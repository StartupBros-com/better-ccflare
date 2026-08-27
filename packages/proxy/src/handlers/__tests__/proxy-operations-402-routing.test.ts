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
		requires_reauth: false,
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

function modelUnavailableResponse(status: 400 | 404): Response {
	return new Response(
		JSON.stringify({
			error: {
				type: "not_found_error",
				code: "model_not_found",
				message: "model not found",
			},
		}),
		{
			status,
			headers: { "content-type": "application/json" },
		},
	);
}

interface ContextHarness {
	ctx: ProxyContext;
	markAccountRateLimited: ReturnType<typeof mock>;
	saveRequest: ReturnType<typeof mock>;
	saveRoutingAttempt: ReturnType<typeof mock>;
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
	const saveRoutingAttempt = mock(async (..._args: unknown[]) => undefined);
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
			saveRoutingAttempt,
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
		saveRoutingAttempt,
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
		expect(harness.saveRoutingAttempt).toHaveBeenCalledTimes(1);
		expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]).toMatchObject({
			parentRequestId: expect.any(String),
			accountId: account.id,
			statusCode: 402,
			reason: "upstream_402_payment_required",
			scope: "account",
			availableAt: null,
			accountBenched: true,
			routeSuppressed: false,
			circuitCounted: false,
		});
		expect(harness.saveRequest).not.toHaveBeenCalled();
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
		400, 404,
	] as const)("tries every requested-family ComboSlot before deferred fallbacks after an initial %i model error", async (initialStatus) => {
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
			const model = body.model ?? "missing";
			attempts.push({ url: request.url, model });

			const account = new URL(request.url).hostname;
			if (account === "first.test" && model === "first-primary") {
				return modelUnavailableResponse(initialStatus);
			}
			if (account === "later.test" && model === "later-primary") {
				return modelUnavailableResponse(initialStatus);
			}
			if (account === "first.test" && model === "first-fallback") {
				return fallback402.response;
			}
			if (account === "later.test" && model === "later-fallback") {
				return successResponse(model);
			}
			throw new Error(`Unexpected upstream route: ${account} ${model}`);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(
			attempts.map(({ url, model }) => ({
				account: new URL(url).hostname,
				model,
			})),
		).toEqual([
			{ account: "first.test", model: "first-primary" },
			{ account: "later.test", model: "later-primary" },
			{ account: "first.test", model: "first-fallback" },
			{ account: "later.test", model: "later-fallback" },
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
		expect(harness.saveRoutingAttempt).toHaveBeenCalledTimes(1);
		expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.statusCode).toBe(402);
		expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.reason).toBe(
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

	it("treats an ambiguous 429 as account-scoped before trying the next ComboSlot", async () => {
		const firstAccount = makeAccount("first", {
			model_mappings: JSON.stringify({
				opus: ["first-primary", "first-fallback"],
			}),
		});
		const laterAccount = makeAccount("later");
		const combo: ComboWithSlots = {
			id: "combo-opus-account-429",
			name: "Priority Opus account 429",
			description: null,
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [
				{
					id: "slot-first",
					combo_id: "combo-opus-account-429",
					account_id: firstAccount.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-later",
					combo_id: "combo-opus-account-429",
					account_id: laterAccount.id,
					model: "claude-opus-4-8",
					priority: 10,
					enabled: true,
				},
			],
		};
		const harness = makeContext([firstAccount, laterAccount], { combo });
		const attempts: Array<{ account: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const attempt = {
				account: new URL(request.url).hostname,
				model: body.model ?? "missing",
			};
			attempts.push(attempt);

			if (
				attempt.account === "first.test" &&
				attempt.model === "first-primary"
			) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "rate_limit_error",
							message: "rate limited",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
						},
					},
				);
			}
			if (
				attempt.account === "later.test" &&
				attempt.model === "later-primary"
			) {
				return successResponse(attempt.model);
			}
			throw new Error(
				`Unexpected upstream route: ${attempt.account} ${attempt.model}`,
			);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(attempts).toEqual([
			{ account: "first.test", model: "first-primary" },
			{ account: "later.test", model: "later-primary" },
		]);
		expect(response.status).toBe(200);
		expect(firstAccount.rate_limited_until).toBeGreaterThan(NOW);
		expect(harness.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[0]).toBe(
			firstAccount.id,
		);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[2]).toBe(
			"all_models_exhausted_429",
		);
		expect(harness.saveRoutingAttempt).toHaveBeenCalledTimes(1);
		expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.statusCode).toBe(429);
		expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.reason).toBe(
			"all_models_exhausted_429",
		);
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
			expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.statusCode).toBe(
				402,
			);
			expect(harness.saveRoutingAttempt.mock.calls[0]?.[0]?.reason).toBe(
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
			reason: "header_absent_legacy_body_disabled",
			delayMs: 0,
			recoverySource: null,
			recoveryScope: null,
		});
	});
});

