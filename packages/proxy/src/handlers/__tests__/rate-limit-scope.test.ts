import { describe, expect, it } from "bun:test";
import {
	MODEL_SCOPED_DEPLETION_TTL_MS,
	type UsageSnapshot,
} from "@better-ccflare/providers";
import {
	classifyPreByte429,
	getAnthropicRateLimitResetAt,
	getRequestRateLimitOutcomes,
	hasHardAnthropicAccountSignal,
	recordRequestRateLimitOutcome,
} from "../rate-limit-scope";

const NOW = 1_800_000_000_000;

function snapshot(
	observedAt: number,
	overrides: {
		session?: number;
		weeklyAll?: number;
		family?: string;
		scoped?: number;
		scopedReset?: number | null;
	} = {},
): UsageSnapshot {
	const {
		session = 0,
		weeklyAll = 72,
		family = "Fable",
		scoped = 100,
		scopedReset = NOW + 60 * 60 * 1000,
	} = overrides;
	return {
		observedAt,
		data: {
			limits: [
				{
					kind: "session",
					percent: session,
					resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_all",
					percent: weeklyAll,
					resets_at: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent: scoped,
					resets_at:
						scopedReset === null ? null : new Date(scopedReset).toISOString(),
					scope: { model: { id: null, display_name: family } },
					is_active: true,
				},
			],
		},
	};
}

function response(headers: HeadersInit = {}): Response {
	return new Response(null, { status: 429, headers });
}

