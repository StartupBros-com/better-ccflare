import { type DiagnosisEvidence, diagnoseTimeline } from "@better-ccflare/core";
import type { CacheFlightRecorderTimeline } from "@better-ccflare/database";

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
	persistenceHealth: "healthy" | "degraded" | "unhealthy";
}

export interface CacheFlightRecorderCommandDatabase {
	lookupCacheFlightRecorderTimeline(
		id: string,
	): Promise<
		| { status: "found"; timeline: CacheFlightRecorderTimeline }
		| { status: "expired" | "not_found" }
	>;
	getCacheFlightRecorderCounts(): Promise<{
		retained: number;
		dropped: number;
		incomplete: number;
	}>;
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
	const turns = [...timeline.turns]
		.sort((a, b) => a.sequence - b.sequence)
		.map(toTurn);
	return {
		kind: "report",
		recorderConversationId: timeline.recorderConversationId,
		baseline:
			turns.find((turn) => turn.sequence === diagnosis.baselineSequence) ??
			null,
		turns,
		diagnosis: {
			cause: diagnosis.cause,
			diagnosedSequence: diagnosis.diagnosedSequence,
			supportingTransitions: diagnosis.supportingEvidence,
			continuityProof: diagnosis.continuityProof,
		},
		gaps: diagnosis.gaps,
		unavailableDimensions: diagnosis.unavailableDimensions,
		completeness:
			timeline.incomplete && diagnosis.completeness !== "contradictory"
				? "incomplete"
				: diagnosis.completeness,
		droppedEvidence: timeline.droppedEvents,
	};
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
				persistenceHealth:
					counts.dropped > 0
						? "unhealthy"
						: counts.incomplete > 0
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
		`Persistence: ${health.persistenceHealth}`,
	].join("\n");
}
