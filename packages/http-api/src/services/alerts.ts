import type { Config } from "@better-ccflare/config";
import {
	type AlertEvt,
	type AuthFailureEvt,
	alertEvents,
	authFailureEvents,
	computeWindowStartMs,
	getModelFamily,
	getModelRates,
	isValidModelId,
	LATEST_MODEL_BY_FAMILY,
	type RequestEvt,
	requestEvents,
	weeklyScopedWindowKey,
} from "@better-ccflare/core";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type {
	AlertEvent,
	AlertsConfigPayload,
	AlertType,
	PredictionPoint,
	RequestResponse,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	sanitizeProjectForDisplay,
} from "./anomaly-insights";
import { computeUsagePrediction } from "./usage-prediction";

const log = new Logger("AlertsService");
const HOUR_MS = 60 * 60 * 1000;
const MAX_ANOMALY_ALERTS_PER_RUN = 25;
/** Usage windows below this utilization are never worth projecting — too
 * little signal, and a false-positive "exhaustion" alert on a near-empty
 * window would train operators to ignore the channel. */
const USAGE_WINDOW_EXHAUSTION_MIN_UTILIZATION = 50;
/** Historical lookback bound when a window's fixed duration is unknown
 * (computeWindowStartMs returns null for window keys outside
 * FIXED_WINDOW_DURATION_MS, e.g. a provider-specific credits window). Covers
 * the longest known fixed window (seven_day = 7d) plus slack; the
 * segmentation inside computeUsagePrediction still cuts to the current
 * window via resets_at, so over-fetching here is safe, just wasted rows. */
const USAGE_WINDOW_HISTORY_FALLBACK_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

interface AlertRow {
	id: string;
	timestamp: number;
	type: AlertType;
	severity: AlertEvent["severity"];
	title: string;
	message: string;
	value: number | null;
	threshold: number | null;
	account: string | null;
	model: string | null;
	project: string | null;
	request_id: string | null;
	acknowledged: number;
}

interface DailySpendRow {
	total: number | null;
}

interface TokensPerHourRow {
	total: number | null;
}

interface UsageSnapshotSqlRow {
	timestamp: number;
	utilization: number;
	resets_at: number | null;
}

interface AnomalySqlRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	agent_used: string | null;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

export function getAlertsConfig(config: Config): AlertsConfigPayload {
	return {
		dailySpendUsd: config.getAlertDailySpendUsd(),
		tokensPerHour: config.getAlertTokensPerHour(),
		requestTokens: config.getAlertRequestTokens(),
		usageWindowThresholdPercent: config.getAlertUsageWindowThresholdPercent(),
		anomalyEnabled: config.getAlertAnomalyEnabled(),
		anomalyIntervalMinutes: config.getAlertAnomalyIntervalMinutes(),
		loopMinRequests: config.getAlertAnomalyLoopMinRequests(),
		cooldownMinutes: config.getAlertCooldownMinutes(),
		webhookUrl: config.getAlertWebhookUrl(),
	};
}

export function setAlertsConfig(
	config: Config,
	payload: AlertsConfigPayload,
): void {
	// Validate webhookUrl before mutating any fields to avoid partial config state.
	// setAlertWebhookUrl throws ValidationError for non-http(s) URLs; all other
	// setters only clamp/coerce and never throw.
	config.setAlertWebhookUrl(payload.webhookUrl);
	config.setAlertDailySpendUsd(payload.dailySpendUsd);
	config.setAlertTokensPerHour(payload.tokensPerHour);
	config.setAlertRequestTokens(payload.requestTokens);
	config.setAlertUsageWindowThresholdPercent(
		payload.usageWindowThresholdPercent,
	);
	config.setAlertAnomalyEnabled(payload.anomalyEnabled);
	config.setAlertAnomalyIntervalMinutes(payload.anomalyIntervalMinutes);
	config.setAlertAnomalyLoopMinRequests(payload.loopMinRequests);
	config.setAlertCooldownMinutes(payload.cooldownMinutes);
}

export function shouldFireAlert(threshold: number, value: number): boolean {
	return threshold > 0 && value >= threshold;
}

export function buildThresholdAlertId(
	type: AlertType,
	scope: string,
	timestamp: number,
	cooldownMinutes: number,
): string {
	const bucketMs = Math.max(1, cooldownMinutes) * 60 * 1000;
	return `${type}:${scope}:${Math.floor(timestamp / bucketMs)}`;
}

export function buildRunawayLoopAlertId(
	loop: RunawayLoopGroup,
	cooldownMinutes: number,
): string {
	return buildThresholdAlertId(
		"anomaly_runaway_loop",
		`${loop.account}:${loop.model}:${loop.project ?? ""}:${loop.agentUsed ?? ""}`,
		loop.windowEndMs,
		cooldownMinutes,
	);
}

