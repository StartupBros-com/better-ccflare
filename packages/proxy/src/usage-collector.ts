import {
	BUFFER_SIZES,
	cacheOutcomeFromTokens,
	estimateCostUSD,
	formatXaiCacheCanary,
	TIME_CONSTANTS,
	type TurnEvidence,
} from "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	type AgentAttributionSource,
	NO_ACCOUNT_ID,
	type ProjectAttributionSource,
	type RequestResponse,
} from "@better-ccflare/types";
import { formatCost } from "@better-ccflare/ui-common";
import { cacheBodyStore } from "./cache-body-store";
import {
	extractProjectAttributionFromParts,
	sanitizeProjectName,
} from "./project-attribution";
import { combineChunks } from "./stream-tee";
import {
	type EndMessage,
	isModelRewrite,
	type StartMessage,
} from "./worker-messages";

interface RequestState {
	startMessage: StartMessage;
	buffer: string;
	streamDecoder: TextDecoder;
	chunks: Uint8Array[];
	chunksBytes: number;
	chunksTruncated: boolean;
	usage: {
		model?: string;
		inputTokens?: number;
		inputTokensPresent?: boolean;
		cacheReadInputTokens?: number;
		cacheReadInputTokensPresent?: boolean;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		outputTokensComputed?: number;
		totalTokens?: number;
		costUsd?: number;
		tokensPerSecond?: number;
	};
	lastActivity: number;
	createdAt: number; // Capacity eviction ordering
	agentUsed?: string;
	agentAttributionSource?: AgentAttributionSource | null;
	project?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	billingType?: string;
	firstTokenTimestamp?: number;
	lastTokenTimestamp?: number;
	providerFinalOutputTokens?: number;
	shouldSkipLogging?: boolean;
	currentEvent?: string; // Track SSE event type across chunks
}

const log = new Logger("UsageCollector");

// Limits to prevent unbounded growth
const MAX_REQUESTS_MAP_SIZE = 10000;
const MAX_MISSING_STATE_WARNINGS = 1000;
const DEFAULT_PRICING_TIMEOUT_MS = 5_000;
const MAX_PRICING_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024; // 256KB - cap stored response body
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // 4MB - afterburn needs full conversation history
// Bound on distinct conversation IDs buffered for dropped recorder evidence
// markers. Beyond this, additional distinct drops are themselves dropped
// (logged, not written) rather than allowed to grow the buffer unboundedly.
const MAX_PENDING_DROPPED_MARKERS = 1024;
// Debounce window before the buffered dropped-marker map is flushed. Keeps
// the write off the request path entirely; drain() flushes immediately.
const PENDING_DROPPED_MARKER_FLUSH_MS = 250;

// Check if a request should be logged
function shouldLogRequest(path: string, status: number): boolean {
	// Skip logging .well-known 404s
	if (path.startsWith("/.well-known/") && status === 404) {
		return false;
	}
	return true;
}

function getPricingTimeoutMs(): number {
	const configured = Number(process.env.CF_PRICING_TIMEOUT_MS);
	return Number.isSafeInteger(configured) &&
		configured >= 1 &&
		configured <= MAX_PRICING_TIMEOUT_MS
		? configured
		: DEFAULT_PRICING_TIMEOUT_MS;
}
// Parse SSE lines to extract usage (reuse existing logic)
function parseSSELine(line: string): { event?: string; data?: string } {
	// Handle both "event: message_start" and "event:message_start" formats
	// Some providers use no space after colon, Anthropic uses space
	if (line.startsWith("event: ") || line.startsWith("event:")) {
		const event = line.startsWith("event: ")
			? line.slice(7).trim()
			: line.slice(6).trim();
		return { event };
	}
	// Handle both "data: {...}" and "data:{...}" formats
	if (line.startsWith("data: ") || line.startsWith("data:")) {
		const data = line.startsWith("data: ")
			? line.slice(6).trim()
			: line.slice(5).trim();
		return { data };
	}
	return {};
}

function shouldParseSSEData(data: string, eventType: string): boolean {
	if (!data.startsWith("{")) return false;

	switch (eventType) {
		case "message_start":
		case "message_delta":
		case "content_block_start":
		case "content_block_delta":
			return true;
		default:
			return (
				data.includes("usage") ||
				data.includes("message") ||
				data.includes("model")
			);
	}
}

function processSSELine(line: string, state: RequestState): void {
	const trimmed = line.trim();
	if (!trimmed) return;

	const parsed = parseSSELine(trimmed);
	if (parsed.event) {
		state.currentEvent = parsed.event;
	} else if (
		parsed.data &&
		state.currentEvent &&
		shouldParseSSEData(parsed.data, state.currentEvent)
	) {
		extractUsageFromData(parsed.data, state.currentEvent, state);
	}
}

// Extract usage data from non-stream JSON response bodies
function extractUsageFromJson(
	json: {
		model?: string;
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens?: number;
		};
	},
	state: RequestState,
): void {
	if (!json) return;

	const usageObj = json.usage;
	if (!usageObj) return;

	state.usage.model = json.model ?? state.usage.model;

	if (usageObj.input_tokens !== undefined) {
		state.usage.inputTokens = usageObj.input_tokens;
		state.usage.inputTokensPresent = true;
	}
	if (usageObj.cache_read_input_tokens !== undefined) {
		state.usage.cacheReadInputTokens = usageObj.cache_read_input_tokens;
		state.usage.cacheReadInputTokensPresent = true;
	}
	if (usageObj.cache_creation_input_tokens !== undefined) {
		state.usage.cacheCreationInputTokens = usageObj.cache_creation_input_tokens;
	}
	state.usage.outputTokens = usageObj.output_tokens ?? 0;

	// Calculate total tokens
	const prompt =
		(state.usage.inputTokens ?? 0) +
		(state.usage.cacheReadInputTokens ?? 0) +
		(state.usage.cacheCreationInputTokens ?? 0);
	const completion = state.usage.outputTokens ?? 0;
	state.usage.totalTokens = prompt + completion;
}

