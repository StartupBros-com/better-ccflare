/**
 * Codex trace, permanent, env-gated observability for request translation and
 * response streaming.
 *
 * The Codex path can spawn far more subagent turns, and cache far worse, than the
 * native Anthropic path. Production payload capture is usually off, so this
 * writes JSONL records that make a live session inspectable offline.
 *
 * Request records summarize historical tool-call load replayed into Codex.
 * Response records summarize newly emitted tool calls from the current Codex
 * response, which is the real signal for fresh subagent fan-out.
 *
 * Enable:
 *   CCFLARE_CODEX_TRACE_DIR=/path/to/dir     # summaries only, no prompt content
 *   CCFLARE_CODEX_TRACE_FULL=1               # also embed full request bodies
 *
 * Tracing is best-effort and MUST never affect the request path: all I/O is
 * wrapped so a trace failure is swallowed.
 */
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";

export const CODEX_TRACE_DIR_ENV = "CCFLARE_CODEX_TRACE_DIR";
export const CODEX_TRACE_FULL_ENV = "CCFLARE_CODEX_TRACE_FULL";
export const CODEX_TRACE_HMAC_KEY_ENV = "CCFLARE_CODEX_TRACE_HMAC_KEY";
/** Warn when one response spawns at least this many subagents (0 disables). */
export const CODEX_FANOUT_WARN_ENV = "CCFLARE_CODEX_FANOUT_WARN";

const TRACE_SCHEMA_VERSION = 9;
const DEFAULT_FANOUT_WARN = 8;
const MAX_INPUT_ITEM_FINGERPRINTS = 64;
/**
 * Tool names that spawn subagents in Claude Code ("Task" historically,
 * "Agent" in current clients). Fan-out through these compounds recursively,
 * so they get dedicated telemetry.
 */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

const log = new Logger("CodexTrace");

const CONTINUATION_NUDGE_MARKER = "Continue the user's original request now";

export interface ToolCallSummary {
	name: string;
	arg_preview: string;
}

export interface CodexTransformSummary {
	input_item_count: number;
	input_bytes: number;
	input_hmac: string | null;
	input_except_last_item_bytes: number | null;
	input_except_last_item_hmac: string | null;
	input_first_item_bytes: number | null;
	input_first_item_hmac: string | null;
	/**
	 * Cumulative keyed fingerprints at input-item boundaries. Matching an earlier
	 * final boundary to a later boundary proves the whole serialized item prefix is
	 * identical without retaining content. Only the newest boundaries are retained.
	 */
	input_item_fingerprints: Array<{
		index: number;
		bytes: number;
		hmac: string;
	}>;
	input_item_total_count: number;
	input_item_fingerprints_truncated: boolean;
	/** Historical tool calls replayed into this request, NOT newly emitted calls. */
	history_function_call_count: number;
	history_function_call_output_count: number;
	history_empty_output_count: number;
	nudge_count: number;
	history_tool_use_by_name: Record<string, number>;
	/** name + short argument preview per historical call, useful for debugging history bloat. */
	history_tool_calls: ToolCallSummary[];
}

export interface CodexResponseSummary {
	new_tool_call_count: number;
	/** Newly emitted Task/Agent calls: the recursive fan-out signal. */
	new_subagent_spawn_count: number;
	new_tool_use_by_name: Record<string, number>;
	new_tool_calls: ToolCallSummary[];
	stop_reason: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "error";
	usage_measurement_available: boolean;
	cache_measurement_available: boolean;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cache_hit_pct: number | null;
	error_type?: string;
	error_message?: string;
	error_code?: string;
	error_status?: string;
}

/**
 * Pure summarizer over the Codex `input` array. No I/O, no env — unit-testable.
 */
