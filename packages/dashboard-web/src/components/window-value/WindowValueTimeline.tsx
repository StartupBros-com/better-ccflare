import type {
	AccountUsageWindows,
	ClosedUsageWindow,
	OpenUsageWindow,
} from "../../api";
import {
	deltaVsPriorMedian,
	formatCompactWindowValue,
	formatTimelineDate,
	formatWindowValue,
	groupByProvider,
	sectionLastFullWindowSubtotal,
	type TimelineDomain,
	type TimelineTick,
	timeDomain,
	timelineSegmentGeometry,
	weeklyTimelineTicks,
} from "./window-value-utils";

const INLINE_DELTA_MIN_WIDTH_PERCENT = 14;

/**
 * Below this width a segment cannot fit its own label (`overflow-hidden` +
 * `truncate` would clip it), so the label renders as a callout chip floating
 * NEXT to the segment instead. This is load-bearing for data honesty: the
 * production phantom-nerf window ($85 at 6% utilization, one day wide) must
 * always show its "· 6% used" qualifier, and on a multi-week domain even a
 * full 7-day window is only ~15% of the lane.
 */
const INLINE_LABEL_MIN_WIDTH_PERCENT = 9;

/**
 * When a narrow segment ends past this point, its callout chip anchors to the
 * segment's left side instead of the right so it stays inside the clipped
 * lane track.
 */
const OUTSIDE_LABEL_FLIP_PERCENT = 80;

type TimelineWindow = ClosedUsageWindow | OpenUsageWindow;

export interface WindowValueTimelineProps {
	accounts: readonly AccountUsageWindows[];
	nowMs: number;
}

function providerTitle(provider: string): string {
	if (provider === "codex") return "Codex Pro";
	if (provider === "anthropic") return "Claude Max";
	return provider;
}

