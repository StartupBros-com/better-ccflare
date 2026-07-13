import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import {
	type AnyUsageData,
	getRepresentativeUtilizationForDisplay,
	getRepresentativeWindowForProvider,
	type UsageData,
	usageCache,
} from "@better-ccflare/providers";
import {
	getServedAccount,
	getUsageThrottleStatus,
} from "@better-ccflare/proxy";
import {
	computeRateLimitStatusDisplay,
	getRepresentativeUsageResetMs,
} from "./rate-limit-status";

/**
 * Shape of the serving-account payload the status-line script consumes. Kept
 * deliberately flat and single-shape: `status` is always present, `account` is
 * present only when `status === "known"` (KTD-4), so the caller never branches
 * on an error envelope.
 */
/** One of an account's usage-limit windows (e.g. Anthropic 5h and 7d are two). */
interface LimitWindow {
	/** Window key, e.g. "five_hour" / "seven_day" / provider-specific like "credits". */
	window: string;
	/** Utilization toward this window's limit (0-100). */
	utilization: number;
	/** Reset time (ms epoch) of this window, if known. */
	resetMs: number | null;
}

interface SessionAccountData {
	status: "known" | "unknown";
	account?: {
		id: string;
		name: string;
		provider: string;
		paused: boolean;
		/** Representative (worst) usage-window utilization (0-100), or null. */
		usageUtilization: number | null;
		/** Label of the representative usage window (e.g. "five_hour"), or null. */
		usageWindow: string | null;
		/** Reset time (ms epoch) of the representative usage window, if known. */
		usageResetMs: number | null;
		/**
		 * ALL of the account's active limit windows, each with its own utilization
		 * and reset — so the badge can show them independently (an account can hit
		 * its 5h limit while well under its 7d weekly). Adaptive: 2 for Anthropic
		 * (5h + 7d), 1 for single-window providers (e.g. Grok credits), 0 when the
		 * account reports no usage data (e.g. Codex during a no-limit promo).
		 */
		windows: LimitWindow[];
		/** Human-readable rate-limit display string ("OK", "usage_exhausted (12m)", …). */
		rateLimitStatus: string;
		/** Local cooldown lock (ms epoch), set by 429-driven backoff. */
		rateLimitedUntil: number | null;
		/** Reset time (ms epoch) of the last unified rate-limit header snapshot. */
		rateLimitReset: number | null;
		/** Time (ms epoch) the account is usage-throttled until, if throttling is on. */
		usageThrottledUntil: number | null;
		/** Names of the windows driving the throttle, if any. */
		usageThrottledWindows: string[];
	};
}

function unknownResponse(): Response {
	return jsonResponse({
		success: true,
		data: { status: "unknown" } satisfies SessionAccountData,
	});
}

/** Parse a reset timestamp: ISO string (anthropic) or ms number (zai/nanogpt). */
function toResetMs(resets: unknown): number | null {
	if (typeof resets === "string") {
		const ms = Date.parse(resets);
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof resets === "number" && Number.isFinite(resets)) return resets;
	return null;
}

/**
 * Whether a window represents a REAL active limit rather than a dormant or
 * absent one. A window with no reset AND zero utilization is either dormant
 * (nothing consumed in that window) or a placeholder the provider fills in for a
 * limit that doesn't currently apply — e.g. Codex's usage parser defaults the
 * five_hour window to {0, null} during the current no-5h-limit promo. Surfacing
 * those as "5h 0%" would invent a limit that isn't there, so they're dropped;
 * anything with a pending reset or real usage is a genuine limit and is kept.
 */
function isActiveWindow(utilization: number, resetMs: number | null): boolean {
	return resetMs !== null || utilization > 0;
}

/**
 * All of an account's active limit windows. Anthropic/Codex expose two
 * account-level hard limits — five_hour (rolling session) and seven_day (weekly)
 * — that move independently, so both are returned when present; a limits[]-only
 * payload derives them from the session/weekly_all entries. Every other provider
 * has a single meaningful window, so its representative window is returned as a
 * one-element list. Windows the account doesn't report are simply omitted, which
 * is what makes the badge adapt (no 5h during a Codex no-limit promo, Grok's
 * single dynamic window, etc.).
 */
function buildLimitWindows(
	usageData: AnyUsageData | null,
	provider: string,
	representative: LimitWindow | null,
): LimitWindow[] {
	if (!usageData) return [];
	if (provider === "anthropic" || provider === "codex") {
		const ud = usageData as UsageData;
		const out: LimitWindow[] = [];
		for (const key of ["five_hour", "seven_day"] as const) {
			const w = ud[key] as
				| { utilization?: number; resets_at?: string | null }
				| undefined;
			if (w && typeof w.utilization === "number") {
				const resetMs = toResetMs(w.resets_at);
				if (isActiveWindow(w.utilization, resetMs))
					out.push({ window: key, utilization: w.utilization, resetMs });
			}
		}
		// limits[]-only payloads carry no flat five_hour/seven_day objects; derive
		// them from the generic session / weekly_all caps instead.
		if (out.length === 0 && Array.isArray(ud.limits)) {
			for (const lim of ud.limits) {
				if (!lim || typeof lim.percent !== "number") continue;
				const window =
					lim.kind === "session"
						? "five_hour"
						: lim.kind === "weekly_all"
							? "seven_day"
							: null;
				if (!window) continue;
				const resetMs = toResetMs(lim.resets_at);
				if (isActiveWindow(lim.percent, resetMs))
					out.push({ window, utilization: lim.percent, resetMs });
			}
		}
		return out;
	}
	// Single-window providers: surface the representative window if it's active.
	return representative &&
		isActiveWindow(representative.utilization, representative.resetMs)
		? [representative]
		: [];
}

