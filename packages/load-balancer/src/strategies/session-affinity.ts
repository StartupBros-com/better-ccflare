import {
	getSessionAffinityAntiThrashWindowMs,
	isAccountAvailable,
	minimumRoutableTier,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	AffinityOwnerSnapshot,
	LoadBalancingStrategy,
	RequestMeta,
	RouteCircuitRecoveryHint,
	RouteHomeAction,
	RoutingCandidateFailureReport,
	RoutingCandidateSuccessReport,
	RoutingHealth,
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

interface RouteCircuitSelection {
	/** Exact viable candidate ids observed during the owning select call. */
	candidateIds: readonly string[];
}

interface SessionAffinityEntry {
	/** Preferred/current owner retained for ordinary stickiness and snapback. */
	candidateId: string;
	/** Backing account identity, distinct from a combo candidate identity. */
	accountId: string;
	/**
	 * Temporary owner used while a strictly-better preferred owner is absent.
	 * Kept separately so fallback turns stay cache-sticky without forfeiting the
	 * preferred owner's immediate recovery/probe semantics.
	 */
	fallbackCandidateId: string | null;
	assignedAt: number;
	/** When the current candidateId was last installed via an upgrade. */
	upgradedAt: number | null;
	/** If set, further upgrades are suppressed until this timestamp. */
	suppressUpgradesUntil: number | null;
	/**
	 * True iff, at the moment `candidateId` was last installed, its routing
	 * tier was strictly worse than the best (minimum) tier among the
	 * request's CONFIGURED candidates -- i.e. the owner was installed as a
	 * displaced fallback while something better was configured but not
	 * currently routable (down/rate-limited/absent-this-request).
	 *
	 * False means the owner was installed "at home": at the best configured
	 * tier available to the request. A later cross-tier outclass (a priority
	 * edit, or a higher-priority account appearing) must never remap an
	 * at-home owner -- only a displaced owner is eligible to keep chasing a
	 * better tier. See the class doc comment for the full invariant.
	 */
	installedBelowBestConfiguredTier: boolean;
	/**
	 * Set once an at-home owner has been protected from a cross-tier
	 * outclass and the protection has been logged at info level for this
	 * episode. Reset to false on an ordinary sticky hit or any remap, so the
	 * next distinct protection episode logs at info again instead of
	 * spamming info on every request of a long-lived protected session.
	 */
	crossTierProtectionLogged: boolean;
}

/** Process-lifetime scalar counters shared across hot strategy replacement. */
export class RoutingTransitionRecorder {
	private atHomeProtectionCount = 0;
	private crossTierOutclassRemapCount = 0;
	private sameTierOutclassRemapCount = 0;
	private failoverRemapCount = 0;
	private snapbackPreservationCount = 0;

	recordAtHomeProtection(): void {
		this.atHomeProtectionCount++;
	}

	recordCrossTierOutclassRemap(): void {
		this.crossTierOutclassRemapCount++;
	}

	recordSameTierOutclassRemap(): void {
		this.sameTierOutclassRemapCount++;
	}

	recordFailoverRemap(): void {
		this.failoverRemapCount++;
	}

	recordSnapbackPreservation(): void {
		this.snapbackPreservationCount++;
	}

	snapshot(): RoutingHealth["transitions"] {
		return {
			atHomeProtections: this.atHomeProtectionCount,
			outclassRemaps: {
				crossTier: this.crossTierOutclassRemapCount,
				sameTier: this.sameTierOutclassRemapCount,
			},
			failoverRemaps: this.failoverRemapCount,
			snapbackPreservations: this.snapbackPreservationCount,
		};
	}
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
 * a better tier (or comparable pressure class) -- subject to the at-home
 * guard below.
 *
 * At-home guard (cross-tier outclass): a healthy owner that was installed AT
 * the request's best-CONFIGURED tier ("at home") is never remapped by a
 * later cross-tier outclass -- an operator priority edit or a newly-added
 * higher-priority account must not silently move a live session mid-
 * conversation and abandon its prompt-cache prefix. The at-home owner keeps
 * the session (ranked first, others behind it) until it becomes unavailable
 * or the session idles out past the TTL. An owner installed while a strictly
 * better tier was CONFIGURED for the request but not currently routable (a
 * genuine displaced fallback, e.g. during an outage) is NOT at home, and
 * still upgrades home once that better tier recovers -- today's behavior,
 * unchanged. Every failover, snapback, anti-thrash suppression, and forced
 * priority probe path is also unchanged: an unavailable owner (at-home or
 * not) still fails over immediately. Only a same-request, cross-TIER
 * outclass of a healthy owner is gated; same-tier pressure-band outclass
 * remaps are unaffected.
 *
 * Anti-thrash (R13): once a session's mapping is upgraded to a better tier,
 * if that new owner fails (rate-limited/paused) within `antiThrashWindowMs`
 * of the upgrade, further upgrades for the session are suppressed for the
 * remainder of the window instead of re-attempting the flapping owner on
 * every recovery. The deterministic FIRST upgrade for a session is never
 * suppressed. Suppression is scoped per-session (per affinity-map entry),
 * never global, and does not apply to request-scoped hard exclusions:
 * only genuine account-level unavailability counts as a "failure". This is
 * orthogonal to the at-home guard above: anti-thrash governs a session that
 * HAS just upgraded and had that upgrade fail, while the at-home guard
 * governs a session that never left its best-configured tier in the first
 * place.
 */
export class SessionAffinityStrategy implements LoadBalancingStrategy {
	private affinityTtlMs: number;
	private maxAffinityEntries: number;
	private antiThrashWindowMs: number;
	private maxRouteSuppressionEntries: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionAffinityStrategy");
	/** Affinity lane → preferred/current owner plus any temporary fallback. */
	private affinity = new Map<string, SessionAffinityEntry>();
	/** accountId → last time it was freshly assigned to a NEW client-session. */
	private lastPickedAt = new Map<string, number>();
	/** Exact lane+candidate circuit state; never promoted to account health. */
	private routeFailureStates = new Map<string, RouteFailureState>();
	/** Request-local view used to expose finite circuit recovery at termination. */
	private routeCircuitSelections = new WeakMap<
		RequestMeta,
		RouteCircuitSelection
	>();
	private nextRouteFailureGcAt = Number.NEGATIVE_INFINITY;
	private routeFailureGcSweepCount = 0;

	constructor(
		affinityTtlMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
		maxAffinityEntries: number = MAX_AFFINITY_ENTRIES,
		antiThrashWindowMs: number = getSessionAffinityAntiThrashWindowMs(),
		maxRouteSuppressionEntries: number = MAX_ROUTE_SUPPRESSION_ENTRIES,
		private readonly now: () => number = Date.now,
		private readonly routingTransitions: RoutingTransitionRecorder = new RoutingTransitionRecorder(),
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

	getRoutingHealth(): RoutingHealth {
		return {
			affinityEntries: this.affinityEntries,
			routeSuppressionEntries: this.routeSuppressionEntries,
			routeSuppressionGcSweeps: this.routeSuppressionGcSweeps,
			transitions: this.routingTransitions.snapshot(),
		};
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

	/** Strategy variants may suppress ordinary stickiness without disabling route circuits. */
	protected selectionAffinityKey(meta: RequestMeta): string | null {
		return this.affinityKey(meta);
	}

	private isDescendantHomeRequest(meta: RequestMeta): boolean {
		return (
			meta.routeLineage?.kind === "descendant" &&
			Boolean(meta.routeLineage.childHomeKey)
		);
	}

	/** The minimum tier in a set, or null for an empty input. */
	private minimumConfiguredTier(tiers: Iterable<number>): number | null {
		let min: number | null = null;
		for (const tier of tiers) {
			if (min === null || tier < min) min = tier;
		}
		return min;
	}

	/**
	 * Best (lowest) tier CONFIGURED on `meta.routingCandidateCatalog` alone,
	 * hard-exclusion filtered, or null when no catalog is present. Split out
	 * from {@link bestConfiguredTier} so `commitAffinityOwner` -- which has
	 * no candidates list to fall back on -- can use the catalog-only half.
	 */
	private bestCatalogConfiguredTier(meta: RequestMeta): number | null {
		const catalog = meta.routingCandidateCatalog;
		if (!catalog) return null;
		return this.minimumConfiguredTier(
			catalog
				.filter(
					(candidate) => !meta.hardExcludedAccountIds?.has(candidate.accountId),
				)
				.map((candidate) => candidate.tier),
		);
	}

	/**
	 * Best (lowest) tier CONFIGURED for this request, independent of live
	 * availability. Source mirrors the R13 `stillConfigured` preference
	 * below: prefer `meta.routingCandidateCatalog` (complete even when combo
	 * pre-filtering already dropped rate-limited/paused slots out of
	 * `candidates` before the strategy ran); otherwise fall back to the
	 * hard-exclusion-filtered configured candidate list, which in the plain
	 * (non-combo) path still INCLUDES rate-limited/paused accounts -- that is
	 * why `isAccountAvailable` filtering and `autoUnpauseElapsedAccounts`
	 * live inside `select()` rather than upstream of it.
	 *
	 * Deliberately NOT `@better-ccflare/core`'s `minimumRoutableTier`: that
	 * helper only ever sees candidates already filtered down to currently
	 * routable ones. Reusing it here over CONFIGURED (possibly unavailable)
	 * candidates would misreport a rate-limited best tier as "not
	 * configured" and mark every genuinely displaced owner as at-home.
	 */
	private bestConfiguredTier(
		meta: RequestMeta,
		candidates: StrategyCandidate[],
	): number | null {
		if (meta.routingCandidateCatalog) {
			return this.bestCatalogConfiguredTier(meta);
		}
		return this.minimumConfiguredTier(
			candidates.map((candidate) => candidate.routing.tier),
		);
	}

	/**
	 * Whether installing `candidate` right now would count as "installed
	 * below the best configured tier" (a displaced fallback) rather than "at
	 * home". See {@link SessionAffinityEntry.installedBelowBestConfiguredTier}.
	 */
	private computeInstalledBelowBestConfiguredTier(
		candidate: StrategyCandidate,
		meta: RequestMeta,
		candidates: StrategyCandidate[],
	): boolean {
		const bestTier = this.bestConfiguredTier(meta, candidates);
		return bestTier !== null && candidate.routing.tier > bestTier;
	}

	snapshotAffinityOwner(meta: RequestMeta): AffinityOwnerSnapshot | null {
		const affinityKey = this.affinityKey(meta);
		if (affinityKey === null) return null;
		const mapping = this.affinity.get(affinityKey);
		if (!mapping || this.now() - mapping.assignedAt >= this.affinityTtlMs) {
			return null;
		}
		return {
			candidateId: mapping.candidateId,
			accountId: mapping.accountId,
		};
	}

	commitAffinityOwner(
		meta: RequestMeta,
		owner: AffinityOwnerSnapshot,
	): boolean {
		const affinityKey = this.affinityKey(meta);
		if (
			affinityKey === null ||
			owner.candidateId.length === 0 ||
			owner.accountId.length === 0 ||
			meta.hardExcludedAccountIds?.has(owner.accountId)
		) {
			return false;
		}
		const now = this.now();
		const existing = this.affinity.get(affinityKey);
		if (existing && now - existing.assignedAt < this.affinityTtlMs) {
			if (
				existing.candidateId !== owner.candidateId ||
				existing.accountId !== owner.accountId
			) {
				return false;
			}
			existing.assignedAt = now;
			return true;
		}
		if (!existing) this.evictOldestIfFull();
		// commitAffinityOwner has no candidates list, only meta: compute
		// "at home" from the catalog's own entry for this owner when a catalog
		// is present. When the catalog is absent, or the owner isn't in it,
		// default to false (protected/at-home) rather than true -- the failure
		// mode of a wrong `false` here is "session stays put", never a
		// surprise cross-tier move, so the conservative default is the safe
		// one.
		const catalogOwnerEntry = meta.routingCandidateCatalog?.find(
			(candidate) => candidate.candidateId === owner.candidateId,
		);
		const bestCatalogTier = this.bestCatalogConfiguredTier(meta);
		const installedBelowBestConfiguredTier =
			catalogOwnerEntry !== undefined &&
			bestCatalogTier !== null &&
			catalogOwnerEntry.tier > bestCatalogTier;
		this.affinity.set(affinityKey, {
			candidateId: owner.candidateId,
			accountId: owner.accountId,
			fallbackCandidateId: null,
			assignedAt: now,
			upgradedAt: null,
			suppressUpgradesUntil: null,
			installedBelowBestConfiguredTier,
			crossTierProtectionLogged: false,
		});
		return true;
	}

	commitDescendantAffinityOwner(
		meta: RequestMeta,
		owner: AffinityOwnerSnapshot,
	): RouteHomeAction {
		const affinityKey = this.affinityKey(meta);
		if (
			affinityKey === null ||
			!this.isDescendantHomeRequest(meta) ||
			owner.candidateId.length === 0 ||
			owner.accountId.length === 0 ||
			meta.hardExcludedAccountIds?.has(owner.accountId)
		) {
			meta.routeHomeAction = "none";
			return "none";
		}

		const now = this.now();
		let existing = this.affinity.get(affinityKey);
		if (existing && now - existing.assignedAt >= this.affinityTtlMs) {
			this.affinity.delete(affinityKey);
			existing = undefined;
		}
		if (existing) {
			if (
				existing.candidateId === owner.candidateId &&
				existing.accountId === owner.accountId
			) {
				existing.assignedAt = now;
				meta.routeHomeAction = "retained";
				return "retained";
			}
			if (
				meta.routeHomeReplacementAllowed !== true ||
				meta.routeHomeExpectedCandidateId !== existing.candidateId
			) {
				meta.routeHomeAction = "none";
				return "none";
			}
		} else if (meta.routeHomeExpectedCandidateId !== null) {
			meta.routeHomeAction = "none";
			return "none";
		}

		if (!existing) this.evictOldestIfFull();
		const action: RouteHomeAction = existing ? "repinned" : "initial_commit";
		this.affinity.set(affinityKey, {
			candidateId: owner.candidateId,
			accountId: owner.accountId,
			fallbackCandidateId: null,
			assignedAt: now,
			upgradedAt: null,
			suppressUpgradesUntil: null,
			installedBelowBestConfiguredTier: false,
			crossTierProtectionLogged: false,
		});
		meta.routeHomeAction = action;
		return action;
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

	getRouteCircuitRecoveryHint(
		meta: RequestMeta,
	): RouteCircuitRecoveryHint | null {
		const selection = this.routeCircuitSelections.get(meta);
		const affinityKey = this.affinityKey(meta);
		if (
			!selection ||
			affinityKey === null ||
			selection.candidateIds.length === 0
		) {
			return null;
		}

		const now = this.now();
		const states = selection.candidateIds
			.map((candidateId) => this.routeFailureState(affinityKey, candidateId))
			.filter((state): state is RouteFailureState => state !== undefined);
		const allCandidatesOpen = states.length === selection.candidateIds.length;
		if (states.length === 0) {
			return {
				allCandidatesOpen: false,
				candidateCount: selection.candidateIds.length,
				probeLeased: false,
				retryAt: null,
				reason: null,
			};
		}

		const recoveries = states.map((state) => {
			const leaseActive =
				state.probeLeaseUntil !== null && now < state.probeLeaseUntil;
			const retryAt = leaseActive
				? (state.probeLeaseUntil as number)
				: now >= state.nextProbeAt || state.earlyProbeAvailable
					? now
					: state.nextProbeAt;
			return { state, retryAt, leaseActive };
		});
		const earliest = [...recoveries].sort(
			(a, b) =>
				a.retryAt - b.retryAt ||
				a.state.candidateId.localeCompare(b.state.candidateId),
		)[0];

		return {
			allCandidatesOpen,
			candidateCount: selection.candidateIds.length,
			probeLeased: recoveries.some((recovery) => recovery.leaseActive),
			retryAt: earliest?.retryAt ?? null,
			reason: earliest?.state.reason ?? null,
		};
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
		const eligible = candidateStates.filter(
			({ candidate, state }) =>
				isEligibleCandidate(candidate) &&
				(state.probeLeaseUntil === null || now >= state.probeLeaseUntil) &&
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
			return {
				candidate,
				score: this.getLeastUsedScore(candidate.account, now),
			};
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

	/** Return the ordinary least-used score, including the bounded recency penalty. */
	protected getLeastUsedScore(account: Account, now: number): number {
		const util =
			this.store?.getAccountUtilization?.(account.id, account.provider) ?? 0;
		const lastPick = this.lastPickedAt.get(account.id) ?? 0;
		const recencyPenalty =
			now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
		return util + recencyPenalty;
	}

	/**
	 * Rank candidates for a fresh assignment or account-level failover.
	 * The base implementation is intentionally the existing least-used order;
	 * opt-in strategy variants may override it without changing sticky-owner or
	 * route-circuit decisions.
	 */
	protected rankFreshCandidates(
		candidates: StrategyCandidate[],
		now: number,
		meta?: RequestMeta,
	): StrategyCandidate[] {
		return this.rankByLeastUsed(candidates, now, meta);
	}

	/** Strategy variants may invalidate an ordinary sticky owner. */
	protected canRetainAffinityOwner(
		_candidate: StrategyCandidate,
		_now: number,
		_meta: RequestMeta,
	): boolean {
		return true;
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
		freshSelection = false,
	): StrategyCandidate[] {
		const ranked = freshSelection
			? this.rankFreshCandidates(available, now, meta)
			: this.rankByLeastUsed(available, now, meta);
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
	 * Keep a legal temporary fallback first without replacing the preferred
	 * owner. If the old fallback disappeared, became unavailable/hard-excluded,
	 * or is outclassed by the best current routing class, choose and remember a
	 * new least-used fallback. The fallback lives inside the already-bounded
	 * affinity entry, so this adds no caller-controlled side map.
	 */
	private orderWithActiveFallback(
		available: StrategyCandidate[],
		mapping: SessionAffinityEntry,
		now: number,
		meta: RequestMeta,
	): StrategyCandidate[] {
		// The lane is active even while its preferred owner is absent/probing.
		mapping.assignedAt = now;
		const ranked = this.rankFreshCandidates(available, now, meta);
		const best = ranked[0];
		const fallback = mapping.fallbackCandidateId
			? available.find(
					(candidate) =>
						candidate.routing.candidateId === mapping.fallbackCandidateId,
				)
			: undefined;

		if (
			fallback &&
			best &&
			isSameStrategyCandidateClass(fallback, best, meta)
		) {
			return [
				fallback,
				...ranked.filter(
					(candidate) =>
						candidate.routing.candidateId !== fallback.routing.candidateId,
				),
			];
		}

		const ordered = this.pickAndMark(available, now, meta, true);
		mapping.fallbackCandidateId = ordered[0]?.routing.candidateId ?? null;
		return ordered;
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
			this.rankFreshCandidates(zipStrategyCandidates(available), now)[0]
				?.account.id ?? null
		);
	}

	async select(accounts: Account[], meta: RequestMeta): Promise<Account[]> {
		const now = this.now();
		this.gcStaleRouteFailureStates(now);
		this.routeCircuitSelections.delete(meta);
		const affinityKey = this.selectionAffinityKey(meta);
		const routeCircuitKey = this.affinityKey(meta);
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

		// GC before any directive-aware return so a retained overlay cannot keep
		// unrelated expired mappings alive.
		for (const [clientId, entry] of this.affinity) {
			if (now - entry.assignedAt >= this.affinityTtlMs) {
				this.affinity.delete(clientId);
			}
		}

		if (affinityKey !== null && this.isDescendantHomeRequest(meta)) {
			meta.routeHomeAction = "none";
			meta.routeHomeExpectedCandidateId = null;
			meta.routeHomeReplacementAllowed = false;
			meta.routeRepinReason = null;
			const mapping = this.affinity.get(affinityKey);
			if (mapping) {
				meta.routeHomeExpectedCandidateId = mapping.candidateId;
				const availableOwner = otherwiseAvailable.find(
					(candidate) =>
						candidate.routing.candidateId === mapping.candidateId &&
						candidate.account.id === mapping.accountId,
				);
				const ownerCircuit = availableOwner
					? this.routeFailureState(affinityKey, mapping.candidateId)
					: undefined;
				if (
					availableOwner &&
					ownerCircuit === undefined &&
					this.canRetainAffinityOwner(availableOwner, now, meta)
				) {
					mapping.assignedAt = now;
					mapping.fallbackCandidateId = null;
					meta.routeHomeAction = "retained";
					const others = this.rankByLeastUsed(
						otherwiseAvailable.filter(
							(candidate) =>
								candidate.routing.candidateId !== mapping.candidateId,
						),
						now,
						meta,
					);
					return commitStrategyCandidateOrder(
						[availableOwner, ...others],
						meta,
					);
				}

				meta.routeHomeReplacementAllowed = true;
				if (ownerCircuit !== undefined) {
					meta.routeRepinReason = "route_circuit_open";
				} else if (meta.hardExcludedAccountIds?.has(mapping.accountId)) {
					meta.routeRepinReason = "hard_exclusion";
				} else if (
					configuredCandidates.some(
						(candidate) =>
							candidate.routing.candidateId === mapping.candidateId,
					)
				) {
					meta.routeRepinReason = "account_unavailable";
				} else {
					meta.routeRepinReason = "structural_removal";
				}
			}

			this.routeCircuitSelections.set(meta, {
				candidateIds: [
					...new Set(
						otherwiseAvailable.map(
							(candidate) => candidate.routing.candidateId,
						),
					),
				],
			});
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
			const allOpenProbe =
				closedCandidates.length === 0
					? this.acquireHalfOpenProbe(circuitCandidates, affinityKey, now, true)
					: null;
			const ranked = allOpenProbe
				? [allOpenProbe]
				: this.pickAndMark(closedCandidates, now, meta, true);
			return commitStrategyCandidateOrder(ranked, meta);
		}

		const ownerDirective =
			meta.affinityOwnerDirective?.kind === "retain-owner"
				? meta.affinityOwnerDirective
				: null;
		if (affinityKey !== null && ownerDirective) {
			const retainedOwner = ownerDirective.owner;
			const catalogOwner = meta.routingCandidateCatalog?.find(
				(candidate) =>
					candidate.candidateId === retainedOwner.candidateId &&
					candidate.accountId === retainedOwner.accountId,
			);
			const configuredOwner = configuredCandidates.find(
				(candidate) =>
					candidate.routing.candidateId === retainedOwner.candidateId &&
					candidate.account.id === retainedOwner.accountId,
			);
			const catalogProvesMissing =
				meta.routingCandidateCatalog !== null &&
				meta.routingCandidateCatalog !== undefined &&
				catalogOwner === undefined;
			const hardInvalid =
				meta.hardExcludedAccountIds?.has(retainedOwner.accountId) === true ||
				catalogProvesMissing ||
				(catalogOwner === undefined && configuredOwner === undefined) ||
				configuredOwner?.account.paused === true;

			if (!hardInvalid) {
				// The directive forces this exact owner regardless of ranking. The
				// at-home marker is INSTALL-time state, so it is computed only when
				// the directive actually installs an owner: a brand-new lane, or a
				// retained owner that differs from the one already mapped.
				// Recomputing it on an ordinary same-owner refresh would let a
				// priority edit made while the directive is in force silently
				// re-label an at-home owner as displaced, so the next cross-tier
				// outclass after the directive lifts would remap the very session
				// the guard exists to protect. `commitAffinityOwner` follows the
				// same same-owner-refresh rule.
				const retainedOwnerInstalledBelowBestConfiguredTier = (): boolean => {
					const retainedOwnerTier =
						catalogOwner?.tier ?? configuredOwner?.routing.tier;
					const bestTier = this.bestConfiguredTier(meta, candidates);
					return (
						retainedOwnerTier !== undefined &&
						bestTier !== null &&
						retainedOwnerTier > bestTier
					);
				};

				let mapping = this.affinity.get(affinityKey);
				if (!mapping) {
					this.evictOldestIfFull();
					mapping = {
						candidateId: retainedOwner.candidateId,
						accountId: retainedOwner.accountId,
						fallbackCandidateId: null,
						assignedAt: now,
						upgradedAt: null,
						suppressUpgradesUntil: null,
						installedBelowBestConfiguredTier:
							retainedOwnerInstalledBelowBestConfiguredTier(),
						crossTierProtectionLogged: false,
					};
					this.affinity.set(affinityKey, mapping);
				} else {
					const ownerChanged =
						mapping.candidateId !== retainedOwner.candidateId ||
						mapping.accountId !== retainedOwner.accountId;
					mapping.candidateId = retainedOwner.candidateId;
					mapping.accountId = retainedOwner.accountId;
					mapping.assignedAt = now;
					if (ownerChanged) {
						mapping.installedBelowBestConfiguredTier =
							retainedOwnerInstalledBelowBestConfiguredTier();
						mapping.crossTierProtectionLogged = false;
						// Anti-thrash state belongs to the owner it was measured
						// against. Installing a DIFFERENT owner here without clearing
						// it lets the replacement inherit a predecessor's upgrade
						// timestamp -- enough to fire the fast-fail-after-upgrade
						// branch for an owner that never upgraded, and to arm
						// suppression from a timestamp that predates it. Every other
						// install site in this class already resets both.
						mapping.upgradedAt = null;
						mapping.suppressUpgradesUntil = null;
					}
				}

				this.routeCircuitSelections.set(meta, {
					candidateIds: [
						...new Set(
							otherwiseAvailable.map(
								(candidate) => candidate.routing.candidateId,
							),
						),
					],
				});
				const closedCandidates = otherwiseAvailable.filter(
					(candidate) =>
						this.routeFailureState(
							affinityKey,
							candidate.routing.candidateId,
						) === undefined,
				);
				const availableOwner = otherwiseAvailable.find(
					(candidate) =>
						candidate.routing.candidateId === retainedOwner.candidateId &&
						candidate.account.id === retainedOwner.accountId,
				);
				const ownerCircuit =
					availableOwner === undefined
						? undefined
						: this.routeFailureState(
								affinityKey,
								availableOwner.routing.candidateId,
							);

				if (availableOwner && ownerCircuit === undefined) {
					mapping.fallbackCandidateId = null;
					const others = this.rankByLeastUsed(
						closedCandidates.filter(
							(candidate) =>
								candidate.routing.candidateId !==
								availableOwner.routing.candidateId,
						),
						now,
						meta,
					);
					return commitStrategyCandidateOrder(
						[availableOwner, ...others],
						meta,
					);
				}

				const fallbacks = closedCandidates.filter(
					(candidate) =>
						candidate.routing.candidateId !== retainedOwner.candidateId,
				);
				const ownerProbe =
					availableOwner && ownerCircuit
						? this.acquireHalfOpenProbe(
								[availableOwner],
								affinityKey,
								now,
								fallbacks.length === 0,
							)
						: null;
				const orderedFallbacks =
					fallbacks.length > 0
						? this.orderWithActiveFallback(fallbacks, mapping, now, meta)
						: [];
				return commitStrategyCandidateOrder(
					ownerProbe ? [ownerProbe, ...orderedFallbacks] : orderedFallbacks,
					meta,
				);
			}
		}

		let available = otherwiseAvailable;
		let forcedPriorityProbe: StrategyCandidate | null = null;
		let forcedPriorityFallbacks: StrategyCandidate[] = [];
		if (routeCircuitKey !== null) {
			this.routeCircuitSelections.set(meta, {
				candidateIds: [
					...new Set(
						otherwiseAvailable.map(
							(candidate) => candidate.routing.candidateId,
						),
					),
				],
			});
			const closedCandidates = otherwiseAvailable.filter(
				(candidate) =>
					this.routeFailureState(
						routeCircuitKey,
						candidate.routing.candidateId,
					) === undefined,
			);
			const circuitCandidates = otherwiseAvailable.filter(
				(candidate) =>
					this.routeFailureState(
						routeCircuitKey,
						candidate.routing.candidateId,
					) !== undefined,
			);
			const rankedClosedCandidates = this.rankByLeastUsed(
				closedCandidates,
				now,
				meta,
			);
			const bestClosedCandidate = rankedClosedCandidates[0];
			const mapping =
				affinityKey === null ? undefined : this.affinity.get(affinityKey);
			const activeMapping =
				mapping && now - mapping.assignedAt < this.affinityTtlMs
					? mapping
					: undefined;
			const upgradeSuppressed =
				activeMapping !== undefined &&
				activeMapping.suppressUpgradesUntil !== null &&
				now < activeMapping.suppressUpgradesUntil;

			// A recovered better routing class must get one real chance to reclaim its
			// configured priority. Lease it only when it will be returned as the first
			// executable attempt, with every healthy closed route retained behind it.
			// Equal/worse circuits stay dormant while a better-or-equal closed route is
			// available, preserving stickiness and preventing phantom probe leases.
			if (bestClosedCandidate && !upgradeSuppressed) {
				forcedPriorityProbe = this.acquireHalfOpenProbe(
					circuitCandidates,
					routeCircuitKey,
					now,
					false,
					(candidate) =>
						compareStrategyCandidates(candidate, bestClosedCandidate, meta) < 0,
					(a, b) => compareStrategyCandidates(a, b, meta),
				);
				if (forcedPriorityProbe) {
					forcedPriorityFallbacks = activeMapping
						? this.orderWithActiveFallback(
								closedCandidates,
								activeMapping,
								now,
								meta,
							)
						: rankedClosedCandidates;
				}
			}

			// With no healthy closed route, preserve the deterministic all-open single
			// probe. This is the only path allowed to consume a first-failure early
			// probe before its ordinary backoff boundary.
			const allOpenProbe =
				closedCandidates.length === 0
					? this.acquireHalfOpenProbe(
							circuitCandidates,
							routeCircuitKey,
							now,
							true,
						)
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
					this.canRetainAffinityOwner(mapped, now, meta) &&
					isSameStrategyCandidateClass(mapped, best, meta)
				) {
					// STICKY hit: keep the client on its account (prompt-cache reuse).
					// Refresh assignedAt so an active session keeps its mapping alive.
					mapping.assignedAt = now;
					mapping.fallbackCandidateId = null;
					// The owner is no longer cross-tier outclassed (if it ever was):
					// end any in-progress protection episode so the next one logs
					// at info again.
					mapping.crossTierProtectionLogged = false;
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
						mapping.fallbackCandidateId = null;
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

					// At-home guard: a healthy owner installed AT the request's best
					// configured tier must never be remapped by a later CROSS-TIER
					// outclass (a priority edit, or a higher-priority account
					// appearing) -- only same-tier pressure-band outclass and owners
					// that were already displaced fallbacks remain eligible below.
					// `best` is always the minimum tier in `available` (rankByLeastUsed
					// sorts tier ascending), so `mapped` can never have a strictly
					// better tier than `best` here -- equal tiers are the same-tier
					// pressure case, which must fall through unchanged.
					const crossTierOutclass = best.routing.tier < mapped.routing.tier;
					if (crossTierOutclass && !mapping.installedBelowBestConfiguredTier) {
						this.routingTransitions.recordAtHomeProtection();
						mapping.assignedAt = now;
						mapping.fallbackCandidateId = null;
						const others = this.rankByLeastUsed(
							available.filter(
								(candidate) =>
									candidate.routing.candidateId !== mapped.routing.candidateId,
							),
							now,
							meta,
						);
						const logFields = {
							ownerCandidateId: mapped.routing.candidateId,
							ownerTier: mapped.routing.tier,
							bestCandidateId: best.routing.candidateId,
							bestTier: best.routing.tier,
							affinityLanePresent: meta.affinityLaneKey != null,
						};
						if (mapping.crossTierProtectionLogged) {
							this.log.debug(
								"At-home route owner protected from cross-tier outclass",
								logFields,
							);
						} else {
							this.log.info(
								"At-home route owner protected from cross-tier outclass",
								logFields,
							);
							mapping.crossTierProtectionLogged = true;
						}
						return commitStrategyCandidateOrder([mapped, ...others], meta);
					}

					// A routable better tier (or comparable higher-pressure class inside
					// the same tier) is authoritative and becomes the new sticky owner.
					const ordered = this.pickAndMark(available, now, meta, true);
					const replacement = ordered[0];
					if (replacement) {
						if (crossTierOutclass) {
							this.routingTransitions.recordCrossTierOutclassRemap();
						} else {
							this.routingTransitions.recordSameTierOutclassRemap();
						}
						mapping.candidateId = replacement.routing.candidateId;
						mapping.accountId = replacement.account.id;
						mapping.fallbackCandidateId = null;
						mapping.assignedAt = now;
						mapping.upgradedAt = now;
						mapping.suppressUpgradesUntil = null;
						mapping.installedBelowBestConfiguredTier =
							this.computeInstalledBelowBestConfiguredTier(
								replacement,
								meta,
								candidates,
							);
						mapping.crossTierProtectionLogged = false;
					}
					// This line fires for both remaps the at-home guard deliberately
					// allows: a same-tier pressure-band outclass, and a displaced
					// owner recovering to its home tier. Carry the tiers and the
					// previous owner so an incident review can tell which happened
					// without re-deriving install-time state that isn't logged.
					this.log.info("Outclassed route owner remapped", {
						candidateId:
							replacement?.routing.candidateId ?? best.routing.candidateId,
						previousCandidateId: mapped.routing.candidateId,
						previousTier: mapped.routing.tier,
						replacementTier: (replacement ?? best).routing.tier,
						crossTier: best.routing.tier < mapped.routing.tier,
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
						const ordered = this.pickAndMark(available, now, meta, true);
						const fallback = ordered[0];
						// The owner this session was just upgraded to has already failed:
						// arm suppression for the remainder of the window (measured from
						// the original upgrade) and settle on the fallback instead of
						// preserving/snapping back to the flapping owner.
						mapping.suppressUpgradesUntil =
							upgradedAt + this.antiThrashWindowMs;
						if (fallback) {
							this.routingTransitions.recordFailoverRemap();
							mapping.candidateId = fallback.routing.candidateId;
							mapping.accountId = fallback.account.id;
							mapping.fallbackCandidateId = null;
							mapping.assignedAt = now;
							mapping.upgradedAt = null;
							mapping.installedBelowBestConfiguredTier =
								this.computeInstalledBelowBestConfiguredTier(
									fallback,
									meta,
									candidates,
								);
							mapping.crossTierProtectionLogged = false;
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
						this.routingTransitions.recordSnapbackPreservation();
						const ordered = this.orderWithActiveFallback(
							available,
							mapping,
							now,
							meta,
						);
						this.log.info(
							"Better-tier route owner unavailable; preserving for snapback",
							{
								candidateId: mapping.candidateId,
								fallbackCandidateId: mapping.fallbackCandidateId,
								affinityLanePresent: meta.affinityLaneKey != null,
							},
						);
						return commitStrategyCandidateOrder(ordered, meta);
					}

					const ordered = this.pickAndMark(available, now, meta, true);
					const fallback = ordered[0];
					if (fallback) {
						this.routingTransitions.recordFailoverRemap();
						mapping.candidateId = fallback.routing.candidateId;
						mapping.accountId = fallback.account.id;
						mapping.fallbackCandidateId = null;
						mapping.assignedAt = now;
						mapping.upgradedAt = null;
						mapping.installedBelowBestConfiguredTier =
							this.computeInstalledBelowBestConfiguredTier(
								fallback,
								meta,
								candidates,
							);
						mapping.crossTierProtectionLogged = false;
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
		const ranked = this.pickAndMark(available, now, meta, true);
		const chosen = ranked[0];

		if (
			affinityKey !== null &&
			chosen &&
			meta.affinityOwnerDirective?.kind !== "defer-owner-assignment"
		) {
			this.evictOldestIfFull();
			this.affinity.set(affinityKey, {
				candidateId: chosen.routing.candidateId,
				accountId: chosen.account.id,
				fallbackCandidateId: null,
				assignedAt: now,
				upgradedAt: null,
				suppressUpgradesUntil: null,
				installedBelowBestConfiguredTier:
					this.computeInstalledBelowBestConfiguredTier(
						chosen,
						meta,
						candidates,
					),
				crossTierProtectionLogged: false,
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
