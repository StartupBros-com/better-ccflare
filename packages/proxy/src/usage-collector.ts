import {
	BUFFER_SIZES,
	type CacheFlightCohortSealReceipt,
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
// Cycle-free subpath (see packages/types/src/request.ts header) — same guard
// the REST handler uses, so both write surfaces narrow identically.
import { toStreamTerminalState } from "@better-ccflare/types/request";
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
	resolveComboModelOverride,
	type StartMessage,
} from "./worker-messages";

interface UsageIteration {
	type: string | undefined;
	model: string | undefined;
	input_tokens: number | undefined;
	output_tokens: number | undefined;
	cache_read_input_tokens: number | undefined;
	cache_creation_input_tokens: number | undefined;
}

interface RequestState {
	startMessage: StartMessage;
	cacheFlightCohortSealReceipt?: CacheFlightCohortSealReceipt | null;
	buffer: string;
	streamDecoder: TextDecoder;
	chunks: Uint8Array[];
	chunksBytes: number;
	chunksTruncated: boolean;
	usagePayloadSeq?: number;
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
		iterations?: UsageIteration[];
		iterationsSeq?: number;
		fallbackIterationSeen?: boolean;
		fallbackIterationModel?: string;
		iterationsTruncated?: boolean;
		// Per-model token aggregate built while scanning the FULL raw
		// iterations array (not just the retained/capped slice), so a
		// truncated snapshot can still be priced without silently dropping
		// advisor spend. Complete-snapshot state: replaced wholesale by a
		// later snapshot exactly like `iterations`, cleared in
		// freeRequestState. `count` tracks how many billable raw iterations
		// fell into each bucket, used to size the model-less (UNRESOLVED_
		// MODEL_KEY) bucket for the attribution-ambiguity flag (Fix 2).
		iterationsAggregate?: Map<
			string,
			{
				input: number;
				output: number;
				cacheRead: number;
				cacheCreation: number;
				count: number;
			}
		>;
		iterationsAggregateUsable?: boolean;
		// Distinct non-empty model strings observed on ANY raw iteration entry,
		// regardless of output_tokens — unlike iterationsAggregate, a
		// zero-output modeled attempt (e.g. a declined primary) still counts
		// here. Built over the FULL raw array in the same loop as the billing
		// aggregate. Complete-snapshot state: replaced wholesale by a later
		// snapshot exactly like `iterations`, cleared in freeRequestState.
		// Bounded by MAX_BILLING_MODELS; overflow sets
		// observedIterationModelsUsable to false rather than growing.
		observedIterationModels?: Set<string>;
		observedIterationModelsUsable?: boolean;
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
	fallbackBlockSeen?: boolean;
	fallbackFromModel?: string;
	servingModelAuthoritative?: boolean;
	// usagePayloadSeq recorded at the moment a fallback signal rewrites
	// state.usage.model (either the streaming content-block site or the
	// non-stream content[] scan site). If no later usage payload arrives
	// after that rewrite, the retained counters are stale-model attempts
	// that were never actually billed at the new model's rate.
	fallbackModelRewriteSeq?: number;
	// Model that owned state.usage counters immediately before the fallback
	// rewrite recorded by fallbackModelRewriteSeq. A chained rewrite within
	// the same usage-payload epoch (e.g. FABLE->HAIKU->OPUS with no usage
	// payload between them) must not overwrite this — it always names the
	// FIRST pre-rewrite model, which is the model the retained counters
	// were actually produced under.
	countersOwnerModel?: string;
	// Sequence mirroring usagePayloadSeq: incremented once per REAL
	// (non-fallback) content_block_start. content_block_delta never updates
	// state.usage.outputTokens (tiktoken-based per-delta counting was
	// removed), so this is the only categorical signal that genuine
	// billable content streamed at all.
	realContentBlockSeq?: number;
	// realContentBlockSeq snapshotted at the moment of the most recent usage
	// payload. If realContentBlockSeq has advanced past this value by
	// finalization, real content streamed that no usage payload has
	// accounted for since.
	realContentBlockSeqAtLastUsagePayload?: number;
}

const log = new Logger("UsageCollector");

