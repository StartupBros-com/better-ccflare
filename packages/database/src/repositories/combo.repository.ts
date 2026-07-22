import { randomUUID } from "node:crypto";
import {
	type Combo,
	type ComboEnrollmentRule,
	type ComboEnrollmentRuleCreateInput,
	type ComboEnrollmentRuleRow,
	type ComboEnrollmentRuleUpdateInput,
	type ComboFamily,
	type ComboFamilyAssignment,
	type ComboFamilyAssignmentRow,
	type ComboFamilyPolicyApplyResult,
	type ComboFamilyPolicyChanges,
	type ComboFamilyPolicyUpdateInput,
	type ComboMembershipExclusion,
	type ComboMembershipExclusionCreateInput,
	type ComboMembershipExclusionRow,
	type ComboRoutingPolicySnapshot,
	type ComboRow,
	type ComboSlot,
	type ComboSlotRow,
	type ComboWithSlots,
	toCombo,
	toComboEnrollmentRule,
	toComboFamilyAssignment,
	toComboMembershipExclusion,
	toComboSlot,
} from "@better-ccflare/types";
import type { BatchStatement } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

interface RoutingPolicySnapshotRow {
	row_kind: "assignment" | "combo" | "slot" | "rule" | "exclusion";
	family: string | null;
	combo_id: string | null;
	id: string | null;
	name: string | null;
	description: string | null;
	model: string | null;
	account_id: string | null;
	provider: string | null;
	route_class: string | null;
	membership_mode: string | null;
	managed_model: string | null;
	enabled: number | null;
	priority: number | null;
	created_at: number | null;
	updated_at: number | null;
}

export class ComboRepository extends BaseRepository<Combo> {
	// ── Combo CRUD ──────────────────────────────────────────────────────────

	async create(name: string, description?: string | null): Promise<Combo> {
		const id = randomUUID();
		const now = Date.now();
		await this.run(
			`INSERT INTO combos (id, name, description, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
			[id, name, description ?? null, now, now],
		);
		const row = await this.get<ComboRow>(
			`SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Failed to create combo: ${name}`);
		return toCombo(row);
	}

	async findAll(): Promise<Combo[]> {
		const rows = await this.query<ComboRow>(
			`SELECT id, name, description, enabled, created_at, updated_at
       FROM combos ORDER BY created_at DESC`,
		);
		return rows.map(toCombo);
	}

	async findById(id: string): Promise<Combo | null> {
		const row = await this.get<ComboRow>(
			`SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
			[id],
		);
		return row ? toCombo(row) : null;
	}

	async update(
		id: string,
		fields: Partial<{
			name: string;
			description: string | null;
			enabled: boolean;
		}>,
	): Promise<Combo> {
		const now = Date.now();
		const setClauses: string[] = ["updated_at = ?"];
		const params: unknown[] = [now];

		if (fields.name !== undefined) {
			setClauses.push("name = ?");
			params.push(fields.name);
		}
		if (Object.hasOwn(fields, "description")) {
			setClauses.push("description = ?");
			params.push(fields.description ?? null);
		}
		if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}

		params.push(id);
		await this.run(
			`UPDATE combos SET ${setClauses.join(", ")} WHERE id = ?`,
			params,
		);

