import {
	BUFFER_SIZES,
	SseFrameBuffer,
	SseLimitError,
} from "@better-ccflare/core";
import {
	type AnthropicTransientSseErrorType,
	classifyAnthropicSseFrame,
} from "./anthropic-sse-frame-classifier";
import { ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS } from "./anthropic-terminal-recovery";

export const ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS = 120_000;
export const ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS =
	ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS;
// This is a total retention budget, distinct from either parser limit. A
// policy-valid maximum frame can arrive after structural lifecycle frames, so
// retain one frame budget plus one tail/prelude budget while keeping the total
// finite and independently operator-configurable.
export const ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES =
	BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES +
	BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES;
export const ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS = 5 * 60 * 1000;

export const ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS";
export const ANTHROPIC_TERMINAL_GRACE_ENV =
	"CCFLARE_ANTHROPIC_TERMINAL_GRACE_MS";
export const ANTHROPIC_PRE_COMMIT_MAX_BUFFER_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_MAX_BUFFER_BYTES";
export const ANTHROPIC_ROUTE_SUPPRESSION_ENV =
	"CCFLARE_ANTHROPIC_ROUTE_SUPPRESSION_MS";

const MAX_SEMANTIC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TERMINAL_GRACE_MS = 60 * 1000;
const MAX_PRE_COMMIT_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_ROUTE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

export interface AnthropicStreamRuntimeConfig {
	semanticTimeoutMs: number;
	terminalGraceMs: number;
	maxBufferedBytes: number;
	routeSuppressionMs: number;
}

export interface NativeAnthropicMessagesSseInput {
	method: string;
	path: string;
	providerName: string;
	requestHeaders: Headers;
	response: Response;
}

function boundedEnvInteger(
	name: string,
	fallback: number,
	maximum: number,
): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, maximum);
}

/**
 * Read the stream-lifecycle knobs at request time so operators can tune them
 * without rebuilding and focused tests can use deterministic short windows.
 * Invalid values fail closed to known-safe defaults; oversized values clamp to
 * finite bounds so a typo cannot retain unbounded memory or suppress a route
 * indefinitely.
 */
export function getAnthropicStreamRuntimeConfig(): AnthropicStreamRuntimeConfig {
	return {
		semanticTimeoutMs: boundedEnvInteger(
			ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV,
			ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
			MAX_SEMANTIC_TIMEOUT_MS,
		),
		terminalGraceMs: boundedEnvInteger(
			ANTHROPIC_TERMINAL_GRACE_ENV,
			ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
			MAX_TERMINAL_GRACE_MS,
		),
		maxBufferedBytes: boundedEnvInteger(
			ANTHROPIC_PRE_COMMIT_MAX_BUFFER_ENV,
			ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
			MAX_PRE_COMMIT_BUFFERED_BYTES,
		),
		routeSuppressionMs: boundedEnvInteger(
			ANTHROPIC_ROUTE_SUPPRESSION_ENV,
			ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS,
			MAX_ROUTE_SUPPRESSION_MS,
		),
	};
}

/** One shared protocol predicate for both the pre-commit gate and recovery. */
export function isNativeAnthropicMessagesSse({
	method,
	path,
	providerName,
	requestHeaders,
	response,
}: NativeAnthropicMessagesSseInput): boolean {
	return (
		method === "POST" &&
		path === "/v1/messages" &&
		providerName === "anthropic" &&
		requestHeaders.has("anthropic-version") &&
		response.ok &&
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") === true
	);
}

export type AnthropicPreCommitStallReason =
	| "semantic_timeout"
	| "terminal_grace_timeout"
	| "buffer_limit"
	| "upstream_eof"
	| "upstream_error"
	| "transient_sse_error";

export interface AnthropicPreCommitStallMetadata {
	reason: AnthropicPreCommitStallReason;
	bufferedBytes: number;
	framesSeen: number;
	terminalEvidenceSeen: boolean;
	limitBytes?: number;
	errorType?: AnthropicTransientSseErrorType;
}

/**
 * A retryable failure raised only while no upstream bytes have been exposed.
 *
 * The fields deliberately contain counts and state flags only. Upstream SSE
 * payloads can include user content and are never copied into the error.
 */
export class AnthropicPreCommitStallError extends Error {
	readonly reason: AnthropicPreCommitStallReason;
	readonly bufferedBytes: number;
	readonly framesSeen: number;
	readonly terminalEvidenceSeen: boolean;
	readonly limitBytes?: number;
	readonly errorType?: AnthropicTransientSseErrorType;

