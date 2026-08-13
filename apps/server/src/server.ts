import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	Config,
	filterEnabledProviderModelDefaultOverrides,
	loadServerToolReplayKeys,
	type RuntimeConfig,
	readGuardCorrelationSecret,
	resolveConfigPath,
} from "@better-ccflare/config";
import {
	CACHE,
	DEFAULT_STRATEGY,
	getVersion,
	HTTP_STATUS,
	initializeNanoGPTPricingIfAccountsExist,
	installOutboundProxy,
	intervalManager,
	NETWORK,
	registerCleanup,
	registerDisposable,
	setPricingLogger,
	shutdown,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	AsyncDbWriter,
	DatabaseFactory,
	initPayloadEncryption,
} from "@better-ccflare/database";
import {
	AlertService,
	APIRouter,
	AuthService,
	createServerDeviceSetupCoordinator,
} from "@better-ccflare/http-api";
import {
	LeastUsedStrategy,
	SessionAffinityStrategy,
	SessionStrategy,
} from "@better-ccflare/load-balancer";
import { Logger, setConsoleLogging } from "@better-ccflare/logger";
import { handleResponsesRequest } from "@better-ccflare/openai-responses-adapter";
import {
	CODEX_DEFAULT_ENDPOINT,
	fetchCodexUsageData,
	fetchCodexUsageOnDemand,
	getProvider,
	getRankingUtilizationForProvider,
	isCodexSubscriptionEndpoint,
	resolveCodexEndpoint,
	setProviderModelDefaultOverrides,
	type UsageData,
	usageCache,
} from "@better-ccflare/providers";
import {
	canUseInferenceProfileDynamic,
	parseBedrockConfig,
	translateModelName,
} from "@better-ccflare/providers/bedrock";
import {
	AnthropicDegradedModeCoordinator,
	AutoRefreshScheduler,
	CacheAffinityOrderer,
	CacheKeepaliveScheduler,
	CohortSealService,
	configurePendingRotationPersistence,
	createAnthropicDegradedDetailedEventSink,
	createAnthropicDegradedRuntimeHealth,
	createDurableServerToolReplayWriterAdmission,
	createGuardCorrelationVerifier,
	createPendingRotationWal,
	createServerToolReplayRuntime,
	DegradedModeObservability,
	DegradedOwnerOverlay,
	drainUsageCollector,
	forceCloseCircuit,
	getCodexModels,
	getModelCatalog,
	getUsageCollectorHealth,
	getValidAccessToken,
	handleProxy,
	initModelCatalogRefresh,
	initProxy,
	ModelRouteSessionRegistry,
	markAccountTokensFresh,
	type ProxyContext,
	parseModelRouteProfiles,
	refreshModelCatalog,
	registerCodexUsageRefresher,
	registerPollingRestarter,
	registerRefreshClearer,
	restorePendingRotations,
	startGlobalTokenHealthChecks,
	startIntegrityScheduler,
	stopGlobalTokenHealthChecks,
	unregisterCodexUsageRefresher,
} from "@better-ccflare/proxy";
import { validatePathOrThrow } from "@better-ccflare/security";
import {
	type Account,
	type LoadBalancingStrategy,
	type RetentionStatus,
	StrategyName,
	type StrategyStore,
} from "@better-ccflare/types";
import { serve } from "bun";

/**
 * Build a load-balancing strategy from its enum name. Add new strategies here
 * as additional cases. Falls back to SessionStrategy on unknown values.
 */
function buildStrategy(
	name: StrategyName,
	sessionDurationMs: number,
): LoadBalancingStrategy {
	switch (name) {
		case StrategyName.LeastUsed:
			return new LeastUsedStrategy();
		case StrategyName.SessionAffinity:
			return new SessionAffinityStrategy(sessionDurationMs);
		default:
			return new SessionStrategy(sessionDurationMs);
	}
}

// Import embedded dashboard assets (will be bundled in compiled binary)
let embeddedDashboard: Record<
	string,
	{ content: string; contentType: string }
> | null = null;
let dashboardManifest: Record<string, string> | null = null;

// Try to load embedded dashboard (will exist in production build)
try {
	const embedded = await import("@better-ccflare/dashboard-web/dist/embedded");
	embeddedDashboard = embedded.embeddedDashboard;
	dashboardManifest = embedded.dashboardManifest;
} catch {
	// Fallback: try loading from file system (development)
	try {
		const manifestModule = await import(
			"@better-ccflare/dashboard-web/dist/manifest.json"
		);
		dashboardManifest = manifestModule.default as Record<string, string>;
	} catch {
		console.warn("⚠️  Dashboard assets not found - dashboard will be disabled");
	}
}

// Memory monitoring thresholds
const MEMORY_MONITOR_INTERVAL_MS = 60 * 1000;
const MEMORY_GROWTH_WARN_BYTES = 512 * 1024 * 1024;
const MEMORY_GROWTH_ERROR_BYTES = 1024 * 1024 * 1024;

export function supportsRefreshBackedUsagePolling(
	provider: string | null | undefined,
): boolean {
	return provider === "anthropic" || provider === "xai" || provider === "codex";
}

/**
 * Account-level refresh-backed usage polling gate. Unlike Anthropic and xAI,
 * Codex's free wham/usage endpoint only exists on the ChatGPT subscription
 * backend — accounts pointed at a custom OpenAI-compatible endpoint have no
 * equivalent and must not be polled through this path.
 */
export function accountSupportsRefreshBackedUsagePolling(account: {
	provider: string | null;
	custom_endpoint?: string | null;
}): boolean {
	if (!supportsRefreshBackedUsagePolling(account.provider)) return false;
	if (account.provider !== "codex") return true;
	return (
		!account.custom_endpoint ||
		isCodexSubscriptionEndpoint(resolveCodexEndpoint(account.custom_endpoint))
	);
}

/**
 * Routing decision for a request against the dashboard SPA, decoupled from
 * actual file I/O so the "never shadow an API route, the health endpoint,
 * or a proxy request" invariant is unit testable without booting the
 * server.
 *
 * The dashboard SPA + its static assets must be served BEFORE the
 * authentication-gated API router is consulted: the initial browser
 * navigation cannot carry an API key, so exempting dashboard-looking paths
 * inside the shared authenticateRequest() path instead reopened an
 * unauthenticated proxy bypass whenever the dashboard was disabled or its
 * assets were unavailable (upstream providers accept arbitrary paths).
 * Serving here, gated on the dashboard actually being available, means only
 * genuine dashboard content skips auth; every other path (API and proxy)
 * stays authenticated.
 */
export type DashboardRouteDecision =
	| "static-asset"
	| "spa-index"
	| "pass-through";

export function resolveDashboardRoute(
	pathname: string,
	method: string,
	hasManifestEntry: boolean,
): DashboardRouteDecision {
	// Real bundled asset (hashed filename in the manifest): serve regardless
	// of method, matching the original static-asset lookup semantics.
	if (hasManifestEntry) {
		return "static-asset";
	}

	// Client-side routing: only fall back to index.html for safe,
	// body-less navigation methods, and never for a path that is actually
	// an API route, the health endpoint, or a proxy request. Those must
	// stay authenticated below.
	const isApiOrProxyPath =
		pathname.startsWith("/api/") ||
		pathname === "/api" ||
		pathname.startsWith("/v1/") ||
		pathname.startsWith("/messages") ||
		pathname === "/health";
	if ((method === "GET" || method === "HEAD") && !isApiOrProxyPath) {
		return "spa-index";
	}

	return "pass-through";
}

/**
 * Minimal interface satisfied by the `usageCache` singleton in
 * `@better-ccflare/providers`. Declared locally so the bootstrap helper
 * can be unit-tested with a mock without dragging the full UsageCache
 * class (which is not exported) into the public type surface.
 */
export interface UsageCacheRegistrar {
	startPolling(
		accountId: string,
		tokenProvider: () => Promise<string>,
		provider: string,
		intervalMs: number,
		customEndpoint?: string | null,
		onWindowReset?: (accountId: string) => void,
		onCapacityRestored?: (accountId: string) => void,
		onSnapshot?: (accountId: string, data: UsageData) => void,
	): void;
}

/**
 * Register usage polling for a single Minimax account. The Minimax fetcher
 * hits the Token Plan `remains` endpoint with a Bearer API key; no OAuth
 * refresh is required. Mirrors the surrounding nanogpt/zai/kilo pattern:
 * pay-as-you-go, API-key authentication, no window reset callback
 * (Minimax has `requiresSessionTracking: false` in provider-config.ts).
 *
 * Returns true if polling was registered, false if the account is not
 * a Minimax account or has no API key. Extracted from the bootstrap
 * loop so the registration contract is unit-testable.
 *
 * When `logger` is provided AND the account is a Minimax account missing a
 * non-empty API key, emits a `WARN` naming the account. Matches the
 * sibling nanogpt/zai/kilo blocks (Greptile #350 P2): "X account <name> has
 * no API key, skipping usage polling". The account name is the only
 * identifier in the message — never the key value or any part of it.
 */
export function registerMinimaxUsagePolling(
	account: Account,
	usageCache: UsageCacheRegistrar,
	intervalMs: number,
	logger?: Logger,
	onSnapshot?: (accountId: string, data: UsageData) => void,
): boolean {
	if (account.provider !== "minimax") return false;
	if (!account.api_key) {
		logger?.warn(
			`Minimax account ${account.name ?? account.id} has no API key, skipping usage polling`,
		);
		return false;
	}
	const apiKeyProvider = async () => account.api_key || "";
	usageCache.startPolling(
		account.id,
		apiKeyProvider,
		account.provider,
		intervalMs,
		undefined,
		undefined,
		undefined,
		onSnapshot,
	);
	return true;
}

/**
 * Run the Minimax usage-polling bootstrap over a list of accounts. This is the
 * shape of the wiring block `startServer()` runs for every Minimax account at
 * startup — filter for provider === "minimax", then delegate each one to
 * {@link registerMinimaxUsagePolling} which decides whether polling should
 * actually start.
 *
 * Returns the account IDs that were registered (i.e. had a usable API key).
 * Returning the registered IDs rather than a bare count lets callers log the
 * affected accounts and gives tests a stable handle to assert against.
 *
 * `logger` is forwarded to {@link registerMinimaxUsagePolling} so per-account
 * "no API key" warnings surface from the unit-testable helper, keeping
 * behavior consistent with the sibling nanogpt/zai/kilo bootstrap blocks.
 *
 * Extracted from the inline bootstrap block so a regression test can exercise
 * the exact wiring path (filter → forEach → registerMinimaxUsagePolling) with
 * a mixed-provider account list. If the inline block in `startServer()` is
 * removed but this helper still exists and is unit-tested in isolation, the
 * startup-time wiring has no test coverage — that is the gap this function
 * exists to close. Keep the bootstrap block in `startServer()` calling this.
 */
export function bootstrapMinimaxUsagePolling(
	accounts: readonly Account[],
	usageCache: UsageCacheRegistrar,
	intervalMs: number,
	logger?: Logger,
	makeOnSnapshot?: (
		account: Account,
	) => (accountId: string, data: UsageData) => void,
): string[] {
	const minimaxAccounts = accounts.filter((a) => a.provider === "minimax");
	const registered: string[] = [];
	for (const account of minimaxAccounts) {
		if (
			registerMinimaxUsagePolling(
				account,
				usageCache,
				intervalMs,
				logger,
				makeOnSnapshot?.(account),
			)
		) {
			registered.push(account.id);
		}
	}
	return registered;
}

// Helper function to resolve dashboard assets with fallback
function resolveDashboardAsset(assetPath: string): string | null {
	try {
		// Try resolving as a package first
		return Bun.resolveSync(
			`@better-ccflare/dashboard-web/dist${assetPath}`,
			dirname(import.meta.path),
		);
	} catch {
		// Fallback to relative path within the repo (development / mono-repo usage)
		try {
			return Bun.resolveSync(
				`../../../packages/dashboard-web/dist${assetPath}`,
				dirname(import.meta.path),
			);
		} catch {
			return null;
		}
	}
}

