import {
	getSessionAffinityAntiThrashWindowMs,
	isAccountAvailable,
	minimumRoutableTier,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	RoutingCandidateFailureReport,
	RoutingCandidateSuccessReport,
	StrategyStore,
} from "@better-ccflare/types";
import { isPeekAvailable, wouldAutoUnpause } from "./peek-availability";
import {
	commitStrategyCandidateOrder,
	compareStrategyCandidates,
	filterHardExcludedCandidates,
	isSameStrategyCandidateClass,
	type StrategyCandidate,
	zipStrategyCandidates,
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
 * Hard cap for transient lane→candidate suppressions. A caller-controlled
 * lane key must not be able to grow process memory without bound.
 */
const MAX_ROUTE_SUPPRESSION_ENTRIES = 10_000;
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;
/** Cap repeated-failure growth at base × 16 until a proven success resets it. */
const MAX_ROUTE_FAILURE_BACKOFF_EXPONENT = 4;
const MAX_ROUTE_CONSECUTIVE_FAILURES = MAX_ROUTE_FAILURE_BACKOFF_EXPONENT + 1;
/** Forget inactive circuit history eventually while retaining half-open state. */
const ROUTE_FAILURE_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Amortize retained-state sweeping off the per-request hot path. */
const ROUTE_FAILURE_GC_INTERVAL_MS = 60 * 1000;
/**
 * A half-open request may disappear without reporting success or failure (for
 * example, a client disconnect). Keep its single-flight lease longer than the
 * proxy's bounded Anthropic commitment window, then permit one replacement
 * probe so a lost reporter cannot wedge the lane forever.
 */
const ROUTE_HALF_OPEN_PROBE_LEASE_MS = 10 * 60 * 1000;

interface RouteFailureState {
	affinityKey: string;
	candidateId: string;
	reason: string;
	reportedAt: number;
	expiresAt: number;
	baseSuppressForMs: number;
	consecutiveFailures: number;
	/** Earliest ordinary half-open retry after the current backoff. */
	nextProbeAt: number;
	/** One in-flight half-open probe for this exact lane candidate. */
	probeLeaseUntil: number | null;
	/** One bounded early probe when every candidate in the lane is open. */
	earlyProbeAvailable: boolean;
}

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
 *
 * Anti-thrash (R13): once a session's mapping is upgraded to a better tier,
 * if that new owner fails (rate-limited/paused) within `antiThrashWindowMs`
 * of the upgrade, further upgrades for the session are suppressed for the
 * remainder of the window instead of re-attempting the flapping owner on
 * every recovery. The deterministic FIRST upgrade for a session is never
 * suppressed. Suppression is scoped per-session (per affinity-map entry),
 * never global, and does not apply to request-scoped hard exclusions:
 * only genuine account-level unavailability counts as a "failure".
 */
export class SessionAffinityStrategy implements LoadBalancingStrategy {
	private affinityTtlMs: number;
	private maxAffinityEntries: number;
	private antiThrashWindowMs: number;
	private maxRouteSuppressionEntries: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionAffinityStrategy");
	/** clientId → which account it is stuck to (and when it was last touched). */
	private affinity = new Map<
		string,
		{
			candidateId: string;
			assignedAt: number;
			/** When the current candidateId was last installed via an upgrade
			 * (branch: outclassed remap), or null if it was a fresh assignment or
			 * a plain (non-upgrade) failover remap. */
			upgradedAt: number | null;
			/** If set and still in the future, further upgrades are suppressed
			 * (anti-thrash) until this timestamp. */
			suppressUpgradesUntil: number | null;
		}
	>();
	/** accountId → last time it was freshly assigned to a NEW client-session. */
	private lastPickedAt = new Map<string, number>();
	/** Exact lane+candidate circuit state; never promoted to account health. */
	private routeFailureStates = new Map<string, RouteFailureState>();
	private nextRouteFailureGcAt = Number.NEGATIVE_INFINITY;
	private routeFailureGcSweepCount = 0;

	constructor(
		affinityTtlMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
		maxAffinityEntries: number = MAX_AFFINITY_ENTRIES,
		antiThrashWindowMs: number = getSessionAffinityAntiThrashWindowMs(),
		maxRouteSuppressionEntries: number = MAX_ROUTE_SUPPRESSION_ENTRIES,
		private readonly now: () => number = Date.now,
	) {
		this.affinityTtlMs = affinityTtlMs;
		this.maxAffinityEntries = maxAffinityEntries;
		this.antiThrashWindowMs = antiThrashWindowMs;
		this.maxRouteSuppressionEntries = maxRouteSuppressionEntries;
	}

	/** Live sticky-mapping count — read-only, for tests and ops metrics. */
	get affinityEntries(): number {
		return this.affinity.size;
	}

	/** Retained lane-scoped candidate circuit count — read-only for tests/ops. */
	get routeSuppressionEntries(): number {
		return this.routeFailureStates.size;
	}

	/** Amortized full-sweep count — useful for tests and runtime diagnostics. */
	get routeSuppressionGcSweeps(): number {
		return this.routeFailureGcSweepCount;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	private affinityKey(meta: RequestMeta): string | null {
		const laneKey = meta.affinityLaneKey ?? null;
		if (laneKey !== null) return `lane:${laneKey}`;
		const clientId = meta.clientSessionId ?? null;
		return clientId !== null ? `client:${clientId}` : null;
	}

	private routeSuppressionKey(
		affinityKey: string,
		candidateId: string,
	): string {
		// JSON tuple encoding prevents separator collisions in caller-controlled ids.
		return JSON.stringify([affinityKey, candidateId]);
	}

	private gcStaleRouteFailureStates(now: number): void {
		if (now < this.nextRouteFailureGcAt) return;
		this.routeFailureGcSweepCount++;
		this.nextRouteFailureGcAt = Math.min(
			MAX_DATE_TIME_MS,
			now + ROUTE_FAILURE_GC_INTERVAL_MS,
		);
		for (const [key, state] of this.routeFailureStates) {
			if (
				now >= state.expiresAt &&
				now - state.reportedAt >= ROUTE_FAILURE_STATE_RETENTION_MS
			) {
				this.routeFailureStates.delete(key);
			}
		}
	}

	private evictOldestRouteSuppressionIfFull(): void {
		if (this.routeFailureStates.size < this.maxRouteSuppressionEntries) return;
		const oldestKey = this.routeFailureStates.keys().next().value;
		if (oldestKey !== undefined) this.routeFailureStates.delete(oldestKey);
	}

	reportCandidateFailure(
		meta: RequestMeta,
		failure: RoutingCandidateFailureReport,
	): void {
		const affinityKey = this.affinityKey(meta);
		if (
			affinityKey === null ||
			failure.candidateId.length === 0 ||
			!Number.isFinite(failure.suppressForMs) ||
			failure.suppressForMs <= 0 ||
			this.maxRouteSuppressionEntries <= 0
		) {
			return;
		}

		const now = this.now();
		this.gcStaleRouteFailureStates(now);
		const key = this.routeSuppressionKey(affinityKey, failure.candidateId);
		const previous = this.routeFailureStates.get(key);
		if (!previous) {
			this.evictOldestRouteSuppressionIfFull();
		} else {
			// Map iteration order is the reported-at order used for O(1) eviction.
			// Updating in place would retain the old insertion position, so move the
			// refreshed state to the newest slot explicitly before replacing it.
			this.routeFailureStates.delete(key);
		}
		const consecutiveFailures = Math.min(
			MAX_ROUTE_CONSECUTIVE_FAILURES,
			(previous?.consecutiveFailures ?? 0) + 1,
		);
		const baseSuppressForMs = Math.max(
			previous?.baseSuppressForMs ?? 0,
			Math.max(1, Math.floor(failure.suppressForMs)),
		);
		const backoffMultiplier =
			2 **
			Math.min(consecutiveFailures - 1, MAX_ROUTE_FAILURE_BACKOFF_EXPONENT);
		const openForMs = Math.min(
			MAX_DATE_TIME_MS - now,
			baseSuppressForMs * backoffMultiplier,
		);
		const expiresAt = Math.min(MAX_DATE_TIME_MS, now + openForMs);
		this.routeFailureStates.set(key, {
			affinityKey,
			candidateId: failure.candidateId,
			reason: failure.reason,
			reportedAt: now,
			expiresAt,
			baseSuppressForMs,
			consecutiveFailures,
			nextProbeAt: expiresAt,
			probeLeaseUntil: null,
			earlyProbeAvailable: previous === undefined,
		});
		this.log.info("Route candidate circuit opened", {
			candidateId: failure.candidateId,
			reason: failure.reason,
			expiresAt: new Date(expiresAt).toISOString(),
			consecutiveFailures,
			openForMs,
			routeSuppressionCount: this.routeFailureStates.size,
			affinityLanePresent: meta.affinityLaneKey != null,
		});
	}

	reportCandidateSuccess(
		meta: RequestMeta,
		success: RoutingCandidateSuccessReport,
	): void {
		const affinityKey = this.affinityKey(meta);
		if (affinityKey === null || success.candidateId.length === 0) return;

		const key = this.routeSuppressionKey(affinityKey, success.candidateId);
		if (!this.routeFailureStates.delete(key)) return;
		this.log.info("Route candidate circuit closed after complete success", {
			candidateId: success.candidateId,
			routeSuppressionCount: this.routeFailureStates.size,
			affinityLanePresent: meta.affinityLaneKey != null,
		});
	}

	private routeFailureState(
		affinityKey: string,
		candidateId: string,
	): RouteFailureState | undefined {
		return this.routeFailureStates.get(
			this.routeSuppressionKey(affinityKey, candidateId),
		);
	}

	private acquireHalfOpenProbe(
		candidates: StrategyCandidate[],
		affinityKey: string,
		now: number,
		allowEarlyProbe: boolean,
		isEligibleCandidate: (candidate: StrategyCandidate) => boolean = () => true,
		compareEligibleCandidates?: (
			a: StrategyCandidate,
			b: StrategyCandidate,
		) => number,
	): StrategyCandidate | null {
		const candidateStates = candidates.flatMap((candidate) => {
			const state = this.routeFailureState(
				affinityKey,
				candidate.routing.candidateId,
			);
			return state ? [{ candidate, state }] : [];
		});
		if (
			candidateStates.some(
				({ state }) =>
					state.probeLeaseUntil !== null && now < state.probeLeaseUntil,
			)
		) {
			return null;
		}

		const eligible = candidateStates.filter(
			({ candidate, state }) =>
				isEligibleCandidate(candidate) &&
				(now >= state.nextProbeAt ||
					(allowEarlyProbe && state.earlyProbeAvailable)),
		);
		const selected = [...eligible].sort((a, b) => {
			const candidateOrder = compareEligibleCandidates?.(
				a.candidate,
				b.candidate,
			);
			if (candidateOrder !== undefined && candidateOrder !== 0) {
				return candidateOrder;
			}
			const stateA = a.state;
			const stateB = b.state;
			const expiryOrder = stateA.expiresAt - stateB.expiresAt;
			if (expiryOrder !== 0) return expiryOrder;
			const ageOrder = stateA.reportedAt - stateB.reportedAt;
			if (ageOrder !== 0) return ageOrder;
			const ordinalOrder =
				a.candidate.routing.ordinal - b.candidate.routing.ordinal;
			if (ordinalOrder !== 0) return ordinalOrder;
			return a.candidate.routing.candidateId.localeCompare(
				b.candidate.routing.candidateId,
			);
		})[0];
		if (!selected) return null;

		const leaseUntil = Math.min(
			MAX_DATE_TIME_MS,
			now + ROUTE_HALF_OPEN_PROBE_LEASE_MS,
		);
		selected.state.probeLeaseUntil = leaseUntil;
		selected.state.nextProbeAt = Math.min(
			selected.state.nextProbeAt,
			leaseUntil,
		);
		selected.state.earlyProbeAvailable = false;
		return selected.candidate;
	}

	/**
	 * Rank accounts by least-used: priority ASC, then upstream utilization plus
	 * a recency penalty for accounts assigned in the last RECENT_PICK_WINDOW_MS.
	 * Identical scoring to LeastUsedStrategy.select() so the two strategies pick
	 * the same primary for a fresh session given the same state.
	 */
	private rankByLeastUsed(
		candidates: StrategyCandidate[],
		now: number,
		meta?: RequestMeta,
	): StrategyCandidate[] {
		const scored = candidates.map((candidate) => {
			const { account } = candidate;
			const util =
				this.store?.getAccountUtilization?.(account.id, account.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(account.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { candidate, score: util + recencyPenalty };
		});

		return scored
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
		available: StrategyCandidate[],
		now: number,
		meta?: RequestMeta,
	): StrategyCandidate[] {
		const ranked = this.rankByLeastUsed(available, now, meta);
		const chosen = ranked[0];
		if (chosen) {
			this.lastPickedAt.set(chosen.account.id, now);
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
		const now = this.now();
		// Use isPeekAvailable so accounts that select() would auto-unpause on its
		// next call surface as candidates here, matching LeastUsedStrategy.peek().
		const available = accounts.filter((a) => isPeekAvailable(a, now));
		if (available.length === 0) return null;
		return (
			this.rankByLeastUsed(zipStrategyCandidates(available), now)[0]?.account
				.id ?? null
		);
	}

	async select(accounts: Account[], meta: RequestMeta): Promise<Account[]> {
		const now = this.now();
		this.gcStaleRouteFailureStates(now);
		const affinityKey = this.affinityKey(meta);
		const configuredCandidates = zipStrategyCandidates(accounts, meta);
		const candidates = filterHardExcludedCandidates(configuredCandidates, meta);

		// Auto-unpause eligible accounts whose upstream usage window has reset.
		// Mirrors LeastUsedStrategy.autoUnpauseElapsedAccounts so users with
		// auto_fallback_enabled accounts get the same self-recovery behaviour
		// regardless of which strategy they pick.
		await this.autoUnpauseElapsedAccounts(
			candidates.map((candidate) => candidate.account),
			now,
		);

		const otherwiseAvailable = candidates.filter((candidate) =>
			isAccountAvailable(candidate.account, now),
		);
		if (otherwiseAvailable.length === 0) {
			return commitStrategyCandidateOrder([], meta);
		}

		let available = otherwiseAvailable;
		let forcedPriorityProbe: StrategyCandidate | null = null;
		let forcedPriorityFallbacks: StrategyCandidate[] = [];
		if (affinityKey !== null) {
			const closedCandidates = otherwiseAvailable.filter(
				(candidate) =>
					this.routeFailureState(affinityKey, candidate.routing.candidateId) ===
					undefined,
			);
			const circuitCandidates = otherwiseAvailable.filter(
				(candidate) =>
					this.routeFailureState(affinityKey, candidate.routing.candidateId) !==
					undefined,
			);
			const rankedClosedCandidates = this.rankByLeastUsed(
				closedCandidates,
				now,
				meta,
			);
			const bestClosedCandidate = rankedClosedCandidates[0];
			const mapping = this.affinity.get(affinityKey);
			const upgradeSuppressed =
				mapping !== undefined &&
				now - mapping.assignedAt < this.affinityTtlMs &&
				mapping.suppressUpgradesUntil !== null &&
				now < mapping.suppressUpgradesUntil;

			// A recovered better routing class must get one real chance to reclaim its
			// configured priority. Lease it only when it will be returned as the first
			// executable attempt, with every healthy closed route retained behind it.
			// Equal/worse circuits stay dormant while a better-or-equal closed route is
			// available, preserving stickiness and preventing phantom probe leases.
			if (bestClosedCandidate && !upgradeSuppressed) {
				forcedPriorityProbe = this.acquireHalfOpenProbe(
					circuitCandidates,
					affinityKey,
					now,
					false,
					(candidate) =>
						compareStrategyCandidates(candidate, bestClosedCandidate, meta) < 0,
					(a, b) => compareStrategyCandidates(a, b, meta),
				);
				if (forcedPriorityProbe) {
					forcedPriorityFallbacks = rankedClosedCandidates;
				}
			}

			// With no healthy closed route, preserve the deterministic all-open single
			// probe. This is the only path allowed to consume a first-failure early
			// probe before its ordinary backoff boundary.
			const allOpenProbe =
				closedCandidates.length === 0
					? this.acquireHalfOpenProbe(circuitCandidates, affinityKey, now, true)
					: null;
			// If every route is circuit-open and no probe can be leased, preserve
			// the strategy's existing [] no-route contract. The proxy returns its
			// retryable 503 instead of letting concurrent retries stampede a route
			// already proven unhealthy.
			available = allOpenProbe ? [allOpenProbe] : closedCandidates;
			if (closedCandidates.length === 0 && circuitCandidates.length > 0) {
				this.log.info(
					allOpenProbe
						? "Every available route candidate circuit is open; probing one"
						: "Every available route candidate circuit is open; probe already leased or backing off",
					{
						candidateId: allOpenProbe?.routing.candidateId ?? null,
						availableCandidateCount: otherwiseAvailable.length,
						routeSuppressionCount: this.routeFailureStates.size,
						affinityLanePresent: meta.affinityLaneKey != null,
					},
				);
			}
		}

		// GC expired affinity entries so the map doesn't grow unboundedly and so
		// long-idle clients are re-balanced onto the currently least-loaded
		// account rather than re-pinned to a possibly-stale one.
		for (const [clientId, entry] of this.affinity) {
			if (now - entry.assignedAt >= this.affinityTtlMs) {
				this.affinity.delete(clientId);
			}
		}

		if (forcedPriorityProbe) {
			this.log.info(
				"Expired higher-priority route circuit selected for a half-open probe",
				{
					candidateId: forcedPriorityProbe.routing.candidateId,
					fallbackCount: forcedPriorityFallbacks.length,
					affinityLanePresent: meta.affinityLaneKey != null,
				},
			);
			return commitStrategyCandidateOrder(
				[forcedPriorityProbe, ...forcedPriorityFallbacks],
				meta,
			);
		}

		// Existing, non-expired client-session: try to honour its sticky mapping.
		if (affinityKey !== null) {
			const mapping = this.affinity.get(affinityKey);
			if (mapping) {
				const mapped = available.find(
					(candidate) => candidate.routing.candidateId === mapping.candidateId,
				);
				const ranked = this.rankByLeastUsed(available, now, meta);
				const best = ranked[0];
				if (
					mapped &&
					best &&
					isSameStrategyCandidateClass(mapped, best, meta)
				) {
					// STICKY hit: keep the client on its account (prompt-cache reuse).
					// Refresh assignedAt so an active session keeps its mapping alive.
					mapping.assignedAt = now;
					const others = this.rankByLeastUsed(
						available.filter(
							(candidate) =>
								candidate.routing.candidateId !== mapped.routing.candidateId,
						),
						now,
						meta,
					);
					this.log.debug("Sticky route selected", {
						candidateId: mapped.routing.candidateId,
						fallbackCount: others.length,
						affinityLanePresent: meta.affinityLaneKey != null,
					});
					return commitStrategyCandidateOrder([mapped, ...others], meta);
				}

				if (mapped && best) {
					const suppressed =
						mapping.suppressUpgradesUntil !== null &&
						now < mapping.suppressUpgradesUntil;
					if (suppressed) {
						// Anti-thrash: this session's mapping was upgraded recently and
						// the new owner failed inside the window. Hold the current
						// (worse-tier) owner steady for the remainder of the window
						// instead of re-attempting the flapping better tier on every
						// recovery.
						mapping.assignedAt = now;
						const others = this.rankByLeastUsed(
							available.filter(
								(candidate) =>
									candidate.routing.candidateId !== mapped.routing.candidateId,
							),
							now,
							meta,
						);
						this.log.info("Route upgrade suppressed by anti-thrash window", {
							upgradeCandidateId: best.routing.candidateId,
							currentCandidateId: mapped.routing.candidateId,
							suppressUpgradesUntil: new Date(
								mapping.suppressUpgradesUntil as number,
							).toISOString(),
							affinityLanePresent: meta.affinityLaneKey != null,
						});
						return commitStrategyCandidateOrder(
							[mapped, ...others],
							meta,
							best.routing.candidateId,
						);
					}

					// A routable better tier (or comparable higher-pressure class inside
					// the same tier) is authoritative and becomes the new sticky owner.
					const ordered = this.pickAndMark(available, now, meta);
					const replacement = ordered[0];
					if (replacement) {
						mapping.candidateId = replacement.routing.candidateId;
						mapping.assignedAt = now;
						mapping.upgradedAt = now;
						mapping.suppressUpgradesUntil = null;
					}
					this.log.info("Outclassed route owner remapped", {
						candidateId:
							replacement?.routing.candidateId ?? best.routing.candidateId,
						affinityLanePresent: meta.affinityLaneKey != null,
					});
					return commitStrategyCandidateOrder(ordered, meta);
				}

				if (best) {
					const configuredOwnerTier =
						meta.routingCandidateCatalog?.find(
							(candidate) => candidate.candidateId === mapping.candidateId,
						)?.tier ??
						configuredCandidates.find(
							(candidate) =>
								candidate.routing.candidateId === mapping.candidateId,
						)?.routing.tier;
					const ordered = this.pickAndMark(available, now, meta);
					const fallback = ordered[0];
					const bestTier =
						minimumRoutableTier(
							available.map((candidate) => candidate.routing.tier),
						) ?? best.routing.tier;

					// Anti-thrash fast-fail detection (R13): only genuine account-level
					// unavailability counts as a "failure": the mapped owner is still
					// structurally eligible (survived request-scoped hard exclusion) but
					// absent from `available` (rate-limited/paused). A hard exclusion or
					// a deleted account is not a flapping upstream and must not arm
					// suppression.
					//
					// Structural eligibility must be read from
					// `routingCandidateCatalog` (every configured candidate, independent
					// of transient availability) rather than `candidates`: combo routing
					// pre-filters paused/rate-limited slots out of `candidates` in
					// account-selector.ts before the strategy ever runs, so a combo
					// owner that just failed would otherwise look structurally removed
					// and never arm suppression. `candidates` remains the fallback for
					// callers that never populate a catalog.
					const catalog = meta.routingCandidateCatalog;
					const stillConfigured = catalog
						? catalog.some(
								(candidate) =>
									candidate.candidateId === mapping.candidateId &&
									!meta.hardExcludedAccountIds?.has(candidate.accountId),
							)
						: candidates.some(
								(candidate) =>
									candidate.routing.candidateId === mapping.candidateId,
							);
					const upgradedAt = mapping.upgradedAt;
					const recentlyUpgraded =
						upgradedAt !== null && now - upgradedAt < this.antiThrashWindowMs;
					const fastFailAfterUpgrade = stillConfigured && recentlyUpgraded;

					if (fastFailAfterUpgrade && upgradedAt !== null) {
						// The owner this session was just upgraded to has already failed:
						// arm suppression for the remainder of the window (measured from
						// the original upgrade) and settle on the fallback instead of
						// preserving/snapping back to the flapping owner.
						mapping.suppressUpgradesUntil =
							upgradedAt + this.antiThrashWindowMs;
						if (fallback) {
							mapping.candidateId = fallback.routing.candidateId;
							mapping.assignedAt = now;
							mapping.upgradedAt = null;
							this.log.info(
								"Upgraded route owner failed inside anti-thrash window",
								{
									candidateId: fallback.routing.candidateId,
									suppressUpgradesUntil: new Date(
										mapping.suppressUpgradesUntil,
									).toISOString(),
									affinityLanePresent: meta.affinityLaneKey != null,
								},
							);
						}
						return commitStrategyCandidateOrder(ordered, meta);
					}

					const preserveForSnapback =
						configuredOwnerTier !== undefined && configuredOwnerTier < bestTier;
					if (preserveForSnapback) {
						// Refresh while the client remains active so a legal temporary
						// failover does not expire the better-tier owner mapping.
						mapping.assignedAt = now;
						this.log.info(
							"Better-tier route owner unavailable; preserving for snapback",
							{
								candidateId: mapping.candidateId,
								affinityLanePresent: meta.affinityLaneKey != null,
							},
						);
					} else if (fallback) {
						mapping.candidateId = fallback.routing.candidateId;
						mapping.assignedAt = now;
						mapping.upgradedAt = null;
						this.log.info("Unavailable equal/worse route owner remapped", {
							candidateId: fallback.routing.candidateId,
							affinityLanePresent: meta.affinityLaneKey != null,
						});
					}
					return commitStrategyCandidateOrder(ordered, meta);
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
				candidateId: chosen.routing.candidateId,
				assignedAt: now,
				upgradedAt: null,
				suppressUpgradesUntil: null,
			});
			this.log.debug("Least-used route owner assigned", {
				candidateId: chosen.routing.candidateId,
				affinityLanePresent: meta.affinityLaneKey != null,
			});
		}

		return commitStrategyCandidateOrder(ranked, meta);
	}

	/**
	 * Auto-unpause any account that {@link wouldAutoUnpause} reports as eligible
	 * (auto_fallback_enabled + safe pause_reason + window elapsed). Mutates the
	 * in-memory account.paused flag to false only once the store confirms the
	 * resume actually happened (`resumed === true`), so the subsequent
	 * isAccountAvailable check never reflects a resume the DB refused.
	 *
	 * Stays in sync with SessionStrategy.select() and
	 * LeastUsedStrategy.autoUnpauseElapsedAccounts() via the shared predicate —
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
