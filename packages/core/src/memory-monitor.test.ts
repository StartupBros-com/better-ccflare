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

test("reports fixed maintenance balances and writer ownership without arbitrary fields", () => {
	const monitor = new MemoryMonitor({ readMemoryUsage: () => usage(100) });
	const owner = {
		workersAcquired: 3,
		workersRetired: 2,
		objectUrlsAcquired: 3,
		objectUrlsRevoked: 2,
		activeJobs: 0,
		queuedJobs: 0,
		closing: false,
		retiring: false,
		held: false,
		source: "secret",
	};
	const result = monitor.snapshot({
		maintenance: {
			periodic: owner,
			compaction: {
				...owner,
				workersAcquired: 0,
				workersRetired: 0,
				objectUrlsAcquired: 0,
				objectUrlsRevoked: 0,
			},
		},
		writer: {
			metadataQueuedJobs: 2,
			payloadQueuedJobs: 0,
			payloadBytesPending: 8192,
			requestId: "secret",
		},
	} as never);
	expect(result.lifecycle?.maintenance?.periodic).toEqual({
		workersAcquired: 3,
		workersRetired: 2,
		workersLive: 1,
		objectUrlsAcquired: 3,
		objectUrlsRevoked: 2,
		objectUrlsLive: 1,
		activeJobs: 0,
		queuedJobs: 0,
		closing: false,
		retiring: false,
		held: false,
	});
	expect(result.lifecycle?.writer).toEqual({
		metadataQueuedJobs: 2,
		payloadQueuedJobs: 0,
		payloadBytesPending: 8192,
	});
	expect(JSON.stringify(result)).not.toContain("secret");
});

test("sanitizes resource gauges and keeps cheap JSC metrics independent", () => {
	const monitor = new MemoryMonitor({
		readMemoryUsage: () => usage(100),
		readJscMemoryUsage: () => ({
			heapSize: 17,
			current: 25,
			peak: 30,
			currentCommit: 40,
			peakCommit: 45,
			pageFaults: 2,
			extraMemorySize: 999,
		}),
	} as never);
	const result = monitor.snapshot({
		maintenance: {
			periodic: {
				workersAcquired: NaN,
				workersRetired: -4,
				objectUrlsAcquired: Infinity,
				objectUrlsRevoked: 0,
				activeJobs: 1,
				queuedJobs: 0,
				closing: false,
				retiring: true,
				held: true,
			},
		},
		writer: {
			metadataQueuedJobs: -1,
			payloadQueuedJobs: NaN,
			payloadBytesPending: Infinity,
		},
	} as never);
	expect(result.jsc).toEqual({
		heapSize: 17,
		current: 25,
		peak: 30,
		currentCommit: 40,
		peakCommit: 45,
		pageFaults: 2,
	});
	expect(result.lifecycle?.maintenance?.periodic.workersLive).toBe(0);
	expect(result.lifecycle?.writer).toEqual({
		metadataQueuedJobs: 0,
		payloadQueuedJobs: 0,
		payloadBytesPending: 0,
	});
	expect(Object.keys(result.jsc ?? {}).sort()).toEqual([
		"current",
		"currentCommit",
		"heapSize",
		"pageFaults",
		"peak",
		"peakCommit",
	]);
});
