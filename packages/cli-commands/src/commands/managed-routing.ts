import type {
	AccountResponse,
	AccountRoutingEffectiveView,
	AccountRoutingOverview,
	ComboFamily,
	ComboFamilyAssignment,
	ComboMembershipDecisionView,
	ComboRoutingMemberDelta,
	ComboRoutingPreviewMemberState,
	ComboRoutingPreviewResult,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import type { PromptAdapter } from "../prompts/adapter";
import type { ManagedRoutingControlPlane } from "./managed-routing-client";

export type ManagedRoutingOutputFormat = "text" | "json";

export class ManagedRoutingSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedRoutingSafetyError";
	}
}

export interface ManagedRoutingAvailabilityProjection {
	available: boolean;
	reason: string;
}

export interface ManagedRoutingMemberProjection {
	id: string | null;
	account_id: string;
	account_name?: string;
	combo_id: string;
	family: ComboFamily;
	included: true;
	logical_model: string;
	tier: number;
	source: "manual" | "managed";
	reason: string;
	slot_id: string | null;
	rule_id: string | null;
	availability: ManagedRoutingAvailabilityProjection;
	identity_provisional: boolean;
}

export interface ManagedRoutingDecisionProjection {
	account_id: string;
	account_name?: string;
	combo_id: string;
	family: ComboFamily;
	included: boolean;
	logical_model: string | null;
	tier: number | null;
	source: "manual" | "managed" | null;
	reason: string;
	slot_id: string | null;
	rule_id: string | null;
	availability: ManagedRoutingAvailabilityProjection;
	identity_provisional: boolean;
}

export interface ManagedRoutingEffectiveProjection {
	family: ComboFamily;
	assignment: {
		family: ComboFamily;
		combo_id: string | null;
		enabled: boolean;
		membership_mode: "manual" | "managed";
		managed_model: string | null;
	};
	combo: { id: string; name: string; enabled: boolean } | null;
	manual_slots: Array<{
		id: string;
		account_id: string;
		model: string;
		tier: number;
		enabled: boolean;
	}>;
	rules: Array<{
		id: string;
		provider: string;
		route_class: string;
		enabled: boolean;
	}>;
	exclusions: Array<{ id: string; account_id: string }>;
	active: boolean;
	resolution_reason: string | null;
	members: ManagedRoutingMemberProjection[];
	decisions: ManagedRoutingDecisionProjection[];
}

export interface ManagedRoutingOpportunityProjection {
	account_id: string;
	family: ComboFamily;
	proposal_id: string;
	combo_id: string;
	managed_model: string;
	tier_source: "account_priority";
	reason: string;
}

export interface ManagedRoutingAccountProjection {
	account_id: string;
	name: string;
	provider: string;
	priority: number;
	paused: boolean;
	requires_reauth: boolean;
	token_status: "valid" | "expired";
	rate_limit_status: string;
	memberships: ManagedRoutingMemberProjection[];
	decisions: ManagedRoutingDecisionProjection[];
	opportunities: ManagedRoutingOpportunityProjection[];
}

export interface ManagedRoutingPreviewStateProjection {
	key: string;
	account_id: string | null;
	candidate_id: string | null;
	identity_provisional: boolean;
	source: "manual" | "managed";
	tier: number;
	logical_model: string;
	reason: string;
}

export interface ManagedRoutingMemberDeltaProjection {
	key: string;
	status: "added" | "removed" | "changed" | "unchanged";
	before: ManagedRoutingPreviewStateProjection | null;
	after: ManagedRoutingPreviewStateProjection | null;
}

export interface ManagedRoutingProposalProjection {
	proposal_id: string;
	family: ComboFamily;
	combo_id: string;
	provider: string;
	route_class: string;
	existing_rule_id: string | null;
	managed_model: string;
	tier_source: "account_priority";
	high_confidence: boolean;
	selected_by_default: boolean;
	reason: string;
	proposed_effective: ManagedRoutingEffectiveProjection;
	member_delta: ManagedRoutingMemberDeltaProjection[];
}

