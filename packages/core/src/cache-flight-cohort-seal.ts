import type { CacheOutcome, Completeness } from "./cache-flight-recorder";

export type CacheFlightSealCompleteness = "complete" | "incomplete";

export type CacheFlightNativeCacheState = "enabled" | "disabled";

export type CacheFlightRecorderState = "enabled" | "disabled";

export interface CacheFlightKeepalivePolicySnapshot {
	readonly globalTtlMinutes: number | null;
	readonly xaiTtlMinutes: number | null;
	readonly effectiveXaiEnabled: boolean;
	readonly effectiveXaiTtlMinutes: number | null;
}

export type CacheFlightSealDimension =
	| "seal_contract_version"
	| "deployment_revision"
	| "service_instance"
	| "process_started_at"
	| "native_cache_state"
	| "recorder_state"
	| "keepalive_policy"
	| "service_epoch_occurrence"
	| "serving_account_scope"
	| "route_model_epoch"
	| "seal_receipt";

export type CacheFlightCohortBlockerDimension =
	| CacheFlightSealDimension
	| "turn_completeness"
	| "turn_unavailable_dimension"
	| "turn_gap"
	| "historical_unsealed";

export type CacheFlightCohortBlockerKind =
	| "changed"
	| "unknown"
	| "not_comparable";

/**
 * Disambiguates a `changed` or `not_comparable` blocker when both can appear
 * for the same dimension at once: observations spanning more than one
 * service instance can show a genuine difference among summaries that share
 * one instance (`within_service_instance`, always paired with `changed`)
 * alongside a withheld cross-instance comparison for the same dimension
 * (`cross_service_instance`, always paired with `not_comparable`). Without
 * this field the two blockers render as a flat contradiction - "known to
 * differ" next to "not known to differ" - even though each is true within
 * its own comparison. Omitted (undefined) when a blocker has no comparison
 * boundary to disambiguate against, e.g. an ordinary `changed` blocker for a
 * service-lifetime dimension, or a partition-dimension `changed`/
 * `not_comparable` blocker when every summary shares one service instance.
 */
export type CacheFlightCohortBlockerScope =
	| "within_service_instance"
	| "cross_service_instance";

export interface CacheFlightServiceEpoch {
	readonly id: string;
	readonly occurrenceId: string | null;
	readonly sealContractVersion: number | null;
	readonly deploymentRevision: string | null;
	readonly serviceInstanceId: string | null;
	readonly processStartedAt: string | null;
	readonly nativeCacheState: CacheFlightNativeCacheState | null;
	readonly recorderState: CacheFlightRecorderState | null;
	readonly keepalivePolicy: CacheFlightKeepalivePolicySnapshot | null;
	readonly completeness: CacheFlightSealCompleteness;
	readonly unavailableDimensions: readonly CacheFlightSealDimension[];
}

export interface CacheFlightObservationPartition {
	readonly id: string;
	readonly serviceEpochId: string;
	readonly servingAccountScope: string | null;
	readonly routeModelEpoch: string | null;
	readonly completeness: CacheFlightSealCompleteness;
	readonly unavailableDimensions: readonly CacheFlightSealDimension[];
}

export interface CacheFlightCohortSealReceipt {
	readonly serviceEpoch: CacheFlightServiceEpoch;
	readonly observationPartition: CacheFlightObservationPartition;
	readonly completeness: CacheFlightSealCompleteness;
	readonly unavailableDimensions: readonly CacheFlightSealDimension[];
}

export interface CacheFlightPersistedSeal
	extends CacheFlightCohortSealReceipt {}

export interface CacheFlightCohortObservation {
	readonly recorderConversationId: string;
	readonly sequence: number;
	readonly timestamp: string;
	readonly cacheOutcome: CacheOutcome;
	readonly completeness: Completeness;
	readonly unavailableDimensions: readonly string[];
	readonly gapBefore?: boolean;
	readonly seal: CacheFlightPersistedSeal | null;
	readonly retained?: boolean;
}

export interface CacheFlightCohortContributor {
	readonly recorderConversationId: string;
	readonly sequence: number;
}

export interface CacheFlightCohortOutcomeCounts {
	readonly hit: number;
	readonly miss: number;
	readonly unknown: number;
}

export interface CacheFlightDescriptiveCounts
	extends CacheFlightCohortOutcomeCounts {
	readonly observations: number;
	readonly sealed: number;
	readonly unsealed: number;
}

