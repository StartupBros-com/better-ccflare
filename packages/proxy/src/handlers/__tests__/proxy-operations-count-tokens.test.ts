import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { CodexProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import {
	createContextAdmissionTracker,
	createContextLengthExceededResponse,
	proxyWithAccount,
	sanitizeInternalHeaders,
	selectAdmittedCodexModel,
} from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: "",
		refresh_token: "refresh-token",
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(path = "/v1/messages/count_tokens"): RequestMeta {
	return {
		id: "req-count-tokens",
		method: "POST",
		path,
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: new CodexProvider() as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeCountTokensRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages/count_tokens", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function makeMessagesRequest(
	body: ArrayBuffer,
	headers: Record<string, string>,
) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers,
	});
}

describe("proxyWithAccount — Codex count_tokens", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_CONTEXT_ADMISSION;
	});

	it("returns a synthetic token count without fetching or refreshing Codex", async () => {
		const fetchMock = mock(async () => {
			throw new Error("count_tokens should not call upstream or refresh Codex");
		});
		globalThis.fetch = fetchMock;

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello world" }],
			}),
		).buffer;
		const ctx = makeProxyContext();
		const result = await proxyWithAccount(
			makeCountTokensRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages/count_tokens"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
		expect(result).toBeInstanceOf(Response);
		expect(result?.status).toBe(200);
		const payload = await result?.json();
		expect(payload.input_tokens).toBeNumber();
		expect(payload.input_tokens).toBeGreaterThan(0);
	});

	it("returns a synthetic error for malformed count_tokens without fetching", async () => {
		const fetchMock = mock(async () => {
			throw new Error("malformed count_tokens should not call upstream Codex");
		});
		globalThis.fetch = fetchMock;

		const bodyBuffer = new TextEncoder().encode("{not-json").buffer;
		const ctx = makeProxyContext();
		const result = await proxyWithAccount(
			makeCountTokensRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages/count_tokens"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
		expect(result).toBeInstanceOf(Response);
		expect(result?.status).toBe(400);
		const payload = await result?.json();
		expect(payload.error.message).toBe(
			"Codex count_tokens requires a valid JSON request body.",
		);
	});

	it("returns max_tokens: 0 as a trusted local 400 without fetching Codex", async () => {
		const fetchMock = mock(async () => {
			throw new Error("max_tokens: 0 should not call upstream Codex");
		});
		globalThis.fetch = fetchMock;

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello world" }],
				max_tokens: 0,
			}),
		).buffer;
		const collector = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);

			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(result).toBeInstanceOf(Response);
			expect(result?.status).toBe(400);
			expect(result?.headers.get("content-type")).toContain("application/json");
			expect(await result?.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Codex subscription requests do not support max_tokens: 0.",
				},
			});
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("marks attributed Codex descendants after provider selection and strips the marker upstream", async () => {
		let fetchedRequest: Request | null = null;
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock;

		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);

		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello world" }],
					max_tokens: 16,
					tools: [
						{
							name: "Agent",
							description: "Spawn an agent.",
							input_schema: { type: "object" },
						},
					],
				}),
			).buffer;
			await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-better-ccflare-attributed-agent": "false",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				{
					...makeRequestMeta("/v1/messages"),
					agentUsed: "general-purpose",
				},
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} finally {
			collectorSpy.mockRestore();
		}

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest).not.toBeNull();
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-attributed-agent"),
		).toBeNull();
		const upstreamBody = await fetchedRequest?.clone().json();
		expect(upstreamBody.tools).toEqual([]);
	});

	it("does not mark unattributed Codex requests", async () => {
		let fetchedRequest: Request | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);

		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello world" }],
					max_tokens: 16,
					tools: [
						{
							name: "Agent",
							description: "Spawn an agent.",
							input_schema: { type: "object" },
						},
					],
				}),
			).buffer;
			await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} finally {
			collectorSpy.mockRestore();
		}

		const upstreamBody = await fetchedRequest?.clone().json();
		expect(
			upstreamBody.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["Agent"]);
	});

	it.each([
		["cc_version=2.1.207; cc_entrypoint=cli; cc_is_subagent=true", []],
		["cc_version=2.1.207; cc_is_subagent=false", ["Agent"]],
		["cc_version=2.1.207; cc_is_subagent=TRUE", ["Agent"]],
		["cc_version=2.1.207; not_cc_is_subagent=true", ["Agent"]],
	])("derives descendant containment from billing metadata %s", async (billingHeader, expectedTools) => {
		let fetchedRequest: Request | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);

		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello world" }],
					max_tokens: 16,
					tools: [
						{
							name: "Agent",
							description: "Spawn an agent.",
							input_schema: { type: "object" },
						},
					],
				}),
			).buffer;
			await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-anthropic-billing-header": billingHeader,
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} finally {
			collectorSpy.mockRestore();
		}

		const upstreamBody = await fetchedRequest?.clone().json();
		expect(
			upstreamBody.tools.map((tool: { name: string }) => tool.name),
		).toEqual(expectedTools);
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-attributed-agent"),
		).toBeNull();
	});

	it("does not trust client-supplied synthetic response markers", async () => {
		let fetchedRequest: Request | null = null;
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock;

		const collector = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello world" }],
					max_tokens: 16,
				}),
			).buffer;
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-better-ccflare-synthetic-response": "true",
					"x-better-ccflare-synthetic-status": "418",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);

			expect(result).toBeInstanceOf(Response);
			expect(result?.status).toBe(200);
			await result?.text();
		} finally {
			collectorSpy.mockRestore();
		}

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			fetchedRequest?.url.startsWith(
				"https://chatgpt.com/backend-api/codex/responses",
			),
		).toBeTrue();
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-synthetic-response"),
		).toBeNull();
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-synthetic-status"),
		).toBeNull();
	});

	it("skips an undersized Codex model before fetch and uses a larger mapped fallback", async () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		let fetchedModel: string | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			fetchedModel =
				((await request.clone().json()) as { model?: string }).model ?? null;
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "summary" }],
					max_tokens: 50_000,
				}),
			).buffer;
			const tracker = createContextAdmissionTracker(110_000, 50_000);
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
					model_mappings: JSON.stringify({
						sonnet: ["gpt-5.3-codex-spark", "gpt-5.6-sol"],
					}),
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				tracker,
			);
			await result?.text();
			expect(fetchedModel).toBe("gpt-5.6-sol");
			expect(tracker.rejectedCount).toBe(1);
			expect(tracker.attemptedCount).toBe(1);
			expect(tracker.requestedMaxOutputTokens).toBe(50_000);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("admission uses the provider's default for a family missing from partial account mappings", () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const tracker = createContextAdmissionTracker(250_000, 20_000);
		const result = selectAdmittedCodexModel(
			makeCodexAccount({
				model_mappings: JSON.stringify({ haiku: "gpt-5.4-mini" }),
			}),
			"claude-sonnet-4-5",
			tracker,
		);
		expect(result).toEqual({ admitted: false, model: null });
		expect(tracker.rejectedCount).toBe(1);
		expect(tracker.largestSafeLimit).toBe(258_400);
	});

	it("reserves the full forwarded max_tokens and reports the exact occupied total", async () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const tracker = createContextAdmissionTracker(220_000, 50_000);
		const result = selectAdmittedCodexModel(
			makeCodexAccount({
				model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
			}),
			"claude-sonnet-4-5",
			tracker,
		);
		expect(result).toEqual({ admitted: false, model: null });
		expect(tracker.requestedMaxOutputTokens).toBe(50_000);
		expect(tracker.largestSafeLimit).toBe(258_400);
		const response = createContextLengthExceededResponse(tracker);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "prompt is too long: 270000 tokens > 258400 tokens",
				code: "context_length_exceeded",
			},
		});
	});

	it("excludes count_tokens from admission", async () => {
		const path = "/v1/messages/count_tokens";
		const extraHeaders = {};
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock;
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "gpt-5.3-codex-spark",
					messages: [{ role: "user", content: "synthetic" }],
					max_tokens: 20_000,
				}),
			).buffer;
			const tracker = createContextAdmissionTracker(300_000, 20_000);
			const req = new Request(`https://proxy.local${path}`, {
				method: "POST",
				body: bodyBuffer,
				headers: { "Content-Type": "application/json", ...extraHeaders },
			});
			const result = await proxyWithAccount(
				req,
				new URL(`https://proxy.local${path}`),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta(path),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				tracker,
			);
			await result?.text();
			expect(tracker.rejectedCount).toBe(0);
			expect(tracker.attemptedCount).toBe(0);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it.each([
		["x-better-ccflare-keepalive", "true"],
		["x-better-ccflare-keepalive", "false"],
		["x-better-ccflare-auto-refresh", "true"],
		["x-better-ccflare-auto-refresh", "false"],
	])("does not let client header %s=%s bypass admission", async (header, value) => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const fetchMock = mock(async () => {
			throw new Error("capacity rejection must happen before fetch");
		});
		globalThis.fetch = fetchMock;
		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "gpt-5.3-codex-spark",
				messages: [{ role: "user", content: "internal-looking" }],
				max_tokens: 20_000,
			}),
		).buffer;
		const tracker = createContextAdmissionTracker(120_000, 20_000);
		const result = await proxyWithAccount(
			makeMessagesRequest(bodyBuffer, {
				"Content-Type": "application/json",
				[header]: value,
			}),
			new URL("https://proxy.local/v1/messages"),
			makeCodexAccount({
				access_token: "access-token",
				expires_at: Date.now() + 60 * 60 * 1000,
			}),
			makeRequestMeta("/v1/messages"),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			tracker,
		);
		expect(result).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(tracker.rejectedCount).toBe(1);
		expect(tracker.attemptedCount).toBe(0);
	});

	it("excludes max_tokens zero cache-prewarm requests from admission", async () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const fetchMock = mock(async () => {
			throw new Error("subscription prewarm should remain a local response");
		});
		globalThis.fetch = fetchMock;
		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "gpt-5.3-codex-spark",
				messages: [{ role: "user", content: "prewarm" }],
				max_tokens: 0,
			}),
		).buffer;
		const tracker = createContextAdmissionTracker(300_000, 0);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		const result = await proxyWithAccount(
			makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
			new URL("https://proxy.local/v1/messages"),
			makeCodexAccount({
				access_token: "access-token",
				expires_at: Date.now() + 60 * 60 * 1000,
			}),
			makeRequestMeta("/v1/messages"),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			tracker,
		);
		try {
			expect(result?.status).toBe(400);
			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(tracker.rejectedCount).toBe(0);
			expect(tracker.attemptedCount).toBe(0);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("preserves later mapped fallback traversal after preselecting the first safe model", async () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const fetchedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const model = ((await request.clone().json()) as { model: string }).model;
			fetchedModels.push(model);
			if (model === "gpt-5.4") {
				return new Response(
					JSON.stringify({ error: { code: "model_not_found" } }),
					{
						status: 429,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "fallback" }],
					max_tokens: 20_000,
				}),
			).buffer;
			const tracker = createContextAdmissionTracker(110_000, 20_000);
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
					model_mappings: JSON.stringify({
						sonnet: ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.6-sol"],
					}),
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				tracker,
			);
			await result?.text();
			expect(fetchedModels).toEqual(["gpt-5.4", "gpt-5.6-sol"]);
			expect(tracker.rejectedCount).toBe(1);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("fails open for unknown Codex capacity", async () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock;
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "unknown-codex-model",
					messages: [{ role: "user", content: "summarize this conversation" }],
					max_tokens: 10,
				}),
			).buffer;
			const tracker = createContextAdmissionTracker(999_999, 10);
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				tracker,
			);
			await result?.text();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(tracker.rejectedCount).toBe(0);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("leaves behavior unchanged when context admission is off", async () => {
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock;
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "gpt-5.3-codex-spark",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 20_000,
				}),
			).buffer;
			const tracker = createContextAdmissionTracker(200_000, 20_000);
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, { "Content-Type": "application/json" }),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				tracker,
			);
			await result?.text();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(tracker.rejectedCount).toBe(0);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("rejects every undersized candidate without cooldown or account mutation", () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({
				sonnet: ["gpt-5.3-codex-spark", "gpt-5.4"],
			}),
		});
		const tracker = createContextAdmissionTracker(300_000, 20_000);
		const result = selectAdmittedCodexModel(
			account,
			"claude-sonnet-4-5",
			tracker,
		);
		expect(result).toEqual({ admitted: false, model: null });
		expect(tracker.rejectedCount).toBe(2);
		expect(tracker.attemptedCount).toBe(0);
		expect(tracker.largestSafeLimit).toBe(258_400);
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
	});

	it("preserves a meaningful attempted failure over later capacity skips", () => {
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		const tracker = createContextAdmissionTracker(300_000, 20_000);
		tracker.attemptedCount = 1;
		const result = selectAdmittedCodexModel(
			makeCodexAccount({
				model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
			}),
			"claude-sonnet-4-5",
			tracker,
		);
		expect(result.admitted).toBeFalse();
		expect(tracker.rejectedCount).toBe(1);
		expect(tracker.attemptedCount).toBe(1);
	});

	it("builds the exact pre-stream Anthropic context error using the largest safe limit", async () => {
		const tracker = createContextAdmissionTracker(360_000, 50_000);
		tracker.rejectedCount = 2;
		tracker.largestSafeLimit = 353_400;
		const response = createContextLengthExceededResponse(tracker);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "prompt is too long: 410000 tokens > 353400 tokens",
				code: "context_length_exceeded",
			},
		});
	});

	it("strips every internal transport header from passthrough headers", () => {
		const headers = new Headers({
			authorization: "Bearer public-upstream-token",
			"x-better-ccflare-request-id": "req-internal",
			"x-better-ccflare-pacing-canary": "bypass",
			"x-better-ccflare-pacing-cohort-id": "cohort",
			"x-better-ccflare-pacing-action": "bypassed",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-attributed-agent": "true",
		});
		const sanitized = sanitizeInternalHeaders(headers);
		expect(sanitized.get("authorization")).toBe("Bearer public-upstream-token");
		for (const name of [
			"x-better-ccflare-request-id",
			"x-better-ccflare-pacing-canary",
			"x-better-ccflare-pacing-cohort-id",
			"x-better-ccflare-pacing-action",
			"x-better-ccflare-request-stream",
			"x-better-ccflare-attributed-agent",
		]) {
			expect(sanitized.get(name)).toBeNull();
		}
		// Pure helper: the reusable transform headers remain intact for retries.
		expect(headers.get("x-better-ccflare-request-id")).toBe("req-internal");
	});

	it("does not trust client-supplied pacing experiment metadata", async () => {
		let transformedHeaders: Headers | null = null;
		const provider = new CodexProvider();
		const originalTransform = provider.transformRequestBody.bind(provider);
		provider.transformRequestBody = async (request, account) => {
			transformedHeaders = new Headers(request.headers);
			return originalTransform(request, account);
		};
		const ctx = makeProxyContext();
		ctx.provider = provider as never;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			).buffer;
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-better-ccflare-pacing-canary": "spoofed",
					"x-better-ccflare-pacing-cohort-id": "secret-value",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
			await result?.text();
		} finally {
			collectorSpy.mockRestore();
		}
		expect(
			transformedHeaders?.get("x-better-ccflare-pacing-canary") ?? null,
		).toBeNull();
		expect(
			transformedHeaders?.get("x-better-ccflare-pacing-cohort-id") ?? null,
		).toBeNull();
	});
});
