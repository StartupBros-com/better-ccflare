import { describe, expect, it } from "bun:test";
import type {
	UsageHistoryWindowSeries,
	UsagePrediction,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageInsightCards } from "./UsageInsightCards";

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = 100 * H; // fixed reference — no Date.now() anywhere in this file

function basePrediction(
	overrides: Partial<UsagePrediction> = {},
): UsagePrediction {
	return {
		slopePerHour: 0,
		etaExhaustMs: null,
		predictedAtReset: null,
		resetsAtMs: null,
		willExhaustBeforeReset: false,
		state: "stable",
		lowConfidence: false,
		...overrides,
	};
}

function series(
	window: string,
	prediction: UsagePrediction,
	points: UsageHistoryWindowSeries["points"] = [
		{ t: NOW, utilization: 50, resetsAt: prediction.resetsAtMs },
	],
): UsageHistoryWindowSeries {
	return { window, points, prediction };
}

function render(windows: UsageHistoryWindowSeries[], now = NOW): string {
	return renderToStaticMarkup(
		<UsageInsightCards windows={windows} now={now} />,
	);
}

describe("UsageInsightCards", () => {
	it("renders nothing when no window has any points", () => {
		const html = render([series("five_hour", basePrediction(), [])]);
		expect(html).toBe("");
	});

	it("skips windows with no points but renders windows that have data", () => {
		const html = render([
			series("five_hour", basePrediction(), []),
			series("seven_day", basePrediction({ resetsAtMs: NOW + 5 * H })),
		]);
		expect(html).toContain("Weekly pace");
		// five_hour was empty — its own card (labeled "5-hour") must not appear.
		expect(html).not.toContain("5-hour");
	});

	it("shows a signed burn rate for a rising window", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({ slopePerHour: 3.2, state: "rising" }),
			),
		]);
		expect(html).toContain("+3.2%/hr");
	});

	it("shows a negative burn rate without a double sign", () => {
		const html = render([
			series("five_hour", basePrediction({ slopePerHour: -1.4 })),
		]);
		expect(html).toContain("-1.4%/hr");
		expect(html).not.toContain("+-1.4%/hr");
	});

	it("shows an em-dash and 'insufficient data' for insufficient_data state", () => {
		const html = render([
			series("five_hour", basePrediction({ state: "insufficient_data" })),
		]);
		expect(html).toContain("insufficient data");
		expect(html).toContain("—");
		expect(html).not.toContain("%/hr");
	});

	it("shows an em-dash and 'insufficient data' when lowConfidence is set", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({
					state: "rising",
					slopePerHour: 8,
					lowConfidence: true,
				}),
			),
		]);
		expect(html).toContain("insufficient data");
		expect(html).not.toContain("%/hr");
	});

	it("formats exhausts-vs-reset and marks it destructive when exhausting first", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({
					state: "rising",
					slopePerHour: 10,
					etaExhaustMs: NOW + 3 * H + 12 * MIN,
					resetsAtMs: NOW + 5 * H,
					willExhaustBeforeReset: true,
				}),
			),
		]);
		expect(html).toContain("exhausts in 3h 12m");
		expect(html).toContain("resets in 5h 0m");
		expect(html).toContain("text-destructive");
	});

	it("uses muted styling and 'not exhausting' when safe until reset", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({
					state: "stable",
					slopePerHour: 0.5,
					resetsAtMs: NOW + 5 * H,
					willExhaustBeforeReset: false,
				}),
			),
		]);
		expect(html).toContain("not exhausting");
		expect(html).toContain("resets in 5h 0m");
		expect(html).not.toContain("text-destructive");
	});

	it("shows 'exhausts now' and destructive styling for an exhausted window", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({
					state: "exhausted",
					etaExhaustMs: NOW,
					resetsAtMs: NOW + 5 * H,
					willExhaustBeforeReset: true,
				}),
			),
		]);
		expect(html).toContain("exhausts now");
		expect(html).toContain("text-destructive");
	});

	it("renders 'no reset known' when the window has no active reset", () => {
		const html = render([
			series(
				"five_hour",
				basePrediction({
					state: "rising",
					slopePerHour: 5,
					etaExhaustMs: NOW + 2 * H,
					resetsAtMs: null,
					willExhaustBeforeReset: false,
				}),
			),
		]);
		expect(html).toContain("no reset known");
	});

	it("only shows weekly pace for the seven_day window, not five_hour or weekly model tiers", () => {
		const resetsAtMs = NOW + 5 * H;
		const html = render([
			series("five_hour", basePrediction({ resetsAtMs })),
			series("seven_day_opus", basePrediction({ resetsAtMs })),
			series("seven_day_sonnet", basePrediction({ resetsAtMs })),
		]);
		expect(html).not.toContain("Weekly pace");
	});

	it("omits weekly pace when the seven_day window has no known reset", () => {
		const html = render([
			series("seven_day", basePrediction({ resetsAtMs: null })),
		]);
		expect(html).not.toContain("Weekly pace");
	});

	it("labels an over-pace seven_day window with warning styling", () => {
		// Window: NOW-3.5d..NOW+3.5d (halfway -> 50% expected). Actual 70% -> +20pp.
		const resetsAtMs = NOW + 3.5 * 24 * H;
		const html = render([
			series("seven_day", basePrediction({ resetsAtMs }), [
				{ t: NOW, utilization: 70, resetsAt: resetsAtMs },
			]),
		]);
		expect(html).toContain("over pace");
		expect(html).toContain("+20.0pp");
		expect(html).toContain("text-warning");
	});

	it("labels an in-reserve seven_day window with success styling", () => {
		const resetsAtMs = NOW + 3.5 * 24 * H;
		const html = render([
			series("seven_day", basePrediction({ resetsAtMs }), [
				{ t: NOW, utilization: 30, resetsAt: resetsAtMs },
			]),
		]);
		expect(html).toContain("in reserve");
		expect(html).toContain("-20.0pp");
		expect(html).toContain("text-success");
	});

	it("labels an on-pace seven_day window as muted, within the 2pp band", () => {
		const resetsAtMs = NOW + 3.5 * 24 * H;
		const html = render([
			series("seven_day", basePrediction({ resetsAtMs }), [
				{ t: NOW, utilization: 51, resetsAt: resetsAtMs },
			]),
		]);
		expect(html).toContain("on pace");
		expect(html).not.toContain("text-warning");
		expect(html).not.toContain("text-success");
	});
});
