import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const { usageCache } = await import("@better-ccflare/providers");
const { selectAccountsForRequest } = await import("../account-selector");

const originalFetch = globalThis.fetch;
const MODEL = "gpt-6";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-drain-1",
		name: "codex",
		provider: "codex",
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

function makeMeta(headers: Record<string, string> = {}): RequestMeta {
	return {
		id: "request-1",
		method: "POST",
		path: "/v1/responses",
		timestamp: Date.now(),
		headers: new Headers(headers),
	};
}

function makeCtx(accounts: Account[]): ProxyContext {
	return {
		strategy: { select: mock((a: Account[]) => a) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getCombosEnabled: () => false },
	} as unknown as ProxyContext;
}

function exhaustedBody(credits: Record<string, unknown>) {
	const reset_at = Math.floor(Date.now() / 1000) + 3600;
	return {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, reset_at },
			secondary_window: { used_percent: 100, reset_at },
		},
		credits,
	};
}

const touched = new Set<string>();

/** A real owned poll: the only source of credit evidence. */
async function ownedPoll(accountId: string, credits: Record<string, unknown>) {
	touched.add(accountId);
	globalThis.fetch = (async () =>
		Response.json(exhaustedBody(credits))) as typeof fetch;
	await new Promise<void>((resolve) => {
		usageCache.startPolling(
			accountId,
			"fake-token",
			"codex",
			60_000,
			undefined,
			undefined,
			undefined,
			() => resolve(),
		);
	});
}

afterEach(() => {
	for (const id of touched) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
	touched.clear();
	globalThis.fetch = originalFetch;
});

const CREDITS = { has_credits: true, unlimited: false, balance: "10" };

describe("selectAccountsForRequest — Codex credit drain", () => {
	it("excludes a spent codex account by default (drain off, credits present)", async () => {
		const account = makeAccount({ id: "drain-off" });
		await ownedPoll(account.id, CREDITS);
		const result = await selectAccountsForRequest(
			makeMeta(),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([]);
	});

	it("selects a spent codex account with drain on and owned credit evidence", async () => {
		const account = makeAccount({
			id: "drain-on",
			codex_credit_drain_enabled: true,
		});
		await ownedPoll(account.id, CREDITS);
		const result = await selectAccountsForRequest(
			makeMeta(),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([account]);
	});

	it("selects the forced account without account_capacity_exhausted", async () => {
		const account = makeAccount({
			id: "drain-forced",
			codex_credit_drain_enabled: true,
		});
		await ownedPoll(account.id, CREDITS);
		const result = await selectAccountsForRequest(
			makeMeta({ "x-better-ccflare-account-id": account.id }),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([account]);
	});

	it("still fails a forced route closed when drain is off", async () => {
		const account = makeAccount({ id: "drain-forced-off" });
		await ownedPoll(account.id, CREDITS);
		await expect(
			selectAccountsForRequest(
				makeMeta({ "x-better-ccflare-account-id": account.id }),
				makeCtx([account]),
				MODEL,
			),
		).rejects.toMatchObject({ accountId: account.id });
	});

	it("excludes when drain is on but the poll says no credits", async () => {
		const account = makeAccount({
			id: "drain-no-credits",
			codex_credit_drain_enabled: true,
		});
		await ownedPoll(account.id, {
			has_credits: false,
			unlimited: false,
			balance: 12,
		});
		const result = await selectAccountsForRequest(
			makeMeta(),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([]);
	});

	it("excludes when drain is on but there is no evidence at all", async () => {
		const account = makeAccount({
			id: "drain-no-evidence",
			codex_credit_drain_enabled: true,
		});
		touched.add(account.id);
		usageCache.set(account.id, {
			five_hour: {
				utilization: 100,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			seven_day: {
				utilization: 100,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
		} as never);
		const result = await selectAccountsForRequest(
			makeMeta(),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([]);
	});

	it("excludes when drain is on and only a passive usageCache.set payload claims credits", async () => {
		const account = makeAccount({
			id: "drain-passive-only",
			codex_credit_drain_enabled: true,
		});
		touched.add(account.id);
		const resets_at = new Date(Date.now() + 3_600_000).toISOString();
		usageCache.set(account.id, {
			five_hour: { utilization: 100, resets_at },
			seven_day: { utilization: 100, resets_at },
			credits: { has_credits: true, unlimited: true, balance: 99 },
			codex_subscription: { hasCredits: true, unlimited: true },
		} as never);
		const result = await selectAccountsForRequest(
			makeMeta(),
			makeCtx([account]),
			MODEL,
		);
		expect(result).toEqual([]);
	});

	/**
	 * Polls stopped succeeding but traffic keeps going: response headers keep
	 * the usage snapshot fresh at 100% while the owned credit evidence ages.
	 */
	async function selectAfterPassiveWrite(id: string, elapsedMs: number) {
		const account = makeAccount({ id, codex_credit_drain_enabled: true });
		await ownedPoll(account.id, CREDITS);
		const realNow = Date.now;
		Date.now = () => realNow() + elapsedMs;
		try {
			const resets_at = new Date(Date.now() + 3_600_000).toISOString();
			usageCache.set(account.id, {
				five_hour: { utilization: 100, resets_at },
				seven_day: { utilization: 100, resets_at },
			} as never);
			const result = await selectAccountsForRequest(
				makeMeta(),
				makeCtx([account]),
				MODEL,
			);
			return { account, result };
		} finally {
			Date.now = realNow;
		}
	}

	it("keeps selecting when a passive header write lands within the evidence window", async () => {
		const { account, result } = await selectAfterPassiveWrite(
			"drain-passive-fresh",
			60_000,
		);
		expect(result).toEqual([account]);
	});

	it("excludes once the owned evidence is stale even though headers keep the snapshot fresh", async () => {
		const { result } = await selectAfterPassiveWrite(
			"drain-passive-stale",
			10 * 60_000,
		);
		expect(result).toEqual([]);
	});
});
