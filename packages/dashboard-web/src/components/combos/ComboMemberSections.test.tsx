import { describe, expect, it, mock } from "bun:test";
import type {
	ComboMembershipDecisionView,
	ComboMembershipExclusion,
	ComboSlot,
	EffectiveComboMemberView,
} from "@better-ccflare/types";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedExclusionList } from "./ManagedExclusionList";
import {
	ManagedMemberList,
	type ManagedRoutingTarget,
} from "./ManagedMemberList";
import { ManualMemberRow } from "./ManualMemberRow";

function findElement(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
	if (Array.isArray(node)) {
		for (const child of node) {
			const match = findElement(child, predicate);
			if (match) return match;
		}
		return null;
	}
	if (!isValidElement<Record<string, unknown>>(node)) return null;
	if (predicate(node)) return node;
	return findElement(node.props.children as ReactNode, predicate);
}

function managedMember(
	overrides: Partial<EffectiveComboMemberView> = {},
): EffectiveComboMemberView {
	return {
		id: "managed-member-1",
		account_id: "account-managed",
		account_name: "Managed primary",
		combo_id: "combo-1",
		family: "opus",
		included: true,
		logical_model: "claude-opus-4-8",
		tier: 0,
		source: "managed",
		reason: "included",
		slot_id: null,
		rule_id: "rule-1",
		availability: { available: true, reason: "available" },
		identity_provisional: false,
		...overrides,
	};
}

function rejectedDecision(
	overrides: Partial<ComboMembershipDecisionView> = {},
): ComboMembershipDecisionView {
	return {
		account_id: "account-excluded",
		account_name: "Excluded peer",
		combo_id: "combo-1",
		family: "opus",
		included: false,
		logical_model: "claude-opus-4-8",
		tier: 8,
		source: null,
		reason: "excluded",
		slot_id: null,
		rule_id: "rule-1",
		availability: { available: false, reason: "paused" },
		identity_provisional: false,
		...overrides,
	};
}

describe("Combo managed member controls", () => {
	it("renders authoritative source, tier, reason, model, and availability", () => {
		const html = renderToStaticMarkup(
			<ManagedMemberList
				family="opus"
				members={[
					{
						member: managedMember(),
						sourceLabel: "Managed",
						reasonLabel: "Included",
						availabilityLabel: "Available",
						isManualOverride: false,
					},
				]}
				onExclude={() => undefined}
			/>,
		);

		expect(html).toContain("Opus managed members");
		expect(html).toContain("Managed primary");
		expect(html).toContain(">Managed<");
		expect(html).toContain("Tier 0");
		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("Included");
		expect(html).toContain("Available");
		expect(html).toContain('data-source="managed"');
	});

	it("excludes the exact account and family", () => {
		const onExclude = mock((_target: ManagedRoutingTarget) => undefined);
		const tree = ManagedMemberList({
			family: "opus",
			members: [
				{
					member: managedMember(),
					sourceLabel: "Managed",
					reasonLabel: "Included",
					availabilityLabel: "Available",
					isManualOverride: false,
				},
			],
			onExclude,
		});
		const button = findElement(
			tree,
			(element) =>
				element.props["aria-label"] ===
				"Exclude Managed primary from Opus managed routing",
		);

		expect(button).not.toBeNull();
		(button?.props.onClick as (() => void) | undefined)?.();
		expect(onExclude).toHaveBeenCalledWith({
			family: "opus",
			accountId: "account-managed",
		});
	});

	it("scopes pending and failed exclusion state to the exact account", () => {
		const html = renderToStaticMarkup(
			<ManagedMemberList
				family="opus"
				members={[
					{
						member: managedMember(),
						sourceLabel: "Managed",
						reasonLabel: "Included",
						availabilityLabel: "Available",
						isManualOverride: false,
					},
					{
						member: managedMember({
							id: "managed-member-2",
							account_id: "account-secondary",
							account_name: "Managed secondary",
						}),
						sourceLabel: "Managed",
						reasonLabel: "Included",
						availabilityLabel: "Available",
						isManualOverride: false,
					},
				]}
				onExclude={() => undefined}
				pendingTarget={{ family: "opus", accountId: "account-managed" }}
				errorTarget={{ family: "opus", accountId: "account-secondary" }}
				mutationPending
			/>,
		);

		expect(html).toContain("Excluding…");
		expect(html).toContain(
			"Exclude Managed secondary from Opus managed routing",
		);
		expect(html).toContain(
			"Could not exclude Managed secondary; authoritative membership is unchanged.",
		);
		expect(html).not.toContain(
			"Could not exclude Managed primary; authoritative membership is unchanged.",
		);
		expect(html.match(/disabled=""/g)).toHaveLength(2);
	});
});

