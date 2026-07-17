import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	boundResponseBodyForClassification,
	isModelUnavailableError,
	proxyWithAccount,
} from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Minimal Account fixture for openai-compatible provider
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "kilo-test",
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

// Native xAI account fixture (R5-R10): provider "xai" resolves to the real
// registered XaiProvider via getProvider() inside proxyWithAccount (not the
// ctx.provider override used by the generic/anthropic fixtures above), since
// importing proxy-operations.ts transitively registers all built-in
// providers. custom_endpoint/model_mappings are left unset so XaiProvider's
// beforeConvert() supplies its own xAI defaults.
function makeXaiAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		provider: "xai",
		custom_endpoint: null,
		model_mappings: null,
		...overrides,
	});
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

function makeProxyContext(): ProxyContext {
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
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("proxyWithAccount — 429 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 429 and no fallback is configured", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc123",
					},
				},
				429,
			),
		);

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
	});

	it("retries with fallback model on 429, returns response when fallback succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			// Capture request body to verify model was swapped on retry
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length === 1) {
				// Primary model: 429
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message:
								"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
						},
					},
					429,
				);
			}
			// Fallback model: success
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
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
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(2);
		// Second call should use the fallback model
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
	});

	it("returns null (failover) when both primary and fallback model return 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
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

		expect(result).toBeNull();
	});

	it("cycles through 3-model array: first two 429, third succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length < 3) {
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					},
					429,
				);
			}
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_mappings: JSON.stringify({
						sonnet: [
							"qwen/qwen3.6-plus:free",
							"bytedance-seed/dola-seed-2.0-pro:free",
							"meta-llama/llama-3.3-70b:free",
						],
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(3);
		expect(fetchCalls[0]).toBe("qwen/qwen3.6-plus:free");
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
		expect(fetchCalls[2]).toBe("meta-llama/llama-3.3-70b:free");
	});

	it("returns null when all models in the array are exhausted", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});
});

function makeProxyContextWithAsyncExec(): ProxyContext {
	const ctx = makeProxyContext();
	return {
		...ctx,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

describe("proxyWithAccount — rate limit audit trail (issue #178)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("calls markAccountRateLimited with reason='model_fallback_429' on no-fallback 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The asyncWriter.enqueue mock captures calls; markAccountRateLimited
		// is called inside the enqueued job. Since asyncWriter.enqueue is mocked
		// (does not execute the job), we verify via markAccountRateLimited directly.
		// The feature requires markAccountRateLimited to receive a third `reason` arg.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBeGreaterThan(0);
		const [, , reason] = markMock.mock.calls[0] as [string, number, string];
		expect(reason).toBe("model_fallback_429");
	});

	it("calls markAccountRateLimited with reason='all_models_exhausted_429' when all models fail", async () => {
		// All fetch calls return 429 — primary + every fallback model
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		// At least one call should carry the all_models_exhausted_429 reason
		const reasons = markMock.mock.calls.map(
			(args: unknown[]) => args[2] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
	});
});

describe("proxyWithAccount — attribution source pass-through to saveRequest (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("passes requestMeta.projectAttributionSource/agentAttributionSource through to saveRequest at positions 18/19 on the model_fallback_429 failover path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				projectAttributionSource: "header_project",
				agentAttributionSource: "header_agent",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		// Full positional order (0-indexed): id, method, path, accountUsed,
		// statusCode, success, errorMessage, responseTime, failoverAttempts,
		// usage, agentUsed, apiKeyId, apiKeyName, project, billingType,
		// comboName, originalModel, appliedModel, projectAttributionSource,
		// agentAttributionSource.
		expect(args[18]).toBe("header_project");
		expect(args[19]).toBe("header_agent");
	});

	it("passes null attribution sources through to saveRequest when requestMeta omits them", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(), // no attribution source overrides
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const reasons = saveRequestMock.mock.calls.map(
			(args: unknown[]) => args[6] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call[18]).toBeNull();
		expect(call[19]).toBeNull();
	});
});

