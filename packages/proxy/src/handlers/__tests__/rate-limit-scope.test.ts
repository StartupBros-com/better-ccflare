import { describe, expect, it } from "bun:test";
import type { UsageSnapshot } from "@better-ccflare/providers";
import {
	classifyPreByte429,
	getRequestRateLimitOutcomes,
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

	it("does not let a Fable-only cap scope an Opus failure", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-opus-4-8",
			snapshot: snapshot(NOW - 120_000),
			now: NOW,
		});
		expect(decision.scope).toBe("account");
		expect(decision.reason).toBe("missing_matching_scoped_limit");
	});

	it("treats evidence at 181 seconds as stale and account-scoped", () => {
		const decision = classifyPreByte429({
			isAnthropic: true,
			response: response(),
			attemptedModel: "claude-fable-5",
			snapshot: snapshot(NOW - 181_000),
			now: NOW,
		});
		expect(decision).toMatchObject({
			scope: "account",
			reason: "stale_usage",
			snapshotAgeMs: 181_000,
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

	it("requires positive session and weekly-all headroom evidence", () => {
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
		expect(decision.scope).toBe("account");
		expect(decision.reason).toBe("missing_account_headroom");
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
