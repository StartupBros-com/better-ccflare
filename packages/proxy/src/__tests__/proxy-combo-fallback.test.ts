import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	ComboWithSlots,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
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
	};
}

const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};
const cachedUsageAccountIds = new Set<string>();

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	for (const accountId of cachedUsageAccountIds) usageCache.delete(accountId);
	cachedUsageAccountIds.clear();
	globalThis.fetch = originalFetch;
});

function installUsageCollector(): ReturnType<typeof mock> {
	const handleStart = mock(() => undefined);
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart,
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as usageCollectorModule.UsageCollector);
	restoreUsageCollector = () => collectorSpy.mockRestore();
	return handleStart;
}

function makeRoutingPolicy(
	combo: ComboWithSlots,
	family: ComboFamily,
): ComboRoutingPolicySnapshot {
	const { slots, ...comboRecord } = combo;
	return {
		assignment: {
			family,
			combo_id: combo.id,
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: comboRecord,
		slots,
		rules: [],
		exclusions: [],
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots,
	strategySelect: (accounts: Account[], meta: unknown) => Account[],
): ProxyContext {
	return {
		strategy: { select: mock(strategySelect) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getComboRoutingPolicy: mock(async (family: ComboFamily) =>
				makeRoutingPolicy(combo, family),
			),
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
}

function makeProxyRequest(
	model = "claude-opus-4-5",
	synthetic = true,
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (synthetic) headers["x-better-ccflare-auto-refresh"] = "true";
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function outOfCreditsResponse(): Response {
	return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
		status: 429,
		headers: {
			"content-type": "application/json",
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		},
	});
}

describe("post-combo normal fallback", () => {
	it("runs the active combo once, then selects normal accounts without re-entering it", async () => {
		const handleStart = mock(() => undefined);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart,
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as unknown as usageCollectorModule.UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		const comboAccount = makeAccount("combo-account");
		const normalAccount = makeAccount("normal-account");
		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(combo, family),
		);
		const strategySelect = mock(
			(
				accounts: Account[],
				meta: { routingCandidates?: readonly unknown[] },
			) =>
				meta.routingCandidates?.some(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						"comboSlotId" in candidate &&
						candidate.comboSlotId !== null,
				)
					? accounts
					: [normalAccount],
		);
		const ctx = {
			strategy: { select: strategySelect },
			dbOps: {
				getAllAccounts: mock(async () => [comboAccount, normalAccount]),
				getComboRoutingPolicy,
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

		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			if (upstreamUrls.length === 1) {
				return new Response(JSON.stringify({ error: "expired" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			"https://upstream.test/combo-account",
			"https://upstream.test/normal-account",
		]);
		expect(getComboRoutingPolicy).toHaveBeenCalledTimes(1);
		expect(strategySelect).toHaveBeenCalledTimes(2);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it("skips duplicate combo slots but still reaches a later distinct route", async () => {
		installUsageCollector();
		const repeated = makeAccount("repeated-account");
		const later = makeAccount("later-account");
		const combo: ComboWithSlots = {
			id: "combo-duplicates",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-repeated-1",
					combo_id: "combo-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-repeated-2",
					combo_id: "combo-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-z-later",
					combo_id: "combo-duplicates",
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([repeated, later], combo, (accounts) => accounts);
		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			return upstreamUrls.length === 1
				? new Response('{"error":"expired"}', { status: 401 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			"https://upstream.test/repeated-account",
			"https://upstream.test/later-account",
		]);
	});

	it("allows a sibling model after model-scoped exhaustion", async () => {
		const handleStart = installUsageCollector();
		const shared = makeAccount("shared-account");
		const combo: ComboWithSlots = {
			id: "combo-models",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-opus-45",
					combo_id: "combo-models",
					account_id: shared.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-opus-48",
					combo_id: "combo-models",
					account_id: shared.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared], combo, (accounts) => accounts);
		// out_of_credits is an Anthropic-only signal. PR #57 deliberately ignores
		// the same header/body shape from arbitrary compatible providers, so keep
		// this cross-slot regression on the provider that owns the contract.
		ctx.provider.name = "anthropic";
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attemptedModels.push(
				((await request.clone().json()) as { model: string }).model,
			);
			return attemptedModels.length === 1
				? outOfCreditsResponse()
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attemptedModels).toEqual(["claude-opus-4-5", "claude-opus-4-8"]);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it.each([
		401, 402, 429,
	])("blocks sibling-model slots after account-wide status %i", async (accountWideStatus) => {
		installUsageCollector();
		const shared = makeAccount(`shared-account-${accountWideStatus}`);
		const later = makeAccount(`later-account-${accountWideStatus}`);
		const combo: ComboWithSlots = {
			id: `combo-account-wide-${accountWideStatus}`,
			name: "Account-wide exclusion",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-shared-opus",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: shared.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-shared-sonnet",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: shared.id,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-z-later",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared, later], combo, (accounts) => accounts);
		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			return upstreamUrls.length === 1
				? new Response('{"error":"account-wide"}', {
						status: accountWideStatus,
						headers: { "content-type": "application/json" },
					})
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			`https://upstream.test/${shared.id}`,
			`https://upstream.test/${later.id}`,
		]);
	});

	it("deduplicates aliases that transform to the same physical model", async () => {
		installUsageCollector();
		const shared = makeAccount("mapped-shared");
		const later = makeAccount("mapped-later");
		const combo: ComboWithSlots = {
			id: "combo-mapped-aliases",
			name: "Mapped aliases",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-alias-opus",
					combo_id: "combo-mapped-aliases",
					account_id: shared.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-alias-sonnet",
					combo_id: "combo-mapped-aliases",
					account_id: shared.id,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-distinct",
					combo_id: "combo-mapped-aliases",
					account_id: later.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared, later], combo, (accounts) => accounts);
		ctx.provider.transformRequestBody = async (request, account) => {
			const body = (await request.json()) as Record<string, unknown>;
			body.model = account?.id === shared.id ? "grok-4.3" : "grok-4-fast";
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			});
		};
		const attempted: Array<{ account: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attempted.push({
				account: new URL(request.url).pathname.slice(1),
				model: ((await request.json()) as { model: string }).model,
			});
			return attempted.length === 1
				? outOfCreditsResponse()
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attempted).toEqual([
			{ account: shared.id, model: "grok-4.3" },
			{ account: later.id, model: "grok-4-fast" },
		]);
	});

	it("persists only completed upstream failures after duplicate skips", async () => {
		const handleStart = installUsageCollector();
		const repeated = makeAccount("metric-repeated");
		const later = makeAccount("metric-later");
		const combo: ComboWithSlots = {
			id: "combo-metric-duplicates",
			name: "Metric duplicates",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "metric-1",
					combo_id: "combo-metric-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "metric-duplicate",
					combo_id: "combo-metric-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "metric-success",
					combo_id: "combo-metric-duplicates",
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([repeated, later], combo, (accounts) => accounts);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return fetchCount === 1
				? new Response('{"error":"expired"}', { status: 401 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetchCount).toBe(2);
		expect(handleStart).toHaveBeenCalledTimes(1);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it("counts internal model fallback before post-combo normal account failover", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("internal-model-fallback");
		comboAccount.model_mappings = JSON.stringify({
			"claude-opus-4-5": ["claude-opus-4-5", "provider-opus-fallback"],
		});
		const normalAccount = makeAccount("normal-after-model-fallback");
		const combo: ComboWithSlots = {
			id: "combo-internal-model-fallback",
			name: "Internal model fallback",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-internal-model-fallback",
					combo_id: "combo-internal-model-fallback",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[comboAccount, normalAccount],
			combo,
			(accounts, meta) =>
				(
					meta as { routingCandidates?: readonly unknown[] }
				).routingCandidates?.some(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						"comboSlotId" in candidate &&
						candidate.comboSlotId !== null,
				)
					? accounts
					: [normalAccount],
		);
		const attempts: Array<{ account: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attempts.push({
				account: new URL(request.url).pathname.slice(1),
				model: ((await request.json()) as { model: string }).model,
			});
			return attempts.length < 3
				? new Response('{"error":"rate limited"}', { status: 429 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: comboAccount.id, model: "claude-opus-4-5" },
			{ account: comboAccount.id, model: "provider-opus-fallback" },
			{ account: normalAccount.id, model: "claude-opus-4-5" },
		]);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(2);
	});

	it("preserves the last upstream 529 when normal fallback only repeats the same physical route", async () => {
		installUsageCollector();
		const account = makeAccount("retained-529-account");
		const combo: ComboWithSlots = {
			id: "combo-retained-529",
			name: "Retained overload",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-529",
					combo_id: "combo-retained-529",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([account], combo, (accounts) => accounts);
		// Model the allowed race where cooldown persistence is still queued when
		// post-combo normal routing refreshes account rows from the database.
		ctx.dbOps.getAllAccounts = mock(async () => [
			{
				...account,
				rate_limited_until: null,
				rate_limited_at: null,
				consecutive_rate_limits: 0,
			},
		]);
		ctx.provider.parseRateLimit = (response) => ({
			isRateLimited: response.status === 529,
			resetTime: null,
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained",
					},
				},
			);
		}) as unknown as typeof fetch;

		const previousRetrySetting = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		try {
			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(fetchCount).toBe(1);
			expect(response.status).toBe(529);
			expect(response.headers.get("x-upstream-proof")).toBe("retained");
			expect(await response.json()).toEqual({
				type: "error",
				error: { type: "overloaded_error" },
			});
		} finally {
			if (previousRetrySetting === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = previousRetrySetting;
			}
		}
	});

	it("preserves a native xAI 402 when normal fallback only repeats the same physical route", async () => {
		installUsageCollector();
		const account = makeAccount("retained-xai-402-account");
		account.provider = "xai";
		account.custom_endpoint = null;
		account.model_mappings = null;
		const combo: ComboWithSlots = {
			id: "combo-retained-xai-402",
			name: "Retained xAI capacity",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-xai-402",
					combo_id: "combo-retained-xai-402",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([account], combo, (accounts) => accounts);
		ctx.dbOps.getAllAccounts = mock(async () => [
			{
				...account,
				rate_limited_until: null,
				rate_limited_at: null,
				consecutive_rate_limits: 0,
			},
		]);
		ctx.dbOps.markAccountRateLimited = mock(async () => 1);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"error":{"type":"rate_limit_error","message":"insufficient credits","code":"xai_402"}}',
				{
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-xai",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(402);
		expect(response.headers.get("x-upstream-proof")).toBe("retained-xai");
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "insufficient credits",
			},
		});
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
	});

	it("prefers a retained 529 when fallback accounts become reactively depleted before throttling", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("retained-529-reactive-combo");
		const depletedFallback = makeAccount("reactive-fallback");
		const combo: ComboWithSlots = {
			id: "combo-retained-529-reactive",
			name: "Retained overload before reactive terminal",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-529-reactive",
					combo_id: "combo-retained-529-reactive",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[comboAccount, depletedFallback],
			combo,
			(accounts, meta) => {
				const isComboPass = (
					meta as {
						routingCandidates?: readonly { comboSlotId?: string | null }[];
					}
				).routingCandidates?.some((candidate) => candidate.comboSlotId != null);
				if (isComboPass) return accounts;

				// Model a marker arriving after normal selection evaluated hard
				// capacity but before the outer proxy applies its final throttle pass.
				usageCache.markModelScopedExhausted(
					depletedFallback.id,
					"claude-opus-4-5",
					null,
					Date.now() + 60_000,
				);
				cachedUsageAccountIds.add(depletedFallback.id);
				return accounts.filter((account) => account.id === depletedFallback.id);
			},
		);
		ctx.provider.parseRateLimit = (response) => ({
			isRateLimited: response.status === 529,
			resetTime: null,
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error","message":"retained reactive proof"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-reactive-529",
					},
				},
			);
		}) as unknown as typeof fetch;

		const previousRetrySetting = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		try {
			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(fetchCount).toBe(1);
			expect(response.status).toBe(529);
			expect(response.headers.get("x-upstream-proof")).toBe(
				"retained-reactive-529",
			);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "overloaded_error",
					message: "retained reactive proof",
				},
			});
			expect(handleStart).toHaveBeenCalledTimes(1);
			expect(
				(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
					.failoverAttempts,
			).toBe(0);
		} finally {
			if (previousRetrySetting === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = previousRetrySetting;
			}
		}
	});

	it("prefers a retained native xAI 402 when every fallback account is predictively throttled", async () => {
		const handleStart = installUsageCollector();
		const xaiAccount = makeAccount("retained-xai-predictive-combo");
		xaiAccount.provider = "xai";
		xaiAccount.custom_endpoint = null;
		xaiAccount.model_mappings = null;
		const throttledFallback = makeAccount("predictive-fallback");
		const combo: ComboWithSlots = {
			id: "combo-retained-xai-predictive",
			name: "Retained xAI before predictive terminal",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-xai-predictive",
					combo_id: "combo-retained-xai-predictive",
					account_id: xaiAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[xaiAccount, throttledFallback],
			combo,
			(accounts, meta) =>
				(
					meta as {
						routingCandidates?: readonly { comboSlotId?: string | null }[];
					}
				).routingCandidates?.some((candidate) => candidate.comboSlotId != null)
					? accounts
					: accounts.filter((account) => account.id === throttledFallback.id),
		);
		ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
		ctx.dbOps.markAccountRateLimited = mock(async () => 1);
		usageCache.set(throttledFallback.id, {
			five_hour: {
				utilization: 80,
				resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: null },
		});
		cachedUsageAccountIds.add(throttledFallback.id);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"error":{"type":"rate_limit_error","message":"retained predictive proof","code":"xai_402"}}',
				{
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-predictive-xai",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(402);
		expect(response.headers.get("x-upstream-proof")).toBe(
			"retained-predictive-xai",
		);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "retained predictive proof",
			},
		});
		expect(handleStart).toHaveBeenCalledTimes(1);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(0);
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
	});
});
