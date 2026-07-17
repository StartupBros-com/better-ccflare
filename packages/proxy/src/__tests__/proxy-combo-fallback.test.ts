import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
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
	};
}

const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
});

describe("post-combo normal fallback", () => {
	it("runs the active combo once, then selects normal accounts without re-entering it", async () => {
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as unknown as usageCollectorModule.UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		const comboAccount = makeAccount("combo-account");
		const normalAccount = makeAccount("normal-account");
		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const getActiveComboForFamily = mock(async () => combo);
		const strategySelect = mock(() => [normalAccount]);
		const ctx = {
			strategy: { select: strategySelect },
			dbOps: {
				getAllAccounts: mock(async () => [comboAccount, normalAccount]),
				getActiveComboForFamily,
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
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
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

		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			if (upstreamUrls.length === 1) {
				return new Response(JSON.stringify({ error: "expired" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-auto-refresh": "true",
			},
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			"https://upstream.test/combo-account",
			"https://upstream.test/normal-account",
		]);
		expect(getActiveComboForFamily).toHaveBeenCalledTimes(1);
		expect(strategySelect).toHaveBeenCalledTimes(1);
	});
});
