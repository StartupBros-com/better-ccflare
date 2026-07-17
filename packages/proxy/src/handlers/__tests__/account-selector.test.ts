import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { CacheAffinityOrderer } from "../../cache-affinity-orderer";
import {
	ForceRouteUnavailableError,
	getComboSlotInfo,
	getReactiveModelCapacityBlocker,
	getRoutingCapacityContext,
	resolveEffectiveModel,
	selectAccountsForRequest,
	setComboSlotInfo,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
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
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeCtx(
	opts: { accounts?: Account[]; activeCombo?: ComboWithSlots | null } = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

const cachedUsageAccountIds = new Set<string>();

function cacheUsage(accountId: string, data: unknown): void {
	usageCache.set(accountId, data as never);
	cachedUsageAccountIds.add(accountId);
}

afterEach(() => {
	for (const accountId of cachedUsageAccountIds) usageCache.delete(accountId);
	cachedUsageAccountIds.clear();
});

// ── setComboSlotInfo / getComboSlotInfo ───────────────────────────────────────

describe("setComboSlotInfo / getComboSlotInfo", () => {
	it("stores and retrieves combo slot info on a RequestMeta", () => {
		const meta = makeRequestMeta();
		const info = {
			comboName: "My Combo",
			slots: [{ accountId: "acc-1", modelOverride: "gpt-4" }],
		};
		setComboSlotInfo(meta, info);
		expect(getComboSlotInfo(meta)).toEqual(info);
	});

	it("returns null for a meta that was never set", () => {
		const meta = makeRequestMeta();
		expect(getComboSlotInfo(meta)).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setComboSlotInfo(meta1, {
			comboName: "Combo A",
			slots: [{ accountId: "a", modelOverride: "m" }],
		});
		expect(getComboSlotInfo(meta2)).toBeNull();
	});
});

// ── selectAccountsForRequest — forced account via header ──────────────────────

describe("selectAccountsForRequest — x-better-ccflare-account-id header", () => {
	it("returns exactly the forced account when the header matches", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-2");
	});

	it("fails closed when the forced account id is not found", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "nonexistent" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "nonexistent",
			reason: "not_found",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced account is paused", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced account is rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-rl" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-rl",
			reason: "rate_limited_or_unavailable",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced-account database lookup fails", async () => {
		const active = makeAccount({ id: "acc-active" });
		const ctx = makeCtx({ accounts: [active] });
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("database offline");
		});
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-forced",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-forced",
			reason: "lookup_failed",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

describe("selectAccountsForRequest — Grok cache-native ownership", () => {
	it("keeps the same owner when the configured strategy changes order", async () => {
		const a = makeAccount({ id: "xai-a", provider: "xai" });
		const b = makeAccount({ id: "xai-b", provider: "xai" });
		let reverse = false;
		const ctx = makeCtx({ accounts: [a, b] });
		ctx.strategy.select = mock(() => {
			reverse = !reverse;
			return reverse ? [a, b] : [b, a];
		});
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);

		const first = await selectAccountsForRequest(
			makeRequestMeta({
				xaiCacheNativeActive: true,
				cacheAffinityKey: "conversation",
			}),
			ctx,
		);
		const second = await selectAccountsForRequest(
			makeRequestMeta({
				xaiCacheNativeActive: true,
				cacheAffinityKey: "conversation",
			}),
			ctx,
		);

		expect(first[0]?.id).toBe("xai-a");
		expect(second[0]?.id).toBe("xai-a");
	});

	it("replaces combo ownership when a better slot tier becomes routable", async () => {
		const a = makeAccount({ id: "xai-a", provider: "xai" });
		const b = makeAccount({ id: "xai-b", provider: "xai" });
		const ctx = makeCtx({
			accounts: [a, b],
			activeCombo: makeCombo([
				{
					id: "slot-a",
					combo_id: "combo-1",
					account_id: "xai-a",
					model: "grok-a",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-b",
					combo_id: "combo-1",
					account_id: "xai-b",
					model: "grok-b",
					priority: 1,
					enabled: true,
				},
			]),
		});
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);
		const affinity = {
			xaiCacheNativeActive: true,
			cacheAffinityKey: "conversation",
		};

		await selectAccountsForRequest(
			makeRequestMeta(affinity),
			ctx,
			"claude-sonnet-4-5",
		);
		const reversedCombo = makeCombo([
			{
				id: "slot-b",
				combo_id: "combo-1",
				account_id: "xai-b",
				model: "grok-b",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-a",
				combo_id: "combo-1",
				account_id: "xai-a",
				model: "grok-a",
				priority: 1,
				enabled: true,
			},
		]);
		(
			ctx.dbOps.getActiveComboForFamily as ReturnType<typeof mock>
		).mockImplementation(async () => reversedCombo);
		const meta = makeRequestMeta(affinity);
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((account) => account.id)).toEqual(["xai-b", "xai-a"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: "xai-b",
				modelOverride: "grok-b",
			},
			{
				accountId: "xai-a",
				modelOverride: "grok-a",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-b",
				accountId: "xai-b",
				modelOverride: "grok-b",
				tier: 0,
				ordinal: 0,
			},
			{
				comboSlotId: "slot-a",
				accountId: "xai-a",
				modelOverride: "grok-a",
				tier: 1,
				ordinal: 1,
			},
		]);
	});

	it("reorders repeated-account xAI slots atomically by slot identity", async () => {
		const account = makeAccount({ id: "xai-a", provider: "xai" });
		const initialCombo = makeCombo([
			{
				id: "slot-opus",
				combo_id: "combo-1",
				account_id: account.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-fable",
				combo_id: "combo-1",
				account_id: account.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [account], activeCombo: initialCombo });
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);
		const affinity = {
			xaiCacheNativeActive: true,
			cacheAffinityKey: "repeated-slot-conversation",
		};

		await selectAccountsForRequest(
			makeRequestMeta(affinity),
			ctx,
			"claude-sonnet-4-5",
		);
		(
			ctx.dbOps.getActiveComboForFamily as ReturnType<typeof mock>
		).mockImplementation(async () =>
			makeCombo([initialCombo.slots[1], initialCombo.slots[0]]),
		);
		const meta = makeRequestMeta(affinity);
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((entry) => entry.id)).toEqual([account.id, account.id]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: account.id, modelOverride: "claude-opus-4-8" },
			{ accountId: account.id, modelOverride: "claude-fable-5" },
		]);
		expect(
			meta.routingCandidates?.map((candidate) => ({
				comboSlotId: candidate.comboSlotId,
				modelOverride: candidate.modelOverride,
				tier: candidate.tier,
				ordinal: candidate.ordinal,
			})),
		).toEqual([
			{
				comboSlotId: "slot-opus",
				modelOverride: "claude-opus-4-8",
				tier: 0,
				ordinal: 1,
			},
			{
				comboSlotId: "slot-fable",
				modelOverride: "claude-fable-5",
				tier: 0,
				ordinal: 0,
			},
		]);
	});
});

