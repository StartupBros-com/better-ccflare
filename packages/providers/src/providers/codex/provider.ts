import { createHash } from "node:crypto";
import {
	BUFFER_SIZES,
	mapModelName,
	SseFrameBuffer,
	SseLimitError,
	ValidationError,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { resolveReasoningEffort } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import {
	estimateAnthropicRequestTokens,
	resolveModelContextCapability,
} from "../../request-capabilities";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import {
	CODEX_SINGLE_ORCHESTRATION_ROOT_ENV,
	deriveConversationIdentity,
	electOrchestrationRoot,
	type OrchestrationAdmission,
} from "./orchestration-election";
import {
	summarizeCodexResponse,
	type ToolCallSummary,
	writeCodexResponseTrace,
	writeCodexTrace,
} from "./trace";
import { normalizeCodexInputUsage } from "./usage";

const log = new Logger("CodexProvider");

const INTERNAL_HEADERS = [
	"x-better-ccflare-request-id",
	"x-better-ccflare-attempt-id",
	"x-better-ccflare-attempt-ordinal",
	"x-better-ccflare-attempt-cause",
	"x-better-ccflare-final-model",
	"x-better-ccflare-request-stream",
	"x-better-ccflare-pacing-canary",
	"x-better-ccflare-pacing-cohort-id",
	"x-better-ccflare-pacing-action",
];

function sanitizeResponseHeaders(headers: Headers): Headers {
	const sanitized = sanitizeProxyHeaders(headers);
	for (const h of INTERNAL_HEADERS) {
		sanitized.delete(h);
	}
	return sanitized;
}

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";
export const CODEX_VERSION = "0.144.4";
const OPENAI_PROMPT_CACHE_HOSTS = new Set(["chatgpt.com", "api.openai.com"]);
export const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;
export const CODEX_PING_MODEL = "gpt-5-codex";
const CODEX_SYNTHETIC_COUNT_TOKENS_URL =
	"https://better-ccflare.local/codex/count_tokens";
const CODEX_SYNTHETIC_RESPONSE_URL =
	"https://better-ccflare.local/codex/response";
export const CODEX_PROMPT_CACHE_KEY_ENV = "CCFLARE_CODEX_PROMPT_CACHE_KEY";
/** "conversation" (default) or "session"; see derivePromptCacheKey. */
export const CODEX_CACHE_KEY_MODE_ENV = "CCFLARE_CODEX_CACHE_KEY_MODE";
export const CODEX_CACHE_KEY_SESSION_PERCENT_ENV =
	"CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT";
const CODEX_CACHE_KEY_SESSION_BUCKET_DOMAIN =
	"better-ccflare:codex-cache-key-session-canary:v1\0";
const CODEX_CACHE_KEY_COHORT_DOMAIN =
	"better-ccflare:codex-cache-key-cohort:v1\0";

export function readCodexCacheKeySessionPercent(
	raw = process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV],
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return 0;
	return Math.min(Number.parseInt(raw, 10), 100);
}

export function deriveCodexCacheKeySessionBucket(sessionId: string): number {
	const digest = createHash("sha256")
		.update(CODEX_CACHE_KEY_SESSION_BUCKET_DOMAIN)
		.update(sessionId.toLowerCase())
		.digest();
	return digest.readUInt32BE(0) % 100;
}
// Structured (non-text) tool_result blocks larger than this are replaced with
// a size marker: replaying megabyte payloads (e.g. base64 documents) into
// every subsequent turn bloats context and destroys prompt-cache reuse.
const CODEX_MAX_STRUCTURED_BLOCK_CHARS = 8_192;

/** Resolve a configured Codex endpoint with the same validation as proxy requests. */
export function resolveCodexEndpoint(
	endpoint?: string | null,
	accountName?: string,
): string {
	if (endpoint) {
		try {
			return validateEndpointUrl(endpoint, "custom_endpoint");
		} catch (error) {
			const accountSuffix = accountName ? ` for ${accountName}` : "";
			log.warn(
				`Invalid custom endpoint${accountSuffix}: ${endpoint}. Using default.`,
				error,
			);
		}
	}
	return CODEX_DEFAULT_ENDPOINT;
}

/**
 * Whether an already-resolved endpoint targets the ChatGPT subscription API.
 * Query strings and trailing slashes do not change that API contract.
 */
export function isCodexSubscriptionEndpoint(endpoint: string): boolean {
	try {
		const candidate = new URL(endpoint);
		const subscription = new URL(CODEX_DEFAULT_ENDPOINT);
		const normalizePath = (pathname: string) =>
			pathname.replace(/\/+$/, "") || "/";
		return (
			candidate.username === "" &&
			candidate.password === "" &&
			candidate.origin === subscription.origin &&
			normalizePath(candidate.pathname) === normalizePath(subscription.pathname)
		);
	} catch {
		return false;
	}
}

function isOpenAiPromptCacheEndpoint(account?: Account): boolean {
	try {
		const endpoint = resolveCodexEndpoint(
			account?.custom_endpoint,
			account?.name,
		);
		return OPENAI_PROMPT_CACHE_HOSTS.has(new URL(endpoint).hostname);
	} catch {
		return false;
	}
}

const _normalizeUsage = (value: unknown): Record<string, number> => {
	const usage =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const getNumber = (field: string) => {
		const candidate = usage[field];
		return typeof candidate === "number" && Number.isFinite(candidate)
			? candidate
			: 0;
	};
	return {
		input_tokens: getNumber("input_tokens"),
		output_tokens: getNumber("output_tokens"),
		cache_read_input_tokens: getNumber("cache_read_input_tokens"),
		cache_creation_input_tokens: getNumber("cache_creation_input_tokens"),
	};
};

// Default model mapping: Anthropic model name prefixes → Codex model names
const DEFAULT_MODEL_MAP: Record<string, string> = {
	opus: "gpt-5.3-codex",
	sonnet: "gpt-5.3-codex",
	haiku: "gpt-5.4-mini",
};

/** Resolve the concrete Codex model exactly as request transformation will. */
export function resolveCodexRequestModel(
	anthropicModel: string,
	account?: Account,
): string {
	if (account) {
		const mapped = mapModelName(anthropicModel, account);
		if (mapped !== anthropicModel) return mapped;
	}

	const lower = anthropicModel.toLowerCase();
	if (lower.includes("haiku")) return DEFAULT_MODEL_MAP.haiku;
	if (lower.includes("sonnet")) return DEFAULT_MODEL_MAP.sonnet;
	if (lower.includes("opus")) return DEFAULT_MODEL_MAP.opus;
	return anthropicModel;
}

// Known Codex failure codes → Anthropic error types. Quota exhaustion cools
// the account like a rate limit; slow_down is a throttle; context/policy and
// subscription errors are permanent and must not be retried as 5xx. Codes and
// their retry semantics mirror the reference client (openai/codex
// codex-api/src/sse/responses.rs + api_bridge.rs): quota codes cool the
// account, server_is_overloaded/slow_down are throttles, context and policy
// errors are permanent 4xx, usage_not_included is a plan-entitlement error.
const CODEX_ERROR_TYPE_BY_CODE: Record<string, string> = {
	rate_limit_exceeded: "rate_limit_error",
	insufficient_quota: "rate_limit_error",
	server_is_overloaded: "overloaded_error",
	slow_down: "overloaded_error",
	server_error: "api_error",
	context_length_exceeded: "invalid_request_error",
	cyber_policy: "invalid_request_error",
	usage_not_included: "permission_error",
};

// Buffered tool-call argument bytes are capped by the same constant used for
// a single SSE frame (packages/core/src/sse-frame-buffer.ts): both the
// per-call buffer and the aggregate across every concurrently open
// function-call buffer are checked against this one cap, reusing it rather
// than introducing a second arbitrary threshold.
const TOOL_ARGS_BYTE_CAP = BUFFER_SIZES.SSE_FRAME_MAX_BYTES;
const byteEncoder = new TextEncoder();

// When enabled, telemetry reports the effective Codex context capacity rather
// than the raw model maximum.
export const CODEX_EFFECTIVE_CONTEXT_ENV = "CCFLARE_CODEX_EFFECTIVE_CONTEXT";
export { MODEL_CONTEXT_WINDOWS } from "../../request-capabilities";

// ── Codex Responses API types ─────────────────────────────────────────────────

interface CodexInputTextItem {
	type: "input_text";
	text: string;
}

interface CodexOutputTextItem {
	type: "output_text";
	text: string;
}

interface CodexFunctionCallItem {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
	status?: "in_progress" | "completed" | "incomplete";
}

interface CodexFunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string;
	status?: "in_progress" | "completed" | "incomplete";
}

type CodexContentItem =
	| CodexInputTextItem
	| CodexOutputTextItem
	| CodexFunctionCallItem
	| CodexFunctionCallOutputItem;

interface CodexMessage {
	role: "user" | "assistant" | "system";
	content: CodexContentItem[];
}

