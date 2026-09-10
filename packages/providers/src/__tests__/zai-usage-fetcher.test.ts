import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getRepresentativeUsageResetMs,
	getRepresentativeUsageSnapshotForProvider,
} from "../usage-fetcher";
import {
	fetchZaiUsageData,
	getRepresentativeZaiUtilization,
	getRepresentativeZaiWindow,
} from "../zai-usage-fetcher";

const SHORT_RESET = 1_788_455_420_775;
const WEEKLY_RESET = 1_789_005_906_998;
const SHORT = {
	type: "TOKENS_LIMIT",
	unit: 3,
	number: 5,
	percentage: 1,
	nextResetTime: SHORT_RESET,
};
const WEEKLY = {
	type: "TOKENS_LIMIT",
	unit: 6,
	number: 1,
	percentage: 2,
	nextResetTime: WEEKLY_RESET,
};
const TIME = {
	type: "TIME_LIMIT",
	unit: 5,
	number: 1,
	usage: 1000,
	currentValue: 0,
	remaining: 1000,
	percentage: 0,
	nextResetTime: 1_790_733_906_999,
};

function body(limits: unknown[]) {
	return {
		code: 200,
		msg: "Operation successful",
		success: true,
		data: { level: "pro", limits },
	};
}

function stubFetch(payload: unknown): void {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

describe("Zai usage fetcher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		["short first", [SHORT, WEEKLY, TIME]],
		["weekly first", [WEEKLY, TIME, SHORT]],
	] as const)("retains both token windows when %s", async (_label, limits) => {
		stubFetch(body([...limits]));
		const usage = await fetchZaiUsageData("fixture-key");
		expect(usage?.tokens_limit).toMatchObject({
			percentage: 1,
			resetAt: SHORT_RESET,
			type: "tokens_limit",
		});
		expect(usage?.tokens_limit_weekly).toMatchObject({
			percentage: 2,
			resetAt: WEEKLY_RESET,
			type: "tokens_limit_weekly",
		});
	});

	it("keeps single-token-window payloads compatible", async () => {
		stubFetch(body([SHORT]));
		const usage = await fetchZaiUsageData("fixture-key");
		expect(usage?.tokens_limit?.resetAt).toBe(SHORT_RESET);
		expect(usage?.tokens_limit_weekly).toBeNull();
		expect(getRepresentativeZaiWindow(usage)).toBe("five_hour");
	});

	it("pairs utilization and reset from the most utilized token window", async () => {
		stubFetch(
			body([
				{ ...SHORT, percentage: 40 },
				{ ...WEEKLY, percentage: 90 },
			]),
		);
		const usage = await fetchZaiUsageData("fixture-key");
		expect(getRepresentativeZaiUtilization(usage)).toBe(90);
		expect(getRepresentativeZaiWindow(usage)).toBe("seven_day");
		expect(getRepresentativeUsageResetMs(usage, "zai")).toBe(WEEKLY_RESET);
		expect(getRepresentativeUsageSnapshotForProvider(usage!, "zai")).toEqual({
			utilization: 90,
			resetMs: WEEKLY_RESET,
		});
	});

	it("breaks equal-utilization ties with the later reset and preserves overage", async () => {
		stubFetch(
			body([
				{ ...SHORT, percentage: 120 },
				{ ...WEEKLY, percentage: 120 },
			]),
		);
		const usage = await fetchZaiUsageData("fixture-key");
		expect(getRepresentativeZaiUtilization(usage)).toBe(120);
		expect(getRepresentativeZaiWindow(usage)).toBe("seven_day");
		expect(getRepresentativeUsageSnapshotForProvider(usage!, "zai")).toEqual({
			utilization: 120,
			resetMs: WEEKLY_RESET,
		});
	});
});