export interface ManagedRoutingPreviewProjection {
	preview_id: string;
	scope: "account" | "family";
	family: ComboFamily;
	managed_model: string;
	effective: ManagedRoutingEffectiveProjection;
	proposals: ManagedRoutingProposalProjection[];
}

export interface ManagedRoutingListReport {
	kind: "list";
	accounts: ManagedRoutingAccountProjection[];
}

export interface ManagedRoutingDetailReport {
	kind: "detail";
	account: ManagedRoutingAccountProjection;
}

export interface ManagedRoutingPreviewReport {
	kind: "preview";
	preview: ManagedRoutingPreviewProjection;
}

export interface ManagedAccountRoutingPreviewReport {
	kind: "account-preview";
	account_id: string;
	previews: ManagedRoutingPreviewProjection[];
}

export interface ManagedRoutingApplyReport {
	kind: "apply";
	status: "applied";
	effective: ManagedRoutingEffectiveProjection;
}

export interface ManagedRoutingDeclinedReport {
	kind: "apply" | "manual-rollback";
	status: "declined";
}

export interface ManagedAccountRoutingApplyResult {
	family: ComboFamily;
	preview_id: string;
	proposal_id: string;
	managed_model: string;
	effective: ManagedRoutingEffectiveProjection;
}

export interface ManagedAccountRoutingApplyReport {
	kind: "account-apply";
	status: "applied" | "declined" | "failed_closed" | "partial";
	account_id: string;
	results: ManagedAccountRoutingApplyResult[];
	stopped: ManagedAccountRoutingApplyStop | null;
}

export type ManagedAccountRoutingApplyStopReason =
	| "preview_failed"
	| "preview_missing"
	| "review_failed"
	| "review_declined"
	| "proposal_missing"
	| "proposal_materially_changed"
	| "confirmation_failed"
	| "confirmation_declined"
	| "apply_failed";

export interface ManagedAccountRoutingApplyStop {
	family: ComboFamily;
	reason: ManagedAccountRoutingApplyStopReason;
}

export interface ManagedRoutingManualRollbackReport {
	kind: "manual-rollback";
	status: "applied";
	assignment: ReturnType<typeof projectFamilyAssignment>;
}

export type ManagedRoutingReport =
	| ManagedRoutingListReport
	| ManagedRoutingDetailReport
	| ManagedRoutingPreviewReport
	| ManagedAccountRoutingPreviewReport
	| ManagedRoutingApplyReport
	| ManagedAccountRoutingApplyReport
	| ManagedRoutingManualRollbackReport
	| ManagedRoutingDeclinedReport;

type EffectiveView = EffectiveComboRoutingView | AccountRoutingEffectiveView;

function projectAvailability(availability: {
	available: boolean;
	reason: string;
}): ManagedRoutingAvailabilityProjection {
	return {
		available: availability.available,
		reason: availability.reason,
	};
}

function accountName(value: unknown): { account_name: string } | object {
	return typeof value === "string" ? { account_name: value } : {};
}

function projectMember(
	member: EffectiveView["resolution"]["members"][number],
): ManagedRoutingMemberProjection {
	const named = member as EffectiveComboMemberView;
	return {
		id: member.id,
		account_id: member.account_id,
		...accountName(named.account_name),
		combo_id: member.combo_id,
		family: member.family,
		included: true,
		logical_model: member.logical_model,
		tier: member.tier,
		source: member.source,
		reason: member.reason,
		slot_id: member.slot_id,
		rule_id: member.rule_id,
		availability: projectAvailability(member.availability),
		identity_provisional: member.identity_provisional,
	};
}

function projectDecision(
	decision: EffectiveView["resolution"]["decisions"][number],
): ManagedRoutingDecisionProjection {
	const named = decision as ComboMembershipDecisionView;
	return {
		account_id: decision.account_id,
		...accountName(named.account_name),
		combo_id: decision.combo_id,
		family: decision.family,
		included: decision.included,
		logical_model: decision.logical_model,
		tier: decision.tier,
		source: decision.source,
		reason: decision.reason,
		slot_id: decision.slot_id,
		rule_id: decision.rule_id,
		availability: projectAvailability(decision.availability),
		identity_provisional: decision.identity_provisional,
	};
}

