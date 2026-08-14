import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

/**
 * Wraps the adapter so a test can assert the fleet read issues ONE query for
 * the whole fleet rather than one per account — the entire point of #137.
 */
function countingAdapter(db: Database): {
	adapter: BunSqlAdapter;
	queries: () => number;
} {
	const adapter = new BunSqlAdapter(db);
	let count = 0;
	const realQuery = adapter.query.bind(adapter);
	adapter.query = (async <R>(sql: string, params?: unknown[]) => {
		count++;
		return realQuery<R>(sql, params);
	}) as typeof adapter.query;
	return { adapter, queries: () => count };
}

async function seed(
	repo: UsageHistoryRepository,
	accountId: string,
	windowKey: string,
	stamps: number[],
	utilization = 10,
): Promise<void> {
	for (const ts of stamps) {
		await repo.recordSnapshot(
			accountId,
			[canonicalWindow(windowKey, utilization)],
			ts,
		);
	}
}

/**
 * Build the canonical window shape directly rather than via a provider
 * normalizer: this repository is provider-agnostic on purpose, so its tests
 * should not need to know which provider happens to emit a given window key.
 */
function canonicalWindow(
	windowKey: string,
	utilization: number,
): CanonicalUsageWindow {
	return {
		windowKey,
		utilization,
		resetsAtMs: null,
		scope: "account",
		modelFamily: null,
		active: true,
	};
}

describe("UsageHistoryRepository.getFleetUsageHistory", () => {
	it("reads the whole fleet with a single query", async () => {
		const db = makeDb();
		const { adapter, queries } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [1000, 2000]);
		await seed(repo, "acc2", "five_hour", [1000, 2000]);
		await seed(repo, "acc3", "five_hour", [1000, 2000]);

		const before = queries();
		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2", "acc3"],
		});

		expect(queries() - before).toBe(1);
		expect(result.rows).toHaveLength(6);
		expect(result.truncated).toBe(false);
		expect(result.returnedPointCount).toBe(6);
		db.close();
	});

	it("returns only the requested accounts", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "five_hour", [1000]);
		await seed(repo, "acc2", "five_hour", [1000]);

		const result = await repo.getFleetUsageHistory({ accountIds: ["acc1"] });
		expect([...new Set(result.rows.map((r) => r.accountId))]).toEqual(["acc1"]);
		db.close();
	});

	it("returns an empty result without querying when no accounts are requested", async () => {
		const db = makeDb();
		const { adapter, queries } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [1000]);

		const before = queries();
		const result = await repo.getFleetUsageHistory({ accountIds: [] });

		// `IN ()` is a syntax error on both dialects — the guard must short-circuit.
		expect(queries() - before).toBe(0);
		expect(result.rows).toEqual([]);
		expect(result.truncated).toBe(false);
		expect(result.returnedPointCount).toBe(0);
		db.close();
	});

	it("filters by windowKey across the fleet", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "five_hour", [1000]);
		await seed(repo, "acc1", "seven_day", [1000]);
		await seed(repo, "acc2", "seven_day", [1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2"],
			windowKey: "seven_day",
		});
		expect(result.rows.map((r) => r.windowKey)).toEqual([
			"seven_day",
			"seven_day",
		]);
		db.close();
	});

	it("honours since/until bounds", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "five_hour", [1000, 2000, 3000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1"],
			since: 1500,
			until: 2500,
		});
		expect(result.rows.map((r) => r.timestamp)).toEqual([2000]);
		db.close();
	});

	it("buckets in SQL onto a shared grid so accounts align", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		// Two accounts polled at different instants inside the same 1000ms bucket.
		await seed(repo, "acc1", "five_hour", [10_100, 10_400], 20);
		await seed(repo, "acc2", "five_hour", [10_600, 10_900], 40);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2"],
			bucketMs: 1000,
		});

		// One bucket-start per account, and the SAME bucket-start for both.
		expect(result.rows).toHaveLength(2);
		expect([...new Set(result.rows.map((r) => r.timestamp))]).toEqual([10_000]);
		expect(result.rows.find((r) => r.accountId === "acc1")?.utilization).toBe(
			20,
		);
		expect(result.rows.find((r) => r.accountId === "acc2")?.utilization).toBe(
			40,
		);
		db.close();
	});

	it("orders deterministically by account, window, then timestamp", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		// Insert deliberately out of order; ordering must not depend on row order.
		await seed(repo, "acc2", "seven_day", [2000]);
		await seed(repo, "acc1", "seven_day", [1000]);
		await seed(repo, "acc1", "five_hour", [3000, 1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc2", "acc1"],
		});
		expect(
			result.rows.map((r) => `${r.accountId}/${r.windowKey}/${r.timestamp}`),
		).toEqual([
			"acc1/five_hour/1000",
			"acc1/five_hour/3000",
			"acc1/seven_day/1000",
			"acc2/seven_day/2000",
		]);
		db.close();
	});

	it("drops whole series past the point budget and reports the truncation", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		// acc1 is newest (ts 5000) so it survives; acc2 (ts 1000) is dropped.
		await seed(repo, "acc1", "five_hour", [4000, 5000]);
		await seed(repo, "acc2", "five_hour", [500, 1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2"],
			pointBudget: 2,
		});

		expect(result.rows.map((r) => r.accountId)).toEqual(["acc1", "acc1"]);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(1);
		expect(result.omittedAccountCount).toBe(1);
		expect(result.returnedPointCount).toBe(2);
		db.close();
	});

	it("never keeps a lower-ranked series in place of one that did not fit", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		// Rank is by recency: acc1 (9000) > acc2 (5200) > acc3 (1000).
		await seed(repo, "acc1", "five_hour", [9000]);
		await seed(repo, "acc2", "five_hour", [5000, 5100, 5200]);
		await seed(repo, "acc3", "five_hour", [1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2", "acc3"],
			pointBudget: 3,
		});

		// acc1 fits. acc2 does not. Admitting acc3 afterwards purely because it is
		// smaller would drop higher-priority data to keep lower-priority data and
		// make the result depend on row counts rather than rank, so the included
		// set must stay a strict prefix of the ranking.
		expect([...new Set(result.rows.map((r) => r.accountId))]).toEqual(["acc1"]);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(2);
		expect(result.omittedAccountCount).toBe(2);
		db.close();
	});

	it("still returns the newest series when it alone exceeds the budget", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "five_hour", [1000, 2000, 3000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1"],
			pointBudget: 1,
		});

		// Returning zero series would render as "fleet has no data", which is a lie.
		expect(result.rows).toHaveLength(3);
		expect(result.truncated).toBe(false);
		expect(result.omittedSeriesCount).toBe(0);
		db.close();
	});

	it("keeps an account whose other window survived out of omittedAccountCount", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "five_hour", [9000]);
		await seed(repo, "acc1", "seven_day", [100]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1"],
			pointBudget: 1,
		});

		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(1);
		// acc1 still has a surviving series, so no account was fully omitted.
		expect(result.omittedAccountCount).toBe(0);
		db.close();
	});

	it("prioritises the explicitly requested window over newer other windows", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "acc1", "seven_day", [9000]);
		await seed(repo, "acc1", "five_hour", [100]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1"],
			windowKey: "five_hour",
			pointBudget: 1,
		});

		expect(result.rows.map((r) => r.windowKey)).toEqual(["five_hour"]);
		db.close();
	});
});
