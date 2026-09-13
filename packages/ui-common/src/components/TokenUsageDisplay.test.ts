import { describe, expect, it } from "bun:test";
import { processTokenUsage } from "./TokenUsageDisplay";

describe("processTokenUsage request cost", () => {
	it("keeps an unloaded summary distinct from unknown cost", () => {
		expect(processTokenUsage(undefined)).toEqual({
			hasData: false,
			sections: {},
		});
	});

	for (const costUsd of [undefined, null]) {
		it(`shows unknown for a completed request with ${costUsd} cost`, () => {
			const usage = processTokenUsage({ inputTokens: 1, costUsd });
			expect(usage.sections.cost).toEqual({ label: "Cost", value: "Unknown" });
		});
	}

	it("displays recorded zero without claiming free upstream billing", () => {
		expect(
			processTokenUsage({ inputTokens: 1, costUsd: 0 }).sections.cost,
		).toEqual({
			label: "Cost",
			value: "$0.0000",
		});
	});

	it("preserves the existing positive-cost precision", () => {
		expect(
			processTokenUsage({ inputTokens: 1, costUsd: 1.23456 }).sections.cost,
		).toEqual({ label: "Cost", value: "$1.2346" });
	});

	for (const costUsd of [undefined, null, 0, 1.25]) {
		it(`does not finalize ${costUsd} cost while a request is pending`, () => {
			const usage = processTokenUsage({
				inputTokens: 1,
				costUsd,
				pending: true,
			});
			expect(usage.sections.cost).toBeUndefined();
			expect(usage.sections.inputTokens?.value).toBe("1");
		});
	}

	it("does not require nonzero tokens to display cost", () => {
		const usage = processTokenUsage({
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
		});
		expect(usage.hasData).toBe(true);
		expect(usage.sections.cost?.value).toBe("$0.0000");
	});

	it("shows missing cost even when token metrics were not recorded", () => {
		const usage = processTokenUsage({});
		expect(usage.hasData).toBe(true);
		expect(usage.sections.cost?.value).toBe("Unknown");
	});

	it("leaves an empty pending summary in its no-data state", () => {
		expect(processTokenUsage({ pending: true })).toEqual({
			hasData: false,
			sections: {},
		});
	});
});