function extractUsageFromData(
	data: string,
	eventType: string,
	state: RequestState,
): void {
	try {
		const parsed = JSON.parse(data);

		// Handle message_start - check both parsed.type and eventType
		// (Some providers put type in event line, Anthropic puts it in JSON)
		const isMessageStart =
			parsed.type === "message_start" || eventType === "message_start";
		if (isMessageStart) {
			if (parsed.message?.usage) {
				const usage = parsed.message.usage;
				if (usage.input_tokens !== undefined) {
					state.usage.inputTokens = usage.input_tokens;
					state.usage.inputTokensPresent = true;
				}
				if (usage.cache_read_input_tokens !== undefined) {
					state.usage.cacheReadInputTokens = usage.cache_read_input_tokens;
					state.usage.cacheReadInputTokensPresent = true;
				}
				if (usage.cache_creation_input_tokens !== undefined) {
					state.usage.cacheCreationInputTokens =
						usage.cache_creation_input_tokens;
				}
				state.usage.outputTokens = usage.output_tokens || 0;
			}
			if (parsed.message?.model) {
				state.usage.model = parsed.message.model;
			}
		}

		// Track streaming start time on first content block
		if (parsed.type === "content_block_start" && !state.firstTokenTimestamp) {
			state.firstTokenTimestamp = Date.now();
		}

		// Handle message_delta - check both parsed.type and eventType
		const isMessageDelta =
			parsed.type === "message_delta" || eventType === "message_delta";
		if (isMessageDelta) {
			state.lastTokenTimestamp = Date.now();

			if (parsed.usage) {
				// Update all token counts from message_delta (authoritative for zai)
				if (parsed.usage.output_tokens !== undefined) {
					state.providerFinalOutputTokens = parsed.usage.output_tokens;
					state.usage.outputTokens = parsed.usage.output_tokens;
				}
				if (parsed.usage.input_tokens !== undefined) {
					state.usage.inputTokens = parsed.usage.input_tokens;
					state.usage.inputTokensPresent = true;
				}
				if (parsed.usage.cache_read_input_tokens !== undefined) {
					state.usage.cacheReadInputTokens =
						parsed.usage.cache_read_input_tokens;
					state.usage.cacheReadInputTokensPresent = true;
				}
				if (parsed.usage.cache_creation_input_tokens !== undefined) {
					state.usage.cacheCreationInputTokens =
						parsed.usage.cache_creation_input_tokens;
				}
				return; // No further processing needed
			}
			// Even if no usage info, we still set the timestamp for duration calculation
		}

		// Note: tiktoken-based outputTokensComputed was removed (see refactor notes).
		// The provider's authoritative token counts are used instead.

		// Handle any usage field in the data
		if (parsed.usage) {
			if (parsed.usage.input_tokens !== undefined) {
				state.usage.inputTokens = parsed.usage.input_tokens;
				state.usage.inputTokensPresent = true;
			}
			if (parsed.usage.output_tokens !== undefined) {
				state.usage.outputTokens = parsed.usage.output_tokens;
			}
			if (parsed.usage.cache_read_input_tokens !== undefined) {
				state.usage.cacheReadInputTokens = parsed.usage.cache_read_input_tokens;
				state.usage.cacheReadInputTokensPresent = true;
			}
			if (parsed.usage.cache_creation_input_tokens !== undefined) {
				state.usage.cacheCreationInputTokens =
					parsed.usage.cache_creation_input_tokens;
			}
		}
	} catch {
		// Silent fail for non-JSON lines
	}
}

function processStreamChunk(
	chunk: Uint8Array,
	state: RequestState,
	maxBufferSize: number,
): void {
	const text = state.streamDecoder.decode(chunk, { stream: true });
	state.buffer += text;
	state.lastActivity = Date.now();

	// Limit buffer size - preserve event boundaries
	if (state.buffer.length > maxBufferSize) {
		const excess = state.buffer.length - maxBufferSize;
		// Find the first newline after cutting the excess to avoid cutting mid-event
		const firstNewlineAfterCut = state.buffer.indexOf("\n", excess);
		if (firstNewlineAfterCut !== -1) {
			state.buffer = state.buffer.slice(firstNewlineAfterCut + 1);
		} else {
			// Fallback: if no newline found, slice from end but this might cut mid-event
			state.buffer = state.buffer.slice(-maxBufferSize);
		}
		// Event context is lost after truncation — a partial event: line may have
		// been discarded, so the next data: line must not inherit a stale type.
		state.currentEvent = undefined;
	}

	let lineStart = 0;
	for (;;) {
		const lineEnd = state.buffer.indexOf("\n", lineStart);
		if (lineEnd === -1) break;

		processSSELine(state.buffer.slice(lineStart, lineEnd), state);
		lineStart = lineEnd + 1;
	}

	if (lineStart > 0) {
		state.buffer = state.buffer.slice(lineStart);
	}
}

/** Free memory held by a request state before deletion */
function freeRequestState(state: RequestState): void {
	state.chunks.length = 0;
	state.chunksBytes = 0;
	state.buffer = "";
	// Release request body and headers held in startMessage.
	// Without this, orphaned requests retain full request bodies until the
	// inactivity cleanup configured by CF_STREAM_TIMEOUT_MS runs. See #67.
	state.startMessage.requestBody = null;
	state.startMessage.requestHeaders = {};
	state.startMessage.responseHeaders = {};
}

export interface UsageCollectorHealth {
	state: "ready";
}

/**
 * UsageCollector — drop-in replacement for the post-processor Worker.
 *
 * Runs entirely on the main thread so Bun never has a chance to leak the
 * backing stores of Uint8Array values sent across a Worker boundary via
 * structured clone (oven-sh/bun#5709).
 */
