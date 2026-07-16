import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-cache-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getRuntime().database.cacheSize", () => {
	it("defaults to a 256MB negative-KiB page cache on a fresh config file", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().database?.cacheSize).toBe(-262144);
		} finally {
			cleanup();
		}
	});

	it("still honors an explicit db_cache_size override", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("db_cache_size", -8000);
			expect(config.getRuntime().database?.cacheSize).toBe(-8000);
		} finally {
			cleanup();
		}
	});
});
