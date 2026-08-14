import { TIME_CONSTANTS } from "@better-ccflare/core";

const DRAIN_DEADLINE = Symbol("drain-deadline");
const responseDrainTransports = new WeakMap<Response, AbortController>();

export interface DrainReaderOptions {
	/** Total time allowed for this best-effort drain. */
	deadlineMs?: number;
	/** Controller for the exact fetch transport that owns this reader. */
	transportAbort?: AbortController;
}

function resolveDeadlineMs(deadlineMs: number | undefined): number {
	return deadlineMs !== undefined &&
		Number.isFinite(deadlineMs) &&
		deadlineMs >= 0
		? deadlineMs
		: TIME_CONSTANTS.STREAM_OPERATION_TIMEOUT_MS;
}

/** Associate a fetch response with the controller dedicated to that fetch. */
export function registerResponseDrainTransport(
	response: Response,
	transportAbort: AbortController,
): void {
	responseDrainTransports.set(response, transportAbort);
}

/**
 * Transfer transport ownership to a same-body or sole-owner response wrapper.
 * Never call this for a concurrent `Response.clone()` tee: its cleanup must
 * not be allowed to abort the sibling that may still be streaming to a client.
 */
export function transferResponseDrainTransport(
	source: Response,
	target: Response,
): void {
	const transportAbort = getResponseDrainTransport(source);
	if (transportAbort) {
		registerResponseDrainTransport(target, transportAbort);
	}
}

/** Return the controller for the exact fetch that produced this response. */
export function getResponseDrainTransport(
	response: Response,
): AbortController | undefined {
	return responseDrainTransports.get(response);
}

/**
 * Drain a reader to `done`, dropping each chunk. `reader.cancel()` is a
 * no-op on every released Bun (oven-sh/bun#35093) and leaks the upstream's
 * native buffer; draining actually releases it. A deadline prevents a stuck
 * source from retaining a fire-and-forget task forever. When the reader owns a
 * registered fetch transport, the deadline aborts that exact fetch before the
 * best-effort reader cancellation, so later attempts remain unaffected.
 * Errors are swallowed since this is cleanup, not caller control flow (#382).
 */
export async function drainReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: DrainReaderOptions = {},
): Promise<void> {
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadlineMs = resolveDeadlineMs(options.deadlineMs);
	const deadline = new Promise<typeof DRAIN_DEADLINE>((resolve) => {
		deadlineTimer = setTimeout(() => {
			const reason = new Error("Response drain deadline exceeded");
			options.transportAbort?.abort(reason);
			// Keep the Bun workaround as a secondary, spec-level release signal.
			// On released Bun versions this alone does not tear down fetch buffers,
			// which is why an owned transport is aborted first when available.
			try {
				void reader.cancel(reason).catch(() => undefined);
			} catch {
				// The reader may already have errored from the transport abort.
			}
			resolve(DRAIN_DEADLINE);
		}, deadlineMs);
	});

	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline]);
			if (result === DRAIN_DEADLINE || result.done) return;
		}
	} catch {
		// Swallow — draining must not throw during cleanup.
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		try {
			reader.releaseLock();
		} catch {
			// A reader without sole transport ownership (notably a clone tee) can
			// still have a pending read after Bun's no-op cancellation. Its sibling
			// may be live, so the bounded helper settles without aborting it.
		}
	}
}
