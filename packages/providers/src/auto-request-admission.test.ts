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
			).toMatchObject({
				status: "admit",
				accounting: { outputLimit: { kind: "catalog", tokens: 20 } },
			});
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
	] as const)("only boolean native support grants %s, without inventing media accounting", (modality, key, block) => {
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
			).toMatchObject(
				supported === true
					? { status: "unknown", reason: "input-accounting-unknown" }
					: { status: "reject", reason: "modality-unsupported" },
			);
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
			).toMatchObject(
				capabilities === undefined
					? { status: "unknown", reason: "input-accounting-unknown" }
					: { status: "reject", reason: "modality-unsupported" },
			);
		}
	});
	it("keeps unknown native output and context unavailable", () => {
		for (const [field, reason] of [
			["max_tokens", "output-unsupported"],
			["max_input_tokens", "context-unsupported"],
		] as const) {
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
			).toMatchObject({ status: "unknown", reason });
		}
	});
});

describe("Auto request suitability (fixtures are not activation proof)", () => {
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
