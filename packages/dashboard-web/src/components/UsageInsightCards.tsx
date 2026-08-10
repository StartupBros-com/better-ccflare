import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import { Flame } from "lucide-react";
import { computeWeeklyPace, formatDurationShort } from "../lib/usage-pace";
import { cn } from "../lib/utils";
import { formatWindowName } from "./accounts/rate-limit-helpers";
import { Card, CardContent } from "./ui/card";

interface UsageInsightCardsProps {
	windows: UsageHistoryWindowSeries[];
	/** Reference "now" (ms epoch), injected by the caller for determinism —
	 * pass the same minute-bucketed value the chart uses (no Date.now() here). */
	now: number;
}

const PACE_LABEL: Record<string, string> = {
	on_pace: "on pace",
	over_pace: "over pace",
	in_reserve: "in reserve",
};

/**
 * Burn-rate & weekly-pace insight cards — one per window that has at least
 * one snapshot, reusing the SAME `windows` series (and its server-computed
 * `prediction`) the usage-history chart already fetched. No duplicate
 * fetching and no reimplemented regression: slope/ETA/willExhaustBeforeReset
 * all come straight from `UsageHistoryWindowSeries.prediction`.
 */
export function UsageInsightCards({ windows, now }: UsageInsightCardsProps) {
	const active = windows.filter((w) => w.points.length > 0);
	if (active.length === 0) return null;

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
			{active.map((series) => (
				<WindowInsightCard key={series.window} series={series} now={now} />
			))}
		</div>
	);
}

function WindowInsightCard({
	series,
	now,
}: {
	series: UsageHistoryWindowSeries;
	now: number;
}) {
	const { window, prediction, points } = series;
	const lastPoint = points[points.length - 1];

	// Mirrors the prediction lib's own confidence gate: too few points
	// ("insufficient_data") or a data span under ~5 min (lowConfidence) both
	// mean the trend isn't trustworthy yet.
	const insufficientData =
		prediction.state === "insufficient_data" || prediction.lowConfidence;

	const burnRateLabel = insufficientData
		? "—"
		: `${prediction.slopePerHour >= 0 ? "+" : ""}${prediction.slopePerHour.toFixed(1)}%/hr`;

	const exhaustsFirst =
		!insufficientData &&
		prediction.willExhaustBeforeReset &&
		prediction.etaExhaustMs != null;

	const exhaustRestLabel = insufficientData
		? "— insufficient data"
		: [
				prediction.state === "exhausted"
					? "exhausts now"
					: prediction.etaExhaustMs != null
						? `exhausts in ${formatDurationShort(Math.max(0, prediction.etaExhaustMs - now))}`
						: "not exhausting",
				prediction.resetsAtMs != null
					? `resets in ${formatDurationShort(Math.max(0, prediction.resetsAtMs - now))}`
					: "no reset known",
			].join(" / ");

	// Weekly pace: seven_day only (not seven_day_opus/seven_day_sonnet — those
	// are per-model tiers, not the account-wide weekly window this compares
	// against calendar pace).
	const weeklyPace =
		window === "seven_day" && lastPoint
			? computeWeeklyPace(lastPoint.utilization, prediction.resetsAtMs, now)
			: null;

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center justify-between mb-4">
					<Flame className="h-8 w-8 text-muted-foreground/20" />
				</div>
				<div className="space-y-1">
					<p className="text-sm text-muted-foreground">
						{formatWindowName(window)} burn rate
					</p>
					<p className="text-2xl font-bold">{burnRateLabel}</p>
				</div>
				<div className="mt-3 pt-3 border-t border-border/50 space-y-1">
					<div className="flex items-baseline justify-between text-xs gap-2">
						<span className="text-muted-foreground shrink-0">
							Exhaustion vs reset
						</span>
						<span
							className={cn(
								"font-medium tabular-nums text-right",
								exhaustsFirst ? "text-destructive" : "text-muted-foreground",
							)}
						>
							{exhaustRestLabel}
						</span>
					</div>
					{weeklyPace && (
						<div className="flex items-baseline justify-between text-xs gap-2">
							<span className="text-muted-foreground shrink-0">
								Weekly pace
							</span>
							<span
								className={cn(
									"font-medium tabular-nums text-right",
									weeklyPace.band === "over_pace"
										? "text-warning"
										: weeklyPace.band === "in_reserve"
											? "text-success"
											: "text-muted-foreground",
								)}
							>
								{PACE_LABEL[weeklyPace.band]} (
								{weeklyPace.deltaPct >= 0 ? "+" : ""}
								{weeklyPace.deltaPct.toFixed(1)}pp)
							</span>
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
