import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { UseQueryOptions } from "@tanstack/react-query";
import * as reactQuery from "@tanstack/react-query";
import * as react from "react";
import { api, type RequestPayload, type RequestSummary } from "../../api";
import { queryKeys } from "../../lib/query-keys";

const { QueryClient, QueryObserver } = reactQuery;
let queryClient: InstanceType<typeof QueryClient>;
const effects: Array<() => undefined | (() => void)> = [];
const cleanups: Array<() => void> = [];
mock.module("react", () => ({
	...react,
	useCallback: <T>(callback: T) => callback,
	useEffect: (effect: () => undefined | (() => void)) => effects.push(effect),
}));
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useQuery: (options: unknown) => options,
	useQueryClient: () => queryClient,
}));
const { useRequests, summaryToPlaceholder } = await import("../queries");
const { captureRequestUpdates, cleanupRequestStream, useRequestStream } =
	await import("../useRequestStream");

type RequestsData = {
	requests: RequestPayload[];
	detailsMap: Map<string, RequestSummary>;
};
const originalGlobals = new Map(
	["EventSource", "document", "window"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
class FakeEventSource extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];
	readyState = FakeEventSource.CONNECTING;
	constructor(readonly url: string) {
		super();
		FakeEventSource.instances.push(this);
	}
	open() {
		this.readyState = FakeEventSource.OPEN;
		this.dispatchEvent(new Event("open"));
	}
	close() {
		this.readyState = FakeEventSource.CLOSED;
	}
	message(data: unknown) {
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(data) }),
		);
	}
}
function RequestsTestComponent(limit: number) {
	useRequestStream(limit);
	return null;
}
function mountStream(limit: number) {
	effects.length = 0;
	RequestsTestComponent(limit);
	const stops = effects.map((effect) => effect());
	const stop = () => {
		for (const cleanup of stops) cleanup?.();
	};
	cleanups.push(stop);
	const source = FakeEventSource.instances.at(-1);
	if (!source) throw new Error("Stream was not created");
	source.open();
	return { source, stop };
}
function RequestsQueryTestComponent(limit: number) {
	return useRequests(limit) as unknown as UseQueryOptions<RequestsData>;
}
function observe(limit: number) {
	const observer = new QueryObserver(
		queryClient,
		RequestsQueryTestComponent(limit),
	);
	const stop = observer.subscribe(() => {});
	cleanups.push(stop);
	return { observer, stop };
}
function summary(id: string, timestamp = 1, statusCode = 200): RequestSummary {
	return {
		id,
		timestamp: new Date(timestamp).toISOString(),
		statusCode,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		success: statusCode < 400,
		rateLimited: statusCode === 429,
		errorMessage: null,
		responseTimeMs: 20,
		failoverAttempts: 0,
	};
}
function start(id: string, timestamp: number) {
	return {
		type: "start",
		id,
		timestamp,
		method: "POST",
		path: "/v1/messages",
		accountId: null,
		statusCode: 0,
		agentUsed: "reviewer",
		agentAttributionSource: "header",
	};
}
function seed(limit: number, summaries: RequestSummary[]) {
	queryClient.setQueryData(queryKeys.requests(limit), {
		requests: summaries.map(summaryToPlaceholder),
		detailsMap: new Map(summaries.map((item) => [item.id, item])),
	});
}
function cached(limit: number) {
	const data = queryClient.getQueryData<RequestsData>(
		queryKeys.requests(limit),
	);
	if (!data) throw new Error("Requests cache is empty");
	return data;
}
async function flush() {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}
function pendingSnapshots() {
	const resolvers: Array<(summaries: RequestSummary[]) => void> = [];
	const fetch = spyOn(api, "getRequestsSummary").mockImplementation(
		() => new Promise((resolve) => resolvers.push(resolve)),
	);
	return {
		fetch,
		resolve: async (
			attempt: number,
			summaries: RequestSummary[],
			calls = attempt,
		) => {
			expect(resolvers).toHaveLength(calls);
			resolvers[attempt - 1](summaries);
			await flush();
		},
	};
}
beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity, retry: false } },
	});
	for (const [key, value] of [
		["EventSource", FakeEventSource],
		[
			"document",
			Object.assign(new EventTarget(), { visibilityState: "visible" }),
		],
		["window", new EventTarget()],
	] as const)
		Object.defineProperty(globalThis, key, { configurable: true, value });
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	cleanupRequestStream();
	queryClient.clear();
	FakeEventSource.instances.length = 0;
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	mock.restore();
});

