import { summarizeCacheReadHistogram } from "@better-ccflare/core";
import type {
	CacheParityDimensionSummary,
	CacheParityMetrics,
	CacheParityPolicySnapshot,
	CacheParityProviderSummary,
	CacheParityResponse,
	CacheParityVerdict,
	CacheParityWindow,
} from "@better-ccflare/types";

export type CacheParityPolicy = CacheParityPolicySnapshot;

export interface CacheParityAggregateRow {
	provider: string;
	physicalModel: string;
	accountName: string;
	turnKind: "first_observed" | "follow_up";
	gapBand: string;
	contextBand: string;
	sameAccount: boolean;
	cacheShareBucket: number | null;
	requests: number;
	successfulRequests: number;
	fallbackRequests: number;
	contextOverflowRequests: number;
	inputTokens: number;
	cacheReadInputTokens: number;
}

export interface BuildCacheParityResponseInput {
	rows24h: readonly CacheParityAggregateRow[];
	rows7d: readonly CacheParityAggregateRow[];
	policy: CacheParityPolicy;
	generatedAt: number;
}

export const CACHE_PARITY_MIN_FOLLOW_UPS = 1_000;
export const CACHE_PARITY_MIN_INPUT_TOKENS = 10_000_000;
export const CACHE_PARITY_WEIGHTED_READ_FLOOR = 96;
export const CACHE_PARITY_POSITIVE_HIT_FLOOR = 99;
export const CACHE_PARITY_ZERO_HIT_CEILING = 1;

function roundPercent(value: number | null): number | null {
	return value === null ? null : Math.round(value * 10) / 10;
}

function rate(numerator: number, denominator: number): number | null {
	return denominator > 0 ? roundPercent((numerator * 100) / denominator) : null;
}

function aggregateMetrics(
	rows: readonly CacheParityAggregateRow[],
): CacheParityMetrics {
	let totalRequests = 0;
	let successfulRequests = 0;
	let fallbackRequests = 0;
	let contextOverflowRequests = 0;
	let totalInputTokens = 0;
	let cacheReadInputTokens = 0;
	let unavailableResponses = 0;
	const bucketCounts = new Map<number, number>();

	for (const row of rows) {
		totalRequests += row.requests;
		successfulRequests += row.successfulRequests;
		fallbackRequests += row.fallbackRequests;
		contextOverflowRequests += row.contextOverflowRequests;
		if (row.cacheShareBucket === null) {
			unavailableResponses += row.successfulRequests;
			continue;
		}
		totalInputTokens += row.inputTokens;
		cacheReadInputTokens += row.cacheReadInputTokens;
		bucketCounts.set(
			row.cacheShareBucket,
			(bucketCounts.get(row.cacheShareBucket) ?? 0) + row.successfulRequests,
		);
	}

	const cache = summarizeCacheReadHistogram({
		totalInputTokens,
		cacheReadInputTokens,
		unavailableResponses,
		buckets: [...bucketCounts].map(([sharePercent, responses]) => ({
			sharePercent,
			responses,
		})),
	});
	return {
		totalRequests,
		successfulRequests,
		successRatePercent: rate(successfulRequests, totalRequests),
		fallbackRequests,
		fallbackRatePercent: rate(fallbackRequests, totalRequests),
		contextOverflowRequests,
		contextOverflowRatePercent: rate(contextOverflowRequests, totalRequests),
		...cache,
	};
}

function groupRows(
	rows: readonly CacheParityAggregateRow[],
	keyOf: (row: CacheParityAggregateRow) => string,
): CacheParityDimensionSummary[] {
	const groups = new Map<string, CacheParityAggregateRow[]>();
	for (const row of rows) {
		const key = keyOf(row);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups]
		.map(([key, groupedRows]) => ({
			key,
			metrics: aggregateMetrics(groupedRows),
		}))
		.sort((left, right) =>
			left.key.localeCompare(right.key, "en", { sensitivity: "base" }),
		);
}

function providerSummaries(
	rows: readonly CacheParityAggregateRow[],
): CacheParityProviderSummary[] {
	const providers = new Map<string, CacheParityAggregateRow[]>();
	for (const row of rows) {
		const group = providers.get(row.provider) ?? [];
		group.push(row);
		providers.set(row.provider, group);
	}
	return [...providers]
		.map(([key, providerRows]) => ({
			key,
			firstObserved: aggregateMetrics(
				providerRows.filter((row) => row.turnKind === "first_observed"),
			),
			followUps: aggregateMetrics(
				providerRows.filter((row) => row.turnKind === "follow_up"),
			),
		}))
		.sort((left, right) => left.key.localeCompare(right.key));
}

