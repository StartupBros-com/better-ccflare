// packages/http-api/src/handlers/usage-history.ts
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type {
	FleetAccountUsageSeries,
	FleetUsageHistoryResponse,
	FleetWindowSeries,
	PredictionPoint,
	UsageHistoryResponse,
	UsageHistoryWindowSeries,
} from "@better-ccflare/types";
import { computeUsagePrediction } from "../services/usage-prediction";
import type { APIContext } from "../types";
import { getRangeConfig } from "../utils/query-filters";

const log = new Logger("UsageHistoryHandler");

// Fleet mode (account=all/omitted) can fan out across many accounts × windows;
// cap each series so the payload/chart stay bounded regardless of retention.
// Always keeps the first and last point so the chart's time domain is exact.
const MAX_FLEET_POINTS_PER_SERIES = 500;

export function downsamplePoints(
	points: PredictionPoint[],
	max = MAX_FLEET_POINTS_PER_SERIES,
): PredictionPoint[] {
	if (points.length <= max || max < 2) return points;
	const result: PredictionPoint[] = [];
	const step = (points.length - 1) / (max - 1);
	let lastIndex = -1;
	for (let i = 0; i < max; i++) {
		const idx = Math.round(i * step);
		if (idx === lastIndex) continue; // rounding can collide near the ends
		result.push(points[idx]);
		lastIndex = idx;
	}
	const lastPoint = points[points.length - 1];
	if (result[result.length - 1] !== lastPoint) result.push(lastPoint);
	return result;
}

function groupRowsByWindow<T extends { windowKey: string }>(
	rows: T[],
): Map<string, T[]> {
	const byWindow = new Map<string, T[]>();
	for (const r of rows) {
		const arr = byWindow.get(r.windowKey) ?? [];
		arr.push(r);
		byWindow.set(r.windowKey, arr);
	}
	return byWindow;
}

function rowsToPoints(
	rows: { timestamp: number; utilization: number; resetsAt: number | null }[],
): PredictionPoint[] {
	return rows.map((r) => ({
		t: r.timestamp,
		utilization: r.utilization,
		resetsAt: r.resetsAt,
	}));
}

export function createUsageHistoryHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const accountId = searchParams.get("account");
		// getRangeConfig returns the normalized effective `range` (unknown values
		// fall back to 24h) — echo that in the response so it matches startMs.
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const windowKey = searchParams.get("window") ?? undefined;

		try {
			// account=all (or the param omitted entirely) requests the fleet-wide
			// view: one series per account × window, for every account that has
			// at least one snapshot in range.
			if (!accountId || accountId === "all") {
				return jsonResponse(
					await buildFleetResponse(context, { range, startMs, windowKey }),
				);
			}

			const rows = await context.dbOps.getUsageHistory({
				accountId,
				windowKey,
				since: startMs,
			});

			const windows: UsageHistoryWindowSeries[] = [
				...groupRowsByWindow(rows).entries(),
			]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([window, windowRows]) => {
					const points = rowsToPoints(windowRows);
					return {
						window,
						points,
						prediction: computeUsagePrediction(points),
					};
				});

			const response: UsageHistoryResponse = { accountId, range, windows };
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch usage history"),
			);
		}
	};
}

async function buildFleetResponse(
	context: APIContext,
	opts: { range: string; startMs: number; windowKey?: string },
): Promise<FleetUsageHistoryResponse> {
	const accounts = await context.dbOps.getAllAccounts();
	const results: FleetAccountUsageSeries[] = [];

	for (const account of accounts) {
		let rows: Awaited<ReturnType<typeof context.dbOps.getUsageHistory>>;
		try {
			rows = await context.dbOps.getUsageHistory({
				accountId: account.id,
				windowKey: opts.windowKey,
				since: opts.startMs,
			});
		} catch (error) {
			// One account's transient failure must not 500 the whole fleet
			// response — that would also let layered client retries replay the
			// entire sequential fan-out. Log, skip, serve a partial fleet.
			log.warn(
				`Fleet usage history: query failed for account ${account.name}, skipping: ${error}`,
			);
			continue;
		}
		if (rows.length === 0) continue; // no snapshots in range — skip entirely

		const windows: FleetWindowSeries[] = [...groupRowsByWindow(rows).entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([window, windowRows]) => ({
				window,
				points: downsamplePoints(rowsToPoints(windowRows)),
			}));

		results.push({
			accountId: account.id,
			accountName: account.name,
			windows,
		});
	}

	return { range: opts.range, accounts: results };
}
