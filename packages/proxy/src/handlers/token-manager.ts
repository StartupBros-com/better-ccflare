import {
	authFailureEvents,
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	registerDisposable,
	ServiceUnavailableError,
	TokenRefreshError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	getProvider,
	type TokenRefreshResult,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "../constants";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import {
	checkRefreshTokenHealth,
	getOAuthErrorMessage,
} from "./token-health-monitor";

const log = new Logger("TokenManager");

/**
 * Providers whose `refreshToken()` performs a genuine OAuth access-token exchange
 * — a real network round-trip that returns a NEW, usable bearer token. Only these
 * are eligible for a reactive stale-token refresh after an upstream 401.
 *
 * Deliberately a positive ALLOWLIST, not a denylist. Several providers carry a
 * `refresh_token` and/or report `supportsOAuth() === true`, yet inherit
 * `OpenAICompatibleProvider.refreshToken`, which just echoes `account.refresh_token`
 * back as the access token (no exchange) — Qwen is the notable case. Reactively
 * "refreshing" one of those would overwrite the stored access token with the
 * refresh token and retry upstream with the wrong bearer (credential corruption),
 * so a denylist that forgets one is a security bug. An allowlist fails safe: an
 * unlisted provider simply falls over on 401 as before. `anthropic` and `codex`
 * and `xai` are the providers with a real OAuth refresh; `claude-oauth` is the
 * legacy alias for anthropic OAuth accounts.
 */
const OAUTH_REACTIVE_REFRESH_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"claude-oauth",
	"codex",
	"xai",
]);

/**
 * Whether an account is eligible for a reactive access-token refresh after an
 * upstream 401. True only for accounts that hold a refresh token AND whose
 * provider does a genuine OAuth token exchange (see
 * OAUTH_REACTIVE_REFRESH_PROVIDERS). Used by the proxy's stale-token 401 recovery
 * to decide whether to refresh + retry the same account before failing over.
 */
export function canAttemptStaleTokenRefresh(account: Account): boolean {
	return (
		Boolean(account.refresh_token?.trim()) &&
		!account.api_key?.trim() &&
		OAUTH_REACTIVE_REFRESH_PROVIDERS.has(account.provider.trim().toLowerCase())
	);
}

/**
 * Reactive refreshes are shared across requests by account id. Keep a short
 * cooldown in this module (next to the refresh-in-flight/backoff state) so a
 * server with several request contexts cannot hammer an OAuth endpoint after a
 * provider-issued 401. The map is bounded because account ids are user data.
 */
const STALE_TOKEN_REFRESH_COOLDOWN_MS = 60_000;
const MAX_STALE_TOKEN_REFRESH_ENTRIES = 1_000;
const lastStaleTokenRefreshAt = new Map<string, number>();

/** Atomically reserve the next reactive refresh window for an account. */
export function tryAcquireStaleTokenRefresh(
	accountId: string,
	now = Date.now(),
): boolean {
	const lastAttempt = lastStaleTokenRefreshAt.get(accountId);
	if (
		lastAttempt !== undefined &&
		now - lastAttempt < STALE_TOKEN_REFRESH_COOLDOWN_MS
	) {
		return false;
	}
	lastStaleTokenRefreshAt.set(accountId, now);
	if (lastStaleTokenRefreshAt.size > MAX_STALE_TOKEN_REFRESH_ENTRIES) {
		let oldestId: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [id, at] of lastStaleTokenRefreshAt) {
			if (at < oldestAt) {
				oldestId = id;
				oldestAt = at;
			}
		}
		if (oldestId) lastStaleTokenRefreshAt.delete(oldestId);
	}
	return true;
}

/** True when another request recently reserved a refresh for this account. */
export function isStaleTokenRefreshCoolingDown(
	accountId: string,
	now = Date.now(),
): boolean {
	const lastAttempt = lastStaleTokenRefreshAt.get(accountId);
	return (
		lastAttempt !== undefined &&
		now - lastAttempt < STALE_TOKEN_REFRESH_COOLDOWN_MS
	);
}

