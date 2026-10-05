import { describe, expect, it } from "bun:test";
import type { UsageSnapshot } from "@better-ccflare/providers";
import { evaluateWindowCaps, getWindowCapStates } from "../usage-throttling";

const now = 10_000_000;
const MIN = 60_000;
const resetAt = now + 3 * 60 * MIN;
const FABLE = "claude-fable-5-1";

/** Live shape: flat five_hour/seven_day; Fable only as an inactive weekly_scoped limits[] row. */
function liveData(
	fablePercent: number | null,
	overrides: Record<string, unknown> = {},
) {
	return {
		five_hour: { utilization: 10, resets_at: resetAt },
		seven_day: { utilization: 70, resets_at: resetAt },
		limits:
			fablePercent === null
				? []
				: [
						{
							kind: "weekly_scoped",
							percent: fablePercent,
							resets_at: resetAt,
							is_active: false,
							scope: { model: { display_name: "Fable" } },
						},
					],
		...overrides,
	};
}

function snap(data: unknown, ageMs = 0): UsageSnapshot {
	return { data, observedAt: now - ageMs } as unknown as UsageSnapshot;
}

const fableCap = { seven_day_fable: 80 };

describe("evaluateWindowCaps", () => {
	it("blocks Fable at 85 over cap 80, expiring at the window reset", () => {
		const out = evaluateWindowCaps(snap(liveData(85), MIN), fableCap, {
			requestModel: FABLE,
			now,
		});
		expect(out).toEqual([
			{
				scope: "family",
				window: "seven_day_fable",
				modelFamily: "fable",
				utilization: 85,
				cap: 80,
				reason: "over_cap",
				resetAtMs: resetAt,
				// freshness window (3 min) ends before the reset: observed at now-1min
				evidenceExpiresAt: now - MIN + 3 * MIN,
			},
		]);
	});

	it("uses the window reset as expiry when it comes before the freshness expiry", () => {
		const soon = now + MIN;
		const data = liveData(85);
		(data.limits[0] as { resets_at: number }).resets_at = soon;
		const out = evaluateWindowCaps(snap(data), fableCap, {
			requestModel: FABLE,
			now,
		});
		expect(out[0]?.evidenceExpiresAt).toBe(soon);
	});

	it("does not block an Opus request on a Fable cap", () => {
		expect(
			evaluateWindowCaps(snap(liveData(85)), fableCap, {
				requestModel: "claude-opus-5-5",
				now,
			}),
		).toEqual([]);
	});

	it("does not block at 79 under cap 80, blocks at exactly 80", () => {
		const opts = { requestModel: FABLE, now };
		expect(evaluateWindowCaps(snap(liveData(79)), fableCap, opts)).toEqual([]);
		expect(evaluateWindowCaps(snap(liveData(80)), fableCap, opts)).toHaveLength(
			1,
		);
	});

	it("treats a 4-minute-old snapshot as stale and a 2-minute-old one as evidence", () => {
		const opts = { requestModel: FABLE, now };
		const stale = evaluateWindowCaps(
			snap(liveData(10), 4 * MIN),
			fableCap,
			opts,
		);
		expect(stale).toHaveLength(1);
		expect(stale[0]).toMatchObject({
			reason: "stale",
			utilization: null,
			evidenceExpiresAt: now + 90_000,
		});
		expect(
			evaluateWindowCaps(snap(liveData(10), 2 * MIN), fableCap, opts),
		).toEqual([]);
	});

	it("fails closed with no snapshot for a capped account, open with no caps", () => {
		const opts = { requestModel: FABLE, now };
		expect(evaluateWindowCaps(null, fableCap, opts)[0]?.reason).toBe("stale");
		expect(evaluateWindowCaps(null, undefined, opts)).toEqual([]);
		expect(evaluateWindowCaps(null, null, opts)).toEqual([]);
		expect(evaluateWindowCaps(null, {}, opts)).toEqual([]);
	});

	it("reads the inactive limits[] Fable row: 40 passes, 85 blocks", () => {
		const opts = { requestModel: FABLE, now };
		expect(evaluateWindowCaps(snap(liveData(40)), fableCap, opts)).toEqual([]);
		expect(evaluateWindowCaps(snap(liveData(85)), fableCap, opts)).toHaveLength(
			1,
		);
	});

	it("treats a payload with no Fable window anywhere as stale", () => {
		const out = evaluateWindowCaps(snap(liveData(null)), fableCap, {
			requestModel: FABLE,
			now,
		});
		expect(out[0]).toMatchObject({ reason: "stale", utilization: null });
	});

	it("applies an account-wide seven_day cap to every request model", () => {
		for (const requestModel of [FABLE, "claude-opus-5-5", null]) {
			const out = evaluateWindowCaps(
				snap(
					liveData(10, { seven_day: { utilization: 92, resets_at: resetAt } }),
				),
				{ seven_day: 90 },
				{ requestModel, now },
			);
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				scope: "account",
				window: "seven_day",
				modelFamily: null,
				utilization: 92,
			});
		}
	});

	it("applies a five_hour cap to every model, and a stale five_hour snapshot too", () => {
		const data = liveData(10, {
			five_hour: { utilization: 95, resets_at: resetAt },
		});
		const caps = { five_hour: 90 };
		expect(
			evaluateWindowCaps(snap(data), caps, {
				requestModel: "claude-opus-5-5",
				now,
			})[0],
		).toMatchObject({
			scope: "account",
			window: "five_hour",
			reason: "over_cap",
		});
		expect(
			evaluateWindowCaps(snap(data, 4 * MIN), caps, {
				requestModel: "claude-opus-5-5",
				now,
			})[0],
		).toMatchObject({ scope: "account", window: "five_hour", reason: "stale" });
	});

	it("releases on a passed reset before the stale or threshold checks", () => {
		const past = now - MIN;
		const data = liveData(100);
		(data.limits[0] as { resets_at: number }).resets_at = past;
		const opts = { requestModel: FABLE, now };
		expect(evaluateWindowCaps(snap(data), fableCap, opts)).toEqual([]);
		expect(evaluateWindowCaps(snap(data, 4 * MIN), fableCap, opts)).toEqual([]);
	});

	it("still blocks at 100 when extra usage is enabled (R3)", () => {
		const data = liveData(100, {
			extra_usage: { is_enabled: true, utilization: 5 },
			spend: { enabled: true, percent: 10 },
		});
		expect(
			evaluateWindowCaps(snap(data), fableCap, { requestModel: FABLE, now }),
		).toHaveLength(1);
	});

	it("returns one exclusion per engaged cap when family and account caps are both over", () => {
		const out = evaluateWindowCaps(
			snap(
				liveData(85, { seven_day: { utilization: 92, resets_at: resetAt } }),
			),
			{ seven_day_fable: 80, seven_day: 90 },
			{ requestModel: FABLE, now },
		);
		expect(out.map((e) => e.window).sort()).toEqual([
			"seven_day",
			"seven_day_fable",
		]);
	});
});

