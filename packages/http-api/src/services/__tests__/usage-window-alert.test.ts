/**
 * End-to-end AlertService tests for the two usage-window alert types
 * (OnWatch cherry-pick):
 *
 *  - usage_window_threshold: a window's utilization crossed the configured
 *    threshold percent (default 90).
 *  - usage_window_exhaustion_projected: utilization is >=50% and the
 *    server-side linear-regression projection (computeUsagePrediction) says
 *    the window exhausts before its resets_at.
 *
 * Dedup is the critical property under test: polls run every ~90s, so an
 * alert must fire ONCE per (account, window, resets_at) per window cycle —
 * not on every poll — and must re-arm once resets_at advances to a new
 * cycle. These run through the real async pipeline
 * (AlertService.evaluateUsageSnapshot), backed by a real in-memory SQLite
 * database, mirroring the harness in model-routing-drift-alert.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { AlertEvent } from "@better-ccflare/types";
import { AlertService } from "../alerts";

function makeConfig(
	overrides: Partial<{
		usageWindowThresholdPercent: number;
		cooldownMinutes: number;
	}> = {},
): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () =>
			overrides.usageWindowThresholdPercent ?? 90,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => overrides.cooldownMinutes ?? 60,
		getAlertWebhookUrl: () => "",
	}) as unknown as Config;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Insert a historical usage_snapshots row directly (mirrors what
 * dbOps.recordUsageSnapshot would have written on an earlier poll). */
function seedSnapshot(
	sqlite: Database,
	opts: {
		accountId: string;
		timestamp: number;
		windowKey: string;
		utilization: number;
		resetsAt: number | null;
	},
): void {
	sqlite.run(
		`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at) VALUES (?, ?, ?, ?, ?)`,
		[
			opts.accountId,
			opts.timestamp,
			opts.windowKey,
			opts.utilization,
			opts.resetsAt,
		],
	);
}