// Helper function to serve dashboard files with proper headers
function serveDashboardFile(
	assetPath: string,
	contentType?: string,
	cacheControl?: string,
): Response {
	// Security headers for dashboard files
	const securityHeaders: Record<string, string> = {
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"X-XSS-Protection": "1; mode=block",
		"Referrer-Policy": "strict-origin-when-cross-origin",
	};

	// Add Content Security Policy for HTML files
	const isHtml = assetPath.endsWith(".html") || contentType === "text/html";
	if (isHtml) {
		// Strict CSP for React apps: only bundled scripts and styles from same origin
		securityHeaders["Content-Security-Policy"] = [
			"default-src 'self'",
			"script-src 'self'", // Only bundled scripts from same origin (no inline)
			"style-src 'self' 'unsafe-inline'", // CSS-in-JS and Tailwind require inline styles
			"img-src 'self' data:",
			"font-src 'self' data:",
			"connect-src 'self'", // API calls to same origin only
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		].join("; ");
	}

	// First, try to serve from embedded assets (production)
	if (embeddedDashboard?.[assetPath]) {
		const asset = embeddedDashboard[assetPath];
		const buffer = Buffer.from(asset.content, "base64");
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType || asset.contentType,
				"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
				...securityHeaders,
			},
		});
	}

	// Fallback: try file system (development)
	const fullPath = resolveDashboardAsset(assetPath);
	if (!fullPath) {
		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	}

	// Auto-detect content type if not provided
	if (!contentType) {
		if (assetPath.endsWith(".js")) contentType = "application/javascript";
		else if (assetPath.endsWith(".css")) contentType = "text/css";
		else if (assetPath.endsWith(".html")) contentType = "text/html";
		else if (assetPath.endsWith(".json")) contentType = "application/json";
		else if (assetPath.endsWith(".svg")) contentType = "image/svg+xml";
		else contentType = "text/plain";
	}

	return new Response(Bun.file(fullPath), {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
			...securityHeaders,
		},
	});
}

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let registeredServerId: string | null = null;
let stopRetentionJob: (() => void) | null = null;
let stopOAuthCleanupJob: (() => void) | null = null;
let stopRateLimitCleanupJob: (() => void) | null = null;
let stopDataCleanupJob: (() => void) | null = null;
let stopWalCheckpointJob: (() => void) | null = null;
let stopIntegritySchedulerJob: (() => void) | null = null;
let stopModelCatalogRefreshJob: (() => void) | null = null;
let stopDeviceSetupRecoveryJob: (() => Promise<void>) | null = null;
let autoRefreshScheduler: AutoRefreshScheduler | null = null;
let cacheFlightCohortSealService: CohortSealService | null = null;
let cacheKeepaliveScheduler: CacheKeepaliveScheduler | null = null;
let memoryMonitorInterval: Timer | null = null;
// Track usage polling retry timeouts for cleanup
const usagePollingRetryTimeouts = new Map<string, NodeJS.Timeout>();

export const DEVICE_SETUP_RECOVERY_INTERVAL_MS = 30_000;

export interface DeviceSetupRecoveryCoordinatorLifecycle {
	tick(): Promise<void>;
	dispose(): void;
	drain(): Promise<void>;
}

export interface DeviceSetupRecoveryLifecycleOptions {
	intervalMs?: number;
	schedule?: (
		callback: () => void | Promise<void>,
		intervalMs: number,
	) => unknown;
	cancel?: (handle: unknown) => void;
	onError?: (error: unknown) => void;
}

/**
 * Own the process-level trigger for durable device setup recovery. The
 * coordinator owns the bounded work performed by each tick; this wrapper
 * guarantees that startup completes one tick before recurring work begins and
 * that interval callbacks never overlap.
 */
export async function startDeviceSetupRecoveryLifecycle(
	coordinator: DeviceSetupRecoveryCoordinatorLifecycle,
	options: DeviceSetupRecoveryLifecycleOptions = {},
): Promise<() => Promise<void>> {
	const intervalMs = options.intervalMs ?? DEVICE_SETUP_RECOVERY_INTERVAL_MS;
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
		throw new TypeError("intervalMs must be a positive safe integer");
	}
	const schedule =
		options.schedule ??
		((callback: () => void | Promise<void>, delayMs: number): unknown => {
			const handle = setInterval(callback, delayMs);
			handle.unref?.();
			return handle;
		});
	const cancel =
		options.cancel ??
		((handle: unknown) => {
			clearInterval(handle as ReturnType<typeof setInterval>);
		});
	const reportError = (error: unknown) => {
		try {
			options.onError?.(error);
		} catch {
			// Recovery diagnostics must never tear down the scheduler.
		}
	};

	let stopped = false;
	let inFlight: Promise<void> | null = null;
	let intervalHandle: unknown = null;
	let stopPromise: Promise<void> | null = null;
	const runTick = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (inFlight) return inFlight;
		let result: Promise<void>;
		try {
			result = coordinator.tick();
		} catch (error) {
			reportError(error);
			return Promise.resolve();
		}
		const running = result
			.catch((error) => {
				reportError(error);
			})
			.finally(() => {
				if (inFlight === running) inFlight = null;
			});
		inFlight = running;
		return running;
	};

	await runTick();
	intervalHandle = schedule(() => runTick(), intervalMs);

	return () => {
		if (stopPromise) return stopPromise;
		stopped = true;
		if (intervalHandle !== null) cancel(intervalHandle);
		coordinator.dispose();
		const currentTick = inFlight;
		stopPromise = (async () => {
			if (currentTick) await currentTick;
			await coordinator.drain();
		})();
		return stopPromise;
	};
}

// SSL/TLS configuration
let tlsEnabled = false;

async function cleanupCacheFlightRecorderRetention(
	config: Config,
	dbOps: DatabaseOperations,
	log: Logger,
): Promise<void> {
	try {
		const retentionHours = config.getCacheFlightRecorderRetentionHours();
		const now = Date.now();
		const retentionMs = retentionHours * 60 * 60 * 1000;
		const expired = await dbOps.expireCacheFlightRecorderTimelines(
			now - retentionMs,
			now + retentionMs,
		);
		await dbOps.expireCacheFlightRecorderTombstones(now);
		if (expired > 0) {
			log.info(
				`Expired ${expired} cache flight recorder timelines (retention=${retentionHours}h)`,
			);
		}
	} catch (err) {
		log.error(`Cache flight recorder retention error: ${err}`);
	}
}

// Startup maintenance (one-shot): cleanup only (compaction available via API endpoint)
async function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
) {
	const log = new Logger("StartupMaintenance");
	// Runs the "data-retention-cleanup" interval's own callback via
	// intervalManager.runNow() instead of duplicating its retention logic
	// here. Two independent code paths writing retentionState could race — a
	// startup run that outlives the first hourly tick would overwrite that
	// tick's newer result — because only the periodic registration's
	// isRunning flag guarded against overlap. runNow() shares that exact flag
	// (registered with maxConcurrent: 1), so at most one retention run is
	// ever in flight regardless of whether startup or the interval triggered
	// it, closing the race entirely (Greptile, PR #390). The interval must
	// already be registered before this runs — see the call site.
	const ran = await intervalManager.runNow("data-retention-cleanup");
	if (!ran) {
		log.warn(
			"Skipped startup retention cleanup - periodic run already in progress",
		);
	}
	await cleanupCacheFlightRecorderRetention(config, dbOps, log);
	try {
		// Clean up expired OAuth sessions
		const removedSessions = await dbOps.cleanupExpiredOAuthSessions();
		if (removedSessions > 0) {
			log.info(
				`Startup cleanup removed ${removedSessions} expired OAuth sessions`,
			);
		}
	} catch (err) {
		log.error(`OAuth session cleanup error: ${err}`);
	}
	try {
		// Clear expired rate_limited_until values. Each cleared row is fed to
		// the circuit breaker via recordSuccess — the active-clear path from
		// the circuit-breaker integration design §3. Without this, the breaker
		// would keep an account failed-fast AFTER the upstream recovered
		// (Risk 2, HIGH).
		const now = Date.now();
		const clearedRows = await dbOps.clearExpiredRateLimits(now);
		for (const row of clearedRows) {
			forceCloseCircuit({ provider: row.provider, accountId: row.id }, now);
		}
		if (clearedRows.length > 0) {
			log.info(
				`Cleared ${clearedRows.length} expired rate_limited_until entries`,
			);
		} else {
			log.info("No expired rate_limited_until entries found to clear");
		}
	} catch (err) {
		log.error(`Rate limit cleanup error: ${err}`);
	}
	try {
		// Prune old agent workspaces (not seen in 7 days)
		const { agentRegistry } = await import("@better-ccflare/agents");
		await agentRegistry.pruneOldWorkspaces();
		log.info("Pruned old agent workspaces");
	} catch (err) {
		log.error(`Agent workspace pruning error: ${err}`);
	}
	// Return a no-op stopper for compatibility
	return () => {};
}

/**
 * Pre-warm Bedrock model and inference profile caches for faster first request
 */
async function prewarmBedrockCache(account: Account, region: string) {
	const logger = new Logger("BedrockCachePrewarm");

	try {
		// Pre-warm model cache
		await translateModelName("claude-opus-4-6", account);

		// Pre-warm inference profile cache
		await canUseInferenceProfileDynamic(
			"claude-opus-4-6",
			"geographic",
			account,
		);

		logger.info(`Successfully pre-warmed Bedrock caches for region ${region}`);
	} catch (error) {
		logger.error(
			`Failed to pre-warm Bedrock caches for region ${region}: ${(error as Error).message}`,
		);
	}
}

/**
 * Get a valid access token for `account`, first reloading its current token
 * state from the database so a concurrent writer (e.g. a fresh
 * reauthentication) is picked up before refreshing.
 *
 * R25 (OAuth control-plane hotfix, U8 pro-gate): earlier revisions of this
 * function temporarily resumed a paused account in the DB before calling
 * getValidAccessToken, then restored the paused state afterward, on the
 * theory that a paused row could block token refresh. Investigation proved
 * that's false: neither getValidAccessToken nor anything it calls
 * (refreshAccessTokenSafe, checkRefreshTokenHealth, every OAuth provider's
 * refreshToken implementation, AccountRepository.updateTokens's raw SQL)
 * reads or gates on `paused` anywhere. auto-refresh-scheduler.ts's proactive
 * Codex and OpenAI-compatible token refreshers already refresh tokens on
 * paused rows directly, with no resume/restore dance at all, confirming this
 * is the established pattern elsewhere in this exact codebase. The temporary
 * resume was therefore structurally unnecessary, and it created a real race:
 * getValidAccessToken can legitimately ROTATE the refresh token as part of a
 * normal, successful refresh (some providers, e.g. Codex, rotate on every
 * refresh), persisted via ctx.asyncWriter possibly before the old restore's
 * `finally` block ran. The restore's guard (matching on the refresh_token
 * captured before the resume) then saw the rotated token as a mismatch and
 * silently skipped re-pausing, leaving a manually- or overage-paused account
 * wrongly active forever. Deleting the resume/restore entirely removes this
 * whole race class instead of patching the guard a second time.
 */
export async function refreshPollingAccessToken(
	account: Account,
	proxyContext: ProxyContext,
): Promise<string> {
	// Reload the current token state from the database first to avoid using
	// stale tokens after re-authentication (or any other writer) updated them
	// since this account object was last touched.
	const currentAccount = await proxyContext.dbOps.getAccount(account.id);
	if (currentAccount) {
		account.access_token = currentAccount.access_token;
		account.refresh_token = currentAccount.refresh_token;
		account.expires_at = currentAccount.expires_at;
		markAccountTokensFresh(account);
	}

	return getValidAccessToken(account, proxyContext);
}

/**
 * Start recurring usage polling for `account`, refreshing its access token
 * (via refreshPollingAccessToken, above) each cycle. Retries with backoff up
 * to MAX_RETRY_ATTEMPTS on failure; a permanently-failing account simply
 * stops polling rather than crashing the server.
 */
