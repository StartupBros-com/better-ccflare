import {
	COMBO_SLOT_PRIORITY_MAX,
	type ComboSlot,
	isComboSlotPriority,
} from "@better-ccflare/types/combo";

export const COMBO_REORDER_WARNING =
	"Dragging intentionally rewrites every slot as a strict 0–N fallback chain, replacing any equal-priority dynamic tiers.";

export function getDefaultComboSlotPriority(
	slots: readonly ComboSlot[],
): number {
	return Math.min(slots.length, COMBO_SLOT_PRIORITY_MAX);
}

export function parseComboSlotPriority(value: string): number | null {
	if (value.trim().length === 0) return null;
	const parsed = Number(value);
	return isComboSlotPriority(parsed) ? parsed : null;
}

interface ComboSlotPriorityKeyActions {
	reset: (value: string) => void;
	requestCommit: () => void;
}

export function handleComboSlotPriorityKeyDown(
	key: string,
	persistedPriority: number,
	{ reset, requestCommit }: ComboSlotPriorityKeyActions,
): void {
	if (key === "Enter") {
		requestCommit();
		return;
	}
	if (key === "Escape") reset(String(persistedPriority));
}
