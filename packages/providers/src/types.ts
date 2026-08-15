import type {
	Account,
	LogicalModelCapability,
	RateLimitReason,
	ServerToolCapabilityDecision,
	ServerToolCapabilityTuple,
	ServerToolReplayAtom,
	ServerToolRequirements,
} from "@better-ccflare/types";
import type { ServerToolHistoryProjection } from "./server-tools/history-projection";
import type {
	ServerToolReplayEnvelopeBinding,
	ServerToolReplayEnvelopePayload,
} from "./server-tools/replay-envelope";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
	/**
	 * Optional provider-supplied typed operational reason. Overrides the
	 * status-derived default reason downstream (response-processor.ts,
	 * rate-limit-cooldown.ts) so a provider can attribute a cooldown to a
	 * more specific cause than a generic upstream 429/529, e.g. XaiProvider's
	 * `xai_capacity_402` for native xAI capacity responses.
	 */
	reason?: RateLimitReason;
}

/**
 * Describes how a provider carries the selected physical model into transport.
 *
 * Cache keepalive replays always retain the normalized, pre-transform source
 * body. Providers that put the model in that source-derived transport (for
 * example a URL path) need no additional mutation. Providers whose transform
 * writes a model into the final JSON body may remap a previously selected
 * fallback and therefore require the proxy to re-assert it after transform.
 */
export type CacheReplayModelStrategy = "normalized-source" | "transformed-body";

export interface ProviderUsageInfo {
	model?: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
}

export interface ProviderAttemptPlanContext {
	readonly request: Request;
	readonly requestBodyBuffer: ArrayBuffer | null;
	readonly account: Account;
	readonly path: string;
	readonly query: string;
	readonly physicalModel: string | null;
	readonly capabilityProofKey: string | null;
	readonly inputReplayMode: readonly ServerToolReplayAtom[];
	readonly outputReplayMode: readonly ServerToolReplayAtom[];
	/**
	 * Request-private synchronous gate invoked immediately before a provider-owned
	 * transport that does not pass through the proxy's fetch boundary.
	 */
	readonly beforePhysicalTransport?: () => void;
	/** Request-private, proof-only history projection authority. */
	readonly serverToolHistoryProjector?: ProviderServerToolHistoryProjector;
	/** Request-private, proof-only replay-envelope issuance authority. */
	readonly serverToolReplayIssuer?: ProviderServerToolReplayIssuer;
}

/**
 * Pure request-local inputs from which a provider may describe one exact
 * server-tool capability tuple. The contract intentionally excludes Request,
 * message content, client-function schemas, credentials I/O, and transport
 * execution state.
 */
export interface ProviderServerToolCapabilityAccountContext {
	readonly provider: string;
	readonly apiKeyConfigured: boolean;
	readonly refreshTokenConfigured: boolean;
	readonly accessTokenConfigured: boolean;
	readonly legacyMirroredApiKey: boolean;
	readonly customEndpoint: string | null;
	readonly customEndpointConfigured: boolean;
	readonly unsafeCustomEndpoint: boolean;
	readonly crossRegionMode: string | null;
	readonly billingType: string | null;
}

export type ProviderServerToolCapabilityRouteClass =
	| "anthropic_messages"
	| "openai_chat_completions"
	| "openai_responses"
	| "other";

/**
 * Bounded semantic route data. Raw request paths and query strings can contain
 * credentials, so capability factories receive only this closed descriptor.
 */
export interface ProviderServerToolCapabilityEndpointContract {
	readonly routeClass: ProviderServerToolCapabilityRouteClass;
	readonly queryPresent: boolean;
}

/** The non-secret immutable context visible to a provider capability factory. */
export interface ProviderServerToolCapabilityContext {
	readonly candidateId: string;
	readonly account: ProviderServerToolCapabilityAccountContext;
	readonly endpointContract: ProviderServerToolCapabilityEndpointContract;
	readonly physicalModel: string;
	readonly requirements: ServerToolRequirements;
}

/** Proxy-side inputs accepted by the capability materializer. */
export interface ProviderServerToolCapabilityMaterializationContext {
	readonly candidateId: string;
	readonly account: Account;
	readonly path: string;
	readonly query: string;
	readonly physicalModel: string;
	readonly requirements: ServerToolRequirements;
}

/**
 * Request-private replay issuance bound to trusted request authority. Callers
 * cannot supply audience or lineage, and the closure must never be persisted
 * on a materialized provider attempt plan.
 */
export type ProviderServerToolReplayIssuer = (
	binding: Omit<ServerToolReplayEnvelopeBinding, "audience" | "lineage">,
	payload: ServerToolReplayEnvelopePayload,
) => Promise<string>;

/** Project one snapshotted Anthropic history using trusted replay authority. */
export type ProviderServerToolHistoryProjector = (
	messages: unknown,
) => Promise<ServerToolHistoryProjection>;

export type ProviderAttemptDataRetryPolicy =
	| Readonly<{ mode: "none"; maxAttempts: 0 }>
	| Readonly<{ mode: "reuse-same-plan"; maxAttempts: number }>;

export type ProviderAttemptNoExecutionDecision =
	| Readonly<{ decision: "proven_no_execution"; reason: string }>
	| Readonly<{ decision: "executing_or_ambiguous" }>;

declare const providerAttemptNoExecutionSnapshotBrand: unique symbol;

/** Canonical bounded response metadata safe for provider classification. */
export interface ProviderAttemptNoExecutionSnapshot {
	readonly status: number;
	readonly headers: readonly (readonly [name: string, value: string])[];
	readonly bodyText: string;
	readonly bodyTruncated: boolean;
	readonly [providerAttemptNoExecutionSnapshotBrand]: true;
}

