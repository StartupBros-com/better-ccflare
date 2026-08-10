/**
 * Types for the alerting system (issue #250): threshold rules,
 * anomaly-driven alerts, alert history, and alert configuration.
 *
 * Pure data shapes shared between the HTTP API, the alert engine,
 * and the dashboard.
 */

/** Severity level attached to an alert event. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Discriminates which rule or anomaly detector produced an alert. */
export type AlertType =
	| "daily_spend"
	| "tokens_per_hour"
	| "request_tokens"
	| "anomaly_token_outlier"
	| "anomaly_output_blowup"
	| "anomaly_runaway_loop"
	| "anomaly_model_misrouting"
	| "auth_failure"
	| "model_routing_drift"
	/** A usage window's (e.g. five_hour, seven_day) utilization crossed the
	 * configured threshold percent. See AlertService.evaluateUsageSnapshot in
	 * packages/http-api/src/services/alerts.ts. */
	| "usage_window_threshold"
	/** A usage window is at least 50% utilized and the server-side linear
	 * projection (computeUsagePrediction, packages/http-api/src/services/
	 * usage-prediction.ts) says it will exhaust before its resets_at. Fires
	 * unconditionally (no separate enable toggle), like model_routing_drift. */
	| "usage_window_exhaustion_projected";

/**
 * Discriminates the two staleness classes detected under the
 * `model_routing_drift` alert type (see AlertService.buildModelRoutingDriftAlerts
 * in packages/http-api/src/services/alerts.ts):
 * - `stale_policy`: a combo's stored model override rewrites traffic AWAY
 *   from what is currently the family's canonical latest model — the "Opus 5
 *   incident", where a pinned combo policy silently downgraded every request
 *   for hours after a new model released.
 * - `unknown_model`: a client requested a plausibly-shaped Claude model ID
 *   that isn't in the bundled catalog (CLAUDE_MODEL_IDS) — the day-0 signal
 *   that packages/core/src/models.ts itself needs a bump.
 *
 * There is no dedicated schema column for this discriminator (the `alerts`
 * table's fixed columns are shared by every alert type). Following how other
 * alert types pack extra semantics into the existing fields instead of a
 * generic payload, the reason is carried in the alert `id`'s cooldown-bucket
 * scope (`model_routing_drift:<reason>:...`, via buildThresholdAlertId) and
 * spelled out in `title`/`message`.
 */
export type ModelRoutingDriftReason = "stale_policy" | "unknown_model";

/** A single alert raised by the alert engine. */
export interface AlertEvent {
	id: string;
	/** ms epoch */
	timestamp: number;
	type: AlertType;
	severity: AlertSeverity;
	title: string;
	message: string;
	/** Observed value that triggered the alert. */
	value: number | null;
	/** Configured threshold (null for anomaly alerts). */
	threshold: number | null;
	account: string | null;
	model: string | null;
	project: string | null;
	requestId: string | null;
	acknowledged: boolean;
}

/** Full response of GET /api/alerts. */
export interface AlertHistoryResponse {
	alerts: AlertEvent[];
	unacknowledgedCount: number;
}

/** Alert configuration payload exchanged with the settings API. */
export interface AlertsConfigPayload {
	/** Daily spend threshold in USD; 0 = disabled. */
	dailySpendUsd: number;
	/** Tokens-per-hour threshold; 0 = disabled. */
	tokensPerHour: number;
	/** Per-request token threshold; 0 = disabled. */
	requestTokens: number;
	/** Usage-window utilization percent (0-100) that triggers
	 * usage_window_threshold; 0 = disabled. Does not gate
	 * usage_window_exhaustion_projected, which is unconditional. */
	usageWindowThresholdPercent: number;
	anomalyEnabled: boolean;
	anomalyIntervalMinutes: number;
	/**
	 * Minimum requests inside one (account, model, agent) window to qualify
	 * as a runaway loop. Default 25 — well above one agent's normal
	 * per-window traffic but still catches true repeated-request loops.
	 */
	loopMinRequests: number;
	cooldownMinutes: number;
	/** Webhook target URL; "" = disabled. */
	webhookUrl: string;
}
