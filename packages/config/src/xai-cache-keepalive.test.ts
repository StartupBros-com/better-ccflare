import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEY = "CCFLARE_XAI_CACHE_KEEPALIVE_TTL_MINUTES";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-xai-ka-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("xai_cache_keepalive_ttl_minutes", () => {
	const original = process.env[ENV_KEY];

	afterEach(() => {
		if (original === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = original;
	});

	it("defaults to 0 (disabled) on a fresh config", () => {
		delete process.env[ENV_KEY];
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("reads and clamps the file value to [0, 60]", () => {
		delete process.env[ENV_KEY];
		const { config, cleanup } = makeConfig();
		try {
			config.setXaiCacheKeepaliveTtlMinutes(2);
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(2);
			config.setXaiCacheKeepaliveTtlMinutes(999);
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(60);
			config.setXaiCacheKeepaliveTtlMinutes(-5);
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("prefers the env var over the file value and clamps it", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setXaiCacheKeepaliveTtlMinutes(2);
			process.env[ENV_KEY] = "5";
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(5);
			process.env[ENV_KEY] = "120";
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(60);
		} finally {
			cleanup();
		}
	});

	it("ignores a non-numeric env var and falls back to the file value", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setXaiCacheKeepaliveTtlMinutes(3);
			process.env[ENV_KEY] = "not-a-number";
			expect(config.getXaiCacheKeepaliveTtlMinutes()).toBe(3);
		} finally {
			cleanup();
		}
	});

	it("is reported in getAllSettings() independently of the global knob", () => {
		delete process.env[ENV_KEY];
		const { config, cleanup } = makeConfig();
		try {
			config.setXaiCacheKeepaliveTtlMinutes(2);
			const settings = config.getAllSettings();
			expect(settings.xai_cache_keepalive_ttl_minutes).toBe(2);
			// Global knob stays at its default (disabled) — the two are independent.
			expect(settings.cache_keepalive_ttl_minutes).toBe(0);
		} finally {
			cleanup();
		}
	});
});
