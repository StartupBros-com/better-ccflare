import { describe, expect, it } from "bun:test";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
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

	// Assert whole windows, not just their keys: the scaling rules differ per
	// provider and a key-only assertion would still pass if a provider's
	// percentage were scaled twice, or not at all.
	function windowShape(
		windowKey: string,
		utilization: number,
		resetsAtMs: number | null,
		overrides: Partial<CanonicalUsageWindow> = {},
	): CanonicalUsageWindow {
		return {
			windowKey,
			utilization,
			resetsAtMs,
			scope: "account",
			modelFamily: null,
			active: true,
			...overrides,
		};
	}

	it("scales NanoGPT's 0-1 fraction to percent exactly once", () => {
		expect(
			normalizeProviderUsageWindows(
				{
					active: true,
					daily: { percentUsed: 0.25, resetAt: resetMs },
					monthly: { percentUsed: 0.5, resetAt: resetMs },
				},
				"nanogpt",
			),
		).toEqual([
			windowShape("daily", 25, resetMs),
			windowShape("monthly", 50, resetMs),
		]);
	});

	it("reports no windows for an inactive NanoGPT subscription", () => {
		expect(
			normalizeProviderUsageWindows(
				{
					active: false,
					daily: { percentUsed: 0.25, resetAt: resetMs },
				},
				"nanogpt",
			),
		).toEqual([]);
	});

	it("leaves Alibaba percentages on their already-0-100 native scale", () => {
		// Regression guard: the fetcher already multiplies, so normalizing must
		// not scale a second time.
		expect(
			normalizeProviderUsageWindows(
				{
					five_hour: { percentUsed: 25, resetAt: resetMs },
					weekly: { percentUsed: 50, resetAt: resetMs },
					monthly: { percentUsed: 75, resetAt: resetMs },
				},
				"alibaba-coding-plan",
			),
		).toEqual([
			windowShape("five_hour", 25, resetMs),
			windowShape("weekly", 50, resetMs),
			windowShape("monthly", 75, resetMs),
		]);
	});

	it("normalizes the remaining provider shapes with their values intact", () => {
		expect(
			normalizeProviderUsageWindows({ utilizationPercent: 33 }, "kilo"),
		).toEqual([windowShape("credits", 33, null)]);

		expect(
			normalizeProviderUsageWindows(
				{
					tokens_limit: { percentage: 40, resetAt: resetMs },
					time_limit: { percentage: 20, resetAt: resetMs },
				},
				"zai",
			),
		).toEqual([
			windowShape("five_hour", 40, resetMs),
			windowShape("time_limit", 20, resetMs),
		]);

		expect(
			normalizeProviderUsageWindows(
				{
					five_hour: { utilization: 10, resetAt: resetMs },
					seven_day: { utilization: 20, resetAt: resetMs },
				},
				"minimax",
			),
		).toEqual([
			windowShape("five_hour", 10, resetMs),
			windowShape("seven_day", 20, resetMs),
		]);

		expect(
			normalizeProviderUsageWindows(
				{ credits: { utilization: 55, resets_at: reset } },
				"xai",
			),
		).toEqual([windowShape("credits", 55, resetMs)]);
	});

	it("preserves limits[] inactive metadata instead of dropping the row", () => {
		expect(
			normalizeProviderUsageWindows(
				{
					limits: [
						{
							kind: "weekly_all",
							percent: 12,
							resets_at: reset,
							is_active: false,
						},
					],
				},
				"codex",
			),
		).toEqual([windowShape("seven_day", 12, resetMs, { active: false })]);
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
