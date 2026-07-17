import type { ComboSlotInfo } from "../src/api";

/** Legacy public shape: downstream producers only provide account/model pairs. */
export const legacyComboSlotInfo = {
	comboName: "legacy-combo",
	slots: [{ accountId: "account-1", modelOverride: "claude-opus-4-8" }],
} satisfies ComboSlotInfo;
