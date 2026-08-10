import { describe, expect, it } from "bun:test";
import { computeWeeklyPace, formatDurationShort } from "../usage-pace";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// Fixed reference points — no Date.now() anywhere in this file.
const RESET = 10 * DAY; // arbitrary epoch-ms anchor
const WINDOW_START = RESET - 7 * DAY;

describe("computeWeeklyPace", () => {
	it("returns null when resetsAtMs is null (no active seven_day window)", () => {
		expect(computeWeeklyPace(50, null, WINDOW_START)).toBeNull();
	});

	it("derives the window start as resetsAt minus 7 days", () => {
		const result = computeWeeklyPace(50, RESET, WINDOW_START);
		expect(result).not.toBeNull();
		expect(result?.windowStartMs).toBe(WINDOW_START);
	});

	it("computes expectedPct as the elapsed fraction of the 7-day window", () => {
		// Halfway through the week (3.5d elapsed of 7d) -> 50% expected.
		const halfway = WINDOW_START + 3.5 * DAY;
		const result = computeWeeklyPace(50, RESET, halfway);
		expect(result?.expectedPct).toBeCloseTo(50, 5);
	});

	it("flags on_pace when |delta| <= 2pp", () => {
		const halfway = WINDOW_START + 3.5 * DAY; // expected 50%
		expect(computeWeeklyPace(50, RESET, halfway)?.band).toBe("on_pace");
		expect(computeWeeklyPace(52, RESET, halfway)?.band).toBe("on_pace"); // +2 boundary
		expect(computeWeeklyPace(48, RESET, halfway)?.band).toBe("on_pace"); // -2 boundary
	});

	it("flags over_pace when actual exceeds expected by more than 2pp", () => {
		const halfway = WINDOW_START + 3.5 * DAY; // expected 50%
		const result = computeWeeklyPace(60, RESET, halfway);
		expect(result?.band).toBe("over_pace");
		expect(result?.deltaPct).toBeCloseTo(10, 5);
	});

	it("flags in_reserve when actual trails expected by more than 2pp", () => {
		const halfway = WINDOW_START + 3.5 * DAY; // expected 50%
		const result = computeWeeklyPace(40, RESET, halfway);
		expect(result?.band).toBe("in_reserve");
		expect(result?.deltaPct).toBeCloseTo(-10, 5);
	});

	it("clamps expectedPct to 0 when now is before the window start", () => {
		const before = WINDOW_START - HOUR;
		const result = computeWeeklyPace(10, RESET, before);
		expect(result?.expectedPct).toBe(0);
	});

	it("clamps expectedPct to 100 when now is past the reset", () => {
		const after = RESET + HOUR;
		const result = computeWeeklyPace(90, RESET, after);
		expect(result?.expectedPct).toBe(100);
	});

	it("returns null when resetsAtMs is not finite", () => {
		expect(computeWeeklyPace(50, Number.NaN, WINDOW_START)).toBeNull();
	});
});

describe("formatDurationShort", () => {
	it("renders sub-hour spans as minutes only", () => {
		expect(formatDurationShort(45 * MIN)).toBe("45m");
	});

	it("renders hour+minute spans as 'Xh Ym'", () => {
		expect(formatDurationShort(3 * HOUR + 12 * MIN)).toBe("3h 12m");
	});

	it("renders an exact hour as 'Xh 0m'", () => {
		expect(formatDurationShort(HOUR)).toBe("1h 0m");
	});

	it("clamps negative spans to 0m", () => {
		expect(formatDurationShort(-5 * MIN)).toBe("0m");
	});

	it("renders a zero span as 0m", () => {
		expect(formatDurationShort(0)).toBe("0m");
	});
});
