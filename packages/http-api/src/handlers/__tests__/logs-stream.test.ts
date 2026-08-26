import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { createLogsStreamHandler } from "../logs";

const decoder = new TextDecoder();

function logEvent(msg: string): LogEvent {
	return { ts: 1, level: "INFO", msg };
}

async function readFrames(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	count: number,
): Promise<string[]> {
	const frames: string[] = [];
	while (frames.length < count) {
		const { done, value } = await reader.read();
		expect(done).toBe(false);
		frames.push(decoder.decode(value));
	}
	return frames;
}

async function expectTerminal(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
	await reader.read().then(
		({ done }) => expect(done).toBe(true),
		() => undefined,
	);
}

describe("createLogsStreamHandler", () => {
	const handler = createLogsStreamHandler();
	const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

	afterEach(async () => {
		await Promise.all(readers.splice(0).map((reader) => reader.cancel()));
	});

	it("frames the connection and log events exactly in synchronous emit order", async () => {
		const response = handler(
			new Request("https://proxy.local/api/logs/stream"),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		readers.push(reader as ReadableStreamDefaultReader<Uint8Array>);

		logBus.emit("log", logEvent("first"));
		logBus.emit("log", logEvent("second"));

		expect(
			await readFrames(reader as ReadableStreamDefaultReader<Uint8Array>, 3),
		).toEqual([
			`data: ${JSON.stringify({ connected: true })}\n\n`,
			`data: ${JSON.stringify(logEvent("first"))}\n\n`,
			`data: ${JSON.stringify(logEvent("second"))}\n\n`,
		]);
	});

	it("keeps concurrent viewers independent when one consumer cancels", async () => {
		const listenersBefore = logBus.listenerCount("log");
		const first = handler(new Request("https://proxy.local/api/logs/stream"));
		const second = handler(new Request("https://proxy.local/api/logs/stream"));
		const firstReader = first.body?.getReader();
		const secondReader = second.body?.getReader();
		expect(firstReader).toBeDefined();
		expect(secondReader).toBeDefined();
		readers.push(
			firstReader as ReadableStreamDefaultReader<Uint8Array>,
			secondReader as ReadableStreamDefaultReader<Uint8Array>,
		);

		expect(logBus.listenerCount("log")).toBe(listenersBefore + 2);
		await firstReader?.cancel("first viewer disconnected");
		expect(logBus.listenerCount("log")).toBe(listenersBefore + 1);

		logBus.emit("log", logEvent("only second viewer remains"));
		expect(
			await readFrames(
				secondReader as ReadableStreamDefaultReader<Uint8Array>,
				2,
			),
		).toEqual([
			`data: ${JSON.stringify({ connected: true })}\n\n`,
			`data: ${JSON.stringify(logEvent("only second viewer remains"))}\n\n`,
		]);
	});

	it("removes the log and named abort listeners when a consumer cancels", async () => {
		const requestController = new AbortController();
		const removeAbortListener = spyOn(
			requestController.signal,
			"removeEventListener",
		);
		const listenersBefore = logBus.listenerCount("log");
		const response = handler(
			new Request("https://proxy.local/api/logs/stream", {
				signal: requestController.signal,
			}),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		readers.push(reader as ReadableStreamDefaultReader<Uint8Array>);

		await reader?.cancel("viewer disconnected");

		expect(logBus.listenerCount("log")).toBe(listenersBefore);
		expect(removeAbortListener).toHaveBeenCalledTimes(1);
		expect(removeAbortListener).toHaveBeenCalledWith(
			"abort",
			expect.any(Function),
		);
		removeAbortListener.mockRestore();
	});

	it("cleans up and terminally closes when the request aborts", async () => {
		const requestController = new AbortController();
		const removeAbortListener = spyOn(
			requestController.signal,
			"removeEventListener",
		);
		const listenersBefore = logBus.listenerCount("log");
		const response = handler(
			new Request("https://proxy.local/api/logs/stream", {
				signal: requestController.signal,
			}),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		readers.push(reader as ReadableStreamDefaultReader<Uint8Array>);

		await readFrames(reader as ReadableStreamDefaultReader<Uint8Array>, 1);
		requestController.abort();

		expect(logBus.listenerCount("log")).toBe(listenersBefore);
		expect(removeAbortListener).toHaveBeenCalledTimes(1);
		await expectTerminal(reader as ReadableStreamDefaultReader<Uint8Array>);
		removeAbortListener.mockRestore();
	});

	it("does not subscribe for a request that was already aborted", async () => {
		const requestController = new AbortController();
		requestController.abort();
		const listenersBefore = logBus.listenerCount("log");
		const response = handler(
			new Request("https://proxy.local/api/logs/stream", {
				signal: requestController.signal,
			}),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		readers.push(reader as ReadableStreamDefaultReader<Uint8Array>);

		expect(logBus.listenerCount("log")).toBe(listenersBefore);
		await expectTerminal(reader as ReadableStreamDefaultReader<Uint8Array>);
	});

	it("contains serialization failures, cleans up, and terminally closes", async () => {
		const requestController = new AbortController();
		const removeAbortListener = spyOn(
			requestController.signal,
			"removeEventListener",
		);
		const listenersBefore = logBus.listenerCount("log");
		const response = handler(
			new Request("https://proxy.local/api/logs/stream", {
				signal: requestController.signal,
			}),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		readers.push(reader as ReadableStreamDefaultReader<Uint8Array>);
		await readFrames(reader as ReadableStreamDefaultReader<Uint8Array>, 1);

		const circular = { value: "circular" };
		(circular as { self?: unknown }).self = circular;
		expect(() => logBus.emit("log", circular as LogEvent)).not.toThrow();

		expect(logBus.listenerCount("log")).toBe(listenersBefore);
		expect(removeAbortListener).toHaveBeenCalledTimes(1);
		await expectTerminal(reader as ReadableStreamDefaultReader<Uint8Array>);
		removeAbortListener.mockRestore();
	});
});