describe("AlertService usage-window alerts", () => {
	let sqlite: Database;
	let service: AlertService;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
	});

	afterEach(() => {
		service.stop();
		sqlite.close();
	});

	it("fires a usage_window_threshold alert once utilization crosses the configured threshold", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const now = 1_800_000_000_000;
		const resetsAtMs = now + FIVE_HOURS_MS;

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 92,
					resets_at: new Date(resetsAtMs).toISOString(),
				},
			},
			now,
		);

		const alerts = await service.listAlerts();
		const thresholdAlerts = alerts.filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(thresholdAlerts).toHaveLength(1);
		const alert = thresholdAlerts[0] as AlertEvent;
		expect(alert.severity).toBe("warning");
		expect(alert.value).toBe(92);
		expect(alert.threshold).toBe(90);
		expect(alert.account).toBe("Primary account");
		expect(alert.message).toContain("five_hour");
	});

	it("does not refire when resets_at jitters by fractions of a second between polls", async () => {
		// Providers recompute resets_at per response; sub-2s jitter around the
		// same instant is the norm (see WINDOW_RESET_MIN_ADVANCE_MS). The dedup
		// key must bucket that jitter or a >threshold window re-fires every poll.
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		const resetsAtMs = start + FIVE_HOURS_MS;
		for (const jitterMs of [0, 1879, -1200]) {
			await service.evaluateUsageSnapshot(
				"acct-1",
				"Primary account",
				{
					five_hour: {
						utilization: 92,
						resets_at: new Date(resetsAtMs + jitterMs).toISOString(),
					},
				},
				start + 90_000,
			);
		}

		const alerts = await service.listAlerts();
		expect(
			alerts.filter((a) => a.type === "usage_window_threshold"),
		).toHaveLength(1);
	});

	it("re-arms when resets_at advances by a real rollover (hours, not jitter)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		for (const cycle of [0, 1]) {
			await service.evaluateUsageSnapshot(
				"acct-1",
				"Primary account",
				{
					five_hour: {
						utilization: 92,
						resets_at: new Date(
							start + FIVE_HOURS_MS * (cycle + 1),
						).toISOString(),
					},
				},
				start + cycle * FIVE_HOURS_MS,
			);
		}

		const alerts = await service.listAlerts();
		expect(
			alerts.filter((a) => a.type === "usage_window_threshold"),
		).toHaveLength(2);
	});

	it("does not refire on a re-poll within the same window cycle", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		const resetsAtMs = start + FIVE_HOURS_MS;
		const usage = {
			five_hour: {
				utilization: 92,
				resets_at: new Date(resetsAtMs).toISOString(),
			},
		};

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			usage,
			start,
		);
		// Re-poll ~90s later, same window cycle (same resets_at), still above
		// threshold.
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			usage,
			start + 90_000,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(alerts).toHaveLength(1);
	});

	it("re-arms once resets_at advances to a new window cycle", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		const firstResetMs = start + FIVE_HOURS_MS;

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 95,
					resets_at: new Date(firstResetMs).toISOString(),
				},
			},
			start,
		);

		// Window rolled over: new resets_at, fresh cycle, still above threshold.
		const secondPollTs = firstResetMs + 1_000;
		const secondResetMs = firstResetMs + FIVE_HOURS_MS;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 91,
					resets_at: new Date(secondResetMs).toISOString(),
				},
			},
			secondPollTs,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(alerts).toHaveLength(2);
	});

	it("does not fire below the configured threshold", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const now = 1_800_000_000_000;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 89,
					resets_at: new Date(now + FIVE_HOURS_MS).toISOString(),
				},
			},
			now,
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("fires a usage_window_exhaustion_projected alert when utilization>=50 and the trend crosses 100% before reset", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			// Crossing-threshold disabled (0) so only the exhaustion-projection
			// path can fire — exhaustion projection has no separate toggle, it
			// is evaluated unconditionally like model_routing_drift.
			makeConfig({ usageWindowThresholdPercent: 0 }),
		);
		service.start();

		const now = 1_800_000_000_000;
		const resetsAtMs = now + 60 * 60 * 1000; // 1h to reset
		// Rising trend over the last 30 minutes: 40% -> 55% -> 70%, i.e. +60pp/hr.
		// Projected at reset: 70 + 60*1 = 130% >= 100% => willExhaustBeforeReset.
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 30 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 40,
			resetsAt: resetsAtMs,
		});
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 15 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 55,
			resetsAt: resetsAtMs,
		});

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 70,
					resets_at: new Date(resetsAtMs).toISOString(),
				},
			},
			now,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_exhaustion_projected",
		);
		expect(alerts).toHaveLength(1);
		const alert = alerts[0] as AlertEvent;
		expect(alert.severity).toBe("critical");
		expect(alert.value).toBe(70);
		expect(alert.account).toBe("Primary account");
	});

	it("does not fire the exhaustion projection for a flat trend, even above 50% utilization", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ usageWindowThresholdPercent: 0 }),
		);
		service.start();

		const now = 1_800_000_000_000;
		const resetsAtMs = now + 60 * 60 * 1000;
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 30 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 60,
			resetsAt: resetsAtMs,
		});
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 15 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 60,
			resetsAt: resetsAtMs,
		});

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 60,
					resets_at: new Date(resetsAtMs).toISOString(),
				},
			},
			now,
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("does not fire the exhaustion projection below 50% utilization even on a steep rise", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ usageWindowThresholdPercent: 0 }),
		);
		service.start();

		const now = 1_800_000_000_000;
		const resetsAtMs = now + 60 * 60 * 1000;
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 30 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 10,
			resetsAt: resetsAtMs,
		});
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 15 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 25,
			resetsAt: resetsAtMs,
		});

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 40,
					resets_at: new Date(resetsAtMs).toISOString(),
				},
			},
			now,
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("fires neither alert type when the crossing threshold is disabled (0) and utilization is below the 50% exhaustion floor", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ usageWindowThresholdPercent: 0 }),
		);
		service.start();

		const now = 1_800_000_000_000;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 30,
					resets_at: new Date(now + FIVE_HOURS_MS).toISOString(),
				},
			},
			now,
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("ignores windows without a resets_at (cannot dedup by cycle boundary safely)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const now = 1_800_000_000_000;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{ five_hour: { utilization: 99, resets_at: null } },
			now,
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("re-fires as critical when utilization escalates 92 -> 100 within one cycle", async () => {
		// The earlier warning must not consume the cycle's only dedup id and
		// silently swallow the exhaustion escalation (pro-gate finding): the
		// stage segment in the alert id gives warning and critical one firing
		// each per cycle.
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		const resetsAtMs = start + FIVE_HOURS_MS;
		for (const [pollOffset, utilization] of [
			[0, 92],
			[90_000, 100],
			[180_000, 100], // third poll must NOT fire a second critical
		] as const) {
			await service.evaluateUsageSnapshot(
				"acct-1",
				"Primary account",
				{
					five_hour: {
						utilization,
						resets_at: new Date(resetsAtMs).toISOString(),
					},
				},
				start + pollOffset,
			);
		}

		const alerts = (await service.listAlerts())
			.filter((a) => a.type === "usage_window_threshold")
			.sort((a, b) => a.timestamp - b.timestamp);
		expect(alerts.map((a) => a.severity)).toEqual(["warning", "critical"]);
	});

	it("escalates to critical severity at 100% utilization", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const now = 1_800_000_000_000;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 100,
					resets_at: new Date(now + FIVE_HOURS_MS).toISOString(),
				},
			},
			now,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(alerts).toHaveLength(1);
		expect((alerts[0] as AlertEvent).severity).toBe("critical");
	});

	it("evaluates limits[]-only payloads (session -> five_hour), matching what usage history records", async () => {
		// Limits-only Anthropic payloads carry NO flat windows — the evaluator
		// must fold limits[] or the alert feature silently dies for those
		// accounts (cross-model review finding).
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const now = 1_800_000_000_000;
		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				limits: [
					{
						kind: "session",
						percent: 95,
						resets_at: new Date(now + FIVE_HOURS_MS).toISOString(),
					},
					{ kind: "weekly_all", percent: 12, resets_at: null },
				],
			},
			now,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(alerts).toHaveLength(1);
		expect((alerts[0] as AlertEvent).message).toContain("five_hour");
	});

	it("excludes an already-persisted current-poll row from the regression input", async () => {
		// The caller records the current snapshot un-awaited; on SQLite that
		// insert commits before the evaluator's SELECT. Seed a poison row AT
		// the evaluation timestamp whose value (0%) would flatten the rising
		// trend if double-counted — the alert must still fire, proving the
		// current poll is represented exactly once (cross-model finding).
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ usageWindowThresholdPercent: 0 }),
		);
		service.start();

		const now = 1_800_000_000_000;
		const resetsAtMs = now + 60 * 60 * 1000;
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 30 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 40,
			resetsAt: resetsAtMs,
		});
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now - 15 * 60 * 1000,
			windowKey: "five_hour",
			utilization: 55,
			resetsAt: resetsAtMs,
		});
		// The "already committed" current poll — same timestamp, poison value.
		seedSnapshot(sqlite, {
			accountId: "acct-1",
			timestamp: now,
			windowKey: "five_hour",
			utilization: 0,
			resetsAt: resetsAtMs,
		});

		await service.evaluateUsageSnapshot(
			"acct-1",
			"Primary account",
			{
				five_hour: {
					utilization: 70,
					resets_at: new Date(resetsAtMs).toISOString(),
				},
			},
			now,
		);

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_exhaustion_projected",
		);
		expect(alerts).toHaveLength(1);
	});

	it("does not double-fire when jitter crosses a minute-bucket boundary", async () => {
		// A reset instant near the half-minute tie-break can round to adjacent
		// buckets under the documented <2s jitter. The adjacent-bucket dedup
		// check must treat those as the same cycle (correctness + cross-model
		// corroborated finding).
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		const start = 1_800_000_000_000;
		// Place the reset 29.6s past a minute boundary: +1879ms jitter crosses
		// the 30s rounding tie-break into the next bucket.
		const resetsAtMs = start + FIVE_HOURS_MS + 29_600;
		for (const jitterMs of [0, 1879]) {
			await service.evaluateUsageSnapshot(
				"acct-1",
				"Primary account",
				{
					five_hour: {
						utilization: 92,
						resets_at: new Date(resetsAtMs + jitterMs).toISOString(),
					},
				},
				start + 90_000,
			);
		}

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_threshold",
		);
		expect(alerts).toHaveLength(1);
	});
});
