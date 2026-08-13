import { CLAUDE_CLI_VERSION, getModelFamily } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { supportsUsageTracking } from "@better-ccflare/types";
import {
	type AlibabaCodingPlanUsageData,
	fetchAlibabaCodingPlanUsageData,
	getRepresentativeAlibabaCodingPlanUtilization,
	getRepresentativeAlibabaCodingPlanWindow,
} from "./alibaba-coding-plan-usage-fetcher";
import {
	fetchKiloUsageData,
	getRepresentativeKiloUtilization,
	getRepresentativeKiloWindow,
	type KiloUsageData,
} from "./kilo-usage-fetcher";
import {
	fetchMinimaxUsageData,
	getRepresentativeMinimaxUtilization,
	getRepresentativeMinimaxWindow,
	type MinimaxUsageData,
} from "./minimax-usage-fetcher";
import {
	fetchNanoGPTUsageData,
	getRepresentativeNanoGPTUtilization,
	getRepresentativeNanoGPTWindow,
	type NanoGPTUsageData,
} from "./nanogpt-usage-fetcher";
import { fetchCodexUsageData } from "./providers/codex/api-usage";
import {
	fetchXaiUsageData,
	getRepresentativeXaiUtilization,
	getRepresentativeXaiWindow,
	type XaiUsageData,
} from "./xai-usage-fetcher";
import {
	fetchZaiUsageData,
	getRepresentativeZaiUtilization,
	getRepresentativeZaiWindow,
	type ZaiUsageData,
} from "./zai-usage-fetcher";

const log = new Logger("UsageFetcher");

/** Conservative fallback when direct out_of_credits evidence has no reset. */
export const MODEL_SCOPED_DEPLETION_TTL_MS = 5 * 60 * 1000;
/** Existing public cache freshness contract. Capacity policy may use a tighter bound. */
export const USAGE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_MODEL_SCOPED_DEPLETIONS_PER_ACCOUNT = 64;
const MAX_FAMILY_SCOPED_DEPLETIONS_PER_ACCOUNT = 8;

interface ModelScopedDepletion {
	expiresAt: number;
	markedAt: number;
}

interface FamilyScopedDepletion extends ModelScopedDepletion {
	family: string;
}

function normalizeModelScope(model: string): string {
	return model.trim().toLowerCase();
}

export function canonicalizeBetaSignature(
	value: string | null | undefined,
): string {
	if (!value) return "";
	return [
		...new Set(
			value
				.split(",")
				.map((part) => part.trim().toLowerCase())
				.filter(Boolean),
		),
	]
		.sort()
		.join(",");
}

function modelScopedDepletionKey(
	model: string,
	betaSignature?: string | null,
): string {
	return `model:${normalizeModelScope(model)}::beta:${canonicalizeBetaSignature(betaSignature)}`;
}

export interface UsageWindow {
	utilization: number;
	resets_at: string | null;
}

export interface ExtraUsage {
	is_enabled: boolean;
	monthly_limit: number | null;
	used_credits: number | null;
	utilization: number | null;
}

// Anthropic's generic per-limit representation (2026 usage API). Session and
// all-models weekly come as kind "session" / "weekly_all"; per-model weekly caps
// (Fable/Opus/Sonnet) come ONLY as kind "weekly_scoped" with scope.model.
export interface UsageLimit {
	kind: string; // "session" | "weekly_all" | "weekly_scoped" | ...
	group?: string; // "session" | "weekly"
	percent: number | null;
	severity?: "normal" | "warning" | "critical" | string;
	resets_at: string | null;
	scope?: {
		model?: { id: string | null; display_name: string } | null;
		surface?: string | null;
	} | null;
	is_active?: boolean;
}

// Overage / pay-as-you-go credit spend block from the usage payload.
export interface UsageSpend {
	used?: { amount_minor: number; currency: string; exponent: number } | null;
	limit?: unknown;
	percent?: number | null;
	severity?: string;
	enabled?: boolean;
	currency?: string | null;
	disabled_reason?: string | null;
}

export interface UsageData {
	// Core windows — present on legacy payloads but ABSENT on limits[]-only
	// payloads (Anthropic is migrating the flat windows into the generic limits[]).
	five_hour?: UsageWindow;
	seven_day?: UsageWindow;
	seven_day_oauth_apps?: UsageWindow;
	seven_day_opus?: UsageWindow | null;
	// New fields from 2025-11 API update (all optional for backward compatibility)
	seven_day_sonnet?: UsageWindow | null;
	seven_day_fable?: UsageWindow | null;
	iguana_necktie?: unknown; // Unknown purpose, keep as flexible type
	extra_usage?: ExtraUsage;
	// New generic representation (2026 API): session/weekly_all/weekly_scoped
	// entries. Per-model weekly caps (Fable/Opus/Sonnet) live ONLY here.
	limits?: UsageLimit[];
	spend?: UsageSpend;
	// Allow any additional fields Anthropic might add in the future
	[key: string]: UsageWindow | ExtraUsage | UsageLimit[] | UsageSpend | unknown;
}

// Union type for all provider usage data
export type AnyUsageData =
	| UsageData
	| NanoGPTUsageData
	| ZaiUsageData
	| KiloUsageData
	| AlibabaCodingPlanUsageData
	| XaiUsageData
	| MinimaxUsageData;

/** A read-only view of one authoritative cache observation. */
export interface UsageSnapshot {
	readonly data: AnyUsageData;
	readonly observedAt: number;
}

/**
 * Minimum advance of the upstream reset timestamp that counts as a real window
 * rollover.
 *
 * Providers recompute `resets_at` per response and it jitters by fractions of a
 * second around the same instant, so comparing for any advance at all reports a
 * rollover on nearly every poll. Measured over 48h of production traffic across
 * three Anthropic accounts: 1554 of 1564 detections were jitter (largest 1.879s)
 * and the 10 genuine rollovers all advanced by exactly 5.00h — nothing landed in
 * between. 60s sits in that empty gap with a wide margin on both sides.
 */
export const WINDOW_RESET_MIN_ADVANCE_MS = 60_000;

/**
 * Extract the primary window reset timestamp (ms) from usage data.
 * Returns null if the provider doesn't expose a reset time or it isn't available.
 */
