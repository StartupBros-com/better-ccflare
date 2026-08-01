import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isNativeAnthropicOAuthDegradedModeEligible } from "../anthropic-degraded-eligibility";

type EligibilityAccount = Pick<
	Account,
	"provider" | "billing_type" | "api_key" | "refresh_token" | "access_token"
>;

function makeAccount(
	overrides: Partial<EligibilityAccount> = {},
): EligibilityAccount {
	return {
		provider: "anthropic",
		billing_type: null,
		api_key: null,
		refresh_token: "oauth-refresh-token",
		access_token: "oauth-access-token",
		...overrides,
	};
}

describe("isNativeAnthropicOAuthDegradedModeEligible", () => {
	it("accepts only native Anthropic accounts with a usable OAuth refresh path", () => {
		expect(isNativeAnthropicOAuthDegradedModeEligible(makeAccount())).toBe(
			true,
		);
		expect(
			isNativeAnthropicOAuthDegradedModeEligible(
				makeAccount({ api_key: "   ", refresh_token: "  refresh-token  " }),
			),
		).toBe(true);
	});

	for (const [label, account] of [
		["Anthropic API key", makeAccount({ api_key: "api-key" })],
		[
			"Anthropic access token only",
			makeAccount({ refresh_token: " ", access_token: "access-token" }),
		],
		["Codex OAuth", makeAccount({ provider: "codex" })],
		[
			"Anthropic-compatible",
			makeAccount({
				provider: "anthropic-compatible",
				api_key: "compatible-key",
				refresh_token: null,
				access_token: null,
			}),
		],
		["contradictory API billing", makeAccount({ billing_type: "api" })],
	] as const) {
		it(`rejects ${label}`, () => {
			expect(isNativeAnthropicOAuthDegradedModeEligible(account)).toBe(false);
		});
	}
});
