/**
 * Coverage for combo-override model observability (the "Opus 5 incident"):
 * when managed combo routing rewrites a request's model via a combo slot's
 * modelOverride, requests.original_model/applied_model must be populated too
 * — previously only agent-interception ever wrote those fields, so a pure
 * combo rewrite silently persisted NOTHING and the policy downgrade was
 * invisible.
 *
 * These tests drive the REAL proxy.ts combo-routing pipeline (account
 * selection, per-slot model override, post-combo fallback) via handleProxy,
 * with the usage collector mocked so we can assert on the exact StartMessage
 * usage-collector.ts persists verbatim to requests.original_model /
 * requests.applied_model and exposes on the live summary event.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	ComboWithSlots,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";
import type { StartMessage } from "../worker-messages";

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
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
		...overrides,
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
	resetRateLimitProbeGatesForTests();
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
	synthetic = false,
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

describe("combo-override model observability", () => {
	it("persists original_model and applied_model for a pure combo rewrite (no agent involved)", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("pure-combo-account");
		const combo: ComboWithSlots = {
			id: "combo-pure-rewrite",
			name: "Pure rewrite",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-pure-rewrite",
					combo_id: "combo-pure-rewrite",
					account_id: comboAccount.id,
					// Deliberately different from the client-requested model so the
					// rewrite is real, not a same-model no-op.
					model: "claude-haiku-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([comboAccount], combo, (accounts) => accounts);
		globalThis.fetch = mock(
			async () =>
				new Response('{"type":"message","content":[]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5");
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		// The incident's exact scenario: before this change, only
		// agent-interception ever populated these fields, so a pure combo
		// override recorded NOTHING (both null/equal). usage-collector.ts
		// persists these verbatim to requests.original_model/applied_model.
		expect(startMessage.originalModel).toBe("claude-opus-4-5");
		expect(startMessage.appliedModel).toBe("claude-haiku-4-5");
		expect(startMessage.comboModelOverrideFrom).toBe("claude-opus-4-5");
		expect(startMessage.comboModelOverrideTo).toBe("claude-haiku-4-5");
	});

	it("attributes the combo override on the probe-gate-suppressed ungated retry", async () => {
		// Regression: when EVERY candidate is probe-gate suppressed, proxy.ts
		// retries the first account ungated rather than 503-ing. That retry
		// applies the combo slot's model override exactly like the main loop —
		// but it used to call modelFallbackPolicyFor() without the
		// comboModelOverrideFrom argument, so the 5th parameter fell back to its
		// `= null` default. The rewrite still reached upstream while being
		// recorded as "no override", hiding a real policy-driven model downgrade
		// from comboModelOverride attribution and from the drift alert — the
		// exact blindness this whole feature exists to remove.
		const handleStart = installUsageCollector();
		const now = Date.now();
		const comboAccount = makeAccount("probe-suppressed-combo-account", {
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});

		// Stand in for a concurrent request that already took this account's
		// single-flight probe lease: the cooldown has expired, so the account is
		// usable, but every candidate is now gate-suppressed — which is what
		// forces proxy.ts down the ungated-retry branch.
		expect(getRateLimitProbeAdmission(comboAccount)).toBe("admitted");

		const combo: ComboWithSlots = {
			id: "combo-probe-suppressed",
			name: "Probe suppressed",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-probe-suppressed",
					combo_id: "combo-probe-suppressed",
					account_id: comboAccount.id,
					// Differs from the requested model, so the override is real.
					model: "claude-haiku-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([comboAccount], combo, (accounts) => accounts);
		globalThis.fetch = mock(
			async () =>
				new Response('{"type":"message","content":[]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5");
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		// The override really was applied on this path...
		expect(startMessage.appliedModel).toBe("claude-haiku-4-5");
		// ...so it must be attributed here too, not silently nulled.
		expect(startMessage.comboModelOverrideFrom).toBe("claude-opus-4-5");
		expect(startMessage.comboModelOverrideTo).toBe("claude-haiku-4-5");
	});

	it("reflects the fallback attempt's model (absent) when all combo slots fail and the non-combo fallback succeeds", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("fails-combo-account");
		const normalAccount = makeAccount("fallback-normal-account");
		const combo: ComboWithSlots = {
			id: "combo-fails-then-fallback",
			name: "Fails then fallback",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-fails",
					combo_id: "combo-fails-then-fallback",
					account_id: comboAccount.id,
					// This override never reaches a successful upstream attempt.
					model: "claude-haiku-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
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
		const ctx = makeContext(
			[comboAccount, normalAccount],
			combo,
			strategySelect,
		);
		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(req.url);
			if (upstreamUrls.length === 1) {
				return new Response('{"error":"expired"}', { status: 401 });
			}
			return new Response('{"type":"message","content":[]}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5");
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			`https://upstream.test/${comboAccount.id}`,
			`https://upstream.test/${normalAccount.id}`,
		]);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		// Success-conditioning: the returned response came from the non-combo
		// fallback attempt (no override applied there), so applied_model must
		// NOT carry the combo slot's override model that failed on the FIRST
		// attempt — it must reflect "no rewrite happened" (null), not a stale
		// value from the failed slot.
		expect(startMessage.appliedModel).not.toBe("claude-haiku-4-5");
		expect(startMessage.appliedModel == null).toBe(true);
		expect(startMessage.originalModel == null).toBe(true);
		expect(startMessage.comboModelOverrideFrom == null).toBe(true);
		expect(startMessage.comboModelOverrideTo == null).toBe(true);
	});
});
