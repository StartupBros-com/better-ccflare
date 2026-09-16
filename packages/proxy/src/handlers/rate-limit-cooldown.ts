import {
	computeOverloadCooldownMs,
	computeOverloadWithResetCapMs,
	computeRateLimitBackoffMs,
	computeServerErrorCooldownMs,
	getRateLimitMaxCooldownMs,
	isOverloadReason,
	isServerErrorReason,
	logError,
	RateLimitError,
	resolveCooldownUntil,
} from "@better-ccflare/core";
import type { MarkAccountRateLimitedResult } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import {
	type CircuitBreaker,
	getDefaultCircuitBreaker,
} from "../circuit-breaker";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("RateLimitCooldown");

const MATURE_COOLDOWN_STREAK = 5;
const PROBE_LEASE_MS = 2 * 60 * 1000;
const MAX_PROBE_GATES = 10_000;
const probeLeases = new Map<string, number>();

const DEFAULT_RATE_LIMIT_PERSIST_AWAIT_TIMEOUT_MS = 3000;

/**
 * Read the bound (ms) on how long applyRateLimitCooldownAwaitingPersist will
 * await the durable markAccountRateLimited write before falling back to the
 * in-memory-only cooldown. Reads CCFLARE_RATE_LIMIT_PERSIST_AWAIT_TIMEOUT_MS
 * from env. Uses an explicit finite check (not ||) so 0 is a valid override
 * for tests.
 */
