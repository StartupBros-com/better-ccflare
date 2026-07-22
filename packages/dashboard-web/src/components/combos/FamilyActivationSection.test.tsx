import { describe, expect, it, mock } from "bun:test";
import type {
	ComboFamilyAssignment,
	ComboRoutingPreviewResult,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import {
	buildManualFamilyPolicyUpdate,
	defaultManagedProposalId,
	FamilyActivationSection,
	familyPolicyMutationErrorMessage,
	getManagedModelOptions,
	previewMatchesPendingConversion,
	resolveAuthoritativeManagedModel,
	runManualFamilyRollback,
	runSerializedFamilyPolicyUpdate,
} from "./FamilyActivationSection";

function assignment(
	overrides: Partial<ComboFamilyAssignment> = {},
): ComboFamilyAssignment {
	return {
		family: "opus",
		combo_id: "combo-opus",
		enabled: true,
		membership_mode: "managed",
		managed_model: "claude-opus-custom",
		...overrides,
	};
}

describe("FamilyActivationSection managed policy controls", () => {
	it("serializes unresolved writes across families so completion order cannot overwrite the target", async () => {
		let resolveOpus: (() => void) | undefined;
		let resolveFable: (() => void) | undefined;
		const opusWrite = new Promise<void>((resolve) => {
			resolveOpus = resolve;
		});
		const fableWrite = new Promise<void>((resolve) => {
			resolveFable = resolve;
		});
		const update = mock((params: { family: string }) =>
			params.family === "opus" ? opusWrite : fableWrite,
		);
		const acceptedTargets: string[] = [];
		const lock = { current: false };

		const first = runSerializedFamilyPolicyUpdate(
			lock,
			"opus",
			{ family: "opus", enabled: true },
			update,
			(family) => acceptedTargets.push(family),
		);
		const blocked = runSerializedFamilyPolicyUpdate(
			lock,
			"fable",
			{ family: "fable", comboId: "combo-fable" },
			update,
			(family) => acceptedTargets.push(family),
		);

		expect(first).not.toBeNull();
		expect(blocked).toBeNull();
		expect(update).toHaveBeenCalledTimes(1);
		expect(acceptedTargets).toEqual(["opus"]);
		expect(lock.current).toBe(true);

		// Even if the blocked write's deferred result resolves first, it cannot
		// complete or replace the accepted target because it was never started.
		resolveFable?.();
		await Promise.resolve();
		expect(lock.current).toBe(true);
		expect(acceptedTargets).toEqual(["opus"]);

		resolveOpus?.();
		await first;
		expect(lock.current).toBe(false);

		const second = runSerializedFamilyPolicyUpdate(
			lock,
			"fable",
			{ family: "fable", comboId: "combo-fable" },
			update,
			(family) => acceptedTargets.push(family),
		);
		expect(second).not.toBeNull();
		await second;
		expect(update).toHaveBeenCalledTimes(2);
		expect(acceptedTargets).toEqual(["opus", "fable"]);
	});

	it("surfaces typed family-policy failures only for the exact family", () => {
		const emptyError = {
			message: "unprocessable",
			details: { code: "managed_route_empty" },
		};
		const staleError = {
			message: "conflict",
			details: { code: "stale_routing_preview" },
		};

		expect(familyPolicyMutationErrorMessage(emptyError, "opus", "opus")).toBe(
			"Managed mode was not enabled because the server found zero effective candidates. The family remains in its previous mode.",
		);
		expect(familyPolicyMutationErrorMessage(staleError, "opus", "opus")).toBe(
			"This preview is stale because routing changed. Refresh and review the current server proposal before applying.",
		);
		expect(
			familyPolicyMutationErrorMessage(emptyError, "opus", "fable"),
		).toBeNull();
	});

	it("keeps the generic family-policy failure fallback", () => {
		expect(
			familyPolicyMutationErrorMessage(
				new Error("unexpected transport detail"),
				"opus",
				"opus",
			),
		).toBe("The family policy was not changed. Try again.");
	});

	it("rolls back with a mode-only partial policy update", async () => {
		const update = mock(async () => assignment({ membership_mode: "manual" }));

		await runManualFamilyRollback("opus", update);

		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(buildManualFamilyPolicyUpdate("opus"));
		expect(buildManualFamilyPolicyUpdate("opus")).toEqual({
			family: "opus",
			membershipMode: "manual",
		});
	});

	it("does not fabricate combo, model, slot, rule, or exclusion fields on rollback", () => {
		const update = buildManualFamilyPolicyUpdate("opus");

		expect(Object.hasOwn(update, "comboId")).toBe(false);
		expect(Object.hasOwn(update, "enabled")).toBe(false);
		expect(Object.hasOwn(update, "managedModel")).toBe(false);
		expect(Object.hasOwn(update, "slots")).toBe(false);
		expect(Object.hasOwn(update, "rules")).toBe(false);
		expect(Object.hasOwn(update, "exclusions")).toBe(false);
	});

	it("uses family-filtered live catalog options and preserves a stored custom model", () => {
		const models = getManagedModelOptions(
			[
				{ id: "vendor/claude-opus-preview", displayName: "Live Opus" },
				{ id: "claude-opus-4-8", displayName: "Latest Opus" },
			],
			"claude-opus-custom",
		);

		expect(models).toEqual([
			{
				id: "claude-opus-custom",
				displayName: "claude-opus-custom",
			},
			{ id: "vendor/claude-opus-preview", displayName: "Live Opus" },
			{ id: "claude-opus-4-8", displayName: "Latest Opus" },
		]);
	});

	it("keeps the selector authoritative when a different draft model is canceled or rolled back", () => {
		const liveOptions = [
			{ id: "claude-opus-4-8", displayName: "Opus 4.8" },
			{ id: "claude-opus-preview", displayName: "Opus preview" },
		];
		const authoritative = assignment({ managed_model: "claude-opus-4-8" });

		// A preview selection is deliberately not an input to this projection.
		expect(resolveAuthoritativeManagedModel(authoritative, liveOptions)).toBe(
			"claude-opus-4-8",
		);
		expect(
			resolveAuthoritativeManagedModel(
				{ ...authoritative, membership_mode: "manual" },
				liveOptions,
			),
		).toBe("claude-opus-4-8");
	});

	it("accepts only a preview for the exact pending family and model", () => {
		const data = {
			family: "opus",
			managed_model: "claude-opus-4-8",
		} as ComboRoutingPreviewResult;

		expect(
			previewMatchesPendingConversion(data, {
				family: "opus",
				managedModel: "claude-opus-4-8",
			}),
		).toBe(true);
		expect(
			previewMatchesPendingConversion(data, {
				family: "fable",
				managedModel: "claude-opus-4-8",
			}),
		).toBe(false);
		expect(
			previewMatchesPendingConversion(data, {
				family: "opus",
				managedModel: "claude-opus-preview",
			}),
		).toBe(false);
	});

	it("never auto-selects ambiguous, low-confidence, or new-billing proposals", () => {
		const base = {
			proposal_id: "safe",
			selected_by_default: true,
			high_confidence: true,
			reason: "included",
		};
		const data = {
			proposals: [
				{ ...base, proposal_id: "ambiguous", reason: "ambiguous" },
				{ ...base, proposal_id: "billing", reason: "new_billing_class" },
				{ ...base, proposal_id: "low", high_confidence: false },
				base,
			],
		} as ComboRoutingPreviewResult;

		expect(defaultManagedProposalId(data)).toBe("safe");
		expect(
			defaultManagedProposalId({
				...data,
				proposals: data.proposals.slice(0, 3),
			}),
		).toBeNull();
	});

	it("renders Manual/Managed controls and the logical-model selector for every family", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.combos(), {
			combos: [
				{
					id: "combo-opus",
					name: "Opus priority",
					description: null,
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		queryClient.setQueryData(queryKeys.families(), {
			families: [assignment({ membership_mode: "manual" })],
		});

		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<FamilyActivationSection />
			</QueryClientProvider>,
		);

		expect(html).toContain("Manual uses only persisted slots");
		expect(html).toContain("Manual");
		expect(html).toContain("Managed");
		expect(html).toContain("Managed logical model");
		expect(html).toContain("Changing this model opens a fresh server preview");
		for (const [family, label] of [
			["fable", "Fable"],
			["opus", "Opus"],
			["sonnet", "Sonnet"],
			["haiku", "Haiku"],
		] as const) {
			expect(html).toContain(`aria-label="Enable ${label} family"`);
			expect(html).toContain(`aria-label="${label} active combo"`);
			expect(html).toContain(`aria-label="${label} managed logical model"`);
			expect(html).toContain(`id="${family}-managed-model"`);
		}
	});
});
