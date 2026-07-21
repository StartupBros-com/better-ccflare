import { describe, expect, test } from "bun:test";
import {
	normalizeCodexCacheWriteTokens,
	normalizeCodexResponseInputUsage,
} from "./usage";

describe("normalizeCodexCacheWriteTokens", () => {
	test("reads the current OpenAI cache_write_tokens field", () => {
		expect(
			normalizeCodexCacheWriteTokens({
				cache_write_tokens: 123,
			}),
		).toBe(123);
	});

	test("preserves the legacy cache_creation_input_tokens alias", () => {
		expect(
			normalizeCodexCacheWriteTokens({
				cache_creation_input_tokens: 45,
			}),
		).toBe(45);
	});

	test("prefers a valid current field and safely falls back to the legacy alias", () => {
		expect(
			normalizeCodexCacheWriteTokens({
				cache_write_tokens: 0,
				cache_creation_input_tokens: 99,
			}),
		).toBe(0);
		expect(
			normalizeCodexCacheWriteTokens({
				cache_write_tokens: Number.NaN,
				cache_creation_input_tokens: 17,
			}),
		).toBe(17);
		expect(normalizeCodexCacheWriteTokens(null)).toBe(0);
	});
});

describe("normalizeCodexResponseInputUsage", () => {
	test("partitions an inclusive total across uncached, read, and written tokens", () => {
		const usage = normalizeCodexResponseInputUsage(42, {
			cached_tokens: 5,
			cache_write_tokens: 11,
			cache_creation_input_tokens: 99,
		});

		expect(usage).toEqual({
			totalInputTokens: 42,
			inputTokens: 26,
			cacheReadInputTokens: 5,
			cacheCreationInputTokens: 11,
		});
		expect(
			usage.inputTokens +
				usage.cacheReadInputTokens +
				usage.cacheCreationInputTokens,
		).toBe(usage.totalInputTokens);
	});

	test.each([
		[
			"oversized reads consume the total before writes",
			42,
			{ cached_tokens: 50, cache_write_tokens: 11 },
			{ input: 0, read: 42, write: 0 },
		],
		[
			"oversized writes clamp to the post-read remainder",
			42,
			{ cached_tokens: 5, cache_write_tokens: 99 },
			{ input: 0, read: 5, write: 37 },
		],
		[
			"invalid current values fall back to a valid legacy write count",
			42,
			{
				cached_tokens: Number.NaN,
				cache_write_tokens: Number.NaN,
				cache_creation_input_tokens: 17,
			},
			{ input: 25, read: 0, write: 17 },
		],
		[
			"invalid totals safely collapse every additive component",
			Number.POSITIVE_INFINITY,
			{ cached_tokens: 5, cache_write_tokens: 11 },
			{ input: 0, read: 0, write: 0 },
		],
	] as const)("%s", (_name, total, details, expected) => {
		const usage = normalizeCodexResponseInputUsage(total, details);
		expect(usage.inputTokens).toBe(expected.input);
		expect(usage.cacheReadInputTokens).toBe(expected.read);
		expect(usage.cacheCreationInputTokens).toBe(expected.write);
		expect(
			usage.inputTokens +
				usage.cacheReadInputTokens +
				usage.cacheCreationInputTokens,
		).toBe(usage.totalInputTokens);
	});
});
