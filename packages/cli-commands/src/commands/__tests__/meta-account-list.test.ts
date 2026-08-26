import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { getAccountsList } from "../account";

/**
 * A Meta account holds a static API key: no OAuth access token and no
 * expiry. Classification derived from those two fields alone reported a working
 * account as an expired `console` account, misleading operators and anything
 * consuming `account list --json`.
 */
function metaAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "meta-1",
		name: "meta",
		provider: "meta",
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

describe("getAccountsList Meta classification", () => {
	it("reports the mode as meta, not console", async () => {
		const dbOps = { getAllAccounts: async () => [metaAccount()] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.mode).toBe("meta");
	});

	it("reports the mode as deepseek, not console", async () => {
		const dbOps = {
			getAllAccounts: async () => [
				metaAccount({ id: "deepseek-1", provider: "deepseek" }),
			],
		};

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.mode).toBe("deepseek");
	});

	it("does not report a static API-key account as expired", async () => {
		const dbOps = { getAllAccounts: async () => [metaAccount()] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.tokenStatus).toBe("valid");
	});

	it("still reports a genuinely expired OAuth account as expired", async () => {
		const expiredOAuth = metaAccount({
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