export function projectFamilyAssignment(assignment: ComboFamilyAssignment) {
	return {
		family: assignment.family,
		combo_id: assignment.combo_id,
		enabled: assignment.enabled,
		membership_mode: assignment.membership_mode,
		managed_model: assignment.managed_model,
	};
}

/** Allowlist-only projection of the authoritative server resolver output. */
export function projectEffectiveRouting(
	view: EffectiveView,
): ManagedRoutingEffectiveProjection {
	return {
		family: view.family,
		assignment: projectFamilyAssignment(view.policy.assignment),
		combo:
			view.policy.combo === null
				? null
				: {
						id: view.policy.combo.id,
						name: view.policy.combo.name,
						enabled: view.policy.combo.enabled,
					},
		manual_slots: view.policy.slots.map((slot) => ({
			id: slot.id,
			account_id: slot.account_id,
			model: slot.model,
			tier: slot.priority,
			enabled: slot.enabled,
		})),
		rules: view.policy.rules.map((rule) => ({
			id: rule.id,
			provider: rule.provider,
			route_class: rule.route_class,
			enabled: rule.enabled,
		})),
		exclusions: view.policy.exclusions.map((exclusion) => ({
			id: exclusion.id,
			account_id: exclusion.account_id,
		})),
		active: view.resolution.active,
		resolution_reason: view.resolution.reason,
		members: view.resolution.members.map(projectMember),
		decisions: view.resolution.decisions.map(projectDecision),
	};
}

function projectPreviewState(
	state: ComboRoutingPreviewMemberState | null,
): ManagedRoutingPreviewStateProjection | null {
	if (state === null) return null;
	return {
		key: state.key,
		account_id: state.account_id,
		candidate_id: state.candidate_id,
		identity_provisional: state.identity_provisional,
		source: state.source,
		tier: state.tier,
		logical_model: state.logical_model,
		reason: state.reason,
	};
}

function projectMemberDelta(
	delta: ComboRoutingMemberDelta,
): ManagedRoutingMemberDeltaProjection {
	return {
		key: delta.key,
		status: delta.status,
		before: projectPreviewState(delta.before),
		after: projectPreviewState(delta.after),
	};
}

export function projectManagedRoutingPreview(
	preview: ComboRoutingPreviewResult,
): ManagedRoutingPreviewProjection {
	return {
		preview_id: preview.preview_id,
		scope: preview.scope,
		family: preview.family,
		managed_model: preview.managed_model,
		effective: projectEffectiveRouting(preview.effective),
		proposals: preview.proposals.map((proposal) => ({
			proposal_id: proposal.proposal_id,
			family: proposal.family,
			combo_id: proposal.combo_id,
			provider: proposal.provider,
			route_class: proposal.route_class,
			existing_rule_id: proposal.existing_rule_id,
			managed_model: proposal.managed_model,
			tier_source: proposal.tier_source,
			high_confidence: proposal.high_confidence,
			selected_by_default: proposal.selected_by_default,
			reason: proposal.reason,
			proposed_effective: projectEffectiveRouting(proposal.proposed_effective),
			member_delta: proposal.member_delta.map(projectMemberDelta),
		})),
	};
}

function projectOpportunity(
	opportunity: AccountRoutingOverview["opportunities"][number],
): ManagedRoutingOpportunityProjection {
	return {
		account_id: opportunity.account_id,
		family: opportunity.family,
		proposal_id: opportunity.proposal_id,
		combo_id: opportunity.combo_id,
		managed_model: opportunity.managed_model,
		tier_source: opportunity.tier_source,
		reason: opportunity.reason,
	};
}

