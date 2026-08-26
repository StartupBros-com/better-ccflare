/**
 * Unit tests for AlertService.evaluateClosedWindow — the usage_window_value_drop
 * alert (issue #252's Window Value Ledger, task P1.6). Unlike the two
 * usage-window alert types covered in usage-window-alert.test.ts (which
 * evaluate a live/open window's utilization), this evaluates one just-CLOSED
 * window against the median of its priced prior closed siblings, called
 * directly by UsageWindowLedger.closeAndValue after a successful close (see
 * usage-window-ledger.test.ts's "alertService wiring" describe block for the
 * ledger-side wiring/isolation tests — this file only covers the alert
 * decision logic itself).
 *
 * Two planted negatives (per the P1.6 task brief) get their own explicit
 * tests: firing with fewer than 2 priced priors, and double-firing on the
 * same closed window.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import type {
	UsageWindow,
	UsageWindowGrantType,
} from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { AlertEvent } from "@better-ccflare/types";
import { AlertService } from "../alerts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "acct-1";
const WINDOW_KEY = "seven_day";

/**
 * Fake Config mirroring the real class's generic get/set semantics (a first
 * read with a default PERSISTS that default, exactly like
 * packages/config/src/index.ts's get()) — evaluateClosedWindow's threshold
 * lookup goes through this generic accessor rather than a dedicated typed
 * getter (packages/config is out of scope for task P1.6; see the comment
 * above ALERT_USAGE_WINDOW_VALUE_DROP_THRESHOLD_KEY in ../alerts.ts).
 */
function makeConfig(
	overrides: Partial<{
		usageWindowValueDropThreshold: number;
		cooldownMinutes: number;
	}> = {},
): Config {
	const store = new Map<string, string | number | boolean>();
	if (overrides.usageWindowValueDropThreshold !== undefined) {
		store.set(
			"alert_usage_window_value_drop_threshold",
			overrides.usageWindowValueDropThreshold,
		);
	}
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () => 90,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 60,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => overrides.cooldownMinutes ?? 60,
		getAlertWebhookUrl: () => "",
		get: (
			key: string,
			defaultValue?: string | number | boolean,
		): string | number | boolean | undefined => {
			if (store.has(key)) return store.get(key);
			if (defaultValue !== undefined) {
				store.set(key, defaultValue);
				return defaultValue;
			}
			return undefined;
		},
		set: (key: string, value: string | number | boolean): void => {
			store.set(key, value);
		},
	}) as unknown as Config;
}

let priorIdCounter = 0;

/** Seeds one priced, closed prior sibling window directly into usage_windows
 * — evaluateClosedWindow reads priors with raw SQL, so no repository/ledger
 * round-trip is needed to set these up. */
