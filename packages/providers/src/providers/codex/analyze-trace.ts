/** Analyze Codex JSONL traces without retaining prompt content. */
import { readFileSync } from "node:fs";

interface ToolCall {
	name: string;
	arg_preview: string;
}

interface InputFingerprint {
	index: number;
	bytes: number;
	hmac: string;
}

export interface TraceRecord {
	trace_schema_version?: number;
	phase?: "request" | "response";
	ts?: string;
	request_id?: string | null;
	attempt_id?: string | null;
	attempt_ordinal?: number | null;
	attempt_cause?: string | null;
	model_in?: string | null;
	model_out?: string | null;
	account?: string | null;
	cache_key_mode?: "conversation" | "session" | null;
	cache_key_assignment?: "conversation" | "session" | null;
	cache_key_cohort_id?: string | null;
	conversation_id?: string | null;
	cache_key_assignment_source?: "canary" | "explicit_session_override" | null;
	pacing_canary?: string | null;
	pacing_cohort_id?: string | null;
	pacing_action?: string | null;
	/** Additive schema reserved for the explicit cache-breakpoint canary. */
	explicit_breakpoint_canary?: string | null;
	explicit_breakpoint_cohort_id?: string | null;
	explicit_breakpoint_action?: string | null;
	input_item_count?: number;
	input_item_total_count?: number;
	input_item_fingerprints?: InputFingerprint[];
	input_item_fingerprints_truncated?: boolean;
	approx_input_chars?: number;
	history_function_call_count?: number;
	history_empty_output_count?: number;
	nudge_count?: number;
	history_tool_use_by_name?: Record<string, number>;
	session_key_hash?: string | null;
	prompt_cache_key_set?: boolean;
	prompt_cache_key_id?: string | null;
	instructions_hmac?: string | null;
	tools_hmac?: string | null;
	new_tool_call_count?: number;
	new_subagent_spawn_count?: number;
	new_tool_use_by_name?: Record<string, number>;
	new_tool_calls?: ToolCall[];
	stop_reason?: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "error";
	usage_measurement_available?: boolean;
	cache_measurement_available?: boolean;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation_measurement_available?: boolean;
	cache_hit_pct?: number | null;
	context_utilization_pct?: number | null;
	error_type?: string;
	error_message?: string;
	error_code?: string;
	error_status?: string;
}

const LARGE_INPUT_TOKENS = 50_000;

export interface CacheCohortStats {
	responses: number;
	avgCacheHitPct: number | null;
	zeroHitResponses: number;
	largeResponses: number;
	largeAvgCacheHitPct: number | null;
	largeZeroHitResponses: number;
}

interface StabilityStats {
	stable: number;
	changed: number;
	unavailable: number;
}

interface ContextBandStats {
	responses: number;
	terminals: Record<string, number>;
	zeroCacheResponses: number;
	weightedCacheReusePct: number | null;
}

interface ContextBandAccumulator extends ContextBandStats {
	inputTokens: number;
	cacheReadInputTokens: number;
}

interface CanaryTurnStats {
	requests: number;
	joinedTerminalResponses: number;
	cacheMeasuredResponses: number;
	weightedCacheReusePct: number | null;
	cachePositiveResponses: number;
	cachePositiveRatePct: number | null;
}

export interface CanaryArmStats {
	assignedRequests: number;
	joinedTerminalResponses: number;
	missingTerminalRequests: number;
	cacheMeasuredResponses: number;
	weightedCacheReusePct: number | null;
	cachePositiveResponses: number;
	cachePositiveRatePct: number | null;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		availableResponses: number;
		unavailableResponses: number;
	};
	terminals: Record<string, number>;
	effectiveModes: Record<string, number>;
	explicitCrossovers: {
		conversationToSession: number;
		sessionToConversation: number;
	};
	models: Record<string, number>;
	accounts: Record<string, number>;
	logicalConversations: number;
	turns: { first: CanaryTurnStats; followUp: CanaryTurnStats };
	conversationTurnBands: Record<string, number>;
	attemptInclusive: {
		attempts: number;
		joinedResponses: number;
		cacheMeasuredResponses: number;
		weightedCacheReusePct: number | null;
	};
}

export interface TraceReport {
	requests: number;
	responses: number;
	logicalRequests: number;
	attempts: number;
	joins: {
		missing: number;
		ambiguous: number;
		schema9MissingAttemptId: number;
	};
	cacheDenominators: {
		attemptInclusive: {
			measuredResponses: number;
			weightedCacheReusePct: number | null;
		};
		finalResponseOnly: {
			measuredResponses: number;
			weightedCacheReusePct: number | null;
		};
	};
	readiness: {
		treatmentAbsent: boolean;
		assignmentEffectiveCrossovers: number;
		maxRequestsPerKeyMinute: number;
		keysOver15RequestsPerMinute: number;
	};
	span: { first?: string; last?: string };
	canary: {
		conversation: CanaryArmStats;
		session: CanaryArmStats;
		unassigned: CanaryArmStats;
		unjoinedResponses: number;
	};
	request: {
		maxHistoryToolCalls: number;
		maxInputItems: number;
		maxApproxInputChars: number;
		totalNudges: number;
		distinctSessions: number;
		topSessions: Array<{ session: string; requests: number }>;
		fingerprintCoverage: { usable: number; missing: number; truncated: number };
		prefixTransitions: {
			retainedExactPriorFullPrefix: number;
			measurableChanged: number;
			unavailableAbsentFingerprints: number;
			unavailableRetentionWindow: number;
		};
		instructionStability: StabilityStats;
		toolStability: StabilityStats;
	};
	response: {
		totalNewToolCalls: number;
		maxNewFanOut: number;
		totalSubagentSpawns: number;
		maxSubagentSpawns: number;
		cacheCohorts: { keyOn: CacheCohortStats; keyOff: CacheCohortStats };
		unjoinedResponses: number;
		newFanOutHistogram: Record<string, number>;
		newToolUseByName: Record<string, number>;
		stopReasons: Record<string, number>;
		textOnlyResponses: number;
		errors: Record<string, number>;
		errorCodes: Record<string, number>;
		errorStatuses: Record<string, number>;
		cacheHitPctAvg: number | null;
		weightedCacheReusePct: number | null;
		zeroCacheResponses: number;
		contextBands: {
			under50: ContextBandStats;
			from50To80: ContextBandStats;
			from80To95: ContextBandStats;
			atLeast95: ContextBandStats;
			unavailable: ContextBandStats;
		};
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
			availableResponses: number;
			unavailableResponses: number;
		};
		respawnResponses: number;
		worstRespawns: Array<{
			request_id: string | null;
			tool: string;
			count: number;
		}>;
	};
}

export type CacheExperimentArm =
	| "treatment"
	| "control"
	| "ineligible"
	| "unassigned";
export type CacheExperimentTurn =
	| "first_observed"
	| "follow_up_observed"
	| "unknown";
export type CacheExperimentGapBand =
	| "under_1m"
	| "from_1m_to_5m"
	| "from_5m_to_15m"
	| "from_15m_to_60m"
	| "at_least_60m"
	| "unknown";

export interface CacheExperimentRow {
	arm: CacheExperimentArm;
	model: string;
	turn: CacheExperimentTurn;
	gapBand: CacheExperimentGapBand;
	observedCodexAttempts: number;
	joinedObservedCodexResponses: number;
	unjoinedObservedCodexAttempts: number;
	cache: {
		measuredResponses: number;
		unavailableResponses: number;
		overflowResponses: number;
		inputTokens: number;
		cachedReadTokens: number;
		weightedCachedReadPct: number | null;
		cacheWriteMeasuredResponses: number;
		cacheWriteUnavailableResponses: number;
		cacheWriteOverflowResponses: number;
		cacheWriteTokens: number;
		positiveHitResponses: number;
		positiveHitRatePct: number | null;
	};
	elapsed: {
		availableResponses: number;
		unavailableResponses: number;
		p50Ms: number | null;
		p95Ms: number | null;
	};
	outcomes: {
		observedCodex400Responses: number;
		observedCodexErrorResponses: number;
		finalObservedCodexAttemptFallbacks: number;
		observedCodexFallbackAttempts: number;
	};
	pacing: {
		pacedRequests: number;
		bypassedRequests: number;
		crossoverPacedRequests: number;
		unknownRequests: number;
		waitMsAvailableRequests: number;
		waitMsUnavailableRequests: number;
	};
	/** Whitelisted action buckets only; unknown values are never echoed. */
	actions: Record<string, number>;
}

export interface CacheExperimentDimensionReport {
	assignmentCounts: Record<CacheExperimentArm, number>;
	rows: CacheExperimentRow[];
}

export interface CodexCacheExperimentReport {
	schemaVersion: 1;
	attribution: {
		unit: "final_observed_codex_attempt";
		responseScope: "codex_trace_only_no_cross_provider_terminal_visibility";
		elapsed: "observed_codex_response_ts_minus_observed_codex_attempt_request_ts";
		gap: "prior_observed_codex_request_ts_in_same_trace_and_valid_cohort";
		pacingWaitMs: "unavailable";
		pacingWaitReason: "trace_has_action_but_no_wait_duration";
	};
	pacing: CacheExperimentDimensionReport;
	explicitBreakpoint: CacheExperimentDimensionReport;
	websocket: WebSocketCacheExperimentReport;
}

export type WebSocketExperimentAssignment = "treatment" | "control";
export type WebSocketExperimentTransport = "websocket" | "http";

/**
 * Ephemeral join material parsed from transport telemetry. The analyzer never
 * copies either identity into its report or formatted output.
 */
export interface ParsedCodexWebSocketObservation {
	requestId: string;
	attemptId: string;
	assignment: WebSocketExperimentAssignment;
	effectiveTransport: WebSocketExperimentTransport;
	action: string;
	hasFallback: boolean;
	frameWritten: boolean;
	fallbackAllowedBeforeWrite: boolean;
	hasCloseCategory: boolean;
	terminalMs: number | null;
	inputTokens: number | null;
	cachedReadTokens: number | null;
	cacheWriteTokens: number | null;
	cacheWriteMeasurementAvailable: boolean;
}

export interface ParsedCodexWebSocketObservations {
	observations: ParsedCodexWebSocketObservation[];
	diagnostics: {
		lines: number;
		acceptedLines: number;
		ignoredLines: number;
		malformedLines: number;
		futureSchemaLines: number;
	};
}

export interface WebSocketExperimentRow {
	assignment: WebSocketExperimentAssignment;
	effectiveTransport: WebSocketExperimentTransport;
	/** Whitelisted action only; unknown telemetry values collapse to `other`. */
	action: string;
	observations: number;
	joinedTraceResponses: number;
	unjoinedObservations: number;
	cache: {
		measuredResponses: number;
		unavailableResponses: number;
		overflowResponses: number;
		inputTokens: number;
		cachedReadTokens: number;
		weightedCachedReadPct: number | null;
		cacheWriteMeasuredResponses: number;
		cacheWriteUnavailableResponses: number;
		cacheWriteOverflowResponses: number;
		cacheWriteTokens: number;
	};
	latency: {
		availableResponses: number;
		unavailableResponses: number;
		p50Ms: number | null;
		p95Ms: number | null;
	};
	outcomes: {
		terminalResponses: number;
		terminalErrors: number;
		preWriteHttpFallbacks: number;
		postWriteFailures: number;
		fallbackCategories: Record<string, number>;
	};
}

