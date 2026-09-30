import type { QualityRouteStatus } from "@better-ccflare/proxy";
import type { QualityDecisionRecord } from "@better-ccflare/types";

/** Current-revision outcome and separately labeled last validated success. Neither is routing authority. */
export interface QualitySessionControlStatus extends QualityRouteStatus {
	status: "known";
	pending: boolean;
	lastSuccessfulHome: QualityRouteStatus["conversations"][number]["home"];
	decisionState: "in-flight" | "settled" | "pending" | "none";
	decision: QualityDecisionRecord | null;
	decisionRequestId: string | null;
	lastSuccessfulDecision: QualityDecisionRecord | null;
	lastSuccessfulDecisionRequestId: string | null;
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
