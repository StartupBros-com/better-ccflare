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
import {
	getModelFamily,
	isFamilyAliasModel,
	resolveFamilyAliasModel,
	resolveStoredPolicyAliasModel,
} from "./model-mappings";
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

interface ManualMemberResolution {
	member: EffectiveComboMember;
	/** Non-null when pass-through substitution applied but the account's
	 * capability check rejected the substituted model — the member must be
	 * excluded (not merely marked unsupported) so it participates correctly
	 * in the zero-eligible retry in resolveEffectiveComboMembership. */
	rejected: ComboMembershipDecision | null;
}

/**
 * Build a manual slot's effective member. When `requestedModel` is given and
 * the slot's stored model is a bare family alias, resolveStoredPolicyAliasModel
 * may substitute the client's own same-family requested id in place of
 * LATEST_MODEL_BY_FAMILY (see model-mappings.ts). Manual slots never checked
 * account capability before this feature (every existing caller/test relies
 * on that — see the `counters.capability === 0` assertions in
 * combo-membership-resolver.test.ts); pass-through must not change that for
 * ordinary alias resolution. Capability is only ever consulted here when
 * pass-through actually substituted a *different* model than the no-pass-
 * through resolution would have produced, gating the one new failure mode
 * this introduces: routing a client's own requested id to an account whose
 * model_mappings can't serve it.
 */
function createManualMember(
	snapshot: ComboRoutingPolicySnapshot,
	slot: ComboRoutingPolicySnapshot["slots"][number],
	requestedModel: string | null,
	resolveCapability: ComboResolverDependencies["resolveCapability"],
	accountsById: ReadonlyMap<string, Account>,
): ManualMemberResolution {
	const withoutPassThrough = resolveStoredPolicyAliasModel(slot.model);
	const logicalModel = resolveStoredPolicyAliasModel(
		slot.model,
		requestedModel,
	);
	const member: EffectiveComboMember = {
		id: `combo:${slot.combo_id}:slot:${slot.id}`,
		account_id: slot.account_id,
		combo_id: slot.combo_id,
		family: snapshot.assignment.family,
		included: true,
		logical_model: logicalModel,
		tier: slot.priority,
		source: "manual",
		reason: "included",
		slot_id: slot.id,
		rule_id: null,
	};
	if (logicalModel === withoutPassThrough) {
		return { member, rejected: null };
	}
	const account = accountsById.get(slot.account_id);
	// The account isn't in the resolvable set — can't verify capability, so
	// don't newly block on it; this mirrors manual mode's pre-existing
	// behavior of never needing account lookups to build a member.
	if (!account) {
		return { member, rejected: null };
	}
	const capability = resolveCapability(account, logicalModel);
	if (capability.status !== "supported") {
		return {
			member,
			rejected: rejectedDecision(snapshot, slot.account_id, capability.reason, {
				logicalModel,
				tier: slot.priority,
				slotId: slot.id,
			}),
		};
	}
	return { member, rejected: null };
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
	requestedModel: string | null,
): string | null {
	const raw =
		snapshot.assignment.managed_model ??
		LATEST_MODEL_BY_FAMILY[snapshot.assignment.family];
	const model = resolveFamilyAliasModel(
		raw,
		snapshot.assignment.family,
		requestedModel,
	);
	return getModelFamily(model) === snapshot.assignment.family ? model : null;
}

export interface ResolveEffectiveComboMembershipOptions {
	/**
	 * The client's own requested model, used ONLY to let a bare family alias
	 * pass through a well-formed same-family concrete id instead of always
	 * rewriting to LATEST_MODEL_BY_FAMILY (see model-mappings.ts
	 * resolveFamilyAliasModel). Pass this only from the live account-selector
	 * request path — every other caller (previews, proposals, onboarding)
	 * omits it and gets today's alias-to-LATEST behavior unchanged.
	 */
	requestedModel?: string | null;
}

