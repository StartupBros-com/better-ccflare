/** Client retry guidance for finite pool, model, and route recovery terminals. */
export const ROUTING_RECOVERY_MAX_RETRY_AFTER_SECONDS = 3600;

export function clampFiniteRoutingRecoveryRetryAfterSeconds(
	recoveryAt: number,
	now: number,
): number {
	return Math.max(
		1,
		Math.min(
			ROUTING_RECOVERY_MAX_RETRY_AFTER_SECONDS,
			Math.ceil((recoveryAt - now) / 1000),
		),
	);
}