function startUsagePollingWithRefresh(
	account: Account,
	proxyContext: ProxyContext,
	alertService: AlertService,
	startupDelayMs: number = 0,
	intervalMs: number = 90000,
) {
	const logger = new Logger("UsagePolling");
	const MAX_RETRY_ATTEMPTS = 10;
	let retryCount = 0;

	// Initial polling with token refresh
	const pollWithRefresh = async () => {
		try {
			// Create a token provider function that gets a fresh token each time.
			// For codex it also re-checks endpoint eligibility from the DB on
			// every cycle: a live custom_endpoint edit must not leave a stale
			// loop polling the subscription backend (pro-gate P1) — the throw
			// fails this fetch and stopPolling ends the loop cleanly.
			const tokenProvider = async () => {
				if (account.provider === "codex") {
					const fresh = await proxyContext.dbOps.getAccount(account.id);
					if (fresh && !accountSupportsRefreshBackedUsagePolling(fresh)) {
						usageCache.stopPolling(account.id);
						throw new Error(
							`Codex account ${account.name} no longer targets the subscription backend; usage polling stopped`,
						);
					}
				}
				return refreshPollingAccessToken(account, proxyContext);
			};

			// Start usage polling with the token provider
			usageCache.startPolling(
				account.id,
				tokenProvider,
				account.provider,
				intervalMs,
				undefined, // customEndpoint
				(accountId) => {
					// Usage window has rolled over — reset session tracking so the
					// dashboard reflects the new window without waiting for the next request.
					proxyContext.dbOps
						.resetAccountSession(accountId, Date.now())
						.catch((err) =>
							logger.warn(
								`Failed to reset session for account ${accountId} on window reset: ${err}`,
							),
						);
				},
				(accountId) => {
					// Usage API shows available capacity (<100%). If rate_limited_until is
					// set in the future (seat-reassignment case), clear it now rather than
					// waiting for the natural expiry timer — the polling loop has confirmed
					// the seat is available again.
					proxyContext.dbOps
						.getAccount(accountId)
						.then((acc) => {
							if (
								acc?.rate_limited_until &&
								Number(acc.rate_limited_until) > Date.now()
							) {
								return proxyContext.dbOps
									.forceResetAccountRateLimit(accountId)
									.then(() => {
										logger.info(
											`Cleared stale rate_limited_until for account ${acc.name} (${accountId}): usage polling shows available capacity (seat reassignment or early reset)`,
										);
									});
							}
						})
						.catch((err) =>
							logger.warn(
								`Failed to check/clear rate_limited_until for account ${accountId} on capacity restore: ${err}`,
							),
						);
				},
				(accountId, data) => {
					const now = Date.now();
					proxyContext.dbOps
						.recordUsageSnapshot(accountId, data, now)
						.catch((err) =>
							logger.warn(
								`Failed to record usage snapshot for account ${accountId}: ${err}`,
							),
						);
					// Usage-window threshold / exhaustion-projection alerts
					// (OnWatch). Independent of recordUsageSnapshot above — must not
					// depend on that insert's timing (see the comment in
					// AlertService.buildUsageWindowExhaustionAlert), and a failure
					// here is best-effort telemetry, never fatal to polling.
					// Resolve the CURRENT name at dispatch — the closure-captured
					// name goes stale on rename (pro-gate round-2 finding).
					proxyContext.dbOps
						.getAccount(accountId)
						.then((acc) =>
							alertService.evaluateUsageSnapshot(
								accountId,
								acc?.name ?? account.name,
								data,
								now,
							),
						)
						.catch((err) =>
							logger.warn(
								`Failed to evaluate usage-window alerts for account ${accountId}: ${err}`,
							),
						);
				},
			);

			// Reset retry count on success
			retryCount = 0;
			// Clear any tracked timeout since we succeeded
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}
		} catch (error) {
			logger.error(
				`Error starting usage polling for account ${account.name}:`,
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					accountId: account.id,
					provider: account.provider,
					timestamp: new Date().toISOString(),
					hasAccessToken: !!account.access_token,
					hasRefreshToken: !!account.refresh_token,
					expiresAt: account.expires_at
						? new Date(account.expires_at).toISOString()
						: null,
				},
			);

			// Log additional context for common error types
			if (error instanceof Error) {
				if (
					error.message.includes("401") ||
					error.message.includes("Unauthorized")
				) {
					logger.error(
						`Authentication failed for account ${account.name} - check API credentials`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (
					error.message.includes("network") ||
					error.message.includes("fetch")
				) {
					logger.error(
						`Network error for account ${account.name} - check connectivity`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (error.message.includes("rate limit")) {
					logger.error(
						`Rate limited for account ${account.name} - backing off`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				}
			}

			// Clear any existing retry timeout before scheduling a new one
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}

			// Check if we've exceeded max retry attempts
			retryCount++;
			if (retryCount >= MAX_RETRY_ATTEMPTS) {
				logger.error(
					`Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for account ${account.name}. Please check the account configuration and try restarting the server after resolving issues.`,
				);
				return;
			}

			// Don't restore paused state on error - let the user control pause/resume via API
			// Retry with exponential backoff (5 min, 10 min, 20 min, ...)
			const baseDelayMs = 5 * 60 * 1000; // 5 minutes
			const delayMs = Math.min(
				baseDelayMs * 2 ** (retryCount - 1),
				60 * 60 * 1000, // Cap at 1 hour
			);
			logger.info(
				`Scheduling retry ${retryCount}/${MAX_RETRY_ATTEMPTS} for account ${account.name} in ${Math.round(delayMs / 1000 / 60)} minutes`,
			);

			const timeoutId = setTimeout(() => {
				logger.info(
					`Retrying usage polling for account ${account.name} (attempt ${retryCount}/${MAX_RETRY_ATTEMPTS})`,
				);
				usagePollingRetryTimeouts.delete(account.id);
				pollWithRefresh();
			}, delayMs);

			// Track the timeout for cleanup
			usagePollingRetryTimeouts.set(account.id, timeoutId);
		}
	};

	// Start the polling (with optional startup delay to stagger multiple accounts)
	if (startupDelayMs > 0) {
		setTimeout(() => pollWithRefresh(), startupDelayMs);
	} else {
		pollWithRefresh();
	}
}

// Above this WAL file size, the periodic checkpoint tick log escalates to WARN.
// With the main connection at wal_autocheckpoint=0 (see database-operations.ts)
// this tick is the SOLE WAL reclaimer, so a WAL that stays large means TRUNCATE
// is being starved (a long-lived reader perpetually holding frames) and is
// trending toward disk-fill, which must be visible, not buried at DEBUG. A
// healthy sawtooth resets to ~0 each reader-idle tick.
export const WAL_SIZE_WARN_MIB = 256;

/**
 * Pure formatter for the wal-checkpoint job's per-tick log line. Extracted
 * from the `registerCleanup` callback so the level/threshold logic is unit
 * testable without spinning up the server.
 */
export function formatWalCheckpointLog(
	result: {
		ok: boolean;
		skipped: boolean;
		error?: string;
		durationMs?: number;
	},
	walBytes: number,
	warnThresholdMiB: number = WAL_SIZE_WARN_MIB,
): { level: "warn" | "debug"; message: string } {
	if (!result.ok) {
		return {
			level: "warn",
			message: `WAL checkpoint/optimize error: ${result.error}`,
		};
	}
	// This tick is the sole WAL reclaimer, so surface the WAL size every tick:
	// a WAL trending toward disk-fill (reader-starved TRUNCATE, or repeated
	// skips) escalates to WARN; otherwise DEBUG. Duration surfaces the
	// optimize+checkpoint's writer-slot hold: a bounded ANALYZE (PRAGMA
	// analysis_limit in the worker, see incremental-vacuum-worker.ts) keeps
	// this in the single-digit/low-tens ms range, a spike back into the
	// hundreds/seconds means ANALYZE is scanning unbounded again.
	const walMiB = walBytes / (1024 * 1024);
	const status = result.skipped ? "skipped (DB busy)" : "ran";
	const timing = result.durationMs != null ? ` in ${result.durationMs}ms` : "";
	if (walMiB > warnThresholdMiB) {
		return {
			level: "warn",
			message: `WAL checkpoint ${status}${timing}; WAL ${walMiB.toFixed(1)}MiB exceeds ${warnThresholdMiB}MiB, reclaim may be starved by a long-lived reader`,
		};
	}
	return {
		level: "debug",
		message: `checkpoint/optimize ${status}${timing}; WAL ${walMiB.toFixed(1)}MiB`,
	};
}

// Export for programmatic use
let serverLifecycleOwned = false;

export default async function startServer(options?: {
	port?: number;
	withDashboard?: boolean;
	sslKeyPath?: string;
	sslCertPath?: string;
}) {
	// From here on, this process owns a server lifecycle: the module-scope
	// signal handlers below act, and the CLI's own handlers stand down.
	serverLifecycleOwned = true;
	// Headless serve mode has no TUI to protect: route WARN/ERROR (and any
	// enabled level) to the console so journald/terminal actually see them.
	setConsoleLogging(true);
	// Return existing server if already running
	if (serverInstance) {
		const existingPort = serverInstance.port;
		if (typeof existingPort !== "number") {
			throw new Error("Server instance has no valid port");
		}
		return {
			port: existingPort,
			stop: () => {
				if (serverInstance) {
					serverInstance.stop();
					serverInstance = null;
				}
			},
		};
	}

	const {
		port = NETWORK.DEFAULT_PORT,
		withDashboard = true,
		sslKeyPath,
		sslCertPath,
	} = options || {};

	// Enable TLS if both certificate paths are provided
	tlsEnabled = !!(sslKeyPath && sslCertPath);

	// Validate SSL certificate files if TLS is enabled
	let validatedSslKeyPath: string | undefined;
	let validatedSslCertPath: string | undefined;

	if (tlsEnabled && sslKeyPath && sslCertPath) {
		// Validate paths for security (prevent path traversal)
		try {
			validatedSslKeyPath = validatePathOrThrow(sslKeyPath, {
				description: "SSL key file",
			});
			validatedSslCertPath = validatePathOrThrow(sslCertPath, {
				description: "SSL certificate file",
			});
		} catch (error) {
			// Don't expose path details in error messages - log to server only
			console.error("SSL file path validation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw new Error(
				"SSL file path validation failed. Check server logs for details.",
			);
		}

		if (!existsSync(validatedSslKeyPath)) {
			// Don't expose paths in error messages
			console.error("SSL key file not found", {
				path: validatedSslKeyPath,
			});
			throw new Error("SSL key file not found. Check server logs for details.");
		}
		if (!existsSync(validatedSslCertPath)) {
			// Don't expose paths in error messages
			console.error("SSL certificate file not found", {
				path: validatedSslCertPath,
			});
			throw new Error(
				"SSL certificate file not found. Check server logs for details.",
			);
		}
	}

	// Initialize DI container
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("Server"));

	// Initialize payload encryption (no-op if PAYLOAD_ENCRYPTION_KEY is unset).
	// This must run before any database operations that read/write payloads.
	await initPayloadEncryption();

	// Initialize components
	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	setProviderModelDefaultOverrides(
		filterEnabledProviderModelDefaultOverrides(
			config.getEnabledProviderModelDefaultProviders(),
			config.getProviderModelDefaultOverrides(),
		),
	);
	installOutboundProxy(() => config.getOutboundProxy());
	const outboundProxyUrl = config.getOutboundProxy();
	if (outboundProxyUrl) {
		const { protocol, host } = new URL(outboundProxyUrl);
		new Logger("OutboundProxy").info(
			`Outbound proxy enabled: ${protocol}//${host}`,
		);
	}
	const runtime = config.getRuntime();
	// Route profiles are strict operator intent. Validate before database startup,
	// background jobs, or the HTTP listener can make this process look healthy.
	const modelRouteProfiles = parseModelRouteProfiles();
	// Override port if provided
	if (port !== runtime.port) {
		runtime.port = port;
	}

	// Process-local secret gating internal-probe markers (auto-refresh /
	// cache-keepalive self-loop requests) — see proxy-types.ts isInternalProbe
	// and AuthService#isInternalProbeRequest. Intentionally re-minted every
	// process start (not persisted): these self-loops originate from the same
	// process that mints the secret, so nothing outside this process ever
	// needs to know it across restarts.
	const internalProbeSecret = crypto.randomUUID();
	// Persisted secret shared with the CLI (via the same on-disk config file)
	// so `bun run cli --reauthenticate` / `--force-reset-rate-limit` can
	// notify this locally-running server of DB-side changes even when
	// API-key auth is enabled (issue #216). See AuthService#isLocalControlRequest.
	const localControlSecret = config.getLocalControlSecret();

	// Keep provider-committed rotations outside the primary DB: this WAL must
	// remain writable when the DB outage that caused the token CAS failure is
	// still active. One encrypted, atomically-replaced file per account avoids
	// cross-account writer races and restores before any scheduler can refresh.
	configurePendingRotationPersistence(
		createPendingRotationWal({
			directory: join(dirname(resolveConfigPath()), "pending-rotations"),
			secret: localControlSecret,
		}),
	);
	await restorePendingRotations();

	DatabaseFactory.initialize(undefined, runtime);
	const dbOps = await DatabaseFactory.getInstanceAsync();

	// One-time migration: promote pre-existing DBs from auto_vacuum=NONE to
	// INCREMENTAL. Fresh DBs created since ensureSchema() started issuing
	// `PRAGMA auto_vacuum = INCREMENTAL` are already in mode 2 and this is a
	// fast no-op. Existing DBs upgraded into this build run a full VACUUM
	// here — minutes on a multi-GB file. Done BEFORE the HTTP listener binds
	// so the proxy never sees a stalled writer slot.
	if (dbOps.isSQLite) {
		const startupLog = new Logger("Startup");
		try {
			const result = dbOps.bootstrapAutoVacuum();
			if (result.migrated) {
				startupLog.info(
					`One-time auto_vacuum migration: mode ${result.modeBefore} → ${result.modeAfter} ` +
						`in ${result.durationMs}ms. Future free-page reclamation runs incrementally via the ` +
						`hourly worker — no more blocking VACUUM.`,
				);
				if (result.modeAfter !== 2) {
					startupLog.error(
						`auto_vacuum still ${result.modeAfter} after migration VACUUM — ` +
							`incremental reclamation will be a no-op. Investigate disk space and DB integrity.`,
					);
				}
			} else if (result.modeBefore === 1) {
				// Operator set auto_vacuum=FULL on purpose. We don't migrate it to
				// INCREMENTAL silently because FULL reclaims pages on every COMMIT
				// while INCREMENTAL only reclaims when our hourly worker runs —
				// rewriting that policy without notice would surprise the user.
				// Log so it shows up in startup logs and `journalctl`. (Greptile #230)
				startupLog.info(
					`auto_vacuum=FULL (mode 1) detected — left in place. The hourly incremental_vacuum ` +
						`worker is a no-op under FULL mode; pages are reclaimed on every COMMIT. ` +
						`Switch to INCREMENTAL manually if you want the worker-driven cadence.`,
				);
			}
		} catch (err) {
			startupLog.error(
				`Bootstrap auto_vacuum migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
					`Free pages will not be reclaimed until this is resolved. ` +
					`Common causes: disk full (VACUUM needs ~2× DB size free), DB corruption.`,
			);
			throw err;
		}
	}

	// Start periodic integrity scheduler. The startup `PRAGMA integrity_check`
	// is intentionally gone — on multi-GB databases it blocked startup for
	// tens of seconds. The scheduler runs `quick_check` every few hours and
	// a full `integrity_check` + `foreign_key_check` daily (in a worker), and
	// surfaces results via /api/storage and the dashboard.
	stopIntegritySchedulerJob = startIntegrityScheduler(dbOps);

	const db = dbOps.getAdapter();
	const log = container.resolve<Logger>(SERVICE_KEYS.Logger);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);
	const deviceSetupCoordinator = createServerDeviceSetupCoordinator(dbOps);
	stopDeviceSetupRecoveryJob = await startDeviceSetupRecoveryLifecycle(
		deviceSetupCoordinator,
		{
			onError: () => {
				log.error("Device setup recovery tick failed");
			},
		},
	);

	// Initialize async DB writer
	const asyncWriter = new AsyncDbWriter();
	container.registerInstance(SERVICE_KEYS.AsyncWriter, asyncWriter);
	registerDisposable(asyncWriter);

	// Initialize pricing logger
	const pricingLogger = new Logger("Pricing");
	container.registerInstance(SERVICE_KEYS.PricingLogger, pricingLogger);
	setPricingLogger(pricingLogger);

	const alertService = new AlertService(db, config);
	alertService.start();
	registerDisposable({ dispose: () => alertService.stop() });

	// Shared successful-poll snapshot dispatch for the API-key pollers
	// (nanogpt/zai/kilo/minimax): history persistence + usage-window alert
	// evaluation, mirroring the refresh-backed path's onSnapshot callback.
	// Without this these pollers were silently unwired from both surfaces
	// (pro-gate finding). Best-effort on both calls — never fatal to polling.
	const makeSnapshotDispatch =
		(accountName: string) => (accountId: string, data: UsageData) => {
			const now = Date.now();
			dbOps
				.recordUsageSnapshot(accountId, data, now)
				.catch((err) =>
					log.warn(
						`Failed to record usage snapshot for account ${accountId}: ${err}`,
					),
				);
			// Resolve the CURRENT name at dispatch: the closure-captured name
			// goes stale on rename and could misattribute alerts if the freed
			// name is reused (pro-gate round-2 finding). Captured name stays
			// as the fallback when the row read fails.
			dbOps
				.getAccount(accountId)
				.then((acc) =>
					alertService.evaluateUsageSnapshot(
						accountId,
						acc?.name ?? accountName,
						data,
						now,
					),
				)
				.catch((err) =>
					log.warn(
						`Failed to evaluate usage-window alerts for account ${accountId}: ${err}`,
					),
				);
		};

	// Strategy is constructed below after RuntimeConfig is built. The router
	// accepts a getter so it can read the live (post-hot-reload) instance.
	let currentStrategy: LoadBalancingStrategy | null = null;

	// The model catalog needs a ProxyContext (account credentials, provider)
	// that is only constructed later in this function. The router is built
	// eagerly, so route through a mutable reference assigned once the
	// ProxyContext exists — mirrors the getStrategy() lazy-getter pattern above.
	let modelCatalogProxyContext: ProxyContext | null = null;
	const serverToolReplayWriterAdmission =
		createDurableServerToolReplayWriterAdmission(
			dbOps.getServerToolReplayIssuanceRepository(),
		);
	const serverToolReplay = await createServerToolReplayRuntime(
		loadServerToolReplayKeys(),
		{ writerAdmission: serverToolReplayWriterAdmission.writerAdmission },
	);
	const anthropicDegradedConfig = config.getAnthropicDegradedModeConfig();
	const anthropicDegradedMode = new AnthropicDegradedModeCoordinator({
		config: anthropicDegradedConfig,
	});
	const degradedOwnerOverlay = new DegradedOwnerOverlay({
		evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
	});
	const degradedOwnerShadowOverlay = new DegradedOwnerOverlay({
		evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
	});
	const anthropicDegradedObservability = new DegradedModeObservability({
		mode: anthropicDegradedConfig.mode,
		largeRequestTokenThreshold:
			anthropicDegradedConfig.largeRequestTokenThreshold,
		largeRequestByteThreshold:
			anthropicDegradedConfig.largeRequestByteThreshold,
		detailedEventsEnabled: config.getAnthropicDegradedDiagnosticsEnabled(),
		sink: createAnthropicDegradedDetailedEventSink(process.stdout),
	});

	// Minimal retention-job telemetry (#384): the periodic data-retention
	// cleanup below silently swallowed failures into a log line with no way
	// to tell "retention healthy" from "retention dead for weeks" apart from
	// tailing logs. Declared here (mirrors the currentStrategy /
	// modelCatalogProxyContext mutable-ref pattern above) so the router,
	// constructed eagerly below, can read it via a getter; the cleanup
	// callback mutates it in place once defined further down.
	const retentionState: RetentionStatus = {
		lastSuccessAt: null,
		lastError: null,
		lastErrorAt: null,
	};
	const getRetentionStatus = (): RetentionStatus => ({ ...retentionState });

	// apiRouter itself is constructed further below (after the
	// data-retention-cleanup job is registered) so its getRetentionStatus and
	// getAnthropicDegradedHealth getters, plus the AuthService/cleanup jobs
	// that follow, can all share one internalProbeSecret/localControlSecret
	// declaration instead of duplicating router construction here.

	// Registered here (before runStartupMaintenance() below) so intervalManager
	// has "data-retention-cleanup" on record and runNow() can find it — startup
	// maintenance triggers the very same callback via runNow() instead of
	// duplicating this logic, so both the boot-time run and the hourly tick
	// share one isRunning guard (maxConcurrent: 1) and can never race on
	// retentionState (Greptile, PR #390).
	const dataRetentionCleanup = async () => {
		const startTime = Date.now();
		try {
			const payloadDays = config.getDataRetentionDays();
			const requestDays = config.getRequestRetentionDays();
			const { removedRequests, removedPayloads } =
				await dbOps.cleanupOldRequests(
					payloadDays * TIME_CONSTANTS.DAY,
					requestDays * TIME_CONSTANTS.DAY,
				);
			if (removedRequests > 0 || removedPayloads > 0) {
				log.info(
					`Periodic cleanup: removed ${removedRequests} requests, ${removedPayloads} payloads in ${Date.now() - startTime}ms`,
				);
				// Reclaim freed pages adaptively. incrementalVacuumAdaptive()
				// scales reclaim with the current freelist: in steady state it
				// returns a small chunk (or no-ops on an empty freelist), but
				// after a retention *drop* — which dumps a large surplus of free
				// pages onto the freelist — it drains that surplus over a handful
				// of hourly ticks instead of weeks. Each underlying worker call is
				// bounded (~64 MiB) and the per-tick total is capped (~1 GiB), with
				// yields between chunks, so the single writer slot is never held
				// long and concurrent main-thread writes (rate-limit updates, OAuth
				// refresh, post-processor inserts) aren't starved. Off-thread via
				// the incremental-vacuum worker. Fire-and-forget so the cleanup
				// callback isn't blocked on it.
				dbOps
					.incrementalVacuumAdaptive()
					.then((r) => {
						if (r.reclaimedPages > 0) {
							log.info(
								`Adaptive incremental vacuum reclaimed ${r.reclaimedPages} pages in ${r.chunks} chunk(s)`,
							);
						}
					})
					.catch((err) => {
						log.error(`Incremental vacuum error: ${err}`);
					});
			}
			const usageHistoryDays = config.getUsageHistoryRetentionDays();
			const removedSnapshots = await dbOps.pruneUsageSnapshots(
				Date.now() - usageHistoryDays * TIME_CONSTANTS.DAY,
			);
			if (removedSnapshots > 0) {
				log.info(`Pruned ${removedSnapshots} old usage snapshots`);
			}
			retentionState.lastSuccessAt = Date.now();
			retentionState.lastError = null;
			retentionState.lastErrorAt = null;
		} catch (err) {
			log.error(`Periodic data retention cleanup error: ${err}`);
			retentionState.lastError =
				err instanceof Error ? err.message : String(err);
			retentionState.lastErrorAt = Date.now();
		}
		await cleanupCacheFlightRecorderRetention(config, dbOps, log);
	};

	// Periodic data retention cleanup every 1 hour (reduced from 6 hours for more aggressive cleanup).
	// Registered with immediate: false (default) — runStartupMaintenance()
	// below fires the first run via intervalManager.runNow() instead, so we
	// don't double-run at boot.
	const unregisterDataCleanup = registerCleanup({
		id: "data-retention-cleanup",
		callback: dataRetentionCleanup,
		minutes: 60, // every 1 hour
		// A batched cleanup can run long on a large backlog (#384) — long enough
		// to still be in flight when the next hourly tick fires, or when
		// runStartupMaintenance's runNow() call races a tick. Without this,
		// IntervalManager would allow overlapping runs, and the two completing
		// out of order could overwrite retentionState with a stale result (e.g.
		// an older failure clobbering a newer success in /health).
		maxConcurrent: 1,
		description: "Periodic data retention cleanup and incremental vacuum",
	});
	stopDataCleanupJob = unregisterDataCleanup;

	const apiRouter = new APIRouter(
		{
			db,
			config,
			dbOps,
			alertService,
			modelCatalog: {
				codexModels: async (accountId: string) => {
					if (!modelCatalogProxyContext) return null;
					return getCodexModels(accountId, modelCatalogProxyContext);
				},
				get: () => getModelCatalog(),
				refresh: async () => {
					if (!modelCatalogProxyContext) {
						return {
							success: false,
							error: "Model catalog is not initialized yet",
						};
					}
					const result = await refreshModelCatalog(modelCatalogProxyContext, {
						trigger: "manual",
					});
					return { success: result.success, error: result.error };
				},
			},
			runtime: {
				port,
				tlsEnabled,
			},
			getAsyncWriterHealth: () => asyncWriter.getHealth(),
			getUsageWorkerHealth: () => getUsageCollectorHealth(),
			getIntegrityStatus: () => dbOps.getIntegrityStatus(),
			getAnthropicDegradedHealth: () =>
				createAnthropicDegradedRuntimeHealth({
					coordinator: anthropicDegradedMode,
					observability: anthropicDegradedObservability,
					ownerOverlay: degradedOwnerOverlay,
					shadowOwnerOverlay: degradedOwnerShadowOverlay,
				}),
			getRetentionStatus,
			getStrategy: () => currentStrategy,
			internalProbeSecret,
			localControlSecret,
		},
		{ deviceSetupCoordinator },
	);

	// Initialize AuthService for proxy authentication
	const authService = new AuthService(
		dbOps,
		internalProbeSecret,
		localControlSecret,
	);

	// Run startup maintenance once (cleanup only) - fire and forget
	runStartupMaintenance(config, dbOps).catch((err) => {
		log.error("Startup maintenance failed:", err);
	});
	stopRetentionJob = () => {}; // No-op stopper

	// Set up periodic OAuth session cleanup (every hour)
	const unregisterOAuthCleanup = registerCleanup({
		id: "oauth-session-cleanup",
		callback: async () => {
			try {
				const removedSessions = await dbOps.cleanupExpiredOAuthSessions();
				if (removedSessions > 0) {
					log.debug(`Cleaned up ${removedSessions} expired OAuth sessions`);
				}
			} catch (err) {
				log.error(`OAuth session cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "OAuth session cleanup",
	});

	stopOAuthCleanupJob = unregisterOAuthCleanup;

	// Set up periodic rate limit cleanup (every hour)
	const unregisterRateLimitCleanup = registerCleanup({
		id: "rate-limit-cleanup",
		callback: async () => {
			try {
				const now = Date.now();
				const clearedRows = await dbOps.clearExpiredRateLimits(now);
				for (const row of clearedRows) {
					forceCloseCircuit({ provider: row.provider, accountId: row.id }, now);
				}
				if (clearedRows.length > 0) {
					log.debug(
						`Cleared ${clearedRows.length} expired rate_limited_until entries`,
					);
				}
			} catch (err) {
				log.error(`Rate limit cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "Rate limit cleanup",
	});

	stopRateLimitCleanupJob = unregisterRateLimitCleanup;

	// Periodic WAL checkpoint every 60s to keep the WAL bounded. Runs PRAGMA
	// optimize + PRAGMA wal_checkpoint(TRUNCATE) in a worker thread. This is the
	// ONLY WAL reclaimer (the main connection has wal_autocheckpoint=0 so it never
	// checkpoints synchronously on the request hot path). 60s (down from 5min)
	// gives TRUNCATE many more chances to land in a reader-idle gap and zero the
	// WAL; busy_timeout=0 means a tick that overlaps a reader just skips, never
	// blocks. The old synchronous dbOps.optimize() parked the main thread in
	// SQLite's busy handler for up to busy_timeout (10s) whenever the hourly
	// vacuum worker held the write lock, freezing the event loop.
	const unregisterWalCheckpoint = registerCleanup({
		id: "wal-checkpoint",
		callback: () => {
			dbOps
				.optimizeAsync()
				.then(async (result) => {
					const walBytes = result.ok ? await dbOps.getWalSizeBytes() : 0;
					const { level, message } = formatWalCheckpointLog(result, walBytes);
					log[level](message);
				})
				.catch((err) => {
					log.error(`WAL checkpoint error: ${err}`);
				});
		},
		minutes: 1,
		description: "WAL checkpoint to prevent unbounded WAL file growth",
	});
	stopWalCheckpointJob = unregisterWalCheckpoint;

	// Initialize load balancing strategy (will be created after runtime config)

	// Get the provider
	const provider = getProvider("anthropic");
	if (!provider) {
		throw new Error("Anthropic provider not available");
	}

	// Create runtime config
	const runtimeConfig: RuntimeConfig = {
		clientId: config.get(
			"client_id",
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		) as string,
		retry: {
			attempts: config.get("retry_attempts", 3) as number,
			delayMs: config.get("retry_delay_ms", 1000) as number,
			backoff: config.get("retry_backoff", 2) as number,
		},
		sessionDurationMs: config.get(
			"session_duration_ms",
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		) as number,
		port,
	};
	const modelRouteSessionRegistry = new ModelRouteSessionRegistry(
		modelRouteProfiles,
		{ ttlMs: runtimeConfig.sessionDurationMs },
	);
	if (modelRouteProfiles.length > 0) {
		log.info(`Model route profiles configured: ${modelRouteProfiles.length}`);
	}

	// Now create the strategy with runtime config
	const strategy = buildStrategy(
		config.getStrategy(),
		runtimeConfig.sessionDurationMs,
	);
	log.info(`Load-balancing strategy: ${config.getStrategy()}`);

	const strategyStore: StrategyStore = Object.assign(dbOps, {
		getAccountUtilization(accountId: string, provider: string): number | null {
			const data = usageCache.get(accountId);
			if (!data) return null;
			// Ranking, not gating: this feeds SessionStrategy's water-filling sort
			// across same-priority accounts, where a spent extra_usage pool is a
			// legitimate reason to prefer another account.
			return getRankingUtilizationForProvider(data, provider);
		},
	});

	strategy.initialize?.(strategyStore);
	currentStrategy = strategy;

	await initProxy(() => config.getStorePayloads());

	// Proxy context
	const guardCorrelationVerifier = createGuardCorrelationVerifier(
		readGuardCorrelationSecret(),
	);
	cacheFlightCohortSealService?.dispose();
	cacheFlightCohortSealService = new CohortSealService({ config });
	const proxyContext: ProxyContext = {
		strategy,
		cacheAffinityOrderer: new CacheAffinityOrderer(
			runtimeConfig.sessionDurationMs,
		),
		cacheFlightCohortSeal: cacheFlightCohortSealService,
		anthropicDegradedMode,
		anthropicDegradedObservability,
		degradedOwnerOverlay,
		degradedOwnerShadowOverlay,
		serverToolReplay,
		dbOps,
		runtime: runtimeConfig,
		config,
		provider,
		refreshInFlight: new Map(),
		asyncWriter,
		internalProbeSecret,
		guardCorrelationVerifier,
		modelRouteSessionRegistry,
	};
	modelCatalogProxyContext = proxyContext;

	// Register this server's refresh clearing capability
	const serverId = `server-${runtime.port}`;
	// Track at module scope so handleGracefulShutdown can unregister cleanly.
	registeredServerId = serverId;
	registerRefreshClearer(serverId, (accountId: string) => {
		// Clear refresh cache for this account in this server's context
		proxyContext.refreshInFlight.delete(accountId);
		log.info(`Cleared refresh cache for account ${accountId} on ${serverId}`);
	});

	// Register this server's usage polling restart capability
	registerPollingRestarter(serverId, async (accountId: string) => {
		const account = await dbOps.getAccount(accountId);
		if (!account) {
			log.warn(
				`Cannot restart usage polling: account ${accountId} not found on ${serverId}`,
			);
			return false;
		}
		if (!accountSupportsRefreshBackedUsagePolling(account)) {
			// Stop any loop started under an earlier, eligible configuration
			// (e.g. a codex account whose custom_endpoint changed) — restart
			// requests are the hook endpoint updates use to enforce the gate.
			usageCache.stopPolling(accountId);
			log.warn(
				`Cannot restart usage polling: account ${account.name} does not support refresh-backed usage polling`,
			);
			return false;
		}
		if (!account.access_token && !account.refresh_token) {
			log.warn(
				`Cannot restart usage polling: account ${account.name} has no tokens`,
			);
			return false;
		}
		log.info(
			`Restarting usage polling for account ${account.name} on ${serverId}`,
		);
		usageCache.stopPolling(accountId);
		startUsagePollingWithRefresh(
			account,
			proxyContext,
			alertService,
			0,
			config.getUsagePollIntervalMs(),
		);
		return true;
	});

	// Register this server's codex usage refresher. Subscription-backend
	// accounts try the free wham/usage introspection endpoint first (see
	// fetchCodexUsageData) — no quota consumed. If that yields no data, or
	// for accounts on a custom OpenAI-compatible endpoint (which has no
	// wham/usage equivalent), fall back to the quota-consuming on-demand ping
	// that parses x-codex-* headers off a tiny upstream request.
	registerCodexUsageRefresher(serverId, async (accountId: string) => {
		const account = await dbOps.getAccount(accountId);
		if (!account) {
			return {
				success: false,
				message: `Account ${accountId} not found`,
			};
		}
		if (account.provider !== "codex") {
			return {
				success: false,
				message: `Account '${account.name}' is not a Codex account`,
			};
		}
		if (!account.access_token && !account.refresh_token) {
			return {
				success: false,
				message: `Account '${account.name}' has no tokens — please re-authenticate`,
			};
		}

		let accessToken: string;
		try {
			accessToken = await getValidAccessToken(account, proxyContext);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				`Codex usage refresh: failed to get access token for ${account.name}: ${message}`,
			);
			return {
				success: false,
				message: `Could not refresh access token for '${account.name}': ${message}`,
			};
		}

		const resolvedEndpoint = resolveCodexEndpoint(
			account.custom_endpoint,
			account.name,
		);
		if (isCodexSubscriptionEndpoint(resolvedEndpoint)) {
			let freeResult: Awaited<ReturnType<typeof fetchCodexUsageData>> | null =
				null;
			try {
				freeResult = await fetchCodexUsageData(accessToken);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.warn(
					`Codex usage refresh: free usage endpoint failed for ${account.name}, falling back to on-demand ping: ${message}`,
				);
			}

			if (freeResult?.data) {
				// Re-check endpoint eligibility AFTER the network fetch: a
				// custom_endpoint switch while the wham request was in flight
				// must not resurrect a subscription snapshot post-teardown
				// (pro-gate round 3). This narrows the race from the fetch
				// duration to milliseconds; full closure needs per-registration
				// identity (follow-up issue).
				const currentRow = await dbOps.getAccount(accountId);
				if (
					!currentRow ||
					!isCodexSubscriptionEndpoint(
						resolveCodexEndpoint(currentRow.custom_endpoint, currentRow.name),
					)
				) {
					return {
						success: false,
						message: `Account '${account.name}' switched endpoints during the refresh — discarded the subscription usage snapshot`,
					};
				}
				usageCache.set(accountId, freeResult.data);

				const windows = [
					freeResult.data.five_hour,
					freeResult.data.seven_day,
				].flatMap((w) => {
					const resetMs = w?.resets_at
						? new Date(w.resets_at).getTime()
						: Number.NaN;
					return Number.isFinite(resetMs)
						? [{ utilization: w?.utilization ?? 0, resetMs }]
						: [];
				});
				const exhausted = windows.filter((w) => w.utilization >= 100);
				// The auto-refresh scheduler treats an account as probe-due once
				// rate_limit_reset passes (its query includes codex). Persisting
				// the EARLIEST reset while a LATER hard window is exhausted would
				// schedule guaranteed-fail probes at the short-window boundary —
				// when any window is exhausted, persist the latest exhausted
				// window's reset instead (pro-gate round 2).
				const candidateMs =
					exhausted.length > 0
						? Math.max(...exhausted.map((w) => w.resetMs))
						: windows.length > 0
							? Math.min(...windows.map((w) => w.resetMs))
							: null;
				if (candidateMs !== null) {
					// Preservation decided INSIDE the UPDATE against the current
					// row (pro-gate round 3): while a response-endpoint cooldown
					// is active, an already-later reset — possibly persisted by a
					// concurrent real 429 after our row read — must not be pulled
					// earlier on introspection data alone.
					try {
						await db.run(
							`UPDATE accounts SET rate_limit_reset = ?
							 WHERE id = ?
							   AND NOT (
							     rate_limited_until IS NOT NULL AND rate_limited_until > ?
							     AND rate_limit_reset IS NOT NULL AND rate_limit_reset > ?
							   )`,
							[candidateMs, account.id, Date.now(), candidateMs],
						);
					} catch (error) {
						log.warn(
							`Codex usage refresh: failed to update rate_limit_reset for ${account.name}:`,
							error,
						);
					}
				}

				const fiveHour = freeResult.data.five_hour?.utilization ?? 0;
				const sevenDay = freeResult.data.seven_day?.utilization ?? 0;
				// The free endpoint reports quota utilization but knows nothing of
				// live cooldowns on the responses endpoint (429/529 set
				// rate_limited_until via real traffic). The old ping-based path
				// surfaced those implicitly through its own HTTP status — keep
				// that honesty by consulting the account row too.
				const cooldownActive =
					account.rate_limited_until != null &&
					Number(account.rate_limited_until) > Date.now();
				const isRateLimited =
					fiveHour >= 100 || sevenDay >= 100 || cooldownActive;
				log.info(
					`Codex usage refreshed (free endpoint) for '${account.name}': 5h=${fiveHour}%, 7d=${sevenDay}%${
						isRateLimited ? " (rate-limited)" : ""
					}`,
				);

				// Mirror the on-demand path's message tone: 429-equivalent
				// exhaustion must not read as an unqualified success. See
				// tombii's PR #219 review note.
				const message = isRateLimited
					? `Usage refreshed for '${account.name}' — account is rate limited (5h: ${fiveHour}%, 7d: ${sevenDay}%).`
					: `Usage refreshed for '${account.name}' (5h: ${fiveHour}%, 7d: ${sevenDay}%).`;

				return { success: true, message };
			}
			// Free fetch yielded no data (or errored) — fall through to the
			// quota-consuming ping below.
		}

		const endpoint = account.custom_endpoint ?? CODEX_DEFAULT_ENDPOINT;

		let fetchResult: Awaited<ReturnType<typeof fetchCodexUsageOnDemand>>;
		try {
			fetchResult = await fetchCodexUsageOnDemand(accessToken, endpoint);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(
				`Codex usage refresh: upstream fetch failed for ${account.name}:`,
				message,
			);
			return {
				success: false,
				message: `Codex request failed for '${account.name}': ${message}`,
			};
		}

		// Persist rate-limit reset even on non-2xx so the dashboard sees the
		// most accurate reset time when the account is currently limited.
		const codexProvider = getProvider("codex");
		if (codexProvider) {
			const rl = codexProvider.parseRateLimit(fetchResult.response);
			if (rl.resetTime != null) {
				try {
					await db.run(
						"UPDATE accounts SET rate_limit_reset = ? WHERE id = ?",
						[rl.resetTime, account.id],
					);
				} catch (error) {
					log.warn(
						`Codex usage refresh: failed to update rate_limit_reset for ${account.name}:`,
						error,
					);
				}
			}
		}

		if (!fetchResult.data) {
			return {
				success: false,
				message: `Codex returned no usage headers (status ${fetchResult.response.status}) for '${account.name}'`,
			};
		}

		usageCache.set(accountId, fetchResult.data);

		const fiveHour = fetchResult.data.five_hour?.utilization ?? 0;
		const sevenDay = fetchResult.data.seven_day?.utilization ?? 0;
		const isRateLimited = fetchResult.response.status === 429;
		log.info(
			`Codex usage refreshed for '${account.name}': 5h=${fiveHour}%, 7d=${sevenDay}%${
				isRateLimited ? " (rate-limited)" : ""
			}`,
		);

		// 429 still produces a successful header refresh (the usage payload is
		// what we wanted), but the dashboard message must not celebrate it —
		// otherwise the operator sees "refreshed successfully" while the
		// account is fully exhausted. See tombii's PR #219 review note.
		const message = isRateLimited
			? `Usage refreshed for '${account.name}' — account is rate limited (5h: ${fiveHour}%, 7d: ${sevenDay}%).`
			: `Usage refreshed for '${account.name}' (5h: ${fiveHour}%, 7d: ${sevenDay}%).`;

		return {
			success: true,
			message,
		};
	});

	// Initialize auto-refresh scheduler (now that proxyContext is available)
	autoRefreshScheduler = new AutoRefreshScheduler(db, proxyContext);
	autoRefreshScheduler.start();

	// Initialize cache keepalive scheduler
	cacheKeepaliveScheduler = new CacheKeepaliveScheduler(proxyContext, config);
	cacheKeepaliveScheduler.start();

	// Initialize token health monitoring service
	startGlobalTokenHealthChecks(() => dbOps.getAllAccounts());

	// Hot reload strategy configuration
	config.on("change", ({ key }: { key: string }) => {
		if (key === "lb_strategy") {
			const newStrategyName = config.getStrategy();
			log.info(`Strategy configuration changed to: ${newStrategyName}`);
			const strategy = buildStrategy(
				newStrategyName,
				runtimeConfig.sessionDurationMs,
			);
			strategy.initialize?.(strategyStore);
			proxyContext.degradedOwnerOverlay.clear();
			proxyContext.degradedOwnerShadowOverlay.clear();
			proxyContext.strategy = strategy;
			currentStrategy = strategy;
		}
		// store_payloads changes are picked up automatically via the getStorePayloads getter
	});

	// Main server
	// Build server configuration with optional TLS and hostname binding
	const hostname = process.env.BETTER_CCFLARE_HOST || "0.0.0.0"; // Allow binding configuration
	try {
		const serverConfig = {
			port: runtime.port,
			hostname,
			idleTimeout: NETWORK.IDLE_TIMEOUT_MAX, // Max allowed by Bun
			...(tlsEnabled && validatedSslKeyPath && validatedSslCertPath
				? {
						tls: {
							key: readFileSync(validatedSslKeyPath),
							cert: readFileSync(validatedSslCertPath),
						},
					}
				: {}),
			async fetch(req: Request): Promise<Response> {
				const url = new URL(req.url);

				// Serve the dashboard SPA + static assets BEFORE the
				// authentication-gated API router. The dashboard shell is
				// public content and the initial browser navigation cannot
				// carry an API key, so it must be reachable without auth.
				// Auth-exempting these paths inside the SHARED
				// authenticateRequest() path instead reopened an
				// unauthenticated proxy bypass when the dashboard was
				// disabled/unavailable (GET /foo fell through to the proxy,
				// and providers accept arbitrary paths). Serving here, gated
				// on the dashboard actually being available, means only
				// genuine dashboard content skips auth; every other path
				// (API and proxy) is still authenticated below.
				if (withDashboard && dashboardManifest) {
					const decision = resolveDashboardRoute(
						url.pathname,
						req.method,
						Boolean(dashboardManifest[url.pathname]),
					);
					if (decision === "static-asset") {
						return serveDashboardFile(
							url.pathname,
							undefined,
							CACHE.CACHE_CONTROL_STATIC,
						);
					}
					if (decision === "spa-index") {
						return serveDashboardFile("/index.html", "text/html");
					}
				}

				// API routes (authenticated inside the router)
				const apiResponse = await apiRouter.handleRequest(url, req);
				if (apiResponse) {
					return apiResponse;
				}

				// All other paths go to proxy
				// Authenticate the proxy request with error handling to prevent bypass
				try {
					const authResult = await authService.authenticateRequest(
						req,
						url.pathname,
						req.method,
					);
					if (!authResult.isAuthenticated) {
						return new Response(
							JSON.stringify({
								type: "error",
								error: {
									type: "authentication_error",
									message: authResult.error || "Authentication failed",
								},
							}),
							{
								status: 401,
								headers: { "Content-Type": "application/json" },
							},
						);
					}

					// Authorization check - verify API key has permission for this endpoint
					if (authResult.apiKey) {
						const authzResult = await authService.authorizeEndpoint(
							authResult.apiKey,
							url.pathname,
							req.method,
						);

						if (!authzResult.authorized) {
							return new Response(
								JSON.stringify({
									type: "error",
									error: {
										type: "authorization_error",
										message: authzResult.reason || "Access denied",
									},
								}),
								{
									status: 403,
									headers: { "Content-Type": "application/json" },
								},
							);
						}
					}

					try {
						// Codex CLI first tries WebSocket transport for /v1/responses.
						// We only support HTTP — reject the upgrade cleanly so Codex
						// falls back to HTTPS without hitting the proxy with an empty body.
						if (
							req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
							(url.pathname === "/v1/responses" ||
								url.pathname === "/v1/responses/compact")
						) {
							return new Response(
								JSON.stringify({
									type: "error",
									error: {
										type: "not_supported_error",
										message:
											"WebSocket transport is not supported. Codex will retry over HTTPS automatically.",
									},
								}),
								{
									status: 503,
									headers: { "Content-Type": "application/json" },
								},
							);
						}

						if (
							req.method === "POST" &&
							(url.pathname === "/v1/responses" ||
								url.pathname === "/v1/responses/compact")
						) {
							return await handleResponsesRequest(
								req,
								url,
								handleProxy as Parameters<typeof handleResponsesRequest>[2],
								proxyContext,
								authResult.apiKeyId,
								authResult.apiKeyName,
							);
						}
						return trackStreamForShutdown(
							await handleProxy(
								req,
								url,
								proxyContext,
								authResult.apiKeyId,
								authResult.apiKeyName,
							),
						);
					} catch (proxyError) {
						const statusCode =
							typeof proxyError === "object" &&
							proxyError !== null &&
							"statusCode" in proxyError &&
							typeof (proxyError as { statusCode: unknown }).statusCode ===
								"number"
								? (proxyError as { statusCode: number }).statusCode
								: HTTP_STATUS.INTERNAL_SERVER_ERROR;

						log.error("Proxy request failed:", proxyError);

						const isServiceUnavailable =
							statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE;

						return new Response(
							JSON.stringify({
								type: "error",
								error: {
									type: isServiceUnavailable
										? "service_unavailable_error"
										: "proxy_error",
									message: isServiceUnavailable
										? "Service temporarily unavailable. Please try again later."
										: "Proxy request failed",
								},
							}),
							{
								status: statusCode,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				} catch (authError) {
					// Log authentication errors for security monitoring
					log.error("Authentication service error:", authError);
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "authentication_error",
								message: "Authentication service error",
							},
						}),
						{
							status: 401,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			},
		};

		serverInstance = serve(serverConfig);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EADDRINUSE"
		) {
			console.error(
				`❌ Port ${runtime.port} is already in use. Please use a different port.`,
			);
			console.error(
				`   You can specify a different port with: --port <number>`,
			);
			void shutdown(); // Don't await to avoid async issues in catch
			process.exit(1);
		}
		throw error;
	}

	// Memory monitoring - log RSS every 60s with warnings at growth thresholds
	const baselineRss = process.memoryUsage.rss();
	const memLog = new Logger("MemoryMonitor");
	memoryMonitorInterval = setInterval(() => {
		const mem = process.memoryUsage();
		const rssMb = Math.round(mem.rss / 1024 / 1024);
		const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
		const growthBytes = mem.rss - baselineRss;
		const growthMb = Math.round(growthBytes / 1024 / 1024);

		if (growthBytes > MEMORY_GROWTH_ERROR_BYTES) {
			memLog.error(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB (>1GB growth - potential leak)`,
			);
		} else if (growthBytes > MEMORY_GROWTH_WARN_BYTES) {
			memLog.warn(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB (>512MB growth)`,
			);
		} else {
			memLog.debug(
				`RSS: ${rssMb}MB, Heap: ${heapMb}MB, Growth: +${growthMb}MB`,
			);
		}
	}, MEMORY_MONITOR_INTERVAL_MS);
	memoryMonitorInterval.unref();

	// Log server startup (async)
	getVersion().then((version) => {
		if (!serverInstance) return;
		const protocol = tlsEnabled ? "https" : "http";
		const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
		const dashboardStatus =
			withDashboard && dashboardManifest
				? `${protocol}://${displayHost}:${serverInstance.port}`
				: withDashboard && !dashboardManifest
					? "unavailable (assets not found)"
					: "disabled";
		console.log(`
🎯 better-ccflare Server v${version}
🌐 Port: ${serverInstance.port}
🌍 Host: ${hostname}
${tlsEnabled ? "🔒 TLS: enabled" : ""}
📊 Dashboard: ${dashboardStatus}
🔗 API Base: ${protocol}://${displayHost}:${serverInstance.port}/api

Available endpoints:
- POST   ${protocol}://localhost:${serverInstance.port}/v1/*            → Proxy to Claude API
- GET    ${protocol}://localhost:${serverInstance.port}/api/accounts    → List accounts
- POST   ${protocol}://localhost:${serverInstance.port}/api/accounts    → Add account
- DELETE ${protocol}://localhost:${serverInstance.port}/api/accounts/:id → Remove account
- GET    ${protocol}://localhost:${serverInstance.port}/api/stats       → View statistics
- POST   ${protocol}://localhost:${serverInstance.port}/api/stats/reset → Reset statistics
- GET    ${protocol}://localhost:${serverInstance.port}/api/config      → View configuration
- PATCH  ${protocol}://localhost:${serverInstance.port}/api/config      → Update configuration

⚡ Ready to proxy requests...
`);
	});

	// Log configuration
	console.log(
		`⚙️  Current strategy: ${config.getStrategy()} (default: ${DEFAULT_STRATEGY})`,
	);

	// Log initial account status
	const accounts = await dbOps.getAllAccounts();
	const activeAccounts = accounts.filter(
		(a) => !a.paused && (!a.expires_at || a.expires_at > Date.now()),
	);
	log.info(
		`Loaded ${accounts.length} accounts (${activeAccounts.length} active)`,
	);
	if (activeAccounts.length === 0) {
		log.warn(
			"No active accounts available - requests will be forwarded without authentication",
		);
	}

	// Start usage polling for refresh-backed providers (regardless of paused status).
	// Anthropic polls Claude quota windows; xAI polls Grok Build credits via
	// grok.com gRPC-web and may need to refresh an expired imported Grok CLI token
	// before the first usage fetch; Codex polls the free ChatGPT wham/usage
	// endpoint, but only for accounts on the subscription backend — custom
	// OpenAI-compatible endpoints have no equivalent and are excluded here.
	const refreshBackedUsageAccounts = accounts.filter((a) =>
		accountSupportsRefreshBackedUsagePolling(a),
	);
	if (refreshBackedUsageAccounts.length > 0) {
		log.info(
			`Found ${refreshBackedUsageAccounts.length} refresh-backed usage account(s), starting usage polling...`,
		);
		for (const [index, account] of refreshBackedUsageAccounts.entries()) {
			log.debug(`Processing usage account: ${account.name}`, {
				accountId: account.id,
				provider: account.provider,
				hasAccessToken: !!account.access_token,
				hasRefreshToken: !!account.refresh_token,
				paused: account.paused,
				expiresAt: account.expires_at
					? new Date(account.expires_at).toISOString()
					: null,
			});

			if (account.access_token || account.refresh_token) {
				// Start usage polling with token refresh capability.
				// Usage data fetching should work independently of account paused status.
				// Stagger startup by 5s per account to avoid simultaneous rate-limit bursts.
				const startupDelayMs = index * 5000;
				startUsagePollingWithRefresh(
					account,
					proxyContext,
					alertService,
					startupDelayMs,
					config.getUsagePollIntervalMs(),
				);
				log.info(
					`Started usage polling for ${account.provider} account ${account.name}${startupDelayMs > 0 ? ` (delayed ${startupDelayMs / 1000}s)` : ""}`,
				);
			} else {
				log.warn(
					`Account ${account.name} has no access token or refresh token, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(
			`No refresh-backed usage accounts found, usage polling will not start`,
		);
	}

	// Start usage polling for NanoGPT accounts (PayG with optional subscription tracking)
	const nanogptAccounts = accounts.filter((a) => a.provider === "nanogpt");
	if (nanogptAccounts.length > 0) {
		log.info(
			`Found ${nanogptAccounts.length} NanoGPT accounts, starting usage polling...`,
		);
		for (const account of nanogptAccounts) {
			log.debug(`Processing NanoGPT account: ${account.name}`, {
				accountId: account.id,
				hasApiKey: !!account.api_key,
				paused: account.paused,
				customEndpoint: account.custom_endpoint,
			});

			if (account.api_key) {
				// NanoGPT uses API key authentication, no token refresh needed
				// Create a simple token provider that returns the API key
				const apiKeyProvider = async () => account.api_key || "";

				// Start usage polling with the API key
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					config.getUsagePollIntervalMs(),
					account.custom_endpoint,
					undefined,
					undefined,
					makeSnapshotDispatch(account.name),
				);
				log.info(`Started usage polling for NanoGPT account ${account.name}`);
			} else {
				log.warn(
					`NanoGPT account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No NanoGPT accounts found, usage polling will not start`);
	}

	// Start usage polling for Zai accounts
	const zaiAccounts = accounts.filter((a) => a.provider === "zai");
	if (zaiAccounts.length > 0) {
		log.info(
			`Found ${zaiAccounts.length} Zai accounts, starting usage polling...`,
		);
		for (const account of zaiAccounts) {
			log.debug(`Processing Zai account: ${account.name}`, {
				accountId: account.id,
				hasApiKey: !!account.api_key,
				paused: account.paused,
			});

			if (account.api_key) {
				// Zai uses API key authentication, no token refresh needed
				// Create a simple token provider that returns the API key
				const apiKeyProvider = async () => account.api_key || "";

				// Start usage polling with the API key
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					config.getUsagePollIntervalMs(),
					undefined, // customEndpoint
					(accountId) => {
						dbOps
							.resetAccountSession(accountId, Date.now())
							.catch((err) =>
								log.warn(
									`Failed to reset session for Zai account ${accountId} on window reset: ${err}`,
								),
							);
					},
					undefined,
					makeSnapshotDispatch(account.name),
				);
				log.info(`Started usage polling for Zai account ${account.name}`);
			} else {
				log.warn(
					`Zai account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Zai accounts found, usage polling will not start`);
	}

	// Start usage polling for Kilo Gateway accounts
	const kiloAccounts = accounts.filter((a) => a.provider === "kilo");
	if (kiloAccounts.length > 0) {
		log.info(
			`Found ${kiloAccounts.length} Kilo Gateway accounts, starting usage polling...`,
		);
		for (const account of kiloAccounts) {
			if (account.api_key) {
				const apiKeyProvider = async () => account.api_key || "";
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					config.getUsagePollIntervalMs(),
					undefined,
					undefined,
					undefined,
					makeSnapshotDispatch(account.name),
				);
				log.info(
					`Started usage polling for Kilo Gateway account ${account.name}`,
				);
			} else {
				log.warn(
					`Kilo Gateway account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Kilo Gateway accounts found, usage polling will not start`);
	}

	// Start usage polling for Minimax accounts (Token Plan `remains` endpoint)
	const minimaxAccounts = accounts.filter((a) => a.provider === "minimax");
	const registeredMinimaxAccountIds = bootstrapMinimaxUsagePolling(
		accounts,
		usageCache,
		config.getUsagePollIntervalMs(),
		log,
		(account) => makeSnapshotDispatch(account.name),
	);
	if (minimaxAccounts.length === 0) {
		log.info(`No Minimax accounts found, usage polling will not start`);
	} else if (registeredMinimaxAccountIds.length > 0) {
		log.info(
			`Found ${minimaxAccounts.length} Minimax accounts, starting usage polling...`,
		);
		for (const accountId of registeredMinimaxAccountIds) {
			const account = accounts.find((a) => a.id === accountId);
			log.info(
				`Started usage polling for Minimax account ${account?.name ?? accountId}`,
			);
		}
	} else {
		// All Minimax accounts exist but lack API keys. Per-account WARN logs
		// already fired inside registerMinimaxUsagePolling; this summary
		// makes the diagnosis unambiguous: the reason polling did not start
		// is missing credentials, not a missing account. Matches the
		// nanogpt/zai/kilo phrasing style (Greptile #350 P2).
		log.info(
			`Found ${minimaxAccounts.length} Minimax account(s) but all lack API keys, usage polling will not start`,
		);
	}

	// Pre-warm Bedrock model and inference profile caches
	const bedrockAccounts = accounts.filter((a) => a.provider === "bedrock");
	if (bedrockAccounts.length > 0) {
		log.info(
			`Found ${bedrockAccounts.length} Bedrock accounts, pre-warming caches...`,
		);

		// Group accounts by region to avoid duplicate cache loads
		const regionMap = new Map<string, Account[]>();
		for (const account of bedrockAccounts) {
			const config = parseBedrockConfig(account.custom_endpoint);
			if (config) {
				const accounts = regionMap.get(config.region) || [];
				accounts.push(account);
				regionMap.set(config.region, accounts);
			}
		}

		// Pre-warm caches per region (don't block startup)
		for (const [region, regionAccounts] of regionMap) {
			prewarmBedrockCache(regionAccounts[0], region).catch((err) => {
				log.warn(
					`Failed to pre-warm Bedrock cache for region ${region}: ${err.message}`,
				);
			});
		}
	} else {
		log.info(`No Bedrock accounts found, cache pre-warming will not start`);
	}

	// Initialize NanoGPT pricing refresh if there are NanoGPT accounts (non-blocking)
	void initializeNanoGPTPricingIfAccountsExist(dbOps, pricingLogger);

	// Initialize the live Anthropic model catalog refresh scheduler (weekly by
	// default, configurable via BETTER_CCFLARE_MODELS_REFRESH_HOURS; a
	// "tick-and-check" scheduler that fires an initial check after a random
	// 30-120s delay, then re-checks every 15 minutes whether a refresh is due,
	// rather than a single long-lived interval timer).
	stopModelCatalogRefreshJob = initModelCatalogRefresh(proxyContext);

	const serverPort = serverInstance.port;
	if (typeof serverPort !== "number") {
		throw new Error("Server instance has no valid port");
	}

	return {
		port: serverPort,
		stop: () => {
			if (serverInstance) {
				serverInstance.stop();
				serverInstance = null;
			}
		},
	};
}

/**
 * How long shutdown waits for in-flight requests to complete before
 * force-closing them. Agent SSE streams can run for minutes, and a
 * mid-stream close is unrecoverable for the client (tokens were already
 * streamed), so this defaults generously. Supervisors must keep their stop
 * timeout (systemd TimeoutStopSec, wrapper SIGKILL delays) above this value
 * plus the watchdog margin or the drain gets SIGKILLed out from under us.
 */
// ── In-flight stream registry for shutdown ─────────────────────────────────
// Bun 1.x cannot escalate a graceful stop(): once stop() has removed the
// listener, a later stop(true) no longer terminates active connections
// (verified empirically on Bun 1.3.5). To force-close still-streaming
// responses at the drain deadline, every proxied response is wrapped in a
// pass-through whose controller can be errored explicitly.
//
// Each tracked stream also exposes a settlement promise. Force-close must
// await those settlements before usage-collector drain / DB disposal, or
// close/error finalizers that record the last usage events can still be
// racing the shutdown path.
type TrackedInflightStream = {
	abort: () => void;
	settled: Promise<void>;
};

const inflightStreams = new Set<TrackedInflightStream>();

export function trackStreamForShutdown(response: Response): Response {
	const body = response.body;
	if (!body) return response;
	const reader = body.getReader();
	let tracked: TrackedInflightStream | null = null;
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const finish = () => {
		if (!tracked) return;
		inflightStreams.delete(tracked);
		tracked = null;
		settle();
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const abort = () => {
				try {
					controller.error(new Error("server shutdown: drain deadline"));
				} catch {
					// already closed or errored
				}
				// Settlement waits for source cancellation so shutdown can
				// observe the terminal path even when no pull is scheduled.
				void reader
					.cancel()
					.catch(() => {})
					.finally(() => finish());
			};
			tracked = { abort, settled };
			inflightStreams.add(tracked);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finish();
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (error) {
				finish();
				try {
					controller.error(error);
				} catch {
					// already errored by abort
				}
			}
		},
		cancel(reason) {
			return reader
				.cancel(reason)
				.catch(() => {})
				.finally(() => finish());
		},
	});
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Error every tracked in-flight stream and return both the abort count and a
 * promise that settles once every aborted stream has finished its terminal
 * close/error path.
 */
export function abortInflightStreams(): {
	aborted: number;
	settled: Promise<void>;
} {
	const streams = [...inflightStreams];
	inflightStreams.clear();
	for (const stream of streams) stream.abort();
	return {
		aborted: streams.length,
		settled: Promise.allSettled(streams.map((stream) => stream.settled)).then(
			() => undefined,
		),
	};
}

export const SHUTDOWN_DRAIN_MS_ENV = "CCFLARE_SHUTDOWN_DRAIN_MS";
const DEFAULT_SHUTDOWN_DRAIN_MS = 60_000;
/**
 * Upper clamp for the drain budget: keeps the watchdog setTimeout well
 * inside its 32-bit millisecond range (an overflowed delay fires
 * immediately, which would cut off the very streams being drained) and
 * keeps shutdown inside any sane service-manager stop timeout.
 */
export const MAX_SHUTDOWN_DRAIN_MS = 15 * 60 * 1000;
/** Budget for post-drain cleanup (DB writer, disposables) before force exit. */
const SHUTDOWN_WATCHDOG_MARGIN_MS = 15_000;
/**
 * Portion of the watchdog cleanup margin reserved for force-close terminal
 * callbacks. The graceful drain deadline is already exhausted when this runs,
 * so it needs its own small budget before usage/DB cleanup begins.
 */
export const FORCE_CLOSE_SETTLEMENT_BUDGET_MS = 1_000;

/**
 * Await aborted stream settlement and Bun's pending-request counter within a
 * dedicated post-force-close budget. Exported so the shutdown timing contract
 * is testable without invoking the process-level signal handler.
 */
export async function waitForForceCloseSettlement(
	settled: Promise<void>,
	getPendingRequests: () => number,
	budgetMs: number = FORCE_CLOSE_SETTLEMENT_BUDGET_MS,
): Promise<void> {
	const boundedBudgetMs = Number.isFinite(budgetMs)
		? Math.max(0, budgetMs)
		: FORCE_CLOSE_SETTLEMENT_BUDGET_MS;
	const deadline = Date.now() + boundedBudgetMs;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const budgetExpired = new Promise<void>((resolve) => {
		timeoutId = setTimeout(resolve, boundedBudgetMs);
	});

	try {
		await Promise.race([settled.catch(() => {}), budgetExpired]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}

	while (getPendingRequests() > 0 && Date.now() < deadline) {
		const remainingMs = deadline - Date.now();
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(50, Math.max(0, remainingMs))),
		);
	}
}

export function readShutdownDrainMs(): number {
	const raw = process.env[SHUTDOWN_DRAIN_MS_ENV];
	if (raw === undefined || raw === "") return DEFAULT_SHUTDOWN_DRAIN_MS;
	// Strict digits only: parseInt accepts numeric prefixes like "1abc" as 1,
	// which would silently shrink the drain budget to a millisecond.
	if (!/^\d+$/.test(raw)) return DEFAULT_SHUTDOWN_DRAIN_MS;
	// Number (not parseInt) so digit strings beyond MAX_SAFE_INTEGER still
	// compare correctly and clamp to the maximum instead of falling back to
	// the shorter default the operator did not ask for.
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_SHUTDOWN_DRAIN_MS;
	}
	return Math.min(parsed, MAX_SHUTDOWN_DRAIN_MS);
}

// Deduplicates concurrent shutdown invocations (e.g. SIGINT arriving while
// SIGTERM is still awaiting serverInstance.stop()). Without this, the second
// invocation races on the same Bun server, worker, and DB writer.
let isShuttingDown = false;

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	if (isShuttingDown) {
		console.log(`Ignoring ${signal} — shutdown already in progress`);
		return;
	}
	isShuttingDown = true;

	console.log(`\n👋 Received ${signal}, shutting down gracefully...`);

	// Hard upper bound on shutdown duration: the drain budget plus a margin
	// for the remaining cleanup. unref'd so it doesn't itself prevent a clean
	// exit if everything else finishes first. Exits with 0 because the
	// watchdog only fires on an expected SIGTERM that ran long, not on a
	// failure — code 1 would make systemd Restart=on-failure auto-restart
	// the unit instead of treating it as a normal stop.
	const drainMs = readShutdownDrainMs();
	const watchdogMs = drainMs + SHUTDOWN_WATCHDOG_MARGIN_MS;
	const watchdog = setTimeout(() => {
		console.error(
			`⚠️ Shutdown watchdog (${watchdogMs}ms) expired, forcing exit`,
		);
		process.exit(0);
	}, watchdogMs);
	watchdog.unref();

	try {
		// Stop scheduler triggers first so they don't add load while draining.
		// Device setup additionally drains its database-owning work before shared
		// resources can be disposed below.
		if (stopDeviceSetupRecoveryJob) {
			const stopDeviceSetup = stopDeviceSetupRecoveryJob;
			stopDeviceSetupRecoveryJob = null;
			await stopDeviceSetup();
		}
		if (stopRetentionJob) {
			stopRetentionJob();
			stopRetentionJob = null;
		}
		if (stopOAuthCleanupJob) {
			stopOAuthCleanupJob();
			stopOAuthCleanupJob = null;
		}
		if (stopRateLimitCleanupJob) {
			stopRateLimitCleanupJob();
			stopRateLimitCleanupJob = null;
		}
		if (stopDataCleanupJob) {
			stopDataCleanupJob();
			stopDataCleanupJob = null;
		}
		if (stopWalCheckpointJob) {
			stopWalCheckpointJob();
			stopWalCheckpointJob = null;
		}
		if (stopIntegritySchedulerJob) {
			stopIntegritySchedulerJob();
			stopIntegritySchedulerJob = null;
		}
		if (stopModelCatalogRefreshJob) {
			stopModelCatalogRefreshJob();
			stopModelCatalogRefreshJob = null;
		}
		if (autoRefreshScheduler) {
			autoRefreshScheduler.stop();
			autoRefreshScheduler = null;
		}
		if (cacheKeepaliveScheduler) {
			cacheKeepaliveScheduler.stop();
			cacheKeepaliveScheduler = null;
		}
		if (cacheFlightCohortSealService) {
			cacheFlightCohortSealService.dispose();
			cacheFlightCohortSealService = null;
		}

		// Stop memory monitoring
		if (memoryMonitorInterval) {
			clearInterval(memoryMonitorInterval);
			memoryMonitorInterval = null;
		}

		// Stop token health monitoring
		stopGlobalTokenHealthChecks();

		// Unregister this server's Codex on-demand usage refresher so the
		// module-level registry doesn't keep a stale callback after restart.
		// Mirrors the cleanup pattern used by the schedulers above.
		if (registeredServerId) {
			unregisterCodexUsageRefresher(registeredServerId);
			registeredServerId = null;
		}

		// Clear all pending usage polling retry timeouts
		if (usagePollingRetryTimeouts.size > 0) {
			console.log(
				`Clearing ${usagePollingRetryTimeouts.size} pending usage polling retry timeout(s)...`,
			);
			for (const [
				_accountId,
				timeoutId,
			] of usagePollingRetryTimeouts.entries()) {
				clearTimeout(timeoutId);
			}
			usagePollingRetryTimeouts.clear();
		}

		// Drain in-flight requests before tearing down shared resources.
		// stop() without arguments stops accepting new connections while
		// letting active ones (including agent SSE streams) run to
		// completion; wait for pendingRequests to reach zero within the
		// drain budget, then force-close whatever remains.
		if (serverInstance) {
			serverInstance.stop();
			const deadline = Date.now() + drainMs;
			const initialPending = serverInstance.pendingRequests;
			if (initialPending > 0) {
				console.log(
					`Draining ${initialPending} in-flight request(s) (budget ${drainMs}ms)...`,
				);
			}
			while (serverInstance.pendingRequests > 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			const remaining = serverInstance.pendingRequests;
			if (remaining > 0) {
				console.error(
					`Drain budget exhausted; force-closing ${remaining} in-flight request(s)`,
				);
				// stop(true) cannot escalate an earlier graceful stop() on Bun 1.x
				// (verified on 1.3.5), so error the tracked response streams
				// directly; the call stays as belt-and-braces for Bun versions
				// where escalation works.
				serverInstance.stop(true);
				const { aborted, settled } = abortInflightStreams();
				if (aborted > 0) {
					console.error(`Errored ${aborted} tracked response stream(s)`);
				}
				// Force-cancelled streams still have close/error handlers that
				// record final usage. The graceful drain deadline is exhausted at
				// this point, so use a dedicated 1s slice of the 15s watchdog
				// cleanup margin. A hung source cancel cannot consume the ~14s
				// left for usage-collector drain and DB disposal.
				await waitForForceCloseSettlement(
					settled,
					() => serverInstance?.pendingRequests ?? 0,
				);
			}
		}

		usageCache.clear(); // Stop all usage polling
		await drainUsageCollector();
		await shutdown();
		console.log("✅ Shutdown complete");
		process.exit(0);
	} catch (error) {
		console.error("❌ Error during shutdown:", error);
		process.exit(1);
	}
}

// Register signal handlers
// Only act once this process actually owns a server lifecycle: for
// short-lived CLI commands (which import this module without starting a
// server) the CLI's own handlers own shutdown, and a second concurrent
// shutdown path could exit while the first is still disposing resources.
process.on("SIGINT", () => {
	if (!serverLifecycleOwned) return;
	handleGracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
	if (!serverLifecycleOwned) return;
	handleGracefulShutdown("SIGTERM");
});

// Export helper to get the current protocol
export function getProtocol(): string {
	return tlsEnabled ? "https" : "http";
}

// Run server if this is the main entry point
if (import.meta.main) {
	// Parse command line arguments
	const args = process.argv.slice(2);
	let port: number | undefined;
	let sslKeyPath: string | undefined;
	let sslCertPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = Number.parseInt(args[i + 1], 10);
			i++; // Skip next arg
		} else if (args[i] === "--ssl-key" && args[i + 1]) {
			sslKeyPath = args[i + 1];
			i++; // Skip next arg
		} else if (args[i] === "--ssl-cert" && args[i + 1]) {
			sslCertPath = args[i + 1];
			i++; // Skip next arg
		}
	}

	// Use environment variables if no command line arguments
	if (!port && process.env.PORT) {
		port = Number.parseInt(process.env.PORT, 10);
	}
	if (!sslKeyPath && process.env.SSL_KEY_PATH) {
		sslKeyPath = process.env.SSL_KEY_PATH;
	}
	if (!sslCertPath && process.env.SSL_CERT_PATH) {
		sslCertPath = process.env.SSL_CERT_PATH;
	}

	// Set env vars if CLI flags were used (ensures consistency across modules)
	if (sslKeyPath) {
		process.env.SSL_KEY_PATH = sslKeyPath;
	}
	if (sslCertPath) {
		process.env.SSL_CERT_PATH = sslCertPath;
	}

	// Start the server asynchronously
	void startServer({ port, sslKeyPath, sslCertPath });
}