export interface ProviderAttemptPlan {
	readonly providerName: string;
	readonly targetUrl: string;
	readonly apiFamily: string;
	readonly physicalModel: string | null;
	readonly capabilityProofKey: string | null;
	readonly inputReplayMode: readonly ServerToolReplayAtom[];
	readonly outputReplayMode: readonly ServerToolReplayAtom[];
	readonly dataRetryPolicy: ProviderAttemptDataRetryPolicy;
	readonly classifyNoExecution: (
		snapshot: ProviderAttemptNoExecutionSnapshot,
	) => Promise<ProviderAttemptNoExecutionDecision>;
	readonly cacheReplayModelStrategy: CacheReplayModelStrategy;
	readonly prepareHeaders: (
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	) => Headers;
	readonly transformRequestBody: (request: Request) => Promise<Request>;
	readonly processResponse: (
		response: Response,
		requestHeaders?: Headers,
	) => Promise<Response>;
	readonly parseRateLimit: (response: Response) => RateLimitInfo;
	readonly parseRateLimitFromBody?: (
		response: Response,
	) => Promise<number | undefined>;
	readonly isStreamingResponse?: (response: Response) => boolean;
	readonly extractTierInfo?: (response: Response) => Promise<number | null>;
	readonly extractUsageInfo?: (
		response: Response,
	) => Promise<ProviderUsageInfo | null>;
	readonly parseUsage?: (
		response: Response,
	) => Promise<ProviderUsageInfo | null>;
}

export interface Provider {
	name: string;

	/** How exact physical models are preserved during cache keepalive replay. */
	readonly cacheReplayModelStrategy?: CacheReplayModelStrategy;

	/**
	 * Pure, network-free logical-model support after explicit mappings have been
	 * checked by the registry facade. Implementations must mirror transport
	 * defaults and return preview-safe metadata only.
	 */
	getLogicalModelCapability?(
		logicalModel: string,
		account: Account,
	): LogicalModelCapability;

	/**
	 * Pure, network-free support decision for one exact candidate, endpoint,
	 * model, tool profile, replay shape, and transport contract.
	 */
	resolveServerToolCapability?(
		requirement: ServerToolRequirements,
		tuple: ServerToolCapabilityTuple,
	): ServerToolCapabilityDecision;

	/**
	 * Purely construct the provider-owned exact capability tuple for one
	 * concrete candidate/model, or return undefined when this provider has no
	 * declared implementation. This factory is deliberately synchronous.
	 */
	createServerToolCapabilityTuple?(
		context: ProviderServerToolCapabilityContext,
	): ServerToolCapabilityTuple | undefined;

	/**
	 * Build one synchronous, request-scoped transport plan after the concrete
	 * account and physical model have been selected. Async planners are invalid.
	 */
	createAttemptPlan?(context: ProviderAttemptPlanContext): ProviderAttemptPlan;

	/**
	 * Check if this provider can handle the given request path
	 */
	canHandle(path: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken(account: Account, clientId: string): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 */
	buildUrl(path: string, query: string, account?: Account): string;

	/**
	 * Optional: release provider-local per-attempt state for an attempt that was
	 * registered while its request body was transformed but will never be
	 * dispatched — a duplicate-route skip or a superseded fallback candidate.
	 * Must be idempotent and safe for an unknown attempt ID. Providers that hold
	 * no per-attempt state omit it.
	 */
	abortTurnStateAttempt?(attemptId: string | null | undefined): void;

	/**
	 * Optional: release provider-local per-attempt state for an attempt that DID
	 * reach the wire but produced no response — a socket, TLS, timeout, or abort
	 * failure after dispatch. Such an attempt never reaches `processResponse`, so
	 * nothing else finalizes it. Distinct from `abortTurnStateAttempt` because the
	 * request really was sent: implementations must not annul its request record.
	 * Must be idempotent and safe for an unknown attempt ID.
	 */
	releaseDispatchedTurnStateAttempt?(
		attemptId: string | null | undefined,
	): void;

	/**
	 * Optional: Pre-process the request before building URL
	 * This allows providers to extract information from the request body
	 * before buildUrl is called (e.g., for including model in URL path)
	 */
	prepareRequest?(
		request: Request,
		requestBodyBuffer: ArrayBuffer | null,
		account: Account,
	): void;

	/**
	 * Prepare headers for the provider request
	 * @param headers - Original request headers
	 * @param accessToken - OAuth access token (for Bearer authentication)
	 * @param apiKey - API key (provider-specific header)
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Optionally recover a provider-specific reset timestamp from a bounded
	 * response body when headers alone do not contain it.
	 */
	parseRateLimitFromBody?(response: Response): Promise<number | undefined>;

	/**
	 * Process the response before returning to client
	 */
	processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
	): Promise<Response>;

	/**
	 * Transform the request body before sending to the provider
	 */
	transformRequestBody?(
		request: Request,
		account?: Account,
		beforePhysicalTransport?: () => void,
	): Promise<Request>;

	/**
	 * Extract tier information from response if available
	 */
	extractTierInfo?(response: Response): Promise<number | null>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<ProviderUsageInfo | null>;

	/**
	 * Parse usage information from streaming SSE response if available
	 * This is called for streaming responses to extract usage from final SSE events
	 * Falls back to extractUsageInfo for non-streaming responses
	 */
	parseUsage?(response: Response): Promise<ProviderUsageInfo | null>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string, redirectUri?: string): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}
