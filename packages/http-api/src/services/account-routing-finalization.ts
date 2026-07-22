import type {
	ComboFamily,
	ComboRoutingPreviewResult,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";

export interface ReviewedAccountRoutingSelection {
	family: ComboFamily;
	proposalId: string;
}

export type PersistedAccountRoutingFinalizationReason =
	| "applied"
	| "already-effective"
	| "preview-missing"
	| "proposal-missing"
	| "confidence-downgraded"
	| "default-downgraded"
	| "stale-preview"
	| "preview-failed"
	| "apply-failed"
	| "not-effective";

export interface PersistedAccountRoutingFinalizationOutcome {
	family: ComboFamily;
	proposalId: string;
	status: "joined" | "action-required";
	reason: PersistedAccountRoutingFinalizationReason;
}

export interface PersistedAccountRoutingFinalizationResult {
	accountId: string;
	outcomes: PersistedAccountRoutingFinalizationOutcome[];
}

export interface PersistedAccountRoutingFinalizationDependencies {
	preview(params: {
		accountId: string;
		family: ComboFamily;
	}): Promise<ComboRoutingPreviewResult>;
	apply(params: {
		accountId: string;
		family: ComboFamily;
		previewId: string;
		proposalId: string;
		managedModel: string;
	}): Promise<EffectiveComboRoutingView>;
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

function proposalWasAlreadyEffective(
	preview: ComboRoutingPreviewResult,
	proposal: ComboRoutingPreviewResult["proposals"][number],
	accountId: string,
): boolean {
	if (!proposal.existing_rule_id) return false;
	const { policy } = preview.effective;
	if (
		policy.assignment.membership_mode !== "managed" ||
		policy.assignment.managed_model !== proposal.managed_model ||
		!policy.rules.some(
			(rule) => rule.id === proposal.existing_rule_id && rule.enabled,
		)
	) {
		return false;
	}
	const member = memberForAccount(preview.effective, accountId);
	return (
		member?.source === "managed" && member.rule_id === proposal.existing_rule_id
	);
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

function failedReason(
	phase: "preview" | "apply",
	error: unknown,
): PersistedAccountRoutingFinalizationReason {
	return errorCode(error) === "stale_routing_preview"
		? "stale-preview"
		: phase === "preview"
			? "preview-failed"
			: "apply-failed";
}

function actionRequired(
	selection: ReviewedAccountRoutingSelection,
	reason: PersistedAccountRoutingFinalizationReason,
): PersistedAccountRoutingFinalizationOutcome {
	return {
		family: selection.family,
		proposalId: selection.proposalId,
		status: "action-required",
		reason,
	};
}

/**
 * Reconcile user-reviewed routing choices against one immutable persisted
 * account. Families intentionally run in order because each successful apply
 * advances the routing-policy revision used by the next fresh preview.
 */
export function createPersistedAccountRoutingFinalizer(
	dependencies: PersistedAccountRoutingFinalizationDependencies,
) {
	return async (params: {
		accountId: string;
		reviewed: readonly ReviewedAccountRoutingSelection[];
	}): Promise<PersistedAccountRoutingFinalizationResult> => {
		const outcomes: PersistedAccountRoutingFinalizationOutcome[] = [];

		for (const selection of params.reviewed) {
			let preview: ComboRoutingPreviewResult;
			try {
				preview = await dependencies.preview({
					accountId: params.accountId,
					family: selection.family,
				});
			} catch (error) {
				outcomes.push(
					actionRequired(selection, failedReason("preview", error)),
				);
				continue;
			}

			if (preview.family !== selection.family) {
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
			if (proposalWasAlreadyEffective(preview, proposal, params.accountId)) {
				outcomes.push({
					family: selection.family,
					proposalId: selection.proposalId,
					status: "joined",
					reason: "already-effective",
				});
				continue;
			}
			if (!proposal.high_confidence) {
				outcomes.push(actionRequired(selection, "confidence-downgraded"));
				continue;
			}
			if (!proposal.selected_by_default) {
				outcomes.push(actionRequired(selection, "default-downgraded"));
				continue;
			}

			let effective: EffectiveComboRoutingView;
			try {
				effective = await dependencies.apply({
					accountId: params.accountId,
					family: selection.family,
					previewId: preview.preview_id,
					proposalId: selection.proposalId,
					managedModel: proposal.managed_model,
				});
			} catch (error) {
				outcomes.push(actionRequired(selection, failedReason("apply", error)));
				continue;
			}

			if (!memberForAccount(effective, params.accountId)) {
				outcomes.push(actionRequired(selection, "not-effective"));
				continue;
			}
			outcomes.push({
				family: selection.family,
				proposalId: selection.proposalId,
				status: "joined",
				reason: "applied",
			});
		}

		return { accountId: params.accountId, outcomes };
	};
}
