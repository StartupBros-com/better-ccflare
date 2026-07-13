import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import {
	type AnyUsageData,
	getRepresentativeUtilizationForProvider,
	getRepresentativeWindowForProvider,
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
interface SessionAccountData {
	status: "known" | "unknown";
	account?: {
		id: string;
		name: string;
		provider: string;
		paused: boolean;
		/** Representative usage-window utilization (0-100), or null when unknown. */
		usageUtilization: number | null;
		/** Label of the representative usage window (e.g. "five_hour"), or null. */
		usageWindow: string | null;
		/** Reset time (ms epoch) of the representative usage window, if known. */
		usageResetMs: number | null;
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
			usageUtilization = getRepresentativeUtilizationForProvider(
				usageData as AnyUsageData,
				provider,
			);
			// Provider-aware window label so non-anthropic providers (zai, nanogpt,
			// kilo, alibaba-coding-plan, xai) don't silently resolve to a null window
			// while their utilization is known.
			usageWindow = getRepresentativeWindowForProvider(
				usageData as AnyUsageData,
				provider,
			);
			usageResetMs = getRepresentativeUsageResetMs(usageData, provider);
		}

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
