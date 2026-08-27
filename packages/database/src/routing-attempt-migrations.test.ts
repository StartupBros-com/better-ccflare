import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSchema, runMigrations } from "./migrations";
import { ROUTING_ATTEMPT_REASONS } from "./routing-attempt-taxonomy";

const expectedColumns = [
	"id",
	"parent_request_id",
	"timestamp",
	"provider",
	"account_id",
	"attempted_model",
	"model_family",
	"status_code",
	"reason",
	"scope",
	"available_at",
	"failover_attempts",
	"physical_attempt",
	"account_benched",
	"route_suppressed",
	"circuit_counted",
	"upstream_evidence",
];

const expectedIndexes = [
	"idx_routing_attempts_timestamp",
	"idx_routing_attempts_parent_timestamp",
	"idx_routing_attempts_reason_scope_timestamp",
	"idx_routing_attempts_account_timestamp",
];

const expectedReasons = [
	"extra_usage_exhausted",
	"upstream_402_payment_required",
	"windowless_429",
	"model_fallback_429",
	"model_scoped_429",
	"out_of_credits",
	"upstream_429_with_reset",
	"xai_capacity_402",
	"upstream_429_no_reset_probe_cooldown",
	"upstream_529_overloaded_with_reset",
	"upstream_529_overloaded_no_reset",
	"all_models_exhausted_429",
];

