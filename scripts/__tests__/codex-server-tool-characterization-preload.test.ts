import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	link,
	lstat,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createServerToolCharacterizationSanitizer,
	type ServerToolCharacterizationKind,
	type ServerToolCharacterizationRecord,
} from "../../packages/providers/src/providers/codex/server-tool-characterization";
import {
	CHARACTERIZATION_CAPTURE_LIMITS,
	createCodexCharacterizationCapture,
	type CharacterizationCaptureFileSystem,
} from "../codex-server-tool-characterization-capture";
import {
	CHARACTERIZATION_ACK,
	installCodexCharacterizationPreload,
} from "../codex-server-tool-characterization-preload";

const ownedTemporaryDirectories = new Set<string>();
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function secureScratch(prefix = "bccf-codex-characterization-") {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	ownedTemporaryDirectories.add(directory);
	await chmod(directory, 0o700);
	return directory;
}

function operatorEnvironment(directory?: string): Record<string, string | undefined> {
	return {
		CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_ACK: CHARACTERIZATION_ACK,
		CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_DIR: directory,
	};
}

function safeRecord(): ServerToolCharacterizationRecord {
	const sanitizer = createServerToolCharacterizationSanitizer();
	const record = sanitizer.sanitize("upstream_event", {
		call_id: "PRIVATE_CALL_ID",
		status: "completed",
		type: "response.web_search_call.completed",
		url: "https://private.internal/search?q=secret",
	});
	if (!record) throw new Error("test fixture did not sanitize");
	return record;
}

function captureFileSystemWithLink(
	linkImplementation: CharacterizationCaptureFileSystem["link"],
): CharacterizationCaptureFileSystem {
	return {
		async open(path, flags, mode) {
			const handle = await open(path, flags, mode);
			return {
				async getIdentity() {
					const status = await handle.stat({ bigint: true });
					return { dev: status.dev, ino: status.ino };
				},
				async chmod(requestedMode) {
					await handle.chmod(requestedMode);
				},
				async writeFile(data, options) {
					await handle.writeFile(data, options);
				},
				async sync() {
					await handle.sync();
				},
				async close() {
					await handle.close();
				},
			};
		},
		async lstat(path) {
			const status = await lstat(path, { bigint: true });
			return { dev: status.dev, ino: status.ino };
		},
		link: linkImplementation,
		unlink,
	};
}

afterEach(async () => {
	for (const directory of ownedTemporaryDirectories) {
		await rm(directory, { force: true, recursive: true });
	}
	ownedTemporaryDirectories.clear();
});

