import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("Fixture did not establish the expected owner or receipt");
	return value;
}

// The factory seam exercises the actual facade lifecycle without provider traffic
// or a real worker's nondeterministic fault scheduling.
class FakeWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	messages: Record<string, unknown>[] = [];
	terminated = 0;
	active = 0;
	maxActive = 0;
	autoResult = true;
	retireAck = true;
	postThrows = false;
	postMessage(message: Record<string, unknown>) {
		this.messages.push(message);
		if (this.postThrows) throw new Error("post failed");
		if (message.kind === "retire") {
			if (this.retireAck)
				queueMicrotask(() =>
					this.emit({
						kind: "retired",
						generation: message.generation,
						closed: true,
					}),
				);
			return;
		}
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		if (this.autoResult) queueMicrotask(() => this.complete(message));
	}
	complete(
		message = required(this.messages.findLast((m) => m.kind !== "retire")),
		result: Record<string, unknown> = { ok: true, skipped: false, mode: 2 },
	) {
		this.active--;
		this.emit({
			...result,
			generation: message.generation,
			jobId: message.jobId,
			closed: true,
		});
	}
	emit(data: Record<string, unknown>) {
		this.onmessage?.({ data } as MessageEvent);
	}
	fault() {
		this.onerror?.({
			message: "worker fault",
			preventDefault() {},
		} as ErrorEvent);
	}
	terminate() {
		this.terminated++;
	}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(
	settings: {
		autoResult?: boolean;
		retireAck?: boolean;
		maxPendingJobs?: number;
		jobTimeoutMs?: number;
		retirementTimeoutMs?: number;
		compiled?: boolean;
		spawnFails?: number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-maintenance-owner-"));
	const workers: FakeWorker[] = [];
	const events: string[] = [];
	let failures = settings.spawnFails ?? 0;
	const options = {
		workerFactory: () => {
			events.push("spawn");
			if (failures-- > 0) throw new Error("spawn failed");
			const worker = new FakeWorker();
			worker.autoResult = settings.autoResult ?? true;
			worker.retireAck = settings.retireAck ?? true;
			workers.push(worker);
			return worker;
		},
		embeddedCode:
			settings.compiled === false
				? ""
				: Buffer.from("mock worker").toString("base64"),
		createObjectURL: () => {
			events.push("url-created");
			return "blob:maintenance-test";
		},
		revokeObjectURL: () => {
			events.push("url-revoked");
		},
		maxPendingJobs: settings.maxPendingJobs ?? 8,
		jobTimeoutMs: settings.jobTimeoutMs ?? 1000,
		retirementTimeoutMs: settings.retirementTimeoutMs ?? 1000,
	};
	const db = new DatabaseOperations(
		join(dir, "test.db"),
		undefined,
		undefined,
		options,
	);
	const adapter = db.getAdapter();
	const originalClose = adapter.close.bind(adapter);
	adapter.close = async () => {
		events.push("adapter-close");
		await originalClose();
	};
	cleanups.push(async () => {
		try {
			await db.close();
		} catch {
			await originalClose();
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return { db, workers, events };
}

async function turns() {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("database maintenance worker ownership", () => {
	it("closes promptly under an unrelated SQLite writer after owned maintenance retires", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-close-busy-"));
		const file = join(dir, "test.db");
		const db = new DatabaseOperations(file);
		const holder = new Database(file);
		try {
			await db.optimizeAsync();
			holder.exec("BEGIN IMMEDIATE");
			const started = Date.now();
			await db.close();
			expect(Date.now() - started).toBeLessThan(1000);
		} finally {
			try {
				holder.exec("ROLLBACK");
			} finally {
				holder.close();
			}
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);

	it.each([
		"compiled",
		"source",
	])("balances real %s worker generations and URLs across repeated ticks and shutdown", async (mode) => {
		const NativeWorker = globalThis.Worker;
		const nativeCreate = URL.createObjectURL;
		const nativeRevoke = URL.revokeObjectURL;
		let acquired = 0;
		let urls = 0;
		let revoked = 0;
		globalThis.Worker = class extends NativeWorker {
			constructor(specifier: string | URL, options?: WorkerOptions) {
				super(specifier, options);
				acquired++;
			}
		};
		URL.createObjectURL = (blob: Blob) => {
			urls++;
			return nativeCreate(blob);
		};
		URL.revokeObjectURL = (url: string) => {
			revoked++;
			nativeRevoke(url);
		};
		const dir = mkdtempSync(join(tmpdir(), "ccflare-real-maintenance-owner-"));
		const db = new DatabaseOperations(
			join(dir, "test.db"),
			undefined,
			undefined,
			mode === "source" ? { embeddedCode: "" } : undefined,
		);
		try {
			await db.optimizeAsync();
			await db.incrementalVacuum(1);
			await db.optimizeAsync();
			expect(acquired).toBe(1);
			await db.close();
			expect(revoked).toBe(urls);
		} finally {
			await db.close();
			globalThis.Worker = NativeWorker;
			URL.createObjectURL = nativeCreate;
			URL.revokeObjectURL = nativeRevoke;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("owns the manual full-VACUUM worker through confirmed database close", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-compact-owner-"));
		const db = new DatabaseOperations(join(dir, "test.db"));
		try {
			expect((await db.compact()).vacuumed).toBe(true);
			expect(db.getMaintenanceStatus().compaction.workersAcquired).toBe(1);
			await db.close();
			const status = db.getMaintenanceStatus().compaction;
			expect(status.workersRetired).toBe(status.workersAcquired);
			expect(status.objectUrlsRevoked).toBe(status.objectUrlsAcquired);
			expect((await db.compact()).vacuumed).toBe(false);
		} finally {
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reuses one worker and serializes repeated and concurrent optimize/vacuum jobs", async () => {
		const { db, workers, events } = fixture();
		const results = await Promise.all([
			db.optimizeAsync(),
			db.incrementalVacuum(1),
			db.optimizeAsync(),
		]);
		expect(results[0]?.ok).toBe(true);
		expect(results[2]?.ok).toBe(true);
		await db.optimizeAsync();
		expect(workers).toHaveLength(1);
		expect(workers[0]?.maxActive).toBe(1);
		expect(events.filter((e) => e === "url-created")).toHaveLength(1);
		await db.close();
		expect(workers[0]?.terminated).toBe(1);
		expect(events.filter((e) => e === "url-revoked")).toHaveLength(1);
		expect(events.indexOf("url-revoked")).toBeLessThan(
			events.indexOf("adapter-close"),
		);
	});

	it("revokes a compiled URL on failed spawn and retries without a retained owner", async () => {
		const { db, workers, events } = fixture({ spawnFails: 1 });
		expect((await db.optimizeAsync()).ok).toBe(false);
		expect(events).toEqual(["url-created", "spawn", "url-revoked"]);
		expect((await db.optimizeAsync()).ok).toBe(true);
		expect(workers).toHaveLength(1);
		await db.close();
		expect(events.filter((e) => e === "url-revoked")).toHaveLength(2);
	});

	it("source mode acquires no compiled object URL", async () => {
		const { db, events } = fixture({ compiled: false });
		expect((await db.optimizeAsync()).ok).toBe(true);
		await db.close();
		expect(events).toEqual(["spawn", "adapter-close"]);
	});

	it("bounds queued jobs while one worker owns a busy job", async () => {
		const { db, workers } = fixture({ autoResult: false, maxPendingJobs: 2 });
		const first = db.optimizeAsync();
		const second = db.optimizeAsync();
		const third = db.optimizeAsync();
		expect((await db.optimizeAsync()).error).toContain("queue full");
		expect(workers).toHaveLength(1);
		required(workers[0]).complete();
		await turns();
		required(workers[0]).complete();
		await turns();
		required(workers[0]).complete();
		expect((await Promise.all([first, second, third])).every((r) => r.ok)).toBe(
			true,
		);
		expect(workers[0]?.maxActive).toBe(1);
	});

	it("settles a fault once and fences replacement until a positive retirement receipt", async () => {
		const { db, workers, events } = fixture({
			autoResult: false,
			retireAck: false,
		});
		const first = db.optimizeAsync();
		const queued = db.optimizeAsync();
		const old = required(workers[0]);
		const sent = required(old.messages[0]);
		old.fault();
		expect((await first).ok).toBe(false);
		expect((await queued).ok).toBe(false);
		expect((await db.optimizeAsync()).error).toContain("retiring");
		expect(workers).toHaveLength(1);
		old.complete(sent); // Late job output is not a retirement receipt.
		expect((await db.optimizeAsync()).ok).toBe(false);
		old.emit({ kind: "retired", generation: sent.generation, closed: true });
		await turns();
		const next = db.optimizeAsync();
		expect(workers).toHaveLength(2);
		old.emit({
			ok: true,
			closed: true,
			generation: sent.generation,
			jobId: sent.jobId,
		});
		required(workers[1]).complete();
		expect((await next).ok).toBe(true);
		required(workers[1]).retireAck = true;
		expect(events.filter((e) => e === "url-revoked")).toHaveLength(1);
	});

	it("observes idle faults and keeps ordinary SQLite failures on the healthy worker", async () => {
		const { db, workers } = fixture({ autoResult: false });
		const job = db.optimizeAsync();
		required(workers[0]).complete(undefined, {
			ok: false,
			error: "SQLITE_BUSY",
		});
		expect((await job).ok).toBe(false);
		const next = db.optimizeAsync();
		expect(workers).toHaveLength(1);
		required(workers[0]).complete();
		expect((await next).ok).toBe(true);
		required(workers[0]).fault();
		await turns();
		const afterFault = db.optimizeAsync();
		expect(workers).toHaveLength(2);
		required(workers[1]).complete();
		expect((await afterFault).ok).toBe(true);
	});

	it("retires after postMessage failure without overlapping a replacement", async () => {
		const { db, workers } = fixture({
			autoResult: false,
			retirementTimeoutMs: 10,
		});
		const job = db.optimizeAsync();
		required(workers[0]).postThrows = true;
		required(workers[0]).fault();
		expect((await job).ok).toBe(false);
		await turns();
		expect((await db.optimizeAsync()).ok).toBe(false);
		expect(workers).toHaveLength(1);
	});

	it("close rejects queued/new jobs, waits for retirement, and closes the adapter once", async () => {
		const { db, workers, events } = fixture({
			autoResult: false,
			retireAck: false,
		});
		const job = db.optimizeAsync();
		const queued = db.optimizeAsync();
		const close1 = db.close();
		const close2 = db.close();
		expect((await job).ok).toBe(false);
		expect((await queued).ok).toBe(false);
		expect((await db.optimizeAsync()).error).toContain("closed");
		await turns();
		expect(events).not.toContain("adapter-close");
		const retirement = required(
			required(workers[0]).messages.find((m) => m.kind === "retire"),
		);
		required(workers[0]).emit({
			kind: "retired",
			generation: retirement.generation,
			closed: true,
		});
		await Promise.all([close1, close2]);
		expect(workers[0]?.terminated).toBe(1);
		expect(events.filter((e) => e === "adapter-close")).toHaveLength(1);
	});

	it("holds ambiguous hung ownership within the retirement bound instead of closing/replacing", async () => {
		const { db, workers, events } = fixture({
			autoResult: false,
			retireAck: false,
			jobTimeoutMs: 10,
			retirementTimeoutMs: 10,
		});
		expect((await db.optimizeAsync()).error).toContain("timeout");
		await expect(db.close()).rejects.toThrow("retirement");
		expect(events).not.toContain("adapter-close");
		expect(events).not.toContain("url-revoked");
		expect(workers[0]?.terminated).toBe(0);
		expect((await db.optimizeAsync()).ok).toBe(false);
	});
});
