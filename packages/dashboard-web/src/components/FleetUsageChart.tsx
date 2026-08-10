import type { FleetAccountUsageSeries } from "@better-ccflare/types";
import { useMemo } from "react";
import { CHART_COLORS } from "../constants";
import {
	formatWindowName,
	isWeeklyWindow,
} from "./accounts/rate-limit-helpers";
import { BaseLineChart } from "./charts/BaseLineChart";

export interface FleetChartRow {
	t: number;
	[seriesKey: string]: number | string | null;
}

export interface FleetLineConfig {
	dataKey: string;
	name: string;
	color: string;
	dashed: boolean;
}

/** Composite recharts dataKey for one account's window series. */
function fleetSeriesKey(accountId: string, window: string): string {
	return `${accountId}::${window}`;
}

/**
 * Flatten per-account × per-window series into a single time-indexed recharts
 * dataset (one row per distinct timestamp across every series, missing values
 * `null`) plus one line config per account × window. Colors cycle through
 * CHART_COLORS by account index (same palette/fallback MultiModelChart uses);
 * line style differentiates a window family within an account — five_hour
 * solid, seven_day/seven_day_* (weekly) dashed — via `isWeeklyWindow`, the
 * same helper RateLimitProgress uses to group windows.
 */
export function buildFleetChartData(accounts: FleetAccountUsageSeries[]): {
	rows: FleetChartRow[];
	lines: FleetLineConfig[];
} {
	const byTime = new Map<number, FleetChartRow>();
	const ensureRow = (t: number): FleetChartRow => {
		let row = byTime.get(t);
		if (!row) {
			row = { t };
			byTime.set(t, row);
		}
		return row;
	};

	const lines: FleetLineConfig[] = [];
	accounts.forEach((account, accountIndex) => {
		const color = CHART_COLORS[accountIndex % CHART_COLORS.length];
		for (const w of account.windows) {
			const dataKey = fleetSeriesKey(account.accountId, w.window);
			// Bucket timestamps to a shared minute grid: accounts poll on
			// independent, unaligned cycles, so exact-ms keys would give every
			// account its own disjoint row set and the merged rows would grow
			// toward accounts x windows x 500 — defeating the server's
			// per-series cap (review finding). Same-bucket points overwrite
			// (latest wins), which is fine for a trend line.
			for (const p of w.points) {
				const bucketT = Math.round(p.t / 60_000) * 60_000;
				ensureRow(bucketT)[dataKey] = p.utilization;
			}
			lines.push({
				dataKey,
				name: `${account.accountName} · ${formatWindowName(w.window)}`,
				color,
				dashed: isWeeklyWindow(w.window),
			});
		}
	});

	const allKeys = lines.map((l) => l.dataKey);
	let rows = [...byTime.values()].sort((a, b) => a.t - b.t);
	// Hard cap on merged rows (belt over the minute bucketing, e.g. 30d
	// ranges): evenly sample, always keeping the first and last row so the
	// chart's time domain stays exact — mirrors the server's downsampling.
	const MAX_MERGED_ROWS = 1500;
	if (rows.length > MAX_MERGED_ROWS) {
		const step = (rows.length - 1) / (MAX_MERGED_ROWS - 1);
		const sampled: FleetChartRow[] = [];
		let lastIdx = -1;
		for (let i = 0; i < MAX_MERGED_ROWS; i++) {
			const idx = Math.round(i * step);
			if (idx === lastIdx) continue;
			sampled.push(rows[idx]);
			lastIdx = idx;
		}
		if (sampled[sampled.length - 1] !== rows[rows.length - 1]) {
			sampled.push(rows[rows.length - 1]);
		}
		rows = sampled;
	}
	for (const row of rows) {
		for (const key of allKeys) if (!(key in row)) row[key] = null;
	}

	return { rows, lines };
}

interface Props {
	accounts: FleetAccountUsageSeries[];
	loading?: boolean;
	height?: number;
	emptyState?: string;
}

/** Fleet-wide usage trend chart: one line per account × window, all on one chart. */
export function FleetUsageChart({
	accounts,
	loading,
	height = 400,
	emptyState = "Collecting usage data…",
}: Props) {
	const { rows, lines, xDomain, yMax } = useMemo(() => {
		const { rows, lines } = buildFleetChartData(accounts);

		// Explicit loops rather than spreading into Math.min/Math.max — a
		// long-lived instance across many accounts can accumulate thousands of
		// points, and spreading that many arguments throws (see
		// UsageHistoryChart, which hit the same RangeError).
		let xMin = Number.POSITIVE_INFINITY;
		let xMax = Number.NEGATIVE_INFINITY;
		for (const r of rows) {
			if (r.t < xMin) xMin = r.t;
			if (r.t > xMax) xMax = r.t;
		}
		const hasX = Number.isFinite(xMin) && Number.isFinite(xMax);
		const xDomain: [number, number] = hasX ? [xMin, xMax] : [0, 1];

		let yMax = 100;
		for (const row of rows) {
			for (const line of lines) {
				const v = row[line.dataKey];
				if (typeof v === "number" && v > yMax) yMax = v;
			}
		}

		return { rows, lines, xDomain, yMax };
	}, [accounts]);

	const lineConfigs = lines.map((line) => ({
		dataKey: line.dataKey,
		stroke: line.color,
		name: line.name,
		strokeDasharray: line.dashed ? "5 3" : undefined,
		connectNulls: true,
	}));

	return (
		<BaseLineChart
			data={rows}
			xAxisKey="t"
			xAxisType="number"
			xAxisDomain={xDomain}
			lines={lineConfigs}
			loading={loading}
			height={height}
			showLegend
			yAxisDomain={[0, yMax]}
			emptyState={emptyState}
			xAxisTickFormatter={(v) => new Date(Number(v)).toLocaleString()}
			tooltipLabelFormatter={(label) =>
				new Date(Number(label)).toLocaleString()
			}
			tooltipFormatter={(value, name) => [
				`${Math.round(Number(value))}%`,
				String(name),
			]}
		/>
	);
}
