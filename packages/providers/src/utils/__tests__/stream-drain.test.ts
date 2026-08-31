import { describe, expect, it } from "bun:test";
import {
	drainReader,
	drainReaderWithDeadline,
	getResponseDrainTransport,
	registerResponseDrainTransport,
	transferResponseDrainTransport,
} from "../stream-drain";

type ByteReader = ReadableStreamDefaultReader<Uint8Array>;

type DrainVariant = {
	name: string;
	run: (
		reader: ByteReader,
		deadlineMs: number,
		transportAbort?: AbortController,
	) => Promise<void>;
};

const drainVariants: DrainVariant[] = [
	{
		name: "drainReader",
		run: (reader, deadlineMs, transportAbort) =>
			drainReader(reader, { deadlineMs, transportAbort }),
	},
	{
		name: "drainReaderWithDeadline",
		run: (reader, deadlineMs, drainAbort) =>
			drainReaderWithDeadline(reader, { deadlineMs, drainAbort }),
	},
];

function neverSettlingReader(onCancel?: (reason: unknown) => void) {
	const stream = new ReadableStream<Uint8Array>({
		pull: () => new Promise<void>(() => {}),
		cancel(reason) {
			onCancel?.(reason);
		},
	});
	return { reader: stream.getReader(), stream };
}

function controlledPendingReader(events: string[]): {
	reader: ByteReader;
	rejectRead: (reason: unknown) => void;
} {
	let rejectReadPromise!: (reason: unknown) => void;
	const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
		(_resolve, reject) => {
			rejectReadPromise = reject;
		},
	);
	const observedRead = pendingRead.catch((error) => {
		events.push("read-rejection-observed");
		throw error;
	});
	const reader = {
		read: () => {
			events.push("read-started");
			return observedRead;
		},
		cancel: () => {
			events.push("cancel");
			return Promise.resolve();
		},
		releaseLock: () => {
			events.push("release");
		},
	} as unknown as ByteReader;
	return {
		reader,
		rejectRead: (reason) => {
			events.push("read-rejected");
			rejectReadPromise(reason);
		},
	};
}

function unabortableReader(
	events: string[],
	rejectOnRelease = false,
): ByteReader {
	let rejectRead!: (reason: unknown) => void;
	const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
		(_resolve, reject) => {
			rejectRead = reject;
		},
	);
	return {
		read: () => {
			events.push("read-started");
			return pendingRead;
		},
		cancel: () => {
			events.push("cancel");
			return Promise.resolve();
		},
		releaseLock: () => {
			events.push("release");
			if (rejectOnRelease) {
				rejectRead(new Error("pending read rejected by lock release"));
			}
		},
	} as unknown as ByteReader;
}

async function captureHelperTimers(run: () => Promise<void>): Promise<{
	delays: number[];
	clearedDelays: number[];
	firedDelays: number[];
}> {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timerDelays = new Map<ReturnType<typeof setTimeout>, number>();
	const clearedDelays: number[] = [];
	const firedDelays: number[] = [];

	globalThis.setTimeout = ((
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		let handle!: ReturnType<typeof setTimeout>;
		handle = originalSetTimeout(() => {
			const delay = timerDelays.get(handle);
			if (delay !== undefined) firedDelays.push(delay);
			if (typeof handler === "function") handler(...args);
		}, timeout);
		timerDelays.set(handle, timeout ?? 0);
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
		const delay = timerDelays.get(handle as ReturnType<typeof setTimeout>);
		if (delay !== undefined) clearedDelays.push(delay);
		return originalClearTimeout(handle);
	}) as typeof clearTimeout;

	try {
		await run();
		return {
			delays: [...timerDelays.values()],
			clearedDelays,
			firedDelays,
		};
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
}

function finiteReader(): {
	reader: ByteReader;
	stream: ReadableStream<Uint8Array>;
	releaseCount: () => number;
} {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
			controller.close();
		},
	});
	const reader = stream.getReader();
	let releases = 0;
	const originalReleaseLock = reader.releaseLock.bind(reader);
	reader.releaseLock = () => {
		releases += 1;
		originalReleaseLock();
	};
	return { reader, stream, releaseCount: () => releases };
}

