import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

function makeIntegerSizeError(): Error {
	return Object.assign(new Error("ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE"), {
		code: "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE",
	});
}

describe("BunSqlAdapter.runReturningOne", () => {
	it("executes one SQLite DML RETURNING statement and returns its row", async () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
			);
			const adapter = new BunSqlAdapter(db);

			const row = await adapter.runReturningOne<{ value_text: string }>(
				`INSERT INTO counters (id, value) VALUES (?, 1)
				 RETURNING CAST(value AS TEXT) AS value_text`,
				["counter-1"],
			);

			expect(row).toEqual({ value_text: "1" });
		} finally {
			db.close();
		}
	});

	it("returns null when conditional SQLite DML returns no row", async () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
			);
			const adapter = new BunSqlAdapter(db);

			await expect(
				adapter.runReturningOne<{ value_text: string }>(
					`UPDATE counters SET value = value + 1
					 WHERE id = ? RETURNING CAST(value AS TEXT) AS value_text`,
					["missing"],
				),
			).resolves.toBeNull();
		} finally {
			db.close();
		}
	});

	it("converts PostgreSQL placeholders and returns the first row", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const fakeSql = {
			unsafe: async (sql: string, params: unknown[]) => {
				calls.push({ sql, params });
				return [{ value_text: "3" }];
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal PostgreSQL client stub
		const adapter = new BunSqlAdapter(fakeSql as any, false);

		await expect(
			adapter.runReturningOne<{ value_text: string }>(
				"UPDATE counters SET value = value + ? RETURNING CAST(value AS TEXT)",
				[1],
			),
		).resolves.toEqual({ value_text: "3" });
		expect(calls).toEqual([
			{
				sql: "UPDATE counters SET value = value + $1 RETURNING CAST(value AS TEXT)",
				params: [1],
			},
		]);
	});

	it("does not retry PostgreSQL returning DML after a decode error", async () => {
		let calls = 0;
		const fakeSql = {
			unsafe: async () => {
				calls += 1;
				throw makeIntegerSizeError();
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal PostgreSQL client stub
		const adapter = new BunSqlAdapter(fakeSql as any, false);

		await expect(
			adapter.runReturningOne(
				"UPDATE counters SET value = value + 1 RETURNING CAST(value AS TEXT)",
			),
		).rejects.toMatchObject({
			code: "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE",
		});
		expect(calls).toBe(1);
	});
});
