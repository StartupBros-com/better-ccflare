import { useUsageWindows } from "../../hooks/queries";
import { Card, CardContent } from "../ui/card";
import { WindowValueTimeline } from "./WindowValueTimeline";

function WindowValueLoadingState() {
	return (
		<div className="space-y-6">
			{Array.from(
				{ length: 2 },
				(_, index) => `window-value-timeline-skeleton-${index}`,
			).map((key) => (
				<div key={key} className="space-y-3">
					<div className="h-6 w-56 animate-pulse rounded bg-muted" />
					<div className="h-8 animate-pulse rounded bg-muted" />
					<div className="h-14 animate-pulse rounded bg-muted" />
					<div className="h-14 animate-pulse rounded bg-muted" />
				</div>
			))}
		</div>
	);
}

/** Fleet usage-window timeline, grouped into provider sections. */
export function WindowValueTab() {
	const { data, error, isLoading } = useUsageWindows("all");
	const accounts = data && "accounts" in data ? data.accounts : [];
	const populatedAccounts = accounts.filter(
		(account) => account.openWindow !== null || account.windows.length > 0,
	);

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

	if (populatedAccounts.length === 0) {
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
		<WindowValueTimeline accounts={populatedAccounts} nowMs={Date.now()} />
	);
}