describe("SSE snapshot cache recovery with real QueryObserver", () => {
	it("refreshes retained Infinity history on a new pool's first open after remount", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([
			summary("before"),
		]);
		seed(10, [summary("before")]);
		const firstObserver = observe(10);
		const firstStream = mountStream(10);
		await flush();
		firstObserver.stop();
		firstStream.stop();
		const callsBeforeRemount = fetch.mock.calls.length;
		fetch.mockResolvedValue([summary("missed-while-unmounted")]);
		const secondObserver = observe(10);
		expect(fetch).toHaveBeenCalledTimes(callsBeforeRemount);
		mountStream(10);
		await flush();
		expect(fetch).toHaveBeenCalledTimes(callsBeforeRemount + 1);
		expect(cached(10).requests[0].id).toBe("missed-while-unmounted");
		expect(secondObserver.observer.getCurrentResult().data).toBe(cached(10));
		expect(RequestsQueryTestComponent(10).refetchInterval).toBe(false);
	});
	it("retains a request pending before refetch and accepts its later summary", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([]);
		seed(10, [summary("old-completed")]);
		const { source } = mountStream(10);
		source.message(start("already-running", 20));
		const { observer } = observe(10);
		await observer.refetch();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached(10).requests.map((request) => request.id)).toEqual([
			"already-running",
		]);
		expect(cached(10).requests[0].meta.pending).toBe(true);
		expect(cached(10).detailsMap.has("old-completed")).toBe(false);
		source.message({
			type: "summary",
			payload: summary("already-running", 20, 429),
		});
		expect(cached(10).requests[0].meta.pending).toBe(false);
		expect(cached(10).requests[0].response?.status).toBe(429);
		expect(cached(10).detailsMap.get("already-running")?.statusCode).toBe(429);
		expect(observer.getCurrentResult().data).toBe(cached(10));
	});
	it("removes stale completed cache rows rather than retaining arbitrary old history", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([]);
		seed(10, [summary("old-completed")]);
		const { observer } = observe(10);
		await observer.refetch();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached(10).requests).toEqual([]);
		expect(cached(10).detailsMap.size).toBe(0);
	});
	it("lets a terminal snapshot replace a request pending before capture", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([
			summary("already-running", 20, 429),
		]);
		const { source } = mountStream(10);
		source.message(start("already-running", 20));
		const { observer } = observe(10);
		await observer.refetch();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached(10).requests[0].meta.pending).not.toBe(true);
		expect(cached(10).requests[0].response?.status).toBe(429);
		expect(cached(10).detailsMap.get("already-running")?.statusCode).toBe(429);
	});
	it("bounds retained prior pending rows together with fetched history", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([
			summary("new-completed", 40),
		]);
		const { source } = mountStream(2);
		source.message(start("older-pending", 20));
		source.message(start("newer-pending", 30));
		const { observer } = observe(2);
		await observer.refetch();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached(2).requests.map((request) => request.id)).toEqual([
			"new-completed",
			"newer-pending",
		]);
		expect(cached(2).requests[1].meta.pending).toBe(true);
		expect([...cached(2).detailsMap.keys()]).toEqual(["new-completed"]);
	});
	for (const initialCache of ["retained", "empty"] as const) {
		it(`preserves starts and summaries when all three snapshots race SSE (${initialCache} cache)`, async () => {
			const pending = pendingSnapshots();
			if (initialCache === "retained") seed(10, [summary("existing")]);
			const { source } = mountStream(10);
			const { observer } = observe(10);
			const result = observer.refetch({ cancelRefetch: false });
			source.message(start("turn-1", 20));
			await pending.resolve(1, [summary("existing")]);
			source.message(start("turn-2", 30));
			await pending.resolve(2, [summary("turn-1", 20), summary("existing")]);
			source.message(start("last", 40));
			source.message({ type: "summary", payload: summary("last", 40, 429) });
			source.message(start("still-pending", 45));
			source.message({ type: "summary", payload: summary("existing", 1, 500) });
			source.message({
				type: "summary",
				payload: summary("summary-only", 35, 201),
			});
			await pending.resolve(3, [
				summary("turn-2", 30),
				summary("turn-1", 20),
				summary("snapshot-only", 10),
				summary("existing"),
			]);
			await result;
			expect(pending.fetch).toHaveBeenCalledTimes(3);
			const data = cached(10);
			expect(data.requests.map((request) => request.id)).toEqual([
				"still-pending",
				"last",
				"summary-only",
				"turn-2",
				"turn-1",
				"snapshot-only",
				"existing",
			]);
			expect(
				data.requests.find((request) => request.id === "last"),
			).toMatchObject({
				response: { status: 429 },
				meta: {
					pending: false,
					rateLimited: true,
					bodiesOmitted: true,
					agentUsed: "reviewer",
					agentAttributionSource: "header",
				},
			});
			expect(data.requests[0]).toMatchObject({
				response: null,
				meta: { pending: true, bodiesOmitted: true },
			});
			expect(data.detailsMap.get("last")).toEqual(summary("last", 40, 429));
			expect(data.detailsMap.get("existing")).toEqual(
				summary("existing", 1, 500),
			);
			expect(data.detailsMap.get("summary-only")).toEqual(
				summary("summary-only", 35, 201),
			);
			expect(observer.getCurrentResult().data).toBe(data);
			expect(observer.getCurrentResult().fetchStatus).toBe("idle");
			await flush();
			expect(pending.fetch).toHaveBeenCalledTimes(3);
		});
	}
	for (const state of ["pending", "completed"] as const) {
		it(`retains an attempt-one ${state} request absent from every later snapshot`, async () => {
			const pending = pendingSnapshots();
			const { source } = mountStream(10);
			const { observer } = observe(10);
			const result = observer.refetch({ cancelRefetch: false });
			source.message(start("not-yet-persisted", 20));
			if (state === "completed")
				source.message({
					type: "summary",
					payload: summary("not-yet-persisted", 20, 429),
				});
			await pending.resolve(1, [summary("historical")]);
			source.message(start("second-attempt", 30));
			await pending.resolve(2, [summary("historical")]);
			source.message(start("third-attempt", 40));
			await pending.resolve(3, [summary("historical")]);
			await result;
			const data = cached(10);
			expect(data.requests.map((request) => request.id)).toEqual([
				"third-attempt",
				"second-attempt",
				"not-yet-persisted",
				"historical",
			]);
			expect(
				data.requests.find((request) => request.id === "not-yet-persisted")
					?.meta.pending,
			).toBe(state === "pending");
			if (state === "completed")
				expect(data.detailsMap.get("not-yet-persisted")?.statusCode).toBe(429);
			expect(pending.fetch).toHaveBeenCalledTimes(3);
		});
	}
	it("does not replay an obsolete start over a later terminal snapshot", async () => {
		const pending = pendingSnapshots();
		const { source } = mountStream(10);
		const { observer } = observe(10);
		const result = observer.refetch({ cancelRefetch: false });
		source.message(start("completed-by-snapshot", 20));
		await pending.resolve(1, []);
		source.message(start("other", 30));
		await pending.resolve(2, [summary("completed-by-snapshot", 20, 429)]);
		source.message(start("last", 40));
		await pending.resolve(3, [
			summary("other", 30),
			summary("completed-by-snapshot", 20, 429),
		]);
		await result;
		const completed = cached(10).requests.find(
			(request) => request.id === "completed-by-snapshot",
		);
		expect(completed?.response?.status).toBe(429);
		expect(completed?.meta.pending).not.toBe(true);
		expect(cached(10).detailsMap.get("completed-by-snapshot")?.statusCode).toBe(
			429,
		);
		expect(pending.fetch).toHaveBeenCalledTimes(3);
	});
	it("preserves an SSE event between query resolution and QueryClient's cache commit", async () => {
		const pending = pendingSnapshots();
		const { source } = mountStream(10);
		const { observer } = observe(10);
		const result = observer.refetch({ cancelRefetch: false });
		const resolving = pending.resolve(1, [summary("snapshot-only")]);
		queueMicrotask(() => {
			source.message(start("at-commit", 50));
			source.message({
				type: "summary",
				payload: summary("at-commit", 50, 429),
			});
		});
		await resolving;
		await result;
		expect(cached(10).requests[0].id).toBe("at-commit");
		expect(cached(10).detailsMap.get("at-commit")?.statusCode).toBe(429);
		expect(pending.fetch).toHaveBeenCalledTimes(1);
	});
	it("replays equal-timestamp starts in event order rather than snapshot order", async () => {
		const pending = pendingSnapshots();
		const { source } = mountStream(1);
		const { observer } = observe(1);
		const result = observer.refetch({ cancelRefetch: false });
		for (let attempt = 1; attempt <= 3; attempt++) {
			source.message(start(`event-${attempt}`, 100));
			await pending.resolve(attempt, [summary("snapshot", 100)]);
		}
		await result;
		expect(cached(1).requests.map((request) => request.id)).toEqual([
			"event-3",
		]);
		expect(cached(1).detailsMap.size).toBe(0);
		expect(pending.fetch).toHaveBeenCalledTimes(3);
	});
	it("does not let a canceled fetch's late completion detach its replacement capture", async () => {
		const pending = pendingSnapshots();
		seed(10, [summary("existing")]);
		const { source } = mountStream(10);
		const { observer } = observe(10);
		const result = observer.refetch();
		source.message(start("replacement-1", 20));
		await pending.resolve(1, [summary("canceled")], 2);
		expect(pending.fetch).toHaveBeenCalledTimes(2);
		await pending.resolve(2, [summary("existing")]);
		source.message(start("replacement-2", 30));
		await pending.resolve(3, [
			summary("replacement-1", 20),
			summary("existing"),
		]);
		source.message(start("replacement-3", 40));
		source.message({
			type: "summary",
			payload: summary("replacement-3", 40, 429),
		});
		await pending.resolve(4, [
			summary("replacement-2", 30),
			summary("replacement-1", 20),
			summary("existing"),
		]);
		await result;
		expect(cached(10).requests[0].id).toBe("replacement-3");
		expect(cached(10).detailsMap.get("replacement-3")?.statusCode).toBe(429);
		expect(
			cached(10).requests.some((request) => request.id === "canceled"),
		).toBe(false);
		expect(pending.fetch).toHaveBeenCalledTimes(4);
	});
	it("bounds capture state by the request limit and isolates clients and limits", () => {
		const { source } = mountStream(2);
		const own = captureRequestUpdates(queryClient, 2);
		const otherLimit = captureRequestUpdates(queryClient, 10);
		const otherClient = captureRequestUpdates(new QueryClient(), 2);
		cleanups.push(own.dispose, otherLimit.dispose, otherClient.dispose);
		for (let index = 1; index <= 50; index++)
			source.message(start(String(index), index));
		expect([...own.updates.keys()]).toEqual(["49", "50"]);
		expect(otherLimit.updates.size).toBe(0);
		expect(otherClient.updates.size).toBe(0);
	});
	it("makes capture disposal idempotent when a newer fetch has started", () => {
		const { source } = mountStream(10);
		const previous = captureRequestUpdates(queryClient, 10);
		previous.dispose();
		const next = captureRequestUpdates(queryClient, 10);
		cleanups.push(next.dispose);
		previous.dispose();
		source.message(start("next-fetch", 10));
		expect(next.updates.has("next-fetch")).toBe(true);
	});
	it("keeps the latest bounded history despite a burst of late old summaries", async () => {
		const pending = pendingSnapshots();
		const { source } = mountStream(2);
		const { observer } = observe(2);
		const result = observer.refetch({ cancelRefetch: false });
		source.message(start("first", 40));
		await pending.resolve(1, []);
		source.message(start("second", 60));
		await pending.resolve(2, [summary("first", 40)]);
		source.message(start("newest", 100));
		source.message({ type: "summary", payload: summary("newest", 100, 429) });
		for (let index = 1; index <= 20; index++) {
			source.message({
				type: "summary",
				payload: summary(`late-${index}`, index),
			});
		}
		await pending.resolve(3, [summary("second", 60), summary("first", 40)]);
		await result;
		expect(pending.fetch).toHaveBeenCalledTimes(3);
		expect(cached(2).requests.map((request) => request.id)).toEqual([
			"newest",
			"second",
		]);
		expect([...cached(2).detailsMap.keys()].sort()).toEqual([
			"newest",
			"second",
		]);
		expect(cached(2).detailsMap.get("newest")?.statusCode).toBe(429);
	});
});
