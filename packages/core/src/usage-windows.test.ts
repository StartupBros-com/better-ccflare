import { describe, expect, it } from "bun:test";
import { normalizeProviderUsageWindows } from "./usage-windows";

describe("normalizeProviderUsageWindows", () => {
	const reset = "2026-08-12T12:00:00.000Z";
	const resetMs = Date.parse(reset);

	it("normalizes Anthropic flat and limits windows without duplicate keys", () => {
		expect(
			normalizeProviderUsageWindows(
				{
					five_hour: { utilization: 25, resets_at: reset },
					seven_day_opus: { utilization: 40, resets_at: reset },
					limits: [
						{ kind: "session", percent: 99, resets_at: reset },
						{
							kind: "weekly_scoped",
							percent: 60,
							resets_at: reset,
							scope: { model: { display_name: "Opus" } },
						},
						{
							kind: "weekly_scoped",
							percent: 70,
							resets_at: reset,
							scope: { model: { display_name: "Sonnet" } },
						},
					],
				},
				"anthropic",
			),
		).toEqual([
			{
				windowKey: "five_hour",
				utilization: 25,
				resetsAtMs: resetMs,
				scope: "account",
				modelFamily: null,
				active: true,
			},
			{
				windowKey: "seven_day_opus",
				utilization: 40,
				resetsAtMs: resetMs,
				scope: "family",
				modelFamily: "opus",
				active: true,
			},
			{
				windowKey: "seven_day_sonnet",
				utilization: 70,
				resetsAtMs: resetMs,
				scope: "family",
				modelFamily: "sonnet",
				active: true,
			},
		]);
	});

	it("normalizes every non-Anthropic provider shape", () => {
		const fixtures: Array<[string, unknown, string[]]> = [
			[
				"nanogpt",
				{
					active: true,
					daily: { percentUsed: 0.25, resetAt: resetMs },
					monthly: { percentUsed: 0.5, resetAt: resetMs },
				},
				["daily", "monthly"],
			],
			[
				"alibaba-coding-plan",
				{
					five_hour: { percentUsed: 25, resetAt: resetMs },
					weekly: { percentUsed: 50, resetAt: resetMs },
					monthly: { percentUsed: 75, resetAt: resetMs },
				},
				["five_hour", "weekly", "monthly"],
			],
			["kilo", { utilizationPercent: 33 }, ["credits"]],
			[
				"zai",
				{
					tokens_limit: { percentage: 40, resetAt: resetMs },
					time_limit: { percentage: 20, resetAt: resetMs },
				},
				["five_hour", "time_limit"],
			],
			[
				"minimax",
				{
					five_hour: { utilization: 10, resetAt: resetMs },
					seven_day: { utilization: 20, resetAt: resetMs },
				},
				["five_hour", "seven_day"],
			],
			["xai", { credits: { utilization: 55, resets_at: reset } }, ["credits"]],
		];
		for (const [provider, data, keys] of fixtures) {
			expect(
				normalizeProviderUsageWindows(data, provider).map((w) => w.windowKey),
			).toEqual(keys);
		}
	});

	it("skips malformed values and preserves Kilo history without a reset", () => {
		expect(
			normalizeProviderUsageWindows(
				{
					five_hour: { utilization: Number.NaN, resets_at: reset },
					seven_day: { utilization: 101, resets_at: reset },
					credits: { utilization: 20, resets_at: "bad" },
				},
				"anthropic",
			),
		).toEqual([]);
		expect(
			normalizeProviderUsageWindows({ utilizationPercent: 20 }, "kilo")[0],
		).toMatchObject({
			windowKey: "credits",
			resetsAtMs: null,
		});
	});
});
