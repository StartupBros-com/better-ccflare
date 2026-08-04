import { isServerToolWebSearchEnabled } from "@better-ccflare/config";
import {
	formatXaiCacheCanary,
	getModelFamily,
	requestEvents,
	ServiceUnavailableError,
	trackClientVersion,
} from "@better-ccflare/core";
import { DatabaseFactory } from "@better-ccflare/database";
import { sanitizeRequestHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	canonicalizeBetaSignature,
	deriveCacheFlightRecorderId,
	deriveXaiConversationIdentity,
	estimateAnthropicAdmissionTokens,
	isCacheFlightRecorderEnabled,
	isXaiCacheNativeEnabled,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	type AnthropicDegradedCohortFacts,
	type AnthropicDegradedRouteInspection,
	classifyAnthropicReplayRisk,
	sanitizeAnthropicRetryAfterSeconds,
} from "./anthropic-degraded-mode";
import type { DegradedModeRequestTracker } from "./anthropic-degraded-observability";
import { trackDegradedResponseTerminal } from "./anthropic-degraded-runtime";
import {
	type AnthropicPreCommitRescueRouteContext,
	coordinateAnthropicPreCommitRescue,
	createAnthropicPreCommitRescueActivation,
	createAnthropicPreCommitRescueRouteContext,
	getAnthropicPreCommitRescueConfig,
	isPotentialDownstreamAnthropicMessagesRequest,
} from "./anthropic-precommit-rescue";
import { cacheBodyStore } from "./cache-body-store";
import { recordDiagnosisCandidate } from "./cache-diagnosis";
import {
	type CachePacingObservation,
	derivePacingCohortKey,
	finishPacing,
	isCodexPacingBypassCandidate,
	observeCachePacing,
	recordCachePacingRoute,
} from "./cache-pacing";
import { warnOnLookbackRisk } from "./cache-telemetry";
import { CACHE_REPLAY_MODEL_HEADER } from "./cache-transport-staging";
import { adaptAnthropicSsePingsForClaudeCode } from "./claude-code-ping-compat";
import { isClaudeCodeSubagent } from "./claude-code-request";
import {
	type AgentInterceptResult,
	createContextAdmissionTracker,
	createContextLengthExceededResponse,
	createModelPoolExhaustedResponse,
	createRequestMetadata,
	createRoutingTerminalResponse,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	ForceRouteUnavailableError,
	filterRequestCompatibleAccounts,
	formatRoutingAttemptMessage,
	getComboSlotInfo,
	getRoutingCapacityContext,
	getUsageThrottleUntil,
	interceptAndModifyRequest,
	isInternalProbe,
	isRefreshTokenLikelyExpired,
	type ModelFallbackExecutionPolicy,
	mergeTerminalAccountState,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	RequestBodyContext,
	type RequestJsonBody,
	RoutingAttemptLedger,
	resolveEffectiveModel,
	selectAccountsForRequest,
	validateProviderPath,
} from "./handlers";
import {
	getCapacityDeferredModelRoutes,
	getClientVisibleServerToolAccountId,
	getReactiveModelCapacityBlocker,
} from "./handlers/account-selector";
import {
	type AnthropicDegradedRequestSendState,
	type AnthropicDegradedSendDenied,
	createAnthropicDegradedNoAccountDenial,
	discardUpstreamBody,
	isAnthropicDegradedSendDenied,
	type ProxyWithAccountResult,
} from "./handlers/proxy-operations";
import {
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	wouldSuppressProbe,
} from "./handlers/rate-limit-cooldown";
import { getRequestRateLimitOutcomes } from "./handlers/rate-limit-scope";
import { createProtectedAnthropicOverloadResponse } from "./handlers/routing-terminal";
import { consumeInternalAutoRefreshAuth } from "./internal-probe-auth";
import {
	MODEL_ROUTE_PROFILE_MODEL_PREFIX,
	type ModelRouteProfile,
} from "./model-route-profiles";
import { opaqueRuntimeId } from "./opaque-runtime-id";
import {
	getPreTransportDeadlineConfig,
	PreTransportPhaseTimeoutError,
	runWithPreTransportDeadline,
} from "./pre-transport-deadline";
import { extractProjectAttributionFromRequest } from "./project-attribution";
import {
	getRequestLifecycleCoordinator,
	recordRoutingTerminalRequest,
} from "./routing-terminal-recorder";
import {
	createServerToolRoutingErrorResponse,
	ServerToolCandidateCapabilityError,
	ServerToolRoutingError,
} from "./server-tool-routing-errors";
import {
	clearSession,
	sessionIdForObservation,
} from "./session-account-observer";
import {
	buildSessionRejectResponse,
	recordSessionRequest,
} from "./session-governor";
import {
	initUsageCollector,
	tryGetUsageCollector,
	type UsageCollectorHealth,
} from "./usage-collector";

export type { ProxyContext } from "./handlers";

function modelRouteUnavailableResponse(
	model: string,
	reason:
		| "unknown_profile"
		| "unbound_child_profile"
		| "conflicting_child_profile" = "unknown_profile",
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "model_route_unavailable",
				message: `Model route ${model} is unavailable`,
				reason,
			},
		}),
		{
			status: 503,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-model-route": "unavailable",
			},
		},
	);
}

function forceRouteUnavailableResponse(
	error: ForceRouteUnavailableError,
	revealAccountId: boolean,
): Response {
	return new Response(
		JSON.stringify({
			error: {
				type: "force_route_unavailable",
				message: error.message,
				...(revealAccountId ? { account_id: error.accountId } : {}),
				reason: error.reason,
			},
		}),
		{
			status: 503,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-force-route": "unavailable",
			},
		},
	);
}

function routeCallerIdentity(
	req: Request,
	apiKeyId?: string | null,
): string | null {
	if (apiKeyId?.trim()) return `api-key-id:${apiKeyId.trim()}`;
	const credential =
		req.headers.get("authorization") ?? req.headers.get("x-api-key");
	if (credential?.trim()) {
		return opaqueRuntimeId("model-route-caller", credential.trim());
	}
	return null;
}

function isModelRouteIntentRequest(req: Request, url: URL): boolean {
	return (
		req.method === "POST" &&
		(url.pathname === "/v1/messages" ||
			url.pathname === "/v1/messages/count_tokens")
	);
}

function applyExplicitModelRoute(
	bodyContext: RequestBodyContext,
	profile: ModelRouteProfile,
): void {
	bodyContext.setModel(profile.logicalModel);
	if (!profile.defaultEffort) return;
	bodyContext.mutateParsedJson((body) => {
		const outputConfig =
			typeof body.output_config === "object" && body.output_config !== null
				? (body.output_config as Record<string, unknown>)
				: null;
		const reasoning =
			typeof body.reasoning === "object" && body.reasoning !== null
				? (body.reasoning as Record<string, unknown>)
				: null;
		if (
			(outputConfig && "effort" in outputConfig) ||
			(reasoning && "effort" in reasoning)
		) {
			return;
		}
		if (body.output_config !== undefined && outputConfig === null) return;
		body.output_config = {
			...(outputConfig ?? {}),
			effort: profile.defaultEffort,
		};
	});
}

interface ReactiveModelDepletionOptions {
	accountId: string;
	model: string | null;
	betaSignature: string | null;
	syntheticProbe: boolean;
	now?: number;
}

function getReactiveModelRecoveryAt(
	opts: ReactiveModelDepletionOptions,
): number | null {
	if (opts.syntheticProbe || !opts.model) return null;
	return (
		getReactiveModelCapacityBlocker(
			opts.accountId,
			opts.model,
			canonicalizeBetaSignature(opts.betaSignature),
			opts.now ?? Date.now(),
		)?.evidenceExpiresAt ?? null
	);
}

export function isReactivelyModelDepleted(
	opts: ReactiveModelDepletionOptions,
): boolean {
	return getReactiveModelRecoveryAt(opts) !== null;
}

/**
 * Reconcile an account-only filtered/reordered route list to its immutable
 * routing-candidate sidecar. Matching is occurrence-safe: repeated combo slots
 * backed by one account consume distinct candidate IDs in their source order.
 */
export function alignRouteCandidateIds(
	accounts: readonly Account[],
	candidates:
		| readonly { readonly accountId: string; readonly candidateId: string }[]
		| null
		| undefined,
): string[] {
	const usedCandidateIndexes = new Set<number>();
	return accounts.map((account, accountIndex) => {
		const indexedCandidate = candidates?.[accountIndex];
		if (
			indexedCandidate?.accountId === account.id &&
			!usedCandidateIndexes.has(accountIndex)
		) {
			usedCandidateIndexes.add(accountIndex);
			return indexedCandidate.candidateId;
		}

		const matchedIndex =
			candidates?.findIndex(
				(candidate, candidateIndex) =>
					candidate.accountId === account.id &&
					!usedCandidateIndexes.has(candidateIndex),
			) ?? -1;
		if (matchedIndex >= 0 && candidates) {
			usedCandidateIndexes.add(matchedIndex);
			return candidates[matchedIndex].candidateId;
		}
		return `account:${account.id}`;
	});
}

const log = new Logger("Proxy");
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

function physicalAnthropicOAuthBetaSignature(headers: Headers): string {
	const features = new Set(
		(headers.get("anthropic-beta") ?? "")
			.split(",")
			.map((feature) => feature.trim())
			.filter(Boolean),
	);
	features.add(ANTHROPIC_OAUTH_BETA);
	return [...features].join(",");
}

function derivePotentialAnthropicOAuthCohortFacts(input: {
	ctx: ProxyContext;
	url: URL;
	headers: Headers;
	body: RequestBodyContext;
}): AnthropicDegradedCohortFacts | null {
	if (
		input.ctx.provider.name !== "anthropic" ||
		input.url.pathname !== "/v1/messages"
	) {
		return null;
	}
	const model = input.body.getModel();
	if (!model) return null;
	let endpoint: string;
	try {
		endpoint = input.ctx.provider.buildUrl(
			input.url.pathname,
			input.url.search,
		);
	} catch {
		return null;
	}
	return {
		provider: "anthropic",
		endpoint,
		path: input.url.pathname,
		protocol: "messages",
		model,
		betaSignature: physicalAnthropicOAuthBetaSignature(input.headers),
	};
}

interface DegradedTelemetryHolder {
	tracker: DegradedModeRequestTracker | null;
}

function degradedSizeBucket(input: {
	readonly kind: "small" | "large";
	readonly bodyBytes: number;
	readonly estimatedInputTokens: number | null;
	readonly tokenThreshold: number;
	readonly byteThreshold: number;
}): "small" | "near_threshold" | "large" {
	if (input.kind === "large") return "large";
	const nearTokens =
		input.estimatedInputTokens !== null &&
		input.estimatedInputTokens >= Math.floor(input.tokenThreshold * 0.8);
	const nearBytes = input.bodyBytes >= Math.floor(input.byteThreshold * 0.8);
	return nearTokens || nearBytes ? "near_threshold" : "small";
}

function isComboSessionFallbackDisabled(): boolean {
	const value = process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
	return /^(1|true|yes|on)$/i.test(value ?? "");
}

function createComboSessionFallbackDisabledResponse(
	comboName: string,
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "service_unavailable_error",
				message: "Service temporarily unavailable. Please try again later.",
				code: "combo_session_fallback_disabled",
				combo: comboName,
			},
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function createAnthropicDegradedDenialResponse(
	denial: AnthropicDegradedSendDenied,
): Response {
	return createProtectedAnthropicOverloadResponse({
		kind: "local_suppression",
		retryAfter: denial.decision.retryAfterSeconds,
	});
}

function getEmptyPoolAnthropicDegradedDenial(input: {
	inspection: AnthropicDegradedRouteInspection | null;
	requestKind: "small" | "large";
	config: ProxyContext["anthropicDegradedMode"]["config"];
	now?: number;
}): AnthropicDegradedSendDenied | null {
	if (
		input.config.mode !== "enforce" ||
		input.requestKind !== "large" ||
		input.inspection === null
	) {
		return null;
	}

	const now = input.now ?? Date.now();
	let retryAt: number;
	switch (input.inspection.detail.state) {
		case "open":
			retryAt = input.inspection.detail.nextProbeAt;
			break;
		case "probing":
			retryAt = Math.max(
				input.inspection.detail.nextProbeAt,
				input.inspection.detail.leaseExpiresAt,
			);
			break;
		case "recovering":
			retryAt = input.inspection.detail.recoveringUntil;
			break;
		default:
			return null;
	}

	return createAnthropicDegradedNoAccountDenial(
		sanitizeAnthropicRetryAfterSeconds(
			Math.max(0, retryAt - now) / 1_000,
			now,
			input.config,
		),
	);
}

// ===== USAGE COLLECTOR MANAGEMENT =====

export async function initProxy(
	getStorePayloads: () => boolean,
): Promise<void> {
	await initUsageCollector(
		getStorePayloads,
		(summary) => {
			requestEvents.emit("event", { type: "summary", payload: summary });
		},
		DatabaseFactory.getInstance(),
	);
}

export async function drainUsageCollector(): Promise<void> {
	return tryGetUsageCollector()?.drain() ?? Promise.resolve();
}

export function getUsageCollectorHealth(): UsageCollectorHealth {
	return tryGetUsageCollector()?.getHealth() ?? { state: "ready" };
}

