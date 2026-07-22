import { describe, expect, it } from "bun:test";
import { getModelFamily, LATEST_MODEL_BY_FAMILY } from "@better-ccflare/core";
import type {
	ComboFamily,
	ComboMembershipDecisionView,
	ComboRoutingMemberDelta,
	ComboRoutingPreviewResult,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import {
	familyModelOptions,
	familyRoutingReasonLabel,
	projectFamilyConversionPreview,
	projectFamilyRouting,
	projectFamilyRoutings,
} from "./family-routing";

const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

function member(
	family: ComboFamily,
	accountId: string,
	source: "manual" | "managed",
	reason: EffectiveComboMemberView["reason"] = "included",
): EffectiveComboMemberView {
	return {
		id: `${source}:${accountId}`,
		account_id: accountId,
		account_name: `${accountId} name`,
		combo_id: `combo-${family}`,
		family,
		included: true,
		logical_model: `claude-${family}-projection-test`,
		tier: source === "manual" ? 7 : 2,
		source,
		reason,
		slot_id: source === "manual" ? `slot-${accountId}` : null,
		rule_id: source === "managed" ? `rule-${accountId}` : null,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
	};
}

function decision(
	family: ComboFamily,
	accountId: string,
	reason: ComboMembershipDecisionView["reason"],
): ComboMembershipDecisionView {
	return {
		account_id: accountId,
		account_name: `${accountId} name`,
		combo_id: `combo-${family}`,
		family,
		included: false,
		logical_model: null,
		tier: null,
		source: null,
		reason,
		slot_id: null,
		rule_id: null,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
	};
}

function routingView(
	family: ComboFamily,
	overrides: {
		members?: EffectiveComboMemberView[];
		decisions?: ComboMembershipDecisionView[];
	} = {},
): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: `combo-${family}`,
				enabled: true,
				membership_mode: "managed",
				managed_model: LATEST_MODEL_BY_FAMILY[family],
			},
			combo: {
				id: `combo-${family}`,
				name: `${family} routing`,
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [
				{
					id: `slot-${family}-manual`,
					combo_id: `combo-${family}`,
					account_id: `${family}-manual`,
					model: `explicit-${family}-model`,
					priority: 7,
					enabled: true,
				},
				{
					id: `slot-${family}-disabled`,
					combo_id: `combo-${family}`,
					account_id: `${family}-disabled`,
					model: `disabled-${family}-model`,
					priority: 9,
					enabled: false,
				},
			],
			rules: [
				{
					id: `rule-${family}`,
					family,
					combo_id: `combo-${family}`,
					provider: "server-owned-provider",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
			exclusions: [
				{
					id: `exclusion-${family}`,
					family,
					combo_id: `combo-${family}`,
					account_id: `${family}-excluded`,
					created_at: 1,
				},
			],
		},
		resolution: {
			family,
			combo_id: `combo-${family}`,
			active: true,
			reason: null,
			members: overrides.members ?? [],
			decisions: overrides.decisions ?? [],
		},
	};
}

describe("family routing projection", () => {
	it("keeps persisted manual slots separate from authoritative effective members", () => {
		const view = routingView("opus", {
			members: [
				member("opus", "opus-manual", "manual", "manual_override"),
				member("opus", "opus-managed", "managed"),
			],
			decisions: [
				decision("opus", "opus-excluded", "excluded"),
				decision("opus", "opus-unsupported", "unsupported"),
			],
		});

		const projection = projectFamilyRouting(view);

		expect(projection.manualSlots.map((slot) => slot.id)).toEqual([
			"slot-opus-manual",
			"slot-opus-disabled",
		]);
		expect(projection.manualMembers).toHaveLength(1);
		expect(projection.manualMembers[0]).toMatchObject({
			sourceLabel: "Manual",
			reasonLabel: "Manual override",
			isManualOverride: true,
		});
		expect(projection.managedMembers).toHaveLength(1);
		expect(projection.managedMembers[0]).toMatchObject({
			sourceLabel: "Managed",
			reasonLabel: "Included",
			isManualOverride: false,
		});
		expect(projection.decisions.map(({ reasonLabel }) => reasonLabel)).toEqual([
			"Excluded from managed routing",
			"Logical model unsupported",
		]);
		expect(projection.decisions[0]).toMatchObject({
			isExcluded: true,
			isRejected: true,
		});
		expect(projection.exclusions).toEqual(view.policy.exclusions);
	});

	it("projects every assigned family without deriving members from rules or decisions", () => {
		const views = FAMILIES.map((family) =>
			routingView(family, {
				decisions: [
					{
						...decision(family, `${family}-decision-only`, "included"),
						included: true,
						source: "managed",
					},
				],
			}),
		);

		const projections = projectFamilyRoutings(views);

		expect(projections.map(({ family }) => family)).toEqual([...FAMILIES]);
		for (const projection of projections) {
			expect(projection.manualMembers).toEqual([]);
			expect(projection.managedMembers).toEqual([]);
			expect(projection.decisions).toHaveLength(1);
		}
	});

	it("uses stable labels for server-owned reasons", () => {
		expect(familyRoutingReasonLabel("manual_override")).toBe("Manual override");
		expect(familyRoutingReasonLabel("excluded")).toBe(
			"Excluded from managed routing",
		);
		expect(familyRoutingReasonLabel("new_billing_class")).toBe(
			"New billing class requires review",
		);
	});
});

