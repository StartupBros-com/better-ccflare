import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestCostBadge } from "./RequestCostBadge";

describe("RequestCostBadge", () => {
	it("does not imply a final cost while the summary is loading", () => {
		expect(renderToStaticMarkup(<RequestCostBadge summary={undefined} />)).toBe(
			"",
		);
	});

	for (const costUsd of [undefined, null]) {
		it(`labels a completed request with ${costUsd} cost as unknown`, () => {
			const html = renderToStaticMarkup(
				<RequestCostBadge summary={{ costUsd }} />,
			);
			expect(html).toContain("Cost unknown");
			expect(html).not.toContain("$0.0000");
		});
	}

	it("shows recorded zero instead of hiding it or labeling it free", () => {
		const html = renderToStaticMarkup(
			<RequestCostBadge summary={{ costUsd: 0 }} />,
		);
		expect(html).toContain("$0.0000");
		expect(html).not.toContain("Cost unknown");
		expect(html).not.toContain("Free");
		expect(html).toContain("may be an estimate");
	});

	it("preserves positive-cost formatting", () => {
		const html = renderToStaticMarkup(
			<RequestCostBadge summary={{ costUsd: 1.23456 }} className="text-xs" />,
		);
		expect(html).toContain("$1.2346");
		expect(html).toContain("text-xs");
	});

	for (const costUsd of [undefined, null, 0, 1.25]) {
		it(`hides ${costUsd} cost while the request is pending`, () => {
			expect(
				renderToStaticMarkup(
					<RequestCostBadge summary={{ costUsd }} pending />,
				),
			).toBe("");
		});
	}

	it("shows the final zero when the pending flag clears", () => {
		const summary = { costUsd: 0 };
		expect(
			renderToStaticMarkup(<RequestCostBadge summary={summary} pending />),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<RequestCostBadge summary={summary} pending={false} />,
			),
		).toContain("$0.0000");
	});
});
