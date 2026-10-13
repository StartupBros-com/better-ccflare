import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import { createTtlCache } from "../utils/ttl-cache";

async function loadStats(
	dbOps: DatabaseOperations,
	sinceDays: number,
	errorsHours: number,
) {
	const statsRepository = dbOps.getStatsRepository();
	const now = Date.now();
	const sinceMs = now - sinceDays * 24 * 60 * 60 * 1000;
	const errorsSinceMs = now - errorsHours * 60 * 60 * 1000;
	const [stats, activeAccounts, accountsWithStats, recentErrors, topModels] =
		await Promise.all([
			statsRepository.getAggregatedStats(sinceMs),
			statsRepository.getActiveAccountCount(),
			// Account and model counts intentionally retain their lifetime scope.
			statsRepository.getAccountStats(10, true),
			statsRepository.getRecentErrorGroups(errorsSinceMs, 50),
			statsRepository.getTopModels(),
		]);
	return {
		totalRequests: stats.totalRequests,
		successRate:
			stats.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0,
		activeAccounts,
		avgResponseTime: Math.round(stats.avgResponseTime || 0),
		totalTokens: stats.totalTokens,
		totalCostUsd: stats.totalCostUsd,
		topModels,
		avgTokensPerSecond: stats.avgTokensPerSecond,
		accounts: accountsWithStats,
		recentErrors,
	};
}

type Stats = Awaited<ReturnType<typeof loadStats>>;
const caches = new WeakMap<
	DatabaseOperations,
	ReturnType<typeof createTtlCache<Stats>>
>();

/** One cache/subscription per database, regardless of how many routers use it. */
function getCache(dbOps: DatabaseOperations) {
	let cache = caches.get(dbOps);
	if (!cache) {
		cache = createTtlCache<Stats>(10_000);
		dbOps.onRequestsDeleted(cache.clear);
		caches.set(dbOps, cache);
	}
	return cache;
}

/** Create a stats handler. */
export function createStatsHandler(dbOps: DatabaseOperations) {
	return async (url: URL): Promise<Response> => {
		// Parse optional ?since=<days> query parameter (default: 30, max: 365).
		const sinceRaw = Number(url.searchParams.get("since") ?? 30);
		const sinceDays =
			Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 365) : 30;
		// Error window defaults to 24 hours, capped at 365 days.
		const errorsHoursRaw = Number(
			url.searchParams.get("errorsSinceHours") ?? 24,
		);
		const errorsHours =
			Number.isFinite(errorsHoursRaw) && errorsHoursRaw > 0
				? Math.min(errorsHoursRaw, 8760)
				: 24;
		const stats = await getCache(dbOps).get(`${sinceDays}:${errorsHours}`, () =>
			loadStats(dbOps, sinceDays, errorsHours),
		);
		return jsonResponse(stats);
	};
}

/** Create a stats reset handler. */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		await dbOps.resetStatistics();
		return jsonResponse({
			success: true,
			message: "Statistics reset successfully",
		});
	};
}
