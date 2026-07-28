import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	computeRateLimitBackoffMs,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const NOW = Date.UTC(2026, 6, 9, 3, 0, 0);
const realDateNow = Date.now;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "mature-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeCtx(opts: { rateLimited: boolean; resetTime?: number }) {
	const calls = {
		markRateLimited: [] as Array<{
			until: number;
			reason: string;
			incrementStreak?: boolean;
		}>,
	};
	const ctx = {
		provider: {
			name: "anthropic",
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		},
		dbOps: {
			markAccountRateLimited: async (
				_accountId: string,
				until: number,
				reason: string,
				incrementStreak?: boolean,
			) => {
				calls.markRateLimited.push({ until, reason, incrementStreak });
				return { consecutiveRateLimits: 9, applied: true };
			},
			updateAccountUsage: mock(() => {}),
			updateAccountRateLimitMeta: mock(() => {}),
			getAdapter: () => ({ run: async () => {} }),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => void job(),
		},
	} as unknown as ProxyContext;
	return { ctx, calls };
}

afterEach(() => {
	Date.now = realDateNow;
	resetRateLimitProbeGatesForTests();
});

describe("mature cooldown re-entry characterization", () => {
	it("treats the exact cooldown boundary as expired", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("single-flights an expired cooldown with a high persisted streak", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		expect(getRateLimitProbeAdmission(account)).toBe("suppressed");
	});

	it("preserves a two-minute upstream reset hint instead of imposing a five-minute floor", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 9 });
		const { ctx, calls } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(account, { resetTime: NOW + 120_000 }, ctx);

		expect(account.rate_limited_until).toBe(NOW + 120_000);
		expect(calls.markRateLimited[0]?.until).toBe(NOW + 120_000);
	});

	it("honors a mature far-future upstream reset instead of the short exponential backoff", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 9 });
		const { ctx, calls } = makeCtx({ rateLimited: true });
		const farFutureReset = NOW + 5 * 60 * 60 * 1000; // 5h window reset

		applyRateLimitCooldown(account, { resetTime: farFutureReset }, ctx);

		// Honored as-is: well inside the 12h safety ceiling and past the ~5min backoff floor.
		expect(account.rate_limited_until).toBe(farFutureReset);
		expect(calls.markRateLimited[0]?.until).toBe(farFutureReset);

		// A stale/oversized reset hint is still bounded by the safety ceiling.
		const beyondCeiling = NOW + 3 * 24 * 60 * 60 * 1000; // 3 days out
		const account2 = makeAccount({ consecutive_rate_limits: 9 });
		const { ctx: ctx2 } = makeCtx({ rateLimited: true });
		applyRateLimitCooldown(account2, { resetTime: beyondCeiling }, ctx2);
		expect(account2.rate_limited_until).toBe(NOW + 12 * 60 * 60 * 1000);
	});

	it("does not gate multiple ordinary requests selected before their first 429 completes", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 0 });

		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("releases the probe after cooldown expiry is followed by another 429", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx({ rateLimited: true });

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		applyRateLimitCooldown(account, { resetTime: NOW + 120_000 }, ctx);
		Date.now = () => NOW + 120_001;

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("releases an abandoned probe immediately", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		completeRateLimitProbe(account, "abandoned");
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("self-heals an abandoned probe after its bounded lease", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		Date.now = () => NOW + 120_001;
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});
});

describe("mature cooldown re-entry — overload-reason gate (frozen 429 streak)", () => {
	it("gates the single-flight probe for a reset-less 529 even with a cold 429 streak (overload reason alone must arm the gate)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 0,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		// A second concurrent request selecting the same account is suppressed,
		// same as the mature-streak case above — an all-529 account never
		// reaches MATURE_COOLDOWN_STREAK because the streak is frozen for
		// overloads, so the reason alone must be able to arm the gate.
		expect(getRateLimitProbeAdmission(account)).toBe("suppressed");
	});
});

