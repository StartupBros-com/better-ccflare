import { describe, expect, test } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { materializeProviderAttemptPlan } from "../../provider-attempt-plan";
import type { ProviderAttemptPlanContext } from "../../types";
import { VertexAIProvider } from "./provider";

function accountFixture(): Account {
	return {
		id: "vertex-shared",
		name: "Shared Vertex",
		provider: "vertex-ai",
		api_key: null,
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
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
		custom_endpoint: JSON.stringify({
			projectId: "shared-project",
			region: "us-east5",
		}),
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function bodyBuffer(value: unknown): ArrayBuffer {
	const encoded = new TextEncoder().encode(JSON.stringify(value));
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

function requestFor(model: string, marker: string): Request {
	return new Request("http://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			max_tokens: 64,
			messages: [{ role: "user", content: marker }],
		}),
	});
}

function contextFor(
	account: Account,
	model: string,
	marker: string,
): ProviderAttemptPlanContext {
	const body = {
		model,
		max_tokens: 64,
		messages: [{ role: "user", content: marker }],
	};
	return {
		request: requestFor(model, marker),
		requestBodyBuffer: bodyBuffer(body),
		account,
		path: "/v1/messages",
		query: "stream=true",
		physicalModel: model,
		capabilityProofKey: null,
		inputReplayMode: [],
		outputReplayMode: [],
	};
}

describe("VertexAIProvider attempt-plan concurrency", () => {
	test("retains isolated model state for interleaved attempts on one account", async () => {
		const provider = new VertexAIProvider();
		const sharedAccount = accountFixture();
		const originalAccount = { ...sharedAccount };
		const firstModel = "claude-sonnet-4-5-20250929";
		const secondModel = "claude-haiku-4-5-20251001";

		const firstPlan = materializeProviderAttemptPlan(
			provider,
			contextFor(sharedAccount, firstModel, "first request"),
		);
		const secondPlan = materializeProviderAttemptPlan(
			provider,
			contextFor(sharedAccount, secondModel, "second request"),
		);

		expect(firstPlan.targetUrl).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/shared-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
		);
		expect(secondPlan.targetUrl).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/shared-project/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict",
		);
		expect(firstPlan.targetUrl).not.toBe(secondPlan.targetUrl);

		const secondRequestPromise = secondPlan.transformRequestBody(
			requestFor(secondModel, "second retained hook"),
		);
		const firstResponsePromise = firstPlan.processResponse(
			Response.json({ id: "first-response", model: "vertex-wire-model" }),
		);
		const firstRequestPromise = firstPlan.transformRequestBody(
			requestFor(firstModel, "first retained hook"),
		);
		const secondResponsePromise = secondPlan.processResponse(
			Response.json({ id: "second-response", model: "vertex-wire-model" }),
		);

		const [secondRequest, firstResponse, firstRequest, secondResponse] =
			await Promise.all([
				secondRequestPromise,
				firstResponsePromise,
				firstRequestPromise,
				secondResponsePromise,
			]);
		const secondRequestBody = await secondRequest.json();
		const firstResponseBody = await firstResponse.json();
		const firstRequestBody = await firstRequest.json();
		const secondResponseBody = await secondResponse.json();

		expect(secondRequestBody).toMatchObject({
			anthropic_version: "vertex-2023-10-16",
			messages: [{ role: "user", content: "second retained hook" }],
		});
		expect(secondRequestBody).not.toHaveProperty("model");
		expect(firstRequestBody).toMatchObject({
			anthropic_version: "vertex-2023-10-16",
			messages: [{ role: "user", content: "first retained hook" }],
		});
		expect(firstRequestBody).not.toHaveProperty("model");
		expect(firstResponseBody).toEqual({
			id: "first-response",
			model: firstModel,
		});
		expect(secondResponseBody).toEqual({
			id: "second-response",
			model: secondModel,
		});

		expect(sharedAccount).toEqual(originalAccount);
		expect(sharedAccount).not.toHaveProperty("_vertexModel");
		expect(sharedAccount).not.toHaveProperty("_originalModel");
	});
});
