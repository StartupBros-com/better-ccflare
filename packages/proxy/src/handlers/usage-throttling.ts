import {
	computeWindowStartMs,
	getModelFamily,
	weeklyScopedWindowKey,
} from "@better-ccflare/core";
import type { AnyUsageData } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

const RETRY_AFTER_SECONDS = 60;
/** Two default 90-second usage polls; independent from the cache's 10m maximum. */
export const DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS = 3 * 60 * 1000;

type CapacityWindowKind = "session" | "weekly_all" | "weekly_scoped" | "other";

interface UsageWindowSnapshot {
	utilization: number;
	resetAtMs: number | null;
	window: string;
	kind: CapacityWindowKind;
	/** Set for per-model weekly caps (weekly_scoped); drives model-aware throttling. */
	modelFamily?: string;
	/** True for a weekly_scoped (per-model) cap — even when its family is unknown. */
	scoped?: boolean;
}

// Minimal shape of Anthropic's generic limits[] entries (see providers UsageLimit).
interface AnthropicLimit {
	kind?: string;
	percent?: number | null;
	resets_at?: string | null;
	is_active?: boolean | null;
	scope?: {
		model?: { id?: string | null; display_name?: string | null } | null;
	} | null;
}

export interface UsageThrottleSettings {
	fiveHourEnabled: boolean;
	weeklyEnabled: boolean;
}

export interface UsageThrottleStatus {
	throttleUntil: number | null;
	throttledWindows: string[];
}