/** One usage window as reported by a provider's usage payload (mirrors the
 * `{ utilization, resets_at }` shape recognized by usage-history.repository.ts's
 * isWindow, so a window that lands in usage_snapshots is exactly the set this
 * also evaluates). `resetsAtMs` is null when `resets_at` is absent, null, or
 * unparseable. */
export interface ExtractedUsageWindow {
	windowKey: string;
	utilization: number;
	resetsAtMs: number | null;
}

/**
 * Maps a `limits[]` entry to the internal window_key. MUST stay in lockstep
 * with `limitWindowKey` in usage-history.repository.ts — the alert evaluator
 * and the history recorder must agree on which windows exist, or an account
 * gets a window persisted and charted but never alerted on (the exact gap
 * this shared mapping closes).
 */
function alertLimitWindowKey(limit: {
	kind?: string;
	scope?: { model?: { display_name?: string } | null } | null;
}): string | null {
	if (limit.kind === "session") return "five_hour";
	if (limit.kind === "weekly_all") return "seven_day";
	if (limit.kind === "weekly_scoped") {
		const name = limit.scope?.model?.display_name?.trim();
		return name ? weeklyScopedWindowKey(name) : null;
	}
	return null;
}

/**
 * Pulls every usage window out of a raw usage snapshot payload: the flat
 * `{ utilization: number, resets_at: ... }`-shaped entries (Anthropic's
 * five_hour/seven_day/..., Codex's mirrored shape, xAI's nested `credits`)
 * AND the generic `limits[]` array (session/weekly_all/weekly_scoped) that
 * limits-only Anthropic payloads carry INSTEAD of flat windows. The set of
 * windows this returns matches what usage-history.repository.ts records, so
 * everything persisted/charted is also alert-eligible.
 */
export function extractUsageWindows(
	usage: Record<string, unknown>,
): ExtractedUsageWindow[] {
	const windows: ExtractedUsageWindow[] = [];
	const seen = new Set<string>();
	for (const [windowKey, value] of Object.entries(usage)) {
		if (typeof value !== "object" || value === null) continue;
		const utilization = (value as { utilization?: unknown }).utilization;
		if (typeof utilization !== "number") continue;
		if (!("resets_at" in (value as object))) continue;
		const resetsAtRaw = (value as { resets_at?: unknown }).resets_at;
		let resetsAtMs: number | null = null;
		if (typeof resetsAtRaw === "string") {
			const ms = new Date(resetsAtRaw).getTime();
			resetsAtMs = Number.isFinite(ms) ? ms : null;
		}
		windows.push({ windowKey, utilization, resetsAtMs });
		seen.add(windowKey);
	}
	const limits = (usage as { limits?: unknown }).limits;
	if (Array.isArray(limits)) {
		for (const limit of limits) {
			if (typeof limit !== "object" || limit === null || !("kind" in limit))
				continue;
			const l = limit as {
				kind?: string;
				percent?: unknown;
				resets_at?: unknown;
				scope?: { model?: { display_name?: string } | null } | null;
			};
			if (typeof l.percent !== "number") continue;
			const windowKey = alertLimitWindowKey(l);
			// Skip unmapped kinds and windows already present as flat entries
			// (no double-evaluation of five_hour/seven_day).
			if (!windowKey || seen.has(windowKey)) continue;
			let resetsAtMs: number | null = null;
			if (typeof l.resets_at === "string") {
				const ms = new Date(l.resets_at).getTime();
				resetsAtMs = Number.isFinite(ms) ? ms : null;
			}
			windows.push({ windowKey, utilization: l.percent, resetsAtMs });
			seen.add(windowKey);
		}
	}
	return windows;
}

/**
 * Dedup key for the two usage-window alert types. Deliberately NOT bucketed
 * by cooldown-minutes like buildThresholdAlertId: a usage window's resets_at
 * is stable for the entire life of the window (polls run every ~90s but
 * resets_at only changes when the window actually rolls over), so keying
 * directly on resetsAtMs already gives exactly the required semantics —
 * fires once per (account, window, cycle), and re-arms the instant resets_at
 * advances to the next cycle.
 */
