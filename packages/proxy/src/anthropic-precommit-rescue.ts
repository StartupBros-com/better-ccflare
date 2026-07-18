export const ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME =
	'event: ping\ndata: {"type":"ping"}\n\n';
export const ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"No compatible account route committed before the recovery deadline"}}\n\n';
export const ANTHROPIC_PRECOMMIT_RESCUE_PARTIAL_ERROR_FRAME =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response failed after partial output"}}\n\n';

// Live direct-route tail reaches roughly 132s. Measured from handleProxy entry,
// this starts rescue just beyond that observation while retaining about 45s of
// margin before Claude's ~180s watchdog, including request setup/header latency.
export const ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS = 135_000;
export const ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS = 25_000;
export const ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS = 8 * 60 * 1000;

export const ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS";
export const ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS";
export const ANTHROPIC_PRECOMMIT_RESCUE_DEADLINE_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_RESCUE_DEADLINE_MS";

const MAX_RESCUE_ACTIVATION_MS = 150_000;
const MAX_RESCUE_PING_INTERVAL_MS = 30_000;
const MAX_RESCUE_COMMITMENT_DEADLINE_MS = 15 * 60 * 1000;

export interface AnthropicPreCommitRescueConfig {
	activationGraceMs: number;
	pingIntervalMs: number;
	commitmentDeadlineMs: number;
}

export interface AnthropicPreCommitRescueActivation {
	readonly promise: Promise<void>;
	activate(): void;
}

/** Request-scoped control seam shared by routing and the rescue coordinator. */
export interface AnthropicPreCommitRescueRouteContext {
	readonly activate: () => void;
	readonly signal: AbortSignal;
}

export interface AnthropicPreCommitRescueOptions {
	/** The existing serial routing coroutine. It must not expose ungated bytes. */
	response: Promise<Response>;
	/** Resolves when an Anthropic downstream route reaches transport or gating. */
	activation: Promise<void>;
	/** Cancels the private routing coroutine on downstream cancel/deadline. */
	abortRouting(reason?: unknown): void;
	config: AnthropicPreCommitRescueConfig;
	/** Whole-request origin; defaults to coordinator entry for isolated callers. */
	requestStartedAt?: number;
}

type ResponseOutcome =
	| { readonly kind: "response"; readonly response: Response }
	| { readonly kind: "error"; readonly error: unknown };

const ACTIVATED = Symbol("anthropic-precommit-rescue-activated");
const GRACE_ELAPSED = Symbol("anthropic-precommit-rescue-grace-elapsed");
const DEADLINE_ELAPSED = Symbol("anthropic-precommit-rescue-deadline-elapsed");

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

export function getAnthropicPreCommitRescueConfig(): AnthropicPreCommitRescueConfig {
	const activationGraceMs = boundedEnvInteger(
		ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_ENV,
		ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
		MAX_RESCUE_ACTIVATION_MS,
	);
	const pingIntervalMs = boundedEnvInteger(
		ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_ENV,
		ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
		MAX_RESCUE_PING_INTERVAL_MS,
	);
	const configuredDeadlineMs = boundedEnvInteger(
		ANTHROPIC_PRECOMMIT_RESCUE_DEADLINE_ENV,
		ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS,
		MAX_RESCUE_COMMITMENT_DEADLINE_MS,
	);

	return {
		activationGraceMs,
		pingIntervalMs,
		// A typo cannot make the rescue expire before its first keepalive.
		commitmentDeadlineMs: Math.max(
			configuredDeadlineMs,
			activationGraceMs + pingIntervalMs,
		),
	};
}

export function createAnthropicPreCommitRescueActivation(): AnthropicPreCommitRescueActivation {
	let activated = false;
	let resolveActivation!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolveActivation = resolve;
	});

	return {
		promise,
		activate() {
			if (activated) return;
			activated = true;
			resolveActivation();
		},
	};
}

export function isPotentialDownstreamAnthropicMessagesRequest(
	request: Request,
	url: URL,
): boolean {
	return (
		request.method === "POST" &&
		url.pathname === "/v1/messages" &&
		request.headers.has("anthropic-version")
	);
}

function responseOutcome(
	response: Promise<Response>,
): Promise<ResponseOutcome> {
	return response.then(
		(value) => ({ kind: "response", response: value }),
		(error: unknown) => ({ kind: "error", error }),
	);
}

function unwrapOutcome(outcome: ResponseOutcome): Response {
	if (outcome.kind === "error") throw outcome.error;
	return outcome.response;
}

function timer<T>(
	value: T,
	delayMs: number,
): {
	readonly promise: Promise<T>;
	cancel(): void;
} {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<T>((resolve) => {
		handle = setTimeout(() => resolve(value), Math.max(0, delayMs));
	});
	return {
		promise,
		cancel() {
			if (handle !== undefined) clearTimeout(handle);
			handle = undefined;
		},
	};
}

function isSuccessfulSse(response: Response): boolean {
	return (
		response.ok &&
		response.body !== null &&
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") === true
	);
}

async function cancelResponseBody(
	response: Response,
	reason: unknown,
): Promise<void> {
	try {
		await response.body?.cancel(reason);
	} catch {
		// Cleanup is best-effort and cannot change the downstream terminal frame.
	}
}

