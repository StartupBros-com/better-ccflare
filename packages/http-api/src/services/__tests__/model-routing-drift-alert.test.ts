/**
 * End-to-end AlertService tests for the model_routing_drift alert (the
 * "Opus 5 incident" detector): a stored combo policy silently rewrote every
 * claude-opus-5 request to claude-opus-4-8 for hours because the policy
 * pinned the old model. Two staleness classes are covered:
 *
 *  - stale_policy: the proxy reports a combo override (comboModelOverride)
 *    that rewrote traffic AWAY from the family's current canonical latest
 *    model.
 *  - unknown_model: a client requested a plausibly-shaped Claude model ID
 *    that isn't in the bundled catalog (CLAUDE_MODEL_IDS) - the day-0 signal
 *    that packages/core/src/models.ts needs a bump.
 *
 * These run through the real async pipeline (AlertService.evaluateRequest,
 * which is what the requestEvents "summary" listener calls), backed by a
 * real in-memory SQLite database, mirroring the harness in
 * auth-failure-alert.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { CLAUDE_MODEL_IDS, requestEvents } from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { AlertEvent, RequestResponse } from "@better-ccflare/types";
import { AlertService } from "../alerts";

function makeConfig(
	overrides: Partial<{ cooldownMinutes: number }> = {},
): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyLoopMinRequests: () => 10,
		getAlertCooldownMinutes: () => overrides.cooldownMinutes ?? 60,
		getAlertWebhookUrl: () => "",
	}) as unknown as Config;
}

function baseRequest(
	overrides: Partial<RequestResponse> = {},
): RequestResponse {
	return {
		id: "req-1",
		timestamp: new Date().toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "account-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 100,
		failoverAttempts: 0,
		project: null,
		...overrides,
	};
}

describe("AlertService model_routing_drift alerts", () => {
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

	// Severity is `warning`, not `critical`, and deliberately so: the check
	// cannot distinguish a stale policy from a deliberate pinned-fallback slot
	// (a documented feature), so firing critical on supported configuration
	// would train operators to mute the channel. See buildStalePolicyDriftAlert.
	it("persists a warning stale_policy alert for the Opus 5 incident shape", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(
			baseRequest({
				id: "req-incident",
				comboModelOverride: {
					from: CLAUDE_MODEL_IDS.OPUS_5,
					to: CLAUDE_MODEL_IDS.OPUS_4_8,
				},
			}),
		);

		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		const alert = alerts[0] as AlertEvent;
		expect(alert.type).toBe("model_routing_drift");
		expect(alert.severity).toBe("warning");
		expect(alert.message).toContain(
			`opus routing policy rewrites ${CLAUDE_MODEL_IDS.OPUS_5} -> ${CLAUDE_MODEL_IDS.OPUS_4_8}`,
		);
		expect(alert.model).toBe(CLAUDE_MODEL_IDS.OPUS_4_8);
	});

	it("is silent for a healthy upgrade (rewrite lands on the family's latest)", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(
			baseRequest({
				comboModelOverride: {
					from: CLAUDE_MODEL_IDS.OPUS_4_8,
					to: CLAUDE_MODEL_IDS.OPUS_5,
				},
			}),
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("does not persist stale_policy alerts for cross-family fallback slots", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(
			baseRequest({
				comboModelOverride: {
					from: CLAUDE_MODEL_IDS.FABLE_5,
					to: CLAUDE_MODEL_IDS.OPUS_5,
				},
			}),
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("is silent for agent-preference rewrites (comboModelOverride null) even though original/applied differ", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(
			baseRequest({
				comboModelOverride: null,
				originalModel: CLAUDE_MODEL_IDS.SONNET_5,
				appliedModel: CLAUDE_MODEL_IDS.OPUS_5,
				model: CLAUDE_MODEL_IDS.OPUS_5,
			}),
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("collapses repeated stale_policy triggers into one alert per cooldown window (INSERT OR IGNORE)", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ cooldownMinutes: 1440 }),
		);
		service.start();

		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.OPUS_5,
				to: CLAUDE_MODEL_IDS.OPUS_4_8,
			},
		});
		await service.evaluateRequest(request);
		await service.evaluateRequest(request);
		await service.evaluateRequest({ ...request, id: "req-2" });

		expect(await service.listAlerts()).toHaveLength(1);
	});

	it("fires unknown_model for a plausibly-shaped model missing from the catalog", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(baseRequest({ model: "claude-opus-6" }));

		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		const alert = alerts[0] as AlertEvent;
		expect(alert.type).toBe("model_routing_drift");
		expect(alert.severity).toBe("warning");
		expect(alert.message).toContain("clients are requesting claude-opus-6");
		expect(alert.message).toContain("not in the bundled model catalog");
	});

	it("dedupes distinct unknown model strings in the same family into one persisted alert", async () => {
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ cooldownMinutes: 1440 }),
		);
		service.start();

		await service.evaluateRequest(
			baseRequest({ id: "req-a", model: "claude-opus-6" }),
		);
		await service.evaluateRequest(
			baseRequest({ id: "req-b", model: "claude-opus-6-preview" }),
		);

		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
	});

	it("never fires unknown_model for a known CLAUDE_MODEL_IDS value", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		await service.evaluateRequest(
			baseRequest({ model: CLAUDE_MODEL_IDS.OPUS_5 }),
		);
		await service.evaluateRequest(
			baseRequest({ id: "req-2", model: CLAUDE_MODEL_IDS.SONNET_4_5 }),
		);

		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("evaluates asynchronously off the requestEvents summary listener, not a direct call from the proxy", async () => {
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		requestEvents.emit("event", {
			type: "summary",
			payload: baseRequest({
				id: "req-via-event",
				comboModelOverride: {
					from: CLAUDE_MODEL_IDS.OPUS_5,
					to: CLAUDE_MODEL_IDS.OPUS_4_8,
				},
			}),
		});

		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await service.listAlerts()).length > 0) break;
			await Bun.sleep(5);
		}
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.type).toBe("model_routing_drift");
	});
});
