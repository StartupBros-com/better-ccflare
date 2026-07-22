import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ComboRepository } from "../combo.repository";

describe("ComboRepository priority tiers", () => {
	let db: Database;
	let repo: ComboRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run(`
			CREATE TABLE combos (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT,
				enabled INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE combo_slots (
				id TEXT PRIMARY KEY,
				combo_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				model TEXT NOT NULL,
				priority INTEGER NOT NULL,
				enabled INTEGER NOT NULL
			);
			CREATE TABLE combo_family_assignments (
				family TEXT PRIMARY KEY,
				combo_id TEXT,
				enabled INTEGER NOT NULL,
				membership_mode TEXT NOT NULL DEFAULT 'manual',
				managed_model TEXT
			);
		`);
		db.run(
			"INSERT INTO combos VALUES ('combo-1', 'Claude lanes', NULL, 1, 0, 0)",
		);
		repo = new ComboRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	function insertSlot(id: string, priority: number): void {
		db.run("INSERT INTO combo_slots VALUES (?, 'combo-1', ?, ?, ?, 1)", [
			id,
			`account-${id}`,
			`model-${id}`,
			priority,
		]);
	}

	it("returns equal-priority slots in stable id order", async () => {
		insertSlot("slot-b", 0);
		insertSlot("slot-a", 0);
		insertSlot("slot-c", 1);

		expect((await repo.getSlots("combo-1")).map((slot) => slot.id)).toEqual([
			"slot-a",
			"slot-b",
			"slot-c",
		]);
	});

	it("uses the same deterministic tier order for active family routing", async () => {
		insertSlot("slot-b", 0);
		insertSlot("slot-a", 0);
		db.run(
			"INSERT INTO combo_family_assignments (family, combo_id, enabled) VALUES ('opus', 'combo-1', 1)",
		);

		const active = await repo.getActiveComboForFamily("opus");
		expect(active?.slots.map((slot) => slot.id)).toEqual(["slot-a", "slot-b"]);
	});

	it("preserves legacy drag reorder as an explicit strict 0..N rewrite", async () => {
		insertSlot("slot-a", 0);
		insertSlot("slot-b", 0);
		insertSlot("slot-c", 1);

		await repo.reorderSlots("combo-1", ["slot-c", "slot-a", "slot-b"]);

		const priorities = db
			.query<{ id: string; priority: number }, []>(
				"SELECT id, priority FROM combo_slots ORDER BY priority ASC",
			)
			.all();
		expect(priorities).toEqual([
			{ id: "slot-c", priority: 0 },
			{ id: "slot-a", priority: 1 },
			{ id: "slot-b", priority: 2 },
		]);
	});
});
