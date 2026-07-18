import { BUFFER_SIZES, SseFrameBuffer } from "@better-ccflare/core";
import { classifyAnthropicSseFrame } from "./anthropic-sse-frame-classifier";

export const ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response stalled after partial output"}}\n\n';

const encoder = new TextEncoder();
const semanticTimeoutBytes = encoder.encode(
	ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME,
);

export interface AnthropicSemanticLivenessOptions {
	/** Idle time after committed semantic output before terminating safely. */
	semanticTimeoutMs: number;
	/** Called once only for a semantic timeout, never for transport termination. */
	onTimeout?: () => void;
	onCancelError?: (error: unknown) => void;
}

function positiveInteger(value: number, optionName: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${optionName} must be a positive safe integer`);
	}
	return value;
}

/**
 * Enforce semantic (not byte) liveness after the first committed Anthropic
 * text/thinking/tool delta. Transport keepalives remain byte-identical but do
 * not postpone the deadline. The wrapper never retries or splices a response:
 * after commitment it emits one standard Anthropic error event and closes.
 */
export function createAnthropicSemanticLivenessStream(
	upstream: ReadableStream<Uint8Array>,
	options: AnthropicSemanticLivenessOptions,
): ReadableStream<Uint8Array> {
	const semanticTimeoutMs = positiveInteger(
		options.semanticTimeoutMs,
		"semanticTimeoutMs",
	);
	const reader = upstream.getReader();
	const frames = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});

	let finalized = false;
	let semanticCommitted = false;
	let semanticMonitoringEnded = false;
	let errorBoundarySeen = false;
	let parserDisabled = false;
	let remainingObservationMs = semanticTimeoutMs;
	let observationStartedAt: number | null = null;
	let livenessTimer: ReturnType<typeof setTimeout> | null = null;
	let downstreamController:
		| ReadableStreamDefaultController<Uint8Array>
		| undefined;
	let cancelPromise: Promise<void> | null = null;

	const clearLivenessTimer = (): void => {
		if (livenessTimer === null) return;
		clearTimeout(livenessTimer);
		livenessTimer = null;
	};

	const pauseActiveObservation = (): void => {
		clearLivenessTimer();
		if (observationStartedAt === null) return;
		remainingObservationMs = Math.max(
			0,
			remainingObservationMs - (performance.now() - observationStartedAt),
		);
		observationStartedAt = null;
	};

	const cancelOnce = (reason: unknown): Promise<void> => {
		if (cancelPromise) return cancelPromise;
		try {
			cancelPromise = reader.cancel(reason);
		} catch (error) {
			cancelPromise = Promise.reject(error);
		}
		return cancelPromise;
	};

	const reportTimeout = (): void => {
		try {
			options.onTimeout?.();
		} catch {
			// Routing/observability callbacks cannot corrupt the client stream.
		}
	};

	const reportCancelError = (error: unknown): void => {
		try {
			options.onCancelError?.(error);
		} catch {
			// Cleanup observability cannot interfere with the already-closed stream.
		}
	};

	const handleSemanticTimeout = (): void => {
		livenessTimer = null;
		if (
			finalized ||
			!semanticCommitted ||
			semanticMonitoringEnded ||
			observationStartedAt === null ||
			!downstreamController
		) {
			return;
		}

		observationStartedAt = null;
		remainingObservationMs = 0;
		finalized = true;
		const timeoutError = new Error(
			"Anthropic stream stopped making semantic progress after commitment",
		);
		downstreamController.enqueue(semanticTimeoutBytes.slice());
		downstreamController.close();
		reportTimeout();
		void cancelOnce(timeoutError).catch(reportCancelError);
	};

	const beginActiveObservation = (): void => {
		if (
			finalized ||
			!semanticCommitted ||
			semanticMonitoringEnded ||
			observationStartedAt !== null
		) {
			return;
		}
		observationStartedAt = performance.now();
		clearLivenessTimer();
		livenessTimer = setTimeout(
			handleSemanticTimeout,
			Math.max(0, Math.ceil(remainingObservationMs)),
		);
	};

	const inspectFrame = (frame: string): void => {
		const classification = classifyAnthropicSseFrame(frame);
		if (classification.kind === "error") {
			errorBoundarySeen = true;
			semanticMonitoringEnded = true;
			pauseActiveObservation();
			return;
		}
		if (semanticMonitoringEnded) return;

		switch (classification.kind) {
			case "meaningful":
			case "unknown":
				semanticCommitted = true;
				remainingObservationMs = semanticTimeoutMs;
				return;
			case "terminal_delta":
			case "message_stop":
				// Terminal recovery and upstream terminal events own these paths.
				// They must never be misreported as a semantic-liveness failure.
				semanticMonitoringEnded = true;
				pauseActiveObservation();
				return;
			case "keepalive":
			case "structural":
			case "malformed":
				return;
		}
	};

	const inspectChunk = (chunk: Uint8Array): void => {
		if (parserDisabled) return;
		try {
			for (const frame of frames.push(chunk)) inspectFrame(frame);
		} catch {
			// A malformed/over-policy stream remains a byte-preserving pass-through.
			// Disable enforcement rather than turning parser uncertainty into a false
			// route-health signal.
			parserDisabled = true;
			semanticMonitoringEnded = true;
			pauseActiveObservation();
		}
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			downstreamController = controller;
		},

		async pull(controller) {
			if (finalized) return;
			beginActiveObservation();
			try {
				const { value, done } = await reader.read();
				pauseActiveObservation();
				if (finalized) return;
				if (done) {
					finalized = true;
					controller.close();
					return;
				}

				controller.enqueue(value);
				inspectChunk(value);
				if (errorBoundarySeen) {
					finalized = true;
					controller.close();
					const terminalError = new Error(
						"Anthropic stream emitted a terminal SSE error event",
					);
					void cancelOnce(terminalError).catch(reportCancelError);
				}
			} catch (error) {
				pauseActiveObservation();
				if (finalized) return;
				finalized = true;
				controller.error(error);
			}
		},

		cancel(reason) {
			if (finalized) return;
			finalized = true;
			pauseActiveObservation();
			return cancelOnce(reason);
		},
	});
}
