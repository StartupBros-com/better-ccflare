import { describe, expect, it, mock } from "bun:test";
import type { TimePoint } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimeRange } from "../../constants";

interface ModelSeries {
	data: Array<{ time: string; [key: string]: string | number }>;
	models: string[];
}

let captured: ModelSeries | undefined;
const EmptyChart = () => null;
mock.module("../charts", () => ({
	BaseAreaChart: EmptyChart,
	BaseBarChart: EmptyChart,
	BaseLineChart: EmptyChart,
	ModelPerformanceChart: EmptyChart,
	MultiModelChart: (props: ModelSeries) => {
		captured = props;
		return null;
	},
	RequestVolumeChart: EmptyChart,
	ResponseTimeChart: EmptyChart,
	TokenSpeedChart: EmptyChart,
	TokenUsageChart: EmptyChart,
}));

const { MainMetricsChart, PerformanceIndicatorsChart } = await import(
	"./AnalyticsCharts"
);

function point(overrides: Partial<TimePoint> = {}): TimePoint {
	return {
		ts: new Date(2026, 0, 1, 10, 0).getTime(),
		model: "alpha",
		requests: 2,
		tokens: 30,
		costUsd: 0.4,
		planCostUsd: 0.3,
		apiCostUsd: 0.1,
		successRate: 95,
		errorRate: 5,
		cacheHitRate: 60,
		avgResponseTime: 150,
		avgTokensPerSecond: 7,
		...overrides,
	};
}

function label(ts: number, range: TimeRange = "24h"): string {
	return range === "30d"
		? new Date(ts).toLocaleDateString()
		: new Date(ts).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
}

function renderSeries(
	points: TimePoint[] | undefined,
	metric: string,
	range: TimeRange = "24h",
	breakdown = true,
	cumulative = false,
): ModelSeries | undefined {
	captured = undefined;
	if (metric === "errorRate" || metric === "cacheHitRate") {
		renderToStaticMarkup(
			<PerformanceIndicatorsChart
				data={[]}
				rawTimeSeries={points}
				loading={false}
				modelBreakdown={breakdown}
				selectedMetric={metric}
				timeRange={range}
			/>,
		);
	} else {
		renderToStaticMarkup(
			<MainMetricsChart
				data={[]}
				rawTimeSeries={points}
				loading={false}
				viewMode={cumulative ? "cumulative" : "normal"}
				timeRange={range}
				selectedMetric={metric}
				setSelectedMetric={() => {}}
				modelBreakdown={breakdown}
			/>,
		);
	}
	return captured;
}

describe("analytics per-model series", () => {
	for (const [metric, value] of [
		["requests", 2],
		["tokens", 30],
		["cost", 0.4],
		["responseTime", 150],
		["tokensPerSecond", 7],
		["errorRate", 5],
		["cacheHitRate", 60],
		["unknown", 0],
	] as const) {
		it(`projects ${metric} without changing the source point`, () => {
			const input = Object.freeze(point());
			const result = renderSeries([input], metric);
			expect(result?.models).toEqual(["alpha"]);
			expect(result?.data).toEqual([{ time: label(input.ts), alpha: value }]);
		});
	}

	for (const metric of ["requests", "errorRate"]) {
		it(`${metric}: sorts, zero-fills, skips missing models and keeps last writes`, () => {
			const early = point().ts;
			const late = early + 3_600_000;
			const points = [
				point({ ts: late, model: "zeta", requests: 11, errorRate: 11 }),
				point({ ts: early, model: "beta", requests: 12, errorRate: 12 }),
				point({ ts: early, model: "alpha", requests: 13, errorRate: 13 }),
				point({ ts: early, model: "beta", requests: 14, errorRate: 14 }),
				point({ ts: early - 3_600_000, model: "" }),
				point({ ts: early - 7_200_000, model: undefined }),
			];
			const before = structuredClone(points);
			const result = renderSeries(points, metric);
			expect(result?.models).toEqual(["alpha", "beta", "zeta"]);
			expect(result?.data).toEqual([
				{ time: label(early), alpha: 13, beta: 14, zeta: 0 },
				{ time: label(late), alpha: 0, beta: 0, zeta: 11 },
			]);
			expect(points).toEqual(before);
		});

		it(`${metric}: preserves locale-label collisions and last timestamp ordering`, () => {
			const early = point().ts;
			const between = early + 3_600_000;
			const nextDay = early + 86_400_000;
			const result = renderSeries(
				[
					point({ ts: early, requests: 1, errorRate: 1 }),
					point({ ts: between, requests: 2, errorRate: 2 }),
					point({ ts: nextDay, requests: 3, errorRate: 3 }),
				],
				metric,
			);
			expect(result?.data).toEqual([
				{ time: label(between), alpha: 2 },
				{ time: label(nextDay), alpha: 3 },
			]);
		});

		it(`${metric}: retains date buckets for 30d and time buckets for 7d`, () => {
			const first = point();
			const later = point({
				ts: first.ts + 3_600_000,
				requests: 9,
				errorRate: 9,
			});
			expect(renderSeries([first, later], metric, "30d")?.data).toEqual([
				{ time: label(later.ts, "30d"), alpha: 9 },
			]);
			expect(renderSeries([first, later], metric, "7d")?.data).toHaveLength(2);
		});

		it(`${metric}: handles empty input and preserves disabled/absent gating`, () => {
			expect(renderSeries([], metric)?.data).toEqual([]);
			expect(renderSeries([], metric)?.models).toEqual([]);
			expect(renderSeries([point({ model: "" })], metric)?.data).toEqual([]);
			expect(renderSeries([point()], metric, "24h", false)).toBeUndefined();
			expect(renderSeries(undefined, metric)).toBeUndefined();
		});
	}

	it("preserves cumulative-mode bypass and changed metric values", () => {
		expect(
			renderSeries([point()], "requests", "24h", true, true),
		).toBeUndefined();
		expect(renderSeries([point()], "requests")?.data[0].alpha).toBe(2);
		expect(renderSeries([point()], "tokens")?.data[0].alpha).toBe(30);
	});

	it("retains the tokens/second falsy fallback", () => {
		for (const value of [null, 0, Number.NaN]) {
			expect(
				renderSeries([point({ avgTokensPerSecond: value })], "tokensPerSecond")
					?.data[0].alpha,
			).toBe(0);
		}
	});
});
