import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";
import { ComboRepository } from "../repositories/combo.repository";

const configuredPostgresUrl = process.env.BETTER_CCFLARE_TEST_POSTGRES_URL;

function requireSafeTestPostgresUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
		url.hostname,
	);
	const isTestDatabase = /(?:^|[_-])test(?:$|[_-])/i.test(databaseName);
	if (!isLoopback || !isTestDatabase) {
		throw new Error(
			"BETTER_CCFLARE_TEST_POSTGRES_URL must target a loopback-hosted database with 'test' in its name",
		);
	}
	return url.toString();
}

const postgresUrl = configuredPostgresUrl
	? requireSafeTestPostgresUrl(configuredPostgresUrl)
	: undefined;
const describePostgres = postgresUrl ? describe : describe.skip;

async function withDisposableDatabase(
	test: (adapter: BunSqlAdapter) => Promise<void>,
): Promise<void> {
	if (!postgresUrl) throw new Error("PostgreSQL integration URL is required");
	const databaseName = `ccflare_managed_${randomUUID().replaceAll("-", "")}`;
	const adminSql = new SQL({ url: postgresUrl, max: 1, prepare: false });
	const databaseUrl = new URL(postgresUrl);
	databaseUrl.pathname = `/${databaseName}`;
	let adapter: BunSqlAdapter | undefined;
	let databaseCreated = false;
	let primaryError: unknown;
	let hasPrimaryError = false;
	try {
		await adminSql.unsafe(`CREATE DATABASE ${databaseName}`);
		databaseCreated = true;
		const sql = new SQL({
			url: databaseUrl.toString(),
			max: 4,
			prepare: false,
		});
		adapter = new BunSqlAdapter(sql, false);
		await test(adapter);
	} catch (error) {
		hasPrimaryError = true;
		primaryError = error;
	}

	const cleanupErrors: unknown[] = [];
	try {
		await adapter?.close();
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (databaseCreated) {
		try {
			await adminSql.unsafe(
				`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
			);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		await adminSql.end();
	} catch (error) {
		cleanupErrors.push(error);
	}

	if (hasPrimaryError) {
		if (primaryError instanceof Error && cleanupErrors.length > 0) {
			(primaryError as Error & { cleanupErrors?: unknown[] }).cleanupErrors =
				cleanupErrors;
		}
		throw primaryError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "PostgreSQL test cleanup failed");
	}
}

async function seedPolicyBase(adapter: BunSqlAdapter): Promise<void> {
	await adapter.run(
		"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
		["account-1", "one", "openai", 1],
	);
	await adapter.run(
		"INSERT INTO combos (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		["combo-1", "primary", 1, 1, 1],
	);
	await adapter.run(
		"INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)",
		["slot-1", "combo-1", "account-1", "manual-model", 9, 1],
	);
}

interface PolicyIndexRow {
	name: string;
	is_unique: boolean;
	columns: string;
}

async function policyIndexes(
	adapter: BunSqlAdapter,
): Promise<PolicyIndexRow[]> {
	return adapter.query<PolicyIndexRow>(
		`SELECT index_class.relname AS name,
			index_meta.indisunique AS is_unique,
			string_agg(attribute.attname, ',' ORDER BY index_key.ordinality) AS columns
		 FROM pg_class table_class
		 JOIN pg_index index_meta ON index_meta.indrelid = table_class.oid
		 JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
		 JOIN LATERAL unnest(index_meta.indkey) WITH ORDINALITY
			AS index_key(attnum, ordinality) ON TRUE
		 JOIN pg_attribute attribute
			ON attribute.attrelid = table_class.oid
			AND attribute.attnum = index_key.attnum
		 WHERE table_class.relname IN ('combo_enrollment_rules', 'combo_membership_exclusions')
			AND index_class.relname LIKE 'idx_combo_%'
		 GROUP BY index_class.relname, index_meta.indisunique
		 ORDER BY index_class.relname`,
	);
}

async function expectPolicyIndexes(adapter: BunSqlAdapter): Promise<void> {
	const indexes = new Map(
		(await policyIndexes(adapter)).map((row) => [row.name, row]),
	);
	expect(indexes.get("idx_combo_enrollment_rules_unique")).toEqual({
		name: "idx_combo_enrollment_rules_unique",
		is_unique: true,
		columns: "family,combo_id,provider,route_class",
	});
	expect(indexes.get("idx_combo_enrollment_rules_combo_id")).toEqual({
		name: "idx_combo_enrollment_rules_combo_id",
		is_unique: false,
		columns: "combo_id",
	});
	expect(indexes.get("idx_combo_membership_exclusions_unique")).toEqual({
		name: "idx_combo_membership_exclusions_unique",
		is_unique: true,
		columns: "family,combo_id,account_id",
	});
	expect(indexes.get("idx_combo_membership_exclusions_combo_id")).toEqual({
		name: "idx_combo_membership_exclusions_combo_id",
		is_unique: false,
		columns: "combo_id",
	});
	expect(indexes.get("idx_combo_membership_exclusions_account_id")).toEqual({
		name: "idx_combo_membership_exclusions_account_id",
		is_unique: false,
		columns: "account_id",
	});
}

async function expectPolicyConstraints(adapter: BunSqlAdapter): Promise<void> {
	await expect(
		adapter.run(
			"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["duplicate-rule", "opus", "combo-1", "openai", "api-key", 1, 2, 2],
		),
	).rejects.toThrow();
	await expect(
		adapter.run(
			"INSERT INTO combo_membership_exclusions (id, family, combo_id, account_id, created_at) VALUES (?, ?, ?, ?, ?)",
			["duplicate-exclusion", "opus", "combo-1", "account-1", 2],
		),
	).rejects.toThrow();
	await expect(
		adapter.run(
			"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["blank-provider", "opus", "combo-1", " ", "api-key", 1, 2, 2],
		),
	).rejects.toThrow();
	await expect(
		adapter.run(
			"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["bad-route", "opus", "combo-1", "openai", "unknown", 1, 2, 2],
		),
	).rejects.toThrow();
	await expect(
		adapter.run(
			"INSERT INTO combo_enrollment_rules (id, family, combo_id, provider, route_class, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["bad-enabled", "opus", "combo-1", "other", "api-key", 2, 2, 2],
		),
	).rejects.toThrow();
}

describePostgres("managed routing PostgreSQL integration", () => {
	it("executes the fresh schema, repository round trip, checked rollback, and cascades", async () => {
		await withDisposableDatabase(async (adapter) => {
			await ensureSchemaPg(adapter);
			await runMigrationsPg(adapter);
			await seedPolicyBase(adapter);
			const repo = new ComboRepository(adapter);
			const seededRevision = await repo.getRoutingPolicyRevision();
			await adapter.run("UPDATE accounts SET refresh_token = ? WHERE id = ?", [
				"first-token",
				"account-1",
			]);
			const credentialShapeRevision = await repo.getRoutingPolicyRevision();
			expect(credentialShapeRevision).toBeGreaterThan(seededRevision);
			await adapter.run("UPDATE accounts SET refresh_token = ? WHERE id = ?", [
				"rotated-token",
				"account-1",
			]);
			expect(await repo.getRoutingPolicyRevision()).toBe(
				credentialShapeRevision,
			);
			await adapter.run("UPDATE combo_slots SET priority = ? WHERE id = ?", [
				8,
				"slot-1",
			]);
			expect(await repo.getRoutingPolicyRevision()).toBeGreaterThan(
				credentialShapeRevision,
			);
			await repo.setFamilyAssignment("opus", "combo-1", true);
			expect((await repo.getRoutingPolicySnapshot("opus")).assignment).toEqual({
				family: "opus",
				combo_id: "combo-1",
				enabled: true,
				membership_mode: "manual",
				managed_model: null,
			});

			expect(
				await repo.applyFamilyPolicyChanges({
					family: "opus",
					assignment: {
						membership_mode: "managed",
						managed_model: "test-model",
					},
					create_rules: [
						{
							id: "rule-1",
							combo_id: "combo-1",
							provider: "openai",
							route_class: "api-key",
						},
					],
					create_exclusions: [
						{
							id: "exclusion-1",
							combo_id: "combo-1",
							account_id: "account-1",
						},
					],
				}),
			).toEqual({ family: "opus", applied: true, mutation_count: 3 });

			const snapshot = await repo.getRoutingPolicySnapshot("opus");
			expect(snapshot.assignment).toMatchObject({
				membership_mode: "managed",
				managed_model: "test-model",
			});
			expect(snapshot.combo?.id).toBe("combo-1");
			expect(snapshot.slots.map((row) => row.id)).toEqual(["slot-1"]);
			expect(snapshot.rules.map((row) => row.id)).toEqual(["rule-1"]);
			expect(snapshot.exclusions.map((row) => row.id)).toEqual(["exclusion-1"]);
			expect(
				await repo.applyFamilyPolicyChanges({
					family: "opus",
					assignment: { membership_mode: "manual" },
				}),
			).toEqual({ family: "opus", applied: true, mutation_count: 1 });
			const manualSnapshot = await repo.getRoutingPolicySnapshot("opus");
			expect(manualSnapshot.assignment).toMatchObject({
				membership_mode: "manual",
				managed_model: "test-model",
			});
			expect(manualSnapshot.rules.map((row) => row.id)).toEqual(["rule-1"]);
			expect(manualSnapshot.exclusions.map((row) => row.id)).toEqual([
				"exclusion-1",
			]);

			const reviewedRevision = await repo.getRoutingPolicyRevision();
			await adapter.run("UPDATE accounts SET priority = ? WHERE id = ?", [
				4,
				"account-1",
			]);
			await expect(
				repo.applyFamilyPolicyChanges({
					family: "opus",
					expected_revision: reviewedRevision,
					assignment: { membership_mode: "managed" },
					create_rules: [
						{
							id: "must-not-commit",
							combo_id: "combo-1",
							provider: "other",
							route_class: "api-key",
						},
					],
				}),
			).rejects.toThrow("Routing policy revision changed");
			const afterStaleApply = await repo.getRoutingPolicySnapshot("opus");
			expect(afterStaleApply.assignment.membership_mode).toBe("manual");
			expect(afterStaleApply.rules.map((row) => row.id)).toEqual(["rule-1"]);
			await expectPolicyConstraints(adapter);
			await expectPolicyIndexes(adapter);

			await expect(
				adapter.runBatchWithChanges([
					{
						sql: "UPDATE combos SET name = ? WHERE id = ?",
						params: ["changed", "combo-1"],
						expectedChanges: 1,
					},
					{
						sql: "DELETE FROM combos WHERE id = ?",
						params: ["missing"],
						expectedChanges: 1,
					},
				]),
			).rejects.toThrow("Batch statement 2 expected 1 change(s), got 0");
			expect(
				await adapter.get<{ name: string }>(
					"SELECT name FROM combos WHERE id = ?",
					["combo-1"],
				),
			).toEqual({ name: "primary" });

			await adapter.run("DELETE FROM accounts WHERE id = ?", ["account-1"]);
			expect(
				await adapter.query("SELECT id FROM combo_membership_exclusions"),
			).toEqual([]);
			await adapter.run("DELETE FROM combos WHERE id = ?", ["combo-1"]);
			expect(
				await adapter.query("SELECT id FROM combo_enrollment_rules"),
			).toEqual([]);
			expect(
				await adapter.get<{ combo_id: string | null }>(
					"SELECT combo_id FROM combo_family_assignments WHERE family = ?",
					["opus"],
				),
			).toEqual({ combo_id: null });
		});
	});

	it("upgrades a true legacy schema without changing explicit combos or slots", async () => {
		await withDisposableDatabase(async (adapter) => {
			await ensureSchemaPg(adapter);
			for (const column of [
				"model_mappings",
				"model_fallbacks",
				"billing_type",
			]) {
				await adapter.unsafe(`ALTER TABLE accounts DROP COLUMN ${column}`);
			}
			await adapter.unsafe("DROP TABLE combo_membership_exclusions");
			await adapter.unsafe("DROP TABLE combo_enrollment_rules");
			await adapter.unsafe(
				"ALTER TABLE combo_family_assignments DROP COLUMN managed_model",
			);
			await adapter.unsafe(
				"ALTER TABLE combo_family_assignments DROP COLUMN membership_mode",
			);
			await seedPolicyBase(adapter);
			await adapter.run(
				"UPDATE combo_family_assignments SET combo_id = ?, enabled = 1 WHERE family = ?",
				["combo-1", "opus"],
			);
			const combosBefore = await adapter.query(
				"SELECT id, name, description, enabled, created_at, updated_at FROM combos ORDER BY id",
			);
			const slotsBefore = await adapter.query(
				"SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots ORDER BY id",
			);

			await ensureSchemaPg(adapter);
			await runMigrationsPg(adapter);

			expect(
				await adapter.get(
					"SELECT combo_id, enabled, membership_mode, managed_model FROM combo_family_assignments WHERE family = ?",
					["opus"],
				),
			).toEqual({
				combo_id: "combo-1",
				enabled: 1,
				membership_mode: "manual",
				managed_model: null,
			});
			expect(
				await adapter.query(
					"SELECT id, name, description, enabled, created_at, updated_at FROM combos ORDER BY id",
				),
			).toEqual(combosBefore);
			expect(
				await adapter.query(
					"SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots ORDER BY id",
				),
			).toEqual(slotsBefore);

			const repo = new ComboRepository(adapter);
			const revisionBeforeAccountPolicyChange =
				await repo.getRoutingPolicyRevision();
			await adapter.run("UPDATE accounts SET billing_type = ? WHERE id = ?", [
				"api",
				"account-1",
			]);
			expect(await repo.getRoutingPolicyRevision()).toBeGreaterThan(
				revisionBeforeAccountPolicyChange,
			);
			expect(
				await repo.applyFamilyPolicyChanges({
					family: "opus",
					assignment: {
						membership_mode: "managed",
						managed_model: "upgraded-model",
					},
					create_rules: [
						{
							id: "rule-1",
							combo_id: "combo-1",
							provider: "openai",
							route_class: "api-key",
						},
					],
					create_exclusions: [
						{
							id: "exclusion-1",
							combo_id: "combo-1",
							account_id: "account-1",
						},
					],
				}),
			).toEqual({ family: "opus", applied: true, mutation_count: 3 });
			expect(
				await repo.applyFamilyPolicyChanges({
					family: "opus",
					assignment: { membership_mode: "manual" },
				}),
			).toEqual({ family: "opus", applied: true, mutation_count: 1 });
			const manualSnapshot = await repo.getRoutingPolicySnapshot("opus");
			expect(manualSnapshot.assignment).toMatchObject({
				membership_mode: "manual",
				managed_model: "upgraded-model",
			});
			expect(manualSnapshot.rules.map((row) => row.id)).toEqual(["rule-1"]);
			expect(manualSnapshot.exclusions.map((row) => row.id)).toEqual([
				"exclusion-1",
			]);
			await expectPolicyConstraints(adapter);
			await expectPolicyIndexes(adapter);
			await expect(
				adapter.run(
					"UPDATE combo_family_assignments SET membership_mode = ? WHERE family = ?",
					["automatic", "opus"],
				),
			).rejects.toThrow();
		});
	});
});
