/**
 * Tests for pausing an account for re-authentication when its OAuth refresh
 * token is permanently revoked/invalid (invalid_grant, refresh_token_reused,
 * etc), instead of burning failed requests until the generic
 * failure_threshold pause trips.
 *
 * Covers:
 *  - pauseAccountForReauthIfInvalidGrant classifies typed OAuthRefreshTokenError
 *    and message-based invalid_grant markers, and ignores transient failures.
 *  - refreshAccessTokenSafe (the token-refresh chokepoint) pauses the account
 *    for reauth when the provider's refreshToken throws a terminal OAuth
 *    error, but does NOT pause on a transient/network refresh failure.
 */

import { describe, expect, it, mock } from "bun:test";
import {
	type AuthFailureEvt,
	authFailureEvents,
	OAuthRefreshTokenError,
} from "@better-ccflare/core";
import { registerProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	clearAccountRefreshCache,
	pauseAccountForReauthIfInvalidGrant,
	refreshAccessTokenSafe,
} from "../handlers/token-manager";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "test-reauth-provider",
		api_key: null,
		refresh_token: "rt-original",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeDbOps(pauseResult = true) {
	const pauseAccountIfActive = mock(async () => pauseResult);
	return { pauseAccountIfActive };
}

describe("pauseAccountForReauthIfInvalidGrant", () => {
	it("publishes exactly one auth-failure event after winning the canonical pause guard", async () => {
		const dbOps = makeDbOps(true);
		const account = {
			id: "acc-1",
			name: "test",
			provider: "anthropic",
			refresh_token: "rt-1",
		};
		const events: AuthFailureEvt[] = [];
		const listener = (event: AuthFailureEvt) => events.push(event);
		authFailureEvents.on("event", listener);

		try {
			const paused = await pauseAccountForReauthIfInvalidGrant(
				new OAuthRefreshTokenError("acc-1"),
				account,
				dbOps as never,
			);

			expect(paused).toBe(true);
			expect(dbOps.pauseAccountIfActive).toHaveBeenCalledTimes(1);
			expect(dbOps.pauseAccountIfActive.mock.calls[0]).toEqual([
				"acc-1",
				"oauth_invalid_grant",
				"rt-1",
			]);
			expect(events).toEqual([
				{
					accountId: "acc-1",
					accountName: "test",
					provider: "anthropic",
					reason: "oauth_invalid_grant",
				},
			]);
		} finally {
			authFailureEvents.off("event", listener);
		}
	});

	it("pauses on a message-based invalid_grant marker (non-typed Error)", async () => {
		const dbOps = makeDbOps(true);
		const account = {
			id: "acc-2",
			name: "test",
			provider: "codex",
			refresh_token: "rt-2",
		};

		const paused = await pauseAccountForReauthIfInvalidGrant(
			new Error("Failed to refresh Codex token: refresh_token_reused"),
			account,
			dbOps as never,
		);

		expect(paused).toBe(true);
		expect(dbOps.pauseAccountIfActive).toHaveBeenCalledTimes(1);
	});

	it("does not publish when another writer wins the pause guard", async () => {
		const dbOps = makeDbOps(false);
		const account = {
			id: "acc-guard-lost",
			name: "test",
			provider: "anthropic",
			refresh_token: "rt-guard-lost",
		};
		const events: AuthFailureEvt[] = [];
		const listener = (event: AuthFailureEvt) => events.push(event);
		authFailureEvents.on("event", listener);

		try {
			const paused = await pauseAccountForReauthIfInvalidGrant(
				new OAuthRefreshTokenError("acc-guard-lost"),
				account,
				dbOps as never,
			);

			expect(paused).toBe(false);
			expect(events).toEqual([]);
		} finally {
			authFailureEvents.off("event", listener);
		}
	});

	it("does NOT pause on a transient network failure", async () => {
		const dbOps = makeDbOps(true);
		const account = {
			id: "acc-3",
			name: "test",
			provider: "anthropic",
			refresh_token: "rt-3",
		};
		const events: AuthFailureEvt[] = [];
		const listener = (event: AuthFailureEvt) => events.push(event);
		authFailureEvents.on("event", listener);

		try {
			const paused = await pauseAccountForReauthIfInvalidGrant(
				new Error("fetch failed: ETIMEDOUT"),
				account,
				dbOps as never,
			);

			expect(paused).toBe(false);
			expect(dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
			expect(events).toEqual([]);
		} finally {
			authFailureEvents.off("event", listener);
		}
	});

	it("returns false and does not throw when the pause call itself throws", async () => {
		const dbOps = {
			pauseAccountIfActive: mock(async () => {
				throw new Error("db locked");
			}),
		};
		const account = {
			id: "acc-4",
			name: "test",
			provider: "anthropic",
			refresh_token: "rt-4",
		};

		const paused = await pauseAccountForReauthIfInvalidGrant(
			new OAuthRefreshTokenError("acc-4"),
			account,
			dbOps as never,
		);

		expect(paused).toBe(false);
	});
});

describe("refreshAccessTokenSafe — pause-for-reauth at the chokepoint", () => {
	function makeCtx(pauseResult = true) {
		const pauseAccountIfActive = mock(async () => pauseResult);
		const ctx = {
			dbOps: {
				pauseAccountIfActive,
				getAccount: mock(async () => null),
				updateAccountTokens: mock(async () => {}),
			},
			asyncWriter: { enqueue: (fn: () => unknown) => fn() },
			refreshInFlight: new Map<string, Promise<string>>(),
			runtime: { clientId: "test-client" },
			provider: undefined,
		};
		return { ctx, pauseAccountIfActive };
	}

	it("pauses the account for reauth when the provider throws OAuthRefreshTokenError", async () => {
		registerProvider({
			name: "test-reauth-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-1", "revoked");
			},
		} as never);

		const account = makeAccount();
		const { ctx, pauseAccountIfActive } = makeCtx(true);

		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		expect(pauseAccountIfActive).toHaveBeenCalledTimes(1);
		expect(pauseAccountIfActive.mock.calls[0][0]).toBe("acc-1");
		expect(pauseAccountIfActive.mock.calls[0][1]).toBe("oauth_invalid_grant");

		clearAccountRefreshCache(account.id);
	});

	it("does NOT pause the account on a transient network refresh failure", async () => {
		registerProvider({
			name: "test-reauth-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error("fetch failed: ETIMEDOUT");
			},
		} as never);

		const account = makeAccount({ id: "acc-transient" });
		const { ctx, pauseAccountIfActive } = makeCtx(true);

		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		expect(pauseAccountIfActive).not.toHaveBeenCalled();

		clearAccountRefreshCache(account.id);
	});
});
