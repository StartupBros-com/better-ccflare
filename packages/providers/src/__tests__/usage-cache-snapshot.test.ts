import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const ACCOUNT_ID = "usage-snapshot-test";
const START = Date.UTC(2026, 6, 17, 12, 0, 0);
const realDateNow = Date.now;

afterEach(() => {
	Date.now = realDateNow;
	usageCache.delete(ACCOUNT_ID);
});

describe("UsageCache snapshots", () => {
	it("exposes cached data with its observation timestamp", () => {
		Date.now = () => START;
		const data = {
			five_hour: { utilization: 25, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
		};

		usageCache.set(ACCOUNT_ID, data);

		const snapshot = usageCache.getSnapshot(ACCOUNT_ID);
		expect(snapshot).toEqual({ data, observedAt: START });
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it("keeps getSnapshot on the same ten-minute freshness boundary as get", () => {
		let now = START;
		Date.now = () => now;
		const data = {
			five_hour: { utilization: 25, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
		};
		usageCache.set(ACCOUNT_ID, data);

		now += 9 * 60 * 1000;
		expect(usageCache.getSnapshot(ACCOUNT_ID)).toEqual({
			data,
			observedAt: START,
		});
		expect(usageCache.get(ACCOUNT_ID)).toBe(data);

		now += 2 * 60 * 1000;
		expect(usageCache.getSnapshot(ACCOUNT_ID)).toBeNull();
		expect(usageCache.get(ACCOUNT_ID)).toBeNull();
	});
});
