import { describe, expect, test } from "bun:test";
import {
	ACCOUNT_MODES,
	renderAddAccountModeUsageError,
	renderHelpText,
} from "../apps/cli/src/main";

// Regression coverage for issue #152: apps/cli/src/main.ts used to
// hand-maintain the account-mode list in three separate places (the
// --mode validModes array, the --help text, and the "Available modes"
// error printed when --add-account is given without --mode). Those
// listings drifted: --help and the no-mode error were missing "ollama"
// and "muse-spark". The fix hoists a single ACCOUNT_MODES constant that
// all three listings derive from, so this suite asserts derivation
// directly from the constant (no hardcoded mode list in the test) plus
// an explicit pin for the two modes that were previously missing.

describe("ACCOUNT_MODES is the single source of truth for account modes", () => {
	test("has no duplicate entries", () => {
		const unique = new Set(ACCOUNT_MODES);
		expect(unique.size).toBe(ACCOUNT_MODES.length);
	});

	test("help output contains every mode in ACCOUNT_MODES", () => {
		const help = renderHelpText("0.0.0-test");
		for (const mode of ACCOUNT_MODES) {
			expect(help).toContain(mode);
		}
	});

	test("no-mode usage error contains every mode in ACCOUNT_MODES", () => {
		const usageError = renderAddAccountModeUsageError();
		for (const mode of ACCOUNT_MODES) {
			expect(usageError).toContain(mode);
		}
	});

	test("regression pin: ollama and muse-spark appear in --help output", () => {
		const help = renderHelpText("0.0.0-test");
		expect(help).toContain("ollama");
		expect(help).toContain("muse-spark");
	});

	test("regression pin: ollama and muse-spark appear in the no-mode usage error", () => {
		const usageError = renderAddAccountModeUsageError();
		expect(usageError).toContain("ollama");
		expect(usageError).toContain("muse-spark");
	});
});
