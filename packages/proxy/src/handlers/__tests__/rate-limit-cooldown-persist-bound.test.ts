import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { applyRateLimitCooldownAwaitingPersist } from "../rate-limit-cooldown";
import { createRoutingTerminalResponse } from "../routing-terminal";

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
		rate_limited_reason: null,
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

function expectRetryablePoolExhaustion(account: Account): void {
	const terminal = createRoutingTerminalResponse({
		source: "attempts",
		accounts: [account],
		capacityContext: null,
		rateLimitOutcomes: [],
		upstreamAttempts: 1,
		now: NOW,
	});

	expect(terminal.kind).toBe("pool_exhausted");
	expect(terminal.response.headers.get("retry-after")).not.toBeNull();
	expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
		"exhausted",
	);
	expect(terminal.response.headers.get("x-better-ccflare-recovery-scope")).toBe(
		"pool",
	);
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
				{
					resetTime: NOW + 120_000,
					reason: "upstream_429_with_reset",
				},
				ctx,
			),
		).resolves.toBeUndefined();

		// The in-memory nextCount (3 + 1 = 4) computed by
		// applyRateLimitCooldownInMemory must stand -- it must NOT be overwritten
		// by a DB-authoritative persistedCount that never arrived.
		expect(account.consecutive_rate_limits).toBe(4);
		expect(account.rate_limited_until).toBeGreaterThan(NOW);
		expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		expectRetryablePoolExhaustion(account);
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
			{
				resetTime: NOW + 120_000,
				reason: "upstream_429_with_reset",
			},
			ctx,
		);
		const elapsed = performance.now() - start;

		// Bounded by the (shortened, via env override) timeout, not by the
		// never-resolving stub.
		expect(elapsed).toBeLessThan(1000);
		expect(account.consecutive_rate_limits).toBe(4);
		expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		expectRetryablePoolExhaustion(account);
	});
});

// Covers the pro-gate follow-up: under a stuck SQLite lock, each timed-out
// awaited persist leaves its withBusyRetry loop running in the background.
// Without coalescing, repeated requests for the same account would spawn
// additional parallel write/retry loops piling up against the same lock.
// These tests use account ids distinct from "acc-1" (the default id used by
// the never-resolving stub above) so a permanently in-flight write left
// behind by that test cannot leak into these.
describe("applyRateLimitCooldownAwaitingPersist: per-account single-flight coalescing", () => {
	it("coalesces two concurrent calls for the same account into a single markAccountRateLimited invocation", async () => {
		Date.now = () => NOW;
		const account = makeAccount({
			id: "acc-coalesce-1",
			consecutive_rate_limits: 3,
		});
		let callCount = 0;
		let resolveWrite: ((value: number) => void) | undefined;
		const ctx = {
			dbOps: {
				markAccountRateLimited: () => {
					callCount++;
					return new Promise<number>((resolve) => {
						resolveWrite = resolve;
					});
				},
			},
		} as unknown as ProxyContext;

		const p1 = applyRateLimitCooldownAwaitingPersist(
			account,
			{ reason: "xai_capacity_402" },
			ctx,
		);
		const p2 = applyRateLimitCooldownAwaitingPersist(
			account,
			{ reason: "xai_capacity_402" },
			ctx,
		);

		// Give both calls a chance to reach the write before either resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(callCount).toBe(1);

		resolveWrite?.(7);
		await Promise.all([p1, p2]);
		expect(callCount).toBe(1);
	});

	it("invokes markAccountRateLimited again for the same account once the prior write has settled", async () => {
		Date.now = () => NOW;
		const account = makeAccount({
			id: "acc-coalesce-2",
			consecutive_rate_limits: 3,
		});
		let callCount = 0;
		const ctx = {
			dbOps: {
				markAccountRateLimited: async () => {
					callCount++;
					return 10;
				},
			},
		} as unknown as ProxyContext;

		await applyRateLimitCooldownAwaitingPersist(
			account,
			{ reason: "xai_capacity_402" },
			ctx,
		);
		expect(callCount).toBe(1);

		await applyRateLimitCooldownAwaitingPersist(
			account,
			{ reason: "xai_capacity_402" },
			ctx,
		);
		expect(callCount).toBe(2);
	});

	it("does not coalesce concurrent calls for different accounts", async () => {
		Date.now = () => NOW;
		const accountA = makeAccount({
			id: "acc-coalesce-3a",
			consecutive_rate_limits: 3,
		});
		const accountB = makeAccount({
			id: "acc-coalesce-3b",
			consecutive_rate_limits: 3,
		});
		let callCount = 0;
		const resolvers: Array<(value: number) => void> = [];
		const ctx = {
			dbOps: {
				markAccountRateLimited: () => {
					callCount++;
					return new Promise<number>((resolve) => {
						resolvers.push(resolve);
					});
				},
			},
		} as unknown as ProxyContext;

		const p1 = applyRateLimitCooldownAwaitingPersist(
			accountA,
			{ reason: "xai_capacity_402" },
			ctx,
		);
		const p2 = applyRateLimitCooldownAwaitingPersist(
			accountB,
			{ reason: "xai_capacity_402" },
			ctx,
		);

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(callCount).toBe(2);

		for (const resolve of resolvers) resolve(1);
		await Promise.all([p1, p2]);
	});
});
