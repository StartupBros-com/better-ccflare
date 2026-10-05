import { describe, expect, it } from "bun:test";
import { findUnknownAccountWindowCapIds } from "@better-ccflare/config";
import type { UsageSnapshot } from "@better-ccflare/providers";
import { getWindowCapStates } from "@better-ccflare/proxy/usage-throttling";
import {
	unknownWindowCapWarnings,
	unsupportedProviderWindowCapWarnings,
	WindowCapTransitionTracker,
} from "./window-cap-transitions";

const now = 10_000_000;
const HOUR = 3_600_000;
const CAP = { seven_day_fable: 80 };

/** Live shape: flat five_hour/seven_day; Fable only as an inactive weekly_scoped limits[] row. */
function liveData(fablePercent: number, resetsAt: number) {
	return {
		five_hour: { utilization: 10, resets_at: now + HOUR },
		seven_day: { utilization: 70, resets_at: resetsAt },
		limits: [
			{
				kind: "weekly_scoped",
				percent: fablePercent,
				resets_at: resetsAt,
				is_active: false,
				scope: { model: { display_name: "Fable" } },
			},
		],
	};
}

function poll(
	tracker: WindowCapTransitionTracker,
	percent: number,
	resetsAt: number,
	at = now,
) {
	const snapshot = {
		data: liveData(percent, resetsAt),
		observedAt: at,
	} as unknown as UsageSnapshot;
	const states = getWindowCapStates(snapshot, CAP, { now: at });
	return tracker.observe("acct-1", "protected", states);
}

describe("WindowCapTransitionTracker", () => {
	it("logs nothing for a first observation below cap", () => {
		const tracker = new WindowCapTransitionTracker();
		expect(poll(tracker, 50, now + 24 * HOUR)).toEqual([]);
	});

	it("emits exactly two transition lines across an upward then downward crossing of 80", () => {
		const tracker = new WindowCapTransitionTracker();
		const reset = now + 24 * HOUR;
		const events = [
			...poll(tracker, 79, reset),
			...poll(tracker, 81, reset),
			...poll(tracker, 82, reset),
			...poll(tracker, 70, reset),
			...poll(tracker, 60, reset),
		];
		expect(events.map((e) => e.kind)).toEqual(["engaged", "released"]);
		expect(events[0]).toMatchObject({
			level: "info",
			fields: {
				accountId: "acct-1",
				accountName: "protected",
				window: "seven_day_fable",
				utilization: 81,
				cap: 80,
				reason: "over_cap",
			},
		});
		expect(events[1]).toMatchObject({
			fields: { window: "seven_day_fable", utilization: 70, cap: 80 },
		});
	});

	it("logs an engaged window once on the first observation after a restart", () => {
		const tracker = new WindowCapTransitionTracker();
		const reset = now + 24 * HOUR;
		expect(poll(tracker, 85, reset).map((e) => e.kind)).toEqual(["engaged"]);
		expect(poll(tracker, 86, reset)).toEqual([]);
	});

	it("names a stale engagement with null utilization", () => {
		const tracker = new WindowCapTransitionTracker();
		const stale = {
			data: liveData(10, now + 24 * HOUR),
			observedAt: now - 60 * 60_000,
		} as unknown as UsageSnapshot;
		const events = tracker.observe(
			"acct-1",
			"protected",
			getWindowCapStates(stale, CAP, { now }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.fields).toMatchObject({
			utilization: null,
			reason: "stale",
		});
	});

	it("says when a capped window is missing from a fresh usage payload", () => {
		const tracker = new WindowCapTransitionTracker();
		const fresh = {
			data: liveData(10, now + 24 * HOUR),
			observedAt: now,
		} as unknown as UsageSnapshot;
		const events = tracker.observe(
			"acct-1",
			"protected",
			getWindowCapStates(fresh, { seven_day_fable_weekly: 80 }, { now }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("engaged");
		expect(events[0]?.message).toContain("seven_day_fable_weekly");
		expect(events[0]?.message).toContain("not in the usage payload");
	});

	it("warns once per reset cycle at cap + 10, again in the next cycle", () => {
		const tracker = new WindowCapTransitionTracker();
		const cycle1 = now + 24 * HOUR;
		const leaks = (events: ReturnType<typeof poll>) =>
			events.filter((e) => e.kind === "cap-leak");

		expect(leaks(poll(tracker, 85, cycle1))).toHaveLength(0);
		const at91 = poll(tracker, 91, cycle1);
		expect(leaks(at91)).toHaveLength(1);
		expect(leaks(at91)[0]).toMatchObject({
			level: "warn",
			fields: { utilization: 91, cap: 80, window: "seven_day_fable" },
		});
		expect(leaks(poll(tracker, 93, cycle1))).toHaveLength(0);

		// reset passes: new cycle, window below cap, then climbs to 90 exactly
		const cycle2 = cycle1 + 7 * 24 * HOUR;
		const later = cycle1 + 1;
		expect(poll(tracker, 5, cycle2, later).map((e) => e.kind)).toEqual([
			"released",
		]);
		expect(leaks(poll(tracker, 90, cycle2, later))).toHaveLength(1);
	});

	it("does not warn about a leak when the window is not engaged", () => {
		const tracker = new WindowCapTransitionTracker();
		expect(
			tracker.observe("a", "n", [
				{
					windowKey: "seven_day",
					cap: 50,
					utilization: 95,
					resetsAtMs: 1,
					engaged: false,
					reason: "reset_passed",
					evidenceExpiresAt: null,
				},
			]),
		).toEqual([]);
	});
});

describe("startup unknown-account warning", () => {
	it("yields one warning for a capped id with no matching account", () => {
		const unknown = findUnknownAccountWindowCapIds(
			{ "ghost-id": { seven_day_fable: 80 }, "acct-1": { seven_day: 90 } },
			["acct-1", "acct-2"],
		);
		const warnings = unknownWindowCapWarnings(unknown);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ghost-id");
	});
});

describe("startup unsupported-provider warning", () => {
	it("warns for a capped account whose provider reports no Anthropic usage windows", () => {
		const warnings = unsupportedProviderWindowCapWarnings(
			{ "zai-1": { seven_day: 90 }, "acct-1": { seven_day_fable: 80 } },
			[
				{ id: "zai-1", name: "zai-main", provider: "zai" },
				{ id: "acct-1", name: "protected", provider: "anthropic" },
				{ id: "codex-1", name: "codex-main", provider: "codex" },
			],
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("zai-main");
		expect(warnings[0]).toContain("zai");
	});

	it("does not warn for capped Anthropic and Codex accounts", () => {
		expect(
			unsupportedProviderWindowCapWarnings(
				{ "acct-1": { seven_day_fable: 80 }, "codex-1": { seven_day: 90 } },
				[
					{ id: "acct-1", name: "protected", provider: "anthropic" },
					{ id: "codex-1", name: "codex-main", provider: "codex" },
				],
			),
		).toEqual([]);
	});
});