export interface WebSocketCacheExperimentReport {
	attribution: {
		unit: "unique_ws_observation_exact_request_and_attempt_join";
		join: "one_request_and_one_response_with_exact_request_id_and_attempt_id";
		websocketCache: "terminal_transport_observation";
		httpCache: "joined_codex_trace_response";
		websocketLatency: "frame_write_to_terminal_observation_ms";
		httpLatency: "trace_response_ts_minus_trace_request_ts";
	};
	ingestion: {
		lines: number;
		acceptedObservations: number;
		ignoredLines: number;
		malformedLines: number;
		futureSchemaLines: number;
		uniqueObservations: number;
		duplicateObservationGroups: number;
		joinedObservations: number;
		unjoinedObservations: number;
		ambiguousTraceJoins: number;
	};
	assignmentCounts: Record<WebSocketExperimentAssignment, number>;
	effectiveTransportCounts: Record<WebSocketExperimentTransport, number>;
	rows: WebSocketExperimentRow[];
}

function keyOf(call: ToolCall): string {
	return `${call.name}::${call.arg_preview}`;
}

function average(values: number[]): number | null {
	return values.length > 0
		? Math.round(
				(10 * values.reduce((sum, value) => sum + value, 0)) / values.length,
			) / 10
		: null;
}

function cohortStats(
	samples: ReadonlyArray<{ pct: number | null; inputTokens: number }>,
): CacheCohortStats {
	const withPct = samples.filter(
		(sample): sample is { pct: number; inputTokens: number } =>
			sample.pct !== null,
	);
	const large = withPct.filter(
		(sample) => sample.inputTokens > LARGE_INPUT_TOKENS,
	);
	return {
		responses: samples.length,
		avgCacheHitPct: average(withPct.map((sample) => sample.pct)),
		zeroHitResponses: withPct.filter((sample) => sample.pct === 0).length,
		largeResponses: large.length,
		largeAvgCacheHitPct: average(large.map((sample) => sample.pct)),
		largeZeroHitResponses: large.filter((sample) => sample.pct === 0).length,
	};
}

function compareHmac(
	previous: string | null | undefined,
	current: string | null | undefined,
	stats: StabilityStats,
): void {
	if (!previous || !current) stats.unavailable++;
	else if (previous === current) stats.stable++;
	else stats.changed++;
}

function contextBandAccumulator(): ContextBandAccumulator {
	return {
		responses: 0,
		terminals: {},
		zeroCacheResponses: 0,
		weightedCacheReusePct: null,
		inputTokens: 0,
		cacheReadInputTokens: 0,
	};
}

function finishContextBand(band: ContextBandAccumulator): ContextBandStats {
	return {
		responses: band.responses,
		terminals: band.terminals,
		zeroCacheResponses: band.zeroCacheResponses,
		weightedCacheReusePct:
			band.inputTokens > 0
				? Math.round((1000 * band.cacheReadInputTokens) / band.inputTokens) / 10
				: null,
	};
}

function increment(distribution: Record<string, number>, value: string): void {
	distribution[value] = (distribution[value] ?? 0) + 1;
}

interface CanaryTurnAccumulator extends CanaryTurnStats {
	measuredInputTokens: number;
	cacheReadInputTokens: number;
}

interface CanaryArmAccumulator
	extends Omit<CanaryArmStats, "turns" | "attemptInclusive"> {
	measuredInputTokens: number;
	conversationIds: Set<string>;
	attemptInclusive: {
		attempts: number;
		joinedResponses: number;
		cacheMeasuredResponses: number;
		measuredInputTokens: number;
		cacheReadInputTokens: number;
	};
	turns: {
		first: CanaryTurnAccumulator;
		followUp: CanaryTurnAccumulator;
	};
}

function canaryTurnAccumulator(): CanaryTurnAccumulator {
	return {
		requests: 0,
		joinedTerminalResponses: 0,
		cacheMeasuredResponses: 0,
		weightedCacheReusePct: null,
		cachePositiveResponses: 0,
		cachePositiveRatePct: null,
		measuredInputTokens: 0,
		cacheReadInputTokens: 0,
	};
}

function canaryArmAccumulator(): CanaryArmAccumulator {
	return {
		assignedRequests: 0,
		joinedTerminalResponses: 0,
		missingTerminalRequests: 0,
		cacheMeasuredResponses: 0,
		weightedCacheReusePct: null,
		cachePositiveResponses: 0,
		cachePositiveRatePct: null,
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			availableResponses: 0,
			unavailableResponses: 0,
		},
		terminals: {},
		effectiveModes: {},
		explicitCrossovers: {
			conversationToSession: 0,
			sessionToConversation: 0,
		},
		models: {},
		accounts: {},
		logicalConversations: 0,
		turns: {
			first: canaryTurnAccumulator(),
			followUp: canaryTurnAccumulator(),
		},
		conversationTurnBands: {},
		measuredInputTokens: 0,
		conversationIds: new Set(),
		attemptInclusive: {
			attempts: 0,
			joinedResponses: 0,
			cacheMeasuredResponses: 0,
			measuredInputTokens: 0,
			cacheReadInputTokens: 0,
		},
	};
}

function finishCanaryTurn(turn: CanaryTurnAccumulator): CanaryTurnStats {
	return {
		requests: turn.requests,
		joinedTerminalResponses: turn.joinedTerminalResponses,
		cacheMeasuredResponses: turn.cacheMeasuredResponses,
		weightedCacheReusePct:
			turn.measuredInputTokens > 0
				? Math.round(
						(1000 * turn.cacheReadInputTokens) / turn.measuredInputTokens,
					) / 10
				: null,
		cachePositiveResponses: turn.cachePositiveResponses,
		cachePositiveRatePct:
			turn.cacheMeasuredResponses > 0
				? Math.round(
						(1000 * turn.cachePositiveResponses) / turn.cacheMeasuredResponses,
					) / 10
				: null,
	};
}

function finishCanaryArm(arm: CanaryArmAccumulator): CanaryArmStats {
	return {
		assignedRequests: arm.assignedRequests,
		joinedTerminalResponses: arm.joinedTerminalResponses,
		missingTerminalRequests: arm.missingTerminalRequests,
		cacheMeasuredResponses: arm.cacheMeasuredResponses,
		weightedCacheReusePct:
			arm.measuredInputTokens > 0
				? Math.round(
						(1000 * arm.usage.cacheReadInputTokens) / arm.measuredInputTokens,
					) / 10
				: null,
		cachePositiveResponses: arm.cachePositiveResponses,
		cachePositiveRatePct:
			arm.cacheMeasuredResponses > 0
				? Math.round(
						(1000 * arm.cachePositiveResponses) / arm.cacheMeasuredResponses,
					) / 10
				: null,
		usage: arm.usage,
		terminals: arm.terminals,
		effectiveModes: arm.effectiveModes,
		explicitCrossovers: arm.explicitCrossovers,
		models: arm.models,
		accounts: arm.accounts,
		logicalConversations: arm.conversationIds.size,
		turns: {
			first: finishCanaryTurn(arm.turns.first),
			followUp: finishCanaryTurn(arm.turns.followUp),
		},
		conversationTurnBands: arm.conversationTurnBands,
		attemptInclusive: {
			attempts: arm.attemptInclusive.attempts,
			joinedResponses: arm.attemptInclusive.joinedResponses,
			cacheMeasuredResponses: arm.attemptInclusive.cacheMeasuredResponses,
			weightedCacheReusePct:
				arm.attemptInclusive.measuredInputTokens > 0
					? Math.round(
							(1000 * arm.attemptInclusive.cacheReadInputTokens) /
								arm.attemptInclusive.measuredInputTokens,
						) / 10
					: null,
		},
	};
}

// Logical-ID joins are a compatibility path for schema 6-8 records only. A
// schema-9 record without attempt_id is an instrumentation failure and must
// surface as unjoinable rather than silently collapsing physical attempts.
function isLegacyJoinEligible(record: TraceRecord): boolean {
	return (record.trace_schema_version ?? 0) < 9;
}

