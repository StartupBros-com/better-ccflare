import { createHash, randomUUID } from "node:crypto";
import { getCodexReasoningRetention } from "@better-ccflare/config";
import {
	BUFFER_SIZES,
	getExactOAuthErrorCode,
	getModelFamily,
	getOAuthErrorCode,
	isForceAccountModelEnabled,
	MAX_OAUTH_ERROR_INPUT_LENGTH,
	mapModelName,
	OAuthRefreshTokenError,
	readBoundedOAuthResponseText,
	SseFrameBuffer,
	StreamResourceLimitError,
	ValidationError,
	validateEndpointUrl,
} from "@better-ccflare/core";
import {
	CODEX_LOGICAL_MODEL_FAMILY_HEADER,
	sanitizeProxyHeaders,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	type AnthropicReasoningEffortSource,
	isGpt56SolModel,
	type ReasoningEffort,
	resolveAnthropicReasoningEffort,
	sanitizeSchemaForOpenAI,
} from "@better-ccflare/openai-formats";
import type {
	Account,
	LogicalModelCapability,
	ServerToolCapabilityDecision,
	ServerToolCapabilityTuple,
	ServerToolRequirements,
} from "@better-ccflare/types";
import {
	RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER,
} from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import {
	registerProviderModelDefaultFactory,
	resolveProviderModelDefault,
} from "../../provider-model-defaults";
import {
	estimateAnthropicRequestTokens,
	resolveModelContextCapability,
} from "../../request-capabilities";
import type {
	ProviderAttemptPlanContext,
	ProviderServerToolCapabilityContext,
	ProviderServerToolReplayIssuer,
	RateLimitInfo,
	RequestObservation,
	TokenRefreshResult,
	UpstreamObservationContext,
} from "../../types";
import { CODEX_REASONING_RETENTION_PREFIX } from "../../utils/codex-reasoning-retention";
import {
	applySkillElision,
	resolveSkillElisionBlockedSkills,
} from "../../utils/skill-elision";
import {
	drainReaderWithDeadline,
	getResponseDrainTransport,
	transferResponseDrainTransport,
} from "../../utils/stream-drain";
import {
	CODEX_CACHE_DIAGNOSTICS_ENV,
	CodexCacheDiagnostics,
} from "./cache-diagnostics";
import {
	type CacheFacts,
	cacheDigest,
	persistCacheTelemetry,
	sanitizeCacheFacts,
} from "./cache-telemetry";
import { observeCodexWire } from "./cache-wire";
import {
	CODEX_SINGLE_ORCHESTRATION_ROOT_ENV,
	deriveConversationIdentity,
	electOrchestrationRoot,
	type OrchestrationAdmission,
	type OrchestrationAdmissionBasis,
	snapshotOrchestrationRoot,
} from "./orchestration-election";
import {
	createCodexHostedSearchAttemptPlan,
	processCodexHostedSearchResponse,
} from "./server-tool-attempt-plan";
import {
	createCodexServerToolCapabilityTuple,
	resolveCodexServerToolCapability,
} from "./server-tools";
import {
	CodexStreamLiveness,
	type CodexStreamLivenessOptions,
} from "./stream-liveness";
import {
	summarizeCodexResponse,
	type ToolCallSummary,
	writeCodexAbortedAttemptTrace,
	writeCodexResponseTrace,
	writeCodexTrace,
} from "./trace";
import {
	type CodexTurnStateAttemptCause,
	CodexTurnStateCoordinator,
	type CodexTurnStateLineage,
	type CodexTurnStateTerminalAction,
	codexInputEndsWithToolOutput,
	extractCodexTurnStateLineage,
	fingerprintCodexTurnStateCallId,
	normalizeCodexTurnStateFingerprints,
} from "./turn-state";
import { normalizeCodexResponseInputUsage } from "./usage";

const log = new Logger("CodexProvider");

/**
 * Shared sink for cache-diagnostics lifecycle facts (observer readiness,
 * sweeps, coverage gaps): logs a bounded, sanitized summary and forwards to
 * the opt-in private telemetry file. Never throws into the caller -- a
 * diagnostics failure must not affect the request path.
 */
function recordCacheLifecycle(facts: CacheFacts): void {
	log.info("Codex cache observation lifecycle", sanitizeCacheFacts(facts));
	persistCacheTelemetry(facts, (dropped) =>
		log.warn("Codex cache telemetry persistence failure", {
			dropped_events: dropped,
		}),
	);
}

export { CODEX_LOGICAL_MODEL_FAMILY_HEADER };

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
	"x-better-ccflare-pacing-role",
	"x-better-ccflare-pacing-wait-ms",
	"x-better-ccflare-pacing-release-reason",
	"x-better-ccflare-codex-conversation-id",
];

function sanitizeResponseHeaders(headers: Headers): Headers {
	const sanitized = sanitizeProxyHeaders(headers);
	for (const h of INTERNAL_HEADERS) {
		sanitized.delete(h);
	}
	sanitized.delete(CODEX_TURN_STATE_HEADER);
	return sanitized;
}

// Matches the SSE event name or item "type" marker, not a bare substring,
// so assistant-generated text can't trigger a false positive.
const CUSTOM_TOOL_CALL_PATTERN =
	/(?:^|\n)event:\s*response\.custom_tool_call|"type"\s*:\s*"(?:response\.)?custom_tool_call/;

function hasCustomToolCallEvent(sseText: string): boolean {
	return CUSTOM_TOOL_CALL_PATTERN.test(sseText);
}

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";
export const CODEX_VERSION = "0.154.0";
/** Hosts that are OpenAI's own Codex/Responses API, not a custom endpoint. */
const OPENAI_PROMPT_CACHE_HOSTS = new Set(["chatgpt.com", "api.openai.com"]);
export const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;
export const CODEX_PING_MODEL = "gpt-5.6-sol";
const CODEX_SYNTHETIC_COUNT_TOKENS_URL =
	"https://better-ccflare.local/codex/count_tokens";
const CODEX_SYNTHETIC_RESPONSE_URL =
	"https://better-ccflare.local/codex/response";
export const CODEX_PROMPT_CACHE_KEY_ENV = "CCFLARE_CODEX_PROMPT_CACHE_KEY";
/**
 * Trusted provider-to-proxy carrier for the privacy-safe WebSocket conversation
 * digest. The proxy strips it before every upstream transport.
 */
export const CODEX_CONVERSATION_ID_HEADER =
	"x-better-ccflare-codex-conversation-id";
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
/** "conversation" (default) or "session"; see derivePromptCacheKey. */
export const CODEX_CACHE_KEY_MODE_ENV = "CCFLARE_CODEX_CACHE_KEY_MODE";
/**
 * Set to "0" to make Codex's synthetic count_tokens endpoint return a typed
 * Anthropic-shaped error instead of a character-based estimate. Anthropic-
 * compatible clients (e.g. Claude Code) already degrade gracefully to a local
 * estimate on a count_tokens error, so this costs them nothing and lets an
 * operator fail the route closed on purpose instead of exposing an estimate
 * that downstream consumers may treat as authoritative. Default behavior is
 * unchanged.
 */
export const CODEX_SYNTHETIC_COUNT_TOKENS_ENV =
	"CCFLARE_CODEX_SYNTHETIC_COUNT_TOKENS";
export const CODEX_CACHE_KEY_SESSION_PERCENT_ENV =
	"CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT";
export const CODEX_CACHE_KEY_CONTINUITY_PERCENT_ENV =
	"CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT";
export const CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT_ENV =
	"CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT";
export const CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV =
	"CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT";
const CODEX_CACHE_KEY_SESSION_BUCKET_DOMAIN =
	"better-ccflare:codex-cache-key-session-canary:v1\0";
const CODEX_CACHE_KEY_CONTINUITY_BUCKET_DOMAIN =
	"better-ccflare:codex-cache-key-continuity-canary:v1\0";
const CODEX_CACHE_KEY_PREFIX_SHARD_BUCKET_DOMAIN =
	"better-ccflare:codex-prefix-shard-canary:v1\0";
const CODEX_CACHE_KEY_PREFIX_SHARD_DOMAIN =
	"better-ccflare:codex-prefix-shard:v1\0";
const CODEX_CACHE_KEY_COHORT_DOMAIN =
	"better-ccflare:codex-cache-key-cohort:v1\0";
const CODEX_CACHE_LANE_RESCUE_DOMAIN =
	"better-ccflare:codex-cache-lane-rescue:v1\0";
const CODEX_CACHE_LANE_RESCUE_SALT_MAX_CHARS = 128;
const CODEX_WEBSOCKET_CONVERSATION_DOMAIN =
	"better-ccflare:codex-ws-conversation:v1\0";
const CODEX_EXPLICIT_BREAKPOINT_BUCKET_DOMAIN =
	"better-ccflare:codex-gpt56-explicit-breakpoint-canary:v1\0";
const CODEX_EXPLICIT_BREAKPOINT_COHORT_DOMAIN =
	"better-ccflare:codex-gpt56-explicit-breakpoint-cohort:v1\0";
const MAX_CODEX_EXPLICIT_BREAKPOINT_SUPPRESSIONS = 2_048;
const codexExplicitBreakpointSuppressions = new Map<string, true>();

function codexExplicitBreakpointSuppressionKey(
	accountId: string,
	model: string,
	endpoint: string,
): string {
	return `${accountId}:${model.toLowerCase()}:${endpoint}`;
}

/** Remember an upstream 400 capability rejection for this process lifetime. */
export function suppressCodexExplicitCacheBreakpoint(
	accountId: string,
	model: string,
	endpoint = CODEX_DEFAULT_ENDPOINT,
): void {
	const normalizedEndpoint =
		normalizeCodexExplicitBreakpointEligibleEndpoint(endpoint);
	if (!accountId || !model || !normalizedEndpoint) return;
	const key = codexExplicitBreakpointSuppressionKey(
		accountId,
		model,
		normalizedEndpoint,
	);
	// Refresh insertion order so the bounded map behaves as a small LRU.
	codexExplicitBreakpointSuppressions.delete(key);
	codexExplicitBreakpointSuppressions.set(key, true);
	while (
		codexExplicitBreakpointSuppressions.size >
		MAX_CODEX_EXPLICIT_BREAKPOINT_SUPPRESSIONS
	) {
		const oldest = codexExplicitBreakpointSuppressions.keys().next().value;
		if (typeof oldest !== "string") break;
		codexExplicitBreakpointSuppressions.delete(oldest);
	}
}

export function isCodexExplicitCacheBreakpointSuppressed(
	accountId: string,
	model: string,
	endpoint = CODEX_DEFAULT_ENDPOINT,
): boolean {
	const normalizedEndpoint =
		normalizeCodexExplicitBreakpointEligibleEndpoint(endpoint);
	if (!normalizedEndpoint) return false;
	return codexExplicitBreakpointSuppressions.has(
		codexExplicitBreakpointSuppressionKey(accountId, model, normalizedEndpoint),
	);
}

export function getCodexExplicitCacheBreakpointSuppressionCount(): number {
	return codexExplicitBreakpointSuppressions.size;
}

export function resetCodexExplicitBreakpointSuppressionsForTest(): void {
	codexExplicitBreakpointSuppressions.clear();
}

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

export function readCodexCacheKeyPrefixShardPercent(
	raw = process.env[CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT_ENV],
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return 0;
	return Math.min(Number.parseInt(raw, 10), 100);
}

function deriveCodexCacheKeyPrefixShardBucket(
	conversationIdentity: string,
): number {
	const digest = createHash("sha256")
		.update(CODEX_CACHE_KEY_PREFIX_SHARD_BUCKET_DOMAIN)
		.update(conversationIdentity)
		.digest();
	return digest.readUInt32BE(0) % 100;
}

function deriveCodexCacheKeyPrefixShard(conversationIdentity: string): number {
	const digest = createHash("sha256")
		.update(CODEX_CACHE_KEY_PREFIX_SHARD_DOMAIN)
		.update(conversationIdentity)
		.digest();
	return digest.readUInt32BE(0) % 8;
}

export function readCodexCacheKeyContinuityPercent(
	raw = process.env[CODEX_CACHE_KEY_CONTINUITY_PERCENT_ENV],
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return 0;
	return Math.min(Number.parseInt(raw, 10), 100);
}

export function deriveCodexCacheKeyContinuityBucket(sessionId: string): number {
	const digest = createHash("sha256")
		.update(CODEX_CACHE_KEY_CONTINUITY_BUCKET_DOMAIN)
		.update(sessionId.toLowerCase())
		.digest();
	return digest.readUInt32BE(0) % 100;
}

export function readCodexExplicitCacheBreakpointPercent(
	raw = process.env[CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV],
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return 0;
	return Math.min(Number.parseInt(raw, 10), 100);
}

