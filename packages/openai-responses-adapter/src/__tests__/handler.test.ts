import { describe, expect, test } from "bun:test";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

describe("handleResponsesRequest", () => {
	test("Test 1: invalid request (no input field) → 400", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("should not be called", { status: 200 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5" }), // no input
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(400);

		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	test("Test 2: non-streaming path → calls handleProxy with /v1/messages, returns translated response", async () => {
		let capturedUrl: URL | null = null;

		const mockHandleProxy: HandleProxyFn = async (_req, url) => {
			capturedUrl = url;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(capturedUrl?.pathname).toBe("/v1/messages");
		expect(resp.status).toBe(200);

		const body = await resp.json();
		expect(body.object).toBe("response");
		expect(Array.isArray(body.output)).toBe(true);
		expect(body.output[0].type).toBe("message");
	});

	test("surfaces a privacy-safe Codex CLI session identity as metadata.user_id", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			forwardedBody = (await req2.json()) as Record<string, unknown>;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const makeReq = (extra: Record<string, unknown>) =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-haiku-4-5",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Hi" }],
						},
					],
					stream: false,
					...extra,
				}),
				headers: { "Content-Type": "application/json" },
			});

		// prompt_cache_key is Codex CLI's stable conversation identity; without
		// surfacing it, /v1/responses traffic is anonymous to the session
		// governor and load-balancer session affinity.
		const req = makeReq({ prompt_cache_key: "conv-abc123" });
		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
		const forwardedUserId = (
			forwardedBody as unknown as { metadata?: { user_id?: string } }
		)?.metadata?.user_id;
		expect(forwardedUserId).not.toContain("conv-abc123");
		expect(JSON.parse(forwardedUserId ?? "{}").session_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);

		// Without any identity the body stays metadata-free (anonymous).
		const anonReq = makeReq({});
		await handleResponsesRequest(
			anonReq,
			new URL(anonReq.url),
			mockHandleProxy,
			{},
		);
		expect(
			(forwardedBody as unknown as { metadata?: unknown })?.metadata,
		).toBeUndefined();
	});

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", { status: 429 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(429);
	});

	test("preserves stable routing error codes and only finite pool recovery headers", async () => {
		const request = () =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-fable-4-5",
					input: "Hi",
				}),
				headers: { "Content-Type": "application/json" },
			});

		const poolResp = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "pool_exhausted",
							code: "pool_exhausted",
							message: "Temporarily unavailable",
							next_available_at: "2026-07-17T12:01:00.000Z",
						},
					}),
					{
						status: 503,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "pool",
						},
					},
				),
			{},
		);
		const poolBody = (await poolResp.json()) as {
			error: { type: string; code: string };
		};
		expect(poolBody.error.type).toBe("pool_exhausted");
		expect(poolBody.error.code).toBe("pool_exhausted");
		expect(poolResp.headers.get("retry-after")).toBe("60");
		expect(poolResp.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(poolResp.headers.get("x-better-ccflare-recovery-scope")).toBe(
			"pool",
		);

		const modelResp = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "service_unavailable",
							code: "model_pool_exhausted",
							message: "Fable exhausted",
						},
					}),
					{
						status: 503,
						headers: {
							"content-type": "application/json",
							// The proxy's reserved marker pair makes this finite
							// request-compatible model-pool recovery authoritative.
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "model",
						},
					},
				),
			{},
		);
		const modelBody = (await modelResp.json()) as {
			error: { type: string; code: string };
		};
		expect(modelBody.error.type).toBe("service_unavailable");
		expect(modelBody.error.code).toBe("model_pool_exhausted");
		expect(modelResp.headers.get("retry-after")).toBe("60");
		expect(modelResp.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(modelResp.headers.get("x-better-ccflare-recovery-scope")).toBe(
			"model",
		);

		for (const { code, headers: invalidHeaders } of [
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "0",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{ code: "model_pool_exhausted", headers: { "retry-after": "60" } },
			{
				code: "model_pool_exhausted",
				headers: {
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "60",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "pool",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "01",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "9007199254741",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "route_unavailable",
				headers: {
					"retry-after": "60",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
		]) {
			const invalidModelResp = await handleResponsesRequest(
				request(),
				new URL("http://localhost/v1/responses"),
				async () =>
					new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "service_unavailable",
								code,
								message: "Fable exhausted",
							},
						}),
						{ status: 503, headers: invalidHeaders },
					),
				{},
			);
			expect(invalidModelResp.headers.get("retry-after")).toBeNull();
			expect(
				invalidModelResp.headers.get("x-better-ccflare-pool-status"),
			).toBeNull();
			expect(
				invalidModelResp.headers.get("x-better-ccflare-recovery-scope"),
			).toBeNull();
		}

		const non503 = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						error: {
							type: "service_unavailable",
							code: "model_pool_exhausted",
							message: "not a retryable terminal",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "model",
						},
					},
				),
			{},
		);
		expect(non503.headers.get("retry-after")).toBeNull();
		expect(non503.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(non503.headers.get("x-better-ccflare-recovery-scope")).toBeNull();
	});

	test("Test 4: streaming path → returns a text/event-stream response", async () => {
		const sseBody =
			"event: message_start\ndata: " +
			JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}) +
			"\n\n" +
			"event: content_block_start\ndata: " +
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}) +
			"\n\n" +
			"event: content_block_delta\ndata: " +
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}) +
			"\n\n" +
			"event: content_block_stop\ndata: " +
			JSON.stringify({
				type: "content_block_stop",
				index: 0,
			}) +
			"\n\n" +
			"event: message_delta\ndata: " +
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			}) +
			"\n\n" +
			"event: message_stop\ndata: " +
			JSON.stringify({ type: "message_stop" }) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");

		// Read body and verify the translation actually ran
		const rawBody = await resp.text();
		expect(rawBody).toContain("response.created");
		expect(rawBody).toContain("response.completed");
	});
});