function createRescueResponse(
	outcomePromise: Promise<ResponseOutcome>,
	abortRouting: (reason?: unknown) => void,
	pingIntervalMs: number,
	remainingDeadlineMs: number,
): Response {
	const encoder = new TextEncoder();
	let cancelled = false;
	let closed = false;
	let abortIssued = false;
	let responseCancelIssued = false;
	let winnerChunkForwarded = false;
	let winnerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | undefined;
	const deadline = timer(DEADLINE_ELAPSED, remainingDeadlineMs);
	const routedResult = Promise.race([outcomePromise, deadline.promise]);
	let settledResult: ResponseOutcome | typeof DEADLINE_ELAPSED | undefined;

	const stopTimers = (): void => {
		if (pingTimer !== undefined) clearInterval(pingTimer);
		pingTimer = undefined;
		deadline.cancel();
	};
	const abortOnce = (reason: unknown): void => {
		if (abortIssued) return;
		abortIssued = true;
		try {
			abortRouting(reason);
		} catch {
			// Abort callbacks cannot corrupt an already-committed client stream.
		}
	};
	const cancelResolvedResponseOnce = async (
		response: Response,
		reason: unknown,
	): Promise<void> => {
		if (responseCancelIssued) return;
		responseCancelIssued = true;
		if (winnerReader) {
			try {
				await winnerReader.cancel(reason);
			} catch {
				// Cleanup is best-effort after downstream departure.
			}
			return;
		}
		await cancelResponseBody(response, reason);
	};
	const cancelLateResponse = (reason: unknown): void => {
		void outcomePromise.then((lateOutcome) => {
			if (lateOutcome.kind === "response") {
				void cancelResolvedResponseOnce(lateOutcome.response, reason);
			}
		});
	};

	void routedResult.then((result) => {
		settledResult = result;
		stopTimers();
		if (result === DEADLINE_ELAPSED) {
			const reason = new Error(
				"Anthropic precommit rescue commitment deadline elapsed",
			);
			abortOnce(reason);
			cancelLateResponse(reason);
			return;
		}
		if (cancelled && result.kind === "response") {
			void cancelResolvedResponseOnce(result.response, "downstream cancelled");
		}
	});

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enqueuePing = (): void => {
				if (cancelled || closed) return;
				if (controller.desiredSize !== null && controller.desiredSize <= 0) {
					return;
				}
				controller.enqueue(
					encoder.encode(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME),
				);
			};

			enqueuePing();
			pingTimer = setInterval(enqueuePing, pingIntervalMs);
		},

		async pull(controller) {
			const closeWithSanitizedError = (
				errorFrame = ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
			): void => {
				if (cancelled || closed) return;
				stopTimers();
				closed = true;
				controller.enqueue(encoder.encode(errorFrame));
				controller.close();
			};
			const result = settledResult ?? (await routedResult);
			if (cancelled || closed) return;

			if (result === DEADLINE_ELAPSED || result.kind === "error") {
				closeWithSanitizedError();
				return;
			}
			if (!isSuccessfulSse(result.response)) {
				closeWithSanitizedError();
				void cancelResolvedResponseOnce(
					result.response,
					"translated delayed non-SSE response",
				);
				return;
			}

			// A queued rescue ping already satisfies downstream demand. Do not read a
			// winner chunk until the queue has capacity again.
			if (controller.desiredSize !== null && controller.desiredSize <= 0)
				return;
			const responseBody = result.response.body;
			if (!responseBody) {
				closeWithSanitizedError();
				return;
			}
			winnerReader ??= responseBody.getReader();
			const reader = winnerReader;
			try {
				const read = await reader.read();
				if (cancelled || closed) return;
				if (read.done) {
					closed = true;
					controller.close();
					return;
				}
				controller.enqueue(read.value);
				winnerChunkForwarded = true;
			} catch {
				closeWithSanitizedError(
					winnerChunkForwarded
						? ANTHROPIC_PRECOMMIT_RESCUE_PARTIAL_ERROR_FRAME
						: ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
				);
			}
		},

		cancel(reason) {
			if (cancelled) return;
			cancelled = true;
			stopTimers();
			abortOnce(reason);
			if (settledResult && settledResult !== DEADLINE_ELAPSED) {
				if (settledResult.kind === "response") {
					void cancelResolvedResponseOnce(settledResult.response, reason);
				}
				return;
			}
			cancelLateResponse(reason);
		},
	});

	return new Response(body, {
		status: 200,
		headers: {
			"cache-control": "no-cache",
			"content-type": "text/event-stream; charset=utf-8",
			"x-better-ccflare-precommit-rescue": "active",
		},
	});
}

/**
 * Keep the existing serial route executor private until it produces a gated
 * winner. Short requests return their original Response object unchanged. Only
 * an Anthropic downstream route whose transport or semantic gate outlives the
 * activation grace commits the outer SSE rescue stream, whose pings keep the
 * client watchdog alive while routing continues in the established
 * combo/deferred order.
 */
export async function coordinateAnthropicPreCommitRescue(
	options: AnthropicPreCommitRescueOptions,
): Promise<Response> {
	const requestStartedAt = options.requestStartedAt ?? Date.now();
	const outcomePromise = responseOutcome(options.response);
	const first = await Promise.race([
		outcomePromise,
		options.activation.then((): typeof ACTIVATED => ACTIVATED),
	]);
	if (first !== ACTIVATED) return unwrapOutcome(first);

	const elapsedBeforeGraceMs = Math.max(0, Date.now() - requestStartedAt);
	const grace = timer(
		GRACE_ELAPSED,
		Math.max(0, options.config.activationGraceMs - elapsedBeforeGraceMs),
	);
	const afterActivation = await Promise.race([outcomePromise, grace.promise]);
	if (afterActivation !== GRACE_ELAPSED) {
		grace.cancel();
		return unwrapOutcome(afterActivation);
	}

	return createRescueResponse(
		outcomePromise,
		options.abortRouting,
		options.config.pingIntervalMs,
		Math.max(
			1,
			options.config.commitmentDeadlineMs -
				Math.max(0, Date.now() - requestStartedAt),
		),
	);
}
