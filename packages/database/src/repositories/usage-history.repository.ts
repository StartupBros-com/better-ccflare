import { weeklyScopedWindowKey } from "@better-ccflare/core";
import type { PredictionPoint, UsageSnapshotRow } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

/** Duck-typed usage window: an object with a numeric `utilization` and a `resets_at` key. */
function isWindow(
	value: unknown,
): value is { utilization: number; resets_at: string | null } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { utilization?: unknown }).utilization === "number" &&
		"resets_at" in (value as object)
	);
}

/** Duck-typed entry of Anthropic's generic `limits[]` array (session/weekly_all/weekly_scoped). */
function isLimitEntry(value: unknown): value is {
	kind?: string;
	percent?: number | null;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string } | null } | null;
} {
	return typeof value === "object" && value !== null && "kind" in value;
}

/**
 * Maps a `limits[]` entry to the internal window_key used everywhere else
 * (dashboard rows, throttle snapshots): session -> five_hour, weekly_all ->
 * seven_day, weekly_scoped -> seven_day_<slug> via weeklyScopedWindowKey.
 * Returns null for limit kinds we don't track as a history window.
 */
function limitWindowKey(limit: {
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

interface SnapshotDbRow {
	account_id: string;
	timestamp: number;
	window_key: string;
	utilization: number;
	resets_at: number | null;
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

export class UsageHistoryRepository extends BaseRepository<UsageSnapshotRow> {
	/**
	 * Insert one row per usage window present in `usage`. One row per successful
	 * poll (NO dedup) — the prediction fit and the chart both need a faithful,
	 * near-uniform series; collapsing flat stretches to a single row makes idle
	 * windows fall out of range queries and biases the regression. Volume is
	 * bounded by retention pruning instead. `usage` is the raw UsageData-shaped
	 * record from the provider cache; non-window fields (extra_usage, unknown
	 * keys) are ignored. A malformed `resets_at` is stored as null, never NaN.
	 *
	 * Anthropic's `limits[]` array (session/weekly_all/weekly_scoped) is folded
	 * in under the same window_key convention as the flat windows (five_hour,
	 * seven_day, seven_day_<slug>) so a limits-only payload — e.g. a per-model
	 * Fable cap with five_hour/seven_day both null — still gets recorded.
	 */
	async recordSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		// Build one value tuple per window, then insert them all in a SINGLE
		// statement. A multi-row INSERT is atomic (all-or-nothing) on both SQLite
		// and Postgres, so a failure can no longer leave a partial snapshot the
		// way the previous await-in-loop of per-window inserts could.
		const params: unknown[] = [];
		const seenKeys = new Set<string>();
		let count = 0;
		for (const [windowKey, value] of Object.entries(usage)) {
			if (!isWindow(value)) continue;
			let resetsAt: number | null = null;
			if (value.resets_at) {
				const ms = new Date(value.resets_at).getTime();
				resetsAt = Number.isFinite(ms) ? ms : null;
			}
			params.push(accountId, now, windowKey, value.utilization, resetsAt);
			seenKeys.add(windowKey);
			count++;
		}
		const limits = usage.limits;
		if (Array.isArray(limits)) {
			for (const limit of limits) {
				if (!isLimitEntry(limit) || typeof limit.percent !== "number") continue;
				const windowKey = limitWindowKey(limit);
				// Skip a kind we don't map, and skip one already recorded from the
				// flat windows above (no double-count of five_hour/seven_day).
				if (!windowKey || seenKeys.has(windowKey)) continue;
				let resetsAt: number | null = null;
				if (limit.resets_at) {
					const ms = new Date(limit.resets_at).getTime();
					resetsAt = Number.isFinite(ms) ? ms : null;
				}
				params.push(accountId, now, windowKey, limit.percent, resetsAt);
				seenKeys.add(windowKey);
				count++;
			}
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
