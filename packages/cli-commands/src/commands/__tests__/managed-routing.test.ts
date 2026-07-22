import { describe, expect, it, mock } from "bun:test";
import type {
	AccountResponse,
	AccountRoutingOverview,
	ComboFamily,
	ComboRoutingPreviewResult,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import type { PromptAdapter } from "../../prompts/adapter";
import {
	createManagedAccountRoutingReviewedSelection,
	formatManagedRoutingReport,
	projectEffectiveRouting,
	projectManagedRoutingPreview,
	runManagedAccountRoutingApply,
	runManagedAccountRoutingPreview,
	runManagedRoutingApply,
	runManagedRoutingDetail,
	runManagedRoutingList,
	runManagedRoutingManualRollback,
	runManagedRoutingPreview,
} from "../managed-routing";
import type { ManagedRoutingControlPlane } from "../managed-routing-client";
import { ManagedRoutingHttpError } from "../managed-routing-client";

function account(id: string, name = id): AccountResponse {
	return {
		id,
		name,
		provider: "server-provider-label",
		priority: 7,
		paused: false,
		requiresReauth: false,
		tokenStatus: "valid",
		rateLimitStatus: "Active",
	} as AccountResponse;
}

function effectiveView(): EffectiveComboRoutingView {
	return {
		family: "opus",
		policy: {
			assignment: {
				family: "opus",
				combo_id: "combo-opus",
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			combo: {
				id: "combo-opus",
				name: "Opus route",
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [
				{
					id: "slot-manual",
					combo_id: "combo-opus",
					account_id: "account-manual",
					model: "manual-model",
					priority: 9,
					enabled: true,
				},
			],
			rules: [
				{
					id: "rule-opus",
					family: "opus",
					combo_id: "combo-opus",
					provider: "server-provider-label",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
			exclusions: [],
		},
		resolution: {
			family: "opus",
			combo_id: "combo-opus",
			active: true,
			reason: "included",
			members: [
				{
					id: "managed:account-member",
					account_id: "account-member",
					account_name: "Managed member",
					combo_id: "combo-opus",
					family: "opus",
					included: true,
					logical_model: "claude-opus-4-8",
					tier: 7,
					source: "managed",
					reason: "included",
					slot_id: null,
					rule_id: "rule-opus",
					availability: { available: false, reason: "model_exhausted" },
					identity_provisional: false,
				},
			],
			decisions: [
				{
					account_id: "account-outside",
					account_name: "Outside account",
					combo_id: "combo-opus",
					family: "opus",
					included: false,
					logical_model: "claude-opus-4-8",
					tier: 4,
					source: null,
					reason: "unsupported",
					slot_id: null,
					rule_id: "rule-opus",
					availability: { available: true, reason: "available" },
					identity_provisional: false,
				},
			],
		},
	};
}

function overview(): AccountRoutingOverview {
	const view = effectiveView();
	return {
		effective: [view],
		opportunities: [
			{
				account_id: "account-zero",
				family: "fable",
				proposal_id: "proposal-zero",
				combo_id: "combo-fable",
				managed_model: "claude-fable-4-5",
				tier_source: "account_priority",
				reason: "included",
			},
		],
	};
}

function preview(): ComboRoutingPreviewResult {
	const current = effectiveView();
	return {
		preview_id: "preview-1",
		scope: "family",
		family: "opus",
		managed_model: "claude-opus-4-8",
		effective: current,
		proposals: [
			{
				proposal_id: "proposal-1",
				family: "opus",
				combo_id: "combo-opus",
				provider: "server-provider-label",
				route_class: "oauth-subscription",
				existing_rule_id: null,
				managed_model: "claude-opus-4-8",
				tier_source: "account_priority",
				high_confidence: true,
				selected_by_default: true,
				reason: "included",
				proposed_effective: current,
				member_delta: [
					{
						key: "server-delta-key",
						status: "added",
						before: null,
						after: {
							key: "server-member-key",
							account_id: "account-member",
							candidate_id: "managed:account-member",
							identity_provisional: false,
							source: "managed",
							tier: 7,
							logical_model: "claude-opus-4-8",
							reason: "included",
						},
					},
				],
			},
		],
	};
}

function accountFamilyPreview(
	family: ComboFamily,
	previewId: string,
	proposalOverrides: Partial<
		ComboRoutingPreviewResult["proposals"][number]
	> = {},
): ComboRoutingPreviewResult {
	const base = preview();
	const managedModel =
		family === "fable" ? "claude-fable-4-5" : `claude-${family}-4-8`;
	const effective = {
		...base.effective,
		family,
		policy: {
			...base.effective.policy,
			assignment: {
				...base.effective.policy.assignment,
				family,
				managed_model: managedModel,
			},
		},
		resolution: {
			...base.effective.resolution,
			family,
		},
	};
	const proposal = base.proposals[0];
	if (!proposal) throw new Error("fixture requires a proposal");
	return {
		...base,
		preview_id: previewId,
		scope: "account",
		family,
		managed_model: managedModel,
		effective,
		proposals: [
			{
				...proposal,
				proposal_id: `proposal-${family}`,
				family,
				managed_model: managedModel,
				proposed_effective: effective,
				member_delta: proposal.member_delta.map((delta) => ({
					...delta,
					before: delta.before
						? { ...delta.before, logical_model: managedModel }
						: null,
					after: delta.after
						? { ...delta.after, logical_model: managedModel }
						: null,
				})),
				...proposalOverrides,
			},
		],
	};
}

function reviewedSelection(value: ComboRoutingPreviewResult) {
	const projected = projectManagedRoutingPreview(value);
	const proposal = projected.proposals[0];
	if (!proposal) throw new Error("fixture requires a projected proposal");
	return createManagedAccountRoutingReviewedSelection(
		projected,
		proposal.proposal_id,
	);
}

function client(overrides: Partial<ManagedRoutingControlPlane> = {}) {
	const value: ManagedRoutingControlPlane = {
		getAccounts: mock(async () => [
			account("account-member", "Managed member"),
			account("account-outside", "Outside account"),
			account("account-zero", "Zero membership"),
		]),
		getAccountRoutingOverview: mock(async () => overview()),
		listEffectiveRouting: mock(async () => [effectiveView()]),
		getEffectiveRouting: mock(async () => effectiveView()),
		previewAccountRouting: mock(async () => ({ families: [preview()] })),
		previewFamilyRouting: mock(async () => preview()),
		applyAccountRoutingProposal: mock(async () => effectiveView()),
		applyFamilyRoutingProposal: mock(async () => effectiveView()),
		rollbackFamilyToManual: mock(async (family: ComboFamily) => ({
			family,
			combo_id: `combo-${family}`,
			enabled: true,
			membership_mode: "manual",
			managed_model: `claude-${family}-managed`,
		})),
		...overrides,
	};
	return value;
}

function prompt(
	options: { selected?: string; confirmed?: boolean } = {},
): PromptAdapter {
	return {
		select: mock(async () => options.selected ?? "proposal-1"),
		input: mock(async () => "unused"),
		confirm: mock(async () => options.confirmed ?? true),
	};
}

describe("managed routing projections and reports", () => {
	it("copies only server-owned parity fields and omits injected secrets", () => {
		const view = effectiveView() as EffectiveComboRoutingView &
			Record<string, unknown>;
		view.access_token = "secret-access-token";
		(
			view.resolution.members[0] as unknown as Record<string, unknown>
		).custom_endpoint = "https://secret.invalid";
		(view.policy as unknown as Record<string, unknown>).model_mappings = {
			opus: "secret-physical-model",
		};

		const projected = projectEffectiveRouting(view);
		const rendered = JSON.stringify(projected);
		expect(projected.members[0]).toMatchObject({
			source: "managed",
			tier: 7,
			logical_model: "claude-opus-4-8",
			reason: "included",
			availability: { available: false, reason: "model_exhausted" },
		});
		expect(rendered).not.toContain("secret-access-token");
		expect(rendered).not.toContain("secret.invalid");
		expect(rendered).not.toContain("secret-physical-model");
		expect(rendered).not.toContain("model_mappings");
	});

	it("strict list merges accounts and routing by immutable ID, retaining a zero-membership account", async () => {
		const api = client();
		const report = await runManagedRoutingList(api);

		expect(api.getAccounts).toHaveBeenCalledTimes(1);
		expect(api.getAccountRoutingOverview).toHaveBeenCalledTimes(1);
		expect(report.accounts.map(({ account_id }) => account_id)).toEqual([
			"account-member",
			"account-outside",
			"account-zero",
		]);
		expect(report.accounts[0]?.memberships[0]).toMatchObject({
			family: "opus",
			source: "managed",
			tier: 7,
			reason: "included",
			availability: { reason: "model_exhausted" },
		});
		expect(report.accounts[1]?.decisions[0]).toMatchObject({
			family: "opus",
			reason: "unsupported",
		});
		expect(report.accounts[2]).toMatchObject({
			account_id: "account-zero",
			memberships: [],
			decisions: [],
			opportunities: [{ proposal_id: "proposal-zero", family: "fable" }],
		});
	});

	it("strict detail uses the same merged projection and errors for an unknown immutable ID", async () => {
		const api = client();
		const report = await runManagedRoutingDetail(api, "account-zero");
		expect(report.account.account_id).toBe("account-zero");
		expect(report.account.memberships).toEqual([]);

		await expect(runManagedRoutingDetail(api, "missing-id")).rejects.toThrow(
			/was not returned by the live server/i,
		);
	});

	it("preview preserves the server proposal and exact member delta without recomputing it", async () => {
		const report = await runManagedRoutingPreview(client(), {
			family: "opus",
			managedModel: "claude-opus-4-8",
		});
		expect(report.preview.proposals[0]?.member_delta).toEqual(
			preview().proposals[0]?.member_delta,
		);
		expect(report.preview.proposals[0]).toMatchObject({
			proposal_id: "proposal-1",
			provider: "server-provider-label",
			route_class: "oauth-subscription",
			tier_source: "account_priority",
			reason: "included",
		});
		const text = formatManagedRoutingReport(report, "text");
		expect(text).toContain(
			"after account=account-member candidate=managed:account-member source=managed tier=7 model=claude-opus-4-8 reason=included",
		);
	});

	it("text and JSON formatters expose parity fields but no injected secret material", async () => {
		const report = await runManagedRoutingList(client());
		const text = formatManagedRoutingReport(report, "text");
		const json = formatManagedRoutingReport(report, "json");
		expect(text).toContain("source=managed");
		expect(text).toContain("tier=7");
		expect(text).toContain("model=claude-opus-4-8");
		expect(text).toContain("reason=included");
		expect(text).toContain("availability=model_exhausted");
		expect(json).toContain('"account_id": "account-zero"');
		expect(text).not.toContain("customEndpoint");
		expect(json).not.toContain("modelMappings");
	});
});

describe("managed routing mutation safety", () => {
	it("requires every identifier, model, and explicit confirmation in noninteractive and JSON modes", async () => {
		for (const automated of [
			{ nonInteractive: true },
			{ json: true, prompt: prompt() },
		]) {
			const api = client();
			await expect(
				runManagedRoutingApply(api, {
					family: "opus",
					...automated,
				}),
			).rejects.toThrow(/previewId.*proposalId.*managedModel.*confirmed/i);
			expect(api.previewFamilyRouting).toHaveBeenCalledTimes(0);
			expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
			if (automated.prompt) {
				expect(automated.prompt.select).toHaveBeenCalledTimes(0);
				expect(automated.prompt.confirm).toHaveBeenCalledTimes(0);
			}
		}
	});

	it("never auto-picks the server default in interactive mode", async () => {
		const api = client();
		const adapter = prompt({ selected: "proposal-1", confirmed: true });
		const order: string[] = [];
		const review = mock(async (report: unknown) => {
			order.push("review");
			expect(JSON.stringify(report)).toContain("server-delta-key");
		});
		adapter.select = mock(async () => {
			order.push("select");
			return "proposal-1";
		});
		adapter.confirm = mock(async () => {
			order.push("confirm");
			return true;
		});
		api.applyFamilyRoutingProposal = mock(async () => {
			order.push("apply");
			return effectiveView();
		});
		const report = await runManagedRoutingApply(api, {
			family: "opus",
			prompt: adapter,
			review,
		});

		expect(order).toEqual(["review", "select", "confirm", "apply"]);
		expect(review).toHaveBeenCalledTimes(1);
		expect(adapter.select).toHaveBeenCalledTimes(1);
		expect(adapter.confirm).toHaveBeenCalledTimes(1);
		expect(api.previewFamilyRouting).toHaveBeenCalledTimes(1);
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(1);
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledWith({
			family: "opus",
			previewId: "preview-1",
			proposalId: "proposal-1",
			managedModel: "claude-opus-4-8",
		});
		expect(report.status).toBe("applied");
	});

	it("rejects partial explicit preview tuples instead of mixing revisions", async () => {
		for (const partial of [
			{ previewId: "preview-stale" },
			{ proposalId: "proposal-stale", managedModel: "claude-opus-4-8" },
		]) {
			const api = client();
			await expect(
				runManagedRoutingApply(api, {
					family: "opus",
					prompt: prompt(),
					review: mock(async () => {}),
					...partial,
				}),
			).rejects.toThrow(/partial.*previewId.*proposalId.*managedModel/i);
			expect(api.previewFamilyRouting).toHaveBeenCalledTimes(0);
			expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
		}
	});

	it("requires a full preview review callback before interactive selection or mutation", async () => {
		const api = client();
		const adapter = prompt();
		await expect(
			runManagedRoutingApply(api, {
				family: "opus",
				prompt: adapter,
			}),
		).rejects.toThrow(/review.*callback/i);
		expect(api.previewFamilyRouting).toHaveBeenCalledTimes(0);
		expect(adapter.select).toHaveBeenCalledTimes(0);
		expect(adapter.confirm).toHaveBeenCalledTimes(0);
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
	});

	it("decline paths perform no write", async () => {
		const api = client();
		const apply = await runManagedRoutingApply(api, {
			family: "opus",
			previewId: "preview-1",
			proposalId: "proposal-1",
			managedModel: "claude-opus-4-8",
			confirmed: false,
			nonInteractive: true,
		});
		const rollback = await runManagedRoutingManualRollback(api, {
			family: "opus",
			confirmed: false,
			nonInteractive: true,
		});

		expect(apply.status).toBe("declined");
		expect(rollback.status).toBe("declined");
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);
	});

	it("propagates stale and empty server failures after exactly one apply write and never rolls back", async () => {
		for (const code of [
			"stale_routing_preview",
			"managed_route_empty",
		] as const) {
			const apply = mock(async () => {
				throw new ManagedRoutingHttpError({ status: 409, code });
			});
			const api = client({ applyFamilyRoutingProposal: apply });
			await expect(
				runManagedRoutingApply(api, {
					family: "opus",
					previewId: "preview-1",
					proposalId: "proposal-1",
					managedModel: "claude-opus-4-8",
					confirmed: true,
					nonInteractive: true,
				}),
			).rejects.toMatchObject({ code });
			expect(apply).toHaveBeenCalledTimes(1);
			expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);
		}
	});

	it("manual rollback requires confirmation and returns only the server assignment projection", async () => {
		const api = client();
		await expect(
			runManagedRoutingManualRollback(api, {
				family: "opus",
				nonInteractive: true,
			}),
		).rejects.toThrow(/confirmed/i);
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);

		const report = await runManagedRoutingManualRollback(api, {
			family: "opus",
			confirmed: true,
			nonInteractive: true,
		});
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(1);
		expect(report).toMatchObject({
			kind: "manual-rollback",
			status: "applied",
			assignment: { membership_mode: "manual" },
		});
	});

	it("previews a persisted post-create account without inventing draft metadata", async () => {
		const api = client();
		const report = await runManagedAccountRoutingPreview(api, {
			accountId: "account-created",
		});

		expect(api.previewAccountRouting).toHaveBeenCalledWith({
			accountId: "account-created",
		});
		expect(report.kind).toBe("account-preview");
		expect(report.previews[0]?.preview_id).toBe("preview-1");
	});

	it("keeps account-scoped auto-apply unavailable in noninteractive and JSON modes", async () => {
		const selection = reviewedSelection(
			accountFamilyPreview("opus", "preview-reviewed"),
		);
		for (const automated of [
			{ nonInteractive: true },
			{ json: true, prompt: prompt() },
		]) {
			const api = client();
			await expect(
				runManagedAccountRoutingApply(api, {
					accountId: "account-created",
					selections: [selection],
					review: mock(async () => {}),
					...automated,
				}),
			).rejects.toThrow(/interactive.*required/i);
			expect(api.previewAccountRouting).toHaveBeenCalledTimes(0);
			expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
		}
	});

	it("refreshes and completes each account family cycle before the next global revision", async () => {
		const events: string[] = [];
		let revision = 1;
		const previewAccountRouting = mock(
			async ({ family }: { family?: ComboFamily }) => {
				if (!family) throw new Error("family-scoped refresh required");
				events.push(`preview:${family}:rev${revision}`);
				return accountFamilyPreview(family, `rev${revision}-${family}`);
			},
		);
		const applyAccountRoutingProposal = mock(
			async ({
				family,
				previewId,
			}: {
				family: ComboFamily;
				previewId: string;
			}) => {
				events.push(`apply:${family}:${previewId}`);
				expect(previewId).toBe(`rev${revision}-${family}`);
				revision += 1;
				return { ...effectiveView(), family } as EffectiveComboRoutingView;
			},
		);
		const api = client({
			previewAccountRouting:
				previewAccountRouting as ManagedRoutingControlPlane["previewAccountRouting"],
			applyAccountRoutingProposal:
				applyAccountRoutingProposal as ManagedRoutingControlPlane["applyAccountRoutingProposal"],
		});
		const adapter = prompt();
		adapter.confirm = mock(async (message) => {
			const family = message.includes("opus") ? "opus" : "fable";
			events.push(`confirm:${family}`);
			return true;
		});

		const report = await runManagedAccountRoutingApply(api, {
			accountId: "account-created",
			selections: [
				reviewedSelection(accountFamilyPreview("opus", "reviewed-opus")),
				reviewedSelection(accountFamilyPreview("fable", "reviewed-fable")),
			],
			prompt: adapter,
			review: mock(async (reviewed) => {
				const current = reviewed.previews[0];
				if (!current) throw new Error("refreshed preview required");
				events.push(`review:${current.family}:${current.preview_id}`);
			}),
		});

		expect(events).toEqual([
			"preview:opus:rev1",
			"review:opus:rev1-opus",
			"confirm:opus",
			"apply:opus:rev1-opus",
			"preview:fable:rev2",
			"review:fable:rev2-fable",
			"confirm:fable",
			"apply:fable:rev2-fable",
		]);
		expect(previewAccountRouting).toHaveBeenCalledTimes(2);
		expect(applyAccountRoutingProposal).toHaveBeenCalledTimes(2);
		expect(report).toMatchObject({
			kind: "account-apply",
			status: "applied",
			account_id: "account-created",
			stopped: null,
		});
		expect(report.results.map(({ family }) => family)).toEqual([
			"opus",
			"fable",
		]);
	});

	it("fails closed when the explicitly reviewed proposal disappears", async () => {
		const baseline = accountFamilyPreview("opus", "reviewed-opus");
		const refreshed = {
			...accountFamilyPreview("opus", "fresh-opus"),
			proposals: [],
		};
		const api = client({
			previewAccountRouting: mock(async () => refreshed),
		});
		const adapter = prompt();
		const review = mock(async () => {});

		const report = await runManagedAccountRoutingApply(api, {
			accountId: "account-created",
			selections: [reviewedSelection(baseline)],
			prompt: adapter,
			review,
		});

		expect(report).toMatchObject({
			status: "failed_closed",
			results: [],
			stopped: { family: "opus", reason: "proposal_missing" },
		});
		expect(review).toHaveBeenCalledTimes(1);
		expect(adapter.confirm).toHaveBeenCalledTimes(0);
		expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
	});

	it("fails closed when confidence, reason, or exact member delta changes after review", async () => {
		const baseline = accountFamilyPreview("opus", "reviewed-opus");
		const baseProposal = baseline.proposals[0];
		if (!baseProposal) throw new Error("fixture requires a proposal");
		const downgraded = [
			{ high_confidence: false },
			{ reason: "unsupported" as const },
			{
				member_delta: baseProposal.member_delta.map((delta) => ({
					...delta,
					status: "removed" as const,
					after: null,
				})),
			},
		];

		for (const proposalOverride of downgraded) {
			const api = client({
				previewAccountRouting: mock(async () =>
					accountFamilyPreview("opus", "fresh-opus", proposalOverride),
				),
			});
			const adapter = prompt();
			const report = await runManagedAccountRoutingApply(api, {
				accountId: "account-created",
				selections: [reviewedSelection(baseline)],
				prompt: adapter,
				review: mock(async () => {}),
			});

			expect(report).toMatchObject({
				status: "failed_closed",
				results: [],
				stopped: {
					family: "opus",
					reason: "proposal_materially_changed",
				},
			});
			expect(adapter.confirm).toHaveBeenCalledTimes(0);
			expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
		}
	});

	it("reports a declined first family and partial success after a later decline honestly", async () => {
		const selections = [
			reviewedSelection(accountFamilyPreview("opus", "reviewed-opus")),
			reviewedSelection(accountFamilyPreview("fable", "reviewed-fable")),
		];
		const freshClient = () =>
			client({
				previewAccountRouting: mock(
					async ({ family }: { family?: ComboFamily }) =>
						accountFamilyPreview(family ?? "opus", `fresh-${family}`),
				),
			});
		const reviewDeclinedApi = freshClient();
		const reviewDeclinedPrompt = prompt();
		const reviewDeclined = await runManagedAccountRoutingApply(
			reviewDeclinedApi,
			{
				accountId: "account-created",
				selections,
				prompt: reviewDeclinedPrompt,
				review: mock(async () => false),
			},
		);
		expect(reviewDeclined).toMatchObject({
			status: "declined",
			results: [],
			stopped: { family: "opus", reason: "review_declined" },
		});
		expect(reviewDeclinedPrompt.confirm).toHaveBeenCalledTimes(0);
		expect(reviewDeclinedApi.applyAccountRoutingProposal).toHaveBeenCalledTimes(
			0,
		);

		const declinedPrompt = prompt({ confirmed: false });
		const declinedApi = freshClient();
		const declined = await runManagedAccountRoutingApply(declinedApi, {
			accountId: "account-created",
			selections,
			prompt: declinedPrompt,
			review: mock(async () => {}),
		});
		expect(declined).toMatchObject({
			status: "declined",
			results: [],
			stopped: { family: "opus", reason: "confirmation_declined" },
		});
		expect(declinedApi.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);

		const confirmations = [true, false];
		const partialPrompt = prompt();
		partialPrompt.confirm = mock(async () => confirmations.shift() ?? false);
		const partialApi = freshClient();
		const partial = await runManagedAccountRoutingApply(partialApi, {
			accountId: "account-created",
			selections,
			prompt: partialPrompt,
			review: mock(async () => {}),
		});
		expect(partial).toMatchObject({
			status: "partial",
			results: [{ family: "opus" }],
			stopped: { family: "fable", reason: "confirmation_declined" },
		});
		const rendered = formatManagedRoutingReport(partial, "text");
		expect(rendered).toContain("Applied 1 reviewed");
		expect(rendered).toContain("stopped at fable");
		expect(rendered).not.toContain("no write was sent");
		expect(partialApi.applyAccountRoutingProposal).toHaveBeenCalledTimes(1);
	});
});
