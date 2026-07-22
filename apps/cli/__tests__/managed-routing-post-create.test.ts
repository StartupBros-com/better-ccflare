import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ManagedRoutingControlPlane,
	PromptAdapter,
} from "@better-ccflare/cli-commands";
import { handlePostCreateManagedRouting } from "@better-ccflare/cli-commands/runner";
import type {
	AccountResponse,
	ComboFamily,
	ComboRoutingPreviewResult,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";

function effective(family: ComboFamily): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: `combo-${family}`,
				enabled: true,
				membership_mode: "managed",
				managed_model: `model-${family}`,
			},
			combo: null,
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: `combo-${family}`,
			active: true,
			reason: "included",
			members: [],
			decisions: [],
		},
	};
}

function preview(
	family: ComboFamily,
	previewId: string,
): ComboRoutingPreviewResult {
	const view = effective(family);
	return {
		preview_id: previewId,
		scope: "account",
		family,
		managed_model: `model-${family}`,
		effective: view,
		proposals: [
			{
				proposal_id: `proposal-${family}`,
				family,
				combo_id: `combo-${family}`,
				provider: "anthropic",
				route_class: "oauth-subscription",
				existing_rule_id: null,
				managed_model: `model-${family}`,
				tier_source: "account_priority",
				high_confidence: true,
				selected_by_default: true,
				reason: "included",
				proposed_effective: view,
				member_delta: [
					{
						key: `delta-${family}`,
						status: "added",
						before: null,
						after: {
							key: `member-${family}`,
							account_id: "immutable-account-id",
							candidate_id: `candidate-${family}`,
							identity_provisional: false,
							source: "managed",
							tier: 1,
							logical_model: `model-${family}`,
							reason: "included",
						},
					},
				],
			},
		],
	};
}

function client(
	overrides: Partial<ManagedRoutingControlPlane> = {},
): ManagedRoutingControlPlane {
	return {
		getAccounts: mock(async () => [
			{
				id: identity.id,
				name: identity.name,
				provider: identity.provider,
				priority: 1,
				paused: false,
				requiresReauth: false,
				tokenStatus: "valid",
				rateLimitStatus: "Active",
			} as AccountResponse,
		]),
		getAccountRoutingOverview: mock(async () => ({
			effective: [],
			opportunities: [],
		})),
		listEffectiveRouting: mock(async () => []),
		getEffectiveRouting: mock(async (family) => effective(family)),
		previewAccountRouting: mock(async () => ({ families: [] })),
		previewFamilyRouting: mock(async ({ family }) => preview(family, "family")),
		applyAccountRoutingProposal: mock(async ({ family }) => effective(family)),
		applyFamilyRoutingProposal: mock(async ({ family }) => effective(family)),
		rollbackFamilyToManual: mock(async (family) => ({
			family,
			combo_id: `combo-${family}`,
			enabled: true,
			membership_mode: "manual",
			managed_model: `model-${family}`,
		})),
		...overrides,
	};
}

const identity = {
	id: "immutable-account-id",
	name: "New account",
	provider: "anthropic",
} as const;

