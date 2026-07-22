import { describe, expect, it } from "bun:test";
import type {
	ComboRoutingPreviewResult,
	ComboRoutingProposalPreview,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	buildManagedFamilyApplyCommand,
	canApplyManagedFamilyConversion,
	isManagedFamilyPreviewCurrent,
	ManagedFamilyConversionBody,
	ManagedFamilyConversionReview,
	managedFamilyConversionError,
	proposalRequiresExplicitReview,
} from "./ManagedFamilyConversionDialog";

function effectiveView(
	membershipMode: "manual" | "managed" = "manual",
): EffectiveComboRoutingView {
	return {
		family: "opus",
		policy: {
			assignment: {
				family: "opus",
				combo_id: "combo-opus",
				enabled: true,
				membership_mode: membershipMode,
				managed_model: membershipMode === "managed" ? "claude-opus-4-8" : null,
			},
			combo: {
				id: "combo-opus",
				name: "Opus priority",
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [
				{
					id: "slot-codex",
					combo_id: "combo-opus",
					account_id: "codex-fallback",
					model: "gpt-5.4",
					priority: 70,
					enabled: true,
				},
			],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family: "opus",
			combo_id: "combo-opus",
			active: true,
			reason: null,
			members: [],
			decisions: [],
		},
	};
}

function proposal(
	overrides: Partial<ComboRoutingProposalPreview> = {},
): ComboRoutingProposalPreview {
	const proposed = effectiveView("managed");
	proposed.resolution.members = [
		{
			id: "managed:opus:rule-anthropic:account-four",
			account_id: "account-four",
			account_name: "Fourth subscription",
			combo_id: "combo-opus",
			family: "opus",
			included: true,
			logical_model: "claude-opus-4-8",
			tier: 0,
			source: "managed",
			reason: "included",
			slot_id: null,
			rule_id: "rule-anthropic",
			availability: { available: true, reason: "available" },
			identity_provisional: false,
		},
	];

	return {
		proposal_id: "proposal-opus-anthropic",
		family: "opus",
		combo_id: "combo-opus",
		provider: "anthropic",
		route_class: "oauth-subscription",
		existing_rule_id: null,
		managed_model: "claude-opus-4-8",
		tier_source: "account_priority",
		high_confidence: true,
		selected_by_default: true,
		reason: "included",
		proposed_effective: proposed,
		member_delta: [
			{
				key: "account-four",
				status: "added",
				before: null,
				after: {
					key: "account-four",
					account_id: "account-four",
					candidate_id: "managed:opus:rule-anthropic:account-four",
					identity_provisional: false,
					source: "managed",
					tier: 0,
					logical_model: "claude-opus-4-8",
					reason: "included",
				},
			},
		],
		...overrides,
	};
}

function preview(
	proposalOverrides: Partial<ComboRoutingProposalPreview> = {},
): ComboRoutingPreviewResult {
	return {
		preview_id: "preview-opus-revision-12",
		scope: "family",
		family: "opus",
		managed_model: "claude-opus-4-8",
		proposals: [proposal(proposalOverrides)],
		effective: effectiveView(),
	};
}

describe("ManagedFamilyConversionDialog", () => {
	it("renders only the server proposal, exact member delta, and preserved slots", () => {
		const data = preview();
		const html = renderToStaticMarkup(
			<ManagedFamilyConversionReview
				family="opus"
				managedModel="claude-opus-4-8"
				preview={data}
				selectedProposalId="proposal-opus-anthropic"
				reviewAcknowledged={false}
				onProposalSelect={() => {}}
				onReviewAcknowledgedChange={() => {}}
			/>,
		);

		expect(html).toContain("Review Opus managed routing");
		expect(html).toContain("anthropic");
		expect(html).toContain("oauth-subscription");
		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("account-four");
		expect(html).toContain("Added");
		expect(html).toContain("Managed · claude-opus-4-8 · tier 0");
		expect(html).toContain("1 manual slot preserved");
		expect(html).toContain("codex-fallback");
		expect(html).toContain("gpt-5.4");
		expect(html).not.toContain("I inferred");

		expect(
			buildManagedFamilyApplyCommand(data, "proposal-opus-anthropic"),
		).toEqual({
			family: "opus",
			previewId: "preview-opus-revision-12",
			proposalId: "proposal-opus-anthropic",
			managedModel: "claude-opus-4-8",
		});
	});

	it("requires an explicit acknowledgement for low-confidence and new-billing proposals", () => {
		const lowConfidence = proposal({
			high_confidence: false,
			selected_by_default: false,
			reason: "ambiguous",
		});
		const newBilling = proposal({
			high_confidence: true,
			selected_by_default: false,
			reason: "new_billing_class",
		});

		expect(proposalRequiresExplicitReview(lowConfidence)).toBe(true);
		expect(proposalRequiresExplicitReview(newBilling)).toBe(true);
		expect(
			canApplyManagedFamilyConversion(
				preview({
					high_confidence: false,
					selected_by_default: false,
					reason: "ambiguous",
				}),
				"proposal-opus-anthropic",
				false,
			),
		).toBe(false);
		expect(
			canApplyManagedFamilyConversion(
				preview({
					high_confidence: false,
					selected_by_default: false,
					reason: "ambiguous",
				}),
				"proposal-opus-anthropic",
				true,
			),
		).toBe(true);

		const html = renderToStaticMarkup(
			<ManagedFamilyConversionReview
				family="opus"
				managedModel="claude-opus-4-8"
				preview={preview({
					high_confidence: true,
					selected_by_default: false,
					reason: "new_billing_class",
				})}
				selectedProposalId="proposal-opus-anthropic"
				reviewAcknowledged={false}
				onProposalSelect={() => {}}
				onReviewAcknowledgedChange={() => {}}
			/>,
		);
		expect(html).toContain("Explicit review required");
		expect(html).toContain("new billing class");
		expect(html).toContain("I reviewed this server proposal");
	});

	it("requires explicit review for an ambiguous proposal even if confidence is inconsistent", () => {
		const inconsistent = proposal({
			high_confidence: true,
			selected_by_default: true,
			reason: "ambiguous",
		});

		expect(proposalRequiresExplicitReview(inconsistent)).toBe(true);
		expect(
			canApplyManagedFamilyConversion(
				preview({
					high_confidence: true,
					selected_by_default: true,
					reason: "ambiguous",
				}),
				"proposal-opus-anthropic",
				false,
			),
		).toBe(false);
	});

	it("fails closed when preview family or managed model differs from the open review", () => {
		const data = preview();

		expect(isManagedFamilyPreviewCurrent(data, "opus", "claude-opus-4-8")).toBe(
			true,
		);
		expect(
			isManagedFamilyPreviewCurrent(data, "fable", "claude-opus-4-8"),
		).toBe(false);
		expect(
			isManagedFamilyPreviewCurrent(data, "opus", "claude-opus-preview"),
		).toBe(false);
		expect(
			buildManagedFamilyApplyCommand(
				data,
				"proposal-opus-anthropic",
				"fable",
				"claude-opus-4-8",
			),
		).toBeNull();
		expect(
			canApplyManagedFamilyConversion(
				data,
				"proposal-opus-anthropic",
				true,
				"opus",
				"claude-opus-preview",
			),
		).toBe(false);
	});

	it("blocks an authoritative zero-member proposal and explains typed apply failures", () => {
		const empty = preview();
		const emptyProposal = empty.proposals[0];
		if (!emptyProposal) throw new Error("fixture proposal is missing");
		emptyProposal.proposed_effective.resolution.members = [];

		expect(
			canApplyManagedFamilyConversion(empty, "proposal-opus-anthropic", true),
		).toBe(false);
		expect(
			managedFamilyConversionError({
				message: "unprocessable",
				details: { code: "managed_route_empty" },
			}),
		).toEqual({
			code: "managed_route_empty",
			message:
				"Managed mode was not enabled because the server found zero effective candidates. The family remains in its previous mode.",
			retryable: true,
		});
	});

	it("marks stale previews as retryable instead of applying old evidence", () => {
		expect(
			managedFamilyConversionError({
				message: "conflict",
				details: { code: "stale_routing_preview" },
			}),
		).toEqual({
			code: "stale_routing_preview",
			message:
				"This preview is stale because routing changed. Refresh and review the current server proposal before applying.",
			retryable: true,
		});

		const html = renderToStaticMarkup(
			<ManagedFamilyConversionBody
				family="opus"
				managedModel="claude-opus-4-8"
				preview={preview()}
				selectedProposalId="proposal-opus-anthropic"
				reviewAcknowledged={false}
				isPreviewLoading={false}
				previewError={null}
				isApplying={false}
				applyError={{
					message: "conflict",
					details: { code: "stale_routing_preview" },
				}}
				onProposalSelect={() => {}}
				onReviewAcknowledgedChange={() => {}}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain("preview is stale");
		expect(html).toContain("Refresh preview");
	});

	it("renders an explicit loading state while no preview is available", () => {
		const html = renderToStaticMarkup(
			<ManagedFamilyConversionBody
				family="opus"
				managedModel="claude-opus-4-8"
				preview={null}
				selectedProposalId={null}
				reviewAcknowledged={false}
				isPreviewLoading
				previewError={null}
				isApplying={false}
				applyError={null}
				onProposalSelect={() => {}}
				onReviewAcknowledgedChange={() => {}}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain("Loading the current server preview");
	});
});
