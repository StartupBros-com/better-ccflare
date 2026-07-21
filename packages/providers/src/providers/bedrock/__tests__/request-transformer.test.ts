import { describe, expect, it } from "bun:test";
import {
	type ClaudeRequest,
	transformMessagesRequest,
	transformStreamingRequest,
} from "../request-transformer";
import { transformNonStreamingResponse } from "../response-parser";

const SONNET_45 = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const OPUS_46 = "anthropic.claude-opus-4-6-v1";
const OPUS_41 = "anthropic.claude-opus-4-1-20250805-v1:0";
const SONNET_4 = "anthropic.claude-sonnet-4-20250514-v1:0";
const HAIKU_35 = "anthropic.claude-3-5-haiku-20241022-v1:0";

function request(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
	return {
		model: "claude-sonnet-4-5",
		max_tokens: 256,
		messages: [{ role: "user", content: "Hello" }],
		...overrides,
	};
}

describe("Bedrock request prompt-cache translation", () => {
	it("emits separate cache points after marked tools, system blocks, and message blocks", () => {
		const transformed = transformMessagesRequest(
			request({
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				system: [
					{
						type: "text",
						text: "Stable instructions",
						cache_control: { type: "ephemeral", ttl: "5m" },
					},
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "Stable context",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.toolConfig?.tools).toEqual([
			{
				toolSpec: {
					name: "lookup",
					description: "Look up a value",
					inputSchema: {
						json: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				},
			},
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
		expect(transformed.system).toEqual([
			{ text: "Stable instructions" },
			{ cachePoint: { type: "default", ttl: "5m" } },
		]);
		expect(transformed.messages?.[0]?.content).toEqual([
			{ text: "Stable context" },
			{ cachePoint: { type: "default" } },
		]);
	});

	it("validates tool definitions against the Bedrock name contract", () => {
		const validBoundaryName = "n".repeat(64);
		const transformed = transformMessagesRequest(
			request({
				tools: [
					{
						name: "valid_tool-1",
						input_schema: { type: "object" },
					},
					{
						name: validBoundaryName,
						input_schema: { type: "object" },
					},
					{
						name: "bad.id",
						input_schema: { type: "object" },
					},
					{
						name: "bad:name",
						input_schema: { type: "object" },
					},
					{
						name: "bad name",
						input_schema: { type: "object" },
					},
					{
						name: "n".repeat(65),
						input_schema: { type: "object" },
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.toolConfig?.tools).toEqual([
			{
				toolSpec: {
					name: "valid_tool-1",
					inputSchema: { json: { type: "object" } },
				},
			},
			{
				toolSpec: {
					name: validBoundaryName,
					inputSchema: { json: { type: "object" } },
				},
			},
		]);
	});

	it("preserves tool-use history and tool results with message cache points", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_1",
								name: "lookup",
								input: { query: "cache" },
								cache_control: { type: "ephemeral", ttl: "1h" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: [
									{ type: "text", text: "result one" },
									{ type: "text", text: "result two" },
								],
								is_error: false,
								cache_control: { type: "ephemeral", ttl: "5m" },
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[0]?.content).toEqual([
			{
				toolUse: {
					toolUseId: "tool_1",
					name: "lookup",
					input: { query: "cache" },
				},
			},
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
		expect(transformed.messages?.[1]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_1",
					content: [{ text: "result one" }, { text: "result two" }],
					status: "success",
				},
			},
			{ cachePoint: { type: "default", ttl: "5m" } },
		]);
	});

	it("preserves empty tool results instead of leaving a dangling tool use", () => {
		for (const emptyContent of ["", []]) {
			const transformed = transformMessagesRequest(
				request({
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "tool_empty",
									name: "lookup",
									input: {},
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "tool_empty",
									content: emptyContent,
								},
							],
						},
					],
				}),
				SONNET_45,
			);

			expect(transformed.messages?.[1]?.content).toEqual([
				{
					toolResult: {
						toolUseId: "tool_empty",
						content: [{ text: "" }],
						status: "success",
					},
				},
			]);
		}
	});

	it("maps image-only and structured tool results to Bedrock content unions", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_image",
								name: "image_lookup",
								input: {},
							},
							{
								type: "tool_use",
								id: "tool_structured",
								name: "structured_lookup",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_image",
								content: [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "AQID",
										},
									},
								],
							},
							{
								type: "tool_result",
								tool_use_id: "tool_structured",
								content: [
									{ type: "json", json: { ok: true } },
									{
										type: "document",
										title: "report.pdf",
										source: {
											type: "base64",
											media_type: "application/pdf",
											data: "BAUG",
										},
									},
									{
										type: "search_result",
										source: "https://example.com/result",
										title: "Example result",
										content: [{ type: "text", text: "Grounded excerpt" }],
										citations: { enabled: true },
									},
								],
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[1]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_image",
					content: [
						{
							image: {
								format: "png",
								source: { bytes: new Uint8Array([1, 2, 3]) },
							},
						},
					],
					status: "success",
				},
			},
			{
				toolResult: {
					toolUseId: "tool_structured",
					content: [
						{ json: { ok: true } },
						{
							document: {
								format: "pdf",
								name: "report-pdf",
								source: { bytes: new Uint8Array([4, 5, 6]) },
							},
						},
						{
							searchResult: {
								source: "https://example.com/result",
								title: "Example result",
								content: [{ text: "Grounded excerpt" }],
								citations: { enabled: true },
							},
						},
					],
					status: "success",
				},
			},
		]);
	});

	it("round-trips signed and redacted reasoning into a tool-use continuation", async () => {
		const transformedResponse = await transformNonStreamingResponse(
			new Response(
				JSON.stringify({
					output: {
						message: {
							role: "assistant",
							content: [
								{
									reasoningContent: {
										reasoningText: { text: "", signature: "sig_opaque" },
									},
								},
								{
									reasoningContent: { redactedContent: "AQID" },
								},
								{
									toolUse: {
										toolUseId: "tool_reasoning",
										name: "lookup",
										input: { query: "cache" },
									},
								},
							],
						},
					},
					stopReason: "tool_use",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		const responseBody = (await transformedResponse.json()) as {
			content: ClaudeRequest["messages"][number]["content"];
		};

		const continued = transformMessagesRequest(
			request({
				messages: [
					{ role: "assistant", content: responseBody.content },
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_reasoning",
								content: "result",
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(continued.messages?.[0]?.content).toEqual([
			{
				reasoningContent: {
					reasoningText: { text: "", signature: "sig_opaque" },
				},
			},
			{
				reasoningContent: {
					redactedContent: new Uint8Array([1, 2, 3]),
				},
			},
			{
				toolUse: {
					toolUseId: "tool_reasoning",
					name: "lookup",
					input: { query: "cache" },
				},
			},
		]);
		expect(continued.messages?.[1]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_reasoning",
					content: [{ text: "result" }],
					status: "success",
				},
			},
		]);
	});

	it("maps signed and redacted reasoning into Bedrock continuation blocks", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "",
								signature: "sig_opaque",
							},
							{ type: "redacted_thinking", data: "AQID" },
							{
								type: "tool_use",
								id: "tool_reasoning",
								name: "lookup",
								input: { query: "cache" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_reasoning",
								content: "result",
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[0]?.content).toEqual([
			{
				reasoningContent: {
					reasoningText: { text: "", signature: "sig_opaque" },
				},
			},
			{
				reasoningContent: {
					redactedContent: new Uint8Array([1, 2, 3]),
				},
			},
			{
				toolUse: {
					toolUseId: "tool_reasoning",
					name: "lookup",
					input: { query: "cache" },
				},
			},
		]);
		expect(transformed.messages?.[1]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_reasoning",
					content: [{ text: "result" }],
					status: "success",
				},
			},
		]);
	});

	it("preserves exact text bytes around signed reasoning history", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{ role: "user", content: "  exact prompt\n" },
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "  signed reasoning\n",
								signature: "sig_exact",
							},
							{ type: "text", text: "  exact answer\n" },
							{
								type: "tool_use",
								id: "tool_exact",
								name: "lookup",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_exact",
								content: "result",
							},
							{ type: "text", text: "  exact follow-up\n" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[0]?.content).toEqual([
			{ text: "  exact prompt\n" },
		]);
		expect(transformed.messages?.[1]?.content).toEqual([
			{
				reasoningContent: {
					reasoningText: {
						text: "  signed reasoning\n",
						signature: "sig_exact",
					},
				},
			},
			{ text: "  exact answer\n" },
			{
				toolUse: {
					toolUseId: "tool_exact",
					name: "lookup",
					input: {},
				},
			},
		]);
		expect(transformed.messages?.[2]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_exact",
					content: [{ text: "result" }],
					status: "success",
				},
			},
			{ text: "  exact follow-up\n" },
		]);
	});

	it("round-trips signed CRLF, Unicode, and interleaved reasoning blocks exactly", async () => {
		const reasoningOne = "\r\n🧠 é reasoning one\r\n";
		const textOne = "\r\n👩🏽‍💻 answer one\r\n";
		const reasoningTwo = "第二段\r\nreasoning 🚀";
		const textTwo = "  final Ω text\r\n";
		const transformedResponse = await transformNonStreamingResponse(
			new Response(
				JSON.stringify({
					output: {
						message: {
							role: "assistant",
							content: [
								{
									reasoningContent: {
										reasoningText: {
											text: reasoningOne,
											signature: "sig_one",
										},
									},
								},
								{ text: textOne },
								{ reasoningContent: { redactedContent: "AQID" } },
								{
									reasoningContent: {
										reasoningText: {
											text: reasoningTwo,
											signature: "sig_two",
										},
									},
								},
								{ text: textTwo },
								{
									toolUse: {
										toolUseId: "tool_unicode",
										name: "lookup",
										input: {},
									},
								},
							],
						},
					},
					stopReason: "tool_use",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		const responseBody = (await transformedResponse.json()) as {
			content: ClaudeRequest["messages"][number]["content"];
		};

		const continued = transformMessagesRequest(
			request({
				messages: [
					{ role: "assistant", content: responseBody.content },
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_unicode",
								content: "done",
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(continued.messages?.[0]?.content).toEqual([
			{
				reasoningContent: {
					reasoningText: { text: reasoningOne, signature: "sig_one" },
				},
			},
			{ text: textOne },
			{ reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
			{
				reasoningContent: {
					reasoningText: { text: reasoningTwo, signature: "sig_two" },
				},
			},
			{ text: textTwo },
			{
				toolUse: {
					toolUseId: "tool_unicode",
					name: "lookup",
					input: {},
				},
			},
		]);
	});

	it("round-trips response citations as Bedrock citationsContent history", async () => {
		const transformedResponse = await transformNonStreamingResponse(
			new Response(
				JSON.stringify({
					output: {
						message: {
							role: "assistant",
							content: [
								{
									citationsContent: {
										content: [{ text: "  Grounded answer  " }],
										citations: [
											{
												title: "Example document",
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
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		const responseBody = (await transformedResponse.json()) as {
			content: ClaudeRequest["messages"][number]["content"];
		};

		const continued = transformMessagesRequest(
			request({
				messages: [{ role: "assistant", content: responseBody.content }],
			}),
			SONNET_45,
		);

		expect(continued.messages?.[0]?.content).toEqual([
			{
				citationsContent: {
					content: [{ text: "  Grounded answer  " }],
					citations: [
						{
							title: "Example document",
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
		]);
	});

	it("preserves citation text order while omitting unsupported metadata", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: "  visible cited text  ",
								citations: [
									{
										type: "web_search_result_location",
										cited_text: "visible cited text",
										encrypted_index: "opaque",
									},
								],
							},
							{ type: "text", text: "\r\nnext visible block" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[0]?.content).toEqual([
			{ text: "  visible cited text  " },
			{ text: "\r\nnext visible block" },
		]);
	});

	it("losslessly degrades search results for unsupported physical models", () => {
		const searchResult = {
			type: "search_result",
			source: "https://example.com/result",
			title: "Example result",
			content: [{ type: "text", text: "Grounded excerpt" }],
			citations: { enabled: true },
		};
		for (const modelId of [OPUS_46, `${SONNET_45}-future`]) {
			const transformed = transformMessagesRequest(
				request({
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "tool_search",
									name: "search",
									input: {},
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "tool_search",
									content: [searchResult],
								},
							],
						},
					],
				}),
				modelId,
			);

			expect(transformed.messages?.[1]?.content).toEqual([
				{
					toolResult: {
						toolUseId: "tool_search",
						content: [{ text: JSON.stringify(searchResult) }],
						status: "success",
					},
				},
			]);
		}
	});

	it("drops malformed tool uses and their results atomically", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_invalid",
								name: "",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_invalid",
								content: "must not be orphaned",
							},
							{ type: "text", text: "Keep this message" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages).toEqual([
			{ role: "user", content: [{ text: "Keep this message" }] },
		]);
	});

	it("drops an entire tool group containing missing, malformed, or duplicate results", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Keep assistant context" },
							{
								type: "tool_use",
								id: "tool_missing",
								name: "lookup",
								input: {},
								cache_control: { type: "ephemeral" },
							},
							{
								type: "tool_use",
								id: "tool_malformed_result",
								name: "lookup",
								input: {},
							},
							{
								type: "tool_use",
								id: "tool_duplicate_result",
								name: "lookup",
								input: {},
							},
							{
								type: "tool_use",
								id: "tool_valid",
								name: "lookup",
								input: { query: "keep" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_malformed_result",
								content: 42,
							},
							{
								type: "tool_result",
								tool_use_id: "tool_duplicate_result",
								content: "first",
							},
							{
								type: "tool_result",
								tool_use_id: "tool_duplicate_result",
								content: "second",
							},
							{
								type: "tool_result",
								tool_use_id: "tool_valid",
								content: "valid result",
							},
							{ type: "text", text: "Keep user context" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages).toEqual([
			{
				role: "assistant",
				content: [{ text: "Keep assistant context" }],
			},
			{
				role: "user",
				content: [{ text: "Keep user context" }],
			},
		]);
	});

	it("rejects duplicate tool uses and results that precede their use", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_out_of_order",
								content: "too early",
							},
							{ type: "text", text: "Keep first message" },
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_out_of_order",
								name: "lookup",
								input: {},
							},
							{
								type: "tool_use",
								id: "tool_duplicate_use",
								name: "lookup",
								input: { attempt: 1 },
							},
							{
								type: "tool_use",
								id: "tool_duplicate_use",
								name: "lookup",
								input: { attempt: 2 },
							},
							{ type: "text", text: "Keep second message" },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_duplicate_use",
								content: "ambiguous",
							},
							{ type: "text", text: "Keep third message" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages).toEqual([
			{ role: "user", content: [{ text: "Keep first message" }] },
			{ role: "assistant", content: [{ text: "Keep second message" }] },
			{ role: "user", content: [{ text: "Keep third message" }] },
		]);
	});

	it("requires adjacent assistant-to-user tool pairs with result-first ordering", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_delayed",
								name: "lookup",
								input: {},
							},
						],
					},
					{ role: "user", content: "Keep intervening turn" },
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_delayed",
								content: "late",
							},
							{ type: "text", text: "Keep late-result turn" },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_use",
								id: "tool_wrong_roles",
								name: "lookup",
								input: {},
							},
							{ type: "text", text: "Keep wrong-role use" },
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_wrong_roles",
								content: "wrong role",
							},
							{ type: "text", text: "Keep wrong-role result" },
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_text_before_result",
								name: "lookup",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{ type: "text", text: "Keep leading text" },
							{
								type: "tool_result",
								tool_use_id: "tool_text_before_result",
								content: "too late in turn",
							},
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_text_after_use",
								name: "lookup",
								input: {},
							},
							{ type: "text", text: "Keep trailing assistant text" },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_text_after_use",
								content: "not immediate",
							},
							{ type: "text", text: "Keep trailing-use result text" },
						],
					},
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Valid preamble" },
							{
								type: "tool_use",
								id: "tool_valid_adjacent",
								name: "lookup",
								input: { query: "keep" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_valid_adjacent",
								content: "valid",
							},
							{ type: "text", text: "Valid follow-up" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages).toEqual([
			{ role: "user", content: [{ text: "Keep intervening turn" }] },
			{ role: "user", content: [{ text: "Keep late-result turn" }] },
			{ role: "user", content: [{ text: "Keep wrong-role use" }] },
			{ role: "assistant", content: [{ text: "Keep wrong-role result" }] },
			{ role: "user", content: [{ text: "Keep leading text" }] },
			{
				role: "assistant",
				content: [{ text: "Keep trailing assistant text" }],
			},
			{
				role: "user",
				content: [{ text: "Keep trailing-use result text" }],
			},
			{
				role: "assistant",
				content: [
					{ text: "Valid preamble" },
					{
						toolUse: {
							toolUseId: "tool_valid_adjacent",
							name: "lookup",
							input: { query: "keep" },
						},
					},
				],
			},
			{
				role: "user",
				content: [
					{
						toolResult: {
							toolUseId: "tool_valid_adjacent",
							content: [{ text: "valid" }],
							status: "success",
						},
					},
					{ text: "Valid follow-up" },
				],
			},
		]);
	});

	it("rejects an entire parallel tool group when any result is missing", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Keep assistant context" },
							{
								type: "tool_use",
								id: "tool_a",
								name: "lookup",
								input: { query: "a" },
							},
							{
								type: "tool_use",
								id: "tool_b",
								name: "lookup",
								input: { query: "b" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_a",
								content: "only a",
							},
							{ type: "text", text: "Keep user context" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages).toEqual([
			{
				role: "assistant",
				content: [{ text: "Keep assistant context" }],
			},
			{ role: "user", content: [{ text: "Keep user context" }] },
		]);
	});

	it("keeps parallel tool groups contiguous before deferred cache checkpoints", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Preamble" },
							{
								type: "tool_use",
								id: "tool_a",
								name: "lookup_a",
								input: {},
								cache_control: { type: "ephemeral", ttl: "1h" },
							},
							{
								type: "tool_use",
								id: "tool_b",
								name: "lookup_b",
								input: {},
								cache_control: { type: "ephemeral", ttl: "5m" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_a",
								content: "a",
							},
							{
								type: "tool_result",
								tool_use_id: "tool_b",
								content: "b",
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[0]?.content).toEqual([
			{ text: "Preamble" },
			{
				toolUse: {
					toolUseId: "tool_a",
					name: "lookup_a",
					input: {},
				},
			},
			{
				toolUse: {
					toolUseId: "tool_b",
					name: "lookup_b",
					input: {},
				},
			},
			{ cachePoint: { type: "default", ttl: "1h" } },
			{ cachePoint: { type: "default", ttl: "5m" } },
		]);
	});

	it("keeps leading parallel tool results contiguous before cache checkpoints and ordinary content", () => {
		const transformed = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_a",
								name: "lookup_a",
								input: {},
							},
							{
								type: "tool_use",
								id: "tool_b",
								name: "lookup_b",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_a",
								content: "a",
								cache_control: { type: "ephemeral", ttl: "1h" },
							},
							{
								type: "tool_result",
								tool_use_id: "tool_b",
								content: "b",
								cache_control: { type: "ephemeral", ttl: "5m" },
							},
							{ type: "text", text: "Ordinary suffix" },
						],
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.messages?.[1]?.content).toEqual([
			{
				toolResult: {
					toolUseId: "tool_a",
					content: [{ text: "a" }],
					status: "success",
				},
			},
			{
				toolResult: {
					toolUseId: "tool_b",
					content: [{ text: "b" }],
					status: "success",
				},
			},
			{ cachePoint: { type: "default", ttl: "1h" } },
			{ cachePoint: { type: "default", ttl: "5m" } },
			{ text: "Ordinary suffix" },
		]);
	});

	it("enforces Bedrock tool identifier syntax and 64-character limits", () => {
		for (const fixture of [
			{ id: "bad id", name: "lookup" },
			{ id: "bad.id", name: "lookup" },
			{ id: "bad:name", name: "lookup" },
			{ id: "tool_bad_name", name: "bad.name" },
			{ id: "tool_bad_colon_name", name: "bad:name" },
			{ id: "i".repeat(65), name: "lookup" },
			{ id: "tool_long_name", name: "n".repeat(65) },
		]) {
			const transformed = transformMessagesRequest(
				request({
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "text", text: "Keep assistant" },
								{
									type: "tool_use",
									id: fixture.id,
									name: fixture.name,
									input: {},
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: fixture.id,
									content: "invalid",
								},
								{ type: "text", text: "Keep user" },
							],
						},
					],
				}),
				SONNET_45,
			);
			expect(transformed.messages).toEqual([
				{ role: "assistant", content: [{ text: "Keep assistant" }] },
				{ role: "user", content: [{ text: "Keep user" }] },
			]);
		}

		const maxId = "i".repeat(64);
		const maxName = "n".repeat(64);
		const boundary = transformMessagesRequest(
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: maxId,
								name: maxName,
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: maxId,
								content: "valid",
							},
						],
					},
				],
			}),
			SONNET_45,
		);
		expect(boundary.messages?.[0]?.content).toMatchObject([
			{ toolUse: { toolUseId: maxId, name: maxName } },
		]);
	});

	it("preserves tools while suppressing cache points for unsupported models", () => {
		const transformed = transformMessagesRequest(
			request({
				tools: [
					{
						name: "lookup",
						input_schema: { type: "object" },
						cache_control: { type: "ephemeral" },
					},
				],
			}),
			"amazon.nova-pro-v1:0",
		);

		expect(transformed.toolConfig?.tools).toEqual([
			{
				toolSpec: {
					name: "lookup",
					inputSchema: { json: { type: "object" } },
				},
			},
		]);
	});

	it("recognizes regional IDs and inference-profile ARNs for supported models", () => {
		const ids = [
			`us.${SONNET_45}`,
			`eu.${SONNET_45}`,
			`global.${SONNET_45}`,
			`arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.${SONNET_45}`,
		];

		for (const modelId of ids) {
			const transformed = transformMessagesRequest(
				request({
					system: [
						{
							type: "text",
							text: "Stable",
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				}),
				modelId,
			);

			expect(transformed.system).toEqual([
				{ text: "Stable" },
				{ cachePoint: { type: "default", ttl: "1h" } },
			]);
		}
	});

	it("emits cache markers for supported Opus 4.1, Sonnet 4, and Haiku 3.5 IDs", () => {
		const ids = [
			OPUS_41,
			`us.${SONNET_4}`,
			`arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.${HAIKU_35}`,
		];

		for (const modelId of ids) {
			const transformed = transformMessagesRequest(
				request({
					system: [
						{
							type: "text",
							text: "Stable older-model context",
							cache_control: { type: "ephemeral" },
						},
					],
				}),
				modelId,
			);

			expect(transformed.system, modelId).toEqual([
				{ text: "Stable older-model context" },
				{ cachePoint: { type: "default" } },
			]);
		}
	});

	it("enforces one-hour model capability without dropping surrounding content", () => {
		const transformed = transformMessagesRequest(
			request({
				system: [
					{
						type: "text",
						text: "Unsupported extended TTL",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
					{
						type: "text",
						text: "Supported default TTL",
						cache_control: { type: "ephemeral" },
					},
				],
			}),
			OPUS_46,
		);

		expect(transformed.system).toEqual([
			{ text: "Unsupported extended TTL" },
			{ text: "Supported default TTL" },
			{ cachePoint: { type: "default" } },
		]);
	});

	it("enforces the four-checkpoint limit in tools-system-messages order", () => {
		const transformed = transformMessagesRequest(
			request({
				tools: [
					{
						name: "one",
						input_schema: { type: "object" },
						cache_control: { type: "ephemeral" },
					},
					{
						name: "two",
						input_schema: { type: "object" },
						cache_control: { type: "ephemeral" },
					},
				],
				system: [
					{
						type: "text",
						text: "system one",
						cache_control: { type: "ephemeral" },
					},
					{
						type: "text",
						text: "system two",
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "fifth marker",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			}),
			SONNET_45,
		);

		const serialized = JSON.stringify(transformed);
		expect(serialized.match(/cachePoint/g)).toHaveLength(4);
		expect(transformed.messages?.[0]?.content).toEqual([
			{ text: "fifth marker" },
		]);
	});

	it("drops a later one-hour marker once a five-minute marker was emitted", () => {
		const transformed = transformMessagesRequest(
			request({
				tools: [
					{
						name: "lookup",
						input_schema: { type: "object" },
						cache_control: { type: "ephemeral", ttl: "5m" },
					},
				],
				system: [
					{
						type: "text",
						text: "Later long TTL",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.toolConfig?.tools).toHaveLength(2);
		expect(transformed.system).toEqual([{ text: "Later long TTL" }]);
	});

	it("ignores malformed cache controls without emitting unsupported markers", () => {
		const transformed = transformMessagesRequest(
			request({
				system: [
					{
						type: "text",
						text: "Wrong type",
						cache_control: { type: "persistent" },
					},
					{
						type: "text",
						text: "Wrong TTL",
						cache_control: { type: "ephemeral", ttl: "30m" },
					},
					{
						type: "text",
						text: "Valid",
						cache_control: { type: "ephemeral", ttl: "5m" },
					},
				],
			}),
			SONNET_45,
		);

		expect(transformed.system).toEqual([
			{ text: "Wrong type" },
			{ text: "Wrong TTL" },
			{ text: "Valid" },
			{ cachePoint: { type: "default", ttl: "5m" } },
		]);
		expect(JSON.stringify(transformed)).not.toContain("cache_control");
	});

	it("uses the same cache translation for streaming requests", () => {
		const input = request({
			system: [
				{
					type: "text",
					text: "Stable",
					cache_control: { type: "ephemeral" },
				},
			],
		});

		expect(transformStreamingRequest(input, SONNET_45)).toEqual(
			transformMessagesRequest(input, SONNET_45),
		);
	});
});