describe("proxyWithAccount — originalModel/appliedModel gated by isModelRewrite on direct 429 saveRequest paths (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("persists null/null (not the equal pair) on the model_fallback_429 path when requestMeta carries an unmodified originalModel/appliedModel pair", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				// Agent-detected but NOT rewritten: original === applied. Before the
				// fix this bypassed isModelRewrite and persisted the equal pair,
				// making an untouched request look like a real rewrite.
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-sonnet-4-5",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		expect(args[16]).toBeNull();
		expect(args[17]).toBeNull();
	});

	it("still persists a genuine originalModel/appliedModel rewrite pair on the all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta({
				originalModel: "claude-sonnet-4-5",
				appliedModel: "qwen/qwen3.6-plus:free",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call).toBeDefined();
		expect(call[16]).toBe("claude-sonnet-4-5");
		expect(call[17]).toBe("qwen/qwen3.6-plus:free");
	});
});

describe("proxyWithAccount — in-memory cooldown mutation (issue #178 fix)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sets account.rate_limited_until on model_fallback_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// In-memory mutation should be set immediately (before DB write completes)
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});

	it("sets account.rate_limited_until on all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					"qwen/qwen3.6-plus:free",
					"bytedance-seed/dola-seed-2.0-pro:free",
				],
			}),
		});
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});
});

describe("getModelList — model_fallbacks merge", () => {
	it("merges model_fallbacks into the model list", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
			model_fallbacks: JSON.stringify({
				sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"bytedance-seed/dola-seed-2.0-pro:free",
		]);
	});

	it("returns single-element list when no fallbacks", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const list = getModelList("claude-sonnet-4-5", makeAccount());
		expect(list).toEqual(["qwen/qwen3.6-plus:free"]);
	});

	it("returns array directly when model_mappings value is an array", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["qwen/qwen3.6-plus:free", "meta-llama/llama-3.3-70b:free"],
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"meta-llama/llama-3.3-70b:free",
		]);
	});
});

describe("proxyWithAccount — 529 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 529 and provider parseRateLimit says isRateLimited:true", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		// Override the proxy context to have a provider that treats 529 as rate-limited
		// (matching the Anthropic provider's parseRateLimit behaviour for 529).
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529 || r.status === 429,
				resetTime: r.status === 529 ? Date.now() + 60_000 : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;

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
			ctx,
		);

		expect(result).toBeNull();
	});

	it("returns upstream 529 on the final account attempt instead of pool exhaustion", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		// proxyWithAccount reaches forwardToClient on the final-attempt passthrough,
		// which requires UsageCollector initialization (not wired in unit tests).
		// Catch that specific error while still verifying the passthrough path
		// (not pool exhaustion) was reached.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
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
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(529);
			const body = (await result.json()) as {
				error: { type: string; message: string };
			};
			expect(body.error.type).toBe("overloaded_error");
			expect(body.error.message).toBe("Overloaded");
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the final-attempt passthrough was taken, not pool
			// exhaustion (which would return null without reaching forwardToClient).
			expect(threwUsageCollectorError).toBe(true);
		}
	});

	it("releases the rate-limit-check clone on the final-attempt 529 passthrough", async () => {
		const cancelReasons: string[] = [];
		const originalStreamCancel = ReadableStream.prototype.cancel;
		ReadableStream.prototype.cancel = function (
			this: ReadableStream,
			reason?: unknown,
		) {
			cancelReasons.push(String(reason));
			return originalStreamCancel.call(this, reason);
		};
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		try {
			await proxyWithAccount(
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
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		} finally {
			ReadableStream.prototype.cancel = originalStreamCancel;
		}

		expect(
			cancelReasons.filter((r) => r === "rate_limit_check_clone").length,
		).toBe(1);
	});

	it("isModelUnavailableError returns false for 529 overloaded responses", async () => {
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{ status: 529, headers: { "content-type": "application/json" } },
		);
		expect(await isModelUnavailableError(response)).toBe(false);
	});
});

