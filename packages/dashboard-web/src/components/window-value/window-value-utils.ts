import type { AccountUsageWindows, ClosedUsageWindow } from "../../api";

const WINDOW_VALUE_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

/** Formats a window's value using the two-decimal monetary precision shown in the ledger. */
export function formatWindowValue(valueUsd: number): string {
	return WINDOW_VALUE_FORMATTER.format(valueUsd);
}

/** Formats a reset time as a deterministic whole-day and whole-hour countdown. */
export function formatCountdown(resetsAt: number, nowMs: number): string {
	const remainingHours = Math.max(
		0,
		Math.floor((resetsAt - nowMs) / 3_600_000),
	);
	const days = Math.floor(remainingHours / 24);
	const hours = remainingHours % 24;
	return `${days}d ${hours}h`;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

/**
 * Returns a closed window's change versus the median of qualifying older windows.
 * The API is newest-first, so a window's priors follow it in the array. Partial
 * first-observed windows never establish a baseline and never receive a delta.
 */
export function deltaVsPriorMedian(
	windows: readonly ClosedUsageWindow[],
	windowIndex: number,
): number | null {
	const window = windows[windowIndex];
	if (!window || window.grantType === "first_observed") return null;

	const priors = windows
		.slice(windowIndex + 1)
		.filter((prior) => prior.grantType !== "first_observed")
		.map((prior) => prior.valueUsd)
		.filter((value): value is number => Number.isFinite(value));

	if (priors.length < 2) return null;

	const priorMedian = median(priors);
	if (priorMedian === 0) return null;
	return ((window.valueUsd - priorMedian) / priorMedian) * 100;
}

export interface FleetOpenWindowSummary {
	totalUsd: number;
	liveCount: number;
	/** True when any counted live window is a partial first-observed grant, making the total a floor. */
	isLowerBound: boolean;
}

/** Sums live open-window value across accounts; partial first-observed windows make the total a lower bound. */
export function fleetOpenWindowSummary(
	accounts: readonly AccountUsageWindows[],
): FleetOpenWindowSummary {
	let totalUsd = 0;
	let liveCount = 0;
	let isLowerBound = false;
	for (const account of accounts) {
		if (!account.openWindow) continue;
		totalUsd += account.openWindow.valueSoFarUsd;
		liveCount += 1;
		if (account.openWindow.grantType === "first_observed") isLowerBound = true;
	}
	return { totalUsd, liveCount, isLowerBound };
}

function latestClosedValue(account: AccountUsageWindows): number {
	return account.windows[0]?.valueUsd ?? Number.NEGATIVE_INFINITY;
}

/** Sorts active accounts by their live value, then inactive accounts by latest closed value. */
export function sortAccountsByWindowValue<T extends AccountUsageWindows>(
	accounts: readonly T[],
): T[] {
	return [...accounts].sort((left, right) => {
		const leftOpenValue = left.openWindow?.valueSoFarUsd;
		const rightOpenValue = right.openWindow?.valueSoFarUsd;

		if (leftOpenValue !== undefined && rightOpenValue !== undefined) {
			return (
				rightOpenValue - leftOpenValue ||
				left.accountName.localeCompare(right.accountName)
			);
		}
		if (leftOpenValue !== undefined) return -1;
		if (rightOpenValue !== undefined) return 1;

		return (
			latestClosedValue(right) - latestClosedValue(left) ||
			left.accountName.localeCompare(right.accountName)
		);
	});
}