export function buildUsageWindowAlertId(
	type: "usage_window_threshold" | "usage_window_exhaustion_projected",
	accountId: string,
	windowKey: string,
	resetsAtMs: number,
): string {
	// Bucket to the nearest minute: providers recompute resets_at per
	// response and it jitters by fractions of a second around the same
	// instant (measured: 1554 of 1564 apparent advances were <2s jitter —
	// see WINDOW_RESET_MIN_ADVANCE_MS in usage-fetcher.ts). Keying on the
	// raw ms would re-fire the alert on nearly every poll; a real rollover
	// advances by hours, which always lands in a new bucket.
	const resetsAtMinuteBucket = Math.round(resetsAtMs / 60_000);
	return `${type}:${accountId}:${windowKey}:${resetsAtMinuteBucket}`;
}

function parseTimestamp(timestamp: string | number): number {
	if (typeof timestamp === "number") return timestamp;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function requestTokenTotal(request: RequestResponse): number {
	return (
		request.totalTokens ??
		(request.inputTokens ?? 0) +
			(request.cacheReadInputTokens ?? 0) +
			(request.cacheCreationInputTokens ?? 0) +
			(request.outputTokens ?? 0)
	);
}

export function buildRequestTokenAlert(
	request: RequestResponse,
	config: AlertsConfigPayload,
): AlertEvent | null {
	const totalTokens = requestTokenTotal(request);
	if (!shouldFireAlert(config.requestTokens, totalTokens)) return null;
	const timestamp = parseTimestamp(request.timestamp);
	return {
		id: buildThresholdAlertId(
			"request_tokens",
			request.id,
			timestamp,
			config.cooldownMinutes,
		),
		timestamp,
		type: "request_tokens",
		severity: "critical",
		title: "Single request token threshold exceeded",
		message: `Request ${request.id} used ${totalTokens.toLocaleString()} tokens, meeting the configured ${config.requestTokens.toLocaleString()} token threshold.`,
		value: totalTokens,
		threshold: config.requestTokens,
		account: request.accountUsed,
		model: request.model ?? null,
		project: request.project ?? null,
		requestId: request.id,
		acknowledged: false,
	};
}

// Plausible-shape guard for Claude model IDs. getModelFamily() is a cheap
// substring match (see packages/core/src/model-mappings.ts) that would
// otherwise fire on arbitrary strings that merely *contain* a family word
// (e.g. some unrelated identifier with "opus" inside it); this regex
// requires the string to actually look like a `claude-<family>...` model ID
// before we treat it as a genuine (if unrecognized) Claude model request.
const CLAUDE_MODEL_SHAPE_RE = /^claude-(opus|sonnet|haiku|fable)(-|$)/i;

/**
 * Detects the "Opus 5 incident" class of model-routing staleness: a combo
 * slot's stored model override rewrote a request AWAY from what is
 * currently the family's canonical latest model (LATEST_MODEL_BY_FAMILY)
 * to an older model in that same family. Cross-family rewrites are fallback
 * policy, not evidence that a family-specific latest-model pin went stale.
 * Only evaluated when the proxy itself reports a combo override applied via
 * `comboModelOverride` — agent-preference rewrites never populate that
 * field (see packages/proxy/src/usage-collector.ts), so they can never
 * trigger this alert. A healthy upgrade (from an older model to the new
 * latest) is silent because `from` is not the family's latest in that case.
 */
export function buildStalePolicyDriftAlert(
	request: RequestResponse,
	config: AlertsConfigPayload,
	timestamp: number,
): AlertEvent | null {
	const override = request.comboModelOverride;
	if (!override) return null;
	const { from, to } = override;
	const family = getModelFamily(from);
	if (!family) return null;
	if (getModelFamily(to) !== family) return null;
	if (LATEST_MODEL_BY_FAMILY[family] !== from) return null;
	// Severity is deliberately `warning`, not `critical`. This check cannot yet
	// distinguish a genuinely stale policy from an operator's DELIBERATE pin: a
	// combo fallback slot pinned to an older model is a documented, first-class
	// feature (docs/combos.md), and every failover onto such a slot rewrites the
	// family's latest model away — matching this predicate exactly. Firing
	// `critical` on supported configuration is how an alert channel gets muted,
	// which would then hide the real incident this exists to catch.
	// FOLLOW-UP: thread an intentionality signal (was the slot alias-configured,
	// or an explicit concrete pin?) from combo-membership-resolver through
	// RoutingCandidateMetadata -> StartMessage -> RequestResponse.comboModelOverride,
	// the same plumbing this feature already built for from/to. Once that exists,
	// this can fire only on genuine drift and be promoted back to `critical`.
	return {
		id: buildThresholdAlertId(
			"model_routing_drift",
			`stale_policy:${family}:${to}`,
			timestamp,
			config.cooldownMinutes,
		),
		timestamp,
		type: "model_routing_drift",
		severity: "warning",
		title: "Model routing policy may be stale",
		message: `${family} routing policy rewrites ${from} -> ${to}, and ${from} is the current latest ${family} model. If this combo is meant to track the latest model, update it or switch it to the '${family}' alias; if the older model is a deliberate pin, no action is needed.`,
		value: null,
		threshold: null,
		account: request.accountUsed,
		model: to,
		project: request.project ?? null,
		requestId: request.id,
		acknowledged: false,
	};
}

/**
 * Detects the day-0 signal that packages/core/src/models.ts itself needs a
 * bump: a client requested a plausibly-shaped Claude model ID that isn't in
 * the bundled catalog (CLAUDE_MODEL_IDS). Uses the pre-override
 * (client-requested) model when any rewrite occurred (combo or agent), else
 * the request's own model — mirroring how `originalModel`/`model` are
 * persisted (see packages/types/src/request.ts).
 */
export function buildUnknownModelDriftAlert(
	request: RequestResponse,
	config: AlertsConfigPayload,
	timestamp: number,
): AlertEvent | null {
	const requestedModel = request.originalModel ?? request.model;
	if (!requestedModel) return null;
	if (!CLAUDE_MODEL_SHAPE_RE.test(requestedModel)) return null;
	if (isValidModelId(requestedModel)) return null;
	const family = getModelFamily(requestedModel);
	if (!family) return null;
	return {
		id: buildThresholdAlertId(
			"model_routing_drift",
			`unknown_model:${family}`,
			timestamp,
			config.cooldownMinutes,
		),
		timestamp,
		type: "model_routing_drift",
		severity: "warning",
		title: "Unknown model requested",
		message: `clients are requesting ${requestedModel} (family ${family}) which is not in the bundled model catalog — bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy`,
		value: null,
		threshold: null,
		account: request.accountUsed,
		model: requestedModel,
		project: request.project ?? null,
		requestId: request.id,
		acknowledged: false,
	};
}

/**
 * Evaluates both model-routing-drift staleness classes for a single request
 * summary. Pure and synchronous like buildRequestTokenAlert — evaluateRequest
 * runs it from the async requestEvents "summary" listener, never from the
 * proxy hot path.
 */
export function buildModelRoutingDriftAlerts(
	request: RequestResponse,
	config: AlertsConfigPayload,
	timestamp: number,
): AlertEvent[] {
	const alerts: AlertEvent[] = [];
	const stalePolicy = buildStalePolicyDriftAlert(request, config, timestamp);
	if (stalePolicy) alerts.push(stalePolicy);
	const unknownModel = buildUnknownModelDriftAlert(request, config, timestamp);
	if (unknownModel) alerts.push(unknownModel);
	return alerts;
}

function toAlertEvent(row: AlertRow): AlertEvent {
	return {
		id: row.id,
		timestamp: Number(row.timestamp),
		type: row.type,
		severity: row.severity,
		title: row.title,
		message: row.message,
		value: row.value == null ? null : Number(row.value),
		threshold: row.threshold == null ? null : Number(row.threshold),
		account: row.account,
		model: row.model,
		// Defence in depth: sanitise at the read boundary so historical
		// alert rows that pre-date the project-extraction fix cannot leak
		// prompt content through the alerts UI. Stored DB data is not
		// modified; only what the dashboard sees is clamped.
		project: sanitizeProjectForDisplay(row.project),
		requestId: row.request_id,
		acknowledged: Boolean(row.acknowledged),
	};
}

function toAnomalyRow(row: AnomalySqlRow): AnomalyRequestRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		account: row.account,
		model: row.model,
		// Preserve the original project so the runaway-loop grouping key
		// (account, model, project) sees distinct values for two projects
		// that share a 63-char prefix but differ at the last char. The
		// DB-side project is already sanitised at write time by
		// sanitizeProjectName in proxy/src/project-attribution.ts
		// (PROJECT_NAME_MAX_LEN=64, C0 control chars stripped). Display
		// truncation for the API response below lives in the response
		// builder, not here — truncation before detection makes the
		// detector itself collapse distinct projects into one loop.
		project: row.project,
		agentUsed: row.agent_used,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
		costUsd: Number(row.cost_usd) || 0,
	};
}