interface CodexTool {
	type: "function";
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface CodexRequest {
	model: string;
	input: (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[];
	stream: boolean;
	store: false;
	reasoning?: { effort: string };
	instructions?: string;
	prompt_cache_key?: string;
	tools?: CodexTool[];
	tool_choice?:
		| "auto"
		| "required"
		| "none"
		| { type: "function"; name: string };
	parallel_tool_calls?: boolean;
	max_output_tokens?: number;
}

export interface CodexPromptCacheKeyDecision {
	key: string | null;
	assignment: "conversation" | "session" | null;
	assignmentSource: "canary" | "explicit_session_override" | null;
	effectiveMode: "conversation" | "session" | null;
	cohortId: string | null;
	conversationIdentity: string | null;
}

interface CodexConversionResult {
	codexBody: CodexRequest;
	cacheKeyDecision: CodexPromptCacheKeyDecision;
	orchestrationAdmission: OrchestrationAdmission;
	filteredToolNames: string[];
}

// ── Anthropic request types ───────────────────────────────────────────────────

interface AnthropicTextContent {
	type: "text";
	text: string;
}

interface AnthropicToolUse {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResult {
	type: "tool_result";
	tool_use_id: string;
	is_error?: boolean;
	content:
		| string
		| Array<{
				type: string;
				text?: string;
				[key: string]: unknown;
		  }>;
}

type AnthropicContentBlock =
	| AnthropicTextContent
	| AnthropicToolUse
	| AnthropicToolResult;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

interface AnthropicToolChoice {
	type: "auto" | "any" | "none" | "tool";
	name?: string;
	disable_parallel_tool_use?: boolean;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string | { type: string; text: string }[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	reasoning?: { effort?: string };
	metadata?: { user_id?: string };
	[key: string]: unknown;
}

// ── SSE streaming state ───────────────────────────────────────────────────────

interface FunctionCallBuffer {
	contentBlockIndex: number;
	name: string;
	arguments: string[];
	/** Running byte total of buffered argument deltas, capped by TOOL_ARGS_BYTE_CAP. */
	bytes: number;
}

interface ContextWindowUsage {
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

interface ContextWindow {
	current_usage: ContextWindowUsage;
	context_window_size: number;
}

interface StreamState {
	messageId: string;
	model: string;
	contentBlockIndex: number;
	hasSentMessageStart: boolean;
	hasSentContentBlockStart: boolean;
	hasSentTerminalEvents: boolean;
	/** Total occupied upstream input, including cached tokens, for telemetry. */
	totalInputTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	usageMeasurementAvailable: boolean;
	cacheMeasurementAvailable: boolean;
	// Anthropic clients expect stop_reason=tool_use when the assistant emitted a tool call.
	sawToolUse: boolean;
	contextWindow: ContextWindow | null;
	// Track function_call items: output_index → buffered arguments and block index
	functionCallBlocks: Map<number, FunctionCallBuffer>;
	/** Aggregate byte total across every entry in functionCallBlocks, capped by TOOL_ARGS_BYTE_CAP. */
	functionCallBytesTotal: number;
	upstreamError?: {
		type: string;
		message: string;
		code?: string;
		status?: string;
	};
	// Newly emitted tool calls from this response only (not historical replay).
	traceNewToolCalls: ToolCallSummary[];
	traceRequestId: string;
	traceAttemptId?: string;
	// One terminal response trace per physical attempt, across every terminal
	// path (completed, failed, abrupt EOF, read error, downstream cancel).
	terminalTraceWritten: boolean;
}

function writeCodexStreamTerminalTrace(
	state: StreamState,
	stopReason: "error" | "end_turn" | "tool_use" | "max_tokens" | "refusal",
	error?: {
		type: string;
		message: string;
		code?: string;
		status?: string;
	},
): void {
	if (state.terminalTraceWritten) return;
	state.terminalTraceWritten = true;
	writeCodexResponseTrace({
		requestId: state.traceRequestId,
		attemptId: state.traceAttemptId,
		modelOut: state.model,
		modelContextWindow: resolveModelContextCapability("codex", state.model)
			?.rawContextWindow,
		summary: summarizeCodexResponse(
			state.traceNewToolCalls,
			state.usageMeasurementAvailable
				? {
						input_tokens: state.totalInputTokens,
						output_tokens: state.outputTokens,
						...(state.cacheMeasurementAvailable
							? {
									cache_read_input_tokens: state.cacheReadInputTokens,
									cache_creation_input_tokens: state.cacheCreationInputTokens,
								}
							: {}),
					}
				: {},
			stopReason,
			error,
		),
	});
}

/**
 * Single source of truth for "does this Codex SSE event, on its own data,
 * commit downstream output" at the four points where handleCodexEvent
 * currently gates an inline `ensureMessageStart()` call on the event's data
 * (not on stream state): response.created, response.output_item.added
 * (function_call items only), response.content_part.added (output_text
 * parts only), and response.output_text.delta (non-empty deltas only).
 *
 * Scope: only those four decision points are covered. output_item.done,
 * error/response.failed, and response.completed/response.incomplete gate
 * their writes on stream STATE (hasSentContentBlockStart,
 * hasSentTerminalEvents, upstreamError) rather than on the event's own data,
 * so a pure (eventName, data) function cannot answer for them the way it can
 * for the four data-gated sites above; they keep their existing, independent
 * gating in handleCodexEvent and fall through to `false` here.
 */
export function codexEventCommitsOutput(
	eventName: string,
	data: Record<string, unknown>,
): boolean {
	switch (eventName) {
		case "response.created":
			return true;
		case "response.output_item.added": {
			const item = data.item as Record<string, unknown> | undefined;
			return (item?.type as string | undefined) === "function_call";
		}
		case "response.content_part.added": {
			const part = data.part as Record<string, unknown> | undefined;
			return (part?.type as string | undefined) === "output_text";
		}
		case "response.output_text.delta": {
			const delta = data.delta as string | undefined;
			return Boolean(delta);
		}
		default:
			return false;
	}
}

export class CodexProvider extends BaseProvider {
	name = "codex";
	// Fallback map: proxy-operations.ts injects x-better-ccflare-request-id and
	// x-better-ccflare-request-stream into the upstream response before calling
	// processResponse, so headerRequestedStream is normally set. This map covers
	// the race where a response arrives after the 30s TTL sweep evicts the entry.
	private requestStreamById = new Map<
		string,
		{ stream: boolean; ts: number }
	>();

	private sweepRequestStreamById(): void {
		const cutoff = Date.now() - 30_000;
		for (const [id, entry] of this.requestStreamById) {
			if (entry.ts < cutoff) {
				this.requestStreamById.delete(id);
			}
		}
	}

	canHandle(path: string): boolean {
		return path === "/v1/messages" || path === "/v1/messages/count_tokens";
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No refresh token for account ${account.name}`);
		}

		log.info(`Refreshing Codex token for account ${account.name}`);

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: CLIENT_ID,
			scope:
				"openid profile email offline_access api.connectors.read api.connectors.invoke",
		});

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			let errorData: { error?: string; error_description?: string } | null =
				null;
			try {
				errorData = await response.json();
			} catch {
				// ignore
			}

			const errorMessage =
				errorData?.error_description || errorData?.error || response.statusText;

			// Rotating refresh tokens: reuse → must re-auth
			if (errorData?.error === "refresh_token_reused") {
				throw new Error(
					`Codex refresh token was reused for account ${account.name}. Please re-authenticate with: bun run cli --reauthenticate ${account.name}`,
				);
			}

			throw new Error(
				`Failed to refresh Codex token for account ${account.name}: ${errorMessage}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		log.debug(`[CodexProvider] token refresh response for ${account.name}:`, {
			expiresIn: json.expires_in,
			responseKeys: Object.keys(json),
		});

		return {
			accessToken: json.access_token,
			// OpenAI issues a new refresh token on each refresh (rotating)
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}

	buildUrl(_path: string, _query: string, account?: Account): string {
		if (_path === "/v1/messages/count_tokens") {
			return CODEX_SYNTHETIC_COUNT_TOKENS_URL;
		}

		return resolveCodexEndpoint(account?.custom_endpoint, account?.name);
	}

	prepareHeaders(headers: Headers, accessToken?: string): Headers {
		const newHeaders = new Headers(headers);

		// Remove client auth and Anthropic-specific headers
		newHeaders.delete("authorization");
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");
		newHeaders.delete("anthropic-beta");
		newHeaders.delete("x-api-key");
		newHeaders.delete("host");

		// Set Codex-required headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}
		newHeaders.set("Version", CODEX_VERSION);
		newHeaders.set("Openai-Beta", "responses=experimental");
		newHeaders.set("User-Agent", CODEX_USER_AGENT);
		newHeaders.set("originator", "codex_cli_rs");

		return newHeaders;
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const isSyntheticCountTokens = this.isSyntheticCountTokensRequest(
			request.url,
		);
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return isSyntheticCountTokens
				? this.createSyntheticErrorResponse(
						request,
						400,
						"invalid_request_error",
						"Codex count_tokens requires an application/json request body.",
					)
				: request;
		}

		try {
			this.sweepRequestStreamById();
			const body = (await request.json()) as AnthropicRequest;
			if (isSyntheticCountTokens) {
				return this.createSyntheticCountTokensResponse(request, body);
			}
			const isSubscriptionEndpoint = isCodexSubscriptionEndpoint(request.url);
			if (isSubscriptionEndpoint && body.max_tokens === 0) {
				return this.createSyntheticErrorResponse(
					request,
					400,
					"invalid_request_error",
					"Codex subscription requests do not support max_tokens: 0.",
				);
			}

			const requestId = request.headers.get("x-better-ccflare-request-id");
			const attemptId = request.headers.get("x-better-ccflare-attempt-id");
			const attemptOrdinal = Number.parseInt(
				request.headers.get("x-better-ccflare-attempt-ordinal") ?? "",
				10,
			);
			const attemptCause = request.headers.get(
				"x-better-ccflare-attempt-cause",
			) as Parameters<typeof writeCodexTrace>[0]["attemptCause"];
			const finalModel = request.headers.get("x-better-ccflare-final-model");
			const isAttributedAgent =
				request.headers.get("x-better-ccflare-attributed-agent") === "true";
			if (requestId) {
				this.requestStreamById.set(requestId, {
					stream: body.stream === true,
					ts: Date.now(),
				});
			}
			const {
				codexBody,
				cacheKeyDecision,
				orchestrationAdmission,
				filteredToolNames,
			} = this.convertToCodexFormat(
				body,
				account,
				requestId ?? undefined,
				isAttributedAgent,
			);
			if (isSubscriptionEndpoint) {
				// ChatGPT's subscription Responses endpoint rejects this API-only field.
				delete codexBody.max_output_tokens;
			}
			// Model fallback is selected after provider conversion. Apply the final wire
			// model before tracing so the record and body describe the same transport.
			if (finalModel) codexBody.model = finalModel;

			// Best-effort, env-gated observability (no-op unless CCFLARE_CODEX_TRACE_DIR set).
			writeCodexTrace({
				requestId: requestId ?? undefined,
				attemptId: attemptId ?? undefined,
				attemptOrdinal: Number.isFinite(attemptOrdinal)
					? attemptOrdinal
					: undefined,
				attemptCause: attemptCause ?? undefined,
				account: account?.name,
				modelIn: body.model,
				modelOut: codexBody.model,
				messageCount: body.messages.length,
				sessionKeyHash: this.hashSessionKey(body),
				promptCacheKeySet: Boolean(codexBody.prompt_cache_key),
				promptCacheKeyId: codexBody.prompt_cache_key
					? codexBody.prompt_cache_key.slice(-16)
					: null,
				cacheKeyMode: cacheKeyDecision.effectiveMode,
				cacheKeyAssignment: cacheKeyDecision.assignment,
				cacheKeyCohortId: cacheKeyDecision.cohortId,
				conversationId:
					cacheKeyDecision.conversationIdentity?.slice(0, 16) ?? null,
				cacheKeyAssignmentSource: cacheKeyDecision.assignmentSource,
				pacingCanary: request.headers.get("x-better-ccflare-pacing-canary"),
				pacingCohortId: request.headers.get(
					"x-better-ccflare-pacing-cohort-id",
				),
				pacingAction: request.headers.get("x-better-ccflare-pacing-action"),
				isDescendant: isAttributedAgent,
				orchestrationAdmission,
				toolsBeforeCount: body.tools?.length ?? 0,
				filteredToolNames,
				instructions: codexBody.instructions,
				tools: codexBody.tools,
				codexInput: codexBody.input,
				anthropicRequest: body,
				codexRequest: codexBody,
			});

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.set(
				"x-better-ccflare-request-stream",
				body.stream === true ? "true" : "false",
			);

			newHeaders.delete("x-better-ccflare-request-id");
			newHeaders.delete("x-better-ccflare-attempt-id");
			newHeaders.delete("x-better-ccflare-attempt-ordinal");
			newHeaders.delete("x-better-ccflare-attempt-cause");
			newHeaders.delete("x-better-ccflare-final-model");
			newHeaders.delete("x-better-ccflare-attributed-agent");
			newHeaders.delete("x-better-ccflare-pacing-canary");
			newHeaders.delete("x-better-ccflare-pacing-cohort-id");
			newHeaders.delete("x-better-ccflare-pacing-action");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(codexBody),
			});
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			if (isSyntheticCountTokens) {
				return this.createSyntheticErrorResponse(
					request,
					400,
					"invalid_request_error",
					"Codex count_tokens requires a valid JSON request body.",
				);
			}
			log.error("Failed to transform request body to Codex format:", error);
			return request;
		}
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const contentType = response.headers.get("content-type");
		const requestId = response.headers.get("x-better-ccflare-request-id");
		const attemptId = response.headers.get("x-better-ccflare-attempt-id");
		const finalModel =
			response.headers.get("x-better-ccflare-final-model") ?? undefined;
		const headerRequestedStream = response.headers.get(
			"x-better-ccflare-request-stream",
		);
		const requestedStream =
			headerRequestedStream === "true"
				? true
				: headerRequestedStream === "false"
					? false
					: requestId
						? (this.requestStreamById.get(requestId)?.stream ?? true)
						: true;
		if (requestId) {
			this.requestStreamById.delete(requestId);
		}
		const isEventStream = contentType?.includes("text/event-stream") ?? false;
		if (isEventStream) {
			if (requestedStream) {
				return this.transformStreamingResponse(
					response,
					requestId ?? undefined,
					attemptId ?? undefined,
					finalModel,
				);
			}
			return this.transformSseResponseToJson(
				response,
				requestId ?? undefined,
				attemptId ?? undefined,
				finalModel,
			);
		}

		if (response.ok && response.body !== null && contentType === null) {
			log.warn(
				`Codex returned successful response without SSE content-type (<missing>); transforming as ${requestedStream ? "SSE" : "JSON"}`,
			);
			const headers = sanitizeResponseHeaders(response.headers);
			headers.set("content-type", "text/event-stream");
			const sseResponse = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
			if (requestedStream) {
				return this.transformStreamingResponse(
					sseResponse,
					requestId ?? undefined,
					attemptId ?? undefined,
					finalModel,
				);
			}
			return this.transformSseResponseToJson(
				sseResponse,
				requestId ?? undefined,
				attemptId ?? undefined,
				finalModel,
			);
		}

		writeCodexResponseTrace({
			requestId: requestId ?? "unknown",
			attemptId: attemptId ?? undefined,
			modelOut: finalModel ?? "unknown",
			summary: summarizeCodexResponse(
				[],
				{},
				response.ok ? "end_turn" : "error",
				response.ok
					? undefined
					: {
							type: `http_${response.status}`,
							message: response.statusText || `HTTP ${response.status}`,
						},
			),
		});
		const headers = sanitizeResponseHeaders(response.headers);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Parse reset time from Codex usage headers (present on all responses)
		const parseReset = (v: string | null) =>
			v ? Number.parseInt(v, 10) * 1000 : undefined;

		// Try primary/secondary headers first, then legacy x-codex-5h/7d headers
		const resets = [
			parseReset(response.headers.get("x-codex-primary-reset-at")),
			parseReset(response.headers.get("x-codex-secondary-reset-at")),
			parseReset(response.headers.get("x-codex-5h-reset-at")),
			parseReset(response.headers.get("x-codex-7d-reset-at")),
		].filter((v): v is number => v !== undefined);

		// Use the sooner (smallest) reset time
		const resetTime = resets.length > 0 ? Math.min(...resets) : undefined;

		if (response.status === 429) {
			return {
				isRateLimited: true,
				resetTime: resetTime ?? Date.now() + 60 * 60 * 1000,
			};
		}

		// 529 (overloaded_error) is rate limiting too, but unlike 429 we do not
		// synthesize a resetTime when Codex doesn't send one. A missing resetTime
		// here is the signal proxy-operations.ts uses to attempt bounded in-place
		// retries before falling back to account cooldown; forcing a synthesized
		// resetTime would skip that retry path entirely.
		if (response.status === 529) {
			return { isRateLimited: true, resetTime };
		}

		// Return reset time for DB tracking even on successful responses
		return { isRateLimited: false, resetTime };
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		const { CodexOAuthProvider } = require("./oauth.js");
		return new CodexOAuthProvider();
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private mapModel(anthropicModel: string, account?: Account): string {
		return resolveCodexRequestModel(anthropicModel, account);
	}

	private extractSystemPrompt(
		system: AnthropicRequest["system"],
	): string | undefined {
		if (!system) return undefined;
		if (typeof system === "string") return system;
		// Array of content blocks
		return system
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n\n");
	}

	/**
	 * Short, privacy-preserving session join key for trace records. Unlike
	 * extractPromptCacheKey this is not env-gated and never sent upstream;
	 * it only lets offline analysis group request/response records by session.
	 */
	private hashSessionKey(body: AnthropicRequest): string | null {
		const rawUserId = body.metadata?.user_id;
		if (typeof rawUserId !== "string" || rawUserId.length === 0) return null;
		return createHash("sha256").update(rawUserId).digest("hex").slice(0, 16);
	}

	private extractSessionId(body: AnthropicRequest): string | undefined {
		const rawUserId = body.metadata?.user_id;
		if (typeof rawUserId !== "string") return undefined;
		try {
			const metadata = JSON.parse(rawUserId) as unknown;
			if (!metadata || typeof metadata !== "object") return undefined;
			const sessionId = (metadata as Record<string, unknown>).session_id;
			if (
				typeof sessionId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					sessionId,
				)
			) {
				return undefined;
			}
			return sessionId.toLowerCase();
		} catch {
			return undefined;
		}
	}

	/**
	 * OpenAI routes each request to a cache machine by hashing the prompt's
	 * initial tokens together with prompt_cache_key, and documents that one key
	 * should stay under ~15 requests/minute or "some requests may miss the
	 * cache". A Claude Code session multiplexes the main loop plus every
	 * subagent conversation over one session id, so keying on the session
	 * alone funnels an entire fan-out burst onto one cache machine and
	 * thrashes it (measured in dogfood traces: turns 1-8 of subagent
	 * conversations cached no better than cold starts while one session key
	 * carried 170+ conversations in five minutes).
	 *
	 * Default "conversation" mode therefore partitions the key by conversation
	 * identity: session id + instructions + first input item, all stable
	 * across the turns of one conversation and distinct across concurrent
	 * subagents. Each conversation is sequential, so per-key traffic stays far
	 * below the documented rate bound. CCFLARE_CODEX_CACHE_KEY_MODE=session
	 * restores the coarse per-session key.
	 */
	private derivePromptCacheKey(
		body: AnthropicRequest,
		instructions: string,
		input: readonly unknown[],
		account?: Account,
	): CodexPromptCacheKeyDecision {
		const ineligible: CodexPromptCacheKeyDecision = {
			key: null,
			assignment: null,
			assignmentSource: null,
			effectiveMode: null,
			cohortId: null,
			conversationIdentity: null,
		};
		if (process.env[CODEX_PROMPT_CACHE_KEY_ENV] === "0") return ineligible;
		if (!isOpenAiPromptCacheEndpoint(account)) return ineligible;
		const sessionId = this.extractSessionId(body);
		if (!sessionId) return ineligible;

		const conversationIdentity =
			deriveConversationIdentity(sessionId, instructions, input) ?? null;
		const sessionPercent = readCodexCacheKeySessionPercent();
		const assignment: "conversation" | "session" =
			sessionPercent === 100 ||
			(sessionPercent > 0 &&
				deriveCodexCacheKeySessionBucket(sessionId) < sessionPercent)
				? "session"
				: "conversation";
		const explicitSessionOverride =
			process.env[CODEX_CACHE_KEY_MODE_ENV] === "session";
		const effectiveMode =
			explicitSessionOverride || assignment === "session" || input.length === 0
				? "session"
				: "conversation";
		const key =
			effectiveMode === "session"
				? `ccflare-session-${createHash("sha256")
						.update(sessionId)
						.digest("hex")
						.slice(0, 48)}`
				: conversationIdentity
					? `ccflare-convo-${conversationIdentity.slice(0, 48)}`
					: null;

		return {
			key,
			assignment,
			assignmentSource: explicitSessionOverride
				? "explicit_session_override"
				: "canary",
			effectiveMode: key ? effectiveMode : null,
			cohortId: createHash("sha256")
				.update(CODEX_CACHE_KEY_COHORT_DOMAIN)
				.update(sessionId)
				.digest("hex")
				.slice(0, 16),
			conversationIdentity,
		};
	}

	private convertToolChoice(
		choice: AnthropicToolChoice | undefined,
		tools: readonly CodexTool[],
	): CodexRequest["tool_choice"] | undefined {
		if (!choice) return undefined;
		if (typeof choice !== "object") {
			throw new ValidationError("tool_choice must be an object");
		}
		if (choice.type === "auto") return "auto";
		if (choice.type === "any") return "required";
		if (choice.type === "none") return "none";
		if (choice.type === "tool") {
			if (
				typeof choice.name !== "string" ||
				!tools.some((tool) => tool.name === choice.name)
			) {
				throw new ValidationError(
					`tool_choice references unknown tool: ${choice.name}`,
				);
			}
			return { type: "function", name: choice.name };
		}
		throw new ValidationError(
			`tool_choice has unsupported type: ${String(
				(choice as { type?: unknown }).type,
			)}`,
		);
	}

	private serializeToolResultContent(
		content: AnthropicToolResult["content"],
	): string {
		if (typeof content === "string") return content;
		// External input can violate the declared type (missing, null, object);
		// degrade to an empty output rather than throwing, because a throw here
		// is swallowed by transformRequestBody and forwards the untranslated
		// Anthropic body upstream.
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
				continue;
			}
			if (block.type === "image") {
				parts.push("[image content not supported in Codex tool results]");
				continue;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(block) ?? "";
			} catch {
				continue;
			}
			if (serialized.length > CODEX_MAX_STRUCTURED_BLOCK_CHARS) {
				parts.push(
					`[${String(block.type ?? "unknown")} content omitted: ${serialized.length} chars]`,
				);
				continue;
			}
			parts.push(serialized);
		}
		return parts.join("\n");
	}

	private convertMessage(
		msg: AnthropicMessage,
	): (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[] {
		const items: (
			| CodexMessage
			| CodexFunctionCallItem
			| CodexFunctionCallOutputItem
		)[] = [];

		// Codex API only accepts user/assistant/system roles.
		// Map developer (Codex CLI system instructions sent as a message role) to system.
		const role = (msg.role as string) === "developer" ? "system" : msg.role;

		if (typeof msg.content === "string") {
			const contentType = role === "assistant" ? "output_text" : "input_text";
			items.push({
				role,
				content: [{ type: contentType, text: msg.content } as CodexContentItem],
			} as CodexMessage);
			return items;
		}

		// Complex content array: may contain tool_use, tool_result, text.
		// Preserve source order so Codex sees the same block chronology the
		// client sent: outputs stay adjacent to their calls, and follow-up text
		// stays after the results it refers to. Consecutive text blocks batch
		// into one message wrapper; function_call* are top-level items.
		let pendingText: CodexContentItem[] = [];
		const flushText = () => {
			if (pendingText.length === 0) return;
			items.push({ role, content: pendingText } as CodexMessage);
			pendingText = [];
		};

		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") {
				const contentType = role === "assistant" ? "output_text" : "input_text";
				pendingText.push({
					type: contentType,
					text: block.text,
				} as CodexContentItem);
			} else if (block.type === "tool_use") {
				flushText();
				items.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(
						this.sanitizeToolUseInput(block.name, block.input),
					),
					status: "completed",
				});
			} else if (block.type === "tool_result") {
				flushText();
				const serialized = this.serializeToolResultContent(block.content);
				items.push({
					type: "function_call_output",
					call_id: block.tool_use_id,
					output:
						block.is_error === true ? `[tool error] ${serialized}` : serialized,
					status: "completed",
				});
			}
		}
		flushText();

		return items;
	}

	private sanitizeToolUseInput(name: string, input: unknown): unknown {
		if (input === undefined) return {};
		if (input === null || typeof input !== "object" || Array.isArray(input)) {
			return input;
		}

		const sanitized: Record<string, unknown> = {
			...(input as Record<string, unknown>),
		};

		if (name === "Read") {
			const pages = sanitized.pages;
			if (
				pages === "" ||
				pages === null ||
				pages === undefined ||
				(Array.isArray(pages) && pages.length === 0)
			) {
				delete sanitized.pages;
			}
		}

		if (name === "WebSearch") {
			const allowedDomains = this.cleanWebSearchDomains(
				sanitized.allowed_domains,
			);
			if (allowedDomains.length > 0) {
				sanitized.allowed_domains = allowedDomains;
			} else {
				delete sanitized.allowed_domains;
			}
			// Claude Code's WebSearch tool only accepts an allow-list at this
			// Anthropic-compatibility boundary. Drop block-lists intentionally rather
			// than forwarding a field the local tool schema rejects.
			delete sanitized.blocked_domains;
		}

		return sanitized;
	}

	private cleanWebSearchDomains(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value
			.filter((domain): domain is string => typeof domain === "string")
			.map((domain) => domain.trim())
			.filter((domain) => domain.length > 0);
	}

	private sanitizeToolUsePartialJson(
		name: string,
		partialJson: string,
	): string {
		try {
			const input = JSON.parse(partialJson) as unknown;
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return partialJson;
			}
			return JSON.stringify(this.sanitizeToolUseInput(name, input));
		} catch {
			return partialJson;
		}
	}

	private extractContextWindow(
		response: Record<string, unknown> | undefined,
		usage: { input_tokens?: number } | undefined,
	): ContextWindow | null {
		const model = response?.model;
		if (typeof model !== "string") return null;
		const capability = resolveModelContextCapability("codex", model);
		if (!capability) return null;
		const contextWindowSize =
			process.env[CODEX_EFFECTIVE_CONTEXT_ENV] === "1"
				? capability.effectiveContextWindow
				: capability.rawContextWindow;

		const inputTokens = usage?.input_tokens;
		if (
			typeof inputTokens !== "number" ||
			!Number.isFinite(inputTokens) ||
			inputTokens < 0
		)
			return null;

		const usageRecord = usage as Record<string, unknown> | undefined;
		const inputTokenDetails = usageRecord?.input_tokens_details as
			| Record<string, unknown>
			| undefined;
		const normalized = normalizeCodexInputUsage(
			inputTokens,
			inputTokenDetails?.cached_tokens,
		);

		return {
			current_usage: {
				input_tokens: normalized.inputTokens,
				cache_read_input_tokens: normalized.cacheReadInputTokens,
				cache_creation_input_tokens:
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					Number.isFinite(inputTokenDetails.cache_creation_input_tokens) &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0,
			},
			context_window_size: contextWindowSize,
		};
	}

	private isSyntheticCountTokensRequest(url: string): boolean {
		return url === CODEX_SYNTHETIC_COUNT_TOKENS_URL;
	}

	private createSyntheticJsonResponse(
		request: Request,
		status: number,
		body: unknown,
	): Request {
		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-synthetic-response": "true",
			"x-better-ccflare-synthetic-status": String(status),
		});
		return new Request(CODEX_SYNTHETIC_RESPONSE_URL, {
			method: request.method,
			headers,
			body: JSON.stringify(body),
		});
	}

	private createSyntheticCountTokensResponse(
		request: Request,
		body: unknown,
	): Request {
		return this.createSyntheticJsonResponse(request, 200, {
			input_tokens: estimateAnthropicRequestTokens(body).tokens,
		});
	}

	private createSyntheticErrorResponse(
		request: Request,
		status: number,
		type: string,
		message: string,
	): Request {
		return this.createSyntheticJsonResponse(request, status, {
			type: "error",
			error: { type, message },
		});
	}

	private convertToCodexFormat(
		body: AnthropicRequest,
		account?: Account,
		requestId?: string,
		isAttributedAgent = false,
	): CodexConversionResult {
		const model = this.mapModel(body.model, account);
		if (process.env.DEBUG?.includes("model") || process.env.DEBUG === "true") {
			log.info(
				`[codex:model-debug] request_id=${requestId ?? "unknown"} request_model=${body.model} mapped_model=${model} account=${account?.name ?? "unknown"}`,
			);
		}
		const instructions = this.extractSystemPrompt(body.system);

		// Convert messages
		const input: CodexRequest["input"] = [];
		const skillCallIds = new Set<string>();
		let skillCompletedInFinalMessage = false;
		for (const [msgIndex, msg] of body.messages.entries()) {
			for (const item of this.convertMessage(msg)) {
				input.push(item);
				if ("type" in item && item.type === "function_call") {
					if (item.name === "Skill") {
						skillCallIds.add(item.call_id);
					}
				} else if (
					"type" in item &&
					item.type === "function_call_output" &&
					skillCallIds.has(item.call_id)
				) {
					skillCallIds.delete(item.call_id);
					if (msgIndex === body.messages.length - 1) {
						skillCompletedInFinalMessage = true;
					}
				}
			}
		}
		// A Skill result in the active turn means new instructions just loaded.
		// Native Claude continues on its own; Codex often stops, so append one
		// nudge. Tail placement keeps the cached prefix stable, and firing on
		// any final-turn Skill result (not only a trailing one) covers parallel
		// fan-out turns that mix Skill and other tool results.
		if (skillCompletedInFinalMessage) {
			input.push({
				role: "user",
				content: [
					{
						type: "input_text",
						text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
					},
				],
			});
		}

		const finalInstructions = instructions || "You are a helpful assistant.";
		const orchestrationToolNames = new Set(["Agent", "Task"]);
		const offersOrchestrationTools =
			body.tools?.some((tool) => orchestrationToolNames.has(tool.name)) ??
			false;
		let orchestrationAdmission: OrchestrationAdmission;
		if (!offersOrchestrationTools) {
			orchestrationAdmission = "no_orchestration_tools";
		} else if (process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV] === "0") {
			orchestrationAdmission = "disabled";
		} else {
			const sessionId = this.extractSessionId(body);
			if (!sessionId) {
				orchestrationAdmission = "no_session";
			} else {
				const conversationId = deriveConversationIdentity(
					sessionId,
					finalInstructions,
					input,
				);
				orchestrationAdmission = conversationId
					? electOrchestrationRoot(sessionId, conversationId)
					: "no_conversation";
			}
		}

		// Descendants are always filtered. For ordinary requests, only the elected
		// root retains current Agent and Task declarations. Historical calls and
		// results are already represented in input and remain untouched.
		const shouldFilterOrchestrationTools =
			isAttributedAgent || orchestrationAdmission === "non_root";
		const filteredToolNames = shouldFilterOrchestrationTools
			? (body.tools ?? [])
					.filter((tool) => orchestrationToolNames.has(tool.name))
					.map((tool) => tool.name)
			: [];
		let tools: CodexTool[] | undefined;
		if (body.tools && body.tools.length > 0) {
			const currentTools = shouldFilterOrchestrationTools
				? body.tools.filter((tool) => !orchestrationToolNames.has(tool.name))
				: body.tools;
			tools = currentTools.map((t) => ({
				type: "function" as const,
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			}));
		}

		const reasoningResolution = resolveReasoningEffort(body.reasoning?.effort, {
			sourceModel: body.model,
			targetModel: model,
		});
		if (reasoningResolution.downgrades.length > 0) {
			for (const downgrade of reasoningResolution.downgrades) {
				log.warn(
					`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
				);
			}
		}

		// Codex always requires streaming upstream; non-streaming clients are handled
		// on the response side via transformSseResponseToJson.
		const codexRequest: CodexRequest = {
			model,
			input,
			stream: true,
			store: false,
			reasoning: { effort: reasoningResolution.effort ?? "medium" },
		};

		codexRequest.instructions = finalInstructions;
		const cacheKeyDecision = this.derivePromptCacheKey(
			body,
			codexRequest.instructions,
			input,
			account,
		);
		if (cacheKeyDecision.key) {
			codexRequest.prompt_cache_key = cacheKeyDecision.key;
		}
		const explicitToolChoice = this.convertToolChoice(
			body.tool_choice,
			tools ?? [],
		);
		if (tools) {
			codexRequest.tools = tools;
			if (explicitToolChoice) {
				codexRequest.tool_choice = explicitToolChoice;
			} else if (tools.some((t) => t.name === "StructuredOutput")) {
				// Claude Code schema agents provide a StructuredOutput tool but do not set
				// Anthropic tool_choice. Native Claude reliably follows the hidden schema
				// instruction; Codex models often end_turn with text instead. Force the
				// function when this sentinel tool is present to preserve workflow semantics.
				codexRequest.tool_choice = {
					type: "function",
					name: "StructuredOutput",
				};
			}
			if (body.tool_choice?.disable_parallel_tool_use === true) {
				codexRequest.parallel_tool_calls = false;
			}
		}

		if (
			typeof body.max_tokens === "number" &&
			Number.isFinite(body.max_tokens)
		) {
			if (body.max_tokens > 0) {
				codexRequest.max_output_tokens = Math.floor(body.max_tokens);
			} else if (body.max_tokens === 0) {
				// Anthropic max_tokens: 0 is a cache-prewarm request that must not
				// generate. The Responses schema has no zero-output mode, so clamp
				// to the 1-token minimum the usage ping already uses instead of
				// dropping the cap and allowing unbounded generation.
				codexRequest.max_output_tokens = 1;
			}
		}

		return {
			codexBody: codexRequest,
			cacheKeyDecision,
			orchestrationAdmission,
			filteredToolNames,
		};
	}

	private async transformSseResponseToJson(
		response: Response,
		requestId = response.headers.get("x-better-ccflare-request-id") ??
			"unknown",
		attemptId = response.headers.get("x-better-ccflare-attempt-id") ??
			undefined,
		finalModel = response.headers.get("x-better-ccflare-final-model") ??
			undefined,
	): Promise<Response> {
		const transformed = this.transformStreamingResponse(
			response,
			requestId,
			attemptId,
			finalModel,
		);
		const reader = transformed.body
			?.pipeThrough(new TextDecoderStream())
			.getReader();
		let messageStartPayload: Record<string, unknown> | null = null;
		let messageDeltaPayload: Record<string, unknown> | null = null;
		let errorPayload: Record<string, unknown> | null = null;
		const content: Array<Record<string, unknown>> = [];
		const textByIndex = new Map<number, string>();
		const toolByIndex = new Map<
			number,
			{ id: string; name: string; partialJson: string }
		>();

		// Parse SSE line-pairs incrementally without buffering full body
		let pending = "";
		let lastEventName: string | null = null;
		const processLine = (line: string) => {
			if (line.startsWith("event:")) {
				lastEventName = line.slice("event:".length).trim();
			} else if (line.startsWith("data:") && lastEventName !== null) {
				const eventName = lastEventName;
				lastEventName = null;
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(line.slice("data:".length).trim());
				} catch {
					return;
				}
				if (eventName === "error") {
					errorPayload = data;
					return;
				}
				if (eventName === "message_start") {
					messageStartPayload = data;
					return;
				}
				if (eventName === "message_delta") {
					messageDeltaPayload = data;
					return;
				}
				if (eventName === "content_block_delta") {
					const index = typeof data.index === "number" ? data.index : -1;
					const delta = data.delta as Record<string, unknown> | undefined;
					if (index < 0 || !delta) return;
					if (delta.type === "text_delta" && typeof delta.text === "string") {
						textByIndex.set(index, (textByIndex.get(index) ?? "") + delta.text);
					} else if (
						delta.type === "input_json_delta" &&
						typeof delta.partial_json === "string"
					) {
						const existing = toolByIndex.get(index);
						if (existing) {
							existing.partialJson += delta.partial_json;
						} else {
							toolByIndex.set(index, {
								id: "",
								name: "",
								partialJson: delta.partial_json,
							});
						}
					}
					return;
				}
				if (eventName === "content_block_start") {
					const index = typeof data.index === "number" ? data.index : -1;
					const block = data.content_block as
						| Record<string, unknown>
						| undefined;
					if (index < 0 || !block) return;
					if (block.type === "tool_use") {
						toolByIndex.set(index, {
							id: typeof block.id === "string" ? block.id : "",
							name: typeof block.name === "string" ? block.name : "",
							partialJson: toolByIndex.get(index)?.partialJson ?? "",
						});
					}
				}
			}
		};

		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					pending += value;
					const parts = pending.split("\n");
					pending = parts.pop() ?? "";
					for (const line of parts) {
						processLine(line);
					}
				}
				if (pending) processLine(pending);
			} finally {
				reader.releaseLock();
			}
		}

		if (errorPayload) {
			const headers = sanitizeResponseHeaders(response.headers);
			headers.set("content-type", "application/json");
			const { status, statusText } =
				this.httpStatusForAnthropicErrorPayload(errorPayload);
			return new Response(JSON.stringify(errorPayload), {
				status,
				statusText,
				headers,
			});
		}

		const allIndices = new Set([...textByIndex.keys(), ...toolByIndex.keys()]);
		for (const index of [...allIndices].sort((a, b) => a - b)) {
			const text = textByIndex.get(index);
			if (text !== undefined) {
				content.push({ type: "text", text });
			}
			const tool = toolByIndex.get(index);
			if (tool !== undefined) {
				let input: Record<string, unknown> = {};
				if (tool.partialJson.trim().length > 0) {
					try {
						input = JSON.parse(tool.partialJson) as Record<string, unknown>;
					} catch {
						input = {};
					}
				}
				content.push({
					type: "tool_use",
					id: tool.id || `call_${index}`,
					name: tool.name,
					input: this.sanitizeToolUseInput(tool.name, input),
				});
			}
		}
		const startMessage =
			((messageStartPayload as Record<string, unknown> | null)?.message as
				| Record<string, unknown>
				| undefined) ?? {};
		const hasDeltaUsage = messageDeltaPayload !== null;
		const deltaUsage = _normalizeUsage(
			(messageDeltaPayload as Record<string, unknown> | null)?.usage,
		);
		const startUsage = _normalizeUsage(startMessage.usage);
		const usage = {
			input_tokens: hasDeltaUsage
				? deltaUsage.input_tokens
				: startUsage.input_tokens,
			output_tokens: hasDeltaUsage
				? deltaUsage.output_tokens
				: startUsage.output_tokens,
			cache_read_input_tokens: hasDeltaUsage
				? deltaUsage.cache_read_input_tokens
				: startUsage.cache_read_input_tokens,
			cache_creation_input_tokens: hasDeltaUsage
				? deltaUsage.cache_creation_input_tokens
				: startUsage.cache_creation_input_tokens,
		};
		const resolvedModel =
			typeof startMessage.model === "string" ? startMessage.model : "gpt-5.4";
		if (
			resolvedModel === "gpt-5.4" &&
			(process.env.DEBUG?.includes("model") || process.env.DEBUG === "true")
		) {
			log.info(
				`[codex:model-debug] request_id=${requestId} transformSseResponseToJson used fallback model=gpt-5.4 (startMessage.model missing)`,
			);
		}
		const stopReason = content.some((block) => block.type === "tool_use")
			? "tool_use"
			: "end_turn";
		const jsonPayload = {
			id:
				typeof startMessage.id === "string"
					? startMessage.id
					: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			type: "message",
			role: "assistant",
			model: resolvedModel,
			content: content.length > 0 ? content : [{ type: "text", text: "" }],
			stop_reason: stopReason,
			stop_sequence: null,
			usage,
		};
		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "application/json");
		return new Response(JSON.stringify(jsonPayload), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private transformStreamingResponse(
		response: Response,
		requestId = response.headers.get("x-better-ccflare-request-id") ??
			"unknown",
		attemptId = response.headers.get("x-better-ccflare-attempt-id") ??
			undefined,
		finalModel = response.headers.get("x-better-ccflare-final-model") ??
			"unknown",
	): Response {
		const state: StreamState = {
			messageId: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			model: finalModel,
			contentBlockIndex: 0,
			hasSentMessageStart: false,
			hasSentContentBlockStart: false,
			hasSentTerminalEvents: false,
			totalInputTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			usageMeasurementAvailable: false,
			cacheMeasurementAvailable: false,
			contextWindow: null,
			functionCallBlocks: new Map(),
			functionCallBytesTotal: 0,
			sawToolUse: false,
			traceNewToolCalls: [],
			traceRequestId: requestId,
			traceAttemptId: attemptId,
			terminalTraceWritten: false,
		};

		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "text/event-stream");

		const upstreamReader = response.body?.getReader();
		let downstreamController: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		let pullWaiters: Array<() => void> = [];
		const releasePullWaiters = () => {
			const waiters = pullWaiters;
			pullWaiters = [];
			for (const waiter of waiters) waiter();
		};
		const awaitDownstreamCapacity = async () => {
			while (!cancelled && (downstreamController.desiredSize ?? 1) <= 0) {
				await new Promise<void>((resolve) => {
					pullWaiters.push(resolve);
				});
			}
		};
		const writeTerminalTrace = (
			error?: {
				type: string;
				message: string;
				code?: string;
				status?: string;
			},
			stopReason:
				| "error"
				| "end_turn"
				| "tool_use"
				| "max_tokens"
				| "refusal" = "error",
		) => {
			if (state.terminalTraceWritten) return;
			state.hasSentTerminalEvents = true;
			writeCodexStreamTerminalTrace(state, stopReason, error);
		};
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				downstreamController = controller;
			},
			pull() {
				releasePullWaiters();
			},
			async cancel(reason) {
				cancelled = true;
				writeTerminalTrace({
					type: "downstream_cancelled",
					message:
						typeof reason === "string" && reason
							? reason
							: "Downstream response was cancelled",
				});
				releasePullWaiters();
				await upstreamReader?.cancel(reason).catch(() => undefined);
			},
		});
		const encoder = new TextEncoder();
		const sseFrameBuffer = new SseFrameBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_BUFFER_MAX_BYTES,
		});

		const writeSSE = async (event: string, data: unknown) => {
			const payload =
				typeof data === "object" && data !== null
					? (data as Record<string, unknown>)
					: null;
			if ((event === "message_start" || event === "message_delta") && payload) {
				const normalizedUsage = _normalizeUsage(payload.usage);
				payload.usage = normalizedUsage;
				if (event === "message_start") {
					const message =
						typeof payload.message === "object" && payload.message !== null
							? (payload.message as Record<string, unknown>)
							: {};
					message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					payload.message = message;
				} else {
					const message = payload.message as
						| Record<string, unknown>
						| undefined;
					if (message) {
						message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					}
				}
			}
			if (event === "message_delta" && payload) {
				const delta =
					typeof payload.delta === "object" && payload.delta !== null
						? (payload.delta as Record<string, unknown>)
						: {};
				if (!("stop_reason" in delta)) {
					delta.stop_reason = "end_turn";
				}
				if (!("stop_sequence" in delta)) {
					delta.stop_sequence = null;
				}
				if (!("usage" in delta)) {
					delta.usage = payload.usage;
				}
				payload.delta = delta;
			}
			await awaitDownstreamCapacity();
			if (cancelled) throw new Error("Downstream response was cancelled");
			const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			downstreamController.enqueue(encoder.encode(line));
		};
		const ensureMessageStart = async () => {
			if (state.hasSentMessageStart) return;
			state.hasSentMessageStart = true;
			await writeSSE("message_start", {
				type: "message_start",
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				message: {
					id: state.messageId,
					type: "message",
					role: "assistant",
					content: [],
					model: state.model,
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
		};

		const processEvents = async () => {
			try {
				if (!upstreamReader) throw new Error("Response body is not readable");

				while (true) {
					const { value, done } = await upstreamReader.read();
					if (done) break;

					// Frame boundary detection and cap enforcement live in
					// SseFrameBuffer (CRLF-tolerant, bounds both a single oversized
					// frame and an unterminated tail). It may throw SseLimitError,
					// which is handled by the dedicated branch in the catch below.
					const frames = sseFrameBuffer.push(value);

					// Process complete SSE events extracted from this chunk
					for (const eventText of frames) {
						const eventLine = eventText
							.split(/\r?\n/)
							.find((l) => l.startsWith("event:"));
						const dataLine = eventText
							.split(/\r?\n/)
							.find((l) => l.startsWith("data:"));

						if (!eventLine || !dataLine) continue;

						const eventName = eventLine.slice("event:".length).trim();
						const dataStr = dataLine.slice("data:".length).trim();

						if (dataStr === "[DONE]") continue;

						let data: Record<string, unknown>;
						try {
							data = JSON.parse(dataStr);
						} catch {
							continue;
						}

						await this.handleCodexEvent(
							eventName,
							data,
							state,
							writeSSE,
							ensureMessageStart,
						);
					}
				}

				if (state.upstreamError) {
					return;
				}

				// Flush any remaining
				await ensureMessageStart();

				// Close any open content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
				}

				if (!state.hasSentTerminalEvents) {
					const abruptError = {
						type: "abrupt_stream_eof",
						message:
							"Codex upstream stream ended before a terminal response event.",
					};
					await writeSSE("error", {
						type: "error",
						error: abruptError,
						model: state.model,
					});
					writeTerminalTrace(abruptError);
				}
			} catch (error) {
				if (!cancelled) {
					if (error instanceof SseLimitError) {
						// Cap trips are a distinct, expected failure mode (an
						// oversized/unterminated SSE frame or tool-call argument
						// buffer), not a generic stream read failure: route them
						// through the same close-block-then-error helper the
						// upstream error/response.failed handler uses instead of
						// the generic branch below.
						const capError = {
							type: "sse_limit_exceeded",
							message: error.message,
						};
						try {
							await this.closeOpenBlockAndWriteError(
								state,
								writeSSE,
								ensureMessageStart,
								{
									type: "error",
									error: {
										type: "api_error",
										message: error.message,
										code: "sse_limit_exceeded",
									},
								},
							);
						} catch {
							// Downstream may already be cancelled or closed.
						}
						writeTerminalTrace(capError);
					} else {
						log.error("Error processing Codex SSE stream:", error);
						const streamError = {
							type: "upstream_stream_read_error",
							message:
								error instanceof Error
									? error.message
									: "Codex upstream stream processing failed",
						};
						try {
							if (!state.hasSentMessageStart) {
								await ensureMessageStart();
							}
							if (!state.hasSentTerminalEvents) {
								await writeSSE("error", {
									type: "error",
									error: streamError,
									model: state.model,
								});
							}
						} catch {
							// Downstream may already be cancelled or closed.
						}
						writeTerminalTrace(streamError);
					}
				}
				await upstreamReader?.cancel(error).catch(() => undefined);
			} finally {
				upstreamReader?.releaseLock();
				if (!cancelled) downstreamController.close();
			}
		};

		void processEvents().catch((error) => {
			log.error("Unhandled Codex SSE processing failure:", error);
		});

		return new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private normalizeCodexStreamError(
		_eventName: string,
		data: Record<string, unknown>,
	): StreamState["upstreamError"] {
		const response =
			data.response && typeof data.response === "object"
				? (data.response as Record<string, unknown>)
				: undefined;
		const responseError =
			response?.error && typeof response.error === "object"
				? (response.error as Record<string, unknown>)
				: undefined;
		const directError =
			data.error && typeof data.error === "object"
				? (data.error as Record<string, unknown>)
				: undefined;
		const error = responseError ?? directError ?? data;
		const messageCandidate = error.message ?? data.message ?? response?.status;
		const rawType = typeof error.type === "string" ? error.type : "";
		const rawCode = typeof error.code === "string" ? error.code : "";
		const typeCandidate = rawType && rawType !== "error" ? rawType : rawCode;
		const codeCandidate = error.code ?? data.code;
		const statusCandidate = response?.status ?? data.status;

		return {
			type: typeCandidate || "api_error",
			message:
				typeof messageCandidate === "string" && messageCandidate.length > 0
					? messageCandidate
					: "Codex upstream failed while generating a response.",
			...(typeof codeCandidate === "string" ? { code: codeCandidate } : {}),
			...(typeof statusCandidate === "string"
				? { status: statusCandidate }
				: {}),
		};
	}

	private toAnthropicErrorPayload(error: StreamState["upstreamError"]): {
		type: "error";
		error: { type: string; message: string; code?: string; status?: string };
	} {
		const code = error?.code;
		const status = error?.status === "rate_limited" ? error.status : undefined;
		const rawType = error?.type;
		let type = "api_error";
		const mappedFromCode = code
			? CODEX_ERROR_TYPE_BY_CODE[code.toLowerCase()]
			: undefined;
		if (mappedFromCode) {
			type = mappedFromCode;
		} else if (status === "rate_limited") {
			type = "rate_limit_error";
		} else if (
			rawType === "invalid_request_error" ||
			rawType === "authentication_error" ||
			rawType === "permission_error" ||
			rawType === "not_found_error" ||
			rawType === "rate_limit_error" ||
			rawType === "overloaded_error" ||
			rawType === "api_error"
		) {
			type = rawType;
		}
		const upstreamMessage = error?.message || "Codex upstream failed.";
		const normalizedCode = code?.toLowerCase();
		const isContextOverflow =
			normalizedCode === "context_length_exceeded" ||
			/^your input exceeds the context window\b/i.test(upstreamMessage);
		const message = isContextOverflow
			? `Prompt is too long. Codex reported: ${upstreamMessage}`
			: upstreamMessage;
		return {
			type: "error",
			error: {
				type,
				message,
				...(code ? { code } : {}),
				...(status ? { status } : {}),
			},
		};
	}

	private httpStatusForAnthropicErrorPayload(
		payload: Record<string, unknown>,
	): {
		status: number;
		statusText: string;
	} {
		const error =
			payload.error && typeof payload.error === "object"
				? (payload.error as Record<string, unknown>)
				: {};
		const type = typeof error.type === "string" ? error.type : "";
		const code = typeof error.code === "string" ? error.code : "";
		const status = typeof error.status === "string" ? error.status : "";

		if (code === "context_length_exceeded") {
			return { status: 400, statusText: "Bad Request" };
		}
		if (type === "invalid_request_error") {
			return { status: 400, statusText: "Bad Request" };
		}
		if (type === "authentication_error") {
			return { status: 401, statusText: "Unauthorized" };
		}
		if (type === "permission_error") {
			return { status: 403, statusText: "Forbidden" };
		}
		if (
			type === "rate_limit_error" ||
			code === "rate_limit_exceeded" ||
			status === "rate_limited"
		) {
			return { status: 429, statusText: "Too Many Requests" };
		}
		if (type === "overloaded_error") {
			return { status: 529, statusText: "Overloaded" };
		}
		return { status: 502, statusText: "Bad Gateway" };
	}

	/**
	 * Close any open content block, then write a terminal error event.
	 * Shared by the upstream error/response.failed handler and by SSE/tool-arg
	 * cap trips, so both paths emit the same well-formed event ordering:
	 * message_start (if not already sent) → content_block_stop (if a block
	 * was open) → error. No-op if a terminal event was already sent.
	 */
	private async closeOpenBlockAndWriteError(
		state: StreamState,
		writeSSE: (event: string, data: unknown) => Promise<void>,
		ensureMessageStart: () => Promise<void>,
		errorPayload: { type: "error"; error: Record<string, unknown> },
	): Promise<void> {
		if (state.hasSentTerminalEvents) return;
		await ensureMessageStart();
		if (state.hasSentContentBlockStart) {
			await writeSSE("content_block_stop", {
				type: "content_block_stop",
				index: state.contentBlockIndex,
			});
			state.contentBlockIndex++;
			state.hasSentContentBlockStart = false;
		}
		await writeSSE("error", errorPayload);
		state.hasSentTerminalEvents = true;
	}

	private async handleCodexEvent(
		eventName: string,
		data: Record<string, unknown>,
		state: StreamState,
		writeSSE: (event: string, data: unknown) => Promise<void>,
		ensureMessageStart: () => Promise<void>,
	): Promise<void> {
		switch (eventName) {
			case "response.created": {
				const resp = data.response as Record<string, unknown> | undefined;
				const usage = resp?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_creation_input_tokens?: number;
							};
					  }
					| undefined;
				if (usage) {
					state.usageMeasurementAvailable =
						typeof usage.input_tokens === "number";
					state.cacheMeasurementAvailable =
						state.usageMeasurementAvailable &&
						typeof usage.input_tokens_details?.cached_tokens === "number";
					const normalized = normalizeCodexInputUsage(
						usage.input_tokens,
						usage.input_tokens_details?.cached_tokens,
					);
					state.totalInputTokens = normalized.totalInputTokens;
					state.inputTokens = normalized.inputTokens;
					state.cacheReadInputTokens = normalized.cacheReadInputTokens;
					if (
						typeof usage.output_tokens === "number" &&
						Number.isFinite(usage.output_tokens) &&
						usage.output_tokens >= 0
					) {
						state.outputTokens = usage.output_tokens;
					}
					const cacheCreation =
						usage.input_tokens_details?.cache_creation_input_tokens;
					if (
						typeof cacheCreation === "number" &&
						Number.isFinite(cacheCreation) &&
						cacheCreation >= 0
					) {
						state.cacheCreationInputTokens = cacheCreation;
					}
				}
				const respId = (resp?.id as string) || state.messageId;
				state.messageId = respId;
				state.model = (resp?.model as string) || state.model;
				if (
					state.hasSentMessageStart ||
					!codexEventCommitsOutput(eventName, data)
				) {
					break;
				}

				await ensureMessageStart();
				break;
			}

			case "response.output_item.added": {
				const item = data.item as Record<string, unknown> | undefined;
				const outputIndex = data.output_index as number | undefined;

				// Text content blocks start on content_part.added instead, so
				// message items (and anything other than function_call) have
				// nothing to emit here.
				if (codexEventCommitsOutput(eventName, data)) {
					const callId = item?.call_id as string;
					const name = item?.name as string;
					state.sawToolUse = true;

					if (state.hasSentContentBlockStart) {
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: state.contentBlockIndex,
						});
						state.contentBlockIndex++;
						state.hasSentContentBlockStart = false;
					}

					const blockIdx = state.contentBlockIndex;
					await ensureMessageStart();
					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: blockIdx,
						content_block: { type: "tool_use", id: callId, name, input: {} },
					});
					state.hasSentContentBlockStart = true;
					if (outputIndex !== undefined) {
						state.functionCallBlocks.set(outputIndex, {
							contentBlockIndex: blockIdx,
							name,
							arguments: [],
							bytes: 0,
						});
					}
				}
				break;
			}

			case "response.content_part.added": {
				if (codexEventCommitsOutput(eventName, data)) {
					await ensureMessageStart();
					// Start a text content block
					if (state.hasSentContentBlockStart) {
						// Only close the current block if it's not a still-open function-call
						// block awaiting output_item.done — closing it here would produce a
						// premature content_block_stop that output_item.done will duplicate.
						const isOpenFunctionCallBlock = [
							...state.functionCallBlocks.values(),
						].some((b) => b.contentBlockIndex === state.contentBlockIndex);
						if (!isOpenFunctionCallBlock) {
							await writeSSE("content_block_stop", {
								type: "content_block_stop",
								index: state.contentBlockIndex,
							});
						}
						state.contentBlockIndex++;
					}

					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: state.contentBlockIndex,
						content_block: { type: "text", text: "" },
					});
					state.hasSentContentBlockStart = true;
				}
				break;
			}

			case "response.output_text.delta": {
				const delta = data.delta as string | undefined;
				if (codexEventCommitsOutput(eventName, data)) {
					await ensureMessageStart();
					await writeSSE("content_block_delta", {
						type: "content_block_delta",
						index: state.contentBlockIndex,
						delta: { type: "text_delta", text: delta },
					});
				}
				break;
			}

			case "response.function_call_arguments.delta": {
				const delta = data.delta as string | undefined;
				const outputIndex = data.output_index as number | undefined;
				if (delta && outputIndex !== undefined) {
					const buffer = state.functionCallBlocks.get(outputIndex);
					if (buffer) {
						const deltaBytes = byteEncoder.encode(delta).length;
						buffer.arguments.push(delta);
						buffer.bytes += deltaBytes;
						state.functionCallBytesTotal += deltaBytes;
						// Per-call cap: guards a single runaway tool call.
						if (buffer.bytes > TOOL_ARGS_BYTE_CAP) {
							throw new SseLimitError(
								`Tool call arguments for output_index ${outputIndex} totaled ${buffer.bytes} bytes, exceeding the ${TOOL_ARGS_BYTE_CAP} byte cap`,
								TOOL_ARGS_BYTE_CAP,
								buffer.bytes,
							);
						}
						// Aggregate cap: guards many concurrently open tool calls that
						// each individually stay under the per-call cap but together
						// still grow the buffered byte total without bound.
						if (state.functionCallBytesTotal > TOOL_ARGS_BYTE_CAP) {
							throw new SseLimitError(
								`Aggregate tool call arguments totaled ${state.functionCallBytesTotal} bytes, exceeding the ${TOOL_ARGS_BYTE_CAP} byte cap`,
								TOOL_ARGS_BYTE_CAP,
								state.functionCallBytesTotal,
							);
						}
					}
				}
				break;
			}

			case "response.output_item.done": {
				const item = data.item as Record<string, unknown> | undefined;
				const itemType = item?.type as string | undefined;

				if (itemType === "function_call") {
					const outputIndex = data.output_index as number | undefined;
					const buffer =
						outputIndex !== undefined
							? state.functionCallBlocks.get(outputIndex)
							: undefined;
					if (buffer) {
						const partialJson = this.sanitizeToolUsePartialJson(
							buffer.name,
							buffer.arguments.join(""),
						);
						state.traceNewToolCalls.push({
							name: buffer.name,
							arg_preview: partialJson.slice(0, 120),
						});
						await writeSSE("content_block_delta", {
							type: "content_block_delta",
							index: buffer.contentBlockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: partialJson,
							},
						});
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: buffer.contentBlockIndex,
						});
						if (outputIndex !== undefined) {
							state.functionCallBytesTotal -= buffer.bytes;
							state.functionCallBlocks.delete(outputIndex);
						}
						if (
							state.hasSentContentBlockStart &&
							state.contentBlockIndex === buffer.contentBlockIndex
						) {
							state.contentBlockIndex++;
							state.hasSentContentBlockStart = false;
						}
					}
					break;
				}

				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.contentBlockIndex++;
					state.hasSentContentBlockStart = false;
				}
				break;
			}

			case "error":
			case "response.failed": {
				const response =
					data.response && typeof data.response === "object"
						? (data.response as Record<string, unknown>)
						: undefined;
				const usage = response?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_creation_input_tokens?: number;
							};
					  }
					| undefined;
				state.usageMeasurementAvailable =
					typeof usage?.input_tokens === "number";
				state.cacheMeasurementAvailable =
					state.usageMeasurementAvailable &&
					typeof usage?.input_tokens_details?.cached_tokens === "number";
				if (usage) {
					const details = usage.input_tokens_details;
					const normalized = normalizeCodexInputUsage(
						usage.input_tokens,
						details?.cached_tokens,
					);
					state.totalInputTokens = normalized.totalInputTokens;
					state.inputTokens = normalized.inputTokens;
					state.cacheReadInputTokens = normalized.cacheReadInputTokens;
					if (
						typeof usage.output_tokens === "number" &&
						Number.isFinite(usage.output_tokens) &&
						usage.output_tokens >= 0
					) {
						state.outputTokens = usage.output_tokens;
					}
					state.cacheCreationInputTokens =
						typeof details?.cache_creation_input_tokens === "number" &&
						Number.isFinite(details.cache_creation_input_tokens) &&
						details.cache_creation_input_tokens >= 0
							? details.cache_creation_input_tokens
							: 0;
				}
				if (typeof response?.model === "string") state.model = response.model;
				state.contextWindow = this.extractContextWindow(response, usage);
				state.upstreamError = this.normalizeCodexStreamError(eventName, data);
				if (!state.hasSentTerminalEvents) {
					// Claim the terminal trace before awaiting downstream writes so a
					// cancellation race cannot record two terminals for one attempt.
					writeCodexStreamTerminalTrace(state, "error", state.upstreamError);
					// closeOpenBlockAndWriteError calls ensureMessageStart() first, so
					// an error arriving as the literal first SSE event still emits
					// message_start before error.
					await this.closeOpenBlockAndWriteError(
						state,
						writeSSE,
						ensureMessageStart,
						this.toAnthropicErrorPayload(state.upstreamError),
					);
				}
				break;
			}

			case "response.incomplete":
			case "response.completed": {
				if (state.upstreamError || state.hasSentTerminalEvents) break;
				const resp = data.response as Record<string, unknown> | undefined;
				const usage = resp?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_creation_input_tokens?: number;
							};
					  }
					| undefined;

				const inputTokenDetails = usage?.input_tokens_details;
				state.usageMeasurementAvailable =
					typeof usage?.input_tokens === "number";
				state.cacheMeasurementAvailable =
					state.usageMeasurementAvailable &&
					typeof inputTokenDetails?.cached_tokens === "number";
				const normalizedInput = normalizeCodexInputUsage(
					usage?.input_tokens,
					inputTokenDetails?.cached_tokens,
				);
				const cacheCreation =
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					Number.isFinite(inputTokenDetails.cache_creation_input_tokens) &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0;

				state.totalInputTokens = normalizedInput.totalInputTokens;
				state.inputTokens = normalizedInput.inputTokens;
				state.outputTokens =
					typeof usage?.output_tokens === "number" &&
					Number.isFinite(usage.output_tokens) &&
					usage.output_tokens >= 0
						? usage.output_tokens
						: state.outputTokens;
				state.cacheReadInputTokens = normalizedInput.cacheReadInputTokens;
				state.cacheCreationInputTokens = cacheCreation;
				state.contextWindow = this.extractContextWindow(resp, usage);
				// Close any lingering content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.hasSentContentBlockStart = false;
				}

				const incompleteDetails = resp?.incomplete_details as
					| { reason?: string }
					| undefined;
				const isIncomplete =
					eventName === "response.incomplete" || resp?.status === "incomplete";
				// An incomplete response never resolves to a success stop_reason:
				// content_filter → refusal (client discards partial output); every
				// other reason, including unknown future ones, → max_tokens (generic
				// truncation, mirroring real Anthropic mid-tool-input truncation
				// semantics: partial blocks are framed, stop_reason forbids execution).
				const stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" =
					isIncomplete
						? incompleteDetails?.reason === "content_filter"
							? "refusal"
							: "max_tokens"
						: state.sawToolUse
							? "tool_use"
							: "end_turn";

				const messageDelta: {
					type: "message_delta";
					delta: {
						stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
						stop_sequence: null;
					};
					usage: {
						input_tokens: number;
						output_tokens: number;
						cache_read_input_tokens: number;
						cache_creation_input_tokens: number;
					};
					context_window?: ContextWindow;
				} = {
					type: "message_delta",
					delta: {
						stop_reason: stopReason,
						stop_sequence: null,
					},
					usage: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						cache_read_input_tokens: state.cacheReadInputTokens,
						cache_creation_input_tokens: state.cacheCreationInputTokens,
					},
				};
				if (state.contextWindow) {
					messageDelta.context_window = state.contextWindow;
				}

				writeCodexStreamTerminalTrace(state, messageDelta.delta.stop_reason);
				await writeSSE("message_delta", messageDelta);
				await writeSSE("message_stop", { type: "message_stop" });
				state.hasSentTerminalEvents = true;
				break;
			}
			default:
				// Ignore unknown events
				break;
		}
	}
}
