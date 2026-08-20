import { getModelRates, type ModelRates } from "@better-ccflare/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	CODEX_CACHE_KEY_MODE_ENV,
	CODEX_PROMPT_CACHE_KEY_ENV,
	getCodexExplicitCacheBreakpointSuppressionCount,
	readCodexCacheKeyContinuityPercent,
	readCodexCacheKeyPrefixShardPercent,
	readCodexCacheKeySessionPercent,
	readCodexExplicitCacheBreakpointPercent,
	readCodexTurnStateConfig,
} from "@better-ccflare/providers";
import {
	readCachePacingMs,
	readCodexCachePacingSettleMs,
	readCodexPacingBypassPercent,
	readCodexWebSocketPercent,
} from "@better-ccflare/proxy";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	DEFAULT_LOOP_MIN_REQUESTS,
	DEFAULT_LOOP_SIMILARITY_TOLERANCE,
	DEFAULT_LOOP_WINDOW_MINUTES,
	DEFAULT_MAX_EVENTS_PER_DETECTOR,
	DEFAULT_MIN_BASELINE_REQUESTS,
	DEFAULT_MISROUTING_MAX_TOTAL_TOKENS,
	DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD,
	DEFAULT_MISROUTING_MIN_REQUESTS,
	DEFAULT_Z_SCORE_THRESHOLD,
	sanitizeProjectForDisplay,
} from "../services/anomaly-insights";
import {
	buildCacheInsightsResponse,
	DEFAULT_THRESHOLD_PERCENT,
	type GroupedTokenRow,
} from "../services/cache-insights";
import {
	buildCacheParityResponse,
	type CacheParityAggregateRow,
	type CacheParityPolicy,
} from "../services/cache-parity";
import {
	analyzePayloadWrapper,
	buildContextInsightsResponse,
	type ContextGrowthRow,
	type ContextRequestRow,
	DEFAULT_PAYLOAD_SCAN_LIMIT,
	DEFAULT_SESSION_GAP_MINUTES,
	DEFAULT_TOP_CONTRIBUTORS,
	MAX_PAYLOAD_SCAN_LIMIT,
	MAX_TOP_CONTRIBUTORS,
	type PayloadAnalysis,
} from "../services/context-insights";
import type { APIContext } from "../types";
import { buildRequestFilters, getRangeConfig } from "../utils/query-filters";

const log = new Logger("InsightsHandler");

/** Raw GROUP BY row shape shared by both insights queries. */
interface GroupedTokenSqlRow {
	dimension_key: string | null;
	model: string | null;
	requests: number;
	uncached_input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

function toGroupedTokenRow(row: GroupedTokenSqlRow): GroupedTokenRow {
	return {
		dimensionKey: row.dimension_key,
		model: row.model,
		requests: Number(row.requests) || 0,
		uncachedInputTokens: Number(row.uncached_input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
	};
}

/** Parse the threshold query param: float, default 50, clamped to 0-100. */
function parseThresholdPercent(raw: string | null): number {
	if (raw === null) return DEFAULT_THRESHOLD_PERCENT;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_THRESHOLD_PERCENT;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * GET /api/insights/cache — cache efficiency insights.
 *
 * Aggregates token sums per (account, model) and (project, model) over the
 * requested range/filters, prices the cache volume via the pricing catalogue,
 * and returns hit rates, dollar savings and low-hit-rate flags.
 */
export function createCacheInsightsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		// Normalize the raw query param so meta.range reflects the window used.
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const { whereClause, params: queryParams } = buildRequestFilters(
			searchParams,
			startMs,
		);
		const thresholdPercent = parseThresholdPercent(
			searchParams.get("threshold"),
		);

		try {
			// account x model (also the source for byModel and totals)
			const accountModelSqlRows = await db.query<GroupedTokenSqlRow>(
				`
				SELECT
					COALESCE(a.name, 'Unknown') as dimension_key,
					r.model as model,
					COUNT(*) as requests,
					SUM(COALESCE(r.input_tokens, 0)) as uncached_input_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation_input_tokens
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE ${whereClause}
				GROUP BY COALESCE(a.name, 'Unknown'), r.model
			`,
				queryParams,
			);

			// project x model
			const projectModelSqlRows = await db.query<GroupedTokenSqlRow>(
				`
				SELECT
					COALESCE(r.project, 'Unknown') as dimension_key,
					r.model as model,
					COUNT(*) as requests,
					SUM(COALESCE(r.input_tokens, 0)) as uncached_input_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation_input_tokens
				FROM requests r
				WHERE ${whereClause}
				GROUP BY COALESCE(r.project, 'Unknown'), r.model
			`,
				queryParams,
			);

			const accountModelRows = accountModelSqlRows.map(toGroupedTokenRow);
			const projectModelRows = projectModelSqlRows.map(toGroupedTokenRow);

			// Price each distinct model id once; null/empty models are handled by
			// the service as "Unknown" and never priced.
			const modelIds = [
				...new Set(
					[...accountModelRows, ...projectModelRows]
						.map((row) => row.model)
						.filter((model): model is string => model != null && model !== ""),
				),
			];
			const rateList = await Promise.all(
				modelIds.map((modelId) => getModelRates(modelId)),
			);
			const rates = new Map<string, ModelRates | null>(
				modelIds.map((modelId, index) => [modelId, rateList[index]]),
			);

			return jsonResponse(
				buildCacheInsightsResponse({
					accountModelRows,
					projectModelRows,
					rates,
					options: { range, thresholdPercent },
				}),
			);
		} catch (error) {
			log.error("Cache insights error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch cache insights data"),
			);
		}
	};
}