export class AlertService {
	private readonly db: BunSqlAdapter;
	private readonly config: Config;
	private readonly requestListener: (event: RequestEvt) => void;
	private readonly authFailureListener: (event: AuthFailureEvt) => void;
	private readonly configChangeListener: ({ key }: { key: string }) => void;
	private anomalyTimer: ReturnType<typeof setInterval> | null = null;

	constructor(db: BunSqlAdapter, config: Config) {
		this.db = db;
		this.config = config;
		this.requestListener = (event) => {
			if (event.type === "summary") {
				void this.evaluateRequest(event.payload);
			}
		};
		this.authFailureListener = (event) => {
			void this.handleAuthFailure(event);
		};
		this.configChangeListener = ({ key }: { key: string }) => {
			if (
				key === "alert_anomaly_enabled" ||
				key === "alert_anomaly_interval_minutes"
			) {
				this.restartAnomalyTimer();
			}
		};
	}

	start(): void {
		requestEvents.on("event", this.requestListener);
		this.config.on("change", this.configChangeListener);
		authFailureEvents.on("event", this.authFailureListener);
		this.restartAnomalyTimer();
	}

	stop(): void {
		requestEvents.off("event", this.requestListener);
		this.config.off("change", this.configChangeListener);
		authFailureEvents.off("event", this.authFailureListener);
		if (this.anomalyTimer) {
			clearInterval(this.anomalyTimer);
			this.anomalyTimer = null;
		}
	}

