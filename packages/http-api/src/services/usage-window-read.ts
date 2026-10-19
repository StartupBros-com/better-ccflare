import type { DatabaseOperations, UsageWindow } from "@better-ccflare/database";
import { valueWindowAggregates } from "./usage-window-valuation";

const HOUR_MS = 60 * 60 * 1000;
/** One closed-or-open `usage_windows` row, camelCased 1:1 — every ledger
 * column the issue asked for, including the parsed `modelBreakdown`. */
export interface UsageWindowRecord {
	id: string;
	accountId: string;
	windowKey: string;
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	grantType: string;
	peakUtilization: number;
	first100At: number | null;
	valueUsd: number | null;
	inputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	outputTokens: number | null;
	requestCount: number | null;
	modelBreakdown: Record<string, unknown> | null;
	unpricedTokens: number | null;
	projectionVersion: string | null;
}

/** The still-open window, with its value computed live rather than read
 * from a (necessarily NULL, since it hasn't closed yet) `value_usd` column. */
export interface OpenUsageWindowRecord extends UsageWindowRecord {
	valueSoFarUsd: number;
	utilization: number;
	ageHours: number;
}

export function toUsageWindowRecord(window: UsageWindow): UsageWindowRecord {
	return {
		id: window.id,
		accountId: window.accountId,
		windowKey: window.windowKey,
		startedAt: window.startedAt,
		resetsAt: window.resetsAt,
		closedAt: window.closedAt,
		grantType: window.grantType,
		peakUtilization: window.peakUtilization,
		first100At: window.first100At,
		valueUsd: window.valueUsd,
		inputTokens: window.inputTokens,
		cacheReadInputTokens: window.cacheReadInputTokens,
		cacheCreationInputTokens: window.cacheCreationInputTokens,
		outputTokens: window.outputTokens,
		requestCount: window.requestCount,
		modelBreakdown: window.modelBreakdown,
		unpricedTokens: window.unpricedTokens,
		projectionVersion: window.projectionVersion,
	};
}

/** Value an open ledger row using the canonical prices at its grant start. */
export async function valueOpenWindow(
	dbOps: Pick<DatabaseOperations, "aggregateTokensByModel">,
	open: UsageWindow,
	nowMs: number,
): Promise<OpenUsageWindowRecord> {
	const aggregates = await dbOps.aggregateTokensByModel(
		open.accountId,
		open.startedAt,
		nowMs,
	);
	const valuation = valueWindowAggregates(aggregates, open.startedAt);
	return {
		...toUsageWindowRecord(open),
		valueSoFarUsd: valuation.valueUsd,
		// An unclosed row has no persisted unpriced count; use the live valuation.
		unpricedTokens: valuation.unpricedTokens,
		utilization: open.peakUtilization,
		ageHours: (nowMs - open.startedAt) / HOUR_MS,
	};
}

/** Private read projection: preserve persisted closed values and value the first
 * open row live, including overdue rows. Reads never settle or mutate rows. */
export async function readUsageWindows(
	dbOps: Pick<
		DatabaseOperations,
		"listUsageWindows" | "aggregateTokensByModel"
	>,
	accountId: string,
	windowKey: string,
	limit: number,
	nowMs: number,
	existingWindows?: UsageWindow[],
): Promise<{
	windows: UsageWindowRecord[];
	openWindow: OpenUsageWindowRecord | null;
}> {
	const allWindows =
		existingWindows ?? (await dbOps.listUsageWindows({ accountId, windowKey }));
	const open = allWindows.find((window) => window.closedAt == null);
	return {
		windows: allWindows
			.filter((window) => window.closedAt != null)
			.slice(0, limit)
			.map(toUsageWindowRecord),
		openWindow: open ? await valueOpenWindow(dbOps, open, nowMs) : null,
	};
}
