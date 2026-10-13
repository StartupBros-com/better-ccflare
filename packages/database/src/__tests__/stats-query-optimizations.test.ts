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
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { StatsRepository } from "../repositories/stats.repository";

let db: Database;
let adapter: BunSqlAdapter;
let stats: StatsRepository;
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	adapter = new BunSqlAdapter(db);
	stats = new StatsRepository(adapter);
});
afterEach(() => {
	mock.restore();
	db.close();
});
function request(
	id: string,
	timestamp: number,
	account: string | null,
	error: string | null = null,
	success = true,
) {
	db.run(
		"INSERT INTO requests (id, timestamp, method, path, account_used, error_message, success, model) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?)",
		[id, timestamp, account, error, success, id],
	);
}

describe("stats query optimizations", () => {
	it("selects tied error groups deterministically before LIMIT and tied latest rows by id", async () => {
		request("z", 20, null, "alpha", false);
		request("a", 20, null, "alpha", false);
		request("old", 10, null, "alpha", false);
		request("b", 20, null, "beta", false);
		request("outside", 1, null, "alpha", false);
		const first = await stats.getRecentErrorGroups(1, 1);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			errorCode: "alpha",
			latestRequestId: "a",
			occurrenceCount: 3,
			firstTimestamp: 10,
			model: "a",
		});
		expect(
			(await stats.getRecentErrorGroups(1, 2)).map(
				(row) => row.latestRequestId,
			),
		).toEqual(["a", "b"]);
	});
	it("preserves NULL/legacy account success rates with an indexable predicate", async () => {
		request("null-success", 10, null);
		// Foreign keys enforce new writes; legacy rows predate that enforcement.
		db.exec("PRAGMA foreign_keys = OFF");
		request("legacy-fail", 10, "no_account", null, false);
		const query = spyOn(adapter, "query");
		expect(await stats.getAccountStats()).toEqual([
			{
				name: "no_account",
				requestCount: 2,
				successRate: 50,
				totalRequests: 0,
			},
		]);
		expect(query.mock.calls[1]?.[0]).toContain("account_used IN (");
		expect(query.mock.calls[1]?.[0]).not.toContain("WHERE COALESCE");
	});
	it("combines unattributed errors but keeps attributed groups separate", async () => {
		db.run(
			"INSERT INTO accounts (id, name, created_at, provider) VALUES ('acct', 'Account', 1, 'fixture')",
		);
		db.exec("PRAGMA foreign_keys = OFF");
		request("a", 20, null, "same", false);
		request("b", 10, "no_account", "same", false);
		request("c", 20, "acct", "same", false);
		const rows = await stats.getRecentErrorGroups(0);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.accountId === null)?.occurrenceCount).toBe(2);
		expect(rows.find((row) => row.accountId === "acct")).toMatchObject({
			occurrenceCount: 1,
			accountName: "Account",
			provider: "fixture",
		});
	});
	it("computes per-id rates across renamed keys in one query without dropping malformed legacy groups", async () => {
		request("1", 10, null);
		request("2", 10, null, null, false);
		request("3", 10, null);
		db.run(
			"UPDATE requests SET api_key_id = 'key', api_key_name = 'Before' WHERE id = '1'",
		);
		db.run(
			"UPDATE requests SET api_key_id = 'key', api_key_name = 'After' WHERE id = '2'",
		);
		db.run(
			"UPDATE requests SET api_key_id = '', api_key_name = 'Legacy' WHERE id = '3'",
		);
		const query = spyOn(adapter, "query");
		const result = await stats.getApiKeyStats();
		expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ id: "key", name: "After", requests: 1, successRate: 50 },
			{ id: "key", name: "Before", requests: 1, successRate: 50 },
			{ id: "", name: "Legacy", requests: 1, successRate: 0 },
		]);
		expect(query).toHaveBeenCalledTimes(1);
		db.run("DELETE FROM requests WHERE api_key_id = 'key'");
		expect(await stats.getApiKeyStats()).toEqual([]);
	});
	it("uses all model counts for percentages even when the output is limited", async () => {
		request("1", 10, null);
		request("2", 10, null);
		request("3", 10, null);
		request("4", 10, null);
		db.run("UPDATE requests SET model = 'common' WHERE id IN ('1','2')");
		db.run("UPDATE requests SET model = NULL WHERE id = '4'");
		expect(await stats.getTopModels(1)).toEqual([
			{ model: "common", count: 2, percentage: 66.67 },
		]);
	});
});
