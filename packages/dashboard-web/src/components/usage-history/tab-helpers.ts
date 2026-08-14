/**
 * Pure, structural helpers for the Usage History tab. Kept decoupled from the
 * full AccountResponse type so they stay trivially testable.
 *
 * Background: usage snapshots are only written for NON-paused accounts (the
 * feature reuses the existing usage poll, which skips paused accounts). So the
 * default selection and empty-state messaging both need to be paused-aware.
 */
export interface AccountLike {
	id: string;
	name: string;
	paused?: boolean | number | null;
}

/** First non-paused account's id; else the first account's id; else undefined. */
export function pickDefaultAccount(
	accounts?: AccountLike[],
): string | undefined {
	if (!accounts || accounts.length === 0) return undefined;
	const active = accounts.find((a) => !a.paused);
	return (active ?? accounts[0]).id;
}

/** New array with non-paused accounts first (stable within each group). */
export function sortAccountsActiveFirst<T extends AccountLike>(
	accounts: T[],
): T[] {
	// Copy first: Array.prototype.sort mutates in place, and callers pass live
	// query data. V8/Bun sort is stable, so equal-group order is preserved.
	return [...accounts].sort((a, b) => Number(!!a.paused) - Number(!!b.paused));
}

/**
 * Milliseconds spanned by a range string. Mirrors the endpoint's range set
 * (getRangeConfig: 1h/6h/24h/7d/30d) and its 24h fallback for anything else,
 * so the chart's forward horizon matches the selected range.
 */
export function rangeToMs(range: string): number {
	const H = 60 * 60 * 1000;
	switch (range) {
		case "1h":
			return H;
		case "6h":
			return 6 * H;
		case "24h":
			return 24 * H;
		case "7d":
			return 7 * 24 * H;
		case "30d":
			return 30 * 24 * H;
		default:
			return 24 * H;
	}
}

/** The truncation-relevant slice of the fleet usage-history response. */
export interface FleetTruncationLike {
	truncated?: boolean;
	omittedAccountCount?: number;
	omittedSeriesCount?: number;
	returnedPointCount?: number;
}

/**
 * Notice text when the fleet response was capped by the server's point budget,
 * or null when the response is complete.
 *
 * A budgeted response is healthy, not broken — the chart shows the newest
 * series and this says so, rather than letting a capped fleet read as the whole
 * fleet. Older servers omit these fields entirely, so an absent `truncated` is
 * treated as "complete" rather than surfacing a scary unknown state.
 */
export function fleetTruncationNotice(
	fleet?: FleetTruncationLike,
): string | null {
	if (!fleet?.truncated) return null;
	const series = fleet.omittedSeriesCount ?? 0;
	const accounts = fleet.omittedAccountCount ?? 0;
	const points = fleet.returnedPointCount ?? 0;

	const parts = [
		`Showing the ${points.toLocaleString()} newest point${points === 1 ? "" : "s"}`,
	];
	if (series > 0) {
		parts.push(`${series} series hidden`);
	}
	if (accounts > 0) {
		parts.push(`${accounts} account${accounts === 1 ? "" : "s"} not shown`);
	}
	return `Fleet view limited by the server's point budget — ${parts.join(", ")}. Narrow the range or pick a single account for the full history.`;
}

/** Empty-state message for the chart, based on the selected account. */
export function usageEmptyStateMessage(account?: AccountLike): string {
	if (!account) return "Select an account to view its usage history.";
	if (account.paused)
		return "Account is paused — usage isn't polled while paused. Resume it to start collecting history.";
	return "Collecting usage data… (first points appear within ~1 minute).";
}