describe("proxyWithAccount — 529 in-place retry", () => {
	let originalFetch: typeof globalThis.fetch;
	const overloadBody =
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
	const successBody =
		'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	function make529NoResetCtx() {
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529,
				resetTime: undefined, // no reset — triggers in-place retry path
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;
		return ctx;
	}

	it("retries in-place on 529 no-reset and makes exactly 2 fetch calls before succeeding", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
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
				ctx,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// fetch was called twice: initial 529 + 1 in-place retry
		expect(callCount).toBe(2);
		// markAccountRateLimited should NOT have been called — no cooldown on successful retry
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("falls through to cooldown/failover when all retries are exhausted", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				}),
		);

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
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
			ctx,
		);

		// All retries exhausted → null (cooldown applied, failover to next account)
		expect(result).toBeNull();
	});

	it("skips in-place retry when CCFLARE_OVERLOAD_RETRY_ENABLED=false", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		await proxyWithAccount(
			makeRequest(bodyBuffer),
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
			ctx,
		);

		// Disabled — only the initial request, no retries
		expect(callCount).toBe(1);
	});

	it("skips in-place retry for synthetic keepalive requests", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const keepaliveReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});
		await proxyWithAccount(
			keepaliveReq,
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
			ctx,
		);

		// Keepalive — only the initial request, no in-place retries
		expect(callCount).toBe(1);
	});
});

