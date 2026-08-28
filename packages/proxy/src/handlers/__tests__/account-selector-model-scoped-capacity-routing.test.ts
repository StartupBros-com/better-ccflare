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