export function projectManagedRoutingAccounts(
	accounts: AccountResponse[],
	overview: AccountRoutingOverview,
): ManagedRoutingAccountProjection[] {
	const projected = accounts.map((account) => ({
		account_id: account.id,
		name: account.name,
		provider: account.provider,
		priority: account.priority,
		paused: account.paused,
		requires_reauth: account.requiresReauth,
		token_status: account.tokenStatus,
		rate_limit_status: account.rateLimitStatus,
		memberships: [] as ManagedRoutingMemberProjection[],
		decisions: [] as ManagedRoutingDecisionProjection[],
		opportunities: [] as ManagedRoutingOpportunityProjection[],
	}));
	const byId = new Map(
		projected.map((account) => [account.account_id, account]),
	);

	for (const view of overview.effective) {
		for (const member of view.resolution.members) {
			byId.get(member.account_id)?.memberships.push(projectMember(member));
		}
		for (const decision of view.resolution.decisions) {
			byId.get(decision.account_id)?.decisions.push(projectDecision(decision));
		}
	}
	for (const opportunity of overview.opportunities) {
		byId
			.get(opportunity.account_id)
			?.opportunities.push(projectOpportunity(opportunity));
	}

	return projected;
}

async function loadManagedRoutingAccounts(
	client: ManagedRoutingControlPlane,
): Promise<ManagedRoutingAccountProjection[]> {
	const [accounts, overview] = await Promise.all([
		client.getAccounts(),
		client.getAccountRoutingOverview(),
	]);
	return projectManagedRoutingAccounts(accounts, overview);
}

export async function runManagedRoutingList(
	client: ManagedRoutingControlPlane,
): Promise<ManagedRoutingListReport> {
	return { kind: "list", accounts: await loadManagedRoutingAccounts(client) };
}

export async function runManagedRoutingDetail(
	client: ManagedRoutingControlPlane,
	accountId: string,
): Promise<ManagedRoutingDetailReport> {
	const account = (await loadManagedRoutingAccounts(client)).find(
		(candidate) => candidate.account_id === accountId,
	);
	if (!account) {
		throw new ManagedRoutingSafetyError(
			"That immutable account ID was not returned by the live server.",
		);
	}
	return { kind: "detail", account };
}

export async function runManagedRoutingPreview(
	client: ManagedRoutingControlPlane,
	input: { family: ComboFamily; managedModel?: string },
): Promise<ManagedRoutingPreviewReport> {
	const preview = await client.previewFamilyRouting(input);
	return { kind: "preview", preview: projectManagedRoutingPreview(preview) };
}

export async function runManagedAccountRoutingPreview(
	client: ManagedRoutingControlPlane,
	input: { accountId: string; family?: ComboFamily; managedModel?: string },
): Promise<ManagedAccountRoutingPreviewReport> {
	if (!input.accountId.trim()) {
		throw new ManagedRoutingSafetyError("A persisted accountId is required.");
	}
	const response = await client.previewAccountRouting(input);
	const previews = "families" in response ? response.families : [response];
	return {
		kind: "account-preview",
		account_id: input.accountId,
		previews: previews.map(projectManagedRoutingPreview),
	};
}

export interface ManagedRoutingApplyOptions {
	family: ComboFamily;
	previewId?: string;
	proposalId?: string;
	managedModel?: string;
	confirmed?: boolean;
	nonInteractive?: boolean;
	json?: boolean;
	prompt?: PromptAdapter;
	review?: ManagedRoutingPreviewReviewer;
}

export type ManagedRoutingPreviewReviewer = (
	report: ManagedRoutingPreviewReport,
) => void | Promise<void>;

function requiredText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function requireAutomatedApplyFields(
	options: ManagedRoutingApplyOptions,
): asserts options is ManagedRoutingApplyOptions & {
	previewId: string;
	proposalId: string;
	managedModel: string;
	confirmed: boolean;
} {
	if (
		!requiredText(options.previewId) ||
		!requiredText(options.proposalId) ||
		!requiredText(options.managedModel) ||
		options.confirmed === undefined
	) {
		throw new ManagedRoutingSafetyError(
			"Automated apply requires explicit previewId, proposalId, managedModel, and confirmed values.",
		);
	}
}

