import { afterEach, describe, expect, it } from "bun:test";
import {
	getRateLimitMaxCooldownMs,
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

	it("floors to backoff when resetTime is smaller than backoff", () => {
		const backoffMs = 30 * 1000; // 30s
		const resetTime = now + 10 * 1000; // 10s out (sooner than backoff)
		expect(
			resolveCooldownUntil({ now, backoffMs, maxCooldownMs, resetTime }),
		).toBe(now + backoffMs);
	});

	it("honors resetTime when it sits between backoff floor and max ceiling", () => {
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
