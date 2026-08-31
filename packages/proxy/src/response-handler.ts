import {
	BUFFER_SIZES,
	type CacheFlightCohortSealReceipt,
	requestEvents,
	SseFrameBuffer,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
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
	RouteProvenance,
} from "@better-ccflare/types";
import type { AnthropicDegradedResponseLifecycle } from "./anthropic-degraded-response-lifecycle";
import { createAnthropicSemanticLivenessStream } from "./anthropic-semantic-liveness";
import {
	getAnthropicStreamRuntimeConfig,
	isDownstreamAnthropicMessagesSse,
} from "./anthropic-semantic-preflight";
import { AnthropicStreamOutcomeTracker } from "./anthropic-stream-outcome";
import {
	type AnthropicTerminalState,
	createAnthropicTerminalRecoveryStream,
} from "./anthropic-terminal-recovery";
import { isInternalProbe, type ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import {
	boundedAccountHoldReset,
	classifyPreByte429,
	getAnthropicRateLimitResetAt,
	type RateLimitScopeDecision,
} from "./handlers/rate-limit-scope";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { ingestModelsListing } from "./model-catalog";
import {
	getRequestLifecycleCoordinator,
	type RequestLifecycleCoordinator,
} from "./routing-terminal-recorder";
import {
	clearSession,
	recordServedAccount,
	sessionIdForObservation,
} from "./session-account-observer";
import { combineChunks, teeStream } from "./stream-tee";
import { extractUpstreamErrorTelemetry } from "./upstream-error-observability";
import { getUsageCollector } from "./usage-collector";
import {
	type EndMessage,
	isModelRewrite,
	resolveComboModelOverride,
	type StartMessage,
} from "./worker-messages";

const log = new Logger("ResponseHandler");

function captureCacheFlightCohortSealReceipt(
	options: Pick<
		ResponseHandlerOptions,
		| "requestId"
		| "account"
		| "cacheFlightRecorderConversationId"
		| "cacheFlightRecorderEligible"
		| "xaiCacheOfficialEndpoint"
		| "attemptedModel"
		| "routeCandidateId"
	>,
	ctx: ProxyContext,
): CacheFlightCohortSealReceipt | null {
	if (
		options.cacheFlightRecorderEligible !== true ||
		!options.cacheFlightRecorderConversationId ||
		options.xaiCacheOfficialEndpoint !== true ||
		ctx.provider.name !== "xai" ||
		!options.account ||
		!ctx.cacheFlightCohortSeal
	) {
		return null;
	}

	try {
		return ctx.cacheFlightCohortSeal.captureReceipt({
			finalServingAccount: options.account,
			attemptedTransportModel: options.attemptedModel ?? null,
			routeCandidateId: options.routeCandidateId ?? null,
		});
	} catch {
		log.warn("Cache flight cohort seal capture failed", {
			requestId: options.requestId,
		});
		return null;
	}
}

function fireAndForgetEnd(
	msg: EndMessage,
	lifecycleCoordinator: RequestLifecycleCoordinator | null,
): void {
	const completion = lifecycleCoordinator
		? lifecycleCoordinator.finalize(msg)
		: getUsageCollector().handleEnd(msg);
	completion.catch((err: unknown) => {
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
	// Hoisted out of the branch below: the cooldown call at the end of this
	// function needs the verdict to know whether any reset it has is attributable
	// to the account window. Without it that call defaulted to "confirmed" and
	// could still write a 12h whole-account bench from a per-model reset (#160).
	let decision: RateLimitScopeDecision | null = null;
	if (firedReason === "rate_limit_error") {
		// Reuse the same conservative policy as a pre-byte generic 429. The SSE
		// response itself is 200, so synthesize only the status while preserving
		// upstream headers that may positively prove an account-wide limit.
		const classificationResponse = new Response(null, {
			status: 429,
			headers: response.headers,
		});
		decision = classifyPreByte429({
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
	const midStreamReason: RateLimitReason = isOverload
		? "upstream_529_overloaded_no_reset"
		: "upstream_429_with_reset";
	// SSE error frames don't carry reset headers — HTTP headers were already
	// sent before the error occurred — so any resetTime we could compute here
	// for a 529 would be a value ccflare invents, never an upstream
	// instruction. Omit it entirely and let the cooldown core apply its own
	// fixed short overload cooldown (computeOverloadCooldownMs, see
	// applyRateLimitCooldown's upstream_529_overloaded_no_reset handling).
	// A genuine rate_limit_error still honors the original HTTP 200 headers
	// exactly as before — they can positively describe a real quota window.
	// The header below never names its window and carries the per-model weekly
	// reset on a model-scoped 429, and the fallback is a value ccflare invents.
	// Neither is attributable, so only the classifier's proven account window may
	// size a durable hold — bounded by the header, which may shorten it but never
	// stretch it (#160).
	const attributedReset = boundedAccountHoldReset(
		decision?.accountWindowResetAt ?? null,
		getAnthropicRateLimitResetAt(response, now),
	);
	applyRateLimitCooldown(
		account,
		isOverload
			? { reason: midStreamReason }
			: {
					resetTime:
						attributedReset ??
						getAnthropicRateLimitResetAt(response, now) ??
						now + getMidStreamRateLimitCooldownMs(),
					reason: midStreamReason,
					resetTimeScope:
						attributedReset !== null ? "confirmed" : "unattributed",
				},
		ctx,
	);
}

// Must match MAX_REQUEST_BODY_BYTES in usage-collector.ts.
// Cap applied before passing to collector to avoid multi-MB copies.
// 4MB so afterburn can see full conversation history for friction analysis.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const MODEL_REWRITE_HEADER = "x-better-ccflare-model-rewrite";
const ROUTE_FALLBACK_HEADER = "x-better-ccflare-route-fallback";
const ROUTED_MODEL_HEADER = "x-better-ccflare-routed-model";
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
		routeProvenance?: RouteProvenance | null;
	},
): Headers {
	const result = new Headers(headers);
	if (isModelRewrite(options.originalModel, options.appliedModel)) {
		result.set(
			MODEL_REWRITE_HEADER,
			`${options.originalModel}->${options.appliedModel}`,
		);
	}
	if (options.routeProvenance?.fallbackRung) {
		result.set(ROUTE_FALLBACK_HEADER, options.routeProvenance.fallbackRung);
	}
	if (options.routeProvenance?.routedModel) {
		result.set(ROUTED_MODEL_HEADER, options.routeProvenance.routedModel);
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

/**
 * Emit categorical metadata for a consumed, non-streaming upstream 403.
 *
 * The body parser is deliberately bounded and drops provider messages and
 * unsafe fields. This is diagnostics only: the response status, headers, and
 * bytes sent to the client remain untouched, and no routing decision consumes
 * this signal.
 */
function logNonStreamingUpstream403(
	requestId: string,
	provider: string,
	accountId: string | null,
	body: Uint8Array | null,
	status: number,
): void {
	const telemetry = extractUpstreamErrorTelemetry(body, status);
	if (!telemetry) return;
	log.warn("upstream_non_stream_403", {
		requestId,
		provider,
		accountId,
		...telemetry,
	});
}

interface RawSseFrame {
	frame: Uint8Array;
	delimiter: Uint8Array;
	remainder: Uint8Array;
}

function takeRawSseFrame(bytes: Uint8Array): RawSseFrame | null {
	for (let index = 0; index < bytes.byteLength; index += 1) {
		let delimiterLength = 0;
		if (bytes[index] === 10) {
			if (bytes[index + 1] === 10) delimiterLength = 2;
			else if (bytes[index + 1] === 13 && bytes[index + 2] === 10)
				delimiterLength = 3;
		} else if (bytes[index] === 13 && bytes[index + 1] === 10) {
			if (bytes[index + 2] === 10) delimiterLength = 3;
			else if (bytes[index + 2] === 13 && bytes[index + 3] === 10)
				delimiterLength = 4;
		}
		if (delimiterLength > 0) {
			return {
				frame: bytes.subarray(0, index),
				delimiter: bytes.subarray(index, index + delimiterLength),
				remainder: bytes.subarray(index + delimiterLength),
			};
		}
	}
	return null;
}

interface JsonStringNode {
	kind: "string";
	value: string;
	start: number;
	end: number;
}

interface JsonObjectNode {
	kind: "object";
	properties: Array<{ key: JsonStringNode; value: JsonNode }>;
}

type JsonNode = JsonStringNode | JsonObjectNode | { kind: "other" };

interface DataSegment {
	value: string;
	start: number;
}

function isJsonWhitespace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** Strict JSON parser retaining token offsets so no payload bytes are reserialized. */
function parseJsonWithOffsets(source: string): JsonNode | null {
	let position = 0;
	const skipWhitespace = (): void => {
		while (position < source.length && isJsonWhitespace(source[position]))
			position += 1;
	};
	const parseString = (): JsonStringNode | null => {
		if (source[position] !== '"') return null;
		const start = position++;
		while (position < source.length) {
			const char = source[position++];
			if (char === '"') {
				try {
					return {
						kind: "string",
						value: JSON.parse(source.slice(start, position)),
						start,
						end: position,
					};
				} catch {
					return null;
				}
			}
			if (char.charCodeAt(0) < 0x20) return null;
			if (char === "\\") {
				const escapedCharacter = source[position++];
				if (!escapedCharacter || !'"\\/bfnrtu'.includes(escapedCharacter)) {
					return null;
				}
				if (escapedCharacter === "u") {
					const hex = source.slice(position, position + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
					position += 4;
				}
			}
		}
		return null;
	};
	const parseValue = (): JsonNode | null => {
		skipWhitespace();
		if (source[position] === '"') return parseString();
		if (source[position] === "{") {
			position += 1;
			skipWhitespace();
			const properties: JsonObjectNode["properties"] = [];
			if (source[position] === "}") {
				position += 1;
				return { kind: "object", properties };
			}
			while (position < source.length) {
				skipWhitespace();
				const key = parseString();
				if (!key) return null;
				skipWhitespace();
				if (source[position++] !== ":") return null;
				const value = parseValue();
				if (!value) return null;
				properties.push({ key, value });
				skipWhitespace();
				if (source[position] === "}") {
					position += 1;
					return { kind: "object", properties };
				}
				if (source[position++] !== ",") return null;
			}
			return null;
		}
		if (source[position] === "[") {
			position += 1;
			skipWhitespace();
			if (source[position] === "]") {
				position += 1;
				return { kind: "other" };
			}
			while (position < source.length) {
				if (!parseValue()) return null;
				skipWhitespace();
				if (source[position] === "]") {
					position += 1;
					return { kind: "other" };
				}
				if (source[position++] !== ",") return null;
			}
			return null;
		}
		const literal =
			/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
				source.slice(position),
			);
		if (!literal) return null;
		position += literal[0].length;
		return { kind: "other" };
	};
	const value = parseValue();
	skipWhitespace();
	return value && position === source.length ? value : null;
}

function uniqueProperty(object: JsonObjectNode, name: string): JsonNode | null {
	const matches = object.properties.filter(
		(property) => property.key.value === name,
	);
	return matches.length === 1 ? matches[0].value : null;
}

function parseSseFrame(frame: string): {
	event: string | null;
	data: DataSegment[];
	ambiguousEvent: boolean;
} {
	const events: string[] = [];
	const data: DataSegment[] = [];
	let lineStart = 0;
	while (lineStart <= frame.length) {
		let lineEnd = lineStart;
		let colon = -1;
		while (lineEnd < frame.length && frame[lineEnd] !== "\n") {
			if (colon === -1 && frame[lineEnd] === ":") colon = lineEnd;
			lineEnd += 1;
		}
		const contentEnd =
			lineEnd > lineStart && frame[lineEnd - 1] === "\r"
				? lineEnd - 1
				: lineEnd;
		if (colon !== -1 && colon < contentEnd && frame[lineStart] !== ":") {
			const field = frame.slice(lineStart, colon);
			const valueStart = frame[colon + 1] === " " ? colon + 2 : colon + 1;
			const value = frame.slice(valueStart, contentEnd);
			if (field === "event") events.push(value);
			if (field === "data") data.push({ value, start: valueStart });
		}
		if (lineEnd === frame.length) break;
		lineStart = lineEnd + 1;
	}
	return {
		event: events.length === 1 ? events[0] : null,
		data,
		ambiguousEvent: events.length > 1,
	};
}

function rewriteUnknownOpenRouterModelFrame(
	frame: Uint8Array,
	attemptedModel: string,
): {
	inspected: boolean;
	replacement: Uint8Array | null;
	invalidUtf8: boolean;
} {
	if (frame[0] === 0xef && frame[1] === 0xbb && frame[2] === 0xbf) {
		// TextDecoder strips a UTF-8 BOM, making source offsets unsuitable for a
		// byte-local replacement. Preserve this and all following frames verbatim.
		return { inspected: true, replacement: null, invalidUtf8: false };
	}
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(frame);
	} catch {
		return { inspected: false, replacement: null, invalidUtf8: true };
	}
	const sse = parseSseFrame(source);
	if (sse.ambiguousEvent) {
		return { inspected: true, replacement: null, invalidUtf8: false };
	}
	if (sse.event !== "message_start") {
		return { inspected: false, replacement: null, invalidUtf8: false };
	}
	const payload = parseJsonWithOffsets(
		sse.data.map(({ value }) => value).join("\n"),
	);
	if (!payload || payload.kind !== "object") {
		return { inspected: true, replacement: null, invalidUtf8: false };
	}
	const type = uniqueProperty(payload, "type");
	const message = uniqueProperty(payload, "message");
	if (
		!type ||
		type.kind !== "string" ||
		type.value !== "message_start" ||
		!message ||
		message.kind !== "object"
	) {
		return { inspected: true, replacement: null, invalidUtf8: false };
	}
	const model = uniqueProperty(message, "model");
	if (!model || model.kind !== "string" || model.value !== "unknown") {
		return { inspected: true, replacement: null, invalidUtf8: false };
	}
	let logicalStart = 0;
	for (const segment of sse.data) {
		const logicalEnd = logicalStart + segment.value.length;
		if (model.start >= logicalStart && model.end <= logicalEnd) {
			const start = segment.start + model.start - logicalStart;
			const end = segment.start + model.end - logicalStart;
			const rawStart = new TextEncoder().encode(
				source.slice(0, start),
			).byteLength;
			const rawEnd = new TextEncoder().encode(source.slice(0, end)).byteLength;
			const replacement = new TextEncoder().encode(
				JSON.stringify(attemptedModel),
			);
			const rewritten = new Uint8Array(
				frame.byteLength - (rawEnd - rawStart) + replacement.byteLength,
			);
			rewritten.set(frame.subarray(0, rawStart));
			rewritten.set(replacement, rawStart);
			rewritten.set(frame.subarray(rawEnd), rawStart + replacement.byteLength);
			return { inspected: true, replacement: rewritten, invalidUtf8: false };
		}
		logicalStart = logicalEnd + 1;
	}
	// Replacing a token that crosses an inserted SSE newline is not provably a raw span.
	return { inspected: true, replacement: null, invalidUtf8: false };
}

/**
 * Normalizes OpenRouter's Anthropic-compatible `message_start` placeholder.
 * attemptedModel is requested transport provenance, not confirmed served identity.
 */
const MAX_RETAINED_SSE_FRAGMENTS = 1_024;

function createOpenRouterModelNormalizationStream(
	upstream: ReadableStream<Uint8Array>,
	attemptedModel: string,
): ReadableStream<Uint8Array> {
	const frames = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});
	let rawParts: Uint8Array[] = [];
	let rawByteLength = 0;
	let passThrough = false;
	const drainRawParts = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		for (const part of rawParts) controller.enqueue(part);
		rawParts = [];
		rawByteLength = 0;
	};

	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (chunk.byteLength === 0) return;
				if (passThrough) {
					controller.enqueue(chunk);
					return;
				}
				rawParts.push(chunk);
				rawByteLength += chunk.byteLength;
				if (rawParts.length > MAX_RETAINED_SSE_FRAGMENTS) {
					passThrough = true;
					drainRawParts(controller);
					return;
				}
				let parsedFrames: string[];
				try {
					parsedFrames = frames.push(chunk);
				} catch {
					passThrough = true;
					drainRawParts(controller);
					return;
				}
				if (parsedFrames.length === 0) return;

				// A complete frame is bounded by SseFrameBuffer. Materialize retained
				// raw fragments only once here; no-delimiter pushes retain fragments.
				const rawBlock = new Uint8Array(rawByteLength);
				let offset = 0;
				for (const part of rawParts) {
					rawBlock.set(part, offset);
					offset += part.byteLength;
				}
				rawParts = [];
				rawByteLength = 0;
				const rawFrames: RawSseFrame[] = [];
				let remainder: Uint8Array<ArrayBufferLike> = rawBlock;
				let rawFrame = takeRawSseFrame(remainder);
				while (rawFrame) {
					rawFrames.push(rawFrame);
					remainder = rawFrame.remainder;
					rawFrame = takeRawSseFrame(remainder);
				}
				if (rawFrames.length !== parsedFrames.length) {
					passThrough = true;
					controller.enqueue(rawBlock);
					return;
				}
				for (const frame of rawFrames) {
					if (passThrough) {
						controller.enqueue(frame.frame);
						controller.enqueue(frame.delimiter);
						continue;
					}
					const inspection = rewriteUnknownOpenRouterModelFrame(
						frame.frame,
						attemptedModel,
					);
					if (inspection.invalidUtf8) passThrough = true;
					controller.enqueue(inspection.replacement ?? frame.frame);
					controller.enqueue(frame.delimiter);
					if (inspection.inspected) passThrough = true;
				}
				if (passThrough) {
					if (remainder.byteLength > 0) controller.enqueue(remainder);
				} else if (remainder.byteLength > 0) {
					rawParts = [remainder];
					rawByteLength = remainder.byteLength;
				}
			},
			flush(controller) {
				if (!passThrough) {
					try {
						frames.flush();
					} catch {
						// The retained raw fragments are emitted unchanged below.
					}
				}
				drainRawParts(controller);
			},
		}),
	);
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
	/** Client session id (body `metadata.user_id`), persisted for attribution. */
	clientSessionId?: string | null;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
	originalModel?: string | null;
	appliedModel?: string | null;
	/** Pre-override model when a combo slot's model override applied on this
	 * attempt; null otherwise. Paired with comboModelOverrideTo and gated
	 * through resolveComboModelOverride() before being persisted/exposed. */
	comboModelOverrideFrom?: string | null;
	/** Combo slot's override model when it applied on this attempt; null
	 * otherwise. See comboModelOverrideFrom. */
	comboModelOverrideTo?: string | null;
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
	/** Classified native terminal recorded when this response closes normally. */
	terminalError?: string | null;
	/** Aborts the same upstream fetch when terminal stream draining times out. */
	drainAbort?: AbortController;
	/** One committed degraded-mode send, transferred after wrapping succeeds. */
	anthropicDegradedLifecycle?: AnthropicDegradedResponseLifecycle | null;
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
		clientSessionId,
		apiKeyId,
		apiKeyName,
		comboName,
		originalModel,
		appliedModel,
		comboModelOverrideFrom,
		comboModelOverrideTo,
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
		terminalError = null,
		drainAbort,
		anthropicDegradedLifecycle,
	} = options;
	const winningCandidate = routeCandidateId
		? routingMeta?.routingCandidateCatalog?.find(
				(candidate) => candidate.candidateId === routeCandidateId,
			)
		: undefined;
	const routeProvenance: RouteProvenance | null =
		routingMeta?.routeProfileId || winningCandidate?.routeFallbackRung
			? {
					profileId: routingMeta?.routeProfileId ?? null,
					requestedModel:
						routingMeta?.requestedLogicalModel ?? originalModel ?? null,
					routedProvider: account?.provider ?? null,
					routedModel: attemptedModel ?? null,
					fallbackRung: winningCandidate?.routeFallbackRung ?? null,
					homeAction: routingMeta?.routeHomeAction ?? "none",
					repinReason: routingMeta?.routeRepinReason ?? null,
					candidateId: routeCandidateId,
				}
			: null;

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
			recordServedAccount(
				servedSessionId,
				account.id,
				timestamp,
				routingMeta?.routeProfileId ?? null,
				attemptedModel
					? {
							requestedModel: originalModel ?? null,
							appliedModel: appliedModel ?? null,
							upstreamModel: attemptedModel,
						}
					: null,
			);
		} else {
			clearSession(servedSessionId, timestamp);
		}
	}

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);
	// Not stripping x-better-ccflare-codex-response-format: for /v1/responses
	// traffic this goes to handler.ts (not the real client), which reads it
	// and strips it itself.
	const isCodexResponsesPassthrough = response.headers.has(
		"x-better-ccflare-codex-response-format",
	);
	response.headers.delete("x-better-ccflare-request-path");

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
	const isAutoRefreshProbe = isInternalProbe(
		requestHeaders,
		ctx,
		"auto-refresh",
	);
	const isSyntheticCountTokens =
		path === "/v1/messages/count_tokens" &&
		(ctx.provider.name === "openai-compatible" ||
			ctx.provider.name === "codex");
	const lifecycleCoordinator = routingMeta
		? getRequestLifecycleCoordinator(routingMeta)
		: null;
	let shouldProcessRequest =
		!isSyntheticCountTokens &&
		!isAutoRefreshProbe &&
		(!lifecycleCoordinator || lifecycleCoordinator.state === "unclaimed");

	// Send START message immediately if not filtered
	if (shouldProcessRequest) {
		const cacheFlightCohortSealReceipt = captureCacheFlightCohortSealReceipt(
			{
				requestId,
				account,
				cacheFlightRecorderConversationId,
				cacheFlightRecorderEligible,
				xaiCacheOfficialEndpoint,
				attemptedModel,
				routeCandidateId,
			},
			ctx,
		);
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
			clientSessionId: clientSessionId ?? null,
			routeProvenance,
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
			// Combo delta only when the override actually applied on THIS
			// (successful) attempt and produced a real change — never a stale
			// value from an earlier failed slot (see proxy-operations.ts
			// attemptAppliedModel/comboModelOverrideFrom derivation).
			comboModelOverrideFrom: resolveComboModelOverride(
				comboModelOverrideFrom,
				comboModelOverrideTo,
			)
				? (comboModelOverrideFrom as string)
				: null,
			comboModelOverrideTo: resolveComboModelOverride(
				comboModelOverrideFrom,
				comboModelOverrideTo,
			)
				? (comboModelOverrideTo as string)
				: null,
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
						...(cacheFlightCohortSealReceipt
							? { cacheFlightCohortSealReceipt }
							: {}),
					}
				: {}),
			failoverAttempts,
		};
		const collector = getUsageCollector();
		if (lifecycleCoordinator) {
			shouldProcessRequest = lifecycleCoordinator.start({
				collector,
				message: startMessage,
				onError: (error) => {
					log.error(`usage lifecycle failed for request ${requestId}`, error);
				},
			});
		} else {
			collector.handleStart(startMessage);
		}
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
		// Anthropic-Messages-shaped SSE response detection for the
		// terminal-recovery wrapper (missing message_stop synthesis) and the
		// outcome tracker below. Deliberately broader than
		// isDownstreamAnthropicMessagesStream above — gated on path +
		// content-type + 2xx status only, NOT on the anthropic-version
		// request header or provider name — because the wire format is
		// identical for any anthropic-compatible provider (e.g. minimax) on
		// `/v1/messages`, and a 200 OK with truncated content must not be
		// silently recorded as success regardless of which upstream served
		// it or whether the client happened to send anthropic-version.
		// isDownstreamAnthropicMessagesStream stays header-scoped because it
		// also gates the separate semantic-liveness/precommit-rescue
		// subsystem above, which penalizes routes via the strategy's
		// circuit breaker — narrower on purpose so that broadening recovery
		// coverage here doesn't also broaden route-penalization blast radius.
		const isAnthropicMessagesSseResponse =
			method === "POST" &&
			path === "/v1/messages" &&
			response.ok &&
			// Skip Anthropic terminal-state tracking for Codex passthrough responses
			!isCodexResponsesPassthrough &&
			(response.headers
				.get("content-type")
				?.toLowerCase()
				.includes("text/event-stream") ??
				false);
		let streamTerminalState: AnthropicTerminalState | null = null;
		const terminalRecoveredBody = isAnthropicMessagesSseResponse
			? createAnthropicTerminalRecoveryStream(semanticallyBoundedBody, {
					drainAbort,
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
					onTerminalState(state) {
						streamTerminalState = state;
						if (state === "truncated") {
							log.warn("anthropic_stream_truncated_mid_content", {
								requestId,
								accountId: account?.id ?? null,
								provider: ctx.provider.name,
								statusCode: response.status,
							});
						} else if (state === "error") {
							log.warn("anthropic_stream_in_band_error", {
								requestId,
								accountId: account?.id ?? null,
								provider: ctx.provider.name,
								statusCode: response.status,
							});
						}
					},
				})
			: semanticallyBoundedBody;
		// Observe the recovered stream so a safely synthesized message_stop is
		// terminal evidence just like the real upstream event it replaces.
		// Gated on the same broadened isAnthropicMessagesSseResponse as the
		// terminal-recovery wrapper above, so success/error derivation below
		// (which is authoritative over streamTerminalState) covers exactly
		// the same set of requests the wrapper can synthesize/classify for.
		const anthropicOutcomeTracker = isAnthropicMessagesSseResponse
			? new AnthropicStreamOutcomeTracker()
			: null;
		const normalizedAttemptedModel = attemptedModel?.trim() ?? "";
		const shouldNormalizeOpenRouterModel =
			ctx.provider.name === "openrouter" &&
			method === "POST" &&
			path === "/v1/messages" &&
			response.ok &&
			(response.headers
				.get("content-type")
				?.toLowerCase()
				.includes("text/event-stream") ??
				false) &&
			normalizedAttemptedModel.length > 0 &&
			normalizedAttemptedModel.toLowerCase() !== "unknown";
		// Normalize after terminal recovery so outcome tracking, the client, and
		// the usage collector consume the same bytes.
		const responseBody = shouldNormalizeOpenRouterModel
			? createOpenRouterModelNormalizationStream(
					terminalRecoveredBody,
					normalizedAttemptedModel,
				)
			: terminalRecoveredBody;

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
					// Skip cooldown on synthetic cache-keepalive replays. The
					// keepalive scheduler fires parallel requests to every cached
					// account simultaneously; bursts of 4+ concurrent requests can
					// trip Anthropic's per-IP burst limit and 429 every account at
					// the same instant. A keepalive replay whose 200 OK response
					// later emits a mid-stream `event: error` SSE frame is the
					// same class of synthetic burst — applying a real cooldown
					// here drains the pool to zero routable accounts even though
					// no user-visible quota was actually exhausted. Loop-prevention
					// header set by cache-keepalive-scheduler.ts; only synthetic
					// replays carry it. Mirrors the keepalive exemption already
					// applied in proxy-operations.ts (3 sites) and
					// response-processor.ts — closing the gap flagged on merged
					// upstream PR #196 (greptile-apps).
					const isKeepalive = isInternalProbe(requestHeaders, ctx, "keepalive");
					if (isKeepalive) {
						log.warn(
							`Keepalive replay for ${account.name} hit mid-stream rate-limit — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
						);
					} else {
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
			if (anthropicDegradedLifecycle) {
				if (response.status === 529) {
					anthropicDegradedLifecycle.settle(
						"overloaded",
						response.headers.get("retry-after"),
					);
				} else if (
					anthropicOutcome?.status === "midstream_error" &&
					anthropicOutcome.errorType === "overloaded_error"
				) {
					anthropicDegradedLifecycle.settle("overloaded");
				} else if (termination.kind === "cancel") {
					anthropicDegradedLifecycle.settle("cancelled");
				} else if (termination.kind === "error") {
					anthropicDegradedLifecycle.settle("failed");
				} else if (
					anthropicCleanTerminalSuccessSeen &&
					anthropicOutcome?.status === "completed" &&
					anthropicOutcome.parseState === "clean" &&
					!anthropicOutcome.truncatedTailSeen
				) {
					anthropicDegradedLifecycle.settle("success");
				} else {
					anthropicDegradedLifecycle.settle("truncated");
				}
			}
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
					// Real observed SSE termination state from the terminal-recovery
					// wrapper (anthropic-terminal-recovery.ts), recorded alongside —
					// not instead of — the anthropicOutcome-derived success/error
					// above. The two classifiers can disagree at the margins (e.g. a
					// client cancel after a terminal delta but before message_stop),
					// and anthropicOutcome/termination.kind stays authoritative here
					// to preserve existing cancel-precedence behavior; this field is
					// purely additive observability for the new DB column.
					streamTerminalState: streamTerminalState ?? null,
				};
				// Fire-and-forget: handleEnd is async for DB writes but we don't block streaming
				fireAndForgetEnd(endMsg, lifecycleCoordinator);
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
					errorCode: anthropicOutcome.errorCode ?? null,
					upstreamStatus: anthropicOutcome.upstreamStatus ?? null,
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
			// stream-tee.ts's teeStream() invokes this onCancel callback
			// synchronously BEFORE it propagates the cancel to the wrapped
			// stream via reader.cancel(reason) (see its cancel() handler).
			// createAnthropicTerminalRecoveryStream's own cancel() handler
			// — which sets streamTerminalState to "client_cancelled" via
			// fireTerminalState()/onTerminalState — only runs as part of
			// that later reader.cancel() call. Reading streamTerminalState
			// synchronously here would always observe it as still null.
			// Defer to the next microtask: by then the synchronous portion
			// of the underlying stream's cancel() handler (which runs
			// synchronously within reader.cancel(), before any microtask
			// can execute) has already set streamTerminalState.
			queueMicrotask(() => finishStream({ kind: "cancel" }));
		};

		const passthroughBody = teeStream(responseBody, {
			onChunk,
			onClose,
			onError,
			onCancel,
		});

		const clientResponse = new Response(passthroughBody, {
			status: response.status,
			statusText: response.statusText,
			headers: withResponseMetadataHeaders(response.headers, {
				originalModel,
				appliedModel,
				cacheFlightRecorderConversationId,
				cacheFlightRecorderEligible,
				routeProvenance,
			}),
		});
		anthropicDegradedLifecycle?.transferToResponse();
		return clientResponse;
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	if (!response.body) {
		if (shouldProcessRequest) {
			logNonStreamingUpstream403(
				requestId,
				ctx.provider.name,
				account?.id ?? null,
				null,
				response.status,
			);
		}
		const lifecycleOutcome =
			response.status === 529
				? "overloaded"
				: isExpectedResponse(path, response)
					? "success"
					: "failed";
		if (shouldProcessRequest) {
			const success = isExpectedResponse(path, response);
			fireAndForgetEnd(
				{
					type: "end",
					requestId,
					...(terminalError ? {} : { responseBody: null }),
					success,
					...(!success && terminalError ? { error: terminalError } : {}),
				},
				lifecycleCoordinator,
			);
		}

		let clientResponse = response;
		if (
			isModelRewrite(originalModel, appliedModel) ||
			(cacheFlightRecorderEligible === true &&
				Boolean(cacheFlightRecorderConversationId))
		) {
			clientResponse = new Response(null, {
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

		anthropicDegradedLifecycle?.transferToResponse();
		anthropicDegradedLifecycle?.settle(
			lifecycleOutcome,
			lifecycleOutcome === "overloaded"
				? response.headers.get("retry-after")
				: undefined,
		);
		return clientResponse;
	}

	const MAX_NON_STREAM_BODY_BYTES = 256 * 1024; // 256KB cap for stored body

	// A non-streaming body can terminate with EOF, an upstream read error, or
	// downstream cancellation. Observe each response at most once so a
	// terminal callback race cannot duplicate the diagnostic event.
	let nonStreaming403Observed = false;
	const observeNonStreaming403 = (body: Uint8Array | null): void => {
		if (nonStreaming403Observed) return;
		nonStreaming403Observed = true;
		logNonStreamingUpstream403(
			requestId,
			ctx.provider.name,
			account?.id ?? null,
			body,
			response.status,
		);
	};

	const passthroughBody = teeStream(response.body, {
		maxBytes: MAX_NON_STREAM_BODY_BYTES,
		onClose(buffered) {
			const cappedBuf = combineChunks(buffered);
			if (shouldProcessRequest) {
				observeNonStreaming403(cappedBuf);
			}
			const lifecycleOutcome =
				response.status === 529
					? "overloaded"
					: isExpectedResponse(path, response)
						? "success"
						: "failed";
			anthropicDegradedLifecycle?.settle(
				lifecycleOutcome,
				lifecycleOutcome === "overloaded"
					? response.headers.get("retry-after")
					: undefined,
			);
			// Hoisted above the shouldProcessRequest filter: passive model-catalog
			// capture is independent of the analytics/logging filter above (it's
			// not analytics, and must still run e.g. for a filtered synthetic
			// request that nonetheless carries a real GET /v1/models response).
			if (
				method === "GET" &&
				path === "/v1/models" &&
				response.status === 200 &&
				account
			) {
				void ingestModelsListing(cappedBuf.toString("utf-8"), account, query);
			}

			if (!shouldProcessRequest) return;
			const success = isExpectedResponse(path, response);
			fireAndForgetEnd(
				{
					type: "end",
					requestId,
					...(terminalError
						? {}
						: {
								responseBody:
									cappedBuf.byteLength > 0
										? cappedBuf.toString("base64")
										: null,
							}),
					success,
					...(!success && terminalError ? { error: terminalError } : {}),
				},
				lifecycleCoordinator,
			);
		},
		onError(err) {
			if (shouldProcessRequest) observeNonStreaming403(null);
			anthropicDegradedLifecycle?.settle("failed");
			if (!shouldProcessRequest) return;
			fireAndForgetEnd(
				{
					type: "end",
					requestId,
					success: false,
					error: err.message,
				},
				lifecycleCoordinator,
			);
		},
		onCancel() {
			if (shouldProcessRequest) observeNonStreaming403(null);
			anthropicDegradedLifecycle?.settle("cancelled");
			if (!shouldProcessRequest) return;
			fireAndForgetEnd(
				{
					type: "end",
					requestId,
					success: false,
					error: "downstream_cancelled",
				},
				lifecycleCoordinator,
			);
		},
	});

	const clientResponse = new Response(passthroughBody, {
		status: response.status,
		statusText: response.statusText,
		headers: withResponseMetadataHeaders(response.headers, {
			originalModel,
			appliedModel,
			cacheFlightRecorderConversationId,
			cacheFlightRecorderEligible,
		}),
	});
	anthropicDegradedLifecycle?.transferToResponse();
	return clientResponse;
}
