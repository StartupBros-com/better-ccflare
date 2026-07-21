import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy, isReactivelyModelDepleted } from "../proxy";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "codex-primary",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		peak_hours_pause_enabled: false,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeContext(account: Account): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => true,
			getUsageThrottlingWeeklyEnabled: () => true,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

afterEach(() => {
	usageCache.delete("acc-1");
});

describe("handleProxy usage throttling", () => {
	it("returns 529 with Retry-After when all selected accounts are throttled", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			five_hour: { utilization: 80, resets_at: resetAt },
			seven_day: { utilization: 10, resets_at: null },
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("keeps reactive evidence scoped to account, exact model, beta, and real traffic", () => {
		const now = Date.now();
		usageCache.markModelScopedExhausted(
			"acc-1",
			"claude-fable-5",
			"context-1m,beta-a",
			now + 60_000,
		);
		const base = {
			model: "claude-fable-5",
			betaSignature: "beta-a,context-1m",
			syntheticProbe: false,
			now,
		};
		expect(isReactivelyModelDepleted({ ...base, accountId: "acc-1" })).toBe(
			true,
		);
		expect(isReactivelyModelDepleted({ ...base, accountId: "acc-2" })).toBe(
			false,
		);
		expect(
			isReactivelyModelDepleted({
				...base,
				accountId: "acc-1",
				model: "claude-opus-4-8",
			}),
		).toBe(false);
		expect(
			isReactivelyModelDepleted({
				...base,
				accountId: "acc-1",
				betaSignature: "other-beta",
			}),
		).toBe(false);
		expect(
			isReactivelyModelDepleted({
				...base,
				accountId: "acc-1",
				syntheticProbe: true,
			}),
		).toBe(false);
	});

	it("applies inferred family evidence to Fable siblings but never Opus or synthetic probes", () => {
		const now = Date.now();
		usageCache.markFamilyScopedExhausted(
			"acc-1",
			"claude-fable-5",
			now + 60_000,
		);
		const base = {
			accountId: "acc-1",
			betaSignature: null,
			syntheticProbe: false,
			now,
		};
		expect(
			isReactivelyModelDepleted({
				...base,
				model: "claude-fable-4-5-20260701",
			}),
		).toBe(true);
		expect(
			isReactivelyModelDepleted({
				...base,
				model: "claude-opus-4-8",
			}),
		).toBe(false);
		expect(
			isReactivelyModelDepleted({
				...base,
				model: "claude-fable-4-5-20260701",
				syntheticProbe: true,
			}),
		).toBe(false);
	});

	it("returns model 503 when family evidence appears after selection", async () => {
		const account = makeAccount({
			provider: "anthropic",
			name: "max-secondary",
		});
		const ctx = makeContext(account);
		ctx.config.getUsageThrottlingFiveHourEnabled = () => false;
		ctx.config.getUsageThrottlingWeeklyEnabled = () => false;
		ctx.strategy.select = ((accounts: Account[]) => {
			usageCache.markFamilyScopedExhausted(
				account.id,
				"claude-fable-5",
				Date.now() + 60_000,
			);
			return accounts;
		}) as never;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-fable-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect((await response.json()).error.code).toBe("model_pool_exhausted");
	});

	it("proactively skips a reactively depleted same-model route", async () => {
		const account = makeAccount({
			provider: "anthropic",
			name: "max-secondary",
		});
		usageCache.markModelScopedExhausted(
			account.id,
			"claude-fable-5",
			null,
			Date.now() + 60_000,
		);
		const realFetch = globalThis.fetch;
		const fetchMock = mock(async () => {
			throw new Error("depleted route must be skipped before fetch");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// The integration harness does not initialize the request-history
					// collector; this header suppresses only terminal history logging.
					"x-better-ccflare-auto-refresh": "true",
				},
				body: JSON.stringify({
					model: "claude-fable-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});
			const ctx = makeContext(account);
			// Direct failure evidence applies independently of optional predictive
			// usage-throttling settings.
			ctx.config.getUsageThrottlingFiveHourEnabled = () => false;
			ctx.config.getUsageThrottlingWeeklyEnabled = () => false;
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("60");
			expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
				"exhausted",
			);
			expect((await response.json()).error.code).toBe("model_pool_exhausted");
			expect(fetchMock).toHaveBeenCalledTimes(0);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
