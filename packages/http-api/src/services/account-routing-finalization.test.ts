import { describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ComboFamily,
	ComboRoutingPreviewResult,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import {
	createPersistedAccountRoutingFinalizer,
	type PersistedAccountRoutingFinalizationDependencies,
} from "./account-routing-finalization";

describe("service import boundaries", () => {
	it("keeps service modules independent from HTTP handlers", () => {
		const violations = readdirSync(import.meta.dir)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.flatMap((name) => {
				const source = readFileSync(join(import.meta.dir, name), "utf8");
				return /from\s+["']\.\.\/handlers(?:\/|["'])/.test(source)
					? [name]
					: [];
			});

		expect(violations).toEqual([]);
	});
});

function effectiveRouting(
	family: ComboFamily,
	accountId: string,
	ruleId: string | null = null,
): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: "combo-1",
				enabled: true,
				membership_mode: ruleId ? "managed" : "manual",
				managed_model: ruleId ? `claude-${family}-4-8` : null,
			},
			combo: null,
			slots: [],
			rules: ruleId
				? [
						{
							id: ruleId,
							family,
							combo_id: "combo-1",
							provider: "anthropic",
							route_class: "oauth-subscription",
							enabled: true,
							created_at: 1,
							updated_at: 1,
						},
					]
				: [],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: "combo-1",
			membership_mode: ruleId ? "managed" : "manual",
			managed_model: ruleId ? `claude-${family}-4-8` : null,
			members: [
				{
					id: `member-${accountId}`,
					account_id: accountId,
					account_name: "must-not-be-used-as-identity",
					combo_id: "combo-1",
					model: `claude-${family}-4-8`,
					priority: 0,
					enabled: true,
					source: ruleId ? "managed" : "explicit",
					tier: 0,
					logical_model: `claude-${family}-4-8`,
					rule_id: ruleId,
					reason: "included",
					availability: { available: true, reason: "available" },
					identity_provisional: false,
				},
			],
			decisions: [],
		},
	} as EffectiveComboRoutingView;
}

function preview(params: {
	family: ComboFamily;
	accountId: string;
	proposalId: string;
	highConfidence?: boolean;
	selectedByDefault?: boolean;
	existingRuleId?: string | null;
	additionalProposalIds?: string[];
}): ComboRoutingPreviewResult {
	const model = `claude-${params.family}-4-8`;
	const existingRuleId = params.existingRuleId ?? null;
	const effective = effectiveRouting(
		params.family,
		params.accountId,
		existingRuleId,
	);
	const proposalFor = (proposalId: string) => ({
		proposal_id: proposalId,
		family: params.family,
		combo_id: "combo-1",
		provider: "anthropic",
		route_class: "oauth-subscription" as const,
		existing_rule_id: existingRuleId,
		managed_model: model,
		tier_source: "account_priority" as const,
		high_confidence: params.highConfidence ?? true,
		selected_by_default: params.selectedByDefault ?? true,
		reason: "included" as const,
		proposed_effective: effective,
		member_delta: [],
	});
	return {
		preview_id: `preview-${params.family}`,
		scope: "account",
		family: params.family,
		managed_model: model,
		proposals: [
			proposalFor(params.proposalId),
			...(params.additionalProposalIds ?? []).map(proposalFor),
		],
		effective,
	};
}

