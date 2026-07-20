import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
	ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
} from "../anthropic-precommit-rescue";
import type { ProxyContext } from "../handlers";

// Loading proxy.ts in a focused unit test must not require ignored embedded
// worker artifacts from the CLI build.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { usageCache } = await import("@better-ccflare/providers");
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MEANINGFUL_PROGRESS_ENV =
	"CCFLARE_ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS";
const RESCUE_ACTIVATION_ENV =
	"CCFLARE_ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS";
const RESCUE_PING_ENV = "CCFLARE_ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS";
const ACCOUNT_SELECTION_TIMEOUT_ENV = "CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS";
const FAST_SUCCESS = [
	"event: message_start",
	'data: {"type":"message_start","message":{"id":"msg-pass","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
	"",
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"passthrough"}}',
	"",
	"event: content_block_stop",
	'data: {"type":"content_block_stop","index":0}',
	"",
	"event: message_delta",
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
	"",
	"event: message_stop",
	'data: {"type":"message_stop"}',
	"",
	"",
].join("\n");
const STRUCTURAL_PRELUDE = [
	"event: message_start",
	'data: {"type":"message_start","message":{"id":"msg-private","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
	"",
	"event: ping",
	'data: {"type":"ping"}',
	"",
	"",
].join("\n");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function byteStream(body: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
}

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

function makeContext(
	accounts: Account[],
	providerName = "codex",
): ProxyContext {
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
			name: providerName,
			canHandle: () => true,
			buildUrl: () => "https://upstream.test/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
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

function makeAnthropicRequest(stream: boolean, signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			stream,
		}),
		signal,
	});
}