// Limits to prevent unbounded growth
const MAX_REQUESTS_MAP_SIZE = 10000;
const MAX_MISSING_STATE_WARNINGS = 1000;
const DEFAULT_PRICING_TIMEOUT_MS = 5_000;
const MAX_PRICING_TIMEOUT_MS = 60_000;
const MAX_USAGE_ITERATIONS = 64;
// Distinct-model cap for the billing aggregate built alongside a (possibly
// truncated) iterations snapshot. Bounds the aggregate Map's growth
// independent of MAX_USAGE_ITERATIONS; exceeding it marks the aggregate
// unusable rather than growing unboundedly.
const MAX_BILLING_MODELS = 16;
// Aggregate bucket key for iteration entries with no model field (e.g.
// compaction), matching the `iteration.model ?? model` serving-model rule.
const UNRESOLVED_MODEL_KEY = "<unresolved>";
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

function normalizeNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function captureUsageIterations(usage: unknown, state: RequestState): void {
	if (!usage || typeof usage !== "object") return;
	const rawIterations = (usage as Record<string, unknown>).iterations;
	if (!Array.isArray(rawIterations)) return;
	if (rawIterations.length > MAX_USAGE_ITERATIONS) {
		log.warn("Usage iterations exceeded limit; truncating", {
			requestId: state.startMessage.requestId,
			observedLength: rawIterations.length,
			maxIterations: MAX_USAGE_ITERATIONS,
		});
	}

	const iterations: UsageIteration[] = [];
	let fallbackIterationSeen = false;
	let fallbackIterationModel: string | undefined;
	// Per-model billing aggregate, built over the FULL raw array (not just
	// the retained/capped slice) so a truncated snapshot never loses billing
	// accuracy. Only entries that actually produced output are billable —
	// pre-output declines stay free, matching the split-pricing predicate.
	const billingAggregate = new Map<
		string,
		{
			input: number;
			output: number;
			cacheRead: number;
			cacheCreation: number;
			count: number;
		}
	>();
	let billingAggregateUsable = true;
	// Every distinct non-empty model string seen on ANY entry, regardless of
	// output_tokens — a zero-output modeled attempt (e.g. a declined primary)
	// is still a model that participated, so it must raise this count even
	// though it never enters billingAggregate above. Bounded by the same
	// MAX_BILLING_MODELS cap; overflow marks the set unusable rather than
	// growing it, and the ambiguity check below fails toward flagging on that
	// overflow instead of trusting an undercounted tally.
	const observedIterationModels = new Set<string>();
	let observedIterationModelsUsable = true;
	for (const rawIteration of rawIterations) {
		if (
			!rawIteration ||
			typeof rawIteration !== "object" ||
			Array.isArray(rawIteration)
		) {
			continue;
		}
		const raw = rawIteration as Record<string, unknown>;
		if (raw.type === "fallback_message") {
			fallbackIterationSeen = true;
			const model = normalizeNonEmptyString(raw.model);
			if (model) fallbackIterationModel = model;
		}
		const model = normalizeNonEmptyString(raw.model);
		if (model && !observedIterationModels.has(model)) {
			if (observedIterationModels.size >= MAX_BILLING_MODELS) {
				observedIterationModelsUsable = false;
			} else {
				observedIterationModels.add(model);
			}
		}
		const outputTokens = normalizeTokenCount(raw.output_tokens);
		if ((outputTokens ?? 0) > 0) {
			const key = model ?? UNRESOLVED_MODEL_KEY;
			let bucket = billingAggregate.get(key);
			if (!bucket) {
				if (billingAggregate.size >= MAX_BILLING_MODELS) {
					billingAggregateUsable = false;
				} else {
					bucket = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheCreation: 0,
						count: 0,
					};
					billingAggregate.set(key, bucket);
				}
			}
			if (bucket) {
				bucket.input += normalizeTokenCount(raw.input_tokens) ?? 0;
				bucket.output += outputTokens ?? 0;
				bucket.cacheRead +=
					normalizeTokenCount(raw.cache_read_input_tokens) ?? 0;
				bucket.cacheCreation +=
					normalizeTokenCount(raw.cache_creation_input_tokens) ?? 0;
				bucket.count += 1;
			}
		}

		if (iterations.length >= MAX_USAGE_ITERATIONS) continue;
		iterations.push({
			type: typeof raw.type === "string" ? raw.type : undefined,
			model,
			input_tokens: normalizeTokenCount(raw.input_tokens),
			output_tokens: outputTokens,
			cache_read_input_tokens: normalizeTokenCount(raw.cache_read_input_tokens),
			cache_creation_input_tokens: normalizeTokenCount(
				raw.cache_creation_input_tokens,
			),
		});
	}

	// Each provider payload is a complete snapshot. A later array supersedes
	// the earlier one, including when every later entry is invalid.
	state.usage.iterations = iterations;
	state.usage.iterationsSeq = state.usagePayloadSeq;
	state.usage.fallbackIterationSeen = fallbackIterationSeen;
	state.usage.fallbackIterationModel = fallbackIterationModel;
	state.usage.iterationsTruncated = rawIterations.length > MAX_USAGE_ITERATIONS;
	state.usage.iterationsAggregate = billingAggregate;
	state.usage.iterationsAggregateUsable = billingAggregateUsable;
	state.usage.observedIterationModels = observedIterationModels;
	state.usage.observedIterationModelsUsable = observedIterationModelsUsable;
}