describe("packaged CLI post-create managed-routing handoff", () => {
	it("captures every shipped add-account branch by exact returned identity", () => {
		const packagedSource = readFileSync(
			join(process.cwd(), "apps/cli/src/main.ts"),
			"utf8",
		);
		const legacySource = readFileSync(
			join(process.cwd(), "packages/cli-commands/src/runner.ts"),
			"utf8",
		);

		expect(
			packagedSource.match(/createdAccount = await addAccount\(/g),
		).toHaveLength(5);
		expect(packagedSource).toContain("identity: createdAccount");
		expect(legacySource).toContain("const createdAccount = await addAccount");
		expect(legacySource).toContain("identity: createdAccount");
	});

	it("prints the authoritative exact-ID routing detail and guidance without previewing or mutating when noninteractive", async () => {
		const api = client();
		const stdout: string[] = [];
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: false,
			json: false,
			client: api,
			io: { stdout: (line) => stdout.push(line), stderr: () => {} },
		});

		expect(result).toBe(0);
		expect(stdout.join("\n")).toContain(
			"New account (immutable-account-id) provider=anthropic priority=1",
		);
		expect(stdout.join("\n")).toContain(
			"routing: no memberships, decisions, or opportunities",
		);
		expect(stdout.join("\n")).toContain("routing detail immutable-account-id");
		expect(api.getAccounts).toHaveBeenCalledTimes(1);
		expect(api.getAccountRoutingOverview).toHaveBeenCalledTimes(1);
		expect(api.previewAccountRouting).toHaveBeenCalledTimes(0);
		expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);
	});

	it("preserves the validated custom API URL in noninteractive guidance shared by both entry points", async () => {
		const api = client();
		const stdout: string[] = [];
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: false,
			json: false,
			apiUrl: "http://127.0.0.1:9191/",
			client: api,
			io: { stdout: (line) => stdout.push(line), stderr: () => {} },
		});

		expect(result).toBe(0);
		expect(stdout).toContain(
			"Inspect this persisted account: better-ccflare routing detail immutable-account-id --api-url http://127.0.0.1:9191",
		);
		expect(stdout).toContain(
			"Review a family before applying: better-ccflare routing preview <family> --api-url http://127.0.0.1:9191",
		);

		const packagedSource = readFileSync(
			join(process.cwd(), "apps/cli/src/main.ts"),
			"utf8",
		);
		const legacySource = readFileSync(
			join(process.cwd(), "packages/cli-commands/src/runner.ts"),
			"utf8",
		);
		expect(packagedSource).toContain("{ apiUrl: parsed.apiUrl }");
		expect(legacySource).toContain("{ apiUrl }");
	});

	it("reports an incomplete authoritative read after persistence, preserves identity and guidance, and sends no mutation", async () => {
		const api = client({
			getAccounts: mock(async () => {
				throw new Error("control plane unavailable");
			}),
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: false,
			json: false,
			client: api,
			io: {
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
			},
		});

		expect(result).toBe(1);
		expect(stdout.join("\n")).toContain(
			"Created account New account with immutable ID immutable-account-id.",
		);
		expect(stdout.join("\n")).toContain("routing detail immutable-account-id");
		expect(stderr.join("\n")).toMatch(
			/post-create effective routing report is incomplete/i,
		);
		expect(stderr.join("\n")).not.toContain("control plane unavailable");
		expect(api.previewAccountRouting).toHaveBeenCalledTimes(0);
		expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
		expect(api.applyFamilyRoutingProposal).toHaveBeenCalledTimes(0);
		expect(api.rollbackFamilyToManual).toHaveBeenCalledTimes(0);
	});

	it("rejects credential-bearing post-create API URLs without echoing credentials", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: false,
			json: false,
			apiUrl: "http://leak-user:leak-password@localhost:8788",
			io: {
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
			},
		});

		expect(result).toBe(2);
		expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain(
			"leak-password",
		);
	});

	it("surfaces each current preview before selection and applies families with fresh revisions", async () => {
		const events: string[] = [];
		let revision = 1;
		const previewAccountRouting = mock(
			async ({ family }: { family?: ComboFamily }) => {
				events.push(`preview:${family ?? "all"}:rev${revision}`);
				if (!family) {
					return {
						families: [
							preview("opus", "rev1-opus"),
							preview("fable", "rev1-fable"),
						],
					};
				}
				return preview(family, `rev${revision}-${family}`);
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
				if (family === "fable" && previewId !== "rev2-fable") {
					throw new Error("stale preview should never be submitted");
				}
				revision += 1;
				return effective(family);
			},
		);
		const api = client({
			previewAccountRouting:
				previewAccountRouting as ManagedRoutingControlPlane["previewAccountRouting"],
			applyAccountRoutingProposal:
				applyAccountRoutingProposal as ManagedRoutingControlPlane["applyAccountRoutingProposal"],
		});
		let confirmationCount = 0;
		const prompt: PromptAdapter = {
			select: mock(async (message, options) => {
				const family = message.includes("opus") ? "opus" : "fable";
				events.push(`select:${family}`);
				return options[0]?.value as string;
			}),
			input: mock(async () => "unused"),
			confirm: mock(async () => {
				const family = confirmationCount === 0 ? "opus" : "fable";
				confirmationCount += 1;
				events.push(`confirm:${family}`);
				return true;
			}),
		};
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: true,
			json: false,
			client: api,
			prompt,
			io: {
				stdout: (line) => {
					if (line.includes("preview=rev1-opus")) events.push("display:opus");
					if (line.includes("preview=rev1-fable"))
						events.push("display-initial:fable");
					if (line.includes("preview=rev2-fable")) events.push("display:fable");
				},
				stderr: (line) => events.push(`error:${line}`),
			},
		});

		expect(result).toBe(0);
		expect(events.some((event) => event.startsWith("error:"))).toBe(false);
		expect(events.indexOf("display:opus")).toBeLessThan(
			events.indexOf("select:opus"),
		);
		expect(events.indexOf("select:opus")).toBeLessThan(
			events.indexOf("confirm:opus"),
		);
		expect(events.lastIndexOf("display:opus")).toBeLessThan(
			events.indexOf("confirm:opus"),
		);
		expect(events.indexOf("confirm:opus")).toBeLessThan(
			events.indexOf("apply:opus:rev1-opus"),
		);
		expect(events.indexOf("apply:opus:rev1-opus")).toBeLessThan(
			events.indexOf("preview:fable:rev2"),
		);
		expect(events.indexOf("display-initial:fable")).toBeLessThan(
			events.indexOf("select:fable"),
		);
		expect(events.indexOf("display:fable")).toBeLessThan(
			events.indexOf("confirm:fable"),
		);
		expect(events.indexOf("confirm:fable")).toBeLessThan(
			events.indexOf("apply:fable:rev2-fable"),
		);
		expect(applyAccountRoutingProposal).toHaveBeenCalledTimes(2);
	});

	it("fails closed when the live control plane is unavailable", async () => {
		const api = client({
			previewAccountRouting: mock(async () => {
				throw new Error("control plane unavailable");
			}),
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		const result = await handlePostCreateManagedRouting({
			identity,
			interactive: true,
			json: false,
			client: api,
			prompt: {
				select: async () => "unused",
				input: async () => "unused",
				confirm: async () => false,
			},
			io: {
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
			},
		});

		expect(result).toBe(1);
		expect(stderr.join("\n")).toMatch(/failed closed/i);
		expect(stdout.join("\n")).toContain("routing detail immutable-account-id");
		expect(api.applyAccountRoutingProposal).toHaveBeenCalledTimes(0);
	});
});
