import { sseResponse } from "@better-ccflare/http-common";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (req: Request): Response => {
		if (req.signal.aborted) {
			return sseResponse(
				new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
			);
		}

		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		let handleLogEvent: ((event: LogEvent) => void) | null = null;
		let cleanedUp = false;
		const handleAbort = () => cleanup();

		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;

			if (handleLogEvent) {
				logBus.off("log", handleLogEvent);
				handleLogEvent = null;
			}
			req.signal.removeEventListener("abort", handleAbort);
			try {
				controller?.close();
			} catch {
				// The consumer may already have cancelled the stream.
			}
		};

		req.signal.addEventListener("abort", handleAbort);

		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				const encoder = new TextEncoder();

				handleLogEvent = (event: LogEvent) => {
					if (cleanedUp) return;
					try {
						streamController.enqueue(
							encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
						);
					} catch {
						cleanup();
					}
				};

				try {
					streamController.enqueue(
						encoder.encode(`data: ${JSON.stringify({ connected: true })}\n\n`),
					);
				} catch {
					cleanup();
					return;
				}
				logBus.on("log", handleLogEvent);
			},
			cancel() {
				cleanup();
			},
		});

		return sseResponse(stream);
	};
}