		const row = await this.get<ComboRow>(
			`SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Combo not found after update: ${id}`);
		return toCombo(row);
	}

	async delete(id: string): Promise<void> {
		await this.run(`DELETE FROM combos WHERE id = ?`, [id]);
	}

	// ── Slot management ──────────────────────────────────────────────────────

	async addSlot(
		comboId: string,
		accountId: string,
		model: string,
		priority: number,
	): Promise<ComboSlot> {
		const id = randomUUID();
		await this.run(
			`INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
			[id, comboId, accountId, model, priority],
		);
		const row = await this.get<ComboSlotRow>(
			`SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Failed to create combo slot`);
		return toComboSlot(row);
	}

	async updateSlot(
		slotId: string,
		fields: Partial<{ model: string; priority: number; enabled: boolean }>,
	): Promise<ComboSlot> {
		const setClauses: string[] = [];
		const params: unknown[] = [];

		if (fields.model !== undefined) {
			setClauses.push("model = ?");
			params.push(fields.model);
		}
		if (fields.priority !== undefined) {
			setClauses.push("priority = ?");
			params.push(fields.priority);
		}
		if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}

		if (setClauses.length === 0) {
			throw new Error("updateSlot called with no fields to update");
		}

		params.push(slotId);
		await this.run(
			`UPDATE combo_slots SET ${setClauses.join(", ")} WHERE id = ?`,
			params,
		);

		const row = await this.get<ComboSlotRow>(
			`SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots WHERE id = ?`,
			[slotId],
		);
		if (!row) throw new Error(`Combo slot not found: ${slotId}`);
		return toComboSlot(row);
	}

	async removeSlot(slotId: string): Promise<void> {
		await this.run(`DELETE FROM combo_slots WHERE id = ?`, [slotId]);
	}

	async getSlots(comboId: string): Promise<ComboSlot[]> {
		const rows = await this.query<ComboSlotRow>(
			`SELECT id, combo_id, account_id, model, priority, enabled
       FROM combo_slots WHERE combo_id = ? ORDER BY priority ASC, id ASC`,
			[comboId],
		);
		return rows.map(toComboSlot);
	}

	/**
	 * Explicit legacy reorder action: reassign priority 0, 1, 2... matching the
	 * order of slotIds. The dashboard warns that dragging converts equal-priority
	 * dynamic tiers into a strict fallback chain; ordinary slot edits never call it.
	 * slotIds must all belong to the same comboId.
	 */
	async reorderSlots(comboId: string, slotIds: string[]): Promise<void> {
		if (slotIds.length === 0) return;

		// Build a single batched UPDATE for atomicity — avoids partial state on crash
		const cases = slotIds.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
		const placeholders = slotIds.map(() => "?").join(", ");
		const sql = `UPDATE combo_slots
                 SET priority = CASE id ${cases} ELSE priority END
                 WHERE combo_id = ? AND id IN (${placeholders})`;
		await this.run(sql, [...slotIds, comboId, ...slotIds]);
	}

	// ── Family assignment ────────────────────────────────────────────────────

	/**
	 * Upsert a family assignment. Pass comboId = null to unassign.
	 */
	async setFamilyAssignment(
		family: ComboFamily,
		comboId: string | null,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`INSERT INTO combo_family_assignments (family, combo_id, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(family) DO UPDATE SET combo_id = excluded.combo_id, enabled = excluded.enabled`,
			[family, comboId, enabled ? 1 : 0],
		);
	}

	async updateFamilyPolicy(
		family: ComboFamily,
		fields: ComboFamilyPolicyUpdateInput,
	): Promise<ComboFamilyAssignment> {
		const { sql, params } = this.buildFamilyPolicyUpdate(family, fields);
		if (!sql)
			throw new Error("updateFamilyPolicy called with no fields to update");
		const changes = await this.adapter.runWithChanges(sql, params);
		if (changes !== 1) {
			throw new Error(`Family assignment not found: ${family}`);
		}
		const row = await this.get<ComboFamilyAssignmentRow>(
			`SELECT family, combo_id, enabled, membership_mode, managed_model
			 FROM combo_family_assignments WHERE family = ?`,
			[family],
		);
		if (!row) throw new Error(`Family assignment not found: ${family}`);
		return toComboFamilyAssignment(row);
	}

	async getFamilyAssignments(): Promise<ComboFamilyAssignment[]> {
		const rows = await this.query<ComboFamilyAssignmentRow>(
			`SELECT family, combo_id, enabled, membership_mode, managed_model
			 FROM combo_family_assignments`,
		);
		// Return stored rows; callers handle missing families as "no assignment"
		return rows.map(toComboFamilyAssignment);
	}

	/**
	 * Returns ComboWithSlots only when:
	 *   - The family has an assignment row with enabled = 1
	 *   - The referenced combo has enabled = 1
	 *   - Only enabled slots (slot.enabled = 1) are included, ordered by priority
	 * Returns null if no active combo for the family.
	 */
	async getActiveComboForFamily(
		family: ComboFamily,
	): Promise<ComboWithSlots | null> {
		const assignment = await this.get<ComboFamilyAssignmentRow>(
			`SELECT family, combo_id, enabled, membership_mode, managed_model
			 FROM combo_family_assignments
       WHERE family = ? AND enabled = 1 AND combo_id IS NOT NULL`,
			[family],
		);
		if (!assignment?.combo_id) return null;

		const comboRow = await this.get<ComboRow>(
			`SELECT id, name, description, enabled, created_at, updated_at
       FROM combos WHERE id = ? AND enabled = 1`,
			[assignment.combo_id],
		);
		if (!comboRow) return null;

		const slotRows = await this.query<ComboSlotRow>(
			`SELECT id, combo_id, account_id, model, priority, enabled
       FROM combo_slots
       WHERE combo_id = ? AND enabled = 1
       ORDER BY priority ASC, id ASC`,
			[comboRow.id],
		);

		const combo = toCombo(comboRow);
		return {
			...combo,
			slots: slotRows.map(toComboSlot),
		};
	}

	// ── Managed family policy ────────────────────────────────────────────────

	async createEnrollmentRule(
		input: ComboEnrollmentRuleCreateInput,
	): Promise<ComboEnrollmentRule> {
		const id = input.id ?? randomUUID();
		const now = Date.now();
		await this.run(
			`INSERT INTO combo_enrollment_rules
			 (id, family, combo_id, provider, route_class, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.family,
				input.combo_id,
				input.provider,
				input.route_class,
				input.enabled === false ? 0 : 1,
				now,
				now,
			],
		);
		return this.requireEnrollmentRule(id);
	}

	async updateEnrollmentRule(
		id: string,
		fields: ComboEnrollmentRuleUpdateInput,
	): Promise<ComboEnrollmentRule> {
		const setClauses = ["updated_at = ?"];
		const params: unknown[] = [Date.now()];
		if (fields.provider !== undefined) {
			setClauses.push("provider = ?");
			params.push(fields.provider);
		}
		if (fields.route_class !== undefined) {
			setClauses.push("route_class = ?");
			params.push(fields.route_class);
		}
		if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}
		if (setClauses.length === 1) {
			throw new Error("updateEnrollmentRule called with no fields to update");
		}
		params.push(id);
		const changes = await this.adapter.runWithChanges(
			`UPDATE combo_enrollment_rules SET ${setClauses.join(", ")} WHERE id = ?`,
			params,
		);
		if (changes !== 1) throw new Error(`Enrollment rule not found: ${id}`);
		return this.requireEnrollmentRule(id);
	}

	async deleteEnrollmentRule(id: string): Promise<void> {
		const changes = await this.adapter.runWithChanges(
			"DELETE FROM combo_enrollment_rules WHERE id = ?",
			[id],
		);
		if (changes !== 1) throw new Error(`Enrollment rule not found: ${id}`);
	}

	async getEnrollmentRules(
		family: ComboFamily,
		comboId?: string,
	): Promise<ComboEnrollmentRule[]> {
		const rows = await this.query<ComboEnrollmentRuleRow>(
			`SELECT id, family, combo_id, provider, route_class, enabled, created_at, updated_at
			 FROM combo_enrollment_rules
			 WHERE family = ?${comboId === undefined ? "" : " AND combo_id = ?"}
			 ORDER BY created_at ASC, id ASC`,
			comboId === undefined ? [family] : [family, comboId],
		);
		return rows.map(toComboEnrollmentRule);
	}

	async createMembershipExclusion(
		input: ComboMembershipExclusionCreateInput,
	): Promise<ComboMembershipExclusion> {
		const id = input.id ?? randomUUID();
		const now = Date.now();
		await this.run(
			`INSERT INTO combo_membership_exclusions
			 (id, family, combo_id, account_id, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[id, input.family, input.combo_id, input.account_id, now],
		);
		const row = await this.get<ComboMembershipExclusionRow>(
			`SELECT id, family, combo_id, account_id, created_at
			 FROM combo_membership_exclusions WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Membership exclusion not found: ${id}`);
		return toComboMembershipExclusion(row);
	}

	async deleteMembershipExclusion(id: string): Promise<void> {
		const changes = await this.adapter.runWithChanges(
			"DELETE FROM combo_membership_exclusions WHERE id = ?",
			[id],
		);
		if (changes !== 1) {
			throw new Error(`Membership exclusion not found: ${id}`);
		}
	}

	async restoreMembership(
		family: ComboFamily,
		comboId: string,
		accountId: string,
	): Promise<void> {
		const changes = await this.adapter.runWithChanges(
			`DELETE FROM combo_membership_exclusions
			 WHERE family = ? AND combo_id = ? AND account_id = ?`,
			[family, comboId, accountId],
		);
		if (changes !== 1) {
			throw new Error(
				`Membership exclusion not found: ${family}/${comboId}/${accountId}`,
			);
		}
	}

	async getMembershipExclusions(
		family: ComboFamily,
		comboId?: string,
	): Promise<ComboMembershipExclusion[]> {
		const rows = await this.query<ComboMembershipExclusionRow>(
			`SELECT id, family, combo_id, account_id, created_at
			 FROM combo_membership_exclusions
			 WHERE family = ?${comboId === undefined ? "" : " AND combo_id = ?"}
			 ORDER BY created_at ASC, id ASC`,
			comboId === undefined ? [family] : [family, comboId],
		);
		return rows.map(toComboMembershipExclusion);
	}

	async getRoutingPolicySnapshot(
		family: ComboFamily,
	): Promise<ComboRoutingPolicySnapshot> {
		const rows = await this.query<RoutingPolicySnapshotRow>(
			`WITH selected_assignment AS (
				SELECT family, combo_id, enabled, membership_mode, managed_model
				FROM combo_family_assignments
				WHERE family = ?
			),
			snapshot_rows AS (
				SELECT
					'assignment' AS row_kind,
					a.family,
					a.combo_id,
					CAST(NULL AS TEXT) AS id,
					CAST(NULL AS TEXT) AS name,
					CAST(NULL AS TEXT) AS description,
					CAST(NULL AS TEXT) AS model,
					CAST(NULL AS TEXT) AS account_id,
					CAST(NULL AS TEXT) AS provider,
					CAST(NULL AS TEXT) AS route_class,
					a.membership_mode,
					a.managed_model,
					a.enabled,
					CAST(NULL AS INTEGER) AS priority,
					CAST(NULL AS BIGINT) AS created_at,
					CAST(NULL AS BIGINT) AS updated_at,
					0 AS sort_group,
					CAST(0 AS BIGINT) AS sort_primary,
					a.family AS sort_text
				FROM selected_assignment a

				UNION ALL

				SELECT
					'combo', a.family, a.combo_id, c.id, c.name, c.description,
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					c.enabled, CAST(NULL AS INTEGER), c.created_at, c.updated_at,
					1, CAST(0 AS BIGINT), c.id
				FROM selected_assignment a
				JOIN combos c ON c.id = a.combo_id

				UNION ALL

				SELECT
					'slot', a.family, s.combo_id, s.id, CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), s.model, s.account_id, CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					s.enabled, s.priority, CAST(NULL AS BIGINT), CAST(NULL AS BIGINT),
					2, CAST(s.priority AS BIGINT), s.id
				FROM selected_assignment a
				JOIN combo_slots s ON s.combo_id = a.combo_id

				UNION ALL

				SELECT
					'rule', r.family, r.combo_id, r.id, CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					r.provider, r.route_class, CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					r.enabled, CAST(NULL AS INTEGER), r.created_at, r.updated_at,
					3, r.created_at, r.id
				FROM selected_assignment a
				JOIN combo_enrollment_rules r
					ON r.family = a.family AND r.combo_id = a.combo_id

				UNION ALL

				SELECT
					'exclusion', e.family, e.combo_id, e.id, CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), e.account_id,
					CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
					CAST(NULL AS TEXT), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
					e.created_at, CAST(NULL AS BIGINT), 4, e.created_at, e.id
				FROM selected_assignment a
				JOIN combo_membership_exclusions e
					ON e.family = a.family AND e.combo_id = a.combo_id
			)
			SELECT row_kind, family, combo_id, id, name, description, model,
				account_id, provider, route_class, membership_mode, managed_model,
				enabled, priority, created_at, updated_at
			FROM snapshot_rows
			ORDER BY sort_group, sort_primary, sort_text`,
			[family],
		);

		let assignment: ComboFamilyAssignment | undefined;
		let combo: Combo | null = null;
		const slots: ComboSlot[] = [];
		const rules: ComboEnrollmentRule[] = [];
		const exclusions: ComboMembershipExclusion[] = [];
		for (const row of rows) {
			switch (row.row_kind) {
				case "assignment":
					assignment = toComboFamilyAssignment({
						family: row.family ?? family,
						combo_id: row.combo_id,
						enabled: row.enabled ?? 0,
						membership_mode: row.membership_mode ?? "manual",
						managed_model: row.managed_model,
					});
					break;
				case "combo":
					combo = toCombo({
						id: row.id ?? "",
						name: row.name ?? "",
						description: row.description,
						enabled: row.enabled ?? 0,
						created_at: row.created_at ?? 0,
						updated_at: row.updated_at ?? 0,
					});
					break;
				case "slot":
					slots.push(
						toComboSlot({
							id: row.id ?? "",
							combo_id: row.combo_id ?? "",
							account_id: row.account_id ?? "",
							model: row.model ?? "",
							priority: row.priority ?? 0,
							enabled: row.enabled ?? 0,
						}),
					);
					break;
				case "rule":
					rules.push(
						toComboEnrollmentRule({
							id: row.id ?? "",
							family: row.family ?? family,
							combo_id: row.combo_id ?? "",
							provider: row.provider ?? "",
							route_class: row.route_class ?? "",
							enabled: row.enabled ?? 0,
							created_at: row.created_at ?? 0,
							updated_at: row.updated_at ?? 0,
						}),
					);
					break;
				case "exclusion":
					exclusions.push(
						toComboMembershipExclusion({
							id: row.id ?? "",
							family: row.family ?? family,
							combo_id: row.combo_id ?? "",
							account_id: row.account_id ?? "",
							created_at: row.created_at ?? 0,
						}),
					);
					break;
			}
		}
		if (!assignment) throw new Error(`Family assignment not found: ${family}`);
		return { assignment, combo, slots, rules, exclusions };
	}

	/** Apply a fixed set of policy mutations atomically on SQLite and PostgreSQL. */
	async applyFamilyPolicyChanges(
		changes: ComboFamilyPolicyChanges,
	): Promise<ComboFamilyPolicyApplyResult> {
		const statements: BatchStatement[] = [];
		if (changes.assignment) {
			const update = this.buildFamilyPolicyUpdate(
				changes.family,
				changes.assignment,
			);
			if (update.sql) statements.push({ ...update, expectedChanges: 1 });
		}
		const now = Date.now();
		for (const input of changes.create_rules ?? []) {
			statements.push({
				sql: `INSERT INTO combo_enrollment_rules
				 (id, family, combo_id, provider, route_class, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				params: [
					input.id ?? randomUUID(),
					changes.family,
					input.combo_id,
					input.provider,
					input.route_class,
					input.enabled === false ? 0 : 1,
					now,
					now,
				],
				expectedChanges: 1,
			});
		}
		for (const update of changes.update_rules ?? []) {
			const clauses = ["updated_at = ?"];
			const params: unknown[] = [now];
			if (update.fields.provider !== undefined) {
				clauses.push("provider = ?");
				params.push(update.fields.provider);
			}
			if (update.fields.route_class !== undefined) {
				clauses.push("route_class = ?");
				params.push(update.fields.route_class);
			}
			if (update.fields.enabled !== undefined) {
				clauses.push("enabled = ?");
				params.push(update.fields.enabled ? 1 : 0);
			}
			if (clauses.length === 1) {
				throw new Error("updateEnrollmentRule called with no fields to update");
			}
			params.push(update.id, changes.family);
			statements.push({
				sql: `UPDATE combo_enrollment_rules SET ${clauses.join(", ")}
				 WHERE id = ? AND family = ?`,
				params,
				expectedChanges: 1,
			});
		}
		for (const id of changes.delete_rule_ids ?? []) {
			statements.push({
				sql: "DELETE FROM combo_enrollment_rules WHERE id = ? AND family = ?",
				params: [id, changes.family],
				expectedChanges: 1,
			});
		}
		for (const input of changes.create_exclusions ?? []) {
			statements.push({
				sql: `INSERT INTO combo_membership_exclusions
				 (id, family, combo_id, account_id, created_at) VALUES (?, ?, ?, ?, ?)`,
				params: [
					input.id ?? randomUUID(),
					changes.family,
					input.combo_id,
					input.account_id,
					now,
				],
				expectedChanges: 1,
			});
		}
		for (const id of changes.delete_exclusion_ids ?? []) {
			statements.push({
				sql: "DELETE FROM combo_membership_exclusions WHERE id = ? AND family = ?",
				params: [id, changes.family],
				expectedChanges: 1,
			});
		}
		const mutationCounts =
			statements.length === 0
				? []
				: await this.adapter.runBatchWithChanges(statements);
		return {
			family: changes.family,
			applied: true,
			mutation_count: mutationCounts.reduce((total, count) => total + count, 0),
		};
	}

	private buildFamilyPolicyUpdate(
		family: ComboFamily,
		fields: ComboFamilyPolicyUpdateInput,
	): { sql: string; params: unknown[] } {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (Object.hasOwn(fields, "combo_id")) {
			clauses.push("combo_id = ?");
			params.push(fields.combo_id ?? null);
		}
		if (fields.enabled !== undefined) {
			clauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}
		if (fields.membership_mode !== undefined) {
			clauses.push("membership_mode = ?");
			params.push(fields.membership_mode);
		}
		if (Object.hasOwn(fields, "managed_model")) {
			clauses.push("managed_model = ?");
			params.push(fields.managed_model ?? null);
		}
		if (clauses.length === 0) return { sql: "", params: [] };
		params.push(family);
		return {
			sql: `UPDATE combo_family_assignments SET ${clauses.join(", ")} WHERE family = ?`,
			params,
		};
	}

	private async requireEnrollmentRule(
		id: string,
	): Promise<ComboEnrollmentRule> {
		const row = await this.get<ComboEnrollmentRuleRow>(
			`SELECT id, family, combo_id, provider, route_class, enabled, created_at, updated_at
			 FROM combo_enrollment_rules WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Enrollment rule not found: ${id}`);
		return toComboEnrollmentRule(row);
	}
}
