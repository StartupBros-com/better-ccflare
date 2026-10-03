import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import { getAccountUsageThrottleUntil } from "../usage-throttling";

const originalFetch = globalThis.fetch;
const MODEL = "gpt-6";
const BOTH = { fiveHourEnabled: true, weeklyEnabled: true };

function codexAccount(id: string, drain: boolean, provider = "codex") {
	return { id, provider, codex_credit_drain_enabled: drain };
}

/** five_hour resets in 1h (80% of it elapsed), seven_day in 1h too. */
function usageBody(
	fiveHourPct: number,
	sevenDayPct: number,
	credits: Record<string, unknown>,
) {
	const reset_at = Math.floor(Date.now() / 1000) + 3600;
	return {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: fiveHourPct, reset_at },
			secondary_window: { used_percent: sevenDayPct, reset_at },
		},
		credits,
	};
}

const touched = new Set<string>();

/** A real owned poll: the only source of credit evidence. */
async function ownedPoll(accountId: string, body: unknown) {
	touched.add(accountId);
	globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
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
const NO_CREDITS = { has_credits: false, unlimited: false, balance: "0" };

describe("getAccountUsageThrottleUntil — Codex credit drain pacing", () => {
	it("does not pace spent windows when drain is on with owned credit evidence", async () => {
		const account = codexAccount("pace-drain-on", true);
		await ownedPoll(account.id, usageBody(100, 100, CREDITS));
		expect(
			getAccountUsageThrottleUntil(account, BOTH, Date.now(), MODEL),
		).toBeNull();
	});

	it("paces spent windows when drain is off", async () => {
		const account = codexAccount("pace-drain-off", false);
		await ownedPoll(account.id, usageBody(100, 100, CREDITS));
		const now = Date.now();
		const until = getAccountUsageThrottleUntil(account, BOTH, now, MODEL);
		expect(until).not.toBeNull();
		expect(until as number).toBeGreaterThan(now);
	});

	it("paces spent windows when drain is on but the poll reports no credits", async () => {
		const account = codexAccount("pace-drain-no-credits", true);
		await ownedPoll(account.id, usageBody(100, 100, NO_CREDITS));
		expect(
			getAccountUsageThrottleUntil(account, BOTH, Date.now(), MODEL),
		).not.toBeNull();
	});

	it("still paces a window that has headroom but is ahead of pace", async () => {
		// five_hour at 95% with 80% of the window elapsed is ahead of pace and
		// not spent, so drain must not skip it.
		const account = codexAccount("pace-drain-headroom", true);
		await ownedPoll(account.id, usageBody(95, 100, CREDITS));
		expect(
			getAccountUsageThrottleUntil(account, BOTH, Date.now(), MODEL),
		).not.toBeNull();
	});

	it("ignores the flag on a non-codex account", async () => {
		const account = codexAccount("pace-drain-anthropic", true, "anthropic");
		await ownedPoll(account.id, usageBody(100, 100, CREDITS));
		expect(
			getAccountUsageThrottleUntil(account, BOTH, Date.now(), MODEL),
		).not.toBeNull();
	});

	it("returns null when both throttles are disabled", async () => {
		const account = codexAccount("pace-disabled", false);
		await ownedPoll(account.id, usageBody(100, 100, CREDITS));
		expect(
			getAccountUsageThrottleUntil(
				account,
				{ fiveHourEnabled: false, weeklyEnabled: false },
				Date.now(),
				MODEL,
			),
		).toBeNull();
	});
});
