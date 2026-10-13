import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query-keys";

const effects: Array<() => undefined | (() => void)> = [];
const queryClient = new QueryClient({
	defaultOptions: { queries: { gcTime: Infinity } },
});
const invalidations = mock(() => Promise.resolve());
queryClient.invalidateQueries = invalidations;

mock.module("react", () => ({
	useCallback: <T>(callback: T) => callback,
	useEffect: (effect: () => undefined | (() => void)) => {
		effects.push(effect);
	},
	useRef: <T>(value: T) => ({ current: value }),
}));
mock.module("@tanstack/react-query", () => ({
	useQueryClient: () => queryClient,
}));

const originalGlobals = new Map(
	["EventSource", "document", "window"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalNow = Date.now;
let now = 0;
let nextTimer = 0;
const intervals = new Map<number, { callback: () => void; delay: number }>();
const timeouts = new Map<number, { callback: () => void; delay: number }>();
let documentTarget: EventTarget & { visibilityState: string };
let windowTarget: EventTarget;

class FakeEventSource extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];
	readonly close = mock(() => {
		this.readyState = FakeEventSource.CLOSED;
	});
	readyState = FakeEventSource.CONNECTING;
	constructor(readonly url: string) {
		super();
		FakeEventSource.instances.push(this);
	}
	open() {
		this.readyState = FakeEventSource.OPEN;
		this.dispatchEvent(new Event("open"));
	}
	fail() {
		this.readyState = FakeEventSource.CONNECTING;
		this.dispatchEvent(new Event("error"));
	}
	message(data: unknown) {
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(data) }),
		);
	}
}

const createEventSource = mock(
	async (_audience: string): Promise<EventSource> =>
		new FakeEventSource("/api/requests/stream") as unknown as EventSource,
);
mock.module("../../api", () => ({ api: { createEventSource } }));
async function flush() {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}
const { cleanupRequestStream, getRequestsSseSeq, useRequestStream } =
	await import("../useRequestStream");

function RequestStreamTestComponent(limit: number) {
	useRequestStream(limit);
	return null;
}

