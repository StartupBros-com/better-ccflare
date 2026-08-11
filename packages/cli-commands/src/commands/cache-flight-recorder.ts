import {
	analyzeCacheFlightCohorts,
	type CacheFlightCohortAnalysisResult,
	type CacheFlightCohortBlocker,
	type CacheFlightCohortBlockerScope,
	type CacheFlightCohortContributor,
	type CacheFlightCohortOutcomeCounts,
	type CacheFlightVisibleSealDimension,
	type DiagnosisEvidence,
	diagnoseTimeline,
	reconcileTurnTokens,
} from "@better-ccflare/core";
import type {
	CacheFlightRecorderCounts,
	CacheFlightRecorderTimeline,
} from "@better-ccflare/database";

export type CacheFlightRecorderExitCode = 0 | 1 | 2;

export interface CacheFlightRecorderReportDto {
	kind: "report";
	recorderConversationId: string;
	baseline: CacheFlightRecorderTurnDto | null;
	turns: CacheFlightRecorderTurnDto[];
	diagnosis: {
		cause: ReturnType<typeof diagnoseTimeline>["cause"];
		diagnosedSequence: number | null;
		supportingTransitions: DiagnosisEvidence[];
		continuityProof: DiagnosisEvidence[];
	};
	gaps: string[];
	unavailableDimensions: string[];
	completeness: ReturnType<typeof diagnoseTimeline>["completeness"];
	droppedEvidence: number;
	cohortAnalysis: CacheFlightCohortAnalysisResult;
}

export interface CacheFlightRecorderTurnDto {
	sequence: number;
	timestamp: string;
	identityFingerprint?: string;
	servingAccountId?: string;
	prefixFingerprint?: string;
	cacheOutcome: "hit" | "miss" | "unknown";
	tokens: { input: number | null; cached: number | null };
	routing: { servingAccountId: string | null };
	completeness: "complete" | "partial" | "incomplete" | "contradictory";
	unavailableDimensions: string[];
	gapBefore: boolean;
}

export interface CacheFlightRecorderHealthDto {
	kind: "health";
	enabled: boolean;
	retentionHours: number;
	retainedCount: number;
	droppedCount: number;
	incompleteCount: number;
	sealedTurnCount: number;
	unsealedTurnCount: number;
	incompleteSealTurnCount: number;
	persistenceHealth: "healthy" | "degraded" | "unhealthy";
}

export interface CacheFlightRecorderCommandDatabase {
	lookupCacheFlightRecorderTimeline(
		id: string,
	): Promise<
		| { status: "found"; timeline: CacheFlightRecorderTimeline }
		| { status: "expired" | "not_found" }
	>;
	getCacheFlightRecorderCounts(): Promise<
		{ retained: number } & CacheFlightRecorderCounts
	>;
}

export type CacheFlightRecorderCommandOptions =
	| { action: "report"; recorderConversationId: string; json: boolean }
	| { action: "health"; json: boolean };

const SAFE_RECORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidCacheFlightRecorderId(value: unknown): value is string {
	return typeof value === "string" && SAFE_RECORDER_ID.test(value);
}

export function cacheFlightRecorderError(status: string): string {
	return JSON.stringify({ kind: "error", status });
}
const causeLabels: Record<
	NonNullable<CacheFlightRecorderReportDto["diagnosis"]["cause"]>,
	string
> = {
	identity_changed: "identity changed",
	serving_account_changed: "serving account changed",
	cacheable_prefix_changed: "cacheable prefix changed",
	upstream_miss_despite_stable_lineage:
		"upstream miss despite stable observed lineage",
	telemetry_unknown: "telemetry unknown",
};

const LINEAGE_DIAGNOSIS_DIMENSIONS: ReadonlySet<
	DiagnosisEvidence["dimension"]
> = new Set(["identity", "serving_account", "cacheable_prefix"]);