export function summarizeCodexTransform(
	codexInput: readonly unknown[],
): CodexTransformSummary {
	let function_call_count = 0;
	let function_call_output_count = 0;
	let empty_output_count = 0;
	let nudge_count = 0;
	const tool_use_by_name: Record<string, number> = {};
	const tool_calls: Array<{ name: string; arg_preview: string }> = [];

	for (const item of codexInput) {
		if (!item || typeof item !== "object") continue;
		const it = item as Record<string, unknown>;

		if (it.type === "function_call") {
			function_call_count++;
			const name = typeof it.name === "string" ? it.name : "?";
			tool_use_by_name[name] = (tool_use_by_name[name] ?? 0) + 1;
			const args = typeof it.arguments === "string" ? it.arguments : "";
			tool_calls.push({ name, arg_preview: args.slice(0, 120) });
		} else if (it.type === "function_call_output") {
			function_call_output_count++;
			const output = typeof it.output === "string" ? it.output : "";
			if (output.length === 0) empty_output_count++;
		} else if (it.role === "user" && Array.isArray(it.content)) {
			const hasNudge = (it.content as Array<Record<string, unknown>>).some(
				(c) =>
					typeof c?.text === "string" &&
					(c.text as string).includes(CONTINUATION_NUDGE_MARKER),
			);
			if (hasNudge) nudge_count++;
		}
	}

	const fullInput = serializedMetrics(codexInput);
	const inputExceptLastItem =
		codexInput.length > 1 ? serializedMetrics(codexInput.slice(0, -1)) : null;
	const firstInputItem =
		codexInput.length > 0 ? serializedMetrics(codexInput[0]) : null;
	const inputItemFingerprints = prefixBoundaryFingerprints(codexInput);

	return {
		input_item_count: codexInput.length,
		input_bytes: fullInput.bytes,
		input_hmac: fullInput.hmac,
		input_except_last_item_bytes: inputExceptLastItem?.bytes ?? null,
		input_except_last_item_hmac: inputExceptLastItem?.hmac ?? null,
		input_first_item_bytes: firstInputItem?.bytes ?? null,
		input_first_item_hmac: firstInputItem?.hmac ?? null,
		input_item_fingerprints: inputItemFingerprints,
		input_item_total_count: codexInput.length,
		input_item_fingerprints_truncated:
			codexInput.length > MAX_INPUT_ITEM_FINGERPRINTS,
		history_function_call_count: function_call_count,
		history_function_call_output_count: function_call_output_count,
		history_empty_output_count: empty_output_count,
		nudge_count,
		history_tool_use_by_name: tool_use_by_name,
		history_tool_calls: tool_calls,
	};
}

export function codexTraceEnabled(): boolean {
	return Boolean(process.env[CODEX_TRACE_DIR_ENV]);
}