function mountSync(limit = 200): () => void {
	effects.length = 0;
	RequestStreamTestComponent(limit);
	const cleanups = effects
		.map((effect) => effect())
		.filter((cleanup): cleanup is () => void => Boolean(cleanup));
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
async function mount(limit = 200) {
	const stop = mountSync(limit);
	await flush();
	return stop;
}
function currentSource() {
	return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}
async function retry() {
	expect(timeouts.size).toBe(1);
	const [id, timer] = [...timeouts][0];
	timeouts.delete(id);
	timer.callback();
	await flush();
}
function heartbeat() {
	for (const timer of [...intervals.values()])
		if (timer.delay === 15000) timer.callback();
}
function start(id: string) {
	return {
		type: "start",
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: now,
		accountId: null,
		statusCode: 0,
		agentUsed: "reviewer",
		agentAttributionSource: "header",
	};
}

beforeEach(() => {
	createEventSource.mockReset();
	createEventSource.mockImplementation(
		async () =>
			new FakeEventSource("/api/requests/stream") as unknown as EventSource,
	);
	now = 0;
	nextTimer = 0;
	documentTarget = Object.assign(new EventTarget(), {
		visibilityState: "visible",
	});
	windowTarget = new EventTarget();
	for (const [key, value] of [
		["EventSource", FakeEventSource],
		["document", documentTarget],
		["window", windowTarget],
	] as const)
		Object.defineProperty(globalThis, key, { configurable: true, value });
	globalThis.setInterval = ((callback: () => void, delay: number) => {
		const id = ++nextTimer;
		intervals.set(id, { callback, delay });
		return id;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((id: number) => {
		intervals.delete(id);
	}) as unknown as typeof clearInterval;
	globalThis.setTimeout = ((callback: () => void, delay: number) => {
		const id = ++nextTimer;
		timeouts.set(id, { callback, delay });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timeouts.delete(id);
	}) as unknown as typeof clearTimeout;
	Date.now = () => now;
});
afterEach(() => {
	cleanupRequestStream();
	queryClient.clear();
	invalidations.mockClear();
	intervals.clear();
	timeouts.clear();
	FakeEventSource.instances.length = 0;
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
	Date.now = originalNow;
});

describe("useRequestStream lifecycle", () => {
	it("closes the last source and clears every timer on final unmount", async () => {
		const unmount = await mount();
		const source = currentSource();
		expect(source.url).toBe("/api/requests/stream");
		unmount();
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(intervals.size).toBe(0);
		expect(timeouts.size).toBe(0);
		const again = await mount();
		expect(FakeEventSource.instances).toHaveLength(2);
		again();
	});
	it("closes errored sources and still reconnects after more than ten failures", async () => {
		const unmount = await mount();
		for (let attempt = 0; attempt < 12; attempt++) {
			const source = currentSource();
			source.fail();
			expect(source.close).toHaveBeenCalledTimes(1);
			const delay = [...timeouts.values()][0]?.delay;
			expect(delay).toBeGreaterThanOrEqual(1000);
			expect(delay).toBeLessThanOrEqual(37500);
			await retry();
		}
		expect(FakeEventSource.instances).toHaveLength(13);
		currentSource().open();
		expect(invalidations).toHaveBeenCalled();
		unmount();
	});
	it("cancels pending retries and browser recovery after final unmount", async () => {
		const unmount = await mount();
		currentSource().fail();
		expect(timeouts.size).toBe(1);
		unmount();
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(FakeEventSource.instances).toHaveLength(1);
	});
	it("leaves CONNECTING alone but reconnects a silently CLOSED source", async () => {
		const unmount = await mount();
		const source = currentSource();
		heartbeat();
		await flush();
		expect(source.close).not.toHaveBeenCalled();
		expect(FakeEventSource.instances).toHaveLength(1);
		source.readyState = FakeEventSource.CLOSED;
		heartbeat();
		await flush();
		expect(FakeEventSource.instances).toHaveLength(2);
		unmount();
	});
	it("recovers a long-hidden tab and forces recovery on online", async () => {
		const unmount = await mount();
		currentSource().open();
		documentTarget.visibilityState = "hidden";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		await flush();
		now = 31000;
		documentTarget.visibilityState = "visible";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(FakeEventSource.instances).toHaveLength(2);
		currentSource().open();
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		expect(FakeEventSource.instances).toHaveLength(3);
		expect(invalidations).toHaveBeenCalledWith({
			queryKey: queryKeys.requests(200),
		});
		unmount();
	});
	it("shares CONNECTING sources and retains recovery when the first subscriber unmounts", async () => {
		const first = await mount();
		const second = await mount();
		expect(FakeEventSource.instances).toHaveLength(1);
		first();
		expect(currentSource().close).not.toHaveBeenCalled();
		currentSource().fail();
		await retry();
		currentSource().open();
		queryClient.setQueryData(queryKeys.requests(200), {
			requests: [],
			detailsMap: new Map(),
		});
		currentSource().message(start("remaining"));
		expect(
			queryClient.getQueryData<{ requests: { id: string }[] }>(
				queryKeys.requests(200),
			)?.requests[0].id,
		).toBe("remaining");
		second();
		expect(intervals.size).toBe(0);
		expect(timeouts.size).toBe(0);
	});
	it("keeps shared subscriber counts through reconnect and runs only one online recovery", async () => {
		const first = await mount();
		currentSource().open();
		const second = await mount();
		currentSource().fail();
		await retry();
		currentSource().open();
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		expect(FakeEventSource.instances).toHaveLength(3);
		first();
		expect(currentSource().close).not.toHaveBeenCalled();
		second();
		expect(currentSource().close).toHaveBeenCalledTimes(1);
	});
	it("ignores late error events from a replaced source", async () => {
		const unmount = await mount();
		const old = currentSource();
		old.fail();
		await retry();
		old.fail();
		expect(timeouts.size).toBe(0);
		expect(currentSource().close).not.toHaveBeenCalled();
		unmount();
	});
	it("shutdown cancels pending retries as well as open connections", async () => {
		await mount();
		currentSource().fail();
		cleanupRequestStream();
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		expect(FakeEventSource.instances).toHaveLength(1);
	});
	it("keeps cache identity for a late evicted summary while advancing the SSE sequence", async () => {
		const unmount = await mount(1);
		currentSource().open();
		queryClient.setQueryData(queryKeys.requests(1), {
			requests: [{ id: "live" }],
			detailsMap: new Map([["live", { id: "live", statusCode: 200 }]]),
		});
		const before = queryClient.getQueryData(queryKeys.requests(1));
		const sequence = getRequestsSseSeq();
		currentSource().message({
			type: "summary",
			payload: { id: "evicted", statusCode: 200, success: true },
		});
		expect(queryClient.getQueryData(queryKeys.requests(1))).toBe(before);
		expect(getRequestsSseSeq()).toBe(sequence + 1);
		unmount();
	});
	for (const shape of ["array", "stale-array", "stale-map"] as const) {
		it(`normalizes and prunes ${shape} details on a late evicted summary`, async () => {
			const unmount = await mount(1);
			currentSource().open();
			const live = { id: "live", statusCode: 200 };
			const summaries =
				shape === "array" ? [live] : [live, { id: "stale", statusCode: 500 }];
			queryClient.setQueryData(queryKeys.requests(1), {
				requests: [{ id: "live" }],
				detailsMap:
					shape === "stale-map"
						? new Map(summaries.map((summary) => [summary.id, summary]))
						: summaries,
			});
			const before = queryClient.getQueryData(queryKeys.requests(1));
			currentSource().message({
				type: "summary",
				payload: { id: "evicted", statusCode: 200, success: true },
			});
			const after = queryClient.getQueryData<{
				detailsMap: Map<string, unknown>;
			}>(queryKeys.requests(1));
			if (!after) throw new Error("Request cache was not populated");
			expect(after).not.toBe(before);
			expect(after.detailsMap).toBeInstanceOf(Map);
			expect([...after.detailsMap.keys()]).toEqual(["live"]);
			expect(after.detailsMap.get("live")).toEqual(live);
			unmount();
		});
	}
	it("prunes evicted details and keeps attribution, lazy-body and final status fields", async () => {
		const unmount = await mount(1);
		currentSource().open();
		queryClient.setQueryData(queryKeys.requests(1), {
			requests: [],
			detailsMap: new Map(),
		});
		currentSource().message(start("old"));
		currentSource().message({
			type: "summary",
			payload: {
				id: "old",
				statusCode: 200,
				success: true,
				rateLimited: false,
			},
		});
		currentSource().message(start("new"));
		currentSource().message({
			type: "summary",
			payload: { id: "old", statusCode: 200, success: true },
		});
		currentSource().message({
			type: "summary",
			payload: {
				id: "new",
				statusCode: 429,
				success: false,
				rateLimited: true,
			},
		});
		const data = queryClient.getQueryData<{
			requests: {
				id: string;
				response: { status: number };
				meta: Record<string, unknown>;
			}[];
			detailsMap: Map<string, unknown>;
		}>(queryKeys.requests(1));
		if (!data) throw new Error("Request cache was not populated");
		expect([...data.detailsMap.keys()]).toEqual(["new"]);
		expect(data.requests[0].response.status).toBe(429);
		expect(data.requests[0].meta).toMatchObject({
			agentUsed: "reviewer",
			agentAttributionSource: "header",
			bodiesOmitted: true,
			pending: false,
			rateLimited: true,
		});
		unmount();
	});
});

describe("asynchronous Requests connection attempts", () => {
	function defer() {
		let resolve!: (source: EventSource) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<EventSource>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		return { promise, resolve, reject };
	}
	it("shares a pending mint and closes its late source after final unmount", async () => {
		const pending = defer();
		createEventSource.mockImplementation(() => pending.promise);
		const first = mountSync();
		const second = mountSync();
		expect(createEventSource).toHaveBeenCalledTimes(1);
		expect(createEventSource).toHaveBeenCalledWith("requests");
		first();
		second();
		const late = new FakeEventSource("late");
		pending.resolve(late as unknown as EventSource);
		await flush();
		expect(late.close).toHaveBeenCalledTimes(1);
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
	});
	for (const outcome of ["resolve", "reject"] as const) {
		it(`ignores a stale ${outcome} after online replaces a pending attempt`, async () => {
			const old = defer();
			createEventSource.mockImplementationOnce(() => old.promise);
			const unmount = mountSync();
			windowTarget.dispatchEvent(new Event("online"));
			await flush();
			const replacement = currentSource();
			replacement.open();
			if (outcome === "resolve") {
				const late = new FakeEventSource("late");
				old.resolve(late as unknown as EventSource);
				await flush();
				expect(late.close).toHaveBeenCalledTimes(1);
				late.open();
				late.fail();
				late.message(start("stale"));
			} else {
				old.reject(new Error("stale mint failed"));
				await flush();
			}
			expect(replacement.close).not.toHaveBeenCalled();
			expect(timeouts.size).toBe(0);
			expect(invalidations).toHaveBeenCalledTimes(2);
			unmount();
		});
	}
	it("retries mint failures with fresh attempts and cancels rejection after shutdown", async () => {
		createEventSource.mockRejectedValueOnce(new Error("mint failed"));
		const unmount = await mount();
		expect(FakeEventSource.instances).toHaveLength(0);
		expect(timeouts.size).toBe(1);
		await retry();
		expect(createEventSource).toHaveBeenCalledTimes(2);
		currentSource().fail();
		const pending = defer();
		createEventSource.mockImplementationOnce(() => pending.promise);
		await retry();
		unmount();
		pending.reject(new Error("unmounted"));
		await flush();
		expect(timeouts.size).toBe(0);
	});
	it("keeps pools separate by limit and deduplicates a query client's messages", async () => {
		const first = await mount(1);
		const shared = await mount(1);
		const other = await mount(2);
		expect(createEventSource).toHaveBeenCalledTimes(2);
		const sequence = getRequestsSseSeq();
		FakeEventSource.instances[0].message(start("one"));
		expect(getRequestsSseSeq()).toBe(sequence + 1);
		first();
		shared();
		expect(currentSource().close).not.toHaveBeenCalled();
		other();
	});
});
