import {
	type AccountUsageSnapshot,
	getConfiguredModelMapping,
	getInPlaceRetryDrainTimeoutMs,
	getModelFamily,
	getModelList,
	getOverloadRetryConfig,
	isOfficialXaiEndpoint,
	isUsageExhausted,
	logError,
	ProviderError,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import type { RoutingAttemptData } from "@better-ccflare/database";
import {
	CODEX_LOGICAL_MODEL_FAMILY_HEADER,
	withSanitizedProxyHeaders,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { stripCacheControlFromOpenAIRequest } from "@better-ccflare/openai-formats";
import type { Provider, ProviderAttemptPlan } from "@better-ccflare/providers";
import {
	applyXaiConvIdHeader,
	buildServerToolCapabilityProofKey,
	CODEX_CONVERSATION_ID_HEADER,
	CODEX_TURN_STATE_HEADER,
	decideContextAdmission,
	estimateAnthropicAdmissionTokens,
	hasDeferredCustomTool,
	isAnthropicExtraUsageExhausted,
	isAnthropicOutOfCredits,
	isCodexSubscriptionEndpoint,
	materializeProviderAttemptPlan,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
	resolveCodexEndpoint,
	resolveCodexRequestModel,
	resolveModelContextCapability,
	resolveProviderForAccount,
	stripCodexReasoningRetention,
	suppressCodexExplicitCacheBreakpoint,
	usageCache,
} from "@better-ccflare/providers";
import {
	drainReader,
	getResponseDrainTransport,
	transferResponseDrainTransport,
} from "@better-ccflare/providers/stream-drain";
import type {
	Account,
	RequestMeta,
	ServerToolCapabilityDecision,
	ServerToolCapabilityTuple,
	ServerToolReplayAtom,
} from "@better-ccflare/types";
import {
	RECOVERY_SCOPE_HEADER,
	RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER,
} from "@better-ccflare/types/routing-recovery";
import { isNativeAnthropicOAuthDegradedModeEligible } from "../anthropic-degraded-eligibility";
import {
	type AnthropicDegradedAdmissionDecision,
	type AnthropicDegradedPermit,
	type AnthropicDegradedRequestAdmission,
	buildAnthropicDegradedCohortKey,
} from "../anthropic-degraded-mode";
import type {
	DegradedModeRequestTracker,
	DegradedModeSuppressionReason,
} from "../anthropic-degraded-observability";
import { AnthropicDegradedResponseLifecycle } from "../anthropic-degraded-response-lifecycle";
import { finishDegradedRequestFromPermitOutcome } from "../anthropic-degraded-runtime";
import {
	type AnthropicPreCommitRescueRouteContext,
	isSuccessfulAnthropicPreCommitRescueSse,
} from "../anthropic-precommit-rescue";
import {
	AnthropicPreCommitAbortedError,
	AnthropicPreCommitStallError,
	classifyAnthropicPreCommitWebSocketFailure,
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
import { isClaudeCodeSubagent } from "../claude-code-request";
import { ensureCodexModelDefaults } from "../codex-model-catalog";
import {
	type CodexWebSocketReceipt,
	codexWebSocketTransport,
	createCodexWebSocketNoReplayResponse,
} from "../codex-websocket-transport";

export type {
	CacheBodyStagingAction,
	CacheBodyStagingInput,
} from "../cache-transport-staging";
export {
	applyCacheBodyStagingPolicy,
	getCacheBodyStagingAction,
} from "../cache-transport-staging";

import type { BoundedModelRouteProfile } from "../model-route-profiles";
import {
	getPreTransportDeadlineConfig,
	PreTransportPhaseTimeoutError,
	runWithPreTransportDeadline,
} from "../pre-transport-deadline";
import { RequestBodyContext } from "../request-body-context";
import {
	forwardToClient,
	handleAnthropicSseRateLimit,
	type ResponseHandlerOptions,
} from "../response-handler";
import { evaluateServerToolReplayEligibility } from "../server-tool-replay-eligibility";
import {
	type RequestPrivateServerToolReplay,
	resolveRequestPrivateServerToolReplay,
} from "../server-tool-replay-runtime";
import { ServerToolCandidateCapabilityError } from "../server-tool-routing-errors";
import {
	recordServedAccount,
	sessionIdForObservation,
} from "../session-account-observer";
import { combineChunks } from "../stream-tee";
import { isModelRewrite } from "../worker-messages";
import {
	ForceRouteUnavailableError,
	getRouteProfileConstraintViolation,
	getXaiConvId,
} from "./account-selector";
import { cancelDiscardedResponseBody } from "./discard-body-cancel";
import {
	ERROR_MESSAGES,
	isInternalProbe,
	type ProxyContext,
} from "./proxy-types";
import {
	applyRateLimitCooldown,
	applyRateLimitCooldownAwaitingPersist,
} from "./rate-limit-cooldown";
import {
	boundedAccountHoldReset,
	classifyPreByte429,
	getAnthropicRateLimitResetAt,
	recordRequestRateLimitOutcome,
} from "./rate-limit-scope";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import {
	handleProxyError,
	processProxyResponse,
	type RateLimitObservation,
} from "./response-processor";
import { isRetryable429 } from "./retryable-429";
import type { DeterministicFailureCapabilityKey } from "./routing-attempt-ledger";
import {
	PhysicalAttemptBudgetExceededError,
	type RoutingAttemptLedger,
} from "./routing-attempt-ledger";
import { clampFiniteRoutingRecoveryRetryAfterSeconds } from "./routing-recovery-advice";
import { createProtectedAnthropicOverloadResponse } from "./routing-terminal";
import {
	canAttemptStaleTokenRefresh,
	clearStaleTokenRefreshState,
	getRefreshTokenUsedForFailure,
	getValidAccessToken,
	isStaleTokenRefreshCoolingDown,
	isTerminalTokenRefreshFailure,
	pauseAccountForUpstreamAuthFailure,
	refreshAccessTokenSafe,
	tryAcquireStaleTokenRefresh,
	upstreamAuthFailureReason,
} from "./token-manager";

const log = new Logger("ProxyOperations");

type RoutingAttemptWrite = Omit<RoutingAttemptData, "id">;

type CooldownState = Pick<
	Account,
	"rate_limited_until" | "rate_limited_at" | "rate_limited_reason"
>;

function captureCooldownState(account: Account): CooldownState {
	return {
		rate_limited_until: account.rate_limited_until,
		rate_limited_at: account.rate_limited_at,
		rate_limited_reason: account.rate_limited_reason,
	};
}

/** True only if this attempt changed the account's in-memory cooldown state. */
function appliedCooldown(account: Account, before: CooldownState): boolean {
	return (
		account.rate_limited_until !== before.rate_limited_until ||
		account.rate_limited_at !== before.rate_limited_at ||
		account.rate_limited_reason !== before.rate_limited_reason
	);
}

/**
 * Best-effort routing-failure telemetry. The immutable snapshot is created at
 * classification time, before it crosses the asynchronous writer boundary, so
 * database backpressure or failure can never influence routing or delivery.
 */
function enqueueRoutingAttempt(
	ctx: ProxyContext,
	attempt: RoutingAttemptWrite,
): void {
	const immutableAttempt = Object.freeze({
		id: crypto.randomUUID(),
		...attempt,
	});
	try {
		ctx.asyncWriter.enqueue(() => {
			try {
				return Promise.resolve(
					ctx.dbOps.saveRoutingAttempt(immutableAttempt),
				).catch((error: unknown) => {
					log.warn("Failed to persist routing attempt:", error);
				});
			} catch (error) {
				log.warn("Failed to enqueue routing attempt write:", error);
			}
		});
	} catch (error) {
		log.warn("Routing attempt writer rejected enqueue:", error);
	}
}

/**
 * Replace an upstream response with the stream released by the Anthropic
 * precommit gate while preserving ownership of that response's exact fetch.
 * The source body is already owned by the gate, so this handoff intentionally
 * reads only response metadata and never touches `sourceResponse.body`.
 */
export function wrapAnthropicPrecommitGatedResponse(
	sourceResponse: Response,
	gatedBody: ReadableStream<Uint8Array>,
): Response {
	const gatedResponse = new Response(gatedBody, {
		status: sourceResponse.status,
		statusText: sourceResponse.statusText,
		headers: sourceResponse.headers,
	});
	transferResponseDrainTransport(sourceResponse, gatedResponse);
	return gatedResponse;
}

/**
 * A provider-issued 401 gets one bounded same-account OAuth refresh/retry.  A
 * second 401 (or an API-key 401) is a credential failure, not a capacity
 * signal; the account is quarantined and the request fails over once.
 */
const STALE_TOKEN_MAX_RETRY = 1;

function shouldAttemptStaleTokenRefresh(
	account: Account,
	staleTokenRetryAttempt: number,
	isSyntheticInternal: boolean,
): boolean {
	if (
		staleTokenRetryAttempt >= STALE_TOKEN_MAX_RETRY ||
		isSyntheticInternal ||
		!canAttemptStaleTokenRefresh(account)
	)
		return false;
	return tryAcquireStaleTokenRefresh(account.id);
}

type HostedDispatchTerminalReason =
	| "ledger_missing"
	| "already_dispatched"
	| "ambiguous_transport";

/**
 * Request-local terminal raised only at or after the irreversible hosted-tool
 * boundary. It is deliberately not a candidate error: once a hosted dispatch
 * may have happened, no sibling route, retry loop, or guard replay is safe.
 */
class HostedDispatchTerminalError extends Error {
	readonly reason: HostedDispatchTerminalReason;

	constructor(reason: HostedDispatchTerminalReason, cause?: unknown) {
		super("Hosted server-tool dispatch is terminal for this request", {
			cause,
		});
		this.name = "HostedDispatchTerminalError";
		this.reason = reason;
	}
}

function createHostedDispatchTerminalResponse(
	error: HostedDispatchTerminalError,
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "api_error",
				code: "server_tool_dispatch_terminal",
				reason: error.reason,
				message:
					"The hosted server-tool attempt ended after its non-replayable dispatch boundary.",
			},
		}),
		{
			status: 502,
			headers: { "content-type": "application/json" },
		},
	);
}

interface AnthropicDegradedNoAccountSuppressionDecision {
	readonly action: "suppress";
	readonly wouldAction: "suppress";
	readonly enforced: true;
	readonly reservation: "denied";
	readonly reason: "no_eligible_account";
	readonly retryAfterSeconds: number;
}

type AnthropicDegradedSuppressionDecision =
	| Extract<AnthropicDegradedAdmissionDecision, { action: "suppress" }>
	| AnthropicDegradedNoAccountSuppressionDecision;

/**
 * Typed request-local stop signal from the physical-send boundary. Keeping the
 * current trusted response on the value (rather than draining it here) lets the
 * outer routing authority deliver it once and prevents every fallback surface
 * from interpreting suppression as an ordinary account miss.
 */
export interface AnthropicDegradedSendDenied {
	readonly kind: "anthropic_degraded_send_denied";
	readonly decision: AnthropicDegradedSuppressionDecision;
	readonly retainedTrustedResponse: Response | null;
}

export function createAnthropicDegradedNoAccountDenial(
	retryAfterSeconds: number,
): AnthropicDegradedSendDenied {
	return {
		kind: "anthropic_degraded_send_denied",
		decision: {
			action: "suppress",
			wouldAction: "suppress",
			enforced: true,
			reservation: "denied",
			reason: "no_eligible_account",
			retryAfterSeconds,
		},
		retainedTrustedResponse: null,
	};
}

export function isAnthropicDegradedSendDenied(
	value: unknown,
): value is AnthropicDegradedSendDenied {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "anthropic_degraded_send_denied"
	);
}

/**
 * U4 owns terminal response-lifecycle completion. U3 exposes the committed
 * fenced permit explicitly and never treats Response construction or headers
 * as proof of success.
 */
export interface AnthropicDegradedRequestSendState {
	readonly admission: AnthropicDegradedRequestAdmission;
	lifecycle: AnthropicDegradedResponseLifecycle | null;
	readonly tracker?: DegradedModeRequestTracker | null;
}

export type ProxyAccountResponseDisposition =
	| "ordinary"
	| "irreversible_no_replay";

export interface PreparedProxyAccountResponse {
	readonly kind: "prepared_proxy_account_response";
	readonly response: Response;
	readonly disposition: ProxyAccountResponseDisposition;
	readonly account: Account;
	readonly candidateId: string;
	/** Snapshot after this attempt has completed all implicit route discovery. */
	readonly isFinalAttempt: boolean;
	/** Whether an ordinary failure resumes the outer route queue. */
	readonly continueAfterOrdinaryFailure: boolean;
	/** Evaluated by the outer arbiter immediately before terminal ownership. */
	canSupersedeRetainedTerminal(): boolean;
	commit(): Promise<Response>;
	discard(reason?: string): Promise<void>;
}

export type ProxyWithAccountResult =
	| PreparedProxyAccountResponse
	| Response
	| null
	| AnthropicDegradedSendDenied;

export function isPreparedProxyAccountResponse(
	value: unknown,
): value is PreparedProxyAccountResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "prepared_proxy_account_response"
	);
}

class AnthropicDegradedSendDeniedError extends Error {
	constructor(readonly denial: AnthropicDegradedSendDenied) {
		super("Anthropic degraded mode denied a physical provider send");
		this.name = "AnthropicDegradedSendDeniedError";
	}
}

function degradedSuppressionReason(
	reason: AnthropicDegradedAdmissionDecision["reason"],
): DegradedModeSuppressionReason {
	switch (reason) {
		case "probe_not_ready":
			return "cohort_open";
		case "probe_in_flight":
			return "probe_busy";
		case "owner_mismatch":
			return "owner_mismatch";
		case "request_budget_spent":
			return "retry_exhausted";
		default:
			return "unknown";
	}
}

function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-better-ccflare-keepalive") ||
		!!headers.get("x-better-ccflare-auto-refresh")
	);
}

const SYNTHETIC_RESPONSE_HEADER = "x-better-ccflare-synthetic-response";
const SYNTHETIC_STATUS_HEADER = "x-better-ccflare-synthetic-status";
const SYNTHETIC_RESPONSE_URL_PREFIX = "https://better-ccflare.local/";
const INTERNAL_TRANSPORT_HEADER_PREFIX = "x-better-ccflare-";
const TRUSTED_SYNTHETIC_HEADER_PREFIX = "x-better-ccflare-synthetic-";
const CODEX_CACHE_LANE_RESCUE_RESERVE_MAX_MS = 30_000;
const CODEX_CACHE_LANE_RESCUE_RESERVE_DIVISOR = 4;
const TEST_CONTEXT_WINDOW_ENV =
	"CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW";

/**
 * Downstream proxy helpers still accept a Provider-shaped context. Bind that
 * request-local view to one immutable attempt plan so rate-limit, streaming,
 * usage, and response-finalization reads cannot drift back to the shared
 * provider singleton after transport planning.
 */
function bindProviderAttemptPlan(plan: ProviderAttemptPlan): Provider {
	const invalidDownstreamLifecycleCall = (method: string): never => {
		throw new Error(
			`Provider lifecycle method ${method} is unavailable on an attempt-bound proxy context`,
		);
	};
	const boundProvider: Provider = {
		name: plan.providerName,
		cacheReplayModelStrategy: plan.cacheReplayModelStrategy,
		canHandle: () => invalidDownstreamLifecycleCall("canHandle"),
		refreshToken: async () => invalidDownstreamLifecycleCall("refreshToken"),
		buildUrl: () => plan.targetUrl,
		prepareHeaders: (headers, accessToken, apiKey) =>
			plan.prepareHeaders(headers, accessToken, apiKey),
		transformRequestBody: (request) => plan.transformRequestBody(request),
		processResponse: (response, _account, requestHeaders, drainAbort) =>
			plan.processResponse(response, requestHeaders, drainAbort),
		parseRateLimit: (response) => plan.parseRateLimit(response),
		...(plan.parseRateLimitFromBody
			? { parseRateLimitFromBody: plan.parseRateLimitFromBody }
			: {}),
		...(plan.isStreamingResponse
			? { isStreamingResponse: plan.isStreamingResponse }
			: {}),
		...(plan.extractTierInfo ? { extractTierInfo: plan.extractTierInfo } : {}),
		...(plan.extractUsageInfo
			? { extractUsageInfo: plan.extractUsageInfo }
			: {}),
		...(plan.parseUsage ? { parseUsage: plan.parseUsage } : {}),
	};
	return Object.freeze(boundProvider);
}

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

const MAX_UPSTREAM_EVIDENCE_BODY_CHARS = 512;
const MAX_UPSTREAM_EVIDENCE_BODY_BYTES = MAX_UPSTREAM_EVIDENCE_BODY_CHARS * 4;
const MAX_UPSTREAM_EVIDENCE_JSON_CHARS = 2048;
const MAX_UPSTREAM_EVIDENCE_HEADERS = 12;
const MAX_UPSTREAM_EVIDENCE_HEADER_VALUE_CHARS = 128;
// Diagnostics must never make a failover wait on a stalled upstream body.
const UPSTREAM_EVIDENCE_BODY_CAPTURE_DEADLINE_MS = 50;
const UPSTREAM_EVIDENCE_HEADER_NAMES = new Set([
	"retry-after",
	"x-should-retry",
	"request-id",
	"cf-ray",
	"content-type",
]);
const UPSTREAM_EVIDENCE_HEADER_PREFIXES = [
	"anthropic-ratelimit-",
	"x-ratelimit-",
] as const;
const UPSTREAM_EVIDENCE_SENSITIVE_HEADER_PARTS = [
	"authorization",
	"cookie",
	"token",
	"secret",
	"key",
	"credential",
	"session",
	"password",
] as const;
let upstreamEvidencePayloadSuppressionLogged = false;

function stripTrailingUnpairedHighSurrogate(value: string): string {
	const lastCodeUnit = value.charCodeAt(value.length - 1);
	return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
		? value.slice(0, -1)
		: value;
}

function truncateEvidenceText(value: string, maxChars: number): string {
	return stripTrailingUnpairedHighSurrogate(value.slice(0, maxChars));
}

function isUpstreamEvidenceHeader(name: string): boolean {
	if (
		UPSTREAM_EVIDENCE_SENSITIVE_HEADER_PARTS.some((part) => name.includes(part))
	) {
		return false;
	}
	return (
		UPSTREAM_EVIDENCE_HEADER_NAMES.has(name) ||
		UPSTREAM_EVIDENCE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
	);
}

function serializeUpstreamEvidence(
	status: number,
	headers: Record<string, string>,
	bodySnippet: string | null,
): string {
	const boundedHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const candidate = { ...boundedHeaders, [name]: value };
		if (
			JSON.stringify({
				status,
				headers: candidate,
				...(bodySnippet === null ? {} : { body_snippet: "" }),
			}).length <= MAX_UPSTREAM_EVIDENCE_JSON_CHARS
		) {
			boundedHeaders[name] = value;
		}
	}

	let boundedBodySnippet =
		bodySnippet === null
			? null
			: stripTrailingUnpairedHighSurrogate(bodySnippet);
	let serialized = JSON.stringify({
		status,
		headers: boundedHeaders,
		...(boundedBodySnippet === null
			? {}
			: { body_snippet: boundedBodySnippet }),
	});
	while (
		boundedBodySnippet !== null &&
		serialized.length > MAX_UPSTREAM_EVIDENCE_JSON_CHARS &&
		boundedBodySnippet.length > 0
	) {
		boundedBodySnippet = stripTrailingUnpairedHighSurrogate(
			boundedBodySnippet.slice(0, -1),
		);
		serialized = JSON.stringify({
			status,
			headers: boundedHeaders,
			...(boundedBodySnippet === null
				? {}
				: { body_snippet: boundedBodySnippet }),
		});
	}
	return serialized;
}

function handOffEvidenceReaderToDiscardDrain(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	response: Response,
	pendingRead?: Promise<unknown>,
	deadlineMs = getInPlaceRetryDrainTimeoutMs(),
): void {
	const transportAbort = getResponseDrainTransport(response);
	transportAbort?.abort(
		new Error("Upstream evidence body capture deadline exceeded"),
	);
	try {
		// Transformed provider streams use cancel as their public release signal;
		// their own cleanup resolves the explicit exact-transport controller.
		void reader.cancel().catch(() => {});
	} catch {
		// The reader may already have errored after the transport abort.
	}
	const drain = () => {
		void drainReader(reader, {
			deadlineMs,
			transportAbort,
		}).catch(() => {});
	};
	if (pendingRead) {
		void pendingRead.then(drain, drain);
	} else {
		drain();
	}
}

/** Capture bounded diagnostics only from a body that will be discarded. */
async function captureSanitizedUpstreamEvidence(
	ctx: ProxyContext,
	response: Response,
	{ consumeOriginalBody = false }: { consumeOriginalBody?: boolean } = {},
): Promise<string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of response.headers) {
		const lowerName = name.toLowerCase();
		if (!isUpstreamEvidenceHeader(lowerName)) continue;
		headers[lowerName] = truncateEvidenceText(
			value,
			MAX_UPSTREAM_EVIDENCE_HEADER_VALUE_CHARS,
		);
		if (Object.keys(headers).length === MAX_UPSTREAM_EVIDENCE_HEADERS) break;
	}

	const shouldCaptureBody = consumeOriginalBody && response.status >= 400;
	const shouldStorePayloads = ctx.config.getStorePayloads?.() ?? true;
	if (shouldCaptureBody && !shouldStorePayloads) {
		if (!upstreamEvidencePayloadSuppressionLogged) {
			upstreamEvidencePayloadSuppressionLogged = true;
			log.info(
				"Upstream evidence body snippet suppressed because payload storage is disabled",
			);
		}
		return serializeUpstreamEvidence(response.status, headers, null);
	}
	if (!shouldCaptureBody) {
		return serializeUpstreamEvidence(response.status, headers, null);
	}

	let bodySnippet: string | null = null;
	const body = response.body;
	if (!body)
		return serializeUpstreamEvidence(response.status, headers, bodySnippet);

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const captureDeadlineAt =
		performance.now() + UPSTREAM_EVIDENCE_BODY_CAPTURE_DEADLINE_MS;
	let bytesRead = 0;
	let handOffToDiscardDrain = false;
	let pendingRead: ReturnType<typeof reader.read> | undefined;
	bodySnippet = "";
	try {
		while (
			bodySnippet.length < MAX_UPSTREAM_EVIDENCE_BODY_CHARS &&
			bytesRead < MAX_UPSTREAM_EVIDENCE_BODY_BYTES
		) {
			const remainingMs = captureDeadlineAt - performance.now();
			if (remainingMs <= 0) {
				handOffToDiscardDrain = true;
				break;
			}
			let readTimeout: ReturnType<typeof setTimeout> | undefined;
			const currentRead = reader.read();
			pendingRead = currentRead;
			const readResult = await Promise.race([
				currentRead,
				new Promise<null>((resolve) => {
					readTimeout = setTimeout(() => resolve(null), remainingMs);
				}),
			]);
			if (readTimeout !== undefined) clearTimeout(readTimeout);
			if (readResult === null) {
				handOffToDiscardDrain = true;
				break;
			}
			pendingRead = undefined;
			const { done, value } = readResult;
			if (done) {
				bodySnippet += truncateEvidenceText(
					decoder.decode(),
					MAX_UPSTREAM_EVIDENCE_BODY_CHARS - bodySnippet.length,
				);
				break;
			}
			if (!value) continue;

			const remainingBytes = MAX_UPSTREAM_EVIDENCE_BODY_BYTES - bytesRead;
			const boundedChunk = value.subarray(0, remainingBytes);
			bodySnippet += truncateEvidenceText(
				decoder.decode(boundedChunk, { stream: true }),
				MAX_UPSTREAM_EVIDENCE_BODY_CHARS - bodySnippet.length,
			);
			bytesRead += boundedChunk.byteLength;
			if (
				boundedChunk.byteLength < value.byteLength ||
				bodySnippet.length === MAX_UPSTREAM_EVIDENCE_BODY_CHARS ||
				bytesRead === MAX_UPSTREAM_EVIDENCE_BODY_BYTES
			) {
				bodySnippet += truncateEvidenceText(
					decoder.decode(),
					MAX_UPSTREAM_EVIDENCE_BODY_CHARS - bodySnippet.length,
				);
				handOffToDiscardDrain = true;
				break;
			}
		}
	} catch {
		// Evidence is best-effort: failed reads must not alter failover.
	} finally {
		if (handOffToDiscardDrain) {
			handOffEvidenceReaderToDiscardDrain(
				reader,
				response,
				pendingRead,
				UPSTREAM_EVIDENCE_BODY_CAPTURE_DEADLINE_MS,
			);
		} else {
			try {
				reader.releaseLock();
			} catch {
				// The reader may already be released after an upstream read failure.
			}
		}
	}

	return serializeUpstreamEvidence(response.status, headers, bodySnippet);
}