export async function runManagedRoutingApply(
	client: ManagedRoutingControlPlane,
	options: ManagedRoutingApplyOptions,
): Promise<ManagedRoutingApplyReport | ManagedRoutingDeclinedReport> {
	let previewId = requiredText(options.previewId);
	let proposalId = requiredText(options.proposalId);
	let managedModel = requiredText(options.managedModel);
	const hasPreviewId = previewId !== undefined;
	const hasProposalId = proposalId !== undefined;
	const hasExplicitTuple = hasPreviewId && hasProposalId && !!managedModel;
	if ((hasPreviewId || hasProposalId) && !hasExplicitTuple) {
		throw new ManagedRoutingSafetyError(
			"A partial reviewed tuple is unsafe; provide previewId, proposalId, and managedModel together.",
		);
	}

	if (options.nonInteractive || options.json) {
		requireAutomatedApplyFields(options);
		if (!options.confirmed) return { kind: "apply", status: "declined" };
		previewId = options.previewId;
		proposalId = options.proposalId;
		managedModel = options.managedModel;
	} else if (!hasExplicitTuple) {
		if (!options.prompt) {
			throw new ManagedRoutingSafetyError(
				"Interactive proposal selection requires an injected PromptAdapter.",
			);
		}
		if (!options.review) {
			throw new ManagedRoutingSafetyError(
				"A review callback is required to surface the full preview before interactive selection.",
			);
		}
		const preview = await client.previewFamilyRouting({
			family: options.family,
			...(managedModel ? { managedModel } : {}),
		});
		await options.review({
			kind: "preview",
			preview: projectManagedRoutingPreview(preview),
		});
		previewId = preview.preview_id;
		managedModel = preview.managed_model;
		if (preview.proposals.length === 0) {
			throw new ManagedRoutingSafetyError(
				"The live server returned no routing proposal to review.",
			);
		}
		proposalId = await options.prompt.select(
			`Select a reviewed ${options.family} routing proposal`,
			preview.proposals.map((proposal) => ({
				label: `${proposal.provider} ${proposal.route_class} model=${proposal.managed_model} tier=${proposal.tier_source} reason=${proposal.reason}`,
				value: proposal.proposal_id,
			})),
		);
		if (
			!preview.proposals.some((proposal) => proposal.proposal_id === proposalId)
		) {
			throw new ManagedRoutingSafetyError(
				"The selected proposal ID was not present in the live preview.",
			);
		}
	}

	if (!previewId || !proposalId || !managedModel) {
		throw new ManagedRoutingSafetyError(
			"Apply requires explicit previewId, proposalId, and managedModel values.",
		);
	}

	let confirmed = options.confirmed;
	if (confirmed === undefined) {
		if (!options.prompt) {
			throw new ManagedRoutingSafetyError(
				"Apply requires explicit confirmation or an injected PromptAdapter.",
			);
		}
		confirmed = await options.prompt.confirm(
			`Apply the reviewed ${options.family} routing proposal?`,
		);
	}
	if (!confirmed) return { kind: "apply", status: "declined" };

	const effective = await client.applyFamilyRoutingProposal({
		family: options.family,
		previewId,
		proposalId,
		managedModel,
	});
	return {
		kind: "apply",
		status: "applied",
		effective: projectEffectiveRouting(effective),
	};
}

export interface ManagedAccountRoutingReviewedSelection {
	family: ComboFamily;
	/** Provenance only: every apply uses a freshly issued preview ID. */
	previewId: string;
	proposalId: string;
	managedModel: string;
	reviewedProposal: ManagedRoutingProposalProjection;
}

export interface ManagedAccountRoutingApplyOptions {
	accountId: string;
	selections?: readonly ManagedAccountRoutingReviewedSelection[];
	nonInteractive?: boolean;
	json?: boolean;
	prompt?: PromptAdapter;
	review?: ManagedAccountRoutingPreviewReviewer;
}

export type ManagedAccountRoutingPreviewReviewer = (
	report: ManagedAccountRoutingPreviewReport,
) => boolean | void | Promise<boolean> | Promise<void>;

export function createManagedAccountRoutingReviewedSelection(
	preview: ManagedRoutingPreviewProjection,
	proposalId: string,
): ManagedAccountRoutingReviewedSelection {
	const proposal = preview.proposals.find(
		(candidate) => candidate.proposal_id === proposalId,
	);
	if (!proposal) {
		throw new ManagedRoutingSafetyError(
			"The selected proposal was not present in the reviewed live preview.",
		);
	}
	return {
		family: preview.family,
		previewId: preview.preview_id,
		proposalId: proposal.proposal_id,
		managedModel: proposal.managed_model,
		reviewedProposal: proposal,
	};
}