describe("529 overload cooldown separation", () => {
	it("applies the fixed overload cooldown for a reset-less 529, ignoring the 429 streak depth", () => {
		Date.now = () => NOW;
		// A mature 429 streak would normally ramp the exponential backoff to
		// minutes; a 529 overload must ignore that ramp entirely.
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		expect(account.rate_limited_until).toBe(
			NOW + TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
	});

	it("does not increment consecutive_rate_limits after a 529 overload, in-memory or via the DB call", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		expect(account.consecutive_rate_limits).toBe(8);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(false);
	});

	it("caps a 529-with-reset at the overload-scale ceiling, not the frozen streak's exponential ramp, while still suppressing the streak (delta2-5)", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });
		// Chosen so the two candidate formulas diverge: the overload cap (60s,
		// computeOverloadWithResetCapMs) sits well below this reset, while the
		// streak's exponential ramp (computeRateLimitBackoffMs(9), capped at
		// 5min) sits well above it. A regression back to deriving duration from
		// the streak — the formula this test used to pin — would silently pass
		// with a resetTime of exactly 60s (both formulas agree there); this
		// value makes the two diverge so the test can actually catch that
		// revert.
		const resetTime = NOW + 120_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_529_overloaded_with_reset" },
			ctx,
		);

		// Duration formula is min(resetTime, now + computeOverloadWithResetCapMs())
		// (see rate-limit-cooldown.ts) — NOT the frozen 429 streak's exponential
		// ramp, even though this account's streak sits at 8. A streak-derived
		// formula would have produced NOW + 120_000 (the uncapped resetTime)
		// here instead.
		expect(account.rate_limited_until).toBe(NOW + 60_000);
		// The streak itself stays untouched — a 529 is not a quota signal, even
		// when it does carry a reset.
		expect(account.consecutive_rate_limits).toBe(8);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(false);
	});

	it("keeps the exponential 429 ramp and reset-time cap unchanged (regression)", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });
		// Shorter than the 8th-streak backoff ceiling, so it drives the cap.
		const resetTime = NOW + 10_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_429_no_reset_probe_cooldown" },
			ctx,
		);

		expect(account.consecutive_rate_limits).toBe(9);
		expect(account.rate_limited_until).toBe(
			Math.min(resetTime, NOW + computeRateLimitBackoffMs(9)),
		);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(true);
	});

	it("honors a full retry-after on a 529-with-reset even with a cold streak (regression: duration must not derive from the frozen 429 streak)", () => {
		Date.now = () => NOW;
		// consecutive_rate_limits stays 0 for an all-529 account (the streak is
		// frozen for overloads) — deriving duration from computeRateLimitBackoffMs
		// via that frozen counter would give a flat 30s regardless of what
		// Anthropic's own retry-after says.
		const account = makeAccount({ consecutive_rate_limits: 0 });
		const { ctx } = makeCtx({ rateLimited: true });
		const resetTime = NOW + 60_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_529_overloaded_with_reset" },
			ctx,
		);

		expect(account.rate_limited_until).toBe(NOW + 60_000);
	});

	it("caps a 529-with-reset duration at OVERLOAD_WITH_RESET_MAX_MS when the upstream reset is far in the future", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 0 });
		const { ctx } = makeCtx({ rateLimited: true });
		// anthropic-ratelimit-unified-reset can carry a quota-window reset that's
		// hours away (provider.ts:368-380) rather than a real short retry-after —
		// far beyond the 60s overload-scale cap.
		const resetTime = NOW + 10 * 60_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_529_overloaded_with_reset" },
			ctx,
		);

		// Pin the literal value, not TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS
		// itself — a quota-window reset carries no information about how long
		// the overload lasts, so the cap must be overload-scale (60s), not the
		// 429 ramp ceiling (5min) a prior revision used here.
		expect(account.rate_limited_until).toBe(NOW + 60_000);
	});

	it("does not shorten an active 429 quota bench when a 529 overload arrives mid-window (forward guard)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 8,
			rate_limited_until: NOW + 300_000,
			rate_limited_at: NOW - 1_000,
		});
		const { ctx, calls } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		// The longer, already-active 429 bench carries more information than a
		// transient overload does — the 529 must not shorten it.
		expect(account.rate_limited_until).toBe(NOW + 300_000);
		// rate_limited_at is deliberately not re-stamped: doing so would delay
		// the stability healing in response-processor.ts on every subsequent 529.
		expect(account.rate_limited_at).toBe(NOW - 1_000);
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("updates rate_limited_reason in-memory (not only in the DB) on every cooldown apply", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 0 });
		const { ctx } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		expect(account.rate_limited_reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
	});
});
