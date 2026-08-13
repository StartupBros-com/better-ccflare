/**
 * Shared bounds for request-local routing diagnostics. These values are
 * intentionally independent of account-pool size so malformed or future
 * callers cannot create unbounded response/log fields.
 */
export const MAX_ROUTING_SELECTION_DIAGNOSTIC_COUNT = 1_000_000;

export function boundedRoutingSelectionCount(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(
		MAX_ROUTING_SELECTION_DIAGNOSTIC_COUNT,
		Math.max(0, Math.floor(value)),
	);
}
