import type {
	ComboMembershipMode,
	ComboMembershipReasonCode,
	ComboMembershipResolution,
	ComboMembershipSource,
} from "@better-ccflare/types";

export interface ComboMembershipDiagnosticsSelection {
	readonly source: ComboMembershipSource;
	readonly tier: number;
	readonly eligibleCandidateCount: number;
}

export interface ComboMembershipDiagnostics {
	readonly family: ComboMembershipResolution["family"];
	readonly comboId: string | null;
	readonly active: boolean;
	readonly membershipMode: ComboMembershipMode;
	readonly memberCount: number;
	readonly sourceCounts: Readonly<Record<ComboMembershipSource, number>>;
	readonly reasonCounts: Readonly<
		Partial<Record<ComboMembershipReasonCode, number>>
	>;
	readonly selectedSource: ComboMembershipSource | null;
	readonly selectedTier: number | null;
	readonly eligibleCandidateCount: number;
}

export function buildComboMembershipDiagnostics(
	resolution: ComboMembershipResolution,
	membershipMode: ComboMembershipMode,
	selection: ComboMembershipDiagnosticsSelection | null,
): ComboMembershipDiagnostics {
	const sourceCounts: Record<ComboMembershipSource, number> = {
		manual: 0,
		managed: 0,
	};
	for (const member of resolution.members) {
		sourceCounts[member.source]++;
	}

	const reasonCounts: Partial<Record<ComboMembershipReasonCode, number>> = {};
	for (const decision of resolution.decisions) {
		reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
	}

	return {
		family: resolution.family,
		comboId: resolution.combo_id,
		active: resolution.active,
		membershipMode,
		memberCount: resolution.members.length,
		sourceCounts,
		reasonCounts,
		selectedSource: selection?.source ?? null,
		selectedTier: selection?.tier ?? null,
		eligibleCandidateCount: selection?.eligibleCandidateCount ?? 0,
	};
}
