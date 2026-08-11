import { describe, expect, it } from "bun:test";
import type { CacheFlightPersistedSeal } from "@better-ccflare/core";
import type { CacheFlightRecorderTimeline } from "@better-ccflare/database";
import {
	buildCacheFlightRecorderReport,
	renderCacheFlightRecorderReport,
	runCacheFlightRecorderCommand,
} from "../cache-flight-recorder";

const baselineTurn = {
	sequence: 0,
	timestamp: "2026-07-15T00:00:00.000Z",
	identityFingerprint: "identity-a",
	servingAccountId: "account-a",
	prefixFingerprint: "prefix-a",
	cacheOutcome: "hit" as const,
	inputTokens: 100,
	cachedTokens: 80,
	completeness: "complete" as const,
	unavailableDimensions: [],
	seal: null,
};
const hitTurn = {
	...baselineTurn,
	sequence: 1,
	timestamp: "2026-07-15T00:01:00.000Z",
	inputTokens: 120,
	cachedTokens: 100,
};
const hitTimeline: CacheFlightRecorderTimeline = {
	recorderConversationId: "recorder-safe-id",
	createdAt: 1_000,
	updatedAt: 2_000,
	incomplete: false,
	droppedEvents: 0,
	turns: [baselineTurn, hitTurn],
};

const completeSeal: CacheFlightPersistedSeal = {
	serviceEpoch: {
		id: "epoch-opaque-1",
		occurrenceId: "occurrence-1",
		sealContractVersion: 1,
		deploymentRevision: "revision-opaque-1",
		serviceInstanceId: "instance-opaque-1",
		processStartedAt: "2026-07-14T23:59:00.000Z",
		nativeCacheState: "enabled",
		recorderState: "enabled",
		keepalivePolicy: {
			globalTtlMinutes: 60,
			xaiTtlMinutes: 30,
			effectiveXaiEnabled: true,
			effectiveXaiTtlMinutes: 30,
		},
		completeness: "complete",
		unavailableDimensions: [],
	},
	observationPartition: {
		id: "partition-opaque-1",
		serviceEpochId: "epoch-opaque-1",
		servingAccountScope: "scope-opaque-1",
		routeModelEpoch: "route-opaque-1",
		completeness: "complete",
		unavailableDimensions: [],
	},
	completeness: "complete",
	unavailableDimensions: [],
};

const sealedHitTimeline: CacheFlightRecorderTimeline = {
	...hitTimeline,
	turns: [
		{ ...baselineTurn, seal: completeSeal },
		{ ...hitTurn, seal: completeSeal },
	],
};

function capture() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		io: {
			stdout: (value: string) => stdout.push(value),
			stderr: (value: string) => stderr.push(value),
		},
	};
}

function db(overrides: Record<string, unknown> = {}) {
	return {
		lookupCacheFlightRecorderTimeline: async () => ({
			status: "found" as const,
			timeline: hitTimeline,
		}),
		getCacheFlightRecorderCounts: async () => ({
			retained: 1,
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 2,
			incompleteSeal: 0,
		}),
		...overrides,
	};
}

