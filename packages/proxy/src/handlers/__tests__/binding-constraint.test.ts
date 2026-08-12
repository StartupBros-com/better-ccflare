import { describe, expect, it } from "bun:test";
import type { AnyUsageData } from "@better-ccflare/providers";
import { getBindingConstraint } from "../usage-throttling";

const NOW = Date.UTC(2026, 7, 11, 23, 0, 0);

/**
 * The live payload shape from the 2026-08-11 incident: Anthropic marks only the
 * BINDING limit `is_active`, so on the accounts that lost 12h of routing the
 * sole active row was weekly_scoped Fable while session/weekly_all sat inactive
 * with headroom. The dashboard reported the account-wide number and read healthy.
 */
function incidentUsage(overrides: { weeklyAll?: number; fable?: number } = {}) {
	const weeklyAll = overrides.weeklyAll ?? 72;
	return {
		// Real payloads carry the flat account windows AND limits[]. collectWindows
		// skips is_active:false rows, then supplements the account windows from
		// these flat fields — so omitting them (as a hand-built fixture naturally
		// would) silently drops account-wide context and misrepresents the shape
		// this function exists to read.
		five_hour: {
			utilization: 45,
			resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
		},
		seven_day: {
			utilization: weeklyAll,
			resets_at: new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString(),
		},
		limits: [
			{
				kind: "session",
				percent: 45,
				resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
				is_active: false,
			},
			{
				kind: "weekly_all",
				percent: weeklyAll,
				resets_at: new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString(),
				is_active: false,
			},
			{
				kind: "weekly_scoped",
				percent: overrides.fable ?? 100,
				resets_at: new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString(),
				scope: { model: { id: null, display_name: "Fable" } },
				is_active: true,
			},
		],
	} as unknown as AnyUsageData;
}

describe("getBindingConstraint", () => {
	it("surfaces the per-model cap the account-wide number hides", () => {
		const binding = getBindingConstraint(incidentUsage());

		expect(binding).toMatchObject({
			utilization: 100,
			scope: "family",
			modelFamily: "fable",
		});
	});

	it("reports the account window when it is the most restrictive", () => {
		const binding = getBindingConstraint(
			incidentUsage({ weeklyAll: 99, fable: 40 }),
		);

		expect(binding).toMatchObject({ utilization: 99, scope: "account" });
	});

	it("hides another family's cap when a model is named", () => {
		const binding = getBindingConstraint(incidentUsage(), {
			requestModel: "claude-opus-5",
		});

		// Opus is unconstrained here; the Fable cap must not be attributed to it.
		expect(binding).toMatchObject({ utilization: 72, scope: "account" });
	});

	it("keeps the matching family's cap when that model is named", () => {
		const binding = getBindingConstraint(incidentUsage(), {
			requestModel: "claude-fable-5",
		});

		expect(binding).toMatchObject({
			utilization: 100,
			scope: "family",
			modelFamily: "fable",
		});
	});

	it("carries the reset so the UI can say when it clears", () => {
		const binding = getBindingConstraint(incidentUsage());

		expect(binding?.resetAtMs).toBe(NOW + 4 * 24 * 60 * 60 * 1000);
	});

	it("returns null when there is no usage data", () => {
		expect(getBindingConstraint(null)).toBeNull();
	});

	it("returns null for a payload with no recognizable windows", () => {
		expect(
			getBindingConstraint({ nonsense: true } as unknown as AnyUsageData),
		).toBeNull();
	});
});