describe("proxyWithAccount — non-codex 529 in-place retry releases superseded responses (P1)", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalStreamCancel: typeof ReadableStream.prototype.cancel;
	let cancelReasons: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		cancelReasons = [];
		originalStreamCancel = ReadableStream.prototype.cancel;
		ReadableStream.prototype.cancel = function (
			this: ReadableStream,
			reason?: unknown,
		) {
			cancelReasons.push(String(reason));
			return originalStreamCancel.call(this, reason);
		};
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		ReadableStream.prototype.cancel = originalStreamCancel;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	it("cancels both superseded 529 response bodies for a non-codex (anthropic) account, and still forwards the eventual success to the client", async () => {
		const overloadBody =
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
		const successBody =
			'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount <= 2) {
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying both superseded 529 responses
		// were released.
		try {
			await proxyWithAccount(
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
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// Initial 529 + 2 in-place retries (the second retry succeeds).
		expect(callCount).toBe(3);
		const supersededCancels = cancelReasons.filter(
			(r) => r === "in_place_529_retry_superseded",
		);
		expect(supersededCancels.length).toBe(2);
	});
});

describe("proxyWithAccount: Codex 529 in-place retry drains discarded streaming responses", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep, matching the generic
		// "529 in-place retry" describe block above.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * Builds a spy-wrapped Codex SSE upstream Response with two committing
	 * events (self-closing). With the transform's default backpressure
	 * (highWaterMark = 1), the second event blocks CodexProvider's
	 * background processEvents() task inside writeSSE() until something
	 * actively reads or cancels the transformed response: per
	 * provider-stream-abandonment.test.ts, a stream stuck at that point
	 * never notices its own raw upstream closing, because processEvents()
	 * is parked in awaitDownstreamCapacity() and never issues the next
	 * upstream read. So releasing this spy's reader genuinely requires the
	 * retry loop's `await response.arrayBuffer()` drain (or the
	 * discardUnusedResponse hook) to actively consume/cancel the transformed
	 * response; it is not an artifact of the raw upstream eventually
	 * closing on its own. The upstream itself still self-closes (rather than
	 * staying open forever like the abandonment test's fixture) because this
	 * test's drain calls are meant to complete, not merely be checked for
	 * having had no effect within a bounded window.
	 */
	function makeLiveSpiedCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_1", model: "gpt-5.4" } })}\n\n`,
		);
		const frame2 = encoder.encode(
			`event: response.output_item.added\ndata: ${JSON.stringify({ item: { type: "function_call", call_id: "call_1", name: "Bash" } })}\n\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				controller.enqueue(frame2);
				controller.close();
			},
		});
		let releaseLockCalls = 0;
		let cancelCalls = 0;
		const originalGetReader = stream.getReader.bind(stream);
		// biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of a built-in
		(stream as any).getReader = (...args: unknown[]) => {
			// biome-ignore lint/suspicious/noExplicitAny: forwarding getReader() args
			const reader = (originalGetReader as any)(...args);
			const originalReleaseLock = reader.releaseLock.bind(reader);
			const originalCancel = reader.cancel.bind(reader);
			reader.releaseLock = (...a: unknown[]) => {
				releaseLockCalls++;
				return originalReleaseLock(...a);
			};
			reader.cancel = (...a: unknown[]) => {
				cancelCalls++;
				return originalCancel(...a);
			};
			return reader;
		};
		const response = new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
		return {
			response,
			getReleaseLockCalls: () => releaseLockCalls,
			getCancelCalls: () => cancelCalls,
		};
	}

	/**
	 * The final, successful upstream: a real, self-closing Codex SSE stream
	 * that completes normally (response.created -> function_call item ->
	 * arguments -> done -> response.completed), so it can flow all the way
	 * through to forwardToClient without getting stuck on backpressure.
	 */
	function makeSuccessCodexUpstream() {
		const encoder = new TextEncoder();
		const events: Array<[string, unknown]> = [
			["response.created", { response: { id: "resp_2", model: "gpt-5.4" } }],
			[
				"response.output_item.added",
				{ item: { type: "message", id: "msg_1" } },
			],
			[
				"response.content_part.added",
				{ part: { type: "output_text" }, content_index: 0 },
			],
			["response.output_text.delta", { delta: "hi" }],
			["response.output_item.done", { item: { type: "message" } }],
			[
				"response.completed",
				{
					response: {
						id: "resp_2",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			],
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const [event, data] of events) {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it(
		"drains both discarded 529 streaming responses (no unresolved upstream " +
			"reader left open) and completes the retry loop with a third success",
		async () => {
			const overloadBody =
				'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
			const upstream1 = makeLiveSpiedCodexUpstream(529);
			const upstream2 = makeLiveSpiedCodexUpstream(529);
			let callCount = 0;
			globalThis.fetch = mock(async () => {
				callCount++;
				if (callCount === 1) return upstream1.response;
				if (callCount === 2) return upstream2.response;
				if (callCount === 3) return makeSuccessCodexUpstream();
				// Any further call is unexpected for this test's fixture.
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			});

			// CodexProvider.transformRequestBody records whether the ORIGINAL
			// client request asked to stream (body.stream === true) in a
			// requestId-keyed map, and processResponse consults that map to
			// decide whether to run the live SSE transform under test
			// (transformStreamingResponse) or a buffering non-streaming
			// fallback (transformSseResponseToJson). Without stream: true here,
			// every response.processResponse call in this test would silently
			// take the buffering path instead of the one this test exists to
			// exercise.
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 10,
					stream: true,
				}),
			).buffer;
			const req = makeRequest(bodyBuffer);
			// proxyWithAccount reaches forwardToClient on success, which requires
			// UsageCollector initialization (not wired in unit tests). Catch that
			// specific error while still verifying the retry drained both
			// discarded 529 responses before the final success was handed off.
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					makeAccount({
						provider: "codex",
						api_key: "test-key",
						access_token: null,
						refresh_token: "",
					}),
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}

			// Exactly 2 in-place retries fired before the third call succeeded.
			expect(callCount).toBe(3);

			// Neither discarded 529 response's upstream reader was left open:
			// the retry loop's own `await response.arrayBuffer()` drain (for
			// the first) and the reassignment to the second retry response
			// (drained the same way on the next loop iteration) must have
			// released both. A stuck reader here means the loop reassigned
			// `response` without consuming the prior value.
			expect(
				upstream1.getCancelCalls() > 0 || upstream1.getReleaseLockCalls() > 0,
			).toBe(true);
			expect(
				upstream2.getCancelCalls() > 0 || upstream2.getReleaseLockCalls() > 0,
			).toBe(true);
		},
	);
});

describe("proxyWithAccount: Codex 529 rate-limited failover does not hang on abandoned clone tee branches", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Retries disabled so the 529 falls straight through to
		// processProxyResponse -> rate_limited_failover instead of the
		// in-place retry loop, keeping the repro minimal and deterministic.
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * A live, spy-wrapped Codex SSE upstream whose body deliberately never
	 * closes (no controller.close() call), mirroring a real Codex connection
	 * that stays open until the server sends a terminal event or the socket
	 * drops. Nothing in this test ever naturally terminates the stream on its
	 * own: the only way `proxyWithAccount` can resolve at all is for the
	 * fix's cancel-on-abandon paths to actively cancel (or fully release) the
	 * upstream reader.
	 */
	function makeLiveNeverClosingCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_hang", model: "gpt-5.4" } })}\n\n`,
		);
		let releaseLockCalls = 0;
		let cancelCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				// Deliberately never close().
			},
		});
		const originalGetReader = stream.getReader.bind(stream);
		// biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of a built-in
		(stream as any).getReader = (...args: unknown[]) => {
			// biome-ignore lint/suspicious/noExplicitAny: forwarding getReader() args
			const reader = (originalGetReader as any)(...args);
			const originalReleaseLock = reader.releaseLock.bind(reader);
			const originalCancel = reader.cancel.bind(reader);
			reader.releaseLock = (...a: unknown[]) => {
				releaseLockCalls++;
				return originalReleaseLock(...a);
			};
			reader.cancel = (...a: unknown[]) => {
				cancelCalls++;
				return originalCancel(...a);
			};
			return reader;
		};
		const response = new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
		return {
			response,
			getReleaseLockCalls: () => releaseLockCalls,
			getCancelCalls: () => cancelCalls,
		};
	}

	it("resolves null within 2s instead of hanging on discardUnusedResponse, and " +
		"eventually cancels or releases the abandoned upstream reader", async () => {
		const upstream = makeLiveNeverClosingCodexUpstream(529);
		globalThis.fetch = mock(async () => upstream.response);

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
				stream: true,
			}),
		).buffer;
		const req = makeRequest(bodyBuffer);

		const account = makeAccount({
			provider: "codex",
			api_key: "test-key",
			access_token: null,
			refresh_token: "",
		});

		const resultPromise = proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		const TIMEOUT = Symbol("timeout");
		const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) =>
			setTimeout(() => resolve(TIMEOUT), 2000),
		);
		const outcome = await Promise.race([resultPromise, timeoutPromise]);

		// Before the fix: discardUnusedResponse awaits an unboundable
		// body.cancel() on a tee branch whose siblings (the parseRateLimit
		// and extractUsageInfo clones) were abandoned without ever being
		// read or cancelled, so this races the 2s timeout and loses.
		expect(outcome).not.toBe(TIMEOUT);
		expect(outcome).toBeNull();

		// Give the transform's background processEvents() task a tick to
		// observe the cancellation and run its own cleanup.
		await Bun.sleep(20);
		expect(
			upstream.getCancelCalls() > 0 || upstream.getReleaseLockCalls() > 0,
		).toBe(true);
	}, 3000);
});

