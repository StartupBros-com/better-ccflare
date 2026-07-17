import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Combo, ComboSlot } from "@better-ccflare/types";
import { createSlotAddHandler, createSlotUpdateHandler } from "../combos";

const combo: Combo = {
	id: "combo-1",
	name: "Dynamic Claude lanes",
	description: null,
	enabled: true,
	created_at: 0,
	updated_at: 0,
};

function slot(priority: number): ComboSlot {
	return {
		id: `slot-${priority}`,
		combo_id: combo.id,
		account_id: `account-${priority}`,
		model: "claude-opus-4-8",
		priority,
		enabled: true,
	};
}

function request(method: "POST" | "PUT", body: unknown): Request {
	return new Request("http://localhost/api/combos/combo-1/slots", {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function makeDb(existing: ComboSlot[] = []) {
	const addComboSlot = mock(
		async (
			comboId: string,
			accountId: string,
			model: string,
			priority: number,
		) => ({
			id: "new-slot",
			combo_id: comboId,
			account_id: accountId,
			model,
			priority,
			enabled: true,
		}),
	);
	const updateComboSlot = mock(
		async (slotId: string, fields: Partial<ComboSlot>) => ({
			...slot(7),
			id: slotId,
			...fields,
		}),
	);
	return {
		dbOps: {
			getCombo: mock(async () => combo),
			getComboSlots: mock(async () => existing),
			addComboSlot,
			updateComboSlot,
		} as unknown as DatabaseOperations,
		addComboSlot,
		updateComboSlot,
	};
}

describe("combo slot priority API", () => {
	it("creates equal-tier slots when an explicit priority is supplied", async () => {
		const { dbOps, addComboSlot } = makeDb([slot(0), slot(1)]);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-new",
				model: "claude-fable-5",
				priority: 0,
			}),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-new",
			"claude-fable-5",
			0,
		);
	});

	it("keeps the legacy append default when priority is omitted", async () => {
		const { dbOps, addComboSlot } = makeDb([slot(0), slot(1)]);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-new",
				model: "claude-opus-4-8",
			}),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-new",
			"claude-opus-4-8",
			2,
		);
	});

	for (const invalid of [-1, 101, 1.5, "0", null]) {
		it(`rejects invalid create priority ${JSON.stringify(invalid)}`, async () => {
			const { dbOps, addComboSlot } = makeDb();
			const response = await createSlotAddHandler(dbOps)(
				request("POST", {
					account_id: "account-new",
					model: "claude-fable-5",
					priority: invalid,
				}),
				combo.id,
			);

			expect(response.status).toBe(400);
			expect(addComboSlot).not.toHaveBeenCalled();
		});
	}

	it("updates priority without renumbering another slot", async () => {
		const { dbOps, updateComboSlot } = makeDb();
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { priority: 42 }),
			combo.id,
			"slot-a",
		);

		expect(response.status).toBe(200);
		expect(updateComboSlot).toHaveBeenCalledWith("slot-a", { priority: 42 });
	});

	it("does not silently change priority during an ordinary model edit", async () => {
		const { dbOps, updateComboSlot } = makeDb();
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { model: "claude-opus-4-8" }),
			combo.id,
			"slot-a",
		);

		expect(response.status).toBe(200);
		expect(updateComboSlot).toHaveBeenCalledWith("slot-a", {
			model: "claude-opus-4-8",
		});
	});

	it("rejects an out-of-range update priority", async () => {
		const { dbOps, updateComboSlot } = makeDb();
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { priority: 101 }),
			combo.id,
			"slot-a",
		);

		expect(response.status).toBe(400);
		expect(updateComboSlot).not.toHaveBeenCalled();
	});
});