export type CacheFlightSealDimensionValue =
	| string
	| number
	| boolean
	| CacheFlightKeepalivePolicySnapshot
	| CacheFlightSealCompleteness;

export interface CacheFlightVisibleSealDimension {
	readonly dimension: CacheFlightSealDimension;
	readonly state: "known" | "unknown";
	readonly value?: CacheFlightSealDimensionValue;
}

export type CacheFlightCohortBlocker =
	| {
			readonly dimension: CacheFlightSealDimension;
			readonly kind: "changed";
			readonly detail: string;
			readonly scope?: CacheFlightCohortBlockerScope;
	  }
	| {
			readonly dimension: CacheFlightSealDimension;
			readonly kind: "not_comparable";
			readonly detail: string;
			readonly scope?: CacheFlightCohortBlockerScope;
	  }
	| {
			readonly dimension: CacheFlightCohortBlockerDimension;
			readonly kind: "unknown";
			readonly detail: string;
	  };

export interface CacheFlightCohortPrivacySafeIds {
	readonly serviceEpochId: string;
	readonly serviceEpochOccurrenceId: string | null;
	readonly observationPartitionId: string;
}

export interface CacheFlightCohortSummary {
	readonly cohortId: string;
	readonly privacySafeIds: CacheFlightCohortPrivacySafeIds;
	readonly firstObservedAt: string;
	readonly lastObservedAt: string;
	readonly visibleSealDimensions: readonly CacheFlightVisibleSealDimension[];
	readonly observationCount: number;
	readonly cacheOutcomeCounts: CacheFlightCohortOutcomeCounts;
	readonly sealCompleteness: CacheFlightSealCompleteness;
	readonly completeness: Completeness;
	readonly eligible: boolean;
	readonly blockers: readonly CacheFlightCohortBlocker[];
	readonly contributors: readonly CacheFlightCohortContributor[];
}

export interface CacheFlightUnsealedSummary {
	readonly observationCount: number;
	readonly cacheOutcomeCounts: CacheFlightCohortOutcomeCounts;
	readonly contributors: readonly CacheFlightCohortContributor[];
}

export interface CacheFlightSafeWithinCohortSubset {
	readonly cohortId: string;
	readonly privacySafeIds: CacheFlightCohortPrivacySafeIds;
	readonly observationCount: number;
	readonly cacheOutcomeCounts: CacheFlightCohortOutcomeCounts;
	readonly contributors: readonly CacheFlightCohortContributor[];
}

export interface CacheFlightCohortAnalysisResult {
	readonly cohorts: readonly CacheFlightCohortSummary[];
	readonly safeWithinCohortSubsets: readonly CacheFlightSafeWithinCohortSubset[];
	readonly unsealed: CacheFlightUnsealedSummary;
	readonly descriptiveCounts: CacheFlightDescriptiveCounts;
	readonly blockers: readonly CacheFlightCohortBlocker[];
	readonly crossCohortMetric: null;
	readonly cachePolicyRecommendation: null;
}

type DimensionSnapshot = {
	readonly state: "known" | "unknown";
	readonly value?: CacheFlightSealDimensionValue;
	readonly comparable?: string;
};

type CohortGroup = {
	readonly seal: CacheFlightPersistedSeal;
	readonly observations: CacheFlightCohortObservation[];
};

/**
 * Canonical seal-dimension order. `packages/proxy/src/cache-flight-cohort-seal.ts`
 * (capture time) and `packages/database/src/repositories/cache-flight-recorder.repository.ts`
 * (write-time validation) each keep an independent literal copy of the
 * service/partition slices of this order for reasons documented at their
 * call sites (the database validator must not trust the receipt it is
 * checking). This export exists so tests in those packages can assert their
 * local copies deep-equal this canonical order instead of silently drifting
 * from it. Do not import this export into either package's production code —
 * only into their tests.
 */
export const SEAL_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
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
];

export const SERVICE_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"seal_contract_version",
	"deployment_revision",
	"service_instance",
	"process_started_at",
	"native_cache_state",
	"recorder_state",
	"keepalive_policy",
	"service_epoch_occurrence",
];

export const PARTITION_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"serving_account_scope",
	"route_model_epoch",
];

const COHORT_SELECTION_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	...SERVICE_DIMENSION_ORDER,
	...PARTITION_DIMENSION_ORDER,
];

