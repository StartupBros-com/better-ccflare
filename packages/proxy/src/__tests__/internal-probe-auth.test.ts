import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	type CacheReplayModelStrategy,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import { cacheBodyStore } from "../cache-body-store";
import {
	CACHE_PACING_MS_ENV,
	getCachePacingStats,
	resetCachePacing,
} from "../cache-pacing";
import { CACHE_REPLAY_MODEL_HEADER } from "../cache-transport-staging";
import type { ProxyContext } from "../handlers";
import {
	consumeInternalAutoRefreshAuth,
	INTERNAL_AUTO_REFRESH_HEADER,
	stampInternalAutoRefreshAuth,
} from "../internal-probe-auth";
import { handleProxy } from "../proxy";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "refresh-account",
		name: "refresh-account",
		provider: "test-provider" as Account["provider"],
		api_key: "test-key",
		refresh_token: null,
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
		paused: true,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: true,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: "overage",
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeContext(
	account: Account,
	preparedHeaders: Headers[],
	cacheReplayModelStrategy?: CacheReplayModelStrategy,
): ProxyContext {
	return {
		strategy: { select: mock(() => []) },
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		},
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider: {
			name: "test-provider",
			cacheReplayModelStrategy,
			canHandle: () => true,
			buildUrl: () => "https://upstream.test/v1/messages",
			prepareHeaders: (headers: Headers) => {
				preparedHeaders.push(new Headers(headers));
				return new Headers(headers);
			},
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) },
	} as unknown as ProxyContext;
}

function makeRequest(
	headers: Headers,
	model = "claude-haiku-4-5",
	bodyOverrides: Record<string, unknown> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 8,
			...bodyOverrides,
		}),
	});
}

const originalFetch = globalThis.fetch;
const originalCachePacingMs = process.env[CACHE_PACING_MS_ENV];

afterEach(() => {
	globalThis.fetch = originalFetch;
	usageCache.delete("refresh-account");
	cacheBodyStore.setEnabled(false);
	resetCachePacing();
	if (originalCachePacingMs === undefined) {
		delete process.env[CACHE_PACING_MS_ENV];
	} else {
		process.env[CACHE_PACING_MS_ENV] = originalCachePacingMs;
	}
});

