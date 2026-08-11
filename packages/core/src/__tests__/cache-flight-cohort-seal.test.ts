import { describe, expect, it } from "bun:test";
import {
	analyzeCacheFlightCohorts,
	type CacheFlightCohortObservation,
	type CacheFlightKeepalivePolicySnapshot,
	type CacheFlightPersistedSeal,
	type CacheFlightSealCompleteness,
	type CacheFlightServiceEpoch,
} from "@better-ccflare/core";

const completeKeepalivePolicy: CacheFlightKeepalivePolicySnapshot = {
	globalTtlMinutes: 20,
	xaiTtlMinutes: 20,
	effectiveXaiEnabled: true,
	effectiveXaiTtlMinutes: 20,
};

function serviceEpoch(
	id: string,
	overrides: Partial<CacheFlightServiceEpoch> = {},
): CacheFlightServiceEpoch {
	return {
		id,
		occurrenceId: `${id}-occurrence`,
		sealContractVersion: 1,
		deploymentRevision: "deploy-a",
		serviceInstanceId: "service-instance-a",
		processStartedAt: "2026-08-08T10:00:00.000Z",
		nativeCacheState: "enabled",
		recorderState: "enabled",
		keepalivePolicy: completeKeepalivePolicy,
		completeness: "complete",
		unavailableDimensions: [],
		...overrides,
	};
}

function seal(
	epoch: CacheFlightServiceEpoch,
	overrides: {
		partitionId?: string;
		servingAccountScope?: string | null;
		routeModelEpoch?: string | null;
		partitionCompleteness?: CacheFlightSealCompleteness;
		partitionUnavailableDimensions?: CacheFlightPersistedSeal["observationPartition"]["unavailableDimensions"];
		sealCompleteness?: CacheFlightSealCompleteness;
		sealUnavailableDimensions?: CacheFlightPersistedSeal["unavailableDimensions"];
	} = {},
): CacheFlightPersistedSeal {
	return {
		serviceEpoch: epoch,
		observationPartition: {
			id: overrides.partitionId ?? "partition-a",
			serviceEpochId: epoch.id,
			servingAccountScope: overrides.servingAccountScope ?? "scope-a",
			routeModelEpoch: overrides.routeModelEpoch ?? "route-model-a",
			completeness: overrides.partitionCompleteness ?? "complete",
			unavailableDimensions: overrides.partitionUnavailableDimensions ?? [],
		},
		completeness: overrides.sealCompleteness ?? "complete",
		unavailableDimensions: overrides.sealUnavailableDimensions ?? [],
	};
}

function observation(
	sequence: number,
	overrides: Partial<CacheFlightCohortObservation> = {},
): CacheFlightCohortObservation {
	return {
		recorderConversationId: "recorder-safe-id",
		sequence,
		timestamp: `2026-08-08T10:0${sequence}:00.000Z`,
		cacheOutcome: "hit",
		completeness: "complete",
		unavailableDimensions: [],
		seal: seal(serviceEpoch("epoch-a")),
		...overrides,
	};
}