/** Clear reactive refresh state after a successful response or re-auth. */
export function clearStaleTokenRefreshState(accountId: string): void {
	lastStaleTokenRefreshAt.delete(accountId);
}

/**
 * Distinguish a revoked/invalid OAuth refresh token from a transient refresh
 * transport failure. `refreshAccessTokenSafe` wraps provider errors in a
 * TokenRefreshError, preserving the provider message in `context.originalError`;
 * inspect both layers so callers do not durably pause an account for a timeout.
 */
export function isTerminalTokenRefreshFailure(error: unknown): boolean {
	if (typeof error === "object" && error !== null) {
		if (terminalRefreshFailures.has(error)) return true;
	}
	if (error instanceof OAuthRefreshTokenError) return true;
	const messages: string[] = [];
	if (error instanceof Error) messages.push(error.message);
	if (typeof error === "object" && error !== null) {
		const context = (error as { context?: unknown }).context;
		if (typeof context === "object" && context !== null) {
			const originalError = (context as { originalError?: unknown })
				.originalError;
			if (typeof originalError === "string") messages.push(originalError);
		}
	}
	return messages.some((message) => isInvalidGrantMessage(message));
}

// Keep the refresh credential identity alongside a wrapped failure without
// putting the raw token into Error.context/toJSON/log output. A WeakMap also
// means this metadata disappears with the error and cannot grow with traffic.
const refreshFailureTokens = new WeakMap<object, string | null>();
const terminalRefreshFailures = new WeakSet<object>();

/** Return the refresh token captured by the refresh operation that failed. */
export function getRefreshTokenUsedForFailure(
	error: unknown,
): string | null | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	return refreshFailureTokens.get(error);
}

/**
 * Return the durable pause reason for an upstream authentication failure.
 *
 * A refresh-token account needs a real re-authentication, while a static
 * API-key account needs its credential repaired or replaced.  Keep the latter
 * distinct from `oauth_invalid_grant`: the dashboard/CLI should not suggest an
 * OAuth flow for an API key, but both states must leave the account out of the
 * routing pool after a definitive 401.
 */
export function upstreamAuthFailureReason(
	account: Pick<Account, "refresh_token"> & Partial<Pick<Account, "provider">>,
): "oauth_invalid_grant" | "auth_failure" {
	const provider = account.provider?.trim().toLowerCase();
	return account.refresh_token?.trim() &&
		provider !== undefined &&
		OAUTH_REACTIVE_REFRESH_PROVIDERS.has(provider)
		? "oauth_invalid_grant"
		: "auth_failure";
}

/** Minimal slice of DatabaseOperations needed to pause an account for reauth. */
interface ReauthPauser {
	pauseAccountIfActive?(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string | null,
	): Promise<boolean>;
}

/**
 * Persist a definitive upstream 401 as an account quarantine.
 *
 * This is deliberately separate from refresh-token error handling: an access
 * token can be rejected while its expiry metadata still says "valid".  The
 * caller has already completed the bounded stale-token refresh/retry decision
 * before invoking this helper.  The DB operation is compare-and-set-like
 * (`pauseAccountIfActive`), so concurrent requests produce one durable write and
 * one alert event; already-paused/manual accounts are left untouched.
 *
 * Older test/runtime contexts may not expose the optional pause method.  In that
 * case this helper remains a safe no-op and the request-local routing ledger is
 * still responsible for preventing another send in the same request.
 */
