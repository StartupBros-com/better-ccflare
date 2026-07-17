import { describe, expect, it } from "bun:test";
import type { TokenRefreshResult } from "@better-ccflare/providers";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import { refreshPollingAccessToken } from "./server";

/**
 * R25 (OAuth control-plane hotfix, U8 pro-gate): refreshPollingAccessToken
 * (formerly refreshTokenWithTemporaryResume) no longer temporarily resumes a
 * paused account before refreshing its token, nor restores the pause
 * afterward -- see the JSDoc above the function in server.ts for the full
 * investigation (neither getValidAccessToken nor anything it calls ever
 * reads or gates on `paused`, and auto-refresh-scheduler.ts's proactive
 * Codex/OpenAI-compatible refreshers already refresh tokens on paused rows
 * directly with no resume/restore dance).
 *
 * These tests prove the resulting invariant: refreshPollingAccessToken never
 * reads or writes `paused`/`pause_reason` at all, regardless of what
 * getValidAccessToken does internally -- including rotating the refresh
 * token, which is exactly what defeated the old restore's refresh-token
 * equality guard (a manually- or overage-paused account was left wrongly
 * active after any refresh that happened to rotate the token, not just a
 * concurrent-reauth clobber). dbOps.resumeAccount / pauseAccountIfActive /
 * pauseAccount are spied to throw if ever called, so a regression that
 * reintroduces any form of the resume/restore dance fails loudly instead of
 * passing by coincidence.
 *
 * The "untouched" tests use a fixture account with a valid, far-future-
 * expiring access token so getValidAccessToken's fast path
 * (packages/proxy/src/handlers/token-manager.ts) returns immediately
 * without touching the network. The rotation test needs the slow (refresh)
 * path, so it uses an expired access token and an unregistered provider
 * name so packages/providers' getProvider() returns undefined and the real
 * refreshAccessTokenSafe falls back to the stubbed proxyContext.provider
 * instead of a real OAuth provider -- no network involved.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-poller",
		name: "acct-poller",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-fixture",
		access_token: "at-fixture-valid",
		expires_at: Date.now() + 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null as RateLimitReason | null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: true,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: "oauth_invalid_grant",
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

/**
 * Spies for the three DB mutators the old temporary-resume/restore dance
 * used to call. Throwing (rather than silently no-oping) makes any
 * regression that reintroduces resume/restore behavior fail the test
 * immediately and loudly instead of passing by coincidence.
 */
function makeNeverCalledPauseSpies() {
	return {
		resumeAccount: async (_id: string) => {
			throw new Error(
				"resumeAccount must never be called by refreshPollingAccessToken",
			);
		},
		pauseAccountIfActive: async (
			_id: string,
			_reason: string,
			_expectedRefreshToken?: string | null,
		) => {
			throw new Error(
				"pauseAccountIfActive must never be called by refreshPollingAccessToken",
			);
		},
		pauseAccount: async (_id: string, _reason?: string) => {
			throw new Error(
				"pauseAccount must never be called by refreshPollingAccessToken",
			);
		},
	};
}

describe("refreshPollingAccessToken (R25: no temporary resume/restore)", () => {
	it("leaves a terminally-paused account's pause state completely untouched (fast path, no refresh needed)", async () => {
		const account = makeAccount({
			paused: true,
			pause_reason: "oauth_invalid_grant",
		});
		const calls: string[] = [];
		const dbOps = {
			getAccount: async (_id: string) => {
				calls.push("getAccount");
				return account;
			},
			...makeNeverCalledPauseSpies(),
		};
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshPollingAccessToken>[1];

		const token = await refreshPollingAccessToken(account, proxyContext);

		expect(token).toBe("at-fixture-valid");
		expect(calls).toEqual(["getAccount"]);
		expect(account.paused).toBe(true);
		expect(account.pause_reason).toBe("oauth_invalid_grant");
	});

	it("leaves an active (non-paused) account's state untouched and refreshes normally", async () => {
		const account = makeAccount({ paused: false, pause_reason: null });
		const calls: string[] = [];
		const dbOps = {
			getAccount: async (_id: string) => {
				calls.push("getAccount");
				return account;
			},
			...makeNeverCalledPauseSpies(),
		};
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshPollingAccessToken>[1];

		const token = await refreshPollingAccessToken(account, proxyContext);

		expect(token).toBe("at-fixture-valid");
		expect(calls).toEqual(["getAccount"]);
		expect(account.paused).toBe(false);
	});
});

