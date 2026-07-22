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
	| "ambiguous";
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
	family: ComboFamily;
	combo_id: string;
	provider: string;
	route_class: ComboRouteClass;
	/** Existing disabled rule to reactivate instead of creating a duplicate. */
	existing_rule_id: string | null;
	managed_model: string;
	tier_source: "account_priority";
	high_confidence: boolean;
	selected_by_default: boolean;
	reason: ComboMembershipReasonCode;
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