export async function pauseAccountForUpstreamAuthFailure(
	account: Pick<Account, "id" | "name" | "provider" | "refresh_token">,
	dbOps: ReauthPauser,
	/** Explicit credential identity used by the failed request, when known. */
	expectedRefreshToken?: string | null,
): Promise<boolean> {
	const pause = dbOps.pauseAccountIfActive;
	if (typeof pause !== "function") return false;
	// `undefined` preserves the legacy call contract (derive from the live
	// account). `null` is an explicit snapshot for a non-OAuth credential and
	// must not fall through to a newly reauthenticated token on the account.
	const refreshTokenForFailure =
		expectedRefreshToken === undefined
			? account.refresh_token
			: expectedRefreshToken;
	const reason = upstreamAuthFailureReason({
		provider: account.provider,
		refresh_token: refreshTokenForFailure,
	});
	// Compare the exact stored token in the CAS.  Trimming here would make a
	// legitimate token containing surrounding whitespace fail the guard even
	// though the account still holds the rejected credential; trimming is only
	// used for classification (OAuth vs API key).
	const expectedTokenForCas =
		expectedRefreshToken === undefined
			? refreshTokenForFailure?.trim()
				? refreshTokenForFailure
				: undefined
			: refreshTokenForFailure;
	try {
		const paused = await pause(account.id, reason, expectedTokenForCas);
		if (paused) {
			log.error(
				`Account "${account.name}" PAUSED — upstream authentication failed (401; ${reason}). Repair the credential before resuming it.`,
			);
			try {
				authFailureEvents.emit("event", {
					accountId: account.id,
					accountName: account.name,
					provider: account.provider,
					reason,
				});
			} catch (eventErr) {
				// Alerting is best-effort and must never undo a committed quarantine.
				log.error(
					`Failed to publish upstream auth-failure event for ${account.name}:`,
					eventErr,
				);
			}
		}
		return paused;
	} catch (pauseErr) {
		log.error(
			`Failed to quarantine account ${account.name} after upstream 401:`,
			pauseErr,
		);
		return false;
	}
}

/**
 * If `error` is a terminal OAuth refresh failure (revoked/invalid refresh token),
 * pause the account with the dedicated `oauth_invalid_grant` reason so the load
 * balancer fails over and the account is flagged for re-auth. Guarded on the
 * account still being active *and* still holding the refresh token that failed,
 * so it never clobbers a manual pause or re-pauses a freshly re-authenticated
 * account. Detection covers both the typed `OAuthRefreshTokenError` and the
 * message string (other OAuth providers). Returns true if it paused.
 *
 * Shared by every refresh path: `refreshAccessTokenSafe` (real requests) and
 * the proactive Codex refresher in the auto-refresh scheduler.
 */
export async function pauseAccountForReauthIfInvalidGrant(
	error: unknown,
	account: {
		id: string;
		name: string;
		provider: string;
		refresh_token: string | null;
	},
	dbOps: ReauthPauser,
	/** Refresh-token snapshot captured before the provider call. */
	expectedRefreshToken?: string | null,
): Promise<boolean> {
	const message = error instanceof Error ? error.message : String(error);
	const isInvalidGrant =
		error instanceof OAuthRefreshTokenError || isInvalidGrantMessage(message);
	if (!isInvalidGrant) return false;
	const pause = dbOps.pauseAccountIfActive;
	if (typeof pause !== "function") return false;
	try {
		const refreshTokenForCas =
			expectedRefreshToken === undefined
				? account.refresh_token
				: expectedRefreshToken;
		const paused = await pause(
			account.id,
			PAUSE_REASON_NEEDS_REAUTH,
			refreshTokenForCas?.trim() ? refreshTokenForCas : undefined,
		);
		if (paused) {
			log.error(
				`Account "${account.name}" PAUSED — OAuth refresh token rejected (needs re-authentication). Reauthenticate the account; it will auto-resume on success.`,
			);
			try {
				authFailureEvents.emit("event", {
					accountId: account.id,
					accountName: account.name,
					provider: account.provider,
					reason: PAUSE_REASON_NEEDS_REAUTH,
				});
			} catch (eventErr) {
				// Alerting is best-effort and must not change the result of a pause
				// that has already committed successfully.
				log.error(
					`Failed to publish auth-failure event for account ${account.name}:`,
					eventErr,
				);
			}
		}
		return paused;
	} catch (pauseErr) {
		log.error(
			`Failed to pause account ${account.name} after invalid_grant:`,
			pauseErr,
		);
		return false;
	}
}

// Track refresh failures for backoff with TTL cleanup
const refreshFailures = new Map<string, number>();
// Track consecutive backoff hits per account
const backoffCounters = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILURE_RECORDS = 1000; // Prevent unbounded growth
const MAX_BACKOFF_RETRIES = 10; // After 10 backoff hits, check DB