describe("selectAccountsForRequest — Grok cache-native force-route fail-closed", () => {
	it("throws when feature is active and forced xAI account is paused", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			provider: "xai",
			paused: true,
		});
		const activeAcc = makeAccount({
			id: "acc-active",
			name: "active",
			provider: "xai",
		});
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toBeInstanceOf(
			ForceRouteUnavailableError,
		);
	});

	it("fails closed for an unavailable custom-endpoint xAI account", async () => {
		const customAcc = makeAccount({
			id: "acc-custom",
			name: "custom",
			provider: "xai",
			custom_endpoint: "https://xai.internal.example/v1",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [customAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-custom",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-custom",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed for an unavailable non-xAI account", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			provider: "codex",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("still allows an authenticated scheduler probe for an official xAI account", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			provider: "xai",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx = makeCtx({ accounts: [rateLimitedAcc, activeAcc] });
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			trustedInternalAutoRefresh: true,
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-rl",
				"x-better-ccflare-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([rateLimitedAcc]);
	});

	it("remains fail-closed when the cache-native feature is off", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			provider: "xai",
			paused: true,
		});
		const activeAcc = makeAccount({
			id: "acc-active",
			name: "active",
			provider: "xai",
		});
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: false,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

// ── selectAccountsForRequest — combo routing ──────────────────────────────────

describe("selectAccountsForRequest — combo routing", () => {
	it("returns combo-ordered accounts when an active combo exists for the model family", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Both accounts should be returned in slot priority order
		expect(result.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("stores combo slot info on the RequestMeta when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-5");

		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo).not.toBeNull();
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.accountId).toBe("acc-1");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});

	it("sets meta.comboName when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-haiku-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-haiku-4-5");
		expect((meta as any).comboName).toBe("Test Combo");
	});

	it("performs one combo pass, then an explicit normal fallback without stale sidecar metadata", async () => {
		const comboAccount = makeAccount({ id: "acc-combo" });
		const normalAccount = makeAccount({ id: "acc-normal" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: comboAccount.id,
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [comboAccount, normalAccount],
			activeCombo: combo,
		});
		ctx.strategy.select = mock(() => [normalAccount]);
		const meta = makeRequestMeta();

		expect(
			(await selectAccountsForRequest(meta, ctx, "claude-opus-4-5")).map(
				(account) => account.id,
			),
		).toEqual([comboAccount.id]);
		expect(getComboSlotInfo(meta)?.comboName).toBe("Test Combo");
		meta.comboSlotIndex = 3;

		const fallback = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-opus-4-5",
			{ skipCombo: true },
		);

		expect(fallback.map((account) => account.id)).toEqual([normalAccount.id]);
		expect(ctx.dbOps.getActiveComboForFamily).toHaveBeenCalledTimes(1);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
		expect(getComboSlotInfo(meta)).toBeNull();
		expect(meta.comboName).toBeNull();
		expect(meta.comboSlotIndex).toBeNull();
	});

	it("skips disabled slots", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: false, // disabled
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("falls back to SessionStrategy when all combo slots are rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000, // rate limited for 1h
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = {
			strategy: {
				select: mock(() => [fallbackAcc]),
			},
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Should fall back to strategy result (fallbackAcc)
		expect(result[0]?.id).toBe("acc-fallback");
	});

	it("falls back to SessionStrategy when no combo is active for the model family", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc], activeCombo: null });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// No combo — strategy.select is used
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("falls back to normal routing when no model is provided", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo lookup for unknown model families", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		// A model that doesn't map to a known family
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"gpt-4-turbo-unknown",
		);
		// getActiveComboForFamily should not be called for unknown families
		const ctxAny = ctx as any;
		expect(ctxAny.dbOps.getActiveComboForFamily).not.toHaveBeenCalled();
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo slots that reference unknown accounts", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-ghost",
				combo_id: "combo-1",
				account_id: "acc-ghost", // does not exist in accounts list
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-real",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Ghost slot is skipped; only acc-1 is returned
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
	});
});