describe("classifyPreByte429", () => {
	it("classifies the incident fixture as Fable-only and bounds marker expiry", () => {
		const observedAt = NOW - 120_000;
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5-20260701",
			snapshot: snapshot(observedAt),
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "family",
			family: "fable",
			attemptedModel: "claude-fable-5-20260701",
			snapshotAgeMs: 120_000,
		});
		// Earliest bound is evidence freshness: observedAt + 180s = now + 60s.
		expect(decision.markerExpiresAt).toBe(NOW + 60_000);
	});

	it("classifies the exact inactive-account-window live fixture as Fable-only", () => {
		const liveFixture = snapshot(NOW - 120_000, { weeklyAll: 84 });
		const limits = (
			liveFixture.data as {
				limits: Array<{
					kind: string;
					percent: number;
					is_active?: boolean;
				}>;
			}
		).limits;
		for (const limit of limits) {
			if (limit.kind === "session" || limit.kind === "weekly_all") {
				limit.is_active = false;
			}
		}

		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response({ "retry-after": "120" }),
			attemptedModel: "claude-fable-5-20260701",
			snapshot: liveFixture,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "family",
			family: "fable",
			reason: "matching_scoped_limit",
			markerExpiresAt: NOW + 60_000,
		});
	});

	it("keeps a generic Opus failure exact-model scoped when only Fable is capped", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-opus-4-8",
			snapshot: snapshot(NOW - 120_000),
			now: NOW,
		});
		expect(decision).toMatchObject({
			scope: "model",
			family: "opus",
			reason: "missing_matching_scoped_limit",
			markerExpiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
	});

	it("treats evidence at 181 seconds as stale without benching the account", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 181_000),
			now: NOW,
		});
		expect(decision).toMatchObject({
			scope: "model",
			reason: "stale_usage",
			snapshotAgeMs: 181_000,
			markerExpiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
	});

	it("keeps a recognized Claude model exact-scoped while startup usage is empty", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5-20260701",
			snapshot: null,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "model",
			family: "fable",
			reason: "missing_usage",
			markerExpiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
	});

	it("uses Retry-After only to shorten marker expiry, never to broaden scope", () => {
		const timedResponse = response({ "retry-after": "90" });
		expect(hasHardAnthropicAccountSignal(timedResponse)).toBe(false);

		const decision = classifyPreByte429({
			isAnthropic: true,
			response: timedResponse,
			attemptedModel: "claude-fable-5-20260701",
			snapshot: null,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "model",
			reason: "missing_usage",
			markerExpiresAt: NOW + 90_000,
		});
	});

	it("caps far-future timing headers at the five-minute model marker TTL", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response({ "x-ratelimit-reset": String(NOW / 1000 + 3600) }),
			attemptedModel: "claude-fable-5-20260701",
			snapshot: null,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "model",
			markerExpiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
	});

	it("lets an account-wide 100% cap override matching scoped evidence", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 120_000, { weeklyAll: 100 }),
			now: NOW,
		});
		expect(decision.scope).toBe("account");
		expect(decision.reason).toBe("account_capacity_signal");
	});

	it("lets a hard live response header override scoped cached evidence", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response({
				"anthropic-ratelimit-unified-status": "rate_limited",
			}),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 120_000),
			now: NOW,
		});
		expect(decision.scope).toBe("account");
		expect(decision.reason).toBe("hard_response_signal");
	});

	it("treats explicit unified remaining zero as account-wide evidence", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response({
				"anthropic-ratelimit-unified-remaining": "0",
				"retry-after": "30",
			}),
			attemptedModel: "claude-fable-5",
			snapshot: null,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "account",
			reason: "hard_response_signal",
			markerExpiresAt: null,
		});
	});

	it("does not treat an empty unified remaining header as explicit zero", () => {
		const ambiguousResponse = response({
			"anthropic-ratelimit-unified-remaining": "",
			"retry-after": "30",
		});
		expect(hasHardAnthropicAccountSignal(ambiguousResponse)).toBe(false);
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: ambiguousResponse,
			attemptedModel: "claude-fable-5",
			snapshot: null,
			now: NOW,
		});
		expect(decision).toMatchObject({
			scope: "model",
			reason: "missing_usage",
			markerExpiresAt: NOW + 30_000,
		});
	});

	it("keeps unknown models and other providers account-scoped", () => {
		const unknown = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "custom-model-without-family",
			snapshot: snapshot(NOW - 120_000),
			now: NOW,
		});
		expect(unknown).toMatchObject({
			scope: "account",
			reason: "unknown_model",
		});

		const otherProvider = classifyPreByte429({
			isAnthropic: false,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 120_000),
			now: NOW,
		});
		expect(otherProvider).toMatchObject({
			scope: "account",
			reason: "non_anthropic",
		});
	});

	it("keeps missing account-headroom evidence exact-model scoped", () => {
		const base = snapshot(NOW - 120_000);
		const data = base.data as { limits: Array<{ kind: string }> };
		data.limits = data.limits.filter((limit) => limit.kind !== "session");
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: base,
			now: NOW,
		});
		expect(decision).toMatchObject({
			scope: "model",
			reason: "missing_account_headroom",
			markerExpiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
	});

	it("ignores inactive account-wide 100% rows when deciding account scope", () => {
		const base = snapshot(NOW - 120_000);
		const data = base.data as {
			limits: Array<{ kind: string; percent: number; is_active?: boolean }>;
		};
		const weekly = data.limits.find((limit) => limit.kind === "weekly_all");
		if (!weekly) throw new Error("fixture weekly_all missing");
		weekly.percent = 100;
		weekly.is_active = false;

		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-opus-4-8",
			snapshot: base,
			now: NOW,
		});

		expect(decision).toMatchObject({
			scope: "model",
			reason: "missing_matching_scoped_limit",
		});
	});

	it("uses the earliest scoped reset when it precedes freshness and TTL", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 30_000, { scopedReset: NOW + 10_000 }),
			now: NOW,
		});
		expect(decision.scope).toBe("family");
		expect(decision.markerExpiresAt).toBe(NOW + 10_000);
	});

	it("uses a response timing header as the earlier family-marker expiry", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response({ "retry-after": "15" }),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 30_000),
			now: NOW,
		});
		expect(decision.scope).toBe("family");
		expect(decision.markerExpiresAt).toBe(NOW + 15_000);
	});
});