function collectWindows(data: AnyUsageData | null): UsageWindowSnapshot[] {
	if (!data || typeof data !== "object") return [];

	const windows: UsageWindowSnapshot[] = [];

	const pushWindow = (
		window: string,
		utilization: number | null | undefined,
		resetAtMs: number | null | undefined,
		modelFamily?: string,
		scoped?: boolean,
		kind: CapacityWindowKind = "other",
	) => {
		if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
			return;
		}
		const normalizedResetAtMs =
			typeof resetAtMs === "number" && Number.isFinite(resetAtMs)
				? resetAtMs
				: null;

		windows.push({
			utilization,
			resetAtMs: normalizedResetAtMs,
			window,
			kind,
			modelFamily,
			scoped,
		});
	};

	// PRIMARY: Anthropic's generic limits[] array. Checked FIRST — current payloads
	// carry BOTH the flat windows and limits[], and per-model caps live only here.
	// session -> five_hour, weekly_all -> seven_day, weekly_scoped -> seven_day_<slug>
	// (with modelFamily so throttling can be scoped to the request's model).
	if (Array.isArray((data as { limits?: unknown }).limits)) {
		const limits = (data as { limits: AnthropicLimit[] }).limits;
		let hasSession = false;
		let hasWeeklyAll = false;
		for (const l of limits) {
			if (!l || l.is_active === false || typeof l.percent !== "number") {
				continue;
			}
			const resetMs = l.resets_at ? new Date(l.resets_at).getTime() : null;
			if (l.kind === "session") {
				pushWindow(
					"five_hour",
					l.percent,
					resetMs,
					undefined,
					false,
					"session",
				);
				hasSession = true;
			} else if (l.kind === "weekly_all") {
				pushWindow(
					"seven_day",
					l.percent,
					resetMs,
					undefined,
					false,
					"weekly_all",
				);
				hasWeeklyAll = true;
			} else if (l.kind === "weekly_scoped") {
				const displayName = l.scope?.model?.display_name?.trim();
				const modelId = l.scope?.model?.id?.trim();
				const name = displayName || modelId || null;
				pushWindow(
					name ? weeklyScopedWindowKey(name) : "seven_day_scoped_unknown",
					l.percent,
					resetMs,
					name ? (getModelFamily(name) ?? undefined) : undefined,
					true,
					"weekly_scoped",
				);
			}
		}
		// Supplement the account-level windows (five_hour / seven_day) from the flat
		// payload whenever limits[] did NOT carry them (per-kind, so no double-count):
		// a payload with only per-model scoped rows must still throttle on an
		// exhausted flat ACCOUNT cap, and an empty limits[] falls back to flat too.
		const flat = data as {
			five_hour?: { utilization?: number | null; resets_at?: string | null };
			seven_day?: { utilization?: number | null; resets_at?: string | null };
		};
		if (!hasSession && flat.five_hour) {
			pushWindow(
				"five_hour",
				flat.five_hour.utilization,
				flat.five_hour.resets_at
					? new Date(flat.five_hour.resets_at).getTime()
					: null,
				undefined,
				false,
				"session",
			);
		}
		if (!hasWeeklyAll && flat.seven_day) {
			pushWindow(
				"seven_day",
				flat.seven_day.utilization,
				flat.seven_day.resets_at
					? new Date(flat.seven_day.resets_at).getTime()
					: null,
				undefined,
				false,
				"weekly_all",
			);
		}
		// Return unless nothing usable was collected (empty limits[] AND no flat
		// account windows), in which case fall through to the other shape branches.
		if (windows.length > 0) return windows;
	}

	if ("five_hour" in data && "seven_day" in data) {
		const anthropicLike = data as {
			five_hour?: { utilization?: number | null; resets_at?: string | null };
			seven_day?: { utilization?: number | null; resets_at?: string | null };
			seven_day_opus?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
			seven_day_sonnet?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
			seven_day_fable?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
		};

		pushWindow(
			"five_hour",
			anthropicLike.five_hour?.utilization,
			anthropicLike.five_hour?.resets_at
				? new Date(anthropicLike.five_hour.resets_at).getTime()
				: null,
			undefined,
			false,
			"session",
		);
		pushWindow(
			"seven_day",
			anthropicLike.seven_day?.utilization,
			anthropicLike.seven_day?.resets_at
				? new Date(anthropicLike.seven_day.resets_at).getTime()
				: null,
			undefined,
			false,
			"weekly_all",
		);
		pushWindow(
			"seven_day_opus",
			anthropicLike.seven_day_opus?.utilization,
			anthropicLike.seven_day_opus?.resets_at
				? new Date(anthropicLike.seven_day_opus.resets_at).getTime()
				: null,
			"opus",
			true,
			"weekly_scoped",
		);
		pushWindow(
			"seven_day_sonnet",
			anthropicLike.seven_day_sonnet?.utilization,
			anthropicLike.seven_day_sonnet?.resets_at
				? new Date(anthropicLike.seven_day_sonnet.resets_at).getTime()
				: null,
			"sonnet",
			true,
			"weekly_scoped",
		);
		pushWindow(
			"seven_day_fable",
			anthropicLike.seven_day_fable?.utilization,
			anthropicLike.seven_day_fable?.resets_at
				? new Date(anthropicLike.seven_day_fable.resets_at).getTime()
				: null,
			"fable",
			true,
			"weekly_scoped",
		);
		return windows;
	}

	if ("tokens_limit" in data || "time_limit" in data) {
		const zai = data as {
			tokens_limit?: { percentage?: number; resetAt?: number | null } | null;
		};
		pushWindow(
			"tokens_limit",
			zai.tokens_limit?.percentage,
			zai.tokens_limit?.resetAt,
		);
		return windows;
	}

	if ("active" in data && "daily" in data && "monthly" in data) {
		const nanogpt = data as {
			active?: boolean;
			daily?: { percentUsed?: number; resetAt?: number };
			monthly?: { percentUsed?: number; resetAt?: number };
		};
		if (nanogpt.active) {
			pushWindow(
				"daily",
				typeof nanogpt.daily?.percentUsed === "number"
					? nanogpt.daily.percentUsed * 100
					: null,
				nanogpt.daily?.resetAt,
			);
			pushWindow(
				"monthly",
				typeof nanogpt.monthly?.percentUsed === "number"
					? nanogpt.monthly.percentUsed * 100
					: null,
				nanogpt.monthly?.resetAt,
			);
		}
		return windows;
	}

	if ("weekly" in data && "monthly" in data && "five_hour" in data) {
		const alibaba = data as {
			five_hour?: { percentUsed?: number; resetAt?: number | null };
			weekly?: { percentUsed?: number; resetAt?: number | null };
			monthly?: { percentUsed?: number; resetAt?: number | null };
		};
		pushWindow(
			"five_hour",
			alibaba.five_hour?.percentUsed,
			alibaba.five_hour?.resetAt,
		);
		pushWindow("weekly", alibaba.weekly?.percentUsed, alibaba.weekly?.resetAt);
		pushWindow(
			"monthly",
			alibaba.monthly?.percentUsed,
			alibaba.monthly?.resetAt,
		);
		return windows;
	}

	return windows;
}

