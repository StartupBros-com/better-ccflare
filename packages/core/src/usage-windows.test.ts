import { describe, expect, it } from "bun:test";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import {
	collectAutoCapacityEvidence,
	normalizeProviderUsageWindows,
} from "./usage-windows";

describe("Auto capacity source precedence", () => {
	it("retains inactive and malformed authoritative rows without resurrecting flat mirrors", () => {
		const rows = collectAutoCapacityEvidence(
			{
				seven_day: { utilization: 100, resets_at: 2000 },
				seven_day_fable: { utilization: 100, resets_at: 2000 },
				limits: [
					{ kind: "weekly_all", percent: -1, is_active: false },
					{
						kind: "weekly_scoped",
						percent: "bad",
						scope: { model: { display_name: "Fable" } },
					},
				],
			},
			"anthropic",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			source: "limits",
			active: false,
			utilization: null,
		});
		expect(rows[1]).toMatchObject({
			source: "limits",
			scope: "family",
			model: "fable",
			utilization: null,
		});
	});

	const healthyWindows = {
		five_hour: { utilization: 6, resets_at: "2026-10-03T12:00:00.000Z" },
		seven_day: { utilization: 2, resets_at: "2026-10-07T12:00:00.000Z" },
	};

	it("does not treat a seven_day_breakdown metadata object as a window", () => {
		const rows = collectAutoCapacityEvidence(
			{
				...healthyWindows,
				seven_day_breakdown: {
					as_of: "2026-10-03T09:00:00.000Z",
					window_started_at: "2026-09-30T09:00:00.000Z",
					rows: [{ key: "fable", display_name: "Fable", percent: 0 }],
				},
			},
			"anthropic",
		);
		expect(rows.map((r) => r.window)).toEqual(["five_hour", "seven_day"]);
		expect(rows.some((r) => r.window === "seven_day_breakdown")).toBe(false);
		expect(rows.some((r) => r.scope === "unknown")).toBe(false);
	});

	it("keeps a window-shaped unrecognized seven_day_ key as an unknown row", () => {
		const rows = collectAutoCapacityEvidence(
			{
				...healthyWindows,
				seven_day_oauth_apps: { utilization: null, resets_at: null },
			},
			"anthropic",
		);
		expect(rows.find((r) => r.window === "seven_day_oauth_apps")).toMatchObject(
			{ scope: "unknown", utilization: null },
		);
	});

	it("keeps an unrecognized seven_day_ key with renamed window fields as an unknown row", () => {
		const rows = collectAutoCapacityEvidence(
			{
				...healthyWindows,
				seven_day_newwindow: { percent: 100 },
			},
			"anthropic",
		);
		expect(rows.find((r) => r.window === "seven_day_newwindow")).toMatchObject({
			window: "seven_day_newwindow",
			scope: "unknown",
			utilization: null,
		});
	});

	it("keeps known windows as rows even when their shape drifts", () => {
		const rows = collectAutoCapacityEvidence(
			{ seven_day: {}, seven_day_fable: { foo: 1 } },
			"anthropic",
		);
		expect(rows.find((r) => r.window === "seven_day_fable")).toMatchObject({
			scope: "family",
			utilization: null,
		});
		expect(rows.find((r) => r.window === "seven_day")).toMatchObject({
			scope: "account",
			utilization: null,
		});
	});
});

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

	it("keeps an over-limit NanoGPT window instead of dropping it", () => {
		// percentUsed can legitimately exceed 1 when the user has overridden the
		// daily limit — the fetcher documents this. Rejecting it as out of range
		// would remove the window from history AND from alert evaluation, muting
		// the exhaustion alert exactly while the account is over its limit.
		expect(
			normalizeProviderUsageWindows(
				{
					active: true,
					daily: { percentUsed: 1.5, resetAt: resetMs },
					monthly: { percentUsed: 0.5, resetAt: resetMs },
				},
				"nanogpt",
			),
		).toEqual([
			windowShape("daily", 100, resetMs),
			windowShape("monthly", 50, resetMs),
		]);
	});

	it("still rejects a negative utilization as malformed", () => {
		// Saturating overage must not turn into "accept anything": a negative
		// reading is broken data, and coercing it to 0% would invent capacity.
		expect(
			normalizeProviderUsageWindows(
				{
					active: true,
					daily: { percentUsed: -0.5, resetAt: resetMs },
					monthly: { percentUsed: 0.5, resetAt: resetMs },
				},
				"nanogpt",
			),
		).toEqual([windowShape("monthly", 50, resetMs)]);
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
		// NaN and an unparseable reset are broken readings and are dropped. An
		// over-100 reading is NOT broken — it is an exhausted account — so it is
		// retained, saturated at 100.
		expect(
			normalizeProviderUsageWindows(
				{
					five_hour: { utilization: Number.NaN, resets_at: reset },
					seven_day: { utilization: 101, resets_at: reset },
					credits: { utilization: 20, resets_at: "bad" },
				},
				"anthropic",
			),
		).toEqual([windowShape("seven_day", 100, resetMs)]);
		expect(
			normalizeProviderUsageWindows({ utilizationPercent: 20 }, "kilo")[0],
		).toMatchObject({
			windowKey: "credits",
			resetsAtMs: null,
		});
	});
});
