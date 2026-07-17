import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { applyRateLimitCooldownAwaitingPersist } from "../rate-limit-cooldown";

// Covers the P0 review fix: applyRateLimitCooldownAwaitingPersist must never let
// a slow or failing ctx.dbOps.markAccountRateLimited call stall or crash the
// request path. On SQLite, withBusyRetry can legitimately stall a write for up
// to 10 minutes (see async-writer.ts's runJobWithWatchdog doc comment for the
// same accepted tradeoff) -- the awaited persist here must be bounded, and a
// rejection must not propagate as an unhandled error. Either degraded path
// (reject or timeout) must still leave the in-memory cooldown computed by
// applyRateLimitCooldownInMemory standing, rather than being clobbered by a
// DB-authoritative value that never arrived.

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const realDateNow = Date.now;
const TIMEOUT_ENV = "CCFLARE_RATE_LIMIT_PERSIST_AWAIT_TIMEOUT_MS";
const originalTimeoutEnv = process.env[TIMEOUT_ENV];

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "xai-account",
		provider: "xai",
		api_key: "key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 3,
		...overrides,
	} as Account;
}

afterEach(() => {
	Date.now = realDateNow;
	if (originalTimeoutEnv === undefined) delete process.env[TIMEOUT_ENV];
	else process.env[TIMEOUT_ENV] = originalTimeoutEnv;
});

describe("applyRateLimitCooldownAwaitingPersist: bounded persist (P0)", () => {
	it("proceeds when markAccountRateLimited rejects: in-memory cooldown stands, no unhandled rejection", async () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 3 });
		const ctx = {
			dbOps: {
				markAccountRateLimited: async () => {
					throw new Error("db unavailable");
				},
			},
		} as unknown as ProxyContext;

		await expect(
			applyRateLimitCooldownAwaitingPersist(
				account,
				{ reason: "xai_capacity_402" },
				ctx,
			),
		).resolves.toBeUndefined();

		// The in-memory nextCount (3 + 1 = 4) computed by
		// applyRateLimitCooldownInMemory must stand -- it must NOT be overwritten
		// by a DB-authoritative persistedCount that never arrived.
		expect(account.consecutive_rate_limits).toBe(4);
		expect(account.rate_limited_until).toBeGreaterThan(NOW);
	});

	it("resolves within the timeout bound when markAccountRateLimited hangs forever", async () => {
		process.env[TIMEOUT_ENV] = "50";
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 3 });
		const ctx = {
			dbOps: {
				// Never-resolving stub: simulates a stalled SQLite write (e.g. blocked
				// behind an exclusive VACUUM lock via withBusyRetry).
				markAccountRateLimited: () => new Promise<number>(() => {}),
			},
		} as unknown as ProxyContext;

		const start = performance.now();
		await applyRateLimitCooldownAwaitingPersist(
			account,
			{ reason: "xai_capacity_402" },
			ctx,
		);
		const elapsed = performance.now() - start;

		// Bounded by the (shortened, via env override) timeout, not by the
		// never-resolving stub.
		expect(elapsed).toBeLessThan(1000);
		expect(account.consecutive_rate_limits).toBe(4);
	});
});