function qualified(metrics: CacheParityMetrics): boolean {
	return (
		metrics.measuredResponses >= CACHE_PARITY_MIN_FOLLOW_UPS &&
		metrics.totalInputTokens >= CACHE_PARITY_MIN_INPUT_TOKENS
	);
}

function meetsCacheFloor(metrics: CacheParityMetrics): boolean {
	return (
		(metrics.weightedCacheReadPercent ?? 0) >=
			CACHE_PARITY_WEIGHTED_READ_FLOOR &&
		(metrics.positiveHitRatePercent ?? 0) >= CACHE_PARITY_POSITIVE_HIT_FLOOR &&
		(metrics.zeroHitRatePercent ?? 100) <= CACHE_PARITY_ZERO_HIT_CEILING
	);
}

function noWorseThan(
	candidate: CacheParityMetrics,
	reference: CacheParityMetrics,
): boolean {
	return (
		(candidate.weightedCacheReadPercent ?? 0) >=
			(reference.weightedCacheReadPercent ?? 0) &&
		(candidate.positiveHitRatePercent ?? 0) >=
			(reference.positiveHitRatePercent ?? 0) &&
		(candidate.zeroHitRatePercent ?? 100) <=
			(reference.zeroHitRatePercent ?? 100)
	);
}

function buildWindow(
	rows: readonly CacheParityAggregateRow[],
	policy: CacheParityPolicy,
): CacheParityWindow {
	const providers = providerSummaries(rows);
	const codex = providers.find((provider) => provider.key === "codex");
	const anthropic = providers.find((provider) => provider.key === "anthropic");
	const codexRows = rows.filter(
		(row) => row.provider === "codex" && row.turnKind === "follow_up",
	);
	const codexByPhysicalModel = groupRows(codexRows, (row) => row.physicalModel);
	const codexByAccount = groupRows(codexRows, (row) => row.accountName);
	const codexByGapBand = groupRows(codexRows, (row) => row.gapBand);
	const codexByContextBand = groupRows(codexRows, (row) => row.contextBand);
	const codexByAccountContinuity = groupRows(codexRows, (row) =>
		row.sameAccount ? "same_account" : "changed_account",
	);
	const codexQualified = Boolean(codex && qualified(codex.followUps));
	const anthropicQualified = Boolean(
		anthropic && qualified(anthropic.followUps),
	);
	const reasons: string[] = [];
	let verdict: CacheParityVerdict = "at_parity";

	if (policy.globalKeepaliveTtlMinutes > 0) {
		verdict = "insufficient_evidence";
		reasons.push("unattributed_synthetic_traffic_possible");
	} else if (!codexQualified) {
		verdict = "insufficient_evidence";
		reasons.push("codex_evidence_below_floor");
	} else if (!codex || !meetsCacheFloor(codex.followUps)) {
		verdict = "below_parity";
		reasons.push("codex_cache_floor_not_met");
	}

	if (
		verdict !== "insufficient_evidence" &&
		codexByPhysicalModel
			.filter((model) => qualified(model.metrics))
			.some((model) => !meetsCacheFloor(model.metrics))
	) {
		verdict = "below_parity";
		reasons.push("codex_model_floor_not_met");
	}
	if (
		verdict !== "insufficient_evidence" &&
		codex &&
		anthropic &&
		anthropicQualified &&
		!noWorseThan(codex.followUps, anthropic.followUps)
	) {
		verdict = "below_parity";
		reasons.push("anthropic_comparison_not_met");
	}
	if (verdict === "at_parity") reasons.push("cache_parity_thresholds_met");

	return {
		verdict,
		reasons,
		evidence: {
			minimumFollowUps: CACHE_PARITY_MIN_FOLLOW_UPS,
			minimumInputTokens: CACHE_PARITY_MIN_INPUT_TOKENS,
			codexQualified,
			anthropicQualified,
		},
		providers,
		codexByPhysicalModel,
		codexByAccount,
		codexByGapBand,
		codexByContextBand,
		codexByAccountContinuity,
	};
}

export function buildCacheParityResponse(
	input: BuildCacheParityResponseInput,
): CacheParityResponse {
	const advisory24h = buildWindow(input.rows24h, input.policy);
	const authoritative7d = buildWindow(input.rows7d, input.policy);
	return {
		generatedAt: input.generatedAt,
		verdict: authoritative7d.verdict,
		metricScopes: {
			durable: "logical_request_final_usage",
			trace: "physical_attempt_usage",
		},
		backendCapability: {
			endpoint: "chatgpt_subscription",
			explicitBreakpoint:
				input.policy.explicitBreakpointSuppressedScopes > 0
					? "unsupported_observed"
					: input.policy.explicitBreakpointPercent > 0
						? "treatment_requested"
						: "not_requested",
		},
		policy: input.policy,
		windows: { advisory24h, authoritative7d },
	};
}
