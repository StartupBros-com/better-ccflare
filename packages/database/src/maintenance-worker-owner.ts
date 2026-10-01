/** One database owner's serialized temporary-connection worker lease. */
export interface MaintenanceWorker {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	postMessage(message: unknown): void;
	terminate(): void;
}

export interface MaintenanceWorkerOptions {
	workerFactory?: (
		specifier: string,
		options?: WorkerOptions,
	) => MaintenanceWorker;
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
	embeddedCode?: string;
	maxPendingJobs?: number;
	jobTimeoutMs?: number;
	retirementTimeoutMs?: number;
}

export type MaintenanceResult = (
	| { ok: true; skipped?: boolean; mode?: number }
	| { ok: false; error: string }
) & {
	walBusy?: number;
	walLog?: number;
	walCheckpointed?: number;
	walTruncateBusy?: number;
};

type Job = {
	id: number;
	request: Record<string, unknown>;
	resolve: (result: MaintenanceResult) => void;
	timer?: ReturnType<typeof setTimeout>;
};

type Lease = {
	worker: MaintenanceWorker;
	generation: number;
	url?: string;
	retiring: boolean;
	retirement?: Promise<void>;
	resolveRetirement?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	held: boolean;
};

export class MaintenanceWorkerOwner {
	private lease?: Lease;
	private active?: Job;
	private queue: Job[] = [];
	private generation = 0;
	private nextJob = 0;
	private closed = false;
	private closePromise?: Promise<void>;
	private acquired = 0;
	private retired = 0;
	private urlsAcquired = 0;
	private urlsRevoked = 0;

	constructor(
		private sourceUrl: string,
		private options: MaintenanceWorkerOptions = {},
	) {
		this.options = {
			...options,
			maxPendingJobs: bounded(options.maxPendingJobs, 8, 0, 8),
			jobTimeoutMs: bounded(options.jobTimeoutMs, 30_000, 1, 30 * 60_000),
			retirementTimeoutMs: bounded(options.retirementTimeoutMs, 1000, 1, 1000),
		};
	}

	getStatus() {
		return {
			workersAcquired: this.acquired,
			workersRetired: this.retired,
			objectUrlsAcquired: this.urlsAcquired,
			objectUrlsRevoked: this.urlsRevoked,
			activeJobs: this.active ? 1 : 0,
			queuedJobs: this.queue.length,
			closing: this.closed,
			retiring: this.lease?.retiring ?? false,
			held: this.lease?.held ?? false,
		};
	}

	run(request: Record<string, unknown>): Promise<MaintenanceResult> {
		if (this.closed)
			return Promise.resolve({ ok: false, error: "maintenance owner closed" });
		if (this.lease?.retiring)
			return Promise.resolve({
				ok: false,
				error: "maintenance worker retiring; ownership fenced",
			});
		if (
			this.queue.length >= (this.options.maxPendingJobs ?? 8) &&
			this.active
		) {
			return Promise.resolve({ ok: false, error: "maintenance queue full" });
		}
		if (
			this.nextJob >= Number.MAX_SAFE_INTEGER ||
			this.generation >= Number.MAX_SAFE_INTEGER
		) {
			return Promise.resolve({
				ok: false,
				error: "maintenance identifier budget exhausted",
			});
		}
		return new Promise((resolve) => {
			this.queue.push({ id: ++this.nextJob, request, resolve });
			this.pump();
		});
	}

	private spawn(): Lease {
		const embedded = this.options.embeddedCode;
		let url: string | undefined;
		if (embedded) {
			const code = Buffer.from(embedded, "base64").toString("utf8");
			url = (this.options.createObjectURL ?? URL.createObjectURL)(
				new Blob([code], { type: "text/javascript" }),
			);
			this.urlsAcquired++;
		}
		let worker: MaintenanceWorker;
		try {
			worker = (
				this.options.workerFactory ??
				((specifier, options) => new Worker(specifier, options))
			)(url ?? this.sourceUrl, { smol: true });
		} catch (error) {
			if (url) this.revoke(url);
			throw error;
		}
		const lease: Lease = {
			worker,
			generation: ++this.generation,
			url,
			retiring: false,
			held: false,
		};
		this.acquired++;
		// Persistent listeners also observe faults while there is no active job.
		worker.onmessage = (event) => this.receive(lease, event.data);
		worker.onerror = (event) => {
			event.preventDefault?.();
			this.fail(lease, "maintenance worker fault");
		};
		this.lease = lease;
		return lease;
	}

