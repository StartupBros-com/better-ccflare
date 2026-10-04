import { describe, expect, it } from "bun:test";
import { sanitizeQualityDecision } from "@better-ccflare/types";
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
import {
	captureCodexModelReasoningSnapshot,
	clearCodexAccountModelContextMetadata,
	estimateAnthropicAdmissionTokens,
	setCodexAccountModelContextMetadata,
} from "./request-capabilities";
import { CODEX_REASONING_RETENTION_PREFIX } from "./utils/codex-reasoning-retention";

function effortCatalog(
	levels: unknown = [{ effort: "high" }],
	accountId = "effort-owner",
) {
	const catalog = createAutoCatalogEvidence({
		accountId,
		provider: "codex",
		source: "live",
		fetchedAt: Date.now(),
		expiresAt: Date.now() + 60000,
		models: [
			{
				id: "gpt-6-astra",
				capabilities: normalizeAutoModelCapabilities("codex", {
					context_window: 10000,
					max_context_window: 10000,
					input_modalities: ["text"],
					supported_reasoning_levels: levels,
				}),
			},
		],
	});
	const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
	if (!catalog || !target) throw new Error("missing effort target");
	return { catalog, target };
}
async function translateEffort(
	original: Record<string, unknown>,
	supported = ["minimal", "low", "medium", "high", "xhigh", "max"],
	refreshed?: string[],
) {
	setCodexAccountModelContextMetadata("effort-owner", [
		{
			id: "gpt-6-astra",
			contextWindow: 10000,
			maxContextWindow: 10000,
			effectiveContextPercent: 100,
			supportedReasoningEfforts: supported,
		},
	]);
	const reasoningSnapshot = captureCodexModelReasoningSnapshot("effort-owner");
	if (refreshed) {
		setCodexAccountModelContextMetadata("effort-owner", [
			{
				id: "gpt-6-astra",
				contextWindow: 10000,
				maxContextWindow: 10000,
				effectiveContextPercent: 100,
				supportedReasoningEfforts: refreshed,
			},
		]);
		expect(
			captureCodexModelReasoningSnapshot("effort-owner")?.get("gpt-6-astra")
				?.supportedEfforts,
		).toEqual(refreshed);
		expect(reasoningSnapshot?.get("gpt-6-astra")?.supportedEfforts).toEqual(
			supported,
		);
	}
	clearCodexAccountModelContextMetadata("effort-owner");
	const transformed = await new CodexProvider().transformRequestBody(
		new Request("https://example.invalid/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(original),
		}),
		undefined,
		undefined,
		{ reasoningSnapshot },
	);
	return transformed.json();
}
const effortBody = {
	model: "gpt-6-astra",
	system: "Keep all input.",
	messages: [{ role: "user", content: "Read a file." }],
	max_tokens: 20,
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
describe("Codex Auto official effort preservation", () => {
	it("rejects malformed official configurations even with a valid translated effort", async () => {
		const finalBody = await translateEffort({
			...effortBody,
			output_config: { effort: "high" },
		});
		for (const output_config of [
			null,
			[],
			"high",
			1,
			{},
			{ effort: null },
			{ effort: [] },
			{ effort: 1 },
			{ effort: "" },
			{ effort: "unknown" },
			{ effort: "HIGH" },
			{ effort: " high " },
			{ effort: "high", format: {} },
			{ format: {} },
		]) {
			expect(
				evaluateAutoRequestAdmission({
					...effortCatalog(),
					finalBody,
					requirements: captureAutoRequestRequirements({
						...effortBody,
						output_config,
					}),
				}),
			).toMatchObject({
				status: "unknown",
				reason: "request-preservation-unknown",
			});
		}
	});
	it("does not compare final reasoning (the adapter owns the clamp; admission checks the original)", async () => {
		const original = { ...effortBody, output_config: { effort: "high" } };
		const finalBody = await translateEffort(original);
		for (const reasoning of [
			undefined,
			null,
			[],
			"high",
			{},
			{ effort: "low" },
			{ effort: 1 },
			{ effort: "high", summary: "auto" },
		]) {
			expect(
				evaluateAutoRequestAdmission({
					...effortCatalog(),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...finalBody, reasoning },
				}).status,
			).toBe("admit");
		}
	});
	it("never admits original legacy reasoning, alone or alongside official effort", async () => {
		for (const original of [
			{ ...effortBody, reasoning: { effort: "high" } },
			{
				...effortBody,
				output_config: { effort: "high" },
				reasoning: { effort: "high" },
			},
		]) {
			const finalBody = await translateEffort(original);
			expect(
				evaluateAutoRequestAdmission({
					...effortCatalog(),
					finalBody,
					requirements: captureAutoRequestRequirements(original),
				}).status,
			).not.toBe("admit");
		}
	});
	it("admits an effort the catalog list lacks or omits (the adapter clamps it)", async () => {
		const original = { ...effortBody, output_config: { effort: "high" } };
		const finalBody = await translateEffort(original);
		for (const levels of [
			null,
			[],
			"high",
			[{ effort: "low" }],
			[{ effort: "high" }, { effort: "unknown" }],
			[{}],
			[null],
			["high"],
			[{ effort: "HIGH" }],
		]) {
			expect(
				evaluateAutoRequestAdmission({
					...effortCatalog(levels),
					finalBody,
					requirements: captureAutoRequestRequirements(original),
				}).status,
			).toBe("admit");
		}
		const missing = effortCatalog();
		const missingCapabilities = normalizeAutoModelCapabilities("codex", {
			context_window: 10000,
			max_context_window: 10000,
			input_modalities: ["text"],
		});
		const catalog = createAutoCatalogEvidence({
			...missing.catalog,
			source: "live",
			models: [{ id: "gpt-6-astra", capabilities: missingCapabilities }],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!target) throw new Error("missing target");
		expect(
			evaluateAutoRequestAdmission({
				catalog,
				target,
				finalBody,
				requirements: captureAutoRequestRequirements(original),
			}).status,
		).toBe("admit");
	});
	it.each([
		["xhigh", "high"],
		["minimal", "low"],
		["max", "xhigh"],
	])("admits actual adapter clamp %s to %s (a deterministic stock transform)", async (effort, clamped) => {
		const original = { ...effortBody, output_config: { effort } };
		// The retained adapter generation differs from the newly published owned catalog.
		const finalBody = await translateEffort(original, [clamped], [effort]);
		expect(finalBody.reasoning).toEqual({ effort: clamped });
		expect(
			evaluateAutoRequestAdmission({
				...effortCatalog([{ effort }]),
				finalBody,
				requirements: captureAutoRequestRequirements(original),
			}).status,
		).toBe("admit");
	});
	it("rechecks account, exact target, support revision and expiry", async () => {
		const original = { ...effortBody, output_config: { effort: "high" } };
		const finalBody = await translateEffort(original);
		const evidence = effortCatalog();
		const input = {
			...evidence,
			finalBody,
			requirements: captureAutoRequestRequirements(original),
		};
		for (const catalog of [
			effortCatalog([{ effort: "high" }], "other-owner").catalog,
			effortCatalog([{ effort: "high" }, { effort: "max" }]).catalog,
			{ ...evidence.catalog, expiresAt: Date.now() },
		])
			expect(evaluateAutoRequestAdmission({ ...input, catalog })).toMatchObject(
				{ status: "unknown", reason: "catalog-evidence-stale" },
			);
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, model: "gpt-6.1-sol" },
			}).status,
		).not.toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, instructions: "changed" },
			}).status,
		).toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, input: [] },
			}).status,
		).toBe("admit");
	});
	it.each([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	])("admits exactly advertised %s through the real adapter", async (effort) => {
		const original = { ...effortBody, output_config: { effort } };
		const finalBody = await translateEffort(original);
		expect(finalBody.reasoning).toEqual({ effort });
		expect(finalBody.instructions).toBe(original.system);
		expect(finalBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Read a file." }] },
		]);
		expect(
			evaluateAutoRequestAdmission({
				...effortCatalog([{ effort }]),
				requirements: captureAutoRequestRequirements(original),
				finalBody,
			}),
		).toMatchObject({
			status: "admit",
			// translateEffort is not the subscription endpoint, so the wire keeps
			// max_output_tokens and stock reserves the caller's 20.
			accounting: {
				requestedOutput: 20,
				headroom: 0,
				outputLimit: { kind: "provider-managed" },
			},
		});
	});
});

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

