import { type Account, StrategyName } from "@better-ccflare/types";
import { PAUSE_REASON_NEEDS_REAUTH } from "./errors";

// Array of all strategies for backwards compatibility
export const STRATEGIES = Object.values(StrategyName);

export function isValidStrategy(strategy: string): strategy is StrategyName {
	return Object.values(StrategyName).includes(strategy as StrategyName);
}

// Default load balancing strategy
export const DEFAULT_STRATEGY = StrategyName.Session;

// Helper to check if an account is available (not rate-limited or paused)
export function isAccountAvailable(
	account: Account,
	now = Date.now(),
): boolean {
	return (
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH &&
		!account.paused &&
		(!account.rate_limited_until || account.rate_limited_until < now)
	);
}

/**
 * The minimum (best) numeric tier among a set of currently-routable
 * candidates. Lower numeric priority is the outer routing invariant:
 * session/cache affinity may only reorder within this best-currently-routable
 * tier, never leapfrog it. Shared by SessionAffinityStrategy and
 * CacheAffinityOrderer's legal-snapback checks so the two independent tier
 * computations cannot drift apart. Returns null for an empty input.
 */
export function minimumRoutableTier(tiers: Iterable<number>): number | null {
	let min: number | null = null;
	for (const tier of tiers) {
		if (min === null || tier < min) min = tier;
	}
	return min;
}

// Re-export from types package for backwards compatibility
export { StrategyName } from "@better-ccflare/types";
