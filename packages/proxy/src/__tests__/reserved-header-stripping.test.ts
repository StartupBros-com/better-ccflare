import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

// P1 spoofing (proxy side): x-better-ccflare-pool-status is a reserved,
// guard-trusted header. The ccflare-guard sitting in front of the proxy
// treats a confirmed value ("exhausted") as sufficient, header-time
// authorization to retry a 503 (R17). If an upstream PROVIDER response
// could carry this header through to the client untouched, any upstream
// (malicious or merely misconfigured) could spoof whole-pool exhaustion
// and force the guard into replaying a possibly non-idempotent request.
// Only the proxy's own synthesized pool-exhausted responses may set this
// header; anything that came from an upstream fetch must have it stripped
// before it reaches the client.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
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

const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
});

describe("upstream response header sanitization (P1 spoofing defense)", () => {
	it("strips a reserved x-better-ccflare-pool-status header set by an upstream provider before it reaches the client", async () => {
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as unknown as usageCollectorModule.UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		const account = makeAccount();
		const ctx = {
			strategy: { select: mock(() => [account]) },
			dbOps: {
				getAllAccounts: mock(async () => [account]),
				getActiveComboForFamily: mock(async () => null),
				getAgentPreference: mock(async () => null),
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
				buildUrl: (_path: string, _search: string, acc: Account) =>
					`https://upstream.test/${acc.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls += 1;
			// A spoofing (or merely misconfigured) upstream sets the reserved
			// guard-trusted header itself, on an otherwise-ordinary 503.
			return new Response(
				JSON.stringify({ error: { type: "overloaded_error" } }),
				{
					status: 503,
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-pool-status": "exhausted",
						"x-better-ccflare-recovery-scope": "model",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCalls).toBe(1);
		expect(response.status).toBe(503);
		expect(response.headers.has("x-better-ccflare-pool-status")).toBe(false);
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBe(false);
	});
});
