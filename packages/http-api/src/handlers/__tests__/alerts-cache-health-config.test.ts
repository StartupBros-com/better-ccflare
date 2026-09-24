import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { getAlertsConfig, setAlertsConfig } from "../../services/alerts";
import type { APIContext } from "../../types";
import {
	createAlertsConfigGetHandler,
	createAlertsConfigSetHandler,
} from "../alerts";

describe("cache health alert config API", () => {
	let directory: string;
	let config: Config;
	let context: APIContext;
	let environment: Record<string, string | undefined>;
	beforeEach(() => {
		environment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("ALERT_")),
		);
		for (const key of Object.keys(environment)) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "cache-health-handler-"));
		config = new Config(join(directory, "config.json"));
		context = { config } as APIContext;
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		for (const key of Object.keys(process.env))
			if (key.startsWith("ALERT_")) delete process.env[key];
		Object.assign(process.env, environment);
	});
	const update = (body: unknown) =>
		createAlertsConfigSetHandler(context)(
			new Request("http://fixture/api/insights/alerts/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	it("roundtrips optional cache fields, preserving omissions, destination and allowlist", async () => {
		config.setAlertWebhookUrl("https://example.com/existing");
		config.setAlertWebhookTypes("auth_failure,model_routing_drift");
		const response = await update({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
		});
		await update({ dailySpendUsd: 25 });
		expect(await createAlertsConfigGetHandler(context)().json()).toMatchObject({
			dailySpendUsd: 25,
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 88,
			cacheHealthDurationMinutes: 60,
			cacheHealthMinRequests: 12,
			cacheHealthMinInputTokens: 120_000,
			cacheHealthReminderMinutes: 720,
			webhookUrl: "https://example.com/existing",
		});
		expect(config.get("alert_webhook_types")).toBe(
			"auth_failure,model_routing_drift",
		);
	});

	it("does not rewrite omitted file values with env overrides", async () => {
		config.setAlertCacheHealthThresholdPercent(80);
		process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT = "95";
		expect(await (await update({ dailySpendUsd: 12 })).json()).toMatchObject({
			cacheHealthThresholdPercent: 95,
		});
		delete process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT;
		expect(config.getAlertCacheHealthThresholdPercent()).toBe(80);
	});

	it("keeps direct callers with old payloads compatible", () => {
		config.setAlertCacheHealthDurationMinutes(80);
		const payload = getAlertsConfig(config);
		delete payload.cacheHealthEnabled;
		delete payload.cacheHealthThresholdPercent;
		delete payload.cacheHealthDurationMinutes;
		delete payload.cacheHealthMinRequests;
		delete payload.cacheHealthMinInputTokens;
		delete payload.cacheHealthReminderMinutes;
		setAlertsConfig(config, payload);
		expect(config.getAlertCacheHealthDurationMinutes()).toBe(80);
	});

	it("normalizes numeric API inputs without poisoning policy with NaN", async () => {
		expect(
			await (
				await update({
					cacheHealthEnabled: "false",
					cacheHealthThresholdPercent: "Infinity",
					cacheHealthDurationMinutes: 31,
					cacheHealthMinRequests: 0,
					cacheHealthMinInputTokens: "bad",
					cacheHealthReminderMinutes: -1,
				})
			).json(),
		).toMatchObject({
			cacheHealthEnabled: false,
			cacheHealthThresholdPercent: 90,
			cacheHealthDurationMinutes: 40,
			cacheHealthMinRequests: 1,
			cacheHealthMinInputTokens: 100_000,
			cacheHealthReminderMinutes: 1,
		});
	});
});
