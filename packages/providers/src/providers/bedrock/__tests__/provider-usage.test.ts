import { describe, expect, it, mock } from "bun:test";

mock.module("@better-ccflare/core", () => ({
	estimateCostUSD: async () => 0,
}));
mock.module("@better-ccflare/database", () => ({
	DatabaseFactory: {
		getInstance: mock(() => ({
			getDatabase: mock(() => ({})),
		})),
	},
	ModelTranslationRepository: mock(() => ({
		findSimilar: mock(() => []),
	})),
}));

const { BedrockProvider } = await import("../provider");

const expectedUsage = {
	promptTokens: 107,
	completionTokens: 3,
	totalTokens: 110,
	inputTokens: 7,
	cacheReadInputTokens: 100,
	cacheCreationInputTokens: 0,
	outputTokens: 3,
};

describe("BedrockProvider usage parity", () => {
	it("returns the canonical cache-aware contract for non-streaming usage", async () => {
		const provider = new BedrockProvider();
		const response = new Response(
			JSON.stringify({
				usage: {
					inputTokens: 7,
					cacheReadInputTokens: 100,
					cacheWriteInputTokens: 0,
					outputTokens: 3,
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);

		await expect(provider.extractUsageInfo(response)).resolves.toMatchObject(
			expectedUsage,
		);
	});

	it("returns the same canonical contract for streaming usage", async () => {
		const provider = new BedrockProvider();
		const response = new Response(
			[
				"event: message_delta",
				'data: {"type":"message_delta","usage":{"input_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"output_tokens":3}}',
				"",
				"event: message_stop",
				'data: {"type":"message_stop"}',
				"",
			].join("\n"),
			{ headers: { "content-type": "text/event-stream" } },
		);

		await expect(provider.parseUsage(response)).resolves.toMatchObject(
			expectedUsage,
		);
	});
});