export class UsageCollector {
	private readonly requests = new Map<string, RequestState>();
	private readonly missingStateWarnings = new Set<string>();
	private readonly pendingHandleEnds = new Set<Promise<void>>();
	private cleanupInterval: Timer | null = null;

	// Bounded, coalescing buffer for dropped recorder evidence markers. Maps
	// recorderConversationId to a summed drop count so N drops on one
	// conversation become a single write. Never written on the request path.
	private readonly pendingDroppedMarkers = new Map<string, number>();
	private pendingDroppedMarkerOverflowCount = 0;
	private pendingMarkerFlushTimer: Timer | null = null;
	private pendingMarkerFlushInFlight: Promise<void> | null = null;

	private readonly maxBufferSize: number;
	private readonly pricingTimeoutMs: number;
	private readonly timeoutMs: number;

	constructor(
		private readonly dbOps: DatabaseOperations,
		private readonly asyncWriter: AsyncDbWriter,
		private readonly getStorePayloads: () => boolean,
		private readonly onSummary: (summary: RequestResponse) => void,
	) {
		this.maxBufferSize =
			Number(
				process.env.CF_STREAM_USAGE_BUFFER_KB ||
					BUFFER_SIZES.STREAM_USAGE_BUFFER_KB,
			) * 1024;
		this.pricingTimeoutMs = getPricingTimeoutMs();
		this.timeoutMs = Number(
			process.env.CF_STREAM_TIMEOUT_MS || TIME_CONSTANTS.STREAM_TIMEOUT_DEFAULT,
		);

		this.startCleanupInterval();
	}

	handleStart(msg: StartMessage): void {
		// A reused request ID is a new lifecycle and should be eligible for a fresh
		// missing-state warning if it is later evicted.
		this.missingStateWarnings.delete(msg.requestId);

		// Check if we should skip logging this request
		const shouldSkip = !shouldLogRequest(msg.path, msg.responseStatus);

		// Emergency cleanup if map is at capacity (shouldn't happen with periodic cleanup)
		if (this.requests.size >= MAX_REQUESTS_MAP_SIZE) {
			log.error(
				`Requests map at capacity (${MAX_REQUESTS_MAP_SIZE})! Running emergency cleanup...`,
			);
			this.cleanupStaleRequests();

			// If still at capacity after cleanup, force evict oldest 10%
			if (this.requests.size >= MAX_REQUESTS_MAP_SIZE) {
				const toRemove = Math.floor(MAX_REQUESTS_MAP_SIZE * 0.1);
				const sortedByAge = Array.from(this.requests.entries()).sort(
					(a, b) => a[1].createdAt - b[1].createdAt,
				);

				log.error(
					`Emergency cleanup insufficient, force evicting ${toRemove} oldest entries...`,
				);

				for (let i = 0; i < toRemove; i++) {
					const [id, state] = sortedByAge[i];
					this.markEvictedRecorderState(state);
					freeRequestState(state);
					this.requests.delete(id);
				}
			}
		}

		// Create request state
		const now = Date.now();
		const state: RequestState = {
			startMessage: msg,
			buffer: "",
			streamDecoder: new TextDecoder(),
			chunks: [],
			chunksBytes: 0,
			chunksTruncated: false,
			usage: {},
			lastActivity: now,
			createdAt: now,
			shouldSkipLogging: shouldSkip,
		};

		// Use agent from message if provided
		if (msg.agentUsed) {
			state.agentUsed = msg.agentUsed;
			log.debug(`Agent '${msg.agentUsed}' used for request ${msg.requestId}`);
		}
		state.agentAttributionSource = msg.agentAttributionSource ?? "none";

		// Tri-state source contract: an authoritative source label on the StartMessage
		// (a concrete value or "none") is honored without recomputation; a legacy
		// message that carries a project but no source is tagged "none"; a fully
		// legacy/direct message with neither is recomputed via the shared helper.
		if (msg.projectAttributionSource != null) {
			// Authoritative source, but still sanitize the value — a legacy/direct
			// producer could pair a real source label with an unsanitized project
			// (control chars, ANSI, overlong). Drop to "none" if nothing survives.
			const sanitized = sanitizeProjectName(msg.project);
			state.project = sanitized;
			state.projectAttributionSource = sanitized
				? msg.projectAttributionSource
				: "none";
		} else if (msg.project) {
			// Legacy message: project set, no source. Sanitize and tag "none".
			state.project = sanitizeProjectName(msg.project);
			state.projectAttributionSource = "none";
		} else {
			const extracted = extractProjectAttributionFromParts(
				msg.requestHeaders,
				msg.requestBody,
			);
			state.project = extracted.project;
			state.projectAttributionSource = extracted.projectAttributionSource;
		}
		if (state.project) {
			log.debug(
				`Project '${state.project}' extracted for request ${msg.requestId}`,
			);
		}

		// Detect billing type from response headers
		const overageInUse =
			msg.responseHeaders["anthropic-ratelimit-unified-overage-in-use"];
		const overageStatus =
			msg.responseHeaders["anthropic-ratelimit-unified-overage-status"];
		if (overageInUse === "true") {
			state.billingType = "overage";
			// Auto-pause on overage: if the account has auto_pause_on_overage enabled and we're
			// in overage mode, pause the account so future requests route to other accounts
			if (msg.accountAutoPauseOnOverageEnabled === 1 && msg.accountId) {
				const accountId = msg.accountId;
				const accountName = msg.accountName || "unknown";
				log.info(
					`Auto-pausing account '${accountName}' (${accountId}) due to overage detection (auto-pause-on-overage enabled)`,
				);
				this.asyncWriter.enqueue(async () => {
					await this.dbOps.pauseAccount(accountId, "overage");
				});
			}
		} else if (
			overageStatus === "rejected" ||
			overageStatus === "org_level_disabled"
		) {
			state.billingType = "plan";
		} else if (msg.accountBillingType) {
			// Account has explicit billing type override
			state.billingType = msg.accountBillingType;
		} else {
			// Providers with subscription plans default to "plan" billing;
			// all others (anthropic-compatible, openai-compatible, etc.) are API
			const planProviders = new Set([
				"anthropic",
				"zai",
				"alibaba-coding-plan",
				"ollama",
				"ollama-cloud",
				"qwen",
				"codex",
			]);
			state.billingType = planProviders.has(msg.providerName) ? "plan" : "api";
		}

		this.requests.set(msg.requestId, state);

		// Skip all database operations for ignored requests
		if (shouldSkip) {
			log.debug(`Skipping logging for ${msg.path} (${msg.responseStatus})`);
			return;
		}

		// Update account usage if authenticated
		if (msg.accountId && msg.accountId !== NO_ACCOUNT_ID) {
			const accountId = msg.accountId; // Capture for closure
			this.asyncWriter.enqueue(async () =>
				this.dbOps.updateAccountUsage(accountId),
			);
		}
	}

