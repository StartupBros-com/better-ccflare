import type {
	Account,
	ComboEnrollmentRuleProposal,
	ComboFamily,
	ComboMembershipDecision,
	ComboMembershipReasonCode,
	ComboMembershipResolution,
	ComboRouteClass,
	ComboRoutingPolicySnapshot,
	EffectiveComboMember,
	LogicalModelCapability,
} from "@better-ccflare/types";
import { getModelFamily } from "./model-mappings";
import { LATEST_MODEL_BY_FAMILY } from "./models";

export interface ComboResolverDependencies {
	deriveRouteClass(account: Account): ComboRouteClass | null;
	resolveCapability(
		account: Account,
		logicalModel: string,
	): LogicalModelCapability;
}

function isManagedTier(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 100;
}

interface ManagedComboMemberIdInput {
	comboId: string;
	family: ComboFamily;
	ruleId: string;
	accountId: string;
}

export function createManagedComboMemberId({
	comboId,
	family,
	ruleId,
	accountId,
}: ManagedComboMemberIdInput): string {
	return `combo:${comboId}:managed:${family}:rule:${ruleId}:account:${accountId}`;
}

function createManualMember(
	snapshot: ComboRoutingPolicySnapshot,
	slot: ComboRoutingPolicySnapshot["slots"][number],
): EffectiveComboMember {
	return {
		id: `combo:${slot.combo_id}:slot:${slot.id}`,
		account_id: slot.account_id,
		combo_id: slot.combo_id,
		family: snapshot.assignment.family,
		included: true,
		logical_model: slot.model,
		tier: slot.priority,
		source: "manual",
		reason: "included",
		slot_id: slot.id,
		rule_id: null,
	};
}

function toDecision(member: EffectiveComboMember): ComboMembershipDecision {
	const { id: _id, ...decision } = member;
	return decision;
}

function compareMembers(
	a: EffectiveComboMember,
	b: EffectiveComboMember,
): number {
	return (
		a.tier - b.tier ||
		(a.source === b.source ? 0 : a.source === "manual" ? -1 : 1) ||
		a.id.localeCompare(b.id)
	);
}

function compareDecisions(
	a: ComboMembershipDecision,
	b: ComboMembershipDecision,
): number {
	return (
		a.account_id.localeCompare(b.account_id) ||
		(a.slot_id ?? "").localeCompare(b.slot_id ?? "") ||
		(a.rule_id ?? "").localeCompare(b.rule_id ?? "") ||
		a.reason.localeCompare(b.reason)
	);
}

function rejectedDecision(
	snapshot: ComboRoutingPolicySnapshot,
	accountId: string,
	reason: ComboMembershipReasonCode,
	options: {
		logicalModel?: string | null;
		tier?: number | null;
		slotId?: string | null;
		ruleId?: string | null;
	} = {},
): ComboMembershipDecision {
	return {
		account_id: accountId,
		combo_id: snapshot.assignment.combo_id ?? snapshot.combo?.id ?? "",
		family: snapshot.assignment.family,
		included: false,
		logical_model: options.logicalModel ?? null,
		tier: options.tier ?? null,
		source: null,
		reason,
		slot_id: options.slotId ?? null,
		rule_id: options.ruleId ?? null,
	};
}

function resolveManagedModel(
	snapshot: ComboRoutingPolicySnapshot,
): string | null {
	const model =
		snapshot.assignment.managed_model ??
		LATEST_MODEL_BY_FAMILY[snapshot.assignment.family];
	return getModelFamily(model) === snapshot.assignment.family ? model : null;
}

