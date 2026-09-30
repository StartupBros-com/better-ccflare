import type { QualityRouteStatus } from "@better-ccflare/proxy";
import type { QualityDecisionEnvelope } from "@better-ccflare/types";

/** Read-only control view; decision remains null until durable U7 explanations. */
export interface QualitySessionControlStatus extends QualityRouteStatus {
	status: "known";
	pending: boolean;
	lastSuccessfulHome: QualityRouteStatus["conversations"][number]["home"];
	decision: QualityDecisionEnvelope | null;
}

// Re-export all types from the centralized types package
export type {
	AccountDeleteRequest,
	AccountResponse,
	AnalyticsResponse,
	APIContext,
	CacheInsightsResponse,
	CacheInsightsRow,
	CleanupResponse,
	ConfigResponse,
	HealthResponse,
	IntegrityStatus,
	ModelPerformance,
	PoolStatus,
	RequestResponse,
	RetentionGetResponse,
	RetentionSetRequest,
	RetentionStatus,
	RoutingHealth,
	StatsResponse,
	StrategyUpdateRequest,
	TimePoint,
	TokenBreakdown,
} from "@better-ccflare/types";
