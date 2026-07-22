export type ComboFamily = "fable" | "opus" | "sonnet" | "haiku";
export type ComboMembershipMode = "manual" | "managed";
export type ComboRouteClass =
	| "oauth-subscription"
	| "api-key"
	| "local"
	| "cloud-credential";
export type ComboMembershipSource = "manual" | "managed";
export type ComboMembershipReasonCode =
	| "included"
	| "manual_override"
	| "excluded"
	| "unsupported"
	| "unknown"
	| "disabled"
	| "ambiguous"
	| "new_billing_class";
export type LogicalModelCapabilityStatus =
	| "supported"
	| "unsupported"
	| "unknown";
export type LogicalModelCapabilityProvenance =
	| "explicit_account_mapping"
	| "provider_default"
	| "native_passthrough"
	| "undeclared";

/** Pure, preview-safe model support declaration. Never contains physical mappings. */
export interface LogicalModelCapability {
	status: LogicalModelCapabilityStatus;
	provenance: LogicalModelCapabilityProvenance;
	reason: "included" | "unsupported" | "unknown";
}

export const COMBO_SLOT_PRIORITY_MIN = 0;
export const COMBO_SLOT_PRIORITY_MAX = 100;

export function isComboSlotPriority(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= COMBO_SLOT_PRIORITY_MIN &&
		value <= COMBO_SLOT_PRIORITY_MAX
	);
}

// Database row types (snake_case, INTEGER booleans — match SQLite storage)
export interface ComboRow {
	id: string;
	name: string;
	description: string | null;
	enabled: number; // 0 or 1
	created_at: number;
	updated_at: number;
}

export interface ComboSlotRow {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: number; // 0 or 1
}

export interface ComboFamilyAssignmentRow {
	family: string;
	combo_id: string | null;
	enabled: number; // 0 or 1
	membership_mode: string;
	managed_model: string | null;
}

export interface ComboEnrollmentRuleRow {
	id: string;
	family: string;
	combo_id: string;
	provider: string;
	route_class: string;
	enabled: number; // 0 or 1
	created_at: number;
	updated_at: number;
}

export interface ComboMembershipExclusionRow {
	id: string;
	family: string;
	combo_id: string;
	account_id: string;
	created_at: number;
}

