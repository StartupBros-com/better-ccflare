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
	TokenRefreshError,
} from "@better-ccflare/core";
import { registerProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	canAttemptStaleTokenRefresh,
	clearAccountRefreshCache,
	clearStaleTokenRefreshState,
	isStaleTokenRefreshCoolingDown,
	isTerminalTokenRefreshFailure,
	pauseAccountForReauthIfInvalidGrant,
	pauseAccountForUpstreamAuthFailure,
	refreshAccessTokenSafe,
	tryAcquireStaleTokenRefresh,
	upstreamAuthFailureReason,
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

class ReceiverBoundDbOps {
	calls: Array<[string, string, string | undefined]> = [];

	async pauseAccountIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string,
	): Promise<boolean> {
		this.calls.push([accountId, reason, expectedRefreshToken]);
		return true;
	}
}

describe("pauseAccountForReauthIfInvalidGrant", () => {
	it("invokes receiver-bound database pause methods with their owner", async () => {
		const dbOps = new ReceiverBoundDbOps();
		const account = makeAccount({
			provider: "codex",
			refresh_token: "rt-revoked",
		});

		await expect(
			pauseAccountForReauthIfInvalidGrant(
				new Error("invalid_grant: refresh token expired"),
				account,
				dbOps,
				"rt-revoked",
			),
		).resolves.toBe(true);
		await expect(
			pauseAccountForUpstreamAuthFailure(account, dbOps, "rt-revoked"),
		).resolves.toBe(true);

		expect(dbOps.calls).toEqual([
			[account.id, "oauth_invalid_grant", "rt-revoked"],
			[account.id, "oauth_invalid_grant", "rt-revoked"],
		]);
	});

	it("maps OAuth upstream 401s to the re-auth pause reason", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "codex",
			refresh_token: "rt-upstream",
		});

		expect(upstreamAuthFailureReason(account)).toBe("oauth_invalid_grant");
		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-upstream",
		);
	});

	it("quarantines API-key upstream 401s without suggesting OAuth re-auth", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "openai-compatible",
			refresh_token: "",
			api_key: "sk-test",
		});

		expect(upstreamAuthFailureReason(account)).toBe("auth_failure");
		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"auth_failure",
			undefined,
		);
	});

	it("treats blank refresh tokens as API-key auth failures", () => {
		expect(
			upstreamAuthFailureReason(makeAccount({ refresh_token: "  " })),
		).toBe("auth_failure");
	});

	it("preserves an explicit null credential snapshot for the quarantine CAS", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "openai-compatible",
			refresh_token: null,
		});

		await pauseAccountForUpstreamAuthFailure(
			account,
			{ pauseAccountIfActive },
			null,
		);

		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"auth_failure",
			null,
		);
	});

	it("preserves the exact nonblank refresh token for the pause CAS guard", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: " rt-with-padding ",
		});

		await expect(
			pauseAccountForUpstreamAuthFailure(account, { pauseAccountIfActive }),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			" rt-with-padding ",
		);
	});

	it("uses the explicit failed credential instead of a newly reauthed token", async () => {
		const pauseAccountIfActive = mock(async () => true);
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "rt-new-after-reauth",
		});

		await expect(
			pauseAccountForUpstreamAuthFailure(
				account,
				{ pauseAccountIfActive },
				"rt-rejected",
			),
		).resolves.toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-rejected",
		);
	});

	it("does not classify a Qwen refresh token as OAuth", () => {
		expect(
			upstreamAuthFailureReason(
				makeAccount({ provider: "qwen", refresh_token: "rt-qwen" }),
			),
		).toBe("auth_failure");
	});

	it("classifies an xAI refresh token as OAuth", () => {
		expect(
			upstreamAuthFailureReason(
				makeAccount({ provider: "xai", refresh_token: "rt-xai" }),
			),
		).toBe("oauth_invalid_grant");
	});

	it("does not reactively refresh accounts that also expose an API key", () => {
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({
					provider: "codex",
					refresh_token: "rt-mixed-credential",
					api_key: "sk-mixed-credential",
				}),
			),
		).toBe(false);
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({
					provider: "codex",
					refresh_token: "rt-oauth-only",
					api_key: null,
				}),
			),
		).toBe(true);
	});

	it("bounds reactive refresh reservations and clears them after reauth", () => {
		clearStaleTokenRefreshState("acc-cooldown");
		expect(tryAcquireStaleTokenRefresh("acc-cooldown", 1_000)).toBe(true);
		expect(tryAcquireStaleTokenRefresh("acc-cooldown", 1_001)).toBe(false);
		expect(isStaleTokenRefreshCoolingDown("acc-cooldown", 1_001)).toBe(true);
		clearStaleTokenRefreshState("acc-cooldown");
		expect(isStaleTokenRefreshCoolingDown("acc-cooldown", 1_001)).toBe(false);
	});

	it("recognizes terminal refresh errors without classifying timeouts as auth", () => {
		expect(
			isTerminalTokenRefreshFailure(new OAuthRefreshTokenError("acc-1")),
		).toBe(true);
		expect(
			isTerminalTokenRefreshFailure(
				new TokenRefreshError("acc-1", new Error("invalid_grant")),
			),
		).toBe(true);
		expect(
			isTerminalTokenRefreshFailure(new Error("fetch failed: ETIMEDOUT")),
		).toBe(false);
	});

	it("recognizes structured OAuth error payloads without object coercion", () => {
		expect(
			isTerminalTokenRefreshFailure({
				error: { code: "invalid_grant", message: "refresh token expired" },
			}),
		).toBe(true);
	});

	it("does not quarantine on an incidental invalid_grant mention in structured prose", () => {
		expect(
			isTerminalTokenRefreshFailure({
				error: { message: "provider mentioned invalid_grant in prose" },
			}),
		).toBe(false);
	});

	it("is safe when a legacy context has no pause operation", async () => {
		const account = makeAccount({ refresh_token: "rt-legacy" });
		await expect(pauseAccountForUpstreamAuthFailure(account, {})).resolves.toBe(
			false,
		);
	});

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

	it("pauses on a structured invalid_grant payload", async () => {
		const dbOps = makeDbOps(true);
		const account = {
			id: "acc-structured",
			name: "test",
			provider: "codex",
			refresh_token: "rt-structured",
		};

		const paused = await pauseAccountForReauthIfInvalidGrant(
			{ error: { code: "invalid_grant", message: "expired" } },
			account,
			dbOps as never,
		);

		expect(paused).toBe(true);
		expect(dbOps.pauseAccountIfActive).toHaveBeenCalledTimes(1);
	});

	it("does not pause on a structured prose-only invalid_grant mention", async () => {
		const dbOps = makeDbOps(true);
		const account = {
			id: "acc-structured-prose",
			name: "test",
			provider: "codex",
			refresh_token: "rt-structured-prose",
		};

		const paused = await pauseAccountForReauthIfInvalidGrant(
			{ error: { message: "provider mentioned invalid_grant in prose" } },
			account,
			dbOps as never,
		);

		expect(paused).toBe(false);
		expect(dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
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
		expect(pauseAccountIfActive.mock.calls[0][2]).toBe("rt-original");

		clearAccountRefreshCache(account.id);
	});

	it("retains terminal classification when the health wrapper hides the provider marker", async () => {
		registerProvider({
			name: "test-reauth-provider-expired",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-expired", "invalid_grant");
			},
		} as never);

		const account = makeAccount({
			id: "acc-expired",
			provider: "test-reauth-provider-expired",
			refresh_token_issued_at: Date.now() - 366 * 24 * 60 * 60 * 1000,
		});
		const { ctx, pauseAccountIfActive } = makeCtx(true);
		let thrown: unknown;
		try {
			await refreshAccessTokenSafe(account, ctx as never);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TokenRefreshError);
		expect(isTerminalTokenRefreshFailure(thrown)).toBe(true);
		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-original",
		);
		clearAccountRefreshCache(account.id);
	});

	it("captures the refresh token before a concurrent reauth mutates the account", async () => {
		const providerName = "test-reauth-token-snapshot-provider";
		registerProvider({
			name: providerName,
			canHandle: () => true,
			refreshToken: async (providerAccount: Account) => {
				expect(providerAccount.refresh_token).toBe("rt-original");
				// Simulate a successful reauth racing the stale refresh failure.
				account.refresh_token = "rt-new-after-reauth";
				throw new OAuthRefreshTokenError(account.id, "revoked");
			},
		} as never);

		const account = makeAccount({ provider: providerName });
		const { ctx, pauseAccountIfActive } = makeCtx(true);
		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toThrow();

		expect(pauseAccountIfActive).toHaveBeenCalledWith(
			account.id,
			"oauth_invalid_grant",
			"rt-original",
		);
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
