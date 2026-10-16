import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import "@better-ccflare/core";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";
import {
	isRouteProvenanceColumn,
	ROUTE_PROVENANCE_COLUMNS,
} from "./route-provenance.fixture";

const SORTED = [...ROUTE_PROVENANCE_COLUMNS].sort();

function requestColumns(db: Database): string[] {
	return db
		.query<{ name: string }, []>("PRAGMA table_info(requests)")
		.all()
		.map((r) => r.name);
}

// Every provenance column a schema path produces, found by name rather than by
// the pinned list, so a column added on one path only shows up as a difference.
function provenanceColumns(columns: Iterable<string>): string[] {
	return [...new Set(columns)].filter(isRouteProvenanceColumn).sort();
}

function sqliteFresh(): string[] {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		return provenanceColumns(requestColumns(db));
	} finally {
		db.close();
	}
}

test("SQLite fresh ensureSchema creates exactly the 8 route provenance columns", () => {
	expect(sqliteFresh()).toEqual(SORTED);
});

test("SQLite upgrade adds exactly the 8 route provenance columns and is idempotent", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		// Rebuild an old-shape table: requests minus every provenance column.
		const keep = requestColumns(db).filter((c) => !isRouteProvenanceColumn(c));
		db.run(
			`CREATE TABLE requests_old AS SELECT ${keep.join(", ")} FROM requests`,
		);
		db.run("DROP TABLE requests");
		db.run("ALTER TABLE requests_old RENAME TO requests");
		expect(provenanceColumns(requestColumns(db))).toEqual([]);
		runMigrations(db);
		expect(provenanceColumns(requestColumns(db))).toEqual(SORTED);
		runMigrations(db);
		expect(provenanceColumns(requestColumns(db))).toEqual(SORTED);
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

function pgCreatedColumns(createSql: string[]): string[] {
	const create = createSql.find((s) =>
		/CREATE TABLE IF NOT EXISTS requests\s*\(/.test(s),
	);
	expect(create).toBeDefined();
	const body = (create as string).slice(
		(create as string).indexOf("(") + 1,
		(create as string).lastIndexOf(")"),
	);
	// One column definition per line: `<name> <TYPE> ...`.
	return body
		.split("\n")
		.map((line) => /^\s*([a-z_]\w*)\s+[A-Z]/.exec(line)?.[1])
		.filter((column): column is string => column !== undefined);
}

function pgAlteredColumns(alterSql: string[]): string[] {
	return alterSql
		.map(
			(sql) =>
				/^\s*ALTER TABLE requests ADD COLUMN (?:IF NOT EXISTS )?(\w+)\s/.exec(
					sql,
				)?.[1],
		)
		.filter((column): column is string => column !== undefined);
}

test("PostgreSQL create table carries exactly the 8 route provenance columns", async () => {
	const { createSql } = await capturePgSql();
	const created = pgCreatedColumns(createSql);
	// Guards the parser: it must see the whole table, not just a fragment.
	expect(created).toContain("id");
	expect(created).toContain("routing_attempt_summary");
	expect(provenanceColumns(created)).toEqual(SORTED);
});

test("PostgreSQL upgrade list adds exactly the 8 route provenance columns", async () => {
	const { alterSql } = await capturePgSql();
	const altered = pgAlteredColumns(alterSql);
	expect(altered).toContain("routing_attempt_summary");
	expect(provenanceColumns(altered)).toEqual(SORTED);
});

test("SQLite and PostgreSQL route provenance column sets are identical", async () => {
	const { createSql } = await capturePgSql();
	expect(sqliteFresh()).toEqual(provenanceColumns(pgCreatedColumns(createSql)));
});
