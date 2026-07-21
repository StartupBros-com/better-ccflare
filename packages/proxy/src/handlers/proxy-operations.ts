import {
	getInPlaceRetryDrainTimeoutMs,
	getModelFamily,
	getModelList,
	getOverloadRetryConfig,
	isOfficialXaiEndpoint,
	logError,
	ProviderError,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { withSanitizedProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { stripCacheControlFromOpenAIRequest } from "@better-ccflare/openai-formats";
import {
	decideContextAdmission,
	getProvider,
	isAnthropicExtraUsageExhausted,
	isAnthropicOutOfCredits,
	isCodexSubscriptionEndpoint,
	resolveCodexEndpoint,
	resolveCodexRequestModel,
	resolveModelContextCapability,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import type { AnthropicPreCommitRescueRouteContext } from "../anthropic-precommit-rescue";
import {
	AnthropicPreCommitAbortedError,
	AnthropicPreCommitStallError,
	gateAnthropicSsePreCommit,
	getAnthropicStreamRuntimeConfig,
	isDownstreamAnthropicMessagesSse,
	isNativeAnthropicMessagesSse,
} from "../anthropic-semantic-preflight";
import {
	CACHE_REPLAY_MODEL_HEADER,
	hasCacheControlHintInJsonText,
	stageCacheBodyForTransportAttempt,
	stripCacheControlFromReplayBody,
} from "../cache-transport-staging";

export type {
	CacheBodyStagingAction,
	CacheBodyStagingInput,
} from "../cache-transport-staging";
export {
	applyCacheBodyStagingPolicy,
	getCacheBodyStagingAction,
} from "../cache-transport-staging";

import {
	getPreTransportDeadlineConfig,
	PreTransportPhaseTimeoutError,
	runWithPreTransportDeadline,
} from "../pre-transport-deadline";
import { RequestBodyContext } from "../request-body-context";
import {
	forwardToClient,
	handleAnthropicSseRateLimit,
} from "../response-handler";
import {
	recordServedAccount,
	sessionIdForObservation,
} from "../session-account-observer";
import { combineChunks } from "../stream-tee";
import { isModelRewrite } from "../worker-messages";
import { GUARD_REQUEST_ID_HEADER } from "./internal-transport-headers";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import {
	classifyPreByte429,
	getAnthropicRateLimitResetAt,
	recordRequestRateLimitOutcome,
} from "./rate-limit-scope";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import type { RoutingAttemptLedger } from "./routing-attempt-ledger";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-better-ccflare-keepalive") ||
		!!headers.get("x-better-ccflare-auto-refresh")
	);
}

const SYNTHETIC_RESPONSE_HEADER = "x-better-ccflare-synthetic-response";
const SYNTHETIC_STATUS_HEADER = "x-better-ccflare-synthetic-status";
const SYNTHETIC_RESPONSE_URL_PREFIX = "https://better-ccflare.local/";
const INTERNAL_TRANSPORT_HEADERS = [
	GUARD_REQUEST_ID_HEADER,
	"x-better-ccflare-request-id",
	"x-better-ccflare-attempt-id",
	"x-better-ccflare-attempt-ordinal",
	"x-better-ccflare-attempt-cause",
	"x-better-ccflare-final-model",
	"x-better-ccflare-pacing-canary",
	"x-better-ccflare-pacing-cohort-id",
	"x-better-ccflare-pacing-action",
	"x-better-ccflare-request-stream",
	"x-better-ccflare-attributed-agent",
	CACHE_REPLAY_MODEL_HEADER,
] as const;
const ANTHROPIC_BILLING_HEADER = "x-anthropic-billing-header";
const CODEX_CACHE_LANE_RESCUE_RESERVE_MAX_MS = 30_000;
const CODEX_CACHE_LANE_RESCUE_RESERVE_DIVISOR = 4;
const TEST_CONTEXT_WINDOW_ENV =
	"CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW";

function getCodexCacheLaneRescueReserveMs(candidateBudgetMs: number): number {
	if (!Number.isFinite(candidateBudgetMs) || candidateBudgetMs <= 0) return 0;
	return Math.min(
		CODEX_CACHE_LANE_RESCUE_RESERVE_MAX_MS,
		Math.floor(candidateBudgetMs / CODEX_CACHE_LANE_RESCUE_RESERVE_DIVISOR),
	);
}
// Cap on how much of a final-candidate rate-limit/capacity response body we
// buffer before running provider classification (processProxyResponse). Some
// providers' classification reads the body without a size cap of their own
// (e.g. ZaiProvider.parseRateLimitFromBody calls clone.json() unconditionally),
// so this cap is enforced generically here rather than per-provider. A body
// at or under the cap is preserved byte-for-byte; a larger body is replaced
// with a headers-only response so classification proceeds on status/headers
// alone. Either way the ORIGINAL (untouched) response is what actually gets
// forwarded to the client -- this only bounds the *classification* read.
const MAX_FINAL_CANDIDATE_CLASSIFICATION_BODY_BYTES = 64 * 1024;

type RawAttemptFailureScope = "not-classified" | "account" | "model" | "family";

interface RawAttemptFailureClassification {
	readonly scope: RawAttemptFailureScope;
	readonly attemptedModel: string | null;
	readonly family: string | null;
	/** Stop this account attempt even when the evidence itself is model-scoped. */
	readonly stopAccountAttempt: boolean;
}

function getTestContextWindowOverride(): number | undefined {
	if (process.env.NODE_ENV !== "test") return undefined;
	const value = Number(process.env[TEST_CONTEXT_WINDOW_ENV]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface ContextAdmissionTracker {
	inputTokens: number;
	requestedMaxOutputTokens: number;
	rejectedCount: number;
	/** Safe limit and occupied total are always retained from the same rejection. */
	largestSafeLimit: number;
	terminalOccupiedTokens: number;
	attemptedCount: number;
	nonCapacitySkipCount: number;
}

/**
 * Request-orchestrator boundary for implicit account-local model fallbacks.
 * The global executor can defer a cross-family fallback, or any fallback that
 * cannot be proven same-family, until every selected requested-family route
 * has run. A deferred route is later re-entered with implicit fallbacks
 * disabled so one planned candidate cannot jump ahead of the remaining queue.
 */
export interface ModelFallbackExecutionPolicy {
	/** Immutable ID of the exact route candidate being executed. */
	readonly routeCandidateId: string;
	/** Request-scoped Anthropic downstream rescue; absent for ordinary routing. */
	readonly anthropicPreCommitRescue?: AnthropicPreCommitRescueRouteContext;
	readonly deferImplicitFallback?: (
		model: string,
		fallbackRank: number,
	) => void;
	readonly implicitFallbacksEnabled?: boolean;
	/** A planned non-final candidate must not terminate the global route queue. */
	readonly forwardModelUnavailableResponse?: boolean;
	/**
	 * Request-semantic finality is independent of response forwarding. Evaluate
	 * immediately before each transport/gate because deferred work may be
	 * discovered while proxyWithAccount is already running.
	 */
	readonly isFinalSemanticAttempt?: () => boolean;
}

export function createContextAdmissionTracker(
	inputTokens: number,
	requestedMaxOutputTokens: unknown,
): ContextAdmissionTracker {
	const sanitizedRequestedMaxOutputTokens =
		typeof requestedMaxOutputTokens === "number" &&
		Number.isFinite(requestedMaxOutputTokens)
			? Math.max(0, Math.floor(requestedMaxOutputTokens))
			: 0;
	return {
		inputTokens,
		requestedMaxOutputTokens: sanitizedRequestedMaxOutputTokens,
		rejectedCount: 0,
		largestSafeLimit: 0,
		terminalOccupiedTokens: inputTokens + sanitizedRequestedMaxOutputTokens,
		attemptedCount: 0,
		nonCapacitySkipCount: 0,
	};
}

export function admitConcreteCodexModel(
	account: Account,
	model: string,
	tracker?: ContextAdmissionTracker,
): boolean {
	if (
		process.env.CCFLARE_CONTEXT_ADMISSION !== "1" ||
		account.provider !== "codex" ||
		!tracker
	) {
		return true;
	}
	const capability = resolveModelContextCapability("codex", model);
	const effectiveContextWindow =
		getTestContextWindowOverride() ?? capability?.effectiveContextWindow;
	if (!effectiveContextWindow) {
		log.debug("Codex context admission capacity unknown, failing open", {
			accountId: account.id,
			model,
			outcome: "unknown",
		});
		return true;
	}
	const resolvedEndpoint = resolveCodexEndpoint(
		account.custom_endpoint,
		account.name,
	);
	// Match CodexProvider.transformRequestBody's concrete wire contract. The
	// ChatGPT subscription endpoint deletes max_output_tokens; API-compatible
	// custom endpoints retain the sanitized Anthropic max_tokens value.
	const outputReserveTokens = isCodexSubscriptionEndpoint(resolvedEndpoint)
		? 0
		: tracker.requestedMaxOutputTokens;
	const decision = decideContextAdmission({
		inputTokens: tracker.inputTokens,
		effectiveContextWindow,
		requestedMaxOutputTokens: outputReserveTokens,
		safetyReserveTokens: 0,
	});
	if (decision.status !== "reject") return true;

	const safeLimitTokens = decision.safeLimitTokens ?? 0;
	const shouldReplaceTerminalDecision =
		tracker.rejectedCount === 0 ||
		safeLimitTokens > tracker.largestSafeLimit ||
		(safeLimitTokens === tracker.largestSafeLimit &&
			decision.occupiedTokens < tracker.terminalOccupiedTokens);
	tracker.rejectedCount++;
	if (shouldReplaceTerminalDecision) {
		tracker.largestSafeLimit = safeLimitTokens;
		tracker.terminalOccupiedTokens = decision.occupiedTokens;
	}
	log.info("Codex context admission rejected attempt", {
		accountId: account.id,
		model,
		outcome: "capacity_rejected",
		outputReserveTokens: decision.outputReserveTokens,
		occupiedTokens: decision.occupiedTokens,
		safeLimitTokens: decision.safeLimitTokens,
	});
	return false;
}

function getConcreteCodexModelList(
	account: Account,
	requestedModel: string,
): string[] {
	const configuredModels = getModelList(requestedModel, account);
	if (!configuredModels) {
		return [resolveCodexRequestModel(requestedModel, account)];
	}
	return configuredModels.map((model) =>
		resolveCodexRequestModel(model, account),
	);
}

export function selectAdmittedCodexModel(
	account: Account,
	requestedModel: string | null,
	tracker?: ContextAdmissionTracker,
	candidateModels?: readonly string[],
): { admitted: boolean; model: string | null } {
	if (
		process.env.CCFLARE_CONTEXT_ADMISSION !== "1" ||
		account.provider !== "codex" ||
		!tracker ||
		!requestedModel
	) {
		return { admitted: true, model: requestedModel };
	}
	for (const model of candidateModels ??
		getConcreteCodexModelList(account, requestedModel)) {
		if (admitConcreteCodexModel(account, model, tracker)) {
			return { admitted: true, model };
		}
	}
	return { admitted: false, model: null };
}

export function createContextLengthExceededResponse(
	tracker: ContextAdmissionTracker,
): Response {
	const occupied = tracker.terminalOccupiedTokens;
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: `prompt is too long: ${occupied} tokens > ${tracker.largestSafeLimit} tokens`,
				code: "context_length_exceeded",
			},
		}),
		{
			status: 400,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function isBillingAttributedSubagent(headers: Headers): boolean {
	const billing = headers.get(ANTHROPIC_BILLING_HEADER);
	if (!billing) return false;
	return billing.split(";").some((field) => {
		const separator = field.indexOf("=");
		if (separator < 0) return false;
		return (
			field.slice(0, separator).trim() === "cc_is_subagent" &&
			field.slice(separator + 1).trim() === "true"
		);
	});
}

export function sanitizeInternalHeaders(headers: Headers): Headers {
	const sanitized = new Headers(headers);
	for (const name of INTERNAL_TRANSPORT_HEADERS) sanitized.delete(name);
	return sanitized;
}

/** Strip proxy-only metadata from a concrete request before upstream fetch. */
function sanitizeInternalTransportHeaders(request: Request): Request {
	if (!INTERNAL_TRANSPORT_HEADERS.some((name) => request.headers.has(name))) {
		return request;
	}
	return new Request(request.url, {
		method: request.method,
		headers: sanitizeInternalHeaders(request.headers),
		body: request.body,
		...(request.body ? { duplex: "half" as const } : {}),
	});
}

// transformRequestBody re-maps model names internally (mapModelName), which can
// revert an explicitly selected fallback model. Force the selected model back
// into an already-transformed request body.
export async function forceModelInTransformedRequest(
	request: Request,
	model: string,
): Promise<Request> {
	try {
		const text = await request.clone().text();
		const body = JSON.parse(text);
		if (body.model === model) return request;
		body.model = model;
		return new Request(request.url, {
			method: request.method,
			headers: new Headers(request.headers),
			body: JSON.stringify(body),
		});
	} catch {
		return request;
	}
}

/**
 * Determines the absolute epoch timestamp (ms since epoch) until which an account
 * should be marked rate-limited after model exhaustion. Priority:
 *   1. retry-after / x-ratelimit-reset / unified reset response headers
 *      (shared Anthropic parser: RFC delay-seconds or HTTP-date for Retry-After,
 *      epoch-seconds for reset headers, earliest usable hint, 24-hour cap)
 *   2. getRateLimitedUntil — usage-window reset time if known
 *   3. probe-cooldown default (TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS,
 *      60s by default, overridable via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) as
 *      last resort. Was a 1-hour ban prior to v3.5.x — that locked accounts
 *      out unnecessarily when upstream returned a transient 429 without a
 *      reset hint, draining small pools to zero routable accounts on a
 *      single burst. Aligns with the same default used in
 *      response-processor.ts when 429s arrive without a reset header.
 *
 * The result is always clamped to at least 60 seconds in the future to avoid a
 * zero or negative value when a parsed timestamp is already in the past.
 *
 * NOTE: getRateLimitedUntil is injected rather than called directly on usageCache
 * so that callers in production pass usageCache.getRateLimitedUntil.bind(usageCache)
 * and tests pass a plain stub — avoiding module-mock symlink issues with Bun.
 */
export function extractCooldownUntil(
	response: Response,
	accountId: string,
	getRateLimitedUntil: (accountId: string) => number | null,
): number {
	const MIN_COOLDOWN_MS = 60 * 1000; // 60 seconds floor
	// Use `||` (not `??`) so empty-string and non-numeric env values
	// (Number("") === 0, Number("abc") === NaN) fall through to the
	// default — `??` would coalesce the empty string to 0 and silently
	// disable the cooldown entirely.
	const DEFAULT_COOLDOWN_MS =
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS;
	const now = Date.now();

	// 1. Parse every upstream reset hint with the same semantics used by the
	// Anthropic provider and scoped-429 classifier. Invalid hints do not mask a
	// valid sibling header, and numeric Retry-After is always delay-seconds.
	const upstreamReset = getAnthropicRateLimitResetAt(response, now);
	if (upstreamReset !== null) {
		return Math.max(upstreamReset, now + MIN_COOLDOWN_MS);
	}

	// 2. Fall back to usage-window reset time if available
	const rateLimitedUntil = getRateLimitedUntil(accountId);
	if (rateLimitedUntil !== null && rateLimitedUntil > now) {
		return Math.max(rateLimitedUntil, now + MIN_COOLDOWN_MS);
	}

	// 3. Last resort: short probe cooldown
	return now + DEFAULT_COOLDOWN_MS;
}

/**
 * Some providers return a synthetic Request containing the provider response
 * payload (instead of a real URL to fetch). Detect and unwrap those requests so
 * we don't try to fetch fake hosts. Bedrock's historical x-bedrock-response
 * marker is kept for compatibility; newer providers use the generic marker.
 */
function isSyntheticProviderResponse(request: Request): boolean {
	return (
		(request.headers.get("x-bedrock-response") === "true" &&
			request.url.startsWith("https://bedrock.aws/response")) ||
		(request.headers.get(SYNTHETIC_RESPONSE_HEADER) === "true" &&
			request.url.startsWith(SYNTHETIC_RESPONSE_URL_PREFIX))
	);
}

function parseSyntheticStatus(request: Request): number {
	const status = Number.parseInt(
		request.headers.get(SYNTHETIC_STATUS_HEADER) ?? "200",
		10,
	);
	return Number.isInteger(status) && status >= 200 && status <= 599
		? status
		: 200;
}

function materializeSyntheticResponse(request: Request): Response {
	const headers = new Headers();
	const contentType = request.headers.get("content-type");
	const cacheControl = request.headers.get("cache-control");
	if (contentType) headers.set("content-type", contentType);
	if (cacheControl) headers.set("cache-control", cacheControl);

	return new Response(request.body, {
		status: parseSyntheticStatus(request),
		headers,
	});
}

/**
 * Removes context-management edits that require thinking to be enabled,
 * e.g. clear_thinking_20251015. Claude rejects requests that pair such an
 * edit with thinking disabled:
 * 400 "`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive"
 * @param body - Parsed request body, mutated in place (top-level key only)
 * @returns True if any edit was removed
 */
function stripClearThinkingEdits(body: Record<string, unknown>): boolean {
	const contextManagement = body.context_management;
	if (!contextManagement || typeof contextManagement !== "object") {
		return false;
	}
	const edits = (contextManagement as Record<string, unknown>).edits;
	if (!Array.isArray(edits)) return false;

	const keptEdits = edits.filter((edit) => {
		const editType =
			edit && typeof edit === "object"
				? (edit as Record<string, unknown>).type
				: undefined;
		return (
			typeof editType !== "string" || !editType.startsWith("clear_thinking")
		);
	});
	if (keptEdits.length === edits.length) return false;

	if (keptEdits.length > 0) {
		body.context_management = { ...contextManagement, edits: keptEdits };
	} else {
		delete body.context_management;
	}
	return true;
}

/**
 * Checks whether the request body explicitly disables thinking, for the
 * purposes of clear_thinking context-management edits. Conservative on
 * purpose: only `thinking.type === "disabled"` counts. An omitted thinking
 * field is ambiguous, model families with default-on thinking accept
 * clear_thinking edits without any thinking config, so those requests pass
 * through untouched and the reactive clear_thinking retry handles the models
 * that reject them.
 */
function isThinkingExplicitlyDisabled(
	body: Readonly<Record<string, unknown>>,
): boolean {
	const thinking = body.thinking;
	if (!thinking || typeof thinking !== "object") return false;
	return (thinking as Record<string, unknown>).type === "disabled";
}

/**
 * Filters thinking blocks from request body
 * Used when Claude rejects thinking blocks with invalid signatures from other providers
 * @param requestBodyBuffer - The original request body buffer
 * @returns New buffer with thinking blocks filtered out, or null if filtering fails
 */
function filterThinkingBlocks(
	requestBody: ArrayBuffer | RequestBodyContext | null,
): ArrayBuffer | null {
	const bodyContext =
		requestBody instanceof RequestBodyContext
			? requestBody
			: new RequestBodyContext(requestBody);
	const requestBodyBuffer = bodyContext.getBuffer();
	if (!requestBodyBuffer) return null;

	try {
		const body = bodyContext.getParsedJson();
		if (!body) return null;

		// Only process if there are messages
		if (!body.messages || !Array.isArray(body.messages)) {
			return requestBodyBuffer;
		}

		let hasChanges = false;

		// Filter out thinking blocks from message content and track which messages were modified
		const processedMessages = body.messages.map(
			(
				msg: {
					role: string;
					content: string | Array<{ type: string; [key: string]: unknown }>;
				},
				index: number,
			) => {
				// Only process assistant messages with array content
				if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
					return { msg, isEmpty: false, hadThinking: false, index };
				}

				// Check if this message has thinking blocks
				const hadThinkingBlock = msg.content.some(
					(block: { type: string }) => block.type === "thinking",
				);

				// Filter out thinking blocks
				const filteredContent = msg.content.filter(
					(block: { type: string; [key: string]: unknown }) => {
						if (block.type === "thinking") {
							hasChanges = true;
							return false;
						}
						return true;
					},
				);

				// Check if message is now effectively empty
				const isEmpty =
					filteredContent.length === 0 ||
					(filteredContent.length === 1 &&
						filteredContent[0].type === "text" &&
						(!filteredContent[0].text || filteredContent[0].text === ""));

				return {
					msg: {
						...msg,
						content: filteredContent.length > 0 ? filteredContent : msg.content,
					},
					isEmpty,
					hadThinking: hadThinkingBlock,
					index,
				};
			},
		);

		// Just filter out thinking blocks and keep all messages
		const filteredMessages = processedMessages
			.filter(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => {
					// Remove empty messages
					if (item.isEmpty) return false;
					return true;
				},
			)
			.map(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => item.msg,
			);

		// Only create new buffer if we made changes
		if (hasChanges) {
			const warningMessage =
				"Disabled thinking mode due to incompatible thinking blocks from previous provider. Conversation context preserved.";
			log.info(warningMessage);

			const filteredBody = {
				...body,
				messages: filteredMessages,
				// Disable thinking mode since we removed thinking blocks
				// This prevents Claude from requiring the final message to start with thinking
				thinking: undefined,
			};
			// With thinking now disabled, any clear_thinking context-management
			// edit would make Claude reject the retried request outright
			// (400 "requires `thinking` to be enabled or adaptive"), so drop it too.
			stripClearThinkingEdits(filteredBody);
			return RequestBodyContext.fromParsed(
				requestBodyBuffer,
				filteredBody,
			).getBuffer();
		}

		return requestBodyBuffer;
	} catch (error) {
		log.warn("Failed to filter thinking blocks:", error);
		return null;
	}
}

/**
 * Checks if a response error is due to invalid thinking block signatures or thinking-related errors
 * @param response - The response to check
 * @returns True if the error is about invalid thinking blocks
 */
type ResponseJsonReader = (response: Response) => Promise<unknown | null>;

async function readResponseCloneJson(
	response: Response,
): Promise<unknown | null> {
	try {
		return await response.clone().json();
	} catch {
		return null;
	}
}

async function isInvalidThinkingSignatureError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (response.status !== 400) return false;
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return false;

	const json = (await readJson(response)) as {
		error?: { message?: unknown };
	} | null;
	// Check for Claude's thinking-related errors
	if (json?.error?.message && typeof json.error.message === "string") {
		const message = json.error.message;
		// Check for invalid signature error
		if (message.includes("Invalid `signature` in `thinking` block")) {
			return true;
		}
		// Check for final message must start with thinking block error
		if (
			message.includes(
				"final `assistant` message must start with a thinking block",
			)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Checks if a 400 is Claude rejecting a clear_thinking context-management
 * edit because thinking is not enabled on the request, e.g.
 * "`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive".
 * Claude Code can send this combination after a mid-session model switch
 * (safeguard fallback), and it repeats on every turn, wedging the session.
 * @param response - The response to check
 * @returns True if the error is the clear_thinking/thinking mismatch
 */
async function isClearThinkingRequiresThinkingError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (response.status !== 400) return false;
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return false;

	const json = (await readJson(response)) as {
		error?: { message?: unknown };
	} | null;
	if (json?.error?.message && typeof json.error.message === "string") {
		const message = json.error.message;
		return (
			message.includes("clear_thinking") &&
			message.includes("requires `thinking` to be enabled")
		);
	}

	return false;
}

/**
 * Removes clear_thinking context-management edits from the request body
 * without touching messages or the thinking config. Used when the client
 * itself sent a clear_thinking edit on a request without thinking enabled.
 * @param requestBody - The original request body buffer or context
 * @returns New buffer without the edits, the original buffer if there was
 * nothing to strip, or null if the body cannot be processed
 */
function filterClearThinkingEdits(
	requestBody: ArrayBuffer | RequestBodyContext | null,
): ArrayBuffer | null {
	const bodyContext =
		requestBody instanceof RequestBodyContext
			? requestBody
			: new RequestBodyContext(requestBody);
	const requestBodyBuffer = bodyContext.getBuffer();
	if (!requestBodyBuffer) return null;

	try {
		const body = bodyContext.getParsedJson();
		if (!body) return null;

		const strippedBody = { ...body };
		if (!stripClearThinkingEdits(strippedBody)) {
			return requestBodyBuffer;
		}
		return RequestBodyContext.fromParsed(
			requestBodyBuffer,
			strippedBody,
		).getBuffer();
	} catch (error) {
		log.warn("Failed to filter clear_thinking context edits:", error);
		return null;
	}
}

/**
 * In-memory set of (accountId, model) pairs known to reject cache_control.
 * Populated on first 400 rejection; cleared on server restart (fast re-learn).
 */
const cacheControlRejectors = new Set<string>();

function cacheControlRejectorKey(accountId: string, model: string): string {
	return `${accountId}:${model}`;
}

/**
 * Checks if a 400 response is caused by an upstream provider rejecting the
 * cache_control field (e.g. GLM-5.1 strict OpenAI-compatible validation).
 */
async function isCacheControlRejectionError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (response.status !== 400) return false;
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return false;

	const json = (await readJson(response)) as {
		error?: { message?: unknown };
		message?: unknown;
	} | null;
	const message = json?.error?.message ?? json?.message ?? "";
	return (
		typeof message === "string" &&
		message.includes("cache_control") &&
		(message.includes("Extra inputs are not permitted") ||
			message.includes("unknown field"))
	);
}

/**
 * Checks if a response error indicates the requested model is unavailable.
 * Covers Anthropic (not_found_error), OpenAI-compat (model_not_found),
 * generic messages, and Bedrock (ResourceNotFoundException).
 */
export async function isModelUnavailableError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (
		response.status !== 404 &&
		response.status !== 400 &&
		response.status !== 429
	)
		return false;

	// 429s always trigger slot failover regardless of content-type.
	// Providers like Qwen return 429 without application/json bodies, and
	// the content-type guard below would otherwise short-circuit before reaching
	// this check, causing the 429 to be forwarded to the client instead of
	// failing over to the next combo slot.
	if (response.status === 429) {
		return true;
	}

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return false;

	const json = (await readJson(response)) as {
		error?: { type?: unknown; code?: unknown; message?: unknown };
	} | null;
	// Anthropic native format
	if (json?.error?.type === "not_found_error") return true;

	// OpenAI-compat format
	if (json?.error?.code === "model_not_found") return true;

	// Generic: message contains "model not found" or "does not exist"
	if (typeof json?.error?.message === "string") {
		const message = json.error.message;
		if (
			message.toLowerCase().includes("model not found") ||
			message.toLowerCase().includes("does not exist") ||
			message.includes("ResourceNotFoundException")
		) {
			return true;
		}
	}

	return false;
}

