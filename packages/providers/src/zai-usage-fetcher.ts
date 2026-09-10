import { Logger } from "@better-ccflare/logger";

const log = new Logger("ZaiUsageFetcher");

export interface ZaiUsageWindow {
	used: number;
	remaining: number;
	percentage: number; // 0-100 from API
	resetAt: number | null; // Unix timestamp in milliseconds
	type: string;
}

export interface ZaiUsageData {
	time_limit: ZaiUsageWindow | null;
	/** Short token window (5-hour on current plans) — the nearest reset. */
	tokens_limit: ZaiUsageWindow | null;
	/** Long token window (weekly on current plans), null on single-window plans. */
	tokens_limit_weekly?: ZaiUsageWindow | null;
}

/**
 * Fetch usage data from Zai's monitoring usage endpoint
 * This is non-blocking - failures return null and won't affect provider operation
 */
export async function fetchZaiUsageData(
	apiKey: string,
): Promise<ZaiUsageData | null> {
	try {
		const response = await fetch(
			"https://api.z.ai/api/monitor/usage/quota/limit",
			{
				method: "GET",
				headers: {
					"x-api-key": apiKey,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const json = await response.json();

		// Validate response structure
		if (!json.success || !json.data || !Array.isArray(json.data.limits)) {
			log.warn("Invalid Zai usage response structure");
			return null;
		}

		const limits = json.data.limits;
		const result: ZaiUsageData = {
			time_limit: null,
			tokens_limit: null,
			tokens_limit_weekly: null,
		};
		const tokenWindows: ZaiUsageWindow[] = [];

		// Parse each limit type
		for (const limit of limits) {
			if (limit.type === "TIME_LIMIT") {
				result.time_limit = {
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "time_limit",
				};
			} else if (limit.type === "TOKENS_LIMIT") {
				tokenWindows.push({
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "tokens_limit",
				});
			}
		}

		// Zai sends multiple identically-typed token limits. Reset order is the
		// stable discriminator: nearest is the short window, later is weekly.
		tokenWindows.sort(
			(a, b) =>
				(a.resetAt ?? Number.POSITIVE_INFINITY) -
				(b.resetAt ?? Number.POSITIVE_INFINITY),
		);
		result.tokens_limit = tokenWindows[0] ?? null;
		result.tokens_limit_weekly = tokenWindows[1]
			? { ...tokenWindows[1], type: "tokens_limit_weekly" }
			: null;

		return result;
	} catch (error) {
		log.warn("Error fetching Zai usage data:", error);
		return null;
	}
}

interface NamedTokenWindow {
	name: "five_hour" | "seven_day";
	window: ZaiUsageWindow;
}

/** Token quotas only: TIME_LIMIT caps web tools, not model traffic. */
function tokenWindows(usage: ZaiUsageData): NamedTokenWindow[] {
	const windows: NamedTokenWindow[] = [];
	if (usage.tokens_limit) {
		windows.push({ name: "five_hour", window: usage.tokens_limit });
	}
	if (usage.tokens_limit_weekly) {
		windows.push({ name: "seven_day", window: usage.tokens_limit_weekly });
	}
	return windows;
}

/** Highest utilization wins; ties choose the later known reset. */
export function getWinningZaiTokenWindow(
	usage: ZaiUsageData | null,
): NamedTokenWindow | null {
	if (!usage) return null;
	const windows = tokenWindows(usage);
	if (windows.length === 0) return null;
	return windows.reduce((prev, current) => {
		if (current.window.percentage !== prev.window.percentage) {
			return current.window.percentage > prev.window.percentage
				? current
				: prev;
		}
		// On a tie, prefer the LATER known reset — but if either tied window's
		// reset is unknown, we cannot safely claim a recovery time at all (the
		// unknown window might still be exhausted after the known one clears),
		// so surface the unknown one rather than guessing.
		if (current.window.resetAt === null || prev.window.resetAt === null) {
			return prev.window.resetAt === null ? prev : current;
		}
		return current.window.resetAt > prev.window.resetAt ? current : prev;
	});
}

/** Return the utilization of the binding model-traffic token quota. */
export function getRepresentativeZaiUtilization(
	usage: ZaiUsageData | null,
): number | null {
	return getWinningZaiTokenWindow(usage)?.window.percentage ?? null;
}

/** Return the canonical name of the binding model-traffic token quota. */
export function getRepresentativeZaiWindow(
	usage: ZaiUsageData | null,
): string | null {
	return getWinningZaiTokenWindow(usage)?.name ?? null;
}
