import { describe, expect, it } from "bun:test";
import {
	createAutoCatalogEvidence,
	normalizeAutoModelCapabilities,
	resolveAutoModelTargets,
} from "./auto-model-capabilities";
import {
	captureAutoRequestRequirements,
	decideAutoContextFit,
	evaluateAutoRequestAdmission,
} from "./auto-request-admission";
import { CodexProvider } from "./providers/codex/provider";

function fixture(contextLimit = 100) {
	const now = Date.now();
	const catalog = createAutoCatalogEvidence({
		accountId: "a",
		provider: "anthropic",
		source: "live",
		fetchedAt: now,
		expiresAt: now + 60000,
		models: [
			{
				id: "claude-fable-5-1",
				capabilities: normalizeAutoModelCapabilities("anthropic", {
					max_input_tokens: contextLimit,
					max_tokens: 20,
					input_modalities: ["text"],
				}),
			},
		],
	});
	const target = resolveAutoModelTargets(catalog, "claude-fable").current;
	if (!catalog || !target) throw new Error("Invalid catalog fixture");
	return { catalog, target };
}
const body = {
	model: "auto",
	messages: [{ role: "user", content: "hello" }],
	max_tokens: 20,
};

describe("Auto request suitability (fixtures are not activation proof)", () => {
	it("admits native client tools with semantic JSON equality and harmless streaming changes", () => {
		const original = {
			...body,
			tools: [
				{
					name: "Read",
					input_schema: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		};
		expect(
			evaluateAutoRequestAdmission({
				...fixture(10000),
				requirements: captureAutoRequestRequirements(original),
				finalBody: {
					max_tokens: 20,
					messages: body.messages,
					tools: original.tools,
					model: "claude-fable-5-1",
					stream: true,
				},
			}).status,
		).toBe("admit");
	});
	it("admits the actual Codex text/client-tool adapter without discarding the original reserve", async () => {
		const original = {
			...body,
			model: "gpt-6-astra",
			system: "Keep all input.",
			messages: [
				{ role: "user", content: "Read a file." },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "Read",
							input: { path: "file.txt" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: "file contents",
						},
						{ type: "text", text: "Summarize it." },
					],
				},
			],
			tools: [
				{
					name: "Read",
					description: "Read a file",
					input_schema: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		};
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify(original),
				headers: { "content-type": "application/json" },
			}),
		);
		const finalBody = await transformed.json();
		expect(finalBody.max_output_tokens).toBeUndefined();
		const now = Date.now();
		const catalog = createAutoCatalogEvidence({
			accountId: "a",
			provider: "codex",
			source: "live",
			fetchedAt: now,
			expiresAt: now + 60000,
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", {
						context_window: 10000,
						max_context_window: 10000,
						max_output_tokens: 20,
						input_modalities: ["text"],
					}),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target) throw new Error("missing synthetic target");
		const input = {
			catalog,
			target,
			requirements: captureAutoRequestRequirements(original),
			finalBody,
		};
		expect(evaluateAutoRequestAdmission(input)).toMatchObject({
			status: "admit",
			accounting: { requestedOutput: 20 },
		});
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, tools: [] },
			}).status,
		).not.toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, input: [] },
			}).status,
		).not.toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, max_output_tokens: 19 },
			}),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
		const narrow = createAutoCatalogEvidence({
			accountId: "a",
			provider: "codex",
			source: "live",
			fetchedAt: now,
			expiresAt: now + 60000,
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", {
						context_window: 100,
						max_context_window: 10000,
						max_output_tokens: 20,
						input_modalities: ["text"],
					}),
				},
			],
		});
		const narrowTarget = resolveAutoModelTargets(narrow, "gpt-astra").current;
		if (!narrowTarget) throw new Error("missing narrow target");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				catalog: narrow,
				target: narrowTarget,
			}),
		).toMatchObject({ status: "reject", reason: "context-unsupported" });
	});
	it("admits ordinary native text with explicitly estimated envelope headroom", () => {
		const decision = evaluateAutoRequestAdmission({
			...fixture(10000),
			requirements: captureAutoRequestRequirements(body),
			finalBody: { ...body, model: "claude-fable-5-1" },
		});
		expect(decision).toMatchObject({
			status: "admit",
			accounting: {
				source: "local-envelope-v1",
				kind: "estimate",
				requestedOutput: 20,
			},
		});
	});
	it("uses the full 91-byte envelope, 1047 headroom, and original 20 output at the margin", () => {
		// Worked policy example: 91 + ceil(91 / 4) + 1024 + 20 = 1158.
		const request = {
			requirements: captureAutoRequestRequirements(body),
			finalBody: { ...body, model: "claude-fable-5-1" },
		};
		expect(
			evaluateAutoRequestAdmission({ ...fixture(1158), ...request }),
		).toMatchObject({
			status: "admit",
			accounting: {
				envelopeBytes: 91,
				inputEstimate: 91,
				headroom: 1047,
				requestedOutput: 20,
			},
		});
		expect(
			evaluateAutoRequestAdmission({ ...fixture(1157), ...request }),
		).toMatchObject({ status: "reject", reason: "context-unsupported" });
	});
	it("keeps unsupported local tool forms and unaccountable media unavailable", () => {
		for (const tools of [
			[{ type: "custom", name: "Read" }],
			[{ name: "Read", input_schema: { type: "object" }, defer_loading: true }],
			[{}],
		]) {
			const original = { ...body, tools };
			expect(
				evaluateAutoRequestAdmission({
					...fixture(10000),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: "claude-fable-5-1" },
				}).status,
			).not.toBe("admit");
		}
	});
	it("does not admit unrecognized or malformed content as ordinary local-tool text", () => {
		for (const block of [
			{ type: "tool_use", id: "call", name: "Read", input: "not-an-object" },
			{ type: "tool_result", content: "missing call identity" },
			{ type: "text", text: "hi", opaque_media: "unknown" },
		]) {
			const original = {
				...body,
				messages: [{ role: "assistant", content: [block] }],
			};
			expect(
				evaluateAutoRequestAdmission({
					...fixture(10000),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: "claude-fable-5-1" },
				}).status,
			).not.toBe("admit");
		}
	});
	it("preserves requested output at an exact arithmetic bound without clamping", () => {
		expect(
			decideAutoContextFit({
				inputUpperBound: 80,
				requestedOutput: 20,
				contextLimit: 100,
				outputLimit: 20,
			}).status,
		).toBe("admit");
		expect(
			decideAutoContextFit({
				inputUpperBound: 81,
				requestedOutput: 20,
				contextLimit: 100,
				outputLimit: 20,
			}),
		).toMatchObject({ status: "reject", reason: "context-unsupported" });
		for (const inputUpperBound of [null, -1, NaN, 1.5])
			expect(
				decideAutoContextFit({
					inputUpperBound,
					requestedOutput: 20,
					contextLimit: 100,
					outputLimit: 20,
				}).status,
			).toBe("unknown");
		expect(
			decideAutoContextFit({
				inputUpperBound: 80,
				requestedOutput: 21,
				contextLimit: 100,
				outputLimit: 20,
			}),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
	});
	it("never treats request token estimates or a current catalog as accounting proof", () => {
		const input = { ...body, input_tokens: 1 };
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements: captureAutoRequestRequirements(input),
				finalBody: { ...input, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "unknown", reason: "input-accounting-unknown" });
	});
	it("keeps native forced-tool vetoes even when translation removes tool choice", () => {
		const original = { ...body, tool_choice: { type: "any" } };
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...body, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "reject", reason: "tools-unsupported" });
	});
	it("does not hide unsupported original modalities behind translation", () => {
		const original = {
			...body,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "url", url: "https://example.invalid/image" },
						},
					],
				},
			],
		};
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...body, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "reject", reason: "modality-unsupported" });
	});
	it("rejects a lowered final output reserve and retains the original after caller mutation", () => {
		const original = structuredClone(body);
		const requirements = captureAutoRequestRequirements(original);
		original.max_tokens = 1;
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements,
				finalBody: { ...original, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
	});
	it("requires exact hosted-tool proof, not a supports_tools flag", () => {
		const original = {
			...body,
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		};
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...original, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "unknown", reason: "tools-unsupported" });
	});
	it("revalidates retained catalog freshness", () => {
		const { catalog, target } = fixture();
		expect(
			evaluateAutoRequestAdmission({
				catalog: { ...catalog, expiresAt: Date.now() - 1 },
				target,
				requirements: captureAutoRequestRequirements(body),
				finalBody: { ...body, model: target.physicalModel },
			}),
		).toMatchObject({ status: "unknown", reason: "catalog-evidence-stale" });
	});
});
