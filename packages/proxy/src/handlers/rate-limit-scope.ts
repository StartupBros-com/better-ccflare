import { getModelFamily } from "@better-ccflare/core";
import {
	MODEL_SCOPED_DEPLETION_TTL_MS,
	parseAnthropicRateLimitResetAt,
	type UsageSnapshot,
} from "@better-ccflare/providers";

/** Two default 90-second usage polls. */
export const REACTIVE_429_MAX_USAGE_AGE_MS = 180_000;
const MAX_REQUEST_RATE_LIMIT_OUTCOMES = 32;

const HARD_UNIFIED_STATUSES = new Set([
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

export type RateLimitFailureScope = "account" | "family" | "model";
export type RateLimitScopeReason =
	| "matching_scoped_limit"
	| "not_429"
	| "non_anthropic"
	| "hard_response_signal"
	| "unknown_model"
	| "missing_usage"
	| "stale_usage"
	| "missing_account_headroom"
	| "account_capacity_signal"
	| "missing_matching_scoped_limit"
	| "conflicting_usage";

export interface RateLimitScopeDecision {
	readonly scope: RateLimitFailureScope;
	readonly family: string | null;
	readonly attemptedModel: string | null;
	readonly reason: RateLimitScopeReason;
	readonly markerExpiresAt: number | null;
	readonly snapshotAgeMs: number | null;
}

interface AnthropicLimitLike {
	kind?: unknown;
	percent?: unknown;
	resets_at?: unknown;
	is_active?: unknown;
	scope?: {
		model?: { id?: unknown; display_name?: unknown } | null;
	} | null;
}

export interface ClassifyPreByte429Options {
	readonly isAnthropic: boolean;
	readonly response: Response;
	readonly attemptedModel: string | null;
	readonly snapshot: UsageSnapshot | null;
	readonly now?: number;
	readonly maxUsageAgeMs?: number;
}

function accountDecision(
	options: ClassifyPreByte429Options,
	reason: RateLimitScopeReason,
	family: string | null,
	snapshotAgeMs: number | null,
): RateLimitScopeDecision {
	return {
		scope: "account",
		family,
		attemptedModel: options.attemptedModel,
		reason,
		markerExpiresAt: null,
		snapshotAgeMs,
	};
}

function modelDecision(
	options: ClassifyPreByte429Options,
	reason: RateLimitScopeReason,
	family: string,
	snapshotAgeMs: number | null,
	now: number,
): RateLimitScopeDecision {
	return {
		scope: "model",
		family,
		attemptedModel: options.attemptedModel,
		reason,
		markerExpiresAt: getScoped429MarkerExpiry(options.response, now),
		snapshotAgeMs,
	};
}

function finitePercent(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseReset(value: unknown): number | null | "invalid" {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") return "invalid";
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : "invalid";
}

function limitFamily(limit: AnthropicLimitLike): string | null {
	const id = limit.scope?.model?.id;
	const displayName = limit.scope?.model?.display_name;
	const displayFamily =
		typeof displayName === "string" && displayName.trim()
			? getModelFamily(displayName)
			: null;
	const idFamily =
		typeof id === "string" && id.trim() ? getModelFamily(id) : null;
	return displayFamily ?? idFamily;
}

/**
 * Read an upstream timing hint without inferring anything about failure scope.
 * Multiple usable hints resolve to the earliest recovery time.
 */
export function getAnthropicRateLimitResetAt(
	response: Response,
	now: number = Date.now(),
): number | null {
	return parseAnthropicRateLimitResetAt(response.headers, now);
}

function getScoped429MarkerExpiry(response: Response, now: number): number {
	const ttlCeiling = now + MODEL_SCOPED_DEPLETION_TTL_MS;
	const upstreamReset = getAnthropicRateLimitResetAt(response, now);
	return upstreamReset === null
		? ttlCeiling
		: Math.min(ttlCeiling, upstreamReset);
}

/** Headers that positively establish an account-level Anthropic rate limit. */
export function hasHardAnthropicAccountSignal(response: Response): boolean {
	const status = response.headers
		.get("anthropic-ratelimit-unified-status")
		?.trim()
		.toLowerCase();
	if (status && HARD_UNIFIED_STATUSES.has(status)) return true;
	const remaining = response.headers.get(
		"anthropic-ratelimit-unified-remaining",
	);
	if (remaining !== null && remaining.trim() !== "") {
		const parsed = Number(remaining);
		if (Number.isFinite(parsed) && parsed <= 0) return true;
	}
	return false;
}

/**
 * Scope a generic Anthropic 429 using only positive capacity evidence. Explicit
 * account-wide exhaustion stays account scoped; fresh matching scoped usage is
 * family scoped; every ambiguous recognized-Claude case is isolated to the
 * exact model + client-beta candidate by the caller.
 */
export function classifyPreByte429(
	options: ClassifyPreByte429Options,
): RateLimitScopeDecision {
	const now = options.now ?? Date.now();
	const family = options.attemptedModel
		? getModelFamily(options.attemptedModel)
		: null;
	if (options.response.status !== 429) {
		return accountDecision(options, "not_429", family, null);
	}
	if (!options.isAnthropic) {
		return accountDecision(options, "non_anthropic", family, null);
	}
	if (hasHardAnthropicAccountSignal(options.response)) {
		return accountDecision(options, "hard_response_signal", family, null);
	}
	if (family === null) {
		return accountDecision(options, "unknown_model", null, null);
	}
	if (options.snapshot === null) {
		return modelDecision(options, "missing_usage", family, null, now);
	}

	const maxAgeMs = options.maxUsageAgeMs ?? REACTIVE_429_MAX_USAGE_AGE_MS;
	const snapshotAgeMs = now - options.snapshot.observedAt;
	if (
		!Number.isFinite(snapshotAgeMs) ||
		snapshotAgeMs < 0 ||
		snapshotAgeMs > maxAgeMs
	) {
		return modelDecision(options, "stale_usage", family, snapshotAgeMs, now);
	}

	const rawLimits = (options.snapshot.data as { limits?: unknown }).limits;
	if (!Array.isArray(rawLimits)) {
		return modelDecision(
			options,
			"missing_account_headroom",
			family,
			snapshotAgeMs,
			now,
		);
	}
	const limits = (rawLimits as AnthropicLimitLike[]).filter(
		(limit) => limit != null,
	);
	const activeLimits = limits.filter((limit) => limit.is_active !== false);
	const activeAccountLimits = activeLimits.filter(
		(limit) => limit.kind === "session" || limit.kind === "weekly_all",
	);
	for (const limit of activeAccountLimits) {
		const percent = finitePercent(limit.percent);
		if (percent !== null && percent >= 100) {
			return accountDecision(
				options,
				"account_capacity_signal",
				family,
				snapshotAgeMs,
			);
		}
	}
	for (const kind of ["session", "weekly_all"] as const) {
		const matching = limits.filter((limit) => limit.kind === kind);
		if (matching.length === 0) {
			return modelDecision(
				options,
				"missing_account_headroom",
				family,
				snapshotAgeMs,
				now,
			);
		}
		for (const limit of matching) {
			const percent = finitePercent(limit.percent);
			if (percent === null || percent < 0) {
				return modelDecision(
					options,
					"conflicting_usage",
					family,
					snapshotAgeMs,
					now,
				);
			}
		}
	}

	const scoped = activeLimits.filter(
		(limit) => limit.kind === "weekly_scoped" && limitFamily(limit) === family,
	);
	if (scoped.length === 0) {
		return modelDecision(
			options,
			"missing_matching_scoped_limit",
			family,
			snapshotAgeMs,
			now,
		);
	}
	const futureResets: number[] = [];
	for (const limit of scoped) {
		const percent = finitePercent(limit.percent);
		const reset = parseReset(limit.resets_at);
		if (
			percent === null ||
			percent < 100 ||
			reset === "invalid" ||
			(typeof reset === "number" && reset <= now)
		) {
			return modelDecision(
				options,
				"conflicting_usage",
				family,
				snapshotAgeMs,
				now,
			);
		}
		if (typeof reset === "number") futureResets.push(reset);
	}

	const evidenceExpiresAt = options.snapshot.observedAt + maxAgeMs;
	const markerExpiresAt = Math.min(
		getScoped429MarkerExpiry(options.response, now),
		evidenceExpiresAt,
		...(futureResets.length > 0 ? futureResets : [Number.POSITIVE_INFINITY]),
	);
	if (!Number.isFinite(markerExpiresAt) || markerExpiresAt <= now) {
		return modelDecision(
			options,
			"conflicting_usage",
			family,
			snapshotAgeMs,
			now,
		);
	}
	return {
		scope: "family",
		family,
		attemptedModel: options.attemptedModel,
		reason: "matching_scoped_limit",
		markerExpiresAt,
		snapshotAgeMs,
	};
}

export interface RequestRateLimitOutcome {
	readonly accountId: string;
	readonly status: number;
	readonly scope: RateLimitFailureScope;
	readonly family: string | null;
	readonly attemptedModel: string | null;
	readonly reason:
		| RateLimitScopeReason
		| "out_of_credits"
		| "upstream_402_payment_required";
	readonly availableAt: number | null;
}

const requestRateLimitOutcomes = new WeakMap<
	Request,
	RequestRateLimitOutcome[]
>();

/** Record one bounded immutable outcome for later terminal classification. */
export function recordRequestRateLimitOutcome(
	request: Request,
	outcome: RequestRateLimitOutcome,
): void {
	let outcomes = requestRateLimitOutcomes.get(request);
	if (!outcomes) {
		outcomes = [];
		requestRateLimitOutcomes.set(request, outcomes);
	}
	if (outcomes.length >= MAX_REQUEST_RATE_LIMIT_OUTCOMES) outcomes.shift();
	outcomes.push(Object.freeze({ ...outcome }));
}

/** Return a frozen snapshot; callers cannot mutate the request's live ledger. */
export function getRequestRateLimitOutcomes(
	request: Request,
): readonly RequestRateLimitOutcome[] {
	return Object.freeze([...(requestRateLimitOutcomes.get(request) ?? [])]);
}