	private async handleAuthFailure(event: AuthFailureEvt): Promise<void> {
		const timestamp = Date.now();
		const config = getAlertsConfig(this.config);
		const alert: AlertEvent = {
			id: buildThresholdAlertId(
				"auth_failure",
				event.accountId,
				timestamp,
				config.cooldownMinutes,
			),
			timestamp,
			type: "auth_failure",
			severity: "critical",
			title: "Account authentication failed",
			message: `Account ${event.accountName} (${event.provider}) requires re-authentication: ${event.reason}`,
			value: null,
			threshold: null,
			account: event.accountName,
			model: null,
			project: null,
			requestId: null,
			acknowledged: false,
		};
		await this.persistAndEmit(alert, config.webhookUrl);
	}

	private restartAnomalyTimer(): void {
		if (this.anomalyTimer) {
			clearInterval(this.anomalyTimer);
			this.anomalyTimer = null;
		}
		const config = getAlertsConfig(this.config);
		if (!config.anomalyEnabled) return;
		this.anomalyTimer = setInterval(
			() => {
				void this.evaluateAnomalies();
			},
			config.anomalyIntervalMinutes * 60 * 1000,
		);
	}

	async evaluateRequest(request: RequestResponse): Promise<void> {
		const config = getAlertsConfig(this.config);
		const alerts: AlertEvent[] = [];
		const requestAlert = buildRequestTokenAlert(request, config);
		if (requestAlert) alerts.push(requestAlert);
		const timestamp = parseTimestamp(request.timestamp);
		// Async by construction: this listener is invoked off the requestEvents
		// "summary" emitter (see requestListener in the constructor above),
		// never from the proxy's hot path, so evaluating model-routing drift
		// here adds no request latency.
		alerts.push(...buildModelRoutingDriftAlerts(request, config, timestamp));
		alerts.push(
			...(await this.buildAggregateAlerts(timestamp, request, config)),
		);
		for (const alert of alerts) {
			await this.persistAndEmit(alert, config.webhookUrl);
		}
	}

	/**
	 * Evaluates a single usage-window poll for the two OnWatch alert types.
	 * Called directly (not via an event bus) from the usage-polling onSnapshot
	 * callback in apps/server/src/server.ts, once per account per poll
	 * (~every 90s) — dedup against re-firing every poll happens entirely via
	 * buildUsageWindowAlertId's resets_at-keyed id (see persistAndEmit's
	 * INSERT OR IGNORE / ON CONFLICT DO NOTHING).
	 */
	async evaluateUsageSnapshot(
		accountId: string,
		accountName: string,
		usage: Record<string, unknown>,
		timestamp: number,
	): Promise<void> {
		const windows = extractUsageWindows(usage);
		if (windows.length === 0) return;
		const config = getAlertsConfig(this.config);
		const alerts: AlertEvent[] = [];
		for (const window of windows) {
			// A window with no resets_at has no cycle boundary to dedup against
			// or project toward — skip it rather than risk firing every poll.
			if (window.resetsAtMs == null) continue;
			const resetsAtMs = window.resetsAtMs;
			const thresholdAlert = this.buildUsageWindowThresholdAlert(
				accountId,
				accountName,
				window.windowKey,
				window.utilization,
				resetsAtMs,
				config,
				timestamp,
			);
			if (thresholdAlert) alerts.push(thresholdAlert);
			const exhaustionAlert = await this.buildUsageWindowExhaustionAlert(
				accountId,
				accountName,
				window.windowKey,
				window.utilization,
				resetsAtMs,
				timestamp,
			);
			if (exhaustionAlert) alerts.push(exhaustionAlert);
		}
		for (const alert of alerts) {
			// Jitter <2s can move the minute bucket by exactly one when the
			// reset instant sits near a half-minute boundary — treat an alert
			// already persisted in an adjacent bucket as the same cycle so a
			// boundary-straddling jitter cannot double-fire (review finding,
			// corroborated cross-model).
			if (await this.usageWindowNeighborBucketExists(alert.id)) continue;
			await this.persistAndEmit(alert, config.webhookUrl);
		}
	}