	constructor(metadata: AnthropicPreCommitStallMetadata) {
		super(
			`Anthropic stream failed before semantic commitment (${metadata.reason}; ${metadata.bufferedBytes} buffered bytes; ${metadata.framesSeen} SSE frames)`,
		);
		this.name = "AnthropicPreCommitStallError";
		this.reason = metadata.reason;
		this.bufferedBytes = metadata.bufferedBytes;
		this.framesSeen = metadata.framesSeen;
		this.terminalEvidenceSeen = metadata.terminalEvidenceSeen;
		this.limitBytes = metadata.limitBytes;
		this.errorType = metadata.errorType;
	}
}

/** A safely retryable HTTP-200 Anthropic SSE error before any bytes escaped. */
export class AnthropicPreCommitTransientError extends AnthropicPreCommitStallError {
	declare readonly errorType: AnthropicTransientSseErrorType;

	constructor(
		metadata: Omit<
			AnthropicPreCommitStallMetadata,
			"reason" | "limitBytes" | "errorType"
		>,
		errorType: AnthropicTransientSseErrorType,
	) {
		super({
			...metadata,
			reason: "transient_sse_error",
			errorType,
		});
		this.name = "AnthropicPreCommitTransientError";
	}
}

/**
 * Caller cancellation before commitment. Routing code should stop, not treat
 * this as evidence that the selected account or provider is unhealthy.
 */
export class AnthropicPreCommitAbortedError extends Error {
	readonly bufferedBytes: number;
	readonly framesSeen: number;
	readonly terminalEvidenceSeen: boolean;

	constructor(
		metadata: Omit<AnthropicPreCommitStallMetadata, "reason" | "limitBytes">,
	) {
		super("Anthropic pre-commit stream gate was aborted by the caller");
		this.name = "AnthropicPreCommitAbortedError";
		this.bufferedBytes = metadata.bufferedBytes;
		this.framesSeen = metadata.framesSeen;
		this.terminalEvidenceSeen = metadata.terminalEvidenceSeen;
	}
}

export interface AnthropicSemanticPreflightOptions {
	/** Absolute time allowed before the first content-bearing event. */
	semanticTimeoutMs?: number;
	/** Time allowed for message_stop after a terminal message_delta. */
	terminalGraceMs?: number;
	/** Hard cap on all raw bytes retained before semantic commitment. */
	maxBufferedBytes?: number;
	/** Cancel preflight without reporting a provider/account route failure. */
	signal?: AbortSignal;
}

type ByteReadResult = Awaited<
	ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

const READ_TIMEOUT = Symbol("anthropic-pre-commit-read-timeout");
const READ_ABORTED = Symbol("anthropic-pre-commit-read-aborted");

