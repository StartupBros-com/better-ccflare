import { describe, expect, it } from "bun:test";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import { refreshTokenWithTemporaryResume } from "./server";

/**
 * R24 (OAuth control-plane hotfix, U8): the usage poller's temporary
 * resume/re-pause must preserve the account's original pause_reason instead
 * of defaulting the re-pause to "manual" (which silently overwrote a
 * terminal oauth_invalid_grant pause every polling cycle), and it must
 * genuinely await both the resume and the restore so a generic resume
 * cannot race with or clobber the terminal reason.
 *
 * The fixture account carries a valid, far-future-expiring access token so
 * getValidAccessToken's fast path (packages/proxy/src/handlers/token-manager.ts)
 * returns immediately without touching the DB or network at all -- this lets
 * the test use the real getValidAccessToken with no mock.module needed.
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
 * Records call order and timing so the test can prove the restore is
 * genuinely awaited (not fire-and-forget) before the function's returned
 * promise settles: pauseAccountIfActive is given an artificial delay, and
 * the test asserts the "restore" call is observed complete before the outer
 * await resolves. pauseAccountIfActive always succeeds here (no
 * expectedRefreshToken mismatch simulated) since these tests cover the
 * non-race preservation behavior; the race itself is covered separately
 * below by makeRaceDbOpsStub.
 */
function makeDbOpsStub(currentAccount: Account) {
	const calls: string[] = [];
	let pauseAccountIfActiveResolved = false;

	const dbOps = {
		getAccount: async (_id: string) => {
			calls.push("getAccount");
			return currentAccount;
		},
		resumeAccount: async (_id: string) => {
			calls.push("resumeAccount");
			return { resumed: true, pauseReason: null };
		},
		pauseAccountIfActive: async (
			_id: string,
			reason: string,
			_expectedRefreshToken?: string | null,
		) => {
			calls.push(`pauseAccountIfActive:${reason}`);
			// Artificial delay to prove the caller genuinely awaits this before
			// returning, not just fires-and-forgets it.
			await new Promise((resolve) => setTimeout(resolve, 20));
			pauseAccountIfActiveResolved = true;
			return true;
		},
	};

	return {
		dbOps,
		calls,
		isPauseAccountIfActiveResolved: () => pauseAccountIfActiveResolved,
	};
}

describe("refreshTokenWithTemporaryResume (R24 poller reason preservation)", () => {
	it("restores the account's original terminal pause_reason instead of defaulting to manual", async () => {
		const account = makeAccount({ paused: true });
		const currentAccount = makeAccount({
			paused: true,
			pause_reason: "oauth_invalid_grant",
		});
		const { dbOps, calls, isPauseAccountIfActiveResolved } =
			makeDbOpsStub(currentAccount);
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		const token = await refreshTokenWithTemporaryResume(account, proxyContext);

		expect(token).toBe("at-fixture-valid");
		// The restore (pauseAccountIfActive) call must have been awaited to
		// completion before refreshTokenWithTemporaryResume's own promise resolved.
		expect(isPauseAccountIfActiveResolved()).toBe(true);
		// The re-pause must preserve the ORIGINAL reason, never default to "manual".
		expect(calls).toEqual([
			"getAccount",
			"resumeAccount",
			"pauseAccountIfActive:oauth_invalid_grant",
		]);
		// In-memory account state must be restored to paused afterward.
		expect(account.paused).toBe(true);
	});

	it("preserves a manual pause reason unchanged (non-terminal reasons are unaffected)", async () => {
		const account = makeAccount({ paused: true });
		const currentAccount = makeAccount({
			paused: true,
			pause_reason: "manual",
		});
		const { dbOps, calls } = makeDbOpsStub(currentAccount);
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		await refreshTokenWithTemporaryResume(account, proxyContext);

		expect(calls).toEqual([
			"getAccount",
			"resumeAccount",
			"pauseAccountIfActive:manual",
		]);
	});

	it("does not temporarily resume or re-pause an account that isn't currently paused", async () => {
		const account = makeAccount({ paused: false });
		const currentAccount = makeAccount({
			paused: false,
			pause_reason: null,
		});
		const { dbOps, calls } = makeDbOpsStub(currentAccount);
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		await refreshTokenWithTemporaryResume(account, proxyContext);

		expect(calls).toEqual(["getAccount"]);
		expect(account.paused).toBe(false);
	});

	it("falls back to manual when the original pause_reason is null on a paused row (legacy data)", async () => {
		const account = makeAccount({ paused: true });
		const currentAccount = makeAccount({
			paused: true,
			pause_reason: null,
		});
		const { dbOps, calls } = makeDbOpsStub(currentAccount);
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		await refreshTokenWithTemporaryResume(account, proxyContext);

		expect(calls).toEqual([
			"getAccount",
			"resumeAccount",
			"pauseAccountIfActive:manual",
		]);
	});
});

