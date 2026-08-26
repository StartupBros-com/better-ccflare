import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { CLAUDE_MODEL_IDS } from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type {
	AlertEvent,
	AlertsConfigPayload,
	RequestResponse,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	AlertService,
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
	anomalyBaselineWindowMinutes: 1440,
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

describe("evaluateAnomalies leave-one-out contract (issue #410 regression)", () => {
	function makeAnomalyConfig(
		overrides: Partial<{
			anomalyIntervalMinutes: number;
			anomalyBaselineWindowMinutes: number;
			loopMinRequests: number;
		}> = {},
	): Config {
		return Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 0,
			get: (_key: string, defaultValue?: string | number | boolean) =>
				defaultValue,
			getAlertAnomalyEnabled: () => true,
			getAlertAnomalyIntervalMinutes: () =>
				overrides.anomalyIntervalMinutes ?? 30,
			getAlertAnomalyBaselineWindowMinutes: () =>
				overrides.anomalyBaselineWindowMinutes ?? 60,
			getAlertAnomalyLoopMinRequests: () => overrides.loopMinRequests ?? 10_000,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
	}

	async function seedRequest(
		adapter: BunSqlAdapter,
		row: {
			id: string;
			timestamp: number;
			inputTokens?: number;
			outputTokens?: number;
			model?: string;
		},
	): Promise<void> {
		await adapter.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
				 input_tokens, output_tokens, cache_read_input_tokens,
				 cache_creation_input_tokens)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, 100, 0, ?, ?, 0, ?, ?, 0, 0)`,
			[
				row.id,
				row.timestamp,
				row.model ?? "claude-opus-4-8",
				(row.inputTokens ?? 0) + (row.outputTokens ?? 0),
				row.inputTokens ?? 0,
				row.outputTokens ?? 0,
			],
		);
	}

	test("scoring rows never double as their own baseline population when all rows fall inside the scoring window", async () => {
		// Regression for issue #410: the old code derived scoringRows as a
		// .filter() of the SAME array used as baselineRows, so every scored
		// row was also a member of its own baseline population. This test
		// seeds 20 rows (>= the default minBaselineRequests of 20) ALL inside
		// the scoring window (timestamp >= scoringSince) and NONE older —
		// i.e. baselineRows must come up EMPTY under the disjoint-partition
		// fix. With an empty baseline, computeBaselines produces no baseline
		// entry at all, so NO outlier alert can fire, no matter how extreme
		// one of the scored values is.
		//
		// Under the OLD buggy code, these same 20 rows would ALSO have been
		// used as baselineRows (since baselineRows was the whole fetched
		// window, unfiltered), which would satisfy minBaselineRequests and
		// let the huge spike row flag itself as an outlier against a
		// baseline that includes itself — exactly the contract violation
		// this PR fixes.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 30,
			anomalyBaselineWindowMinutes: 60,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			// 19 rows with a normal 3-value spread, all within the last 30
			// minutes (inside the scoring window: timestamp >= now - 30min).
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 19; i++) {
				await seedRequest(adapter, {
					id: `scoring-normal-${i}`,
					timestamp: now - i * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One huge spike, also inside the scoring window.
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 500,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			// No baseline could be formed (0 rows older than scoringSince), so
			// nothing can be flagged — proves scoringRows is no longer a
			// subset of baselineRows.
			expect(outlierAlerts).toHaveLength(0);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("a spike in the scoring window flags only when a genuinely disjoint OLDER baseline exists, and the flagged id is never one of the baseline ids", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 5,
			anomalyBaselineWindowMinutes: 60,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			const scoringSince = now - 5 * 60 * 1000;
			const baselineIds: string[] = [];
			// 21 baseline rows, strictly OLDER than the 5-minute scoring
			// window (between 10 and 55 minutes ago), with a 3-value spread
			// for a non-degenerate MAD.
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				const id = `baseline-${i}`;
				baselineIds.push(id);
				await seedRequest(adapter, {
					id,
					timestamp: scoringSince - (10 + i) * 60 * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One spike inside the scoring window (last 5 minutes).
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 1000,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			expect(outlierAlerts).toHaveLength(1);
			expect(outlierAlerts[0]?.requestId).toBe("scoring-spike");
			// The flagged request id must never be one of the ids that fed the
			// baseline population — the two sets are genuinely disjoint.
			expect(baselineIds).not.toContain(outlierAlerts[0]?.requestId);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("a baseline window SHORTER than the scoring interval still produces a non-empty baseline population (issue #410 follow-up review fix)", async () => {
		// Regression: the query window used to be
		// Math.max(baselineWindowMinutes, intervalMinutes), which collapses to
		// just intervalMinutes whenever baselineWindowMinutes <= intervalMinutes
		// (a valid config combination — nothing prevents
		// anomalyBaselineWindowMinutes from being set lower than
		// anomalyIntervalMinutes). That made the query fetch ONLY the scoring
		// interval's worth of history, so every fetched row had
		// timestamp >= scoringSince, baselineRows came up empty, and no
		// outlier could ever be flagged for this config — a silent
		// false-negative regression.
		//
		// Here baseline=30min, interval=120min (baseline < interval). Rows are
		// seeded both inside the scoring window (last 120 minutes) AND further
		// back, within the 30-minute baseline-before-scoring range (i.e.
		// between 120 and 150 minutes ago). Under the fixed additive query
		// window (baselineWindowMinutes + intervalMinutes = 150 minutes), the
		// older rows are fetched and land in baselineRows; under the old
		// Math.max bug they would never even be queried.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 120,
			anomalyBaselineWindowMinutes: 30,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			const scoringSince = now - 120 * 60 * 1000;
			const baselineIds: string[] = [];
			// 21 baseline rows strictly OLDER than the 120-minute scoring
			// window, within the 30-minute baseline range before it (i.e.
			// between 121 and 149 minutes ago), 3-value spread for a
			// non-degenerate MAD.
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				const id = `baseline-${i}`;
				baselineIds.push(id);
				await seedRequest(adapter, {
					id,
					timestamp: scoringSince - (1 + i) * 60 * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One spike inside the scoring window.
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 1000,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			// A non-empty, genuinely older baseline population must have been
			// available, so the spike is flagged.
			expect(outlierAlerts).toHaveLength(1);
			expect(outlierAlerts[0]?.requestId).toBe("scoring-spike");
			expect(baselineIds).not.toContain(outlierAlerts[0]?.requestId);
		} finally {
			service.stop();
			sqlite.close();
		}
	});
});

describe("anomaly alert cooldown scope (issue #411 regression)", () => {
	test("anomaly_token_outlier and anomaly_output_blowup are scoped by account:model, not requestId", () => {
		// Before the fix, buildThresholdAlertId was called with event.requestId
		// as the scope — unique per request — so the cooldown time-bucket could
		// never dedupe two distinct outlier requests, no matter how close in
		// time. Scoping by account:model (matching the anomaly_runaway_loop and
		// anomaly_model_misrouting pattern) lets same-bucket requests collide.
		const first = buildThresholdAlertId(
			"anomaly_token_outlier",
			"acct:model-a",
			123_456,
			60,
		);
		const second = buildThresholdAlertId(
			"anomaly_token_outlier",
			"acct:model-a",
			200_000,
			60,
		);
		expect(first).toBe(second);

		const blowupFirst = buildThresholdAlertId(
			"anomaly_output_blowup",
			"acct:model-a",
			123_456,
			60,
		);
		const blowupSecond = buildThresholdAlertId(
			"anomaly_output_blowup",
			"acct:model-a",
			200_000,
			60,
		);
		expect(blowupFirst).toBe(blowupSecond);

		// A different model must still get its own bucket.
		const differentModel = buildThresholdAlertId(
			"anomaly_token_outlier",
			"acct:model-b",
			123_456,
			60,
		);
		expect(differentModel).not.toBe(first);
	});

	test("an account literally named 'Unknown' does not share a cooldown bucket with a request that has no account at all (greptile review follow-up)", async () => {
		// TokenOutlierEvent.account/.model are already normalized for display
		// (null -> the literal string "Unknown") before alerts.ts ever sees
		// them, so a scope built from those display fields alone — even with
		// a safe separator — cannot tell a real account named "Unknown" apart
		// from a request with no account. This test proves the actual fix:
		// the cooldown scope is built from event.accountRaw/.modelRaw (the
		// pre-normalization fields), so the two cases get independent
		// buckets and neither spike alert is swallowed by the other's
		// cooldown.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 0,
			get: (_key: string, defaultValue?: string | number | boolean) =>
				defaultValue,
			getAlertAnomalyEnabled: () => true,
			getAlertAnomalyIntervalMinutes: () => 5,
			getAlertAnomalyBaselineWindowMinutes: () => 60,
			getAlertAnomalyLoopMinRequests: () => 10_000,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
		const service = new AlertService(adapter, config);

		async function seedGroup(
			accountName: string | null,
			idPrefix: string,
		): Promise<void> {
			// requests.account_used is a foreign key into accounts.id, and the
			// anomaly query joins to accounts.name for display — so a request
			// attributed to a real account must have a matching accounts row,
			// or the join always yields NULL regardless of account_used.
			const accountUsed = accountName === null ? null : `${idPrefix}-account`;
			if (accountName !== null) {
				await adapter.run(
					`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`,
					[accountUsed, accountName, Date.now()],
				);
			}
			const now = Date.now();
			const scoringSince = now - 5 * 60 * 1000;
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				await adapter.run(
					`INSERT INTO requests
						(id, timestamp, method, path, account_used, status_code, success,
						 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
						 input_tokens, output_tokens, cache_read_input_tokens,
						 cache_creation_input_tokens)
					 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, 'model-a', ?, 0, ?, 0, 0, 0)`,
					[
						`${idPrefix}-baseline-${i}`,
						scoringSince - (10 + i) * 60 * 1000,
						accountUsed,
						spreadValues[i % spreadValues.length],
						spreadValues[i % spreadValues.length],
					],
				);
			}
			await adapter.run(
				`INSERT INTO requests
					(id, timestamp, method, path, account_used, status_code, success,
					 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
					 input_tokens, output_tokens, cache_read_input_tokens,
					 cache_creation_input_tokens)
				 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, 'model-a', ?, 0, ?, 0, 0, 0)`,
				[`${idPrefix}-spike`, now - 1000, accountUsed, 100_000, 100_000],
			);
		}

		try {
			// Group 1: no account attribution at all (account_used IS NULL).
			await seedGroup(null, "noacct");
			// Group 2: a real account whose name is literally "Unknown".
			await seedGroup("Unknown", "literal");

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			// Both spikes must be flagged independently — if the cooldown scope
			// collapsed null and the literal "Unknown" into one bucket, only
			// one of these two would have persisted.
			const flaggedIds = outlierAlerts.map((a) => a.requestId).sort();
			expect(flaggedIds).toEqual(["literal-spike", "noacct-spike"]);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("a request with no model does not share a cooldown bucket with a request whose model is a NUL character (greptile review follow-up)", async () => {
		// `model` is attacker-controlled — taken verbatim from the inbound
		// request's JSON `model` field with no charset restriction, unlike
		// account names. A fixed sentinel string for "no model" (e.g. a NUL
		// character) would alias a request with no model at all with a
		// request whose model happens to equal that exact sentinel. This
		// test proves encodeScopePart's length-prefix encoding keeps the two
		// cases in independent cooldown buckets regardless of what
		// characters a real model value contains.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 0,
			get: (_key: string, defaultValue?: string | number | boolean) =>
				defaultValue,
			getAlertAnomalyEnabled: () => true,
			getAlertAnomalyIntervalMinutes: () => 5,
			getAlertAnomalyBaselineWindowMinutes: () => 60,
			getAlertAnomalyLoopMinRequests: () => 10_000,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
		const service = new AlertService(adapter, config);

		async function seedGroup(
			model: string | null,
			idPrefix: string,
		): Promise<void> {
			const now = Date.now();
			const scoringSince = now - 5 * 60 * 1000;
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				await adapter.run(
					`INSERT INTO requests
						(id, timestamp, method, path, account_used, status_code, success,
						 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
						 input_tokens, output_tokens, cache_read_input_tokens,
						 cache_creation_input_tokens)
					 VALUES (?, ?, 'POST', '/v1/messages', 'acct', 200, 1, 100, 0, ?, ?, 0, ?, 0, 0, 0)`,
					[
						`${idPrefix}-baseline-${i}`,
						scoringSince - (10 + i) * 60 * 1000,
						model,
						spreadValues[i % spreadValues.length],
						spreadValues[i % spreadValues.length],
					],
				);
			}
			await adapter.run(
				`INSERT INTO requests
					(id, timestamp, method, path, account_used, status_code, success,
					 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
					 input_tokens, output_tokens, cache_read_input_tokens,
					 cache_creation_input_tokens)
				 VALUES (?, ?, 'POST', '/v1/messages', 'acct', 200, 1, 100, 0, ?, ?, 0, ?, 0, 0, 0)`,
				[`${idPrefix}-spike`, now - 1000, model, 100_000, 100_000],
			);
		}

		try {
			await adapter.run(
				`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`,
				["acct", "acct", Date.now()],
			);
			// Group 1: no model attribution at all (model IS NULL).
			await seedGroup(null, "nomodel");
			// Group 2: a request whose model is literally a NUL character —
			// the exact value the old fixed-sentinel encoding aliased with null.
			await seedGroup("\x00", "nulmodel");

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			const flaggedIds = outlierAlerts.map((a) => a.requestId).sort();
			expect(flaggedIds).toEqual(["nomodel-spike", "nulmodel-spike"]);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("two distinct outlier requests on the same account/model within one cooldown bucket only persist one alert", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 0,
			get: (_key: string, defaultValue?: string | number | boolean) =>
				defaultValue,
			getAlertAnomalyEnabled: () => true,
			getAlertAnomalyIntervalMinutes: () => 5,
			getAlertAnomalyBaselineWindowMinutes: () => 60,
			getAlertAnomalyLoopMinRequests: () => 10_000,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			const scoringSince = now - 5 * 60 * 1000;
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				await adapter.run(
					`INSERT INTO requests
						(id, timestamp, method, path, account_used, status_code, success,
						 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
						 input_tokens, output_tokens, cache_read_input_tokens,
						 cache_creation_input_tokens)
					 VALUES (?, ?, 'POST', '/v1/messages', 'acct', 200, 1, 100, 0, 'model-a', ?, 0, ?, 0, 0, 0)`,
					[
						`baseline-${i}`,
						scoringSince - (10 + i) * 60 * 1000,
						spreadValues[i % spreadValues.length],
						spreadValues[i % spreadValues.length],
					],
				);
			}
			// Two distinct spike requests, same account+model, both inside the
			// same 60-minute cooldown bucket. Pre-fix, both would have fired
			// (scope = requestId, unique per row); post-fix, only the first
			// should persist and the second must be swallowed by the cooldown.
			for (const id of ["spike-1", "spike-2"]) {
				await adapter.run(
					`INSERT INTO requests
						(id, timestamp, method, path, account_used, status_code, success,
						 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
						 input_tokens, output_tokens, cache_read_input_tokens,
						 cache_creation_input_tokens)
					 VALUES (?, ?, 'POST', '/v1/messages', 'acct', 200, 1, 100, 0, 'model-a', ?, 0, ?, 0, 0, 0)`,
					[id, now - 1000, 100_000, 100_000],
				);
			}

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			expect(outlierAlerts).toHaveLength(1);
		} finally {
			service.stop();
			sqlite.close();
		}
	});
});