describe("Codex server-tool characterization preload validation", () => {
	test("is a strict no-op without the exact operator acknowledgement", async () => {
		for (const acknowledgement of [undefined, "", "private-human-session-v0"]) {
			const env: Record<string, string | undefined> = {
				CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_ACK: acknowledgement,
				CCFLARE_SERVER_TOOL_WEB_SEARCH: "operator-owned-value",
				DATABASE_URL: "postgresql://operator-owned",
			};
			let providerImports = 0;
			let coreImports = 0;
			let captureCreations = 0;

			const installed = await installCodexCharacterizationPreload(env, {
				createCapture: () => {
					captureCreations++;
					throw new Error("must not initialize capture storage");
				},
				loadCore: async () => {
					coreImports++;
					throw new Error("must not import core");
				},
				loadProviders: async () => {
					providerImports++;
					throw new Error("must not import providers");
				},
			});

			expect(installed).toBeNull();
			expect(providerImports).toBe(0);
			expect(coreImports).toBe(0);
			expect(captureCreations).toBe(0);
			expect(env).toEqual({
				CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_ACK: acknowledgement,
				CCFLARE_SERVER_TOOL_WEB_SEARCH: "operator-owned-value",
				DATABASE_URL: "postgresql://operator-owned",
			});
		}
	});

	test("rejects DATABASE_URL before provider, core, or capture initialization", async () => {
		const directory = await secureScratch();
		const env = {
			...operatorEnvironment(directory),
			DATABASE_URL: "postgresql://operator-owned",
		};
		const before = { ...env };
		let providerImports = 0;
		let coreImports = 0;
		let captureCreations = 0;

		await expect(
			installCodexCharacterizationPreload(env, {
				createCapture: () => {
					captureCreations++;
					throw new Error("must not initialize capture storage");
				},
				loadCore: async () => {
					coreImports++;
					throw new Error("must not import core");
				},
				loadProviders: async () => {
					providerImports++;
					throw new Error("must not import providers");
				},
			}),
		).rejects.toThrow("characterization preload rejected");

		expect({ captureCreations, coreImports, providerImports }).toEqual({
			captureCreations: 0,
			coreImports: 0,
			providerImports: 0,
		});
		expect(env).toEqual(before);
	});

	test("rejects a scratch leaf not owned by the effective user before initialization", async () => {
		if (process.platform !== "linux" || typeof process.geteuid !== "function") {
			return;
		}
		const effectiveUserId = process.geteuid();
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);
		const before = { ...env };
		let providerImports = 0;

		await expect(
			installCodexCharacterizationPreload(env, {
				getEffectiveUserId: () => effectiveUserId + 1,
				loadProviders: async () => {
					providerImports++;
					throw new Error("must not import providers");
				},
			}),
		).rejects.toThrow("characterization preload rejected");

		expect(providerImports).toBe(0);
		expect(env).toEqual(before);
	});

	test("fails closed when descriptor-backed directory validation is unavailable", async () => {
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);
		let providerImports = 0;

		await expect(
			installCodexCharacterizationPreload(env, {
				loadProviders: async () => {
					providerImports++;
					throw new Error("must not import providers");
				},
				platform: "win32",
			}),
		).rejects.toThrow("characterization preload rejected");

		expect(providerImports).toBe(0);
		expect(env.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});

	test("rejects missing, relative, repository, symlinked, and permissive directories", async () => {
		const secure = await secureScratch();
		const missing = join(secure, "missing");
		const target = await secureScratch("bccf-codex-target-");
		const alias = join(secure, "alias");
		await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		const permissive = await secureScratch("bccf-codex-permissive-");
		await chmod(permissive, 0o755);

		for (const directory of [
			undefined,
			"relative/scratch",
			repositoryRoot,
			missing,
			alias,
			permissive,
		]) {
			await expect(
				installCodexCharacterizationPreload(operatorEnvironment(directory)),
			).rejects.toThrow("characterization preload rejected");
		}
	});

	test("rejects conflicting environment and pre-existing isolated files", async () => {
		const conflicts = [
			"BETTER_CCFLARE_DB_PATH",
			"BETTER_CCFLARE_CONFIG_PATH",
			"ccflare_DB_PATH",
			"ccflare_CONFIG_PATH",
		] as const;
		for (const key of conflicts) {
			const directory = await secureScratch();
			const env = operatorEnvironment(directory);
			env[key] = "/operator/existing";
			await expect(
				installCodexCharacterizationPreload(env),
			).rejects.toThrow("characterization preload rejected");
		}

		for (const name of [
			"capture.jsonl",
			".capture.jsonl.tmp",
			"better-ccflare.db",
			"better-ccflare.json",
		]) {
			const directory = await secureScratch();
			await writeFile(join(directory, name), "operator-owned\n");
			await expect(
				installCodexCharacterizationPreload(operatorEnvironment(directory)),
			).rejects.toThrow("characterization preload rejected");
		}
	});

	test("installs isolated paths before overriding only the built-in Codex provider", async () => {
		if (process.platform !== "linux") return;
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);
		env.CCFLARE_SERVER_TOOL_WEB_SEARCH = "operator-owned-value";
		const events: string[] = [];
		let registeredProvider:
			| {
					name: string;
					observer: (record: ServerToolCharacterizationRecord) => void;
					observationGate?: (kind: ServerToolCharacterizationKind) => boolean;
			  }
			| undefined;
		let registeredDisposable: { dispose(): Promise<void> } | undefined;

		class TestCodexProvider {
			readonly name = "codex";
			readonly observer: (record: ServerToolCharacterizationRecord) => void;
			readonly observationGate?: (
				kind: ServerToolCharacterizationKind,
			) => boolean;

			constructor(options: {
				characterizationObserver: (
					record: ServerToolCharacterizationRecord,
				) => void;
				characterizationObservationGate?: (
					kind: ServerToolCharacterizationKind,
				) => boolean;
			}) {
				events.push("construct-codex");
				this.observer = options.characterizationObserver;
				this.observationGate = options.characterizationObservationGate;
			}
		}

		const capture = await installCodexCharacterizationPreload(env, {
			loadProviders: async () => {
				events.push("providers-builtins");
				const databasePath = env.BETTER_CCFLARE_DB_PATH;
				const configPath = env.BETTER_CCFLARE_CONFIG_PATH;
				if (!databasePath || !configPath) {
					throw new Error("isolated paths were not installed");
				}
				const boundDirectory = dirname(databasePath);
				expect(await realpath(boundDirectory)).toBe(directory);
				expect(databasePath).toBe(join(boundDirectory, "better-ccflare.db"));
				expect(configPath).toBe(join(boundDirectory, "better-ccflare.json"));
				return {
					CodexProvider: TestCodexProvider,
					registerProvider(provider: object) {
						events.push("register-codex");
						registeredProvider = provider as typeof registeredProvider;
					},
				};
			},
			loadCore: async () => {
				events.push("core");
				return {
					registerDisposable(disposable) {
						events.push("register-disposable");
						registeredDisposable = disposable;
					},
				};
			},
		});

		expect(capture).not.toBeNull();
		if (!capture) throw new Error("characterization preload did not install");
		expect(events).toEqual([
			"providers-builtins",
			"core",
			"construct-codex",
			"register-codex",
			"register-disposable",
		]);
		expect(registeredProvider?.name).toBe("codex");
		expect(registeredProvider?.observer).toBe(capture.observer);
		expect(registeredProvider?.observationGate?.("outbound_request")).toBe(true);
		expect(registeredDisposable).toBe(capture);
		expect(env.CCFLARE_SERVER_TOOL_WEB_SEARCH).toBe("operator-owned-value");
		const firstDisposal = capture.dispose();
		expect(capture.dispose()).toBe(firstDisposal);
		await firstDisposal;
		expect(env.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});

	test("rechecks leaf protection after imports and before capture creation", async () => {
		if (process.platform !== "linux") return;
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);
		let captureCreations = 0;

		class TestCodexProvider {
			constructor(_options: {
				characterizationObserver: (
					record: ServerToolCharacterizationRecord,
				) => void;
			}) {}
		}

		await expect(
			installCodexCharacterizationPreload(env, {
				createCapture: () => {
					captureCreations++;
					throw new Error("must not create a capture");
				},
				loadCore: async () => ({ registerDisposable() {} }),
				loadProviders: async () => {
					await chmod(directory, 0o755);
					return {
						CodexProvider: TestCodexProvider,
						registerProvider() {},
					};
				},
			}),
		).rejects.toThrow("characterization preload rejected");

		expect(captureCreations).toBe(0);
		expect(env.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});

	test("binds DB, config, and publication to the validated leaf across path replacement", async () => {
		if (process.platform !== "linux") return;
		const directory = await secureScratch();
		const retainedDirectory = `${directory}-retained`;
		const replacementDirectory = await secureScratch(
			"bccf-codex-replacement-",
		);
		ownedTemporaryDirectories.add(retainedDirectory);
		const env = operatorEnvironment(directory);

		class TestCodexProvider {
			readonly observer: (record: ServerToolCharacterizationRecord) => void;

			constructor(options: {
				characterizationObserver: (
					record: ServerToolCharacterizationRecord,
				) => void;
			}) {
				this.observer = options.characterizationObserver;
			}
		}

		const capture = await installCodexCharacterizationPreload(env, {
			loadCore: async () => ({ registerDisposable() {} }),
			loadProviders: async () => {
				await rename(directory, retainedDirectory);
				await symlink(replacementDirectory, directory, "dir");
				const databasePath = env.BETTER_CCFLARE_DB_PATH;
				const configPath = env.BETTER_CCFLARE_CONFIG_PATH;
				if (!databasePath || !configPath) {
					throw new Error("isolated paths were not installed");
				}
				const boundDirectory = dirname(databasePath);
				expect(await realpath(boundDirectory)).toBe(retainedDirectory);
				expect(databasePath).toBe(join(boundDirectory, "better-ccflare.db"));
				expect(configPath).toBe(join(boundDirectory, "better-ccflare.json"));
				await writeFile(databasePath, "fake-database\n", {
					flag: "wx",
					mode: 0o600,
				});
				await writeFile(configPath, "fake-config\n", {
					flag: "wx",
					mode: 0o600,
				});
				return {
					CodexProvider: TestCodexProvider,
					registerProvider() {},
				};
			},
		});

		if (!capture) throw new Error("characterization preload did not install");
		capture.observer(safeRecord());
		await capture.dispose();

		expect(await readFile(join(retainedDirectory, "capture.jsonl"), "utf8")).toContain(
			'"type":"observation"',
		);
		expect(
			await readFile(join(retainedDirectory, "better-ccflare.db"), "utf8"),
		).toBe("fake-database\n");
		expect(
			await readFile(join(retainedDirectory, "better-ccflare.json"), "utf8"),
		).toBe("fake-config\n");
		await expect(
			lstat(join(replacementDirectory, "capture.jsonl")),
		).rejects.toThrow();
		await expect(
			lstat(join(replacementDirectory, "better-ccflare.db")),
		).rejects.toThrow();
		await expect(
			lstat(join(replacementDirectory, "better-ccflare.json")),
		).rejects.toThrow();
		expect(env.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});

	test("restores isolated environment paths when provider setup fails", async () => {
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);
		env.CCFLARE_SERVER_TOOL_WEB_SEARCH = "unchanged";

		await expect(
			installCodexCharacterizationPreload(env, {
				loadProviders: async () => {
					throw new Error("injected provider import failure");
				},
			}),
		).rejects.toThrow("characterization preload rejected");
		expect(env.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
		expect(env.CCFLARE_SERVER_TOOL_WEB_SEARCH).toBe("unchanged");
		await expect(lstat(join(directory, "capture.jsonl"))).rejects.toThrow();
		await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
	});

	test("closes the pinned leaf when a post-validation environment read throws", async () => {
		if (process.platform !== "linux") return;
		const directory = await secureScratch();
		const target = operatorEnvironment(directory);
		let databaseReads = 0;
		let scratchCloses = 0;
		const env = new Proxy(target, {
			get(current, key, receiver) {
				if (key === "BETTER_CCFLARE_DB_PATH") {
					databaseReads++;
					if (databaseReads === 2) {
						throw new Error("injected environment read failure");
					}
				}
				return Reflect.get(current, key, receiver);
			},
		});
		const dependencies = {
			onScratchDirectoryClose() {
				scratchCloses++;
			},
		};

		await expect(
			installCodexCharacterizationPreload(env, dependencies),
		).rejects.toThrow("characterization preload rejected");
		expect(scratchCloses).toBe(1);
		expect(target.BETTER_CCFLARE_DB_PATH).toBeUndefined();
		expect(target.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});

	test("closes the pinned leaf after partial environment writes even when rollback throws", async () => {
		if (process.platform !== "linux") return;
		for (const rollbackThrows of [false, true]) {
			const directory = await secureScratch(
				`bccf-codex-env-${rollbackThrows ? "throw" : "restore"}-`,
			);
			const target = operatorEnvironment(directory);
			let scratchCloses = 0;
			const env = new Proxy(target, {
				deleteProperty(current, key) {
					if (rollbackThrows && key === "BETTER_CCFLARE_DB_PATH") {
						throw new Error("injected rollback failure");
					}
					return Reflect.deleteProperty(current, key);
				},
				set(current, key, value, receiver) {
					if (key === "BETTER_CCFLARE_CONFIG_PATH") {
						throw new Error("injected environment write failure");
					}
					return Reflect.set(current, key, value, receiver);
				},
			});
			const dependencies = {
				onScratchDirectoryClose() {
					scratchCloses++;
				},
			};

			await expect(
				installCodexCharacterizationPreload(env, dependencies),
			).rejects.toThrow("characterization preload rejected");
			expect(scratchCloses).toBe(1);
			if (!rollbackThrows) {
				expect(target.BETTER_CCFLARE_DB_PATH).toBeUndefined();
			}
		}
	});

	test("restores only isolated environment values still owned at disposal", async () => {
		if (process.platform !== "linux") return;
		const directory = await secureScratch();
		const env = operatorEnvironment(directory);

		class TestCodexProvider {
			constructor(_options: {
				characterizationObserver: (
					record: ServerToolCharacterizationRecord,
				) => void;
			}) {}
		}

		const capture = await installCodexCharacterizationPreload(env, {
			loadCore: async () => ({ registerDisposable() {} }),
			loadProviders: async () => ({
				CodexProvider: TestCodexProvider,
				registerProvider() {},
			}),
		});
		if (!capture) throw new Error("characterization preload did not install");
		const isolatedConfigPath = env.BETTER_CCFLARE_CONFIG_PATH;
		if (!isolatedConfigPath) throw new Error("isolated config path was not set");
		env.BETTER_CCFLARE_DB_PATH = "/later-owner/database.db";

		await capture.dispose();

		expect(env.BETTER_CCFLARE_DB_PATH).toBe("/later-owner/database.db");
		expect(env.BETTER_CCFLARE_CONFIG_PATH).toBeUndefined();
	});
});

describe("Codex server-tool characterization capture", () => {
	test("publishes byte-identical deterministic JSONL with fixed framing", async () => {
		const firstDirectory = await secureScratch();
		const secondDirectory = await secureScratch();

		for (const directory of [firstDirectory, secondDirectory]) {
			const capture = createCodexCharacterizationCapture({
				scratchDirectory: directory,
			});
			capture.observer(safeRecord());
			await expect(lstat(join(directory, "capture.jsonl"))).rejects.toThrow();
			await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
			await capture.dispose();
		}

		const first = await readFile(join(firstDirectory, "capture.jsonl"));
		const second = await readFile(join(secondDirectory, "capture.jsonl"));
		expect(first.equals(second)).toBe(true);
		expect(first.byteLength).toBeLessThanOrEqual(
			CHARACTERIZATION_CAPTURE_LIMITS.maxBytes,
		);
		const text = first.toString("utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text).not.toContain("PRIVATE_CALL_ID");
		expect(text).not.toContain("private.internal");
		expect(text).toContain("response.web_search_call.completed");
		const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{
				limits: {
					maxBytes: 4 * 1024 * 1024,
					maxObservationLineBytes: 64 * 1024,
					maxRecords: 512,
				},
				schema: "better-ccflare.codex-server-tool-characterization",
				type: "header",
				version: 1,
			},
			{
				record: {
					data: {
						call_id: "id-1",
						status: "completed",
						type: "response.web_search_call.completed",
						url: "https://source-1.example/",
					},
					kind: "upstream_event",
				},
				sequence: 1,
				type: "observation",
			},
			{
				acceptedRecords: 1,
				droppedRecords: 0,
				truncated: false,
				type: "completion",
			},
		]);
		expect((await stat(join(firstDirectory, "capture.jsonl"))).mode & 0o777).toBe(
			0o600,
		);
		expect(await lstat(join(firstDirectory, "capture.jsonl"))).toBeDefined();
	});

	test("never overwrites a destination that appears at publication", async () => {
		const directory = await secureScratch();
		const fileSystem = captureFileSystemWithLink(
			async (existingPath, newPath) => {
				await writeFile(newPath, "operator-owned\n", {
					flag: "wx",
					mode: 0o600,
				});
				await link(existingPath, newPath);
			},
		);
		const capture = createCodexCharacterizationCapture({
			fileSystem,
			scratchDirectory: directory,
		});
		capture.observer(safeRecord());

		await expect(capture.dispose()).resolves.toBeUndefined();
		expect(await readFile(join(directory, "capture.jsonl"), "utf8")).toBe(
			"operator-owned\n",
		);
		await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
	});

	test("removes its linked output when the pinned identity fails its publication recheck", async () => {
		const directory = await secureScratch();
		let identityIsValid = true;
		const fileSystem = captureFileSystemWithLink(
			async (existingPath, newPath) => {
				await link(existingPath, newPath);
				identityIsValid = false;
			},
		);
		const capture = createCodexCharacterizationCapture({
			directoryGuard: {
				assertIdentity() {
					if (!identityIsValid) throw new Error("injected identity change");
				},
				directoryPath: directory,
			},
			fileSystem,
			scratchDirectory: directory,
		});
		capture.observer(safeRecord());

		await expect(capture.dispose()).resolves.toBeUndefined();
		await expect(lstat(join(directory, "capture.jsonl"))).rejects.toThrow();
		await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
	});

	test("preserves a replacement at the linked destination during identity-failure cleanup", async () => {
		const directory = await secureScratch();
		const destinationPath = join(directory, "capture.jsonl");
		let identityIsValid = true;
		let destinationReplaced = false;
		const baseFileSystem = captureFileSystemWithLink(link);
		const fileSystem = {
			...baseFileSystem,
			async lstat(path: string) {
				const status = await lstat(path, { bigint: true });
				if (path === destinationPath && !destinationReplaced) {
					destinationReplaced = true;
					await unlink(path);
					await writeFile(path, "replacement-destination\n", {
						flag: "wx",
						mode: 0o600,
					});
					identityIsValid = false;
				}
				return status;
			},
		};
		const capture = createCodexCharacterizationCapture({
			directoryGuard: {
				assertIdentity() {
					if (!identityIsValid) throw new Error("injected identity change");
				},
				directoryPath: directory,
			},
			fileSystem,
			scratchDirectory: directory,
		});
		capture.observer(safeRecord());

		await expect(capture.dispose()).resolves.toBeUndefined();
		expect(await readFile(destinationPath, "utf8")).toBe(
			"replacement-destination\n",
		);
		await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
	});

	test("preserves a replacement at the temporary path during identity-failure cleanup", async () => {
		const directory = await secureScratch();
		const temporaryPath = join(directory, ".capture.jsonl.tmp");
		let identityIsValid = true;
		const fileSystem = captureFileSystemWithLink(
			async (existingPath, newPath) => {
				await link(existingPath, newPath);
				await unlink(existingPath);
				await writeFile(existingPath, "replacement-temporary\n", {
					flag: "wx",
					mode: 0o600,
				});
				identityIsValid = false;
			},
		);
		const capture = createCodexCharacterizationCapture({
			directoryGuard: {
				assertIdentity() {
					if (!identityIsValid) throw new Error("injected identity change");
				},
				directoryPath: directory,
			},
			fileSystem,
			scratchDirectory: directory,
		});
		capture.observer(safeRecord());

		await expect(capture.dispose()).resolves.toBeUndefined();
		expect(await readFile(temporaryPath, "utf8")).toBe(
			"replacement-temporary\n",
		);
		await expect(lstat(join(directory, "capture.jsonl"))).rejects.toThrow();
	});

	test("deterministically truncates at record, observation-line, and total byte bounds", async () => {
		const recordDirectory = await secureScratch();
		const recordCapture = createCodexCharacterizationCapture({
			scratchDirectory: recordDirectory,
		});
		for (let index = 0; index <= CHARACTERIZATION_CAPTURE_LIMITS.maxRecords; index++) {
			recordCapture.observer(safeRecord());
		}
		await recordCapture.dispose();
		const recordLines = (await readFile(
			join(recordDirectory, "capture.jsonl"),
			"utf8",
		))
			.trimEnd()
			.split("\n");
		expect(recordLines).toHaveLength(
			CHARACTERIZATION_CAPTURE_LIMITS.maxRecords + 2,
		);
		expect(JSON.parse(recordLines.at(-1)!)).toEqual({
			acceptedRecords: CHARACTERIZATION_CAPTURE_LIMITS.maxRecords,
			droppedRecords: 1,
			truncated: true,
			type: "completion",
		});

		const lineDirectory = await secureScratch();
		const lineCapture = createCodexCharacterizationCapture({
			limitReductions: { maxObservationLineBytes: 64 },
			scratchDirectory: lineDirectory,
		});
		lineCapture.observer(safeRecord());
		await lineCapture.dispose();
		const lineOutput = await readFile(join(lineDirectory, "capture.jsonl"), "utf8");
		expect(lineOutput).not.toContain('"type":"observation"');
		const framingLines = lineOutput.trimEnd().split("\n");
		expect(new TextEncoder().encode(`${framingLines[0]}\n`).byteLength).toBeGreaterThan(
			64,
		);
		expect(
			new TextEncoder().encode(`${framingLines.at(-1)}\n`).byteLength,
		).toBeGreaterThan(64);
		expect(JSON.parse(framingLines.at(-1)!)).toEqual({
			acceptedRecords: 0,
			droppedRecords: 1,
			truncated: true,
			type: "completion",
		});

		const totalOutputs: Buffer[] = [];
		for (let run = 0; run < 2; run++) {
			const directory = await secureScratch(`bccf-codex-total-${run}-`);
			const capture = createCodexCharacterizationCapture({
				limitReductions: { maxBytes: 700 },
				scratchDirectory: directory,
			});
			for (let index = 0; index < 10; index++) capture.observer(safeRecord());
			await capture.dispose();
			const output = await readFile(join(directory, "capture.jsonl"));
			totalOutputs.push(output);
			expect(output.byteLength).toBeLessThanOrEqual(700);
			for (const line of output.toString("utf8").trimEnd().split("\n")) {
				const parsed = JSON.parse(line) as { type?: string };
				if (parsed.type !== "observation") continue;
				expect(new TextEncoder().encode(`${line}\n`).byteLength).toBeLessThanOrEqual(
					CHARACTERIZATION_CAPTURE_LIMITS.maxObservationLineBytes,
				);
			}
			const footer = JSON.parse(output.toString("utf8").trimEnd().split("\n").at(-1)!);
			expect(footer.truncated).toBe(true);
			expect(footer.droppedRecords).toBeGreaterThan(0);
		}
		expect(totalOutputs[0]?.equals(totalOutputs[1]!)).toBe(true);
	});

	test("drops forged unsafe records and becomes permanently inert on disposal", async () => {
		const directory = await secureScratch();
		const capture = createCodexCharacterizationCapture({
			scratchDirectory: directory,
		});
		capture.observer({
			kind: "upstream_event",
			data: { type: "lowercase_secret" },
		} as ServerToolCharacterizationRecord);
		capture.observer(safeRecord());
		const firstDisposal = capture.dispose();
		capture.observer(safeRecord());
		const secondDisposal = capture.dispose();
		expect(secondDisposal).toBe(firstDisposal);
		await expect(firstDisposal).resolves.toBeUndefined();
		await expect(capture.dispose()).resolves.toBeUndefined();

		const output = await readFile(join(directory, "capture.jsonl"), "utf8");
		expect(output).not.toContain("lowercase_secret");
		const lines = output.trimEnd().split("\n");
		expect(lines.filter((line) => line.includes('"type":"observation"'))).toHaveLength(
			1,
		);
		expect(JSON.parse(lines.at(-1)!)).toEqual({
			acceptedRecords: 1,
			droppedRecords: 1,
			truncated: true,
			type: "completion",
		});
	});

	test("swallows write, fsync, and link failures without publishing partial data", async () => {
		for (const failure of ["write", "fsync", "link"] as const) {
			const directory = await secureScratch(`bccf-codex-${failure}-`);
			const fileSystem: CharacterizationCaptureFileSystem = {
				async open(path, flags, mode) {
					const handle = await open(path, flags, mode);
					return {
						async getIdentity() {
							const status = await handle.stat({ bigint: true });
							return { dev: status.dev, ino: status.ino };
						},
						async chmod(requestedMode) {
							await handle.chmod(requestedMode);
						},
						async writeFile(data, options) {
							if (failure === "write") throw new Error("injected write failure");
							await handle.writeFile(data, options);
						},
						async sync() {
							if (failure === "fsync" && flags === "wx") {
								throw new Error("injected fsync failure");
							}
							await handle.sync();
						},
						async close() {
							await handle.close();
						},
					};
				},
				async lstat(path) {
					const status = await lstat(path, { bigint: true });
					return { dev: status.dev, ino: status.ino };
				},
				async link(existingPath, newPath) {
					if (failure === "link") throw new Error("injected link failure");
					await link(existingPath, newPath);
				},
				unlink,
			};
			const capture = createCodexCharacterizationCapture({
				fileSystem,
				scratchDirectory: directory,
			});
			capture.observer(safeRecord());

			await expect(capture.dispose()).resolves.toBeUndefined();
			await expect(lstat(join(directory, "capture.jsonl"))).rejects.toThrow();
			await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
		}
	});

	test("keeps a complete publication when directory fsync fails after the atomic link", async () => {
		const directory = await secureScratch("bccf-codex-directory-fsync-");
		const fileSystem: CharacterizationCaptureFileSystem = {
			async open(path, flags, mode) {
				const handle = await open(path, flags, mode);
				return {
					async getIdentity() {
						const status = await handle.stat({ bigint: true });
						return { dev: status.dev, ino: status.ino };
					},
					async chmod(requestedMode) {
						await handle.chmod(requestedMode);
					},
					async writeFile(data, options) {
						await handle.writeFile(data, options);
					},
					async sync() {
						if (flags === "r") throw new Error("injected directory fsync failure");
						await handle.sync();
					},
					async close() {
						await handle.close();
					},
				};
			},
			async lstat(path) {
				const status = await lstat(path, { bigint: true });
				return { dev: status.dev, ino: status.ino };
			},
			link,
			unlink,
		};
		const capture = createCodexCharacterizationCapture({
			fileSystem,
			scratchDirectory: directory,
		});
		capture.observer(safeRecord());

		await expect(capture.dispose()).resolves.toBeUndefined();
		const output = await readFile(join(directory, "capture.jsonl"), "utf8");
		expect(output.endsWith("\n")).toBe(true);
		expect(output.trimEnd().split("\n")).toHaveLength(3);
		expect(JSON.parse(output.trimEnd().split("\n").at(-1)!)).toEqual({
			acceptedRecords: 1,
			droppedRecords: 0,
			truncated: false,
			type: "completion",
		});
		await expect(lstat(join(directory, ".capture.jsonl.tmp"))).rejects.toThrow();
	});

	test("loads as an eval-only Bun preload without starting a server", async () => {
		const childEnvironment = { ...process.env };
		delete childEnvironment.CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_ACK;
		delete childEnvironment.CCFLARE_CODEX_SERVER_TOOL_CHARACTERIZATION_DIR;
		const preloadPath = join(repositoryRoot, "scripts", "codex-server-tool-characterization-preload.ts");
		const child = Bun.spawn(
			[
				process.execPath,
				"--preload",
				preloadPath,
				"-e",
				'process.stdout.write("eval-only")',
			],
			{
				cwd: repositoryRoot,
				env: childEnvironment,
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr, stdout }).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: "eval-only",
		});
	});
});