interface TraceInputs {
	/** Logical client request identity, shared by all physical transports. */
	requestId?: string;
	/** Unique physical upstream transport identity. */
	attemptId?: string;
	/** One-based physical transport ordinal within the logical request. */
	attemptOrdinal?: number;
	attemptCause?:
		| "initial"
		| "model_fallback"
		| "overload_529"
		| "thinking_retry"
		| "cache_control_retry"
		| "cache_lane_rescue"
		| "account_failover"
		| "other_retry";
	account?: string;
	modelIn?: string;
	modelOut?: string;
	messageCount?: number;
	/** Privacy-preserving session join key (hash of metadata.user_id). */
	sessionKeyHash?: string | null;
	/** Whether a prompt_cache_key was attached to the outbound request. */
	promptCacheKeySet?: boolean;
	/**
	 * Last 16 hex chars of the outbound prompt_cache_key (itself a digest, so
	 * nothing reversible). Lets offline analysis group requests per cache key
	 * and measure hit rate by turn within one conversation.
	 */
	promptCacheKeyId?: string | null;
	/** Key derivation mode: "conversation" | "session" (see provider). */
	cacheKeyMode?: "conversation" | "session" | null;
	/** Intended experiment arm for eligible cache-key canary traffic. */
	cacheKeyAssignment?: "conversation" | "session" | null;
	/** Bounded, domain-separated session cohort digest. */
	cacheKeyCohortId?: string | null;
	/** Bounded digest of the logical conversation identity. */
	conversationId?: string | null;
	/** Why the effective cache-key mode was selected. */
	cacheKeyAssignmentSource?: "canary" | "explicit_session_override" | null;
	/** Pacing canary arm: "control" | "bypass". */
	pacingCanary?: string | null;
	/** Privacy-preserving conversation cohort digest for stability checks. */
	pacingCohortId?: string | null;
	/** Effective request action: paced | bypassed | crossover-paced. */
	pacingAction?: string | null;
	instructions?: string;
	isDescendant?: boolean;
	orchestrationAdmission?:
		| "root"
		| "non_root"
		| "no_session"
		| "no_conversation"
		| "no_orchestration_tools"
		| "disabled";
	toolsBeforeCount?: number;
	filteredToolNames?: readonly string[];
	/**
	 * Diagnostic: this turn's derived conversation identity no longer matched
	 * an already-elected root for its session (see orchestration-election.ts).
	 * Additive on schema 9; a missing value writes null, not a version bump.
	 */
	orchestrationDemotionObserved?: boolean;
	/**
	 * Diagnostic: milliseconds since the demoted session's root was last
	 * active. Only meaningful when orchestrationDemotionObserved is true.
	 */
	elapsedMsSinceRoot?: number | null;
	tools?: readonly unknown[];
	codexInput: readonly unknown[];
	/** full bodies, only embedded when CCFLARE_CODEX_TRACE_FULL=1 */
	anthropicRequest?: unknown;
	codexRequest?: unknown;
}

interface ResponseTraceInputs {
	requestId?: string;
	attemptId?: string;
	modelOut?: string;
	/** Raw model context window, for utilization telemetry. */
	modelContextWindow?: number;
	/** Whether the upstream response carried x-codex-turn-state. */
	turnStateHeaderPresent?: boolean;
	/** Never written raw; converted to a keyed, domain-separated fingerprint. */
	turnState?: string | null;
	/** Never written raw; converted to a keyed, domain-separated fingerprint. */
	responseId?: string | null;
	summary: CodexResponseSummary;
}

/** Input tokens as a percentage of the model window, 0.1% resolution. */
export function contextUtilizationPct(
	inputTokens: number,
	contextWindow: number | undefined,
): number | null {
	if (!contextWindow || contextWindow <= 0 || inputTokens <= 0) return null;
	return Math.round((1000 * inputTokens) / contextWindow) / 10;
}

export function summarizeCodexResponse(
	toolCalls: readonly ToolCallSummary[],
	usage: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	},
	stopReason: CodexResponseSummary["stop_reason"],
	error?: { type?: string; message?: string; code?: string; status?: string },
): CodexResponseSummary {
	const newToolUseByName: Record<string, number> = {};
	let subagentSpawnCount = 0;
	for (const call of toolCalls) {
		newToolUseByName[call.name] = (newToolUseByName[call.name] ?? 0) + 1;
		if (SUBAGENT_TOOL_NAMES.has(call.name)) {
			subagentSpawnCount++;
		}
	}
	const inputTokens = usage.input_tokens ?? null;
	const cacheRead = usage.cache_read_input_tokens ?? null;
	const usageMeasurementAvailable = typeof inputTokens === "number";
	const cacheMeasurementAvailable =
		usageMeasurementAvailable && typeof cacheRead === "number";
	return {
		new_tool_call_count: toolCalls.length,
		new_subagent_spawn_count: subagentSpawnCount,
		new_tool_use_by_name: newToolUseByName,
		new_tool_calls: [...toolCalls],
		stop_reason: stopReason,
		usage_measurement_available: usageMeasurementAvailable,
		cache_measurement_available: cacheMeasurementAvailable,
		input_tokens: inputTokens,
		output_tokens: usage.output_tokens ?? null,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
		cache_hit_pct:
			cacheMeasurementAvailable && inputTokens > 0
				? Math.round(
						(1000 * Math.min(Math.max(cacheRead, 0), inputTokens)) /
							inputTokens,
					) / 10
				: null,
		...(stopReason === "error"
			? {
					error_type: error?.type || "unclassified_upstream_error",
					...(error?.message ? { error_message: error.message } : {}),
					...(error?.code ? { error_code: error.code } : {}),
					...(error?.status ? { error_status: error.status } : {}),
				}
			: {}),
	};
}

