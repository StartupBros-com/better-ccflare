import type { AllowedModel } from "./agent";
import type {
	AgentAttributionSource,
	ProjectAttributionSource,
} from "./request";

/** Combo slot routing info indexed exactly like the returned account array. */
export interface ComboSlotInfo {
	/** The combo name (null when not using combo routing) */
	comboName: string | null;
	/** Account/model pairs, indexed by position in the returned accounts array. */
	slots: Array<{ accountId: string; modelOverride: string }>;
}

/**
 * Immutable routing identity for one configured candidate. Normal routes use
 * one candidate per account; combos use one candidate per slot, so the same
 * account can safely appear with multiple concrete models.
 */
export interface RoutingCandidateMetadata {
	candidateId: string;
	accountId: string;
	/** Account.priority for normal routes; ComboSlot.priority for combo routes. */
	tier: number;
	/** Stable source order within one tier. */
	ordinal: number;
	comboSlotId: string | null;
	modelOverride: string | null;
	/** Model-lane pressure for this exact candidate, when safely comparable. */
	quotaPressure: AccountQuotaPressure | null;
}

/**
 * Coarse, stable quota-pressure buckets used to consume comparable
 * subscription windows before they reset. Higher-pressure bands sort first.
 */
export type QuotaPressureBand =
	| "critical"
	| "urgent"
	| "hot"
	| "warm"
	| "steady"
	| "cold";

/** Request-local quota pressure for one account and concrete model lane. */
export interface AccountQuotaPressure {
	band: QuotaPressureBand;
	/**
	 * Identifies snapshots whose provider, plan, source, and window shape are
	 * comparable. A null key deliberately disables pressure-based reordering.
	 */
	comparisonKey: string | null;
}

export interface RequestMeta {
	id: string;
	method: string;
	path: string;
	timestamp: number;
	agentUsed?: string | null;
	project?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	agentAttributionSource?: AgentAttributionSource | null;
	headers?: Headers;
	/** Authenticated in-process auto-refresh probe; never derived from public hint headers. */
	trustedInternalAutoRefresh?: boolean;
	/** Active combo name (set when combo routing is used) */
	comboName?: string | null;
	/** Combo slot index being attempted (set per-iteration in proxy loop) */
	comboSlotIndex?: number | null;
	/** Per-client session id (from request body metadata.user_id) for session-affinity routing. */
	clientSessionId?: string | null;
	/**
	 * Model- and feature-scoped affinity identity computed before account
	 * selection. This takes precedence over clientSessionId so one conversation's
	 * Fable and Opus traffic can have independent sticky owners.
	 */
	affinityLaneKey?: string | null;
	/** Accounts that are hard-ineligible for this concrete request lane. */
	hardExcludedAccountIds?: ReadonlySet<string> | null;
	/** Comparable per-account quota pressure for this concrete request lane. */
	quotaPressureByAccountId?: ReadonlyMap<string, AccountQuotaPressure> | null;
	/**
	 * Original configured candidates before transient availability/capacity
	 * filtering. Affinity uses this to decide whether snapback is legal.
	 */
	routingCandidateCatalog?: readonly RoutingCandidateMetadata[] | null;
	/** Candidate metadata aligned index-for-index with the current account list. */
	routingCandidates?: readonly RoutingCandidateMetadata[] | null;
	/**
	 * Set by SessionAffinityStrategy (R13 anti-thrash) when an active
	 * suppression window prevents this request from upgrading to an
	 * otherwise-routable better-tier candidate. Downstream orderers that
	 * reorder the already-committed candidate list (e.g. CacheAffinityOrderer)
	 * must not promote this candidate ahead of the committed first candidate.
	 * Null whenever no upgrade is currently being suppressed.
	 */
	affinityUpgradeSuppressedCandidateId?: string | null;
	/**
	 * Optional conversation-level sticky key (e.g. Grok cache-native affinity).
	 * Owned exclusively by the proxy's xAI CacheAffinityOrderer.
	 */
	cacheAffinityKey?: string | null;
	/** True when the Grok cache-native vertical slice has a valid request identity. */
	xaiCacheNativeActive?: boolean;
	/** Privacy-safe native identity fingerprint for cache canary telemetry. */
	xaiCacheIdentityFingerprint?: string | null;
	/** Privacy-safe stable-prefix fingerprint for cache canary telemetry. */
	xaiCachePrefixFingerprint?: string | null;
	/** Stable privacy-safe lookup ID, derived before routing and emitted only after eligibility confirmation. */
	cacheFlightRecorderConversationId?: string | null;
	/** Official xAI accounts eligible for conversation-level cache affinity. */
	xaiCacheEligibleAccountIds?: ReadonlySet<string> | null;
	/** Model the client originally requested, before any agent-preference rewrite. */
	originalModel?: string | null;
	/** Model actually forwarded upstream after an agent-preference rewrite (equal to originalModel when none occurred). */
	appliedModel?: string | null;
	/** Immutable deterministic canary assignment (intention-to-treat). */
	codexPacingCanary?: "control" | "bypass" | null;
	/** Effective action on this request (per-protocol). */
	codexPacingAction?: "paced" | "bypassed" | "crossover-paced" | null;
	/** Privacy-preserving digest of the pacing-canary conversation identity. */
	codexPacingCohortId?: string | null;
	/** One-based physical Codex transport sequence for this logical request. */
	codexTransportAttemptOrdinal?: number;
}

export interface AgentUpdatePayload {
	description?: string;
	/** `null` (or the string "inherit") reverts the agent to inheriting the session model. */
	model?: AllowedModel | null;
	tools?: string[];
	color?: string;
	systemPrompt?: string;
	mode?: "all" | "edit" | "read-only" | "execution" | "custom";
}

// Retention and maintenance API shapes
export interface RetentionGetResponse {
	payloadDays: number;
	requestDays: number;
	storePayloads: boolean;
}

export interface RetentionSetRequest {
	payloadDays?: number;
	requestDays?: number;
	storePayloads?: boolean;
}

export interface CleanupResponse {
	removedRequests: number;
	removedPayloads: number;
	payloadCutoffIso: string | null;
	requestCutoffIso: string;
	dbSizeBytes: number;
	tableRowCounts: Array<{ name: string; rowCount: number; dataBytes?: number }>;
}
