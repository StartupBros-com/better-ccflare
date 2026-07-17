import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { evaluateGuardRetry } from "../../../../../scripts/ccflare-guard-policy.mjs";
import { handleProxy } from "../../proxy";
import * as usageCollectorModule from "../../usage-collector";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { getRequestRateLimitOutcomes } from "../rate-limit-scope";

const NOW = 1_800_000_000_000;

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
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
		custom_endpoint: `https://${id}.test/v1`,
		model_mappings: JSON.stringify({
			opus: [`${id}-primary`, `${id}-fallback`],
		}),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers: new Headers(),
		...overrides,
	};
}

function makeBody(model = "claude-opus-4-8"): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	).buffer;
}

function makeRequest(body = makeBody()): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

interface ObservableResponse {
	response: Response;
	cancelReasons: unknown[];
}

function observable402(headers: HeadersInit = {}): ObservableResponse {
	const cancelReasons: unknown[] = [];
	const payload = new TextEncoder().encode(
		JSON.stringify({ error: { message: "Payment required" } }),
	);
	return {
		response: new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(payload);
					setTimeout(() => {
						try {
							controller.close();
						} catch {
							// The proxy may have cancelled the stream first.
						}
					}, 20);
				},
				cancel(reason) {
					cancelReasons.push(reason);
				},
			}),
			{
				status: 402,
				headers: { "content-type": "application/json", ...headers },
			},
		),
		cancelReasons,
	};
}

function successResponse(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_success",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

interface ContextHarness {
	ctx: ProxyContext;
	markAccountRateLimited: ReturnType<typeof mock>;
	saveRequest: ReturnType<typeof mock>;
	getActiveComboForFamily: ReturnType<typeof mock>;
	strategySelect: ReturnType<typeof mock>;
	flush: () => Promise<void>;
}

function makeContext(
	accounts: Account[],
	options: { combo?: ComboWithSlots | null } = {},
): ContextHarness {
	const persistedCooldowns = new Map<
		string,
		{ until: number; reason: string }
	>();
	const queuedJobs: Promise<unknown>[] = [];
	const markAccountRateLimited = mock(
		async (accountId: string, until: number, reason: string) => {
			persistedCooldowns.set(accountId, { until, reason });
			return 1;
		},
	);
	const saveRequest = mock(async (..._args: unknown[]) => undefined);
	const getActiveComboForFamily = mock(async () => options.combo ?? null);
	const strategySelect = mock(() => accounts);
	const getAllAccounts = mock(async () =>
		accounts.map((account) => {
			const persisted = persistedCooldowns.get(account.id);
			return persisted
				? {
						...account,
						rate_limited_until: persisted.until,
						rate_limited_reason: persisted.reason,
					}
				: account;
		}),
	);
	const ctx = {
		strategy: { select: strategySelect },
		dbOps: {
			getAllAccounts,
			getActiveComboForFamily,
			markAccountRateLimited,
			saveRequest,
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
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
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string, account: Account) =>
				`${account.custom_endpoint}/messages`,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: null,
			}),
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock((job: () => unknown) => {
				const result = job();
				if (result instanceof Promise) queuedJobs.push(result);
			}),
		},
	} as unknown as ProxyContext;
	return {
		ctx,
		markAccountRateLimited,
		saveRequest,
		getActiveComboForFamily,
		strategySelect,
		flush: async () => {
			await Promise.all(queuedJobs);
		},
	};
}

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalDefaultCooldown =
	process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS;
let restoreUsageCollector = (): void => {};

beforeEach(() => {
	Date.now = () => NOW;
	process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS = "60000";
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as usageCollectorModule.UsageCollector);
	restoreUsageCollector = () => collectorSpy.mockRestore();
});

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
	Date.now = originalDateNow;
	if (originalDefaultCooldown === undefined) {
		delete process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS;
	} else {
		process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS = originalDefaultCooldown;
	}
});

