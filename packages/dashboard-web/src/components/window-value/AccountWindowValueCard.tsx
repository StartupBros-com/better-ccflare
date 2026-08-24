import type { AccountUsageWindows, ClosedUsageWindow } from "../../api";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
	deltaVsPriorMedian,
	formatCountdown,
	formatWindowValue,
} from "./window-value-utils";

interface AccountWindowValueCardProps {
	account: AccountUsageWindows;
	nowMs?: number;
}

function formatCompactWindowValue(valueUsd: number): string {
	if (Math.abs(valueUsd) < 1_000) return formatWindowValue(valueUsd);

	const compact = (valueUsd / 1_000).toFixed(1).replace(/\.0$/, "");
	return `$${compact}k`;
}

function grantBadge(grantType: ClosedUsageWindow["grantType"]) {
	if (grantType === "early_reset") {
		return (
			<Badge variant="default" className="w-fit px-1.5 py-0 text-[10px]">
				bonus reset
			</Badge>
		);
	}
	if (grantType === "first_observed") {
		return (
			<Badge variant="secondary" className="w-fit px-1.5 py-0 text-[10px]">
				partial
			</Badge>
		);
	}
	return null;
}

function windowValueLabel(window: ClosedUsageWindow): string {
	const value = formatWindowValue(window.valueUsd);
	return window.grantType === "first_observed" ? `≥ ${value}` : value;
}

function DeltaChip({ delta }: { delta: number }) {
	const isNerf = delta < 0;
	const isAlert = delta <= -25;
	const sign = delta >= 0 ? "+" : "";

	return (
		<span
			className={
				isNerf
					? `rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive ${
							isAlert ? "font-bold ring-1 ring-destructive/30" : "font-medium"
						}`
					: "rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
			}
		>
			Δ {sign}
			{delta.toFixed(1)}%
		</span>
	);
}

/** A props-only account ledger card, suitable for server rendering and screenshot tests. */
export function AccountWindowValueCard({
	account,
	nowMs = Date.now(),
}: AccountWindowValueCardProps) {
	const oldestFirstWindows = [...account.windows].reverse();
	const maxClosedValue = Math.max(
		0,
		...account.windows.map((window) => window.valueUsd),
	);
	const resetLabel = account.openWindow
		? `resets in ${formatCountdown(account.openWindow.resetsAt, nowMs)}`
		: null;

	return (
		<Card className="min-w-0 overflow-hidden">
			<CardHeader className="flex-row items-center justify-between space-y-0 p-5 pb-3">
				<CardTitle className="truncate text-base" title={account.accountName}>
					{account.accountName}
				</CardTitle>
				<Badge variant="outline" className="shrink-0 text-[10px]">
					{account.provider}
				</Badge>
			</CardHeader>
			<CardContent className="space-y-5 p-5 pt-0">
				{account.openWindow ? (
					<div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									Open window value
								</p>
								<p className="mt-1 text-3xl font-bold tracking-tight text-foreground">
									{account.openWindow.grantType === "first_observed"
										? `≥ ${formatWindowValue(account.openWindow.valueSoFarUsd)}`
										: formatWindowValue(account.openWindow.valueSoFarUsd)}
								</p>
							</div>
							<div className="text-right text-sm">
								<p className="font-medium text-foreground">{resetLabel}</p>
								<p className="mt-1 text-muted-foreground">
									{Math.round(account.openWindow.utilization)}% utilized
								</p>
							</div>
						</div>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							{grantBadge(account.openWindow.grantType)}
							{account.openWindow.unpricedTokens > 0 && (
								<Badge variant="warning" className="px-1.5 py-0 text-[10px]">
									unpriced
								</Badge>
							)}
						</div>
					</div>
				) : (
					<div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						no live window
					</div>
				)}

				{oldestFirstWindows.length > 0 && (
					<section aria-label={`${account.accountName} closed-window values`}>
						<p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Closed windows
						</p>
						<ol className="grid grid-cols-[repeat(auto-fit,minmax(4.25rem,1fr))] gap-2">
							{oldestFirstWindows.map((window) => {
								const apiIndex = account.windows.indexOf(window);
								const delta = deltaVsPriorMedian(account.windows, apiIndex);
								const height =
									maxClosedValue > 0
										? `${(window.valueUsd / maxClosedValue) * 100}%`
										: "0%";

								return (
									<li key={window.id} className="min-w-0 text-center">
										<div className="flex h-28 items-end border-b border-border px-1">
											<div
												className="w-full rounded-t-sm bg-primary/80 transition-opacity hover:opacity-100"
												style={{ height }}
												title={windowValueLabel(window)}
											/>
										</div>
										<p
											className="mt-1 truncate text-xs font-medium text-foreground"
											title={windowValueLabel(window)}
										>
											{window.grantType === "first_observed" ? "≥ " : ""}
											{formatCompactWindowValue(window.valueUsd)}
										</p>
										<div className="mt-1 flex min-h-5 flex-wrap justify-center gap-1">
											{grantBadge(window.grantType)}
											{window.unpricedTokens > 0 && (
												<Badge
													variant="warning"
													className="px-1.5 py-0 text-[10px]"
												>
													unpriced
												</Badge>
											)}
										</div>
										{delta !== null && <DeltaChip delta={delta} />}
									</li>
								);
							})}
						</ol>
					</section>
				)}
			</CardContent>
		</Card>
	);
}
