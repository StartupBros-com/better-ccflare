/**
 * Shared contract for Claude Code advisor emulation on Codex routes
 * (docs/plans/2026-10-13-feat-advisor-codex-emulation-plan.md).
 *
 * Every id the proxy mints for an emulated advisor call carries this prefix.
 * It is the only signal history handling uses to tell an emulated pair from a
 * native Anthropic one, so it must never change once shipped.
 */
export const EMULATED_ADVISOR_ID_PREFIX = "srvtoolu_bccf_";

/** Error codes Claude Code 2.1.296 renders for `advisor_tool_result_error`. */
export type AdvisorEmulationErrorCode =
	| "max_uses_exceeded"
	| "too_many_requests"
	| "overloaded"
	| "prompt_too_long"
	| "execution_time_exceeded"
	| "unavailable";

export type AdvisorResultContent =
	| { type: "advisor_result"; text: string }
	| {
			type: "advisor_tool_result_error";
			error_code: AdvisorEmulationErrorCode;
	  };

export interface AdvisorTokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** What one advisor sub-call produced, success or mapped failure. */
export interface AdvisorOutcome {
	content: AdvisorResultContent;
	/** The physical advisor model, e.g. `gpt-6-astra`. */
	model: string;
	/** Absent when the sub-call never returned usage (timeout, abort, transport error). */
	usage?: AdvisorTokenUsage;
}

/** An Anthropic Messages content block, kept loose on purpose. */
export type AnthropicBlock = Record<string, unknown> & { type: string };

export interface AdvisorRoundInput {
	/** 1-based advisor round within this client request. */
	round: number;
	/**
	 * The assistant content the client has been sent so far in this message,
	 * in order. For `runAdvisor` it ends before the pending advisor call; for
	 * `runContinuation` it ends with the round's `server_tool_use` and
	 * `advisor_tool_result` blocks.
	 */
	inflightAssistantContent: readonly AnthropicBlock[];
	signal: AbortSignal;
}

export interface AdvisorEmulationStreamDeps {
	runAdvisor(input: AdvisorRoundInput): Promise<AdvisorOutcome>;
	/** Resolves to the Anthropic-SSE response of the next worker call. */
	runContinuation(input: AdvisorRoundInput): Promise<Response>;
	/** Physical advisor model, used for `max_uses_exceeded` iterations. */
	advisorModel: string;
	pingIntervalMs?: number;
	advisorTimeoutMs?: number;
	maxAdvisorCalls?: number;
	maxWorkerCalls?: number;
	signal?: AbortSignal;
	onEvent?: (event: AdvisorEmulationEvent) => void;
}

export type AdvisorEmulationEvent =
	| { kind: "advisor_dropped_with_siblings"; round: number }
	| { kind: "advisor_round_started"; round: number }
	| {
			kind: "advisor_round_finished";
			round: number;
			outcome: AdvisorResultContent["type"];
			errorCode?: AdvisorEmulationErrorCode;
			durationMs: number;
	  }
	| { kind: "continuation_failed"; round: number; status?: number }
	| { kind: "caps_reached"; advisorCalls: number; workerCalls: number };

/** Per-request emulation decision, set on `RequestMeta.advisorEmulation`. */
export interface AdvisorEmulationDecision {
	/** Physical Codex model the advisor runs on. */
	advisorModel: string;
	/** The `model` field of the client's advisor declaration. */
	declarationModel: string;
}

export function isEmulatedAdvisorId(id: unknown): id is string {
	return typeof id === "string" && id.startsWith(EMULATED_ADVISOR_ID_PREFIX);
}

/** Derive the emulated id from a Codex `call_id`; deterministic so replays match. */
export function emulatedAdvisorIdFromCallId(callId: string): string {
	const sanitized = callId.replace(/[^\w-]/g, "_");
	return `${EMULATED_ADVISOR_ID_PREFIX}${sanitized}`;
}
