import { describe, expect, test } from "bun:test";
import { MemoryMonitor } from "./memory-monitor";

function usage(rss: number) {
	return {
		rss,
		heapTotal: 20,
		heapUsed: 10,
		external: 8,
		arrayBuffers: 3,
	};
}

describe("MemoryMonitor", () => {
	test("reports raw bytes with a zero-growth startup baseline", () => {
		const samples = [usage(100), usage(100)];
		const monitor = new MemoryMonitor({
			readMemoryUsage: () => samples.shift() ?? usage(100),
			readUptimeSeconds: () => 0,
		});

		expect(monitor.snapshot()).toEqual({
			rss: 100,
			heapTotal: 20,
			heapUsed: 10,
			external: 8,
			arrayBuffers: 3,
			startupRss: 100,
			peakRss: 100,
			rssGrowth: 0,
			uptimeSeconds: 0,
		});
	});

	test("keeps the RSS peak monotonic while current growth follows the current sample", () => {
		const samples = [usage(100), usage(140), usage(120)];
		const monitor = new MemoryMonitor({
			readMemoryUsage: () => samples.shift() ?? usage(120),
			readUptimeSeconds: () => 5,
		});

		expect(monitor.snapshot()).toMatchObject({
			rss: 140,
			startupRss: 100,
			peakRss: 140,
			rssGrowth: 40,
			uptimeSeconds: 5,
		});
		expect(monitor.snapshot()).toMatchObject({
			rss: 120,
			startupRss: 100,
			peakRss: 140,
			rssGrowth: 20,
		});
	});

	test("allow-lists aggregate lifecycle counts without request identifiers", () => {
		const monitor = new MemoryMonitor({
			readMemoryUsage: () => usage(100),
			readUptimeSeconds: () => 1,
		});

		const snapshot = monitor.snapshot({
			bodyAdmission: {
				activeLeases: 2,
				reservedBytes: 30,
				queuedRequests: 1,
				accountId: "must-not-leak",
			},
			trackedStreams: 4,
			pendingRequests: 5,
			path: "/v1/messages",
		} as unknown as Parameters<typeof monitor.snapshot>[0]);

		expect(snapshot.lifecycle).toEqual({
			bodyAdmission: {
				activeLeases: 2,
				reservedBytes: 30,
				queuedRequests: 1,
			},
			trackedStreams: 4,
			pendingRequests: 5,
		});
		expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
		expect(JSON.stringify(snapshot)).not.toContain("/v1/messages");
	});
});
