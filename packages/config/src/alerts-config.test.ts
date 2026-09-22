import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEYS = [
	"ALERT_DAILY_SPEND_USD",
	"ALERT_TOKENS_PER_HOUR",
	"ALERT_REQUEST_TOKENS",
	"ALERT_USAGE_WINDOW_THRESHOLD_PERCENT",
	"ALERT_ANOMALY_ENABLED",
	"ALERT_ANOMALY_INTERVAL_MINUTES",
	"ALERT_ANOMALY_BASELINE_WINDOW_MINUTES",
	"ALERT_ANOMALY_LOOP_MIN_REQUESTS",
	"ALERT_COOLDOWN_MINUTES",
	"ALERT_WEBHOOK_URL",
	"ALERT_WEBHOOK_TYPES",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
	ORIGINAL_ENV[key] = process.env[key];
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("alert config settings", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("returns defaults when nothing is configured", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(0);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(90);
			expect(config.getAlertAnomalyEnabled()).toBe(false);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(15);
			expect(config.getAlertAnomalyBaselineWindowMinutes()).toBe(1440);
			expect(config.getAlertAnomalyLoopMinRequests()).toBe(25);
			expect(config.getAlertCooldownMinutes()).toBe(60);
			expect(config.getAlertWebhookUrl()).toBe("");
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("honors environment variable overrides", () => {
		process.env.ALERT_DAILY_SPEND_USD = "25.5";
		process.env.ALERT_TOKENS_PER_HOUR = "500000";
		process.env.ALERT_REQUEST_TOKENS = "200000";
		process.env.ALERT_USAGE_WINDOW_THRESHOLD_PERCENT = "75";
		process.env.ALERT_ANOMALY_ENABLED = "true";
		process.env.ALERT_ANOMALY_INTERVAL_MINUTES = "30";
		process.env.ALERT_ANOMALY_BASELINE_WINDOW_MINUTES = "720";
		process.env.ALERT_ANOMALY_LOOP_MIN_REQUESTS = "40";
		process.env.ALERT_COOLDOWN_MINUTES = "120";
		process.env.ALERT_WEBHOOK_URL = "https://example.com/hook";
		process.env.ALERT_WEBHOOK_TYPES = "auth_failure, model_routing_drift";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(25.5);
			expect(config.getAlertTokensPerHour()).toBe(500000);
			expect(config.getAlertRequestTokens()).toBe(200000);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(75);
			expect(config.getAlertAnomalyEnabled()).toBe(true);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(30);
			expect(config.getAlertAnomalyBaselineWindowMinutes()).toBe(720);
			expect(config.getAlertAnomalyLoopMinRequests()).toBe(40);
			expect(config.getAlertCooldownMinutes()).toBe(120);
			expect(config.getAlertWebhookUrl()).toBe("https://example.com/hook");
			expect(config.getAlertWebhookTypes()).toEqual([
				"auth_failure",
				"model_routing_drift",
			]);
		} finally {
			cleanup();
		}
	});

	it("treats non-true anomaly env values as disabled", () => {
		process.env.ALERT_ANOMALY_ENABLED = "disabled";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertAnomalyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range environment values", () => {
		process.env.ALERT_DAILY_SPEND_USD = "-5";
		process.env.ALERT_TOKENS_PER_HOUR = "9999999999";
		process.env.ALERT_REQUEST_TOKENS = "-100";
		process.env.ALERT_USAGE_WINDOW_THRESHOLD_PERCENT = "150";
		process.env.ALERT_ANOMALY_INTERVAL_MINUTES = "2";
		process.env.ALERT_ANOMALY_BASELINE_WINDOW_MINUTES = "10";
		process.env.ALERT_ANOMALY_LOOP_MIN_REQUESTS = "9999";
		process.env.ALERT_COOLDOWN_MINUTES = "0";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000_000);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(100);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(5);
			expect(config.getAlertAnomalyBaselineWindowMinutes()).toBe(60);
			expect(config.getAlertAnomalyLoopMinRequests()).toBe(1000);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range config-file values via setters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(2_000_000);
			expect(config.getAlertDailySpendUsd()).toBe(1_000_000);

			config.setAlertUsageWindowThresholdPercent(150);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(100);

			config.setAlertUsageWindowThresholdPercent(-10);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(0);

			config.setAlertAnomalyIntervalMinutes(3);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(5);

			config.setAlertAnomalyIntervalMinutes(99999);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(1440);

			config.setAlertAnomalyBaselineWindowMinutes(1);
			expect(config.getAlertAnomalyBaselineWindowMinutes()).toBe(60);

			config.setAlertAnomalyBaselineWindowMinutes(999999);
			expect(config.getAlertAnomalyBaselineWindowMinutes()).toBe(43200);

			config.setAlertAnomalyLoopMinRequests(1);
			expect(config.getAlertAnomalyLoopMinRequests()).toBe(5);

			config.setAlertAnomalyLoopMinRequests(99999);
			expect(config.getAlertAnomalyLoopMinRequests()).toBe(1000);

			config.setAlertCooldownMinutes(0);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("persists setter values readable by getters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(50);
			config.setAlertTokensPerHour(1_000_000);
			config.setAlertRequestTokens(300_000);
			config.setAlertUsageWindowThresholdPercent(80);
			config.setAlertAnomalyEnabled(true);
			config.setAlertCooldownMinutes(45);
			config.setAlertWebhookUrl("https://hooks.example.com/alert");

			expect(config.getAlertDailySpendUsd()).toBe(50);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000);
			expect(config.getAlertRequestTokens()).toBe(300_000);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(80);
			expect(config.getAlertAnomalyEnabled()).toBe(true);
			expect(config.getAlertCooldownMinutes()).toBe(45);
			expect(config.getAlertWebhookUrl()).toBe(
				"https://hooks.example.com/alert",
			);
		} finally {
			cleanup();
		}
	});

	it("accepts an empty webhook URL (disabled) and rejects invalid ones", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(() => config.setAlertWebhookUrl("")).not.toThrow();
			expect(config.getAlertWebhookUrl()).toBe("");

			expect(() => config.setAlertWebhookUrl("not-a-url")).toThrow();
			expect(() => config.setAlertWebhookUrl("ftp://example.com")).toThrow();
			expect(() =>
				config.setAlertWebhookUrl("http://example.com/hook"),
			).not.toThrow();
		} finally {
			cleanup();
		}
	});

	it("includes alert settings in getAllSettings()", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			const settings = config.getAllSettings();
			expect(settings.alert_daily_spend_usd).toBe(0);
			expect(settings.alert_tokens_per_hour).toBe(0);
			expect(settings.alert_request_tokens).toBe(0);
			expect(settings.alert_usage_window_threshold_percent).toBe(90);
			expect(settings.alert_anomaly_enabled).toBe(false);
			expect(settings.alert_anomaly_interval_minutes).toBe(15);
			expect(settings.alert_anomaly_baseline_window_minutes).toBe(1440);
			expect(settings.alert_anomaly_loop_min_requests).toBe(25);
			expect(settings.alert_cooldown_minutes).toBe(60);
			expect(settings.alert_webhook_url).toBe("");
			expect(settings.alert_webhook_types).toBe("");
		} finally {
			cleanup();
		}
	});
});

