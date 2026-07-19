import { requestEvents, TIME_CONSTANTS } from "@better-ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	AgentAttributionSource,
	ProjectAttributionSource,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import { createAnthropicSemanticLivenessStream } from "./anthropic-semantic-liveness";
import {
	getAnthropicStreamRuntimeConfig,
	isDownstreamAnthropicMessagesSse,
} from "./anthropic-semantic-preflight";
import { AnthropicStreamOutcomeTracker } from "./anthropic-stream-outcome";
import { createAnthropicTerminalRecoveryStream } from "./anthropic-terminal-recovery";
import type { ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import {
	classifyPreByte429,
	getAnthropicRateLimitResetAt,
} from "./handlers/rate-limit-scope";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { ingestModelsListing } from "./model-catalog";
import {
	clearSession,
	recordServedAccount,
	sessionIdForObservation,
} from "./session-account-observer";
import { combineChunks, teeStream } from "./stream-tee";
import { getUsageCollector } from "./usage-collector";
import {
	type EndMessage,
	isModelRewrite,
	type StartMessage,
} from "./worker-messages";

const log = new Logger("ResponseHandler");

function fireAndForgetEnd(msg: EndMessage): void {
	getUsageCollector()
		.handleEnd(msg)
		.catch((err: unknown) => {
			log.error(`handleEnd failed for request ${msg.requestId}`, err);
		});
}

// Default cooldown for rate-limit errors detected mid-stream. SSE error
// frames don't carry reset headers (HTTP headers were sent before the
// error occurred), so we fall back to the same probe-friendly default
// that response-processor.ts uses for headerless 429 responses.
//
// Read on every call (not module load) so a runtime change to the env
// var is picked up without a server restart. Use `||` (not `??`) so an
// empty-string env value (Number("") === 0) falls through to the default
// instead of silently disabling the cooldown.
function getMidStreamRateLimitCooldownMs(): number {
	return (
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS
	);
}

/**
 * Scope an Anthropic `rate_limit_error` discovered only after SSE bytes have
 * already been forwarded. Fresh positive usage can prove a family or account
 * limit; missing, stale, or ambiguous usage is isolated to the exact model +
 * client-beta candidate.
 *
 * This intentionally does not replay the current stream. Once bytes have been
 * emitted, retrying another account would splice two upstream responses into
 * one protocol stream. The marker affects only subsequent routing decisions.
 */
export function handleAnthropicSseRateLimit(
	account: Account,
	attemptedModel: string | null,
	firedReason: "rate_limit_error" | "overloaded_error",
	response: Response,
	requestId: string,
	ctx: ProxyContext,
	betaSignature: string | null = null,
): void {
	if (firedReason === "rate_limit_error") {
		// Reuse the same conservative policy as a pre-byte generic 429. The SSE
		// response itself is 200, so synthesize only the status while preserving
		// upstream headers that may positively prove an account-wide limit.
		const classificationResponse = new Response(null, {
			status: 429,
			headers: response.headers,
		});
		const decision = classifyPreByte429({
			isAnthropic:
				ctx.provider.name === "anthropic" ||
				account.provider === "claude-oauth",
			response: classificationResponse,
			attemptedModel,
			snapshot: usageCache.getSnapshot(account.id),
		});
		let markerApplied = false;
		if (
			decision.scope === "family" &&
			decision.markerExpiresAt !== null &&
			attemptedModel
		) {
			markerApplied = usageCache.markFamilyScopedExhausted(
				account.id,
				attemptedModel,
				decision.markerExpiresAt,
			);
		} else if (
			decision.scope === "model" &&
			decision.markerExpiresAt !== null &&
			attemptedModel
		) {
			usageCache.markModelScopedExhausted(
				account.id,
				attemptedModel,
				betaSignature,
				decision.markerExpiresAt,
			);
			markerApplied =
				usageCache.getModelScopedExhaustion(
					account.id,
					attemptedModel,
					betaSignature,
				) !== null;
		}
		if (markerApplied) {
			log.warn("midstream_model_scoped_429", {
				requestId,
				accountId: account.id,
				accountName: account.name,
				attemptedModel,
				family: decision.family,
				scope: decision.scope,
				reason: decision.reason,
				markerExpiresAt: decision.markerExpiresAt,
				evidenceAgeMs: decision.snapshotAgeMs,
				accountBenched: false,
				streamReplayed: false,
			});
			return;
		}
	}

	const now = Date.now();
	const isOverload = firedReason === "overloaded_error";
	// The original HTTP 200 headers can describe a long-lived account quota
	// window even when the later SSE frame is only a transient overload. Never
	// let that unrelated quota hint turn a 529 into a multi-hour account bench.
	// A genuine rate_limit_error still honors those headers exactly as before.
	const resetTime = isOverload
		? now + getMidStreamRateLimitCooldownMs()
		: (getAnthropicRateLimitResetAt(response, now) ??
			now + getMidStreamRateLimitCooldownMs());
	const midStreamReason: RateLimitReason = isOverload
		? "upstream_529_overloaded_no_reset"
		: "upstream_429_with_reset";
	applyRateLimitCooldown(
		account,
		{
			resetTime,
			reason: midStreamReason,
		},
		ctx,
	);
}

// Must match MAX_REQUEST_BODY_BYTES in usage-collector.ts.
// Cap applied before passing to collector to avoid multi-MB copies.
// 4MB so afterburn can see full conversation history for friction analysis.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const MODEL_REWRITE_HEADER = "x-better-ccflare-model-rewrite";
const CACHE_FLIGHT_RECORDER_HEADER =
	"x-better-ccflare-cache-flight-recorder-id";

/**
 * Builds a Headers copy with the model-rewrite header set when an
 * agent-preference rewrite actually swapped the model (originalModel and
 * appliedModel both present and different). No-op copy otherwise.
 */
function withResponseMetadataHeaders(
	headers: Headers,
	options: {
		originalModel?: string | null;
		appliedModel?: string | null;
		cacheFlightRecorderConversationId?: string | null;
		cacheFlightRecorderEligible?: boolean;
	},
): Headers {
	const result = new Headers(headers);
	if (isModelRewrite(options.originalModel, options.appliedModel)) {
		result.set(
			MODEL_REWRITE_HEADER,
			`${options.originalModel}->${options.appliedModel}`,
		);
	}
	if (
		options.cacheFlightRecorderEligible === true &&
		options.cacheFlightRecorderConversationId
	) {
		result.set(
			CACHE_FLIGHT_RECORDER_HEADER,
			options.cacheFlightRecorderConversationId,
		);
	}
	return result;
}

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: string;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	project?: string | null;
	/** Raw URL query string (e.g. `?after_id=...`), used for passive model-catalog capture. */
	query?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
	agentAttributionSource?: AgentAttributionSource | null;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
	originalModel?: string | null;
	appliedModel?: string | null;
	xaiCacheIdentityFingerprint?: RequestMeta["xaiCacheIdentityFingerprint"];
	xaiCachePrefixFingerprint?: RequestMeta["xaiCachePrefixFingerprint"];
	xaiCacheOfficialEndpoint?: boolean;
	xaiCacheKeyPresent?: boolean;
	cacheFlightRecorderConversationId?: RequestMeta["cacheFlightRecorderConversationId"];
	cacheFlightRecorderEligible?: boolean;
	cacheFlightRecorderNativeActive?: boolean;
	/** Concrete provider model used for this final upstream attempt. */
	attemptedModel?: string | null;
	/** Immutable identity of the exact route that produced this response. */
	routeCandidateId?: string | null;
	/** Internal routing context used only for lane-local failure suppression. */
	routingMeta?: RequestMeta;
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing
 */
// Forward response to client while streaming analytics to worker
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		project,
		query,
		projectAttributionSource,
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
		agentAttributionSource,
		apiKeyId,
		apiKeyName,
		comboName,
		originalModel,
		appliedModel,
		xaiCacheIdentityFingerprint,
		xaiCachePrefixFingerprint,
		xaiCacheOfficialEndpoint,
		xaiCacheKeyPresent,
		cacheFlightRecorderConversationId,
		cacheFlightRecorderEligible,
		cacheFlightRecorderNativeActive,
		attemptedModel = null,
		routeCandidateId = null,
		routingMeta,
	} = options;

	// Record which account actually served this session's request, keyed on the
	// Claude Code session id header, for the status-line account badge (R1, R2).
	// This is the single success point where the definitive serving account and
	// the original request headers are both in scope, after force-routing and the
	// failover loop settled (KTD-1). Synchronous and in-memory so the status-line
	// read never races the async usage collector. When this is the unauthenticated
	// passthrough (account === null), no account served the request, so clear any
	// stale association instead of recording one (KTD-5). Headers.get is
	// case-insensitive and the header is not stripped from the live request.
	//
	// Skip synthetic internal traffic (cache-keepalive replays, auto-refresh
	// probes) via the shared chokepoint, so a keepalive replay's account never
	// overwrites the active session's badge (see sessionIdForObservation).
	const servedSessionId = sessionIdForObservation(requestHeaders);
	if (servedSessionId) {
		// `timestamp` is the request's start time — the ordering version that keeps
		// concurrent same-session requests resolving by issuance, not completion.
		if (account) {
			recordServedAccount(servedSessionId, account.id, timestamp);
		} else {
			clearSession(servedSessionId, timestamp);
		}
	}

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const shouldStorePayloads = ctx.config.getStorePayloads?.() ?? true;

	// Filter out:
	//   - count_tokens requests on providers that synthesize or proxy advisory
	//     token counts; these aren't billable user traffic.
	//   - synthetic auto-refresh probes (issue #199, bug 2). Logging these
	//     pollutes the user-visible 503/200 metrics on the dashboard with
	//     internal scheduler activity. Header set by AutoRefreshScheduler
	//     mirrors the existing keepalive pattern.
	const isAutoRefreshProbe =
		requestHeaders.get("x-better-ccflare-auto-refresh") === "true";
	const isSyntheticCountTokens =
		path === "/v1/messages/count_tokens" &&
		(ctx.provider.name === "openai-compatible" ||
			ctx.provider.name === "codex");
	const shouldProcessRequest = !isSyntheticCountTokens && !isAutoRefreshProbe;

	// Send START message immediately if not filtered
	if (shouldProcessRequest) {
		const startMessage: StartMessage = {
			type: "start",
			messageId: crypto.randomUUID(),
			requestId,
			accountId: account?.id || null,
			method,
			path,
			timestamp,
			requestHeaders: requestHeadersObj,
			requestBody:
				shouldStorePayloads && requestBody
					? Buffer.from(
							new Uint8Array(requestBody).subarray(
								0,
								Math.min(requestBody.byteLength, MAX_REQUEST_BODY_BYTES),
							),
						).toString("base64")
					: null,
			project: project ?? null,
			projectAttributionSource: projectAttributionSource ?? "none",
			agentAttributionSource: agentAttributionSource ?? "none",
			responseStatus: response.status,
			responseHeaders: responseHeadersObj,
			isStream,
			providerName: ctx.provider.name,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			accountName: account?.name ?? null,
			agentUsed: agentUsed || null,
			// Persist the pair only for an actual swap — an agent-detected but
			// unmodified request would otherwise record two equal values that
			// downstream cannot distinguish from a real rewrite.
			originalModel: isModelRewrite(originalModel, appliedModel)
				? (originalModel as string)
				: null,
			appliedModel: isModelRewrite(originalModel, appliedModel)
				? (appliedModel as string)
				: null,
			comboName: comboName || null,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			retryAttempt,
			xaiCacheIdentityFingerprint,
			xaiCachePrefixFingerprint,
			xaiCacheOfficialEndpoint,
			xaiCacheKeyPresent,
			...(cacheFlightRecorderEligible === true &&
			cacheFlightRecorderConversationId
				? {
						cacheFlightRecorderConversationId,
						cacheFlightRecorderEligible: true,
						cacheFlightRecorderNativeActive:
							cacheFlightRecorderNativeActive === true,
					}
				: {}),
			failoverAttempts,
		};
		getUsageCollector().handleStart(startMessage);
	}

	// Emit request start event for real-time dashboard
	if (shouldProcessRequest) {
		requestEvents.emit("event", {
			type: "start",
			id: requestId,
			timestamp,
			method,
			path,
			accountId: account?.id || null,
			statusCode: response.status,
			agentUsed: agentUsed || null,
			agentAttributionSource: agentAttributionSource ?? "none",
		});
	}

	/*********************************************************************
	 *  STREAMING RESPONSES — wrap body with teeStream for inline analytics
	 *********************************************************************/
	if (isStream && response.body) {
		// Mid-stream rate-limit detection for issue #114 Fix 1.2. Only
		// create a sniffer when we know which account to mark — anonymous
		// or unauthenticated requests can't be failed over.
		const rateLimitSniffer = account
			? createSseRateLimitSniffer({ provider: account.provider })
			: null;
		const isDownstreamAnthropicMessagesStream =
			isDownstreamAnthropicMessagesSse({
				method,
				path,
				requestHeaders,
				response,
			});
		const anthropicStreamConfig = isDownstreamAnthropicMessagesStream
			? getAnthropicStreamRuntimeConfig()
			: null;
		let anthropicCleanTerminalSuccessSeen = false;
		const semanticallyBoundedBody =
			isDownstreamAnthropicMessagesStream && anthropicStreamConfig
				? createAnthropicSemanticLivenessStream(response.body, {
						semanticTimeoutMs: anthropicStreamConfig.semanticTimeoutMs,
						meaningfulProgressTimeoutMs:
							anthropicStreamConfig.postCommitMeaningfulProgressTimeoutMs,
						onTimeout(livenessTimeout) {
							let routeCircuitPenalized = false;
							if (
								routeCandidateId &&
								routingMeta &&
								ctx.strategy.reportCandidateFailure
							) {
								ctx.strategy.reportCandidateFailure(routingMeta, {
									candidateId: routeCandidateId,
									reason: `anthropic_postcommit_${livenessTimeout.reason}`,
									suppressForMs: anthropicStreamConfig.routeSuppressionMs,
								});
								routeCircuitPenalized = true;
							}
							log.warn("anthropic_postcommit_semantic_timeout", {
								requestId,
								accountId: account?.id ?? null,
								candidateId: routeCandidateId,
								attemptedModel,
								affinityLanePresent: routingMeta?.affinityLaneKey != null,
								semanticTimeoutMs: anthropicStreamConfig.semanticTimeoutMs,
								postCommitMeaningfulProgressTimeoutMs:
									anthropicStreamConfig.postCommitMeaningfulProgressTimeoutMs,
								timeoutReason: livenessTimeout.reason,
								framesSeen: livenessTimeout.framesSeen,
								validProtocolFramesSeen:
									livenessTimeout.validProtocolFramesSeen,
								frameKindCounts: livenessTimeout.frameKindCounts,
								lastValidProtocolActivityAgeMs:
									livenessTimeout.lastValidProtocolActivityAgeMs,
								lastMeaningfulProgressAgeMs:
									livenessTimeout.lastMeaningfulProgressAgeMs,
								routeCircuitPenalized,
								streamReplayed: false,
							});
						},
						onTransientUpstreamError(errorType) {
							log.warn("anthropic_postcommit_transient_sse_error", {
								requestId,
								accountId: account?.id ?? null,
								candidateId: routeCandidateId,
								attemptedModel,
								affinityLanePresent: routingMeta?.affinityLaneKey != null,
								errorType,
								streamReplayed: false,
							});
							if (routeCandidateId && routingMeta) {
								ctx.strategy.reportCandidateFailure?.(routingMeta, {
									candidateId: routeCandidateId,
									reason: `anthropic_postcommit_transient_sse_error:${errorType}`,
									suppressForMs: anthropicStreamConfig.routeSuppressionMs,
								});
							}
						},
						onTerminalSuccess() {
							// This is evidence from the pre-recovery stream: a real,
							// well-formed message_stop followed by clean upstream EOF.
							anthropicCleanTerminalSuccessSeen = true;
						},
						onCancelError(error) {
							log.warn("anthropic_postcommit_upstream_cancel_failed", {
								requestId,
								accountId: account?.id ?? null,
								candidateId: routeCandidateId,
								errorType: error instanceof Error ? error.name : typeof error,
							});
						},
					})
				: response.body;
		const responseBody = isDownstreamAnthropicMessagesStream
			? createAnthropicTerminalRecoveryStream(semanticallyBoundedBody, {
					gracePeriodMs: anthropicStreamConfig?.terminalGraceMs,
					onRecovery(reason) {
						log.warn("anthropic_terminal_message_stop_recovered", {
							requestId,
							accountId: account?.id ?? null,
							provider: ctx.provider.name,
							reason,
							gracePeriodMs: anthropicStreamConfig?.terminalGraceMs,
						});
					},
					onCancelError(error, reason) {
						log.warn("anthropic_terminal_upstream_cancel_failed", {
							requestId,
							accountId: account?.id ?? null,
							provider: ctx.provider.name,
							reason,
							errorType: error instanceof Error ? error.name : typeof error,
						});
					},
				})
			: semanticallyBoundedBody;
		// Observe the recovered stream so a safely synthesized message_stop is
		// terminal evidence just like the real upstream event it replaces.
		const anthropicOutcomeTracker = isDownstreamAnthropicMessagesStream
			? new AnthropicStreamOutcomeTracker()
			: null;

		const onChunk = (value: Uint8Array): void => {
			anthropicOutcomeTracker?.push(value);
			if (shouldProcessRequest) {
				getUsageCollector().handleChunk(requestId, value);
			}

			// Mid-stream rate-limit detection. The sniffer
			// fires exactly once; after that feed() is a no-op.
			if (account && rateLimitSniffer?.feed(value)) {
				const firedReason = rateLimitSniffer.firedReason;
				if (firedReason) {
					handleAnthropicSseRateLimit(
						account,
						attemptedModel,
						firedReason,
						response,
						requestId,
						ctx,
						requestHeaders.get("anthropic-beta"),
					);
				}
			}
		};

		let streamTerminalHandled = false;
		const finishStream = (
			termination:
				| { kind: "close" }
				| { kind: "error"; error: Error }
				| { kind: "cancel" },
		): void => {
			if (streamTerminalHandled) return;
			streamTerminalHandled = true;

			const anthropicOutcome = anthropicOutcomeTracker?.finish();
			if (
				termination.kind === "close" &&
				anthropicCleanTerminalSuccessSeen &&
				anthropicOutcome?.status === "completed" &&
				anthropicOutcome.parseState === "clean" &&
				!anthropicOutcome.truncatedTailSeen &&
				routeCandidateId &&
				routingMeta
			) {
				ctx.strategy.reportCandidateSuccess?.(routingMeta, {
					candidateId: routeCandidateId,
				});
			}
			if (shouldProcessRequest) {
				let success: boolean;
				let error: string | undefined;

				// Protocol evidence is authoritative for native Anthropic streams:
				// an SSE error event always fails safely, while message_stop completes
				// the response even if the still-open transport later errors or is
				// cancelled. Before either boundary, preserve the transport outcome.
				if (anthropicOutcome?.status === "midstream_error") {
					success = false;
					error = `anthropic_midstream_error:${anthropicOutcome.errorType ?? "unknown_error"}`;
				} else if (anthropicOutcome?.status === "completed") {
					success = true;
					error = undefined;
				} else if (termination.kind === "error") {
					success = false;
					error = termination.error.message;
				} else if (termination.kind === "cancel") {
					success = false;
					error = "downstream_cancelled";
				} else {
					success = anthropicOutcome
						? false
						: isExpectedResponse(path, response);
					error =
						anthropicOutcome?.status === "incomplete_eof"
							? "anthropic_incomplete_eof"
							: undefined;
				}

				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success,
					...(error ? { error } : {}),
				};
				// Fire-and-forget: handleEnd is async for DB writes but we don't block streaming
				fireAndForgetEnd(endMsg);
			}

			if (anthropicOutcome) {
				const outcomeLog = {
					requestId,
					accountId: account?.id ?? null,
					provider: ctx.provider.name,
					transportTermination: termination.kind,
					status: anthropicOutcome.status,
					terminalEvidence: anthropicOutcome.terminalEvidence,
					parseState: anthropicOutcome.parseState,
					limitKind: anthropicOutcome.limitKind ?? null,
					errorType: anthropicOutcome.errorType ?? null,
					messageStopSeen: anthropicOutcome.messageStopSeen,
					errorEventSeen: anthropicOutcome.errorEventSeen,
					truncatedTailSeen: anthropicOutcome.truncatedTailSeen,
					chunkCount: anthropicOutcome.chunkCount,
					rawByteCount: anthropicOutcome.rawByteCount,
					frameCount: anthropicOutcome.frameCount,
					eventCount: anthropicOutcome.eventCount,
					commentFrameCount: anthropicOutcome.commentFrameCount,
					pingEventCount: anthropicOutcome.pingEventCount,
					unknownEventCount: anthropicOutcome.unknownEventCount,
					malformedEventCount: anthropicOutcome.malformedEventCount,
					messageStopCount: anthropicOutcome.messageStopCount,
					errorEventCount: anthropicOutcome.errorEventCount,
				};
				if (anthropicOutcome.status === "completed") {
					log.info("anthropic_stream_terminal_outcome", outcomeLog);
				} else {
					log.warn("anthropic_stream_terminal_outcome", outcomeLog);
				}
			}
		};

		const onClose = (_buffered: Uint8Array[]): void => {
			finishStream({ kind: "close" });
		};

		const onError = (err: Error): void => {
			finishStream({ kind: "error", error: err });
		};

		const onCancel = (_reason: unknown): void => {
			finishStream({ kind: "cancel" });
		};

		const passthroughBody = teeStream(responseBody, {
			onChunk,
			onClose,
			onError,
			onCancel,
		});

		return new Response(passthroughBody, {
			status: response.status,
			statusText: response.statusText,
			headers: withResponseMetadataHeaders(response.headers, {
				originalModel,
				appliedModel,
				cacheFlightRecorderConversationId,
				cacheFlightRecorderEligible,
			}),
		});
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	if (!response.body) {
		if (shouldProcessRequest) {
			fireAndForgetEnd({
				type: "end",
				requestId,
				responseBody: null,
				success: isExpectedResponse(path, response),
			});
		}

		if (
			isModelRewrite(originalModel, appliedModel) ||
			(cacheFlightRecorderEligible === true &&
				Boolean(cacheFlightRecorderConversationId))
		) {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: withResponseMetadataHeaders(response.headers, {
					originalModel,
					appliedModel,
					cacheFlightRecorderConversationId,
					cacheFlightRecorderEligible,
				}),
			});
		}

		return response;
	}

	const MAX_NON_STREAM_BODY_BYTES = 256 * 1024; // 256KB cap for stored body

	const passthroughBody = teeStream(response.body, {
		maxBytes: MAX_NON_STREAM_BODY_BYTES,
		onClose(buffered) {
			// Hoisted above the shouldProcessRequest filter: passive model-catalog
			// capture is independent of the analytics/logging filter above (it's
			// not analytics, and must still run e.g. for a filtered synthetic
			// request that nonetheless carries a real GET /v1/models response).
			const cappedBuf = combineChunks(buffered);

			if (
				method === "GET" &&
				path === "/v1/models" &&
				response.status === 200 &&
				account
			) {
				void ingestModelsListing(cappedBuf.toString("utf-8"), account, query);
			}

			if (!shouldProcessRequest) return;
			fireAndForgetEnd({
				type: "end",
				requestId,
				responseBody:
					cappedBuf.byteLength > 0 ? cappedBuf.toString("base64") : null,
				success: isExpectedResponse(path, response),
			});
		},
		onError(err) {
			if (!shouldProcessRequest) return;
			fireAndForgetEnd({
				type: "end",
				requestId,
				success: false,
				error: err.message,
			});
		},
		onCancel() {
			if (!shouldProcessRequest) return;
			fireAndForgetEnd({
				type: "end",
				requestId,
				success: false,
				error: "downstream_cancelled",
			});
		},
	});

	return new Response(passthroughBody, {
		status: response.status,
		statusText: response.statusText,
		headers: withResponseMetadataHeaders(response.headers, {
			originalModel,
			appliedModel,
			cacheFlightRecorderConversationId,
			cacheFlightRecorderEligible,
		}),
	});
}
