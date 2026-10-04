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
import {
	captureCodexModelReasoningSnapshot,
	clearCodexAccountModelContextMetadata,
	setCodexAccountModelContextMetadata,
} from "./request-capabilities";

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
	it("rejects missing, malformed, changed or extra final reasoning", async () => {
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
			).not.toBe("admit");
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
	it("unchanged wire effort cannot replace missing, malformed or unsupported catalog support", async () => {
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
			).not.toBe("admit");
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
		).not.toBe("admit");
	});
	it.each([
		["xhigh", "high"],
		["minimal", "low"],
		["max", "xhigh"],
	])("rejects actual adapter clamp %s to %s despite current support", async (effort, clamped) => {
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
		).not.toBe("admit");
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
		).not.toBe("admit");
		expect(
			evaluateAutoRequestAdmission({
				...input,
				finalBody: { ...finalBody, input: [] },
			}).status,
		).not.toBe("admit");
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
			accounting: {
				requestedOutput: 20,
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
	it("reserves caller output, not the Codex catalog ceiling, with distinct limit diagnostics", async () => {
		const original = { ...body, model: "gpt-6-astra" };
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify(original),
				headers: { "content-type": "application/json" },
			}),
		);
		const finalBody = await transformed.json();
		expect(finalBody.max_output_tokens).toBeUndefined();
		const envelopeBytes = new TextEncoder().encode(
			JSON.stringify(finalBody),
		).length;
		const headroom = Math.ceil(envelopeBytes / 4) + 1024;
		const exactFit = envelopeBytes + headroom + original.max_tokens;
		const knownCeiling = original.max_tokens + 100;
		for (const ceiling of [knownCeiling, undefined, null]) {
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
						inputEstimate: envelopeBytes,
						headroom,
						requestedOutput: original.max_tokens,
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
	])("delegates an unpublished Codex output ceiling (%s) without losing the reserve", async (ceiling) => {
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
			accounting: {
				requestedOutput: 20,
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
			).toMatchObject({ status: "unknown", reason: "output-unsupported" });
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

describe("Auto advisor admission is decided by first-party status", () => {
	const advisorTool = {
		type: "advisor_20260301",
		name: "advisor",
		model: "claude-opus-5-5",
	};
	const clientTool = {
		name: "Read",
		input_schema: { type: "object", properties: {} },
	};
	const advisorHistory = [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: [
				{
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "advisor",
					input: {},
				},
				{
					type: "advisor_tool_result",
					tool_use_id: "srvtoolu_1",
					content: { type: "advisor_result", text: "use a map" },
				},
				{ type: "text", text: "done" },
			],
		},
		{ role: "user", content: "continue" },
	];
	const decide = (original: Record<string, unknown>, firstParty?: boolean) =>
		evaluateAutoRequestAdmission({
			...fixture(10000),
			requirements: captureAutoRequestRequirements(original),
			finalBody: { ...original, model: "claude-fable-5-1" },
			...(firstParty === undefined ? {} : { firstPartyAnthropic: firstParty }),
		});

	it("admits the advisor declaration beside client tools on a first-party candidate", () => {
		expect(
			decide({ ...body, tools: [clientTool, advisorTool] }, true).status,
		).toBe("admit");
	});
	it("admits advisor-only history on a first-party candidate", () => {
		expect(decide({ ...body, messages: advisorHistory }, true).status).toBe(
			"admit",
		);
	});
	it("admits advisor history with extra keys on a first-party candidate, as stock routing sends it", () => {
		// #430: native admission applies only proven rejections, no shape check.
		// cache_control is the extra key Claude Code actually sends.
		for (const extra of [
			{ cache_control: { type: "ephemeral" } },
			{ bogus: 1 },
		])
			for (const index of [0, 1]) {
				const messages = structuredClone(advisorHistory);
				Object.assign(
					(messages[1].content as Record<string, unknown>[])[index],
					extra,
				);
				expect(decide({ ...body, messages }, true).status).toBe("admit");
			}
	});
	it("does not admit the advisor declaration on a native candidate that is not first-party", () => {
		for (const firstParty of [false, undefined])
			expect(decide({ ...body, tools: [advisorTool] }, firstParty)).toEqual({
				status: "reject",
				reason: "tools-unsupported",
			});
	});
	it("does not admit advisor history on a native candidate that is not first-party", () => {
		expect(decide({ ...body, messages: advisorHistory }, false)).toEqual({
			status: "reject",
			reason: "tools-unsupported",
		});
	});
	it("does not admit advisor content on a non-Anthropic target even when the caller passes firstPartyAnthropic", () => {
		const { catalog, target } = effortCatalog();
		const codex = (original: Record<string, unknown>) =>
			evaluateAutoRequestAdmission({
				catalog,
				target,
				requirements: captureAutoRequestRequirements(original),
				finalBody: { ...original, model: target.physicalModel },
				firstPartyAnthropic: true,
			});
		for (const original of [
			{ ...body, tools: [advisorTool] },
			{ ...body, messages: advisorHistory },
		])
			expect(codex(original)).toEqual({
				status: "reject",
				reason: "tools-unsupported",
			});
		expect(codex(body)).not.toEqual({
			status: "reject",
			reason: "tools-unsupported",
		});
	});
	it("leaves an unknown advisor type to the request-level guard and hosted tools to the materializer", () => {
		// #430: no native shape check. An unknown advisor_* type is refused by the
		// request-level unknownDeclaredTypes guard, not by candidate admission.
		expect(
			decide(
				{ ...body, tools: [{ type: "advisor_20990101", name: "advisor" }] },
				true,
			).status,
		).toBe("admit");
		expect(
			decide(
				{ ...body, tools: [{ type: "code_execution_20250825", name: "x" }] },
				true,
			).status,
		).not.toBe("admit");
	});
	it("leaves non-advisor admission unchanged by the first-party flag", () => {
		for (const original of [
			body,
			{ ...body, tools: [clientTool] },
			{ ...body, tools: [{ type: "weird_tool", name: "w" }] },
		]) {
			const outcomes = [true, false, undefined].map((flag) =>
				decide(original, flag),
			);
			expect(outcomes[1]).toEqual(outcomes[0]);
			expect(outcomes[2]).toEqual(outcomes[0]);
		}
	});
});

const CODEX_A = { status: "admit" };
const CODEX_B = { status: "unknown", reason: "request-preservation-unknown" };
const CODEX_C = CODEX_B;
const CODEX_D = CODEX_B;
const CODEX_E = { status: "reject", reason: "modality-unsupported" };
const CODEX_F = CODEX_B;
const CODEX_G = { status: "unknown", reason: "tools-unsupported" };
const CODEX_H = { status: "unknown", reason: "context-unsupported" };
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
		it(`admits on anthropic, codex unchanged: ${name}`, async () => {
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
	it("admits on anthropic when catalog window and output ceiling are unknown, codex unchanged", async () => {
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
