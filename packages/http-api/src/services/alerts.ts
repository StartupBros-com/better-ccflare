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
	normalizeProviderUsageWindows,
	type RequestEvt,
	requestEvents,
} from "@better-ccflare/core";
import type { BunSqlAdapter, UsageWindow } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type {
	AlertEvent,
	AlertsConfigPayload,
	AlertType,
	CanonicalUsageWindow,
	PredictionPoint,
	RequestResponse,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	GROUP_KEY_SEPARATOR,
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

/**
 * Config key backing usageWindowValueDropThreshold. Read/written through
 * Config's generic get/set rather than a dedicated typed getter/setter like
 * every other alert threshold in this file — packages/config is out of
 * scope for the Window Value Ledger's alert work (issue #252, task P1.6),
 * and Config.get/set is itself an established pattern for settings that
 * skip a bespoke accessor (see e.g. `retry_attempts` in apps/server/src/
 * server.ts). See getUsageWindowValueDropThreshold below.
 */
const ALERT_USAGE_WINDOW_VALUE_DROP_THRESHOLD_KEY =
	"alert_usage_window_value_drop_threshold";
/** Default fraction (25%) a closed window's value must fall below the
 * median of its priced prior closed siblings before usage_window_value_drop
 * fires. */
const DEFAULT_USAGE_WINDOW_VALUE_DROP_THRESHOLD = 0.25;
/** How many of the most recent priced closed windows feed the median. */
const USAGE_WINDOW_VALUE_DROP_PRIOR_LIMIT = 8;
/** Fewer priced priors than this and there is no meaningful median to
 * compare against — evaluateClosedWindow never fires (issue #252's planted
 * negative: "usage_window_value_drop must not fire with <2 priors"). */
const USAGE_WINDOW_VALUE_DROP_MIN_PRIORS = 2;

function clampUnitFraction(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_USAGE_WINDOW_VALUE_DROP_THRESHOLD;
	}
	return Math.max(0, Math.min(1, value));
}

function getUsageWindowValueDropThreshold(config: Config): number {
	const fromEnv = process.env.ALERT_USAGE_WINDOW_VALUE_DROP_THRESHOLD;
	if (fromEnv) {
		const parsed = Number.parseFloat(fromEnv);
		if (!Number.isNaN(parsed)) return clampUnitFraction(parsed);
	}
	const raw = config.get(
		ALERT_USAGE_WINDOW_VALUE_DROP_THRESHOLD_KEY,
		DEFAULT_USAGE_WINDOW_VALUE_DROP_THRESHOLD,
	);
	return typeof raw === "number"
		? clampUnitFraction(raw)
		: DEFAULT_USAGE_WINDOW_VALUE_DROP_THRESHOLD;
}

function setUsageWindowValueDropThreshold(config: Config, value: number): void {
	config.set(
		ALERT_USAGE_WINDOW_VALUE_DROP_THRESHOLD_KEY,
		clampUnitFraction(value),
	);
}

/** Mirrors the median helper in packages/core/src/cache-metrics.ts:122 —
 * that one is module-private (not exported), so it is copied rather than
 * imported (avoids a speculative cross-package cycle for one tiny function).
 * `sortedValues` must already be ascending. */
function median(sortedValues: readonly number[]): number | null {
	if (sortedValues.length === 0) return null;
	const midpoint = sortedValues.length / 2;
	if (Number.isInteger(midpoint)) {
		const lower = sortedValues[midpoint - 1];
		const upper = sortedValues[midpoint];
		if (lower === undefined || upper === undefined) return null;
		return (lower + upper) / 2;
	}
	return sortedValues[Math.floor(midpoint)] ?? null;
}

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
		usageWindowValueDropThreshold: getUsageWindowValueDropThreshold(config),
		anomalyEnabled: config.getAlertAnomalyEnabled(),
		anomalyIntervalMinutes: config.getAlertAnomalyIntervalMinutes(),
		anomalyBaselineWindowMinutes: config.getAlertAnomalyBaselineWindowMinutes(),
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
	if (payload.usageWindowValueDropThreshold !== undefined) {
		setUsageWindowValueDropThreshold(
			config,
			payload.usageWindowValueDropThreshold,
		);
	}
	config.setAlertAnomalyEnabled(payload.anomalyEnabled);
	config.setAlertAnomalyIntervalMinutes(payload.anomalyIntervalMinutes);
	config.setAlertAnomalyBaselineWindowMinutes(
		payload.anomalyBaselineWindowMinutes,
	);
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

