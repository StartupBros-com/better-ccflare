import { describe, expect, it } from "bun:test";
import type { TimePoint } from "@better-ccflare/types";
import { buildModelTimeSeries } from "./model-time-series";

const TS = new Date(2026, 0, 1, 10).getTime();

function point(model: string | undefined, ts = TS): TimePoint {
	return {
		ts,
		model,
		requests: 2,
		tokens: 3,
		costUsd: 4,
		planCostUsd: 0,
		apiCostUsd: 0,
		successRate: 100,
		errorRate: 0,
		cacheHitRate: 50,
		avgResponseTime: 10,
		avgTokensPerSecond: null,
	};
}

describe("buildModelTimeSeries", () => {
	it("invokes the projection once per included point in input order", () => {
		const points = [
			point("zeta", TS + 3_600_000),
			point(""),
			point(undefined),
			point("alpha"),
			point("alpha"),
		];
		const visited: TimePoint[] = [];
		const result = buildModelTimeSeries(points, "24h", (value) => {
			visited.push(value);
			return visited.length;
		});
		expect(visited).toEqual([points[0], points[3], points[4]]);
		expect(result.models).toEqual(["alpha", "zeta"]);
		expect(result.data.map(({ alpha, zeta }) => ({ alpha, zeta }))).toEqual([
			{ alpha: 3, zeta: 0 },
			{ alpha: 0, zeta: 1 },
		]);
	});

	it("does not project empty or unnamed input", () => {
		let calls = 0;
		const result = buildModelTimeSeries(
			[point(""), point(undefined)],
			"30d",
			() => {
				calls++;
				return 1;
			},
		);
		expect(result).toEqual({ data: [], models: [] });
		expect(calls).toBe(0);
	});

	it("preserves numeric projection values without coercion", () => {
		for (const value of [-1, -0, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = buildModelTimeSeries([point("alpha")], "24h", () => value);
			expect(Object.is(result.data[0].alpha, value)).toBe(true);
		}
	});

	it("does not mutate frozen inputs and returns fresh rows on each call", () => {
		const points = [Object.freeze(point("alpha"))];
		const first = buildModelTimeSeries(
			points,
			"24h",
			(value) => value.requests,
		);
		first.data[0].alpha = 100;
		first.models.push("other");
		const second = buildModelTimeSeries(
			points,
			"24h",
			(value) => value.requests,
		);
		expect(second.data[0].alpha).toBe(2);
		expect(second.models).toEqual(["alpha"]);
		expect(points[0].requests).toBe(2);
	});
});
