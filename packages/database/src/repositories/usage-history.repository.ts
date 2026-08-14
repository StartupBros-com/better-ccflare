import type {
	CanonicalUsageWindow,
	PredictionPoint,
	UsageSnapshotRow,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

interface SnapshotDbRow {
	account_id: string;
	timestamp: number;
	window_key: string;
	utilization: number;
	resets_at: number | null;
}

interface FleetSnapshotDbRow extends SnapshotDbRow {
	total_series_count: number;
	total_account_count: number;
	selected_series_count: number;
	selected_account_count: number;
}

export interface GetSeriesOptions {
	accountId: string;
	windowKey?: string;
	since?: number;
	until?: number;
	/**
	 * When set, aggregate rows into fixed time buckets IN SQL (bucket-start
	 * timestamp, mean utilization, max resets_at per window_key+bucket)
	 * instead of returning every raw row. Bounds database work, memory, and
	 * payload for wide ranges — a 30d fleet read at a 10s poll interval
	 * would otherwise materialize hundreds of thousands of rows per window
	 * before any JS-side downsampling (pro-gate finding). Bucket-start
	 * timestamps are grid-aligned, so series from different accounts share
	 * row keys when merged.
	 */
	bucketMs?: number;
}

export interface GetFleetSeriesOptions {
	/** Every account to read in one pass. An empty list short-circuits. */
	accountIds: string[];
	windowKey?: string;
	since?: number;
	until?: number;
	bucketMs?: number;
	/**
	 * Hard ceiling on total points returned across ALL series. Whole series are
	 * dropped (never silently thinned) once it is reached, and what was dropped
	 * is reported rather than passed off as an empty fleet.
	 */
	pointBudget?: number;
}

export interface FleetSeriesResult {
	rows: UsageSnapshotRow[];
	/** True when the point budget excluded at least one series. */
	truncated: boolean;
	/** Accounts that had data in range but ended up with no series returned. */
	omittedAccountCount: number;
	omittedSeriesCount: number;
	returnedPointCount: number;
}

/**
 * Default ceiling on points in one fleet read. Sized well above a normal fleet
 * (accounts x windows x ~500 bucketed points) so it only engages on genuinely
 * pathological reads, but low enough that one request cannot materialize an
 * unbounded result set.
 */
export const DEFAULT_FLEET_POINT_BUDGET = 20_000;

export class UsageHistoryRepository extends BaseRepository<UsageSnapshotRow> {
	/**
	 * Insert one row per usage window present in `usage`. One row per successful
	 * poll (NO dedup) — the prediction fit and the chart both need a faithful,
	 * near-uniform series; collapsing flat stretches to a single row makes idle
	 * windows fall out of range queries and biases the regression. Volume is
	 * bounded by retention pruning instead.
	 *
	 * `windows` is already canonical: every provider shape — Anthropic's flat
	 * windows, its `limits[]` array, NanoGPT's 0-1 fractions, Kilo's resetless
	 * credits — has been resolved by `normalizeProviderUsageWindows` before it
	 * reaches here, including scaling, reset parsing and duplicate-key
	 * suppression. This repository stays provider-agnostic on purpose: adding a
	 * provider must never mean editing persistence.
	 */
	async recordSnapshot(
		accountId: string,
		windows: CanonicalUsageWindow[],
		now: number,
	): Promise<void> {
		// Build one value tuple per window, then insert them all in a SINGLE
		// statement. A multi-row INSERT is atomic (all-or-nothing) on both SQLite
		// and Postgres, so a failure can no longer leave a partial snapshot the
		// way the previous await-in-loop of per-window inserts could.
		const params: unknown[] = [];
		const count = windows.length;
		for (const window of windows) {
			params.push(
				accountId,
				now,
				window.windowKey,
				window.utilization,
				window.resetsAtMs,
			);
		}
		if (count === 0) return;
		const rows = Array.from({ length: count }, () => "(?, ?, ?, ?, ?)").join(
			", ",
		);
		await this.run(
			`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
			 VALUES ${rows}`,
			params,
		);
	}

	async getSeries(opts: GetSeriesOptions): Promise<UsageSnapshotRow[]> {
		const clauses = ["account_id = ?"];
		const whereParams: unknown[] = [opts.accountId];
		if (opts.windowKey) {
			clauses.push("window_key = ?");
			whereParams.push(opts.windowKey);
		}
		if (opts.since != null) {
			clauses.push("timestamp >= ?");
			whereParams.push(opts.since);
		}
		if (opts.until != null) {
			clauses.push("timestamp <= ?");
			whereParams.push(opts.until);
		}
		const bucketMs =
			opts.bucketMs != null && opts.bucketMs > 0
				? Math.round(opts.bucketMs)
				: null;
		// Integer division truncates identically on SQLite and Postgres, so
		// the bucketed variant runs unchanged on both adapters.
		// The bucket expression is computed ONCE in a subquery and grouped by
		// its alias: repeating `timestamp / ?` in SELECT and GROUP BY binds
		// DISTINCT parameters after placeholder conversion ($1 vs $n), and
		// PostgreSQL does not recognize those as the same grouping expression
		// — every bucketed query would raise an ungrouped-column error
		// (pro-gate finding).
		const rows = bucketMs
			? await this.query<SnapshotDbRow>(
					`SELECT account_id, bucket * ? AS timestamp, window_key,
					        AVG(utilization) AS utilization, MAX(resets_at) AS resets_at
					 FROM (
					   SELECT account_id, timestamp / ? AS bucket, window_key, utilization, resets_at
					   FROM usage_snapshots
					   WHERE ${clauses.join(" AND ")}
					 ) bucketed
					 GROUP BY account_id, window_key, bucket
					 ORDER BY timestamp ASC`,
					[bucketMs, bucketMs, ...whereParams],
				)
			: await this.query<SnapshotDbRow>(
					`SELECT account_id, timestamp, window_key, utilization, resets_at
					 FROM usage_snapshots
					 WHERE ${clauses.join(" AND ")}
					 ORDER BY timestamp ASC`,
					whereParams,
				);
		return rows.map((r) => ({
			accountId: r.account_id,
			timestamp: Number(r.timestamp),
			windowKey: r.window_key,
			utilization: Number(r.utilization),
			resetsAt: r.resets_at == null ? null : Number(r.resets_at),
		}));
	}

	/**
	 * Read every requested account's history in ONE set-based query.
	 *
	 * The fleet view previously issued one query per account and awaited each in
	 * turn, so a 60s dashboard refresh cost O(accounts) sequential round trips
	 * and grew with the fleet. Filtering and bucketing all accounts together
	 * bounds the database work before any row leaves the DB (#137).
	 *
	 * Whatever the budget excludes is REPORTED, never silently dropped: a
	 * budgeted response and a genuinely empty fleet must not look alike to the
	 * dashboard.
	 */
	async getFleetUsageHistory(
		opts: GetFleetSeriesOptions,
	): Promise<FleetSeriesResult> {
		const accountIds = [...new Set(opts.accountIds)];
		if (accountIds.length === 0) {
			// `IN ()` is a syntax error on both dialects, and there is nothing to
			// ask for anyway.
			return {
				rows: [],
				truncated: false,
				omittedAccountCount: 0,
				omittedSeriesCount: 0,
				returnedPointCount: 0,
			};
		}

		const bucketMs =
			opts.bucketMs != null && opts.bucketMs > 0
				? Math.round(opts.bucketMs)
				: null;
		const budget =
			opts.pointBudget != null && opts.pointBudget > 0
				? Number.isFinite(opts.pointBudget)
					? Math.floor(opts.pointBudget)
					: Number.MAX_SAFE_INTEGER
				: DEFAULT_FLEET_POINT_BUDGET;
		const requestedWindow = opts.windowKey || null;
		const accountIdsJson = JSON.stringify(accountIds);
		const params: unknown[] = [accountIdsJson];
		let nextParamIndex = 2;
		const bindParam = (value: unknown): string => {
			params.push(value);
			return `?${nextParamIndex++}`;
		};
		const requestedAccountsSql = this.adapter.isSQLite
			? "SELECT DISTINCT CAST(value AS TEXT) AS account_id FROM json_each(?1)"
			: "SELECT DISTINCT account_id FROM jsonb_array_elements_text(CAST(?1 AS jsonb)) AS requested(account_id)";
		// Pin text ordering to raw UTF-8 bytes. SQLite's default BINARY collation
		// happens to provide that today, but PostgreSQL inherits the database's
		// locale unless `C` is explicit; equal-recency series could therefore
		// select different strict prefixes on the two adapters.
		const bytewiseCollationSql = this.adapter.isSQLite
			? "COLLATE BINARY"
			: 'COLLATE "C"';
		const filterClauses: string[] = [];
		const requestedWindowPlaceholder = requestedWindow
			? bindParam(requestedWindow)
			: null;
		if (requestedWindowPlaceholder) {
			filterClauses.push(
				`snapshots.window_key = CAST(${requestedWindowPlaceholder} AS TEXT)`,
			);
		}
		if (opts.since != null) {
			const sincePlaceholder = bindParam(opts.since);
			filterClauses.push(
				`snapshots.timestamp >= CAST(${sincePlaceholder} AS BIGINT)`,
			);
		}
		if (opts.until != null) {
			const untilPlaceholder = bindParam(opts.until);
			filterClauses.push(
				`snapshots.timestamp <= CAST(${untilPlaceholder} AS BIGINT)`,
			);
		}
		const filteredWhere =
			filterClauses.length > 0
				? `WHERE ${filterClauses.join("\n\t\t\t\tAND ")}`
				: "";
		const bucketPlaceholder = bucketMs ? bindParam(bucketMs) : null;
		const bucketExpression = bucketPlaceholder
			? `snapshots.timestamp / CAST(${bucketPlaceholder} AS BIGINT)`
			: null;
		const seriesPointStats = bucketExpression
			? `COUNT(DISTINCT ${bucketExpression}) AS point_count, MAX(${bucketExpression}) AS last_ts`
			: "COUNT(*) AS point_count, MAX(snapshots.timestamp) AS last_ts";
		const budgetPlaceholder = bindParam(budget);
		const requestedWindowOrderSql = requestedWindowPlaceholder
			? `CASE WHEN window_key = CAST(${requestedWindowPlaceholder} AS TEXT) THEN 0 ELSE 1 END ASC,`
			: "";
		const commonCtes = `WITH requested_accounts(account_id) AS (
				${requestedAccountsSql}
			),
			series_stats AS (
				SELECT snapshots.account_id, snapshots.window_key,
				       ${seriesPointStats}
				FROM usage_snapshots snapshots
				JOIN requested_accounts requested
				  ON requested.account_id = snapshots.account_id
				${filteredWhere}
				GROUP BY snapshots.account_id, snapshots.window_key
			),
			ordered_series AS (
				SELECT account_id, window_key, point_count, last_ts,
				       ROW_NUMBER() OVER (
				         ORDER BY ${requestedWindowOrderSql}
				                  last_ts DESC,
				                  account_id ${bytewiseCollationSql} ASC,
				                  window_key ${bytewiseCollationSql} ASC
				       ) AS series_rank
				FROM series_stats
			),
			running_series AS (
				SELECT account_id, window_key, point_count, series_rank,
				       SUM(point_count) OVER (
				         ORDER BY series_rank
				         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
				       ) AS cumulative_points
				FROM ordered_series
			),
			selected_series AS (
				SELECT account_id, window_key
				FROM running_series
				WHERE series_rank = 1
				   OR cumulative_points <= CAST(${budgetPlaceholder} AS BIGINT)
			),
			fleet_summary AS (
				SELECT
				  (SELECT COUNT(*) FROM series_stats) AS total_series_count,
				  (SELECT COUNT(DISTINCT account_id) FROM series_stats) AS total_account_count,
				  (SELECT COUNT(*) FROM selected_series) AS selected_series_count,
				  (SELECT COUNT(DISTINCT account_id) FROM selected_series) AS selected_account_count
			)`;

		// Selection happens before the final row-producing SELECT. The adapter
		// therefore receives only the strict prefix admitted by the fleet point
		// budget instead of materializing every candidate series and discarding
		// the tail in JavaScript. A JSON array keeps the bind count constant as
		// the requested fleet grows; positional placeholders safely reuse the
		// same values in every CTE on both adapters.
		const fleetSql = bucketMs
			? `${commonCtes},
				selected_bucket_rows AS (
					SELECT snapshots.account_id,
					       ${bucketExpression} AS bucket,
					       snapshots.window_key,
					       snapshots.utilization,
					       snapshots.resets_at
					FROM usage_snapshots snapshots
					JOIN selected_series selected
					  ON selected.account_id = snapshots.account_id
					 AND selected.window_key = snapshots.window_key
					${filteredWhere}
				)
				SELECT bucketed.account_id,
				       bucketed.bucket * CAST(${bucketPlaceholder} AS BIGINT) AS timestamp,
				       bucketed.window_key,
				       AVG(bucketed.utilization) AS utilization,
				       MAX(bucketed.resets_at) AS resets_at,
				       summary.total_series_count,
				       summary.total_account_count,
				       summary.selected_series_count,
				       summary.selected_account_count
				FROM selected_bucket_rows bucketed
				CROSS JOIN fleet_summary summary
				GROUP BY bucketed.account_id, bucketed.window_key, bucketed.bucket,
				         summary.total_series_count, summary.total_account_count,
				         summary.selected_series_count, summary.selected_account_count
				ORDER BY bucketed.account_id ${bytewiseCollationSql} ASC,
				         bucketed.window_key ${bytewiseCollationSql} ASC,
				         timestamp ASC`
			: `${commonCtes}
				SELECT snapshots.account_id,
				       snapshots.timestamp,
				       snapshots.window_key,
				       snapshots.utilization,
				       snapshots.resets_at,
				       summary.total_series_count,
				       summary.total_account_count,
				       summary.selected_series_count,
				       summary.selected_account_count
				FROM usage_snapshots snapshots
				JOIN selected_series selected
				  ON selected.account_id = snapshots.account_id
				 AND selected.window_key = snapshots.window_key
				CROSS JOIN fleet_summary summary
				${filteredWhere}
				ORDER BY snapshots.account_id ${bytewiseCollationSql} ASC,
				         snapshots.window_key ${bytewiseCollationSql} ASC,
				         snapshots.timestamp ASC`;
		const dbRows = await this.query<FleetSnapshotDbRow>(fleetSql, params);
		const rows = dbRows.map((r) => ({
			accountId: r.account_id,
			timestamp: Number(r.timestamp),
			windowKey: r.window_key,
			utilization: Number(r.utilization),
			resetsAt: r.resets_at == null ? null : Number(r.resets_at),
		}));
		const summary = dbRows[0];
		const totalSeriesCount = Number(summary?.total_series_count ?? 0);
		const selectedSeriesCount = Number(summary?.selected_series_count ?? 0);
		const totalAccountCount = Number(summary?.total_account_count ?? 0);
		const selectedAccountCount = Number(summary?.selected_account_count ?? 0);

		return {
			rows,
			truncated: selectedSeriesCount < totalSeriesCount,
			omittedAccountCount: totalAccountCount - selectedAccountCount,
			omittedSeriesCount: totalSeriesCount - selectedSeriesCount,
			returnedPointCount: rows.length,
		};
	}

	async deleteOlderThan(cutoffTs: number): Promise<number> {
		// Batched like RequestRepository.deleteOlderThan/deletePayloadsOlderThan —
		// an unbounded DELETE here can exceed the PG statement_timeout once the
		// table is large, which previously caused retention cleanup to fail
		// forever and let usage_snapshots grow unbounded (#384).
		//
		// usage_snapshots has no surrogate key column (append-only time series —
		// see the CREATE TABLE comment in migrations.ts), and its natural key
		// (account_id, timestamp, window_key) isn't declared unique. Selecting
		// on the natural key with LIMIT only bounds the number of *distinct
		// keys*, not physical rows: if duplicate keys exist, the outer DELETE
		// removes every row matching each selected key, so a nominal 2000-row
		// batch could still expand into an unbounded single-statement DELETE —
		// exactly the PG statement_timeout failure this batching exists to
		// avoid. Use each row's physical identity instead — SQLite's implicit
		// `rowid` and PostgreSQL's system `ctid` column — so LIMIT always caps
		// physical rows deleted per statement, independent of key duplicates.
		// idx_usage_snapshots_ts (on timestamp alone) makes the inner SELECT
		// efficient on both dialects.
		const BATCH_SIZE = 2000;
		const physicalIdSql = this.adapter.isSQLite
			? `DELETE FROM usage_snapshots WHERE rowid IN (
					SELECT rowid FROM usage_snapshots WHERE timestamp < ? LIMIT ?
				)`
			: `DELETE FROM usage_snapshots WHERE ctid IN (
					SELECT ctid FROM usage_snapshots WHERE timestamp < ? LIMIT ?
				)`;
		let total = 0;
		let deleted: number;
		do {
			deleted = await this.runWithChanges(physicalIdSql, [
				cutoffTs,
				BATCH_SIZE,
			]);
			total += deleted;
		} while (deleted === BATCH_SIZE);
		return total;
	}
}

/** Convenience: map snapshot rows to prediction/chart points. */
export function toPredictionPoints(
	rows: UsageSnapshotRow[],
): PredictionPoint[] {
	return rows.map((r) => ({
		t: r.timestamp,
		utilization: r.utilization,
		resetsAt: r.resetsAt,
	}));
}