describe("proxyWithAccount: Codex 529 in-place retry drain is bounded by a timeout (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_IN_PLACE_RETRY_DRAIN_TIMEOUT_MS = "50";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_IN_PLACE_RETRY_DRAIN_TIMEOUT_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * A live Codex SSE upstream whose body deliberately never closes,
	 * mirroring a real connection that never emits a terminal frame. Before
	 * the fix, the retry loop's `await response.arrayBuffer()` drain of the
	 * superseded response has no bound and would hang forever on a body
	 * like this.
	 */
	function makeLiveNeverClosingCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_drain_hang", model: "gpt-5.4" } })}\n\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				// Deliberately never close().
			},
		});
		return new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("proceeds to the in-place retry instead of hanging when the superseded 529 body never closes", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return makeLiveNeverClosingCodexUpstream(529);
		});

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
				stream: true,
			}),
		).buffer;
		const req = makeRequest(bodyBuffer);

		const resultPromise = proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "codex",
				api_key: "test-key",
				access_token: null,
				refresh_token: "",
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		).catch((e) => {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("UsageCollector not initialized")) return null;
			throw e;
		});

		const TIMEOUT = Symbol("timeout");
		const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) =>
			setTimeout(() => resolve(TIMEOUT), 2000),
		);
		const outcome = await Promise.race([resultPromise, timeoutPromise]);

		// Before the fix: `await response.arrayBuffer()` on the never-closing
		// first 529 body blocks forever, so the retry loop never reaches its
		// second fetch call and this races the 2s timeout and loses.
		expect(outcome).not.toBe(TIMEOUT);
		expect(callCount).toBe(2);
	}, 3000);
});

describe("proxyWithAccount — 401 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 401", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{ error: { type: "authentication_error", message: "Invalid API key" } },
				401,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("does not failover on successful 200 response", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: "qwen/qwen3.6-plus:free",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying no failover (null) occurred.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(200);
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the success path was taken and no failover (null) occurred.
			expect(threwUsageCollectorError).toBe(true);
		}
	});
});