export function resolveEffectiveComboMembership(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	deps: ComboResolverDependencies,
): ComboMembershipResolution {
	const comboId = snapshot.assignment.combo_id;
	const inactive =
		!snapshot.assignment.enabled ||
		!comboId ||
		!snapshot.combo?.enabled ||
		snapshot.combo.id !== comboId;
	if (inactive) {
		return {
			family: snapshot.assignment.family,
			combo_id: comboId,
			active: false,
			reason: "disabled",
			members: [],
			decisions: snapshot.slots
				.map((slot) =>
					rejectedDecision(snapshot, slot.account_id, "disabled", {
						slotId: slot.id,
					}),
				)
				.sort(compareDecisions),
		};
	}

	const members = snapshot.slots
		.filter((slot) => slot.enabled && slot.combo_id === comboId)
		.map((slot) => createManualMember(snapshot, slot));
	const decisions: ComboMembershipDecision[] = members.map(toDecision);
	for (const slot of snapshot.slots) {
		if (!slot.enabled && slot.combo_id === comboId) {
			decisions.push(
				rejectedDecision(snapshot, slot.account_id, "disabled", {
					slotId: slot.id,
				}),
			);
		}
	}

	if (snapshot.assignment.membership_mode === "manual") {
		members.sort(compareMembers);
		decisions.sort(compareDecisions);
		return {
			family: snapshot.assignment.family,
			combo_id: comboId,
			active: true,
			reason: "included",
			members,
			decisions,
		};
	}

	const managedModel = resolveManagedModel(snapshot);
	if (!managedModel) {
		return {
			family: snapshot.assignment.family,
			combo_id: comboId,
			active: true,
			reason: "ambiguous",
			members: members.sort(compareMembers),
			decisions: decisions.sort(compareDecisions),
		};
	}

	const manualAccountIds = new Set(members.map((member) => member.account_id));
	const excludedAccountIds = new Set(
		snapshot.exclusions
			.filter(
				(exclusion) =>
					exclusion.combo_id === comboId &&
					exclusion.family === snapshot.assignment.family,
			)
			.map((exclusion) => exclusion.account_id),
	);
	const rulesByRoute = new Map<string, ComboRoutingPolicySnapshot["rules"]>();
	for (const rule of snapshot.rules) {
		if (
			rule.combo_id !== comboId ||
			rule.family !== snapshot.assignment.family
		) {
			continue;
		}
		const key = `${rule.provider}\u0000${rule.route_class}`;
		const existing = rulesByRoute.get(key);
		if (existing) existing.push(rule);
		else rulesByRoute.set(key, [rule]);
	}

	for (const current of [...accounts].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		const routeClass = deps.deriveRouteClass(current);
		if (!routeClass) continue;
		const rules = rulesByRoute.get(`${current.provider}\u0000${routeClass}`);
		if (!rules || rules.length === 0) continue;
		if (rules.length > 1) {
			decisions.push(
				rejectedDecision(snapshot, current.id, "ambiguous", {
					logicalModel: managedModel,
					tier: current.priority,
				}),
			);
			continue;
		}

		const rule = rules[0];
		if (!rule.enabled) {
			decisions.push(
				rejectedDecision(snapshot, current.id, "disabled", {
					logicalModel: managedModel,
					tier: current.priority,
					ruleId: rule.id,
				}),
			);
			continue;
		}
		if (manualAccountIds.has(current.id)) {
			decisions.push(
				rejectedDecision(snapshot, current.id, "manual_override", {
					logicalModel: managedModel,
					tier: current.priority,
					ruleId: rule.id,
				}),
			);
			continue;
		}
		if (excludedAccountIds.has(current.id)) {
			decisions.push(
				rejectedDecision(snapshot, current.id, "excluded", {
					logicalModel: managedModel,
					tier: current.priority,
					ruleId: rule.id,
				}),
			);
			continue;
		}
		if (!isManagedTier(current.priority)) {
			decisions.push(
				rejectedDecision(snapshot, current.id, "ambiguous", {
					logicalModel: managedModel,
					ruleId: rule.id,
				}),
			);
			continue;
		}

		const capability = deps.resolveCapability(current, managedModel);
		if (capability.status !== "supported") {
			decisions.push(
				rejectedDecision(snapshot, current.id, capability.reason, {
					logicalModel: managedModel,
					tier: current.priority,
					ruleId: rule.id,
				}),
			);
			continue;
		}

		const member: EffectiveComboMember = {
			id: createManagedComboMemberId({
				comboId,
				family: snapshot.assignment.family,
				ruleId: rule.id,
				accountId: current.id,
			}),
			account_id: current.id,
			combo_id: comboId,
			family: snapshot.assignment.family,
			included: true,
			logical_model: managedModel,
			tier: current.priority,
			source: "managed",
			reason: "included",
			slot_id: null,
			rule_id: rule.id,
		};
		members.push(member);
		decisions.push(toDecision(member));
	}

	members.sort(compareMembers);
	decisions.sort(compareDecisions);
	return {
		family: snapshot.assignment.family,
		combo_id: comboId,
		active: true,
		reason: "included",
		members,
		decisions,
	};
}