function positiveInteger(value: number, optionName: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${optionName} must be a positive safe integer`);
	}
	return value;
}

function createReleasedStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	bufferedChunks: Uint8Array[],
): ReadableStream<Uint8Array> {
	let bufferedIndex = 0;
	let finalized = false;
	let cancelPromise: Promise<void> | null = null;

	const cancelOnce = (reason: unknown): Promise<void> => {
		if (cancelPromise) return cancelPromise;
		try {
			cancelPromise = reader.cancel(reason);
		} catch (error) {
			cancelPromise = Promise.reject(error);
		}
		return cancelPromise;
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (finalized) return;
			if (bufferedIndex < bufferedChunks.length) {
				controller.enqueue(bufferedChunks[bufferedIndex++]);
				return;
			}

			try {
				const { value, done } = await reader.read();
				if (finalized) return;
				if (done) {
					finalized = true;
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				if (finalized) return;
				finalized = true;
				controller.error(error);
			}
		},

		cancel(reason) {
			if (finalized) return;
			finalized = true;
			return cancelOnce(reason);
		},
	});
}

function readBefore(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	waitMs: number,
	signal?: AbortSignal,
): Promise<ByteReadResult | typeof READ_TIMEOUT | typeof READ_ABORTED> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (
			result: ByteReadResult | typeof READ_TIMEOUT | typeof READ_ABORTED,
		): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		function onAbort(): void {
			settle(READ_ABORTED);
		}

		if (signal?.aborted) {
			settle(READ_ABORTED);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => settle(READ_TIMEOUT), Math.max(0, waitMs));
		reader.read().then(
			(result) => settle(result),
			(error: unknown) => fail(error),
		);
	});
}

/**
 * Buffer a native Anthropic SSE body until retrying it is no longer safe.
 *
 * The returned promise resolves only after a content-bearing delta (or a
 * conservative terminal/unknown boundary) is present in the buffered bytes.
 * Consequently, callers can route to another account when this function
 * rejects: no Response containing these bytes could have reached the client.
 * After resolution this module is a byte-preserving pass-through and performs
 * no retries or semantic recovery.
 */
export async function gateAnthropicSsePreCommit(
	upstream: ReadableStream<Uint8Array>,
	options: AnthropicSemanticPreflightOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const semanticTimeoutMs = positiveInteger(
		options.semanticTimeoutMs ?? ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
		"semanticTimeoutMs",
	);
	const terminalGraceMs = positiveInteger(
		options.terminalGraceMs ?? ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
		"terminalGraceMs",
	);
	const maxBufferedBytes = positiveInteger(
		options.maxBufferedBytes ?? ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
		"maxBufferedBytes",
	);

	const reader = upstream.getReader();
	const parser = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});
	const bufferedChunks: Uint8Array[] = [];
	const startedAt = Date.now();
	const semanticDeadline = startedAt + semanticTimeoutMs;

	let bufferedBytes = 0;
	let framesSeen = 0;
	let terminalEvidenceSeen = false;
	let terminalDeadline: number | undefined;
	let cancelPromise: Promise<void> | null = null;

	const metadata = (
		reason: AnthropicPreCommitStallReason,
		limitBytes?: number,
		errorType?: AnthropicTransientSseErrorType,
	): AnthropicPreCommitStallMetadata => ({
		reason,
		bufferedBytes,
		framesSeen,
		terminalEvidenceSeen,
		...(limitBytes === undefined ? {} : { limitBytes }),
		...(errorType === undefined ? {} : { errorType }),
	});

	const cancelOnce = (reason: unknown): Promise<void> => {
		if (cancelPromise) return cancelPromise;
		try {
			cancelPromise = reader.cancel(reason);
		} catch (error) {
			cancelPromise = Promise.reject(error);
		}
		return cancelPromise;
	};

	const cancelBestEffort = (reason: unknown): void => {
		void cancelOnce(reason).catch(() => {
			// Transport cleanup is best-effort. It must never delay a semantic
			// deadline or caller cancellation, including when cancel never settles.
		});
	};

	const fail = (
		reason: AnthropicPreCommitStallReason,
		limitBytes?: number,
	): never => {
		const error = new AnthropicPreCommitStallError(
			metadata(reason, limitBytes),
		);
		cancelBestEffort(error);
		throw error;
	};

	const abort = (): never => {
		const error = new AnthropicPreCommitAbortedError({
			bufferedBytes,
			framesSeen,
			terminalEvidenceSeen,
		});
		cancelBestEffort(error);
		throw error;
	};

	const failTransient = (errorType: AnthropicTransientSseErrorType): never => {
		const error = new AnthropicPreCommitTransientError(
			{
				bufferedBytes,
				framesSeen,
				terminalEvidenceSeen,
			},
			errorType,
		);
		cancelBestEffort(error);
		throw error;
	};

	const applyFrameDecision = (frame: string): boolean => {
		framesSeen += 1;
		const classification = classifyAnthropicSseFrame(frame);
		if (classification.transientErrorType) {
			return failTransient(classification.transientErrorType);
		}
		if (classification.kind === "terminal_delta") {
			terminalEvidenceSeen = true;
			terminalDeadline ??= Date.now() + terminalGraceMs;
			return false;
		}
		return (
			classification.kind === "meaningful" ||
			classification.kind === "message_stop" ||
			classification.kind === "error" ||
			classification.kind === "unknown"
		);
	};

	while (true) {
		if (options.signal?.aborted) return abort();
		// Terminal protocol evidence starts a fresh, bounded grace window. It
		// supersedes the generic semantic deadline whether that is sooner or later.
		const activeDeadline = terminalDeadline ?? semanticDeadline;
		let readResult: ByteReadResult | typeof READ_TIMEOUT | typeof READ_ABORTED;
		try {
			readResult = await readBefore(
				reader,
				activeDeadline - Date.now(),
				options.signal,
			);
		} catch {
			return fail("upstream_error");
		}

		if (readResult === READ_ABORTED) return abort();

		if (readResult === READ_TIMEOUT) {
			return fail(
				terminalDeadline === undefined
					? "semantic_timeout"
					: "terminal_grace_timeout",
			);
		}

		if (readResult.done) {
			try {
				// Validate the final bounded parser tail, but never classify it. An SSE
				// event is dispatched only after its blank-line delimiter; treating an
				// unterminated EOF tail as commitment could expose a partial event and
				// make an otherwise safe route retry impossible.
				parser.flush();
			} catch (error) {
				if (error instanceof SseLimitError) {
					return fail("buffer_limit", error.limitBytes);
				}
				return fail("upstream_error");
			}
			return fail("upstream_eof");
		}

		bufferedBytes += readResult.value.byteLength;
		if (bufferedBytes > maxBufferedBytes) {
			return fail("buffer_limit", maxBufferedBytes);
		}
		bufferedChunks.push(readResult.value.slice());

		let frames: string[];
		try {
			frames = parser.push(readResult.value);
		} catch (error) {
			if (error instanceof SseLimitError) {
				return fail("buffer_limit", error.limitBytes);
			}
			return fail("upstream_error");
		}

		if (frames.some(applyFrameDecision)) {
			return createReleasedStream(reader, bufferedChunks);
		}
	}
}
