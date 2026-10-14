import { type RequestEvt, requestEvents } from "@better-ccflare/core";
import { startSseKeepalive } from "./sse-keepalive";

export function createRequestsStreamHandler() {
	return (req: Request): Response => {
		let writeHandler: ((data: RequestEvt) => void) | null = null;
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		let stopKeepalive: (() => void) | null = null;
		let isClosed = false;
		const handleAbort = () => cleanup();
		const cleanup = () => {
			if (isClosed) return;
			isClosed = true;
			stopKeepalive?.();
			stopKeepalive = null;
			if (writeHandler) {
				requestEvents.off("event", writeHandler);
				writeHandler = null;
			}
			req.signal.removeEventListener("abort", handleAbort);
			try {
				controller?.close();
			} catch {
				// The consumer may already have cancelled the stream.
			}
		};

		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				if (req.signal.aborted) {
					cleanup();
					return;
				}
				req.signal.addEventListener("abort", handleAbort);
				const encoder = new TextEncoder();
				writeHandler = (data: RequestEvt) => {
					if (isClosed) return;
					try {
						streamController.enqueue(
							encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
						);
					} catch {
						cleanup();
					}
				};
				try {
					streamController.enqueue(
						encoder.encode("event: connected\ndata: ok\n\n"),
					);
				} catch {
					cleanup();
					return;
				}
				requestEvents.on("event", writeHandler);
				stopKeepalive = startSseKeepalive(streamController, cleanup);
			},
			cancel: cleanup,
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"Cache-Control": "no-cache",
			},
		});
	};
}