function blockedProposal(
	snapshot: ComboRoutingPolicySnapshot,
	provider: string,
	routeClass: ComboRouteClass,
	managedModel: string,
	reason: ComboMembershipReasonCode,
	existingRuleId: string | null = null,
): ComboEnrollmentRuleProposal {
	return {
		family: snapshot.assignment.family,
		combo_id: snapshot.combo?.id ?? snapshot.assignment.combo_id ?? "",
		provider,
		route_class: routeClass,
		existing_rule_id: existingRuleId,
		managed_model: managedModel,
		tier_source: "account_priority",
		high_confidence: false,
		selected_by_default: false,
		reason,
	};
}

export function proposeComboEnrollmentRules(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	draftAccount: Account,
	deps: ComboResolverDependencies,
): ComboEnrollmentRuleProposal[] {
	if (
		!snapshot.assignment.enabled ||
		!snapshot.combo?.enabled ||
		!snapshot.assignment.combo_id ||
		snapshot.combo.id !== snapshot.assignment.combo_id
	) {
		return [];
	}

	const routeClass = deps.deriveRouteClass(draftAccount);
	if (!routeClass) return [];
	const managedModel = LATEST_MODEL_BY_FAMILY[snapshot.assignment.family];
	const base = (
		reason: ComboMembershipReasonCode,
		existingRuleId: string | null = null,
	) =>
		blockedProposal(
			snapshot,
			draftAccount.provider,
			routeClass,
			managedModel,
			reason,
			existingRuleId,
		);
	const matchingRules = snapshot.rules.filter(
		(rule) =>
			rule.family === snapshot.assignment.family &&
			rule.combo_id === snapshot.assignment.combo_id &&
			rule.provider === draftAccount.provider &&
			rule.route_class === routeClass,
	);
	if (matchingRules.some((rule) => rule.enabled)) return [];
	if (matchingRules.length === 1) {
		return [base("disabled", matchingRules[0].id)];
	}
	if (matchingRules.length > 1) return [base("ambiguous")];
	const peerAccounts = new Map(
		accounts.map((current) => [current.id, current]),
	);
	const peerSlots = snapshot.slots.filter((slot) => slot.enabled);
	if (peerSlots.length === 0) return [base("ambiguous")];
	if (
		new Set(peerSlots.map((slot) => slot.account_id)).size !== peerSlots.length
	) {
		return [base("ambiguous")];
	}

	if (
		snapshot.exclusions.some(
			(exclusion) =>
				exclusion.combo_id === snapshot.combo?.id &&
				exclusion.family === snapshot.assignment.family &&
				(exclusion.account_id === draftAccount.id ||
					peerSlots.some((slot) => slot.account_id === exclusion.account_id)),
		)
	) {
		return [base("excluded")];
	}

	for (const slot of peerSlots) {
		const peer = peerAccounts.get(slot.account_id);
		if (
			!peer ||
			peer.provider !== draftAccount.provider ||
			deps.deriveRouteClass(peer) !== routeClass ||
			getModelFamily(slot.model) !== snapshot.assignment.family ||
			slot.priority !== peer.priority
		) {
			return [base("ambiguous")];
		}
		const peerCapability = deps.resolveCapability(peer, managedModel);
		if (peerCapability.status !== "supported") {
			return [base(peerCapability.reason)];
		}
	}

	const capability = deps.resolveCapability(draftAccount, managedModel);
	if (capability.status !== "supported") return [base(capability.reason)];

	return [
		{
			...base("included"),
			high_confidence: true,
			selected_by_default: true,
		},
	];
}