/**
 * Cancel an abandoned upstream response body so Bun releases its socket and
 * native read buffer immediately.
 *
 * A `fetch()` Response body that is neither read to EOF nor cancelled keeps
 * that memory committed indefinitely. On the proxy's failover/retry paths we
 * obtain an upstream Response and then discard it: return `null` to try the
 * next account, or overwrite `rawResponse`/`response` with a retry, without
 * ever consuming its body. Each dropped body is an off-heap leak that
 * ratchets up with every 429/401/529 failover under load. Calling this
 * before every such drop releases the buffer.
 *
 * Safe to call with any Response/null: skips a `null`/locked body (locked
 * means a reader already owns it, so it will be drained or was cloned) and
 * swallows the harmless error from a body that is already cancelled/errored.
 */
export async function discardUpstreamBody(
	response: Response | null | undefined,
): Promise<void> {
	const body = response?.body;
	if (!body || body.locked) return;
	try {
		// Fire without awaiting settlement: per the Streams spec, cancelling
		// one branch of a tee()'d body never settles until every sibling
		// branch is cancelled or fully read, so awaiting here can hang
		// forever if a sibling clone was abandoned (same rationale as
		// discardUnusedResponse below).
		body.cancel().catch(() => {
			// Body already cancelled/errored -- nothing left to release.
		});
	} catch {
		// Body may already be locked/disturbed; ignore synchronous throws too.
	}
}

/**
 * Reads a response clone's body up to MAX_FINAL_CANDIDATE_CLASSIFICATION_BODY_BYTES
 * and returns an equivalent Response for provider classification
 * (processProxyResponse). This is only ever applied to a *clone* used for
 * final-candidate rate-limit/capacity classification (529, or native xAI
 * 402/429) -- the original response, untouched, is always what gets
 * forwarded to the client.
 *
 * - Body at or under the cap: returned intact, byte-for-byte.
 * - Body over the cap: replaced with a headers-only Response (no body), so
 *   classification proceeds on status/headers alone without an unbounded
 *   read. Callers must not rely on body-driven enrichment when this happens.
 * - No body: passed through unchanged.
 */
export async function boundResponseBodyForClassification(
	clone: Response,
): Promise<Response> {
	const body = clone.body;
	if (!body) return clone;

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let exceededCap = false;
	let readFailed = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				totalBytes += value.byteLength;
				if (totalBytes > MAX_FINAL_CANDIDATE_CLASSIFICATION_BODY_BYTES) {
					exceededCap = true;
					// Stop buffering further chunks, but keep draining/cancelling
					// below so the underlying stream is released cleanly.
					break;
				}
				chunks.push(value);
			}
		}
	} catch {
		// Classification is entirely status/header-based (see the exceeded-cap
		// branch below), so a mid-read failure on this clone must not surface as
		// a thrown error and take down the request path. Fall back to the same
		// headers-only Response used when the body exceeds the cap.
		readFailed = true;
	} finally {
		// Whether we finished normally or bailed out early on the cap, release
		// the reader's lock. If we bailed early, cancel the remainder so the
		// stream doesn't stay half-read.
		if (exceededCap) {
			try {
				// Fire without awaiting settlement, mirroring discardUpstreamBody
				// above: per the Streams spec, cancelling one branch of a tee()'d
				// body never settles until every sibling branch is cancelled or
				// fully read, so awaiting here could hang this helper indefinitely
				// under any current-or-future Bun tee semantics for this reader.
				reader.cancel().catch(() => {
					// Already cancelled/errored -- nothing left to release.
				});
			} catch {
				// Reader may already be released/disturbed; ignore synchronous
				// throws too.
			}
		}
		reader.releaseLock();
	}

	if (exceededCap || readFailed) {
		return new Response(null, {
			status: clone.status,
			statusText: clone.statusText,
			headers: clone.headers,
		});
	}

	const merged = combineChunks(chunks);
	// combineChunks returns a Node Buffer, whose .buffer is typed as
	// ArrayBufferLike (not the concrete ArrayBuffer TS's BodyInit expects for a
	// typed-array view). Copy into a plain Uint8Array<ArrayBuffer> instead of
	// viewing merged.buffer directly.
	const mergedView = new Uint8Array(merged);

	return new Response(mergedView, {
		status: clone.status,
		statusText: clone.statusText,
		headers: clone.headers,
	});
}

class AnthropicPreCommitAttemptDeadlineError extends Error {
	constructor(
		readonly deadlineAt: number,
		readonly budgetMs: number,
	) {
		super("Anthropic route attempt exceeded its private precommit deadline");
		this.name = "AnthropicPreCommitAttemptDeadlineError";
	}
}

interface AnthropicAttemptCommitmentTiming {
	readonly deadlineAt: number;
	readonly startedAt: number;
	readonly budgetMs: number;
}

/**
 * One transport attempt's precommit lifetime. Unlike a fetch-only timeout, the
 * scope remains armed after response headers so every body classifier and the
 * semantic gate share the same absolute boundary.
 */