// ── selectAccountsForRequest — auto-refresh bypass for overage-paused accounts ─

describe("selectAccountsForRequest — trusted auto-refresh bypass", () => {
	/**
	 * The auto-refresh scheduler intentionally refreshes accounts that are paused
	 * due to auto_pause_on_overage. Only the authenticated in-process credential,
	 * not caller-controlled routing hints, may grant that narrow exception.
	 */
	it("rejects spoofed public auto-refresh headers for an overage-paused account", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-overage",
			reason: "paused",
		});
	});

	it("allows an authenticated internal probe through an overage pause", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const ctx = makeCtx({ accounts: [overagePausedAcc] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([overagePausedAcc]);
	});

	it("blocks an overage-paused account without trusted internal authentication", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				// Public traffic has no trustedInternalAutoRefresh bit.
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-overage",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("blocks a manually-paused account even for an authenticated internal probe", async () => {
		// A manual pause must win even when auto_pause_on_overage_enabled is set:
		// the auto-resume guard would never un-pause it, so admitting it on a
		// bypass-session force-route just produces an endless probe loop. Mirrors
		// the scheduler eligibility query and the sendDummyMessage resume guard.
		const manualPausedAcc = makeAccount({
			id: "acc-manual",
			name: "manual-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "manual",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [manualPausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-manual",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-manual",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("allows an authenticated internal probe through an account cooldown", async () => {
		// The scheduler probes rate-limited accounts to detect when the window has reset.
		// Without this fix the account selector falls through to SessionStrategy and routes
		// to a *different* account, corrupting the intended account's rate_limit_reset row.
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			paused: false,
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-rl",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Rate-limited account must be returned directly — bypass-session overrides the guard
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-rl");
	});

	it("blocks a failure-paused account even for an authenticated internal probe", async () => {
		// A failure-paused account: paused=true, auto_pause_on_overage_enabled=false
		const failurePausedAcc = makeAccount({
			id: "acc-broken",
			name: "failure-paused",
			paused: true,
			auto_pause_on_overage_enabled: false,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [failurePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-broken",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-broken",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

// ── selectAccountsForRequest — paused account handling ───────────────────────

describe("selectAccountsForRequest — paused accounts in combo", () => {
	it("excludes paused accounts from combo slot results", async () => {
		const pausedAcc = makeAccount({ id: "acc-paused", paused: true });
		const activeAcc = makeAccount({ id: "acc-active" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-paused",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-active",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({
			accounts: [pausedAcc, activeAcc],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-active"]);
	});
});

// ── resolveEffectiveModel ──────────────────────────────────────────────────────

describe("resolveEffectiveModel", () => {
	it("returns the applied model when the interceptor rewrote the request", () => {
		expect(resolveEffectiveModel("claude-opus-4-5", "claude-sonnet-4-5")).toBe(
			"claude-opus-4-5",
		);
	});

	it("falls back to the original request model when nothing was applied", () => {
		expect(resolveEffectiveModel(null, "claude-sonnet-4-5")).toBe(
			"claude-sonnet-4-5",
		);
		expect(resolveEffectiveModel(undefined, "claude-sonnet-4-5")).toBe(
			"claude-sonnet-4-5",
		);
	});

	it("returns null when neither an applied nor an original model is available", () => {
		expect(resolveEffectiveModel(null, null)).toBeNull();
		expect(resolveEffectiveModel(undefined, undefined)).toBeNull();
	});
});

// ── selectAccountsForRequest — routes on the post-rewrite (effective) model ────

describe("selectAccountsForRequest — routes on effective model, not the client's original model", () => {
	it("combo routing matches the applied model's family, not the original request's family", async () => {
		// Client requested a sonnet model, but the agent interceptor rewrote it
		// to an opus model (e.g. via an agent preference). Routing must pick
		// the combo for the *opus* family, mirroring what proxy.ts does by
		// calling selectAccountsForRequest with resolveEffectiveModel's result
		// instead of the raw client-requested model.
		const opusAcc = makeAccount({ id: "acc-opus" });
		const opusCombo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-opus",
				account_id: "acc-opus",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [opusAcc], activeCombo: opusCombo });
		const meta = makeRequestMeta();

		const originalModel = "claude-sonnet-4-5";
		const appliedModel = "claude-opus-4-5"; // simulates interceptor rewrite
		const effectiveModel = resolveEffectiveModel(appliedModel, originalModel);
		expect(effectiveModel).toBe("claude-opus-4-5");

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			effectiveModel ?? undefined,
		);

		expect(result.map((a) => a.id)).toEqual(["acc-opus"]);
		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});
});

// ── model-lane capacity planning ─────────────────────────────────────────────

describe("selectAccountsForRequest — model-lane hard capacity", () => {
	function weeklyScoped(
		displayName: string | null,
		percent = 100,
		resetAt = Date.now() + 60 * 60 * 1000,
	) {
		return {
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: new Date(resetAt).toISOString(),
					scope:
						displayName === null
							? null
							: {
									model: { id: null, display_name: displayName },
									surface: null,
								},
				},
			],
		};
	}

	it("excludes a Fable-full account before strategy selection but keeps it eligible for Opus", async () => {
		const preferred = makeAccount({ id: "capacity-preferred", priority: 0 });
		const fallback = makeAccount({ id: "capacity-fallback", priority: 1 });
		cacheUsage(preferred.id, weeklyScoped("Fable"));

		const strategy = mock((_accounts: Account[]) => [preferred, fallback]);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		ctx.strategy.select = strategy;
		const fableMeta = makeRequestMeta({ clientSessionId: "conversation-1" });

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5",
		);
		const candidatesSeenByStrategy = strategy.mock.calls[0]?.[0] as Account[];
		expect(candidatesSeenByStrategy.map((account) => account.id)).toEqual([
			fallback.id,
		]);
		// Defensive filtering still wins if a strategy returns an account that was
		// not present in its candidate input.
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(fableMeta.hardExcludedAccountIds?.has(preferred.id)).toBe(true);
		expect(fableMeta.routingCandidateCatalog).toMatchObject([
			{ accountId: preferred.id, tier: 0, comboSlotId: null },
			{ accountId: fallback.id, tier: 1, comboSlotId: null },
		]);

		const context = getRoutingCapacityContext(fableMeta);
		expect(context?.effectiveModel).toBe("claude-fable-5");
		expect(context?.exclusions).toHaveLength(1);
		expect(context?.exclusions[0]?.accountId).toBe(preferred.id);
		expect(context?.exclusions[0]?.modelFamily).toBe("fable");
		expect(context?.exclusions[0]?.exclusions[0]?.scope).toBe("family");
		expect(context?.blockedUntil).toBeGreaterThan(Date.now());

		strategy.mockClear();
		strategy.mockImplementation((_accounts: Account[]) => [
			preferred,
			fallback,
		]);
		const opus = await selectAccountsForRequest(
			makeRequestMeta({ clientSessionId: "conversation-1" }),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
		expect(
			((strategy.mock.calls[0]?.[0] ?? []) as Account[]).map(
				(account) => account.id,
			),
		).toEqual([preferred.id, fallback.id]);
	});

	it("fails open for a 100% weekly-scoped cap whose family is unknown", async () => {
		const account = makeAccount({ id: "capacity-unknown-scope" });
		cacheUsage(account.id, weeklyScoped(null));
		const ctx = makeCtx({ accounts: [account] });

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-fable-5",
		);

		expect(result).toEqual([account]);
	});

	it("fails a forced exhausted model lane closed without substituting another account", async () => {
		const forced = makeAccount({ id: "forced-capacity" });
		const substitute = makeAccount({ id: "forced-substitute" });
		cacheUsage(forced.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [forced, substitute] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": forced.id,
			}),
		});

		try {
			await selectAccountsForRequest(meta, ctx, "claude-fable-5");
			expect.unreachable("expected force-route capacity failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ForceRouteUnavailableError);
			expect((error as ForceRouteUnavailableError).accountId).toBe(forced.id);
			expect((error as ForceRouteUnavailableError).reason).toBe(
				"model_capacity_exhausted",
			);
		}
		expect(ctx.strategy.select).not.toHaveBeenCalled();
		expect(getRoutingCapacityContext(meta)?.exclusions[0]?.accountId).toBe(
			forced.id,
		);

		const opus = await selectAccountsForRequest(
			makeRequestMeta({
				headers: new Headers({
					"x-better-ccflare-account-id": forced.id,
				}),
			}),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus).toEqual([forced]);
	});

	it("still enforces hard model capacity for an authenticated internal probe", async () => {
		const forced = makeAccount({
			id: "forced-refresh-capacity",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		cacheUsage(forced.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [forced] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": forced.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-fable-5"),
		).rejects.toMatchObject({
			accountId: forced.id,
			reason: "model_capacity_exhausted",
		});
	});

	it("uses exact reactive model+beta evidence across normal routing and leaves Opus usable", async () => {
		const preferred = makeAccount({ id: "reactive-preferred", priority: 0 });
		const fallback = makeAccount({ id: "reactive-fallback", priority: 1 });
		usageCache.markModelScopedExhausted(
			preferred.id,
			"claude-fable-5",
			"beta-b,context-1m",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(preferred.id);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		const fableMeta = makeRequestMeta({
			headers: new Headers({
				"anthropic-beta": "CONTEXT-1M, beta-b",
			}),
		});

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5",
		);
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(
			getRoutingCapacityContext(fableMeta)?.exclusions[0]?.exclusions[0]
				?.source,
		).toBe("reactive_marker");

		const opus = await selectAccountsForRequest(
			makeRequestMeta({
				headers: new Headers({
					"anthropic-beta": "beta-b,context-1m",
				}),
			}),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
	});

	it("uses inferred family evidence for every Fable version while leaving Opus usable", async () => {
		const preferred = makeAccount({
			id: "reactive-family-preferred",
			priority: 0,
		});
		const fallback = makeAccount({
			id: "reactive-family-fallback",
			priority: 1,
		});
		usageCache.markFamilyScopedExhausted(
			preferred.id,
			"claude-fable-5",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(preferred.id);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		const fableMeta = makeRequestMeta();

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5-20260701",
		);
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(
			getRoutingCapacityContext(fableMeta)?.exclusions[0]?.exclusions[0],
		).toMatchObject({
			source: "reactive_marker",
			scope: "family",
			window: "reactive_family",
			modelFamily: "fable",
		});

		const opus = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
	});

	it("keeps exact model+beta evidence ahead of a matching family marker", () => {
		const accountId = "reactive-exact-precedence";
		const now = Date.now();
		usageCache.markModelScopedExhausted(
			accountId,
			"claude-fable-5",
			"beta-a",
			now + 30_000,
		);
		usageCache.markFamilyScopedExhausted(
			accountId,
			"claude-fable-5",
			now + 60_000,
		);
		cachedUsageAccountIds.add(accountId);

		expect(
			getReactiveModelCapacityBlocker(
				accountId,
				"claude-fable-5",
				"beta-a",
				now,
			),
		).toMatchObject({
			scope: "model",
			window: "reactive_model",
			evidenceExpiresAt: now + 30_000,
		});
	});

	it("preserves legacy selection when no concrete model is available", async () => {
		const account = makeAccount({ id: "capacity-no-model" });
		cacheUsage(account.id, {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: new Date(Date.now() + 60_000).toISOString(),
					scope: null,
				},
			],
		});
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		expect(await selectAccountsForRequest(meta, ctx)).toEqual([account]);
		expect(meta.hardExcludedAccountIds).toBeNull();
		expect(meta.affinityLaneKey).toBeNull();
	});
});

describe("selectAccountsForRequest — lane identity and quota pressure", () => {
	function weeklyAll(
		percent: number,
		hoursUntilReset: number,
	): Record<string, unknown> {
		return {
			limits: [
				{
					kind: "weekly_all",
					percent,
					resets_at: new Date(
						Date.now() + hoursUntilReset * 60 * 60 * 1000,
					).toISOString(),
					scope: null,
				},
			],
		};
	}

	it("isolates Fable and Opus affinity while canonicalizing client beta order", async () => {
		const account = makeAccount({ id: "lane-account" });
		const ctx = makeCtx({ accounts: [account] });
		const fableA = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "context-1m, beta-b,context-1m",
			}),
		});
		const fableB = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "BETA-B, context-1m",
			}),
		});
		const opus = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "context-1m,beta-b",
			}),
		});

		await selectAccountsForRequest(fableA, ctx, "claude-fable-5");
		await selectAccountsForRequest(fableB, ctx, "claude-fable-5");
		await selectAccountsForRequest(opus, ctx, "claude-opus-4-8");

		expect(fableA.affinityLaneKey).toBe(fableB.affinityLaneKey);
		expect(fableA.affinityLaneKey).not.toBe(opus.affinityLaneKey);
		expect(fableA.affinityLaneKey).toContain("/v1/messages");
		expect(fableA.affinityLaneKey).toContain("fable");
	});

	it("derives comparable quota metadata for OAuth subscription accounts with null billing_type", async () => {
		const urgent = makeAccount({
			id: "pressure-urgent",
			priority: 0,
			billing_type: null,
			refresh_token: "oauth-token-a",
		});
		const steady = makeAccount({
			id: "pressure-steady",
			priority: 0,
			billing_type: null,
			refresh_token: "oauth-token-b",
		});
		cacheUsage(urgent.id, weeklyAll(90, 2));
		cacheUsage(steady.id, weeklyAll(50, 200));
		const ctx = makeCtx({ accounts: [urgent, steady] });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		const urgentPressure = meta.quotaPressureByAccountId?.get(urgent.id);
		const steadyPressure = meta.quotaPressureByAccountId?.get(steady.id);
		expect(urgentPressure?.band).toBe("critical");
		expect(steadyPressure?.band).toBe("steady");
		expect(urgentPressure?.comparisonKey).not.toBeNull();
		expect(urgentPressure?.comparisonKey).toBe(steadyPressure?.comparisonKey);
	});

	it("does not invent a pressure comparison class for an unclassified API-key account", async () => {
		const account = makeAccount({
			id: "pressure-api-unknown",
			billing_type: null,
			refresh_token: "",
			api_key: "secret",
		});
		cacheUsage(account.id, weeklyAll(80, 20));
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(
			meta.quotaPressureByAccountId?.get(account.id)?.comparisonKey,
		).toBeNull();
	});
});

