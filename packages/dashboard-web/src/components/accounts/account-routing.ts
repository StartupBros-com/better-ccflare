import type {
	AccountRoutingOverview,
	ComboFamily,
	ComboMembershipReasonCode,
	ComboRouteClass,
	ComboRoutingAccountDraft,
	ComboRoutingAvailabilityReason,
	ComboRoutingPreviewResult,
	ComboRoutingPreviewSubject,
	ComboRoutingProposalPreview,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";

export type AccountSetupMode =
	| "claude-oauth"
	| "console"
	| "zai"
	| "minimax"
	| "anthropic-compatible"
	| "openai-compatible"
	| "nanogpt"
	| "vertex-ai"
	| "bedrock"
	| "kilo"
	| "openrouter"
	| "alibaba-coding-plan"
	| "codex"
	| "qwen"
	| "ollama"
	| "ollama-cloud";

export interface AccountSetupRoutingMetadata {
	provider: string;
	routeClass: ComboRouteClass;
	billingType: "plan" | "api" | null;
}

const ACCOUNT_SETUP_ROUTING_METADATA = {
	"claude-oauth": {
		provider: "anthropic",
		routeClass: "oauth-subscription",
		billingType: "plan",
	},
	console: {
		provider: "claude-console-api",
		routeClass: "api-key",
		billingType: "api",
	},
	zai: { provider: "zai", routeClass: "api-key", billingType: "api" },
	minimax: { provider: "minimax", routeClass: "api-key", billingType: "api" },
	"anthropic-compatible": {
		provider: "anthropic-compatible",
		routeClass: "api-key",
		billingType: "api",
	},
	"openai-compatible": {
		provider: "openai-compatible",
		routeClass: "api-key",
		billingType: "api",
	},
	nanogpt: { provider: "nanogpt", routeClass: "api-key", billingType: "api" },
	"vertex-ai": {
		provider: "vertex-ai",
		routeClass: "cloud-credential",
		billingType: null,
	},
	bedrock: {
		provider: "bedrock",
		routeClass: "cloud-credential",
		billingType: null,
	},
	kilo: { provider: "kilo", routeClass: "api-key", billingType: "api" },
	openrouter: {
		provider: "openrouter",
		routeClass: "api-key",
		billingType: "api",
	},
	"alibaba-coding-plan": {
		provider: "alibaba-coding-plan",
		routeClass: "api-key",
		billingType: "api",
	},
	codex: {
		provider: "codex",
		routeClass: "oauth-subscription",
		billingType: "plan",
	},
	qwen: {
		provider: "qwen",
		routeClass: "oauth-subscription",
		billingType: "plan",
	},
	ollama: { provider: "ollama", routeClass: "local", billingType: null },
	"ollama-cloud": {
		provider: "ollama-cloud",
		routeClass: "api-key",
		billingType: "api",
	},
} as const satisfies Record<AccountSetupMode, AccountSetupRoutingMetadata>;

/** Explicit, network-free setup metadata; no provider inference happens in UI. */
export function accountSetupRoutingMetadata(
	mode: AccountSetupMode,
): AccountSetupRoutingMetadata {
	return ACCOUNT_SETUP_ROUTING_METADATA[mode];
}

/**
 * Routing-only setup metadata. Secret-bearing form fields are accepted only so
 * callers can pass their form shape without accidentally serializing them.
 */
export interface AccountRoutingDraftInput {
	provider: string;
	routeClass: ComboRouteClass;
	priority: number;
	billingType?: "plan" | "api" | null;
	modelMappings?: Record<string, string | string[]> | null;
	apiKey?: unknown;
	api_key?: unknown;
	accessToken?: unknown;
	access_token?: unknown;
	refreshToken?: unknown;
	refresh_token?: unknown;
	customEndpoint?: unknown;
	custom_endpoint?: unknown;
	name?: unknown;
}

/** Build the exact non-secret draft accepted by the authoritative preview API. */
export function buildAccountRoutingDraft(
	input: AccountRoutingDraftInput,
): ComboRoutingAccountDraft {
	const modelMappings = input.modelMappings
		? Object.fromEntries(
				Object.entries(input.modelMappings).map(([family, mapping]) => [
					family,
					Array.isArray(mapping) ? [...mapping] : mapping,
				]),
			)
		: null;

	return {
		provider: input.provider,
		priority: input.priority,
		auth_shape: input.routeClass,
		...(input.billingType !== undefined
			? { billing_type: input.billingType }
			: {}),
		...(modelMappings ? { model_mappings: modelMappings } : {}),
	};
}

export interface AccountSetupRoutingDraftInput {
	mode: AccountSetupMode;
	priority: number;
	modelMappings?: Record<string, string | string[]> | null;
	name?: unknown;
	apiKey?: unknown;
	api_key?: unknown;
	customEndpoint?: unknown;
	custom_endpoint?: unknown;
	accessToken?: unknown;
	refreshToken?: unknown;
}

/** Setup preview boundary: copy only explicitly reviewed, non-secret fields. */
export function buildAccountSetupRoutingDraft(
	input: AccountSetupRoutingDraftInput,
): ComboRoutingAccountDraft {
	const metadata = accountSetupRoutingMetadata(input.mode);
	return buildAccountRoutingDraft({
		provider: metadata.provider,
		routeClass: metadata.routeClass,
		priority: input.priority,
		billingType: metadata.billingType,
		modelMappings: input.modelMappings,
	});
}

export interface AccountSetupRoutingReview {
	previewDraftKey: string | null;
	reviewed: boolean;
}

export function accountSetupRoutingReviewIsCurrent(
	review: AccountSetupRoutingReview,
	currentDraftKey: string,
): boolean {
	return review.reviewed && review.previewDraftKey === currentDraftKey;
}

export function invalidateAccountSetupRoutingReview(
	review: AccountSetupRoutingReview,
	currentDraftKey: string,
): AccountSetupRoutingReview {
	return review.previewDraftKey === null ||
		review.previewDraftKey === currentDraftKey
		? review
		: { previewDraftKey: null, reviewed: false };
}

export interface AccountRoutingSelection {
	family: ComboFamily;
	proposalId: string;
}

/** Stable UI identity: a proposal ID is meaningful only inside its family. */
export function routingSelectionKey(
	selection: AccountRoutingSelection,
): string {
	return `${selection.family}:${selection.proposalId}`;
}

export type AccountRoutingPreviewPayload =
	| ComboRoutingPreviewResult
	| { families: ComboRoutingPreviewResult[] };

export function routingPreviewsFromPayload(
	payload: AccountRoutingPreviewPayload,
): ComboRoutingPreviewResult[] {
	return "families" in payload ? payload.families : [payload];
}

/** Server-selected defaults are trusted only while confidence is also high. */
export function defaultRoutingSelections(
	previews: readonly ComboRoutingPreviewResult[],
): AccountRoutingSelection[] {
	const selections: AccountRoutingSelection[] = [];
	const seen = new Set<string>();
	for (const preview of previews) {
		for (const proposal of preview.proposals) {
			if (!proposal.high_confidence || !proposal.selected_by_default) continue;
			const selection = {
				family: preview.family,
				proposalId: proposal.proposal_id,
			};
			const key = routingSelectionKey(selection);
			if (seen.has(key)) continue;
			seen.add(key);
			selections.push(selection);
		}
	}
	return selections;
}

export interface AccountRoutingReconcileClient {
	previewRouting(
		subject: ComboRoutingPreviewSubject,
		family: ComboFamily,
	): Promise<AccountRoutingPreviewPayload>;
	applyRoutingProposal(params: {
		family: ComboFamily;
		previewId: string;
		proposalId: string;
		accountId: string;
		managedModel: string;
	}): Promise<EffectiveComboRoutingView>;
}

export type AccountRoutingOutcomeReason =
	| "applied"
	| "already-effective"
	| "preview-missing"
	| "proposal-missing"
	| "confidence-downgraded"
	| "default-downgraded"
	| "stale-preview"
	| "preview-failed"
	| "apply-failed"
	| "not-effective"
	| "missing-account-id";

export interface AccountRoutingOutcome {
	family: ComboFamily;
	proposalId: string;
	status: "joined" | "action-required";
	reason: AccountRoutingOutcomeReason;
	member: EffectiveComboMemberView | null;
}

function memberForAccount(
	view: EffectiveComboRoutingView,
	accountId: string,
): EffectiveComboMemberView | null {
	return (
		view.resolution.members.find((member) => member.account_id === accountId) ??
		null
	);
}

function proposalIsAlreadyEffective(
	preview: ComboRoutingPreviewResult,
	proposal: ComboRoutingProposalPreview,
	accountId: string,
): EffectiveComboMemberView | null {
	if (!proposal.existing_rule_id) return null;
	const { policy } = preview.effective;
	if (
		policy.assignment.membership_mode !== "managed" ||
		policy.assignment.managed_model !== proposal.managed_model ||
		!policy.rules.some(
			(rule) => rule.id === proposal.existing_rule_id && rule.enabled,
		)
	) {
		return null;
	}
	const member = memberForAccount(preview.effective, accountId);
	return member?.source === "managed" &&
		member.rule_id === proposal.existing_rule_id
		? member
		: null;
}

function errorCode(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	const value = error as {
		code?: unknown;
		details?: unknown;
		body?: unknown;
		response?: unknown;
	};
	if (typeof value.code === "string") return value.code;
	for (const nested of [value.details, value.body, value.response]) {
		const nestedCode = errorCode(nested);
		if (nestedCode) return nestedCode;
	}
	return null;
}

function isStalePreviewError(error: unknown): boolean {
	if (errorCode(error) === "stale_routing_preview") return true;
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes("routing preview is stale")
	);
}