function isWindowThrottlingEnabled(
	window: string,
	settings: UsageThrottleSettings,
): boolean {
	// Five-hour-class windows gate on the 5h setting; everything else — seven_day,
	// any per-model seven_day_<slug>, weekly, monthly, and unknown future windows —
	// gates on the weekly setting (so a dynamic scoped window never silently no-ops).
	if (
		window === "five_hour" ||
		window === "daily" ||
		window === "tokens_limit"
	) {
		return settings.fiveHourEnabled;
	}
	return settings.weeklyEnabled;
}

export type HardCapacityScope = "account" | "family";

export interface HardCapacityExclusion {
	readonly scope: HardCapacityScope;
	readonly window: string;
	readonly windowKind: "session" | "weekly_all" | "weekly_scoped";
	readonly modelFamily: string | null;
	readonly utilization: number;
	readonly resetAtMs: number | null;
	/** The earlier of reset and evidence freshness expiry. */
	readonly evidenceExpiresAt: number;
}

export interface HardCapacityStatus {
	readonly eligible: boolean;
	readonly exclusions: readonly HardCapacityExclusion[];
	readonly snapshotAgeMs: number | null;
	readonly snapshotFresh: boolean;
	/** When all simultaneous exclusions for this candidate can have cleared. */
	readonly blockedUntil: number | null;
}

export interface HardCapacityOptions {
	readonly requestModel: string | null;
	readonly observedAt: number;
	/** Provider is used only for provider-specific billing/overage semantics. */
	readonly provider?: string | null;
	readonly now?: number;
	readonly snapshotFreshnessMs?: number;
}

export type CapacityOverageStatus = "available" | "unavailable" | "unknown";

/**
 * Resolve Anthropic's current and legacy overage signals without guessing.
 * A missing signal is unknown: falsely excluding an overage-enabled account
 * is worse than paying for one reactive upstream rejection.
 */
export function resolveCapacityOverageStatus(
	data: AnyUsageData | null,
): CapacityOverageStatus {
	const billing = data as {
		spend?: { enabled?: boolean } | null;
		extra_usage?: { is_enabled?: boolean } | null;
	} | null;
	if (typeof billing?.spend?.enabled === "boolean") {
		return billing.spend.enabled ? "available" : "unavailable";
	}
	if (typeof billing?.extra_usage?.is_enabled === "boolean") {
		return billing.extra_usage.is_enabled ? "available" : "unavailable";
	}
	return "unknown";
}

/**
 * Count every active raw scoped row for a family, including rows the normalizer
 * must drop because percent/reset evidence is incomplete. Comparing this with
 * normalized rows prevents proving exhaustion by omission.
 */
function countRawScopedFamilyRows(
	data: AnyUsageData | null,
	family: string,
): number {
	const limits = (data as { limits?: unknown[] } | null)?.limits;
	if (!Array.isArray(limits)) return 0;
	let count = 0;
	for (const value of limits) {
		const row = value as AnthropicLimit | null;
		if (!row || row.is_active === false || row.kind !== "weekly_scoped") {
			continue;
		}
		const name =
			row.scope?.model?.display_name?.trim() ||
			row.scope?.model?.id?.trim() ||
			null;
		if (name && getModelFamily(name) === family) count++;
	}
	return count;
}