describe("response drain transport ownership", () => {
	it("tracks and transfers exact transports without reading response bodies", () => {
		let bodyAccesses = 0;
		const observeBodyAccess = (response: Response): Response =>
			new Proxy(response, {
				get(target, property) {
					if (property === "body") bodyAccesses += 1;
					return Reflect.get(target, property, target);
				},
			});
		const source = observeBodyAccess(new Response("source"));
		const target = observeBodyAccess(new Response("target"));
		const transportAbort = new AbortController();

		registerResponseDrainTransport(source, transportAbort);
		expect(getResponseDrainTransport(source)).toBe(transportAbort);
		transferResponseDrainTransport(source, target);
		expect(getResponseDrainTransport(target)).toBe(transportAbort);
		expect(bodyAccesses).toBe(0);
	});
});

for (const variant of drainVariants) {
	describe(variant.name, () => {
		it("aborts the exact transport and observes abort settlement before releasing", async () => {
			const events: string[] = [];
			const transportAbort = new AbortController();
			const { reader, rejectRead } = controlledPendingReader(events);
			transportAbort.signal.addEventListener(
				"abort",
				() => {
					events.push("abort");
					setTimeout(() => {
						rejectRead(new Error("transport aborted"));
					}, 0);
				},
				{ once: true },
			);

			await variant.run(reader, 5, transportAbort);
			await Bun.sleep(10);

			expect(events.indexOf("abort")).toBeGreaterThan(
				events.indexOf("read-started"),
			);
			expect(events.indexOf("read-rejection-observed")).toBeGreaterThan(
				events.indexOf("abort"),
			);
			expect(events.indexOf("release")).toBeGreaterThan(
				events.indexOf("read-rejection-observed"),
			);
		});

		it("clears primary and grace timers after abort settles the pending read early", async () => {
			const events: string[] = [];
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			const transportAbort = new AbortController();
			const { reader, rejectRead } = controlledPendingReader(events);
			transportAbort.signal.addEventListener(
				"abort",
				() => {
					events.push("abort");
					queueMicrotask(() => {
						rejectRead(new Error("transport aborted"));
					});
				},
				{ once: true },
			);
			const deadlineMs = 7;

			try {
				const timers = await captureHelperTimers(() =>
					variant.run(reader, deadlineMs, transportAbort),
				);
				expect(timers.delays).toEqual([deadlineMs, deadlineMs]);
				expect(timers.clearedDelays).toEqual([deadlineMs, deadlineMs]);
				expect(timers.firedDelays).toEqual([deadlineMs]);
				expect(events.indexOf("read-rejection-observed")).toBeGreaterThan(
					events.indexOf("abort"),
				);
				expect(events.indexOf("release")).toBeGreaterThan(
					events.indexOf("read-rejection-observed"),
				);

				await Bun.sleep(deadlineMs * 2);
				expect(timers.firedDelays).toEqual([deadlineMs]);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("uses the resolved drain deadline as one bounded settlement-grace window", async () => {
			const events: string[] = [];
			const transportAbort = new AbortController();
			transportAbort.signal.addEventListener(
				"abort",
				() => events.push("abort"),
				{ once: true },
			);
			const deadlineMs = 7;

			const timers = await captureHelperTimers(() =>
				variant.run(unabortableReader(events), deadlineMs, transportAbort),
			);

			// One drain-deadline window plus one equal settlement-grace window:
			// the worst-case deadline path is bounded to two consecutive budgets.
			expect(timers.delays).toEqual([deadlineMs, deadlineMs]);
			expect(timers.clearedDelays).toEqual([deadlineMs, deadlineMs]);
			expect(events.at(-1)).toBe("release");
			expect(events.indexOf("release")).toBeGreaterThan(
				events.indexOf("abort"),
			);
		});

		it("observes a read rejected by lock release after bounded grace", async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);

			try {
				await variant.run(unabortableReader([], true), 5);
				await Bun.sleep(10);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		it("drains a finite reader and releases its lock exactly once", async () => {
			const transportAbort = new AbortController();
			const { reader, stream, releaseCount } = finiteReader();

			await variant.run(reader, 50, transportAbort);

			expect(transportAbort.signal.aborted).toBe(false);
			expect(stream.locked).toBe(false);
			expect(releaseCount()).toBe(1);
		});

		it("cannot abort or consume a live Response.clone sibling", async () => {
			const transportAbort = new AbortController();
			let sourceController!: ReadableStreamDefaultController<Uint8Array>;
			const response = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						sourceController = controller;
						controller.enqueue(new Uint8Array([7]));
					},
				}),
			);
			registerResponseDrainTransport(response, transportAbort);
			const clone = response.clone();

			expect(getResponseDrainTransport(clone)).toBeUndefined();
			await variant.run(
				clone.body?.getReader() as ByteReader,
				5,
				getResponseDrainTransport(clone),
			);

			expect(transportAbort.signal.aborted).toBe(false);
			const liveReader = response.body?.getReader() as ByteReader;
			const liveChunk = await liveReader.read();
			expect(liveChunk.done).toBe(false);
			expect([...((liveChunk.value as Uint8Array) ?? [])]).toEqual([7]);
			sourceController.close();
			liveReader.releaseLock();
		});
	});
}

