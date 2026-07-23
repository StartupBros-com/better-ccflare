import { describe, expect, it } from "bun:test";
import {
	diagnoseTimeline,
	type Timeline,
	type TurnEvidence,
} from "@better-ccflare/core";

const baseTurn: TurnEvidence = {
	sequence: 1,
	timestamp: "2026-07-15T10:00:00.000Z",
	identityFingerprint: "identity-a",
	servingAccountId: "account-a",
	prefixFingerprint: "prefix-a",
	cacheOutcome: "hit",
	inputTokens: 100,
	cachedTokens: 80,
	completeness: "complete",
	unavailableDimensions: [],
};

function turn(
	sequence: number,
	overrides: Partial<TurnEvidence> = {},
): TurnEvidence {
	return {
		...baseTurn,
		sequence,
		timestamp: `2026-07-15T10:0${sequence}:00.000Z`,
		...overrides,
	};
}

function timeline(...turns: TurnEvidence[]): Timeline {
	return { recorderConversationId: "recorder-safe-id", turns };
}

describe("diagnoseTimeline", () => {
	it("treats the first eligible turn as a baseline without a diagnosis", () => {
		const report = diagnoseTimeline(
			timeline(turn(1, { cacheOutcome: "miss", cachedTokens: 0 })),
		);

		expect(report.baselineSequence).toBe(1);
		expect(report.cause).toBeNull();
		expect(report.diagnosedSequence).toBeNull();
		expect(report.supportingEvidence).toEqual([]);
	});

	it("uses later hits as continuity proof without inventing a miss diagnosis", () => {
		const report = diagnoseTimeline(timeline(turn(1), turn(2)));

		expect(report.cause).toBeNull();
		expect(report.continuityProof.map((item) => item.dimension)).toEqual([
			"identity",
			"serving_account",
			"cacheable_prefix",
		]);
		expect(report.continuityProof.every((item) => item.kind === "stable")).toBe(
			true,
		);
	});

	it("diagnoses identity changes and retains later changes as evidence", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					identityFingerprint: "identity-b",
					servingAccountId: "account-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("identity_changed");
		expect(report.diagnosedSequence).toBe(2);
		expect(
			report.supportingEvidence.map((item) => [item.dimension, item.kind]),
		).toEqual([
			["identity", "changed"],
			["serving_account", "changed"],
			["cacheable_prefix", "changed"],
			["cache_outcome", "observed"],
		]);
	});

	it("diagnoses a serving account change when identity remains stable", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					servingAccountId: "account-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("serving_account_changed");
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "serving_account",
				kind: "changed",
			}),
		);
		// The stable prerequisite must survive alongside the changed dimension:
		// identity staying put is proof the miss isn't an identity break.
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "identity",
				kind: "stable",
			}),
		);
	});

	it("diagnoses a cacheable prefix change when identity and account are stable", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("cacheable_prefix_changed");
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "cacheable_prefix",
				kind: "changed",
			}),
		);
		// Stable prerequisites (identity and serving account) must remain so
		// the report proves the break wasn't caused by either of them.
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "identity",
				kind: "stable",
			}),
		);
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "serving_account",
				kind: "stable",
			}),
		);
	});

	it("diagnoses an upstream miss when observed lineage stays stable", () => {
		const report = diagnoseTimeline(
			timeline(turn(1), turn(2, { cacheOutcome: "miss", cachedTokens: 0 })),
		);

		expect(report.cause).toBe("upstream_miss_despite_stable_lineage");
		expect(
			report.supportingEvidence.map((item) => [item.dimension, item.kind]),
		).toEqual([
			["identity", "stable"],
			["serving_account", "stable"],
			["cacheable_prefix", "stable"],
			["cache_outcome", "observed"],
		]);
	});

	it("uses dimension precedence when several fields change on one transition", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					identityFingerprint: "identity-b",
					servingAccountId: "account-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("identity_changed");
	});

	it("diagnoses against the last proven hit, not earlier continuity history", () => {
		// Identity drifts on a hit turn, which advances continuity proof.
		// The later miss therefore diagnoses the first break after that hit.
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, { identityFingerprint: "identity-b" }),
				turn(3, {
					identityFingerprint: "identity-b",
					servingAccountId: "account-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("serving_account_changed");
		expect(
			report.supportingEvidence
				.filter((item) => item.kind === "changed")
				.map((item) => [item.fromSequence, item.toSequence, item.dimension]),
		).toEqual([
			[2, 3, "serving_account"],
			[2, 3, "cacheable_prefix"],
		]);
	});

	it("keeps later supporting transitions when identity is the first break before a miss", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					identityFingerprint: "identity-b",
					servingAccountId: "account-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				}),
			),
		);

		expect(report.cause).toBe("identity_changed");
		expect(
			report.supportingEvidence
				.filter((item) => item.kind === "changed")
				.map((item) => item.dimension),
		).toEqual(["identity", "serving_account", "cacheable_prefix"]);
	});

	it("returns telemetry unknown for an explicit sequence gap", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					cacheOutcome: "miss",
					cachedTokens: 0,
					gapBefore: true,
				}),
			),
		);

		expect(report.cause).toBe("telemetry_unknown");
		expect(report.gaps).toContain("gap_before_turn_2");
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({ dimension: "timeline", kind: "gap" }),
		);
	});

	it("detects implicit sequence gaps", () => {
		const report = diagnoseTimeline(
			timeline(turn(1), turn(3, { cacheOutcome: "miss", cachedTokens: 0 })),
		);

		expect(report.cause).toBe("telemetry_unknown");
		expect(report.gaps).toContain("missing_turns_2_to_2");
	});

	it("annotates stable-lineage misses with idle gap evidence", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1, {
					timestamp: "2026-07-23T02:07:20.000Z",
					inputTokens: 316_800,
					cachedTokens: 316_800,
				}),
				turn(2, {
					timestamp: "2026-07-23T02:09:44.000Z",
					cacheOutcome: "miss",
					inputTokens: 319_758,
					cachedTokens: 128,
				}),
			),
		);

		expect(report.cause).toBe("upstream_miss_despite_stable_lineage");
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "timeline",
				kind: "observed",
				detail: "idle_gap_seconds_144",
			}),
		);
	});

	it("diagnoses effective near-miss collapses without token contradiction", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1, {
					inputTokens: 316_800,
					cachedTokens: 316_800,
				}),
				turn(2, {
					cacheOutcome: "miss",
					inputTokens: 319_758,
					cachedTokens: 128,
				}),
			),
		);

		expect(report.cause).toBe("upstream_miss_despite_stable_lineage");
		expect(report.completeness).toBe("complete");
		expect(report.diagnosedSequence).toBe(2);
	});

	it("returns telemetry unknown for contradictory token evidence", () => {
		const report = diagnoseTimeline(
			timeline(turn(1), turn(2, { cacheOutcome: "miss", cachedTokens: 25 })),
		);

		expect(report.cause).toBe("telemetry_unknown");
		expect(report.completeness).toBe("contradictory");
		expect(report.supportingEvidence).toContainEqual(
			expect.objectContaining({
				dimension: "token_accounting",
				kind: "contradiction",
			}),
		);
	});

	it("does not infer a miss when cache telemetry is unavailable", () => {
		const report = diagnoseTimeline(
			timeline(
				turn(1),
				turn(2, {
					cacheOutcome: "unknown",
					cachedTokens: undefined,
					completeness: "partial",
					unavailableDimensions: ["cache_telemetry"],
				}),
			),
		);

		expect(report.cause).toBe("telemetry_unknown");
		expect(report.diagnosedSequence).toBe(2);
		expect(report.unavailableDimensions).toContain("cache_telemetry");
	});
});