function seedClosedWindow(
	sqlite: Database,
	opts: {
		accountId?: string;
		windowKey?: string;
		valueUsd: number;
		closedAt: number;
		startedAt?: number;
		resetsAt?: number;
		grantType?: UsageWindowGrantType;
	},
): void {
	priorIdCounter += 1;
	const accountId = opts.accountId ?? ACCOUNT_ID;
	const windowKey = opts.windowKey ?? WINDOW_KEY;
	const resetsAt = opts.resetsAt ?? opts.closedAt;
	const startedAt = opts.startedAt ?? resetsAt - SEVEN_DAYS_MS;
	sqlite.run(
		`INSERT INTO usage_windows (
			id, account_id, window_key, started_at, resets_at, closed_at,
			grant_type, peak_utilization, value_usd
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			`prior-${priorIdCounter}`,
			accountId,
			windowKey,
			startedAt,
			resetsAt,
			opts.closedAt,
			opts.grantType ?? "natural",
			100,
			opts.valueUsd,
		],
	);
}

/** Builds the just-CLOSED window object evaluateClosedWindow is called with —
 * this is exactly the shape UsageWindowLedger.closeAndValue constructs
 * (`{ ...window, ...closeInput }`) right after a successful close. It is
 * deliberately NOT inserted into usage_windows: evaluateClosedWindow only
 * queries PRIOR rows filtered by `id != window.id`, so a window that isn't
 * in the table at all satisfies that filter just as well and keeps these
 * tests focused on the alert decision, not persistence plumbing. */
function buildClosedWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
	const resetsAt = overrides.resetsAt ?? 1_800_000_000_000 + SEVEN_DAYS_MS;
	const startedAt = overrides.startedAt ?? resetsAt - SEVEN_DAYS_MS;
	return {
		id: "closed-window-under-test",
		accountId: ACCOUNT_ID,
		windowKey: WINDOW_KEY,
		startedAt,
		resetsAt,
		closedAt: resetsAt,
		grantType: "natural",
		peakUtilization: 100,
		first100At: null,
		valueUsd: 5,
		inputTokens: 1000,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 500,
		requestCount: 5,
		modelBreakdown: null,
		unpricedTokens: 0,
		projectionVersion: "v1",
		...overrides,
	};
}

describe("AlertService.evaluateClosedWindow (usage_window_value_drop)", () => {
	let sqlite: Database;
	let service: AlertService;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
	});

	afterEach(() => {
		sqlite.close();
	});

	it("does not fire with zero priced prior closed windows (planted negative)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		const window = buildClosedWindow({ valueUsd: 0.01 });

		await service.evaluateClosedWindow(window, "Primary account");

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("does not fire with exactly one priced prior closed window (planted negative)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - SEVEN_DAYS_MS,
		});
		const window = buildClosedWindow({ valueUsd: 0.01 });

		await service.evaluateClosedWindow(window, "Primary account");

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("does not fire when the closed value is within the configured threshold of the median", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		// Two priors, both $10 -> median $10. Default threshold 0.25 -> drop
		// floor is $7.50. $8 is below the median but NOT below the floor.
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - SEVEN_DAYS_MS,
		});
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - 2 * SEVEN_DAYS_MS,
		});
		const window = buildClosedWindow({ valueUsd: 8 });

		await service.evaluateClosedWindow(window, "Primary account");

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("fires below the configured threshold with account, window boundaries, closed value, median, percent-below, and grant_type in the message", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		// Priors $10 and $12 -> median $11. Default threshold 0.25 -> drop
		// floor $8.25. Closed value $5 is well below that floor.
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - SEVEN_DAYS_MS,
		});
		seedClosedWindow(sqlite, {
			valueUsd: 12,
			closedAt: 1_800_000_000_000 - 2 * SEVEN_DAYS_MS,
		});
		const window = buildClosedWindow({
			valueUsd: 5,
			grantType: "early_reset",
		});

		await service.evaluateClosedWindow(window, "Primary account");

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_value_drop",
		);
		expect(alerts).toHaveLength(1);
		const alert = alerts[0] as AlertEvent;
		expect(alert.severity).toBe("warning");
		expect(alert.value).toBe(5);
		expect(alert.threshold).toBe(0.25);
		expect(alert.account).toBe("Primary account");
		expect(alert.message).toContain("Primary account");
		expect(alert.message).toContain(new Date(window.startedAt).toISOString());
		expect(alert.message).toContain(new Date(window.resetsAt).toISOString());
		expect(alert.message).toContain("5.00");
		expect(alert.message).toContain("11.00");
		// (11 - 5) / 11 * 100 = 54.5454...% -> toFixed(1) = "54.5"
		expect(alert.message).toContain("54.5");
		expect(alert.message).toContain("early_reset");
	});

	it("dedups: evaluating the same closed window twice persists exactly one alert (planted negative)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - SEVEN_DAYS_MS,
		});
		seedClosedWindow(sqlite, {
			valueUsd: 12,
			closedAt: 1_800_000_000_000 - 2 * SEVEN_DAYS_MS,
		});
		const window = buildClosedWindow({ valueUsd: 5 });

		await service.evaluateClosedWindow(window, "Primary account");
		// Simulates a retried close invoking evaluation for the exact same
		// already-closed window a second time.
		await service.evaluateClosedWindow(window, "Primary account");

		const alerts = (await service.listAlerts()).filter(
			(a) => a.type === "usage_window_value_drop",
		);
		expect(alerts).toHaveLength(1);
	});

	it("respects a configured threshold override", async () => {
		// Median $10 (two $10 priors). Default threshold (0.25) drop floor is
		// $7.50 -> $8 would NOT fire. A tighter override (0.1) raises the
		// floor to $9 -> $8 DOES fire.
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - SEVEN_DAYS_MS,
		});
		seedClosedWindow(sqlite, {
			valueUsd: 10,
			closedAt: 1_800_000_000_000 - 2 * SEVEN_DAYS_MS,
		});
		const window = buildClosedWindow({ valueUsd: 8 });

		const defaultService = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig(),
		);
		await defaultService.evaluateClosedWindow(window, "Primary account");
		expect(
			(await defaultService.listAlerts()).filter(
				(a) => a.type === "usage_window_value_drop",
			),
		).toHaveLength(0);

		const overriddenService = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ usageWindowValueDropThreshold: 0.1 }),
		);
		await overriddenService.evaluateClosedWindow(window, "Primary account");
		const alerts = (await overriddenService.listAlerts()).filter(
			(a) => a.type === "usage_window_value_drop",
		);
		expect(alerts).toHaveLength(1);
		expect((alerts[0] as AlertEvent).threshold).toBe(0.1);
	});
});