describe("cache flight recorder report", () => {
	it("exposes one complete eligible cohort identically through human and JSON output", async () => {
		const human = capture();
		const json = capture();
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
		};
		const sealedDb = db({
			lookupCacheFlightRecorderTimeline: async () => ({
				status: "found" as const,
				timeline: sealedHitTimeline,
			}),
		});

		expect(
			(
				await runCacheFlightRecorderCommand(
					sealedDb,
					{ ...command, json: false },
					{ enabled: true, retentionHours: 72 },
					human.io,
				)
			).exitCode,
		).toBe(0);
		expect(
			(
				await runCacheFlightRecorderCommand(
					sealedDb,
					{ ...command, json: true },
					{ enabled: true, retentionHours: 72 },
					json.io,
				)
			).exitCode,
		).toBe(0);

		const report = JSON.parse(json.stdout.at(0) ?? "");
		expect(human.stdout).toEqual([renderCacheFlightRecorderReport(report)]);
		expect(report.cohortAnalysis).toEqual({
			cohorts: [
				{
					cohortId: "epoch-opaque-1:partition-opaque-1",
					privacySafeIds: {
						serviceEpochId: "epoch-opaque-1",
						serviceEpochOccurrenceId: "occurrence-1",
						observationPartitionId: "partition-opaque-1",
					},
					firstObservedAt: "2026-07-15T00:00:00.000Z",
					lastObservedAt: "2026-07-15T00:01:00.000Z",
					visibleSealDimensions: [
						{
							dimension: "seal_contract_version",
							state: "known",
							value: 1,
						},
						{
							dimension: "deployment_revision",
							state: "known",
							value: "revision-opaque-1",
						},
						{
							dimension: "service_instance",
							state: "known",
							value: "instance-opaque-1",
						},
						{
							dimension: "process_started_at",
							state: "known",
							value: "2026-07-14T23:59:00.000Z",
						},
						{
							dimension: "native_cache_state",
							state: "known",
							value: "enabled",
						},
						{
							dimension: "recorder_state",
							state: "known",
							value: "enabled",
						},
						{
							dimension: "keepalive_policy",
							state: "known",
							value: {
								globalTtlMinutes: 60,
								xaiTtlMinutes: 30,
								effectiveXaiEnabled: true,
								effectiveXaiTtlMinutes: 30,
							},
						},
						{
							dimension: "service_epoch_occurrence",
							state: "known",
							value: "occurrence-1",
						},
						{
							dimension: "serving_account_scope",
							state: "known",
							value: "scope-opaque-1",
						},
						{
							dimension: "route_model_epoch",
							state: "known",
							value: "route-opaque-1",
						},
						{
							dimension: "seal_receipt",
							state: "known",
							value: "complete",
						},
					],
					observationCount: 2,
					cacheOutcomeCounts: { hit: 2, miss: 0, unknown: 0 },
					sealCompleteness: "complete",
					completeness: "complete",
					eligible: true,
					blockers: [],
					contributors: [
						{ recorderConversationId: "recorder-safe-id", sequence: 0 },
						{ recorderConversationId: "recorder-safe-id", sequence: 1 },
					],
				},
			],
			safeWithinCohortSubsets: [
				{
					cohortId: "epoch-opaque-1:partition-opaque-1",
					privacySafeIds: {
						serviceEpochId: "epoch-opaque-1",
						serviceEpochOccurrenceId: "occurrence-1",
						observationPartitionId: "partition-opaque-1",
					},
					observationCount: 2,
					cacheOutcomeCounts: { hit: 2, miss: 0, unknown: 0 },
					contributors: [
						{ recorderConversationId: "recorder-safe-id", sequence: 0 },
						{ recorderConversationId: "recorder-safe-id", sequence: 1 },
					],
				},
			],
			unsealed: {
				observationCount: 0,
				cacheOutcomeCounts: { hit: 0, miss: 0, unknown: 0 },
				contributors: [],
			},
			descriptiveCounts: {
				observations: 2,
				sealed: 2,
				unsealed: 0,
				hit: 2,
				miss: 0,
				unknown: 0,
			},
			blockers: [],
			crossCohortMetric: null,
			cachePolicyRecommendation: null,
		});
		expect(report.diagnosis.cause).toBeNull();
		expect(
			report.turns.map((turn: { sequence: number }) => turn.sequence),
		).toEqual([0, 1]);
		for (const evidence of [
			"Cohorts: 1",
			"Cohort: epoch-opaque-1:partition-opaque-1",
			"Service epoch: epoch-opaque-1",
			"Service epoch occurrence: occurrence-1",
			"Observation partition: partition-opaque-1",
			"First observed: 2026-07-15T00:00:00.000Z",
			"Last observed: 2026-07-15T00:01:00.000Z",
			"Observations: 2",
			"Cache outcomes: hit=2 miss=0 unknown=0",
			"Seal completeness: complete",
			"Turn completeness: complete",
			"Eligible: true",
			"Blockers: none",
			"seal_contract_version=known:1",
			"Contributors: recorder-safe-id#0, recorder-safe-id#1",
			"Safe within-cohort subsets: 1",
			"Safe within-cohort subset: epoch-opaque-1:partition-opaque-1",
			"Cross-cohort metric: null",
			"Cache policy recommendation: null",
			"Diagnosis: no continuity break observed",
			"Turns:",
		]) {
			expect(human.stdout.at(0)).toContain(evidence);
		}
		expect(human.stdout.at(0)).toContain(
			[
				"Safe within-cohort subsets: 1",
				"Safe within-cohort subset: epoch-opaque-1:partition-opaque-1",
				"  Service epoch: epoch-opaque-1",
				"  Service epoch occurrence: occurrence-1",
				"  Observation partition: partition-opaque-1",
				"  Observations: 2",
				"  Cache outcomes: hit=2 miss=0 unknown=0",
				"  Contributors: recorder-safe-id#0, recorder-safe-id#1",
			].join("\n"),
		);
		expect(human.stderr).toEqual(json.stderr);
	});

	it("drives human and JSON command output from one canonical hit-only DTO", async () => {
		const dto = buildCacheFlightRecorderReport(hitTimeline);
		const human = capture();
		const json = capture();
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
		};

		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{ ...command, json: false },
					{ enabled: true, retentionHours: 72 },
					human.io,
				)
			).exitCode,
		).toBe(0);
		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{ ...command, json: true },
					{ enabled: true, retentionHours: 72 },
					json.io,
				)
			).exitCode,
		).toBe(0);

		expect(dto.diagnosis.cause).toBeNull();
		expect(dto.diagnosis.continuityProof).toHaveLength(3);
		expect(dto.baseline?.sequence).toBe(0);
		expect(dto.turns.map((turn) => turn.sequence)).toEqual([0, 1]);
		expect(dto.turns[1]?.tokens).toEqual({ input: 120, cached: 100 });
		expect(human.stdout).toEqual([renderCacheFlightRecorderReport(dto)]);
		expect(human.stdout[0]).toContain(
			"Diagnosis: no continuity break observed",
		);
		expect(human.stdout[0]).toContain("Completeness: complete");
		expect(JSON.parse(json.stdout.at(0) ?? "")).toEqual(dto);
		expect(human.stderr).toEqual(json.stderr);
	});

	it("reports a miss cause and ordered supporting transitions", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				...hitTimeline.turns,
				{
					...hitTurn,
					sequence: 2,
					identityFingerprint: "identity-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				},
			],
		});

		expect(dto.diagnosis.cause).toBe("identity_changed");
		expect(dto.diagnosis.supportingTransitions[0]).toMatchObject({
			dimension: "identity",
			fromSequence: 1,
			toSequence: 2,
		});
		expect(renderCacheFlightRecorderReport(dto)).toContain(
			"Diagnosis: identity changed",
		);
	});

	it("keeps incomplete timelines reportable with explicit gaps", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			droppedEvents: 1,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					sequence: 2,
					gapBefore: true,
					cacheOutcome: "unknown",
					cachedTokens: undefined,
					completeness: "incomplete",
					unavailableDimensions: ["cache_outcome"],
				},
			],
		});

		expect(dto.completeness).toBe("incomplete");
		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		expect(dto.gaps).toEqual(["gap_before_turn_2", "missing_turns_1_to_1"]);
		expect(dto.unavailableDimensions).toEqual(["cache_outcome"]);
		expect(renderCacheFlightRecorderReport(dto)).toContain(
			"Dropped evidence: 1",
		);
	});

	it("does not downgrade known timeline loss to partial", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					completeness: "partial",
					unavailableDimensions: ["token_accounting"],
				},
			],
		});

		expect(dto.completeness).toBe("incomplete");
	});

	it("degrades a lost-evidence timeline to telemetry unknown even when retained turns are hit-only", () => {
		// Both retained turns are hits, so the pure diagnosis has no cause to
		// report. Evidence was still lost, so the headline must not claim
		// continuity was proven: the dropped turns could hide the real break.
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			droppedEvents: 1,
			turns: [baselineTurn, hitTurn],
		});

		expect(dto.completeness).toBe("incomplete");
		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		const rendered = renderCacheFlightRecorderReport(dto);
		expect(rendered).toContain("Diagnosis: telemetry unknown");
		expect(rendered).not.toContain("no continuity break observed");
		expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
	});

	it("degrades confident causes to telemetry unknown when evidence was lost", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			droppedEvents: 2,
			turns: [
				...hitTimeline.turns,
				{
					...hitTurn,
					sequence: 2,
					identityFingerprint: "identity-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				},
			],
		});

		expect(dto.completeness).toBe("incomplete");
		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		expect(renderCacheFlightRecorderReport(dto)).toContain(
			"Diagnosis: telemetry unknown",
		);
	});

	it("renders all privacy-safe diagnosis and turn evidence", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					identityFingerprint: "identity-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					completeness: "partial",
					unavailableDimensions: ["token_accounting"],
					gapBefore: true,
				},
			],
		});
		const human = renderCacheFlightRecorderReport(dto);

		expect(human).toContain("Diagnosed sequence: 1");
		expect(human).toContain(
			"kind=changed dimension=identity fromSequence=0 toSequence=1 fromValue=identity-a toValue=identity-b detail=identity_changed",
		);
		expect(human).toContain("identity=identity-b");
		expect(human).toContain("prefix=prefix-b");
		expect(human).toContain("completeness=partial");
		expect(human).toContain("unavailable=token_accounting");
		expect(human).toContain("gapBefore=true");
	});

	it("keeps service epochs and observation partitions separate with changed blockers", () => {
		const partitionSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			observationPartition: {
				...completeSeal.observationPartition,
				id: "partition-opaque-2",
				servingAccountScope: "scope-opaque-2",
				routeModelEpoch: "route-opaque-2",
			},
		};
		const restartedSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			serviceEpoch: {
				...completeSeal.serviceEpoch,
				id: "epoch-opaque-2",
				occurrenceId: "occurrence-2",
				processStartedAt: "2026-07-15T00:01:30.000Z",
			},
			observationPartition: {
				...completeSeal.observationPartition,
				id: "partition-opaque-3",
				serviceEpochId: "epoch-opaque-2",
			},
		};
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, seal: partitionSeal },
				{
					...hitTurn,
					sequence: 2,
					timestamp: "2026-07-15T00:02:00.000Z",
					seal: restartedSeal,
				},
			],
		});

		expect(dto.cohortAnalysis.cohorts.map((cohort) => cohort.cohortId)).toEqual(
			[
				"epoch-opaque-1:partition-opaque-1",
				"epoch-opaque-1:partition-opaque-2",
				"epoch-opaque-2:partition-opaque-3",
			],
		);
		expect(
			dto.cohortAnalysis.cohorts.map((cohort) => cohort.contributors),
		).toEqual([
			[{ recorderConversationId: "recorder-safe-id", sequence: 0 }],
			[{ recorderConversationId: "recorder-safe-id", sequence: 1 }],
			[{ recorderConversationId: "recorder-safe-id", sequence: 2 }],
		]);
		expect(dto.cohortAnalysis.cohorts.every((cohort) => cohort.eligible)).toBe(
			true,
		);
		expect(
			dto.cohortAnalysis.safeWithinCohortSubsets.map(
				(subset) => subset.cohortId,
			),
		).toEqual([
			"epoch-opaque-1:partition-opaque-1",
			"epoch-opaque-1:partition-opaque-2",
			"epoch-opaque-2:partition-opaque-3",
		]);
		expect(dto.cohortAnalysis.blockers).toEqual([
			{
				dimension: "process_started_at",
				kind: "changed",
				detail: "process_started_at_changed",
			},
			{
				dimension: "service_epoch_occurrence",
				kind: "changed",
				detail: "service_epoch_occurrence_changed",
			},
			{
				dimension: "serving_account_scope",
				kind: "changed",
				detail: "serving_account_scope_changed",
			},
			{
				dimension: "route_model_epoch",
				kind: "changed",
				detail: "route_model_epoch_changed",
			},
		]);
		expect(dto.cohortAnalysis.crossCohortMetric).toBeNull();
		expect(dto.cohortAnalysis.cachePolicyRecommendation).toBeNull();
		const human = renderCacheFlightRecorderReport(dto);
		expect(human).toContain(
			"Cohort blockers: changed:process_started_at:process_started_at_changed",
		);
		expect(human).toContain(
			"changed:serving_account_scope:serving_account_scope_changed",
		);
		expect(human).toContain("Cross-cohort metric: null");
		expect(human).toContain("Cache policy recommendation: null");
	});

	it("reports not-comparable partition dimensions across a restart consistently in human and JSON output", () => {
		const restartedInstanceSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			serviceEpoch: {
				...completeSeal.serviceEpoch,
				id: "epoch-opaque-2",
				occurrenceId: "occurrence-2",
				serviceInstanceId: "instance-opaque-2",
				processStartedAt: "2026-07-15T00:01:30.000Z",
			},
			observationPartition: {
				...completeSeal.observationPartition,
				id: "partition-opaque-2",
				serviceEpochId: "epoch-opaque-2",
				servingAccountScope: "scope-opaque-2",
				routeModelEpoch: "route-opaque-2",
			},
		};
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, seal: restartedInstanceSeal },
			],
		});

		expect(dto.cohortAnalysis.blockers).toEqual(
			expect.arrayContaining([
				{
					dimension: "service_instance",
					kind: "changed",
					detail: "service_instance_changed",
				},
				{
					dimension: "process_started_at",
					kind: "changed",
					detail: "process_started_at_changed",
				},
				{
					dimension: "service_epoch_occurrence",
					kind: "changed",
					detail: "service_epoch_occurrence_changed",
				},
			]),
		);
		expect(
			dto.cohortAnalysis.blockers.filter(
				(blocker) =>
					blocker.dimension === "serving_account_scope" ||
					blocker.dimension === "route_model_epoch",
			),
		).toEqual([
			{
				dimension: "serving_account_scope",
				kind: "not_comparable",
				detail: "serving_account_scope_not_comparable_across_restart",
				scope: "cross_service_instance",
			},
			{
				dimension: "route_model_epoch",
				kind: "not_comparable",
				detail: "route_model_epoch_not_comparable_across_restart",
				scope: "cross_service_instance",
			},
		]);

		const human = renderCacheFlightRecorderReport(dto);
		expect(human).toContain(
			"not_comparable:serving_account_scope:serving_account_scope_not_comparable_across_restart",
		);
		expect(human).toContain(
			"not_comparable:route_model_epoch:route_model_epoch_not_comparable_across_restart",
		);
		// The rendering must tell the operator the truth: the pseudonyms rotate
		// per process, so a cross-restart comparison of identity is impossible -
		// not that the account or route changed.
		expect(human).toContain("not comparable across a restart");
		expect(human).not.toContain(
			"changed:serving_account_scope:serving_account_scope_changed",
		);
		expect(human).not.toContain(
			"changed:route_model_epoch:route_model_epoch_changed",
		);

		const jsonOutput = capture();
		const humanOutput = capture();
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
		};
		const restartedDb = db({
			lookupCacheFlightRecorderTimeline: async () => ({
				status: "found" as const,
				timeline: {
					...hitTimeline,
					turns: [
						{ ...baselineTurn, seal: completeSeal },
						{ ...hitTurn, seal: restartedInstanceSeal },
					],
				},
			}),
		});

		return Promise.all([
			runCacheFlightRecorderCommand(
				restartedDb,
				{ ...command, json: true },
				{ enabled: true, retentionHours: 72 },
				jsonOutput.io,
			),
			runCacheFlightRecorderCommand(
				restartedDb,
				{ ...command, json: false },
				{ enabled: true, retentionHours: 72 },
				humanOutput.io,
			),
		]).then(() => {
			const report = JSON.parse(jsonOutput.stdout.at(0) ?? "");
			expect(report.cohortAnalysis.blockers).toContainEqual({
				dimension: "serving_account_scope",
				kind: "not_comparable",
				detail: "serving_account_scope_not_comparable_across_restart",
				scope: "cross_service_instance",
			});
			expect(humanOutput.stdout).toEqual([
				renderCacheFlightRecorderReport(report),
			]);
		});
	});

	it("scopes a within-instance changed blocker and a cross-instance not_comparable blocker for the same dimension so human and JSON output both read as two non-contradictory facts", () => {
		// Two turns share one known service instance (interleaved accounts
		// within one process lifetime) with a genuine serving_account_scope
		// difference between them; a third turn sits behind a restart into a
		// different service instance. Before the fix, the operator would see
		// "changed:serving_account_scope:..." and
		// "not_comparable:serving_account_scope:..." rendered adjacently with no
		// indication that they describe different comparisons - a
		// self-contradictory pair for the same dimension.
		const withinInstanceSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			observationPartition: {
				...completeSeal.observationPartition,
				id: "partition-opaque-2",
				servingAccountScope: "scope-opaque-2",
			},
		};
		const restartedSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			serviceEpoch: {
				...completeSeal.serviceEpoch,
				id: "epoch-opaque-2",
				occurrenceId: "occurrence-2",
				serviceInstanceId: "instance-opaque-2",
				processStartedAt: "2026-07-15T00:01:30.000Z",
			},
			observationPartition: {
				...completeSeal.observationPartition,
				id: "partition-opaque-3",
				serviceEpochId: "epoch-opaque-2",
				servingAccountScope: "scope-opaque-3",
			},
		};
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, seal: withinInstanceSeal },
				{
					...hitTurn,
					sequence: 2,
					timestamp: "2026-07-15T00:02:00.000Z",
					seal: restartedSeal,
				},
			],
		});

		const scopeBlockers = dto.cohortAnalysis.blockers.filter(
			(blocker) => blocker.dimension === "serving_account_scope",
		);
		expect(scopeBlockers).toContainEqual({
			dimension: "serving_account_scope",
			kind: "changed",
			detail: "serving_account_scope_changed",
			scope: "within_service_instance",
		});
		expect(scopeBlockers).toContainEqual({
			dimension: "serving_account_scope",
			kind: "not_comparable",
			detail: "serving_account_scope_not_comparable_across_restart",
			scope: "cross_service_instance",
		});
		expect(scopeBlockers).toHaveLength(2);

		const human = renderCacheFlightRecorderReport(dto);
		const cohortBlockersLine = human
			.split("\n")
			.find((line) => line.startsWith("Cohort blockers: "));
		expect(cohortBlockersLine).toBeDefined();
		// Detail text for "not_comparable" contains its own internal comma, so
		// individual entries can't be recovered by splitting the joined line on
		// ", " - assert on the exact rendered substring for each blocker
		// instead. This directly proves each carries distinguishing scope
		// language attached to the right blocker, so the pair reads as two
		// facts about different comparisons rather than one flat contradiction.
		expect(cohortBlockersLine).toContain(
			"changed:serving_account_scope:serving_account_scope_changed [scope: within one service instance]",
		);
		expect(cohortBlockersLine).toContain(
			"not_comparable:serving_account_scope:serving_account_scope_not_comparable_across_restart (pseudonym rotates per process restart; not comparable across a restart, not known to differ) [scope: across service instances]",
		);

		const jsonOutput = capture();
		const humanOutput = capture();
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
		};
		const mixedDb = db({
			lookupCacheFlightRecorderTimeline: async () => ({
				status: "found" as const,
				timeline: {
					...hitTimeline,
					turns: [
						{ ...baselineTurn, seal: completeSeal },
						{ ...hitTurn, seal: withinInstanceSeal },
						{
							...hitTurn,
							sequence: 2,
							timestamp: "2026-07-15T00:02:00.000Z",
							seal: restartedSeal,
						},
					],
				},
			}),
		});

		return Promise.all([
			runCacheFlightRecorderCommand(
				mixedDb,
				{ ...command, json: true },
				{ enabled: true, retentionHours: 72 },
				jsonOutput.io,
			),
			runCacheFlightRecorderCommand(
				mixedDb,
				{ ...command, json: false },
				{ enabled: true, retentionHours: 72 },
				humanOutput.io,
			),
		]).then(() => {
			const report = JSON.parse(jsonOutput.stdout.at(0) ?? "");
			const jsonScopeBlockers = report.cohortAnalysis.blockers.filter(
				(blocker: { dimension: string }) =>
					blocker.dimension === "serving_account_scope",
			);
			expect(jsonScopeBlockers).toContainEqual({
				dimension: "serving_account_scope",
				kind: "changed",
				detail: "serving_account_scope_changed",
				scope: "within_service_instance",
			});
			expect(jsonScopeBlockers).toContainEqual({
				dimension: "serving_account_scope",
				kind: "not_comparable",
				detail: "serving_account_scope_not_comparable_across_restart",
				scope: "cross_service_instance",
			});
			expect(humanOutput.stdout).toEqual([
				renderCacheFlightRecorderReport(report),
			]);
		});
	});

	it("keeps unknown seal evidence and historical unsealed turns descriptive-only", () => {
		const unknownRevisionSeal: CacheFlightPersistedSeal = {
			...completeSeal,
			serviceEpoch: {
				...completeSeal.serviceEpoch,
				deploymentRevision: null,
				completeness: "incomplete",
				unavailableDimensions: ["deployment_revision"],
			},
			completeness: "incomplete",
			unavailableDimensions: ["deployment_revision"],
		};
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: unknownRevisionSeal },
				{ ...hitTurn, seal: null },
			],
		});

		expect(dto.turns.map((turn) => turn.sequence)).toEqual([0, 1]);
		expect(dto.cohortAnalysis.cohorts).toHaveLength(1);
		expect(dto.cohortAnalysis.cohorts[0]).toMatchObject({
			cohortId: "epoch-opaque-1:partition-opaque-1",
			observationCount: 1,
			sealCompleteness: "incomplete",
			completeness: "complete",
			eligible: false,
			blockers: [
				{
					dimension: "deployment_revision",
					kind: "unknown",
					detail: "deployment_revision_unknown",
				},
			],
		});
		expect(
			dto.cohortAnalysis.cohorts[0]?.visibleSealDimensions.find(
				(dimension) => dimension.dimension === "deployment_revision",
			),
		).toEqual({ dimension: "deployment_revision", state: "unknown" });
		expect(dto.cohortAnalysis.safeWithinCohortSubsets).toEqual([]);
		expect(dto.cohortAnalysis.unsealed).toEqual({
			observationCount: 1,
			cacheOutcomeCounts: { hit: 1, miss: 0, unknown: 0 },
			contributors: [
				{ recorderConversationId: "recorder-safe-id", sequence: 1 },
			],
		});
		expect(dto.cohortAnalysis.descriptiveCounts).toEqual({
			observations: 2,
			sealed: 1,
			unsealed: 1,
			hit: 2,
			miss: 0,
			unknown: 0,
		});
		expect(dto.cohortAnalysis.blockers).toEqual([
			{
				dimension: "deployment_revision",
				kind: "unknown",
				detail: "deployment_revision_unknown",
			},
			{
				dimension: "historical_unsealed",
				kind: "unknown",
				detail: "historical_seal_reference_null",
			},
		]);
		const human = renderCacheFlightRecorderReport(dto);
		expect(human).toContain("deployment_revision=unknown");
		expect(human).toContain(
			"Blockers: unknown:deployment_revision:deployment_revision_unknown",
		);
		expect(human).toContain("Unsealed observations: 1");
		expect(human).toContain("Unsealed contributors: recorder-safe-id#1");
		expect(human).toContain("Safe within-cohort subsets: 0");
		expect(human).toContain(
			"unknown:historical_unsealed:historical_seal_reference_null",
		);
	});

	it("keeps core-derived contradictions, sequence gaps, and lost evidence authoritative", () => {
		const contradictory = buildCacheFlightRecorderReport({
			...sealedHitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, cachedTokens: 0, seal: completeSeal },
			],
		});
		expect(contradictory.completeness).toBe("contradictory");
		expect(contradictory.cohortAnalysis.cohorts[0]).toMatchObject({
			sealCompleteness: "complete",
			completeness: "contradictory",
			eligible: false,
			blockers: [
				{
					dimension: "turn_completeness",
					kind: "unknown",
					detail: "turn_contradictory",
				},
			],
		});
		expect(
			contradictory.cohortAnalysis.safeWithinCohortSubsets[0]?.contributors,
		).toEqual([{ recorderConversationId: "recorder-safe-id", sequence: 0 }]);

		const sequenceGap = buildCacheFlightRecorderReport({
			...sealedHitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, sequence: 2, seal: completeSeal },
			],
		});
		expect(sequenceGap.gaps).toEqual(["missing_turns_1_to_1"]);
		expect(sequenceGap.completeness).toBe("incomplete");
		expect(sequenceGap.cohortAnalysis.cohorts[0]).toMatchObject({
			sealCompleteness: "complete",
			completeness: "incomplete",
			eligible: false,
			blockers: [
				{
					dimension: "turn_gap",
					kind: "unknown",
					detail: "turn_gaps_present",
				},
			],
		});
		expect(
			sequenceGap.cohortAnalysis.safeWithinCohortSubsets[0]?.contributors,
		).toEqual([{ recorderConversationId: "recorder-safe-id", sequence: 0 }]);

		const lostEvidence = buildCacheFlightRecorderReport({
			...sealedHitTimeline,
			incomplete: true,
			droppedEvents: 1,
		});
		expect(lostEvidence.diagnosis.cause).toBe("telemetry_unknown");
		expect(lostEvidence.droppedEvidence).toBe(1);
		expect(lostEvidence.completeness).toBe("incomplete");
		expect(lostEvidence.cohortAnalysis.cohorts[0]).toMatchObject({
			sealCompleteness: "complete",
			completeness: "incomplete",
			eligible: false,
			blockers: [
				{
					dimension: "turn_completeness",
					kind: "unknown",
					detail: "turn_incomplete",
				},
			],
		});
		expect(lostEvidence.cohortAnalysis.safeWithinCohortSubsets).toEqual([]);

		const contradictoryLostEvidence = buildCacheFlightRecorderReport({
			...sealedHitTimeline,
			incomplete: true,
			droppedEvents: 1,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, cachedTokens: 0, seal: completeSeal },
			],
		});
		expect(contradictoryLostEvidence.completeness).toBe("contradictory");
		expect(contradictoryLostEvidence.cohortAnalysis.cohorts[0]).toMatchObject({
			completeness: "contradictory",
			eligible: false,
			blockers: [
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
			],
		});
		expect(
			contradictoryLostEvidence.cohortAnalysis.safeWithinCohortSubsets,
		).toEqual([]);
	});

	it("projects diagnosis-derived missing lineage into the shared analyzer", () => {
		const dto = buildCacheFlightRecorderReport({
			...sealedHitTimeline,
			turns: [
				{
					...baselineTurn,
					identityFingerprint: undefined,
					seal: completeSeal,
				},
				{
					...hitTurn,
					identityFingerprint: undefined,
					cacheOutcome: "miss",
					cachedTokens: 0,
					seal: completeSeal,
				},
			],
		});

		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		expect(dto.completeness).toBe("partial");
		expect(dto.diagnosis.supportingTransitions).toContainEqual(
			expect.objectContaining({
				kind: "unavailable",
				dimension: "identity",
				fromSequence: 0,
				toSequence: 1,
			}),
		);
		expect(dto.cohortAnalysis.cohorts[0]).toMatchObject({
			sealCompleteness: "complete",
			completeness: "partial",
			eligible: false,
			blockers: [
				{
					dimension: "turn_unavailable_dimension",
					kind: "unknown",
					detail: "turn_unavailable_dimensions_present",
				},
			],
		});
		expect(dto.cohortAnalysis.safeWithinCohortSubsets).toEqual([]);
	});

	it("does not let a complete seal upgrade incomplete turn evidence or diagnosis", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{
					...hitTurn,
					identityFingerprint: "identity-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
					completeness: "partial",
					unavailableDimensions: ["token_accounting"],
					seal: completeSeal,
				},
			],
		});

		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		expect(dto.completeness).toBe("partial");
		expect(dto.cohortAnalysis.cohorts).toHaveLength(1);
		expect(dto.cohortAnalysis.cohorts[0]).toMatchObject({
			cohortId: "epoch-opaque-1:partition-opaque-1",
			observationCount: 2,
			cacheOutcomeCounts: { hit: 1, miss: 1, unknown: 0 },
			sealCompleteness: "complete",
			completeness: "partial",
			eligible: false,
			blockers: [
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
			],
		});
		expect(dto.cohortAnalysis.safeWithinCohortSubsets).toEqual([
			{
				cohortId: "epoch-opaque-1:partition-opaque-1",
				privacySafeIds: {
					serviceEpochId: "epoch-opaque-1",
					serviceEpochOccurrenceId: "occurrence-1",
					observationPartitionId: "partition-opaque-1",
				},
				observationCount: 1,
				cacheOutcomeCounts: { hit: 1, miss: 0, unknown: 0 },
				contributors: [
					{ recorderConversationId: "recorder-safe-id", sequence: 0 },
				],
			},
		]);
		const human = renderCacheFlightRecorderReport(dto);
		expect(human).toContain("Diagnosis: telemetry unknown");
		expect(human).toContain("Seal completeness: complete");
		expect(human).toContain("Turn completeness: partial");
		expect(human).toContain("Eligible: false");
		expect(human).toContain("unknown:turn_completeness:turn_partial");
		expect(human).toContain(
			[
				"Safe within-cohort subsets: 1",
				"Safe within-cohort subset: epoch-opaque-1:partition-opaque-1",
				"  Service epoch: epoch-opaque-1",
				"  Service epoch occurrence: occurrence-1",
				"  Observation partition: partition-opaque-1",
				"  Observations: 1",
				"  Cache outcomes: hit=1 miss=0 unknown=0",
				"  Contributors: recorder-safe-id#0",
			].join("\n"),
		);
	});

	it("never includes raw content, rows, or errors", () => {
		const serialized = JSON.stringify(
			buildCacheFlightRecorderReport(hitTimeline),
		);
		for (const forbidden of [
			"prompt",
			"request_body",
			"response_body",
			"rawRow",
			"error",
			"private prompt content",
		]) {
			expect(serialized).not.toContain(forbidden);
		}

		const cohortSerialized = JSON.stringify(
			buildCacheFlightRecorderReport(sealedHitTimeline).cohortAnalysis,
		);
		for (const forbidden of [
			"account-a",
			"raw-model-value",
			"raw-candidate-value",
			"prompt",
			"request_body",
			"credential",
			"cache_key",
			"host_identity",
		]) {
			expect(cohortSerialized).not.toContain(forbidden);
		}
	});
});

