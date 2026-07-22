import type {
	Account,
	RateLimitReason,
	RouteCircuitRecoveryHint,
} from "@better-ccflare/types";
import {
	RECOVERY_SCOPE_HEADER,
	RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER,
} from "@better-ccflare/types/routing-recovery";
import type { RoutingCapacityContext } from "./account-selector";
import type { RequestRateLimitOutcome } from "./rate-limit-scope";

export type RoutingTerminalKind =
	| "model_pool_exhausted"
	| "pool_exhausted"
	| "route_unavailable";

export interface RoutingTerminalResult {
	readonly kind: RoutingTerminalKind;
	readonly response: Response;
}

export interface RoutingTerminalOptions {
	readonly source: "selection" | "attempts";
	readonly accounts: readonly Account[];
	readonly capacityContext: RoutingCapacityContext | null;
	readonly rateLimitOutcomes: readonly RequestRateLimitOutcome[];
	readonly upstreamAttempts: number;
	readonly now?: number;
	readonly message?: string;
	readonly routeCircuitRecoveryHint?: RouteCircuitRecoveryHint | null;
	/** Request-local finite recovery learned after the selection snapshot. */
	readonly modelRecoveryAt?: number | null;
}

interface AutomaticRecovery {
	readonly accountId: string;
	readonly availableAt: number;
	readonly reason: "account_capacity" | "account_cooldown";
}

// Set<RateLimitReason> (not Set<string>) so a future RateLimitReason rename
// or removal fails typecheck here instead of silently drifting out of sync.
const GLOBAL_COOLDOWN_REASONS = new Set<RateLimitReason>([
	"upstream_429_with_reset",
	"upstream_429_no_reset_default_5h",
	"upstream_429_no_reset_probe_cooldown",
	"all_models_exhausted_429",
	"upstream_529_overloaded_with_reset",
	"upstream_529_overloaded_no_reset",
	// Native xAI capacity exhaustion (R5-R10) is an account-wide cooldown like
	// any other global rate limit reason, not a model-lane-scoped one: xAI
	// routes every Claude model alias to the same underlying grok model, so a
	// pool exhausted purely by xai_capacity_402 cooldowns is retryable
	// pool_exhausted, not route_unavailable.
	"xai_capacity_402",
]);

function isFiniteFuture(
	value: number | null | undefined,
	now: number,
): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > now;
}

function modelOnlyCapacity(
	context: RoutingCapacityContext | null,
	accounts: readonly Account[],
	now: number,
): boolean {
	const unpaused = accounts.filter((account) => !account.paused);
	if (unpaused.length === 0) return false;
	const compatibleIds = new Set(unpaused.map((account) => account.id));
	const exclusions =
		context?.exclusions.filter((candidate) =>
			compatibleIds.has(candidate.accountId),
		) ?? [];
	const exclusionsByAccount = new Map<string, typeof exclusions>();
	for (const exclusion of exclusions) {
		const existing = exclusionsByAccount.get(exclusion.accountId) ?? [];
		existing.push(exclusion);
		exclusionsByAccount.set(exclusion.accountId, existing);
	}
	return Boolean(
		context &&
			exclusions.length > 0 &&
			unpaused.every((account) => {
				if (isFiniteFuture(account.rate_limited_until, now)) return false;
				const candidates = exclusionsByAccount.get(account.id) ?? [];
				return (
					candidates.length > 0 &&
					candidates.every(
						(candidate) =>
							candidate.exclusions.length > 0 &&
							candidate.exclusions.every(
								(blocker) =>
									blocker.scope === "family" || blocker.scope === "model",
							),
					)
				);
			}),
	);
}

function finiteCandidateRecovery(
	candidate: RoutingCapacityContext["exclusions"][number],
	now: number,
): number | null {
	if (candidate.exclusions.length === 0) return null;
	if (
		candidate.exclusions.some(
			(blocker) =>
				blocker.scope === "account" && blocker.source !== "usage_snapshot",
		)
	) {
		return null;
	}
	const resetTimes = candidate.exclusions.map((blocker) => blocker.resetAtMs);
	if (!resetTimes.every((resetAtMs) => isFiniteFuture(resetAtMs, now))) {
		return null;
	}
	return Math.max(...resetTimes);
}

function everyAttemptWasModelLaneScoped(
	outcomes: readonly RequestRateLimitOutcome[],
	upstreamAttempts: number,
): boolean {
	return (
		upstreamAttempts > 0 &&
		outcomes.length === upstreamAttempts &&
		outcomes.every(
			(outcome) => outcome.scope === "family" || outcome.scope === "model",
		)
	);
}

function earliestFuture(
	values: readonly (number | null | undefined)[],
	now: number,
): number | null {
	const future = values.filter((value): value is number =>
		isFiniteFuture(value, now),
	);
	return future.length > 0 ? Math.min(...future) : null;
}