/**
 * Append one request JSONL trace record. No-op (and never throws) when disabled.
 */
export function writeCodexTrace(inputs: TraceInputs): void {
	const instructionsMetrics = inputs.instructions
		? serializedMetrics(inputs.instructions)
		: null;
	const toolsMetrics = inputs.tools ? serializedMetrics(inputs.tools) : null;
	const record: Record<string, unknown> = {
		trace_schema_version: TRACE_SCHEMA_VERSION,
		phase: "request",
		ts: new Date().toISOString(),
		request_id: inputs.requestId ?? null,
		attempt_id: inputs.attemptId ?? null,
		attempt_ordinal: inputs.attemptOrdinal ?? null,
		attempt_cause: inputs.attemptCause ?? null,
		account: inputs.account ?? null,
		model_in: inputs.modelIn ?? null,
		model_out: inputs.modelOut ?? null,
		message_count: inputs.messageCount ?? null,
		session_key_hash: inputs.sessionKeyHash ?? null,
		prompt_cache_key_set: inputs.promptCacheKeySet ?? false,
		prompt_cache_key_id: inputs.promptCacheKeyId ?? null,
		cache_key_mode: inputs.cacheKeyMode ?? null,
		cache_key_assignment: inputs.cacheKeyAssignment ?? null,
		cache_key_cohort_id: inputs.cacheKeyCohortId ?? null,
		conversation_id: inputs.conversationId ?? null,
		cache_key_assignment_source: inputs.cacheKeyAssignmentSource ?? null,
		pacing_canary: inputs.pacingCanary ?? null,
		pacing_cohort_id: inputs.pacingCohortId ?? null,
		pacing_action: inputs.pacingAction ?? null,
		is_descendant: inputs.isDescendant ?? false,
		orchestration_admission:
			inputs.orchestrationAdmission ?? "no_orchestration_tools",
		orchestration_demotion_observed:
			inputs.orchestrationDemotionObserved ?? null,
		elapsed_ms_since_root: inputs.elapsedMsSinceRoot ?? null,
		tools_before_count: inputs.toolsBeforeCount ?? inputs.tools?.length ?? 0,
		tools_after_count: inputs.tools?.length ?? 0,
		filtered_tool_names: inputs.filteredToolNames ?? [],
		instructions_len: inputs.instructions?.length ?? null,
		instructions_bytes: instructionsMetrics?.bytes ?? null,
		instructions_hmac: instructionsMetrics?.hmac ?? null,
		tool_count: inputs.tools?.length ?? 0,
		tools_bytes: toolsMetrics?.bytes ?? null,
		tools_hmac: toolsMetrics?.hmac ?? null,
		approx_input_chars: safeLength(inputs.codexInput),
		...summarizeCodexTransform(inputs.codexInput),
	};
	if (process.env[CODEX_TRACE_FULL_ENV] === "1") {
		record.anthropic_request = inputs.anthropicRequest ?? null;
		record.codex_request = inputs.codexRequest ?? null;
	}
	appendTraceRecord(record);
}

/**
 * Append one response JSONL trace record. No-op (and never throws) when disabled.
 */