/**
 * Encodes a possibly-null raw value for use inside a cooldown scope key,
 * distinguishing "no value" from a real value that happens to equal the
 * display fallback ("Unknown"). `event.account`/`event.model` on anomaly
 * events are already normalized (null -> "Unknown") for display purposes,
 * so a scope built directly from those two fields cannot tell an account
 * literally named "Unknown" apart from a request with no account at all —
 * this must be built from the raw (pre-normalization) field instead.
 *
 * `model` is attacker-controlled (taken verbatim from the inbound request's
 * JSON `model` field, with no charset restriction — unlike account names,
 * which are validated against patterns.accountName), so no fixed sentinel
 * string is safe: a client could always send a model value equal to
 * whatever sentinel was chosen. Instead, length-prefix the value
 * (`${length}:${value}`) and use a length of 0 for null. Two distinct
 * inputs can never produce the same encoding this way, regardless of what
 * characters either one contains — the length prefix is unambiguous.
 */
function encodeScopePart(raw: string | null): string {
	if (raw === null) return "0:";
	return `${raw.length}:${raw}`;
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

/** Compatibility wrapper for callers that still provide an Anthropic payload. */
export function extractUsageWindows(
	usage: Record<string, unknown>,
	provider = "anthropic",
): ExtractedUsageWindow[] {
	return normalizeProviderUsageWindows(usage, provider).map(
		({ windowKey, utilization, resetsAtMs }) => ({
			windowKey,
			utilization,
			resetsAtMs,
		}),
	);
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
	type:
		| "usage_window_threshold"
		| "usage_window_exhaustion_projected"
		| "usage_window_value_drop",
	accountId: string,
	windowKey: string,
	resetsAtMs: number,
	/**
	 * Escalation stage within the cycle. Without it, a warning at 90%
	 * consumes the cycle's one id and the later 100% critical escalation is
	 * silently deduped away (pro-gate finding). Threshold alerts pass
	 * "warning" | "critical"; the projection type has a single stage.
	 * usage_window_value_drop also uses the "single" default — a closed
	 * window's resetsAt never changes again, so there is no escalation
	 * sequence to distinguish.
	 */
	stage = "single",
): string {
	// Bucket to the nearest minute: providers recompute resets_at per
	// response and it jitters by fractions of a second around the same
	// instant (measured: 1554 of 1564 apparent advances were <2s jitter —
	// see WINDOW_RESET_MIN_ADVANCE_MS in usage-fetcher.ts). Keying on the
	// raw ms would re-fire the alert on nearly every poll; a real rollover
	// advances by hours, which always lands in a new bucket.
	const resetsAtMinuteBucket = Math.round(resetsAtMs / 60_000);
	return `${type}:${stage}:${accountId}:${windowKey}:${resetsAtMinuteBucket}`;
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
	/** Last exhaustion-projection evaluation per `${accountId}:${windowKey}`
	 * — in-memory rate limit on the history+regression work (see
	 * buildUsageWindowExhaustionAlert). Reset on restart is fine: one extra
	 * evaluation per window is the worst case. */
	private readonly usageWindowExhaustionEvalAt = new Map<string, number>();

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
		windows: CanonicalUsageWindow[],
		timestamp: number,
		expectedCreatedAt?: number,
	): Promise<void> {
		if (windows.length === 0) return;
		const config = getAlertsConfig(this.config);
		for (const window of windows) {
			// Inactive provider rows remain available for history, but do not describe
			// currently consumable capacity and must not trigger operator alerts.
			if (!window.active) continue;
			// A window with no resets_at has no cycle boundary to dedup against
			// or project toward — skip it rather than risk firing every poll.
			if (window.resetsAtMs == null) continue;
			const resetsAtMs = window.resetsAtMs;
			// Threshold alerts persist immediately, before any projection work:
			// they do not depend on history, and a projection-query failure
			// must not discard them (pro-gate finding).
			const thresholdAlert = this.buildUsageWindowThresholdAlert(
				accountId,
				accountName,
				window.windowKey,
				window.utilization,
				resetsAtMs,
				config,
				timestamp,
			);
			if (thresholdAlert) {
				await this.persistUsageWindowAlert(
					thresholdAlert,
					config.webhookUrl,
					accountId,
					expectedCreatedAt,
				);
			}
			// Projection is best-effort per window: a history lookup failing for
			// one window must not cancel evaluation of the remaining windows.
			try {
				const exhaustionAlert = await this.buildUsageWindowExhaustionAlert(
					accountId,
					accountName,
					window.windowKey,
					window.utilization,
					resetsAtMs,
					timestamp,
				);
				if (exhaustionAlert) {
					await this.persistUsageWindowAlert(
						exhaustionAlert,
						config.webhookUrl,
						accountId,
						expectedCreatedAt,
					);
				}
			} catch (error) {
				log.warn(
					`Usage-window exhaustion projection failed for ${accountName}/${window.windowKey}: ${error}`,
				);
			}
		}
	}

	private async persistUsageWindowAlert(
		alert: AlertEvent,
		webhookUrl: string,
		accountId: string,
		expectedCreatedAt?: number,
	): Promise<void> {
		// Jitter <2s can move the minute bucket by exactly one when the reset
		// instant sits near a half-minute boundary — treat an alert already
		// persisted in an adjacent bucket as the same cycle so a
		// boundary-straddling jitter cannot double-fire (review finding,
		// corroborated cross-model). The guard rides INSIDE the insert
		// statement (WHERE NOT EXISTS) so it holds under one snapshot rather
		// than a raceable check-then-insert (pro-gate round-3 finding).
		const m = alert.id.match(/^(.*):(-?\d+)$/);
		const neighborIds = m
			? [`${m[1]}:${Number(m[2]) - 1}`, `${m[1]}:${Number(m[2]) + 1}`]
			: [];
		await this.persistAndEmit(
			alert,
			webhookUrl,
			neighborIds,
			accountId,
			expectedCreatedAt,
		);
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
		// 100% is a hard cap (the window is fully exhausted, not just past a
		// soft threshold) — operationally worse than crossing the configured
		// percent, so it earns critical AND its own dedup stage: the earlier
		// warning must not consume the cycle's only id and silently swallow
		// the escalation (pro-gate finding).
		const stage = utilization >= 100 ? "critical" : "warning";
		return {
			id: buildUsageWindowAlertId(
				"usage_window_threshold",
				accountId,
				windowKey,
				resetsAtMs,
				stage,
			),
			timestamp,
			type: "usage_window_threshold",
			severity: stage,
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
		if (utilization >= 100) {
			// Factual exhaustion needs no projection (and no history query) —
			// and it carries its own dedup stage: an earlier "projected" alert
			// must not conflict-ignore the actual exhaustion, which would
			// otherwise leave the stored alert a mere prediction (pro-gate
			// round-2 finding).
			return {
				id: buildUsageWindowAlertId(
					"usage_window_exhaustion_projected",
					accountId,
					windowKey,
					resetsAtMs,
					"exhausted",
				),
				timestamp,
				type: "usage_window_exhaustion_projected",
				severity: "critical",
				title: "Usage window exhausted",
				message: `Account ${accountName}'s ${windowKey} usage window is fully exhausted (${utilization.toFixed(1)}%). It resets at ${new Date(resetsAtMs).toISOString()}.`,
				value: utilization,
				threshold: null,
				account: accountName,
				model: null,
				project: null,
				requestId: null,
				acknowledged: false,
			};
		}
		// Rate-limit the history+regression work per (account, window): at the
		// supported 10s poll interval a per-poll re-aggregation of the raw
		// cycle is quadratic over the window's life (pro-gate finding). One
		// evaluation per bucket width loses no fidelity — the regression input
		// is 5-minute-bucketed anyway.
		const evalKey = `${accountId}:${windowKey}`;
		const lastEvalAt = this.usageWindowExhaustionEvalAt.get(evalKey);
		if (lastEvalAt != null && timestamp - lastEvalAt < 4.5 * 60 * 1000) {
			return null;
		}
		this.usageWindowExhaustionEvalAt.set(evalKey, timestamp);
		const windowStartMs =
			computeWindowStartMs(resetsAtMs, windowKey) ??
			timestamp - USAGE_WINDOW_HISTORY_FALLBACK_LOOKBACK_MS;
		// Bound the query at `timestamp` so the current poll is represented
		// EXACTLY once regardless of insert/evaluate ordering: on SQLite the
		// caller's un-awaited recordUsageSnapshot commits synchronously before
		// this SELECT runs, and reading that row PLUS the push below would
		// double-count the current point and bias the regression (pro-gate
		// cross-model finding).
		//
		// Aggregate into 5-minute buckets (last sample time, mean utilization)
		// so the regression input is bounded (~2016 rows for a 7d window) even
		// at the supported 10s poll interval — re-reading every raw row per
		// poll is quadratic over the cycle (pro-gate finding). Integer
		// division truncates identically on SQLite and Postgres.
		const rows = await this.db.query<UsageSnapshotSqlRow>(
			`SELECT MAX(timestamp) AS timestamp, AVG(utilization) AS utilization, MAX(resets_at) AS resets_at
			 FROM usage_snapshots
			 WHERE account_id = ? AND window_key = ? AND timestamp >= ? AND timestamp < ?
			 GROUP BY timestamp / 300000
			 ORDER BY MAX(timestamp) ASC`,
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
				"projected",
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

	/**
	 * Evaluates the `usage_window_value_drop` alert for one just-CLOSED
	 * usage window (issue #252's Window Value Ledger). Called by
	 * UsageWindowLedger.closeAndValue immediately after a successful close;
	 * `window` already carries the final valueUsd/grantType/aggregates that
	 * close produced, so this method never re-reads the just-closed row —
	 * it only queries PRIOR closed siblings, excluded by `id` (not by
	 * position/value), so a `closed_at` tie can never accidentally
	 * include/exclude the wrong row.
	 *
	 * Needs at least USAGE_WINDOW_VALUE_DROP_MIN_PRIORS (2) priced prior
	 * closed windows to have a meaningful median; with fewer, this never
	 * fires. Fires when `window.valueUsd < median * (1 - threshold)`, using
	 * the configured (or default 0.25) usageWindowValueDropThreshold.
	 *
	 * Dedup id is (type, accountId, windowKey, resetsAtMs) via
	 * buildUsageWindowAlertId — a closed window's resetsAt is fixed
	 * forever, so persistAndEmit's INSERT OR IGNORE guarantees the SAME
	 * closed window can never alert twice even if this method is invoked
	 * for it repeatedly (e.g. a retried close).
	 */
	async evaluateClosedWindow(
		window: UsageWindow,
		accountName: string,
		expectedCreatedAt?: number,
	): Promise<void> {
		if (window.valueUsd == null) return;
		const config = getAlertsConfig(this.config);
		const threshold =
			config.usageWindowValueDropThreshold ??
			DEFAULT_USAGE_WINDOW_VALUE_DROP_THRESHOLD;
		const priorRows = await this.db.query<{ value_usd: number }>(
			`SELECT value_usd FROM usage_windows
			 WHERE account_id = ? AND window_key = ? AND id != ?
			   AND closed_at IS NOT NULL AND value_usd IS NOT NULL
			 ORDER BY closed_at DESC LIMIT ?`,
			[
				window.accountId,
				window.windowKey,
				window.id,
				USAGE_WINDOW_VALUE_DROP_PRIOR_LIMIT,
			],
		);
		if (priorRows.length < USAGE_WINDOW_VALUE_DROP_MIN_PRIORS) return;
		const priors = priorRows
			.map((row) => Number(row.value_usd))
			.sort((a, b) => a - b);
		const med = median(priors);
		if (med == null) return;
		const closedValue = window.valueUsd;
		const dropFloor = med * (1 - threshold);
		if (!(closedValue < dropFloor)) return;
		const percentBelow = med > 0 ? ((med - closedValue) / med) * 100 : 100;
		const alert: AlertEvent = {
			id: buildUsageWindowAlertId(
				"usage_window_value_drop",
				window.accountId,
				window.windowKey,
				window.resetsAt,
			),
			timestamp: window.closedAt ?? Date.now(),
			type: "usage_window_value_drop",
			severity: "warning",
			title: "Usage window value dropped",
			message: `Account ${accountName}'s ${window.windowKey} usage window (${new Date(
				window.startedAt,
			).toISOString()} to ${new Date(window.resetsAt).toISOString()}) closed at $${closedValue.toFixed(2)}, ${percentBelow.toFixed(1)}% below the $${med.toFixed(2)} median of its last ${priors.length} priced closed windows (grant_type: ${window.grantType}).`,
			value: closedValue,
			threshold,
			account: accountName,
			model: null,
			project: null,
			requestId: null,
			acknowledged: false,
		};
		await this.persistAndEmit(
			alert,
			config.webhookUrl,
			[],
			window.accountId,
			expectedCreatedAt,
		);
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
		const baselineWindowMinutes = config.anomalyBaselineWindowMinutes;
		const intervalMinutes = config.anomalyIntervalMinutes;
		// Query one wider window spanning both the baseline history and the
		// scoring interval, then partition client-side below into two
		// GENUINELY DISJOINT sets: rows strictly before scoringSince feed the
		// baseline, rows at/after scoringSince are what gets scored. This
		// keeps the DB hit to a single query instead of two, while still
		// upholding the leave-one-out contract documented on
		// detectTokenOutliers (issue #410) — a scored row must never also be
		// a member of its own baseline population.
		//
		// The query window must be ADDITIVE (baselineWindowMinutes +
		// intervalMinutes), not Math.max(...). Math.max collapses to just
		// intervalMinutes whenever baselineWindowMinutes <= intervalMinutes
		// (a valid config — nothing prevents anomalyBaselineWindowMinutes
		// from being set lower than anomalyIntervalMinutes), which would
		// fetch ONLY the scoring interval's worth of history. Every fetched
		// row would then have timestamp >= scoringSince, so baselineRows
		// would come up empty and every anomaly would silently go
		// undetected. The additive formula guarantees the fetch always
		// extends a full baselineWindowMinutes further back than
		// scoringSince, regardless of how intervalMinutes compares to it.
		const scoringSince = Date.now() - intervalMinutes * 60 * 1000;
		const baselineSince = scoringSince - baselineWindowMinutes * 60 * 1000;
		const allRows = (
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
				[baselineSince],
			)
		).map(toAnomalyRow);
		if (allRows.length === 0) return;
		// Partition by timestamp so the two sets never share a row: baseline is
		// strictly OLDER history (up to a full baselineWindowMinutes wide),
		// scoring is the recent slice.
		const baselineRows = allRows.filter((row) => row.timestamp < scoringSince);
		const scoringRows = allRows.filter((row) => row.timestamp >= scoringSince);
		if (scoringRows.length === 0) return;
		const modelIds = [
			...new Set(
				scoringRows
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
			baselineRows,
			scoringRows,
			rates,
			options: {
				range: `${intervalMinutes}m`,
				baselineWindowMinutes,
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
					`${encodeScopePart(event.accountRaw)}${GROUP_KEY_SEPARATOR}${encodeScopePart(event.modelRaw)}`,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_token_outlier",
				severity: "warning",
				title: "Token usage anomaly detected",
				message: `Request ${event.requestId} used ${event.value.toLocaleString()} tokens (${(event.value / event.approxBaselineMedian).toFixed(1)}x the account/model baseline of ~${Math.round(event.approxBaselineMedian).toLocaleString()}; anomaly score ${event.zScore.toFixed(1)}).`,
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
					`${encodeScopePart(event.accountRaw)}${GROUP_KEY_SEPARATOR}${encodeScopePart(event.modelRaw)}`,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_output_blowup",
				severity: "warning",
				title: "Output token blowup detected",
				message: `Request ${event.requestId} returned ${event.value.toLocaleString()} output tokens (${(event.value / event.approxBaselineMedian).toFixed(1)}x the account/model baseline of ~${Math.round(event.approxBaselineMedian).toLocaleString()} output tokens; anomaly score ${event.zScore.toFixed(1)}).`,
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
		suppressIfExistingIds: string[] = [],
		accountId?: string,
		expectedCreatedAt?: number,
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
			//
			// suppressIfExistingIds extends the guard to RELATED ids (the
			// usage-window adjacent jitter buckets): the existence check rides
			// inside the INSERT ... SELECT statement so it evaluates under the
			// same snapshot as the insert instead of a separate, raceable
			// pre-check.
			const hasGenerationFence =
				accountId !== undefined && expectedCreatedAt !== undefined;
			const conditions: string[] = [];
			if (hasGenerationFence) {
				conditions.push(
					"EXISTS (SELECT 1 FROM accounts WHERE id = ? AND created_at = ?)",
				);
			}
			if (suppressIfExistingIds.length > 0) {
				conditions.push(
					`NOT EXISTS (SELECT 1 FROM alerts WHERE id IN (${suppressIfExistingIds.map(() => "?").join(", ")}))`,
				);
			}
			const valuesSource =
				conditions.length > 0
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${conditions.join(" AND ")}`
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
			const inserted = await this.db.runWithChanges(
				`
				${conflictClause} INTO alerts (
					id, timestamp, type, severity, title, message, value, threshold,
					account, model, project, request_id, acknowledged
				) ${valuesSource}
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
					...(hasGenerationFence ? [accountId, expectedCreatedAt] : []),
					...suppressIfExistingIds,
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
