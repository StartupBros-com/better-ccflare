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
}

export interface TraceReport {
	requests: number;
	responses: number;
	logicalRequests: number;
	attempts: number;
	joins: { missing: number; ambiguous: number };
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

interface CanaryArmAccumulator extends Omit<CanaryArmStats, "turns"> {
	measuredInputTokens: number;
	conversationIds: Set<string>;
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
	};
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
		else if (request.request_id)
			append(legacyRequestsByLogicalId, request.request_id, request);
	}
	for (const response of responseRecords) {
		if (response.attempt_id)
			append(responseAttemptsById, response.attempt_id, response);
		else if (response.request_id)
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
		if (!request.request_id) return undefined;
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
			arm.usage.cacheCreationInputTokens +=
				response.cache_creation_input_tokens ?? 0;
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
	for (const request of requestRecords) {
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
		const map = response.attempt_id
			? responsesByAttemptId
			: legacyResponsesByLogicalId;
		const id = response.attempt_id ?? response.request_id;
		if (!id) continue;
		const group = map.get(id) ?? [];
		group.push(response);
		map.set(id, group);
	}
	let missingJoins = records.filter(
		(record) => !record.request_id && !record.attempt_id,
	).length;
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
			const responseGroup = responses.get(id);
			if (requestGroup.length === 1 && responseGroup?.length === 1) {
				attemptInclusiveResponses.push(responseGroup[0]!);
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
			usage.cacheCreationInputTokens +=
				response.cache_creation_input_tokens ?? 0;
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
		joins: { missing: missingJoins, ambiguous: ambiguousJoins },
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
		`joins             : missing=${report.joins.missing} ambiguous=${report.joins.ambiguous}`,
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

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: bun run analyze-trace.ts <codex-trace.jsonl>");
		process.exit(1);
	}
	console.log(
		formatReport(
			analyzeCodexTrace(parseTraceJsonl(readFileSync(file, "utf8"))),
		),
	);
}
