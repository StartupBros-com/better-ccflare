import { BUFFER_SIZES, SseFrameBuffer } from "@better-ccflare/core";
import { classifyAnthropicSseFrame } from "./anthropic-sse-frame-classifier";

export const ANTHROPIC_MESSAGE_STOP_FRAME =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export const ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS = 10_000;

const encoder = new TextEncoder();
const messageStopBytes = encoder.encode(ANTHROPIC_MESSAGE_STOP_FRAME);

export type AnthropicTerminalRecoveryReason = "timeout" | "eof";

export interface AnthropicTerminalRecoveryOptions {
	/** @internal Override only in deterministic unit tests. */
	gracePeriodMs?: number;
	onRecovery?: (reason: AnthropicTerminalRecoveryReason) => void;
	onCancelError?: (
		error: unknown,
		reason: AnthropicTerminalRecoveryReason,
	) => void;
}

/**
 * Observe a native Anthropic SSE stream without rewriting its upstream bytes.
 *
 * A terminal `message_delta` carries the authoritative stop reason. Anthropic's
 * protocol follows it with `message_stop`; if that final event never arrives,
 * Claude Code waits for semantic progress until its watchdog expires. This
 * wrapper gives the upstream a short grace period, then supplies only the
 * protocol terminator that was already implied by the terminal delta.
 */
