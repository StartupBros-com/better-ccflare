import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import {
	handleRateLimitResponse,
	processProxyResponse,
} from "../response-processor";

// Minimal Account fixture used by every test in this file. Only the fields
// the response-processor actually reads matter — the rest exist to satisfy
// the type checker.
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

// Spy-style ProxyContext. We don't try to construct a full DatabaseOperations
// or Provider — we hand in just enough method surface for processProxyResponse
// to do its work and we record what it calls.
function makeCtx(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{ accountId: string; resetTime: number }>,
		enqueueCount: 0,
	};

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: (
				accountId: string,
				resetTime: number,
				_reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime });
				return Promise.resolve(1);
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				// Run the job immediately so any DB-side mutations are observable
				// from the test. The real AsyncDbWriter is interval-driven; for
				// the assertions we care about, sync execution is equivalent and
				// avoids needing to flush a queue.
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

// Extended spy context that captures the reason argument passed to markAccountRateLimited.
function makeCtxWithReason(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
		}>,
		enqueueCount: 0,
	};

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime, reason });
				return Promise.resolve(1);
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("processProxyResponse — rate limit audit trail (issue #178)", () => {
	it("passes reason='upstream_429_with_reset' when resetTime is present", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		// cooldownUntil = Math.min(resetTime, now+backoff) — backoff caps below resetTime for count=1
		expect(calls.markRateLimited[0]?.resetTime).toBeLessThanOrEqual(resetTime);
		expect(calls.markRateLimited[0]?.resetTime).toBeGreaterThan(Date.now());
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("passes reason='upstream_429_no_reset_probe_cooldown' when no resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_429_no_reset_probe_cooldown",
		);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS). Allow ±1s drift.
		const THIRTY_SECONDS = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + THIRTY_SECONDS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + THIRTY_SECONDS + 1000);
	});

	it("passes reason='upstream_429_with_reset' on streaming 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 60 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: true,
			rateLimited: true,
			resetTime,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});
});

describe("processProxyResponse — streaming rate-limit failover (issue #114)", () => {
	it("returns true and marks the account on a streaming 429", async () => {
		// Pre-stream 429 — this is the case where Anthropic responds with a
		// 429 but the response happens to carry text/event-stream content-type
		// (e.g. an upstream that preserves the requested content-type on
		// errors). The historic `!isStream` guard would silently bypass both
		// marking and failover here.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true); // signals failover loop
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
	});

	it("returns true and marks the account on a non-streaming 429 (regression)", async () => {
		// Regression guard for the historic happy path: a JSON 429 must still
		// trigger marking + failover.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
	});

	it("returns false on a successful streaming response", async () => {
		// Negative case: a healthy SSE response must NOT be marked as
		// rate-limited and must NOT signal failover. This guards against an
		// over-correction where dropping the !isStream guard accidentally
		// flags every stream.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({ isStream: true, rateLimited: false });
		const response = new Response("event: message_start\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(false);
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("falls back to exponential backoff cooldown when a streaming 429 has no resetTime", async () => {
		// Some providers return 429s without rate-limit headers. The code uses
		// exponential backoff starting at 30s (RATE_LIMIT_BACKOFF_BASE_MS for count=1).
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		// Exponential backoff for count=1 is 30s. Allow ±1s for test runtime drift.
		const THIRTY_SECONDS = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + THIRTY_SECONDS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + THIRTY_SECONDS + 1000);
	});
});

describe("handleRateLimitResponse — in-memory cooldown mutation", () => {
	it("sets account.rate_limited_until to resetTime when resetTime is present", () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const rateLimitInfo = {
			isRateLimited: true,
			resetTime,
			statusHeader: "rate_limited",
			remaining: undefined,
		};

		handleRateLimitResponse(account, rateLimitInfo, ctx);

		// In-memory mutation: cooldownUntil = Math.min(resetTime, now+backoff)
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until).toBeLessThanOrEqual(resetTime);
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(Date.now());
	});

	it("does not mutate account.rate_limited_until when resetTime is undefined", () => {
		const account = makeAccount();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const rateLimitInfo = {
			isRateLimited: true,
			resetTime: undefined,
			statusHeader: "rate_limited",
			remaining: undefined,
		};

		handleRateLimitResponse(account, rateLimitInfo, ctx);

		// handleRateLimitResponse only mutates when resetTime is present
		expect(account.rate_limited_until).toBeNull();
	});
});

describe("processProxyResponse — 529 overload reason", () => {
	it("passes reason='upstream_529_overloaded_with_reset' on 529 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_with_reset",
		);
	});

	it("passes reason='upstream_529_overloaded_no_reset' on 529 without resetTime", async () => {
		const account = makeAccount();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
	});

	it("skips cooldown but logs status code for keepalive 529 requests", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{
				status: 529,
				headers: { "content-type": "application/json" },
			},
		);
		const requestMeta = {
			headers: new Headers({ "x-better-ccflare-keepalive": "true" }),
		};

		await processProxyResponse(response, account, ctx, undefined, requestMeta);

		// Keepalive requests skip cooldown marking
		expect(calls.markRateLimited).toHaveLength(0);
	});
});

