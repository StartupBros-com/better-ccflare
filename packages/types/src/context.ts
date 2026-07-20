import type { Config } from "@better-ccflare/config";
import type {
	BunSqlAdapter,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Account } from "./account";
import type { AlertEvent } from "./alerts";
import type { RequestMeta } from "./api";
import type { ApiKey } from "./api-key";
import type { IntegrityStatus } from "./stats";
import type { StrategyStore } from "./strategy";

/**
 * A request-lane-local failure of one exact routing candidate.
 *
 * `candidateId` deliberately identifies the immutable route candidate rather
 * than its backing account: combo slots may share one account while carrying
 * different models, tiers, or quota policy.
 */
export interface RoutingCandidateFailureReport {
	candidateId: string;
	reason: string;
	suppressForMs: number;
}

/** A proven complete success for one exact request-lane route candidate. */
export interface RoutingCandidateSuccessReport {
	candidateId: string;
}

/**
 * Request-local recovery evidence for a lane whose viable candidates are all
 * protected by route circuits. This is deliberately separate from account
 * cooldown/capacity evidence: it may justify Retry-After, but never authorizes
 * a whole-pool-exhausted classification.
 */
export interface RouteCircuitRecoveryHint {
	allCandidatesOpen: boolean;
	candidateCount: number;
	probeLeased: boolean;
	retryAt: number | null;
	reason: string | null;
}

// API context for HTTP handlers
export interface APIContext {
	db: BunSqlAdapter;
	config: Config;
	dbOps: DatabaseOperations;
	alertService: {
		listAlerts(limit?: number): Promise<AlertEvent[]>;
		getUnacknowledgedCount(): Promise<number>;
		acknowledgeAlert(id: string): Promise<boolean>;
		acknowledgeAll(): Promise<void>;
	};
	auth?: {
		isAuthenticated: boolean;
		apiKey?: ApiKey;
	};
	runtime?: {
		port: number;
		tlsEnabled: boolean;
	};
	getAsyncWriterHealth?: () => {
		healthy: boolean;
		failureCount: number;
		recentDrops: number;
		queuedJobs: number;
		metadataQueuedJobs: number;
		payloadQueuedJobs: number;
		payloadBytesPending: number;
		oldestMetadataAgeMs: number;
		oldestPayloadAgeMs: number;
		metadataDropped: number;
		payloadDropped: number;
		payloadDroppedBytes: number;
	};
	getUsageWorkerHealth?: () => {
		state: string;
	};
	getIntegrityStatus?: () => IntegrityStatus;
	getStrategy?: () => LoadBalancingStrategy | null;
	/**
	 * Live Anthropic model catalog access, injected by the server entrypoint
	 * (avoids a direct http-api -> proxy type dependency here). Absent when
	 * the catalog has not been wired up (e.g. in narrower test contexts).
	 */
	modelCatalog?: {
		get: () => Promise<{
			models: Array<{
				id: string;
				displayName: string;
				createdAt: string | null;
			}>;
			fetchedAt: number;
			source: "live" | "fallback";
		}>;
		refresh: () => Promise<{ success: boolean; error?: string }>;
	};
}

// Load balancing strategy interface
export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out.
	 * The first account in the list should be tried first.
	 *
	 * Async because implementations may need to await StrategyStore.resumeAccount
	 * (auto-unpause) and only include an account once the DB confirms it actually
	 * resumed it.
	 */
	select(accounts: Account[], meta: RequestMeta): Promise<Account[]>;

	/**
	 * Side-effect-free preview: return the ID of the account that would
	 * be picked first by select() given the current state, or null if
	 * no account is available. MUST NOT mutate any state (no DB writes,
	 * no resumeAccount, no resetSession, no internal counters).
	 */
	peek(accounts: Account[]): string | null;

	/**
	 * Optionally suppress one exact routing candidate for the request's affinity
	 * lane. Implementations must not turn this into global account health state.
	 */
	reportCandidateFailure?(
		meta: RequestMeta,
		failure: RoutingCandidateFailureReport,
	): void;

	/**
	 * Optionally close the circuit for one exact routing candidate in the
	 * request's affinity lane. Callers must report only a proven complete
	 * response (for Anthropic SSE, after a clean terminal `message_stop`), never
	 * merely an HTTP 200 or a stream that emitted partial bytes.
	 */
	reportCandidateSuccess?(
		meta: RequestMeta,
		success: RoutingCandidateSuccessReport,
	): void;

	/**
	 * Optional finite lane-circuit recovery evidence from the strategy that owns
	 * the corresponding route failure state.
	 */
	getRouteCircuitRecoveryHint?(
		meta: RequestMeta,
	): RouteCircuitRecoveryHint | null;

	/**
	 * Optional initialization method to inject dependencies
	 * Used for strategies that need access to a StrategyStore
	 */
	initialize?(store: StrategyStore): void;
}
