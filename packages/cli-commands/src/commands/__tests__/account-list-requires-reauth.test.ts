import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { getAccountsList } from "../account";

describe("getAccountsList canonical reauthentication state", () => {
	it("carries the oauth_invalid_grant-derived state into CLI list items", async () => {
		const account = {
			id: "account-1",
			name: "Account 1",
			provider: "anthropic",
			expires_at: Date.now() + 60_000,
			created_at: Date.now(),
			last_used: null,
			request_count: 0,
			total_requests: 0,
			paused: true,
			requires_reauth: true,
			pause_reason: "oauth_invalid_grant",
			rate_limited_until: null,
			session_start: null,
			session_request_count: 0,
			access_token: "access-token",
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			cross_region_mode: null,
		} as Account;
		const dbOps = { getAllAccounts: async () => [account] };

		const result = await getAccountsList(dbOps as never);

		expect(result[0]?.requiresReauth).toBe(true);
	});
});
