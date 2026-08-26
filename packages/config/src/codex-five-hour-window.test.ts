import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ORIGINAL_ENV = process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED;

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("Codex five-hour window setting", () => {
	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED;
		} else {
			process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED = ORIGINAL_ENV;
		}
	});

	it("defaults off and is included in all settings", () => {
		delete process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCodexFiveHourWindowEnabled()).toBe(false);
			expect(config.getAllSettings().codex_five_hour_window_enabled).toBe(
				false,
			);
		} finally {
			cleanup();
		}
	});

	it("honors explicit environment values over the persisted setting", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCodexFiveHourWindowEnabled(true);
			process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED = "disabled";
			expect(config.getCodexFiveHourWindowEnabled()).toBe(false);
			process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED = "true";
			expect(config.getCodexFiveHourWindowEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("persists the configured value when no environment override exists", () => {
		delete process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED;
		const { config, cleanup } = makeConfig();
		try {
			config.setCodexFiveHourWindowEnabled(true);
			expect(config.getCodexFiveHourWindowEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});
});
