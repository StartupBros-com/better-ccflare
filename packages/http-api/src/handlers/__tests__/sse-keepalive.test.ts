import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { SSE_KEEPALIVE_INTERVAL_MS, startSseKeepalive } from "../sse-keepalive";

afterEach(() => mock.restore());

describe("SSE keepalive failure boundary", () => {
	it("stops its timer and invokes cleanup if the stream errors", () => {
		let tick = () => {};
		const interval = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
		) => {
			tick = callback;
			return 42;
		}) as typeof setInterval);
		const clear = spyOn(globalThis, "clearInterval").mockImplementation(
			() => {},
		);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const onFail = mock(() => {});
		startSseKeepalive(controller, onFail);
		expect(interval).toHaveBeenCalledWith(
			expect.any(Function),
			SSE_KEEPALIVE_INTERVAL_MS,
		);
		controller.error(new Error("stream failed"));
		tick();
		expect(onFail).toHaveBeenCalledTimes(1);
		expect(clear).toHaveBeenCalledWith(42);
	});
	it("returns a stop function which removes its interval", () => {
		spyOn(globalThis, "setInterval").mockImplementation(
			(() => 17) as typeof setInterval,
		);
		const clear = spyOn(globalThis, "clearInterval").mockImplementation(
			() => {},
		);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		startSseKeepalive(controller, () => {})();
		expect(clear).toHaveBeenCalledWith(17);
	});
});
