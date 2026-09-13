import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestSummary } from "../api";
import { TokenUsageDisplay } from "./TokenUsageDisplay";

// Deliberately omit totalTokens: cost must not depend on a recorded total.
function summary(costUsd?: number): RequestSummary {
	return { id: "cost-fixture", inputTokens: 1, costUsd } as RequestSummary;
}

describe("TokenUsageDisplay cost presentation", () => {
	it("keeps the unloaded state free of a final cost label", () => {
		const html = renderToStaticMarkup(
			<TokenUsageDisplay summary={undefined} />,
		);
		expect(html).toContain("No token usage data available");
		expect(html).not.toContain("Cost:");
	});

	it("shows unknown cost without requiring totalTokens", () => {
		const html = renderToStaticMarkup(
			<TokenUsageDisplay summary={summary()} />,
		);
		expect(html).toContain("Cost: Unknown");
		expect(html).not.toContain("$0.0000");
	});

	it("shows recorded zero without requiring totalTokens", () => {
		const html = renderToStaticMarkup(
			<TokenUsageDisplay summary={summary(0)} />,
		);
		expect(html).toContain("Cost: $0.0000");
		expect(html).toContain("may be an estimate");
	});

	it("preserves positive-cost formatting", () => {
		const html = renderToStaticMarkup(
			<TokenUsageDisplay summary={summary(1.23456)} />,
		);
		expect(html).toContain("Cost: $1.2346");
	});

	for (const costUsd of [undefined, 0, 1.25]) {
		it(`does not finalize ${costUsd} cost while pending`, () => {
			const html = renderToStaticMarkup(
				<TokenUsageDisplay summary={summary(costUsd)} pending />,
			);
			expect(html).toContain("Input Tokens");
			expect(html).not.toContain("Cost:");
		});
	}
});