describe("persisted account routing finalization", () => {
	it("fresh-previews and applies reviewed families sequentially with the exact identity", async () => {
		const calls: string[] = [];
		const dependencies: PersistedAccountRoutingFinalizationDependencies = {
			preview: mock(async ({ accountId, family }) => {
				calls.push(`preview:${family}`);
				return preview({ family, accountId, proposalId: `reviewed-${family}` });
			}),
			apply: mock(async ({ accountId, family, proposalId }) => {
				calls.push(`apply:${family}:${proposalId}`);
				return effectiveRouting(family, accountId);
			}),
		};
		const finalize = createPersistedAccountRoutingFinalizer(dependencies);

		const result = await finalize({
			accountId: "persisted-account-id",
			reviewed: [
				{ family: "opus", proposalId: "reviewed-opus" },
				{ family: "sonnet", proposalId: "reviewed-sonnet" },
			],
		});

		expect(calls).toEqual([
			"preview:opus",
			"apply:opus:reviewed-opus",
			"preview:sonnet",
			"apply:sonnet:reviewed-sonnet",
		]);
		expect(result.accountId).toBe("persisted-account-id");
		expect(
			result.outcomes.map(({ status, reason }) => ({ status, reason })),
		).toEqual([
			{ status: "joined", reason: "applied" },
			{ status: "joined", reason: "applied" },
		]);
	});

	it("never substitutes an unreviewed proposal when the exact proposal disappeared", async () => {
		const apply = mock(async () =>
			effectiveRouting("opus", "persisted-account-id"),
		);
		const finalize = createPersistedAccountRoutingFinalizer({
			preview: async ({ accountId, family }) =>
				preview({
					family,
					accountId,
					proposalId: "different-default",
					additionalProposalIds: ["another-alternative"],
				}),
			apply,
		});

		const result = await finalize({
			accountId: "persisted-account-id",
			reviewed: [{ family: "opus", proposalId: "reviewed-proposal" }],
		});

		expect(apply).not.toHaveBeenCalled();
		expect(result.outcomes).toEqual([
			{
				family: "opus",
				proposalId: "reviewed-proposal",
				status: "action-required",
				reason: "proposal-missing",
			},
		]);
	});

	it("requires the reviewed proposal to remain high-confidence and selected by default", async () => {
		const apply = mock(async () =>
			effectiveRouting("opus", "persisted-account-id"),
		);
		const previews = [
			preview({
				family: "opus",
				accountId: "persisted-account-id",
				proposalId: "reviewed-opus",
				highConfidence: false,
			}),
			preview({
				family: "sonnet",
				accountId: "persisted-account-id",
				proposalId: "reviewed-sonnet",
				selectedByDefault: false,
			}),
		];
		const finalize = createPersistedAccountRoutingFinalizer({
			preview: async () => {
				const next = previews.shift();
				if (!next) throw new Error("Missing preview fixture");
				return next;
			},
			apply,
		});

		const result = await finalize({
			accountId: "persisted-account-id",
			reviewed: [
				{ family: "opus", proposalId: "reviewed-opus" },
				{ family: "sonnet", proposalId: "reviewed-sonnet" },
			],
		});

		expect(apply).not.toHaveBeenCalled();
		expect(result.outcomes.map((outcome) => outcome.reason)).toEqual([
			"confidence-downgraded",
			"default-downgraded",
		]);
	});

	it("revalidates an already-effective reviewed proposal and reports replay success", async () => {
		const apply = mock(async ({ accountId, family }) =>
			effectiveRouting(family, accountId, "managed-rule"),
		);
		const finalize = createPersistedAccountRoutingFinalizer({
			preview: async ({ accountId, family }) =>
				preview({
					family,
					accountId,
					proposalId: "reviewed-proposal",
					existingRuleId: "managed-rule",
				}),
			apply,
		});

		const result = await finalize({
			accountId: "persisted-account-id",
			reviewed: [{ family: "opus", proposalId: "reviewed-proposal" }],
		});

		expect(apply).not.toHaveBeenCalled();
		expect(result.outcomes[0]).toMatchObject({
			status: "joined",
			reason: "already-effective",
		});
	});

	it("records a failed family and continues later reviewed work in order", async () => {
		const apply = mock(
			async ({
				accountId,
				family,
			}: {
				accountId: string;
				family: ComboFamily;
			}) => {
				if (family === "opus") {
					throw Object.assign(new Error("revision changed"), {
						code: "stale_routing_preview",
					});
				}
				return effectiveRouting(family, accountId);
			},
		);
		const finalize = createPersistedAccountRoutingFinalizer({
			preview: async ({ accountId, family }) =>
				preview({ family, accountId, proposalId: `reviewed-${family}` }),
			apply,
		});

		const result = await finalize({
			accountId: "persisted-account-id",
			reviewed: [
				{ family: "opus", proposalId: "reviewed-opus" },
				{ family: "sonnet", proposalId: "reviewed-sonnet" },
			],
		});

		expect(result.accountId).toBe("persisted-account-id");
		expect(
			result.outcomes.map(({ family, status, reason }) => ({
				family,
				status,
				reason,
			})),
		).toEqual([
			{ family: "opus", status: "action-required", reason: "stale-preview" },
			{ family: "sonnet", status: "joined", reason: "applied" },
		]);
	});
});
