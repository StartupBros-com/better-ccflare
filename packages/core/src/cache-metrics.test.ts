import { describe, expect, test } from "bun:test";
import {
	cacheReadSharePercent,
	summarizeCacheReadObservations,
	type CacheUsageObservation,
} from "./cache-metrics";

describe("cacheReadSharePercent", () => {
	test("agrees for equivalent additive and inclusive usage", () => {
		expect(
			cacheReadSharePercent({
				shape: "additive",
				uncachedInputTokens: 100,
				cacheReadInputTokens: 900,
				cacheWriteInputTokens: 0,
			}),
		).toBe(90);
		expect(
			cacheReadSharePercent({
				shape: "inclusive",
				totalInputTokens: 1_000,
				cacheReadInputTokens: 900,
			}),
		).toBe(90);
	});

	test("includes cache writes once in the additive denominator", () => {
		expect(
			cacheReadSharePercent({
				shape: "additive",
				uncachedInputTokens: 100,
				cacheReadInputTokens: 800,
				cacheWriteInputTokens: 100,
			}),
		).toBe(80);
	});

	test("returns null for invalid or contradictory token counts", () => {
		expect(
			cacheReadSharePercent({
				shape: "inclusive",
				totalInputTokens: 100,
				cacheReadInputTokens: 101,
			}),
		).toBeNull();
		expect(
			cacheReadSharePercent({
				shape: "additive",
				uncachedInputTokens: Number.NaN,
				cacheReadInputTokens: 0,
				cacheWriteInputTokens: 0,
			}),
		).toBeNull();
		expect(
			cacheReadSharePercent({
				shape: "inclusive",
				totalInputTokens: -1,
				cacheReadInputTokens: 0,
			}),
		).toBeNull();
	});

	test("treats a measured empty input as zero percent", () => {
		expect(
			cacheReadSharePercent({
				shape: "inclusive",
				totalInputTokens: 0,
				cacheReadInputTokens: 0,
			}),
		).toBe(0);
	});
});

describe("summarizeCacheReadObservations", () => {
	test("reports weighted and per-request distributions together", () => {
		const observations: CacheUsageObservation[] = [
			{
				shape: "inclusive",
				totalInputTokens: 100,
				cacheReadInputTokens: 0,
			},
			{
				shape: "inclusive",
				totalInputTokens: 100,
				cacheReadInputTokens: 50,
			},
			{
				shape: "inclusive",
				totalInputTokens: 100,
				cacheReadInputTokens: 100,
			},
			{
				shape: "inclusive",
				totalInputTokens: 700,
				cacheReadInputTokens: 700,
			},
		];

		expect(summarizeCacheReadObservations(observations)).toEqual({
			measuredResponses: 4,
			unavailableResponses: 0,
			totalInputTokens: 1_000,
			cacheReadInputTokens: 850,
			weightedCacheReadPercent: 85,
			medianCacheReadPercent: 75,
			p25CacheReadPercent: 0,
			p75CacheReadPercent: 100,
			positiveHitResponses: 3,
			positiveHitRatePercent: 75,
			zeroHitResponses: 1,
			zeroHitRatePercent: 25,
		});
	});

	test("counts invalid observations as unavailable without poisoning totals", () => {
		expect(
			summarizeCacheReadObservations([
				{
					shape: "inclusive",
					totalInputTokens: 100,
					cacheReadInputTokens: 50,
				},
				{
					shape: "inclusive",
					totalInputTokens: 100,
					cacheReadInputTokens: 101,
				},
			]),
		).toMatchObject({
			measuredResponses: 1,
			unavailableResponses: 1,
			totalInputTokens: 100,
			cacheReadInputTokens: 50,
			weightedCacheReadPercent: 50,
		});
	});
});
