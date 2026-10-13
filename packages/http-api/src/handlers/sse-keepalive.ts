export const SSE_KEEPALIVE_INTERVAL_MS = 20_000;

const PING = new TextEncoder().encode(": ping\n\n");

// Comments keep idle intermediaries alive without growing an unread queue.
// The caller owns stream/listener cleanup when enqueue fails.
export function startSseKeepalive(
	controller: ReadableStreamDefaultController<Uint8Array>,
	onFail: () => void,
): () => void {
	const timer = setInterval(() => {
		if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
		try {
			controller.enqueue(PING);
		} catch {
			clearInterval(timer);
			onFail();
		}
	}, SSE_KEEPALIVE_INTERVAL_MS);
	return () => clearInterval(timer);
}
