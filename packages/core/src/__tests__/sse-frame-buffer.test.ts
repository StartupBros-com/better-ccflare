import { describe, expect, it } from "bun:test";
import {
	BUFFER_SIZES,
	SseFrameBuffer,
	SseLimitError,
	StreamResourceLimitError,
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

/**
 * Build ASCII frame content (prefix + repeated "a" filler) whose encoded
 * byte length is exactly `targetBytes`. Every character here is ASCII, so
 * string length and encoded byte length are always equal, which keeps the
 * byte-accounting in these tests exact without re-encoding to check.
 */
function buildAsciiPayload(prefix: string, targetBytes: number): string {
	const prefixBytes = encoder.encode(prefix).length;
	if (prefixBytes > targetBytes) {
		throw new Error(
			`prefix of ${prefixBytes} bytes exceeds target of ${targetBytes} bytes`,
		);
	}
	return prefix + "a".repeat(targetBytes - prefixBytes);
}

function catchError(fn: () => unknown): unknown {
	try {
		fn();
		return undefined;
	} catch (err) {
		return err;
	}
}

describe("SseFrameBuffer resource policies", () => {
	// AE1: the exact incident-observed frame size (110,079 bytes), well
	// under the new 4MiB transport frame policy, must succeed for both LF
	// and CRLF delimiters, including a delimiter split across chunks.
	const INCIDENT_FRAME_BYTES = 110_079;

	it("accepts the exact 110,079-byte LF-delimited incident frame under the transport frame policy", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const payload = buildAsciiPayload(
			"event: incident\ndata: ",
			INCIDENT_FRAME_BYTES,
		);
		const frames = buf.push(encoder.encode(`${payload}\n\n`));
		expect(frames).toEqual([payload]);
		expect(encoder.encode(frames[0]).length).toBe(INCIDENT_FRAME_BYTES);
	});

	it("accepts the exact 110,079-byte CRLF-delimited incident frame with the delimiter split across chunks", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const payload = buildAsciiPayload(
			"event: incident\r\ndata: ",
			INCIDENT_FRAME_BYTES,
		);
		// Split right in the middle of the trailing \r\n\r\n delimiter, as in
		// the existing split-delimiter test above.
		const first = buf.push(encoder.encode(`${payload}\r\n\r`));
		expect(first).toEqual([]);
		const second = buf.push(encoder.encode("\n"));
		expect(second).toEqual([payload]);
		expect(encoder.encode(second[0]).length).toBe(INCIDENT_FRAME_BYTES);
	});

	it("accepts a complete frame at exactly the 4MiB transport frame policy cap", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const payload = buildAsciiPayload(
			"event: cap\ndata: ",
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);
		const frames = buf.push(encoder.encode(`${payload}\n\n`));
		expect(frames).toEqual([payload]);
		expect(encoder.encode(frames[0]).length).toBe(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);
	});

	it("rejects a complete frame one byte over the 4MiB transport frame policy cap with kind sse_frame", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const targetBytes = BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES + 1;
		const payload = buildAsciiPayload("event: cap\ndata: ", targetBytes);
		const err = catchError(() => buf.push(encoder.encode(`${payload}\n\n`)));
		expect(err).toBeInstanceOf(SseLimitError);
		const sseErr = err as SseLimitError;
		expect(sseErr.kind).toBe("sse_frame");
		expect(sseErr.limitBytes).toBe(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES);
		expect(sseErr.actualBytes).toBe(targetBytes);
	});

	it("accepts an unterminated tail at exactly the 4MiB transport tail policy cap", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const payload = "a".repeat(BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES);
		const frames = buf.push(encoder.encode(payload));
		expect(frames).toEqual([]);
		expect(buf.flush()).toBe(payload);
	});

	it("rejects an unterminated tail one byte over the 4MiB transport tail policy cap with kind sse_tail", () => {
		const buf = makeBuffer({
			maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
			maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		});
		const targetBytes = BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1;
		const payload = "a".repeat(targetBytes);
		const err = catchError(() => buf.push(encoder.encode(payload)));
		expect(err).toBeInstanceOf(SseLimitError);
		const sseErr = err as SseLimitError;
		expect(sseErr.kind).toBe("sse_tail");
		expect(sseErr.limitBytes).toBe(BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES);
		expect(sseErr.actualBytes).toBe(targetBytes);
	});

	it("rechecks the tail cap after decoder flush so a split multi-byte code point cannot bypass it", () => {
		// Small cap so the test stays fast and the arithmetic stays readable.
		const capBytes = 40;
		const buf = makeBuffer({ maxFrameBytes: 1024, maxBufferBytes: capBytes });

		// Fill the tail to exactly the cap with single-byte ASCII characters.
		const filled = buf.push(encoder.encode("x".repeat(capBytes)));
		expect(filled).toEqual([]);

		// Push a single lead byte of a 3-byte UTF-8 sequence (U+2603 SNOWMAN
		// is E2 98 83). TextDecoder in streaming mode buffers an incomplete
		// trailing sequence internally and returns "" for it, so tailBytes
		// stays at the cap and this push does not throw.
		const incomplete = buf.push(new Uint8Array([0xe2]));
		expect(incomplete).toEqual([]);

		// flush()'s final (non-streaming) decode() call materializes the
		// pending byte as a 3-byte replacement character, adding bytes that
		// were never counted against the tail cap on push(). The cap must
		// be rechecked here, or these bytes bypass it entirely.
		const err = catchError(() => buf.flush());
		expect(err).toBeInstanceOf(SseLimitError);
		const sseErr = err as SseLimitError;
		expect(sseErr.kind).toBe("sse_tail");
		expect(sseErr.limitBytes).toBe(capBytes);
		expect(sseErr.actualBytes).toBe(capBytes + 3);
	});

	it("reports kind, limitBytes, and actualBytes without including payload text in the message", () => {
		const buf = makeBuffer({ maxFrameBytes: 16, maxBufferBytes: 1024 });
		const secretPayload = "super-secret-token-value";
		const oversized = `event: big\ndata: ${secretPayload}\n\n`;
		const err = catchError(() => buf.push(encoder.encode(oversized)));
		expect(err).toBeInstanceOf(SseLimitError);
		const sseErr = err as SseLimitError;
		expect(sseErr.kind).toBe("sse_frame");
		expect(typeof sseErr.limitBytes).toBe("number");
		expect(typeof sseErr.actualBytes).toBe("number");
		expect(sseErr.message).not.toContain(secretPayload);
	});

	it("is an instance of StreamResourceLimitError so translators can catch the shared base", () => {
		const buf = makeBuffer({ maxFrameBytes: 16, maxBufferBytes: 1024 });
		const oversized = `event: big\ndata: ${"x".repeat(64)}\n\n`;
		const err = catchError(() => buf.push(encoder.encode(oversized)));
		expect(err).toBeInstanceOf(SseLimitError);
		expect(err).toBeInstanceOf(StreamResourceLimitError);
	});
});
