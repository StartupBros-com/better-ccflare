import {
	type AlertEvent,
	CACHE_HEALTH_BUCKET_MS,
	type CacheHealthBucket,
	type CacheHealthState,
	cacheHealthScopeKey,
	isNativeCacheHealthRoute,
} from "@better-ccflare/types";
import { BatchExpectedChangesError } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

const DAY_MS = 24 * 60 * 60_000;
const MAX_TOKENS = Number.MAX_SAFE_INTEGER;

/** Central stored-usage normalization; only protocol-specific writes may default to zero. */
export function cacheHealthBucketQuery(sqlite: boolean): string {
	const real = sqlite ? "REAL" : "DOUBLE PRECISION";
	const valid = (column: string) =>
		`(${sqlite ? `typeof(${column}) IN ('integer', 'real') AND ` : ""}${column} >= 0 AND ${column} <= ${MAX_TOKENS} AND ${column} = CAST(${column} AS BIGINT))`;
	return `WITH source AS (
		SELECT r.account_used, r.path, r.success, r.status_code,
			r.stream_terminal_state, r.internal_origin, r.cache_health_native,
			r.input_tokens, r.prompt_tokens, r.cache_read_input_tokens,
			r.cache_creation_input_tokens, a.created_at AS generation,
			COALESCE(NULLIF(r.routed_provider, ''), a.provider) AS provider,
			COALESCE(NULLIF(r.model, ''), NULLIF(r.routed_model, ''), NULLIF(r.applied_model, '')) AS physical_model,
			CAST(r.timestamp / ${CACHE_HEALTH_BUCKET_MS} AS BIGINT) * ${CACHE_HEALTH_BUCKET_MS} AS bucket_start
		FROM requests r JOIN accounts a ON a.id = r.account_used
		WHERE r.timestamp >= ? AND r.timestamp < ?
			AND r.method = 'POST'
			AND r.path IN ('/v1/messages', '/v1/responses', '/v1/chat/completions')
			AND r.account_generation = a.created_at
	), writes AS (
		SELECT source.*, CASE WHEN cache_creation_input_tokens IS NULL AND (
			path IN ('/v1/responses', '/v1/chat/completions')
			OR provider IN ('codex', 'xai', 'openai', 'openai-compatible', 'openrouter', 'ollama', 'litellm', 'omniroute')
		) THEN 0 ELSE cache_creation_input_tokens END AS cache_write
		FROM source WHERE physical_model IS NOT NULL AND provider IS NOT NULL
	), inputs AS (
		SELECT writes.*, CASE WHEN input_tokens IS NOT NULL THEN input_tokens
			WHEN ${valid("prompt_tokens")} AND ${valid("cache_read_input_tokens")} AND ${valid("cache_write")}
			THEN CAST(prompt_tokens AS ${real}) - cache_read_input_tokens - cache_write
			ELSE NULL END AS uncached
		FROM writes
	), classified AS (
		SELECT inputs.*, CASE
			WHEN internal_origin = 1 THEN 'internal'
			WHEN success IS NOT TRUE OR status_code IS NULL OR status_code < 200 OR status_code >= 300
				OR (stream_terminal_state IS NOT NULL AND stream_terminal_state <> 'complete') THEN 'failed'
			WHEN (uncached IS NOT NULL AND NOT ${valid("uncached")})
				OR (cache_read_input_tokens IS NOT NULL AND NOT ${valid("cache_read_input_tokens")})
				OR (cache_write IS NOT NULL AND NOT ${valid("cache_write")})
				OR (input_tokens IS NULL AND prompt_tokens IS NOT NULL AND NOT ${valid("prompt_tokens")})
				OR CAST(uncached AS ${real}) + cache_read_input_tokens + cache_write > ${MAX_TOKENS} THEN 'invalid'
			WHEN prompt_tokens = 0 AND COALESCE(input_tokens, 0) = 0
				AND COALESCE(cache_read_input_tokens, 0) = 0 AND COALESCE(cache_write, 0) = 0 THEN 'zero'
			WHEN uncached IS NULL OR cache_read_input_tokens IS NULL OR cache_write IS NULL THEN 'missing'
			WHEN uncached + cache_read_input_tokens + cache_write = 0 THEN 'zero'
			ELSE 'measured' END AS measurement
		FROM inputs
	)
	SELECT account_used, generation, provider, physical_model, bucket_start,
		MAX(cache_health_native) AS native,
		SUM(CASE WHEN measurement IN ('measured', 'missing', 'invalid') THEN 1 ELSE 0 END) AS eligible,
		SUM(CASE WHEN measurement = 'measured' THEN 1 ELSE 0 END) AS measured,
		SUM(CASE WHEN measurement = 'missing' THEN 1 ELSE 0 END) AS missing,
		SUM(CASE WHEN measurement = 'invalid' THEN 1 ELSE 0 END) AS invalid,
		SUM(CASE WHEN measurement = 'zero' THEN 1 ELSE 0 END) AS zero_input,
		SUM(CASE WHEN measurement = 'failed' THEN 1 ELSE 0 END) AS failed,
		SUM(CASE WHEN measurement = 'internal' THEN 1 ELSE 0 END) AS internal,
		SUM(CASE WHEN measurement = 'measured' AND cache_read_input_tokens = 0 THEN 1 ELSE 0 END) AS zero_hit,
		SUM(CASE WHEN measurement = 'measured' THEN CAST(uncached AS ${real}) ELSE 0 END) AS input_tokens,
		SUM(CASE WHEN measurement = 'measured' THEN CAST(cache_read_input_tokens AS ${real}) ELSE 0 END) AS read_tokens,
		SUM(CASE WHEN measurement = 'measured' THEN CAST(cache_write AS ${real}) ELSE 0 END) AS write_tokens
	FROM classified GROUP BY account_used, generation, provider, physical_model, bucket_start
	ORDER BY bucket_start, account_used, provider, physical_model`;
}

