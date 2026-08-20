import { describe, expect, it } from "bun:test";
import {
	BoundedJsonTooLargeError,
	readBoundedRequestBody,
	serializeBoundedJson,
} from "../bounded-request-body";

const encoder = new TextEncoder();

function requestFromStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
	headers?: HeadersInit,
	signal?: AbortSignal,
): Pick<Request, "body" | "headers"> & { signal?: AbortSignal } {
	return { body: stream, headers: new Headers(headers), signal };
}

function streamFromChunks(
	chunks: Uint8Array<ArrayBuffer>[],
	onCancel?: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
		cancel: onCancel,
	});
}

describe("serializeBoundedJson", () => {
	it("preserves JSON.stringify semantics while enforcing the UTF-8 limit", () => {
		const value = {
			drop: undefined,
			list: [undefined, () => undefined, Symbol("ignored")],
			custom: { toJSON: () => "é" },
		};
		const serialized = JSON.stringify(value);

		expect(
			serializeBoundedJson(value, Buffer.byteLength(serialized, "utf8")),
		).toBe(serialized);
		expect(() =>
			serializeBoundedJson(value, Buffer.byteLength(serialized, "utf8") - 1),
		).toThrow(BoundedJsonTooLargeError);
	});

	it("matches JSON.stringify when toJSON returns its receiver", () => {
		const value = {
			name: "self-returning",
			toJSON() {
				return this;
			},
		};
		const serialized = JSON.stringify(value);

		expect(
			serializeBoundedJson(value, Buffer.byteLength(serialized, "utf8")),
		).toBe(serialized);
	});

	it("preserves invalid JSON serialization errors", () => {
		expect(() => serializeBoundedJson({ value: 1n }, 8)).toThrow(TypeError);
	});
});

