import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CLAUDE_MODEL_IDS } from "./models";
import {
	LIST_PRICE_ERAS,
	type ListPriceEra,
	priceTokensAtListPrice,
	VALUE_PRICING_VERSION,
} from "./value-pricing";

// Synthetic two-era model used only to test era-selection boundaries in
// isolation from the real seed data (which, at seed time, has exactly one
// era per model — real multi-era boundary behavior can't be exercised
// against it yet).
const TEST_MODEL = "test-two-era-model";
const ERA1_SINCE_MS = Date.parse("2026-06-01T00:00:00Z");
const ERA2_SINCE_MS = Date.parse("2026-07-01T00:00:00Z");

const testEras: ListPriceEra[] = [
	{
		sinceMs: ERA1_SINCE_MS,
		inputPerM: 1,
		cacheReadPerM: 0.1,
		outputPerM: 5,
		// era1: no cacheCreationPerM — used to test the "missing rate with
		// tokens>0 must go loud, not silently underprice" requirement.
	},
	{
		sinceMs: ERA2_SINCE_MS,
		inputPerM: 2,
		cacheReadPerM: 0.2,
		cacheCreationPerM: 0.15,
		outputPerM: 10,
	},
];

describe("priceTokensAtListPrice", () => {
	it("advances VALUE_PRICING_VERSION for the Fable 5.1 price table", () => {
		expect(VALUE_PRICING_VERSION).toBe("2026-09-01.1");
	});

	describe("with a synthetic two-era model", () => {
		beforeEach(() => {
			LIST_PRICE_ERAS[TEST_MODEL] = testEras;
		});

		afterEach(() => {
			delete LIST_PRICE_ERAS[TEST_MODEL];
		});

		describe("era selection", () => {
			it("returns null for a timestamp before the first era", () => {
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS - 1, {
					inputTokens: 1_000_000,
				});
				expect(result).toBeNull();
			});

			it("selects era1 for a timestamp between era1 and era2", () => {
				const midpointMs = ERA1_SINCE_MS + (ERA2_SINCE_MS - ERA1_SINCE_MS) / 2;
				const result = priceTokensAtListPrice(TEST_MODEL, midpointMs, {
					inputTokens: 1_000_000,
				});
				// era1.inputPerM = 1 -> 1,000,000 * 1 / 1e6 = 1
				expect(result).toBe(1);
			});

			it("selects era1 exactly at era1.sinceMs (inclusive lower bound)", () => {
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS, {
					inputTokens: 1_000_000,
				});
				expect(result).toBe(1);
			});

			it("selects era2 for a timestamp at or after era2.sinceMs", () => {
				const result = priceTokensAtListPrice(TEST_MODEL, ERA2_SINCE_MS, {
					inputTokens: 1_000_000,
				});
				// era2.inputPerM = 2 -> 1,000,000 * 2 / 1e6 = 2
				expect(result).toBe(2);
			});

			it("selects era2 for a timestamp well after era2.sinceMs", () => {
				const result = priceTokensAtListPrice(
					TEST_MODEL,
					ERA2_SINCE_MS + 1_000 * 60 * 60 * 24 * 365,
					{ inputTokens: 1_000_000 },
				);
				expect(result).toBe(2);
			});
		});

		describe("exact arithmetic", () => {
			it("computes the exact hand-computed total including the cache-read discount", () => {
				// era1: inputPerM=1, cacheReadPerM=0.1, outputPerM=5
				// input:      1,000,000 * 1  / 1e6 = 1
				// cache read:   500,000 * 0.1/ 1e6 = 0.05  (10x cheaper than input)
				// output:       200,000 * 5  / 1e6 = 1
				// total = 2.05
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS, {
					inputTokens: 1_000_000,
					cacheReadInputTokens: 500_000,
					outputTokens: 200_000,
				});
				expect(result).toBe(2.05);
			});

			it("returns 0 (not null) for a known model/era with no tokens supplied", () => {
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS, {});
				expect(result).toBe(0);
			});
		});

		describe("cache creation handling", () => {
			it("counts cache-creation tokens when the era has a cacheCreationPerM rate", () => {
				// era2: inputPerM=2, cacheCreationPerM=0.15
				// input:          1,000,000 * 2    / 1e6 = 2
				// cache creation:   100,000 * 0.15 / 1e6 = 0.015
				// total = 2.015
				const result = priceTokensAtListPrice(TEST_MODEL, ERA2_SINCE_MS, {
					inputTokens: 1_000_000,
					cacheCreationInputTokens: 100_000,
				});
				expect(result).toBeCloseTo(2.015, 10);
			});

			it("returns null (loud) when cacheCreationInputTokens>0 but the era has no cacheCreationPerM rate", () => {
				// era1 has no cacheCreationPerM. A silent omission would produce a
				// price that quietly excludes real spend — this must go loud instead.
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS, {
					inputTokens: 1_000_000,
					cacheCreationInputTokens: 50_000,
				});
				expect(result).toBeNull();
			});

			it("does not go loud when cacheCreationInputTokens is 0 even without a rate", () => {
				const result = priceTokensAtListPrice(TEST_MODEL, ERA1_SINCE_MS, {
					inputTokens: 1_000_000,
					cacheCreationInputTokens: 0,
				});
				expect(result).toBe(1);
			});
		});
	});

	describe("unknown model / unknown era", () => {
		it("returns null for a model with no era table at all", () => {
			const result = priceTokensAtListPrice(
				"totally-unknown-model-xyz",
				Date.now(),
				{ inputTokens: 100 },
			);
			expect(result).toBeNull();
		});

		it("returns null for a real seeded model queried before its era floor", () => {
			const beforeFloorMs = Date.parse("2026-05-31T23:59:59Z");
			const result = priceTokensAtListPrice(
				CLAUDE_MODEL_IDS.SONNET_5,
				beforeFloorMs,
				{ inputTokens: 100 },
			);
			expect(result).toBeNull();
		});
	});

	describe("seeded rate table", () => {
		const AFTER_FLOOR_MS = Date.parse("2026-06-15T00:00:00Z");

		it("prices gpt-5.6-terra using the models.dev 'openai' section rates", () => {
			// 2.0 / 0.2 (cache read) / 12.0 $/M per spec, verified against
			// /tmp/better-ccflare/models.dev.json's 'openai' provider section.
			const result = priceTokensAtListPrice("gpt-5.6-terra", AFTER_FLOOR_MS, {
				inputTokens: 1_000_000,
				cacheReadInputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});
			expect(result).toBeCloseTo(2.0 + 0.2 + 12.0, 10);
		});

		it("prices gpt-5.6-luna using the models.dev 'openai' section rates", () => {
			const result = priceTokensAtListPrice("gpt-5.6-luna", AFTER_FLOOR_MS, {
				inputTokens: 1_000_000,
				cacheReadInputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});
			expect(result).toBeCloseTo(0.2 + 0.02 + 1.2, 10);
		});

		it("prices gpt-5.6-sol using the pre-2026-08-21-drop rate as the single current era", () => {
			const result = priceTokensAtListPrice("gpt-5.6-sol", AFTER_FLOOR_MS, {
				inputTokens: 1_000_000,
				cacheReadInputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});
			expect(result).toBeCloseTo(5.0 + 0.5 + 30.0, 10);
		});

		it("returns null for gpt-5.6-terra when cache-creation tokens are supplied (no rate seeded for OpenAI models)", () => {
			const result = priceTokensAtListPrice("gpt-5.6-terra", AFTER_FLOOR_MS, {
				inputTokens: 1_000_000,
				cacheCreationInputTokens: 1,
			});
			expect(result).toBeNull();
		});

		it("prices an Anthropic model including its cache-creation rate", () => {
			// claude-sonnet-5, from BUNDLED_PRICING in pricing.ts: input 3,
			// output 15, cache_read 0.3, cache_write 3.75 ($/M).
			const result = priceTokensAtListPrice(
				CLAUDE_MODEL_IDS.SONNET_5,
				AFTER_FLOOR_MS,
				{
					inputTokens: 1_000_000,
					cacheReadInputTokens: 1_000_000,
					cacheCreationInputTokens: 1_000_000,
					outputTokens: 1_000_000,
				},
			);
			expect(result).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
		});

		it("estimates Fable 5.1 aggregate cache creation at its published 5-minute write rate", () => {
			const result = priceTokensAtListPrice(
				CLAUDE_MODEL_IDS.FABLE_5_1,
				AFTER_FLOOR_MS,
				{
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
					cacheReadInputTokens: 1_000_000,
					cacheCreationInputTokens: 1_000_000,
				},
			);
			expect(result).toBeCloseTo(10 + 50 + 0.25 + 12.5, 10);
		});
	});
});
