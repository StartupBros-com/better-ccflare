import type { Config } from "@better-ccflare/config";

/**
 * The exact slice of `Config` that `readCacheParityPolicy` (insights.ts)
 * reads directly off `context.config` for GET /api/insights/cache-parity.
 *
 * Kept as its own type (rather than `Pick<Config, ...>` inlined at each call
 * site) so a new accessor added to that function shows up here as a type
 * error at every consumer, including this file's own default stub below.
 */
export type CacheParityConfigStub = Pick<
	Config,
	"getCacheKeepaliveTtlMinutes" | "getXaiCacheKeepaliveTtlMinutes"
>;

/**
 * Builds the `Config` stub `createCacheParityHandler` needs.
 *
 * WHY THIS EXISTS: the cache-parity handler's R18 fail-closed guard reads
 * `getXaiCacheKeepaliveTtlMinutes()` directly (see insights.ts) specifically
 * so a missing/renamed accessor throws instead of silently resolving to 0.
 * That guard is only as good as every hand-rolled test config stub staying
 * in sync with it — and twice already, one fixture (SQLite) got a new
 * accessor added while the other (live PostgreSQL) did not, and only one of
 * them ran in CI, so the drift went undetected until the dead fixture was
 * finally exercised. One factory, used by both fixtures, makes that
 * impossible: add a key here once and every caller gets it.
 *
 * `overrides` lets an individual test change one accessor's return value
 * without hand-rolling the rest of the stub.
 */
export function createCacheParityConfigStub(
	overrides: Partial<CacheParityConfigStub> = {},
): CacheParityConfigStub {
	return {
		getCacheKeepaliveTtlMinutes: () => 0,
		getXaiCacheKeepaliveTtlMinutes: () => 0,
		...overrides,
	};
}
