/** Reserved proxy-to-guard recovery contract headers. */
export const RECOVERY_STATUS_HEADER = "x-better-ccflare-pool-status" as const;
export const RECOVERY_STATUS_EXHAUSTED = "exhausted" as const;
export const RECOVERY_SCOPE_HEADER = "x-better-ccflare-recovery-scope" as const;

export const RECOVERY_SCOPES = ["pool", "model"] as const;
export type RecoveryScope = (typeof RECOVERY_SCOPES)[number];

export type RecoverableRoutingCode = "pool_exhausted" | "model_pool_exhausted";

export function isRecoveryScope(value: unknown): value is RecoveryScope {
	return value === "pool" || value === "model";
}

export function recoveryScopeForCode(code: unknown): RecoveryScope | undefined {
	if (code === "pool_exhausted") return "pool";
	if (code === "model_pool_exhausted") return "model";
	return undefined;
}
