import { BUFFER_SIZES } from "@better-ccflare/core";

/**
 * Tees a ReadableStream to capture data without blocking the original stream.
 * Allows buffering stream content for analytics while maintaining streaming performance.
 */
export function teeStream(
	upstream: ReadableStream<Uint8Array>,
	options: {
		onChunk?: (chunk: Uint8Array) => void;
		onClose?: (buffered: Uint8Array[]) => void;
		onError?: (error: Error) => void;
		onCancel?: (reason: unknown) => void;
		maxBytes?: number; // Max bytes to buffer (default: 1MB)
	} = {},
): ReadableStream<Uint8Array> {
	const {
		onChunk,
		onClose,
		onError,
		onCancel,
		maxBytes = BUFFER_SIZES.STREAM_TEE_MAX_BYTES,
	} = options;
	const reader = upstream.getReader();
	const buffered: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;
	let terminalState: "active" | "closed" | "errored" | "cancelled" = "active";

	const runTerminalCallback = (callback: () => void): void => {
		try {
			callback();
		} catch {
			// Analytics callbacks must not change or block stream termination.
		}
	};

	return new ReadableStream({
		async pull(controller) {
			try {
				const { value, done } = await reader.read();
				if (terminalState !== "active") return;

				if (done) {
					terminalState = "closed";
					runTerminalCallback(() => onClose?.(buffered));
					controller.close();
					return;
				}

				// Pass through to client immediately
				controller.enqueue(value);

				// Buffer for analytics if under limit
				if (!truncated && totalBytes + value.length <= maxBytes) {
					buffered.push(value);
					totalBytes += value.length;
				} else if (!truncated) {
					truncated = true;
					// Still buffer this chunk partially to reach exactly maxBytes
					const remaining = maxBytes - totalBytes;
					if (remaining > 0) {
						buffered.push(value.slice(0, remaining));
						totalBytes = maxBytes;
					}
				}

				// Notify chunk handler
				onChunk?.(value);
			} catch (error) {
				if (terminalState !== "active") return;
				terminalState = "errored";
				runTerminalCallback(() => onError?.(error as Error));
				controller.error(error);
			}
		},

		cancel(reason) {
			if (terminalState !== "active") return;
			terminalState = "cancelled";
			runTerminalCallback(() => onCancel?.(reason));
			// FORK DIVERGENCE from upstream 50ec29ba8d (which drains to `done`
			// here instead of cancelling): in this fork, teeStream wraps the
			// semantic-liveness / terminal-recovery stream chain, not the raw
			// fetch body. Propagating reader.cancel(reason) is load-bearing:
			// (1) it runs createAnthropicTerminalRecoveryStream's cancel()
			// handler, which records streamTerminalState="client_cancelled"
			// (response-handler.ts's onCancel comment documents this contract),
			// and (2) it tears down a STALLED upstream during stall-recovery,
			// where the client is still connected so upstream's drain — bounded
			// only by the fetch abort signal — would hang forever holding the
			// connection. Upstream's Bun cancel-leak rationale (oven-sh/bun#35093)
			// applies to raw fetch bodies; releasing the raw body is the
			// responsibility of the innermost wrapper in this fork's chain.
			// One piece of upstream's change IS adopted: teardown must not
			// throw, so a rejection from cancelling an already-errored inner
			// stream is swallowed rather than propagated.
			return reader.cancel(reason).catch(() => {});
		},
	});
}

/**
 * Combines buffered chunks into a single Buffer
 */
export function combineChunks(chunks: Uint8Array[]): Buffer {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const combined = Buffer.allocUnsafe(totalLength);
	let offset = 0;

	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}

	return combined;
}
