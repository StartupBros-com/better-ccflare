import type {
	AccountUsageWindows,
	ClosedUsageWindow,
	OpenUsageWindow,
} from "../../api";
import {
	deltaVsPreviousQualifying,
	deltaVsPriorMedian,
	formatTimelineDate,
	formatWindowValue,
} from "./window-value-utils";

const DAY_MS = 24 * 60 * 60 * 1_000;

type TimelineWindow = ClosedUsageWindow | OpenUsageWindow;

interface ComparisonRow {
	window: TimelineWindow;
	closedWindowIndex: number | null;
}

export interface WindowValueComparisonTableProps {
	accounts: readonly AccountUsageWindows[];
	nowMs: number;
}

function isOpenWindow(window: TimelineWindow): window is OpenUsageWindow {
	return window.closedAt === null;
}

function isPartialWindow(window: TimelineWindow): boolean {
	return !isOpenWindow(window) && window.peakUtilization < 95;
}

function grantTypeLabel(window: TimelineWindow): string {
	if (window.grantType === "early_reset") return "bonus reset";
	if (window.grantType === "first_observed") return "partial";
	return "natural";
}

function formatDelta(delta: number): string {
	return `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
}

function windowValue(window: TimelineWindow): number {
	return isOpenWindow(window) ? window.valueSoFarUsd : window.valueUsd;
}

function windowDurationDays(window: TimelineWindow, nowMs: number): string {
	const endMs = isOpenWindow(window)
		? Math.min(nowMs, window.resetsAt)
		: window.closedAt;
	return (Math.max(0, endMs - window.startedAt) / DAY_MS).toFixed(1);
}

function windowUtilization(window: TimelineWindow): number {
	return Math.round(
		isOpenWindow(window) ? window.utilization : window.peakUtilization,
	);
}

function comparisonRows(account: AccountUsageWindows): ComparisonRow[] {
	return [
		...(account.openWindow
			? [{ window: account.openWindow, closedWindowIndex: null }]
			: []),
		...account.windows.map((window, closedWindowIndex) => ({
			window,
			closedWindowIndex,
		})),
	];
}

function DeltaCell({ delta }: { delta: number | null }) {
	if (delta === null) {
		return <span className="text-muted-foreground">—</span>;
	}

	return (
		<span
			className={
				delta < 0
					? "rounded bg-destructive/15 px-1 py-0.5 text-[10px] font-medium text-destructive"
					: "rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
			}
		>
			{formatDelta(delta)}
		</span>
	);
}

/** Provider-local period-over-period values for the timeline's account lanes. */
export function WindowValueComparisonTable({
	accounts,
	nowMs,
}: WindowValueComparisonTableProps) {
	return (
		<div className="space-y-2">
			<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Period over period
			</p>
			<div className="overflow-x-auto rounded-md border border-border">
				<table className="w-full min-w-[46rem] text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th scope="col" className="px-3 py-2 text-left font-medium">
								Account
							</th>
							<th scope="col" className="px-3 py-2 text-left font-medium">
								Window
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Days
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Value
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Util
							</th>
							<th scope="col" className="px-3 py-2 text-left font-medium">
								Grant
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Δ prev
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Δ median
							</th>
						</tr>
					</thead>
					<tbody>
						{accounts.flatMap((account) =>
							comparisonRows(account).map(({ window, closedWindowIndex }) => {
								const open = isOpenWindow(window);
								const partial = isPartialWindow(window);
								const deltaPrevious =
									closedWindowIndex === null
										? null
										: deltaVsPreviousQualifying(
												account.windows,
												closedWindowIndex,
											);
								const deltaMedian =
									closedWindowIndex === null
										? null
										: deltaVsPriorMedian(account.windows, closedWindowIndex);
								const rowClassName = [
									"border-t border-border",
									partial
										? "window-value-row--partial opacity-50 text-muted-foreground"
										: "",
									open ? "window-value-row--open bg-muted/20" : "",
								]
									.filter(Boolean)
									.join(" ");
								const lowerBound =
									window.grantType === "first_observed" ? "≥ " : "";
								const endMs = open
									? Math.min(nowMs, window.resetsAt)
									: window.closedAt;
								const windowLabel = `${formatTimelineDate(window.startedAt)} → ${formatTimelineDate(endMs)}`;
								const valueLabel = `${lowerBound}${formatWindowValue(windowValue(window))}`;
								const utilizationLabel = `${windowUtilization(window)}%`;

								return (
									<tr className={rowClassName} key={window.id}>
										<td className="px-3 py-2 font-medium text-foreground">
											{account.accountName}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{windowLabel}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{windowDurationDays(window, nowMs)}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
											{valueLabel}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{utilizationLabel}
										</td>
										<td className="whitespace-nowrap px-3 py-2">
											<span>{grantTypeLabel(window)}</span>
											{open && (
												<span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
													open
												</span>
											)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											<DeltaCell delta={deltaPrevious} />
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											<DeltaCell delta={deltaMedian} />
										</td>
									</tr>
								);
							}),
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
