import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	openSync,
} from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import {
	CHARACTERIZATION_CAPTURE_FILE,
	CHARACTERIZATION_CAPTURE_TEMP_FILE,
	createCodexCharacterizationCapture,
	type CharacterizationCaptureDirectoryGuard,
	type CodexCharacterizationCapture,
} from "./codex-server-tool-characterization-capture";
import {
	createCodexCharacterizationProvider,
	type CharacterizationCodexProviderConstructor,
} from "./codex-server-tool-characterization-request-adapter";

export const CHARACTERIZATION_ACK = "private-human-session-v1";

const ACK_ENV = "CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_ACK";
const DIRECTORY_ENV = "CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_DIR";
const DB_ENV = "BETTER_CCFLARE_DB_PATH";
const CONFIG_ENV = "BETTER_CCFLARE_CONFIG_PATH";
const CONFLICTING_PATH_ENV = [
	DB_ENV,
	CONFIG_ENV,
	"DATABASE_URL",
	"ccflare_DB_PATH",
	"ccflare_CONFIG_PATH",
] as const;
const ISOLATED_FILES = [
	CHARACTERIZATION_CAPTURE_FILE,
	CHARACTERIZATION_CAPTURE_TEMP_FILE,
	"better-ccflare.db",
	"better-ccflare.json",
] as const;

type CharacterizationEnvironment = Record<string, string | undefined>;

interface CharacterizationProviderModule {
	CodexProvider: CharacterizationCodexProviderConstructor;
	registerProvider(provider: object): void;
}

interface CharacterizationCoreModule {
	registerDisposable(disposable: CodexCharacterizationCapture): void;
}

export interface CharacterizationPreloadDependencies {
	readonly loadProviders?: () => Promise<CharacterizationProviderModule>;
	readonly loadCore?: () => Promise<CharacterizationCoreModule>;
	readonly repositoryDirectory?: string;
	readonly createCapture?: typeof createCodexCharacterizationCapture;
	readonly getEffectiveUserId?: () => number;
	readonly onScratchDirectoryClose?: () => void;
	readonly platform?: NodeJS.Platform;
}

interface ScratchDirectorySnapshot {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly uid: bigint;
	readonly isDirectory: boolean;
}

interface PinnedScratchDirectory extends CharacterizationCaptureDirectoryGuard {
	close(): void;
}

function rejected(): Error {
	return new Error("characterization preload rejected");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return false;
		}
		throw rejected();
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return (
		pathFromParent === "" ||
		(!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
	);
}

function scratchPathComponents(
	directory: string,
): ReadonlyArray<string> | undefined {
	if (
		directory.includes("\0") ||
		!posix.isAbsolute(directory) ||
		posix.normalize(directory) !== directory
	) {
		return undefined;
	}
	const components = directory.slice(1).split("/");
	if (
		components.length === 0 ||
		components.some(
			(component) =>
				component.length === 0 || component === "." || component === "..",
		)
	) {
		return undefined;
	}
	return components;
}

function scratchDirectorySnapshot(descriptor: number): ScratchDirectorySnapshot {
	const status = fstatSync(descriptor, { bigint: true });
	return {
		dev: status.dev,
		ino: status.ino,
		mode: status.mode,
		nlink: status.nlink,
		uid: status.uid,
		isDirectory: status.isDirectory(),
	};
}

function isProtectedScratchDirectory(
	snapshot: ScratchDirectorySnapshot,
	effectiveUserId: number,
): boolean {
	return (
		snapshot.isDirectory &&
		snapshot.nlink > 0n &&
		snapshot.uid === BigInt(effectiveUserId) &&
		(snapshot.mode & 0o7777n) === 0o700n
	);
}

