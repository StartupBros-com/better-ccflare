import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { getAccountsList } from "../account";

/**
 * A Muse Spark account holds a static API key: no OAuth access token and no
 * expiry. Classification derived from those two fields alone reported a working
 * account as an expired `console` account, misleading operators and anything
 * consuming `account list --json`.
 */
function museSparkAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "muse-1",
		name: "meta",
		provider: "muse-spark",
		api_key: "LLM|123|secret",
		access_token: null,
		refresh_token: null,
		expires_at: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		paused: false,
		requires_reauth: false,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: "https://api.meta.ai",
		cross_region_mode: null,
		...overrides,
	} as Account;
}

describe("getAccountsList Muse Spark classification", () => {
	it("reports the mode as muse-spark, not console", async () => {
		const dbOps = { getAllAccounts: async () => [museSparkAccount()] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.mode).toBe("muse-spark");
	});

	it("does not report a static API-key account as expired", async () => {
		const dbOps = { getAllAccounts: async () => [museSparkAccount()] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.tokenStatus).toBe("valid");
	});

	it("still reports a genuinely expired OAuth account as expired", async () => {
		const expiredOAuth = museSparkAccount({
			id: "oauth-1",
			provider: "anthropic",
			api_key: null,
			access_token: "token",
			expires_at: Date.now() - 60_000,
		});
		const dbOps = { getAllAccounts: async () => [expiredOAuth] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.tokenStatus).toBe("expired");
	});
});
