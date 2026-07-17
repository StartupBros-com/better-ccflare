import { isAccountAvailable, TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import { isPeekAvailable, wouldAutoUnpause } from "./peek-availability";
import {
	compareRoutingMetadata,
	filterHardExcludedAccounts,
	isSameRoutingClass,
} from "./routing-metadata";

/**
 * Window during which a freshly-picked account is deprioritized so that
 * concurrent NEW client-sessions rotate through the pool instead of all
 * landing on the same lowest-utilization candidate. Copied from
 * LeastUsedStrategy — see that file for the rationale.
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
 * Upper bound on live client→account affinity entries. `clientId` comes from
 * the request body (`metadata.user_id`), so an adversarial or buggy caller can
 * send a stream of distinct ids; the TTL-based GC only evicts *expired* entries
 * and gives no bound within the TTL window. When the map is full we evict the
 * least-recently-touched entry so memory stays bounded regardless of input.
 * Legitimate concurrent client-sessions are in the hundreds at most, far below
 * this; the cap only ever bites pathological input.
 */
const MAX_AFFINITY_ENTRIES = 10_000;

/**
 * SessionAffinityStrategy — a hybrid of SessionStrategy and LeastUsedStrategy.
 *
 * Routing is keyed on the *client* session id (request body
 * `metadata.user_id`, threaded through as {@link RequestMeta.clientSessionId}):
 *
 *   - The first request of a new client-session is routed to the least-loaded
 *     available account (same least-used scoring as LeastUsedStrategy, with the
 *     recency penalty so concurrently-starting sessions spread across the pool).
 *   - That client→account mapping is then made STICKY for `affinityTtlMs`, so
 *     every subsequent request from the same client keeps hitting the same
 *     upstream → prompt-cache affinity is preserved across the agentic loop.
 *
 * The result: many concurrent client-sessions are spread across all healthy
 * accounts (one account is no longer maxed before the next is touched, the
 * sequential-exhaustion failure mode of SessionStrategy), while each individual
 * session still keeps its cache locality (which per-request LeastUsedStrategy
 * throws away).
 *
 * Trade-off:
 *   - vs SessionStrategy: SessionStrategy tracks ONE account-level session and
 *     funnels ALL traffic to it until it rate-limits/expires, then rotates —
 *     maxing one account before the next. SessionAffinity instead pins each
 *     client to its own account, so N concurrent clients use up to N accounts.
 *   - vs LeastUsedStrategy: LeastUsed spreads every individual request and so
 *     loses prompt-cache reuse. SessionAffinity keeps a client glued to one
 *     account, trading some instantaneous load-evenness for cache hits.
 *
 * When the pinned account is temporarily unavailable, snapback is retained
 * only if its configured tier is strictly better than the fallback. Equal or
 * worse unavailable owners are replaced, as are routable owners outclassed by
 * a better tier (or comparable pressure class).
 */
export class SessionAffinityStrategy implements LoadBalancingStrategy {
	private affinityTtlMs: number;
	private maxAffinityEntries: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionAffinityStrategy");
	/** clientId → which account it is stuck to (and when it was last touched). */
	private affinity = new Map<
		string,
		{ accountId: string; assignedAt: number }
	>();
	/** accountId → last time it was freshly assigned to a NEW client-session. */
	private lastPickedAt = new Map<string, number>();

	constructor(
		affinityTtlMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
		maxAffinityEntries: number = MAX_AFFINITY_ENTRIES,
	) {
		this.affinityTtlMs = affinityTtlMs;
		this.maxAffinityEntries = maxAffinityEntries;
	}

	/** Live sticky-mapping count — read-only, for tests and ops metrics. */
	get affinityEntries(): number {
		return this.affinity.size;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	/**
	 * Rank accounts by least-used: priority ASC, then upstream utilization plus
	 * a recency penalty for accounts assigned in the last RECENT_PICK_WINDOW_MS.
	 * Identical scoring to LeastUsedStrategy.select() so the two strategies pick
	 * the same primary for a fresh session given the same state.
	 */
	private rankByLeastUsed(
		accounts: Account[],
		now: number,
		meta?: RequestMeta,
	): Account[] {
		const scored = accounts.map((a) => {
			const util = this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(a.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { account: a, score: util + recencyPenalty };
		});

		return scored
			.sort((a, b) => {
				const routingOrder = compareRoutingMetadata(a.account, b.account, meta);
				if (routingOrder !== 0) return routingOrder;
				return a.score - b.score;
			})
			.map((s) => s.account);
	}

	/**
	 * Rank available accounts least-used AND mark the chosen primary as
	 * recently-picked, so concurrent picks within RECENT_PICK_WINDOW_MS spread
	 * across the pool instead of converging on one account.
	 *
	 * Used by BOTH the new-session assignment and the failover path. The
	 * failover path MUST mark too: when many clients are pinned to a single
	 * downed account and fail over together, without the mark each one
	 * independently recomputes the same least-used backup and piles onto it —
	 * overloading the next account during exactly the partial-outage scenario
	 * where spreading matters most.
	 */
	private pickAndMark(
		available: Account[],
		now: number,
		meta?: RequestMeta,
	): Account[] {
		const ranked = this.rankByLeastUsed(available, now, meta);
		const chosen = ranked[0];
		if (chosen) {
			this.lastPickedAt.set(chosen.id, now);
			// Opportunistic GC of entries older than 10× the window.
			const gcThreshold = now - RECENT_PICK_WINDOW_MS * 10;
			for (const [id, ts] of this.lastPickedAt) {
				if (ts < gcThreshold) this.lastPickedAt.delete(id);
			}
		}
		return ranked;
	}

	/**
	 * Bound the affinity map: when it is full, evict the least-recently-touched
	 * entry (smallest assignedAt) before inserting a new one. O(n) only when at
	 * capacity, which only happens under pathological unique-clientId input.
	 */
	private evictOldestIfFull(): void {
		if (this.affinity.size < this.maxAffinityEntries) return;
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.affinity) {
			if (entry.assignedAt < oldestAt) {
				oldestAt = entry.assignedAt;
				oldestKey = key;
			}
		}
		if (oldestKey !== null) this.affinity.delete(oldestKey);
	}

	peek(accounts: Account[]): string | null {
		const now = Date.now();
		// Use isPeekAvailable so accounts that select() would auto-unpause on its
		// next call surface as candidates here, matching LeastUsedStrategy.peek().
		const available = accounts.filter((a) => isPeekAvailable(a, now));
		if (available.length === 0) return null;
		return this.rankByLeastUsed(available, now)[0]?.id ?? null;
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();
		const candidates = filterHardExcludedAccounts(accounts, meta);

		// Auto-unpause eligible accounts whose upstream usage window has reset.
		// Mirrors LeastUsedStrategy.autoUnpauseElapsedAccounts so users with
		// auto_fallback_enabled accounts get the same self-recovery behaviour
		// regardless of which strategy they pick.
		this.autoUnpauseElapsedAccounts(candidates, now);

		const available = candidates.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		// GC expired affinity entries so the map doesn't grow unboundedly and so
		// long-idle clients are re-balanced onto the currently least-loaded
		// account rather than re-pinned to a possibly-stale one.
		for (const [clientId, entry] of this.affinity) {
			if (now - entry.assignedAt >= this.affinityTtlMs) {
				this.affinity.delete(clientId);
			}
		}

		const laneKey = meta.affinityLaneKey ?? null;
		const clientId = meta.clientSessionId ?? null;
		const affinityKey =
			laneKey !== null
				? `lane:${laneKey}`
				: clientId !== null
					? `client:${clientId}`
					: null;

		// Existing, non-expired client-session: try to honour its sticky mapping.
		if (affinityKey !== null) {
			const mapping = this.affinity.get(affinityKey);
			if (mapping) {
				const mapped = available.find((a) => a.id === mapping.accountId);
				const ranked = this.rankByLeastUsed(available, now, meta);
				const best = ranked[0];
				if (mapped && best && isSameRoutingClass(mapped, best, meta)) {
					// STICKY hit: keep the client on its account (prompt-cache reuse).
					// Refresh assignedAt so an active session keeps its mapping alive.
					mapping.assignedAt = now;
					const others = this.rankByLeastUsed(
						available.filter((a) => a.id !== mapped.id),
						now,
						meta,
					);
					this.log.debug(
						`Sticky route ${affinityKey} → ${mapped.name} (${others.length} fallback(s))`,
					);
					return [mapped, ...others];
				}

				if (mapped && best) {
					// A routable better tier (or comparable higher-pressure class inside
					// the same tier) is authoritative and becomes the new sticky owner.
					const ordered = this.pickAndMark(available, now, meta);
					const replacement = ordered[0];
					if (replacement) {
						mapping.accountId = replacement.id;
						mapping.assignedAt = now;
					}
					this.log.info(
						`Route ${affinityKey} owner ${mapped.name} was outclassed — remapped to ${replacement?.name ?? best.name}`,
					);
					return ordered;
				}

				if (best) {
					const configuredOwnerTier =
						meta.routingCandidateCatalog?.find(
							(candidate) =>
								candidate.comboSlotId === null &&
								candidate.accountId === mapping.accountId,
						)?.tier ??
						accounts.find((account) => account.id === mapping.accountId)
							?.priority;
					const ordered = this.pickAndMark(available, now, meta);
					const fallback = ordered[0];
					const preserveForSnapback =
						configuredOwnerTier !== undefined &&
						configuredOwnerTier < best.priority;
					if (preserveForSnapback) {
						// Refresh while the client remains active so a legal temporary
						// failover does not expire the better-tier owner mapping.
						mapping.assignedAt = now;
						this.log.info(
							`Route ${affinityKey} better-tier owner ${mapping.accountId} is temporarily unavailable — preserving for snapback`,
						);
					} else if (fallback) {
						mapping.accountId = fallback.id;
						mapping.assignedAt = now;
						this.log.info(
							`Route ${affinityKey} unavailable equal/worse owner remapped to ${fallback.name}`,
						);
					}
					return ordered;
				}
			}
		}

		// New (or expired) client-session, or a request with no client id: assign
		// the least-loaded available account (marking it picked for spread) and
		// stick the client to it.
		const ranked = this.pickAndMark(available, now, meta);
		const chosen = ranked[0];

		if (affinityKey !== null && chosen) {
			this.evictOldestIfFull();
			this.affinity.set(affinityKey, {
				accountId: chosen.id,
				assignedAt: now,
			});
			this.log.debug(
				`Assigned route ${affinityKey} → ${chosen.name} (least-used)`,
			);
		}

		return ranked;
	}

	/**
	 * Auto-unpause any account that {@link wouldAutoUnpause} reports as eligible
	 * (auto_fallback_enabled + safe pause_reason + window elapsed). Mutates the
	 * in-memory account.paused flag to false on resume so the subsequent
	 * isAccountAvailable check reflects the new state.
	 *
	 * Stays in sync with SessionStrategy.select() and
	 * LeastUsedStrategy.autoUnpauseElapsedAccounts() via the shared predicate —
	 * keep changes there mirrored here.
	 */
	private autoUnpauseElapsedAccounts(accounts: Account[], now: number): void {
		if (!this.store?.resumeAccount) return;

		for (const account of accounts) {
			if (!wouldAutoUnpause(account, now)) continue;

			this.log.info(
				`Auto-unpausing ${account.name} (pause_reason=${account.pause_reason ?? "null"}) — usage window has reset`,
			);
			this.store.resumeAccount(account.id);
			account.paused = false;
		}
	}
}
