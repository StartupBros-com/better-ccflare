import type { RateLimitReason } from "./account";

/** Public, bounded routing-attempt reasons safe for aggregate telemetry. */
export const ROUTING_ATTEMPT_REASONS = [
	"extra_usage_exhausted",
	"upstream_402_payment_required",
	"windowless_429",
	"model_fallback_429",
	"model_scoped_429",
	"out_of_credits",
	"upstream_429_with_reset",
	"xai_capacity_402",
	"upstream_429_no_reset_probe_cooldown",
	"upstream_529_overloaded_with_reset",
	"upstream_529_overloaded_no_reset",
	"all_models_exhausted_429",
] as const satisfies readonly RateLimitReason[];

export type RoutingAttemptReason = (typeof ROUTING_ATTEMPT_REASONS)[number];

/** Scope at which a routing event was applied; never identifies an account or model. */
export const ROUTING_ATTEMPT_SCOPES = [
	"account",
	"family",
	"model",
	"request",
] as const;

export type RoutingAttemptScope = (typeof ROUTING_ATTEMPT_SCOPES)[number];

/** Supported bounded windows for the public aggregate endpoint. */
export const ROUTING_ATTEMPT_SUMMARY_WINDOWS = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
} as const;

export type RoutingAttemptSummaryWindow =
	keyof typeof ROUTING_ATTEMPT_SUMMARY_WINDOWS;

/** Aggregate outcomes for one reason and scope pair. */
export interface RoutingAttemptReasonScopeSummary {
	reason: RoutingAttemptReason;
	scope: RoutingAttemptScope;
	attemptCount: number;
	distinctRequests: number;
	recoveredRequests: number;
	terminalFailureRequests: number;
	awaitingTerminalRequests: number;
}

/** Identifier-free aggregate for routing events in one bounded window. */
export interface RoutingAttemptSummary {
	/** Earliest retained routing attempt, or null when no telemetry exists. */
	firstObservedAt: string | null;
	totalAttempts: number;
	distinctRequests: number;
	recoveredRequests: number;
	terminalFailureRequests: number;
	awaitingTerminalRequests: number;
	byReasonScope: RoutingAttemptReasonScopeSummary[];
}

/** Public response from GET /api/routing-attempts/summary. */
export interface RoutingAttemptSummaryResponse extends RoutingAttemptSummary {
	window: RoutingAttemptSummaryWindow;
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
}