// ===== MAIN HANDLER =====

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Validating the provider can handle the path
 * 3. Preparing the request body for reuse
 * 4. Selecting accounts based on load balancing strategy
 * 5. Attempting to proxy with each account in order
 * 6. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @param apiKeyId - Optional API key ID for tracking
 * @param apiKeyName - Optional API key name for tracking
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	// Reserve root intent synchronously, before body buffering or agent
	// interception can await and invert same-session request order. Discovery,
	// unrelated paths, children, credentialless callers, and zero-profile
	// registries remain allocation-free.
	const rootIntentGeneration =
		ctx.modelRouteSessionRegistry?.hasProfiles &&
		isModelRouteIntentRequest(req, url)
			? ctx.modelRouteSessionRegistry.beginRootIntent({
					callerIdentity: routeCallerIdentity(req, apiKeyId),
					sessionId: req.headers.get("x-claude-code-session-id"),
					isSubagent: isClaudeCodeSubagent(req.headers),
				})
			: null;
	const telemetry: DegradedTelemetryHolder = { tracker: null };
	const rescueRequestStartedAt = Date.now();
	try {
		let response: Response;
		if (!isPotentialDownstreamAnthropicMessagesRequest(req, url)) {
			response = await handleProxyCore(
				req,
				url,
				ctx,
				apiKeyId,
				apiKeyName,
				rootIntentGeneration,
				undefined,
				telemetry,
			);
		} else {
			const activation = createAnthropicPreCommitRescueActivation();
			const rescueConfig = getAnthropicPreCommitRescueConfig(req);
			const routingAbortController = new AbortController();
			const routingSignal = AbortSignal.any([
				req.signal,
				routingAbortController.signal,
			]);
			const routeContext = createAnthropicPreCommitRescueRouteContext({
				activate: activation.activate,
				signal: routingSignal,
				requestStartedAt: rescueRequestStartedAt,
				commitmentDeadlineMs: rescueConfig.commitmentDeadlineMs,
			});
			const routedResponse = handleProxyCore(
				req,
				url,
				ctx,
				apiKeyId,
				apiKeyName,
				rootIntentGeneration,
				routeContext,
				telemetry,
			);
			const coordinatedResponse = await coordinateAnthropicPreCommitRescue({
				response: routedResponse,
				activation: activation.promise,
				config: rescueConfig,
				requestStartedAt: rescueRequestStartedAt,
				commitmentDeadlineAt: routeContext.commitmentDeadlineAt,
				onRescueTerminal: routeContext.reportTerminal,
				onResponseAccepted: routeContext.releaseResponseLifecycle,
				abortRouting(reason) {
					if (!routingAbortController.signal.aborted) {
						routingAbortController.abort(reason);
					}
				},
			});
			response = adaptAnthropicSsePingsForClaudeCode(
				req,
				url,
				coordinatedResponse,
			);
		}
		return telemetry.tracker
			? trackDegradedResponseTerminal(response, telemetry.tracker)
			: response;
	} catch (error) {
		try {
			telemetry.tracker?.finish({
				outcome: req.signal.aborted
					? "cancelled"
					: error instanceof DOMException && error.name === "TimeoutError"
						? "timeout"
						: "failure",
			});
		} catch {
			// Telemetry never changes request failure authority.
		}
		throw error;
	}
}