describe("raw upstream HTTP 402 routing", () => {
	it("cancels, audits, cools, and returns control without trying a model fallback", async () => {
		const account = makeAccount("grok-openai-compatible", {
			provider: "test-provider" as Account["provider"],
		});
		const harness = makeContext([account]);
		const upstream = observable402({ "retry-after": "120" });
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.json()) as { model?: string };
			attemptedModels.push(body.model ?? "missing");
			return upstream.response;
		}) as unknown as typeof fetch;
		const body = makeBody();
		const request = makeRequest(body);

		const response = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			harness.ctx,
		);
		await harness.flush();

		const returnedStatus = response?.status ?? null;
		if (response?.body) await response.body.cancel("test_cleanup");
		expect(returnedStatus).toBeNull();
		expect(attemptedModels).toEqual(["claude-opus-4-8"]);
		expect(upstream.cancelReasons).toEqual([undefined]);
		expect(account.paused).toBe(false);
		expect(account.rate_limited_until).toBeGreaterThan(NOW);
		expect(account.rate_limited_until).toBeLessThanOrEqual(NOW + 120_000);
		expect(harness.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[0]).toBe(account.id);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[2]).toBe(
			"upstream_402_payment_required",
		);
		expect(harness.saveRequest).toHaveBeenCalledTimes(1);
		expect(harness.saveRequest.mock.calls[0]?.[4]).toBe(402);
		expect(harness.saveRequest.mock.calls[0]?.[5]).toBe(false);
		expect(harness.saveRequest.mock.calls[0]?.[6]).toBe(
			"upstream_402_payment_required",
		);
		expect(getRequestRateLimitOutcomes(request)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				status: 402,
				scope: "account",
				reason: "upstream_402_payment_required",
				availableAt: null,
			}),
		]);
	});

	it("returns from the first ComboSlot 402 and succeeds on the later account", async () => {
		// Bypass the global provider registry so this integration fixture controls
		// the raw HTTP responses; ctx.provider below is the OpenAI-compatible path.
		const grok = makeAccount("grok", {
			provider: "test-provider" as Account["provider"],
		});
		const later = makeAccount("later-openai", {
			provider: "test-provider" as Account["provider"],
		});
		const combo: ComboWithSlots = {
			id: "combo-opus",
			name: "Priority Opus 4.8",
			description: null,
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [
				{
					id: "slot-grok",
					combo_id: "combo-opus",
					account_id: grok.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-later",
					combo_id: "combo-opus",
					account_id: later.id,
					model: "claude-opus-4-8",
					priority: 10,
					enabled: true,
				},
			],
		};
		const harness = makeContext([grok, later], { combo });
		const first = observable402();
		const upstreamUrls: string[] = [];
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			const body = (await request.clone().json()) as { model?: string };
			attemptedModels.push(body.model ?? "missing");
			return upstreamUrls.length === 1
				? first.response
				: successResponse(body.model ?? "later-openai-primary");
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(upstreamUrls).toHaveLength(2);
		expect(upstreamUrls[0]).toContain("grok.test");
		expect(upstreamUrls[1]).toContain("later-openai.test");
		expect(attemptedModels).toEqual(["claude-opus-4-8", "claude-opus-4-8"]);
		expect(response.status).toBe(200);
		expect(first.cancelReasons).toEqual([undefined]);
		expect(harness.getActiveComboForFamily).toHaveBeenCalledTimes(1);
		// Active combo candidates now flow through the configured strategy as one
		// atomic candidate list before the request-local failover loop starts.
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it.each([
		400, 404, 429,
	])("fails over to the next ComboSlot when an initial %i model error is followed by fallback 402", async (initialStatus) => {
		const firstAccount = makeAccount("first", {
			model_mappings: JSON.stringify({
				opus: ["first-primary", "first-fallback", "first-never"],
			}),
		});
		const laterAccount = makeAccount("later");
		const combo: ComboWithSlots = {
			id: "combo-opus-fallback-402",
			name: "Priority Opus fallback 402",
			description: null,
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [
				{
					id: "slot-first",
					combo_id: "combo-opus-fallback-402",
					account_id: firstAccount.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-later",
					combo_id: "combo-opus-fallback-402",
					account_id: laterAccount.id,
					model: "claude-opus-4-8",
					priority: 10,
					enabled: true,
				},
			],
		};
		const harness = makeContext([firstAccount, laterAccount], { combo });
		const fallback402 = observable402({ "retry-after": "120" });
		const attempts: Array<{ url: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			attempts.push({ url: request.url, model: body.model ?? "missing" });
			if (attempts.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							type: "not_found_error",
							code: "model_not_found",
							message: "model not found",
						},
					}),
					{
						status: initialStatus,
						headers: { "content-type": "application/json" },
					},
				);
			}
			if (attempts.length === 2) return fallback402.response;
			return successResponse(body.model ?? "later-primary");
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(attempts).toEqual([
			expect.objectContaining({ model: "first-primary" }),
			expect.objectContaining({ model: "first-fallback" }),
			expect.objectContaining({ model: "later-primary" }),
		]);
		expect(response.status).toBe(200);
		expect(attempts.some(({ model }) => model === "first-never")).toBe(false);
		expect(fallback402.cancelReasons).toEqual([undefined]);
		expect(firstAccount.rate_limited_until).toBeGreaterThan(NOW);
		expect(harness.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[0]).toBe(
			firstAccount.id,
		);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[2]).toBe(
			"upstream_402_payment_required",
		);
		expect(harness.saveRequest).toHaveBeenCalledTimes(1);
		expect(harness.saveRequest.mock.calls[0]?.[4]).toBe(402);
		expect(harness.saveRequest.mock.calls[0]?.[6]).toBe(
			"upstream_402_payment_required",
		);
		expect(getRequestRateLimitOutcomes(request)).toEqual([
			expect.objectContaining({
				accountId: firstAccount.id,
				status: 402,
				scope: "account",
				attemptedModel: "first-fallback",
				reason: "upstream_402_payment_required",
				availableAt: null,
			}),
		]);
	});

	it("handles a raw 402 returned by an in-place 529 retry before provider processing", async () => {
		const savedRetryBase = process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		const savedRetryMax = process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		const savedRetryAttempts = process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		const savedRetryEnabled = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;

		try {
			const account = makeAccount("overload-retry", {
				provider: "test-provider" as Account["provider"],
			});
			const harness = makeContext([account]);
			harness.ctx.provider.parseRateLimit = (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: null,
			});
			const retry402 = observable402();
			let callCount = 0;
			globalThis.fetch = mock(async () => {
				callCount++;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "overloaded_error", message: "Overloaded" },
						}),
						{
							status: 529,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return retry402.response;
			}) as unknown as typeof fetch;
			const body = makeBody();
			const request = makeRequest(body);

			const response = await proxyWithAccount(
				request,
				new URL(request.url),
				account,
				makeRequestMeta(),
				body,
				() => undefined,
				0,
				harness.ctx,
			);
			await harness.flush();

			expect(response).toBeNull();
			expect(callCount).toBe(2);
			expect(retry402.cancelReasons).toEqual([undefined]);
			expect(harness.markAccountRateLimited).toHaveBeenCalledTimes(1);
			expect(harness.saveRequest.mock.calls[0]?.[4]).toBe(402);
			expect(harness.saveRequest.mock.calls[0]?.[6]).toBe(
				"upstream_402_payment_required",
			);
			expect(getRequestRateLimitOutcomes(request)).toEqual([
				expect.objectContaining({
					accountId: account.id,
					status: 402,
					scope: "account",
					reason: "upstream_402_payment_required",
				}),
			]);
		} finally {
			for (const [name, value] of [
				["CCFLARE_OVERLOAD_RETRY_BASE_MS", savedRetryBase],
				["CCFLARE_OVERLOAD_RETRY_MAX_MS", savedRetryMax],
				["CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS", savedRetryAttempts],
				["CCFLARE_OVERLOAD_RETRY_ENABLED", savedRetryEnabled],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("turns all-account 402s into a stable non-retryable route_unavailable", async () => {
		const firstAccount = makeAccount("grok");
		const secondAccount = makeAccount("openai-backup", { priority: 10 });
		const harness = makeContext([firstAccount, secondAccount]);
		const first = observable402();
		const second = observable402({
			"x-ratelimit-reset": String(NOW / 1000 + 90),
		});
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return callCount === 1 ? first.response : second.response;
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();
		const payload = (await response.json()) as {
			error: { code: string; type: string };
		};

		expect(callCount).toBe(2);
		expect(response.status).toBe(503);
		expect(payload.error.code).toBe("route_unavailable");
		expect(response.headers.get("retry-after")).toBeNull();
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(first.cancelReasons).toEqual([undefined]);
		expect(second.cancelReasons).toEqual([undefined]);
		expect(getRequestRateLimitOutcomes(request)).toEqual([
			expect.objectContaining({
				accountId: firstAccount.id,
				status: 402,
				scope: "account",
				availableAt: null,
			}),
			expect.objectContaining({
				accountId: secondAccount.id,
				status: 402,
				scope: "account",
				availableAt: null,
			}),
		]);
		expect(
			evaluateGuardRetry({
				status: response.status,
				headers: response.headers,
				bodyText: JSON.stringify(payload),
				nowMs: NOW,
			}),
		).toEqual({
			retry: false,
			reason: "pool_not_exhausted",
			delayMs: 0,
			recoverySource: null,
		});
	});
});
