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
 * Records call order and timing so the test can prove pauseAccount is
 * genuinely awaited (not fire-and-forget) before the function's returned
 * promise settles: pauseAccount is given an artificial delay, and the test
 * asserts the "restore" call is observed complete before the outer await
 * resolves.
 */
function makeDbOpsStub(currentAccount: Account) {
	const calls: string[] = [];
	let pauseAccountResolved = false;

	const dbOps = {
		getAccount: async (_id: string) => {
			calls.push("getAccount");
			return currentAccount;
		},
		resumeAccount: async (_id: string) => {
			calls.push("resumeAccount");
			return { resumed: true, pauseReason: null };
		},
		pauseAccount: async (_id: string, reason?: string) => {
			calls.push(`pauseAccount:${reason}`);
			// Artificial delay to prove the caller genuinely awaits this before
			// returning, not just fires-and-forgets it.
			await new Promise((resolve) => setTimeout(resolve, 20));
			pauseAccountResolved = true;
		},
	};

	return {
		dbOps,
		calls,
		isPauseAccountResolved: () => pauseAccountResolved,
	};
}

describe("refreshTokenWithTemporaryResume (R24 poller reason preservation)", () => {
	it("restores the account's original terminal pause_reason instead of defaulting to manual", async () => {
		const account = makeAccount({ paused: true });
		const currentAccount = makeAccount({
			paused: true,
			pause_reason: "oauth_invalid_grant",
		});
		const { dbOps, calls, isPauseAccountResolved } =
			makeDbOpsStub(currentAccount);
		const proxyContext = {
			dbOps,
		} as unknown as Parameters<typeof refreshTokenWithTemporaryResume>[1];

		const token = await refreshTokenWithTemporaryResume(account, proxyContext);

		expect(token).toBe("at-fixture-valid");
		// The restore (pauseAccount) call must have been awaited to completion
		// before refreshTokenWithTemporaryResume's own promise resolved.
		expect(isPauseAccountResolved()).toBe(true);
		// The re-pause must preserve the ORIGINAL reason, never default to "manual".
		expect(calls).toEqual([
			"getAccount",
			"resumeAccount",
			"pauseAccount:oauth_invalid_grant",
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
			"pauseAccount:manual",
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
			"pauseAccount:manual",
		]);
	});
});
