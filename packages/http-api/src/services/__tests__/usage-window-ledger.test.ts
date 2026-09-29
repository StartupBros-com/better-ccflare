import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	CLAUDE_MODEL_IDS,
	LIST_PRICE_ERAS,
	priceTokensAtListPrice,
	VALUE_PRICING_VERSION,
} from "@better-ccflare/core";
import { DatabaseOperations, type UsageWindow } from "@better-ccflare/database";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import type { AlertService } from "../alerts";
import { UsageWindowLedger } from "../usage-window-ledger";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "acct-1";

/** Builds a single 'seven_day' CanonicalUsageWindow snapshot; the ledger
 * ignores every other field on the type except windowKey/resetsAtMs/utilization. */
function sevenDay(
	utilization: number,
	resetsAtMs: number | null,
): CanonicalUsageWindow {
	return {
		windowKey: "seven_day",
		utilization,
		resetsAtMs,
		scope: "account",
		modelFamily: null,
		active: true,
	};
}

function fiveHour(
	utilization: number,
	resetsAtMs: number | null,
): CanonicalUsageWindow {
	return {
		windowKey: "five_hour",
		utilization,
		resetsAtMs,
		scope: "account",
		modelFamily: null,
		active: true,
	};
}

function legacyJunk(
	utilization: number,
	resetsAtMs: number | null,
): CanonicalUsageWindow {
	return {
		windowKey: "nimbus_quill",
		utilization,
		resetsAtMs,
		scope: "account",
		modelFamily: null,
		active: true,
	};
}

async function seedRequest(
	dbOps: DatabaseOperations,
	opts: {
		id: string;
		timestamp: number;
		model: string;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		accountId?: string;
		path?: string;
		billingType?: string;
	},
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			model, billing_type, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens
		) VALUES (?, ?, 'POST', ?, ?, 200, 1, ?, ?, ?, ?, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.path ?? "/v1/messages",
			opts.accountId ?? ACCOUNT_ID,
			opts.model,
			opts.billingType ?? "plan",
			opts.inputTokens ?? 0,
			opts.cacheReadInputTokens ?? 0,
			opts.cacheCreationInputTokens ?? 0,
			opts.outputTokens ?? 0,
		],
	);
}

