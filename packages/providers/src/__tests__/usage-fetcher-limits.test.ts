import { describe, expect, it } from "bun:test";
import type { UsageData } from "../usage-fetcher";
import {
	extractWeeklyResetTime,
	getRepresentativeUtilization,
	getRepresentativeUtilizationForProvider,
	getRepresentativeWindow,
} from "../usage-fetcher";

const R = "2030-01-01T00:00:00.000Z";

// A limits[]-only Anthropic payload (no flat five_hour/seven_day) — the shape
// Anthropic moves toward. The account-level number must come from limits[]:
// weekly_all 70 is the hard account cap; the Fable 100% weekly_scoped is a
// per-model cap and must NOT count as the account-level utilization.
const limitsOnly = {
	limits: [
		{ kind: "session", percent: 40, resets_at: R, scope: null },
		{ kind: "weekly_all", percent: 70, resets_at: R, scope: null },
		{
			kind: "weekly_scoped",
			percent: 100,
			resets_at: R,
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
} as unknown as UsageData;

describe("getRepresentativeUtilization — limits[] (P1)", () => {
	it("reads account-level session/weekly_all from limits[], ignoring weekly_scoped", () => {
		expect(getRepresentativeUtilization(limitsOnly)).toBe(70);
	});

	it("returns null (not 0) when no usable window is present", () => {
		expect(
			getRepresentativeUtilization({ limits: [] } as unknown as UsageData),
		).toBeNull();
	});

	it("still reads legacy flat windows when limits[] is absent", () => {
		const flat = {
			five_hour: { utilization: 30, resets_at: R },
			seven_day: { utilization: 20, resets_at: R },
		} as UsageData;
		expect(getRepresentativeUtilization(flat)).toBe(30);
	});
});

describe("getRepresentativeWindow — limits[] (P1)", () => {
	it("maps the most-restrictive account-level limit to a canonical window key", () => {
		// weekly_all (70) beats session (40) -> canonical "seven_day".
		expect(getRepresentativeWindow(limitsOnly)).toBe("seven_day");
	});
});

describe("getRepresentativeUtilizationForProvider — limits[] (P1)", () => {
	it("anthropic reads account-level limits[] (max session/weekly_all)", () => {
		expect(
			getRepresentativeUtilizationForProvider(limitsOnly, "anthropic"),
		).toBe(70);
	});
});

describe("extractWeeklyResetTime", () => {
	it("reads the legacy flat seven_day reset for Codex-shaped data", () => {
		const reset = "2030-02-03T04:05:06.000Z";
		const data = {
			seven_day: { utilization: 40, resets_at: reset },
		} as UsageData;
		expect(extractWeeklyResetTime(data, "codex")).toBe(
			new Date(reset).getTime(),
		);
	});

	it("reads limits[].weekly_all when the flat window is absent", () => {
		const reset = "2030-03-04T05:06:07.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 20, resets_at: "2030-03-04T01:00:00.000Z" },
				{ kind: "weekly_all", percent: 40, resets_at: reset },
			],
		} as unknown as UsageData;
		expect(extractWeeklyResetTime(data, "codex")).toBe(
			new Date(reset).getTime(),
		);
	});

	it("falls back to a valid limits reset when the flat reset is malformed", () => {
		const reset = "2030-04-05T06:07:08.000Z";
		const nowMs = new Date("2029-01-01T00:00:00.000Z").getTime();
		const data = {
			seven_day: { utilization: 40, resets_at: "not-a-date" },
			limits: [{ kind: "weekly_all", percent: 40, resets_at: reset }],
		} as unknown as UsageData;

		expect(extractWeeklyResetTime(data, "codex", nowMs)).toBe(
			new Date(reset).getTime(),
		);
	});

	it("falls back to a future limits reset when the flat reset is already past", () => {
		const reset = "2030-05-06T07:08:09.000Z";
		const nowMs = new Date("2029-01-01T00:00:00.000Z").getTime();
		const data = {
			seven_day: {
				utilization: 40,
				resets_at: "2020-01-01T00:00:00.000Z",
			},
			limits: [{ kind: "weekly_all", percent: 40, resets_at: reset }],
		} as unknown as UsageData;

		expect(extractWeeklyResetTime(data, "codex", nowMs)).toBe(
			new Date(reset).getTime(),
		);
	});

	it("falls back when the flat reset is exactly at the observation boundary", () => {
		const nowMs = new Date("2030-06-01T00:00:00.000Z").getTime();
		const reset = "2030-06-02T00:00:00.000Z";
		const data = {
			seven_day: {
				utilization: 40,
				resets_at: "2030-06-01T00:00:00.000Z",
			},
			limits: [{ kind: "weekly_all", percent: 40, resets_at: reset }],
		} as unknown as UsageData;

		expect(extractWeeklyResetTime(data, "codex", nowMs)).toBe(
			new Date(reset).getTime(),
		);
	});

	it("ignores inactive weekly_all limits", () => {
		const activeReset = "2030-06-07T08:09:10.000Z";
		const nowMs = new Date("2029-01-01T00:00:00.000Z").getTime();
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: "2030-01-01T00:00:00.000Z",
					is_active: false,
				},
				{ kind: "weekly_all", percent: 40, resets_at: activeReset },
			],
		} as unknown as UsageData;

		expect(extractWeeklyResetTime(data, "codex", nowMs)).toBe(
			new Date(activeReset).getTime(),
		);
	});

	it("returns null for unsupported providers, missing, malformed, or unrelated windows", () => {
		expect(
			extractWeeklyResetTime(
				{
					seven_day: {
						utilization: 40,
						resets_at: "2030-01-01T00:00:00.000Z",
					},
				} as UsageData,
				"xai",
			),
		).toBeNull();
		expect(
			extractWeeklyResetTime({ limits: [] } as unknown as UsageData),
			"codex",
		).toBeNull();
		expect(
			extractWeeklyResetTime(
				{
					seven_day: { utilization: 40, resets_at: "not-a-date" },
				} as UsageData,
				"codex",
			),
		).toBeNull();
		expect(
			extractWeeklyResetTime(
				{
					limits: [
						{
							kind: "weekly_scoped",
							percent: 40,
							resets_at: "2030-01-01T00:00:00.000Z",
						},
					],
				} as unknown as UsageData,
				"codex",
			),
		).toBeNull();
	});
});