const completenessRank: Record<Completeness, number> = {
	complete: 0,
	partial: 1,
	incomplete: 2,
	contradictory: 3,
};

function lessComplete(left: Completeness, right: Completeness): Completeness {
	return completenessRank[left] >= completenessRank[right] ? left : right;
}

function countOutcome(
	counts: { hit: number; miss: number; unknown: number },
	outcome: CacheOutcome,
): void {
	counts[outcome] += 1;
}

function contributorOf(
	observation: CacheFlightCohortObservation,
): CacheFlightCohortContributor {
	return {
		recorderConversationId: observation.recorderConversationId,
		sequence: observation.sequence,
	};
}

function compareObservations(
	left: CacheFlightCohortObservation,
	right: CacheFlightCohortObservation,
): number {
	const leftMs = Date.parse(left.timestamp);
	const rightMs = Date.parse(right.timestamp);
	if (
		Number.isFinite(leftMs) &&
		Number.isFinite(rightMs) &&
		leftMs !== rightMs
	) {
		return leftMs - rightMs;
	}
	const byTimestamp = left.timestamp.localeCompare(right.timestamp);
	if (byTimestamp !== 0) return byTimestamp;
	const byConversation = left.recorderConversationId.localeCompare(
		right.recorderConversationId,
	);
	if (byConversation !== 0) return byConversation;
	return left.sequence - right.sequence;
}

function blockerKey(blocker: CacheFlightCohortBlocker): string {
	return `${blocker.dimension}\u0000${blocker.kind}\u0000${blocker.detail}`;
}

function uniqueBlockers(
	blockers: readonly CacheFlightCohortBlocker[],
): CacheFlightCohortBlocker[] {
	const seen = new Set<string>();
	const unique: CacheFlightCohortBlocker[] = [];
	for (const blocker of blockers) {
		const key = blockerKey(blocker);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(blocker);
	}
	return unique;
}

function unknownBlocker(
	dimension: CacheFlightCohortBlockerDimension,
	detail = `${dimension}_unknown`,
): CacheFlightCohortBlocker {
	return {
		dimension,
		kind: "unknown",
		detail,
	};
}

function changedBlocker(
	dimension: CacheFlightSealDimension,
	scope?: CacheFlightCohortBlockerScope,
): CacheFlightCohortBlocker {
	return {
		dimension,
		kind: "changed",
		detail: `${dimension}_changed`,
		...(scope === undefined ? {} : { scope }),
	};
}

/**
 * Distinct from both `changed` and `unknown`: the values on both sides are
 * perfectly well known, but they cannot be compared because the underlying
 * pseudonym (HMAC-derived from a per-process secret and boot nonce - see
 * `packages/proxy/src/opaque-runtime-id.ts`) rotates on every process
 * restart. Reporting `changed` here would assert that the account or
 * route/model identity differed, which is not something this data can show;
 * reporting `unknown` would misstate that the value is missing. Declining to
 * compare (this kind) asserts nothing about equivalence, which is the R7
 * posture: withhold the conclusion rather than guess it either way.
 *
 * This blocker is only ever produced for the cross-instance comparison
 * itself (its one call site guards on `crossesServiceInstances`), so its
 * `scope` is unconditionally `cross_service_instance` - see
 * `CacheFlightCohortBlockerScope`.
 */
function notComparableBlocker(
	dimension: CacheFlightSealDimension,
): CacheFlightCohortBlocker {
	return {
		dimension,
		kind: "not_comparable",
		detail: `${dimension}_not_comparable_across_restart`,
		scope: "cross_service_instance",
	};
}

