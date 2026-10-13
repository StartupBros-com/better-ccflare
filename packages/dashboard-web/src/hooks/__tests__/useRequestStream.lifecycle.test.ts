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

const { cleanupRequestStream, getRequestsSseSeq, useRequestStream } =
	await import("../useRequestStream");

function RequestStreamTestComponent(limit: number) {
	useRequestStream(limit);
	return null;
}

function mount(limit = 200): () => void {
	effects.length = 0;
	RequestStreamTestComponent(limit);
	const cleanups = effects
		.map((effect) => effect())
		.filter((cleanup): cleanup is () => void => Boolean(cleanup));
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
function currentSource() {
	return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}
function retry() {
	expect(timeouts.size).toBe(1);
	const [id, timer] = [...timeouts][0];
	timeouts.delete(id);
	timer.callback();
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
	it("closes the last source and clears every timer on final unmount", () => {
		const unmount = mount();
		const source = currentSource();
		expect(source.url).toBe("/api/requests/stream");
		unmount();
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(intervals.size).toBe(0);
		expect(timeouts.size).toBe(0);
		const again = mount();
		expect(FakeEventSource.instances).toHaveLength(2);
		again();
	});
	it("closes errored sources and still reconnects after more than ten failures", () => {
		const unmount = mount();
		for (let attempt = 0; attempt < 12; attempt++) {
			const source = currentSource();
			source.fail();
			expect(source.close).toHaveBeenCalledTimes(1);
			const delay = [...timeouts.values()][0]?.delay;
			expect(delay).toBeGreaterThanOrEqual(1000);
			expect(delay).toBeLessThanOrEqual(37500);
			retry();
		}
		expect(FakeEventSource.instances).toHaveLength(13);
		currentSource().open();
		expect(invalidations).toHaveBeenCalled();
		unmount();
	});
	it("cancels pending retries and browser recovery after final unmount", () => {
		const unmount = mount();
		currentSource().fail();
		expect(timeouts.size).toBe(1);
		unmount();
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
		windowTarget.dispatchEvent(new Event("online"));
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		expect(FakeEventSource.instances).toHaveLength(1);
	});
	it("leaves CONNECTING alone but reconnects a silently CLOSED source", () => {
		const unmount = mount();
		const source = currentSource();
		heartbeat();
		expect(source.close).not.toHaveBeenCalled();
		expect(FakeEventSource.instances).toHaveLength(1);
		source.readyState = FakeEventSource.CLOSED;
		heartbeat();
		expect(FakeEventSource.instances).toHaveLength(2);
		unmount();
	});
	it("recovers a long-hidden tab and forces recovery on online", () => {
		const unmount = mount();
		currentSource().open();
		documentTarget.visibilityState = "hidden";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		now = 31000;
		documentTarget.visibilityState = "visible";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		expect(FakeEventSource.instances).toHaveLength(2);
		currentSource().open();
		windowTarget.dispatchEvent(new Event("online"));
		expect(FakeEventSource.instances).toHaveLength(3);
		expect(invalidations).toHaveBeenCalledWith({
			queryKey: queryKeys.requests(200),
		});
		unmount();
	});
	it("shares CONNECTING sources and retains recovery when the first subscriber unmounts", () => {
		const first = mount();
		const second = mount();
		expect(FakeEventSource.instances).toHaveLength(1);
		first();
		expect(currentSource().close).not.toHaveBeenCalled();
		currentSource().fail();
		retry();
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
	it("keeps shared subscriber counts through reconnect and runs only one online recovery", () => {
		const first = mount();
		currentSource().open();
		const second = mount();
		currentSource().fail();
		retry();
		currentSource().open();
		windowTarget.dispatchEvent(new Event("online"));
		expect(FakeEventSource.instances).toHaveLength(3);
		first();
		expect(currentSource().close).not.toHaveBeenCalled();
		second();
		expect(currentSource().close).toHaveBeenCalledTimes(1);
	});
	it("ignores late error events from a replaced source", () => {
		const unmount = mount();
		const old = currentSource();
		old.fail();
		retry();
		old.fail();
		expect(timeouts.size).toBe(0);
		expect(currentSource().close).not.toHaveBeenCalled();
		unmount();
	});
	it("shutdown cancels pending retries as well as open connections", () => {
		mount();
		currentSource().fail();
		cleanupRequestStream();
		expect(timeouts.size).toBe(0);
		expect(intervals.size).toBe(0);
		windowTarget.dispatchEvent(new Event("online"));
		expect(FakeEventSource.instances).toHaveLength(1);
	});
	it("keeps cache identity for a late evicted summary while advancing the SSE sequence", () => {
		const unmount = mount(1);
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
		it(`normalizes and prunes ${shape} details on a late evicted summary`, () => {
			const unmount = mount(1);
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
	it("prunes evicted details and keeps attribution, lazy-body and final status fields", () => {
		const unmount = mount(1);
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
