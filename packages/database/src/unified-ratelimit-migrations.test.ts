import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { runMigrations } from "./migrations";
import { RequestRepository } from "./repositories/request.repository";

const columns = (db: Database) =>
	(db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map(
		(c) => c.name,
	);

it("adds requests.unified_ratelimit_headers on fresh and upgraded SQLite databases", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		expect(columns(db)).toContain("unified_ratelimit_headers");
		db.run("ALTER TABLE requests DROP COLUMN unified_ratelimit_headers");
		runMigrations(db);
		expect(columns(db)).toContain("unified_ratelimit_headers");
	} finally {
		db.close();
	}
});

it("declares the same column in the PostgreSQL create table and upgrade list", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "migrations-pg.ts"),
		"utf8",
	);
	expect(source).toMatch(/^\s+unified_ratelimit_headers TEXT,$/m);
	expect(source).toContain('["unified_ratelimit_headers", "TEXT"]');
});

it("persists the headers JSON and keeps the first value on a re-save", async () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		const repo = new RequestRepository(new BunSqlAdapter(db));
		const data = {
			id: "u1",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1,
			failoverAttempts: 0,
		};
		await repo.save({ ...data, unifiedRatelimitHeaders: '{"a":"1"}' });
		await repo.save({ ...data, unifiedRatelimitHeaders: null });
		await repo.save({ ...data, id: "u2" });
		const get = (id: string) =>
			(
				db
					.query(
						"SELECT unified_ratelimit_headers AS v FROM requests WHERE id = ?",
					)
					.get(id) as { v: string | null }
			).v;
		expect(get("u1")).toBe('{"a":"1"}');
		expect(get("u2")).toBeNull();
	} finally {
		db.close();
	}
});