describe("documented native Models capabilities reach request admission", () => {
	function native(
		raw: Record<string, unknown>,
		line = "claude-fable" as Parameters<typeof resolveAutoModelTargets>[1],
	) {
		const capabilities = normalizeAutoModelCapabilities("anthropic", raw);
		const catalog = createAutoCatalogEvidence({
			accountId: "native-fixture",
			provider: "anthropic",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [{ id: String(raw.id), capabilities }],
		});
		const target = resolveAutoModelTargets(catalog, line).current;
		return { catalog, target, capabilities };
	}
	const raw = {
		id: "claude-fable-5-1",
		max_input_tokens: 10000,
		max_tokens: 20,
	};
	it.each([
		["claude-fable-5-1", "claude-fable"],
		["claude-opus-5-5", "claude-opus"],
		["claude-sonnet-5-5", "claude-sonnet"],
		["claude-haiku-4-5", "claude-haiku"],
		["claude-haiku-4-5-20251001", "claude-haiku"],
	] as const)("admits baseline text for reviewed exact identity %s", (id, line) => {
		for (const capabilities of [
			undefined,
			{},
			{ image_input: { supported: false }, pdf_input: { supported: false } },
		]) {
			const evidence = native({ ...raw, id, capabilities }, line);
			if (!evidence.target) throw new Error("missing approved target");
			expect(evidence.capabilities.inputModalities).toEqual(["text"]);
			expect(
				evaluateAutoRequestAdmission({
					...evidence,
					target: evidence.target,
					requirements: captureAutoRequestRequirements(body),
					finalBody: { ...body, model: id },
				}),
			).toEqual({ status: "admit" });
		}
	});
	it("never grants baseline text or an approved target from a prefix or capacities", () => {
		for (const id of [
			"claude-fable-99",
			"claude-fable-5-1-unreviewed",
			"unknown",
			"",
		]) {
			const evidence = native({ ...raw, id });
			expect(evidence.capabilities.inputModalities ?? []).not.toContain("text");
			expect(evidence.target).toBeNull();
		}
	});
	it.each([
		[
			"image",
			"image_input",
			{
				type: "image",
				source: { type: "url", url: "https://example.invalid/image" },
			},
		],
		[
			"pdf",
			"pdf_input",
			{
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: "synthetic",
				},
			},
		],
	] as const)("native %s capability flags never gate admission (stock does not check modality)", (modality, key, block) => {
		for (const supported of [true, false, "true", 1, null, undefined]) {
			const evidence = native({
				...raw,
				capabilities: { [key]: { supported } },
			});
			if (!evidence.target) throw new Error("missing native target");
			expect(evidence.capabilities.inputModalities?.includes(modality)).toBe(
				supported === true,
			);
			const original = {
				...body,
				messages: [{ role: "user", content: [block] }],
			};
			expect(
				evaluateAutoRequestAdmission({
					...evidence,
					target: evidence.target,
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: raw.id },
				}),
			).toEqual({ status: "admit" });
		}
		for (const capabilities of [undefined, { [key]: { supported: false } }]) {
			const evidence = native({
				...raw,
				input_modalities: ["text", modality],
				capabilities,
			});
			if (!evidence.target) throw new Error("missing native target");
			const original = {
				...body,
				messages: [{ role: "user", content: [block] }],
			};
			expect(
				evaluateAutoRequestAdmission({
					...evidence,
					target: evidence.target,
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: raw.id },
				}),
			).toEqual({ status: "admit" });
		}
	});
	it("admits when native output or context capacity is unknown", () => {
		for (const field of ["max_tokens", "max_input_tokens"] as const) {
			const evidence = native({
				...raw,
				[field]: undefined,
				input_modalities: ["text"],
			});
			if (!evidence.target) throw new Error("missing native target");
			expect(
				evaluateAutoRequestAdmission({
					...evidence,
					target: evidence.target,
					requirements: captureAutoRequestRequirements(body),
					finalBody: { ...body, model: raw.id },
				}),
			).toEqual({ status: "admit" });
		}
	});
});