function actionRequired(
	selection: AccountRoutingSelection,
	reason: AccountRoutingOutcomeReason,
): AccountRoutingOutcome {
	return {
		family: selection.family,
		proposalId: selection.proposalId,
		status: "action-required",
		reason,
		member: null,
	};
}

export function missingAccountIdentityOutcomes(
	selections: readonly AccountRoutingSelection[],
): AccountRoutingOutcome[] {
	return selections.map((selection) =>
		actionRequired(selection, "missing-account-id"),
	);
}

/**
 * Reconcile reviewed draft choices against the immutable persisted account.
 * Families intentionally run one-by-one: an apply changes policy revision and
 * the next family must receive its own fresh server preview.
 */
export async function reconcileAccountRoutingSelections(params: {
	accountId: string;
	selections: readonly AccountRoutingSelection[];
	client: AccountRoutingReconcileClient;
}): Promise<AccountRoutingOutcome[]> {
	const outcomes: AccountRoutingOutcome[] = [];
	for (const selection of params.selections) {
		let preview: ComboRoutingPreviewResult | undefined;
		try {
			const payload = await params.client.previewRouting(
				{ account_id: params.accountId },
				selection.family,
			);
			preview = routingPreviewsFromPayload(payload).find(
				(candidate) => candidate.family === selection.family,
			);
		} catch (error) {
			outcomes.push(
				actionRequired(
					selection,
					isStalePreviewError(error) ? "stale-preview" : "preview-failed",
				),
			);
			continue;
		}

		if (!preview) {
			outcomes.push(actionRequired(selection, "preview-missing"));
			continue;
		}
		const proposal = preview.proposals.find(
			(candidate) => candidate.proposal_id === selection.proposalId,
		);
		if (!proposal) {
			outcomes.push(actionRequired(selection, "proposal-missing"));
			continue;
		}
		if (!proposal.high_confidence) {
			outcomes.push(actionRequired(selection, "confidence-downgraded"));
			continue;
		}

		const existingMember = proposalIsAlreadyEffective(
			preview,
			proposal,
			params.accountId,
		);
		if (existingMember) {
			outcomes.push({
				family: selection.family,
				proposalId: selection.proposalId,
				status: "joined",
				reason: "already-effective",
				member: existingMember,
			});
			continue;
		}

		try {
			const effective = await params.client.applyRoutingProposal({
				family: selection.family,
				previewId: preview.preview_id,
				proposalId: selection.proposalId,
				accountId: params.accountId,
				managedModel: proposal.managed_model,
			});
			const member = memberForAccount(effective, params.accountId);
			outcomes.push(
				member
					? {
							family: selection.family,
							proposalId: selection.proposalId,
							status: "joined",
							reason: "applied",
							member,
						}
					: actionRequired(selection, "not-effective"),
			);
		} catch (error) {
			outcomes.push(
				actionRequired(
					selection,
					isStalePreviewError(error) ? "stale-preview" : "apply-failed",
				),
			);
		}
	}
	return outcomes;
}

