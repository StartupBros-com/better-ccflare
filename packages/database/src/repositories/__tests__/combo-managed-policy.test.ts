import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ComboRepository } from "../combo.repository";

describe("ComboRepository managed policy", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let repo: ComboRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		ensureSchema(db);
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('account-1', 'one', 'anthropic', 1)",
		);
		db.run(
			"INSERT INTO combos (id, name, enabled, created_at, updated_at) VALUES ('combo-1', 'primary', 1, 1, 1)",
		);
		db.run(
			"INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES ('slot-1', 'combo-1', 'account-1', 'manual-model', 9, 1)",
		);
		adapter = new BunSqlAdapter(db);
		repo = new ComboRepository(adapter);
	});

	afterEach(() => db.close());

	it("keeps legacy family assignment behavior manual by default", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);

		const assignment = (await repo.getFamilyAssignments()).find(
			(row) => row.family === "opus",
		);
		expect(assignment).toMatchObject({
			combo_id: "combo-1",
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		});
		expect((await repo.getActiveComboForFamily("opus"))?.slots).toHaveLength(1);
	});

	it("round-trips a complete policy snapshot and preserves policy on manual rollback", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		await repo.updateFamilyPolicy("opus", {
			membership_mode: "managed",
			managed_model: "claude-opus-4-6",
		});
		const rule = await repo.createEnrollmentRule({
			family: "opus",
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription",
		});
		const exclusion = await repo.createMembershipExclusion({
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-1",
		});

		const managed = await repo.getRoutingPolicySnapshot("opus");
		expect(managed.assignment.membership_mode).toBe("managed");
		expect(managed.assignment.managed_model).toBe("claude-opus-4-6");
		expect(managed.combo?.id).toBe("combo-1");
		expect(managed.slots.map((slot) => slot.id)).toEqual(["slot-1"]);
		expect(managed.rules).toEqual([rule]);
		expect(managed.exclusions).toEqual([exclusion]);

		await repo.updateFamilyPolicy("opus", { membership_mode: "manual" });
		const rolledBack = await repo.getRoutingPolicySnapshot("opus");
		expect(rolledBack.assignment.membership_mode).toBe("manual");
		expect(rolledBack.rules).toEqual([rule]);
		expect(rolledBack.exclusions).toEqual([exclusion]);
	});

	it("reads a coherent policy snapshot with one additive SQL statement", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		await repo.createEnrollmentRule({
			id: "rule-1",
			family: "opus",
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription",
		});
		await repo.createMembershipExclusion({
			id: "exclusion-1",
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-1",
		});

		const statements: string[] = [];
		const originalQuery = db.query;
		// biome-ignore lint/suspicious/noExplicitAny: instrumenting the SQLite query boundary
		(db as any).query = (sql: string) => {
			statements.push(sql);
			return originalQuery.call(db, sql);
		};
		try {
			const snapshot = await repo.getRoutingPolicySnapshot("opus");
			expect(snapshot.combo?.id).toBe("combo-1");
			expect(snapshot.slots.map((slot) => slot.id)).toEqual(["slot-1"]);
			expect(snapshot.rules.map((rule) => rule.id)).toEqual(["rule-1"]);
			expect(snapshot.exclusions.map((row) => row.id)).toEqual(["exclusion-1"]);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restoring instrumented method
			(db as any).query = originalQuery;
		}

		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("UNION ALL");
	});

	it("pins update, delete, and restore missing-row behavior", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		const rule = await repo.createEnrollmentRule({
			id: "rule-1",
			family: "opus",
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription",
		});

		expect(
			await repo.updateEnrollmentRule(rule.id, {
				provider: "openai",
				route_class: "api-key",
				enabled: false,
			}),
		).toMatchObject({
			id: "rule-1",
			provider: "openai",
			route_class: "api-key",
			enabled: false,
		});
		await expect(repo.updateEnrollmentRule(rule.id, {})).rejects.toThrow(
			"updateEnrollmentRule called with no fields to update",
		);
		await expect(
			repo.updateEnrollmentRule("missing-rule", { enabled: false }),
		).rejects.toThrow("Enrollment rule not found: missing-rule");

		await repo.deleteEnrollmentRule(rule.id);
		await expect(repo.deleteEnrollmentRule(rule.id)).rejects.toThrow(
			"Enrollment rule not found: rule-1",
		);

		await repo.createMembershipExclusion({
			id: "exclusion-restore",
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-1",
		});
		await repo.restoreMembership("opus", "combo-1", "account-1");
		await expect(
			repo.restoreMembership("opus", "combo-1", "account-1"),
		).rejects.toThrow("Membership exclusion not found: opus/combo-1/account-1");

		await repo.createMembershipExclusion({
			id: "exclusion-delete",
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-1",
		});
		await repo.deleteMembershipExclusion("exclusion-delete");
		await expect(
			repo.deleteMembershipExclusion("exclusion-delete"),
		).rejects.toThrow("Membership exclusion not found: exclusion-delete");

		db.run("DELETE FROM combo_family_assignments WHERE family = 'fable'");
		await expect(
			repo.updateFamilyPolicy("fable", { membership_mode: "managed" }),
		).rejects.toThrow("Family assignment not found: fable");
	});

	it("returns a durable apply acknowledgement and leaves snapshot reads explicit", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);

		expect(
			await repo.applyFamilyPolicyChanges({
				family: "opus",
				assignment: {
					membership_mode: "managed",
					managed_model: "claude-opus-4-6",
				},
				create_rules: [
					{
						id: "rule-apply",
						combo_id: "combo-1",
						provider: "anthropic",
						route_class: "oauth-subscription",
					},
				],
				create_exclusions: [
					{
						id: "exclusion-apply",
						combo_id: "combo-1",
						account_id: "account-1",
					},
				],
			}),
		).toEqual({ family: "opus", applied: true, mutation_count: 3 });

		let snapshot = await repo.getRoutingPolicySnapshot("opus");
		expect(snapshot.assignment).toMatchObject({
			membership_mode: "managed",
			managed_model: "claude-opus-4-6",
		});
		expect(snapshot.rules.map((row) => row.id)).toEqual(["rule-apply"]);
		expect(snapshot.exclusions.map((row) => row.id)).toEqual([
			"exclusion-apply",
		]);

		expect(
			await repo.applyFamilyPolicyChanges({
				family: "opus",
				update_rules: [{ id: "rule-apply", fields: { provider: "openai" } }],
				delete_exclusion_ids: ["exclusion-apply"],
			}),
		).toEqual({ family: "opus", applied: true, mutation_count: 2 });

		snapshot = await repo.getRoutingPolicySnapshot("opus");
		expect(snapshot.rules[0]?.provider).toBe("openai");
		expect(snapshot.exclusions).toEqual([]);
		expect(await repo.applyFamilyPolicyChanges({ family: "opus" })).toEqual({
			family: "opus",
			applied: true,
			mutation_count: 0,
		});
	});

	it("rolls back earlier mutations when a checked update matches no row", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);

		await expect(
			repo.applyFamilyPolicyChanges({
				family: "opus",
				assignment: { membership_mode: "managed" },
				update_rules: [{ id: "missing-rule", fields: { enabled: false } }],
			}),
		).rejects.toThrow("Batch statement 2 expected 1 change(s), got 0");

		const snapshot = await repo.getRoutingPolicySnapshot("opus");
		expect(snapshot.assignment.membership_mode).toBe("manual");
	});

	it("rejects a stale routing revision atomically after a raw slot interleave", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		const reviewedRevision = await repo.getRoutingPolicyRevision();
		db.run("UPDATE combo_slots SET priority = 7 WHERE id = 'slot-1'");

		await expect(
			repo.applyFamilyPolicyChanges({
				family: "opus",
				expected_revision: reviewedRevision,
				assignment: { membership_mode: "managed" },
				create_rules: [
					{
						id: "must-not-commit",
						combo_id: "combo-1",
						provider: "anthropic",
						route_class: "oauth-subscription",
					},
				],
			}),
		).rejects.toThrow("Routing policy revision changed");

		const snapshot = await repo.getRoutingPolicySnapshot("opus");
		expect(snapshot.assignment.membership_mode).toBe("manual");
		expect(snapshot.slots[0]?.priority).toBe(7);
		expect(snapshot.rules).toEqual([]);

		const accountReviewedRevision = await repo.getRoutingPolicyRevision();
		db.run("UPDATE accounts SET priority = 3 WHERE id = 'account-1'");
		await expect(
			repo.applyFamilyPolicyChanges({
				family: "opus",
				expected_revision: accountReviewedRevision,
				assignment: { membership_mode: "managed" },
				create_rules: [
					{
						id: "account-interleave-must-not-commit",
						combo_id: "combo-1",
						provider: "anthropic",
						route_class: "oauth-subscription",
					},
				],
			}),
		).rejects.toThrow("Routing policy revision changed");
		expect((await repo.getRoutingPolicySnapshot("opus")).rules).toEqual([]);
	});

	it("rejects duplicate normalized rules and exclusions", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		const rule = {
			family: "opus" as const,
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription" as const,
		};
		await repo.createEnrollmentRule(rule);
		await expect(repo.createEnrollmentRule(rule)).rejects.toThrow();

		const exclusion = {
			family: "opus" as const,
			combo_id: "combo-1",
			account_id: "account-1",
		};
		await repo.createMembershipExclusion(exclusion);
		await expect(repo.createMembershipExclusion(exclusion)).rejects.toThrow();
	});

	it("cascades account/combo policy rows without affecting another family", async () => {
		db.run(
			"INSERT INTO combos (id, name, enabled, created_at, updated_at) VALUES ('combo-2', 'secondary', 1, 1, 1)",
		);
		await repo.setFamilyAssignment("opus", "combo-1", true);
		await repo.setFamilyAssignment("fable", "combo-2", true);
		await repo.createEnrollmentRule({
			family: "opus",
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription",
		});
		await repo.createMembershipExclusion({
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-1",
		});

		db.run("DELETE FROM accounts WHERE id = 'account-1'");
		expect((await repo.getRoutingPolicySnapshot("opus")).exclusions).toEqual(
			[],
		);
		await repo.delete("combo-1");
		const opus = await repo.getRoutingPolicySnapshot("opus");
		expect(opus.assignment.combo_id).toBeNull();
		expect(opus.rules).toEqual([]);
		expect(
			(await repo.getRoutingPolicySnapshot("fable")).assignment.combo_id,
		).toBe("combo-2");
	});

	it("rolls back a multi-mutation batch when one constraint fails", async () => {
		await repo.setFamilyAssignment("opus", "combo-1", true);
		const duplicate = {
			combo_id: "combo-1",
			provider: "anthropic",
			route_class: "oauth-subscription" as const,
		};
		await expect(
			repo.applyFamilyPolicyChanges({
				family: "opus",
				assignment: { membership_mode: "managed" },
				create_rules: [duplicate, duplicate],
			}),
		).rejects.toThrow();

		const snapshot = await repo.getRoutingPolicySnapshot("opus");
		expect(snapshot.assignment.membership_mode).toBe("manual");
		expect(snapshot.rules).toEqual([]);
	});
});
