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
	model_in?: string | null;
	model_out?: string | null;
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
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
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

export interface TraceReport {
	requests: number;
	responses: number;
	span: { first?: string; last?: string };
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
	const sessions = new Map<string, number>();
	const requestKeySetById = new Map<string, boolean>();
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
		if (request.request_id)
			requestKeySetById.set(
				request.request_id,
				request.prompt_cache_key_set === true,
			);
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
		const hasCacheRead = typeof response.cache_read_input_tokens === "number";
		const cacheRead = hasCacheRead
			? Math.min(Math.max(response.cache_read_input_tokens ?? 0, 0), input)
			: 0;
		usage.inputTokens += input;
		usage.outputTokens += response.output_tokens ?? 0;
		usage.cacheReadInputTokens += cacheRead;
		usage.cacheCreationInputTokens += response.cache_creation_input_tokens ?? 0;
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
		const keySet = response.request_id
			? requestKeySetById.get(response.request_id)
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
		span: { first: timestamps[0], last: timestamps.at(-1) },
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

export function formatReport(report: TraceReport): string {
	const lines = [
		`FINGERPRINT AVAILABILITY: usable=${report.request.fingerprintCoverage.usable} missing=${report.request.fingerprintCoverage.missing} truncated=${report.request.fingerprintCoverage.truncated}`,
		`span              : ${report.span.first ?? "?"} -> ${report.span.last ?? "?"}`,
		`request records   : ${report.requests}`,
		`response records  : ${report.responses}`,
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
