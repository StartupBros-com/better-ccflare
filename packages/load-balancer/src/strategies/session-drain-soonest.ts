import { compareAccountPreference, TIME_CONSTANTS } from "@better-ccflare/core";
import {
	type Account,
	PROVIDER_NAMES,
	type RequestMeta,
	requiresSessionDurationTracking,
	type StrategyStore,
} from "@better-ccflare/types";
import {
	compareStrategyCandidates,
	type StrategyCandidate,
} from "./routing-metadata";
import {
	RoutingTransitionRecorder,
	SessionAffinityStrategy,
} from "./session-affinity";
import { codexWindowHasReset } from "./session-window-reset";

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
export type SessionDrainSoonestMode = "sticky" | "strict";

export class SessionDrainSoonestStrategy extends SessionAffinityStrategy {
	private drainStore: StrategyStore | null = null;

	constructor(
		private readonly sessionDurationMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
		private readonly mode: SessionDrainSoonestMode = "sticky",
		routingTransitions: RoutingTransitionRecorder = new RoutingTransitionRecorder(),
	) {
		super(
			sessionDurationMs,
			undefined,
			undefined,
			undefined,
			Date.now,
			routingTransitions,
		);
	}

	override initialize(store: StrategyStore): void {
		this.drainStore = store;
		super.initialize(store);
	}

	protected override selectionAffinityKey(meta: RequestMeta): string | null {
		if (
			this.mode === "strict" &&
			meta.affinityOwnerDirective?.kind !== "retain-owner"
		) {
			return null;
		}
		return super.selectionAffinityKey(meta);
	}

	protected override canRetainAffinityOwner(
		candidate: StrategyCandidate,
		now: number,
	): boolean {
		return !codexWindowHasReset(candidate.account, now);
	}

	private hasActiveSession(account: Account, now: number): boolean {
		if (!requiresSessionDurationTracking(account.provider)) return false;
		if (account.rate_limited_until && account.rate_limited_until > now) {
			return false;
		}
		if (codexWindowHasReset(account, now)) return false;
		return (
			account.session_start !== null &&
			now - account.session_start < this.sessionDurationMs
		);
	}

	private resetSelectedSession(account: Account, now: number): void {
		const fixedDurationExpired =
			requiresSessionDurationTracking(account.provider) &&
			(account.session_start === null ||
				now - account.session_start >= this.sessionDurationMs);
		const providerWindowReset =
			(account.provider === PROVIDER_NAMES.ANTHROPIC &&
				account.rate_limit_reset !== null &&
				account.rate_limit_reset < now - 1000) ||
			codexWindowHasReset(account, now);
		if (!fixedDurationExpired && !providerWindowReset) return;

		this.drainStore?.resetAccountSession(account.id, now);
		account.session_start = now;
		account.session_request_count = 0;
	}

	override async select(
		accounts: Account[],
		meta: RequestMeta,
	): Promise<Account[]> {
		const selected = await super.select(accounts, meta);
		if (
			meta.headers?.get("x-better-ccflare-bypass-session") !== "true" &&
			selected[0]
		) {
			this.resetSelectedSession(selected[0], Date.now());
		}
		return selected;
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

	private isEligibleAutoFallback(account: Account, now: number): boolean {
		if (!account.auto_fallback_enabled) return false;
		if (
			account.provider !== PROVIDER_NAMES.ANTHROPIC &&
			account.provider !== PROVIDER_NAMES.CODEX &&
			account.provider !== PROVIDER_NAMES.ZAI
		) {
			return false;
		}
		return (
			account.rate_limit_reset !== null &&
			account.rate_limit_reset < now - 1000 &&
			(!account.rate_limited_until || account.rate_limited_until <= now)
		);
	}

	protected override rankFreshCandidates(
		candidates: StrategyCandidate[],
		now: number,
		meta?: RequestMeta,
	): StrategyCandidate[] {
		// Usage telemetry is account-scoped, not candidate-scoped. Snapshot it
		// once per ranking so a mutable cache cannot make one sort observe multiple
		// values. Exact combo slots remain distinct because candidates are not
		// collapsed by account.
		const weeklyResetByAccount = new Map<string, number | null>();
		const utilizationByAccount = new Map<string, number>();
		const stickyScoreByAccount = new Map<string, number>();
		const accountKey = (account: Account): string =>
			`${account.provider}\u0000${account.id}`;
		for (const candidate of candidates) {
			const key = accountKey(candidate.account);
			if (!weeklyResetByAccount.has(key)) {
				weeklyResetByAccount.set(key, this.weeklyReset(candidate.account, now));
			}
			if (!utilizationByAccount.has(key)) {
				let utilization = 0;
				try {
					utilization =
						this.drainStore?.getAccountUtilization?.(
							candidate.account.id,
							candidate.account.provider,
						) ?? 0;
				} catch {
					// Telemetry cannot make a candidate fail closed.
				}
				utilizationByAccount.set(key, utilization);
				stickyScoreByAccount.set(
					key,
					this.getLeastUsedScore(candidate.account, now),
				);
			}
		}

		return [...candidates].sort((a, b) => {
			// Exact route/profile/combo classes remain authoritative. Strict drain
			// changes strategy stickiness, not the candidate set or outer policy.
			const structuralOrder = compareStrategyCandidates(a, b, meta);
			if (structuralOrder !== 0) return structuralOrder;

			if (this.mode === "strict") {
				const fallbackA = this.isEligibleAutoFallback(a.account, now);
				const fallbackB = this.isEligibleAutoFallback(b.account, now);
				if (fallbackA !== fallbackB) return fallbackA ? -1 : 1;
			}

			const resetA = weeklyResetByAccount.get(accountKey(a.account)) ?? null;
			const resetB = weeklyResetByAccount.get(accountKey(b.account)) ?? null;
			if (resetA !== resetB) {
				if (resetA === null) return 1;
				if (resetB === null) return -1;
				return resetA - resetB;
			}

			if (this.mode === "strict") {
				const activeA = this.hasActiveSession(a.account, now);
				const activeB = this.hasActiveSession(b.account, now);
				if (activeA !== activeB) return activeA ? -1 : 1;
			}

			const preferenceOrder = compareAccountPreference(
				a.account,
				b.account,
				now,
			);
			if (preferenceOrder !== 0) return preferenceOrder;

			const scoreOrder =
				this.mode === "strict"
					? (utilizationByAccount.get(accountKey(a.account)) ?? 0) -
						(utilizationByAccount.get(accountKey(b.account)) ?? 0)
					: (stickyScoreByAccount.get(accountKey(a.account)) ?? 0) -
						(stickyScoreByAccount.get(accountKey(b.account)) ?? 0);
			if (scoreOrder !== 0) return scoreOrder;

			if (this.mode === "strict") {
				const accountOrder = a.account.id.localeCompare(b.account.id);
				if (accountOrder !== 0) return accountOrder;
			}
			const ordinalOrder = a.routing.ordinal - b.routing.ordinal;
			if (ordinalOrder !== 0) return ordinalOrder;
			return a.routing.candidateId.localeCompare(b.routing.candidateId);
		});
	}
}
