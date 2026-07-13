import { TIME_CONSTANTS } from "@better-ccflare/core";

/**
 * Records which better-ccflare account actually served the most recent request
 * for a given Claude Code session id (the `X-Claude-Code-Session-Id` header).
 *
 * This is live, short-lived state — the read-only foundation for the status-line
 * account badge. It is deliberately in-memory only: the association carries no
 * durable value and a persisted column would force a SQLite + PostgreSQL
 * migration for nothing (R3). Bounds mirror {@link SessionAffinityStrategy}: a
 * 5h TTL swept lazily on access (no timers) and a hard entry cap with
 * oldest-entry eviction, so a buggy or adversarial caller streaming distinct
 * session ids cannot grow the map without bound.
 *
 * The map trusts the client-supplied session id with no ownership check: any
 * proxy caller can overwrite another session's recorded account. That is
 * accepted because the mapping is observational and read-only with no secrets
 * (KTD-1). Revisit before the deferred pinning feature reuses this map, since a
 * forced link would make header spoofing controlling rather than cosmetic.
 */

/** Upper bound on live session→account entries, mirroring MAX_AFFINITY_ENTRIES. */
const DEFAULT_MAX_ENTRIES = 10_000;

interface SessionAccountEntry {
	accountId: string;
	/** Observation (completion) time — drives TTL expiry and eviction recency. */
	recordedAt: number;
	/**
	 * Ordering version = the request's START time. A record/clear only applies
	 * when its version is not older than the stored one, so a slow failing
	 * request cannot clear (or an out-of-order completion overwrite) a mapping a
	 * newer concurrent request already recorded for the same session.
	 */
	version: number;
}

export interface SessionAccountObserverOptions {
	/** Entry lifetime in ms. Defaults to the 5h Anthropic session duration. */
	ttlMs?: number;
	/** Hard cap on live entries before oldest-entry eviction kicks in. */
	maxEntries?: number;
	/** Clock injection so TTL/eviction tests run without mocking Date.now. */
	now?: () => number;
}

export class SessionAccountObserver {
	private ttlMs: number;
	private maxEntries: number;
	private now: () => number;
	private map = new Map<string, SessionAccountEntry>();

	constructor(options: SessionAccountObserverOptions = {}) {
		this.ttlMs =
			options.ttlMs ?? TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
	}

	/** Live entry count — read-only, for tests and ops metrics. */
	get size(): number {
		return this.map.size;
	}

	/**
	 * Record that `accountId` served the request for `sessionId`. A later record
	 * for the same session overwrites (failover, R2) and refreshes the entry's
	 * recency so an active session is never the eviction victim. Empty session or
	 * account ids are ignored (no header / unauthenticated passthrough, AE4).
	 *
	 * `version` is the request's start time; a record whose version is older than
	 * the stored one is dropped, so an out-of-order completion of an earlier
	 * request can't clobber a newer concurrent request's mapping. Defaults to the
	 * current clock (last-observed-wins) when a caller supplies no version.
	 */
	record(
		sessionId: string,
		accountId: string,
		version: number = this.now(),
	): void {
		if (!sessionId || !accountId) return;
		const existing = this.map.get(sessionId);
		if (existing && existing.version > version) return;
		// Only a brand-new key grows the map, so bound-check just then.
		if (!existing) {
			this.evictOldestIfFull();
		}
		this.map.set(sessionId, { accountId, recordedAt: this.now(), version });
	}

	/**
	 * Return the account id last recorded for `sessionId`, or undefined when the
	 * session is unknown or its entry has aged past the TTL (swept on access).
	 */
	get(sessionId: string): string | undefined {
		if (!sessionId) return undefined;
		const entry = this.map.get(sessionId);
		if (!entry) return undefined;
		if (this.now() - entry.recordedAt >= this.ttlMs) {
			this.map.delete(sessionId);
			return undefined;
		}
		return entry.accountId;
	}

	/**
	 * Drop `sessionId`'s entry. A no-op when the session id is absent or empty, or
	 * when a newer request (higher `version`) has already recorded for this session
	 * — so a slow failing request can't erase a newer concurrent success. Defaults
	 * to the current clock when a caller supplies no version.
	 */
	clear(sessionId: string, version: number = this.now()): void {
		if (!sessionId) return;
		const existing = this.map.get(sessionId);
		if (!existing) return;
		if (existing.version > version) return;
		this.map.delete(sessionId);
	}

	/**
	 * When at capacity, evict the least-recently-recorded entry (smallest
	 * recordedAt) before inserting a new one. O(n) only at capacity, which only
	 * happens under pathological unique-session-id input. Mirrors
	 * SessionAffinityStrategy.evictOldestIfFull.
	 */
	private evictOldestIfFull(): void {
		if (this.map.size < this.maxEntries) return;
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.map) {
			if (entry.recordedAt < oldestAt) {
				oldestAt = entry.recordedAt;
				oldestKey = key;
			}
		}
		if (oldestKey !== null) this.map.delete(oldestKey);
	}
}

/**
 * Process-wide singleton. `packages/http-api` imports the read function directly
 * from `@better-ccflare/proxy`, following the `usageCache` singleton precedent
 * (KTD-2).
 */
const observer = new SessionAccountObserver();

/**
 * The Claude Code session id to correlate this request with, or null when the
 * request is synthetic internal traffic that must never mutate the session→
 * account map. Cache-keepalive REPLAYS the original client request (session id
 * and all), force-routed to a specific account, so recording/clearing on it
 * would corrupt the active session's badge; auto-refresh probes carry no session
 * id but are excluded for symmetry. This single chokepoint keeps every observer
 * mutation site (forwardToClient, handleProxy exits, the model-not-found direct
 * return) guarding synthetic traffic identically.
 */
export function sessionIdForObservation(headers: Headers): string | null {
	if (
		headers.get("x-better-ccflare-keepalive") === "true" ||
		headers.get("x-better-ccflare-auto-refresh") === "true"
	) {
		return null;
	}
	return headers.get("x-claude-code-session-id");
}

/**
 * Record the account that served `sessionId`'s most recent request. Pass the
 * request's start time as `version` so concurrent same-session requests resolve
 * by issuance order rather than completion order.
 */
export function recordServedAccount(
	sessionId: string,
	accountId: string,
	version?: number,
): void {
	observer.record(sessionId, accountId, version);
}

/** Look up the account id that last served `sessionId`, if still live. */
export function getServedAccount(sessionId: string): string | undefined {
	return observer.get(sessionId);
}

/**
 * Forget `sessionId`'s association (request completed with no serving account).
 * Pass the request's start time as `version` so a slow failing request can't
 * clear a newer concurrent request's mapping.
 */
export function clearSession(sessionId: string, version?: number): void {
	observer.clear(sessionId, version);
}