function tickPositionPercent(atMs: number, domain: TimelineDomain): number {
	const spanMs = Math.max(1, domain.endMs - domain.startMs);
	return ((atMs - domain.startMs) / spanMs) * 100;
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
	return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function segmentLabel(window: TimelineWindow): string {
	const valueUsd = isOpenWindow(window)
		? window.valueSoFarUsd
		: window.valueUsd;
	const lowerBound = window.grantType === "first_observed" ? "≥ " : "";
	const valueLabel = `${lowerBound}${formatCompactWindowValue(valueUsd)}`;

	if (isPartialWindow(window)) {
		return `${valueLabel} · ${Math.round(window.peakUtilization)}% used`;
	}

	return valueLabel;
}

function segmentTitle(
	window: TimelineWindow,
	nowMs: number,
	delta: number | null,
): string {
	const endMs = isOpenWindow(window)
		? Math.min(nowMs, window.resetsAt)
		: window.closedAt;
	const valueUsd = isOpenWindow(window)
		? window.valueSoFarUsd
		: window.valueUsd;
	const utilization = isOpenWindow(window)
		? window.utilization
		: window.peakUtilization;
	const openDetail = isOpenWindow(window) ? " · open" : "";
	const deltaDetail = delta === null ? "" : ` · Δ ${formatDelta(delta)}`;
	// Same lower-bound treatment as segmentLabel: a first-observed value is an
	// observational floor, and the tooltip must never present it as exact.
	const lowerBound = window.grantType === "first_observed" ? "≥ " : "";

	return `${formatTimelineDate(window.startedAt)} – ${formatTimelineDate(endMs)} · ${lowerBound}${formatWindowValue(valueUsd)} · ${Math.round(utilization)}% used · ${grantTypeLabel(window)}${deltaDetail}${openDetail}`;
}

function TimelineGridlines({
	domain,
	ticks,
}: {
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
}) {
	return (
		<>
			{ticks.map((tick) => (
				<span
					aria-hidden="true"
					className="absolute inset-y-0 w-px bg-border/70"
					key={tick.atMs}
					style={{ left: `${tickPositionPercent(tick.atMs, domain)}%` }}
				/>
			))}
		</>
	);
}

function TimelineAxis({
	domain,
	ticks,
}: {
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
}) {
	return (
		<div className="relative h-8 border-b border-border">
			<TimelineGridlines domain={domain} ticks={ticks} />
			{ticks.map((tick) => (
				<span
					className="absolute top-1 text-[10px] text-muted-foreground"
					key={tick.atMs}
					style={{
						left: `${tickPositionPercent(tick.atMs, domain)}%`,
						transform: "translateX(-50%)",
					}}
				>
					{tick.label}
				</span>
			))}
		</div>
	);
}

function DeltaChip({ delta }: { delta: number }) {
	const isNerf = delta < 0;
	return (
		<span
			className={
				isNerf
					? "shrink-0 rounded bg-destructive/15 px-1 py-0.5 text-[10px] font-medium text-destructive"
					: "shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
			}
		>
			Δ {formatDelta(delta)}
		</span>
	);
}

function WindowValueSegment({
	window,
	windowIndex,
	closedWindows,
	domain,
	nowMs,
}: {
	window: TimelineWindow;
	windowIndex: number | null;
	closedWindows: readonly ClosedUsageWindow[];
	domain: TimelineDomain;
	nowMs: number;
}) {
	const geometry = timelineSegmentGeometry(window, domain, nowMs);
	const partial = isPartialWindow(window);
	const open = isOpenWindow(window);
	const delta =
		windowIndex === null
			? null
			: deltaVsPriorMedian(closedWindows, windowIndex);
	const showInlineDelta =
		delta !== null && geometry.widthPercent >= INLINE_DELTA_MIN_WIDTH_PERCENT;
	const labelInside = geometry.widthPercent >= INLINE_LABEL_MIN_WIDTH_PERCENT;
	const rightEdgePercent = geometry.leftPercent + geometry.widthPercent;
	const title = segmentTitle(window, nowMs, delta);
	const classNames = [
		"window-value-segment",
		"absolute inset-y-2 flex min-w-0 items-center gap-1 overflow-hidden rounded-sm border px-1.5 text-[11px] font-medium shadow-sm",
		window.grantType === "early_reset"
			? "window-value-segment--early-reset border-amber-500/60 bg-amber-400/80 text-amber-950 dark:bg-amber-500/70 dark:text-amber-50"
			: window.grantType === "first_observed"
				? "window-value-segment--first-observed border-muted-foreground/30 bg-muted text-muted-foreground"
				: "border-primary/35 bg-primary/80 text-primary-foreground dark:bg-primary/70",
		partial ? "window-value-segment--partial opacity-45" : "",
		open ? "border-r-2 border-r-dashed" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<div
				className={classNames}
				style={{
					left: `${geometry.leftPercent}%`,
					width: `${geometry.widthPercent}%`,
				}}
				title={title}
			>
				{labelInside && (
					<span className="truncate">{segmentLabel(window)}</span>
				)}
				{window.grantType === "early_reset" &&
					geometry.widthPercent >= INLINE_DELTA_MIN_WIDTH_PERCENT && (
						<span className="shrink-0 rounded bg-background/25 px-1 py-0.5 text-[10px] font-semibold">
							bonus reset
						</span>
					)}
				{showInlineDelta && <DeltaChip delta={delta} />}
			</div>
			{!labelInside && (
				<span
					className="window-value-segment-label--outside absolute inset-y-2 z-10 flex items-center whitespace-nowrap rounded border border-border bg-background/95 px-1 text-[11px] font-medium text-foreground shadow-sm"
					style={
						rightEdgePercent > OUTSIDE_LABEL_FLIP_PERCENT
							? { right: `${100 - geometry.leftPercent}%` }
							: { left: `${rightEdgePercent}%` }
					}
					title={title}
				>
					{segmentLabel(window)}
				</span>
			)}
		</>
	);
}

function AccountTimelineLane({
	account,
	domain,
	ticks,
	nowMs,
}: {
	account: AccountUsageWindows;
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
	nowMs: number;
}) {
	const closedSegments = account.windows
		.map((window, index) => ({ window, index }))
		.reverse();
	const openSegment = account.openWindow
		? { window: account.openWindow, index: null }
		: null;

	return (
		<div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
			<div className="flex min-w-0 items-center">
				<p
					className="truncate text-sm font-medium text-foreground"
					title={account.accountName}
				>
					{account.accountName}
				</p>
			</div>
			<div className="relative h-14 overflow-hidden rounded-md bg-muted/30">
				<TimelineGridlines domain={domain} ticks={ticks} />
				{closedSegments.map(({ window, index }) => (
					<WindowValueSegment
						closedWindows={account.windows}
						domain={domain}
						key={window.id}
						nowMs={nowMs}
						window={window}
						windowIndex={index}
					/>
				))}
				{openSegment && (
					<WindowValueSegment
						closedWindows={account.windows}
						domain={domain}
						key={openSegment.window.id}
						nowMs={nowMs}
						window={openSegment.window}
						windowIndex={openSegment.index}
					/>
				)}
			</div>
		</div>
	);
}

/** Props-only provider-sectioned usage-window timeline for deterministic rendering. */
export function WindowValueTimeline({
	accounts,
	nowMs,
}: WindowValueTimelineProps) {
	const sections = groupByProvider(accounts);
	const domain = timeDomain(accounts, nowMs);
	const ticks = weeklyTimelineTicks(domain);

	return (
		<div className="space-y-8">
			{sections.map((section) => {
				const subtotal = sectionLastFullWindowSubtotal(section.accounts);
				const title = providerTitle(section.provider);

				return (
					<section
						aria-label={`${title} usage-window timeline`}
						className="space-y-3"
						key={section.provider}
					>
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<h2 className="text-lg font-semibold tracking-tight text-foreground">
								{title}
							</h2>
							<p className="text-sm text-muted-foreground">
								{`last full window: ${formatWindowValue(subtotal)}`}
							</p>
						</div>

						<div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
							<p className="self-end pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
								Account
							</p>
							<TimelineAxis domain={domain} ticks={ticks} />
						</div>

						<div className="space-y-2">
							{section.accounts.map((account) => (
								<AccountTimelineLane
									account={account}
									domain={domain}
									key={account.accountId}
									nowMs={nowMs}
									ticks={ticks}
								/>
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}
