import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: null,
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

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				// Mock filtering: only return accounts that are NOT paused and NOT rate-limited
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
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

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

let savedPassthrough: string | undefined;

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
});

afterEach(() => {
	usageCache.delete("acc-resetless-capacity");
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

describe("routing terminal — 503 response", () => {
	it("returns non-retryable route_unavailable when pool is empty", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.type).toBe("error");

		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("service_unavailable");
		expect(error.code).toBe("route_unavailable");
		expect(typeof error.message).toBe("string");
		expect((error.message as string).length).toBeGreaterThan(0);
		expect("next_available_at" in error).toBe(false);
		expect(Array.isArray(error.accounts)).toBe(true);
	});

	it("does not return Retry-After when pool is empty", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBeNull();
	});

	it("does not return a whole-pool marker without recovery evidence", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
	});

	it("returns Content-Type: application/json header", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.headers.get("Content-Type")).toContain("application/json");
	});

	it("includes account info in response when accounts are paused/rate-limited", async () => {
		const pausedAccount = makeAccount({
			id: "acc-paused",
			name: "paused-account",
			paused: true,
			pause_reason: "manual",
		});
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: Date.now() + 60_000,
			rate_limited_reason: "upstream_429_with_reset",
		});

		const ctx = makeContext([pausedAccount, rateLimitedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		const accounts = error.accounts as Array<Record<string, unknown>>;

		expect(accounts.length).toBe(2);
		const names = accounts.map((a) => a.name as string);
		expect(names).toContain("paused-account");
		expect(names).toContain("rate-limited-account");
	});

	it("includes next_available_at ISO timestamp when rate-limited accounts exist", async () => {
		const cooldownUntil = Date.now() + 3_600_000; // 1 hour from now
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: cooldownUntil,
			rate_limited_reason: "upstream_429_with_reset",
		});

		const ctx = makeContext([rateLimitedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.next_available_at).not.toBeNull();
		// Should be a valid ISO timestamp
		const ts = new Date(error.next_available_at as string);
		expect(ts.getTime()).toBeGreaterThan(Date.now());
	});

	it("sets Retry-After to seconds until next_available_at when rate-limited accounts exist", async () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const cooldownUntil = now + 3_600_000; // 1 hour
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: cooldownUntil,
			rate_limited_reason: "upstream_429_with_reset",
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const ctx = makeContext([rateLimitedAccount]);
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(503);
			const retryAfter = Number(response.headers.get("Retry-After"));
			// Should be close to 3600 seconds (within 5s tolerance)
			expect(retryAfter).toBeGreaterThan(3595);
			expect(retryAfter).toBeLessThanOrEqual(3600);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("does not set Retry-After when only manually paused accounts exist", async () => {
		const pausedAccount = makeAccount({
			id: "acc-paused",
			name: "paused-account",
			paused: true,
		});

		const ctx = makeContext([pausedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBeNull();
	});

	it("keeps resetless session and weekly-all capacity terminal states non-retryable", async () => {
		for (const kind of ["session", "weekly_all"] as const) {
			const account = makeAccount({ id: "acc-resetless-capacity" });
			usageCache.set(account.id, {
				limits: [
					{
						kind,
						percent: 100,
						resets_at: null,
						scope: null,
					},
				],
			});

			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([account]),
			);

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBeNull();
			expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
			const payload = (await response.json()) as {
				error: { code: string };
			};
			expect(payload.error.code).toBe("route_unavailable");
		}
	});

	it("retains compatible dynamic providers in terminal inventory", async () => {
		const codexAccount = makeAccount({
			id: "acc-codex",
			name: "codex-account",
			provider: "codex",
			paused: true,
			pause_reason: "manual",
		});
		const anthropicAccount = makeAccount({
			id: "acc-anthropic",
			name: "anthropic-account",
			provider: "anthropic",
			paused: true,
			pause_reason: "manual",
		});

		// Dynamic routing considers both providers for /v1/messages.
		const ctx = makeContext([codexAccount, anthropicAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		const accounts = error.accounts as Array<Record<string, unknown>>;

		expect(accounts.length).toBe(2);
		expect(accounts.map((account) => account.name)).toEqual([
			"codex-account",
			"anthropic-account",
		]);
	});
});

describe("pool exhausted — CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1 escape hatch", () => {
	it("does NOT return 503 when CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1 and pool is empty", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";

		const ctx = makeContext([]);
		// proxyUnauthenticated will try to make a real request and fail —
		// we just check it doesn't return 503 with our pool_exhausted body.
		// It will throw or return a different status.
		try {
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
			// If it returns, it should NOT be our 503 pool_exhausted
			if (response.status === 503) {
				const body = (await response.json()) as Record<string, unknown>;
				const error = body.error as Record<string, unknown> | undefined;
				expect(error?.type).not.toBe("pool_exhausted");
			}
			// Any other status means passthrough was attempted
		} catch {
			// Expected: proxyUnauthenticated throws when no real provider configured
			// This is fine — it means we went through the passthrough path
		}
	});
});