describe("getAnthropicRateLimitResetAt", () => {
	const validCases: Array<{
		name: string;
		headers: HeadersInit;
		expected: number;
	}> = [
		{
			name: "Retry-After delay seconds",
			headers: { "retry-after": "45" },
			expected: NOW + 45_000,
		},
		{
			name: "Retry-After HTTP-date",
			headers: { "retry-after": new Date(NOW + 45_000).toUTCString() },
			expected: NOW + 45_000,
		},
		{
			name: "x-ratelimit-reset epoch seconds",
			headers: { "x-ratelimit-reset": String(NOW / 1000 + 45) },
			expected: NOW + 45_000,
		},
		{
			name: "Anthropic unified reset epoch seconds",
			headers: {
				"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 45),
			},
			expected: NOW + 45_000,
		},
	];

	for (const fixture of validCases) {
		it(`parses ${fixture.name}`, () => {
			expect(getAnthropicRateLimitResetAt(response(fixture.headers), NOW)).toBe(
				fixture.expected,
			);
		});
	}

	it("treats every numeric Retry-After as delay-seconds and clamps it", () => {
		expect(
			getAnthropicRateLimitResetAt(
				response({ "retry-after": String(NOW / 1000 + 45) }),
				NOW,
			),
		).toBe(NOW + 24 * 60 * 60 * 1000);
	});

	const invalidCases: Array<{ name: string; headers: HeadersInit }> = [
		{ name: "invalid text", headers: { "retry-after": "not-a-reset" } },
		{ name: "zero", headers: { "retry-after": "0" } },
		{ name: "negative", headers: { "retry-after": "-1" } },
		{
			name: "past epoch seconds",
			headers: { "x-ratelimit-reset": String(NOW / 1000 - 1) },
		},
		{ name: "invalid reset epoch", headers: { "x-ratelimit-reset": "nope" } },
		{
			name: "zero unified reset",
			headers: { "anthropic-ratelimit-unified-reset": "0" },
		},
	];

	for (const fixture of invalidCases) {
		it(`rejects ${fixture.name}`, () => {
			expect(
				getAnthropicRateLimitResetAt(response(fixture.headers), NOW),
			).toBeNull();
		});
	}

	it("ignores invalid hints when another reset is usable", () => {
		expect(
			getAnthropicRateLimitResetAt(
				response({
					"retry-after": "not-a-reset",
					"x-ratelimit-reset": String(NOW / 1000 + 30),
				}),
				NOW,
			),
		).toBe(NOW + 30_000);
	});

	it("uses the earliest of multiple usable reset hints", () => {
		expect(
			getAnthropicRateLimitResetAt(
				response({
					"retry-after": "90",
					"x-ratelimit-reset": String(NOW / 1000 + 30),
					"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 60),
				}),
				NOW,
			),
		).toBe(NOW + 30_000);
	});
});

describe("request-local rate-limit outcome ledger", () => {
	it("keeps immutable outcomes isolated by Request identity", () => {
		const first = new Request("https://proxy.local/v1/messages");
		const second = new Request("https://proxy.local/v1/messages");
		recordRequestRateLimitOutcome(first, {
			accountId: "acc-1",
			status: 429,
			scope: "family",
			family: "fable",
			attemptedModel: "claude-fable-5",
			reason: "matching_scoped_limit",
			availableAt: NOW + 60_000,
		});

		expect(getRequestRateLimitOutcomes(first)).toEqual([
			{
				accountId: "acc-1",
				status: 429,
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-5",
				reason: "matching_scoped_limit",
				availableAt: NOW + 60_000,
			},
		]);
		expect(getRequestRateLimitOutcomes(second)).toEqual([]);
		expect(Object.isFrozen(getRequestRateLimitOutcomes(first))).toBe(true);
	});
});
