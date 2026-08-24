import { useUsageWindows } from "../../hooks/queries";
import { Card, CardContent } from "../ui/card";
import { AccountWindowValueCard } from "./AccountWindowValueCard";
import {
	fleetOpenWindowSummary,
	formatWindowValue,
	sortAccountsByWindowValue,
} from "./window-value-utils";

function WindowValueLoadingState() {
	return (
		<div className="space-y-4">
			<div className="h-28 animate-pulse rounded-lg bg-muted" />
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
				{Array.from(
					{ length: 3 },
					(_, index) => `window-value-skeleton-${index}`,
				).map((key) => (
					<div key={key} className="h-80 animate-pulse rounded-lg bg-muted" />
				))}
			</div>
		</div>
	);
}

/** Fleet view of current usage-window value and the most recent completed windows. */
export function WindowValueTab() {
	const { data, error, isLoading } = useUsageWindows("all");
	const accounts = data && "accounts" in data ? data.accounts : [];
	const populatedAccounts = accounts.filter(
		(account) => account.openWindow !== null || account.windows.length > 0,
	);
	const sortedAccounts = sortAccountsByWindowValue(populatedAccounts);
	const fleet = fleetOpenWindowSummary(sortedAccounts);

	if (isLoading) return <WindowValueLoadingState />;

	if (error) {
		return (
			<Card className="border-destructive/40">
				<CardContent className="p-6">
					<p className="font-medium text-destructive">
						Unable to load window values.
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{error instanceof Error
							? error.message
							: "Please try again shortly."}
					</p>
				</CardContent>
			</Card>
		);
	}

	if (sortedAccounts.length === 0) {
		return (
			<Card>
				<CardContent className="p-8 text-center">
					<p className="font-medium text-foreground">No usage windows yet</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Completed and live windows will appear here after usage is observed.
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-5">
			<section
				className="rounded-lg border border-primary/20 bg-primary/5 p-5"
				aria-label="Fleet window value"
			>
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Fleet open-window value
				</p>
				<div className="mt-1 flex flex-wrap items-end justify-between gap-3">
					<p className="text-3xl font-bold tracking-tight text-foreground">
						{fleet.isLowerBound ? "≥ " : ""}
						{formatWindowValue(fleet.totalUsd)}
					</p>
					<p className="text-sm text-muted-foreground">
						{sortedAccounts.length} account
						{sortedAccounts.length === 1 ? "" : "s"} · {fleet.liveCount} live
						window{fleet.liveCount === 1 ? "" : "s"}
					</p>
				</div>
			</section>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
				{sortedAccounts.map((account) => (
					<AccountWindowValueCard key={account.accountId} account={account} />
				))}
			</div>
		</div>
	);
}