function validateAccountSelections(
	selections: readonly ManagedAccountRoutingReviewedSelection[] | undefined,
): readonly ManagedAccountRoutingReviewedSelection[] {
	if (!selections?.length) {
		throw new ManagedRoutingSafetyError(
			"At least one explicit reviewed account routing selection is required.",
		);
	}
	const families = new Set<ComboFamily>();
	for (const selection of selections) {
		if (
			!requiredText(selection.previewId) ||
			!requiredText(selection.proposalId) ||
			!requiredText(selection.managedModel) ||
			!selection.reviewedProposal
		) {
			throw new ManagedRoutingSafetyError(
				"Every reviewed account selection requires previewId, proposalId, managedModel, and reviewedProposal.",
			);
		}
		if (
			selection.reviewedProposal.proposal_id !== selection.proposalId ||
			selection.reviewedProposal.family !== selection.family ||
			selection.reviewedProposal.managed_model !== selection.managedModel
		) {
			throw new ManagedRoutingSafetyError(
				"The reviewed account proposal does not match its explicit family, proposalId, and managedModel selection.",
			);
		}
		if (families.has(selection.family)) {
			throw new ManagedRoutingSafetyError(
				"Only one reviewed account routing selection is allowed per family.",
			);
		}
		families.add(selection.family);
	}
	return selections;
}

function proposalReviewMaterial(
	proposal: ManagedRoutingProposalProjection,
): string {
	return JSON.stringify({
		proposal_id: proposal.proposal_id,
		family: proposal.family,
		combo_id: proposal.combo_id,
		provider: proposal.provider,
		route_class: proposal.route_class,
		existing_rule_id: proposal.existing_rule_id,
		managed_model: proposal.managed_model,
		tier_source: proposal.tier_source,
		high_confidence: proposal.high_confidence,
		reason: proposal.reason,
		member_delta: proposal.member_delta,
	});
}

function accountApplyStopped(
	accountId: string,
	results: ManagedAccountRoutingApplyResult[],
	family: ComboFamily,
	reason: ManagedAccountRoutingApplyStopReason,
): ManagedAccountRoutingApplyReport {
	return {
		kind: "account-apply",
		status:
			results.length > 0
				? "partial"
				: reason === "review_declined" || reason === "confirmation_declined"
					? "declined"
					: "failed_closed",
		account_id: accountId,
		results,
		stopped: { family, reason },
	};
}

function accountFamilyPreview(
	response:
		| ComboRoutingPreviewResult
		| { families: ComboRoutingPreviewResult[] },
	family: ComboFamily,
): ComboRoutingPreviewResult | undefined {
	return "families" in response
		? response.families.find((preview) => preview.family === family)
		: response.family === family
			? response
			: undefined;
}

/**
 * Apply persisted-account selections in review order. Every family gets a new
 * preview/review/confirmation/write cycle because each write advances the one
 * global routing revision and invalidates every older preview.
 */
