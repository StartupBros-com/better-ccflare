import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import { clearSession, recordServedAccount } from "@better-ccflare/proxy";
import type { Account, AccountResponse } from "@better-ccflare/types";
import {
	createAccountCodexCreditDrainHandler,
	createAccountsListHandler,
} from "../accounts";
import { computePoolStatus } from "../health";
import { createSessionAccountHandler } from "../sessions";

const originalFetch = globalThis.fetch;
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;
const CREDITS = { has_credits: true, unlimited: false, balance: "10" };
const touched = new Set<string>();

/** A real owned poll: the only source of credit evidence. */
async function ownedPoll(accountId: string, credits: Record<string, unknown>) {
	touched.add(accountId);
	const reset_at = Math.floor(Date.now() / 1000) + 3600;
	globalThis.fetch = (async () =>
		Response.json({
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: { used_percent: 100, reset_at },
				secondary_window: { used_percent: 100, reset_at },
			},
			credits,
		})) as typeof fetch;
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

let dbOps: DatabaseOperations;

async function insertAccount(id: string, provider: string) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			`name-${id}`,
			provider,
			"refresh",
			"access",
			Date.now() + 3_600_000,
			Date.now(),
		],
	);
}

async function readFlag(id: string): Promise<number> {
	const row = await dbOps
		.getAdapter()
		.get<{ v: number }>(
			"SELECT codex_credit_drain_enabled as v FROM accounts WHERE id = ?",
			[id],
		);
	return Number(row?.v);
}

function post(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x/codex-credit-drain", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(() => {
	for (const id of touched) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
	touched.clear();
	globalThis.fetch = originalFetch;
	clearSession("cd-session");
});

describe("POST /api/accounts/:id/codex-credit-drain", () => {
	it("sets the flag on a codex account (200) and can clear it", async () => {
		await insertAccount("c1", "codex");
		const handler = createAccountCodexCreditDrainHandler(dbOps);
		const res = await handler(post({ enabled: 1 }), "c1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			codexCreditDrainEnabled: boolean;
		};
		expect(body.success).toBe(true);
		expect(body.codexCreditDrainEnabled).toBe(true);
		expect(await readFlag("c1")).toBe(1);

		const off = await handler(post({ enabled: 0 }), "c1");
		expect(off.status).toBe(200);
		expect(await readFlag("c1")).toBe(0);
	});

	it("rejects non-codex providers with 400 and leaves the flag unset", async () => {
		await insertAccount("a1", "anthropic");
		const res = await createAccountCodexCreditDrainHandler(dbOps)(
			post({ enabled: 1 }),
			"a1",
		);
		expect(res.status).toBe(400);
		expect(await readFlag("a1")).toBe(0);
	});

	it("rejects a bad body with 400", async () => {
		await insertAccount("c2", "codex");
		const handler = createAccountCodexCreditDrainHandler(dbOps);
		expect((await handler(post({ enabled: 2 }), "c2")).status).toBe(400);
		expect((await handler(post({}), "c2")).status).toBe(400);
		expect((await handler(post({ enabled: "yes" }), "c2")).status).toBe(400);
		expect(await readFlag("c2")).toBe(0);
	});

	it("returns 404 for an unknown account", async () => {
		const res = await createAccountCodexCreditDrainHandler(dbOps)(
			post({ enabled: 1 }),
			"missing",
		);
		expect(res.status).toBe(404);
	});
});

