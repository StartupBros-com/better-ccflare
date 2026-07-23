import { Logger } from "@better-ccflare/logger";

const log = new Logger("CacheBodyStore");

/**
 * In-memory store for the last request body per account that created or read a
 * cache entry.
 *
 * Flow:
 *  1. When a request body is buffered in the proxy, stageRequest() is called.
 *  2. When the post-processor emits a summary, onSummary() is called.
 *     - If cache creation or read tokens are positive, the staged entry is
 *       promoted to the per-account "last cached request" slot.
 *     - The staging entry is always deleted (request is complete).
 *  3. The keepalive scheduler reads getLastCachedRequest() at tick time and
 *     replays the body through the proxy.
 *
 * Memory bounds:
 *  - stagingMap: one entry per in-flight request, cleared on completion → bounded
 *    by concurrent request count.
 *  - lastCachedRequest: one entry per account → bounded by account count.
 *
 * Note: client headers ARE stored because some providers (e.g. Anthropic) copy
 * incoming headers in prepareHeaders() and augment them, so the replay needs to
 * carry the original client headers to produce an identical upstream request.
 * Providers that build headers from scratch (Qwen, Bedrock) simply ignore them.
 *
 * Sensitive and internal headers are stripped before storing.
 */

/**
 * Only cache requests to this path — other endpoints don't use prompt cache.
 */
const CACHEABLE_PATH = "/v1/messages";

/** Maximum number of in-flight staging entries. Oldest is evicted when exceeded. */
const MAX_STAGING_ENTRIES = 200;

/** Maximum age for a staging entry before it is swept out. */
const STAGING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Byte patterns to search for in the request body to detect cache_control hints.
 * Both quoted forms cover JSON key serialization styles.
 */
const CACHE_CONTROL_HINTS: Uint8Array[] = [
	new TextEncoder().encode('"cache_control"'),
	new TextEncoder().encode('"cache-control"'),
];

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	const hLen = haystack.length;
	const nLen = needle.length;
	if (nLen === 0) return true;
	if (nLen > hLen) return false;
	outer: for (let i = 0; i <= hLen - nLen; i++) {
		for (let j = 0; j < nLen; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

export function hasCacheControlHint(body: ArrayBuffer): boolean {
	const bytes = new Uint8Array(body);
	return CACHE_CONTROL_HINTS.some((hint) => containsBytes(bytes, hint));
}

export interface CachedRequestEntry {
	/** Replay-safe source body after route/model selection, before provider transform. */
	body: Buffer;
	/** Sanitized original client headers (no auth, no internal proxy headers). */
	headers: Record<string, string>;
	/** Request path, e.g. "/v1/messages". */
	path: string;
	/** Unix timestamp when this entry was recorded. */
	timestamp: number;
	/** Exact physical model used by the cache-writing transport. */
	resolvedModel: string | null;
}

// Strip sensitive and internal headers before storing.
// Auth headers are injected by prepareHeaders() from account credentials.
// Internal x-better-ccflare-* headers are injected fresh by the scheduler.
const STRIP_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"x-amz-security-token",
	"cookie",
	"x-better-ccflare-account-id",
	"x-better-ccflare-bypass-session",
	"x-better-ccflare-skip-cache",
	"x-better-ccflare-keepalive",
	"content-length",
	"transfer-encoding",
	"accept-encoding",
	"content-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"host",
]);

class CacheBodyStore {
	/** requestId → { accountId, entry, automaticPrefixCache } while in-flight. */
	private staging = new Map<
		string,
		{
			accountId: string;
			entry: CachedRequestEntry;
			automaticPrefixCache: boolean;
		}
	>();

	/** accountId → last request that created or read a cache entry. */
	private lastCachedRequest = new Map<string, CachedRequestEntry>();

