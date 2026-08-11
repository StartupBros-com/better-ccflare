import type { Config, RuntimeConfig } from "@better-ccflare/config";
import type {
	AsyncDbWriter,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Provider } from "@better-ccflare/providers";
import type { LoadBalancingStrategy } from "@better-ccflare/types";
import type { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import type { DegradedModeObservability } from "../anthropic-degraded-observability";
import type { CacheAffinityOrderer } from "../cache-affinity-orderer";
import type { CohortSealService } from "../cache-flight-cohort-seal";
import type { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ModelRouteSessionRegistry } from "../model-route-profiles";
import type { ServerToolReplayRuntimeState } from "../server-tool-replay-runtime";
import type { GuardCorrelationVerifier } from "./guard-correlation-auth";

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
