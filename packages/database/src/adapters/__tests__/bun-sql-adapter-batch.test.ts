import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

describe("BunSqlAdapter checked DML batches", () => {
	let db: Database | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	it("rolls back SQLite when a statement affects an unexpected number of rows", async () => {
		db = new Database(":memory:");
		db.run("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.run("INSERT INTO records (id, value) VALUES ('one', 'before')");
		const adapter = new BunSqlAdapter(db);

		await expect(
			adapter.runBatchWithChanges([
				{
					sql: "UPDATE records SET value = ? WHERE id = ?",
					params: ["after", "one"],
					expectedChanges: 1,
				},
				{
					sql: "DELETE FROM records WHERE id = ?",
					params: ["missing"],
					expectedChanges: 1,
				},
			]),
		).rejects.toThrow("Batch statement 2 expected 1 change(s), got 0");

		expect(
			db
				.query<{ value: string }, []>(
					"SELECT value FROM records WHERE id = 'one'",
				)
				.get(),
		).toEqual({ value: "before" });
	});

	it("throws inside the PostgreSQL transaction callback on a count mismatch", async () => {
		let transactionRolledBack = false;
		let statementIndex = 0;
		const tx = {
			unsafe: async () => ({ count: statementIndex++ === 0 ? 1 : 0 }),
		};
		const fakeSql = {
			begin: async (
				callback: (transaction: typeof tx) => Promise<number[]>,
			) => {
				try {
					return await callback(tx);
				} catch (error) {
					transactionRolledBack = true;
					throw error;
				}
			},
			on: () => {},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal Bun.SQL transaction fake
		const adapter = new BunSqlAdapter(fakeSql as any, false);

		await expect(
			adapter.runBatchWithChanges([
				{
					sql: "UPDATE records SET value = ?",
					params: ["after"],
					expectedChanges: 1,
				},
				{
					sql: "DELETE FROM records WHERE id = ?",
					params: ["missing"],
					expectedChanges: 1,
				},
			]),
		).rejects.toThrow("Batch statement 2 expected 1 change(s), got 0");
		expect(transactionRolledBack).toBe(true);
	});
});