function projectDerivedGapEvidence(gaps: readonly string[]): {
	affectedSequences: ReadonlySet<number>;
	hasUnlocatedGap: boolean;
} {
	const affectedSequences = new Set<number>();
	let hasUnlocatedGap = false;
	for (const gap of gaps) {
		if (/^gap_before_turn_\d+$/.test(gap)) continue;
		const missing = /^missing_turns_\d+_to_(\d+)$/.exec(gap);
		if (missing) {
			affectedSequences.add(Number(missing[1]) + 1);
			continue;
		}
		const duplicate = /^duplicate_turn_(\d+)$/.exec(gap);
		if (duplicate) {
			affectedSequences.add(Number(duplicate[1]));
			continue;
		}
		hasUnlocatedGap = true;
	}
	return { affectedSequences, hasUnlocatedGap };
}

function projectDiagnosisUnavailableDimensions(
	evidence: readonly DiagnosisEvidence[],
): ReadonlyMap<number, ReadonlySet<string>> {
	const bySequence = new Map<number, Set<string>>();
	const add = (sequence: number, dimension: string) => {
		const dimensions = bySequence.get(sequence) ?? new Set<string>();
		dimensions.add(dimension);
		bySequence.set(sequence, dimensions);
	};
	for (const item of evidence) {
		if (
			item.kind !== "unavailable" ||
			!LINEAGE_DIAGNOSIS_DIMENSIONS.has(item.dimension)
		) {
			continue;
		}
		if (item.fromSequence !== undefined && item.fromValue === undefined) {
			add(item.fromSequence, item.dimension);
		}
		if (item.toValue === undefined) add(item.toSequence, item.dimension);
	}
	return bySequence;
}

function toTurn(
	turn: CacheFlightRecorderTimeline["turns"][number],
): CacheFlightRecorderTurnDto {
	return {
		sequence: turn.sequence,
		timestamp: turn.timestamp,
		...(turn.identityFingerprint === undefined
			? {}
			: { identityFingerprint: turn.identityFingerprint }),
		...(turn.servingAccountId === undefined
			? {}
			: { servingAccountId: turn.servingAccountId }),
		...(turn.prefixFingerprint === undefined
			? {}
			: { prefixFingerprint: turn.prefixFingerprint }),
		cacheOutcome: turn.cacheOutcome,
		tokens: {
			input: turn.inputTokens ?? null,
			cached: turn.cachedTokens ?? null,
		},
		routing: { servingAccountId: turn.servingAccountId ?? null },
		completeness: turn.completeness,
		unavailableDimensions: [...turn.unavailableDimensions],
		gapBefore: turn.gapBefore === true,
	};
}

export function buildCacheFlightRecorderReport(
	timeline: CacheFlightRecorderTimeline,
): CacheFlightRecorderReportDto {
	const diagnosis = diagnoseTimeline(timeline);
	// A timeline that lost evidence cannot support a confident cause: the
	// missing turns could contain the real continuity break, so any strong
	// diagnosis degrades to telemetry unknown rather than guessing.
	const evidenceLost =
		timeline.incomplete && diagnosis.completeness !== "contradictory";
	const gapProjection = projectDerivedGapEvidence(diagnosis.gaps);
	const diagnosisUnavailableDimensions = projectDiagnosisUnavailableDimensions(
		diagnosis.supportingEvidence,
	);
	const selectionIntegrityIncomplete =
		timeline.incomplete || gapProjection.hasUnlocatedGap;
	const cohortAnalysis = analyzeCacheFlightCohorts(
		timeline.turns.map((turn) => {
			const reconciledCompleteness = reconcileTurnTokens(turn);
			const projectedUnavailableDimensions = diagnosisUnavailableDimensions.get(
				turn.sequence,
			);
			return {
				recorderConversationId: timeline.recorderConversationId,
				sequence: turn.sequence,
				timestamp: turn.timestamp,
				cacheOutcome: turn.cacheOutcome,
				completeness:
					selectionIntegrityIncomplete &&
					reconciledCompleteness !== "contradictory"
						? "incomplete"
						: reconciledCompleteness,
				unavailableDimensions: projectedUnavailableDimensions
					? [
							...new Set([
								...turn.unavailableDimensions,
								...projectedUnavailableDimensions,
							]),
						]
					: turn.unavailableDimensions,
				gapBefore:
					turn.gapBefore === true ||
					gapProjection.affectedSequences.has(turn.sequence),
				seal: turn.seal,
			};
		}),
	);
	const turns = [...timeline.turns]
		.sort((a, b) => a.sequence - b.sequence)
		.map(toTurn);
	const cause = evidenceLost ? "telemetry_unknown" : diagnosis.cause;
	return {
		kind: "report",
		recorderConversationId: timeline.recorderConversationId,
		baseline:
			turns.find((turn) => turn.sequence === diagnosis.baselineSequence) ??
			null,
		turns,
		diagnosis: {
			cause,
			diagnosedSequence: diagnosis.diagnosedSequence,
			supportingTransitions: diagnosis.supportingEvidence,
			continuityProof: diagnosis.continuityProof,
		},
		gaps: diagnosis.gaps,
		unavailableDimensions: diagnosis.unavailableDimensions,
		completeness: evidenceLost ? "incomplete" : diagnosis.completeness,
		droppedEvidence: timeline.droppedEvents,
		cohortAnalysis,
	};
}