	private async usageWindowNeighborBucketExists(
		alertId: string,
	): Promise<boolean> {
		const m = alertId.match(/^(.*):(-?\d+)$/);
		if (!m) return false;
		const [, prefix, bucketStr] = m;
		const bucket = Number(bucketStr);
		const rows = await this.db.query<{ id: string }>(
			`SELECT id FROM alerts WHERE id IN (?, ?) LIMIT 1`,
			[`${prefix}:${bucket - 1}`, `${prefix}:${bucket + 1}`],
		);
		return rows.length > 0;
	}

	private buildUsageWindowThresholdAlert(
		accountId: string,
		accountName: string,
		windowKey: string,
		utilization: number,
		resetsAtMs: number,
		config: AlertsConfigPayload,
		timestamp: number,
	): AlertEvent | null {
		if (!shouldFireAlert(config.usageWindowThresholdPercent, utilization)) {
			return null;
		}
		return {
			id: buildUsageWindowAlertId(
				"usage_window_threshold",
				accountId,
				windowKey,
				resetsAtMs,
			),
			timestamp,
			type: "usage_window_threshold",
			// 100% is a hard cap (the window is fully exhausted, not just past a
			// soft threshold) — that state is operationally worse than merely
			// crossing the configured percent, so it earns critical.
			severity: utilization >= 100 ? "critical" : "warning",
			title: "Usage window threshold exceeded",
			message: `Account ${accountName}'s ${windowKey} usage window reached ${utilization.toFixed(1)}%, meeting the configured ${config.usageWindowThresholdPercent}% threshold.`,
			value: utilization,
			threshold: config.usageWindowThresholdPercent,
			account: accountName,
			model: null,
			project: null,
			requestId: null,
			acknowledged: false,
		};
	}

	private async buildUsageWindowExhaustionAlert(
		accountId: string,
		accountName: string,
		windowKey: string,
		utilization: number,
		resetsAtMs: number,
		timestamp: number,
	): Promise<AlertEvent | null> {
		if (utilization < USAGE_WINDOW_EXHAUSTION_MIN_UTILIZATION) return null;
		const windowStartMs =
			computeWindowStartMs(resetsAtMs, windowKey) ??
			timestamp - USAGE_WINDOW_HISTORY_FALLBACK_LOOKBACK_MS;
		// Bound the query at `timestamp` so the current poll is represented
		// EXACTLY once regardless of insert/evaluate ordering: on SQLite the
		// caller's un-awaited recordUsageSnapshot commits synchronously before
		// this SELECT runs, and reading that row PLUS the push below would
		// double-count the current point and bias the regression (pro-gate
		// cross-model finding).
		const rows = await this.db.query<UsageSnapshotSqlRow>(
			`SELECT timestamp, utilization, resets_at FROM usage_snapshots
			 WHERE account_id = ? AND window_key = ? AND timestamp >= ? AND timestamp < ?
			 ORDER BY timestamp ASC`,
			[accountId, windowKey, windowStartMs, timestamp],
		);
		const points: PredictionPoint[] = rows.map((row) => ({
			t: Number(row.timestamp),
			utilization: Number(row.utilization),
			resetsAt: row.resets_at == null ? null : Number(row.resets_at),
		}));
		points.push({ t: timestamp, utilization, resetsAt: resetsAtMs });
		const prediction = computeUsagePrediction(points);
		if (!prediction.willExhaustBeforeReset) return null;
		return {
			id: buildUsageWindowAlertId(
				"usage_window_exhaustion_projected",
				accountId,
				windowKey,
				resetsAtMs,
			),
			timestamp,
			type: "usage_window_exhaustion_projected",
			severity: "critical",
			title: "Usage window projected to exhaust before reset",
			message: `Account ${accountName}'s ${windowKey} usage window is at ${utilization.toFixed(1)}% and trending toward exhaustion (${prediction.slopePerHour.toFixed(1)}pp/hr) before it resets at ${new Date(resetsAtMs).toISOString()}.`,
			value: utilization,
			threshold: null,
			account: accountName,
			model: null,
			project: null,
			requestId: null,
			acknowledged: false,
		};
	}