describe("alert webhook type allowlist", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("defaults to delivering all types (empty allowlist)", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("persists a setter value readable by the getter, normalized and de-duplicated", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes(
				"Auth_Failure, model_routing_drift,auth_failure",
			);
			expect(config.getAlertWebhookTypes()).toEqual([
				"auth_failure",
				"model_routing_drift",
			]);
		} finally {
			cleanup();
		}
	});

	it("clearing to an empty string re-enables delivering all types", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes("auth_failure");
			expect(config.getAlertWebhookTypes()).toEqual(["auth_failure"]);

			config.setAlertWebhookTypes("");
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("rejects an unknown alert type name", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(() =>
				config.setAlertWebhookTypes("auth_failure,not_a_real_alert_type"),
			).toThrow();
			// The rejected write must not have partially applied.
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("rejects an oversized list containing an unknown type instead of silently allowing all", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			// 65 comma-separated tokens (one past the internal 64-token cap),
			// padded with a valid, repeated type plus one unknown name. The
			// write path must still fail loudly on the unknown name rather
			// than silently short-circuiting the oversized list to "deliver
			// all" (the getter's safe fallback, not the setter's contract).
			const tokens = Array.from({ length: 64 }, () => "auth_failure");
			tokens.push("not_a_real_alert_type");
			expect(() => config.setAlertWebhookTypes(tokens.join(","))).toThrow();
			// The rejected write must not have partially applied.
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("env var overrides the file value, including an explicit empty override", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes("auth_failure");
			process.env.ALERT_WEBHOOK_TYPES = "model_routing_drift";
			expect(config.getAlertWebhookTypes()).toEqual(["model_routing_drift"]);

			process.env.ALERT_WEBHOOK_TYPES = "";
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});
});