function formatOutcomeCounts(counts: CacheFlightCohortOutcomeCounts): string {
	return `hit=${counts.hit} miss=${counts.miss} unknown=${counts.unknown}`;
}

function formatContributors(
	contributors: readonly CacheFlightCohortContributor[],
): string {
	return (
		contributors
			.map(
				(contributor) =>
					`${contributor.recorderConversationId}#${contributor.sequence}`,
			)
			.join(", ") || "none"
	);
}

const BLOCKER_SCOPE_LABELS: Record<CacheFlightCohortBlockerScope, string> = {
	within_service_instance: "within one service instance",
	cross_service_instance: "across service instances",
};

function formatCohortBlockers(
	blockers: readonly CacheFlightCohortBlocker[],
): string {
	return (
		blockers
			.map((blocker) => {
				const base = `${blocker.kind}:${blocker.dimension}:${blocker.detail}`;
				// The default kind:dimension:detail triple already names the
				// dimension and a machine detail, but "not_comparable" needs an
				// explicit human explanation: the pseudonyms for this dimension
				// rotate per process, so a cross-restart comparison of
				// account/route identity is impossible - not that it is known to
				// differ (that would be "changed") and not that it is missing
				// (that would be "unknown").
				const notComparableSuffix =
					blocker.kind === "not_comparable"
						? " (pseudonym rotates per process restart; not comparable across a restart, not known to differ)"
						: "";
				// A "changed" and a "not_comparable" blocker can legitimately
				// co-occur for the SAME dimension when observations span more than
				// one service instance: a genuine difference among summaries
				// sharing one instance, alongside a withheld cross-instance
				// comparison. Left unscoped that pair reads as a flat
				// contradiction ("known to differ" beside "not known to differ").
				// Tagging each blocker's scope makes clear they describe two
				// different, non-contradictory comparisons.
				const scopeSuffix =
					(blocker.kind === "changed" || blocker.kind === "not_comparable") &&
					blocker.scope
						? ` [scope: ${BLOCKER_SCOPE_LABELS[blocker.scope]}]`
						: "";
				return `${base}${notComparableSuffix}${scopeSuffix}`;
			})
			.join(", ") || "none"
	);
}

function formatVisibleSealDimension(
	dimension: CacheFlightVisibleSealDimension,
): string {
	if (dimension.state === "unknown" || dimension.value === undefined) {
		return `${dimension.dimension}=unknown`;
	}
	const value =
		typeof dimension.value === "object"
			? JSON.stringify(dimension.value)
			: String(dimension.value);
	return `${dimension.dimension}=known:${value}`;
}

