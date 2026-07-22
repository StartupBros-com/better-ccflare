import { describe, expect, it } from "bun:test";
import type {
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { buildComboFamilyRoutingStates, CombosTab } from "./CombosTab";
import { projectFamilyRoutings } from "./family-routing";

const combo: Combo & { slot_count: number } = {
	id: "combo-shared",
	name: "Shared priority route",
	description: null,
	enabled: true,
	created_at: 1,
	updated_at: 1,
	slot_count: 7,
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

function effectiveView(
	familyAssignment: ComboFamilyAssignment,
	manualCount: number,
	managedCount: number,
): EffectiveComboRoutingView {
	const family = familyAssignment.family;
	return {
		family,
		policy: {
			assignment: familyAssignment,
			combo,
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: combo.id,
			active: true,
			reason: "included",
			members: [
				...Array.from({ length: manualCount }, (_, index) => ({
					id: `${family}:manual:${index}`,
					account_id: `${family}-manual-${index}`,
					account_name: `${family} manual ${index}`,
					combo_id: combo.id,
					family,
					included: true as const,
					logical_model: `claude-${family}-manual`,
					tier: index,
					source: "manual" as const,
					reason: "included" as const,
					slot_id: `slot-${family}-${index}`,
					rule_id: null,
					availability: { available: true, reason: "available" as const },
					identity_provisional: false,
				})),
				...Array.from({ length: managedCount }, (_, index) => ({
					id: `${family}:managed:${index}`,
					account_id: `${family}-managed-${index}`,
					account_name: `${family} managed ${index}`,
					combo_id: combo.id,
					family,
					included: true as const,
					logical_model: `claude-${family}-managed`,
					tier: index,
					source: "managed" as const,
					reason: "included" as const,
					slot_id: null,
					rule_id: `rule-${family}`,
					availability: { available: true, reason: "available" as const },
					identity_provisional: false,
				})),
			],
			decisions: [],
		},
	};
}

describe("CombosTab managed routing overview", () => {
	it("joins every assigned family without treating a single family as representative", () => {
		const opus = assignment("opus", "managed");
		const fable = assignment("fable", "manual");
		const haiku = assignment("haiku", "managed");
		const projections = projectFamilyRoutings([
			effectiveView(opus, 1, 3),
			effectiveView(haiku, 0, 2),
		]);

		const states = buildComboFamilyRoutingStates(
			combo.id,
			[opus, fable],
			projections,
		);

		expect(states.map(({ assignment: item }) => item.family)).toEqual([
			"opus",
			"fable",
			"haiku",
		]);
		expect(states[0]?.routing?.managedMembers).toHaveLength(3);
		expect(states[1]?.routing).toBeNull();
		expect(states[2]?.assignment.managed_model).toBe("claude-haiku-managed");
	});

	it("passes every assigned family and each authoritative routing projection to the combo card", () => {
		const opus = assignment("opus", "managed");
		const fable = assignment("fable", "manual");
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.combos(), { combos: [combo] });
		client.setQueryData(queryKeys.families(), { families: [opus, fable] });
		client.setQueryData(queryKeys.routingEffective(), [
			effectiveView(opus, 1, 3),
			effectiveView(fable, 2, 0),
		]);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<CombosTab />
			</QueryClientProvider>,
		);

		expect(html).toContain("7 persisted Manual slots");
		expect(html).toContain("Opus");
		expect(html).toContain("Fable");
		expect(html).toContain("Managed mode");
		expect(html).toContain("Manual mode");
		expect(html).toContain("Logical model: claude-opus-managed");
		expect(html).toContain("Effective members: 4");
		expect(html).toContain("Effective members: 2");
	});
});
