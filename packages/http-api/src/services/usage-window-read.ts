import { valueWindowAggregates } from "@better-ccflare/core";
import type { DatabaseOperations, UsageWindow } from "@better-ccflare/database";

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

function toRecord(window: UsageWindow): UsageWindowRecord {
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

/** Shared read projection: open rows use canonical valuation at grant start;
 * completed rows retain their persisted ledger valuation. Reads never settle rows. */
export async function readUsageWindows(
	dbOps: Pick<
		DatabaseOperations,
		"listUsageWindows" | "getOpenUsageWindow" | "aggregateTokensByModel"
	>,
	accountId: string,
	windowKey: string,
	limit: number,
	nowMs: number,
	options: {
		bounded?: boolean;
		activeOnly?: boolean;
		/** Ledger rows have no generation column and survive account deletion.
		 * Conservatively omit windows starting before this account generation,
		 * including an ambiguous backdated first_observed window. */
		accountCreatedAt?: number;
		existingWindows?: UsageWindow[];
	} = {},
): Promise<{
	windows: UsageWindowRecord[];
	openWindow: OpenUsageWindowRecord | null;
}> {
	const allWindows =
		options.existingWindows ??
		(options.bounded
			? [
					...(await dbOps.listUsageWindows({
						accountId,
						windowKey,
						closedOnly: true,
						limit,
						startedAtOrAfter: options.accountCreatedAt,
					})),
				]
			: await dbOps.listUsageWindows({ accountId, windowKey }));
	if (options.bounded) {
		const open = await dbOps.getOpenUsageWindow(accountId, windowKey);
		if (open) allWindows.push(open);
	}
	const candidate = allWindows.find((w) => w.closedAt == null) ?? null;
	const open =
		candidate &&
		(!options.activeOnly ||
			(candidate.startedAt <= nowMs && nowMs < candidate.resetsAt)) &&
		(options.accountCreatedAt == null ||
			candidate.startedAt >= options.accountCreatedAt)
			? candidate
			: null;
	const closed = allWindows.filter((w) => w.closedAt != null).slice(0, limit);

	let openWindow: OpenUsageWindowRecord | null = null;
	if (open) {
		const aggregates = await dbOps.aggregateTokensByModel(
			accountId,
			open.startedAt,
			nowMs,
		);
		const valuation = valueWindowAggregates(aggregates, open.startedAt);
		openWindow = {
			...toRecord(open),
			valueSoFarUsd: valuation.valueUsd,
			// The unclosed ledger row's own unpriced_tokens column is still null;
			// the live valuation is the only source that can report unpriced usage
			// inside an open window, so surface it (the dashboard's "unpriced"
			// warning on live windows depends on this field).
			unpricedTokens: valuation.unpricedTokens,
			utilization: open.peakUtilization,
			ageHours: (nowMs - open.startedAt) / HOUR_MS,
		};
	}

	return { windows: closed.map(toRecord), openWindow };
}
