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
		capacityMode: "off",
		capacitySource: "default",
		onCapacityChange: () => {},
		capacityDisabled: false,
		...overrides,
	};
	return renderToStaticMarkup(<RoutingCardView {...props} />);
}

describe("RoutingCardView", () => {
	it("renders both the strategy selector and the capacity switch", () => {
		const html = render();
		expect(html).toContain('role="combobox"');
		expect(html).toContain("Load-balancing strategy");
		expect(html).toContain('role="switch"');
		expect(html).toContain("Model-scoped capacity routing");
	});

	it("describes both drain-soonest modes honestly", () => {
		const html = render();
		expect(html).toContain("never preempted");
		expect(html).toContain("within each authorized routing class");
		expect(html).toContain("only breaks ties");
		expect(html).toContain("explicit owner-retention");
		expect(html).toContain("Only session-class strategies are shown");
	});

	it("reflects the exhausted capacity mode as a checked switch", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).toContain('aria-checked="true"');
	});

	it("describes the conditional model-pool exhaustion terminal", () => {
		const html = render({ capacityMode: "exhausted" });
		expect(html).toContain("per-model accounts are skipped");
		expect(html).toContain(
			"remaining eligible accounts can still handle the request",
		);
		expect(html).toContain(
			"only if capacity filtering leaves no eligible account",
		);
		expect(html).toContain("model_pool_exhausted");
		expect(html).toContain("503");
		expect(html).not.toContain("model_family_exhausted");
	});

	it("reflects the off capacity mode as an unchecked switch", () => {
		const html = render({ capacityMode: "off", capacitySource: "file" });
		expect(html).toContain('aria-checked="false"');
	});

	it("locks the switch and shows an env-locked badge when the source is env", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "env" });
		expect(html).toContain("env-locked");
		expect(html).toContain("data-disabled");
		expect(html).toContain("MODEL_SCOPED_CAPACITY_ROUTING");
	});

	it("locks the switch off when the environment does", () => {
		const html = render({ capacityMode: "off", capacitySource: "env" });
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain("data-disabled");
		expect(html).toContain("env-locked");
	});

	it("leaves the switch enabled and hides the badge for the file source", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the switch enabled and hides the badge for the default source", () => {
		const html = render({
			capacityMode: "exhausted",
			capacitySource: "default",
		});
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("locks the strategy select and shows an env-locked badge when strategySource is env", () => {
		const html = render({ strategy: "session", strategySource: "env" });
		expect(html).toContain("env-locked");
		expect(html).toContain("data-disabled");
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

	it("associates labels with their controls", () => {
		const html = render();
		expect(html).toContain('for="routing-strategy"');
		expect(html).toContain('id="routing-strategy"');
		expect(html).toContain('for="routing-capacity"');
		expect(html).toContain('id="routing-capacity"');
	});

	it("does not throw when the effective strategy is not listed", () => {
		const html = render({ strategy: "least-used" });
		expect(html).toContain('role="combobox"');
	});
});

describe("getStrategySelectItems", () => {
	const listed: readonly StrategySelectItem[] = [
		{ label: "Session", value: "session" },
		{ label: "Session — drain soonest", value: "session-drain-soonest" },
		{
			label: "Session — drain soonest (strict)",
			value: "session-drain-soonest-strict",
		},
	];

	it("returns only the three listed options when the current strategy is listed", () => {
		expect(getStrategySelectItems("session")).toEqual(listed);
		expect(getStrategySelectItems("session-drain-soonest")).toEqual(listed);
		expect(getStrategySelectItems("session-drain-soonest-strict")).toEqual(
			listed,
		);
	});

	it("appends the current strategy as a disabled item when it is not listed", () => {
		expect(getStrategySelectItems("least-used")).toEqual([
			...listed,
			{ label: "least-used (current)", value: "least-used", disabled: true },
		]);
	});

	it("appends session-affinity as a disabled current item", () => {
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