// Cleanup old failures periodically
let cleanupInterval: Timer | null = null;

export const startTokenCleanupInterval = () => {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			const now = Date.now();
			const toDelete: string[] = [];

			for (const [accountId, failureTime] of refreshFailures.entries()) {
				if (now - failureTime > FAILURE_TTL_MS) {
					toDelete.push(accountId);
				}
			}

			// Clean up both maps together
			toDelete.forEach((accountId) => {
				refreshFailures.delete(accountId);
				backoffCounters.delete(accountId);
			});

			// Enforce size limit during periodic cleanup to prevent memory bloat
			enforceMaxSize();

			if (toDelete.length > 0) {
				log.debug(`Cleaned up ${toDelete.length} expired failure records`);
			}
		}, FAILURE_TTL_MS / 10); // Run cleanup more frequently (every 30 seconds)
	}
};

export const stopTokenCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval and register for shutdown
startTokenCleanupInterval();

// Register cleanup as disposable for proper shutdown
registerDisposable({
	dispose: () => {
		stopTokenCleanupInterval();
		refreshFailures.clear();
		backoffCounters.clear();
		lastStaleTokenRefreshAt.clear();
	},
});

/**
 * Helper function to clean expired entries from refreshFailures Map
 */
function cleanupExpiredFailures(): void {
	const now = Date.now();
	const toDelete: string[] = [];

	for (const [accountId, failureTime] of refreshFailures.entries()) {
		if (now - failureTime > FAILURE_TTL_MS) {
			toDelete.push(accountId);
		}
	}

	toDelete.forEach((accountId) => {
		refreshFailures.delete(accountId);
		backoffCounters.delete(accountId); // Also clean up backoff counters
	});

	if (toDelete.length > 0) {
		log.debug(
			`Cleaned up ${toDelete.length} expired failure records during proactive cleanup`,
		);
	}
}

/**
 * Helper function to enforce maximum size limit on refreshFailures Map
 */