describe("processProxyResponse — in-memory cooldown mutation", () => {
	it("sets account.rate_limited_until on 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// cooldownUntil = Math.min(resetTime, now+backoff) — backoff caps below resetTime for count=1
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until).toBeLessThanOrEqual(resetTime);
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(Date.now());
	});

	it("sets account.rate_limited_until to ~30s on 429 without resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(account.rate_limited_until).not.toBeNull();
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS). Allow ±1s drift.
		const THIRTY_SECONDS = 30 * 1000;
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + THIRTY_SECONDS - 1000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + THIRTY_SECONDS + 1000,
		);
	});

	it("clears account.rate_limited_until on successful response", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000, // previously rate-limited
		});
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// Successful response clears cooldown
		expect(account.rate_limited_until).toBeNull();
	});

	it("does not clear account.rate_limited_until when already null on success", async () => {
		const account = makeAccount(); // rate_limited_until is null by default
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// No mutation needed — already null
		expect(account.rate_limited_until).toBeNull();
	});
});

describe("handleRateLimitResponse - provider-supplied reason override", () => {
	it("prefers rateLimitInfo.reason over the status-derived default", () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const rateLimitInfo = {
			isRateLimited: true,
			resetTime,
			statusHeader: "rate_limited",
			remaining: undefined,
			reason: "xai_capacity_402" as const,
		};

		handleRateLimitResponse(account, rateLimitInfo, ctx, 429);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
	});

	it("falls back to the status-derived default when no reason is supplied", () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const rateLimitInfo = {
			isRateLimited: true,
			resetTime,
			statusHeader: "rate_limited",
			remaining: undefined,
		};

		handleRateLimitResponse(account, rateLimitInfo, ctx, 429);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});
});

// Native xAI account fixture - provider must be "xai" for the response
// processor's xAI-specific direct-evidence cooldown path (R5-R10) to engage.
function makeXaiAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({ provider: "xai", ...overrides });
}

/**
 * Spy ProxyContext builder for the native xAI direct-evidence cooldown path.
 * Unlike makeCtx/makeCtxWithReason, this allows the caller to control the
 * exact rateLimitInfo (including `reason`) returned by parseRateLimit, and to
 * delay dbOps.markAccountRateLimited's resolution so tests can assert the
 * awaited-persist behavior required by R9.
 */