describe("proxyWithAccount - native xAI capacity failover (R5-R10, AE3/AE4a)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("AE3: middle-candidate xAI 402 releases the body, persists cooldown with reason=xai_capacity_402, and fails over (returns null)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"insufficient credits"}', {
					status: 402,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeXaiAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			// modelOverride, apiKeyId, apiKeyName, requestBodyContext,
			// returnRateLimitedResponseOnExhaustion left at defaults: this is a
			// MIDDLE candidate (not the final one), matching AE3's "candidate two
			// serves the request" setup.
		);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("xai_capacity_402");
	});

	it("middle-candidate xAI 429 also fails over and persists the standard reason (never relabeled as xai_capacity_402)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"rate limited"}', {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeXaiAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("upstream_429_no_reset_probe_cooldown");
	});

	it("AE4a: final-candidate xAI 402 updates cooldown from a clone and forwards the original status/headers/body intact", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"insufficient credits","code":"xai_402"}', {
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-marker": "xai-402-original",
					},
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true, // returnRateLimitedResponseOnExhaustion: final candidate
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(402);
			expect(result.headers.get("x-upstream-marker")).toBe("xai-402-original");
			const body = (await result.json()) as { error: string; code: string };
			expect(body.error).toBe("insufficient credits");
			expect(body.code).toBe("xai_402");
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the final-candidate passthrough was taken, not the
			// middle-candidate discard/failover (which returns null without
			// reaching forwardToClient).
			expect(threwUsageCollectorError).toBe(true);
		}

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("xai_capacity_402");
	});

	it("AE4a: final-candidate xAI 429 forwards the original status/headers/body intact", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"rate limited"}', {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "30",
					},
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(429);
			const body = (await result.json()) as { error: string };
			expect(body.error).toBe("rate limited");
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
	});

	it("does not fail over on a native xAI 400 (not classified as rate-limited)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"bad request"}', {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		// A 400 is not a rate limit signal for xAI: it must be forwarded as-is
		// (or reach forwardToClient), never treated as a failover trigger.
		if (result) {
			expect(result.status).toBe(400);
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).not.toHaveBeenCalled();
	});

	it("64 KiB cap: an oversized final-candidate xAI 402 body is still forwarded to the client byte-for-byte, unenriched", async () => {
		// One byte over the 64 KiB classification cap.
		const oversizedPayload = `{"error":"${"x".repeat(64 * 1024 + 1)}"}`;
		globalThis.fetch = mock(
			async () =>
				new Response(oversizedPayload, {
					status: 402,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(402);
			const text = await result.text();
			expect(text).toBe(oversizedPayload);
			expect(text.length).toBeGreaterThan(64 * 1024);
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
		// Classification still ran (status-only for xAI) and still persisted a
		// cooldown despite the oversized body exceeding the classification cap.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
	});
});

describe("boundResponseBodyForClassification (64 KiB final-candidate classification cap)", () => {
	it("returns a response whose body is preserved byte-for-byte when under the cap", async () => {
		const original = new Response('{"error":"small body"}', {
			status: 402,
			headers: { "content-type": "application/json", "x-test": "1" },
		});

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		expect(bounded.headers.get("x-test")).toBe("1");
		const text = await bounded.text();
		expect(text).toBe('{"error":"small body"}');
	});

	it("returns a headers-only (no body) response when the body exceeds the 64 KiB cap", async () => {
		const oversized = "x".repeat(64 * 1024 + 1);
		const original = new Response(oversized, {
			status: 402,
			headers: { "content-type": "application/json", "x-test": "2" },
		});

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		expect(bounded.headers.get("x-test")).toBe("2");
		const text = await bounded.text();
		expect(text).toBe("");
	});

	it("preserves a body exactly at the 64 KiB boundary", async () => {
		const exact = "y".repeat(64 * 1024);
		const original = new Response(exact, { status: 429 });

		const bounded = await boundResponseBodyForClassification(original);

		const text = await bounded.text();
		expect(text).toBe(exact);
	});

	it("passes through a response with no body unchanged", async () => {
		const original = new Response(null, { status: 402 });

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		const text = await bounded.text();
		expect(text).toBe("");
	});
});
