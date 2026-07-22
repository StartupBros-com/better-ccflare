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

	it("counts only direct SQLite changes when an audit trigger also writes", async () => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE revision (value INTEGER NOT NULL);
			INSERT INTO records (id, value) VALUES ('one', 'before');
			INSERT INTO revision (value) VALUES (0);
			CREATE TRIGGER bump_revision AFTER UPDATE ON records
			BEGIN
				UPDATE revision SET value = value + 1;
			END;
		`);
		const adapter = new BunSqlAdapter(db);

		expect(
			await adapter.runBatchWithChanges([
				{
					sql: "UPDATE records SET value = ? WHERE id = ?",
					params: ["after", "one"],
					expectedChanges: 1,
				},
			]),
		).toEqual([1]);
		expect(
			db.query<{ value: number }, []>("SELECT value FROM revision").get(),
		).toEqual({ value: 1 });
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
