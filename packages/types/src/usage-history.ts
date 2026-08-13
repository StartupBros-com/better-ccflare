/** One canonical provider usage window at the UsageCache snapshot boundary. */
export interface CanonicalUsageWindow {
	windowKey: string;
	utilization: number;
	resetsAtMs: number | null;
	scope: "account" | "family" | "other";
	modelFamily: string | null;
	active: boolean;
}

/** One persisted usage-window measurement. `utilization` is 0–100. */
export interface UsageSnapshotRow {
	accountId: string;
	timestamp: number;
	windowKey: string;
	utilization: number;
	resetsAt: number | null;
}

/** A single point fed to the prediction fn / chart. */
export interface PredictionPoint {
	t: number;
	utilization: number;
	resetsAt: number | null;
}

export interface UsagePrediction {
	slopePerHour: number;
	etaExhaustMs: number | null;
	predictedAtReset: number | null;
	resetsAtMs: number | null;
	willExhaustBeforeReset: boolean;
	state: "insufficient_data" | "stable" | "rising" | "exhausted";
	lowConfidence: boolean;
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

export interface FleetWindowSeries {
	window: string;
	points: PredictionPoint[];
}

export interface FleetAccountUsageSeries {
	accountId: string;
	accountName: string;
	windows: FleetWindowSeries[];
}

export interface FleetUsageHistoryResponse {
	range: string;
	accounts: FleetAccountUsageSeries[];
	partial: boolean;
	failedAccounts: string[];
}
