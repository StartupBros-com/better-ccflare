import {
	computeRateLimitBackoffMs,
	getRateLimitMaxCooldownMs,
	logError,
	RateLimitError,
	resolveCooldownUntil,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account, RateLimitReason } from "@better-ccflare/types";
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
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const expiredMatureCooldown =
		account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK &&
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
 * In-memory half of applyRateLimitCooldown / applyRateLimitCooldownAwaitingPersist:
 * computes the exponential-backoff cooldown (capped by upstream reset, if any) and
 * mutates the account in place. Shared so both the fire-and-forget and the
 * awaited-persist variants apply identical cooldown math and audit-reason
 * derivation.
 */
function applyRateLimitCooldownInMemory(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
	},
): { cooldownUntil: number; reason: RateLimitReason } {
	const now = Date.now();
	// Best-effort in-memory computation. The DB write does the authoritative atomic
	// increment; under parallel 429s the second concurrent request may compute one
	// tier short, but the persisted counter still ramps correctly.
	const nextCount = account.consecutive_rate_limits + 1;
	const backoffMs = computeRateLimitBackoffMs(nextCount);
	// When the upstream reset is known, bench until that reset (bounded above by
	// the safety ceiling) instead of discarding a far-future reset and
	// re-probing every ~5min — see resolveCooldownUntil.
	const cooldownUntil = resolveCooldownUntil({
		now,
		backoffMs,
		maxCooldownMs: getRateLimitMaxCooldownMs(),
		resetTime: rateLimitInfo.resetTime,
	});
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.rate_limited_reason = reason;
	account.consecutive_rate_limits = nextCount;
	const wasRecoveryProbe = probeLeases.has(account.id);
	completeRateLimitProbe(account, "cooldown_reapplied");
	if (wasRecoveryProbe) {
		log.info(
			`[ccflare] account=${account.name} cooldown_probe_reapplied reason=${reason} until=${new Date(cooldownUntil).toISOString()}`,
		);
	}

	return { cooldownUntil, reason };
}

/**
 * Single entry point for applying a 429-driven cooldown to an account.
 * Computes exponential-backoff cooldown capped by upstream reset (if any), updates
 * in-memory state, and enqueues the DB-side atomic increment.
 *
 * Must be called from every 429 path (response-processor, model_fallback_429,
 * all_models_exhausted_429, mid-stream sniffer): never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429 (mutated in place).
 * @param rateLimitInfo - `resetTime` (if known) is honored as the cooldown target,
 *   bounded above by the safety ceiling (CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS),
 *   see resolveCooldownUntil. Falls back to the exponential backoff only when
 *   no resetTime is provided.
 *   `remaining` is forwarded to the emitted RateLimitError. `reason` overrides the
 *   auto-derived audit reason.
 * @param ctx - The proxy context (provides asyncWriter + dbOps).
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
	},
	ctx: ProxyContext,
): void {
	const { cooldownUntil, reason } = applyRateLimitCooldownInMemory(
		account,
		rateLimitInfo,
	);

	ctx.asyncWriter.enqueue(async () => {
		const persistedCount = await ctx.dbOps.markAccountRateLimited(
			account.id,
			cooldownUntil,
			reason,
		);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account).
		account.consecutive_rate_limits = persistedCount;
		// Log AFTER the DB write so the reported consecutive= reflects the persisted value.
		log.warn(
			`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
		);
	});

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
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
 * equal deadlines retain the first observed reason, matching the database's
 * strict-greater monotonic clamp. This intentionally adds no process-local
 * selection breaker: selection still always reads fresh account state from
 * the DB.
 */
interface RateLimitPersistPayload {
	ctx: ProxyContext;
	cooldownUntil: number;
	reason: RateLimitReason;
}

interface PendingRateLimitWrite extends RateLimitPersistPayload {
	promise: Promise<number>;
	resolve: (persistedCount: number) => void;
	reject: (error: unknown) => void;
}

interface RateLimitWriteState {
	active: RateLimitPersistPayload;
	activePromise: Promise<number>;
	pending: PendingRateLimitWrite | null;
}

const inFlightRateLimitWrites = new Map<string, RateLimitWriteState>();

function invokeMarkAccountRateLimited(
	accountId: string,
	payload: RateLimitPersistPayload,
): Promise<number> {
	try {
		return Promise.resolve(
			payload.ctx.dbOps.markAccountRateLimited(
				accountId,
				payload.cooldownUntil,
				payload.reason,
			),
		);
	} catch (error) {
		return Promise.reject(error);
	}
}

function observeRateLimitWrite(
	accountId: string,
	state: RateLimitWriteState,
	writePromise: Promise<number>,
	completion?: PendingRateLimitWrite,
): void {
	void writePromise
		.then(
			(persistedCount) => {
				completion?.resolve(persistedCount);
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
	settledPromise: Promise<number>,
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
): PendingRateLimitWrite {
	let resolve!: (persistedCount: number) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<number>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { ...payload, promise, resolve, reject };
}

function getOrStartMarkAccountRateLimited(
	ctx: ProxyContext,
	account: Account,
	cooldownUntil: number,
	reason: RateLimitReason,
): Promise<number> {
	const payload = { ctx, cooldownUntil, reason };
	const existing = inFlightRateLimitWrites.get(account.id);
	if (existing) {
		if (cooldownUntil <= existing.active.cooldownUntil) {
			return existing.activePromise;
		}

		if (!existing.pending) {
			existing.pending = createPendingRateLimitWrite(payload);
		} else if (cooldownUntil > existing.pending.cooldownUntil) {
			existing.pending.ctx = ctx;
			existing.pending.cooldownUntil = cooldownUntil;
			existing.pending.reason = reason;
		}
		return existing.pending.promise;
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
 * @param account - The account that just received a directly-observed rate
 *   limit / capacity signal (mutated in place).
 * @param rateLimitInfo - Same shape and semantics as applyRateLimitCooldown.
 * @param ctx - The proxy context (provides dbOps; asyncWriter is intentionally
 *   bypassed for this path).
 */
export async function applyRateLimitCooldownAwaitingPersist(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
	},
	ctx: ProxyContext,
): Promise<void> {
	const { cooldownUntil, reason } = applyRateLimitCooldownInMemory(
		account,
		rateLimitInfo,
	);

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
	let persistedCount: number | null = null;
	try {
		persistedCount = await raceWithTimeout(
			getOrStartMarkAccountRateLimited(ctx, account, cooldownUntil, reason),
			getRateLimitPersistAwaitTimeoutMs(),
		);
	} catch (err) {
		log.error(
			`[ccflare] account=${account.name} id=${account.id} cooldown_persist_failed reason=${reason}`,
			err,
		);
	}

	if (persistedCount !== null) {
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 402/429s for the same account).
		account.consecutive_rate_limits = persistedCount;
	} else {
		log.warn(
			`[ccflare] account=${account.name} cooldown_persist_deferred reason=${reason} -- proceeding with in-memory streak=${account.consecutive_rate_limits}`,
		);
	}
	log.warn(
		`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${account.consecutive_rate_limits}`,
	);

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
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
