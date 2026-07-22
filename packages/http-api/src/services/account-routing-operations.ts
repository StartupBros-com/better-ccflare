import { createHash } from "node:crypto";
import type { ComboResolverDependencies } from "@better-ccflare/core/managed-routing";
import {
	proposeComboEnrollmentRules,
	proposeComboFamilyConversionRules,
	resolveComboProposalManagedModel,
	resolveEffectiveComboMembership,
} from "@better-ccflare/core/managed-routing";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	Conflict,
	NotFound,
	UnprocessableEntity,
} from "@better-ccflare/errors";
import {
	createComboRouteClassDraftProbe,
	deriveComboRouteClass,
	resolveAccountLogicalModelCapability,
} from "@better-ccflare/providers/request-capabilities";
import { usageCache } from "@better-ccflare/providers/usage-cache";
import { evaluateHardCapacity } from "@better-ccflare/proxy/usage-throttling";
import type {
	Account,
	AccountRoutingEffectiveView,
	ComboEnrollmentRuleProposal,
	ComboFamily,
	ComboFamilyPolicyChanges,
	ComboMembershipResolution,
	ComboRouteClass,
	ComboRoutingAccountDraft,
	ComboRoutingAvailabilitySummary,
	ComboRoutingMemberDelta,
	ComboRoutingPolicySnapshot,
	ComboRoutingPreviewMemberState,
	ComboRoutingPreviewResult,
	ComboRoutingPreviewScope,
	ComboRoutingPreviewSubject,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { isComboSlotPriority } from "@better-ccflare/types";
import { createPersistedAccountRoutingFinalizer } from "./account-routing-finalization";

const VALID_ROUTE_CLASSES: readonly ComboRouteClass[] = [
	"oauth-subscription",
	"api-key",
	"local",
	"cloud-credential",
];
const PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID = "routing-preview-draft";
const PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID = "preview:draft";
const ROUTING_PREVIEW_COHERENCE_ATTEMPTS = 3;

export interface ManagedRoutingDependencies extends ComboResolverDependencies {
	isLogicalModelExhausted?: (
		account: Account,
		logicalModel: string,
		now: number,
	) => boolean;
}

function isLogicalModelExhausted(
	account: Account,
	logicalModel: string,
	now: number,
): boolean {
	if (
		usageCache.getModelScopedExhaustion(account.id, logicalModel, null, now) !==
			null ||
		usageCache.getFamilyScopedExhaustion(account.id, logicalModel, now) !== null
	) {
		return true;
	}

	const snapshot = usageCache.getSnapshot(account.id);
	if (snapshot === null) return false;
	return !evaluateHardCapacity(snapshot.data, {
		requestModel: logicalModel,
		observedAt: snapshot.observedAt,
		provider: account.provider,
		now,
	}).eligible;
}

export const defaultManagedRoutingDependencies: ManagedRoutingDependencies = {
	deriveRouteClass: deriveComboRouteClass,
	resolveCapability: resolveAccountLogicalModelCapability,
	isLogicalModelExhausted,
};

function availabilityFor(
	account: Account,
	logicalModel: string | null,
	dependencies: ManagedRoutingDependencies,
	now: number,
): ComboRoutingAvailabilitySummary {
	if (account.requires_reauth) {
		return { available: false, reason: "requires_reauth" };
	}
	if (account.paused) return { available: false, reason: "paused" };
	if (
		logicalModel !== null &&
		(dependencies.isLogicalModelExhausted ?? isLogicalModelExhausted)(
			account,
			logicalModel,
			now,
		)
	) {
		return { available: false, reason: "model_exhausted" };
	}
	if (account.rate_limited_until !== null && account.rate_limited_until > now) {
		return { available: false, reason: "rate_limited" };
	}
	return { available: true, reason: "available" };
}

export function toEffectiveRoutingView(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	resolution: ComboMembershipResolution,
	dependencies: ManagedRoutingDependencies,
): EffectiveComboRoutingView {
	const accountsById = new Map(
		accounts.map((account) => [account.id, account]),
	);
	const now = Date.now();
	const decorate = <
		T extends { account_id: string; logical_model: string | null },
	>(
		item: T,
	) => {
		const account = accountsById.get(item.account_id);
		return {
			...item,
			account_name: account?.name ?? item.account_id,
			availability: account
				? availabilityFor(account, item.logical_model, dependencies, now)
				: { available: false, reason: "requires_reauth" as const },
			identity_provisional: false,
		};
	};
	return {
		family: snapshot.assignment.family,
		policy: snapshot,
		resolution: {
			...resolution,
			members: resolution.members.map(decorate),
			decisions: resolution.decisions.map(decorate),
		},
	};
}

export async function readEffectiveRouting(
	dbOps: DatabaseOperations,
	family: ComboFamily,
	dependencies: ManagedRoutingDependencies,
	preloadedAccounts?: readonly Account[],
): Promise<EffectiveComboRoutingView> {
	const snapshot = await dbOps.getComboRoutingPolicy(family);
	const accounts = preloadedAccounts ?? (await dbOps.getAllAccounts());
	const resolution = resolveEffectiveComboMembership(
		snapshot,
		accounts,
		dependencies,
	);
	return toEffectiveRoutingView(snapshot, accounts, resolution, dependencies);
}

function validateModelMappings(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw BadRequest("model_mappings must be an object when provided");
	}
	const sanitized: Record<string, string | string[]> = {};
	for (const [key, mapping] of Object.entries(value)) {
		if (!key.trim()) throw BadRequest("model_mappings keys must be non-empty");
		if (typeof mapping === "string" && mapping.trim()) {
			sanitized[key] = mapping.trim();
			continue;
		}
		if (
			Array.isArray(mapping) &&
			mapping.length > 0 &&
			mapping.every((item) => typeof item === "string" && item.trim())
		) {
			sanitized[key] = mapping.map((item) => item.trim());
			continue;
		}
		throw BadRequest(
			"model_mappings values must be non-empty strings or arrays",
		);
	}
	return JSON.stringify(sanitized);
}

