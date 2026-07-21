import { describe, expect, it } from "bun:test";
import {
	normalizeBedrockUsage,
	transformBedrockCitation,
	transformNonStreamingResponse,
} from "../response-parser";

describe("Bedrock usage normalization", () => {
	it("counts uncached input, cache reads, and output without double counting", () => {
		expect(
			normalizeBedrockUsage({
				inputTokens: 7,
				cacheReadInputTokens: 100,
				cacheWriteInputTokens: 0,
				outputTokens: 3,
			}),
		).toEqual({
			inputTokens: 7,
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 0,
			outputTokens: 3,
			promptTokens: 107,
			completionTokens: 3,
			totalTokens: 110,
		});
	});

	it("normalizes Claude streaming aliases with the same token contract", () => {
		expect(
			normalizeBedrockUsage({
				input_tokens: 7,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 11,
				output_tokens: 3,
			}),
		).toMatchObject({
			inputTokens: 7,
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 11,
			outputTokens: 3,
			promptTokens: 118,
			totalTokens: 121,
		});
	});

	it("preserves cache usage in non-streaming Claude-compatible responses", async () => {
		const response = new Response(
			JSON.stringify({
				output: {
					message: {
						role: "assistant",
						content: [{ text: "Hello" }],
					},
				},
				stopReason: "end_turn",
				usage: {
					inputTokens: 7,
					cacheReadInputTokens: 100,
					cacheWriteInputTokens: 11,
					outputTokens: 3,
					totalTokens: 121,
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const transformed = await transformNonStreamingResponse(response);
		const body = (await transformed.json()) as {
			usage: Record<string, number>;
		};

		expect(body.usage).toEqual({
			input_tokens: 7,
			output_tokens: 3,
			cache_read_input_tokens: 100,
			cache_creation_input_tokens: 11,
		});
	});

	it("maps Bedrock text and tool use blocks to valid Anthropic blocks", async () => {
		const response = new Response(
			JSON.stringify({
				output: {
					message: {
						role: "assistant",
						content: [
							{ text: "I will look that up." },
							{
								toolUse: {
									toolUseId: "tool_123",
									name: "lookup",
									input: { query: "cache" },
								},
							},
						],
					},
				},
				stopReason: "tool_use",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const transformed = await transformNonStreamingResponse(response);
		const body = (await transformed.json()) as { content: unknown[] };

		expect(body.content).toEqual([
			{ type: "text", text: "I will look that up." },
			{
				type: "tool_use",
				id: "tool_123",
				name: "lookup",
				input: { query: "cache" },
			},
		]);
	});

	it("maps signed reasoning and citation text while omitting unsupported output unions", async () => {
		const response = new Response(
			JSON.stringify({
				output: {
					message: {
						role: "assistant",
						content: [
							{
								reasoningContent: {
									reasoningText: { text: "Reasoning", signature: "sig" },
								},
							},
							{
								reasoningContent: {
									reasoningText: { text: "", signature: "sig_omitted" },
								},
							},
							{
								reasoningContent: { redactedContent: "AQID" },
							},
							{
								citationsContent: {
									content: [{ text: "Grounded answer" }],
									citations: [],
								},
							},
							{ image: { format: "png", source: { bytes: "AQID" } } },
						],
					},
				},
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const transformed = await transformNonStreamingResponse(response);
		const body = (await transformed.json()) as { content: unknown[] };

		expect(body.content).toEqual([
			{
				type: "thinking",
				thinking: "Reasoning",
				signature: "sig",
			},
			{
				type: "thinking",
				thinking: "",
				signature: "sig_omitted",
			},
			{ type: "redacted_thinking", data: "AQID" },
			{ type: "text", text: "Grounded answer" },
		]);
	});

	it("maps complete Bedrock citation metadata to Anthropic text citations", async () => {
		const response = new Response(
			JSON.stringify({
				output: {
					message: {
						role: "assistant",
						content: [
							{
								citationsContent: {
									content: [{ text: "Grounded answer" }],
									citations: [
										{
											title: "Example document",
											source: "document-2",
											sourceContent: [{ text: "Grounded excerpt" }],
											location: {
												documentChar: {
													documentIndex: 2,
													start: 4,
													end: 20,
												},
											},
										},
									],
								},
							},
						],
					},
				},
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const transformed = await transformNonStreamingResponse(response);
		const body = (await transformed.json()) as { content: unknown[] };

		expect(body.content).toEqual([
			{
				type: "text",
				text: "Grounded answer",
				citations: [
					{
						type: "char_location",
						cited_text: "Grounded excerpt",
						document_index: 2,
						document_title: "Example document",
						start_char_index: 4,
						end_char_index: 20,
						file_id: null,
					},
				],
			},
		]);
	});

	it("keeps generated text but omits Bedrock web citations without an Anthropic encrypted index", async () => {
		const response = new Response(
			JSON.stringify({
				output: {
					message: {
						role: "assistant",
						content: [
							{
								citationsContent: {
									content: [{ text: "Web-grounded answer" }],
									citations: [
										{
											title: "Example",
											sourceContent: [{ text: "Excerpt" }],
											location: {
												web: {
													url: "https://example.com",
													domain: "example.com",
												},
											},
										},
									],
								},
							},
						],
					},
				},
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const transformed = await transformNonStreamingResponse(response);
		const body = (await transformed.json()) as { content: unknown[] };

		expect(body.content).toEqual([
			{ type: "text", text: "Web-grounded answer" },
		]);
	});

	it("rejects non-exclusive, invalid-page, and unsafe citation ranges", () => {
		const base = {
			title: "Example document",
			sourceContent: [{ text: "Grounded excerpt" }],
		};

		expect(
			transformBedrockCitation({
				...base,
				location: {
					documentChar: { documentIndex: 0, start: 0, end: 1 },
					documentChunk: { documentIndex: 0, start: 0, end: 1 },
				},
			}),
		).toBeUndefined();
		expect(
			transformBedrockCitation({
				...base,
				location: {
					documentChar: { documentIndex: 0, start: 0, end: 0 },
				},
			}),
		).toBeUndefined();
		expect(
			transformBedrockCitation({
				...base,
				location: {
					documentChunk: { documentIndex: 0, start: 2, end: 1 },
				},
			}),
		).toBeUndefined();
		expect(
			transformBedrockCitation({
				...base,
				location: {
					documentPage: { documentIndex: 0, start: 0, end: 1 },
				},
			}),
		).toBeUndefined();
		expect(
			transformBedrockCitation({
				...base,
				location: {
					documentChar: {
						documentIndex: Number.MAX_SAFE_INTEGER + 1,
						start: 0,
						end: 1,
					},
				},
			}),
		).toBeUndefined();
	});

	it.each([
		["char", { documentChar: { documentIndex: 0, start: 0, end: 1 } }],
		["page", { documentPage: { documentIndex: 0, start: 1, end: 2 } }],
		[
			"content block",
			{ documentChunk: { documentIndex: 0, start: 0, end: 1 } },
		],
	])("includes file_id null on %s document citations", (_label, location) => {
		expect(
			transformBedrockCitation({
				title: "Example document",
				sourceContent: [{ text: "Grounded excerpt" }],
				location,
			}),
		).toMatchObject({ file_id: null });
	});

	it.each([
		["missing output", {}],
		[
			"non-array content",
			{
				output: { message: { role: "assistant", content: {} } },
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			},
		],
		[
			"non-object content block",
			{
				output: { message: { role: "assistant", content: [null] } },
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			},
		],
		[
			"missing stop reason",
			{
				output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			},
		],
		[
			"non-string stop reason",
			{
				output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
				stopReason: 123,
				usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			},
		],
		[
			"missing usage",
			{
				output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
				stopReason: "end_turn",
			},
		],
		[
			"non-object usage",
			{
				output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
				stopReason: "end_turn",
				usage: null,
			},
		],
		[
			"non-canonical usage",
			{
				output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
				stopReason: "end_turn",
				usage: { inputTokens: 1, outputTokens: 2 },
			},
		],
	])("returns a deliberate upstream error for %s", async (_label, payload) => {
		const response = new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await transformNonStreamingResponse(response);

		expect(transformed.status).toBe(502);
		await expect(transformed.json()).resolves.toEqual({
			type: "error",
			error: {
				type: "api_error",
				message: "Bedrock returned an invalid Converse response.",
			},
		});
	});
});