const REASON_LABELS: Record<ComboMembershipReasonCode, string> = {
	included: "Included",
	manual_override: "Manual override",
	excluded: "Excluded from managed routing",
	unsupported: "Logical model unsupported",
	unknown: "Capability unknown",
	disabled: "Family routing disabled",
	ambiguous: "Ambiguous server proposal",
	new_billing_class: "New billing class requires review",
};

const AVAILABILITY_LABELS: Record<ComboRoutingAvailabilityReason, string> = {
	available: "Available",
	paused: "Paused; membership is unchanged",
	requires_reauth: "Re-authentication required; membership is unchanged",
	rate_limited: "Rate limited; membership is unchanged",
	model_exhausted: "Model usage exhausted; membership is unchanged",
};

export function routingReasonLabel(reason: ComboMembershipReasonCode): string {
	return REASON_LABELS[reason];
}

export function routingAvailabilityLabel(
	reason: ComboRoutingAvailabilityReason,
): string {
	return AVAILABILITY_LABELS[reason];
}

export interface AccountFamilyRoutingState {
	family: ComboFamily;
	comboId: string | null;
	comboName: string | null;
	active: boolean;
	membershipLabel: "Manual" | "Managed" | null;
	tier: number | null;
	logicalModel: string | null;
	reason: ComboMembershipReasonCode | null;
	reasonLabel: string | null;
	availability: ComboRoutingAvailabilityReason | null;
	availabilityLabel: string | null;
	/** True only when the compact server overview includes this exact account ID. */
	managedRouteAvailable: boolean;
}