export function renderCacheFlightRecorderReport(
	report: CacheFlightRecorderReportDto,
): string {
	const diagnosis = report.diagnosis.cause
		? causeLabels[report.diagnosis.cause]
		: "no continuity break observed";
	const formatEvidence = (item: DiagnosisEvidence) =>
		`kind=${item.kind} dimension=${item.dimension} fromSequence=${item.fromSequence ?? "unavailable"} toSequence=${item.toSequence} fromValue=${item.fromValue ?? "unavailable"} toValue=${item.toValue ?? "unavailable"} detail=${item.detail}`;
	const lines = [
		`Cache flight recorder: ${report.recorderConversationId}`,
		`Diagnosis: ${diagnosis}`,
		`Diagnosed sequence: ${report.diagnosis.diagnosedSequence ?? "unavailable"}`,
		`Completeness: ${report.completeness}`,
		`Baseline: ${report.baseline?.sequence ?? "unavailable"}`,
		`Dropped evidence: ${report.droppedEvidence}`,
		"Turns:",
	];
	for (const turn of report.turns) {
		lines.push(
			`  ${turn.sequence}: cache=${turn.cacheOutcome} input=${turn.tokens.input ?? "unavailable"} cached=${turn.tokens.cached ?? "unavailable"} route=${turn.routing.servingAccountId ?? "unavailable"} identity=${turn.identityFingerprint ?? "unavailable"} prefix=${turn.prefixFingerprint ?? "unavailable"} completeness=${turn.completeness} unavailable=${turn.unavailableDimensions.join("|") || "none"} gapBefore=${turn.gapBefore}`,
		);
	}
	lines.push(
		`Supporting transitions: ${report.diagnosis.supportingTransitions.map(formatEvidence).join(", ") || "none"}`,
	);
	lines.push(
		`Continuity proof: ${report.diagnosis.continuityProof.map(formatEvidence).join(", ") || "none"}`,
	);
	lines.push(`Gaps: ${report.gaps.join(", ") || "none"}`);
	lines.push(
		`Unavailable dimensions: ${report.unavailableDimensions.join(", ") || "none"}`,
	);
	const analysis = report.cohortAnalysis;
	lines.push("Cohort analysis:");
	lines.push(
		`Descriptive counts: observations=${analysis.descriptiveCounts.observations} sealed=${analysis.descriptiveCounts.sealed} unsealed=${analysis.descriptiveCounts.unsealed} hit=${analysis.descriptiveCounts.hit} miss=${analysis.descriptiveCounts.miss} unknown=${analysis.descriptiveCounts.unknown}`,
	);
	lines.push(`Cohorts: ${analysis.cohorts.length}`);
	for (const cohort of analysis.cohorts) {
		lines.push(`Cohort: ${cohort.cohortId}`);
		lines.push(`  Service epoch: ${cohort.privacySafeIds.serviceEpochId}`);
		lines.push(
			`  Service epoch occurrence: ${cohort.privacySafeIds.serviceEpochOccurrenceId ?? "unknown"}`,
		);
		lines.push(
			`  Observation partition: ${cohort.privacySafeIds.observationPartitionId}`,
		);
		lines.push(`  First observed: ${cohort.firstObservedAt}`);
		lines.push(`  Last observed: ${cohort.lastObservedAt}`);
		lines.push(`  Observations: ${cohort.observationCount}`);
		lines.push(
			`  Cache outcomes: ${formatOutcomeCounts(cohort.cacheOutcomeCounts)}`,
		);
		lines.push(`  Seal completeness: ${cohort.sealCompleteness}`);
		lines.push(`  Turn completeness: ${cohort.completeness}`);
		lines.push(`  Eligible: ${cohort.eligible}`);
		lines.push(
			`  Visible seal dimensions: ${cohort.visibleSealDimensions.map(formatVisibleSealDimension).join(", ") || "none"}`,
		);
		lines.push(`  Blockers: ${formatCohortBlockers(cohort.blockers)}`);
		lines.push(`  Contributors: ${formatContributors(cohort.contributors)}`);
	}
	lines.push(
		`Unsealed observations: ${analysis.unsealed.observationCount}`,
		`Unsealed cache outcomes: ${formatOutcomeCounts(analysis.unsealed.cacheOutcomeCounts)}`,
		`Unsealed contributors: ${formatContributors(analysis.unsealed.contributors)}`,
	);
	lines.push(
		`Safe within-cohort subsets: ${analysis.safeWithinCohortSubsets.length}`,
	);
	for (const subset of analysis.safeWithinCohortSubsets) {
		lines.push(`Safe within-cohort subset: ${subset.cohortId}`);
		lines.push(`  Service epoch: ${subset.privacySafeIds.serviceEpochId}`);
		lines.push(
			`  Service epoch occurrence: ${subset.privacySafeIds.serviceEpochOccurrenceId ?? "unknown"}`,
		);
		lines.push(
			`  Observation partition: ${subset.privacySafeIds.observationPartitionId}`,
		);
		lines.push(`  Observations: ${subset.observationCount}`);
		lines.push(
			`  Cache outcomes: ${formatOutcomeCounts(subset.cacheOutcomeCounts)}`,
		);
		lines.push(`  Contributors: ${formatContributors(subset.contributors)}`);
	}
	lines.push(`Cohort blockers: ${formatCohortBlockers(analysis.blockers)}`);
	lines.push(`Cross-cohort metric: ${analysis.crossCohortMetric}`);
	lines.push(
		`Cache policy recommendation: ${analysis.cachePolicyRecommendation}`,
	);
	return lines.join("\n");
}