export function extractWindowResetTime(
	data: AnyUsageData,
	provider: string,
): number | null {
	if (provider === "zai") {
		const zai = data as ZaiUsageData;
		return zai.tokens_limit?.resetAt ?? null;
	}
	if (provider === "anthropic" || provider === "codex") {
		const d = data as UsageData;
		// Prefer the flat five_hour window; fall back to the limits[] session
		// entry so limits-only payloads still expose a session reset time.
		const resetsAt =
			d.five_hour?.resets_at ??
			(Array.isArray(d.limits)
				? (d.limits.find((l) => l?.kind === "session")?.resets_at ?? null)
				: null);
		if (!resetsAt) return null;
		const ms = new Date(resetsAt).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (provider === "xai") {
		const xai = data as XaiUsageData;
		const resetsAt = xai.credits?.resets_at;
		if (!resetsAt) return null;
		const ms = new Date(resetsAt).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (provider === "minimax") {
		const m = data as MinimaxUsageData;
		const windowName = getRepresentativeMinimaxWindow(m);
		if (windowName === "seven_day") {
			return m.seven_day?.resetAt ?? null;
		}
		// Default and "five_hour": prefer the short window's reset
		return m.five_hour?.resetAt ?? m.seven_day?.resetAt ?? null;
	}
	return null;
}

/**
 * Extract the all-model weekly reset (`seven_day` or `limits[].weekly_all`)
 * from the Anthropic/Codex usage contract. Other providers may expose a
 * seven-day-looking credit window with different semantics; those payloads
 * deliberately fail open instead of becoming an account-drain signals. This
 * is intentionally separate from `extractWindowResetTime`, whose contract is
 * the representative (often five-hour) window. Unknown or malformed
 * telemetry is represented as `null` so callers can fail open to their normal
 * ordering.
 */
export function extractWeeklyResetTime(
	data: AnyUsageData,
	provider: string,
	nowMs: number = Date.now(),
): number | null {
	if (provider !== "anthropic" && provider !== "codex") return null;
	if (!data || typeof data !== "object") return null;
	const usage = data as UsageData;

	// Keep source precedence (flat seven_day before limits[]) while parsing each
	// source independently. A malformed/stale flat value must not mask a usable
	// weekly_all entry during the limits[] migration.
	const candidates: number[] = [];
	const parseReset = (value: unknown): number | null => {
		if (typeof value !== "string" || value.length === 0) return null;
		const timestamp = new Date(value).getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	};

	const flatReset = parseReset(usage.seven_day?.resets_at);
	if (flatReset !== null) candidates.push(flatReset);

	if (Array.isArray(usage.limits)) {
		for (const limit of usage.limits) {
			if (!limit || limit.kind !== "weekly_all" || limit.is_active === false)
				continue;
			const limitsReset = parseReset(limit.resets_at);
			if (limitsReset !== null) candidates.push(limitsReset);
		}
	}

	if (candidates.length === 0) return null;
	const referenceNow = Number.isFinite(nowMs) ? nowMs : Date.now();
	return (
		candidates.find((candidate) => candidate > referenceNow) ?? candidates[0]
	);
}

/**
 * Fetch usage data from Anthropic's OAuth usage endpoint
 */
export interface UsageFetchResult {
	data: UsageData | null;
	retryAfterMs: number | null; // Set when server returns retry-after on 429
}

export async function fetchUsageData(
	accessToken: string,
	externalSignal?: AbortSignal,
): Promise<UsageFetchResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	const abort = () => controller.abort();
	externalSignal?.addEventListener("abort", abort, { once: true });
	if (externalSignal?.aborted) controller.abort();
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": `claude-code/${CLAUDE_CLI_VERSION}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());

			// Extract retry-after on 429 so callers can schedule smarter backoff
			let retryAfterMs: number | null = null;
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter) {
					const seconds = Number(retryAfter);
					if (Number.isFinite(seconds) && seconds > 0) {
						retryAfterMs = Math.round(seconds * 1000);
						log.warn(`Usage endpoint rate-limited, retry-after: ${seconds}s`);
					} else {
						const retryDateMs = new Date(retryAfter).getTime();
						if (Number.isFinite(retryDateMs)) {
							const deltaMs = retryDateMs - Date.now();
							if (deltaMs > 0) {
								retryAfterMs = deltaMs;
								log.warn(
									`Usage endpoint rate-limited, retry-after date: ${retryAfter}`,
								);
							}
						}
					}
				}
			}

			try {
				const errorBody = await response.text();
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return { data: null, retryAfterMs };
		}

		const data = (await response.json()) as UsageData;
		return { data, retryAfterMs: null };
	} catch (error) {
		// Ensure we have a proper error object for logging
		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null
					? JSON.stringify(error)
					: String(error);

		log.error("Error fetching usage data:", errorMessage || "Unknown error");
		return { data: null, retryAfterMs: null };
	} finally {
		clearTimeout(timeoutId);
		externalSignal?.removeEventListener("abort", abort);
	}
}

/**
 * Get the representative utilization percentage
 * Returns the highest utilization across all windows
 * Dynamically handles any usage window fields in the response
 */
// Account-level utilization from Anthropic's generic limits[] array: session ->
// five_hour, weekly_all -> seven_day. Per-model (weekly_scoped) caps are excluded
// — they are mutual fallbacks, not hard account limits.
function accountLevelLimitWindows(
	usage: UsageData,
): Array<{ window: string; util: number }> {
	if (!Array.isArray(usage.limits)) return [];
	const out: Array<{ window: string; util: number }> = [];
	for (const limit of usage.limits) {
		if (!limit || typeof limit.percent !== "number") continue;
		if (limit.kind === "session")
			out.push({ window: "five_hour", util: limit.percent });
		else if (limit.kind === "weekly_all")
			out.push({ window: "seven_day", util: limit.percent });
	}
	return out;
}

export function getRepresentativeUtilization(
	usage: UsageData | null,
): number | null {
	if (!usage) return null;

	const utilizations: number[] = [];

	// Iterate through all properties to find UsageWindow objects
	for (const [key, value] of Object.entries(usage)) {
		// Check if this is a UsageWindow object
		if (
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			utilizations.push(value.utilization);
		}
		// Also check extra_usage if present
		if (
			key === "extra_usage" &&
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			utilizations.push(value.utilization);
		}
	}

	// Fold in Anthropic's generic limits[] account-level caps (session / weekly_all).
	for (const { util } of accountLevelLimitWindows(usage)) {
		utilizations.push(util);
	}

	// Return null (not 0) when nothing was found: 0 reads as "fully available" and
	// would falsely un-bench an exhausted account (capacity guard) and mis-rank it.
	return utilizations.length > 0 ? Math.max(...utilizations) : null;
}

/**
 * Determine which window is the most restrictive (highest utilization)
 * Dynamically handles any usage window fields in the response
 */