// Domain model types (camelCase, proper booleans)
export interface Combo {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface ComboSlot {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
}

export interface ComboSlotCreateInput {
	account_id: string;
	model: string;
	priority?: number;
	enabled?: boolean;
}

export interface ComboSlotUpdateInput {
	model?: string;
	priority?: number;
	enabled?: boolean;
}

export interface ComboFamilyAssignment {
	family: ComboFamily;
	combo_id: string | null;
	enabled: boolean;
	membership_mode: ComboMembershipMode;
	managed_model: string | null;
}

export interface ComboEnrollmentRule {
	id: string;
	family: ComboFamily;
	combo_id: string;
	provider: string;
	route_class: ComboRouteClass;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface ComboEnrollmentRuleCreateInput {
	id?: string;
	family: ComboFamily;
	combo_id: string;
	provider: string;
	route_class: ComboRouteClass;
	enabled?: boolean;
}

export interface ComboEnrollmentRuleUpdateInput {
	provider?: string;
	route_class?: ComboRouteClass;
	enabled?: boolean;
}

export interface ComboMembershipExclusion {
	id: string;
	family: ComboFamily;
	combo_id: string;
	account_id: string;
	created_at: number;
}

export interface ComboMembershipExclusionCreateInput {
	id?: string;
	family: ComboFamily;
	combo_id: string;
	account_id: string;
}

export interface ComboFamilyPolicyUpdateInput {
	combo_id?: string | null;
	enabled?: boolean;
	membership_mode?: ComboMembershipMode;
	managed_model?: string | null;
}

export interface ComboFamilyPolicyChanges {
	family: ComboFamily;
	/** Internal compare-and-swap token captured with a coherent preview read. */
	expected_revision?: number;
	assignment?: ComboFamilyPolicyUpdateInput;
	create_rules?: Array<Omit<ComboEnrollmentRuleCreateInput, "family">>;
	update_rules?: Array<{
		id: string;
		fields: ComboEnrollmentRuleUpdateInput;
	}>;
	delete_rule_ids?: string[];
	create_exclusions?: Array<
		Omit<ComboMembershipExclusionCreateInput, "family">
	>;
	delete_exclusion_ids?: string[];
}

/** Durable acknowledgement returned after a policy mutation transaction commits. */
export interface ComboFamilyPolicyApplyResult {
	family: ComboFamily;
	applied: true;
	mutation_count: number;
}

export interface ComboRoutingPolicySnapshot {
	assignment: ComboFamilyAssignment;
	combo: Combo | null;
	slots: ComboSlot[];
	rules: ComboEnrollmentRule[];
	exclusions: ComboMembershipExclusion[];
}

/** Stable, presentation-safe decision emitted by the pure membership resolver. */
export interface ComboMembershipDecision {
	account_id: string;
	combo_id: string;
	family: ComboFamily;
	included: boolean;
	logical_model: string | null;
	tier: number | null;
	source: ComboMembershipSource | null;
	reason: ComboMembershipReasonCode;
	slot_id: string | null;
	rule_id: string | null;
}

/** Shared member contract populated by the pure resolver in the next unit. */
export interface EffectiveComboMember extends ComboMembershipDecision {
	id: string;
	included: true;
	logical_model: string;
	tier: number;
	source: ComboMembershipSource;
}

/** Authoritative pure membership result shared by routing and presentation. */
export interface ComboMembershipResolution {
	family: ComboFamily;
	combo_id: string | null;
	active: boolean;
	reason: ComboMembershipReasonCode | null;
	members: EffectiveComboMember[];
	decisions: ComboMembershipDecision[];
}

/** A visible peer-derived policy suggestion; never applied by the resolver. */
export interface ComboEnrollmentRuleProposal {
	/** Deterministic, review-safe identity for this exact server proposal. */
	proposal_id: string;
	family: ComboFamily;
	combo_id: string;
	provider: string;
	route_class: ComboRouteClass;
	/** Existing rule to reuse or reactivate instead of creating a duplicate. */
	existing_rule_id: string | null;
	managed_model: string;
	tier_source: "account_priority";
	high_confidence: boolean;
	selected_by_default: boolean;
	reason: ComboMembershipReasonCode;
}

/** Non-secret authentication metadata accepted by managed-routing preview. */
export interface ComboRoutingAccountDraft {
	provider: string;
	priority: number;
	auth_shape: ComboRouteClass;
	billing_type?: "plan" | "api" | null;
	/** Optional routing-only input. It is never echoed by the API. */
	model_mappings?: Record<string, string | string[]> | null;
}

export type ComboRoutingPreviewSubject =
	| { account_id: string; draft?: never }
	| { account_id?: never; draft: ComboRoutingAccountDraft };

/** Server-owned inference scope for a reviewed routing preview. */
export type ComboRoutingPreviewScope = "account" | "family";

export type ComboRoutingAvailabilityReason =
	| "available"
	| "paused"
	| "requires_reauth"
	| "rate_limited"
	| "model_exhausted";

export interface ComboRoutingAvailabilitySummary {
	available: boolean;
	reason: ComboRoutingAvailabilityReason;
}

export interface EffectiveComboMemberView
	extends Omit<EffectiveComboMember, "id"> {
	/** Null only for a non-persisted account in a proposal preview. */
	id: string | null;
	account_name: string;
	availability: ComboRoutingAvailabilitySummary;
	identity_provisional: boolean;
}

export interface ComboMembershipDecisionView extends ComboMembershipDecision {
	account_name: string;
	availability: ComboRoutingAvailabilitySummary;
	identity_provisional: boolean;
}

/** Secret-free authoritative family policy and effective-membership view. */
export interface EffectiveComboRoutingView {
	family: ComboFamily;
	policy: ComboRoutingPolicySnapshot;
	resolution: Omit<ComboMembershipResolution, "members" | "decisions"> & {
		members: EffectiveComboMemberView[];
		decisions: ComboMembershipDecisionView[];
	};
}

export interface ComboRoutingPreviewMemberState {
	/** Hash of stable, non-secret candidate ownership used to correlate changes. */
	key: string;
	/** Persisted identity only; null for a draft subject. */
	account_id: string | null;
	/** Durable slot/managed-candidate identity only; null for a draft subject. */
	candidate_id: string | null;
	identity_provisional: boolean;
	source: ComboMembershipSource;
	tier: number;
	logical_model: string;
	reason: ComboMembershipReasonCode;
}

export interface ComboRoutingMemberDelta {
	key: string;
	status: "added" | "removed" | "changed" | "unchanged";
	before: ComboRoutingPreviewMemberState | null;
	after: ComboRoutingPreviewMemberState | null;
}

export interface ComboRoutingProposalPreview
	extends ComboEnrollmentRuleProposal {
	/** Authoritative resolver result if this exact proposal were applied. */
	proposed_effective: EffectiveComboRoutingView;
	/** Exact server-owned before/after member comparison. */
	member_delta: ComboRoutingMemberDelta[];
}

export interface ComboRoutingPreviewResult {
	preview_id: string;
	scope: ComboRoutingPreviewScope;
	family: ComboFamily;
	/** Resolved reviewed model: override, valid assignment model, then latest. */
	managed_model: string;
	proposals: ComboRoutingProposalPreview[];
	effective: EffectiveComboRoutingView;
}

/** Name-free effective routing projection for the Accounts routing overview. */
export interface AccountRoutingEffectiveMemberView
	extends Omit<EffectiveComboMemberView, "account_name"> {}

/** Name-free rejected/included decision for the Accounts routing overview. */
export interface AccountRoutingMembershipDecisionView
	extends Omit<ComboMembershipDecisionView, "account_name"> {}

/**
 * Authoritative family state used by account cards. Account names are already
 * available from the Accounts API and are deliberately not repeated here.
 */
export interface AccountRoutingEffectiveView
	extends Omit<EffectiveComboRoutingView, "resolution"> {
	resolution: Omit<
		EffectiveComboRoutingView["resolution"],
		"members" | "decisions"
	> & {
		members: AccountRoutingEffectiveMemberView[];
		decisions: AccountRoutingMembershipDecisionView[];
	};
}

/** Compact, server-approved notice that an outside account can join a route. */
export interface AccountRoutingOpportunityView {
	account_id: string;
	family: ComboFamily;
	proposal_id: string;
	combo_id: string;
	managed_model: string;
	tier_source: "account_priority";
	reason: ComboMembershipReasonCode;
}

/** One coherent, secret-free routing snapshot for every persisted account. */
export interface AccountRoutingOverview {
	effective: AccountRoutingEffectiveView[];
	opportunities: AccountRoutingOpportunityView[];
}

// Extended type with slots populated
export interface ComboWithSlots extends Combo {
	slots: ComboSlot[];
}

// Converter functions (Row -> Domain)
export function toCombo(row: ComboRow): Combo {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: !!row.enabled,
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

export function toComboSlot(row: ComboSlotRow): ComboSlot {
	return {
		id: row.id,
		combo_id: row.combo_id,
		account_id: row.account_id,
		model: row.model,
		priority: Number(row.priority),
		enabled: !!row.enabled,
	};
}

export function toComboFamilyAssignment(
	row: ComboFamilyAssignmentRow,
): ComboFamilyAssignment {
	return {
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		enabled: !!row.enabled,
		membership_mode: row.membership_mode as ComboMembershipMode,
		managed_model: row.managed_model,
	};
}

export function toComboEnrollmentRule(
	row: ComboEnrollmentRuleRow,
): ComboEnrollmentRule {
	return {
		id: row.id,
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		provider: row.provider,
		route_class: row.route_class as ComboRouteClass,
		enabled: !!row.enabled,
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

export function toComboMembershipExclusion(
	row: ComboMembershipExclusionRow,
): ComboMembershipExclusion {
	return {
		id: row.id,
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		account_id: row.account_id,
		created_at: Number(row.created_at),
	};
}