async function seedAccount(
	dbOps: DatabaseOperations,
	opts: { id: string; name: string; createdAt?: number },
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`, [
			opts.id,
			opts.name,
			opts.createdAt ?? 0,
		]);
}

/** Minimal AlertService double for wiring tests below — only
 * evaluateClosedWindow is exercised by UsageWindowLedger, so nothing else
 * on the real class needs a fake. */
function fakeAlertService(
	impl: (window: UsageWindow, accountName: string) => Promise<void>,
): { service: AlertService; calls: Array<[UsageWindow, string]> } {
	const calls: Array<[UsageWindow, string]> = [];
	const service = {
		evaluateClosedWindow: async (window: UsageWindow, accountName: string) => {
			calls.push([window, accountName]);
			await impl(window, accountName);
		},
	} as unknown as AlertService;
	return { service, calls };
}

describe("UsageWindowLedger", () => {
	let dbOps: DatabaseOperations;
	let ledger: UsageWindowLedger;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		ledger = new UsageWindowLedger(dbOps);
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	// -------------------------------------------------------------------
	// (a) Jitter within +-5s stays one window
	// -------------------------------------------------------------------
	it("treats resets_at jitter within tolerance as the same window", async () => {
		const t0 = Date.parse("2026-08-01T00:00:00Z");
		const resetsAt = t0 + 5 * DAY_MS;

		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(10, resetsAt)], t0);
		// 5s of jitter on the reported resets_at, a later poll.
		const t1 = t0 + 60_000;
		await ledger.observeSnapshot(
			ACCOUNT_ID,
			[sevenDay(20, resetsAt + 5_000)],
			t1,
		);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].grantType).toBe("first_observed");
		expect(windows[0].peakUtilization).toBe(20);
		expect(windows[0].closedAt).toBeNull();
	});

	// -------------------------------------------------------------------
	// (b) Bonus early reset: resets_at jumps ~2 days while the old window
	// still had ~5 days of runway left -> grant_type = 'early_reset'
	// (mirrors the Aug-11/Aug-13 bonus resets from the 2026-08 audit).
	// -------------------------------------------------------------------
	it("closes the old window and opens 'early_reset' when the cluster jumps while the old window still had days left", async () => {
		const t0 = Date.parse("2026-08-11T00:00:00Z");
		const oldResetsAt = t0 + 5 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(30, oldResetsAt)], t0);

		// Shortly after, a bonus reset lands: resets_at jumps forward by ~2 days.
		const t1 = t0 + 1_000;
		const newResetsAt = t1 + 7 * DAY_MS;
		expect(Math.abs(newResetsAt - oldResetsAt)).toBeGreaterThan(DAY_MS);
		// utilization 1, not 0: a 0% snapshot with resets_at == now+7d is the
		// provider's sliding pre-anchor placeholder, which the ledger skips.
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(1, newResetsAt)], t1);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(2);

		const closed = windows.find((w) => w.resetsAt === oldResetsAt);
		const opened = windows.find((w) => w.resetsAt === newResetsAt);
		expect(closed?.closedAt).toBe(t1);
		expect(opened?.grantType).toBe("early_reset");
		expect(opened?.startedAt).toBe(t1);
	});

	// -------------------------------------------------------------------
	// (c) New cluster arriving right at/after the old resets_at -> 'natural'
	// (mirrors the Aug-20 windows from the 2026-08 audit).
	// -------------------------------------------------------------------
	it("opens a 'natural' window when the cluster changes right at/after the old window's resets_at", async () => {
		const t0 = Date.parse("2026-08-20T00:00:00Z");
		const oldResetsAt = t0 + 3 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(80, oldResetsAt)], t0);

		// Poll lands just after the old window's natural reset time.
		// (utilization 1: an anchored window has usage — see placeholder note above.)
		const t1 = oldResetsAt + 1_000;
		const newResetsAt = t1 + 7 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(1, newResetsAt)], t1);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(2);
		const opened = windows.find((w) => w.resetsAt === newResetsAt);
		expect(opened?.grantType).toBe("natural");
		expect(opened?.startedAt).toBe(t1);

		const closed = windows.find((w) => w.resetsAt === oldResetsAt);
		expect(closed?.closedAt).toBe(t1);
	});

	// -------------------------------------------------------------------
	// (d) First snapshot ever -> 'first_observed', started_at clamp
	// -------------------------------------------------------------------
	it("opens a 'first_observed' window on the very first snapshot, clamping started_at to now when the natural start would be future", async () => {
		const t0 = Date.parse("2026-08-05T00:00:00Z");
		// resets_at only 1 day out -> natural start (resetsAt - 7d) is in the
		// past relative to t0, so no clamping needed here (sanity case).
		const resetsAt = t0 + DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(5, resetsAt)], t0);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].grantType).toBe("first_observed");
		expect(windows[0].startedAt).toBe(resetsAt - 7 * DAY_MS);
	});

	it("clamps started_at to the observation time when resetsAt - 7d would land in the future", async () => {
		const t0 = Date.parse("2026-08-05T00:00:00Z");
		// resets_at is 10 days out -> naturalStart = resetsAt - 7d = t0 + 3d,
		// which is AFTER t0 (the moment of first observation). Must clamp down
		// to t0 rather than recording a future start time.
		const resetsAt = t0 + 10 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(5, resetsAt)], t0);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].grantType).toBe("first_observed");
		expect(windows[0].startedAt).toBe(t0);
	});

	// -------------------------------------------------------------------
	// (e) Utilization 35 -> 100: first_100_at set once, peak sticks at 100
	// -------------------------------------------------------------------
	it("sets first_100_at exactly once and keeps peak_utilization at the max observed", async () => {
		const t0 = Date.parse("2026-08-12T00:00:00Z");
		const resetsAt = t0 + 4 * DAY_MS;

		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(35, resetsAt)], t0);
		const t1 = t0 + 60_000;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(100, resetsAt)], t1);
		const t2 = t1 + 60_000;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(100, resetsAt)], t2);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].peakUtilization).toBe(100);
		expect(windows[0].first100At).toBe(t1);
	});

	// -------------------------------------------------------------------
	// (f) Legacy/unrelated window keys are ignored entirely
	// -------------------------------------------------------------------
	it("ignores 'five_hour' and legacy junk window keys, recording nothing", async () => {
		const t0 = Date.parse("2026-08-13T00:00:00Z");
		await ledger.observeSnapshot(
			ACCOUNT_ID,
			[fiveHour(50, t0 + 3 * 60 * 60 * 1000), legacyJunk(999, t0 + DAY_MS)],
			t0,
		);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(0);
	});

	it("skips a seven_day snapshot with a null resetsAtMs", async () => {
		const t0 = Date.parse("2026-08-13T00:00:00Z");
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(50, null)], t0);
		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(0);
	});

	// -------------------------------------------------------------------
	// Inactive rows: normalizeProviderUsageWindows keeps limits[] entries
	// flagged is_active:false, leaving the filter to consumers. They describe
	// no consumable capacity, so they must neither open nor close a window.
	// -------------------------------------------------------------------
	it("ignores an inactive seven_day row rather than opening a window for it", async () => {
		const t0 = Date.parse("2026-08-13T00:00:00Z");
		await ledger.observeSnapshot(
			ACCOUNT_ID,
			[{ ...sevenDay(40, t0 + 7 * DAY_MS), active: false }],
			t0,
		);
		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(0);
	});

	it("never closes the live window when an inactive row carries a different resets_at", async () => {
		const t0 = Date.parse("2026-08-13T00:00:00Z");
		const liveResetsAt = t0 + 7 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(20, liveResetsAt)], t0);

		// A stale/promotional limits[] entry the provider still echoes, far
		// outside the 120s cluster tolerance: it must be inert.
		await ledger.observeSnapshot(
			ACCOUNT_ID,
			[
				{ ...sevenDay(0, t0 + 30 * DAY_MS), active: false },
				sevenDay(45, liveResetsAt),
			],
			t0 + 60 * 60 * 1000,
		);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].closedAt).toBeNull();
		expect(windows[0].resetsAt).toBe(liveResetsAt);
		expect(windows[0].peakUtilization).toBe(45);
	});

	// -------------------------------------------------------------------
	// (g) closeAndValue prices from seeded requests; unknown model lands
	// in unpricedTokens. Real gpt-5.6-terra list rates: 2.0/0.2/12 per 1M.
	// -------------------------------------------------------------------
	it("closeAndValue prices plan-billed requests by model, folding an unpriced model's tokens into unpricedTokens", async () => {
		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;

		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		// gpt-5.6-terra: input 2.0/M, cacheRead 0.2/M, output 12.0/M.
		// Row A: 1,000,000 input -> 2.0
		await seedRequest(dbOps, {
			id: "req-a",
			timestamp: startedAt + 1_000,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000,
		});
		// Row B: 500,000 output -> 6.0
		await seedRequest(dbOps, {
			id: "req-b",
			timestamp: startedAt + 2_000,
			model: "gpt-5.6-terra",
			outputTokens: 500_000,
		});
		// gpt-5.6-terra total value = 2.0 + 6.0 = 8.0
		await seedRequest(dbOps, {
			id: "req-c",
			timestamp: startedAt + 3_000,
			model: "unknown-model-zzz",
			inputTokens: 300,
			cacheReadInputTokens: 20,
			outputTokens: 75,
		});
		// Excluded: count_tokens path.
		await seedRequest(dbOps, {
			id: "req-excluded-path",
			timestamp: startedAt + 4_000,
			model: "gpt-5.6-terra",
			path: "/v1/messages/count_tokens",
			inputTokens: 999_999,
		});
		// Excluded: non-plan billing.
		await seedRequest(dbOps, {
			id: "req-excluded-billing",
			timestamp: startedAt + 5_000,
			model: "gpt-5.6-terra",
			billingType: "api",
			inputTokens: 999_999,
		});
		// Excluded: outside [startedAt, closedAt).
		await seedRequest(dbOps, {
			id: "req-excluded-range",
			timestamp: closedAt,
			model: "gpt-5.6-terra",
			inputTokens: 999_999,
		});

		const closedOk = await ledger.closeAndValue(opened, closedAt);
		expect(closedOk).toBe(true);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		const w = windows[0];
		expect(w.closedAt).toBe(closedAt);
		expect(w.valueUsd).toBeCloseTo(8.0, 10);
		expect(w.unpricedTokens).toBe(300 + 20 + 75);
		expect(w.requestCount).toBe(3);
		expect(w.inputTokens).toBe(1_000_000 + 300);
		expect(w.cacheReadInputTokens).toBe(20);
		expect(w.outputTokens).toBe(500_000 + 75);
		expect(w.projectionVersion).toBe(VALUE_PRICING_VERSION);
		expect(w.modelBreakdown).not.toBeNull();
		const breakdown = w.modelBreakdown as Record<
			string,
			{ valueUsd: number | null }
		>;
		expect(breakdown["gpt-5.6-terra"].valueUsd).toBeCloseTo(8.0, 10);
		expect(breakdown["unknown-model-zzz"].valueUsd).toBeNull();
	});

	it("closeAndValue uses newStartedAtMs (not closedAtMs) as the aggregation upper bound when provided", async () => {
		const startedAt = Date.parse("2026-08-15T00:00:00Z");
		const newStartedAt = startedAt + DAY_MS;
		const closedAt = startedAt + 2 * DAY_MS;

		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		// Inside [startedAt, newStartedAt) -> counted.
		await seedRequest(dbOps, {
			id: "req-in-range",
			timestamp: startedAt + 1_000,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000,
		});
		// At/after newStartedAt (but before closedAt) -> must NOT be counted,
		// since it belongs to the successor window's life, not this one's.
		await seedRequest(dbOps, {
			id: "req-after-new-start",
			timestamp: newStartedAt,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000,
		});

		await ledger.closeAndValue(opened, closedAt, newStartedAt);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		const w = windows.find((win) => win.id === opened.id);
		expect(w?.inputTokens).toBe(1_000_000);
		expect(w?.valueUsd).toBeCloseTo(2.0, 10);
	});

	// -------------------------------------------------------------------
	// Resilience: one account's failure must not throw out of observeSnapshot.
	// -------------------------------------------------------------------
	it("swallows a per-window failure instead of throwing out of observeSnapshot", async () => {
		const t0 = Date.parse("2026-08-14T00:00:00Z");
		// A negative resetsAtMs is nonsensical but must not crash the poll
		// loop — the underlying repository validation throwing is exactly the
		// kind of failure evaluateUsageSnapshot-style resilience guards against.
		await expect(
			ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(10, -1)], t0),
		).resolves.toBeUndefined();
	});
});

describe("UsageWindowLedger alertService wiring", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	it("invokes alertService.evaluateClosedWindow with the closed window and the account's current name after a successful close", async () => {
		await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary account" });
		const { service, calls } = fakeAlertService(async () => {});
		const ledger = new UsageWindowLedger(dbOps, service);

		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		const closedOk = await ledger.closeAndValue(opened, closedAt);
		expect(closedOk).toBe(true);

		expect(calls).toHaveLength(1);
		const [closedWindow, accountName] = calls[0];
		expect(accountName).toBe("Primary account");
		expect(closedWindow.id).toBe(opened.id);
		expect(closedWindow.closedAt).toBe(closedAt);
		expect(closedWindow.valueUsd).toBe(0);
	});

	it("falls back to the accountId when no accounts row exists", async () => {
		// No seedAccount call — dbOps.getAccount returns null for an unknown id.
		const { service, calls } = fakeAlertService(async () => {});
		const ledger = new UsageWindowLedger(dbOps, service);

		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		await ledger.closeAndValue(opened, closedAt);

		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toBe(ACCOUNT_ID);
	});

	it("does not invoke alertService on a no-op close (window already closed)", async () => {
		await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary account" });
		const { service, calls } = fakeAlertService(async () => {});
		const ledger = new UsageWindowLedger(dbOps, service);

		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		const firstClose = await ledger.closeAndValue(opened, closedAt);
		expect(firstClose).toBe(true);
		// Second close of the same already-closed window is a no-op
		// (UsageWindowsRepository.closeWindow guards on closed_at IS NULL).
		const secondClose = await ledger.closeAndValue(opened, closedAt + 1_000);
		expect(secondClose).toBe(false);

		expect(calls).toHaveLength(1);
	});

	it("isolates an alertService failure from the close path — closeAndValue still succeeds and does not throw", async () => {
		await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary account" });
		const { service, calls } = fakeAlertService(async () => {
			throw new Error("boom: alert evaluation exploded");
		});
		const ledger = new UsageWindowLedger(dbOps, service);

		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});

		let closedOk: boolean | undefined;
		await expect(
			(async () => {
				closedOk = await ledger.closeAndValue(opened, closedAt);
			})(),
		).resolves.toBeUndefined();

		expect(closedOk).toBe(true);
		expect(calls).toHaveLength(1);

		// The window itself is genuinely closed in the DB despite the alert
		// failure — the failure isolation must not roll back or skip the close.
		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows[0]?.closedAt).toBe(closedAt);
	});

	it("does not require an alertService at all (backward compatible)", async () => {
		const ledger = new UsageWindowLedger(dbOps);
		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});
		await expect(ledger.closeAndValue(opened, closedAt)).resolves.toBe(true);
	});
});

describe("UsageWindowLedger real pricing table sanity", () => {
	it("gpt-5.6-terra is actually priced at 2.0/0.2/12 per 1M in LIST_PRICE_ERAS as of this test's fixtures", () => {
		// Guards the (g) fixture above against LIST_PRICE_ERAS drifting without
		// the hand-computed expectations being updated to match.
		const eras = LIST_PRICE_ERAS["gpt-5.6-terra"];
		expect(eras).toBeDefined();
		const era = eras?.[eras.length - 1];
		expect(era?.inputPerM).toBe(2.0);
		expect(era?.cacheReadPerM).toBe(0.2);
		expect(era?.outputPerM).toBe(12.0);
	});
});

// ---------------------------------------------------------------------------
// Sliding placeholder resets. Live pattern observed 2026-08-24 on all three
// codex Pro accounts: after the provider cuts an account to 0%, every poll
// reports utilization 0 with resets_at = poll_time + 7d EXACTLY, sliding
// forward until first usage anchors the real window (pro-secondary idled
// 00:44->20:39 UTC that way). Without the placeholder guard the accumulated
// slide drifts past the 120s cluster tolerance every ~2-3 polls and the
// ledger churns a close+open each time — junk windows that poison the
// value-drop alert's priors median.
// ---------------------------------------------------------------------------
describe("UsageWindowLedger sliding placeholder resets", () => {
	let dbOps: DatabaseOperations;
	let ledger: UsageWindowLedger;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		ledger = new UsageWindowLedger(dbOps);
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	it("does not churn windows while an idle account's resets_at slides", async () => {
		const t0 = Date.parse("2026-08-20T03:35:00Z");
		const liveResetsAt = t0 + 7 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(100, liveResetsAt)], t0);

		// The cut: ~4 days later the account idles at 0% while resets_at
		// slides with each ~95s poll.
		const cut = Date.parse("2026-08-24T00:44:54Z");
		for (let i = 0; i < 6; i++) {
			const ts = cut + i * 95_000;
			await ledger.observeSnapshot(
				ACCOUNT_ID,
				[sevenDay(0, ts + 7 * DAY_MS)],
				ts,
			);
		}

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(1);
		expect(windows[0].closedAt).toBeNull();
		expect(windows[0].resetsAt).toBe(liveResetsAt);
	});

	it("anchors the new window at resets_at - 7d and classifies it early_reset once usage resumes", async () => {
		await seedAccount(dbOps, { id: ACCOUNT_ID, name: "acct" });
		const t0 = Date.parse("2026-08-20T03:35:00Z");
		const oldResetsAt = t0 + 7 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(50, oldResetsAt)], t0);

		// Usage inside the old window: 1M input of gpt-5.6-terra = $2.00 list.
		await seedRequest(dbOps, {
			id: "req-old",
			timestamp: t0 + 60 * 60 * 1000,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000,
		});

		// Idle slide phase — every snapshot skipped as a placeholder.
		const cut = Date.parse("2026-08-24T00:44:54Z");
		for (let i = 0; i < 3; i++) {
			const ts = cut + i * 95_000;
			await ledger.observeSnapshot(
				ACCOUNT_ID,
				[sevenDay(0, ts + 7 * DAY_MS)],
				ts,
			);
		}

		// First usage at 18:30:44 anchors resets_at = first_use + 7d; the poll
		// only notices at 18:52. A request inside the 18:30->18:52 gap must be
		// attributed to the NEW window, not the old one.
		const anchor = Date.parse("2026-08-24T18:30:44Z");
		const poll = Date.parse("2026-08-24T18:52:20Z");
		await seedRequest(dbOps, {
			id: "req-new",
			timestamp: anchor + 5 * 60 * 1000,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000,
		});
		await ledger.observeSnapshot(
			ACCOUNT_ID,
			[sevenDay(1, anchor + 7 * DAY_MS)],
			poll,
		);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(2);
		const closed = windows.find((w) => w.resetsAt === oldResetsAt);
		const opened = windows.find((w) => w.resetsAt === anchor + 7 * DAY_MS);
		expect(closed?.closedAt).toBe(poll);
		// Value cut at the anchor, not the poll: req-new is excluded.
		expect(closed?.valueUsd).toBeCloseTo(2.0, 10);
		expect(opened?.grantType).toBe("early_reset");
		expect(opened?.startedAt).toBe(anchor);
	});

	it("still processes a genuine zero-utilization window whose resets_at is not a now+7d placeholder", async () => {
		const t0 = Date.parse("2026-08-20T03:35:00Z");
		const liveResetsAt = t0 + 7 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(60, liveResetsAt)], t0);

		// 0% but with a FIXED resets_at well short of now+7d (e.g. a provider
		// stamping calendar boundaries): must close/reopen normally rather
		// than be mistaken for a pending placeholder.
		const t1 = t0 + 2 * DAY_MS;
		const fixedResetsAt = t1 + 4 * DAY_MS;
		await ledger.observeSnapshot(ACCOUNT_ID, [sevenDay(0, fixedResetsAt)], t1);

		const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		expect(windows).toHaveLength(2);
	});
});

describe("UsageWindowLedger generation fence", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	it("does not open a ledger row when the account is replaced after getOpenUsageWindow resolves", async () => {
		const generationA = 100;
		const generationB = 200;
		await seedAccount(dbOps, {
			id: ACCOUNT_ID,
			name: "generation A",
			createdAt: generationA,
		});
		const ledger = new UsageWindowLedger(dbOps);
		const original = dbOps.getOpenUsageWindow.bind(dbOps);
		let replaced = false;
		const getOpen = spyOn(dbOps, "getOpenUsageWindow").mockImplementation(
			async (...args) => {
				const open = await original(...args);
				if (!replaced) {
					replaced = true;
					await dbOps
						.getAdapter()
						.run("DELETE FROM accounts WHERE id = ?", [ACCOUNT_ID]);
					await dbOps
						.getAdapter()
						.run(
							"INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)",
							[ACCOUNT_ID, "generation B", generationB],
						);
				}
				return open;
			},
		);
		try {
			const now = Date.parse("2026-08-25T00:00:00Z");
			await ledger.observeSnapshot(
				ACCOUNT_ID,
				[sevenDay(20, now + 7 * DAY_MS)],
				now,
				generationA,
			);
		} finally {
			getOpen.mockRestore();
		}
		expect(replaced).toBe(true);
		expect(await dbOps.listUsageWindows({ accountId: ACCOUNT_ID })).toEqual([]);
	});
});

describe("UsageWindowLedger.revalueStaleClosedWindows", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	const STARTED_AT = Date.parse("2026-09-01T00:00:00Z");
	const TERRA = "gpt-5.6-terra"; // 2.0 / 0.2 / 12.0 per 1M
	const LUNA = "gpt-5.6-luna"; // 0.2 / 0.02 / 1.2 per 1M

	function entry(
		tokens: { input?: number; cacheRead?: number; output?: number },
		valueUsd: number | null,
	) {
		return {
			requestCount: 2,
			inputTokens: tokens.input ?? 0,
			cacheReadInputTokens: tokens.cacheRead ?? 0,
			cacheCreationInputTokens: 0,
			outputTokens: tokens.output ?? 0,
			valueUsd,
		};
	}

	const TOTALS_FIELDS = [
		"requestCount",
		"inputTokens",
		"cacheReadInputTokens",
		"cacheCreationInputTokens",
		"outputTokens",
	] as const;

	/** Seeds a closed window straight through the repository, bypassing the
	 * ledger, so its stored version/values can be arbitrarily stale. */
	async function seedClosed(opts: {
		resetsAt: number;
		breakdown: Record<string, ReturnType<typeof entry>> | null;
		valueUsd: number;
		unpricedTokens?: number;
		version: string | null;
		totals?: Partial<Record<(typeof TOTALS_FIELDS)[number], number>>;
		close?: boolean;
	}): Promise<UsageWindow> {
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt: STARTED_AT,
			resetsAt: opts.resetsAt,
			grantType: "natural",
		});
		if (opts.close === false) return opened;
		const values = Object.values(opts.breakdown ?? {});
		const sum = (f: (e: ReturnType<typeof entry>) => number) =>
			values.reduce((a, e) => a + f(e), 0);
		await dbOps.closeUsageWindow(opened.id, {
			closedAt: opts.resetsAt,
			valueUsd: opts.valueUsd,
			inputTokens: opts.totals?.inputTokens ?? sum((e) => e.inputTokens),
			cacheReadInputTokens:
				opts.totals?.cacheReadInputTokens ?? sum((e) => e.cacheReadInputTokens),
			cacheCreationInputTokens:
				opts.totals?.cacheCreationInputTokens ??
				sum((e) => e.cacheCreationInputTokens),
			outputTokens: opts.totals?.outputTokens ?? sum((e) => e.outputTokens),
			requestCount: opts.totals?.requestCount ?? sum((e) => e.requestCount),
			modelBreakdown: opts.breakdown,
			unpricedTokens: opts.unpricedTokens ?? 0,
			projectionVersion: opts.version,
		});
		return opened;
	}

	async function reload(id: string): Promise<UsageWindow> {
		const all = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
		const found = all.find((w) => w.id === id);
		if (!found) throw new Error("window vanished");
		return found;
	}

	const terraTokens = {
		input: 1_000_000,
		cacheRead: 1_000_000,
		output: 100_000,
	};
	// 2.0 + 0.2 + 1.2 = 3.4
	const TERRA_CURRENT = 3.4;
	const lunaTokens = { input: 500_000, output: 50_000 };
	// 0.1 + 0.06 = 0.16
	const LUNA_VALUE = (500_000 * 0.2 + 50_000 * 1.2) / 1_000_000;

	it("re-prices a stale-version window at current eras and only touches the changed model", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: {
				[TERRA]: entry(terraTokens, 9.99), // stale rate
				[LUNA]: entry(lunaTokens, LUNA_VALUE),
			},
			valueUsd: 9.99 + LUNA_VALUE,
			version: "old-version",
		});
		const ledger = new UsageWindowLedger(dbOps);
		const summary = await ledger.revalueStaleClosedWindows();

		expect(summary.scanned).toBe(1);
		expect(summary.stamped).toBe(1);
		expect(summary.valueChanged).toBe(1);
		expect(summary.skipped).toBe(0);
		expect(summary.valueDeltaUsd).toBeCloseTo(TERRA_CURRENT - 9.99, 9);

		const after = await reload(w.id);
		expect(after.valueUsd).toBeCloseTo(TERRA_CURRENT + LUNA_VALUE, 9);
		const breakdown = after.modelBreakdown as Record<
			string,
			ReturnType<typeof entry>
		>;
		expect(breakdown[TERRA].valueUsd).toBeCloseTo(TERRA_CURRENT, 9);
		expect(breakdown[LUNA]).toEqual(entry(lunaTokens, LUNA_VALUE));
		expect(after.unpricedTokens).toBe(0);
		expect(after.projectionVersion).toBe(VALUE_PRICING_VERSION);
		expect(after.closedAt).toBe(w.resetsAt);
	});

	it("leaves a window already at the current version untouched", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: VALUE_PRICING_VERSION,
		});
		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary.scanned).toBe(0);
		expect((await reload(w.id)).valueUsd).toBe(9.99);
	});

	it("leaves open windows untouched", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: null,
			valueUsd: 0,
			version: null,
			close: false,
		});
		// A closed-only invariant, not a data one: give the open row a stale
		// version and a breakdown so only the closed_at filter can exclude it.
		await dbOps
			.getAdapter()
			.run(
				"UPDATE usage_windows SET model_breakdown = ?, projection_version = ? WHERE id = ?",
				[JSON.stringify({ [TERRA]: entry(terraTokens, 9.99) }), "old", w.id],
			);
		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary.scanned).toBe(0);
		const after = await reload(w.id);
		expect(after.closedAt).toBeNull();
		expect(after.projectionVersion).toBe("old");
	});

	it("treats a NULL projection_version as stale and is idempotent on a second run", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: null,
		});
		const ledger = new UsageWindowLedger(dbOps);
		const first = await ledger.revalueStaleClosedWindows();
		expect(first.stamped).toBe(1);
		const afterFirst = await reload(w.id);
		expect(afterFirst.projectionVersion).toBe(VALUE_PRICING_VERSION);

		const second = await ledger.revalueStaleClosedWindows();
		expect(second).toMatchObject({
			scanned: 0,
			stamped: 0,
			valueChanged: 0,
			skipped: 0,
			valueDeltaUsd: 0,
		});
		expect(await reload(w.id)).toEqual(afterFirst);
	});

	for (const field of TOTALS_FIELDS) {
		it(`skips a window whose stored ${field} disagrees with its breakdown`, async () => {
			const w = await seedClosed({
				resetsAt: STARTED_AT + 7 * DAY_MS,
				breakdown: { [TERRA]: entry(terraTokens, 9.99) },
				valueUsd: 9.99,
				version: "old-version",
				totals: { [field]: 123 },
			});
			const summary = await new UsageWindowLedger(
				dbOps,
			).revalueStaleClosedWindows();
			expect(summary).toMatchObject({ scanned: 1, stamped: 0, skipped: 1 });
			const after = await reload(w.id);
			expect(after.valueUsd).toBe(9.99);
			expect(after.projectionVersion).toBe("old-version");
		});
	}

	it("keeps going past unreadable, mismatched and malformed windows", async () => {
		// Listed in resets_at order: the three bad windows come before the
		// valid one, so a skip that ended the pass would leave it stale.
		const unreadable = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});
		await dbOps
			.getAdapter()
			.run("UPDATE usage_windows SET model_breakdown = ? WHERE id = ?", [
				"{not json",
				unreadable.id,
			]);
		const mismatched = await seedClosed({
			resetsAt: STARTED_AT + 8 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
			totals: { outputTokens: 123 },
		});
		const malformed = await seedClosed({
			resetsAt: STARTED_AT + 9 * DAY_MS,
			breakdown: {
				[TERRA]: { requestCount: "x" } as unknown as ReturnType<typeof entry>,
			},
			valueUsd: 9.99,
			version: "old-version",
			totals: { inputTokens: 0, requestCount: 0 },
		});
		const valid = await seedClosed({
			resetsAt: STARTED_AT + 10 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});

		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary).toMatchObject({
			scanned: 4,
			stamped: 1,
			valueChanged: 1,
			skipped: 3,
		});
		expect(summary.valueDeltaUsd).toBeCloseTo(TERRA_CURRENT - 9.99, 9);
		const adapter = dbOps.getAdapter();
		const raw = await adapter.get<{
			model_breakdown: string;
			projection_version: string;
		}>(
			"SELECT model_breakdown, projection_version FROM usage_windows WHERE id = ?",
			[unreadable.id],
		);
		expect(raw).toEqual({
			model_breakdown: "{not json",
			projection_version: "old-version",
		});
		// reload() parses every row, so the corrupt one has to go first.
		await adapter.run("DELETE FROM usage_windows WHERE id = ?", [
			unreadable.id,
		]);
		const repriced = await reload(valid.id);
		expect(repriced.valueUsd).toBeCloseTo(TERRA_CURRENT, 9);
		expect(repriced.projectionVersion).toBe(VALUE_PRICING_VERSION);
		for (const id of [mismatched.id, malformed.id]) {
			const after = await reload(id);
			expect(after.valueUsd).toBe(9.99);
			expect(after.projectionVersion).toBe("old-version");
		}
	});

	it("skips a window whose write throws and re-prices the rest", async () => {
		const failing = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});
		const next = await seedClosed({
			resetsAt: STARTED_AT + 8 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});
		const realRevalue = dbOps.revalueClosedUsageWindow.bind(dbOps);
		const revalueSpy = spyOn(
			dbOps,
			"revalueClosedUsageWindow",
		).mockImplementation(async (id, input, expected) => {
			if (id === failing.id) throw new Error("disk I/O error");
			return realRevalue(id, input, expected);
		});
		try {
			const summary = await new UsageWindowLedger(
				dbOps,
			).revalueStaleClosedWindows();
			expect(summary).toMatchObject({ scanned: 2, stamped: 1, skipped: 1 });
		} finally {
			revalueSpy.mockRestore();
		}
		expect((await reload(failing.id)).projectionVersion).toBe("old-version");
		expect((await reload(next.id)).projectionVersion).toBe(
			VALUE_PRICING_VERSION,
		);
	});

	it("skips a window with a malformed breakdown entry", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: {
				[TERRA]: { requestCount: "x" } as unknown as ReturnType<typeof entry>,
			},
			valueUsd: 9.99,
			version: "old-version",
			totals: { inputTokens: 0, requestCount: 0 },
		});
		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary).toMatchObject({ scanned: 1, stamped: 0, skipped: 1 });
		expect((await reload(w.id)).projectionVersion).toBe("old-version");
	});

	it("does not apply when projection_version changed between list and update", async () => {
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});
		const realList = dbOps.listClosedWindowsNotAtProjectionVersion.bind(dbOps);
		const listSpy = spyOn(
			dbOps,
			"listClosedWindowsNotAtProjectionVersion",
		).mockImplementation(async (v: string) => {
			const rows = await realList(v);
			// A concurrent writer re-stamps the row after we listed it.
			await dbOps
				.getAdapter()
				.run("UPDATE usage_windows SET projection_version = ? WHERE id = ?", [
					"concurrent-version",
					w.id,
				]);
			return rows;
		});
		try {
			const summary = await new UsageWindowLedger(
				dbOps,
			).revalueStaleClosedWindows();
			expect(summary).toMatchObject({ scanned: 1, stamped: 0, skipped: 1 });
		} finally {
			listSpy.mockRestore();
		}
		const after = await reload(w.id);
		expect(after.valueUsd).toBe(9.99);
		expect(after.projectionVersion).toBe("concurrent-version");
	});

	it("fires no alert while re-pricing", async () => {
		await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: { [TERRA]: entry(terraTokens, 9.99) },
			valueUsd: 9.99,
			version: "old-version",
		});
		const { service, calls } = fakeAlertService(async () => {});
		const summary = await new UsageWindowLedger(
			dbOps,
			service,
		).revalueStaleClosedWindows();
		expect(summary.stamped).toBe(1);
		expect(calls).toHaveLength(0);
	});

	it("re-prices a production-shaped breakdown: empty-model entry, cache writes, key order", async () => {
		// Shaped like a real stored row: a zero-token "" entry with a null value
		// (requests that never resolved a model), Claude models with cache writes,
		// and a model at the stale Sonnet 5 $3/$15 era next to a current one.
		const unresolved = {
			requestCount: 25,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			valueUsd: null,
		};
		const sonnet5Tokens = {
			requestCount: 10,
			inputTokens: 1_000_000,
			cacheReadInputTokens: 10_000_000,
			cacheCreationInputTokens: 200_000,
			outputTokens: 100_000,
		};
		// $3/$15 era: 3 + 3.0 + 0.75 + 1.5
		const SONNET5_STALE = 8.25;
		// $2/$10 era: 2 + 2.0 + 0.5 + 1.0
		const SONNET5_CURRENT = 5.5;
		const opusTokens = {
			requestCount: 4,
			inputTokens: 200_000,
			cacheReadInputTokens: 3_000_000,
			cacheCreationInputTokens: 50_000,
			outputTokens: 40_000,
		};
		const opusValue = priceTokensAtListPrice(
			CLAUDE_MODEL_IDS.OPUS_5,
			STARTED_AT,
			opusTokens,
		);
		if (opusValue === null) throw new Error("Opus 5 must be priced");
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: {
				"": unresolved,
				[CLAUDE_MODEL_IDS.OPUS_5]: { ...opusTokens, valueUsd: opusValue },
				[CLAUDE_MODEL_IDS.SONNET_5]: {
					...sonnet5Tokens,
					valueUsd: SONNET5_STALE,
				},
			},
			valueUsd: opusValue + SONNET5_STALE,
			version: "2026-09-01.1",
		});

		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary).toMatchObject({ stamped: 1, valueChanged: 1, skipped: 0 });
		expect(summary.valueDeltaUsd).toBeCloseTo(
			SONNET5_CURRENT - SONNET5_STALE,
			9,
		);

		const after = await reload(w.id);
		expect(after.valueUsd).toBeCloseTo(opusValue + SONNET5_CURRENT, 9);
		expect(after.unpricedTokens).toBe(0);
		expect(after.projectionVersion).toBe(VALUE_PRICING_VERSION);
		const breakdown = after.modelBreakdown as Record<
			string,
			ReturnType<typeof entry>
		>;
		expect(Object.keys(breakdown)).toEqual([
			"",
			CLAUDE_MODEL_IDS.OPUS_5,
			CLAUDE_MODEL_IDS.SONNET_5,
		]);
		expect(breakdown[""]).toEqual(unresolved);
		expect(breakdown[CLAUDE_MODEL_IDS.OPUS_5]).toEqual({
			...opusTokens,
			valueUsd: opusValue,
		});
		expect(breakdown[CLAUDE_MODEL_IDS.SONNET_5]).toEqual({
			...sonnet5Tokens,
			valueUsd: expect.closeTo(SONNET5_CURRENT, 9),
		});
	});

	it("prices a model that was unpriced at the old version and drops unpriced_tokens", async () => {
		const unpriced = 1_000_000 + 1_000_000 + 100_000;
		const w = await seedClosed({
			resetsAt: STARTED_AT + 7 * DAY_MS,
			breakdown: {
				[TERRA]: entry(terraTokens, null),
				[LUNA]: entry(lunaTokens, LUNA_VALUE),
			},
			valueUsd: LUNA_VALUE,
			unpricedTokens: unpriced,
			version: "old-version",
		});
		const summary = await new UsageWindowLedger(
			dbOps,
		).revalueStaleClosedWindows();
		expect(summary.valueChanged).toBe(1);
		expect(summary.valueDeltaUsd).toBeCloseTo(TERRA_CURRENT, 9);
		const after = await reload(w.id);
		expect(after.unpricedTokens).toBe(0);
		expect(after.valueUsd).toBeCloseTo(TERRA_CURRENT + LUNA_VALUE, 9);
		const breakdown = after.modelBreakdown as Record<
			string,
			ReturnType<typeof entry>
		>;
		expect(breakdown[TERRA].valueUsd).toBeCloseTo(TERRA_CURRENT, 9);
	});
});
