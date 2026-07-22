import { describe, expect, it, mock } from "bun:test";
import type {
	AccountRoutingOverview,
	ComboFamily,
	ComboMembershipDecisionView,
	ComboRoutingMemberDelta,
	ComboRoutingPreviewResult,
	ComboRoutingProposalPreview,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import {
	type AccountSetupMode,
	type AccountSetupRoutingMetadata,
	accountSetupRoutingMetadata,
	accountSetupRoutingReviewIsCurrent,
	buildAccountRoutingDraft,
	buildAccountSetupRoutingDraft,
	defaultRoutingSelections,
	getAccountFamilyRoutingStates,
	invalidateAccountSetupRoutingReview,
	missingAccountIdentityOutcomes,
	reconcileAccountRoutingSelections,
	routingOutcomeReasonLabel,
	routingSelectionKey,
} from "./account-routing";

describe("account routing outcome labels", () => {
	it("keeps a server default downgrade distinct and actionable", () => {
		expect(routingOutcomeReasonLabel("default-downgraded")).toBe(
			"The reviewed default changed; review the current routing proposal",
		);
	});
});

function routingView(
	family: ComboFamily,
	overrides: {
		members?: EffectiveComboMemberView[];
		decisions?: ComboMembershipDecisionView[];
		mode?: "manual" | "managed";
		managedModel?: string | null;
		rules?: EffectiveComboRoutingView["policy"]["rules"];
	} = {},
): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: `combo-${family}`,
				enabled: true,
				membership_mode: overrides.mode ?? "manual",
				managed_model: overrides.managedModel ?? null,
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
			rules: overrides.rules ?? [],
			exclusions: [],
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

function managedMember(
	family: ComboFamily,
	overrides: Partial<EffectiveComboMemberView> = {},
): EffectiveComboMemberView {
	return {
		id: `candidate-${family}`,
		account_id: "persisted-account",
		account_name: "Fourth account",
		combo_id: `combo-${family}`,
		family,
		included: true,
		logical_model: `claude-${family}-latest`,
		tier: 0,
		source: "managed",
		reason: "included",
		slot_id: null,
		rule_id: `rule-${family}`,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
		...overrides,
	};
}

function decision(
	family: ComboFamily,
	reason: ComboMembershipDecisionView["reason"],
	overrides: Partial<ComboMembershipDecisionView> = {},
): ComboMembershipDecisionView {
	return {
		account_id: "persisted-account",
		account_name: "Fourth account",
		combo_id: `combo-${family}`,
		family,
		included: false,
		logical_model: `claude-${family}-latest`,
		tier: null,
		source: null,
		reason,
		slot_id: null,
		rule_id: null,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
		...overrides,
	};
}

function preview(
	family: ComboFamily,
	options: {
		previewId?: string;
		proposalId?: string;
		highConfidence?: boolean;
		selectedByDefault?: boolean;
		existingRuleId?: string | null;
		effective?: EffectiveComboRoutingView;
		proposedEffective?: EffectiveComboRoutingView;
		memberDelta?: ComboRoutingMemberDelta[];
	} = {},
): ComboRoutingPreviewResult {
	const effective = options.effective ?? routingView(family);
	const proposal: ComboRoutingProposalPreview = {
		proposal_id: options.proposalId ?? `proposal-${family}`,
		family,
		combo_id: `combo-${family}`,
		provider: "anthropic",
		route_class: "oauth-subscription",
		existing_rule_id: options.existingRuleId ?? null,
		managed_model: `claude-${family}-latest`,
		tier_source: "account_priority",
		high_confidence: options.highConfidence ?? true,
		selected_by_default: options.selectedByDefault ?? true,
		reason: "included",
		proposed_effective: options.proposedEffective ?? effective,
		member_delta: options.memberDelta ?? [],
	};
	return {
		preview_id: options.previewId ?? `draft-preview-${family}`,
		scope: "account",
		family,
		managed_model: proposal.managed_model,
		proposals: [proposal],
		effective,
	};
}

function routingOverview(
	effective: EffectiveComboRoutingView[],
	opportunities: AccountRoutingOverview["opportunities"] = [],
): AccountRoutingOverview {
	return { effective, opportunities };
}

describe("account routing draft and selection", () => {
	it("maps every setup mode to an explicit provider, route class, and billing class", () => {
		const expected: Record<AccountSetupMode, AccountSetupRoutingMetadata> = {
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
			minimax: {
				provider: "minimax",
				routeClass: "api-key",
				billingType: "api",
			},
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
			nanogpt: {
				provider: "nanogpt",
				routeClass: "api-key",
				billingType: "api",
			},
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
		};

		for (const [mode, metadata] of Object.entries(expected)) {
			expect(accountSetupRoutingMetadata(mode as AccountSetupMode)).toEqual(
				metadata,
			);
		}
	});

	it("builds setup preview drafts from a strict non-secret whitelist", () => {
		const draft = buildAccountSetupRoutingDraft({
			mode: "anthropic-compatible",
			priority: 3,
			modelMappings: { fable: "provider/fable" },
			name: "must-not-leak",
			apiKey: "must-not-leak",
			customEndpoint: "https://secret.example",
		});

		expect(draft).toEqual({
			provider: "anthropic-compatible",
			priority: 3,
			auth_shape: "api-key",
			billing_type: "api",
			model_mappings: { fable: "provider/fable" },
		});
		const serialized = JSON.stringify(draft);
		expect(serialized).not.toContain("must-not-leak");
		expect(serialized).not.toContain("secret.example");
	});

	it("blocks creation before review and invalidates consent when the draft changes", () => {
		const review = { previewDraftKey: "draft-a", reviewed: true };

		expect(accountSetupRoutingReviewIsCurrent(review, "draft-a")).toBeTrue();
		expect(
			accountSetupRoutingReviewIsCurrent(
				{ previewDraftKey: "draft-a", reviewed: false },
				"draft-a",
			),
		).toBeFalse();
		expect(accountSetupRoutingReviewIsCurrent(review, "draft-b")).toBeFalse();
		expect(invalidateAccountSetupRoutingReview(review, "draft-b")).toEqual({
			previewDraftKey: null,
			reviewed: false,
		});
	});

	it("turns a missing created identity into visible action-required outcomes", () => {
		expect(
			missingAccountIdentityOutcomes([
				{ family: "opus", proposalId: "proposal-opus" },
				{ family: "fable", proposalId: "proposal-fable" },
			]),
		).toEqual([
			expect.objectContaining({
				family: "opus",
				status: "action-required",
				reason: "missing-account-id",
			}),
			expect.objectContaining({
				family: "fable",
				status: "action-required",
				reason: "missing-account-id",
			}),
		]);
	});

	it("builds a secret-free draft with the Fable mapping intact", () => {
		const draft = buildAccountRoutingDraft({
			provider: "anthropic",
			routeClass: "oauth-subscription",
			priority: 0,
			billingType: "plan",
			modelMappings: {
				fable: "claude-fable-5",
				opus: "claude-opus-4-8",
			},
			apiKey: "must-not-leak",
			api_key: "must-not-leak",
			accessToken: "must-not-leak",
			access_token: "must-not-leak",
			refreshToken: "must-not-leak",
			refresh_token: "must-not-leak",
			customEndpoint: "https://secret.example",
			custom_endpoint: "https://secret.example",
			name: "mutable-name-must-not-be-a-selector",
		});

		expect(draft).toEqual({
			provider: "anthropic",
			priority: 0,
			auth_shape: "oauth-subscription",
			billing_type: "plan",
			model_mappings: {
				fable: "claude-fable-5",
				opus: "claude-opus-4-8",
			},
		});
		const serialized = JSON.stringify(draft);
		for (const forbidden of [
			"apiKey",
			"api_key",
			"accessToken",
			"access_token",
			"refreshToken",
			"refresh_token",
			"customEndpoint",
			"custom_endpoint",
			"name",
			"must-not-leak",
			"secret.example",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("preselects only proposals that are both high-confidence and server-defaulted", () => {
		const safe = preview("opus");
		const ambiguous = preview("fable", { highConfidence: false });
		const reviewedOnly = preview("sonnet", { selectedByDefault: false });

		expect(defaultRoutingSelections([safe, ambiguous, reviewedOnly])).toEqual([
			{ family: "opus", proposalId: "proposal-opus" },
		]);
		expect(
			routingSelectionKey({ family: "opus", proposalId: "proposal-opus" }),
		).toBe("opus:proposal-opus");
	});
});

describe("persisted account routing reconciliation", () => {
	it("re-previews and applies two selected families sequentially with fresh preview IDs", async () => {
		const events: string[] = [];
		const persistedPreviews = new Map<ComboFamily, ComboRoutingPreviewResult>([
			[
				"opus",
				preview("opus", {
					previewId: "persisted-preview-opus",
					proposalId: "proposal-opus",
				}),
			],
			[
				"fable",
				preview("fable", {
					previewId: "persisted-preview-fable",
					proposalId: "proposal-fable",
				}),
			],
		]);
		const previewRouting = mock(
			async (subject: { account_id: string }, family: ComboFamily) => {
				events.push(`preview:${family}:${subject.account_id}`);
				return persistedPreviews.get(family) as ComboRoutingPreviewResult;
			},
		);
		const applyRoutingProposal = mock(
			async (params: {
				family: ComboFamily;
				previewId: string;
				proposalId: string;
				accountId: string;
				managedModel: string;
			}) => {
				events.push(`apply:${params.family}:${params.previewId}`);
				return routingView(params.family, {
					members: [managedMember(params.family)],
				});
			},
		);

		const outcomes = await reconcileAccountRoutingSelections({
			accountId: "persisted-account",
			selections: [
				{ family: "opus", proposalId: "proposal-opus" },
				{ family: "fable", proposalId: "proposal-fable" },
			],
			client: { previewRouting, applyRoutingProposal },
		});

		expect(events).toEqual([
			"preview:opus:persisted-account",
			"apply:opus:persisted-preview-opus",
			"preview:fable:persisted-account",
			"apply:fable:persisted-preview-fable",
		]);
		expect(applyRoutingProposal.mock.calls.map(([params]) => params)).toEqual([
			{
				family: "opus",
				previewId: "persisted-preview-opus",
				proposalId: "proposal-opus",
				accountId: "persisted-account",
				managedModel: "claude-opus-latest",
			},
			{
				family: "fable",
				previewId: "persisted-preview-fable",
				proposalId: "proposal-fable",
				accountId: "persisted-account",
				managedModel: "claude-fable-latest",
			},
		]);
		expect(outcomes.map(({ status, reason }) => ({ status, reason }))).toEqual([
			{ status: "joined", reason: "applied" },
			{ status: "joined", reason: "applied" },
		]);
	});

	it("requires action when a persisted proposal is missing, downgraded, or stale", async () => {
		const applyRoutingProposal = mock(async () => {
			throw Object.assign(new Error("Routing preview is stale"), {
				code: "stale_routing_preview",
			});
		});
		const previews: Record<ComboFamily, ComboRoutingPreviewResult> = {
			opus: { ...preview("opus"), proposals: [] },
			fable: preview("fable", { highConfidence: false }),
			sonnet: preview("sonnet"),
			haiku: preview("haiku"),
		};

		const outcomes = await reconcileAccountRoutingSelections({
			accountId: "persisted-account",
			selections: [
				{ family: "opus", proposalId: "proposal-opus" },
				{ family: "fable", proposalId: "proposal-fable" },
				{ family: "sonnet", proposalId: "proposal-sonnet" },
			],
			client: {
				previewRouting: async (_subject, family) => previews[family],
				applyRoutingProposal,
			},
		});

		expect(outcomes.map(({ status, reason }) => ({ status, reason }))).toEqual([
			{ status: "action-required", reason: "proposal-missing" },
			{ status: "action-required", reason: "confidence-downgraded" },
			{ status: "action-required", reason: "stale-preview" },
		]);
		expect(applyRoutingProposal).toHaveBeenCalledTimes(1);
	});

	it("reports an existing enabled managed rule as joined without writing", async () => {
		const family: ComboFamily = "opus";
		const rule = {
			id: "rule-opus",
			family,
			combo_id: "combo-opus",
			provider: "anthropic",
			route_class: "oauth-subscription" as const,
			enabled: true,
			created_at: 1,
			updated_at: 1,
		};
		const effective = routingView(family, {
			mode: "managed",
			managedModel: "claude-opus-latest",
			rules: [rule],
			members: [managedMember(family, { rule_id: rule.id })],
		});
		const applyRoutingProposal = mock(async () => effective);

		const outcomes = await reconcileAccountRoutingSelections({
			accountId: "persisted-account",
			selections: [{ family, proposalId: "proposal-opus" }],
			client: {
				previewRouting: async () =>
					preview(family, {
						previewId: "fresh-preview",
						proposalId: "proposal-opus",
						existingRuleId: rule.id,
						effective,
					}),
				applyRoutingProposal,
			},
		});

		expect(outcomes[0]?.status).toBe("joined");
		expect(outcomes[0]?.reason).toBe("already-effective");
		expect(applyRoutingProposal).not.toHaveBeenCalled();
	});
});

describe("authoritative account family card state", () => {
	it("uses only server members and decisions for source, tier, reasons, and availability", () => {
		const states = getAccountFamilyRoutingStates(
			"persisted-account",
			routingOverview([
				routingView("opus", {
					members: [
						managedMember("opus", {
							source: "manual",
							tier: 5,
							slot_id: "slot-opus",
							rule_id: null,
							availability: { available: false, reason: "paused" },
						}),
					],
				}),
				routingView("fable", {
					members: [
						managedMember("fable", {
							availability: { available: false, reason: "model_exhausted" },
						}),
					],
				}),
				routingView("sonnet", {
					decisions: [decision("sonnet", "excluded")],
				}),
				routingView("haiku", {
					decisions: [decision("haiku", "unsupported")],
				}),
			]),
		);

		expect(states).toEqual([
			expect.objectContaining({
				family: "opus",
				membershipLabel: "Manual",
				tier: 5,
				reasonLabel: "Included",
				availabilityLabel: "Paused; membership is unchanged",
			}),
			expect.objectContaining({
				family: "fable",
				membershipLabel: "Managed",
				tier: 0,
				availabilityLabel: "Model usage exhausted; membership is unchanged",
			}),
			expect.objectContaining({
				family: "sonnet",
				membershipLabel: null,
				reasonLabel: "Excluded from managed routing",
			}),
			expect.objectContaining({
				family: "haiku",
				membershipLabel: null,
				reasonLabel: "Logical model unsupported",
			}),
		]);
	});

	it("uses an exact immutable account ID opportunity only as an outside-route warning", () => {
		const exactAccountId = "acct:opaque/Δ-01";
		const lookalikeAccountId = "acct:opaque/Δ-010";
		const current = routingView("opus", {
			decisions: [
				decision("opus", "unknown", {
					account_id: exactAccountId,
					availability: { available: false, reason: "rate_limited" },
				}),
				decision("opus", "unknown", {
					account_id: lookalikeAccountId,
				}),
			],
		});
		const overview = routingOverview(
			[current],
			[
				{
					account_id: exactAccountId,
					family: "opus",
					proposal_id: "proposal-opus",
					combo_id: "combo-opus",
					managed_model: "claude-opus-latest",
					tier_source: "account_priority",
					reason: "included",
				},
			],
		);

		const states = getAccountFamilyRoutingStates(exactAccountId, overview);
		const lookalikeStates = getAccountFamilyRoutingStates(
			lookalikeAccountId,
			overview,
		);

		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({
			membershipLabel: null,
			tier: null,
			reason: "unknown",
			availability: "rate_limited",
			managedRouteAvailable: true,
		});
		expect(lookalikeStates[0]).toMatchObject({
			membershipLabel: null,
			managedRouteAvailable: false,
		});
	});

	it("does not infer opportunities from low-confidence or ineligible effective decisions omitted by the server", () => {
		const states = getAccountFamilyRoutingStates(
			"persisted-account",
			routingOverview([
				routingView("fable", {
					decisions: [decision("fable", "ambiguous")],
				}),
				routingView("sonnet", {
					decisions: [decision("sonnet", "unsupported")],
				}),
				routingView("haiku", {
					decisions: [decision("haiku", "new_billing_class")],
				}),
			]),
		);

		expect(states).toHaveLength(3);
		expect(states.every((state) => !state.managedRouteAvailable)).toBeTrue();
		expect(states.every((state) => state.membershipLabel === null)).toBeTrue();
	});
});