export async function runManagedAccountRoutingApply(
	client: ManagedRoutingControlPlane,
	options: ManagedAccountRoutingApplyOptions,
): Promise<ManagedAccountRoutingApplyReport> {
	if (options.nonInteractive || options.json) {
		throw new ManagedRoutingSafetyError(
			"Interactive review is required for account-scoped routing apply.",
		);
	}
	if (!options.accountId.trim()) {
		throw new ManagedRoutingSafetyError("A persisted accountId is required.");
	}
	const selections = validateAccountSelections(options.selections);
	if (!options.prompt || !options.review) {
		throw new ManagedRoutingSafetyError(
			"Account-scoped apply requires injected prompt and review callbacks.",
		);
	}

	const results: ManagedAccountRoutingApplyResult[] = [];
	for (const selection of selections) {
		let response:
			| ComboRoutingPreviewResult
			| { families: ComboRoutingPreviewResult[] };
		try {
			response = await client.previewAccountRouting({
				accountId: options.accountId,
				family: selection.family,
				managedModel: selection.managedModel,
			});
		} catch {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"preview_failed",
			);
		}

		const refreshed = accountFamilyPreview(response, selection.family);
		if (!refreshed) {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"preview_missing",
			);
		}
		const projected = projectManagedRoutingPreview(refreshed);
		let reviewDeclined = false;
		try {
			reviewDeclined =
				(await options.review({
					kind: "account-preview",
					account_id: options.accountId,
					previews: [projected],
				})) === false;
		} catch {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"review_failed",
			);
		}
		if (reviewDeclined) {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"review_declined",
			);
		}

		const proposal = projected.proposals.find(
			(candidate) => candidate.proposal_id === selection.proposalId,
		);
		if (!proposal) {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"proposal_missing",
			);
		}
		if (
			proposalReviewMaterial(proposal) !==
			proposalReviewMaterial(selection.reviewedProposal)
		) {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"proposal_materially_changed",
			);
		}

		let confirmed: boolean;
		try {
			confirmed = await options.prompt.confirm(
				`Apply the refreshed reviewed ${selection.family} routing proposal?`,
			);
		} catch {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"confirmation_failed",
			);
		}
		if (!confirmed) {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"confirmation_declined",
			);
		}

		let effective: EffectiveComboRoutingView;
		try {
			effective = await client.applyAccountRoutingProposal({
				family: selection.family,
				accountId: options.accountId,
				previewId: projected.preview_id,
				proposalId: proposal.proposal_id,
				managedModel: proposal.managed_model,
			});
		} catch {
			return accountApplyStopped(
				options.accountId,
				results,
				selection.family,
				"apply_failed",
			);
		}
		results.push({
			family: selection.family,
			preview_id: projected.preview_id,
			proposal_id: proposal.proposal_id,
			managed_model: proposal.managed_model,
			effective: projectEffectiveRouting(effective),
		});
	}

	return {
		kind: "account-apply",
		status: "applied",
		account_id: options.accountId,
		results,
		stopped: null,
	};
}

export interface ManagedRoutingManualRollbackOptions {
	family: ComboFamily;
	confirmed?: boolean;
	nonInteractive?: boolean;
	json?: boolean;
	prompt?: PromptAdapter;
}

export async function runManagedRoutingManualRollback(
	client: ManagedRoutingControlPlane,
	options: ManagedRoutingManualRollbackOptions,
): Promise<ManagedRoutingManualRollbackReport | ManagedRoutingDeclinedReport> {
	let confirmed = options.confirmed;
	if ((options.nonInteractive || options.json) && confirmed === undefined) {
		throw new ManagedRoutingSafetyError(
			"Automated manual rollback requires an explicit confirmed value.",
		);
	}
	if (confirmed === undefined) {
		if (!options.prompt) {
			throw new ManagedRoutingSafetyError(
				"Manual rollback requires explicit confirmation or an injected PromptAdapter.",
			);
		}
		confirmed = await options.prompt.confirm(
			`Return ${options.family} membership to Manual mode?`,
		);
	}
	if (!confirmed) return { kind: "manual-rollback", status: "declined" };

	const assignment = await client.rollbackFamilyToManual(options.family);
	return {
		kind: "manual-rollback",
		status: "applied",
		assignment: projectFamilyAssignment(assignment),
	};
}

function renderMember(member: ManagedRoutingMemberProjection): string {
	return `${member.family} source=${member.source} tier=${member.tier} model=${member.logical_model} reason=${member.reason} availability=${member.availability.reason}`;
}

function renderAccount(account: ManagedRoutingAccountProjection): string[] {
	const lines = [
		`${account.name} (${account.account_id}) provider=${account.provider} priority=${account.priority}`,
	];
	for (const member of account.memberships) {
		lines.push(`  member ${renderMember(member)}`);
	}
	for (const decision of account.decisions) {
		lines.push(
			`  decision ${decision.family} source=${decision.source ?? "none"} tier=${decision.tier ?? "none"} model=${decision.logical_model ?? "none"} reason=${decision.reason} availability=${decision.availability.reason}`,
		);
	}
	for (const opportunity of account.opportunities) {
		lines.push(
			`  opportunity ${opportunity.family} proposal=${opportunity.proposal_id} model=${opportunity.managed_model} tier=${opportunity.tier_source} reason=${opportunity.reason}`,
		);
	}
	if (
		account.memberships.length === 0 &&
		account.decisions.length === 0 &&
		account.opportunities.length === 0
	) {
		lines.push("  routing: no memberships, decisions, or opportunities");
	}
	return lines;
}

