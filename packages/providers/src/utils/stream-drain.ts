import { TIME_CONSTANTS } from "@better-ccflare/core";

const DRAIN_DEADLINE = Symbol("drain-deadline");
const responseDrainTransports = new WeakMap<Response, AbortController>();

export interface DrainReaderOptions {
	/**
	 * Time allowed for this best-effort drain before deadline cleanup starts.
	 * A pending read then receives one additional, equal settlement-grace window.
	 */
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

async function awaitPendingReadSettlement(
	pendingRead: Promise<unknown>,
	graceMs: number,
): Promise<void> {
	const observedPendingRead = pendingRead.then(
		() => undefined,
		() => undefined,
	);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<void>((resolve) => {
		graceTimer = setTimeout(resolve, graceMs);
	});
	try {
		await Promise.race([observedPendingRead, grace]);
	} finally {
		if (graceTimer !== undefined) clearTimeout(graceTimer);
	}
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
export async function drainReader<T>(
	reader: ReadableStreamDefaultReader<T>,
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
			const pendingRead = reader.read();
			const result = await Promise.race([pendingRead, deadline]);
			if (result === DRAIN_DEADLINE) {
				await awaitPendingReadSettlement(pendingRead, deadlineMs);
				return;
			}
			if (result.done) return;
		}
	} catch {
		// Swallow — draining must not throw during cleanup.
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		reader.releaseLock();
	}
}

export interface DrainReaderWithDeadlineOptions {
	/**
	 * Upper bound on how long the drain will wait for `beforeDrain` (if
	 * supplied) and then for `reader.read()` before deadline cleanup starts —
	 * one deadline shared across both phases, not a fresh one per phase. On
	 * expiry, `drainAbort` (when supplied) is aborted so the underlying fetch's
	 * connection is actually torn down, then a pending read receives one
	 * additional, equal settlement-grace window before lock release.
	 */
	deadlineMs: number;
	drainAbort?: AbortController;
	/**
	 * Optional pre-step raced against the same deadline before the reader is
	 * touched (e.g. Codex reconciling an in-flight read owned by a liveness
	 * tracker, which allows at most one outstanding `reader.read()` at a
	 * time). Must resolve to let the drain proceed to the read loop; if the
	 * deadline wins the race instead, `drainAbort` is aborted and the
	 * function returns without touching the reader.
	 */
	beforeDrain?: () => Promise<void>;
	/**
	 * When true, errors from `beforeDrain`/`reader.read()` are swallowed
	 * (matches Codex's `drainUpstream`, which wraps the whole operation in
	 * try/catch since it's purely best-effort cleanup running detached from
	 * any caller that awaits it). When false (default), errors propagate to
	 * the caller (matches Anthropic's `drainUpstreamReader`, whose only
	 * caller either `.catch()`s the returned promise itself or returns it
	 * unchanged from the stream's native `cancel()` handler — the caller
	 * owns error handling, not the drain helper).
	 */
	swallowErrors?: boolean;
}

/**
 * Deadline-bounded, abort-capable variant of `drainReader`, shared by
 * `anthropic-terminal-recovery.ts` and Codex's `provider.ts`. See
 * `drainReader` above for why draining (not `reader.cancel()`) is needed;
 * this variant additionally bounds the wait so a stuck-but-open upstream
 * can't hold the connection open forever, and optionally reconciles a
 * pre-step (Codex's liveness handoff) before taking ownership of the reader.
 */
export async function drainReaderWithDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: DrainReaderWithDeadlineOptions,
): Promise<void> {
	const { deadlineMs, drainAbort, beforeDrain, swallowErrors } = options;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const runDrain = async (): Promise<void> => {
		const deadline = new Promise<"deadline">((resolve) => {
			deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
		});

		if (beforeDrain) {
			const reconciled = await Promise.race([
				beforeDrain().then(() => "settled" as const),
				deadline,
			]);
			if (reconciled === "deadline") {
				drainAbort?.abort(new Error("Drain deadline exceeded"));
				return;
			}
		}

		while (true) {
			const pendingRead = reader.read();
			const outcome = await Promise.race([pendingRead, deadline]);
			if (outcome === "deadline") {
				// `pendingRead` is still outstanding here. Releasing the lock
				// while a read is in flight only rejects that promise
				// (WHATWG Streams §4.5) — it does not tell the underlying
				// source the stream is abandoned, which is exactly the
				// "touched then abandoned" shape Bun's native fetch can
				// buffer without bound (oven-sh/bun#39590, #382). Abort
				// first so the losing read has a chance to actually settle
				// (reject) via the torn-down connection, then give it a
				// bounded grace window before releasing the lock regardless
				// — a stuck-but-unabortable source must not hang the drain.
				drainAbort?.abort(new Error("Drain deadline exceeded"));
				await awaitPendingReadSettlement(pendingRead, deadlineMs);
				return;
			}
			if (outcome.done) return;
		}
	};

	try {
		await runDrain();
	} catch (error) {
		if (!swallowErrors) throw error;
		// Swallow — draining is best-effort cleanup (Codex's prior behavior).
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		reader.releaseLock();
	}
}
