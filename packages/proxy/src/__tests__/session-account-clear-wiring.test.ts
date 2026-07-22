import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import {
	clearSession,
	getServedAccount,
	recordServedAccount,
} from "../session-account-observer";
import * as usageCollectorModule from "../usage-collector";

/**
 * KTD-5 wiring: every handleProxy exit that finishes with NO serving account
 * must clear the session→account association, so the status-line badge degrades
 * to unknown instead of showing the last healthy account. These drive
 * handleProxy into representative no-account-served exits with the
 * X-Claude-Code-Session-Id header present and assert a previously recorded
 * entry is gone afterward (verifies the wiring, not just the observer module).
 */

// A UNIQUE session id per test: clear() now leaves a tombstone carrying the
// clear's version, so a shared id would let one test's afterEach tombstone
// (large version) reject the next test's version-1 seed. Unique ids isolate.
let sessionCounter = 0;
let SESSION_ID = "clear-wiring-session-0";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "codex-primary",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
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

function makeContext(
	accounts: Account[],
	overrides: {
		throttling?: boolean;
		providerName?: string;
	} = {},
): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
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
			getUsageThrottlingFiveHourEnabled: () => overrides.throttling ?? false,
			getUsageThrottlingWeeklyEnabled: () => overrides.throttling ?? false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: overrides.providerName ?? "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeRequest(extraHeaders: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Claude-Code-Session-Id": SESSION_ID,
			...extraHeaders,
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

let savedPassthrough: string | undefined;
let restoreUsageCollector = (): void => {};

beforeEach(() => {
	const collector = {
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	};
	const requiredCollectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector as never);
	const optionalCollectorSpy = spyOn(
		usageCollectorModule,
		"tryGetUsageCollector",
	).mockReturnValue(collector as never);
	restoreUsageCollector = () => {
		requiredCollectorSpy.mockRestore();
		optionalCollectorSpy.mockRestore();
	};
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	SESSION_ID = `clear-wiring-session-${++sessionCounter}`;
	// Seed a stale association (from an OLDER request, version 1) so each exit's
	// clear — stamped with the current request's later timestamp — supersedes it.
	recordServedAccount(SESSION_ID, "stale-account", 1);
});

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	clearSession(SESSION_ID);
	usageCache.delete("acc-throttled");
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

describe("KTD-5: clearSession on no-account-served exits", () => {
	it("clears on the no-accounts 503 pool-exhausted exit", async () => {
		expect(getServedAccount(SESSION_ID)).toBe("stale-account");

		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([]),
		);

		expect(response.status).toBe(503);
		expect(getServedAccount(SESSION_ID)).toBeUndefined();
	});

	it("clears on the usage-throttled early return", async () => {
		const account = makeAccount({
			id: "acc-throttled",
			access_token: "access-token",
			expires_at: Date.now() + 60_000,
		});
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			five_hour: { utilization: 80, resets_at: resetAt },
			seven_day: { utilization: 10, resets_at: null },
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			expect(getServedAccount(SESSION_ID)).toBe("stale-account");

			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([account], { throttling: true }),
			);

			expect(response.status).toBe(529);
			expect(getServedAccount(SESSION_ID)).toBeUndefined();
		} finally {
			Date.now = realDateNow;
		}
	});

	it("clears on the CCFLARE_PASSTHROUGH_ON_EMPTY_POOL passthrough (even when it throws)", async () => {
		// With an empty pool and the passthrough flag on, no better-ccflare account
		// serves the request. The clear runs BEFORE proxyUnauthenticated, so even
		// when the passthrough throws (no real upstream here) the stale mapping is
		// still cleared — the gap a thrown proxyUnauthenticated would otherwise
		// leave by bypassing forwardToClient's null-account branch (KTD-5).
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		expect(getServedAccount(SESSION_ID)).toBe("stale-account");

		try {
			await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([]),
			);
		} catch {
			// proxyUnauthenticated throws without a real upstream — expected.
		}

		expect(getServedAccount(SESSION_ID)).toBeUndefined();
	});

	it("does NOT clear on a failed cache-keepalive replay carrying the session header", async () => {
		// A keepalive replay carries the original client's session id; when it fails
		// (empty pool here), it reaches a clear exit — but the synthetic-traffic
		// guard must prevent it from wiping the active session's real mapping.
		recordServedAccount(SESSION_ID, "healthy-account", 100);
		expect(getServedAccount(SESSION_ID)).toBe("healthy-account");

		await handleProxy(
			makeRequest({ "x-better-ccflare-keepalive": "true" }),
			new URL("https://proxy.local/v1/messages"),
			makeContext([]),
		);

		// Still mapped — the keepalive failure did not clear it.
		expect(getServedAccount(SESSION_ID)).toBe("healthy-account");
	});

	it("clears on the all-candidates-failed route_unavailable response", async () => {
		// Force-route to an account whose provider is unregistered, so
		// proxyWithAccount falls back to the minimal stub ctx.provider and throws
		// inside prepareHeaders (no network) — every candidate fails, driving the
		// post-loop routing terminal. refresh_token is null so the reauth branch is
		// skipped and the generic route_unavailable response is returned.
		const account = makeAccount({
			id: "acc-force",
			provider: "test-unregistered-provider",
			// Falsy refresh_token so the reauth branch is skipped and the generic
			// routing terminal handles the failure instead.
			refresh_token: "",
			api_key: null,
			access_token: "access-token",
			expires_at: Date.now() + 60 * 60 * 1000,
		});
		const ctx = makeContext([account], {
			providerName: "test-unregistered-provider",
		});

		expect(getServedAccount(SESSION_ID)).toBe("stale-account");

		const response = await handleProxy(
			makeRequest({ "x-better-ccflare-account-id": account.id }),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.type).toBe("error");
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("service_unavailable");
		expect(error.code).toBe("route_unavailable");
		expect(getServedAccount(SESSION_ID)).toBeUndefined();
	});
});
