import { describe, expect, it, mock } from "bun:test";
import type {
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ComboCard, type ComboFamilyRoutingCardState } from "./ComboCard";
import type { FamilyRoutingProjection } from "./family-routing";

const combo: Combo = {
	id: "combo-shared",
	name: "Shared priority route",
	description: "Routes more than one model family",
	enabled: true,
	created_at: 1,
	updated_at: 1,
};

function assignment(
	family: ComboFamily,
	membershipMode: "manual" | "managed",
): ComboFamilyAssignment {
	return {
		family,
		combo_id: combo.id,
		enabled: true,
		membership_mode: membershipMode,
		managed_model:
			membershipMode === "managed" ? `claude-${family}-managed` : null,
	};
}

function routingState(
	family: ComboFamily,
	membershipMode: "manual" | "managed",
	manualMemberCount: number,
	managedMemberCount: number,
): ComboFamilyRoutingCardState {
	const familyAssignment = assignment(family, membershipMode);
	return {
		assignment: familyAssignment,
		routing: {
			family,
			assignment: familyAssignment,
			combo,
			manualSlots: [],
			manualMembers: Array.from({ length: manualMemberCount }, (_, index) => ({
				member: {
					id: `${family}:manual:${index}`,
					account_id: `${family}-manual-${index}`,
					account_name: `${family} manual ${index}`,
					combo_id: combo.id,
					family,
					included: true,
					logical_model: `claude-${family}-manual`,
					tier: index,
					source: "manual",
					reason: "included",
					slot_id: `slot-${family}-${index}`,
					rule_id: null,
					availability: { available: true, reason: "available" },
					identity_provisional: false,
				},
				sourceLabel: "Manual",
				reasonLabel: "Included",
				availabilityLabel: "Available",
				isManualOverride: false,
			})),
			managedMembers: Array.from(
				{ length: managedMemberCount },
				(_, index) => ({
					member: {
						id: `${family}:managed:${index}`,
						account_id: `${family}-managed-${index}`,
						account_name: `${family} managed ${index}`,
						combo_id: combo.id,
						family,
						included: true,
						logical_model: `claude-${family}-managed`,
						tier: index,
						source: "managed",
						reason: "included",
						slot_id: null,
						rule_id: `rule-${family}`,
						availability: { available: true, reason: "available" },
						identity_provisional: false,
					},
					sourceLabel: "Managed" as const,
					reasonLabel: "Included",
					availabilityLabel: "Available",
					isManualOverride: false,
				}),
			),
			decisions: [],
			rules: [],
			exclusions: [],
		} satisfies FamilyRoutingProjection,
	};
}

describe("ComboCard managed routing summary", () => {
	it("renders every assigned family and keeps persisted slots distinct from authoritative effective counts", () => {
		const html = renderToStaticMarkup(
			<ComboCard
				combo={combo}
				slotCount={9}
				familyRoutings={[
					routingState("opus", "managed", 1, 3),
					routingState("fable", "manual", 2, 0),
				]}
				onEdit={mock(() => undefined)}
				onDelete={mock(() => undefined)}
				onToggleEnabled={mock(() => undefined)}
			/>,
		);

		expect(html).toContain("9 persisted Manual slots");
		expect(html).toContain("Opus");
		expect(html).toContain("Fable");
		expect(html).toContain("Managed mode");
		expect(html).toContain("Manual mode");
		expect(html).toContain("Logical model: claude-opus-managed");
		expect(html).toContain('aria-label="Opus family routing"');
		expect(html).toContain(
			'aria-label="Opus authoritative effective membership"',
		);
		expect(html).toContain("Authoritative effective membership");
		expect(html).toContain("Manual members: 1");
		expect(html).toContain("Managed members: 3");
		expect(html).toContain("Effective members: 4");
		expect(html).toContain("Manual members: 2");
		expect(html).toContain("Managed members: 0");
		expect(html).toContain("Effective members: 2");
	});

	it("does not infer effective counts when the authoritative projection is unavailable", () => {
		const html = renderToStaticMarkup(
			<ComboCard
				combo={combo}
				slotCount={4}
				familyRoutings={[
					{ assignment: assignment("sonnet", "managed"), routing: null },
				]}
				onEdit={mock(() => undefined)}
				onDelete={mock(() => undefined)}
				onToggleEnabled={mock(() => undefined)}
			/>,
		);

		expect(html).toContain("4 persisted Manual slots");
		expect(html).toContain("Sonnet");
		expect(html).toContain("Effective membership unavailable");
		expect(html).not.toContain("Effective members: 4");
		expect(html).not.toContain(
			'aria-label="Sonnet authoritative effective membership"',
		);
		expect(html).toContain('aria-label="Shared priority route enabled"');
		expect(html).toContain('aria-label="Edit Shared priority route"');
		expect(html).toContain('aria-label="Delete Shared priority route"');
	});
});
