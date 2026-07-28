import { describe, expect, test } from "bun:test";
import { CLAUDE_MODEL_IDS } from "@better-ccflare/core";
import type {
	AlertEvent,
	AlertsConfigPayload,
	RequestResponse,
} from "@better-ccflare/types";
import {
	buildModelRoutingDriftAlerts,
	buildRequestTokenAlert,
	buildStalePolicyDriftAlert,
	buildThresholdAlertId,
	buildUnknownModelDriftAlert,
	shouldFireAlert,
} from "../alerts";

const CONFIG: AlertsConfigPayload = {
	dailySpendUsd: 10,
	tokensPerHour: 100_000,
	requestTokens: 50_000,
	anomalyEnabled: false,
	anomalyIntervalMinutes: 15,
	cooldownMinutes: 60,
	webhookUrl: "",
};

describe("alert threshold helpers", () => {
	test("buildThresholdAlertId is stable for the cooldown bucket", () => {
		expect(buildThresholdAlertId("request_tokens", "req-1", 123_456, 60)).toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
		expect(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000, 60),
		).not.toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
	});

	test("shouldFireAlert respects disabled and threshold values", () => {
		expect(shouldFireAlert(0, 50)).toBe(false);
		expect(shouldFireAlert(10, 9)).toBe(false);
		expect(shouldFireAlert(10, 10)).toBe(true);
		expect(shouldFireAlert(10, 11)).toBe(true);
	});

	test("buildRequestTokenAlert returns null below threshold", () => {
		expect(
			buildRequestTokenAlert(
				{
					id: "req-1",
					timestamp: "2026-06-10T10:00:00.000Z",
					method: "POST",
					path: "/v1/messages",
					accountUsed: "acct",
					statusCode: 200,
					success: true,
					errorMessage: null,
					responseTimeMs: 100,
					failoverAttempts: 0,
					totalTokens: 49_999,
				},
				CONFIG,
			),
		).toBeNull();
	});

	test("buildRequestTokenAlert emits a critical alert at threshold", () => {
		const alert = buildRequestTokenAlert(
			{
				id: "req-2",
				timestamp: "2026-06-10T10:00:00.000Z",
				method: "POST",
				path: "/v1/messages",
				accountUsed: "acct",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTimeMs: 100,
				failoverAttempts: 0,
				model: "model-a",
				project: "proj",
				totalTokens: 50_000,
			},
			CONFIG,
		) as AlertEvent;

		expect(alert.type).toBe("request_tokens");
		expect(alert.severity).toBe("critical");
		expect(alert.value).toBe(50_000);
		expect(alert.threshold).toBe(50_000);
		expect(alert.requestId).toBe("req-2");
		expect(alert.model).toBe("model-a");
		expect(alert.project).toBe("proj");
		expect(alert.acknowledged).toBe(false);
	});
});

function baseRequest(
	overrides: Partial<RequestResponse> = {},
): RequestResponse {
	return {
		id: "req-drift",
		timestamp: "2026-07-24T10:00:00.000Z",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 100,
		failoverAttempts: 0,
		...overrides,
	};
}

const DRIFT_TIMESTAMP = 1_800_000_000_000;

