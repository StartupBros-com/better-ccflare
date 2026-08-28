import type { MemorySnapshot } from "@better-ccflare/types";

export type MemoryUsageSample = Readonly<{
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	arrayBuffers: number;
}>;

export type MemoryLifecycleSnapshot = NonNullable<MemorySnapshot["lifecycle"]>;

export type MemoryMonitorOptions = Readonly<{
	readMemoryUsage?: () => MemoryUsageSample;
	readUptimeSeconds?: () => number;
}>;

function allowListedLifecycle(
	lifecycle: MemoryLifecycleSnapshot | undefined,
): MemoryLifecycleSnapshot | undefined {
	if (!lifecycle) return undefined;

	const bodyAdmission = lifecycle.bodyAdmission
		? {
				activeLeases: lifecycle.bodyAdmission.activeLeases,
				reservedBytes: lifecycle.bodyAdmission.reservedBytes,
				queuedRequests: lifecycle.bodyAdmission.queuedRequests,
			}
		: undefined;
	const hasCounts =
		lifecycle.trackedStreams !== undefined ||
		lifecycle.pendingRequests !== undefined;
	if (!bodyAdmission && !hasCounts) return undefined;

	return {
		...(bodyAdmission ? { bodyAdmission } : {}),
		...(lifecycle.trackedStreams !== undefined
			? { trackedStreams: lifecycle.trackedStreams }
			: {}),
		...(lifecycle.pendingRequests !== undefined
			? { pendingRequests: lifecycle.pendingRequests }
			: {}),
	};
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
	private readonly startupRss: number;
	private peakRss: number;

	constructor({
		readMemoryUsage = () => process.memoryUsage(),
		readUptimeSeconds = () => process.uptime(),
	}: MemoryMonitorOptions = {}) {
		this.readMemoryUsage = readMemoryUsage;
		this.readUptimeSeconds = readUptimeSeconds;
		this.startupRss = this.readMemoryUsage().rss;
		this.peakRss = this.startupRss;
	}

	snapshot(lifecycle?: MemoryLifecycleSnapshot): MemorySnapshot {
		const memory = this.readMemoryUsage();
		this.peakRss = Math.max(this.peakRss, memory.rss);

		const allowedLifecycle = allowListedLifecycle(lifecycle);
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
			...(allowedLifecycle ? { lifecycle: allowedLifecycle } : {}),
		};
	}
}
