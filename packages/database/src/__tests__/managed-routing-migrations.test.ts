import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";

function columnNames(db: Database, table: string): string[] {
	return db
		.query<{ name: string }, [string]>(`SELECT name FROM pragma_table_info(?)`)
		.all(table)
		.map((column) => column.name);
}

function routingRevision(db: Database): number {
	return (
		db
			.query<{ revision: number }, []>(
				"SELECT revision FROM routing_policy_revision WHERE scope = 'global'",
			)
			.get()?.revision ?? -1
	);
}

describe("managed routing migrations", () => {
	it("creates equivalent SQLite policy columns, constraints, indexes, and cascades", () => {
		const db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		ensureSchema(db);

		const assignmentColumns = db
			.query<{ name: string; notnull: number; dflt_value: string | null }, []>(
				"PRAGMA table_info(combo_family_assignments)",
			)
			.all();
		expect(
			assignmentColumns.find((column) => column.name === "membership_mode"),
		).toMatchObject({
			name: "membership_mode",
			notnull: 1,
			dflt_value: "'manual'",
		});
		expect(
			assignmentColumns.some((column) => column.name === "managed_model"),
		).toBe(true);

		expect(columnNames(db, "combo_enrollment_rules")).toEqual([
			"id",
			"family",
			"combo_id",
			"provider",
			"route_class",
			"enabled",
			"created_at",
			"updated_at",
		]);
		expect(columnNames(db, "combo_membership_exclusions")).toEqual([
			"id",
			"family",
			"combo_id",
			"account_id",
			"created_at",
		]);

		const indexes = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('combo_enrollment_rules', 'combo_membership_exclusions')",
			)
			.all()
			.map((row) => row.name);
		expect(indexes).toContain("idx_combo_enrollment_rules_unique");
		expect(indexes).toContain("idx_combo_enrollment_rules_combo_id");
		expect(indexes).toContain("idx_combo_membership_exclusions_unique");
		expect(indexes).toContain("idx_combo_membership_exclusions_account_id");

		expect(() =>
			db.run(
				"UPDATE combo_family_assignments SET membership_mode = 'automatic' WHERE family = 'opus'",
			),
		).toThrow();
		db.close();
	});

	it("tracks every SQLite preview-hash input without token-rotation churn", () => {
		const db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);

		expect(columnNames(db, "routing_policy_revision")).toEqual([
			"scope",
			"revision",
		]);
		expect(routingRevision(db)).toBe(0);
		const triggerNames = new Set(
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_routing_revision_%'",
				)
				.all()
				.map((row) => row.name),
		);
		for (const table of [
			"combos",
			"combo_slots",
			"combo_family_assignments",
			"combo_enrollment_rules",
			"combo_membership_exclusions",
		]) {
			for (const operation of ["insert", "update", "delete"]) {
				expect(triggerNames).toContain(
					`trg_routing_revision_${table}_${operation}`,
				);
			}
		}
		expect(triggerNames).toContain("trg_routing_revision_accounts_insert");
		expect(triggerNames).toContain("trg_routing_revision_accounts_update");
		expect(triggerNames).toContain("trg_routing_revision_accounts_delete");

		const expectBump = (mutate: () => void) => {
			const before = routingRevision(db);
			mutate();
			expect(routingRevision(db)).toBeGreaterThan(before);
		};
		expectBump(() =>
			db.run(
				"INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, priority) VALUES ('account-r', 'routing', 'anthropic', 'first', 'first-access', 1, 0)",
			),
		);
		expectBump(() =>
			db.run(
				"INSERT INTO combos (id, name, enabled, created_at, updated_at) VALUES ('combo-r', 'routing', 1, 1, 1)",
			),
		);
		expectBump(() =>
			db.run(
				"INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES ('slot-r', 'combo-r', 'account-r', 'claude-opus-4-7', 0, 1)",
			),
		);
		expectBump(() =>
			db.run(
				"UPDATE combo_family_assignments SET combo_id = 'combo-r', enabled = 1 WHERE family = 'opus'",
			),
		);
		expectBump(() =>
			db.run(
				"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES ('rule-r', 'opus', 'combo-r', 'anthropic', 'oauth-subscription', 1, 1, 1)",
			),
		);
		expectBump(() =>
			db.run(
				"INSERT INTO combo_membership_exclusions (id, family, combo_id, account_id, created_at) VALUES ('exclusion-r', 'opus', 'combo-r', 'account-r', 1)",
			),
		);
		expectBump(() =>
			db.run("UPDATE accounts SET priority = 1 WHERE id = 'account-r'"),
		);
		for (const sql of [
			"UPDATE accounts SET provider = 'xai' WHERE id = 'account-r'",
			"UPDATE accounts SET billing_type = 'plan' WHERE id = 'account-r'",
			"UPDATE accounts SET model_mappings = '{\"opus\":\"mapped\"}' WHERE id = 'account-r'",
			"UPDATE accounts SET model_fallbacks = '{\"opus\":\"fallback\"}' WHERE id = 'account-r'",
			"UPDATE accounts SET custom_endpoint = 'https://routing.example' WHERE id = 'account-r'",
		]) {
			expectBump(() => db.run(sql));
		}

		const beforeRotation = routingRevision(db);
		db.run(
			"UPDATE accounts SET refresh_token = 'rotated', access_token = 'rotated-access' WHERE id = 'account-r'",
		);
		expect(routingRevision(db)).toBe(beforeRotation);
		const beforeUsageOnly = routingRevision(db);
		db.run("UPDATE accounts SET request_count = 99 WHERE id = 'account-r'");
		expect(routingRevision(db)).toBe(beforeUsageOnly);
		expectBump(() =>
			db.run("UPDATE accounts SET refresh_token = NULL WHERE id = 'account-r'"),
		);
		expectBump(() => db.run("DELETE FROM combo_membership_exclusions"));
		expectBump(() => db.run("DELETE FROM combo_enrollment_rules"));
		db.close();
	});

	it("tracks SQLite legacy-mirrored credential shape without secret-rotation churn", () => {
		const db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		db.run(
			"INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"legacy-shape",
				"legacy shape",
				"openai-compatible",
				"shape-a",
				"shape-a",
				"shape-a",
				1,
			],
		);

		const expectRevisionDelta = (expected: number, mutate: () => void) => {
			const before = routingRevision(db);
			mutate();
			expect(routingRevision(db) - before).toBe(expected);
		};

		// Exact mirror -> contradictory same-presence shape changes route class.
		expectRevisionDelta(1, () =>
			db.run("UPDATE accounts SET access_token = ? WHERE id = ?", [
				"shape-b",
				"legacy-shape",
			]),
		);
		// Contradictory -> contradictory rotation remains the same durable shape.
		expectRevisionDelta(0, () =>
			db.run("UPDATE accounts SET access_token = ? WHERE id = ?", [
				"shape-c",
				"legacy-shape",
			]),
		);
		// Contradictory -> exact mirror restores the API-key route class.
		expectRevisionDelta(1, () =>
			db.run(
				"UPDATE accounts SET refresh_token = api_key, access_token = api_key WHERE id = ?",
				["legacy-shape"],
			),
		);
		// Exact mirror -> a different exact mirror is ordinary secret rotation.
		expectRevisionDelta(0, () =>
			db.run(
				"UPDATE accounts SET api_key = ?, refresh_token = ?, access_token = ? WHERE id = ?",
				["shape-d", "shape-d", "shape-d", "legacy-shape"],
			),
		);
		// Presence transitions retain the existing revision behavior.
		expectRevisionDelta(1, () =>
			db.run("UPDATE accounts SET access_token = NULL WHERE id = ?", [
				"legacy-shape",
			]),
		);
		expectRevisionDelta(1, () =>
			db.run("UPDATE accounts SET access_token = api_key WHERE id = ?", [
				"legacy-shape",
			]),
		);

		// Exact mirror equality is not a route-class input for OAuth providers.
		db.run(
			"INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"oauth-shape",
				"oauth shape",
				"anthropic",
				"shape-o",
				"shape-o",
				"shape-o",
				1,
			],
		);
		expectRevisionDelta(0, () =>
			db.run("UPDATE accounts SET access_token = ? WHERE id = ?", [
				"shape-p",
				"oauth-shape",
			]),
		);
		db.close();
	});

	it("upgrades explicit-only SQLite data to manual policy without changing combos or slots", () => {
		const db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		ensureSchema(db);

		// Reconstruct the actual pre-managed-routing shape. Starting from today's
		// schema is convenient, but every U1 table/column must be absent before the
		// migration runs or this test only exercises idempotency.
		db.run("DROP TABLE combo_membership_exclusions");
		db.run("DROP TABLE combo_enrollment_rules");
		for (const column of ["managed_model", "membership_mode"]) {
			if (columnNames(db, "combo_family_assignments").includes(column)) {
				db.run(`ALTER TABLE combo_family_assignments DROP COLUMN ${column}`);
			}
		}
		expect(columnNames(db, "combo_enrollment_rules")).toEqual([]);
		expect(columnNames(db, "combo_membership_exclusions")).toEqual([]);
		expect(columnNames(db, "combo_family_assignments")).not.toContain(
			"membership_mode",
		);
		expect(columnNames(db, "combo_family_assignments")).not.toContain(
			"managed_model",
		);
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('account-1', 'one', 'anthropic', 1)",
		);
		db.run(
			"INSERT INTO combos (id, name, enabled, created_at, updated_at) VALUES ('combo-1', 'existing', 1, 1, 1)",
		);
		db.run(
			"INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES ('slot-1', 'combo-1', 'account-1', 'claude-opus-4-6', 7, 1)",
		);
		db.run(
			"UPDATE combo_family_assignments SET combo_id = 'combo-1', enabled = 1 WHERE family = 'opus'",
		);
		const comboBefore = db
			.query<
				{
					id: string;
					name: string;
					description: string | null;
					enabled: number;
					created_at: number;
					updated_at: number;
				},
				[]
			>(
				"SELECT id, name, description, enabled, created_at, updated_at FROM combos ORDER BY id",
			)
			.all();
		const slotsBefore = db
			.query<
				{
					id: string;
					combo_id: string;
					account_id: string;
					model: string;
					priority: number;
					enabled: number;
				},
				[]
			>(
				"SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots ORDER BY id",
			)
			.all();

		runMigrations(db);

		expect(
			db
				.query<
					{
						combo_id: string;
						enabled: number;
						membership_mode: string;
						managed_model: string | null;
					},
					[]
				>(
					"SELECT combo_id, enabled, membership_mode, managed_model FROM combo_family_assignments WHERE family = 'opus'",
				)
				.get(),
		).toEqual({
			combo_id: "combo-1",
			enabled: 1,
			membership_mode: "manual",
			managed_model: null,
		});
		expect(
			db
				.query(
					"SELECT id, name, description, enabled, created_at, updated_at FROM combos ORDER BY id",
				)
				.all(),
		).toEqual(comboBefore);
		expect(
			db
				.query(
					"SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots ORDER BY id",
				)
				.all(),
		).toEqual(slotsBefore);

		expect(() =>
			db.run(
				"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES ('blank-provider', 'opus', 'combo-1', '   ', 'oauth-subscription', 1, 1, 1)",
			),
		).toThrow();
		expect(() =>
			db.run(
				"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES ('bad-route', 'opus', 'combo-1', 'anthropic', 'unknown', 1, 1, 1)",
			),
		).toThrow();
		expect(() =>
			db.run(
				"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES ('bad-enabled', 'opus', 'combo-1', 'anthropic', 'oauth-subscription', 2, 1, 1)",
			),
		).toThrow();

		db.run(
			"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES ('rule-1', 'opus', 'combo-1', 'anthropic', 'oauth-subscription', 1, 1, 1)",
		);
		db.run(
			"INSERT INTO combo_membership_exclusions (id, family, combo_id, account_id, created_at) VALUES ('exclusion-1', 'opus', 'combo-1', 'account-1', 1)",
		);
		db.run("DELETE FROM accounts WHERE id = 'account-1'");
		expect(
			db.query("SELECT id FROM combo_membership_exclusions").all(),
		).toEqual([]);
		db.run("DELETE FROM combos WHERE id = 'combo-1'");
		expect(db.query("SELECT id FROM combo_enrollment_rules").all()).toEqual([]);
		expect(
			db
				.query<{ combo_id: string | null }, []>(
					"SELECT combo_id FROM combo_family_assignments WHERE family = 'opus'",
				)
				.get(),
		).toEqual({ combo_id: null });
		db.close();
	});

	it("emits matching PostgreSQL fresh and upgrade policy DDL", async () => {
		const freshStatements: string[] = [];
		const freshAdapter = {
			get: async () => ({ exists: 1 }),
			run: async (sql: string) => {
				freshStatements.push(sql);
			},
			unsafe: async (sql: string) => {
				freshStatements.push(sql);
			},
		} as unknown as BunSqlAdapter;
		await ensureSchemaPg(freshAdapter);
		expect(freshStatements.join("\n")).not.toContain(
			"CREATE TRIGGER trg_routing_revision_accounts_update",
		);
		await runMigrationsPg(freshAdapter);
		const freshSql = freshStatements.join("\n");
		expect(freshSql).toContain(
			"membership_mode TEXT NOT NULL DEFAULT 'manual'",
		);
		expect(freshSql).toContain(
			"CREATE TABLE IF NOT EXISTS combo_enrollment_rules",
		);
		expect(freshSql).toContain(
			"CREATE TABLE IF NOT EXISTS combo_membership_exclusions",
		);
		expect(freshSql).toContain("idx_combo_enrollment_rules_unique");
		expect(freshSql).toContain("idx_combo_membership_exclusions_unique");
		expect(freshSql).toContain(
			"CREATE TABLE IF NOT EXISTS routing_policy_revision",
		);
		expect(freshSql).toContain(
			"CREATE OR REPLACE FUNCTION bump_routing_policy_revision",
		);
		for (const table of [
			"combos",
			"combo_slots",
			"combo_family_assignments",
			"combo_enrollment_rules",
			"combo_membership_exclusions",
		]) {
			expect(freshSql).toContain(
				`CREATE TRIGGER trg_routing_revision_${table}`,
			);
		}
		expect(freshSql).toContain(
			"CREATE TRIGGER trg_routing_revision_accounts_insert_delete",
		);
		expect(freshSql).toContain(
			"CREATE TRIGGER trg_routing_revision_accounts_update",
		);
		const accountTriggerSql = freshStatements
			.find((statement) =>
				statement.includes(
					"CREATE TRIGGER trg_routing_revision_accounts_update",
				),
			)
			?.replace(/\s+/g, " ");
		expect(accountTriggerSql).toContain(
			"OLD.refresh_token = OLD.api_key AND OLD.access_token = OLD.api_key",
		);
		expect(accountTriggerSql).toContain(
			"NEW.refresh_token = NEW.api_key AND NEW.access_token = NEW.api_key",
		);
		expect(accountTriggerSql).toContain(
			"COALESCE(OLD.provider IN ('claude-console-api', 'zai', 'minimax', 'anthropic-compatible', 'openai-compatible', 'nanogpt', 'kilo', 'openrouter', 'alibaba-coding-plan', 'ollama-cloud'), FALSE)",
		);
		expect(accountTriggerSql).toContain(
			"COALESCE(NEW.provider IN ('claude-console-api', 'zai', 'minimax', 'anthropic-compatible', 'openai-compatible', 'nanogpt', 'kilo', 'openrouter', 'alibaba-coding-plan', 'ollama-cloud'), FALSE)",
		);
		expect(accountTriggerSql).toContain("IS DISTINCT FROM");

		const upgradeStatements: string[] = [];
		const upgradeAdapter = {
			get: async (_sql: string, params: unknown[]) => ({
				exists:
					params[0] === "combo_family_assignments" &&
					(params[1] === "membership_mode" || params[1] === "managed_model")
						? 0
						: 1,
			}),
			unsafe: async (sql: string) => {
				upgradeStatements.push(sql);
				return [];
			},
			run: async (sql: string) => {
				upgradeStatements.push(sql);
			},
		} as unknown as BunSqlAdapter;
		await runMigrationsPg(upgradeAdapter);
		const upgradeSql = upgradeStatements.join("\n");
		expect(upgradeSql).toContain(
			"ALTER TABLE combo_family_assignments ADD COLUMN membership_mode TEXT NOT NULL DEFAULT 'manual'",
		);
		expect(upgradeSql).toContain(
			"ALTER TABLE combo_family_assignments ADD COLUMN managed_model TEXT",
		);
		expect(upgradeSql).toContain(
			"CREATE TABLE IF NOT EXISTS combo_enrollment_rules",
		);
		expect(upgradeSql).toContain(
			"CREATE TABLE IF NOT EXISTS combo_membership_exclusions",
		);
		expect(upgradeSql).toContain(
			"CREATE TABLE IF NOT EXISTS routing_policy_revision",
		);
		expect(upgradeSql).toContain(
			"CREATE OR REPLACE FUNCTION bump_routing_policy_revision",
		);
	});

	it("migrates truly old PostgreSQL account columns before installing the routing revision trigger", async () => {
		const accountColumns = new Set([
			"id",
			"name",
			"provider",
			"api_key",
			"refresh_token",
			"access_token",
			"created_at",
			"priority",
			"custom_endpoint",
		]);
		const triggerColumns = [
			"id",
			"provider",
			"priority",
			"billing_type",
			"model_mappings",
			"model_fallbacks",
			"custom_endpoint",
			"api_key",
			"refresh_token",
			"access_token",
		];
		let accountUpdateTriggerInstalls = 0;
		const adapter = {
			get: async (_sql: string, params: unknown[]) => {
				const [table, column] = params as [string, string];
				return {
					exists: table === "accounts" ? Number(accountColumns.has(column)) : 1,
				};
			},
			unsafe: async (sql: string) => {
				const normalized = sql.replace(/\s+/g, " ").trim();
				const addedAccountColumn = normalized.match(
					/^ALTER TABLE accounts ADD COLUMN ([a-z_]+)/i,
				)?.[1];
				if (addedAccountColumn) accountColumns.add(addedAccountColumn);
				if (
					normalized.includes(
						"CREATE TRIGGER trg_routing_revision_accounts_update",
					)
				) {
					const missing = triggerColumns.filter(
						(column) => !accountColumns.has(column),
					);
					if (missing.length > 0) {
						throw new Error(
							`routing revision trigger references missing account columns: ${missing.join(", ")}`,
						);
					}
					accountUpdateTriggerInstalls++;
				}
				return [];
			},
			run: async () => undefined,
		} as unknown as BunSqlAdapter;

		await ensureSchemaPg(adapter);
		await runMigrationsPg(adapter);

		expect(accountUpdateTriggerInstalls).toBe(1);
		for (const column of triggerColumns) {
			expect(accountColumns).toContain(column);
		}
	});
});
