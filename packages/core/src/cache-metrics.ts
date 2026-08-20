export interface AdditiveCacheUsageObservation {
	shape: "additive";
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheWriteInputTokens: number;
}

export interface InclusiveCacheUsageObservation {
	shape: "inclusive";
	totalInputTokens: number;
	cacheReadInputTokens: number;
}

export type CacheUsageObservation =
	| AdditiveCacheUsageObservation
	| InclusiveCacheUsageObservation;

export interface CacheReadSummary {
	measuredResponses: number;
	unavailableResponses: number;
	totalInputTokens: number;
	cacheReadInputTokens: number;
	weightedCacheReadPercent: number | null;
	medianCacheReadPercent: number | null;
	p25CacheReadPercent: number | null;
	p75CacheReadPercent: number | null;
	positiveHitResponses: number;
	positiveHitRatePercent: number | null;
	zeroHitResponses: number;
	zeroHitRatePercent: number | null;
}

interface NormalizedCacheUsage {
	totalInputTokens: number;
	cacheReadInputTokens: number;
	sharePercent: number;
}

function validTokenCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function safeTokenSum(...values: readonly number[]): number | null {
	let total = 0;
	for (const value of values) {
		if (!validTokenCount(value)) return null;
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function normalizeCacheUsage(
	observation: CacheUsageObservation,
): NormalizedCacheUsage | null {
	const cacheReadInputTokens = observation.cacheReadInputTokens;
	if (!validTokenCount(cacheReadInputTokens)) return null;

	const totalInputTokens =
		observation.shape === "inclusive"
			? observation.totalInputTokens
			: safeTokenSum(
					observation.uncachedInputTokens,
					cacheReadInputTokens,
					observation.cacheWriteInputTokens,
				);
	if (
		totalInputTokens === null ||
		!validTokenCount(totalInputTokens) ||
		cacheReadInputTokens > totalInputTokens
	) {
		return null;
	}

	return {
		totalInputTokens,
		cacheReadInputTokens,
		sharePercent:
			totalInputTokens === 0
				? 0
				: (cacheReadInputTokens * 100) / totalInputTokens,
	};
}

/**
 * Cache-read share on a 0-100 scale using the source's actual token semantics.
 * Invalid or contradictory measurements return null rather than becoming misses.
 */
export function cacheReadSharePercent(
	observation: CacheUsageObservation,
): number | null {
	return normalizeCacheUsage(observation)?.sharePercent ?? null;
}

function percentile(
	sortedValues: readonly number[],
	quantile: number,
): number | null {
	if (sortedValues.length === 0) return null;
	const index = Math.max(
		0,
		Math.min(
			sortedValues.length - 1,
			Math.ceil(quantile * sortedValues.length) - 1,
		),
	);
	return sortedValues[index] ?? null;
}

function median(sortedValues: readonly number[]): number | null {
	if (sortedValues.length === 0) return null;
	const midpoint = sortedValues.length / 2;
	if (Number.isInteger(midpoint)) {
		const lower = sortedValues[midpoint - 1];
		const upper = sortedValues[midpoint];
		if (lower === undefined || upper === undefined) return null;
		return (lower + upper) / 2;
	}
	return sortedValues[Math.floor(midpoint)] ?? null;
}

function roundPercent(value: number | null): number | null {
	return value === null ? null : Math.round(value * 10) / 10;
}

/** Aggregate weighted and per-request cache-read metrics from one source shape. */
export function summarizeCacheReadObservations(
	observations: readonly CacheUsageObservation[],
): CacheReadSummary {
	let totalInputTokens = 0;
	let cacheReadInputTokens = 0;
	let unavailableResponses = 0;
	let positiveHitResponses = 0;
	let zeroHitResponses = 0;
	const shares: number[] = [];

	for (const observation of observations) {
		const normalized = normalizeCacheUsage(observation);
		if (!normalized) {
			unavailableResponses++;
			continue;
		}
		const nextTotal = safeTokenSum(
			totalInputTokens,
			normalized.totalInputTokens,
		);
		const nextCached = safeTokenSum(
			cacheReadInputTokens,
			normalized.cacheReadInputTokens,
		);
		if (nextTotal === null || nextCached === null) {
			unavailableResponses++;
			continue;
		}
		totalInputTokens = nextTotal;
		cacheReadInputTokens = nextCached;
		shares.push(normalized.sharePercent);
		if (normalized.cacheReadInputTokens > 0) positiveHitResponses++;
		else zeroHitResponses++;
	}

	shares.sort((left, right) => left - right);
	const measuredResponses = shares.length;
	return {
		measuredResponses,
		unavailableResponses,
		totalInputTokens,
		cacheReadInputTokens,
		weightedCacheReadPercent:
			totalInputTokens > 0
				? roundPercent((cacheReadInputTokens * 100) / totalInputTokens)
				: measuredResponses > 0
					? 0
					: null,
		medianCacheReadPercent: roundPercent(median(shares)),
		p25CacheReadPercent: roundPercent(percentile(shares, 0.25)),
		p75CacheReadPercent: roundPercent(percentile(shares, 0.75)),
		positiveHitResponses,
		positiveHitRatePercent:
			measuredResponses > 0
				? roundPercent((positiveHitResponses * 100) / measuredResponses)
				: null,
		zeroHitResponses,
		zeroHitRatePercent:
			measuredResponses > 0
				? roundPercent((zeroHitResponses * 100) / measuredResponses)
				: null,
	};
}
