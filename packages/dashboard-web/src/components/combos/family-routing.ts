import {
	getModelDisplayName,
	getModelFamily,
	LATEST_MODEL_BY_FAMILY,
} from "@better-ccflare/core";
import type {
	Combo,
	ComboEnrollmentRule,
	ComboFamily,
	ComboFamilyAssignment,
	ComboMembershipDecisionView,
	ComboMembershipExclusion,
	ComboMembershipReasonCode,
	ComboRoutingMemberDelta,
	ComboRoutingPreviewResult,
	ComboRoutingProposalPreview,
	ComboSlot,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { useModelOptions } from "../../hooks/queries";
import {
	routingAvailabilityLabel,
	routingReasonLabel,
} from "../accounts/account-routing";

export interface FamilyRoutingModelOption {
	id: string;
	displayName: string;
}

export interface FamilyRoutingMemberProjection {
	member: EffectiveComboMemberView;
	sourceLabel: "Manual" | "Managed";
	reasonLabel: string;
	availabilityLabel: string;
	isManualOverride: boolean;
}

export interface FamilyRoutingDecisionProjection {
	decision: ComboMembershipDecisionView;
	reasonLabel: string;
	availabilityLabel: string;
	isExcluded: boolean;
	isRejected: boolean;
}

export interface FamilyRoutingProjection {
	family: ComboFamily;
	assignment: ComboFamilyAssignment;
	combo: Combo | null;
	/** Persisted configuration only, including disabled slots. */
	manualSlots: ComboSlot[];
	/** Authoritative effective manual members; never reconstructed from slots. */
	manualMembers: FamilyRoutingMemberProjection[];
	/** Authoritative virtual members returned by the server resolver. */
	managedMembers: FamilyRoutingMemberProjection[];
	/** Authoritative included and rejected decisions, with display-only labels. */
	decisions: FamilyRoutingDecisionProjection[];
	rules: ComboEnrollmentRule[];
	exclusions: ComboMembershipExclusion[];
}

export interface FamilyRoutingProposalProjection {
	proposal: ComboRoutingProposalPreview;
	proposedRouting: FamilyRoutingProjection;
	/** Exact server-owned before/after comparison; never recomputed client-side. */
	memberDelta: ComboRoutingMemberDelta[];
}

export interface FamilyRoutingConversionProjection {
	previewId: string;
	family: ComboFamily;
	managedModel: string;
	currentRouting: FamilyRoutingProjection;
	proposals: FamilyRoutingProposalProjection[];
}

/** Stable copy for the family-routing UI's reason badges and callouts. */
export function familyRoutingReasonLabel(
	reason: ComboMembershipReasonCode,
): string {
	return routingReasonLabel(reason);
}

function projectMember(
	member: EffectiveComboMemberView,
): FamilyRoutingMemberProjection {
	return {
		member,
		sourceLabel: member.source === "manual" ? "Manual" : "Managed",
		reasonLabel: familyRoutingReasonLabel(member.reason),
		availabilityLabel: routingAvailabilityLabel(member.availability.reason),
		isManualOverride: member.reason === "manual_override",
	};
}

function projectDecision(
	decision: ComboMembershipDecisionView,
): FamilyRoutingDecisionProjection {
	return {
		decision,
		reasonLabel: familyRoutingReasonLabel(decision.reason),
		availabilityLabel: routingAvailabilityLabel(decision.availability.reason),
		isExcluded: decision.reason === "excluded",
		isRejected: !decision.included,
	};
}

/**
 * Produce display state solely from the server's coherent policy + resolution.
 * Rules, slots, and decisions are never treated as inferred effective members.
 */
export function projectFamilyRouting(
	view: EffectiveComboRoutingView,
): FamilyRoutingProjection {
	const projectedMembers = view.resolution.members.map(projectMember);
	return {
		family: view.family,
		assignment: view.policy.assignment,
		combo: view.policy.combo,
		manualSlots: [...view.policy.slots],
		manualMembers: projectedMembers.filter(
			({ member }) => member.source === "manual",
		),
		managedMembers: projectedMembers.filter(
			({ member }) => member.source === "managed",
		),
		decisions: view.resolution.decisions.map(projectDecision),
		rules: [...view.policy.rules],
		exclusions: [...view.policy.exclusions],
	};
}

/** Preserve one projection for every assignment returned by the server. */
export function projectFamilyRoutings(
	views: readonly EffectiveComboRoutingView[],
): FamilyRoutingProjection[] {
	return views.map(projectFamilyRouting);
}

/**
 * Shape a conversion preview without reproducing membership or delta logic in
 * the browser. Both proposed membership and member_delta remain server-owned.
 */
export function projectFamilyConversionPreview(
	preview: ComboRoutingPreviewResult,
): FamilyRoutingConversionProjection {
	return {
		previewId: preview.preview_id,
		family: preview.family,
		managedModel: preview.managed_model,
		currentRouting: projectFamilyRouting(preview.effective),
		proposals: preview.proposals.map((proposal) => ({
			proposal,
			proposedRouting: projectFamilyRouting(proposal.proposed_effective),
			memberDelta: proposal.member_delta,
		})),
	};
}

/**
 * Restrict the live model catalog to the selected family using the canonical
 * family classifier. The latest logical model is always available as fallback.
 */
export function familyModelOptions(
	family: ComboFamily,
	modelOptions: readonly FamilyRoutingModelOption[],
): FamilyRoutingModelOption[] {
	const latest = LATEST_MODEL_BY_FAMILY[family];
	const latestFromCatalog = modelOptions.find(({ id }) => id === latest);
	const candidates = [
		latestFromCatalog ?? {
			id: latest,
			displayName: getModelDisplayName(latest),
		},
		...modelOptions,
	];
	const seen = new Set<string>();
	return candidates.filter(({ id }) => {
		if (seen.has(id) || getModelFamily(id) !== family) return false;
		seen.add(id);
		return true;
	});
}

/** Family-filtered choices backed by the shared live-catalog hook. */
export function useFamilyModelOptions(
	family: ComboFamily,
): FamilyRoutingModelOption[] {
	return familyModelOptions(family, useModelOptions());
}