function findAutomaticRecoveries(
	accounts: readonly Account[],
	capacityContext: RoutingCapacityContext | null,
	attemptRouteRecoveries: ReadonlyMap<string, readonly (number | null)[]>,
	now: number,
): AutomaticRecovery[] {
	// Capacity context is candidate-local: one account may expose more than one
	// compatible route (for example, Combo slots). Keep every candidate until
	// its complete blocker set is validated, then collapse to the first route on
	// that account that can become eligible.
	const exclusionsByAccount = new Map<
		string,
		RoutingCapacityContext["exclusions"]
	>();
	for (const candidate of capacityContext?.exclusions ?? []) {
		const existing = exclusionsByAccount.get(candidate.accountId) ?? [];
		exclusionsByAccount.set(candidate.accountId, [...existing, candidate]);
	}

	const recoveries: AutomaticRecovery[] = [];
	for (const account of accounts) {
		if (account.paused) continue;
		let accountCooldown: number | null = null;
		if (isFiniteFuture(account.rate_limited_until, now)) {
			if (
				!account.rate_limited_reason ||
				!GLOBAL_COOLDOWN_REASONS.has(account.rate_limited_reason)
			) {
				// A live but unverified account marker is itself an unknown blocker.
				continue;
			}
			accountCooldown = account.rate_limited_until;
		}

		const candidates = exclusionsByAccount.get(account.id) ?? [];
		const requestAttemptRecoveries =
			attemptRouteRecoveries.get(account.id) ?? [];
		if (candidates.length === 0 && requestAttemptRecoveries.length === 0) {
			if (accountCooldown !== null) {
				recoveries.push({
					accountId: account.id,
					availableAt: accountCooldown,
					reason: "account_cooldown",
				});
			}
			continue;
		}

		const candidateRecoveries = [
			...candidates.map((candidate) => finiteCandidateRecovery(candidate, now)),
			...requestAttemptRecoveries,
		];
		if (
			!candidateRecoveries.every(
				(recovery): recovery is number => recovery !== null,
			)
		) {
			// Evidence freshness is not provider recovery. One resetless or invalid
			// blocker makes the route's eligibility unknown, including when a finite
			// account cooldown also exists for the same route.
			continue;
		}
		const routeRecoveries = candidateRecoveries.map((capacityRecovery) =>
			accountCooldown === null
				? capacityRecovery
				: Math.max(accountCooldown, capacityRecovery),
		);
		const availableAt = Math.min(...routeRecoveries);
		recoveries.push({
			accountId: account.id,
			availableAt,
			reason:
				accountCooldown !== null && availableAt === accountCooldown
					? "account_cooldown"
					: "account_capacity",
		});
	}

	return recoveries;
}

function accountReason(
	account: Account,
	recovery: AutomaticRecovery | undefined,
	now: number,
): string {
	if (account.paused) return account.pause_reason || "paused";
	if (recovery?.reason === "account_capacity") return "capacity_exhausted";
	if (recovery?.reason === "account_cooldown") return "rate_limited";
	if (isFiniteFuture(account.rate_limited_until, now)) {
		return "recovery_unverified";
	}
	return "unavailable";
}

export function createModelPoolExhaustedResponse(options: {
	capacityContext: RoutingCapacityContext | null;
	rateLimitOutcomes: readonly RequestRateLimitOutcome[];
	now: number;
	modelRecoveryAt?: number | null;
}): Response {
	const { capacityContext, rateLimitOutcomes, now, modelRecoveryAt } = options;
	const nextAvailableAt = earliestFuture(
		[
			capacityContext?.blockedUntil,
			...rateLimitOutcomes.map((outcome) => outcome.availableAt),
			modelRecoveryAt,
		],
		now,
	);
	const outcomeModel = rateLimitOutcomes.find(
		(outcome) => outcome.attemptedModel,
	)?.attemptedModel;
	const outcomeFamily = rateLimitOutcomes.find(
		(outcome) => outcome.family,
	)?.family;
	const error: Record<string, unknown> = {
		type: "service_unavailable",
		code: "model_pool_exhausted",
		message:
			"No eligible account currently has capacity for the requested model lane.",
		model: capacityContext?.effectiveModel ?? outcomeModel ?? null,
		family: capacityContext?.effectiveModelFamily ?? outcomeFamily ?? null,
	};
	if (nextAvailableAt !== null) {
		error.next_available_at = new Date(nextAvailableAt).toISOString();
	}
	const headers = new Headers({ "content-type": "application/json" });
	if (nextAvailableAt !== null) {
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((nextAvailableAt - now) / 1000),
		);
		headers.set("retry-after", String(retryAfterSeconds));
		headers.set(RECOVERY_STATUS_HEADER, RECOVERY_STATUS_EXHAUSTED);
		headers.set(RECOVERY_SCOPE_HEADER, "model");
	}
	return new Response(JSON.stringify({ type: "error", error }), {
		status: 503,
		headers,
	});
}