interface SnapshotFreshness {
	ageMs: number | null;
	expiresAt: number | null;
	fresh: boolean;
}

function evaluateSnapshotFreshness(
	observedAt: number,
	now: number,
	maxAgeMs: number,
): SnapshotFreshness {
	if (
		!Number.isFinite(observedAt) ||
		!Number.isFinite(now) ||
		!Number.isFinite(maxAgeMs) ||
		maxAgeMs <= 0
	) {
		return { ageMs: null, expiresAt: null, fresh: false };
	}
	const ageMs = Math.max(0, now - observedAt);
	const expiresAt = observedAt + maxAgeMs;
	return { ageMs, expiresAt, fresh: now < expiresAt };
}

/**
 * Evaluate hard provider capacity for one concrete request model. This policy is
 * intentionally independent from the optional predictive pacing flags.
 */
export function evaluateHardCapacity(
	data: AnyUsageData | null,
	options: HardCapacityOptions,
): HardCapacityStatus {
	const now = options.now ?? Date.now();
	const freshness = evaluateSnapshotFreshness(
		options.observedAt,
		now,
		options.snapshotFreshnessMs ?? DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS,
	);
	if (!freshness.fresh || freshness.expiresAt === null) {
		return {
			eligible: true,
			exclusions: [],
			snapshotAgeMs: freshness.ageMs,
			snapshotFresh: false,
			blockedUntil: null,
		};
	}

	const requestFamily = options.requestModel
		? getModelFamily(options.requestModel)
		: null;
	const windows = collectWindows(data);
	const matchingScopedRows = requestFamily
		? windows.filter(
				(window) =>
					window.kind === "weekly_scoped" &&
					window.modelFamily === requestFamily,
			)
		: [];
	const rawScopedRowCount = requestFamily
		? countRawScopedFamilyRows(data, requestFamily)
		: 0;
	const everyScopedRowProvesExhaustion =
		matchingScopedRows.length > 0 &&
		rawScopedRowCount === matchingScopedRows.length &&
		matchingScopedRows.every(
			(window) =>
				window.utilization >= 100 &&
				window.resetAtMs !== null &&
				window.resetAtMs > now,
		);
	// Anthropic can continue serving a 100% scoped allowance through paid
	// overage. Only a confirmed-disabled billing signal makes that cap hard.
	// Other providers do not expose these Anthropic-specific fields, so their
	// existing subscription-cap routing remains authoritative.
	const scopedFamilyHardBlocked =
		everyScopedRowProvesExhaustion &&
		(options.provider !== "anthropic" ||
			resolveCapacityOverageStatus(data) === "unavailable");

	const exclusions: HardCapacityExclusion[] = [];
	for (const window of windows) {
		if (
			window.kind !== "session" &&
			window.kind !== "weekly_all" &&
			window.kind !== "weekly_scoped"
		) {
			continue;
		}
		if (window.utilization < 100) continue;
		if (window.resetAtMs !== null && window.resetAtMs <= now) continue;

		let scope: HardCapacityScope;
		if (window.kind === "weekly_scoped") {
			// Unknown/malformed and unrelated scopes fail open proactively.
			if (
				requestFamily === null ||
				window.modelFamily == null ||
				window.modelFamily !== requestFamily ||
				!scopedFamilyHardBlocked
			) {
				continue;
			}
			scope = "family";
		} else {
			scope = "account";
		}

		const evidenceExpiresAt =
			window.resetAtMs === null
				? freshness.expiresAt
				: Math.min(window.resetAtMs, freshness.expiresAt);
		if (evidenceExpiresAt <= now) continue;
		exclusions.push({
			scope,
			window: window.window,
			windowKind: window.kind,
			modelFamily: window.modelFamily ?? null,
			utilization: window.utilization,
			resetAtMs: window.resetAtMs,
			evidenceExpiresAt,
		});
	}

	return {
		eligible: exclusions.length === 0,
		exclusions,
		snapshotAgeMs: freshness.ageMs,
		snapshotFresh: true,
		blockedUntil:
			exclusions.length === 0
				? null
				: Math.max(...exclusions.map((entry) => entry.evidenceExpiresAt)),
	};
}

