import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";

const DEVICE_SETUP_JOB_COLUMNS = [
	"id",
	"idempotency_key",
	"request_fingerprint",
	"provider",
	"account_id",
	"status",
	"routing_selections_json",
	"routing_outcomes_json",
	"routing_cursor",
	"lease_token",
	"lease_expires_at",
	"attempt_count",
	"error_code",
	"error_message",
	"created_at",
	"updated_at",
	"terminal_at",
	"retention_expires_at",
];

const DEVICE_SETUP_JOB_INDEXES = [
	"idx_device_setup_jobs_claim",
	"idx_device_setup_jobs_retention",
	"idx_device_setup_jobs_account",
] as const;

const SENSITIVE_COLUMN_NAMES = [
	"device_code",
	"user_code",
	"verification_url",
	"auth_url",
	"pkce_verifier",
	"access_token",
	"refresh_token",
	"api_key",
	"tokens",
	"credentials",
	"custom_endpoint",
	"endpoint",
	"model_mappings",
	"mappings",
	"provider_response",
	"provider_responses",
	"operation",
	"account_name",
	"priority",
] as const;

function columnInfo(db: Database): Array<{ name: string; notnull: number }> {
	return db
		.query<{ name: string; notnull: number }, []>(
			"PRAGMA table_info(device_setup_jobs)",
		)
		.all();
}

function columnNames(db: Database): string[] {
	return columnInfo(db).map((column) => column.name);
}

function tableSql(db: Database): string {
	return (
		db
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device_setup_jobs'",
			)
			.get()?.sql ?? ""
	);
}

function indexNames(db: Database): string[] {
	return db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'device_setup_jobs'",
		)
		.all()
		.map((row) => row.name);
}

function expectExactDomains(sql: string): void {
	const normalized = sql.replace(/\s+/g, " ");
	expect(normalized).toContain("CHECK (provider IN ('qwen', 'codex'))");
	expect(normalized).toContain(
		"CHECK (status IN ('awaiting_authorization', 'account_committed', 'reconciling', 'complete', 'complete_with_actions', 'authorization_error', 'expired'))",
	);
}

function expectNoSensitiveColumns(columns: readonly string[]): void {
	for (const name of SENSITIVE_COLUMN_NAMES) {
		expect(columns).not.toContain(name);
	}
}

function minimalJob(id: string, idempotencyKey: string): unknown[] {
	return [
		id,
		idempotencyKey,
		`fingerprint-${id}`,
		"qwen",
		`account-${id}`,
		"awaiting_authorization",
		1,
		1,
	];
}

function insertMinimalJob(db: Database, values: unknown[]): void {
	db.run(
		`INSERT INTO device_setup_jobs (
			id, idempotency_key, request_fingerprint, provider, account_id, status,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		values as never[],
	);
}

function captureAdapter(statements: string[]): BunSqlAdapter {
	return {
		get: async () => ({ exists: 1 }),
		run: async (sql: string) => {
			statements.push(sql);
		},
		unsafe: async (sql: string) => {
			statements.push(sql);
		},
	} as unknown as BunSqlAdapter;
}

function deviceSetupTableSql(statements: string[]): string {
	return (
		statements.find((sql) =>
			sql.includes("CREATE TABLE IF NOT EXISTS device_setup_jobs"),
		) ?? ""
	);
}

function expectPostgresDeviceSetupDdl(statements: string[]): void {
	const ddl = deviceSetupTableSql(statements);
	expect(ddl).not.toBe("");
	expectExactDomains(ddl);
	const normalized = ddl.replace(/\s+/g, " ");
	expect(normalized).toContain("idempotency_key TEXT NOT NULL UNIQUE");
	expect(normalized).toContain("retention_expires_at BIGINT");
	expect(normalized).not.toContain("retention_expires_at BIGINT NOT NULL");
	for (const column of DEVICE_SETUP_JOB_COLUMNS) {
		expect(ddl).toMatch(new RegExp(`\\b${column}\\b`));
	}
	for (const name of SENSITIVE_COLUMN_NAMES) {
		expect(ddl).not.toMatch(new RegExp(`\\b${name}\\b`));
	}
	const allSql = statements.join("\n");
	for (const index of DEVICE_SETUP_JOB_INDEXES) {
		expect(allSql).toContain(index);
	}
}

describe("device setup job migrations", () => {
	it("creates the exact security-minimal SQLite schema on fresh install", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);

			const columns = columnNames(db);
			expect(columns).toEqual(DEVICE_SETUP_JOB_COLUMNS);
			expectNoSensitiveColumns(columns);
			expect(
				columnInfo(db).find((column) => column.name === "retention_expires_at"),
			).toMatchObject({ notnull: 0 });
			expectExactDomains(tableSql(db));
			for (const index of DEVICE_SETUP_JOB_INDEXES) {
				expect(indexNames(db)).toContain(index);
			}

			insertMinimalJob(db, minimalJob("job-1", "same-key"));
			expect(() =>
				insertMinimalJob(db, minimalJob("job-2", "same-key")),
			).toThrow();
			expect(() => {
				const invalid = minimalJob("job-3", "provider-key");
				invalid[3] = "anthropic";
				insertMinimalJob(db, invalid);
			}).toThrow();
			expect(() => {
				const invalid = minimalJob("job-4", "status-key");
				invalid[5] = "pending";
				insertMinimalJob(db, invalid);
			}).toThrow();
		} finally {
			db.close();
		}
	});

	it("creates the same SQLite table through the upgrade path", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			db.run("DROP TABLE device_setup_jobs");
			expect(columnNames(db)).toEqual([]);

			runMigrations(db);

			const columns = columnNames(db);
			expect(columns).toEqual(DEVICE_SETUP_JOB_COLUMNS);
			expectNoSensitiveColumns(columns);
			expect(
				columnInfo(db).find((column) => column.name === "retention_expires_at"),
			).toMatchObject({ notnull: 0 });
			expectExactDomains(tableSql(db));
			for (const index of DEVICE_SETUP_JOB_INDEXES) {
				expect(indexNames(db)).toContain(index);
			}
		} finally {
			db.close();
		}
	});

	it("emits matching security-minimal PostgreSQL DDL for fresh and upgrade paths", async () => {
		const freshStatements: string[] = [];
		await ensureSchemaPg(captureAdapter(freshStatements));
		expectPostgresDeviceSetupDdl(freshStatements);

		const upgradeStatements: string[] = [];
		await runMigrationsPg(captureAdapter(upgradeStatements));
		expectPostgresDeviceSetupDdl(upgradeStatements);

		expect(
			deviceSetupTableSql(freshStatements).replace(/\s+/g, " ").trim(),
		).toBe(deviceSetupTableSql(upgradeStatements).replace(/\s+/g, " ").trim());
	});
});