export function getRepresentativeWindow(
	usage: UsageData | null,
): string | null {
	if (!usage) return null;

	const windows: Array<{ name: string; util: number }> = [];

	// Iterate through all properties to find UsageWindow objects
	for (const [key, value] of Object.entries(usage)) {
		// Check if this is a UsageWindow object
		if (
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
		// Also check extra_usage if present
		if (
			key === "extra_usage" &&
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
	}

	for (const { window, util } of accountLevelLimitWindows(usage)) {
		windows.push({ name: window, util });
	}

	if (windows.length === 0) return null;

	const max = windows.reduce((prev, current) =>
		current.util > prev.util ? current : prev,
	);

	return max.name;
}

/**
 * Get the representative utilization for any supported provider type.
 * Returns null if the provider is not supported or data is unavailable.
 */
export function getRepresentativeUtilizationForProvider(
	data: AnyUsageData,
	provider: string,
): number | null {
	switch (provider) {
		case "anthropic":
		case "codex": {
			const d = data as UsageData;
			// Only account-level windows count as hard limits. Model-specific windows
			// (seven_day_sonnet, seven_day_opus) are excluded: they are mutual fallbacks
			// and Anthropic never exposes both simultaneously, so neither is a hard limit.
			const utils: number[] = [];
			for (const key of [
				"five_hour",
				"seven_day",
				"seven_day_oauth_apps",
			] as const) {
				const w = d[key] as UsageWindow | undefined;
				if (w?.utilization != null) utils.push(w.utilization);
			}
			// extra_usage has utilization: number | null
			if (d.extra_usage?.utilization != null)
				utils.push(d.extra_usage.utilization);
			// Account-level limits[] caps (session / weekly_all) for limits-only payloads.
			for (const { util } of accountLevelLimitWindows(d)) utils.push(util);
			return utils.length > 0 ? Math.max(...utils) : null;
		}
		case "nanogpt": {
			return getRepresentativeNanoGPTUtilization(data as NanoGPTUsageData);
		}
		case "zai": {
			const zai = data as ZaiUsageData;
			const candidates = [
				zai.time_limit?.percentage ?? null,
				zai.tokens_limit?.percentage ?? null,
			].filter((v): v is number => v !== null);
			return candidates.length > 0 ? Math.max(...candidates) : null;
		}
		case "kilo": {
			return getRepresentativeKiloUtilization(data as KiloUsageData);
		}
		case "alibaba-coding-plan": {
			return getRepresentativeAlibabaCodingPlanUtilization(
				data as AlibabaCodingPlanUsageData,
			);
		}
		case "xai": {
			return getRepresentativeXaiUtilization(data as XaiUsageData);
		}
		case "minimax": {
			return getRepresentativeMinimaxUtilization(data as MinimaxUsageData);
		}
		default:
			return null;
	}
}

/**
 * DISPLAY utilization: the provider-aware counterpart that PAIRS with
 * {@link getRepresentativeWindowForProvider} and {@link getRepresentativeUsageResetMs}
 * — all three dispatch to the same per-provider window set, so a badge composed
 * from them describes ONE consistent quota (utilization %, its window label, and
 * its reset time all agree).
 *
 * This differs from {@link getRepresentativeUtilizationForProvider}, which is the
 * ROUTING/health variant: for anthropic it counts only hard-limit windows
 * (excludes model-scoped fallbacks) and for zai it takes max(time_limit,
 * tokens_limit). Mixing the routing utilization with the display window/reset is
 * what let the badge report a percentage from one quota with the label/reset of
 * another (matches the accounts-list display, which pairs
 * getRepresentativeUtilization + getRepresentativeWindow).
 */
export function getRepresentativeUtilizationForDisplay(
	data: AnyUsageData,
	provider: string,
): number | null {
	switch (provider) {
		case "anthropic":
		case "codex":
			return getRepresentativeUtilization(data as UsageData);
		case "nanogpt":
			return getRepresentativeNanoGPTUtilization(data as NanoGPTUsageData);
		case "zai":
			return getRepresentativeZaiUtilization(data as ZaiUsageData);
		case "kilo":
			return getRepresentativeKiloUtilization(data as KiloUsageData);
		case "alibaba-coding-plan":
			return getRepresentativeAlibabaCodingPlanUtilization(
				data as AlibabaCodingPlanUsageData,
			);
		case "xai":
			return getRepresentativeXaiUtilization(data as XaiUsageData);
		case "minimax":
			return getRepresentativeMinimaxUtilization(data as MinimaxUsageData);
		default:
			return null;
	}
}

/**
 * Provider-aware sibling of {@link getRepresentativeUtilizationForDisplay}:
 * returns the LABEL of the representative usage window (e.g. "five_hour") for
 * any supported provider, or null. The plain {@link getRepresentativeWindow}
 * only recognizes anthropic/codex-shaped windows (objects with a `utilization`
 * field), so callers that must label the window for non-anthropic providers
 * (zai/nanogpt/kilo/alibaba-coding-plan/xai) need this dispatch — otherwise the
 * window silently resolves to null even when utilization is known.
 */
export function getRepresentativeWindowForProvider(
	data: AnyUsageData,
	provider: string,
): string | null {
	switch (provider) {
		case "anthropic":
		case "codex":
			return getRepresentativeWindow(data as UsageData);
		case "nanogpt":
			return getRepresentativeNanoGPTWindow(data as NanoGPTUsageData);
		case "zai":
			return getRepresentativeZaiWindow(data as ZaiUsageData);
		case "kilo":
			return getRepresentativeKiloWindow(data as KiloUsageData);
		case "alibaba-coding-plan":
			return getRepresentativeAlibabaCodingPlanWindow(
				data as AlibabaCodingPlanUsageData,
			);
		case "xai":
			return getRepresentativeXaiWindow(data as XaiUsageData);
		case "minimax":
			return getRepresentativeMinimaxWindow(data as MinimaxUsageData);
		default:
			return null;
	}
}

/**
 * Pull the reset timestamp (ms epoch) of a named usage window out of raw
 * provider usage data. Handles both timestamp shapes in use:
 * anthropic-style `resets_at` (ISO string) and zai/nanogpt-style `resetAt`
 * (ms number).
 */
export function extractUsageResetMs(
	usageData: unknown,
	windowName: string | null,
): number | null {
	if (!usageData || typeof usageData !== "object" || !windowName) return null;
	const window = (usageData as Record<string, unknown>)[windowName];
	if (!window || typeof window !== "object") return null;
	const w = window as { resets_at?: unknown; resetAt?: unknown };
	if (typeof w.resets_at === "string") {
		const ms = new Date(w.resets_at).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof w.resetAt === "number" && Number.isFinite(w.resetAt)) {
		return w.resetAt;
	}
	return null;
}

/**
 * limits[] `kind` that maps to each synthetic window name produced by
 * getRepresentativeWindow's accountLevelLimitWindows fold (session ->
 * five_hour, weekly_all -> seven_day). Kept in lockstep with that mapping
 * above in this file.
 */
const WINDOW_NAME_TO_LIMIT_KIND: Record<string, string> = {
	five_hour: "session",
	seven_day: "weekly_all",
};

/**
 * Reset time (ms epoch) for a limits[]-only Anthropic/Codex payload: finds
 * the limits[] entry whose `kind` corresponds to the given synthetic window
 * name and returns its own `resets_at`.
 */
function getRepresentativeLimitResetMs(
	usage: UsageData,
	windowName: string | null,
): number | null {
	if (!windowName || !Array.isArray(usage.limits)) return null;
	const kind = WINDOW_NAME_TO_LIMIT_KIND[windowName];
	if (!kind) return null;
	const limit = usage.limits.find((l) => l?.kind === kind);
	const resetsAt = limit?.resets_at;
	if (typeof resetsAt !== "string") return null;
	const ms = new Date(resetsAt).getTime();
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Reset time (ms epoch) of the representative usage window, derived the same
 * way for every provider — the single source BOTH the /health usage_exhausted
 * counter and the accounts rateLimitStatus display use, so their staleness
 * guards cannot diverge (PR #299 review finding). Note zai: the display
 * window is labeled "five_hour" (Claude terminology), but the payload key
 * carrying the reset is `tokens_limit` — extraction must use the payload key,
 * not the display label.
 */
export function getRepresentativeUsageResetMs(
	usageData: unknown,
	provider: string,
): number | null {
	if (!usageData || typeof usageData !== "object") return null;
	try {
		const data = usageData as AnyUsageData;
		switch (provider) {
			case "anthropic":
			case "codex": {
				const windowName = getRepresentativeWindow(data as UsageData);
				// Flat legacy shape: the window name is an actual property
				// (five_hour/seven_day/...) carrying its own resets_at.
				const flatReset = extractUsageResetMs(data, windowName);
				if (flatReset !== null) return flatReset;
				// limits[]-only payloads (2026 API): five_hour/seven_day are
				// absent as properties — getRepresentativeWindow derives those
				// same names synthetically from limits[] kind "session" /
				// "weekly_all". Fall back to the matching limits[] entry's own
				// resets_at so the staleness guard still has a real reset time.
				return getRepresentativeLimitResetMs(data as UsageData, windowName);
			}
			case "zai":
				return extractUsageResetMs(
					data,
					(data as ZaiUsageData).tokens_limit ? "tokens_limit" : null,
				);
			case "nanogpt":
				return extractUsageResetMs(
					data,
					getRepresentativeNanoGPTWindow(data as NanoGPTUsageData),
				);
			case "kilo":
				return extractUsageResetMs(
					data,
					getRepresentativeKiloWindow(data as KiloUsageData),
				);
			case "alibaba-coding-plan":
				return extractUsageResetMs(
					data,
					getRepresentativeAlibabaCodingPlanWindow(
						data as AlibabaCodingPlanUsageData,
					),
				);
			case "xai":
				return extractUsageResetMs(
					data,
					getRepresentativeXaiWindow(data as XaiUsageData),
				);
			case "minimax": {
				const windowName = getRepresentativeMinimaxWindow(
					data as MinimaxUsageData,
				);
				// extractUsageResetMs reads `resets_at` (string) OR `resetAt` (ms);
				// the Minimax fetcher populates `resetAt` with epoch ms, so this
				// works for both 5h and 7d windows.
				return extractUsageResetMs(data, windowName);
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/**
 * Representative utilization paired with the reset that belongs to the same
 * winning window. Zai needs special handling because its utilization is the
 * max of time_limit and tokens_limit while getRepresentativeUsageResetMs is
 * intentionally tokens_limit-only for display surfaces. Other providers keep
 * their existing representative-reset behavior unchanged.
 */
export function getRepresentativeUsageSnapshotForProvider(
	data: AnyUsageData,
	provider: string,
): { utilization: number; resetMs: number | null } | null {
	if (provider === "zai") {
		const zai = data as ZaiUsageData;
		const candidates = [zai.time_limit, zai.tokens_limit].filter(
			(window): window is NonNullable<typeof window> => window !== null,
		);
		if (candidates.length === 0) return null;
		// On a tie (both windows equally exhausted), prefer the LATER reset —
		// the account isn't actually available again until every exhausted
		// window clears, so picking the earlier one would tell clients to
		// retry while the other window is still capped.
		const winning = candidates.reduce((prev, current) => {
			if (current.percentage !== prev.percentage) {
				return current.percentage > prev.percentage ? current : prev;
			}
			if (current.resetAt === null || prev.resetAt === null) {
				return prev.resetAt === null ? prev : current;
			}
			return current.resetAt > prev.resetAt ? current : prev;
		});
		return {
			utilization: winning.percentage,
			resetMs: winning.resetAt,
		};
	}

	const utilization = getRepresentativeUtilizationForProvider(data, provider);
	if (utilization === null) return null;
	return {
		utilization,
		resetMs: getRepresentativeUsageResetMs(data, provider),
	};
}

/**
 * Type for a function that retrieves a fresh access token or API key
 */
export type AccessTokenProvider = () => Promise<string>;

type PollRegistration = {
	accountId: string;
	epoch: number;
	tokenProvider: AccessTokenProvider;
	provider?: string;
	customEndpoint?: string | null;
	baseIntervalMs: number;
	onWindowReset?: (accountId: string) => void;
	onCapacityRestored?: (accountId: string) => void;
	onSnapshot?: (accountId: string, data: UsageData) => void;
	timer?: NodeJS.Timeout;
	abortController: AbortController;
	failureCount: number;
};

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, { data: AnyUsageData; timestamp: number }>();
	/**
	 * Exactly one live registration per account, created by each startPolling
	 * call. Registration identity — not the account id — is the correctness
	 * guard: a stop→start pair replaces the map entry, so every async
	 * continuation belonging to the previous generation fails its identity
	 * check and writes nothing.
	 */
	private registrations = new Map<string, PollRegistration>();
	private nextEpoch = 0;
	private usageRateLimitedUntil = new Map<string, number>(); // Tracks when usage API 429 clears
	private modelScopedDepletions = new Map<
		string,
		Map<string, ModelScopedDepletion>
	>();
	private familyScopedDepletions = new Map<
		string,
		Map<string, FamilyScopedDepletion>
	>();
	private inFlightFetches = new Map<
		string,
		{
			registration: PollRegistration;
			promise: Promise<{ success: boolean; retryAfterMs: number | null }>;
		}
	>();

	/** True only while this exact registration still owns its account. */
	private isCurrent(registration: PollRegistration): boolean {
		return this.registrations.get(registration.accountId) === registration;
	}

	/**
	 * Drop the in-flight entry only when it still references this exact
	 * registration AND this exact promise: an older generation completing after
	 * a stop→start must not delete the replacement's live fetch (which would
	 * un-deduplicate concurrent refreshes and let a second request fly).
	 */
	private clearInFlight(
		registration: PollRegistration,
		promise: Promise<{ success: boolean; retryAfterMs: number | null }>,
	): void {
		const current = this.inFlightFetches.get(registration.accountId);
		if (current?.registration === registration && current.promise === promise) {
			this.inFlightFetches.delete(registration.accountId);
		}
	}

	/**
	 * Deduplicate concurrent fetches per registration. Dedup is keyed on the
	 * registration, so a stale generation's promise is never handed to the
	 * replacement.
	 */
	private fetchRegistration(
		registration: PollRegistration,
	): Promise<{ success: boolean; retryAfterMs: number | null }> {
		const current = this.inFlightFetches.get(registration.accountId);
		if (current?.registration === registration) {
			log.debug(
				`Reusing in-flight fetch for account ${registration.accountId} — skipping duplicate request`,
			);
			return current.promise;
		}

		const promise = this._doFetchAndCache(registration);
		this.inFlightFetches.set(registration.accountId, { registration, promise });
		promise.finally(() => this.clearInFlight(registration, promise));
		return promise;
	}

	private setRegistrationCache(
		registration: PollRegistration,
		data: AnyUsageData,
	): void {
		if (!this.isCurrent(registration)) return;
		this.setAuthoritative(registration.accountId, data);
	}

	private notifySnapshot(
		registration: PollRegistration,
		data: AnyUsageData,
	): void {
		if (!this.isCurrent(registration)) return;
		registration.onSnapshot?.(registration.accountId, data as UsageData);
	}

	private notifyRegistrationWindowReset(
		registration: PollRegistration,
		data: AnyUsageData,
		provider: string,
	): void {
		if (!this.isCurrent(registration) || !registration.onWindowReset) return;
		this.notifyWindowReset(
			registration.accountId,
			data,
			provider,
			registration.onWindowReset,
		);
	}

	/**
	 * Schedule the next poll with exponential backoff on failures.
	 * If retryAfterMs is provided (from a 429 retry-after header), it takes
	 * precedence over the calculated backoff delay. Failure streaks live on the
	 * registration, so a stopped generation cannot inflate the replacement's
	 * backoff or add a second concurrent timer chain.
	 */
	private scheduleNextPoll(
		registration: PollRegistration,
		retryAfterMs?: number | null,
	) {
		if (!this.isCurrent(registration)) return;
		const failures = registration.failureCount;
		const baseIntervalMs = registration.baseIntervalMs;
		// Add ±20% random jitter to the base interval so accounts spread out
		// and don't lock into sync with each other over time.
		const jitter = (Math.random() - 0.5) * 0.4 * baseIntervalMs;
		// Use server-provided retry-after if available, otherwise exponential backoff capped at 30 minutes
		const delay =
			retryAfterMs != null
				? retryAfterMs
				: failures === 0
					? baseIntervalMs + jitter
					: Math.min(baseIntervalMs * 2 ** failures, 30 * 60 * 1000);

		if (failures > 0) {
			log.info(
				`Usage poll backoff for account ${registration.accountId}: retry in ${Math.round(delay / 1000)}s (${failures} consecutive failure(s))${retryAfterMs != null ? " [server retry-after]" : ""}`,
			);
		}

		registration.timer = setTimeout(async () => {
			registration.timer = undefined;
			// Bail if this generation was stopped or replaced.
			if (!this.isCurrent(registration)) return;

			const { success, retryAfterMs: nextRetryAfterMs } =
				await this.fetchRegistration(registration);
			if (!this.isCurrent(registration)) return;
			registration.failureCount = success ? 0 : registration.failureCount + 1;
			this.scheduleNextPoll(registration, nextRetryAfterMs);
		}, delay);
	}

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(
		accountId: string,
		accessTokenOrProvider: string | AccessTokenProvider,
		provider?: string,
		intervalMs?: number,
		customEndpoint?: string | null,
		onWindowReset?: (accountId: string) => void,
		onCapacityRestored?: (accountId: string) => void,
		onSnapshot?: (accountId: string, data: UsageData) => void,
	) {
		// Check if provider supports usage tracking
		if (provider && !supportsUsageTracking(provider)) {
			log.info(
				`Skipping usage polling for account ${accountId} - provider ${provider} does not support usage tracking`,
			);
			return;
		}

		// Retire any previous generation first: its timer is cleared, its fetch
		// is aborted, and its identity check now fails permanently.
		if (this.registrations.has(accountId)) {
			log.warn(
				`Clearing existing polling registration for account ${accountId} before starting new one`,
			);
			this.stopPolling(accountId);
		}

		// Store the token provider (either a static token or a function)
		const tokenProvider: AccessTokenProvider =
			typeof accessTokenOrProvider === "string"
				? async () => accessTokenOrProvider
				: accessTokenOrProvider;

		const registration: PollRegistration = {
			accountId,
			epoch: ++this.nextEpoch,
			tokenProvider,
			provider,
			customEndpoint,
			// Default to 90s if not provided
			baseIntervalMs: intervalMs ?? 90000,
			onWindowReset,
			onCapacityRestored,
			onSnapshot,
			abortController: new AbortController(),
			failureCount: 0,
		};
		this.registrations.set(accountId, registration);

		// Immediate fetch
		void this.fetchRegistration(registration).then(
			({ success, retryAfterMs }) => {
				if (!this.isCurrent(registration)) return;
				registration.failureCount = success ? 0 : 1;
				this.scheduleNextPoll(registration, retryAfterMs);
			},
		);

		log.debug(
			`Started usage polling for account ${accountId} (provider: ${provider}) with base interval ${Math.round(registration.baseIntervalMs / 1000)}s`,
		);
	}

	/**
	 * Trigger an immediate usage fetch for an account that already has polling configured.
	 * Returns false when no polling/token provider is configured or when the fetch fails.
	 * A refresh whose registration was stopped or replaced mid-flight reports
	 * failure rather than publishing a result for a generation that is gone.
	 */
	async refreshNow(accountId: string): Promise<boolean> {
		const registration = this.registrations.get(accountId);
		if (!registration) {
			return false;
		}

		const { success } = await this.fetchRegistration(registration);
		return success && this.isCurrent(registration);
	}

	/**
	 * Stop polling for an account
	 */
	stopPolling(accountId: string) {
		const registration = this.registrations.get(accountId);
		if (!registration) return;

		this.registrations.delete(accountId);
		if (registration.timer) {
			clearTimeout(registration.timer);
			registration.timer = undefined;
		}
		// Best-effort cancellation of the generation's outstanding request where
		// the provider fetcher accepts a signal; the identity checks in
		// _doFetchAndCache remain the correctness guard for fetchers that don't.
		registration.abortController.abort();
		// Clean up cache entry when polling stops to prevent memory leaks
		this.cache.delete(accountId);
		this.usageRateLimitedUntil.delete(accountId);
		this.modelScopedDepletions.delete(accountId);
		this.familyScopedDepletions.delete(accountId);
		// Drop the in-flight entry only if it still belongs to this generation.
		const inFlight = this.inFlightFetches.get(accountId);
		if (inFlight?.registration === registration) {
			this.inFlightFetches.delete(accountId);
		}
		log.info(
			`Stopped usage polling and cleared cache for account ${accountId}`,
		);
	}

	private async _doFetchAndCache(
		registration: PollRegistration,
	): Promise<{ success: boolean; retryAfterMs: number | null }> {
		const { accountId, tokenProvider, provider, customEndpoint } = registration;
		try {
			// Get a fresh access token or API key on each fetch
			let token: string;
			try {
				token = await tokenProvider();
			} catch (tokenError) {
				// Handle token provider errors that might result in empty objects
				const tokenErrorMessage =
					tokenError instanceof Error
						? tokenError.message
						: typeof tokenError === "object" && tokenError !== null
							? JSON.stringify(tokenError)
							: String(tokenError);

				log.warn(
					`Token provider failed for account ${accountId}: ${tokenErrorMessage || "Unknown error"}`,
				);
				return { success: false, retryAfterMs: null };
			}
			// Validate token before proceeding
			if (!token || (typeof token === "string" && token.trim() === "")) {
				log.warn(
					`No valid token available for account ${accountId}, skipping usage fetch`,
				);
				return { success: false, retryAfterMs: null };
			}

			// Fetch data based on provider type
			let data: AnyUsageData | null = null;

			if (provider === "nanogpt") {
				// Fetch NanoGPT usage data
				data = await fetchNanoGPTUsageData(token, customEndpoint);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					// Import NanoGPT helper functions
					const {
						getRepresentativeNanoGPTUtilization,
						getRepresentativeNanoGPTWindow,
					} = await import("./nanogpt-usage-fetcher");
					if (!this.isCurrent(registration)) {
						return { success: false, retryAfterMs: null };
					}

					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeNanoGPTUtilization(
						data as NanoGPTUsageData,
					);
					const window = getRepresentativeNanoGPTWindow(
						data as NanoGPTUsageData,
					);
					log.debug(
						`Successfully fetched NanoGPT usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "zai") {
				// Fetch Zai usage data
				data = await fetchZaiUsageData(token);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					// Import Zai helper functions
					const {
						getRepresentativeZaiUtilization,
						getRepresentativeZaiWindow,
					} = await import("./zai-usage-fetcher");
					if (!this.isCurrent(registration)) {
						return { success: false, retryAfterMs: null };
					}

					this.notifyRegistrationWindowReset(registration, data, "zai");
					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeZaiUtilization(
						data as ZaiUsageData,
					);
					const window = getRepresentativeZaiWindow(data as ZaiUsageData);
					log.debug(
						`Successfully fetched Zai usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "kilo") {
				// Fetch Kilo usage data
				data = await fetchKiloUsageData(token);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeKiloUtilization(
						data as KiloUsageData,
					);
					const window = getRepresentativeKiloWindow(data as KiloUsageData);
					log.debug(
						`Successfully fetched Kilo usage data for account ${accountId}: $${(data as KiloUsageData).remainingUsd.toFixed(2)} remaining (${utilization?.toFixed(1)}% used, ${window})`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "alibaba-coding-plan") {
				// Fetch Alibaba Coding Plan usage data
				data = await fetchAlibabaCodingPlanUsageData(token);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeAlibabaCodingPlanUtilization(
						data as AlibabaCodingPlanUsageData,
					);
					const window = getRepresentativeAlibabaCodingPlanWindow(
						data as AlibabaCodingPlanUsageData,
					);
					log.debug(
						`Successfully fetched Alibaba Coding Plan usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "xai") {
				// Fetch xAI/Grok Build credits data via grok.com gRPC-web.
				data = await fetchXaiUsageData(token);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					this.notifyRegistrationWindowReset(registration, data, "xai");
					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeXaiUtilization(
						data as XaiUsageData,
					);
					const window = getRepresentativeXaiWindow(data as XaiUsageData);
					log.debug(
						`Successfully fetched xAI Grok usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "minimax") {
				// Fetch Minimax Token Plan remains (metadata-only GET, zero quota).
				data = await fetchMinimaxUsageData(token);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (data) {
					this.notifyRegistrationWindowReset(registration, data, "minimax");
					this.setRegistrationCache(registration, data);
					this.notifySnapshot(registration, data);
					const utilization = getRepresentativeMinimaxUtilization(
						data as MinimaxUsageData,
					);
					const window = getRepresentativeMinimaxWindow(
						data as MinimaxUsageData,
					);
					log.debug(
						`Successfully fetched Minimax usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "codex") {
				// Codex/ChatGPT subscription usage via the free wham/usage
				// introspection endpoint — no quota consumed, unlike the
				// quota-consuming ping in on-demand-fetch.ts.
				const result = await fetchCodexUsageData(
					token,
					registration.abortController.signal,
				);
				if (!this.isCurrent(registration)) {
					// Polling was stopped while this fetch was in flight (e.g. the
					// account's endpoint changed away from the subscription
					// backend): discard the snapshot rather than resurrecting
					// stale subscription quota after teardown (pro-gate round 2).
					return { success: false, retryAfterMs: null };
				}
				if (result.data) {
					if (this.isCurrent(registration))
						this.usageRateLimitedUntil.delete(accountId);
					this.notifyRegistrationWindowReset(
						registration,
						result.data,
						"codex",
					);
					this.setRegistrationCache(registration, result.data);
					this.notifySnapshot(registration, result.data);
					const utilization = getRepresentativeUtilization(
						result.data as UsageData,
					);
					// Deliberately NO capacity-restored callback for codex (unlike
					// the anthropic branch): a 429 here is the wham INTROSPECTION
					// endpoint throttling, which says nothing about cooldowns on
					// the responses endpoint — firing the callback could clear a
					// live rate_limited_until and re-route a cooling account
					// (pro-gate P1). Cooldowns clear on their natural expiry.
					const window = getRepresentativeWindow(result.data as UsageData);
					log.debug(
						`Successfully fetched Codex usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
				if (
					this.isCurrent(registration) &&
					result.retryAfterMs != null &&
					result.retryAfterMs > 0
				) {
					this.usageRateLimitedUntil.set(
						accountId,
						Date.now() + result.retryAfterMs,
					);
				} else if (
					this.isCurrent(registration) &&
					result.retryAfterMs == null
				) {
					// Non-429 failure: clear any stale rate-limit marker
					this.usageRateLimitedUntil.delete(accountId);
				}
				return { success: false, retryAfterMs: result.retryAfterMs };
			} else {
				// Default to Anthropic usage data
				const result = await fetchUsageData(
					token,
					registration.abortController.signal,
				);
				if (!this.isCurrent(registration)) {
					return { success: false, retryAfterMs: null };
				}
				if (result.data) {
					// Snapshot before clearing — needed for the capacity-restored guard below.
					const wasRateLimited = this.usageRateLimitedUntil.has(accountId);
					if (this.isCurrent(registration))
						this.usageRateLimitedUntil.delete(accountId);
					this.notifyRegistrationWindowReset(
						registration,
						result.data,
						"anthropic",
					);
					this.setRegistrationCache(registration, result.data);
					this.notifySnapshot(registration, result.data);
					const utilization = getRepresentativeUtilization(
						result.data as UsageData,
					);
					// Notify capacity-restored listener only when the account was previously
					// rate-limited (usageRateLimitedUntil set) and usage now shows < 100%.
					// This handles seat-reassignment: org admin reassigns a seat mid-window,
					// Anthropic resets usage, polling detects available capacity and lets
					// the caller clear stale rate_limited_until in the DB.
					if (
						this.isCurrent(registration) &&
						utilization !== null &&
						utilization < 100 &&
						wasRateLimited
					) {
						registration.onCapacityRestored?.(accountId);
					}
					const window = getRepresentativeWindow(result.data as UsageData);
					log.debug(
						`Successfully fetched usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
				if (
					this.isCurrent(registration) &&
					result.retryAfterMs != null &&
					result.retryAfterMs > 0
				) {
					this.usageRateLimitedUntil.set(
						accountId,
						Date.now() + result.retryAfterMs,
					);
				} else if (
					this.isCurrent(registration) &&
					result.retryAfterMs == null
				) {
					// Non-429 failure: clear any stale rate-limit marker
					this.usageRateLimitedUntil.delete(accountId);
				}
				return { success: false, retryAfterMs: result.retryAfterMs };
			}

			return { success: false, retryAfterMs: null };
		} catch (error) {
			// Ensure we have a proper error object for logging
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "object" && error !== null
						? JSON.stringify(error)
						: String(error);

			log.error(
				`Error fetching usage data for account ${accountId}:`,
				errorMessage || "Unknown error",
			);
			return { success: false, retryAfterMs: null };
		}
	}

	/**
	 * Clean up stale cache entries older than maxAgeMs
	 */
	cleanupStaleEntries(maxAgeMs: number = USAGE_CACHE_MAX_AGE_MS): void {
		const now = Date.now();
		let cleanedCount = 0;

		for (const [accountId, cached] of this.cache.entries()) {
			if (now - cached.timestamp > maxAgeMs) {
				this.cache.delete(accountId);
				cleanedCount++;
			}
		}

		if (cleanedCount > 0) {
			log.debug(`Cleaned up ${cleanedCount} stale usage cache entries`);
		}
	}

	/**
	 * Get cached usage data for an account
	 */
	get(accountId: string): AnyUsageData | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		// Clean up stale entries while accessing
		const age = Date.now() - cached.timestamp;
		if (age > USAGE_CACHE_MAX_AGE_MS) {
			// 10 minutes max age
			this.cache.delete(accountId);
			log.debug(
				`Removed stale cache entry for account ${accountId} (age: ${Math.round(age / 1000)}s)`,
			);
			return null;
		}

		return cached.data;
	}

	/**
	 * Return the same fresh cache entry as get(), together with the time it was
	 * observed. The wrapper is immutable so scheduling code cannot rewrite the
	 * cache timestamp or swap its data. This deliberately retains get()'s
	 * existing ten-minute maximum age; stricter capacity freshness is evaluated
	 * by the pure routing policy.
	 */
	getSnapshot(accountId: string): UsageSnapshot | null {
		const data = this.get(accountId);
		if (data === null) return null;
		const cached = this.cache.get(accountId);
		if (!cached) return null;
		return Object.freeze({ data, observedAt: cached.timestamp });
	}

	/** Mark direct upstream evidence that one account/model/beta candidate is depleted. */
	markModelScopedExhausted(
		accountId: string,
		model: string,
		betaSignature?: string | null,
		expiresAt: number = Date.now() + MODEL_SCOPED_DEPLETION_TTL_MS,
	): void {
		const now = Date.now();
		const safeExpiresAt =
			Number.isFinite(expiresAt) && expiresAt > now
				? expiresAt
				: now + MODEL_SCOPED_DEPLETION_TTL_MS;
		let accountMarkers = this.modelScopedDepletions.get(accountId);
		if (!accountMarkers) {
			accountMarkers = new Map();
			this.modelScopedDepletions.set(accountId, accountMarkers);
		}
		const key = modelScopedDepletionKey(model, betaSignature);
		// Prune stale entries before enforcing the bound. Re-marking an existing
		// key refreshes its insertion order so bounded eviction removes the least
		// recently evidenced candidate, not a freshly reconfirmed one.
		for (const [candidateKey, marker] of accountMarkers) {
			if (marker.expiresAt <= now) accountMarkers.delete(candidateKey);
		}
		if (accountMarkers.has(key)) accountMarkers.delete(key);
		if (accountMarkers.size >= MAX_MODEL_SCOPED_DEPLETIONS_PER_ACCOUNT) {
			const oldest = accountMarkers.keys().next().value;
			if (oldest !== undefined) accountMarkers.delete(oldest);
		}
		accountMarkers.set(key, {
			expiresAt: safeExpiresAt,
			markedAt: now,
		});
	}

	/** Return active direct depletion evidence, lazily removing expired state. */
	getModelScopedExhaustion(
		accountId: string,
		model: string,
		betaSignature?: string | null,
		now: number = Date.now(),
	): { exhausted: true; expiresAt: number; markedAt: number } | null {
		const accountMarkers = this.modelScopedDepletions.get(accountId);
		if (!accountMarkers) return null;
		const key = modelScopedDepletionKey(model, betaSignature);
		const marker = accountMarkers.get(key);
		if (!marker) return null;
		if (marker.expiresAt <= now) {
			accountMarkers.delete(key);
			if (accountMarkers.size === 0) {
				this.modelScopedDepletions.delete(accountId);
			}
			return null;
		}
		return { exhausted: true, ...marker };
	}

	/** Clear only one exact model/client-beta depletion marker. */
	clearModelScopedExhaustion(
		accountId: string,
		model: string,
		betaSignature?: string | null,
	): boolean {
		const accountMarkers = this.modelScopedDepletions.get(accountId);
		if (!accountMarkers) return false;
		const cleared = accountMarkers.delete(
			modelScopedDepletionKey(model, betaSignature),
		);
		if (accountMarkers.size === 0) {
			this.modelScopedDepletions.delete(accountId);
		}
		return cleared;
	}

	/**
	 * Mark direct/inferred evidence that one recognized Claude model family is
	 * depleted. Family state is deliberately separate from exact model+beta
	 * state so a generic Fable 429 can never erase or broaden an exact marker.
	 */
	markFamilyScopedExhausted(
		accountId: string,
		model: string,
		expiresAt: number = Date.now() + MODEL_SCOPED_DEPLETION_TTL_MS,
	): boolean {
		const family = getModelFamily(model);
		if (family === null) return false;
		const now = Date.now();
		const ttlCeiling = now + MODEL_SCOPED_DEPLETION_TTL_MS;
		const safeExpiresAt =
			Number.isFinite(expiresAt) && expiresAt > now
				? Math.min(expiresAt, ttlCeiling)
				: ttlCeiling;
		let accountMarkers = this.familyScopedDepletions.get(accountId);
		if (!accountMarkers) {
			accountMarkers = new Map();
			this.familyScopedDepletions.set(accountId, accountMarkers);
		}
		for (const [candidateFamily, marker] of accountMarkers) {
			if (marker.expiresAt <= now) accountMarkers.delete(candidateFamily);
		}
		if (accountMarkers.has(family)) accountMarkers.delete(family);
		if (accountMarkers.size >= MAX_FAMILY_SCOPED_DEPLETIONS_PER_ACCOUNT) {
			const oldest = accountMarkers.keys().next().value;
			if (oldest !== undefined) accountMarkers.delete(oldest);
		}
		accountMarkers.set(family, {
			family,
			expiresAt: safeExpiresAt,
			markedAt: now,
		});
		return true;
	}

	/** Return active family evidence for the concrete model, if recognized. */
	getFamilyScopedExhaustion(
		accountId: string,
		model: string,
		now: number = Date.now(),
	): {
		exhausted: true;
		family: string;
		expiresAt: number;
		markedAt: number;
	} | null {
		const family = getModelFamily(model);
		if (family === null) return null;
		const accountMarkers = this.familyScopedDepletions.get(accountId);
		if (!accountMarkers) return null;
		const marker = accountMarkers.get(family);
		if (!marker) return null;
		if (marker.expiresAt <= now) {
			accountMarkers.delete(family);
			if (accountMarkers.size === 0) {
				this.familyScopedDepletions.delete(accountId);
			}
			return null;
		}
		return { exhausted: true, ...marker };
	}

	/** Clear only the recognized family matching one successful model. */
	clearFamilyScopedExhaustion(accountId: string, model: string): boolean {
		const family = getModelFamily(model);
		if (family === null) return false;
		const accountMarkers = this.familyScopedDepletions.get(accountId);
		if (!accountMarkers) return false;
		const cleared = accountMarkers.delete(family);
		if (accountMarkers.size === 0) {
			this.familyScopedDepletions.delete(accountId);
		}
		return cleared;
	}

	/**
	 * Clear all short-lived reactive route exclusions for one account while
	 * preserving its authoritative usage snapshot and polling configuration.
	 */
	clearReactiveScopedDepletions(accountId: string): void {
		this.modelScopedDepletions.delete(accountId);
		this.familyScopedDepletions.delete(accountId);
	}

	/**
	 * Single dispatch point for successful-poll snapshots: history
	 * persistence and usage-window alert evaluation ride this callback for
	 * EVERY provider. Per-branch inline dispatch left the API-key providers
	 * (nanogpt/zai/kilo/alibaba/minimax) silently unwired — the callback was
	 * registered but never invoked for them (pro-gate finding).
	 */
	private setAuthoritative(accountId: string, data: AnyUsageData): void {
		this.cache.set(accountId, { data, timestamp: Date.now() });
		// Ordinary usage snapshots do not prove a recent model+client-beta-specific
		// out_of_credits condition has cleared, and an older in-flight poll can
		// complete after newer direct failure evidence. Keep reactive markers for
		// their short TTL; account deletion, polling teardown, or explicit cache
		// clearing removes them sooner. The provider's mandatory OAuth beta is
		// intentionally excluded because it is constant across these candidates.
	}

	/** Set authoritative cached usage data for an account. */
	set(accountId: string, data: AnyUsageData): void {
		this.setAuthoritative(accountId, data);

		// Periodic cleanup of stale entries to prevent memory bloat
		// Run cleanup every 100 sets to balance performance and memory
		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	}

	/**
	 * Check if the usage window has reset by comparing the new data's reset time
	 * against the previously cached data, and fire the callback if it has advanced
	 * by more than {@link WINDOW_RESET_MIN_ADVANCE_MS} — smaller advances are
	 * upstream jitter on the same window, not a rollover.
	 * Should be called after successfully fetching new data, before updating the cache.
	 * No-ops on the first poll (no previous data) to avoid spurious resets.
	 */
	notifyWindowReset(
		accountId: string,
		newData: AnyUsageData,
		provider: string,
		callback: (accountId: string) => void,
	): void {
		const previous = this.cache.get(accountId);
		if (!previous) return; // first poll — no baseline to compare against

		const prevResetAt = extractWindowResetTime(previous.data, provider);
		const newResetAt = extractWindowResetTime(newData, provider);

		if (
			prevResetAt !== null &&
			newResetAt !== null &&
			newResetAt - prevResetAt > WINDOW_RESET_MIN_ADVANCE_MS
		) {
			log.info(
				`Usage window reset detected for account ${accountId} (${provider}): ` +
					`${new Date(prevResetAt).toISOString()} → ${new Date(newResetAt).toISOString()}`,
			);
			callback(accountId);
		}
	}

	/**
	 * Returns the timestamp (ms since epoch) until which the usage API is rate-limited
	 * for this account, or null if not currently rate-limited.
	 */
	getRateLimitedUntil(accountId: string): number | null {
		const until = this.usageRateLimitedUntil.get(accountId);
		if (until === undefined) return null;
		if (Date.now() >= until) {
			this.usageRateLimitedUntil.delete(accountId);
			return null;
		}
		return until;
	}

	/**
	 * Get cached data age in milliseconds
	 */
	getAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		// Clean up if too old
		if (age > USAGE_CACHE_MAX_AGE_MS) {
			// 10 minutes max age
			this.cache.delete(accountId);
			return null;
		}

		return age;
	}

	/**
	 * Clear cached data for a specific account
	 */
	delete(accountId: string): void {
		this.cache.delete(accountId);
		this.modelScopedDepletions.delete(accountId);
		this.familyScopedDepletions.delete(accountId);
		log.debug(`Cleared usage cache for account ${accountId}`);
	}

	/**
	 * Clear all cached data and stop all polling
	 */
	clear() {
		for (const accountId of this.registrations.keys()) {
			this.stopPolling(accountId);
		}
		this.cache.clear();
		this.usageRateLimitedUntil.clear();
		this.modelScopedDepletions.clear();
		this.familyScopedDepletions.clear();
		log.info("Cleared all usage cache and stopped polling");
	}
}

// Export singleton instance
export const usageCache = new UsageCache();
