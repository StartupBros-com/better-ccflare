import { describe, expect, it } from "bun:test";
import {
	buildAccountModelMappings,
	buildDeviceSetupInitCommand,
} from "./AccountAddForm";

const source = await Bun.file(`${import.meta.dir}/AccountAddForm.tsx`).text();

describe("AccountAddForm provider contracts", () => {
	it("builds an exact durable command from the stable key and reviewed IDs", () => {
		const command = buildDeviceSetupInitCommand({
			name: "durable account",
			priority: 25,
			idempotencyKey: "stable-key-01",
			reviewed: [
				{ family: "opus", proposalId: "proposal-opus" },
				{ family: "fable", proposalId: "proposal-fable" },
			],
			apiKey: "must-not-leak",
			customEndpoint: "https://must-not-leak.example",
		} as Parameters<typeof buildDeviceSetupInitCommand>[0] & {
			apiKey: string;
			customEndpoint: string;
		});

		expect(command).toEqual({
			name: "durable account",
			priority: 25,
			idempotencyKey: "stable-key-01",
			reviewed: [
				{ family: "opus", proposalId: "proposal-opus" },
				{ family: "fable", proposalId: "proposal-fable" },
			],
		});
		expect(JSON.stringify(command)).not.toContain("must-not-leak");
	});

	it("uses durable status reads and leaves device routing finalization to the server", () => {
		expect(source).toContain("useDeviceSetupJob");
		expect(source).not.toContain("getQwenAuthStatus(");
		expect(source).not.toContain("getCodexAuthStatus(");
		expect(source).toContain("continues on the server");

		for (const handler of ["handleStartQwenAuth", "handleStartCodexAuth"]) {
			const start = source.indexOf(`const ${handler}`);
			const end = source.indexOf("\n\tconst ", start + 1);
			const body = source.slice(start, end);
			expect(body).toContain("idempotencyKey");
			expect(body).toContain("reviewed");
			expect(body).not.toContain("reconcileAccountRoutingSelections");
			expect(body).not.toContain("applyRoutingProposal");
		}
	});

	it("builds all four family mappings without retaining provider secrets", () => {
		const mappings = buildAccountModelMappings({
			fableModel: "provider/fable",
			opusModel: "provider/opus",
			sonnetModel: "provider/sonnet",
			haikuModel: "provider/haiku",
			apiKey: "must-not-leak",
			customEndpoint: "https://secret.example",
			name: "mutable-name",
		} as Parameters<typeof buildAccountModelMappings>[0] & {
			apiKey: string;
			customEndpoint: string;
			name: string;
		});

		expect(mappings).toEqual({
			fable: "provider/fable",
			opus: "provider/opus",
			sonnet: "provider/sonnet",
			haiku: "provider/haiku",
		});
		const serialized = JSON.stringify(mappings);
		expect(serialized).not.toContain("must-not-leak");
		expect(serialized).not.toContain("secret.example");
		expect(serialized).not.toContain("mutable-name");
	});

	it("requires every OAuth and direct completion callback to return and forward the identity", () => {
		const completionCallbacks = [
			"onCompleteAccount",
			"onAddZaiAccount",
			"onAddMinimaxAccount",
			"onAddMetaAccount",
			"onAddAnthropicCompatibleAccount",
			"onAddNanoGPTAccount",
			"onAddOpenAIAccount",
			"onAddVertexAIAccount",
			"onAddBedrockAccount",
			"onAddAlibabaCodingPlanAccount",
			"onAddKiloAccount",
			"onAddOpenRouterAccount",
			"onAddOllamaAccount",
			"onAddOllamaCloudAccount",
		] as const;

		for (const callback of completionCallbacks) {
			const declarationStart = source.indexOf(`${callback}:`);
			expect(declarationStart).toBeGreaterThanOrEqual(0);
			expect(source.slice(declarationStart, declarationStart + 700)).toContain(
				"Promise<AccountCreationIdentity>",
			);
			expect(source).toContain(`const identity = await ${callback}(`);
		}

		expect(source).toContain(
			"onSuccess: (identity: AccountCreationIdentity) => void",
		);
	});

	it("validates DeepSeek credentials before creation and unwinds every direct credential guard", () => {
		expect(source).toContain(
			'deepseek: "API key is required for DeepSeek accounts",',
		);

		const handlerStart = source.indexOf(
			"const handleAddAccount = async () => {",
		);
		expect(handlerStart).toBeGreaterThanOrEqual(0);
		const handlerEnd = source.indexOf(
			"\n\tconst handleCodeSubmit",
			handlerStart,
		);
		const handler = source.slice(handlerStart, handlerEnd);
		const credentialModes = [
			"zai",
			"minimax",
			"deepseek",
			"meta",
			"nanogpt",
			"kilo",
			"alibaba-coding-plan",
			"openrouter",
			"anthropic-compatible",
			"openai-compatible",
			"ollama-cloud",
		];

		for (const mode of credentialModes) {
			const branchStart = handler.indexOf(`newAccount.mode === "${mode}"`);
			expect(branchStart).toBeGreaterThanOrEqual(0);
			const nextBranch = handler.indexOf(
				"if (newAccount.mode ===",
				branchStart + 1,
			);
			const branch = handler.slice(
				branchStart,
				nextBranch === -1 ? undefined : nextBranch,
			);
			expect(branch).toContain("abortDirectCreation(");
		}
	});

	it("renders a Fable input everywhere the existing family mapping UI is shown", () => {
		const fableLabels = source.match(/Fable Model/g)?.length ?? 0;
		const opusLabels = source.match(/Opus Model/g)?.length ?? 0;

		expect(opusLabels).toBeGreaterThan(0);
		expect(fableLabels).toBe(opusLabels);
		expect(source).toContain('fableModel: ""');
	});
});
