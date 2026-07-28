/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	getStrategySelectItems,
	RoutingCardView,
	type RoutingCardViewProps,
	type StrategySelectItem,
} from "./RoutingCard";

function render(overrides: Partial<RoutingCardViewProps> = {}): string {
	const props: RoutingCardViewProps = {
		strategy: "session",
		onStrategyChange: () => {},
		strategyDisabled: false,
		strategySource: "default",
		...overrides,
	};
	return renderToStaticMarkup(<RoutingCardView {...props} />);
}

describe("RoutingCardView", () => {
	it("renders the strategy selector and the capacity routing note", () => {
		const html = render();
		// The strategy Select renders as a Radix combobox trigger.
		expect(html).toContain('role="combobox"');
		expect(html).toContain("Load-balancing strategy");
		// Capacity routing is always on in this fork, so it is described rather
		// than offered as a switch — there is no toggle endpoint behind it.
		expect(html).not.toContain('role="switch"');
		expect(html).toContain("Model-scoped capacity routing");
		expect(html).toContain("Always on");
	});

	it("explains the session strategy in the strategy description", () => {
		const html = render();
		expect(html).toContain("keeps each client on");
		// The safety note about not offering per-request spreading strategies.
		expect(html).toContain("Only session-class strategies are shown");
	});

	it("locks the strategy select and shows an env-locked badge when strategySource is env", () => {
		const html = render({ strategy: "session", strategySource: "env" });
		expect(html).toContain("env-locked");
		// Radix marks a disabled trigger with data-disabled; nothing else on the
		// card is disable-able, so this uniquely proves the select is disabled.
		expect(html).toContain("data-disabled");
		// Badge tooltip points the user at the overriding env var.
		expect(html).toContain("LB_STRATEGY");
	});

	it("leaves the strategy select enabled and hides its badge for the file source", () => {
		const html = render({ strategy: "session", strategySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the strategy select enabled and hides its badge for the default source", () => {
		const html = render({ strategy: "session", strategySource: "default" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("associates the strategy label with its Select trigger via htmlFor/id", () => {
		const html = render();
		expect(html).toContain('for="routing-strategy"');
		expect(html).toContain('id="routing-strategy"');
	});

	it("does not throw when the effective strategy is not one of the listed options", () => {
		// least-used/session-affinity are valid StrategyName values that are
		// deliberately not offered (see STRATEGY_OPTIONS), but the server can
		// still report them as the effective strategy (env/config/older
		// default). The view must render without error in that case.
		const html = render({ strategy: "least-used" });
		expect(html).toContain('role="combobox"');
	});
});

describe("getStrategySelectItems", () => {
	const listed: readonly StrategySelectItem[] = [
		{ label: "Session", value: "session" },
	];

	it("returns only the listed options when the current strategy is one of them", () => {
		expect(getStrategySelectItems("session")).toEqual(listed);
	});

	it("appends the current strategy as a disabled item when it is not listed", () => {
		expect(getStrategySelectItems("least-used")).toEqual([
			...listed,
			{ label: "least-used (current)", value: "least-used", disabled: true },
		]);
	});

	it("appends session-affinity as a disabled item when it is the current strategy", () => {
		expect(getStrategySelectItems("session-affinity")).toEqual([
			...listed,
			{
				label: "session-affinity (current)",
				value: "session-affinity",
				disabled: true,
			},
		]);
	});
});
