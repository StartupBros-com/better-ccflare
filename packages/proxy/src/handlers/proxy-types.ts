import { timingSafeEqual } from "node:crypto";
import type {
	Config,
	ImplicitFallbackPolicyConfig,
	RuntimeConfig,
} from "@better-ccflare/config";
import type {
	AsyncDbWriter,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Provider } from "@better-ccflare/providers";
import type { LoadBalancingStrategy, RequestMeta } from "@better-ccflare/types";
import type { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import type { DegradedModeObservability } from "../anthropic-degraded-observability";
import type { CacheAffinityOrderer } from "../cache-affinity-orderer";
import type { CohortSealService } from "../cache-flight-cohort-seal";
import type { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ModelRouteSessionRegistry } from "../model-route-profiles";
import type { ServerToolReplayRuntimeState } from "../server-tool-replay-runtime";
import type { GuardCorrelationVerifier } from "./guard-correlation-auth";
// Type-only, so the runtime edge stays one-way (proxy-operations imports
// values from here, never the reverse).
import type { PoolExhaustionKind } from "./proxy-operations";

const trustedNativeResponsesRequests = new WeakSet<RequestMeta>();

/**
 * Mark a request created by the authenticated /v1/responses adapter. A
 * WeakSet keeps this trust bit in-process: no client header can forge it and
 * no request metadata field can accidentally be serialized or persisted.
 */
export function markTrustedNativeResponses(requestMeta: RequestMeta): void {
	trustedNativeResponsesRequests.add(requestMeta);
}

export function isTrustedNativeResponses(requestMeta: RequestMeta): boolean {
	return trustedNativeResponsesRequests.has(requestMeta);
}

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	cacheAffinityOrderer?: CacheAffinityOrderer;
	/** Process-local producer for immutable cache-flight cohort receipts. */
	cacheFlightCohortSeal?: CohortSealService;
	/** One restart-scoped coordinator shared by every request in this server. */
	anthropicDegradedMode: AnthropicDegradedModeCoordinator;
	/** Process-local aggregate counters plus default-off detailed diagnostics. */
	anthropicDegradedObservability: DegradedModeObservability;
	/** Bounded owner continuity state colocated with the coordinator. */
	degradedOwnerOverlay: DegradedOwnerOverlay;
	/** Observe-only owner simulation; never read by enforcement. */
	degradedOwnerShadowOverlay: DegradedOwnerOverlay;
	/** Restart-scoped replay readers; writer admission remains independently gated. */
	serverToolReplay?: ServerToolReplayRuntimeState;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	config: Config;
	/** Restart-scoped admission policy for implicit normal/combo fallback. */
	implicitFallbackPolicy?: ImplicitFallbackPolicyConfig;
	provider: Provider;
	refreshInFlight: Map<string, Promise<string>>;
	asyncWriter: AsyncDbWriter;
	internalProbeSecret?: string;
	/** Verifies guard correlation without exposing the env-only credential. */
	guardCorrelationVerifier?: GuardCorrelationVerifier;
	/** Restart-scoped Claude Code gateway route profiles and session bindings. */
	modelRouteSessionRegistry?: ModelRouteSessionRegistry;
}

/** Error messages used throughout the proxy module */
export const ERROR_MESSAGES = {
	NO_ACCOUNTS:
		"No active accounts available - forwarding request without authentication",
	PROVIDER_CANNOT_HANDLE: "Provider cannot handle path",
	REFRESH_NOT_FOUND: "Refresh promise not found for account",
	UNAUTHENTICATED_FAILED: "Failed to forward unauthenticated request",
	ALL_UPSTREAM_ROUTES_FAILED:
		"All compatible upstream routes failed to proxy the request",
	TOKEN_REFRESH_FAILED: "Failed to refresh access token",
	PROXY_REQUEST_FAILED: "Failed to proxy request with account",
	POOL_EXHAUSTED: "All accounts are temporarily unavailable",
} as const;