describe("internal auto-refresh authentication", () => {
	it("has the scheduler stamp its localhost probe with the process credential", async () => {
		let sentHeaders: Headers | null = null;
		globalThis.fetch = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				sentHeaders = new Headers(init?.headers);
				return new Response("upstream unavailable", { status: 500 });
			},
		) as unknown as typeof fetch;
		const db = {
			run: mock(async () => undefined),
			runWithChanges: mock(async () => 0),
			query: mock(async () => []),
		};
		const scheduler = new AutoRefreshScheduler(
			db as never,
			{ runtime: { port: 8080, clientId: "test" } } as never,
		) as unknown as {
			sendDummyMessage(account: Record<string, unknown>): Promise<boolean>;
		};

		await scheduler.sendDummyMessage({
			id: "scheduler-account",
			name: "scheduler-account",
			provider: "anthropic",
			refresh_token: "refresh-token",
			access_token: "access-token",
			expires_at: Date.now() + 60_000,
			rate_limit_reset: null,
			custom_endpoint: null,
			paused: 0,
			auto_pause_on_overage_enabled: 0,
			pause_reason: null,
		});

		expect(sentHeaders).not.toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-auto-refresh")).toBe("true");
		expect(consumeInternalAutoRefreshAuth(sentHeaders as Headers)).toBe(true);
	});

	it("uses an unguessable process credential and consumes its private header", () => {
		const headers = new Headers();
		stampInternalAutoRefreshAuth(headers);
		const credential = headers.get(INTERNAL_AUTO_REFRESH_HEADER);

		expect(credential?.length).toBeGreaterThanOrEqual(32);
		expect(consumeInternalAutoRefreshAuth(headers)).toBe(true);
		expect(headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
	});

	it("deletes an invalid private header without trusting it", () => {
		const headers = new Headers({
			[INTERNAL_AUTO_REFRESH_HEADER]: "caller-controlled",
		});

		expect(consumeInternalAutoRefreshAuth(headers)).toBe(false);
		expect(headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
	});

	it("admits a valid internal scheduler probe and never forwards the credential", async () => {
		const account = makeAccount();
		const preparedHeaders: Headers[] = [];
		const ctx = makeContext(account, preparedHeaders);
		let upstreamHeaders: Headers | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstream = input instanceof Request ? input : new Request(input);
			upstreamHeaders = new Headers(upstream.headers);
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-account-id": account.id,
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-bypass-session": "true",
		});
		stampInternalAutoRefreshAuth(headers);
		const request = makeRequest(headers);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(request.headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(preparedHeaders[0]?.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(upstreamHeaders?.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
	});

	it("reapplies a trusted keepalive fallback model after provider conversion and strips the directive upstream", async () => {
		const account = makeAccount({ paused: false });
		const preparedHeaders: Headers[] = [];
		const ctx = makeContext(account, preparedHeaders, "transformed-body");
		ctx.provider.transformRequestBody = async (request: Request) => {
			const transformed = (await request.json()) as Record<string, unknown>;
			// Characterize the production fallback defect: normal conversion maps the
			// replay source alias back to the provider's primary model.
			transformed.model = "physical-primary-model";
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(transformed),
			});
		};
		let upstreamBody: Record<string, unknown> | null = null;
		let upstreamHeaders: Headers | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstream = input instanceof Request ? input : new Request(input);
			upstreamBody = (await upstream.json()) as Record<string, unknown>;
			upstreamHeaders = new Headers(upstream.headers);
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-account-id": account.id,
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-keepalive": "true",
			[CACHE_REPLAY_MODEL_HEADER]: "physical-fallback-model",
		});
		stampInternalAutoRefreshAuth(headers);
		const request = makeRequest(headers);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamBody?.model).toBe("physical-fallback-model");
		expect(request.headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(upstreamHeaders?.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(upstreamHeaders?.has(CACHE_REPLAY_MODEL_HEADER)).toBe(false);
	});

	it("preserves a Vertex-style replay model in the upstream URL without adding it to the transformed body", async () => {
		const account = makeAccount({ paused: false });
		const preparedHeaders: Headers[] = [];
		const ctx = makeContext(account, preparedHeaders, "normalized-source");
		let preparedModel = "physical-primary-model";
		ctx.provider.prepareRequest = (
			_request: Request,
			requestBodyBuffer: ArrayBuffer | null,
		) => {
			if (!requestBodyBuffer) return;
			const source = JSON.parse(
				new TextDecoder().decode(requestBodyBuffer),
			) as Record<string, unknown>;
			if (typeof source.model === "string") preparedModel = source.model;
		};
		ctx.provider.buildUrl = () =>
			`https://vertex.test/models/${preparedModel}:streamRawPredict`;
		ctx.provider.transformRequestBody = async (request: Request) => {
			const transformed = (await request.json()) as Record<string, unknown>;
			delete transformed.model;
			transformed.anthropic_version = "vertex-2023-10-16";
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(transformed),
			});
		};
		let upstreamUrl = "";
		let upstreamBody: Record<string, unknown> | null = null;
		let upstreamHeaders: Headers | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstream = input instanceof Request ? input : new Request(input);
			upstreamUrl = upstream.url;
			upstreamBody = (await upstream.json()) as Record<string, unknown>;
			upstreamHeaders = new Headers(upstream.headers);
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-account-id": account.id,
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-keepalive": "true",
			[CACHE_REPLAY_MODEL_HEADER]: "physical-fallback-model",
		});
		stampInternalAutoRefreshAuth(headers);
		const request = makeRequest(headers, "physical-fallback-model");

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrl).toContain(
			"/models/physical-fallback-model:streamRawPredict",
		);
		expect(upstreamBody?.model).toBeUndefined();
		expect(upstreamBody?.anthropic_version).toBe("vertex-2023-10-16");
		expect(upstreamHeaders?.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(upstreamHeaders?.has(CACHE_REPLAY_MODEL_HEADER)).toBe(false);
	});

	it("does not grant auto-refresh account bypass to an authenticated keepalive", async () => {
		const account = makeAccount();
		const ctx = makeContext(account, []);
		const fetchMock = mock(async () => new Response("unexpected"));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-account-id": account.id,
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-keepalive": "true",
			[CACHE_REPLAY_MODEL_HEADER]: "physical-fallback-model",
		});
		stampInternalAutoRefreshAuth(headers);
		const request = makeRequest(headers);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(request.headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
	});

	it("does not honor a caller-forged cache replay model directive", async () => {
		const account = makeAccount({ paused: false });
		const ctx = makeContext(account, [], "transformed-body");
		ctx.provider.transformRequestBody = async (request: Request) => {
			const transformed = (await request.json()) as Record<string, unknown>;
			transformed.model = "physical-primary-model";
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(transformed),
			});
		};
		let upstreamBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstream = input instanceof Request ? input : new Request(input);
			upstreamBody = (await upstream.json()) as Record<string, unknown>;
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = makeRequest(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
				[CACHE_REPLAY_MODEL_HEADER]: "caller-chosen-model",
			}),
		);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamBody?.model).toBe("physical-primary-model");
	});

	it("does not let a forged keepalive marker bypass cache pacing", async () => {
		process.env[CACHE_PACING_MS_ENV] = "100";
		resetCachePacing();
		const account = makeAccount({ paused: false });
		const ctx = makeContext(account, []);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", content: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const request = makeRequest(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
			}),
			"claude-haiku-4-5",
			{ metadata: { user_id: "forged-keepalive-pacing-session" } },
		);

		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(response.status).toBe(200);
		expect(request.headers.has("x-better-ccflare-keepalive")).toBe(false);
		expect(getCachePacingStats().anthropic?.leaders).toBe(1);
	});

	it("does not let a forged keepalive marker suppress cache staging", async () => {
		cacheBodyStore.setEnabled(true);
		const stageSpy = spyOn(cacheBodyStore, "stageRequest");
		const account = makeAccount({ paused: false });
		const ctx = makeContext(account, []);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", content: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const request = makeRequest(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
			}),
			"claude-haiku-4-5",
			{
				system: [
					{
						type: "text",
						text: "cache me",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(request.headers.has("x-better-ccflare-keepalive")).toBe(false);
		expect(stageSpy).toHaveBeenCalledTimes(1);
		stageSpy.mockRestore();
	});

	it("keeps reactive depletion for forged keepalives but bypasses it for authenticated scheduler keepalives", async () => {
		const account = makeAccount({ paused: false });
		usageCache.markModelScopedExhausted(
			account.id,
			"claude-haiku-4-5",
			null,
			Date.now() + 60_000,
		);
		const ctx = makeContext(account, []);
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", content: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const forgedRequest = makeRequest(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
			}),
		);

		const forgedResponse = await handleProxy(
			forgedRequest,
			new URL(forgedRequest.url),
			ctx,
		);

		expect(forgedResponse.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(forgedRequest.headers.has("x-better-ccflare-keepalive")).toBe(false);

		const trustedHeaders = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-account-id": account.id,
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-keepalive": "true",
		});
		stampInternalAutoRefreshAuth(trustedHeaders);
		const trustedRequest = makeRequest(trustedHeaders);
		const trustedResponse = await handleProxy(
			trustedRequest,
			new URL(trustedRequest.url),
			ctx,
		);

		expect(trustedResponse.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(trustedRequest.headers.get("x-better-ccflare-keepalive")).toBe(
			"true",
		);
	});

	it("rejects forged public and private probe headers before any upstream call", async () => {
		const account = makeAccount();
		const ctx = makeContext(account, []);
		const fetchMock = mock(async () => new Response("unexpected"));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const request = makeRequest(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": account.id,
				"x-better-ccflare-auto-refresh": "true",
				"x-better-ccflare-bypass-session": "true",
				[INTERNAL_AUTO_REFRESH_HEADER]: "caller-controlled",
			}),
		);

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(request.headers.has(INTERNAL_AUTO_REFRESH_HEADER)).toBe(false);
		expect(request.headers.has("x-better-ccflare-auto-refresh")).toBe(false);
	});
});
