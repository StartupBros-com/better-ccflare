import type { TimePoint } from "@better-ccflare/types";
import type { TimeRange } from "../../constants";

/** Shared per-model chart pivot. Keep locale-label buckets and last-write wins. */
export function buildModelTimeSeries(
	points: TimePoint[],
	timeRange: TimeRange,
	getValue: (point: TimePoint) => number,
): {
	data: Array<{ time: string; [model: string]: string | number }>;
	models: string[];
} {
	const grouped: Record<
		string,
		{ time: string; [model: string]: string | number }
	> = {};
	const models = new Set<string>();
	const timeToTimestamp = new Map<string, number>();
	const formatTime = (ts: number) =>
		timeRange === "30d"
			? new Date(ts).toLocaleDateString()
			: new Date(ts).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				});

	points.forEach((point) => {
		if (point.model) {
			models.add(point.model);
			// Repeated labels retain their last timestamp for chronological sorting.
			timeToTimestamp.set(formatTime(point.ts), point.ts);
		}
	});

	const sortedTimes = Array.from(timeToTimestamp.keys()).sort(
		(a, b) => (timeToTimestamp.get(a) || 0) - (timeToTimestamp.get(b) || 0),
	);
	const sortedModels = Array.from(models).sort();
	for (const time of sortedTimes) {
		grouped[time] = { time };
		for (const model of sortedModels) grouped[time][model] = 0;
	}

	points.forEach((point) => {
		if (point.model) {
			grouped[formatTime(point.ts)][point.model] = getValue(point);
		}
	});

	return {
		data: sortedTimes.map((time) => grouped[time]),
		models: sortedModels,
	};
}