describe("readBoundedRequestBody", () => {
	it("returns null for a request without a body", async () => {
		await expect(
			readBoundedRequestBody(requestFromStream(null), 8),
		).resolves.toBe(null);
	});

	it("returns an exact empty buffer for an empty body", async () => {
		const body = await readBoundedRequestBody(
			requestFromStream(streamFromChunks([])),
			8,
		);

		expect(body).toBeInstanceOf(ArrayBuffer);
		expect(body?.byteLength).toBe(0);
	});

	it("preserves binary and multibyte UTF-8 bytes exactly", async () => {
		const payload = new Uint8Array([0, 255, ...encoder.encode("é")]);
		const body = await readBoundedRequestBody(
			requestFromStream(
				streamFromChunks([payload.subarray(0, 2), payload.subarray(2)]),
			),
			8,
		);

		expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([...payload]);
	});

	it("accepts a body exactly at the byte limit", async () => {
		const body = await readBoundedRequestBody(
			requestFromStream(
				streamFromChunks([encoder.encode("1234"), encoder.encode("5678")]),
				{ "content-length": "8" },
			),
			8,
		);

		if (body === null) throw new Error("Expected an accepted request body");
		expect(new TextDecoder().decode(body)).toBe("12345678");
	});

	it("returns the actual body length for safe Content-Length mismatches", async () => {
		const underlength = await readBoundedRequestBody(
			requestFromStream(streamFromChunks([encoder.encode("1234")]), {
				"content-length": "8",
			}),
			8,
		);
		expect(underlength?.byteLength).toBe(4);

		const overlength = await readBoundedRequestBody(
			requestFromStream(
				streamFromChunks([encoder.encode("1234"), encoder.encode("5678")]),
				{
					"content-length": "4",
				},
			),
			8,
		);
		if (overlength === null)
			throw new Error("Expected an accepted request body");
		expect(new TextDecoder().decode(overlength)).toBe("12345678");
	});

	it("rejects a valid declared content length above the limit before reading", async () => {
		const unreadableBody = new ReadableStream<Uint8Array<ArrayBuffer>>();

		await expect(
			readBoundedRequestBody(
				requestFromStream(unreadableBody, { "content-length": "9" }),
				8,
			),
		).rejects.toMatchObject({
			name: "RequestBodyTooLargeError",
			source: "declared",
			limit: 8,
		});
		expect(unreadableBody.locked).toBe(false);
	});

	it("ignores malformed and unsafe content-length values", async () => {
		for (const contentLength of ["-1", "1.5", "8x", "9007199254740992"]) {
			const body = await readBoundedRequestBody(
				requestFromStream(streamFromChunks([encoder.encode("12345678")]), {
					"content-length": contentLength,
				}),
				8,
			);
			expect(body?.byteLength).toBe(8);
		}
	});

	it("recognizes leading-zero decimal content-length values", async () => {
		await expect(
			readBoundedRequestBody(
				requestFromStream(streamFromChunks([]), { "content-length": "0009" }),
				8,
			),
		).rejects.toMatchObject({ source: "declared", limit: 8 });
	});

	it("cancels and rejects streamed overflow without returning a retained prefix", async () => {
		let cancelled = false;
		let chunkIndex = 0;
		const chunks = [encoder.encode("1234"), encoder.encode("56789")];
		const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull(controller) {
				const chunk = chunks[chunkIndex++];
				if (chunk) controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			readBoundedRequestBody(requestFromStream(stream), 8),
		).rejects.toMatchObject({
			name: "RequestBodyTooLargeError",
			source: "streamed",
			limit: 8,
		});
		expect(cancelled).toBe(true);
	});

	it("rejects streamed overflow when cancellation never settles", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				controller.enqueue(encoder.encode("123456789"));
			},
			cancel() {
				cancelled = true;
				return new Promise<void>(() => {});
			},
		});

		const outcome = await Promise.race([
			readBoundedRequestBody(requestFromStream(stream), 8).then(
				() => "resolved",
				(error: unknown) =>
					error instanceof Error && error.name === "RequestBodyTooLargeError"
						? "too-large"
						: "wrong-error",
			),
			new Promise<"timed-out">((resolve) => {
				setTimeout(() => resolve("timed-out"), 50);
			}),
		]);

		expect(outcome).toBe("too-large");
		expect(cancelled).toBe(true);
		expect(stream.locked).toBe(false);
	});

	it("preserves abort errors from the body reader", async () => {
		const abort = new DOMException("client disconnected", "AbortError");
		const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				controller.error(abort);
			},
		});

		await expect(
			readBoundedRequestBody(requestFromStream(stream), 8),
		).rejects.toBe(abort);
	});

	it("preserves reader errors and releases the reader lock", async () => {
		const failure = new Error("reader failed");
		const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				controller.error(failure);
			},
		});

		await expect(
			readBoundedRequestBody(requestFromStream(body), 8),
		).rejects.toBe(failure);
		expect(body.locked).toBe(false);
	});

	it("rejects an already-aborted request before locking its body", async () => {
		const controller = new AbortController();
		const reason = new DOMException("client disconnected", "AbortError");
		controller.abort(reason);
		const body = streamFromChunks([encoder.encode("unread")]);

		await expect(
			readBoundedRequestBody(
				requestFromStream(body, undefined, controller.signal),
				8,
			),
		).rejects.toBe(reason);
		expect(body.locked).toBe(false);
	});

	it("cancels a pending read once and promptly rejects with the abort reason", async () => {
		const controller = new AbortController();
		const reason = new DOMException("client disconnected", "AbortError");
		let startReading: (() => void) | undefined;
		const reading = new Promise<void>((resolve) => {
			startReading = resolve;
		});
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull() {
				startReading?.();
				return new Promise<void>(() => {});
			},
			cancel() {
				cancellations += 1;
				return new Promise<void>(() => {});
			},
		});

		const admission = readBoundedRequestBody(
			requestFromStream(body, undefined, controller.signal),
			8,
		);
		await reading;
		controller.abort(reason);

		const outcome = await Promise.race([
			admission.then(
				() => "resolved",
				(error: unknown) => (error === reason ? "aborted" : "wrong-error"),
			),
			new Promise<"timed-out">((resolve) => {
				setTimeout(() => resolve("timed-out"), 50);
			}),
		]);
		expect(outcome).toBe("aborted");
		expect(cancellations).toBe(1);
		expect(body.locked).toBe(false);
	});
});
