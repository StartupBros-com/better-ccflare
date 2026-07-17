import {
	formatXaiCacheCanary,
	requestEvents,
	ServiceUnavailableError,
	trackClientVersion,
} from "@better-ccflare/core";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	deriveCacheFlightRecorderId,
	deriveXaiConversationIdentity,
	estimateAnthropicAdmissionTokens,
	isCacheFlightRecorderEnabled,
	isXaiCacheNativeEnabled,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
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
import {
	createContextAdmissionTracker,
	createContextLengthExceededResponse,
	createModelPoolExhaustedResponse,
	createRequestMetadata,
	createRoutingTerminalResponse,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	ForceRouteUnavailableError,
	filterRequestCompatibleAccounts,
	getComboSlotInfo,
	getRoutingCapacityContext,
	getUsageThrottleUntil,
	interceptAndModifyRequest,
	isRefreshTokenLikelyExpired,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	RequestBodyContext,
	type RequestJsonBody,
	resolveEffectiveModel,
	selectAccountsForRequest,
	validateProviderPath,
} from "./handlers";
import {
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
} from "./handlers/rate-limit-cooldown";
import { getRequestRateLimitOutcomes } from "./handlers/rate-limit-scope";
import { consumeInternalAutoRefreshAuth } from "./internal-probe-auth";
import { extractProjectAttributionFromRequest } from "./project-attribution";
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

export function isReactivelyModelDepleted(opts: {
	accountId: string;
	model: string | null;
	betaSignature: string | null;
	syntheticProbe: boolean;
	now?: number;
}): boolean {
	if (opts.syntheticProbe || !opts.model) return false;
	return (
		usageCache.getModelScopedExhaustion(
			opts.accountId,
			opts.model,
			opts.betaSignature,
			opts.now,
		) != null ||
		usageCache.getFamilyScopedExhaustion(
			opts.accountId,
			opts.model,
			opts.now,
		) != null
	);
}