	async listAlerts(limit = 100): Promise<AlertEvent[]> {
		const rows = await this.db.query<AlertRow>(
			`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`,
			[Math.max(1, Math.min(500, Math.round(limit)))],
		);
		return rows.map(toAlertEvent);
	}

	async getUnacknowledgedCount(): Promise<number> {
		const row = await this.db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0`,
		);
		return Number(row?.count) || 0;
	}

	async acknowledgeAlert(id: string): Promise<boolean> {
		const row = await this.db.get<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM alerts WHERE id = ?`,
			[id],
		);
		// Bun.SQL returns COUNT(*) on PostgreSQL as a JavaScript string (BIGINT
		// is stringified, see Bun#22188). Strict equality `row.cnt === 0` is
		// always false under that serialization, so the "missing id" branch
		// never fires on PG. Coerce to Number first — the same coercion
		// getUnacknowledgedCount() uses one method above.
		if (!row || Number(row.cnt) === 0) return false;
		await this.db.run(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`, [id]);
		return true;
	}

	async acknowledgeAll(): Promise<void> {
		await this.db.run(
			`UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0`,
		);
	}

	private async buildAggregateAlerts(
		timestamp: number,
		request: RequestResponse,
		config: AlertsConfigPayload,
	): Promise<AlertEvent[]> {
		const alerts: AlertEvent[] = [];
		const dayStart = new Date(timestamp);
		dayStart.setHours(0, 0, 0, 0);
		if (config.dailySpendUsd > 0) {
			const row = await this.db.get<DailySpendRow>(
				`SELECT SUM(COALESCE(cost_usd, 0)) as total FROM requests WHERE timestamp >= ?`,
				[dayStart.getTime()],
			);
			const total = Number(row?.total) || 0;
			if (shouldFireAlert(config.dailySpendUsd, total)) {
				alerts.push({
					id: buildThresholdAlertId(
						"daily_spend",
						"global",
						timestamp,
						config.cooldownMinutes,
					),
					timestamp,
					type: "daily_spend",
					severity: "warning",
					title: "Daily spend threshold exceeded",
					message: `Daily spend reached $${total.toFixed(2)}, meeting the configured $${config.dailySpendUsd.toFixed(2)} threshold.`,
					value: total,
					threshold: config.dailySpendUsd,
					account: null,
					model: null,
					project: request.project ?? null,
					requestId: request.id,
					acknowledged: false,
				});
			}
		}
		if (config.tokensPerHour > 0) {
			const row = await this.db.get<TokensPerHourRow>(
				`SELECT SUM(COALESCE(total_tokens, 0)) as total FROM requests WHERE timestamp >= ?`,
				[timestamp - HOUR_MS],
			);
			const total = Number(row?.total) || 0;
			if (shouldFireAlert(config.tokensPerHour, total)) {
				alerts.push({
					id: buildThresholdAlertId(
						"tokens_per_hour",
						"global",
						timestamp,
						config.cooldownMinutes,
					),
					timestamp,
					type: "tokens_per_hour",
					severity: "warning",
					title: "Hourly token threshold exceeded",
					message: `The last hour used ${total.toLocaleString()} tokens, meeting the configured ${config.tokensPerHour.toLocaleString()} token threshold.`,
					value: total,
					threshold: config.tokensPerHour,
					account: null,
					model: null,
					project: request.project ?? null,
					requestId: request.id,
					acknowledged: false,
				});
			}
		}
		return alerts;
	}

	async evaluateAnomalies(): Promise<void> {
		const config = getAlertsConfig(this.config);
		if (!config.anomalyEnabled) return;
		const since = Date.now() - config.anomalyIntervalMinutes * 60 * 1000;
		const rows = (
			await this.db.query<AnomalySqlRow>(
				`
				SELECT
					r.id as id,
					r.timestamp as timestamp,
					a.name as account,
					r.model as model,
					r.project as project,
					r.agent_used as agent_used,
					COALESCE(r.input_tokens, 0) as input_tokens,
					COALESCE(r.cache_read_input_tokens, 0) as cache_read_input_tokens,
					COALESCE(r.cache_creation_input_tokens, 0) as cache_creation_input_tokens,
					COALESCE(r.output_tokens, 0) as output_tokens,
					COALESCE(r.cost_usd, 0) as cost_usd
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE r.timestamp >= ?
				ORDER BY r.timestamp ASC
			`,
				[since],
			)
		).map(toAnomalyRow);
		if (rows.length === 0) return;
		const modelIds = [
			...new Set(
				rows
					.map((row) => row.model)
					.filter((model): model is string => model != null && model !== ""),
			),
		];
		const rateList = await Promise.all(
			modelIds.map((modelId) => getModelRates(modelId)),
		);
		const rates = new Map(
			modelIds.map((modelId, index) => [modelId, rateList[index]]),
		);
		const response = buildAnomalyInsightsResponse({
			rows,
			rates,
			options: {
				range: `${config.anomalyIntervalMinutes}m`,
				truncated: false,
				loopMinRequests: config.loopMinRequests,
			},
		});
		const alerts: AlertEvent[] = [];
		for (const event of response.tokenOutliers.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_token_outlier",
					event.requestId,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_token_outlier",
				severity: "warning",
				title: "Token usage anomaly detected",
				message: `Request ${event.requestId} used ${event.value.toLocaleString()} tokens (${event.zScore.toFixed(1)}σ above baseline).`,
				value: event.value,
				threshold: null,
				account: event.account,
				model: event.model,
				project: event.project,
				requestId: event.requestId,
				acknowledged: false,
			});
		}
		for (const event of response.outputBlowups.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_output_blowup",
					event.requestId,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_output_blowup",
				severity: "warning",
				title: "Output token blowup detected",
				message: `Request ${event.requestId} returned ${event.value.toLocaleString()} output tokens (${event.zScore.toFixed(1)}σ above baseline).`,
				value: event.value,
				threshold: null,
				account: event.account,
				model: event.model,
				project: event.project,
				requestId: event.requestId,
				acknowledged: false,
			});
		}
		for (const loop of response.runawayLoops.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildRunawayLoopAlertId(loop, config.cooldownMinutes),
				timestamp: loop.windowEndMs,
				type: "anomaly_runaway_loop",
				severity: "critical",
				title: "Runaway loop detected",
				message: `${loop.requests} near-identical requests were sent in a short window by ${loop.agentUsed ?? "an unattributed agent"} for ${loop.model}.`,
				value: loop.requests,
				threshold: null,
				account: loop.account,
				model: loop.model,
				project: loop.project,
				requestId: null,
				acknowledged: false,
			});
		}
		for (const group of response.misrouting.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_model_misrouting",
					`${group.account}:${group.model}`,
					Date.now(),
					config.cooldownMinutes,
				),
				timestamp: Date.now(),
				type: "anomaly_model_misrouting",
				severity: "info",
				title: "Potential model misrouting detected",
				message: `${group.requests} short requests used expensive model ${group.model}.`,
				value: group.requests,
				threshold: null,
				account: group.account,
				model: group.model,
				project: null,
				requestId: group.exampleRequestIds[0] ?? null,
				acknowledged: false,
			});
		}
		for (const alert of alerts) {
			await this.persistAndEmit(alert, config.webhookUrl);
		}
	}

	private async persistAndEmit(
		alert: AlertEvent,
		webhookUrl: string,
	): Promise<void> {
		try {
			// INSERT OR IGNORE is SQLite-only; PostgreSQL uses ON CONFLICT DO NOTHING.
			const conflictClause = this.db.isSQLite ? "INSERT OR IGNORE" : "INSERT";
			const onConflictClause = this.db.isSQLite
				? ""
				: "ON CONFLICT (id) DO NOTHING";
			// The unique alert ID is the cooldown guard. Only the caller whose insert
			// actually wins may emit SSE or deliver the webhook; checking first would
			// leave a race in which concurrent duplicates both deliver notifications.
			const inserted = await this.db.runWithChanges(
				`
				${conflictClause} INTO alerts (
					id, timestamp, type, severity, title, message, value, threshold,
					account, model, project, request_id, acknowledged
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				${onConflictClause}
			`,
				[
					alert.id,
					alert.timestamp,
					alert.type,
					alert.severity,
					alert.title,
					alert.message,
					alert.value,
					alert.threshold,
					alert.account,
					alert.model,
					alert.project,
					alert.requestId,
					alert.acknowledged ? 1 : 0,
				],
			);
			if (inserted === 0) return;
		} catch (error) {
			// Alerts are best-effort telemetry — a persistence failure must not
			// terminate the proxy (the listener is invoked from an async event
			// handler, so an unhandled rejection crashes Bun with exit code 1).
			log.error(
				`Failed to persist ${alert.type} alert: ${(error as Error).message}`,
			);
			return;
		}
		const event: AlertEvt = { type: "alert", payload: alert };
		alertEvents.emit("event", event);
		if (webhookUrl) {
			void this.deliverWebhook(webhookUrl, alert);
		}
	}

	private async deliverWebhook(
		webhookUrl: string,
		alert: AlertEvent,
	): Promise<void> {
		try {
			await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "alert", alert }),
			});
		} catch (error) {
			log.warn(`Alert webhook delivery failed: ${(error as Error).message}`);
		}
	}
}
