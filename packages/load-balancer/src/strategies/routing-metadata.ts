import type { Account, RequestMeta } from "@better-ccflare/types";

const PRESSURE_RANK = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
} as const;

/** Remove accounts that the request planner has found hard-ineligible. */
export function filterHardExcludedAccounts(
	accounts: Account[],
	meta?: RequestMeta,
): Account[] {
	const excluded = meta?.hardExcludedAccountIds;
	if (!excluded || excluded.size === 0) return accounts;
	return accounts.filter((account) => !excluded.has(account.id));
}

/**
 * Compare the immutable outer routing class shared by all strategies.
 *
 * Numeric priority is always authoritative. Quota pressure is considered only
 * for same-priority accounts carrying the same non-null comparison key. A zero
 * result intentionally delegates to each strategy's existing utilization,
 * recency, or stable-order tiebreaker.
 */
export function compareRoutingMetadata(
	a: Account,
	b: Account,
	meta?: RequestMeta,
): number {
	if (a.priority !== b.priority) return a.priority - b.priority;

	const pressureA = meta?.quotaPressureByAccountId?.get(a.id);
	const pressureB = meta?.quotaPressureByAccountId?.get(b.id);
	if (
		!pressureA ||
		!pressureB ||
		pressureA.comparisonKey === null ||
		pressureB.comparisonKey === null ||
		pressureA.comparisonKey !== pressureB.comparisonKey
	) {
		return 0;
	}

	const rankA = PRESSURE_RANK[pressureA.band];
	const rankB = PRESSURE_RANK[pressureB.band];
	if (rankA === undefined || rankB === undefined) return 0;
	return rankB - rankA;
}

/**
 * Whether a sticky owner remains in the best account's priority/pressure
 * class. Incomparable or missing pressure deliberately falls back to legacy
 * same-priority stickiness rather than manufacturing an ordering.
 */
export function isSameRoutingClass(
	account: Account,
	best: Account,
	meta?: RequestMeta,
): boolean {
	if (account.priority !== best.priority) return false;

	const accountPressure = meta?.quotaPressureByAccountId?.get(account.id);
	const bestPressure = meta?.quotaPressureByAccountId?.get(best.id);
	if (
		!accountPressure ||
		!bestPressure ||
		accountPressure.comparisonKey === null ||
		bestPressure.comparisonKey === null ||
		accountPressure.comparisonKey !== bestPressure.comparisonKey
	) {
		return true;
	}

	return accountPressure.band === bestPressure.band;
}
