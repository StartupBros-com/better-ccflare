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

export interface CacheReadHistogramBucket {
	sharePercent: number;
	responses: number;
}

export interface CacheReadHistogram {
	totalInputTokens: number;
	cacheReadInputTokens: number;
	unavailableResponses: number;
	buckets: readonly CacheReadHistogramBucket[];
}

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

function summaryFromParts(input: {
	totalInputTokens: number;
	cacheReadInputTokens: number;
	unavailableResponses: number;
	measuredResponses: number;
	medianCacheReadPercent: number | null;
	p25CacheReadPercent: number | null;
	p75CacheReadPercent: number | null;
	positiveHitResponses: number;
	zeroHitResponses: number;
}): CacheReadSummary {
	return {
		measuredResponses: input.measuredResponses,
		unavailableResponses: input.unavailableResponses,
		totalInputTokens: input.totalInputTokens,
		cacheReadInputTokens: input.cacheReadInputTokens,
		weightedCacheReadPercent:
			input.totalInputTokens > 0
				? roundPercent(
						(input.cacheReadInputTokens * 100) / input.totalInputTokens,
					)
				: input.measuredResponses > 0
					? 0
					: null,
		medianCacheReadPercent: roundPercent(input.medianCacheReadPercent),
		p25CacheReadPercent: roundPercent(input.p25CacheReadPercent),
		p75CacheReadPercent: roundPercent(input.p75CacheReadPercent),
		positiveHitResponses: input.positiveHitResponses,
		positiveHitRatePercent:
			input.measuredResponses > 0
				? roundPercent(
						(input.positiveHitResponses * 100) / input.measuredResponses,
					)
				: null,
		zeroHitResponses: input.zeroHitResponses,
		zeroHitRatePercent:
			input.measuredResponses > 0
				? roundPercent((input.zeroHitResponses * 100) / input.measuredResponses)
				: null,
	};
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
	return summaryFromParts({
		measuredResponses,
		unavailableResponses,
		totalInputTokens,
		cacheReadInputTokens,
		medianCacheReadPercent: median(shares),
		p25CacheReadPercent: percentile(shares, 0.25),
		p75CacheReadPercent: percentile(shares, 0.75),
		positiveHitResponses,
		zeroHitResponses,
	});
}

function histogramValueAtRank(
	buckets: readonly CacheReadHistogramBucket[],
	rank: number,
): number | null {
	let observed = 0;
	for (const bucket of buckets) {
		observed += bucket.responses;
		if (rank < observed) return bucket.sharePercent;
	}
	return null;
}

/**
 * Summarize a bounded cache-share histogram without expanding one value per
 * request. Buckets must use a 0-100 percentage scale.
 */
export function summarizeCacheReadHistogram(
	histogram: CacheReadHistogram,
): CacheReadSummary {
	if (
		!validTokenCount(histogram.totalInputTokens) ||
		!validTokenCount(histogram.cacheReadInputTokens) ||
		histogram.cacheReadInputTokens > histogram.totalInputTokens ||
		!validTokenCount(histogram.unavailableResponses)
	) {
		return summaryFromParts({
			measuredResponses: 0,
			unavailableResponses: histogram.buckets.length + 1,
			totalInputTokens: 0,
			cacheReadInputTokens: 0,
			medianCacheReadPercent: null,
			p25CacheReadPercent: null,
			p75CacheReadPercent: null,
			positiveHitResponses: 0,
			zeroHitResponses: 0,
		});
	}

	const buckets = [...histogram.buckets]
		.filter(
			(bucket) =>
				Number.isFinite(bucket.sharePercent) &&
				bucket.sharePercent >= 0 &&
				bucket.sharePercent <= 100 &&
				validTokenCount(bucket.responses) &&
				bucket.responses > 0,
		)
		.sort((left, right) => left.sharePercent - right.sharePercent);
	let measuredResponses = 0;
	let positiveHitResponses = 0;
	let zeroHitResponses = 0;
	for (const bucket of buckets) {
		measuredResponses += bucket.responses;
		if (bucket.sharePercent > 0) positiveHitResponses += bucket.responses;
		else zeroHitResponses += bucket.responses;
	}

	const medianRank = measuredResponses / 2;
	const medianCacheReadPercent = Number.isInteger(medianRank)
		? (() => {
				const lower = histogramValueAtRank(buckets, medianRank - 1);
				const upper = histogramValueAtRank(buckets, medianRank);
				return lower === null || upper === null ? null : (lower + upper) / 2;
			})()
		: histogramValueAtRank(buckets, Math.floor(medianRank));
	const percentileRank = (quantile: number) =>
		measuredResponses > 0
			? histogramValueAtRank(
					buckets,
					Math.max(0, Math.ceil(quantile * measuredResponses) - 1),
				)
			: null;

	return summaryFromParts({
		measuredResponses,
		unavailableResponses: histogram.unavailableResponses,
		totalInputTokens: histogram.totalInputTokens,
		cacheReadInputTokens: histogram.cacheReadInputTokens,
		medianCacheReadPercent,
		p25CacheReadPercent: percentileRank(0.25),
		p75CacheReadPercent: percentileRank(0.75),
		positiveHitResponses,
		zeroHitResponses,
	});
}
