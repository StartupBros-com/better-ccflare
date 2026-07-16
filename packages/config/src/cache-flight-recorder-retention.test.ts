import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-recorder-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getCacheFlightRecorderRetentionHours", () => {
	const original = process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS;
	beforeEach(() => {
		delete process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS;
	});
	afterEach(() => {
		if (original === undefined)
			delete process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS;
		else process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS = original;
	});

	it("defaults to 72 hours", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheFlightRecorderRetentionHours()).toBe(72);
		} finally {
			cleanup();
		}
	});

	it("clamps environment overrides to 1 hour through 14 days", () => {
		const { config, cleanup } = makeConfig();
		try {
			process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS = "0";
			expect(config.getCacheFlightRecorderRetentionHours()).toBe(1);
			process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS = "999";
			expect(config.getCacheFlightRecorderRetentionHours()).toBe(336);
		} finally {
			cleanup();
		}
	});

	it("clamps persisted values and exposes the active policy", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("cache_flight_recorder_retention_hours", 500);
			expect(config.getCacheFlightRecorderRetentionHours()).toBe(336);
			expect(
				config.getAllSettings().cache_flight_recorder_retention_hours,
			).toBe(336);
		} finally {
			cleanup();
		}
	});
});
