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
			unsafe: async (sql: string) => {
				freshStatements.push(sql);
			},
		} as unknown as BunSqlAdapter;
		await ensureSchemaPg(freshAdapter);
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
	});
});
