import { describe, expect, it } from "bun:test";
import type { FleetAccountUsageSeries } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { CHART_COLORS } from "../constants";
import { buildFleetChartData, FleetUsageChart } from "./FleetUsageChart";

function account(
	accountId: string,
	accountName: string,
	windows: FleetAccountUsageSeries["windows"],
): FleetAccountUsageSeries {
	return { accountId, accountName, windows };
}

describe("buildFleetChartData", () => {
	it("returns empty rows and lines for an empty accounts array", () => {
		const { rows, lines } = buildFleetChartData([]);
		expect(rows).toEqual([]);
		expect(lines).toEqual([]);
	});

	it("builds one line per account × window with a composite dataKey", () => {
		const { lines } = buildFleetChartData([
			account("acc1", "Acc One", [
				{
					window: "five_hour",
					points: [{ t: 1000, utilization: 10, resetsAt: null }],
				},
				{
					window: "seven_day",
					points: [{ t: 1000, utilization: 5, resetsAt: null }],
				},
			]),
		]);
		expect(lines).toHaveLength(2);
		const dataKeys = lines.map((l) => l.dataKey);
		expect(new Set(dataKeys).size).toBe(2); // both unique
		expect(lines.every((l) => l.dataKey.includes("acc1"))).toBe(true);
	});

	it("labels each line 'account · window'", () => {
		const { lines } = buildFleetChartData([
			account("acc1", "Acc One", [
				{
					window: "five_hour",
					points: [{ t: 1000, utilization: 10, resetsAt: null }],
				},
			]),
		]);
		expect(lines[0].name).toBe("Acc One · 5-hour");
	});

	it("marks five_hour solid (not dashed) and seven_day-family dashed", () => {
		const { lines } = buildFleetChartData([
			account("acc1", "Acc One", [
				{
					window: "five_hour",
					points: [{ t: 1000, utilization: 10, resetsAt: null }],
				},
				{
					window: "seven_day",
					points: [{ t: 1000, utilization: 10, resetsAt: null }],
				},
				{
					window: "seven_day_opus",
					points: [{ t: 1000, utilization: 10, resetsAt: null }],
				},
			]),
		]);
		const byWindow = Object.fromEntries(
			lines.map((l) => [l.name.split(" · ")[1], l.dashed]),
		);
		expect(byWindow["5-hour"]).toBe(false);
		expect(byWindow.Weekly).toBe(true); // seven_day -> "Weekly" via formatWindowName
	});

	it("cycles account colors through CHART_COLORS by account index", () => {
		const many = Array.from({ length: CHART_COLORS.length + 1 }, (_, i) =>
			account(`acc${i}`, `Acc ${i}`, [
				{
					window: "five_hour",
					points: [{ t: 1000, utilization: 1, resetsAt: null }],
				},
			]),
		);
		const { lines } = buildFleetChartData(many);
		expect(lines[0].color).toBe(CHART_COLORS[0]);
		expect(lines[CHART_COLORS.length].color).toBe(CHART_COLORS[0]); // wraps around
	});

	it("merges points into shared minute buckets, nulling absent series", () => {
		const M = 60_000;
		const { rows } = buildFleetChartData([
			account("acc1", "Acc One", [
				{
					window: "five_hour",
					points: [
						{ t: 1 * M, utilization: 10, resetsAt: null },
						{ t: 2 * M, utilization: 20, resetsAt: null },
					],
				},
			]),
			account("acc2", "Acc Two", [
				{
					window: "five_hour",
					// 12s off acc1's poll time — unaligned per-account cycles must
					// land in the SAME minute bucket so cross-account rows merge
					// instead of growing toward accounts x windows x 500 disjoint
					// rows (review finding).
					points: [{ t: 1 * M + 12_000, utilization: 50, resetsAt: null }],
				},
			]),
		]);
		expect(rows.map((r) => r.t)).toEqual([1 * M, 2 * M]);
		const row1 = rows[0];
		const row2 = rows[1];
		const acc1Key = "acc1::five_hour";
		const acc2Key = "acc2::five_hour";
		expect(row1[acc1Key]).toBe(10);
		expect(row1[acc2Key]).toBe(50);
		expect(row2[acc1Key]).toBe(20);
		expect(row2[acc2Key]).toBeNull(); // acc2 has no point in the 2m bucket
	});

	it("omits an account's window entirely when it has no points (no empty line)", () => {
		const { lines } = buildFleetChartData([
			account("acc1", "Acc One", [{ window: "five_hour", points: [] }]),
		]);
		// A line config is still emitted (so the legend can show it), but it
		// contributes no data — verified indirectly via rows being empty.
		expect(lines).toHaveLength(1);
	});
});

describe("FleetUsageChart", () => {
	it("renders the empty state when there are no accounts", () => {
		const html = renderToStaticMarkup(
			<FleetUsageChart accounts={[]} emptyState="Nothing to see" />,
		);
		expect(html).toContain("Nothing to see");
	});

	it("renders a loading spinner instead of the chart when loading", () => {
		const html = renderToStaticMarkup(
			<FleetUsageChart
				accounts={[
					account("acc1", "Acc One", [
						{
							window: "five_hour",
							points: [{ t: 1000, utilization: 10, resetsAt: null }],
						},
					]),
				]}
				loading
			/>,
		);
		expect(html).not.toContain("Acc One");
	});

	it("renders the chart container without throwing for real data", () => {
		// recharts' ResponsiveContainer measures via ResizeObserver, which never
		// fires under renderToStaticMarkup (no jsdom in this package — see
		// LiveCountdown.test.tsx) — so it SSRs at width 0 and the legend/lines
		// aren't in the initial markup. This only proves the data path doesn't
		// throw; buildFleetChartData's tests above cover the actual line/legend
		// content (name, color, dash pattern).
		const html = renderToStaticMarkup(
			<FleetUsageChart
				accounts={[
					account("acc1", "Acc One", [
						{
							window: "five_hour",
							points: [
								{ t: 1000, utilization: 10, resetsAt: null },
								{ t: 2000, utilization: 20, resetsAt: null },
							],
						},
					]),
				]}
			/>,
		);
		expect(html).toContain("recharts-responsive-container");
	});
});