export async function runCacheFlightRecorderCommand(
	db: CacheFlightRecorderCommandDatabase,
	options: CacheFlightRecorderCommandOptions,
	healthConfig: { enabled: boolean; retentionHours: number },
	io: { stdout(value: string): void; stderr(value: string): void } = {
		stdout: console.log,
		stderr: console.error,
	},
): Promise<{ exitCode: CacheFlightRecorderExitCode }> {
	try {
		if (options.action === "health") {
			const counts = await db.getCacheFlightRecorderCounts();
			const health: CacheFlightRecorderHealthDto = {
				kind: "health",
				enabled: healthConfig.enabled,
				retentionHours: healthConfig.retentionHours,
				retainedCount: counts.retained,
				droppedCount: counts.dropped,
				incompleteCount: counts.incomplete,
				sealedTurnCount: counts.sealed,
				unsealedTurnCount: counts.unsealed,
				incompleteSealTurnCount: counts.incompleteSeal,
				persistenceHealth:
					counts.dropped > 0
						? "unhealthy"
						: counts.incomplete > 0 || counts.incompleteSeal > 0
							? "degraded"
							: "healthy",
			};
			io.stdout(options.json ? JSON.stringify(health) : renderHealth(health));
			return { exitCode: 0 };
		}
		if (!isValidCacheFlightRecorderId(options.recorderConversationId)) {
			io.stderr("Invalid recorder ID");
			if (options.json) io.stdout(cacheFlightRecorderError("invalid_args"));
			return { exitCode: 2 };
		}
		const lookup = await db.lookupCacheFlightRecorderTimeline(
			options.recorderConversationId,
		);
		if (lookup.status !== "found") {
			io.stderr(
				lookup.status === "expired"
					? "Recorder timeline expired"
					: "Recorder timeline not found",
			);
			if (options.json)
				io.stdout(
					JSON.stringify({
						kind: "error",
						status: lookup.status,
						recorderConversationId: options.recorderConversationId,
					}),
				);
			return { exitCode: 2 };
		}
		const report = buildCacheFlightRecorderReport(lookup.timeline);
		io.stdout(
			options.json
				? JSON.stringify(report)
				: renderCacheFlightRecorderReport(report),
		);
		return { exitCode: 0 };
	} catch {
		io.stderr("Cache flight recorder operation failed");
		if (options.json)
			io.stdout(cacheFlightRecorderError("operational_failure"));
		return { exitCode: 1 };
	}
}

function renderHealth(health: CacheFlightRecorderHealthDto): string {
	return [
		"Cache flight recorder health",
		`Enabled: ${health.enabled}`,
		`Retention: ${health.retentionHours} hours`,
		`Retained: ${health.retainedCount}`,
		`Dropped: ${health.droppedCount}`,
		`Incomplete: ${health.incompleteCount}`,
		`Sealed turns: ${health.sealedTurnCount}`,
		`Unsealed turns: ${health.unsealedTurnCount}`,
		`Incomplete-seal turns: ${health.incompleteSealTurnCount}`,
		`Persistence: ${health.persistenceHealth}`,
	].join("\n");
}