// Extract usage data from non-stream JSON response bodies
function extractUsageFromJson(
	json: {
		model?: string;
		content?: unknown;
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens?: number;
			iterations?: unknown;
		};
	},
	state: RequestState,
): void {
	if (!json) return;
	const normalizedModel = normalizeNonEmptyString(json.model);
	if (Array.isArray(json.content)) {
		for (const rawContentBlock of json.content) {
			if (
				!rawContentBlock ||
				typeof rawContentBlock !== "object" ||
				Array.isArray(rawContentBlock)
			) {
				continue;
			}
			const contentBlock = rawContentBlock as Record<string, unknown>;
			if (contentBlock.type !== "fallback") continue;

			state.fallbackBlockSeen = true;
			const from = contentBlock.from;
			const to = contentBlock.to;
			const fromModel = normalizeNonEmptyString(
				from && typeof from === "object" && !Array.isArray(from)
					? (from as Record<string, unknown>).model
					: undefined,
			);
			const toModel = normalizeNonEmptyString(
				to && typeof to === "object" && !Array.isArray(to)
					? (to as Record<string, unknown>).model
					: undefined,
			);
			if (fromModel) state.fallbackFromModel = fromModel;
			if (toModel && !normalizedModel) {
				state.usage.model = toModel;
				// Sequence-guard site 2 (non-stream): record the seq at the
				// moment of the rewrite. If no later usage payload arrives to
				// advance usagePayloadSeq past this value, the pricing branch
				// treats the retained counters as pre-output and refuses to
				// price them at the new model's rate.
				state.fallbackModelRewriteSeq = state.usagePayloadSeq;
			}
		}
	}

	const usageObj = json.usage;
	if (!usageObj) return;

	state.usagePayloadSeq = (state.usagePayloadSeq ?? 0) + 1;
	captureUsageIterations(usageObj, state);
	// The non-stream response model is authoritative over both fallback signals.
	state.usage.model = normalizedModel ?? state.usage.model;
	if (normalizedModel) {
		state.servingModelAuthoritative = true;
	}

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
		let usagePayloadCounted = false;
		const countUsagePayload = () => {
			if (usagePayloadCounted) return;
			usagePayloadCounted = true;
			state.usagePayloadSeq = (state.usagePayloadSeq ?? 0) + 1;
			// Snapshot the real-content sequence at the moment this usage
			// payload lands, so finalization can tell whether any real
			// content streamed AFTER the last payload that could have
			// accounted for it.
			state.realContentBlockSeqAtLastUsagePayload =
				state.realContentBlockSeq ?? 0;
		};

		// Handle message_start - check both parsed.type and eventType
		// (Some providers put type in event line, Anthropic puts it in JSON)
		const isMessageStart =
			parsed.type === "message_start" || eventType === "message_start";
		if (isMessageStart) {
			if (parsed.message?.usage) {
				const usage = parsed.message.usage;
				countUsagePayload();
				captureUsageIterations(usage, state);
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

		const isContentBlockStart =
			parsed.type === "content_block_start" ||
			eventType === "content_block_start";

		const isFallbackContentBlock =
			isContentBlockStart && parsed.content_block?.type === "fallback";

		// Track streaming start time on first content block. A fallback seam
		// is itself a content_block_start/stop pair with no deltas (per
		// Anthropic's streaming docs), so it must not start the clock — doing
		// so deflates tokensPerSecond by counting handoff latency as
		// generation time.
		if (
			isContentBlockStart &&
			!isFallbackContentBlock &&
			!state.firstTokenTimestamp
		) {
			state.firstTokenTimestamp = Date.now();
		}

		// Real (non-fallback) content blocks carry no usage of their own —
		// content_block_delta never updates state.usage.outputTokens — so
		// this sequence is the only signal that genuine billable content
		// streamed at all. Compared against
		// realContentBlockSeqAtLastUsagePayload at finalization to detect
		// content that no usage payload has accounted for.
		if (isContentBlockStart && !isFallbackContentBlock) {
			state.realContentBlockSeq = (state.realContentBlockSeq ?? 0) + 1;
		}

		if (isFallbackContentBlock) {
			state.fallbackBlockSeen = true;
			const fromModel = normalizeNonEmptyString(
				parsed.content_block.from?.model,
			);
			const toModel = normalizeNonEmptyString(parsed.content_block.to?.model);
			if (fromModel) state.fallbackFromModel = fromModel;
			if (toModel) {
				if (state.fallbackModelRewriteSeq !== state.usagePayloadSeq) {
					// First rewrite since counters were last refreshed by a
					// usage payload: capture the model that actually owns the
					// CURRENT counters before it is overwritten below. A later
					// rewrite in the same epoch (chained fallback) must not
					// clobber this — the counters still belong to the FIRST
					// pre-rewrite model.
					state.countersOwnerModel = state.usage.model;
				}
				state.usage.model = toModel;
				// Sequence-guard site 1 (streaming): mirror of the non-stream
				// site above. See its comment for the pricing consequence.
				state.fallbackModelRewriteSeq = state.usagePayloadSeq;
			}
		}

		// Handle message_delta - check both parsed.type and eventType
		const isMessageDelta =
			parsed.type === "message_delta" || eventType === "message_delta";
		if (isMessageDelta) {
			state.lastTokenTimestamp = Date.now();

			if (parsed.usage) {
				countUsagePayload();
				captureUsageIterations(parsed.usage, state);
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
			countUsagePayload();
			captureUsageIterations(parsed.usage, state);
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
	state.usage.iterations = undefined;
	state.usage.iterationsSeq = undefined;
	state.usage.fallbackIterationSeen = undefined;
	state.usage.fallbackIterationModel = undefined;
	state.usage.iterationsTruncated = undefined;
	state.usage.iterationsAggregate = undefined;
	state.usage.iterationsAggregateUsable = undefined;
	state.usage.observedIterationModels = undefined;
	state.usage.observedIterationModelsUsable = undefined;
	state.usagePayloadSeq = undefined;
	state.fallbackBlockSeen = undefined;
	state.fallbackFromModel = undefined;
	state.servingModelAuthoritative = undefined;
	state.fallbackModelRewriteSeq = undefined;
	state.countersOwnerModel = undefined;
	state.realContentBlockSeq = undefined;
	state.realContentBlockSeqAtLastUsagePayload = undefined;
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
			cacheFlightCohortSealReceipt: msg.cacheFlightCohortSealReceipt ?? null,
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

		// The streaming message_start names the REQUESTED model; a fallback content
		// block or a fallback_message iteration names the model that actually served.
		// A non-stream body's top-level model is already the serving model, so it wins.
		if (
			state.servingModelAuthoritative !== true &&
			state.fallbackBlockSeen !== true &&
			state.usage.fallbackIterationModel
		) {
			state.usage.model = state.usage.fallbackIterationModel;
		}

		// Calculate total tokens and cost
		const iterations = state.usage.iterations ?? [];
		const hasFallbackSignal =
			state.fallbackBlockSeen === true ||
			state.usage.fallbackIterationSeen === true;
		const iterationsStale = state.usage.iterationsSeq !== state.usagePayloadSeq;
		const hasFallbackBillingSplit =
			hasFallbackSignal &&
			iterations.length > 0 &&
			state.usage.iterationsTruncated !== true &&
			!iterationsStale;
		// Anthropic does not bill an iteration that declined before producing
		// any output: its tokens are reported on its usage.iterations entry
		// but never charged ("Refusals and fallback" docs). This holds
		// regardless of type/chain position/stop_reason, including the
		// terminal entry of a fully-refused chain — so exclude every
		// zero/undefined-output iteration from the split price. A
		// mid-output decline is still billed for what it actually produced.
		const billableIterations = hasFallbackBillingSplit
			? iterations.filter((iteration) => (iteration.output_tokens ?? 0) > 0)
			: undefined;
		// Top-level usage fields reflect executor tokens only — advisor_message
		// iterations are billed at a different rate and are never rolled into
		// the top level (Anthropic advisor-tool docs). When the retained
		// per-iteration snapshot was truncated (>MAX_USAGE_ITERATIONS), the
		// per-model aggregate built alongside it (over the FULL raw array) is
		// the only way to avoid silently dropping that spend.
		const canPriceFromAggregate =
			hasFallbackSignal &&
			!hasFallbackBillingSplit &&
			state.usage.iterationsTruncated === true &&
			state.usage.iterationsAggregateUsable === true &&
			!iterationsStale;
		// A fallback rewrite with no later usage payload means the retained
		// counters were never refreshed for the new model. Whether that is a
		// genuine $0 or real (under-tracked) spend depends on what actually
		// happened before the request ended — see the sub-conditions below.
		const isFallbackSeamNoLaterUsage =
			hasFallbackSignal &&
			!hasFallbackBillingSplit &&
			!canPriceFromAggregate &&
			state.fallbackModelRewriteSeq !== undefined &&
			state.fallbackModelRewriteSeq === state.usagePayloadSeq;
		// message_start.usage.output_tokens is routinely a nonzero PLACEHOLDER
		// (Anthropic's streaming docs show small values like 1-3 before any
		// real content), and content_block_delta NEVER updates
		// state.usage.outputTokens (tiktoken-based per-delta counting was
		// removed) — so "outputTokens > 0" cannot distinguish real streamed
		// content from a placeholder. realContentBlockSeq is the only
		// categorical signal for "something real happened here."
		const seamRealContentUnaccounted =
			isFallbackSeamNoLaterUsage &&
			(state.realContentBlockSeq ?? 0) >
				(state.realContentBlockSeqAtLastUsagePayload ?? 0);
		const seamHasBillableCounters =
			isFallbackSeamNoLaterUsage &&
			((state.usage.inputTokens ?? 0) > 0 ||
				(state.usage.cacheReadInputTokens ?? 0) > 0 ||
				(state.usage.cacheCreationInputTokens ?? 0) > 0 ||
				(state.usage.outputTokens ?? 0) > 0);
		// Genuine no-content case: nothing streamed and nothing counted — a
		// real $0, not a guess. Narrower than before: a fallback rewrite with
		// billable counters or unaccounted real content now prices below
		// instead of being zeroed out.
		const isUnpricedPreOutputFallback =
			isFallbackSeamNoLaterUsage &&
			!seamRealContentUnaccounted &&
			!seamHasBillableCounters;
		// The seam produced something real (billable counters and/or
		// unaccounted real content): price the authoritative input/cache
		// tokens at the model that actually owned them (pre-rewrite), never
		// at the fallback target and never at $0 (see Fix 1).
		const isFallbackSeamPricedAtCountersOwner =
			isFallbackSeamNoLaterUsage && !isUnpricedPreOutputFallback;
		// Fix 2 — model-less iteration entries (e.g. BetaCompactionIterationUsage)
		// carry no `model` field at all, unlike message/advisor/fallback_message
		// entries. Anthropic's docs are silent on which model a model-less
		// entry belongs to when more than one model is in play (a mid-request
		// compaction between a declined attempt and a fallback_message could
		// belong to either side) — so no positional "activeModel" cursor is
		// implemented here; that would encode an undocumented guess into
		// billing. Instead: keep pricing model-less entries at the serving
		// model (unchanged — `iteration.model ?? model` / the aggregate's
		// UNRESOLVED_MODEL_KEY bucket), and flag the row as billingIncomplete
		// when that estimate is genuinely ambiguous. The ambiguity count comes
		// from observedIterationModels (every model seen, regardless of
		// output_tokens), NOT from billingAggregate (billable-only): a
		// zero-output modeled attempt (e.g. a declined primary) is still a
		// model that participated and could plausibly own the model-less
		// entry, so it must raise the count even though it produced nothing
		// billable. When the observed set overflowed its cap, its true
		// cardinality is unknown, so ambiguity fails open (flagged) rather
		// than trusting an undercounted tally.
		const billingAggregate = state.usage.iterationsAggregate;
		const unresolvedIterationModels =
			billingAggregate?.get(UNRESOLVED_MODEL_KEY)?.count ?? 0;
		const observedDistinctModels =
			state.usage.observedIterationModels?.size ?? 0;
		const observedIterationModelsOverflowed =
			state.usage.observedIterationModelsUsable === false;
		const iterationAttributionAmbiguous =
			unresolvedIterationModels > 0 &&
			(observedIterationModelsOverflowed || observedDistinctModels >= 2);
		// None of the accurate pricing paths applied, but an iterations
		// snapshot was seen at all: top-level pricing proceeds (unchanged
		// behavior), but the row is marked so an under-billed row is
		// identifiable rather than silently wrong. Also set whenever the
		// fallback seam left real content unaccounted for (Fix 1), or a
		// model-less entry's attribution is genuinely ambiguous (Fix 2).
		const billingIncomplete =
			(hasFallbackSignal &&
				!hasFallbackBillingSplit &&
				!canPriceFromAggregate &&
				!isFallbackSeamNoLaterUsage &&
				iterations.length > 0) ||
			seamRealContentUnaccounted ||
			iterationAttributionAmbiguous;
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

			if (hasFallbackBillingSplit) {
				state.usage.costUsd = await this.estimateCostWithDeadline(
					startMessage.requestId,
					model,
					async () => {
						const billable = billableIterations ?? [];
						if (billable.length === 0) {
							// Every iteration was a pre-output decline (a fully
							// refused chain): this genuinely costs ~$0, but it
							// must be an explicit, commented branch so a future
							// reader does not "restore" the missing sum.
							return 0;
						}
						const iterationCosts = await Promise.all(
							billable.map((iteration) =>
								estimateCostUSD(iteration.model ?? model, {
									inputTokens: iteration.input_tokens,
									outputTokens: iteration.output_tokens,
									cacheReadInputTokens: iteration.cache_read_input_tokens,
									cacheCreationInputTokens:
										iteration.cache_creation_input_tokens,
								}),
							),
						);
						return iterationCosts.reduce((total, cost) => total + cost, 0);
					},
				);
			} else if (canPriceFromAggregate) {
				const aggregate = state.usage.iterationsAggregate;
				state.usage.costUsd = await this.estimateCostWithDeadline(
					startMessage.requestId,
					model,
					async () => {
						const entries = aggregate ? Array.from(aggregate.entries()) : [];
						if (entries.length === 0) {
							// Nothing billable in the truncated snapshot (e.g. a
							// fully pre-output-declined chain): genuinely $0.
							return 0;
						}
						const modelCosts = await Promise.all(
							entries.map(([aggModel, tokens]) =>
								estimateCostUSD(
									aggModel === UNRESOLVED_MODEL_KEY ? model : aggModel,
									{
										inputTokens: tokens.input,
										outputTokens: tokens.output,
										cacheReadInputTokens: tokens.cacheRead,
										cacheCreationInputTokens: tokens.cacheCreation,
									},
								),
							),
						);
						return modelCosts.reduce((total, cost) => total + cost, 0);
					},
				);
			} else if (isUnpricedPreOutputFallback) {
				// The retained counters were never refreshed by a usage payload
				// after the fallback rewrite: they are a pre-output attempt at
				// the old model, not billable work at the new model's rate.
				// This is a direct $0, not an estimate — no estimateCostUSD call.
				state.usage.costUsd = 0;
			} else {
				// Plain top-level pricing. When a fallback seam left the
				// retained counters unrefreshed by any later usage payload
				// (isFallbackSeamPricedAtCountersOwner), those counters were
				// produced by the PRE-rewrite model, not state.usage.model
				// (which now names the fallback target) — price them at
				// countersOwnerModel instead (see Fix 1).
				const pricingModel = isFallbackSeamPricedAtCountersOwner
					? (state.countersOwnerModel ?? model)
					: model;
				state.usage.costUsd = await this.estimateCostWithDeadline(
					startMessage.requestId,
					pricingModel,
					() =>
						estimateCostUSD(pricingModel, {
							inputTokens: state.usage.inputTokens,
							outputTokens: finalOutputTokens,
							cacheReadInputTokens: state.usage.cacheReadInputTokens,
							cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
						}),
				);
			}

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

		const iterationCount = state.usage.iterations?.length ?? 0;
		if (hasFallbackSignal) {
			let fallbackFromModel = state.fallbackFromModel;
			if (!fallbackFromModel && state.usage.iterations) {
				for (let i = state.usage.iterations.length - 1; i >= 0; i--) {
					const iteration = state.usage.iterations[i];
					if (iteration.type !== "fallback_message" && iteration.model) {
						fallbackFromModel = iteration.model;
						break;
					}
				}
			}
			log.info("anthropic_server_side_fallback", {
				requestId: startMessage.requestId,
				from: fallbackFromModel ?? state.usage.model,
				to: state.usage.model,
				iterationCount,
				priced: hasFallbackBillingSplit
					? "iterations"
					: canPriceFromAggregate
						? "aggregate"
						: isUnpricedPreOutputFallback
							? "unpriced_pre_output"
							: "top_level",
				...(hasFallbackBillingSplit && billableIterations?.length === 0
					? { billableIterations: 0 }
					: {}),
				...(state.usage.iterationsTruncated === true
					? { iterationsTruncated: true }
					: {}),
				...(iterations.length > 0 && iterationsStale
					? { iterationsStale: true }
					: {}),
				...(billingIncomplete ? { billingIncomplete: true } : {}),
				...(iterationAttributionAmbiguous ? { unresolvedIterationModels } : {}),
			});
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
			const sealReceipt = state.cacheFlightCohortSealReceipt ?? null;
			const accepted = this.asyncWriter.enqueue(async () => {
				try {
					if (sealReceipt) {
						await this.dbOps.appendCacheFlightRecorderTurn(
							recorderConversationId,
							turn,
							undefined,
							sealReceipt,
						);
					} else {
						await this.dbOps.appendCacheFlightRecorderTurn(
							recorderConversationId,
							turn,
						);
					}
				} catch (error) {
					log.warn("Cache flight recorder write failed", {
						recorderConversationId,
						error: error instanceof Error ? error.message : String(error),
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
					msg.streamTerminalState ?? null,
					startMessage.clientSessionId ?? null,
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
			// Already gated in response-handler.ts (both-or-neither), but re-gate
			// here too so this object literal is never the sole place that could
			// leak a from===to or one-sided pair onto the live summary event.
			comboModelOverride: resolveComboModelOverride(
				startMessage.comboModelOverrideFrom,
				startMessage.comboModelOverrideTo,
			)
				? {
						from: startMessage.comboModelOverrideFrom as string,
						to: startMessage.comboModelOverrideTo as string,
					}
				: null,
			projectAttributionSource: state.projectAttributionSource ?? undefined,
			agentAttributionSource: state.agentAttributionSource ?? undefined,
			clientSessionId: startMessage.clientSessionId ?? undefined,
			// Same value handed to saveRequest above, so a dashboard does not have
			// to reload before a request shows its terminal state. Note this is
			// the value as REPORTED, not as persisted: the save is an
			// AsyncDbWriter job that may be dropped when the metadata queue is
			// saturated, and its own failures are logged rather than propagated —
			// so under write pressure the live summary can show a state that no
			// later /api/requests fetch will confirm. That gap predates this field
			// and applies to the whole row, not just this value.
			//
			// Narrowed with the same guard as the REST path even though the
			// producer only emits known states: both surfaces feed one field, and
			// hardening one of them is how the two drift apart.
			streamTerminalState: toStreamTerminalState(msg.streamTerminalState),
		};

		// Notify cacheBodyStore and emit summary for real-time updates
		const totalInputTokensForStaging =
			(state.usage.inputTokens ?? 0) +
			(state.usage.cacheReadInputTokens ?? 0) +
			(state.usage.cacheCreationInputTokens ?? 0);
		cacheBodyStore.onSummary(
			startMessage.requestId,
			state.usage.cacheCreationInputTokens,
			msg.success,
			state.usage.cacheReadInputTokens,
			{
				totalInputTokens: totalInputTokensForStaging,
				inputTokensPresent:
					state.usage.inputTokensPresent === true ||
					state.usage.cacheReadInputTokensPresent === true,
			},
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