export function writeCodexResponseTrace(inputs: ResponseTraceInputs): void {
	// Real-time fan-out visibility, independent of whether file tracing is on:
	// a single response spawning many subagents is the leading edge of a
	// recursive storm and should be loud in the service journal.
	const warnThreshold = readFanoutWarnThreshold();
	if (
		warnThreshold > 0 &&
		inputs.summary.new_subagent_spawn_count >= warnThreshold
	) {
		log.warn(
			`response ${inputs.requestId ?? "unknown"} (${inputs.modelOut ?? "unknown model"}) spawned ${inputs.summary.new_subagent_spawn_count} subagents in one turn (warn threshold ${warnThreshold}). Possible recursive fan-out.`,
		);
	}
	appendTraceRecord({
		trace_schema_version: TRACE_SCHEMA_VERSION,
		phase: "response",
		ts: new Date().toISOString(),
		request_id: inputs.requestId ?? null,
		attempt_id: inputs.attemptId ?? null,
		model_out: inputs.modelOut ?? null,
		codex_turn_state_present:
			inputs.turnStateHeaderPresent ?? Boolean(inputs.turnState),
		codex_turn_state_hmac: privacyHmac("turn-state", inputs.turnState),
		response_id_present: Boolean(inputs.responseId),
		response_id_hmac: privacyHmac("response-id", inputs.responseId),
		context_utilization_pct:
			typeof inputs.summary.input_tokens === "number"
				? contextUtilizationPct(
						inputs.summary.input_tokens,
						inputs.modelContextWindow,
					)
				: null,
		...inputs.summary,
	});
}

function privacyHmac(
	domain: "turn-state" | "response-id",
	value: string | null | undefined,
): string | null {
	const key = process.env[CODEX_TRACE_HMAC_KEY_ENV];
	if (!key || !value) return null;
	return createHmac("sha256", key)
		.update(`better-ccflare/codex-trace/${domain}/v1\0`, "utf8")
		.update(value, "utf8")
		.digest("hex");
}

function appendTraceRecord(record: Record<string, unknown>): void {
	const dir = process.env[CODEX_TRACE_DIR_ENV];
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		appendFileSync(
			join(dir, `codex-trace-${day}.jsonl`),
			`${JSON.stringify(record)}\n`,
		);
	} catch {
		// best-effort: tracing must never break the request path
	}
}

function prefixBoundaryFingerprints(
	items: readonly unknown[],
): CodexTransformSummary["input_item_fingerprints"] {
	const key = process.env[CODEX_TRACE_HMAC_KEY_ENV];
	if (!key) return [];

	const fingerprints: CodexTransformSummary["input_item_fingerprints"] = [];
	let chain = "";
	let cumulativeBytes = 0;
	for (const [index, item] of items.entries()) {
		let serialized: string;
		try {
			serialized = JSON.stringify(item) ?? "";
		} catch {
			return [];
		}
		const itemBytes = Buffer.byteLength(serialized, "utf8");
		cumulativeBytes += itemBytes;
		chain = createHmac("sha256", key)
			.update(chain, "utf8")
			.update("\0")
			.update(String(itemBytes), "utf8")
			.update("\0")
			.update(serialized, "utf8")
			.digest("hex");
		fingerprints.push({ index, bytes: cumulativeBytes, hmac: chain });
		if (fingerprints.length > MAX_INPUT_ITEM_FINGERPRINTS) {
			fingerprints.shift();
		}
	}
	return fingerprints;
}

function serializedMetrics(value: unknown): {
	bytes: number;
	hmac: string | null;
} {
	try {
		const serialized = JSON.stringify(value) ?? "";
		const key = process.env[CODEX_TRACE_HMAC_KEY_ENV];
		return {
			bytes: Buffer.byteLength(serialized, "utf8"),
			hmac: key
				? createHmac("sha256", key).update(serialized, "utf8").digest("hex")
				: null,
		};
	} catch {
		return { bytes: 0, hmac: null };
	}
}

function readFanoutWarnThreshold(): number {
	const raw = process.env[CODEX_FANOUT_WARN_ENV];
	if (raw === undefined || raw === "") return DEFAULT_FANOUT_WARN;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FANOUT_WARN;
}

function safeLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}
