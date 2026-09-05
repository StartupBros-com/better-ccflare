import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { toComboFamilyAssignment } from "@better-ccflare/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";
import { ComboRepository } from "../repositories/combo.repository";

describe("native quota family policy persistence", () => {
	it("treats old row inputs as legacy", () => {
		expect(
			toComboFamilyAssignment({
				family: "fable",
				combo_id: null,
				enabled: 0,
				membership_mode: "manual",
				managed_model: null,
			}).exhaustion_policy,
		).toBe("legacy");
	});

	for (const upgrade of [false, true]) {
		it(`round-trips policy and partial updates on SQLite ${upgrade ? "upgrade" : "fresh"} schema`, async () => {
			const db = new Database(":memory:");
			try {
				ensureSchema(db);
				if (upgrade)
					db.run(
						"ALTER TABLE combo_family_assignments DROP COLUMN exhaustion_policy",
					);
				runMigrations(db);
				const repo = new ComboRepository(new BunSqlAdapter(db));
				expect(
					(await repo.getRoutingPolicySnapshot("fable")).assignment
						.exhaustion_policy,
				).toBe("legacy");
				const revision = await repo.getRoutingPolicyRevision();
				await repo.updateFamilyPolicy("fable", {
					exhaustion_policy: "native_quota_wait",
				});
				expect(await repo.getRoutingPolicyRevision()).toBeGreaterThan(revision);
				await repo.updateFamilyPolicy("fable", { enabled: true });
				await repo.setFamilyAssignment("fable", null, false);
				expect(
					(await repo.getFamilyAssignments()).find(
						(row) => row.family === "fable",
					)?.exhaustion_policy,
				).toBe("native_quota_wait");
				expect(
					(await repo.getRoutingPolicySnapshot("fable")).assignment
						.exhaustion_policy,
				).toBe("native_quota_wait");
				await repo.applyFamilyPolicyChanges({
					family: "fable",
					expected_revision: await repo.getRoutingPolicyRevision(),
					assignment: { exhaustion_policy: "legacy" },
				});
				expect(
					(await repo.getRoutingPolicySnapshot("fable")).assignment
						.exhaustion_policy,
				).toBe("legacy");
				expect(() =>
					db.run(
						"UPDATE combo_family_assignments SET exhaustion_policy = 'unknown'",
					),
				).toThrow();
			} finally {
				db.close();
			}
		});
	}

	it("generates PostgreSQL fresh and upgrade policy columns with legacy defaults and enum constraints", async () => {
		for (const upgrade of [false, true]) {
			const statements: string[] = [];
			const adapter = {
				get: async (_sql: string, params: unknown[] = []) => ({
					exists:
						params[0] === "combo_family_assignments" &&
						params[1] === "exhaustion_policy"
							? 0
							: 1,
				}),
				unsafe: async (sql: string) => {
					statements.push(sql);
					return [];
				},
				run: async (sql: string) => {
					statements.push(sql);
				},
			} as unknown as BunSqlAdapter;
			await (upgrade ? runMigrationsPg(adapter) : ensureSchemaPg(adapter));
			const sql = statements.join("\n").replace(/\s+/g, " ");
			expect(sql).toContain(
				`${upgrade ? "ALTER TABLE combo_family_assignments ADD COLUMN " : ""}exhaustion_policy TEXT NOT NULL DEFAULT 'legacy' CHECK (exhaustion_policy IN ('legacy', 'native_quota_wait'))`,
			);
		}
	});
});
