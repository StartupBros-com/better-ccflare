import { describe, expect, it } from "bun:test";
import {
	BUFFER_SIZES,
	SseFrameBuffer,
	SseLimitError,
} from "@better-ccflare/core";

const encoder = new TextEncoder();

function makeBuffer(
	overrides: Partial<{ maxFrameBytes: number; maxBufferBytes: number }> = {},
): SseFrameBuffer {
	return new SseFrameBuffer({
		maxFrameBytes: overrides.maxFrameBytes ?? BUFFER_SIZES.SSE_FRAME_MAX_BYTES,
		maxBufferBytes:
			overrides.maxBufferBytes ?? BUFFER_SIZES.SSE_BUFFER_MAX_BYTES,
	});
}

describe("SseFrameBuffer", () => {
	it("extracts a single LF-terminated frame", () => {
		const buf = makeBuffer();
		const frames = buf.push(
			encoder.encode('event: message_start\ndata: {"a":1}\n\n'),
		);
		expect(frames).toEqual(['event: message_start\ndata: {"a":1}']);
	});

	it("extracts multiple LF-terminated frames delivered in one push", () => {
		const buf = makeBuffer();
		const frames = buf.push(
			encoder.encode('event: a\ndata: {"a":1}\n\nevent: b\ndata: {"b":2}\n\n'),
		);
		expect(frames).toEqual([
			'event: a\ndata: {"a":1}',
			'event: b\ndata: {"b":2}',
		]);
	});

	it("extracts a CRLF-terminated frame", () => {
		const buf = makeBuffer();
		const frames = buf.push(
			encoder.encode('event: message_start\r\ndata: {"a":1}\r\n\r\n'),
		);
		expect(frames).toEqual(['event: message_start\r\ndata: {"a":1}']);
	});

	it("extracts a frame whose CRLF delimiter is split across two push() calls", () => {
		const buf = makeBuffer();
		// Split right in the middle of the \r\n\r\n delimiter.
		const first = buf.push(
			encoder.encode('event: message_start\r\ndata: {"a":1}\r\n\r'),
		);
		expect(first).toEqual([]);
		const second = buf.push(
			encoder.encode("\nevent: next\r\ndata: {}\r\n\r\n"),
		);
		expect(second).toEqual([
			'event: message_start\r\ndata: {"a":1}',
			"event: next\r\ndata: {}",
		]);
	});

	it("throws SseLimitError for a single oversized-but-complete frame in one push()", () => {
		const buf = makeBuffer({ maxFrameBytes: 16, maxBufferBytes: 1024 });
		const oversized = `event: big\ndata: ${"x".repeat(64)}\n\n`;
		expect(() => buf.push(encoder.encode(oversized))).toThrow(SseLimitError);
	});

	it("applies the per-frame cap to every extracted frame, not just the tail", () => {
		// Two complete frames delivered together: the first is small, the
		// second is oversized. The tail after extraction is empty (well under
		// any buffer cap), so only a per-frame check on each sliced frame
		// (not a tail-remainder check) can catch the second frame.
		const buf = makeBuffer({ maxFrameBytes: 16, maxBufferBytes: 1024 });
		const smallFrame = "event: a\ndata: {}\n\n";
		const oversizedFrame = `event: b\ndata: ${"y".repeat(64)}\n\n`;
		expect(() => buf.push(encoder.encode(smallFrame + oversizedFrame))).toThrow(
			SseLimitError,
		);
	});

	it("throws SseLimitError when an unterminated remainder exceeds the buffer cap", () => {
		const buf = makeBuffer({ maxFrameBytes: 1024, maxBufferBytes: 32 });
		const neverTerminated = `event: growing\ndata: ${"z".repeat(64)}`;
		expect(() => buf.push(encoder.encode(neverTerminated))).toThrow(
			SseLimitError,
		);
	});

	it("flush() returns trailing partial content correctly", () => {
		const buf = makeBuffer();
		const frames = buf.push(
			encoder.encode("event: complete\ndata: {}\n\nevent: partial\ndata: {"),
		);
		expect(frames).toEqual(["event: complete\ndata: {}"]);
		expect(buf.flush()).toBe("event: partial\ndata: {");
	});

	it("flush() returns empty string when the buffer is empty", () => {
		const buf = makeBuffer();
		buf.push(encoder.encode("event: complete\ndata: {}\n\n"));
		expect(buf.flush()).toBe("");
	});

	it("accumulates a never-delimited tail in small chunks without quadratic slowdown", () => {
		// Regression test for a quadratic push(): restarting the delimiter
		// scan from index 0 and re-encoding the whole buffer on every call
		// made accumulating an unterminated tail in small chunks O(n^2).
		// Benchmarked against the unfixed implementation: 256-byte chunks
		// up to the 4MiB cap took ~31s of synchronous CPU. A correct
		// incremental implementation finishes in well under a second; 2s
		// leaves ample margin for CI variance while still failing hard
		// against a regression back to full rescans/re-encodes per push.
		const buf = makeBuffer();
		const chunkSize = 256;
		// No \r or \n anywhere, so no delimiter is ever found and every
		// byte stays in the buffered, unterminated tail.
		const chunk = encoder.encode("x".repeat(chunkSize));
		const chunkCount =
			Math.ceil(BUFFER_SIZES.SSE_BUFFER_MAX_BYTES / chunkSize) + 2;

		const start = performance.now();
		expect(() => {
			for (let i = 0; i < chunkCount; i++) {
				buf.push(chunk);
			}
		}).toThrow(SseLimitError);
		const elapsedMs = performance.now() - start;

		expect(elapsedMs).toBeLessThan(2000);
	}, 35_000);
});
