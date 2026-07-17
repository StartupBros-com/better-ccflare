import { isAccountAvailable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import { isPeekAvailable, wouldAutoUnpause } from "./peek-availability";
import {
	commitStrategyCandidateOrder,
	compareStrategyCandidates,
	filterHardExcludedCandidates,
	zipStrategyCandidates,
} from "./routing-metadata";

/**
 * Window during which a freshly-picked account is deprioritized so
 * concurrent bursts rotate through the pool instead of all picking
 * the same lowest-utilization candidate.
 */
const RECENT_PICK_WINDOW_MS = 500;

/**
 * Score added to an account's effective utilization when it was picked
 * within RECENT_PICK_WINDOW_MS. 100 = "treat as fully utilized" for
 * tiebreak purposes — large enough to override realistic upstream
 * utilization deltas (typically 0–95).
 */
const RECENT_PICK_PENALTY = 100;

/**
 * LeastUsedStrategy — picks the available account with the lowest effective
 * utilization, where effective utilization = upstream utilization + a
 * recency penalty for accounts picked in the last RECENT_PICK_WINDOW_MS.
 *
 * Without the recency penalty, N concurrent select() calls all evaluate
 * the same utilization snapshot and all pick the same lowest-util account,
 * funneling the burst into one upstream and triggering chained per-account
 * rate-limits — the exact failure mode this strategy is meant to avoid.
 * The penalty makes burst behavior approximately round-robin (each select
 * sees the previous pick as "recent" and deprioritizes it) while still
 * preferring the genuinely least-utilized account for sparse traffic.
 *
 * Trade-off vs SessionStrategy:
 *   - No prompt-cache stickiness: each request is routed independently of
 *     the previous one, so cross-request prompt caches on the upstream
 *     are less effective.
 *   - Better burst behavior: a sudden spike of N concurrent requests is
 *     spread across all healthy accounts rather than funneled into a
 *     single sticky account, reducing the probability of multiple
 *     accounts hitting per-account rate limits in near-simultaneity
 *     ("burst-cool" pool exhaustion).
 *
 * Use SessionStrategy when prompt-cache reuse is the primary cost driver
 * (long agentic loops with stable system prompts). Use LeastUsedStrategy
 * when burst tolerance and broad pool spread matter more than cache hits.
 */
export class LeastUsedStrategy implements LoadBalancingStrategy {
	private store: StrategyStore | null = null;
	private log = new Logger("LeastUsedStrategy");
	private lastPickedAt = new Map<string, number>();

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	peek(accounts: Account[]): string | null {
		const now = Date.now();
		// Use isPeekAvailable so accounts that select() would auto-unpause on its
		// next call (paused with safe pause_reason + auto_fallback + elapsed
		// window) surface as candidates here. Without this, peek() flags a
		// lower-priority account as Primary while real traffic goes to the
		// auto-unpaused higher-priority one.
		const available = accounts.filter((a) => isPeekAvailable(a, now));
		if (available.length === 0) return null;

		const scored = available.map((a) => {
			const util = this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(a.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { account: a, score: util + recencyPenalty };
		});

		scored.sort((a, b) => {
			if (a.account.priority !== b.account.priority) {
				return a.account.priority - b.account.priority;
			}
			return a.score - b.score;
		});

		return scored[0]?.account.id ?? null;
	}

	async select(accounts: Account[], meta: RequestMeta): Promise<Account[]> {
		const now = Date.now();
		const candidates = filterHardExcludedCandidates(
			zipStrategyCandidates(accounts, meta),
			meta,
		);

		// Auto-unpause eligible accounts whose upstream usage window has reset.
		// Mirrors SessionStrategy's checkForAutoFallbackAccounts path so users
		// who configured auto_fallback_enabled accounts get the same self-recovery
		// behaviour regardless of which strategy they pick.
		await this.autoUnpauseElapsedAccounts(
			candidates.map((candidate) => candidate.account),
			now,
		);

		const available = candidates.filter((candidate) =>
			isAccountAvailable(candidate.account, now),
		);
		if (available.length === 0) {
			return commitStrategyCandidateOrder([], meta);
		}

		// Score each account: priority is primary, then upstream utilization
		// plus a recency penalty for accounts picked in the recent window.
		// Treat null utilization as 0 so newly-added accounts (no usage data
		// yet) are preferred over fully-utilized ones.
		const scored = available.map((candidate) => {
			const { account } = candidate;
			const util =
				this.store?.getAccountUtilization?.(account.id, account.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(account.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { candidate, score: util + recencyPenalty };
		});

		const sorted = scored
			.sort((a, b) => {
				const routingOrder = compareStrategyCandidates(
					a.candidate,
					b.candidate,
					meta,
				);
				if (routingOrder !== 0) return routingOrder;
				return a.score - b.score;
			})
			.map((entry) => entry.candidate);

		// Mark the primary as recently picked so the *next* concurrent
		// select() within RECENT_PICK_WINDOW_MS prefers a different account.
		// Opportunistic GC: prune entries older than 10× the window so the
		// map doesn't grow unboundedly when accounts come and go.
		const primary = sorted[0];
		if (primary) this.lastPickedAt.set(primary.account.id, now);
		const gcThreshold = now - RECENT_PICK_WINDOW_MS * 10;
		for (const [id, ts] of this.lastPickedAt) {
			if (ts < gcThreshold) this.lastPickedAt.delete(id);
		}

		this.log.debug(
			`Selected ${sorted.length} account(s) by least-used (primary ${primary?.account.name ?? "none"}): ${sorted.map((candidate) => candidate.account.name).join(", ")}`,
		);

		return commitStrategyCandidateOrder(sorted, meta);
	}

	/**
	 * Auto-unpause any account that {@link wouldAutoUnpause} reports as
	 * eligible (auto_fallback_enabled + safe pause_reason + window elapsed).
	 *
	 * Mutates the in-memory account.paused flag to false only once the store
	 * confirms the resume actually happened (`resumed === true`), so the
	 * subsequent isAccountAvailable check never reflects a resume the DB
	 * refused (e.g. a blocked pause reason or a concurrent writer). Manual
	 * pauses (pause_reason='manual' or 'failure_threshold') are not touched.
	 *
	 * Stays in sync with SessionStrategy.select() via the shared predicate —
	 * keep changes there mirrored here.
	 */
	private async autoUnpauseElapsedAccounts(
		accounts: Account[],
		now: number,
	): Promise<void> {
		if (!this.store?.resumeAccount) return;

		for (const account of accounts) {
			if (!wouldAutoUnpause(account, now)) continue;

			this.log.info(
				`Auto-unpausing ${account.name} (pause_reason=${account.pause_reason ?? "null"}) — usage window has reset`,
			);
			const { resumed } = await this.store.resumeAccount(account.id);
			if (resumed) {
				account.paused = false;
			} else {
				this.log.info(
					`Store refused to resume ${account.name} — leaving it paused for this pass`,
				);
			}
		}
	}
}