class AnthropicPreCommitAttemptScope {
	readonly deadlineError: AnthropicPreCommitAttemptDeadlineError;
	readonly signal: AbortSignal;
	readonly abortPromise: Promise<never>;
	private readonly deadlineController = new AbortController();
	private readonly onAbort: () => void;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly routingSignal: AbortSignal,
		readonly timing: AnthropicAttemptCommitmentTiming,
	) {
		this.deadlineError = new AnthropicPreCommitAttemptDeadlineError(
			timing.deadlineAt,
			timing.budgetMs,
		);
		this.signal = AbortSignal.any([
			routingSignal,
			this.deadlineController.signal,
		]);
		let rejectAbort!: (reason: unknown) => void;
		this.abortPromise = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		this.onAbort = () => rejectAbort(this.abortReason());
		if (this.signal.aborted) {
			this.onAbort();
		} else {
			this.signal.addEventListener("abort", this.onAbort, { once: true });
		}
		// The promise is raced only while precommit work is pending. Keep a rejection
		// handler attached after disposal so a later downstream abort is never noisy.
		void this.abortPromise.catch(() => undefined);

		if (timing.budgetMs <= 0) {
			this.deadlineController.abort(this.deadlineError);
		} else {
			this.deadlineTimer = setTimeout(
				() => this.deadlineController.abort(this.deadlineError),
				timing.budgetMs,
			);
		}
	}

	private abortReason(): unknown {
		if (this.routingSignal.aborted) {
			return (
				this.routingSignal.reason ??
				new DOMException("routing aborted", "AbortError")
			);
		}
		return this.deadlineError;
	}

	isPrivateDeadline(): boolean {
		return (
			!this.routingSignal.aborted && this.deadlineController.signal.aborted
		);
	}

	/** Read a classification clone without allowing its tee branch to outlive the attempt. */
	async readJson(response: Response): Promise<unknown | null> {
		let clone: Response;
		try {
			clone = response.clone();
		} catch {
			return null;
		}
		if (!clone.body) return null;

		const reader = clone.body.getReader();
		const chunks: Uint8Array[] = [];
		try {
			while (true) {
				const readPromise = reader.read();
				void readPromise.catch(() => undefined);
				const result = await Promise.race([readPromise, this.abortPromise]);
				if (result.done) break;
				if (result.value) chunks.push(result.value);
			}
			reader.releaseLock();
		} catch (error) {
			if (!this.signal.aborted) {
				// A rejected read leaves the classifier clone's reader locked even
				// though the stream has already errored. Release that branch explicitly
				// so it cannot retain tee bookkeeping after classification gives up.
				try {
					reader.releaseLock();
				} catch {
					// The errored reader may already have detached itself.
				}
				return null;
			}
			const reason = this.abortReason();
			try {
				void reader.cancel(reason).catch(() => undefined);
			} catch {
				// The reader may already have errored from the fetch abort.
			}
			// Cancel the untouched original branch too. Tee cancellation reaches the
			// upstream source once both branches are released.
			void discardUpstreamBody(response);
			throw reason ?? error;
		}

		try {
			return JSON.parse(new TextDecoder().decode(combineChunks(chunks)));
		} catch {
			return null;
		}
	}

	dispose(): void {
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.signal.removeEventListener("abort", this.onAbort);
	}
}

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	anthropicPreCommitRescue?: AnthropicPreCommitRescueRouteContext,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = sanitizeInternalHeaders(
		ctx.provider.prepareHeaders(req.headers, undefined, undefined),
	);
	const routingSignal = anthropicPreCommitRescue?.signal ?? req.signal;
	let attemptCommitment: AnthropicPreCommitAttemptScope | undefined;

	try {
		anthropicPreCommitRescue?.activate();
		if (anthropicPreCommitRescue) {
			const startedAt = Date.now();
			const deadlineAt =
				anthropicPreCommitRescue.getAttemptCommitmentDeadlineAt(true);
			attemptCommitment = new AnthropicPreCommitAttemptScope(routingSignal, {
				deadlineAt,
				startedAt,
				budgetMs: Math.max(0, deadlineAt - startedAt),
			});
			if (attemptCommitment.timing.budgetMs <= 0) {
				throw attemptCommitment.deadlineError;
			}
		}

		let response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
			attemptCommitment?.signal ?? routingSignal,
		);

		if (
			attemptCommitment &&
			response.body &&
			isNativeAnthropicMessagesSse({
				method: req.method,
				path: url.pathname,
				providerName: ctx.provider.name,
				requestHeaders: req.headers,
				response,
			})
		) {
			const streamConfig = getAnthropicStreamRuntimeConfig();
			const gatedBody = await gateAnthropicSsePreCommit(response.body, {
				semanticTimeoutMs: streamConfig.semanticTimeoutMs,
				meaningfulProgressTimeoutMs: streamConfig.meaningfulProgressTimeoutMs,
				commitmentDeadlineAt: attemptCommitment.timing.deadlineAt,
				terminalGraceMs: streamConfig.terminalGraceMs,
				maxBufferedBytes: streamConfig.maxBufferedBytes,
				signal: routingSignal,
			});
			response = new Response(gatedBody, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				project: requestMeta.project,
				query: url.search || null,
				projectAttributionSource: requestMeta.projectAttributionSource ?? null,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: requestMeta.agentUsed,
				originalModel: requestMeta.originalModel,
				appliedModel: requestMeta.appliedModel,
				agentAttributionSource: requestMeta.agentAttributionSource ?? null,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routingMeta: requestMeta,
			},
			ctx,
		);
	} catch (error) {
		if (
			routingSignal.aborted ||
			attemptCommitment?.isPrivateDeadline() ||
			error instanceof AnthropicPreCommitAttemptDeadlineError ||
			error instanceof AnthropicPreCommitAbortedError
		) {
			throw error;
		}
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.provider.name,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	} finally {
		attemptCommitment?.dispose();
	}
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream (buffered earlier)
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns Promise resolving to response or null if failed
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	_createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ProxyContext,
	modelOverride?: string | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	requestBodyContext?: RequestBodyContext | null,
	returnRateLimitedResponseOnExhaustion = false,
	contextAdmissionTracker?: ContextAdmissionTracker,
	routingAttemptLedger?: RoutingAttemptLedger,
	modelFallbackPolicy?: ModelFallbackExecutionPolicy,
): Promise<Response | null> {
	const preCommitRescue = modelFallbackPolicy?.anthropicPreCommitRescue;
	const routingSignal = preCommitRescue?.signal ?? req.signal;
	let implicitFallbackDiscoveryPossible =
		modelFallbackPolicy?.deferImplicitFallback !== undefined;
	const isFinalSemanticAttempt = (): boolean =>
		(modelFallbackPolicy?.isFinalSemanticAttempt?.() ??
			modelFallbackPolicy?.forwardModelUnavailableResponse === true) &&
		!implicitFallbackDiscoveryPossible;
	const resolveAttemptCommitmentDeadline = ():
		| {
				readonly deadlineAt: number;
				readonly startedAt: number;
				readonly budgetMs: number;
		  }
		| undefined => {
		if (!preCommitRescue) return undefined;
		const startedAt = Date.now();
		const deadlineAt = preCommitRescue.getAttemptCommitmentDeadlineAt(
			isFinalSemanticAttempt(),
		);
		return {
			deadlineAt,
			startedAt,
			budgetMs: Math.max(0, deadlineAt - startedAt),
		};
	};
	let latestTransportCommitment:
		| ReturnType<typeof resolveAttemptCommitmentDeadline>
		| undefined;
	let activeAttemptCommitment: AnthropicPreCommitAttemptScope | undefined;
	const readAttemptBoundJson: ResponseJsonReader = (response) =>
		activeAttemptCommitment?.readJson(response) ??
		readResponseCloneJson(response);
	const isAttemptControlError = (error: unknown): boolean =>
		error instanceof AnthropicPreCommitAttemptDeadlineError ||
		routingSignal.aborted ||
		activeAttemptCommitment?.signal.aborted === true;
	const makeAttemptRequest = async (request: Request): Promise<Response> => {
		// The outer context exists only for an Anthropic-shaped downstream request.
		// Any real provider transport can hang before headers (including transformed
		// OpenAI-compatible routes), so start rescue immediately before every fetch.
		// Synthetic provider responses never call this wrapper and remain synchronous.
		preCommitRescue?.activate();
		const commitment = resolveAttemptCommitmentDeadline();
		latestTransportCommitment = commitment;
		activeAttemptCommitment?.dispose();
		activeAttemptCommitment = undefined;
		if (!commitment) {
			return makeProxyRequest(
				request,
				undefined,
				undefined,
				undefined,
				undefined,
				routingSignal,
			);
		}

		const attemptCommitment = new AnthropicPreCommitAttemptScope(
			routingSignal,
			commitment,
		);
		activeAttemptCommitment = attemptCommitment;
		if (commitment.budgetMs <= 0) {
			throw attemptCommitment.deadlineError;
		}

		try {
			return await makeProxyRequest(
				request,
				undefined,
				undefined,
				undefined,
				undefined,
				attemptCommitment.signal,
			);
		} catch (error) {
			if (attemptCommitment.isPrivateDeadline()) {
				throw attemptCommitment.deadlineError;
			}
			throw error;
		}
	};
	try {
		if (
			process.env.DEBUG?.includes("proxy") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(
				`Attempting request with account: ${account.name} (provider: ${account.provider})`,
			);
		}

		// Apply model override from combo slot (per D-04, REQ-12)
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		let effectiveBodyContext = baseBodyContext;
		let effectiveBodyBuffer = baseBodyContext.getBuffer();
		if (modelOverride && effectiveBodyBuffer) {
			const overriddenContext = baseBodyContext.withPatchedModel(modelOverride);
			if (overriddenContext) {
				effectiveBodyContext = overriddenContext;
				effectiveBodyBuffer = overriddenContext.getBuffer();

				if (
					process.env.DEBUG?.includes("proxy") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.info(
						`Combo model override: applying model "${modelOverride}" for account ${account.name}`,
					);
				}
			} else {
				log.warn(
					"Failed to patch request body with model override, using original body",
				);
				effectiveBodyBuffer = baseBodyContext.getBuffer();
			}
		}

		// Get the provider for this account before applying the staging policy: the
		// resolved provider (including ctx fallback) determines replay safety.
		const provider = getProvider(account.provider) || ctx.provider;
		const requestedModelBeforeAdmission = effectiveBodyContext.getModel();
		const concreteCodexModels =
			account.provider === "codex" && requestedModelBeforeAdmission
				? getConcreteCodexModelList(account, requestedModelBeforeAdmission)
				: [];
		const admissionEnabledForAttempt =
			url.pathname === "/v1/messages" &&
			effectiveBodyContext.getParsedJson()?.max_tokens !== 0;
		const attemptAdmissionTracker = admissionEnabledForAttempt
			? contextAdmissionTracker
			: undefined;
		const usesCodexAdmissionPlan =
			account.provider === "codex" && attemptAdmissionTracker !== undefined;
		const requestedFamilyBeforeAdmission = requestedModelBeforeAdmission
			? getModelFamily(requestedModelBeforeAdmission)
			: null;
		let deferredAdmissionRank = 0;
		const admissionCandidates =
			modelFallbackPolicy?.deferImplicitFallback && usesCodexAdmissionPlan
				? concreteCodexModels.filter((model, index) => {
						const candidateFamily = getModelFamily(model);
						const isProvablySameFamily =
							requestedFamilyBeforeAdmission !== null &&
							candidateFamily === requestedFamilyBeforeAdmission;
						const isPrimaryProviderMapping =
							index === 0 && candidateFamily === null;
						if (!isProvablySameFamily && !isPrimaryProviderMapping) {
							modelFallbackPolicy.deferImplicitFallback?.(
								model,
								deferredAdmissionRank++,
							);
							return false;
						}
						return true;
					})
				: undefined;
		const admission = selectAdmittedCodexModel(
			account,
			requestedModelBeforeAdmission,
			attemptAdmissionTracker,
			admissionCandidates,
		);
		if (!admission.admitted) return null;
		const admittedModelIndex = admission.model
			? concreteCodexModels.indexOf(admission.model)
			: -1;
		if (modelFallbackPolicy?.deferImplicitFallback) {
			const discoveryModels =
				modelFallbackPolicy.implicitFallbacksEnabled === false ||
				!requestedModelBeforeAdmission
					? []
					: usesCodexAdmissionPlan
						? concreteCodexModels
						: (getModelList(requestedModelBeforeAdmission, account) ?? []);
			const discoveryStartIndex = usesCodexAdmissionPlan
				? admittedModelIndex + 1
				: 1;
			let deferredDiscoveryRank = 0;
			implicitFallbackDiscoveryPossible = false;
			for (const candidateModel of discoveryModels.slice(
				Math.max(0, discoveryStartIndex),
			)) {
				const candidateFamily = getModelFamily(candidateModel);
				if (
					requestedFamilyBeforeAdmission !== null &&
					candidateFamily === requestedFamilyBeforeAdmission
				) {
					continue;
				}
				implicitFallbackDiscoveryPossible = true;
				// Plan the route before any transport can consume the reserved slice.
				// The request-level callback is occurrence-safe and de-duplicates the
				// later reactive discovery in the model-unavailable loop.
				modelFallbackPolicy.deferImplicitFallback(
					candidateModel,
					deferredDiscoveryRank++,
				);
			}
		} else {
			implicitFallbackDiscoveryPossible = false;
		}
		if (admission.model && admission.model !== requestedModelBeforeAdmission) {
			const admittedContext = effectiveBodyContext.withPatchedModel(
				admission.model,
			);
			if (admittedContext) {
				effectiveBodyContext = admittedContext;
				effectiveBodyBuffer = admittedContext.getBuffer();
			}
		}
		const admittedRequestModel =
			admission.model ?? requestedModelBeforeAdmission ?? null;
		const concreteAttemptModel =
			account.provider === "codex" && admittedRequestModel
				? resolveCodexRequestModel(admittedRequestModel, account)
				: admittedRequestModel;
		const isSyntheticInternal = isSyntheticInternalRequest(req.headers);

		// Validate that the account-specific provider can handle this path
		validateProviderPath(provider, url.pathname);

		const isClaudeProvider =
			provider.name === "anthropic" || account.provider === "claude-oauth";

		// Pre-send guard: a clear_thinking context-management edit combined with
		// explicit `thinking.type === "disabled"` is deterministically rejected
		// by Claude with 400 "requires `thinking` to be enabled or adaptive", so
		// strip the edit up front instead of paying a guaranteed rejection
		// round-trip. An omitted thinking field is left alone: default-thinking
		// model families accept the edit as-is, and the reactive retry further
		// down unwedges the ones that reject it.
		if (isClaudeProvider && effectiveBodyBuffer) {
			const parsedBody = effectiveBodyContext.getParsedJson();
			if (parsedBody && isThinkingExplicitlyDisabled(parsedBody)) {
				const strippedBuffer = filterClearThinkingEdits(effectiveBodyContext);
				if (strippedBuffer && strippedBuffer !== effectiveBodyBuffer) {
					log.info(
						`Stripped clear_thinking context edit sent without thinking enabled for account ${account.name}`,
					);
					effectiveBodyContext = new RequestBodyContext(strippedBuffer);
					effectiveBodyBuffer = strippedBuffer;
				}
			}
		}
		let currentReplayBody = effectiveBodyBuffer;

		const isSyntheticCodexCountTokens =
			provider.name === "codex" && url.pathname === "/v1/messages/count_tokens";

		// Synthetic Codex count_tokens never calls upstream, so it should not require
		// or refresh OAuth credentials just to return an advisory local estimate.
		let accessToken = "";
		if (!isSyntheticCodexCountTokens) {
			try {
				accessToken = await runWithPreTransportDeadline({
					phase: "credential_resolution",
					timeoutMs:
						getPreTransportDeadlineConfig().credentialResolutionTimeoutMs,
					signal: routingSignal,
					operation: () => getValidAccessToken(account, ctx),
				});
			} catch (error) {
				if (error instanceof PreTransportPhaseTimeoutError) {
					// No provider request exists yet, so this candidate can be skipped
					// without pausing the account or poisoning its route circuit. The
					// deadline helper consumes any late credential settlement.
					return null;
				}
				throw error;
			}
		}

		// Pre-process request if provider supports it (e.g., to extract model for URL)
		if (provider.prepareRequest) {
			provider.prepareRequest(req, effectiveBodyBuffer, account);
		}

		// Prepare request using account-specific provider
		const replayResolvedModel =
			provider.cacheReplayModelStrategy === "transformed-body"
				? req.headers.get(CACHE_REPLAY_MODEL_HEADER)
				: null;
		const headers = provider.prepareHeaders(
			req.headers,
			accessToken,
			account.api_key || undefined,
		);
		headers.delete(CACHE_REPLAY_MODEL_HEADER);
		// Codex request tracing and stream-intent correlation need the proxy request
		// ID during transformRequestBody. The Codex provider consumes and strips this
		// internal header before the request is sent upstream.
		let transportAttemptOrdinal = requestMeta.codexTransportAttemptOrdinal ?? 0;
		let currentTransportAttemptId: string | null = null;
		const stampCodexAttempt = (
			attemptHeaders: Headers,
			cause:
				| "initial"
				| "model_fallback"
				| "overload_529"
				| "thinking_retry"
				| "cache_control_retry"
				| "cache_lane_rescue"
				| "precommit_sse_retry"
				| "account_failover"
				| "other_retry",
			finalModel?: string,
		) => {
			if (provider.name !== "codex") return;
			transportAttemptOrdinal++;
			requestMeta.codexTransportAttemptOrdinal = transportAttemptOrdinal;
			currentTransportAttemptId = crypto.randomUUID();
			attemptHeaders.set(
				"x-better-ccflare-attempt-id",
				currentTransportAttemptId,
			);
			attemptHeaders.set(
				"x-better-ccflare-attempt-ordinal",
				String(transportAttemptOrdinal),
			);
			attemptHeaders.set("x-better-ccflare-attempt-cause", cause);
			if (finalModel) {
				attemptHeaders.set("x-better-ccflare-final-model", finalModel);
			} else {
				attemptHeaders.delete("x-better-ccflare-final-model");
			}
		};
		if (provider.name === "codex") {
			const isAttributedAgent =
				Boolean(requestMeta.agentUsed) ||
				isBillingAttributedSubagent(req.headers);
			// Client-supplied copies are untrusted. Strip before attaching only
			// server-derived experiment metadata so traces cannot be spoofed or
			// retain arbitrary sensitive header content.
			headers.delete("x-better-ccflare-pacing-canary");
			headers.delete("x-better-ccflare-pacing-cohort-id");
			headers.delete("x-better-ccflare-pacing-action");
			headers.set("x-better-ccflare-request-id", requestMeta.id);
			// Attribution is resolved by the proxy before account selection. Replace
			// any client-supplied marker here, once the selected provider is known.
			if (isAttributedAgent) {
				headers.set("x-better-ccflare-attributed-agent", "true");
			} else {
				headers.delete("x-better-ccflare-attributed-agent");
			}
			if (requestMeta.codexPacingCanary) {
				headers.set(
					"x-better-ccflare-pacing-canary",
					requestMeta.codexPacingCanary,
				);
			}
			if (requestMeta.codexPacingAction) {
				headers.set(
					"x-better-ccflare-pacing-action",
					requestMeta.codexPacingAction,
				);
			}
			if (requestMeta.codexPacingCohortId) {
				headers.set(
					"x-better-ccflare-pacing-cohort-id",
					requestMeta.codexPacingCohortId,
				);
			}
		} else {
			headers.delete("x-better-ccflare-attributed-agent");
		}
		stampCodexAttempt(
			headers,
			transportAttemptOrdinal > 0 ? "account_failover" : "initial",
		);
		// Synthetic-response markers are internal provider-to-proxy signals. Strip
		// client-supplied copies before providers transform the outbound request.
		headers.delete(SYNTHETIC_RESPONSE_HEADER);
		headers.delete(SYNTHETIC_STATUS_HEADER);
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);
		const executeCacheAwareProviderAttempt = async (
			transportRequest: Request,
			replayBody: ArrayBuffer | null,
			cacheIdentityHasCacheControl?: boolean,
			resolvedModel?: string | null,
		): Promise<Response> => {
			const isSynthetic = isSyntheticProviderResponse(transportRequest);
			await stageCacheBodyForTransportAttempt({
				requestId: requestMeta.id,
				accountId: account.id,
				providerName: provider.name,
				replayBody,
				transportRequest,
				clientHeaders: req.headers,
				path: url.pathname,
				cacheIdentityHasCacheControl,
				isSyntheticProviderTransport: isSynthetic,
				resolvedModel:
					provider.cacheReplayModelStrategy === "transformed-body"
						? resolvedModel
						: null,
			});
			return isSynthetic
				? materializeSyntheticResponse(transportRequest)
				: makeAttemptRequest(transportRequest);
		};
		const enforcePhysicalModelAfterTransform = async (
			transportRequest: Request,
			physicalModel: string | null | undefined,
		): Promise<Request> => {
			if (
				!physicalModel ||
				provider.cacheReplayModelStrategy !== "transformed-body" ||
				isSyntheticProviderResponse(transportRequest)
			) {
				return transportRequest;
			}
			return forceModelInTransformedRequest(transportRequest, physicalModel);
		};

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
		};
		if (effectiveBodyBuffer) {
			requestInit.body = new Uint8Array(effectiveBodyBuffer);
			requestInit.duplex = "half";
		}

		const providerRequest = new Request(targetUrl, requestInit);
		// Keep server-derived correlation/experiment metadata on the reusable
		// transform headers: model fallback transforms need the same request ID and
		// cohort attribution. Strip only the concrete transport request below,
		// after each transform, so internal headers never reach upstream.

		let transformedRequest = provider.transformRequestBody
			? await provider.transformRequestBody(providerRequest, account)
			: providerRequest;
		transformedRequest = await enforcePhysicalModelAfterTransform(
			transformedRequest,
			replayResolvedModel,
		);
		// Provider-local stream intent must reach processResponse, not upstream.
		// Capture it before transport sanitization and reattach only to the local
		// response object below.
		const internalRequestStream = transformedRequest.headers.get(
			"x-better-ccflare-request-stream",
		);
		const xaiCacheKeyPresent = transformedRequest.headers.has("x-grok-conv-id");
		const xaiCacheOfficialEndpoint = isOfficialXaiEndpoint(account);
		const cacheFlightRecorderEligible =
			provider.name === "xai" &&
			url.pathname === "/v1/messages" &&
			xaiCacheOfficialEndpoint &&
			Boolean(requestMeta.cacheFlightRecorderConversationId);
		// Defense-in-depth: providers normally consume these before returning,
		// but transform fallbacks may return the original request.
		transformedRequest = sanitizeInternalTransportHeaders(transformedRequest);
		const isSyntheticResponse = isSyntheticProviderResponse(transformedRequest);

		// Pre-strip cache_control for (account, model) pairs known to reject it
		// Synthetic transports (notably Bedrock) contain the upstream RESPONSE:
		// never clone/buffer that response as though it were an outbound body.
		const transformedBodyText = isSyntheticResponse
			? ""
			: await transformedRequest.clone().text();
		let currentCacheIdentityHasCacheControl: boolean | undefined =
			isSyntheticResponse
				? undefined
				: hasCacheControlHintInJsonText(transformedBodyText);
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(transformedBodyText);
		} catch {
			// ignore
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ??
			(isSyntheticResponse ? (concreteAttemptModel ?? "") : "");
		let currentTransportModel = transformedModel || concreteAttemptModel;
		if (
			routingAttemptLedger &&
			!routingAttemptLedger.claim(account.id, currentTransportModel)
		) {
			if (attemptAdmissionTracker) {
				attemptAdmissionTracker.nonCapacitySkipCount++;
			}
			log.debug(
				`Skipping duplicate request-local route account=${account.name} model=${currentTransportModel ?? "unknown"}`,
			);
			return null;
		}
		if (routingAttemptLedger) {
			// A later unique upstream route supersedes any deferred terminal response
			// from the previous route. Duplicate skips return above and deliberately
			// preserve it so the request can still surface that upstream terminal once
			// every unique route has been exhausted.
			await routingAttemptLedger.discardTerminalResponse();
			failoverAttempts = Math.max(
				failoverAttempts,
				routingAttemptLedger.attemptedCount - 1,
			);
		}
		if (attemptAdmissionTracker) attemptAdmissionTracker.attemptedCount++;

		const finalizedCodexAttemptIds = new Set<string>();
		const finalizeCurrentCodexTransport = async (discarded: Response) => {
			if (provider.name !== "codex" || !currentTransportAttemptId) return;
			const attemptId = currentTransportAttemptId;
			if (finalizedCodexAttemptIds.has(attemptId)) return;
			// Mark finalized before draining so a rejecting body cannot abort the
			// intended retry/failover path or cause repeated finalization work.
			finalizedCodexAttemptIds.add(attemptId);
			try {
				const traceHeaders = new Headers(discarded.headers);
				traceHeaders.set("x-better-ccflare-request-id", requestMeta.id);
				traceHeaders.set("x-better-ccflare-request-stream", "false");
				traceHeaders.set("x-better-ccflare-attempt-id", attemptId);
				if (currentTransportModel) {
					traceHeaders.set(
						"x-better-ccflare-final-model",
						currentTransportModel,
					);
				}
				const processed = await provider.processResponse(
					new Response(discarded.clone().body, {
						status: discarded.status,
						statusText: discarded.statusText,
						headers: traceHeaders,
					}),
					account,
					req.headers,
				);
				await processed.arrayBuffer();
			} catch (error) {
				log.debug(
					`Codex attempt finalization failed for ${attemptId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		};
		// Some providers (currently Codex) return a `response` whose body is a
		// live ReadableStream backed by a background task that pumps an
		// upstream reader (see CodexProvider's transformStreamingResponse). If
		// that response is discarded here without ever being read or
		// cancelled, the background task parks forever waiting for downstream
		// backpressure to clear, holding the upstream reader's lock open
		// indefinitely. Calling body.cancel() unsticks that task the same way
		// a well-behaved consumer aborting mid-stream would, and is a no-op
		// (or a cheap connection-close) for providers whose response body is a
		// plain, unread passthrough stream. Always call this before returning
		// null / dropping a `response` reference at a failover point.
		//
		// IMPORTANT: `discarded.body` may be one branch of a tee()'d stream
		// (e.g. earlier header-only `response.clone()` calls for
		// parseRateLimit, or response-processor.ts's usage-extraction clone).
		// Per the Streams spec, cancelling one tee branch never settles until
		// every branch has been cancelled or fully read: awaiting an
		// unbounded `cancel()` here can hang forever if any sibling branch was
		// abandoned without being read or cancelled. Callers still get an
		// awaitable promise (so existing call sites don't need to change),
		// but this never itself awaits the underlying cancel: it fires it and
		// returns, guaranteeing prompt resolution regardless of the state of
		// any sibling tee branch. Sibling clones created in this file and in
		// response-processor.ts are now cancelled at their own call sites
		// once their header/usage-only use is done, so in the common case
		// the cancellation still completes quickly in the background.
		const discardUnusedResponse = async (
			discarded: Response,
			reason: string,
		) => {
			try {
				discarded.body?.cancel(reason).catch(() => {
					// Best effort only: the goal is to unstick any pending
					// backpressure or release a held upstream connection, not
					// to guarantee cancellation succeeds.
				});
			} catch {
				// Body may already be locked/disturbed; ignore synchronous throws too.
			}
		};

		// Drains a superseded in-place-retry response so its usage capture and
		// attempt-trace finalization complete when the body ends promptly, while
		// guaranteeing a never-closing body (e.g. a live SSE stream with no
		// terminal frame) cannot hang the retry loop: past the bound the drain
		// is abandoned and the reader is cancelled instead.
		const drainSupersededResponse = async (discarded: Response) => {
			const body = discarded.body;
			if (!body) return;
			const timeoutMs = getInPlaceRetryDrainTimeoutMs();
			const reader = body.getReader();
			const deadline = Date.now() + timeoutMs;
			while (true) {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					reader.cancel("in_place_529_retry_drain_timeout").catch(() => {});
					return;
				}
				const result = await Promise.race([
					reader.read().catch(() => ({ done: true }) as const),
					new Promise<"timeout">((resolve) =>
						setTimeout(() => resolve("timeout"), remainingMs),
					),
				]);
				if (result === "timeout") {
					reader.cancel("in_place_529_retry_drain_timeout").catch(() => {});
					return;
				}
				if (result.done) return;
			}
		};
		if (
			!isSyntheticResponse &&
			transformedModel &&
			cacheControlRejectors.has(
				cacheControlRejectorKey(account.id, transformedModel),
			) &&
			transformedBodyJson
		) {
			stripCacheControlFromOpenAIRequest(
				transformedBodyJson as unknown as Parameters<
					typeof stripCacheControlFromOpenAIRequest
				>[0],
			);
			const strippedBodyText = JSON.stringify(transformedBodyJson);
			transformedRequest = new Request(transformedRequest.url, {
				method: transformedRequest.method,
				headers: transformedRequest.headers,
				body: strippedBodyText,
			});
			currentCacheIdentityHasCacheControl =
				hasCacheControlHintInJsonText(strippedBodyText);
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// Capture a clone for in-place 529 retries before the body is consumed.
		const transformedRequestForRetry = isSyntheticResponse
			? transformedRequest
			: transformedRequest.clone();
		// The 529 in-place retry must resend the CURRENT physical transport, not
		// the original request: thinking/cache-control retries and model fallback
		// all replace the outbound body, and reverting silently changes the model.
		let retrySourceRequest = providerRequest;
		let retryTransformedTemplate = transformedRequestForRetry;

		// Make the request, or unwrap a provider response produced during transform.
		// Both paths first replace/discard cache staging for this physical attempt.
		let rawResponse = await executeCacheAwareProviderAttempt(
			transformedRequest,
			currentReplayBody,
			currentCacheIdentityHasCacheControl,
			currentTransportModel,
		);

		// Check if this is a Claude provider and we got an invalid thinking signature error
		if (
			isClaudeProvider &&
			(await isInvalidThinkingSignatureError(rawResponse, readAttemptBoundJson))
		) {
			log.info(
				`Detected invalid thinking block signature error for account ${account.name}, retrying with thinking blocks filtered`,
			);

			// Filter thinking blocks from the request body
			const filteredBodyBuffer = filterThinkingBlocks(effectiveBodyContext);

			if (filteredBodyBuffer && filteredBodyBuffer !== effectiveBodyBuffer) {
				// Retry the request with filtered body
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(filteredBodyBuffer),
					duplex: "half",
				};

				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				stampCodexAttempt(headers, "thinking_retry");
				const retryProviderRequest = new Request(targetUrl, retryRequestInit);
				retrySourceRequest = retryProviderRequest.clone();

				let retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;
				retryTransformedRequest = await enforcePhysicalModelAfterTransform(
					retryTransformedRequest,
					currentTransportModel,
				);
				retryTransformedTemplate = retryTransformedRequest.clone();

				// Preserve internal metadata through the transform for tracing, then
				// strip it from the concrete transport request.
				const retryTransportRequest = sanitizeInternalTransportHeaders(
					retryTransformedTemplate.clone(),
				);
				currentReplayBody = filteredBodyBuffer;
				currentCacheIdentityHasCacheControl = undefined;
				// Make the retry request (or unwrap a synthetic provider response)
				rawResponse = await executeCacheAwareProviderAttempt(
					retryTransportRequest,
					currentReplayBody,
					currentCacheIdentityHasCacheControl,
					currentTransportModel,
				);
			} else {
				log.warn(
					"Failed to filter thinking blocks or no changes made, proceeding with original error response",
				);
			}
		}

		// Claude rejects requests that pair a clear_thinking context-management
		// edit with thinking disabled (400 "`clear_thinking_20251015` strategy
		// requires `thinking` to be enabled or adaptive"). Claude Code sends this
		// combination after a mid-session model switch and repeats it on every
		// turn, so the session stays wedged unless the edit is dropped. Retry
		// once with the offending edits removed; everything else is preserved.
		if (
			isClaudeProvider &&
			(await isClearThinkingRequiresThinkingError(
				rawResponse,
				readAttemptBoundJson,
			))
		) {
			const strippedBodyBuffer = filterClearThinkingEdits(effectiveBodyContext);

			if (strippedBodyBuffer && strippedBodyBuffer !== effectiveBodyBuffer) {
				log.info(
					`Claude rejected clear_thinking context edit without thinking enabled for account ${account.name}, retrying with the edit removed`,
				);
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(strippedBodyBuffer),
					duplex: "half",
				};

				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				stampCodexAttempt(headers, "other_retry");
				const retryProviderRequest = new Request(targetUrl, retryRequestInit);
				retrySourceRequest = retryProviderRequest.clone();

				let retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;
				retryTransformedRequest = await enforcePhysicalModelAfterTransform(
					retryTransformedRequest,
					currentTransportModel,
				);
				retryTransformedTemplate = retryTransformedRequest.clone();

				const retryTransportRequest = sanitizeInternalTransportHeaders(
					retryTransformedTemplate.clone(),
				);
				currentReplayBody = strippedBodyBuffer;
				currentCacheIdentityHasCacheControl = undefined;
				rawResponse = await executeCacheAwareProviderAttempt(
					retryTransportRequest,
					currentReplayBody,
					currentCacheIdentityHasCacheControl,
					currentTransportModel,
				);
			} else {
				log.warn(
					"No clear_thinking context edits to strip or filtering failed, proceeding with original error response",
				);
			}
		}

		// Retry without cache_control if provider rejected it (e.g. GLM-5.1 strict validation).
		// Mark (accountId, model) so subsequent requests skip cache_control immediately.
		if (await isCacheControlRejectionError(rawResponse, readAttemptBoundJson)) {
			const rejectorKey = cacheControlRejectorKey(account.id, transformedModel);
			if (!cacheControlRejectors.has(rejectorKey)) {
				// Mark before retry so subsequent requests pre-strip without a round-trip.
				// The current caller still receives the retried response (or the original
				// 400 if the retry also fails).
				cacheControlRejectors.add(rejectorKey);
				log.info(
					`Provider rejected cache_control for account=${account.name} model=${transformedModel}, retrying without it`,
				);
			}

			try {
				const retryBodyJson = JSON.parse(transformedBodyText);
				stripCacheControlFromOpenAIRequest(retryBodyJson);
				let retryRequest: Request;
				if (provider.name === "codex" && provider.transformRequestBody) {
					await finalizeCurrentCodexTransport(rawResponse);
					await discardUpstreamBody(rawResponse);
					const retryHeaders = new Headers(providerRequest.headers);
					stampCodexAttempt(retryHeaders, "cache_control_retry");
					const retrySourceBody = await providerRequest.clone().json();
					stripCacheControlFromOpenAIRequest(retrySourceBody);
					const retrySourceText = JSON.stringify(retrySourceBody);
					const retrySource = new Request(providerRequest.url, {
						method: providerRequest.method,
						headers: retryHeaders,
						body: retrySourceText,
					});
					currentReplayBody = new TextEncoder().encode(retrySourceText).buffer;
					currentCacheIdentityHasCacheControl = undefined;
					retrySourceRequest = retrySource.clone();
					const retryTransformed = await provider.transformRequestBody(
						retrySource,
						account,
					);
					retryTransformedTemplate = retryTransformed.clone();
					retryRequest = sanitizeInternalTransportHeaders(
						retryTransformedTemplate.clone(),
					);
				} else {
					const retryBodyText = JSON.stringify(retryBodyJson);
					retryRequest = new Request(transformedRequest.url, {
						method: transformedRequest.method,
						headers: transformedRequest.headers,
						body: retryBodyText,
					});
					// The physical retry is already provider-transformed, but keepalive
					// must re-enter from the normalized source and receive exactly one
					// transform. Strip rejected markers from that source projection rather
					// than persisting the OpenAI/Vertex transport shape.
					currentReplayBody =
						stripCacheControlFromReplayBody(currentReplayBody);
					currentCacheIdentityHasCacheControl =
						hasCacheControlHintInJsonText(retryBodyText);
					retryTransformedTemplate = retryRequest.clone();
				}
				rawResponse = await executeCacheAwareProviderAttempt(
					retryRequest,
					currentReplayBody,
					currentCacheIdentityHasCacheControl,
					currentTransportModel,
				);
			} catch (err) {
				if (isAttemptControlError(err)) throw err;
				log.warn("Failed to retry without cache_control:", err);
			}
		}

		/**
		 * HTTP 402 is an account-specific billing/credit failure, not a model
		 * availability signal. Every transport attempt must pass through this helper,
		 * including responses produced inside the same-account model fallback loop.
		 * A short, bounded cooldown prevents every concurrent request from probing the
		 * same route, but availableAt stays null because a reset hint does not prove
		 * global billing recovery. The outer account/ComboSlot loop remains the owner
		 * of same-request failover.
		 */
		const handlePaymentRequired402 = async (
			failureResponse: Response,
			attemptedModel = currentTransportModel || effectiveBodyContext.getModel(),
		): Promise<RawAttemptFailureClassification | null> => {
			if (failureResponse.status !== 402) return null;
			// Native xAI capacity signal (R5-R10): XaiProvider.parseRateLimit
			// classifies a 402 as "xai_capacity_402" (more specific than this
			// generic account-wide billing reason), and that classification path
			// awaits the durable cooldown write before returning (R9: avoids a
			// fast follow-up request racing ahead of the write) and forwards the
			// original response intact on the final candidate (AE4a) instead of
			// unconditionally failing over. Skip this generic handler for xAI so
			// the response falls through to processProxyResponse's xAI-specific
			// branch (response-processor.ts) further down instead of being
			// swallowed here with a fire-and-forget cooldown and a mislabeled
			// reason. Every other provider's 402 handling is unaffected.
			if (account.provider === "xai") return null;
			const reason: RateLimitReason = "upstream_402_payment_required";
			const cooldownUntil = extractCooldownUntil(
				failureResponse,
				account.id,
				usageCache.getRateLimitedUntil.bind(usageCache),
			);
			applyRateLimitCooldown(
				account,
				{ resetTime: cooldownUntil, reason },
				ctx,
			);
			routingAttemptLedger?.blockAccount(account.id);
			recordRequestRateLimitOutcome(req, {
				accountId: account.id,
				status: 402,
				scope: "account",
				family: attemptedModel ? getModelFamily(attemptedModel) : null,
				attemptedModel,
				reason,
				availableAt: null,
			});
			log.warn(
				`Account ${account.name} returned payment required (402${attemptedModel ? `, model=${attemptedModel}` : ""}) — ` +
					"applying bounded account probe cooldown and failing over without model fallback",
			);
			const responseTime = Date.now() - requestMeta.timestamp;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.saveRequest(
					crypto.randomUUID(),
					req.method,
					url.pathname,
					account.id,
					402,
					false,
					reason,
					responseTime,
					failoverAttempts,
					attemptedModel ? { model: attemptedModel } : undefined,
					requestMeta.agentUsed ?? undefined,
					apiKeyId ?? undefined,
					apiKeyName ?? undefined,
					requestMeta.project ?? null,
					undefined,
					requestMeta.comboName ?? null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.originalModel ?? null)
						: null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.appliedModel ?? null)
						: null,
					requestMeta.projectAttributionSource ?? null,
					requestMeta.agentAttributionSource ?? null,
				),
			);
			return {
				scope: "account",
				attemptedModel,
				family: attemptedModel ? getModelFamily(attemptedModel) : null,
				stopAccountAttempt: true,
			};
		};

		// ── extra_usage_exhausted: billing-policy rejection, NOT a rate limit (issue #293) ──
		// Anthropic returns 400 invalid_request_error when a Claude OAuth account's
		// "extra usage" credit balance is depleted for third-party-app traffic (e.g.
		// OpenCode). This is a billing rejection, not account exhaustion — we do NOT
		// bench the account and we do NOT change what's returned to the client; the
		// 400 is passed through unchanged. We only log/record it for dashboard visibility.
		// Checked before isModelUnavailableError since this 400 shape (invalid_request_error
		// mentioning "extra usage") is not a "model unavailable" condition and would
		// otherwise never be reached — isModelUnavailableError only matches not_found_error,
		// model_not_found, "model not found"/"does not exist", or ResourceNotFoundException.
		// Gated to Anthropic/Claude-OAuth accounts only — the body-shape match
		// (invalid_request_error + "extra usage") is specific enough for Anthropic's
		// API but could otherwise coincidentally match an arbitrary OpenAI-compatible
		// provider's error text and mislabel its billing state.
		if (
			isClaudeProvider &&
			rawResponse.status === 400 &&
			(await isAnthropicExtraUsageExhausted(rawResponse.clone()))
		) {
			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			const reason: RateLimitReason = "extra_usage_exhausted";
			log.warn(
				`Account ${account.name} extra_usage_exhausted (400${requestedModel ? `, model=${requestedModel}` : ""}) — ` +
					`Anthropic extra-usage credits depleted for this OAuth account; NOT benching, response passed through to client`,
			);
			const responseTime = Date.now() - requestMeta.timestamp;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.saveRequest(
					crypto.randomUUID(),
					req.method,
					url.pathname,
					account.id,
					400,
					false,
					reason,
					responseTime,
					failoverAttempts,
					requestedModel ? { model: requestedModel } : undefined,
					requestMeta.agentUsed ?? undefined,
					apiKeyId ?? undefined,
					apiKeyName ?? undefined,
					requestMeta.project ?? null,
					undefined,
					requestMeta.comboName ?? null,
				),
			);
			// Do not bench the account or fail over — pass Anthropic's real error
			// through to the client unchanged, same as any other 400 today.
			return withSanitizedProxyHeaders(rawResponse);
		}

		/**
		 * Scope every generic Anthropic 429 before account cooldown. Fresh positive
		 * scoped usage can mark a family; missing, stale, or ambiguous usage marks
		 * only the exact model + client-beta candidate. Positive account-wide
		 * evidence and unrecognized models fall through to account cooldown below.
		 */
		const handleScopedAnthropic429 = async (
			failureResponse: Response,
			attemptedModel: string | null,
		): Promise<RawAttemptFailureClassification | null> => {
			if (
				failureResponse.status !== 429 ||
				!isClaudeProvider ||
				isAnthropicOutOfCredits(failureResponse) ||
				req.headers.get("x-better-ccflare-keepalive") === "true"
			) {
				return null;
			}
			const decision = classifyPreByte429({
				isAnthropic: true,
				response: failureResponse,
				attemptedModel,
				snapshot: usageCache.getSnapshot(account.id),
			});
			if (decision.scope === "account") {
				const cooldownUntil = extractCooldownUntil(
					failureResponse,
					account.id,
					usageCache.getRateLimitedUntil.bind(usageCache),
				);
				const auditReason: RateLimitReason = "model_fallback_429";
				applyRateLimitCooldown(
					account,
					{ resetTime: cooldownUntil, reason: auditReason },
					ctx,
				);
				routingAttemptLedger?.blockAccount(account.id);
				recordRequestRateLimitOutcome(req, {
					accountId: account.id,
					status: 429,
					scope: "account",
					family: decision.family,
					attemptedModel,
					reason: decision.reason,
					// applyRateLimitCooldown may enforce its configured safety ceiling;
					// record the actual in-memory route marker, not the raw hint.
					availableAt: account.rate_limited_until,
				});
				log.warn(
					`Account ${account.name} generic 429 classified account scoped ` +
						`(model=${attemptedModel ?? "unknown"}, family=${decision.family ?? "unknown"}, reason=${decision.reason}) — ` +
						"benching account and stopping same-account model fallback",
				);
				const responseTime = Date.now() - requestMeta.timestamp;
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.saveRequest(
						crypto.randomUUID(),
						req.method,
						url.pathname,
						account.id,
						429,
						false,
						auditReason,
						responseTime,
						failoverAttempts,
						attemptedModel ? { model: attemptedModel } : undefined,
						requestMeta.agentUsed ?? undefined,
						apiKeyId ?? undefined,
						apiKeyName ?? undefined,
						requestMeta.project ?? null,
						undefined,
						requestMeta.comboName ?? null,
						isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
							? (requestMeta.originalModel ?? null)
							: null,
						isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
							? (requestMeta.appliedModel ?? null)
							: null,
						requestMeta.projectAttributionSource ?? null,
						requestMeta.agentAttributionSource ?? null,
					),
				);
				return {
					scope: "account",
					attemptedModel,
					family: decision.family,
					stopAccountAttempt: true,
				};
			}
			if (
				decision.family === null ||
				decision.markerExpiresAt === null ||
				!attemptedModel
			) {
				return null;
			}

			let availableAt: number | null = null;
			if (decision.scope === "family") {
				if (
					!usageCache.markFamilyScopedExhausted(
						account.id,
						attemptedModel,
						decision.markerExpiresAt,
					)
				) {
					return null;
				}
				availableAt =
					usageCache.getFamilyScopedExhaustion(account.id, attemptedModel)
						?.expiresAt ?? null;
			} else {
				const betaSignature = req.headers.get("anthropic-beta");
				usageCache.markModelScopedExhausted(
					account.id,
					attemptedModel,
					betaSignature,
					decision.markerExpiresAt,
				);
				availableAt =
					usageCache.getModelScopedExhaustion(
						account.id,
						attemptedModel,
						betaSignature,
					)?.expiresAt ?? null;
			}
			if (availableAt === null) return null;

			recordRequestRateLimitOutcome(req, {
				accountId: account.id,
				status: 429,
				scope: decision.scope,
				family: decision.family,
				attemptedModel,
				reason: decision.reason,
				availableAt,
			});
			const reason: RateLimitReason = "model_scoped_429";
			log.warn(
				`Account ${account.name} generic 429 classified ${decision.scope} scoped ` +
					`(model=${attemptedModel}, family=${decision.family}, evidence_age_ms=${decision.snapshotAgeMs ?? "unknown"}) — ` +
					"NOT benching account; pruning only the evidenced route scope",
			);
			const responseTime = Date.now() - requestMeta.timestamp;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.saveRequest(
					crypto.randomUUID(),
					req.method,
					url.pathname,
					account.id,
					429,
					false,
					reason,
					responseTime,
					failoverAttempts,
					{ model: attemptedModel },
					requestMeta.agentUsed ?? undefined,
					apiKeyId ?? undefined,
					apiKeyName ?? undefined,
					requestMeta.project ?? null,
					undefined,
					requestMeta.comboName ?? null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.originalModel ?? null)
						: null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.appliedModel ?? null)
						: null,
					requestMeta.projectAttributionSource ?? null,
					requestMeta.agentAttributionSource ?? null,
				),
			);
			return {
				scope: decision.scope,
				attemptedModel,
				family: decision.family,
				stopAccountAttempt: false,
			};
		};

		/**
		 * Persist direct out_of_credits evidence in both the routing cache and the
		 * request-local terminal ledger. The marker is exact to model + client beta;
		 * recording its actual expiry keeps the terminal response aligned with the
		 * state subsequent requests will consult.
		 */
		const recordExactModelExhaustion = (attemptedModel: string): void => {
			const betaSignature = req.headers.get("anthropic-beta");
			usageCache.markModelScopedExhausted(
				account.id,
				attemptedModel,
				betaSignature,
			);
			const marker = usageCache.getModelScopedExhaustion(
				account.id,
				attemptedModel,
				betaSignature,
			);
			recordRequestRateLimitOutcome(req, {
				accountId: account.id,
				status: 429,
				scope: "model",
				family: getModelFamily(attemptedModel),
				attemptedModel,
				reason: "out_of_credits",
				availableAt: marker?.expiresAt ?? null,
			});
		};

		/**
		 * Classify the exact Anthropic out_of_credits signal before provider
		 * transformation. The signal is model/beta scoped, so it must never reach
		 * processProxyResponse's account-wide 429 cooldown path.
		 */
		const handleExactModel429 = async (
			failureResponse: Response,
			attemptedModel: string | null,
		): Promise<RawAttemptFailureClassification | null> => {
			if (
				failureResponse.status !== 429 ||
				!isClaudeProvider ||
				!isAnthropicOutOfCredits(failureResponse)
			) {
				return null;
			}

			if (req.headers.get("x-better-ccflare-keepalive") === "true") {
				return {
					scope: "model",
					attemptedModel,
					family: attemptedModel ? getModelFamily(attemptedModel) : null,
					stopAccountAttempt: true,
				};
			}

			const reason: RateLimitReason = "out_of_credits";
			if (attemptedModel) recordExactModelExhaustion(attemptedModel);
			log.warn(
				`Account ${account.name} out_of_credits (429${attemptedModel ? `, model=${attemptedModel}` : ""}) — ` +
					"model/beta-scoped, NOT benching account; pruning this exact model from request-local routing",
			);
			const responseTime = Date.now() - requestMeta.timestamp;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.saveRequest(
					crypto.randomUUID(),
					req.method,
					url.pathname,
					account.id,
					429,
					false,
					reason,
					responseTime,
					failoverAttempts,
					attemptedModel ? { model: attemptedModel } : undefined,
					requestMeta.agentUsed ?? undefined,
					apiKeyId ?? undefined,
					apiKeyName ?? undefined,
					requestMeta.project ?? null,
					undefined,
					requestMeta.comboName ?? null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.originalModel ?? null)
						: null,
					isModelRewrite(requestMeta.originalModel, requestMeta.appliedModel)
						? (requestMeta.appliedModel ?? null)
						: null,
					requestMeta.projectAttributionSource ?? null,
					requestMeta.agentAttributionSource ?? null,
				),
			);
			return {
				scope: "model",
				attemptedModel,
				family: attemptedModel ? getModelFamily(attemptedModel) : null,
				stopAccountAttempt: false,
			};
		};

		/**
		 * One raw-response classification boundary shared by the initial transport,
		 * every same-account model fallback, and every in-place 529 retry. Classified
		 * responses are finalized and drained exactly once here. Callers use the rich
		 * scope to decide whether to fail the account or continue with a candidate
		 * outside only the failed exact model / family.
		 */
		const handleRawAttemptFailure = async (
			failureResponse: Response,
			attemptedModel = currentTransportModel || effectiveBodyContext.getModel(),
		): Promise<RawAttemptFailureClassification> => {
			const classification =
				(await handlePaymentRequired402(failureResponse, attemptedModel)) ??
				(await handleExactModel429(failureResponse, attemptedModel)) ??
				(await handleScopedAnthropic429(failureResponse, attemptedModel));
			if (!classification) {
				return {
					scope: "not-classified",
					attemptedModel,
					family: attemptedModel ? getModelFamily(attemptedModel) : null,
					stopAccountAttempt: false,
				};
			}
			await finalizeCurrentCodexTransport(failureResponse);
			await discardUpstreamBody(failureResponse);
			return classification;
		};

		let rawFailureClassification = await handleRawAttemptFailure(rawResponse);
		if (rawFailureClassification.stopAccountAttempt) {
			return null;
		}
		const failedExactModels = new Set<string>();
		const failedFamilies = new Set<string>();
		const rememberScopedFailure = (
			classification: RawAttemptFailureClassification,
		): void => {
			if (classification.scope === "model" && classification.attemptedModel) {
				failedExactModels.add(classification.attemptedModel.toLowerCase());
			}
			if (classification.scope === "family" && classification.family) {
				failedFamilies.add(classification.family);
			}
		};
		const isScopedFailure = (
			classification: RawAttemptFailureClassification,
		): boolean =>
			classification.scope === "model" || classification.scope === "family";
		const candidateHasScopedFailure = (model: string): boolean => {
			if (failedExactModels.has(model.toLowerCase())) return true;
			const family = getModelFamily(model);
			if (family && failedFamilies.has(family)) return true;
			const betaSignature = req.headers.get("anthropic-beta");
			return (
				usageCache.getModelScopedExhaustion(
					account.id,
					model,
					betaSignature,
				) !== null ||
				usageCache.getFamilyScopedExhaustion(account.id, model) !== null
			);
		};
		rememberScopedFailure(rawFailureClassification);

		// Native xAI capacity/rate-limit signals (R5-R10) are a first-class,
		// account-level failover state, not a "try a different model" signal:
		// XAI_MODEL_MAPPINGS routes every Claude model alias to the same
		// underlying grok model, so cycling through the model list here would
		// never find a working alternative anyway. A 402 already bypasses the
		// isModelUnavailableError block below (402 is not in its checked status
		// list); this keeps 429 symmetric with 402 for xAI specifically, so both
		// fall through uniformly to the account-specific classification further
		// down (which awaits the durable cooldown write per R9 and honors
		// returnRateLimitedResponseOnExhaustion per AE4a), instead of being
		// consumed here by the generic fire-and-forget "all_models_exhausted_429"
		// path that unconditionally returns null. Every other provider's 429
		// handling (Qwen, OpenRouter, etc.) is unaffected.
		const isNativeXaiCapacityOrRateLimitSignal =
			account.provider === "xai" && rawResponse.status === 429;

		// On model unavailable / rate-limited: cycle through the model list for
		// this account. getModelList returns [primary, ...fallbacks] merged from
		// model_mappings arrays and legacy model_fallbacks. We already tried index 0
		// (the primary), so start at index 1.
		if (
			!isNativeXaiCapacityOrRateLimitSignal &&
			(await isModelUnavailableError(rawResponse, readAttemptBoundJson))
		) {
			// Log 429 response headers for debugging upstream rate-limit info
			if (rawResponse.status === 429) {
				const rlHeaders: Record<string, string> = {};
				rawResponse.headers.forEach((v, k) => {
					const lk = k.toLowerCase();
					if (
						lk.includes("rate") ||
						lk.includes("retry") ||
						lk.includes("limit") ||
						lk.includes("reset") ||
						lk.includes("x-") ||
						lk.includes("quota")
					) {
						rlHeaders[k] = v;
					}
				});
				log.debug(
					`Account ${account.name} received 429 — headers: ${JSON.stringify(rlHeaders)}`,
				);
			}
			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			if (requestedModel) {
				const modelList =
					modelFallbackPolicy?.implicitFallbacksEnabled === false
						? null
						: usesCodexAdmissionPlan
							? concreteCodexModels
							: getModelList(requestedModel, account);
				const fallbackStartIndex = usesCodexAdmissionPlan
					? admittedModelIndex + 1
					: 1;
				if (!modelList || fallbackStartIndex >= modelList.length) {
					if (isScopedFailure(rawFailureClassification)) {
						return null;
					}
					// No fallback models configured — fail over to the next account.
					// 429s should never be forwarded to the client when other
					// accounts are available; only genuine model-not-found
					// errors (404/400) warrant returning the upstream response.
					if (rawResponse.status === 429) {
						// Skip cooldown on synthetic cache-keepalive replays. The
						// keepalive scheduler fires parallel requests to every
						// cached account; a burst of 4+ simultaneous requests
						// trips Anthropic's per-IP burst limit and 429s every
						// account at the same instant. Applying real cooldowns
						// here drains the pool to zero routable accounts even
						// though no real user-facing rate limit was hit.
						const isKeepalive =
							req.headers.get("x-better-ccflare-keepalive") === "true";
						if (isKeepalive) {
							log.warn(
								`Keepalive replay for ${account.name} got 429 — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
							);
							await finalizeCurrentCodexTransport(rawResponse);
							await discardUpstreamBody(rawResponse);
							return null;
						}
						log.warn(
							`Account ${account.name} rate-limited (429), no model fallbacks — failing over to next account`,
						);
						const cooldownUntil = extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						);
						const reason: RateLimitReason = "model_fallback_429";
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						routingAttemptLedger?.blockAccount(account.id);
						const responseTime = Date.now() - requestMeta.timestamp;
						ctx.asyncWriter.enqueue(() =>
							ctx.dbOps.saveRequest(
								crypto.randomUUID(),
								req.method,
								url.pathname,
								account.id,
								429,
								false,
								reason,
								responseTime,
								failoverAttempts,
								requestedModel ? { model: requestedModel } : undefined,
								requestMeta.agentUsed ?? undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
								isModelRewrite(
									requestMeta.originalModel,
									requestMeta.appliedModel,
								)
									? (requestMeta.originalModel ?? null)
									: null,
								isModelRewrite(
									requestMeta.originalModel,
									requestMeta.appliedModel,
								)
									? (requestMeta.appliedModel ?? null)
									: null,
								requestMeta.projectAttributionSource ?? null,
								requestMeta.agentAttributionSource ?? null,
							),
						);
						await finalizeCurrentCodexTransport(rawResponse);
						await discardUpstreamBody(rawResponse);
						return null;
					}
					// Model-not-found (404/400) is forwarded to the client so it can
					// surface the real error. Strip content-encoding/content-length
					// first: Bun's fetch already decompressed the body, so leaving the
					// upstream `content-encoding: gzip` header makes the client try to
					// gunzip plaintext → "Decompression error: ZlibError".
					//
					// This is a final account-backed response returned OUTSIDE
					// forwardToClient, so record the serving account for the status-line
					// badge here too — otherwise a force-routed request that ends in
					// model-not-found leaves the badge showing a previously-served
					// account (skips synthetic keepalive/auto-refresh traffic).
					if (modelFallbackPolicy?.forwardModelUnavailableResponse === false) {
						log.warn(
							`Planned model ${requestedModel} unavailable on account ${account.name}; continuing the global model-first queue`,
						);
						await finalizeCurrentCodexTransport(rawResponse);
						if (routingAttemptLedger) {
							const retainedModelUnavailableResponse = rawResponse;
							await routingAttemptLedger.retainTerminalResponse({
								deliver: async () => {
									const retainedSessionId = sessionIdForObservation(
										req.headers,
									);
									if (retainedSessionId) {
										recordServedAccount(
											retainedSessionId,
											account.id,
											requestMeta.timestamp,
										);
									}
									return withSanitizedProxyHeaders(
										retainedModelUnavailableResponse,
									);
								},
								discard: () =>
									discardUpstreamBody(retainedModelUnavailableResponse),
							});
						} else {
							await discardUpstreamBody(rawResponse);
						}
						return null;
					}
					const observedSessionId = sessionIdForObservation(req.headers);
					if (observedSessionId) {
						recordServedAccount(
							observedSessionId,
							account.id,
							requestMeta.timestamp,
						);
					}
					await finalizeCurrentCodexTransport(rawResponse);
					return withSanitizedProxyHeaders(rawResponse);
				}

				let deferredFallbackRank = 0;
				for (let i = fallbackStartIndex; i < modelList.length; i++) {
					const nextModel = modelList[i];
					if (candidateHasScopedFailure(nextModel)) {
						log.info(
							`Skipping model ${nextModel} on account ${account.name} because the current request has scoped exhaustion evidence`,
						);
						continue;
					}
					const requestedFamily = getModelFamily(requestedModel);
					const nextFamily = getModelFamily(nextModel);
					if (
						modelFallbackPolicy?.deferImplicitFallback &&
						(requestedFamily === null || nextFamily !== requestedFamily)
					) {
						modelFallbackPolicy.deferImplicitFallback(
							nextModel,
							deferredFallbackRank++,
						);
						log.info(
							`Deferring implicit model fallback on account ${account.name}: ` +
								`requested_family=${requestedFamily ?? "unknown"} candidate_family=${nextFamily ?? "unknown"} model=${nextModel} until requested-family routes are exhausted`,
						);
						continue;
					}
					if (
						!admitConcreteCodexModel(
							account,
							nextModel,
							attemptAdmissionTracker,
						)
					) {
						continue;
					}
					log.info(
						`Model '${currentTransportModel}' unavailable/rate-limited on account ${account.name}, ` +
							`retrying with: ${nextModel} (${i}/${modelList.length - 1})`,
					);

					// Patch the original request body with the next model name, then let
					// transformRequestBody handle format conversion (e.g. Anthropic→OpenAI).
					// After that, re-patch the model name because transformRequestBody calls
					// mapModelName internally which remaps non-Claude names back to the primary
					// model (no family match → sonnet fallback). We always want nextModel to
					// reach the upstream provider verbatim.
					const patchedContext =
						effectiveBodyContext.withPatchedModel(nextModel);
					const patchedBody = patchedContext?.getBuffer() ?? null;
					if (!patchedBody) {
						log.warn("Failed to patch request body for model retry");
						break;
					}
					// getModelList returns concrete provider models, and the transformed
					// request is force-patched to this exact value below. Claim before
					// retry tracing/finalization so a duplicate skip has no side effects.
					if (
						routingAttemptLedger &&
						!routingAttemptLedger.claim(account.id, nextModel)
					) {
						if (attemptAdmissionTracker) {
							attemptAdmissionTracker.nonCapacitySkipCount++;
						}
						log.debug(
							`Skipping duplicate request-local model fallback account=${account.name} model=${nextModel}`,
						);
						continue;
					}
					if (routingAttemptLedger) {
						failoverAttempts = Math.max(
							failoverAttempts,
							routingAttemptLedger.attemptedCount - 1,
						);
					}
					const retryRequestInit: RequestInit & { duplex?: "half" } = {
						method: req.method,
						headers,
						body: new Uint8Array(patchedBody),
						duplex: "half",
					};

					if (!isScopedFailure(rawFailureClassification)) {
						await finalizeCurrentCodexTransport(rawResponse);
						await discardUpstreamBody(rawResponse);
					}
					stampCodexAttempt(headers, "model_fallback", nextModel);
					currentTransportModel = nextModel;
					// URL-model providers derive their physical transport from the
					// normalized retry source, so prepare and rebuild the URL for every
					// concrete fallback rather than reusing the primary model's URL.
					if (provider.prepareRequest) {
						provider.prepareRequest(req, patchedBody, account);
					}
					const retryTargetUrl = provider.buildUrl(
						url.pathname,
						url.search,
						account,
					);
					const retryProviderRequest = new Request(
						retryTargetUrl,
						retryRequestInit,
					);
					retrySourceRequest = retryProviderRequest.clone();
					let retryTransformedRequest = provider.transformRequestBody
						? await provider.transformRequestBody(retryProviderRequest, account)
						: retryProviderRequest;

					// Body-model conversions can remap nextModel back to the primary;
					// source/URL providers already resolved it during prepare/build above.
					retryTransformedRequest = await enforcePhysicalModelAfterTransform(
						retryTransformedRequest,
						nextModel,
					);
					retryTransformedTemplate = retryTransformedRequest.clone();

					// Fallback transforms need internal correlation metadata, but the
					// concrete transport request must never carry it upstream.
					const retryTransportRequest = sanitizeInternalTransportHeaders(
						retryTransformedRequest,
					);
					currentReplayBody = patchedBody;
					currentCacheIdentityHasCacheControl = undefined;
					// Attribution advances only once a concrete request is ready to
					// execute. A failed patch must leave it on the previous model.
					rawResponse = await executeCacheAwareProviderAttempt(
						retryTransportRequest,
						currentReplayBody,
						currentCacheIdentityHasCacheControl,
						currentTransportModel,
					);
					rawFailureClassification = await handleRawAttemptFailure(
						rawResponse,
						nextModel,
					);
					if (rawFailureClassification.stopAccountAttempt) {
						return null;
					}
					rememberScopedFailure(rawFailureClassification);
					if (isScopedFailure(rawFailureClassification)) continue;

					// isModelUnavailableError clones internally only when it must inspect a
					// 400/404 body. Passing a caller-created clone for a header-only 429
					// would strand a tee branch and prevent the later failover discard from
					// cancelling the upstream socket.
					if (
						!(await isModelUnavailableError(rawResponse, readAttemptBoundJson))
					) {
						break; // Success — stop cycling
					}
				}
			}

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
			if (await isModelUnavailableError(rawResponse, readAttemptBoundJson)) {
				if (isScopedFailure(rawFailureClassification)) {
					return null;
				}
				log.warn(
					`All models exhausted on account ${account.name}, failing over to next account`,
				);
				// Mark account rate-limited for 1 hour so that isAccountAvailable()
				// excludes it from future requests until the cooldown expires.
				// Without this write the DB state stays stale (rate_limited_until = null)
				// and the same account is retried on every subsequent request.
				// Only fire for genuine rate-limit responses (429); model-not-found
				// (404/400) is a configuration issue, not account exhaustion.
				if (rawResponse.status === 429) {
					// Same keepalive-skip as the no-fallback path above: synthetic
					// keepalive bursts can trip Anthropic's per-IP limit even when
					// individual accounts are healthy.
					const isKeepalive =
						req.headers.get("x-better-ccflare-keepalive") === "true";
					if (isKeepalive) {
						log.warn(
							`Keepalive replay for ${account.name} got 429 (post-model-list) — skipping cooldown`,
						);
					} else {
						const cooldownUntil = extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						);
						const reason: RateLimitReason = "all_models_exhausted_429";
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						routingAttemptLedger?.blockAccount(account.id);
						const responseTime = Date.now() - requestMeta.timestamp;
						ctx.asyncWriter.enqueue(() =>
							ctx.dbOps.saveRequest(
								crypto.randomUUID(),
								req.method,
								url.pathname,
								account.id,
								429,
								false,
								reason,
								responseTime,
								failoverAttempts,
								requestedModel ? { model: requestedModel } : undefined,
								requestMeta.agentUsed ?? undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
								isModelRewrite(
									requestMeta.originalModel,
									requestMeta.appliedModel,
								)
									? (requestMeta.originalModel ?? null)
									: null,
								isModelRewrite(
									requestMeta.originalModel,
									requestMeta.appliedModel,
								)
									? (requestMeta.appliedModel ?? null)
									: null,
								requestMeta.projectAttributionSource ?? null,
								requestMeta.agentAttributionSource ?? null,
							),
						);
					}
				}
				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				return null;
			}
		}

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID without needing the original request object.
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-better-ccflare-request-id", requestMeta.id);
		if (currentTransportAttemptId) {
			responseHeaders.set(
				"x-better-ccflare-attempt-id",
				currentTransportAttemptId,
			);
		}
		if (currentTransportModel) {
			responseHeaders.set(
				"x-better-ccflare-final-model",
				currentTransportModel,
			);
		}
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set(
				"x-better-ccflare-request-stream",
				internalRequestStream,
			);
		}
		const taggedRawResponse = new Response(rawResponse.body, {
			status: rawResponse.status,
			statusText: rawResponse.statusText,
			headers: responseHeaders,
		});

		// Process response (transform format, sanitize headers, etc.) using account-specific provider
		let response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
		);
		if (provider.name === "codex" && currentTransportAttemptId) {
			finalizedCodexAttemptIds.add(currentTransportAttemptId);
		}

		// Failover to next account on upstream 401 — credentials are invalid/expired
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) for account ${account.name}, failing over to next account`,
			);
			routingAttemptLedger?.blockAccount(account.id);
			await discardUnusedResponse(response, "auth_failed_401");
			return null;
		}

		// In-place retry for reset-less 529 (overloaded_error) — bounded attempts with
		// full-jitter exponential backoff before applying account cooldown. This prevents
		// all accounts cooling simultaneously under concurrency spikes. Skipped for
		// synthetic (keepalive / auto-refresh) requests to avoid loop amplification.
		if (response.status === 529 && !isSyntheticInternal) {
			const rlInfoClone = response.clone();
			const rlInfo = provider.parseRateLimit(rlInfoClone);
			// parseRateLimit only reads headers; it never touches the body. This
			// clone is otherwise an abandoned tee branch that would block a later
			// discardUnusedResponse/cancel() on `response` from ever settling (see
			// the comment on discardUnusedResponse above). Reuse the same helper
			// to release it: it is fire-and-forget internally, so calling it here
			// (before `response` itself has been consumed or cancelled) cannot
			// deadlock, unlike an unbounded cancel() would.
			await discardUnusedResponse(rlInfoClone, "rate_limit_probe_clone");
			if (rlInfo.isRateLimited && !rlInfo.resetTime) {
				const retryCfg = getOverloadRetryConfig();
				if (retryCfg.enabled && retryCfg.maxAttempts > 1) {
					for (let attempt = 1; attempt < retryCfg.maxAttempts; attempt++) {
						// Full-jitter backoff: sleep in [0, min(base * 2^attempt, max)]
						const cap = Math.min(
							retryCfg.baseMs * 2 ** attempt,
							retryCfg.maxMs,
						);
						const delayMs = Math.random() * cap;
						await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

						log.info(
							`Account ${account.name}: in-place retry ${attempt}/${retryCfg.maxAttempts - 1} after ${Math.round(delayMs)}ms for 529 overloaded_error`,
						);

						let retryTransport = sanitizeInternalTransportHeaders(
							retryTransformedTemplate.clone(),
						);
						if (provider.name === "codex" && provider.transformRequestBody) {
							const retryHeaders = new Headers(retrySourceRequest.headers);
							await drainSupersededResponse(response);
							stampCodexAttempt(
								retryHeaders,
								"overload_529",
								currentTransportModel ?? undefined,
							);
							const retrySource = new Request(retrySourceRequest.url, {
								method: retrySourceRequest.method,
								headers: retryHeaders,
								body: await retrySourceRequest.clone().arrayBuffer(),
							});
							let retryTransformed = await provider.transformRequestBody(
								retrySource,
								account,
							);
							if (currentTransportModel) {
								retryTransformed = await forceModelInTransformedRequest(
									retryTransformed,
									currentTransportModel,
								);
							}
							retryTransport =
								sanitizeInternalTransportHeaders(retryTransformed);
						} else {
							// Non-codex providers reach this loop too (the anthropic
							// provider marks bare 529 overloaded_error responses as rate
							// limited with no reset), and their superseded response would
							// otherwise be abandoned with a live body when `response` is
							// reassigned below.
							await discardUnusedResponse(
								response,
								"in_place_529_retry_superseded",
							);
						}
						const retryRaw = await executeCacheAwareProviderAttempt(
							retryTransport,
							currentReplayBody,
							currentCacheIdentityHasCacheControl,
							currentTransportModel,
						);
						const retryFailureClassification = await handleRawAttemptFailure(
							retryRaw,
							currentTransportModel || effectiveBodyContext.getModel(),
						);
						if (retryFailureClassification.scope !== "not-classified") {
							return null;
						}

						const retryTaggedHeaders = new Headers(retryRaw.headers);
						retryTaggedHeaders.set(
							"x-better-ccflare-request-id",
							requestMeta.id,
						);
						if (currentTransportAttemptId) {
							retryTaggedHeaders.set(
								"x-better-ccflare-attempt-id",
								currentTransportAttemptId,
							);
						}
						if (currentTransportModel) {
							retryTaggedHeaders.set(
								"x-better-ccflare-final-model",
								currentTransportModel,
							);
						}
						const retryTaggedRaw = new Response(retryRaw.body, {
							status: retryRaw.status,
							statusText: retryRaw.statusText,
							headers: retryTaggedHeaders,
						});
						const retryResponse = await provider.processResponse(
							retryTaggedRaw,
							account,
							req.headers,
						);

						await discardUpstreamBody(response);
						response = retryResponse;

						// If credentials expired mid-retry, break out and let the 401
						// failover guard below handle it (return null → try next account).
						if (retryResponse.status === 401) {
							break;
						}

						if (retryResponse.status !== 529) {
							log.info(
								`Account ${account.name}: 529 resolved on retry ${attempt} (status ${retryResponse.status})`,
							);
							break;
						}

						const retryRlInfoClone = retryResponse.clone();
						const retryRlInfo = provider.parseRateLimit(retryRlInfoClone);
						// Same reasoning as the outer parseRateLimit clone above: this is a
						// header-only read, and if the loop breaks out below without a
						// further iteration to drain `retryResponse` via arrayBuffer(),
						// nothing else would ever release this clone's tee branch.
						await discardUnusedResponse(
							retryRlInfoClone,
							"rate_limit_probe_clone_retry",
						);
						if (!retryRlInfo.isRateLimited || retryRlInfo.resetTime) {
							// Got a reset hint on retry — stop; let processProxyResponse apply cooldown
							break;
						}
					}
					if (response.status === 529) {
						log.warn(
							`Account ${account.name}: all ${retryCfg.maxAttempts - 1} in-place 529 retries exhausted, applying cooldown and failing over`,
						);
					}
				}
			}
		}

		// Re-check 401 after in-place retry — credentials might have been revoked
		// between the initial 529 and a retry response. The guard above only covered
		// the initial response; a retry 401 would have updated `response` and broken
		// out of the loop, so we need to catch it here before forwarding to the client.
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) on 529 retry for account ${account.name}, failing over to next account`,
			);
			routingAttemptLedger?.blockAccount(account.id);
			await discardUnusedResponse(response, "auth_failed_401_after_retry");
			return null;
		}

		// At this boundary provider.processResponse has already converted any
		// OpenAI-compatible upstream stream to downstream Anthropic Messages SSE.
		// Hold every such stream behind the same semantic replay boundary: a
		// transformed message_start/ping prelude is no more safe to expose than a
		// native one. Raw provider SSE is never parsed by the Anthropic classifier.
		//
		// Keep native Anthropic header-based rate-limit policy separate and ahead of
		// body access. processProxyResponse starts a background usage clone for
		// successful streams, and that tee sibling would make cancellation of a
		// pre-commit stall wait indefinitely. In Bun, merely reading Response.body
		// before a later classification clone can also disturb the retained branch.
		const officialCodexPrecommitSseRetryRouteEligible =
			provider.name === "codex" &&
			account.provider === "codex" &&
			url.pathname === "/v1/messages" &&
			!isSyntheticInternal &&
			isCodexSubscriptionEndpoint(targetUrl);
		const officialCodexCacheLaneRescueEligible =
			officialCodexPrecommitSseRetryRouteEligible &&
			typeof transformedBodyJson?.prompt_cache_key === "string" &&
			transformedBodyJson.prompt_cache_key.length > 0;
		let codexPrecommitRetryAttempted = false;
		while (true) {
			const isDownstreamAnthropicMessagesStream =
				isDownstreamAnthropicMessagesSse({
					method: req.method,
					path: url.pathname,
					requestHeaders: req.headers,
					response,
				});
			const isNativeAnthropicMessagesStream = isNativeAnthropicMessagesSse({
				method: req.method,
				path: url.pathname,
				providerName: provider.name,
				requestHeaders: req.headers,
				response,
			});
			const downstreamAnthropicResponseBody =
				isDownstreamAnthropicMessagesStream ? response.body : null;
			const nativeAnthropicHeadersAreRateLimited =
				isNativeAnthropicMessagesStream &&
				provider.parseRateLimit(response).isRateLimited;
			if (
				!isDownstreamAnthropicMessagesStream ||
				nativeAnthropicHeadersAreRateLimited ||
				!downstreamAnthropicResponseBody
			) {
				break;
			}
			const streamConfig = getAnthropicStreamRuntimeConfig();
			preCommitRescue?.activate();
			// Re-evaluate semantic finality at the gate, but never extend the
			// absolute deadline chosen before the corresponding real fetch.
			const gateCommitment = resolveAttemptCommitmentDeadline();
			let attemptCommitmentDeadlineAt = gateCommitment?.deadlineAt;
			if (latestTransportCommitment?.deadlineAt !== undefined) {
				attemptCommitmentDeadlineAt =
					attemptCommitmentDeadlineAt === undefined
						? latestTransportCommitment.deadlineAt
						: Math.min(
								attemptCommitmentDeadlineAt,
								latestTransportCommitment.deadlineAt,
							);
			}
			const attemptCommitmentStartedAt =
				latestTransportCommitment?.startedAt ?? gateCommitment?.startedAt;
			const attemptCommitmentBudgetMs =
				attemptCommitmentDeadlineAt === undefined ||
				attemptCommitmentStartedAt === undefined
					? streamConfig.meaningfulProgressTimeoutMs
					: Math.max(
							0,
							attemptCommitmentDeadlineAt - attemptCommitmentStartedAt,
						);
			// Split only this already-allocated candidate slice. The request-wide
			// deadline and any global fallback reserve remain unchanged, while the
			// first cache lane cannot consume the retry's bounded share.
			const cacheLaneRescueReserveMs =
				officialCodexCacheLaneRescueEligible &&
				!codexPrecommitRetryAttempted &&
				attemptCommitmentDeadlineAt !== undefined
					? getCodexCacheLaneRescueReserveMs(attemptCommitmentBudgetMs)
					: 0;
			const semanticCommitmentDeadlineAt =
				attemptCommitmentDeadlineAt === undefined
					? undefined
					: attemptCommitmentDeadlineAt - cacheLaneRescueReserveMs;
			try {
				const gatedBody = await gateAnthropicSsePreCommit(
					downstreamAnthropicResponseBody,
					{
						semanticTimeoutMs: streamConfig.semanticTimeoutMs,
						meaningfulProgressTimeoutMs:
							streamConfig.meaningfulProgressTimeoutMs,
						commitmentDeadlineAt: semanticCommitmentDeadlineAt,
						terminalGraceMs: streamConfig.terminalGraceMs,
						maxBufferedBytes: streamConfig.maxBufferedBytes,
						signal: activeAttemptCommitment?.signal ?? routingSignal,
					},
				);
				response = new Response(gatedBody, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
				break;
			} catch (error) {
				if (activeAttemptCommitment?.isPrivateDeadline()) {
					// The fetch and semantic gate share this candidate's private
					// commitment signal. Preserve that control-flow identity even when
					// aborting the transport makes reader.read() reject first; otherwise
					// the gate would report upstream_error and poison a healthy route.
					throw activeAttemptCommitment.deadlineError;
				}
				if (
					routingSignal.aborted ||
					req.signal.aborted ||
					error instanceof AnthropicPreCommitAbortedError
				) {
					throw error;
				}
				if (!(error instanceof AnthropicPreCommitStallError)) throw error;
				const isZeroMeaningfulCodexStall =
					error.errorType === undefined &&
					(error.reason === "semantic_timeout" ||
						error.reason === "meaningful_progress_timeout");
				const isRetryableCodexPrecommitSseError =
					error.reason === "transient_sse_error" &&
					error.errorType === "api_error";
				const remainingCandidateBudgetMs =
					attemptCommitmentDeadlineAt === undefined
						? Number.POSITIVE_INFINITY
						: attemptCommitmentDeadlineAt - Date.now();
				const hasBoundedCacheLaneRescueBudget =
					remainingCandidateBudgetMs > 0 &&
					(error.reason === "semantic_timeout" || cacheLaneRescueReserveMs > 0);
				const hasBoundedPrecommitSseRetryBudget =
					attemptCommitmentDeadlineAt !== undefined &&
					remainingCandidateBudgetMs > 0;
				let codexPrecommitRetryCause:
					| "cache_lane_rescue"
					| "precommit_sse_retry"
					| null = null;
				if (isZeroMeaningfulCodexStall && hasBoundedCacheLaneRescueBudget) {
					codexPrecommitRetryCause = "cache_lane_rescue";
				} else if (
					isRetryableCodexPrecommitSseError &&
					hasBoundedPrecommitSseRetryBudget
				) {
					codexPrecommitRetryCause = "precommit_sse_retry";
				}
				if (
					((codexPrecommitRetryCause === "cache_lane_rescue" &&
						officialCodexCacheLaneRescueEligible) ||
						(codexPrecommitRetryCause === "precommit_sse_retry" &&
							officialCodexPrecommitSseRetryRouteEligible)) &&
					!codexPrecommitRetryAttempted &&
					codexPrecommitRetryCause
				) {
					codexPrecommitRetryAttempted = true;
					const isPrecommitSseRetry =
						codexPrecommitRetryCause === "precommit_sse_retry";
					log.warn(
						isPrecommitSseRetry
							? "codex_precommit_sse_retry"
							: "codex_precommit_cache_lane_rescue",
						{
							requestId: requestMeta.id,
							accountId: account.id,
							attemptedModel: currentTransportModel,
							attemptCause: codexPrecommitRetryCause,
							reason: error.reason,
							bufferedBytes: error.bufferedBytes,
							framesSeen: error.framesSeen,
							validProtocolFramesSeen: error.validProtocolFramesSeen,
							commitmentDeadlineAt: semanticCommitmentDeadlineAt ?? null,
							transportCommitmentDeadlineAt:
								attemptCommitmentDeadlineAt ?? null,
							cacheLaneRescueReserveMs,
						},
					);

					// gateAnthropicSsePreCommit already cancelled its reader. This extra
					// best-effort cancel covers response implementations whose transformed
					// wrapper did not propagate reader cancellation synchronously.
					await discardUnusedResponse(
						response,
						isPrecommitSseRetry
							? "codex_precommit_sse_retry_superseded"
							: "codex_precommit_cache_lane_rescue_superseded",
					);
					const rescueHeaders = new Headers(retrySourceRequest.headers);
					stampCodexAttempt(
						rescueHeaders,
						codexPrecommitRetryCause,
						currentTransportModel ?? undefined,
					);
					const rescueRequestInit: RequestInit & { duplex?: "half" } = {
						method: retrySourceRequest.method,
						headers: rescueHeaders,
					};
					if (currentReplayBody) {
						rescueRequestInit.body = new Uint8Array(currentReplayBody);
						rescueRequestInit.duplex = "half";
					}
					const rescueSourceRequest = new Request(
						retrySourceRequest.url,
						rescueRequestInit,
					);
					retrySourceRequest = rescueSourceRequest.clone();
					let rescueTransformedRequest = provider.transformRequestBody
						? await provider.transformRequestBody(rescueSourceRequest, account)
						: rescueSourceRequest;
					rescueTransformedRequest = await enforcePhysicalModelAfterTransform(
						rescueTransformedRequest,
						currentTransportModel,
					);
					retryTransformedTemplate = rescueTransformedRequest.clone();
					const rescueBodyText = await rescueTransformedRequest.clone().text();
					currentCacheIdentityHasCacheControl =
						hasCacheControlHintInJsonText(rescueBodyText);
					const rescueTransportRequest = sanitizeInternalTransportHeaders(
						rescueTransformedRequest,
					);
					rawResponse = await executeCacheAwareProviderAttempt(
						rescueTransportRequest,
						currentReplayBody,
						currentCacheIdentityHasCacheControl,
						currentTransportModel,
					);
					rawFailureClassification = await handleRawAttemptFailure(
						rawResponse,
						currentTransportModel,
					);
					if (rawFailureClassification.stopAccountAttempt) return null;
					rememberScopedFailure(rawFailureClassification);
					if (isScopedFailure(rawFailureClassification)) return null;

					const rescueResponseHeaders = new Headers(rawResponse.headers);
					rescueResponseHeaders.set(
						"x-better-ccflare-request-id",
						requestMeta.id,
					);
					if (currentTransportAttemptId) {
						rescueResponseHeaders.set(
							"x-better-ccflare-attempt-id",
							currentTransportAttemptId,
						);
					}
					if (currentTransportModel) {
						rescueResponseHeaders.set(
							"x-better-ccflare-final-model",
							currentTransportModel,
						);
					}
					if (
						internalRequestStream === "true" ||
						internalRequestStream === "false"
					) {
						rescueResponseHeaders.set(
							"x-better-ccflare-request-stream",
							internalRequestStream,
						);
					}
					response = await provider.processResponse(
						new Response(rawResponse.body, {
							status: rawResponse.status,
							statusText: rawResponse.statusText,
							headers: rescueResponseHeaders,
						}),
						account,
						req.headers,
					);
					if (currentTransportAttemptId) {
						finalizedCodexAttemptIds.add(currentTransportAttemptId);
					}
					if (response.status === 401) {
						routingAttemptLedger?.blockAccount(account.id);
						await discardUnusedResponse(
							response,
							isPrecommitSseRetry
								? "auth_failed_401_after_precommit_sse_retry"
								: "auth_failed_401_after_cache_lane_rescue",
						);
						return null;
					}
					continue;
				}

				const candidateId = modelFallbackPolicy?.routeCandidateId ?? null;
				const failureReason = error.errorType
					? `anthropic_precommit_${error.reason}:${error.errorType}`
					: `anthropic_precommit_${error.reason}`;
				const routeCircuitPenalized =
					error.reason !== "semantic_timeout" &&
					error.reason !== "meaningful_progress_timeout";
				log.warn("anthropic_precommit_stall", {
					requestId: requestMeta.id,
					accountId: account.id,
					candidateId,
					attemptedModel: currentTransportModel,
					affinityLanePresent: requestMeta.affinityLaneKey != null,
					reason: error.reason,
					errorType: error.errorType ?? null,
					bufferedBytes: error.bufferedBytes,
					framesSeen: error.framesSeen,
					validProtocolFramesSeen: error.validProtocolFramesSeen,
					frameKindCounts: error.frameKindCounts,
					lastValidProtocolActivityAgeMs: error.lastValidProtocolActivityAgeMs,
					terminalEvidenceSeen: error.terminalEvidenceSeen,
					limitBytes: error.limitBytes ?? null,
					semanticTimeoutMs: streamConfig.semanticTimeoutMs,
					meaningfulProgressTimeoutMs: attemptCommitmentBudgetMs,
					commitmentDeadlineAt: semanticCommitmentDeadlineAt ?? null,
					transportCommitmentDeadlineAt: attemptCommitmentDeadlineAt ?? null,
					cacheLaneRescueReserveMs,
					terminalGraceMs: streamConfig.terminalGraceMs,
					routeCircuitPenalized,
				});
				if (
					error.errorType === "rate_limit_error" ||
					error.errorType === "overloaded_error"
				) {
					handleAnthropicSseRateLimit(
						account,
						currentTransportModel,
						error.errorType,
						response,
						requestMeta.id,
						{ ...ctx, provider },
						req.headers.get("anthropic-beta"),
					);
				}
				if (candidateId && routeCircuitPenalized) {
					ctx.strategy.reportCandidateFailure?.(requestMeta, {
						candidateId,
						reason: failureReason,
						suppressForMs: streamConfig.routeSuppressionMs,
					});
				}
				return null;
			}
		}

		// Check for rate limit using account-specific provider. A terminal response
		// that may be delivered now or deferred in the request-local ledger is
		// classified from a bounded clone so the original headers/body remain
		// untouched for the client. Native xAI treats 402/429 as capacity signals;
		// every provider retains the established 529 terminal contract.
		const isTerminalRateLimitStatus =
			response.status === 529 ||
			(account.provider === "xai" &&
				(response.status === 402 || response.status === 429));
		const shouldPreserveTerminalRateLimitResponse =
			isTerminalRateLimitStatus &&
			(returnRateLimitedResponseOnExhaustion || Boolean(routingAttemptLedger));
		const responseForRateLimitCheck = shouldPreserveTerminalRateLimitResponse
			? await boundResponseBodyForClassification(response.clone())
			: response;
		const isRateLimited = await processProxyResponse(
			responseForRateLimitCheck,
			account,
			{
				...ctx,
				provider,
			},
			requestMeta.id,
			requestMeta,
		);
		if (responseForRateLimitCheck !== response) {
			// The rate-limit check ran on a clone whose header-only use is done.
			// Release its tee branch so it cannot keep the original body's
			// cancellation pending elsewhere.
			await discardUnusedResponse(
				responseForRateLimitCheck,
				"rate_limit_check_clone",
			);
		}
		if (isRateLimited) {
			const comboNameAtAttempt = requestMeta.comboName ?? null;
			const forwardTerminalRateLimitResponse = (
				terminalResponse: Response,
				terminalFailoverAttempts: number,
			) =>
				forwardToClient(
					{
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						project: requestMeta.project,
						query: url.search || null,
						projectAttributionSource:
							requestMeta.projectAttributionSource ?? null,
						response: terminalResponse,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts: terminalFailoverAttempts,
						agentUsed: requestMeta.agentUsed,
						originalModel: requestMeta.originalModel,
						appliedModel: requestMeta.appliedModel,
						attemptedModel: currentTransportModel,
						agentAttributionSource: requestMeta.agentAttributionSource ?? null,
						comboName: comboNameAtAttempt,
						apiKeyId,
						apiKeyName,
						xaiCacheIdentityFingerprint:
							requestMeta.xaiCacheIdentityFingerprint,
						xaiCachePrefixFingerprint: requestMeta.xaiCachePrefixFingerprint,
						xaiCacheOfficialEndpoint,
						xaiCacheKeyPresent,
						cacheFlightRecorderConversationId:
							requestMeta.cacheFlightRecorderConversationId,
						cacheFlightRecorderEligible,
						cacheFlightRecorderNativeActive:
							requestMeta.xaiCacheNativeActive === true,
						routingMeta: requestMeta,
					},
					{ ...ctx, provider },
				);
			if (req.headers.get("x-better-ccflare-keepalive") !== "true") {
				routingAttemptLedger?.blockAccount(account.id);
			}
			if (returnRateLimitedResponseOnExhaustion && isTerminalRateLimitStatus) {
				log.warn(
					`Account ${account.name} returned final ${response.status} rate-limit/capacity response, forwarding upstream response instead of pool_exhausted`,
				);
				return forwardTerminalRateLimitResponse(response, failoverAttempts);
			}
			if (isTerminalRateLimitStatus && routingAttemptLedger) {
				const retainedResponse = response;
				await routingAttemptLedger.retainTerminalResponse({
					deliver: async (terminalFailoverAttempts) => {
						try {
							return await forwardTerminalRateLimitResponse(
								retainedResponse,
								terminalFailoverAttempts,
							);
						} catch (error) {
							await discardUnusedResponse(
								retainedResponse,
								"retained_terminal_delivery_failed",
							);
							throw error;
						}
					},
					discard: () =>
						discardUnusedResponse(
							retainedResponse,
							"retained_terminal_superseded",
						),
				});
				return null;
			}
			await discardUnusedResponse(response, "rate_limited_failover");
			return null; // Signal to try next account
		}

		// A concrete successful model disproves only matching reactive state. Keep
		// sibling-family and sibling-beta evidence intact.
		if (response.ok && currentTransportModel) {
			usageCache.clearModelScopedExhaustion(
				account.id,
				currentTransportModel,
				req.headers.get("anthropic-beta"),
			);
			usageCache.clearFamilyScopedExhaustion(account.id, currentTransportModel);
		}

		// Forward response to client
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				project: requestMeta.project,
				query: url.search || null,
				projectAttributionSource: requestMeta.projectAttributionSource ?? null,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
				agentUsed: requestMeta.agentUsed,
				originalModel: requestMeta.originalModel,
				appliedModel: requestMeta.appliedModel,
				attemptedModel: currentTransportModel,
				agentAttributionSource: requestMeta.agentAttributionSource ?? null,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				xaiCacheIdentityFingerprint: requestMeta.xaiCacheIdentityFingerprint,
				xaiCachePrefixFingerprint: requestMeta.xaiCachePrefixFingerprint,
				xaiCacheOfficialEndpoint,
				xaiCacheKeyPresent,
				cacheFlightRecorderConversationId:
					requestMeta.cacheFlightRecorderConversationId,
				cacheFlightRecorderEligible,
				cacheFlightRecorderNativeActive:
					requestMeta.xaiCacheNativeActive === true,
				routeCandidateId: modelFallbackPolicy?.routeCandidateId ?? null,
				routingMeta: requestMeta,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		if (
			routingSignal.aborted ||
			req.signal.aborted ||
			err instanceof AnthropicPreCommitAbortedError
		) {
			throw err;
		}
		if (err instanceof AnthropicPreCommitAttemptDeadlineError) {
			// This private candidate exhausted only its reserved slice of the shared
			// request budget. Fail over without pausing the account or reporting a
			// route-circuit failure.
			log.warn("anthropic_precommit_attempt_deadline", {
				requestId: requestMeta.id,
				accountId: account.id,
				candidateId: modelFallbackPolicy?.routeCandidateId ?? null,
				deadlineAt: err.deadlineAt,
				attemptCommitmentBudgetMs: err.budgetMs,
			});
			return null;
		}
		handleProxyError(err, account, log);
		return null;
	} finally {
		activeAttemptCommitment?.dispose();
	}
}

