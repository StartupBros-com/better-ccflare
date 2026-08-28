import { describe, expect, test } from "bun:test";
import { createHeapStatsHandler, createRssHandler } from "../debug";

const memory = {
	rss: 101,
	heapTotal: 102,
	heapUsed: 103,
	external: 104,
	arrayBuffers: 105,
	startupRss: 100,
	peakRss: 110,
	rssGrowth: 1,
	uptimeSeconds: 12,
	lifecycle: {
		bodyAdmission: {
			activeLeases: 2,
			reservedBytes: 30,
			queuedRequests: 1,
		},
		trackedStreams: 4,
		pendingRequests: 5,
	},
};

describe("debug memory handlers", () => {
	test("RSS endpoint retains its legacy fields and exposes the supported aggregate snapshot", async () => {
		const body = (await createRssHandler(() => memory)().json()) as Record<
			string,
			unknown
		>;

		expect(body.rss_bytes).toBe(101);
		expect(body.uptime_s).toBe(12);
		expect(body.memory).toEqual(memory);
	});

	test("heap endpoint exposes the same supported aggregate snapshot without creating a heap snapshot", async () => {
		const body = (await createHeapStatsHandler(
			() => memory,
		)().json()) as Record<string, unknown>;

		expect(body.memory).toEqual(memory);
		expect(body.heap).toBeDefined();
	});
});