export function resolveEffectiveComboMembership(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	deps: ComboResolverDependencies,
	options: ResolveEffectiveComboMembershipOptions = {},
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

	const requestedModel = options.requestedModel ?? null;
	const primary = computeActiveMembership(
		snapshot,
		accounts,
		deps,
		comboId,
		requestedModel,
	);
	// Zero-eligible guard: a version-pinned account's model_mappings may only
	// list the newest id, so passing through an older (or a not-yet-mapped
	// newer) client model can leave a combo with zero eligible candidates.
	// Re-resolve once without the requested model — today's LATEST behavior —
	// rather than falling all the way through to ordinary-stock routing.
	if (requestedModel && primary.members.length === 0) {
		return computeActiveMembership(snapshot, accounts, deps, comboId, null);
	}
	return primary;
}

function computeActiveMembership(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	deps: ComboResolverDependencies,
	comboId: string,
	requestedModel: string | null,
): ComboMembershipResolution {
	const accountsById = new Map(
		accounts.map((current) => [current.id, current]),
	);

	// Two manual slots for the same account can resolve to the same concrete
	// model (e.g. one stored as a literal model ID, another as a bare family
	// alias that resolves to that same latest model). Dedupe by
	// (account_id, resolved logical_model), keeping the first member by the
	// existing compare order and demoting the rest to a rejected
	// "manual_override" decision so every enabled slot still yields exactly
	// one decision entry.
	const manualResolutions = snapshot.slots
		.filter((slot) => slot.enabled && slot.combo_id === comboId)
		.map((slot) =>
			createManualMember(
				snapshot,
				slot,
				requestedModel,
				deps.resolveCapability,
				accountsById,
			),
		)
		.sort((a, b) => compareMembers(a.member, b.member));
	const members: EffectiveComboMember[] = [];
	const decisions: ComboMembershipDecision[] = [];
	const seenManualKeys = new Set<string>();
	for (const { member: candidate, rejected } of manualResolutions) {
		if (rejected) {
			decisions.push(rejected);
			continue;
		}
		const key = `${candidate.account_id}\u0000${candidate.logical_model}`;
		if (seenManualKeys.has(key)) {
			decisions.push(
				rejectedDecision(snapshot, candidate.account_id, "manual_override", {
					logicalModel: candidate.logical_model,
					tier: candidate.tier,
					slotId: candidate.slot_id,
				}),
			);
			continue;
		}
		seenManualKeys.add(key);
		members.push(candidate);
		decisions.push(toDecision(candidate));
	}
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

	const managedModel = resolveManagedModel(snapshot, requestedModel);
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
	policyManagedModel: string,
	reason: ComboMembershipReasonCode,
	existingRuleId: string | null = null,
): ComboEnrollmentRuleProposal {
	return {
		proposal_id: createComboEnrollmentRuleProposalId({
			family: snapshot.assignment.family,
			comboId: snapshot.combo?.id ?? snapshot.assignment.combo_id ?? "",
			provider,
			routeClass,
			managedModel,
		}),
		family: snapshot.assignment.family,
		combo_id: snapshot.combo?.id ?? snapshot.assignment.combo_id ?? "",
		provider,
		route_class: routeClass,
		existing_rule_id: existingRuleId,
		managed_model: managedModel,
		policy_managed_model: policyManagedModel,
		tier_source: "account_priority",
		high_confidence: false,
		selected_by_default: false,
		reason,
	};
}

export function createComboEnrollmentRuleProposalId(input: {
	family: ComboFamily;
	comboId: string;
	provider: string;
	routeClass: ComboRouteClass;
	managedModel: string;
}): string {
	return [
		"proposal",
		input.family,
		input.comboId,
		input.provider,
		input.routeClass,
		input.managedModel,
	].join(":");
}

export function resolveComboProposalPolicyModel(
	snapshot: ComboRoutingPolicySnapshot,
	reviewedOverride?: string,
): string {
	for (const candidate of [
		reviewedOverride,
		snapshot.assignment.managed_model ?? undefined,
	]) {
		if (!candidate) continue;
		const resolved = resolveFamilyAliasModel(
			candidate,
			snapshot.assignment.family,
		);
		if (getModelFamily(resolved) !== snapshot.assignment.family) continue;
		return isFamilyAliasModel(candidate, snapshot.assignment.family)
			? snapshot.assignment.family
			: candidate;
	}
	return snapshot.assignment.family;
}

