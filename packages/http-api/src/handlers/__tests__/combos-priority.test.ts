import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type {
	Account,
	Combo,
	ComboFamilyAssignment,
	ComboSlot,
} from "@better-ccflare/types";
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

function makeDb(
	existing: ComboSlot[] = [],
	assignments: ComboFamilyAssignment[] = [],
	accounts: Account[] = [],
) {
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
			getFamilyAssignments: mock(async () => assignments),
			getRoutingPolicyRevision: mock(async () => 0),
			getAllAccounts: mock(async () => accounts),
			getComboRoutingPolicy: mock(async (family: string) => ({
				assignment: assignments.find(
					(assignment) => assignment.family === family,
				),
				combo,
				slots: existing,
				rules: [],
				exclusions: [],
			})),
			addComboSlot,
			updateComboSlot,
		} as unknown as DatabaseOperations,
		addComboSlot,
		updateComboSlot,
	};
}

function nativeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: `refresh-${id}`,
		access_token: `access-${id}`,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: "plan",
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function manualSlot(
	id: string,
	accountId: string,
	model: string,
	priority: number,
): ComboSlot {
	return {
		id,
		combo_id: combo.id,
		account_id: accountId,
		model,
		priority,
		enabled: true,
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

describe("combo slot family alias validation", () => {
	const opusAssignment: ComboFamilyAssignment = {
		family: "opus",
		combo_id: combo.id,
		enabled: true,
		membership_mode: "managed",
		managed_model: "claude-opus-4-8",
	};

	it("accepts any non-empty model when the combo has no family assignment", async () => {
		const { dbOps, addComboSlot } = makeDb([], []);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-new",
				model: "some-custom-model",
			}),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-new",
			"some-custom-model",
			0,
		);
	});

	it("rejects a slot model that does not belong to any family assigned to the combo", async () => {
		const { dbOps, addComboSlot } = makeDb([], [opusAssignment]);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-new",
				model: "claude-sonnet-5",
			}),
			combo.id,
		);

		expect(response.status).toBe(400);
		expect(addComboSlot).not.toHaveBeenCalled();
	});

	it("normalizes a bare family alias slot model to the canonical family word when a matching assignment exists", async () => {
		const { dbOps, addComboSlot } = makeDb([], [opusAssignment]);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", { account_id: "account-new", model: "  OPUS  " }),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-new",
			"opus",
			0,
		);
	});

	it("matches a slot model against any of multiple families assigned to the combo", async () => {
		const fableAssignment: ComboFamilyAssignment = {
			...opusAssignment,
			family: "fable",
		};
		const { dbOps, addComboSlot } = makeDb(
			[],
			[opusAssignment, fableAssignment],
		);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", { account_id: "account-new", model: "fable" }),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-new",
			"fable",
			0,
		);
	});

	it("rejects a slot model update that does not belong to any family assigned to the combo", async () => {
		const { dbOps, updateComboSlot } = makeDb([slot(0)], [opusAssignment]);
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { model: "claude-sonnet-5" }),
			combo.id,
			"slot-0",
		);

		expect(response.status).toBe(400);
		expect(updateComboSlot).not.toHaveBeenCalled();
	});

	it("normalizes a bare family alias on a slot model update when a matching assignment exists", async () => {
		const { dbOps, updateComboSlot } = makeDb([slot(0)], [opusAssignment]);
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { model: "opus" }),
			combo.id,
			"slot-0",
		);

		expect(response.status).toBe(200);
		expect(updateComboSlot).toHaveBeenCalledWith("slot-0", { model: "opus" });
	});
});