describe("family conversion preview projection", () => {
	it("preserves the exact authoritative member_delta for each proposal", () => {
		const current = routingView("opus");
		const proposed = routingView("opus", {
			members: [member("opus", "opus-managed", "managed")],
		});
		const memberDelta: ComboRoutingMemberDelta[] = [
			{
				key: "managed:opus-managed",
				status: "added",
				before: null,
				after: {
					key: "managed:opus-managed",
					account_id: "opus-managed",
					candidate_id: "managed:opus-managed",
					identity_provisional: false,
					source: "managed",
					tier: 2,
					logical_model: LATEST_MODEL_BY_FAMILY.opus,
					reason: "included",
				},
			},
		];
		const preview: ComboRoutingPreviewResult = {
			preview_id: "preview-opus",
			scope: "family",
			family: "opus",
			managed_model: LATEST_MODEL_BY_FAMILY.opus,
			effective: current,
			proposals: [
				{
					proposal_id: "proposal-opus",
					family: "opus",
					combo_id: "combo-opus",
					provider: "server-owned-provider",
					route_class: "oauth-subscription",
					existing_rule_id: null,
					managed_model: LATEST_MODEL_BY_FAMILY.opus,
					tier_source: "account_priority",
					high_confidence: true,
					selected_by_default: true,
					reason: "included",
					proposed_effective: proposed,
					member_delta: memberDelta,
				},
			],
		};

		const projection = projectFamilyConversionPreview(preview);

		expect(projection.currentRouting.manualSlots).toEqual(current.policy.slots);
		expect(projection.proposals[0].memberDelta).toEqual(memberDelta);
		expect(projection.proposals[0].proposedRouting.managedMembers).toHaveLength(
			1,
		);
	});
});

describe("family model options", () => {
	it("uses canonical family detection and always offers the latest model for all families", () => {
		const options = [
			{ id: "vendor/claude-fable-preview", displayName: "Fable preview" },
			{ id: "vendor/claude-opus-preview", displayName: "Opus preview" },
			{ id: "vendor/claude-sonnet-preview", displayName: "Sonnet preview" },
			{ id: "vendor/claude-haiku-preview", displayName: "Haiku preview" },
			{ id: "provider-unclassified-model", displayName: "Other" },
		];

		for (const family of FAMILIES) {
			const choices = familyModelOptions(family, options);
			expect(choices[0]?.id).toBe(LATEST_MODEL_BY_FAMILY[family]);
			expect(choices.map(({ id }) => getModelFamily(id))).toEqual(
				choices.map(() => family),
			);
			expect(
				choices.some(({ id }) => id === "provider-unclassified-model"),
			).toBe(false);
		}
	});

	it("does not duplicate the latest model already supplied by useModelOptions", () => {
		const latest = LATEST_MODEL_BY_FAMILY.opus;
		expect(
			familyModelOptions("opus", [
				{ id: latest, displayName: "Live latest" },
				{ id: latest, displayName: "Duplicate" },
			]),
		).toEqual([{ id: latest, displayName: "Live latest" }]);
	});
});
