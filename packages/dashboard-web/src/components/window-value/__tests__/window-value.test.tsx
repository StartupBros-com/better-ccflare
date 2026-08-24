import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AccountWindowValueCard } from "../AccountWindowValueCard";
import {
	deltaVsPriorMedian,
	fleetOpenWindowSummary,
	formatCountdown,
	formatWindowValue,
	sortAccountsByWindowValue,
} from "../window-value-utils";

type GrantType = "natural" | "early_reset" | "first_observed";

interface ClosedWindowFixture {
	id: string;
	accountId: string;
	windowKey: "seven_day";
	startedAt: number;
	resetsAt: number;
	closedAt: number;
	grantType: GrantType;
	peakUtilization: number;
	first100At: number | null;
	valueUsd: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	requestCount: number;
	modelBreakdown: Record<string, unknown>;
	unpricedTokens: number;
	projectionVersion: string;
}

interface OpenWindowFixture
	extends Omit<ClosedWindowFixture, "closedAt" | "valueUsd"> {
	closedAt: null;
	valueUsd: null;
	valueSoFarUsd: number;
	utilization: number;
	ageHours: number;
}

interface AccountUsageWindowsFixture {
	accountId: string;
	accountName: string;
	provider: string;
	windows: ClosedWindowFixture[];
	openWindow: OpenWindowFixture | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.UTC(2026, 7, 24, 12, 0, 0);

function closedWindow(
	id: string,
	accountId: string,
	grantType: GrantType,
	valueUsd: number,
	resetsAt: number,
	unpricedTokens = 0,
): ClosedWindowFixture {
	return {
		id,
		accountId,
		windowKey: "seven_day",
		startedAt: resetsAt - 7 * DAY_MS,
		resetsAt,
		closedAt: resetsAt,
		grantType,
		peakUtilization: 100,
		first100At: resetsAt - HOUR_MS,
		valueUsd,
		inputTokens: 10_000_000,
		cacheReadInputTokens: 5_000_000,
		cacheCreationInputTokens: 1_000_000,
		outputTokens: 500_000,
		requestCount: 100,
		modelBreakdown: {},
		unpricedTokens,
		projectionVersion: "v1",
	};
}

function openWindow(
	accountId: string,
	valueSoFarUsd: number,
	utilization: number,
	resetsAt: number,
): OpenWindowFixture {
	return {
		id: `${accountId}-open`,
		accountId,
		windowKey: "seven_day",
		startedAt: NOW_MS - 4 * DAY_MS,
		resetsAt,
		closedAt: null,
		grantType: "natural",
		peakUtilization: utilization,
		first100At: null,
		valueUsd: null,
		inputTokens: 5_000_000,
		cacheReadInputTokens: 2_500_000,
		cacheCreationInputTokens: 500_000,
		outputTokens: 250_000,
		requestCount: 50,
		modelBreakdown: {},
		unpricedTokens: 0,
		projectionVersion: "v1",
		valueSoFarUsd,
		utilization,
		ageHours: 96,
	};
}

// API order is newest first, matching GET /api/usage-windows.
const proPrimary: AccountUsageWindowsFixture = {
	accountId: "pro-primary",
	accountName: "pro-primary",
	provider: "codex",
	windows: [
		closedWindow(
			"primary-w4",
			"pro-primary",
			"natural",
			2_962.44,
			NOW_MS - DAY_MS,
		),
		closedWindow(
			"primary-w3",
			"pro-primary",
			"early_reset",
			1_653.13,
			NOW_MS - 8 * DAY_MS,
		),
		closedWindow(
			"primary-w2",
			"pro-primary",
			"natural",
			2_522.09,
			NOW_MS - 15 * DAY_MS,
		),
		closedWindow(
			"primary-w1",
			"pro-primary",
			"first_observed",
			1_100,
			NOW_MS - 22 * DAY_MS,
		),
	],
	openWindow: openWindow(
		"pro-primary",
		812.55,
		34,
		NOW_MS + 2 * DAY_MS + 14 * HOUR_MS,
	),
};

const proSecondary: AccountUsageWindowsFixture = {
	accountId: "pro-secondary",
	accountName: "pro-secondary",
	provider: "codex",
	windows: [
		closedWindow(
			"secondary-w1",
			"pro-secondary",
			"natural",
			1_655.28,
			NOW_MS - DAY_MS,
			5_000_000,
		),
	],
	openWindow: openWindow("pro-secondary", 95, 4, NOW_MS + 3 * DAY_MS),
};

const maxTertiary: AccountUsageWindowsFixture = {
	accountId: "max-tertiary",
	accountName: "max-tertiary",
	provider: "anthropic",
	windows: [
		closedWindow(
			"tertiary-w3",
			"max-tertiary",
			"natural",
			2_587,
			NOW_MS - DAY_MS,
		),
		closedWindow(
			"tertiary-w2",
			"max-tertiary",
			"natural",
			2_608,
			NOW_MS - 8 * DAY_MS,
		),
		closedWindow(
			"tertiary-w1",
			"max-tertiary",
			"natural",
			3_179,
			NOW_MS - 15 * DAY_MS,
		),
	],
	openWindow: null,
};

describe("AccountWindowValueCard", () => {
	it("renders primary values, grant badges, and a lower bound for a partial window", () => {
		const html = renderToString(
			<AccountWindowValueCard account={proPrimary} nowMs={NOW_MS} />,
		);

		expect(html).toContain("pro-primary");
		expect(html).toContain("$2,962.44");
		expect(html).toContain("$1,653.13");
		expect(html).toContain("bonus reset");
		expect(html).toContain("partial");
		expect(html).toMatch(/(?:≥|&gt;=|>=)\s*\$1,100\.00/);
	});

	it("shows the live value and a deterministic reset countdown", () => {
		const html = renderToString(
			<AccountWindowValueCard account={proPrimary} nowMs={NOW_MS} />,
		);

		expect(formatWindowValue(812.55)).toBe("$812.55");
		expect(formatCountdown(proPrimary.openWindow?.resetsAt ?? 0, NOW_MS)).toBe(
			"2d 14h",
		);
		expect(html).toContain("$812.55");
		expect(html).toContain("resets in 2d 14h");
	});

	it("renders the no-live-window state without crashing", () => {
		const html = renderToString(
			<AccountWindowValueCard account={maxTertiary} nowMs={NOW_MS} />,
		);

		expect(html).toContain("no live window");
	});

	it("renders a first-observed open window's live value as a lower bound", () => {
		// A ledger that first saw this account mid-cycle only knows a floor for
		// the live window — presenting it as exact would overstate a screenshot.
		const partialOpen: AccountUsageWindowsFixture = {
			...proPrimary,
			openWindow: {
				...(proPrimary.openWindow as OpenWindowFixture),
				grantType: "first_observed",
			},
		};

		const partialHtml = renderToString(
			<AccountWindowValueCard account={partialOpen} nowMs={NOW_MS} />,
		);
		expect(partialHtml).toMatch(/(?:≥|&gt;=|>=)\s*\$812\.55/);

		// The natural open window keeps its exact presentation.
		const naturalHtml = renderToString(
			<AccountWindowValueCard account={proPrimary} nowMs={NOW_MS} />,
		);
		expect(naturalHtml).not.toMatch(/(?:≥|&gt;=|>=)\s*\$812\.55/);
	});

	it("does not render a delta chip for a single closed window but flags unpriced usage", () => {
		const html = renderToString(
			<AccountWindowValueCard account={proSecondary} nowMs={NOW_MS} />,
		);

		expect(html).not.toContain("Δ");
		expect(html).toContain("unpriced");
	});
});

describe("window-value utilities", () => {
	it("compares a natural window against only earlier qualifying windows", () => {
		// W4's priors are W3 + W2: W1 is first_observed and must be excluded.
		const w4Delta = deltaVsPriorMedian(proPrimary.windows, 0);
		expect(w4Delta).not.toBeNull();
		expect(w4Delta).toBeCloseTo(41.9, 1);

		// W3 has only W2 as a qualifying earlier window, so it has no baseline.
		expect(deltaVsPriorMedian(proPrimary.windows, 1)).toBeNull();
		// A first-observed row never gets a delta, even if later data exists.
		expect(deltaVsPriorMedian(proPrimary.windows, 3)).toBeNull();
	});

	it("sums fleet live value and marks it a lower bound only when a partial window is included", () => {
		const exact = fleetOpenWindowSummary([
			proPrimary,
			proSecondary,
			maxTertiary,
		]);
		expect(exact.totalUsd).toBeCloseTo(907.55, 10);
		expect(exact.liveCount).toBe(2);
		expect(exact.isLowerBound).toBe(false);

		const withPartial = fleetOpenWindowSummary([
			{
				...proPrimary,
				openWindow: {
					...(proPrimary.openWindow as OpenWindowFixture),
					grantType: "first_observed",
				},
			},
			proSecondary,
		]);
		expect(withPartial.totalUsd).toBeCloseTo(907.55, 10);
		expect(withPartial.liveCount).toBe(2);
		expect(withPartial.isLowerBound).toBe(true);
	});

	it("orders live accounts by open value before accounts with no live window", () => {
		const sorted = sortAccountsByWindowValue([
			maxTertiary,
			proSecondary,
			proPrimary,
		]);

		expect(sorted.map((account) => account.accountId)).toEqual([
			"pro-primary",
			"pro-secondary",
			"max-tertiary",
		]);
	});
});