	handleChunk(requestId: string, data: Uint8Array): void {
		const state = this.requests.get(requestId);
		if (!state) {
			this.warnMissingState(requestId);
			return;
		}

		const storePayloads = this.getStorePayloads();

		// Store chunk for later payload saving (capped at MAX_RESPONSE_BODY_BYTES)
		if (storePayloads && !state.chunksTruncated) {
			if (state.chunksBytes + data.byteLength <= MAX_RESPONSE_BODY_BYTES) {
				state.chunks.push(data);
				state.chunksBytes += data.byteLength;
			} else {
				// Store partial chunk up to the limit
				const remaining = MAX_RESPONSE_BODY_BYTES - state.chunksBytes;
				if (remaining > 0) {
					state.chunks.push(data.slice(0, remaining));
					state.chunksBytes += remaining;
				}
				state.chunksTruncated = true;
			}
		}

		// Always process for usage extraction regardless of truncation
		processStreamChunk(data, state, this.maxBufferSize);
	}

	handleEnd(msg: EndMessage): Promise<void> {
		const promise = this._handleEndInternal(msg);
		this.pendingHandleEnds.add(promise);
		const cleanup = () => this.pendingHandleEnds.delete(promise);
		promise.then(cleanup, cleanup);
		return promise;
	}

	/**
	 * Await all in-flight handleEnd promises, flush any buffered dropped
	 * recorder evidence markers, then flush the AsyncDbWriter queue to
	 * completion before process exit.
	 */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.pendingHandleEnds]);
		await this.flushPendingDroppedMarkersNow();
		await this.asyncWriter.dispose();
	}

	getHealth(): UsageCollectorHealth {
		return { state: "ready" };
	}

	dispose(): void {
		this.stopCleanupInterval();
		if (this.pendingMarkerFlushTimer) {
			clearTimeout(this.pendingMarkerFlushTimer);
			this.pendingMarkerFlushTimer = null;
		}
	}

	private async _handleEndInternal(msg: EndMessage): Promise<void> {
		const state = this.requests.get(msg.requestId);
		if (!state) {
			this.warnMissingState(msg.requestId);
			return;
		}
		// Atomically transfer ownership to this finalizer before its first await.
		// This keeps capacity cleanup from freeing the state while pricing resolves,
		// and prevents this lifecycle from later deleting a reused request ID.
		this.requests.delete(msg.requestId);

		const { startMessage } = state;
		const responseTime = Date.now() - startMessage.timestamp;

		// Skip all database operations for ignored requests
		if (state.shouldSkipLogging) {
			freeRequestState(state);
			return;
		}

		// Flush any incomplete multi-byte UTF-8 sequences held in the streaming decoder
		const trailing = state.streamDecoder.decode();
		if (trailing) {
			state.buffer += trailing;
			const lines = state.buffer.split("\n");
			state.buffer = lines.pop() ?? "";
			for (const line of lines) {
				processSSELine(line, state);
			}
		}

		// For non-stream responses, extract usage data from response body
		if (!state.usage.model && msg.responseBody) {
			try {
				const decoded = Buffer.from(msg.responseBody, "base64").toString(
					"utf-8",
				);
				const json = JSON.parse(decoded);
				extractUsageFromJson(json, state);
			} catch {
				// Ignore parse errors
			}
		}

		// Calculate total tokens and cost
		if (state.usage.model) {
			const model = state.usage.model;
			// Use provider's authoritative count if available, fallback to computed
			const finalOutputTokens =
				state.providerFinalOutputTokens ??
				state.usage.outputTokens ??
				state.usage.outputTokensComputed ??
				0;

			// Update usage with final values
			state.usage.outputTokens = finalOutputTokens;
			state.usage.outputTokensComputed = undefined; // Clear to avoid confusion

			state.usage.totalTokens =
				(state.usage.inputTokens || 0) +
				finalOutputTokens +
				(state.usage.cacheReadInputTokens || 0) +
				(state.usage.cacheCreationInputTokens || 0);

			state.usage.costUsd = await this.estimateCostWithDeadline(
				startMessage.requestId,
				model,
				() =>
					estimateCostUSD(model, {
						inputTokens: state.usage.inputTokens,
						outputTokens: finalOutputTokens,
						cacheReadInputTokens: state.usage.cacheReadInputTokens,
						cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
					}),
			);

			// Calculate tokens per second - zai specific vs other providers
			if (finalOutputTokens > 0) {
				const totalDurationSec = responseTime / 1000;

				if (totalDurationSec > 0) {
					// Check if this is a zai model (glm-*)
					const isZaiModel = state.usage.model?.startsWith("glm-");

					if (isZaiModel) {
						// For zai models, use total response time (more intuitive for users)
						state.usage.tokensPerSecond = finalOutputTokens / totalDurationSec;
						if (
							process.env.DEBUG?.includes("worker") ||
							process.env.DEBUG === "true" ||
							process.env.NODE_ENV === "development"
						) {
							log.debug(
								`ZAI token/s calculation: ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (using total response time: ${responseTime}ms)`,
							);
						}
					} else {
						// For other providers (like Anthropic), use streaming duration if available
						if (state.firstTokenTimestamp && state.lastTokenTimestamp) {
							const streamingDurationMs =
								state.lastTokenTimestamp - state.firstTokenTimestamp;
							const streamingDurationSec = streamingDurationMs / 1000;

							if (streamingDurationMs > 0) {
								// Use streaming duration for generation speed
								state.usage.tokensPerSecond =
									finalOutputTokens / streamingDurationSec;
								if (
									process.env.DEBUG?.includes("worker") ||
									process.env.DEBUG === "true" ||
									process.env.NODE_ENV === "development"
								) {
									log.info(
										`Token/s calculation (streaming): ${finalOutputTokens} tokens / ${streamingDurationSec}s = ${state.usage.tokensPerSecond} tok/s (streaming duration: ${streamingDurationMs}ms)`,
									);
								}
							} else {
								// Fallback to total response time
								state.usage.tokensPerSecond =
									finalOutputTokens / totalDurationSec;
								if (
									process.env.DEBUG?.includes("worker") ||
									process.env.DEBUG === "true" ||
									process.env.NODE_ENV === "development"
								) {
									log.info(
										`Token/s calculation (fallback): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
									);
								}
							}
						} else {
							// No streaming timestamps available, use total response time
							state.usage.tokensPerSecond =
								finalOutputTokens / totalDurationSec;
							if (
								process.env.DEBUG?.includes("worker") ||
								process.env.DEBUG === "true" ||
								process.env.NODE_ENV === "development"
							) {
								log.info(
									`Token/s calculation (no timestamps): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
								);
							}
						}
					}
				} else {
					// If response time is 0, use a very small duration
					state.usage.tokensPerSecond = finalOutputTokens / 0.001;
					if (
						process.env.DEBUG?.includes("worker") ||
						process.env.DEBUG === "true" ||
						process.env.NODE_ENV === "development"
					) {
						log.info(
							`Token/s calculation (instant): ${finalOutputTokens} tokens / 0.001s = ${state.usage.tokensPerSecond} tok/s`,
						);
					}
				}
			}
		}

		const totalInputForOutcome =
			(state.usage.inputTokens ?? 0) +
			(state.usage.cacheReadInputTokens ?? 0) +
			(state.usage.cacheCreationInputTokens ?? 0);
		const xaiCacheOutcome = cacheOutcomeFromTokens(
			state.usage.cacheReadInputTokens,
			state.usage.cacheReadInputTokensPresent === true,
			state.usage.inputTokensPresent === true ||
				state.usage.cacheReadInputTokensPresent === true
				? totalInputForOutcome
				: undefined,
		);
		if (
			startMessage.xaiCacheIdentityFingerprint &&
			startMessage.xaiCacheOfficialEndpoint === true
		) {
			const recorderSuffix = startMessage.cacheFlightRecorderConversationId
				? ` recorder=${startMessage.cacheFlightRecorderConversationId}`
				: "";
			log.info(
				`Grok cache canary ${formatXaiCacheCanary({
					requestId: startMessage.requestId,
					accountId: startMessage.accountId ?? undefined,
					accountName: startMessage.accountName ?? undefined,
					officialEndpoint: startMessage.xaiCacheOfficialEndpoint === true,
					keyPresent: startMessage.xaiCacheKeyPresent === true,
					identityFingerprint: startMessage.xaiCacheIdentityFingerprint,
					prefixFingerprint:
						startMessage.xaiCachePrefixFingerprint ?? undefined,
					cacheOutcome: xaiCacheOutcome,
					cachedTokens: state.usage.cacheReadInputTokens,
					inputTokens: state.usage.inputTokens,
				})}${recorderSuffix}`,
			);
		}

		const recorderCacheOutcome =
			xaiCacheOutcome === "fail_closed" ? "unknown" : xaiCacheOutcome;
		if (
			startMessage.cacheFlightRecorderEligible === true &&
			startMessage.cacheFlightRecorderConversationId &&
			startMessage.providerName === "xai" &&
			startMessage.xaiCacheOfficialEndpoint === true
		) {
			const recorderConversationId =
				startMessage.cacheFlightRecorderConversationId;
			const unavailableDimensions: string[] = [];
			const nativeActive =
				startMessage.cacheFlightRecorderNativeActive === true;
			if (!nativeActive || !startMessage.xaiCacheIdentityFingerprint) {
				unavailableDimensions.push("identity");
			}
			if (!startMessage.accountId) {
				unavailableDimensions.push("serving_account");
			}
			if (!nativeActive || !startMessage.xaiCachePrefixFingerprint) {
				unavailableDimensions.push("cacheable_prefix");
			}
			if (recorderCacheOutcome === "unknown") {
				unavailableDimensions.push("cache_outcome");
			}
			// Token telemetry was only actually observed for this request if a
			// provider payload set inputTokensPresent; otherwise a "0" total
			// would be an invented number, not an honestly reported one.
			const inputTokensObserved = state.usage.inputTokensPresent === true;
			if (!inputTokensObserved) {
				unavailableDimensions.push("token_accounting");
			}
			const turn: TurnEvidence = {
				// The repository allocates the durable sequence at the persistence boundary.
				sequence: 0,
				timestamp: new Date(Date.now()).toISOString(),
				...(nativeActive && startMessage.xaiCacheIdentityFingerprint
					? {
							identityFingerprint: startMessage.xaiCacheIdentityFingerprint,
						}
					: {}),
				...(startMessage.accountId
					? { servingAccountId: startMessage.accountId }
					: {}),
				...(nativeActive && startMessage.xaiCachePrefixFingerprint
					? {
							prefixFingerprint: startMessage.xaiCachePrefixFingerprint,
						}
					: {}),
				cacheOutcome: recorderCacheOutcome,
				...(inputTokensObserved
					? {
							inputTokens:
								(state.usage.inputTokens ?? 0) +
								(state.usage.cacheReadInputTokens ?? 0) +
								(state.usage.cacheCreationInputTokens ?? 0),
						}
					: {}),
				...(state.usage.cacheReadInputTokensPresent === true
					? { cachedTokens: state.usage.cacheReadInputTokens ?? 0 }
					: {}),
				completeness:
					unavailableDimensions.length === 0 ? "complete" : "partial",
				unavailableDimensions,
			};
			const accepted = this.asyncWriter.enqueue(async () => {
				try {
					await this.dbOps.appendCacheFlightRecorderTurn(
						recorderConversationId,
						turn,
					);
				} catch {
					log.warn("Cache flight recorder write failed", {
						recorderConversationId,
					});
					// The turn is irrecoverably lost, so it is dropped evidence, not
					// merely an incomplete dimension.
					try {
						await this.dbOps.markCacheFlightRecorderIncomplete(
							recorderConversationId,
							{ dropped: true },
						);
					} catch {
						// Best effort only. The writer already contains and reports failures.
					}
				}
			});
			if (!accepted) {
				log.warn("Cache flight recorder write dropped", {
					recorderConversationId,
				});
				this.markRecorderEvidenceDropped(recorderConversationId);
			}
		}

		// Update request with final data
		if (
			process.env.DEBUG?.includes("worker") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.debug(`Saving final request data for ${startMessage.requestId}`);
		}
		const projectAtEnd = state.project ?? null;
		const modelRewritten = isModelRewrite(
			startMessage.originalModel,
			startMessage.appliedModel,
		);
		const inclusivePromptTokens = state.usage.inputTokensPresent
			? (state.usage.inputTokens ?? 0) +
				(state.usage.cacheReadInputTokens ?? 0) +
				(state.usage.cacheCreationInputTokens ?? 0)
			: undefined;
		// No preliminary INSERT needed — dashboard tracks pending requests via SSE events, not DB queries.
		this.asyncWriter.enqueue(async () => {
			try {
				await this.dbOps.saveRequest(
					startMessage.requestId,
					startMessage.method,
					startMessage.path,
					startMessage.accountId,
					startMessage.responseStatus,
					msg.success,
					msg.error || null,
					responseTime,
					startMessage.failoverAttempts,
					state.usage.model
						? {
								model: state.usage.model,
								promptTokens: inclusivePromptTokens,
								completionTokens: state.usage.outputTokens,
								totalTokens: state.usage.totalTokens,
								costUsd: state.usage.costUsd,
								// Keep original breakdown for payload
								inputTokens: state.usage.inputTokens,
								outputTokens: state.usage.outputTokens,
								cacheReadInputTokens: state.usage.cacheReadInputTokens,
								cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
								tokensPerSecond: state.usage.tokensPerSecond,
							}
						: undefined,
					state.agentUsed,
					startMessage.apiKeyId || undefined,
					startMessage.apiKeyName || undefined,
					projectAtEnd,
					state.billingType,
					startMessage.comboName || null,
					// Only persist when an actual rewrite occurred — leaves both
					// columns null for the (overwhelmingly common) unchanged case
					// instead of duplicating the `model` column's value.
					modelRewritten ? startMessage.originalModel : null,
					modelRewritten ? startMessage.appliedModel : null,
					state.projectAttributionSource ?? null,
					state.agentAttributionSource ?? null,
				);
			} catch (error) {
				log.error(
					`Failed to save request for ${startMessage.requestId}:`,
					error,
				);
			}
		});

		const requestId = startMessage.requestId;
		const storePayloads = this.getStorePayloads();
		if (storePayloads) {
			// Preflight backpressure check — skip serialization entirely if the
			// writer is already overloaded. The metadata write above already
			// captured the request; only the payload is dropped.
			const estimatedRequestBytes = startMessage.requestBody?.length ?? 0;
			const estimatedResponseBytes =
				msg.responseBody?.length ?? state.chunksBytes ?? 0;
			const estimatedPayloadBytes =
				estimatedRequestBytes + estimatedResponseBytes + 2048;

			if (!this.asyncWriter.canAcceptPayload(estimatedPayloadBytes)) {
				this.asyncWriter.recordPayloadDrop(estimatedPayloadBytes);
				log.warn(
					`Backpressure: skipping payload persistence for ${requestId} (estimated_bytes=${estimatedPayloadBytes})`,
				);
			} else {
				// Save payload - eagerly serialize to break closure references
				let responseBody: string | null = null;

				if (msg.responseBody) {
					// Non-streaming response
					responseBody = msg.responseBody;
				} else if (state.chunks.length > 0) {
					// Streaming response - combine chunks
					const combined = combineChunks(state.chunks);
					if (combined.length > 0) {
						responseBody = combined.toString("base64");
					}
				}

				// Cap request body to prevent unbounded payload storage
				let requestBody = startMessage.requestBody;
				if (requestBody) {
					const rawBytes = Buffer.byteLength(requestBody, "base64");
					if (rawBytes > MAX_REQUEST_BODY_BYTES) {
						requestBody = Buffer.from(requestBody, "base64")
							.subarray(0, MAX_REQUEST_BODY_BYTES)
							.toString("base64");
					}
				}

				const payloadJson = JSON.stringify({
					request: {
						headers: startMessage.requestHeaders,
						body: requestBody,
					},
					response: {
						status: startMessage.responseStatus,
						headers: startMessage.responseHeaders,
						body: responseBody,
					},
					meta: {
						accountId: startMessage.accountId || NO_ACCOUNT_ID,
						timestamp: startMessage.timestamp,
						success: msg.success,
						isStream: startMessage.isStream,
						retry: startMessage.retryAttempt,
						project: state.project ?? undefined,
						projectAttributionSource:
							state.projectAttributionSource ?? undefined,
					},
				});

				// Null out large references now that we have the serialized JSON
				responseBody = null;

				const payloadBytes = Buffer.byteLength(payloadJson);
				const accepted = this.asyncWriter.enqueuePayload(
					requestId,
					payloadBytes,
					async () => {
						try {
							await this.dbOps.saveRequestPayloadRaw(requestId, payloadJson);
						} catch (error) {
							log.error(`Failed to save payload for ${requestId}:`, error);
						}
					},
				);
				if (!accepted) {
					log.warn(
						`Payload write rejected post-serialization for ${requestId} (bytes=${payloadBytes})`,
					);
				}
			}
		}
		freeRequestState(state);

		// Log if we have usage
		if (state.usage.model && startMessage.accountId !== NO_ACCOUNT_ID) {
			if (
				process.env.DEBUG?.includes("worker") ||
				process.env.DEBUG === "true" ||
				process.env.NODE_ENV === "development"
			) {
				log.debug(
					`Usage for request ${startMessage.requestId}: Model: ${state.usage.model}, ` +
						`Tokens: ${state.usage.totalTokens || 0}, Cost: ${formatCost(state.usage.costUsd)}`,
				);
			}
		}

		// Build summary for real-time updates
		const summary: RequestResponse = {
			id: startMessage.requestId,
			timestamp: new Date(startMessage.timestamp).toISOString(),
			method: startMessage.method,
			path: startMessage.path,
			accountUsed: startMessage.accountId,
			statusCode: startMessage.responseStatus,
			success: msg.success,
			errorMessage: msg.error || null,
			responseTimeMs: responseTime,
			failoverAttempts: startMessage.failoverAttempts,
			model: state.usage.model,
			promptTokens: inclusivePromptTokens,
			completionTokens: state.usage.outputTokens,
			totalTokens: state.usage.totalTokens,
			inputTokens: state.usage.inputTokens,
			cacheReadInputTokens: state.usage.cacheReadInputTokens,
			cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
			outputTokens: state.usage.outputTokens,
			costUsd: state.usage.costUsd,
			agentUsed: state.agentUsed,
			tokensPerSecond: state.usage.tokensPerSecond,
			apiKeyId: startMessage.apiKeyId || undefined,
			apiKeyName: startMessage.apiKeyName || undefined,
			project: state.project ?? undefined,
			billingType: state.billingType,
			originalModel: startMessage.originalModel || undefined,
			appliedModel: startMessage.appliedModel || undefined,
			comboName: startMessage.comboName || undefined,
			projectAttributionSource: state.projectAttributionSource ?? undefined,
			agentAttributionSource: state.agentAttributionSource ?? undefined,
		};

		// Notify cacheBodyStore and emit summary for real-time updates
		cacheBodyStore.onSummary(
			startMessage.requestId,
			state.usage.cacheCreationInputTokens,
			msg.success,
			state.usage.cacheReadInputTokens,
		);
		this.onSummary(summary);
	}

	/**
	 * Buffer irrecoverably lost recorder evidence for a bounded, off-path
	 * flush. This runs exactly when the queue is saturated or state is
	 * force-evicted; it deliberately bypasses the AsyncDbWriter because
	 * routing the marker through the same rejected queue would hide the
	 * loss from health counts. The buffer itself never performs a DB call
	 * on the request path: drops are coalesced per conversation ID in
	 * memory and written by flushPendingDroppedMarkers() on a debounce
	 * timer (or immediately, sequentially, during drain()).
	 */
	private markRecorderEvidenceDropped(recorderConversationId: string): void {
		const current = this.pendingDroppedMarkers.get(recorderConversationId);
		if (current === undefined) {
			if (this.pendingDroppedMarkers.size >= MAX_PENDING_DROPPED_MARKERS) {
				this.pendingDroppedMarkerOverflowCount++;
				log.warn(
					"Dropped recorder evidence marker buffer full; losing marker",
					{
						recorderConversationId,
						bufferCap: MAX_PENDING_DROPPED_MARKERS,
						lostSinceStart: this.pendingDroppedMarkerOverflowCount,
					},
				);
				return;
			}
			this.pendingDroppedMarkers.set(recorderConversationId, 1);
		} else {
			this.pendingDroppedMarkers.set(recorderConversationId, current + 1);
		}
		this.schedulePendingMarkerFlush();
	}

	/** Debounce successive drops into one flush pass instead of a timer per drop. */
	private schedulePendingMarkerFlush(): void {
		if (this.pendingMarkerFlushTimer) return;
		this.pendingMarkerFlushTimer = setTimeout(() => {
			this.pendingMarkerFlushTimer = null;
			this.pendingMarkerFlushInFlight =
				this.flushPendingDroppedMarkers().finally(() => {
					this.pendingMarkerFlushInFlight = null;
				});
		}, PENDING_DROPPED_MARKER_FLUSH_MS);
		this.pendingMarkerFlushTimer.unref();
	}

	/**
	 * Take and clear the current buffer, then write each entry sequentially
	 * (await one at a time) so PostgreSQL never sees unbounded concurrency
	 * from this path. Failures are best effort: log and continue with the
	 * remaining entries, never throw.
	 */
	private async flushPendingDroppedMarkers(): Promise<void> {
		if (this.pendingDroppedMarkers.size === 0) return;
		const entries = [...this.pendingDroppedMarkers.entries()];
		this.pendingDroppedMarkers.clear();
		for (const [recorderConversationId, droppedCount] of entries) {
			try {
				await this.dbOps.markCacheFlightRecorderIncomplete(
					recorderConversationId,
					{ dropped: true, droppedCount },
				);
			} catch {
				log.warn("Failed to flush dropped recorder evidence marker", {
					recorderConversationId,
					droppedCount,
				});
				// Best effort only; never disturb the response lifecycle.
			}
		}
	}

	/**
	 * Shutdown path: cancel any pending debounce timer, wait for an
	 * in-flight flush to finish (so writes stay sequential), then flush
	 * whatever remains, including entries buffered during the wait.
	 */
	private async flushPendingDroppedMarkersNow(): Promise<void> {
		if (this.pendingMarkerFlushTimer) {
			clearTimeout(this.pendingMarkerFlushTimer);
			this.pendingMarkerFlushTimer = null;
		}
		if (this.pendingMarkerFlushInFlight) {
			await this.pendingMarkerFlushInFlight;
		}
		await this.flushPendingDroppedMarkers();
	}

	private markEvictedRecorderState(state: RequestState): void {
		const start = state.startMessage;
		if (
			start.cacheFlightRecorderEligible === true &&
			start.cacheFlightRecorderConversationId &&
			start.providerName === "xai" &&
			start.xaiCacheOfficialEndpoint === true
		) {
			this.markRecorderEvidenceDropped(start.cacheFlightRecorderConversationId);
		}
	}

	private cleanupStaleRequests(): void {
		const now = Date.now();
		let removedCount = 0;

		// 1. Remove inactive requests (orphaned). A stream may legitimately run
		// for much longer than the inactivity timeout, so lifecycle age alone must
		// never evict it while chunks (including provider pings) are still arriving.
		for (const [id, state] of this.requests) {
			const inactivity = now - state.lastActivity;
			if (inactivity > this.timeoutMs) {
				log.warn(
					`Request ${id} appears orphaned (no activity for ${Math.round(inactivity / 1000)}s), removing...`,
				);
				this.markEvictedRecorderState(state);
				freeRequestState(state);
				this.requests.delete(id);
				removedCount++;
			}
		}

		// 2. Enforce size limit by evicting oldest entries
		if (this.requests.size > MAX_REQUESTS_MAP_SIZE) {
			const excess = this.requests.size - MAX_REQUESTS_MAP_SIZE;
			const sortedByAge = Array.from(this.requests.entries()).sort(
				(a, b) => a[1].createdAt - b[1].createdAt,
			);

			log.warn(
				`Requests map size (${this.requests.size}) exceeds limit (${MAX_REQUESTS_MAP_SIZE}), evicting ${excess} oldest entries...`,
			);

			for (let i = 0; i < excess; i++) {
				const [id, state] = sortedByAge[i];
				this.markEvictedRecorderState(state);
				freeRequestState(state);
				this.requests.delete(id);
				removedCount++;
			}
		}

		if (removedCount > 0 || this.requests.size > 0) {
			log.info(
				`requests.size=${this.requests.size} after cleanup (removed=${removedCount})`,
			);
		}
	}

	private async estimateCostWithDeadline(
		requestId: string,
		model: string,
		estimate: () => Promise<number>,
	): Promise<number> {
		let timeoutHandle: Timer | undefined;
		const timeout = new Promise<number>((resolve) => {
			timeoutHandle = setTimeout(() => {
				log.warn("Pricing estimate timed out; using zero-cost fallback", {
					model,
					requestId,
					timeoutMs: this.pricingTimeoutMs,
				});
				resolve(0);
			}, this.pricingTimeoutMs);
		});

		const estimatePromise = Promise.resolve().then(estimate);
		try {
			return await Promise.race([estimatePromise, timeout]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	private warnMissingState(requestId: string): void {
		if (this.missingStateWarnings.has(requestId)) return;

		log.warn(`No state found for request ${requestId}`);
		this.missingStateWarnings.add(requestId);

		if (this.missingStateWarnings.size > MAX_MISSING_STATE_WARNINGS) {
			const oldestRequestId = this.missingStateWarnings.keys().next().value;
			if (oldestRequestId !== undefined) {
				this.missingStateWarnings.delete(oldestRequestId);
			}
		}
	}

	private startCleanupInterval(): void {
		if (!this.cleanupInterval) {
			// Run cleanup every 30 seconds
			this.cleanupInterval = setInterval(() => {
				this.cleanupStaleRequests();
			}, 30000);
			// Allow process to exit if no other work is pending
			this.cleanupInterval.unref();
		}
	}

	private stopCleanupInterval(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}
}

// Singleton — instantiated lazily by initUsageCollector()
let _usageCollector: UsageCollector | null = null;

/**
 * Initialize (or return the existing) singleton UsageCollector.
 * Must be called after initPayloadEncryption() and after DatabaseFactory
 * is set up, because it creates its own DatabaseOperations + AsyncDbWriter
 * (unless a shared instance is passed via `sharedDbOps`).
 *
 * Awaits schema setup/migrations (initializeAsync is idempotent — safe to
 * call on an already-initialized shared instance) before returning, so no
 * caller can enqueue a write against a PostgreSQL database that hasn't been
 * migrated yet.
 *
 * The `onSummary` callback is called once per completed request and should
 * emit requestEvents + drive cacheBodyStore.
 */
export async function initUsageCollector(
	getStorePayloads: () => boolean,
	onSummary: (summary: RequestResponse) => void,
	sharedDbOps?: DatabaseOperations,
): Promise<UsageCollector> {
	if (_usageCollector) return _usageCollector;

	const dbOps = sharedDbOps ?? new DatabaseOperations();
	await dbOps.initializeAsync();
	const asyncWriter = new AsyncDbWriter();

	_usageCollector = new UsageCollector(
		dbOps,
		asyncWriter,
		getStorePayloads,
		onSummary,
	);
	return _usageCollector;
}

/**
 * Returns the singleton UsageCollector. Throws if initUsageCollector() has
 * not been called yet.
 */
export function getUsageCollector(): UsageCollector {
	if (!_usageCollector) {
		throw new Error(
			"UsageCollector not initialized — call initUsageCollector() first",
		);
	}
	return _usageCollector;
}

/**
 * Returns the singleton or null if not yet initialized.
 * Use in shutdown / health paths where a pre-init call must be a no-op.
 */
export function tryGetUsageCollector(): UsageCollector | null {
	return _usageCollector;
}
