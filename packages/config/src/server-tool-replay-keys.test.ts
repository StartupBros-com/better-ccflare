import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import {
	CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE,
	loadServerToolReplayKeys,
} from "./index";

let testDirectory: string | undefined;
const ACTIVE_KEY = Buffer.from(
	"active-key-material-is-32-bytes!",
	"utf8",
).toString("base64url");
const RETAINED_KEY = Buffer.from(
	"retained-key-material-is-32-byte",
	"utf8",
).toString("base64url");
const NEXT_KEY = Buffer.from(
	"next-key-material-is-exactly-32b",
	"utf8",
).toString("base64url");

let fileCounter = 0;

function getTestDirectory(): string {
	testDirectory ??= mkdtempSync(join(tmpdir(), "better-ccflare-replay-keys-"));
	return testDirectory;
}

function writeKeyFile(value: unknown, mode = 0o600): string {
	return writeRawKeyFile(JSON.stringify(value), mode);
}

function writeRawKeyFile(contents: string, mode = 0o600): string {
	const path = join(getTestDirectory(), `keys-${fileCounter++}.json`);
	writeFileSync(path, contents, { mode });
	chmodSync(path, mode);
	return path;
}

function loadPath(path: string, platform: NodeJS.Platform = "linux") {
	return loadServerToolReplayKeys(
		{ [CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE]: path },
		platform,
	);
}

function validKeyFile(
	keys: unknown[] = [
		{ id: "current", status: "active", key: ACTIVE_KEY },
		{ id: "previous", status: "retained", key: RETAINED_KEY },
		{ id: "compromised", status: "revoked" },
	],
): { version: 1; activeKeyId: string; keys: unknown[] } {
	return { version: 1, activeKeyId: "current", keys };
}

function expectDeeplyFrozen(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	expect(Object.isFrozen(value)).toBe(true);
	for (const nested of Object.values(value)) expectDeeplyFrozen(nested);
}

afterAll(() => {
	if (testDirectory !== undefined) {
		rmSync(testDirectory, { recursive: true, force: true });
	}
});

