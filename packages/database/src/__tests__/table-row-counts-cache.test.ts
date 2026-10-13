import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { DatabaseOperations } from "../database-operations";
import type { RequestRepository } from "../repositories/request.repository";

let db: DatabaseOperations;
let clock: number;
beforeEach(() => {
	db = new DatabaseOperations(":memory:", { walMode: false });
	clock = Date.now();
	spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(async () => {
	mock.restore();
	await db.close();
});

async function seed() {
	await db
		.getAdapter()
		.run(
			"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts) VALUES ('old', ?, 'POST', '/v1/messages', TRUE, 1, 0)",
			[clock - 60000],
		);
}

describe("table-count cache and deletion observers", () => {
	it("deduplicates scans, caches for sixty seconds, then expires", async () => {
		const get = spyOn(db.getAdapter(), "get");
		const results = await Promise.all([
			db.getTableRowCounts(),
			db.getTableRowCounts(),
			db.getTableRowCounts(),
		]);
		expect(results[1]).toEqual(results[0]);
		expect(results[0].some((row) => row.name === "request_payloads")).toBe(
			true,
		);
		const scans = () =>
			get.mock.calls.filter(([sql]) => sql.includes("SUM(LENGTH(json))"))
				.length;
		expect(scans()).toBe(1);
		clock += 59999;
		await db.getTableRowCounts();
		expect(scans()).toBe(1);
		clock++;
		await db.getTableRowCounts();
		expect(scans()).toBe(2);
	});
	it("drops counts after cleanup and atomic reset", async () => {
		await seed();
		const count = async () =>
			(await db.getTableRowCounts()).find((row) => row.name === "requests")
				?.rowCount;
		expect(await count()).toBe(1);
		await db.cleanupOldRequests(0, 0);
		expect(await count()).toBe(0);
		await seed();
		clock += 60000;
		expect(await count()).toBe(1);
		await db.resetStatistics();
		expect(await count()).toBe(0);
	});
	it("does not cache failed scans", async () => {
		spyOn(db.getAdapter(), "query").mockRejectedValueOnce(
			new Error("scan failed"),
		);
		expect(await db.getTableRowCounts()).toEqual([]);
		expect((await db.getTableRowCounts()).length).toBeGreaterThan(0);
	});
	it("does not let an invalidated in-flight scan repopulate old counts", async () => {
		await seed();
		const adapter = db.getAdapter();
		const original = adapter.get.bind(adapter);
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let captured: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			captured = resolve;
		});
		const spy = spyOn(adapter, "get").mockImplementation(
			async (sql, params) => {
				const value = await original(sql, params);
				if (sql.includes('COUNT(*) AS rowCount FROM "requests"')) {
					captured?.();
					await blocked;
				}
				return value;
			},
		);
		const old = db.getTableRowCounts();
		await started;
		await db.resetStatistics();
		spy.mockRestore();
		const fresh = await db.getTableRowCounts();
		expect(fresh.find((row) => row.name === "requests")?.rowCount).toBe(0);
		release?.();
		await old;
		expect(
			(await db.getTableRowCounts()).find((row) => row.name === "requests")
				?.rowCount,
		).toBe(0);
	});
	it("notifies once for request deletion, not no-op or payload-only cleanup, and supports unsubscribe", async () => {
		let calls = 0;
		const off = db.onRequestsDeleted(() => {
			calls++;
		});
		await seed();
		await db.cleanupOldRequests(0);
		await db.cleanupOldRequests(0, 86400000);
		expect(calls).toBe(0);
		await db.cleanupOldRequests(0, 0);
		expect(calls).toBe(1);
		off();
		await seed();
		await db.cleanupOldRequests(0, 0);
		expect(calls).toBe(1);
	});
	it("invalidates after partial batched deletion and preserves the original failure", async () => {
		await seed();
		let calls = 0;
		db.onRequestsDeleted(() => {
			calls++;
		});
		const repo = (db as unknown as { requests: RequestRepository }).requests;
		const original = repo.deleteOlderThan.bind(repo);
		const failure = new Error("later delete batch failed");
		spyOn(repo, "deleteOlderThan").mockImplementation(async (cutoff) => {
			await original(cutoff);
			throw failure;
		});
		await expect(db.cleanupOldRequests(0, 0)).rejects.toBe(failure);
		expect(calls).toBe(1);
		expect(
			await db.getAdapter().get("SELECT COUNT(*) AS n FROM requests"),
		).toEqual({ n: 0 });
	});
	it("isolates throwing listeners and releases listeners on close", async () => {
		await seed();
		const calls = mock(() => {});
		db.onRequestsDeleted(() => {
			throw new Error("listener failed");
		});
		db.onRequestsDeleted(calls);
		expect((await db.cleanupOldRequests(0, 0)).removedRequests).toBe(1);
		expect(calls).toHaveBeenCalledTimes(1);
		await db.close();
		expect(
			(db as unknown as { requestsDeletedListeners: Set<() => void> })
				.requestsDeletedListeners.size,
		).toBe(0);
	});
});
