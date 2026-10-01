import type {
	MemoryMaintenanceOwnerSnapshot,
	MemorySnapshot,
} from "@better-ccflare/types";

export type MemoryUsageSample = Readonly<{
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	arrayBuffers: number;
}>;

export type MemoryLifecycleSnapshot = NonNullable<MemorySnapshot["lifecycle"]>;

type MaintenanceSample = Omit<
	MemoryMaintenanceOwnerSnapshot,
	"workersLive" | "objectUrlsLive"
>;
export type MemoryLifecycleSample = Omit<
	MemoryLifecycleSnapshot,
	"maintenance"
> & {
	maintenance?: {
		periodic?: MaintenanceSample;
		compaction?: MaintenanceSample;
	};
};
export type JscMemorySample = NonNullable<MemorySnapshot["jsc"]>;

export type MemoryMonitorOptions = Readonly<{
	readMemoryUsage?: () => MemoryUsageSample;
	readUptimeSeconds?: () => number;
	readJscMemoryUsage?: () => JscMemorySample;
}>;

function count(value: number): number {
	return Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
		: 0;
}
function maintenanceOwner(
	value: MaintenanceSample | undefined,
): MemoryMaintenanceOwnerSnapshot | undefined {
	if (!value) return undefined;
	const workersAcquired = count(value.workersAcquired),
		workersRetired = count(value.workersRetired),
		objectUrlsAcquired = count(value.objectUrlsAcquired),
		objectUrlsRevoked = count(value.objectUrlsRevoked);
	return {
		workersAcquired,
		workersRetired,
		workersLive: Math.max(0, workersAcquired - workersRetired),
		objectUrlsAcquired,
		objectUrlsRevoked,
		objectUrlsLive: Math.max(0, objectUrlsAcquired - objectUrlsRevoked),
		activeJobs: count(value.activeJobs),
		queuedJobs: count(value.queuedJobs),
		closing: value.closing === true,
		retiring: value.retiring === true,
		held: value.held === true,
	};
}
function allowListedLifecycle(
	lifecycle: MemoryLifecycleSample | undefined,
): MemoryLifecycleSnapshot | undefined {
	if (!lifecycle) return undefined;
	const periodic = maintenanceOwner(lifecycle.maintenance?.periodic),
		compaction = maintenanceOwner(lifecycle.maintenance?.compaction);
	const bodyAdmission = lifecycle.bodyAdmission
		? {
				activeLeases: count(lifecycle.bodyAdmission.activeLeases),
				reservedBytes: count(lifecycle.bodyAdmission.reservedBytes),
				queuedRequests: count(lifecycle.bodyAdmission.queuedRequests),
			}
		: undefined;
	const writer = lifecycle.writer
		? {
				metadataQueuedJobs: count(lifecycle.writer.metadataQueuedJobs),
				payloadQueuedJobs: count(lifecycle.writer.payloadQueuedJobs),
				payloadBytesPending: count(lifecycle.writer.payloadBytesPending),
			}
		: undefined;
	const result = {
		...(bodyAdmission ? { bodyAdmission } : {}),
		...(writer ? { writer } : {}),
		...(periodic || compaction
			? {
					maintenance: {
						...(periodic ? { periodic } : {}),
						...(compaction ? { compaction } : {}),
					},
				}
			: {}),
		...(lifecycle.trackedStreams !== undefined
			? { trackedStreams: count(lifecycle.trackedStreams) }
			: {}),
		...(lifecycle.pendingRequests !== undefined
			? { pendingRequests: count(lifecycle.pendingRequests) }
			: {}),
	};
	return Object.keys(result).length ? result : undefined;
}
function jscSample(
	read: (() => JscMemorySample) | undefined,
): JscMemorySample | undefined {
	if (!read) return undefined;
	try {
		const value = read();
		return {
			heapSize: count(value.heapSize),
			current: count(value.current),
			peak: count(value.peak),
			currentCommit: count(value.currentCommit),
			peakCommit: count(value.peakCommit),
			pageFaults: count(value.pageFaults),
		};
	} catch {
		return undefined;
	}
}

/**
 * Holds a restart-scoped RSS baseline and monotonic peak while leaving every
 * sample source injectable. `external` already includes `arrayBuffers`; the
 * snapshot deliberately reports both separately and never invents a summed
 * native-memory metric.
 */
export class MemoryMonitor {
	private readonly readMemoryUsage: () => MemoryUsageSample;
	private readonly readUptimeSeconds: () => number;
	private readonly readJscMemoryUsage?: () => JscMemorySample;
	private readonly startupRss: number;
	private peakRss: number;

	constructor({
		readMemoryUsage = () => process.memoryUsage(),
		readUptimeSeconds = () => process.uptime(),
		readJscMemoryUsage,
	}: MemoryMonitorOptions = {}) {
		this.readMemoryUsage = readMemoryUsage;
		this.readUptimeSeconds = readUptimeSeconds;
		this.readJscMemoryUsage = readJscMemoryUsage;
		this.startupRss = this.readMemoryUsage().rss;
		this.peakRss = this.startupRss;
	}

	snapshot(lifecycle?: MemoryLifecycleSample): MemorySnapshot {
		const memory = this.readMemoryUsage();
		this.peakRss = Math.max(this.peakRss, memory.rss);

		const allowedLifecycle = allowListedLifecycle(lifecycle);
		const jsc = jscSample(this.readJscMemoryUsage);
		return {
			rss: memory.rss,
			heapTotal: memory.heapTotal,
			heapUsed: memory.heapUsed,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
			startupRss: this.startupRss,
			peakRss: this.peakRss,
			rssGrowth: memory.rss - this.startupRss,
			uptimeSeconds: this.readUptimeSeconds(),
			...(jsc ? { jsc } : {}),
			...(allowedLifecycle ? { lifecycle: allowedLifecycle } : {}),
		};
	}
}