export function createAnthropicTerminalRecoveryStream(
	upstream: ReadableStream<Uint8Array>,
	options: AnthropicTerminalRecoveryOptions = {},
): ReadableStream<Uint8Array> {
	const gracePeriodMs =
		options.gracePeriodMs ?? ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS;
	const reader = upstream.getReader();
	let frames: SseFrameBuffer | null = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});

	let terminalDeltaSeen = false;
	let messageStopSeen = false;
	let recoveryDisabled = false;
	let finalized = false;
	let upstreamCancelPromise: Promise<void> | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let downstreamController:
		| ReadableStreamDefaultController<Uint8Array>
		| undefined;

	const clearRecoveryTimer = (): void => {
		if (recoveryTimer === null) return;
		clearTimeout(recoveryTimer);
		recoveryTimer = null;
	};

	const disableRecovery = (): void => {
		recoveryDisabled = true;
		terminalDeltaSeen = false;
		clearRecoveryTimer();
		// Drop the parser reference immediately. In particular, a limit failure
		// must not retain the over-policy tail for the lifetime of the stream.
		frames = null;
	};

	const cancelUpstream = (reason: unknown): Promise<void> => {
		if (upstreamCancelPromise) return upstreamCancelPromise;
		try {
			upstreamCancelPromise = reader.cancel(reason);
		} catch (error) {
			upstreamCancelPromise = Promise.reject(error);
		}
		return upstreamCancelPromise;
	};

	const reportRecovery = (reason: AnthropicTerminalRecoveryReason): void => {
		try {
			options.onRecovery?.(reason);
		} catch {
			// Observability must never interfere with client stream recovery.
		}
	};

	const reportCancelError = (
		error: unknown,
		reason: AnthropicTerminalRecoveryReason,
	): void => {
		try {
			options.onCancelError?.(error, reason);
		} catch {
			// Observability must never interfere with an already-complete stream.
		}
	};

	const appendMissingEventDelimiter = (delimiter: string): void => {
		if (delimiter && downstreamController) {
			downstreamController.enqueue(encoder.encode(delimiter));
		}
	};

	const cancelAfterForcedClose = (
		reason: AnthropicTerminalRecoveryReason,
		message: string,
	): void => {
		void cancelUpstream(new Error(message)).catch((error: unknown) => {
			reportCancelError(error, reason);
		});
	};

	const recover = (
		reason: AnthropicTerminalRecoveryReason,
		missingEventDelimiter = "",
	): void => {
		if (
			finalized ||
			messageStopSeen ||
			recoveryDisabled ||
			!downstreamController
		) {
			return;
		}

		finalized = true;
		clearRecoveryTimer();
		frames = null;
		appendMissingEventDelimiter(missingEventDelimiter);
		downstreamController.enqueue(messageStopBytes.slice());
		downstreamController.close();
		reportRecovery(reason);
		cancelAfterForcedClose(
			reason,
			`Anthropic stream recovered after missing message_stop (${reason})`,
		);
	};

	const inspectEvent = (rawEvent: string): void => {
		const classification = classifyAnthropicSseFrame(rawEvent);
		switch (classification.kind) {
			case "message_stop":
				messageStopSeen = true;
				clearRecoveryTimer();
				frames = null;
				return;
			case "error":
				// A protocol error is terminal and authoritative. Never turn it into a
				// successful-looking message_stop, even if a terminal delta came first.
				disableRecovery();
				return;
			case "terminal_delta":
				terminalDeltaSeen = true;
				armRecoveryTimer();
				return;
			case "malformed":
			case "unknown":
				// Unknown or malformed protocol bytes make semantic recovery uncertain.
				// Preserve the upstream stream verbatim and fail open.
				disableRecovery();
				return;
			case "keepalive":
			case "structural":
			case "meaningful":
				return;
		}
	};

	const takeBufferedEventDelimiter = (): string => {
		if (!frames || recoveryDisabled) return "";
		let bufferedEvent: string;
		try {
			bufferedEvent = frames.flush();
		} catch {
			disableRecovery();
			return "";
		}
		frames = null;
		if (bufferedEvent.length === 0) return "";
		inspectEvent(bufferedEvent);
		if (recoveryDisabled) return "";
		return bufferedEvent.endsWith("\r\n")
			? "\r\n"
			: bufferedEvent.endsWith("\n")
				? "\n"
				: "\n\n";
	};

	const finalizeBufferedMessageStopAtTimeout = (
		missingEventDelimiter: string,
	): void => {
		if (finalized || !downstreamController) return;
		finalized = true;
		clearRecoveryTimer();
		frames = null;
		appendMissingEventDelimiter(missingEventDelimiter);
		downstreamController.close();
		cancelAfterForcedClose(
			"timeout",
			"Anthropic stream closed after message_stop at timeout boundary",
		);
	};

	const handleRecoveryTimeout = (): void => {
		recoveryTimer = null;
		if (finalized || recoveryDisabled) return;
		const missingEventDelimiter = takeBufferedEventDelimiter();
		if (recoveryDisabled) return;
		if (messageStopSeen) {
			finalizeBufferedMessageStopAtTimeout(missingEventDelimiter);
			return;
		}
		recover("timeout", missingEventDelimiter);
	};

	const armRecoveryTimer = (): void => {
		if (
			recoveryTimer !== null ||
			finalized ||
			messageStopSeen ||
			recoveryDisabled
		) {
			return;
		}
		recoveryTimer = setTimeout(handleRecoveryTimeout, gracePeriodMs);
	};

	const inspectChunk = (chunk: Uint8Array): void => {
		if (!frames || recoveryDisabled) return;
		const activeFrames = frames;
		try {
			for (const frame of activeFrames.push(chunk)) {
				inspectEvent(frame);
				if (!frames || recoveryDisabled || messageStopSeen) break;
			}
		} catch {
			// Resource-limit and parser failures are not protocol evidence. Keep the
			// raw bytes already enqueued downstream, disable semantic recovery, and
			// release all parser-retained memory.
			disableRecovery();
		}
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			downstreamController = controller;
		},

		async pull(controller) {
			if (finalized) return;

			try {
				const { value, done } = await reader.read();
				if (finalized) return;

				if (done) {
					const missingEventDelimiter = takeBufferedEventDelimiter();
					if (terminalDeltaSeen && !messageStopSeen && !recoveryDisabled) {
						recover("eof", missingEventDelimiter);
						return;
					}

					finalized = true;
					clearRecoveryTimer();
					frames = null;
					if (messageStopSeen) {
						appendMissingEventDelimiter(missingEventDelimiter);
					}
					controller.close();
					return;
				}

				controller.enqueue(value);
				inspectChunk(value);
			} catch (error) {
				if (finalized) return;
				finalized = true;
				clearRecoveryTimer();
				frames = null;
				controller.error(error);
			}
		},

		cancel(reason) {
			if (finalized) return;
			finalized = true;
			clearRecoveryTimer();
			frames = null;
			return cancelUpstream(reason);
		},
	});
}
