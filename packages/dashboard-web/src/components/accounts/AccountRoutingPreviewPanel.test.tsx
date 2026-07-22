import { describe, expect, it } from "bun:test";
import type {
	ComboFamily,
	ComboRoutingPreviewResult,
	ComboRoutingProposalPreview,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountRoutingPreviewPanel } from "./AccountRoutingPreviewPanel";

function view(family: ComboFamily): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: `combo-${family}`,
				enabled: true,
				membership_mode: "manual",
				managed_model: null,
			},
			combo: {
				id: `combo-${family}`,
				name: `${family} priority`,
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: `combo-${family}`,
			active: true,
			reason: null,
			members: [],
			decisions: [],
		},
	};
}

function preview(
	family: ComboFamily,
	highConfidence: boolean,
): ComboRoutingPreviewResult {
	const effective = view(family);
	const proposal: ComboRoutingProposalPreview = {
		proposal_id: `proposal-${family}`,
		family,
		combo_id: `combo-${family}`,
		provider: "anthropic",
		route_class: "oauth-subscription",
		existing_rule_id: null,
		managed_model: `claude-${family}-latest`,
		tier_source: "account_priority",
		high_confidence: highConfidence,
		selected_by_default: highConfidence,
		reason: highConfidence ? "included" : "ambiguous",
		proposed_effective: effective,
		member_delta: [],
	};
	return {
		preview_id: `preview-${family}`,
		scope: "account",
		family,
		managed_model: proposal.managed_model,
		proposals: [proposal],
		effective,
	};
}

describe("AccountRoutingPreviewPanel", () => {
	it("shows authoritative proposal details, safe selection, and durable outcomes", () => {
		const html = renderToStaticMarkup(
			<AccountRoutingPreviewPanel
				previews={[preview("opus", true), preview("fable", false)]}
				selections={[{ family: "opus", proposalId: "proposal-opus" }]}
				onSelectionChange={() => {}}
				outcomes={[
					{
						family: "opus",
						proposalId: "proposal-opus",
						status: "joined",
						reason: "applied",
						member: null,
					},
					{
						family: "fable",
						proposalId: "proposal-fable",
						status: "action-required",
						reason: "confidence-downgraded",
						member: null,
					},
				]}
			/>,
		);

		expect(html).toContain("Routing preview");
		expect(html).toContain("opus priority");
		expect(html).toContain("claude-opus-latest");
		expect(html).toContain("Account priority");
		expect(html).toContain('data-selection-key="opus:proposal-opus"');
		expect(html).toContain('data-selected="true"');
		expect(html).toContain('data-selection-key="fable:proposal-fable"');
		expect(html).toContain('data-selected="false"');
		expect(html).toContain("Ambiguous server proposal");
		expect(html).toContain("Joined");
		expect(html).toContain("Action required");
		expect(html).toContain("Confidence changed after account creation");
	});
});