interface BucketRow {
	account_used: string;
	generation: number | string;
	provider: string;
	physical_model: string;
	bucket_start: number | string;
	native: number | string | null;
	eligible: number | string;
	measured: number | string;
	missing: number | string;
	invalid: number | string;
	zero_input: number | string;
	failed: number | string;
	internal: number | string;
	zero_hit: number | string;
	input_tokens: number | string;
	read_tokens: number | string;
	write_tokens: number | string;
}

const LIVE_GENERATION = `(account_id IS NULL OR EXISTS (
	SELECT 1 FROM accounts WHERE accounts.id = cache_health_state.account_id
	AND accounts.created_at = cache_health_state.account_generation))`;

interface StateRow {
	scope_key: string;
	revision: number | string;
	last_bucket_end: number | string;
	snapshot: string;
}

function readState(row: StateRow): CacheHealthState {
	const state = JSON.parse(row.snapshot) as CacheHealthState;
	if (
		state.version !== 1 ||
		cacheHealthScopeKey(state.scope) !== row.scope_key ||
		state.revision !== Number(row.revision) ||
		state.lastBucketEnd !== Number(row.last_bucket_end)
	)
		throw new Error("Invalid cache health snapshot");
	return state;
}

export class CacheHealthRepository extends BaseRepository<CacheHealthState> {
	/**
	 * One half-open fleet aggregate; never reads request payloads. Legacy rows
	 * without a captured account generation are unclassified: completion time
	 * cannot safely assign delayed writes across deletion/recreation.
	 */
	async fetchBuckets(
		startMs: number,
		endMs: number,
	): Promise<CacheHealthBucket[]> {
		if (
			![startMs, endMs].every(
				(n) =>
					Number.isSafeInteger(n) && n >= 0 && n % CACHE_HEALTH_BUCKET_MS === 0,
			) ||
			endMs <= startMs ||
			endMs - startMs > DAY_MS
		)
			throw new Error("Invalid cache health query window");
		const rows = await this.query<BucketRow>(
			cacheHealthBucketQuery(this.adapter.isSQLite),
			[startMs, endMs],
		);
		return rows.map((row) => {
			const tokens = [row.input_tokens, row.read_tokens, row.write_tokens].map(
				Number,
			);
			const totalsValid = [...tokens, tokens.reduce((a, b) => a + b, 0)].every(
				(n) => Number.isSafeInteger(n) && n >= 0,
			);
			const generation = Number(row.generation);
			const start = Number(row.bucket_start);
			if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(start))
				throw new Error("Invalid cache health identity");
			return {
				scope: {
					kind: "account",
					accountId: row.account_used,
					accountGeneration: generation,
					provider: row.provider,
					model: row.physical_model,
				},
				startMs: start,
				endMs: start + CACHE_HEALTH_BUCKET_MS,
				contributors: [
					{ accountId: row.account_used, accountGeneration: generation },
				],
				native:
					row.native === null
						? isNativeCacheHealthRoute(row.provider, false)
						: Number(row.native) === 1,
				eligible: Number(row.eligible),
				measured: Number(row.measured),
				missing: Number(row.missing),
				invalid: Number(row.invalid),
				zeroInput: Number(row.zero_input),
				failed: Number(row.failed),
				internal: Number(row.internal),
				zeroHit: Number(row.zero_hit),
				inputTokens: totalsValid ? tokens[0] : 0,
				cacheReadTokens: totalsValid ? tokens[1] : 0,
				cacheWriteTokens: totalsValid ? tokens[2] : 0,
				totalsValid,
			};
		});
	}

	/** Load live generations, including durable eligibility and active incidents. */
	async loadStates(nowMs: number): Promise<CacheHealthState[]> {
		await this.pruneStates(nowMs);
		// Retained snapshots must be visible with their existing revision: an
		// idle non-native route cannot relearn capability from zero cache hits.
		const rows = await this.query<StateRow>(
			`SELECT scope_key, revision, last_bucket_end, snapshot FROM cache_health_state
			WHERE ${LIVE_GENERATION}`,
		);
		return rows.map(readState);
	}

	/** Expire evidence, not learned eligibility, incident identity or open incidents. */
	async pruneStates(nowMs: number): Promise<number> {
		let deleted = await this.runWithChanges(
			`DELETE FROM cache_health_state WHERE NOT ${LIVE_GENERATION}`,
		);
		const rows = await this.query<StateRow>(
			`SELECT scope_key, revision, last_bucket_end, snapshot FROM cache_health_state
			WHERE last_bucket_end < ? AND ${LIVE_GENERATION}`,
			[nowMs - DAY_MS],
		);
		for (const row of rows) {
			const state = readState(row);
			// Sequence-only snapshots preserve monotonic incident ids even for
			// native telemetry incidents that never learned positive-cache evidence.
			if (
				!state.enrolled &&
				!state.reuse.incident &&
				!state.telemetry.incident &&
				state.reuse.sequence === 0 &&
				state.telemetry.sequence === 0
			) {
				deleted += await this.runWithChanges(
					"DELETE FROM cache_health_state WHERE scope_key = ? AND revision = ? AND last_bucket_end = ? AND active = 0",
					[row.scope_key, state.revision, state.lastBucketEnd],
				);
				continue;
			}
			state.healthyEnds = [];
			state.reportingEnd = null;
			state.reuse.bad =
				state.reuse.recovery =
				state.telemetry.bad =
				state.telemetry.recovery =
					null;
			// Keep provider contributors for the service's generation cleanup.
			// Cleanup is not a bucket transition; preserve revision and watermark,
			// and never overwrite evidence committed after the snapshot was read.
			const snapshot = JSON.stringify(state);
			if (snapshot !== row.snapshot)
				await this.runWithChanges(
					"UPDATE cache_health_state SET snapshot = ? WHERE scope_key = ? AND revision = ? AND last_bucket_end = ?",
					[snapshot, row.scope_key, state.revision, state.lastBucketEnd],
				);
		}
		return deleted;
	}

	/** Returns true only to the insert winner; publish those already-persisted alerts. */
	async commit(
		expectedRevision: number,
		state: CacheHealthState,
		alerts: readonly AlertEvent[],
	): Promise<boolean> {
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			state.revision !== expectedRevision + 1 ||
			!Number.isSafeInteger(state.lastBucketEnd) ||
			state.lastBucketEnd <= 0 ||
			state.healthyEnds.length > 2
		)
			throw new Error("Invalid cache health transition");
		const snapshot = JSON.stringify(state);
		if (snapshot.length > 65_536)
			throw new Error("Cache health snapshot too large");
		const contributors = [...state.contributors];
		if (state.scope.kind === "account") {
			if (
				state.scope.accountId === null ||
				state.scope.accountGeneration === null
			)
				throw new Error("Missing account generation");
			contributors.push({
				accountId: state.scope.accountId,
				accountGeneration: state.scope.accountGeneration,
			});
		}
		const unique = [
			...new Map(
				contributors.map((c) => [
					JSON.stringify([c.accountId, c.accountGeneration]),
					c,
				]),
			).values(),
		].sort((a, b) => a.accountId.localeCompare(b.accountId));
		if (!unique.length)
			throw new Error("Missing cache health generation fence");
		const key = cacheHealthScopeKey(state.scope);
		const active = state.reuse.incident || state.telemetry.incident ? 1 : 0;
		try {
			await this.adapter.runBatchWithChanges([
				// Lock account generations until this batch commits on PG as well as
				// SQLite. A separate preflight SELECT would race deletion/recreation.
				// Stable ordering avoids deadlocks across provider/account evaluations.
				...unique.map((c) => ({
					sql: "UPDATE accounts SET created_at = created_at WHERE id = ? AND created_at = ?",
					params: [c.accountId, c.accountGeneration],
					expectedChanges: 1,
				})),
				expectedRevision === 0
					? {
							sql: `INSERT INTO cache_health_state (scope_key, account_id, account_generation, revision, last_bucket_end, active, snapshot)
					VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope_key) DO NOTHING`,
							params: [
								key,
								state.scope.accountId,
								state.scope.accountGeneration,
								state.revision,
								state.lastBucketEnd,
								active,
								snapshot,
							],
							expectedChanges: 1,
						}
					: {
							sql: `UPDATE cache_health_state SET revision = ?, last_bucket_end = ?, active = ?, snapshot = ?
					WHERE scope_key = ? AND revision = ? AND last_bucket_end < ?`,
							params: [
								state.revision,
								state.lastBucketEnd,
								active,
								snapshot,
								key,
								expectedRevision,
								state.lastBucketEnd,
							],
							expectedChanges: 1,
						},
				...alerts.map((alert) => ({
					sql: `INSERT INTO alerts (id, timestamp, type, severity, title, message, value, threshold, account, model, project, request_id, acknowledged)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
					params: [
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
					expectedChanges: 1,
				})),
			]);
			return true;
		} catch (error) {
			if (error instanceof BatchExpectedChangesError) return false;
			throw error;
		}
	}
}