/**
 * P1 review fix: a successful concurrent reauthentication (fresh tokens
 * stored, oauth_invalid_grant cleared, account genuinely resumed via
 * resumeAccountIfNeedsReauth from the http-api oauth callback) can complete
 * during the poller's temporary-resume window. Before this fix, the
 * finally-block restore called dbOps.pauseAccount(id, originalPauseReason)
 * unconditionally, with no guard at all, so it clobbered the fresh reauth
 * straight back to paused/oauth_invalid_grant even though valid tokens were
 * now stored. Since oauth_invalid_grant is excluded from auto-unpause, the
 * account would then be stuck paused forever under a stale terminal
 * classification.
 *
 * The stub below models the DB row as mutable state so the "concurrent
 * reauth" can be injected as a side effect that lands inside the temporary-
 * resume window (right after our own resumeAccount call, before
 * getValidAccessToken/the finally-block restore run), and implements
 * pauseAccountIfActive with the same COALESCE(paused,0)=0 AND
 * refresh_token=? guard semantics as the real
 * AccountRepository.pauseIfActive, so the fix under test can be exercised
 * against faithful guard behavior.
 */
function makeRaceDbOpsStub(initial: {
	paused: boolean;
	pause_reason: string | null;
	refresh_token: string;
}) {
	const state = { ...initial };
	const calls: string[] = [];

	const dbOps = {
		getAccount: async (_id: string) => {
			calls.push("getAccount");
			return {
				paused: state.paused,
				pause_reason: state.pause_reason,
				refresh_token: state.refresh_token,
				access_token: "at-fixture-valid",
				expires_at: Date.now() + 60 * 60 * 1000,
			} as unknown as Account;
		},
		resumeAccount: async (_id: string) => {
			calls.push("resumeAccount");
			// Our own attempt to temporarily resume an oauth_invalid_grant-paused
			// account is refused by the R23 guard (resumeUnlessPausedForReason) --
			// it never actually flips the row. Meanwhile, independently and
			// concurrently, a real reauthentication completes: fresh tokens are
			// stored and the account is genuinely resumed via
			// resumeAccountIfNeedsReauth. This models that landing inside the
			// temporary-resume window, before our restore runs.
			state.paused = false;
			state.pause_reason = null;
			state.refresh_token = "rt-new-after-reauth";
			return { resumed: false, pauseReason: "oauth_invalid_grant" };
		},
		pauseAccount: async (_id: string, reason?: string) => {
			calls.push(`pauseAccount:${reason}`);
			// OLD (buggy) unconditional restore.
			state.paused = true;
			state.pause_reason = reason ?? "manual";
		},
		pauseAccountIfActive: async (
			_id: string,
			reason: string,
			expectedRefreshToken?: string | null,
		) => {
			calls.push(`pauseAccountIfActive:${reason}:${expectedRefreshToken}`);
			if (state.paused) return false;
			if (
				expectedRefreshToken != null &&
				state.refresh_token !== expectedRefreshToken
			) {
				return false;
			}
			state.paused = true;
			state.pause_reason = reason;
			return true;
		},
	};

	return { dbOps, calls, state };
}

describe("refreshTokenWithTemporaryResume (P1 review: concurrent reauth must not be clobbered)", () => {
	it("does not clobber a successful concurrent reauthentication that lands during the temporary-resume window", async () => {
		const account = makeAccount({
			paused: true,
			pause_reason: "oauth_invalid_grant",
			refresh_token: "rt-old",
		});
		const { dbOps, state } = makeRaceDbOpsStub({
			paused: true,
			pause_reason: "oauth_invalid_grant",
			refresh_token: "rt-old",
		});
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		await refreshTokenWithTemporaryResume(account, proxyContext);

		// A genuine, freshly-reauthenticated account must remain resumed: the
		// restore must never clobber it back to paused/oauth_invalid_grant just
		// because we captured the original (now stale) pause reason before the
		// concurrent reauth landed.
		expect(state.paused).toBe(false);
		expect(state.pause_reason).toBeNull();
		expect(state.refresh_token).toBe("rt-new-after-reauth");
	});
});
