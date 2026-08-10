/**
 * LiveCountdown ticks a reset countdown every second via its own setInterval,
 * independent of the app-wide 30s registerUIRefresh tick used elsewhere in the
 * dashboard (see RateLimitProgress.tsx). renderToStaticMarkup (this directory's
 * standard test harness -- see RateLimitProgress.test.tsx / RoutingCard.test.tsx)
 * does not run effects, so these tests cover:
 *   1. The pure formatting helpers exhaustively (the actual tick math).
 *   2. The component's INITIAL render (the useState lazy initializer runs
 *      synchronously during SSR, before any effect), proving it wires target
 *      resolution + formatting correctly at mount.
 * The per-second re-render and unmount cleanup are implemented per spec but
 * are not exercised by an automated test here -- there is no DOM/act harness
 * in this package to observe a live setInterval tick (no jsdom/happy-dom
 * dependency exists in the repo, and adding one is out of scope).
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatCountdownDuration,
	formatCountdownLabel,
	LiveCountdown,
	resolveCountdownTargetMs,
} from "./LiveCountdown";

describe("formatCountdownDuration", () => {
	it("renders hours, minutes, and seconds once an hour or more remains", () => {
		const ms = 2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 3 * 1000;
		expect(formatCountdownDuration(ms)).toBe("2h 5m 3s");
	});

	it("omits the hour segment under an hour", () => {
		expect(formatCountdownDuration(5 * 60 * 1000 + 30 * 1000)).toBe("5m 30s");
	});

	it("shows seconds only under a minute", () => {
		expect(formatCountdownDuration(45 * 1000)).toBe("45s");
	});

	it("rounds a sub-second remainder up (never flashes early)", () => {
		expect(formatCountdownDuration(500)).toBe("1s");
	});

	it("clamps non-positive input to 0s", () => {
		expect(formatCountdownDuration(0)).toBe("0s");
		expect(formatCountdownDuration(-5000)).toBe("0s");
	});

	it("keeps a zero minute segment when hours are present", () => {
		expect(formatCountdownDuration(60 * 60 * 1000 + 5 * 1000)).toBe("1h 0m 5s");
	});
});

describe("formatCountdownLabel", () => {
	it("appends the suffix while time remains", () => {
		expect(formatCountdownLabel(65 * 1000, " until refresh")).toBe(
			"1m 5s until refresh",
		);
	});

	it("drops the suffix and shows the default zero text once expired", () => {
		expect(formatCountdownLabel(0, " until refresh")).toBe("resetting…");
		expect(formatCountdownLabel(-500, " until refresh")).toBe("resetting…");
	});

	it("shows the zero text for a non-finite (invalid target) input", () => {
		expect(formatCountdownLabel(Number.NaN, " until refresh")).toBe(
			"resetting…",
		);
	});

	it("accepts a custom zero text", () => {
		expect(formatCountdownLabel(0, "", "expired")).toBe("expired");
	});

	it("defaults to no suffix", () => {
		expect(formatCountdownLabel(45 * 1000)).toBe("45s");
	});
});

describe("resolveCountdownTargetMs", () => {
	it("passes a numeric epoch through unchanged", () => {
		expect(resolveCountdownTargetMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	it("parses an ISO string into epoch milliseconds", () => {
		const iso = "2026-01-01T00:00:00.000Z";
		expect(resolveCountdownTargetMs(iso)).toBe(new Date(iso).getTime());
	});

	it("returns NaN for an invalid string", () => {
		expect(Number.isNaN(resolveCountdownTargetMs("not-a-date"))).toBe(true);
	});
});

describe("LiveCountdown (initial render)", () => {
	const FIXED_NOW = new Date("2026-08-10T12:00:00.000Z").getTime();

	afterEach(() => {
		setSystemTime();
	});

	it("renders the initial remaining duration with the suffix", () => {
		setSystemTime(FIXED_NOW);
		const target = FIXED_NOW + 90 * 60 * 1000; // 1h30m away
		const html = renderToStaticMarkup(
			<LiveCountdown target={target} suffix=" until refresh" />,
		);
		expect(html).toContain("1h 30m 0s until refresh");
	});

	it("accepts an ISO string target", () => {
		setSystemTime(FIXED_NOW);
		const target = new Date(FIXED_NOW + 45 * 1000).toISOString();
		const html = renderToStaticMarkup(<LiveCountdown target={target} />);
		expect(html).toContain("45s");
	});

	it("shows the zero text (not the suffix) once the target has already passed", () => {
		setSystemTime(FIXED_NOW);
		const html = renderToStaticMarkup(
			<LiveCountdown target={FIXED_NOW - 1000} suffix=" until refresh" />,
		);
		expect(html).toContain("resetting…");
		expect(html).not.toContain("until refresh");
	});

	it("applies the supplied className to the wrapping element", () => {
		setSystemTime(FIXED_NOW);
		const html = renderToStaticMarkup(
			<LiveCountdown
				target={FIXED_NOW + 1000}
				className="text-xs text-muted-foreground"
			/>,
		);
		expect(html).toContain('class="text-xs text-muted-foreground"');
	});
});
