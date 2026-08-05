import {
	link as linkFile,
	lstat as lstatFile,
	open as openFile,
	unlink as unlinkFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	canonicalizeServerToolCharacterization,
	type ServerToolCharacterizationObserver,
	type ServerToolCharacterizationRecord,
} from "../packages/providers/src/providers/codex/server-tool-characterization";

export const CHARACTERIZATION_CAPTURE_LIMITS = Object.freeze({
	maxRecords: 512,
	maxBytes: 4 * 1024 * 1024,
	maxObservationLineBytes: 64 * 1024,
});

export const CHARACTERIZATION_CAPTURE_FILE = "capture.jsonl";
export const CHARACTERIZATION_CAPTURE_TEMP_FILE = ".capture.jsonl.tmp";

const CAPTURE_SCHEMA = "better-ccflare.codex-server-tool-characterization";
const textEncoder = new TextEncoder();

type CharacterizationCaptureLimits = typeof CHARACTERIZATION_CAPTURE_LIMITS;

function headerLine(limits: CharacterizationCaptureLimits): string {
	return `${JSON.stringify({
		limits,
		schema: CAPTURE_SCHEMA,
		type: "header",
		version: 1,
	})}\n`;
}

interface CharacterizationCaptureFileHandle {
	getIdentity(): Promise<CharacterizationCaptureFileIdentity>;
	writeFile(
		data: string,
		options: { encoding: "utf8" },
	): Promise<void>;
	chmod(mode: number): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

interface CharacterizationCaptureFileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

export interface CharacterizationCaptureFileSystem {
	open(
		path: string,
		flags: "r" | "wx",
		mode?: number,
	): Promise<CharacterizationCaptureFileHandle>;
	lstat(path: string): Promise<CharacterizationCaptureFileIdentity>;
	link(existingPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface CharacterizationCaptureDirectoryGuard {
	readonly directoryPath: string;
	assertIdentity(): void;
}

const defaultFileSystem: CharacterizationCaptureFileSystem = {
	async open(path, flags, mode) {
		const handle = await openFile(path, flags, mode);
		return {
			async getIdentity() {
				const status = await handle.stat({ bigint: true });
				return { dev: status.dev, ino: status.ino };
			},
			chmod: (requestedMode) => handle.chmod(requestedMode),
			close: () => handle.close(),
			sync: () => handle.sync(),
			writeFile: (data, options) => handle.writeFile(data, options),
		};
	},
	async lstat(path) {
		const status = await lstatFile(path, { bigint: true });
		return { dev: status.dev, ino: status.ino };
	},
	link: linkFile,
	unlink: unlinkFile,
};

export interface CodexCharacterizationCapture {
	readonly observer: ServerToolCharacterizationObserver;
	dispose(): Promise<void>;
}

export interface CodexCharacterizationCaptureOptions {
	readonly scratchDirectory: string;
	readonly directoryGuard?: CharacterizationCaptureDirectoryGuard;
	readonly fileSystem?: CharacterizationCaptureFileSystem;
	/** Test/service profiles may only reduce the source-controlled hard limits. */
	readonly limitReductions?: Partial<CharacterizationCaptureLimits>;
}

function footerLine(
	acceptedRecords: number,
	droppedRecords: number,
	truncated: boolean,
): string {
	return `${JSON.stringify({
		acceptedRecords,
		droppedRecords,
		truncated,
		type: "completion",
	})}\n`;
}

function incrementBounded(value: number): number {
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function sameFileIdentity(
	left: CharacterizationCaptureFileIdentity,
	right: CharacterizationCaptureFileIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfOwned(
	fileSystem: CharacterizationCaptureFileSystem,
	path: string,
	ownedIdentity: CharacterizationCaptureFileIdentity | undefined,
): Promise<boolean> {
	if (!ownedIdentity) return false;
	try {
		const currentIdentity = await fileSystem.lstat(path);
		if (!sameFileIdentity(currentIdentity, ownedIdentity)) return false;
		await fileSystem.unlink(path);
		return true;
	} catch {
		return false;
	}
}

function resolveLimits(
	reductions: Partial<CharacterizationCaptureLimits> | undefined,
): CharacterizationCaptureLimits {
	const limits = {
		maxRecords:
			reductions?.maxRecords ?? CHARACTERIZATION_CAPTURE_LIMITS.maxRecords,
		maxBytes: reductions?.maxBytes ?? CHARACTERIZATION_CAPTURE_LIMITS.maxBytes,
		maxObservationLineBytes:
			reductions?.maxObservationLineBytes ??
			CHARACTERIZATION_CAPTURE_LIMITS.maxObservationLineBytes,
	};
	for (const key of Object.keys(limits) as (keyof CharacterizationCaptureLimits)[]) {
		if (
			!Number.isSafeInteger(limits[key]) ||
			limits[key] <= 0 ||
			limits[key] > CHARACTERIZATION_CAPTURE_LIMITS[key]
		) {
			throw new Error("characterization capture limit reduction is invalid");
		}
	}
	return Object.freeze(limits);
}

function observationLine(
	record: ServerToolCharacterizationRecord,
	sequence: number,
): string | null {
	const canonicalRecord = canonicalizeServerToolCharacterization(record);
	if (canonicalRecord === null) return null;
	return `{"record":${canonicalRecord},"sequence":${sequence},"type":"observation"}\n`;
}

export function createCodexCharacterizationCapture(
	options: CodexCharacterizationCaptureOptions,
): CodexCharacterizationCapture {
	const directoryGuard = options.directoryGuard;
	if (
		!isAbsolute(options.scratchDirectory) ||
		(directoryGuard !== undefined &&
			directoryGuard.directoryPath !== options.scratchDirectory)
	) {
		throw new Error("characterization capture requires an absolute directory");
	}
	directoryGuard?.assertIdentity();

	const fileSystem = options.fileSystem ?? defaultFileSystem;
	const limits = resolveLimits(options.limitReductions);
	const header = headerLine(limits);
	const maximumFooterBytes = textEncoder.encode(
		footerLine(limits.maxRecords, Number.MAX_SAFE_INTEGER, true),
	).byteLength;
	if (
		textEncoder.encode(header).byteLength + maximumFooterBytes >
		limits.maxBytes
	) {
		throw new Error("characterization capture byte reduction is too small");
	}
	const destinationPath = join(
		options.scratchDirectory,
		CHARACTERIZATION_CAPTURE_FILE,
	);
	const temporaryPath = join(
		options.scratchDirectory,
		CHARACTERIZATION_CAPTURE_TEMP_FILE,
	);
	const lines: string[] = [];
	let acceptedBytes = textEncoder.encode(header).byteLength;
	let droppedRecords = 0;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	const observer: ServerToolCharacterizationObserver = (record) => {
		if (disposed) return;
		try {
			const line = observationLine(record, lines.length + 1);
			if (line === null) {
				droppedRecords = incrementBounded(droppedRecords);
				return;
			}
			const lineBytes = textEncoder.encode(line).byteLength;
			if (
				lines.length >= limits.maxRecords ||
				lineBytes > limits.maxObservationLineBytes ||
				acceptedBytes + lineBytes + maximumFooterBytes > limits.maxBytes
			) {
				droppedRecords = incrementBounded(droppedRecords);
				return;
			}
			lines.push(line);
			acceptedBytes += lineBytes;
		} catch {
			// Characterization must remain invisible to the provider request path.
			droppedRecords = incrementBounded(droppedRecords);
		}
	};

	async function publish(): Promise<void> {
		const footer = footerLine(
			lines.length,
			droppedRecords,
			droppedRecords > 0,
		);
		const payload = `${header}${lines.join("")}${footer}`;
		if (textEncoder.encode(payload).byteLength > limits.maxBytes) {
			return;
		}

		let temporaryHandle: CharacterizationCaptureFileHandle | undefined;
		let directoryHandle: CharacterizationCaptureFileHandle | undefined;
		let temporaryIdentity: CharacterizationCaptureFileIdentity | undefined;
		let destinationIdentity: CharacterizationCaptureFileIdentity | undefined;
		try {
			directoryGuard?.assertIdentity();
			temporaryHandle = await fileSystem.open(temporaryPath, "wx", 0o600);
			temporaryIdentity = await temporaryHandle.getIdentity();
			await temporaryHandle.chmod(0o600);
			await temporaryHandle.writeFile(payload, { encoding: "utf8" });
			await temporaryHandle.sync();
			await temporaryHandle.close();
			temporaryHandle = undefined;

			directoryGuard?.assertIdentity();
			await fileSystem.link(temporaryPath, destinationPath);
			const linkedIdentity = await fileSystem.lstat(destinationPath);
			if (!sameFileIdentity(temporaryIdentity, linkedIdentity)) {
				throw new Error("characterization capture link identity changed");
			}
			destinationIdentity = linkedIdentity;
			directoryGuard?.assertIdentity();
			if (!(await unlinkIfOwned(fileSystem, temporaryPath, temporaryIdentity))) {
				throw new Error("characterization capture temporary identity changed");
			}
			temporaryIdentity = undefined;
			directoryGuard?.assertIdentity();
			destinationIdentity = undefined;

			directoryHandle = await fileSystem.open(options.scratchDirectory, "r");
			await directoryHandle.sync();
			await directoryHandle.close();
			directoryHandle = undefined;
		} catch {
			// Lifecycle shutdown and provider behavior must not depend on capture I/O.
		} finally {
			if (temporaryHandle) {
				try {
					await temporaryHandle.close();
				} catch {}
			}
			if (directoryHandle) {
				try {
					await directoryHandle.close();
				} catch {}
			}
			await unlinkIfOwned(fileSystem, destinationPath, destinationIdentity);
			await unlinkIfOwned(fileSystem, temporaryPath, temporaryIdentity);
		}
	}

	return Object.freeze({
		observer,
		dispose(): Promise<void> {
			if (disposePromise) return disposePromise;
			disposed = true;
			disposePromise = publish();
			return disposePromise;
		},
	});
}
