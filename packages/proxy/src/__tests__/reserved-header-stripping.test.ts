import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers";
import type { UsageCollector } from "../usage-collector";

const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");

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
		refresh_token: "",
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
		requires_reauth: false,
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
		} as unknown as UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		const account = makeAccount();
		const anthropicDegradedMode = new AnthropicDegradedModeCoordinator({
			config: {
				mode: "off",
				largeRequestTokenThreshold: 100_000,
				largeRequestByteThreshold: 256 * 1024,
				evidenceWindowMs: 30_000,
				quorum: 2,
				retryMinMs: 5_000,
				retryFallbackMs: 10_000,
				retryMaxMs: 60_000,
				recoveryWindowMs: 30_000,
				probeLeaseMs: 10 * 60_000,
				maxCohorts: 1_024,
			},
		});
		const ctx = {
			strategy: { select: mock(() => [account]) },
			anthropicDegradedMode,
			degradedOwnerOverlay: new DegradedOwnerOverlay({
				evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
			}),
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
		let providerRequestHeaders: Headers | null = null;
		globalThis.fetch = mock(async (input: Request | URL | string, init) => {
			fetchCalls += 1;
			providerRequestHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
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
						"x-better-ccflare-guard-request-id": "must-not-reach-client",
						"x-better-ccflare-guard-correlation-secret": "must-never-be-http",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "test-account",
				"x-better-ccflare-future-routing-signal": "must-not-reach-provider",
				"x-better-ccflare-guard-request-id":
					"v1.76110a75-9e91-4ab9-89a7-3e5d25a318fc.1.spoofed",
				"x-better-ccflare-guard-correlation-secret": "client-spoof",
				"x-public-client-header": "preserved",
			},
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
		expect(response.headers.has("x-better-ccflare-guard-request-id")).toBe(
			false,
		);
		expect(
			response.headers.has("x-better-ccflare-guard-correlation-secret"),
		).toBe(false);
		expect(
			providerRequestHeaders?.has("x-better-ccflare-guard-request-id"),
		).toBe(false);
		expect(
			providerRequestHeaders?.has("x-better-ccflare-guard-correlation-secret"),
		).toBe(false);
		expect(providerRequestHeaders?.has("x-better-ccflare-account-id")).toBe(
			false,
		);
		expect(
			providerRequestHeaders?.has("x-better-ccflare-future-routing-signal"),
		).toBe(false);
		expect(providerRequestHeaders?.get("x-public-client-header")).toBe(
			"preserved",
		);
	});
});
