import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { SQL } from "bun";
// Avoid the pre-existing types/core initialization cycle.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { StatsRepository } from "../repositories/stats.repository";

let db: Database;
let adapter: BunSqlAdapter;
let stats: StatsRepository;

beforeEach(() => {
	db = new Database(":memory:");
	// Nullable legacy names and request ids exercise the existing query contract.
	db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, request_count INTEGER, total_requests INTEGER);
		CREATE TABLE requests (id TEXT PRIMARY KEY, account_used TEXT, success BOOLEAN)`);
	adapter = new BunSqlAdapter(db);
	stats = new StatsRepository(adapter);
});
afterEach(() => {
	mock.restore();
	db.close();
});

function account(id: string, name: string | null, count = 1) {
	db.run("INSERT INTO accounts VALUES (?, ?, ?, 9)", [id, name, count]);
}

function request(
	id: string | null,
	accountId: string | null,
	success: number | null = 1,
) {
	db.run("INSERT INTO requests VALUES (?, ?, ?)", [id, accountId, success]);
}

describe("SQLite lifetime account aggregation", () => {
	it("uses one query and keeps orphan counts out of NULL/literal success rates", async () => {
		request("null", null);
		request("legacy", "no_account", 0);
		request("orphan", "missing", 0);
		const query = spyOn(adapter, "query");
		expect(await stats.getAccountStats()).toEqual([
			{
				name: "no_account",
				requestCount: 3,
				successRate: 50,
				totalRequests: 0,
			},
		]);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("returns zero for orphan-only rates and handles empty history and zero limit", async () => {
		account("unused", "Unused", 99);
		expect(await stats.getAccountStats()).toEqual([]);
		request("orphan", "missing");
		expect(await stats.getAccountStats()).toEqual([
			{ name: "no_account", requestCount: 1, successRate: 0, totalRequests: 0 },
		]);
		expect(await stats.getAccountStats(0)).toEqual([]);
	});

	it("shares sentinel rates across display groups before LIMIT and preserves NULL-id contributions", async () => {
		account("no_account", "Reserved", 7);
		request(null, "no_account", 0);
		request("literal", "no_account");
		request("null1", null);
		request("null2", null);
		request("orphan", "missing", 0);
		expect(await stats.getAccountStats(1)).toEqual([
			{
				name: "no_account",
				requestCount: 3,
				successRate: 75,
				totalRequests: 0,
			},
		]);
		expect(
			(await stats.getAccountStats(2)).map((row) => row.successRate),
		).toEqual([75, 75]);
		db.run("DELETE FROM requests WHERE id = 'literal'");
		expect(await stats.getAccountStats()).toEqual([
			{
				name: "no_account",
				requestCount: 3,
				successRate: 67,
				totalRequests: 0,
			},
		]);
		request("null-success", null, null);
		expect((await stats.getAccountStats())[0]?.successRate).toBe(50);
	});

	it("keeps renamed and duplicate account names separate while coalescing legacy NULL names", async () => {
		account("a", "Before");
		account("b", "Same");
		account("c", null);
		request("a1", "a");
		request("a2", "a", 0);
		request("a3", "a");
		request("b1", "b", 0);
		request("b2", "b");
		request("c1", "c");
		db.run("UPDATE accounts SET name = 'Same' WHERE id = 'a'");
		expect(await stats.getAccountStats()).toEqual([
			{ name: "Same", requestCount: 3, successRate: 67, totalRequests: 9 },
			{ name: "Same", requestCount: 2, successRate: 50, totalRequests: 9 },
			{
				name: "no_account",
				requestCount: 1,
				successRate: 100,
				totalRequests: 9,
			},
		]);
	});

	it("combines a real sentinel account with the fallback when their names match", async () => {
		account("no_account", "no_account");
		request("literal", "no_account", 0);
		request("null", null);
		expect(await stats.getAccountStats()).toEqual([
			{
				name: "no_account",
				requestCount: 2,
				successRate: 50,
				totalRequests: 9,
			},
		]);
	});

	it("leaves authenticated-only selection based on account counters", async () => {
		account("counter", "Counter only", 99);
		account("history", "History only", 0);
		request("h1", "history");
		request("h2", "history", 0);
		expect(await stats.getAccountStats(10, false)).toEqual([
			{
				name: "Counter only",
				requestCount: 99,
				successRate: 0,
				totalRequests: 9,
			},
		]);
		expect((await stats.getAccountStats())[0]?.name).toBe("History only");
		expect(await stats.getAccountStats(0, false)).toEqual([]);
	});

	it("leaves PostgreSQL grouping, parameters and numeric coercion on the existing path", async () => {
		const unsafe = mock(
			async () =>
				[
					{ id: "a", name: "Account", requestCount: "3", totalRequests: "9" },
				] as unknown[],
		);
		unsafe.mockResolvedValueOnce([
			{ id: "a", name: "Account", requestCount: "3", totalRequests: "9" },
		]);
		unsafe.mockResolvedValueOnce([
			{ accountId: "a", total: "3", successful: "2" },
		]);
		const pg = new BunSqlAdapter(
			{ unsafe } as unknown as InstanceType<typeof SQL>,
			false,
		);
		const query = spyOn(pg, "query");
		expect(await new StatsRepository(pg).getAccountStats()).toEqual([
			{ name: "Account", requestCount: 3, successRate: 67, totalRequests: 9 },
		]);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[0]?.[0]).toContain("GROUP BY 1, 2");
		expect(query.mock.calls[1]?.[1]).toEqual(["no_account", "a"]);
		expect(query.mock.calls[1]?.[0]).toContain("account_used IN (?)");
	});

	it("uses a single covering request scan with the existing migrated indexes", async () => {
		const indexed = new Database(":memory:");
		try {
			ensureSchema(indexed);
			runMigrations(indexed);
			indexed.run(
				"INSERT INTO requests (id, timestamp, method, path, success) VALUES ('old', 1, 'POST', '/v1/messages', TRUE)",
			);
			const indexedAdapter = new BunSqlAdapter(indexed);
			const query = spyOn(indexedAdapter, "query");
			expect(
				(await new StatsRepository(indexedAdapter).getAccountStats())[0]
					?.requestCount,
			).toBe(1);
			expect(query).toHaveBeenCalledTimes(1);
			const call = query.mock.calls[0];
			expect(call).toBeDefined();
			if (!call) throw new Error("Expected account aggregation query");
			const plan = indexed
				.query(`EXPLAIN QUERY PLAN ${call[0]}`)
				.all(...(call[1] as (string | number)[])) as { detail: string }[];
			const requestScans = plan.filter((row) =>
				/SCAN (?:requests|r) USING COVERING INDEX/.test(row.detail),
			);
			expect(requestScans).toHaveLength(1);
			expect(requestScans[0]?.detail).toContain("COVERING INDEX");
		} finally {
			indexed.close();
		}
	});
});
