import { describe, expect, it } from "bun:test";
import type {
	Account,
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	ComboRouteClass,
	ComboRoutingPolicySnapshot,
	LogicalModelCapability,
} from "@better-ccflare/types";
import {
	createManagedComboMemberId,
	proposeComboEnrollmentRules,
	resolveEffectiveComboMembership,
} from "./combo-membership-resolver";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "Account 1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
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
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function snapshot(
	family: ComboFamily = "opus",
	overrides: Partial<ComboRoutingPolicySnapshot> = {},
): ComboRoutingPolicySnapshot {
	const combo: Combo = {
		id: "combo-1",
		name: "Opus route",
		description: null,
		enabled: true,
		created_at: 1,
		updated_at: 1,
	};
	const assignment: ComboFamilyAssignment = {
		family,
		combo_id: combo.id,
		enabled: true,
		membership_mode: "managed",
		managed_model: family === "fable" ? "claude-fable-5" : "claude-opus-4-8",
	};
	return {
		assignment,
		combo,
		slots: [],
		rules: [
			{
				id: "rule-1",
				family,
				combo_id: combo.id,
				provider: "anthropic",
				route_class: "oauth-subscription",
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
		],
		exclusions: [],
		...overrides,
	};
}

const supported: LogicalModelCapability = {
	status: "supported",
	provenance: "native_passthrough",
	reason: "included",
};

function dependencies(counters?: { route: number; capability: number }) {
	return {
		deriveRouteClass(current: Account): ComboRouteClass | null {
			if (counters) counters.route++;
			return current.provider === "anthropic"
				? "oauth-subscription"
				: "api-key";
		},
		resolveCapability(): LogicalModelCapability {
			if (counters) counters.capability++;
			return supported;
		},
	};
}

describe("resolveEffectiveComboMembership", () => {
	it("preserves manual slot model, tier, identity, order, and repeated accounts", () => {
		const policy = snapshot("opus", {
			assignment: {
				...snapshot().assignment,
				membership_mode: "manual",
			},
			slots: [
				{
					id: "slot-z",
					combo_id: "combo-1",
					account_id: "account-1",
					model: "claude-opus-4-6",
					priority: 10,
					enabled: true,
				},
				{
					id: "slot-a",
					combo_id: "combo-1",
					account_id: "account-1",
					model: "claude-opus-4-8",
					priority: 5,
					enabled: true,
				},
				{
					id: "slot-disabled",
					combo_id: "combo-1",
					account_id: "account-2",
					model: "claude-opus-4-8",
					priority: 0,
					enabled: false,
				},
			],
		});
		const counters = { route: 0, capability: 0 };
		const result = resolveEffectiveComboMembership(
			policy,
			[account()],
			dependencies(counters),
		);

		expect(
			result.members.map(({ id, logical_model, tier }) => ({
				id,
				logical_model,
				tier,
			})),
		).toEqual([
			{
				id: "combo:combo-1:slot:slot-a",
				logical_model: "claude-opus-4-8",
				tier: 5,
			},
			{
				id: "combo:combo-1:slot:slot-z",
				logical_model: "claude-opus-4-6",
				tier: 10,
			},
		]);
		expect(counters).toEqual({ route: 0, capability: 0 });
	});

	it("adds managed members at current account priority with stable identities", () => {
		const policy = snapshot();
		const first = resolveEffectiveComboMembership(
			policy,
			[account({ priority: 0 })],
			dependencies(),
		);
		const second = resolveEffectiveComboMembership(
			policy,
			[account({ priority: 10 })],
			dependencies(),
		);

		expect(first.members).toHaveLength(1);
		expect(first.members[0]).toMatchObject({
			id: "combo:combo-1:managed:opus:rule:rule-1:account:account-1",
			tier: 0,
			logical_model: "claude-opus-4-8",
			source: "managed",
		});
		expect(second.members[0]?.id).toBe(first.members[0]?.id);
		expect(second.members[0]?.tier).toBe(10);
	});

	it("gives enabled manual slots precedence and keeps exclusions managed-only", () => {
		const manualSlot = {
			id: "manual-1",
			combo_id: "combo-1",
			account_id: "account-1",
			model: "claude-opus-4-6",
			priority: 5,
			enabled: true,
		};
		const policy = snapshot("opus", {
			slots: [manualSlot],
			exclusions: [
				{
					id: "exclude-1",
					family: "opus",
					combo_id: "combo-1",
					account_id: "account-1",
					created_at: 1,
				},
			],
		});
		const counters = { route: 0, capability: 0 };
		const result = resolveEffectiveComboMembership(
			policy,
			[account()],
			dependencies(counters),
		);

		expect(result.members).toHaveLength(1);
		expect(result.members[0]).toMatchObject({
			id: "combo:combo-1:slot:manual-1",
			logical_model: "claude-opus-4-6",
			tier: 5,
			source: "manual",
		});
		expect(result.decisions).toContainEqual(
			expect.objectContaining({
				account_id: "account-1",
				included: false,
				reason: "manual_override",
				rule_id: "rule-1",
			}),
		);
		expect(counters.capability).toBe(0);
	});

	it("fails closed with stable unsupported and unknown reasons", () => {
		for (const reason of ["unsupported", "unknown"] as const) {
			const result = resolveEffectiveComboMembership(snapshot(), [account()], {
				...dependencies(),
				resolveCapability: () => ({
					status: reason,
					provenance: "undeclared",
					reason,
				}),
			});
			expect(result.members).toHaveLength(0);
			expect(result.decisions[0]?.reason).toBe(reason);
		}
	});

	it("reports disabled, excluded, and ambiguous states without capability work", () => {
		const current = account();
		const disabled = resolveEffectiveComboMembership(
			snapshot("opus", {
				combo: { ...(snapshot().combo as Combo), enabled: false },
			}),
			[current],
			dependencies(),
		);
		expect(disabled).toMatchObject({ active: false, reason: "disabled" });

		const excludedCounters = { route: 0, capability: 0 };
		const excluded = resolveEffectiveComboMembership(
			snapshot("opus", {
				exclusions: [
					{
						id: "exclude-1",
						family: "opus",
						combo_id: "combo-1",
						account_id: current.id,
						created_at: 1,
					},
				],
			}),
			[current],
			dependencies(excludedCounters),
		);
		expect(excluded.decisions[0]?.reason).toBe("excluded");
		expect(excludedCounters.capability).toBe(0);

		const ambiguous = resolveEffectiveComboMembership(
			snapshot("opus", {
				assignment: {
					...snapshot().assignment,
					managed_model: "claude-sonnet-5",
				},
			}),
			[current],
			dependencies(),
		);
		expect(ambiguous).toMatchObject({ active: true, reason: "ambiguous" });
		expect(ambiguous.members).toHaveLength(0);
	});

	it("uses the canonical family model and keeps operational state out of membership", () => {
		const policy = snapshot("fable", {
			assignment: {
				...snapshot("fable").assignment,
				managed_model: null,
			},
		});
		const result = resolveEffectiveComboMembership(
			policy,
			[
				account({
					paused: true,
					requires_reauth: true,
					rate_limited_until: Date.now() + 60_000,
				}),
			],
			dependencies(),
		);
		expect(result.members[0]).toMatchObject({
			logical_model: "claude-fable-5",
			source: "managed",
		});
	});

	it("does not let a disabled slot suppress a managed candidate", () => {
		const result = resolveEffectiveComboMembership(
			snapshot("opus", {
				slots: [
					{
						id: "disabled-slot",
						combo_id: "combo-1",
						account_id: "account-1",
						model: "claude-opus-4-6",
						priority: 1,
						enabled: false,
					},
				],
			}),
			[account()],
			dependencies(),
		);
		expect(result.members).toHaveLength(1);
		expect(result.members[0]?.source).toBe("managed");
		expect(result.decisions.map((decision) => decision.reason)).toContain(
			"disabled",
		);
	});

	it("is deterministic under input reordering and bounds injected operations", () => {
		const accounts = Array.from({ length: 40 }, (_, index) =>
			account({
				id: `account-${index.toString().padStart(2, "0")}`,
				priority: index % 4,
			}),
		);
		const counters = { route: 0, capability: 0 };
		const forward = resolveEffectiveComboMembership(
			snapshot(),
			accounts,
			dependencies(counters),
		);
		const reversed = resolveEffectiveComboMembership(
			snapshot(),
			[...accounts].reverse(),
			dependencies(),
		);

		expect(reversed).toEqual(forward);
		expect(counters.route).toBe(accounts.length);
		expect(counters.capability).toBe(accounts.length);
	});

	it("changes managed identity only when a durable governing input changes", () => {
		const id = createManagedComboMemberId({
			comboId: "combo-1",
			family: "opus",
			ruleId: "rule-1",
			accountId: "account-1",
		});
		expect(id).toBe("combo:combo-1:managed:opus:rule:rule-1:account:account-1");
		expect(
			createManagedComboMemberId({
				comboId: "combo-1",
				family: "opus",
				ruleId: "rule-2",
				accountId: "account-1",
			}),
		).not.toBe(id);
	});
});

describe("proposeComboEnrollmentRules", () => {
	it("does not propose a duplicate when the exact managed rule is enabled", () => {
		const proposals = proposeComboEnrollmentRules(
			snapshot(),
			[account()],
			account({ id: "draft" }),
			dependencies(),
		);

		expect(proposals).toEqual([]);
	});

	it("surfaces an exact disabled rule as a non-default reactivation", () => {
		const policy = snapshot("opus", {
			rules: [{ ...snapshot().rules[0], enabled: false }],
		});
		const proposals = proposeComboEnrollmentRules(
			policy,
			[account()],
			account({ id: "draft" }),
			dependencies(),
		);

		expect(proposals).toEqual([
			expect.objectContaining({
				existing_rule_id: "rule-1",
				high_confidence: false,
				selected_by_default: false,
				reason: "disabled",
			}),
		]);
	});

	it("proposes one visible high-confidence Anthropic cohort for a fourth peer", () => {
		const peers = [0, 1, 2].map((priority) =>
			account({ id: `peer-${priority}`, priority }),
		);
		const policy = snapshot("opus", {
			rules: [],
			slots: peers.map((peer) => ({
				id: `slot-${peer.id}`,
				combo_id: "combo-1",
				account_id: peer.id,
				model: "claude-opus-4-8",
				priority: peer.priority,
				enabled: true,
			})),
		});
		const proposals = proposeComboEnrollmentRules(
			policy,
			peers,
			account({ id: "peer-3", priority: 0 }),
			dependencies(),
		);

		expect(proposals).toEqual([
			expect.objectContaining({
				family: "opus",
				combo_id: "combo-1",
				provider: "anthropic",
				route_class: "oauth-subscription",
				managed_model: "claude-opus-4-8",
				tier_source: "account_priority",
				high_confidence: true,
				selected_by_default: true,
				reason: "included",
			}),
		]);
	});

	it("blocks conflicting model families and tier relationships", () => {
		const peers = [
			account({ id: "peer-a", priority: 0 }),
			account({ id: "peer-b", priority: 1 }),
		];
		const base = snapshot("opus", {
			rules: [],
			slots: [
				{
					id: "slot-a",
					combo_id: "combo-1",
					account_id: "peer-a",
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-b",
					combo_id: "combo-1",
					account_id: "peer-b",
					model: "claude-sonnet-5",
					priority: 9,
					enabled: true,
				},
			],
		});
		const [proposal] = proposeComboEnrollmentRules(
			base,
			peers,
			account({ id: "draft" }),
			dependencies(),
		);
		expect(proposal).toMatchObject({
			high_confidence: false,
			selected_by_default: false,
			reason: "ambiguous",
		});
	});

	it("blocks exclusions, new route classes, and unsupported capabilities separately", () => {
		const peer = account({ id: "peer", priority: 0 });
		const peerSlot = {
			id: "slot-peer",
			combo_id: "combo-1",
			account_id: peer.id,
			model: "claude-opus-4-8",
			priority: 0,
			enabled: true,
		};
		const excludedPolicy = snapshot("opus", {
			rules: [],
			slots: [peerSlot],
			exclusions: [
				{
					id: "exclude-peer",
					family: "opus",
					combo_id: "combo-1",
					account_id: peer.id,
					created_at: 1,
				},
			],
		});
		expect(
			proposeComboEnrollmentRules(
				excludedPolicy,
				[peer],
				account({ id: "draft" }),
				dependencies(),
			)[0],
		).toMatchObject({ high_confidence: false, reason: "excluded" });

		const basePolicy = snapshot("opus", { rules: [], slots: [peerSlot] });
		expect(
			proposeComboEnrollmentRules(
				basePolicy,
				[peer],
				account({ id: "draft", provider: "openai-compatible" }),
				dependencies(),
			)[0],
		).toMatchObject({ high_confidence: false, reason: "ambiguous" });

		expect(
			proposeComboEnrollmentRules(
				basePolicy,
				[peer],
				account({ id: "draft" }),
				{
					...dependencies(),
					resolveCapability: () => ({
						status: "unsupported",
						provenance: "provider_default",
						reason: "unsupported",
					}),
				},
			)[0],
		).toMatchObject({ high_confidence: false, reason: "unsupported" });
	});

	it("blocks repeated peer slots and unsupported peer capability", () => {
		const peer = account({ id: "peer", priority: 0 });
		const slot = {
			id: "slot-peer",
			combo_id: "combo-1",
			account_id: peer.id,
			model: "claude-opus-4-8",
			priority: 0,
			enabled: true,
		};
		const repeated = snapshot("opus", {
			rules: [],
			slots: [slot, { ...slot, id: "slot-peer-2" }],
		});
		expect(
			proposeComboEnrollmentRules(
				repeated,
				[peer],
				account({ id: "draft" }),
				dependencies(),
			)[0],
		).toMatchObject({ high_confidence: false, reason: "ambiguous" });

		let capabilityCalls = 0;
		expect(
			proposeComboEnrollmentRules(
				snapshot("opus", { rules: [], slots: [slot] }),
				[peer],
				account({ id: "draft" }),
				{
					...dependencies(),
					resolveCapability: () => {
						capabilityCalls++;
						return capabilityCalls === 1
							? {
									status: "unknown",
									provenance: "undeclared",
									reason: "unknown",
								}
							: supported;
					},
				},
			)[0],
		).toMatchObject({ high_confidence: false, reason: "unknown" });
	});
});