function analyzeCanary(
	requestRecords: readonly TraceRecord[],
	responseRecords: readonly TraceRecord[],
): TraceReport["canary"] {
	const requestAttemptsById = new Map<string, TraceRecord[]>();
	const responseAttemptsById = new Map<string, TraceRecord[]>();
	const legacyRequestsByLogicalId = new Map<string, TraceRecord[]>();
	const legacyResponsesByLogicalId = new Map<string, TraceRecord[]>();
	let responsesWithoutId = 0;
	const append = (
		map: Map<string, TraceRecord[]>,
		id: string,
		record: TraceRecord,
	) => {
		const group = map.get(id) ?? [];
		group.push(record);
		map.set(id, group);
	};
	for (const request of requestRecords) {
		if (request.attempt_id)
			append(requestAttemptsById, request.attempt_id, request);
		else if (request.request_id && isLegacyJoinEligible(request))
			append(legacyRequestsByLogicalId, request.request_id, request);
	}
	for (const response of responseRecords) {
		if (response.attempt_id)
			append(responseAttemptsById, response.attempt_id, response);
		else if (response.request_id && isLegacyJoinEligible(response))
			append(legacyResponsesByLogicalId, response.request_id, response);
		else responsesWithoutId++;
	}
	const requestsByLogicalId = new Map<string, TraceRecord[]>();
	const anonymousRequests: TraceRecord[] = [];
	for (const request of requestRecords) {
		if (!request.request_id) {
			anonymousRequests.push(request);
			continue;
		}
		append(requestsByLogicalId, request.request_id, request);
	}
	const retainedRequests = [...requestsByLogicalId.values()]
		.map((attempts) =>
			[...attempts]
				.sort(
					(a, b) =>
						(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
						(a.ts ?? "").localeCompare(b.ts ?? ""),
				)
				.at(-1),
		)
		.filter((request): request is TraceRecord => Boolean(request));
	retainedRequests.push(...anonymousRequests);
	const responseFor = (request: TraceRecord): TraceRecord | undefined => {
		if (request.attempt_id) {
			const requests = requestAttemptsById.get(request.attempt_id) ?? [];
			const responses = responseAttemptsById.get(request.attempt_id) ?? [];
			return requests.length === 1 && responses.length === 1
				? responses[0]
				: undefined;
		}
		if (!request.request_id || !isLegacyJoinEligible(request)) return undefined;
		const requests = legacyRequestsByLogicalId.get(request.request_id) ?? [];
		const responses = legacyResponsesByLogicalId.get(request.request_id) ?? [];
		return requests.length === 1 && responses.length === 1
			? responses[0]
			: undefined;
	};

	const conversationRequests = new Map<string, TraceRecord[]>();
	for (const request of retainedRequests) {
		if (!request.conversation_id) continue;
		const group = conversationRequests.get(request.conversation_id) ?? [];
		group.push(request);
		conversationRequests.set(request.conversation_id, group);
	}
	const turnIndexByRequest = new Map<TraceRecord, number>();
	const conversationSizeByRequest = new Map<TraceRecord, number>();
	for (const group of conversationRequests.values()) {
		group.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
		group.forEach((request, index) => {
			turnIndexByRequest.set(request, index);
			conversationSizeByRequest.set(request, group.length);
		});
	}

	const arms = {
		conversation: canaryArmAccumulator(),
		session: canaryArmAccumulator(),
		unassigned: canaryArmAccumulator(),
	};
	for (const request of retainedRequests) {
		const assignment = request.cache_key_assignment;
		const arm =
			assignment === "conversation" || assignment === "session"
				? arms[assignment]
				: arms.unassigned;
		arm.assignedRequests++;
		if (request.cache_key_mode)
			increment(arm.effectiveModes, request.cache_key_mode);
		if (request.model_out) increment(arm.models, request.model_out);
		if (request.account) increment(arm.accounts, request.account);
		if (request.conversation_id)
			arm.conversationIds.add(request.conversation_id);
		const conversationSize = conversationSizeByRequest.get(request);
		if (conversationSize !== undefined)
			increment(arm.conversationTurnBands, String(conversationSize));
		if (
			request.cache_key_assignment_source === "explicit_session_override" &&
			assignment === "conversation" &&
			request.cache_key_mode === "session"
		)
			arm.explicitCrossovers.conversationToSession++;
		if (assignment === "session" && request.cache_key_mode === "conversation")
			arm.explicitCrossovers.sessionToConversation++;

		const turn =
			turnIndexByRequest.get(request) === 0
				? arm.turns.first
				: arm.turns.followUp;
		turn.requests++;
		const response = responseFor(request);
		if (!response) {
			arm.missingTerminalRequests++;
			continue;
		}
		arm.joinedTerminalResponses++;
		turn.joinedTerminalResponses++;
		increment(arm.terminals, response.stop_reason ?? "unknown");
		const inputTokens = response.input_tokens ?? 0;
		if (response.usage_measurement_available === false) {
			arm.usage.unavailableResponses++;
		} else if (typeof response.input_tokens === "number") {
			arm.usage.availableResponses++;
			arm.usage.inputTokens += inputTokens;
			arm.usage.outputTokens += response.output_tokens ?? 0;
			if (hasMeasuredCacheWrite(response)) {
				arm.usage.cacheCreationInputTokens +=
					response.cache_creation_input_tokens ?? 0;
			}
		} else {
			arm.usage.unavailableResponses++;
		}
		if (
			response.cache_measurement_available === false ||
			typeof response.cache_read_input_tokens !== "number" ||
			typeof response.input_tokens !== "number"
		)
			continue;
		const cacheRead = Math.min(
			Math.max(response.cache_read_input_tokens, 0),
			inputTokens,
		);
		arm.cacheMeasuredResponses++;
		arm.measuredInputTokens += inputTokens;
		arm.usage.cacheReadInputTokens += cacheRead;
		turn.cacheMeasuredResponses++;
		turn.measuredInputTokens += inputTokens;
		turn.cacheReadInputTokens += cacheRead;
		if (cacheRead > 0) {
			arm.cachePositiveResponses++;
			turn.cachePositiveResponses++;
		}
	}

	// Attempt-inclusive per-arm economics: every physical attempt joins under
	// the arm of its own request record, so retry and failover costs are
	// attributable to the treatment that incurred them.
	const armFor = (request: TraceRecord) => {
		const assignment = request.cache_key_assignment;
		return assignment === "conversation" || assignment === "session"
			? arms[assignment]
			: arms.unassigned;
	};
	for (const request of requestRecords) {
		armFor(request).attemptInclusive.attempts++;
	}
	const accumulateAttemptJoin = (
		requests: readonly TraceRecord[],
		responses: readonly TraceRecord[],
	) => {
		if (requests.length !== 1 || responses.length !== 1) return;
		const request = requests[0];
		const response = responses[0];
		if (!request || !response) return;
		const arm = armFor(request);
		arm.attemptInclusive.joinedResponses++;
		if (
			response.cache_measurement_available === false ||
			typeof response.cache_read_input_tokens !== "number" ||
			typeof response.input_tokens !== "number"
		)
			return;
		const inputTokens = response.input_tokens;
		const cacheRead = Math.min(
			Math.max(response.cache_read_input_tokens, 0),
			inputTokens,
		);
		arm.attemptInclusive.cacheMeasuredResponses++;
		arm.attemptInclusive.measuredInputTokens += inputTokens;
		arm.attemptInclusive.cacheReadInputTokens += cacheRead;
	};
	for (const [attemptId, requests] of requestAttemptsById) {
		accumulateAttemptJoin(requests, responseAttemptsById.get(attemptId) ?? []);
	}
	for (const [logicalId, requests] of legacyRequestsByLogicalId) {
		accumulateAttemptJoin(
			requests,
			legacyResponsesByLogicalId.get(logicalId) ?? [],
		);
	}
	let unjoinedResponses = responsesWithoutId;
	for (const [attemptId, responses] of responseAttemptsById)
		if (
			(requestAttemptsById.get(attemptId)?.length ?? 0) !== 1 ||
			responses.length !== 1
		)
			unjoinedResponses += responses.length;
	for (const [requestId, responses] of legacyResponsesByLogicalId) {
		const requests = legacyRequestsByLogicalId.get(requestId) ?? [];
		if (requests.length !== 1 || responses.length !== 1) {
			unjoinedResponses += responses.length;
		}
	}
	return {
		conversation: finishCanaryArm(arms.conversation),
		session: finishCanaryArm(arms.session),
		unassigned: finishCanaryArm(arms.unassigned),
		unjoinedResponses,
	};
}

function analyzeRequestTransitions(requests: TraceRecord[]) {
	const prefixTransitions = {
		retainedExactPriorFullPrefix: 0,
		measurableChanged: 0,
		unavailableAbsentFingerprints: 0,
		unavailableRetentionWindow: 0,
	};
	const instructionStability: StabilityStats = {
		stable: 0,
		changed: 0,
		unavailable: 0,
	};
	const toolStability: StabilityStats = {
		stable: 0,
		changed: 0,
		unavailable: 0,
	};
	const groups = new Map<string, TraceRecord[]>();
	for (const request of requests) {
		if (!request.prompt_cache_key_id) continue;
		const group = groups.get(request.prompt_cache_key_id) ?? [];
		group.push(request);
		groups.set(request.prompt_cache_key_id, group);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
		for (let index = 1; index < group.length; index++) {
			const previous = group[index - 1] as TraceRecord;
			const current = group[index] as TraceRecord;
			compareHmac(
				previous.instructions_hmac,
				current.instructions_hmac,
				instructionStability,
			);
			compareHmac(previous.tools_hmac, current.tools_hmac, toolStability);
			const previousCount =
				previous.input_item_total_count ?? previous.input_item_count;
			const currentCount =
				current.input_item_total_count ?? current.input_item_count;
			const fingerprints = current.input_item_fingerprints ?? [];
			if (previousCount === undefined || fingerprints.length === 0) {
				prefixTransitions.unavailableAbsentFingerprints++;
				continue;
			}
			const boundaryIndex = previousCount - 1;
			const previousFinal = (previous.input_item_fingerprints ?? []).find(
				(fingerprint) => fingerprint.index === boundaryIndex,
			);
			if (!previousFinal) {
				prefixTransitions.unavailableAbsentFingerprints++;
				continue;
			}
			if (currentCount !== undefined && currentCount < previousCount) {
				prefixTransitions.measurableChanged++;
				continue;
			}
			const currentBoundary = fingerprints.find(
				(fingerprint) => fingerprint.index === boundaryIndex,
			);
			if (!currentBoundary) {
				const firstRetained = fingerprints[0]?.index;
				if (
					current.input_item_fingerprints_truncated === true &&
					firstRetained !== undefined &&
					firstRetained > boundaryIndex
				) {
					prefixTransitions.unavailableRetentionWindow++;
				} else {
					prefixTransitions.measurableChanged++;
				}
				continue;
			}
			if (previousFinal.hmac === currentBoundary.hmac)
				prefixTransitions.retainedExactPriorFullPrefix++;
			else prefixTransitions.measurableChanged++;
		}
	}
	return { prefixTransitions, instructionStability, toolStability };
}

const SAFE_COHORT = /^[a-fA-F0-9]{16}$/;
const FALLBACK_CAUSES = new Set(["model_fallback", "account_failover"]);
const PACING_ACTIONS = new Set(["paced", "bypassed", "crossover-paced"]);
const OFFICIAL_CODEX_MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> =
	[
		[/^gpt-5\.6-sol(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-sol"],
		[/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.5"],
		[/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4-mini"],
		[/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4"],
		[/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.3-codex"],
	];
const EXPLICIT_BREAKPOINT_ACTIONS = new Set([
	"placed_source_marker",
	"placed_first_user_text",
	"skip_percent_control",
	"skip_env_disabled",
	"skip_non_gpt56",
	"skip_non_eligible_endpoint",
	"skip_no_prompt_cache_key",
	"skip_no_conversation",
	"skip_known_unsupported",
	"skip_no_eligible_block",
	"skip_rotated_cache_key_attempt",
]);

const WS_OBSERVATION_MESSAGE = "codex_ws_transport";
const WS_OBSERVATION_ACTIONS = new Set([
	"abort",
	"buffer_overflow",
	"cohort_control",
	"cohort_not_allowlisted",
	"connection_busy",
	"connection_opening",
	"downstream_cancelled",
	"global_cap",
	"handshake_close",
	"handshake_error",
	"handshake_timeout",
	"lane_identity_busy",
	"malformed_frame",
	"observe_only",
	"per_account_cap",
	"post_write_close",
	"post_write_error",
	"post_write_timeout",
	"semantic_stall",
	"send_failed_before_write",
	"sticky_http",
	"stream_cancelled",
	"upstream_terminal_error",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableSafeCount(value: unknown): value is number | null {
	return value === null || safeTokenCount(value);
}

type WebSocketObservationCandidate =
	| { kind: "ignored" }
	| { kind: "malformed" }
	| { kind: "candidate"; value: Record<string, unknown> };

function extractWebSocketObservationCandidate(
	value: unknown,
	depth = 0,
): WebSocketObservationCandidate {
	if (!isObjectRecord(value)) return { kind: "ignored" };
	if (typeof value.MESSAGE === "string" && depth < 2) {
		const message = value.MESSAGE.trim();
		try {
			const nested = JSON.parse(message) as unknown;
			const extracted = extractWebSocketObservationCandidate(nested, depth + 1);
			if (extracted.kind !== "ignored") return extracted;
		} catch {
			// Pretty logger output is handled by the marker parser below.
		}
		const marker = message.indexOf(WS_OBSERVATION_MESSAGE);
		if (marker < 0) return { kind: "ignored" };
		const suffix = message.slice(marker + WS_OBSERVATION_MESSAGE.length).trim();
		try {
			const parsed = JSON.parse(suffix) as unknown;
			return isObjectRecord(parsed)
				? { kind: "candidate", value: parsed }
				: { kind: "malformed" };
		} catch {
			return { kind: "malformed" };
		}
	}
	if (value.msg === WS_OBSERVATION_MESSAGE) {
		return isObjectRecord(value.data)
			? { kind: "candidate", value: value.data }
			: { kind: "malformed" };
	}
	if (
		"requestId" in value ||
		"attemptId" in value ||
		"assignment" in value ||
		"effectiveTransport" in value
	) {
		return { kind: "candidate", value };
	}
	return { kind: "ignored" };
}

type ParsedWebSocketObservationLine =
	| { kind: "accepted"; observation: ParsedCodexWebSocketObservation }
	| { kind: "malformed" }
	| { kind: "future" };

function parseWebSocketObservation(
	value: Record<string, unknown>,
): ParsedWebSocketObservationLine {
	const schemaVersion =
		value.observationSchemaVersion ??
		value.observation_schema_version ??
		value.schemaVersion ??
		value.schema_version;
	if (schemaVersion !== undefined) {
		if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1)
			return { kind: "malformed" };
		if (Number(schemaVersion) > 1) return { kind: "future" };
	}
	if (
		typeof value.requestId !== "string" ||
		value.requestId.length === 0 ||
		value.requestId.length > 1_024 ||
		typeof value.attemptId !== "string" ||
		value.attemptId.length === 0 ||
		value.attemptId.length > 1_024 ||
		(value.assignment !== "treatment" && value.assignment !== "control") ||
		(value.effectiveTransport !== "websocket" &&
			value.effectiveTransport !== "http") ||
		typeof value.frameWritten !== "boolean" ||
		typeof value.fallbackAllowedBeforeWrite !== "boolean" ||
		typeof value.cacheWriteMeasurementAvailable !== "boolean" ||
		(value.fallbackReason !== null &&
			typeof value.fallbackReason !== "string") ||
		(value.closeCategory !== null && typeof value.closeCategory !== "string") ||
		!nullableSafeCount(value.terminalMs) ||
		!nullableSafeCount(value.inputTokens) ||
		!nullableSafeCount(value.cachedReadTokens) ||
		!nullableSafeCount(value.cacheWriteTokens)
	) {
		return { kind: "malformed" };
	}
	const fallback = value.fallbackReason;
	const action =
		typeof fallback === "string" && fallback.length > 0
			? WS_OBSERVATION_ACTIONS.has(fallback)
				? fallback
				: "other"
			: value.effectiveTransport === "websocket"
				? "websocket_terminal"
				: value.assignment === "control"
					? "http_control"
					: "http_bypass";
	return {
		kind: "accepted",
		observation: {
			requestId: value.requestId,
			attemptId: value.attemptId,
			assignment: value.assignment,
			effectiveTransport: value.effectiveTransport,
			action,
			hasFallback: typeof fallback === "string" && fallback.length > 0,
			frameWritten: value.frameWritten,
			fallbackAllowedBeforeWrite: value.fallbackAllowedBeforeWrite,
			hasCloseCategory:
				typeof value.closeCategory === "string" &&
				value.closeCategory.length > 0,
			terminalMs: value.terminalMs,
			inputTokens: value.inputTokens,
			cachedReadTokens: value.cachedReadTokens,
			cacheWriteTokens: value.cacheWriteTokens,
			cacheWriteMeasurementAvailable: value.cacheWriteMeasurementAvailable,
		},
	};
}

/**
 * Parse direct observation JSONL, Logger JSONL, or `journalctl -o json` output.
 * Sensitive telemetry fields are discarded immediately; only ephemeral exact
 * join identities plus aggregate-safe enums and measurements are retained.
 */
export function parseCodexWebSocketObservationsJsonl(
	text: string,
): ParsedCodexWebSocketObservations {
	const result: ParsedCodexWebSocketObservations = {
		observations: [],
		diagnostics: {
			lines: 0,
			acceptedLines: 0,
			ignoredLines: 0,
			malformedLines: 0,
			futureSchemaLines: 0,
		},
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		result.diagnostics.lines++;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			result.diagnostics.malformedLines++;
			continue;
		}
		const candidate = extractWebSocketObservationCandidate(parsed);
		if (candidate.kind === "ignored") {
			result.diagnostics.ignoredLines++;
			continue;
		}
		if (candidate.kind === "malformed") {
			result.diagnostics.malformedLines++;
			continue;
		}
		const observation = parseWebSocketObservation(candidate.value);
		if (observation.kind === "future") {
			result.diagnostics.futureSchemaLines++;
			continue;
		}
		if (observation.kind === "malformed") {
			result.diagnostics.malformedLines++;
			continue;
		}
		result.observations.push(observation.observation);
		result.diagnostics.acceptedLines++;
	}
	return result;
}

function emptyParsedCodexWebSocketObservations(): ParsedCodexWebSocketObservations {
	return {
		observations: [],
		diagnostics: {
			lines: 0,
			acceptedLines: 0,
			ignoredLines: 0,
			malformedLines: 0,
			futureSchemaLines: 0,
		},
	};
}

interface CacheExperimentLogicalSample {
	request: TraceRecord;
	attempts: TraceRecord[];
	response?: TraceRecord;
	logicalTimestamp: number | null;
}

interface CacheExperimentAnnotatedSample extends CacheExperimentLogicalSample {
	arm: CacheExperimentArm;
	model: string;
	turn: CacheExperimentTurn;
	gapBand: CacheExperimentGapBand;
	action: string;
}

interface CacheExperimentRowAccumulator extends CacheExperimentRow {
	elapsedSamples: number[];
}

type CacheExperimentKind = "pacing" | "explicitBreakpoint";

function appendRecord(
	map: Map<string, TraceRecord[]>,
	id: string,
	record: TraceRecord,
): void {
	const records = map.get(id) ?? [];
	records.push(record);
	map.set(id, records);
}

function matchingLogicalRequestIds(
	request: TraceRecord,
	response: TraceRecord,
): boolean {
	return !(
		request.request_id &&
		response.request_id &&
		request.request_id !== response.request_id
	);
}

/**
 * Retain the last Codex attempt observed per request ID in this trace slice.
 * The trace cannot reveal a later cross-provider attempt or terminal. IDs are
 * used only as ephemeral join keys and never copied into the report.
 */
function cacheExperimentLogicalSamples(
	records: readonly TraceRecord[],
): CacheExperimentLogicalSample[] {
	const requestRecords = records.filter(
		(record) => (record.phase ?? "request") === "request",
	);
	const responseRecords = records.filter(
		(record) => record.phase === "response",
	);
	const requestsByAttempt = new Map<string, TraceRecord[]>();
	const responsesByAttempt = new Map<string, TraceRecord[]>();
	const legacyRequestsByLogical = new Map<string, TraceRecord[]>();
	const legacyResponsesByLogical = new Map<string, TraceRecord[]>();
	for (const request of requestRecords) {
		if (request.attempt_id)
			appendRecord(requestsByAttempt, request.attempt_id, request);
		else if (request.request_id && isLegacyJoinEligible(request))
			appendRecord(legacyRequestsByLogical, request.request_id, request);
	}
	for (const response of responseRecords) {
		if (response.attempt_id)
			appendRecord(responsesByAttempt, response.attempt_id, response);
		else if (response.request_id && isLegacyJoinEligible(response))
			appendRecord(legacyResponsesByLogical, response.request_id, response);
	}

	const logicalRequests = new Map<string, TraceRecord[]>();
	let anonymous = 0;
	for (const request of requestRecords) {
		const key = request.request_id
			? `logical:${request.request_id}`
			: request.attempt_id
				? `attempt:${request.attempt_id}`
				: `anonymous:${anonymous++}`;
		appendRecord(logicalRequests, key, request);
	}

	const timestampOf = (record: TraceRecord): number | null => {
		if (!record.ts) return null;
		const parsed = Date.parse(record.ts);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const samples: CacheExperimentLogicalSample[] = [];
	for (const attempts of logicalRequests.values()) {
		const ordered = [...attempts].sort(
			(a, b) =>
				(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
				(timestampOf(a) ?? Number.POSITIVE_INFINITY) -
					(timestampOf(b) ?? Number.POSITIVE_INFINITY),
		);
		const request = ordered.at(-1);
		if (!request) continue;
		let response: TraceRecord | undefined;
		if (request.attempt_id) {
			const joinedRequests = requestsByAttempt.get(request.attempt_id) ?? [];
			const joinedResponses = responsesByAttempt.get(request.attempt_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			)
				response = joinedResponses[0];
		} else if (request.request_id && isLegacyJoinEligible(request)) {
			const joinedRequests =
				legacyRequestsByLogical.get(request.request_id) ?? [];
			const joinedResponses =
				legacyResponsesByLogical.get(request.request_id) ?? [];
			if (
				joinedRequests.length === 1 &&
				joinedResponses.length === 1 &&
				joinedResponses[0] &&
				matchingLogicalRequestIds(request, joinedResponses[0])
			)
				response = joinedResponses[0];
		}
		const validAttemptTimes = ordered
			.map(timestampOf)
			.filter((value): value is number => value !== null);
		const logicalTimestamp = validAttemptTimes.reduce<number | null>(
			(earliest, timestamp) =>
				earliest === null || timestamp < earliest ? timestamp : earliest,
			null,
		);
		samples.push({
			request,
			attempts: ordered,
			response,
			logicalTimestamp,
		});
	}
	return samples;
}

function experimentField(
	request: TraceRecord,
	kind: CacheExperimentKind,
): string | null | undefined {
	return kind === "pacing"
		? request.pacing_canary
		: request.explicit_breakpoint_canary;
}

function experimentCohort(
	request: TraceRecord,
	kind: CacheExperimentKind,
): string | null {
	const cohort =
		kind === "pacing"
			? request.pacing_cohort_id
			: request.explicit_breakpoint_cohort_id;
	return typeof cohort === "string" && SAFE_COHORT.test(cohort)
		? cohort.toLowerCase()
		: null;
}

function experimentArm(
	value: string | null | undefined,
	kind: CacheExperimentKind,
): CacheExperimentArm {
	if (kind === "pacing") {
		if (value === "bypass") return "treatment";
		if (value === "control") return "control";
		return "unassigned";
	}
	if (value === "treatment" || value === "control" || value === "ineligible")
		return value;
	return "unassigned";
}

function safeModel(request: TraceRecord): string {
	const model = request.model_out ?? request.model_in;
	if (typeof model !== "string" || model.length === 0) return "unknown";
	for (const [pattern, family] of OFFICIAL_CODEX_MODEL_FAMILIES)
		if (pattern.test(model)) return family;
	return "other_or_custom";
}

function experimentAction(
	request: TraceRecord,
	kind: CacheExperimentKind,
): string {
	const action =
		kind === "pacing"
			? request.pacing_action
			: request.explicit_breakpoint_action;
	if (action === null || action === undefined || action === "")
		return "unavailable";
	const allowlist =
		kind === "pacing" ? PACING_ACTIONS : EXPLICIT_BREAKPOINT_ACTIONS;
	return allowlist.has(action) ? action : "unknown";
}

function gapBand(gapMs: number): CacheExperimentGapBand {
	if (gapMs < 60_000) return "under_1m";
	if (gapMs < 5 * 60_000) return "from_1m_to_5m";
	if (gapMs < 15 * 60_000) return "from_5m_to_15m";
	if (gapMs < 60 * 60_000) return "from_15m_to_60m";
	return "at_least_60m";
}

function annotateExperimentSamples(
	samples: readonly CacheExperimentLogicalSample[],
	kind: CacheExperimentKind,
): CacheExperimentAnnotatedSample[] {
	const included = samples.filter((sample) => {
		const assignment = experimentField(sample.request, kind);
		return typeof assignment === "string" && assignment.length > 0;
	});
	const turnBySample = new Map<
		CacheExperimentLogicalSample,
		{ turn: CacheExperimentTurn; gapBand: CacheExperimentGapBand }
	>();
	const samplesByCohort = new Map<string, CacheExperimentLogicalSample[]>();
	for (const sample of included) {
		const cohort = experimentCohort(sample.request, kind);
		if (!cohort || sample.logicalTimestamp === null) {
			turnBySample.set(sample, { turn: "unknown", gapBand: "unknown" });
			continue;
		}
		const group = samplesByCohort.get(cohort) ?? [];
		group.push(sample);
		samplesByCohort.set(cohort, group);
	}
	for (const group of samplesByCohort.values()) {
		group.sort((a, b) => (a.logicalTimestamp ?? 0) - (b.logicalTimestamp ?? 0));
		group.forEach((sample, index) => {
			if (index === 0) {
				turnBySample.set(sample, {
					turn: "first_observed",
					gapBand: "unknown",
				});
				return;
			}
			const previous = group[index - 1];
			const currentTs = sample.logicalTimestamp;
			const previousTs = previous?.logicalTimestamp;
			if (
				currentTs === null ||
				previousTs === null ||
				previousTs === undefined ||
				currentTs < previousTs
			) {
				turnBySample.set(sample, {
					turn: "follow_up_observed",
					gapBand: "unknown",
				});
				return;
			}
			const observedGapMs = currentTs - previousTs;
			turnBySample.set(sample, {
				turn: "follow_up_observed",
				gapBand: Number.isSafeInteger(observedGapMs)
					? gapBand(observedGapMs)
					: "unknown",
			});
		});
	}
	return included.map((sample) => ({
		...sample,
		arm: experimentArm(experimentField(sample.request, kind), kind),
		model: safeModel(sample.request),
		...(turnBySample.get(sample) ?? {
			turn: "unknown" as const,
			gapBand: "unknown" as const,
		}),
		action: experimentAction(sample.request, kind),
	}));
}

function cacheExperimentRowAccumulator(
	sample: CacheExperimentAnnotatedSample,
): CacheExperimentRowAccumulator {
	return {
		arm: sample.arm,
		model: sample.model,
		turn: sample.turn,
		gapBand: sample.gapBand,
		observedCodexAttempts: 0,
		joinedObservedCodexResponses: 0,
		unjoinedObservedCodexAttempts: 0,
		cache: {
			measuredResponses: 0,
			unavailableResponses: 0,
			overflowResponses: 0,
			inputTokens: 0,
			cachedReadTokens: 0,
			weightedCachedReadPct: null,
			cacheWriteMeasuredResponses: 0,
			cacheWriteUnavailableResponses: 0,
			cacheWriteOverflowResponses: 0,
			cacheWriteTokens: 0,
			positiveHitResponses: 0,
			positiveHitRatePct: null,
		},
		elapsed: {
			availableResponses: 0,
			unavailableResponses: 0,
			p50Ms: null,
			p95Ms: null,
		},
		outcomes: {
			observedCodex400Responses: 0,
			observedCodexErrorResponses: 0,
			finalObservedCodexAttemptFallbacks: 0,
			observedCodexFallbackAttempts: 0,
		},
		pacing: {
			pacedRequests: 0,
			bypassedRequests: 0,
			crossoverPacedRequests: 0,
			unknownRequests: 0,
			waitMsAvailableRequests: 0,
			waitMsUnavailableRequests: 0,
		},
		actions: {},
		elapsedSamples: [],
	};
}

function safeTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Schema 11 records say whether cache-write usage was actually reported.
 * Earlier positive values remain usable, but an earlier zero is ambiguous
 * because the normalizer historically substituted zero when the field was
 * absent. Treat those legacy zeros as unavailable instead of measured facts.
 */
function hasMeasuredCacheWrite(response: TraceRecord): boolean {
	if (response.usage_measurement_available === false) return false;
	if (!safeTokenCount(response.cache_creation_input_tokens)) return false;
	if (response.cache_creation_measurement_available === false) return false;
	if (response.cache_creation_measurement_available === true) return true;
	return response.cache_creation_input_tokens > 0;
}

function safeTokenSum(current: number, increment: number): number | null {
	if (increment > Number.MAX_SAFE_INTEGER - current) return null;
	return current + increment;
}

function percentile(
	values: readonly number[],
	quantile: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
	return sorted[index] ?? null;
}

function incrementPacingAction(
	row: CacheExperimentRowAccumulator,
	action: string | null | undefined,
): void {
	if (action === "paced") {
		row.pacing.pacedRequests++;
		row.pacing.waitMsUnavailableRequests++;
	} else if (action === "bypassed") {
		row.pacing.bypassedRequests++;
	} else if (action === "crossover-paced") {
		row.pacing.crossoverPacedRequests++;
		row.pacing.waitMsUnavailableRequests++;
	} else {
		row.pacing.unknownRequests++;
	}
}

function finishCacheExperimentRow(
	row: CacheExperimentRowAccumulator,
): CacheExperimentRow {
	const actions = Object.fromEntries(
		Object.entries(row.actions).sort(([a], [b]) => a.localeCompare(b)),
	);
	return {
		arm: row.arm,
		model: row.model,
		turn: row.turn,
		gapBand: row.gapBand,
		observedCodexAttempts: row.observedCodexAttempts,
		joinedObservedCodexResponses: row.joinedObservedCodexResponses,
		unjoinedObservedCodexAttempts: row.unjoinedObservedCodexAttempts,
		cache: {
			...row.cache,
			weightedCachedReadPct:
				row.cache.inputTokens > 0
					? Math.round(
							(row.cache.cachedReadTokens / row.cache.inputTokens) * 1000,
						) / 10
					: null,
			positiveHitRatePct:
				row.cache.measuredResponses > 0
					? Math.round(
							(1000 * row.cache.positiveHitResponses) /
								row.cache.measuredResponses,
						) / 10
					: null,
		},
		elapsed: {
			availableResponses: row.elapsed.availableResponses,
			unavailableResponses: row.elapsed.unavailableResponses,
			p50Ms: percentile(row.elapsedSamples, 0.5),
			p95Ms: percentile(row.elapsedSamples, 0.95),
		},
		outcomes: row.outcomes,
		pacing: row.pacing,
		actions,
	};
}

const ARM_ORDER: CacheExperimentArm[] = [
	"control",
	"treatment",
	"ineligible",
	"unassigned",
];
const TURN_ORDER: CacheExperimentTurn[] = [
	"first_observed",
	"follow_up_observed",
	"unknown",
];
const GAP_ORDER: CacheExperimentGapBand[] = [
	"under_1m",
	"from_1m_to_5m",
	"from_5m_to_15m",
	"from_15m_to_60m",
	"at_least_60m",
	"unknown",
];

function cacheExperimentDimension(
	samples: readonly CacheExperimentLogicalSample[],
	kind: CacheExperimentKind,
): CacheExperimentDimensionReport {
	const annotated = annotateExperimentSamples(samples, kind);
	const assignmentCounts: Record<CacheExperimentArm, number> = {
		treatment: 0,
		control: 0,
		ineligible: 0,
		unassigned: 0,
	};
	const rows = new Map<string, CacheExperimentRowAccumulator>();
	for (const sample of annotated) {
		assignmentCounts[sample.arm]++;
		const rowKey = [sample.arm, sample.model, sample.turn, sample.gapBand].join(
			"\u0000",
		);
		let row = rows.get(rowKey);
		if (!row) {
			row = cacheExperimentRowAccumulator(sample);
			rows.set(rowKey, row);
		}
		row.observedCodexAttempts++;
		increment(row.actions, sample.action);
		incrementPacingAction(row, sample.request.pacing_action);
		const fallbackAttempts = sample.attempts.filter((attempt) =>
			FALLBACK_CAUSES.has(attempt.attempt_cause ?? ""),
		).length;
		if (FALLBACK_CAUSES.has(sample.request.attempt_cause ?? ""))
			row.outcomes.finalObservedCodexAttemptFallbacks++;
		row.outcomes.observedCodexFallbackAttempts += fallbackAttempts;
		const response = sample.response;
		if (!response) {
			row.unjoinedObservedCodexAttempts++;
			continue;
		}
		row.joinedObservedCodexResponses++;
		if (response.stop_reason === "error")
			row.outcomes.observedCodexErrorResponses++;
		if (
			Number(response.error_status) === 400 ||
			response.error_type === "http_400"
		)
			row.outcomes.observedCodex400Responses++;
		if (
			response.cache_measurement_available !== false &&
			safeTokenCount(response.input_tokens) &&
			safeTokenCount(response.cache_read_input_tokens) &&
			response.cache_read_input_tokens <= response.input_tokens
		) {
			const nextInputTokens = safeTokenSum(
				row.cache.inputTokens,
				response.input_tokens,
			);
			const nextCachedReadTokens = safeTokenSum(
				row.cache.cachedReadTokens,
				response.cache_read_input_tokens,
			);
			if (nextInputTokens === null || nextCachedReadTokens === null) {
				row.cache.overflowResponses++;
			} else {
				row.cache.measuredResponses++;
				row.cache.inputTokens = nextInputTokens;
				row.cache.cachedReadTokens = nextCachedReadTokens;
				if (response.cache_read_input_tokens > 0)
					row.cache.positiveHitResponses++;
			}
		} else {
			row.cache.unavailableResponses++;
		}
		if (!hasMeasuredCacheWrite(response)) {
			row.cache.cacheWriteUnavailableResponses++;
		} else {
			const nextCacheWriteTokens = safeTokenSum(
				row.cache.cacheWriteTokens,
				response.cache_creation_input_tokens ?? 0,
			);
			if (nextCacheWriteTokens === null) {
				row.cache.cacheWriteOverflowResponses++;
			} else {
				row.cache.cacheWriteMeasuredResponses++;
				row.cache.cacheWriteTokens = nextCacheWriteTokens;
			}
		}
		const requestTimestamp = sample.request.ts
			? Date.parse(sample.request.ts)
			: Number.NaN;
		const responseTimestamp = response.ts
			? Date.parse(response.ts)
			: Number.NaN;
		const observedElapsedMs = responseTimestamp - requestTimestamp;
		if (
			Number.isFinite(requestTimestamp) &&
			Number.isFinite(responseTimestamp) &&
			responseTimestamp >= requestTimestamp &&
			Number.isSafeInteger(observedElapsedMs)
		) {
			row.elapsed.availableResponses++;
			row.elapsedSamples.push(observedElapsedMs);
		} else {
			row.elapsed.unavailableResponses++;
		}
	}
	const finishedRows = [...rows.values()].map(finishCacheExperimentRow);
	finishedRows.sort(
		(a, b) =>
			ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm) ||
			a.model.localeCompare(b.model) ||
			TURN_ORDER.indexOf(a.turn) - TURN_ORDER.indexOf(b.turn) ||
			GAP_ORDER.indexOf(a.gapBand) - GAP_ORDER.indexOf(b.gapBand),
	);
	return { assignmentCounts, rows: finishedRows };
}

interface WebSocketExperimentRowAccumulator extends WebSocketExperimentRow {
	latencySamples: number[];
}

function webSocketObservationJoinKey(
	requestId: string,
	attemptId: string,
): string {
	return `${requestId.length}:${requestId}${attemptId.length}:${attemptId}`;
}

function webSocketRowAccumulator(
	observation: ParsedCodexWebSocketObservation,
): WebSocketExperimentRowAccumulator {
	return {
		assignment: observation.assignment,
		effectiveTransport: observation.effectiveTransport,
		action: observation.action,
		observations: 0,
		joinedTraceResponses: 0,
		unjoinedObservations: 0,
		cache: {
			measuredResponses: 0,
			unavailableResponses: 0,
			overflowResponses: 0,
			inputTokens: 0,
			cachedReadTokens: 0,
			weightedCachedReadPct: null,
			cacheWriteMeasuredResponses: 0,
			cacheWriteUnavailableResponses: 0,
			cacheWriteOverflowResponses: 0,
			cacheWriteTokens: 0,
		},
		latency: {
			availableResponses: 0,
			unavailableResponses: 0,
			p50Ms: null,
			p95Ms: null,
		},
		outcomes: {
			terminalResponses: 0,
			terminalErrors: 0,
			preWriteHttpFallbacks: 0,
			postWriteFailures: 0,
			fallbackCategories: {
				control: 0,
				pre_write: 0,
				post_write: 0,
				none: 0,
				other: 0,
			},
		},
		latencySamples: [],
	};
}

function webSocketFallbackCategory(
	observation: ParsedCodexWebSocketObservation,
): "control" | "downstream" | "pre_write" | "post_write" | "none" | "other" {
	if (
		observation.action === "downstream_cancelled" &&
		!observation.hasCloseCategory
	)
		return "downstream";
	if (!observation.hasFallback && !observation.hasCloseCategory) return "none";
	if (observation.assignment === "control") return "control";
	if (observation.effectiveTransport === "http" && !observation.frameWritten)
		return "pre_write";
	if (
		observation.effectiveTransport === "websocket" &&
		observation.frameWritten
	)
		return "post_write";
	return "other";
}

function finishWebSocketExperimentRow(
	row: WebSocketExperimentRowAccumulator,
): WebSocketExperimentRow {
	return {
		assignment: row.assignment,
		effectiveTransport: row.effectiveTransport,
		action: row.action,
		observations: row.observations,
		joinedTraceResponses: row.joinedTraceResponses,
		unjoinedObservations: row.unjoinedObservations,
		cache: {
			...row.cache,
			weightedCachedReadPct:
				row.cache.inputTokens > 0
					? Math.round(
							(row.cache.cachedReadTokens / row.cache.inputTokens) * 1000,
						) / 10
					: null,
		},
		latency: {
			availableResponses: row.latency.availableResponses,
			unavailableResponses: row.latency.unavailableResponses,
			p50Ms: percentile(row.latencySamples, 0.5),
			p95Ms: percentile(row.latencySamples, 0.95),
		},
		outcomes: {
			...row.outcomes,
			fallbackCategories: Object.fromEntries(
				Object.entries(row.outcomes.fallbackCategories).sort(([a], [b]) =>
					a.localeCompare(b),
				),
			),
		},
	};
}

function addWebSocketCacheMeasurement(
	row: WebSocketExperimentRowAccumulator,
	inputTokens: unknown,
	cachedReadTokens: unknown,
): void {
	if (
		!safeTokenCount(inputTokens) ||
		!safeTokenCount(cachedReadTokens) ||
		cachedReadTokens > inputTokens
	) {
		row.cache.unavailableResponses++;
		return;
	}
	const nextInput = safeTokenSum(row.cache.inputTokens, inputTokens);
	const nextRead = safeTokenSum(row.cache.cachedReadTokens, cachedReadTokens);
	if (nextInput === null || nextRead === null) {
		row.cache.overflowResponses++;
		return;
	}
	row.cache.measuredResponses++;
	row.cache.inputTokens = nextInput;
	row.cache.cachedReadTokens = nextRead;
}

function addWebSocketCacheWriteMeasurement(
	row: WebSocketExperimentRowAccumulator,
	available: boolean,
	cacheWriteTokens: unknown,
): void {
	if (!available || !safeTokenCount(cacheWriteTokens)) {
		row.cache.cacheWriteUnavailableResponses++;
		return;
	}
	const nextWrite = safeTokenSum(row.cache.cacheWriteTokens, cacheWriteTokens);
	if (nextWrite === null) {
		row.cache.cacheWriteOverflowResponses++;
		return;
	}
	row.cache.cacheWriteMeasuredResponses++;
	row.cache.cacheWriteTokens = nextWrite;
}

function analyzeWebSocketCacheExperiments(
	records: readonly TraceRecord[],
	parsed: ParsedCodexWebSocketObservations,
): WebSocketCacheExperimentReport {
	const observationGroups = new Map<
		string,
		ParsedCodexWebSocketObservation[]
	>();
	for (const observation of parsed.observations) {
		const key = webSocketObservationJoinKey(
			observation.requestId,
			observation.attemptId,
		);
		const group = observationGroups.get(key) ?? [];
		group.push(observation);
		observationGroups.set(key, group);
	}
	const uniqueObservations: ParsedCodexWebSocketObservation[] = [];
	let duplicateObservationGroups = 0;
	for (const group of observationGroups.values()) {
		if (group.length !== 1) {
			duplicateObservationGroups++;
			continue;
		}
		const observation = group[0];
		if (observation) uniqueObservations.push(observation);
	}

	const traceRequests = new Map<string, TraceRecord[]>();
	const traceResponses = new Map<string, TraceRecord[]>();
	for (const record of records) {
		if (
			typeof record.request_id !== "string" ||
			record.request_id.length === 0 ||
			typeof record.attempt_id !== "string" ||
			record.attempt_id.length === 0
		)
			continue;
		const key = webSocketObservationJoinKey(
			record.request_id,
			record.attempt_id,
		);
		appendRecord(
			(record.phase ?? "request") === "request"
				? traceRequests
				: traceResponses,
			key,
			record,
		);
	}

	const assignmentCounts: Record<WebSocketExperimentAssignment, number> = {
		control: 0,
		treatment: 0,
	};
	const effectiveTransportCounts: Record<WebSocketExperimentTransport, number> =
		{
			http: 0,
			websocket: 0,
		};
	const rows = new Map<string, WebSocketExperimentRowAccumulator>();
	let joinedObservations = 0;
	let unjoinedObservations = 0;
	let ambiguousTraceJoins = 0;
	for (const observation of uniqueObservations) {
		assignmentCounts[observation.assignment]++;
		effectiveTransportCounts[observation.effectiveTransport]++;
		const rowKey = [
			observation.assignment,
			observation.effectiveTransport,
			observation.action,
		].join("\u0000");
		let row = rows.get(rowKey);
		if (!row) {
			row = webSocketRowAccumulator(observation);
			rows.set(rowKey, row);
		}
		row.observations++;

		const joinKey = webSocketObservationJoinKey(
			observation.requestId,
			observation.attemptId,
		);
		const requests = traceRequests.get(joinKey) ?? [];
		const responses = traceResponses.get(joinKey) ?? [];
		if (requests.length !== 1 || responses.length !== 1) {
			if (requests.length > 1 || responses.length > 1) ambiguousTraceJoins++;
			unjoinedObservations++;
			row.unjoinedObservations++;
			continue;
		}
		const request = requests[0];
		const response = responses[0];
		if (!request || !response) {
			unjoinedObservations++;
			row.unjoinedObservations++;
			continue;
		}
		joinedObservations++;
		row.joinedTraceResponses++;
		row.outcomes.terminalResponses++;
		const downstreamCancellation =
			observation.action === "downstream_cancelled" &&
			!observation.hasCloseCategory;
		const postWriteFailure =
			!downstreamCancellation &&
			observation.effectiveTransport === "websocket" &&
			observation.frameWritten &&
			(observation.hasFallback || observation.hasCloseCategory);
		if (
			!downstreamCancellation &&
			(response.stop_reason === "error" || postWriteFailure)
		)
			row.outcomes.terminalErrors++;
		if (
			observation.assignment === "treatment" &&
			observation.effectiveTransport === "http" &&
			!observation.frameWritten &&
			observation.hasFallback
		)
			row.outcomes.preWriteHttpFallbacks++;
		if (postWriteFailure) row.outcomes.postWriteFailures++;
		increment(
			row.outcomes.fallbackCategories,
			webSocketFallbackCategory(observation),
		);

		if (observation.effectiveTransport === "websocket") {
			addWebSocketCacheMeasurement(
				row,
				observation.inputTokens,
				observation.cachedReadTokens,
			);
			addWebSocketCacheWriteMeasurement(
				row,
				observation.cacheWriteMeasurementAvailable,
				observation.cacheWriteTokens,
			);
			if (safeTokenCount(observation.terminalMs)) {
				row.latency.availableResponses++;
				row.latencySamples.push(observation.terminalMs);
			} else row.latency.unavailableResponses++;
		} else {
			addWebSocketCacheMeasurement(
				row,
				response.input_tokens,
				response.cache_read_input_tokens,
			);
			addWebSocketCacheWriteMeasurement(
				row,
				hasMeasuredCacheWrite(response),
				response.cache_creation_input_tokens,
			);
			const requestTimestamp = request.ts ? Date.parse(request.ts) : Number.NaN;
			const responseTimestamp = response.ts
				? Date.parse(response.ts)
				: Number.NaN;
			const elapsedMs = responseTimestamp - requestTimestamp;
			if (
				Number.isFinite(requestTimestamp) &&
				Number.isFinite(responseTimestamp) &&
				responseTimestamp >= requestTimestamp &&
				Number.isSafeInteger(elapsedMs)
			) {
				row.latency.availableResponses++;
				row.latencySamples.push(elapsedMs);
			} else row.latency.unavailableResponses++;
		}
	}

	const finishedRows = [...rows.values()].map(finishWebSocketExperimentRow);
	finishedRows.sort(
		(a, b) =>
			(a.assignment === b.assignment
				? 0
				: a.assignment === "control"
					? -1
					: 1) ||
			(a.effectiveTransport === b.effectiveTransport
				? 0
				: a.effectiveTransport === "http"
					? -1
					: 1) ||
			a.action.localeCompare(b.action),
	);
	return {
		attribution: {
			unit: "unique_ws_observation_exact_request_and_attempt_join",
			join: "one_request_and_one_response_with_exact_request_id_and_attempt_id",
			websocketCache: "terminal_transport_observation",
			httpCache: "joined_codex_trace_response",
			websocketLatency: "frame_write_to_terminal_observation_ms",
			httpLatency: "trace_response_ts_minus_trace_request_ts",
		},
		ingestion: {
			lines: parsed.diagnostics.lines,
			acceptedObservations: parsed.diagnostics.acceptedLines,
			ignoredLines: parsed.diagnostics.ignoredLines,
			malformedLines: parsed.diagnostics.malformedLines,
			futureSchemaLines: parsed.diagnostics.futureSchemaLines,
			uniqueObservations: uniqueObservations.length,
			duplicateObservationGroups,
			joinedObservations,
			unjoinedObservations,
			ambiguousTraceJoins,
		},
		assignmentCounts,
		effectiveTransportCounts,
		rows: finishedRows,
	};
}

/**
 * Privacy-safe, opt-in cache experiment analysis. Cohort hashes and join IDs
 * are used only in-memory and never appear in the returned report.
 */
export function analyzeCodexCacheExperiments(
	records: readonly TraceRecord[],
	websocketObservations = emptyParsedCodexWebSocketObservations(),
): CodexCacheExperimentReport {
	const samples = cacheExperimentLogicalSamples(records);
	return {
		schemaVersion: 1,
		attribution: {
			unit: "final_observed_codex_attempt",
			responseScope: "codex_trace_only_no_cross_provider_terminal_visibility",
			elapsed:
				"observed_codex_response_ts_minus_observed_codex_attempt_request_ts",
			gap: "prior_observed_codex_request_ts_in_same_trace_and_valid_cohort",
			pacingWaitMs: "unavailable",
			pacingWaitReason: "trace_has_action_but_no_wait_duration",
		},
		pacing: cacheExperimentDimension(samples, "pacing"),
		explicitBreakpoint: cacheExperimentDimension(samples, "explicitBreakpoint"),
		websocket: analyzeWebSocketCacheExperiments(records, websocketObservations),
	};
}

export function analyzeCodexTrace(
	records: readonly TraceRecord[],
): TraceReport {
	const timestamps: string[] = [];
	const requestRecords = records.filter(
		(record) => (record.phase ?? "request") === "request",
	);
	const responseRecords = records.filter(
		(record) => record.phase === "response",
	);
	const logicalIds = new Set(
		requestRecords
			.map((record) => record.request_id)
			.filter((id): id is string => Boolean(id)),
	);
	const requestsByLogicalId = new Map<string, TraceRecord[]>();
	for (const request of requestRecords) {
		if (!request.request_id) continue;
		const group = requestsByLogicalId.get(request.request_id) ?? [];
		group.push(request);
		requestsByLogicalId.set(request.request_id, group);
	}
	const requestsByAttemptId = new Map<string, TraceRecord[]>();
	const responsesByAttemptId = new Map<string, TraceRecord[]>();
	const legacyRequestsByLogicalId = new Map<string, TraceRecord[]>();
	const legacyResponsesByLogicalId = new Map<string, TraceRecord[]>();
	let schema9MissingAttemptId = 0;
	for (const request of requestRecords) {
		if (!request.attempt_id && !isLegacyJoinEligible(request)) {
			schema9MissingAttemptId++;
			continue;
		}
		const map = request.attempt_id
			? requestsByAttemptId
			: legacyRequestsByLogicalId;
		const id = request.attempt_id ?? request.request_id;
		if (!id) continue;
		const group = map.get(id) ?? [];
		group.push(request);
		map.set(id, group);
	}
	for (const response of responseRecords) {
		if (!response.attempt_id && !isLegacyJoinEligible(response)) {
			schema9MissingAttemptId++;
			continue;
		}
		const map = response.attempt_id
			? responsesByAttemptId
			: legacyResponsesByLogicalId;
		const id = response.attempt_id ?? response.request_id;
		if (!id) continue;
		const group = map.get(id) ?? [];
		group.push(response);
		map.set(id, group);
	}
	let missingJoins =
		records.filter((record) => !record.request_id && !record.attempt_id)
			.length + schema9MissingAttemptId;
	let ambiguousJoins = 0;
	const countJoinQuality = (
		requests: ReadonlyMap<string, TraceRecord[]>,
		responses: ReadonlyMap<string, TraceRecord[]>,
	) => {
		for (const id of new Set([...requests.keys(), ...responses.keys()])) {
			const requestCount = requests.get(id)?.length ?? 0;
			const responseCount = responses.get(id)?.length ?? 0;
			if (requestCount === 0 || responseCount === 0) {
				missingJoins += Math.max(requestCount, responseCount);
			} else if (requestCount !== 1 || responseCount !== 1) {
				ambiguousJoins++;
			}
		}
	};
	countJoinQuality(requestsByAttemptId, responsesByAttemptId);
	countJoinQuality(legacyRequestsByLogicalId, legacyResponsesByLogicalId);
	const measuredStats = (samples: readonly TraceRecord[]) => {
		let input = 0;
		let cacheRead = 0;
		let measuredResponses = 0;
		for (const sample of samples) {
			if (
				sample.cache_measurement_available === false ||
				typeof sample.cache_read_input_tokens !== "number" ||
				typeof sample.input_tokens !== "number"
			)
				continue;
			const sampleInput = sample.input_tokens;
			input += sampleInput;
			cacheRead += Math.min(
				Math.max(sample.cache_read_input_tokens, 0),
				sampleInput,
			);
			measuredResponses++;
		}
		return {
			measuredResponses,
			weightedCacheReusePct:
				input > 0 ? Math.round((1000 * cacheRead) / input) / 10 : null,
		};
	};
	const finalResponses: TraceRecord[] = [];
	for (const [logicalId, attempts] of requestsByLogicalId) {
		const ordered = [...attempts].sort(
			(a, b) =>
				(a.attempt_ordinal ?? 0) - (b.attempt_ordinal ?? 0) ||
				(a.ts ?? "").localeCompare(b.ts ?? ""),
		);
		const finalAttempt = ordered.at(-1);
		const attemptResponses = finalAttempt?.attempt_id
			? responsesByAttemptId.get(finalAttempt.attempt_id)
			: undefined;
		const joined = finalAttempt?.attempt_id
			? (requestsByAttemptId.get(finalAttempt.attempt_id)?.length ?? 0) === 1 &&
				attemptResponses?.length === 1
				? attemptResponses[0]
				: undefined
			: attempts.length === 1 &&
					(legacyResponsesByLogicalId.get(logicalId)?.length ?? 0) === 1
				? legacyResponsesByLogicalId.get(logicalId)?.[0]
				: undefined;
		if (joined) finalResponses.push(joined);
	}
	const timestampsByKey = new Map<string, number[]>();
	for (const request of requestRecords) {
		if (!request.prompt_cache_key_id || !request.ts) continue;
		const timestamp = Date.parse(request.ts);
		if (!Number.isFinite(timestamp)) continue;
		const timestamps = timestampsByKey.get(request.prompt_cache_key_id) ?? [];
		timestamps.push(timestamp);
		timestampsByKey.set(request.prompt_cache_key_id, timestamps);
	}
	const concentration: number[] = [];
	let maxRequestsPerKeyMinute = 0;
	for (const timestamps of timestampsByKey.values()) {
		timestamps.sort((a, b) => a - b);
		let left = 0;
		let maximum = 0;
		for (let right = 0; right < timestamps.length; right++) {
			while ((timestamps[right] ?? 0) - (timestamps[left] ?? 0) >= 60_000)
				left++;
			maximum = Math.max(maximum, right - left + 1);
		}
		concentration.push(maximum);
		maxRequestsPerKeyMinute = Math.max(maxRequestsPerKeyMinute, maximum);
	}
	const attemptInclusiveResponses: TraceRecord[] = [];
	const collectUnambiguousJoins = (
		requests: ReadonlyMap<string, TraceRecord[]>,
		responses: ReadonlyMap<string, TraceRecord[]>,
	) => {
		for (const [id, requestGroup] of requests) {
			const response =
				responses.get(id)?.length === 1 ? responses.get(id)?.[0] : undefined;
			if (requestGroup.length === 1 && response) {
				attemptInclusiveResponses.push(response);
			}
		}
	};
	collectUnambiguousJoins(requestsByAttemptId, responsesByAttemptId);
	collectUnambiguousJoins(
		legacyRequestsByLogicalId,
		legacyResponsesByLogicalId,
	);
	const sessions = new Map<string, number>();
	const requestKeySetByAttemptId = new Map<string, boolean>();
	const legacyRequestKeySetByLogicalId = new Map<string, boolean>();
	let maxHistoryToolCalls = 0;
	let maxInputItems = 0;
	let maxApproxInputChars = 0;
	let totalNudges = 0;
	for (const request of requestRecords) {
		if (request.ts) timestamps.push(request.ts);
		maxHistoryToolCalls = Math.max(
			maxHistoryToolCalls,
			request.history_function_call_count ?? 0,
		);
		maxInputItems = Math.max(maxInputItems, request.input_item_count ?? 0);
		maxApproxInputChars = Math.max(
			maxApproxInputChars,
			request.approx_input_chars ?? 0,
		);
		totalNudges += request.nudge_count ?? 0;
		if (request.attempt_id) {
			const requests = requestsByAttemptId.get(request.attempt_id) ?? [];
			if (requests.length === 1) {
				requestKeySetByAttemptId.set(
					request.attempt_id,
					request.prompt_cache_key_set === true,
				);
			}
		} else if (request.request_id) {
			const requests = legacyRequestsByLogicalId.get(request.request_id) ?? [];
			if (requests.length === 1) {
				legacyRequestKeySetByLogicalId.set(
					request.request_id,
					request.prompt_cache_key_set === true,
				);
			}
		}
		if (request.session_key_hash)
			sessions.set(
				request.session_key_hash,
				(sessions.get(request.session_key_hash) ?? 0) + 1,
			);
	}
	const fingerprintCoverage = {
		usable: requestRecords.filter(
			(request) => (request.input_item_fingerprints?.length ?? 0) > 0,
		).length,
		missing: requestRecords.filter(
			(request) => (request.input_item_fingerprints?.length ?? 0) === 0,
		).length,
		truncated: requestRecords.filter(
			(request) => request.input_item_fingerprints_truncated === true,
		).length,
	};
	const transitions = analyzeRequestTransitions(requestRecords);
	const newFanOutHistogram: Record<string, number> = {};
	const newToolUseByName: Record<string, number> = {};
	const stopReasons: Record<string, number> = {};
	const errors: Record<string, number> = {};
	const errorCodes: Record<string, number> = {};
	const errorStatuses: Record<string, number> = {};
	const contextBands = {
		under50: contextBandAccumulator(),
		from50To80: contextBandAccumulator(),
		from80To95: contextBandAccumulator(),
		atLeast95: contextBandAccumulator(),
		unavailable: contextBandAccumulator(),
	};
	const usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		availableResponses: 0,
		unavailableResponses: 0,
	};
	let cacheMeasuredInputTokens = 0;
	const cachePcts: number[] = [];
	const cohortSamples = {
		keyOn: [] as Array<{ pct: number | null; inputTokens: number }>,
		keyOff: [] as Array<{ pct: number | null; inputTokens: number }>,
	};
	const worstRespawns: TraceReport["response"]["worstRespawns"] = [];
	let totalNewToolCalls = 0;
	let maxNewFanOut = 0;
	let totalSubagentSpawns = 0;
	let maxSubagentSpawns = 0;
	let textOnlyResponses = 0;
	let unjoinedResponses = 0;
	let respawnResponses = 0;
	let zeroCacheResponses = 0;
	for (const response of responseRecords) {
		if (response.ts) timestamps.push(response.ts);
		const newCalls = response.new_tool_call_count ?? 0;
		totalNewToolCalls += newCalls;
		maxNewFanOut = Math.max(maxNewFanOut, newCalls);
		newFanOutHistogram[String(newCalls)] =
			(newFanOutHistogram[String(newCalls)] ?? 0) + 1;
		for (const [name, count] of Object.entries(
			response.new_tool_use_by_name ?? {},
		))
			newToolUseByName[name] = (newToolUseByName[name] ?? 0) + count;
		const spawns =
			response.new_subagent_spawn_count ??
			(response.new_tool_use_by_name?.Task ?? 0) +
				(response.new_tool_use_by_name?.Agent ?? 0);
		totalSubagentSpawns += spawns;
		maxSubagentSpawns = Math.max(maxSubagentSpawns, spawns);
		const stop = response.stop_reason ?? "unknown";
		stopReasons[stop] = (stopReasons[stop] ?? 0) + 1;
		if (stop === "end_turn" && newCalls === 0) textOnlyResponses++;
		if (stop === "error") {
			const type = response.error_type || "unclassified_upstream_error";
			errors[type] = (errors[type] ?? 0) + 1;
			if (response.error_code)
				errorCodes[response.error_code] =
					(errorCodes[response.error_code] ?? 0) + 1;
			if (response.error_status)
				errorStatuses[response.error_status] =
					(errorStatuses[response.error_status] ?? 0) + 1;
		}
		const input = response.input_tokens ?? 0;
		const hasCacheRead =
			response.cache_measurement_available !== false &&
			typeof response.input_tokens === "number" &&
			typeof response.cache_read_input_tokens === "number";
		const cacheRead = hasCacheRead
			? Math.min(Math.max(response.cache_read_input_tokens ?? 0, 0), input)
			: 0;
		if (response.usage_measurement_available === false) {
			usage.unavailableResponses++;
		} else if (typeof response.input_tokens === "number") {
			usage.availableResponses++;
			usage.inputTokens += input;
			usage.outputTokens += response.output_tokens ?? 0;
			if (hasMeasuredCacheWrite(response)) {
				usage.cacheCreationInputTokens +=
					response.cache_creation_input_tokens ?? 0;
			}
		} else {
			usage.unavailableResponses++;
		}
		usage.cacheReadInputTokens += cacheRead;
		if (hasCacheRead) cacheMeasuredInputTokens += input;
		if (hasCacheRead && cacheRead === 0) zeroCacheResponses++;
		if (typeof response.cache_hit_pct === "number")
			cachePcts.push(response.cache_hit_pct);
		const utilization = response.context_utilization_pct;
		const contextBand =
			typeof utilization !== "number"
				? contextBands.unavailable
				: utilization < 50
					? contextBands.under50
					: utilization < 80
						? contextBands.from50To80
						: utilization < 95
							? contextBands.from80To95
							: contextBands.atLeast95;
		contextBand.responses++;
		contextBand.terminals[stop] = (contextBand.terminals[stop] ?? 0) + 1;
		if (hasCacheRead) {
			if (cacheRead === 0) contextBand.zeroCacheResponses++;
			contextBand.inputTokens += input;
			contextBand.cacheReadInputTokens += cacheRead;
		}
		const keySet = response.attempt_id
			? (responsesByAttemptId.get(response.attempt_id)?.length ?? 0) === 1
				? requestKeySetByAttemptId.get(response.attempt_id)
				: undefined
			: response.request_id &&
					(legacyResponsesByLogicalId.get(response.request_id)?.length ?? 0) ===
						1
				? legacyRequestKeySetByLogicalId.get(response.request_id)
				: undefined;
		if (keySet === undefined) unjoinedResponses++;
		else
			cohortSamples[keySet ? "keyOn" : "keyOff"].push({
				pct:
					typeof response.cache_hit_pct === "number"
						? response.cache_hit_pct
						: null,
				inputTokens: input,
			});
		const duplicateCounts = new Map<string, number>();
		for (const call of response.new_tool_calls ?? [])
			duplicateCounts.set(
				keyOf(call),
				(duplicateCounts.get(keyOf(call)) ?? 0) + 1,
			);
		let hasRespawn = false;
		for (const [tool, count] of duplicateCounts)
			if (count > 1) {
				hasRespawn = true;
				worstRespawns.push({
					request_id: response.request_id ?? null,
					tool,
					count,
				});
			}
		if (hasRespawn) respawnResponses++;
	}
	timestamps.sort();
	worstRespawns.sort((a, b) => b.count - a.count);
	const topSessions = [...sessions.entries()]
		.map(([session, requests]) => ({ session, requests }))
		.sort((a, b) => b.requests - a.requests)
		.slice(0, 5);
	return {
		requests: requestRecords.length,
		responses: responseRecords.length,
		logicalRequests:
			logicalIds.size +
			requestRecords.filter((record) => !record.request_id).length,
		attempts: requestRecords.length,
		joins: {
			missing: missingJoins,
			ambiguous: ambiguousJoins,
			schema9MissingAttemptId,
		},
		cacheDenominators: {
			attemptInclusive: measuredStats(attemptInclusiveResponses),
			finalResponseOnly: measuredStats(finalResponses),
		},
		readiness: {
			treatmentAbsent: !requestRecords.some(
				(request) => request.cache_key_assignment === "session",
			),
			assignmentEffectiveCrossovers: requestRecords.filter(
				(request) =>
					request.cache_key_assignment !== null &&
					request.cache_key_assignment !== undefined &&
					request.cache_key_mode !== null &&
					request.cache_key_mode !== undefined &&
					request.cache_key_assignment !== request.cache_key_mode,
			).length,
			maxRequestsPerKeyMinute,
			keysOver15RequestsPerMinute: concentration.filter((count) => count > 15)
				.length,
		},
		span: { first: timestamps[0], last: timestamps.at(-1) },
		canary: analyzeCanary(requestRecords, responseRecords),
		request: {
			maxHistoryToolCalls,
			maxInputItems,
			maxApproxInputChars,
			totalNudges,
			distinctSessions: sessions.size,
			topSessions,
			fingerprintCoverage,
			...transitions,
		},
		response: {
			totalNewToolCalls,
			maxNewFanOut,
			totalSubagentSpawns,
			maxSubagentSpawns,
			cacheCohorts: {
				keyOn: cohortStats(cohortSamples.keyOn),
				keyOff: cohortStats(cohortSamples.keyOff),
			},
			unjoinedResponses,
			newFanOutHistogram,
			newToolUseByName,
			stopReasons,
			textOnlyResponses,
			errors,
			errorCodes,
			errorStatuses,
			cacheHitPctAvg: average(cachePcts),
			weightedCacheReusePct:
				cacheMeasuredInputTokens > 0
					? Math.round(
							(1000 * usage.cacheReadInputTokens) / cacheMeasuredInputTokens,
						) / 10
					: null,
			zeroCacheResponses,
			contextBands: {
				under50: finishContextBand(contextBands.under50),
				from50To80: finishContextBand(contextBands.from50To80),
				from80To95: finishContextBand(contextBands.from80To95),
				atLeast95: finishContextBand(contextBands.atLeast95),
				unavailable: finishContextBand(contextBands.unavailable),
			},
			usage,
			respawnResponses,
			worstRespawns: worstRespawns.slice(0, 15),
		},
	};
}

export function parseTraceJsonl(text: string): TraceRecord[] {
	const records: TraceRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				continue;
			}
			records.push(parsed as TraceRecord);
		} catch {
			/* skip malformed lines */
		}
	}
	return records;
}

function formatCanaryArm(name: string, arm: CanaryArmStats): string[] {
	return [
		`  ${name}: assigned=${arm.assignedRequests} joined=${arm.joinedTerminalResponses} missing-terminal=${arm.missingTerminalRequests}`,
		`    cache measured: ${arm.cacheMeasuredResponses}; weighted reuse: ${arm.weightedCacheReusePct ?? "n/a"}%`,
		`    attempt-inclusive: attempts=${arm.attemptInclusive.attempts} joined=${arm.attemptInclusive.joinedResponses} measured=${arm.attemptInclusive.cacheMeasuredResponses} weighted reuse=${arm.attemptInclusive.weightedCacheReusePct ?? "n/a"}%`,
		`    cache positive: ${arm.cachePositiveResponses}/${arm.cacheMeasuredResponses} measured (${arm.cachePositiveRatePct ?? "n/a"}%)`,
		`    terminals: ${JSON.stringify(arm.terminals)}`,
		`    effective modes: ${JSON.stringify(arm.effectiveModes)}`,
		`    explicit crossovers: conversation->session=${arm.explicitCrossovers.conversationToSession}, session->conversation=${arm.explicitCrossovers.sessionToConversation}`,
		`    usage: ${JSON.stringify(arm.usage)}`,
		`    models: ${JSON.stringify(arm.models)}`,
		`    accounts: ${JSON.stringify(arm.accounts)}`,
		`    logical conversations: ${arm.logicalConversations}`,
		`    first requests: ${JSON.stringify(arm.turns.first)}`,
		`    cache-eligible follow-ups: ${JSON.stringify(arm.turns.followUp)}`,
		`    observed conversation-turn bands: ${JSON.stringify(arm.conversationTurnBands)}`,
	];
}

export function formatReport(report: TraceReport): string {
	const lines = [
		`FINGERPRINT AVAILABILITY: usable=${report.request.fingerprintCoverage.usable} missing=${report.request.fingerprintCoverage.missing} truncated=${report.request.fingerprintCoverage.truncated}`,
		`span              : ${report.span.first ?? "?"} -> ${report.span.last ?? "?"}`,
		`logical requests  : ${report.logicalRequests}`,
		`physical attempts : ${report.attempts}`,
		`request records   : ${report.requests}`,
		`response records  : ${report.responses}`,
		`joins             : missing=${report.joins.missing} ambiguous=${report.joins.ambiguous} schema9-missing-attempt-id=${report.joins.schema9MissingAttemptId}`,
		`cache denominators: final=${JSON.stringify(report.cacheDenominators.finalResponseOnly)} attempts=${JSON.stringify(report.cacheDenominators.attemptInclusive)}`,
		`experiment ready  : treatment-absent=${report.readiness.treatmentAbsent} crossovers=${report.readiness.assignmentEffectiveCrossovers}`,
		`key concentration : max=${report.readiness.maxRequestsPerKeyMinute}/min keys-over-15=${report.readiness.keysOver15RequestsPerMinute}`,
		"",
		"REQUEST (historical replay load, NOT new fan-out):",
		`  max history tool calls/req : ${report.request.maxHistoryToolCalls}`,
		`  max input items/req        : ${report.request.maxInputItems}`,
		`  max approx input chars/req : ${report.request.maxApproxInputChars}`,
		`  nudges injected            : ${report.request.totalNudges}`,
		`  prefix transitions         : ${JSON.stringify(report.request.prefixTransitions)}`,
		`  instruction stability      : ${JSON.stringify(report.request.instructionStability)}`,
		`  tool stability             : ${JSON.stringify(report.request.toolStability)}`,
		"",
		"RESPONSE (newly emitted this turn, the real fan-out signal):",
		`  total new tool calls       : ${report.response.totalNewToolCalls}`,
		`  max NEW fan-out / response : ${report.response.maxNewFanOut}`,
		`  new fan-out histogram      : ${JSON.stringify(report.response.newFanOutHistogram)}`,
		`  new tool use by name       : ${JSON.stringify(report.response.newToolUseByName)}`,
		`  stop_reason distribution   : ${JSON.stringify(report.response.stopReasons)}`,
		`  text-only responses        : ${report.response.textOnlyResponses}`,
		`  context bands              : ${JSON.stringify(report.response.contextBands)}`,
		`  upstream errors            : ${JSON.stringify(report.response.errors)}`,
		`  upstream error codes       : ${JSON.stringify(report.response.errorCodes)}`,
		`  upstream error statuses    : ${JSON.stringify(report.response.errorStatuses)}`,
		`  avg cache hit %            : ${report.response.cacheHitPctAvg ?? "n/a"}`,
		`  weighted cache reuse %     : ${report.response.weightedCacheReusePct ?? "n/a"}`,
		`  zero-cache responses       : ${report.response.zeroCacheResponses}`,
		`  usage totals               : ${JSON.stringify(report.response.usage)}`,
		`  subagent spawns            : total ${report.response.totalSubagentSpawns}, max/response ${report.response.maxSubagentSpawns}`,
		"  CACHE COHORTS (by prompt_cache_key on request):",
		`    key ON : ${JSON.stringify(report.response.cacheCohorts.keyOn)}`,
		`    key OFF: ${JSON.stringify(report.response.cacheCohorts.keyOff)}`,
		`    unjoined responses: ${report.response.unjoinedResponses}`,
		`  sessions                   : ${report.request.distinctSessions} distinct; top ${report.request.topSessions
			.map((session) => `${session.session.slice(0, 8)}=${session.requests}`)
			.join(", ")}`,
		`  RE-SPAWN responses         : ${report.response.respawnResponses}`,
		"",
		"CONVERSATION VS SESSION CANARY (intention-to-treat):",
		...formatCanaryArm("conversation", report.canary.conversation),
		...formatCanaryArm("session", report.canary.session),
		...formatCanaryArm("unassigned compatibility", report.canary.unassigned),
		`  unjoined responses: ${report.canary.unjoinedResponses}`,
	];
	if (report.response.worstRespawns.length > 0) {
		lines.push("  worst within-response re-spawns:");
		for (const respawn of report.response.worstRespawns) {
			lines.push(
				`    x${respawn.count}  req=${respawn.request_id ?? "?"}  ${respawn.tool}`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * Format only aggregate cache-experiment metrics. Unlike the legacy diagnostic
 * report, this intentionally has no request IDs, cohort hashes, cache keys, or
 * tool-call previews.
 */
export function formatCacheExperimentReport(
	report: CodexCacheExperimentReport,
): string {
	const lines = [
		"CODEX CACHE EXPERIMENTS",
		`attribution: unit=${report.attribution.unit} scope=${report.attribution.responseScope} elapsed=${report.attribution.elapsed} gap=${report.attribution.gap} pacing_wait_ms=${report.attribution.pacingWaitMs}`,
	];
	const append = (name: string, dimension: CacheExperimentDimensionReport) => {
		lines.push(
			"",
			`${name}: assignments=${JSON.stringify(dimension.assignmentCounts)}`,
		);
		for (const row of dimension.rows) lines.push(`  ${JSON.stringify(row)}`);
	};
	append("PACING BYPASS CANARY", report.pacing);
	append("EXPLICIT BREAKPOINT CANARY", report.explicitBreakpoint);
	lines.push(
		"",
		`WEBSOCKET TRANSPORT CANARY: assignments=${JSON.stringify(report.websocket.assignmentCounts)} effective_transports=${JSON.stringify(report.websocket.effectiveTransportCounts)} ingestion=${JSON.stringify(report.websocket.ingestion)}`,
	);
	for (const row of report.websocket.rows)
		lines.push(`  ${JSON.stringify(row)}`);
	return lines.join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const cacheExperiments = args.includes("--cache-experiments");
	let websocketObservationsFile: string | undefined;
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--cache-experiments") continue;
		if (arg === "--ws-observations") {
			websocketObservationsFile = args[index + 1];
			index++;
			continue;
		}
		if (arg) files.push(arg);
	}
	const file = files[0];
	if (
		!file ||
		files.length !== 1 ||
		(args.includes("--ws-observations") && !websocketObservationsFile) ||
		(websocketObservationsFile !== undefined && !cacheExperiments)
	) {
		console.error(
			"usage: bun run analyze-trace.ts [--cache-experiments [--ws-observations <codex-ws-observations.jsonl>]] <codex-trace.jsonl>",
		);
		process.exit(1);
	}
	const records = parseTraceJsonl(readFileSync(file, "utf8"));
	const websocketObservations = websocketObservationsFile
		? parseCodexWebSocketObservationsJsonl(
				readFileSync(websocketObservationsFile, "utf8"),
			)
		: emptyParsedCodexWebSocketObservations();
	console.log(
		cacheExperiments
			? formatCacheExperimentReport(
					analyzeCodexCacheExperiments(records, websocketObservations),
				)
			: formatReport(analyzeCodexTrace(records)),
	);
}
