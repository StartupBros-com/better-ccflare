import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import "@better-ccflare/core";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";

const ROUTE_COLUMNS = [
	"route_profile_id",
	"requested_route_model",
	"routed_provider",
	"routed_model",
	"route_fallback_rung",
	"route_home_action",
	"route_repin_reason",
	"route_candidate_id",
];

function requestColumns(db: Database): string[] {
	return db
		.query<{ name: string }, []>("PRAGMA table_info(requests)")
		.all()
		.map((r) => r.name);
}

function routeColumns(columns: string[]): string[] {
	return columns.filter((c) => ROUTE_COLUMNS.includes(c)).sort();
}

const SORTED = [...ROUTE_COLUMNS].sort();

test("SQLite fresh ensureSchema creates all 8 route provenance columns", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		expect(routeColumns(requestColumns(db))).toEqual(SORTED);
	} finally {
		db.close();
	}
});

test("SQLite upgrade adds missing route provenance columns and is idempotent", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		// Rebuild an old-shape table: copy of requests minus the 8 columns.
		const keep = requestColumns(db).filter((c) => !ROUTE_COLUMNS.includes(c));
		db.run(
			`CREATE TABLE requests_old AS SELECT ${keep.join(", ")} FROM requests`,
		);
		db.run("DROP TABLE requests");
		db.run("ALTER TABLE requests_old RENAME TO requests");
		expect(routeColumns(requestColumns(db))).toEqual([]);
		runMigrations(db);
		expect(routeColumns(requestColumns(db))).toEqual(SORTED);
		runMigrations(db);
		expect(routeColumns(requestColumns(db))).toEqual(SORTED);
	} finally {
		db.close();
	}
});

async function capturePgSql() {
	const createSql: string[] = [];
	const alterSql: string[] = [];
	let mode: "fresh" | "upgrade" = "fresh";
	const adapter = {
		// Every column reported missing so runMigrationsPg emits every ALTER.
		get: async () => ({ exists: 0 }),
		unsafe: async (sql: string) => {
			(mode === "fresh" ? createSql : alterSql).push(sql);
			return [];
		},
		run: async () => {},
	} as unknown as BunSqlAdapter;
	await ensureSchemaPg(adapter);
	mode = "upgrade";
	await runMigrationsPg(adapter);
	return { createSql, alterSql };
}

function pgRequestsCreate(createSql: string[]): string {
	const create = createSql.find((s) =>
		/CREATE TABLE IF NOT EXISTS requests\s*\(/.test(s),
	);
	expect(create).toBeDefined();
	return create as string;
}

test("PostgreSQL create table and upgrade list carry the same 8 route provenance columns", async () => {
	const { createSql, alterSql } = await capturePgSql();
	const create = pgRequestsCreate(createSql);
	const created = ROUTE_COLUMNS.filter((c) =>
		new RegExp(`\\b${c}\\s+TEXT`).test(create),
	);
	expect(created.sort()).toEqual(SORTED);
	const altered = ROUTE_COLUMNS.filter((c) =>
		alterSql.includes(`ALTER TABLE requests ADD COLUMN ${c} TEXT`),
	);
	expect(altered.sort()).toEqual(SORTED);
});

test("SQLite and PostgreSQL route provenance column sets are identical", async () => {
	const db = new Database(":memory:");
	let sqliteSet: string[];
	try {
		ensureSchema(db);
		sqliteSet = routeColumns(requestColumns(db));
	} finally {
		db.close();
	}
	const { createSql } = await capturePgSql();
	const create = pgRequestsCreate(createSql);
	const pgSet = [
		...create.matchAll(
			/\b(route_\w+|requested_route_model|routed_provider|routed_model)\s+TEXT/g,
		),
	]
		.map((m) => m[1])
		.sort();
	expect(pgSet).toEqual(SORTED);
	expect(sqliteSet).toEqual(pgSet);
});
