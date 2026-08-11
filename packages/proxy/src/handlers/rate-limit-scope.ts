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
	// Measured on a real exhausted-window 429 (five-hour utilization 1.01,
	// `anthropic-ratelimit-unified-5h-status: rejected`) that also carried
	// `x-should-retry: true` — see retryable-429.ts's
	// ACCOUNT_WIDE_UNIFIED_STATUSES derivation notes.
	"rejected",
]);

export type RateLimitFailureScope = "account" | "family" | "model";
export type RateLimitScopeReason =
	| "matching_scoped_limit"
	| "not_429"
	| "non_anthropic"
	| "hard_response_signal"
	| "spent_window_signal"
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
 * True when a 429 positively describes a spent unified rate-limit window —
 * Anthropic's own limiter speaking, e.g. `anthropic-ratelimit-unified-reset`
 * or a per-window `anthropic-ratelimit-unified-5h-status: rejected`. Used to
 * bench the account when no usage snapshot exists to refine the scope
 * (upstream issue #301's counterpart: a 429 that DOES report a window is a
 * real window rejection, unlike the windowless shape).
 *
 * Deliberately narrower than "any rate-limit metadata":
 * - Generic `retry-after` / `x-ratelimit-*` hints only ever shorten marker
 *   expiry, never broaden scope (fork behavior, pinned by
 *   rate-limit-scope.test.ts).
 * - Empty header values are not evidence (matches the empty
 *   `unified-remaining` precedent in hasHardAnthropicAccountSignal).
 * - A `-status` header only counts when its value is in
 *   HARD_UNIFIED_STATUSES — a soft/allowed status is not a spent window.
 * - A parseable POSITIVE `unified-remaining` contradicts an account-wide
 *   rejection (the unified limiter has headroom; a scoped limit elsewhere
 *   produced the 429), so it vetoes the evidence.
 */
function hasSpentUnifiedWindowEvidence(response: Response): boolean {
	const remaining = response.headers.get(
		"anthropic-ratelimit-unified-remaining",
	);
	if (remaining !== null && remaining.trim() !== "") {
		const parsed = Number(remaining);
		if (Number.isFinite(parsed) && parsed > 0) return false;
	}
	let evidence = false;
	response.headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (!lower.startsWith("anthropic-ratelimit-unified-")) return;
		const trimmed = value.trim();
		if (trimmed === "") return;
		if (lower.endsWith("-status")) {
			if (HARD_UNIFIED_STATUSES.has(trimmed.toLowerCase())) evidence = true;
			return;
		}
		evidence = true;
	});
	return evidence;
}

/**
 * Classify a 429 against a snapshot the caller has already proven fresh.
 *
 * Split out of {@link classifyPreByte429} so the hard-account-signal branch can
 * weigh the very same evidence before widening to account scope, instead of
 * re-implementing the limit parsing. Two independent copies of these rules are
 * exactly how the header path and the snapshot path drifted apart in the first
 * place (see the 2026-08-11 note in classifyPreByte429).
 *
 * Only `matching_scoped_limit` is a positive, affirmative proof that the 429
 * belongs to one model family; every other outcome here is an absence of
 * evidence, which callers must not read as evidence of absence.
 */
function classifyFreshSnapshot(
	options: ClassifyPreByte429Options,
	snapshot: UsageSnapshot,
	family: string,
	snapshotAgeMs: number,
	now: number,
	maxAgeMs: number,
): RateLimitScopeDecision {
	const rawLimits = (snapshot.data as { limits?: unknown }).limits;
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

	const evidenceExpiresAt = snapshot.observedAt + maxAgeMs;
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
	const maxAgeMs = options.maxUsageAgeMs ?? REACTIVE_429_MAX_USAGE_AGE_MS;
	const snapshot = options.snapshot;
	const snapshotIsFresh =
		snapshot !== null &&
		Number.isFinite(now - snapshot.observedAt) &&
		now - snapshot.observedAt >= 0 &&
		now - snapshot.observedAt <= maxAgeMs;

	if (hasHardAnthropicAccountSignal(options.response)) {
		// A hard unified status reports THAT the request was rejected, never WHICH
		// limit rejected it — Anthropic sends the same status for per-model weekly
		// caps. Short-circuiting straight to account scope here benched whole
		// accounts for a Fable-only cap on 2026-08-11: the two healthiest accounts
		// left every model lane for 12h and the pool emptied into
		// `503 route_unavailable`.
		//
		// Narrow ONLY on affirmative proof — a fresh snapshot showing this family's
		// scoped cap spent while the account-wide windows still have headroom.
		// Every other outcome is an absence of evidence and keeps the account-wide
		// reading, because under-benching a genuinely exhausted account costs one
		// repeated 429 while over-benching costs a multi-hour pool outage.
		if (family !== null && snapshot !== null && snapshotIsFresh) {
			const refined = classifyFreshSnapshot(
				options,
				snapshot,
				family,
				now - snapshot.observedAt,
				now,
				maxAgeMs,
			);
			if (refined.reason === "matching_scoped_limit") return refined;
		}
		return accountDecision(options, "hard_response_signal", family, null);
	}
	if (family === null) {
		return accountDecision(options, "unknown_model", null, null);
	}
	if (snapshot === null) {
		// No usage evidence to refine the scope. If the response itself reports
		// a spent unified window, that is account-level evidence from the
		// server — bench rather than model-mark (upstream #301 counterpart).
		if (hasSpentUnifiedWindowEvidence(options.response)) {
			return accountDecision(options, "spent_window_signal", family, null);
		}
		return modelDecision(options, "missing_usage", family, null, now);
	}

	const snapshotAgeMs = now - snapshot.observedAt;
	if (!snapshotIsFresh) {
		if (hasSpentUnifiedWindowEvidence(options.response)) {
			return accountDecision(
				options,
				"spent_window_signal",
				family,
				snapshotAgeMs,
			);
		}
		return modelDecision(options, "stale_usage", family, snapshotAgeMs, now);
	}

	return classifyFreshSnapshot(
		options,
		snapshot,
		family,
		snapshotAgeMs,
		now,
		maxAgeMs,
	);
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
