import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cacheBodyStore } from "../cache-body-store";
import {
	stageCacheBodyForTransportAttempt,
	stripCacheControlFromReplayBody,
} from "../cache-transport-staging";

const encoder = new TextEncoder();

function body(value: Record<string, unknown>): ArrayBuffer {
	return encoder.encode(JSON.stringify(value)).buffer;
}

function transportRequest(value: Record<string, unknown>): Request {
	return new Request("https://upstream.example/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});
}

async function stage({
	requestId,
	accountId,
	replayBody,
	transportBody,
	providerName = "anthropic",
	clientHeaders = new Headers({ "content-type": "application/json" }),
	cacheIdentityHasCacheControl,
}: {
	requestId: string;
	accountId: string;
	replayBody: Record<string, unknown>;
	transportBody: Record<string, unknown>;
	providerName?: string;
	clientHeaders?: Headers;
	cacheIdentityHasCacheControl?: boolean;
}) {
	return stageCacheBodyForTransportAttempt({
		requestId,
		accountId,
		providerName,
		replayBody: body(replayBody),
		transportRequest: transportRequest(transportBody),
		clientHeaders,
		path: "/v1/messages",
		cacheIdentityHasCacheControl,
	});
}

function promotedBody(accountId: string): Record<string, unknown> | null {
	const entry = cacheBodyStore.getLastCachedRequest(accountId);
	return entry ? JSON.parse(entry.body.toString("utf8")) : null;
}

describe("cache transport staging", () => {
	beforeEach(() => {
		cacheBodyStore.setEnabled(false);
		cacheBodyStore.setEnabled(true);
	});

	afterEach(() => {
		cacheBodyStore.setEnabled(false);
	});

	it("replays the combo-selected model instead of the original request model", async () => {
		await stage({
			requestId: "req-combo",
			accountId: "account-combo",
			replayBody: {
				model: "claude-opus-4-8",
				messages: [{ role: "user", content: "hello" }],
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "claude-opus-4-8",
				messages: [{ role: "user", content: "hello" }],
				cache_control: { type: "ephemeral" },
			},
		});

		cacheBodyStore.onSummary("req-combo", 64);

		expect(promotedBody("account-combo")?.model).toBe("claude-opus-4-8");
	});

	it("replays the admission-selected model before provider conversion", async () => {
		await stage({
			requestId: "req-admission",
			accountId: "account-admission",
			replayBody: {
				model: "gpt-5.2-codex",
				messages: [{ role: "user", content: "hello" }],
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "gpt-5.2-codex",
				input: [{ role: "user", content: "hello" }],
				cache_control: { type: "ephemeral" },
			},
		});

		cacheBodyStore.onSummary("req-admission", 64);

		const replay = promotedBody("account-admission");
		expect(replay?.model).toBe("gpt-5.2-codex");
		expect(replay?.messages).toBeDefined();
		expect(replay?.input).toBeUndefined();
	});

	it("uses the post-transform body for eligibility but stores the replay-safe source", async () => {
		await stage({
			requestId: "req-provider-marker",
			accountId: "account-provider-marker",
			replayBody: {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "hello" }],
			},
			transportBody: {
				model: "qwen3.5-plus",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "hello",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			},
		});

		cacheBodyStore.onSummary("req-provider-marker", 64);

		const replay = promotedBody("account-provider-marker");
		expect(replay?.model).toBe("qwen3.5-plus");
		expect(JSON.stringify(replay)).not.toContain("cache_control");
	});

	it("replaces a failed route so only the successful cache-creating route is promoted", async () => {
		await stage({
			requestId: "req-failover",
			accountId: "account-failed",
			replayBody: {
				model: "failed-model",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "failed-model",
				cache_control: { type: "ephemeral" },
			},
		});

		await stage({
			requestId: "req-failover",
			accountId: "account-success",
			replayBody: {
				model: "successful-model",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "successful-model",
				cache_control: { type: "ephemeral" },
			},
		});

		cacheBodyStore.onSummary("req-failover", 64);

		expect(cacheBodyStore.getLastCachedRequest("account-failed")).toBeNull();
		expect(promotedBody("account-success")?.model).toBe("successful-model");
	});

	it("stages official xAI traffic without Anthropic cache_control markers", async () => {
		await stage({
			requestId: "req-xai-automatic",
			accountId: "account-xai",
			providerName: "xai",
			replayBody: {
				model: "grok-4.5",
				messages: [{ role: "user", content: "hello" }],
			},
			transportBody: {
				model: "grok-4.5",
				messages: [{ role: "user", content: "hello" }],
			},
			cacheIdentityHasCacheControl: false,
		});

		cacheBodyStore.onSummary("req-xai-automatic", 0, true, 12_800);
		expect(promotedBody("account-xai")?.model).toBe("grok-4.5");
	});

	it("clears a previous route when the final transport has no cache marker", async () => {
		await stage({
			requestId: "req-final-uncached",
			accountId: "account-failed",
			replayBody: {
				model: "failed-model",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "failed-model",
				cache_control: { type: "ephemeral" },
			},
		});

		await stage({
			requestId: "req-final-uncached",
			accountId: "account-success",
			replayBody: { model: "successful-model" },
			transportBody: { model: "successful-model" },
		});

		cacheBodyStore.onSummary("req-final-uncached", 64);

		expect(cacheBodyStore.getLastCachedRequest("account-failed")).toBeNull();
		expect(cacheBodyStore.getLastCachedRequest("account-success")).toBeNull();
	});

	it("retains only sanitized client headers", async () => {
		await stage({
			requestId: "req-headers",
			accountId: "account-headers",
			replayBody: {
				model: "claude-sonnet-4-5",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "claude-sonnet-4-5",
				cache_control: { type: "ephemeral" },
			},
			clientHeaders: new Headers({
				authorization: "Bearer should-not-be-retained",
				"x-api-key": "should-not-be-retained",
				"x-better-ccflare-request-id": "internal-request-id",
				"anthropic-beta": "prompt-caching-2024-07-31",
			}),
		});

		cacheBodyStore.onSummary("req-headers", 64);

		const headers =
			cacheBodyStore.getLastCachedRequest("account-headers")?.headers;
		expect(headers?.authorization).toBeUndefined();
		expect(headers?.["x-api-key"]).toBeUndefined();
		expect(headers?.["x-better-ccflare-request-id"]).toBeUndefined();
		expect(headers?.["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
	});

	it("uses a precomputed final-body probe without cloning the transport", async () => {
		const request = transportRequest({
			model: "qwen3.5-plus",
			cache_control: { type: "ephemeral" },
		});
		Object.defineProperty(request, "clone", {
			value: () => {
				throw new Error("transport body should not be cloned");
			},
		});

		await stageCacheBodyForTransportAttempt({
			requestId: "req-probe",
			accountId: "account-probe",
			providerName: "anthropic",
			replayBody: body({
				model: "qwen3.5-plus",
				cache_control: { type: "ephemeral" },
			}),
			transportRequest: request,
			clientHeaders: new Headers(),
			path: "/v1/messages",
			cacheIdentityHasCacheControl: true,
		});

		cacheBodyStore.onSummary("req-probe", 64);
		expect(promotedBody("account-probe")?.model).toBe("qwen3.5-plus");
	});

	it("stages a transform-time synthetic Bedrock result from its replay source without cloning the response", async () => {
		const syntheticResponse = new Request("https://bedrock.aws/response", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-bedrock-response": "true",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				usage: { cacheWriteInputTokens: 64 },
			}),
		});
		Object.defineProperty(syntheticResponse, "clone", {
			value: () => {
				throw new Error("synthetic response body must not be cloned");
			},
		});

		await stageCacheBodyForTransportAttempt({
			requestId: "req-bedrock",
			accountId: "account-bedrock",
			providerName: "bedrock",
			replayBody: body({
				model: "claude-sonnet-4-5",
				system: [
					{
						type: "text",
						text: "stable prefix",
						cache_control: { type: "ephemeral" },
					},
				],
			}),
			transportRequest: syntheticResponse,
			clientHeaders: new Headers(),
			path: "/v1/messages",
			isSyntheticProviderTransport: true,
		});

		cacheBodyStore.onSummary("req-bedrock", 64, true);
		expect(promotedBody("account-bedrock")?.model).toBe("claude-sonnet-4-5");
	});

	it("replaces failed Anthropic staging with the successful synthetic Bedrock projection", async () => {
		await stage({
			requestId: "req-anthropic-bedrock",
			accountId: "account-anthropic",
			replayBody: {
				model: "claude-opus-4-8",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "claude-opus-4-8",
				cache_control: { type: "ephemeral" },
			},
		});

		const syntheticResponse = new Request("https://bedrock.aws/response", {
			method: "POST",
			headers: { "x-bedrock-response": "true" },
			body: JSON.stringify({ type: "message", usage: {} }),
		});
		Object.defineProperty(syntheticResponse, "clone", {
			value: () => {
				throw new Error("synthetic response body must not be cloned");
			},
		});
		await stageCacheBodyForTransportAttempt({
			requestId: "req-anthropic-bedrock",
			accountId: "account-bedrock",
			providerName: "bedrock",
			replayBody: body({
				model: "claude-sonnet-4-5",
				cache_control: { type: "ephemeral" },
			}),
			transportRequest: syntheticResponse,
			clientHeaders: new Headers(),
			path: "/v1/messages",
			isSyntheticProviderTransport: true,
		});

		cacheBodyStore.onSummary("req-anthropic-bedrock", 64, true);
		expect(cacheBodyStore.getLastCachedRequest("account-anthropic")).toBeNull();
		expect(promotedBody("account-bedrock")?.model).toBe("claude-sonnet-4-5");
	});

	it("clears failed Anthropic staging when successful synthetic Bedrock did not create cache", async () => {
		await stage({
			requestId: "req-bedrock-uncached",
			accountId: "account-anthropic",
			replayBody: {
				model: "claude-opus-4-8",
				cache_control: { type: "ephemeral" },
			},
			transportBody: {
				model: "claude-opus-4-8",
				cache_control: { type: "ephemeral" },
			},
		});

		const syntheticResponse = new Request("https://bedrock.aws/response", {
			method: "POST",
			headers: { "x-bedrock-response": "true" },
			body: JSON.stringify({ type: "message", usage: {} }),
		});
		Object.defineProperty(syntheticResponse, "clone", {
			value: () => {
				throw new Error("synthetic response body must not be cloned");
			},
		});
		await stageCacheBodyForTransportAttempt({
			requestId: "req-bedrock-uncached",
			accountId: "account-bedrock",
			providerName: "bedrock",
			replayBody: body({ model: "claude-sonnet-4-5" }),
			transportRequest: syntheticResponse,
			clientHeaders: new Headers(),
			path: "/v1/messages",
			isSyntheticProviderTransport: true,
		});

		cacheBodyStore.onSummary("req-bedrock-uncached", 64, true);
		expect(cacheBodyStore.getLastCachedRequest("account-anthropic")).toBeNull();
		expect(cacheBodyStore.getLastCachedRequest("account-bedrock")).toBeNull();
	});

	it("strips cache markers from the replay-safe source without adopting the provider-transformed shape", () => {
		const replaySource = body({
			model: "claude-sonnet-4-5",
			system: [
				{
					type: "text",
					text: "stable system",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "hello",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		});

		const stripped = stripCacheControlFromReplayBody(replaySource);
		expect(stripped).not.toBeNull();
		if (!stripped) throw new Error("expected replay-safe body");
		const parsed = JSON.parse(new TextDecoder().decode(stripped));
		expect(parsed.model).toBe("claude-sonnet-4-5");
		expect(parsed.system).toBeDefined();
		expect(parsed.messages).toBeDefined();
		expect(parsed.input).toBeUndefined();
		expect(JSON.stringify(parsed)).not.toContain("cache_control");
	});
});
