import { getRateLimitResetStabilityMs, logError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	extractWindowResetTime,
	type Provider,
	parseCodexUsageHeaders,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";
import {
	applyRateLimitCooldown,
	applyRateLimitCooldownAwaitingPersist,
	completeRateLimitProbe,
} from "./rate-limit-cooldown";

const log = new Logger("ResponseProcessor");

/**
 * Releases a `response.clone()` tee branch that a provider hook (parseUsage /
 * extractUsageInfo) may resolve without ever reading. Per the Streams spec,
 * cancelling one tee branch never settles until every sibling branch has
 * been cancelled or fully read: an abandoned, never-touched clone left
 * lying around can block cancellation of the ORIGINAL response elsewhere
 * (e.g. proxy-operations.ts's discardUnusedResponse on rate-limited
 * failover) forever. BaseProvider's default extractUsageInfo is exactly
 * this case: it returns null without touching `_response` at all.
 *
 * Only acts when `bodyUsed` is still false, i.e. nothing ever started
 * reading this exact clone. Providers that DO consume the body (directly,
 * or via their own internal `response.clone()`) leave `bodyUsed` false on
 * this outer clone too in the common "clone-then-read-the-inner-clone"
 * pattern used by anthropic/openai/base-anthropic-compatible, but fully
 * draining their inner clone also closes this one (tee branches close
 * together once the shared underlying source reaches EOF), so cancelling an
 * already-closed stream here is a harmless, immediately-resolved no-op.
 * Never awaited by the caller: cancellation may itself stay pending on a
 * still-unresolved sibling branch, and this function must never become
 * another place a caller can get stuck waiting.
 */
function releaseUnconsumedClone(clone: Response): void {
	if (clone.bodyUsed) return;
	try {
		clone.body?.cancel().catch(() => {
			// Best effort only; see function doc above.
		});
	} catch {
		// Body may already be locked/disturbed by the time we check; ignore.
	}
}

/**
 * Resolves a fresh, future cached xAI Grok Build credits reset time (ms) for
 * enrichment of a directly-observed 402/429 that carries no resetTime of its
 * own (e.g. XaiProvider.parseRateLimit's 402 case, which has no reset header
 * to parse). Returns null for any of: no cache entry (usageCache.get already
 * discards entries older than 10 minutes), missing resets_at, an invalid
 * (unparseable) timestamp, or a reset time that has already passed: all of
 * which fall through to the bounded no-reset probe cooldown instead.
 */
function resolveXaiCachedResetTime(accountId: string): number | null {
	const cached = usageCache.get(accountId);
	if (!cached) return null;
	const resetMs = extractWindowResetTime(cached, "xai");
	if (resetMs == null) return null;
	if (resetMs <= Date.now()) return null;
	return resetMs;
}

function isSyntheticCountTokensRequest(
	ctx: ProxyContext,
	requestMeta?: { path?: string },
): boolean {
	return (
		requestMeta?.path === "/v1/messages/count_tokens" &&
		(ctx.provider.name === "openai-compatible" || ctx.provider.name === "codex")
	);
}

/**
 * Handles rate limit response for an account
 * @param account - The rate-limited account
 * @param rateLimitInfo - Parsed rate limit information
 * @param ctx - The proxy context
 * @param status - HTTP status code of the triggering response (429 or 529). Defaults to 429.
 */
export function handleRateLimitResponse(
	account: Account,
	rateLimitInfo: ReturnType<Provider["parseRateLimit"]>,
	ctx: ProxyContext,
	status = 429,
): void {
	if (!rateLimitInfo.resetTime) return;

	// Prefer a provider-supplied typed reason (e.g. XaiProvider's
	// `xai_capacity_402`) over the generic status-derived default so a 402
	// classified as a rate limit is never relabeled as a plain 429/529.
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(status === 529
			? "upstream_529_overloaded_with_reset"
			: "upstream_429_with_reset");
	applyRateLimitCooldown(
		account,
		{
			resetTime: rateLimitInfo.resetTime,
			remaining: rateLimitInfo.remaining,
			reason,
		},
		ctx,
	);
}

/**
 * Updates account metadata in the background
 * @param account - The account to update
 * @param response - The response to extract metadata from
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @param bypassSession - Whether to bypass session tracking (for auto-refresh)
 */
export function updateAccountMetadata(
	account: Account,
	response: Response,
	ctx: ProxyContext,
	requestId?: string,
	bypassSession = false,
): void {
	// Update basic usage (with optional bypass)
	if (bypassSession) {
		// Increment request count without updating session tracking
		ctx.asyncWriter.enqueue(async () => {
			// Manually increment request count and total requests without touching session
			const db = ctx.dbOps.getAdapter();
			const now = Date.now();
			await db.run(
				`UPDATE accounts
				 SET last_used = ?, request_count = request_count + 1, total_requests = total_requests + 1
				 WHERE id = ?`,
				[now, account.id],
			);
		});
	} else {
		ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));
	}
	// Extract and update rate limit info for every response
	const rateLimitInfo = ctx.provider.parseRateLimit(response);
	// Only update rate limit metadata when we have actual rate limit headers
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}
	// Note: rate_limited_until is cleared unconditionally in processProxyResponse on any
	// successful response. No need to duplicate that logic here.

	if (account.provider === "codex") {
		const codexUsage = parseCodexUsageHeaders(response.headers, {
			defaultUtilization: response.status === 429 ? 100 : 0,
		});
		if (codexUsage) {
			const prevUsage = usageCache.get(account.id);
			const prevResetAt = (
				prevUsage as { five_hour?: { resets_at: string | null } } | null
			)?.five_hour?.resets_at;
			const newResetAt = codexUsage.five_hour?.resets_at;
			const windowRolledOver =
				prevResetAt != null &&
				newResetAt != null &&
				newResetAt !== prevResetAt &&
				new Date(newResetAt).getTime() > new Date(prevResetAt).getTime();

			usageCache.set(account.id, codexUsage);
			log.debug(
				`Updated Codex usage cache for ${account.name}: 5h=${codexUsage.five_hour?.utilization ?? "?"}%, 7d=${codexUsage.seven_day?.utilization ?? "?"}%`,
			);

			// Update rate_limit_reset from usage headers so auto-refresh can track windows
			const resetTimes = [
				codexUsage.five_hour?.resets_at,
				codexUsage.seven_day?.resets_at,
			]
				.filter((t): t is string => t != null)
				.map((t) => new Date(t).getTime());
			if (resetTimes.length > 0) {
				const earliestReset = Math.min(...resetTimes);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps
						.getAdapter()
						.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
							earliestReset,
							account.id,
						]),
				);
			}

			if (windowRolledOver) {
				log.info(
					`Codex window rolled over for ${account.name}: ${prevResetAt} → ${newResetAt}, resetting session`,
				);
				ctx.dbOps
					.resetAccountSession(account.id, Date.now())
					.catch((err) =>
						log.warn(
							`Failed to reset Codex session for ${account.name} on window reset: ${err}`,
						),
					);
			}
		}
	}

	// Extract usage info if supported
	if (requestId) {
		// For streaming responses, prefer parseUsage (handles SSE final events)
		// For non-streaming, use extractUsageInfo (handles JSON responses)
		const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

		if (isStream && ctx.provider.parseUsage) {
			const parseUsage = ctx.provider.parseUsage.bind(ctx.provider);
			const usageClone = response.clone() as Response;
			(async () => {
				try {
					const usageInfo = await parseUsage(usageClone);
					if (usageInfo) {
						log.debug(
							`Extracted streaming usage for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract streaming usage for account ${account.name}:`,
						error,
					);
				} finally {
					releaseUnconsumedClone(usageClone);
				}
			})();
		} else if (ctx.provider.extractUsageInfo) {
			const extractUsageInfo = ctx.provider.extractUsageInfo.bind(ctx.provider);
			const usageClone = response.clone() as Response;
			(async () => {
				try {
					const usageInfo = await extractUsageInfo(usageClone);
					if (usageInfo) {
						log.debug(
							`Extracted usage info for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract usage info for account ${account.name}:`,
						error,
					);
				} finally {
					releaseUnconsumedClone(usageClone);
				}
			})();
		}
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @returns Promise resolving to whether the response is rate-limited
 */
export async function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ProxyContext,
	requestId?: string,
	requestMeta?: { headers?: Headers; path?: string },
): Promise<boolean> {
	let rateLimitInfo = ctx.provider.parseRateLimit(response);

	// For Zai provider, if we got a 429 without resetTime, try parsing the body
	if (
		rateLimitInfo.isRateLimited &&
		!rateLimitInfo.resetTime &&
		account.provider === "zai" &&
		response.status === 429
	) {
		// Try to parse reset time from response body
		const provider = ctx.provider;
		if ("parseRateLimitFromBody" in provider) {
			const bodyResetTime = await (
				provider as Provider & {
					parseRateLimitFromBody: (
						response: Response,
					) => Promise<number | null>;
				}
			).parseRateLimitFromBody(response);
			if (bodyResetTime) {
				rateLimitInfo = {
					...rateLimitInfo,
					resetTime: bodyResetTime,
				};
			}
		}
	}

	// Handle rate limit
	//
	// We deliberately do NOT exclude streaming responses here. A rate-limited
	// account is rate-limited regardless of whether the response that revealed
	// it was a stream — and the failover decision (returning true to signal
	// the next-account loop) is safe at this point because no response bytes
	// have been written to the client yet. The proxy hasn't entered the
	// `forwardToClient` path; it's still inspecting the upstream response.
	//
	// In practice the most common pre-stream 429 has
	// `content-type: application/json` because Anthropic only opens an SSE
	// stream when the request is accepted, but the historic `!isStream` guard
	// here was a footgun: providers that emit `text/event-stream` 429s, or
	// future provider transforms that preserve the requested content-type on
	// errors, would silently bypass marking and failover. The mid-stream case
	// (status 200 with an SSE `event: error` frame partway through the body)
	// is handled separately by the streaming forwarder — see issue #114.
	if (rateLimitInfo.isRateLimited) {
		// Skip cooldown application on synthetic cache-keepalive replays. The
		// keepalive scheduler fires parallel requests across every cached
		// account simultaneously; bursts of 4+ concurrent requests can trip
		// Anthropic's per-IP burst limit and 429 every account at the same
		// instant. Treating those as real per-account rate limits drains the
		// pool to zero routable accounts even though no user-visible quota
		// was actually exhausted. Loop-prevention header set by
		// cache-keepalive-scheduler.ts; only synthetic replays carry it.
		const isKeepalive =
			requestMeta?.headers?.get("x-better-ccflare-keepalive") === "true";
		if (isKeepalive) {
			log.warn(
				`Keepalive replay for ${account.name} got ${response.status} — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
			);
		} else if (account.provider === "xai") {
			// Native xAI capacity/rate-limit signal (R5-R10): this is direct
			// upstream evidence from XaiProvider.parseRateLimit, not an
			// inferred/derived signal, so it is routed through the
			// awaited-persist cooldown variant. Selection reads fresh account
			// state from the DB on every request (no process-local breaker), so
			// the durable single-row UPDATE must land before this promise
			// resolves, otherwise a fast follow-up request (e.g. an immediate
			// next turn in the same conversation) could race ahead of the
			// write and reselect the same still-cooling-down account.
			//
			// Priority order (never relabel a 402 as a 429, `reason` always
			// carries the provider-supplied classification through):
			//   1. A direct resetTime from the response itself (Retry-After /
			//      unified headers), handled above via rateLimitInfo.resetTime.
			//   2. For a direct 402 (or a provider-classified xai_capacity_402)
			//      only, a fresh, future cached xAI credits.resets_at from
			//      usageCache (missing/invalid/stale/past entries are ignored).
			//      Scoped to 402 because a transient 429 has no billing-window
			//      semantics: inheriting the cached reset could bench an
			//      otherwise-healthy account for hours on a short-lived blip.
			//   3. The bounded no-reset probe cooldown (exponential backoff).
			const isDirect402 =
				response.status === 402 || rateLimitInfo.reason === "xai_capacity_402";
			const cachedResetTime = isDirect402
				? resolveXaiCachedResetTime(account.id)
				: null;
			await applyRateLimitCooldownAwaitingPersist(
				account,
				{
					resetTime: rateLimitInfo.resetTime ?? cachedResetTime ?? undefined,
					remaining: rateLimitInfo.remaining,
					reason: rateLimitInfo.reason,
				},
				ctx,
			);
		} else if (rateLimitInfo.resetTime) {
			handleRateLimitResponse(account, rateLimitInfo, ctx, response.status);
		} else {
			// Mark as rate-limited even without reset time. Route through
			// applyRateLimitCooldown so the consecutive counter ramps correctly
			// even for reset-less 429s.
			const reason: RateLimitReason =
				response.status === 529
					? "upstream_529_overloaded_no_reset"
					: "upstream_429_no_reset_probe_cooldown";
			applyRateLimitCooldown(account, { reason }, ctx);
		}
		// Also update metadata for rate-limited responses
		const bypassSession =
			requestMeta?.headers?.get("x-better-ccflare-bypass-session") === "true";
		updateAccountMetadata(account, response, ctx, requestId, bypassSession);
		return true; // Signal rate limit
	}

	const skipAccountMetadata = isSyntheticCountTokensRequest(ctx, requestMeta);
	if (!skipAccountMetadata) {
		// Update account metadata in background
		const bypassSession =
			requestMeta?.headers?.get("x-better-ccflare-bypass-session") === "true";
		updateAccountMetadata(account, response, ctx, requestId, bypassSession);
	}

	if (!rateLimitInfo.isRateLimited && !skipAccountMetadata) {
		completeRateLimitProbe(account, response.ok ? "recovered" : "abandoned");
		// Cooldown/reason state is cleared only by an actual provider-approved
		// success (response.ok), never by a non-rate-limited error response
		// (400/403/404/500/etc). Without this gate, ANY non-rate-limited error
		// status, not just 2xx, would clear an account's cooldown/consecutive
		// counter, silently undoing a still-valid cooldown the moment the
		// account returns an unrelated error.
		if (response.ok) {
			// (a) Stability reset: gated only on rate_limited_at.
			// clearExpiredRateLimits nulls rate_limited_until without touching rate_limited_at,
			// so we must not gate on rate_limited_until or we'd miss accounts already cleared
			// by that job.
			if (
				account.rate_limited_at &&
				Date.now() - account.rate_limited_at > getRateLimitResetStabilityMs()
			) {
				account.consecutive_rate_limits = 0;
				account.rate_limited_at = null;
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.resetConsecutiveRateLimits(account.id),
				);
			}

			// (b) Clear rate_limited_until on any successful upstream response. We clear
			// unconditionally (even if the timestamp is still in the future) because a
			// successful response proves the account is usable, e.g. after a seat
			// reassignment that resets usage mid-window before the stored expiry fires.
			if (account.rate_limited_until) {
				account.rate_limited_until = null;
				ctx.asyncWriter.enqueue(async () => {
					const db = ctx.dbOps.getAdapter();
					await db.run(
						"UPDATE accounts SET rate_limited_until = NULL WHERE id = ? AND rate_limited_until IS NOT NULL",
						[account.id],
					);
					log.debug(
						`Cleared rate_limited_until for account ${account.name} on successful response`,
					);
				});
			}
		}
	}

	return false;
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
export function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