function createPoolExhaustedResponse(options: {
	accounts: readonly Account[];
	recoveries: readonly AutomaticRecovery[];
	now: number;
}): Response {
	const { accounts, recoveries, now } = options;
	const nextAvailableAt = Math.min(
		...recoveries.map((recovery) => recovery.availableAt),
	);
	const recoveryByAccount = new Map(
		recoveries.map((recovery) => [recovery.accountId, recovery]),
	);
	const accountInfos = accounts.map((account) => {
		const recovery = recoveryByAccount.get(account.id);
		return {
			name: account.name,
			reason: accountReason(account, recovery, now),
			available_at: recovery
				? new Date(recovery.availableAt).toISOString()
				: null,
		};
	});
	const retryAfterSeconds = Math.max(
		1,
		Math.ceil((nextAvailableAt - now) / 1000),
	);
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "pool_exhausted",
				code: "pool_exhausted",
				message: "All compatible account routes are temporarily unavailable.",
				next_available_at: new Date(nextAvailableAt).toISOString(),
				accounts: accountInfos,
			},
		}),
		{
			status: 503,
			headers: {
				"content-type": "application/json",
				"retry-after": String(retryAfterSeconds),
				[RECOVERY_STATUS_HEADER]: RECOVERY_STATUS_EXHAUSTED,
				[RECOVERY_SCOPE_HEADER]: "pool",
			},
		},
	);
}

function createRouteUnavailableResponse(options: {
	accounts: readonly Account[];
	now: number;
	message?: string;
	attemptedRoutes?: number;
	routeCircuitRecoveryHint?: RouteCircuitRecoveryHint | null;
}): Response {
	const { accounts, now } = options;
	const recovery = options.routeCircuitRecoveryHint;
	const error: Record<string, unknown> = {
		type: "service_unavailable",
		code: "route_unavailable",
		message:
			options.message || "No compatible account route is currently available.",
		accounts: accounts.map((account) => ({
			name: account.name,
			reason: accountReason(account, undefined, now),
		})),
	};
	if (options.attemptedRoutes !== undefined) {
		error.attempted_routes = options.attemptedRoutes;
	}
	const headers = new Headers({ "content-type": "application/json" });
	if (
		recovery?.allCandidatesOpen &&
		recovery.retryAt !== null &&
		Number.isFinite(recovery.retryAt)
	) {
		const effectiveRetryAt = Math.max(now, recovery.retryAt);
		error.next_available_at = new Date(effectiveRetryAt).toISOString();
		error.route_circuit = {
			all_candidates_open: recovery.allCandidatesOpen,
			candidate_count: recovery.candidateCount,
			probe_leased: recovery.probeLeased,
			reason: recovery.reason,
		};
		headers.set(
			"retry-after",
			String(Math.max(1, Math.ceil((effectiveRetryAt - now) / 1000))),
		);
		headers.set("x-better-ccflare-route-status", "circuit-open");
	}
	return new Response(
		JSON.stringify({
			type: "error",
			error,
		}),
		{
			status: 503,
			headers,
		},
	);
}

/**
 * Build the terminal response from positively-known routing state. Retryable
 * pool- or model-scoped recovery is deliberately narrow; absent complete,
 * finite automatic recovery evidence, requests fail once as route_unavailable.
 */