function insertAttempt(
	db: Database,
	{
		id,
		reason,
		physicalAttempt,
	}: {
		id: string;
		reason: string;
		physicalAttempt: number | null;
	},
): void {
	db.prepare(`INSERT INTO routing_attempts (
		id, parent_request_id, timestamp, provider, account_id, attempted_model,
		model_family, status_code, reason, scope, available_at, failover_attempts,
		physical_attempt, account_benched, route_suppressed, circuit_counted
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		id,
		"parent",
		1,
		"anthropic",
		"account",
		"model",
		"family",
		429,
		reason,
		"model",
		null,
		0,
		physicalAttempt,
		0,
		0,
		0,
	);
}

function columns(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(routing_attempts)").all() as Array<{
			name: string;
		}>
	).map(({ name }) => name);
}

function indexes(db: Database): string[] {
	return (
		db.prepare("PRAGMA index_list(routing_attempts)").all() as Array<{
			name: string;
		}>
	).map(({ name }) => name);
}

describe("routing_attempts migrations", () => {
	it("creates the bounded append-only table and indexes on a fresh SQLite database", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			runMigrations(db);

			expect(columns(db)).toEqual(expectedColumns);
			expect(indexes(db)).toEqual(expect.arrayContaining(expectedIndexes));
			expect(
				db.prepare("PRAGMA foreign_key_list(routing_attempts)").all(),
			).toEqual([]);

			const prohibited = [
				"payload",
				"error_body",
				"token",
				"cost",
				"api_key",
				"client",
				"session",
				"agent",
				"project",
				"user",
			];
			expect(
				columns(db).filter((column) =>
					prohibited.some((term) => column.includes(term)),
				),
			).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("restricts reasons to audited writers and requires one-based physical ordinals", () => {
		expect(ROUTING_ATTEMPT_REASONS).toEqual(expectedReasons);
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			for (const [index, reason] of expectedReasons.entries()) {
				insertAttempt(db, {
					id: `accepted-${index}`,
					reason,
					physicalAttempt: index === 0 ? null : 1,
				});
			}

			for (const reason of [
				"upstream_429_no_reset_default_5h",
				"not_a_routing_attempt_reason",
			]) {
				expect(() =>
					insertAttempt(db, {
						id: `rejected-${reason}`,
						reason,
						physicalAttempt: 1,
					}),
				).toThrow();
			}

			expect(() =>
				insertAttempt(db, {
					id: "zero-ordinal",
					reason: expectedReasons[0],
					physicalAttempt: 0,
				}),
			).toThrow();
		} finally {
			db.close();
		}
	});

	it("adds the table to a legacy SQLite database without moving request history", () => {
		const db = new Database(":memory:");
		try {
			db.run(`CREATE TABLE requests (
			id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, method TEXT NOT NULL,
			path TEXT NOT NULL, account_used TEXT, status_code INTEGER, success BOOLEAN,
			error_message TEXT, response_time_ms INTEGER, failover_attempts INTEGER DEFAULT 0
		)`);
			db.run(
				"INSERT INTO requests VALUES ('terminal-before-upgrade', 1, 'POST', '/v1/messages', NULL, 200, 1, NULL, 1, 0)",
			);

			runMigrations(db);

			expect(columns(db)).toEqual(expectedColumns);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM requests").get(),
			).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("repairs an interrupted SQLite migration where the table exists but indexes do not", () => {
		const db = new Database(":memory:");
		try {
			db.run(`CREATE TABLE routing_attempts (
			id TEXT PRIMARY KEY, parent_request_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
			provider TEXT NOT NULL, account_id TEXT NOT NULL, attempted_model TEXT,
			model_family TEXT, status_code INTEGER NOT NULL, reason TEXT NOT NULL,
			scope TEXT NOT NULL, available_at INTEGER, failover_attempts INTEGER NOT NULL,
			physical_attempt INTEGER, account_benched INTEGER NOT NULL,
			route_suppressed INTEGER NOT NULL, circuit_counted INTEGER NOT NULL
		)`);

			runMigrations(db);
			expect(columns(db)).toEqual(expectedColumns);
			expect(indexes(db)).toEqual(expect.arrayContaining(expectedIndexes));
		} finally {
			db.close();
		}
	});

	it("is idempotent across repeated SQLite schema and upgrade calls", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			runMigrations(db);
			ensureSchema(db);
			runMigrations(db);
			expect(columns(db)).toEqual(expectedColumns);
			expect(indexes(db)).toEqual(expect.arrayContaining(expectedIndexes));
		} finally {
			db.close();
		}
	});

	it("keeps PostgreSQL fresh and upgrade paths in exact logical parity", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "migrations-pg.ts"),
			"utf8",
		);
		for (const column of expectedColumns) {
			expect(source).toContain(column);
		}
		for (const index of expectedIndexes) {
			expect(source).toContain(index);
		}
		expect(source).toContain('table: "routing_attempts"');
		expect(source).toContain('column: "upstream_evidence"');
		expect(source).toContain(
			"ALTER TABLE routing_attempts ADD COLUMN upstream_evidence TEXT",
		);
		const pgTable = source.match(
			/CREATE TABLE IF NOT EXISTS routing_attempts \(([\s\S]*?)\n\t\t\)/,
		)?.[1];
		expect(pgTable).toBeDefined();
		expect(pgTable).not.toContain("FOREIGN KEY");
		const sqliteSource = fs.readFileSync(
			path.join(__dirname, "migrations.ts"),
			"utf8",
		);
		for (const migrationSource of [source, sqliteSource]) {
			expect(migrationSource).toContain(
				'import { ROUTING_ATTEMPT_REASON_SQL } from "./routing-attempt-taxonomy";',
			);
		}
		expect(pgTable).toContain(
			"reason TEXT NOT NULL CHECK (reason IN ($" +
				"{ROUTING_ATTEMPT_REASON_SQL}))",
		);
		expect(pgTable).toContain(
			"physical_attempt INTEGER CHECK (physical_attempt IS NULL OR physical_attempt >= 1)",
		);
		for (const prohibited of [
			"payload",
			"error_body",
			"token",
			"cost",
			"api_key",
			"client",
			"session",
			"agent",
			"project",
			"user",
		]) {
			expect(pgTable).not.toContain(prohibited);
		}
		expect(source).toMatch(
			/export async function ensureSchemaPg[\s\S]*ensureRoutingAttemptsSchemaPg\(adapter\)/,
		);
		expect(source).toMatch(
			/export async function runMigrationsPg[\s\S]*ensureRoutingAttemptsSchemaPg\(adapter\)/,
		);
	});
});
