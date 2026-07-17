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

	const persistedCount = await ctx.dbOps.markAccountRateLimited(
		account.id,
		cooldownUntil,
		reason,
	);
	// Reconcile in-memory counter with the authoritative DB value (may differ
	// under concurrent 402/429s for the same account).
	account.consecutive_rate_limits = persistedCount;
	log.warn(
		`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
	);

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}
