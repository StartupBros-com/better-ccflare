import type { Config } from "@better-ccflare/config";
import type { CacheFlightKeepalivePolicySnapshot } from "@better-ccflare/core";

export type CacheKeepalivePolicyConfig = Pick<
	Config,
	"getCacheKeepaliveTtlMinutes"
> &
	Partial<Pick<Config, "getXaiCacheKeepaliveTtlMinutes">>;

/** Effective keepalive TTL for one staged entry given global + xAI knobs. */
export function resolveKeepaliveTtlMinutes(
	providerName: string | null | undefined,
	globalTtlMinutes: number,
	xaiTtlMinutes: number,
): number {
	if (providerName === "xai") {
		if (xaiTtlMinutes > 0) return xaiTtlMinutes;
		return globalTtlMinutes > 0 ? globalTtlMinutes : 0;
	}
	return globalTtlMinutes > 0 ? globalTtlMinutes : 0;
}

export function resolveEffectiveXaiKeepalivePolicy(
	globalTtlMinutes: number,
	xaiTtlMinutes: number,
): CacheFlightKeepalivePolicySnapshot {
	const effectiveXaiTtlMinutes = resolveKeepaliveTtlMinutes(
		"xai",
		globalTtlMinutes,
		xaiTtlMinutes,
	);
	return Object.freeze({
		globalTtlMinutes,
		xaiTtlMinutes,
		effectiveXaiEnabled: effectiveXaiTtlMinutes > 0,
		effectiveXaiTtlMinutes:
			effectiveXaiTtlMinutes > 0 ? effectiveXaiTtlMinutes : null,
	});
}

export function readEffectiveXaiKeepalivePolicy(
	config: CacheKeepalivePolicyConfig,
): CacheFlightKeepalivePolicySnapshot {
	const globalTtlMinutes = config.getCacheKeepaliveTtlMinutes();
	const xaiTtlMinutes =
		typeof config.getXaiCacheKeepaliveTtlMinutes === "function"
			? config.getXaiCacheKeepaliveTtlMinutes()
			: 0;
	return resolveEffectiveXaiKeepalivePolicy(globalTtlMinutes, xaiTtlMinutes);
}
