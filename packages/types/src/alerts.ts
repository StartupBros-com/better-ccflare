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
	| "usage_window_exhaustion_projected"
	/** A usage window CLOSED (fully settled and priced) with a value
	 * markedly lower than its recent history: closedValue fell more than
	 * the configured fraction below the median of its priced prior closed
	 * siblings. Unlike the two alerts above, this evaluates a settled
	 * window after the fact rather than an open window's live utilization
	 * — see AlertService.evaluateClosedWindow and
	 * UsageWindowLedger.closeAndValue in packages/http-api/src/services/
	 * (alerts.ts, usage-window-ledger.ts), issue #252's Window Value
	 * Ledger. Needs at least two priced prior closed windows to have a
	 * baseline; with fewer, it never fires. */
	| "usage_window_value_drop"
	| "cache_efficiency_low"
	| "cache_efficiency_critical"
	| "cache_telemetry_gap"
	| "cache_efficiency_recovered"
	/** info: a Codex account's own catalog moved a family's AUTOMATIC role
	 * target (the model unpinned families follow). Fires once per new target.
	 * Webhook opt-in: see WEBHOOK_OPT_IN_ALERT_TYPES. */
	| "codex_role_target_changed"
	/** info: a pinned Codex family's model is still offered but is no longer
	 * the catalog's role target. An intentional pin is not an error. Webhook
	 * opt-in: see WEBHOOK_OPT_IN_ALERT_TYPES. */
	| "codex_pin_superseded"
	/** warning: a pinned Codex family's model is absent from the account's
	 * own fresh catalog. */
	| "codex_pin_unavailable"
	/** warning: an account's own Codex catalog is old and its latest refresh
	 * failed, so routing is still serving the last-good catalog. */
	| "codex_catalog_stale"
	/** warning: a catalog-role route profile failed closed. */
	| "codex_route_role_unavailable"
	/** warning: a configured verified Codex CLI version record is stale or
	 * unreadable — the managed updater has stalled. */
	| "codex_identity_record_stale";

/**
 * Every known `AlertType` value, in the same order as the union above. The
 * single source of truth for validating a caller-supplied alert type name
 * (e.g. `ALERT_WEBHOOK_TYPES` / `alert_webhook_types`, see
 * packages/config/src/index.ts's parseAlertWebhookTypes) — a hand-maintained
 * duplicate list would silently drift the day a new AlertType is added.
 */
export const ALERT_TYPES: readonly AlertType[] = [
	"daily_spend",
	"tokens_per_hour",
	"request_tokens",
	"anomaly_token_outlier",
	"anomaly_output_blowup",
	"anomaly_runaway_loop",
	"anomaly_model_misrouting",
	"auth_failure",
	"model_routing_drift",
	"usage_window_threshold",
	"usage_window_exhaustion_projected",
	"usage_window_value_drop",
	"cache_efficiency_low",
	"cache_efficiency_critical",
	"cache_telemetry_gap",
	"cache_efficiency_recovered",
	"codex_role_target_changed",
	"codex_pin_superseded",
	"codex_pin_unavailable",
	"codex_catalog_stale",
	"codex_route_role_unavailable",
	"codex_identity_record_stale",
];

const ALERT_TYPE_SET: ReadonlySet<string> = new Set(ALERT_TYPES);

/** Type guard: is `value` one of the known `AlertType` names? */
export function isAlertType(value: string): value is AlertType {
	return ALERT_TYPE_SET.has(value);
}

/**
 * Informational alert types that an EMPTY webhook allowlist does not deliver:
 * they are recorded, listed and streamed to the dashboard, but reach the
 * webhook only when the operator names them in `ALERT_WEBHOOK_TYPES` /
 * `alert_webhook_types`. Healthy adoption of a new model and an intentional
 * pin are not worth a push notification by default.
 *
 * Every type that existed before this list keeps its original delivery (an
 * empty allowlist still delivers it); only types added here opt out.
 */
export const WEBHOOK_OPT_IN_ALERT_TYPES: readonly AlertType[] = [
	"codex_role_target_changed",
	"codex_pin_superseded",
];

const WEBHOOK_OPT_IN_ALERT_TYPE_SET: ReadonlySet<string> = new Set(
	WEBHOOK_OPT_IN_ALERT_TYPES,
);

/** True for types an empty webhook allowlist keeps in-app only. */
export function isWebhookOptInAlertType(type: AlertType): boolean {
	return WEBHOOK_OPT_IN_ALERT_TYPE_SET.has(type);
}

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
	/** Fraction (0-1) a closed usage window's priced value must fall below
	 * the median of its recent priced prior closed windows before
	 * usage_window_value_drop fires — e.g. 0.25 fires once the closed
	 * value is more than 25% below that median. Optional (unlike its
	 * sibling thresholds above) so a hand-built payload that omits it
	 * still satisfies this type; getAlertsConfig always populates a real
	 * number (default 0.25). See AlertService.evaluateClosedWindow. */
	usageWindowValueDropThreshold?: number;
	/** Optional so older settings clients preserve the saved cache policy. */
	cacheHealthEnabled?: boolean;
	cacheHealthThresholdPercent?: number;
	/** Whole ten-minute buckets; the default is thirty minutes. */
	cacheHealthDurationMinutes?: number;
	cacheHealthMinRequests?: number;
	cacheHealthMinInputTokens?: number;
	cacheHealthReminderMinutes?: number;
	anomalyEnabled: boolean;
	anomalyIntervalMinutes: number;
	/**
	 * Minutes of trailing history used to build token baselines (median/MAD),
	 * decoupled from anomalyIntervalMinutes (which only controls how often new
	 * rows are scored). Must be a stable window distinct from the rows being
	 * scored so a request is never scored against a baseline it is a member of.
	 */
	anomalyBaselineWindowMinutes: number;
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