function makeXaiCtx(opts: {
	rateLimitInfo: {
		isRateLimited: boolean;
		resetTime?: number;
		remaining?: number;
		reason?: "xai_capacity_402";
	};
	dbWriteDelay?: Promise<void>;
}) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
		}>,
		enqueueCount: 0,
	};
	let dbWriteCompleted = false;

	const ctx = {
		provider: {
			name: "xai",
			isStreamingResponse: () => false,
			parseRateLimit: () => opts.rateLimitInfo,
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: async (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				if (opts.dbWriteDelay) {
					await opts.dbWriteDelay;
				}
				dbWriteCompleted = true;
				calls.markRateLimited.push({ accountId, resetTime, reason });
				return 1;
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
				return true;
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls, isDbWriteCompleted: () => dbWriteCompleted };
}

describe("processProxyResponse - native xAI capacity classification (R5-R10)", () => {
	afterEach(() => {
		usageCache.delete("xai-1");
	});

	it("passes reason='xai_capacity_402' through to the durable cooldown write on a direct 402", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, reason: "xai_capacity_402" },
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
	});

	it("awaits the durable cooldown write before resolving (R9)", async () => {
		// Ordering-based assertion rather than tick-counting: a fire-and-forget
		// write (the old behavior) resolves processProxyResponse's promise
		// before the DB write's own "complete" event has been recorded, since
		// nothing forces the write to finish first. The awaited-persist path
		// must record "db-write-complete" strictly before
		// "process-response-resolved".
		const events: string[] = [];
		const account = makeXaiAccount({ id: "xai-1" });
		let resolveDbWrite: (() => void) | undefined;
		const dbWriteDelay = new Promise<void>((resolve) => {
			resolveDbWrite = resolve;
		}).then(() => {
			events.push("db-write-complete");
		});
		const { ctx } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, reason: "xai_capacity_402" },
			dbWriteDelay,
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		const resultPromise = processProxyResponse(response, account, ctx).then(
			(result) => {
				events.push("process-response-resolved");
				return result;
			},
		);

		// Give the write's microtask chain a few ticks to run to completion
		// if nothing is blocking it, then resolve it, then observe the order.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		resolveDbWrite?.();
		const result = await resultPromise;

		expect(result).toBe(true);
		expect(events).toEqual(["db-write-complete", "process-response-resolved"]);
	});

	it("uses a fresh future cached xAI credits.resets_at when the 402 carries no direct resetTime", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const futureResetIso = new Date(Date.now() + 20 * 60_000).toISOString();
		usageCache.set("xai-1", {
			credits: { utilization: 100, resets_at: futureResetIso },
		});
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, reason: "xai_capacity_402" },
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
		expect(calls.markRateLimited[0]?.resetTime).toBe(
			new Date(futureResetIso).getTime(),
		);
	});

	it("falls back to the bounded no-reset cooldown when the cached xAI reset is in the past", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const pastResetIso = new Date(Date.now() - 60_000).toISOString();
		usageCache.set("xai-1", {
			credits: { utilization: 100, resets_at: pastResetIso },
		});
		const before = Date.now();
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, reason: "xai_capacity_402" },
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
		const THIRTY_SECONDS = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + THIRTY_SECONDS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + THIRTY_SECONDS + 1000);
	});

	it("falls back to the bounded no-reset cooldown when there is no cached xAI usage at all", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const before = Date.now();
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, reason: "xai_capacity_402" },
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
		const THIRTY_SECONDS = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + THIRTY_SECONDS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + THIRTY_SECONDS + 1000);
	});

	it("a direct valid Retry-After resetTime outranks a conflicting cached xAI credits reset", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const directResetTime = Date.now() + 5 * 60_000;
		const conflictingCachedResetIso = new Date(
			Date.now() + 45 * 60_000,
		).toISOString();
		usageCache.set("xai-1", {
			credits: { utilization: 100, resets_at: conflictingCachedResetIso },
		});
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: {
				isRateLimited: true,
				resetTime: directResetTime,
				reason: "xai_capacity_402",
			},
		});
		const response = new Response('{"error":"insufficient credits"}', {
			status: 402,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("xai_capacity_402");
		// cooldownUntil = Math.min(resetTime, now+backoff) - direct resetTime wins, never
		// the larger cached value.
		expect(calls.markRateLimited[0]?.resetTime).toBeLessThanOrEqual(
			directResetTime,
		);
	});

	it("native xAI 429 classifies and is not relabeled as xai_capacity_402", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const resetTime = Date.now() + 30_000;
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true, resetTime },
		});
		const response = new Response('{"error":"rate limited"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("native xAI 429 with no direct resetTime does not inherit a cached xAI credits reset (R8 scope)", async () => {
		// R8 scopes cache enrichment to direct 402 cooldowns only. A transient
		// 429 with no direct resetTime and no provider-supplied reason must fall
		// through to the bounded no-reset probe cooldown, not inherit a cached
		// billing-window reset that could bench a healthy account for hours.
		const account = makeXaiAccount({ id: "xai-1" });
		const futureResetIso = new Date(Date.now() + 45 * 60_000).toISOString();
		usageCache.set("xai-1", {
			credits: { utilization: 100, resets_at: futureResetIso },
		});
		const before = Date.now();
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: true },
		});
		const response = new Response('{"error":"rate limited"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_429_no_reset_probe_cooldown",
		);
		const THIRTY_SECONDS = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + THIRTY_SECONDS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + THIRTY_SECONDS + 1000);
	});

	it("native xAI 400 does not classify as rate-limited", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: false },
		});
		const response = new Response('{"error":"bad request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(false);
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("native xAI 500 does not classify as rate-limited", async () => {
		const account = makeXaiAccount({ id: "xai-1" });
		const { ctx, calls } = makeXaiCtx({
			rateLimitInfo: { isRateLimited: false },
		});
		const response = new Response('{"error":"internal error"}', {
			status: 500,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(false);
		expect(calls.markRateLimited).toHaveLength(0);
	});
});

describe("processProxyResponse - cooldown clearing gated on response.ok (root-cause fix)", () => {
	it("does NOT clear rate_limited_until on a non-rate-limited 400 error response", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: false });
		const response = new Response('{"error":"bad request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(account.rate_limited_until).not.toBeNull();
	});

	it("does NOT clear rate_limited_until on a non-rate-limited 500 error response", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: false });
		const response = new Response('{"error":"internal error"}', {
			status: 500,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(account.rate_limited_until).not.toBeNull();
	});

	it("does NOT reset consecutive_rate_limits stability counter on a non-ok error response", async () => {
		const account = makeAccount({
			rate_limited_at: Date.now() - 999_999_999, // well past the stability window
			consecutive_rate_limits: 3,
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: false });
		const response = new Response('{"error":"bad request"}', {
			status: 404,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(account.consecutive_rate_limits).toBe(3);
		expect(account.rate_limited_at).not.toBeNull();
	});

	it("still clears rate_limited_until on a genuine 2xx success (regression)", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx } = makeCtx({ isStream: false, rateLimited: false });
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(account.rate_limited_until).toBeNull();
	});
});
