import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import type {
	AccountUsageWindows,
	ClosedUsageWindow,
	OpenUsageWindow,
	UsageWindowGrantType,
} from "../../../api";
import { WindowValueTimeline } from "../WindowValueTimeline";
import {
	deltaVsPriorMedian,
	groupByProvider,
	sectionLastFullWindowSubtotal,
	timeDomain,
	timelineSegmentGeometry,
	weeklyTimelineTicks,
} from "../window-value-utils";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.UTC(2026, 7, 25, 0, 0, 0);

const AUG_8 = Date.UTC(2026, 7, 8, 0, 0, 0);
const AUG_11 = Date.UTC(2026, 7, 11, 0, 0, 0);
const AUG_13 = Date.UTC(2026, 7, 13, 0, 0, 0);
const AUG_18 = Date.UTC(2026, 7, 18, 0, 0, 0);
const AUG_19 = Date.UTC(2026, 7, 19, 0, 0, 0);
const AUG_20 = Date.UTC(2026, 7, 20, 0, 0, 0);
const AUG_24 = Date.UTC(2026, 7, 24, 0, 0, 0);
const AUG_24_1830 = Date.UTC(2026, 7, 24, 18, 30, 0);
const AUG_31_1830 = Date.UTC(2026, 7, 31, 18, 30, 0);

function closedWindow({
	id,
	accountId,
	startedAt,
	closedAt,
	grantType = "natural",
	peakUtilization = 100,
	valueUsd,
}: {
	id: string;
	accountId: string;
	startedAt: number;
	closedAt: number;
	grantType?: UsageWindowGrantType;
	peakUtilization?: number;
	valueUsd: number;
}): ClosedUsageWindow {
	return {
		id,
		accountId,
		windowKey: "seven_day",
		startedAt,
		resetsAt: closedAt,
		closedAt,
		grantType,
		peakUtilization,
		first100At: peakUtilization >= 95 ? closedAt - HOUR_MS : null,
		valueUsd,
		inputTokens: 10_000_000,
		cacheReadInputTokens: 5_000_000,
		cacheCreationInputTokens: 1_000_000,
		outputTokens: 500_000,
		requestCount: 100,
		modelBreakdown: {},
		unpricedTokens: 0,
		projectionVersion: "v1",
	};
}

function openWindow({
	accountId,
	startedAt,
	resetsAt,
	grantType = "natural",
	valueSoFarUsd,
	utilization,
}: {
	accountId: string;
	startedAt: number;
	resetsAt: number;
	grantType?: UsageWindowGrantType;
	valueSoFarUsd: number;
	utilization: number;
}): OpenUsageWindow {
	return {
		...closedWindow({
			id: `${accountId}-open`,
			accountId,
			startedAt,
			closedAt: resetsAt,
			grantType,
			peakUtilization: utilization,
			valueUsd: 0,
		}),
		closedAt: null,
		valueUsd: null,
		valueSoFarUsd,
		utilization,
		ageHours: (NOW_MS - startedAt) / HOUR_MS,
	};
}

// API order is newest first, matching GET /api/usage-windows.
const proPrimary: AccountUsageWindows = {
	accountId: "pro-primary",
	accountName: "pro-primary",
	provider: "codex",
	windows: [
		closedWindow({
			id: "pro-natural",
			accountId: "pro-primary",
			startedAt: AUG_20,
			closedAt: AUG_24,
			valueUsd: 2_962.44,
		}),
		closedWindow({
			id: "pro-early-reset-2",
			accountId: "pro-primary",
			startedAt: AUG_13,
			closedAt: AUG_20,
			grantType: "early_reset",
			valueUsd: 1_653.13,
		}),
		closedWindow({
			id: "pro-early-reset-1",
			accountId: "pro-primary",
			startedAt: AUG_11,
			closedAt: AUG_13,
			grantType: "early_reset",
			valueUsd: 2_522.09,
		}),
		closedWindow({
			id: "pro-first-observed",
			accountId: "pro-primary",
			startedAt: AUG_8,
			closedAt: AUG_13,
			grantType: "first_observed",
			peakUtilization: 86,
			valueUsd: 1_960,
		}),
	],
	openWindow: openWindow({
		accountId: "pro-primary",
		startedAt: AUG_24_1830,
		resetsAt: AUG_31_1830,
		grantType: "early_reset",
		valueSoFarUsd: 812.55,
		utilization: 34,
	}),
};

