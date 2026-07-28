import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	computeOverloadCooldownMs,
	computeOverloadWithResetCapMs,
	computeRateLimitBackoffMs,
	getRateLimitMaxCooldownMs,
	getRateLimitResetStabilityMs,
	resolveCooldownUntil,
	TIME_CONSTANTS,
} from "@better-ccflare/core";

describe("resolveCooldownUntil", () => {
	const now = 1_700_000_000_000; // fixed reference time
	const maxCooldownMs = 12 * 60 * 60 * 1000; // 12h

	it("returns now + backoffMs when no resetTime is provided", () => {
		const backoffMs = 30 * 1000;
		expect(resolveCooldownUntil({ now, backoffMs, maxCooldownMs })).toBe(
			now + backoffMs,
		);
	});

	it("honors a resetTime sooner than the backoff instead of flooring it up (probe single-flight already guards short cooldowns)", () => {
		const backoffMs = 30 * 1000; // 30s
		const resetTime = now + 10 * 1000; // 10s out (sooner than backoff)
		expect(
			resolveCooldownUntil({ now, backoffMs, maxCooldownMs, resetTime }),
		).toBe(resetTime);
	});

	it("honors resetTime when it sits between backoff and max ceiling", () => {
		const backoffMs = 30 * 1000; // 30s
		const resetTime = now + 30 * 60 * 1000; // 30min out
		expect(
			resolveCooldownUntil({ now, backoffMs, maxCooldownMs, resetTime }),
		).toBe(resetTime);
	});

	it("caps at now + maxCooldownMs when resetTime is beyond max", () => {
		const backoffMs = 30 * 1000; // 30s
		const resetTime = now + 2.5 * 24 * 60 * 60 * 1000; // 2.5 days out
		expect(
			resolveCooldownUntil({ now, backoffMs, maxCooldownMs, resetTime }),
		).toBe(now + maxCooldownMs);
	});
});

describe("getRateLimitMaxCooldownMs", () => {
	const original = process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS;
		} else {
			process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS = original;
		}
	});

	it("defaults to TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS when env is unset", () => {
		delete process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS;
		expect(getRateLimitMaxCooldownMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});

	it("respects a valid numeric env override", () => {
		process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS = String(60 * 60 * 1000);
		expect(getRateLimitMaxCooldownMs()).toBe(60 * 60 * 1000);
	});

	it("falls back to the default on empty env", () => {
		process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS = "";
		expect(getRateLimitMaxCooldownMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});

	it("falls back to the default on non-numeric (garbage) env", () => {
		process.env.CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS = "not-a-number";
		expect(getRateLimitMaxCooldownMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_MAX_COOLDOWN_MS,
		);
	});
});

const ENV_KEYS = [
	"CCFLARE_OVERLOAD_COOLDOWN_MS",
	"CCFLARE_OVERLOAD_WITH_RESET_MAX_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS",
	"CCFLARE_RATE_LIMIT_RESET_STABILITY_MS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("duration env overrides", () => {
	it("honors a valid positive override", () => {
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "2500";
		process.env.CCFLARE_OVERLOAD_WITH_RESET_MAX_MS = "90000";
		process.env.CCFLARE_RATE_LIMIT_RESET_STABILITY_MS = "1234";
		expect(computeOverloadCooldownMs()).toBe(2500);
		expect(computeOverloadWithResetCapMs()).toBe(90000);
		expect(getRateLimitResetStabilityMs()).toBe(1234);
	});

	it("falls back to the default when the variable is unset or unparseable", () => {
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "not-a-number";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "0";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
	});

	// A negative duration is not a shorter cooldown — it lands in the past, so
	// every cooldown written from it is already expired on arrival, silently
	// disabling the mechanism instead of tuning it.
	it("rejects negative durations", () => {
		for (const key of ENV_KEYS) process.env[key] = "-5000";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		expect(computeOverloadWithResetCapMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS,
		);
		expect(getRateLimitResetStabilityMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
		);
		expect(computeRateLimitBackoffMs(1)).toBeGreaterThan(0);
	});

	// Infinity benches the account forever and makes the audit logging throw:
	// applyRateLimitCooldown formats the resulting timestamp with
	// `new Date(cooldownUntil).toISOString()`, which raises RangeError.
	it("rejects non-finite durations", () => {
		for (const key of ENV_KEYS) process.env[key] = "Infinity";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		expect(computeOverloadWithResetCapMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS,
		);
		expect(getRateLimitResetStabilityMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
		);
		expect(Number.isFinite(computeRateLimitBackoffMs(1))).toBe(true);
	});

	// The with-reset cap is the only clamp between a 529 carrying an
	// anthropic-ratelimit-unified-reset header (hours away) and an
	// hours-long bench. A non-finite cap disables `min(resetTime, cap)`
	// entirely, so it must never be reachable through configuration.
	it("keeps the with-reset cap finite so min(resetTime, cap) still clamps", () => {
		process.env.CCFLARE_OVERLOAD_WITH_RESET_MAX_MS = "Infinity";
		const now = 1_700_000_000_000;
		const threeHoursOut = now + 3 * 60 * 60 * 1000;
		const capUntil = now + computeOverloadWithResetCapMs();
		expect(Math.min(threeHoursOut, capUntil)).toBe(capUntil);
		expect(capUntil).toBeLessThan(threeHoursOut);
	});
});