export function createRoutingTerminalResponse(
	options: RoutingTerminalOptions,
): RoutingTerminalResult {
	const now = options.now ?? Date.now();
	const modelExhausted =
		options.source === "selection"
			? modelOnlyCapacity(options.capacityContext, options.accounts, now)
			: everyAttemptWasModelLaneScoped(
					options.rateLimitOutcomes,
					options.upstreamAttempts,
				);
	if (modelExhausted) {
		return {
			kind: "model_pool_exhausted",
			response: createModelPoolExhaustedResponse({
				capacityContext:
					options.source === "selection" ? options.capacityContext : null,
				rateLimitOutcomes: options.rateLimitOutcomes,
				now,
				modelRecoveryAt: options.modelRecoveryAt,
			}),
		};
	}
	const hasAttemptModelEvidence =
		options.source === "attempts" &&
		options.rateLimitOutcomes.some(
			(outcome) => outcome.scope === "family" || outcome.scope === "model",
		);
	if (
		hasAttemptModelEvidence &&
		options.rateLimitOutcomes.length !== options.upstreamAttempts
	) {
		return {
			kind: "route_unavailable",
			response: createRouteUnavailableResponse({
				accounts: options.accounts,
				now,
				message: options.message,
				attemptedRoutes:
					options.source === "attempts" ? options.upstreamAttempts : undefined,
				routeCircuitRecoveryHint: options.routeCircuitRecoveryHint,
			}),
		};
	}
	const attemptRouteRecoveries = new Map<string, (number | null)[]>();
	if (hasAttemptModelEvidence) {
		for (const outcome of options.rateLimitOutcomes) {
			if (outcome.scope !== "family" && outcome.scope !== "model") continue;
			const existing = attemptRouteRecoveries.get(outcome.accountId) ?? [];
			existing.push(
				isFiniteFuture(outcome.availableAt, now) ? outcome.availableAt : null,
			);
			attemptRouteRecoveries.set(outcome.accountId, existing);
		}
	}

	const recoveries = findAutomaticRecoveries(
		options.accounts,
		options.capacityContext,
		attemptRouteRecoveries,
		now,
	);
	const recoveredIds = new Set(
		recoveries.map((recovery) => recovery.accountId),
	);
	const unpausedAccounts = options.accounts.filter(
		(account) => !account.paused,
	);
	if (
		recoveries.length > 0 &&
		unpausedAccounts.every((account) => recoveredIds.has(account.id))
	) {
		return {
			kind: "pool_exhausted",
			response: createPoolExhaustedResponse({
				accounts: options.accounts,
				recoveries,
				now,
			}),
		};
	}

	return {
		kind: "route_unavailable",
		response: createRouteUnavailableResponse({
			accounts: options.accounts,
			now,
			message: options.message,
			attemptedRoutes:
				options.source === "attempts" ? options.upstreamAttempts : undefined,
			routeCircuitRecoveryHint: options.routeCircuitRecoveryHint,
		}),
	};
}

function finiteAccountTimestamp(
	value: number | null | undefined,
): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Merge request-local cooldown observations into a successfully refreshed
 * terminal inventory without replacing the refreshed rows wholesale.
 *
 * A bounded/rejected cooldown write can leave the DB row older than the
 * account object mutated by the current request. In that case the local
 * observation is required for an accurate terminal response. The DB row still
 * supplies every unrelated field, and it wins outright when its
 * `rate_limited_at` is equal or newer. When the local observation is newer, its
 * deadline and reason remain an atomic observation: an older, longer DB
 * deadline with a null or lane-scoped reason must not erase verified recovery
 * provenance. Deleted or request-incompatible refreshed rows are never
 * resurrected.
 */
export function mergeTerminalAccountState(
	refreshedAccounts: readonly Account[],
	requestLocalAccounts: readonly Account[],
): Account[] {
	const localById = new Map<string, Account>();
	for (const account of requestLocalAccounts) {
		const candidateAt = finiteAccountTimestamp(account.rate_limited_at);
		if (candidateAt === null) continue;
		const existing = localById.get(account.id);
		const existingAt = finiteAccountTimestamp(existing?.rate_limited_at);
		if (
			existingAt === null ||
			candidateAt > existingAt ||
			(candidateAt === existingAt &&
				(account.rate_limited_until ?? -Infinity) >
					(existing?.rate_limited_until ?? -Infinity))
		) {
			localById.set(account.id, account);
		}
	}

	return refreshedAccounts.map((refreshed) => {
		const local = localById.get(refreshed.id);
		if (!local) return refreshed;
		const localAt = finiteAccountTimestamp(local.rate_limited_at);
		const localUntil = finiteAccountTimestamp(local.rate_limited_until);
		const refreshedAt = finiteAccountTimestamp(refreshed.rate_limited_at);
		if (
			localAt === null ||
			localUntil === null ||
			local.rate_limited_reason == null ||
			(refreshedAt !== null && refreshedAt >= localAt)
		) {
			return refreshed;
		}

		return {
			...refreshed,
			rate_limited_at: localAt,
			rate_limited_until: localUntil,
			rate_limited_reason: local.rate_limited_reason,
			consecutive_rate_limits: Math.max(
				refreshed.consecutive_rate_limits,
				local.consecutive_rate_limits,
			),
		};
	});
}

/** Mirror selector request exclusions while retaining dynamic cross-provider routing. */
export function filterRequestCompatibleAccounts(
	accounts: readonly Account[],
	headers: Headers,
): Account[] {
	const excluded =
		headers
			.get("x-better-ccflare-exclude-providers")
			?.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean) ?? [];
	if (excluded.length === 0) return [...accounts];
	return accounts.filter((account) =>
		excluded.every((provider) => {
			if (provider === "anthropic-oauth") {
				return !(
					account.provider === "anthropic" && account.refresh_token != null
				);
			}
			return account.provider !== provider;
		}),
	);
}
