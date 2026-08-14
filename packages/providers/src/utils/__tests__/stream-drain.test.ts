import { describe, expect, it } from "bun:test";
import {
	drainReader,
	getResponseDrainTransport,
	registerResponseDrainTransport,
	transferResponseDrainTransport,
} from "../stream-drain";

function neverSettlingReader(onCancel?: (reason: unknown) => void) {
	const stream = new ReadableStream<Uint8Array>({
		pull: () => new Promise<void>(() => {}),
		cancel(reason) {
			onCancel?.(reason);
		},
	});
	return { reader: stream.getReader(), stream };
}

describe("drainReader", () => {
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

	it("settles by the deadline when reader.read never settles", async () => {
		let cancelReason: unknown;
		const { reader } = neverSettlingReader((reason) => {
			cancelReason = reason;
		});

		const outcome = await Promise.race([
			drainReader(reader, { deadlineMs: 10 }).then(() => "settled" as const),
			Bun.sleep(100).then(() => "watchdog" as const),
		]);

		expect(outcome).toBe("settled");
		expect(cancelReason).toBeInstanceOf(Error);
	});

	it("aborts the response's exact transport when the deadline expires", async () => {
		const transportAbort = new AbortController();
		const { reader } = neverSettlingReader();

		await drainReader(reader, {
			deadlineMs: 10,
			transportAbort,
		});

		expect(transportAbort.signal.aborted).toBe(true);
		expect(transportAbort.signal.reason).toBeInstanceOf(Error);
		expect((transportAbort.signal.reason as Error).message).toBe(
			"Response drain deadline exceeded",
		);
	});

	it("drains a finite reader without aborting its transport", async () => {
		const transportAbort = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
		});

		await drainReader(stream.getReader(), {
			deadlineMs: 50,
			transportAbort,
		});

		expect(transportAbort.signal.aborted).toBe(false);
		expect(stream.locked).toBe(false);
	});

	it("does not let a clone cleanup deadline abort its live sibling", async () => {
		const transportAbort = new AbortController();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull: () => new Promise<void>(() => {}),
			}),
		);
		registerResponseDrainTransport(response, transportAbort);
		const clone = response.clone();

		expect(getResponseDrainTransport(clone)).toBeUndefined();
		await drainReader(
			clone.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>,
			{
				deadlineMs: 10,
			},
		);

		expect(transportAbort.signal.aborted).toBe(false);
		expect(response.bodyUsed).toBe(false);
	});
});
