import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";

const decoder = new TextDecoder();
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const timers = new Map<number, () => void>();
let nextTimer = 0;
const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
	callback: () => void,
	interval: number,
) => {
	expect(interval).toBe(20000);
	const id = ++nextTimer;
	timers.set(id, callback);
	return id;
}) as typeof setInterval);
const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((
	id: number,
) => {
	timers.delete(id);
}) as typeof clearInterval);

afterEach(async () => {
	for (const reader of readers.splice(0)) await reader.cancel();
	expect(timers.size).toBe(0);
});
afterAll(() => {
	intervalSpy.mockRestore();
	clearSpy.mockRestore();
});

function openResponse(response: Response) {
	if (!response.body) throw new Error("SSE response has no body");
	const reader = response.body.getReader();
	readers.push(reader);
	return reader;
}

export function testSseKeepalive(handler: {
	name: string;
	create: () => (req: Request) => Response;
	listeners: () => number;
	emitFailure: () => void;
}) {
	describe(`${handler.name} SSE keepalive`, () => {
		it("sends comment pings, skips backed-up queues and clears the timer on cancellation", async () => {
			const response = handler.create()(
				new Request("http://localhost/api/stream"),
			);
			const reader = openResponse(response);
			expect(timers.size).toBe(1);
			await reader.read();
			const ping = [...timers.values()][0];
			ping();
			ping();
			ping();
			expect(decoder.decode((await reader.read()).value)).toBe(": ping\n\n");
			let nextSettled = false;
			const next = reader.read().then((value) => {
				nextSettled = true;
				return value;
			});
			await Promise.resolve();
			expect(nextSettled).toBe(false);
			await reader.cancel();
			expect((await next).done).toBe(true);
			expect(timers.size).toBe(0);
		});
		it("closes and removes timer plus abort and bus listeners on abort", async () => {
			const ac = new AbortController();
			const request = new Request("http://localhost/api/stream", {
				signal: ac.signal,
			});
			const removeListener = spyOn(request.signal, "removeEventListener");
			const before = handler.listeners();
			const reader = openResponse(handler.create()(request));
			await reader.read();
			ac.abort();
			expect(timers.size).toBe(0);
			expect(handler.listeners()).toBe(before);
			expect(removeListener).toHaveBeenCalledWith(
				"abort",
				expect.any(Function),
			);
			expect((await reader.read()).done).toBe(true);
			removeListener.mockRestore();
		});
		it("does not register timers or listeners for pre-aborted requests", async () => {
			const ac = new AbortController();
			ac.abort();
			const before = handler.listeners();
			const reader = openResponse(
				handler.create()(
					new Request("http://localhost/api/stream", { signal: ac.signal }),
				),
			);
			expect(handler.listeners()).toBe(before);
			expect(timers.size).toBe(0);
			expect((await reader.read()).done).toBe(true);
		});
		it("cleans up and closes on event serialization failure", async () => {
			const before = handler.listeners();
			const reader = openResponse(
				handler.create()(new Request("http://localhost/api/stream")),
			);
			await reader.read();
			handler.emitFailure();
			expect(handler.listeners()).toBe(before);
			expect(timers.size).toBe(0);
			expect((await reader.read()).done).toBe(true);
		});
	});
}
