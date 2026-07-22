import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers/usage-cache";
import type {
	Account,
	ComboFamilyPolicyChanges,
	ComboRoutingPolicySnapshot,
} from "@better-ccflare/types";
import { createServerOwnedAccountRoutingFinalizer } from "../../services/account-routing-operations";
import {
	createAccountRoutingOverviewHandler,
	createEffectiveRoutingHandler,
	createFamilyAssignHandler,
	createMembershipExclusionCreateHandler,
	createMembershipExclusionRestoreHandler,
	createRoutingApplyHandler,
	createRoutingPreviewHandler,
} from "../combos";

const dependencies = {
	deriveRouteClass(current: Account) {
		if (current.provider === "anthropic" && current.refresh_token) {
			return "oauth-subscription" as const;
		}
		if (current.api_key) return "api-key" as const;
		return null;
	},
	resolveCapability() {
		return {
			status: "supported" as const,
			provenance: "provider_default" as const,
			reason: "included" as const,
		};
	},
};

function account(id: string, priority = 0): Account {
	return {
		id,
		name: `Account ${id}`,
		provider: "anthropic",
		api_key: null,
		refresh_token: `secret-${id}`,
		access_token: `access-${id}`,
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
		priority,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://must-not-leak.example",
		model_mappings: JSON.stringify({ opus: "private-physical-model" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: "plan",
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function snapshot(): ComboRoutingPolicySnapshot {
	return {
		assignment: {
			family: "opus",
			combo_id: "combo-1",
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: {
			id: "combo-1",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 1,
		},
		slots: ["a", "b"].map((id, index) => ({
			id: `slot-${id}`,
			combo_id: "combo-1",
			account_id: id,
			model: "claude-opus-4-8",
			priority: index,
			enabled: true,
		})),
		rules: [],
		exclusions: [],
	};
}

function request(path: string, body: unknown, method = "POST"): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function rawRequest(path: string, body: string, method = "POST"): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body,
	});
}

function staleRoutingRevisionError(): Error & {
	code: "stale_routing_preview";
} {
	return Object.assign(
		new Error("Routing policy revision changed before apply"),
		{
			code: "stale_routing_preview" as const,
		},
	);
}

function statefulDb() {
	let policy = snapshot();
	let routingRevision = 0;
	let beforeNextApply: (() => void) | undefined;
	const accounts = [account("a", 0), account("b", 1), account("new", 0)];
	const applyFamilyPolicyChanges = mock(
		async (changes: ComboFamilyPolicyChanges) => {
			const interleave = beforeNextApply;
			beforeNextApply = undefined;
			interleave?.();
			if (
				changes.expected_revision !== undefined &&
				changes.expected_revision !== routingRevision
			) {
				throw staleRoutingRevisionError();
			}
			if (changes.assignment) {
				policy = {
					...policy,
					assignment: { ...policy.assignment, ...changes.assignment },
				};
			}
			for (const rule of changes.create_rules ?? []) {
				policy.rules.push({
					id: rule.id ?? "created-rule",
					family: changes.family,
					combo_id: rule.combo_id,
					provider: rule.provider,
					route_class: rule.route_class,
					enabled: rule.enabled !== false,
					created_at: 2,
					updated_at: 2,
				});
			}
			for (const update of changes.update_rules ?? []) {
				policy.rules = policy.rules.map((rule) =>
					rule.id === update.id ? { ...rule, ...update.fields } : rule,
				);
			}
			for (const exclusion of changes.create_exclusions ?? []) {
				policy.exclusions.push({
					id: exclusion.id ?? "created-exclusion",
					family: changes.family,
					combo_id: exclusion.combo_id,
					account_id: exclusion.account_id,
					created_at: 3,
				});
			}
			for (const exclusionId of changes.delete_exclusion_ids ?? []) {
				policy.exclusions = policy.exclusions.filter(
					(exclusion) => exclusion.id !== exclusionId,
				);
			}
			routingRevision++;
			return {
				family: changes.family,
				applied: true as const,
				mutation_count: 1,
			};
		},
	);
	const restoreComboMembership = mock(
		async (_family: string, _comboId: string, accountId: string) => {
			policy.exclusions = policy.exclusions.filter(
				(exclusion) => exclusion.account_id !== accountId,
			);
		},
	);
	return {
		dbOps: {
			getRoutingPolicyRevision: mock(async () => routingRevision),
			getCombo: mock(async (id: string) =>
				id === policy.combo?.id ? structuredClone(policy.combo) : null,
			),
			getComboSlots: mock(async (id: string) =>
				id === policy.combo?.id ? structuredClone(policy.slots) : [],
			),
			getComboEnrollmentRules: mock(async (_family: string, id: string) =>
				id === policy.combo?.id ? structuredClone(policy.rules) : [],
			),
			getComboMembershipExclusions: mock(async (_family: string, id: string) =>
				id === policy.combo?.id ? structuredClone(policy.exclusions) : [],
			),
			getComboRoutingPolicy: mock(async () => structuredClone(policy)),
			getAllAccounts: mock(async () => structuredClone(accounts)),
			getAccount: mock(async (id: string) =>
				structuredClone(accounts.find((current) => current.id === id) ?? null),
			),
			applyFamilyPolicyChanges,
			setFamilyPolicy: mock(async (_family: string, fields: object) => {
				policy = {
					...policy,
					assignment: { ...policy.assignment, ...fields },
				};
				return structuredClone(policy.assignment);
			}),
			setFamilyCombo: mock(
				async (_family: string, comboId: string | null, enabled: boolean) => {
					policy.assignment.combo_id = comboId;
					policy.assignment.enabled = enabled;
				},
			),
			createComboMembershipExclusion: mock(async (input: object) => {
				const created = {
					id: "created-exclusion",
					created_at: 3,
					...(input as Record<string, unknown>),
				};
				policy.exclusions.push(created as never);
				return created;
			}),
			restoreComboMembership,
		} as unknown as DatabaseOperations,
		applyFamilyPolicyChanges,
		restoreComboMembership,
		mutatePolicy(mutator: (current: ComboRoutingPolicySnapshot) => void) {
			mutator(policy);
			routingRevision++;
		},
		mutateAccount(id: string, fields: Partial<Account>) {
			const current = accounts.find((account) => account.id === id);
			if (current) {
				Object.assign(current, fields);
				routingRevision++;
			}
		},
		addAccount(current: Account) {
			accounts.push(current);
			routingRevision++;
		},
		interleaveBeforeNextApply(mutator: () => void) {
			beforeNextApply = mutator;
		},
	};
}

describe("managed routing HTTP control plane", () => {
	it("builds one coherent account-routing overview for ten accounts and two families", async () => {
		const accounts = Array.from({ length: 10 }, (_, index) =>
			account(
				index < 2 ? String.fromCharCode(97 + index) : `outside-${index}`,
				index,
			),
		);
		const families = ["opus", "fable"] as const;
		const getAllAccounts = mock(async () => structuredClone(accounts));
		const getFamilyAssignments = mock(async () =>
			families.map((family) => ({ ...snapshot().assignment, family })),
		);
		const getComboRoutingPolicy = mock(async (family: "opus" | "fable") => ({
			...snapshot(),
			assignment: { ...snapshot().assignment, family },
			slots: snapshot().slots.map((slot) => ({
				...slot,
				model: family === "opus" ? "claude-opus-4-8" : "claude-fable-5",
			})),
		}));
		const dbOps = {
			getRoutingPolicyRevision: mock(async () => 7),
			getFamilyAssignments,
			getAllAccounts,
			getComboRoutingPolicy,
		} as unknown as DatabaseOperations;

		const response = await createAccountRoutingOverviewHandler(
			dbOps,
			dependencies,
		)();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(getAllAccounts).toHaveBeenCalledTimes(1);
		expect(getFamilyAssignments).toHaveBeenCalledTimes(1);
		expect(getComboRoutingPolicy).toHaveBeenCalledTimes(2);
		expect(
			body.data.effective.map((view: { family: string }) => view.family),
		).toEqual(["fable", "opus"]);
		expect(body.data.opportunities).toHaveLength(16);
		expect(body.data.opportunities[0]).toEqual({
			account_id: expect.stringMatching(/^outside-/),
			family: expect.stringMatching(/^(fable|opus)$/),
			proposal_id: expect.any(String),
			combo_id: "combo-1",
			managed_model: expect.any(String),
			tier_source: "account_priority",
			reason: "included",
		});
	});

	it("returns only exact high-confidence outside-route opportunities", async () => {
		const current = account("current", 0);
		const outside = account("acct:opaque/Δ-01", 2);
		const unsupported = account("unsupported", 3);
		const newBilling = {
			...account("new-billing", 4),
			provider: "unrepresented-provider",
			api_key: "new-billing-secret",
			refresh_token: null,
			access_token: null,
		};
		const policy = {
			...snapshot(),
			slots: [
				{
					...snapshot().slots[0],
					id: "slot-current",
					account_id: "current",
					priority: 0,
				},
				{
					...snapshot().slots[1],
					id: "slot-peer",
					account_id: "peer",
					priority: 1,
				},
			],
			exclusions: [
				{
					id: "excluded-outside",
					family: "opus" as const,
					combo_id: "combo-1",
					account_id: "excluded",
					created_at: 1,
				},
			],
		};
		const accounts = [
			current,
			account("peer", 1),
			outside,
			unsupported,
			account("excluded", 5),
			newBilling,
		];
		const dbOps = {
			getRoutingPolicyRevision: mock(async () => 4),
			getFamilyAssignments: mock(async () => [policy.assignment]),
			getAllAccounts: mock(async () => structuredClone(accounts)),
			getComboRoutingPolicy: mock(async () => structuredClone(policy)),
		} as unknown as DatabaseOperations;
		const response = await createAccountRoutingOverviewHandler(dbOps, {
			...dependencies,
			resolveCapability(currentAccount: Account) {
				return currentAccount.id === "unsupported"
					? {
							status: "unsupported" as const,
							provenance: "explicit_mapping" as const,
							reason: "unsupported" as const,
						}
					: dependencies.resolveCapability();
			},
		})();
		const body = await response.json();

		expect(body.data.opportunities).toEqual([
			expect.objectContaining({
				account_id: "acct:opaque/Δ-01",
				family: "opus",
			}),
		]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("Account acct:opaque");
		expect(serialized).not.toContain("Account current");
		expect(serialized).not.toContain("Account peer");
		expect(serialized).not.toContain("Account unsupported");
		expect(serialized).not.toContain("secret-");
		expect(serialized).not.toContain("new-billing-secret");
		expect(serialized).not.toContain("must-not-leak.example");
		expect(serialized).not.toContain("private-physical-model");
		expect(serialized).not.toContain("refresh_token");
		expect(serialized).not.toContain("custom_endpoint");
		expect(serialized).not.toContain("model_mappings");
	});

	it("retries the complete account-routing overview after a revision change", async () => {
		const revisions = [10, 11, 11, 11];
		let accountRead = 0;
		const getAllAccounts = mock(async () => {
			accountRead++;
			return accountRead === 1
				? [account("a", 0), account("b", 1), account("stale-account", 2)]
				: [account("a", 0), account("b", 1), account("fresh-account", 2)];
		});
		const getComboRoutingPolicy = mock(async () => {
			const policy = snapshot();
			if (!policy.combo) throw new Error("Expected combo fixture");
			policy.combo = {
				...policy.combo,
				name: accountRead === 1 ? "Stale policy" : "Fresh policy",
			};
			return policy;
		});
		const dbOps = {
			getRoutingPolicyRevision: mock(async () => revisions.shift() ?? 11),
			getFamilyAssignments: mock(async () => [snapshot().assignment]),
			getAllAccounts,
			getComboRoutingPolicy,
		} as unknown as DatabaseOperations;

		const response = await createAccountRoutingOverviewHandler(
			dbOps,
			dependencies,
		)();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(getAllAccounts).toHaveBeenCalledTimes(2);
		expect(getComboRoutingPolicy).toHaveBeenCalledTimes(2);
		expect(body.data.effective[0].policy.combo.name).toBe("Fresh policy");
		expect(
			body.data.opportunities.map(
				(opportunity: { account_id: string }) => opportunity.account_id,
			),
		).toEqual(["fresh-account"]);
	});

	it("returns authoritative effective membership without credential or mapping data", async () => {
		const { dbOps } = statefulDb();
		const response = await createEffectiveRoutingHandler(
			dbOps,
			dependencies,
		)("opus");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.family).toBe("opus");
		expect(
			body.data.resolution.members.map(
				(member: { account_id: string }) => member.account_id,
			),
		).toEqual(["a", "b"]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("secret-a");
		expect(serialized).not.toContain("must-not-leak");
		expect(serialized).not.toContain("private-physical-model");
	});

	it("keeps model exhaustion and reauthentication distinct in availability", async () => {
		const state = statefulDb();
		state.mutateAccount("a", {
			rate_limited_until: Date.now() + 60_000,
			rate_limited_reason: "model_scoped_429",
		});
		state.mutateAccount("b", { requires_reauth: true });
		const genericResponse = await createEffectiveRoutingHandler(
			state.dbOps,
			dependencies,
		)("opus");
		const genericMembers = (await genericResponse.json()).data.resolution
			.members;
		expect(genericMembers[0].availability.reason).toBe("rate_limited");

		state.mutateAccount("a", {
			rate_limited_until: null,
			rate_limited_reason: null,
		});
		const response = await createEffectiveRoutingHandler(state.dbOps, {
			...dependencies,
			isLogicalModelExhausted: (_account, logicalModel) =>
				logicalModel === "claude-opus-4-8",
		})("opus");
		const members = (await response.json()).data.resolution.members;
		expect(
			members.map(
				(member: { availability: { reason: string } }) =>
					member.availability.reason,
			),
		).toEqual(["model_exhausted", "requires_reauth"]);
	});

	it("reads canonical family-scoped exhaustion from the shared usage cache", async () => {
		const state = statefulDb();
		usageCache.markFamilyScopedExhausted(
			"a",
			"claude-opus-4-8",
			Date.now() + 60_000,
		);
		try {
			const response = await createEffectiveRoutingHandler(state.dbOps)("opus");
			const members = (await response.json()).data.resolution.members;
			expect(members[0].availability.reason).toBe("model_exhausted");
			expect(members[1].availability.reason).toBe("available");
		} finally {
			usageCache.clearFamilyScopedExhaustion("a", "claude-opus-4-8");
		}
	});

	it("previews from a non-secret draft auth shape and emits reviewed identifiers", async () => {
		const state = statefulDb();
		for (const [id, provider, priority] of [
			["codex-fallback", "codex", 10],
			["xai-fallback", "xai", 20],
		] as const) {
			state.addAccount({
				...account(id, priority),
				provider,
				api_key: `secret-${id}`,
				refresh_token: null,
				access_token: null,
			});
			state.mutatePolicy((policy) => {
				policy.slots.push({
					id: `slot-${id}`,
					combo_id: "combo-1",
					account_id: id,
					model: "claude-opus-4-8",
					priority,
					enabled: true,
				});
			});
		}
		const response = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				family: "opus",
				managed_model: "claude-opus-4-7",
				draft: {
					provider: "anthropic",
					priority: 0,
					auth_shape: "oauth-subscription",
				},
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.preview_id).toMatch(/^preview:/);
		expect(body.data.managed_model).toBe("claude-opus-4-7");
		expect(body.data.proposals).toHaveLength(1);
		expect(body.data.proposals[0]).toMatchObject({
			proposal_id: expect.any(String),
			family: "opus",
			high_confidence: true,
			selected_by_default: true,
			managed_model: "claude-opus-4-7",
		});
		expect(
			body.data.proposals[0].proposed_effective.resolution.decisions,
		).toBeArray();
		const added = body.data.proposals[0].member_delta.filter(
			(entry: { status: string }) => entry.status === "added",
		);
		const provisionalAdded = added.filter(
			(entry: { after: { identity_provisional: boolean } | null }) =>
				entry.after?.identity_provisional === true,
		);
		expect(provisionalAdded).toHaveLength(1);
		expect(provisionalAdded[0]).toMatchObject({
			before: null,
			after: {
				account_id: null,
				candidate_id: null,
				identity_provisional: true,
				source: "managed",
				tier: 0,
				logical_model: "claude-opus-4-7",
				reason: "included",
			},
		});
		const draftMember =
			body.data.proposals[0].proposed_effective.resolution.members.find(
				(member: { identity_provisional: boolean }) =>
					member.identity_provisional,
			);
		expect(draftMember).toMatchObject({
			id: null,
			account_id: "preview:draft",
			identity_provisional: true,
		});
		expect(JSON.stringify(body)).not.toContain("routing-preview-draft");
		expect(JSON.stringify(body)).not.toContain("refresh_token");
	});

	it("projects a fourth draft through an already-enabled managed rule", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
			policy.assignment.managed_model = "claude-opus-4-8";
			policy.rules.push({
				id: "enabled-rule",
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: true,
				created_at: 1,
				updated_at: 1,
			});
		});
		const response = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				family: "opus",
				draft: {
					provider: "anthropic",
					priority: 0,
					auth_shape: "oauth-subscription",
				},
			}),
		);
		const preview = (await response.json()).data;

		expect(response.status).toBe(200);
		expect(preview.proposals).toHaveLength(1);
		expect(preview.proposals[0]).toMatchObject({
			existing_rule_id: "enabled-rule",
			high_confidence: true,
			selected_by_default: true,
		});
		expect(
			preview.proposals[0].proposed_effective.resolution.members.find(
				(member: { identity_provisional: boolean }) =>
					member.identity_provisional,
			),
		).toMatchObject({
			id: null,
			account_id: "preview:draft",
			source: "managed",
			rule_id: "enabled-rule",
		});
		expect(
			preview.proposals[0].member_delta.filter(
				(entry: { status: string; after: { identity_provisional: boolean } }) =>
					entry.status === "added" && entry.after?.identity_provisional,
			),
		).toHaveLength(1);
		const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: {
					draft: {
						provider: "anthropic",
						priority: 0,
						auth_shape: "oauth-subscription",
					},
				},
			}),
			"opus",
		);
		expect(apply.status).toBe(400);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("accepts compatible-provider plan drafts through production route derivation", async () => {
		const state = statefulDb();
		for (const id of ["a", "b"]) {
			state.mutateAccount(id, {
				provider: "openai-compatible",
				api_key: `secret-${id}`,
				refresh_token: null,
				access_token: null,
				billing_type: "plan",
				model_mappings: JSON.stringify({ opus: "physical-opus" }),
			});
		}
		const response = await createRoutingPreviewHandler(state.dbOps)(
			request("/api/routing/preview", {
				family: "opus",
				draft: {
					provider: "openai-compatible",
					priority: 0,
					auth_shape: "oauth-subscription",
					billing_type: "plan",
					model_mappings: { opus: "physical-opus" },
				},
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.proposals).toHaveLength(1);
		expect(body.data.proposals[0]).toMatchObject({
			provider: "openai-compatible",
			route_class: "oauth-subscription",
		});
		expect(JSON.stringify(body)).not.toContain(
			"present-for-route-shape-validation",
		);

		const contradiction = await createRoutingPreviewHandler(state.dbOps)(
			request("/api/routing/preview", {
				family: "opus",
				draft: {
					provider: "openai-compatible",
					priority: 0,
					auth_shape: "oauth-subscription",
					billing_type: "api",
					model_mappings: { opus: "physical-opus" },
				},
			}),
		);
		expect(contradiction.status).toBe(400);
	});

	it("re-previews a persisted automatic member and reuses its enabled rule without a write", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
			policy.assignment.managed_model = "claude-opus-4-8";
			policy.rules.push({
				id: "enabled-rule",
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: true,
				created_at: 1,
				updated_at: 1,
			});
		});
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const preview = (await previewResponse.json()).data;
		const proposal = preview.proposals[0];

		expect(previewResponse.status).toBe(200);
		expect(proposal).toMatchObject({
			existing_rule_id: "enabled-rule",
		});
		expect(
			proposal.proposed_effective.resolution.members.find(
				(member: { account_id: string }) => member.account_id === "new",
			),
		).toMatchObject({ source: "managed", rule_id: "enabled-rule" });

		const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: proposal.proposal_id,
				managed_model: preview.managed_model,
				subject: { account_id: "new" },
			}),
			"opus",
		);
		const effective = (await apply.json()).data;

		expect(apply.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
		expect(
			effective.resolution.members.find(
				(member: { account_id: string }) => member.account_id === "new",
			),
		).toMatchObject({ source: "managed", rule_id: "enabled-rule" });
	});

	it("server-owned finalization replays an exact reviewed account proposal idempotently", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const reviewed = (await previewResponse.json()).data.proposals[0];
		const finalize = createServerOwnedAccountRoutingFinalizer(
			state.dbOps,
			dependencies,
		);

		const first = await finalize({
			accountId: "new",
			reviewed: [{ family: "opus", proposalId: reviewed.proposal_id }],
		});
		const replay = await finalize({
			accountId: "new",
			reviewed: [{ family: "opus", proposalId: reviewed.proposal_id }],
		});

		expect(first).toMatchObject({
			accountId: "new",
			outcomes: [{ status: "joined", reason: "applied" }],
		});
		expect(replay).toMatchObject({
			accountId: "new",
			outcomes: [{ status: "joined", reason: "already-effective" }],
		});
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
	});

	it("defaults proposals to the valid assignment model and rejects a wrong-family override", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.managed_model = "claude-opus-4-7";
		});
		const defaulted = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		expect(defaulted.status).toBe(200);
		expect((await defaulted.json()).data.managed_model).toBe("claude-opus-4-7");

		const invalid = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				family: "opus",
				managed_model: "claude-fable-5",
				account_id: "new",
			}),
		);
		expect(invalid.status).toBe(400);
	});

	it("rejects stale reviewed proposals and never applies client-computed policy", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const preview = (await previewResponse.json()).data;
		state.mutatePolicy((policy) => {
			policy.slots[0].priority = 9;
		});

		const applyResponse = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: { account_id: "new" },
			}),
			"opus",
		);

		expect(applyResponse.status).toBe(409);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("rejects a policy interleave inside the repository CAS with zero apply writes", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const preview = (await previewResponse.json()).data;
		state.interleaveBeforeNextApply(() => {
			state.mutatePolicy((policy) => {
				policy.slots[0].priority = 9;
			});
		});

		const applyResponse = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: { account_id: "new" },
			}),
			"opus",
		);

		expect(applyResponse.status).toBe(409);
		expect((await applyResponse.json()).details.code).toBe(
			"stale_routing_preview",
		);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
		expect(state.applyFamilyPolicyChanges.mock.calls[0][0]).toMatchObject({
			expected_revision: expect.any(Number),
		});
		const policyAfterConflict = await state.dbOps.getComboRoutingPolicy("opus");
		expect(policyAfterConflict.assignment.membership_mode).toBe("manual");
		expect(policyAfterConflict.rules).toEqual([]);
		expect(policyAfterConflict.slots[0]?.priority).toBe(9);
	});

	it("bounds coherent preview retries when routing inputs keep changing", async () => {
		const state = statefulDb();
		let revision = 0;
		state.dbOps.getRoutingPolicyRevision = mock(async () => revision++);

		const response = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));

		expect(response.status).toBe(409);
		expect((await response.json()).details.code).toBe("stale_routing_preview");
		expect(state.dbOps.getRoutingPolicyRevision).toHaveBeenCalledTimes(6);
	});

	it("keeps draft subjects preview-only and requires a persisted account for apply", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				family: "opus",
				draft: {
					provider: "anthropic",
					priority: 0,
					auth_shape: "oauth-subscription",
				},
			}),
		);
		const preview = (await previewResponse.json()).data;
		const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: {
					draft: {
						provider: "anthropic",
						priority: 0,
						auth_shape: "oauth-subscription",
					},
				},
			}),
			"opus",
		);
		expect(apply.status).toBe(400);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("loads one account snapshot for all-family effective reads", async () => {
		const getAllAccounts = mock(async () => [account("a")]);
		const dbOps = {
			getRoutingPolicyRevision: mock(async () => 0),
			getFamilyAssignments: mock(async () => [
				{ ...snapshot().assignment, family: "opus" },
				{ ...snapshot().assignment, family: "fable" },
			]),
			getAllAccounts,
			getComboRoutingPolicy: mock(async (family: "opus" | "fable") => ({
				...snapshot(),
				assignment: { ...snapshot().assignment, family },
			})),
		} as unknown as DatabaseOperations;
		const response = await createEffectiveRoutingHandler(dbOps, dependencies)();
		expect(response.status).toBe(200);
		expect(getAllAccounts).toHaveBeenCalledTimes(1);
	});

	it("loads one account snapshot for all-family previews", async () => {
		const getAllAccounts = mock(async () => [account("a")]);
		const dbOps = {
			getRoutingPolicyRevision: mock(async () => 0),
			getFamilyAssignments: mock(async () => [
				{ ...snapshot().assignment, family: "opus" },
				{ ...snapshot().assignment, family: "fable" },
			]),
			getAllAccounts,
			getComboRoutingPolicy: mock(async (family: "opus" | "fable") => ({
				...snapshot(),
				assignment: { ...snapshot().assignment, family },
				slots: snapshot().slots.map((slot) => ({
					...slot,
					model: family === "opus" ? "claude-opus-4-8" : "claude-fable-5",
				})),
			})),
		} as unknown as DatabaseOperations;
		const response = await createRoutingPreviewHandler(
			dbOps,
			dependencies,
		)(request("/api/routing/preview", { account_id: "a" }));
		expect(response.status).toBe(200);
		expect(getAllAccounts).toHaveBeenCalledTimes(1);
		expect((await response.json()).data.families).toHaveLength(2);
	});

	it("previews and atomically applies a server-owned unanimous family conversion", async () => {
		const state = statefulDb();
		for (const [id, provider, priority] of [
			["codex-fallback", "codex", 10],
			["xai-fallback", "xai", 20],
		] as const) {
			state.addAccount({
				...account(id, priority),
				provider,
				api_key: `secret-${id}`,
				refresh_token: null,
				access_token: null,
			});
			state.mutatePolicy((policy) => {
				policy.slots.push({
					id: `slot-${id}`,
					combo_id: "combo-1",
					account_id: id,
					model: "claude-opus-4-8",
					priority,
					enabled: true,
				});
			});
		}
		const accountPreviewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const accountPreview = (await accountPreviewResponse.json()).data;
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { scope: "family", family: "opus" }));
		const preview = (await previewResponse.json()).data;

		expect(previewResponse.status).toBe(200);
		expect(preview.scope).toBe("family");
		expect(accountPreview.scope).toBe("account");
		expect(preview.preview_id).not.toBe(accountPreview.preview_id);
		const selected = preview.proposals.filter(
			(proposal: { selected_by_default: boolean }) =>
				proposal.selected_by_default,
		);
		expect(selected).toHaveLength(1);
		const proposal = selected[0];
		expect(proposal).toMatchObject({
			provider: "anthropic",
			route_class: "oauth-subscription",
			existing_rule_id: null,
			high_confidence: true,
			selected_by_default: true,
		});
		const added = proposal.member_delta.filter(
			(entry: { status: string }) => entry.status === "added",
		);
		expect(added).toHaveLength(1);
		expect(added[0].after).toMatchObject({
			account_id: "new",
			identity_provisional: false,
			source: "managed",
			tier: 0,
			logical_model: preview.managed_model,
		});

		const applyResponse = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				scope: "family",
				preview_id: preview.preview_id,
				proposal_id: proposal.proposal_id,
				managed_model: preview.managed_model,
			}),
			"opus",
		);

		expect(applyResponse.status).toBe(200);
		const applied = (await applyResponse.json()).data;
		const proposedNewMember =
			proposal.proposed_effective.resolution.members.find(
				(member: { account_id: string }) => member.account_id === "new",
			);
		const appliedNewMember = applied.resolution.members.find(
			(member: { account_id: string }) => member.account_id === "new",
		);
		expect(proposedNewMember).toMatchObject({
			id: expect.stringContaining(":managed:"),
			rule_id: expect.stringMatching(/^managed-rule:/),
		});
		expect(appliedNewMember).toMatchObject({
			id: proposedNewMember.id,
			rule_id: proposedNewMember.rule_id,
		});
		expect(
			proposal.proposed_effective.resolution.members
				.filter((member: { account_id: string }) =>
					member.account_id.endsWith("-fallback"),
				)
				.map((member: { source: string }) => member.source),
		).toEqual(["manual", "manual"]);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
		expect(state.applyFamilyPolicyChanges.mock.calls[0][0]).toMatchObject({
			family: "opus",
			assignment: {
				membership_mode: "managed",
				managed_model: preview.managed_model,
			},
			create_rules: [
				{
					id: proposedNewMember.rule_id,
					combo_id: "combo-1",
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
				},
			],
		});
	});

	it("reviews an enabled stored rule after rollback and converts without a duplicate", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "manual";
			policy.assignment.managed_model = "claude-opus-4-7";
			policy.rules.push({
				id: "stored-rule",
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: true,
				created_at: 1,
				updated_at: 1,
			});
		});
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { scope: "family", family: "opus" }));
		const preview = (await previewResponse.json()).data;

		expect(previewResponse.status).toBe(200);
		expect(preview.managed_model).toBe("claude-opus-4-7");
		expect(preview.proposals).toHaveLength(1);
		expect(preview.proposals[0]).toMatchObject({
			existing_rule_id: "stored-rule",
			high_confidence: true,
			selected_by_default: true,
		});
		expect(
			preview.proposals[0].proposed_effective.resolution.members.some(
				(member: { account_id: string }) => member.account_id === "new",
			),
		).toBe(true);

		const applyResponse = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				scope: "family",
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
			}),
			"opus",
		);

		expect(applyResponse.status).toBe(200);
		const changes = state.applyFamilyPolicyChanges.mock.calls[0][0];
		expect(changes.create_rules).toBeUndefined();
		expect(changes.update_rules).toEqual([
			{ id: "stored-rule", fields: { enabled: true } },
		]);
	});

	it("reports model-policy changes against stable candidate ownership", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
			policy.assignment.managed_model = "claude-opus-4-8";
			policy.rules.push({
				id: "stored-rule",
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: true,
				created_at: 1,
				updated_at: 1,
			});
		});
		const response = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				scope: "family",
				family: "opus",
				managed_model: "claude-opus-4-7",
			}),
		);
		const preview = (await response.json()).data;
		const proposal = preview.proposals.find(
			(candidate: { existing_rule_id: string | null }) =>
				candidate.existing_rule_id === "stored-rule",
		);
		const changed = proposal.member_delta.filter(
			(entry: { status: string }) => entry.status === "changed",
		);

		expect(response.status).toBe(200);
		expect(changed).toHaveLength(1);
		expect(changed[0]).toMatchObject({
			before: {
				account_id: "new",
				logical_model: "claude-opus-4-8",
			},
			after: {
				account_id: "new",
				logical_model: "claude-opus-4-7",
			},
		});
		expect(changed[0].before.candidate_id).toBe(changed[0].after.candidate_id);
	});

	it("does not auto-select a family conversion when explicit peers are ambiguous", async () => {
		const state = statefulDb();
		state.mutateAccount("b", {
			refresh_token: null,
			access_token: null,
			api_key: "must-not-leak",
			billing_type: "api",
		});
		const response = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { scope: "family", family: "opus" }));
		const preview = (await response.json()).data;

		expect(response.status).toBe(200);
		expect(preview.scope).toBe("family");
		expect(preview.proposals.length).toBeGreaterThan(0);
		expect(
			preview.proposals.every(
				(proposal: { selected_by_default: boolean }) =>
					proposal.selected_by_default === false,
			),
		).toBe(true);
		expect(JSON.stringify(preview)).not.toContain("must-not-leak");
	});

	it("rejects stale family conversion evidence and family-scope subject injection", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { scope: "family", family: "opus" }));
		const preview = (await previewResponse.json()).data;
		state.mutatePolicy((policy) => {
			policy.slots[0].priority = 9;
		});
		const stale = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				scope: "family",
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
			}),
			"opus",
		);
		expect(stale.status).toBe(409);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();

		const injectedPreview = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				scope: "family",
				family: "opus",
				account_id: "new",
			}),
		);
		expect(injectedPreview.status).toBe(400);

		const injectedApply = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				scope: "family",
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: { account_id: "new" },
			}),
			"opus",
		);
		expect(injectedApply.status).toBe(400);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("reactivates an exact disabled rule without creating a duplicate", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.rules.push({
				id: "disabled-rule",
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: false,
				created_at: 1,
				updated_at: 1,
			});
		});
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const preview = (await previewResponse.json()).data;
		const applyResponse = await createRoutingApplyHandler(
			state.dbOps,
			dependencies,
		)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
				subject: { account_id: "new" },
			}),
			"opus",
		);

		expect(applyResponse.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
		const changes = state.applyFamilyPolicyChanges.mock.calls[0][0];
		expect(changes.create_rules).toBeUndefined();
		expect(changes.update_rules).toEqual([
			{ id: "disabled-rule", fields: { enabled: true } },
		]);
		expect(
			(await applyResponse.json()).data.resolution.members.length,
		).toBeGreaterThan(0);
	});

	it("recomputes a reviewed model during apply and rejects a tampered model", async () => {
		const state = statefulDb();
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { family: "opus", account_id: "new" }));
		const preview = (await previewResponse.json()).data;
		const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: "claude-opus-4-7",
				subject: { account_id: "new" },
			}),
			"opus",
		);
		expect(apply.status).toBe(409);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("rejects a managed model from the wrong logical family", async () => {
		const { dbOps } = statefulDb();
		const response = await createFamilyAssignHandler(dbOps, dependencies)(
			request("/api/families/opus", {
				membership_mode: "managed",
				managed_model: "claude-fable-5",
			}),
			"opus",
		);
		expect(response.status).toBe(400);
	});

	it("fails closed with 422 when managed mode would have zero candidates", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.slots = [];
			policy.rules = [];
		});
		const response = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", {
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			}),
			"opus",
		);
		expect(response.status).toBe(422);
	});

	it("rejects a concurrent last-candidate removal for partial and legacy managed writes", async () => {
		for (const body of [
			{
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			{ combo_id: "combo-1", enabled: true },
		] as const) {
			const state = statefulDb();
			if (!("membership_mode" in body)) {
				state.mutatePolicy((policy) => {
					policy.assignment.membership_mode = "managed";
					policy.assignment.managed_model = "claude-opus-4-8";
				});
			}
			state.interleaveBeforeNextApply(() => {
				state.mutatePolicy((policy) => {
					policy.slots = [];
					policy.rules = [];
				});
			});

			const response = await createFamilyAssignHandler(
				state.dbOps,
				dependencies,
			)(request("/api/families/opus", body, "PUT"), "opus");

			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				details: { code: "stale_routing_preview" },
			});
			expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
			expect(state.dbOps.setFamilyPolicy).not.toHaveBeenCalled();
			expect(state.dbOps.setFamilyCombo).not.toHaveBeenCalled();
		}
	});

	it("keeps family conversion atomic when its recomputed proposal is empty", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.slots = [];
			policy.rules = [
				{
					id: "empty-rule",
					family: "opus",
					combo_id: "combo-1",
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			];
			policy.exclusions = ["a", "b", "new"].map((accountId) => ({
				id: `exclude-${accountId}`,
				family: "opus",
				combo_id: "combo-1",
				account_id: accountId,
				created_at: 1,
			}));
		});
		const previewResponse = await createRoutingPreviewHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/preview", { scope: "family", family: "opus" }));
		const preview = (await previewResponse.json()).data;
		const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
			request("/api/routing/apply/opus", {
				scope: "family",
				preview_id: preview.preview_id,
				proposal_id: preview.proposals[0].proposal_id,
				managed_model: preview.managed_model,
			}),
			"opus",
		);

		expect(apply.status).toBe(422);
		expect(state.applyFamilyPolicyChanges).not.toHaveBeenCalled();
	});

	it("allows disabling an empty managed route and validates enabled strictly", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
			policy.slots = [];
			policy.rules = [];
		});
		const disabled = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", {
				enabled: false,
				membership_mode: "managed",
			}),
			"opus",
		);
		expect(disabled.status).toBe(200);

		const invalid = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", { enabled: "false" }),
			"opus",
		);
		expect(invalid.status).toBe(400);
	});

	it("treats enabled-only and model-only family writes as partial policy updates", async () => {
		const state = statefulDb();
		const disabled = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", { enabled: false }, "PUT"),
			"opus",
		);

		expect(disabled.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).toHaveBeenNthCalledWith(1, {
			family: "opus",
			expected_revision: 0,
			assignment: { enabled: false },
		});
		expect(state.dbOps.setFamilyCombo).not.toHaveBeenCalled();
		expect((await disabled.json()).data).toMatchObject({
			combo_id: "combo-1",
			enabled: false,
		});

		const modeled = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request(
				"/api/families/opus",
				{ managed_model: "claude-opus-4-7" },
				"PUT",
			),
			"opus",
		);
		expect(modeled.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).toHaveBeenNthCalledWith(2, {
			family: "opus",
			expected_revision: 1,
			assignment: { managed_model: "claude-opus-4-7" },
		});
		expect((await modeled.json()).data).toMatchObject({
			combo_id: "combo-1",
			managed_model: "claude-opus-4-7",
		});
	});

	it("preserves explicit combo and null legacy assignment compatibility", async () => {
		const assigned = statefulDb();
		const assignResponse = await createFamilyAssignHandler(
			assigned.dbOps,
			dependencies,
		)(
			request(
				"/api/families/opus",
				{ combo_id: "combo-1", enabled: true },
				"PUT",
			),
			"opus",
		);
		expect(assignResponse.status).toBe(200);
		expect(assigned.applyFamilyPolicyChanges).toHaveBeenCalledWith({
			family: "opus",
			expected_revision: 0,
			assignment: { combo_id: "combo-1", enabled: true },
		});
		expect(assigned.dbOps.setFamilyCombo).not.toHaveBeenCalled();
		expect(assigned.dbOps.setFamilyPolicy).not.toHaveBeenCalled();

		const unassigned = statefulDb();
		const unassignResponse = await createFamilyAssignHandler(
			unassigned.dbOps,
			dependencies,
		)(
			request("/api/families/opus", { combo_id: null, enabled: false }, "PUT"),
			"opus",
		);
		expect(unassignResponse.status).toBe(200);
		expect(unassigned.applyFamilyPolicyChanges).toHaveBeenCalledWith({
			family: "opus",
			expected_revision: 0,
			assignment: { combo_id: null, enabled: false },
		});
		expect(unassigned.dbOps.setFamilyCombo).not.toHaveBeenCalled();
		expect(unassigned.dbOps.setFamilyPolicy).not.toHaveBeenCalled();
	});

	it("rolls a managed family back to manual without clearing its combo or model", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
			policy.assignment.managed_model = "claude-opus-4-7";
		});

		const response = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", { membership_mode: "manual" }, "PUT"),
			"opus",
		);

		expect(response.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledWith({
			family: "opus",
			expected_revision: 1,
			assignment: { membership_mode: "manual" },
		});
		expect(state.dbOps.setFamilyPolicy).not.toHaveBeenCalled();
		expect(state.dbOps.setFamilyCombo).not.toHaveBeenCalled();
		expect((await response.json()).data).toMatchObject({
			combo_id: "combo-1",
			membership_mode: "manual",
			managed_model: "claude-opus-4-7",
		});
	});

	it("rejects a family write with no recognized fields without mutating policy", async () => {
		const state = statefulDb();
		const response = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", {}, "PUT"),
			"opus",
		);

		expect(response.status).toBe(400);
		expect(state.dbOps.setFamilyPolicy).not.toHaveBeenCalled();
		expect(state.dbOps.setFamilyCombo).not.toHaveBeenCalled();
	});

	it("validates a changed combo against the target policy snapshot", async () => {
		const state = statefulDb();
		const dbOps = state.dbOps as unknown as Record<
			string,
			ReturnType<typeof mock>
		>;
		dbOps.getCombo = mock(async (id: string) =>
			id === "combo-empty"
				? {
						id,
						name: "Empty",
						description: null,
						enabled: true,
						created_at: 1,
						updated_at: 1,
					}
				: null,
		);
		dbOps.getComboSlots = mock(async () => []);
		dbOps.getComboEnrollmentRules = mock(async () => []);
		dbOps.getComboMembershipExclusions = mock(async () => []);
		const response = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", {
				combo_id: "combo-empty",
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			}),
			"opus",
		);
		expect(response.status).toBe(422);
		expect(state.dbOps.setFamilyPolicy).not.toHaveBeenCalled();
	});

	it("does not let the legacy assignment body bypass a managed-route guard", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.assignment.membership_mode = "managed";
		});
		const dbOps = state.dbOps as unknown as Record<
			string,
			ReturnType<typeof mock>
		>;
		dbOps.getCombo = mock(async (id: string) =>
			id === "combo-empty"
				? {
						id,
						name: "Empty",
						description: null,
						enabled: true,
						created_at: 1,
						updated_at: 1,
					}
				: null,
		);
		dbOps.getComboSlots = mock(async () => []);
		dbOps.getComboEnrollmentRules = mock(async () => []);
		dbOps.getComboMembershipExclusions = mock(async () => []);

		const response = await createFamilyAssignHandler(state.dbOps, dependencies)(
			request("/api/families/opus", {
				combo_id: "combo-empty",
				enabled: true,
			}),
			"opus",
		);
		expect(response.status).toBe(422);
		expect(state.dbOps.setFamilyCombo).not.toHaveBeenCalled();
	});

	it("creates and restores a family-local exclusion with authoritative rereads", async () => {
		const state = statefulDb();
		const exclude = await createMembershipExclusionCreateHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/exclusions/opus", { account_id: "new" }), "opus");
		expect(exclude.status).toBe(201);
		expect(state.applyFamilyPolicyChanges).toHaveBeenNthCalledWith(1, {
			family: "opus",
			expected_revision: 0,
			create_exclusions: [{ combo_id: "combo-1", account_id: "new" }],
		});
		expect(state.dbOps.createComboMembershipExclusion).not.toHaveBeenCalled();
		expect((await exclude.json()).data.policy.exclusions).toHaveLength(1);

		const duplicate = await createMembershipExclusionCreateHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/exclusions/opus", { account_id: "new" }), "opus");
		expect(duplicate.status).toBe(409);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);

		const restore = await createMembershipExclusionRestoreHandler(
			state.dbOps,
			dependencies,
		)("opus", "new");
		expect(restore.status).toBe(200);
		expect(state.applyFamilyPolicyChanges).toHaveBeenNthCalledWith(2, {
			family: "opus",
			expected_revision: 1,
			delete_exclusion_ids: ["created-exclusion"],
		});
		expect(state.restoreComboMembership).not.toHaveBeenCalled();
		expect((await restore.json()).data.policy.exclusions).toHaveLength(0);

		const alreadyRestored = await createMembershipExclusionRestoreHandler(
			state.dbOps,
			dependencies,
		)("opus", "new");
		expect(alreadyRestored.status).toBe(404);
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(2);
	});

	it("rejects exclusion creation when the family assignment changes before commit", async () => {
		const state = statefulDb();
		state.interleaveBeforeNextApply(() => {
			state.mutatePolicy((policy) => {
				policy.assignment.combo_id = null;
				policy.assignment.enabled = false;
			});
		});

		const response = await createMembershipExclusionCreateHandler(
			state.dbOps,
			dependencies,
		)(request("/api/routing/exclusions/opus", { account_id: "new" }), "opus");

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "stale_routing_preview" },
		});
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
		expect(state.dbOps.createComboMembershipExclusion).not.toHaveBeenCalled();
	});

	it("rejects exclusion restore when the family assignment changes before commit", async () => {
		const state = statefulDb();
		state.mutatePolicy((policy) => {
			policy.exclusions.push({
				id: "exclude-new",
				family: "opus",
				combo_id: "combo-1",
				account_id: "new",
				created_at: 1,
			});
		});
		state.interleaveBeforeNextApply(() => {
			state.mutatePolicy((policy) => {
				policy.assignment.combo_id = null;
				policy.assignment.enabled = false;
			});
		});

		const response = await createMembershipExclusionRestoreHandler(
			state.dbOps,
			dependencies,
		)("opus", "new");

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "stale_routing_preview" },
		});
		expect(state.applyFamilyPolicyChanges).toHaveBeenCalledTimes(1);
		expect(state.restoreComboMembership).not.toHaveBeenCalled();
	});

	it("returns a typed 404 before restoring a missing exclusion", async () => {
		const state = statefulDb();
		const response = await createMembershipExclusionRestoreHandler(
			state.dbOps,
			dependencies,
		)("opus", "missing");
		expect(response.status).toBe(404);
		expect(state.restoreComboMembership).not.toHaveBeenCalled();
	});

	it("returns typed errors for unsafe preview and exclusion requests", async () => {
		const unknownRoute = statefulDb();
		const preview = await createRoutingPreviewHandler(
			unknownRoute.dbOps,
			dependencies,
		)(
			request("/api/routing/preview", {
				family: "opus",
				draft: {
					provider: "anthropic",
					priority: 0,
					auth_shape: "secret-route-class",
				},
			}),
		);
		expect(preview.status).toBe(400);

		const missing = statefulDb();
		const invalidAccount = await createMembershipExclusionCreateHandler(
			missing.dbOps,
			dependencies,
		)(
			request("/api/routing/exclusions/opus", { account_id: "missing" }),
			"opus",
		);
		expect(invalidAccount.status).toBe(404);

		const disabled = statefulDb();
		disabled.mutatePolicy((policy) => {
			policy.assignment.enabled = false;
		});
		const disabledRoute = await createMembershipExclusionCreateHandler(
			disabled.dbOps,
			dependencies,
		)(request("/api/routing/exclusions/opus", { account_id: "new" }), "opus");
		expect(disabledRoute.status).toBe(422);

		const duplicate = statefulDb();
		duplicate.mutatePolicy((policy) => {
			policy.exclusions.push({
				id: "already-excluded",
				family: "opus",
				combo_id: "combo-1",
				account_id: "new",
				created_at: 1,
			});
		});
		const duplicateResponse = await createMembershipExclusionCreateHandler(
			duplicate.dbOps,
			dependencies,
		)(request("/api/routing/exclusions/opus", { account_id: "new" }), "opus");
		expect(duplicateResponse.status).toBe(409);
	});

	it("maps malformed and non-object JSON to typed 400s on every new write endpoint", async () => {
		const state = statefulDb();
		for (const body of ["null", "{"]) {
			const preview = await createRoutingPreviewHandler(
				state.dbOps,
				dependencies,
			)(rawRequest("/api/routing/preview", body));
			expect(preview.status).toBe(400);

			const apply = await createRoutingApplyHandler(state.dbOps, dependencies)(
				rawRequest("/api/routing/apply/opus", body),
				"opus",
			);
			expect(apply.status).toBe(400);

			const exclusion = await createMembershipExclusionCreateHandler(
				state.dbOps,
				dependencies,
			)(rawRequest("/api/routing/exclusions/opus", body), "opus");
			expect(exclusion.status).toBe(400);
		}
	});
});
