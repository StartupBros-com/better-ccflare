/**
 * Tests for `DatabaseOperations.optimizeAsync()` and the `kind` discriminator
 * added to the incremental-vacuum worker protocol.
 *
 * Background: the 5-minute "wal-checkpoint" job used to call a synchronous
 * `optimize()` that ran `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)`
 * on the MAIN thread via `sqliteDb.exec()`. When another connection (e.g. the
 * hourly incremental-vacuum worker) held the write lock, `PRAGMA optimize`'s
 * internal ANALYZE blocked inside SQLite's C-level busy handler for the full
 * busy_timeout (10 s), freezing the entire event loop, then threw "database
 * is locked".
 *
 * The fix routes the work through the existing incremental-vacuum worker
 * (kind: "optimize") on its own connection with `busy_timeout = 0`:
 *   - main thread never blocks (worker round-trip is async),
 *   - lock contention resolves instantly as `{ ok: true, skipped: true }`
 *     instead of a 10 s C-level sleep -- skipping a 5-minute cycle is normal
 *     when maintenance contends.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseOperations as DatabaseOperationsType } from "../database-operations";

// Fresh worktrees intentionally do not contain the generated embedded worker
// modules. Keep this focused suite on the source-worker fallback without
// generating or reading those excluded build artifacts.
mock.module("../inline-incremental-vacuum-worker", () => ({
	EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE: "",
}));
mock.module("../inline-vacuum-worker", () => ({
	EMBEDDED_VACUUM_WORKER_CODE: "",
}));

const { DatabaseOperations } = await import("../database-operations");

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-optimize-test-"));
}

type MaintenanceResponse =
	| { ok: true; skipped: boolean }
	| { ok: true; mode: number }
	| { ok: false; error: string };

class FakeMaintenanceWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	readonly messages: unknown[] = [];
	terminateCount = 0;
	activeMessages = 0;
	maxActiveMessages = 0;

	constructor(
		private readonly respond: (
			worker: FakeMaintenanceWorker,
			message: unknown,
		) => void = (worker) => {
			worker.reply({ ok: true, skipped: false });
		},
	) {}

	postMessage(message: unknown): void {
		this.messages.push(message);
		this.activeMessages += 1;
		this.maxActiveMessages = Math.max(
			this.maxActiveMessages,
			this.activeMessages,
		);
		this.respond(this, message);
	}

	reply(result: MaintenanceResponse): void {
		queueMicrotask(() => {
			this.activeMessages -= 1;
			this.onmessage?.({ data: result } as MessageEvent);
		});
	}

	fail(message: string): void {
		queueMicrotask(() => {
			this.activeMessages -= 1;
			this.onerror?.({ message } as ErrorEvent);
		});
	}

	terminate(): void {
		this.terminateCount += 1;
	}
}

function createLifecycleFactory(
	createWorker: (index: number) => FakeMaintenanceWorker = () =>
		new FakeMaintenanceWorker(),
) {
	const workers: FakeMaintenanceWorker[] = [];
	let revokeCount = 0;
	const factory = () => {
		const worker = createWorker(workers.length);
		workers.push(worker);
		return {
			worker,
			revokeObjectUrl: () => {
				revokeCount += 1;
			},
		};
	};
	return {
		factory,
		workers,
		get revokeCount() {
			return revokeCount;
		},
	};
}

describe("DatabaseOperations.optimizeAsync", () => {
	let tmpDir: string;
	let dbPath: string;
	let dbOps: DatabaseOperationsType;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
		// Constructor runs ensureSchema -> real schema with indexed,
		// never-ANALYZEd tables, so `PRAGMA optimize` on the worker's fresh
		// connection has genuine ANALYZE work to attempt (SQLite >= 3.46
		// analyzes indexed tables that lack sqlite_stat1 entries).
		dbOps = new DatabaseOperations(dbPath);
	});

	afterEach(async () => {
		await dbOps.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves ok (not skipped) on an idle DB and checkpoints the WAL", async () => {
		// Grow the WAL a bit so the checkpoint has frames to flush.
		const writer = new Database(dbPath);
		try {
			writer.exec(
				"CREATE TABLE IF NOT EXISTS optimize_smoke (id INTEGER PRIMARY KEY, v TEXT)",
			);
			const ins = writer.prepare("INSERT INTO optimize_smoke (v) VALUES (?)");
			for (let i = 0; i < 500; i++) ins.run(`val-${i}`);
		} finally {
			writer.close();
		}
		const walBefore = await dbOps.getWalSizeBytes();
		expect(walBefore).toBeGreaterThan(0);

		const result = await dbOps.optimizeAsync();
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("checkpoints with TRUNCATE (not PASSIVE), zeroing the WAL on an idle DB", async () => {
		// Regression for the wal_autocheckpoint=0 migration: the main
		// connection no longer checkpoints on its own, so the off-thread
		// optimize tick is the SOLE reclaimer and must actively zero the WAL
		// (TRUNCATE) rather than merely flush frames without resetting the
		// file (PASSIVE), or the WAL would grow unbounded.
		const writer = new Database(dbPath);
		try {
			writer.exec(
				"CREATE TABLE IF NOT EXISTS optimize_truncate_smoke (id INTEGER PRIMARY KEY, v TEXT)",
			);
			const ins = writer.prepare(
				"INSERT INTO optimize_truncate_smoke (v) VALUES (?)",
			);
			for (let i = 0; i < 500; i++) ins.run(`val-${i}`);
		} finally {
			writer.close();
		}
		expect(await dbOps.getWalSizeBytes()).toBeGreaterThan(0);

		// No open readers/writers at this point, so TRUNCATE can fully reclaim.
		const result = await dbOps.optimizeAsync();
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(false);

		expect(await dbOps.getWalSizeBytes()).toBe(0);
	});

	it("returns skipped:true quickly when another connection holds the write lock (regression: 10s event-loop freeze)", async () => {
		// Simulate the production contention: the hourly incremental-vacuum
		// worker holds SQLite's single writer slot while the 5-minute
		// optimize tick fires. BEGIN IMMEDIATE takes the same write lock.
		const holder = new Database(dbPath);
		try {
			holder.exec("BEGIN IMMEDIATE");

			const start = Date.now();
			const result = await dbOps.optimizeAsync();
			const elapsed = Date.now() - start;

			// The buggy version slept ~10 s (busy_timeout) inside SQLite's C
			// busy handler -- on the main thread. The worker runs with
			// busy_timeout = 0 and reports the contention as a normal skip.
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(true);
			expect(elapsed).toBeLessThan(2000);
		} finally {
			try {
				holder.exec("ROLLBACK");
			} catch {
				// Transaction may already be gone; closing is what matters.
			}
			holder.close();
		}
	});

	it("does not expose the old synchronous optimize() anymore", () => {
		// The sync method was the bug -- it must not silently come back.
		expect(
			(dbOps as unknown as Record<string, unknown>).optimize,
		).toBeUndefined();
	});

	it("keeps the process FD count flat across repeated real worker ticks", async () => {
		const fdDirectory = "/proc/self/fd";
		if (!fs.existsSync(fdDirectory)) return;

		// Warm up first so the persistent Worker's own descriptors are part of
		// the baseline. Subsequent ticks should reuse them, not add one
		// epoll/eventfd/timerfd group per cycle.
		expect((await dbOps.optimizeAsync()).ok).toBe(true);
		const before = fs.readdirSync(fdDirectory).length;
		for (let tick = 0; tick < 200; tick += 1) {
			expect((await dbOps.optimizeAsync()).ok).toBe(true);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		const after = fs.readdirSync(fdDirectory).length;

		expect(after).toBeLessThanOrEqual(before + 2);
	});
});

describe("DatabaseOperations maintenance worker lifecycle", () => {
	let tmpDir: string;
	let dbOps: DatabaseOperationsType | undefined;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(async () => {
		await dbOps?.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function createOps(
		factory: () => {
			worker: FakeMaintenanceWorker;
			revokeObjectUrl?: () => void;
		},
	): DatabaseOperationsType {
		dbOps = new DatabaseOperations(
			path.join(tmpDir, "test.db"),
			undefined,
			undefined,
			factory,
		);
		return dbOps;
	}

	it("uses an injected worker factory lazily", async () => {
		const lifecycle = createLifecycleFactory();
		const ops = createOps(lifecycle.factory);

		expect(lifecycle.workers).toHaveLength(0);
		expect((await ops.optimizeAsync()).ok).toBe(true);
		expect(lifecycle.workers).toHaveLength(1);
	});

	it("reuses one worker for hundreds of calls and never overlaps requests", async () => {
		const lifecycle = createLifecycleFactory();
		const ops = createOps(lifecycle.factory);

		const results = await Promise.all(
			Array.from({ length: 250 }, () => ops.optimizeAsync()),
		);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(lifecycle.workers).toHaveLength(1);
		expect(lifecycle.workers[0]?.messages).toHaveLength(250);
		expect(lifecycle.workers[0]?.maxActiveMessages).toBe(1);
	});

	it("shares the same serialized worker with incremental vacuum", async () => {
		const lifecycle = createLifecycleFactory();
		const ops = createOps(lifecycle.factory);

		await ops.incrementalVacuum(1);
		await ops.optimizeAsync();

		expect(lifecycle.workers).toHaveLength(1);
		expect(lifecycle.workers[0]?.messages).toEqual([
			expect.objectContaining({ kind: "vacuum", pages: 1 }),
			expect.objectContaining({ kind: "optimize" }),
		]);
	});

	it("close terminates the persistent worker and revokes its URL exactly once", async () => {
		const lifecycle = createLifecycleFactory();
		const ops = createOps(lifecycle.factory);
		await ops.optimizeAsync();

		await ops.close();
		await ops.close();

		expect(lifecycle.workers[0]?.terminateCount).toBe(1);
		expect(lifecycle.revokeCount).toBe(1);
	});

	it("close settles an active call before terminating its worker", async () => {
		const lifecycle = createLifecycleFactory(
			() => new FakeMaintenanceWorker(() => undefined),
		);
		const ops = createOps(lifecycle.factory);
		const pending = ops.optimizeAsync();
		await Promise.resolve();
		expect(lifecycle.workers).toHaveLength(1);

		await ops.close();
		const result = await pending;

		expect(result).toMatchObject({
			ok: false,
			skipped: false,
			error: "DatabaseOperations closed during maintenance",
		});
		expect(lifecycle.workers[0]?.terminateCount).toBe(1);
		expect(lifecycle.revokeCount).toBe(1);
	});

	it("replaces a worker after a transport failure and keeps later calls healthy", async () => {
		const lifecycle = createLifecycleFactory((index) =>
			index === 0
				? new FakeMaintenanceWorker((worker) =>
						worker.fail("simulated worker crash"),
					)
				: new FakeMaintenanceWorker(),
		);
		const ops = createOps(lifecycle.factory);

		const failed = await ops.optimizeAsync();
		const recovered = await ops.optimizeAsync();

		expect(failed).toMatchObject({
			ok: false,
			skipped: false,
			error: "simulated worker crash",
		});
		expect(recovered.ok).toBe(true);
		expect(lifecycle.workers).toHaveLength(2);
		expect(lifecycle.workers[0]?.terminateCount).toBe(1);
		expect(lifecycle.revokeCount).toBe(1);
	});
});

describe("incremental-vacuum worker protocol: kind discriminator", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function spawnWorker(): Worker {
		return new Worker(
			new URL("../incremental-vacuum-worker.ts", import.meta.url).href,
		);
	}

	function roundTrip<T>(worker: Worker, message: unknown): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data as T);
			worker.onerror = (event: ErrorEvent) =>
				reject(new Error(event.message ?? "worker error"));
			worker.postMessage(message);
		});
	}

	it("kind-less messages still run the vacuum path (backward compat)", async () => {
		// ensureSchema (via the DatabaseOperations constructor) creates the DB
		// in auto_vacuum=INCREMENTAL mode, which the vacuum path requires.
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; mode?: number }>(worker, {
				dbPath,
				pages: 1,
			});
			expect(result.ok).toBe(true);
			expect(result.mode).toBe(2);
		} finally {
			worker.terminate();
		}
	});

	it('kind "optimize" succeeds on an idle DB without requiring auto_vacuum=2', async () => {
		// optimize/checkpoint has no auto_vacuum precondition -- verify the
		// worker doesn't apply the vacuum path's mode gate to it. Plain DB,
		// auto_vacuum=0.
		{
			const db = new Database(dbPath, { create: true });
			try {
				db.exec("PRAGMA journal_mode = WAL");
				db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, v TEXT)");
				db.exec("CREATE INDEX idx_smoke_v ON smoke(v)");
				db.exec("INSERT INTO smoke (v) VALUES ('a'), ('b'), ('c')");
			} finally {
				db.close();
			}
		}

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; skipped?: boolean }>(
				worker,
				{ dbPath, kind: "optimize" },
			);
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(false);
		} finally {
			worker.terminate();
		}
	});
});

describe("DatabaseOperations embedded maintenance worker lifecycle", () => {
	it("creates and revokes the production Blob URL exactly once on close", async () => {
		const embeddedWorkerCode = Buffer.from(
			"self.onmessage = () => undefined;",
		).toString("base64");
		mock.module("../inline-incremental-vacuum-worker", () => ({
			EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE: embeddedWorkerCode,
		}));
		const { DatabaseOperations: EmbeddedDatabaseOperations } = await import(
			"../database-operations?embedded-worker-url-lifecycle-test"
		);

		const tmpDir = makeTempDir();
		const worker = new FakeMaintenanceWorker();
		const workerUrls: Array<string | URL> = [];
		// biome-ignore lint/complexity/useArrowFunction: the Worker stub must be constructable.
		const WorkerStub = function (url: string | URL) {
			workerUrls.push(url);
			return worker;
		};
		const createObjectUrl = mock(
			(_blob: Blob) => "blob:ccflare-maintenance-worker-test",
		);
		const revokeObjectUrl = mock((_url: string) => undefined);
		const originalWorker = globalThis.Worker;
		const originalCreateObjectUrl = URL.createObjectURL;
		const originalRevokeObjectUrl = URL.revokeObjectURL;
		let ops: DatabaseOperationsType | undefined;

		try {
			globalThis.Worker = WorkerStub as unknown as typeof Worker;
			URL.createObjectURL = createObjectUrl;
			URL.revokeObjectURL = revokeObjectUrl;
			ops = new EmbeddedDatabaseOperations(path.join(tmpDir, "test.db"));

			expect((await ops.optimizeAsync()).ok).toBe(true);
			await ops.close();
			await ops.close();

			expect(createObjectUrl).toHaveBeenCalledTimes(1);
			expect(workerUrls).toEqual(["blob:ccflare-maintenance-worker-test"]);
			expect(worker.terminateCount).toBe(1);
			expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
			expect(revokeObjectUrl).toHaveBeenCalledWith(
				"blob:ccflare-maintenance-worker-test",
			);
		} finally {
			await ops?.close();
			globalThis.Worker = originalWorker;
			URL.createObjectURL = originalCreateObjectUrl;
			URL.revokeObjectURL = originalRevokeObjectUrl;
			mock.module("../inline-incremental-vacuum-worker", () => ({
				EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE: "",
			}));
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