describe("selectAccountsForRequest — atomic combo capacity", () => {
	it("removes only an exhausted duplicate-account slot and keeps each model sidecar aligned", async () => {
		const preferred = makeAccount({ id: "combo-preferred", priority: 0 });
		const fallback = makeAccount({ id: "combo-fallback", priority: 1 });
		cacheUsage(preferred.id, {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: {
						model: { id: null, display_name: "Fable" },
						surface: null,
					},
				},
			],
		});
		const combo = makeCombo([
			{
				id: "slot-preferred-fable",
				combo_id: "combo-1",
				account_id: preferred.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-preferred-opus",
				combo_id: "combo-1",
				account_id: preferred.id,
				model: "claude-opus-4-8",
				priority: 1,
				enabled: true,
			},
			{
				id: "slot-fallback-fable",
				combo_id: "combo-1",
				account_id: fallback.id,
				model: "claude-fable-5",
				priority: 2,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [preferred, fallback],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: preferred.id,
				modelOverride: "claude-opus-4-8",
			},
			{
				accountId: fallback.id,
				modelOverride: "claude-fable-5",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-preferred-opus",
				accountId: preferred.id,
				modelOverride: "claude-opus-4-8",
				tier: 1,
				ordinal: 1,
			},
			{
				comboSlotId: "slot-fallback-fable",
				accountId: fallback.id,
				modelOverride: "claude-fable-5",
				tier: 2,
				ordinal: 2,
			},
		]);
		expect(getRoutingCapacityContext(meta)?.exclusions).toMatchObject([
			{
				accountId: preferred.id,
				model: "claude-fable-5",
				modelFamily: "fable",
			},
		]);
	});

	it("uses slot priority and repository order independently of account priority", async () => {
		const accountHigh = makeAccount({ id: "combo-account-high", priority: 9 });
		const accountLow = makeAccount({ id: "combo-account-low", priority: 0 });
		const combo = makeCombo([
			{
				id: "slot-high-late-tier",
				combo_id: "combo-1",
				account_id: accountHigh.id,
				model: "claude-opus-4-8",
				priority: 2,
				enabled: true,
			},
			{
				id: "slot-low-first-in-tier",
				combo_id: "combo-1",
				account_id: accountLow.id,
				model: "claude-opus-4-8",
				priority: 1,
				enabled: true,
			},
			{
				id: "slot-high-second-in-tier",
				combo_id: "combo-1",
				account_id: accountHigh.id,
				model: "claude-opus-4-5",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [accountHigh, accountLow],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map((account) => account.id)).toEqual([
			accountLow.id,
			accountHigh.id,
			accountHigh.id,
		]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: accountLow.id,
				modelOverride: "claude-opus-4-8",
			},
			{
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-5",
			},
			{
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-8",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-low-first-in-tier",
				accountId: accountLow.id,
				modelOverride: "claude-opus-4-8",
				tier: 1,
				ordinal: 1,
			},
			{
				comboSlotId: "slot-high-second-in-tier",
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-5",
				tier: 1,
				ordinal: 2,
			},
			{
				comboSlotId: "slot-high-late-tier",
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-8",
				tier: 2,
				ordinal: 0,
			},
		]);
	});

	it("uses only same-family quota pressure inside an equal slot tier", async () => {
		const expiringFable = makeAccount({
			id: "combo-expiring-fable",
			priority: 99,
		});
		const expiringOpus = makeAccount({
			id: "combo-expiring-opus",
			priority: 0,
		});
		const resetAt = (hours: number) =>
			new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
		const scoped = (displayName: string, percent: number, hours: number) => ({
			kind: "weekly_scoped",
			percent,
			resets_at: resetAt(hours),
			scope: {
				model: { id: null, display_name: displayName },
				surface: null,
			},
		});
		cacheUsage(expiringFable.id, {
			limits: [scoped("Fable", 90, 2), scoped("Opus", 10, 200)],
		});
		cacheUsage(expiringOpus.id, {
			limits: [scoped("Fable", 50, 200), scoped("Opus", 90, 2)],
		});
		const combo = makeCombo([
			{
				id: "slot-opus-pressure-first",
				combo_id: "combo-1",
				account_id: expiringOpus.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-fable-pressure-second",
				combo_id: "combo-1",
				account_id: expiringFable.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [expiringFable, expiringOpus],
			activeCombo: combo,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-fable-5",
		);

		// Fable pressure outranks repository order. Account.priority and the
		// opposite Opus scoped pressure must not participate in this lane.
		expect(result.map((account) => account.id)).toEqual([
			expiringFable.id,
			expiringOpus.id,
		]);
	});
});