function draftToAccount(draft: ComboRoutingAccountDraft): Account {
	if (!draft.provider || typeof draft.provider !== "string") {
		throw BadRequest("draft.provider is required");
	}
	if (!isComboSlotPriority(draft.priority)) {
		throw BadRequest("draft.priority must be an integer between 0 and 100");
	}
	if (!VALID_ROUTE_CLASSES.includes(draft.auth_shape)) {
		throw BadRequest("draft.auth_shape is unknown");
	}
	if (
		draft.billing_type !== undefined &&
		draft.billing_type !== null &&
		draft.billing_type !== "plan" &&
		draft.billing_type !== "api"
	) {
		throw BadRequest("draft.billing_type must be plan, api, or null");
	}
	const billingType =
		draft.billing_type ??
		(draft.auth_shape === "oauth-subscription"
			? "plan"
			: draft.auth_shape === "api-key"
				? "api"
				: null);
	const routeProbe = createComboRouteClassDraftProbe({
		provider: draft.provider,
		routeClass: draft.auth_shape,
		billingType,
	});
	if (!routeProbe) {
		throw BadRequest("draft auth shape is incompatible with the provider");
	}
	const account: Account = {
		id: PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID,
		name: "Routing preview draft",
		provider: draft.provider,
		api_key: routeProbe.api_key,
		refresh_token: routeProbe.refresh_token,
		access_token: routeProbe.access_token,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: draft.priority,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: validateModelMappings(draft.model_mappings),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: routeProbe.billing_type,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
	if (deriveComboRouteClass(account) !== draft.auth_shape) {
		throw BadRequest("draft auth shape is incompatible with the provider");
	}
	return account;
}

export interface CoherentRoutingInputs {
	revision: number;
	families: ComboFamily[];
	accounts: readonly Account[];
	snapshots: Map<ComboFamily, ComboRoutingPolicySnapshot>;
}

export async function readCoherentRoutingInputs(
	dbOps: DatabaseOperations,
	requestedFamilies?: readonly ComboFamily[],
): Promise<CoherentRoutingInputs> {
	for (
		let attempt = 0;
		attempt < ROUTING_PREVIEW_COHERENCE_ATTEMPTS;
		attempt++
	) {
		const before = await dbOps.getRoutingPolicyRevision();
		const families = requestedFamilies
			? [...new Set(requestedFamilies)].sort()
			: (await dbOps.getFamilyAssignments())
					.map((assignment) => assignment.family)
					.sort();
		const [accounts, ...snapshots] = await Promise.all([
			dbOps.getAllAccounts(),
			...families.map((family) => dbOps.getComboRoutingPolicy(family)),
		]);
		const after = await dbOps.getRoutingPolicyRevision();
		if (before === after) {
			return {
				revision: after,
				families,
				accounts,
				snapshots: new Map(
					families.map((family, index) => [family, snapshots[index]]),
				),
			};
		}
	}
	throw Conflict("Routing policy changed while building the preview; retry", {
		code: "stale_routing_preview",
	});
}

export function coherentSnapshot(
	inputs: CoherentRoutingInputs,
	family: ComboFamily,
): ComboRoutingPolicySnapshot {
	const snapshot = inputs.snapshots.get(family);
	if (!snapshot)
		throw new Error(`Missing coherent routing snapshot: ${family}`);
	return snapshot;
}

function isPersistedPreviewSubject(
	subject: ComboRoutingPreviewSubject,
): subject is { account_id: string; draft?: never } {
	return typeof subject.account_id === "string";
}

export function resolvePreviewSubject(
	subject: ComboRoutingPreviewSubject,
	accounts: readonly Account[],
): Account {
	if (isPersistedPreviewSubject(subject)) {
		const found = accounts.find((account) => account.id === subject.account_id);
		if (!found) throw NotFound("Preview account not found");
		return found;
	}
	return draftToAccount(subject.draft);
}

function createReviewedRuleId(proposal: ComboEnrollmentRuleProposal): string {
	return `managed-rule:${createHash("sha256")
		.update(proposal.proposal_id)
		.digest("hex")}`;
}

function hypotheticalSnapshot(
	snapshot: ComboRoutingPolicySnapshot,
	proposal: ComboEnrollmentRuleProposal,
): ComboRoutingPolicySnapshot {
	const rules = snapshot.rules.map((rule) =>
		rule.id === proposal.existing_rule_id ? { ...rule, enabled: true } : rule,
	);
	if (!proposal.existing_rule_id) {
		rules.push({
			id: createReviewedRuleId(proposal),
			family: proposal.family,
			combo_id: proposal.combo_id,
			provider: proposal.provider,
			route_class: proposal.route_class,
			enabled: true,
			created_at: 0,
			updated_at: 0,
		});
	}
	return {
		...snapshot,
		assignment: {
			...snapshot.assignment,
			membership_mode: "managed",
			managed_model: proposal.managed_model,
		},
		rules,
	};
}

function createPreviewId(value: unknown): string {
	return `preview:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function publicProposalView(
	view: EffectiveComboRoutingView,
	hasDraftSubject: boolean,
): EffectiveComboRoutingView {
	if (!hasDraftSubject) return view;
	return {
		...view,
		resolution: {
			...view.resolution,
			members: view.resolution.members.map((member) =>
				member.account_id === PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID
					? {
							...member,
							id: null,
							account_id: PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID,
							account_name: "Draft account",
							identity_provisional: true,
						}
					: member,
			),
			decisions: view.resolution.decisions.map((decision) =>
				decision.account_id === PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID
					? {
							...decision,
							account_id: PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID,
							account_name: "Draft account",
							identity_provisional: true,
						}
					: decision,
			),
		},
	};
}

function previewMemberState(
	member: EffectiveComboRoutingView["resolution"]["members"][number],
): ComboRoutingPreviewMemberState {
	const ownership = {
		subject: member.identity_provisional ? "draft" : "persisted",
		account_id: member.identity_provisional ? null : member.account_id,
		candidate_id: member.identity_provisional ? null : member.id,
		source: member.source,
	};
	const key = `member:${createHash("sha256")
		.update(JSON.stringify(ownership))
		.digest("hex")}`;
	return {
		key,
		account_id: ownership.account_id,
		candidate_id: ownership.candidate_id,
		identity_provisional: member.identity_provisional,
		source: member.source,
		tier: member.tier,
		logical_model: member.logical_model,
		reason: member.reason,
	};
}

function samePreviewMemberState(
	left: ComboRoutingPreviewMemberState,
	right: ComboRoutingPreviewMemberState,
): boolean {
	return (
		left.account_id === right.account_id &&
		left.candidate_id === right.candidate_id &&
		left.identity_provisional === right.identity_provisional &&
		left.source === right.source &&
		left.tier === right.tier &&
		left.logical_model === right.logical_model &&
		left.reason === right.reason
	);
}

function memberDelta(
	before: EffectiveComboRoutingView,
	after: EffectiveComboRoutingView,
): ComboRoutingMemberDelta[] {
	const beforeByKey = new Map(
		before.resolution.members
			.map(previewMemberState)
			.map((member) => [member.key, member]),
	);
	const afterByKey = new Map(
		after.resolution.members
			.map(previewMemberState)
			.map((member) => [member.key, member]),
	);
	return [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
		.sort()
		.map((key) => {
			const previous = beforeByKey.get(key) ?? null;
			const next = afterByKey.get(key) ?? null;
			return {
				key,
				status:
					previous === null
						? "added"
						: next === null
							? "removed"
							: samePreviewMemberState(previous, next)
								? "unchanged"
								: "changed",
				before: previous,
				after: next,
			};
		});
}

export type RoutingPreviewInput =
	| { scope: "account"; subject: ComboRoutingPreviewSubject }
	| { scope: "family" };

export function computeRoutingPreview(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	revision: number,
	family: ComboFamily,
	input: RoutingPreviewInput,
	dependencies: ManagedRoutingDependencies,
	options: {
		managedModel?: string;
		draftAccount?: Account;
	} = {},
): ComboRoutingPreviewResult {
	const managedModel = resolveComboProposalManagedModel(
		snapshot,
		options.managedModel,
	);
	const previewAccount =
		input.scope === "account"
			? (options.draftAccount ?? resolvePreviewSubject(input.subject, accounts))
			: null;
	const baseProposals =
		input.scope === "account"
			? proposeComboEnrollmentRules(
					snapshot,
					accounts,
					previewAccount as Account,
					dependencies,
					{ managedModel },
				)
			: proposeComboFamilyConversionRules(snapshot, accounts, dependencies, {
					managedModel,
				});
	const currentResolution = resolveEffectiveComboMembership(
		snapshot,
		accounts,
		dependencies,
	);
	const effective = toEffectiveRoutingView(
		snapshot,
		accounts,
		currentResolution,
		dependencies,
	);
	const hasDraftSubject =
		input.scope === "account" && !isPersistedPreviewSubject(input.subject);
	const proposedAccounts =
		hasDraftSubject && previewAccount !== null
			? [...accounts, previewAccount]
			: accounts;
	const proposed = baseProposals.map((proposal) => {
		const proposedSnapshot = hypotheticalSnapshot(snapshot, proposal);
		const resolution = resolveEffectiveComboMembership(
			proposedSnapshot,
			proposedAccounts,
			dependencies,
		);
		const proposedEffective = publicProposalView(
			toEffectiveRoutingView(
				proposedSnapshot,
				proposedAccounts,
				resolution,
				dependencies,
			),
			hasDraftSubject,
		);
		return {
			proposal: {
				...proposal,
				proposed_effective: proposedEffective,
				member_delta: memberDelta(effective, proposedEffective),
			},
			resolution,
		};
	});
	const safeSubject =
		input.scope === "family"
			? null
			: isPersistedPreviewSubject(input.subject)
				? { account_id: input.subject.account_id }
				: {
						draft: {
							provider: input.subject.draft.provider,
							priority: input.subject.draft.priority,
							auth_shape: input.subject.draft.auth_shape,
							billing_type: input.subject.draft.billing_type ?? null,
						},
					};
	const previewId = createPreviewId({
		revision,
		scope: input.scope,
		family,
		managed_model: managedModel,
		subject: safeSubject,
		policy: snapshot,
		proposals: baseProposals,
		current: currentResolution,
		proposed: proposed.map((entry) => entry.resolution),
	});
	return {
		preview_id: previewId,
		scope: input.scope,
		family,
		managed_model: managedModel,
		proposals: proposed.map((entry) => entry.proposal),
		effective,
	};
}

export function omitAccountNames(
	view: EffectiveComboRoutingView,
): AccountRoutingEffectiveView {
	return {
		...view,
		resolution: {
			...view.resolution,
			members: view.resolution.members.map(
				({ account_name: _accountName, ...member }) => member,
			),
			decisions: view.resolution.decisions.map(
				({ account_name: _accountName, ...decision }) => decision,
			),
		},
	};
}

export async function previewAccountRoutingForFamily(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies,
	params: {
		family: ComboFamily;
		subject: ComboRoutingPreviewSubject;
		managedModel?: string;
	},
): Promise<ComboRoutingPreviewResult> {
	const inputs = await readCoherentRoutingInputs(dbOps, [params.family]);
	return computeRoutingPreview(
		coherentSnapshot(inputs, params.family),
		inputs.accounts,
		inputs.revision,
		params.family,
		{ scope: "account", subject: params.subject },
		dependencies,
		{ managedModel: params.managedModel },
	);
}

export interface RoutingApplyCommand {
	family: ComboFamily;
	previewId: string;
	proposalId: string;
	managedModel: string;
	scope: ComboRoutingPreviewScope;
	subject?: ComboRoutingPreviewSubject;
}

export async function applyRoutingProposal(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies,
	command: RoutingApplyCommand,
): Promise<EffectiveComboRoutingView> {
	const inputs = await readCoherentRoutingInputs(dbOps, [command.family]);
	const accounts = inputs.accounts;
	const policySnapshot = coherentSnapshot(inputs, command.family);
	let current: ComboRoutingPreviewResult;
	if (command.scope === "family") {
		if (command.subject !== undefined) {
			throw BadRequest(
				"family-scoped apply does not accept an account subject",
			);
		}
		current = computeRoutingPreview(
			policySnapshot,
			accounts,
			inputs.revision,
			command.family,
			{ scope: "family" },
			dependencies,
			{ managedModel: command.managedModel },
		);
	} else {
		if (!command.subject) throw BadRequest("subject is required");
		if (!isPersistedPreviewSubject(command.subject)) {
			throw BadRequest(
				"Draft routing previews cannot be applied; create the account first",
			);
		}
		const persistedAccount = resolvePreviewSubject(command.subject, accounts);
		current = computeRoutingPreview(
			policySnapshot,
			accounts,
			inputs.revision,
			command.family,
			{ scope: "account", subject: command.subject },
			dependencies,
			{
				managedModel: command.managedModel,
				draftAccount: persistedAccount,
			},
		);
	}
	if (current.preview_id !== command.previewId) {
		throw Conflict("Routing preview is stale; review the current proposal", {
			code: "stale_routing_preview",
			preview_id: current.preview_id,
		});
	}
	const proposal = current.proposals.find(
		(candidate) => candidate.proposal_id === command.proposalId,
	);
	if (!proposal) throw BadRequest("proposal_id is not in this preview");

	const snapshot = current.effective.policy;
	const proposedSnapshot = hypotheticalSnapshot(snapshot, proposal);
	const proposedResolution = resolveEffectiveComboMembership(
		proposedSnapshot,
		accounts,
		dependencies,
	);
	if (proposedResolution.members.length === 0) {
		throw UnprocessableEntity(
			"Managed mode requires at least one effective candidate",
			{ code: "managed_route_empty" },
		);
	}
	const existingRule = proposal.existing_rule_id
		? snapshot.rules.find((rule) => rule.id === proposal.existing_rule_id)
		: null;
	if (
		snapshot.assignment.membership_mode === "managed" &&
		snapshot.assignment.managed_model === proposal.managed_model &&
		existingRule?.enabled === true
	) {
		if ((await dbOps.getRoutingPolicyRevision()) !== inputs.revision) {
			throw Conflict("Routing preview is stale; review the current proposal", {
				code: "stale_routing_preview",
			});
		}
		return current.effective;
	}

	const changes: ComboFamilyPolicyChanges = {
		family: command.family,
		expected_revision: inputs.revision,
		assignment: {
			membership_mode: "managed",
			managed_model: proposal.managed_model,
		},
		...(proposal.existing_rule_id
			? {
					update_rules: [
						{ id: proposal.existing_rule_id, fields: { enabled: true } },
					],
				}
			: {
					create_rules: [
						{
							id: createReviewedRuleId(proposal),
							combo_id: proposal.combo_id,
							provider: proposal.provider,
							route_class: proposal.route_class,
							enabled: true,
						},
					],
				}),
	};
	try {
		await dbOps.applyFamilyPolicyChanges(changes);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: unknown }).code === "stale_routing_preview"
		) {
			throw Conflict("Routing preview is stale; review the current proposal", {
				code: "stale_routing_preview",
			});
		}
		throw error;
	}
	return readEffectiveRouting(dbOps, command.family, dependencies);
}

/** Non-HTTP finalizer used by durable account-setup workers after account commit. */
export function createServerOwnedAccountRoutingFinalizer(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
) {
	return createPersistedAccountRoutingFinalizer({
		preview: ({ accountId, family }) =>
			previewAccountRoutingForFamily(dbOps, dependencies, {
				family,
				subject: { account_id: accountId },
			}),
		apply: ({ accountId, family, previewId, proposalId, managedModel }) =>
			applyRoutingProposal(dbOps, dependencies, {
				family,
				previewId,
				proposalId,
				managedModel,
				scope: "account",
				subject: { account_id: accountId },
			}),
	});
}
