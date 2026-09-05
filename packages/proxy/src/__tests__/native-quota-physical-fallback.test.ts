import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { getModelList } from "@better-ccflare/core";
import {
	getProvider,
	registerProvider,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboWithSlots,
} from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import type { UsageCollector } from "../usage-collector";
import * as usageCollectorModule from "../usage-collector";

const FABLE = "claude-fable-5";
const DATED_FABLE = "claude-fable-5-20260901";
const OPUS = "claude-opus-4-8";
const originalFetch = globalThis.fetch;
const originalProvider = getProvider("anthropic");
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	globalThis.fetch = originalFetch;
	if (originalProvider) registerProvider(originalProvider);
});

function nativePool() {
	const account = {
		id: "native-physical-account",
		name: "Native physical fallback",
		provider: "anthropic",
		api_key: null,
		access_token: "offline-token",
		refresh_token: "offline-refresh",
		expires_at: Date.now() + 3_600_000,
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
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: JSON.stringify({ [FABLE]: [DATED_FABLE, FABLE] }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	} satisfies Account;
	const combo: ComboWithSlots = {
		id: "native-physical-combo",
		name: "Native physical mappings",
		description: null,
		enabled: true,
		created_at: 0,
		updated_at: 0,
		slots: [FABLE, OPUS].map((model, index) => ({
			id: `native-physical-${index}`,
			combo_id: "native-physical-combo",
			account_id: account.id,
			model,
			priority: index * 10,
			enabled: true,
		})),
	};
	const anthropicDegradedMode = new AnthropicDegradedModeCoordinator({
		config: {
			mode: "off",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			evidenceWindowMs: 30_000,
			quorum: 2,
			retryMinMs: 5_000,
			retryFallbackMs: 10_000,
			retryMaxMs: 60_000,
			recoveryWindowMs: 30_000,
			probeLeaseMs: 600_000,
			maxCohorts: 1_024,
		},
	});
	const provider = {
		name: "anthropic",
		cacheReplayModelStrategy: "transformed-body" as const,
		canHandle: () => true,
		buildUrl: () => "https://api.anthropic.com/offline/physical-fallback",
		prepareHeaders: (headers: Headers) => new Headers(headers),
		transformRequestBody: async (request: Request) => {
			const body = await request.json();
			return new Request(request, {
				body: JSON.stringify({
					...body,
					model: getModelList(body.model, account)?.[0] ?? body.model,
				}),
			});
		},
		processResponse: async (response: Response) => response,
		parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		isStreamingResponse: () => false,
	};
	registerProvider(provider);
	const ctx = {
		anthropicDegradedMode,
		degradedOwnerOverlay: new DegradedOwnerOverlay({
			evidenceWindowMs: 30_000,
		}),
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAllAccounts: async () => [account],
			getComboRoutingPolicy: async (family: ComboFamily) => ({
				assignment: {
					family,
					combo_id: combo.id,
					enabled: true,
					membership_mode: "manual",
					managed_model: null,
					exhaustion_policy: "native_quota_wait",
				},
				combo,
				slots: combo.slots,
				rules: [],
				exclusions: [],
			}),
		},
		config: {
			getModelScopedCapacityRouting: () => "exhausted",
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => true,
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		},
		runtime: { port: 8080, clientId: "test" },
		provider,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => undefined },
	} as unknown as ProxyContext;
	const handleStart = mock(() => undefined);
	const collector = {
		handleStart,
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as UsageCollector;
	for (const name of ["getUsageCollector", "tryGetUsageCollector"] as const) {
		const spy = spyOn(usageCollectorModule, name).mockReturnValue(collector);
		cleanups.push(() => spy.mockRestore());
	}
	cleanups.push(() => usageCache.delete(account.id));
	const calls: string[] = [];
	const fetch = (respond: (model: string) => Response | Promise<Response>) => {
		globalThis.fetch = mock(async (request: Request) => {
			const { model } = await request.clone().json();
			calls.push(model);
			return await respond(model);
		}) as typeof globalThis.fetch;
	};
	const send = async (signal?: AbortSignal) => {
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: FABLE,
				messages: [{ role: "user", content: "offline fixture" }],
				max_tokens: 16,
			}),
			signal,
		});
		return await handleProxy(request, new URL(request.url), ctx);
	};
	return {
		account: account as Account,
		combo,
		ctx,
		provider,
		calls,
		handleStart,
		fetch,
		send,
	};
}

function missingModel() {
	return Response.json(
		{
			type: "error",
			error: { type: "not_found_error", message: "model not found" },
		},
		{ status: 404 },
	);
}

function success(model: string) {
	return Response.json({ type: "message", model, content: [] });
}

