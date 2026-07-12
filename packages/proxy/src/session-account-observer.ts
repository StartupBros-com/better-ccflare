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
	recordedAt: number;
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
	 */
	record(sessionId: string, accountId: string): void {
		if (!sessionId || !accountId) return;
		// Only a brand-new key grows the map, so bound-check just then.
		if (!this.map.has(sessionId)) {
			this.evictOldestIfFull();
		}
		this.map.set(sessionId, { accountId, recordedAt: this.now() });
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

	/** Drop `sessionId`'s entry. A no-op when the session id is absent or empty. */
	clear(sessionId: string): void {
		if (!sessionId) return;
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

/** Record the account that served `sessionId`'s most recent request. */
export function recordServedAccount(
	sessionId: string,
	accountId: string,
): void {
	observer.record(sessionId, accountId);
}

/** Look up the account id that last served `sessionId`, if still live. */
export function getServedAccount(sessionId: string): string | undefined {
	return observer.get(sessionId);
}

/** Forget `sessionId`'s association (request completed with no serving account). */
export function clearSession(sessionId: string): void {
	observer.clear(sessionId);
}
