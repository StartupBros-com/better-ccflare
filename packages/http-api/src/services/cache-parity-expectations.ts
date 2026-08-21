/**
 * Declared cache-parity policy — the expected default for every lever
 * CacheParityPolicySnapshot reports, plus the parity floor the system is
 * expected to hold.
 *
 * This exists so a nonzero lever in the live snapshot never has to be
 * re-investigated from scratch: either it matches this file, or it shows up
 * in the drift report as a deviation that is either acknowledged (owned, by
 * issue number) or not (a real anomaly). See docs/configuration.md "Codex
 * cache parity ownership" for the KEEP/DEFER/RETIRE contract each default
 * below is drawn from.
 */

import type {
	CacheParityDeclaredAcknowledgement,
	CacheParityDeclaredFloor,
	CacheParityDriftEntry,
	CacheParityDriftReport,
	CacheParityLeverKey,
	CacheParityMetrics,
	CacheParityPolicySnapshot,
} from "@better-ccflare/types";

/**
 * Declared default for every lever in CacheParityPolicySnapshot (excluding
 * the `explicitBreakpointSuppressedScopes` observed counter — see
 * CacheParityLeverKey). Values mirror docs/configuration.md:
 *
 * - promptCacheKeyEnabled / cacheKeyMode / pacingMs (60s) /
 *   cacheKeyContinuityPercent (100): KEEP — the proven production controls.
 *   pacingMs and cacheKeyContinuityPercent are recorded as their deployed
 *   values (2026-08-20 plan doc Sources block: `CCFLARE_CACHE_PACING_MS=60000`,
 *   `CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT=100`), not the env-unset
 *   code default, because the ownership table declares them KEPT ON.
 * - explicitBreakpointPercent: DEFER — 0 until the private ChatGPT
 *   subscription endpoint accepts the documented marker on natural traffic.
 * - cacheKeySessionPercent, cacheKeyPrefixShardPercent, codexSettleMs,
 *   turnStatePercent, webSocketPercent: RETIRE — measured worse than or no
 *   better than the KEEP baseline, so declared default is 0.
 * - pacingBypassPercent, globalKeepaliveTtlMinutes,
 *   xaiCacheKeepaliveTtlMinutes: default-off diagnostic/compatibility
 *   surfaces with no parity claim, declared default 0.
 * - turnStateObserveOnly: declared false — moot while turnStatePercent's
 *   declared default is 0 (no cohort is ever eligible for treatment), and
 *   matches the code's own env-unset default.
 */
export const CACHE_PARITY_DECLARED_DEFAULTS: CacheParityPolicySnapshot = {
	promptCacheKeyEnabled: true,
	cacheKeyMode: "conversation",
	cacheKeySessionPercent: 0,
	cacheKeyContinuityPercent: 100,
	cacheKeyPrefixShardPercent: 0,
	pacingMs: 60_000,
	codexSettleMs: 0,
	pacingBypassPercent: 0,
	explicitBreakpointPercent: 0,
	explicitBreakpointSuppressedScopes: 0,
	turnStatePercent: 0,
	turnStateObserveOnly: false,
	webSocketPercent: 0,
	globalKeepaliveTtlMinutes: 0,
	xaiCacheKeepaliveTtlMinutes: 0,
};

/**
 * The parity floor the system is expected to hold — deliberately based on
 * the currently achieved and measured level, not on Anthropic's cache-read
 * number (that remains the longer-range #174 target, tracked separately by
 * the `at_parity` verdict thresholds in cache-parity.ts).
 *
 * Measured source figures for Codex follow-ups (issue #233, seven-day window
 * ending 2026-08-20): 79.1% weighted cache-read, 9.1% zero-hit. The
 * 2026-08-20 plan doc's own seven-day read: 78.91% weighted cache-read,
 * 9.36% zero-hit. The floor below sits at/inside both readings so ordinary
 * measurement noise does not itself register as a breach.
 */
export const CACHE_PARITY_DECLARED_FLOOR: CacheParityDeclaredFloor = {
	weightedCacheReadPercent: 79,
	zeroHitRatePercent: 10,
};

/**
 * Known, owned deviations from CACHE_PARITY_DECLARED_DEFAULTS. A lever
 * listed here reports as an acknowledged deviation in the drift report
 * rather than an unacknowledged anomaly.
 */
export const CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS: Partial<
	Record<CacheParityLeverKey, CacheParityDeclaredAcknowledgement>
> = {
	turnStatePercent: {
		issue: 199,
		note: "CCFLARE_CODEX_TURN_STATE_PERCENT=50 stays as-is pending diagnosis (issue #199 comment, 2026-08-17); measured null as a parity lever.",
	},
};

const DECLARED_LEVER_KEYS: CacheParityLeverKey[] = [
	"promptCacheKeyEnabled",
	"cacheKeyMode",
	"cacheKeySessionPercent",
	"cacheKeyContinuityPercent",
	"cacheKeyPrefixShardPercent",
	"pacingMs",
	"codexSettleMs",
	"pacingBypassPercent",
	"explicitBreakpointPercent",
	"turnStatePercent",
	"turnStateObserveOnly",
	"webSocketPercent",
	"globalKeepaliveTtlMinutes",
	"xaiCacheKeepaliveTtlMinutes",
];

function floorHeldBy(
	metrics: CacheParityMetrics | undefined,
	floor: CacheParityDeclaredFloor,
): boolean {
	if (!metrics) return false;
	const weighted = metrics.weightedCacheReadPercent;
	const zeroHit = metrics.zeroHitRatePercent;
	if (weighted === null || zeroHit === null) return false;
	return (
		weighted >= floor.weightedCacheReadPercent &&
		zeroHit <= floor.zeroHitRatePercent
	);
}

/**
 * Diff a live cache-parity policy snapshot against the declared defaults and
 * report whether the declared floor is currently held.
 *
 * @param codexFollowUpMetrics The authoritative (seven-day) Codex follow-up
 *   metrics, when available — used only to compute `floorHeld`.
 */
export function buildCacheParityDriftReport(
	policy: CacheParityPolicySnapshot,
	codexFollowUpMetrics: CacheParityMetrics | undefined,
): CacheParityDriftReport {
	const deviations: CacheParityDriftEntry[] = [];
	for (const lever of DECLARED_LEVER_KEYS) {
		const declaredValue = CACHE_PARITY_DECLARED_DEFAULTS[lever];
		const liveValue = policy[lever];
		if (declaredValue === liveValue) continue;
		const acknowledgement = CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS[lever] ?? null;
		deviations.push({
			lever,
			declaredValue,
			liveValue,
			acknowledged: acknowledgement !== null,
			acknowledgement,
		});
	}

	return {
		declaredDefaults: CACHE_PARITY_DECLARED_DEFAULTS,
		deviations,
		floor: CACHE_PARITY_DECLARED_FLOOR,
		floorHeld: floorHeldBy(codexFollowUpMetrics, CACHE_PARITY_DECLARED_FLOOR),
	};
}