interface CacheParitySqlRow {
	provider: string;
	physical_model: string;
	account_name: string;
	turn_kind: "first_observed" | "follow_up";
	gap_band: string;
	context_band: string;
	same_account: number | boolean;
	cache_share_bucket: number | null;
	requests: number;
	successful_requests: number;
	fallback_requests: number;
	context_overflow_requests: number;
	input_tokens: number;
	cache_read_input_tokens: number;
}

const CACHE_PARITY_WINDOW_SQL = `
	WITH sequenced AS (
		SELECT
			r.id,
			r.timestamp,
			r.account_used,
			r.success,
			r.failover_attempts,
			r.error_message,
			COALESCE(r.input_tokens, 0) +
				COALESCE(r.cache_read_input_tokens, 0) +
				COALESCE(r.cache_creation_input_tokens, 0) AS request_input_tokens,
			COALESCE(r.cache_read_input_tokens, 0) AS cache_read_input_tokens,
			COALESCE(a.provider, 'unknown') AS provider,
			COALESCE(NULLIF(r.applied_model, ''), NULLIF(r.model, ''), 'unknown') AS physical_model,
			COALESCE(a.name, 'Unknown') AS account_name,
			LAG(r.timestamp) OVER (
				PARTITION BY COALESCE(a.provider, 'unknown'), r.client_session_id
				ORDER BY r.timestamp, r.id
			) AS previous_timestamp,
			LAG(r.account_used) OVER (
				PARTITION BY COALESCE(a.provider, 'unknown'), r.client_session_id
				ORDER BY r.timestamp, r.id
			) AS previous_account
		FROM requests r
		LEFT JOIN accounts a ON a.id = r.account_used
		WHERE r.timestamp >= ?
			AND r.path = '/v1/messages'
			AND r.client_session_id IS NOT NULL
	), classified AS (
		SELECT
			*,
			CASE
				WHEN previous_timestamp IS NULL THEN 'first_observed'
				ELSE 'follow_up'
			END AS turn_kind,
			CASE
				WHEN previous_timestamp IS NULL THEN 'unknown'
				WHEN timestamp - previous_timestamp < 60000 THEN 'under_1m'
				WHEN timestamp - previous_timestamp < 300000 THEN 'from_1m_to_5m'
				WHEN timestamp - previous_timestamp < 900000 THEN 'from_5m_to_15m'
				WHEN timestamp - previous_timestamp < 3600000 THEN 'from_15m_to_60m'
				ELSE 'at_least_60m'
			END AS gap_band,
			CASE
				WHEN request_input_tokens < 50000 THEN 'under_50k'
				WHEN request_input_tokens < 100000 THEN 'from_50k_to_100k'
				WHEN request_input_tokens < 200000 THEN 'from_100k_to_200k'
				ELSE 'at_least_200k'
			END AS context_band,
			CASE
				WHEN previous_account IS NOT NULL AND previous_account = account_used THEN 1
				ELSE 0
			END AS same_account,
			CASE
				WHEN success = TRUE AND request_input_tokens > 0 THEN
					CASE
						WHEN cache_read_input_tokens >= request_input_tokens THEN 100
						ELSE (cache_read_input_tokens * 100) / request_input_tokens
					END
				ELSE NULL
			END AS cache_share_bucket
		FROM sequenced
	)
	SELECT
		provider,
		physical_model,
		account_name,
		turn_kind,
		gap_band,
		context_band,
		same_account,
		cache_share_bucket,
		COUNT(*) AS requests,
		SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful_requests,
		SUM(CASE WHEN COALESCE(failover_attempts, 0) > 0 THEN 1 ELSE 0 END) AS fallback_requests,
		SUM(CASE
			WHEN LOWER(COALESCE(error_message, '')) LIKE '%context%'
				AND (
					LOWER(COALESCE(error_message, '')) LIKE '%exceed%'
					OR LOWER(COALESCE(error_message, '')) LIKE '%overflow%'
					OR LOWER(COALESCE(error_message, '')) LIKE '%too long%'
				)
			THEN 1 ELSE 0
		END) AS context_overflow_requests,
		SUM(CASE WHEN cache_share_bucket IS NOT NULL THEN request_input_tokens ELSE 0 END) AS input_tokens,
		SUM(CASE WHEN cache_share_bucket IS NOT NULL THEN cache_read_input_tokens ELSE 0 END) AS cache_read_input_tokens
	FROM classified
	GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
`;

