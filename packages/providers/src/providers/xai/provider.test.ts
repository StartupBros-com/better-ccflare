import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { XAI_CACHE_NATIVE_ENV, XAI_CONV_ID_HEADER } from "./cache-native";
import {
	XAI_DEFAULT_ENDPOINT,
	XAI_MODEL_MAPPINGS,
	XAI_TOKEN_ENDPOINT,
	XaiProvider,
} from "./provider";

const account = (overrides: Partial<Account> = {}): Account => ({
	id: "xai-1",
	name: "xai-test",
	provider: "xai",
	api_key: null,
	refresh_token: "refresh-token",
	access_token: "access-token",
	expires_at: Date.now() + 60_000,
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
	priority: 50,
	auto_fallback_enabled: true,
	auto_refresh_enabled: true,
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
});

describe("XaiProvider", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds xAI chat completions URLs from Anthropic messages paths", () => {
		const provider = new XaiProvider();

		expect(provider.buildUrl("/v1/messages", "?foo=bar", account())).toBe(
			`${XAI_DEFAULT_ENDPOINT}/chat/completions?foo=bar`,
		);
	});

	it("uses default Grok model mappings when the account has none", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 32,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account());
		const body = await transformed.json();

		expect(body.model).toBe(XAI_MODEL_MAPPINGS.sonnet);
	});

	it("preserves custom model mappings", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-haiku",
				max_tokens: 32,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(
			request,
			account({ model_mappings: JSON.stringify({ haiku: "grok-custom" }) }),
		);
		const body = await transformed.json();

		expect(body.model).toBe("grok-custom");
	});

	it("declares only the defaults the transform will inject", () => {
		const provider = new XaiProvider();
		expect(
			provider.getLogicalModelCapability("claude-fable-5", account()),
		).toMatchObject({ status: "supported", provenance: "provider_default" });
		expect(
			provider.getLogicalModelCapability(
				"claude-fable-5",
				account({ model_mappings: JSON.stringify({ opus: "custom-opus" }) }),
			),
		).toMatchObject({ status: "unsupported", provenance: "provider_default" });
	});

	it("advertises Grok Build credits usage polling", () => {
		const provider = new XaiProvider();

		expect(provider.supportsUsageTracking()).toBe(true);
	});

	it("requests stream usage chunks for streaming xAI requests", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 32,
				stream: true,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account());
		const body = await transformed.json();

		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	it("attaches x-grok-conv-id only when cache-native is enabled on official xAI", async () => {
		const original = process.env[XAI_CACHE_NATIVE_ENV];
		const provider = new XaiProvider();
		const sessionBody = {
			model: "claude-3-5-sonnet-20241022",
			max_tokens: 32,
			system: "stable system",
			messages: [{ role: "user", content: "hello" }],
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
		};
		const makeReq = () =>
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(sessionBody),
			});

		delete process.env[XAI_CACHE_NATIVE_ENV];
		const off = await provider.transformRequestBody(makeReq(), account());
		expect(off.headers.get(XAI_CONV_ID_HEADER)).toBeNull();

		process.env[XAI_CACHE_NATIVE_ENV] = "1";
		const on = await provider.transformRequestBody(makeReq(), account());
		const header = on.headers.get(XAI_CONV_ID_HEADER);
		expect(header).toMatch(/^ccflare-xai-[0-9a-f]{48}$/);

		const custom = await provider.transformRequestBody(
			makeReq(),
			account({ custom_endpoint: "https://proxy.example.com/v1" }),
		);
		expect(custom.headers.get(XAI_CONV_ID_HEADER)).toBeNull();

		if (original === undefined) delete process.env[XAI_CACHE_NATIVE_ENV];
		else process.env[XAI_CACHE_NATIVE_ENV] = original;
	});

	it("refreshes xAI OAuth tokens with the Grok client id", async () => {
		const provider = new XaiProvider();
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(_input)).toBe(XAI_TOKEN_ENDPOINT);
				expect(init?.method).toBe("POST");
				const body = init?.body?.toString() ?? "";
				expect(body).toContain("grant_type=refresh_token");
				expect(body).toContain("refresh_token=refresh-token");
				return new Response(
					JSON.stringify({
						access_token: "new-access-token",
						refresh_token: "new-refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await provider.refreshToken(account(), "unused");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.accessToken).toBe("new-access-token");
		expect(result.refreshToken).toBe("new-refresh-token");
		expect(result.expiresAt).toBeGreaterThan(Date.now());
	});

	it("preserves the machine-readable OAuth error code on a failed refresh", async () => {
		const provider = new XaiProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "Refresh token is invalid or has been revoked.",
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(account(), "unused");
		} catch (error) {
			thrown = error as Error;
		}

		// The code must survive alongside the description so token management can
		// classify a definitively dead xAI refresh token.
		expect(thrown?.message).toContain("invalid_grant");
	});

	it("extracts cached_tokens from non-stream OpenAI-compatible usage", async () => {
		const provider = new XaiProvider();
		const response = new Response(
			JSON.stringify({
				model: "grok-4.3",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 10,
					total_tokens: 110,
					prompt_tokens_details: { cached_tokens: 40 },
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
		const usage = await provider.extractUsageInfo(response);
		expect(usage?.cacheReadInputTokens).toBe(40);
		expect(usage?.inputTokens).toBe(60);
		expect(usage?.promptTokens).toBe(100);
		expect(usage?.totalTokens).toBe(110);
	});

	describe("parseRateLimit - native xAI capacity classification (R5-R7)", () => {
		it("classifies 402 as rate-limited with reason xai_capacity_402, no resetTime", () => {
			const provider = new XaiProvider();
			const response = new Response(
				JSON.stringify({ error: "insufficient credits" }),
				{ status: 402, headers: { "content-type": "application/json" } },
			);

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(true);
			expect(info.reason).toBe("xai_capacity_402");
			expect(info.resetTime).toBeUndefined();
		});

		it("classifies 429 as rate-limited using standard Retry-After parsing (seconds)", () => {
			const provider = new XaiProvider();
			const response = new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": "30",
				},
			});
			const before = Date.now();

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(true);
			expect(info.reason).toBeUndefined();
			expect(info.resetTime).toBeGreaterThanOrEqual(before + 30_000 - 1000);
			expect(info.resetTime).toBeLessThanOrEqual(Date.now() + 30_000 + 1000);
		});

		it("classifies 429 as rate-limited with no resetTime when Retry-After is absent", () => {
			const provider = new XaiProvider();
			const response = new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(true);
			expect(info.resetTime).toBeUndefined();
		});

		it("parses an HTTP-date Retry-After header on 429", () => {
			const provider = new XaiProvider();
			const future = new Date(Date.now() + 60_000).toUTCString();
			const response = new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": future,
				},
			});

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(true);
			expect(info.resetTime).toBe(new Date(future).getTime());
		});

		it("does not classify 400 as rate-limited", () => {
			const provider = new XaiProvider();
			const response = new Response(JSON.stringify({ error: "bad request" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(false);
		});

		it("does not classify 500 as rate-limited", () => {
			const provider = new XaiProvider();
			const response = new Response(
				JSON.stringify({ error: "internal error" }),
				{ status: 500, headers: { "content-type": "application/json" } },
			);

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(false);
		});

		it("does not classify 200 as rate-limited", () => {
			const provider = new XaiProvider();
			const response = new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

			const info = provider.parseRateLimit(response);

			expect(info.isRateLimited).toBe(false);
		});
	});
});

describe("OpenAICompatibleProvider.parseRateLimit - unchanged for generic providers (R6)", () => {
	it("still reports isRateLimited:false on a generic OpenAI-compatible 402", async () => {
		const { OpenAICompatibleProvider } = await import("../openai/provider");
		const provider = new OpenAICompatibleProvider();
		const response = new Response(JSON.stringify({ error: "payment" }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBe(false);
		expect(info.statusHeader).toBe("allowed");
	});

	it("still reports isRateLimited:false on a generic OpenAI-compatible 429", async () => {
		const { OpenAICompatibleProvider } = await import("../openai/provider");
		const provider = new OpenAICompatibleProvider();
		const response = new Response(JSON.stringify({ error: "rate limited" }), {
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "30" },
		});

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBe(false);
		expect(info.statusHeader).toBe("allowed");
	});
});