	private pump(): void {
		if (this.active || this.closed || this.lease?.retiring) return;
		const job = this.queue.shift();
		if (!job) return;
		let lease: Lease;
		try {
			lease = this.lease ?? this.spawn();
		} catch {
			job.resolve({ ok: false, error: "maintenance worker creation failed" });
			this.pump();
			return;
		}
		this.active = job;
		job.timer = setTimeout(
			() => this.fail(lease, "maintenance job timeout"),
			this.options.jobTimeoutMs ?? 30_000,
		);
		try {
			lease.worker.postMessage({
				...job.request,
				generation: lease.generation,
				jobId: job.id,
			});
		} catch {
			this.fail(lease, "maintenance worker postMessage failed");
		}
	}

	private receive(lease: Lease, data: unknown): void {
		if (this.lease !== lease || typeof data !== "object" || data === null)
			return;
		const message = data as Record<string, unknown>;
		if (message.generation !== lease.generation) return;
		if (
			message.kind === "retired" &&
			message.closed === true &&
			lease.retiring
		) {
			// This acknowledgment is sent only after the worker's temporary DB closes.
			// Bun's terminate/close event alone does not establish native thread exit.
			if (lease.timer) clearTimeout(lease.timer);
			lease.worker.onmessage = null;
			lease.worker.onerror = null;
			lease.worker.terminate();
			if (lease.url) this.revoke(lease.url);
			this.retired++;
			this.lease = undefined;
			lease.resolveRetirement?.();
			return;
		}
		const job = this.active;
		if (lease.retiring || !job || message.jobId !== job.id) return;
		if (message.closed !== true || typeof message.ok !== "boolean") {
			this.fail(lease, "maintenance worker invalid completion");
			return;
		}
		if (job.timer) clearTimeout(job.timer);
		this.active = undefined;
		// Copy a fixed result shape rather than retaining arbitrary worker data.
		const result: MaintenanceResult = message.ok
			? {
					ok: true,
					skipped: message.skipped === true,
					...(typeof message.mode === "number" ? { mode: message.mode } : {}),
					...numericFields(message),
				}
			: {
					ok: false,
					error:
						typeof message.error === "string"
							? message.error.slice(0, 512)
							: "maintenance operation failed",
					...numericFields(message),
				};
		job.resolve(result);
		this.pump();
	}

	private settleJobs(error: string): void {
		if (this.active) {
			if (this.active.timer) clearTimeout(this.active.timer);
			this.active.resolve({ ok: false, error });
			this.active = undefined;
		}
		for (const job of this.queue.splice(0)) job.resolve({ ok: false, error });
	}

	private fail(lease: Lease, error: string): void {
		if (this.lease !== lease || lease.retiring) return;
		this.settleJobs(error);
		// Observe rejection here; close() still receives the original retirement failure.
		void this.retire(lease).catch(() => {});
	}

	private retire(lease: Lease): Promise<void> {
		if (lease.retirement) return lease.retirement;
		lease.retiring = true;
		lease.retirement = new Promise<void>((resolve, reject) => {
			lease.resolveRetirement = resolve;
			lease.timer = setTimeout(() => {
				lease.held = true;
				reject(
					new Error(
						"maintenance retirement unconfirmed; database ownership held",
					),
				);
			}, this.options.retirementTimeoutMs ?? 1000);
			try {
				lease.worker.postMessage({
					kind: "retire",
					generation: lease.generation,
				});
			} catch {
				clearTimeout(lease.timer);
				lease.held = true;
				reject(
					new Error(
						"maintenance retirement transport failed; database ownership held",
					),
				);
			}
		});
		return lease.retirement;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.settleJobs("maintenance owner closed");
		this.closePromise = this.lease
			? this.retire(this.lease)
			: Promise.resolve();
		return this.closePromise;
	}

	private revoke(url: string): void {
		(this.options.revokeObjectURL ?? URL.revokeObjectURL)(url);
		this.urlsRevoked++;
	}
}

function numericFields(message: Record<string, unknown>) {
	const fields: {
		walBusy?: number;
		walLog?: number;
		walCheckpointed?: number;
		walTruncateBusy?: number;
	} = {};
	for (const key of [
		"walBusy",
		"walLog",
		"walCheckpointed",
		"walTruncateBusy",
	] as const) {
		const value = message[key];
		if (typeof value === "number" && Number.isFinite(value))
			fields[key] = value;
	}
	return fields;
}

function bounded(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.min(max, Math.trunc(value)))
		: fallback;
}