describe("native Fable quota-wait slot validation", () => {
	const fableNativeAssignment: ComboFamilyAssignment = {
		family: "fable",
		combo_id: combo.id,
		enabled: true,
		membership_mode: "manual",
		managed_model: null,
		exhaustion_policy: "native_quota_wait",
	};
	const primary = manualSlot("primary", "account-a", "fable", 0);

	it("adds an Opus backup on the primary account at a later tier", async () => {
		const { dbOps, addComboSlot } = makeDb(
			[primary],
			[fableNativeAssignment],
			[nativeAccount("account-a")],
		);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-a",
				model: "claude-opus-4-8",
				priority: 1,
			}),
			combo.id,
		);

		expect(response.status).toBe(201);
		expect(addComboSlot).toHaveBeenCalledWith(
			combo.id,
			"account-a",
			"claude-opus-4-8",
			1,
		);
	});

	it("canonicalizes an Opus alias update after validating the proposed route", async () => {
		const backup = manualSlot("backup", "account-a", "claude-opus-4-8", 1);
		const { dbOps, updateComboSlot } = makeDb(
			[primary, backup],
			[fableNativeAssignment],
			[nativeAccount("account-a")],
		);
		const response = await createSlotUpdateHandler(dbOps)(
			request("PUT", { model: "  OPUS  " }),
			combo.id,
			backup.id,
		);

		expect(response.status).toBe(200);
		expect(updateComboSlot).toHaveBeenCalledWith(backup.id, { model: "opus" });
	});

	for (const [label, accountId, priority] of [
		["same tier", "account-a", 0],
		["non-primary account", "account-b", 1],
	] as const) {
		it(`rejects an Opus backup on the ${label}`, async () => {
			const { dbOps, addComboSlot } = makeDb(
				[primary],
				[fableNativeAssignment],
				[nativeAccount("account-a"), nativeAccount("account-b")],
			);
			const response = await createSlotAddHandler(dbOps)(
				request("POST", {
					account_id: accountId,
					model: "opus",
					priority,
				}),
				combo.id,
			);

			expect(response.status).toBe(422);
			expect(addComboSlot).not.toHaveBeenCalled();
		});
	}

	for (const [label, overrides] of [
		["mapping", { model_mappings: JSON.stringify({ opus: "gpt-5" }) }],
		["provider", { provider: "ollama", refresh_token: null }],
	] as const) {
		it(`rejects a non-native Opus ${label}`, async () => {
			const { dbOps, addComboSlot } = makeDb(
				[primary],
				[fableNativeAssignment],
				[nativeAccount("account-a", overrides)],
			);
			const response = await createSlotAddHandler(dbOps)(
				request("POST", {
					account_id: "account-a",
					model: "opus",
					priority: 1,
				}),
				combo.id,
			);

			expect(response.status).toBe(422);
			expect(addComboSlot).not.toHaveBeenCalled();
		});
	}

	it("rejects incompatible simultaneous active native assignments", async () => {
		const opusNativeAssignment: ComboFamilyAssignment = {
			...fableNativeAssignment,
			family: "opus",
		};
		const { dbOps, addComboSlot } = makeDb(
			[primary],
			[fableNativeAssignment, opusNativeAssignment],
			[nativeAccount("account-a")],
		);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-a",
				model: "opus",
				priority: 1,
			}),
			combo.id,
		);

		expect(response.status).toBe(422);
		expect(addComboSlot).not.toHaveBeenCalled();
	});

	it("keeps legacy Fable assignments from accepting Opus", async () => {
		const { dbOps, addComboSlot } = makeDb(
			[],
			[{ ...fableNativeAssignment, exhaustion_policy: "legacy" }],
		);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-a",
				model: "opus",
				priority: 1,
			}),
			combo.id,
		);

		expect(response.status).toBe(400);
		expect(addComboSlot).not.toHaveBeenCalled();
	});

	it("keeps unrelated family validation unchanged", async () => {
		const sonnetAssignment: ComboFamilyAssignment = {
			...fableNativeAssignment,
			family: "sonnet",
		};
		const { dbOps, addComboSlot } = makeDb([], [sonnetAssignment]);
		const response = await createSlotAddHandler(dbOps)(
			request("POST", {
				account_id: "account-a",
				model: "opus",
				priority: 1,
			}),
			combo.id,
		);

		expect(response.status).toBe(400);
		expect(addComboSlot).not.toHaveBeenCalled();
	});
});