/**
 * Convert the coherent server overview into card state. Effective members and
 * decisions are the only current facts. A compact opportunity can prompt
 * review but never becomes a current membership claim.
 */
export function getAccountFamilyRoutingStates(
	accountId: string,
	overview: AccountRoutingOverview,
): AccountFamilyRoutingState[] {
	const opportunitiesByFamily = new Map(
		overview.opportunities
			.filter((opportunity) => opportunity.account_id === accountId)
			.map((opportunity) => [opportunity.family, opportunity]),
	);

	const states: AccountFamilyRoutingState[] = [];
	for (const view of overview.effective) {
		const member =
			view.resolution.members.find(
				(candidate) => candidate.account_id === accountId,
			) ?? null;
		const fact =
			member ??
			view.resolution.decisions.find(
				(decision) => decision.account_id === accountId,
			);
		const managedRouteAvailable =
			!member && opportunitiesByFamily.has(view.family);
		if (!fact && !managedRouteAvailable) continue;
		states.push({
			family: view.family,
			comboId: view.policy.combo?.id ?? null,
			comboName: view.policy.combo?.name ?? null,
			active: view.resolution.active,
			membershipLabel: member
				? member.source === "manual"
					? "Manual"
					: "Managed"
				: null,
			tier: fact?.tier ?? null,
			logicalModel: fact?.logical_model ?? null,
			reason: fact?.reason ?? null,
			reasonLabel: fact ? routingReasonLabel(fact.reason) : null,
			availability: fact?.availability.reason ?? null,
			availabilityLabel: fact
				? routingAvailabilityLabel(fact.availability.reason)
				: null,
			managedRouteAvailable,
		});
	}
	return states;
}

export function routingOutcomeReasonLabel(
	reason: AccountRoutingOutcomeReason,
): string {
	switch (reason) {
		case "applied":
			return "Reviewed routing proposal applied";
		case "already-effective":
			return "Already joined through an enabled managed rule";
		case "preview-missing":
			return "Authoritative family preview is unavailable";
		case "proposal-missing":
			return "Reviewed proposal changed after account creation";
		case "confidence-downgraded":
			return "Confidence changed after account creation";
		case "default-downgraded":
			return "The reviewed default changed; review the current routing proposal";
		case "stale-preview":
			return "Routing policy changed; review the current proposal";
		case "preview-failed":
			return "Authoritative routing preview failed";
		case "apply-failed":
			return "Routing proposal could not be applied";
		case "not-effective":
			return "Applied policy did not produce an effective membership";
		case "missing-account-id":
			return "Account creation did not return an immutable account ID";
	}
}