function putUsage(account: Account, fable = 20, shared = 20) {
	usageCache.set(account.id, {
		spend: { enabled: false },
		limits: [
			{
				kind: "session",
				percent: shared,
				is_active: true,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			{
				kind: "weekly_all",
				percent: 20,
				is_active: true,
				resets_at: new Date(Date.now() + 86_400_000).toISOString(),
			},
			{
				kind: "weekly_scoped",
				percent: fable,
				is_active: true,
				resets_at: new Date(Date.now() + 86_400_000).toISOString(),
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
			},
		],
	} as never);
}

function rateLimited() {
	return Response.json(
		{
			type: "error",
			error: { type: "rate_limit_error", message: "temporarily unavailable" },
		},
		{ status: 429 },
	);
}

describe("native quota physical model fallbacks", () => {
	it("tries the second configured native Fable model after the first returns 404", async () => {
		const pool = nativePool();
		pool.fetch((model) =>
			model === DATED_FABLE ? missingModel() : success(model),
		);
		const response = await pool.send();
		expect(response.status).toBe(200);
		expect((await response.json()).model).toBe(FABLE);
		expect(pool.calls).toEqual([DATED_FABLE, FABLE]);
		expect(pool.handleStart.mock.calls[0]?.[0]).toMatchObject({
			failoverAttempts: 1,
		});
	});

	it("keeps trying the healthy Fable tail on the next request while the first exact marker is active", async () => {
		const pool = nativePool();
		putUsage(pool.account);
		pool.fetch((model) =>
			model === DATED_FABLE ? rateLimited() : success(model),
		);
		expect((await pool.send()).status).toBe(200);
		expect(
			usageCache.getModelScopedExhaustion(pool.account.id, DATED_FABLE, null),
		).not.toBeNull();
		expect((await pool.send()).status).toBe(200);
		expect(pool.calls).toEqual([DATED_FABLE, FABLE, FABLE]);
	});

	it.each([
		"persisted",
		"during preparation",
	] as const)("skips a middle physical model blocked %s and reaches the healthy third model", async (timing) => {
		const pool = nativePool();
		const middleModel = "claude-fable-5-20260902";
		pool.account.model_mappings = JSON.stringify({
			[FABLE]: [DATED_FABLE, middleModel, FABLE],
		});
		const blockMiddle = () =>
			usageCache.markModelScopedExhausted(
				pool.account.id,
				middleModel,
				null,
				Date.now() + 60_000,
			);
		if (timing === "persisted") blockMiddle();
		registerProvider({
			...pool.provider,
			transformRequestBody: async (request: Request) => {
				const model = (await request.clone().json()).model;
				const transformed = await pool.provider.transformRequestBody(request);
				if (timing === "during preparation" && model === middleModel)
					blockMiddle();
				return transformed;
			},
		});
		pool.fetch((model) =>
			model === DATED_FABLE ? missingModel() : success(model),
		);
		const response = await pool.send();
		expect(response.status).toBe(200);
		expect((await response.json()).model).toBe(FABLE);
		expect(pool.calls).toEqual([DATED_FABLE, FABLE]);
	});

	it("keeps Opus locked after generic 429s exhaust both configured Fable models", async () => {
		const pool = nativePool();
		putUsage(pool.account);
		pool.fetch(() => rateLimited());
		const response = await pool.send();
		expect(response.status).toBe(529);
		expect(pool.calls).toEqual([DATED_FABLE, FABLE]);
		expect(
			usageCache.getFamilyScopedExhaustion(pool.account.id, FABLE),
		).toBeNull();
		expect(pool.account.rate_limited_until).toBeNull();
	});

	it("reaches a second member's distinct tail after its first physical model was already attempted", async () => {
		const pool = nativePool();
		const secondLogical = "claude-fable-5-20260831";
		const secondTail = "claude-fable-5-20260903";
		pool.combo.slots.splice(1, 0, {
			id: "native-physical-second-primary",
			combo_id: pool.combo.id,
			account_id: pool.account.id,
			model: secondLogical,
			priority: 0,
			enabled: true,
		});
		pool.account.model_mappings = JSON.stringify({
			[FABLE]: [DATED_FABLE, FABLE],
			[secondLogical]: [DATED_FABLE, secondTail],
		});
		pool.fetch((model) =>
			model === secondTail ? success(model) : missingModel(),
		);
		const response = await pool.send();
		expect(response.status).toBe(200);
		expect((await response.json()).model).toBe(secondTail);
		expect(pool.calls).toEqual([DATED_FABLE, FABLE, secondTail]);
	});

	it("preserves the bounded stale-token retry before trying a new physical model", async () => {
		const pool = nativePool();
		Object.assign(pool.ctx.dbOps, {
			getAccount: async () => pool.account,
			updateAccountTokensIfRefreshTokenMatches: async () => true,
		});
		registerProvider({
			...pool.provider,
			refreshToken: async () => ({
				accessToken: "offline-refreshed-token",
				refreshToken: "offline-refresh",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		pool.fetch((model) => {
			if (pool.calls.length === 1)
				return Response.json(
					{ error: { type: "authentication_error", message: "stale token" } },
					{ status: 401 },
				);
			return model === DATED_FABLE ? missingModel() : success(model);
		});
		const response = await pool.send();
		expect(response.status).toBe(200);
		expect(pool.calls).toEqual([DATED_FABLE, DATED_FABLE, FABLE]);
	});

	it("uses both physical Opus alternatives on the deferred lane only after own-account Fable proof", async () => {
		const pool = nativePool();
		const datedOpus = "claude-opus-4-8-20260901";
		pool.account.model_mappings = JSON.stringify({
			[FABLE]: [DATED_FABLE, FABLE],
			[OPUS]: [datedOpus, OPUS],
		});
		putUsage(pool.account);
		pool.fetch((model) => {
			if (model === DATED_FABLE) {
				putUsage(pool.account, 100);
				return rateLimited();
			}
			return model === datedOpus ? missingModel() : success(model);
		});
		const response = await pool.send();
		expect(response.status).toBe(200);
		expect((await response.json()).model).toBe(OPUS);
		expect(pool.calls).toEqual([DATED_FABLE, datedOpus, OPUS]);
	});

	it("waits when a shared window closes before the second Fable model", async () => {
		const pool = nativePool();
		putUsage(pool.account);
		pool.fetch(() => {
			putUsage(pool.account, 20, 100);
			return rateLimited();
		});
		const response = await pool.send();
		expect(response.status).toBe(429);
		expect((await response.json()).error.code).toBe("native_quota_wait");
		expect(pool.calls).toEqual([DATED_FABLE]);
	});

	it.each([
		"family",
		"endpoint",
	] as const)("blocks %s configuration drift during second-model preparation", async (drift) => {
		const pool = nativePool();
		let transforms = 0;
		registerProvider({
			...pool.provider,
			transformRequestBody: async (request: Request) => {
				const transformed = await pool.provider.transformRequestBody(request);
				if (++transforms === 2) {
					if (drift === "family") {
						pool.account.model_mappings = JSON.stringify({
							[FABLE]: [DATED_FABLE, OPUS],
						});
					} else {
						pool.account.custom_endpoint =
							"https://foreign.invalid/v1/messages";
					}
				}
				return transformed;
			},
		});
		pool.fetch((model) =>
			model === DATED_FABLE ? missingModel() : success(model),
		);
		const response = await pool.send();
		expect(transforms).toBe(2);
		expect(response.status).toBe(503);
		expect(response.headers.get("x-should-retry")).toBeNull();
		expect(pool.calls).toEqual([DATED_FABLE]);
	});

	it("blocks a foreign transport URL introduced while preparing the second model", async () => {
		const pool = nativePool();
		let transforms = 0;
		registerProvider({
			...pool.provider,
			transformRequestBody: async (request: Request) => {
				const transformed = await pool.provider.transformRequestBody(request);
				if (++transforms !== 2) return transformed;
				return new Request("https://foreign.invalid/v1/messages", {
					method: "POST",
					headers: transformed.headers,
					body: await transformed.text(),
				});
			},
		});
		pool.fetch((model) =>
			model === DATED_FABLE ? missingModel() : success(model),
		);
		const response = await pool.send();
		expect(response.status).toBe(503);
		expect(pool.calls).toEqual([DATED_FABLE]);
	});

	it("does not dispatch another physical model after cancellation", async () => {
		const pool = nativePool();
		const controller = new AbortController();
		pool.fetch(() => {
			controller.abort();
			return missingModel();
		});
		expect((await pool.send(controller.signal)).status).toBe(499);
		expect(pool.calls).toEqual([DATED_FABLE]);
	});

	it("ends routing when the first physical model succeeds", async () => {
		const pool = nativePool();
		pool.fetch(success);
		expect((await pool.send()).status).toBe(200);
		expect(pool.calls).toEqual([DATED_FABLE]);
	});

	it("keeps the physical attempt ceiling across configured model arrays", async () => {
		const pool = nativePool();
		const models = Array.from(
			{ length: 16 },
			(_, index) => `claude-fable-5-${20260901 + index}`,
		);
		pool.account.model_mappings = JSON.stringify({ [FABLE]: models });
		const accounts = [
			pool.account,
			...["second", "third"].map((id) => ({ ...pool.account, id })),
		];
		pool.ctx.dbOps.getAllAccounts = async () => accounts;
		pool.combo.slots = accounts.flatMap((account, index) =>
			[FABLE, OPUS].map((model, tier) => ({
				id: `native-physical-budget-${index}-${tier}`,
				combo_id: pool.combo.id,
				account_id: account.id,
				model,
				priority: tier * 10,
				enabled: true,
			})),
		);
		pool.fetch(missingModel);
		const response = await pool.send();
		expect(response.status).toBe(503);
		expect((await response.json()).error.code).toBe(
			"physical_attempt_budget_exhausted",
		);
		expect(pool.calls).toEqual([...models, ...models]);
	});
});