let savedPassthrough: string | undefined;
let savedMeaningfulProgress: string | undefined;
let savedRescueActivation: string | undefined;
let savedRescuePing: string | undefined;
let savedAccountSelectionTimeout: string | undefined;
let restoreUsageCollector = (): void => {};
let usageStarts: Array<Record<string, unknown>> = [];
let usageEnds: Array<Record<string, unknown>> = [];

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	savedMeaningfulProgress = process.env[MEANINGFUL_PROGRESS_ENV];
	savedRescueActivation = process.env[RESCUE_ACTIVATION_ENV];
	savedRescuePing = process.env[RESCUE_PING_ENV];
	savedAccountSelectionTimeout = process.env[ACCOUNT_SELECTION_TIMEOUT_ENV];
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	usageStarts = [];
	usageEnds = [];
	const collector = {
		handleStart: mock((message: Record<string, unknown>) => {
			usageStarts.push(message);
		}),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async (message: Record<string, unknown>) => {
			usageEnds.push(message);
		}),
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
});

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
	usageCache.delete("acc-resetless-capacity");
	usageCache.delete("acc-fable-secondary");
	usageCache.delete("acc-fable-tertiary");
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
	for (const [name, value] of [
		[MEANINGFUL_PROGRESS_ENV, savedMeaningfulProgress],
		[RESCUE_ACTIVATION_ENV, savedRescueActivation],
		[RESCUE_PING_ENV, savedRescuePing],
		[ACCOUNT_SELECTION_TIMEOUT_ENV, savedAccountSelectionTimeout],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("routing terminal — 503 response", () => {
	it("records the direct native terminal lifecycle exactly once", async () => {
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([]),
		);

		expect(response.status).toBe(503);
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 503,
			isStream: false,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "route_unavailable",
		});
	});

	it("records a delayed final-attempt 503 before rescue translates it to SSE", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "100";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		const account = makeAccount({
			id: "acc-rescued-terminal",
			provider: "anthropic",
			access_token: "test-access-token",
			refresh_token: "test-refresh-token",
			expires_at: Date.now() + 60_000,
		});
		globalThis.fetch = mock(async () => {
			await delay(10);
			throw new Error("simulated upstream connection failure");
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			makeContext([account], "anthropic"),
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 503,
			isStream: false,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "route_unavailable",
		});
	});

	it("records an outer-rescue routing rejection once as the HTTP-200 terminal it emitted", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "100";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		const account = makeAccount({
			id: "acc-rescue-routing-rejection",
			provider: "anthropic",
			access_token: "test-access-token",
			refresh_token: "test-refresh-token",
			expires_at: Date.now() + 60_000,
		});
		const ctx = makeContext([account], "anthropic");
		ctx.strategy.getRouteCircuitRecoveryHint = () => {
			throw new Error("simulated terminal routing rejection");
		};
		globalThis.fetch = mock(async () => {
			await delay(10);
			throw new Error("simulated upstream connection failure");
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 200,
			isStream: true,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "anthropic_rescue_routing_error",
		});
	});

	it("records a delayed local non-SSE terminal only when the outer rescue owns its translation", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "100";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[ACCOUNT_SELECTION_TIMEOUT_ENV] = "5";
		const ctx = makeContext([], "anthropic");
		ctx.strategy = {
			select: async () => {
				await delay(30);
				return [];
			},
		} as never;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 200,
			isStream: true,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "anthropic_rescue_non_sse_response",
		});
	});

	it("records the outer commitment deadline once when routing never settles", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "30";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[ACCOUNT_SELECTION_TIMEOUT_ENV] = "100";
		const ctx = makeContext([], "anthropic");
		ctx.strategy = {
			select: () => new Promise<Account[]>(() => undefined),
		} as never;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 200,
			isStream: true,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "anthropic_rescue_commitment_deadline",
		});
	});

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

	it("returns retryable pool exhaustion for mixed finite global and Fable route recovery without an upstream attempt", async () => {
		const now = Date.UTC(2026, 6, 20, 12);
		const primary = makeAccount({
			id: "acc-global-primary",
			name: "primary",
			rate_limited_until: now + 60_000,
			rate_limited_reason: "upstream_429_with_reset",
		});
		const secondary = makeAccount({
			id: "acc-fable-secondary",
			name: "secondary",
		});
		const tertiary = makeAccount({
			id: "acc-fable-tertiary",
			name: "tertiary",
		});
		const realDateNow = Date.now;
		Date.now = () => now;
		let upstreamAttempts = 0;
		globalThis.fetch = mock(async () => {
			upstreamAttempts += 1;
			throw new Error("upstream must not be called");
		}) as unknown as typeof fetch;
		try {
			for (const [account, resetAt] of [
				[secondary, now + 120_000],
				[tertiary, now + 180_000],
			] as const) {
				usageCache.set(account.id, {
					limits: [
						{
							kind: "weekly_scoped",
							percent: 100,
							resets_at: new Date(resetAt).toISOString(),
							scope: { model: { id: null, display_name: "Fable" } },
							is_active: true,
						},
					],
				});
			}
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-fable-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext([primary, secondary, tertiary]),
			);

			expect(response.status).toBe(503);
			expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
				"exhausted",
			);
			expect(response.headers.get("retry-after")).toBe("60");
			expect(upstreamAttempts).toBe(0);
			expect((await response.json()).error.code).toBe("pool_exhausted");
		} finally {
			Date.now = realDateNow;
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
	it("bounds an unauthenticated pre-header stall with the shared rescue signal", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		let abortCount = 0;
		let abortElapsedMs: number | null = null;
		const startedAt = Date.now();
		globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input, init);
			return new Promise<Response>((_resolve, reject) => {
				const rejectOnAbort = () => {
					abortCount++;
					abortElapsedMs = Date.now() - startedAt;
					reject(upstreamRequest.signal.reason);
				};
				if (upstreamRequest.signal.aborted) rejectOnAbort();
				else {
					upstreamRequest.signal.addEventListener("abort", rejectOnAbort, {
						once: true,
					});
				}
			});
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			makeContext([], "anthropic"),
		);
		const body = await response.text();

		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(abortCount).toBe(1);
		expect(abortElapsedMs).not.toBeNull();
		expect(usageStarts).toHaveLength(1);
		expect(usageEnds).toHaveLength(1);
		expect(usageStarts[0]).toMatchObject({
			requestId: usageEnds[0].requestId,
			accountId: null,
			responseStatus: 200,
			isStream: true,
		});
		expect(usageEnds[0]).toMatchObject({
			success: false,
			error: "anthropic_rescue_commitment_deadline",
		});
		if (abortElapsedMs === null) return;
		expect(abortElapsedMs).toBeLessThan(100);
	});

	it("terminates a structural-only unauthenticated stream before the shared boundary", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		let cancelCount = 0;
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(STRUCTURAL_PRELUDE));
						},
						cancel() {
							cancelCount++;
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
		) as unknown as typeof fetch;

		const startedAt = Date.now();
		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			makeContext([], "anthropic"),
		);
		const stalled = Symbol("passthrough stream remained open");
		const body = await Promise.race([
			response.text(),
			delay(120).then((): typeof stalled => stalled),
		]);

		expect(body).not.toBe(stalled);
		if (body === stalled) return;
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(body).not.toContain("msg-private");
		expect(Date.now() - startedAt).toBeLessThan(120);
		expect(cancelCount).toBe(1);
	});

	it("forwards a fast meaningful unauthenticated stream byte-for-byte", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		process.env[RESCUE_ACTIVATION_ENV] = "40";
		globalThis.fetch = mock(
			async () =>
				new Response(byteStream(FAST_SUCCESS), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-upstream-fast": "preserved",
					},
				}),
		) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			makeContext([], "anthropic"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-upstream-fast")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(FAST_SUCCESS);
	});

	it("propagates rescued downstream cancellation to unauthenticated fetch", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		process.env[MEANINGFUL_PROGRESS_ENV] = "100";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		let abortCount = 0;
		globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input, init);
			return new Promise<Response>((_resolve, reject) => {
				upstreamRequest.signal.addEventListener(
					"abort",
					() => {
						abortCount++;
						reject(upstreamRequest.signal.reason);
					},
					{ once: true },
				);
			});
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(true),
			new URL("https://proxy.local/v1/messages"),
			makeContext([], "anthropic"),
		);
		const reader = response.body?.getReader();
		const first = await reader?.read();
		expect(decoder.decode(first?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		await reader?.cancel("downstream left");
		const deadline = Date.now() + 50;
		while (abortCount === 0 && Date.now() < deadline) await delay(1);

		expect(abortCount).toBe(1);
	});

	it("leaves a slow stream:false unauthenticated response native", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		process.env[MEANINGFUL_PROGRESS_ENV] = "20";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		const expectedBody = JSON.stringify({ passthrough: "native" });
		globalThis.fetch = mock(async () => {
			await delay(60);
			return new Response(expectedBody, {
				status: 202,
				statusText: "Native passthrough",
				headers: {
					"content-type": "application/json",
					"x-native-passthrough": "preserved",
				},
			});
		}) as unknown as typeof fetch;

		const response = await handleProxy(
			makeAnthropicRequest(false),
			new URL("https://proxy.local/v1/messages"),
			makeContext([], "anthropic"),
		);

		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Native passthrough");
		expect(response.headers.get("x-native-passthrough")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(expectedBody);
	});
});