export type QuotaPressureBand =
	| "critical"
	| "urgent"
	| "hot"
	| "warm"
	| "steady"
	| "cold";

export interface QuotaPressureComparatorMetadata {
	readonly provider: string | null;
	readonly billingClass: string | null;
	readonly windowKind: "weekly_scoped" | "weekly_all";
}

export interface WeeklyQuotaPressure {
	readonly window: string;
	readonly windowKind: "weekly_scoped" | "weekly_all";
	readonly modelFamily: string | null;
	readonly utilization: number;
	readonly resetAtMs: number;
	readonly remainingHours: number;
	readonly requiredBurnRate: number;
	readonly band: QuotaPressureBand;
	readonly comparator: QuotaPressureComparatorMetadata;
}

export interface WeeklyQuotaPressureOptions {
	readonly requestModel: string | null;
	readonly observedAt: number;
	readonly provider: string | null;
	readonly billingClass: string | null;
	readonly now?: number;
	readonly snapshotFreshnessMs?: number;
}

const PRESSURE_BAND_RANK: Readonly<Record<QuotaPressureBand, number>> = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
};

function quotaPressureBand(requiredBurnRate: number): QuotaPressureBand {
	if (requiredBurnRate >= 4) return "critical";
	if (requiredBurnRate >= 2) return "urgent";
	if (requiredBurnRate >= 1) return "hot";
	if (requiredBurnRate >= 0.5) return "warm";
	if (requiredBurnRate >= 0.25) return "steady";
	return "cold";
}

function normalizeComparatorPart(value: string | null): string | null {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : null;
}

/**
 * Return model-relevant weekly pressure from a fresh subscription snapshot.
 * Matching scoped quota wins; otherwise the account-wide weekly quota is used.
 * Session/five-hour windows are deliberately excluded from this comparator.
 */
export function getWeeklyQuotaPressure(
	data: AnyUsageData | null,
	options: WeeklyQuotaPressureOptions,
): WeeklyQuotaPressure | null {
	const now = options.now ?? Date.now();
	const freshness = evaluateSnapshotFreshness(
		options.observedAt,
		now,
		options.snapshotFreshnessMs ?? DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS,
	);
	if (!freshness.fresh) return null;

	const requestFamily = options.requestModel
		? getModelFamily(options.requestModel)
		: null;
	const windows = collectWindows(data);
	const matchingScoped =
		requestFamily === null
			? []
			: windows.filter(
					(window) =>
						window.kind === "weekly_scoped" &&
						window.modelFamily === requestFamily,
				);
	const selected =
		matchingScoped.length > 0
			? matchingScoped
			: windows.filter((window) => window.kind === "weekly_all");
	const windowKind = matchingScoped.length > 0 ? "weekly_scoped" : "weekly_all";

	let best: WeeklyQuotaPressure | null = null;
	for (const window of selected) {
		if (
			window.utilization < 0 ||
			window.utilization >= 100 ||
			window.resetAtMs === null ||
			window.resetAtMs <= now
		) {
			continue;
		}
		const remainingHours = (window.resetAtMs - now) / (60 * 60 * 1000);
		if (!Number.isFinite(remainingHours) || remainingHours <= 0) continue;
		const requiredBurnRate = (100 - window.utilization) / remainingHours;
		if (!Number.isFinite(requiredBurnRate) || requiredBurnRate < 0) continue;

		const pressure: WeeklyQuotaPressure = {
			window: window.window,
			windowKind,
			modelFamily: window.modelFamily ?? requestFamily,
			utilization: window.utilization,
			resetAtMs: window.resetAtMs,
			remainingHours,
			requiredBurnRate,
			band: quotaPressureBand(requiredBurnRate),
			comparator: {
				provider: normalizeComparatorPart(options.provider),
				billingClass: normalizeComparatorPart(options.billingClass),
				windowKind,
			},
		};
		if (
			best === null ||
			PRESSURE_BAND_RANK[pressure.band] > PRESSURE_BAND_RANK[best.band]
		) {
			best = pressure;
		}
	}
	return best;
}

