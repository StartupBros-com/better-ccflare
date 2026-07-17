import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
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

function makeRequest(headers: Headers): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 8,
		}),
	});
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
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