describe("Combo exclusion and rejection controls", () => {
	it("shows rejected reasons and only offers restore for an exclusion", () => {
		const html = renderToStaticMarkup(
			<ManagedExclusionList
				family="opus"
				decisions={[
					{
						decision: rejectedDecision(),
						reasonLabel: "Excluded from managed routing",
						availabilityLabel: "Paused; membership is unchanged",
						isExcluded: true,
						isRejected: true,
					},
					{
						decision: rejectedDecision({
							account_id: "account-unsupported",
							account_name: "Unsupported peer",
							reason: "unsupported",
							availability: { available: true, reason: "available" },
						}),
						reasonLabel: "Logical model unsupported",
						availabilityLabel: "Available",
						isExcluded: false,
						isRejected: true,
					},
				]}
				onRestore={() => undefined}
			/>,
		);

		expect(html).toContain("Excluded and rejected accounts");
		expect(html).toContain("Excluded peer");
		expect(html).toContain("Excluded from managed routing");
		expect(html).toContain("Tier 8");
		expect(html).toContain("Paused; membership is unchanged");
		expect(html).toContain("Unsupported peer");
		expect(html).toContain("Logical model unsupported");
		expect(html).toContain("Restore Excluded peer to Opus managed routing");
		expect(html).not.toContain(
			"Restore Unsupported peer to Opus managed routing",
		);
	});

	it("restores the exact excluded account and family", () => {
		const onRestore = mock((_target: ManagedRoutingTarget) => undefined);
		const tree = ManagedExclusionList({
			family: "opus",
			decisions: [
				{
					decision: rejectedDecision(),
					reasonLabel: "Excluded from managed routing",
					availabilityLabel: "Paused; membership is unchanged",
					isExcluded: true,
					isRejected: true,
				},
			],
			onRestore,
		});
		const button = findElement(
			tree,
			(element) =>
				element.props["aria-label"] ===
				"Restore Excluded peer to Opus managed routing",
		);

		expect(button).not.toBeNull();
		(button?.props.onClick as (() => void) | undefined)?.();
		expect(onRestore).toHaveBeenCalledWith({
			family: "opus",
			accountId: "account-excluded",
		});
	});

	it("keeps a durable exclusion restorable when no current candidate decision exists", () => {
		const exclusion: ComboMembershipExclusion = {
			id: "exclusion-detached",
			family: "opus",
			combo_id: "combo-1",
			account_id: "account-detached",
			created_at: 1,
		};
		const onRestore = mock((_target: ManagedRoutingTarget) => undefined);
		const tree = ManagedExclusionList({
			family: "opus",
			decisions: [],
			exclusions: [exclusion],
			accountNameFor: () => "Detached excluded peer",
			onRestore,
		});
		const html = renderToStaticMarkup(tree);
		const button = findElement(
			tree,
			(element) =>
				element.props["aria-label"] ===
				"Restore Detached excluded peer to Opus managed routing",
		);

		expect(html).toContain("Detached excluded peer");
		expect(html).toContain("Stored exclusion");
		expect(html).toContain("Availability not currently resolved");
		expect(button).not.toBeNull();
		(button?.props.onClick as (() => void) | undefined)?.();
		expect(onRestore).toHaveBeenCalledWith({
			family: "opus",
			accountId: "account-detached",
		});
	});

	it("does not duplicate a manual override as a rejected managed candidate", () => {
		const html = renderToStaticMarkup(
			<ManagedExclusionList
				family="opus"
				decisions={[
					{
						decision: rejectedDecision({
							account_id: "account-manual",
							account_name: "Manual override peer",
							reason: "manual_override",
						}),
						reasonLabel: "Manual override",
						availabilityLabel: "Available",
						isExcluded: false,
						isRejected: true,
					},
				]}
				onRestore={() => undefined}
			/>,
		);

		expect(html).not.toContain("Manual override peer");
		expect(html).not.toContain('data-reason="manual_override"');
	});

	it("scopes a failed restore to the exact stored exclusion", () => {
		const exclusions: ComboMembershipExclusion[] = [
			{
				id: "exclusion-first",
				family: "opus",
				combo_id: "combo-1",
				account_id: "account-first",
				created_at: 1,
			},
			{
				id: "exclusion-second",
				family: "opus",
				combo_id: "combo-1",
				account_id: "account-second",
				created_at: 2,
			},
		];
		const html = renderToStaticMarkup(
			<ManagedExclusionList
				family="opus"
				decisions={[]}
				exclusions={exclusions}
				accountNameFor={(accountId) =>
					accountId === "account-first" ? "First excluded" : "Second excluded"
				}
				onRestore={() => undefined}
				errorTarget={{ family: "opus", accountId: "account-second" }}
				mutationPending
			/>,
		);

		expect(html).toContain(
			"Could not restore Second excluded; the stored exclusion is unchanged.",
		);
		expect(html).not.toContain(
			"Could not restore First excluded; the stored exclusion is unchanged.",
		);
		expect(html.match(/disabled=""/g)).toHaveLength(2);
	});
});