describe("drainReader best-effort cancellation", () => {
	it("retains reader.cancel as a fallback after exact transport abort", async () => {
		let cancelReason: unknown;
		const transportAbort = new AbortController();
		const { reader } = neverSettlingReader((reason) => {
			cancelReason = reason;
		});

		await drainReader(reader, {
			deadlineMs: 5,
			transportAbort,
		});

		expect(transportAbort.signal.aborted).toBe(true);
		expect(transportAbort.signal.reason).toBeInstanceOf(Error);
		expect((transportAbort.signal.reason as Error).message).toBe(
			"Response drain deadline exceeded",
		);
		expect(cancelReason).toBeInstanceOf(Error);
	});
});

describe("drainReaderWithDeadline beforeDrain", () => {
	it("settles a retained pending read after abort before releasing its lock", async () => {
		const events: string[] = [];
		const drainAbort = new AbortController();
		const { reader, rejectRead } = controlledPendingReader(events);
		const retainedRead = reader.read().then(
			() => undefined,
			() => {
				events.push("prestep-settled");
			},
		);
		drainAbort.signal.addEventListener(
			"abort",
			() => {
				events.push("abort");
				setTimeout(() => {
					rejectRead(new Error("transport aborted"));
				}, 0);
			},
			{ once: true },
		);

		await drainReaderWithDeadline(reader, {
			deadlineMs: 5,
			drainAbort,
			beforeDrain: () => {
				events.push("prestep-started");
				return retainedRead;
			},
		});

		expect(events).toEqual([
			"read-started",
			"prestep-started",
			"abort",
			"read-rejected",
			"read-rejection-observed",
			"prestep-settled",
			"release",
		]);
	});

	it("gives an unabortable beforeDrain one equal bounded grace window", async () => {
		const events: string[] = [];
		let readCount = 0;
		let releaseCount = 0;
		const reader = {
			read: () => {
				readCount += 1;
				return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
			},
			releaseLock: () => {
				releaseCount += 1;
				events.push("release");
			},
		} as unknown as ByteReader;
		const drainAbort = new AbortController();
		drainAbort.signal.addEventListener("abort", () => events.push("abort"), {
			once: true,
		});
		const deadlineMs = 7;

		const timers = await captureHelperTimers(() =>
			drainReaderWithDeadline(reader, {
				deadlineMs,
				drainAbort,
				beforeDrain: () => new Promise<void>(() => {}),
			}),
		);

		expect(readCount).toBe(0);
		expect(releaseCount).toBe(1);
		expect(timers.delays).toEqual([deadlineMs, deadlineMs]);
		expect(timers.firedDelays).toEqual([deadlineMs, deadlineMs]);
		expect(timers.clearedDelays).toEqual([deadlineMs, deadlineMs]);
		expect(events).toEqual(["abort", "release"]);
	});

	it("propagates a beforeDrain error when the caller owns errors", async () => {
		const expected = new Error("beforeDrain failed");
		let readCount = 0;
		let releaseCount = 0;
		const reader = {
			read: () => {
				readCount += 1;
				return Promise.resolve({ done: true, value: undefined });
			},
			releaseLock: () => {
				releaseCount += 1;
			},
		} as unknown as ByteReader;

		await expect(
			drainReaderWithDeadline(reader, {
				deadlineMs: 50,
				beforeDrain: async () => {
					throw expected;
				},
			}),
		).rejects.toBe(expected);
		expect(readCount).toBe(0);
		expect(releaseCount).toBe(1);
	});

	it("swallows a beforeDrain error only in best-effort mode", async () => {
		let readCount = 0;
		let releaseCount = 0;
		const reader = {
			read: () => {
				readCount += 1;
				return Promise.resolve({ done: true, value: undefined });
			},
			releaseLock: () => {
				releaseCount += 1;
			},
		} as unknown as ByteReader;

		await expect(
			drainReaderWithDeadline(reader, {
				deadlineMs: 50,
				beforeDrain: async () => {
					throw new Error("beforeDrain failed");
				},
				swallowErrors: true,
			}),
		).resolves.toBeUndefined();
		expect(readCount).toBe(0);
		expect(releaseCount).toBe(1);
	});
});
