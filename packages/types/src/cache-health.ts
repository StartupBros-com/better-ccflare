import type { AlertSeverity } from "./alerts";

export const CACHE_HEALTH_BUCKET_MS = 10 * 60_000;
export const CACHE_HEALTH_INTERVAL_MS = 5 * 60_000;
export const CACHE_HEALTH_SETTLEMENT_MS = 2 * 60_000;
export const CACHE_HEALTH_CATCHUP_MS = 30 * 60_000;

export interface CacheHealthAccountGeneration {
	accountId: string;
	accountGeneration: number;
}

/** Server-owned facts captured at dispatch, never copied from client marker headers. */
export interface RequestAccountingContext {
	accountGeneration: number | null;
	provider: string;
	/** Physical attempt target, used only when observed response usage has no model. */
	model?: string | null;
	nativeCache: boolean;
	internal: boolean;
}

export interface CacheHealthScope {
	kind: "account" | "provider";
	provider: string;
	model: string;
	accountId: string | null;
	accountGeneration: number | null;
}

/** Labels never participate in identity. JSON tuples avoid delimiter collisions. */
export function cacheHealthScopeKey(scope: CacheHealthScope): string {
	return JSON.stringify([
		scope.kind,
		scope.provider,
		scope.model,
		scope.accountId,
		scope.accountGeneration,
	]);
}

export interface CacheHealthEvidence {
	startMs: number;
	endMs: number;
	eligible: number;
	measured: number;
	missing: number;
	invalid: number;
	zeroInput: number;
	failed: number;
	internal: number;
	zeroHit: number;
	/** All three token fields are additive; prompt_tokens is never added. */
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalsValid: boolean;
	contributors: CacheHealthAccountGeneration[];
}

export interface CacheHealthBucket extends CacheHealthEvidence {
	scope: CacheHealthScope;
	/** Request-time native capability, independent of observed hits. */
	native: boolean;
}

export interface CacheHealthPolicy {
	warningPercent: number;
	criticalPercent: number;
	recoveryPercent: number;
	warningBuckets: number;
	minimumRequests: number;
	minimumInputTokens: number;
	minimumCoveragePercent: number;
	telemetryGapPercent: number;
	telemetryReportingPercent: number;
	telemetryRecoveryPercent: number;
	telemetryBuckets: number;
	recoveryBuckets: number;
	reminderMs: number;
}

/** Shared by configuration and the pure detector; no HTTP dependency. */
export const CACHE_HEALTH_DEFAULT_POLICY: Readonly<CacheHealthPolicy> =
	Object.freeze({
		warningPercent: 90,
		criticalPercent: 50,
		recoveryPercent: 92,
		warningBuckets: 3,
		minimumRequests: 10,
		minimumInputTokens: 100_000,
		minimumCoveragePercent: 90,
		telemetryGapPercent: 80,
		telemetryReportingPercent: 95,
		telemetryRecoveryPercent: 90,
		telemetryBuckets: 3,
		recoveryBuckets: 2,
		reminderMs: 6 * 60 * 60_000,
	});

export interface CacheHealthStreak {
	buckets: number;
	evidence: CacheHealthEvidence;
}

export interface CacheHealthIncident {
	sequence: number;
	severity: "warning" | "critical";
	lastNotificationAt: number;
}

export interface CacheHealthSignalState {
	sequence: number;
	incident: CacheHealthIncident | null;
	bad: CacheHealthStreak | null;
	recovery: CacheHealthStreak | null;
}

/** Bounded operational snapshot; no request ids, payloads, or session ids. */
export interface CacheHealthState {
	version: 1;
	scope: CacheHealthScope;
	revision: number;
	lastBucketEnd: number;
	policyFingerprint: string;
	/** Persisted positive-cache evidence; native capability is checked per bucket. */
	enrolled: boolean;
	/** The most recent two qualified healthy bucket ends. */
	healthyEnds: number[];
	reportingEnd: number | null;
	contributors: CacheHealthAccountGeneration[];
	reuse: CacheHealthSignalState;
	telemetry: CacheHealthSignalState;
}

export type CacheHealthAlertType =
	| "cache_efficiency_low"
	| "cache_efficiency_critical"
	| "cache_telemetry_gap"
	| "cache_efficiency_recovered";

/** Pure description for the existing alert service to render into an AlertEvent. */
export interface CacheHealthAlertDecision {
	id: string;
	type: CacheHealthAlertType;
	severity: AlertSeverity;
	scope: CacheHealthScope;
	reason: "reuse" | "telemetry";
	phase: "opened" | "escalated" | "reminder" | "recovered";
	sequence: number;
	timestamp: number;
	threshold: number;
	reusePercent: number | null;
	coveragePercent: number | null;
	zeroHitPercent: number | null;
	evidence: CacheHealthEvidence;
}

/** Compatibility zeros are recorded telemetry, not proof of upstream measurement. */
export function isNativeCacheHealthRoute(
	provider: string,
	officialXai: boolean,
): boolean {
	return (
		provider === "anthropic" ||
		provider === "codex" ||
		(provider === "xai" && officialXai)
	);
}
