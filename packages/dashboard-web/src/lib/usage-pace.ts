import { computeWindowStartMs } from "@better-ccflare/core";

/** How a `seven_day` window's actual usage compares to its calendar pace. */
export type PaceBand = "on_pace" | "over_pace" | "in_reserve";

// |delta| <= this many percentage-points counts as "on pace" — matches the
// tolerance used for the burn-rate insight cards (UsageInsightCards).
const PACE_TOLERANCE_PP = 2;

export interface WeeklyPaceResult {
	/** Utilization (0-100) expected if usage tracked the elapsed calendar
	 * fraction of the window linearly. */
	expectedPct: number;
	/** actualPct - expectedPct, in percentage points. Positive = ahead of
	 * calendar pace (burning faster than a flat weekly rate). */
	deltaPct: number;
	band: PaceBand;
	/** Window start, derived as resetsAtMs minus the fixed 7-day span. */
	windowStartMs: number;
}

/**
 * Weekly pace for the `seven_day` window only — compares actual utilization
 * against the utilization "expected" if usage were spread evenly across the
 * calendar week (elapsedFractionOfWindow * 100). Calendar-time only; there is
 * no work-day weighting/mode. Pure and deterministic: `now` and `resetsAtMs`
 * are both caller-supplied ms-epoch values (no Date.now() in here), so this
 * is directly unit-testable with fixed timestamps.
 *
 * Returns null when the window bounds can't be established — no known reset,
 * or a non-positive window span.
 */
export function computeWeeklyPace(
	actualPct: number,
	resetsAtMs: number | null,
	now: number,
): WeeklyPaceResult | null {
	if (resetsAtMs == null) return null;
	const windowStartMs = computeWindowStartMs(resetsAtMs, "seven_day");
	if (windowStartMs == null) return null;
	const windowDurationMs = resetsAtMs - windowStartMs;
	if (windowDurationMs <= 0) return null;

	const elapsedMs = Math.max(
		0,
		Math.min(now - windowStartMs, windowDurationMs),
	);
	const expectedPct = (elapsedMs / windowDurationMs) * 100;
	const deltaPct = actualPct - expectedPct;
	const band: PaceBand =
		deltaPct > PACE_TOLERANCE_PP
			? "over_pace"
			: deltaPct < -PACE_TOLERANCE_PP
				? "in_reserve"
				: "on_pace";

	return { expectedPct, deltaPct, band, windowStartMs };
}
