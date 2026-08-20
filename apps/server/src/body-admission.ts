import { MAX_REQUEST_BODY_BYTES } from "@better-ccflare/core";

export const DEFAULT_BODY_ADMISSION_BUDGET_BYTES = 256 * 1024 * 1024;
export const BODY_ADMISSION_RESERVATION_MULTIPLIER = 8;
export const DEFAULT_BODY_ADMISSION_QUEUE_LIMIT = 500;
export const MAX_BODY_ADMISSION_QUEUE_LIMIT = 5_000;

export class BodyAdmissionQueueFullError extends Error {
	constructor() {
		super("Request-body admission queue is full.");
		this.name = "BodyAdmissionQueueFullError";
	}
}

export class BodyAdmissionShuttingDownError extends Error {
	constructor() {
		super("Request-body admission is shutting down.");
		this.name = "BodyAdmissionShuttingDownError";
	}
}

export type BodyAdmissionLease = Readonly<{
	/** Lower this live reservation to an exact byte count; increases are ignored. */
	reduceTo: (bytes: number) => void;
	release: () => void;
}>;

export type BodyAdmissionSnapshot = Readonly<{
	enabled: true;
	budgetBytes: number;
	reservedBytes: number;
	activeLeases: number;
	queuedRequests: number;
	queueLimit: number;
	peakReservedBytes: number;
	peakActiveLeases: number;
	counters: Readonly<{
		admitted: number;
		queued: number;
		queueFull: number;
		queueAborted: number;
		released: number;
	}>;
}>;

type QueuedAdmission = {
	bytes: number;
	resolve: (lease: BodyAdmissionLease) => void;
	reject: (reason: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ?? new DOMException("The request was aborted.", "AbortError")
	);
}

function isCanonicalSafeContentLength(value: string | null): number | null {
	// Accept the one canonical decimal representation only. Leading zeros and
	// whitespace can be normalized differently by hops, so they must take the
	// conservative full-budget path rather than affecting admission arithmetic.
	if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Computes the process-local weighted reservation before a proxy body is read.
 * A transparent body can use its canonical Content-Length; every other body is
 * charged the complete budget because decompression and chunking obscure the
 * retained work until the body reader enforces its exact 32 MiB ceiling.
 */
export function bodyAdmissionReservationBytes(
	headers: Headers,
	budgetBytes = DEFAULT_BODY_ADMISSION_BUDGET_BYTES,
): number {
	const contentEncoding = headers.get("content-encoding");
	const transparentEncoding =
		contentEncoding === null || contentEncoding.toLowerCase() === "identity";
	if (!transparentEncoding || headers.has("transfer-encoding"))
		return budgetBytes;

	const contentLength = isCanonicalSafeContentLength(
		headers.get("content-length"),
	);
	if (contentLength === null || contentLength > MAX_REQUEST_BODY_BYTES) {
		return budgetBytes;
	}
	return Math.min(
		budgetBytes,
		contentLength * BODY_ADMISSION_RESERVATION_MULTIPLIER,
	);
}

/** A FIFO, process-local weighted admission controller with no request metadata. */
export class BodyAdmissionController {
	private readonly budgetBytes: number;
	private readonly queueLimit: number;
	private reservedBytes = 0;
	private activeLeases = 0;
	private peakReservedBytes = 0;
	private peakActiveLeases = 0;
	private shuttingDown = false;
	private readonly queue: QueuedAdmission[] = [];
	private readonly counters = {
		admitted: 0,
		queued: 0,
		queueFull: 0,
		queueAborted: 0,
		released: 0,
	};

	constructor(
		options: Readonly<{
			budgetBytes?: number;
			queueLimit?: number;
		}> = {},
	) {
		this.budgetBytes =
			Number.isSafeInteger(options.budgetBytes) &&
			(options.budgetBytes ?? 0) > 0
				? (options.budgetBytes as number)
				: DEFAULT_BODY_ADMISSION_BUDGET_BYTES;
		this.queueLimit =
			Number.isSafeInteger(options.queueLimit) &&
			(options.queueLimit ?? -1) >= 0
				? Math.min(options.queueLimit as number, MAX_BODY_ADMISSION_QUEUE_LIMIT)
				: DEFAULT_BODY_ADMISSION_QUEUE_LIMIT;
	}

	acquire(bytes: number, signal?: AbortSignal): Promise<BodyAdmissionLease> {
		if (this.shuttingDown) {
			return Promise.reject(new BodyAdmissionShuttingDownError());
		}
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.budgetBytes) {
			this.counters.queueFull += 1;
			return Promise.reject(new BodyAdmissionQueueFullError());
		}
		if (signal?.aborted) return Promise.reject(abortReason(signal));

		if (this.queue.length === 0 && this.canAdmit(bytes)) {
			return Promise.resolve(this.createLease(bytes));
		}
		if (this.queue.length >= this.queueLimit) {
			this.counters.queueFull += 1;
			return Promise.reject(new BodyAdmissionQueueFullError());
		}

		this.counters.queued += 1;
		return new Promise<BodyAdmissionLease>((resolve, reject) => {
			const queued: QueuedAdmission = { bytes, resolve, reject, signal };
			if (signal) {
				queued.onAbort = () => {
					const index = this.queue.indexOf(queued);
					if (index === -1) return;
					this.queue.splice(index, 1);
					this.counters.queueAborted += 1;
					const onAbort = queued.onAbort;
					if (onAbort) signal.removeEventListener("abort", onAbort);
					reject(abortReason(signal));
					this.drain();
				};
				signal.addEventListener("abort", queued.onAbort, { once: true });
			}
			this.queue.push(queued);
			this.drain();
		});
	}

	shutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		for (const queued of this.queue.splice(0)) {
			if (queued.signal && queued.onAbort) {
				queued.signal.removeEventListener("abort", queued.onAbort);
			}
			queued.reject(new BodyAdmissionShuttingDownError());
		}
	}

	snapshot(): BodyAdmissionSnapshot {
		return {
			enabled: true,
			budgetBytes: this.budgetBytes,
			reservedBytes: this.reservedBytes,
			activeLeases: this.activeLeases,
			queuedRequests: this.queue.length,
			queueLimit: this.queueLimit,
			peakReservedBytes: this.peakReservedBytes,
			peakActiveLeases: this.peakActiveLeases,
			counters: { ...this.counters },
		};
	}

	private canAdmit(bytes: number): boolean {
		return bytes <= this.budgetBytes - this.reservedBytes;
	}

	private createLease(bytes: number): BodyAdmissionLease {
		this.reservedBytes += bytes;
		this.activeLeases += 1;
		this.peakReservedBytes = Math.max(
			this.peakReservedBytes,
			this.reservedBytes,
		);
		this.peakActiveLeases = Math.max(this.peakActiveLeases, this.activeLeases);
		this.counters.admitted += 1;
		let released = false;
		let reservedByLease = bytes;
		return {
			reduceTo: (nextBytes: number) => {
				if (
					released ||
					!Number.isSafeInteger(nextBytes) ||
					nextBytes < 0 ||
					nextBytes >= reservedByLease
				) {
					return;
				}
				const reduction = reservedByLease - nextBytes;
				reservedByLease = nextBytes;
				this.reservedBytes = Math.max(0, this.reservedBytes - reduction);
				this.drain();
			},
			release: () => {
				if (released) return;
				released = true;
				this.reservedBytes = Math.max(0, this.reservedBytes - reservedByLease);
				this.activeLeases = Math.max(0, this.activeLeases - 1);
				this.counters.released += 1;
				this.drain();
			},
		};
	}

	private drain(): void {
		if (this.shuttingDown) return;
		while (true) {
			const queued = this.queue[0];
			if (!queued || !this.canAdmit(queued.bytes)) return;
			this.queue.shift();
			if (queued.signal && queued.onAbort) {
				queued.signal.removeEventListener("abort", queued.onAbort);
			}
			queued.resolve(this.createLease(queued.bytes));
		}
	}
}

export function bodyAdmissionUnavailableResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "service_unavailable_error",
				message: "Service temporarily unavailable. Please try again later.",
			},
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": "1",
			},
		},
	);
}

/**
 * Holds an already-admitted weighted lease until the response stream reaches a
 * terminal state. The wrapper deliberately contains no request data, so it is
 * safe to compose outside proxy/adapter implementations and inside shutdown
 * stream tracking.
 */
export function holdBodyAdmissionLease(
	response: Response,
	lease: BodyAdmissionLease,
): Response {
	if (!response.body) {
		lease.release();
		return response;
	}
	const reader = response.body.getReader();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		lease.release();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					release();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		cancel(reason) {
			release();
			return reader.cancel(reason).catch(() => {});
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Admit body-bearing proxy traffic before any downstream handler can read it.
 * API/dashboard/health routes do not reach this helper; a bodyless proxy
 * request also bypasses it because it cannot retain request-body bytes.
 */
type BodyAdmissionOptions = Readonly<{
	forceFull?: boolean;
}>;

export async function withBodyAdmission(
	request: Request,
	controller: BodyAdmissionController,
	handler: (lease: BodyAdmissionLease) => Response | Promise<Response>,
	options: BodyAdmissionOptions = {},
): Promise<Response> {
	if (request.body === null)
		return handler({
			reduceTo: () => {},
			release: () => {},
		});
	let lease: BodyAdmissionLease;
	try {
		const budgetBytes = controller.snapshot().budgetBytes;
		lease = await controller.acquire(
			options.forceFull
				? budgetBytes
				: bodyAdmissionReservationBytes(request.headers, budgetBytes),
			request.signal,
		);
	} catch (error) {
		if (
			error instanceof BodyAdmissionQueueFullError ||
			error instanceof BodyAdmissionShuttingDownError
		) {
			return bodyAdmissionUnavailableResponse();
		}
		throw error;
	}
	try {
		return holdBodyAdmissionLease(await handler(lease), lease);
	} catch (error) {
		lease.release();
		throw error;
	}
}