const log = new Logger("Proxy");

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
	// Consume the private scheduler credential before any request inspection,
	// metadata construction, logging, cache staging, or upstream forwarding.
	const trustedInternalAutoRefresh = consumeInternalAutoRefreshAuth(
		req.headers,
	);
	// The public marker is meaningful only after internal authentication. Remove
	// spoofed markers so they cannot suppress pacing, analytics, or cache staging.
	if (!trustedInternalAutoRefresh) {
		req.headers.delete("x-better-ccflare-auto-refresh");
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
	const contextAdmissionTracker =
		process.env.CCFLARE_CONTEXT_ADMISSION === "1" &&
		url.pathname === "/v1/messages" &&
		originalParsedBody &&
		originalParsedBody.max_tokens !== 0
			? createContextAdmissionTracker(
					estimateAnthropicAdmissionTokens(originalParsedBody).tokens,
					originalParsedBody.max_tokens,
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
	const {
		modifiedBody,
		agentUsed,
		originalModel,
		appliedModel,
		agentAttributionSource,
	} = await interceptAndModifyRequest(
		requestBodyContext,
		ctx.dbOps,
		req.headers,
		{
			frontmatterModelFallback: ctx.config.getAgentFrontmatterModelFallback(),
		},
	);

	// Use modified body if available
	const finalBodyBuffer = modifiedBody || requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	if (agentUsed && originalModel !== appliedModel) {
		log.info(
			`Agent ${agentUsed} detected, model changed from ${originalModel} to ${appliedModel}`,
		);
	}

	// 5. Create request metadata with agent info
	const requestMeta = createRequestMetadata(req, url);
	requestMeta.trustedInternalAutoRefresh = trustedInternalAutoRefresh;
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
	requestMeta.originalModel = originalModel;
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
		!req.headers.get("x-better-ccflare-keepalive") &&
		!req.headers.get("x-better-ccflare-auto-refresh");
	const pacingCohortKey = pacingEligible
		? derivePacingCohortKey(requestMeta.clientSessionId, parsedBody)
		: null;
	const canaryCandidate = isCodexPacingBypassCandidate(pacingCohortKey);
	requestMeta.codexPacingCohortId = pacingCohortKey?.slice(0, 16) ?? null;
	const effectiveModel = resolveEffectiveModel(appliedModel, requestModel);
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
		selectedAccounts = await selectAccountsForRequest(
			requestMeta,
			ctx,
			effectiveModel ?? undefined,
		);
	} catch (error) {
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
			return new Response(
				JSON.stringify({
					error: {
						type: "force_route_unavailable",
						message: error.message,
						account_id: error.accountId,
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
		throw error;
	}
	const syntheticProbe =
		req.headers.get("x-better-ccflare-keepalive") === "true";
	const applyUsageThrottling = (accounts: Account[]) => {
		const settings = {
			fiveHourEnabled: ctx.config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: ctx.config.getUsageThrottlingWeeklyEnabled(),
		};
		const predictiveUsageEnabled =
			settings.fiveHourEnabled || settings.weeklyEnabled;
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
			const throttleUntil = predictiveUsageEnabled
				? getUsageThrottleUntil(usageCache.get(account.id), settings, now, {
						requestModel: comboRouted ? null : effectiveModel,
						scopedMode: "match",
					})
				: null;
			const reactivelyDepleted =
				!comboRouted &&
				isReactivelyModelDepleted({
					accountId: account.id,
					model: effectiveModel,
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
			selectedAccounts = await selectAccountsForRequest(
				requestMeta,
				ctx,
				effectiveModel ?? undefined,
			);
		} catch (error) {
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
				return new Response(
					JSON.stringify({
						error: {
							type: "force_route_unavailable",
							message: error.message,
							account_id: error.accountId,
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
			throw error;
		}
		({
			available: accounts,
			predictivelyThrottled: throttledAccounts,
			reactivelyDepletedAccounts,
		} = applyUsageThrottling(selectedAccounts));
	}
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

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		// No account will serve this request, whichever branch below fires. Clear
		// the badge association up front — BEFORE the fallible getAllAccounts fetch,
		// collector logging, and the passthrough (a thrown proxyUnauthenticated
		// never reaches forwardToClient's null-account clear) — so no failure or
		// throw below can leave a stale mapping (KTD-5).
		if (sessionId) clearSession(sessionId, requestMeta.timestamp);

		if (reactivelyDepletedAccounts.length > 0) {
			return finishPacing(
				pacingSlot,
				createModelPoolExhaustedResponse({
					capacityContext: getRoutingCapacityContext(requestMeta),
					rateLimitOutcomes: getRequestRateLimitOutcomes(req),
					now: Date.now(),
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
		});
		log.error(`Routing terminal: ${terminal.kind}`);

		// Skip request-log staging for synthetic auto-refresh probes that
		// 503 because their target account is on a known cooldown. Logging
		// these as user-facing 503s inflates the dashboard fail-rate without
		// reflecting any real client impact (issue #199, bug 2). The keepalive
		// scheduler already gets the equivalent treatment via its loop-prevention
		// header path; this brings auto-refresh in line.
		const isAutoRefreshProbe =
			req.headers.get("x-better-ccflare-auto-refresh") === "true";
		const usageCollector = tryGetUsageCollector();
		if (!isAutoRefreshProbe && usageCollector) {
			// Log to request history via usage collector
			usageCollector.handleStart({
				type: "start",
				messageId: crypto.randomUUID(),
				requestId: requestMeta.id,
				accountId: null,
				method: req.method,
				path: url.pathname,
				timestamp: requestMeta.timestamp,
				requestHeaders: Object.fromEntries(req.headers.entries()),
				requestBody: null,
				project: project ?? null,
				projectAttributionSource: projectAttributionSource ?? "none",
				agentAttributionSource: agentAttributionSource ?? "none",
				responseStatus: 503,
				responseHeaders: Object.fromEntries(
					terminal.response.headers.entries(),
				),
				isStream: false,
				providerName: ctx.provider.name,
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: 0,
				accountName: null,
				agentUsed: agentUsed || null,
				originalModel: originalModel || null,
				appliedModel: appliedModel || null,
				comboName: null,
				apiKeyId: apiKeyId || null,
				apiKeyName: apiKeyName || null,
				retryAttempt: 0,
				failoverAttempts: 0,
			});

			usageCollector
				.handleEnd({
					type: "end",
					requestId: requestMeta.id,
					success: false,
					error: terminal.kind,
				})
				.catch((err: unknown) => {
					log.error(
						`handleEnd failed for ${terminal.kind} request ${requestMeta.id}`,
						err,
					);
				});
		}

		// (Session badge already cleared at the top of this block.)
		return finishPacing(pacingSlot, terminal.response);
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
	let response: Response | null = null;
	let upstreamAttempts = 0;
	const reactiveDepletionSkips: Account[] = [];
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
			isReactivelyModelDepleted({
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

		const attemptedBefore = contextAdmissionTracker?.attemptedCount ?? 0;
		try {
			response = await proxyWithAccount(
				req,
				url,
				accounts[i],
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				i,
				ctx,
				modelOverride,
				apiKeyId,
				apiKeyName,
				requestBodyContext,
				!filteredComboInfo?.comboName && i === accounts.length - 1,
				contextAdmissionTracker,
			);
		} finally {
			if (probeAdmission === "admitted") {
				completeRateLimitProbe(accounts[i], "abandoned");
			}
		}
		if (
			!contextAdmissionTracker ||
			contextAdmissionTracker.attemptedCount > attemptedBefore
		) {
			upstreamAttempts++;
		}

		if (response) {
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

		// Log combo slot failure
		if (filteredComboInfo) {
			log.info(
				`Combo slot ${i} failed on account ${accounts[i].name}${i < accounts.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
			);
		}
	}

	// 10. Combo fallback: if combo routing was active and all slots failed,
	//     fall back to normal SessionStrategy routing (REQ-14)
	let fallbackAccounts: Account[] | null = null;
	if (filteredComboInfo?.comboName) {
		log.warn(
			`All combo slots failed for combo "${filteredComboInfo.comboName}", falling back to SessionStrategy routing`,
		);
		// Clear combo info and retry with normal routing
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
		const selectedFallbackAccounts = await selectAccountsForRequest(
			requestMeta,
			ctx,
			effectiveModel ?? undefined,
			{ skipCombo: true },
		);
		const {
			available: filteredFallbackAccounts,
			predictivelyThrottled: throttledFallbackAccounts,
			reactivelyDepletedAccounts: reactivelyDepletedFallbackAccounts,
		} = applyUsageThrottling(selectedFallbackAccounts);
		fallbackAccounts = filteredFallbackAccounts;

		if (fallbackAccounts.length > 0) {
			log.info(
				`Fallback: trying ${fallbackAccounts.length} SessionStrategy accounts`,
			);
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

				const attemptedBefore = contextAdmissionTracker?.attemptedCount ?? 0;
				try {
					response = await proxyWithAccount(
						req,
						url,
						fallbackAccounts[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						i,
						ctx,
						undefined, // No model override for fallback path
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						i === fallbackAccounts.length - 1,
						contextAdmissionTracker,
					);
				} finally {
					if (probeAdmission === "admitted") {
						completeRateLimitProbe(fallbackAccounts[i], "abandoned");
					}
				}
				if (
					!contextAdmissionTracker ||
					contextAdmissionTracker.attemptedCount > attemptedBefore
				) {
					upstreamAttempts++;
				}

				if (response) {
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
		} else if (reactivelyDepletedFallbackAccounts.length > 0) {
			cacheBodyStore.discardStaged(requestMeta.id);
			if (sessionId) clearSession(sessionId, requestMeta.timestamp);
			return finishPacing(
				pacingSlot,
				createModelPoolExhaustedResponse({
					capacityContext: getRoutingCapacityContext(requestMeta),
					rateLimitOutcomes: getRequestRateLimitOutcomes(req),
					now: Date.now(),
				}),
			);
		} else if (throttledFallbackAccounts.length > 0) {
			cacheBodyStore.discardStaged(requestMeta.id);
			// Combo fallback throttled, no account served — badge unknown (KTD-5).
			if (sessionId) clearSession(sessionId, requestMeta.timestamp);
			return finishPacing(
				pacingSlot,
				createUsageThrottledResponse(throttledFallbackAccounts),
			);
		}
	}

	// If routing skipped every remaining candidate using direct, short-lived
	// model-scoped depletion evidence, return a model-lane terminal. Predictive
	// pacing alone owns HTTP 529; hard/reactive exclusions must not masquerade as
	// a soft throttle or acquire retry-held whole-pool markers.
	if (reactiveDepletionSkips.length > 0) {
		if (upstreamAttempts === 0) {
			cacheBodyStore.discardStaged(requestMeta.id);
			return finishPacing(
				pacingSlot,
				createModelPoolExhaustedResponse({
					capacityContext: getRoutingCapacityContext(requestMeta),
					rateLimitOutcomes: getRequestRateLimitOutcomes(req),
					now: Date.now(),
				}),
			);
		}
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
		return createContextLengthExceededResponse(contextAdmissionTracker);
	}

	// 11. All accounts failed - check if OAuth token issues are the cause
	const allAttemptedAccounts = filteredComboInfo
		? [...accounts, ...(fallbackAccounts ?? [])]
		: accounts;
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
		terminalAccounts = filterRequestCompatibleAccounts(
			await ctx.dbOps.getAllAccounts(),
			req.headers,
		);
	} catch (error) {
		log.error("Failed to refresh terminal account state", error);
	}
	const terminal = createRoutingTerminalResponse({
		source: "attempts",
		accounts: terminalAccounts,
		capacityContext: getRoutingCapacityContext(requestMeta),
		rateLimitOutcomes: getRequestRateLimitOutcomes(req),
		upstreamAttempts,
		message: `${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${allAttemptedAccounts.length} attempted)`,
	});
	cacheBodyStore.discardStaged(requestMeta.id);
	// All candidates failed, no account served — degrade the badge (KTD-5).
	if (sessionId) clearSession(sessionId, requestMeta.timestamp);
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
