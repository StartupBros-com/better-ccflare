import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const { usageCache } = await import("@better-ccflare/providers");
const {
	getCapacityDeferredModelRoutes,
	getComboSlotInfo,
	getNativeQuotaContext,
	getRoutingCapacityContext,
	selectAccountsForRequest,
} = await import("../account-selector");

type CapacityMode = "off" | "exhausted";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
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
		id: "request-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeCombo(accountId: string): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Fable Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: [
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: accountId,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		],
	};
}

function makeCtx(input: {
	accounts: Account[];
	mode?: CapacityMode;
	combo?: ComboWithSlots | null;
}): ProxyContext {
	return {
		strategy: {
			select: mock((accounts: Account[]) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => input.accounts),
			getActiveComboForFamily: mock(async () => input.combo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getCombosEnabled: () => true,
			...(input.mode === undefined
				? {}
				: { getModelScopedCapacityRouting: () => input.mode }),
		},
	} as unknown as ProxyContext;
}

const cachedAccountIds = new Set<string>();

function cacheUsage(accountId: string, data: unknown): void {
	usageCache.set(accountId, data as never);
	cachedAccountIds.add(accountId);
}

function weeklyScoped(displayName: string): Record<string, unknown> {
	return {
		spend: { enabled: false },
		limits: [
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				scope: {
					model: { id: null, display_name: displayName },
					surface: null,
				},
			},
		],
	};
}

function sessionExhausted(): Record<string, unknown> {
	return {
		limits: [
			{
				kind: "session",
				percent: 100,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				is_active: true,
			},
		],
	};
}

afterEach(() => {
	for (const accountId of cachedAccountIds) usageCache.delete(accountId);
	cachedAccountIds.clear();
});

describe("selectAccountsForRequest — model-scoped capacity routing", () => {
	it("suppresses family snapshot blockers only while mode is off", async () => {
		const off = makeAccount({ id: "snapshot-off" });
		const exhausted = makeAccount({ id: "snapshot-exhausted" });
		cacheUsage(off.id, weeklyScoped("Fable"));
		cacheUsage(exhausted.id, weeklyScoped("Fable"));

		const offResult = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts: [off], mode: "off" }),
			"claude-fable-5",
		);
		const exhaustedMeta = makeRequestMeta();
		const exhaustedResult = await selectAccountsForRequest(
			exhaustedMeta,
			makeCtx({ accounts: [exhausted], mode: "exhausted" }),
			"claude-fable-5",
		);

		expect(offResult).toEqual([off]);
		expect(exhaustedResult).toEqual([]);
		expect(getRoutingCapacityContext(exhaustedMeta)?.exclusions).toMatchObject([
			{ accountId: exhausted.id, exclusions: [{ scope: "family" }] },
		]);
	});

	it("suppresses reactive model blockers only while mode is off", async () => {
		const off = makeAccount({ id: "reactive-off" });
		const exhausted = makeAccount({ id: "reactive-exhausted" });
		usageCache.markModelScopedExhausted(
			off.id,
			"claude-fable-5",
			"",
			Date.now() + 60_000,
		);
		usageCache.markModelScopedExhausted(
			exhausted.id,
			"claude-fable-5",
			"",
			Date.now() + 60_000,
		);
		cachedAccountIds.add(off.id);
		cachedAccountIds.add(exhausted.id);

		const offResult = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts: [off], mode: "off" }),
			"claude-fable-5",
		);
		const exhaustedResult = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts: [exhausted], mode: "exhausted" }),
			"claude-fable-5",
		);

		expect(offResult).toEqual([off]);
		expect(exhaustedResult).toEqual([]);
	});

	it("keeps account-wide snapshot blockers active while mode is off", async () => {
		const account = makeAccount({ id: "account-wide-off" });
		cacheUsage(account.id, sessionExhausted());
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account], mode: "off" }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(getRoutingCapacityContext(meta)?.exclusions).toMatchObject([
			{ accountId: account.id, exclusions: [{ scope: "account" }] },
		]);
	});

	it("defaults incomplete config doubles to off without bypassing account-wide blockers", async () => {
		const modelScoped = makeAccount({ id: "incomplete-config-model-scoped" });
		const accountWide = makeAccount({ id: "incomplete-config-account-wide" });
		cacheUsage(modelScoped.id, weeklyScoped("Fable"));
		cacheUsage(accountWide.id, sessionExhausted());
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [modelScoped, accountWide] }),
			"claude-fable-5",
		);

		expect(result).toEqual([modelScoped]);
		expect(getRoutingCapacityContext(meta)?.exclusions).toMatchObject([
			{ accountId: accountWide.id, exclusions: [{ scope: "account" }] },
		]);
	});

	it("keeps protected exact routes fail-closed for family snapshot blockers while mode is off", async () => {
		const account = makeAccount({ id: "forced-family-off" });
		cacheUsage(account.id, weeklyScoped("Fable"));

		await expect(
			selectAccountsForRequest(
				makeRequestMeta({
					headers: new Headers({
						"x-better-ccflare-account-id": account.id,
					}),
				}),
				makeCtx({ accounts: [account], mode: "off" }),
				"claude-fable-5",
			),
		).rejects.toMatchObject({
			accountId: account.id,
			reason: "model_capacity_exhausted",
		});
	});

	it("suppresses family snapshot blockers for capability routes while mode is off", async () => {
		const account = makeAccount({
			id: "capability-off",
			model_mappings: JSON.stringify({ fable: ["claude-fable-5"] }),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		const meta = makeRequestMeta({
			routeProfileId: "capability-profile",
			routeProfileSelection: "capability",
			routeExpectedProvider: "anthropic",
			routeProfileExpectedPhysicalModel: "claude-fable-5",
			routeProfileLogicalModel: "claude-fable-5",
		});

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account], mode: "off" }),
			"claude-fable-5",
		);

		expect(result).toEqual([account]);
	});

	it("uses the same mode authority for combo and mapped fallback lanes", async () => {
		const comboAccount = makeAccount({ id: "combo-off" });
		cacheUsage(comboAccount.id, weeklyScoped("Fable"));
		const comboMeta = makeRequestMeta();

		const comboResult = await selectAccountsForRequest(
			comboMeta,
			makeCtx({
				accounts: [comboAccount],
				mode: "off",
				combo: makeCombo(comboAccount.id),
			}),
			"claude-fable-5",
		);

		expect(comboResult).toEqual([comboAccount]);
		expect(getComboSlotInfo(comboMeta)?.slots).toEqual([
			{ accountId: comboAccount.id, modelOverride: "claude-fable-5" },
		]);

		const fallbackAccount = makeAccount({
			id: "fallback-exhausted",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(fallbackAccount.id, weeklyScoped("Fable"));
		const fallbackMeta = makeRequestMeta({
			agentUsed: "capacity-routing-test-agent",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "claude-fable-5",
		});

		const fallbackResult = await selectAccountsForRequest(
			fallbackMeta,
			makeCtx({ accounts: [fallbackAccount], mode: "exhausted" }),
			"claude-fable-5",
		);

		expect(fallbackResult).toEqual([]);
		expect(getCapacityDeferredModelRoutes(fallbackMeta)).toMatchObject([
			{ account: fallbackAccount, model: "claude-opus-4-8" },
		]);
	});
});