describe("model_routing_drift: stale_policy (Opus 5 incident)", () => {
	test("fires when the stored policy pins the family's current latest model away from itself", () => {
		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.OPUS_5,
				to: CLAUDE_MODEL_IDS.OPUS_4_8,
			},
		});
		const alert = buildStalePolicyDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(alert).not.toBeNull();
		expect(alert.type).toBe("model_routing_drift");
		// warning, not critical: this predicate also matches a deliberate
		// pinned-fallback slot, so critical would fire on supported config.
		expect(alert.severity).toBe("warning");
		expect(alert.id).toBe(
			buildThresholdAlertId(
				"model_routing_drift",
				`stale_policy:opus:${CLAUDE_MODEL_IDS.OPUS_4_8}`,
				DRIFT_TIMESTAMP,
				CONFIG.cooldownMinutes,
			),
		);
		expect(alert.message).toContain(
			`opus routing policy rewrites ${CLAUDE_MODEL_IDS.OPUS_5} -> ${CLAUDE_MODEL_IDS.OPUS_4_8}`,
		);
		expect(alert.message).toContain(
			`${CLAUDE_MODEL_IDS.OPUS_5} is the current latest opus model`,
		);
		// The message must NOT assert staleness as fact: a deliberate pinned
		// fallback slot produces this exact shape, so the wording has to offer
		// both readings (severity is asserted above).
		expect(alert.message).toContain(
			"If this combo is meant to track the latest model",
		);
		expect(alert.message).toContain("deliberate pin, no action is needed");
		expect(alert.message).toContain("'opus' alias");
		expect(alert.model).toBe(CLAUDE_MODEL_IDS.OPUS_4_8);
		expect(alert.requestId).toBe(request.id);
		expect(alert.acknowledged).toBe(false);
	});

	test("is silent for a healthy upgrade (rewrite lands ON the family's latest)", () => {
		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.OPUS_4_8,
				to: CLAUDE_MODEL_IDS.OPUS_5,
			},
		});
		expect(
			buildStalePolicyDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP),
		).toEqual([]);
	});

	test("is silent for agent-preference rewrites (comboModelOverride null) even when original/applied differ", () => {
		const request = baseRequest({
			comboModelOverride: null,
			originalModel: CLAUDE_MODEL_IDS.SONNET_5,
			appliedModel: CLAUDE_MODEL_IDS.OPUS_5,
			model: CLAUDE_MODEL_IDS.OPUS_5,
		});
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP),
		).toEqual([]);
	});
});

describe("model_routing_drift: unknown_model (day-0 catalog gap)", () => {
	test("fires for a plausibly-shaped model missing from CLAUDE_MODEL_IDS", () => {
		const request = baseRequest({ model: "claude-opus-6" });
		const alert = buildUnknownModelDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(alert).not.toBeNull();
		expect(alert.type).toBe("model_routing_drift");
		expect(alert.severity).toBe("warning");
		expect(alert.message).toContain(
			"clients are requesting claude-opus-6 (family opus)",
		);
		expect(alert.message).toContain("not in the bundled model catalog");
		expect(alert.message).toContain(
			"bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy",
		);
		expect(alert.model).toBe("claude-opus-6");
	});

	test("dedupes distinct unknown model strings in the same family into one cooldown bucket", () => {
		const requestA = buildUnknownModelDriftAlert(
			baseRequest({ id: "req-a", model: "claude-opus-6" }),
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;
		const requestB = buildUnknownModelDriftAlert(
			baseRequest({ id: "req-b", model: "claude-opus-6-preview" }),
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(requestA).not.toBeNull();
		expect(requestB).not.toBeNull();
		// Scope is the family alone (not the literal requested string), so a
		// misbehaving client appending random suffixes cannot flood alerts.
		expect(requestA.id).toBe(requestB.id);
		expect(requestA.id).toBe(
			buildThresholdAlertId(
				"model_routing_drift",
				"unknown_model:opus",
				DRIFT_TIMESTAMP,
				CONFIG.cooldownMinutes,
			),
		);
	});

	test("uses the pre-override (client-requested) model when a rewrite occurred", () => {
		const request = baseRequest({
			model: CLAUDE_MODEL_IDS.OPUS_5,
			originalModel: "claude-opus-6",
			appliedModel: CLAUDE_MODEL_IDS.OPUS_5,
		});
		const alert = buildUnknownModelDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;
		expect(alert).not.toBeNull();
		expect(alert.model).toBe("claude-opus-6");
	});

	test("never fires for a known CLAUDE_MODEL_IDS value", () => {
		const request = baseRequest({ model: CLAUDE_MODEL_IDS.OPUS_5 });
		expect(
			buildUnknownModelDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		const request2 = baseRequest({ model: CLAUDE_MODEL_IDS.SONNET_4_5 });
		expect(
			buildUnknownModelDriftAlert(request2, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
	});

	test("never fires for a garbage string that merely contains a family substring", () => {
		// getModelFamily() is a substring match and would say "opus" here;
		// the shape guard (CLAUDE_MODEL_SHAPE_RE) must reject it first.
		const request = baseRequest({ model: "my-opus-experiment" });
		expect(
			buildUnknownModelDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
	});
});
