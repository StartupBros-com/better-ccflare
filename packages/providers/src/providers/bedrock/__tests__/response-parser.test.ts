import { describe, expect, it } from "bun:test";
import {
	normalizeBedrockUsage,
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
});
