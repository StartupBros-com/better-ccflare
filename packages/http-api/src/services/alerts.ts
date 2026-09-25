import type { Config } from "@better-ccflare/config";
import {
	type AlertEvt,
	type AuthFailureEvt,
	alertEvents,
	authFailureEvents,
	CODEX_CATALOG_FAMILIES,
	type CodexCatalogEvt,
	type CodexCatalogStaleEvt,
	type CodexIdentityRecordStaleEvt,
	type CodexOwnCatalogPublishedEvt,
	type CodexRoleTargetChangedEvt,
	type CodexRouteRoleUnavailableEvt,
	codexCatalogEvents,
	computeWindowStartMs,
	getModelFamily,
	getModelRates,
	isValidModelId,
	isWellFormedConcreteClaudeModelId,
	LATEST_MODEL_BY_FAMILY,
	normalizeProviderUsageWindows,
	type RequestEvt,
	requestEvents,
} from "@better-ccflare/core";
import {
	type BunSqlAdapter,
	CacheHealthRepository,
	type UsageWindow,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { getProviderModelDefaultOverrides } from "@better-ccflare/providers";
import type {
	Account,
	AlertEvent,
	AlertsConfigPayload,
	AlertType,
	CanonicalUsageWindow,
	PredictionPoint,
	RequestResponse,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	CACHE_HEALTH_BUCKET_MS,
	CACHE_HEALTH_DEFAULT_POLICY,
	CACHE_HEALTH_INTERVAL_MS,
	type CacheHealthAlertDecision,
	type CacheHealthPolicy,
	type CacheHealthState,
	cacheHealthScopeKey,
	isWebhookOptInAlertType,
} from "@better-ccflare/types";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	GROUP_KEY_SEPARATOR,
	sanitizeProjectForDisplay,
} from "./anomaly-insights";
import {
	advanceCacheHealth,
	aggregateProviderCacheBuckets,
	cacheHealthQueryWindow,
	createCacheHealthState,
	isRedundantProviderCacheAlert,
} from "./cache-health";
import {
	type CodexAccountFamilySource,
	resolveCodexAccountFamilyDefault,
} from "./codex-effective-defaults";
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
		// Legacy Config doubles implement only the older alert getters.
		cacheHealthEnabled: config.getAlertCacheHealthEnabled?.() ?? true,
		cacheHealthThresholdPercent:
			config.getAlertCacheHealthThresholdPercent?.() ??
			CACHE_HEALTH_DEFAULT_POLICY.warningPercent,
		cacheHealthDurationMinutes:
			config.getAlertCacheHealthDurationMinutes?.() ??
			(CACHE_HEALTH_DEFAULT_POLICY.warningBuckets * CACHE_HEALTH_BUCKET_MS) /
				60_000,
		cacheHealthMinRequests:
			config.getAlertCacheHealthMinRequests?.() ??
			CACHE_HEALTH_DEFAULT_POLICY.minimumRequests,
		cacheHealthMinInputTokens:
			config.getAlertCacheHealthMinInputTokens?.() ??
			CACHE_HEALTH_DEFAULT_POLICY.minimumInputTokens,
		cacheHealthReminderMinutes:
			config.getAlertCacheHealthReminderMinutes?.() ??
			CACHE_HEALTH_DEFAULT_POLICY.reminderMs / 60_000,
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
	if (payload.cacheHealthEnabled !== undefined)
		config.setAlertCacheHealthEnabled(payload.cacheHealthEnabled);
	if (payload.cacheHealthThresholdPercent !== undefined)
		config.setAlertCacheHealthThresholdPercent(
			payload.cacheHealthThresholdPercent,
		);
	if (payload.cacheHealthDurationMinutes !== undefined)
		config.setAlertCacheHealthDurationMinutes(
			payload.cacheHealthDurationMinutes,
		);
	if (payload.cacheHealthMinRequests !== undefined)
		config.setAlertCacheHealthMinRequests(payload.cacheHealthMinRequests);
	if (payload.cacheHealthMinInputTokens !== undefined)
		config.setAlertCacheHealthMinInputTokens(payload.cacheHealthMinInputTokens);
	if (payload.cacheHealthReminderMinutes !== undefined)
		config.setAlertCacheHealthReminderMinutes(
			payload.cacheHealthReminderMinutes,
		);
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
 *
 * This is primarily a catalog-completeness signal, not a routing failure —
 * but ONLY when `requestedModel` is well-formed per
 * isWellFormedConcreteClaudeModelId(): a bare family-alias combo/managed
 * policy then passes it straight through to the account instead of
 * rewriting it (see combo-membership-resolver.ts's requestedModel
 * pass-through). This function fires on the looser CLAUDE_MODEL_SHAPE_RE, so
 * it also catches malformed ids (e.g. "claude-opus-6-preview") that fail
 * that stricter shape guard — those are NOT passed through; a bare-alias
 * route still rewrites them to LATEST_MODEL_BY_FAMILY, same as a well-formed
 * id landing on a cross-family fallback slot or a version-pinned account
 * (both of which also still rewrite to LATEST regardless of well-formedness;
 * see docs/combos.md's documented residual gap). The message below branches
 * on well-formedness so it never claims pass-through occurred for a request
 * this feature does not actually pass through. What always goes stale
 * without the catalog bump, in every branch, is offline pricing,
 * list-price-era lookups, and dashboard/CLI model pickers, which all key off
 * CLAUDE_MODEL_IDS.
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
	const catalogGapMessage = `offline pricing, list-price eras, and pickers don't recognize it yet; bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy`;
	const message = isWellFormedConcreteClaudeModelId(requestedModel)
		? `clients are requesting ${requestedModel} (family ${family}) which is missing from the bundled model catalog — a same-family bare-alias route now passes a well-formed id like this straight through instead of downgrading it, though a cross-family fallback slot or a version-pinned account can still send an older model instead; ${catalogGapMessage}`
		: `clients are requesting ${requestedModel} (family ${family}) which is missing from the bundled model catalog and doesn't match the pass-through shape guard, so a bare-alias route can still silently rewrite it to the family's latest model; ${catalogGapMessage}`;
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
		message,
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

/*
 * Codex catalog, pin and client-identity alerts (issue #370). The proxy emits
 * typed events on codexCatalogEvents (packages/core/src/codex-catalog-events.ts);
 * AlertService.evaluateCodexCatalogEvent turns each into zero or more alerts
 * through the ordinary persistAndEmit dedup and delivery path.
 *
 * Messages carry account names/ids, family names, route-profile ids and model
 * slugs only: never credentials, file paths or emails.
 */

/** Where a pinned Codex family's model came from, in operator words. */
const CODEX_PIN_SOURCE_LABEL: Record<CodexAccountFamilySource, string> = {
	account_mapping_pin: "account model mapping",
	custom_endpoint_mapping: "custom endpoint model mapping",
	model_fallbacks: "legacy model fallback",
	environment_mapping: "environment model mapping",
	global_provider_override: "provider-wide default override",
	account_catalog: "account catalog",
	provider_catalog_borrowed: "borrowed provider catalog",
	compiled_default: "compiled default",
};

/**
 * The account columns pin attribution reads. Deliberately excludes every
 * credential column (api_key, refresh_token, access_token).
 */
export interface CodexPinAccountRow {
	id: string;
	name: string;
	provider: string;
	model_mappings: string | null;
	custom_endpoint: string | null;
	model_fallbacks: string | null;
	created_at: number;
}

/**
 * Content-addressed: one alert per (account, family, new target), whenever it
 * is observed, rather than one per cooldown bucket.
 */
export function buildCodexRoleTargetChangedAlert(
	event: CodexRoleTargetChangedEvt,
	timestamp: number,
): AlertEvent {
	return {
		id: `codex_role_target_changed:${event.accountId}:${event.family}:${event.to}`,
		timestamp,
		type: "codex_role_target_changed",
		severity: "info",
		title: "Codex automatic model target changed",
		message: `Codex account ${event.accountName}'s own catalog now puts ${event.to} at the ${event.family} role, replacing ${event.from}. Families that follow the automatic target route to ${event.to} from now on; pinned families are unaffected.`,
		value: null,
		threshold: null,
		account: event.accountName,
		model: event.to,
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

/**
 * Classify every family pin of one account against a fresh publication of its
 * OWN catalog, using the same attribution the effective-defaults API and the
 * migration preview use (resolveCodexAccountFamilyDefault), so a family is a
 * pin here exactly when routing treats it as one — including force-account-
 * model mode, where account-level pins are not applied.
 *
 * - pinned model absent from the catalog: `codex_pin_unavailable` (warning);
 * - pinned model offered but not the role target: `codex_pin_superseded`
 *   (info — an intentional pin is never an error just because a newer model
 *   exists);
 * - pin equal to the role target, or an unpinned family: nothing.
 *
 * Content-addressed ids: a standing condition is reported once, not on every
 * fifteen-minute republication.
 */
export function buildCodexPinAlerts(
	row: CodexPinAccountRow,
	event: CodexOwnCatalogPublishedEvt,
	timestamp: number,
	globalOverrides: Readonly<Record<string, string>> | undefined,
): AlertEvent[] {
	// Only the mapping columns are read by attribution (plus id and name for
	// scoping and logs); a credential-free row is sufficient by construction.
	const account = row as unknown as Account;
	const offered = new Set(event.models);
	const alerts: AlertEvent[] = [];
	for (const family of CODEX_CATALOG_FAMILIES) {
		const target = event.roleTargets[family];
		if (!target) continue;
		const attribution = resolveCodexAccountFamilyDefault(account, family, {
			globalOverride: globalOverrides?.[family],
			catalog: { source: "own" },
		});
		if (!attribution.pinned) continue;
		const pin = attribution.effectiveModel;
		if (pin === target) continue;
		const source = CODEX_PIN_SOURCE_LABEL[attribution.source];
		const common = {
			timestamp,
			value: null,
			threshold: null,
			account: row.name,
			model: pin,
			project: null,
			requestId: null,
			acknowledged: false,
		};
		if (!offered.has(pin)) {
			alerts.push({
				...common,
				id: `codex_pin_unavailable:${row.id}:${family}:${pin}`,
				type: "codex_pin_unavailable",
				severity: "warning",
				title: "Pinned Codex model is no longer offered",
				message: `Codex account ${row.name} pins ${family} to ${pin} (${source}), but the account's own catalog no longer offers it. Requests for ${family} on this account may fail until the pin is updated or removed; the catalog's ${family} role target is ${target}.`,
			});
			continue;
		}
		alerts.push({
			...common,
			id: `codex_pin_superseded:${row.id}:${family}:${encodeScopePart(pin)}:${target}`,
			type: "codex_pin_superseded",
			severity: "info",
			title: "Pinned Codex model is no longer the catalog default",
			message: `Codex account ${row.name} pins ${family} to ${pin} (${source}). The account's own catalog still offers it but now puts ${target} at the ${family} role. No action is needed if the pin is intentional; remove it to follow the automatic target.`,
		});
	}
	return alerts;
}

export function buildCodexCatalogStaleAlert(
	event: CodexCatalogStaleEvt,
	timestamp: number,
	cooldownMinutes: number,
): AlertEvent {
	const minutes = Math.floor(event.ageMs / 60_000);
	return {
		id: buildThresholdAlertId(
			"codex_catalog_stale",
			event.accountId,
			timestamp,
			cooldownMinutes,
		),
		timestamp,
		type: "codex_catalog_stale",
		severity: "warning",
		title: "Codex model catalog is stale",
		message: `Codex account ${event.accountName}'s own model catalog was last read successfully ${minutes} minutes ago and its latest refresh failed. Routing keeps using that last-good catalog, so newly released or retired models are not reflected until a refresh succeeds.`,
		value: minutes,
		threshold: null,
		account: event.accountName,
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

export function buildCodexRouteRoleUnavailableAlert(
	event: CodexRouteRoleUnavailableEvt,
	accountName: string | null,
	timestamp: number,
	cooldownMinutes: number,
): AlertEvent {
	const accountLabel = event.accountId
		? (accountName ?? event.accountId)
		: null;
	let message: string;
	if (event.reason === "catalog_role_unavailable") {
		const subject = accountLabel
			? `Codex account ${accountLabel} has`
			: "no account in its pool has";
		message = `Codex route profile ${event.profileId} failed closed: ${subject} a role target in a catalog of its own yet (its own model catalog has not loaded or could not be read), so the request was refused rather than routed to a different model.`;
	} else {
		message = accountLabel
			? `Codex route profile ${event.profileId} failed closed: Codex account ${accountLabel}'s effective model mapping differs from the role target in its own catalog, so the request was refused. Remove the pin to follow the catalog, or use an exact-model profile.`
			: `Codex route profile ${event.profileId} failed closed: no account in its pool both has a catalog of its own and follows that catalog's role target (at least one is pinned to a different model), so the request was refused.`;
	}
	return {
		id: buildThresholdAlertId(
			"codex_route_role_unavailable",
			`${encodeScopePart(event.profileId)}:${encodeScopePart(event.accountId ?? null)}:${event.reason}`,
			timestamp,
			cooldownMinutes,
		),
		timestamp,
		type: "codex_route_role_unavailable",
		severity: "warning",
		title: "Codex catalog-role route failed closed",
		message,
		value: null,
		threshold: null,
		account: accountLabel,
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

export function buildCodexIdentityRecordAlert(
	event: CodexIdentityRecordStaleEvt,
	timestamp: number,
	cooldownMinutes: number,
): AlertEvent {
	const advertised = event.verifiedAt
		? `ccflare advertises Codex client version ${event.version} from the last valid record (verified ${event.verifiedAt})`
		: `ccflare advertises its compiled fallback Codex client version ${event.version}`;
	let message: string;
	switch (event.error) {
		case "stale_record":
			message = `The verified Codex CLI version record is past its freshness window${event.verifiedAt ? ` (last verified ${event.verifiedAt})` : ""}. ccflare still advertises Codex client version ${event.version}; the managed Codex updater appears to have stalled.`;
			break;
		case "unavailable_record":
			message = `The configured verified Codex CLI version record is missing. ${advertised}; the managed Codex updater appears to have stalled or has not published a record yet.`;
			break;
		case "invalid_record":
			message = `The configured verified Codex CLI version record could not be read as a valid record. ${advertised}; check the managed Codex updater.`;
			break;
		case "invalid_path":
			message = `The configured location of the verified Codex CLI version record is not a valid absolute path, so the record is never read. ${advertised}.`;
			break;
	}
	return {
		id: buildThresholdAlertId(
			"codex_identity_record_stale",
			event.error,
			timestamp,
			cooldownMinutes,
		),
		timestamp,
		type: "codex_identity_record_stale",
		severity: "warning",
		title: "Codex CLI version record is not current",
		message,
		value: null,
		threshold: null,
		account: null,
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
	};
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

/**
 * Discord identifies a webhook by host + `/api/webhooks/<id>/<token>` path;
 * everything else (including the media CDN `cdn.discordapp.com` and
 * lookalike hosts like `evil-discord.com`) is treated as a generic webhook
 * and keeps the legacy body. See deliverAlertWebhook.
 */
const DISCORD_WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
	"discord.com",
	"discordapp.com",
	"ptb.discord.com",
	"canary.discord.com",
]);
const DISCORD_WEBHOOK_PATH_PREFIX = "/api/webhooks/";

/** Discord's edge returns 403 to a generic/default fetch User-Agent. */
const ALERT_WEBHOOK_USER_AGENT = "better-ccflare-alerts/1.0";

/** Discord hard-caps message `content` at 2000 codepoints. A byte- or
 * UTF-16-unit-based cut can split a surrogate pair; see
 * truncateToCodepoints. */
const DISCORD_CONTENT_MAX_CODEPOINTS = 2000;

export function isDiscordWebhookUrl(url: URL): boolean {
	return (
		DISCORD_WEBHOOK_HOSTS.has(url.hostname) &&
		url.pathname.startsWith(DISCORD_WEBHOOK_PATH_PREFIX)
	);
}

function buildTruncationMarker(omittedCount: number): string {
	const noun = omittedCount === 1 ? "character" : "characters";
	return `\n[truncated — ${omittedCount} ${noun} omitted]`;
}

/**
 * Truncate `text` to at most `maxCodepoints` Unicode codepoints (not bytes,
 * not UTF-16 code units — `Array.from`/the string iterator splits on
 * codepoints, so a surrogate pair is never cut in half), appending an
 * explicit marker stating how many codepoints were omitted. The marker
 * itself counts against the cap: this iterates the reservation to a fixed
 * point (converges in a handful of steps — the marker's length only changes
 * when the omitted count's digit count crosses a power of ten) so the
 * returned text is never longer than `maxCodepoints`.
 */
export function truncateToCodepoints(
	text: string,
	maxCodepoints: number,
): { text: string; omittedCount: number } {
	const codepoints = Array.from(text);
	if (codepoints.length <= maxCodepoints) {
		return { text, omittedCount: 0 };
	}
	let keep = maxCodepoints;
	for (let i = 0; i < 20; i++) {
		const omitted = codepoints.length - keep;
		const markerLen = Array.from(buildTruncationMarker(omitted)).length;
		const nextKeep = Math.max(0, maxCodepoints - markerLen);
		if (nextKeep === keep) break;
		keep = nextKeep;
	}
	const omittedCount = codepoints.length - keep;
	const marker = buildTruncationMarker(omittedCount);
	return { text: codepoints.slice(0, keep).join("") + marker, omittedCount };
}

/**
 * Concise markdown rendering of an alert for Discord: severity + type +
 * title in bold on the first line, then the message, then account / model /
 * value-vs-threshold when present — bounded to Discord's 2000-codepoint
 * `content` limit.
 */
export function buildDiscordAlertContent(alert: AlertEvent): string {
	const lines: string[] = [
		`**${alert.severity.toUpperCase()} · ${alert.type}: ${alert.title}**`,
		alert.message,
	];
	const details: string[] = [];
	if (alert.account) details.push(`Account: ${alert.account}`);
	if (alert.model) details.push(`Model: ${alert.model}`);
	if (alert.value !== null && alert.threshold !== null) {
		details.push(`Value: ${alert.value} / Threshold: ${alert.threshold}`);
	} else if (alert.value !== null) {
		details.push(`Value: ${alert.value}`);
	}
	if (details.length > 0) {
		lines.push(details.join(" · "));
	}
	return truncateToCodepoints(lines.join("\n"), DISCORD_CONTENT_MAX_CODEPOINTS)
		.text;
}

/** Discord's webhook body shape: `allowed_mentions: {parse: []}` suppresses
 * every mention type so an account/model name containing `@everyone`-shaped
 * text can never actually ping. */
export function buildDiscordWebhookBody(alert: AlertEvent): {
	content: string;
	allowed_mentions: { parse: never[] };
} {
	return {
		content: buildDiscordAlertContent(alert),
		allowed_mentions: { parse: [] },
	};
}

/**
 * Empty allowlist = deliver every type (today's behaviour, unchanged), except
 * the informational types in WEBHOOK_OPT_IN_ALERT_TYPES, which an empty
 * allowlist keeps in-app only. A non-empty allowlist delivers exactly the
 * listed types, opt-in types included.
 */
export function isAlertTypeAllowedForWebhook(
	type: AlertType,
	allowedTypes: readonly AlertType[],
): boolean {
	if (allowedTypes.length === 0) return !isWebhookOptInAlertType(type);
	return allowedTypes.includes(type);
}

/**
 * POST one alert to a configured webhook. Fire-and-forget: every failure
 * mode (a malformed URL, a network error, a non-2xx response) is caught and
 * logged here, never thrown, because the caller (persistAndEmit) invokes
 * this with `void` from inside a synchronous event-handler path where an
 * unhandled rejection would crash the proxy.
 *
 * Discord's webhook endpoint rejects the legacy `{type:"alert", alert}`
 * body (it needs `content` or `embeds`); a Discord URL gets a Discord-shaped
 * body instead. Every other URL keeps the legacy body unchanged
 * (backward-compatible) but also gets the explicit User-Agent Discord's edge
 * requires — harmless for non-Discord receivers.
 *
 * The webhook URL is never logged: Discord webhook URLs embed a bearer
 * token in the path.
 */
export async function deliverAlertWebhook(
	webhookUrl: string,
	alert: AlertEvent,
	signal?: AbortSignal,
): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(webhookUrl);
	} catch (_error) {
		// Do not interpolate the caught error's message: both Bun's and
		// Node's WHATWG URL parser embed the entire original input string in
		// it, which would leak a Discord webhook's secret token into the log
		// stream (logBus is unconditionally emitted and streamed to the
		// dashboard's live log viewer regardless of console-silence
		// settings).
		log.warn("Alert webhook delivery skipped: configured URL failed to parse");
		return;
	}
	const body = isDiscordWebhookUrl(parsed)
		? buildDiscordWebhookBody(alert)
		: { type: "alert" as const, alert };
	try {
		if (signal?.aborted) return;
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": ALERT_WEBHOOK_USER_AGENT,
			},
			body: JSON.stringify(body),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
				: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			log.warn(
				`Alert webhook delivery received non-2xx status: ${response.status}`,
			);
		}
	} catch (_error) {
		// Fetch exception strings can contain the complete secret-bearing URL.
		log.warn("Alert webhook delivery failed or timed out");
	}
}

interface CacheHealthAccountLabel {
	id: string;
	name: string;
	created_at: number;
}

interface CacheHealthEvaluationConfig {
	enabled: boolean;
	policy: CacheHealthPolicy;
	webhookUrl: string;
	allowedTypes: readonly AlertType[];
}

function cacheHealthAlertEvent(
	decision: CacheHealthAlertDecision,
	accounts: ReadonlyMap<string, CacheHealthAccountLabel>,
): AlertEvent {
	const { scope, evidence } = decision;
	const label = (id: string, generation: number | null): string => {
		const account = accounts.get(id);
		return account && Number(account.created_at) === generation
			? account.name
			: "Unknown account";
	};
	const account =
		scope.accountId === null
			? null
			: label(scope.accountId, scope.accountGeneration);
	const contributors = evidence.contributors.map((c) =>
		label(c.accountId, c.accountGeneration),
	);
	const percent = (value: number | null): string =>
		value === null ? "unavailable" : `${value.toFixed(2)}%`;
	const telemetry = decision.reason === "telemetry";
	const recovered = decision.phase === "recovered";
	const symptom = telemetry
		? recovered
			? "Cache usage records available again"
			: "Cache usage unavailable in request records"
		: recovered
			? "RECORDED cache reuse recovered"
			: "RECORDED cache reuse low";
	return {
		id: decision.id,
		timestamp: decision.timestamp,
		type: decision.type,
		severity: decision.severity,
		title: `${symptom} (${decision.phase})`,
		message: [
			`${symptom}. Provider: ${scope.provider}; model: ${scope.model}; ${account === null ? `accounts: ${contributors.join(", ")}` : `account: ${account}`}.`,
			`UTC evidence: ${new Date(evidence.startMs).toISOString()} to ${new Date(evidence.endMs).toISOString()} (end exclusive).`,
			`RECORDED reuse: ${percent(decision.reusePercent)}; ${telemetry ? "coverage" : "reuse"} threshold: ${decision.threshold}%; stored coverage: ${percent(decision.coveragePercent)}; zero-hit share: ${percent(decision.zeroHitPercent)}.`,
			`Requests: ${evidence.measured} measured / ${evidence.eligible} eligible; missing ${evidence.missing}, invalid ${evidence.invalid}; excluded zero-input ${evidence.zeroInput}, failed ${evidence.failed}, internal ${evidence.internal}.`,
			`Input tokens: ${evidence.inputTokens + evidence.cacheReadTokens + evidence.cacheWriteTokens} total (uncached ${evidence.inputTokens}, read ${evidence.cacheReadTokens}, creation ${evidence.cacheWriteTokens}).`,
			"Recorded usage does not establish a warmed prefix or a cache-backend cause.",
		].join("\n"),
		value: telemetry ? decision.coveragePercent : decision.reusePercent,
		threshold: decision.threshold,
		account,
		model: scope.model,
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

export class AlertService {
	private readonly db: BunSqlAdapter;
	private readonly config: Config;
	private readonly requestListener: (event: RequestEvt) => void;
	private readonly authFailureListener: (event: AuthFailureEvt) => void;
	private readonly codexCatalogListener: (event: CodexCatalogEvt) => void;
	private readonly configChangeListener: ({ key }: { key: string }) => void;
	private anomalyTimer: ReturnType<typeof setInterval> | null = null;
	private cacheHealthTimer: ReturnType<typeof setInterval> | null = null;
	private cacheHealthFlight: Promise<void> | null = null;
	private cacheHealthEpoch = 0;
	private cacheHealthDelivery = new AbortController();
	private started = false;
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
				// Request-level alerting includes aggregate database queries. A transient
				// rejection must stay inside this fire-and-forget event boundary rather
				// than becoming an unhandled rejection that terminates the proxy.
				this.evaluateRequest(event.payload).catch((error) => {
					log.error(
						`Alert evaluation failed for request ${event.payload.id}: ${(error as Error).message}`,
					);
				});
			}
		};
		this.authFailureListener = (event) => {
			// Authentication alerts are also dispatched from a synchronous event
			// emitter, so contain failures from config lookup or persistence here.
			this.handleAuthFailure(event).catch((error) => {
				log.error(
					`Auth-failure alert evaluation failed for account ${event.accountId}: ${(error as Error).message}`,
				);
			});
		};
		this.codexCatalogListener = (event) => {
			// Emitted synchronously from proxy catalog and routing paths; contain
			// lookup and persistence failures here, as for auth failures.
			this.evaluateCodexCatalogEvent(event).catch((error) => {
				log.error(
					`Codex catalog alert evaluation failed for ${event.type}: ${(error as Error).message}`,
				);
			});
		};
		this.configChangeListener = ({ key }: { key: string }) => {
			if (
				key === "alert_anomaly_enabled" ||
				key === "alert_anomaly_interval_minutes"
			) {
				this.restartAnomalyTimer();
			}
			if (
				key.startsWith("alert_cache_health_") ||
				key === "alert_webhook_url" ||
				key === "alert_webhook_types"
			) {
				this.restartCacheHealthTimer();
			}
		};
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		requestEvents.on("event", this.requestListener);
		this.config.on("change", this.configChangeListener);
		authFailureEvents.on("event", this.authFailureListener);
		codexCatalogEvents.on("event", this.codexCatalogListener);
		this.restartAnomalyTimer();
		this.restartCacheHealthTimer();
	}

	stop(): Promise<void> {
		this.started = false;
		requestEvents.off("event", this.requestListener);
		this.config.off("change", this.configChangeListener);
		authFailureEvents.off("event", this.authFailureListener);
		codexCatalogEvents.off("event", this.codexCatalogListener);
		if (this.anomalyTimer) {
			clearInterval(this.anomalyTimer);
			this.anomalyTimer = null;
		}
		this.invalidateCacheHealth();
		// Synchronous callers still detach listeners/timers immediately. The
		// existing disposal registry can await an already-admitted DB batch.
		return this.cacheHealthFlight ?? Promise.resolve();
	}

	private invalidateCacheHealth(): void {
		this.cacheHealthEpoch++;
		this.cacheHealthDelivery.abort();
		this.cacheHealthDelivery = new AbortController();
		if (this.cacheHealthTimer) clearInterval(this.cacheHealthTimer);
		this.cacheHealthTimer = null;
	}

	private restartCacheHealthTimer(): void {
		this.invalidateCacheHealth();
		// Older Config test doubles deliberately have no cache accessors. They
		// keep their original timer/query behavior; real Config defaults on.
		if (!this.started || !this.config.getAlertCacheHealthEnabled?.()) return;
		this.cacheHealthTimer = setInterval(() => {
			void this.evaluateCacheHealth();
		}, CACHE_HEALTH_INTERVAL_MS);
		this.cacheHealthTimer.unref?.();
	}

	private cacheHealthConfig(): CacheHealthEvaluationConfig {
		const settings = getAlertsConfig(this.config);
		const warningPercent =
			settings.cacheHealthThresholdPercent ??
			CACHE_HEALTH_DEFAULT_POLICY.warningPercent;
		return {
			enabled: this.config.getAlertCacheHealthEnabled?.() ?? false,
			policy: {
				...CACHE_HEALTH_DEFAULT_POLICY,
				warningPercent,
				criticalPercent: Math.min(
					CACHE_HEALTH_DEFAULT_POLICY.criticalPercent,
					warningPercent,
				),
				recoveryPercent: Math.min(100, warningPercent + 2),
				warningBuckets:
					((settings.cacheHealthDurationMinutes ??
						(CACHE_HEALTH_DEFAULT_POLICY.warningBuckets *
							CACHE_HEALTH_BUCKET_MS) /
							60_000) *
						60_000) /
					CACHE_HEALTH_BUCKET_MS,
				minimumRequests:
					settings.cacheHealthMinRequests ??
					CACHE_HEALTH_DEFAULT_POLICY.minimumRequests,
				minimumInputTokens:
					settings.cacheHealthMinInputTokens ??
					CACHE_HEALTH_DEFAULT_POLICY.minimumInputTokens,
				reminderMs:
					(settings.cacheHealthReminderMinutes ??
						CACHE_HEALTH_DEFAULT_POLICY.reminderMs / 60_000) * 60_000,
			},
			webhookUrl: settings.webhookUrl,
			allowedTypes: [...this.config.getAlertWebhookTypes()],
		};
	}

	/** A clock-injected entry point for fixture evaluation and the five-minute
	 * timer. A concurrent tick joins the existing scan; every later tick loads
	 * persisted revisions again, including after a CAS loss or failed batch. */
	evaluateCacheHealth(nowMs = Date.now()): Promise<void> {
		if (!this.started) return Promise.resolve();
		if (this.cacheHealthFlight) return this.cacheHealthFlight;
		const epoch = this.cacheHealthEpoch;
		const flight = this.scanCacheHealth(nowMs, epoch)
			.catch(() => {
				// Do not log query/config/transport exception contents or account data.
				log.warn("Cache health evaluation failed; retrying on a later tick");
			})
			.finally(() => {
				if (this.cacheHealthFlight === flight) this.cacheHealthFlight = null;
			});
		this.cacheHealthFlight = flight;
		return flight;
	}

	private async scanCacheHealth(nowMs: number, epoch: number): Promise<void> {
		if (!this.config.getAlertCacheHealthEnabled?.()) return;
		const configuration = this.cacheHealthConfig();
		if (!configuration.enabled) return;
		const signature = JSON.stringify(configuration);
		const current = () =>
			this.started &&
			epoch === this.cacheHealthEpoch &&
			signature === JSON.stringify(this.cacheHealthConfig());
		const signal = this.cacheHealthDelivery.signal;
		const repository = new CacheHealthRepository(this.db);
		const loaded = await repository.loadStates(nowMs); // includes repository cleanup
		if (!current()) return;
		// Labels only: never select a credential-bearing Account row.
		const labels = await this.db.query<CacheHealthAccountLabel>(
			"SELECT id, name, created_at FROM accounts",
		);
		if (!current()) return;
		const accounts = new Map(labels.map((account) => [account.id, account]));
		const states = new Map<string, CacheHealthState>();
		for (const state of loaded) {
			const key = cacheHealthScopeKey(state.scope);
			const invalid = state.contributors.filter(
				(c) =>
					Number(accounts.get(c.accountId)?.created_at) !== c.accountGeneration,
			);
			if (state.scope.kind === "provider" && invalid.length > 0) {
				// Repository cleanup handles account scopes. Provider evidence can
				// span several generations; retire it only if still invalid and at
				// the loaded revision, so concurrent fresh evidence cannot be lost.
				if (!current()) return;
				const removed = await this.db.runWithChanges(
					`DELETE FROM cache_health_state WHERE scope_key = ? AND revision = ? AND (${invalid.map(() => "NOT EXISTS (SELECT 1 FROM accounts WHERE id = ? AND created_at = ?)").join(" OR ")})`,
					[
						key,
						state.revision,
						...invalid.flatMap((c) => [c.accountId, c.accountGeneration]),
					],
				);
				if (!current() || removed === 0) return;
				continue;
			}
			states.set(key, state);
		}
		const window = cacheHealthQueryWindow(nowMs);
		const buckets = await repository.fetchBuckets(window.startMs, window.endMs);
		if (!current()) return;
		const enrolled = new Set(
			[...states]
				.filter(([, state]) => state.scope.kind === "account" && state.enrolled)
				.map(([key]) => key),
		);
		// Aggregate the entire chronological window first. This carries newly
		// learned enrollment into later zero buckets, before any volume floors.
		const providers = aggregateProviderCacheBuckets(buckets, enrolled);
		const ordered = [...buckets, ...providers].sort(
			(left, right) =>
				left.endMs - right.endMs ||
				(left.scope.kind === right.scope.kind
					? cacheHealthScopeKey(left.scope).localeCompare(
							cacheHealthScopeKey(right.scope),
						)
					: left.scope.kind === "account"
						? -1
						: 1),
		);
		const accountDecisions: CacheHealthAlertDecision[] = [];
		for (const bucket of ordered) {
			if (!current()) return;
			const key = cacheHealthScopeKey(bucket.scope);
			const previous = states.get(key) ?? createCacheHealthState(bucket.scope);
			const next = advanceCacheHealth(
				previous,
				bucket,
				configuration.policy,
				nowMs,
			);
			if (next.state === previous) continue;
			const decisions = next.alerts.filter((decision) => {
				if (
					decision.phase !== "opened" ||
					!isRedundantProviderCacheAlert(decision, accountDecisions, [
						...states.values(),
					])
				)
					return true;
				// A suppressed parent must not retain an invisible incident that
				// blocks a newly affected account. Only openings are suppressed;
				// once a provider opening is real its recovery is always retained.
				next.state[decision.reason].incident = null;
				return false;
			});
			const alerts = decisions.map((decision) =>
				cacheHealthAlertEvent(decision, accounts),
			);
			if (!current()) return;
			const won = await repository.commit(
				previous.revision,
				next.state,
				alerts,
			);
			// A submitted atomic batch can finish during stop; stop() awaits it.
			// Never start another batch or publish from an invalidated evaluation.
			if (!current() || !won) return;
			states.set(key, next.state);
			if (bucket.scope.kind === "account") accountDecisions.push(...decisions);
			for (const alert of alerts) {
				if (!current()) return;
				this.publishPersistedAlert(
					alert,
					configuration.webhookUrl,
					configuration.allowedTypes,
					signal,
				);
			}
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

	/**
	 * Turn one Codex catalog event into alerts. Called from the codexCatalogEvents
	 * listener; public (like evaluateUsageSnapshot) so callers and tests can
	 * await one evaluation with an explicit clock.
	 *
	 * Role-target and pin alerts are content-addressed and fire once per real
	 * change; stale-catalog, route-profile and identity-record alerts are
	 * bucketed by the configured cooldown.
	 */
	async evaluateCodexCatalogEvent(
		event: CodexCatalogEvt,
		timestamp: number = Date.now(),
	): Promise<void> {
		const config = getAlertsConfig(this.config);
		switch (event.type) {
			case "role_target_changed":
				await this.persistAndEmit(
					buildCodexRoleTargetChangedAlert(event, timestamp),
					config.webhookUrl,
				);
				return;
			case "own_catalog_published": {
				// Credential-free columns only, read fresh so attribution sees the
				// account's current pins; a deleted account has nothing to report.
				const row = await this.db.get<CodexPinAccountRow>(
					`SELECT id, name, provider, model_mappings, custom_endpoint, model_fallbacks, created_at
					 FROM accounts WHERE id = ?`,
					[event.accountId],
				);
				if (!row || row.provider !== "codex") return;
				const alerts = buildCodexPinAlerts(
					row,
					event,
					timestamp,
					getProviderModelDefaultOverrides().codex,
				);
				for (const alert of alerts) {
					// Generation fence: a same-id replacement must not inherit these.
					await this.persistAndEmit(
						alert,
						config.webhookUrl,
						[],
						row.id,
						Number(row.created_at),
					);
				}
				return;
			}
			case "catalog_stale":
				await this.persistAndEmit(
					buildCodexCatalogStaleAlert(event, timestamp, config.cooldownMinutes),
					config.webhookUrl,
				);
				return;
			case "route_role_unavailable": {
				const accountName = event.accountId
					? ((
							await this.db.get<{ name: string }>(
								"SELECT name FROM accounts WHERE id = ?",
								[event.accountId],
							)
						)?.name ?? null)
					: null;
				await this.persistAndEmit(
					buildCodexRouteRoleUnavailableAlert(
						event,
						accountName,
						timestamp,
						config.cooldownMinutes,
					),
					config.webhookUrl,
				);
				return;
			}
			case "identity_record_stale":
				await this.persistAndEmit(
					buildCodexIdentityRecordAlert(
						event,
						timestamp,
						config.cooldownMinutes,
					),
					config.webhookUrl,
				);
				return;
		}
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
				// The interval has no caller to await its asynchronous database work.
				// Catch failures at the registered callback so later ticks remain active.
				this.evaluateAnomalies().catch((error) => {
					log.error(`Anomaly evaluation failed: ${(error as Error).message}`);
				});
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
		this.publishPersistedAlert(alert, webhookUrl);
	}

	/** Both ordinary insert winners and atomic cache-state winners use this
	 * publication boundary. Persistence is not a webhook delivery receipt. */
	private publishPersistedAlert(
		alert: AlertEvent,
		webhookUrl: string,
		allowedTypes?: readonly AlertType[],
		signal?: AbortSignal,
	): void {
		if (signal?.aborted) return;
		const event: AlertEvt = { type: "alert", payload: alert };
		alertEvents.emit("event", event);
		if (
			!signal?.aborted &&
			webhookUrl &&
			isAlertTypeAllowedForWebhook(
				alert.type,
				allowedTypes ?? this.config.getAlertWebhookTypes(),
			)
		) {
			void deliverAlertWebhook(webhookUrl, alert, signal);
		}
	}
}
