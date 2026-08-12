import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	computeRateLimitBackoffMs,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { applyRateLimitCooldown } from "../rate-limit-cooldown";

const NOW = Date.UTC(2026, 7, 11, 23, 0, 0);
const realDateNow = Date.now;

// Anthropic's per-model weekly caps reset days out. The 2026-08-11 incident
// applied exactly this value as an ACCOUNT-wide hold duration.
const FAR_FUTURE_RESET = NOW + 3 * 24 * 60 * 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "max-quinary-wmrdgm",
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

function makeCtx() {
	const calls = {
		markRateLimited: [] as Array<{ until: number; reason: string }>,
	};
	const ctx = {
		provider: { name: "anthropic", isStreamingResponse: () => false },
		dbOps: {
			markAccountRateLimited: async (
				_accountId: string,
				until: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ until, reason });
				return { consecutiveRateLimits: 1, applied: true };
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
});

describe("cooldown duration is derived from scope-matched evidence", () => {
	// 2026-08-11 #157. A restart wipes the in-memory usage cache. With no
	// snapshot the classifier cannot confirm which window rejected the request,
	// so it correctly reads the 429 as account-wide — but the reset header it
	// then honours describes the per-model Fable window, days out, which the
	// ceiling clamps to a 12h ACCOUNT bench. Three healthy accounts left the
	// pool 19 seconds after a deploy and ~60 requests 503'd.
	//
	// An unattributed reset must not outlive a probe: we do not know which
	// window it describes, so it cannot justify a long hold.
	it("ignores a far-future reset that is not attributed to this hold's scope", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx } = makeCtx();

		applyRateLimitCooldown(
			account,
			{
				resetTime: FAR_FUTURE_RESET,
				reason: "model_fallback_429",
				resetTimeScope: "unattributed",
			},
			ctx,
		);

		expect(account.rate_limited_until).toBe(NOW + computeRateLimitBackoffMs(1));
		// The whole point: nowhere near the 12h ceiling.
		expect(account.rate_limited_until).toBeLessThan(
			NOW + TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});

	it("honours a far-future reset once the scope is confirmed, bounded by the ceiling", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx } = makeCtx();

		applyRateLimitCooldown(
			account,
			{
				resetTime: FAR_FUTURE_RESET,
				reason: "model_fallback_429",
				resetTimeScope: "confirmed",
			},
			ctx,
		);

		expect(account.rate_limited_until).toBe(
			NOW + TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});

	// Every existing caller omits the field; none of their behaviour may move.
	it("treats an omitted scope as confirmed so existing callers are unchanged", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx } = makeCtx();

		applyRateLimitCooldown(
			account,
			{ resetTime: FAR_FUTURE_RESET, reason: "model_fallback_429" },
			ctx,
		);

		expect(account.rate_limited_until).toBe(
			NOW + TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});

	it("persists the shortened cooldown, not just the in-memory value", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx, calls } = makeCtx();

		applyRateLimitCooldown(
			account,
			{
				resetTime: FAR_FUTURE_RESET,
				reason: "model_fallback_429",
				resetTimeScope: "unattributed",
			},
			ctx,
		);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.until).toBe(
			NOW + computeRateLimitBackoffMs(1),
		);
	});

	// A 529 carries its own capped duration and never consults resolveCooldownUntil,
	// so the new field must not perturb the overload path.
	it("leaves the overload path untouched", () => {
		Date.now = () => NOW;
		const account = makeAccount();
		const { ctx } = makeCtx();

		applyRateLimitCooldown(
			account,
			{
				reason: "upstream_529_overloaded_no_reset",
				resetTimeScope: "unattributed",
			},
			ctx,
		);

		// Short, fixed overload cooldown — unrelated to the backoff ramp.
		expect(account.rate_limited_until).toBeGreaterThan(NOW);
		expect(account.rate_limited_until).toBeLessThan(NOW + 60 * 60 * 1000);
	});
});