const proSecondary: AccountUsageWindows = {
	accountId: "pro-secondary",
	accountName: "pro-secondary",
	provider: "codex",
	windows: [
		closedWindow({
			id: "secondary-natural",
			accountId: "pro-secondary",
			startedAt: AUG_18,
			closedAt: AUG_24,
			valueUsd: 1_655.28,
		}),
	],
	openWindow: null,
};

// The $85 row is real production-shaped fixture data: its 6% utilization is a
// partial observation, not an $85 Pro grant. It sits between full $2.9k-$3.1k
// windows and must neither establish a delta baseline nor change the subtotal.
const maxPrimary: AccountUsageWindows = {
	accountId: "max-primary-bros",
	accountName: "max-primary-bros",
	provider: "anthropic",
	windows: [
		closedWindow({
			id: "max-latest-full",
			accountId: "max-primary-bros",
			startedAt: AUG_19,
			closedAt: AUG_24,
			valueUsd: 3_000,
		}),
		closedWindow({
			id: "max-phantom-nerf",
			accountId: "max-primary-bros",
			startedAt: AUG_18,
			closedAt: AUG_19,
			peakUtilization: 6,
			valueUsd: 85,
		}),
		closedWindow({
			id: "max-middle-full",
			accountId: "max-primary-bros",
			startedAt: AUG_11,
			closedAt: AUG_18,
			valueUsd: 3_110,
		}),
		closedWindow({
			id: "max-oldest-full",
			accountId: "max-primary-bros",
			startedAt: AUG_8,
			closedAt: AUG_11,
			valueUsd: 2_900,
		}),
	],
	openWindow: null,
};

const otherProvider: AccountUsageWindows = {
	accountId: "other-primary",
	accountName: "other-primary",
	provider: "ollama",
	windows: [
		closedWindow({
			id: "other-full",
			accountId: "other-primary",
			startedAt: AUG_20,
			closedAt: AUG_24,
			valueUsd: 420,
		}),
	],
	openWindow: null,
};

const firstObservedOpen: AccountUsageWindows = {
	accountId: "partial-open",
	accountName: "partial-open",
	provider: "ollama",
	windows: [],
	openWindow: openWindow({
		accountId: "partial-open",
		startedAt: AUG_24_1830,
		resetsAt: AUG_31_1830,
		grantType: "first_observed",
		valueSoFarUsd: 95,
		utilization: 4,
	}),
};

