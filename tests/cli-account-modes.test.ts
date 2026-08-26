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
// listings now derive from ACCOUNT_MODES, with canonical `meta` replacing
// the legacy CLI-only `muse-spark` spelling.

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

	test("uses canonical meta mode rather than the legacy muse-spark CLI alias", () => {
		const help = renderHelpText("0.0.0-test");
		const usageError = renderAddAccountModeUsageError();

		expect(ACCOUNT_MODES).toContain("meta");
		expect(ACCOUNT_MODES).not.toContain("muse-spark");
		expect(help).toContain("meta");
		expect(help).not.toContain("muse-spark");
		expect(usageError).toContain("meta");
		expect(usageError).not.toContain("muse-spark");
	});
});