/**
 * The `error.type` values better-ccflare puts in a refusal it generates
 * ITSELF, as opposed to anything an upstream provider ever sends:
 *
 * - `pool_exhausted` / `circuit_open` — {@link createPoolExhaustedResponse}
 *   (`error.type = kind`) in proxy-operations.ts;
 * - `service_unavailable_error` — the refusal helpers at the top of proxy.ts
 *   (which add a `code`) and the server's catch-all for
 *   {@link ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (which does not).
 *
 * The auto-refresh scheduler tests a failed probe's body against this set
 * before exempting it from failure accounting. Status alone is not enough: a
 * forced probe legitimately reaches a rate-limited account (the selector's
 * bypass exists for that), and the transient-5xx retry is disabled for
 * internal probes, so a genuine upstream 503 arrives at the scheduler
 * unchanged. Without the shape test a truly broken endpoint on a benched
 * account could never reach the failure threshold.
 *
 * No collision with the providers: Anthropic sends invalid_request_error,
 * authentication_error, permission_error, not_found_error, request_too_large,
 * rate_limit_error, api_error and overloaded_error; OpenAI sends server_error,
 * insufficient_quota and friends.
 */
export const LOCAL_REFUSAL_ERROR_TYPES: ReadonlySet<string> = new Set([
	"pool_exhausted",
	"circuit_open",
	"service_unavailable_error",
	"service_unavailable",
	"force_route_unavailable",
] as const satisfies readonly (
	| PoolExhaustionKind
	| "service_unavailable_error"
	| "service_unavailable"
	| "force_route_unavailable"
)[]);

/** Timing constants */
export const TIMING = {
	WORKER_SHUTDOWN_DELAY: 100, // ms
} as const;

/** HTTP headers used in proxy operations */
export const HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;

/** Header carrying the process-local secret that gates internal-probe markers */
export const INTERNAL_PROBE_SECRET_HEADER =
	"x-better-ccflare-internal-probe-secret";

/** Process-local authentication for the Responses adapter's synthetic request. */
export const RESPONSES_ADAPTER_SECRET_HEADER =
	"x-better-ccflare-responses-adapter-secret";

export function isResponsesAdapterRequest(
	headers: Headers | null | undefined,
	ctx: Pick<ProxyContext, "internalProbeSecret">,
): boolean {
	if (!headers || !ctx.internalProbeSecret) return false;
	const provided = headers.get(RESPONSES_ADAPTER_SECRET_HEADER);
	if (!provided) return false;
	// Mirrors http-api auth-service's timingSafeStringEqual without introducing
	// a proxy -> http-api dependency. Secret formats have a fixed public length.
	const providedBytes = Buffer.from(provided, "utf8");
	const expectedBytes = Buffer.from(ctx.internalProbeSecret, "utf8");
	return (
		providedBytes.length === expectedBytes.length &&
		timingSafeEqual(providedBytes, expectedBytes)
	);
}

/**
 * Determines whether a request is a legitimate internal probe (auto-refresh
 * or cache-keepalive) rather than an external client forging the marker
 * headers. Requires the process-local secret to match in addition to the
 * marker header(s).
 */
export function isInternalProbe(
	headers: Headers | null | undefined,
	ctx: Pick<ProxyContext, "internalProbeSecret">,
	marker: "auto-refresh" | "keepalive" | "any" = "any",
): boolean {
	if (!headers || !ctx.internalProbeSecret) return false;
	if (headers.get(INTERNAL_PROBE_SECRET_HEADER) !== ctx.internalProbeSecret)
		return false;
	const hasAutoRefresh =
		headers.get("x-better-ccflare-auto-refresh") === "true";
	const hasKeepalive = headers.get("x-better-ccflare-keepalive") === "true";
	if (marker === "auto-refresh") return hasAutoRefresh;
	if (marker === "keepalive") return hasKeepalive;
	return hasAutoRefresh || hasKeepalive;
}
