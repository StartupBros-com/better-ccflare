import { describe, expect, it, mock } from "bun:test";
import type {
	AccountResponse,
	AccountRoutingOverview,
	ComboFamily,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import type { PromptAdapter } from "../../prompts/adapter";
import {
	executeManagedRoutingCliCommand,
	ManagedRoutingCliUsageError,
	parseLegacyCliArguments,
	parseManagedRoutingCliCommand,
	preflightPostCreateManagedRouting,
} from "../../runner";
import type { ManagedRoutingControlPlane } from "../managed-routing-client";

function emptyClient(
	overrides: Partial<ManagedRoutingControlPlane> = {},
): ManagedRoutingControlPlane {
	const effective = {
		family: "opus",
		policy: {
			assignment: {
				family: "opus",
				combo_id: "combo-opus",
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			combo: null,
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family: "opus",
			combo_id: "combo-opus",
			active: true,
			reason: "included",
			members: [],
			decisions: [],
		},
	} as EffectiveComboRoutingView;
	return {
		getAccounts: mock(async () => [] as AccountResponse[]),
		getAccountRoutingOverview: mock(
			async () =>
				({ effective: [], opportunities: [] }) as AccountRoutingOverview,
		),
		listEffectiveRouting: mock(async () => [effective]),
		getEffectiveRouting: mock(async () => effective),
		previewAccountRouting: mock(async () => ({ families: [] })),
		previewFamilyRouting: mock(async () => ({
			preview_id: "preview-opus",
			scope: "family",
			family: "opus",
			managed_model: "claude-opus-4-8",
			proposals: [],
			effective,
		})),
		applyAccountRoutingProposal: mock(async () => effective),
		applyFamilyRoutingProposal: mock(async () => effective),
		rollbackFamilyToManual: mock(async (family: ComboFamily) => ({
			family,
			combo_id: `combo-${family}`,
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		})),
		...overrides,
	};
}

describe("shared managed-routing CLI parser", () => {
	it("does not misclassify a legacy argument value named routing", () => {
		expect(
			parseManagedRoutingCliCommand(["--add-account", "routing"], {
				interactive: false,
			}),
		).toBeNull();
	});

	it("parses the exact list/detail/preview/apply/manual syntax", () => {
		expect(
			parseManagedRoutingCliCommand(
				["routing", "list", "--api-url", "http://127.0.0.1:9191", "--json"],
				{ interactive: false },
			),
		).toMatchObject({ action: "list", json: true });
		expect(
			parseManagedRoutingCliCommand(["routing", "detail", "account-id"], {
				interactive: false,
			}),
		).toMatchObject({ action: "detail", accountId: "account-id" });
		expect(
			parseManagedRoutingCliCommand(
				["routing", "preview", "fable", "--managed-model", "fable-model"],
				{ interactive: false },
			),
		).toMatchObject({
			action: "preview",
			family: "fable",
			managedModel: "fable-model",
		});
		expect(
			parseManagedRoutingCliCommand(
				[
					"routing",
					"apply",
					"opus",
					"--preview-id",
					"preview-id",
					"--proposal-id",
					"proposal-id",
					"--managed-model",
					"opus-model",
					"--yes",
				],
				{ interactive: false },
			),
		).toMatchObject({
			action: "apply",
			family: "opus",
			previewId: "preview-id",
			proposalId: "proposal-id",
			managedModel: "opus-model",
			confirmed: true,
		});
		expect(
			parseManagedRoutingCliCommand(["routing", "manual", "haiku"], {
				interactive: true,
			}),
		).toMatchObject({ action: "manual", family: "haiku" });
	});

	it("rejects unknown families, flags, conflicting partial tuples, and unattended mutation", () => {
		for (const args of [
			["routing", "detail"],
			["routing", "preview", "unknown"],
			["routing", "list", "--proposal-id", "wrong-surface"],
			["routing", "list", "--admin-api-key", "secret"],
			["routing", "list", "--json", "--json"],
			["routing", "apply", "opus", "--preview-id", "partial"],
			["routing", "apply", "opus", "--yes"],
			["routing", "manual", "opus"],
		]) {
			expect(() =>
				parseManagedRoutingCliCommand(args, { interactive: false }),
			).toThrow(ManagedRoutingCliUsageError);
		}
	});

	it("requires --yes when an interactive apply supplies a reviewed tuple", () => {
		expect(() =>
			parseManagedRoutingCliCommand(
				[
					"routing",
					"apply",
					"opus",
					"--preview-id",
					"preview-id",
					"--proposal-id",
					"proposal-id",
					"--managed-model",
					"opus-model",
				],
				{ interactive: true },
			),
		).toThrow(ManagedRoutingCliUsageError);
	});

	it("parses the legacy hyphenated API URL and preflights environment URLs", () => {
		const parsed = parseLegacyCliArguments([
			"add",
			"new-account",
			"--api-url",
			"http://127.0.0.1:9191",
		]);
		expect(parsed.positionals).toEqual(["add", "new-account"]);
		expect(parsed.values["api-url"]).toBe("http://127.0.0.1:9191");

		expect(() =>
			preflightPostCreateManagedRouting({
				interactive: true,
				env: { BETTER_CCFLARE_API_URL: "https://example.com" },
			}),
		).toThrow(/loopback/i);
	});
});

describe("shared managed-routing CLI executor", () => {
	it("renders server-owned JSON from an injected live client", async () => {
		const api = emptyClient();
		const command = parseManagedRoutingCliCommand(
			["routing", "list", "--json"],
			{ interactive: false },
		);
		if (!command) throw new Error("expected routing command");

		const result = await executeManagedRoutingCliCommand(command, {
			client: api,
			interactive: false,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"kind": "list"');
		expect(api.getAccounts).toHaveBeenCalledTimes(1);
		expect(api.getAccountRoutingOverview).toHaveBeenCalledTimes(1);
	});

	it("maps an explicit decline to exit 2 and performs no rollback write", async () => {
		const api = emptyClient();
		const adapter: PromptAdapter = {
			select: mock(async () => "unused"),
			input: mock(async () => "unused"),
			confirm: mock(async () => false),
		};
		const command = parseManagedRoutingCliCommand(
			["routing", "manual", "opus"],
			{ interactive: true },
		);
		if (!command) throw new Error("expected routing command");

		const result = await executeManagedRoutingCliCommand(command, {
			client: api,
			interactive: true,
			prompt: adapter,
		});

		expect(result.exitCode).toBe(2);
		expect(result.output).toMatch(/declined/i);
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);
	});

	it("surfaces the exact interactive preview before select, confirm, and apply", async () => {
		const events: string[] = [];
		const seed = emptyClient();
		const view = await seed.getEffectiveRouting("opus");
		const api = emptyClient({
			previewFamilyRouting: mock(async () => {
				events.push("preview");
				return {
					preview_id: "preview-opus",
					scope: "family",
					family: "opus",
					managed_model: "claude-opus-4-8",
					effective: view,
					proposals: [
						{
							proposal_id: "proposal-opus",
							family: "opus",
							combo_id: "combo-opus",
							provider: "anthropic",
							route_class: "oauth-subscription",
							existing_rule_id: null,
							managed_model: "claude-opus-4-8",
							tier_source: "account_priority",
							high_confidence: true,
							selected_by_default: true,
							reason: "included",
							proposed_effective: view,
							member_delta: [],
						},
					],
				};
			}),
			applyFamilyRoutingProposal: mock(async () => {
				events.push("apply");
				return view;
			}),
		});
		const adapter: PromptAdapter = {
			select: mock(async () => {
				events.push("select");
				return "proposal-opus";
			}),
			input: mock(async () => "unused"),
			confirm: mock(async () => {
				events.push("confirm");
				return true;
			}),
		};
		const command = parseManagedRoutingCliCommand(
			["routing", "apply", "opus"],
			{ interactive: true },
		);
		if (!command) throw new Error("expected routing command");

		const result = await executeManagedRoutingCliCommand(command, {
			client: api,
			interactive: true,
			prompt: adapter,
			onReviewOutput: async (output) => {
				expect(output).toContain("preview=preview-opus");
				events.push("display");
			},
		});

		expect(result.exitCode).toBe(0);
		expect(events).toEqual([
			"preview",
			"display",
			"select",
			"confirm",
			"apply",
		]);
	});
});