function getRateLimitPersistAwaitTimeoutMs(): number {
	const raw = Number(process.env.CCFLARE_RATE_LIMIT_PERSIST_AWAIT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw >= 0
		? raw
		: DEFAULT_RATE_LIMIT_PERSIST_AWAIT_TIMEOUT_MS;
}

/**
 * True for reasons where the upstream, not the account's quota, is what went
 * wrong: both 529 overload variants and a transient 5xx server error. These
 * share three behaviours — `consecutive_rate_limits` stays frozen, the cooldown
 * write is forward-guarded so it can never shorten a longer active bench, and
 * the single-flight recovery probe arms on the reason alone (a frozen streak
 * can never reach MATURE_COOLDOWN_STREAK by itself).
 */
function isTransientUpstreamReason(reason: RateLimitReason): boolean {
	return isOverloadReason(reason) || isServerErrorReason(reason);
}

export type RateLimitProbeAdmission =
	| "not_required"
	| "admitted"
	| "suppressed";

function pruneProbeLeases(now: number): void {
	for (const [accountId, leaseUntil] of probeLeases) {
		if (leaseUntil <= now) probeLeases.delete(accountId);
	}
	while (probeLeases.size >= MAX_PROBE_GATES) {
		const oldest = probeLeases.keys().next().value;
		if (oldest === undefined) break;
		probeLeases.delete(oldest);
	}
}

/**
 * Admits one process-local recovery probe after a mature cooldown expires.
 * Ordinary accounts and accounts still cooling down are not gated.
 *
 * Rationale: once an account has racked up a long streak of consecutive
 * 429s, its cooldown expiry is often optimistic relative to the upstream
 * quota window. Letting every concurrently selected request pile onto that
 * account the instant the cooldown clears re-triggers the same 429 storm
 * that produced the streak. Gating to a single in-flight probe lets one
 * request find out whether the account has actually recovered while the
 * rest fall through to the next account in the selection order — provided
 * one is available. If every candidate in the pool is currently suppressed
 * (a single-account pool, or a pool-wide overload storm), there is no next
 * account to fall through to: the caller runs the highest-priority
 * candidate ungated instead (see proxy.ts's "every candidate suppressed"
 * fallback), and this gate suppresses nothing for that request.
 *
 * The gate also arms for any 529 overload cooldown and for a transient 5xx
 * server-error cooldown, regardless of streak depth. consecutive_rate_limits is
 * frozen for both (see applyRateLimitCooldown) so an account whose failures are
 * exclusively upstream-side never reaches MATURE_COOLDOWN_STREAK on its own —
 * without this, the single-flight protection could never engage for such an
 * account, and every concurrently selected request would hit it again the
 * instant its (short) cooldown expires.
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const reason = account.rate_limited_reason;
	const isTransientUpstream =
		reason != null && isTransientUpstreamReason(reason);
	const expiredMatureCooldown =
		(account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK ||
			isTransientUpstream) &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	if (!expiredMatureCooldown) return "not_required";

	pruneProbeLeases(now);
	const existingLease = probeLeases.get(account.id);
	if (existingLease && existingLease > now) {
		log.debug(
			`[ccflare] account=${account.name} cooldown_probe_suppressed lease_until=${new Date(existingLease).toISOString()}`,
		);
		return "suppressed";
	}

	const leaseUntil = now + PROBE_LEASE_MS;
	probeLeases.set(account.id, leaseUntil);
	log.info(
		`[ccflare] account=${account.name} cooldown_probe_admitted streak=${account.consecutive_rate_limits} lease_until=${new Date(leaseUntil).toISOString()}`,
	);
	return "admitted";
}

/**
 * Side-effect-free lookahead for `getRateLimitProbeAdmission`: reports
 * whether the account would currently be reported as "suppressed" for a
 * probe, without checking a lease out or pruning expired ones. Used by the
 * account loops in proxy.ts to determine whether every candidate *after*
 * the one about to be attempted would be skipped — if so, the current
 * attempt is the request's actual terminal one, even when it isn't the
 * last index in the pool.
 */
export function wouldSuppressProbe(
	account: Account,
	now: number = Date.now(),
): boolean {
	const reason = account.rate_limited_reason;
	const isTransientUpstream =
		reason != null && isTransientUpstreamReason(reason);
	const expiredMatureCooldown =
		(account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK ||
			isTransientUpstream) &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	if (!expiredMatureCooldown) return false;

	const existingLease = probeLeases.get(account.id);
	return existingLease != null && existingLease > now;
}

/**
 * Releases the single-flight probe lease for an account, if one is held.
 * Must be called on every terminal outcome of a probed request: success
 * (recovered), a fresh cooldown being reapplied, or the request being
 * abandoned (exception, or the account being skipped mid-loop).
 */
export function completeRateLimitProbe(
	account: Account,
	outcome: "recovered" | "cooldown_reapplied" | "abandoned",
): void {
	if (!probeLeases.delete(account.id)) return;
	if (outcome === "recovered") {
		log.info(
			`[ccflare] account=${account.name} cooldown_probe_recovery_success`,
		);
	} else if (outcome === "abandoned") {
		log.debug(`[ccflare] account=${account.name} cooldown_probe_abandoned`);
	}
}

export function resetRateLimitProbeGatesForTests(): void {
	probeLeases.clear();
}

/**
 * Whether `resetTime` is known to describe the same scope as the hold it is
 * about to size.
 *
 * - `confirmed` — the reset came from a window whose scope matches this hold:
 *   fresh capacity evidence proved the account-wide window is spent, and this
 *   is an account-wide hold.
 * - `unattributed` — the reset came from an upstream header that never names
 *   the window it describes. Anthropic returns the per-model weekly reset there
 *   on a model-scoped 429, so honouring it as an account-wide duration converts
 *   a Fable-only cap into a 12h whole-account bench.
 *
 * An unattributed reset may not outlive a probe. Sizing a durable hold from a
 * window we cannot attribute is how a restart with a cold usage cache benched
 * three healthy accounts for 12h on 2026-08-11 and emptied the pool into
 * `503 route_unavailable` (issue #157).
 *
 * Omitted means `confirmed`: every caller predating this distinction keeps its
 * existing behaviour, so the narrowing is opt-in at the sites that actually
 * know their evidence is header-only.
 */
export type ResetTimeScope = "confirmed" | "unattributed";

export interface RateLimitCooldownInput {
	resetTime?: number;
	remaining?: number;
	reason?: RateLimitReason;
	resetTimeScope?: ResetTimeScope;
}

/**
 * In-memory half of applyRateLimitCooldown / applyRateLimitCooldownAwaitingPersist:
 * computes the cooldown (429 exponential backoff capped by upstream reset, or a
 * 529 overload duration — see the doc comment on applyRateLimitCooldown below)
 * and mutates the account in place. Shared so both the fire-and-forget and the
 * awaited-persist variants apply identical cooldown math, audit-reason
 * derivation, and the 529 forward guard.
 */
function applyRateLimitCooldownInMemory(
	account: Account,
	rateLimitInfo: RateLimitCooldownInput,
): {
	cooldownUntil: number;
	reason: RateLimitReason;
	isOverload: boolean;
	isTransientUpstream: boolean;
	skipped: boolean;
} {
	const now = Date.now();
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");
	const isOverload = isOverloadReason(reason);
	const isTransientUpstream = isTransientUpstreamReason(reason);
	// Only the reset-less 529 gets the fixed short cooldown. A 529-with-reset
	// gets its own capped duration below — see the doc comment above.
	const isOverloadNoReset = reason === "upstream_529_overloaded_no_reset";

	// Best-effort in-memory computation for the 429 ramp. The DB write does the
	// authoritative atomic increment; under parallel 429s the second concurrent
	// request may compute one tier short, but the persisted counter still ramps
	// correctly. Unused for 529s — their duration no longer derives from this
	// (frozen) counter.
	const nextCount = account.consecutive_rate_limits + 1;

	let cooldownUntil: number;
	if (isOverloadNoReset) {
		cooldownUntil = now + computeOverloadCooldownMs();
	} else if (isServerErrorReason(reason)) {
		const capUntil = now + computeServerErrorCooldownMs();
		cooldownUntil =
			rateLimitInfo.resetTime != null
				? Math.min(rateLimitInfo.resetTime, capUntil)
				: capUntil;
	} else if (isOverload) {
		const capUntil = now + computeOverloadWithResetCapMs();
		cooldownUntil =
			rateLimitInfo.resetTime != null
				? Math.min(rateLimitInfo.resetTime, capUntil)
				: capUntil;
	} else {
		const backoffMs = computeRateLimitBackoffMs(nextCount);
		// An unattributed reset describes a window we cannot match to this hold's
		// scope, so it is withheld and the backoff ramp decides instead. Dropping
		// it here rather than inside resolveCooldownUntil keeps that helper a pure
		// clamp and puts the evidence rule at the single place every 429 caller
		// already funnels through — see ResetTimeScope.
		const attributedResetTime =
			rateLimitInfo.resetTimeScope === "unattributed"
				? undefined
				: rateLimitInfo.resetTime;
		// When the upstream reset is known, bench until that reset (bounded above by
		// the safety ceiling) instead of discarding a far-future reset and
		// re-probing every ~5min — see resolveCooldownUntil.
		cooldownUntil = resolveCooldownUntil({
			now,
			backoffMs,
			maxCooldownMs: getRateLimitMaxCooldownMs(),
			resetTime: attributedResetTime,
		});
	}

	if (
		isTransientUpstream &&
		account.rate_limited_until != null &&
		account.rate_limited_until > cooldownUntil
	) {
		// Forward guard: this 529 found a longer, already-active cooldown (a
		// real 429 quota bench outlives any 529 that arrives while it's
		// running) — don't overwrite it with a shorter overload cooldown.
		// rate_limited_at is deliberately NOT re-stamped here: doing so would
		// delay the stability healing in response-processor.ts (gated on
		// rate_limited_at) on every subsequent 529, even though nothing about
		// the bench itself changed.
		const wasRecoveryProbe = probeLeases.has(account.id);
		completeRateLimitProbe(account, "cooldown_reapplied");
		if (wasRecoveryProbe) {
			log.info(
				`[ccflare] account=${account.name} cooldown_probe_reapplied reason=${reason} until=${new Date(account.rate_limited_until).toISOString()}`,
			);
		}
		log.warn(
			`[ccflare] account=${account.name} upstream_overloaded reason=${reason} found longer active cooldown until=${new Date(account.rate_limited_until).toISOString()} — not overwriting with the shorter 529 cooldown (would have been until=${new Date(cooldownUntil).toISOString()})`,
		);
		return {
			cooldownUntil,
			reason,
			isOverload,
			isTransientUpstream,
			skipped: true,
		};
	}

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.rate_limited_reason = reason;
	if (!isTransientUpstream) {
		account.consecutive_rate_limits = nextCount;
	}
	const wasRecoveryProbe = probeLeases.has(account.id);
	completeRateLimitProbe(account, "cooldown_reapplied");
	if (wasRecoveryProbe) {
		log.info(
			`[ccflare] account=${account.name} cooldown_probe_reapplied reason=${reason} until=${new Date(cooldownUntil).toISOString()}`,
		);
	}

	return {
		cooldownUntil,
		reason,
		isOverload,
		isTransientUpstream,
		skipped: false,
	};
}

/**
 * Single entry point for applying an upstream-driven cooldown to an account
 * after a 429 (quota), a 529 (transient overload) or a transient 5xx server
 * error response.
 *
 * Cooldown DURATION:
 * - A 429 uses the exponential-backoff ramp capped by the upstream reset (if
 *   any) — `min(resetTime, now + backoff)`. Unchanged by this function's 529
 *   handling.
 * - A reset-less 529 (`upstream_529_overloaded_no_reset`) uses a short fixed
 *   cooldown instead (`computeOverloadCooldownMs`): Anthropic gave no
 *   retry-after for it, so there is no account-specific signal to honor, and
 *   ramping the backoff there only punishes a healthy account for an
 *   upstream-wide overload.
 * - A 529-with-reset (`upstream_529_overloaded_with_reset`) honors Anthropic's
 *   own retry-after directly — `min(resetTime, now + computeOverloadWithResetCapMs())`
 *   — see upstream ccflare#271. This does NOT derive from
 *   computeRateLimitBackoffMs/the 429 streak (unlike before): the streak is
 *   frozen for 529s (see below), so deriving duration from it would silently
 *   drift as more 529s arrive. The cap guards against `resetTime` coming from
 *   the anthropic-ratelimit-unified-reset header — a quota window that can be
 *   hours away (provider.ts:368-380) — rather than a short, real retry-after.
 * - A transient server error (`upstream_5xx_server_error`) uses
 *   `min(retryAfter, now + computeServerErrorCooldownMs())`, or the fixed
 *   cooldown when the response carried no usable `Retry-After`. The cap is
 *   separate from the 529 one because the two failure modes have different
 *   shapes: a 529 clears in seconds, whereas the 500s this exists for lasted
 *   minutes at a time on one organization while sibling accounts were healthy.
 *
 * Streak (`consecutive_rate_limits`): incremented for 429s only. Both 529
 * variants AND `upstream_5xx_server_error` (`isTransientUpstreamReason`) leave
 * it untouched — none of them is the account hitting its own quota, and a
 * transient upstream failure must not leave the account throttled once the
 * upstream recovers. The streak also gates
 * `getRateLimitProbeAdmission`'s single-flight recovery probe (which
 * additionally arms on the overload reason directly, see that function's doc
 * comment), so letting a run of transient overloads inflate it would keep
 * throttling an account's concurrency long after its cooldown (and the
 * overload) has cleared, even though the account itself never hit its own
 * quota.
 *
 * Forward guard: a transient upstream cooldown (either 529 variant or a 5xx
 * server error) never shortens an active cooldown that already extends past the
 * newly computed one — e.g. a real 429 quota bench that's still running when a
 * 529 or a 500 arrives mid-window. The longer,
 * already-active bench carries more information than a transient overload
 * does. In that case this function skips every write (in-memory and DB)
 * entirely and only releases the probe lease. The guard covers exactly the
 * transient upstream reasons (both 529 variants and upstream_5xx_server_error);
 * the 429 path keeps its existing last-writer-wins behavior. "Never shorten an
 * active cooldown" is not a project-wide invariant to begin with — the
 * successful-response clear in response-processor.ts unconditionally nulls
 * rate_limited_until (even a future one) the moment a response succeeds.
 *
 * Must be called from every 429/529/5xx path (response-processor, model_fallback_429,
 * all_models_exhausted_429, mid-stream sniffer, the transient-5xx failover in
 * proxy-operations) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429/529 (mutated in place).
 * @param rateLimitInfo - For a 429, `resetTime` (if known) is honored as the cooldown target,
 *   bounded above by the safety ceiling (CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS), see
 *   resolveCooldownUntil. Falls back to the exponential backoff only when no resetTime is
 *   provided. For a 529-with-reset, `resetTime` instead caps via min(resetTime, now + cap) — see
 *   computeOverloadWithResetCapMs. `remaining` is forwarded to the emitted RateLimitError (429
 *   path only). `reason` overrides the auto-derived audit reason and determines which cooldown
 *   strategy applies.
 * @param ctx - The proxy context (provides asyncWriter + dbOps).
 * @param breaker - Circuit breaker fed via `recordFailure` on every non-suppressed cooldown.
 *   Defaults to `getDefaultCircuitBreaker()` (the process-wide singleton). Tests pass a
 *   deterministic instance to assert circuit state. The `recordFailure` exclusion predicate
 *   short-circuits model-scoped reasons so client-side graceful model fallback is preserved.
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: RateLimitCooldownInput,
	ctx: ProxyContext,
	breaker: CircuitBreaker = getDefaultCircuitBreaker(),
): boolean {
	const { cooldownUntil, reason, isTransientUpstream, skipped } =
		applyRateLimitCooldownInMemory(account, rateLimitInfo);
	if (skipped) return false;

	// Feed the circuit breaker. The exclusion predicate in
	// `CircuitBreaker.recordFailure` short-circuits model-scoped reasons
	// (`model_fallback_429`, `out_of_credits`, `extra_usage_exhausted`) so
	// the headline constraint — client-side graceful model fallback must
	// not be defeated by a breaker open — is honored here without any
	// per-site mapping. Failures suppressed by the forward guard above
	// never reach this call (applyRateLimitCooldownInMemory returns
	// skipped=true and this function already returned), which is what
	// prevents double-counting when a 529 arrives mid-429-bench.
	const circuitCounted = breaker.recordFailure(
		{ provider: account.provider, accountId: account.id },
		reason,
		Date.now(),
	);

	ctx.asyncWriter.enqueue(async () => {
		const { consecutiveRateLimits: persistedCount, applied } =
			await ctx.dbOps.markAccountRateLimited(
				account.id,
				cooldownUntil,
				reason,
				!isTransientUpstream,
			);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account). Skipped for the transient
		// upstream reasons: the streak is not touched by a 529 (with or without
		// reset) or a 5xx, so there is nothing to reconcile.
		if (!isTransientUpstream) {
			account.consecutive_rate_limits = persistedCount;
		}
		// Log AFTER the DB write so the reported consecutive= reflects the persisted
		// value, and log the outcome the write actually had. A guarded transient write
		// can be rejected by the repository's forward guard (a concurrent request
		// already set a longer-lived cooldown) — asserting `cooldown_applied` for
		// a write that was in fact skipped left two contradictory log lines for
		// the same event.
		if (applied) {
			log.warn(
				`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
			);
		} else {
			log.warn(
				`[ccflare] account=${account.name} cooldown_write_skipped reason=${reason} candidate_until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount} (existing later cooldown or row absent)`,
			);
		}
	});

	if (isTransientUpstream) {
		// A 529 or a 5xx is a transient upstream server state, not a quota
		// signal — emitting a RateLimitError here would misdiagnose it as
		// account exhaustion. Log honestly instead.
		log.warn(
			`[ccflare] account=${account.name} upstream_transient_failure reason=${reason} until=${new Date(cooldownUntil).toISOString()} (transient upstream failure — streak untouched)`,
		);
		return circuitCounted;
	}

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
	return circuitCounted;
}

/**
 * Per-account single-flight coalescing for the durable markAccountRateLimited
 * write used by applyRateLimitCooldownAwaitingPersist. Under a stuck SQLite
 * lock, withBusyRetry can legitimately block a write for minutes (see the doc
 * comment on applyRateLimitCooldownAwaitingPersist below); once that write
 * times out from the awaiting caller's perspective, its withBusyRetry loop
 * keeps running in the background. Without coalescing, each additional
 * request for the SAME account (e.g. rapid retries against a still
 * rate-limited account) would spawn its own parallel write/retry loop, piling
 * up concurrent SQLite writers against the same lock. Reusing the in-flight
 * promise instead avoids the pile-up. Calls whose deadline is already covered
 * by the active write reuse it. Calls with a later deadline share one pending
 * follow-up write, whose payload is updated to the maximum observed deadline;
 * Only the caller that supplied the eventual write payload owns its applied
 * receipt; coalesced followers receive the count with applied=false.
 * Equal deadlines retain the first observed reason, matching the database's
 * strict-greater monotonic clamp. This intentionally adds no process-local
 * selection breaker: selection still always reads fresh account state from
 * the DB.
 */
interface RateLimitPersistPayload {
	ctx: ProxyContext;
	cooldownUntil: number;
	reason: RateLimitReason;
	incrementStreak: boolean;
}

interface PendingRateLimitWrite extends RateLimitPersistPayload {
	receiptOwner: symbol;
	promise: Promise<MarkAccountRateLimitedResult>;
	resolve: (result: MarkAccountRateLimitedResult) => void;
	reject: (error: unknown) => void;
}

interface RateLimitWriteState {
	active: RateLimitPersistPayload;
	activePromise: Promise<MarkAccountRateLimitedResult>;
	pending: PendingRateLimitWrite | null;
}

const inFlightRateLimitWrites = new Map<string, RateLimitWriteState>();

function invokeMarkAccountRateLimited(
	accountId: string,
	payload: RateLimitPersistPayload,
): Promise<MarkAccountRateLimitedResult> {
	try {
		return Promise.resolve(
			payload.ctx.dbOps.markAccountRateLimited(
				accountId,
				payload.cooldownUntil,
				payload.reason,
				payload.incrementStreak,
			),
		);
	} catch (error) {
		return Promise.reject(error);
	}
}

function observeRateLimitWrite(
	accountId: string,
	state: RateLimitWriteState,
	writePromise: Promise<MarkAccountRateLimitedResult>,
	completion?: PendingRateLimitWrite,
): void {
	void writePromise
		.then(
			(result) => {
				completion?.resolve(result);
				advanceRateLimitWrite(accountId, state, writePromise);
			},
			(error) => {
				completion?.reject(error);
				advanceRateLimitWrite(accountId, state, writePromise);
			},
		)
		.catch((error) => {
			log.error(
				`[ccflare] account_id=${accountId} cooldown_persist_bookkeeping_failed`,
				error,
			);
		});
}

function advanceRateLimitWrite(
	accountId: string,
	state: RateLimitWriteState,
	settledPromise: Promise<MarkAccountRateLimitedResult>,
): void {
	if (
		inFlightRateLimitWrites.get(accountId) !== state ||
		state.activePromise !== settledPromise
	) {
		return;
	}

	const pending = state.pending;
	if (!pending) {
		inFlightRateLimitWrites.delete(accountId);
		return;
	}

	state.pending = null;
	state.active = pending;
	const writePromise = invokeMarkAccountRateLimited(accountId, pending);
	state.activePromise = writePromise;
	observeRateLimitWrite(accountId, state, writePromise, pending);
}

function createPendingRateLimitWrite(
	payload: RateLimitPersistPayload,
	receiptOwner: symbol,
): PendingRateLimitWrite {
	let resolve!: (result: MarkAccountRateLimitedResult) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<MarkAccountRateLimitedResult>(
		(resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		},
	);
	return { ...payload, receiptOwner, promise, resolve, reject };
}

function getOrStartMarkAccountRateLimited(
	ctx: ProxyContext,
	account: Account,
	cooldownUntil: number,
	reason: RateLimitReason,
	incrementStreak: boolean,
): Promise<MarkAccountRateLimitedResult> {
	const payload = { ctx, cooldownUntil, reason, incrementStreak };
	const existing = inFlightRateLimitWrites.get(account.id);
	if (existing) {
		if (cooldownUntil <= existing.active.cooldownUntil) {
			// This call is covered by another writer, so only its count is
			// authoritative for the follower; it did not apply this mutation.
			return existing.activePromise.then((result) => ({
				...result,
				applied: false,
			}));
		}

		const receiptOwner = Symbol();
		if (!existing.pending) {
			existing.pending = createPendingRateLimitWrite(payload, receiptOwner);
		} else if (cooldownUntil > existing.pending.cooldownUntil) {
			existing.pending.ctx = ctx;
			existing.pending.cooldownUntil = cooldownUntil;
			existing.pending.reason = reason;
			existing.pending.incrementStreak = incrementStreak;
			existing.pending.receiptOwner = receiptOwner;
		}
		const pending = existing.pending;
		// A stronger pending payload supersedes its previous owner. Tied or
		// weaker followers await the same write without claiming its mutation.
		return pending.promise.then((result) =>
			pending.receiptOwner === receiptOwner
				? result
				: { ...result, applied: false },
		);
	}

	const writePromise = invokeMarkAccountRateLimited(account.id, payload);
	const state: RateLimitWriteState = {
		active: payload,
		activePromise: writePromise,
		pending: null,
	};
	inFlightRateLimitWrites.set(account.id, state);
	observeRateLimitWrite(account.id, state, writePromise);
	return writePromise;
}

/**
 * Durable-write variant of applyRateLimitCooldown: identical in-memory cooldown
 * math and audit-reason derivation, but AWAITS the DB-side single-row UPDATE
 * directly instead of enqueueing it on the (fire-and-forget) async writer queue.
 *
 * Required for the native xAI direct-evidence failover path (R9): account
 * selection reads fresh account state from the DB on every request rather than
 * consulting a process-local breaker, so a fire-and-forget write could let a
 * fast follow-up request (e.g. an immediate next turn in the same conversation)
 * race ahead of the durable cooldown and reselect the same still-cooling-down
 * account. Callers on this path must await this function before treating
 * failover as safe to proceed.
 *
 * Returns the durable write receipt, or null when persistence failed/timed out.
 * A false applied flag includes the in-memory or database forward guard.
 *
 * @param account - The account that just received a directly-observed rate
 *   limit / capacity signal (mutated in place).
 * @param rateLimitInfo - Same shape and semantics as applyRateLimitCooldown.
 * @param ctx - The proxy context (provides dbOps; asyncWriter is intentionally
 *   bypassed for this path).
 */
export async function applyRateLimitCooldownAwaitingPersist(
	account: Account,
	rateLimitInfo: RateLimitCooldownInput,
	ctx: ProxyContext,
): Promise<MarkAccountRateLimitedResult | null> {
	const { cooldownUntil, reason, isTransientUpstream, skipped } =
		applyRateLimitCooldownInMemory(account, rateLimitInfo);
	if (skipped) {
		return {
			consecutiveRateLimits: account.consecutive_rate_limits ?? 0,
			applied: false,
		};
	}

	// The durable single-row UPDATE is awaited (not enqueued) so failover
	// selection -- which reads fresh account state from the DB on every request,
	// see the class doc comment above -- observes it before this promise
	// resolves. But on SQLite, withBusyRetry can legitimately stall a write for
	// up to 10 minutes while another process holds an exclusive VACUUM lock:
	// the same accepted tradeoff documented on async-writer.ts's
	// runJobWithWatchdog ("DB job failed" logging, un-cancellable background
	// writes bounded only by the process-level shutdown watchdog). Blocking the
	// request path on that stall would be worse than the race this await exists
	// to prevent, so it is bounded here: past the timeout, or on an outright
	// rejection, fall back to the in-memory-only cooldown already computed by
	// applyRateLimitCooldownInMemory above and let the write converge in the
	// background. Do not try to abort/cancel the underlying SQLite call --
	// there is nothing to cancel it with, and a second timer layered on top
	// would only orphan the original promise without shortening the real wait.
	let persistedResult: MarkAccountRateLimitedResult | null = null;
	try {
		persistedResult = await raceWithTimeout(
			getOrStartMarkAccountRateLimited(
				ctx,
				account,
				cooldownUntil,
				reason,
				!isTransientUpstream,
			),
			getRateLimitPersistAwaitTimeoutMs(),
		);
	} catch (err) {
		log.error(
			`[ccflare] account=${account.name} id=${account.id} cooldown_persist_failed reason=${reason}`,
			err,
		);
	}

	if (persistedResult !== null) {
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 402/429s for the same account). Skipped for overload:
		// the streak is not touched by a 529 (with or without reset), so there is
		// nothing to reconcile.
		if (!isTransientUpstream) {
			account.consecutive_rate_limits = persistedResult.consecutiveRateLimits;
		}
	} else {
		log.warn(
			`[ccflare] account=${account.name} cooldown_persist_deferred reason=${reason} -- proceeding with in-memory streak=${account.consecutive_rate_limits}`,
		);
	}
	if (persistedResult?.applied === false) {
		log.warn(
			`[ccflare] account=${account.name} cooldown_write_skipped reason=${reason} candidate_until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedResult.consecutiveRateLimits} (existing later cooldown or row absent)`,
		);
		return persistedResult;
	}
	if (persistedResult?.applied) {
		log.warn(
			`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${account.consecutive_rate_limits}`,
		);
	}

	if (isTransientUpstream) {
		// A 529 or 5xx is a transient upstream server state, not a quota signal —
		// emitting a RateLimitError here would misdiagnose it as account
		// exhaustion. Log honestly instead.
		log.warn(
			`[ccflare] account=${account.name} upstream_transient_failure reason=${reason} until=${new Date(cooldownUntil).toISOString()} (transient upstream failure — streak untouched)`,
		);
		return persistedResult;
	}

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
	return persistedResult;
}

/**
 * Awaits `promise`, but resolves with null instead once `timeoutMs` elapses.
 * The timer is always cleared once either side settles, so a fast-resolving
 * `promise` does not leave a dangling timer keeping the event loop alive.
 * The losing side (whichever settles second) is left to settle on its own;
 * Promise.race already attaches a rejection handler to both inputs, so a late
 * rejection from the losing promise never surfaces as an unhandled rejection.
 */
function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		clearTimeout(timer);
	});
}
