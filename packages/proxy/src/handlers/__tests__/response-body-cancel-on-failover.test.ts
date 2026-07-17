import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { discardUpstreamBody, proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Regression: every failover/retry branch in proxyWithAccount that discards an
 * upstream fetch() Response (returns null to try the next account, or
 * overwrites rawResponse/response with a retry) must cancel the abandoned
 * body first. On Bun a ReadableStream body that is neither read to EOF nor
 * cancelled keeps its socket and native read buffer committed indefinitely,
 * an off-heap leak that ratchets up with every 429/401/529 failover under
 * load. These tests drive real drop/overwrite paths with a body backed by a
 * ReadableStream whose cancel() is instrumented, and assert cancellation.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(overrides: Partial<ProxyContext> = {}): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(1),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://openrouter.ai/api/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		...overrides,
	};
}

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/**
 * Build an error Response whose body is a ReadableStream we can observe. The
 * returned `state.cancelled` ref flips true if the proxy cancels the body
 * (the fix); it stays false if the body is dropped on the floor (the leak).
 * `state.pulled` flips true the moment anything actually reads from the
 * stream (including a discarded provider clone) -- a body that is read
 * anywhere in its tee graph is not abandoned, even if a *sibling* branch's
 * later cancel() call never resolves at the tee level (see the native xAI
 * tests below for why that distinction matters).
 */
function observableBodyResponse(
	status: number,
	json: string,
	headers: Record<string, string> = {},
): { response: Response; state: { cancelled: boolean; pulled: boolean } } {
	const state = { cancelled: false, pulled: false };
	const payload = new TextEncoder().encode(json);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulled = true;
			controller.enqueue(payload);
			controller.close();
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const response = new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
	return { response, state };
}

describe("discardUpstreamBody (unit)", () => {
	it("cancels a fresh body", async () => {
		const { response, state } = observableBodyResponse(429, "{}");
		await discardUpstreamBody(response);
		expect(state.cancelled).toBe(true);
	});

	it("skips a locked body without throwing", async () => {
		const { response, state } = observableBodyResponse(429, "{}");
		// Lock the body by attaching a reader — simulates a body already owned
		// by another consumer (e.g. mid-clone).
		response.body?.getReader();
		await expect(discardUpstreamBody(response)).resolves.toBeUndefined();
		expect(state.cancelled).toBe(false);
	});

	it("swallows the error from an already-cancelled body", async () => {
		const { response } = observableBodyResponse(429, "{}");
		await response.body?.cancel();
		await expect(discardUpstreamBody(response)).resolves.toBeUndefined();
	});

	it("is a no-op for a null/undefined response", async () => {
		await expect(discardUpstreamBody(null)).resolves.toBeUndefined();
		await expect(discardUpstreamBody(undefined)).resolves.toBeUndefined();
	});
});