async function handleProxyCore(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	rootIntentGeneration: number | null = null,
	anthropicPreCommitRescue?: AnthropicPreCommitRescueRouteContext,
	degradedTelemetry?: DegradedTelemetryHolder,
): Promise<Response> {
	// Consume the private scheduler credential before any request inspection,
	// metadata construction, logging, cache staging, or upstream forwarding.
	// Two internal-probe trust mechanisms currently coexist: our own
	// randomBytes(32)/timingSafeEqual credential (consumeInternalAutoRefreshAuth,
	// delete-before-compare above) and isInternalProbe's process-local
	// ctx.internalProbeSecret (a crypto.randomUUID() minted in server.ts),
	// which request-handler.ts/response-processor.ts/proxy-operations.ts already
	// rely on for the same schedulers' probe requests. Either one, backed by its
	// matching secret, is sufficient here — an unverified marker alone never is.
	const trustedInternalScheduler = consumeInternalAutoRefreshAuth(req.headers);
	const trustedInternalAutoRefresh =
		(trustedInternalScheduler &&
			req.headers.get("x-better-ccflare-auto-refresh") === "true") ||
		isInternalProbe(req.headers, ctx, "auto-refresh");
	const trustedInternalKeepalive =
		(trustedInternalScheduler &&
			req.headers.get("x-better-ccflare-keepalive") === "true") ||
		isInternalProbe(req.headers, ctx, "keepalive");
	// The public marker is meaningful only after internal authentication. Remove
	// spoofed markers so they cannot suppress pacing, analytics, or cache staging.
	if (!trustedInternalAutoRefresh) {
		req.headers.delete("x-better-ccflare-auto-refresh");
	}
	if (!trustedInternalKeepalive) {
		req.headers.delete("x-better-ccflare-keepalive");
		req.headers.delete(CACHE_REPLAY_MODEL_HEADER);
	}

	// 0. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// handleProxy is entered only after the server's authentication layer. When
	// profiles are configured, Claude Code gateway discovery is a local metadata
	// read: never validate a provider, query accounts, or forward this request.
	if (
		req.method === "GET" &&
		url.pathname === "/v1/models" &&
		ctx.modelRouteSessionRegistry?.hasProfiles
	) {
		return new Response(
			JSON.stringify({
				data: ctx.modelRouteSessionRegistry.getDiscoveryModels(),
				has_more: false,
			}),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			},
		);
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// Claude Code session id (sent since CLI v2.1.86) used to correlate this
	// chat with its serving account for the status-line badge. Read once here so
	// every no-account-served exit below can clear the association, degrading the
	// badge to unknown instead of showing the last healthy account (KTD-5). The
	// success path records the account in forwardToClient (KTD-1). Synthetic
	// internal traffic (cache-keepalive replays that carry the original session id,
	// auto-refresh probes) is excluded via the shared chokepoint so a failed
	// replay reaching a clear exit can't wipe the active session's real mapping.
	const sessionId = sessionIdForObservation(req.headers);

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);
	const requestBodyContext = new RequestBodyContext(requestBodyBuffer);
	const originalParsedBody = requestBodyContext.getParsedJson();
	// Scheduler auth has already been consumed above. Only an explicitly
	// streaming Anthropic Messages request may activate the outer SSE rescue;
	// non-streaming callers must retain their eventual JSON status/headers/body,
	// even when a provider takes longer than the rescue activation grace.
	const activeAnthropicPreCommitRescue =
		originalParsedBody?.stream === true ? anthropicPreCommitRescue : undefined;
	// Create the shared request identity before activating rescue so any outer
	// terminal can join the same one-shot lifecycle as forwardToClient and local
	// routing terminals, even if routing later rejects before producing a Response.
	const requestMeta = createRequestMetadata(
		req,
		url,
		ctx.guardCorrelationVerifier,
	);
	const createUnservedServerToolRoutingErrorResponse = (
		error: ServerToolRoutingError,
	): Response => {
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		const clientVisibleAccountId = getClientVisibleServerToolAccountId(
			requestMeta,
			error.accountId,
		);
		return createServerToolRoutingErrorResponse(
			clientVisibleAccountId === error.accountId
				? error
				: new ServerToolRoutingError({
						reason: error.reason,
						accountId: clientVisibleAccountId,
						capabilitySummary: error.capabilitySummary,
					}),
		);
	};
	requestMeta.trustedInternalAutoRefresh = trustedInternalAutoRefresh;
	const routingAttemptLedger = new RoutingAttemptLedger();
	activeAnthropicPreCommitRescue?.registerRequestLifecycle(
		getRequestLifecycleCoordinator(requestMeta),
	);
	activeAnthropicPreCommitRescue?.registerTerminalRecorder((terminalKind) => {
		void recordRoutingTerminalRequest({
			collector: tryGetUsageCollector(),
			requestMeta,
			requestHeaders: req.headers,
			response: new Response(null, {
				status: 200,
				headers: { "content-type": "text/event-stream; charset=utf-8" },
			}),
			providerName: ctx.provider.name,
			terminalKind,
			upstreamAttempts: routingAttemptLedger.attemptedCount,
			apiKeyId,
			apiKeyName,
			skip: trustedInternalAutoRefresh,
			onError: (error) => {
				log.error(
					`handleEnd failed for ${terminalKind} request ${requestMeta.id}`,
					error,
				);
			},
		});
	});
	// Arm the watchdog bridge as soon as a parsed streaming Messages request is
	// known. Account selection, pacing, credential acquisition, and the first
	// provider fetch can all stall before the lower transport hooks run.
	activeAnthropicPreCommitRescue?.activate();
	const routingSignal = activeAnthropicPreCommitRescue?.signal ?? req.signal;
	const preTransportDeadlines = getPreTransportDeadlineConfig();
	const contextAdmissionTracker =
		process.env.CCFLARE_CONTEXT_ADMISSION === "1" &&
		url.pathname === "/v1/messages" &&
		originalParsedBody &&
		originalParsedBody.max_tokens !== 0
			? createContextAdmissionTracker(
					estimateAnthropicAdmissionTokens(originalParsedBody),
					originalParsedBody.max_tokens,
					requestMeta.id,
				)
			: undefined;

	// 3b. Optionally inject 1h TTL into system prompt cache_control blocks
	if (ctx.config.getSystemPromptCacheTtl1h() && requestBodyBuffer) {
		injectSystemCacheTtl(requestBodyContext);
	}

	// Extract model from request body for family detection (used by combo routing)
	// and reuse parsed body for /v1/messages validation (consolidate parses)
	const parsedBody = requestBodyContext.getParsedJson();
	const requestModel = requestBodyContext.getModel();
	const normalizedRequestModel = requestModel?.trim() ?? null;
	const modelRouteRegistry = ctx.modelRouteSessionRegistry;
	const { project, projectAttributionSource } =
		extractProjectAttributionFromRequest(req.headers, parsedBody);

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		if (parsedBody) {
			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: parsedBody.event_type,
						event_name: (
							parsedBody.event_data as Record<string, unknown> | undefined
						)?.event_name,
					},
				);
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} else {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation");
		}
	}

	// 4. Intercept and modify request for agent model preferences
	let agentInterception: AgentInterceptResult;
	try {
		// Isolate the interceptor's mutable body context. If its dependencies settle
		// after our fail-open deadline, they cannot rewrite the request now routing.
		const interceptionBodyContext = new RequestBodyContext(
			requestBodyContext.getBuffer(),
		);
		agentInterception = await runWithPreTransportDeadline({
			phase: "agent_interception",
			timeoutMs: preTransportDeadlines.agentInterceptionTimeoutMs,
			signal: routingSignal,
			operation: () =>
				interceptAndModifyRequest(
					interceptionBodyContext,
					ctx.dbOps,
					req.headers,
					{
						frontmatterModelFallback:
							ctx.config.getAgentFrontmatterModelFallback(),
					},
				),
		});
	} catch (error) {
		if (!(error instanceof PreTransportPhaseTimeoutError)) throw error;
		const originalModel = requestBodyContext.getModel();
		agentInterception = {
			modifiedBody: requestBodyContext.getBuffer(),
			agentUsed: null,
			originalModel,
			appliedModel: originalModel,
			agentAttributionSource: "none" as const,
		};
	}
	const { modifiedBody, agentUsed, originalModel, agentAttributionSource } =
		agentInterception;
	let appliedModel = agentInterception.appliedModel;

	// Use modified body if available
	let finalBodyBuffer = modifiedBody || requestBodyContext.getBuffer();
	// proxyWithAccount prefers the parsed context over its raw buffer argument.
	// Keep that context aligned with the interceptor result while retaining the
	// original isolated context if the deadline failed open.
	const finalRequestBodyContext =
		finalBodyBuffer === requestBodyContext.getBuffer()
			? requestBodyContext
			: new RequestBodyContext(finalBodyBuffer);
	const effectiveModelAfterInterception =
		finalRequestBodyContext.getModel()?.trim() ?? null;
	const isSubagent = isClaudeCodeSubagent(req.headers);
	const originalReservedPicker =
		normalizedRequestModel?.startsWith(MODEL_ROUTE_PROFILE_MODEL_PREFIX) ===
		true;
	const configuredOriginalPicker =
		normalizedRequestModel !== null &&
		modelRouteRegistry?.hasPublicModelId(normalizedRequestModel) === true;
	const effectiveReservedPicker =
		effectiveModelAfterInterception?.startsWith(
			MODEL_ROUTE_PROFILE_MODEL_PREFIX,
		) === true;
	const configuredEffectivePicker =
		effectiveModelAfterInterception !== null &&
		modelRouteRegistry?.hasPublicModelId(effectiveModelAfterInterception) ===
			true;
	// A stale picker selected directly in /model is not a native clear. Children,
	// however, are classified entirely by their post-interception effective model.
	if (!isSubagent && originalReservedPicker && !configuredOriginalPicker) {
		return modelRouteUnavailableResponse(normalizedRequestModel ?? "unknown");
	}
	if (isSubagent && effectiveReservedPicker && !configuredEffectivePicker) {
		return modelRouteUnavailableResponse(
			effectiveModelAfterInterception ?? "unknown",
		);
	}
	const modelRouteRequestModel = isSubagent
		? effectiveModelAfterInterception
		: normalizedRequestModel;
	const modelRouteResolutionInput = {
		callerIdentity: routeCallerIdentity(req, apiKeyId),
		requestModel: modelRouteRequestModel,
		sessionId: req.headers.get("x-claude-code-session-id"),
		isSubagent,
	};
	const modelRouteResolution = modelRouteRegistry?.resolve(
		modelRouteResolutionInput,
		rootIntentGeneration,
	);
	// A native root remains native even if an agent preference injects a reserved
	// picker after /model selection. Resolve first so the authoritative native
	// intent clears the binding, then fail locally before the picker can escape.
	if (!isSubagent && !originalReservedPicker && effectiveReservedPicker) {
		return modelRouteUnavailableResponse(
			effectiveModelAfterInterception ?? "unknown",
		);
	}
	if (modelRouteResolution?.kind === "unavailable") {
		return modelRouteUnavailableResponse(
			modelRouteRequestModel ?? "unknown",
			modelRouteResolution.reason,
		);
	}
	if (modelRouteResolution?.kind === "route") {
		const { profile, source } = modelRouteResolution;
		requestMeta.forcedAccountId = profile.accountId;
		requestMeta.routeProfileId = profile.id;
		requestMeta.routeExpectedProvider = profile.expectedProvider;
		const inheritedPickerModel =
			source === "inherited" && configuredEffectivePicker;
		if (
			inheritedPickerModel &&
			effectiveModelAfterInterception !== profile.publicModelId
		) {
			return modelRouteUnavailableResponse(
				effectiveModelAfterInterception,
				"conflicting_child_profile",
			);
		}
		if (source === "explicit") {
			applyExplicitModelRoute(finalRequestBodyContext, profile);
			finalBodyBuffer = finalRequestBodyContext.getBuffer();
			appliedModel = profile.logicalModel;
			requestMeta.routeExpectedPhysicalModel = profile.expectedPhysicalModel;
		} else if (inheritedPickerModel) {
			finalRequestBodyContext.setModel(profile.logicalModel);
			finalBodyBuffer = finalRequestBodyContext.getBuffer();
			appliedModel = profile.logicalModel;
			requestMeta.routeExpectedPhysicalModel = profile.expectedPhysicalModel;
		}
	}
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};
	const serverToolRequirements = isServerToolWebSearchEnabled()
		? finalRequestBodyContext.finalizeServerToolRequirements()
		: undefined;
	if (serverToolRequirements) {
		requestMeta.serverToolRequirements = serverToolRequirements;
		// Selection needs only the semantic presence bit. Keep the raw query out of
		// routing metadata while allowing the provider materializer to derive the
		// same endpoint contract here and at pretransport binding.
		requestMeta.serverToolQueryPresent = url.search.length > 0;
		if (serverToolRequirements.invalid?.length) {
			return createUnservedServerToolRoutingErrorResponse(
				new ServerToolRoutingError({ reason: "invalid_requirement" }),
			);
		}
		if (serverToolRequirements.unsupported?.length) {
			return createUnservedServerToolRoutingErrorResponse(
				new ServerToolRoutingError({ reason: "unsupported_requirement" }),
			);
		}
	}
	const finalParsedBody = finalRequestBodyContext.getParsedJson();
	const potentialAnthropicCohortFacts =
		derivePotentialAnthropicOAuthCohortFacts({
			ctx,
			url,
			headers: req.headers,
			body: finalRequestBodyContext,
		});
	const anthropicDegradedMode = ctx.anthropicDegradedMode;
	const anthropicDegradedObservability = ctx.anthropicDegradedObservability;
	const degradedTelemetryActive =
		anthropicDegradedMode !== undefined &&
		(anthropicDegradedMode.config.mode !== "off" ||
			anthropicDegradedObservability?.detailsEnabled === true);
	// Classification can invoke a comparatively expensive token estimator.
	// Keep the entire degraded path inert unless the route is a native Anthropic
	// Messages candidate and either mode or explicit diagnostics is active.
	const anthropicReplayRisk =
		potentialAnthropicCohortFacts !== null &&
		anthropicDegradedMode !== undefined &&
		degradedTelemetryActive
			? classifyAnthropicReplayRisk({
					body: finalBodyBuffer
						? new Uint8Array(finalBodyBuffer)
						: new Uint8Array(0),
					estimateInputTokens: finalParsedBody
						? () => estimateAnthropicAdmissionTokens(finalParsedBody)
						: undefined,
					config: anthropicDegradedMode.config,
				})
			: null;
	let degradedTracker: DegradedModeRequestTracker | null = null;
	if (
		potentialAnthropicCohortFacts !== null &&
		anthropicReplayRisk !== null &&
		anthropicDegradedMode !== undefined &&
		anthropicDegradedObservability !== undefined
	) {
		try {
			degradedTracker = anthropicDegradedObservability.beginRequest({
				correlationKey: requestMeta.id,
				guardAttemptOrdinal: requestMeta.guardAttemptOrdinal,
				replayRisk: anthropicReplayRisk.kind,
				sizeBucket: degradedSizeBucket({
					...anthropicReplayRisk,
					tokenThreshold:
						anthropicDegradedMode.config.largeRequestTokenThreshold,
					byteThreshold: anthropicDegradedMode.config.largeRequestByteThreshold,
				}),
				estimatedInputTokens: anthropicReplayRisk.estimatedInputTokens,
				bodyBytes: anthropicReplayRisk.bodyBytes,
			});
			routingAttemptLedger.attachDegradedTracker(
				degradedTracker,
				requestMeta.guardAttemptOrdinal,
			);
			if (degradedTelemetry) degradedTelemetry.tracker = degradedTracker;
		} catch {
			// Aggregate/detail instrumentation is never routing authority.
		}
	}
	const anthropicDegradedInspection =
		potentialAnthropicCohortFacts !== null &&
		anthropicReplayRisk !== null &&
		anthropicDegradedMode !== undefined
			? anthropicDegradedMode.inspectRoute(potentialAnthropicCohortFacts)
			: null;
	const degradedOwnerSelection =
		anthropicDegradedInspection && anthropicReplayRisk
			? {
					inspection: anthropicDegradedInspection,
					requestKind: anthropicReplayRisk.kind,
					onDecision: (
						decision: NonNullable<RequestMeta["affinityOwnerDirective"]> | null,
					): void => {
						if (!degradedTracker || decision === null) return;
						try {
							degradedTracker.recordTransition({
								subject: "owner",
								from: "missing",
								to: decision.kind === "retain-owner" ? "retained" : "missing",
								reason:
									decision.kind === "retain-owner"
										? "owner_observed"
										: "unknown",
								cohortKey: anthropicDegradedInspection.cohortKey,
								ownerKey:
									decision.kind === "retain-owner"
										? decision.owner.accountId
										: null,
							});
						} catch {
							// Owner simulation is already complete.
						}
					},
				}
			: undefined;

	if (agentUsed && originalModel !== appliedModel) {
		log.info(
			`Agent ${agentUsed} detected, model changed from ${originalModel} to ${appliedModel}`,
		);
	}

	// 5. Complete request metadata with agent info
	requestMeta.agentUsed = agentUsed;
	requestMeta.agentAttributionSource = agentAttributionSource;
	requestMeta.project = project;
	requestMeta.projectAttributionSource = projectAttributionSource;
	requestMeta.clientSessionId = requestBodyContext.getClientId();
	const parsedConversationBody = requestBodyContext.getParsedJson() as Record<
		string,
		unknown
	> | null;
	if (parsedConversationBody && isCacheFlightRecorderEnabled()) {
		requestMeta.cacheFlightRecorderConversationId = deriveCacheFlightRecorderId(
			parsedConversationBody,
		);
	}
	if (parsedConversationBody && isXaiCacheNativeEnabled()) {
		const identity = deriveXaiConversationIdentity(parsedConversationBody);
		if (identity) {
			requestMeta.cacheAffinityKey = identity.affinityKey;
			requestMeta.xaiCacheNativeActive = true;
			requestMeta.xaiCacheIdentityFingerprint = identity.identityFingerprint;
			requestMeta.xaiCachePrefixFingerprint = identity.prefixFingerprint;
		}
	}
	// Model-rewrite provenance is serialized into a response header. Picker IDs
	// are matched after trimming, so keep only that header-bound value normalized.
	requestMeta.originalModel =
		normalizedRequestModel !== null &&
		modelRouteRegistry?.hasPublicModelId(normalizedRequestModel) === true
			? normalizedRequestModel
			: originalModel;
	requestMeta.appliedModel = appliedModel;

	// 5b. Session volume circuit breaker: a runaway subagent storm shows up as
	// one client session hammering /v1/messages. Count it here and, when
	// enforcement is enabled, reject before account selection burns upstream
	// quota. All identified traffic is counted: header-based exemptions would
	// be client-forgeable, and internal synthetic requests either carry no
	// client session (refresh probes, anonymous and thus ungoverned) or spend
	// upstream quota like any other request (keepalive replays) and belong in
	// the budget. This is a runaway-loop breaker, not an authentication
	// boundary: a client that omits session metadata entirely is out of scope.
	if (url.pathname === "/v1/messages") {
		const verdict = recordSessionRequest(requestMeta.clientSessionId);
		if (verdict?.rejected) {
			return buildSessionRejectResponse(verdict);
		}
	}

	// 5c. Cache pacing and the Codex-only bypass canary. Non-candidate controls
	// retain the original wait-before-selection ordering. Candidates select
	// early; after usage throttling, only a first usable Codex route bypasses.
	// A candidate resolving elsewhere is paced before any upstream call and
	// reselected afterward so Anthropic never receives stale or unpaced traffic.
	const pacingEligible =
		url.pathname === "/v1/messages" &&
		!trustedInternalKeepalive &&
		!trustedInternalAutoRefresh;
	const pacingCohortKey = pacingEligible
		? derivePacingCohortKey(requestMeta.clientSessionId, parsedBody)
		: null;
	const canaryCandidate = isCodexPacingBypassCandidate(pacingCohortKey);
	requestMeta.codexPacingCohortId = pacingCohortKey?.slice(0, 16) ?? null;
	const effectiveModel = resolveEffectiveModel(appliedModel, requestModel);
	const syntheticProbe = trustedInternalKeepalive;
	const selectAccountsWithDeadline = (
		options?: Parameters<typeof selectAccountsForRequest>[3],
	) =>
		runWithPreTransportDeadline({
			phase: "account_selection",
			timeoutMs: preTransportDeadlines.accountSelectionTimeoutMs,
			signal: routingSignal,
			operation: () =>
				selectAccountsForRequest(
					requestMeta,
					ctx,
					effectiveModel ?? undefined,
					{
						...options,
						syntheticProbe,
						degradedOwner: degradedOwnerSelection,
					},
				),
		});
	const getRouteCircuitRecoveryHint = () =>
		ctx.strategy.getRouteCircuitRecoveryHint?.(requestMeta) ?? null;
	const accountSelectionTimeoutResponse = (
		pacingSlot: Parameters<typeof finishPacing>[0],
	): Response => {
		cacheBodyStore.discardStaged(requestMeta.id);
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});
		// A phase timeout is transient incomplete evidence, so keep the canonical
		// route_unavailable body while explicitly inviting a bounded client retry.
		terminal.response.headers.set("retry-after", "1");
		return finishPacing(pacingSlot, terminal.response);
	};
	let pacingObservation: CachePacingObservation | null = null;
	let pacingBypassed = false;
	// Immutable assignment. Effective action may become crossover-paced, but
	// route cohort attribution must remain treatment, not control.
	const assignedCodexPacingBypass = canaryCandidate;
	let selectedAccounts: Account[] | null = null;

	if (!canaryCandidate && pacingEligible) {
		pacingObservation = await observeCachePacing({
			sessionKey: requestMeta.clientSessionId,
			model: effectiveModel,
		});
	}
	if (pacingEligible) {
		warnOnLookbackRisk(parsedBody, requestMeta.clientSessionId);
		recordDiagnosisCandidate(
			requestMeta.clientSessionId,
			finalBodyBuffer,
			req.headers,
		);
	}

	// 6. Controls select after pacing. Candidates select here so the bypass
	// decision can use the first actually available, usage-throttled account.
	try {
		selectedAccounts = await selectAccountsWithDeadline();
	} catch (error) {
		if (error instanceof PreTransportPhaseTimeoutError) {
			return accountSelectionTimeoutResponse(pacingObservation?.slot ?? null);
		}
		if (error instanceof ServerToolRoutingError) {
			return finishPacing(
				pacingObservation?.slot ?? null,
				createUnservedServerToolRoutingErrorResponse(error),
			);
		}
		if (error instanceof ForceRouteUnavailableError) {
			log.warn(
				`Grok cache canary ${formatXaiCacheCanary({
					requestId: requestMeta.id,
					accountId: error.accountId,
					officialEndpoint: true,
					keyPresent: false,
					identityFingerprint:
						requestMeta.xaiCacheIdentityFingerprint ?? undefined,
					prefixFingerprint: requestMeta.xaiCachePrefixFingerprint ?? undefined,
					cacheOutcome: "fail_closed",
					failClosedReason: error.reason,
				})}`,
			);
			return finishPacing(
				pacingObservation?.slot ?? null,
				forceRouteUnavailableResponse(
					error,
					requestMeta.routeProfileId == null,
				),
			);
		}
		if (serverToolRequirements) {
			return finishPacing(
				pacingObservation?.slot ?? null,
				createUnservedServerToolRoutingErrorResponse(
					new ServerToolRoutingError({
						reason: "temporary_unavailable",
						capabilitySummary: requestMeta.serverToolCapabilitySummary,
					}),
				),
			);
		}
		throw error;
	}
	let reactiveModelRecoveryAt: number | null = null;
	const hasReactiveModelDepletion = (
		opts: ReactiveModelDepletionOptions,
	): boolean => {
		const recoveryAt = getReactiveModelRecoveryAt(opts);
		if (recoveryAt === null) return false;
		reactiveModelRecoveryAt =
			reactiveModelRecoveryAt === null
				? recoveryAt
				: Math.min(reactiveModelRecoveryAt, recoveryAt);
		return true;
	};
	const getPredictiveThrottleUntil = (
		account: Account,
		model: string | null,
		now: number,
	): number | null => {
		const settings = {
			fiveHourEnabled: ctx.config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: ctx.config.getUsageThrottlingWeeklyEnabled(),
		};
		return settings.fiveHourEnabled || settings.weeklyEnabled
			? getUsageThrottleUntil(usageCache.get(account.id), settings, now, {
					requestModel: model,
					scopedMode: "match",
				})
			: null;
	};
	const applyUsageThrottling = (accounts: Account[]) => {
		// Internal synthetic probes (auto-refresh window-reset checks, cache
		// keepalive replays) must never be usage-throttled. They exist
		// specifically to hit the real endpoint and observe state changes
		// (window resets, recovered accounts) — the same reason
		// selectAccountsForRequest already lets them bypass pause/rate-limit
		// checks (see account-selector.ts's isAutoRefreshBypass). Without this
		// exemption, a throttled-but-healthy account's own synthetic probe gets
		// our own 529 back; the auto-refresh scheduler then misreads that as an
		// endpoint failure and counts it toward its consecutive-failure pause
		// threshold (recordRefreshFailure), auto-pausing a healthy account the
		// instant its usage window resets and the scheduler re-probes it.
		// trustedInternalAutoRefresh/trustedInternalKeepalive already fold in
		// both internal-probe trust mechanisms (see the comment where they're
		// computed above), so they're the single canonical trust signal here —
		// consistent with how they gate pacing, session tracking, and cache
		// staging elsewhere in this function.
		if (trustedInternalAutoRefresh || trustedInternalKeepalive) {
			return {
				available: accounts,
				predictivelyThrottled: [] as Account[],
				reactivelyDepletedAccounts: [] as Account[],
			};
		}

		const now = Date.now();
		const available: Account[] = [];
		const predictivelyThrottled: Account[] = [];
		const reactivelyDepletedAccounts: Account[] = [];

		// Model-aware throttling: a per-model weekly cap should only throttle
		// requests for that model. Use the effective (post-intercept) request
		// model; combo-routed requests assign per-slot models later, so skip
		// scoped caps (null) and rely on the flat windows + reactive out_of_credits.
		// combo routing sets meta.comboName during selection and CLEARS it on the
		// step-10 fallback; use it (not the stale comboSlotInfo WeakMap, which the
		// fallback does not clear) so fallback routing still applies per-model scoped
		// throttling for its now-known single model.
		const comboRouted = requestMeta.comboName != null;
		const effectiveModel = appliedModel ?? requestModel ?? null;

		for (const account of accounts) {
			const candidateModel = comboRouted ? null : effectiveModel;
			const throttleUntil = getPredictiveThrottleUntil(
				account,
				candidateModel,
				now,
			);
			const reactivelyDepleted =
				!comboRouted &&
				hasReactiveModelDepletion({
					accountId: account.id,
					model: candidateModel,
					betaSignature: req.headers.get("anthropic-beta"),
					syntheticProbe,
					now,
				});
			if (reactivelyDepleted) {
				reactivelyDepletedAccounts.push(account);
				continue;
			}
			if (throttleUntil && throttleUntil > now) {
				predictivelyThrottled.push(account);
				continue;
			}
			available.push(account);
		}

		if (predictivelyThrottled.length > 0) {
			log.info(
				`Predictively usage-throttled ${predictivelyThrottled.length} account(s): ${predictivelyThrottled.map((account) => account.name).join(", ")}`,
			);
		}
		if (reactivelyDepletedAccounts.length > 0) {
			log.info(
				`Reactively model-depleted ${reactivelyDepletedAccounts.length} account(s): ${reactivelyDepletedAccounts.map((account) => account.name).join(", ")}`,
			);
		}

		return {
			available,
			predictivelyThrottled,
			reactivelyDepletedAccounts,
		};
	};

	const returnComboSessionFallbackDisabled = async (
		comboName: string,
		failoverAttempts: number,
	): Promise<Response> => {
		const disabledFallbackResponse =
			createComboSessionFallbackDisabledResponse(comboName);
		const collector = tryGetUsageCollector();
		if (collector) {
			collector.handleStart({
				type: "start",
				messageId: crypto.randomUUID(),
				requestId: requestMeta.id,
				accountId: null,
				method: req.method,
				path: url.pathname,
				timestamp: requestMeta.timestamp,
				requestHeaders: Object.fromEntries(
					sanitizeRequestHeaders(req.headers).entries(),
				),
				requestBody: null,
				project: project ?? null,
				projectAttributionSource: projectAttributionSource ?? "none",
				agentAttributionSource: agentAttributionSource ?? "none",
				responseStatus: 503,
				responseHeaders: Object.fromEntries(
					disabledFallbackResponse.headers.entries(),
				),
				isStream: false,
				providerName: ctx.provider.name,
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: 0,
				accountName: null,
				agentUsed: agentUsed || null,
				originalModel: originalModel || null,
				appliedModel: appliedModel || null,
				comboName,
				// This 503 is generated locally when combo session fallback is
				// disabled: the request never reaches a combo slot or a serving
				// account (accountId is null above), so no slot-level model
				// rewrite happened and there is nothing to attribute. Same
				// reasoning as the locally generated terminal path in
				// routing-terminal-recorder.ts.
				comboModelOverrideFrom: null,
				comboModelOverrideTo: null,
				apiKeyId: apiKeyId || null,
				apiKeyName: apiKeyName || null,
				retryAttempt: 0,
				failoverAttempts,
			});
			try {
				await collector.handleEnd({
					type: "end",
					requestId: requestMeta.id,
					success: false,
					error: "combo_session_fallback_disabled",
				});
			} catch (err) {
				log.error(
					`handleEnd failed for combo fallback disabled request ${requestMeta.id}`,
					err,
				);
			}
		}
		cacheBodyStore.discardStaged(requestMeta.id);
		return disabledFallbackResponse;
	};

	let {
		available: accounts,
		predictivelyThrottled: throttledAccounts,
		reactivelyDepletedAccounts,
	} = applyUsageThrottling(selectedAccounts);

	if (canaryCandidate && accounts[0]?.provider === "codex") {
		pacingBypassed = true;
	} else if (canaryCandidate && pacingEligible) {
		// This candidate did not resolve to a usable Codex route. Pace before any
		// upstream call, then discard the pre-wait selection and route again so
		// Anthropic availability/cooldowns are fresh after the wait.
		pacingObservation = await observeCachePacing({
			sessionKey: requestMeta.clientSessionId,
			model: effectiveModel,
		});
		try {
			selectedAccounts = await selectAccountsWithDeadline();
		} catch (error) {
			if (error instanceof PreTransportPhaseTimeoutError) {
				return accountSelectionTimeoutResponse(pacingObservation?.slot ?? null);
			}
			if (error instanceof ServerToolRoutingError) {
				return finishPacing(
					pacingObservation?.slot ?? null,
					createUnservedServerToolRoutingErrorResponse(error),
				);
			}
			if (error instanceof ForceRouteUnavailableError) {
				log.warn(
					`Grok cache canary ${formatXaiCacheCanary({
						requestId: requestMeta.id,
						accountId: error.accountId,
						officialEndpoint: true,
						keyPresent: false,
						identityFingerprint:
							requestMeta.xaiCacheIdentityFingerprint ?? undefined,
						prefixFingerprint:
							requestMeta.xaiCachePrefixFingerprint ?? undefined,
						cacheOutcome: "fail_closed",
						failClosedReason: error.reason,
					})}`,
				);
				return finishPacing(
					pacingObservation?.slot ?? null,
					forceRouteUnavailableResponse(
						error,
						requestMeta.routeProfileId == null,
					),
				);
			}
			if (serverToolRequirements) {
				return finishPacing(
					pacingObservation?.slot ?? null,
					createUnservedServerToolRoutingErrorResponse(
						new ServerToolRoutingError({
							reason: "temporary_unavailable",
							capabilitySummary: requestMeta.serverToolCapabilitySummary,
						}),
					),
				);
			}
			throw error;
		}
		({
			available: accounts,
			predictivelyThrottled: throttledAccounts,
			reactivelyDepletedAccounts,
		} = applyUsageThrottling(selectedAccounts));
	}
	const selectedCapacityDeferredRoutes =
		getCapacityDeferredModelRoutes(requestMeta);
	let pacingSlot = pacingObservation?.slot ?? null;
	let crossoverPacingRestored = false;
	requestMeta.codexPacingCanary = pacingEligible
		? canaryCandidate
			? "bypass"
			: "control"
		: null;
	requestMeta.codexPacingAction = pacingEligible
		? pacingBypassed
			? "bypassed"
			: "paced"
		: null;
	const requestedForcedAccountId =
		requestMeta.forcedAccountId?.trim() ||
		req.headers.get("x-better-ccflare-account-id")?.trim() ||
		null;
	const successfullyForceRouted =
		requestedForcedAccountId !== null &&
		requestedForcedAccountId.length > 0 &&
		selectedAccounts.length === 1 &&
		selectedAccounts[0]?.id === requestedForcedAccountId;
	type LateBindableAnthropicDegradedSendState =
		AnthropicDegradedRequestSendState & {
			bindOwnerBeforeFirstProtectedSend(ownerAccountId: string): boolean;
		};
	const anthropicDegradedSendState:
		| LateBindableAnthropicDegradedSendState
		| undefined =
		anthropicReplayRisk && anthropicDegradedMode
			? (() => {
					let admission = anthropicDegradedMode.createRequestAdmission({
						cohortKey: anthropicDegradedInspection?.cohortKey ?? null,
						risk: anthropicReplayRisk,
						ownerAccountId:
							requestMeta.affinityOwnerDirective?.kind === "retain-owner"
								? requestMeta.affinityOwnerDirective.owner.accountId
								: null,
						forceRouted: successfullyForceRouted,
					});
					let ownerBound = Boolean(admission.input.ownerAccountId?.trim());
					return {
						get admission() {
							return admission;
						},
						lifecycle: null,
						tracker: degradedTracker,
						bindOwnerBeforeFirstProtectedSend(ownerAccountId: string): boolean {
							const normalizedOwnerAccountId = ownerAccountId.trim();
							if (
								anthropicDegradedMode.config.mode !== "enforce" ||
								ownerBound ||
								normalizedOwnerAccountId.length === 0 ||
								admission.hasClaimedProtectedSend
							) {
								return false;
							}
							admission = anthropicDegradedMode.createRequestAdmission({
								...admission.input,
								ownerAccountId: normalizedOwnerAccountId,
							});
							ownerBound = true;
							return true;
						},
					};
				})()
			: undefined;

	// 7. Handle no accounts case
	if (accounts.length === 0 && selectedCapacityDeferredRoutes.length === 0) {
		// No account will serve this request, whichever branch below fires. Clear
		// the badge association up front — BEFORE the fallible getAllAccounts fetch,
		// collector logging, and the passthrough (a thrown proxyUnauthenticated
		// never reaches forwardToClient's null-account clear) — so no failure or
		// throw below can leave a stale mapping (KTD-5).
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);

		if (requestMeta.comboName && isComboSessionFallbackDisabled()) {
			return await returnComboSessionFallbackDisabled(requestMeta.comboName, 0);
		}

		if (reactivelyDepletedAccounts.length > 0) {
			return finishPacing(
				pacingSlot,
				createModelPoolExhaustedResponse({
					capacityContext: getRoutingCapacityContext(requestMeta),
					rateLimitOutcomes: getRequestRateLimitOutcomes(req),
					now: Date.now(),
					modelRecoveryAt: reactiveModelRecoveryAt,
				}),
			);
		}

		if (throttledAccounts.length > 0) {
			return finishPacing(
				pacingSlot,
				createUsageThrottledResponse(throttledAccounts),
			);
		}

		// Check feature flag for backwards compatibility
		if (process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL === "1") {
			// An unauthenticated passthrough cannot supply independent account
			// evidence and must never claim the protected cohort's recovery lease.
			// Inspecting is deliberately non-mutating: protected large requests
			// receive the same typed overload denial used by authenticated sends,
			// while off-mode, closed, and small requests retain legacy passthrough.
			const degradedDenial = anthropicDegradedMode
				? getEmptyPoolAnthropicDegradedDenial({
						inspection: anthropicDegradedInspection,
						requestKind: anthropicReplayRisk?.kind ?? "small",
						config: anthropicDegradedMode.config,
					})
				: null;
			if (degradedDenial) {
				try {
					degradedTracker?.recordSuppression({
						decision: "suppressed",
						reason: "owner_missing",
						cohortKey: anthropicDegradedInspection?.cohortKey,
					});
					degradedTracker?.finish({ outcome: "suppressed" });
				} catch {
					// Local overload response remains authoritative.
				}
				return finishPacing(
					pacingSlot,
					createAnthropicDegradedDenialResponse(degradedDenial),
				);
			}
			log.warn(ERROR_MESSAGES.NO_ACCOUNTS);
			return finishPacing(
				pacingSlot,
				await proxyUnauthenticated(
					req,
					url,
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					ctx,
					apiKeyId,
					apiKeyName,
					activeAnthropicPreCommitRescue,
					routingAttemptLedger,
				),
			);
		}

		// Re-fetch request-compatible accounts because the strategy returns only
		// usable routes. A DB read failure is deliberately incomplete evidence and
		// therefore becomes route_unavailable rather than a retry-held pool marker.
		let allAccounts: Account[] = [];
		try {
			allAccounts = filterRequestCompatibleAccounts(
				await ctx.dbOps.getAllAccounts(),
				req.headers,
			);
		} catch (error) {
			log.error("Failed to load terminal account state", error);
		}
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: allAccounts,
			capacityContext: getRoutingCapacityContext(requestMeta),
			rateLimitOutcomes: getRequestRateLimitOutcomes(req),
			upstreamAttempts: 0,
			routeCircuitRecoveryHint: getRouteCircuitRecoveryHint(),
		});
		log.error(`Routing terminal: ${terminal.kind}`);

		// Skip request-log staging for synthetic auto-refresh probes that
		// 503 because their target account is on a known cooldown. Logging
		// these as user-facing 503s inflates the dashboard fail-rate without
		// reflecting any real client impact (issue #199, bug 2). The keepalive
		// scheduler already gets the equivalent treatment via its loop-prevention
		// header path; this brings auto-refresh in line.
		void recordRoutingTerminalRequest({
			collector: tryGetUsageCollector(),
			requestMeta,
			requestHeaders: req.headers,
			response: terminal.response,
			providerName: ctx.provider.name,
			terminalKind: terminal.kind,
			upstreamAttempts: 0,
			apiKeyId,
			apiKeyName,
			skip: trustedInternalAutoRefresh,
			onError: (error) => {
				log.error(
					`handleEnd failed for ${terminal.kind} request ${requestMeta.id}`,
					error,
				);
			},
		});

		// (Session badge already cleared at the top of this block.)
		return finishPacing(pacingSlot, terminal.response);
	}

	if (
		modelRouteResolution?.kind === "route" &&
		modelRouteResolution.source === "explicit" &&
		accounts.some(
			(account) => account.id === modelRouteResolution.profile.accountId,
		)
	) {
		modelRouteRegistry?.commitExplicit(
			modelRouteResolutionInput,
			modelRouteResolution,
		);
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	if (
		process.env.DEBUG?.includes("proxy") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// 9. Try each account
	const comboInfo = getComboSlotInfo(requestMeta);
	const allowedAccountIds = new Set(accounts.map((account) => account.id));
	const filteredComboInfo = comboInfo
		? {
				...comboInfo,
				slots: comboInfo.slots.filter((slot) =>
					allowedAccountIds.has(slot.accountId),
				),
			}
		: null;
	let response: ProxyWithAccountResult = null;
	let upstreamAttempts = 0;
	const serverToolCandidateCapabilityFailures: ServerToolCandidateCapabilityError[] =
		[];
	const locallyFailedServerToolCandidateIds = new Set<string>();
	// Every candidate probe-gate-suppressed and skipped via `continue` below
	// means the loop never actually attempted an account; the post-loop
	// fallback tier uses this to retry the top candidate once, ungated.
	let anyAccountAttempted = false;
	type DeferredModelRoute = {
		readonly account: Account;
		readonly model: string;
		readonly routeKey: string;
		readonly candidateId: string;
		readonly comboName: string | null;
		readonly comboSlotIndex: number | null;
		readonly normalStrategyManaged: boolean;
		readonly fallbackRank: number;
		readonly fallbackWave: number;
		readonly sequence: number;
	};
	const deferredModelRouteKeyFor = (account: Account, model: string): string =>
		JSON.stringify([account.id, model.trim().toLowerCase()]);
	const deferredModelRoutes: DeferredModelRoute[] = [];
	const deferredModelRouteKeys = new Set<string>();
	const deferredFallbackWaves = new Map<string, number>();
	const deferredFamilyOccurrences = new Map<string, number>();
	let preferredContextOverflowRouteKey: string | null = null;
	const deferModelRoute = (
		account: Account,
		model: string,
		candidateId: string,
		fallbackRank: number,
		comboName: string | null,
		comboSlotIndex: number | null,
		configuredFamilyOccurrence?: number | null,
	): void => {
		const key = deferredModelRouteKeyFor(account, model);
		if (deferredModelRouteKeys.has(key)) return;
		deferredModelRouteKeys.add(key);
		const targetFamily = getModelFamily(model);
		let waveKey: string;
		if (targetFamily) {
			const occurrenceKey = JSON.stringify([account.id, targetFamily]);
			const nextOccurrence = deferredFamilyOccurrences.get(occurrenceKey) ?? 0;
			const occurrence = configuredFamilyOccurrence ?? nextOccurrence;
			deferredFamilyOccurrences.set(
				occurrenceKey,
				Math.max(nextOccurrence, occurrence + 1),
			);
			waveKey = `family:${targetFamily}:occurrence:${occurrence}`;
		} else {
			waveKey = `fallback-rank:${fallbackRank}`;
		}
		let fallbackWave = deferredFallbackWaves.get(waveKey);
		if (fallbackWave === undefined) {
			fallbackWave = deferredFallbackWaves.size;
			deferredFallbackWaves.set(waveKey, fallbackWave);
		}
		deferredModelRoutes.push({
			account,
			model,
			routeKey: key,
			candidateId,
			comboName,
			comboSlotIndex,
			normalStrategyManaged: comboName === null,
			fallbackRank,
			fallbackWave,
			sequence: deferredModelRoutes.length,
		});
	};
	const selectedRouteCandidateIds = alignRouteCandidateIds(
		accounts,
		requestMeta.routingCandidates,
	);
	for (const route of selectedCapacityDeferredRoutes) {
		deferModelRoute(
			route.account,
			route.model,
			route.candidateId,
			route.fallbackRank,
			null,
			null,
			route.familyOccurrence,
		);
	}
	const modelFallbackPolicyFor = (
		account: Account,
		candidateId: string,
		forwardModelUnavailableResponse: boolean,
		currentlyFinalSemanticRoute: boolean,
		// Pre-override model (effectiveModel) when this attempt is a genuine
		// combo-slot override; null for the fallback loop and every other
		// caller (default), so the combo-vs-implicit-fallback distinction is
		// never inferred from modelOverride alone.
		comboModelOverrideFrom: string | null = null,
	): ModelFallbackExecutionPolicy => {
		const comboName = requestMeta.comboName ?? null;
		const comboSlotIndex = requestMeta.comboSlotIndex ?? null;
		return {
			routeCandidateId: candidateId,
			forwardModelUnavailableResponse,
			comboModelOverrideFrom,
			// proxyWithAccount combines this currently-known queue finality with its
			// account/model-specific implicit-fallback discovery state immediately
			// before each real fetch and semantic gate.
			isFinalSemanticAttempt: () =>
				currentlyFinalSemanticRoute && deferredModelRoutes.length === 0,
			canReplayContextOverflow: () =>
				!currentlyFinalSemanticRoute ||
				deferredModelRoutes.length > 0 ||
				(comboName !== null && !isComboSessionFallbackDisabled()),
			anthropicPreCommitRescue: activeAnthropicPreCommitRescue,
			deferImplicitFallback: (model, fallbackRank) => {
				deferModelRoute(
					account,
					model,
					candidateId,
					fallbackRank,
					comboName,
					comboSlotIndex,
				);
			},
			preferContextOverflowFallback: (model) => {
				const key = deferredModelRouteKeyFor(account, model);
				if (deferredModelRouteKeys.has(key)) {
					preferredContextOverflowRouteKey = key;
				}
			},
		};
	};
	const hasPreferredLegacyContextOverflowRoute = (): boolean =>
		preferredContextOverflowRouteKey !== null &&
		routingAttemptLedger.hasRetainedTerminalKind("legacy_context_overflow");
	const deliverRetainedTerminalResponse =
		async (): Promise<Response | null> => {
			const retainedTerminalResponse =
				routingAttemptLedger.takeTerminalResponse();
			if (!retainedTerminalResponse) return null;
			const terminalFailoverAttempts = Math.max(
				0,
				routingAttemptLedger.attemptedCount - 1,
			);
			return retainedTerminalResponse.deliver(terminalFailoverAttempts);
		};
	const settleRoutedResponse = async (
		candidateResponse: Response,
	): Promise<Response> => {
		if (candidateResponse.ok) {
			await routingAttemptLedger.discardTerminalResponse();
			return candidateResponse;
		}
		const retainedTerminalResponse = await deliverRetainedTerminalResponse();
		if (!retainedTerminalResponse) return candidateResponse;
		void candidateResponse.body
			?.cancel("superseded by retained upstream terminal")
			.catch(() => {
				// Best-effort release: the chosen retained response must not wait on
				// a failed fallback body's transport cleanup.
			});
		return retainedTerminalResponse;
	};
	const recordServerToolCandidateCapabilityFailure = (
		error: ServerToolCandidateCapabilityError,
		attemptedBefore: number,
	): Response | null => {
		serverToolCandidateCapabilityFailures.push(error);
		locallyFailedServerToolCandidateIds.add(error.candidateId);
		log.warn("server_tool_candidate_capability_drift", {
			requestId: requestMeta.id,
			accountId: error.accountId,
			candidateId: error.candidateId,
			reason: error.reason,
		});
		// A forced route whose exact proof failed before any transport has no
		// authorized sibling substitute. A capability failure discovered only
		// after a genuine upstream attempt remains subject to retained-terminal
		// precedence below.
		if (
			successfullyForceRouted &&
			error.accountId === requestedForcedAccountId &&
			routingAttemptLedger.attemptedCount === attemptedBefore
		) {
			cacheBodyStore.discardStaged(requestMeta.id);
			return createUnservedServerToolRoutingErrorResponse(
				new ServerToolRoutingError({
					reason: "forced_incapable",
					accountId: error.accountId,
					capabilitySummary: currentServerToolCapabilitySummary(),
				}),
			);
		}
		return null;
	};
	const currentServerToolSelectionWaveCandidateIds = (): ReadonlySet<string> =>
		new Set([
			...(requestMeta.routingCandidates ?? []).map(
				(candidate) => candidate.candidateId,
			),
			...getCapacityDeferredModelRoutes(requestMeta).map(
				(route) => route.candidateId,
			),
		]);
	const currentServerToolSelectionWaveFailedCandidateIds =
		(): ReadonlySet<string> => {
			const activeCandidateIds = currentServerToolSelectionWaveCandidateIds();
			return new Set(
				[...locallyFailedServerToolCandidateIds].filter((candidateId) =>
					activeCandidateIds.has(candidateId),
				),
			);
		};
	const currentServerToolCapabilitySummary = () => {
		const summary = requestMeta.serverToolCapabilitySummary;
		if (!summary) return undefined;
		const failedCandidateIds =
			currentServerToolSelectionWaveFailedCandidateIds();
		const invalidatedProvenCount = Math.min(
			summary.provenCandidateCount,
			failedCandidateIds.size,
		);
		const provenCandidateCount = Math.max(
			0,
			summary.provenCandidateCount - invalidatedProvenCount,
		);
		return Object.freeze({
			...summary,
			provenCandidateCount,
			unknownCandidateCount:
				summary.unknownCandidateCount + invalidatedProvenCount,
			temporarilyUnavailableProvenCandidateCount: Math.min(
				summary.temporarilyUnavailableProvenCandidateCount,
				Math.max(
					0,
					provenCandidateCount - summary.replayIneligibleCandidateCount,
				),
			),
			eligibleCandidateCount: Math.max(
				0,
				summary.eligibleCandidateCount - failedCandidateIds.size,
			),
		});
	};
	const hasExhaustedLocalServerToolCapabilityFailures = (): boolean => {
		if (
			serverToolCandidateCapabilityFailures.length === 0 ||
			routingAttemptLedger.attemptedCount !== 0
		) {
			return false;
		}
		const activeCandidateIds = currentServerToolSelectionWaveCandidateIds();
		return (
			activeCandidateIds.size > 0 &&
			[...activeCandidateIds].every((candidateId) =>
				locallyFailedServerToolCandidateIds.has(candidateId),
			)
		);
	};
	const deliverAnthropicDegradedDenial = async (
		denial: AnthropicDegradedSendDenied,
	): Promise<Response> => {
		try {
			degradedTracker?.finish({ outcome: "suppressed" });
		} catch {
			// The typed denial already owns the terminal response.
		}
		if (denial.retainedTrustedResponse) {
			return createProtectedAnthropicOverloadResponse({
				kind: "trusted_upstream",
				response: denial.retainedTrustedResponse,
				retryAfter: denial.decision.retryAfterSeconds,
			});
		}
		const retainedTerminalResponse = await deliverRetainedTerminalResponse();
		if (retainedTerminalResponse?.status === 529) {
			return createProtectedAnthropicOverloadResponse({
				kind: "trusted_upstream",
				response: retainedTerminalResponse,
				retryAfter:
					retainedTerminalResponse.headers.get("retry-after") ??
					denial.decision.retryAfterSeconds,
			});
		}
		if (retainedTerminalResponse) {
			await discardUpstreamBody(retainedTerminalResponse);
		}
		return createAnthropicDegradedDenialResponse(denial);
	};
	const deferredPredictivelyThrottledAccounts: Account[] = [];
	const reactiveDepletionSkips: Account[] = [];
	const deferredReactiveDepletionSkips: Account[] = [];
	const betaSignature = req.headers.get("anthropic-beta");

	for (let i = 0; i < accounts.length; i++) {
		// A Codex treatment may fail over to Anthropic. Before the first
		// non-Codex attempt, restore pacing so no crossover sends Anthropic
		// traffic unpaced. The route is still marked as a crossover, not treatment.
		if (
			pacingBypassed &&
			!crossoverPacingRestored &&
			accounts[i].provider !== "codex"
		) {
			pacingObservation = await observeCachePacing({
				sessionKey: requestMeta.clientSessionId,
				model: effectiveModel,
			});
			pacingSlot = pacingObservation?.slot ?? null;
			crossoverPacingRestored = true;
			pacingBypassed = false;
			requestMeta.codexPacingAction = "crossover-paced";
		}
		// For combo routing: enrich metadata with slot index and look up model override
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]) {
			const slot = filteredComboInfo.slots[i];
			if (slot.accountId !== accounts[i].id) {
				log.error(
					`Combo slot/account desync: slot ${i} expects account ${slot.accountId} but got ${accounts[i].id}`,
				);
			} else {
				modelOverride = slot.modelOverride;
			}
			requestMeta.comboSlotIndex = i;
			log.info(
				`Attempting combo slot ${i}/${accounts.length - 1} on account ${accounts[i].name} with model "${modelOverride}"`,
			);
		}

		const attemptModel = modelOverride ?? effectiveModel;
		// Normal routes were filtered above. Combo slots need this attempt-level
		// check because each slot may override the model independently.
		if (
			filteredComboInfo &&
			attemptModel &&
			hasReactiveModelDepletion({
				accountId: accounts[i].id,
				model: attemptModel,
				betaSignature,
				syntheticProbe,
			})
		) {
			reactiveDepletionSkips.push(accounts[i]);
			if (contextAdmissionTracker) {
				contextAdmissionTracker.nonCapacitySkipCount++;
			}
			log.info(
				`Skipping account ${accounts[i].name} for model ${attemptModel}: recent model-scoped out_of_credits`,
			);
			continue;
		}

		const probeAdmission = getRateLimitProbeAdmission(accounts[i]);
		if (probeAdmission === "suppressed") {
			if (contextAdmissionTracker) {
				contextAdmissionTracker.nonCapacitySkipCount++;
			}
			continue;
		}

		anyAccountAttempted = true;
		// The last actually-attempted candidate is not always the last pool
		// index: a probe-suppressed tail account gets skipped via `continue`
		// above rather than attempted. Look ahead at the remaining candidates'
		// CURRENT suppression state (without taking a lease) to find out
		// whether any of them would still be attempted after this one.
		const isLastAttemptedCandidate = accounts
			.slice(i + 1)
			.every((candidate) => wouldSuppressProbe(candidate));

		const attemptedBefore = routingAttemptLedger.attemptedCount;
		const candidateId =
			selectedRouteCandidateIds[i] ?? `account:${accounts[i].id}`;
		const isFinalSelectedCandidate =
			!filteredComboInfo?.comboName &&
			isLastAttemptedCandidate &&
			deferredModelRoutes.length === 0;
		const isFinalSelectedSemanticRoute =
			isLastAttemptedCandidate && deferredModelRoutes.length === 0;
		try {
			response = await proxyWithAccount(
				req,
				url,
				accounts[i],
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				upstreamAttempts,
				ctx,
				modelOverride,
				apiKeyId,
				apiKeyName,
				finalRequestBodyContext,
				isFinalSelectedCandidate,
				contextAdmissionTracker,
				routingAttemptLedger,
				modelFallbackPolicyFor(
					accounts[i],
					candidateId,
					isFinalSelectedCandidate,
					isFinalSelectedSemanticRoute,
					// Only a genuine combo slot carries a pre-override baseline;
					// the desync edge case above leaves modelOverride null so no
					// override is attributed there either.
					modelOverride ? effectiveModel : null,
				),
				anthropicDegradedSendState,
			);
		} catch (error) {
			if (error instanceof ServerToolCandidateCapabilityError) {
				upstreamAttempts +=
					routingAttemptLedger.attemptedCount - attemptedBefore;
				const forcedResponse = recordServerToolCandidateCapabilityFailure(
					error,
					attemptedBefore,
				);
				if (forcedResponse) {
					return finishPacing(pacingSlot, forcedResponse);
				}
				continue;
			}
			await routingAttemptLedger.discardTerminalResponse();
			throw error;
		} finally {
			if (probeAdmission === "admitted") {
				completeRateLimitProbe(accounts[i], "abandoned");
			}
		}
		upstreamAttempts += routingAttemptLedger.attemptedCount - attemptedBefore;

		if (isAnthropicDegradedSendDenied(response)) {
			try {
				degradedTracker?.finish({ outcome: "suppressed" });
			} catch {
				// The typed denial already owns the terminal response.
			}
			return finishPacing(
				pacingSlot,
				await deliverAnthropicDegradedDenial(response),
			);
		}
		if (response) {
			response = await settleRoutedResponse(response);
			recordCachePacingRoute(
				pacingObservation,
				{
					accountId: accounts[i].id,
					accountName: accounts[i].name,
					provider: accounts[i].provider,
				},
				{
					candidate: pacingEligible,
					assignedBypass: assignedCodexPacingBypass,
				},
			);
			return finishPacing(pacingSlot, response);
		}
		if (hasPreferredLegacyContextOverflowRoute()) {
			break;
		}

		// Log combo slot failure
		if (filteredComboInfo) {
			log.info(
				`Combo slot ${i} failed on account ${accounts[i].name}${i < accounts.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
			);
		}
	}

	// Every candidate was single-flight probe-gate suppressed — no account was
	// ever actually attempted. The gate's purpose is to prefer another account
	// over stampeding one that just recovered, not to drop the request when
	// there is no other account to prefer: retry the highest-priority
	// candidate once, bypassing the gate, instead of falling through to a hard
	// 503 against what may be a perfectly healthy account.
	if (!anyAccountAttempted && accounts.length > 0) {
		const i = 0;
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]?.accountId === accounts[i].id) {
			modelOverride = filteredComboInfo.slots[i].modelOverride;
		}
		log.info(
			`All ${accounts.length} candidate account(s) were probe-gate suppressed; retrying account ${accounts[i].name} ungated`,
		);
		// This retry is terminal only when no deferred route remains. The loop
		// above never actually attempted any selected candidate, but hard-capacity
		// planning may already have queued another account/model route. Threads
		// through the same routingAttemptLedger /
		// contextAdmissionTracker / modelFallbackPolicy wiring, and the same
		// pacing finalization, as the main loop above so this rare path can't
		// silently skip our fork's routing/pacing bookkeeping.
		const candidateId =
			selectedRouteCandidateIds[i] ?? `account:${accounts[i].id}`;
		const isFinalSelectedCandidate =
			!filteredComboInfo?.comboName && deferredModelRoutes.length === 0;
		const isFinalSelectedSemanticRoute = deferredModelRoutes.length === 0;
		const attemptedBefore = routingAttemptLedger.attemptedCount;
		try {
			response = await proxyWithAccount(
				req,
				url,
				accounts[i],
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				upstreamAttempts,
				ctx,
				modelOverride,
				apiKeyId,
				apiKeyName,
				finalRequestBodyContext,
				isFinalSelectedCandidate,
				contextAdmissionTracker,
				routingAttemptLedger,
				modelFallbackPolicyFor(
					accounts[i],
					candidateId,
					isFinalSelectedCandidate,
					isFinalSelectedSemanticRoute,
					// This ungated retry applies the combo slot's model override
					// exactly like the main loop does (modelOverride is computed
					// above and passed to proxyWithAccount), so it must attribute
					// the override too. Omitting this argument let it default to
					// null, which recorded a real slot-level rewrite as "no
					// override" and hid it from comboModelOverride attribution
					// and from the model-routing drift alert.
					modelOverride ? effectiveModel : null,
				),
				anthropicDegradedSendState,
			);
		} catch (error) {
			if (error instanceof ServerToolCandidateCapabilityError) {
				const forcedResponse = recordServerToolCandidateCapabilityFailure(
					error,
					attemptedBefore,
				);
				if (forcedResponse) {
					return finishPacing(pacingSlot, forcedResponse);
				}
				response = null;
			} else {
				await routingAttemptLedger.discardTerminalResponse();
				throw error;
			}
		}
		upstreamAttempts += routingAttemptLedger.attemptedCount - attemptedBefore;

		if (isAnthropicDegradedSendDenied(response)) {
			return finishPacing(
				pacingSlot,
				await deliverAnthropicDegradedDenial(response),
			);
		}
		if (response) {
			response = await settleRoutedResponse(response);
			recordCachePacingRoute(
				pacingObservation,
				{
					accountId: accounts[i].id,
					accountName: accounts[i].name,
					provider: accounts[i].provider,
				},
				{
					candidate: pacingEligible,
					assignedBypass: assignedCodexPacingBypass,
				},
			);
			return finishPacing(pacingSlot, response);
		}
	}

	// 10. Combo fallback: if combo routing was active and all slots failed,
	//     fall back to normal SessionStrategy routing (REQ-14)
	let fallbackAccounts: Account[] | null = null;
	let reactivelyDepletedFallbackAccounts: Account[] = [];
	let throttledFallbackAccounts: Account[] = [];
	let fallbackSelectionHadNoAvailable = false;
	if (
		filteredComboInfo?.comboName &&
		!hasPreferredLegacyContextOverflowRoute()
	) {
		if (isComboSessionFallbackDisabled()) {
			if (hasExhaustedLocalServerToolCapabilityFailures()) {
				cacheBodyStore.discardStaged(requestMeta.id);
				return finishPacing(
					pacingSlot,
					createUnservedServerToolRoutingErrorResponse(
						new ServerToolRoutingError({
							reason: "no_implementation",
							capabilitySummary: currentServerToolCapabilitySummary(),
						}),
					),
				);
			}
			log.warn(
				`All combo slots failed for combo "${filteredComboInfo.comboName}", session fallback disabled by CCFLARE_DISABLE_COMBO_SESSION_FALLBACK`,
			);
			return await returnComboSessionFallbackDisabled(
				filteredComboInfo.comboName,
				accounts.length,
			);
		}

		log.warn(
			`All combo slots failed for combo "${filteredComboInfo.comboName}", falling back to SessionStrategy routing`,
		);
		// Clear combo info and retry with normal routing
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
		let selectedFallbackAccounts: Account[];
		try {
			selectedFallbackAccounts = await selectAccountsWithDeadline({
				skipCombo: true,
			});
		} catch (error) {
			if (error instanceof PreTransportPhaseTimeoutError) {
				const retainedTerminalResponse =
					routingAttemptLedger.takeTerminalResponse();
				if (
					retainedTerminalResponse?.terminalKind ===
					"authoritative_context_overflow"
				) {
					const terminalFailoverAttempts = Math.max(
						0,
						routingAttemptLedger.attemptedCount - 1,
					);
					return finishPacing(
						pacingSlot,
						await retainedTerminalResponse.deliver(terminalFailoverAttempts),
					);
				}
				if (retainedTerminalResponse) {
					await retainedTerminalResponse.discard();
				}
				return accountSelectionTimeoutResponse(pacingSlot);
			}
			if (error instanceof ServerToolRoutingError) {
				const retainedTerminalResponse =
					await deliverRetainedTerminalResponse();
				if (retainedTerminalResponse) {
					return finishPacing(pacingSlot, retainedTerminalResponse);
				}
				return finishPacing(
					pacingSlot,
					createUnservedServerToolRoutingErrorResponse(error),
				);
			}
			if (serverToolRequirements) {
				const retainedTerminalResponse =
					await deliverRetainedTerminalResponse();
				if (retainedTerminalResponse) {
					return finishPacing(pacingSlot, retainedTerminalResponse);
				}
				return finishPacing(
					pacingSlot,
					createUnservedServerToolRoutingErrorResponse(
						new ServerToolRoutingError({
							reason: "temporary_unavailable",
							capabilitySummary: requestMeta.serverToolCapabilitySummary,
						}),
					),
				);
			}
			await routingAttemptLedger.discardTerminalResponse();
			throw error;
		}
		for (const route of getCapacityDeferredModelRoutes(requestMeta)) {
			deferModelRoute(
				route.account,
				route.model,
				route.candidateId,
				route.fallbackRank,
				null,
				null,
				route.familyOccurrence,
			);
		}
		// The explicit post-combo selection is the only strategy pass that runs
		// after request admission is created. A combo without a native Anthropic
		// OAuth candidate cannot materialize an affinity owner, but normal fallback
		// may discover a retained owner. Bind that owner before the first protected
		// fallback send; once a protected send is claimed, the admission (and its
		// permit fencing) remains immutable.
		if (requestMeta.affinityOwnerDirective?.kind === "retain-owner") {
			anthropicDegradedSendState?.bindOwnerBeforeFirstProtectedSend(
				requestMeta.affinityOwnerDirective.owner.accountId,
			);
		}
		const fallbackSelection = applyUsageThrottling(selectedFallbackAccounts);
		const filteredFallbackAccounts = fallbackSelection.available;
		throttledFallbackAccounts = fallbackSelection.predictivelyThrottled;
		reactivelyDepletedFallbackAccounts =
			fallbackSelection.reactivelyDepletedAccounts;
		fallbackAccounts = filteredFallbackAccounts;
		fallbackSelectionHadNoAvailable = fallbackAccounts.length === 0;
		if (fallbackAccounts.length === 0) {
			// The combo already reached a concrete upstream terminal and fallback
			// selection found no new unique route to attempt. Surface that upstream
			// response before synthesizing model-depleted or usage-throttled output.
			if (deferredModelRoutes.length === 0) {
				const retainedTerminalResponse =
					await deliverRetainedTerminalResponse();
				if (retainedTerminalResponse) {
					return finishPacing(pacingSlot, retainedTerminalResponse);
				}
			}
		}

		if (fallbackAccounts.length > 0) {
			const fallbackRouteCandidateIds = alignRouteCandidateIds(
				fallbackAccounts,
				requestMeta.routingCandidates,
			);
			log.info(
				`Fallback: trying ${fallbackAccounts.length} SessionStrategy accounts`,
			);
			let anyFallbackAttempted = false;
			for (let i = 0; i < fallbackAccounts.length; i++) {
				if (
					pacingBypassed &&
					!crossoverPacingRestored &&
					fallbackAccounts[i].provider !== "codex"
				) {
					pacingObservation = await observeCachePacing({
						sessionKey: requestMeta.clientSessionId,
						model: effectiveModel,
					});
					pacingSlot = pacingObservation?.slot ?? null;
					crossoverPacingRestored = true;
					pacingBypassed = false;
					requestMeta.codexPacingAction = "crossover-paced";
				}
				const probeAdmission = getRateLimitProbeAdmission(fallbackAccounts[i]);
				if (probeAdmission === "suppressed") {
					if (contextAdmissionTracker) {
						contextAdmissionTracker.nonCapacitySkipCount++;
					}
					continue;
				}

				anyFallbackAttempted = true;
				// Same rationale as the main loop above: a probe-suppressed tail
				// candidate is skipped via `continue`, so the last pool index is
				// not necessarily the last one actually attempted.
				const isLastAttemptedFallback = fallbackAccounts
					.slice(i + 1)
					.every((candidate) => wouldSuppressProbe(candidate));
				const attemptedBefore = routingAttemptLedger.attemptedCount;
				const candidateId =
					fallbackRouteCandidateIds[i] ?? `account:${fallbackAccounts[i].id}`;
				const isFinalFallbackCandidate =
					isLastAttemptedFallback && deferredModelRoutes.length === 0;
				try {
					response = await proxyWithAccount(
						req,
						url,
						fallbackAccounts[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						upstreamAttempts,
						ctx,
						undefined, // No model override for fallback path
						apiKeyId,
						apiKeyName,
						finalRequestBodyContext,
						isFinalFallbackCandidate,
						contextAdmissionTracker,
						routingAttemptLedger,
						modelFallbackPolicyFor(
							fallbackAccounts[i],
							candidateId,
							isFinalFallbackCandidate,
							isFinalFallbackCandidate,
						),
						anthropicDegradedSendState,
					);
				} catch (error) {
					if (error instanceof ServerToolCandidateCapabilityError) {
						upstreamAttempts +=
							routingAttemptLedger.attemptedCount - attemptedBefore;
						const forcedResponse = recordServerToolCandidateCapabilityFailure(
							error,
							attemptedBefore,
						);
						if (forcedResponse) {
							return finishPacing(pacingSlot, forcedResponse);
						}
						continue;
					}
					await routingAttemptLedger.discardTerminalResponse();
					throw error;
				} finally {
					if (probeAdmission === "admitted") {
						completeRateLimitProbe(fallbackAccounts[i], "abandoned");
					}
				}
				upstreamAttempts +=
					routingAttemptLedger.attemptedCount - attemptedBefore;

				if (isAnthropicDegradedSendDenied(response)) {
					return finishPacing(
						pacingSlot,
						await deliverAnthropicDegradedDenial(response),
					);
				}
				if (response) {
					response = await settleRoutedResponse(response);
					recordCachePacingRoute(
						pacingObservation,
						{
							accountId: fallbackAccounts[i].id,
							accountName: fallbackAccounts[i].name,
							provider: fallbackAccounts[i].provider,
						},
						{
							candidate: pacingEligible,
							assignedBypass: assignedCodexPacingBypass,
						},
					);
					return finishPacing(pacingSlot, response);
				}
				if (hasPreferredLegacyContextOverflowRoute()) {
					break;
				}
			}

			// Every candidate was single-flight probe-gate suppressed — no account
			// was ever actually attempted. Same rationale as the main loop above:
			// retry the highest-priority fallback candidate once, bypassing the
			// gate, instead of falling through to a hard failure.
			if (!anyFallbackAttempted && fallbackAccounts.length > 0) {
				const i = 0;
				log.info(
					`All ${fallbackAccounts.length} fallback candidate(s) were probe-gate suppressed; retrying account ${fallbackAccounts[i].name} ungated`,
				);
				// This retry is the terminal attempt by construction (the fallback
				// loop already exhausted every candidate), and the fallback path is
				// never combo-routed (comboName was cleared before re-selection), so
				// isFinalFallbackCandidate only needs to account for deferred routes.
				const candidateId =
					fallbackRouteCandidateIds[i] ?? `account:${fallbackAccounts[i].id}`;
				const isFinalFallbackCandidate = deferredModelRoutes.length === 0;
				const attemptedBefore = routingAttemptLedger.attemptedCount;
				try {
					response = await proxyWithAccount(
						req,
						url,
						fallbackAccounts[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						upstreamAttempts,
						ctx,
						undefined,
						apiKeyId,
						apiKeyName,
						finalRequestBodyContext,
						isFinalFallbackCandidate,
						contextAdmissionTracker,
						routingAttemptLedger,
						modelFallbackPolicyFor(
							fallbackAccounts[i],
							candidateId,
							isFinalFallbackCandidate,
							true,
						),
						anthropicDegradedSendState,
					);
				} catch (error) {
					if (error instanceof ServerToolCandidateCapabilityError) {
						const forcedResponse = recordServerToolCandidateCapabilityFailure(
							error,
							attemptedBefore,
						);
						if (forcedResponse) {
							return finishPacing(pacingSlot, forcedResponse);
						}
						response = null;
					} else {
						await routingAttemptLedger.discardTerminalResponse();
						throw error;
					}
				}
				upstreamAttempts +=
					routingAttemptLedger.attemptedCount - attemptedBefore;

				if (isAnthropicDegradedSendDenied(response)) {
					return finishPacing(
						pacingSlot,
						await deliverAnthropicDegradedDenial(response),
					);
				}
				if (response) {
					response = await settleRoutedResponse(response);
					recordCachePacingRoute(
						pacingObservation,
						{
							accountId: fallbackAccounts[i].id,
							accountName: fallbackAccounts[i].name,
							provider: fallbackAccounts[i].provider,
						},
						{
							candidate: pacingEligible,
							assignedBypass: assignedCodexPacingBypass,
						},
					);
					return finishPacing(pacingSlot, response);
				}
			}
		} else if (
			deferredModelRoutes.length === 0 &&
			!hasExhaustedLocalServerToolCapabilityFailures() &&
			reactivelyDepletedFallbackAccounts.length > 0
		) {
			cacheBodyStore.discardStaged(requestMeta.id);
			if (sessionId) clearSession(sessionId, requestMeta.timestamp);
			return finishPacing(
				pacingSlot,
				createModelPoolExhaustedResponse({
					capacityContext: getRoutingCapacityContext(requestMeta),
					rateLimitOutcomes: getRequestRateLimitOutcomes(req),
					now: Date.now(),
					modelRecoveryAt: reactiveModelRecoveryAt,
				}),
			);
		} else if (
			deferredModelRoutes.length === 0 &&
			!hasExhaustedLocalServerToolCapabilityFailures() &&
			throttledFallbackAccounts.length > 0
		) {
			cacheBodyStore.discardStaged(requestMeta.id);
			// Combo fallback throttled, no account served — badge unknown (KTD-5).
			if (sessionId) clearSession(sessionId, requestMeta.timestamp);
			return finishPacing(
				pacingSlot,
				createUsageThrottledResponse(throttledFallbackAccounts),
			);
		}
	}

	// Global model-first boundary: account-local mappings may describe a
	// degradation to another Claude family or an opaque provider model that
	// cannot be proven same-family. Those implicit routes execute only after
	// every explicit combo/normal candidate and known same-family sibling. Each
	// re-entry is constrained to exactly the queued model.
	if (deferredModelRoutes.length > 0) {
		// A normal deferred family can combine preblocked accounts (which never
		// reached strategy.select()) with dynamically deferred selected accounts.
		// Derive one side-effect-free strategy order by repeatedly peeking and
		// removing the winner. This avoids a second select() call, which could mutate
		// affinity, recency, sessions, or route-circuit leases. Explicit combo routes
		// remain sequence-ordered below.
		const strategyManagedAccountOrder = new Map<string, number>();
		const remainingStrategyManagedAccounts = [
			...new Map(
				deferredModelRoutes
					.filter((route) => route.normalStrategyManaged)
					.map((route) => [route.account.id, route.account]),
			).values(),
		];
		while (remainingStrategyManagedAccounts.length > 0) {
			const preferredAccountId = ctx.strategy.peek?.(
				remainingStrategyManagedAccounts,
			);
			if (!preferredAccountId) break;
			const preferredIndex = remainingStrategyManagedAccounts.findIndex(
				(account) => account.id === preferredAccountId,
			);
			if (preferredIndex < 0) break;
			strategyManagedAccountOrder.set(
				preferredAccountId,
				strategyManagedAccountOrder.size,
			);
			remainingStrategyManagedAccounts.splice(preferredIndex, 1);
		}
		for (const account of remainingStrategyManagedAccounts) {
			strategyManagedAccountOrder.set(
				account.id,
				strategyManagedAccountOrder.size,
			);
		}

		const requestedFamily = effectiveModel
			? getModelFamily(effectiveModel)
			: null;
		type DeferredFallbackGroup = {
			readonly requestedFamilyTier: number;
			readonly minimumFallbackRank: number;
			readonly firstSeen: number;
			readonly normalStrategyManagedOnly: boolean;
		};
		const deferredFallbackGroups = new Map<number, DeferredFallbackGroup>();
		for (const route of deferredModelRoutes) {
			const routeFamily = getModelFamily(route.model);
			const requestedFamilyTier =
				requestedFamily !== null && routeFamily === requestedFamily ? 0 : 1;
			const existing = deferredFallbackGroups.get(route.fallbackWave);
			deferredFallbackGroups.set(route.fallbackWave, {
				requestedFamilyTier: Math.min(
					existing?.requestedFamilyTier ?? requestedFamilyTier,
					requestedFamilyTier,
				),
				minimumFallbackRank: Math.min(
					existing?.minimumFallbackRank ?? route.fallbackRank,
					route.fallbackRank,
				),
				firstSeen: existing?.firstSeen ?? route.fallbackWave,
				normalStrategyManagedOnly:
					(existing?.normalStrategyManagedOnly ?? true) &&
					route.normalStrategyManaged,
			});
		}
		const orderedDeferredModelRoutes = hasPreferredLegacyContextOverflowRoute()
			? deferredModelRoutes.filter(
					(route) => route.routeKey === preferredContextOverflowRouteKey,
				)
			: [...deferredModelRoutes].sort((a, b) => {
					const aGroup = deferredFallbackGroups.get(a.fallbackWave);
					const bGroup = deferredFallbackGroups.get(b.fallbackWave);
					if (!aGroup || !bGroup) return a.sequence - b.sequence;
					const groupOrder =
						aGroup.requestedFamilyTier - bGroup.requestedFamilyTier ||
						aGroup.minimumFallbackRank - bGroup.minimumFallbackRank ||
						aGroup.firstSeen - bGroup.firstSeen;
					if (groupOrder !== 0) return groupOrder;
					if (aGroup.normalStrategyManagedOnly) {
						const accountOrder =
							(strategyManagedAccountOrder.get(a.account.id) ??
								Number.MAX_SAFE_INTEGER) -
							(strategyManagedAccountOrder.get(b.account.id) ??
								Number.MAX_SAFE_INTEGER);
						if (accountOrder !== 0) return accountOrder;
					}
					return a.sequence - b.sequence;
				});
		log.info(
			`Requested-family routes exhausted; trying ${orderedDeferredModelRoutes.length} deferred degradation route(s)`,
		);
		const attemptDeferredRoute = async (
			route: DeferredModelRoute,
			isFinalDeferredRoute: boolean,
			probeAdmission: ReturnType<typeof getRateLimitProbeAdmission> | null,
		): Promise<Response | null> => {
			requestMeta.comboName = route.comboName;
			requestMeta.comboSlotIndex = route.comboSlotIndex;
			log.info(
				`Attempting deferred route candidate=${route.candidateId} account=${route.account.name} model=${route.model}`,
			);
			const attemptedBefore = routingAttemptLedger.attemptedCount;
			try {
				response = await proxyWithAccount(
					req,
					url,
					route.account,
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					upstreamAttempts,
					ctx,
					route.model,
					apiKeyId,
					apiKeyName,
					finalRequestBodyContext,
					isFinalDeferredRoute,
					contextAdmissionTracker,
					routingAttemptLedger,
					{
						routeCandidateId: route.candidateId,
						recomputeServerToolCapability: true,
						implicitFallbacksEnabled: false,
						forwardModelUnavailableResponse: isFinalDeferredRoute,
						isFinalSemanticAttempt: () => isFinalDeferredRoute,
						anthropicPreCommitRescue: activeAnthropicPreCommitRescue,
					},
					anthropicDegradedSendState,
				);
			} catch (error) {
				if (error instanceof ServerToolCandidateCapabilityError) {
					upstreamAttempts +=
						routingAttemptLedger.attemptedCount - attemptedBefore;
					const forcedResponse = recordServerToolCandidateCapabilityFailure(
						error,
						attemptedBefore,
					);
					if (forcedResponse) {
						return finishPacing(pacingSlot, forcedResponse);
					}
					return null;
				}
				await routingAttemptLedger.discardTerminalResponse();
				throw error;
			} finally {
				if (probeAdmission === "admitted") {
					completeRateLimitProbe(route.account, "abandoned");
				}
			}
			upstreamAttempts += routingAttemptLedger.attemptedCount - attemptedBefore;

			if (isAnthropicDegradedSendDenied(response)) {
				return finishPacing(
					pacingSlot,
					await deliverAnthropicDegradedDenial(response),
				);
			}
			if (!response) return null;

			response = await settleRoutedResponse(response);
			recordCachePacingRoute(
				pacingObservation,
				{
					accountId: route.account.id,
					accountName: route.account.name,
					provider: route.account.provider,
				},
				{
					candidate: pacingEligible,
					assignedBypass: assignedCodexPacingBypass,
				},
			);
			return finishPacing(pacingSlot, response);
		};
		let anyDeferredRouteCrossedTransport = false;
		let firstProbeSuppressedDeferredRoute: DeferredModelRoute | null = null;
		for (let i = 0; i < orderedDeferredModelRoutes.length; i++) {
			const route = orderedDeferredModelRoutes[i];
			requestMeta.comboName = route.comboName;
			requestMeta.comboSlotIndex = route.comboSlotIndex;
			const now = Date.now();
			const predictiveThrottleUntil =
				trustedInternalAutoRefresh || trustedInternalKeepalive
					? null
					: getPredictiveThrottleUntil(route.account, route.model, now);
			if (predictiveThrottleUntil !== null && predictiveThrottleUntil > now) {
				if (
					!deferredPredictivelyThrottledAccounts.some(
						(account) => account.id === route.account.id,
					)
				) {
					deferredPredictivelyThrottledAccounts.push(route.account);
				}
				continue;
			}

			if (
				hasReactiveModelDepletion({
					accountId: route.account.id,
					model: route.model,
					betaSignature,
					syntheticProbe,
				})
			) {
				reactiveDepletionSkips.push(route.account);
				if (
					!deferredReactiveDepletionSkips.some(
						(account) => account.id === route.account.id,
					)
				) {
					deferredReactiveDepletionSkips.push(route.account);
				}
				if (contextAdmissionTracker) {
					contextAdmissionTracker.nonCapacitySkipCount++;
				}
				continue;
			}
			if (
				pacingBypassed &&
				!crossoverPacingRestored &&
				route.account.provider !== "codex"
			) {
				pacingObservation = await observeCachePacing({
					sessionKey: requestMeta.clientSessionId,
					model: effectiveModel,
				});
				pacingSlot = pacingObservation?.slot ?? null;
				crossoverPacingRestored = true;
				pacingBypassed = false;
				requestMeta.codexPacingAction = "crossover-paced";
			}

			const probeAdmission = getRateLimitProbeAdmission(route.account);
			if (probeAdmission === "suppressed") {
				firstProbeSuppressedDeferredRoute ??= route;
				if (contextAdmissionTracker) {
					contextAdmissionTracker.nonCapacitySkipCount++;
				}
				continue;
			}

			const attemptedBeforeDeferredRoute = routingAttemptLedger.attemptedCount;
			const finalResponse = await attemptDeferredRoute(
				route,
				i === orderedDeferredModelRoutes.length - 1,
				probeAdmission,
			);
			if (routingAttemptLedger.attemptedCount > attemptedBeforeDeferredRoute) {
				anyDeferredRouteCrossedTransport = true;
			}
			if (finalResponse) return finalResponse;
		}
		if (
			!anyDeferredRouteCrossedTransport &&
			firstProbeSuppressedDeferredRoute
		) {
			log.info(
				`No deferred route crossed transport and a probe-gated route remains; retrying account ${firstProbeSuppressedDeferredRoute.account.name} model=${firstProbeSuppressedDeferredRoute.model} ungated`,
			);
			if (contextAdmissionTracker) {
				contextAdmissionTracker.nonCapacitySkipCount--;
			}
			const finalResponse = await attemptDeferredRoute(
				firstProbeSuppressedDeferredRoute,
				true,
				null,
			);
			if (finalResponse) return finalResponse;
		}
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
	}

	const retainedTerminalResponse = await deliverRetainedTerminalResponse();
	if (retainedTerminalResponse) {
		return finishPacing(pacingSlot, retainedTerminalResponse);
	}
	if (hasExhaustedLocalServerToolCapabilityFailures()) {
		cacheBodyStore.discardStaged(requestMeta.id);
		return finishPacing(
			pacingSlot,
			createUnservedServerToolRoutingErrorResponse(
				new ServerToolRoutingError({
					reason: "no_implementation",
					capabilitySummary: currentServerToolCapabilitySummary(),
				}),
			),
		);
	}

	if (
		fallbackSelectionHadNoAvailable &&
		reactivelyDepletedFallbackAccounts.length > 0
	) {
		cacheBodyStore.discardStaged(requestMeta.id);
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		return finishPacing(
			pacingSlot,
			createModelPoolExhaustedResponse({
				capacityContext: getRoutingCapacityContext(requestMeta),
				rateLimitOutcomes: getRequestRateLimitOutcomes(req),
				now: Date.now(),
				modelRecoveryAt: reactiveModelRecoveryAt,
			}),
		);
	}
	// If routing skipped every remaining candidate using direct, short-lived
	// model-scoped depletion evidence, return a model-lane terminal. Predictive
	// pacing alone owns HTTP 529; hard/reactive exclusions take precedence over
	// every soft throttle and must not acquire retry-held whole-pool markers.
	if (
		deferredReactiveDepletionSkips.length > 0 ||
		(reactiveDepletionSkips.length > 0 && upstreamAttempts === 0)
	) {
		cacheBodyStore.discardStaged(requestMeta.id);
		return finishPacing(
			pacingSlot,
			createModelPoolExhaustedResponse({
				capacityContext: getRoutingCapacityContext(requestMeta),
				rateLimitOutcomes: getRequestRateLimitOutcomes(req),
				now: Date.now(),
				modelRecoveryAt: reactiveModelRecoveryAt,
			}),
		);
	}
	if (fallbackSelectionHadNoAvailable && throttledFallbackAccounts.length > 0) {
		cacheBodyStore.discardStaged(requestMeta.id);
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		return finishPacing(
			pacingSlot,
			createUsageThrottledResponse(throttledFallbackAccounts),
		);
	}
	if (deferredPredictivelyThrottledAccounts.length > 0) {
		cacheBodyStore.discardStaged(requestMeta.id);
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		return finishPacing(
			pacingSlot,
			createUsageThrottledResponse(deferredPredictivelyThrottledAccounts),
		);
	}

	if (
		contextAdmissionTracker &&
		contextAdmissionTracker.rejectedCount > 0 &&
		contextAdmissionTracker.attemptedCount === 0 &&
		contextAdmissionTracker.nonCapacitySkipCount === 0
	) {
		cacheBodyStore.discardStaged(requestMeta.id);
		pacingSlot?.abandon();
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		const terminalResponse = createContextLengthExceededResponse(
			contextAdmissionTracker,
		);
		void recordRoutingTerminalRequest({
			collector: tryGetUsageCollector(),
			requestMeta,
			requestHeaders: req.headers,
			response: terminalResponse,
			providerName: ctx.provider.name,
			terminalKind: "context_length_exceeded",
			upstreamAttempts: 0,
			apiKeyId,
			apiKeyName,
			skip: trustedInternalAutoRefresh,
			onError: (error) => {
				log.error(
					`handleEnd failed for context_length_exceeded request ${requestMeta.id}`,
					error,
				);
			},
		});
		return terminalResponse;
	}

	// 11. All accounts failed - check if OAuth token issues are the cause
	const allAttemptedAccounts = [
		...new Map(
			[
				...accounts,
				...(fallbackAccounts ?? []),
				...deferredModelRoutes.map((route) => route.account),
			].map((account) => [account.id, account]),
		).values(),
	];
	const oauthAccounts = allAttemptedAccounts.filter((acc) => acc.refresh_token);
	const needsReauth = oauthAccounts.filter((acc) =>
		isRefreshTokenLikelyExpired(acc),
	);

	if (needsReauth.length > 0) {
		// Quote account names to prevent command injection (defense-in-depth)
		const reauthCommands = needsReauth
			.map(
				(acc) =>
					`bun run cli --reauthenticate "${acc.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
			)
			.join("\n  ");
		cacheBodyStore.discardStaged(requestMeta.id);
		pacingSlot?.abandon();
		// All candidates failed, no account served — degrade the badge (KTD-5).
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${needsReauth.map((acc) => acc.name).join(", ")}.\n\nPlease re-authenticate:\n  ${reauthCommands}`,
			ctx.provider.name,
		);
	}

	let terminalAccounts = allAttemptedAccounts;
	try {
		const refreshedTerminalAccounts = filterRequestCompatibleAccounts(
			await ctx.dbOps.getAllAccounts(),
			req.headers,
		);
		terminalAccounts = mergeTerminalAccountState(
			refreshedTerminalAccounts,
			allAttemptedAccounts,
		);
	} catch (error) {
		log.error("Failed to refresh terminal account state", error);
	}
	const actualUpstreamAttempts = routingAttemptLedger.attemptedCount;
	const terminal = createRoutingTerminalResponse({
		source: "attempts",
		accounts: terminalAccounts,
		capacityContext: getRoutingCapacityContext(requestMeta),
		rateLimitOutcomes: getRequestRateLimitOutcomes(req),
		upstreamAttempts: actualUpstreamAttempts,
		modelRecoveryAt: reactiveModelRecoveryAt,
		message: formatRoutingAttemptMessage(
			ERROR_MESSAGES.ALL_UPSTREAM_ROUTES_FAILED,
			routingAttemptLedger,
		),
		routeCircuitRecoveryHint: getRouteCircuitRecoveryHint(),
	});
	cacheBodyStore.discardStaged(requestMeta.id);
	// All candidates failed, no account served — degrade the badge (KTD-5).
	if (sessionId) clearSession(sessionId, requestMeta.timestamp);
	// Record the native terminal before the outer Anthropic rescue can translate
	// a delayed JSON 503 into an HTTP-200 SSE error. This path previously bypassed
	// forwardToClient entirely, leaving no durable request-history row.
	void recordRoutingTerminalRequest({
		collector: tryGetUsageCollector(),
		requestMeta,
		requestHeaders: req.headers,
		response: terminal.response,
		providerName: ctx.provider.name,
		terminalKind: terminal.kind,
		upstreamAttempts: actualUpstreamAttempts,
		apiKeyId,
		apiKeyName,
		skip: trustedInternalAutoRefresh,
		onError: (error) => {
			log.error(
				`handleEnd failed for ${terminal.kind} request ${requestMeta.id}`,
				error,
			);
		},
	});
	return finishPacing(pacingSlot, terminal.response);
}

/**
 * Injects `ttl: "1h"` into system-level cache_control blocks that are missing a TTL.
 * ArrayBuffer overload: returns modified buffer or null (no changes).
 * RequestBodyContext overload: mutates in-place via markDirty(); return value unused.
 */
export function injectSystemCacheTtl(buf: ArrayBuffer): ArrayBuffer | null;
export function injectSystemCacheTtl(context: RequestBodyContext): void;
export function injectSystemCacheTtl(
	input: ArrayBuffer | RequestBodyContext,
): ArrayBuffer | null {
	const bodyContext =
		input instanceof RequestBodyContext ? input : new RequestBodyContext(input);
	try {
		const body = bodyContext.getParsedJson() as
			| (RequestJsonBody & {
					system?: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			  })
			| null;
		if (!body) return null;
		if (!Array.isArray(body.system)) return null;
		const blocksToUpdate = body.system.filter(
			(block) =>
				block.cache_control?.type === "ephemeral" && !block.cache_control.ttl,
		);
		if (blocksToUpdate.length === 0) return null;
		bodyContext.mutateParsedJson((b) => {
			const typedBody = b as RequestJsonBody & {
				system: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			};
			for (const block of typedBody.system) {
				if (
					block.cache_control?.type === "ephemeral" &&
					!block.cache_control.ttl
				) {
					block.cache_control.ttl = "1h";
				}
			}
		});
		return bodyContext.getBuffer();
	} catch {
		return null;
	}
}
