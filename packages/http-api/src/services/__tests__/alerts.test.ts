import { describe, expect, test } from "bun:test";
import { CLAUDE_MODEL_IDS } from "@better-ccflare/core";
import type {
	AlertEvent,
	AlertsConfigPayload,
	RequestResponse,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	buildModelRoutingDriftAlerts,
	buildRequestTokenAlert,
	buildRunawayLoopAlertId,
	buildStalePolicyDriftAlert,
	buildThresholdAlertId,
	buildUnknownModelDriftAlert,
	buildUsageWindowAlertId,
	extractUsageWindows,
	shouldFireAlert,
} from "../alerts";

const CONFIG: AlertsConfigPayload = {
	dailySpendUsd: 10,
	tokensPerHour: 100_000,
	requestTokens: 50_000,
	usageWindowThresholdPercent: 90,
	anomalyEnabled: false,
	anomalyIntervalMinutes: 15,
	loopMinRequests: 10,
	cooldownMinutes: 60,
	webhookUrl: "",
};

const LOOP: RunawayLoopGroup = {
	account: "acct",
	model: "model-a",
	project: "proj-a",
	agentUsed: "agent-a",
	windowStartMs: 0,
	windowEndMs: 1,
	requests: 10,
	requestsPerMinute: 10,
	meanRequestSideTokens: 100,
	requestSideTokenSpread: 0,
};

describe("runaway-loop alert identity", () => {
	test("different projects produce distinct exact IDs for the same account, model, and agent", () => {
		const projectA = buildRunawayLoopAlertId(LOOP, 60);
		const projectB = buildRunawayLoopAlertId(
			{ ...LOOP, project: "proj-b" },
			60,
		);

		expect(projectA).toBe("anomaly_runaway_loop:acct:model-a:proj-a:agent-a:0");
		expect(projectB).toBe("anomaly_runaway_loop:acct:model-a:proj-b:agent-a:0");
		expect(projectA).not.toBe(projectB);
	});

	test("repeated evaluations of one group keep a stable cooldown ID", () => {
		const atBucketStart = buildRunawayLoopAlertId(LOOP, 60);
		const atBucketEnd = buildRunawayLoopAlertId(
			{ ...LOOP, windowEndMs: 3_600_000 - 1 },
			60,
		);

		expect(atBucketStart).toBe(atBucketEnd);
	});
});

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

describe("usage-window alert helpers", () => {
	test("buildUsageWindowAlertId is stable for the same window cycle regardless of poll timestamp", () => {
		const first = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		const second = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		expect(first).toBe(second);
	});

	test("buildUsageWindowAlertId re-arms when resets_at changes (new window cycle)", () => {
		const cycleOne = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		const cycleTwo = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_018_000_000, // +5h
		);
		expect(cycleOne).not.toBe(cycleTwo);
	});

	test("buildUsageWindowAlertId distinguishes account, window, and alert type", () => {
		const base = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		expect(
			buildUsageWindowAlertId(
				"usage_window_threshold",
				"acct-2",
				"five_hour",
				1_800_000_000_000,
			),
		).not.toBe(base);
		expect(
			buildUsageWindowAlertId(
				"usage_window_threshold",
				"acct-1",
				"seven_day",
				1_800_000_000_000,
			),
		).not.toBe(base);
		expect(
			buildUsageWindowAlertId(
				"usage_window_exhaustion_projected",
				"acct-1",
				"five_hour",
				1_800_000_000_000,
			),
		).not.toBe(base);
	});

	test("extractUsageWindows reads utilization + resets_at shaped windows and skips everything else", () => {
		const windows = extractUsageWindows({
			five_hour: { utilization: 42, resets_at: "2026-07-24T15:00:00.000Z" },
			seven_day: { utilization: 10, resets_at: null },
			// Not window-shaped: no numeric `utilization`.
			extra_usage: { enabled: true },
			// Not window-shaped: no `resets_at` key at all.
			spend: { percent: 12 },
			limits: [{ kind: "session", percent: 5 }],
		});

		expect(windows).toContainEqual({
			windowKey: "five_hour",
			utilization: 42,
			resetsAtMs: new Date("2026-07-24T15:00:00.000Z").getTime(),
		});
		expect(windows).toContainEqual({
			windowKey: "seven_day",
			utilization: 10,
			resetsAtMs: null,
		});
		expect(windows).toHaveLength(2);
	});

	test("extractUsageWindows drops a window whose resets_at is unparseable", () => {
		// A malformed reset is rejected by the canonical normalizer rather than
		// coerced to null, which would make it indistinguishable from a window
		// that legitimately has no cycle boundary (and from NaN arithmetic).
		const windows = extractUsageWindows({
			five_hour: { utilization: 42, resets_at: "not-a-date" },
		});
		expect(windows).toEqual([]);
	});

	test("extractUsageWindows keeps a window whose resets_at is explicitly null", () => {
		const windows = extractUsageWindows({
			five_hour: { utilization: 42, resets_at: null },
		});
		expect(windows).toEqual([
			{ windowKey: "five_hour", utilization: 42, resetsAtMs: null },
		]);
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

	test("is silent for an intentional cross-family fallback from latest Fable to Opus", () => {
		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.FABLE_5,
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