describe("proxyWithAccount — cancels abandoned upstream body on failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("cancels the 429 body on the no-fallback failover (return null)", async () => {
		const { response, state } = observableBodyResponse(
			429,
			JSON.stringify({
				error: {
					type: "api_error",
					message: "Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
				},
			}),
			{ "retry-after": "60" },
		);
		globalThis.fetch = mock(async () => response);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
		expect(state.cancelled).toBe(true);
	});

	it("cancels the 401 body on the auth-failure failover (return null)", async () => {
		// Real "anthropic" provider is resolved via getProvider(account.provider),
		// which supersedes the mock ctx.provider (openai-compatible test fixture
		// only applies as a fallback for unregistered provider names). Its
		// processResponse() preserves body identity for non-SSE JSON responses,
		// so the observable-body assertion below reflects the true upstream
		// stream, matching how a real Claude-OAuth 401 flows through the proxy.
		const { response, state } = observableBodyResponse(
			401,
			JSON.stringify({
				error: { type: "authentication_error", message: "Invalid API key" },
			}),
		);
		globalThis.fetch = mock(async () => response);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
		expect(state.cancelled).toBe(true);
	});

	it("cancels the abandoned body before overwriting it on a model-fallback retry", async () => {
		const bodies: { cancelled: boolean }[] = [];
		let call = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			call++;
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const model = (JSON.parse(bodyText) as { model?: string }).model ?? "";
			if (call === 1) {
				const { response, state } = observableBodyResponse(
					429,
					JSON.stringify({
						error: { type: "api_error", message: "Rate limit exceeded" },
					}),
				);
				bodies.push(state);
				return response;
			}
			// Fallback model succeeds.
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		try {
			await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_fallbacks: JSON.stringify({
						sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			// forwardToClient on success needs UsageCollector, not wired in unit
			// tests, irrelevant to the cancellation assertion below.
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		expect(call).toBe(2);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].cancelled).toBe(true);
	});

	it("does not abandon the native xAI 402 body on the middle-candidate failover (return null, AE3)", async () => {
		// Native xAI account: provider "xai" resolves to the real registered
		// XaiProvider via getProvider() inside proxyWithAccount (importing
		// proxy-operations.ts transitively registers all built-in providers),
		// not the ctx.provider "openai-compatible" fixture used by the other
		// tests in this file.
		//
		// This path does not exercise state.cancelled the way the other
		// tests in this file do, and that is expected, not a regression.
		// Unlike the no-fallback/auth-failure/model-fallback paths above
		// (which discard rawResponse directly, before any provider hook
		// touches it), the native xAI middle-candidate path always runs the
		// response through provider.processResponse() for classification and
		// then through updateAccountMetadata() -> extractUsageInfo(), which
		// unconditionally clones and reads the body (response-processor.ts).
		// Per the WHATWG ReadableStreamTee cancel algorithm, once ANY
		// sibling in a tee graph is read to completion (not cancelled), a
		// cancel() on another sibling can never propagate to the real
		// underlying source -- it stays permanently pending at the tee
		// level. That is intentional per this codebase's own
		// releaseUnconsumedClone doc comment ("fully draining their inner
		// clone also closes this one ... cancelling an already-closed
		// stream here is a harmless, immediately-resolved no-op"): once a
		// body is read anywhere in its tee graph the underlying resource is
		// released via normal consumption, and a later cancel() elsewhere
		// in that graph is correctly a no-op, not a leak. So the meaningful
		// invariant to protect here is that the body actually gets READ
		// (never silently dropped without being touched at all), which
		// state.pulled verifies.
		const { response, state } = observableBodyResponse(
			402,
			JSON.stringify({ error: { message: "insufficient credits" } }),
		);
		globalThis.fetch = mock(async () => response);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "xai",
				custom_endpoint: null,
				model_mappings: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
		expect(state.pulled).toBe(true);
	});

	it("does not abandon the native xAI 429 body on the middle-candidate failover (return null)", async () => {
		// Same reasoning as the 402 test directly above: the body is
		// consumed via provider.processResponse() / extractUsageInfo(), not
		// via an explicit cancel() on `response` itself, so state.pulled
		// (not state.cancelled) is the correct no-leak signal here.
		const { response, state } = observableBodyResponse(
			429,
			JSON.stringify({ error: { message: "rate limited" } }),
		);
		globalThis.fetch = mock(async () => response);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "xai",
				custom_endpoint: null,
				model_mappings: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
		expect(state.pulled).toBe(true);
	});

	it("does NOT cancel a pass-through response returned to the client (extra_usage_exhausted)", async () => {
		const EXTRA_USAGE_MESSAGE =
			"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";
		const { response, state } = observableBodyResponse(
			400,
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: EXTRA_USAGE_MESSAGE },
			}),
		);
		globalThis.fetch = mock(async () => response);

		const account = makeAccount({
			id: "acc-anthropic-1",
			provider: "anthropic",
			api_key: null,
			refresh_token: "refresh-token",
			access_token: "access-token",
			expires_at: Date.now() + 3 * 60 * 60 * 1000,
			custom_endpoint: null,
			model_mappings: null,
		});
		const ctx = makeProxyContext({
			provider: {
				name: "anthropic",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string) =>
					"https://api.anthropic.com/v1/messages",
				prepareHeaders: (_headers: Headers) => new Headers(),
				transformRequestBody: null,
				processResponse: async (r: Response) => r,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: undefined,
					statusHeader: "allowed",
					remaining: undefined,
				}),
				isStreamingResponse: () => false,
			} as never,
		});

		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Passed through unchanged to the client — body must still be readable.
		expect(result).not.toBeNull();
		expect(result?.status).toBe(400);
		expect(state.cancelled).toBe(false);
		const parsed = await result?.json();
		expect(parsed).toEqual({
			type: "error",
			error: { type: "invalid_request_error", message: EXTRA_USAGE_MESSAGE },
		});
	});
});