/**
 * `GET /api/sessions/:sessionId/account` — return the account that most recently
 * served the given Claude Code session, with its usage-toward-limit and
 * rate-limit/paused/throttled state, or a well-formed `unknown` (R4, R5).
 *
 * The serving account id comes from the proxy's in-memory session→account
 * observer (U1); name, usage, and health are resolved at read time so the badge
 * never shows a stale usage snapshot. Usage is composed with the same
 * provider-aware pieces `health.ts` uses (`usageCache` +
 * `getRepresentativeUtilizationForProvider` + `getRepresentativeUsageResetMs`),
 * NOT the per-provider dispatch block in `createAccountsListHandler` — that
 * block's guards are what the shared health composition exists to avoid
 * duplicating (PR #299 split-brain note).
 *
 * The endpoint is exempt from API-key auth (see `isStaticPathExempt`): the
 * caller is a local status-line script with no credential store, and the payload
 * is coarse operational state with no secrets (KTD-3).
 */
export function createSessionAccountHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (sessionId: string): Promise<Response> => {
		const trimmed = sessionId?.trim();
		if (!trimmed) {
			return errorResponse(BadRequest("Session id cannot be empty"));
		}

		const accountId = getServedAccount(trimmed);
		if (!accountId) {
			// No live association for this session (fresh chat, proxy restart, or an
			// older/non-Claude-Code client that sends no session header). AE2, AE4.
			return unknownResponse();
		}

		const accounts = await dbOps.getAllAccounts();
		const account = accounts.find((a) => a.id === accountId);
		if (!account) {
			// The mapping points at a since-deleted account — resolve to unknown so
			// the script's parse path stays single-shape (KTD-4).
			return unknownResponse();
		}

		const now = Date.now();
		const provider = account.provider ?? "anthropic";
		const usageData = usageCache.get(account.id) ?? null;

		let usageUtilization: number | null = null;
		let usageWindow: string | null = null;
		let usageResetMs: number | null = null;
		if (usageData) {
			// Utilization, window, and reset must all describe the SAME quota, so
			// use the display-paired dispatchers (not the routing-side
			// getRepresentativeUtilizationForProvider, which selects a different
			// window set). This mirrors the accounts-list display and keeps the
			// badge's percentage, window label, and reset countdown consistent.
			usageUtilization = getRepresentativeUtilizationForDisplay(
				usageData as AnyUsageData,
				provider,
			);
			usageWindow = getRepresentativeWindowForProvider(
				usageData as AnyUsageData,
				provider,
			);
			usageResetMs = getRepresentativeUsageResetMs(usageData, provider);
		}

		// All of the account's limit windows (Anthropic 5h + 7d; others their one
		// window), so the badge can show them independently.
		const windows = buildLimitWindows(
			usageData as AnyUsageData | null,
			provider,
			usageUtilization != null
				? {
						window: usageWindow ?? "",
						utilization: usageUtilization,
						resetMs: usageResetMs,
					}
				: null,
		);

		// Computed after usage resolution so an exhausted usage window can outrank
		// stale header snapshots and the bare "OK" default (same precedence as the
		// accounts list handler; incident 2026-07-09).
		const rateLimitStatus = computeRateLimitStatusDisplay(
			{
				rate_limit_status: account.rate_limit_status ?? null,
				rate_limit_reset: account.rate_limit_reset ?? null,
				rate_limited_until: account.rate_limited_until ?? null,
				usageUtilization,
				usageResetMs,
			},
			now,
		);

		// Usage-throttled state, computed from the throttling config exactly as
		// createAccountsListHandler does (display path surfaces all per-model caps).
		let usageThrottledUntil: number | null = null;
		let usageThrottledWindows: string[] = [];
		const throttleSettings = {
			fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
		};
		if (
			(throttleSettings.fiveHourEnabled || throttleSettings.weeklyEnabled) &&
			usageData
		) {
			const throttle = getUsageThrottleStatus(
				usageData as AnyUsageData,
				throttleSettings,
				now,
				{ scopedMode: "all" },
			);
			usageThrottledUntil = throttle.throttleUntil;
			usageThrottledWindows = throttle.throttledWindows;
		}

		const data: SessionAccountData = {
			status: "known",
			account: {
				id: account.id,
				name: account.name,
				provider,
				paused: account.paused,
				usageUtilization,
				usageWindow,
				usageResetMs,
				windows,
				rateLimitStatus,
				rateLimitedUntil: account.rate_limited_until ?? null,
				rateLimitReset: account.rate_limit_reset ?? null,
				usageThrottledUntil,
				usageThrottledWindows,
			},
		};

		return jsonResponse({ success: true, data });
	};
}