/**
 * The rotation bug this fix eliminates: getValidAccessToken can legitimately
 * ROTATE the refresh token as part of a normal, successful refresh (some
 * providers rotate on every refresh). The now-deleted restore guard compared
 * the account's post-refresh refresh_token against the value captured before
 * the temporary resume, and skipped restoring the pause on any mismatch --
 * including this entirely benign rotation, not just a concurrent-reauth
 * clobber. That left a manually-paused account wrongly active forever. A red
 * run of this exact scenario against the pre-fix refreshTokenWithTemporaryResume
 * (recorded before this fix landed) confirmed the bug: calls sequenced as
 * getAccount -> resumeAccount -> provider.refreshToken -> updateAccountTokens
 * -> pauseAccountIfActive("manual", "rt-old"), with the guard checked against
 * the now-stale "rt-old" while the DB row's refresh_token had already
 * rotated to "rt-rotated", so pauseAccountIfActive returned false and the
 * account was left paused:false.
 *
 * This models the full round trip through the REAL getValidAccessToken /
 * refreshAccessTokenSafe (packages/proxy/src/handlers/token-manager.ts) via
 * a fake, unregistered provider name so packages/providers' getProvider()
 * returns undefined and refreshAccessTokenSafe falls back to
 * proxyContext.provider -- a fully stubbed provider whose refreshToken
 * resolves immediately with a rotated refresh token, no network involved.
 * proxyContext.asyncWriter.enqueue runs its job synchronously so the token
 * persistence (dbOps.updateAccountTokens) that would normally happen via the
 * async writer lands deterministically, modeling the worst-case timing the
 * bug depended on.
 */
function makeRotationProxyContext(state: {
	paused: boolean;
	pause_reason: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
}) {
	const calls: string[] = [];

	const dbOps = {
		getAccount: async (_id: string) => {
			calls.push("getAccount");
			return { ...state } as unknown as Account;
		},
		updateAccountTokens: async (
			_id: string,
			accessToken: string,
			expiresAt: number,
			refreshToken?: string,
		) => {
			calls.push("updateAccountTokens");
			state.access_token = accessToken;
			state.expires_at = expiresAt;
			if (refreshToken) state.refresh_token = refreshToken;
		},
		...makeNeverCalledPauseSpies(),
	};

	const provider = {
		name: "fixture-rotating-provider",
		refreshToken: async (): Promise<TokenRefreshResult> => {
			calls.push("provider.refreshToken");
			return {
				accessToken: "at-rotated",
				expiresAt: Date.now() + 60 * 60 * 1000,
				refreshToken: "rt-rotated",
			};
		},
	};

	const proxyContext = {
		dbOps,
		provider,
		runtime: { clientId: "test-client" },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {
			enqueue: (job: () => unknown) => {
				job();
				return true;
			},
		},
	} as unknown as Parameters<typeof refreshPollingAccessToken>[1];

	return { proxyContext, calls, state };
}

describe("refreshPollingAccessToken (R25: rotation no longer defeats the pause)", () => {
	it("leaves a manually-paused account paused even when the refresh rotates the refresh token", async () => {
		const account = makeAccount({
			paused: true,
			pause_reason: "manual",
			refresh_token: "rt-old",
			access_token: null,
			expires_at: null,
			// Unregistered provider name so packages/providers' getProvider()
			// returns undefined and the real refreshAccessTokenSafe falls back to
			// proxyContext.provider (our stub) instead of a real OAuth provider.
			provider: "fixture-rotating-provider",
		});
		const { proxyContext, calls, state } = makeRotationProxyContext({
			paused: true,
			pause_reason: "manual",
			refresh_token: "rt-old",
			access_token: null,
			expires_at: null,
		});

		const token = await refreshPollingAccessToken(account, proxyContext);

		expect(token).toBe("at-rotated");
		// The refresh really did rotate the token -- this is not a no-op fixture.
		expect(state.refresh_token).toBe("rt-rotated");
		// The pause must survive the refresh untouched: refreshPollingAccessToken
		// never reads or writes `paused`/`pause_reason`, so there is nothing left
		// for the rotation to defeat.
		expect(state.paused).toBe(true);
		expect(state.pause_reason).toBe("manual");
		expect(calls).toEqual([
			"getAccount",
			"provider.refreshToken",
			"updateAccountTokens",
		]);
	});
});
