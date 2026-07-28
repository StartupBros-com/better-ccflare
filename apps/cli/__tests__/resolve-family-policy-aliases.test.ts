/**
 * P1 regression coverage for `--resolve-family-policy-aliases`
 * (apps/cli/src/main.ts, `resolveFamilyPolicyAliases`).
 *
 * This is the rollback-safety sweep operators run before downgrading to a
 * binary that predates family-alias support (docs/combos.md): it rewrites
 * every stored bare family-alias value (the literal family word, e.g.
 * "opus") to its currently-resolved concrete model, both in a family's
 * managed_model policy field and in individual combo slot model fields. It
 * mutates rows in place and previously shipped with zero test coverage.
 *
 * dbOps is a hand-built mock exposing only the five DatabaseOperations
 * methods the sweep actually calls (getFamilyAssignments, setFamilyPolicy,
 * listCombos, getComboSlots, updateComboSlot) — no real database is ever
 * opened, so this can never touch a developer's or operator's live DB.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { LATEST_MODEL_BY_FAMILY } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import type {
	Combo,
	ComboFamilyAssignment,
	ComboSlot,
} from "@better-ccflare/types";
import { resolveFamilyPolicyAliases } from "../src/main";

function assignment(
	overrides: Partial<ComboFamilyAssignment> = {},
): ComboFamilyAssignment {
	return {
		family: "opus",
		combo_id: null,
		enabled: true,
		membership_mode: "managed",
		managed_model: null,
		...overrides,
	};
}

function combo(overrides: Partial<Combo> = {}): Combo {
	return {
		id: "combo-1",
		name: "Combo 1",
		description: null,
		enabled: true,
		created_at: 0,
		updated_at: 0,
		...overrides,
	};
}

function slot(overrides: Partial<ComboSlot> = {}): ComboSlot {
	return {
		id: "slot-1",
		combo_id: "combo-1",
		account_id: "account-1",
		model: "claude-opus-4-8",
		priority: 0,
		enabled: true,
		...overrides,
	};
}

function makeDb(options: {
	assignments?: ComboFamilyAssignment[];
	combos?: Combo[];
	slotsByCombo?: Record<string, ComboSlot[]>;
}) {
	const { assignments = [], combos = [], slotsByCombo = {} } = options;
	const setFamilyPolicy = mock(
		async (
			family: ComboFamilyAssignment["family"],
			fields: Partial<ComboFamilyAssignment>,
		) => ({ ...assignment({ family }), ...fields }),
	);
	const updateComboSlot = mock(
		async (slotId: string, fields: Partial<ComboSlot>) => ({
			...slot({ id: slotId }),
			...fields,
		}),
	);
	return {
		dbOps: {
			getFamilyAssignments: mock(async () => assignments),
			setFamilyPolicy,
			listCombos: mock(async () => combos),
			getComboSlots: mock(
				async (comboId: string) => slotsByCombo[comboId] ?? [],
			),
			updateComboSlot,
		} as unknown as DatabaseOperations,
		setFamilyPolicy,
		updateComboSlot,
	};
}

describe("resolveFamilyPolicyAliases", () => {
	let logSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		logSpy?.mockRestore();
	});

	it("rewrites an alias-valued family policy managed_model to the concrete latest-model value", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps, setFamilyPolicy, updateComboSlot } = makeDb({
			assignments: [assignment({ family: "opus", managed_model: "opus" })],
		});

		await resolveFamilyPolicyAliases(dbOps);

		expect(setFamilyPolicy).toHaveBeenCalledTimes(1);
		expect(setFamilyPolicy).toHaveBeenCalledWith("opus", {
			managed_model: LATEST_MODEL_BY_FAMILY.opus,
		});
		expect(updateComboSlot).not.toHaveBeenCalled();
	});

	it("rewrites an alias-valued combo slot model to the concrete latest-model value", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps, setFamilyPolicy, updateComboSlot } = makeDb({
			combos: [combo({ id: "combo-1" })],
			slotsByCombo: {
				"combo-1": [slot({ id: "slot-1", model: "sonnet" })],
			},
		});

		await resolveFamilyPolicyAliases(dbOps);

		expect(updateComboSlot).toHaveBeenCalledTimes(1);
		expect(updateComboSlot).toHaveBeenCalledWith("slot-1", {
			model: LATEST_MODEL_BY_FAMILY.sonnet,
		});
		expect(setFamilyPolicy).not.toHaveBeenCalled();
	});

	it("leaves an already-concrete family policy and slot value untouched with no spurious write", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps, setFamilyPolicy, updateComboSlot } = makeDb({
			assignments: [
				assignment({ family: "opus", managed_model: "claude-opus-4-8" }),
			],
			combos: [combo({ id: "combo-1" })],
			slotsByCombo: {
				"combo-1": [slot({ id: "slot-1", model: "claude-sonnet-4-5" })],
			},
		});

		await resolveFamilyPolicyAliases(dbOps);

		expect(setFamilyPolicy).not.toHaveBeenCalled();
		expect(updateComboSlot).not.toHaveBeenCalled();
	});

	it("is a genuine no-op — issues no DB writes — when there is nothing to resolve", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps, setFamilyPolicy, updateComboSlot } = makeDb({
			assignments: [assignment({ family: "opus", managed_model: null })],
			combos: [combo({ id: "combo-1" })],
			slotsByCombo: { "combo-1": [] },
		});

		await resolveFamilyPolicyAliases(dbOps);

		expect(setFamilyPolicy).not.toHaveBeenCalled();
		expect(updateComboSlot).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("No stored family-alias values found"),
		);
	});

	it("reports a summary count that matches exactly what it changed", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps } = makeDb({
			assignments: [
				assignment({ family: "opus", managed_model: "opus" }),
				assignment({ family: "sonnet", managed_model: "claude-sonnet-4-5" }),
			],
			combos: [combo({ id: "combo-1" }), combo({ id: "combo-2" })],
			slotsByCombo: {
				"combo-1": [slot({ id: "slot-1", model: "haiku" })],
				"combo-2": [slot({ id: "slot-2", model: "claude-opus-4-8" })],
			},
		});

		await resolveFamilyPolicyAliases(dbOps);

		// Two real rewrites: the "opus" family policy alias and the "haiku"
		// slot alias. The concrete sonnet policy and concrete opus slot must
		// not inflate the count.
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Rewrote 2 stored family-alias values"),
		);
	});

	it("does not double-count a single slot matching more than one family word", async () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		const { dbOps, updateComboSlot } = makeDb({
			combos: [combo({ id: "combo-1" })],
			slotsByCombo: {
				"combo-1": [slot({ id: "slot-1", model: "opus" })],
			},
		});

		await resolveFamilyPolicyAliases(dbOps);

		expect(updateComboSlot).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Rewrote 1 stored family-alias value"),
		);
	});
});