describe("GET /api/accounts — codex credit drain display", () => {
	async function listAccount(id: string): Promise<AccountResponse> {
		const res = await createAccountsListHandler(dbOps, CONFIG)();
		const accounts = (await res.json()) as AccountResponse[];
		const found = accounts.find((a) => a.id === id);
		if (!found) throw new Error("account missing from list");
		return found;
	}

	it("returns codexCreditDrainEnabled=false/Active=false by default", async () => {
		await insertAccount("c3", "codex");
		const account = await listAccount("c3");
		expect(account.codexCreditDrainEnabled).toBe(false);
		expect(account.codexCreditDrainActive).toBe(false);
	});

	it("draining spent account: active, not usage_exhausted, not throttled", async () => {
		await insertAccount("c4", "codex");
		await dbOps.setCodexCreditDrainEnabled("c4", true);
		await ownedPoll("c4", CREDITS);
		const account = await listAccount("c4");
		expect(account.codexCreditDrainEnabled).toBe(true);
		expect(account.codexCreditDrainActive).toBe(true);
		expect(account.rateLimitStatus).not.toContain("usage_exhausted");
		expect(account.usageThrottledWindows).toEqual([]);
		expect(account.usageThrottledUntil).toBeNull();
	});

	it("planted negative: drain off with credits and a spent window IS usage_exhausted", async () => {
		await insertAccount("c5", "codex");
		await ownedPoll("c5", CREDITS);
		const account = await listAccount("c5");
		expect(account.codexCreditDrainActive).toBe(false);
		expect(account.rateLimitStatus).toContain("usage_exhausted");
		expect(account.usageThrottledWindows.length).toBeGreaterThan(0);
	});

	it("planted negative: drain on but no credits stays usage_exhausted", async () => {
		await insertAccount("c6", "codex");
		await dbOps.setCodexCreditDrainEnabled("c6", true);
		await ownedPoll("c6", {
			has_credits: false,
			unlimited: false,
			balance: "5",
		});
		const account = await listAccount("c6");
		expect(account.codexCreditDrainEnabled).toBe(true);
		expect(account.codexCreditDrainActive).toBe(false);
		expect(account.rateLimitStatus).toContain("usage_exhausted");
	});
});

describe("computePoolStatus — codex credit drain", () => {
	// Evidence acquiredAt must not lie in the future relative to `now`, so each
	// test takes `now` after its owned poll.
	const spent = (now: number) => () => ({
		utilization: 100,
		resetMs: now + 3_600_000,
	});

	function codex(overrides: Partial<Account> = {}): Account {
		return {
			id: "cp1",
			name: "cp1",
			provider: "codex",
			paused: false,
			rate_limited_until: null,
			...overrides,
		} as Account;
	}

	it("counts a draining spent account routable and not usage_exhausted", async () => {
		await ownedPoll("cp1", CREDITS);
		const now = Date.now();
		const status = computePoolStatus(
			[codex({ codex_credit_drain_enabled: true })],
			now,
			spent(now),
		);
		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(0);
	});

	it("planted negative: drain off keeps the spent account unroutable", async () => {
		await ownedPoll("cp1", CREDITS);
		const now = Date.now();
		const status = computePoolStatus([codex()], now, spent(now));
		expect(status.routable).toBe(0);
		expect(status.usage_exhausted).toBe(1);
	});
});

describe("GET /api/sessions/:id/account — codex credit drain", () => {
	function codexAccount(overrides: Partial<Account>): Account {
		return {
			id: "cs1",
			name: "cs1",
			provider: "codex",
			paused: false,
			rate_limited_until: null,
			rate_limit_reset: null,
			rate_limit_status: null,
			...overrides,
		} as Account;
	}

	async function sessionData(account: Account) {
		recordServedAccount("cd-session", account.id, Date.now(), null, {
			requestedModel: "gpt-6",
			appliedModel: "gpt-6",
			upstreamModel: "gpt-6",
		});
		const handler = createSessionAccountHandler(
			{
				getAllAccounts: async () => [account],
			} as unknown as DatabaseOperations,
			CONFIG,
		);
		const body = (await (await handler("cd-session")).json()) as {
			data: {
				account: { rateLimitStatus: string; usageThrottledWindows: string[] };
			};
		};
		return body.data.account;
	}

	it("draining spent account is not shown exhausted or throttled", async () => {
		await ownedPoll("cs1", CREDITS);
		const a = await sessionData(
			codexAccount({ codex_credit_drain_enabled: true }),
		);
		expect(a.rateLimitStatus).not.toContain("usage_exhausted");
		expect(a.usageThrottledWindows).toEqual([]);
	});

	it("planted negative: drain off shows exhausted", async () => {
		await ownedPoll("cs1", CREDITS);
		const a = await sessionData(codexAccount({}));
		expect(a.rateLimitStatus).toContain("usage_exhausted");
		expect(a.usageThrottledWindows.length).toBeGreaterThan(0);
	});
});
