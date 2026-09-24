import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_HEALTH_DEFAULT_POLICY } from "@better-ccflare/types";
import { Config } from "./index";

const keys = [
	"ALERT_CACHE_HEALTH_ENABLED",
	"ALERT_CACHE_HEALTH_THRESHOLD_PERCENT",
	"ALERT_CACHE_HEALTH_DURATION_MINUTES",
	"ALERT_CACHE_HEALTH_MIN_REQUESTS",
	"ALERT_CACHE_HEALTH_MIN_INPUT_TOKENS",
	"ALERT_CACHE_HEALTH_REMINDER_MINUTES",
] as const;

describe("cache health configuration", () => {
	let directory: string;
	let config: Config;
	let original: (string | undefined)[];
	beforeEach(() => {
		original = keys.map((key) => process.env[key]);
		for (const key of keys) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "cache-health-config-"));
		config = new Config(join(directory, "config.json"));
	});
	afterEach(() => {
		keys.forEach((key, index) => {
			if (original[index] === undefined) delete process.env[key];
			else process.env[key] = original[index];
		});
		rmSync(directory, { recursive: true, force: true });
	});

	it("exports policy defaults without opting new types into a saved allowlist", () => {
		config.set("alert_webhook_types", "auth_failure,model_routing_drift");
		expect(config.getAlertCacheHealthEnabled()).toBe(true);
		expect(config.getAlertCacheHealthThresholdPercent()).toBe(
			CACHE_HEALTH_DEFAULT_POLICY.warningPercent,
		);
		expect(config.getAlertCacheHealthDurationMinutes()).toBe(30);
		expect(config.getAlertCacheHealthMinRequests()).toBe(10);
		expect(config.getAlertCacheHealthMinInputTokens()).toBe(100_000);
		expect(config.getAlertCacheHealthReminderMinutes()).toBe(360);
		expect(config.getAllSettings()).toMatchObject({
			alert_cache_health_enabled: true,
			alert_cache_health_threshold_percent: 90,
			alert_cache_health_duration_minutes: 30,
			alert_cache_health_min_requests: 10,
			alert_cache_health_min_input_tokens: 100_000,
			alert_cache_health_reminder_minutes: 360,
		});
		expect(config.get("alert_webhook_types")).toBe(
			"auth_failure,model_routing_drift",
		);
	});

	it("persists settings and honors env overrides without rewriting the file", () => {
		config.setAlertCacheHealthEnabled(false);
		config.setAlertCacheHealthThresholdPercent(85);
		config.setAlertCacheHealthDurationMinutes(60);
		config.setAlertCacheHealthMinRequests(20);
		config.setAlertCacheHealthMinInputTokens(200_000);
		config.setAlertCacheHealthReminderMinutes(720);
		const reloaded = new Config(join(directory, "config.json"));
		expect(reloaded.getAllSettings()).toMatchObject({
			alert_cache_health_enabled: false,
			alert_cache_health_duration_minutes: 60,
		});
		const values = ["true", "95", "40", "15", "150000", "180"];
		keys.forEach((key, index) => {
			process.env[key] = values[index];
		});
		expect(reloaded.getAllSettings()).toMatchObject({
			alert_cache_health_enabled: true,
			alert_cache_health_threshold_percent: 95,
			alert_cache_health_duration_minutes: 40,
			alert_cache_health_min_requests: 15,
			alert_cache_health_min_input_tokens: 150_000,
			alert_cache_health_reminder_minutes: 180,
		});
		for (const key of keys) delete process.env[key];
		expect(reloaded.getAlertCacheHealthThresholdPercent()).toBe(85);
	});

	it("clamps finite values, quantizes duration upward, and replaces nonfinite values with defaults", () => {
		config.setAlertCacheHealthThresholdPercent(101);
		config.setAlertCacheHealthDurationMinutes(31);
		config.setAlertCacheHealthMinRequests(-1);
		config.setAlertCacheHealthMinInputTokens(Number.NaN);
		config.setAlertCacheHealthReminderMinutes(Number.POSITIVE_INFINITY);
		expect(config.getAlertCacheHealthThresholdPercent()).toBe(100);
		expect(config.getAlertCacheHealthDurationMinutes()).toBe(40);
		expect(config.getAlertCacheHealthMinRequests()).toBe(1);
		expect(config.getAlertCacheHealthMinInputTokens()).toBe(100_000);
		expect(config.getAlertCacheHealthReminderMinutes()).toBe(360);
		config.setAlertCacheHealthMinRequests(10.9);
		expect(config.getAlertCacheHealthMinRequests()).toBe(10);
		process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT = "90garbage";
		process.env.ALERT_CACHE_HEALTH_DURATION_MINUTES = "Infinity";
		process.env.ALERT_CACHE_HEALTH_MIN_REQUESTS = "";
		expect(config.getAlertCacheHealthThresholdPercent()).toBe(90);
		expect(config.getAlertCacheHealthDurationMinutes()).toBe(30);
		expect(config.getAlertCacheHealthMinRequests()).toBe(10);
	});
});