const OFFICIAL_CODEX_MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^gpt-5\.6-sol(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-sol"],
	[/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-terra"],
	[/^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-luna"],
	[/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.5"],
	[/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4-mini"],
	[/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4"],
	[/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.3-codex"],
];

function safeParityPhysicalModel(provider: string, model: string): string {
	if (provider !== "codex") return model;
	for (const [pattern, family] of OFFICIAL_CODEX_MODEL_FAMILIES) {
		if (pattern.test(model)) return family;
	}
	return model === "unknown" ? "unknown" : "other_or_custom";
}

function toCacheParityAggregateRow(
	row: CacheParitySqlRow,
): CacheParityAggregateRow {
	return {
		provider: row.provider,
		physicalModel: safeParityPhysicalModel(row.provider, row.physical_model),
		accountName: row.account_name,
		turnKind: row.turn_kind,
		gapBand: row.gap_band,
		contextBand: row.context_band,
		sameAccount: row.same_account === true || Number(row.same_account) === 1,
		cacheShareBucket:
			row.cache_share_bucket === null
				? null
				: Number(row.cache_share_bucket),
		requests: Number(row.requests) || 0,
		successfulRequests: Number(row.successful_requests) || 0,
		fallbackRequests: Number(row.fallback_requests) || 0,
		contextOverflowRequests: Number(row.context_overflow_requests) || 0,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
	};
}

function readCacheParityPolicy(context: APIContext): CacheParityPolicy {
	const turnState = readCodexTurnStateConfig();
	return {
		promptCacheKeyEnabled: process.env[CODEX_PROMPT_CACHE_KEY_ENV] !== "0",
		cacheKeyMode:
			process.env[CODEX_CACHE_KEY_MODE_ENV] === "session"
				? "session"
				: "conversation",
		cacheKeySessionPercent: readCodexCacheKeySessionPercent(),
		cacheKeyContinuityPercent: readCodexCacheKeyContinuityPercent(),
		cacheKeyPrefixShardPercent: readCodexCacheKeyPrefixShardPercent(),
		pacingMs: readCachePacingMs(),
		codexSettleMs: readCodexCachePacingSettleMs(),
		pacingBypassPercent: readCodexPacingBypassPercent(),
		explicitBreakpointPercent: readCodexExplicitCacheBreakpointPercent(),
		explicitBreakpointSuppressedScopes:
			getCodexExplicitCacheBreakpointSuppressionCount(),
		turnStatePercent: turnState.percent,
		turnStateObserveOnly: turnState.observeOnly,
		webSocketPercent: readCodexWebSocketPercent(),
		globalKeepaliveTtlMinutes:
			typeof context.config.getCacheKeepaliveTtlMinutes === "function"
				? context.config.getCacheKeepaliveTtlMinutes()
				: 0,
	};
}

/** GET /api/insights/cache-parity — sustained cache parity and live policy. */
export function createCacheParityHandler(context: APIContext) {
	return async (): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const generatedAt = Date.now();
		try {
			const [rows24h, rows7d] = await Promise.all([
				db.query<CacheParitySqlRow>(
					CACHE_PARITY_WINDOW_SQL,
					[generatedAt - 24 * 60 * 60 * 1000],
				),
				db.query<CacheParitySqlRow>(
					CACHE_PARITY_WINDOW_SQL,
					[generatedAt - 7 * 24 * 60 * 60 * 1000],
				),
			]);
			return jsonResponse(
				buildCacheParityResponse({
					rows24h: rows24h.map(toCacheParityAggregateRow),
					rows7d: rows7d.map(toCacheParityAggregateRow),
					policy: readCacheParityPolicy(context),
					generatedAt,
				}),
			);
		} catch (error) {
			log.error("Cache parity error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch cache parity data"),
			);
		}
	};
}

/**
 * Hard cap on rows fetched per anomalies request. With wide ranges on
 * high-traffic instances the raw fetch would otherwise be unbounded; beyond
 * the cap only the most recent rows are analyzed and meta.truncated is set.
 */
const MAX_ANOMALY_SCAN_ROWS = 100_000;

/** Raw per-request row shape for the anomalies query. */
interface AnomalyRequestSqlRow {
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

function toAnomalyRequestRow(row: AnomalyRequestSqlRow): AnomalyRequestRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		account: row.account,
		model: row.model,
		// Defence in depth: sanitise the project field at the boundary so
		// control chars / overly long prompt content cannot leak through
		// the API response. The real extraction bug is upstream (#368).
		project: sanitizeProjectForDisplay(row.project),
		agentUsed: row.agent_used,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
		costUsd: Number(row.cost_usd) || 0,
	};
}

/**
 * Parse a numeric detector-threshold query param: fall back to the default
 * when missing or unparseable, clamp to [min, max], optionally round to an
 * integer (for count-like params). Exported for tests.
 */
export function parseDetectorParam(
	raw: string | null,
	fallback: number,
	min: number,
	max: number,
	integer = false,
): number {
	const parsed = raw === null ? fallback : Number.parseFloat(raw);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	const clamped = Math.min(max, Math.max(min, value));
	return integer ? Math.round(clamped) : clamped;
}

/**
 * GET /api/insights/anomalies — token anomaly detection.
 *
 * Fetches per-request rows over the requested range/filters in one batch
 * query and runs the pure detectors from services/anomaly-insights:
 * per-account/model baselines, token outliers, output blowups, runaway
 * loops, and model misrouting. Detector thresholds are query params with
 * sane defaults (see AnomalyInsightsOptions).
 */
export function createAnomalyInsightsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const { whereClause, params: queryParams } = buildRequestFilters(
			searchParams,
			startMs,
		);

		const options = {
			range,
			zScoreThreshold: parseDetectorParam(
				searchParams.get("zScoreThreshold"),
				DEFAULT_Z_SCORE_THRESHOLD,
				0.5,
				10,
			),
			minBaselineRequests: parseDetectorParam(
				searchParams.get("minBaselineRequests"),
				DEFAULT_MIN_BASELINE_REQUESTS,
				2,
				100_000,
				true,
			),
			loopWindowMinutes: parseDetectorParam(
				searchParams.get("loopWindowMinutes"),
				DEFAULT_LOOP_WINDOW_MINUTES,
				1,
				120,
				true,
			),
			loopMinRequests: parseDetectorParam(
				searchParams.get("loopMinRequests"),
				DEFAULT_LOOP_MIN_REQUESTS,
				2,
				10_000,
				true,
			),
			loopSimilarityTolerance: parseDetectorParam(
				searchParams.get("loopSimilarityTolerance"),
				DEFAULT_LOOP_SIMILARITY_TOLERANCE,
				0,
				5,
			),
			misroutingMaxTotalTokens: parseDetectorParam(
				searchParams.get("misroutingMaxTotalTokens"),
				DEFAULT_MISROUTING_MAX_TOTAL_TOKENS,
				1,
				1_000_000,
				true,
			),
			misroutingMinOutputRateUsd: parseDetectorParam(
				searchParams.get("misroutingMinOutputRateUsd"),
				DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD,
				0,
				10_000,
			),
			misroutingMinRequests: parseDetectorParam(
				searchParams.get("misroutingMinRequests"),
				DEFAULT_MISROUTING_MIN_REQUESTS,
				1,
				10_000,
				true,
			),
			maxEventsPerDetector: parseDetectorParam(
				searchParams.get("maxEventsPerDetector"),
				DEFAULT_MAX_EVENTS_PER_DETECTOR,
				1,
				500,
				true,
			),
		};

		try {
			// Safety cap on the batch fetch: scan at most the most recent
			// MAX_ANOMALY_SCAN_ROWS rows (fetch one extra to detect truncation).
			const sqlRows = await db.query<AnomalyRequestSqlRow>(
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
				WHERE ${whereClause}
				ORDER BY r.timestamp DESC
				LIMIT ${MAX_ANOMALY_SCAN_ROWS + 1}
			`,
				queryParams,
			);
			const truncated = sqlRows.length > MAX_ANOMALY_SCAN_ROWS;
			// Undo the DESC fetch order so detectors see chronological rows.
			// Not load-bearing (the loop detector re-sorts per group), just
			// keeps the row order deterministic and intuitive.
			const rows = sqlRows
				.slice(0, MAX_ANOMALY_SCAN_ROWS)
				.map(toAnomalyRequestRow)
				.reverse();

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
			const rates = new Map<string, ModelRates | null>(
				modelIds.map((modelId, index) => [modelId, rateList[index]]),
			);

			return jsonResponse(
				buildAnomalyInsightsResponse({
					rows,
					rates,
					options: { ...options, truncated },
				}),
			);
		} catch (error) {
			log.error("Anomaly insights error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch anomaly insights data"),
			);
		}
	};
}

/**
 * Hard cap on rows fetched for the context growth curve. The growth query
 * reads the requests table only (no payload join), so it may scan far more
 * rows than the payload loop; beyond the cap only the most recent rows are
 * used and growthCurve.truncated is set.
 */
const MAX_GROWTH_SCAN_ROWS = 20_000;

/** Upper bound for the sessionGapMinutes query param (12 hours). */
const MAX_SESSION_GAP_MINUTES = 720;

/** Raw row shape for the payload coverage query. */
interface ContextCoverageSqlRow {
	requests_in_range: number;
	requests_with_payload: number;
}

/** Raw per-request row shape for the context candidate query. */
interface ContextRequestSqlRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
}

function toContextRequestRow(row: ContextRequestSqlRow): ContextRequestRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		account: row.account,
		model: row.model,
		project: row.project,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
	};
}

/** Raw per-request row shape for the growth-curve query. */
interface ContextGrowthSqlRow {
	id: string;
	timestamp: number;
	project: string | null;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
}

function toContextGrowthRow(row: ContextGrowthSqlRow): ContextGrowthRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		project: row.project,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
	};
}

/**
 * GET /api/insights/context — context composition analysis from stored
 * request payloads.
 *
 * Payload storage is optional (store_payloads) and retention-cleaned, so
 * coverage is partial — meta.payloadCoverage reports requests in the window
 * vs requests with a stored payload. To bound memory, candidate request ids
 * are fetched metadata-only first, then each payload's json column is
 * fetched, parsed, aggregated and discarded ONE ROW AT A TIME; the json
 * column is never selected in a multi-row query. The growth curve uses only
 * exact requests-table token columns (no payload parsing).
 */
export function createContextInsightsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const { whereClause, params: queryParams } = buildRequestFilters(
			searchParams,
			startMs,
		);
		const limit = parseDetectorParam(
			searchParams.get("limit"),
			DEFAULT_PAYLOAD_SCAN_LIMIT,
			1,
			MAX_PAYLOAD_SCAN_LIMIT,
			true,
		);
		const topContributors = parseDetectorParam(
			searchParams.get("topContributors"),
			DEFAULT_TOP_CONTRIBUTORS,
			1,
			MAX_TOP_CONTRIBUTORS,
			true,
		);
		const sessionGapMinutes = parseDetectorParam(
			searchParams.get("sessionGapMinutes"),
			DEFAULT_SESSION_GAP_MINUTES,
			1,
			MAX_SESSION_GAP_MINUTES,
			true,
		);

		try {
			// Coverage: how many requests in the window have a stored payload at
			// all — payload storage is optional, so this can be far below 100%.
			const coverageRows = await db.query<ContextCoverageSqlRow>(
				`
				SELECT
					COUNT(*) as requests_in_range,
					COUNT(rp.id) as requests_with_payload
				FROM requests r
				LEFT JOIN request_payloads rp ON rp.id = r.id
				WHERE ${whereClause}
			`,
				queryParams,
			);
			const coverage = {
				requestsInRange: Number(coverageRows[0]?.requests_in_range) || 0,
				requestsWithPayload:
					Number(coverageRows[0]?.requests_with_payload) || 0,
			};

			// Candidate ids: metadata-only (the json column is deliberately NOT
			// selected here), most recent first, one extra row to detect truncation.
			const candidateSqlRows = await db.query<ContextRequestSqlRow>(
				`
				SELECT
					r.id as id,
					r.timestamp as timestamp,
					a.name as account,
					r.model as model,
					r.project as project,
					COALESCE(r.input_tokens, 0) as input_tokens,
					COALESCE(r.cache_read_input_tokens, 0) as cache_read_input_tokens,
					COALESCE(r.cache_creation_input_tokens, 0) as cache_creation_input_tokens,
					COALESCE(r.output_tokens, 0) as output_tokens
				FROM requests r
				JOIN request_payloads rp ON rp.id = r.id
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE ${whereClause}
				ORDER BY r.timestamp DESC
				LIMIT ${limit + 1}
			`,
				queryParams,
			);
			const truncated = candidateSqlRows.length > limit;
			const candidates = candidateSqlRows
				.slice(0, limit)
				.map(toContextRequestRow);

			// Sequential per-id loop keeps at most one payload in memory at a
			// time. getRequestPayload handles at-rest decryption; rows that
			// fail to decrypt or whose bodies don't parse (truncated 4MB-capped
			// bodies, invalid base64) count as unparseable in meta rather than
			// failing the request.
			const analyses: Array<{
				row: ContextRequestRow;
				analysis: PayloadAnalysis | null;
			}> = [];
			for (const row of candidates) {
				let payload: unknown = null;
				try {
					payload = await context.dbOps.getRequestPayload(row.id);
				} catch (error) {
					log.warn(`Failed to load payload ${row.id}:`, error);
				}
				analyses.push({
					row,
					analysis: payload === null ? null : analyzePayloadWrapper(payload),
				});
			}

			// Growth curve: exact token columns over the whole window, no payload
			// join. Fetch one extra row to detect truncation at the scan cap.
			const growthSqlRows = await db.query<ContextGrowthSqlRow>(
				`
				SELECT
					r.id as id,
					r.timestamp as timestamp,
					r.project as project,
					COALESCE(r.input_tokens, 0) as input_tokens,
					COALESCE(r.cache_read_input_tokens, 0) as cache_read_input_tokens,
					COALESCE(r.cache_creation_input_tokens, 0) as cache_creation_input_tokens,
					COALESCE(r.output_tokens, 0) as output_tokens
				FROM requests r
				WHERE ${whereClause}
				ORDER BY r.timestamp DESC
				LIMIT ${MAX_GROWTH_SCAN_ROWS + 1}
			`,
				queryParams,
			);
			const growthScanTruncated = growthSqlRows.length > MAX_GROWTH_SCAN_ROWS;
			// Undo the DESC fetch order so session building sees chronological rows.
			const growthRows = growthSqlRows
				.slice(0, MAX_GROWTH_SCAN_ROWS)
				.map(toContextGrowthRow)
				.reverse();

			return jsonResponse(
				buildContextInsightsResponse({
					analyses,
					coverage,
					growthRows,
					options: {
						range,
						truncated,
						growthScanTruncated,
						topContributors,
						sessionGapMinutes,
					},
				}),
			);
		} catch (error) {
			log.error("Context insights error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch context insights data"),
			);
		}
	};
}