describe("analyzeCacheFlightCohorts", () => {
	it("forms one eligible cohort for complete observations in one epoch and partition", () => {
		const epoch = serviceEpoch("epoch-a");
		const persistedSeal = seal(epoch);
		const result = analyzeCacheFlightCohorts([
			observation(2, { cacheOutcome: "miss", seal: persistedSeal }),
			observation(1, { cacheOutcome: "hit", seal: persistedSeal }),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.safeWithinCohortSubsets).toHaveLength(1);
		expect(result.crossCohortMetric).toBeNull();
		expect(result.cachePolicyRecommendation).toBeNull();
		expect(result.descriptiveCounts).toEqual({
			observations: 2,
			sealed: 2,
			unsealed: 0,
			hit: 1,
			miss: 1,
			unknown: 0,
		});
		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				privacySafeIds: {
					serviceEpochId: "epoch-a",
					serviceEpochOccurrenceId: "epoch-a-occurrence",
					observationPartitionId: "partition-a",
				},
				firstObservedAt: "2026-08-08T10:01:00.000Z",
				lastObservedAt: "2026-08-08T10:02:00.000Z",
				observationCount: 2,
				cacheOutcomeCounts: { hit: 1, miss: 1, unknown: 0 },
				sealCompleteness: "complete",
				completeness: "complete",
				eligible: true,
				blockers: [],
				contributors: [
					{ recorderConversationId: "recorder-safe-id", sequence: 1 },
					{ recorderConversationId: "recorder-safe-id", sequence: 2 },
				],
			}),
		);
		expect(
			result.cohorts[0]?.visibleSealDimensions.map((item) => item.dimension),
		).toEqual([
			"seal_contract_version",
			"deployment_revision",
			"service_instance",
			"process_started_at",
			"native_cache_state",
			"recorder_state",
			"keepalive_policy",
			"service_epoch_occurrence",
			"serving_account_scope",
			"route_model_epoch",
			"seal_receipt",
		]);
		expect(result.safeWithinCohortSubsets[0]?.contributors).toEqual([
			{ recorderConversationId: "recorder-safe-id", sequence: 1 },
			{ recorderConversationId: "recorder-safe-id", sequence: 2 },
		]);
	});

	it("keeps different epoch IDs separate and reports changed known service dimensions", () => {
		const firstEpoch = serviceEpoch("epoch-a");
		const secondEpoch = serviceEpoch("epoch-b", {
			occurrenceId: "epoch-b-occurrence",
			deploymentRevision: "deploy-b",
			keepalivePolicy: {
				...completeKeepalivePolicy,
				xaiTtlMinutes: 5,
				effectiveXaiTtlMinutes: 5,
			},
		});
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: seal(firstEpoch) }),
			observation(2, {
				seal: seal(secondEpoch, { partitionId: "partition-b" }),
			}),
		]);

		expect(result.cohorts).toHaveLength(2);
		expect(
			result.blockers
				.filter((blocker) => blocker.kind === "changed")
				.map((blocker) => blocker.dimension),
		).toEqual([
			"deployment_revision",
			"keepalive_policy",
			"service_epoch_occurrence",
		]);
		expect(result.safeWithinCohortSubsets).toHaveLength(2);
	});

	it("reports changed and unknown blockers for mixed deployment evidence", () => {
		const firstEpoch = serviceEpoch("epoch-a");
		const secondEpoch = serviceEpoch("epoch-b", {
			occurrenceId: "epoch-b-occurrence",
			deploymentRevision: "deploy-b",
		});
		const unknownDeploymentEpoch = serviceEpoch("epoch-c", {
			occurrenceId: "epoch-c-occurrence",
			deploymentRevision: null,
			completeness: "incomplete",
			unavailableDimensions: ["deployment_revision"],
		});
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: seal(firstEpoch) }),
			observation(2, {
				seal: seal(secondEpoch, { partitionId: "partition-b" }),
			}),
			observation(3, {
				seal: seal(unknownDeploymentEpoch, {
					partitionId: "partition-c",
					sealCompleteness: "incomplete",
				}),
			}),
		]);

		expect(
			result.blockers.filter(
				(blocker) => blocker.dimension === "deployment_revision",
			),
		).toEqual([
			{
				dimension: "deployment_revision",
				kind: "unknown",
				detail: "deployment_revision_unknown",
			},
			{
				dimension: "deployment_revision",
				kind: "changed",
				detail: "deployment_revision_changed",
			},
		]);
		expect(result.safeWithinCohortSubsets).toHaveLength(2);
	});

	it("keeps different partitions under one epoch separate without a service-profile blocker", () => {
		const epoch = serviceEpoch("epoch-a");
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: seal(epoch) }),
			observation(2, {
				seal: seal(epoch, {
					partitionId: "partition-b",
					servingAccountScope: "scope-b",
					routeModelEpoch: "route-model-b",
				}),
			}),
		]);

		expect(result.cohorts).toHaveLength(2);
		expect(result.blockers.map((blocker) => blocker.dimension)).toEqual([
			"serving_account_scope",
			"route_model_epoch",
		]);
		expect(
			result.blockers.some((blocker) =>
				[
					"deployment_revision",
					"keepalive_policy",
					"service_epoch_occurrence",
				].includes(blocker.dimension),
			),
		).toBe(false);
	});

	it("keeps reused cohort IDs with conflicting seal evidence descriptive only", () => {
		const firstSeal = seal(
			serviceEpoch("epoch-a", {
				occurrenceId: "epoch-a-occurrence-1",
				deploymentRevision: "deploy-a",
			}),
		);
		const conflictingSeal = seal(
			serviceEpoch("epoch-a", {
				occurrenceId: "epoch-a-occurrence-2",
				deploymentRevision: "deploy-b",
			}),
		);
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: firstSeal }),
			observation(2, { cacheOutcome: "miss", seal: conflictingSeal }),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				cohortId: "epoch-a:partition-a",
				privacySafeIds: {
					serviceEpochId: "epoch-a",
					serviceEpochOccurrenceId: null,
					observationPartitionId: "partition-a",
				},
				observationCount: 2,
				cacheOutcomeCounts: { hit: 1, miss: 1, unknown: 0 },
				sealCompleteness: "incomplete",
				completeness: "complete",
				eligible: false,
				blockers: [
					{
						dimension: "deployment_revision",
						kind: "changed",
						detail: "deployment_revision_changed",
					},
					{
						dimension: "service_epoch_occurrence",
						kind: "changed",
						detail: "service_epoch_occurrence_changed",
					},
				],
				contributors: [
					{ recorderConversationId: "recorder-safe-id", sequence: 1 },
					{ recorderConversationId: "recorder-safe-id", sequence: 2 },
				],
			}),
		);
		expect(
			result.cohorts[0]?.visibleSealDimensions.find(
				(dimension) => dimension.dimension === "deployment_revision",
			),
		).toEqual({
			dimension: "deployment_revision",
			state: "unknown",
		});
		expect(
			result.cohorts[0]?.visibleSealDimensions.find(
				(dimension) => dimension.dimension === "service_epoch_occurrence",
			),
		).toEqual({
			dimension: "service_epoch_occurrence",
			state: "unknown",
		});
		expect(result.safeWithinCohortSubsets).toEqual([]);
		expect(result.blockers).toContainEqual({
			dimension: "deployment_revision",
			kind: "changed",
			detail: "deployment_revision_changed",
		});
		expect(result.blockers).toContainEqual({
			dimension: "service_epoch_occurrence",
			kind: "changed",
			detail: "service_epoch_occurrence_changed",
		});
	});

	it("keeps known and unknown evidence under reused IDs incomplete", () => {
		const knownSeal = seal(serviceEpoch("epoch-a"));
		const unknownSeal = seal(
			serviceEpoch("epoch-a", {
				deploymentRevision: null,
				completeness: "incomplete",
				unavailableDimensions: ["deployment_revision"],
			}),
			{ sealCompleteness: "incomplete" },
		);
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: knownSeal }),
			observation(2, { seal: unknownSeal }),
		]);

		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				sealCompleteness: "incomplete",
				eligible: false,
			}),
		);
		expect(
			result.cohorts[0]?.visibleSealDimensions.find(
				(dimension) => dimension.dimension === "deployment_revision",
			),
		).toEqual({
			dimension: "deployment_revision",
			state: "unknown",
		});
		expect(result.safeWithinCohortSubsets).toEqual([]);
	});

	it("keeps A to B to later A-shaped service profiles as separate occurrences", () => {
		const epochA1 = serviceEpoch("epoch-a1", {
			occurrenceId: "occurrence-a1",
			keepalivePolicy: {
				...completeKeepalivePolicy,
				xaiTtlMinutes: 20,
			},
		});
		const epochB = serviceEpoch("epoch-b", {
			occurrenceId: "occurrence-b",
			keepalivePolicy: {
				...completeKeepalivePolicy,
				xaiTtlMinutes: 5,
				effectiveXaiTtlMinutes: 5,
			},
		});
		const epochA2 = serviceEpoch("epoch-a2", {
			occurrenceId: "occurrence-a2",
			keepalivePolicy: {
				...completeKeepalivePolicy,
				xaiTtlMinutes: 20,
			},
		});
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: seal(epochA1, { partitionId: "partition-a1" }) }),
			observation(2, { seal: seal(epochB, { partitionId: "partition-b" }) }),
			observation(3, { seal: seal(epochA2, { partitionId: "partition-a2" }) }),
		]);

		expect(result.cohorts.map((cohort) => cohort.privacySafeIds)).toEqual([
			{
				serviceEpochId: "epoch-a1",
				serviceEpochOccurrenceId: "occurrence-a1",
				observationPartitionId: "partition-a1",
			},
			{
				serviceEpochId: "epoch-b",
				serviceEpochOccurrenceId: "occurrence-b",
				observationPartitionId: "partition-b",
			},
			{
				serviceEpochId: "epoch-a2",
				serviceEpochOccurrenceId: "occurrence-a2",
				observationPartitionId: "partition-a2",
			},
		]);
		expect(result.blockers).toContainEqual(
			expect.objectContaining({
				dimension: "service_epoch_occurrence",
				kind: "changed",
			}),
		);
		expect(result.blockers).toContainEqual(
			expect.objectContaining({
				dimension: "keepalive_policy",
				kind: "changed",
			}),
		);
	});

	it("keeps missing deployment, account scope, and route/model evidence descriptive only", () => {
		const epoch = serviceEpoch("epoch-a", {
			deploymentRevision: null,
			completeness: "incomplete",
			unavailableDimensions: ["deployment_revision"],
		});
		const result = analyzeCacheFlightCohorts([
			observation(1, {
				seal: seal(epoch, {
					servingAccountScope: null,
					routeModelEpoch: null,
					partitionCompleteness: "incomplete",
					partitionUnavailableDimensions: [
						"serving_account_scope",
						"route_model_epoch",
					],
					sealCompleteness: "incomplete",
				}),
			}),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.safeWithinCohortSubsets).toEqual([]);
		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				observationCount: 1,
				sealCompleteness: "incomplete",
				eligible: false,
			}),
		);
		expect(result.cohorts[0]?.blockers).toEqual([
			{
				dimension: "deployment_revision",
				kind: "unknown",
				detail: "deployment_revision_unknown",
			},
			{
				dimension: "serving_account_scope",
				kind: "unknown",
				detail: "serving_account_scope_unknown",
			},
			{
				dimension: "route_model_epoch",
				kind: "unknown",
				detail: "route_model_epoch_unknown",
			},
		]);
	});

	it("does not let complete seals upgrade incomplete turn evidence", () => {
		const epoch = serviceEpoch("epoch-a");
		const persistedSeal = seal(epoch);
		const result = analyzeCacheFlightCohorts([
			observation(1, {
				completeness: "partial",
				unavailableDimensions: ["cache_telemetry"],
				seal: persistedSeal,
			}),
			observation(2, { completeness: "incomplete", seal: persistedSeal }),
			observation(3, {
				completeness: "contradictory",
				seal: persistedSeal,
			}),
			observation(4, {
				completeness: "complete",
				gapBefore: true,
				seal: persistedSeal,
			}),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				sealCompleteness: "complete",
				completeness: "contradictory",
				eligible: false,
				observationCount: 4,
			}),
		);
		expect(result.safeWithinCohortSubsets).toEqual([]);
		expect(result.cohorts[0]?.blockers).toEqual([
			{
				dimension: "turn_completeness",
				kind: "unknown",
				detail: "turn_partial",
			},
			{
				dimension: "turn_unavailable_dimension",
				kind: "unknown",
				detail: "turn_unavailable_dimensions_present",
			},
			{
				dimension: "turn_completeness",
				kind: "unknown",
				detail: "turn_incomplete",
			},
			{
				dimension: "turn_completeness",
				kind: "unknown",
				detail: "turn_contradictory",
			},
			{
				dimension: "turn_gap",
				kind: "unknown",
				detail: "turn_gaps_present",
			},
		]);
	});

	it("keeps historical null seals unsealed and descriptive only", () => {
		const result = analyzeCacheFlightCohorts([
			observation(1, { cacheOutcome: "hit", seal: null }),
			observation(2, { cacheOutcome: "miss" }),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.unsealed).toEqual({
			observationCount: 1,
			cacheOutcomeCounts: { hit: 1, miss: 0, unknown: 0 },
			contributors: [
				{ recorderConversationId: "recorder-safe-id", sequence: 1 },
			],
		});
		expect(result.descriptiveCounts).toEqual({
			observations: 2,
			sealed: 1,
			unsealed: 1,
			hit: 1,
			miss: 1,
			unknown: 0,
		});
		expect(result.safeWithinCohortSubsets).toHaveLength(1);
		expect(result.blockers).toContainEqual({
			dimension: "historical_unsealed",
			kind: "unknown",
			detail: "historical_seal_reference_null",
		});
	});

	it("reports partition dimensions as not comparable across a restart while service-epoch dimensions still report changed", () => {
		// Same underlying account/route, but a restart: serviceInstanceId,
		// processStartedAt, and the epoch occurrence all rotate (as intended -
		// R2/KTD2). The partition pseudonyms (serving_account_scope,
		// route_model_epoch) are HMAC-derived per-process, so they take on
		// different opaque string values across the restart too - but that
		// difference is an artifact of the restart, not evidence the
		// underlying account or route actually changed. The analyzer must not
		// claim "changed" for those two dimensions across this boundary.
		const beforeRestart = serviceEpoch("epoch-a", {
			occurrenceId: "occurrence-a",
			serviceInstanceId: "service-instance-a",
			processStartedAt: "2026-08-08T10:00:00.000Z",
		});
		const afterRestart = serviceEpoch("epoch-b", {
			occurrenceId: "occurrence-b",
			serviceInstanceId: "service-instance-b",
			processStartedAt: "2026-08-08T11:00:00.000Z",
		});
		const result = analyzeCacheFlightCohorts([
			observation(1, {
				seal: seal(beforeRestart, {
					partitionId: "partition-a",
					servingAccountScope: "scope-pseudonym-before",
					routeModelEpoch: "route-pseudonym-before",
				}),
			}),
			observation(2, {
				seal: seal(afterRestart, {
					partitionId: "partition-b",
					servingAccountScope: "scope-pseudonym-after",
					routeModelEpoch: "route-pseudonym-after",
				}),
			}),
		]);

		expect(
			result.blockers
				.filter((blocker) => blocker.kind === "changed")
				.map((blocker) => blocker.dimension),
		).toEqual([
			"service_instance",
			"process_started_at",
			"service_epoch_occurrence",
		]);
		expect(
			result.blockers
				.filter((blocker) => blocker.kind === "not_comparable")
				.map((blocker) => blocker.dimension),
		).toEqual(["serving_account_scope", "route_model_epoch"]);
		expect(
			result.blockers.some(
				(blocker) =>
					blocker.dimension === "serving_account_scope" ||
					blocker.dimension === "route_model_epoch",
			),
		).toBe(true);
		expect(
			result.blockers.filter(
				(blocker) =>
					(blocker.dimension === "serving_account_scope" ||
						blocker.dimension === "route_model_epoch") &&
					blocker.kind === "changed",
			),
		).toEqual([]);
	});

	it("keeps a genuinely missing partition dimension reported as unknown, distinct from not-comparable, when service instance is shared", () => {
		const epoch = serviceEpoch("epoch-a");
		const result = analyzeCacheFlightCohorts([
			observation(1, {
				seal: seal(epoch, {
					partitionId: "partition-a",
					servingAccountScope: "scope-a",
					routeModelEpoch: "route-model-a",
				}),
			}),
			observation(2, {
				seal: seal(epoch, {
					partitionId: "partition-b",
					servingAccountScope: null,
					routeModelEpoch: "route-model-b",
					partitionCompleteness: "incomplete",
					partitionUnavailableDimensions: ["serving_account_scope"],
					sealCompleteness: "incomplete",
				}),
			}),
		]);

		expect(
			result.blockers.filter(
				(blocker) => blocker.dimension === "serving_account_scope",
			),
		).toEqual([
			{
				dimension: "serving_account_scope",
				kind: "unknown",
				detail: "serving_account_scope_unknown",
			},
		]);
		expect(
			result.blockers.some(
				(blocker) =>
					blocker.dimension === "serving_account_scope" &&
					blocker.kind === "not_comparable",
			),
		).toBe(false);
		expect(
			result.blockers.filter(
				(blocker) => blocker.dimension === "route_model_epoch",
			),
		).toEqual([
			{
				dimension: "route_model_epoch",
				kind: "changed",
				detail: "route_model_epoch_changed",
			},
		]);
	});

	it("uses only retained contributors in summaries and counts", () => {
		const epoch = serviceEpoch("epoch-a");
		const persistedSeal = seal(epoch);
		const result = analyzeCacheFlightCohorts([
			observation(1, { seal: persistedSeal }),
			observation(2, {
				cacheOutcome: "miss",
				retained: false,
				seal: persistedSeal,
			}),
			observation(3, { cacheOutcome: "unknown", seal: persistedSeal }),
		]);

		expect(result.cohorts).toHaveLength(1);
		expect(result.cohorts[0]).toEqual(
			expect.objectContaining({
				firstObservedAt: "2026-08-08T10:01:00.000Z",
				lastObservedAt: "2026-08-08T10:03:00.000Z",
				observationCount: 2,
				cacheOutcomeCounts: { hit: 1, miss: 0, unknown: 1 },
				contributors: [
					{ recorderConversationId: "recorder-safe-id", sequence: 1 },
					{ recorderConversationId: "recorder-safe-id", sequence: 3 },
				],
			}),
		);
		expect(result.descriptiveCounts).toEqual({
			observations: 2,
			sealed: 2,
			unsealed: 0,
			hit: 1,
			miss: 0,
			unknown: 1,
		});
	});
});
