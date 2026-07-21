import { afterAll, describe, expect, it, mock } from "bun:test";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Account } from "@better-ccflare/types";

let capturedInput: Record<string, unknown> | undefined;

const originalRuntimeSend = BedrockRuntimeClient.prototype.send;
const send = mock(async (command: { input: Record<string, unknown> }) => {
	capturedInput = command.input;
	return {
		output: { message: { role: "assistant", content: [{ text: "ok" }] } },
		stopReason: "end_turn",
	};
});
Object.defineProperty(BedrockRuntimeClient.prototype, "send", {
	configurable: true,
	value: send,
});

const originalProfileSend = BedrockClient.prototype.send;
const profileSend = mock(async () => {
	throw new Error("explicit inference-profile ARNs must not be rediscovered");
});

afterAll(() => {
	Object.defineProperty(BedrockRuntimeClient.prototype, "send", {
		configurable: true,
		value: originalRuntimeSend,
	});
	Object.defineProperty(BedrockClient.prototype, "send", {
		configurable: true,
		value: originalProfileSend,
	});
});
Object.defineProperty(BedrockClient.prototype, "send", {
	configurable: true,
	value: profileSend,
});

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

function account(modelId: string): Account {
	return {
		id: "bedrock-test",
		name: "Bedrock test",
		provider: "bedrock",
		api_key: null,
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: true,
		peak_hours_pause_enabled: false,
		custom_endpoint: "bedrock:default:us-east-1",
		model_mappings: JSON.stringify({ custom: modelId }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

describe("BedrockProvider request model integration", () => {
	it("preserves inference-profile ARNs under the default geographic mode", async () => {
		const inferenceProfileArn =
			"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0";
		const provider = new BedrockProvider();
		const request = new Request("https://localhost/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 32,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		await provider.transformRequestBody(request, account(inferenceProfileArn));

		expect(capturedInput?.modelId).toBe(inferenceProfileArn);
		expect(profileSend).not.toHaveBeenCalled();
	});
});