describe("window-value timeline helpers", () => {
	it("uses one fixed-now domain and deterministic weekly date ticks", () => {
		const domain = timeDomain([proPrimary, maxPrimary], NOW_MS);

		expect(domain).toEqual({ startMs: AUG_8, endMs: NOW_MS });
		expect(weeklyTimelineTicks(domain)).toEqual([
			{ atMs: AUG_8, label: "Aug 8" },
			{ atMs: AUG_8 + 7 * DAY_MS, label: "Aug 15" },
			{ atMs: AUG_8 + 14 * DAY_MS, label: "Aug 22" },
		]);
	});

	it("places closed segments in the shared time domain and clamps open segments at now", () => {
		const domain = { startMs: AUG_8, endMs: AUG_8 + 10 * DAY_MS };
		const closed = closedWindow({
			id: "geometry-closed",
			accountId: "geometry",
			startedAt: AUG_8 + 2 * DAY_MS,
			closedAt: AUG_8 + 5 * DAY_MS,
			valueUsd: 500,
		});
		const open = openWindow({
			accountId: "geometry",
			startedAt: AUG_8 + 6 * DAY_MS,
			resetsAt: AUG_8 + 12 * DAY_MS,
			valueSoFarUsd: 300,
			utilization: 40,
		});

		expect(timelineSegmentGeometry(closed, domain, domain.endMs)).toEqual({
			leftPercent: 20,
			widthPercent: 30,
		});
		expect(timelineSegmentGeometry(open, domain, domain.endMs)).toEqual({
			leftPercent: 60,
			widthPercent: 40,
		});
	});

	it("orders provider sections and sums each account's latest fully-consumed window", () => {
		const sections = groupByProvider([
			otherProvider,
			maxPrimary,
			proSecondary,
			proPrimary,
		]);

		expect(sections.map((section) => section.provider)).toEqual([
			"codex",
			"anthropic",
			"ollama",
		]);
		expect(
			sectionLastFullWindowSubtotal(
				sections.find((section) => section.provider === "codex")?.accounts ??
					[],
			),
		).toBeCloseTo(4_617.72, 2);
		expect(
			sectionLastFullWindowSubtotal(
				sections.find((section) => section.provider === "anthropic")
					?.accounts ?? [],
			),
		).toBe(3_000);
	});

	it("skips a most-recent partial row when choosing a section subtotal", () => {
		const partialIsNewest: AccountUsageWindows = {
			...maxPrimary,
			windows: [
				maxPrimary.windows[1],
				maxPrimary.windows[0],
				...maxPrimary.windows.slice(2),
			],
		};

		expect(sectionLastFullWindowSubtotal([partialIsNewest])).toBe(3_000);
		expect(sectionLastFullWindowSubtotal([partialIsNewest])).not.toBe(85);
	});

	it("excludes partial and first-observed rows from delta baselines and requires two priors", () => {
		const partialDelta = deltaVsPriorMedian(maxPrimary.windows, 1);
		const latestDelta = deltaVsPriorMedian(maxPrimary.windows, 0);
		const naiveDeltaIncludingThePartial = ((3_000 - 2_900) / 2_900) * 100;

		expect(partialDelta).toBeNull();
		expect(latestDelta).toBeCloseTo(-0.17, 2);
		expect(latestDelta).not.toBeCloseTo(naiveDeltaIncludingThePartial, 1);

		// The first-observed $1,960 floor cannot affect pro-primary's baseline.
		expect(deltaVsPriorMedian(proPrimary.windows, 0)).toBeCloseTo(41.9, 1);
		expect(deltaVsPriorMedian(proPrimary.windows, 1)).toBeNull();
		expect(deltaVsPriorMedian(proPrimary.windows, 3)).toBeNull();
	});
});

describe("WindowValueTimeline", () => {
	it("renders provider sections, muted partials, lower bounds, bonus-reset markers, and detailed titles", () => {
		const html = renderToString(
			<WindowValueTimeline
				accounts={[
					proPrimary,
					proSecondary,
					maxPrimary,
					otherProvider,
					firstObservedOpen,
				]}
				nowMs={NOW_MS}
			/>,
		);

		expect(html.indexOf("Codex Pro")).toBeLessThan(html.indexOf("Claude Max"));
		expect(html).toContain("last full window: $4,617.72");
		expect(html).toContain("window-value-segment--partial");
		expect(html).toContain("$85.00 · 6% used");
		expect(html).toContain("window-value-segment--early-reset");
		expect(html).toContain("bonus reset");
		expect(html).toContain("≥ $2k");
		expect(html).toContain("≥ $95.00");
		expect(html).toMatch(
			/title="[^"]*Aug 18[^"]*Aug 19[^"]*\$85\.00[^"]*6%[^"]*natural[^"]*"/,
		);
	});

	it("keeps lower bounds in titles and floats labels for too-narrow segments", () => {
		const html = renderToString(
			<WindowValueTimeline
				accounts={[
					proPrimary,
					proSecondary,
					maxPrimary,
					otherProvider,
					firstObservedOpen,
				]}
				nowMs={NOW_MS}
			/>,
		);

		// Tooltips carry the ≥ floor for first-observed values, closed and open —
		// an observational floor must never read as an exact grant anywhere.
		expect(html).toMatch(
			/title="[^"]*Aug 8[^"]*≥ \$1,960\.00[^"]*partial[^"]*"/,
		);
		expect(html).toMatch(/title="[^"]*≥ \$95\.00[^"]*open[^"]*"/);

		// The one-day $85/6% window (~5.9% of the Aug 8→25 domain) cannot fit
		// its own label inside the clipped segment; it must float as a callout
		// chip so the "6% used" qualifier is never truncated away.
		expect(html).toMatch(
			/window-value-segment-label--outside[^>]*>[^<]*\$85\.00 · 6% used/,
		);
		// Wide windows keep their inline label.
		expect(html).toContain('class="truncate">$3.1k');
	});
});
