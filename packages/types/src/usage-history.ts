// packages/types/src/usage-history.ts

/** One persisted usage-window measurement. `utilization` is 0–100. */
export interface UsageSnapshotRow {
	accountId: string;
	timestamp: number; // ms epoch — when the snapshot was taken
	windowKey: string; // e.g. "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet"
	utilization: number; // 0–100
	resetsAt: number | null; // ms epoch when the window resets
}

/** A single point fed to the prediction fn / chart. */
export interface PredictionPoint {
	t: number; // ms epoch
	utilization: number; // 0–100
	resetsAt: number | null;
}

export interface UsagePrediction {
	slopePerHour: number; // fitted utilization gain per hour over the current segment (0 only when the fit is flat or has too few points)
	etaExhaustMs: number | null; // ms epoch reaching 100%, anchored at CURRENT usage; null unless rising/exhausted
	predictedAtReset: number | null; // clamped projected utilization (0–100) at the window reset ("target line"); null if no reset/low-confidence
	resetsAtMs: number | null; // current window reset (ms epoch)
	willExhaustBeforeReset: boolean; // the RAW (unclamped) projected-at-reset value >= 100
	state: "insufficient_data" | "stable" | "rising" | "exhausted";
	lowConfidence: boolean; // data span < ~5 min — trend not trustworthy; etaExhaustMs/predictedAtReset suppressed (slopePerHour still reported)
}

export interface UsageHistoryWindowSeries {
	window: string;
	points: PredictionPoint[];
	prediction: UsagePrediction;
}

export interface UsageHistoryResponse {
	accountId: string;
	range: string;
	windows: UsageHistoryWindowSeries[];
}

/**
 * One window's points for one account in the fleet-wide (all-accounts) view.
 * No per-window `prediction` — the fleet chart only plots raw series, and
 * computing/predicting per account × window for every account would be
 * unnecessary work for a payload nobody reads insight cards from.
 */
export interface FleetWindowSeries {
	window: string;
	points: PredictionPoint[];
}

/** One account's series in the fleet-wide usage history view. */
export interface FleetAccountUsageSeries {
	accountId: string;
	accountName: string;
	windows: FleetWindowSeries[];
}

/**
 * Response for GET /api/usage-history?account=all (account omitted defaults
 * to the same fleet view). One entry per account that has at least one
 * snapshot in range — accounts with none are omitted entirely.
 */
export interface FleetUsageHistoryResponse {
	range: string;
	accounts: FleetAccountUsageSeries[];
	/** True when at least one account's history query failed and was skipped
	 * — the response is a partial fleet, not an authoritative empty state. */
	partial: boolean;
	/** Names of accounts whose queries failed (empty when partial is false). */
	failedAccounts: string[];
	/**
	 * True when a global point budget excluded whole series from this response.
	 * Distinct from `partial`, which means a query FAILED. A truncated response
	 * is healthy but incomplete, and the UI must say so rather than presenting
	 * a budgeted fleet as the whole fleet.
	 */
	truncated: boolean;
	/** Accounts that had data in range but were entirely excluded by the budget. */
	omittedAccountCount: number;
	/** Account x window series excluded by the budget. */
	omittedSeriesCount: number;
	/** Points actually returned, after bucketing and the budget. */
	returnedPointCount: number;
}
