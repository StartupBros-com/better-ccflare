import { afterEach, describe, expect, it, mock } from "bun:test";
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
		markRateLimited: [] as Array<{ until: number; reason: string }>,
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
			) => {
				calls.markRateLimited.push({ until, reason });
				return 9;
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
