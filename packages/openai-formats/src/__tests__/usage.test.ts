import { describe, expect, it } from "bun:test";
import { normalizeOpenAIInputUsage } from "../usage";

describe("normalizeOpenAIInputUsage", () => {
	it.each([
		["missing", undefined],
		["negative", -1],
		["non-finite", Number.NaN],
	])("keeps cache telemetry unknown when the inclusive total is %s", (_label, totalInputTokens) => {
		const result = normalizeOpenAIInputUsage(totalInputTokens, 12, 3);

		expect(result).toEqual({
			totalInputTokens: 0,
			inputTokens: 0,
		});
	});

	it("preserves explicit zero cache telemetry with a valid inclusive total", () => {
		expect(normalizeOpenAIInputUsage(20, 0, 0)).toEqual({
			totalInputTokens: 20,
			inputTokens: 20,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});
});
