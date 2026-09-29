import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// Guards bunfig.toml's [test] preload: without it tests share /tmp paths with
// the production service (pricing cache, model catalog cache, app.log).
describe("bun test preload", () => {
	test("tmpdir() is a per-process directory", () => {
		expect(basename(tmpdir()).startsWith("ccflare-test-")).toBe(true);
		expect(dirname(tmpdir())).not.toBe(tmpdir());
	});

	test("log and model-cache overrides resolve under the per-process dir", () => {
		const root = tmpdir() + "/";
		expect(process.env.BETTER_CCFLARE_LOG_DIR?.startsWith(root)).toBe(true);
		expect(process.env.BETTER_CCFLARE_MODELS_CACHE_DIR?.startsWith(root)).toBe(
			true,
		);
		expect(join(tmpdir(), "x").startsWith(root)).toBe(true);
	});
});