function renderEffective(
	effective: ManagedRoutingEffectiveProjection,
): string[] {
	const lines = [
		`${effective.family} mode=${effective.assignment.membership_mode} active=${effective.active} model=${effective.assignment.managed_model ?? "none"} reason=${effective.resolution_reason ?? "none"}`,
	];
	for (const member of effective.members)
		lines.push(`  ${renderMember(member)}`);
	for (const decision of effective.decisions) {
		lines.push(
			`  decision account=${decision.account_id} source=${decision.source ?? "none"} tier=${decision.tier ?? "none"} model=${decision.logical_model ?? "none"} reason=${decision.reason} availability=${decision.availability.reason}`,
		);
	}
	return lines;
}

function renderPreview(preview: ManagedRoutingPreviewProjection): string[] {
	const lines = [
		`preview=${preview.preview_id} scope=${preview.scope} family=${preview.family} model=${preview.managed_model}`,
		...renderEffective(preview.effective),
	];
	for (const proposal of preview.proposals) {
		lines.push(
			`proposal=${proposal.proposal_id} provider=${proposal.provider} route_class=${proposal.route_class} tier=${proposal.tier_source} reason=${proposal.reason}`,
		);
		for (const delta of proposal.member_delta) {
			lines.push(
				`  delta=${delta.status} key=${delta.key}`,
				`    ${renderDeltaState("before", delta.before)}`,
				`    ${renderDeltaState("after", delta.after)}`,
			);
		}
	}
	return lines;
}

function renderDeltaState(
	label: "before" | "after",
	state: ManagedRoutingPreviewStateProjection | null,
): string {
	if (state === null) return `${label}=none`;
	return `${label} account=${state.account_id ?? "draft"} candidate=${state.candidate_id ?? "draft"} source=${state.source} tier=${state.tier} model=${state.logical_model} reason=${state.reason} provisional=${state.identity_provisional}`;
}

export function formatManagedRoutingReport(
	report: ManagedRoutingReport,
	format: ManagedRoutingOutputFormat,
): string {
	if (format === "json") return JSON.stringify(report, null, 2);

	switch (report.kind) {
		case "list":
			return report.accounts.flatMap(renderAccount).join("\n");
		case "detail":
			return renderAccount(report.account).join("\n");
		case "preview":
			return renderPreview(report.preview).join("\n");
		case "account-preview":
			return [
				`account=${report.account_id}`,
				...report.previews.flatMap(renderPreview),
			].join("\n");
		case "apply":
			return report.status === "declined"
				? "Routing apply declined; no write was sent."
				: [
						"Routing proposal applied.",
						...renderEffective(report.effective),
					].join("\n");
		case "account-apply":
			if (report.status === "declined") {
				return `Account routing apply declined for ${report.stopped?.family ?? "the current family"}; no write was sent.`;
			}
			if (report.status === "failed_closed") {
				return `Account routing apply failed closed for ${report.stopped?.family ?? "the current family"} (${report.stopped?.reason ?? "unknown"}); no write was sent.`;
			}
			return [
				report.status === "partial"
					? `Applied ${report.results.length} reviewed account routing proposal(s) for ${report.account_id}, then stopped at ${report.stopped?.family ?? "the current family"} (${report.stopped?.reason ?? "unknown"}).`
					: `Applied ${report.results.length} reviewed account routing proposal(s) for ${report.account_id}.`,
				...report.results.flatMap(({ effective }) =>
					renderEffective(effective),
				),
			].join("\n");
		case "manual-rollback":
			return report.status === "declined"
				? "Manual rollback declined; no write was sent."
				: `${report.assignment.family} membership mode is now ${report.assignment.membership_mode}.`;
	}
}