describe("cache flight recorder command", () => {
	it("writes exactly one JSON object to stdout", async () => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db(),
			{
				action: "report",
				recorderConversationId: "recorder-safe-id",
				json: true,
			},
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(0);
		expect(output.stdout).toHaveLength(1);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toMatchObject({
			kind: "report",
			recorderConversationId: "recorder-safe-id",
		});
		expect(output.stderr).toEqual([]);
	});

	it("recomputes cohorts after the final retained contributor is removed", async () => {
		let currentTimeline: CacheFlightRecorderTimeline = {
			...hitTimeline,
			turns: [
				{ ...baselineTurn, seal: completeSeal },
				{ ...hitTurn, seal: null },
			],
		};
		const mutableDb = db({
			lookupCacheFlightRecorderTimeline: async () => ({
				status: "found" as const,
				timeline: currentTimeline,
			}),
		});
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
			json: true,
		};
		const before = capture();

		expect(
			(
				await runCacheFlightRecorderCommand(
					mutableDb,
					command,
					{ enabled: true, retentionHours: 72 },
					before.io,
				)
			).exitCode,
		).toBe(0);
		expect(
			JSON.parse(before.stdout.at(0) ?? "").cohortAnalysis.cohorts.map(
				(cohort: { cohortId: string }) => cohort.cohortId,
			),
		).toEqual(["epoch-opaque-1:partition-opaque-1"]);

		currentTimeline = {
			...currentTimeline,
			turns: [{ ...hitTurn, seal: null }],
		};
		const after = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					mutableDb,
					command,
					{ enabled: true, retentionHours: 72 },
					after.io,
				)
			).exitCode,
		).toBe(0);
		const refreshed = JSON.parse(after.stdout.at(0) ?? "");
		expect(refreshed.cohortAnalysis.cohorts).toEqual([]);
		expect(refreshed.cohortAnalysis.safeWithinCohortSubsets).toEqual([]);
		expect(refreshed.cohortAnalysis.descriptiveCounts).toEqual({
			observations: 1,
			sealed: 0,
			unsealed: 1,
			hit: 1,
			miss: 0,
			unknown: 0,
		});
		expect(refreshed.cohortAnalysis.unsealed.contributors).toEqual([
			{ recorderConversationId: "recorder-safe-id", sequence: 1 },
		]);
		expect(after.stdout.at(0)).not.toContain(
			"epoch-opaque-1:partition-opaque-1",
		);

		const human = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					mutableDb,
					{ ...command, json: false },
					{ enabled: true, retentionHours: 72 },
					human.io,
				)
			).exitCode,
		).toBe(0);
		expect(human.stdout.at(0)).not.toContain(
			"epoch-opaque-1:partition-opaque-1",
		);
		expect(human.stdout.at(0)).toContain("Cohorts: 0");
		expect(human.stdout.at(0)).toContain(
			"Unsealed contributors: recorder-safe-id#1",
		);
	});

	it.each([
		["expired", "expired"],
		["not_found", "not found"],
	] as const)("distinguishes %s lookup", async (status, diagnostic) => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db({ lookupCacheFlightRecorderTimeline: async () => ({ status }) }),
			{
				action: "report",
				recorderConversationId: "recorder-safe-id",
				json: true,
			},
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(2);
		expect(output.stdout).toHaveLength(1);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toEqual({
			kind: "error",
			status,
			recorderConversationId: "recorder-safe-id",
		});
		expect(output.stderr.join("\n")).toContain(diagnostic);

		const human = capture();
		const humanResult = await runCacheFlightRecorderCommand(
			db({ lookupCacheFlightRecorderTimeline: async () => ({ status }) }),
			{
				action: "report",
				recorderConversationId: "recorder-safe-id",
				json: false,
			},
			{ enabled: true, retentionHours: 72 },
			human.io,
		);
		expect(humanResult.exitCode).toBe(2);
		expect(human.stdout).toEqual([]);
		expect(human.stderr.join("\n")).toContain(diagnostic);
	});

	it.each([
		[
			{
				retained: 4,
				dropped: 0,
				incomplete: 0,
				sealed: 7,
				unsealed: 2,
				incompleteSeal: 0,
			},
			"healthy",
		],
		[
			{
				retained: 4,
				dropped: 0,
				incomplete: 0,
				sealed: 5,
				unsealed: 1,
				incompleteSeal: 3,
			},
			"degraded",
		],
		[
			{
				retained: 4,
				dropped: 0,
				incomplete: 1,
				sealed: 8,
				unsealed: 0,
				incompleteSeal: 0,
			},
			"degraded",
		],
		[
			{
				retained: 4,
				dropped: 0,
				incomplete: 1,
				sealed: 5,
				unsealed: 1,
				incompleteSeal: 3,
			},
			"degraded",
		],
		[
			{
				retained: 4,
				dropped: 2,
				incomplete: 1,
				sealed: 5,
				unsealed: 1,
				incompleteSeal: 3,
			},
			"unhealthy",
		],
	] as const)("projects conversation and seal-turn health for %j", async (counts, persistenceHealth) => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db({ getCacheFlightRecorderCounts: async () => counts }),
			{ action: "health", json: true },
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toEqual({
			kind: "health",
			enabled: true,
			retentionHours: 72,
			retainedCount: counts.retained,
			droppedCount: counts.dropped,
			incompleteCount: counts.incomplete,
			sealedTurnCount: counts.sealed,
			unsealedTurnCount: counts.unsealed,
			incompleteSealTurnCount: counts.incompleteSeal,
			persistenceHealth,
		});
		expect(output.stdout[0]).not.toContain("causeRate");

		const human = capture();
		const humanResult = await runCacheFlightRecorderCommand(
			db({ getCacheFlightRecorderCounts: async () => counts }),
			{ action: "health", json: false },
			{ enabled: true, retentionHours: 72 },
			human.io,
		);
		expect(humanResult.exitCode).toBe(0);
		expect(human.stdout.at(0)).toContain(`Retained: ${counts.retained}`);
		expect(human.stdout.at(0)).toContain(`Sealed turns: ${counts.sealed}`);
		expect(human.stdout.at(0)).toContain(`Unsealed turns: ${counts.unsealed}`);
		expect(human.stdout.at(0)).toContain(
			`Incomplete-seal turns: ${counts.incompleteSeal}`,
		);
		expect(human.stdout.at(0)).toContain(`Persistence: ${persistenceHealth}`);
	});

	it("uses explicit nonzero exits for invalid args and DB failures", async () => {
		const invalid = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{
						action: "report",
						recorderConversationId: "not safe!",
						json: false,
					},
					{ enabled: true, retentionHours: 72 },
					invalid.io,
				)
			).exitCode,
		).toBe(2);
		expect(invalid.stderr.join("\n")).toContain("Invalid recorder ID");

		const invalidJson = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{
						action: "report",
						recorderConversationId: "not safe!",
						json: true,
					},
					{ enabled: true, retentionHours: 72 },
					invalidJson.io,
				)
			).exitCode,
		).toBe(2);
		expect(invalidJson.stdout).toEqual([
			JSON.stringify({ kind: "error", status: "invalid_args" }),
		]);
		expect(invalidJson.stderr).toEqual(["Invalid recorder ID"]);

		const failed = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					db({
						lookupCacheFlightRecorderTimeline: async () => {
							throw new Error("database contains private details");
						},
					}),
					{
						action: "report",
						recorderConversationId: "recorder-safe-id",
						json: true,
					},
					{ enabled: true, retentionHours: 72 },
					failed.io,
				)
			).exitCode,
		).toBe(1);
		expect(failed.stdout).toEqual([
			JSON.stringify({ kind: "error", status: "operational_failure" }),
		]);
		expect(failed.stderr).toEqual(["Cache flight recorder operation failed"]);
	});
});