type RawAttemptFailureScope = "not-classified" | "account" | "model" | "family";

interface RawAttemptFailureClassification {
	readonly scope: RawAttemptFailureScope;
	readonly attemptedModel: string | null;
	readonly family: string | null;
	/** Stop this account attempt even when the evidence itself is model-scoped. */
	readonly stopAccountAttempt: boolean;
	/** The caller or request ledger owns this response body until delivery/discard. */
	readonly retainedTerminalResponse?: boolean;
	/** Preserve the legacy direct-call contract when no request ledger is supplied. */
	readonly returnOriginalResponse?: boolean;
}

function getTestContextWindowOverride(): number | undefined {
	if (process.env.NODE_ENV !== "test") return undefined;
	const value = Number(process.env[TEST_CONTEXT_WINDOW_ENV]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface ContextAdmissionTracker {
	inputTokens: number;
	estimateMethod: string;
	estimateConfidence: ContextAdmissionEstimateConfidence;
	requestId?: string;
	requestedMaxOutputTokens: number;
	rejectedCount: number;
	/** Safe limit and occupied total are always retained from the same rejection. */
	largestSafeLimit: number;
	terminalOccupiedTokens: number;
	attemptedCount: number;
	nonCapacitySkipCount: number;
}

export type ContextAdmissionEstimateConfidence =
	| "low"
	| "calibrated"
	| "authoritative";

export interface ContextAdmissionEstimate {
	readonly tokens: number;
	readonly method: string;
	readonly confidence: ContextAdmissionEstimateConfidence;
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
	/** Defer final forwarding until the request scheduler chooses the winner. */
	readonly prepareFinalResponse?: boolean;
	/** A scheduler-promoted/deferred miss must resume its untouched queue tail. */
	readonly continueAfterPreparedFailure?: boolean;
	/**
	 * A globally deferred physical-model route may outlive replacement of the
	 * selector sidecar that admitted its source candidate. It must recompute an
	 * exact proof instead of trusting the newer unrelated sidecar.
	 */
	readonly recomputeServerToolCapability?: boolean;
	/** Request-scoped Anthropic downstream rescue; absent for ordinary routing. */
	readonly anthropicPreCommitRescue?: AnthropicPreCommitRescueRouteContext;
	readonly deferImplicitFallback?: (
		model: string,
		fallbackRank: number,
	) => void;
	/**
	 * Bind a legacy message-only context overflow to the exact queued
	 * known-larger Codex model selected for its one permitted replay.
	 */
	readonly preferContextOverflowFallback?: (model: string) => void;
	readonly implicitFallbacksEnabled?: boolean;
	/** A planned non-final candidate must not terminate the global route queue. */
	readonly forwardModelUnavailableResponse?: boolean;
	/**
	 * Request-semantic finality is independent of response forwarding. Evaluate
	 * immediately before each transport/gate because deferred work may be
	 * discovered while proxyWithAccount is already running.
	 */
	readonly isFinalSemanticAttempt?: () => boolean;
	/**
	 * Narrow replay policy for authoritative Codex context overflow. This may
	 * include a pending post-combo route without changing generic stall/deadline
	 * finality for the current transport.
	 */
	readonly canReplayContextOverflow?: () => boolean;
	/**
	 * Pre-override model (effectiveModel at selection time) when a combo
	 * slot's model override applies to this attempt; null/absent for a plain
	 * route, an implicit-fallback route, or the post-combo fallback re-route.
	 * Populated only by the genuine combo-slot call site in proxy.ts so the
	 * combo-vs-implicit-fallback distinction never has to be inferred from
	 * modelOverride alone.
	 */
	readonly comboModelOverrideFrom?: string | null;
}

export function createContextAdmissionTracker(
	estimate: ContextAdmissionEstimate,
	requestedMaxOutputTokens: unknown,
	requestId?: string,
): ContextAdmissionTracker {
	const inputTokens =
		typeof estimate.tokens === "number" && Number.isFinite(estimate.tokens)
			? Math.max(0, Math.floor(estimate.tokens))
			: 0;
	const sanitizedRequestedMaxOutputTokens =
		typeof requestedMaxOutputTokens === "number" &&
		Number.isFinite(requestedMaxOutputTokens)
			? Math.max(0, Math.floor(requestedMaxOutputTokens))
			: 0;
	return {
		inputTokens,
		estimateMethod: estimate.method,
		estimateConfidence: estimate.confidence,
		...(requestId && { requestId }),
		requestedMaxOutputTokens: sanitizedRequestedMaxOutputTokens,
		rejectedCount: 0,
		largestSafeLimit: 0,
		terminalOccupiedTokens: inputTokens + sanitizedRequestedMaxOutputTokens,
		attemptedCount: 0,
		nonCapacitySkipCount: 0,
	};
}

type ContextAdmissionOutcome =
	| "admit"
	| "capacity_rejected"
	| "defer_low_confidence";

function logContextAdmissionDecision(input: {
	account: Account;
	model: string;
	endpointClass: "subscription" | "custom";
	tracker: ContextAdmissionTracker;
	decision: ReturnType<typeof decideContextAdmission>;
	outcome: ContextAdmissionOutcome;
}): void {
	const data = {
		...(input.tracker.requestId && { requestId: input.tracker.requestId }),
		accountId: input.account.id,
		model: input.model,
		endpointClass: input.endpointClass,
		estimateMethod: input.tracker.estimateMethod,
		estimateConfidence: input.tracker.estimateConfidence,
		estimatedInputTokens: input.decision.inputTokens,
		outputReserveTokens: input.decision.outputReserveTokens,
		occupiedTokens: input.decision.occupiedTokens,
		safeLimitTokens: input.decision.safeLimitTokens ?? 0,
		outcome: input.outcome,
	};
	if (input.outcome === "admit") {
		log.debug("context_admission_decision", data);
		return;
	}
	log.info("context_admission_decision", data);
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
	const subscriptionEndpoint = isCodexSubscriptionEndpoint(resolvedEndpoint);
	// Match CodexProvider.transformRequestBody's concrete wire contract. The
	// ChatGPT subscription endpoint deletes max_output_tokens; API-compatible
	// custom endpoints retain the sanitized Anthropic max_tokens value.
	const outputReserveTokens = subscriptionEndpoint
		? 0
		: tracker.requestedMaxOutputTokens;
	const endpointClass = subscriptionEndpoint ? "subscription" : "custom";
	const decision = decideContextAdmission({
		inputTokens: tracker.inputTokens,
		effectiveContextWindow,
		requestedMaxOutputTokens: outputReserveTokens,
		safetyReserveTokens: 0,
	});
	if (decision.status !== "reject") {
		logContextAdmissionDecision({
			account,
			model,
			endpointClass,
			tracker,
			decision,
			outcome: "admit",
		});
		return true;
	}
	// A low-confidence estimate is useful for ordering and telemetry, but it is
	// not a safe local rejection bound. Defer ambiguous capacity decisions to
	// the concrete provider, which can return an authoritative context error.
	if (tracker.estimateConfidence === "low") {
		logContextAdmissionDecision({
			account,
			model,
			endpointClass,
			tracker,
			decision,
			outcome: "defer_low_confidence",
		});
		return true;
	}

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
	logContextAdmissionDecision({
		account,
		model,
		endpointClass,
		tracker,
		decision,
		outcome: "capacity_rejected",
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

function isKnownLargerCodexCandidate(
	currentModel: string,
	candidateModel: string,
): boolean {
	const currentCapability = resolveModelContextCapability(
		"codex",
		currentModel,
	);
	if (!currentCapability) return false;
	const candidateCapability = resolveModelContextCapability(
		"codex",
		candidateModel,
	);
	return (
		candidateCapability !== undefined &&
		candidateCapability.effectiveContextWindow >
			currentCapability.effectiveContextWindow
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

type BoundedModelRouteAdmissionErrorCode =
	| "bounded_profile_invalid_request"
	| "bounded_profile_deferred_tools_unsupported"
	| "bounded_profile_context_length_exceeded";

interface BoundedModelRouteAdmissionBase {
	readonly profileId: string;
	readonly contextWindow: number;
	readonly requestedMaxOutputTokens: number | null;
	readonly effectiveMaxOutputTokens: number | null;
	readonly outputReserveTokens: number | null;
	readonly estimatedInputTokens: number | null;
	readonly occupiedTokens: number | null;
	readonly clamped: boolean;
}

export type BoundedModelRouteAdmissionDecision =
	| (BoundedModelRouteAdmissionBase & {
			readonly status: "admit";
			readonly code: null;
	  })
	| (BoundedModelRouteAdmissionBase & {
			readonly status: "reject";
			readonly code: BoundedModelRouteAdmissionErrorCode;
	  });

function boundedModelRouteAdmissionBase(
	profile: BoundedModelRouteProfile,
): BoundedModelRouteAdmissionBase {
	return {
		profileId: profile.id,
		contextWindow: profile.contextWindow,
		requestedMaxOutputTokens: null,
		effectiveMaxOutputTokens: null,
		outputReserveTokens: null,
		estimatedInputTokens: null,
		occupiedTokens: null,
		clamped: false,
	};
}

/**
 * Applies the fixed output cap and fail-closed envelope admission for an already
 * resolved bounded exact profile. This deliberately uses the numeric conservative
 * estimate even though the shared estimator labels its confidence as low; bounded
 * profiles are a local capacity contract, unlike optional Codex admission.
 */
export function admitBoundedModelRouteProfileRequest(
	profile: BoundedModelRouteProfile,
	bodyContext: RequestBodyContext,
): BoundedModelRouteAdmissionDecision {
	const base = boundedModelRouteAdmissionBase(profile);
	const parsedBody = bodyContext.getParsedJson();
	if (hasDeferredCustomTool(parsedBody)) {
		return {
			...base,
			status: "reject",
			code: "bounded_profile_deferred_tools_unsupported",
		};
	}

	const requestedMaxOutputTokens = parsedBody?.max_tokens;
	if (
		!parsedBody ||
		!Array.isArray(parsedBody.messages) ||
		typeof requestedMaxOutputTokens !== "number" ||
		!Number.isFinite(requestedMaxOutputTokens) ||
		!Number.isInteger(requestedMaxOutputTokens) ||
		requestedMaxOutputTokens <= 0
	) {
		return {
			...base,
			status: "reject",
			code: "bounded_profile_invalid_request",
		};
	}

	const effectiveMaxOutputTokens = Math.min(
		requestedMaxOutputTokens,
		profile.maxOutputTokens,
	);
	const clamped = effectiveMaxOutputTokens !== requestedMaxOutputTokens;
	if (clamped) {
		bodyContext.mutateParsedJson((body) => {
			body.max_tokens = effectiveMaxOutputTokens;
		});
	}

	const estimate = estimateAnthropicAdmissionTokens(
		bodyContext.getParsedJson(),
	);
	const admission = decideContextAdmission({
		inputTokens: estimate.tokens,
		effectiveContextWindow: profile.contextWindow,
		// Reserve the configured cap, not the caller's smaller requested output.
		requestedMaxOutputTokens: profile.maxOutputTokens,
		safetyReserveTokens: 0,
	});
	const decision = {
		...base,
		requestedMaxOutputTokens,
		effectiveMaxOutputTokens,
		outputReserveTokens: admission.outputReserveTokens,
		estimatedInputTokens: admission.inputTokens,
		occupiedTokens: admission.occupiedTokens,
		clamped,
	};
	if (admission.status !== "admit") {
		return {
			...decision,
			status: "reject",
			code: "bounded_profile_context_length_exceeded",
		};
	}
	return { ...decision, status: "admit", code: null };
}

export function createBoundedModelRouteAdmissionResponse(
	decision: Extract<
		BoundedModelRouteAdmissionDecision,
		{ readonly status: "reject" }
	>,
): Response {
	const message =
		decision.code === "bounded_profile_invalid_request"
			? "This bounded route profile requires a valid JSON request with a messages array and a finite positive max_tokens."
			: decision.code === "bounded_profile_deferred_tools_unsupported"
				? "This profile does not support deferred custom tools. Select a native Anthropic route or start a fresh non-Anthropic client with ENABLE_TOOL_SEARCH=0."
				: "This request exceeds the bounded route profile context limit.";
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message,
				code: decision.code,
			},
		}),
		{
			status: 400,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function sanitizeInternalHeadersCopy(
	headers: Headers,
	preserveTrustedSyntheticMarkers: boolean,
): { headers: Headers; changed: boolean } {
	const sanitized = new Headers(headers);
	let changed = false;
	for (const name of [...sanitized.keys()]) {
		const normalizedName = name.toLowerCase();
		if (!normalizedName.startsWith(INTERNAL_TRANSPORT_HEADER_PREFIX)) continue;
		if (
			preserveTrustedSyntheticMarkers &&
			normalizedName.startsWith(TRUSTED_SYNTHETIC_HEADER_PREFIX)
		) {
			continue;
		}
		sanitized.delete(name);
		changed = true;
	}
	return { headers: sanitized, changed };
}

export function sanitizeInternalHeaders(headers: Headers): Headers {
	return sanitizeInternalHeadersCopy(headers, false).headers;
}

function isTrustedSyntheticProviderResponse(request: Request): boolean {
	return (
		request.headers.get(SYNTHETIC_RESPONSE_HEADER) === "true" &&
		request.url.startsWith(SYNTHETIC_RESPONSE_URL_PREFIX)
	);
}

/** Strip proxy-only metadata from a concrete request before upstream fetch. */
function sanitizeInternalTransportHeaders(request: Request): Request {
	const preserveSyntheticMarkers = isTrustedSyntheticProviderResponse(request);
	const { headers: sanitizedHeaders, changed } = sanitizeInternalHeadersCopy(
		request.headers,
		preserveSyntheticMarkers,
	);
	if (!changed) {
		return request;
	}
	return new Request(request.url, {
		method: request.method,
		headers: sanitizedHeaders,
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
		isTrustedSyntheticProviderResponse(request)
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
 * Removes proxy-minted Codex reasoning retention blocks from assistant
 * history while preserving genuine Anthropic redacted-thinking blocks.
 */
export function filterCodexReasoningBlocks(
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
		if (!body) {
			if (bodyContext.hasParseFailed) {
				log.warn(
					"Failed to filter Codex reasoning blocks: request body is not valid JSON",
				);
			}
			return null;
		}

		const { body: filteredBody, strippedCount } =
			stripCodexReasoningRetention(body);
		if (strippedCount === 0) return requestBodyBuffer;

		return RequestBodyContext.fromParsed(
			requestBodyBuffer,
			filteredBody,
		).getBuffer();
	} catch (error) {
		log.warn("Failed to filter Codex reasoning blocks:", error);
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

	// Cloned only after the content-type gate above. Cloning before it would
	// tee the body and then return early for every non-JSON body, stranding
	// that copy unread — the tee keeps buffering for whoever consumes the
	// original. Reachable in normal operation: providers such as Qwen do
	// return non-JSON error bodies. See issue #356.
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
 * Checks whether Codex rejected a retained encrypted reasoning item because
 * its payload cannot be verified against the item ID.
 */
export async function isCodexReasoningVerificationError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (response.status !== 400) return false;
	// A MISSING content-type is allowed here, unlike the Anthropic-facing
	// classifiers above. The Codex backend routinely answers without one — the
	// provider already logs and works around that on the success path ("Codex
	// returned successful response without SSE content-type"). Measured on the
	// live wire 2026-08-11: an item-id mismatch returned a 400 whose JSON body
	// carried the verification message but no content-type at all, so a copied
	// `includes("application/json")` gate skipped the check and left the
	// conversation wedged. An explicitly non-JSON content-type still short
	// circuits, which keeps the issue-#356 discipline: never tee a body we
	// cannot parse.
	const contentType = response.headers.get("content-type");
	if (contentType && !contentType.includes("application/json")) return false;

	const json = (await readJson(response)) as {
		error?: { message?: unknown };
	} | null;
	if (typeof json?.error?.message !== "string") return false;

	const rawMessage = json.error.message;
	if (/invalid\s+['"]input\[\d+\]\.id['"]/i.test(rawMessage)) {
		return true;
	}

	const message = rawMessage.toLowerCase();
	// Observed wordings (live, 2026-08-11):
	//   "The encrypted content for item <id> could not be verified. Reason:
	//    Encrypted content could not be decrypted or parsed."
	//   "The encrypted content for item <id> could not be verified. Reason:
	//    Encrypted content item_id did not match the target item id."
	// Both share the "encrypted content" subject; the reason clause varies, so
	// match the subject plus any known failure phrasing rather than one reason.
	return (
		message.includes("encrypted content") &&
		(message.includes("could not be verified") ||
			message.includes("could not be decrypted") ||
			message.includes("did not match"))
	);
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

	// Cloned only after the content-type gate above. Cloning before it would
	// tee the body and then return early for every non-JSON body, stranding
	// that copy unread — the tee keeps buffering for whoever consumes the
	// original. Reachable in normal operation: providers such as Qwen do
	// return non-JSON error bodies. See issue #356.
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
 * Match only a JSON 400 that explicitly rejects the experimental OpenAI
 * breakpoint field. Generic validation failures must not consume a replay.
 */
async function isCodexExplicitCacheBreakpointRejectionError(
	response: Response,
	transformedRequestHadMarker: boolean,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<boolean> {
	if (!transformedRequestHadMarker || response.status !== 400) return false;
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return false;
	const json = (await readJson(response)) as {
		error?: { message?: unknown; param?: unknown };
		message?: unknown;
	} | null;
	const candidate = [json?.error?.message, json?.error?.param, json?.message]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
	if (
		!candidate.includes("prompt_cache_breakpoint") &&
		!candidate.includes("prompt_cache_options")
	) {
		return false;
	}
	return (
		candidate.includes("unknown") ||
		candidate.includes("unsupported") ||
		candidate.includes("not supported") ||
		candidate.includes("extra input") ||
		candidate.includes("invalid")
	);
}

function hasCodexExplicitCacheBreakpoint(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const input = (body as Record<string, unknown>).input;
	if (!Array.isArray(input)) return false;
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (!Object.hasOwn(block, "prompt_cache_breakpoint")) {
				continue;
			}
			const marker = (block as Record<string, unknown>).prompt_cache_breakpoint;
			if (
				marker &&
				typeof marker === "object" &&
				(marker as Record<string, unknown>).mode === "explicit"
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Classify only Codex's authoritative Responses API capacity code or the
 * legacy message-only shape produced by CodexProvider. The legacy shape is
 * eligible only for a known-larger-model replay at its call site; generic
 * invalid-request 400s remain terminal and never consume another route.
 */
async function classifyCodexContextOverflowError(
	response: Response,
	readJson: ResponseJsonReader = readResponseCloneJson,
): Promise<"authoritative" | "legacy" | null> {
	if (response.status !== 400) return null;
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) return null;
	const json = (await readJson(response)) as {
		error?: { code?: unknown; message?: unknown };
	} | null;
	if (json?.error?.code === "context_length_exceeded") {
		return "authoritative";
	}
	return typeof json?.error?.message === "string" &&
		/^Prompt is too long\. Codex reported:/i.test(json.error.message)
		? "legacy"
		: null;
}

function buildCodexContextOverflowCapabilityKey(
	endpoint: string,
	model: string | null | undefined,
	accountId: string,
): DeterministicFailureCapabilityKey {
	const subscriptionEndpoint = isCodexSubscriptionEndpoint(endpoint);
	return {
		failureKind: "authoritative_context_overflow",
		provider: "codex",
		// All official subscription-account URLs share one wire capability even
		// when harmless query/trailing-slash variants differ. A custom gateway may
		// select a different deployment from each account's bearer token, so URL
		// equality alone is never proof that two custom-account routes are equivalent.
		endpoint: subscriptionEndpoint ? "codex-subscription" : endpoint,
		capabilityScope: subscriptionEndpoint
			? "shared-subscription"
			: `account:${accountId}`,
		model,
	};
}

function createCodexContextOverflowTerminalResponse(
	authoritative: boolean,
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"Prompt is too long. Codex reported: Input exceeds the context window.",
				...(authoritative ? { code: "context_length_exceeded" } : {}),
			},
		}),
		{
			status: 400,
			statusText: "Bad Request",
			headers: { "content-type": "application/json" },
		},
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

	// Cloned only after the content-type gate above. Cloning before it would
	// tee the body and then return early for every non-JSON body, stranding
	// that copy unread — the tee keeps buffering for whoever consumes the
	// original. Reachable in normal operation: providers such as Qwen do
	// return non-JSON error bodies. See issue #356.
	const json = (await readJson(response)) as {
		error?: { type?: unknown; code?: unknown; message?: unknown };
		detail?: unknown;
	} | null;
	// Anthropic native format
	if (json?.error?.type === "not_found_error") return true;

	// OpenAI-compat format
	if (json?.error?.code === "model_not_found") return true;

	// Generic: nested or top-level message names an unavailable model. Codex's
	// ChatGPT-account endpoint uses a top-level `detail` string for this shape.
	const messages = [json?.error?.message, json?.detail].filter(
		(message): message is string => typeof message === "string",
	);
	for (const message of messages) {
		const lower = message.toLowerCase();
		if (
			lower.includes("model not found") ||
			lower.includes("does not exist") ||
			lower.includes("model is not supported") ||
			lower.includes("model is unavailable") ||
			message.includes("ResourceNotFoundException")
		) {
			return true;
		}
	}

	return false;
}

/**
 * Release an abandoned upstream response body so Bun frees its socket and
 * native read buffer.
 *
 * A `fetch()` Response body that is neither read to EOF nor released keeps
 * that memory committed indefinitely. On the proxy's failover/retry paths we
 * obtain an upstream Response and then discard it: return `null` to try the
 * next account, or overwrite `rawResponse`/`response` with a retry, without
 * ever consuming its body. Each dropped body is an off-heap leak that
 * ratchets up with every 429/401/529 failover under load. Calling this
 * before every such drop releases the buffer.
 *
 * Delegates to the chunked-drain primitive (discard-body-cancel.ts):
 * `body.cancel()` is a measured NO-OP on every released Bun (78–83 KB/req
 * leaked, indistinguishable from not calling it — see the bench notes in
 * that module), while draining to `done` actually closes the upstream
 * source. The drain is fire-and-forget inside the helper, so this never
 * blocks the failover path; locked bodies (a reader/clone owns them) and
 * null bodies are skipped there.
 */
export async function discardUpstreamBody(
	response: Response | null | undefined,
): Promise<void> {
	cancelDiscardedResponseBody(response);
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
	deadlineError: AnthropicPreCommitAttemptDeadlineError;
	readonly signal: AbortSignal;
	readonly abortPromise: Promise<never>;
	private readonly deadlineController = new AbortController();
	private readonly onAbort: () => void;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly routingSignal: AbortSignal,
		public timing: AnthropicAttemptCommitmentTiming,
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

	/**
	 * Synchronize a semantic-gate timeout with this transport's live signal.
	 * The gate and this scope intentionally share an absolute deadline, but two
	 * same-tick timers can otherwise let the gate reject first and disposal clear
	 * this scope's timer before it aborts the already-written WebSocket frame.
	 */
	abortIfDeadlineElapsed(): void {
		if (
			this.deadlineController.signal.aborted ||
			Date.now() < this.timing.deadlineAt
		) {
			return;
		}
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.deadlineController.abort(this.deadlineError);
	}

	/** Promote an irreversible transport write onto the request-wide boundary. */
	promoteDeadlineTo(deadlineAt: number): void {
		if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
			throw new RangeError("deadlineAt must be a positive safe integer");
		}
		if (this.deadlineController.signal.aborted) return;
		if (deadlineAt <= this.timing.deadlineAt) return;

		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.timing = {
			deadlineAt,
			startedAt: this.timing.startedAt,
			budgetMs: Math.max(0, deadlineAt - this.timing.startedAt),
		};
		this.deadlineError = new AnthropicPreCommitAttemptDeadlineError(
			this.timing.deadlineAt,
			this.timing.budgetMs,
		);
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) {
			this.deadlineController.abort(this.deadlineError);
			return;
		}
		this.deadlineTimer = setTimeout(
			() => this.deadlineController.abort(this.deadlineError),
			remainingMs,
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
		} catch (error) {
			if (!this.signal.aborted) return null;
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
		} finally {
			reader.releaseLock();
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
	routingAttemptLedger?: RoutingAttemptLedger,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = sanitizeInternalHeaders(
		ctx.provider.prepareHeaders(req.headers, undefined, undefined),
	);
	const routingSignal = anthropicPreCommitRescue?.signal ?? req.signal;
	const drainAbortController = new AbortController();
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

		routingAttemptLedger?.recordPhysicalAttempt({
			laneKey: requestMeta.affinityLaneKey ?? null,
		});
		let response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
			// Abort upstream when the client disconnects; this path builds no
			// Request object, so the signal has to be passed explicitly.
			// routingSignal already falls back to req.signal when there is no
			// active pre-commit rescue, so this chain covers both cases. The
			// drain controller must be present when fetch is created so terminal
			// recovery can later tear down a stuck response body.
			AbortSignal.any([
				attemptCommitment?.signal ?? routingSignal,
				drainAbortController.signal,
			]),
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
			response = wrapAnthropicPrecommitGatedResponse(response, gatedBody);
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
				clientSessionId: requestMeta.clientSessionId ?? null,
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
				drainAbort: drainAbortController,
			},
			ctx,
		);
	} catch (error) {
		if (error instanceof PhysicalAttemptBudgetExceededError) throw error;
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
	anthropicDegraded?:
		| AnthropicDegradedRequestAdmission
		| AnthropicDegradedRequestSendState,
	/** Request-local bound for reactive stale-token refresh after a 401. */
	staleTokenRetryAttempt = 0,
	/** Refresh credential snapshot carried into the bounded same-account retry. */
	staleTokenRefreshTokenAtStart?: string | null,
): Promise<ProxyWithAccountResult> {
	// Snapshot before any credential lookup. A recursive stale-token retry carries
	// its original identity; an initial request captures the generation that was
	// present before getValidAccessToken can await or mutate shared state. A later
	// 401 must never read a newer mutable token and pause the wrong credential.
	let requestRefreshTokenAtStart: string | null =
		staleTokenRefreshTokenAtStart !== undefined
			? staleTokenRefreshTokenAtStart
			: account.refresh_token;
	const refreshTokenBeforeCredentialResolution = requestRefreshTokenAtStart;
	const anthropicDegradedState: AnthropicDegradedRequestSendState | undefined =
		anthropicDegraded &&
		"admission" in anthropicDegraded &&
		"lifecycle" in anthropicDegraded
			? anthropicDegraded
			: anthropicDegraded
				? { admission: anthropicDegraded, lifecycle: null, tracker: null }
				: undefined;
	const preCommitRescue = modelFallbackPolicy?.anthropicPreCommitRescue;
	let preparedResponseOwnsLifecycle = false;
	const canPreparedResponseSupersedeRetainedTerminal = (
		candidate: Response,
	): boolean =>
		preCommitRescue?.isRescueCommitted() !== true ||
		isSuccessfulAnthropicPreCommitRescueSse(candidate);
	const routingSignal = preCommitRescue?.signal ?? req.signal;
	const currentTransportSignal = (): AbortSignal => {
		const lifecycle = anthropicDegradedState?.lifecycle;
		if (!lifecycle?.enforced) return routingSignal;
		return AbortSignal.any([routingSignal, lifecycle.transportSignal]);
	};
	let implicitFallbackDiscoveryPossible =
		modelFallbackPolicy?.deferImplicitFallback !== undefined;
	const isFinalSemanticAttempt = (): boolean =>
		(modelFallbackPolicy?.isFinalSemanticAttempt?.() ??
			modelFallbackPolicy?.forwardModelUnavailableResponse === true) &&
		!implicitFallbackDiscoveryPossible;
	const canReplayContextOverflow = (): boolean =>
		modelFallbackPolicy?.canReplayContextOverflow?.() ??
		!isFinalSemanticAttempt();
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
	let currentCodexWebSocketReceipt: CodexWebSocketReceipt | null = null;
	const getCurrentCodexWebSocketReceipt = () => currentCodexWebSocketReceipt;
	const readAttemptBoundJson: ResponseJsonReader = (response) =>
		activeAttemptCommitment?.readJson(response) ??
		readResponseCloneJson(response);
	const isAttemptControlError = (error: unknown): boolean =>
		error instanceof PhysicalAttemptBudgetExceededError ||
		error instanceof AnthropicPreCommitAttemptDeadlineError ||
		routingSignal.aborted ||
		anthropicDegradedState?.lifecycle?.transportSignal.aborted === true ||
		activeAttemptCommitment?.signal.aborted === true;
	const physicalAttemptVetoContext = () => ({
		accountId: account.id,
		candidateId: modelFallbackPolicy?.routeCandidateId ?? null,
		laneKey: requestMeta.affinityLaneKey ?? null,
	});
	const drainAbortController = new AbortController();
	/**
	 * Single transport boundary for one physical attempt.
	 *
	 * `onDispatchStarted` reports the irreversible point — the WebSocket frame
	 * write, or the final HTTP dispatch hook that immediately precedes fetch —
	 * so the caller can tell an attempt that reached the wire from one abandoned
	 * before it. Both transports report it themselves rather than the wrapper
	 * inferring it from an error type, because the hooks that run just before
	 * each send can still refuse it: they assert the request-local physical
	 * budget and throw instead of returning.
	 */
	const makeAttemptRequest = async (
		request: Request,
		optionalOutboundTransport?: (
			signal: AbortSignal,
			markDispatched: () => void,
		) => Promise<Response | null>,
		onHttpDispatch?: () => void,
		onDispatchStarted?: () => void,
	): Promise<Response> => {
		const markDispatched = (): void => {
			onDispatchStarted?.();
		};
		{
			// The outer context exists only for an Anthropic-shaped downstream request.
			// Any real provider transport can hang before headers (including transformed
			// OpenAI-compatible routes), so start rescue immediately before every fetch.
			// Synthetic provider responses never call this wrapper and remain synchronous.
			preCommitRescue?.activate();
			const commitment = resolveAttemptCommitmentDeadline();
			latestTransportCommitment = commitment;
			activeAttemptCommitment?.dispose();
			activeAttemptCommitment = undefined;
			const dispatch = async (signal: AbortSignal): Promise<Response> => {
				// HTTP and optional transports must share the exact same live abort
				// source. Terminal recovery cannot attach a controller after either
				// transport has already created its connection.
				const attemptSignal = AbortSignal.any([
					signal,
					drainAbortController.signal,
				]);
				const optionalResponse = await optionalOutboundTransport?.(
					attemptSignal,
					markDispatched,
				);
				if (optionalResponse) return optionalResponse;
				// This hook is the last thing that can refuse the send: it asserts the
				// request-local physical budget and claims a hosted dispatch, and it
				// throws instead of returning when either fails. Mark only after it
				// returns, when nothing remains between here and the fetch below.
				onHttpDispatch?.();
				markDispatched();
				return makeProxyRequest(
					request,
					undefined,
					undefined,
					undefined,
					undefined,
					attemptSignal,
				);
			};
			const transportSignal = currentTransportSignal();
			if (!commitment) {
				return dispatch(transportSignal);
			}

			const attemptCommitment = new AnthropicPreCommitAttemptScope(
				transportSignal,
				commitment,
			);
			activeAttemptCommitment = attemptCommitment;
			if (commitment.budgetMs <= 0) {
				throw attemptCommitment.deadlineError;
			}

			try {
				return await dispatch(attemptCommitment.signal);
			} catch (error) {
				if (attemptCommitment.isPrivateDeadline()) {
					const websocketReceipt = getCurrentCodexWebSocketReceipt();
					if (websocketReceipt?.frameWritten) {
						websocketReceipt.markPostWriteFailure("semantic_stall");
						return createCodexWebSocketNoReplayResponse(504, "semantic_stall");
					}
					throw attemptCommitment.deadlineError;
				}
				throw error;
			}
		}
	};
	try {
		// Every upstream call stays tied to the client connection: when the client
		// disconnects, the upstream fetch must be aborted instead of running on.
		// Call sites pass `req.signal` to makeProxyRequest explicitly instead of
		// relying on the Request object to carry it, because provider body
		// transforms rebuild the Request from its URL and drop the signal (see
		// providers/src/utils/model-mapping.ts and the openai/codex providers).
		if (
			process.env.DEBUG?.includes("proxy") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.debug(
				`Attempting request with account: ${account.name} (provider: ${account.provider})`,
			);
		}

		// Apply model override from combo slot (per D-04, REQ-12)
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		let effectiveBodyContext = baseBodyContext;
		let effectiveBodyBuffer = baseBodyContext.getBuffer();
		// True only once the override is actually patched into the outgoing body —
		// a failed patch falls through to the original body, so applied_model must
		// not claim a model that was never really sent upstream.
		let modelOverrideApplied = false;
		if (modelOverride && effectiveBodyBuffer) {
			const overriddenContext = baseBodyContext.withPatchedModel(modelOverride);
			if (overriddenContext) {
				effectiveBodyContext = overriddenContext;
				effectiveBodyBuffer = overriddenContext.getBuffer();
				modelOverrideApplied = true;

				if (
					process.env.DEBUG?.includes("proxy") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.debug(
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

		// Model observability for this specific attempt (success-conditioned):
		// modelOverride and modelFallbackPolicy are plain function
		// arguments/closures, never mutated after this call started, so these
		// stay correctly scoped to THIS attempt even if the eventual response is
		// retained by the routing ledger and delivered later, after subsequent
		// attempts (including a non-combo fallback) have already run. Combo
		// override info is attributed only when the override actually made it
		// into the outgoing body — never a stale value from a failed slot.
		const attemptAppliedModel = modelOverrideApplied
			? (modelOverride as string)
			: (requestMeta.appliedModel ?? null);
		const comboModelOverrideFrom = modelOverrideApplied
			? (modelFallbackPolicy?.comboModelOverrideFrom ?? null)
			: null;
		const comboModelOverrideTo = comboModelOverrideFrom
			? (modelOverride as string)
			: null;

		// Get the provider for this account before applying the staging policy: the
		// resolved provider (including ctx fallback) determines replay safety.
		const provider = resolveProviderForAccount(account.provider, ctx.provider);
		if (!provider) {
			throw new ServerToolCandidateCapabilityError({
				accountId: account.id,
				candidateId:
					modelFallbackPolicy?.routeCandidateId ?? `account:${account.id}`,
				reason: "provider_unavailable",
			});
		}
		const requestedModelBeforeAdmission = effectiveBodyContext.getModel();
		const cacheReplayPhysicalModel = req.headers.get(CACHE_REPLAY_MODEL_HEADER);
		const requestedConfiguredModelMapping = requestedModelBeforeAdmission
			? getConfiguredModelMapping(requestedModelBeforeAdmission, account)
			: null;
		const hasExactPreAdmissionModelIdentity =
			cacheReplayPhysicalModel !== null ||
			(requestedModelBeforeAdmission !== null &&
				getModelFamily(requestedModelBeforeAdmission) === null) ||
			(requestedConfiguredModelMapping !== null &&
				requestedConfiguredModelMapping.models.length > 0 &&
				requestedConfiguredModelMapping.models.every(
					(model) => getModelFamily(model) === null,
				));
		// Context admission itself resolves logical families. An unhydrated Codex
		// account must first learn its own defaults, otherwise the provider-wide
		// fallback can make a sibling's model look candidate-specific and suppress a
		// legitimately distinct frontier. Exact replay, operator mapping, and
		// concrete input identities remain safe to admit without credential work.
		const ensuredCodexDefaultsBeforeAdmission =
			account.provider === "codex" && !hasExactPreAdmissionModelIdentity;
		if (ensuredCodexDefaultsBeforeAdmission) {
			await ensureCodexModelDefaults(account, ctx);
		}
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
		const mayPlanCodexContextOverflowFallback =
			usesCodexAdmissionPlan &&
			attemptAdmissionTracker?.estimateConfidence === "low" &&
			modelFallbackPolicy?.deferImplicitFallback !== undefined &&
			modelFallbackPolicy.implicitFallbacksEnabled !== false &&
			admission.model !== null;
		let codexContextOverflowFallbackModel: string | null = null;
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
				if (
					mayPlanCodexContextOverflowFallback &&
					admission.model &&
					codexContextOverflowFallbackModel === null &&
					isKnownLargerCodexCandidate(admission.model, candidateModel)
				) {
					// Set only after the request-level queue accepts this route (or
					// de-duplicates it against the same route queued during admission).
					codexContextOverflowFallbackModel = candidateModel;
				}
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
		const preEnsureConcreteAttemptModel =
			account.provider === "codex" && admittedRequestModel
				? resolveCodexRequestModel(admittedRequestModel, account)
				: admittedRequestModel
					? (getModelList(admittedRequestModel, account)?.[0] ??
						admittedRequestModel)
					: null;
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

		type ExactServerToolCapabilityBinding = Readonly<{
			tuple: ServerToolCapabilityTuple;
			proofKey: string;
			inputReplayMode: readonly ServerToolReplayAtom[];
			outputReplayMode: readonly ServerToolReplayAtom[];
			replay: RequestPrivateServerToolReplay;
		}>;
		const serverToolRequirements = requestMeta.serverToolRequirements;
		const routeCandidateId =
			modelFallbackPolicy?.routeCandidateId ?? `account:${account.id}`;
		const candidateCapabilityError = (
			reason: ConstructorParameters<
				typeof ServerToolCandidateCapabilityError
			>[0]["reason"],
		): ServerToolCandidateCapabilityError =>
			new ServerToolCandidateCapabilityError({
				accountId: account.id,
				candidateId: routeCandidateId,
				reason,
			});
		const replayModesEqual = (
			left: readonly ServerToolReplayAtom[],
			right: readonly ServerToolReplayAtom[],
		): boolean =>
			left.length === right.length &&
			left.every((atom, index) => atom === right[index]);
		const resolveExactServerToolCapability = (
			physicalModel: string | null,
			requireSelectedCandidateBinding: boolean,
		): ExactServerToolCapabilityBinding | null => {
			if (!serverToolRequirements) return null;
			if (!physicalModel) throw candidateCapabilityError("tuple_unavailable");

			const currentProvider = resolveProviderForAccount(
				account.provider,
				ctx.provider,
			);
			if (!currentProvider || currentProvider !== provider) {
				throw candidateCapabilityError("provider_unavailable");
			}

			let tuple: ServerToolCapabilityTuple | undefined;
			try {
				tuple = materializeProviderServerToolCapabilityTuple(provider, {
					candidateId: routeCandidateId,
					account,
					path: url.pathname,
					query: url.search,
					physicalModel,
					requirements: serverToolRequirements,
				});
			} catch {
				throw candidateCapabilityError("tuple_unavailable");
			}
			if (!tuple) throw candidateCapabilityError("tuple_unavailable");

			let decision: ServerToolCapabilityDecision;
			try {
				decision = materializeProviderServerToolCapabilityDecision(
					provider,
					serverToolRequirements,
					tuple,
				);
			} catch {
				throw candidateCapabilityError("resolver_invalid");
			}
			if (decision.decision !== "proven") {
				throw candidateCapabilityError("capability_unproven");
			}
			const proof = decision.proof;
			const proofKey = buildServerToolCapabilityProofKey(
				proof.revision,
				proof.tuple,
			);
			if (!proofKey) throw candidateCapabilityError("resolver_invalid");

			const inputReplayMode = Object.freeze([...proof.tuple.inputReplay]);
			const outputReplayMode = Object.freeze([...proof.tuple.outputReplay]);
			const replayEligibility = evaluateServerToolReplayEligibility(
				serverToolRequirements,
				inputReplayMode,
				outputReplayMode,
				ctx.serverToolReplay,
			);
			if (!replayEligibility.eligible) {
				throw candidateCapabilityError("replay_unavailable");
			}
			const replay = resolveRequestPrivateServerToolReplay(requestMeta, {
				request: req,
				apiKeyId,
				lineage: sessionIdForObservation(req.headers),
			});
			if (!replay) throw candidateCapabilityError("replay_unavailable");
			if (requireSelectedCandidateBinding) {
				const selected = requestMeta.routingCandidates?.find(
					(candidate) =>
						candidate.candidateId === routeCandidateId &&
						candidate.accountId === account.id,
				);
				const expected = selected?.serverToolCapability;
				if (!expected) {
					throw candidateCapabilityError("candidate_binding_missing");
				}
				if (
					expected.resolvedProvider !== tuple.provider ||
					expected.physicalModel !== physicalModel ||
					expected.decision !== "proven" ||
					expected.reason !== null ||
					expected.proofKey !== proofKey ||
					expected.replayRuntimeStatus !== replayEligibility.status ||
					!replayModesEqual(expected.inputReplayMode, inputReplayMode) ||
					!replayModesEqual(expected.outputReplayMode, outputReplayMode)
				) {
					throw candidateCapabilityError("candidate_binding_mismatch");
				}
			}

			return Object.freeze({
				tuple,
				proofKey,
				inputReplayMode,
				outputReplayMode,
				replay,
			});
		};

		const createPlanningRequest = (bodyBuffer: ArrayBuffer | null): Request => {
			const init: RequestInit & { duplex?: "half" } = {
				method: req.method,
				headers: req.headers,
			};
			if (bodyBuffer) {
				init.body = new Uint8Array(bodyBuffer);
				init.duplex = "half";
			}
			return new Request(req.url, init);
		};
		const materializeAttemptPlan = (
			bodyBuffer: ArrayBuffer | null,
			physicalModel: string | null,
			requireSelectedCandidateBinding = false,
		): ProviderAttemptPlan => {
			const constraintViolation = getRouteProfileConstraintViolation(
				account,
				requestMeta,
				admittedRequestModel,
				physicalModel,
			);
			if (constraintViolation) {
				throw new ForceRouteUnavailableError(account.id, constraintViolation);
			}
			const capability = resolveExactServerToolCapability(
				physicalModel,
				requireSelectedCandidateBinding,
			);
			return materializeProviderAttemptPlan(provider, {
				request: createPlanningRequest(bodyBuffer),
				requestBodyBuffer: bodyBuffer,
				account,
				path: url.pathname,
				query: url.search,
				physicalModel,
				capabilityProofKey: capability?.proofKey ?? null,
				inputReplayMode: capability?.inputReplayMode ?? [],
				outputReplayMode: capability?.outputReplayMode ?? [],
				beforePhysicalTransport: routingAttemptLedger
					? () => {
							routingAttemptLedger.recordPhysicalAttempt({
								accountId: account.id,
								candidateId: modelFallbackPolicy?.routeCandidateId ?? null,
								laneKey: requestMeta.affinityLaneKey ?? null,
							});
						}
					: undefined,
				serverToolHistoryProjector:
					capability?.replay.serverToolHistoryProjector,
				serverToolReplayIssuer: capability?.replay.serverToolReplayIssuer,
			});
		};
		const assertAttemptPlanCapabilityIsCurrent = (
			plan: ProviderAttemptPlan,
		): void => {
			const current = resolveExactServerToolCapability(
				plan.physicalModel,
				false,
			);
			if (!serverToolRequirements) return;
			if (
				!current ||
				current.tuple.provider !== plan.providerName ||
				current.tuple.model !== plan.physicalModel ||
				current.proofKey !== plan.capabilityProofKey ||
				!replayModesEqual(current.inputReplayMode, plan.inputReplayMode) ||
				!replayModesEqual(current.outputReplayMode, plan.outputReplayMode)
			) {
				throw candidateCapabilityError("proof_drift");
			}
		};
		const hostedDispatchCommitted = (): boolean =>
			routingAttemptLedger?.hostedDispatchState === "hosted_dispatched";
		const transformWithCurrentAttemptPlan = async (
			plan: ProviderAttemptPlan,
			request: Request,
		): Promise<Request> => {
			assertAttemptPlanCapabilityIsCurrent(plan);
			return plan.transformRequestBody(request);
		};
		const preflightEndpoint =
			provider.name === "codex" && account.provider === "codex"
				? provider.buildUrl(url.pathname, url.search, account)
				: null;
		const explicitlyMappedModel = requestedConfiguredModelMapping
			? admission.model &&
				requestedConfiguredModelMapping.models.includes(admission.model)
				? admission.model
				: admission.model === requestedModelBeforeAdmission
					? (requestedConfiguredModelMapping.models[0] ?? null)
					: null
			: null;
		const concreteInputModel =
			requestedModelBeforeAdmission &&
			getModelFamily(requestedModelBeforeAdmission) === null
				? requestedModelBeforeAdmission
				: null;
		// A compiled family default is only a guess until catalog hydration. It
		// must not suppress a sibling account before that account can reveal a
		// distinct live frontier. Cache replay, actual explicit mappings, and
		// concrete model IDs are the only exact pre-credential identities.
		const preflightPhysicalModel =
			cacheReplayPhysicalModel ??
			(explicitlyMappedModel && getModelFamily(explicitlyMappedModel) === null
				? explicitlyMappedModel
				: null) ??
			concreteInputModel;
		const preflightContextOverflowCapability =
			routingAttemptLedger &&
			preflightEndpoint &&
			serverToolRequirements === undefined
				? buildCodexContextOverflowCapabilityKey(
						preflightEndpoint,
						preflightPhysicalModel,
						account.id,
					)
				: null;
		if (
			preflightContextOverflowCapability &&
			routingAttemptLedger?.hasDeterministicFailure(
				preflightContextOverflowCapability,
			)
		) {
			if (attemptAdmissionTracker) {
				attemptAdmissionTracker.nonCapacitySkipCount++;
			}
			log.debug(
				`Skipping request-local deterministic Codex context overflow before credential resolution account=${account.name} model=${preflightPhysicalModel ?? "unknown"}`,
			);
			return null;
		}
		if (provider.name === "codex" && !ensuredCodexDefaultsBeforeAdmission) {
			await ensureCodexModelDefaults(account, ctx);
		}
		// Catalog hydration can change a logical Claude-family request from the
		// compiled Codex fallback to the account/provider's live frontier. Resolve
		// again after `ensureCodexModelDefaults`, then bind the plan and transform to
		// that account's exact physical identity. The preflight key above remains a
		// cheap request-local skip only when an explicit or cache-replay identity was
		// already known; a legitimate account-specific catalog change is not plan
		// drift.
		const concreteAttemptModel =
			account.provider === "codex" && admittedRequestModel
				? resolveCodexRequestModel(admittedRequestModel, account)
				: preEnsureConcreteAttemptModel;
		const plannedPhysicalModel =
			cacheReplayPhysicalModel ?? concreteAttemptModel;
		let attemptPlan = materializeAttemptPlan(
			effectiveBodyBuffer,
			plannedPhysicalModel,
			modelFallbackPolicy?.recomputeServerToolCapability !== true,
		);
		const contextOverflowCapabilityForPlan = (
			plan: ProviderAttemptPlan,
		): DeterministicFailureCapabilityKey | null =>
			plan.providerName === "codex" && account.provider === "codex"
				? buildCodexContextOverflowCapabilityKey(
						plan.targetUrl,
						plan.physicalModel,
						account.id,
					)
				: null;
		let currentContextOverflowCapability =
			contextOverflowCapabilityForPlan(attemptPlan);
		if (
			currentContextOverflowCapability &&
			routingAttemptLedger?.hasDeterministicFailure(
				currentContextOverflowCapability,
			)
		) {
			if (attemptAdmissionTracker) {
				attemptAdmissionTracker.nonCapacitySkipCount++;
			}
			log.debug(
				`Skipping request-local deterministic Codex context overflow account=${account.name} model=${attemptPlan.physicalModel ?? "unknown"}`,
			);
			return null;
		}
		let attemptProvider = bindProviderAttemptPlan(attemptPlan);
		const attemptProxyContext = (): ProxyContext => ({
			...ctx,
			provider: attemptProvider,
		});
		const claimCurrentHostedDispatch = (): void => {
			if (attemptPlan.capabilityProofKey === null) return;
			// Revalidate after every fallible local staging step and immediately before
			// the irreversible fetch/frame-write callback.
			assertAttemptPlanCapabilityIsCurrent(attemptPlan);
			if (!routingAttemptLedger) {
				throw new HostedDispatchTerminalError("ledger_missing");
			}
			if (!routingAttemptLedger.claimHostedDispatch()) {
				throw new HostedDispatchTerminalError("already_dispatched");
			}
		};
		let currentReplayBody = effectiveBodyBuffer;

		const isSyntheticCodexCountTokens =
			attemptPlan.providerName === "codex" &&
			url.pathname === "/v1/messages/count_tokens";

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
		if (staleTokenRefreshTokenAtStart === undefined) {
			requestRefreshTokenAtStart = refreshTokenBeforeCredentialResolution;
		}
		const replayResolvedModel =
			attemptPlan.cacheReplayModelStrategy === "transformed-body"
				? cacheReplayPhysicalModel
				: null;
		// Codex request tracing and stream-intent correlation need the proxy request
		// ID during transformRequestBody. The Codex provider consumes and strips this
		// internal header before the request is sent upstream.
		let transportAttemptOrdinal = requestMeta.codexTransportAttemptOrdinal ?? 0;
		let currentTransportAttemptId: string | null = null;
		/**
		 * The route this attempt will use, held until it is irreversibly dispatched.
		 *
		 * `stampCodexAttempt` runs while an attempt's body is transformed, well
		 * before that attempt can reach the wire, so publishing the route there
		 * would leave the request pointing at a candidate that may never send. The
		 * only consumer of the published value asks "what route did we last send
		 * on?" -- to classify the next attempt as a retry, a fallback, or the
		 * initial send -- so it is committed from the dispatch callback instead,
		 * and an abandoned candidate simply never publishes anything to undo.
		 */
		let pendingCodexAttemptRoute: {
			accountId: string;
			model: string | null;
		} | null = null;
		const commitCodexDispatchedRoute = (): void => {
			if (!pendingCodexAttemptRoute) return;
			requestMeta.codexLastAttemptAccountId =
				pendingCodexAttemptRoute.accountId;
			requestMeta.codexLastAttemptModel = pendingCodexAttemptRoute.model;
			pendingCodexAttemptRoute = null;
		};
		/** Physical models compare case-insensitively; unknown never matches. */
		const normalizeCodexAttemptModel = (
			model: string | null | undefined,
		): string | null => model?.trim().toLowerCase() || null;
		const stampCodexAttempt = (
			attemptHeaders: Headers,
			cause:
				| "initial"
				| "model_fallback"
				| "overload_529"
				| "thinking_retry"
				| "reasoning_retry"
				| "cache_control_retry"
				| "prompt_cache_breakpoint_retry"
				| "cache_lane_rescue"
				| "precommit_sse_retry"
				| "account_failover"
				| "other_retry",
			finalModel?: string,
		) => {
			if (attemptPlan.providerName !== "codex") return;
			transportAttemptOrdinal++;
			requestMeta.codexTransportAttemptOrdinal = transportAttemptOrdinal;
			// Held rather than published; `commitCodexDispatchedRoute` publishes it
			// once this attempt actually reaches the wire. `attemptPlan` still
			// describes the attempt being superseded when a fallback stamps itself,
			// so the explicit model wins where one is given.
			pendingCodexAttemptRoute = {
				accountId: account.id,
				model: normalizeCodexAttemptModel(
					finalModel ?? attemptPlan.physicalModel,
				),
			};
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
		const prepareAttemptHeaders = (plan: ProviderAttemptPlan): Headers => {
			const clientHeadersForPlan = new Headers(req.headers);
			clientHeadersForPlan.delete(CODEX_LOGICAL_MODEL_FAMILY_HEADER);
			const prepared = plan.prepareHeaders(
				clientHeadersForPlan,
				accessToken,
				account.api_key || undefined,
			);
			applyXaiConvIdHeader(
				prepared,
				plan.providerName,
				account,
				getXaiConvId(requestMeta),
			);
			prepared.delete(CACHE_REPLAY_MODEL_HEADER);
			if (plan.providerName === "codex") {
				const logicalModel =
					requestMeta.appliedModel ?? requestMeta.originalModel;
				const logicalModelFamily = logicalModel
					? getModelFamily(logicalModel)
					: null;
				if (logicalModelFamily) {
					prepared.set(CODEX_LOGICAL_MODEL_FAMILY_HEADER, logicalModelFamily);
				}
				const isAttributedAgent =
					Boolean(requestMeta.agentUsed) || isClaudeCodeSubagent(req.headers);
				// Client-supplied copies are untrusted. Strip before attaching only
				// server-derived experiment metadata so traces cannot be spoofed or
				// retain arbitrary sensitive header content.
				prepared.delete("x-better-ccflare-pacing-canary");
				prepared.delete("x-better-ccflare-pacing-cohort-id");
				prepared.delete("x-better-ccflare-pacing-action");
				prepared.delete("x-better-ccflare-pacing-role");
				prepared.delete("x-better-ccflare-pacing-wait-ms");
				prepared.delete("x-better-ccflare-pacing-release-reason");
				prepared.set("x-better-ccflare-request-id", requestMeta.id);
				// Attribution is resolved by the proxy before account selection. Replace
				// any client-supplied marker here, once the selected provider is known.
				if (isAttributedAgent) {
					prepared.set("x-better-ccflare-attributed-agent", "true");
				} else {
					prepared.delete("x-better-ccflare-attributed-agent");
				}
				if (requestMeta.codexPacingCanary) {
					prepared.set(
						"x-better-ccflare-pacing-canary",
						requestMeta.codexPacingCanary,
					);
				}
				if (requestMeta.codexPacingAction) {
					prepared.set(
						"x-better-ccflare-pacing-action",
						requestMeta.codexPacingAction,
					);
				}
				if (requestMeta.codexPacingCohortId) {
					prepared.set(
						"x-better-ccflare-pacing-cohort-id",
						requestMeta.codexPacingCohortId,
					);
				}
				if (requestMeta.codexPacingRole) {
					prepared.set(
						"x-better-ccflare-pacing-role",
						requestMeta.codexPacingRole,
					);
				}
				if (
					typeof requestMeta.codexPacingWaitMs === "number" &&
					Number.isSafeInteger(requestMeta.codexPacingWaitMs) &&
					requestMeta.codexPacingWaitMs >= 0
				) {
					prepared.set(
						"x-better-ccflare-pacing-wait-ms",
						String(requestMeta.codexPacingWaitMs),
					);
				}
				if (requestMeta.codexPacingReleaseReason) {
					prepared.set(
						"x-better-ccflare-pacing-release-reason",
						requestMeta.codexPacingReleaseReason,
					);
				}
			} else {
				prepared.delete("x-better-ccflare-attributed-agent");
			}
			// Synthetic-response markers are internal provider-to-proxy signals. Strip
			// client-supplied copies before providers transform the outbound request.
			prepared.delete(SYNTHETIC_RESPONSE_HEADER);
			prepared.delete(SYNTHETIC_STATUS_HEADER);
			return prepared;
		};
		let headers = prepareAttemptHeaders(attemptPlan);
		// A nonzero ordinal only means this logical request has been sent before,
		// not that it moved. Re-entry on the same account AND the same physical
		// model -- the bounded 401 retry after refreshing credentials, for
		// instance -- is a compatible retry: the rejected credential never
		// committed the model turn, so its turn state is still valid and must not
		// be discarded as failover would. Any change of account or of physical
		// model is a route change instead, and a route change must invalidate and
		// suppress rather than replay: a deferred cross-family fallback re-enters
		// with this same request metadata and only the model differs. An unknown
		// account or model on either side keeps the route-change classification,
		// because that side only discards state while the retry side preserves it.
		const previousAttemptAccountId = requestMeta.codexLastAttemptAccountId;
		const previousAttemptModel = requestMeta.codexLastAttemptModel;
		const entryTransportModel = normalizeCodexAttemptModel(
			replayResolvedModel ?? attemptPlan.physicalModel,
		);
		const sameAccountReentry = previousAttemptAccountId === account.id;
		const sameModelReentry =
			entryTransportModel !== null &&
			previousAttemptModel === entryTransportModel;
		stampCodexAttempt(
			headers,
			// Keyed on whether a route was ever dispatched, not on the attempt
			// ordinal. The ordinal counts candidates, including ones abandoned before
			// the wire, so using it here stamped the first real send of a request as
			// a failover from a route that never sent -- which then invalidated and
			// suppressed turn state that was still eligible.
			previousAttemptAccountId === undefined ||
				previousAttemptAccountId === null
				? "initial"
				: sameAccountReentry && sameModelReentry
					? "other_retry"
					: sameAccountReentry
						? "model_fallback"
						: "account_failover",
			replayResolvedModel ?? undefined,
		);
		let targetUrl = attemptPlan.targetUrl;
		type PhysicalSendReservation =
			| { readonly kind: "not_required" }
			| {
					readonly kind: "reserved";
					readonly permit: AnthropicDegradedPermit;
					readonly cohortKey: NonNullable<
						AnthropicDegradedRequestAdmission["input"]["cohortKey"]
					>;
					readonly enforced: boolean;
					committed: boolean;
					probeSendObserved: boolean;
			  };

		const physicalAnthropicCohortKey = (
			transportRequest: Request,
			resolvedModel: string | null | undefined,
		) => {
			if (
				!anthropicDegradedState ||
				attemptPlan.providerName !== "anthropic" ||
				!isNativeAnthropicOAuthDegradedModeEligible(account) ||
				url.pathname !== "/v1/messages" ||
				!resolvedModel
			) {
				return null;
			}
			return buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: transportRequest.url,
				path: url.pathname,
				protocol: "messages",
				model: resolvedModel,
				// Use the physical OAuth request after prepareHeaders has appended
				// its required beta. Candidate aliases and caller-only beta values
				// therefore cannot split or poison the retained cohort.
				betaSignature: transportRequest.headers.get("anthropic-beta"),
			});
		};

		const reservePhysicalSend = (
			transportRequest: Request,
			resolvedModel: string | null | undefined,
			retainedTrustedResponse: Response | null = null,
		): PhysicalSendReservation => {
			if (
				!anthropicDegradedState ||
				isSyntheticProviderResponse(transportRequest)
			) {
				return { kind: "not_required" };
			}
			const cohortKey = physicalAnthropicCohortKey(
				transportRequest,
				resolvedModel,
			);
			if (cohortKey === null) {
				return { kind: "not_required" };
			}
			let decision: AnthropicDegradedAdmissionDecision;
			try {
				decision = anthropicDegradedState.admission.reserve(
					account.id,
					cohortKey,
				);
			} catch (error) {
				if (ctx.anthropicDegradedMode.config.mode === "observe") {
					return { kind: "not_required" };
				}
				throw error;
			}
			try {
				if (decision.action === "suppress") {
					anthropicDegradedState.tracker?.recordSuppression({
						decision: "suppressed",
						reason: degradedSuppressionReason(decision.reason),
						cohortKey,
						ownerKey: decision.requiredAccountId,
					});
				} else if (decision.wouldAction === "suppress") {
					anthropicDegradedState.tracker?.recordSuppression({
						decision: "would_suppress",
						reason: degradedSuppressionReason(decision.reason),
						cohortKey,
						ownerKey:
							"requiredAccountId" in decision
								? decision.requiredAccountId
								: undefined,
					});
				}
			} catch {
				// Admission already decided; telemetry cannot revise it.
			}
			if (decision.action === "suppress") {
				throw new AnthropicDegradedSendDeniedError({
					kind: "anthropic_degraded_send_denied",
					decision,
					retainedTrustedResponse,
				});
			}
			if (!decision.permit) return { kind: "not_required" };
			return {
				kind: "reserved",
				permit: decision.permit,
				cohortKey,
				enforced: decision.enforced,
				committed: false,
				probeSendObserved: false,
			};
		};

		const cancelPhysicalSendReservation = (
			reservation: PhysicalSendReservation,
			retryAfter?: unknown,
		): void => {
			if (reservation.kind !== "reserved") return;
			if (reservation.enforced) {
				reservation.permit.cancel(retryAfter);
				return;
			}
			try {
				reservation.permit.cancel(retryAfter);
			} catch {
				// Observe-mode bookkeeping is shadow-only and must never affect
				// transport or routing.
			}
		};

		const commitPhysicalSendReservation = (
			reservation: PhysicalSendReservation,
			retainedTrustedResponse: Response | null = null,
		): void => {
			if (reservation.kind !== "reserved") return;
			if (reservation.committed) return;
			if (routingSignal.aborted) {
				cancelPhysicalSendReservation(reservation);
				if (!reservation.enforced) return;
				throw (
					routingSignal.reason ??
					new DOMException("routing aborted", "AbortError")
				);
			}
			let committed = false;
			try {
				committed = reservation.permit.commit();
			} catch (error) {
				if (!reservation.enforced) return;
				throw error;
			}
			if (!committed) {
				if (!reservation.enforced) return;
				const retryDecision = anthropicDegradedState?.admission.reserve(
					account.id,
					reservation.cohortKey,
				);
				if (retryDecision?.action === "suppress") {
					throw new AnthropicDegradedSendDeniedError({
						kind: "anthropic_degraded_send_denied",
						decision: retryDecision,
						retainedTrustedResponse,
					});
				}
				throw new Error(
					"Anthropic degraded-mode fenced permit could not be committed",
				);
			}
			if (anthropicDegradedState) {
				reservation.committed = true;
				if (
					anthropicDegradedState.lifecycle &&
					!anthropicDegradedState.lifecycle.isSettled
				) {
					throw new Error(
						"Anthropic degraded-mode committed lifecycle overwrite refused",
					);
				}
				try {
					anthropicDegradedState.lifecycle =
						new AnthropicDegradedResponseLifecycle({
							permit: reservation.permit,
							accountId: account.id,
							cohortKey: reservation.cohortKey,
							enforced: reservation.enforced,
							now: () => ctx.anthropicDegradedMode.currentTime(),
							onSuccess: () => {
								const recoveredState = ctx.anthropicDegradedMode.getCohortState(
									reservation.cohortKey,
								);
								if (recoveredState.state === "recovering") {
									const ownerOverlay = reservation.enforced
										? ctx.degradedOwnerOverlay
										: ctx.degradedOwnerShadowOverlay;
									ownerOverlay.retainAfterRecovery(
										reservation.cohortKey,
										recoveredState.recoveringUntil,
									);
								}
								if (!reservation.enforced) return;
								const routeCandidateId =
									modelFallbackPolicy?.routeCandidateId?.trim();
								if (
									requestMeta.affinityOwnerDirective?.kind ===
										"defer-owner-assignment" &&
									routeCandidateId
								) {
									ctx.strategy.commitAffinityOwner?.(requestMeta, {
										candidateId: routeCandidateId,
										accountId: account.id,
									});
								}
							},
							onSettled: (outcome) => {
								const tracker = anthropicDegradedState.tracker;
								if (tracker && reservation.permit.kind === "probe") {
									try {
										tracker.recordTransition({
											subject: "probe",
											from: "committed",
											to: outcome === "success" ? "recovering" : "open",
											reason:
												outcome === "success"
													? "probe_success"
													: outcome === "timeout"
														? "probe_timeout"
														: "probe_failure",
											cohortKey: reservation.cohortKey,
										});
									} catch {
										// Settlement authority already accepted the outcome.
										// Transition telemetry cannot block exact terminalization.
									}
								}
								if (tracker) {
									finishDegradedRequestFromPermitOutcome(tracker, outcome);
								}
							},
						});
					try {
						if (reservation.permit.kind === "probe") {
							if (!reservation.enforced) {
								anthropicDegradedState.tracker?.recordProbe("would_send");
							}
							anthropicDegradedState.tracker?.recordTransition({
								subject: "probe",
								from: "reserved",
								to: "committed",
								reason: "probe_committed",
								cohortKey: reservation.cohortKey,
							});
						}
					} catch {
						// The committed permit and lifecycle remain authoritative.
					}
				} catch (error) {
					reservation.permit.complete("failed");
					throw error;
				}
			}
		};

		let latestPhysicalAnthropicCohortKey: ReturnType<
			typeof physicalAnthropicCohortKey
		> = null;
		const activeLifecycleForLatestResponse = () => {
			const lifecycle = anthropicDegradedState?.lifecycle;
			return lifecycle?.matches(account.id, latestPhysicalAnthropicCohortKey) &&
				!lifecycle.isSettled
				? lifecycle
				: null;
		};
		const wasProtectedLifecycleForLatestResponse = () => {
			const lifecycle = anthropicDegradedState?.lifecycle;
			return (
				lifecycle?.enforced === true &&
				lifecycle.accountId === account.id &&
				latestPhysicalAnthropicCohortKey !== null
			);
		};
		const observeTrustedOverload = (
			response: Response,
			cohortKey: ReturnType<typeof physicalAnthropicCohortKey>,
			outcome: "http_529" | "semantic_overloaded",
		): void => {
			if (!anthropicDegradedState) return;
			if (cohortKey === null) return;
			let observation: ReturnType<
				typeof ctx.anthropicDegradedMode.observeTrustedOverload
			>;
			try {
				observation = ctx.anthropicDegradedMode.observeTrustedOverload({
					cohortKey,
					accountId: account.id,
					outcome,
					phase: "pre_commit",
					forceRouted:
						anthropicDegradedState.admission.input.forceRouted === true,
					retryAfter: response.headers.get("retry-after"),
				});
			} catch (error) {
				if (ctx.anthropicDegradedMode.config.mode === "observe") return;
				throw error;
			}
			if (observation.kind === "recorded" && observation.accepted) {
				try {
					ctx.anthropicDegradedObservability.recordOverloadEvidence();
					if (observation.opened) {
						anthropicDegradedState.tracker?.recordTransition({
							subject: "quorum",
							from: "collecting",
							to: "open",
							reason: "trusted_overload",
							cohortKey,
						});
					}
				} catch {
					// Evidence is already committed in the coordinator.
				}
			}
			if (
				observation.kind === "recorded" &&
				observation.accepted &&
				anthropicDegradedState.admission.input.risk.kind === "large" &&
				requestMeta.affinityOwnerSnapshot
			) {
				const ownerOverlay =
					ctx.anthropicDegradedMode.config.mode === "observe"
						? ctx.degradedOwnerShadowOverlay
						: ctx.degradedOwnerOverlay;
				try {
					ownerOverlay.retainQualifyingOwner({
						laneKey: requestMeta.affinityLaneKey ?? null,
						cohortKey,
						owner: requestMeta.affinityOwnerSnapshot,
					});
				} catch {
					// Owner evidence is best-effort and never changes overload proof.
				}
			}
			const lifecycle = anthropicDegradedState.lifecycle;
			if (lifecycle?.matches(account.id, cohortKey)) {
				try {
					lifecycle.settle("overloaded", response.headers.get("retry-after"));
				} catch (error) {
					if (ctx.anthropicDegradedMode.config.mode !== "observe") throw error;
				}
			}
		};
		const observeTrustedHttpOverload = (
			response: Response,
			transportRequest: Request,
			resolvedModel: string | null | undefined,
		): void => {
			if (response.status !== 529) return;
			observeTrustedOverload(
				response,
				physicalAnthropicCohortKey(transportRequest, resolvedModel),
				"http_529",
			);
		};

		/**
		 * Runs one physical attempt, from the final transport boundary through the
		 * upstream response.
		 *
		 * Codex registers an attempt's turn-state context earlier, while its body is
		 * transformed, so an attempt can be abandoned here without ever reaching the
		 * wire: the request-local physical budget can veto the send, the attempt's
		 * commitment budget can already be exhausted, or staging can fail. Left
		 * registered, such an attempt keeps its lease and reads as live, suppressing
		 * the client's next replay for the full attempt TTL and leaving a request
		 * record for a send that never happened. Releasing it on every pre-dispatch
		 * exit is one guard for the whole class, so a new veto added ahead of the
		 * transport is covered without a matching release beside it.
		 */
		const executeCacheAwareProviderAttempt = async (
			transportRequest: Request,
			replayBody: ArrayBuffer | null,
			cacheIdentityHasCacheControl?: boolean,
			resolvedModel?: string | null,
			reservation?: PhysicalSendReservation,
		): Promise<Response> => {
			let dispatchStarted = false;
			try {
				return await runCacheAwareProviderAttempt();
			} catch (error) {
				if (attemptPlan.providerName === "codex") {
					try {
						if (dispatchStarted) {
							// Sent, but no response came back, so nothing downstream will
							// ever finalize this attempt. Release it without the "never
							// sent" tombstone, which would wrongly annul a real send.
							provider.releaseDispatchedTurnStateAttempt?.(
								currentTransportAttemptId,
							);
						} else {
							provider.abortTurnStateAttempt?.(currentTransportAttemptId);
						}
					} catch {
						// Turn-state bookkeeping never replaces the transport failure.
					}
					// Nothing to undo when it never dispatched: this attempt's route was
					// only ever held pending, so dropping it stops a later attempt
					// inheriting a route this one merely intended to use. After dispatch
					// the route is already published and must stay.
					if (!dispatchStarted) pendingCodexAttemptRoute = null;
				}
				throw error;
			}

			async function runCacheAwareProviderAttempt(): Promise<Response> {
				// Codex replaces any client copy with its trusted, derived conversation
				// identity during transformation. Capture that local transport hint before
				// the broad private-header sanitizer removes it from the wire request.
				const webSocketConversationIdentity =
					attemptPlan.providerName === "codex"
						? transportRequest.headers.get(CODEX_CONVERSATION_ID_HEADER)
						: null;
				// Every transport attempt, including retries, passes this final boundary.
				// Preserve only trusted local synthetic-response markers; no
				// x-better-ccflare-* metadata may reach a real upstream transport.
				transportRequest = sanitizeInternalTransportHeaders(transportRequest);
				const trustedTransportHeaders = new Headers(transportRequest.headers);
				applyXaiConvIdHeader(
					trustedTransportHeaders,
					attemptPlan.providerName,
					account,
					getXaiConvId(requestMeta),
				);
				transportRequest = new Request(transportRequest, {
					headers: trustedTransportHeaders,
				});
				const isSynthetic = isSyntheticProviderResponse(transportRequest);
				latestPhysicalAnthropicCohortKey = isSynthetic
					? null
					: physicalAnthropicCohortKey(transportRequest, resolvedModel);
				if (
					!isSynthetic &&
					(reservation !== undefined ||
						latestPhysicalAnthropicCohortKey !== null)
				) {
					try {
						routingAttemptLedger?.assertPhysicalAttemptAvailable(
							physicalAttemptVetoContext(),
						);
					} catch (error) {
						// A caller may have reserved before an in-place retry backoff. If a
						// sibling send spent the last request-local slot meanwhile, release
						// that uncommitted permit before propagating the veto.
						if (reservation) cancelPhysicalSendReservation(reservation);
						throw error;
					}
				}
				const physicalReservation =
					reservation ??
					reservePhysicalSend(transportRequest, resolvedModel, null);
				// The reservation is already exclusive. Commit synchronously before
				// cache staging or provider I/O; no second contender can steal it.
				commitPhysicalSendReservation(physicalReservation);
				await stageCacheBodyForTransportAttempt({
					requestId: requestMeta.id,
					accountId: account.id,
					providerName: attemptPlan.providerName,
					replayBody,
					transportRequest,
					clientHeaders: req.headers,
					path: url.pathname,
					cacheIdentityHasCacheControl,
					isSyntheticProviderTransport: isSynthetic,
					resolvedModel:
						attemptPlan.cacheReplayModelStrategy === "transformed-body"
							? resolvedModel
							: null,
				});
				if (isSynthetic) {
					currentCodexWebSocketReceipt = null;
					return materializeSyntheticResponse(transportRequest);
				}
				const recordPhysicalDispatch = (): void => {
					routingAttemptLedger?.recordPhysicalAttempt({
						accountId: account.id,
						candidateId: modelFallbackPolicy?.routeCandidateId ?? null,
						laneKey: requestMeta.affinityLaneKey ?? null,
						recoveryProbe:
							physicalReservation.kind === "reserved" &&
							physicalReservation.permit.kind === "probe",
					});
					if (
						physicalReservation.kind !== "reserved" ||
						physicalReservation.permit.kind !== "probe" ||
						!physicalReservation.enforced ||
						physicalReservation.probeSendObserved
					) {
						return;
					}
					physicalReservation.probeSendObserved = true;
					try {
						anthropicDegradedState?.tracker?.recordProbe("sent");
					} catch {
						// The physical send remains authoritative over telemetry.
					}
				};
				const hostedAttempt = attemptPlan.capabilityProofKey !== null;
				// A provider-issued turn-state token is scoped to this HTTP turn. Never
				// offer the same transformed request to the persistent WebSocket lane.
				const hasCodexTurnStateReplay =
					attemptPlan.providerName === "codex" &&
					transportRequest.headers.has(CODEX_TURN_STATE_HEADER);
				const claimHostedDispatchAfterBudgetAssertion = (): void => {
					// onBeforeFrameSend asserted the budget immediately before this callback.
					// Reassert defensively before crossing the irreversible hosted boundary.
					routingAttemptLedger?.assertPhysicalAttemptAvailable(
						physicalAttemptVetoContext(),
					);
					claimCurrentHostedDispatch();
				};
				const claimHostedAndRecordHttpDispatch = (): void => {
					routingAttemptLedger?.assertPhysicalAttemptAvailable(
						physicalAttemptVetoContext(),
					);
					claimCurrentHostedDispatch();
					recordPhysicalDispatch();
				};
				const httpTransportRequest = hostedAttempt
					? new Request(transportRequest, { redirect: "manual" })
					: transportRequest;
				const response = await makeAttemptRequest(
					httpTransportRequest,
					attemptPlan.providerName === "codex" && !hasCodexTurnStateReplay
						? async (signal, markDispatched) => {
								currentCodexWebSocketReceipt = null;
								// Capture the concrete stamped attempt before any later retry mutates the
								// surrounding attempt variable. These are the same join keys written to
								// Codex usage/cache traces during response finalization.
								const websocketAttemptId = currentTransportAttemptId;
								if (!websocketAttemptId) return null;
								const websocketAttempt =
									await codexWebSocketTransport.tryRequest({
										requestId: requestMeta.id,
										attemptId: websocketAttemptId,
										accountId: account.id,
										providerName: attemptPlan.providerName,
										conversationIdentity: webSocketConversationIdentity,
										request: transportRequest,
										signal,
										onBeforeFrameSend: () =>
											routingAttemptLedger?.assertPhysicalAttemptAvailable(
												physicalAttemptVetoContext(),
											),
										onBeforeFrameWrite: hostedAttempt
											? () => {
													// Order matters: the budget assertion inside this claim
													// can still veto, and a vetoed attempt never wrote a
													// frame. Only once the hosted claim succeeds has the
													// attempt passed the point where annulling it would
													// discard a send that may have reached upstream.
													claimHostedDispatchAfterBudgetAssertion();
													markDispatched();
												}
											: undefined,
										onFrameWritten: (receipt) => {
											markDispatched();
											recordPhysicalDispatch();
											currentCodexWebSocketReceipt = receipt;
											// response.create is now irreversible, so neither the non-final
											// fallback reserve nor the cache-lane retry reserve can be used.
											// Promote the existing composite signal to the request-wide deadline.
											if (preCommitRescue) {
												activeAttemptCommitment?.promoteDeadlineTo(
													preCommitRescue.commitmentDeadlineAt,
												);
											}
										},
									});
								if (!websocketAttempt) return null;
								currentCodexWebSocketReceipt = websocketAttempt.receipt;
								return websocketAttempt.response;
							}
						: undefined,
					hostedAttempt
						? claimHostedAndRecordHttpDispatch
						: recordPhysicalDispatch,
					() => {
						dispatchStarted = true;
						// The irreversible boundary: only now is this attempt's route
						// something a later attempt should compare itself against.
						commitCodexDispatchedRoute();
					},
				);
				observeTrustedHttpOverload(response, transportRequest, resolvedModel);
				return response;
			}
		};
		const enforcePhysicalModelAfterTransform = async (
			transportRequest: Request,
			physicalModel: string | null | undefined,
			plan: ProviderAttemptPlan = attemptPlan,
		): Promise<Request> => {
			if (
				!physicalModel ||
				plan.cacheReplayModelStrategy !== "transformed-body" ||
				isSyntheticProviderResponse(transportRequest)
			) {
				return transportRequest;
			}
			return forceModelInTransformedRequest(transportRequest, physicalModel);
		};

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
			// Tie the upstream fetch to the client connection. When the client goes
			// away mid-stream (idle-watchdog abort, Ctrl-C, network drop) the
			// upstream request must be aborted too, instead of streaming on
			// unattended and holding the connection open.
			signal: req.signal,
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

		let transformedRequest = await transformWithCurrentAttemptPlan(
			attemptPlan,
			providerRequest,
		);
		transformedRequest = await enforcePhysicalModelAfterTransform(
			transformedRequest,
			attemptPlan.providerName === "codex"
				? attemptPlan.physicalModel
				: replayResolvedModel,
		);
		// Provider-local stream intent must reach processResponse, not upstream.
		// Capture it before transport sanitization and reattach only to the local
		// response object below.
		const internalRequestStream = transformedRequest.headers.get(
			"x-better-ccflare-request-stream",
		);
		const xaiCacheOfficialEndpoint = isOfficialXaiEndpoint(account);
		const xaiCacheKeyPresent =
			transformedRequest.headers.has("x-grok-conv-id") ||
			(attemptPlan.providerName === "xai" &&
				xaiCacheOfficialEndpoint &&
				getXaiConvId(requestMeta) !== null);
		const cacheFlightRecorderEligible =
			attemptPlan.providerName === "xai" &&
			url.pathname === "/v1/messages" &&
			xaiCacheOfficialEndpoint &&
			Boolean(requestMeta.cacheFlightRecorderConversationId);
		const isSyntheticResponse = isSyntheticProviderResponse(transformedRequest);

		// Pre-strip cache_control for (account, model) pairs known to reject it
		// Synthetic transports (notably Bedrock) contain the upstream RESPONSE:
		// never clone/buffer that response as though it were an outbound body.
		// Consume the one inspection clone now, then reconstruct an independent
		// retry body from its text below. Keeping an unread Request clone as a
		// retry template leaves a tee branch retaining the native request buffer.
		let retryBodyText = isSyntheticResponse
			? ""
			: await transformedRequest.clone().text();
		let currentCacheIdentityHasCacheControl: boolean | undefined =
			isSyntheticResponse
				? undefined
				: hasCacheControlHintInJsonText(retryBodyText);
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(retryBodyText);
		} catch {
			// ignore
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ??
			(isSyntheticResponse ? (concreteAttemptModel ?? "") : "");
		let currentTransportModel = transformedModel || concreteAttemptModel;
		if (
			routingAttemptLedger &&
			!(staleTokenRetryAttempt > 0
				? routingAttemptLedger.claimRetry(account.id, currentTransportModel)
				: routingAttemptLedger.claim(account.id, currentTransportModel))
		) {
			if (attemptAdmissionTracker) {
				attemptAdmissionTracker.nonCapacitySkipCount++;
			}
			log.debug(
				`Skipping duplicate request-local route account=${account.name} model=${currentTransportModel ?? "unknown"}`,
			);
			// The body transform above already registered this attempt's turn-state
			// context, and nothing will ever dispatch it or process its response.
			// Without this release it would hold its lease and keep its scope alive,
			// suppressing every matching continuation. Its route is dropped for the
			// same reason: a route that never sent must not be what a later re-entry
			// compares itself against. It was only ever held pending, so dropping it
			// is enough -- there is nothing published to restore.
			provider.abortTurnStateAttempt?.(currentTransportAttemptId);
			pendingCodexAttemptRoute = null;
			return null;
		}
		if (routingAttemptLedger) {
			// Merely attempting another unique route does not supersede a retained
			// upstream terminal. A later retained terminal replaces it through the
			// ledger, while the outer routing loop releases it after success or throw.
			// If this route fails without retaining a replacement, the earlier response
			// remains available once every unique route is exhausted.
			failoverAttempts = Math.max(
				failoverAttempts,
				routingAttemptLedger.attemptedCount - 1,
			);
		}
		if (attemptAdmissionTracker) attemptAdmissionTracker.attemptedCount++;

		const finalizedCodexAttemptIds = new Set<string>();
		const finalizeCurrentCodexTransport = async (
			discarded: Response,
			// Paths that stamp the next attempt before finalizing the one it
			// supersedes pass that superseded ID explicitly.
			attemptIdOverride?: string | null,
		) => {
			const attemptId = attemptIdOverride ?? currentTransportAttemptId;
			if (attemptPlan.providerName !== "codex" || !attemptId) return;
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
				const processed = await attemptPlan.processResponse(
					new Response(discarded.clone().body, {
						status: discarded.status,
						statusText: discarded.statusText,
						headers: traceHeaders,
					}),
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

		/**
		 * Handle one provider-issued 401 at the request-local failover seam.
		 *
		 * OAuth accounts get one same-account refresh/retry when the access token
		 * could be stale. If that retry cannot produce a different token, or the
		 * retry itself returns 401, persist a credential quarantine and let the
		 * outer account loop choose a sibling. API-key accounts skip refresh and
		 * are quarantined immediately. Protected/hosted responses remain owned by
		 * their terminal lifecycle and deliberately return `undefined` here.
		 */
		const handleUpstreamAuthFailure = async (
			failedResponse: Response,
			discardReason: string,
		): Promise<ProxyWithAccountResult | undefined> => {
			if (
				failedResponse.status !== 401 ||
				hostedDispatchCommitted() ||
				wasProtectedLifecycleForLatestResponse()
			) {
				return undefined;
			}
			// Keep the credential identity that produced this request stable across
			// concurrent reauth. The mutable Account object may already contain a new
			// token by the time the response is handled.
			const refreshEligible = canAttemptStaleTokenRefresh(account);
			const refreshAttempted = shouldAttemptStaleTokenRefresh(
				account,
				staleTokenRetryAttempt,
				isSyntheticInternal,
			);
			let refreshTokenUsedByFailure = requestRefreshTokenAtStart;
			if (refreshAttempted) {
				// Release the rejected response before awaiting token refresh. A slow
				// OAuth endpoint must not pin the upstream 401 socket/body.
				await discardUpstreamBody(failedResponse);
				// `accessToken` is the exact bearer used by this invocation's
				// transport. Reading account.access_token here would race a concurrent
				// reauth and could incorrectly classify a genuinely new token as a
				// no-op refresh.
				const tokenBefore = accessToken;
				let refreshedToken: string | null = null;
				try {
					refreshedToken = await runWithPreTransportDeadline({
						phase: "credential_resolution",
						timeoutMs:
							getPreTransportDeadlineConfig().credentialResolutionTimeoutMs,
						signal: routingSignal,
						operation: () => refreshAccessTokenSafe(account, ctx),
					});
				} catch (error) {
					const capturedRefreshToken = getRefreshTokenUsedForFailure(error);
					if (capturedRefreshToken !== undefined) {
						refreshTokenUsedByFailure = capturedRefreshToken;
					}
					log.warn(
						`Stale-token refresh failed for account ${account.name}: ${
							error instanceof Error ? error.message : String(error)
						}; failing over`,
					);
					// The token manager already durably pauses terminal invalid_grant
					// failures. A timeout/backoff failure is not enough evidence to
					// quarantine a healthy OAuth account; keep this request-local.
					if (!isTerminalTokenRefreshFailure(error)) {
						routingAttemptLedger?.blockAccount(account.id);
						await discardUnusedResponse(failedResponse, discardReason);
						return null;
					}
				}
				// A no-op refresh would just repeat the same rejected credential.
				if (refreshedToken && refreshedToken !== tokenBefore) {
					log.info(
						`Refreshed token for account ${account.name} after 401; retrying the same account`,
					);
					return proxyWithAccount(
						req,
						url,
						account,
						requestMeta,
						requestBodyBuffer,
						_createBodyStream,
						failoverAttempts,
						ctx,
						modelOverride,
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						returnRateLimitedResponseOnExhaustion,
						contextAdmissionTracker,
						routingAttemptLedger,
						modelFallbackPolicy,
						anthropicDegraded,
						staleTokenRetryAttempt + 1,
						requestRefreshTokenAtStart,
					);
				}
			}

			// Another request may already be refreshing this OAuth account. Its
			// 401 must not race that refresh into a durable pause; block only this
			// request and let the shared refresh result decide the next attempt.
			if (
				!refreshAttempted &&
				refreshEligible &&
				staleTokenRetryAttempt === 0 &&
				isStaleTokenRefreshCoolingDown(account.id)
			) {
				routingAttemptLedger?.blockAccount(account.id);
				await discardUnusedResponse(failedResponse, discardReason);
				return null;
			}

			// Internal synthetic probes are intentionally non-destructive: a probe
			// 401 should not pause a real OAuth account based on probe credentials.
			if (isSyntheticInternal) {
				routingAttemptLedger?.blockAccount(account.id);
				await discardUnusedResponse(failedResponse, discardReason);
				return null;
			}

			// A single upstream 401 is not sufficient evidence for an account-wide
			// credential quarantine. Custom endpoints and model-scoped gateways can
			// reject one route while the credential remains valid elsewhere. The
			// only safe durable signal here is a second 401 after a genuine OAuth
			// refresh/retry on the same account. Terminal invalid-grant refresh
			// failures are quarantined by the token manager itself. Every other
			// 401 remains request-local so one bad route cannot DoS the account.
			if (!refreshEligible || staleTokenRetryAttempt === 0) {
				routingAttemptLedger?.blockAccount(account.id);
				await discardUnusedResponse(failedResponse, discardReason);
				return null;
			}

			const failedCredentialRefreshToken = refreshTokenUsedByFailure ?? null;
			const reason = upstreamAuthFailureReason({
				provider: account.provider,
				refresh_token: failedCredentialRefreshToken,
			});
			routingAttemptLedger?.recordAuthFailure(account.id, reason);
			try {
				await runWithPreTransportDeadline({
					phase: "credential_resolution",
					timeoutMs:
						getPreTransportDeadlineConfig().credentialResolutionTimeoutMs,
					signal: routingSignal,
					operation: () =>
						pauseAccountForUpstreamAuthFailure(
							account,
							ctx.dbOps,
							failedCredentialRefreshToken,
						),
				});
			} catch (error) {
				log.warn(
					`Account ${account.name} auth quarantine did not complete before the credential-resolution deadline: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			await discardUnusedResponse(failedResponse, discardReason);
			return null;
		};
		const retainCodexContextOverflowResponse = async (
			retainedContextOverflowResponse: Response,
			authoritative: boolean,
		): Promise<void> => {
			if (routingAttemptLedger) {
				// This response may outlive later account/model attempts. Freeze the exact
				// route contract now so delayed delivery cannot inherit mutable provider or
				// model state from whichever attempt happens to run last.
				const retainedProxyContext = attemptProxyContext();
				const retainedForwardOptions: Omit<
					ResponseHandlerOptions,
					"response" | "failoverAttempts" | "terminalError"
				> = {
					requestId: requestMeta.id,
					method: req.method,
					path: url.pathname,
					account,
					requestHeaders: req.headers,
					requestBody: effectiveBodyBuffer,
					project: requestMeta.project,
					clientSessionId: requestMeta.clientSessionId ?? null,
					query: url.search || null,
					projectAttributionSource:
						requestMeta.projectAttributionSource ?? null,
					timestamp: requestMeta.timestamp,
					retryAttempt: 0,
					agentUsed: requestMeta.agentUsed,
					originalModel: requestMeta.originalModel,
					appliedModel: attemptAppliedModel,
					attemptedModel: currentTransportModel,
					agentAttributionSource: requestMeta.agentAttributionSource ?? null,
					comboName: requestMeta.comboName ?? null,
					comboModelOverrideFrom,
					comboModelOverrideTo,
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
					routeCandidateId,
					routingMeta: requestMeta,
					anthropicDegradedLifecycle: activeLifecycleForLatestResponse(),
					drainAbort: drainAbortController,
				};
				await routingAttemptLedger.retainTerminalResponse({
					terminalKind: authoritative
						? "authoritative_context_overflow"
						: "legacy_context_overflow",
					deliver: async (terminalFailoverAttempts) => {
						if (preCommitRescue?.isRescueCommitted()) {
							// The committed rescue owns the HTTP-200 wire response. Start its
							// deferred account-backed lifecycle through the ordinary seam using a
							// bodyless response shell; the outer terminal recorder then replaces
							// this pending success with context_length_exceeded exactly once.
							await forwardToClient(
								{
									...retainedForwardOptions,
									response: new Response(null, {
										status: 200,
										headers: {
											"cache-control": "no-cache",
											"content-type": "text/event-stream; charset=utf-8",
											"x-better-ccflare-precommit-rescue": "active",
										},
									}),
									failoverAttempts: terminalFailoverAttempts,
								},
								retainedProxyContext,
							);
							return withSanitizedProxyHeaders(retainedContextOverflowResponse);
						}
						return forwardToClient(
							{
								...retainedForwardOptions,
								response: retainedContextOverflowResponse,
								failoverAttempts: terminalFailoverAttempts,
								terminalError: "context_length_exceeded",
							},
							retainedProxyContext,
						);
					},
					discard: () => discardUpstreamBody(retainedContextOverflowResponse),
				});
				return;
			}
			await discardUpstreamBody(retainedContextOverflowResponse);
		};
		const hasRetainedLegacyContextOverflow = (): boolean =>
			routingAttemptLedger?.hasRetainedTerminalKind(
				"legacy_context_overflow",
			) === true;
		const handleProcessedCodexContextOverflow = async (
			candidateResponse: Response,
		): Promise<boolean> => {
			if (
				attemptPlan.providerName !== "codex" ||
				account.provider !== "codex" ||
				getCurrentCodexWebSocketReceipt()?.frameWritten === true
			) {
				return false;
			}
			const classification = await classifyCodexContextOverflowError(
				candidateResponse,
				readAttemptBoundJson,
			);
			if (!classification) return false;
			const authoritative = classification === "authoritative";
			const retainedLegacyContextOverflow = hasRetainedLegacyContextOverflow();
			const canReplayAuthoritativeOverflow =
				authoritative && canReplayContextOverflow();
			if (authoritative) {
				if (currentContextOverflowCapability) {
					routingAttemptLedger?.recordDeterministicFailure(
						currentContextOverflowCapability,
					);
				}
			}
			if (!authoritative && codexContextOverflowFallbackModel === null) {
				return false;
			}
			if (codexContextOverflowFallbackModel) {
				modelFallbackPolicy?.preferContextOverflowFallback?.(
					codexContextOverflowFallbackModel,
				);
			}
			log.info("codex_context_overflow_fallback", {
				requestId: requestMeta.id,
				accountId: account.id,
				attemptedModel: currentTransportModel,
				fallbackScope: authoritative
					? retainedLegacyContextOverflow
						? "larger_model_terminal"
						: canReplayAuthoritativeOverflow
							? "remaining_route"
							: "final_route_terminal"
					: "larger_model",
				responseStatus: candidateResponse.status,
			});
			await retainCodexContextOverflowResponse(
				candidateResponse,
				authoritative,
			);
			return true;
		};

		// Drains a superseded in-place-retry response so its usage capture and
		// attempt-trace finalization complete when the body ends promptly, while
		// guaranteeing a never-closing body (e.g. a live SSE stream with no
		// terminal frame) cannot hang the retry loop: past the bound the drain
		// is abandoned and the reader is cancelled instead.
		const drainSupersededResponse = async (discarded: Response) => {
			const body = discarded.body;
			if (!body) return;
			// This response is the sole owner of its registered fetch transport.
			// Response.clone() tee siblings never inherit this authority.
			await drainReader(body.getReader(), {
				deadlineMs: getInPlaceRetryDrainTimeoutMs(),
				transportAbort: getResponseDrainTransport(discarded),
			});
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
				// A URL-based rebuild drops the signal — carry it over. Belt-and-
				// braces: executeCacheAwareProviderAttempt below also threads an
				// explicit AbortSignal into every physical transport, but a rebuilt
				// Request should never silently lose the one it started with.
				signal: req.signal,
			});
			retryBodyText = strippedBodyText;
			currentCacheIdentityHasCacheControl =
				hasCacheControlHintInJsonText(retryBodyText);
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// The 529 in-place retry must resend the CURRENT physical transport, not
		// the original request: thinking/cache-control retries and model fallback
		// all replace the outbound body, and reverting silently changes the model.
		// Rebuild its body from consumed retry text rather than holding an unread
		// clone of the transformed request, which would retain a tee branch.
		const retryRequest = new Request(transformedRequest.url, {
			method: transformedRequest.method,
			headers: transformedRequest.headers,
			body: retryBodyText || undefined,
			signal: req.signal,
		});
		let retrySourceRequest = providerRequest;
		let retryTransformedTemplate = retryRequest;

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
			!hostedDispatchCommitted() &&
			isClaudeProvider &&
			(await isInvalidThinkingSignatureError(rawResponse, readAttemptBoundJson))
		) {
			log.info(
				`Detected invalid thinking block signature error for account ${account.name}, retrying with thinking blocks filtered`,
			);

			// Filter thinking blocks from the request body
			const filteredBodyBuffer = filterThinkingBlocks(currentReplayBody);

			if (filteredBodyBuffer && filteredBodyBuffer !== currentReplayBody) {
				// Retry the request with filtered body
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(filteredBodyBuffer),
					duplex: "half",
					signal: req.signal,
				};

				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				stampCodexAttempt(headers, "thinking_retry");
				const retryProviderRequest = new Request(targetUrl, retryRequestInit);
				retrySourceRequest = retryProviderRequest.clone();

				let retryTransformedRequest = await transformWithCurrentAttemptPlan(
					attemptPlan,
					retryProviderRequest,
				);
				retryTransformedRequest = await enforcePhysicalModelAfterTransform(
					retryTransformedRequest,
					currentTransportModel,
				);
				retryTransformedTemplate = retryTransformedRequest.clone();

				const retryTransportRequest = retryTransformedTemplate.clone();
				currentReplayBody = filteredBodyBuffer;
				currentCacheIdentityHasCacheControl = undefined;
				// Make the retry request (or unwrap a synthetic provider response).
				// The prior rawResponse body was already drained above via
				// discardUpstreamBody before this retry request was built.
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

		// A retained Codex encrypted-reasoning block that can no longer be
		// verified is resent by Claude Code on every later turn. Strip only the
		// proxy-minted retention blocks and replay this physical route once so a
		// single rejected history item cannot permanently wedge the conversation.
		if (
			!hostedDispatchCommitted() &&
			attemptPlan.providerName === "codex" &&
			(await isCodexReasoningVerificationError(
				rawResponse,
				readAttemptBoundJson,
			))
		) {
			const strippedBodyBuffer = filterCodexReasoningBlocks(currentReplayBody);

			if (strippedBodyBuffer && strippedBodyBuffer !== currentReplayBody) {
				log.info(
					`Codex rejected retained encrypted reasoning for account ${account.name}, retrying with proxy-minted reasoning blocks removed`,
				);
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(strippedBodyBuffer),
					duplex: "half",
					signal: req.signal,
				};

				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				stampCodexAttempt(headers, "reasoning_retry");
				const retryProviderRequest = new Request(targetUrl, retryRequestInit);
				retrySourceRequest = retryProviderRequest.clone();

				let retryTransformedRequest = await transformWithCurrentAttemptPlan(
					attemptPlan,
					retryProviderRequest,
				);
				retryTransformedRequest = await enforcePhysicalModelAfterTransform(
					retryTransformedRequest,
					currentTransportModel,
				);
				retryTransformedTemplate = retryTransformedRequest.clone();

				const retryTransportRequest = retryTransformedTemplate.clone();
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
					"No proxy-minted Codex reasoning blocks to strip or filtering failed, proceeding with original error response",
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
			!hostedDispatchCommitted() &&
			isClaudeProvider &&
			(await isClearThinkingRequiresThinkingError(
				rawResponse,
				readAttemptBoundJson,
			))
		) {
			const strippedBodyBuffer = filterClearThinkingEdits(currentReplayBody);

			if (strippedBodyBuffer && strippedBodyBuffer !== currentReplayBody) {
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

				let retryTransformedRequest = await transformWithCurrentAttemptPlan(
					attemptPlan,
					retryProviderRequest,
				);
				retryTransformedRequest = await enforcePhysicalModelAfterTransform(
					retryTransformedRequest,
					currentTransportModel,
				);
				retryTransformedTemplate = retryTransformedRequest.clone();

				const retryTransportRequest = retryTransformedTemplate.clone();
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

		// GPT-5.6 explicit breakpoints are a dark canary on the private Codex
		// subscription route as well as the documented public Responses route. If
		// that exact field is rejected, always learn the account/model/endpoint
		// capability. Only a pre-content attempt may transparently retry the
		// unchanged normalized source once; a post-frame rejection must flow through
		// without replay while future turns skip the known-unsupported marker.
		const transformedRequestHadExplicitBreakpoint =
			hasCodexExplicitCacheBreakpoint(transformedBodyJson);
		const explicitBreakpointRejection =
			attemptPlan.providerName === "codex" &&
			(await isCodexExplicitCacheBreakpointRejectionError(
				rawResponse,
				transformedRequestHadExplicitBreakpoint,
				readAttemptBoundJson,
			));
		if (explicitBreakpointRejection && !hostedDispatchCommitted()) {
			suppressCodexExplicitCacheBreakpoint(
				account.id,
				transformedModel,
				transformedRequest.url,
			);
			const replayBody = currentReplayBody;
			if (
				replayBody !== null &&
				!getCurrentCodexWebSocketReceipt()?.frameWritten
			) {
				log.info(
					`Codex rejected prompt_cache_breakpoint for account=${account.name} model=${transformedModel}; retrying once without it`,
				);
				await finalizeCurrentCodexTransport(rawResponse);
				await discardUpstreamBody(rawResponse);
				const retryHeaders = new Headers(providerRequest.headers);
				stampCodexAttempt(
					retryHeaders,
					"prompt_cache_breakpoint_retry",
					currentTransportModel ?? undefined,
				);
				const retrySource = new Request(providerRequest.url, {
					method: providerRequest.method,
					headers: retryHeaders,
					body: new Uint8Array(replayBody),
				});
				retrySourceRequest = retrySource.clone();
				let retryTransformed = await transformWithCurrentAttemptPlan(
					attemptPlan,
					retrySource,
				);
				retryTransformed = await enforcePhysicalModelAfterTransform(
					retryTransformed,
					currentTransportModel,
				);
				// Materialize two independent requests. Reusing nested clone branches here
				// can leave Bun waiting on tee bookkeeping after the compatibility probe.
				const retryTransformedBody = await retryTransformed.text();
				retryTransformedTemplate = new Request(retryTransformed.url, {
					method: retryTransformed.method,
					headers: retryTransformed.headers,
					body: retryTransformedBody,
				});
				const retryTransport = new Request(retryTransformed.url, {
					method: retryTransformed.method,
					headers: retryTransformed.headers,
					body: retryTransformedBody,
				});
				rawResponse = await executeCacheAwareProviderAttempt(
					retryTransport,
					replayBody,
					currentCacheIdentityHasCacheControl,
					currentTransportModel,
				);
			}
		}

		// Retry without cache_control if provider rejected it (e.g. GLM-5.1 strict validation).
		// Mark (accountId, model) so subsequent requests skip cache_control immediately.
		if (
			!hostedDispatchCommitted() &&
			(await isCacheControlRejectionError(rawResponse, readAttemptBoundJson))
		) {
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
				const retryBodyJson = JSON.parse(retryBodyText);
				stripCacheControlFromOpenAIRequest(retryBodyJson);
				let retryRequest: Request;
				if (attemptPlan.providerName === "codex") {
					await finalizeCurrentCodexTransport(rawResponse);
					await discardUpstreamBody(rawResponse);
					const retryHeaders = new Headers(providerRequest.headers);
					stampCodexAttempt(retryHeaders, "cache_control_retry");
					const retryReplayBody =
						stripCacheControlFromReplayBody(currentReplayBody);
					if (!retryReplayBody) {
						throw new Error("Failed to strip cache_control from replay body");
					}
					const retrySource = new Request(providerRequest.url, {
						method: providerRequest.method,
						headers: retryHeaders,
						body: new Uint8Array(retryReplayBody),
					});
					currentReplayBody = retryReplayBody;
					currentCacheIdentityHasCacheControl = undefined;
					retrySourceRequest = retrySource.clone();
					const retryTransformed = await transformWithCurrentAttemptPlan(
						attemptPlan,
						retrySource,
					);
					retryTransformedTemplate = retryTransformed.clone();
					retryRequest = retryTransformedTemplate.clone();
				} else {
					const retryBodyText = JSON.stringify(retryBodyJson);
					retryRequest = new Request(transformedRequest.url, {
						method: transformedRequest.method,
						headers: transformedRequest.headers,
						body: retryBodyText,
						// A URL-based rebuild drops the signal — carry it over.
						signal: req.signal,
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
					// The codex branch above already drains the pre-retry rawResponse
					// via discardUpstreamBody; this branch has no equivalent call, so
					// drain it here before the reassignment below drops the reference.
					cancelDiscardedResponseBody(rawResponse);
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
			// mislabeled with this generic reason. Every other provider's 402
			// handling awaits the same bounded durable cooldown persistence here.
			if (account.provider === "xai") return null;
			const reason = "upstream_402_payment_required";
			const cooldownUntil = extractCooldownUntil(
				failureResponse,
				account.id,
				usageCache.getRateLimitedUntil.bind(usageCache),
			);
			const cooldownBefore = captureCooldownState(account);
			await applyRateLimitCooldownAwaitingPersist(
				account,
				{ resetTime: cooldownUntil, reason },
				ctx,
			);
			const accountBenched = appliedCooldown(account, cooldownBefore);
			const routeSuppressed = routingAttemptLedger !== undefined;
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
			enqueueRoutingAttempt(ctx, {
				parentRequestId: requestMeta.id,
				timestamp: Date.now(),
				provider: account.provider,
				accountId: account.id,
				attemptedModel: attemptedModel,
				modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
				statusCode: 402,
				reason,
				upstreamEvidence: await captureSanitizedUpstreamEvidence(
					ctx,
					failureResponse,
					{
						consumeOriginalBody: true,
					},
				),
				scope: "account",
				availableAt: null,
				failoverAttempts,
				physicalAttempt:
					routingAttemptLedger && routingAttemptLedger.physicalAttemptCount > 0
						? routingAttemptLedger.physicalAttemptCount
						: null,
				accountBenched,
				routeSuppressed,
				circuitCounted: false,
			});
			return {
				scope: "account",
				attemptedModel,
				family: attemptedModel ? getModelFamily(attemptedModel) : null,
				stopAccountAttempt: true,
			};
		};

		/**
		 * Classify Anthropic's extra-usage billing rejection as request-local route
		 * exhaustion. It must not create a cooldown or durable usage marker: another
		 * account, or a distinct concrete model slot on the same account, may still
		 * serve this request. Keep one original upstream 400 in the request ledger so
		 * total route exhaustion returns the real billing response instead of a
		 * synthetic 503.
		 */
		const handleExtraUsageExhausted400 = async (
			failureResponse: Response,
			attemptedModel: string | null,
		): Promise<RawAttemptFailureClassification | null> => {
			if (
				failureResponse.status !== 400 ||
				!isClaudeProvider ||
				!(await isAnthropicExtraUsageExhausted(failureResponse))
			) {
				return null;
			}

			const reason = "extra_usage_exhausted";
			log.warn(
				`Account ${account.name} extra_usage_exhausted (400${attemptedModel ? `, model=${attemptedModel}` : ""}) — ` +
					"retaining the original response and continuing request-local failover without a global cooldown",
			);
			enqueueRoutingAttempt(ctx, {
				parentRequestId: requestMeta.id,
				timestamp: Date.now(),
				provider: account.provider,
				accountId: account.id,
				attemptedModel: attemptedModel,
				modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
				statusCode: 400,
				reason,
				upstreamEvidence: await captureSanitizedUpstreamEvidence(
					ctx,
					failureResponse,
				),
				scope: "request",
				availableAt: null,
				failoverAttempts,
				physicalAttempt:
					routingAttemptLedger && routingAttemptLedger.physicalAttemptCount > 0
						? routingAttemptLedger.physicalAttemptCount
						: null,
				accountBenched: false,
				routeSuppressed: false,
				circuitCounted: false,
			});

			if (!routingAttemptLedger) {
				return {
					scope: "not-classified",
					attemptedModel,
					family: attemptedModel ? getModelFamily(attemptedModel) : null,
					stopAccountAttempt: false,
					retainedTerminalResponse: true,
					returnOriginalResponse: true,
				};
			}

			const retainedResponse = failureResponse;
			await routingAttemptLedger.retainTerminalResponse({
				deliver: async () => withSanitizedProxyHeaders(retainedResponse),
				discard: () => discardUpstreamBody(retainedResponse),
			});
			return {
				scope: "model",
				attemptedModel,
				family: attemptedModel ? getModelFamily(attemptedModel) : null,
				stopAccountAttempt: false,
				retainedTerminalResponse: true,
			};
		};

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
			// ── windowless 429: request-scoped, NOT account-wide (issue #301) ──
			// Anthropic 429s some requests with `x-should-retry: true` and not one
			// rate-limit header (`retry-after`, `anthropic-ratelimit-*`,
			// `x-ratelimit-*`). Live measurement (upstream #301) showed these are
			// scoped to the individual request, not the account: the same account
			// serves 200s seconds either side of the rejection, in-place retries
			// never clear it, and every other account rejects the same request
			// identically. Benching would drain the pool one account per attempt.
			// Fail over per request with NO cooldown, NO consecutive-429 increment,
			// and — unlike the classified model/family branches below — NO
			// usageCache exhaustion marker (measured recovery is ~38s; a 5-minute
			// model-scoped marker would wrongly suppress a healthy route). The
			// enclosing guard has already excluded non-429, non-Claude,
			// out_of_credits, and keepalive traffic — the exact preconditions
			// upstream's placement required.
			if (isRetryable429(failureResponse, isClaudeProvider)) {
				const reason = "windowless_429";
				log.warn(
					`Account ${account.name} returned a windowless 429 (${
						attemptedModel ? `model=${attemptedModel}, ` : ""
					}x-should-retry with no rate-limit window) — request-scoped, ` +
						`NOT benching account; failing over to next account`,
				);
				enqueueRoutingAttempt(ctx, {
					parentRequestId: requestMeta.id,
					timestamp: Date.now(),
					provider: account.provider,
					accountId: account.id,
					attemptedModel: attemptedModel,
					modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
					statusCode: 429,
					reason,
					upstreamEvidence: await captureSanitizedUpstreamEvidence(
						ctx,
						failureResponse,
						{
							consumeOriginalBody: true,
						},
					),
					scope: "request",
					availableAt: null,
					failoverAttempts,
					physicalAttempt:
						routingAttemptLedger &&
						routingAttemptLedger.physicalAttemptCount > 0
							? routingAttemptLedger.physicalAttemptCount
							: null,
					accountBenched: false,
					routeSuppressed: false,
					circuitCounted: false,
				});
				return {
					scope: "model",
					attemptedModel,
					family: attemptedModel ? getModelFamily(attemptedModel) : null,
					stopAccountAttempt: false,
				};
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
				const auditReason = "model_fallback_429";
				// Read the header directly, never extractCooldownUntil's output: that
				// collapses header, usage-poller and synthetic values into one number
				// and cannot tell an instruction from a guess.
				const attributedReset = boundedAccountHoldReset(
					decision.accountWindowResetAt,
					getAnthropicRateLimitResetAt(failureResponse, Date.now()),
				);
				const cooldownBefore = captureCooldownState(account);
				await applyRateLimitCooldownAwaitingPersist(
					account,
					{
						// ONLY the account window that proved this verdict may size the
						// hold, and the classifier hands that timestamp over directly.
						// #158 keyed on the verdict's reason and then passed
						// extractCooldownUntil's independently-chosen value, which is a
						// different question: it picks the response header, the
						// usage-poller value, or a synthetic fallback, none checked
						// against the proving window. A spent 2h session window paired
						// with a per-model reset days out still wrote a 12h whole-account
						// bench (#160). No attributed reset -> the backoff ramp decides.
						resetTime: attributedReset ?? cooldownUntil,
						reason: auditReason,
						resetTimeScope:
							attributedReset !== null ? "confirmed" : "unattributed",
					},
					ctx,
				);
				const accountBenched = appliedCooldown(account, cooldownBefore);
				const routeSuppressed = routingAttemptLedger !== undefined;
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
				enqueueRoutingAttempt(ctx, {
					parentRequestId: requestMeta.id,
					timestamp: Date.now(),
					provider: account.provider,
					accountId: account.id,
					attemptedModel: attemptedModel,
					modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
					statusCode: 429,
					reason: auditReason,
					upstreamEvidence: await captureSanitizedUpstreamEvidence(
						ctx,
						failureResponse,
						{
							consumeOriginalBody: true,
						},
					),
					scope: "account",
					availableAt: account.rate_limited_until,
					failoverAttempts,
					physicalAttempt:
						routingAttemptLedger &&
						routingAttemptLedger.physicalAttemptCount > 0
							? routingAttemptLedger.physicalAttemptCount
							: null,
					accountBenched,
					routeSuppressed,
					circuitCounted: false,
				});
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
			const reason = "model_scoped_429";
			log.warn(
				`Account ${account.name} generic 429 classified ${decision.scope} scoped ` +
					`(model=${attemptedModel}, family=${decision.family}, evidence_age_ms=${decision.snapshotAgeMs ?? "unknown"}) — ` +
					"NOT benching account; pruning only the evidenced route scope",
			);
			enqueueRoutingAttempt(ctx, {
				parentRequestId: requestMeta.id,
				timestamp: Date.now(),
				provider: account.provider,
				accountId: account.id,
				attemptedModel: attemptedModel,
				modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
				statusCode: 429,
				reason,
				upstreamEvidence: await captureSanitizedUpstreamEvidence(
					ctx,
					failureResponse,
					{
						consumeOriginalBody: true,
					},
				),
				scope: decision.scope,
				availableAt: availableAt,
				failoverAttempts,
				physicalAttempt:
					routingAttemptLedger && routingAttemptLedger.physicalAttemptCount > 0
						? routingAttemptLedger.physicalAttemptCount
						: null,
				accountBenched: false,
				routeSuppressed: availableAt !== null,
				circuitCounted: false,
			});
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
		const recordExactModelExhaustion = (
			attemptedModel: string,
		): number | null => {
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
			const availableAt = marker?.expiresAt ?? null;
			recordRequestRateLimitOutcome(req, {
				accountId: account.id,
				status: 429,
				scope: "model",
				family: getModelFamily(attemptedModel),
				attemptedModel,
				reason: "out_of_credits",
				availableAt,
			});
			return availableAt;
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

			const reason = "out_of_credits";
			const modelAvailableAt = attemptedModel
				? recordExactModelExhaustion(attemptedModel)
				: null;
			log.warn(
				`Account ${account.name} out_of_credits (429${attemptedModel ? `, model=${attemptedModel}` : ""}) — ` +
					"model/beta-scoped, NOT benching account; pruning this exact model from request-local routing",
			);
			enqueueRoutingAttempt(ctx, {
				parentRequestId: requestMeta.id,
				timestamp: Date.now(),
				provider: account.provider,
				accountId: account.id,
				attemptedModel: attemptedModel,
				modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
				statusCode: 429,
				reason,
				upstreamEvidence: await captureSanitizedUpstreamEvidence(
					ctx,
					failureResponse,
					{
						consumeOriginalBody: true,
					},
				),
				scope: "model",
				availableAt: modelAvailableAt,
				failoverAttempts,
				physicalAttempt:
					routingAttemptLedger && routingAttemptLedger.physicalAttemptCount > 0
						? routingAttemptLedger.physicalAttemptCount
						: null,
				accountBenched: false,
				routeSuppressed: modelAvailableAt !== null,
				circuitCounted: false,
			});
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
				(await handleExtraUsageExhausted400(failureResponse, attemptedModel)) ??
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
			if (!classification.retainedTerminalResponse) {
				await discardUpstreamBody(failureResponse);
			}
			return classification;
		};

		const initialAttemptedModel =
			currentTransportModel || effectiveBodyContext.getModel();
		let rawFailureClassification: RawAttemptFailureClassification = {
			scope: "not-classified",
			attemptedModel: initialAttemptedModel,
			family: initialAttemptedModel
				? getModelFamily(initialAttemptedModel)
				: null,
			stopAccountAttempt: false,
		};
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
		// A committed enforced degraded-mode send owns this request's only
		// physical attempt. Preserve its response before any raw classifier,
		// model fallback, cooldown failover, or body drain can consume it.
		if (
			!wasProtectedLifecycleForLatestResponse() &&
			!hostedDispatchCommitted()
		) {
			rawFailureClassification = await handleRawAttemptFailure(rawResponse);
			if (rawFailureClassification.returnOriginalResponse) {
				return withSanitizedProxyHeaders(rawResponse);
			}
			if (rawFailureClassification.stopAccountAttempt) {
				return null;
			}
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
				(isScopedFailure(rawFailureClassification) ||
					(await isModelUnavailableError(rawResponse, readAttemptBoundJson)))
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
				if (effectiveBodyBuffer)
					requestedModel = effectiveBodyContext.getModel();

				if (rawResponse.status === 429) {
					const isKeepalive =
						req.headers.get("x-better-ccflare-keepalive") === "true";

					// Preserve verified Codex recovery provenance before the generic 429
					// model-fallback path can replace it with model_fallback_429 and a
					// fabricated probe cooldown. The provider only supplies
					// upstream_429_with_reset for a plausible direct reset hint or for a
					// reset paired with the exact exhausted usage window; routine quota
					// telemetry alone is not trusted. The cooldown helper applies the shared
					// safety ceiling before persisting the verified deadline.
					const codexRateLimitInfo =
						attemptPlan.providerName === "codex" && !isKeepalive
							? attemptPlan.parseRateLimit(rawResponse)
							: null;
					const verifiedCodexReset =
						codexRateLimitInfo?.isRateLimited === true &&
						codexRateLimitInfo.reason === "upstream_429_with_reset" &&
						typeof codexRateLimitInfo.resetTime === "number" &&
						Number.isFinite(codexRateLimitInfo.resetTime) &&
						codexRateLimitInfo.resetTime > Date.now();
					if (verifiedCodexReset) {
						const reason = "upstream_429_with_reset";
						log.warn(
							`Account ${account.name} received a verified Codex quota reset — persisting account cooldown before failover`,
						);
						const cooldownBefore = captureCooldownState(account);
						await applyRateLimitCooldownAwaitingPersist(
							account,
							{
								resetTime: codexRateLimitInfo.resetTime,
								remaining: codexRateLimitInfo.remaining,
								reason,
							},
							ctx,
						);
						const accountBenched = appliedCooldown(account, cooldownBefore);
						const routeSuppressed = routingAttemptLedger !== undefined;
						const attemptedModel = currentTransportModel ?? requestedModel;
						routingAttemptLedger?.blockAccount(account.id);
						enqueueRoutingAttempt(ctx, {
							parentRequestId: requestMeta.id,
							timestamp: Date.now(),
							provider: account.provider,
							accountId: account.id,
							attemptedModel,
							modelFamily: attemptedModel
								? getModelFamily(attemptedModel)
								: null,
							statusCode: 429,
							reason,
							upstreamEvidence: await captureSanitizedUpstreamEvidence(
								ctx,
								rawResponse,
								{
									consumeOriginalBody: true,
								},
							),
							scope: "account",
							availableAt: account.rate_limited_until,
							failoverAttempts,
							physicalAttempt:
								routingAttemptLedger &&
								routingAttemptLedger.physicalAttemptCount > 0
									? routingAttemptLedger.physicalAttemptCount
									: null,
							accountBenched,
							routeSuppressed,
							circuitCounted: false,
						});
						await finalizeCurrentCodexTransport(rawResponse);
						await discardUpstreamBody(rawResponse);
						return null;
					}
				}

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
							const isKeepalive = isInternalProbe(
								req.headers,
								ctx,
								"keepalive",
							);
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
							const reason = "model_fallback_429";
							const upstreamEvidence = await captureSanitizedUpstreamEvidence(
								ctx,
								rawResponse,
								{
									consumeOriginalBody: true,
								},
							);
							const cooldownBefore = captureCooldownState(account);
							const circuitCounted = applyRateLimitCooldown(
								account,
								{ resetTime: cooldownUntil, reason },
								ctx,
							);
							const attemptedModel = currentTransportModel ?? requestedModel;
							const accountBenched = appliedCooldown(account, cooldownBefore);
							const routeSuppressed = routingAttemptLedger !== undefined;
							routingAttemptLedger?.blockAccount(account.id);
							enqueueRoutingAttempt(ctx, {
								parentRequestId: requestMeta.id,
								timestamp: Date.now(),
								provider: account.provider,
								accountId: account.id,
								attemptedModel,
								modelFamily: attemptedModel
									? getModelFamily(attemptedModel)
									: null,
								statusCode: 429,
								reason,
								upstreamEvidence,
								scope: "account",
								availableAt: account.rate_limited_until,
								failoverAttempts,
								physicalAttempt:
									routingAttemptLedger &&
									routingAttemptLedger.physicalAttemptCount > 0
										? routingAttemptLedger.physicalAttemptCount
										: null,
								accountBenched,
								routeSuppressed,
								circuitCounted,
							});
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
						const modelUnavailableProxyContext = attemptProxyContext();
						const modelUnavailableForwardBase: Omit<
							ResponseHandlerOptions,
							"response" | "failoverAttempts"
						> = {
							requestId: requestMeta.id,
							method: req.method,
							path: url.pathname,
							account,
							requestHeaders: req.headers,
							requestBody: effectiveBodyBuffer,
							project: requestMeta.project,
							clientSessionId: requestMeta.clientSessionId ?? null,
							query: url.search || null,
							projectAttributionSource:
								requestMeta.projectAttributionSource ?? null,
							timestamp: requestMeta.timestamp,
							retryAttempt: 0,
							agentUsed: requestMeta.agentUsed,
							originalModel: requestMeta.originalModel,
							appliedModel: attemptAppliedModel,
							attemptedModel: currentTransportModel,
							agentAttributionSource:
								requestMeta.agentAttributionSource ?? null,
							comboName: requestMeta.comboName,
							comboModelOverrideFrom,
							comboModelOverrideTo,
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
							routeCandidateId,
							routingMeta: requestMeta,
							anthropicDegradedLifecycle: activeLifecycleForLatestResponse(),
							drainAbort: drainAbortController,
						};
						if (
							modelFallbackPolicy?.forwardModelUnavailableResponse === false
						) {
							log.warn(
								`Planned model ${requestedModel} unavailable on account ${account.name}; continuing the global model-first queue`,
							);
							await finalizeCurrentCodexTransport(rawResponse);
							if (routingAttemptLedger) {
								const retainedModelUnavailableResponse = rawResponse;
								await routingAttemptLedger.retainTerminalResponse({
									deliver: async (terminalFailoverAttempts) => {
										return forwardToClient(
											{
												...modelUnavailableForwardBase,
												response: retainedModelUnavailableResponse,
												failoverAttempts: terminalFailoverAttempts,
											},
											modelUnavailableProxyContext,
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
						await finalizeCurrentCodexTransport(rawResponse);
						if (modelFallbackPolicy?.prepareFinalResponse === true) {
							const modelUnavailableForwardOptions: ResponseHandlerOptions = {
								...modelUnavailableForwardBase,
								response: rawResponse,
								failoverAttempts,
							};
							const modelUnavailableLifecycle =
								modelUnavailableForwardOptions.anthropicDegradedLifecycle;
							let settled = false;
							preparedResponseOwnsLifecycle =
								modelUnavailableLifecycle !== null &&
								modelUnavailableLifecycle !== undefined;
							return {
								kind: "prepared_proxy_account_response",
								response: rawResponse,
								disposition: "ordinary",
								account,
								candidateId: routeCandidateId,
								isFinalAttempt: true,
								continueAfterOrdinaryFailure: false,
								canSupersedeRetainedTerminal: () =>
									canPreparedResponseSupersedeRetainedTerminal(rawResponse),
								async commit() {
									if (settled) {
										throw new Error(
											"prepared account response already settled",
										);
									}
									settled = true;
									preparedResponseOwnsLifecycle = false;
									return await forwardToClient(
										modelUnavailableForwardOptions,
										modelUnavailableProxyContext,
									);
								},
								async discard() {
									if (settled) return;
									settled = true;
									preparedResponseOwnsLifecycle = false;
									await discardUpstreamBody(rawResponse);
									if (
										modelUnavailableLifecycle &&
										!modelUnavailableLifecycle.isTransferred &&
										!modelUnavailableLifecycle.isSettled
									) {
										modelUnavailableLifecycle.settle(
											req.signal.aborted ? "cancelled" : "failed",
										);
									}
								},
							} satisfies PreparedProxyAccountResponse;
						}
						const observedSessionId = sessionIdForObservation(req.headers);
						if (observedSessionId) {
							recordServedAccount(
								observedSessionId,
								account.id,
								requestMeta.timestamp,
								requestMeta.routeProfileId ?? null,
								currentTransportModel
									? {
											requestedModel: requestMeta.originalModel ?? null,
											appliedModel: attemptAppliedModel ?? null,
											upstreamModel: currentTransportModel,
										}
									: null,
							);
						}
						return withSanitizedProxyHeaders(rawResponse);
					}

					let deferredFallbackRank = 0;
					let lastModelFallbackCapabilityError: ServerToolCandidateCapabilityError | null =
						null;
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
						// Patch from the LIVE replay body, not the frozen original: an
						// earlier retry in this same request may have rewritten it
						// (thinking-block filter, clear_thinking strip, Codex reasoning
						// strip). Rebuilding from effectiveBodyContext here resurrects
						// exactly the content that retry proved the upstream rejects, and
						// those classifiers are sequential `if`s that already ran — the
						// resurrected rejection would reach the fallback candidates with
						// no handler left. Falls back to the original context when no
						// retry has replaced the body.
						const replayContext =
							currentReplayBody && currentReplayBody !== effectiveBodyBuffer
								? new RequestBodyContext(currentReplayBody)
								: effectiveBodyContext;
						const patchedContext = replayContext.withPatchedModel(nextModel);
						const patchedBody = patchedContext?.getBuffer() ?? null;
						if (!patchedBody) {
							log.warn("Failed to patch request body for model retry");
							break;
						}
						let fallbackPlan: ProviderAttemptPlan;
						let fallbackHeaders: Headers;
						let retryTransformedRequest: Request;
						// The response this fallback supersedes is finalized further down,
						// after the ledger claim, so its attempt identity has to survive the
						// stamp below.
						const supersededCodexAttemptId: string | null =
							currentTransportAttemptId;
						const supersededCodexAccountId =
							requestMeta.codexLastAttemptAccountId;
						const supersededCodexModel = requestMeta.codexLastAttemptModel;
						let fallbackAttemptStamped = false;
						try {
							if (provider.name === "codex") {
								await ensureCodexModelDefaults(account, ctx);
							}
							// Exact capability and replay readiness are resolved before the
							// request ledger can claim this physical fallback.
							fallbackPlan = materializeAttemptPlan(
								patchedBody,
								nextModel,
								false,
							);
							fallbackHeaders = prepareAttemptHeaders(fallbackPlan);
							// Stamp before the request is built and transformed: the Codex
							// provider registers this attempt's turn-state context during the
							// transform, reading the attempt ID and cause from these headers.
							// Stamping afterwards registered the attempt under an identity the
							// response never carries -- so its terminal resolved nothing -- and
							// hid the model fallback behind the default `initial` cause, which
							// skips the suppression a route change requires. Mirrors the
							// in-place 529 retry, which stamps before transforming.
							stampCodexAttempt(fallbackHeaders, "model_fallback", nextModel);
							fallbackAttemptStamped = true;
							const retryRequestInit: RequestInit & { duplex?: "half" } = {
								method: req.method,
								headers: fallbackHeaders,
								body: new Uint8Array(patchedBody),
								duplex: "half",
							};
							const retryProviderRequest = new Request(
								fallbackPlan.targetUrl,
								retryRequestInit,
							);
							retrySourceRequest = retryProviderRequest.clone();
							retryTransformedRequest = await transformWithCurrentAttemptPlan(
								fallbackPlan,
								retryProviderRequest,
							);
							retryTransformedRequest =
								await enforcePhysicalModelAfterTransform(
									retryTransformedRequest,
									nextModel,
									fallbackPlan,
								);
						} catch (error) {
							// This candidate never sends, so the superseded response is still
							// the live attempt for whatever runs next.
							if (fallbackAttemptStamped) {
								provider.abortTurnStateAttempt?.(currentTransportAttemptId);
								currentTransportAttemptId = supersededCodexAttemptId;
								requestMeta.codexLastAttemptAccountId =
									supersededCodexAccountId;
								requestMeta.codexLastAttemptModel = supersededCodexModel;
							}
							if (error instanceof ServerToolCandidateCapabilityError) {
								lastModelFallbackCapabilityError = error;
								continue;
							}
							if (
								error instanceof PhysicalAttemptBudgetExceededError &&
								!isScopedFailure(rawFailureClassification)
							) {
								// A provider-owned transform (currently Bedrock) may perform the
								// next physical send before this fallback reaches the shared fetch
								// boundary. If that send is vetoed, release the prior model failure
								// that this loop still owns before crossing the account seam.
								await finalizeCurrentCodexTransport(rawResponse);
								await discardUpstreamBody(rawResponse);
							}
							throw error;
						}

						// getModelList returns concrete provider models, and the transformed
						// request is force-patched to this exact value. Claim only after the
						// proof-equality transform gate has succeeded.
						const fallbackContextOverflowCapability =
							contextOverflowCapabilityForPlan(fallbackPlan);
						if (
							routingAttemptLedger &&
							((fallbackContextOverflowCapability !== null &&
								routingAttemptLedger.hasDeterministicFailure(
									fallbackContextOverflowCapability,
								)) ||
								!routingAttemptLedger.claim(account.id, nextModel))
						) {
							if (attemptAdmissionTracker) {
								attemptAdmissionTracker.nonCapacitySkipCount++;
							}
							log.debug(
								`Skipping duplicate request-local model fallback account=${account.name} model=${nextModel}`,
							);
							provider.abortTurnStateAttempt?.(currentTransportAttemptId);
							currentTransportAttemptId = supersededCodexAttemptId;
							requestMeta.codexLastAttemptAccountId = supersededCodexAccountId;
							requestMeta.codexLastAttemptModel = supersededCodexModel;
							continue;
						}
						lastModelFallbackCapabilityError = null;
						if (routingAttemptLedger) {
							failoverAttempts = Math.max(
								failoverAttempts,
								routingAttemptLedger.attemptedCount - 1,
							);
						}
						if (!isScopedFailure(rawFailureClassification)) {
							await finalizeCurrentCodexTransport(
								rawResponse,
								supersededCodexAttemptId,
							);
							await discardUpstreamBody(rawResponse);
						}
						attemptPlan = fallbackPlan;
						currentContextOverflowCapability =
							fallbackContextOverflowCapability;
						attemptProvider = bindProviderAttemptPlan(fallbackPlan);
						headers = fallbackHeaders;
						currentTransportModel = nextModel;
						targetUrl = fallbackPlan.targetUrl;
						retryTransformedTemplate = retryTransformedRequest.clone();

						const retryTransportRequest = retryTransformedRequest;
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
							!(await isModelUnavailableError(
								rawResponse,
								readAttemptBoundJson,
							))
						) {
							break; // Success — stop cycling
						}
					}
					if (lastModelFallbackCapabilityError) {
						await finalizeCurrentCodexTransport(rawResponse);
						await discardUpstreamBody(rawResponse);
						throw lastModelFallbackCapabilityError;
					}
				}

				// If still unavailable/rate-limited after exhausting the model list,
				// failover to the next account. OpenAI-compatible providers never set
				// isRateLimited:true in parseRateLimit, so we must handle it here.
				if (
					isScopedFailure(rawFailureClassification) ||
					(await isModelUnavailableError(rawResponse, readAttemptBoundJson))
				) {
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
						const isKeepalive = isInternalProbe(req.headers, ctx, "keepalive");
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
							const reason = "all_models_exhausted_429";
							const upstreamEvidence = await captureSanitizedUpstreamEvidence(
								ctx,
								rawResponse,
								{
									consumeOriginalBody: true,
								},
							);
							const cooldownBefore = captureCooldownState(account);
							const circuitCounted = applyRateLimitCooldown(
								account,
								{ resetTime: cooldownUntil, reason },
								ctx,
							);
							const attemptedModel = currentTransportModel ?? requestedModel;
							const accountBenched = appliedCooldown(account, cooldownBefore);
							const routeSuppressed = routingAttemptLedger !== undefined;
							routingAttemptLedger?.blockAccount(account.id);
							enqueueRoutingAttempt(ctx, {
								parentRequestId: requestMeta.id,
								timestamp: Date.now(),
								provider: account.provider,
								accountId: account.id,
								attemptedModel,
								modelFamily: attemptedModel
									? getModelFamily(attemptedModel)
									: null,
								statusCode: 429,
								reason,
								upstreamEvidence,
								scope: "account",
								availableAt: account.rate_limited_until,
								failoverAttempts,
								physicalAttempt:
									routingAttemptLedger &&
									routingAttemptLedger.physicalAttemptCount > 0
										? routingAttemptLedger.physicalAttemptCount
										: null,
								accountBenched,
								routeSuppressed,
								circuitCounted,
							});
						}
					}
					await finalizeCurrentCodexTransport(rawResponse);
					await discardUpstreamBody(rawResponse);
					return null;
				}
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
		const internalCustomTools = transformedRequest.headers.get(
			"x-better-ccflare-codex-custom-tools",
		);
		if (internalCustomTools === "true" || internalCustomTools === "false") {
			responseHeaders.set(
				"x-better-ccflare-codex-custom-tools",
				internalCustomTools,
			);
		}
		// Inject the original request path so providers can identify the
		// response type (e.g. /v1/models vs /v1/messages) in processResponse
		// without needing the original request object.
		responseHeaders.set("x-better-ccflare-request-path", requestMeta.path);
		const taggedRawResponse = new Response(rawResponse.body, {
			status: rawResponse.status,
			statusText: rawResponse.statusText,
			headers: responseHeaders,
		});
		transferResponseDrainTransport(rawResponse, taggedRawResponse);

		// Process response (transform format, sanitize headers, etc.) using account-specific provider
		let response = await attemptPlan.processResponse(
			taggedRawResponse,
			req.headers,
			getResponseDrainTransport(taggedRawResponse),
		);
		if (attemptPlan.providerName === "codex" && currentTransportAttemptId) {
			finalizedCodexAttemptIds.add(currentTransportAttemptId);
		}

		if (
			!hostedDispatchCommitted() &&
			(await handleProcessedCodexContextOverflow(response))
		) {
			return null;
		}

		// A provider-issued 401 is either repaired by one bounded same-account
		// OAuth refresh/retry or quarantined and failed over. Protected/hosted
		// lifecycles remain terminal and are intentionally untouched.
		if (response.status === 401 && !hostedDispatchCommitted()) {
			const authResult = await handleUpstreamAuthFailure(
				response,
				"auth_failed_401",
			);
			if (authResult !== undefined) return authResult;
		}

		// In-place retry for reset-less 529 (overloaded_error) — bounded attempts with
		// full-jitter exponential backoff before applying account cooldown. This prevents
		// all accounts cooling simultaneously under concurrency spikes. Skipped for
		// synthetic (keepalive / auto-refresh) requests to avoid loop amplification.
		if (
			response.status === 529 &&
			!hostedDispatchCommitted() &&
			!isSyntheticInternal &&
			!wasProtectedLifecycleForLatestResponse()
		) {
			// No clone: parseRateLimit is synchronous (providers/types.ts) and
			// reads only headers and status, so it cannot touch the body. Cloning
			// here teed the body into a second stream that nothing ever read or
			// disposed of — one orphan per 529, plus one per in-place retry
			// below. See issue #354.
			const rlInfo = attemptPlan.parseRateLimit(response);
			if (rlInfo.isRateLimited && !rlInfo.resetTime) {
				const retryCfg = getOverloadRetryConfig();
				if (retryCfg.enabled && retryCfg.maxAttempts > 1) {
					for (let attempt = 1; attempt < retryCfg.maxAttempts; attempt++) {
						try {
							routingAttemptLedger?.assertPhysicalAttemptAvailable(
								physicalAttemptVetoContext(),
							);
						} catch (error) {
							// The current 529 is local ownership: the request terminalizer
							// cannot see it after the budget veto crosses this account seam.
							await discardUpstreamBody(response);
							throw error;
						}
						let retryTransport = retryTransformedTemplate.clone();
						// Reserve before backoff or touching the trusted 529. A denied
						// follower returns it untouched to the outer terminal authority.
						const degradedReservation = reservePhysicalSend(
							retryTransport,
							currentTransportModel,
							response,
						);
						// Full-jitter backoff: sleep in [0, min(base * 2^attempt, max)]
						const cap = Math.min(
							retryCfg.baseMs * 2 ** attempt,
							retryCfg.maxMs,
						);
						const delayMs = Math.random() * cap;
						try {
							await new Promise<void>((resolve) =>
								setTimeout(resolve, delayMs),
							);
						} catch (error) {
							cancelPhysicalSendReservation(degradedReservation);
							throw error;
						}

						log.info(
							`Account ${account.name}: in-place retry ${attempt}/${retryCfg.maxAttempts - 1} after ${Math.round(delayMs)}ms for 529 overloaded_error`,
						);

						// Commit is noncontending and synchronous. It precedes every
						// destructive drain below and the cache staging/fetch in the
						// shared executor.
						commitPhysicalSendReservation(degradedReservation, response);
						if (attemptPlan.providerName === "codex") {
							const retryHeaders = new Headers(retrySourceRequest.headers);
							await drainSupersededResponse(response);
							stampCodexAttempt(
								retryHeaders,
								"overload_529",
								currentTransportModel ?? undefined,
							);
							const retrySourceInit: RequestInit & { duplex?: "half" } = {
								method: retrySourceRequest.method,
								headers: retryHeaders,
							};
							if (currentReplayBody) {
								retrySourceInit.body = new Uint8Array(currentReplayBody);
								retrySourceInit.duplex = "half";
							}
							const retrySource = new Request(
								retrySourceRequest.url,
								retrySourceInit,
							);
							let retryTransformed = await transformWithCurrentAttemptPlan(
								attemptPlan,
								retrySource,
							);
							if (currentTransportModel) {
								retryTransformed = await forceModelInTransformedRequest(
									retryTransformed,
									currentTransportModel,
								);
							}
							retryTransport = retryTransformed;
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
							degradedReservation,
						);
						const retryFailureClassification = await handleRawAttemptFailure(
							retryRaw,
							currentTransportModel || effectiveBodyContext.getModel(),
						);
						if (retryFailureClassification.scope !== "not-classified") {
							return null;
						}

						// A Codex retry re-transforms its reconstructed body. Read the
						// transport's final metadata so the response tags describe the
						// actual retry rather than the superseded first attempt.
						const retryRequestStream = retryTransport.headers.get(
							"x-better-ccflare-request-stream",
						);
						const retryCustomTools = retryTransport.headers.get(
							"x-better-ccflare-codex-custom-tools",
						);

						// Mirror the first response's metadata tagging: providers read
						// stream intent / custom-tool state from these headers, and the
						// map fallback behind them has a 30s TTL a long backoff can
						// outlive — the request ID alone is not enough.
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
						if (
							retryRequestStream === "true" ||
							retryRequestStream === "false"
						) {
							retryTaggedHeaders.set(
								"x-better-ccflare-request-stream",
								retryRequestStream,
							);
						}
						if (retryCustomTools === "true" || retryCustomTools === "false") {
							retryTaggedHeaders.set(
								"x-better-ccflare-codex-custom-tools",
								retryCustomTools,
							);
						}
						retryTaggedHeaders.set(
							"x-better-ccflare-request-path",
							requestMeta.path,
						);
						const retryTaggedRaw = new Response(retryRaw.body, {
							status: retryRaw.status,
							statusText: retryRaw.statusText,
							headers: retryTaggedHeaders,
						});
						transferResponseDrainTransport(retryRaw, retryTaggedRaw);
						const retryResponse = await attemptPlan.processResponse(
							retryTaggedRaw,
							req.headers,
							getResponseDrainTransport(retryTaggedRaw),
						);

						await discardUpstreamBody(response);
						response = retryResponse;
						if (await handleProcessedCodexContextOverflow(retryResponse)) {
							return null;
						}

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

						// Header-only read, see the note on the first parseRateLimit
						// call above — the retry response must not be teed either.
						const retryRlInfo = attemptPlan.parseRateLimit(retryResponse);
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

		// Re-check 401 after an in-place 529 retry. The same bounded auth handler
		// prevents a revoked credential from being sent again on later requests.
		if (response.status === 401 && !hostedDispatchCommitted()) {
			const authResult = await handleUpstreamAuthFailure(
				response,
				"auth_failed_401_after_retry",
			);
			if (authResult !== undefined) return authResult;
		}
		if (response.status >= 200 && response.status < 400) {
			clearStaleTokenRefreshState(account.id);
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
			!hostedDispatchCommitted() &&
			attemptPlan.providerName === "codex" &&
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
				providerName: attemptPlan.providerName,
				requestHeaders: req.headers,
				response,
			});
			const nativeAnthropicHeadersAreRateLimited =
				isNativeAnthropicMessagesStream &&
				attemptPlan.parseRateLimit(response).isRateLimited;
			if (
				!isDownstreamAnthropicMessagesStream ||
				nativeAnthropicHeadersAreRateLimited
			) {
				break;
			}
			const protectedPrecommitSend = wasProtectedLifecycleForLatestResponse();
			const protectedPrecommitBackup = protectedPrecommitSend
				? response.clone()
				: null;
			const downstreamAnthropicResponseBody = response.body;
			if (!downstreamAnthropicResponseBody) {
				if (protectedPrecommitBackup) {
					await discardUnusedResponse(
						protectedPrecommitBackup,
						"protected_precommit_backup_empty",
					);
				}
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
			const websocketReceipt = getCurrentCodexWebSocketReceipt();
			const hasIrreversibleCodexWebSocketWrite =
				preCommitRescue !== undefined &&
				websocketReceipt?.frameWritten === true;
			// Split only this already-allocated candidate slice. The request-wide
			// deadline and any global fallback reserve remain unchanged, while the
			// first cache lane cannot consume the retry's bounded share.
			const cacheLaneRescueReserveMs =
				!hasIrreversibleCodexWebSocketWrite &&
				officialCodexCacheLaneRescueEligible &&
				!codexPrecommitRetryAttempted &&
				attemptCommitmentDeadlineAt !== undefined
					? getCodexCacheLaneRescueReserveMs(attemptCommitmentBudgetMs)
					: 0;
			const semanticCommitmentDeadlineAt = hasIrreversibleCodexWebSocketWrite
				? preCommitRescue.commitmentDeadlineAt
				: attemptCommitmentDeadlineAt === undefined
					? undefined
					: attemptCommitmentDeadlineAt - cacheLaneRescueReserveMs;
			const codexAuthoritativeContextOverflowCanBeHandled =
				!hostedDispatchCommitted() &&
				attemptPlan.providerName === "codex" &&
				account.provider === "codex";
			try {
				const gatedBody = await gateAnthropicSsePreCommit(
					downstreamAnthropicResponseBody,
					{
						semanticTimeoutMs: streamConfig.semanticTimeoutMs,
						disableProtocolIdleTimeout: hasIrreversibleCodexWebSocketWrite,
						meaningfulProgressTimeoutMs:
							streamConfig.meaningfulProgressTimeoutMs,
						commitmentDeadlineAt: semanticCommitmentDeadlineAt,
						terminalGraceMs: streamConfig.terminalGraceMs,
						maxBufferedBytes: streamConfig.maxBufferedBytes,
						failOnContextOverflow:
							codexContextOverflowFallbackModel !== null ||
							codexAuthoritativeContextOverflowCanBeHandled,
						requireAuthoritativeContextOverflow:
							codexContextOverflowFallbackModel === null,
						signal: activeAttemptCommitment?.signal ?? currentTransportSignal(),
					},
				);
				response = wrapAnthropicPrecommitGatedResponse(response, gatedBody);
				if (protectedPrecommitBackup) {
					await discardUnusedResponse(
						protectedPrecommitBackup,
						"protected_precommit_backup_unused",
					);
				}
				break;
			} catch (error) {
				const websocketReceipt = getCurrentCodexWebSocketReceipt();
				if (websocketReceipt?.frameWritten) {
					activeAttemptCommitment?.abortIfDeadlineElapsed();
				}
				if (activeAttemptCommitment?.isPrivateDeadline()) {
					if (websocketReceipt?.frameWritten) {
						websocketReceipt.markPostWriteFailure("semantic_stall");
						response = createCodexWebSocketNoReplayResponse(
							504,
							"semantic_stall",
						);
						break;
					}
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
				const authoritativeContextOverflow =
					error instanceof AnthropicPreCommitStallError &&
					error.reason === "context_length_exceeded" &&
					error.contextOverflowAuthoritative === true;
				// Consult the request-level replay policy before applying the stronger
				// WebSocket no-replay boundary. A written response.create vetoes even a
				// safe cross-provider candidate, but the authoritative capability evidence
				// must still be retained for every later request-local routing decision.
				const authoritativeContextOverflowCanReplay =
					authoritativeContextOverflow && canReplayContextOverflow();
				if (authoritativeContextOverflow) {
					if (currentContextOverflowCapability) {
						routingAttemptLedger?.recordDeterministicFailure(
							currentContextOverflowCapability,
						);
					}
				}
				// A Responses WebSocket request cannot be replayed once response.create
				// has been written: the server may have accepted the turn even when no
				// meaningful downstream event arrived. Surface one final error and pin
				// this conversation to HTTP before considering any HTTP/cache-lane retry.
				if (websocketReceipt?.frameWritten) {
					const failureCategory =
						classifyAnthropicPreCommitWebSocketFailure(error) ??
						"post_write_error";
					websocketReceipt.markPostWriteFailure(failureCategory);
					response = createCodexWebSocketNoReplayResponse(
						failureCategory === "semantic_stall" ? 504 : 502,
						failureCategory,
					);
					break;
				}
				if (!(error instanceof AnthropicPreCommitStallError)) throw error;
				if (
					error.reason === "context_length_exceeded" &&
					(codexContextOverflowFallbackModel !== null ||
						(error.contextOverflowAuthoritative === true &&
							codexAuthoritativeContextOverflowCanBeHandled))
				) {
					if (codexContextOverflowFallbackModel) {
						modelFallbackPolicy?.preferContextOverflowFallback?.(
							codexContextOverflowFallbackModel,
						);
					}
					log.info("codex_context_overflow_fallback", {
						requestId: requestMeta.id,
						accountId: account.id,
						attemptedModel: currentTransportModel,
						fallbackScope:
							codexContextOverflowFallbackModel !== null
								? "larger_model"
								: hasRetainedLegacyContextOverflow()
									? "larger_model_terminal"
									: authoritativeContextOverflowCanReplay
										? "remaining_route"
										: "final_route_terminal",
						bufferedBytes: error.bufferedBytes,
						framesSeen: error.framesSeen,
					});
					// A larger model may already be queued by deferImplicitFallback;
					// otherwise the request-local route ledger still has a distinct
					// replay-safe candidate. Codex records the terminal trace before
					// emitting this downstream error frame, and the gate cancels its
					// private reader before any meaningful client-visible bytes escape.
					// This is request/model capacity, not unhealthy account evidence.
					await retainCodexContextOverflowResponse(
						createCodexContextOverflowTerminalResponse(
							error.contextOverflowAuthoritative === true,
						),
						error.contextOverflowAuthoritative === true,
					);
					return null;
				}
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
					let rescueTransformedRequest = await transformWithCurrentAttemptPlan(
						attemptPlan,
						rescueSourceRequest,
					);
					rescueTransformedRequest = await enforcePhysicalModelAfterTransform(
						rescueTransformedRequest,
						currentTransportModel,
					);
					retryTransformedTemplate = rescueTransformedRequest.clone();
					const rescueBodyText = await rescueTransformedRequest.clone().text();
					currentCacheIdentityHasCacheControl =
						hasCacheControlHintInJsonText(rescueBodyText);
					const rescueTransportRequest = rescueTransformedRequest;
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
					if (
						internalCustomTools === "true" ||
						internalCustomTools === "false"
					) {
						rescueResponseHeaders.set(
							"x-better-ccflare-codex-custom-tools",
							internalCustomTools,
						);
					}
					rescueResponseHeaders.set(
						"x-better-ccflare-request-path",
						requestMeta.path,
					);
					const rescueTaggedRaw = new Response(rawResponse.body, {
						status: rawResponse.status,
						statusText: rawResponse.statusText,
						headers: rescueResponseHeaders,
					});
					transferResponseDrainTransport(rawResponse, rescueTaggedRaw);
					response = await attemptPlan.processResponse(
						rescueTaggedRaw,
						req.headers,
						getResponseDrainTransport(rescueTaggedRaw),
					);
					if (currentTransportAttemptId) {
						finalizedCodexAttemptIds.add(currentTransportAttemptId);
					}
					if (await handleProcessedCodexContextOverflow(response)) {
						return null;
					}
					if (response.status === 401) {
						const authResult = await handleUpstreamAuthFailure(
							response,
							isPrecommitSseRetry
								? "auth_failed_401_after_precommit_sse_retry"
								: "auth_failed_401_after_cache_lane_rescue",
						);
						if (authResult !== undefined) return authResult;
					}
					if (response.status >= 200 && response.status < 400) {
						clearStaleTokenRefreshState(account.id);
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
				let protectedSemanticDenial: AnthropicDegradedSendDenied | null = null;
				if (
					error.errorType === "rate_limit_error" ||
					error.errorType === "overloaded_error"
				) {
					if (error.errorType === "overloaded_error") {
						// Semantic HTTP-200 overload is trusted pre-commit evidence.
						// Record it synchronously before the outer route can reserve
						// another physical send for this request.
						observeTrustedOverload(
							response,
							latestPhysicalAnthropicCohortKey,
							"semantic_overloaded",
						);
						if (protectedPrecommitSend) {
							const suppression = anthropicDegradedState?.admission.reserve(
								account.id,
								latestPhysicalAnthropicCohortKey,
							);
							if (!suppression || suppression.action !== "suppress") {
								throw new Error(
									"Committed Anthropic semantic overload was not terminally suppressed",
								);
							}
							protectedSemanticDenial = {
								kind: "anthropic_degraded_send_denied",
								decision: suppression,
								retainedTrustedResponse:
									createProtectedAnthropicOverloadResponse({
										kind: "semantic_overload",
										retryAfter: response.headers.get("retry-after"),
									}),
							};
						}
					}
					handleAnthropicSseRateLimit(
						account,
						currentTransportModel,
						error.errorType,
						response,
						requestMeta.id,
						attemptProxyContext(),
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
				if (protectedSemanticDenial) {
					if (protectedPrecommitBackup) {
						await discardUnusedResponse(
							protectedPrecommitBackup,
							"protected_precommit_backup_overloaded",
						);
					}
					throw new AnthropicDegradedSendDeniedError(protectedSemanticDenial);
				}
				if (protectedPrecommitBackup) {
					// The gate consumed only its tee branch. Preserve the exact
					// same-request non-overload SSE terminal instead of falling
					// through to another account after the protected send budget.
					response = protectedPrecommitBackup;
					break;
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
		let rateLimitObservation: RateLimitObservation | null = null;
		const isRateLimited = await processProxyResponse(
			responseForRateLimitCheck,
			account,
			attemptProxyContext(),
			requestMeta.id,
			requestMeta,
			(observation) => {
				rateLimitObservation = observation;
			},
		);
		if (responseForRateLimitCheck !== response) {
			// The rate-limit check ran on a clone whose header-only use is done.
			// boundResponseBodyForClassification already buffered it into a
			// synthetic Response, so release it via the drain primitive —
			// body.cancel() is a measured no-op on released Bun (issue #273).
			cancelDiscardedResponseBody(responseForRateLimitCheck);
		}
		if (isRateLimited) {
			// Every raw-response writer above returns before this point. This is the
			// sole telemetry path for response-processor classifications, so its
			// observation can be emitted exactly once regardless of terminal,
			// retained, or ordinary failover disposition.
			const enqueueObservedRateLimitAttempt = async (
				routeSuppressed: boolean,
				consumeOriginalBody: boolean,
			): Promise<void> => {
				if (!rateLimitObservation) return;
				const attemptedModel = currentTransportModel ?? null;
				enqueueRoutingAttempt(ctx, {
					parentRequestId: requestMeta.id,
					timestamp: Date.now(),
					provider: account.provider,
					accountId: account.id,
					attemptedModel,
					modelFamily: attemptedModel ? getModelFamily(attemptedModel) : null,
					statusCode: rateLimitObservation.status,
					reason: rateLimitObservation.reason,
					upstreamEvidence: await captureSanitizedUpstreamEvidence(
						ctx,
						response,
						{
							consumeOriginalBody,
						},
					),
					scope: "account",
					availableAt: rateLimitObservation.availableAt,
					failoverAttempts,
					physicalAttempt:
						routingAttemptLedger &&
						routingAttemptLedger.physicalAttemptCount > 0
							? routingAttemptLedger.physicalAttemptCount
							: null,
					accountBenched: rateLimitObservation.accountBenched,
					routeSuppressed,
					circuitCounted: rateLimitObservation.circuitCounted,
				});
			};
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
						clientSessionId: requestMeta.clientSessionId ?? null,
						query: url.search || null,
						projectAttributionSource:
							requestMeta.projectAttributionSource ?? null,
						response: terminalResponse,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts: terminalFailoverAttempts,
						agentUsed: requestMeta.agentUsed,
						originalModel: requestMeta.originalModel,
						appliedModel: attemptAppliedModel,
						attemptedModel: currentTransportModel,
						agentAttributionSource: requestMeta.agentAttributionSource ?? null,
						comboName: comboNameAtAttempt,
						comboModelOverrideFrom,
						comboModelOverrideTo,
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
						routeCandidateId,
						routingMeta: requestMeta,
						anthropicDegradedLifecycle: activeLifecycleForLatestResponse(),
						drainAbort: drainAbortController,
					},
					attemptProxyContext(),
				);
			if (hostedDispatchCommitted()) {
				await enqueueObservedRateLimitAttempt(false, false);
				// The first hosted provider response is authoritative for this inbound
				// request. Preserve it exactly; converting it into an account miss would
				// invite model/account/guard replay after an irreversible execution.
				return await forwardTerminalRateLimitResponse(
					response,
					failoverAttempts,
				);
			}
			if (wasProtectedLifecycleForLatestResponse()) {
				await enqueueObservedRateLimitAttempt(false, false);
				return await forwardTerminalRateLimitResponse(
					response.status === 529
						? createProtectedAnthropicOverloadResponse({
								kind: "trusted_upstream",
								response,
								retryAfter: response.headers.get("retry-after"),
							})
						: response,
					failoverAttempts,
				);
			}
			const routeSuppressed =
				req.headers.get("x-better-ccflare-keepalive") !== "true" &&
				routingAttemptLedger !== undefined;
			if (routeSuppressed) {
				routingAttemptLedger.blockAccount(account.id);
			}
			const retainsRateLimitResponse =
				isTerminalRateLimitStatus &&
				(returnRateLimitedResponseOnExhaustion ||
					routingAttemptLedger !== undefined);
			await enqueueObservedRateLimitAttempt(
				routeSuppressed,
				!retainsRateLimitResponse,
			);
			if (returnRateLimitedResponseOnExhaustion && isTerminalRateLimitStatus) {
				log.warn(
					`Account ${account.name} returned final ${response.status} rate-limit/capacity response, forwarding upstream response instead of pool_exhausted`,
				);
				if (modelFallbackPolicy?.prepareFinalResponse === true) {
					let settled = false;
					const retainedResponse = response;
					return {
						kind: "prepared_proxy_account_response",
						response: retainedResponse,
						disposition: "ordinary",
						account,
						candidateId: routeCandidateId,
						isFinalAttempt: isFinalSemanticAttempt(),
						continueAfterOrdinaryFailure: false,
						canSupersedeRetainedTerminal: () =>
							canPreparedResponseSupersedeRetainedTerminal(retainedResponse),
						async commit() {
							if (settled) {
								throw new Error("prepared account response already settled");
							}
							settled = true;
							return await forwardTerminalRateLimitResponse(
								retainedResponse,
								failoverAttempts,
							);
						},
						async discard() {
							if (settled) return;
							settled = true;
							await discardUpstreamBody(retainedResponse);
						},
					} satisfies PreparedProxyAccountResponse;
				}
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

		// Prepare the response without claiming request history, session ownership,
		// or downstream body delivery. The outer request scheduler arbitrates this
		// candidate against any retained terminal before committing exactly one
		// winner; every losing body is released exactly once.
		const hasLogicalModelRewrite = isModelRewrite(
			requestMeta.originalModel,
			attemptAppliedModel,
		);
		const clientRequestedModel =
			requestMeta.originalModel ?? baseBodyContext.getModel();
		const hasTransportModelProvenance =
			response.ok &&
			!hasLogicalModelRewrite &&
			clientRequestedModel !== null &&
			currentTransportModel !== null &&
			clientRequestedModel !== currentTransportModel;
		const forwardOriginalModel = hasTransportModelProvenance
			? clientRequestedModel
			: requestMeta.originalModel;
		const forwardAppliedModel = hasTransportModelProvenance
			? currentTransportModel
			: attemptAppliedModel;

		const responseLifecycle = activeLifecycleForLatestResponse();
		const forwardOptions = {
			requestId: requestMeta.id,
			method: req.method,
			path: url.pathname,
			account,
			requestHeaders: req.headers,
			requestBody: effectiveBodyBuffer,
			project: requestMeta.project,
			clientSessionId: requestMeta.clientSessionId ?? null,
			query: url.search || null,
			projectAttributionSource: requestMeta.projectAttributionSource ?? null,
			response,
			timestamp: requestMeta.timestamp,
			retryAttempt: 0,
			failoverAttempts,
			agentUsed: requestMeta.agentUsed,
			originalModel: forwardOriginalModel,
			appliedModel: forwardAppliedModel,
			attemptedModel: currentTransportModel,
			agentAttributionSource: requestMeta.agentAttributionSource ?? null,
			comboName: requestMeta.comboName,
			comboModelOverrideFrom,
			comboModelOverrideTo,
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
			routeCandidateId,
			routingMeta: requestMeta,
			anthropicDegradedLifecycle: responseLifecycle,
			drainAbort: drainAbortController,
		};
		const forwardContext = attemptProxyContext();
		if (modelFallbackPolicy?.prepareFinalResponse !== true) {
			const forwardedResponse = forwardToClient(forwardOptions, forwardContext);
			if (responseLifecycle?.enforced || hostedDispatchCommitted()) {
				return await forwardedResponse;
			}
			return forwardedResponse;
		}
		let settled = false;
		preparedResponseOwnsLifecycle = responseLifecycle !== null;
		return {
			kind: "prepared_proxy_account_response",
			response,
			disposition:
				getCurrentCodexWebSocketReceipt()?.frameWritten === true && !response.ok
					? "irreversible_no_replay"
					: "ordinary",
			account,
			candidateId: routeCandidateId,
			isFinalAttempt: isFinalSemanticAttempt(),
			continueAfterOrdinaryFailure:
				modelFallbackPolicy?.continueAfterPreparedFailure === true,
			canSupersedeRetainedTerminal: () =>
				canPreparedResponseSupersedeRetainedTerminal(response),
			async commit() {
				if (settled)
					throw new Error("prepared account response already settled");
				settled = true;
				preparedResponseOwnsLifecycle = false;
				try {
					return await forwardToClient(forwardOptions, forwardContext);
				} catch (error) {
					if (
						responseLifecycle &&
						!responseLifecycle.isTransferred &&
						!responseLifecycle.isSettled
					) {
						responseLifecycle.settle("failed");
					}
					throw error;
				}
			},
			async discard(_reason = "superseded by routing winner") {
				if (settled) return;
				settled = true;
				preparedResponseOwnsLifecycle = false;
				await discardUpstreamBody(response);
				if (
					responseLifecycle &&
					!responseLifecycle.isTransferred &&
					!responseLifecycle.isSettled
				) {
					responseLifecycle.settle(req.signal.aborted ? "cancelled" : "failed");
				}
			},
		} satisfies PreparedProxyAccountResponse;
	} catch (err) {
		const committedLifecycle = anthropicDegradedState?.lifecycle;
		if (req.signal.aborted) {
			if (
				committedLifecycle &&
				!committedLifecycle.isTransferred &&
				!committedLifecycle.isSettled
			) {
				committedLifecycle.settle("cancelled");
			}
			// Client disconnected: the socket is gone, so failing over to another
			// account would burn pool capacity answering nobody. End the request
			// with nginx's 499 (client closed request).
			log.info(
				`Client disconnected during request to ${account.name} — ending instead of failing over`,
			);
			return new Response(null, { status: 499 });
		}
		if (
			err instanceof PhysicalAttemptBudgetExceededError &&
			routingAttemptLedger?.hostedDispatchState !== "hosted_dispatched"
		) {
			// Request-local policy veto: do not classify it as account/provider
			// health, and let the request orchestrator terminate every sibling loop.
			throw err;
		}
		if (
			err instanceof HostedDispatchTerminalError ||
			routingAttemptLedger?.hostedDispatchState === "hosted_dispatched"
		) {
			const terminalError =
				err instanceof HostedDispatchTerminalError
					? err
					: new HostedDispatchTerminalError("ambiguous_transport", err);
			return createHostedDispatchTerminalResponse(terminalError);
		}
		if (err instanceof ForceRouteUnavailableError) {
			throw err;
		}
		if (err instanceof ServerToolCandidateCapabilityError) {
			// Exact capability drift is request-local. It must not pause the account,
			// poison route health, or be collapsed into a generic transport failure;
			// the request orchestrator owns sibling failover and the final terminal.
			throw err;
		}
		if (
			committedLifecycle &&
			!preparedResponseOwnsLifecycle &&
			!committedLifecycle.isTransferred &&
			!committedLifecycle.isSettled
		) {
			committedLifecycle.settle(
				routingSignal.aborted || req.signal.aborted ? "cancelled" : "failed",
			);
		}
		if (
			committedLifecycle?.enforced &&
			committedLifecycle.transportSignal.aborted
		) {
			const suppression = anthropicDegradedState?.admission.reserve(
				account.id,
				committedLifecycle.cohortKey,
			);
			if (suppression?.action === "suppress") {
				return {
					kind: "anthropic_degraded_send_denied",
					decision: suppression,
					retainedTrustedResponse: null,
				};
			}
		}
		if (err instanceof AnthropicDegradedSendDeniedError) {
			return err.denial;
		}
		if (
			routingSignal.aborted ||
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
		const committedLifecycle = anthropicDegradedState?.lifecycle;
		if (
			committedLifecycle &&
			!preparedResponseOwnsLifecycle &&
			!committedLifecycle.isTransferred &&
			!committedLifecycle.isSettled
		) {
			committedLifecycle.settle("abandoned");
		}
	}
}

/**
 * Floor for `Retry-After` when no recovery time is known (cooldown cleared and
 * usage reset unknown). Tuned to the UsageCache TTL (10 minutes — see
 * providers/src/usage-fetcher.ts:1065) so a client that respects this header
 * is guaranteed to see fresh usage telemetry on retry. Pre-fix this was the
 * optimistic 60s that triggered CLAUDE_CODE_MAX_RETRIES=5 clients to die in
 * 300s during an approximately two-hour outage (production trace).
 */
export const POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS = 600;

/** Compatibility alias for the shared routing recovery retry-advice ceiling. */
export { ROUTING_RECOVERY_MAX_RETRY_AFTER_SECONDS as POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS } from "./routing-recovery-advice";

/**
 * Top-level error.type values produced by createPoolExhaustedResponse.
 *
 * `pool_exhausted` means "every account is genuinely exhausted (rate-limited,
 * usage-capped, paused, requires reauth, or otherwise filtered out)".
 * `circuit_open` means "the circuit breaker is refusing this account". The
 * wire shape stays identical — only `error.type` and `accounts[].reason`
 * differ — so SDK clients keep treating the response as a 503 transient.
 * Downstream consumers that need to differentiate (e.g. the AO fleet reaper)
 * read the JSON body.
 */
export type PoolExhaustionKind = "pool_exhausted" | "circuit_open";

/**
 * Per-account reason values emitted in `accounts[].reason`.
 *
 * `circuit_open` is distinct from the other values: it means the breaker
 * refused this account, NOT that the account's cooldown is expired. Reporting
 * a circuit-open account as `rate_limited` would mislead the reaper into
 * pausing session spawns for the wrong reason.
 */
export type PoolExhaustionAccountReason =
	| "requires_reauth"
	| "paused"
	| "usage_exhausted"
	| "rate_limited"
	| "circuit_open"
	| "unavailable";

/**
 * Default Retry-After (seconds) for the `circuit_open` response. Matches the
 * breaker's `OPEN_COOLDOWN_MS` so a polite client that respects Retry-After
 * will retry exactly when the breaker is most likely to admit a half-open
 * probe. Only used as a floor when no usage/cooldown recovery time is known
 * or is sooner than this — see `retryAfterSeconds` below.
 */
const CIRCUIT_OPEN_RETRY_AFTER_SECONDS = 30;

/**
 * Create a 503 Service Unavailable response when the account pool is exhausted.
 * All accounts are paused, rate-limited, usage-exhausted, circuit-open, or
 * filtered out.
 *
 * Usage-aware: `usageSnapshots` (keyed by account.id) lets the function surface
 * a `usage_exhausted` reason for accounts with no `rate_limited_until` cooldown
 * — otherwise those would fall through to the `unavailable` bucket and the
 * client would receive an optimistic `Retry-After: 60`, never reaching the
 * upstream reset. The caller is responsible for sourcing snapshots from
 * `usageCache` (or its own snapshot provider); the function itself stays pure
 * and testable without touching I/O.
 *
 * `kind: "circuit_open"` overrides every per-account reason to `circuit_open`
 * — the account's own state (paused, rate-limited, usage-exhausted) is
 * irrelevant when the breaker itself is the gate refusing the request. The
 * Retry-After is still the longer of the breaker's cooldown and any known
 * usage/rate-limit recovery time: a 30s breaker hint on an account that is
 * also usage-capped for hours would otherwise lie to the client about when
 * capacity actually returns.
 *
 * @param accounts - All accounts that were considered but are unavailable
 * @param usageSnapshots - Per-account usage telemetry (id → snapshot), used
 *   to identify usage_exhausted accounts and to derive `next_available_at` /
 *   `Retry-After` when an upstream reset time is known.
 * @param kind - Which top-level cause to report. Defaults to `"pool_exhausted"`.
 * @returns 503 response with the pool-exhausted JSON shape and Retry-After header
 */
export function createPoolExhaustedResponse(
	accounts: Account[],
	usageSnapshots?: ReadonlyMap<string, AccountUsageSnapshot>,
	kind: PoolExhaustionKind = "pool_exhausted",
): Response {
	const now = Date.now();
	const isCircuitOpen = kind === "circuit_open";

	// Build account info list — usage-exhausted outranks cooldown because the
	// client needs the longer reset horizon (weekly vs minutes-long cooldowns)
	// to avoid retrying an account upstream will reject immediately.
	// `circuit_open` outranks everything else: the breaker was the gate, so
	// the account's own state is irrelevant to why this request was refused.
	const accountInfos = accounts.map((account) => {
		const usage = usageSnapshots?.get(account.id);
		const usageExhausted =
			usage !== undefined &&
			isUsageExhausted(usage.utilization, usage.resetMs, now);

		const reason: PoolExhaustionAccountReason = isCircuitOpen
			? "circuit_open"
			: account.requires_reauth
				? "requires_reauth"
				: account.paused
					? "paused"
					: usageExhausted
						? "usage_exhausted"
						: account.rate_limited_until && account.rate_limited_until > now
							? "rate_limited"
							: "unavailable";

		let availableAt: string | null = null;
		if (!isCircuitOpen) {
			if (usageExhausted && usage?.resetMs && usage.resetMs > now) {
				availableAt = new Date(usage.resetMs).toISOString();
			} else if (
				account.rate_limited_until &&
				account.rate_limited_until > now
			) {
				availableAt = new Date(account.rate_limited_until).toISOString();
			}
		}

		return {
			name: account.name,
			reason,
			available_at: availableAt,
		};
	});

	// next_available_at / Retry-After = earliest of (active cooldown) and
	// (future usage reset). Both signals have to be considered — a
	// usage-capped account with `rate_limited_until = null` would otherwise be
	// ignored and leak an optimistic Retry-After to the client. For
	// circuit_open, the breaker's own cooldown floors the wait — but if the
	// account is ALSO usage-capped or rate-limited past that, the longer,
	// more honest wait wins (a 30s breaker hint must never undercut an hours-long
	// usage cap).
	const recoveryCandidates: number[] = [];
	for (const account of accounts) {
		if (account.rate_limited_until && account.rate_limited_until > now) {
			recoveryCandidates.push(account.rate_limited_until);
		}
		const usage = usageSnapshots?.get(account.id);
		if (
			usage &&
			isUsageExhausted(usage.utilization, usage.resetMs, now) &&
			usage.resetMs &&
			usage.resetMs > now
		) {
			recoveryCandidates.push(usage.resetMs);
		}
	}
	const earliestRecoveryMs =
		recoveryCandidates.length > 0 ? Math.min(...recoveryCandidates) : null;

	const nextAvailableAt =
		!isCircuitOpen && earliestRecoveryMs !== null
			? new Date(earliestRecoveryMs).toISOString()
			: null;

	// Retry-After: clamped to [1, MAX], with a defensible floor when no
	// recovery time is known. Mirrors model-capacity.ts's clamp semantics; the
	// floor (600s = UsageCache TTL) ensures a client retry can observe fresh
	// telemetry rather than retrying blindly against a stale snapshot.
	const usageAwareRetryAfterSeconds =
		earliestRecoveryMs !== null
			? clampFiniteRoutingRecoveryRetryAfterSeconds(earliestRecoveryMs, now)
			: POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS;

	// For circuit_open, take the longer of the breaker's own cooldown and any
	// KNOWN usage/rate-limit recovery — "the longer, more honest wait wins".
	// The 600s POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS floor is a
	// pool_exhausted-specific fallback for "no telemetry at all"; it must not
	// leak into circuit_open's own 30s floor when no other recovery signal
	// is known (earliestRecoveryMs === null).
	const retryAfterSeconds = isCircuitOpen
		? earliestRecoveryMs !== null
			? Math.max(CIRCUIT_OPEN_RETRY_AFTER_SECONDS, usageAwareRetryAfterSeconds)
			: CIRCUIT_OPEN_RETRY_AFTER_SECONDS
		: usageAwareRetryAfterSeconds;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: kind,
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
				// Wire shape stays identical regardless of kind — the cause lives
				// in `error.type`. Downstream consumers that need to differentiate
				// (fleet reaper, capacity-state consumers) read the JSON body.
				[RECOVERY_STATUS_HEADER]: RECOVERY_STATUS_EXHAUSTED,
				[RECOVERY_SCOPE_HEADER]: "pool",
			},
		},
	);
}
