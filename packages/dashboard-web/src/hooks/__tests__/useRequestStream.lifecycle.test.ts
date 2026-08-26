import { afterEach, describe, expect, it, mock } from "bun:test";

const effects: Array<() => undefined | (() => void)> = [];
const queryClient = {
	getQueryData: () => undefined,
	setQueryData: () => undefined,
};

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

const originalEventSource = Object.getOwnPropertyDescriptor(
	globalThis,
	"EventSource",
);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let nextTimer = 0;
const clearedTimers = mock((_timer: unknown) => undefined);

globalThis.setInterval = (() => ++nextTimer) as typeof setInterval;
globalThis.clearInterval = clearedTimers as typeof clearInterval;

class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];
	readonly close = mock(() => {
		this.readyState = FakeEventSource.CLOSED;
	});
	readyState = FakeEventSource.OPEN;

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener() {}
}

Object.defineProperty(globalThis, "EventSource", {
	configurable: true,
	value: FakeEventSource,
});

const { cleanupRequestStream, useRequestStream } = await import(
	"../useRequestStream"
);

function RequestStreamTestComponent() {
	useRequestStream();
	return null;
}

function mountAndRunEffects(): Array<() => void> {
	effects.length = 0;
	RequestStreamTestComponent();
	return effects
		.map((effect) => effect())
		.filter((cleanup): cleanup is () => void => Boolean(cleanup));
}

afterEach(() => {
	cleanupRequestStream();
	FakeEventSource.instances.length = 0;
	clearedTimers.mockClear();
	nextTimer = 0;
	if (originalEventSource) {
		Object.defineProperty(globalThis, "EventSource", originalEventSource);
	} else {
		Reflect.deleteProperty(globalThis, "EventSource");
	}
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
});

describe("useRequestStream lifecycle", () => {
	it("closes the final EventSource and clears heartbeat and pool cleanup timers", () => {
		const [connectionCleanup, globalCleanup] = mountAndRunEffects();
		const [connection] = FakeEventSource.instances;

		expect(connection.url).toBe("/api/requests/stream");
		expect(nextTimer).toBe(2);

		connectionCleanup();
		globalCleanup();

		expect(connection.close).toHaveBeenCalledTimes(1);
		expect(clearedTimers).toHaveBeenCalledWith(2);
		expect(clearedTimers).toHaveBeenCalledWith(1);

		// A new mount must build a fresh EventSource, proving the final unmount
		// removed the ref-count-zero entry from the connection pool.
		const remountCleanups = mountAndRunEffects();
		expect(FakeEventSource.instances).toHaveLength(2);
		remountCleanups[0]();
		remountCleanups[1]();
	});
});
