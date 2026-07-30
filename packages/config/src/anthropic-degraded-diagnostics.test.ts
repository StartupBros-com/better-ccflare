import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_NAME = "CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS";
const original = process.env[ENV_NAME];

function makeConfig(): { config: Config; cleanup: () => void } {
	const directory = mkdtempSync(
		join(tmpdir(), "better-ccflare-degraded-diagnostics-"),
	);
	return {
		config: new Config(join(directory, "config.json")),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

describe("Anthropic degraded detailed diagnostics configuration", () => {
	beforeEach(() => {
		delete process.env[ENV_NAME];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV_NAME];
		else process.env[ENV_NAME] = original;
	});

	it("defaults off and exposes only the fixed boolean setting", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(false);
			expect(
				config.getAllSettings().anthropic_degraded_diagnostics_enabled,
			).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("accepts explicit booleans with env precedence", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("anthropic_degraded_diagnostics_enabled", true);
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(true);

			process.env[ENV_NAME] = "false";
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(false);

			process.env[ENV_NAME] = "1";
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("fails closed for malformed env or file values", () => {
		const { config, cleanup } = makeConfig();
		try {
			process.env[ENV_NAME] = "sometimes";
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(false);

			delete process.env[ENV_NAME];
			config.set(
				"anthropic_degraded_diagnostics_enabled",
				"true" as unknown as boolean,
			);
			expect(config.getAnthropicDegradedDiagnosticsEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});
});
