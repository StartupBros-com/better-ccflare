import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { observeCachePacing } from "../cache-pacing";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";

// Minimal seam test for the second selectAccountsForRequest call site inside
// handleProxy (the pacing-canary reselect branch): a force-routed request
// whose forced account becomes unavailable between the first (control) select
// and the second (canary reselect) select must get the same typed 503
// force_route_unavailable response as the first call site, not an uncaught
// throw. There is no existing unit coverage of either proxy.ts catch site
// (only selectAccountsForRequest itself is unit-tested in
// account-selector.test.ts), so this exercises handleProxy end-to-end through
// the real cache-pacing canary path rather than mocking it away.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "forced-account",
		name: "forced-account",
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

const CACHE_PACING_MS_ENV = "CCFLARE_CACHE_PACING_MS";
const CODEX_PACING_BYPASS_PERCENT_ENV = "CCFLARE_CODEX_PACING_BYPASS_PERCENT";
const originalCachePacingMs = process.env[CACHE_PACING_MS_ENV];
const originalCodexPacingBypassPercent =
	process.env[CODEX_PACING_BYPASS_PERCENT_ENV];

beforeEach(() => {
	// Force every pacing-eligible request with an identifiable session/model
	// pair to be a canary candidate so the second (reselect) selectAccountsForRequest
	// call at proxy.ts's pacing-canary branch is deterministically reached.
	process.env[CACHE_PACING_MS_ENV] = "5000";
	process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "100";
});

afterEach(() => {
	if (originalCachePacingMs === undefined)
		delete process.env[CACHE_PACING_MS_ENV];
	else process.env[CACHE_PACING_MS_ENV] = originalCachePacingMs;
	if (originalCodexPacingBypassPercent === undefined)
		delete process.env[CODEX_PACING_BYPASS_PERCENT_ENV];
	else
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] =
			originalCodexPacingBypassPercent;
});

describe("handleProxy: force-route fail-closed at the pacing-canary reselect call site (P2)", () => {
	it("returns the typed 503 force_route_unavailable response, not a generic throw, when the forced account becomes unavailable between the two selects", async () => {
		let getAllAccountsCalls = 0;
		const getAllAccounts = mock(async () => {
			getAllAccountsCalls++;
			// First call (the control select at ~line 368): account is available.
			if (getAllAccountsCalls === 1) return [makeAccount()];
			// Second call (the canary reselect at ~line 494): the account was
			// paused in between, simulating it becoming unavailable.
			return [makeAccount({ paused: true, pause_reason: "manual" })];
		});

		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts,
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

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "forced-account",
			},
			body: JSON.stringify({
				model: "claude-fable-4-5",
				messages: [{ role: "user", content: "hello" }],
				metadata: { user_id: "canary-session-1" },
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(getAllAccountsCalls).toBeGreaterThanOrEqual(2);
		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; account_id: string; reason: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.account_id).toBe("forced-account");
		expect(parsed.error.reason).toBe("paused");

		// The canary reselect branch (~line 490) acquires a pacing leader slot
		// for this session/model key immediately before the second select call
		// that threw. The 503 catch must release that slot (finishPacing), not
		// leave the leaders map entry dangling -- otherwise a fresh
		// observeCachePacing call for the same key would be forced to wait as a
		// follower instead of immediately becoming a new leader.
		const followUp = await observeCachePacing({
			sessionKey: "canary-session-1",
			model: "claude-fable-4-5",
		});
		expect(followUp?.role).toBe("leader");
	});
});

describe("handleProxy: force-route fail-closed at the control-cohort first select call site (P2)", () => {
	beforeEach(() => {
		// Force the control cohort (not the canary bypass candidate) so the
		// FIRST selectAccountsForRequest call (~line 368) is the one that
		// throws, exercising the original (non-canary) catch site rather than
		// the pacing-canary reselect site covered above.
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "0";
	});

	it("returns the typed 503 force_route_unavailable response and releases the pacing leader slot when the forced account does not exist", async () => {
		let getAllAccountsCalls = 0;
		const getAllAccounts = mock(async () => {
			getAllAccountsCalls++;
			return [];
		});

		const ctx = {
			strategy: { select: mock(() => []) },
			dbOps: {
				getAllAccounts,
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

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "missing-account",
			},
			body: JSON.stringify({
				model: "claude-fable-4-5",
				messages: [{ role: "user", content: "hello" }],
				metadata: { user_id: "control-session-1" },
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(getAllAccountsCalls).toBe(1);
		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const parsed = (await response.json()) as {
			error: { type: string; account_id: string; reason: string };
		};
		expect(parsed.error.type).toBe("force_route_unavailable");
		expect(parsed.error.account_id).toBe("missing-account");
		expect(parsed.error.reason).toBe("not_found");

		// The control cohort acquires its pacing leader slot (~line 350) before
		// the first select call that threw. The 503 catch must release that
		// slot too, matching the canary reselect site above.
		const followUp = await observeCachePacing({
			sessionKey: "control-session-1",
			model: "claude-fable-4-5",
		});
		expect(followUp?.role).toBe("leader");
	});
});