	/** Whether the feature is enabled — skip staging entirely when false. */
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.staging.clear();
			this.lastCachedRequest.clear();
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Called when a request body has been buffered.
	 * Only stages if the feature is enabled and we have a body.
	 *
	 * @param options.automaticPrefixCache When true, stage even without
	 *   Anthropic-style `cache_control` markers. Official xAI Chat uses
	 *   automatic exact-prefix caching, so keepalive eligibility must not
	 *   depend on markers the client may omit.
	 */
	stageRequest(
		requestId: string,
		accountId: string | null,
		body: ArrayBuffer | null,
		headers: Headers,
		path: string,
		cacheIdentityBody: ArrayBuffer | null = body,
		cacheIdentityHasCacheControl?: boolean,
		resolvedModel: string | null = null,
		options?: { automaticPrefixCache?: boolean },
	): void {
		if (!this.enabled) return;

		// A request can execute multiple physical transports through in-place retry,
		// model fallback, or account failover. Each new attempt replaces the prior
		// projection, even when the new transport is not cacheable, so a later
		// response summary can never promote stale residue from a failed route.
		this.staging.delete(requestId);

		if (!accountId || !body || body.byteLength === 0) return;

		// Only cache prompt-cache-relevant endpoint.
		if (path !== CACHEABLE_PATH) return;

		// Marker-based providers (Anthropic) only create cache when the body
		// carries cache_control. Automatic-prefix providers (official xAI) cache
		// without markers, so keepalive must stage those bodies too.
		const cacheable =
			options?.automaticPrefixCache === true ||
			(cacheIdentityHasCacheControl ??
				(cacheIdentityBody !== null &&
					cacheIdentityBody.byteLength > 0 &&
					hasCacheControlHint(cacheIdentityBody)));
		if (!cacheable) {
			return;
		}

		const sanitizedHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			const normalizedKey = key.toLowerCase();
			if (
				!STRIP_HEADERS.has(normalizedKey) &&
				!normalizedKey.startsWith("x-better-ccflare-")
			) {
				sanitizedHeaders[key] = value;
			}
		});

		this.staging.set(requestId, {
			accountId,
			automaticPrefixCache: options?.automaticPrefixCache === true,
			entry: {
				body: Buffer.from(body),
				headers: sanitizedHeaders,
				path,
				timestamp: Date.now(),
				resolvedModel,
			},
		});

		// Enforce size cap: evict oldest entry if over limit.
		if (this.staging.size > MAX_STAGING_ENTRIES) {
			let oldestId: string | null = null;
			let oldestTimestamp = Infinity;
			for (const [id, staged] of this.staging) {
				if (staged.entry.timestamp < oldestTimestamp) {
					oldestTimestamp = staged.entry.timestamp;
					oldestId = id;
				}
			}
			if (oldestId !== null) {
				this.staging.delete(oldestId);
				log.warn(
					`Staging cap (${MAX_STAGING_ENTRIES}) exceeded — evicted oldest entry (requestId=${oldestId})`,
				);
			}
		}

		// Sweep stale entries on every stage call.
		this.sweepStagingByAge();
	}

	/**
	 * Discards a staged entry without promoting it. Call on terminal error paths
	 * (e.g. all-accounts-failed throw) where onSummary will never fire, to prevent
	 * the staging map from leaking memory.
	 */
	discardStaged(requestId: string): void {
		this.staging.delete(requestId);
	}

	/**
	 * Removes staging entries that are older than STAGING_MAX_AGE_MS.
	 * Handles the worker-restart orphan case where onSummary never fires.
	 */
	sweepStagingByAge(): void {
		const cutoff = Date.now() - STAGING_MAX_AGE_MS;
		let swept = 0;
		for (const [id, staged] of this.staging) {
			if (staged.entry.timestamp < cutoff) {
				this.staging.delete(id);
				swept++;
			}
		}
		if (swept > 0) {
			log.info(
				`Swept ${swept} orphaned staging entr${swept === 1 ? "y" : "ies"} older than ${STAGING_MAX_AGE_MS / 1000}s`,
			);
		}
	}

	/**
	 * Called when the post-processor emits a summary for a completed request.
	 * Promotes to per-account slot if caching was used; always cleans up staging.
	 */
	onSummary(
		requestId: string,
		cacheCreationInputTokens: number | undefined,
		success = true,
		cacheReadInputTokens?: number,
		options?: {
			/** Inclusive prompt tokens when the provider reported authoritative usage. */
			totalInputTokens?: number;
			inputTokensPresent?: boolean;
		},
	): void {
		const staged = this.staging.get(requestId);
		this.staging.delete(requestId);

		if (!staged) return;

		const cacheWasUsed =
			(cacheCreationInputTokens ?? 0) > 0 || (cacheReadInputTokens ?? 0) > 0;
		// Automatic-prefix providers (xAI) cache the first request even when
		// cached_tokens is 0. Promote successful cold seeds so keepalive can
		// refresh the entry that was just written.
		const automaticPrefixColdSeed =
			staged.automaticPrefixCache &&
			options?.inputTokensPresent === true &&
			typeof options.totalInputTokens === "number" &&
			Number.isFinite(options.totalInputTokens) &&
			options.totalInputTokens > 0;
		if (success && (cacheWasUsed || automaticPrefixColdSeed)) {
			this.lastCachedRequest.set(staged.accountId, {
				...staged.entry,
				timestamp: Date.now(),
			});
		}
	}

	/**
	 * Returns the last request body that created or read a cache entry for this
	 * account, or null if none is recorded.
	 */
	getLastCachedRequest(accountId: string): CachedRequestEntry | null {
		return this.lastCachedRequest.get(accountId) ?? null;
	}

	/** Returns all accounts that have a recorded cached request. */
	getAllCachedAccounts(): string[] {
		return Array.from(this.lastCachedRequest.keys());
	}

	/** Remove a specific account's cached entry (e.g. account deleted). */
	evict(accountId: string): void {
		this.lastCachedRequest.delete(accountId);
	}

	/**
	 * Evicts cached request entries older than the specified age threshold.
	 * Called at keepalive tick time to prevent replaying stale requests whose
	 * underlying prompt cache has long expired.
	 *
	 * @param ttlMinutes The configured cache TTL in minutes
	 * @param ageMultiplier Multiplier for TTL to determine max age (default: 3)
	 *                      e.g. TTL 5min with multiplier 3 = evict entries older than 15min
	 */
	evictStaleEntries(ttlMinutes: number, ageMultiplier = 3): void {
		const maxAgeMs = ttlMinutes * 60_000 * ageMultiplier;
		const cutoffTime = Date.now() - maxAgeMs;
		let evictedCount = 0;

		for (const [accountId, entry] of this.lastCachedRequest.entries()) {
			if (entry.timestamp < cutoffTime) {
				this.lastCachedRequest.delete(accountId);
				evictedCount++;
			}
		}

		if (evictedCount > 0) {
			const maxAgeMinutes = Math.round(maxAgeMs / 60_000);
			log.info(
				`Evicted ${evictedCount} stale cached request(s) older than ${maxAgeMinutes}min (TTL: ${ttlMinutes}min × ${ageMultiplier})`,
			);
		}
	}
}

export const cacheBodyStore = new CacheBodyStore();
