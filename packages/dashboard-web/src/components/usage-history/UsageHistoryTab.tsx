import { useState } from "react";
import type { TimeRange } from "../../constants";
import {
	useAccounts,
	useFleetUsageHistory,
	useUsageHistory,
} from "../../hooks/queries";
import { FleetUsageChart } from "../FleetUsageChart";
import { UsageInsightCards } from "../UsageInsightCards";
import { Card } from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { formatPredictionAnnotation } from "./chart-data";
import {
	pickDefaultAccount,
	rangeToMs,
	sortAccountsActiveFirst,
	usageEmptyStateMessage,
} from "./tab-helpers";
import { UsageHistoryChart } from "./UsageHistoryChart";

// Match the ranges the endpoint accepts (getRangeConfig: 1h/6h/24h/7d/30d).
const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

/** Sentinel account-picker value for the fleet-wide (all accounts) chart. */
const ALL_ACCOUNTS = "all";

export function UsageHistoryTab() {
	const { data: accounts } = useAccounts();
	const [accountId, setAccountId] = useState<string>("");
	const [range, setRange] = useState<string>("24h");

	const isFleet = accountId === ALL_ACCOUNTS;
	const selected = isFleet
		? ALL_ACCOUNTS
		: accountId || pickDefaultAccount(accounts) || "";
	const selectedAccount = accounts?.find((a) => a.id === selected);
	// Neither query fires for the branch that isn't showing — useUsageHistory
	// is disabled by its own `enabled: !!account` when passed "", and
	// useFleetUsageHistory takes `isFleet` directly as its `enabled`.
	const { data, isLoading } = useUsageHistory(isFleet ? "" : selected, range);
	const { data: fleetData, isLoading: fleetLoading } = useFleetUsageHistory(
		range,
		isFleet,
	);
	const windows = data?.windows ?? [];
	// Bucket "now" to 1-minute granularity (matching the chart's nowBucket) so the
	// per-window annotations use a single, stable reference rather than a fresh
	// Date.now() per window per render — avoids sub-minute ETA display drift.
	const nowBucket = Math.floor(Date.now() / 60_000) * 60_000;

	return (
		<div className="space-y-4">
			<div className="flex gap-3">
				<Select value={selected} onValueChange={setAccountId}>
					<SelectTrigger className="w-64">
						<SelectValue placeholder="Select account" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_ACCOUNTS}>All accounts</SelectItem>
						{sortAccountsActiveFirst(accounts ?? []).map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
								{a.paused ? " (paused)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger className="w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RANGES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{isFleet ? (
				<Card className="p-4">
					<FleetUsageChart
						accounts={fleetData?.accounts ?? []}
						loading={fleetLoading}
						emptyState="No accounts have usage snapshots in this range yet."
					/>
				</Card>
			) : (
				<>
					<UsageInsightCards windows={windows} now={nowBucket} />

					<Card className="p-4">
						<UsageHistoryChart
							windows={windows}
							rangeMs={rangeToMs(range)}
							loading={isLoading}
							emptyState={usageEmptyStateMessage(selectedAccount)}
						/>
					</Card>

					{windows.length > 0 && (
						<Card className="p-4 space-y-1 text-sm">
							{windows.map((w) => (
								<div key={w.window}>
									{formatPredictionAnnotation(w, nowBucket)}
								</div>
							))}
						</Card>
					)}
				</>
			)}
		</div>
	);
}