function isKnownString(value: string | null | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function isKnownNumber(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function comparableKeepalivePolicy(
	policy: CacheFlightKeepalivePolicySnapshot,
): string {
	return JSON.stringify({
		effectiveXaiEnabled: policy.effectiveXaiEnabled,
		effectiveXaiTtlMinutes: policy.effectiveXaiTtlMinutes,
		globalTtlMinutes: policy.globalTtlMinutes,
		xaiTtlMinutes: policy.xaiTtlMinutes,
	});
}

function known(
	value: CacheFlightSealDimensionValue,
	comparable = String(value),
): DimensionSnapshot {
	return { state: "known", value, comparable };
}

function unknown(): DimensionSnapshot {
	return { state: "unknown" };
}

function dimensionSnapshot(
	seal: CacheFlightPersistedSeal,
	dimension: CacheFlightSealDimension,
): DimensionSnapshot {
	const { serviceEpoch, observationPartition } = seal;
	switch (dimension) {
		case "seal_contract_version":
			return isKnownNumber(serviceEpoch.sealContractVersion)
				? known(serviceEpoch.sealContractVersion)
				: unknown();
		case "deployment_revision":
			return isKnownString(serviceEpoch.deploymentRevision)
				? known(serviceEpoch.deploymentRevision)
				: unknown();
		case "service_instance":
			return isKnownString(serviceEpoch.serviceInstanceId)
				? known(serviceEpoch.serviceInstanceId)
				: unknown();
		case "process_started_at":
			return isKnownString(serviceEpoch.processStartedAt)
				? known(serviceEpoch.processStartedAt)
				: unknown();
		case "native_cache_state":
			return serviceEpoch.nativeCacheState === null
				? unknown()
				: known(serviceEpoch.nativeCacheState);
		case "recorder_state":
			return serviceEpoch.recorderState === null
				? unknown()
				: known(serviceEpoch.recorderState);
		case "keepalive_policy":
			return serviceEpoch.keepalivePolicy === null
				? unknown()
				: known(
						serviceEpoch.keepalivePolicy,
						comparableKeepalivePolicy(serviceEpoch.keepalivePolicy),
					);
		case "service_epoch_occurrence":
			return isKnownString(serviceEpoch.occurrenceId)
				? known(serviceEpoch.occurrenceId)
				: unknown();
		case "serving_account_scope":
			return isKnownString(observationPartition.servingAccountScope)
				? known(observationPartition.servingAccountScope)
				: unknown();
		case "route_model_epoch":
			return isKnownString(observationPartition.routeModelEpoch)
				? known(observationPartition.routeModelEpoch)
				: unknown();
		case "seal_receipt":
			return known(seal.completeness);
	}
}

function unavailableDimensions(
	seal: CacheFlightPersistedSeal,
): Set<CacheFlightSealDimension> {
	const dimensions = new Set<CacheFlightSealDimension>([
		...seal.unavailableDimensions,
		...seal.serviceEpoch.unavailableDimensions,
		...seal.observationPartition.unavailableDimensions,
	]);
	for (const dimension of SEAL_DIMENSION_ORDER) {
		if (dimensionSnapshot(seal, dimension).state === "unknown") {
			dimensions.add(dimension);
		}
	}
	if (seal.observationPartition.serviceEpochId !== seal.serviceEpoch.id) {
		dimensions.add("seal_receipt");
	}
	if (
		dimensions.size === 0 &&
		(seal.completeness !== "complete" ||
			seal.serviceEpoch.completeness !== "complete" ||
			seal.observationPartition.completeness !== "complete")
	) {
		dimensions.add("seal_receipt");
	}
	return dimensions;
}

function sealCompleteness(
	seals: readonly CacheFlightPersistedSeal[],
	changedBlockers: readonly CacheFlightCohortBlocker[] = [],
): CacheFlightSealCompleteness {
	if (changedBlockers.length > 0) return "incomplete";
	return seals.every(
		(seal) =>
			seal.completeness === "complete" &&
			seal.serviceEpoch.completeness === "complete" &&
			seal.observationPartition.completeness === "complete" &&
			unavailableDimensions(seal).size === 0,
	)
		? "complete"
		: "incomplete";
}

function visibleSealDimensions(
	seals: readonly CacheFlightPersistedSeal[],
	changedDimensions: ReadonlySet<CacheFlightSealDimension> = new Set(),
): CacheFlightVisibleSealDimension[] {
	const firstSeal = seals[0];
	return SEAL_DIMENSION_ORDER.map((dimension) => {
		if (
			!firstSeal ||
			changedDimensions.has(dimension) ||
			seals.some((seal) => unavailableDimensions(seal).has(dimension))
		) {
			return { dimension, state: "unknown" };
		}
		const snapshot = dimensionSnapshot(firstSeal, dimension);
		return snapshot.state === "known"
			? {
					dimension,
					state: "known",
					value: snapshot.value,
				}
			: { dimension, state: "unknown" };
	});
}

function sealBlockers(
	seals: readonly CacheFlightPersistedSeal[],
): CacheFlightCohortBlocker[] {
	const blockers: CacheFlightCohortBlocker[] = [];
	for (const seal of seals) {
		for (const dimension of SEAL_DIMENSION_ORDER) {
			if (unavailableDimensions(seal).has(dimension)) {
				blockers.push(unknownBlocker(dimension));
			}
		}
	}
	return uniqueBlockers(blockers);
}

function knownComparableSealValues(
	seals: readonly CacheFlightPersistedSeal[],
	dimension: CacheFlightSealDimension,
): Set<string> {
	const values = new Set<string>();
	for (const seal of seals) {
		if (unavailableDimensions(seal).has(dimension)) continue;
		const snapshot = dimensionSnapshot(seal, dimension);
		if (snapshot.state === "known" && snapshot.comparable !== undefined) {
			values.add(snapshot.comparable);
		}
	}
	return values;
}

function changedSealBlockers(
	seals: readonly CacheFlightPersistedSeal[],
): CacheFlightCohortBlocker[] {
	if (seals.length < 2) return [];
	const blockers: CacheFlightCohortBlocker[] = [];
	for (const dimension of COHORT_SELECTION_DIMENSION_ORDER) {
		if (knownComparableSealValues(seals, dimension).size > 1) {
			blockers.push(changedBlocker(dimension));
		}
	}
	return blockers;
}

function changedSealDimensions(
	blockers: readonly CacheFlightCohortBlocker[],
): Set<CacheFlightSealDimension> {
	const dimensions = new Set<CacheFlightSealDimension>();
	for (const blocker of blockers) {
		if (blocker.kind === "changed") dimensions.add(blocker.dimension);
	}
	return dimensions;
}

function completeness(
	observations: readonly CacheFlightCohortObservation[],
): Completeness {
	let completeness: Completeness = "complete";
	for (const observation of observations) {
		completeness = lessComplete(completeness, observation.completeness);
		if ((observation.unavailableDimensions ?? []).length > 0) {
			completeness = lessComplete(completeness, "partial");
		}
		if (observation.cacheOutcome === "unknown") {
			completeness = lessComplete(completeness, "partial");
		}
		if (observation.gapBefore === true) {
			completeness = lessComplete(completeness, "incomplete");
		}
	}
	return completeness;
}

function turnBlockers(
	observations: readonly CacheFlightCohortObservation[],
): CacheFlightCohortBlocker[] {
	const blockers: CacheFlightCohortBlocker[] = [];
	for (const observation of observations) {
		if (observation.completeness !== "complete") {
			blockers.push(
				unknownBlocker("turn_completeness", `turn_${observation.completeness}`),
			);
		}
		if ((observation.unavailableDimensions ?? []).length > 0) {
			blockers.push(
				unknownBlocker(
					"turn_unavailable_dimension",
					"turn_unavailable_dimensions_present",
				),
			);
		}
		if (observation.cacheOutcome === "unknown") {
			blockers.push(
				unknownBlocker("turn_unavailable_dimension", "cache_outcome_unknown"),
			);
		}
		if (observation.gapBefore === true) {
			blockers.push(unknownBlocker("turn_gap", "turn_gaps_present"));
		}
	}
	return uniqueBlockers(blockers);
}

function isTurnEligible(observation: CacheFlightCohortObservation): boolean {
	return (
		observation.completeness === "complete" &&
		(observation.unavailableDimensions ?? []).length === 0 &&
		observation.gapBefore !== true &&
		observation.cacheOutcome !== "unknown"
	);
}

function emptyOutcomeCounts(): { hit: number; miss: number; unknown: number } {
	return { hit: 0, miss: 0, unknown: 0 };
}

function outcomeCounts(
	observations: readonly CacheFlightCohortObservation[],
): CacheFlightCohortOutcomeCounts {
	const counts = emptyOutcomeCounts();
	for (const observation of observations)
		countOutcome(counts, observation.cacheOutcome);
	return counts;
}

function cohortId(seal: CacheFlightPersistedSeal): string {
	return `${seal.serviceEpoch.id}:${seal.observationPartition.id}`;
}

function summarizeCohort(group: CohortGroup): CacheFlightCohortSummary {
	const observations = [...group.observations].sort(compareObservations);
	const contributors = observations.map(contributorOf);
	const seals = observations
		.map((observation) => observation.seal)
		.filter((seal): seal is CacheFlightPersistedSeal => seal !== null);
	const changedBlockers = changedSealBlockers(seals);
	const changedDimensions = changedSealDimensions(changedBlockers);
	const sealState = sealCompleteness(seals, changedBlockers);
	const blockers = uniqueBlockers([
		...sealBlockers(seals),
		...changedBlockers,
		...turnBlockers(observations),
	]);
	const turnState = completeness(observations);
	return {
		cohortId: cohortId(group.seal),
		privacySafeIds: {
			serviceEpochId: group.seal.serviceEpoch.id,
			serviceEpochOccurrenceId: changedDimensions.has(
				"service_epoch_occurrence",
			)
				? null
				: group.seal.serviceEpoch.occurrenceId,
			observationPartitionId: group.seal.observationPartition.id,
		},
		firstObservedAt: observations[0]?.timestamp ?? "",
		lastObservedAt: observations[observations.length - 1]?.timestamp ?? "",
		visibleSealDimensions: visibleSealDimensions(seals, changedDimensions),
		observationCount: observations.length,
		cacheOutcomeCounts: outcomeCounts(observations),
		sealCompleteness: sealState,
		completeness: turnState,
		eligible: sealState === "complete" && blockers.length === 0,
		blockers,
		contributors,
	};
}

function summarizeUnsealed(
	observations: readonly CacheFlightCohortObservation[],
): CacheFlightUnsealedSummary {
	const ordered = [...observations].sort(compareObservations);
	return {
		observationCount: ordered.length,
		cacheOutcomeCounts: outcomeCounts(ordered),
		contributors: ordered.map(contributorOf),
	};
}

function safeSubsetForSummary(
	summary: CacheFlightCohortSummary,
	observations: readonly CacheFlightCohortObservation[],
): CacheFlightSafeWithinCohortSubset | null {
	if (summary.sealCompleteness !== "complete") return null;
	if (summary.blockers.some((blocker) => blocker.kind === "changed"))
		return null;
	const safeObservations = observations
		.filter(isTurnEligible)
		.sort(compareObservations);
	if (safeObservations.length === 0) return null;
	return {
		cohortId: summary.cohortId,
		privacySafeIds: summary.privacySafeIds,
		observationCount: safeObservations.length,
		cacheOutcomeCounts: outcomeCounts(safeObservations),
		contributors: safeObservations.map(contributorOf),
	};
}

function comparableVisibleDimension(
	visible: CacheFlightVisibleSealDimension,
): string | null {
	if (visible.state === "unknown" || visible.value === undefined) return null;
	if (visible.dimension === "keepalive_policy") {
		return typeof visible.value === "object"
			? comparableKeepalivePolicy(visible.value)
			: null;
	}
	return String(visible.value);
}

function knownComparableValues(
	summaries: readonly CacheFlightCohortSummary[],
	dimension: CacheFlightSealDimension,
): { unknown: boolean; values: Set<string> } {
	const values = new Set<string>();
	let hasUnknown = false;
	for (const summary of summaries) {
		const visible = summary.visibleSealDimensions.find(
			(item) => item.dimension === dimension,
		);
		if (!visible || visible.state === "unknown") {
			hasUnknown = true;
			continue;
		}
		const comparable = comparableVisibleDimension(visible);
		if (comparable === null) {
			hasUnknown = true;
			continue;
		}
		values.add(comparable);
	}
	return { unknown: hasUnknown, values };
}

/**
 * Groups summaries by the service instance whose partition dimensions were
 * observed. Partition pseudonyms (`serving_account_scope`,
 * `route_model_epoch`) are only meaningfully comparable within one service
 * instance's lifetime - across instances they are HMAC outputs of different
 * per-process secrets, so equal or unequal string values carry no signal.
 * A summary whose `service_instance` is itself unknown cannot be asserted
 * comparable to anything (not even another unknown), so it becomes its own
 * singleton group.
 */
function partitionComparabilityGroups(
	summaries: readonly CacheFlightCohortSummary[],
): ReadonlyMap<string, CacheFlightCohortSummary[]> {
	const groups = new Map<string, CacheFlightCohortSummary[]>();
	summaries.forEach((summary, index) => {
		const visible = summary.visibleSealDimensions.find(
			(item) => item.dimension === "service_instance",
		);
		const key =
			visible &&
			visible.state === "known" &&
			typeof visible.value === "string" &&
			visible.value.length > 0
				? `known:${visible.value}`
				: `unknown:${index}`;
		const existing = groups.get(key);
		if (existing) existing.push(summary);
		else groups.set(key, [summary]);
	});
	return groups;
}

function selectionBlockers(
	summaries: readonly CacheFlightCohortSummary[],
	unsealed: CacheFlightUnsealedSummary,
): CacheFlightCohortBlocker[] {
	const blockers: CacheFlightCohortBlocker[] = summaries.flatMap(
		(summary) => summary.blockers,
	);
	if (unsealed.observationCount > 0) {
		blockers.push(
			unknownBlocker("historical_unsealed", "historical_seal_reference_null"),
		);
	}
	if (summaries.length > 1) {
		const partitionGroups = partitionComparabilityGroups(summaries);
		const crossesServiceInstances = partitionGroups.size > 1;
		for (const dimension of COHORT_SELECTION_DIMENSION_ORDER) {
			if (
				crossesServiceInstances &&
				PARTITION_DIMENSION_ORDER.includes(dimension)
			) {
				// The pseudonyms rotate per process, so a value difference across
				// this boundary is not evidence of a real change - withhold the
				// conclusion rather than assert either "changed" or "unknown" for
				// the cross-instance comparison itself.
				blockers.push(notComparableBlocker(dimension));
				// Within a single service instance's group, the pseudonyms ARE
				// comparable, so a real difference there is still reported. This
				// "changed" blocker and the "not_comparable" blocker just pushed
				// above can both land on the same dimension - scope each one so
				// they read as two true, non-contradictory facts about different
				// comparisons rather than a flat contradiction (see
				// CacheFlightCohortBlockerScope).
				for (const group of partitionGroups.values()) {
					if (group.length < 2) continue;
					const { values } = knownComparableValues(group, dimension);
					if (values.size > 1) {
						blockers.push(changedBlocker(dimension, "within_service_instance"));
					}
				}
				const { unknown: hasUnknown } = knownComparableValues(
					summaries,
					dimension,
				);
				if (hasUnknown) blockers.push(unknownBlocker(dimension));
				continue;
			}
			const { unknown: hasUnknown, values } = knownComparableValues(
				summaries,
				dimension,
			);
			if (hasUnknown) blockers.push(unknownBlocker(dimension));
			if (values.size > 1) blockers.push(changedBlocker(dimension));
		}
	}
	return uniqueBlockers(blockers);
}

/**
 * Partition retained cache-flight observations without deriving missing seal data.
 */
export function analyzeCacheFlightCohorts(
	observations: readonly CacheFlightCohortObservation[],
): CacheFlightCohortAnalysisResult {
	const retained = observations
		.filter((observation) => observation.retained !== false)
		.sort(compareObservations);
	const groups = new Map<string, CohortGroup>();
	const unsealedObservations: CacheFlightCohortObservation[] = [];
	const descriptiveCounts = {
		observations: 0,
		sealed: 0,
		unsealed: 0,
		hit: 0,
		miss: 0,
		unknown: 0,
	};

	for (const observation of retained) {
		descriptiveCounts.observations += 1;
		countOutcome(descriptiveCounts, observation.cacheOutcome);
		if (!observation.seal) {
			descriptiveCounts.unsealed += 1;
			unsealedObservations.push(observation);
			continue;
		}
		descriptiveCounts.sealed += 1;
		const id = cohortId(observation.seal);
		const group = groups.get(id);
		if (group) {
			group.observations.push(observation);
		} else {
			groups.set(id, {
				seal: observation.seal,
				observations: [observation],
			});
		}
	}

	const cohortEntries = [...groups.values()].sort((left, right) => {
		const first = compareObservations(
			left.observations[0],
			right.observations[0],
		);
		if (first !== 0) return first;
		return cohortId(left.seal).localeCompare(cohortId(right.seal));
	});
	const cohorts = cohortEntries.map(summarizeCohort);
	const safeWithinCohortSubsets = cohortEntries
		.map((group, index) =>
			safeSubsetForSummary(cohorts[index], group.observations),
		)
		.filter(
			(subset): subset is CacheFlightSafeWithinCohortSubset => subset !== null,
		);
	const unsealed = summarizeUnsealed(unsealedObservations);

	return {
		cohorts,
		safeWithinCohortSubsets,
		unsealed,
		descriptiveCounts,
		blockers: selectionBlockers(cohorts, unsealed),
		crossCohortMetric: null,
		cachePolicyRecommendation: null,
	};
}
