import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LIST_PRICE_ERAS, type ListPriceEra } from "./value-pricing";
import {
	valueWindowAggregates,
	type WindowTokenAggregate,
} from "./window-valuation";

// Synthetic single-era model, isolated from the real seed data so these
// tests don't drift if LIST_PRICE_ERAS gains/changes real entries.
const PRICED_MODEL = "test-priced-model";
const ERA_SINCE_MS = Date.parse("2026-06-01T00:00:00Z");
const AT_MS = Date.parse("2026-06-15T00:00:00Z");

const testEra: ListPriceEra[] = [
	{
		sinceMs: ERA_SINCE_MS,
		inputPerM: 2,
		cacheReadPerM: 0.2,
		cacheCreationPerM: 4,
		outputPerM: 10,
	},
];

const UNKNOWN_MODEL = "totally-unpriced-model-xyz";

function agg(overrides: Partial<WindowTokenAggregate>): WindowTokenAggregate {
	return {
		model: PRICED_MODEL,
		requestCount: 1,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		...overrides,
	};
}

describe("valueWindowAggregates", () => {
	beforeEach(() => {
		LIST_PRICE_ERAS[PRICED_MODEL] = testEra;
	});

	afterEach(() => {
		delete LIST_PRICE_ERAS[PRICED_MODEL];
	});

	it("returns all zeros and an empty breakdown for an empty aggregate list", () => {
		const result = valueWindowAggregates([], AT_MS);
		expect(result).toEqual({
			valueUsd: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			unpricedTokens: 0,
			modelBreakdown: {},
		});
	});

	it("prices a single known model and sums token/request totals", () => {
		const result = valueWindowAggregates(
			[
				agg({
					requestCount: 3,
					inputTokens: 1_000_000,
					cacheReadInputTokens: 500_000,
					cacheCreationInputTokens: 100_000,
					outputTokens: 200_000,
				}),
			],
			AT_MS,
		);
		// input: 1,000,000*2/1e6=2; cacheRead: 500,000*0.2/1e6=0.1;
		// cacheCreation: 100,000*4/1e6=0.4; output: 200,000*10/1e6=2
		// total = 4.5
		expect(result.valueUsd).toBeCloseTo(4.5, 10);
		expect(result.inputTokens).toBe(1_000_000);
		expect(result.cacheReadInputTokens).toBe(500_000);
		expect(result.cacheCreationInputTokens).toBe(100_000);
		expect(result.outputTokens).toBe(200_000);
		expect(result.requestCount).toBe(3);
		expect(result.unpricedTokens).toBe(0);
		expect(result.modelBreakdown[PRICED_MODEL]).toEqual({
			requestCount: 3,
			inputTokens: 1_000_000,
			cacheReadInputTokens: 500_000,
			cacheCreationInputTokens: 100_000,
			outputTokens: 200_000,
			valueUsd: 4.5,
		});
	});

	it("sends an unknown model's TOTAL tokens to unpricedTokens while still pricing other models", () => {
		const result = valueWindowAggregates(
			[
				agg({
					model: PRICED_MODEL,
					inputTokens: 1_000_000,
					outputTokens: 0,
				}),
				agg({
					model: UNKNOWN_MODEL,
					requestCount: 2,
					inputTokens: 300,
					cacheReadInputTokens: 20,
					cacheCreationInputTokens: 5,
					outputTokens: 75,
				}),
			],
			AT_MS,
		);
		// priced model: 1,000,000 * 2 / 1e6 = 2
		expect(result.valueUsd).toBeCloseTo(2, 10);
		// unpriced model total = 300+20+5+75 = 400
		expect(result.unpricedTokens).toBe(400);
		expect(result.modelBreakdown[UNKNOWN_MODEL]).toEqual({
			requestCount: 2,
			inputTokens: 300,
			cacheReadInputTokens: 20,
			cacheCreationInputTokens: 5,
			outputTokens: 75,
			valueUsd: null,
		});
		// Overall token sums still include the unpriced model's tokens.
		expect(result.inputTokens).toBe(1_000_300);
		expect(result.requestCount).toBe(3);
	});

	it("marks a model unpriced when atMs precedes its era floor, even though the model is known", () => {
		const beforeEraMs = ERA_SINCE_MS - 1;
		const result = valueWindowAggregates(
			[agg({ inputTokens: 1000 })],
			beforeEraMs,
		);
		expect(result.valueUsd).toBe(0);
		expect(result.unpricedTokens).toBe(1000);
		expect(result.modelBreakdown[PRICED_MODEL].valueUsd).toBeNull();
	});

	it("merges duplicate rows for the same model instead of clobbering the earlier entry", () => {
		const result = valueWindowAggregates(
			[
				agg({ requestCount: 1, inputTokens: 1_000_000 }),
				agg({ requestCount: 2, inputTokens: 500_000 }),
			],
			AT_MS,
		);
		expect(result.requestCount).toBe(3);
		expect(result.inputTokens).toBe(1_500_000);
		// 1,000,000*2/1e6=2, 500,000*2/1e6=1 -> merged 3
		expect(result.valueUsd).toBeCloseTo(3, 10);
		expect(result.modelBreakdown[PRICED_MODEL]).toEqual({
			requestCount: 3,
			inputTokens: 1_500_000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			valueUsd: 3,
		});
	});

	it("merges duplicate unpriced rows for the same model, accumulating unpricedTokens once per row", () => {
		const result = valueWindowAggregates(
			[
				agg({ model: UNKNOWN_MODEL, requestCount: 1, inputTokens: 100 }),
				agg({ model: UNKNOWN_MODEL, requestCount: 1, outputTokens: 50 }),
			],
			AT_MS,
		);
		expect(result.unpricedTokens).toBe(150);
		expect(result.modelBreakdown[UNKNOWN_MODEL]).toEqual({
			requestCount: 2,
			inputTokens: 100,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 50,
			valueUsd: null,
		});
	});

	it("real gpt-5.6-terra rates (2.0/0.2/12 per 1M) price a hand-computed total", () => {
		// input: 2,000,000 * 2.0 / 1e6 = 4
		// cache read: 1,000,000 * 0.2 / 1e6 = 0.2
		// output: 500,000 * 12.0 / 1e6 = 6
		// total = 10.2
		const result = valueWindowAggregates(
			[
				{
					model: "gpt-5.6-terra",
					requestCount: 5,
					inputTokens: 2_000_000,
					cacheReadInputTokens: 1_000_000,
					cacheCreationInputTokens: 0,
					outputTokens: 500_000,
				},
			],
			Date.parse("2026-08-15T00:00:00Z"),
		);
		expect(result.valueUsd).toBeCloseTo(10.2, 10);
		expect(result.unpricedTokens).toBe(0);
	});
});
