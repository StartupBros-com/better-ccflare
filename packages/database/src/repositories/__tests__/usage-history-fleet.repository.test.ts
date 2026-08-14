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
	observations: () => {
		sql: string;
		params: unknown[];
		returnedRowCount: number;
	}[];
} {
	const adapter = new BunSqlAdapter(db);
	let count = 0;
	const observations: {
		sql: string;
		params: unknown[];
		returnedRowCount: number;
	}[] = [];
	const realQuery = adapter.query.bind(adapter);
	adapter.query = (async <R>(sql: string, params?: unknown[]) => {
		count++;
		const rows = await realQuery<R>(sql, params);
		observations.push({
			sql,
			params: [...(params ?? [])],
			returnedRowCount: rows.length,
		});
		return rows;
	}) as typeof adapter.query;
	return { adapter, queries: () => count, observations: () => observations };
}

function positionalSlots(sql: string): number[] {
	return [
		...new Set([...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]))),
	].sort((a, b) => a - b);
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

	it("keeps duplicate requested account ids as set membership", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc1"],
		});

		expect(result.rows.map((row) => row.accountId)).toEqual(["acc1"]);
		expect(result.returnedPointCount).toBe(1);
		expect(result.truncated).toBe(false);
		expect(observations().at(-1)?.sql).toContain(
			"SELECT DISTINCT CAST(value AS TEXT) AS account_id FROM json_each(?1)",
		);
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

	it("returns zero summary counts when requested accounts have no history", async () => {
		const db = makeDb();
		const repo = new UsageHistoryRepository(new BunSqlAdapter(db));
		await seed(repo, "other-account", "five_hour", [1000]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["missing-account"],
		});

		expect(result).toEqual({
			rows: [],
			truncated: false,
			omittedAccountCount: 0,
			omittedSeriesCount: 0,
			returnedPointCount: 0,
		});
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

	it("keeps window and time filters sargable on the composite index", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [1000, 2000, 3000]);

		await repo.getFleetUsageHistory({
			accountIds: ["acc1"],
			windowKey: "five_hour",
			since: 1500,
			until: 2500,
		});

		const observation = observations().at(-1);
		expect(observation?.params).toHaveLength(5);
		expect(positionalSlots(observation?.sql ?? "")).toEqual([1, 2, 3, 4, 5]);
		const plan = await adapter.query<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${observation?.sql ?? ""}`,
			observation?.params ?? [],
		);
		const snapshotSearches = plan
			.map((row) => row.detail)
			.filter((detail) => detail.includes("idx_usage_snapshots_acct_win_time"));
		expect(snapshotSearches.length).toBeGreaterThanOrEqual(2);
		expect(
			snapshotSearches.every((detail) =>
				/\(account_id=\? AND window_key=\? AND timestamp>\? AND timestamp<\?\)/.test(
					detail,
				),
			),
		).toBe(true);
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

	it("uses an explicit bytewise tie-break for equal-recency series", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		// UTF-8 byte order is uppercase ASCII, lowercase ASCII, then non-ASCII.
		// Locale-backed PostgreSQL collations can order the accented id near "e"
		// instead, selecting a different strict prefix unless both dialects pin
		// their bytewise collation explicitly.
		for (const accountId of ["acct-é", "acct-a", "acct-Z"]) {
			await seed(repo, accountId, "five_hour", [5000]);
		}

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acct-é", "acct-a", "acct-Z"],
			pointBudget: 2,
		});

		expect(result.rows.map((row) => row.accountId)).toEqual([
			"acct-Z",
			"acct-a",
		]);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(1);
		expect(result.omittedAccountCount).toBe(1);
		expect(
			observations()
				.at(-1)
				?.sql.match(/account_id COLLATE BINARY ASC/g),
		).toHaveLength(2);
		expect(
			observations()
				.at(-1)
				?.sql.match(/window_key COLLATE BINARY ASC/g),
		).toHaveLength(2);
		db.close();
	});

	it("drops whole series past the point budget and reports the truncation", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
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
		// The point budget must bound rows at the adapter boundary, not after the
		// repository has already materialized every omitted series in JavaScript.
		expect(observations().at(-1)?.returnedRowCount).toBe(2);
		db.close();
	});

	it("never keeps a lower-ranked series in place of one that did not fit", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
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
		expect(observations().at(-1)?.returnedRowCount).toBe(1);
		db.close();
	});

	it("still returns the newest series when it alone exceeds the budget", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [1000, 2000, 3000]);
		await seed(repo, "acc2", "five_hour", [500]);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2"],
			pointBudget: 1,
		});

		// Returning zero series would render as "fleet has no data", which is a lie.
		expect(result.rows).toHaveLength(3);
		expect(result.rows.every((row) => row.accountId === "acc1")).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(1);
		expect(result.omittedAccountCount).toBe(1);
		expect(observations().at(-1)?.returnedRowCount).toBe(3);
		db.close();
	});

	it("selects a strict prefix by bucket count before aggregating selected series", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		// Bucketed rank/count: acc1 has 1 newest bucket, acc2 has 3 buckets and
		// does not fit after acc1, while lower-ranked acc3 would fit. The result
		// must stop at acc2 and materialize only acc1's selected aggregate row.
		await seed(repo, "acc1", "five_hour", [9_100, 9_200], 10);
		await seed(repo, "acc2", "five_hour", [5_100, 6_100, 7_100], 20);
		await seed(repo, "acc3", "five_hour", [1_100], 30);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2", "acc3"],
			bucketMs: 1000,
			pointBudget: 3,
		});

		expect(result.rows.map((row) => row.accountId)).toEqual(["acc1"]);
		expect(result.rows[0]?.timestamp).toBe(9000);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(2);
		expect(result.omittedAccountCount).toBe(2);
		expect(result.returnedPointCount).toBe(1);
		const observation = observations().at(-1);
		expect(observation?.returnedRowCount).toBe(1);
		expect(observation?.params).toHaveLength(3);
		expect(positionalSlots(observation?.sql ?? "")).toEqual([1, 2, 3]);
		expect(observation?.sql).not.toMatch(/\?(?!\d)/);
		db.close();
	});

	it("keeps the top bucketed series whole when its bucket count exceeds the budget", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		await seed(repo, "acc1", "five_hour", [7_100, 8_100, 9_100], 10);
		await seed(repo, "acc2", "five_hour", [1_100], 20);

		const result = await repo.getFleetUsageHistory({
			accountIds: ["acc1", "acc2"],
			bucketMs: 1000,
			pointBudget: 1,
		});

		expect(result.rows.map((row) => row.timestamp)).toEqual([7000, 8000, 9000]);
		expect(result.rows.every((row) => row.accountId === "acc1")).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.omittedSeriesCount).toBe(1);
		expect(result.omittedAccountCount).toBe(1);
		expect(result.returnedPointCount).toBe(3);
		expect(observations().at(-1)?.returnedRowCount).toBe(3);
		db.close();
	});

	it("uses a constant number of bind parameters for large account fleets", async () => {
		const db = makeDb();
		const { adapter, observations } = countingAdapter(db);
		const repo = new UsageHistoryRepository(adapter);
		const accountIds = Array.from(
			{ length: 1500 },
			(_, index) => `account-${index}`,
		);
		await seed(repo, accountIds.at(-1) ?? "", "five_hour", [1000]);
		await repo.getFleetUsageHistory({
			accountIds: [accountIds.at(-1) ?? ""],
			pointBudget: 10,
		});
		const smallFleetParamCount = observations().at(-1)?.params.length;

		const result = await repo.getFleetUsageHistory({
			accountIds,
			pointBudget: 10,
		});

		const observation = observations().at(-1);
		expect(result.rows.map((row) => row.accountId)).toEqual([
			accountIds.at(-1),
		]);
		expect(observation?.params.length).toBe(smallFleetParamCount);
		expect(observation?.params.length).toBe(2);
		expect(positionalSlots(observation?.sql ?? "")).toEqual([1, 2]);
		expect(observation?.sql).toContain("json_each(?1)");
		expect(observation?.sql).not.toMatch(/\?(?!\d)/);
		expect(observation?.params[0]).toBe(JSON.stringify(accountIds));
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
