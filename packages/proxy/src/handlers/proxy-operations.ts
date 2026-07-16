import {
	getInPlaceRetryDrainTimeoutMs,
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
	resolveCodexRequestModel,
	resolveModelContextCapability,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import { RequestBodyContext } from "../request-body-context";
import { forwardToClient } from "../response-handler";
import {
	recordServedAccount,
	sessionIdForObservation,
} from "../session-account-observer";
import { isModelRewrite } from "../worker-messages";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

const SYNTHETIC_RESPONSE_HEADER = "x-better-ccflare-synthetic-response";
const SYNTHETIC_STATUS_HEADER = "x-better-ccflare-synthetic-status";
const SYNTHETIC_RESPONSE_URL_PREFIX = "https://better-ccflare.local/";
const INTERNAL_TRANSPORT_HEADERS = [
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
] as const;
const ANTHROPIC_BILLING_HEADER = "x-anthropic-billing-header";
const TEST_CONTEXT_WINDOW_ENV =
	"CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW";

function getTestContextWindowOverride(): number | undefined {
	if (process.env.NODE_ENV !== "test") return undefined;
	const value = Number(process.env[TEST_CONTEXT_WINDOW_ENV]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface ContextAdmissionTracker {
	inputTokens: number;
	requestedMaxOutputTokens: number;
	rejectedCount: number;
	largestSafeLimit: number;
	attemptedCount: number;
	nonCapacitySkipCount: number;
}

export function createContextAdmissionTracker(
	inputTokens: number,
	requestedMaxOutputTokens: unknown,
): ContextAdmissionTracker {
	return {
		inputTokens,
		requestedMaxOutputTokens:
			typeof requestedMaxOutputTokens === "number" &&
			Number.isFinite(requestedMaxOutputTokens)
				? Math.max(0, Math.floor(requestedMaxOutputTokens))
				: 0,
		rejectedCount: 0,
		largestSafeLimit: 0,
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
	const decision = decideContextAdmission({
		inputTokens: tracker.inputTokens,
		effectiveContextWindow,
		requestedMaxOutputTokens: tracker.requestedMaxOutputTokens,
		safetyReserveTokens: 0,
	});
	if (decision.status !== "reject") return true;

	tracker.rejectedCount++;
	tracker.largestSafeLimit = Math.max(
		tracker.largestSafeLimit,
		decision.safeLimitTokens ?? 0,
	);
	log.info("Codex context admission rejected attempt", {
		accountId: account.id,
		model,
		outcome: "capacity_rejected",
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
): { admitted: boolean; model: string | null } {
	if (
		process.env.CCFLARE_CONTEXT_ADMISSION !== "1" ||
		account.provider !== "codex" ||
		!tracker ||
		!requestedModel
	) {
		return { admitted: true, model: requestedModel };
	}
	for (const model of getConcreteCodexModelList(account, requestedModel)) {
		if (admitConcreteCodexModel(account, model, tracker)) {
			return { admitted: true, model };
		}
	}
	return { admitted: false, model: null };
}

export function createContextLengthExceededResponse(
	tracker: ContextAdmissionTracker,
): Response {
	const occupied = tracker.inputTokens + tracker.requestedMaxOutputTokens;
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

export type CacheBodyStagingAction = "stage" | "discard" | "skip";

export interface CacheBodyStagingInput {
	requestId: string;
	accountId: string | null;
	providerName: string;
	body: ArrayBuffer | null;
	headers: Headers;
	path: string;
}

function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-better-ccflare-keepalive") ||
		!!headers.get("x-better-ccflare-auto-refresh")
	);
}

/**
 * Chooses how one provider attempt should affect cache-keepalive staging.
 * Synthetic non-Codex requests retain the historical truthy-header skip
 * semantics. Every Codex attempt discards any entry staged by an earlier
 * provider so a later response summary cannot promote stale failover residue.
 */
export function getCacheBodyStagingAction(
	headers: Headers,
	providerName: string,
): CacheBodyStagingAction {
	if (providerName === "codex") return "discard";
	if (isSyntheticInternalRequest(headers)) return "skip";
	return "stage";
}

/** Applies the cache-body staging policy for one account/provider attempt. */
export function applyCacheBodyStagingPolicy(
	input: CacheBodyStagingInput,
): CacheBodyStagingAction {
	const action = getCacheBodyStagingAction(input.headers, input.providerName);

	if (action === "stage") {
		cacheBodyStore.stageRequest(
			input.requestId,
			input.accountId,
			input.body,
			input.headers,
			input.path,
		);
	} else if (action === "discard") {
		cacheBodyStore.discardStaged(input.requestId);
	}

	return action;
}

/**
 * Determines the absolute epoch timestamp (ms since epoch) until which an account
 * should be marked rate-limited after model exhaustion. Priority:
 *   1. retry-after / x-ratelimit-reset response header (actual upstream backoff)
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

	// 1. Check retry-after / x-ratelimit-reset headers
	const retryAfter =
		response.headers.get("retry-after") ??
		response.headers.get("x-ratelimit-reset");
	if (retryAfter) {
		const parsed = Number(retryAfter);
		if (!Number.isNaN(parsed) && parsed > 0) {
			// Unix timestamp (seconds) if value looks like an epoch (> 1 billion)
			const isUnixTimestamp = parsed > 1_000_000_000;
			const epochMs = isUnixTimestamp ? parsed * 1000 : now + parsed * 1000;
			if (epochMs > now) {
				return Math.max(epochMs, now + MIN_COOLDOWN_MS);
			}
			// epochMs <= now: stale/already-past timestamp — fall through to next priority
		} else {
			// Try HTTP-date format (RFC 7231), e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
			const dateMs = new Date(retryAfter).getTime();
			if (!Number.isNaN(dateMs) && dateMs > now) {
				return Math.max(dateMs, now + MIN_COOLDOWN_MS);
			}
			// Invalid or past date — fall through to next priority
		}
	}

	// 2. Fall back to usage-window reset time if available
	const rateLimitedUntil = getRateLimitedUntil(accountId);
	if (rateLimitedUntil !== null && rateLimitedUntil > now) {
		return Math.max(rateLimitedUntil, now + MIN_COOLDOWN_MS);
	}

	// 3. Last resort: 1 hour
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
async function isInvalidThinkingSignatureError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const clone = response.clone();
		const contentType = response.headers.get("content-type");

		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();

		// Check for Claude's thinking-related errors
		if (json.error?.message && typeof json.error.message === "string") {
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
	} catch {
		// Ignore parse errors
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
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		const json = await response.clone().json();

		if (json.error?.message && typeof json.error.message === "string") {
			const message = json.error.message;
			return (
				message.includes("clear_thinking") &&
				message.includes("requires `thinking` to be enabled")
			);
		}
	} catch {
		// Ignore parse errors
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
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const clone = response.clone();
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();
		const message: string = json.error?.message ?? json.message ?? "";
		return (
			typeof message === "string" &&
			message.includes("cache_control") &&
			(message.includes("Extra inputs are not permitted") ||
				message.includes("unknown field"))
		);
	} catch {
		return false;
	}
}

/**
 * Checks if a response error indicates the requested model is unavailable.
 * Covers Anthropic (not_found_error), OpenAI-compat (model_not_found),
 * generic messages, and Bedrock (ResourceNotFoundException).
 */
export async function isModelUnavailableError(
	response: Response,
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

	try {
		const clone = response.clone();
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();

		// Anthropic native format
		if (json.error?.type === "not_found_error") return true;

		// OpenAI-compat format
		if (json.error?.code === "model_not_found") return true;

		// Generic: message contains "model not found" or "does not exist"
		if (
			json.error?.message &&
			typeof json.error.message === "string" &&
			(json.error.message.toLowerCase().includes("model not found") ||
				json.error.message.toLowerCase().includes("does not exist"))
		) {
			return true;
		}

		// Bedrock: ResourceNotFoundException
		if (
			json.error?.message &&
			typeof json.error.message === "string" &&
			json.error.message.includes("ResourceNotFoundException")
		) {
			return true;
		}
	} catch {
		// Ignore parse errors
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
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = sanitizeInternalHeaders(
		ctx.provider.prepareHeaders(req.headers, undefined, undefined),
	);

	try {
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);

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
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.provider.name,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
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
): Promise<Response | null> {
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
		const admission = selectAdmittedCodexModel(
			account,
			requestedModelBeforeAdmission,
			attemptAdmissionTracker,
		);
		if (!admission.admitted) return null;
		const admittedModelIndex = admission.model
			? concreteCodexModels.indexOf(admission.model)
			: -1;
		if (admission.model && admission.model !== requestedModelBeforeAdmission) {
			const admittedContext = effectiveBodyContext.withPatchedModel(
				admission.model,
			);
			if (admittedContext) {
				effectiveBodyContext = admittedContext;
				effectiveBodyBuffer = admittedContext.getBuffer();
			}
		}
		if (attemptAdmissionTracker) attemptAdmissionTracker.attemptedCount++;

		// Stage the original request body + headers for cache keepalive replay.
		// Uses the pre-transform body (effectiveBodyBuffer may have a model override
		// patched in, so use the original requestBodyBuffer for a faithful replay).
		// Headers are stored because Anthropic's prepareHeaders() copies incoming
		// client headers (anthropic-version, anthropic-beta, x-stainless-*, etc.)
		// and augments them — providers that build headers from scratch ignore them.
		// Skip staging for internal synthetic requests:
		//   - keepalive replays — prevent infinite loop
		//   - auto-refresh probes — same loop-prevention concern, plus these
		//     hit known-cooled accounts and shouldn't pollute the staged-body cache
		//     (issue #199, bug 2).
		// Ordinary Codex attempts also cannot be staged: the subscription endpoint
		// does not support the output cap used by keepalive replays. Discard instead
		// so failover from an earlier provider cannot leave promotable residue.
		// For non-Codex providers, both header checks are truthy (not
		// strict-equality) to preserve the original keepalive guard's behaviour:
		// any non-empty value skips staging, matching what
		// `!req.headers.get(...)` returned before.
		const isSyntheticInternal = isSyntheticInternalRequest(req.headers);
		applyCacheBodyStagingPolicy({
			requestId: requestMeta.id,
			accountId: account.id,
			providerName: provider.name,
			body: baseBodyContext.getBuffer(),
			headers: req.headers,
			path: url.pathname,
		});

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

		const isSyntheticCodexCountTokens =
			provider.name === "codex" && url.pathname === "/v1/messages/count_tokens";

		// Synthetic Codex count_tokens never calls upstream, so it should not require
		// or refresh OAuth credentials just to return an advisory local estimate.
		const accessToken = isSyntheticCodexCountTokens
			? ""
			: await getValidAccessToken(account, ctx);

		// Pre-process request if provider supports it (e.g., to extract model for URL)
		if (provider.prepareRequest) {
			provider.prepareRequest(req, effectiveBodyBuffer, account);
		}

		// Prepare request using account-specific provider
		const headers = provider.prepareHeaders(
			req.headers,
			accessToken,
			account.api_key || undefined,
		);
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

		// Pre-strip cache_control for (account, model) pairs known to reject it
		const transformedBodyText = await transformedRequest.clone().text();
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(transformedBodyText);
		} catch {
			// ignore
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ?? "";
		let currentTransportModel = transformedModel;
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
			transformedRequest = new Request(transformedRequest.url, {
				method: transformedRequest.method,
				headers: transformedRequest.headers,
				body: JSON.stringify(transformedBodyJson),
			});
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// Capture a clone for in-place 529 retries before the body is consumed.
		const transformedRequestForRetry = transformedRequest.clone();
		// The 529 in-place retry must resend the CURRENT physical transport, not
		// the original request: thinking/cache-control retries and model fallback
		// all replace the outbound body, and reverting silently changes the model.
		let retrySourceRequest = providerRequest;
		let retryTransformedTemplate = transformedRequestForRetry;

		// Make the request (or unwrap a synthetic provider response)
		let rawResponse = isSyntheticProviderResponse(transformedRequest)
			? materializeSyntheticResponse(transformedRequest)
			: await makeProxyRequest(transformedRequest);

		// Check if this is a Claude provider and we got an invalid thinking signature error
		if (
			isClaudeProvider &&
			(await isInvalidThinkingSignatureError(rawResponse))
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

				const retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;
				retryTransformedTemplate = retryTransformedRequest.clone();

				// Preserve internal metadata through the transform for tracing, then
				// strip it from the concrete transport request.
				const retryTransportRequest = sanitizeInternalTransportHeaders(
					retryTransformedTemplate.clone(),
				);
				// Make the retry request (or unwrap a synthetic provider response)
				rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
					? materializeSyntheticResponse(retryTransformedRequest)
					: await makeProxyRequest(retryTransportRequest);
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
			(await isClearThinkingRequiresThinkingError(rawResponse))
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

				const retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;
				retryTransformedTemplate = retryTransformedRequest.clone();

				const retryTransportRequest = sanitizeInternalTransportHeaders(
					retryTransformedTemplate.clone(),
				);
				rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
					? materializeSyntheticResponse(retryTransformedRequest)
					: await makeProxyRequest(retryTransportRequest);
			} else {
				log.warn(
					"No clear_thinking context edits to strip or filtering failed, proceeding with original error response",
				);
			}
		}

		// Retry without cache_control if provider rejected it (e.g. GLM-5.1 strict validation).
		// Mark (accountId, model) so subsequent requests skip cache_control immediately.
		if (await isCacheControlRejectionError(rawResponse)) {
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
					const retrySource = new Request(providerRequest.url, {
						method: providerRequest.method,
						headers: retryHeaders,
						body: JSON.stringify(retrySourceBody),
					});
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
					retryRequest = new Request(transformedRequest.url, {
						method: transformedRequest.method,
						headers: transformedRequest.headers,
						body: JSON.stringify(retryBodyJson),
					});
					retryTransformedTemplate = retryRequest.clone();
				}
				rawResponse = isSyntheticProviderResponse(retryRequest)
					? materializeSyntheticResponse(retryRequest)
					: await makeProxyRequest(retryRequest);
			} catch (err) {
				log.warn("Failed to retry without cache_control:", err);
			}
		}

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

		// On model unavailable / rate-limited: cycle through the model list for
		// this account. getModelList returns [primary, ...fallbacks] merged from
		// model_mappings arrays and legacy model_fallbacks. We already tried index 0
		// (the primary), so start at index 1.
		if (await isModelUnavailableError(rawResponse)) {
			// Tracks the concrete model used by the last fallback attempt so a
			// fallback out_of_credits response is scoped to that model, not the
			// originally requested model or the whole account.
			let finalAttemptModel: string | null = null;
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

			// ── out_of_credits: model/beta-scoped depletion, NOT account-wide (issue #261) ──
			// Anthropic returns 429 + `overage-disabled-reason: out_of_credits` with no reset
			// header. This is scoped to a specific model/beta (e.g. context-1m), not the
			// account — opus/haiku/plain-sonnet still succeed on the same account. So we do
			// NOT bench the account (no applyRateLimitCooldown, no consecutive increment):
			// fail over per-request and leave the account in rotation for other models.
			if (rawResponse.status === 429 && isAnthropicOutOfCredits(rawResponse)) {
				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				const isKeepalive =
					req.headers.get("x-better-ccflare-keepalive") === "true";
				if (isKeepalive) {
					return null;
				}
				const reason: RateLimitReason = "out_of_credits";
				if (requestedModel) {
					usageCache.markModelScopedExhausted(
						account.id,
						requestedModel,
						req.headers.get("anthropic-beta"),
					);
				}
				log.warn(
					`Account ${account.name} out_of_credits (429${requestedModel ? `, model=${requestedModel}` : ""}) — ` +
						`model/beta-scoped, NOT benching account; failing over to next account`,
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
						requestedModel ? { model: requestedModel } : undefined,
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
				return null;
			}

			if (requestedModel) {
				const modelList = attemptAdmissionTracker
					? concreteCodexModels
					: getModelList(requestedModel, account);
				const fallbackStartIndex = attemptAdmissionTracker
					? admittedModelIndex + 1
					: 1;
				if (!modelList || fallbackStartIndex >= modelList.length) {
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

				finalAttemptModel = requestedModel;
				for (let i = fallbackStartIndex; i < modelList.length; i++) {
					const nextModel = modelList[i];
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
						`Model '${modelList[i - 1]}' unavailable/rate-limited on account ${account.name}, ` +
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

					const retryRequestInit: RequestInit & { duplex?: "half" } = {
						method: req.method,
						headers,
						body: new Uint8Array(patchedBody),
						duplex: "half",
					};

					await finalizeCurrentCodexTransport(rawResponse);
					await discardUpstreamBody(rawResponse);
					stampCodexAttempt(headers, "model_fallback", nextModel);
					currentTransportModel = nextModel;
					const retryProviderRequest = new Request(targetUrl, retryRequestInit);
					retrySourceRequest = retryProviderRequest.clone();
					let retryTransformedRequest = provider.transformRequestBody
						? await provider.transformRequestBody(retryProviderRequest, account)
						: retryProviderRequest;

					// Re-patch model after transformRequestBody — the provider's conversion
					// (e.g. convertAnthropicRequestToOpenAI) calls mapModelName which can
					// remap nextModel back to the primary model if it has no Claude family
					// pattern. Force nextModel into the final request body.
					retryTransformedRequest = await forceModelInTransformedRequest(
						retryTransformedRequest,
						nextModel,
					);
					retryTransformedTemplate = retryTransformedRequest.clone();

					// Fallback transforms need internal correlation metadata, but the
					// concrete transport request must never carry it upstream.
					const retryTransportRequest = sanitizeInternalTransportHeaders(
						retryTransformedRequest,
					);
					// Attribution advances only once a concrete request is ready to
					// execute. A failed patch must leave it on the previous model.
					finalAttemptModel = nextModel;
					rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
						? materializeSyntheticResponse(retryTransformedRequest)
						: await makeProxyRequest(retryTransportRequest);

					if (!(await isModelUnavailableError(rawResponse.clone()))) {
						break; // Success — stop cycling
					}
				}
			}

			// A fallback model may itself return Anthropic out_of_credits. Re-run
			// scoped classification against the final response/model before
			// account-wide handling, otherwise one fallback benches the account.
			if (rawResponse.status === 429 && isAnthropicOutOfCredits(rawResponse)) {
				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				if (req.headers.get("x-better-ccflare-keepalive") === "true") {
					return null;
				}
				if (finalAttemptModel) {
					usageCache.markModelScopedExhausted(
						account.id,
						finalAttemptModel,
						req.headers.get("anthropic-beta"),
					);
				}
				log.warn(
					`Account ${account.name} out_of_credits (429${finalAttemptModel ? `, model=${finalAttemptModel}` : ""}) — model/beta-scoped after fallback, NOT benching account`,
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
						"out_of_credits",
						responseTime,
						failoverAttempts,
						finalAttemptModel ? { model: finalAttemptModel } : undefined,
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
				return null;
			}

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
			if (await isModelUnavailableError(rawResponse)) {
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
						const retryRaw = isSyntheticProviderResponse(retryTransport)
							? materializeSyntheticResponse(retryTransport.clone())
							: await makeProxyRequest(retryTransport);

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
			await discardUnusedResponse(response, "auth_failed_401_after_retry");
			return null;
		}

		// Check for rate limit using account-specific provider
		const responseForRateLimitCheck =
			returnRateLimitedResponseOnExhaustion && response.status === 529
				? response.clone()
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
			if (returnRateLimitedResponseOnExhaustion && response.status === 529) {
				log.warn(
					`Account ${account.name} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
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
						projectAttributionSource:
							requestMeta.projectAttributionSource ?? null,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						agentUsed: requestMeta.agentUsed,
						originalModel: requestMeta.originalModel,
						appliedModel: requestMeta.appliedModel,
						agentAttributionSource: requestMeta.agentAttributionSource ?? null,
						comboName: requestMeta.comboName,
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
					},
					{ ...ctx, provider },
				);
			}
			await discardUnusedResponse(response, "rate_limited_failover");
			return null; // Signal to try next account
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
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		handleProxyError(err, account, log);
		return null;
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
	const nextAvailableAt =
		rateLimitedAccounts.length > 0
			? new Date(
					Math.min(
						...rateLimitedAccounts.map(
							(account) => account.rate_limited_until!,
						),
					),
				).toISOString()
			: null;

	// Calculate Retry-After header (seconds) directly from numeric min
	const retryAfterSeconds =
		rateLimitedAccounts.length > 0
			? Math.max(
					1,
					Math.round(
						(Math.min(
							...rateLimitedAccounts.map(
								(account) => account.rate_limited_until!,
							),
						) -
							now) /
							1000,
					),
				)
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
