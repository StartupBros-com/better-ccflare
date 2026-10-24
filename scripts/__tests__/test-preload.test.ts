import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// Guards bunfig.toml's [test] preload: without it tests share /tmp paths with
// the production service (pricing cache, model catalog cache, app.log).
describe("bun test preload", () => {
	test("tmpdir() is a per-process directory", () => {
		expect(basename(tmpdir()).startsWith("ccflare-test-")).toBe(true);
		expect(dirname(tmpdir())).not.toBe(tmpdir());
	});

	test("every variable tmpdir() may read points at the per-process dir", () => {
		// Windows reads TEMP/TMP, not TMPDIR.
		expect(process.env.TMPDIR).toBe(tmpdir());
		expect(process.env.TEMP).toBe(tmpdir());
		expect(process.env.TMP).toBe(tmpdir());
	});

	test("log and model-cache overrides resolve under the per-process dir", () => {
		const root = tmpdir() + sep;
		expect(process.env.BETTER_CCFLARE_LOG_DIR?.startsWith(root)).toBe(true);
		expect(process.env.BETTER_CCFLARE_MODELS_CACHE_DIR?.startsWith(root)).toBe(
			true,
		);
		expect(join(tmpdir(), "x").startsWith(root)).toBe(true);
	});
});

describe("bun test preload teardown", () => {
	for (const mode of [
		"unused",
		"import-only",
		"queued-writes",
		"open-error",
	] as const) {
		test(`cleans up safely with logger ${mode}`, () => {
			const root = mkdtempSync(join(tmpdir(), "preload-lifecycle-"));
			try {
				const outside = join(root, "outside");
				mkdirSync(outside);
				const sentinel = join(outside, "app.log");
				writeFileSync(sentinel, "untouched");
				const fixture = join(root, "lifecycle.test.ts");
				const observer = join(root, "observe-preload.ts");
				const preload = resolve(import.meta.dir, "../test-preload.ts");
				const writer = resolve(
					import.meta.dir,
					"../../packages/logger/src/file-writer.ts",
				);

				// Delay the real filesystem open to deterministically put it after
				// synchronous test completion. The final hook keeps Bun alive to
				// observe completion/errors, even on the old premature-cleanup path.
				writeFileSync(
					observer,
					`import { afterAll, expect, mock } from "bun:test";
import * as fs from "node:fs";
import { finished } from "node:stream/promises";
const createWriteStream = fs.createWriteStream;
const open = fs.open;
const streams = [];
mock.module("node:fs", () => ({
	...fs,
	createWriteStream(path, options) {
		${mode === "open-error" ? "fs.mkdirSync(path);" : ""}
		const stream = createWriteStream(path, {
			...options,
			fs: {
				open: (...args) => setTimeout(() => open(...args), 25),
				write: fs.write,
				writev: fs.writev,
				close: fs.close,
			},
		});
		streams.push(stream);
		return stream;
	},
}));
afterAll(async () => {
	expect(streams.length).toBe(${mode === "unused" ? 0 : 1});
	await Promise.all(streams.map((stream) => {
		const closed = finished(stream, { cleanup: true });
		if (!stream.writableEnded) stream.end();
		return closed;
	}));
});
`,
				);
				writeFileSync(
					fixture,
					`import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
${mode === "unused" ? "" : `import { logFileWriter } from ${JSON.stringify(writer)};`}
console.log("TEST_TMPDIR=" + tmpdir());
test("logger fixture", () => {
	expect(existsSync(tmpdir())).toBe(true);
	${mode === "unused" ? "" : "expect(logFileWriter).not.toBeNull();"}
	${mode === "queued-writes" ? 'logFileWriter.write({ ts: 1, level: "INFO", msg: "queued" });' : ""}
});
afterAll(() => {
	expect(existsSync(tmpdir())).toBe(true);
	${mode === "queued-writes" ? 'logFileWriter.write({ ts: 2, level: "INFO", msg: "final hook" });' : ""}
});
`,
				);
				const child = Bun.spawnSync(
					[
						process.execPath,
						"test",
						"--preload",
						preload,
						"--preload",
						observer,
						fixture,
					],
					{
						cwd: root,
						env: {
							...process.env,
							TMPDIR: root,
							TMP: root,
							TEMP: root,
							BETTER_CCFLARE_LOG_DIR: outside,
							BETTER_CCFLARE_MODELS_CACHE_DIR: outside,
						},
						stdout: "pipe",
						stderr: "pipe",
						timeout: 10_000,
					},
				);
				const output = child.stdout.toString() + child.stderr.toString();
				expect(output).not.toContain("ENOENT");
				if (mode === "open-error") {
					expect(child.exitCode).not.toBe(0);
					expect(output).toContain("EISDIR");
				} else {
					expect(child.exitCode).toBe(0);
				}
				const isolated = output.match(/^TEST_TMPDIR=(.+)$/m)?.[1]?.trim();
				expect(isolated).toBeDefined();
				expect(dirname(isolated as string)).toBe(root);
				// A failed drain must fail the run and leave its directory intact;
				// it must not remove files while another stream may still be active.
				expect(existsSync(isolated as string)).toBe(mode === "open-error");
				expect(readFileSync(sentinel, "utf8")).toBe("untouched");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