export function deriveCodexExplicitBreakpointBucket(
	conversationIdentity: string,
): number {
	const digest = createHash("sha256")
		.update(CODEX_EXPLICIT_BREAKPOINT_BUCKET_DOMAIN)
		.update(conversationIdentity)
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

/**
 * Exact canary endpoints. The public OpenAI Responses path documents the
 * field; the private ChatGPT Codex path is inferred and protected by the dark
 * default plus a capability-rejection fallback.
 */
function normalizeCodexExplicitBreakpointEligibleEndpoint(
	endpoint: string,
): string | null {
	try {
		const url = new URL(endpoint);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const official =
			(url.hostname === "chatgpt.com" &&
				pathname === "/backend-api/codex/responses") ||
			(url.hostname === "api.openai.com" && pathname === "/v1/responses");
		return official ? `${url.origin}${pathname}` : null;
	} catch {
		return null;
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
	fable: "gpt-5.3-codex",
	opus: "gpt-5.3-codex",
	sonnet: "gpt-5.3-codex",
	haiku: "gpt-5.4-mini",
};
registerProviderModelDefaultFactory("codex", DEFAULT_MODEL_MAP);

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
	const family = ["fable", "haiku", "sonnet", "opus"].find((candidate) =>
		lower.includes(candidate),
	);
	if (family) {
		return (
			resolveProviderModelDefault("codex", family, account?.id) ??
			DEFAULT_MODEL_MAP[family]
		);
	}
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

// A Codex SSE body is often delivered with HTTP 200 even when its terminal
// event carries an error. Conversely, a definitive transport response (401,
// 403, 429, or 529) can still contain an SSE-shaped error body. The latter
// status is authoritative for non-streaming callers; otherwise the normalized
// body mapping remains the source of truth (especially for HTTP 200).
const CODEX_DEFINITIVE_TRANSPORT_STATUSES = new Set([401, 403, 429, 529]);
const CODEX_MAPPED_ERROR_STATUSES = new Set([400, 401, 403, 429, 502, 529]);

function shouldPreserveCodexTransportStatus(
	transportStatus: number,
	bodyStatus: number,
): boolean {
	return (
		CODEX_DEFINITIVE_TRANSPORT_STATUSES.has(transportStatus) &&
		CODEX_MAPPED_ERROR_STATUSES.has(bodyStatus)
	);
}

/**
 * The `event:` and `data:` lines of one complete SSE frame, or `undefined` for
 * whichever line the frame does not carry.
 */
export interface CodexSseFrameLines {
	eventLine: string | undefined;
	dataLine: string | undefined;
}

/**
 * Locate the `event:` and `data:` lines of an SSE frame.
 *
 * A Codex `data:` line can approach the 4MiB transport frame cap
 * (BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES), and this runs once per frame on
 * the streaming hot path, so how the frame is scanned matters. The hot shape is
 * the canonical two-line, LF-terminated frame; it is read with `indexOf` plus
 * two slices rather than by splitting the whole frame into an array.
 *
 * Semantics are exactly those of the two `.find()` scans this replaces, and are
 * deliberately NOT the same as the OpenAI Responses adapter's frame parser
 * (`parseSseFrameFields` in
 * packages/openai-responses-adapter/src/stream-translator.ts). The two must not
 * be unified:
 *
 *   - the prefixes have no trailing space (`event:`, not `event: `), so a
 *     space-less `data:{...}` line still matches, and
 *   - the FIRST matching line wins for each field, not the last.
 *
 * Each mirrors what its own upstream emits, and each is pinned by its own
 * differential test suite. See
 * docs/solutions/performance-issues/sse-translation-hot-path-and-benchmark-noise.md.
 *
 * The fast path is taken only for a frame holding exactly one LF that is not
 * part of a CRLF. CRLF framing, multi-line data, id/comment lines and
 * newline-free frames all fall through to the array scan, which stays the
 * authority on those shapes — except that it now splits once instead of twice.
 */
export function findCodexSseFrameLines(eventText: string): CodexSseFrameLines {
	const firstNewline = eventText.indexOf("\n");
	const secondNewline =
		firstNewline === -1 ? -1 : eventText.indexOf("\n", firstNewline + 1);

	if (
		firstNewline !== -1 &&
		secondNewline === -1 &&
		(firstNewline === 0 || eventText.charCodeAt(firstNewline - 1) !== 13)
	) {
		const firstLine = eventText.slice(0, firstNewline);
		const secondLine = eventText.slice(firstNewline + 1);
		return {
			eventLine: firstLine.startsWith("event:")
				? firstLine
				: secondLine.startsWith("event:")
					? secondLine
					: undefined,
			dataLine: firstLine.startsWith("data:")
				? firstLine
				: secondLine.startsWith("data:")
					? secondLine
					: undefined,
		};
	}

	const lines = eventText.split(/\r?\n/);
	return {
		eventLine: lines.find((l) => l.startsWith("event:")),
		dataLine: lines.find((l) => l.startsWith("data:")),
	};
}

// Buffered tool-call argument bytes are bounded by two independent policies
// (packages/core/src/constants.ts): a per-call cap on any single function
// call's accumulated argument buffer, and a separate aggregate cap across
// every concurrently open function-call buffer, since several calls can each
// individually stay under the per-call cap but together still grow buffered
// memory without bound. Each trip is attributed to its own
// StreamResourceLimitKind so callers can tell the two failure modes apart.
const TOOL_ARGS_PER_CALL_BYTE_CAP =
	BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES;
const TOOL_ARGS_TOTAL_BYTE_CAP = BUFFER_SIZES.TOOL_ARGUMENTS_TOTAL_MAX_BYTES;
const byteEncoder = new TextEncoder();
const CODEX_REASONING_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// When enabled, telemetry reports the effective Codex context capacity rather
// than the raw model maximum.
export const CODEX_EFFECTIVE_CONTEXT_ENV = "CCFLARE_CODEX_EFFECTIVE_CONTEXT";
export { MODEL_CONTEXT_WINDOWS } from "../../request-capabilities";

// ── Codex Responses API types ─────────────────────────────────────────────────

const SOURCE_CACHE_MARKED = Symbol("codex-source-cache-marked");
const SOURCE_MESSAGE_INDEX = Symbol("codex-source-message-index");

interface CodexInputTextItem {
	type: "input_text";
	text: string;
	prompt_cache_breakpoint?: { mode: "explicit" };
	[SOURCE_CACHE_MARKED]?: boolean;
	[SOURCE_MESSAGE_INDEX]?: number;
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

interface CodexReasoningItem {
	type: "reasoning";
	id: string;
	summary: [];
	encrypted_content: string;
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

interface CodexAdditionalToolsItem {
	type: "additional_tools";
	[key: string]: unknown;
}

function isCodexMessage(
	item: CodexRequest["input"][number],
): item is CodexMessage {
	if (!("role" in item) || !("content" in item)) return false;
	return (
		(item.role === "user" ||
			item.role === "assistant" ||
			item.role === "system") &&
		Array.isArray(item.content)
	);
}

interface CodexRequest {
	model: string;
	input: (
		| CodexMessage
		| CodexFunctionCallItem
		| CodexFunctionCallOutputItem
		| CodexReasoningItem
		| CodexAdditionalToolsItem
	)[];
	stream: boolean;
	store: boolean;
	include?: string[];
	reasoning?: { effort: ReasoningEffort };
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
	/**
	 * Only ever set internally from a digest-verified prior response id (see
	 * `selectCodexContinuationOwner` / KTD6). Never populated from a
	 * caller-supplied value.
	 */
	previous_response_id?: string;
}

export interface CodexPromptCacheKeyDecision {
	key: string | null;
	assignment: "conversation" | "session" | null;
	assignmentSource:
		| "canary"
		| "explicit_session_override"
		| "prefix_shard"
		| null;
	effectiveMode: "conversation" | "session" | null;
	cohortId: string | null;
	conversationIdentity: string | null;
	/** Canonical identity authorized by orchestration admission, if any. */
	canonicalConversationIdentity: string | null;
	/** Identity selected for the base cache key before any rescue salt. */
	selectedConversationIdentity: string | null;
	/** Whether canonical continuity was selected; null when ineligible/inapplicable. */
	continuityApplied: boolean | null;
	continuityBasis:
		| "derived"
		| "identity_match"
		| "lineage_match"
		| "rejected"
		| "session"
		| "ineligible";
	webSocketConversationIdentity: string | null;
}

export type CodexExplicitBreakpointAction =
	| "placed_source_marker"
	| "placed_first_user_text"
	| "skip_percent_control"
	| "skip_non_gpt56"
	| "skip_non_eligible_endpoint"
	| "skip_no_prompt_cache_key"
	| "skip_no_conversation"
	| "skip_known_unsupported"
	| "skip_rotated_cache_key_attempt"
	| "skip_no_eligible_block";

export interface CodexExplicitBreakpointDecision {
	canary: "treatment" | "control" | "ineligible";
	cohortId: string | null;
	action: CodexExplicitBreakpointAction;
}

interface CodexConversionResult {
	codexBody: CodexRequest;
	reasoningEffortRequested: ReasoningEffort | undefined;
	reasoningEffortSource: AnthropicReasoningEffortSource;
	cacheKeyDecision: CodexPromptCacheKeyDecision;
	explicitBreakpointDecision: CodexExplicitBreakpointDecision;
	orchestrationAdmission: OrchestrationAdmission;
	/**
	 * Diagnostic-only reasoning basis behind orchestrationAdmission, when an
	 * election actually ran ("initial_claim" | "identity_match" |
	 * "lineage_match" | "rejected"). Null when no election ran at all (e.g.
	 * no_orchestration_tools, attributed_descendant, disabled, no_session,
	 * no_conversation). Written verbatim to trace.ts's TraceInputs as
	 * orchestrationBasis.
	 */
	orchestrationBasis: OrchestrationAdmissionBasis | null;
	filteredToolNames: string[];
	/** Diagnostic: see orchestrationDemotionObserved in trace.ts's TraceInputs. */
	orchestrationDemotionObserved: boolean;
	/** Diagnostic: see elapsedMsSinceRoot in trace.ts's TraceInputs. */
	elapsedMsSinceRoot: number | null;
}

// ── Anthropic request types ───────────────────────────────────────────────────

interface AnthropicTextContent {
	type: "text";
	text: string;
	cache_control?: { type?: string; ttl?: string };
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

interface AnthropicRedactedThinkingBlock {
	type: "redacted_thinking";
	data: string;
}

interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

type AnthropicContentBlock =
	| AnthropicTextContent
	| AnthropicToolUse
	| AnthropicToolResult
	| AnthropicRedactedThinkingBlock
	| AnthropicThinkingBlock;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

/**
 * Flattened, top-level-only view of an AnthropicTool's input_schema, used to
 * decide whether an empty-string tool-call argument is safe to strip. Only
 * `properties` and `required` are read; nested schemas are not descended
 * into. Built once per request in transformRequestBody and cached by
 * request id (see CodexProvider#requestToolSchemasById) so the response-side
 * sanitizer never needs to throw or guess on a cache miss.
 */
interface CodexToolSchemaPropInfo {
	isString: boolean;
	enumHasEmptyString: boolean;
}

interface CodexToolSchemaInfo {
	required: Set<string>;
	props: Map<string, CodexToolSchemaPropInfo>;
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
	system?:
		| string
		| {
				type: string;
				text: string;
				cache_control?: { type?: string; ttl?: string };
		  }[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	output_config?: { effort?: string };
	reasoning?: { effort?: string };
	metadata?: { user_id?: string };
	[key: string]: unknown;
}

// ── SSE streaming state ───────────────────────────────────────────────────────

interface FunctionCallBuffer {
	contentBlockIndex: number;
	name: string;
	callIdFingerprint: string | null;
	arguments: string[];
	/** Running byte total of buffered argument deltas, capped by TOOL_ARGS_PER_CALL_BYTE_CAP. */
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

// Bound translated protocol-liveness traffic even if an upstream emits the
// same nonterminal progress event at delta-like frequency. This stays far
// inside the independent 120s Anthropic protocol-idle window while ensuring a
// throttled event can move that window by at most one second less than the
// latest observed upstream activity.
const CODEX_PROGRESS_PING_MIN_INTERVAL_MS = 1_000;

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
	cacheCreationMeasurementAvailable: boolean;
	usageMeasurementAvailable: boolean;
	cacheMeasurementAvailable: boolean;
	// Anthropic clients expect stop_reason=tool_use when the assistant emitted a tool call.
	sawToolUse: boolean;
	contextWindow: ContextWindow | null;
	// Track function_call items: output_index → buffered arguments and block index
	functionCallBlocks: Map<number, FunctionCallBuffer>;
	/** Aggregate byte total across every entry in functionCallBlocks, capped by TOOL_ARGS_TOTAL_BYTE_CAP. */
	functionCallBytesTotal: number;
	upstreamError?: {
		type: string;
		message: string;
		code?: string;
		status?: string;
	};
	// Newly emitted tool calls from this response only (not historical replay).
	traceNewToolCalls: ToolCallSummary[];
	turnStateOutputCallFingerprints: string[];
	turnStateOutputCallsInvalid: boolean;
	traceReasoningOutputItemCount: number;
	traceReasoningEncryptedPresent: boolean;
	traceReasoningUnrepresentableIdSkipCount: number;
	// Wrapped redacted_thinking payloads whose emission is deferred while a
	// function-call block is still streaming: emitting mid-lifecycle would
	// interleave block lifecycles on the wire (pro-gate P1, PR #139).
	pendingReasoningBlocks: string[];
	traceRequestId: string;
	traceAttemptId?: string;
	traceTurnStateHeaderPresent: boolean;
	traceTurnState: string | null;
	turnStateTerminalAction: CodexTurnStateTerminalAction | null;
	finalizeTurnState: (
		stopReason: "error" | "end_turn" | "tool_use" | "max_tokens" | "refusal",
		outputLineage: CodexTurnStateLineage,
	) => CodexTurnStateTerminalAction;
	traceResponseId: string | null;
	/** Last canonical Anthropic ping translated from allowlisted Codex progress. */
	lastProgressPingAt: number | null;
	// One terminal response trace per physical attempt, across every terminal
	// path (completed, failed, abrupt EOF, read error, downstream cancel).
	terminalTraceWritten: boolean;
	/**
	 * Staged by the "response.completed" case only (never "response.incomplete")
	 * when this attempt is response-id-owned. Consumed by the tail validator
	 * after the client-facing stream has already reached its terminal boundary;
	 * never delays client delivery.
	 */
	responseIdTerminal?: { responseId: string; output: unknown[] } | null;
	/**
	 * KTD7 tail check: set when a data-bearing SSE frame (or a second
	 * `[DONE]` marker) is observed either in the SAME chunk after the
	 * terminal event was already handled (`processEvents`'s frame loop), or
	 * on a LATER read by the dedicated `runCodexResponseIdTailValidator`
	 * after a successful move-only handoff. `commitCodexResponseIdCheckpoint`
	 * discards a staged candidate rather than promoting it when this is set,
	 * since "exactly one valid completed response ... no other data-bearing
	 * frame" no longer holds.
	 */
	responseIdTailTainted?: boolean;
	/** Internal bookkeeping for the taint check above: at most one trailing `[DONE]` is expected. */
	responseIdDoneSeenAfterTerminal?: boolean;
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
	// A buffer still open at the terminal is a call the client was handed but that
	// never completed upstream. Its fingerprint is missing, so the lineage would
	// be an exact-looking subset of the turn upstream actually produced, and a
	// continuation carrying only the completed calls would replay a token minted
	// for a different turn. Only an exactly paired added/done set may be captured.
	if (state.functionCallBlocks.size > 0) {
		state.turnStateOutputCallsInvalid = true;
	}
	const outputLineage =
		stopReason === "tool_use" && !state.turnStateOutputCallsInvalid
			? normalizeCodexTurnStateFingerprints(
					state.turnStateOutputCallFingerprints,
				)
			: stopReason === "tool_use"
				? ({ kind: "invalid" } as const)
				: ({ kind: "none" } as const);
	state.turnStateTerminalAction = state.finalizeTurnState(
		stopReason,
		outputLineage,
	);
	writeCodexResponseTrace({
		requestId: state.traceRequestId,
		attemptId: state.traceAttemptId,
		modelOut: state.model,
		modelContextWindow: resolveModelContextCapability("codex", state.model)
			?.rawContextWindow,
		turnStateHeaderPresent: state.traceTurnStateHeaderPresent,
		turnState: state.traceTurnState,
		turnStateTerminalAction: state.turnStateTerminalAction ?? "unknown_attempt",
		responseId: state.traceResponseId,
		summary: summarizeCodexResponse(
			state.traceNewToolCalls,
			state.usageMeasurementAvailable
				? {
						input_tokens: state.totalInputTokens,
						output_tokens: state.outputTokens,
						...(state.cacheMeasurementAvailable
							? {
									cache_read_input_tokens: state.cacheReadInputTokens,
								}
							: {}),
						cache_creation_measurement_available:
							state.cacheCreationMeasurementAvailable,
						...(state.cacheCreationMeasurementAvailable
							? {
									cache_creation_input_tokens: state.cacheCreationInputTokens,
								}
							: {}),
					}
				: {},
			stopReason,
			error,
			{
				outputItemCount: state.traceReasoningOutputItemCount,
				encryptedPresent: state.traceReasoningEncryptedPresent,
				unrepresentableIdSkipCount:
					state.traceReasoningUnrepresentableIdSkipCount,
			},
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

export const CODEX_STREAM_DRAIN_DEADLINE_MS = 30_000;

export interface CodexProviderOptionsForTests {
	streamHeartbeatIntervalMs?: number;
	streamRawSilenceTimeoutMs?: number;
	streamDrainDeadlineMs?: number;
}

interface CodexTransformOptions {
	hosted?: boolean;
}

interface CodexProcessResponseOptions {
	/**
	 * Whether this response belongs to a hosted-search attempt. Hosted attempts
	 * are never registered with the turn-state coordinator, so they must not try
	 * to finalize one: the lookup would miss and report `unknown_attempt`, which
	 * is reserved for an attempt that was registered and then lost.
	 */
	hosted?: boolean;
}

// ── Native response-id continuation (KTD6/KTD7/KTD13) ───────────────────────
//
// A SEPARATE mechanism from the fork's own turn-state continuation
// (turn-state.ts), scoped to the native Responses protocol lane only (a
// request that reached this provider through the trusted Responses adapter,
// see `x-better-ccflare-native-responses` below). Exactly one of
// {"response-id", "turn-state", "none"} owns a given physical attempt; see
// `selectCodexContinuationOwner`.
//
// Trust boundary: the client's own opt-in header
// (`x-better-ccflare-codex-continuation: previous_response_id`) is read only
// by the Responses adapter itself (openai-responses-adapter/src/handler.ts)
// and carried inside the already-trust-gated
// `__better_ccflare_codex_passthrough` carrier. A caller-supplied
// `previous_response_id` value is NEVER consumed -- only an internally
// computed, digest-verified prior response id may ever populate
// `codexBody.previous_response_id`.

/** External opt-in header consumed only by the Responses adapter. */
export const CODEX_CONTINUATION_HEADER = "x-better-ccflare-codex-continuation";
/**
 * Internal-only signal, set exclusively by proxy-operations.ts from a
 * server-verified check (`isResponsesAdapterRequest`), never trusted from a
 * raw client header. Deleted before any outbound transport.
 */
export const CODEX_NATIVE_RESPONSES_HEADER =
	"x-better-ccflare-native-responses";
/**
 * Internal-only caller-identity digest, stamped by proxy-operations.ts from
 * the already-authenticated API key id for *this* physical request. Never
 * trusted from a raw client header; deleted before any outbound transport.
 */
export const CODEX_AUTHENTICATED_CALLER_HEADER =
	"x-better-ccflare-authenticated-caller";

/**
 * Behavior 1 (Messages-lane continuation): default-OFF gate. Nothing on the
 * plain Claude Messages lane (a request that did NOT arrive through the
 * trusted Responses adapter, i.e. `!nativeResponses`) may become
 * response-id-owned unless this env var is exactly "1". Mirrors upstream
 * 99f5dce0's own env var name.
 */
export const CODEX_MESSAGES_CONTINUATION_ENV =
	"CCFLARE_CODEX_MESSAGES_CONTINUATION";
/**
 * Optional comma-separated allowlist of physical Codex models admitted to
 * Behavior 1. Undefined means "all models admitted" (once the flag above is
 * on); an empty string admits none, matching upstream's own
 * `undefined || list.includes(model)` semantics exactly (an empty string
 * splits to `[""]`, which never matches a real model id).
 */
export const CODEX_MESSAGES_CONTINUATION_MODELS_ENV =
	"CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS";

type CodexContinuationOwner = "response-id" | "turn-state" | "none";
/** Protocol lane discriminator, hashed into every response-id lane key so a
 * native-Responses checkpoint and a Messages-lane checkpoint can never be
 * reachable from one another, even for an identical account/model/caller/
 * session tuple. */
type CodexResponseIdProtocol = "native-responses" | "messages";

/** KTD13: shared cross-lane retention ceilings. */
const CODEX_RESPONSE_ID_MAX_DIGEST_ITEMS = 2_048;
const CODEX_RESPONSE_ID_MAX_ID_BYTES = 256;
const CODEX_RESPONSE_ID_MAX_CHECKPOINT_BYTES = 512 * 1_024;
/**
 * Exported (not just module-private) so
 * provider.response-id-rejection-repair.test.ts's budget-exhaustion proof can
 * assert the veto boundary it discovers by genuinely charging the real
 * aggregate ceiling instead of duplicating this number as an untracked
 * magic-number copy.
 */
export const CODEX_RESPONSE_ID_MAX_AGGREGATE_BYTES = 32 * 1_024 * 1_024;
/**
 * Additional ceilings, on top of the byte/item budget above. Exported (not
 * just module-private) so provider.cache-replay.test.ts's KTD6
 * eviction/tombstone proof-first tests can compute exact fixture sizes and
 * fast-forward exact TTL/tombstone boundaries instead of duplicating these
 * numbers as untracked magic-number copies.
 */
export const CODEX_RESPONSE_ID_LANE_TTL_MS = 30 * 60 * 1_000;
export const CODEX_RESPONSE_ID_MAX_LANES = 2_048;
const CODEX_RESPONSE_ID_MAX_PENDING_ATTEMPTS = 4_096;
export const CODEX_RESPONSE_ID_PENDING_TTL_MS =
	CODEX_STREAM_DRAIN_DEADLINE_MS * 4;
/**
 * Behavior 2 (rejected-id repair): per-lane suppression window after a
 * recognized rejected-id repair. Exported so tests can fast-forward past it
 * deterministically instead of duplicating the magic number.
 */
export const CODEX_RESPONSE_ID_REJECTED_TTL_MS = 5 * 60 * 1_000;
/** Approximate per-entry container overhead charged alongside digest bytes. */
const CODEX_RESPONSE_ID_ENTRY_OVERHEAD_BYTES = 16;

interface CodexResponseIdLaneState {
	responseId: string;
	digests: string[];
	configDigest: string;
	expiresAt: number;
	chargedBytes: number;
	lastUsedAt: number;
}

interface CodexResponseIdLaneEntry {
	generation: number;
	state?: CodexResponseIdLaneState;
	/**
	 * Set the instant `state` is cleared without deleting the entry (TTL
	 * expiry or LRU-cap eviction), so the entry is a tombstone that still
	 * carries the real `generation` high-water mark forward. Cleared back to
	 * undefined the moment `state` is set again. See
	 * `sweepCodexResponseIdState`'s tombstone-eviction block for why a
	 * tombstone is only safe to fully delete once `CODEX_RESPONSE_ID_PENDING_TTL_MS`
	 * has passed since it was created.
	 */
	tombstonedAt?: number;
}

interface CodexPendingResponseIdCandidate {
	lane: string;
	generation: number;
	requestDigests: string[];
	configDigest: string;
	chargedBytes: number;
	ts: number;
	/**
	 * True iff this attempt actually carried a `previous_response_id` (a
	 * prefix-match hit against committed lane state), false for a cold send.
	 * Behavior 2 (rejected-id repair) must never fire for a cold send: it
	 * never sent a `previous_response_id`, so a rejection naming that field
	 * cannot legitimately apply to it.
	 */
	continued: boolean;
}

/** Deep-sorts object keys so digest input is stable regardless of key order. */
function canonicalizeForDigest(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeForDigest);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			sorted[key] = canonicalizeForDigest(record[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Normalizes a Codex Responses-format replay item (input or, symmetrically,
 * a completed response's own output item fed back as input on the next
 * turn) into a stable, lossy-replay-tolerant shape for digesting.
 *
 * Clients (and this provider's own Anthropic<->Responses round trip) replay
 * history lossily: a `function_call` item may drop `status`, assistant
 * `output_text`/`refusal` blocks may be coalesced, and annotations may be
 * stripped. Digesting the raw bytes would treat a lossless-but-differently
 * shaped replay as a mismatch and needlessly fall back to a cold, full
 * history send. `reasoning` items are intentionally excluded: their content
 * is retained server-side by the response id itself, and clients frequently
 * do not replay them at all.
 *
 * Returns null for any item this function does not recognize, which the
 * caller treats as fail-closed: an unsupported item anywhere in history
 * disqualifies the whole array from response-id continuation for this
 * attempt, never a truncation.
 */
function normalizeReplayItemForDigest(
	item: unknown,
): Record<string, unknown> | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const record = item as Record<string, unknown>;
	const type = record.type;
	if (type === "function_call") {
		if (
			typeof record.call_id !== "string" ||
			typeof record.name !== "string" ||
			typeof record.arguments !== "string"
		) {
			return null;
		}
		return {
			type: "function_call",
			call_id: record.call_id,
			name: record.name,
			arguments: record.arguments,
		};
	}
	if (type === "function_call_output") {
		if (typeof record.call_id !== "string") return null;
		return {
			type: "function_call_output",
			call_id: record.call_id,
			output: record.output ?? null,
		};
	}
	if (type === "reasoning") {
		// Retained server-side by the response id; excluded from the digest.
		return { type: "reasoning" };
	}
	// Message items in this fork's `codexBody.input` (see `CodexMessage` /
	// `isCodexMessage`) are recognized structurally -- role + a content
	// array -- and never carry an explicit `type: "message"` discriminant
	// (the field is optional on the wire and this fork's own converter never
	// sets it). Requiring a literal `type === "message"` here would fail
	// closed for every ordinary text-only conversation, since none of its
	// input items would ever match. Accept both an explicit "message" type
	// (upstream/defensive) and this fork's untyped shape.
	const looksLikeUntypedMessage =
		type === undefined &&
		(record.role === "user" ||
			record.role === "assistant" ||
			record.role === "system") &&
		Array.isArray(record.content);
	if (type === "message" || looksLikeUntypedMessage) {
		const content = record.content;
		if (!Array.isArray(content)) return null;
		const normalizedContent: Array<{ type: "text" | "image"; value: unknown }> =
			[];
		for (const block of content) {
			if (!block || typeof block !== "object" || Array.isArray(block)) {
				return null;
			}
			const blockRecord = block as Record<string, unknown>;
			if (
				blockRecord.type === "input_text" ||
				blockRecord.type === "output_text"
			) {
				normalizedContent.push({ type: "text", value: blockRecord.text });
			} else if (blockRecord.type === "input_image") {
				normalizedContent.push({
					type: "image",
					value: blockRecord.image_url,
				});
			} else if (blockRecord.type === "refusal") {
				normalizedContent.push({ type: "text", value: blockRecord.refusal });
			} else {
				return null;
			}
		}
		return {
			type: "message",
			role: record.role ?? null,
			content: normalizedContent,
		};
	}
	return null;
}

function replayItemDigest(item: unknown): string | null {
	const normalized = normalizeReplayItemForDigest(item);
	if (normalized === null) return null;
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeForDigest(normalized)))
		.digest("hex");
}

/** Digests every item in order; fails closed (returns null) on any miss. */
function digestReplayItems(
	items: readonly unknown[] | null | undefined,
): string[] | null {
	if (!Array.isArray(items)) return null;
	const digests: string[] = [];
	for (const item of items) {
		const digest = replayItemDigest(item);
		if (digest === null) return null;
		digests.push(digest);
	}
	return digests;
}

function isDigestPrefixMatch(prefix: string[], candidate: string[]): boolean {
	if (prefix.length === 0 || prefix.length > candidate.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (prefix[i] !== candidate[i]) return false;
	}
	return true;
}

/**
 * KTD13: estimates the retained-state charge for a checkpoint. Returns null
 * when the checkpoint itself exceeds a per-item ceiling (response id length
 * or digest item count) or the resulting byte total exceeds the per-checkpoint
 * ceiling -- callers treat null as "skip capture", never as a truncation or a
 * failed client request.
 */
function estimateCodexResponseIdCharge(
	responseId: string,
	digests: readonly string[],
): number | null {
	if (Buffer.byteLength(responseId, "utf8") > CODEX_RESPONSE_ID_MAX_ID_BYTES) {
		return null;
	}
	if (digests.length > CODEX_RESPONSE_ID_MAX_DIGEST_ITEMS) return null;
	let bytes = Buffer.byteLength(responseId, "utf8");
	for (const digest of digests) {
		bytes +=
			Buffer.byteLength(digest, "utf8") +
			CODEX_RESPONSE_ID_ENTRY_OVERHEAD_BYTES;
	}
	if (bytes > CODEX_RESPONSE_ID_MAX_CHECKPOINT_BYTES) return null;
	return bytes;
}

/**
 * Behavior 2 (rejected-id repair) classifier: detects a recognized upstream
 * rejection of the gateway-supplied `previous_response_id` -- a 400/404
 * naming that exact field, matching the same error shapes upstream 99f5dce0
 * recognizes (`previous_response_not_found` / `invalid_previous_response_id`
 * error codes, or `param === "previous_response_id"` with
 * `type === "invalid_request_error"`). Pure and stateless: never mutates any
 * continuation state. A caller must still gate the actual repair on
 * `CodexProvider.prepareCodexResponseIdRejectionRepair` returning `true`
 * before dispatching a retry -- this function alone never confirms the
 * attempt was response-id-owned, so a generic 400/404 that happens to
 * mention that field on a turn-state-owned or cold attempt is correctly
 * refused downstream instead of here.
 */
export async function isCodexResponseIdRejectionError(
	response: Response,
	readJson: (response: Response) => Promise<unknown | null>,
): Promise<boolean> {
	if (response.status !== 400 && response.status !== 404) return false;
	const parsed = await readJson(response);
	if (!parsed || typeof parsed !== "object") return false;
	const error = (parsed as { error?: unknown }).error;
	if (!error || typeof error !== "object") return false;
	const { code, param, type } = error as {
		code?: unknown;
		param?: unknown;
		type?: unknown;
	};
	return (
		code === "previous_response_not_found" ||
		code === "invalid_previous_response_id" ||
		(param === "previous_response_id" && type === "invalid_request_error")
	);
}

/**
 * KTD7 tail validator teardown helper: duplicated locally rather than
 * imported because packages/providers/src/utils/stream-drain.ts does not
 * export this exact primitive. Releasing a reader's lock while a read() is
 * still outstanding only rejects that promise (WHATWG Streams §4.5); it
 * never tells the underlying native source the stream is abandoned, which
 * is exactly the "touched then abandoned" shape Bun's native fetch can
 * buffer without bound (oven-sh/bun#39590, #382). Every losing exit from
 * `runCodexResponseIdTailValidator`'s read loop therefore aborts the
 * transport first, then gives the still-outstanding read this bounded
 * grace window to actually settle before `releaseLock()` runs.
 */
async function awaitCodexTailPendingReadSettlement(
	pendingRead: Promise<unknown>,
	graceMs: number,
): Promise<void> {
	const observedPendingRead = pendingRead.then(
		() => undefined,
		() => undefined,
	);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<void>((resolve) => {
		graceTimer = setTimeout(resolve, graceMs);
	});
	try {
		await Promise.race([observedPendingRead, grace]);
	} finally {
		if (graceTimer !== undefined) clearTimeout(graceTimer);
	}
}

export class CodexProvider extends BaseProvider {
	name = "codex";
	private readonly streamLivenessOptions: CodexStreamLivenessOptions;
	private readonly streamDrainDeadlineMs: number;
	private readonly turnStateCoordinator = new CodexTurnStateCoordinator();

	// ── Native response-id continuation state (KTD6/KTD7/KTD13) ──────────────
	/** Keyed by lane digest (account+model+caller+session+config). */
	private readonly responseIdLanes = new Map<
		string,
		CodexResponseIdLaneEntry
	>();
	/**
	 * Keyed by the physical attempt id (never the logical request id): a retry
	 * or failover must not let a still-draining sibling's staged candidate be
	 * overwritten.
	 */
	private readonly pendingResponseIdByAttempt = new Map<
		string,
		CodexPendingResponseIdCandidate
	>();
	/** Recorded once per physical attempt, before either facility has side effects. */
	private readonly continuationOwnerByAttempt = new Map<
		string,
		{ owner: CodexContinuationOwner; ts: number }
	>();
	/** Lane -> expiry. At most one repair per lane while suppressed. */
	private readonly responseIdRejectedLanes = new Map<string, number>();
	private responseIdBudgetBytes = 0;
	// ── Final-wire cache diagnostics (KTD8): observational only, opt-in via
	// CODEX_CACHE_DIAGNOSTICS_ENV, never routing or continuation authority. ──
	private readonly cacheDiagnostics = new CodexCacheDiagnostics(
		(facts) => {
			log.info("Codex outgoing cache diagnostics", sanitizeCacheFacts(facts));
			persistCacheTelemetry(facts, (dropped) =>
				log.warn("Codex cache telemetry persistence failure", {
					dropped_events: dropped,
				}),
			);
		},
		Date.now,
		recordCacheLifecycle,
	);

	constructor(options: CodexProviderOptionsForTests = {}) {
		super();
		if (process.env[CODEX_CACHE_DIAGNOSTICS_ENV] === "1") {
			recordCacheLifecycle({ event: "observer_ready" });
		}
		this.streamLivenessOptions = {
			heartbeatIntervalMs: options.streamHeartbeatIntervalMs,
			rawSilenceTimeoutMs: options.streamRawSilenceTimeoutMs,
		};
		this.streamDrainDeadlineMs =
			options.streamDrainDeadlineMs ?? CODEX_STREAM_DRAIN_DEADLINE_MS;
	}

	/**
	 * Releases turn-state context for an attempt that was registered during
	 * request transformation but will never be dispatched. Idempotent; see
	 * `CodexTurnStateCoordinator.abortAttempt`.
	 *
	 * Also annuls the attempt's request trace, so analysis does not count a
	 * candidate that never reached the wire as a physical request. That is
	 * deliberately not conditional on turn-state eligibility: the request record
	 * was written for this attempt whatever arm it landed in, so the correction
	 * has to be written the same way.
	 */
	abortTurnStateAttempt(attemptId: string | null | undefined): void {
		const requestId = this.turnStateCoordinator.abortAttempt(attemptId);
		writeCodexAbortedAttemptTrace({ attemptId, requestId });
		this.releaseCodexResponseIdAttempt(attemptId);
	}

	/**
	 * Releases an attempt that reached the wire but never produced a response --
	 * a socket, TLS, timeout, or abort failure after dispatch.
	 *
	 * Such an attempt never reaches `processResponse`, so nothing else finalizes
	 * it. Left registered it reads as live, which keeps its logical request's
	 * lease held and suppresses every later turn on the scope until the attempt
	 * TTL expires. Deliberately writes no `attempt_aborted` tombstone: that record
	 * means "never sent", and this request was sent -- annulling it would erase a
	 * real physical attempt from requests-per-key and fallback accounting.
	 *
	 * The pending turn is left intact on purpose. The send's effect upstream is
	 * unknown, and the official contract's answer to that is precisely to replay
	 * the same token on a compatible retry, so discarding it here would forfeit
	 * the reuse this canary exists to measure.
	 */
	releaseDispatchedTurnStateAttempt(
		attemptId: string | null | undefined,
	): void {
		this.turnStateCoordinator.abortAttempt(attemptId);
		this.releaseCodexResponseIdAttempt(attemptId);
	}

	// ── Native response-id continuation helpers (KTD6/KTD7/KTD13) ────────────

	/**
	 * Releases a still-pending response-id candidate's charge and removes it,
	 * without ever promoting it. Idempotent. Called whenever a physical
	 * attempt is known to never reach (or never complete) `processResponse`:
	 * this is the single choke point for "cancellation" release under KTD13.
	 */
	private releaseCodexResponseIdAttempt(
		attemptId: string | null | undefined,
	): void {
		if (!attemptId) return;
		this.continuationOwnerByAttempt.delete(attemptId);
		const pending = this.pendingResponseIdByAttempt.get(attemptId);
		if (!pending) return;
		this.pendingResponseIdByAttempt.delete(attemptId);
		this.releaseCodexResponseIdBytes(pending.chargedBytes);
	}

	private chargeCodexResponseIdBytes(bytes: number): boolean {
		if (bytes <= 0) return true;
		if (
			this.responseIdBudgetBytes + bytes >
			CODEX_RESPONSE_ID_MAX_AGGREGATE_BYTES
		) {
			return false;
		}
		this.responseIdBudgetBytes += bytes;
		return true;
	}

	private releaseCodexResponseIdBytes(bytes: number): void {
		this.responseIdBudgetBytes = Math.max(
			0,
			this.responseIdBudgetBytes - bytes,
		);
	}

	/** TTL sweep + LRU-style cap for bounded retention (additional ceilings on top of KTD13's byte budget). */
	private sweepCodexResponseIdState(): void {
		const now = Date.now();
		for (const [attemptId, pending] of this.pendingResponseIdByAttempt) {
			if (now - pending.ts > CODEX_RESPONSE_ID_PENDING_TTL_MS) {
				this.pendingResponseIdByAttempt.delete(attemptId);
				this.releaseCodexResponseIdBytes(pending.chargedBytes);
			}
		}
		if (
			this.pendingResponseIdByAttempt.size >
			CODEX_RESPONSE_ID_MAX_PENDING_ATTEMPTS
		) {
			const oldestFirst = [...this.pendingResponseIdByAttempt.entries()].sort(
				(a, b) => a[1].ts - b[1].ts,
			);
			const excess =
				this.pendingResponseIdByAttempt.size -
				CODEX_RESPONSE_ID_MAX_PENDING_ATTEMPTS;
			for (let i = 0; i < excess; i++) {
				const [attemptId, pending] = oldestFirst[i];
				this.pendingResponseIdByAttempt.delete(attemptId);
				this.releaseCodexResponseIdBytes(pending.chargedBytes);
			}
		}
		for (const [attemptId, entry] of this.continuationOwnerByAttempt) {
			if (now - entry.ts > CODEX_RESPONSE_ID_PENDING_TTL_MS) {
				this.continuationOwnerByAttempt.delete(attemptId);
			}
		}
		for (const [, entry] of this.responseIdLanes) {
			if (entry.state && entry.state.expiresAt <= now) {
				this.releaseCodexResponseIdBytes(entry.state.chargedBytes);
				entry.state = undefined;
				entry.tombstonedAt = now;
			}
		}
		// KTD6 defect fix: LRU-cap eviction must never discard `generation`.
		// Deleting the whole entry would let a still-pending attempt from
		// before eviction (carrying a large pre-eviction generation number)
		// pass `laneEntry.generation > pending.generation` once a fresh
		// attempt chain on the same lane key restarts counting from 0/1 --
		// silently overwriting newer state with stale output. Clearing only
		// `state` (a tombstone) preserves the high-water mark so every
		// subsequent generation on this lane, evicted or not, keeps
		// increasing monotonically.
		if (this.responseIdLanes.size > CODEX_RESPONSE_ID_MAX_LANES) {
			const withState = [...this.responseIdLanes.entries()].filter(
				([, entry]) => entry.state,
			);
			withState.sort(
				(a, b) => (a[1].state?.lastUsedAt ?? 0) - (b[1].state?.lastUsedAt ?? 0),
			);
			const excess = this.responseIdLanes.size - CODEX_RESPONSE_ID_MAX_LANES;
			for (let i = 0; i < excess && i < withState.length; i++) {
				const [, entry] = withState[i];
				if (entry.state)
					this.releaseCodexResponseIdBytes(entry.state.chargedBytes);
				entry.state = undefined;
				entry.tombstonedAt = now;
			}
		}
		// Tombstones (state cleared, generation preserved) are themselves
		// bounded, just not by the state-holding LRU cap above: a tombstone
		// is safe to fully delete once `CODEX_RESPONSE_ID_PENDING_TTL_MS` has
		// passed since it was created. Proof: any still-pending attempt that
		// could reference a generation <= this tombstone's was necessarily
		// staged (its own `ts`) at or before `tombstonedAt` -- generation
		// numbers only increase and are burned into `pendingResponseIdByAttempt`
		// at staging time. By the time `tombstonedAt + PENDING_TTL_MS` has
		// elapsed, that attempt's own `ts + PENDING_TTL_MS` has also elapsed,
		// so the pending-attempt sweep at the top of this function has
		// already purged it in this very pass (or an earlier one) --
		// `commitCodexResponseIdCheckpoint` becomes a no-op for it via its
		// own `pendingResponseIdByAttempt.get(attemptId)` miss, independent
		// of anything still (or no longer) in `responseIdLanes`. So deleting
		// the tombstone here can never resurrect the reset-generation bug.
		for (const [lane, entry] of this.responseIdLanes) {
			if (
				!entry.state &&
				entry.tombstonedAt !== undefined &&
				now - entry.tombstonedAt > CODEX_RESPONSE_ID_PENDING_TTL_MS
			) {
				this.responseIdLanes.delete(lane);
			}
		}
		for (const [lane, expiresAt] of this.responseIdRejectedLanes) {
			if (expiresAt <= now) this.responseIdRejectedLanes.delete(lane);
		}
	}

	private codexResponseIdLaneKey(
		accountId: string | undefined,
		model: string,
		callerDigest: string | null,
		sessionIdentity: string | null,
		protocol: CodexResponseIdProtocol,
	): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					accountId: accountId ?? null,
					model,
					callerDigest,
					sessionIdentity,
					protocol,
				}),
			)
			.digest("hex");
	}

	private codexResponseIdConfigDigest(
		accountId: string | undefined,
		codexBody: Pick<CodexRequest, "store" | "reasoning">,
	): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					accountId: accountId ?? null,
					store: codexBody.store,
					reasoningEffort: codexBody.reasoning?.effort ?? null,
				}),
			)
			.digest("hex");
	}

	/**
	 * KTD6: selects exactly one continuation owner for this physical attempt
	 * and, when response-id owns it, mutates the codex request in place
	 * (setting `previous_response_id` and truncating `input` to the new tail)
	 * and stages a pending candidate keyed by `attemptId`. Must run, and must
	 * fully resolve ownership, before `CodexTurnStateCoordinator.beginAttempt`
	 * is invoked for this attempt.
	 */
	private selectCodexResponseIdOwner(params: {
		nativeResponses: boolean;
		continuationOptIn: boolean;
		/**
		 * Behavior 1 (Messages-lane continuation): true iff
		 * `CCFLARE_CODEX_MESSAGES_CONTINUATION=1` (and, when set, the optional
		 * model allowlist admits this physical model) for a request that did
		 * NOT arrive through the trusted Responses adapter. Only ever
		 * consulted when `!nativeResponses`; a native-Responses attempt is
		 * gated exclusively by `continuationOptIn` as before.
		 */
		messagesLaneAdmitted: boolean;
		hosted: boolean;
		customToolsDeclared: boolean;
		accountId: string | undefined;
		attemptId: string | null;
		codexBody: CodexRequest;
		callerDigest: string | null;
		sessionIdentity: string | null;
	}): boolean {
		const {
			nativeResponses,
			continuationOptIn,
			messagesLaneAdmitted,
			hosted,
			customToolsDeclared,
			accountId,
			attemptId,
			codexBody,
			callerDigest,
			sessionIdentity,
		} = params;
		// Exactly one lane can be eligible for a given attempt: the trusted
		// native Responses lane (server-verified header + explicit client
		// opt-in) or the plain Messages lane (server-verified ABSENCE of that
		// header + the default-OFF env flag, and optional model filter).
		const eligible = nativeResponses ? continuationOptIn : messagesLaneAdmitted;
		if (
			!eligible ||
			!attemptId ||
			hosted ||
			// A request declaring a custom (non-function) tool takes the raw
			// Responses passthrough branch in processResponse
			// (buildCustomToolCallPassthroughResponse), which never runs
			// processEvents/handleCodexEvent at all. Claiming response-id
			// ownership here would suppress turn-state for nothing -- no
			// checkpoint can ever be committed on that path -- and would leak
			// the KTD13 charge staged below. Fail closed to "turn-state" (or
			// "none") instead.
			customToolsDeclared
		) {
			return false;
		}
		const protocol: CodexResponseIdProtocol = nativeResponses
			? "native-responses"
			: "messages";
		// Digested *after* full conversion (Skill-nudge appends included), so
		// the fork's converted-tail safeguard is naturally preserved: a
		// response-id continuation always carries whatever the wire will
		// actually see, never what the client originally supplied.
		const fullDigests = digestReplayItems(codexBody.input);
		if (!fullDigests) return false;
		const lane = this.codexResponseIdLaneKey(
			accountId,
			codexBody.model,
			callerDigest,
			sessionIdentity,
			protocol,
		);
		const rejectedUntil = this.responseIdRejectedLanes.get(lane);
		if (rejectedUntil && rejectedUntil > Date.now()) return false;
		const configDigest = this.codexResponseIdConfigDigest(accountId, codexBody);
		const laneEntry = this.responseIdLanes.get(lane) ?? { generation: 0 };
		const laneState = laneEntry.state;
		let matchedPrefixLength = 0;
		if (
			laneState &&
			laneState.expiresAt > Date.now() &&
			laneState.configDigest === configDigest &&
			isDigestPrefixMatch(laneState.digests, fullDigests)
		) {
			matchedPrefixLength = laneState.digests.length;
		}
		// KTD13: check the pending charge before retaining/mutating anything.
		// A staged candidate is charged for its own response id slot too (the
		// worst case for what this attempt might promote), so overflow is
		// caught here rather than silently truncating input or failing later.
		const chargeEstimate = estimateCodexResponseIdCharge(
			"x".repeat(CODEX_RESPONSE_ID_MAX_ID_BYTES),
			fullDigests,
		);
		if (
			chargeEstimate === null ||
			!this.chargeCodexResponseIdBytes(chargeEstimate)
		) {
			// Aggregate budget (or a per-checkpoint ceiling) exhausted: fall
			// back safely to no continuation for this attempt. Never truncate
			// input and never fail the client request.
			return false;
		}
		const generation = laneEntry.generation + 1;
		laneEntry.generation = generation;
		this.responseIdLanes.set(lane, laneEntry);
		if (matchedPrefixLength > 0 && laneState) {
			codexBody.previous_response_id = laneState.responseId;
			// Only response-id projection truncates input; fork turn-state
			// never does.
			codexBody.input = codexBody.input.slice(matchedPrefixLength);
			laneState.lastUsedAt = Date.now();
		}
		this.pendingResponseIdByAttempt.set(attemptId, {
			lane,
			generation,
			requestDigests: fullDigests,
			configDigest,
			chargedBytes: chargeEstimate,
			ts: Date.now(),
			continued: matchedPrefixLength > 0,
		});
		return true;
	}

	/**
	 * Behavior 2 (rejected-id repair): must be called by proxy-operations.ts's
	 * shared physical-send boundary immediately after
	 * `isCodexResponseIdRejectionError` has classified the raw upstream
	 * response as a recognized rejection of the gateway-supplied
	 * `previous_response_id`, and strictly BEFORE dispatching the one-shot
	 * full-history repair retry.
	 *
	 * Confirms this exact physical attempt was actually response-id-owned
	 * with a real (non-cold) continuation -- a cold send never carried a
	 * `previous_response_id`, so a rejection naming that field cannot
	 * legitimately apply to it, and no repair is warranted -- then:
	 *  1. Drains the rejected attempt through the exact KTD13 owner choke
	 *     point (`releaseCodexResponseIdAttempt`), matching every other
	 *     non-promoting exit from this engine.
	 *  2. Retires the rejected lane's checkpoint: `state` is cleared (a
	 *     tombstone, `generation` preserved) exactly like TTL/LRU eviction in
	 *     `sweepCodexResponseIdState`, so no stale checkpoint can ever be
	 *     reused by a later attempt on this lane.
	 *  3. Populates `responseIdRejectedLanes` so `selectCodexResponseIdOwner`
	 *     refuses response-id ownership on this lane for
	 *     `CODEX_RESPONSE_ID_REJECTED_TTL_MS` -- the existing (previously
	 *     unwired) suppression gate this method activates. A second
	 *     rejection therefore can never trigger a second repair: the retry
	 *     that follows a `true` return here is sent with no
	 *     `previous_response_id` at all (full history, cold), and if upstream
	 *     rejects THAT attempt too, no continuation was ever staged for it,
	 *     so this method returns `false` and no further repair is attempted.
	 *
	 * Idempotent for a repeated call with the same `attemptId`: the second
	 * call's `pendingResponseIdByAttempt` lookup misses because the first
	 * call already drained it, so it returns `false` without mutating
	 * anything further.
	 */
	prepareCodexResponseIdRejectionRepair(
		attemptId: string | null | undefined,
	): boolean {
		if (!attemptId) return false;
		const owner = this.continuationOwnerByAttempt.get(attemptId);
		if (!owner || owner.owner !== "response-id") return false;
		const pending = this.pendingResponseIdByAttempt.get(attemptId);
		if (!pending?.continued) return false;
		const lane = pending.lane;
		this.releaseCodexResponseIdAttempt(attemptId);
		const laneEntry = this.responseIdLanes.get(lane);
		if (laneEntry?.state) {
			this.releaseCodexResponseIdBytes(laneEntry.state.chargedBytes);
			laneEntry.state = undefined;
			laneEntry.tombstonedAt = Date.now();
		}
		this.responseIdRejectedLanes.set(
			lane,
			Date.now() + CODEX_RESPONSE_ID_REJECTED_TTL_MS,
		);
		return true;
	}

	/**
	 * KTD7: promotes a staged response-id candidate into committed lane state,
	 * or discards it, from data the "response.completed" case already holds in
	 * memory (the terminal event's own `id` and `output`) -- it never reads,
	 * releases, or otherwise touches the upstream transport, so it cannot
	 * interfere with `cancelUpstreamOnce`/drain/finally for that transport,
	 * and it never gates or delays anything already written to the
	 * client-facing stream. Called from two places, both after the terminal
	 * SSE frames are already enqueued to the client: (1) `processEvents`'s
	 * frame loop, directly, once the rest of the chunk containing the
	 * terminal event has been scanned for a same-chunk trailing frame (see
	 * `state.responseIdTailTainted`) -- this is the ONLY call site when the
	 * KTD7 move-only handoff below is not eligible (turn-state-owned
	 * attempts, an already-tainted same-chunk tail, or no reader/pending
	 * candidate to hand off); and (2) `runCodexResponseIdTailValidator`,
	 * asynchronously, once that dedicated validator has independently
	 * observed true clean EOF across every subsequent read. Safe to call
	 * unconditionally in either case (idempotent: a missing or
	 * already-consumed pending candidate is a no-op).
	 *
	 * Never called for "response.incomplete" -- an incomplete response's
	 * `output` is not a trustworthy replay tail for the next turn, so that
	 * path (and every other non-clean terminal path: errors, cancellation,
	 * abrupt EOF) instead relies on the unconditional
	 * `releaseCodexResponseIdAttempt` cleanup in `processEvents`'s `finally`.
	 */
	private commitCodexResponseIdCheckpoint(state: StreamState): void {
		const attemptId = state.traceAttemptId;
		const terminal = state.responseIdTerminal;
		const tainted = state.responseIdTailTainted === true;
		state.responseIdTerminal = null;
		state.responseIdTailTainted = false;
		state.responseIdDoneSeenAfterTerminal = false;
		if (!attemptId || !terminal) return;
		const pending = this.pendingResponseIdByAttempt.get(attemptId);
		if (!pending) return;
		const outputDigests = digestReplayItems(terminal.output);
		// Release the pending (request-time, worst-case) charge unconditionally
		// before any attempt at a real (response-time, exact) charge -- the two
		// must never be double-counted against the aggregate budget, whichever
		// branch below returns.
		this.pendingResponseIdByAttempt.delete(attemptId);
		this.continuationOwnerByAttempt.delete(attemptId);
		this.releaseCodexResponseIdBytes(pending.chargedBytes);
		if (tainted) {
			// KTD7: a same-chunk trailing frame (or duplicate "[DONE]") after the
			// terminal event disqualifies this checkpoint outright -- "exactly
			// one valid completed response ... no other data-bearing frame" no
			// longer holds.
			return;
		}
		if (!outputDigests) {
			// Fail closed: an unrecognized output item type disqualifies this
			// checkpoint. The lane keeps whatever committed state (if any) it
			// already had, so the next request on this lane can still prefix-
			// match against that older checkpoint or fall back to a cold send.
			return;
		}
		const fullDigests = [...pending.requestDigests, ...outputDigests];
		const chargeEstimate = estimateCodexResponseIdCharge(
			terminal.responseId,
			fullDigests,
		);
		if (
			chargeEstimate === null ||
			!this.chargeCodexResponseIdBytes(chargeEstimate)
		) {
			// Ceiling exceeded at commit time: skip capture, retain no new lane.
			return;
		}
		const laneEntry = this.responseIdLanes.get(pending.lane) ?? {
			generation: pending.generation,
		};
		if (laneEntry.generation > pending.generation) {
			// KTD6 lane-generation guard: superseded by a newer attempt on the
			// same lane. Never let a stale, slower-finishing attempt clobber a
			// fresher checkpoint. Release the just-approved charge too.
			this.releaseCodexResponseIdBytes(chargeEstimate);
			return;
		}
		if (laneEntry.state) {
			this.releaseCodexResponseIdBytes(laneEntry.state.chargedBytes);
		}
		laneEntry.generation = pending.generation;
		laneEntry.state = {
			responseId: terminal.responseId,
			digests: fullDigests,
			configDigest: pending.configDigest,
			expiresAt: Date.now() + CODEX_RESPONSE_ID_LANE_TTL_MS,
			chargedBytes: chargeEstimate,
			lastUsedAt: Date.now(),
		};
		// Reactivating a tombstoned entry (evicted/expired, generation kept):
		// it is no longer eligible for tombstone-only sweeping now that it
		// carries live state again.
		laneEntry.tombstonedAt = undefined;
		this.responseIdLanes.set(pending.lane, laneEntry);
	}

	/**
	 * KTD7 attempt-scoped tail validator: the sole owner, from the instant
	 * `processEvents` hands it off, of the upstream reader, the SSE parser's
	 * carried partial buffer, and the transport's abort capability. This is a
	 * move, not a share -- the handoff call site forces
	 * `upstreamDrainStarted = true` first, which makes `cancelUpstreamOnce`
	 * and the `finally` block's own reader release/settlement permanently
	 * no-ops for this transport, so nothing else can read, release, drain, or
	 * abort it while this method is running. There is no separate
	 * outstanding upstream read to move at handoff time: `CodexStreamLiveness
	 * .next()` already consumed and cleared its own pending read to produce
	 * the `{ value, done }` for the very chunk that triggered the terminal
	 * event, so reader + buffer + abort capability is the whole of what
	 * needs to transfer.
	 *
	 * Resolves the staged response-id candidate through exactly one of five
	 * distinct outcomes -- clean EOF (promote via
	 * `commitCodexResponseIdCheckpoint`), or invalid tail / deadline / read
	 * error / cancellation (all four discard via
	 * `releaseCodexResponseIdAttempt`) -- via a single `resolved` compare-
	 * and-set, so whichever trigger (a later frame, the deadline timer, or a
	 * downstream cancel) reaches the gate first is the only one that can act;
	 * every later trigger becomes a no-op. Never touches `writeSSE`/
	 * `writeTerminalTrace`/the downstream controller: the client-facing
	 * stream has already reached its terminal boundary and closed by the
	 * time this runs (the handoff call site never awaits this method), and a
	 * tail result only ever appends checkpoint diagnostics
	 * (`state.responseIdTailTainted`), never a second terminal trace or a
	 * retraction of what the client already received.
	 *
	 * One monotonic budget covers the whole loop plus the final pending-read
	 * settlement grace on a losing exit, mirroring -- never stacking beyond
	 * -- `drainReaderWithDeadline`'s own read-plus-settlement shape:
	 * `deadlineMs` bounds how long the read loop may run, and the same
	 * `deadlineMs` bounds the one settlement grace given to a still-
	 * outstanding read after the transport is aborted.
	 */
	private async runCodexResponseIdTailValidator(params: {
		state: StreamState;
		reader: ReadableStreamDefaultReader<Uint8Array>;
		sseFrameBuffer: SseFrameBuffer;
		drainAbort?: AbortController;
		deadlineMs: number;
		cancelSignal: AbortSignal;
	}): Promise<void> {
		const {
			state,
			reader,
			sseFrameBuffer,
			drainAbort,
			deadlineMs,
			cancelSignal,
		} = params;
		let resolved = false;
		const resolveOnce = (
			outcome:
				| "clean_eof"
				| "invalid_tail"
				| "deadline"
				| "read_error"
				| "cancellation",
		): void => {
			if (resolved) return;
			resolved = true;
			if (outcome === "clean_eof") {
				this.commitCodexResponseIdCheckpoint(state);
				return;
			}
			if (outcome === "invalid_tail") {
				// Diagnostics only, per contract: never a second terminal
				// trace, never a retraction of already-delivered client
				// output. commitCodexResponseIdCheckpoint (not called here)
				// would also discard correctly on `tainted`, but this exit
				// never received a fresh terminal frame to stage, so the
				// dedicated KTD13 discard choke point is used directly.
				state.responseIdTailTainted = true;
			}
			this.releaseCodexResponseIdAttempt(state.traceAttemptId ?? null);
		};

		const abortTransport = (message: string) => {
			if (drainAbort && !drainAbort.signal.aborted) {
				drainAbort.abort(new Error(message));
			}
		};

		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
		});
		const cancellation = new Promise<"cancellation">((resolve) => {
			if (cancelSignal.aborted) {
				resolve("cancellation");
				return;
			}
			cancelSignal.addEventListener("abort", () => resolve("cancellation"), {
				once: true,
			});
		});

		try {
			while (true) {
				const pendingRead = reader.read();
				const raced = await Promise.race([pendingRead, deadline, cancellation]);
				if (raced === "deadline" || raced === "cancellation") {
					abortTransport(
						raced === "deadline"
							? "Codex response-id tail validation deadline exceeded"
							: "Codex response-id tail validation cancelled",
					);
					await awaitCodexTailPendingReadSettlement(pendingRead, deadlineMs);
					resolveOnce(raced);
					return;
				}
				const { value, done } = raced;
				if (done) {
					// Reached true upstream EOF. A non-empty flush() means a
					// partial frame straddled the buffer boundary and was
					// never terminated -- KTD7 requires clean EOF, not "EOF
					// after discarding unterminated bytes".
					let leftover: string;
					try {
						leftover = sseFrameBuffer.flush();
					} catch {
						resolveOnce("invalid_tail");
						return;
					}
					resolveOnce(leftover.length > 0 ? "invalid_tail" : "clean_eof");
					return;
				}
				let frames: string[];
				try {
					frames = sseFrameBuffer.push(value);
				} catch {
					// SseLimitError or similar: an oversized frame/tail on the
					// tail read is itself a disqualifying, non-clean EOF.
					abortTransport(
						"Codex response-id tail validation hit a resource limit",
					);
					resolveOnce("invalid_tail");
					return;
				}
				for (const eventText of frames) {
					// Mirrors the same-chunk scanner above: only a data-bearing
					// frame disqualifies the candidate, and at most one
					// trailing "[DONE]" is tolerated (state.responseIdDoneSeen
					// AfterTerminal is the same flag threaded from the
					// same-chunk scan, so a "[DONE]" already seen there still
					// counts here).
					const { dataLine } = findCodexSseFrameLines(eventText);
					if (!dataLine) continue;
					const dataStr = dataLine.slice("data:".length).trim();
					if (dataStr === "[DONE]" && !state.responseIdDoneSeenAfterTerminal) {
						state.responseIdDoneSeenAfterTerminal = true;
						continue;
					}
					abortTransport(
						"Codex response-id tail validation found a disqualifying frame",
					);
					resolveOnce("invalid_tail");
					return;
				}
			}
		} catch {
			abortTransport("Codex response-id tail validation read failed");
			resolveOnce("read_error");
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			try {
				reader.releaseLock();
			} catch {
				// Reader may already be errored/released by the transport abort.
			}
		}
	}

	createServerToolCapabilityTuple(
		context: ProviderServerToolCapabilityContext,
	): ServerToolCapabilityTuple | undefined {
		return createCodexServerToolCapabilityTuple(context);
	}

	resolveServerToolCapability(
		requirements: ServerToolRequirements,
		tuple: ServerToolCapabilityTuple,
	): ServerToolCapabilityDecision {
		return resolveCodexServerToolCapability(requirements, tuple);
	}

	createAttemptPlan(context: ProviderAttemptPlanContext) {
		return createCodexHostedSearchAttemptPlan(context, {
			prepareHeaders: (headers, accessToken) =>
				this.prepareHeaders(headers, accessToken),
			transformOrdinaryRequest: (request) =>
				this.transformRequestBody(request, context.account, undefined, {
					hosted: true,
				}),
			processHostedResponse: (
				response,
				_requestHeaders,
				requestedStream,
				replayIssuer: ProviderServerToolReplayIssuer,
				capabilityProofKey,
				physicalModel,
			) => {
				const requestId = response.headers.get("x-better-ccflare-request-id");
				if (requestId) this.requestStreamById.delete(requestId);
				return processCodexHostedSearchResponse({
					response,
					requestedStream,
					replayIssuer,
					capabilityProofKey,
					physicalModel,
					sanitizeHeaders: sanitizeResponseHeaders,
					sanitizeClientFunctionArguments: (name, argumentsJson) =>
						this.sanitizeToolUsePartialJson(name, argumentsJson),
					fallback: () =>
						// Hosted search never registers a turn-state attempt (it has no
						// reachable turn-state terminal), so finalizing here would look
						// up an attempt the coordinator was never told about and report
						// `unknown_attempt` -- a counter that otherwise means "we lost
						// an attempt we should still have". Say `ineligible` instead,
						// which is what this attempt actually was.
						this.processResponse(response, context.account, undefined, {
							hosted: true,
						}),
				});
			},
			parseRateLimit: (response) => this.parseRateLimit(response),
			...(this.isStreamingResponse
				? {
						isStreamingResponse: (response: Response) =>
							this.isStreamingResponse?.(response) ?? false,
					}
				: {}),
			...(this.extractTierInfo
				? {
						extractTierInfo: (response: Response) =>
							this.extractTierInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
			...(this.extractUsageInfo
				? {
						extractUsageInfo: (response: Response) =>
							this.extractUsageInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
		});
	}

	getLogicalModelCapability(
		logicalModel: string,
		_account: Account,
	): LogicalModelCapability {
		const family = getModelFamily(logicalModel);
		if (!family) {
			return {
				status: "unknown",
				provenance: "undeclared",
				reason: "unknown",
			};
		}
		return DEFAULT_MODEL_MAP[family]
			? {
					status: "supported",
					provenance: "provider_default",
					reason: "included",
				}
			: {
					status: "unsupported",
					provenance: "provider_default",
					reason: "unsupported",
				};
	}
	override readonly cacheReplayModelStrategy = "transformed-body" as const;
	// Fallback map: proxy-operations.ts injects x-better-ccflare-request-id and
	// x-better-ccflare-request-stream into the upstream response before calling
	// processResponse, so headerRequestedStream is normally set. This map covers
	// the race where a response arrives after the 30s TTL sweep evicts the entry,
	// and the 529 in-place retry path (which doesn't re-tag those headers).
	private requestStreamById = new Map<
		string,
		{ stream: boolean; hasCustomTools: boolean; ts: number }
	>();

	private sweepRequestStreamById(): void {
		const cutoff = Date.now() - 30_000;
		for (const [id, entry] of this.requestStreamById) {
			if (entry.ts < cutoff) {
				this.requestStreamById.delete(id);
			}
		}
	}

	// Per-request, per-tool schema info derived from the Anthropic request's
	// tools[].input_schema, used to decide whether a ""-valued tool-call
	// argument is a genuinely-omitted optional string (safe to strip) versus
	// an unknown field (kept, never guessed). Same 30s TTL sweep pattern as
	// requestStreamById above; populated in transformRequestBody, read from
	// the response-side sanitizers via requestId.
	private requestToolSchemasById = new Map<
		string,
		{ tools: Map<string, CodexToolSchemaInfo>; ts: number }
	>();

	private sweepRequestToolSchemasById(): void {
		const cutoff = Date.now() - 30_000;
		for (const [id, entry] of this.requestToolSchemasById) {
			if (entry.ts < cutoff) {
				this.requestToolSchemasById.delete(id);
			}
		}
	}

	/** Guarded against malformed/missing schemas: never throws, worst case yields an empty map. */
	private buildToolSchemaMap(
		tools: AnthropicTool[] | undefined,
	): Map<string, CodexToolSchemaInfo> {
		const result = new Map<string, CodexToolSchemaInfo>();
		if (!Array.isArray(tools)) return result;
		for (const tool of tools) {
			if (!tool || typeof tool.name !== "string") continue;
			const schema = tool.input_schema;
			if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
				continue;
			}
			const required = new Set<string>();
			const requiredRaw = (schema as Record<string, unknown>).required;
			if (Array.isArray(requiredRaw)) {
				for (const key of requiredRaw) {
					if (typeof key === "string") required.add(key);
				}
			}
			const props = new Map<string, CodexToolSchemaPropInfo>();
			const propsRaw = (schema as Record<string, unknown>).properties;
			if (
				propsRaw &&
				typeof propsRaw === "object" &&
				!Array.isArray(propsRaw)
			) {
				for (const [propName, propSchemaRaw] of Object.entries(
					propsRaw as Record<string, unknown>,
				)) {
					if (
						!propSchemaRaw ||
						typeof propSchemaRaw !== "object" ||
						Array.isArray(propSchemaRaw)
					) {
						continue;
					}
					const propSchema = propSchemaRaw as Record<string, unknown>;
					const type = propSchema.type;
					const isString =
						type === "string" ||
						(Array.isArray(type) && type.includes("string"));
					const enumValues = propSchema.enum;
					const enumHasEmptyString =
						Array.isArray(enumValues) && enumValues.includes("");
					props.set(propName, { isString, enumHasEmptyString });
				}
			}
			result.set(tool.name, { required, props });
		}
		return result;
	}

	private getToolSchemaInfo(
		requestId: string | undefined,
		toolName: string,
	): CodexToolSchemaInfo | undefined {
		if (!requestId) return undefined;
		return this.requestToolSchemasById.get(requestId)?.tools.get(toolName);
	}

	canHandle(path: string): boolean {
		return (
			path === "/v1/messages" ||
			path === "/v1/messages/count_tokens" ||
			path === "/v1/models"
		);
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
			let errorData: unknown = null;
			let responseText = "";
			let responseTextTruncated = false;
			try {
				const bounded = await readBoundedOAuthResponseText(response);
				responseText = bounded.text;
				responseTextTruncated = bounded.truncated;
				errorData = JSON.parse(responseText);
			} catch {
				// ignore
			}

			// A response that hit the bound is not authoritative. Even if the
			// bounded prefix happens to be valid JSON, trailing bytes could change
			// its meaning, so it must never quarantine an account.
			const errorCode = responseTextTruncated
				? ""
				: getOAuthErrorCode(errorData) || getExactOAuthErrorCode(responseText);
			const errorMessage = errorCode || `HTTP ${response.status}`;

			// Rotating refresh tokens: reuse → terminal, must re-auth. Throw the
			// typed error so the refresh chokepoint pauses the account for reauth
			// (detection is by type, not by message wording).
			if (errorCode === "refresh_token_reused") {
				throw new OAuthRefreshTokenError(
					account.id,
					`Codex refresh_token_reused for account ${account.name}. Please re-authenticate with: bun run cli --reauthenticate ${account.name}`,
					errorCode,
				);
			}

			const failureMessage = `Failed to refresh Codex token for account ${account.name}: ${errorMessage}`;
			if (errorCode) {
				throw new OAuthRefreshTokenError(account.id, failureMessage, errorCode);
			}
			throw new Error(failureMessage);
		}

		const bounded = await readBoundedOAuthResponseText(response);
		if (bounded.truncated) {
			throw new Error(
				`Codex token refresh response exceeded ${MAX_OAUTH_ERROR_INPUT_LENGTH} bytes`,
			);
		}
		let json: {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};
		try {
			json = JSON.parse(bounded.text) as typeof json;
		} catch {
			throw new Error(
				`Codex token refresh response for ${account.name} was not valid JSON`,
			);
		}
		if (!json || typeof json.access_token !== "string" || !json.access_token) {
			throw new Error(
				`Codex token refresh response for ${account.name} did not include an access token`,
			);
		}

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
		if (_path === "/v1/models") {
			return `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_VERSION)}`;
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
		newHeaders.delete(CODEX_TURN_STATE_HEADER);

		// Remove internal proxy headers.
		for (const key of [...newHeaders.keys()]) {
			if (key.startsWith("x-better-ccflare-")) {
				newHeaders.delete(key);
			}
		}

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

	/**
	 * Request-top observation, strictly BEFORE account selection: the proxy
	 * calls this before any account is chosen, so it also covers a purely
	 * local refusal (pool exhaustion, a policy exclusion, ...) that never
	 * reaches `observeUpstream`'s final-wire boundary below. Opt-in via the
	 * same `CODEX_CACHE_DIAGNOSTICS_ENV` switch, and a diagnostics failure
	 * here must never affect the request path -- every fact is computed from
	 * caller-supplied headers/response only, nothing here can throw into
	 * routing. `refusal_reason: "pool_exhausted"` is read off the recovery
	 * headers `createModelPoolExhaustedResponse`/`createRoutingTerminalResponse`
	 * already set on a locally-terminated response, not from any Codex-specific
	 * signal, so this fires for a pool refusal regardless of which provider
	 * ultimately would have served the request.
	 */
	observeRequest(
		headers: Headers,
		nativeResponses: boolean,
	): RequestObservation | undefined {
		if (process.env[CODEX_CACHE_DIAGNOSTICS_ENV] !== "1") return undefined;
		const gatewayIdentity = (name: string): string | null => {
			const value = headers.get(name);
			return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
		};
		const facts: CacheFacts = {
			ingress_digest: cacheDigest(randomUUID()),
			path: nativeResponses ? "native" : "legacy",
			gateway_request_digest: gatewayIdentity(
				"x-better-ccflare-gateway-request-digest",
			),
			gateway_attempt_digest: gatewayIdentity(
				"x-better-ccflare-gateway-attempt-digest",
			),
		};
		recordCacheLifecycle({ ...facts, event: "request_received" });
		return {
			bindRequestId(requestId: string) {
				facts.request_digest = cacheDigest(requestId);
				recordCacheLifecycle({ ...facts, event: "request_identified" });
			},
			response(response: Response) {
				recordCacheLifecycle({
					...facts,
					event: "request_headers",
					status_code: response.status,
					refusal_reason:
						response.headers.get(RECOVERY_STATUS_HEADER) ===
						RECOVERY_STATUS_EXHAUSTED
							? "pool_exhausted"
							: null,
				});
				return response;
			},
			error(_error: unknown) {
				recordCacheLifecycle({ ...facts, event: "request_error" });
			},
		};
	}

	/**
	 * Final-wire observation (KTD8): captured by the proxy at the point closest
	 * to the actual dispatched HTTP request, strictly AFTER every retry's final
	 * model/input/header transformations. Purely observational -- opt-in via
	 * `CODEX_CACHE_DIAGNOSTICS_ENV`, and a diagnostics failure here must never
	 * affect the request path (see `observeCodexWire`'s own guarantees). Skips
	 * GET requests (e.g. `/v1/models` passthrough), which carry no body to
	 * correlate.
	 */
	async observeUpstream(request: Request, context: UpstreamObservationContext) {
		if (
			process.env[CODEX_CACHE_DIAGNOSTICS_ENV] !== "1" ||
			request.method === "GET"
		) {
			return undefined;
		}
		return observeCodexWire(
			this.cacheDiagnostics,
			request,
			context,
			(source) =>
				this.extractSessionId(source as unknown as AnthropicRequest) ?? null,
		);
	}

	/**
	 * @param _beforePhysicalTransport - Third positional slot in the `Provider`
	 * contract, reserved for providers whose transform performs the physical send
	 * itself (Bedrock). Codex only rewrites the body — the proxy owns its
	 * transport — so the gate is accepted to keep the shared signature and
	 * deliberately never invoked. Asserting the attempt budget here would charge a
	 * send that has not happened yet.
	 * @param options - Codex-private transform options; keep them after the
	 * contract's own parameters so a future shared parameter does not collide.
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
		_beforePhysicalTransport?: () => void,
		options: CodexTransformOptions = {},
	): Promise<Request> {
		const trustedLogicalModelFamily = request.headers.has(
			CODEX_LOGICAL_MODEL_FAMILY_HEADER,
		)
			? (request.headers.get(CODEX_LOGICAL_MODEL_FAMILY_HEADER) ?? "")
					.trim()
					.toLowerCase()
			: null;
		if (
			request.headers.has(CODEX_LOGICAL_MODEL_FAMILY_HEADER) ||
			request.headers.has(CODEX_TURN_STATE_HEADER)
		) {
			const sanitizedHeaders = new Headers(request.headers);
			sanitizedHeaders.delete(CODEX_LOGICAL_MODEL_FAMILY_HEADER);
			sanitizedHeaders.delete(CODEX_TURN_STATE_HEADER);
			request = new Request(request, { headers: sanitizedHeaders });
		}
		// /v1/models is a GET passthrough to the subscription catalog endpoint.
		// It has no JSON body to translate.
		const codexModelsUrl = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_VERSION)}`;
		if (request.url.startsWith(codexModelsUrl.split("?")[0])) {
			return request;
		}

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
			this.sweepRequestToolSchemasById();
			const rawBody = (await request.json()) as AnthropicRequest;
			const passthrough = rawBody.__better_ccflare_codex_passthrough as
				| Record<string, unknown>
				| undefined;
			// This carrier is private proxy metadata, never part of the upstream
			// Responses schema. Consume it before serializing the Codex request.
			delete rawBody.__better_ccflare_codex_passthrough;
			const body = applySkillElision(
				this.name,
				rawBody,
				resolveSkillElisionBlockedSkills(),
			);
			const logicalModelFamily =
				trustedLogicalModelFamily ?? getModelFamily(body.model);
			if (isSyntheticCountTokens) {
				if (process.env[CODEX_SYNTHETIC_COUNT_TOKENS_ENV] === "0") {
					return this.createSyntheticErrorResponse(
						request,
						501,
						"not_implemented_error",
						"Codex does not support count_tokens; synthetic estimates are disabled (CCFLARE_CODEX_SYNTHETIC_COUNT_TOKENS=0).",
					);
				}
				return this.createSyntheticCountTokensResponse(request, body);
			}
			const isSubscriptionEndpoint = isCodexSubscriptionEndpoint(request.url);
			if (
				isSubscriptionEndpoint &&
				typeof body.max_tokens === "number" &&
				body.max_tokens <= 0
			) {
				return this.createSyntheticErrorResponse(
					request,
					400,
					"invalid_request_error",
					`Codex subscription requests do not support max_tokens: ${body.max_tokens}.`,
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
				this.requestToolSchemasById.set(requestId, {
					tools: this.buildToolSchemaMap(body.tools),
					ts: Date.now(),
				});
			}
			const {
				codexBody,
				reasoningEffortRequested,
				reasoningEffortSource,
				cacheKeyDecision,
				explicitBreakpointDecision,
				orchestrationAdmission,
				orchestrationBasis,
				filteredToolNames,
				orchestrationDemotionObserved,
				elapsedMsSinceRoot,
			} = this.convertToCodexFormat(
				body,
				account,
				requestId ?? undefined,
				isAttributedAgent,
				isSubscriptionEndpoint &&
					(attemptCause === "cache_lane_rescue" ||
						attemptCause === "precommit_sse_retry") &&
					requestId
					? requestId.slice(0, CODEX_CACHE_LANE_RESCUE_SALT_MAX_CHARS)
					: undefined,
				request.url,
				finalModel ?? undefined,
				logicalModelFamily,
				passthrough,
			);
			if (isSubscriptionEndpoint) {
				// ChatGPT's subscription Responses endpoint rejects this API-only field.
				delete codexBody.max_output_tokens;
			}
			// Computed BEFORE any response-id input truncation below (which
			// mutates codexBody.input in place): both the owner-eligibility gate
			// and the later processResponse-format bookkeeping must see the
			// original declaration, not a possibly-truncated tail that could
			// have sliced away the declaring "additional_tools" item.
			const hasCustomTools =
				(codexBody.tools?.some(
					(t) => (t as { type?: string }).type !== "function",
				) ??
					false) ||
				codexBody.input.some(
					(item) => (item as { type?: string }).type === "additional_tools",
				);
			// KTD6: resolve the single continuation owner for this physical
			// attempt before CodexTurnStateCoordinator.beginAttempt runs. Either
			// a server-verified native-Responses request (see
			// prepareAttemptHeaders in proxy-operations.ts) with an explicit
			// client opt-in (`continuation_strategy: "previous_response_id"`,
			// carried only through the already-trust-gated passthrough
			// carrier), or -- Behavior 1 -- a plain Claude Messages request
			// (server-verified ABSENCE of the native-Responses header) with
			// the default-OFF CCFLARE_CODEX_MESSAGES_CONTINUATION=1 env flag
			// (and optional model allowlist) is eligible; everything else
			// falls through to the fork's own turn-state mechanism unchanged.
			this.sweepCodexResponseIdState();
			const nativeResponses =
				request.headers.get(CODEX_NATIVE_RESPONSES_HEADER) === "1";
			const continuationOptIn =
				passthrough?.continuation_strategy === "previous_response_id";
			const messagesContinuationModels =
				process.env[CODEX_MESSAGES_CONTINUATION_MODELS_ENV];
			const messagesLaneAdmitted =
				!nativeResponses &&
				process.env[CODEX_MESSAGES_CONTINUATION_ENV] === "1" &&
				(messagesContinuationModels === undefined ||
					messagesContinuationModels
						.split(",")
						.map((model) => model.trim())
						.includes(codexBody.model));
			const sessionIdentity =
				cacheKeyDecision.selectedConversationIdentity ??
				cacheKeyDecision.conversationIdentity;
			const responseIdOwns = this.selectCodexResponseIdOwner({
				nativeResponses,
				continuationOptIn,
				messagesLaneAdmitted,
				hosted: options.hosted === true,
				customToolsDeclared: hasCustomTools,
				accountId: account?.id,
				attemptId,
				codexBody,
				callerDigest: request.headers.get(CODEX_AUTHENTICATED_CALLER_HEADER),
				sessionIdentity,
			});
			if (attemptId) {
				this.continuationOwnerByAttempt.set(attemptId, {
					owner: responseIdOwns ? "response-id" : "turn-state",
					ts: Date.now(),
				});
			}
			// KTD6 owner exclusivity: response-id and turn-state never both own
			// the same physical attempt. When response-id owns it, turn-state's
			// own beginAttempt (percentage/cohort gating, token issuance, replay
			// bookkeeping) must not run at all for this attempt -- not run and
			// discarded, never run.
			const turnStateDecision = responseIdOwns
				? {
						arm: "ineligible" as const,
						cohortId: null,
						action: "response_id_owned" as const,
						replayApplied: false,
						turnState: undefined,
					}
				: this.turnStateCoordinator.beginAttempt({
						accountId: account?.id,
						model: codexBody.model,
						conversationIdentity: sessionIdentity,
						requestId,
						attemptId,
						attemptCause: attemptCause as CodexTurnStateAttemptCause | null,
						eligibleEndpoint: isSubscriptionEndpoint,
						hosted: options.hosted === true,
						lineage: extractCodexTurnStateLineage(body.messages),
						// Reported from the converted body, not the client's messages: those
						// are what lineage is derived from, but conversion is free to append
						// after them (see the Skill nudge in convertToCodexFormat).
						continuationTailIntact: codexInputEndsWithToolOutput(
							codexBody.input,
						),
					});
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
				logicalReasoningEffortRequested: reasoningEffortRequested,
				logicalReasoningEffortSource: reasoningEffortSource,
				physicalReasoningEffortApplied: codexBody.reasoning?.effort,
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
				cacheKeyContinuityBasis: cacheKeyDecision.continuityBasis,
				cacheKeyContinuityApplied: cacheKeyDecision.continuityApplied,
				continuityEvidenceId:
					cacheKeyDecision.effectiveMode === "conversation"
						? (cacheKeyDecision.canonicalConversationIdentity?.slice(0, 16) ??
							null)
						: null,
				canonicalConversationId: cacheKeyDecision.continuityApplied
					? (cacheKeyDecision.selectedConversationIdentity?.slice(0, 16) ??
						null)
					: null,
				explicitBreakpointCanary: explicitBreakpointDecision.canary,
				explicitBreakpointCohortId: explicitBreakpointDecision.cohortId,
				explicitBreakpointAction: explicitBreakpointDecision.action,
				pacingCanary: request.headers.get("x-better-ccflare-pacing-canary"),
				pacingCohortId: request.headers.get(
					"x-better-ccflare-pacing-cohort-id",
				),
				pacingAction: request.headers.get("x-better-ccflare-pacing-action"),
				pacingRole: request.headers.get("x-better-ccflare-pacing-role"),
				pacingWaitMs: request.headers.get("x-better-ccflare-pacing-wait-ms"),
				pacingReleaseReason: request.headers.get(
					"x-better-ccflare-pacing-release-reason",
				),
				turnStateArm: turnStateDecision.arm,
				turnStateCohortId: turnStateDecision.cohortId,
				turnStateRequestAction: turnStateDecision.action,
				turnStateReplayApplied: turnStateDecision.replayApplied,
				turnState: turnStateDecision.turnState,
				isDescendant: isAttributedAgent,
				orchestrationAdmission,
				orchestrationBasis,
				orchestrationDemotionObserved,
				elapsedMsSinceRoot,
				toolsBeforeCount: body.tools?.length ?? 0,
				filteredToolNames,
				instructions: codexBody.instructions,
				tools: codexBody.tools,
				codexInput: codexBody.input,
				anthropicRequest: body,
				codexRequest: codexBody,
			});

			// hasCustomTools was already computed above (before any response-id
			// input truncation) so processResponse's buffering-skip decision and
			// the KTD6 owner-eligibility gate agree on the same declaration.
			if (requestId) {
				this.requestStreamById.set(requestId, {
					stream: body.stream === true,
					hasCustomTools,
					ts: Date.now(),
				});
			}

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete(CODEX_TURN_STATE_HEADER);
			if (turnStateDecision.turnState) {
				newHeaders.set(CODEX_TURN_STATE_HEADER, turnStateDecision.turnState);
			}
			newHeaders.set(
				"x-better-ccflare-request-stream",
				body.stream === true ? "true" : "false",
			);
			newHeaders.set(
				"x-better-ccflare-codex-custom-tools",
				hasCustomTools ? "true" : "false",
			);
			newHeaders.delete(CODEX_CONVERSATION_ID_HEADER);
			if (cacheKeyDecision.webSocketConversationIdentity) {
				newHeaders.set(
					CODEX_CONVERSATION_ID_HEADER,
					cacheKeyDecision.webSocketConversationIdentity,
				);
			}

			newHeaders.delete("x-better-ccflare-request-id");
			newHeaders.delete("x-better-ccflare-attempt-id");
			newHeaders.delete("x-better-ccflare-attempt-ordinal");
			newHeaders.delete("x-better-ccflare-attempt-cause");
			newHeaders.delete("x-better-ccflare-final-model");
			newHeaders.delete("x-better-ccflare-attributed-agent");
			newHeaders.delete("x-better-ccflare-pacing-canary");
			newHeaders.delete("x-better-ccflare-pacing-cohort-id");
			newHeaders.delete("x-better-ccflare-pacing-action");
			newHeaders.delete("x-better-ccflare-pacing-role");
			newHeaders.delete("x-better-ccflare-pacing-wait-ms");
			newHeaders.delete("x-better-ccflare-pacing-release-reason");
			newHeaders.delete(CODEX_NATIVE_RESPONSES_HEADER);
			newHeaders.delete(CODEX_AUTHENTICATED_CALLER_HEADER);
			newHeaders.delete("content-length");

			const serializedBody = JSON.stringify(codexBody);

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: serializedBody,
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

	/**
	 * @param _requestHeaders - Third positional slot in the `Provider` contract.
	 * Codex does not read it, but it is accepted so this stays assignable to the
	 * shared signature -- the same collision that bit `transformRequestBody`.
	 * @param drainAbortOrOptions - The shared contract supplies the exact fetch's
	 * abort controller in this slot. Codex-owned hosted-search callers may instead
	 * pass private turn-state options; exact response ownership wins when both an
	 * explicit controller and a registered response controller exist.
	 */
	async processResponse(
		response: Response,
		_account: Account | null,
		_requestHeaders?: Headers,
		drainAbortOrOptions: AbortController | CodexProcessResponseOptions = {},
	): Promise<Response> {
		const options =
			drainAbortOrOptions instanceof AbortController ? {} : drainAbortOrOptions;
		const explicitDrainAbort =
			drainAbortOrOptions instanceof AbortController
				? drainAbortOrOptions
				: undefined;
		const drainAbort =
			getResponseDrainTransport(response) ?? explicitDrainAbort;

		// /v1/models responses: translate Codex format → OpenAI /v1/models format
		// with full capability fields preserved for the CLI.
		const requestPath = response.headers.get("x-better-ccflare-request-path");
		if (requestPath === "/v1/models") {
			return this.transformModelsListResponse(response);
		}

		const contentType = response.headers.get("content-type");
		const requestId = response.headers.get("x-better-ccflare-request-id");
		const fallbackEntry = requestId
			? this.requestStreamById.get(requestId)
			: undefined;
		// Sliding TTL: a long bounded retry must retain the request's stream and
		// custom-tool declaration until its response is processed.
		if (requestId && fallbackEntry) {
			this.requestStreamById.set(requestId, {
				...fallbackEntry,
				ts: Date.now(),
			});
		}
		const attemptId = response.headers.get("x-better-ccflare-attempt-id");
		const turnStateHeaderPresent = response.headers.has(
			CODEX_TURN_STATE_HEADER,
		);
		const turnState = response.headers.get(CODEX_TURN_STATE_HEADER);
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
					: (fallbackEntry?.stream ?? true);
		const headerCustomTools = response.headers.get(
			"x-better-ccflare-codex-custom-tools",
		);
		const mightHaveCustomToolCalls =
			headerCustomTools === "true"
				? true
				: headerCustomTools === "false"
					? false
					: (fallbackEntry?.hasCustomTools ?? false);
		// Not deleted: an in-place 529 retry re-invokes processResponse and needs
		// this entry too. sweepRequestStreamById reclaims it after 30s instead.
		const isEventStream = contentType?.includes("text/event-stream") ?? false;
		if (isEventStream) {
			// No custom tools declared, so no custom_tool_call is possible: skip
			// buffering and stream straight through.
			if (!mightHaveCustomToolCalls) {
				if (requestedStream) {
					return this.transformStreamingResponse(
						response,
						requestId ?? undefined,
						attemptId ?? undefined,
						finalModel,
						options.hosted === true,
						drainAbort,
					);
				}
				return this.transformSseResponseToJson(
					response,
					requestId ?? undefined,
					attemptId ?? undefined,
					finalModel,
					options.hosted === true,
					drainAbort,
				);
			}
			// A custom_tool_call can appear at any point in the stream, and the
			// passthrough-vs-transform choice must be made before the first byte
			// is returned, so sniffing for one would buffer the whole stream and
			// withhold deltas and keepalives until upstream EOF. Custom tools only
			// originate from the /v1/responses adapter, whose client speaks
			// Responses SSE natively — pass the live stream through untouched.
			if (requestedStream) {
				// KTD13: this passthrough branch never reaches
				// transformStreamingResponse/processEvents, so no commit or
				// finally-block release will ever run for a candidate staged at
				// request time. selectCodexResponseIdOwner already excludes a
				// custom-tools-declaring request from ownership, so this is
				// normally a no-op; kept as defense-in-depth so no charge can leak
				// on this branch regardless.
				this.releaseCodexResponseIdAttempt(attemptId);
				return this.buildCustomToolCallPassthroughResponse(
					response.body,
					response,
				);
			}
			// The Responses adapter consumes the native terminal event and returns
			// its response object as JSON for non-streaming clients.
			this.releaseCodexResponseIdAttempt(attemptId);
			return this.buildCustomToolCallPassthroughResponse(
				await response.text(),
				response,
			);
		}

		if (response.ok && response.body !== null && contentType === null) {
			log.warn(
				`Codex returned successful response without SSE content-type (<missing>); transforming as ${requestedStream ? "SSE" : "JSON"}`,
			);
			if (mightHaveCustomToolCalls && requestedStream) {
				this.releaseCodexResponseIdAttempt(attemptId);
				return this.buildCustomToolCallPassthroughResponse(
					response.body,
					response,
				);
			}
			const body = mightHaveCustomToolCalls
				? await response.text()
				: response.body;
			if (
				typeof body === "string" &&
				mightHaveCustomToolCalls &&
				hasCustomToolCallEvent(body)
			) {
				this.releaseCodexResponseIdAttempt(attemptId);
				return this.buildCustomToolCallPassthroughResponse(body, response);
			}
			// Keep private upstream headers until the normal response transformer has
			// captured them. That transformer sanitizes the downstream response.
			const headers = new Headers(response.headers);
			headers.set("content-type", "text/event-stream");
			const sseResponse = new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
			transferResponseDrainTransport(response, sseResponse);
			if (requestedStream) {
				return this.transformStreamingResponse(
					sseResponse,
					requestId ?? undefined,
					attemptId ?? undefined,
					finalModel,
					options.hosted === true,
					drainAbort,
				);
			}
			return this.transformSseResponseToJson(
				sseResponse,
				requestId ?? undefined,
				attemptId ?? undefined,
				finalModel,
				options.hosted === true,
				drainAbort,
			);
		}

		// This attempt never reached an SSE body at all (a genuine HTTP-level
		// error), so transformStreamingResponse's own cleanup never runs for
		// it: release any staged response-id candidate here instead.
		this.releaseCodexResponseIdAttempt(attemptId);
		const turnStateTerminalAction = attemptId
			? this.turnStateCoordinator.finalizeAttempt({
					attemptId,
					stopReason: "error",
					responseTurnState: turnState,
					outputLineage: { kind: "none" },
				})
			: "unknown_attempt";
		writeCodexResponseTrace({
			requestId: requestId ?? "unknown",
			attemptId: attemptId ?? undefined,
			modelOut: finalModel ?? "unknown",
			turnStateHeaderPresent,
			turnState,
			turnStateTerminalAction,
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
		const sanitized = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
		transferResponseDrainTransport(response, sanitized);
		return sanitized;
	}

	private buildCustomToolCallPassthroughResponse(
		body: BodyInit | null,
		response: Response,
	): Response {
		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "text/event-stream");
		headers.set("x-better-ccflare-codex-response-format", "responses-api");
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	parseRateLimit(response: Response): RateLimitInfo {
		const now = Date.now();
		const maxVerifiedRecoveryTime = now + 8 * 24 * 60 * 60 * 1000;
		const isPlausibleRecoveryTime = (candidate: number): boolean =>
			Number.isSafeInteger(candidate) &&
			candidate > now &&
			candidate <= maxVerifiedRecoveryTime;
		const parseEpochSeconds = (value: string | null): number | undefined => {
			if (!value || !/^\d+$/.test(value)) return undefined;
			const seconds = Number(value);
			const candidate = seconds * 1000;
			return Number.isSafeInteger(seconds) && isPlausibleRecoveryTime(candidate)
				? candidate
				: undefined;
		};
		const parseDeltaSeconds = (value: string | null): number | undefined => {
			if (!value || !/^\d+$/.test(value)) return undefined;
			const seconds = Number(value);
			const candidate = now + seconds * 1000;
			return Number.isSafeInteger(seconds) &&
				seconds > 0 &&
				isPlausibleRecoveryTime(candidate)
				? candidate
				: undefined;
		};
		const parseRetryAfter = (value: string | null): number | undefined => {
			if (!value) return undefined;
			if (/^\d+$/.test(value)) {
				return parseDeltaSeconds(value);
			}
			const candidate = Date.parse(value);
			return isPlausibleRecoveryTime(candidate) ? candidate : undefined;
		};
		const parseFiniteNumber = (value: string | null): number | undefined => {
			if (!value || value.trim() === "") return undefined;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		};
		const exhaustedWindowResets: number[] = [];
		let hasIncompleteExhaustedWindow = false;
		for (const prefix of ["primary", "secondary"] as const) {
			const usedPercent = parseFiniteNumber(
				response.headers.get(`x-codex-${prefix}-used-percent`),
			);
			if (usedPercent === undefined || usedPercent < 100) continue;

			const windowMinutes = parseFiniteNumber(
				response.headers.get(`x-codex-${prefix}-window-minutes`),
			);
			const windowResetCandidates = [
				parseEpochSeconds(response.headers.get(`x-codex-${prefix}-reset-at`)),
				parseDeltaSeconds(
					response.headers.get(`x-codex-${prefix}-reset-after-seconds`),
				),
			].filter((value): value is number => value !== undefined);
			const windowReset =
				windowResetCandidates.length > 0
					? Math.max(...windowResetCandidates)
					: undefined;
			if (
				windowMinutes === undefined ||
				windowMinutes <= 0 ||
				windowReset === undefined
			) {
				hasIncompleteExhaustedWindow = true;
				continue;
			}
			exhaustedWindowResets.push(windowReset);
		}

		const retryAfterReset = parseRetryAfter(
			response.headers.get("retry-after"),
		);
		const directRateLimitReset = parseEpochSeconds(
			response.headers.get("x-ratelimit-reset"),
		);
		const codexUsageWindowResets = [
			parseEpochSeconds(response.headers.get("x-codex-primary-reset-at")),
			parseEpochSeconds(response.headers.get("x-codex-secondary-reset-at")),
			parseEpochSeconds(response.headers.get("x-codex-5h-reset-at")),
			parseEpochSeconds(response.headers.get("x-codex-7d-reset-at")),
		].filter((v): v is number => v !== undefined);

		if (response.status === 429) {
			// Codex usage-window resets are ordinary quota telemetry. They can be
			// present while the corresponding window is not exhausted, so ignore a
			// window reset unless its exact primary/secondary triple proves exhaustion.
			// Without a direct rate-limit header, every exhausted window must have a
			// complete future horizon before inferred recovery is trusted. With direct
			// evidence, complete exhausted-window horizons may extend (never shorten)
			// that lower bound; incomplete quota telemetry cannot invalidate it.
			const directResets = [retryAfterReset, directRateLimitReset].filter(
				(value): value is number => value !== undefined,
			);
			const resetCandidates =
				directResets.length > 0
					? [...directResets, ...exhaustedWindowResets]
					: hasIncompleteExhaustedWindow
						? []
						: exhaustedWindowResets;
			const resetTime =
				resetCandidates.length > 0 ? Math.max(...resetCandidates) : undefined;
			return {
				isRateLimited: true,
				resetTime,
				reason: resetTime === undefined ? undefined : "upstream_429_with_reset",
			};
		}

		// 529 (overloaded_error) is rate limiting too, but unlike 429 we do not
		// synthesize a resetTime when Codex doesn't send one. A missing resetTime
		// here is the signal proxy-operations.ts uses to attempt bounded in-place
		// retries before falling back to account cooldown; forcing a synthesized
		// resetTime would skip that retry path entirely.
		if (response.status === 529) {
			const resets = [
				retryAfterReset,
				directRateLimitReset,
				...codexUsageWindowResets,
			].filter((v): v is number => v !== undefined);
			const resetTime = resets.length > 0 ? Math.min(...resets) : undefined;
			return { isRateLimited: true, resetTime };
		}

		// Return reset time for DB tracking even on successful responses
		const resets = [
			retryAfterReset,
			directRateLimitReset,
			...codexUsageWindowResets,
		].filter((v): v is number => v !== undefined);
		const resetTime = resets.length > 0 ? Math.min(...resets) : undefined;
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

	// An account-specific model_mappings substitution is authoritative over the
	// Responses API's requested raw model. Family defaults merely select a
	// transport variant for a Claude alias, so a raw Responses model can refine
	// them when no explicit account policy applies.
	private mapModel(
		anthropicModel: string,
		account?: Account,
	): { model: string; isExplicitMapping: boolean } {
		// The force-account-model compatibility mode intentionally preserves the
		// client model verbatim. It must not look like an account mapping hit just
		// because the model happens to have a configured substitution.
		if (isForceAccountModelEnabled()) {
			return { model: anthropicModel, isExplicitMapping: false };
		}

		if (account) {
			const mapped = mapModelName(anthropicModel, account);
			if (mapped !== anthropicModel) {
				return { model: mapped, isExplicitMapping: true };
			}
		}

		return {
			model: resolveCodexRequestModel(anthropicModel, undefined),
			isExplicitMapping: false,
		};
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
	 * Derive a conservative WebSocket conversation identity from tool lineage.
	 *
	 * Claude Code can deliberately share one prompt_cache_key across a root and
	 * its sibling agents. Conversely, its history compaction can drop the first
	 * user item used by deriveConversationIdentity(). Tool call IDs are scoped to
	 * one logical conversation and survive the common prefix-drop compaction
	 * shape as either a function_call or function_call_output. Hashing the first
	 * surviving call ID with the validated session keeps ordinary follow-ups and
	 * compacted continuations together without exposing either value.
	 *
	 * Requests without a trustworthy tool-lineage anchor intentionally return
	 * null. WebSocket treatment must fail closed rather than widen to a shared
	 * session identity.
	 */
	private deriveWebSocketConversationIdentity(
		sessionId: string,
		input: readonly unknown[],
	): string | null {
		for (const item of input) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			if (
				record.type !== "function_call" &&
				record.type !== "function_call_output"
			) {
				continue;
			}
			const callId = record.call_id;
			if (
				typeof callId !== "string" ||
				callId.length === 0 ||
				callId.length > 512
			) {
				continue;
			}
			return createHash("sha256")
				.update(CODEX_WEBSOCKET_CONVERSATION_DOMAIN)
				.update(sessionId.toLowerCase())
				.update("\0")
				.update(callId)
				.digest("hex");
		}
		return null;
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
		tools: readonly CodexTool[] | undefined,
		physicalModel: string,
		endpoint: string,
		account?: Account,
		cacheLaneRescueSalt?: string,
		orchestrationResult?: {
			basis: OrchestrationAdmissionBasis | null;
			canonicalConversationIdentity: string | null;
		},
	): CodexPromptCacheKeyDecision {
		const ineligible: CodexPromptCacheKeyDecision = {
			key: null,
			assignment: null,
			assignmentSource: null,
			effectiveMode: null,
			cohortId: null,
			conversationIdentity: null,
			canonicalConversationIdentity: null,
			selectedConversationIdentity: null,
			continuityApplied: null,
			continuityBasis: "ineligible",
			webSocketConversationIdentity: null,
		};
		if (process.env[CODEX_PROMPT_CACHE_KEY_ENV] === "0") return ineligible;
		if (!isOpenAiPromptCacheEndpoint(account)) return ineligible;
		const sessionId = this.extractSessionId(body);
		if (!sessionId) return ineligible;

		const conversationIdentity =
			deriveConversationIdentity(sessionId, instructions, input) ?? null;
		const webSocketConversationIdentity =
			this.deriveWebSocketConversationIdentity(sessionId, input);
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
		const continuityPercent = readCodexCacheKeyContinuityPercent();
		const continuityTreatment =
			continuityPercent === 100 ||
			(continuityPercent > 0 &&
				deriveCodexCacheKeyContinuityBucket(sessionId) < continuityPercent);
		const canonicalConversationIdentity =
			orchestrationResult?.canonicalConversationIdentity ?? null;
		const continuityBasis =
			effectiveMode === "session"
				? "session"
				: orchestrationResult?.basis === "identity_match"
					? "identity_match"
					: orchestrationResult?.basis === "lineage_match"
						? "lineage_match"
						: orchestrationResult?.basis === "rejected"
							? "rejected"
							: "derived";
		const continuityApplied =
			effectiveMode === "conversation"
				? Boolean(continuityTreatment && canonicalConversationIdentity)
				: null;
		const selectedConversationIdentity =
			effectiveMode === "conversation" &&
			continuityTreatment &&
			canonicalConversationIdentity
				? canonicalConversationIdentity
				: conversationIdentity;
		const prefixShardPercent = readCodexCacheKeyPrefixShardPercent();
		const prefixShardTreatment =
			effectiveMode === "conversation" &&
			isCodexSubscriptionEndpoint(endpoint) &&
			(prefixShardPercent === 100 ||
				(prefixShardPercent > 0 &&
					conversationIdentity !== null &&
					deriveCodexCacheKeyPrefixShardBucket(conversationIdentity) <
						prefixShardPercent));
		const prefixShardSeed =
			canonicalConversationIdentity ?? conversationIdentity;
		const prefixShard = prefixShardSeed
			? deriveCodexCacheKeyPrefixShard(prefixShardSeed)
			: null;
		const prefixShardKey =
			prefixShardTreatment && prefixShard !== null
				? createHash("sha256")
						.update(CODEX_CACHE_KEY_PREFIX_SHARD_DOMAIN)
						.update(physicalModel)
						.update("\0")
						.update(instructions)
						.update("\0")
						.update(tools === undefined ? "<absent>" : JSON.stringify(tools))
						.update("\0")
						.update(String(prefixShard))
						.digest("hex")
				: null;
		let key =
			effectiveMode === "session"
				? `ccflare-session-${createHash("sha256")
						.update(sessionId)
						.digest("hex")
						.slice(0, 48)}`
				: (prefixShardKey ??
					(selectedConversationIdentity
						? `ccflare-convo-${selectedConversationIdentity.slice(0, 48)}`
						: null));
		if (key && cacheLaneRescueSalt) {
			key = `ccflare-rescue-${createHash("sha256")
				.update(CODEX_CACHE_LANE_RESCUE_DOMAIN)
				.update(key)
				.update("\0")
				.update(cacheLaneRescueSalt)
				.digest("hex")
				.slice(0, 48)}`;
		}

		return {
			key,
			assignment,
			assignmentSource: prefixShardKey
				? "prefix_shard"
				: explicitSessionOverride
					? "explicit_session_override"
					: "canary",
			effectiveMode: key ? effectiveMode : null,
			cohortId: createHash("sha256")
				.update(CODEX_CACHE_KEY_COHORT_DOMAIN)
				.update(sessionId)
				.digest("hex")
				.slice(0, 16),
			conversationIdentity,
			canonicalConversationIdentity,
			selectedConversationIdentity,
			continuityApplied,
			continuityBasis,
			webSocketConversationIdentity,
		};
	}

	private applyExplicitCacheBreakpoint(
		request: CodexRequest,
		cacheKeyDecision: CodexPromptCacheKeyDecision,
		account: Account | undefined,
		endpoint: string,
		sourceMessageCount: number,
		hasSourceSystemCacheMarker: boolean,
		rotatedCacheKeyAttempt: boolean,
	): CodexExplicitBreakpointDecision {
		const ineligible = (
			action: Extract<
				CodexExplicitBreakpointAction,
				| "skip_non_gpt56"
				| "skip_non_eligible_endpoint"
				| "skip_no_prompt_cache_key"
				| "skip_no_conversation"
			>,
		): CodexExplicitBreakpointDecision => ({
			canary: "ineligible",
			cohortId: null,
			action,
		});

		if (!/^gpt-5\.6(?:$|-)/i.test(request.model)) {
			return ineligible("skip_non_gpt56");
		}
		if (!normalizeCodexExplicitBreakpointEligibleEndpoint(endpoint)) {
			return ineligible("skip_non_eligible_endpoint");
		}
		if (!request.prompt_cache_key) {
			return ineligible("skip_no_prompt_cache_key");
		}
		const conversationIdentity = cacheKeyDecision.conversationIdentity;
		if (!conversationIdentity) {
			return ineligible("skip_no_conversation");
		}
		// cacheKeyDecision.cohortId is a bounded session-derived digest. Assigning
		// over it keeps one Claude chat (including its compacted history) in one arm;
		// conversationIdentity is still required for cache-key eligibility but can
		// change when compaction drops the earliest input item.
		const stableAssignmentIdentity = cacheKeyDecision.cohortId;
		if (!stableAssignmentIdentity) {
			return ineligible("skip_no_conversation");
		}

		const cohortId = createHash("sha256")
			.update(CODEX_EXPLICIT_BREAKPOINT_COHORT_DOMAIN)
			.update(stableAssignmentIdentity)
			.digest("hex")
			.slice(0, 16);
		const percent = readCodexExplicitCacheBreakpointPercent();
		const treatment =
			percent === 100 ||
			(percent > 0 &&
				deriveCodexExplicitBreakpointBucket(stableAssignmentIdentity) <
					percent);
		if (!treatment) {
			return {
				canary: "control",
				cohortId,
				action: "skip_percent_control",
			};
		}
		if (rotatedCacheKeyAttempt) {
			return {
				canary: "treatment",
				cohortId,
				action: "skip_rotated_cache_key_attempt",
			};
		}

		if (
			account?.id &&
			isCodexExplicitCacheBreakpointSuppressed(
				account.id,
				request.model,
				endpoint,
			)
		) {
			return {
				canary: "treatment",
				cohortId,
				action: "skip_known_unsupported",
			};
		}

		let firstUserText: CodexInputTextItem | undefined;
		let firstSourceMarkedText: CodexInputTextItem | undefined;
		for (const item of request.input) {
			if (!isCodexMessage(item) || item.role !== "user") continue;
			for (const content of item.content) {
				if (
					content.type !== "input_text" ||
					typeof content.text !== "string" ||
					content.text.trim().length === 0
				) {
					continue;
				}
				const sourceMessageIndex = content[SOURCE_MESSAGE_INDEX];
				// The default implicit policy already marks the latest message. Only
				// historical source text is stable enough to justify an extra billable
				// GPT-5.6 cache write.
				if (
					typeof sourceMessageIndex !== "number" ||
					sourceMessageIndex >= sourceMessageCount - 1
				) {
					continue;
				}
				firstUserText ??= content;
				if (content[SOURCE_CACHE_MARKED] === true) {
					firstSourceMarkedText ??= content;
				}
			}
		}

		const selected = firstSourceMarkedText ?? firstUserText;
		if (!selected) {
			return {
				canary: "treatment",
				cohortId,
				action: "skip_no_eligible_block",
			};
		}
		selected.prompt_cache_breakpoint = { mode: "explicit" };
		return {
			canary: "treatment",
			cohortId,
			action:
				firstSourceMarkedText || hasSourceSystemCacheMarker
					? "placed_source_marker"
					: "placed_first_user_text",
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
				serialized = JSON.stringify(block);
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
		sourceMessageIndex: number,
	): (
		| CodexMessage
		| CodexFunctionCallItem
		| CodexFunctionCallOutputItem
		| CodexReasoningItem
	)[] {
		const items: (
			| CodexMessage
			| CodexFunctionCallItem
			| CodexFunctionCallOutputItem
			| CodexReasoningItem
		)[] = [];

		// Codex API only accepts user/assistant/system roles.
		// Map developer (Codex CLI system instructions sent as a message role) to system.
		const role = (msg.role as string) === "developer" ? "system" : msg.role;

		if (typeof msg.content === "string") {
			const contentType = role === "assistant" ? "output_text" : "input_text";
			const contentItem = {
				type: contentType,
				text: msg.content,
			} as CodexContentItem;
			if (role === "user" && contentType === "input_text") {
				Object.defineProperty(contentItem, SOURCE_MESSAGE_INDEX, {
					value: sourceMessageIndex,
					enumerable: false,
				});
			}
			const textItem = {
				role,
				content: [contentItem],
			} as CodexMessage;
			items.push(textItem);
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
				const textItem = {
					type: contentType,
					text: block.text,
				} as CodexContentItem;
				if (role === "user" && contentType === "input_text") {
					Object.defineProperty(textItem, SOURCE_MESSAGE_INDEX, {
						value: sourceMessageIndex,
						enumerable: false,
					});
				}
				if (
					role === "user" &&
					contentType === "input_text" &&
					block.cache_control?.type === "ephemeral"
				) {
					Object.defineProperty(textItem, SOURCE_CACHE_MARKED, {
						value: true,
						enumerable: false,
					});
				}
				pendingText.push(textItem);
			} else if (
				block.type === "redacted_thinking" &&
				role === "assistant" &&
				getCodexReasoningRetention() &&
				typeof block.data === "string" &&
				block.data.startsWith(CODEX_REASONING_RETENTION_PREFIX)
			) {
				const separatorIndex = block.data.indexOf(
					".",
					CODEX_REASONING_RETENTION_PREFIX.length,
				);
				if (separatorIndex !== -1) {
					const reasoningId = block.data.slice(
						CODEX_REASONING_RETENTION_PREFIX.length,
						separatorIndex,
					);
					const encryptedContent = block.data.slice(separatorIndex + 1);
					// Older builds could mint bccfr1 blocks with an empty id. Drop those
					// legacy poison blocks so a live transcript cannot replay a guaranteed 400.
					if (
						CODEX_REASONING_ID_PATTERN.test(reasoningId) &&
						encryptedContent.length > 0
					) {
						flushText();
						items.push({
							type: "reasoning",
							id: reasoningId,
							summary: [],
							encrypted_content: encryptedContent,
						});
					}
				}
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

	private sanitizeToolUseInput(
		name: string,
		input: unknown,
		schema?: CodexToolSchemaInfo,
	): unknown {
		if (input === undefined) return {};
		if (input === null || typeof input !== "object" || Array.isArray(input)) {
			return input;
		}

		const sanitized: Record<string, unknown> = {
			...(input as Record<string, unknown>),
		};

		// Generic, schema-aware pass over top-level keys, ahead of the
		// per-tool cases below. GPT-family models routed through this
		// provider never omit optional tool parameters (verified incident:
		// EnterWorktree calls carrying `"name": ""` alongside `path`,
		// tripping "at most one of name or path"), so this normalizes that
		// shape back to what an Anthropic-native model would have sent.
		for (const [key, value] of Object.entries(sanitized)) {
			if (value === null) {
				delete sanitized[key];
				continue;
			}
			if (value === "" && schema) {
				const prop = schema.props.get(key);
				if (
					prop?.isString &&
					!prop.enumHasEmptyString &&
					!schema.required.has(key)
				) {
					delete sanitized[key];
				}
			}
			// value === "" with no schema (cache miss / unknown tool / schema
			// never registered): keep it. Never guess.
		}

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
		requestId?: string,
	): string {
		try {
			const input = JSON.parse(partialJson) as unknown;
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return partialJson;
			}
			return JSON.stringify(
				this.sanitizeToolUseInput(
					name,
					input,
					this.getToolSchemaInfo(requestId, name),
				),
			);
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
		const normalized = normalizeCodexResponseInputUsage(
			inputTokens,
			inputTokenDetails,
		);

		return {
			current_usage: {
				input_tokens: normalized.inputTokens,
				cache_read_input_tokens: normalized.cacheReadInputTokens,
				cache_creation_input_tokens: normalized.cacheCreationInputTokens,
			},
			context_window_size: contextWindowSize,
		};
	}

	private isSyntheticCountTokensRequest(url: string): boolean {
		return url === CODEX_SYNTHETIC_COUNT_TOKENS_URL;
	}

	private async transformModelsListResponse(
		response: Response,
	): Promise<Response> {
		if (!response.ok) {
			return response;
		}
		try {
			const raw = (await response.clone().json()) as {
				models?: Array<
					Record<string, unknown> & {
						slug?: string;
						visibility?: string;
					}
				>;
			};
			const data = (raw.models ?? [])
				.filter(
					(m) =>
						typeof m.slug === "string" &&
						m.slug.length > 0 &&
						(!m.visibility || m.visibility === "list"),
				)
				.map((m) => ({
					...m,
					id: m.slug as string,
					object: "model" as const,
					created: Math.floor(Date.now() / 1000),
					owned_by: "openai",
				}));
			return new Response(
				JSON.stringify({ object: "list", data, models: data }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (err) {
			log.warn(`Failed to transform Codex models response: ${err}`);
			// The upstream body was malformed JSON despite a 200 status — passing
			// the original response through would present it to the client as a
			// successful (if empty) model list. Surface it as a failure instead.
			return new Response(
				JSON.stringify({
					error: {
						type: "api_error",
						message: "Codex models response could not be parsed",
					},
				}),
				{
					status: 502,
					statusText: "Bad Gateway",
					headers: { "Content-Type": "application/json" },
				},
			);
		}
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
		cacheLaneRescueSalt?: string,
		endpoint = CODEX_DEFAULT_ENDPOINT,
		finalModel?: string,
		logicalModelFamily?: string | null,
		passthrough?: Record<string, unknown>,
	): CodexConversionResult {
		const { model: mappedModel, isExplicitMapping } = this.mapModel(
			body.model,
			account,
		);
		// A raw Responses model identifies a precise Codex variant that the
		// Anthropic family alias cannot. Explicit account mappings remain the
		// selection authority, and finalModel remains the route-selected physical
		// transport provenance when the proxy supplied one.
		const model =
			!isExplicitMapping &&
			typeof passthrough?.model === "string" &&
			passthrough.model.trim()
				? passthrough.model
				: mappedModel;
		const physicalModel = finalModel?.trim() || model;
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
			for (const item of this.convertMessage(msg, msgIndex)) {
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
		let orchestrationBasis: OrchestrationAdmissionBasis | null = null;
		let orchestrationCacheKeyResult: {
			basis: OrchestrationAdmissionBasis;
			canonicalConversationIdentity: string | null;
		} | null = null;
		let orchestrationDemotionObserved = false;
		let elapsedMsSinceRoot: number | null = null;
		if (!offersOrchestrationTools) {
			orchestrationAdmission = "no_orchestration_tools";
		} else if (isAttributedAgent) {
			// Attributed descendants (subagents) are never contenders in root
			// election: they must not claim an empty slot, must not extend an
			// existing root's continuity state, and must not observe or report a
			// demotion. Their current Agent/Task declarations are unconditionally
			// filtered below using only this admission tag -- no snapshot, no
			// derived conversation identity, no admit() call, no root recording.
			orchestrationAdmission = "attributed_descendant";
		} else if (process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV] === "0") {
			orchestrationAdmission = "disabled";
		} else {
			const sessionId = this.extractSessionId(body);
			if (!sessionId) {
				orchestrationAdmission = "no_session";
			} else {
				// Captured before electOrchestrationRoot() mutates the entry, so a
				// demotion below can still report how long the prior root was idle.
				const priorRootSnapshot = snapshotOrchestrationRoot(sessionId);
				const conversationId = deriveConversationIdentity(
					sessionId,
					finalInstructions,
					input,
				);
				if (!conversationId) {
					orchestrationAdmission = "no_conversation";
				} else {
					const electionResult = electOrchestrationRoot(
						sessionId,
						conversationId,
						finalInstructions,
						input,
					);
					orchestrationAdmission = electionResult.admission;
					orchestrationBasis = electionResult.basis;
					orchestrationCacheKeyResult = {
						basis: electionResult.basis,
						canonicalConversationIdentity:
							electionResult.canonicalConversationIdentity,
					};
					if (electionResult.admission === "non_root" && priorRootSnapshot) {
						// This session already had an elected root, and this turn was
						// rejected as an ordinary contender (categorical basis:
						// "rejected"): neither its derived identity nor its call_id
						// lineage matched. Diagnostic only, and privacy-safe: no raw
						// session id, instructions text, or call ids are ever logged,
						// only the request id and a domain-separated session digest.
						orchestrationDemotionObserved = true;
						elapsedMsSinceRoot = Date.now() - priorRootSnapshot.lastActiveAt;
						log.warn(
							`orchestration demotion observed: request=${requestId ?? "unknown"} session_digest=${this.hashSessionKey(body) ?? "none"} elapsed_ms_since_root=${elapsedMsSinceRoot} isAttributedAgent=${isAttributedAgent} basis=${electionResult.basis}`,
						);
					}
				}
			}
		}

		// Descendants are always filtered. For ordinary requests, only the elected
		// root retains current Agent and Task declarations. Historical calls and
		// results are already represented in input and remain untouched.
		const shouldFilterOrchestrationTools =
			orchestrationAdmission === "attributed_descendant" ||
			orchestrationAdmission === "non_root";
		const filteredToolNames = shouldFilterOrchestrationTools
			? (body.tools ?? [])
					.filter((tool) => orchestrationToolNames.has(tool.name))
					.map((tool) => tool.name)
			: [];
		let tools: CodexTool[] | undefined;
		if (body.tools) {
			const currentTools = shouldFilterOrchestrationTools
				? body.tools.filter((tool) => !orchestrationToolNames.has(tool.name))
				: body.tools;
			tools = currentTools.map((t) => ({
				type: "function" as const,
				name: t.name,
				description: t.description,
				parameters: sanitizeSchemaForOpenAI(t.input_schema) as
					| Record<string, unknown>
					| undefined,
			}));
		}

		const passthroughReasoning = passthrough?.reasoning as
			| AnthropicRequest["reasoning"]
			| undefined;
		const reasoningResolution = resolveAnthropicReasoningEffort(
			passthroughReasoning
				? { ...body, reasoning: passthroughReasoning }
				: body,
			{
				sourceModel: body.model,
				targetModel: physicalModel,
			},
		);
		if (reasoningResolution.downgrades.length > 0) {
			for (const downgrade of reasoningResolution.downgrades) {
				log.warn(
					`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
				);
			}
		}

		// Codex always requires streaming upstream; non-streaming clients are handled
		// on the response side via transformSseResponseToJson.
		const defaultReasoningEffort =
			logicalModelFamily === "fable" && isGpt56SolModel(physicalModel)
				? "xhigh"
				: "medium";
		const codexRequest: CodexRequest = {
			model: physicalModel,
			input,
			stream: true,
			store:
				typeof passthrough?.store === "boolean" ? passthrough.store : false,
			...(getCodexReasoningRetention()
				? { include: ["reasoning.encrypted_content"] }
				: {}),
			reasoning: {
				effort: reasoningResolution.effort ?? defaultReasoningEffort,
			},
		};

		const passthroughAdditionalTools = passthrough?.additional_tools;
		if (
			Array.isArray(passthroughAdditionalTools) &&
			passthroughAdditionalTools.length > 0
		) {
			// Responses Lite carries additional tool declarations as input items.
			// Preserve their position ahead of translated Anthropic conversation input.
			codexRequest.input.unshift(
				...(passthroughAdditionalTools as CodexRequest["input"]),
			);
		}

		codexRequest.instructions = finalInstructions;
		const cacheKeyDecision = this.derivePromptCacheKey(
			body,
			codexRequest.instructions,
			input,
			tools,
			codexRequest.model,
			endpoint,
			account,
			cacheLaneRescueSalt,
			orchestrationCacheKeyResult ?? undefined,
		);
		const originalCacheKey =
			typeof passthrough?.prompt_cache_key === "string"
				? passthrough.prompt_cache_key
				: undefined;
		if (originalCacheKey) {
			cacheKeyDecision.key = originalCacheKey;
		}
		if (cacheKeyDecision.key) {
			codexRequest.prompt_cache_key = cacheKeyDecision.key;
		}
		const explicitBreakpointDecision = this.applyExplicitCacheBreakpoint(
			codexRequest,
			cacheKeyDecision,
			account,
			endpoint,
			body.messages.length,
			Array.isArray(body.system) &&
				body.system.some((block) => block.cache_control?.type === "ephemeral"),
			Boolean(cacheLaneRescueSalt),
		);
		const explicitToolChoice = this.convertToolChoice(
			body.tool_choice,
			tools ?? [],
		);
		if (explicitToolChoice) {
			codexRequest.tool_choice = explicitToolChoice;
		} else if (tools?.length === 1 && tools[0].name === "StructuredOutput") {
			// Claude Code schema agents provide a StructuredOutput tool but do not set
			// Anthropic tool_choice. Native Claude reliably follows the hidden schema
			// instruction; Codex models often end_turn with text instead. Force the
			// function when this sentinel tool is the sole *current* tool remaining
			// after orchestration filtering above -- if it coexists with any other
			// current tool (e.g. Read), the model may still legitimately need that
			// other tool first, so tool_choice is intentionally left unset.
			codexRequest.tool_choice = {
				type: "function",
				name: "StructuredOutput",
			};
		}
		if (body.tool_choice?.disable_parallel_tool_use === true) {
			codexRequest.parallel_tool_calls = false;
		}
		if (passthrough?.parallel_tool_calls === false) {
			codexRequest.parallel_tool_calls = false;
		}
		const passthroughTools = passthrough?.tools;
		if (Array.isArray(passthroughTools) && passthroughTools.length > 0) {
			codexRequest.tools = passthroughTools as CodexTool[];
		} else if (tools && (body.tools?.length ?? 0) > 0) {
			codexRequest.tools = tools;
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
			reasoningEffortRequested: reasoningResolution.requestedEffort,
			reasoningEffortSource: reasoningResolution.source,
			cacheKeyDecision,
			explicitBreakpointDecision,
			orchestrationAdmission,
			orchestrationBasis,
			filteredToolNames,
			orchestrationDemotionObserved,
			elapsedMsSinceRoot,
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
		hosted = false,
		drainAbort?: AbortController,
	): Promise<Response> {
		const transformed = this.transformStreamingResponse(
			response,
			requestId,
			attemptId,
			finalModel,
			hosted,
			drainAbort,
		);
		const reader = transformed.body
			?.pipeThrough(new TextDecoderStream())
			.getReader();
		let messageStartPayload: Record<string, unknown> | null = null;
		let messageDeltaPayload: Record<string, unknown> | null = null;
		let errorPayload: Record<string, unknown> | null = null;
		const content: Array<Record<string, unknown>> = [];
		const textByIndex = new Map<number, string>();
		const redactedThinkingByIndex = new Map<
			number,
			{ type: "redacted_thinking"; data: string }
		>();
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
					} else if (
						block.type === "redacted_thinking" &&
						typeof block.data === "string"
					) {
						redactedThinkingByIndex.set(index, {
							type: "redacted_thinking",
							data: block.data,
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
					const parts = pending.split(/\r?\n/);
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
			const bodyStatus = this.httpStatusForAnthropicErrorPayload(errorPayload);
			const preserveTransportStatus = shouldPreserveCodexTransportStatus(
				response.status,
				bodyStatus.status,
			);
			const status = preserveTransportStatus
				? response.status
				: bodyStatus.status;
			const statusText = preserveTransportStatus
				? response.statusText || bodyStatus.statusText
				: bodyStatus.statusText;
			return new Response(JSON.stringify(errorPayload), {
				status,
				statusText,
				headers,
			});
		}

		const allIndices = new Set([
			...textByIndex.keys(),
			...redactedThinkingByIndex.keys(),
			...toolByIndex.keys(),
		]);
		for (const index of [...allIndices].sort((a, b) => a - b)) {
			const redactedThinking = redactedThinkingByIndex.get(index);
			if (redactedThinking !== undefined) {
				content.push(redactedThinking);
			}
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
					input: this.sanitizeToolUseInput(
						tool.name,
						input,
						this.getToolSchemaInfo(requestId, tool.name),
					),
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
		hosted = false,
		drainAbort?: AbortController,
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
			cacheCreationMeasurementAvailable: false,
			usageMeasurementAvailable: false,
			cacheMeasurementAvailable: false,
			contextWindow: null,
			functionCallBlocks: new Map(),
			functionCallBytesTotal: 0,
			sawToolUse: false,
			traceNewToolCalls: [],
			turnStateOutputCallFingerprints: [],
			turnStateOutputCallsInvalid: false,
			traceReasoningOutputItemCount: 0,
			traceReasoningEncryptedPresent: false,
			traceReasoningUnrepresentableIdSkipCount: 0,
			pendingReasoningBlocks: [],
			traceRequestId: requestId,
			traceAttemptId: attemptId,
			traceTurnStateHeaderPresent: response.headers.has(
				CODEX_TURN_STATE_HEADER,
			),
			traceTurnState: response.headers.get(CODEX_TURN_STATE_HEADER),
			turnStateTerminalAction: null,
			finalizeTurnState: (stopReason, outputLineage) =>
				hosted
					? "ineligible"
					: attemptId
						? this.turnStateCoordinator.finalizeAttempt({
								attemptId,
								stopReason,
								responseTurnState: response.headers.get(
									CODEX_TURN_STATE_HEADER,
								),
								outputLineage,
							})
						: "unknown_attempt",
			traceResponseId: null,
			lastProgressPingAt: null,
			terminalTraceWritten: false,
		};

		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "text/event-stream");

		const upstreamReader = response.body?.getReader();
		const streamLiveness = new CodexStreamLiveness(this.streamLivenessOptions);
		let upstreamDrainStarted = false;
		const drainUpstream = async (): Promise<void> => {
			if (!upstreamReader) return;
			await drainReaderWithDeadline(upstreamReader, {
				deadlineMs: this.streamDrainDeadlineMs,
				drainAbort,
				beforeDrain: () => streamLiveness.settlePendingReadForCleanup(),
				swallowErrors: true,
			});
		};
		const cancelUpstreamOnce = (_reason: unknown): void => {
			if (upstreamDrainStarted || !upstreamReader) return;
			upstreamDrainStarted = true;
			void drainUpstream().catch(() => undefined);
		};
		/**
		 * KTD7 move-only handoff: once the response-id tail validator has taken
		 * over `upstreamReader`/`drainAbort`, this stream's own cancel/catch/
		 * finally paths must never read, release, drain, or abort that
		 * transport again (see `upstreamDrainStarted` being force-set at
		 * handoff, which makes `cancelUpstreamOnce` a permanent no-op). A
		 * downstream cancel arriving after handoff is instead routed to the
		 * validator itself, which owns the only remaining abort capability and
		 * reports "cancellation" as one of its distinct outcomes.
		 */
		let tailValidatorCancel: ((reason: unknown) => void) | null = null;
		/**
		 * Set exactly once, synchronously, at the KTD7 move-only handoff site
		 * below. Gates the `finally` block's own
		 * `releaseCodexResponseIdAttempt` call: once true, the detached tail
		 * validator owns that single-choke-point call instead (via its own
		 * `commitCodexResponseIdCheckpoint`/`releaseCodexResponseIdAttempt`
		 * resolution), so `finally` must not race it by releasing the still-
		 * pending candidate out from under an in-flight validation.
		 */
		let responseIdTailHandoff = false;
		let downstreamController: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const pullWaiters = new Set<() => void>();
		const releasePullWaiters = () => {
			const waiters = [...pullWaiters];
			pullWaiters.clear();
			for (const waiter of waiters) waiter();
		};
		const awaitDownstreamCapacity = async (signal?: AbortSignal) => {
			while (
				!cancelled &&
				!signal?.aborted &&
				(downstreamController.desiredSize ?? 1) <= 0
			) {
				await new Promise<void>((resolve) => {
					let released = false;
					const release = () => {
						if (released) return;
						released = true;
						pullWaiters.delete(release);
						signal?.removeEventListener("abort", release);
						resolve();
					};
					pullWaiters.add(release);
					signal?.addEventListener("abort", release, { once: true });
					if (signal?.aborted) release();
				});
			}
		};
		const heartbeatGate = {
			isReady: () => !cancelled && (downstreamController.desiredSize ?? 1) > 0,
			waitUntilReady: (signal: AbortSignal) => awaitDownstreamCapacity(signal),
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
			cancel(reason) {
				cancelled = true;
				streamLiveness.stop();
				const message =
					typeof reason === "string" && reason
						? reason
						: "Downstream response was cancelled";
				writeTerminalTrace({
					type: "downstream_cancelled",
					message,
				});
				releasePullWaiters();
				if (tailValidatorCancel) {
					// Transport ownership already moved to the tail validator;
					// let it abort/release itself as its own "cancellation"
					// outcome instead of racing it here.
					tailValidatorCancel(reason);
					return;
				}
				if (drainAbort && !drainAbort.signal.aborted) {
					drainAbort.abort(
						reason instanceof Error ? reason : new Error(message),
					);
				}
				cancelUpstreamOnce(reason);
			},
		});
		const encoder = new TextEncoder();
		const sseFrameBuffer = new SseFrameBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});

		const writeSSE = async (
			event: string,
			data: unknown,
			canEnqueue?: () => boolean,
		): Promise<void> => {
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
			if (canEnqueue && !canEnqueue()) return;
			const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			downstreamController.enqueue(encoder.encode(line));
			streamLiveness.recordDownstreamWrite();
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
					const outcome = await streamLiveness.next(
						upstreamReader,
						heartbeatGate,
					);
					if (outcome.type === "stopped") break;
					if (outcome.type === "heartbeat_due") {
						if (state.hasSentTerminalEvents) break;
						await writeSSE(
							"ping",
							{ type: "ping" },
							() =>
								!state.hasSentTerminalEvents &&
								streamLiveness.canEmitHeartbeat(),
						);
						continue;
					}
					if (outcome.type === "raw_silence_timeout") {
						const timeoutError = {
							type: "upstream_stream_timeout",
							message:
								"Codex upstream timed out while waiting for response data.",
						};
						// Claim this terminal path before any backpressured writes. A
						// downstream-cancel or pending-read rejection during teardown
						// must not replace it with a second terminal trace/error.
						writeCodexStreamTerminalTrace(state, "error", timeoutError);
						cancelUpstreamOnce(new Error(timeoutError.message));
						await this.closeOpenBlockAndWriteError(
							state,
							writeSSE,
							ensureMessageStart,
							{
								type: "error",
								error: {
									type: "api_error",
									message: timeoutError.message,
								},
							},
						);
						return;
					}
					if (outcome.type === "upstream_error") {
						throw outcome.error;
					}

					const { value, done } = outcome.result;
					if (done) break;

					// Frame boundary detection and cap enforcement live in
					// SseFrameBuffer (CRLF-tolerant, bounds both a single oversized
					// frame and an unterminated tail). It may throw a
					// StreamResourceLimitError (SseLimitError), which is handled by
					// the dedicated branch in the catch below.
					const frames = sseFrameBuffer.push(value);

					// Process complete SSE events extracted from this chunk
					for (const eventText of frames) {
						if (state.hasSentTerminalEvents) {
							// KTD7 same-chunk tail check: the terminal event already
							// ran (from an earlier frame in this same chunk). At most
							// one trailing "[DONE]" is expected; any other data-bearing
							// frame here -- including a duplicate "[DONE]" -- means
							// "exactly one valid completed response ... no other
							// data-bearing frame" no longer holds, so disqualify the
							// staged response-id candidate. This only covers a
							// trailing frame observed in THIS chunk; one arriving on a
							// later read is instead caught by
							// runCodexResponseIdTailValidator after the move-only
							// handoff below (see its own doc comment).
							const { dataLine: tailDataLine } =
								findCodexSseFrameLines(eventText);
							if (tailDataLine) {
								const tailDataStr = tailDataLine.slice("data:".length).trim();
								if (
									tailDataStr === "[DONE]" &&
									!state.responseIdDoneSeenAfterTerminal
								) {
									state.responseIdDoneSeenAfterTerminal = true;
								} else {
									state.responseIdTailTainted = true;
								}
							}
							continue;
						}

						const { eventLine, dataLine } = findCodexSseFrameLines(eventText);

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

					if (state.hasSentTerminalEvents) {
						// KTD7: promote/discard only after the whole chunk containing
						// the terminal event has been scanned for a same-chunk tail
						// taint above -- never from inside handleCodexEvent itself,
						// which cannot see frames later in the same `frames` array.
						const handoffAttemptId = state.traceAttemptId;
						const handoffEligible =
							!state.responseIdTailTainted &&
							!!handoffAttemptId &&
							!!state.responseIdTerminal &&
							this.pendingResponseIdByAttempt.has(handoffAttemptId) &&
							!!upstreamReader;
						if (handoffEligible && upstreamReader) {
							// KTD7 move-only handoff: from this point on,
							// `upstreamDrainStarted = true` makes
							// `cancelUpstreamOnce` and the `finally` block's own
							// reader release/settlement permanent no-ops for this
							// transport -- runCodexResponseIdTailValidator is the
							// sole remaining owner of the reader, sseFrameBuffer's
							// carried partial bytes, and drainAbort. Launched
							// detached (never awaited): the client-facing stream
							// still closes at the current completion boundary via
							// the unconditional `downstreamController.close()`
							// below, not on validator completion.
							upstreamDrainStarted = true;
							responseIdTailHandoff = true;
							streamLiveness.stop();
							const tailAbort = new AbortController();
							tailValidatorCancel = (reason) => {
								if (!tailAbort.signal.aborted) {
									tailAbort.abort(
										reason instanceof Error
											? reason
											: new Error(String(reason)),
									);
								}
							};
							void this.runCodexResponseIdTailValidator({
								state,
								reader: upstreamReader,
								sseFrameBuffer,
								drainAbort,
								deadlineMs: this.streamDrainDeadlineMs,
								cancelSignal: tailAbort.signal,
							});
						} else {
							// Handoff not eligible (turn-state-owned attempt,
							// already same-chunk-tainted, no pending candidate, or
							// no reader): fall back to the existing cleanup path
							// unchanged. commitCodexResponseIdCheckpoint is a
							// no-op whenever there is nothing to promote/discard.
							this.commitCodexResponseIdCheckpoint(state);
							streamLiveness.stop();
							cancelUpstreamOnce("Codex terminal response received");
						}
						break;
					}
				}

				if (cancelled) return;
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
					if (error instanceof StreamResourceLimitError) {
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
				cancelUpstreamOnce(error);
			} finally {
				streamLiveness.stop();
				if (!upstreamDrainStarted) {
					await streamLiveness.settlePendingReadForCleanup();
					upstreamReader?.releaseLock();
				}
				if (!cancelled) downstreamController.close();
				// KTD13: single choke point for every non-promoted exit from this
				// attempt's lifecycle (response.incomplete, error, cancellation,
				// abrupt EOF). Idempotent -- a no-op when
				// commitCodexResponseIdCheckpoint already consumed the pending
				// candidate on the clean response.completed path above. Skipped
				// entirely once the KTD7 tail validator has taken ownership of
				// this attempt's candidate (responseIdTailHandoff): the
				// validator's own resolveOnce is that attempt's single choke
				// point from here on, and this call running concurrently would
				// race it, releasing (or double-releasing) a charge the
				// validator may still promote.
				if (!responseIdTailHandoff) {
					this.releaseCodexResponseIdAttempt(state.traceAttemptId ?? null);
				}
			}
		};

		void processEvents().catch((error) => {
			log.error("Unhandled Codex SSE processing failure:", error);
		});

		const transformed = new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
		transferResponseDrainTransport(response, transformed);
		return transformed;
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
		if (isContextOverflow) {
			type = "invalid_request_error";
		}
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
			case "response.in_progress": {
				// Exact allowlist: this is known, nonterminal Codex protocol activity.
				// Translate it to a canonical Anthropic keepalive instead of exposing
				// the raw Responses event or manufacturing semantic content. Pings are
				// deliberately outside codexEventCommitsOutput(), so the absolute
				// meaningful-content deadline and no-replay boundary remain unchanged.
				if (state.hasSentTerminalEvents) break;
				const now = Date.now();
				if (
					state.lastProgressPingAt !== null &&
					now >= state.lastProgressPingAt &&
					now - state.lastProgressPingAt < CODEX_PROGRESS_PING_MIN_INTERVAL_MS
				) {
					break;
				}
				state.lastProgressPingAt = now;
				await writeSSE("ping", { type: "ping" });
				break;
			}

			case "response.created": {
				const resp = data.response as Record<string, unknown> | undefined;
				const usage = resp?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_write_tokens?: number;
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
					const normalized = normalizeCodexResponseInputUsage(
						usage.input_tokens,
						usage.input_tokens_details,
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
					state.cacheCreationInputTokens = normalized.cacheCreationInputTokens;
					state.cacheCreationMeasurementAvailable =
						normalized.cacheCreationMeasurementAvailable;
				}
				const respId =
					typeof resp?.id === "string" && resp.id ? resp.id : state.messageId;
				state.messageId = respId;
				if (typeof resp?.id === "string" && resp.id) {
					state.traceResponseId = resp.id;
				}
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
					if (outputIndex === undefined) {
						// Untracked: without an index this call can never be paired with
						// its done event, so its fingerprint would be silently missing
						// from the lineage.
						state.turnStateOutputCallsInvalid = true;
					}
					if (outputIndex !== undefined) {
						const callIdFingerprint = fingerprintCodexTurnStateCallId(callId);
						if (!callIdFingerprint) {
							state.turnStateOutputCallsInvalid = true;
						}
						if (state.functionCallBlocks.has(outputIndex)) {
							// A reused index overwrites the buffer still open under it, so
							// one of the two calls can never contribute its fingerprint.
							state.turnStateOutputCallsInvalid = true;
						}
						state.functionCallBlocks.set(outputIndex, {
							contentBlockIndex: blockIdx,
							name,
							callIdFingerprint,
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
						if (buffer.bytes > TOOL_ARGS_PER_CALL_BYTE_CAP) {
							throw new StreamResourceLimitError(
								`Tool call arguments for output_index ${outputIndex} totaled ${buffer.bytes} bytes, exceeding the ${TOOL_ARGS_PER_CALL_BYTE_CAP} byte cap`,
								"tool_arguments_per_call",
								TOOL_ARGS_PER_CALL_BYTE_CAP,
								buffer.bytes,
							);
						}
						// Aggregate cap: guards many concurrently open tool calls that
						// each individually stay under the per-call cap but together
						// still grow the buffered byte total without bound.
						if (state.functionCallBytesTotal > TOOL_ARGS_TOTAL_BYTE_CAP) {
							throw new StreamResourceLimitError(
								`Aggregate tool call arguments totaled ${state.functionCallBytesTotal} bytes, exceeding the ${TOOL_ARGS_TOTAL_BYTE_CAP} byte cap`,
								"tool_arguments_total",
								TOOL_ARGS_TOTAL_BYTE_CAP,
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
				const encryptedReasoning = item?.encrypted_content;

				if (itemType === "reasoning") {
					state.traceReasoningOutputItemCount++;
					if (
						typeof encryptedReasoning === "string" &&
						encryptedReasoning.length > 0
					) {
						state.traceReasoningEncryptedPresent = true;
					}
				}

				if (itemType === "function_call") {
					const outputIndex = data.output_index as number | undefined;
					const buffer =
						outputIndex !== undefined
							? state.functionCallBlocks.get(outputIndex)
							: undefined;
					if (!buffer) {
						// Completed without a matching added event, so this call's
						// fingerprint was never collected and the lineage cannot be an
						// exact record of the turn.
						state.turnStateOutputCallsInvalid = true;
					}
					if (buffer) {
						// Pairing is by output index alone, so the completion has to be
						// checked against the call the start announced. Upstream completing
						// a different call at the same index would otherwise record the
						// started id -- the one the client was handed -- and a continuation
						// carrying it would match a lineage minted for another call set.
						const doneCallIdFingerprint = fingerprintCodexTurnStateCallId(
							item?.call_id,
						);
						if (
							!doneCallIdFingerprint ||
							doneCallIdFingerprint !== buffer.callIdFingerprint
						) {
							state.turnStateOutputCallsInvalid = true;
						}
						const partialJson = this.sanitizeToolUsePartialJson(
							buffer.name,
							buffer.arguments.join(""),
							state.traceRequestId,
						);
						state.traceNewToolCalls.push({
							name: buffer.name,
							arg_preview: partialJson.slice(0, 120),
						});
						if (buffer.callIdFingerprint) {
							state.turnStateOutputCallFingerprints.push(
								buffer.callIdFingerprint,
							);
						} else {
							state.turnStateOutputCallsInvalid = true;
						}
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
						if (
							state.functionCallBlocks.size === 0 &&
							!state.hasSentContentBlockStart &&
							state.pendingReasoningBlocks.length > 0
						) {
							for (const pendingData of state.pendingReasoningBlocks) {
								const pendingIndex = state.contentBlockIndex;
								await writeSSE("content_block_start", {
									type: "content_block_start",
									index: pendingIndex,
									content_block: {
										type: "redacted_thinking",
										data: pendingData,
									},
								});
								await writeSSE("content_block_stop", {
									type: "content_block_stop",
									index: pendingIndex,
								});
								state.contentBlockIndex++;
							}
							state.pendingReasoningBlocks = [];
						}
					}
					break;
				}

				if (
					itemType === "reasoning" &&
					getCodexReasoningRetention() &&
					typeof encryptedReasoning === "string" &&
					encryptedReasoning.length > 0
				) {
					const rawReasoningId = typeof item?.id === "string" ? item.id : "";
					if (CODEX_REASONING_ID_PATTERN.test(rawReasoningId)) {
						await ensureMessageStart();
						const reasoningData = `${CODEX_REASONING_RETENTION_PREFIX}${rawReasoningId}.${encryptedReasoning}`;

						if (
							state.functionCallBlocks.size > 0 ||
							state.hasSentContentBlockStart
						) {
							// ANY still-open block (streaming tool call or live text) defers
							// emission: closing a live text block here would orphan its later
							// deltas at an index with no content_block_start. Flushed after
							// the owning output item closes, or at stream end.
							state.pendingReasoningBlocks.push(reasoningData);
							break;
						}

						const reasoningBlockIndex = state.contentBlockIndex;
						await writeSSE("content_block_start", {
							type: "content_block_start",
							index: reasoningBlockIndex,
							content_block: {
								type: "redacted_thinking",
								data: reasoningData,
							},
						});
						state.hasSentContentBlockStart = true;
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: reasoningBlockIndex,
						});
						state.contentBlockIndex++;
						state.hasSentContentBlockStart = false;
						break;
					}
					// An encrypted item without a representable id cannot be replayed,
					// so nothing is minted. Do NOT fall through to the generic close
					// below: a reasoning item never owns the open content block, and
					// closing someone else's block here orphans its later deltas at an
					// index with no content_block_start (the interleaving bug fixed for
					// minted blocks in PR #139, on the skip path). The owning output
					// item's own `done` closes it.
					state.traceReasoningUnrepresentableIdSkipCount++;
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
				if (
					state.functionCallBlocks.size === 0 &&
					state.pendingReasoningBlocks.length > 0
				) {
					for (const pendingData of state.pendingReasoningBlocks) {
						const pendingIndex = state.contentBlockIndex;
						await writeSSE("content_block_start", {
							type: "content_block_start",
							index: pendingIndex,
							content_block: {
								type: "redacted_thinking",
								data: pendingData,
							},
						});
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: pendingIndex,
						});
						state.contentBlockIndex++;
					}
					state.pendingReasoningBlocks = [];
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
								cache_write_tokens?: number;
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
					const normalized = normalizeCodexResponseInputUsage(
						usage.input_tokens,
						details,
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
					state.cacheCreationInputTokens = normalized.cacheCreationInputTokens;
					state.cacheCreationMeasurementAvailable =
						normalized.cacheCreationMeasurementAvailable;
				}
				if (typeof response?.id === "string" && response.id) {
					state.traceResponseId = response.id;
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
								cache_write_tokens?: number;
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
				const normalizedInput = normalizeCodexResponseInputUsage(
					usage?.input_tokens,
					inputTokenDetails,
				);

				state.totalInputTokens = normalizedInput.totalInputTokens;
				state.inputTokens = normalizedInput.inputTokens;
				state.outputTokens =
					typeof usage?.output_tokens === "number" &&
					Number.isFinite(usage.output_tokens) &&
					usage.output_tokens >= 0
						? usage.output_tokens
						: state.outputTokens;
				state.cacheReadInputTokens = normalizedInput.cacheReadInputTokens;
				state.cacheCreationInputTokens =
					normalizedInput.cacheCreationInputTokens;
				state.cacheCreationMeasurementAvailable =
					normalizedInput.cacheCreationMeasurementAvailable;
				if (typeof resp?.id === "string" && resp.id) {
					state.traceResponseId = resp.id;
				}
				// KTD7: stage the terminal checkpoint candidate from data this
				// event already carries in memory. "response.incomplete" never
				// stages one -- its output is not a trustworthy replay tail --
				// so commitCodexResponseIdCheckpoint below is a no-op for that
				// path (state.responseIdTerminal stays null).
				if (
					eventName === "response.completed" &&
					typeof resp?.id === "string" &&
					resp.id &&
					Array.isArray(resp.output)
				) {
					state.responseIdTerminal = {
						responseId: resp.id,
						output: resp.output,
					};
				}
				state.contextWindow = this.extractContextWindow(resp, usage);
				// Close any lingering content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.hasSentContentBlockStart = false;
					state.contentBlockIndex++;
				}
				// Flush reasoning deferred behind a tool block whose done never
				// arrived (truncated stream): retention must not lose the payload.
				for (const pendingData of state.pendingReasoningBlocks) {
					const pendingIndex = state.contentBlockIndex;
					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: pendingIndex,
						content_block: {
							type: "redacted_thinking",
							data: pendingData,
						},
					});
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: pendingIndex,
					});
					state.contentBlockIndex++;
				}
				state.pendingReasoningBlocks = [];

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

				// Commit turn state only once both terminal frames are enqueued.
				// `writeCodexStreamTerminalTrace` finalizes the coordinator entry,
				// so running it first would capture or advance a turn whose response
				// the client never receives: a cancel or enqueue failure between the
				// two awaits would leave the next request replaying a token for a
				// turn that did not complete. If either write throws, the cancel
				// callback and the stream catch block finalize as `error` instead,
				// which never mutates turn state.
				await writeSSE("message_delta", messageDelta);
				await writeSSE("message_stop", { type: "message_stop" });
				state.hasSentTerminalEvents = true;
				writeCodexStreamTerminalTrace(state, messageDelta.delta.stop_reason);
				// KTD7: promotion/discard is NOT done here. `processEvents`'s frame
				// loop must first finish scanning the rest of the current chunk for
				// a same-chunk trailing frame (this function cannot see frames
				// later in that same `frames` array) before calling
				// `commitCodexResponseIdCheckpoint`. Both terminal SSE frames are
				// already enqueued to the client at this point regardless, so
				// deferring the commit cannot delay or interfere with client
				// delivery.
				break;
			}
			default:
				// Ignore unknown events
				break;
		}
	}
}