describe("native quota wait combo isolation", () => {
	function nativeSetup(accounts: Account[]) {
		const combo = makeCombo(accounts[0]?.id ?? "missing");
		combo.slots = accounts.flatMap((account, index) => [
			{
				id: `native-primary-${index}`,
				combo_id: combo.id,
				account_id: account.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: `native-backup-${index}`,
				combo_id: combo.id,
				account_id: account.id,
				model: "claude-opus-4-8",
				priority: 10,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts, combo, mode: "exhausted" });
		ctx.config.getComboSessionFallback = () => true;
		ctx.dbOps.getComboRoutingPolicy = mock(async () => ({
			assignment: {
				family: "fable",
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
		}));
		return { ctx, combo };
	}

	function familyUsage(
		accountId: string,
		percent = 100,
		sharedPercent = 10,
	): void {
		cacheUsage(accountId, {
			spend: { enabled: false },
			limits: [
				{
					kind: "session",
					percent: sharedPercent,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_all",
					percent: 10,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					is_active: true,
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
				},
			],
		});
	}

	it("keeps all configured backups locked while any primary Fable allowance is usable", async () => {
		const first = makeAccount({ id: "native-primary-used" });
		const second = makeAccount({ id: "native-primary-ready" });
		familyUsage(first.id);
		familyUsage(second.id, 30);
		const { ctx } = nativeSetup([first, second]);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[second],
		);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.modelOverride),
		).toEqual(["claude-fable-5"]);
		expect(meta.routingCandidateCatalog).toHaveLength(4);
		expect(
			meta.routingCandidateCatalog?.filter((candidate) => candidate.tier === 0),
		).toHaveLength(2);
	});

	it("uses Opus B when A retains Fable allowance but its shared window is exhausted", async () => {
		const first = makeAccount({ id: "native-shared-a" });
		const second = makeAccount({ id: "native-proven-b" });
		familyUsage(first.id, 51, 100);
		familyUsage(second.id, 100, 20);
		const { ctx } = nativeSetup([first, second]);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[second],
		);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.modelOverride),
		).toEqual(["claude-opus-4-8"]);
	});

	it("preserves Fable priority against a strategy returning backup-first order", async () => {
		const first = makeAccount({ id: "native-order-a" });
		const second = makeAccount({ id: "native-order-b" });
		familyUsage(first.id, 51, 20);
		familyUsage(second.id, 100, 20);
		const { ctx } = nativeSetup([first, second]);
		ctx.strategy.select = mock((accounts: Account[]) => accounts.toReversed());
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[first],
		);
		expect(meta.routingCandidates?.[0]?.modelOverride).toBe("claude-fable-5");
	});

	it("admits each same-pool Opus route when its own primary account proves family exhaustion", async () => {
		const accounts = [
			makeAccount({ id: "native-used-a" }),
			makeAccount({ id: "native-used-b" }),
		];
		for (const account of accounts) familyUsage(account.id);
		const { ctx } = nativeSetup(accounts);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			accounts,
		);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.modelOverride),
		).toEqual(["claude-opus-4-8", "claude-opus-4-8"]);
	});

	it("does not let a different account cooldown veto proven same-account Opus", async () => {
		const first = makeAccount({ id: "native-cooldown-used" });
		const second = makeAccount({
			id: "native-cooldown-ready",
			rate_limited_until: Date.now() + 60_000,
		});
		familyUsage(first.id);
		familyUsage(second.id, 30);
		const { ctx } = nativeSetup([first, second]);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[first],
		);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.modelOverride),
		).toEqual(["claude-opus-4-8"]);
		expect(meta.comboName).toBe("Fable Combo");
	});

	it("keeps mixed shared and family blockers owned by the combo instead of session fallback", async () => {
		const first = makeAccount({ id: "native-mixed-used" });
		const second = makeAccount({ id: "native-mixed-shared" });
		familyUsage(first.id);
		cacheUsage(second.id, sessionExhausted());
		const { ctx } = nativeSetup([first, second]);
		const unrelated = makeAccount({ id: "native-unrelated" });
		ctx.dbOps.getAllAccounts = mock(async () => [first, second, unrelated]);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[first],
		);
		expect(getComboSlotInfo(meta)).toEqual({
			comboName: "Fable Combo",
			slots: [{ accountId: first.id, modelOverride: "claude-opus-4-8" }],
		});
	});

	it("fails closed on opted-in cross-provider shape while leaving explicit force routes alone", async () => {
		const account = makeAccount({
			id: "native-invalid",
			provider: "openrouter",
			api_key: "offline-test",
		});
		const { ctx } = nativeSetup([account]);
		const meta = makeRequestMeta();
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[],
		);
		expect(meta.comboName).toBe("Fable Combo");
		const forced = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": account.id }),
		});
		expect(
			await selectAccountsForRequest(forced, ctx, "claude-fable-5"),
		).toEqual([account]);
		expect(forced.comboName).toBeNull();
	});

	it("does not opt a non-Claude substring model into native quota isolation", async () => {
		const { ctx } = nativeSetup([makeAccount({ id: "native-nonclaude" })]);
		const meta = makeRequestMeta();
		await selectAccountsForRequest(meta, ctx, "vendor-fable-custom");
		expect(getNativeQuotaContext(meta)).toBeNull();
	});

	it("leaves explicit profiles and globally disabled combos outside native isolation", async () => {
		const account = makeAccount({ id: "native-explicit" });
		const { ctx } = nativeSetup([account]);
		const profileMeta = makeRequestMeta({
			routeProfileId: "explicit-native",
			forcedAccountId: account.id,
		});
		expect(
			await selectAccountsForRequest(profileMeta, ctx, "claude-fable-5"),
		).toEqual([account]);
		expect(getNativeQuotaContext(profileMeta)).toBeNull();
		ctx.config.getCombosEnabled = () => false;
		const disabledMeta = makeRequestMeta();
		await selectAccountsForRequest(disabledMeta, ctx, "claude-fable-5");
		expect(getNativeQuotaContext(disabledMeta)).toBeNull();
	});

	it("snaps back to Fable after refreshed usage recovers without dropping the primary catalog", async () => {
		const account = makeAccount({ id: "native-reset" });
		const { ctx } = nativeSetup([account]);
		familyUsage(account.id);
		const before = makeRequestMeta();
		await selectAccountsForRequest(before, ctx, "claude-fable-5");
		expect(before.routingCandidates?.[0]?.modelOverride).toBe(
			"claude-opus-4-8",
		);
		familyUsage(account.id, 0);
		const after = makeRequestMeta();
		await selectAccountsForRequest(after, ctx, "claude-fable-5");
		expect(
			after.routingCandidates?.map((candidate) => candidate.modelOverride),
		).toEqual(["claude-fable-5"]);
		expect(after.routingCandidateCatalog).toHaveLength(2);
	});
});