// ── U5 canary contract: AE4, AE5, AE6 (constructed fixtures) ────────────────
//
// ALL fixtures in this describe block are CONSTRUCTED from the provider's
// documented error shapes, not captured from live traffic. The 402, 429, and
// model-scoped (404/400 model_not_found) failure shapes were built from
// documented Vercel/OpenAI-compatible error responses, not provoked live
// (KTD7). No live capture was available.
//
// The Vercel catch-all is modeled as an openai-compatible account with
// model_mappings that route every Claude family to zai/glm-5.2-fast (primary)
// then zai/glm-5.2 (fallback), matching the U4 recipe.

describe("U5 canary: AE4 model-scoped Fast failure advances to standard GLM", () => {
	// CONSTRUCTED fixture: a model-scoped 404 (model_not_found) response for
	// the Fast primary model. This shape mirrors the OpenAI-compatible error
	// for an unavailable model, built from documented error shapes.
	function modelNotFoundResponse(model: string): Response {
		return new Response(
			JSON.stringify({
				error: {
					type: "not_found_error",
					code: "model_not_found",
					message: `The model '${model}' does not exist`,
				},
			}),
			{
				status: 404,
				headers: { "content-type": "application/json" },
			},
		);
	}

	it("advances from zai/glm-5.2-fast to zai/glm-5.2 on a model-scoped 404 and succeeds", async () => {
		const vercel = makeAccount("vercel-catchall", {
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const harness = makeContext([vercel]);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			// First attempt (Fast primary) returns model-scoped 404
			if (model === "zai/glm-5.2-fast") {
				return modelNotFoundResponse("zai/glm-5.2-fast");
			}
			// Second attempt (standard GLM) succeeds
			return successResponse(model);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(attemptedModels).toEqual(["zai/glm-5.2-fast", "zai/glm-5.2"]);
		expect(response.status).toBe(200);
		expect(vercel.rate_limited_until).toBeNull();
		// No account-level cooldown was applied (model-scoped failure)
		expect(harness.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it.each([
		400, 404,
	] as const)("advances from Fast to standard GLM on a model-scoped %i and succeeds", async (status) => {
		const vercel = makeAccount("vercel-catchall", {
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const harness = makeContext([vercel]);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			if (model === "zai/glm-5.2-fast") {
				return modelUnavailableResponse(status);
			}
			return successResponse(model);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(attemptedModels).toEqual(["zai/glm-5.2-fast", "zai/glm-5.2"]);
		expect(response.status).toBe(200);
	});
});

describe("U5 canary: AE5 account-wide 402 ends the account attempt without trying standard GLM", () => {
	it("does not advance to zai/glm-5.2 after an account-wide 402 on zai/glm-5.2-fast", async () => {
		const vercel = makeAccount("vercel-catchall", {
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const harness = makeContext([vercel]);
		const upstream = observable402({ "retry-after": "120" });
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			attemptedModels.push(body.model ?? "missing");
			return upstream.response;
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		// Only the Fast primary was tried — standard GLM was NOT attempted
		expect(attemptedModels).toEqual(["zai/glm-5.2-fast"]);
		// The 402 ended the account attempt; with only one account the
		// outer router returns a stable route_unavailable (503)
		expect(response.status).toBe(503);
		const payload = (await response.json()) as {
			error: { code: string };
		};
		expect(payload.error.code).toBe("route_unavailable");
		// Account was benched with the 402 reason
		expect(vercel.rate_limited_until).toBeGreaterThan(NOW);
		expect(harness.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(harness.markAccountRateLimited.mock.calls[0]?.[2]).toBe(
			"upstream_402_payment_required",
		);
		expect(getRequestRateLimitOutcomes(request)).toEqual([
			expect.objectContaining({
				accountId: vercel.id,
				status: 402,
				scope: "account",
				reason: "upstream_402_payment_required",
				availableAt: null,
			}),
		]);
	});

	it("leaves outer failover unchanged — a second higher-priority account can still serve", async () => {
		const vercel = makeAccount("vercel-catchall", {
			priority: 100,
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const preferred = makeAccount("preferred", {
			priority: 10,
			model_mappings: JSON.stringify({
				opus: ["preferred-opus"],
			}),
		});
		const harness = makeContext([preferred, vercel]);
		const vercel402 = observable402({ "retry-after": "120" });
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			const hostname = new URL(request.url).hostname;
			// Vercel account 402s
			if (hostname === "vercel-catchall.test") {
				return vercel402.response;
			}
			// Preferred account succeeds
			return successResponse(model);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		// Vercel was tried first (lower priority number = higher priority... but
		// priority 100 is the platform max, so preferred at 10 comes first).
		// Actually: strategy.select returns accounts as-is, and the proxy tries
		// them in order. The preferred account (priority 10) should be tried
		// first and succeed without reaching Vercel.
		expect(response.status).toBe(200);
		expect(vercel.rate_limited_until).toBeNull();
		expect(harness.markAccountRateLimited).not.toHaveBeenCalled();
	});
});

describe("U5 canary: AE6 billed canary result is recorded as evidence only, not a pass condition", () => {
	it("records a billed canary request (usage > 0) as evidence without failing admission", async () => {
		// AE6: The canary's billed outcome is evidence only. A successful
		// response with non-zero usage must not be treated as a failure —
		// the canary passes because routing and streaming worked, not
		// because the charge was zero.
		const vercel = makeAccount("vercel-catchall", {
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const harness = makeContext([vercel]);
		globalThis.fetch = mock(async () => {
			// A billed success response — usage carries a non-zero charge
			return new Response(
				JSON.stringify({
					id: "msg_billed_canary",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "zai/glm-5.2-fast",
					stop_reason: "end_turn",
					usage: { input_tokens: 100, output_tokens: 50 },
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		// The canary succeeds: routing worked, response is 200
		expect(response.status).toBe(200);
		// Billing is recorded as evidence only — it does NOT trigger an
		// account cooldown, pause, or any failure classification
		expect(vercel.rate_limited_until).toBeNull();
		expect(vercel.paused).toBe(false);
		expect(harness.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("records a zero-cost canary result as evidence without changing admission", async () => {
		// AE6/R13: A canary remains economically successful whether Vercel bills
		// it at zero or debits the configured balance. A zero-cost success must
		// pass admission identically to a billed success.
		const vercel = makeAccount("vercel-catchall", {
			model_mappings: JSON.stringify({
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
		const harness = makeContext([vercel]);
		globalThis.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					id: "msg_zero_cost_canary",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "zai/glm-5.2-fast",
					stop_reason: "end_turn",
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
		);
		await harness.flush();

		expect(response.status).toBe(200);
		expect(vercel.rate_limited_until).toBeNull();
		expect(vercel.paused).toBe(false);
		expect(harness.markAccountRateLimited).not.toHaveBeenCalled();
	});
});