function sameScratchDirectoryIdentity(
	left: ScratchDirectorySnapshot,
	right: ScratchDirectorySnapshot,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function openPinnedScratchDirectory(
	directory: string,
	effectiveUserId: number,
	onClose?: () => void,
): PinnedScratchDirectory {
	const components = scratchPathComponents(directory);
	if (components === undefined) throw rejected();

	const descriptors: number[] = [];
	try {
		const flags =
			fsConstants.O_RDONLY |
			fsConstants.O_DIRECTORY |
			fsConstants.O_NOFOLLOW;
		let parentDescriptor = openSync("/", flags);
		descriptors.push(parentDescriptor);

		// Shared ancestors such as /tmp may be writable. Walking every component
		// through an already-open parent with O_NOFOLLOW, then using only the
		// retained leaf descriptor, prevents an ancestor rename or symlink swap
		// from redirecting any DB, config, or capture output.
		for (const component of components) {
			const descriptor = openSync(
				`/proc/self/fd/${parentDescriptor}/${component}`,
				flags,
			);
			descriptors.push(descriptor);
			parentDescriptor = descriptor;
		}

		const pinnedDescriptor = parentDescriptor;
		const initial = scratchDirectorySnapshot(pinnedDescriptor);
		if (!isProtectedScratchDirectory(initial, effectiveUserId)) {
			throw rejected();
		}

		for (const descriptor of descriptors.slice(0, -1).reverse()) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		descriptors.splice(0, descriptors.length - 1);

		let closed = false;
		return Object.freeze({
			directoryPath: `/proc/self/fd/${pinnedDescriptor}`,
			assertIdentity(): void {
				if (closed) throw rejected();
				const current = scratchDirectorySnapshot(pinnedDescriptor);
				if (
					!sameScratchDirectoryIdentity(initial, current) ||
					!isProtectedScratchDirectory(current, effectiveUserId)
				) {
					throw rejected();
				}
			},
			close(): void {
				if (closed) return;
				closed = true;
				try {
					closeSync(pinnedDescriptor);
				} catch {
				} finally {
					try {
						onClose?.();
					} catch {}
				}
			},
		});
	} catch {
		for (const descriptor of descriptors.reverse()) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		throw rejected();
	}
}

async function validateScratchDirectory(
	directory: string | undefined,
	repositoryDirectory: string,
	platform: NodeJS.Platform,
	getEffectiveUserId: () => number,
	onClose?: () => void,
): Promise<PinnedScratchDirectory> {
	if (
		!directory ||
		!isAbsolute(directory) ||
		resolve(directory) !== directory ||
		platform !== "linux" ||
		process.platform !== "linux"
	) {
		throw rejected();
	}

	let effectiveUserId: number;
	try {
		effectiveUserId = getEffectiveUserId();
	} catch {
		throw rejected();
	}
	if (!Number.isSafeInteger(effectiveUserId) || effectiveUserId < 0) {
		throw rejected();
	}

	const pinnedDirectory = openPinnedScratchDirectory(
		directory,
		effectiveUserId,
		onClose,
	);
	try {
		const physicalDirectory = await realpath(pinnedDirectory.directoryPath);
		const physicalRepository = await realpath(repositoryDirectory);
		if (
			physicalDirectory !== directory ||
			isWithin(physicalRepository, physicalDirectory)
		) {
			throw rejected();
		}

		for (const name of ISOLATED_FILES) {
			if (await pathExists(join(pinnedDirectory.directoryPath, name))) {
				throw rejected();
			}
		}
		pinnedDirectory.assertIdentity();
		return pinnedDirectory;
	} catch {
		pinnedDirectory.close();
		throw rejected();
	}
}

function restoreOwnedEnvironment(
	env: CharacterizationEnvironment,
	before: Readonly<Record<string, string | undefined>>,
	installed: Readonly<Record<string, string>>,
): void {
	for (const key of [DB_ENV, CONFIG_ENV]) {
		try {
			if (env[key] !== installed[key]) continue;
			const value = before[key];
			if (value === undefined) delete env[key];
			else env[key] = value;
		} catch {
			// Environment rollback is best-effort; descriptor closure is mandatory.
		}
	}
}

export async function installCodexCharacterizationPreload(
	env: CharacterizationEnvironment = process.env,
	dependencies: CharacterizationPreloadDependencies = {},
): Promise<CodexCharacterizationCapture | null> {
	if (env[ACK_ENV] !== CHARACTERIZATION_ACK) return null;
	if (CONFLICTING_PATH_ENV.some((key) => env[key] !== undefined)) {
		throw rejected();
	}

	const repositoryDirectory =
		dependencies.repositoryDirectory ?? resolve(import.meta.dir, "..");
	const getEffectiveUserId =
		dependencies.getEffectiveUserId ??
		(() => {
			if (typeof process.geteuid !== "function") throw rejected();
			return process.geteuid();
		});
	const scratchDirectory = await validateScratchDirectory(
		env[DIRECTORY_ENV],
		repositoryDirectory,
		dependencies.platform ?? process.platform,
		getEffectiveUserId,
		dependencies.onScratchDirectoryClose,
	);
	let environmentInstallation:
		| Readonly<{
				before: Readonly<Record<string, string | undefined>>;
				installed: Readonly<Record<string, string>>;
		  }>
		| undefined;
	let scratchDirectoryTransferred = false;
	try {
		const databaseBefore = env[DB_ENV];
		const configBefore = env[CONFIG_ENV];
		const before = { [DB_ENV]: databaseBefore, [CONFIG_ENV]: configBefore };
		const installed = {
			[DB_ENV]: join(scratchDirectory.directoryPath, "better-ccflare.db"),
			[CONFIG_ENV]: join(
				scratchDirectory.directoryPath,
				"better-ccflare.json",
			),
		};
		environmentInstallation = { before, installed };
		env[DB_ENV] = installed[DB_ENV];
		env[CONFIG_ENV] = installed[CONFIG_ENV];

		const providers = dependencies.loadProviders
			? await dependencies.loadProviders()
			: ((await import(
					"@better-ccflare/providers"
				)) as unknown as CharacterizationProviderModule);
		const core = dependencies.loadCore
			? await dependencies.loadCore()
			: ((await import(
					"@better-ccflare/core"
				)) as CharacterizationCoreModule);
		scratchDirectory.assertIdentity();
		const captureImplementation = (
			dependencies.createCapture ?? createCodexCharacterizationCapture
		)({
			directoryGuard: scratchDirectory,
			scratchDirectory: scratchDirectory.directoryPath,
		});
		scratchDirectory.assertIdentity();
		let disposePromise: Promise<void> | undefined;
		const capture: CodexCharacterizationCapture = Object.freeze({
			observer: captureImplementation.observer,
			dispose(): Promise<void> {
				if (disposePromise) return disposePromise;
				disposePromise = (async () => {
					try {
						await captureImplementation.dispose();
					} finally {
						restoreOwnedEnvironment(env, before, installed);
						scratchDirectory.close();
					}
				})();
				return disposePromise;
			},
		});
		providers.registerProvider(
			createCodexCharacterizationProvider(
				providers.CodexProvider,
				capture.observer,
			),
		);
		core.registerDisposable(capture);
		scratchDirectoryTransferred = true;
		return capture;
	} catch {
		if (environmentInstallation) {
			restoreOwnedEnvironment(
				env,
				environmentInstallation.before,
				environmentInstallation.installed,
			);
		}
		throw rejected();
	} finally {
		if (!scratchDirectoryTransferred) scratchDirectory.close();
	}
}

await installCodexCharacterizationPreload();
