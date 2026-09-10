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
	"route_fallback_rung",
	"route_candidate_id",
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
	"org_permission_denied",
];

/**
 * The allowlist as it existed before `org_permission_denied` was added.
 * Used to build a legacy `routing_attempts` table (below) that models an
 * existing installation created before this migration, so the reason
 * CHECK-constraint upgrade path can be exercised against real stale SQL
 * rather than the current schema.
 */
const legacyReasons = expectedReasons.filter(
	(reason) => reason !== "org_permission_denied",
);

/**
 * Build a `routing_attempts` table exactly as a pre-upgrade installation
 * would have it: every column already migrated in (matching
 * `expectedColumns`), but the reason CHECK constraint still pinned to
 * `legacyReasons`. Deliberately does not call `ensureSchema`/`runMigrations`
 * for this — the whole point is to prove the upgrade path handles real
 * stale SQL, not the current schema under a different name.
 */
function createLegacyRoutingAttemptsTable(
	db: Database,
	reasons: readonly string[],
): void {
	const reasonSql = reasons.map((reason) => `'${reason}'`).join(", ");
	db.run(`
		CREATE TABLE routing_attempts (
			id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
			parent_request_id TEXT NOT NULL CHECK (length(parent_request_id) BETWEEN 1 AND 128),
			timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
			provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
			account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
			attempted_model TEXT CHECK (attempted_model IS NULL OR length(attempted_model) BETWEEN 1 AND 512),
			model_family TEXT CHECK (model_family IS NULL OR length(model_family) BETWEEN 1 AND 128),
			status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
			reason TEXT NOT NULL CHECK (reason IN (${reasonSql})),
			scope TEXT NOT NULL CHECK (scope IN ('account', 'family', 'model', 'request')),
			available_at INTEGER CHECK (available_at IS NULL OR available_at >= 0),
			failover_attempts INTEGER NOT NULL CHECK (failover_attempts >= 0),
			physical_attempt INTEGER CHECK (physical_attempt IS NULL OR physical_attempt >= 1),
			account_benched INTEGER NOT NULL CHECK (account_benched IN (0, 1)),
			route_suppressed INTEGER NOT NULL CHECK (route_suppressed IN (0, 1)),
			circuit_counted INTEGER NOT NULL CHECK (circuit_counted IN (0, 1)),
			upstream_evidence TEXT CHECK (upstream_evidence IS NULL OR length(upstream_evidence) <= 2048),
			route_fallback_rung TEXT,
			route_candidate_id TEXT
		)
	`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_routing_attempts_timestamp
		 ON routing_attempts(timestamp DESC, id DESC)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_routing_attempts_parent_timestamp
		 ON routing_attempts(parent_request_id, timestamp ASC, id ASC)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_routing_attempts_reason_scope_timestamp
		 ON routing_attempts(reason, scope, timestamp DESC)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_routing_attempts_account_timestamp
		 ON routing_attempts(account_id, timestamp DESC)`,
	);
}

function allRoutingAttemptRows(db: Database): unknown[] {
	return db.prepare("SELECT * FROM routing_attempts ORDER BY id ASC").all();
}

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

	it("upgrades an existing SQLite reason constraint to accept a newly allowlisted reason without losing rows", () => {
		const db = new Database(":memory:");
		try {
			createLegacyRoutingAttemptsTable(db, legacyReasons);
			insertAttempt(db, {
				id: "pre-existing-1",
				reason: "extra_usage_exhausted",
				physicalAttempt: 1,
			});
			insertAttempt(db, {
				id: "pre-existing-2",
				reason: "windowless_429",
				physicalAttempt: null,
			});

			// Red: the legacy constraint rejects the new reason before migrating.
			expect(() =>
				insertAttempt(db, {
					id: "rejected-before-migration",
					reason: "org_permission_denied",
					physicalAttempt: 1,
				}),
			).toThrow();

			const beforeRows = allRoutingAttemptRows(db);

			runMigrations(db);

			// Green: the same reason is now accepted post-migration.
			expect(() =>
				insertAttempt(db, {
					id: "accepted-after-migration",
					reason: "org_permission_denied",
					physicalAttempt: 1,
				}),
			).not.toThrow();

			// Every pre-existing row survived migration with identical values.
			const afterRows = allRoutingAttemptRows(db).filter(
				(row) => (row as { id: string }).id !== "accepted-after-migration",
			);
			expect(afterRows).toEqual(beforeRows);
		} finally {
			db.close();
		}
	});

	it("still rejects unrelated invalid reasons after the SQLite reason-constraint upgrade", () => {
		const db = new Database(":memory:");
		try {
			createLegacyRoutingAttemptsTable(db, legacyReasons);
			runMigrations(db);

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
		} finally {
			db.close();
		}
	});

	it("is idempotent when the SQLite reason-constraint upgrade runs twice, preserving indexes and no foreign keys", () => {
		const db = new Database(":memory:");
		try {
			createLegacyRoutingAttemptsTable(db, legacyReasons);
			insertAttempt(db, {
				id: "row-1",
				reason: "extra_usage_exhausted",
				physicalAttempt: 1,
			});

			runMigrations(db);
			const afterFirstRun = allRoutingAttemptRows(db);
			runMigrations(db);
			const afterSecondRun = allRoutingAttemptRows(db);

			expect(afterSecondRun).toEqual(afterFirstRun);
			expect(
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM routing_attempts")
						.get() as {
						count: number;
					}
				).count,
			).toBe(1);
			expect(columns(db)).toEqual(expectedColumns);
			expect(indexes(db)).toEqual(expect.arrayContaining(expectedIndexes));
			expect(
				db.prepare("PRAGMA foreign_key_list(routing_attempts)").all(),
			).toEqual([]);
			expect(() =>
				insertAttempt(db, {
					id: "row-2",
					reason: "org_permission_denied",
					physicalAttempt: 1,
				}),
			).not.toThrow();
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
			// Formatting-tolerant: matches a single- or multi-line named import,
			// with any number of sibling symbols, as long as it pulls
			// ROUTING_ATTEMPT_REASON_SQL from the shared taxonomy module. This is
			// what actually guarantees the SQLite and PostgreSQL reason lists
			// can't drift — the exact import text/formatting is incidental.
			const importMatch = migrationSource.match(
				/import\s*\{([^}]*)\}\s*from\s*["']\.\/routing-attempt-taxonomy["'];/,
			);
			expect(importMatch).not.toBeNull();
			const importedSymbols = (importMatch?.[1] ?? "")
				.split(",")
				.map((symbol) => symbol.trim())
				.filter(Boolean);
			expect(importedSymbols).toContain("ROUTING_ATTEMPT_REASON_SQL");
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
