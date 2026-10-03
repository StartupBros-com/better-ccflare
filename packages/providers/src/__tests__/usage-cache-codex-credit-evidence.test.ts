import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const originalFetch = globalThis.fetch;
const accountId = "codex-credit-evidence-test";
const MAX_AGE = 180_000;

function body(credits: Record<string, unknown>) {
	return {
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: null,
			secondary_window: {
				used_percent: 100,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
		credits,
	};
}

async function poll(payload: unknown) {
	globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
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
	usageCache.stopPolling(accountId);
	usageCache.delete(accountId);
	globalThis.fetch = originalFetch;
});

describe("UsageCache Codex credit evidence", () => {
	it("is true after an owned poll reporting has_credits", async () => {
		await poll(body({ has_credits: true, unlimited: false, balance: "5" }));
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBe(true);
	});

	it("is true for unlimited", async () => {
		await poll(body({ has_credits: false, unlimited: true }));
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBe(true);
	});

	it("is false when has_credits and unlimited are false even with a positive balance", async () => {
		await poll(body({ has_credits: false, unlimited: false, balance: 12 }));
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBe(false);
	});

	it("survives a later passive usageCache.set", async () => {
		await poll(body({ has_credits: true, unlimited: false }));
		usageCache.set(accountId, {
			five_hour: { utilization: 100, resets_at: null },
			seven_day: { utilization: 100, resets_at: null },
		} as never);
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBe(true);
	});

	it("is never created by usageCache.set alone", () => {
		usageCache.set(accountId, {
			five_hour: { utilization: 100, resets_at: null },
			seven_day: { utilization: 100, resets_at: null },
			credits: { has_credits: true, unlimited: true, balance: 99 },
			codex_subscription: { hasCredits: true, unlimited: true },
		} as never);
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBeNull();
	});

	it("is cleared by delete", async () => {
		await poll(body({ has_credits: true }));
		usageCache.delete(accountId);
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBeNull();
	});

	it("is cleared by stopPolling", async () => {
		await poll(body({ has_credits: true }));
		usageCache.stopPolling(accountId);
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBeNull();
	});

	it("is null once a replacement registration has not yet produced evidence", async () => {
		await poll(body({ has_credits: true }));
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBe(true);
		// A second startPolling without stopPolling replaces the registration.
		// Its fetch never settles, so it cannot bind new evidence.
		globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
		usageCache.startPolling(accountId, "fake-token", "codex", 60_000);
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), MAX_AGE),
		).toBeNull();
	});

	it("goes stale after maxAgeMs and rejects future-dated evidence", async () => {
		await poll(body({ has_credits: true }));
		const now = Date.now();
		expect(
			usageCache.getCodexCreditEvidence(accountId, now + MAX_AGE + 1, MAX_AGE),
		).toBeNull();
		expect(
			usageCache.getCodexCreditEvidence(accountId, now - 60_000, MAX_AGE),
		).toBeNull();
	});
});
