/**
 * Mid-stream overloaded_error test.
 *
 * Tests that when an SSE stream contains an overloaded_error frame mid-stream,
 * the account gets a short probe cooldown without inheriting unrelated quota
 * reset headers from the original HTTP response.
 *
 * Note: Mid-stream detection cannot rescue the current response — the stream
 * headers were already sent to the client. It only prevents future requests
 * from being routed to the overloaded account until the cooldown expires.
 */
import { describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { forwardToClient } from "../../response-handler";
import * as usageCollectorModule from "../../usage-collector";
import type { ProxyContext } from "../proxy-types";
import * as rateLimitCooldownModule from "../rate-limit-cooldown";
import { handleRateLimitResponse } from "../response-processor";
import { createSseRateLimitSniffer } from "../sse-rate-limit-sniffer";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-mid-1",
		name: "mid-stream-test",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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

function makeCtxWithReason() {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
		}>,
		enqueueCount: 0,
	};

	const ctx = {
		config: {
			getStorePayloads: () => false,
		},
		provider: {
			name: "anthropic",
			isStreamingResponse: () => true,
			parseRateLimit: () => ({
				isRateLimited: true,
				resetTime: undefined,
				statusHeader: undefined,
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
				return Promise.resolve({ consecutiveRateLimits: 1, applied: true });
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

function setFreshScopedUsage(accountId: string, family = "Fable"): void {
	usageCache.set(accountId, {
		limits: [
			{
				kind: "session",
				percent: 10,
				resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 72,
				resets_at: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				scope: { model: { id: null, display_name: family } },
				is_active: true,
			},
		],
	});
}

function setLiveInactiveAccountWindowUsage(accountId: string): void {
	usageCache.set(accountId, {
		limits: [
			{
				kind: "session",
				percent: 0,
				resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				is_active: false,
			},
			{
				kind: "weekly_all",
				percent: 84,
				resets_at: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
				is_active: false,
			},
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				scope: { model: { id: null, display_name: "Fable" } },
				is_active: true,
			},
		],
	});
}

function midStreamErrorResponse(
	errorType: "rate_limit_error" | "overloaded_error" = "rate_limit_error",
	headers: HeadersInit = {},
): Response {
	const encoder = new TextEncoder();
	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "text/event-stream");
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
					),
				);
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: {"type":"error","error":{"type":"${errorType}","message":"limited"}}\n\n`,
					),
				);
				controller.close();
			},
		}),
		{ status: 200, headers: responseHeaders },
	);
}

async function forwardAndConsumeMidStream(
	account: Account,
	ctx: ProxyContext,
	response: Response,
	attemptedModel: string | null,
	betaSignature: string | null = null,
): Promise<string> {
	const collector = {
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(() => Promise.resolve()),
	};
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(
		collector as unknown as usageCollectorModule.UsageCollector,
	);
	try {
		const requestHeaders = new Headers({
			"content-type": "application/json",
		});
		if (betaSignature) requestHeaders.set("anthropic-beta", betaSignature);
		const forwarded = await forwardToClient(
			{
				requestId: `req-${account.id}`,
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders,
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				attemptedModel,
			},
			ctx,
		);
		return await forwarded.text();
	} finally {
		collectorSpy.mockRestore();
	}
}

describe("handleRateLimitResponse — mid-stream 529 overload", () => {
	it("marks account with reason='upstream_529_overloaded_with_reset' when called with status 529 and resetTime", () => {
		// This simulates what response-handler.ts does when rateLimitSniffer fires
		// for an overloaded_error frame mid-stream (firedReason === "overloaded_error").
		// The handler passes status=529 so the reason is correctly mapped.
		const account = makeAccount();
		const resetTime = Date.now() + 60_000;
		const { ctx, calls } = makeCtxWithReason();

		// handleRateLimitResponse with status=529 should use "upstream_529_overloaded_with_reset"
		handleRateLimitResponse(
			account,
			{ isRateLimited: true, resetTime },
			ctx,
			529,
		);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_with_reset",
		);
		// cooldownUntil = Math.min(resetTime, now+backoff) — backoff caps below resetTime for count=1
		expect(calls.markRateLimited[0]?.resetTime).toBeLessThanOrEqual(resetTime);
		expect(calls.markRateLimited[0]?.resetTime).toBeGreaterThan(Date.now());
		expect(account.rate_limited_until).toBeLessThanOrEqual(resetTime);
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(Date.now());
	});

	it("marks account with reason='upstream_429_with_reset' when called with status 429 and resetTime", () => {
		// rate_limit_error -> status 429 -> reason "upstream_429_with_reset"
		const account = makeAccount();
		const resetTime = Date.now() + 60_000;
		const { ctx, calls } = makeCtxWithReason();

		handleRateLimitResponse(
			account,
			{ isRateLimited: true, resetTime },
			ctx,
			429,
		);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("does not mark when resetTime is absent (no-reset path is handled by caller)", () => {
		// handleRateLimitResponse only applies cooldown when resetTime is provided.
		// The no-reset path (upstream_529_overloaded_no_reset) goes through processProxyResponse.
		const account = makeAccount();
		const { ctx, calls } = makeCtxWithReason();

		handleRateLimitResponse(account, { isRateLimited: true }, ctx, 529);

		// handleRateLimitResponse returns early when no resetTime
		expect(calls.markRateLimited).toHaveLength(0);
		expect(account.rate_limited_until).toBeNull();
	});
});

describe("production sniffer integration — overloaded_error mid-stream", () => {
	it("sniffer fires on mid-stream overloaded_error and maps to 529 reason", () => {
		const sniffer = createSseRateLimitSniffer({ provider: "anthropic" });
		const encode = (s: string) => new TextEncoder().encode(s);
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(true);
		expect(sniffer.firedReason).toBe("overloaded_error");
		// The mapping used by response-handler.ts:
		const status = sniffer.firedReason === "overloaded_error" ? 529 : 429;
		expect(status).toBe(529);
	});

	it("sniffer with non-Anthropic provider does NOT fire on overloaded_error", () => {
		const sniffer = createSseRateLimitSniffer({
			provider: "openai-compatible",
		});
		const encode = (s: string) => new TextEncoder().encode(s);
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(false);
	});

	// Upstream v3.5.44 split 529-overload cooldown away from the generic
	// no-reset 429 cooldown so an overload can no longer ramp the 429 streak
	// (upstream commits f68ba838f / a25b8f252 / c168a56bc). The overload path
	// now reads CCFLARE_OVERLOAD_COOLDOWN_MS instead of
	// CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS. This test's two real claims are
	// unchanged: unrelated quota reset headers are ignored, and the short
	// overload cooldown is what gets applied.
	it("ignores unrelated quota reset headers and uses the short overload cooldown", async () => {
		const now = 1_800_000_000_000;
		const realDateNow = Date.now;
		const originalCooldown = process.env.CCFLARE_OVERLOAD_COOLDOWN_MS;
		Date.now = () => now;
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "15000";
		const account = makeAccount({ id: "acct-mid-overload-quota-reset" });
		const { ctx, calls } = makeCtxWithReason();

		try {
			await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse("overloaded_error", {
					"anthropic-ratelimit-unified-reset": String(now / 1000 + 6 * 60 * 60),
					"x-ratelimit-reset": String(now / 1000 + 4 * 60 * 60),
				}),
				"claude-opus-4-8",
			);

			expect(calls.markRateLimited).toEqual([
				{
					accountId: account.id,
					resetTime: now + 15_000,
					reason: "upstream_529_overloaded_no_reset",
				},
			]);
			expect(account.rate_limited_until).toBe(now + 15_000);
		} finally {
			Date.now = realDateNow;
			if (originalCooldown === undefined) {
				delete process.env.CCFLARE_OVERLOAD_COOLDOWN_MS;
			} else {
				process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = originalCooldown;
			}
		}
	});
});

describe("forwardToClient — model-scoped Anthropic 429 after SSE bytes", () => {
	it("marks only the exhausted Fable family and leaves the account and Opus routable", async () => {
		const account = makeAccount({ id: "acct-mid-fable-scoped" });
		const { ctx, calls } = makeCtxWithReason();
		setFreshScopedUsage(account.id);

		try {
			const body = await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse(),
				"claude-fable-5-20260701",
			);

			// The already-started stream is not replayed; its upstream error reaches
			// the caller and closes normally.
			expect(body).toContain('"type":"content_block_delta"');
			expect(body).toContain('"type":"rate_limit_error"');
			expect(calls.markRateLimited).toHaveLength(0);
			expect(account.rate_limited_until).toBeNull();
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-fable-5-20260701",
				),
			).not.toBeNull();
			expect(
				usageCache.getFamilyScopedExhaustion(account.id, "claude-opus-4-8"),
			).toBeNull();
		} finally {
			usageCache.delete(account.id);
		}
	});

	it("isolates the exact inactive-account-window live fixture to Fable", async () => {
		const now = 1_800_000_000_000;
		const realDateNow = Date.now;
		Date.now = () => now;
		const account = makeAccount({ id: "acct-mid-live-inactive-windows" });
		const { ctx, calls } = makeCtxWithReason();
		setLiveInactiveAccountWindowUsage(account.id);

		try {
			await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse("rate_limit_error", { "retry-after": "120" }),
				"claude-fable-5-20260701",
			);

			expect(calls.markRateLimited).toHaveLength(0);
			expect(account.rate_limited_until).toBeNull();
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-fable-5-20260701",
					now,
				),
			).toMatchObject({ family: "fable", expiresAt: now + 120_000 });
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-opus-4-8",
					now,
				),
			).toBeNull();
		} finally {
			usageCache.delete(account.id);
			Date.now = realDateNow;
		}
	});

	it("keeps startup-empty rate_limit_error evidence exact-model scoped", async () => {
		const account = makeAccount({ id: "acct-mid-no-usage" });
		const { ctx, calls } = makeCtxWithReason();

		try {
			await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse("rate_limit_error", { "retry-after": "120" }),
				"claude-fable-5-20260701",
				"feature-b,feature-a",
			);

			expect(calls.markRateLimited).toHaveLength(0);
			expect(account.rate_limited_until).toBeNull();
			expect(
				usageCache.getModelScopedExhaustion(
					account.id,
					"claude-fable-5-20260701",
					"feature-a,feature-b",
				),
			).not.toBeNull();
			expect(
				usageCache.getModelScopedExhaustion(
					account.id,
					"claude-opus-4-8",
					"feature-a,feature-b",
				),
			).toBeNull();
		} finally {
			usageCache.delete(account.id);
		}
	});

	it("uses Retry-After as family marker timing without benching the account", async () => {
		const account = makeAccount({ id: "acct-mid-hard-signal" });
		const { ctx, calls } = makeCtxWithReason();
		setFreshScopedUsage(account.id);

		try {
			await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse("rate_limit_error", { "retry-after": "60" }),
				"claude-fable-5-20260701",
			);

			expect(calls.markRateLimited).toHaveLength(0);
			expect(account.rate_limited_until).toBeNull();
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-fable-5-20260701",
				),
			).not.toBeNull();
		} finally {
			usageCache.delete(account.id);
		}
	});

	it("preserves account cooldown for an explicit unified hard status", async () => {
		const now = 1_800_000_000_000;
		const realDateNow = Date.now;
		Date.now = () => now;
		const account = makeAccount({ id: "acct-mid-explicit-hard-signal" });
		const { ctx, calls } = makeCtxWithReason();
		setFreshScopedUsage(account.id);

		try {
			await forwardAndConsumeMidStream(
				account,
				ctx,
				midStreamErrorResponse("rate_limit_error", {
					"anthropic-ratelimit-unified-status": "rate_limited",
					"retry-after": "60",
				}),
				"claude-fable-5-20260701",
			);

			expect(calls.markRateLimited).toHaveLength(1);
			expect(calls.markRateLimited[0]?.resetTime).toBe(now + 60_000);
			expect(account.rate_limited_until).not.toBeNull();
			expect(account.rate_limited_until).toBe(now + 60_000);
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-fable-5-20260701",
				),
			).toBeNull();
		} finally {
			usageCache.delete(account.id);
			Date.now = realDateNow;
		}
	});
});

// ── real forwardToClient call form (review Befund 4/8) ───────────────────────
//
// The tests above exercise handleRateLimitResponse (response-processor.ts's
// status-based 429/529 path) and the sniffer in isolation. Neither drives the
// actual code that constructs the mid-stream applyRateLimitCooldown() call in
// response-handler.ts's forwardToClient — the synthetic-resetTime bug (an
// invented reset passed off as an upstream instruction) lived entirely in
// that construction and would have stayed green through CI without a test
// that runs the real call form.
describe("forwardToClient — real mid-stream sniffer call form", () => {
	function createStreamingCtx(): ProxyContext {
		return {
			provider: { name: "anthropic", isStreamingResponse: () => true },
			config: { getStorePayloads: () => true },
			dbOps: {
				markAccountRateLimited: () =>
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			},
			asyncWriter: {
				enqueue: (job: () => void | Promise<void>) => {
					void job();
				},
			},
		} as unknown as ProxyContext;
	}

	function mockCollector() {
		return {
			handleStart: () => {},
			handleChunk: () => {},
			handleEnd: () => Promise.resolve(),
		};
	}

	async function feedSseErrorFrame(
		errorType: "overloaded_error" | "rate_limit_error",
		account: Account,
		ctx: ProxyContext,
	): Promise<void> {
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			mockCollector() as unknown as usageCollectorModule.UsageCollector,
		);
		try {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							`event: error\ndata: {"type":"error","error":{"type":"${errorType}","message":"Overloaded"}}\n\n`,
						),
					);
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: `req-real-${errorType}`,
					method: "POST",
					path: "/v1/messages",
					account,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();
		} finally {
			collectorSpy.mockRestore();
		}
	}

	it("overloaded_error: calls applyRateLimitCooldown with reason='upstream_529_overloaded_no_reset' and no resetTime — no synthetic upstream instruction", async () => {
		const account = makeAccount({ id: "acct-real-529" });
		const ctx = createStreamingCtx();
		const spy = spyOn(rateLimitCooldownModule, "applyRateLimitCooldown");

		try {
			await feedSseErrorFrame("overloaded_error", account, ctx);

			expect(spy).toHaveBeenCalledTimes(1);
			const [, rateLimitInfo] = spy.mock.calls[0] as [
				Account,
				{ resetTime?: number; reason?: string },
				ProxyContext,
			];
			expect(rateLimitInfo.reason).toBe("upstream_529_overloaded_no_reset");
			expect(rateLimitInfo.resetTime).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});

	it("rate_limit_error: calls applyRateLimitCooldown with reason='upstream_429_with_reset' and a synthetic ~60s resetTime — unchanged 429 behaviour", async () => {
		const account = makeAccount({ id: "acct-real-429" });
		const ctx = createStreamingCtx();
		const spy = spyOn(rateLimitCooldownModule, "applyRateLimitCooldown");
		const before = Date.now();

		try {
			await feedSseErrorFrame("rate_limit_error", account, ctx);

			expect(spy).toHaveBeenCalledTimes(1);
			const [, rateLimitInfo] = spy.mock.calls[0] as [
				Account,
				{ resetTime?: number; reason?: string },
				ProxyContext,
			];
			expect(rateLimitInfo.reason).toBe("upstream_429_with_reset");
			expect(rateLimitInfo.resetTime).toBeGreaterThanOrEqual(before + 59_000);
			expect(rateLimitInfo.resetTime).toBeLessThanOrEqual(Date.now() + 61_000);
		} finally {
			spy.mockRestore();
		}
	});
});
