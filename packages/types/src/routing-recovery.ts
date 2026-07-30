/** Reserved proxy-to-guard recovery contract headers. */
export const RECOVERY_STATUS_HEADER = "x-better-ccflare-pool-status" as const;
export const RECOVERY_STATUS_EXHAUSTED = "exhausted" as const;
export const RECOVERY_SCOPE_HEADER = "x-better-ccflare-recovery-scope" as const;

// "route" is deliberately narrower than "pool": it says the lane's candidates
// are all held open by route circuits that reopen at a known time, not that
// the whole pool is exhausted. It still authorizes a bounded guard retry,
// because the reopen time is finite and positively known.
export const RECOVERY_SCOPES = ["pool", "model", "route"] as const;
export type RecoveryScope = (typeof RECOVERY_SCOPES)[number];

export type RecoverableRoutingCode =
	| "pool_exhausted"
	| "model_pool_exhausted"
	| "route_unavailable";

export function isRecoveryScope(value: unknown): value is RecoveryScope {
	return value === "pool" || value === "model" || value === "route";
}

export function recoveryScopeForCode(code: unknown): RecoveryScope | undefined {
	if (code === "pool_exhausted") return "pool";
	if (code === "model_pool_exhausted") return "model";
	if (code === "route_unavailable") return "route";
	return undefined;
}