/**
 * Create a 503 Service Unavailable response when the account pool is exhausted.
 * All accounts are paused, rate-limited, or filtered out.
 * @param accounts - All accounts that were considered but are unavailable
 * @returns 503 response with pool_exhausted error and Retry-After header
 */
export function createPoolExhaustedResponse(accounts: Account[]): Response {
	const now = Date.now();

	// Build account info list
	const accountInfos = accounts.map((account) => {
		const reason = account.paused
			? "paused"
			: account.rate_limited_until && account.rate_limited_until > now
				? "rate_limited"
				: "unavailable";

		const availableAt =
			account.rate_limited_until && account.rate_limited_until > now
				? new Date(account.rate_limited_until).toISOString()
				: null;

		return {
			name: account.name,
			reason,
			available_at: availableAt,
		};
	});

	// Calculate next_available_at from earliest rate_limited_until
	const rateLimitedAccounts = accounts.filter(
		(account) => account.rate_limited_until && account.rate_limited_until > now,
	);
	const rateLimitedUntil = rateLimitedAccounts
		.map((account) => account.rate_limited_until)
		.filter((until): until is number => typeof until === "number");
	const earliestRateLimitedUntil =
		rateLimitedUntil.length > 0 ? Math.min(...rateLimitedUntil) : null;
	const nextAvailableAt =
		earliestRateLimitedUntil !== null
			? new Date(earliestRateLimitedUntil).toISOString()
			: null;

	// Calculate Retry-After header (seconds) directly from numeric min
	const retryAfterSeconds =
		earliestRateLimitedUntil !== null
			? Math.max(1, Math.round((earliestRateLimitedUntil - now) / 1000))
			: 60; // Default 60s if no cooldown info

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "pool_exhausted",
				message: ERROR_MESSAGES.POOL_EXHAUSTED,
				next_available_at: nextAvailableAt,
				accounts: accountInfos,
			},
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				"x-better-ccflare-pool-status": "exhausted",
			},
		},
	);
}