describe("getWindowCapStates", () => {
	it("reports one state per capped window with its reason", () => {
		const states = getWindowCapStates(
			snap(liveData(85)),
			{ seven_day_fable: 80, seven_day: 90, five_hour: 50 },
			{ now },
		);
		const by = Object.fromEntries(states.map((s) => [s.windowKey, s]));
		expect(by.seven_day_fable).toMatchObject({
			engaged: true,
			reason: "over_cap",
			utilization: 85,
			cap: 80,
			resetsAtMs: resetAt,
		});
		expect(by.seven_day).toMatchObject({
			engaged: false,
			reason: "below_cap",
			utilization: 70,
		});
		expect(by.five_hour).toMatchObject({
			engaged: false,
			reason: "below_cap",
			utilization: 10,
		});
	});

	it("reports stale for an old snapshot and reset_passed after the reset", () => {
		expect(
			getWindowCapStates(snap(liveData(10), 4 * MIN), fableCap, { now })[0],
		).toMatchObject({ engaged: true, reason: "stale", utilization: null });
		const data = liveData(100);
		(data.limits[0] as { resets_at: number }).resets_at = now - 1;
		expect(getWindowCapStates(snap(data), fableCap, { now })[0]).toMatchObject({
			engaged: false,
			reason: "reset_passed",
		});
	});

	it("returns nothing without caps", () => {
		expect(getWindowCapStates(null, undefined, { now })).toEqual([]);
	});
});
