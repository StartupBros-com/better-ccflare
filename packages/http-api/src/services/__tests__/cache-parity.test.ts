import { describe, expect, test } from "bun:test";
import {
	buildCacheParityResponse,
	type CacheParityAggregateRow,
	type CacheParityPolicy,
} from "../cache-parity";

const POLICY: CacheParityPolicy = {
	promptCacheKeyEnabled: true,
	cacheKeyMode: "conversation",
	cacheKeySessionPercent: 0,
	cacheKeyContinuityPercent: 100,
	cacheKeyPrefixShardPercent: 0,
	pacingMs: 60_000,
	codexSettleMs: 0,
	pacingBypassPercent: 0,
	explicitBreakpointPercent: 0,
	explicitBreakpointSuppressedScopes: 0,
	turnStatePercent: 0,
	turnStateObserveOnly: false,
	webSocketPercent: 0,
	globalKeepaliveTtlMinutes: 0,
	xaiCacheKeepaliveTtlMinutes: 0,
};

function row(
	partial: Partial<CacheParityAggregateRow> = {},
): CacheParityAggregateRow {
	return {
		provider: "codex",
		physicalModel: "gpt-5.6-sol",
		accountName: "codex-primary",
		turnKind: "follow_up",
		gapBand: "under_1m",
		contextBand: "from_100k_to_200k",
		sameAccount: true,
		cacheShareBucket: 98,
		requests: 1_000,
		successfulRequests: 1_000,
		fallbackRequests: 0,
		contextOverflowRequests: 0,
		inputTokens: 20_000_000,
		cacheReadInputTokens: 19_600_000,
		...partial,
	};
}

function response(
	rows7d: CacheParityAggregateRow[],
	rows24h: CacheParityAggregateRow[] = rows7d,
	policy: CacheParityPolicy = POLICY,
) {
	return buildCacheParityResponse({
		rows24h,
		rows7d,
		policy,
		generatedAt: 1_787_218_000_000,
	});
}

describe("buildCacheParityResponse", () => {
	test("keeps the seven-day verdict authoritative over a passing 24-hour view", () => {
		const data = response(
			[
				row({
					cacheShareBucket: 90,
					cacheReadInputTokens: 18_000_000,
				}),
			],
			[row()],
		);

		expect(data.windows.advisory24h.verdict).toBe("at_parity");
		expect(data.windows.authoritative7d.verdict).toBe("below_parity");
		expect(data.verdict).toBe("below_parity");
	});

	test("fails closed when the Codex evidence floor is not met", () => {
		const data = response([
			row({ requests: 999, successfulRequests: 999, inputTokens: 9_999_999 }),
		]);
		expect(data.verdict).toBe("insufficient_evidence");
		expect(data.windows.authoritative7d.reasons).toContain(
			"codex_evidence_below_floor",
		);
	});

	test("requires weighted, positive, zero-hit, model, and Anthropic parity", () => {
		const data = response([
			row(),
			row({
				provider: "anthropic",
				physicalModel: "claude-sonnet",
				accountName: "anthropic-primary",
				cacheShareBucket: 97,
				cacheReadInputTokens: 19_400_000,
			}),
		]);

		expect(data.verdict).toBe("at_parity");
		const codex = data.windows.authoritative7d.providers.find(
			(item) => item.key === "codex",
		);
		expect(codex?.followUps).toMatchObject({
			weightedCacheReadPercent: 98,
			positiveHitRatePercent: 100,
			zeroHitRatePercent: 0,
		});
	});

	test("reports first turns but excludes them from the verdict", () => {
		const data = response([
			row(),
			row({
				turnKind: "first_observed",
				cacheShareBucket: 0,
				cacheReadInputTokens: 0,
			}),
		]);

		expect(data.verdict).toBe("at_parity");
		const codex = data.windows.authoritative7d.providers.find(
			(item) => item.key === "codex",
		);
		expect(codex?.firstObserved.zeroHitRatePercent).toBe(100);
	});

	test("blocks parity when a qualified physical model misses the floor", () => {
		const data = response([
			row({
				physicalModel: "gpt-5.6-sol",
				cacheShareBucket: 100,
				cacheReadInputTokens: 20_000_000,
			}),
			row({
				physicalModel: "gpt-5.6-terra",
				cacheShareBucket: 90,
				cacheReadInputTokens: 18_000_000,
			}),
		]);

		expect(data.verdict).toBe("below_parity");
		expect(data.windows.authoritative7d.reasons).toContain(
			"codex_model_floor_not_met",
		);
	});

	test("fails closed when unattributed synthetic Codex traffic is possible", () => {
		const data = response([row()], [row()], {
			...POLICY,
			globalKeepaliveTtlMinutes: 5,
		});
		expect(data.verdict).toBe("insufficient_evidence");
		expect(data.windows.authoritative7d.reasons).toContain(
			"unattributed_synthetic_traffic_possible",
		);
	});

	test("carries a drift report, and a live turn-state percent reports as acknowledged", () => {
		const data = response([row()], [row()], {
			...POLICY,
			turnStatePercent: 50,
		});
		const turnStateDrift = data.driftReport.deviations.find(
			(deviation) => deviation.lever === "turnStatePercent",
		);
		expect(turnStateDrift?.acknowledged).toBe(true);
		expect(turnStateDrift?.acknowledgement?.issue).toBe(199);
		expect(data.driftReport.floorHeld).toBe(true);
	});
});
