import { describe, expect, it, mock } from "bun:test";
import { teeStream } from "../stream-tee";

describe("tee collection opt-out", () => {
	for (const collect of [true, false]) {
		it(`passes every chunk and closes exactly once with collect=${collect}`, async () => {
			const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
			const upstream = new ReadableStream<Uint8Array>({
				start(c) {
					for (const chunk of chunks) c.enqueue(chunk);
					c.close();
				},
			});
			const onChunk = mock(() => {});
			const onClose = mock(() => {});
			const reader = teeStream(upstream, {
				collect,
				maxBytes: 1,
				onChunk,
				onClose,
			}).getReader();
			expect((await reader.read()).value).toBe(chunks[0]);
			expect((await reader.read()).value).toBe(chunks[1]);
			expect((await reader.read()).done).toBe(true);
			expect(onChunk).toHaveBeenCalledTimes(2);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledWith(
				collect ? [new Uint8Array([1])] : [],
				collect,
			);
			expect(upstream.locked).toBe(false);
		});
		it(`cancels pending reads once and releases the source with collect=${collect}`, async () => {
			const cancel = mock(() => {});
			const upstream = new ReadableStream<Uint8Array>({ cancel });
			const onCancel = mock(() => {}),
				onClose = mock(() => {}),
				onError = mock(() => {});
			const reader = teeStream(upstream, {
				collect,
				onCancel,
				onClose,
				onError,
			}).getReader();
			const pending = reader.read();
			await reader.cancel("stop");
			await pending;
			expect(onCancel).toHaveBeenCalledWith("stop");
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(onClose).not.toHaveBeenCalled();
			expect(onError).not.toHaveBeenCalled();
			expect(upstream.locked).toBe(false);
		});
		it(`propagates source errors without close with collect=${collect}`, async () => {
			const failure = new Error("source failed");
			const upstream = new ReadableStream<Uint8Array>({
				pull(c) {
					c.error(failure);
				},
			});
			const onError = mock(() => {}),
				onClose = mock(() => {});
			const reader = teeStream(upstream, {
				collect,
				onError,
				onClose,
			}).getReader();
			await expect(reader.read()).rejects.toBe(failure);
			expect(onError).toHaveBeenCalledTimes(1);
			expect(onClose).not.toHaveBeenCalled();
			expect(upstream.locked).toBe(false);
		});
	}
});
