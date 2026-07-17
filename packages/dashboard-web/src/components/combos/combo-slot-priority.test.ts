import { describe, expect, it } from "bun:test";
import type { ComboSlot } from "@better-ccflare/types";
import {
	COMBO_REORDER_WARNING,
	getDefaultComboSlotPriority,
	handleComboSlotPriorityKeyDown,
	parseComboSlotPriority,
} from "./combo-slot-priority";

function slot(priority: number): ComboSlot {
	return {
		id: `slot-${priority}`,
		combo_id: "combo-1",
		account_id: `account-${priority}`,
		model: "claude-opus-4-8",
		priority,
		enabled: true,
	};
}

describe("combo slot priority controls", () => {
	it("uses the legacy append index as the add-form default", () => {
		expect(getDefaultComboSlotPriority([])).toBe(0);
		expect(getDefaultComboSlotPriority([slot(0), slot(0), slot(10)])).toBe(3);
	});

	it("keeps the default inside the supported API range", () => {
		expect(
			getDefaultComboSlotPriority(Array.from({ length: 150 }, () => slot(0))),
		).toBe(100);
	});

	it("accepts only integer priority text from 0 through 100", () => {
		expect(parseComboSlotPriority("0")).toBe(0);
		expect(parseComboSlotPriority("100")).toBe(100);
		expect(parseComboSlotPriority(" 42 ")).toBe(42);
		for (const invalid of ["", "-1", "101", "1.5", "not-a-number"]) {
			expect(parseComboSlotPriority(invalid)).toBeNull();
		}
	});

	it("resets a valid edit on Escape without requesting a commit", () => {
		const persistedPriority = 3;
		let visiblePriority = "42";
		const priorityChanges: number[] = [];
		const requestCommit = () => {
			const priority = parseComboSlotPriority(visiblePriority);
			if (priority !== null && priority !== persistedPriority) {
				priorityChanges.push(priority);
			}
		};

		handleComboSlotPriorityKeyDown("Escape", persistedPriority, {
			reset: (value) => {
				visiblePriority = value;
			},
			requestCommit,
		});

		expect(visiblePriority).toBe("3");
		expect(priorityChanges).toEqual([]);
	});

	it("still requests the ordinary blur commit on Enter", () => {
		let commitRequests = 0;

		handleComboSlotPriorityKeyDown("Enter", 3, {
			reset: () => {
				throw new Error("Enter must not reset the edit");
			},
			requestCommit: () => {
				commitRequests += 1;
			},
		});

		expect(commitRequests).toBe(1);
	});

	it("warns that drag reorder intentionally replaces dynamic tiers", () => {
		expect(COMBO_REORDER_WARNING).toContain("strict 0–N fallback chain");
		expect(COMBO_REORDER_WARNING).toContain("equal-priority");
	});
});