describe("Persisted manual member row", () => {
	it("keeps the editable persisted slot visibly distinct from managed members", () => {
		const slot: ComboSlot = {
			id: "slot-1",
			combo_id: "combo-1",
			account_id: "account-managed",
			model: "claude-opus-4-6",
			priority: 7,
			enabled: true,
		};
		const html = renderToStaticMarkup(
			<ManualMemberRow
				slot={slot}
				index={1}
				accountName="Managed primary"
				provider="anthropic"
				onPriorityChange={() => undefined}
				onRemove={() => undefined}
				isUpdatingPriority={false}
				isRemoving={false}
			/>,
		);

		expect(html).toContain("Managed primary");
		expect(html).toContain("anthropic");
		expect(html).toContain(">Manual<");
		expect(html).toContain("claude-opus-4-6");
		expect(html).toContain("Tier");
		expect(html).toContain('value="7"');
		expect(html).toContain('data-source="manual"');
		expect(html).toContain("Remove Managed primary");
	});

	it("labels the persisted slot as the explicit override and scopes row errors", () => {
		const slot: ComboSlot = {
			id: "slot-override",
			combo_id: "combo-1",
			account_id: "account-managed",
			model: "claude-opus-4-6",
			priority: 7,
			enabled: true,
		};
		const html = renderToStaticMarkup(
			<ManualMemberRow
				slot={slot}
				index={1}
				accountName="Managed primary"
				provider="anthropic"
				routingFacts={[
					{
						family: "opus",
						reasonLabel: "Manual override",
						availabilityLabel: "Available",
						isManualOverride: true,
					},
				]}
				onPriorityChange={() => undefined}
				onRemove={() => undefined}
				isUpdatingPriority={false}
				isRemoving={false}
				priorityError="Could not update this Manual slot tier."
			/>,
		);

		expect(html).toContain(">Manual override<");
		expect(html).toContain("Opus");
		expect(html).toContain("Available");
		expect(html).toContain("Could not update this Manual slot tier.");
	});
});
