import type {
	Account,
	RateLimitReason,
	RouteCircuitRecoveryHint,
} from "@better-ccflare/types";
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

function hasUnpausedModelCapacityEvidence(
	context: RoutingCapacityContext | null,
	accounts: readonly Account[],
): boolean {
	const unpausedIds = new Set(
		accounts.filter((account) => !account.paused).map((account) => account.id),
	);
	return Boolean(
		context?.exclusions.some(
			(candidate) =>
				unpausedIds.has(candidate.accountId) &&
				candidate.exclusions.some(
					(blocker) => blocker.scope === "family" || blocker.scope === "model",
				),
		),
	);
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
	now: number,
): AutomaticRecovery[] {
	const accountById = new Map(accounts.map((account) => [account.id, account]));
	const recoveries = new Map<string, AutomaticRecovery>();
	const accountsWithUnknownCapacityRecovery = new Set<string>();

	for (const account of accounts) {
		if (
			account.paused ||
			!isFiniteFuture(account.rate_limited_until, now) ||
			!account.rate_limited_reason ||
			!GLOBAL_COOLDOWN_REASONS.has(account.rate_limited_reason)
		) {
			continue;
		}
		recoveries.set(account.id, {
			accountId: account.id,
			availableAt: account.rate_limited_until,
			reason: "account_cooldown",
		});
	}

	for (const candidate of capacityContext?.exclusions ?? []) {
		const account = accountById.get(candidate.accountId);
		if (
			!account ||
			account.paused ||
			candidate.exclusions.length === 0 ||
			!candidate.exclusions.every((blocker) => blocker.scope === "account")
		) {
			continue;
		}
		const hasCompleteProviderResets = candidate.exclusions.every(
			(blocker) =>
				blocker.source === "usage_snapshot" &&
				isFiniteFuture(blocker.resetAtMs, now),
		);
		if (!hasCompleteProviderResets) {
			// Evidence freshness only says when to re-check. It is not proof that
			// provider capacity will recover, and it must invalidate a DB cooldown
			// that would otherwise make this account look completely recoverable.
			accountsWithUnknownCapacityRecovery.add(account.id);
			continue;
		}
		const availableAt = Math.max(
			...candidate.exclusions
				.map((blocker) => blocker.resetAtMs)
				.filter((resetAtMs): resetAtMs is number => resetAtMs !== null),
		);
		const existing = recoveries.get(account.id);
		// A candidate with multiple simultaneous global blockers becomes eligible
		// only when all clear. Preserve the later recovery when DB cooldown and
		// request-local capacity evidence coexist for the same account.
		if (!existing || availableAt > existing.availableAt) {
			recoveries.set(account.id, {
				accountId: account.id,
				availableAt,
				reason: "account_capacity",
			});
		}
	}
	for (const accountId of accountsWithUnknownCapacityRecovery) {
		recoveries.delete(accountId);
	}

	return [...recoveries.values()];
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
}): Response {
	const { capacityContext, rateLimitOutcomes, now } = options;
	const nextAvailableAt = earliestFuture(
		[
			capacityContext?.blockedUntil,
			...rateLimitOutcomes.map((outcome) => outcome.availableAt),
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
	return new Response(JSON.stringify({ type: "error", error }), {
		status: 503,
		headers: { "content-type": "application/json" },
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
				"x-better-ccflare-pool-status": "exhausted",
			},
		},
	);
}

function createRouteUnavailableResponse(options: {
	accounts: readonly Account[];
	now: number;
	message?: string;
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
 * whole-pool exhaustion is deliberately the narrow case; absent complete,
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
			}),
		};
	}
	const ambiguousModelEvidence =
		options.source === "selection"
			? hasUnpausedModelCapacityEvidence(
					options.capacityContext,
					options.accounts,
				)
			: options.rateLimitOutcomes.some(
					(outcome) => outcome.scope === "family" || outcome.scope === "model",
				);
	if (ambiguousModelEvidence) {
		return {
			kind: "route_unavailable",
			response: createRouteUnavailableResponse({
				accounts: options.accounts,
				now,
				message: options.message,
				routeCircuitRecoveryHint: options.routeCircuitRecoveryHint,
			}),
		};
	}

	const recoveries = findAutomaticRecoveries(
		options.accounts,
		options.capacityContext,
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
			routeCircuitRecoveryHint: options.routeCircuitRecoveryHint,
		}),
	};
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
