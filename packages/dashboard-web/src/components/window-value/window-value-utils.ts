import type {
	AccountUsageWindows,
	ClosedUsageWindow,
	OpenUsageWindow,
} from "../../api";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

const WINDOW_VALUE_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const TIMELINE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

export interface ProviderWindowSection {
	provider: string;
	accounts: AccountUsageWindows[];
}

export interface TimelineDomain {
	startMs: number;
	endMs: number;
}

export interface TimelineTick {
	atMs: number;
	label: string;
}

export interface TimelineSegmentGeometry {
	leftPercent: number;
	widthPercent: number;
}

/** Formats a window's value using the two-decimal monetary precision shown in the ledger. */
export function formatWindowValue(valueUsd: number): string {
	return WINDOW_VALUE_FORMATTER.format(valueUsd);
}

/** Formats a window value compactly enough to label a timeline segment. */
export function formatCompactWindowValue(valueUsd: number): string {
	if (Math.abs(valueUsd) < 1_000) return formatWindowValue(valueUsd);

	const compact = (valueUsd / 1_000).toFixed(1).replace(/\.0$/, "");
	return `$${compact}k`;
}

/** Formats timeline dates in UTC, rather than the browser's local time zone. */
export function formatTimelineDate(atMs: number): string {
	return TIMELINE_DATE_FORMATTER.format(atMs);
}

/** A qualifying window is a fully consumed, non-observational grant. */
export function isQualifyingWindow(window: ClosedUsageWindow): boolean {
	return (
		window.grantType !== "first_observed" &&
		window.peakUtilization >= 95 &&
		Number.isFinite(window.valueUsd)
	);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

/**
 * Returns a closed window's change versus the median of qualifying older windows.
 * The API is newest-first, so a window's priors follow it in the array. Partially
 * consumed and first-observed windows neither establish a baseline nor receive a
 * delta themselves.
 */
export function deltaVsPriorMedian(
	windows: readonly ClosedUsageWindow[],
	windowIndex: number,
): number | null {
	const window = windows[windowIndex];
	if (!window || !isQualifyingWindow(window)) return null;

	const priors = windows
		.slice(windowIndex + 1)
		.filter(isQualifyingWindow)
		.map((prior) => prior.valueUsd);

	if (priors.length < 2) return null;

	const priorMedian = median(priors);
	if (priorMedian === 0) return null;
	return ((window.valueUsd - priorMedian) / priorMedian) * 100;
}

/** Groups accounts into stable provider sections, putting paid Claude-code providers first. */
export function groupByProvider(
	accounts: readonly AccountUsageWindows[],
): ProviderWindowSection[] {
	const byProvider = new Map<string, AccountUsageWindows[]>();
	for (const account of accounts) {
		const section = byProvider.get(account.provider);
		if (section) section.push(account);
		else byProvider.set(account.provider, [account]);
	}

	return [...byProvider.entries()]
		.map(([provider, sectionAccounts]) => ({
			provider,
			accounts: [...sectionAccounts].sort((left, right) =>
				left.accountName.localeCompare(right.accountName),
			),
		}))
		.sort((left, right) => providerSortOrder(left.provider, right.provider));
}

function providerSortOrder(left: string, right: string): number {
	const specialOrder = ["codex", "anthropic"];
	const leftIndex = specialOrder.indexOf(left);
	const rightIndex = specialOrder.indexOf(right);

	if (leftIndex !== -1 || rightIndex !== -1) {
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	}

	return left.localeCompare(right);
}

/** Sums every account's most recent qualifying closed-window value in a section. */
export function sectionLastFullWindowSubtotal(
	accounts: readonly AccountUsageWindows[],
): number {
	return accounts.reduce((subtotal, account) => {
		const latestFullWindow = account.windows.find(isQualifyingWindow);
		return subtotal + (latestFullWindow?.valueUsd ?? 0);
	}, 0);
}

/** Builds the common timeline domain from every closed and live rendered window. */
export function timeDomain(
	accounts: readonly AccountUsageWindows[],
	nowMs: number,
): TimelineDomain {
	const startedAts = accounts.flatMap((account) => [
		...account.windows.map((window) => window.startedAt),
		...(account.openWindow ? [account.openWindow.startedAt] : []),
	]);

	return {
		startMs: startedAts.length > 0 ? Math.min(...startedAts) : nowMs,
		endMs: nowMs,
	};
}

/** Generates deterministic weekly axis ticks from a timeline domain. */
export function weeklyTimelineTicks(domain: TimelineDomain): TimelineTick[] {
	const ticks: TimelineTick[] = [];
	for (let atMs = domain.startMs; atMs <= domain.endMs; atMs += WEEK_MS) {
		ticks.push({ atMs, label: formatTimelineDate(atMs) });
	}
	return ticks;
}

/** Converts a closed or live usage window into its position in the shared domain. */
export function timelineSegmentGeometry(
	window: ClosedUsageWindow | OpenUsageWindow,
	domain: TimelineDomain,
	nowMs: number,
): TimelineSegmentGeometry {
	const spanMs = Math.max(1, domain.endMs - domain.startMs);
	const endMs =
		window.closedAt === null
			? Math.min(nowMs, window.resetsAt)
			: window.closedAt;

	return {
		leftPercent: ((window.startedAt - domain.startMs) / spanMs) * 100,
		widthPercent: Math.max(0, ((endMs - window.startedAt) / spanMs) * 100),
	};
}
