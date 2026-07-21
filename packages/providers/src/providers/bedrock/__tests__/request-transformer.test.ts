import { describe, expect, it } from "bun:test";
import {
	type ClaudeRequest,
	transformMessagesRequest,
	transformStreamingRequest,
} from "../request-transformer";

const SONNET_45 = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const OPUS_46 = "anthropic.claude-opus-4-6-v1";

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