describe("Auto request suitability (fixtures are not activation proof)", () => {
	it("reserves what the wire carries, never the Codex catalog ceiling, with distinct limit diagnostics", async () => {
		const original = { ...body, model: "gpt-6-astra" };
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify(original),
				headers: { "content-type": "application/json" },
			}),
		);
		const subscriptionWire = await transformed.json();
		expect(subscriptionWire.max_output_tokens).toBeUndefined();
		// Stock's estimator, no headroom, and stock's wire reserve: nothing once
		// the subscription endpoint drops max_output_tokens, the caller's cap where
		// a custom endpoint keeps it. The catalog ceiling is never the reserve.
		const cap = original.max_tokens;
		const customWire = { ...subscriptionWire, max_output_tokens: cap };
		const inputEstimate = estimateAnthropicAdmissionTokens(original).tokens;
		const knownCeiling = original.max_tokens + 100;
		for (const [finalBody, ceiling] of [subscriptionWire, customWire].flatMap(
			(wire) =>
				[knownCeiling, undefined, null].map(
					(ceiling) => [wire, ceiling] as const,
				),
		)) {
			const reserve = finalBody === customWire ? original.max_tokens : 0;
			const exactFit = inputEstimate + reserve;
			for (const contextWindow of [exactFit, exactFit - 1]) {
				const catalog = createAutoCatalogEvidence({
					accountId: "codex-fixture",
					provider: "codex",
					source: "live",
					fetchedAt: Date.now(),
					expiresAt: Date.now() + 60000,
					models: [
						{
							id: original.model,
							capabilities: normalizeAutoModelCapabilities("codex", {
								context_window: contextWindow,
								max_context_window: contextWindow,
								input_modalities: ["text"],
								...(ceiling === undefined
									? {}
									: { max_output_tokens: ceiling }),
							}),
						},
					],
				});
				const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
				if (!catalog || !target) throw new Error("missing Codex target");
				expect(
					evaluateAutoRequestAdmission({
						catalog,
						target,
						finalBody,
						requirements: captureAutoRequestRequirements(original),
					}),
				).toMatchObject({
					...(contextWindow === exactFit
						? { status: "admit" }
						: { status: "reject", reason: "context-unsupported" }),
					accounting: {
						inputEstimate,
						headroom: 0,
						requestedOutput: reserve,
						outputLimit:
							ceiling === knownCeiling
								? { kind: "catalog", tokens: knownCeiling }
								: { kind: "provider-managed", tokens: null },
					},
				});
			}
		}
	});
	it.each([
		undefined,
		null,
	])("delegates an unpublished Codex output ceiling (%s), reserving zero like stock", async (ceiling) => {
		const original = { ...body, model: "gpt-6-astra" };
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify(original),
				headers: { "content-type": "application/json" },
			}),
		);
		const finalBody = await transformed.json();
		const catalog = createAutoCatalogEvidence({
			accountId: "codex-fixture",
			provider: "codex",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [
				{
					id: original.model,
					capabilities: normalizeAutoModelCapabilities("codex", {
						context_window: 10000,
						max_context_window: 10000,
						input_modalities: ["text"],
						...(ceiling === undefined ? {} : { max_output_tokens: ceiling }),
					}),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target) throw new Error("missing Codex target");
		expect(
			evaluateAutoRequestAdmission({
				catalog,
				target,
				finalBody,
				requirements: captureAutoRequestRequirements(original),
			}),
		).toMatchObject({
			status: "admit",
			// Subscription endpoint drops max_output_tokens: stock reserves 0.
			accounting: {
				requestedOutput: 0,
				outputLimit: { kind: "provider-managed", tokens: null },
			},
		});
		for (const invalid of [
			0,
			-1,
			1.5,
			"20",
			Number.MAX_SAFE_INTEGER + 1,
			{},
			undefined,
		]) {
			const malformed = createAutoCatalogEvidence({
				...catalog,
				source: "live",
				models: [
					{
						id: original.model,
						capabilities: normalizeAutoModelCapabilities("codex", {
							context_window: 10000,
							max_context_window: 10000,
							input_modalities: ["text"],
							max_output_tokens: invalid,
						}),
					},
				],
			});
			const malformedTarget = resolveAutoModelTargets(
				malformed,
				"gpt-astra",
			).current;
			if (!malformed || !malformedTarget)
				throw new Error("missing malformed target");
			expect(malformedTarget.capabilityRevision).not.toBe(
				target.capabilityRevision,
			);
			expect(
				evaluateAutoRequestAdmission({
					catalog: malformed,
					target: malformedTarget,
					finalBody,
					requirements: captureAutoRequestRequirements(original),
				}),
			).toMatchObject({
				// Stock never checks a malformed ceiling, and the subscription wire
				// carries no cap, so nothing is reserved.
				status: "admit",
				accounting: {
					requestedOutput: 0,
					outputLimit: { kind: "provider-managed", tokens: null },
				},
			});
		}
	});
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
	it("admits the actual Codex text/client-tool adapter and ignores the final tools and input", async () => {
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
			// The subscription wire carries no cap, so stock reserves nothing.
			accounting: { requestedOutput: 0 },
		});
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, tools: [] },
			}).status,
		).toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, input: [] },
			}).status,
		).toBe("admit");
		// An untranslated body (no Responses input) is still refused.
		const { input: _input, ...untranslated } = finalBody;
		expect(
			evaluateAutoRequestAdmission({ ...input, finalBody: untranslated }),
		).toMatchObject({
			status: "unknown",
			reason: "request-preservation-unknown",
		});
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
					// Stock's window is the maximum one, so narrow that.
					capabilities: normalizeAutoModelCapabilities("codex", {
						context_window: 100,
						max_context_window: 100,
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
	it("admits ordinary native text without claiming local token accounting", () => {
		const decision = evaluateAutoRequestAdmission({
			...fixture(10000),
			requirements: captureAutoRequestRequirements(body),
			finalBody: { ...body, model: "claude-fable-5-1" },
		});
		expect(decision).toEqual({ status: "admit" });
	});
	it("admits native tool schema variants the local contract used to refuse", () => {
		for (const tools of [
			[{ name: "Read", strict: true, input_schema: { type: "object" } }],
			[
				{
					name: "Read",
					input_schema: { type: "object" },
					defer_loading: "true",
				},
			],
			[{}],
		]) {
			const original = { ...body, tools };
			expect(
				evaluateAutoRequestAdmission({
					...fixture(10000),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: "claude-fable-5-1" },
				}).status,
			).toBe("admit");
		}
	});
	it("admits unrecognized or malformed native content (upstream validates it, as for stock)", () => {
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
			).toBe("admit");
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
	it("does not refuse native requests carrying extra request token claims", () => {
		const input = { ...body, input_tokens: 1 };
		expect(
			evaluateAutoRequestAdmission({
				...fixture(),
				requirements: captureAutoRequestRequirements(input),
				finalBody: { ...input, model: "claude-fable-5-1" },
			}),
		).toEqual({ status: "admit" });
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
	it("does not gate native admission on modality (stock sends images to the account)", () => {
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
		).toEqual({ status: "admit" });
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

const CODEX_A = { status: "admit" };
// Codex expectations follow the Codex-target contract (issue #429): shapes the
// adapter translates deterministically admit; lossy content stays refused.
const CODEX_B = { status: "admit" }; // context_management is ignored by the adapter
const CODEX_C = { status: "admit" }; // the adapter clamps effort, never refuses it
const CODEX_D = { status: "admit" }; // the adapter ignores the thinking budget
const CODEX_E = { status: "unknown", reason: "request-preservation-unknown" }; // image/PDF content is lost
const CODEX_F = { status: "unknown", reason: "request-preservation-unknown" };
const CODEX_G = { status: "unknown", reason: "tools-unsupported" };
const CODEX_H = { status: "admit" }; // an unknown window fails open, as stock does
const CODEX_I = { status: "reject", reason: "context-unsupported" };
describe("native Anthropic admission never refuses what stock routing would send", () => {
	const nativeRaw = {
		id: "claude-fable-5-1",
		max_input_tokens: 10000,
		max_tokens: 20000,
	};
	function nativeEvidence(raw: Record<string, unknown> = nativeRaw) {
		const catalog = createAutoCatalogEvidence({
			accountId: "native-parity",
			provider: "anthropic",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [
				{
					id: String(raw.id),
					capabilities: normalizeAutoModelCapabilities("anthropic", raw),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "claude-fable").current;
		if (!catalog || !target) throw new Error("missing native target");
		return { catalog, target };
	}
	async function codexEvidence(original: Record<string, unknown>) {
		const catalog = createAutoCatalogEvidence({
			accountId: "codex-parity",
			provider: "codex",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", {
						context_window: 10000,
						max_context_window: 10000,
						max_output_tokens: 20000,
						input_modalities: ["text"],
					}),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target) throw new Error("missing codex target");
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify({ ...original, model: "gpt-6-astra" }),
				headers: { "content-type": "application/json" },
			}),
		);
		return { catalog, target, finalBody: await transformed.json() };
	}
	const base = {
		model: "auto",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 20,
	};
	const imageMessages = [
		{
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "url", url: "https://example.invalid/i.png" },
				},
			],
		},
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "c1",
					content: [
						{
							type: "document",
							source: {
								type: "base64",
								media_type: "application/pdf",
								data: "synthetic",
							},
						},
					],
				},
			],
		},
	];
	// [name, original body, native final body (stock transform applied), codex expectation]
	const cases: [
		string,
		Record<string, unknown>,
		Record<string, unknown>,
		Record<string, unknown>,
	][] = [
		[
			"system cache_control gains ttl 1h after the snapshot",
			{
				...base,
				system: [
					{ type: "text", text: "s", cache_control: { type: "ephemeral" } },
				],
			},
			{
				...base,
				system: [
					{
						type: "text",
						text: "s",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			},
			CODEX_A,
		],
		[
			"clear_thinking edit stripped by stock when thinking is disabled",
			{
				...base,
				thinking: { type: "disabled" },
				context_management: {
					edits: [
						{ type: "clear_tool_uses_20250919" },
						{ type: "clear_thinking_20251015" },
					],
				},
			},
			{
				...base,
				thinking: { type: "disabled" },
				context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
			},
			CODEX_B,
		],
		[
			"output_config effort xhigh",
			{ ...base, output_config: { effort: "xhigh" } },
			{ ...base, output_config: { effort: "xhigh" } },
			CODEX_C,
		],
		[
			"thinking budget_tokens",
			{ ...base, thinking: { type: "enabled", budget_tokens: 8000 } },
			{ ...base, thinking: { type: "enabled", budget_tokens: 8000 } },
			CODEX_D,
		],
		[
			"image block and PDF inside tool_result",
			{ ...base, messages: imageMessages },
			{ ...base, messages: imageMessages },
			CODEX_E,
		],
		[
			"unknown top-level key",
			{ ...base, service_tier: "auto" },
			{ ...base, service_tier: "auto" },
			CODEX_F,
		],
		[
			"client tool with extra schema keys",
			{
				...base,
				tools: [
					{
						name: "Read",
						strict: true,
						cache_control: { type: "ephemeral" },
						input_schema: { type: "object" },
					},
				],
			},
			{
				...base,
				tools: [
					{
						name: "Read",
						strict: true,
						cache_control: { type: "ephemeral" },
						input_schema: { type: "object" },
					},
				],
			},
			CODEX_G,
		],
	];
	for (const [name, original, nativeFinal, codexExpected] of cases) {
		it(`admits on anthropic, codex per contract: ${name}`, async () => {
			expect(
				evaluateAutoRequestAdmission({
					...nativeEvidence(),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...nativeFinal, model: "claude-fable-5-1" },
				}),
			).toEqual({ status: "admit" });
			const codex = await codexEvidence(original);
			expect(
				evaluateAutoRequestAdmission({
					...codex,
					requirements: captureAutoRequestRequirements({
						...original,
						model: "gpt-6-astra",
					}),
				}),
			).toMatchObject(codexExpected);
		});
	}
	it("admits on anthropic when catalog window and output ceiling are unknown, codex admits too", async () => {
		const original = base;
		expect(
			evaluateAutoRequestAdmission({
				...nativeEvidence({ id: "claude-fable-5-1" }),
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...original, model: "claude-fable-5-1" },
			}),
		).toEqual({ status: "admit" });
		const codex = await codexEvidence(original);
		const catalog = createAutoCatalogEvidence({
			...codex.catalog,
			source: "live",
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", {
						input_modalities: ["text"],
					}),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!target) throw new Error("missing codex target");
		expect(
			evaluateAutoRequestAdmission({
				catalog,
				target,
				finalBody: codex.finalBody,
				requirements: captureAutoRequestRequirements(original),
			}),
		).toMatchObject(CODEX_H);
	});
	it("admits a multi-megabyte body on anthropic; codex keeps its context rejection", async () => {
		const original = {
			...base,
			messages: [{ role: "user", content: "x".repeat(4_000_000) }],
		};
		expect(
			evaluateAutoRequestAdmission({
				...nativeEvidence(),
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...original, model: "claude-fable-5-1" },
			}),
		).toEqual({ status: "admit" });
		const codex = await codexEvidence(original);
		expect(
			evaluateAutoRequestAdmission({
				...codex,
				requirements: captureAutoRequestRequirements({
					...original,
					model: "gpt-6-astra",
				}),
			}),
		).toMatchObject(CODEX_I);
	});
	it("admits when max_tokens is missing or invalid (no proven skip)", () => {
		for (const max_tokens of [undefined, 0, -1, 1.5, "20", null]) {
			const original = { ...base, max_tokens };
			expect(
				evaluateAutoRequestAdmission({
					...nativeEvidence(),
					requirements: captureAutoRequestRequirements(original),
					finalBody: { ...original, model: "claude-fable-5-1" },
				}),
			).toEqual({ status: "admit" });
		}
	});
	it("still rejects proven anthropic failures", () => {
		const evidence = nativeEvidence();
		const requirements = captureAutoRequestRequirements({
			...base,
			max_tokens: 20001,
		});
		expect(
			evaluateAutoRequestAdmission({
				...evidence,
				requirements,
				finalBody: { ...base, max_tokens: 20001, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
		expect(
			evaluateAutoRequestAdmission({
				...evidence,
				requirements: captureAutoRequestRequirements(base),
				finalBody: { ...base, max_tokens: 19, model: "claude-fable-5-1" },
			}),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
		expect(
			evaluateAutoRequestAdmission({
				...evidence,
				requirements: captureAutoRequestRequirements(base),
				finalBody: { ...base, model: "claude-opus-5-5" },
			}),
		).toMatchObject({ status: "reject", reason: "model-unsupported" });
		expect(
			evaluateAutoRequestAdmission({
				...evidence,
				requirements: captureAutoRequestRequirements({
					...base,
					tools: [{ type: "web_search_20250305", name: "web_search" }],
				}),
				finalBody: {
					...base,
					tools: [{ type: "web_search_20250305", name: "web_search" }],
					model: "claude-fable-5-1",
				},
			}),
		).toMatchObject({ status: "unknown", reason: "tools-unsupported" });
	});
});

describe("Codex Auto admits what the stock Codex route translates deterministically", () => {
	type Raw = Record<string, unknown>;
	const roomy: Raw = {
		context_window: 200000,
		max_context_window: 200000,
		max_output_tokens: 32000,
		input_modalities: ["text"],
	};
	async function evaluate(
		original: Record<string, unknown>,
		raw: Raw = roomy,
		mutateFinal?: (final: Record<string, unknown>) => Record<string, unknown>,
	) {
		const catalog = createAutoCatalogEvidence({
			accountId: "codex-contract",
			provider: "codex",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", raw),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target) throw new Error("missing codex target");
		// An adapter throw (invalid effort, unknown tool_choice) is swallowed by the
		// proxy, which then forwards the untranslated body. Stand in a translated
		// body so the original-side check is what refuses.
		const translated = await new CodexProvider()
			.transformRequestBody(
				new Request("https://chatgpt.com/backend-api/codex/responses", {
					method: "POST",
					body: JSON.stringify({ ...original, model: "gpt-6-astra" }),
					headers: { "content-type": "application/json" },
				}),
			)
			.then((response) => response.json())
			.catch(() => ({ model: "gpt-6-astra", input: [] }));
		return evaluateAutoRequestAdmission({
			catalog,
			target,
			finalBody: mutateFinal ? mutateFinal(translated) : translated,
			requirements: captureAutoRequestRequirements({
				...original,
				model: "gpt-6-astra",
			}),
		});
	}
	const base = {
		model: "auto",
		system: [
			{ type: "text", text: "sys", cache_control: { type: "ephemeral" } },
		],
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16000,
	};
	const readTool = {
		name: "Read",
		description: "Read",
		input_schema: { type: "object", properties: { path: { type: "string" } } },
	};
	const png = { type: "base64", media_type: "image/png", data: "x" };
	const assistantTurn = (content: unknown[]) => [
		{ role: "user", content: "hi" },
		{ role: "assistant", content },
		{ role: "user", content: "next" },
	];
	const admits: [string, Record<string, unknown>, Raw?][] = [
		[
			"assistant adaptive thinking with signature",
			{
				...base,
				messages: assistantTurn([
					{ type: "thinking", thinking: "hmm", signature: "sig" },
					{ type: "text", text: "answer" },
				]),
			},
		],
		[
			"non-minted redacted_thinking",
			{
				...base,
				messages: assistantTurn([
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "text", text: "answer" },
				]),
			},
		],
		[
			"proxy-minted retention redacted_thinking",
			{
				...base,
				messages: assistantTurn([
					{
						type: "redacted_thinking",
						data: `${CODEX_REASONING_RETENTION_PREFIX}rs_abc123.cipher`,
					},
					{ type: "text", text: "answer" },
				]),
			},
		],
		[
			"top-level thinking and context_management",
			{
				...base,
				thinking: { type: "adaptive" },
				context_management: {
					edits: [{ type: "clear_thinking_20251015", keep: "all" }],
				},
			},
		],
		[
			"effort xhigh with no catalog effort list",
			{ ...base, output_config: { effort: "xhigh" } },
		],
		[
			"effort xhigh with a list lacking it",
			{ ...base, output_config: { effort: "xhigh" } },
			{ ...roomy, supported_reasoning_levels: [{ effort: "high" }] },
		],
		[
			"tool schema with $schema, format uri and a lookaround pattern",
			{
				...base,
				tools: [
					{
						name: "Fetch",
						description: "Fetch",
						input_schema: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "object",
							properties: {
								url: { type: "string", format: "uri" },
								name: { type: "string", pattern: "^(?!foo)(?<=a)b+$" },
							},
						},
					},
				],
			},
		],
		[
			"tool_use input the adapter sanitizes",
			{
				...base,
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_1",
								name: "Read",
								input: { path: "a.txt", limit: null },
							},
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "call_1", content: "ok" },
						],
					},
				],
				tools: [readTool],
			},
		],
		[
			"defer_loading tools",
			{ ...base, tools: [{ ...readTool, defer_loading: true }] },
		],
		[
			"sampling and stop keys the adapter ignores",
			{
				...base,
				temperature: 0.2,
				top_p: 0.9,
				top_k: 5,
				stop_sequences: ["END"],
			},
		],
		[
			"Agent and Task tools plus tool_choice",
			{
				...base,
				tools: [
					readTool,
					{ ...readTool, name: "Agent" },
					{ ...readTool, name: "Task" },
				],
				tool_choice: { type: "auto", disable_parallel_tool_use: true },
			},
		],
		[
			"final-turn Skill tool_result",
			{
				...base,
				messages: [
					{ role: "user", content: "use the skill" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_s",
								name: "Skill",
								input: { skill: "demo" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_s",
								content: [{ type: "text", text: "skill body" }],
							},
						],
					},
				],
				tools: [{ ...readTool, name: "Skill" }],
			},
		],
		[
			// The adapter serializes these intact as JSON text (provider.fidelity.test.ts).
			"ToolSearch tool_reference results",
			{
				...base,
				tools: [
					{ ...readTool, name: "ToolSearch" },
					{ ...readTool, name: "TaskCreate", defer_loading: true },
				],
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_search",
								name: "ToolSearch",
								input: { query: "select:TaskCreate" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_search",
								content: [{ type: "tool_reference", tool_name: "TaskCreate" }],
							},
						],
					},
				],
			},
		],
		[
			"missing max_tokens",
			{ model: "auto", messages: [{ role: "user", content: "hi" }] },
		],
		[
			"text-only content with no catalog modality list",
			base,
			{ context_window: 200000, max_context_window: 200000 },
		],
	];
	for (const [name, original, raw] of admits)
		it(`admits: ${name}`, async () => {
			expect(await evaluate(original, raw)).toMatchObject({ status: "admit" });
		});
	it("admission does not depend on the final tools, input or instructions", async () => {
		const original = {
			...base,
			tools: [readTool, { ...readTool, name: "Agent" }],
		};
		expect(
			await evaluate(original, roomy, (final) => ({
				...final,
				tools: [],
				input: [],
				instructions: "changed",
				tool_choice: "required",
			})),
		).toMatchObject({ status: "admit" });
	});
	const refuses: [string, Record<string, unknown>, Raw?][] = [
		[
			"image message block",
			{
				...base,
				messages: [{ role: "user", content: [{ type: "image", source: png }] }],
			},
			{ context_window: 200000, max_context_window: 200000 },
		],
		[
			"image inside a tool_result",
			{
				...base,
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "c1",
								content: [{ type: "image", source: png }],
							},
						],
					},
				],
			},
		],
		[
			"PDF document",
			{
				...base,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "document",
								source: {
									type: "base64",
									media_type: "application/pdf",
									data: "x",
								},
							},
						],
					},
				],
			},
			{ context_window: 200000, max_context_window: 200000 },
		],
		[
			"server_tool_use in history",
			{
				...base,
				messages: assistantTurn([
					{ type: "server_tool_use", id: "s1", name: "web_search", input: {} },
				]),
			},
		],
		[
			"web_search_tool_result in history",
			{
				...base,
				messages: assistantTurn([
					{ type: "web_search_tool_result", tool_use_id: "s1", content: [] },
				]),
			},
		],
		[
			"non-text system block",
			{
				...base,
				system: [
					{
						type: "image",
						source: { type: "url", url: "https://x.invalid/i" },
					},
				],
			},
		],
		[
			"unknown block type",
			{
				...base,
				messages: [{ role: "user", content: [{ type: "mystery", text: "x" }] }],
			},
		],
		["unknown top-level key", { ...base, service_tier: "auto" }],
		[
			"output_config with an extra key",
			{ ...base, output_config: { effort: "high", format: {} } },
		],
		[
			"invalid effort value",
			{ ...base, output_config: { effort: "ludicrous" } },
		],
		[
			"thinking block in a user message",
			{
				...base,
				messages: [
					{
						role: "user",
						content: [{ type: "thinking", thinking: "x", signature: "s" }],
					},
				],
			},
		],
		[
			"tool_choice naming an unknown tool",
			{
				...base,
				tool_choice: { type: "tool", name: "Nope" },
				tools: [readTool],
			},
		],
	];
	for (const [name, original, raw] of refuses)
		it(`still refuses lossy content: ${name}`, async () => {
			const decision = await evaluate(original, raw);
			expect(decision.status).toBe("unknown");
			// Hosted-tool blocks in history take the unchanged hosted-tool path first.
			if (!/server_tool_use|web_search_tool_result/.test(name))
				expect(decision).toMatchObject({
					reason: "request-preservation-unknown",
				});
			else expect(decision).toMatchObject({ reason: "tools-unsupported" });
		});
	it("rejects an image when the catalog lists only text", async () => {
		expect(
			await evaluate({
				...base,
				messages: [{ role: "user", content: [{ type: "image", source: png }] }],
			}),
		).toMatchObject({ status: "reject", reason: "modality-unsupported" });
	});
	it("refuses an untranslated final body", async () => {
		for (const mutate of [
			(f: Record<string, unknown>) => ({ ...f, messages: [] }),
			(f: Record<string, unknown>) => {
				const { input: _input, ...rest } = f;
				return rest;
			},
		])
			expect(await evaluate(base, roomy, mutate)).toMatchObject({
				status: "unknown",
				reason: "request-preservation-unknown",
			});
	});
	it("still rejects a mismatched model, a lowered final cap and an over-ceiling request", async () => {
		expect(
			await evaluate(base, roomy, (f) => ({ ...f, model: "gpt-6.1-sol" })),
		).toMatchObject({ status: "reject", reason: "model-unsupported" });
		expect(
			await evaluate(base, roomy, (f) => ({ ...f, max_output_tokens: 3 })),
		).toMatchObject({ status: "reject", reason: "output-unsupported" });
		expect(await evaluate({ ...base, max_tokens: 40000 })).toMatchObject({
			status: "reject",
			reason: "output-unsupported",
		});
	});
	it("does not admit a provider that is neither codex nor anthropic", () => {
		const catalog = createAutoCatalogEvidence({
			accountId: "other",
			provider: "codex",
			source: "live",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			models: [
				{
					id: "gpt-6-astra",
					capabilities: normalizeAutoModelCapabilities("codex", roomy),
				},
			],
		});
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target) throw new Error("missing target");
		expect(
			evaluateAutoRequestAdmission({
				catalog,
				target: { ...target, provider: "other" } as never,
				finalBody: { model: "gpt-6-astra", input: [] },
				requirements: captureAutoRequestRequirements(base),
			}).status,
		).not.toBe("admit");
	});
	describe("context fit uses the stock estimator", () => {
		const text = {
			...base,
			messages: [{ role: "user", content: "x".repeat(900) }],
		};
		const estimateOf = (original: Record<string, unknown>) =>
			estimateAnthropicAdmissionTokens({ ...original, model: "gpt-6-astra" })
				.tokens;
		// A custom (API-compatible) endpoint keeps the translated cap on the wire.
		const cap = base.max_tokens;
		const customWire = (final: Record<string, unknown>) => ({
			...final,
			max_output_tokens: cap,
		});
		it("reserves the cap a custom endpoint keeps on the wire and records zero headroom", async () => {
			const estimate = estimateOf(text);
			const exact = estimate + base.max_tokens;
			for (const [window, expected] of [
				[exact, "admit"],
				[exact - 1, "reject"],
			] as const) {
				const decision = await evaluate(
					text,
					{ ...roomy, context_window: window, max_context_window: window },
					customWire,
				);
				expect(decision.status).toBe(expected);
				if (expected === "reject")
					expect(decision).toMatchObject({ reason: "context-unsupported" });
				expect(decision).toMatchObject({
					accounting: {
						source: "stock-codex-estimate-v1",
						kind: "estimate",
						inputEstimate: estimate,
						headroom: 0,
						requestedOutput: base.max_tokens,
						outputLimit: { kind: "catalog", tokens: 32000 },
					},
				});
			}
		});
		it("subscription (provider-managed output) reserves zero", async () => {
			const estimate = estimateOf(text);
			const raw = {
				context_window: estimate,
				max_context_window: estimate,
				input_modalities: ["text"],
			};
			expect(await evaluate(text, raw)).toMatchObject({
				status: "admit",
				accounting: {
					requestedOutput: 0,
					headroom: 0,
					outputLimit: { kind: "provider-managed", tokens: null },
				},
			});
			expect(
				await evaluate(text, {
					...raw,
					context_window: estimate - 1,
					max_context_window: estimate - 1,
				}),
			).toMatchObject({ status: "reject", reason: "context-unsupported" });
		});
		it("reserves nothing once the subscription endpoint drops the cap, whatever the catalog ceiling", async () => {
			// Stock admitConcreteCodexModel reserves 0 on the subscription endpoint
			// because transformRequestBody deletes max_output_tokens there.
			const estimate = estimateOf(text);
			const decision = await evaluate(text, {
				...roomy,
				context_window: estimate,
				max_context_window: estimate,
			});
			expect(decision).toMatchObject({
				status: "admit",
				accounting: {
					requestedOutput: 0,
					outputLimit: { kind: "catalog", tokens: 32000 },
				},
			});
		});
		it("uses stock's window: the maximum window at the effective percent", async () => {
			// resolveModelContextCapability: floor(max_context_window * percent / 100).
			// A smaller current context_window does not shrink it.
			const estimate = estimateOf(text);
			const raw = {
				...roomy,
				context_window: 10,
				max_context_window: estimate * 2,
				effective_context_window_percent: 50,
			};
			expect(await evaluate(text, raw)).toMatchObject({ status: "admit" });
			expect(
				await evaluate(text, { ...raw, max_context_window: estimate * 2 - 2 }),
			).toMatchObject({ status: "reject", reason: "context-unsupported" });
		});
		it("an over-window request rejects context-unsupported", async () => {
			expect(
				await evaluate(
					{ ...base, messages: [{ role: "user", content: "x".repeat(40000) }] },
					{ ...roomy, context_window: 1000, max_context_window: 1000 },
				),
			).toMatchObject({ status: "reject", reason: "context-unsupported" });
		});
		it("an unknown window admits with no context check", async () => {
			const decision = await evaluate(
				{ ...base, messages: [{ role: "user", content: "x".repeat(40000) }] },
				{ input_modalities: ["text"] },
			);
			expect(decision).toMatchObject({ status: "admit" });
			expect(decision).not.toHaveProperty("accounting");
		});
		it("accounting passes the types validator", async () => {
			for (const raw of [roomy, { ...roomy, max_output_tokens: undefined }]) {
				const decision = await evaluate(text, raw);
				const record = sanitizeQualityDecision({
					version: 1,
					policyRevision: "quality-policy-v1:test",
					requested: { kind: "main", preference: "auto" },
					selected: null,
					skippedLanes: [],
					accounting: (decision as { accounting?: unknown }).accounting,
				});
				expect(record?.accounting).toBeDefined();
			}
		});
	});
});