export function resolveComboProposalManagedModel(
	snapshot: ComboRoutingPolicySnapshot,
	reviewedOverride?: string,
): string {
	return resolveFamilyAliasModel(
		resolveComboProposalPolicyModel(snapshot, reviewedOverride),
		snapshot.assignment.family,
	);
}

export function proposeComboEnrollmentRules(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	draftAccount: Account,
	deps: ComboResolverDependencies,
	options: { managedModel?: string } = {},
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
	const managedModel = resolveComboProposalManagedModel(
		snapshot,
		options.managedModel,
	);
	const policyManagedModel = resolveComboProposalPolicyModel(
		snapshot,
		options.managedModel,
	);
	const base = (
		reason: ComboMembershipReasonCode,
		existingRuleId: string | null = null,
	) =>
		blockedProposal(
			snapshot,
			draftAccount.provider,
			routeClass,
			managedModel,
			policyManagedModel,
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
	if (matchingRules.length > 1) return [base("ambiguous")];
	const peerAccounts = new Map(
		accounts.map((current) => [current.id, current]),
	);
	if (matchingRules.length === 1) {
		const [matchingRule] = matchingRules;
		if (!matchingRule.enabled) {
			return [base("disabled", matchingRule.id)];
		}
		if (
			snapshot.exclusions.some(
				(exclusion) =>
					exclusion.combo_id === snapshot.combo?.id &&
					exclusion.family === snapshot.assignment.family &&
					exclusion.account_id === draftAccount.id,
			)
		) {
			return [base("excluded", matchingRule.id)];
		}
		const capability = deps.resolveCapability(draftAccount, managedModel);
		if (capability.status !== "supported") {
			return [base(capability.reason, matchingRule.id)];
		}
		return [
			{
				...base("included", matchingRule.id),
				high_confidence: true,
				selected_by_default: true,
			},
		];
	}
	const peerSlots = snapshot.slots.filter(
		(slot) =>
			slot.enabled &&
			peerAccounts.get(slot.account_id)?.provider === draftAccount.provider,
	);
	if (peerSlots.length === 0) {
		return [
			base(
				snapshot.slots.some((slot) => slot.enabled)
					? "new_billing_class"
					: "ambiguous",
			),
		];
	}
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

	const peerRoutes = new Set<string>();
	for (const slot of peerSlots) {
		const peer = peerAccounts.get(slot.account_id);
		if (
			!peer ||
			getModelFamily(slot.model) !== snapshot.assignment.family ||
			slot.priority !== peer.priority
		) {
			return [base("ambiguous")];
		}
		const peerRouteClass = deps.deriveRouteClass(peer);
		if (!peerRouteClass) return [base("ambiguous")];
		peerRoutes.add(`${peer.provider}\u0000${peerRouteClass}`);
		const peerCapability = deps.resolveCapability(peer, managedModel);
		if (peerCapability.status !== "supported") {
			return [base(peerCapability.reason)];
		}
	}
	if (peerRoutes.size !== 1) return [base("ambiguous")];
	if (!peerRoutes.has(`${draftAccount.provider}\u0000${routeClass}`)) {
		return [base("new_billing_class")];
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

/**
 * Derive family-conversion proposals exclusively from persisted policy and
 * explicit peers. Unlike account onboarding, an already-enabled rule remains
 * visible so a family rolled back to manual mode can be reviewed and converted
 * again without creating a duplicate rule.
 */
export function proposeComboFamilyConversionRules(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	deps: ComboResolverDependencies,
	options: { managedModel?: string } = {},
): ComboEnrollmentRuleProposal[] {
	if (
		!snapshot.assignment.enabled ||
		!snapshot.combo?.enabled ||
		!snapshot.assignment.combo_id ||
		snapshot.combo.id !== snapshot.assignment.combo_id
	) {
		return [];
	}

	const managedModel = resolveComboProposalManagedModel(
		snapshot,
		options.managedModel,
	);
	const policyManagedModel = resolveComboProposalPolicyModel(
		snapshot,
		options.managedModel,
	);
	const proposals = new Map<string, ComboEnrollmentRuleProposal>();
	const accountById = new Map(accounts.map((current) => [current.id, current]));
	const currentRules = snapshot.rules
		.filter(
			(rule) =>
				rule.family === snapshot.assignment.family &&
				rule.combo_id === snapshot.assignment.combo_id,
		)
		.sort((left, right) => left.id.localeCompare(right.id));
	const rulesByProposalId = new Map<string, (typeof currentRules)[number][]>();
	for (const rule of currentRules) {
		const proposalId = createComboEnrollmentRuleProposalId({
			family: snapshot.assignment.family,
			comboId: snapshot.assignment.combo_id,
			provider: rule.provider,
			routeClass: rule.route_class,
			managedModel,
		});
		const matching = rulesByProposalId.get(proposalId) ?? [];
		matching.push(rule);
		rulesByProposalId.set(proposalId, matching);
	}

	const slotsByProvider = new Map<string, typeof snapshot.slots>();
	for (const slot of snapshot.slots
		.filter((current) => current.enabled)
		.sort((left, right) => left.id.localeCompare(right.id))) {
		const peer = accountById.get(slot.account_id);
		if (!peer) continue;
		const cohort = slotsByProvider.get(peer.provider) ?? [];
		cohort.push(slot);
		slotsByProvider.set(peer.provider, cohort);
	}

	for (const [provider, cohortSlots] of [...slotsByProvider.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		const peerAccountIds = [
			...new Set(cohortSlots.map((slot) => slot.account_id)),
		].sort();
		const cohortSnapshot: ComboRoutingPolicySnapshot = {
			...snapshot,
			slots: cohortSlots,
			// Stored rules are merged after peer evidence is evaluated so an
			// enabled rule cannot hide a conflicting explicit cohort.
			rules: [],
		};
		for (const accountId of peerAccountIds) {
			const peer = accountById.get(accountId);
			if (!peer || peer.provider !== provider) continue;
			for (const inferred of proposeComboEnrollmentRules(
				cohortSnapshot,
				accounts,
				peer,
				deps,
				{ managedModel },
			)) {
				let proposal = inferred;
				if (peerAccountIds.length < 2 && proposal.high_confidence) {
					proposal = {
						...proposal,
						high_confidence: false,
						selected_by_default: false,
						reason: "ambiguous",
					};
				}
				const matchingRules = rulesByProposalId.get(proposal.proposal_id) ?? [];
				if (matchingRules.length > 0) {
					const [rule] = matchingRules;
					proposal = {
						...proposal,
						existing_rule_id: rule.id,
						...(matchingRules.length > 1
							? {
									high_confidence: false,
									selected_by_default: false,
									reason: "ambiguous" as const,
								}
							: !rule.enabled && proposal.high_confidence
								? {
										high_confidence: false,
										selected_by_default: false,
										reason: "disabled" as const,
									}
								: {}),
					};
				}
				if (!proposals.has(proposal.proposal_id)) {
					proposals.set(proposal.proposal_id, proposal);
				}
			}
		}
	}

	for (const rule of currentRules) {
		const proposalId = createComboEnrollmentRuleProposalId({
			family: snapshot.assignment.family,
			comboId: snapshot.assignment.combo_id,
			provider: rule.provider,
			routeClass: rule.route_class,
			managedModel,
		});
		if (proposals.has(proposalId)) continue;
		const hasPeerEvidence = slotsByProvider.has(rule.provider);
		const highConfidence = rule.enabled && !hasPeerEvidence;
		proposals.set(proposalId, {
			...blockedProposal(
				snapshot,
				rule.provider,
				rule.route_class,
				managedModel,
				policyManagedModel,
				hasPeerEvidence ? "ambiguous" : rule.enabled ? "included" : "disabled",
				rule.id,
			),
			high_confidence: highConfidence,
			selected_by_default: highConfidence,
		});
	}

	return [...proposals.values()].sort((left, right) =>
		left.proposal_id.localeCompare(right.proposal_id),
	);
}
