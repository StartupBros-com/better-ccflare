import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LATEST_MODEL_BY_FAMILY } from "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ComboRepository } from "../combo.repository";

describe("ComboRepository family alias policy conversion", () => {
	let db: Database;
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
			`INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES ('slot-opus', 'combo-1', 'account-1', '${LATEST_MODEL_BY_FAMILY.opus}', 0, 1), ('slot-pin', 'combo-1', 'account-1', 'claude-sonnet-4-5', 1, 1)`,
		);
		repo = new ComboRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("previews latest concrete assignment and slot values but preserves older pins", async () => {
		await repo.updateFamilyPolicy("fable", {
			managed_model: LATEST_MODEL_BY_FAMILY.fable,
		});
		await repo.updateFamilyPolicy("opus", {
			managed_model: LATEST_MODEL_BY_FAMILY.opus,
		});
		await repo.updateFamilyPolicy("sonnet", {
			managed_model: "claude-sonnet-4-5",
		});
		await repo.updateFamilyPolicy("haiku", {
			managed_model: LATEST_MODEL_BY_FAMILY.haiku,
		});

		const preview = await repo.previewFamilyAliasPolicy();
		for (const [kind, family, id] of [
			["family_assignment", "fable", undefined],
			["family_assignment", "opus", undefined],
			["family_assignment", "haiku", undefined],
			["combo_slot", "opus", "slot-opus"],
		] as const) {
			expect(
				preview.candidates.some(
					(candidate) =>
						candidate.identity.kind === kind &&
						candidate.family === family &&
						(id === undefined ||
							(candidate.identity.kind === "combo_slot" &&
								candidate.identity.slot_id === id)),
				),
			).toBeTrue();
		}
		expect(
			preview.candidates.some((candidate) => candidate.family === "sonnet"),
		).toBeFalse();
	});

	it("converts a selected subset atomically and advances revision once", async () => {
		await repo.updateFamilyPolicy("opus", {
			managed_model: LATEST_MODEL_BY_FAMILY.opus,
		});
		const preview = await repo.previewFamilyAliasPolicy();
		const assignment = preview.candidates.find(
			(candidate) => candidate.identity.kind === "family_assignment",
		);
		expect(assignment).toBeDefined();
		if (!assignment) throw new Error("expected assignment candidate");

		const result = await repo.applyFamilyAliasPolicy({
			expected_revision: preview.revision,
			selections: [
				{
					identity: assignment.identity,
					family: assignment.family,
					expected_old_value: assignment.current_value,
				},
			],
		});

		expect(result).toEqual({ revision: preview.revision + 1, converted: 1 });
		expect(
			(await repo.getRoutingPolicySnapshot("opus")).assignment.managed_model,
		).toBe("opus");
		expect(
			(await repo.getSlots("combo-1")).find((slot) => slot.id === "slot-opus")
				?.model,
		).toBe(LATEST_MODEL_BY_FAMILY.opus);
	});

	it("rejects stale and mismatched selections with no writes, revision change, or mapping mutation", async () => {
		await repo.updateFamilyPolicy("opus", {
			managed_model: LATEST_MODEL_BY_FAMILY.opus,
		});
		const preview = await repo.previewFamilyAliasPolicy();
		const candidate = preview.candidates.find(
			(item) => item.identity.kind === "family_assignment",
		);
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("expected assignment candidate");
		await expect(
			repo.applyFamilyAliasPolicy({
				expected_revision: preview.revision,
				selections: [
					{
						identity: candidate.identity,
						family: candidate.family,
						expected_old_value: "wrong",
					},
				],
			}),
		).rejects.toThrow();
		expect(await repo.getRoutingPolicyRevision()).toBe(preview.revision);
		expect(
			(await repo.getRoutingPolicySnapshot("opus")).assignment.managed_model,
		).toBe(LATEST_MODEL_BY_FAMILY.opus);

		await expect(
			repo.applyFamilyAliasPolicy({
				expected_revision: preview.revision - 1,
				selections: [
					{
						identity: candidate.identity,
						family: candidate.family,
						expected_old_value: candidate.current_value,
					},
				],
			}),
		).rejects.toThrow();
		expect(await repo.getRoutingPolicyRevision()).toBe(preview.revision);
	});

	it("skips a concrete slot that collides with an existing alias slot and converts unrelated safe policy", async () => {
		db.run(
			"INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled) VALUES ('slot-opus-alias', 'combo-1', 'account-1', 'opus', 2, 1)",
		);
		await repo.updateFamilyPolicy("haiku", {
			managed_model: LATEST_MODEL_BY_FAMILY.haiku,
		});
		const preview = await repo.previewFamilyAliasPolicy();
		expect(
			preview.candidates.some(
				(candidate) =>
					candidate.identity.kind === "combo_slot" &&
					candidate.identity.slot_id === "slot-opus",
			),
		).toBeFalse();
		expect(preview.skipped).toContainEqual({
			identity: { kind: "combo_slot", slot_id: "slot-opus" },
			family: "opus",
			current_value: LATEST_MODEL_BY_FAMILY.opus,
			alias: "opus",
			latest_target: LATEST_MODEL_BY_FAMILY.opus,
			reason: "alias_slot_collision",
		});
		const safe = preview.candidates.find(
			(candidate) =>
				candidate.identity.kind === "family_assignment" &&
				candidate.family === "haiku",
		);
		expect(safe).toBeDefined();
		if (!safe) throw new Error("expected a safe candidate");
		const result = await repo.applyFamilyAliasPolicy({
			expected_revision: preview.revision,
			selections: [
				{
					identity: safe.identity,
					family: safe.family,
					expected_old_value: safe.current_value,
				},
			],
		});
		expect(result).toEqual({ revision: preview.revision + 1, converted: 1 });
		const slots = await repo.getSlots("combo-1");
		expect(slots.find((slot) => slot.id === "slot-opus")?.model).toBe(
			LATEST_MODEL_BY_FAMILY.opus,
		);
		expect(slots.find((slot) => slot.id === "slot-opus-alias")?.model).toBe(
			"opus",
		);
		expect(
			(await repo.getRoutingPolicySnapshot("haiku")).assignment.managed_model,
		).toBe("haiku");
	});

	it("treats already-alias assignment and slot selections as no-op identity checks", async () => {
		await repo.updateFamilyPolicy("opus", { managed_model: "opus" });
		db.run("UPDATE combo_slots SET model = 'opus' WHERE id = 'slot-opus'");
		const revision = await repo.getRoutingPolicyRevision();
		const result = await repo.applyFamilyAliasPolicy({
			expected_revision: revision,
			selections: [
				{
					identity: { kind: "family_assignment", family: "opus" },
					family: "opus",
					expected_old_value: "opus",
				},
				{
					identity: { kind: "combo_slot", slot_id: "slot-opus" },
					family: "opus",
					expected_old_value: "opus",
				},
			],
		});
		expect(result).toEqual({ revision, converted: 0 });
		expect(await repo.getRoutingPolicyRevision()).toBe(revision);
		expect(
			(await repo.getRoutingPolicySnapshot("opus")).assignment.managed_model,
		).toBe("opus");
		expect(
			(await repo.getSlots("combo-1")).find((slot) => slot.id === "slot-opus")
				?.model,
		).toBe("opus");
	});
});
