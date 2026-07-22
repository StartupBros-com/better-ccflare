import { describe, expect, it } from "bun:test";
import type {
	ComboFamily,
	ComboFamilyAssignment,
	ComboMembershipDecisionView,
	ComboSlot,
	ComboWithSlots,
	EffectiveComboMemberView,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import {
	ComboSlotBuilder,
	createSerializedTargetMutation,
} from "./ComboSlotBuilder";
import type { ManagedRoutingTarget } from "./ManagedMemberList";

const manualSlot: ComboSlot = {
	id: "slot-override",
	combo_id: "combo-shared",
	account_id: "account-override",
	model: "manual-override-model",
	priority: 6,
	enabled: true,
};

function assignment(
	family: ComboFamily,
	membershipMode: ComboFamilyAssignment["membership_mode"] = "managed",
): ComboFamilyAssignment {
	return {
		family,
		combo_id: "combo-shared",
		enabled: true,
		membership_mode: membershipMode,
		managed_model: `claude-${family}-managed`,
	};
}

function member(
	family: ComboFamily,
	accountId: string,
	accountName: string,
	source: "manual" | "managed",
): EffectiveComboMemberView {
	return {
		id: `${family}:${source}:${accountId}`,
		account_id: accountId,
		account_name: accountName,
		combo_id: "combo-shared",
		family,
		included: true,
		logical_model:
			source === "manual" ? manualSlot.model : `claude-${family}-managed`,
		tier: source === "manual" ? manualSlot.priority : 0,
		source,
		reason: "included",
		slot_id: source === "manual" ? manualSlot.id : null,
		rule_id: source === "managed" ? `rule-${family}` : null,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
	};
}

function decision(
	family: ComboFamily,
	accountId: string,
	accountName: string,
	reason: ComboMembershipDecisionView["reason"],
): ComboMembershipDecisionView {
	return {
		account_id: accountId,
		account_name: accountName,
		combo_id: "combo-shared",
		family,
		included: false,
		logical_model: `claude-${family}-managed`,
		tier: 6,
		source: null,
		reason,
		slot_id: null,
		rule_id: `rule-${family}`,
		availability: { available: true, reason: "available" },
		identity_provisional: false,
	};
}

function view(
	family: ComboFamily,
	membershipMode: ComboFamilyAssignment["membership_mode"] = "managed",
): EffectiveComboRoutingView {
	const managedName =
		family === "opus" ? "Opus managed peer" : "Fable managed peer";
	return {
		family,
		policy: {
			assignment: assignment(family, membershipMode),
			combo: {
				id: "combo-shared",
				name: "Shared priority route",
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [manualSlot],
			rules: [
				{
					id: `rule-${family}`,
					family,
					combo_id: "combo-shared",
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: "combo-shared",
			active: true,
			reason: "included",
			members: [
				member(family, "account-override", "Manual override peer", "manual"),
				member(family, `account-managed-${family}`, managedName, "managed"),
			],
			decisions: [
				decision(
					family,
					"account-override",
					"Manual override peer",
					"manual_override",
				),
			],
		},
	};
}

describe("ComboSlotBuilder managed routing", () => {
	it("serializes two targets until the controlled mutation promise settles", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstRequest = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const calls: ManagedRoutingTarget[] = [];
		const mutation = createSerializedTargetMutation<ManagedRoutingTarget>(
			async (target) => {
				calls.push(target);
				if (calls.length === 1) await firstRequest;
			},
		);
		const firstTarget = { family: "opus", accountId: "account-first" } as const;
		const secondTarget = {
			family: "opus",
			accountId: "account-second",
		} as const;

		const firstRun = mutation.run(firstTarget);
		expect(mutation.isLocked()).toBe(true);
		expect(await mutation.run(secondTarget)).toBe("ignored");
		expect(calls).toEqual([firstTarget]);

		releaseFirst?.();
		expect(await firstRun).toBe("started");
		expect(mutation.isLocked()).toBe(false);
		expect(await mutation.run(secondTarget)).toBe("started");
		expect(calls).toEqual([firstTarget, secondTarget]);
	});

	it("renders persisted Manual slots once and managed resolution for every assigned family", () => {
		const combo: ComboWithSlots = {
			id: "combo-shared",
			name: "Shared priority route",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 1,
			slots: [manualSlot],
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.accounts(), [
			{
				id: "account-override",
				name: "Manual override peer",
				provider: "anthropic",
			},
		]);
		client.setQueryData(queryKeys.families(), {
			families: [assignment("opus"), assignment("fable")],
		});
		client.setQueryData(queryKeys.routingEffective(), [
			view("opus"),
			view("fable"),
		]);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={combo} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Persisted Manual slots (1)");
		expect(html).toContain("Opus managed members");
		expect(html).toContain("Fable managed members");
		expect(html).toContain("Opus managed peer");
		expect(html).toContain("Fable managed peer");
		expect(html).toContain("Manual override");
		expect(html).toContain("manual-override-model");
		expect(html.match(/data-source="manual"/g)).toHaveLength(1);
		expect(html.match(/data-source="managed"/g)).toHaveLength(2);
		expect(html).toContain(
			'data-account-id="account-override" data-source="manual"',
		);
		expect(html).not.toContain(
			'data-account-id="account-override" data-source="managed"',
		);
		expect(html).toContain("Add Manual slot");
		expect(html).toContain("Priority tier for Manual override peer");
		expect(html).not.toContain('data-reason="manual_override"');
	});

	it("hides virtual members in Manual mode while retaining saved policy and exclusions", () => {
		const combo: ComboWithSlots = {
			id: "combo-shared",
			name: "Shared priority route",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 1,
			slots: [manualSlot],
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const manualView = view("opus", "manual");
		manualView.policy.exclusions = [
			{
				id: "saved-exclusion",
				family: "opus",
				combo_id: "combo-shared",
				account_id: "account-saved-exclusion",
				created_at: 1,
			},
		];
		client.setQueryData(queryKeys.accounts(), [
			{
				id: "account-override",
				name: "Manual override peer",
				provider: "anthropic",
			},
			{
				id: "account-saved-exclusion",
				name: "Saved excluded peer",
				provider: "anthropic",
			},
		]);
		client.setQueryData(queryKeys.families(), {
			// Simulate the assignment list cache lagging one refresh behind the
			// coherent effective-routing snapshot after rollback.
			families: [assignment("opus", "managed")],
		});
		client.setQueryData(queryKeys.routingEffective(), [manualView]);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={combo} />
			</QueryClientProvider>,
		);

		expect(html).toContain("opus · manual");
		expect(html).not.toContain("opus · managed");
		expect(html).toContain("Managed routing is off");
		expect(html).toContain("1 saved rule");
		expect(html).toContain("1 saved exclusion");
		expect(html).toContain("Saved excluded peer");
		expect(html).toContain("Stored exclusion");
		expect(html).not.toContain("Opus managed members");
		expect(html).not.toContain("Opus managed peer");
		expect(html).not.toContain('data-source="managed"');
	});

	it("uses the coherent projection assignments and slots across deliberately skewed caches", () => {
		const staleSlot: ComboSlot = {
			id: "slot-stale",
			combo_id: "combo-shared",
			account_id: "account-stale",
			model: "stale-dialog-model",
			priority: 99,
			enabled: true,
		};
		const authoritativeSlot: ComboSlot = {
			id: "slot-authoritative",
			combo_id: "combo-shared",
			account_id: "account-override",
			model: "authoritative-manual-model",
			priority: 4,
			enabled: true,
		};
		const staleCombo: ComboWithSlots = {
			id: "combo-shared",
			name: "Shared priority route",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 1,
			slots: [staleSlot, manualSlot],
		};
		const opusView = view("opus", "managed");
		opusView.policy.slots = [authoritativeSlot];
		opusView.resolution.members = [
			{
				...member("opus", "account-override", "Manual override peer", "manual"),
				id: "opus:manual:authoritative",
				logical_model: authoritativeSlot.model,
				tier: authoritativeSlot.priority,
				slot_id: authoritativeSlot.id,
			},
			member("opus", "account-managed-opus", "Opus managed peer", "managed"),
		];
		const fableView = view("fable", "managed");
		fableView.policy.slots = [authoritativeSlot];
		fableView.resolution.members = [
			{
				...member(
					"fable",
					"account-override",
					"Manual override peer",
					"manual",
				),
				id: "fable:manual:authoritative",
				logical_model: authoritativeSlot.model,
				tier: authoritativeSlot.priority,
				slot_id: authoritativeSlot.id,
			},
			member("fable", "account-managed-fable", "Fable managed peer", "managed"),
		];
		const crossComboView = view("sonnet", "managed");
		crossComboView.policy.assignment.combo_id = "combo-other";
		if (crossComboView.policy.combo) {
			crossComboView.policy.combo.id = "combo-other";
		}
		crossComboView.policy.slots = [];
		crossComboView.resolution.combo_id = "combo-other";

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.accounts(), [
			{
				id: "account-override",
				name: "Manual override peer",
				provider: "anthropic",
			},
			{
				id: "account-stale",
				name: "Stale dialog account",
				provider: "anthropic",
			},
		]);
		client.setQueryData(queryKeys.families(), {
			families: [assignment("opus", "manual"), assignment("sonnet", "managed")],
		});
		client.setQueryData(queryKeys.routingEffective(), [
			opusView,
			fableView,
			crossComboView,
		]);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={staleCombo} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Persisted Manual slots (1)");
		expect(html).toContain("authoritative-manual-model");
		expect(html).toContain("Priority tier for Manual override peer");
		expect(html).not.toContain("stale-dialog-model");
		expect(html).not.toContain("Stale dialog account");
		expect(html).toContain("opus · managed");
		expect(html).toContain("fable · managed");
		expect(html).not.toContain("sonnet · managed");
		expect(html).toContain("Fable managed members");
		expect(html.match(/data-source="manual"/g)).toHaveLength(1);
		expect(html).not.toContain(
			'data-account-id="account-override" data-source="managed"',
		);
	});

	it("falls back to dialog slots when the combo is truly unassigned", () => {
		const combo: ComboWithSlots = {
			id: "combo-shared",
			name: "Unassigned manual route",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 1,
			slots: [manualSlot],
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.accounts(), [
			{
				id: "account-override",
				name: "Manual override peer",
				provider: "anthropic",
			},
		]);
		client.setQueryData(queryKeys.families(), { families: [] });
		client.setQueryData(queryKeys.routingEffective(), []);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={combo} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Persisted Manual slots (1)");
		expect(html).toContain("manual-override-model");
		expect(html).toContain("This combo is not assigned to a model family.");
		expect(html).toContain("Priority tier for Manual override peer");
	});

	it("rejects cached effective data after a refetch failure and uses newer safe caches", () => {
		const currentSlot: ComboSlot = {
			id: "slot-current-dialog",
			combo_id: "combo-shared",
			account_id: "account-current",
			model: "current-dialog-manual-model",
			priority: 3,
			enabled: true,
		};
		const stalePolicySlot: ComboSlot = {
			id: "slot-stale-effective",
			combo_id: "combo-shared",
			account_id: "account-stale-effective",
			model: "stale-effective-model",
			priority: 88,
			enabled: true,
		};
		const currentCombo: ComboWithSlots = {
			id: "combo-shared",
			name: "Current dialog combo",
			description: null,
			enabled: true,
			created_at: 1,
			updated_at: 2,
			slots: [currentSlot],
		};
		const staleEffective = view("opus", "managed");
		staleEffective.policy.slots = [stalePolicySlot];
		staleEffective.resolution.members = [
			member("opus", "account-stale-managed", "Stale managed peer", "managed"),
		];

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.accounts(), [
			{
				id: "account-current",
				name: "Current manual peer",
				provider: "anthropic",
			},
			{
				id: "account-stale-effective",
				name: "Stale effective peer",
				provider: "anthropic",
			},
		]);
		client.setQueryData(queryKeys.families(), {
			families: [assignment("fable", "manual")],
		});
		const effectiveKey = queryKeys.routingEffective();
		client.setQueryData(effectiveKey, [staleEffective]);
		const effectiveQuery = client
			.getQueryCache()
			.find({ queryKey: effectiveKey });
		effectiveQuery?.setState({
			status: "error",
			fetchStatus: "idle",
			error: new Error("controlled effective-routing refetch failure"),
		});

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={currentCombo} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Persisted Manual slots (1)");
		expect(html).toContain("Current manual peer");
		expect(html).toContain("current-dialog-manual-model");
		expect(html).toContain("fable · manual");
		expect(html).not.toContain("stale-effective-model");
		expect(html).not.toContain("Stale managed peer");
		expect(html).not.toContain("opus · managed");
		expect(html).not.toContain("Exclude Stale managed peer");
		expect(html).toContain("Authoritative routing could not be refreshed");
		expect(html).toContain(
			"Managed membership and exception actions are unavailable until retry succeeds.",
		);
		expect(html).toContain("Retry authoritative routing");
	});
});
