import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const effects: Array<{
	effect: () => undefined | (() => void);
	deps: unknown[];
	stop?: () => void;
}> = [];
const state: unknown[] = [];
const refs: Array<{ current: unknown }> = [];
const writes: unknown[] = [];
let stateIndex = 0;
let effectIndex = 0;
let refIndex = 0;
mock.module("react", () => ({
	useEffect: (effect: () => undefined | (() => void), deps: unknown[]) => {
		const index = effectIndex++;
		const previous = effects[index];
		if (
			previous &&
			deps.every((value, i) => Object.is(value, previous.deps[i]))
		)
			return;
		previous?.stop?.();
		const stop = effect();
		effects[index] = {
			effect,
			deps,
			stop: typeof stop === "function" ? stop : undefined,
		};
	},
	useRef: <T>(current: T) => {
		const index = refIndex++;
		refs[index] ??= { current };
		return refs[index];
	},
	useState: <T>(initial: T) => {
		const index = stateIndex++;
		if (index >= state.length) state[index] = initial;
		return [
			state[index],
			(value: T) => {
				state[index] = value;
				writes.push(value);
			},
		];
	},
}));
class Source extends EventTarget {
	static instances: Source[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	close = mock(() => {});
	constructor(readonly url: string) {
		super();
		Source.instances.push(this);
	}
	connected() {
		this.dispatchEvent(new Event("connected"));
	}
	fail() {
		this.dispatchEvent(new Event("error"));
		this.onerror?.();
	}
	message(data: unknown) {
		const event = new MessageEvent("message", { data: JSON.stringify(data) });
		this.dispatchEvent(event);
		this.onmessage?.(event);
	}
}
const createEventSource = mock(
	async (_audience: string): Promise<EventSource> =>
		new Source(
			"/api/insights/alerts/stream?stream_token=fresh",
		) as unknown as EventSource,
);
mock.module("../../api", () => ({ api: { createEventSource } }));
const { useAlertStream } = await import("../useAlertStream");
const originalSource = Object.getOwnPropertyDescriptor(
	globalThis,
	"EventSource",
);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, { callback: () => void; delay: number }>();
let nextTimer = 0;
const cleanups: Array<() => void> = [];
const alert = { type: "alert", payload: { id: "first" } };
const onAlert = mock(() => {});
async function flush() {
	for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}
function AlertStreamTestComponent(
	options: Parameters<typeof useAlertStream>[0],
) {
	useAlertStream(options);
	return null;
}
function render(enabled = true, callback = onAlert) {
	stateIndex = 0;
	effectIndex = 0;
	refIndex = 0;
	AlertStreamTestComponent({ enabled, onAlert: callback });
}
function mount(enabled = true) {
	render(enabled);
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		for (const entry of effects.splice(0)) entry.stop?.();
	};
	cleanups.push(stop);
	return stop;
}
function deferred() {
	let resolve!: (source: EventSource) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<EventSource>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void promise.catch(() => {});
	return {
		promise,
		resolve: (source: Source) => resolve(source as unknown as EventSource),
		reject,
	};
}
async function retry() {
	expect(timers.size).toBe(1);
	const [id, timer] = [...timers][0];
	timers.delete(id);
	timer.callback();
	await flush();
}
beforeEach(() => {
	Source.instances = [];
	writes.length = 0;
	state.length = 0;
	refs.length = 0;
	effects.length = 0;
	onAlert.mockClear();
	createEventSource.mockReset();
	createEventSource.mockImplementation(
		async () =>
			new Source(
				"/api/insights/alerts/stream?stream_token=fresh",
			) as unknown as EventSource,
	);
	Object.defineProperty(globalThis, "EventSource", {
		configurable: true,
		value: Source,
	});
	globalThis.setTimeout = ((callback: () => void, delay: number) => {
		const id = ++nextTimer;
		timers.set(id, { callback, delay });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timers.delete(id);
	}) as unknown as typeof clearTimeout;
});
afterEach(() => {
	for (const stop of cleanups.splice(0)) stop();
	timers.clear();
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
	if (originalSource)
		Object.defineProperty(globalThis, "EventSource", originalSource);
	else Reflect.deleteProperty(globalThis, "EventSource");
});
describe("Alerts authenticated stream lifecycle", () => {
	it("uses the shared factory and retains named connected and alert delivery", async () => {
		mount();
		await flush();
		expect(createEventSource).toHaveBeenCalledWith("alerts");
		expect(state).toEqual([false, null]);
		Source.instances[0].connected();
		Source.instances[0].message(alert);
		expect(state).toEqual([true, null]);
		expect(onAlert).toHaveBeenCalledWith(alert);
	});
	it("closes errors, mints a fresh source on retry, and ignores stale events", async () => {
		mount();
		await flush();
		const first = Source.instances[0];
		first.connected();
		first.fail();
		expect(first.close).toHaveBeenCalledTimes(1);
		expect(state[0]).toBe(false);
		expect(state[1]).toBe("Connection lost — reconnecting…");
		const count = writes.length;
		first.connected();
		first.message(alert);
		first.fail();
		expect(writes).toHaveLength(count);
		expect(onAlert).not.toHaveBeenCalled();
		await retry();
		expect(createEventSource).toHaveBeenCalledTimes(2);
		Source.instances[1].connected();
		expect(state).toEqual([true, null]);
		first.fail();
		expect(timers.size).toBe(0);
	});
	it("retries mint rejection with bounded backoff and resets it after connection", async () => {
		createEventSource.mockRejectedValue(new Error("mint failed"));
		mount();
		await flush();
		expect(state).toEqual([false, "mint failed"]);
		for (let attempt = 0; attempt < 12; attempt++) {
			const delay = [...timers.values()][0]?.delay;
			expect(delay).toBeGreaterThanOrEqual(1000);
			expect(delay).toBeLessThanOrEqual(37500);
			await retry();
		}
		createEventSource.mockImplementation(
			async () => new Source("fresh") as unknown as EventSource,
		);
		await retry();
		Source.instances[0].connected();
		Source.instances[0].fail();
		expect([...timers.values()][0].delay).toBeLessThanOrEqual(1250);
	});
	it("closes a source resolving after unmount without handlers or state writes", async () => {
		const pending = deferred();
		createEventSource.mockReturnValue(pending.promise);
		const stop = mount();
		stop();
		const count = writes.length;
		const late = new Source("late");
		pending.resolve(late);
		await flush();
		expect(late.close).toHaveBeenCalledTimes(1);
		late.connected();
		late.message(alert);
		late.fail();
		expect(writes).toHaveLength(count);
		expect(timers.size).toBe(0);
		expect(onAlert).not.toHaveBeenCalled();
	});
	it("ignores a rejected mint after unmount", async () => {
		const pending = deferred();
		createEventSource.mockReturnValue(pending.promise);
		const stop = mount();
		stop();
		const count = writes.length;
		pending.reject(new Error("stale"));
		await flush();
		expect(writes).toHaveLength(count);
		expect(timers.size).toBe(0);
	});
	it("disabled mounts do not connect; disabling closes active source and retry timer", async () => {
		mount(false);
		await flush();
		expect(createEventSource).not.toHaveBeenCalled();
		const stop = mount();
		await flush();
		const source = Source.instances[0];
		source.connected();
		source.fail();
		expect(timers.size).toBe(1);
		stop();
		mount(false);
		expect(timers.size).toBe(0);
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(state).toEqual([false, null]);
		mount();
		await flush();
		expect(createEventSource).toHaveBeenCalledTimes(2);
	});
	for (const outcome of ["resolve", "reject"] as const) {
		it(`ignores old ${outcome} after disable and re-enable`, async () => {
			const pending = deferred();
			createEventSource.mockReturnValueOnce(pending.promise);
			const stop = mount();
			stop();
			mount(false);
			mount();
			await flush();
			const current = Source.instances[0];
			current.connected();
			const count = writes.length;
			if (outcome === "resolve") {
				const late = new Source("late");
				pending.resolve(late);
				await flush();
				expect(late.close).toHaveBeenCalledTimes(1);
				late.connected();
				late.message(alert);
				late.fail();
			} else {
				pending.reject(new Error("old"));
				await flush();
			}
			expect(writes).toHaveLength(count);
			expect(state).toEqual([true, null]);
			expect(current.close).not.toHaveBeenCalled();
			expect(timers.size).toBe(0);
			expect(onAlert).not.toHaveBeenCalled();
		});
	}
	it("disabling an established stream resets state and reconnects only on re-enable", async () => {
		mount();
		await flush();
		const source = Source.instances[0];
		source.connected();
		render(false);
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(state).toEqual([false, null]);
		source.connected();
		source.fail();
		source.message(alert);
		expect(timers.size).toBe(0);
		expect(onAlert).not.toHaveBeenCalled();
		render(true);
		await flush();
		expect(createEventSource).toHaveBeenCalledTimes(2);
		Source.instances[1].connected();
		expect(state).toEqual([true, null]);
	});
	it("updates the alert callback without replacing a healthy stream", async () => {
		mount();
		await flush();
		const updated = mock(() => {});
		render(true, updated);
		Source.instances[0].message(alert);
		expect(updated).toHaveBeenCalledWith(alert);
		expect(onAlert).not.toHaveBeenCalled();
		expect(createEventSource).toHaveBeenCalledTimes(1);
	});
	it("unmount closes an active stream and suppresses queued events", async () => {
		const stop = mount();
		await flush();
		const source = Source.instances[0];
		source.connected();
		stop();
		const count = writes.length;
		source.connected();
		source.message(alert);
		source.fail();
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(writes).toHaveLength(count);
		expect(timers.size).toBe(0);
		expect(onAlert).not.toHaveBeenCalled();
	});
});
