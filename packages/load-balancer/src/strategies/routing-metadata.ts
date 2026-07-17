import type {
	Account,
	RequestMeta,
	RoutingCandidateMetadata,
} from "@better-ccflare/types";

const PRESSURE_RANK = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
} as const;

/** One account and the immutable route candidate it represents. */
export interface StrategyCandidate {
	account: Account;
	routing: RoutingCandidateMetadata;
}

function synthesizedRouting(
	account: Account,
	ordinal: number,
	occurrence: number,
	meta?: RequestMeta,
): RoutingCandidateMetadata {
	return {
		candidateId:
			occurrence === 0
				? `account:${account.id}`
				: `account:${account.id}#${occurrence}`,
		accountId: account.id,
		tier: account.priority,
		ordinal,
		comboSlotId: null,
		modelOverride: meta?.appliedModel ?? meta?.originalModel ?? null,
		quotaPressure: meta?.quotaPressureByAccountId?.get(account.id) ?? null,
	};
}

/**
 * Zip account values with their exact candidate metadata. Candidate identity is
 * positional when the selector supplied an aligned sidecar; otherwise unused
 * same-account entries are consumed in source order before synthesizing legacy
 * metadata. This occurrence-aware fallback is important for custom strategies
 * and for combos that intentionally repeat one account in multiple slots.
 */
export function zipStrategyCandidates(
	accounts: Account[],
	meta?: RequestMeta,
): StrategyCandidate[] {
	const explicit = meta?.routingCandidates;
	if (
		explicit?.length === accounts.length &&
		explicit.every(
			(candidate, index) => candidate.accountId === accounts[index]?.id,
		)
	) {
		return accounts.map((account, index) => ({
			account,
			routing: explicit[index] as RoutingCandidateMetadata,
		}));
	}

	const source = explicit ?? meta?.routingCandidateCatalog ?? [];
	const usedCandidateIds = new Set<string>();
	const occurrences = new Map<string, number>();
	return accounts.map((account, ordinal) => {
		const occurrence = occurrences.get(account.id) ?? 0;
		occurrences.set(account.id, occurrence + 1);
		const configured = source.find(
			(candidate) =>
				candidate.accountId === account.id &&
				!usedCandidateIds.has(candidate.candidateId),
		);
		if (configured) {
			usedCandidateIds.add(configured.candidateId);
			return { account, routing: configured };
		}

		return {
			account,
			routing: synthesizedRouting(account, ordinal, occurrence, meta),
		};
	});
}

/** Remove account-wide hard exclusions while preserving candidate identity. */
export function filterHardExcludedCandidates(
	candidates: StrategyCandidate[],
	meta?: RequestMeta,
): StrategyCandidate[] {
	const excluded = meta?.hardExcludedAccountIds;
	if (!excluded || excluded.size === 0) return candidates;
	return candidates.filter((candidate) => !excluded.has(candidate.account.id));
}

/** Commit one atomic candidate ordering back to the strategy's public API. */
export function commitStrategyCandidateOrder(
	candidates: StrategyCandidate[],
	meta?: RequestMeta,
): Account[] {
	if (meta) {
		meta.routingCandidates = candidates.map((candidate) => candidate.routing);
	}
	return candidates.map((candidate) => candidate.account);
}

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

/** Compare exact route candidates without collapsing duplicate accounts. */
export function compareStrategyCandidates(
	a: StrategyCandidate,
	b: StrategyCandidate,
	meta?: RequestMeta,
): number {
	if (a.routing.tier !== b.routing.tier) {
		return a.routing.tier - b.routing.tier;
	}

	const pressureA =
		a.routing.quotaPressure ??
		meta?.quotaPressureByAccountId?.get(a.account.id);
	const pressureB =
		b.routing.quotaPressure ??
		meta?.quotaPressureByAccountId?.get(b.account.id);
	if (
		!pressureA ||
		!pressureB ||
		pressureA.comparisonKey === null ||
		pressureB.comparisonKey === null ||
		pressureA.comparisonKey !== pressureB.comparisonKey
	) {
		return 0;
	}

	return PRESSURE_RANK[pressureB.band] - PRESSURE_RANK[pressureA.band];
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

/** Whether two exact candidates remain in the same sticky routing class. */
export function isSameStrategyCandidateClass(
	candidate: StrategyCandidate,
	best: StrategyCandidate,
	meta?: RequestMeta,
): boolean {
	if (candidate.routing.tier !== best.routing.tier) return false;

	const candidatePressure =
		candidate.routing.quotaPressure ??
		meta?.quotaPressureByAccountId?.get(candidate.account.id);
	const bestPressure =
		best.routing.quotaPressure ??
		meta?.quotaPressureByAccountId?.get(best.account.id);
	if (
		!candidatePressure ||
		!bestPressure ||
		candidatePressure.comparisonKey === null ||
		bestPressure.comparisonKey === null ||
		candidatePressure.comparisonKey !== bestPressure.comparisonKey
	) {
		return true;
	}

	return candidatePressure.band === bestPressure.band;
}