/**
 * Compare pressure bands only when provider, plan class, and weekly-window kind
 * are positively known and identical. Positive means the left side is preferred.
 */
export function compareQuotaPressure(
	left: WeeklyQuotaPressure | null,
	right: WeeklyQuotaPressure | null,
): -1 | 0 | 1 | null {
	if (left === null || right === null) return null;
	const a = left.comparator;
	const b = right.comparator;
	if (
		a.provider === null ||
		a.billingClass === null ||
		b.provider === null ||
		b.billingClass === null ||
		a.provider !== b.provider ||
		a.billingClass !== b.billingClass ||
		a.windowKind !== b.windowKind
	) {
		return null;
	}
	const difference =
		PRESSURE_BAND_RANK[left.band] - PRESSURE_BAND_RANK[right.band];
	return difference === 0 ? 0 : difference > 0 ? 1 : -1;
}

export function getUsageThrottleStatus(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	opts?: { requestModel?: string | null; scopedMode?: "match" | "all" },
): UsageThrottleStatus {
	// scopedMode "all" (default, display path) surfaces every per-model cap;
	// "match" (routing path) only counts a scoped cap when the request's model
	// family matches it.
	const scopedMode = opts?.scopedMode ?? "all";
	const requestFamily =
		opts?.requestModel != null ? getModelFamily(opts.requestModel) : null;
	const windows = collectWindows(data);
	let throttleUntil: number | null = null;
	const throttledWindows: string[] = [];

	for (const window of windows) {
		// A per-model (scoped) cap only throttles in "all" mode, or in "match" mode
		// when its family is KNOWN and equals the request's. An unmapped scoped cap
		// (modelFamily undefined) is skipped in match mode rather than throttling
		// every model; whole-account windows (not scoped) always throttle.
		if (
			window.scoped &&
			scopedMode !== "all" &&
			(window.modelFamily == null || window.modelFamily !== requestFamily)
		) {
			continue;
		}
		if (!isWindowThrottlingEnabled(window.window, settings)) continue;
		if (window.resetAtMs === null) continue;
		if (window.resetAtMs <= now) continue;
		const startMs = computeWindowStartMs(window.resetAtMs, window.window);
		if (startMs === null || startMs >= window.resetAtMs) continue;

		const durationMs = window.resetAtMs - startMs;
		const elapsedMs = now - startMs;
		if (elapsedMs <= 0) continue;

		const expectedPct = Math.min(
			100,
			Math.max(0, (elapsedMs / durationMs) * 100),
		);
		if (window.utilization <= expectedPct) continue;

		const resumeAt = Math.min(
			startMs + (window.utilization / 100) * durationMs,
			window.resetAtMs,
		);
		if (resumeAt <= now) continue;
		throttledWindows.push(window.window);
		if (throttleUntil === null || resumeAt > throttleUntil) {
			throttleUntil = resumeAt;
		}
	}

	return { throttleUntil, throttledWindows };
}

export function getUsageThrottleUntil(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	opts?: { requestModel?: string | null; scopedMode?: "match" | "all" },
): number | null {
	return getUsageThrottleStatus(data, settings, now, opts).throttleUntil;
}

export function createUsageThrottledResponse(accounts: Account[]): Response {
	const names = accounts.map((account) => account.name).join(", ");
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "overloaded_error",
				message: `Usage throttling is delaying requests for account(s): ${names}. Retry after ${RETRY_AFTER_SECONDS} seconds.`,
			},
		}),
		{
			status: 529,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(RETRY_AFTER_SECONDS),
			},
		},
	);
}
