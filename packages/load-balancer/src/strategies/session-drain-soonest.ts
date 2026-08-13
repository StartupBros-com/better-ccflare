import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import {
	compareStrategyCandidates,
	type StrategyCandidate,
} from "./routing-metadata";
import { SessionAffinityStrategy } from "./session-affinity";

/**
 * Opt-in SessionAffinity variant that drains the account whose all-model
 * weekly window expires first. The inherited strategy still owns client/lane
 * affinity, route circuits, anti-thrash, and cache-safe sticky-owner logic;
 * this class changes ordering only at fresh assignment or account failover.
 *
 * Structural routing metadata (tier, quota-pressure class, combo identity)
 * remains authoritative. Weekly-reset ordering is applied only within that
 * same structural class, then account priority, utilization, and the base
 * strategy's bounded recency score provide deterministic tie-breaks.
 */
export class SessionDrainSoonestStrategy extends SessionAffinityStrategy {
	private drainStore: StrategyStore | null = null;

	override initialize(store: StrategyStore): void {
		this.drainStore = store;
		super.initialize(store);
	}

	private weeklyReset(account: Account, now: number): number | null {
		let reset: number | null | undefined;
		try {
			reset = this.drainStore?.getAccountWeeklyReset?.(
				account.id,
				account.provider,
			);
		} catch {
			// A telemetry adapter must never make candidate selection fail closed.
			return null;
		}
		// Treat absent, malformed, and already-past telemetry as unknown. This
		// fail-open rule is important during the first poll after a real rollover.
		if (reset === null || reset === undefined || !Number.isFinite(reset)) {
			return null;
		}
		return reset > now ? reset : null;
	}

	protected override rankFreshCandidates(
		candidates: StrategyCandidate[],
		now: number,
		meta?: RequestMeta,
	): StrategyCandidate[] {
		// Usage telemetry is account-scoped, not candidate-scoped. Snapshot it
		// once per ranking so a store backed by a mutable cache cannot make the
		// comparator observe different reset values across sort calls. Duplicate
		// combo slots still remain distinct because only telemetry is keyed here;
		// the candidates themselves are never collapsed.
		const weeklyResetByAccount = new Map<string, number | null>();
		const scoreByAccount = new Map<string, number>();
		const accountKey = (account: Account): string =>
			`${account.provider}\u0000${account.id}`;
		for (const candidate of candidates) {
			const key = accountKey(candidate.account);
			if (!weeklyResetByAccount.has(key)) {
				weeklyResetByAccount.set(key, this.weeklyReset(candidate.account, now));
			}
			if (!scoreByAccount.has(key)) {
				scoreByAccount.set(key, this.getLeastUsedScore(candidate.account, now));
			}
		}

		return [...candidates].sort((a, b) => {
			// Keep exact route/profile/combo classes ahead of drain urgency. This
			// prevents a weekly deadline from crossing provider/model/tier policy.
			const structuralOrder = compareStrategyCandidates(a, b, meta);
			if (structuralOrder !== 0) return structuralOrder;

			const resetA = weeklyResetByAccount.get(accountKey(a.account)) ?? null;
			const resetB = weeklyResetByAccount.get(accountKey(b.account)) ?? null;
			if (resetA !== resetB) {
				if (resetA === null) return 1;
				if (resetB === null) return -1;
				return resetA - resetB;
			}

			if (a.account.priority !== b.account.priority) {
				return a.account.priority - b.account.priority;
			}

			const scoreOrder =
				(scoreByAccount.get(accountKey(a.account)) ?? 0) -
				(scoreByAccount.get(accountKey(b.account)) ?? 0);
			if (scoreOrder !== 0) return scoreOrder;

			const ordinalOrder = a.routing.ordinal - b.routing.ordinal;
			if (ordinalOrder !== 0) return ordinalOrder;
			return a.routing.candidateId.localeCompare(b.routing.candidateId);
		});
	}
}