function enforceMaxSize(): void {
	if (refreshFailures.size > MAX_FAILURE_RECORDS) {
		// Remove oldest entries if we exceed the max size
		const _now = Date.now();
		const entries = Array.from(refreshFailures.entries()).sort(
			(a, b) => a[1] - b[1], // Sort by timestamp (oldest first)
		);

		const toRemove = entries.slice(
			0,
			refreshFailures.size - MAX_FAILURE_RECORDS + 1,
		);
		for (const [accountId] of toRemove) {
			refreshFailures.delete(accountId);
			backoffCounters.delete(accountId); // Also clean up backoff counters
		}

		if (toRemove.length > 0) {
			log.warn(
				`Removed ${toRemove.length} oldest failure records to maintain max size limit`,
			);
		}
	}
}

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// Proactively clean expired entries before checking
	cleanupExpiredFailures();

	// Check for recent refresh failures and implement backoff
	const lastFailure = refreshFailures.get(account.id);
	if (lastFailure && Date.now() - lastFailure < TOKEN_REFRESH_BACKOFF_MS) {
		// Increment backoff counter
		const currentCount = backoffCounters.get(account.id) || 0;
		const newCount = currentCount + 1;
		backoffCounters.set(account.id, newCount);

		log.warn(
			`Account ${account.name} is in refresh backoff period (attempt ${newCount})`,
		);

		// After MAX_BACKOFF_RETRIES consecutive backoff hits, check DB for updated tokens
		if (newCount >= MAX_BACKOFF_RETRIES) {
			log.info(
				`Account ${account.name} has hit ${newCount} backoff attempts, checking DB for updated tokens`,
			);

			try {
				// Reload account from database
				const dbAccount = await ctx.dbOps.getAccount(account.id);
				if (dbAccount) {
					// Check if DB has a valid token that we don't have in memory
					const accessTokenFromDb = dbAccount.access_token;
					const expiresAtFromDb = dbAccount.expires_at;
					const hasValidToken =
						typeof accessTokenFromDb === "string" &&
						typeof expiresAtFromDb === "number" &&
						expiresAtFromDb - Date.now() > TOKEN_SAFETY_WINDOW_MS;

					if (hasValidToken && accessTokenFromDb !== account.access_token) {
						log.info(
							`Found updated token in DB for account ${account.name}, updating in-memory account`,
						);

						// Update in-memory account with DB data
						account.access_token = accessTokenFromDb;
						account.expires_at = expiresAtFromDb;
						if (dbAccount.refresh_token) {
							account.refresh_token = dbAccount.refresh_token;
						}
						account.last_used = Date.now();

						// Clear failure records and backoff counter
						refreshFailures.delete(account.id);
						backoffCounters.delete(account.id);

						log.info(
							`Successfully recovered token for account ${account.name} from DB`,
						);
						if (!dbAccount.access_token) {
							throw new TokenRefreshError(
								account.id,
								new Error("DB account has no access token"),
							);
						}
						return dbAccount.access_token;
					} else {
						log.warn(
							`DB token for account ${account.name} is not valid or same as in-memory`,
						);
					}
				} else {
					log.warn(
						`Account ${account.name} not found in DB during backoff recovery`,
					);
				}
			} catch (error) {
				log.error(
					`Failed to check DB for account ${account.name} during backoff recovery`,
					error,
				);
			}
		}

		throw new ServiceUnavailableError(
			`Token refresh for account ${account.name} is in backoff period after recent failure`,
		);
	} else {
		// Not in backoff, reset counter
		backoffCounters.delete(account.id);
	}

	// The caller's account object may be a stale snapshot (the auto-refresh
	// scheduler builds one from a loop-start SELECT). Re-read the row and adopt
	// fresher credentials before initiating a refresh — refreshing with an
	// already-rotated refresh token produces a false-definitive invalid_grant.
	if (!ctx.refreshInFlight.has(account.id)) {
		const adopted = await adoptDbTokensIfFresher(account, ctx);
		if (adopted) return adopted;
	}

	// Check if a refresh is already in progress for this account.
	// NOTE: no await may sit between this check and refreshInFlight.set() —
	// microtask atomicity is what deduplicates concurrent callers.
	if (!ctx.refreshInFlight.has(account.id)) {
		// Snapshot the credential before creating the provider promise. Reauth can
		// replace the mutable account object while the network call is in flight;
		// the provider and CAS pause must both refer to this exact credential.
		const refreshTokenAtStart = account.refresh_token;
		const refreshAccount = {
			...account,
			refresh_token: refreshTokenAtStart,
		};
		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Create a new refresh promise and store it
		const refreshPromise = provider
			.refreshToken(refreshAccount, ctx.runtime.clientId)
			.then((result: TokenRefreshResult) => {
				// 1. Persist to database asynchronously
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTokens(
						account.id,
						result.accessToken,
						result.expiresAt,
						result.refreshToken,
					),
				);

				// 2. Update the live in-memory account object immediately
				// This prevents subsequent requests from seeing stale token data
				account.access_token = result.accessToken;
				account.expires_at = result.expiresAt;
				if (result.refreshToken) {
					account.refresh_token = result.refreshToken;
				}
				account.last_used = Date.now();

				// Clear any previous failure record on successful refresh
				refreshFailures.delete(account.id);

				const expiresInSec = Math.round((result.expiresAt - Date.now()) / 1000);
				log.info(`Successfully refreshed token for account: ${account.name}`);
				log.debug(`refresh for ${account.name}:`, {
					expiresInSec,
					newRefreshToken: result.refreshToken !== account.refresh_token,
					provider: account.provider,
				});
				return result.accessToken;
			})
			.catch(async (error) => {
				// Record the failure timestamp for backoff
				refreshFailures.set(account.id, Date.now());
				// Enforce size limit after adding a new entry
				enforceMaxSize();

				const originalError =
					error instanceof Error ? error.message : String(error);
				const enhancedMessage = getOAuthErrorMessage(account, originalError);

				log.error(
					`Token refresh failed for account ${account.name}: ${enhancedMessage}`,
					error,
				);
				// Terminal auth failure (revoked/invalid refresh token): pause the
				// account for re-auth immediately so the LB fails over instead of
				// leaving it in rotation to fail every request. Awaited so the pause
				// lands before any caller (e.g. the auto-refresh scheduler) records a
				// generic failure that could otherwise mask the specific reason.
				const terminalRefreshFailure = isTerminalTokenRefreshFailure(error);
				await pauseAccountForReauthIfInvalidGrant(
					error,
					account,
					ctx.dbOps,
					refreshTokenAtStart,
				);
				const wrappedError = new TokenRefreshError(
					account.id,
					new Error(enhancedMessage),
				);
				refreshFailureTokens.set(wrappedError, refreshTokenAtStart);
				if (terminalRefreshFailure) {
					// Preserve definitive classification even when getOAuthErrorMessage
					// replaces the provider marker with a health/reauth hint.
					terminalRefreshFailures.add(wrappedError);
				}
				throw wrappedError;
			})
			.finally(() => {
				// Clean up the map when done (success or failure)
				ctx.refreshInFlight.delete(account.id);
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Return the existing or new refresh promise
	const promise = ctx.refreshInFlight.get(account.id);
	if (!promise) {
		throw new ServiceUnavailableError(
			`${ERROR_MESSAGES.REFRESH_NOT_FOUND} ${account.id}`,
		);
	}
	return promise;
}

// Global registry for account refresh clearing functions
const refreshClearers: Map<string, (accountId: string) => void> = new Map();

// Global registry for usage polling restart functions
const pollingRestarters: Map<string, (accountId: string) => Promise<boolean>> =
	new Map();

export interface CodexUsageRefreshOutcome {
	success: boolean;
	message: string;
}

// Global registry for codex on-demand usage refreshers (one per server)
const codexUsageRefreshers: Map<
	string,
	(accountId: string) => Promise<CodexUsageRefreshOutcome>
> = new Map();

// Per-account in-flight tracker so concurrent requests share a single fetch.
const codexUsageInflight: Map<
	string,
	Promise<CodexUsageRefreshOutcome>
> = new Map();

/**
 * Register a function to restart usage polling for a specific account.
 * Used by the server to expose its polling restart capability to HTTP handlers.
 */
export function registerPollingRestarter(
	serverId: string,
	restarter: (accountId: string) => Promise<boolean>,
): void {
	pollingRestarters.set(serverId, restarter);
}

/**
 * Restart usage polling for an account across all registered servers.
 * Returns true if at least one server successfully restarted polling.
 */
export async function restartUsagePollingForAccount(
	accountId: string,
): Promise<boolean> {
	let anySuccess = false;
	for (const [serverId, restarter] of pollingRestarters) {
		try {
			const ok = await restarter(accountId);
			if (ok) {
				anySuccess = true;
				log.info(
					`Restarted usage polling for account ${accountId} on server ${serverId}`,
				);
			}
		} catch (error) {
			log.error(
				`Failed to restart usage polling for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
	return anySuccess;
}

/**
 * Register a function that performs an on-demand codex usage refresh for a
 * given account. The server registers a callback that has access to its
 * proxy context so token refresh + DB updates can run via the normal path.
 */
export function registerCodexUsageRefresher(
	serverId: string,
	refresher: (accountId: string) => Promise<CodexUsageRefreshOutcome>,
): void {
	codexUsageRefreshers.set(serverId, refresher);
}

/**
 * Unregister a previously registered codex usage refresher.
 */
export function unregisterCodexUsageRefresher(serverId: string): void {
	codexUsageRefreshers.delete(serverId);
}

/**
 * Refresh codex usage data for an account by dispatching to a registered
 * server. Iterates serverId-keyed callbacks **sequentially** and returns the
 * first successful outcome — we never fan-out because every call costs a
 * real codex request. Concurrent callers for the same accountId share a
 * single in-flight promise.
 */
export async function refreshCodexUsageForAccount(
	accountId: string,
): Promise<CodexUsageRefreshOutcome> {
	const existing = codexUsageInflight.get(accountId);
	if (existing) {
		log.debug(`Reusing in-flight codex usage refresh for account ${accountId}`);
		return existing;
	}

	const promise = (async (): Promise<CodexUsageRefreshOutcome> => {
		if (codexUsageRefreshers.size === 0) {
			return {
				success: false,
				message: "No proxy server is registered to handle codex usage refresh.",
			};
		}

		let lastFailure: CodexUsageRefreshOutcome | null = null;
		for (const [serverId, refresher] of codexUsageRefreshers) {
			try {
				const result = await refresher(accountId);
				if (result.success) {
					log.info(
						`Refreshed codex usage for account ${accountId} via server ${serverId}`,
					);
					return result;
				}
				lastFailure = result;
			} catch (error) {
				log.error(
					`Codex usage refresh via server ${serverId} threw for account ${accountId}:`,
					error,
				);
				lastFailure = {
					success: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return (
			lastFailure ?? {
				success: false,
				message: "Codex usage refresh failed for unknown reasons.",
			}
		);
	})();

	codexUsageInflight.set(accountId, promise);
	promise.finally(() => {
		codexUsageInflight.delete(accountId);
	});
	return promise;
}

/**
 * Register a function to clear refresh cache for a specific account
 * Used by the server to register its refresh clearing capability
 */
export function registerRefreshClearer(
	serverId: string,
	clearer: (accountId: string) => void,
): void {
	refreshClearers.set(serverId, clearer);
}

/**
 * Clear refresh cache for an account across all registered servers
 */
export function clearAccountRefreshCache(accountId: string): void {
	// Clear module-level backoff/failure state for this account (not per-server)
	// so a just-re-authenticated account can immediately attempt a fresh refresh
	// instead of waiting out the backoff window, even if no server clearer is
	// registered yet.
	refreshFailures.delete(accountId);
	backoffCounters.delete(accountId);
	clearStaleTokenRefreshState(accountId);
	for (const [serverId, clearer] of refreshClearers) {
		try {
			clearer(accountId);
			log.info(
				`Cleared refresh cache for account ${accountId} on server ${serverId}`,
			);
		} catch (error) {
			log.error(
				`Failed to clear refresh cache for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
}

/**
 * Internal function to clear refresh cache with specific context
 * This is what the server registers as its clearer function
 */
function _clearAccountRefreshCacheWithContext(
	accountId: string,
	ctx: ProxyContext,
): void {
	// Clear any in-flight refresh for this account
	ctx.refreshInFlight.delete(accountId);

	// Clear refresh failure records and backoff
	refreshFailures.delete(accountId);
	backoffCounters.delete(accountId);
	clearStaleTokenRefreshState(accountId);

	log.info(`Cleared refresh cache for account ${accountId}`);
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// For API key providers, return the API key directly without OAuth token refresh logic
	if (
		account.provider === "openai-compatible" ||
		account.provider === "zai" ||
		account.provider === "claude-console-api" ||
		account.provider === "anthropic-compatible" ||
		account.provider === "minimax" ||
		account.provider === "muse-spark"
	) {
		if (account.api_key) {
			return account.api_key;
		}
		throw new Error(`No API key available for account ${account.name}`);
	}

	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	// Check if token exists and won't expire within the safety window
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS
	) {
		return account.access_token;
	}

	// Check refresh token health before attempting refresh
	const tokenHealth = checkRefreshTokenHealth(account);

	// Log token health warnings for OAuth accounts
	if (tokenHealth.hasRefreshToken) {
		if (tokenHealth.status === "expired" || tokenHealth.status === "critical") {
			log.error(`🚨 ${tokenHealth.message}`);
		} else if (tokenHealth.status === "warning") {
			log.warn(`⚠️ ${tokenHealth.message}`);
		}
	}

	// Token is expired, missing, or will expire soon
	const reason = !account.access_token
		? "missing"
		: !account.expires_at
			? "no expiry"
			: account.expires_at <= Date.now()
				? "expired"
				: "expiring soon";

	log.info(`Token ${reason} for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}