describe("server-tool replay key loader", () => {
	it("returns a deeply frozen disabled state when no key file is configured", () => {
		const result = loadServerToolReplayKeys({});

		expect(CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE).toBe(
			"CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE",
		);
		expect(result).toEqual({ status: "disabled" });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it.each([
		"aix",
		"darwin",
		"freebsd",
		"openbsd",
		"sunos",
		"win32",
	] as const)("fails closed on the %s platform", (platform) => {
		expect(loadPath("/unused/replay-keys.json", platform)).toEqual({
			status: "unavailable",
			code: "invalid_replay_key_config",
		});
	});

	it("redacts a throwing replay-key environment accessor", () => {
		const sentinel = "hostile-env-access-SENTINEL";
		const env = new Proxy<Record<string, string | undefined>>(
			{},
			{
				get(_target, property) {
					if (property === CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE) {
						throw new Error(sentinel);
					}
					return undefined;
				},
			},
		);
		const unavailable = loadPath("/unused/replay-keys.json", "win32");

		const result = loadServerToolReplayKeys(env);

		expect(result).toBe(unavailable);
		expect(result).toEqual({
			status: "unavailable",
			code: "invalid_replay_key_config",
		});
		expect(JSON.stringify(result)).not.toContain(sentinel);
	});

	describe.skipIf(process.platform !== "linux")(
		"Linux protected key-file loading",
		() => {
			it.each([
				0o400, 0o600,
			])("loads decoded active and retained keys from a protected %o file", (mode) => {
				const result = loadPath(writeKeyFile(validKeyFile(), mode));

				expect(result).toEqual({
					status: "ready",
					activeKeyId: "current",
					keys: [
						{ id: "compromised", status: "revoked" },
						{
							id: "current",
							status: "active",
							key: [...Buffer.from(ACTIVE_KEY, "base64url")],
						},
						{
							id: "previous",
							status: "retained",
							key: [...Buffer.from(RETAINED_KEY, "base64url")],
						},
					],
				});
				expectDeeplyFrozen(result);
			});

			it("canonicalizes key-array order instead of deriving activation from order", () => {
				const keys = [
					{ id: "current", status: "active", key: ACTIVE_KEY },
					{ id: "previous", status: "retained", key: RETAINED_KEY },
					{ id: "compromised", status: "revoked" },
				];

				const forward = loadPath(writeKeyFile(validKeyFile(keys)));
				const reordered = loadPath(
					writeKeyFile(validKeyFile([...keys].reverse())),
				);

				expect(reordered).toEqual(forward);
			});

			it("accepts a 64-character key ID and rejects a 65-character key ID", () => {
				const maximumKeyId = `a${"b".repeat(63)}`;
				const oversizedKeyId = `${maximumKeyId}c`;
				const maximum = loadPath(
					writeKeyFile({
						version: 1,
						activeKeyId: maximumKeyId,
						keys: [{ id: maximumKeyId, status: "active", key: ACTIVE_KEY }],
					}),
				);
				const oversized = loadPath(
					writeKeyFile({
						version: 1,
						activeKeyId: oversizedKeyId,
						keys: [{ id: oversizedKeyId, status: "active", key: ACTIVE_KEY }],
					}),
				);

				expect(maximum).toMatchObject({
					status: "ready",
					activeKeyId: maximumKeyId,
				});
				expect(oversized).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("restores the same keyring and exposes explicit rotation state", () => {
				const original = loadPath(writeKeyFile(validKeyFile()));
				const restored = loadPath(writeKeyFile(validKeyFile()));
				const rotated = loadPath(
					writeKeyFile({
						version: 1,
						activeKeyId: "next",
						keys: [
							{ id: "previous", status: "revoked" },
							{ id: "next", status: "active", key: NEXT_KEY },
							{ id: "current", status: "retained", key: ACTIVE_KEY },
						],
					}),
				);

				expect(restored).toEqual(original);
				expect(rotated).toMatchObject({
					status: "ready",
					activeKeyId: "next",
					keys: [
						{ id: "current", status: "retained" },
						{ id: "next", status: "active" },
						{ id: "previous", status: "revoked" },
					],
				});
				expectDeeplyFrozen(rotated);
			});

			it.each([
				0o640, 0o644,
			])("rejects a replay key file with group or world access (%o)", (mode) => {
				expect(loadPath(writeKeyFile(validKeyFile(), mode))).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("rejects symlinks and non-regular files", () => {
				const target = writeKeyFile(validKeyFile());
				const symlink = join(getTestDirectory(), "keys-link.json");
				symlinkSync(target, symlink);
				const directory = join(getTestDirectory(), "keys-directory");
				mkdirSync(directory, { mode: 0o700 });

				const unavailable = loadPath(symlink);
				expect(unavailable).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
				expect(loadPath(directory)).toBe(unavailable);
			});

			it("pins FIFO and device payloads without opening them for read", () => {
				const fifoPath = join(
					getTestDirectory(),
					`keys-fifo-${fileCounter++}.json`,
				);
				const mkfifo = Bun.spawnSync({ cmd: ["mkfifo", fifoPath] });
				expect(mkfifo.exitCode).toBe(0);
				const originalOpenSync = fs.openSync;
				const openCalls: Array<{ path: string; flags: number }> = [];
				const open = spyOn(fs, "openSync").mockImplementation(((
					...args: unknown[]
				) => {
					const [path, flags] = args;
					if (typeof path === "string" && typeof flags === "number") {
						openCalls.push({ path, flags });
					}
					return Reflect.apply(originalOpenSync, fs, args) as number;
				}) as typeof fs.openSync);

				try {
					for (const path of [fifoPath, "/dev/null"]) {
						openCalls.length = 0;
						expect(loadPath(path)).toEqual({
							status: "unavailable",
							code: "invalid_replay_key_config",
						});
						const finalComponent = basename(path);
						const finalComponentOpens = openCalls.filter(({ path: opened }) =>
							opened.endsWith(`/${finalComponent}`),
						);
						expect(finalComponentOpens.length).toBeGreaterThan(0);
						expect(
							finalComponentOpens.every(
								({ flags }) => (flags & 0o10000000) === 0o10000000,
							),
						).toBe(true);
					}
				} finally {
					open.mockRestore();
				}
			});

			it("rejects same-size in-place mutation during the bounded read", () => {
				const originalContents = JSON.stringify(validKeyFile());
				const mutatedContents = originalContents.replace(
					ACTIVE_KEY,
					RETAINED_KEY,
				);
				expect(mutatedContents).not.toBe(originalContents);
				expect(Buffer.byteLength(mutatedContents)).toBe(
					Buffer.byteLength(originalContents),
				);
				const keyPath = writeRawKeyFile(originalContents);
				const originalReadSync = fs.readSync;
				let mutated = false;
				const read = spyOn(fs, "readSync").mockImplementation(((
					...args: unknown[]
				) => {
					const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
					if (!mutated && bytesRead > 0) {
						mutated = true;
						writeFileSync(keyPath, mutatedContents);
						const future = new Date(Date.now() + 10_000);
						utimesSync(keyPath, future, future);
					}
					return bytesRead;
				}) as typeof fs.readSync);

				try {
					expect(loadPath(keyPath)).toEqual({
						status: "unavailable",
						code: "invalid_replay_key_config",
					});
					expect(mutated).toBe(true);
				} finally {
					read.mockRestore();
				}
			});

			it("rejects a replay key file reached through an intermediate symlink", () => {
				const realDirectory = join(
					getTestDirectory(),
					`real-parent-${fileCounter++}`,
				);
				const linkedDirectory = join(
					getTestDirectory(),
					`linked-parent-${fileCounter++}`,
				);
				mkdirSync(realDirectory, { mode: 0o700 });
				const keyPath = join(realDirectory, "keys.json");
				writeFileSync(keyPath, JSON.stringify(validKeyFile()), { mode: 0o600 });
				chmodSync(keyPath, 0o600);
				symlinkSync(realDirectory, linkedDirectory, "dir");

				expect(loadPath(join(linkedDirectory, "keys.json"))).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("rejects a multiply linked replay key file", () => {
				const keyPath = writeKeyFile(validKeyFile());
				const secondLink = join(
					getTestDirectory(),
					`keys-hard-link-${fileCounter++}.json`,
				);
				linkSync(keyPath, secondLink);
				expect(statSync(keyPath).nlink).toBe(2);

				expect(loadPath(keyPath)).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("rejects a replay key file larger than 64 KiB", () => {
				const oversizedKeys = [
					{ id: "current", status: "active", key: ACTIVE_KEY },
					...Array.from({ length: 2_500 }, (_, index) => ({
						id: `revoked-${index}`,
						status: "revoked",
					})),
				];
				const keyPath = writeKeyFile(validKeyFile(oversizedKeys));
				expect(statSync(keyPath).size).toBeGreaterThan(64 * 1024);

				expect(loadPath(keyPath)).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it.each([
				[
					"repeated root member",
					`{"version":1,"version":1,"activeKeyId":"current","keys":[{"id":"current","status":"active","key":"${ACTIVE_KEY}"}]}`,
				],
				[
					"escape-equivalent root member",
					`{"version":1,"\\u0076ersion":1,"activeKeyId":"current","keys":[{"id":"current","status":"active","key":"${ACTIVE_KEY}"}]}`,
				],
				[
					"escape-equivalent active key member",
					`{"version":1,"activeKeyId":"ignored","active\\u004beyId":"current","keys":[{"id":"current","status":"active","key":"${ACTIVE_KEY}"}]}`,
				],
				[
					"repeated nested key-record member",
					`{"version":1,"activeKeyId":"current","keys":[{"id":"current","\\u0069d":"current","status":"active","key":"${ACTIVE_KEY}"}]}`,
				],
			] as const)("rejects a JSON document with a %s", (_label, contents) => {
				expect(loadPath(writeRawKeyFile(contents))).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("rejects excessive JSON nesting before the full-document parse", () => {
				const nestedValue = `${"[".repeat(65)}null${"]".repeat(65)}`;
				const contents = `{"version":1,"activeKeyId":"current","keys":${nestedValue}}`;
				const originalParse = JSON.parse;
				let fullDocumentParses = 0;
				const parse = spyOn(JSON, "parse").mockImplementation(((
					...args: unknown[]
				) => {
					if (args[0] === contents) fullDocumentParses += 1;
					return Reflect.apply(originalParse, JSON, args) as unknown;
				}) as typeof JSON.parse);

				try {
					expect(loadPath(writeRawKeyFile(contents))).toEqual({
						status: "unavailable",
						code: "invalid_replay_key_config",
					});
					expect(fullDocumentParses).toBe(0);
				} finally {
					parse.mockRestore();
				}
			});

			it.each([
				["zero", "0"],
				["negative zero", "-0"],
				["integer", "1234567890"],
				["fraction", "-12.375"],
				["positive exponent", "6.022e+23"],
				["negative exponent", "1E-9"],
			] as const)("accepts a valid JSON number token: %s", (_label, numberToken) => {
				const contents = `{"probe":${numberToken}}`;
				const originalParse = JSON.parse;
				let fullDocumentParses = 0;
				const parse = spyOn(JSON, "parse").mockImplementation(((
					...args: unknown[]
				) => {
					if (args[0] === contents) fullDocumentParses += 1;
					return Reflect.apply(originalParse, JSON, args) as unknown;
				}) as typeof JSON.parse);

				try {
					expect(loadPath(writeRawKeyFile(contents))).toEqual({
						status: "unavailable",
						code: "invalid_replay_key_config",
					});
					expect(fullDocumentParses).toBe(1);
				} finally {
					parse.mockRestore();
				}
			});

			it.each([
				["leading zero", "01"],
				["bare minus", "-"],
				["missing integer", ".5"],
				["missing fraction", "1."],
				["missing exponent", "1e"],
				["missing signed exponent", "1e+"],
				["leading plus", "+1"],
			] as const)("rejects an invalid JSON number token before the full parse: %s", (_label, numberToken) => {
				const contents = `{"probe":${numberToken}}`;
				const originalParse = JSON.parse;
				let fullDocumentParses = 0;
				const parse = spyOn(JSON, "parse").mockImplementation(((
					...args: unknown[]
				) => {
					if (args[0] === contents) fullDocumentParses += 1;
					return Reflect.apply(originalParse, JSON, args) as unknown;
				}) as typeof JSON.parse);

				try {
					expect(loadPath(writeRawKeyFile(contents))).toEqual({
						status: "unavailable",
						code: "invalid_replay_key_config",
					});
					expect(fullDocumentParses).toBe(0);
				} finally {
					parse.mockRestore();
				}
			});

			it("scans a near-limit numeric array without tail-string copies", () => {
				const contents = `{"probe":[${"0,".repeat(31_999)}0]}`;
				expect(Buffer.byteLength(contents)).toBeGreaterThan(63_000);
				expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(64 * 1024);
				const keyPath = writeRawKeyFile(contents);
				const originalParse = JSON.parse;
				const originalSlice = String.prototype.slice;
				let fullDocumentParses = 0;
				let unboundedTailSlices = 0;
				const parse = spyOn(JSON, "parse").mockImplementation(((
					...args: unknown[]
				) => {
					if (args[0] === contents) fullDocumentParses += 1;
					return Reflect.apply(originalParse, JSON, args) as unknown;
				}) as typeof JSON.parse);
				const slice = spyOn(String.prototype, "slice").mockImplementation(
					function (this: string, start?: number, end?: number): string {
						if (this.valueOf() === contents && end === undefined) {
							unboundedTailSlices += 1;
						}
						return Reflect.apply(originalSlice, this, [start, end]) as string;
					},
				);

				try {
					expect(loadPath(keyPath)).toEqual({
						status: "unavailable",
						code: "invalid_replay_key_config",
					});
					expect(fullDocumentParses).toBe(1);
					expect(unboundedTailSlices).toBe(0);
				} finally {
					slice.mockRestore();
					parse.mockRestore();
				}
			});

			it.each([
				["wrong version", { ...validKeyFile(), version: 2 }],
				["missing active key ID", { version: 1, keys: [] }],
				[
					"unsafe active key ID",
					{ ...validKeyFile(), activeKeyId: "../current" },
				],
				[
					"active key ID begins with a hyphen",
					{
						version: 1,
						activeKeyId: "-current",
						keys: [{ id: "-current", status: "active", key: ACTIVE_KEY }],
					},
				],
				[
					"active key ID begins with an underscore",
					{
						version: 1,
						activeKeyId: "_current",
						keys: [{ id: "_current", status: "active", key: ACTIVE_KEY }],
					},
				],
				[
					"duplicate IDs",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "current", status: "retained", key: RETAINED_KEY },
					]),
				],
				[
					"duplicate usable raw key material",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "previous", status: "retained", key: ACTIVE_KEY },
					]),
				],
				[
					"record ID begins with a hyphen",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "-previous", status: "retained", key: RETAINED_KEY },
					]),
				],
				[
					"record ID begins with an underscore",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "_previous", status: "retained", key: RETAINED_KEY },
					]),
				],
				[
					"unsafe record ID",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "unsafe.key", status: "retained", key: RETAINED_KEY },
					]),
				],
				[
					"active ID points at retained record",
					{
						version: 1,
						activeKeyId: "current",
						keys: [
							{ id: "current", status: "retained", key: ACTIVE_KEY },
							{ id: "other", status: "active", key: NEXT_KEY },
						],
					},
				],
				[
					"multiple active records",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "other", status: "active", key: NEXT_KEY },
					]),
				],
				[
					"invalid status",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "previous", status: "retired", key: RETAINED_KEY },
					]),
				],
				[
					"missing retained key",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "previous", status: "retained" },
					]),
				],
				[
					"revoked record retains key bytes",
					validKeyFile([
						{ id: "current", status: "active", key: ACTIVE_KEY },
						{ id: "compromised", status: "revoked", key: RETAINED_KEY },
					]),
				],
				[
					"short key",
					validKeyFile([{ id: "current", status: "active", key: "c2hvcnQ" }]),
				],
				[
					"padded base64url key",
					validKeyFile([
						{ id: "current", status: "active", key: `${ACTIVE_KEY}=` },
					]),
				],
				[
					"unexpected root property",
					{ ...validKeyFile(), source: "environment" },
				],
			] as const)("fails closed for %s", (_label, value) => {
				const result = loadPath(writeKeyFile(value));

				expect(result).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
				expectDeeplyFrozen(result);
			});

			it("returns the same redacted unavailable DTO for every configured failure", () => {
				const sentinel = "replay-secret-SENTINEL-must-not-leak";
				const sentinelPath = join(getTestDirectory(), `${sentinel}.json`);
				writeFileSync(sentinelPath, `{ "version": 1, "key": "${sentinel}"`, {
					mode: 0o600,
				});

				const malformed = loadPath(sentinelPath);
				const duplicateJson = loadPath(
					writeRawKeyFile(
						`{"version":1,"version":1,"activeKeyId":"current","keys":[{"id":"current","status":"active","key":"${ACTIVE_KEY}"}]}`,
					),
				);
				const duplicateMaterial = loadPath(
					writeKeyFile(
						validKeyFile([
							{ id: "current", status: "active", key: ACTIVE_KEY },
							{ id: "previous", status: "retained", key: ACTIVE_KEY },
						]),
					),
				);
				const missing = loadPath(
					join(getTestDirectory(), `${sentinel}-missing.json`),
				);
				const win32 = loadPath(sentinelPath, "win32");

				expect(malformed).toBe(duplicateJson);
				expect(duplicateJson).toBe(duplicateMaterial);
				expect(duplicateMaterial).toBe(missing);
				expect(missing).toBe(win32);
				expect(malformed).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
				expect(JSON.stringify(malformed)).not.toContain(sentinel);
				expect(malformed).not.toHaveProperty("path");
				expect(malformed).not.toHaveProperty("key");
				expect(malformed).not.toHaveProperty("error");
				expectDeeplyFrozen(malformed);
			});

			it.each([
				"relative",
				"non-normalized",
				"NUL-containing",
			])("rejects a %s configured path", (label) => {
				const keyPath = writeKeyFile(validKeyFile());
				const configuredPath =
					label === "relative"
						? "tmp/replay-keys.json"
						: label === "non-normalized"
							? `//${keyPath.slice(1)}`
							: `${keyPath}\0ignored`;
				expect(loadPath(configuredPath)).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});

			it("never emits a configured path sentinel through Logger diagnostics", () => {
				const sentinel = "replay-path-SENTINEL-must-not-reach-diagnostics";
				const sentinelDirectory = join(getTestDirectory(), sentinel);
				mkdirSync(sentinelDirectory, { mode: 0o700 });
				const sentinelPath = join(sentinelDirectory, "keys.json");
				writeFileSync(sentinelPath, JSON.stringify(validKeyFile()), {
					mode: 0o600,
				});
				chmodSync(sentinelPath, 0o600);

				const diagnostics: unknown[][] = [];
				const debug = spyOn(Logger.prototype, "debug").mockImplementation(
					(message, data) => diagnostics.push(["debug", message, data]),
				);
				const info = spyOn(Logger.prototype, "info").mockImplementation(
					(message, data) => diagnostics.push(["info", message, data]),
				);
				const warn = spyOn(Logger.prototype, "warn").mockImplementation(
					(message, data) => diagnostics.push(["warn", message, data]),
				);
				const error = spyOn(Logger.prototype, "error").mockImplementation(
					(message, data) => diagnostics.push(["error", message, data]),
				);

				try {
					expect(loadPath(sentinelPath).status).toBe("ready");
					expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
				} finally {
					debug.mockRestore();
					info.mockRestore();
					warn.mockRestore();
					error.mockRestore();
				}
			});

			it("treats a configured blank path as unavailable", () => {
				expect(
					loadServerToolReplayKeys({
						[CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE]: "",
					}),
				).toEqual({
					status: "unavailable",
					code: "invalid_replay_key_config",
				});
			});
		},
	);
});
