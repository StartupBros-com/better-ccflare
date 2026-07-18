import { describe, expect, it } from "bun:test";
import { BUFFER_SIZES } from "@better-ccflare/core";
import {
	type AnthropicStreamOutcome,
	AnthropicStreamOutcomeTracker,
} from "../anthropic-stream-outcome";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}

function track(
	chunks: readonly string[],
	options?: ConstructorParameters<typeof AnthropicStreamOutcomeTracker>[0],
): AnthropicStreamOutcome {
	const tracker = new AnthropicStreamOutcomeTracker(options);
	for (const chunk of chunks) tracker.push(bytes(chunk));
	return tracker.finish();
}

describe("AnthropicStreamOutcomeTracker", () => {
	it("reports completion only after a message_stop event", () => {
		const outcome = track([
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private output"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "completed",
			terminalEvidence: "message_stop",
			messageStopSeen: true,
			messageStopCount: 1,
			eventCount: 3,
			parseState: "clean",
		});
		expect(outcome).not.toHaveProperty("payload");
		expect(outcome).not.toHaveProperty("message");
	});

	it("accepts policy-valid SSE frames larger than the legacy 1 MiB cap", () => {
		const padding = "x".repeat(1024 * 1024 + 128);
		const frame = `event: message_stop\ndata: ${JSON.stringify({
			type: "message_stop",
			ignored: padding,
		})}\n\n`;
		const encoded = bytes(frame);

		expect(encoded.byteLength).toBeGreaterThan(1024 * 1024);
		expect(encoded.byteLength).toBeLessThanOrEqual(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);
		expect(track([frame])).toMatchObject({
			status: "completed",
			messageStopSeen: true,
			parseState: "clean",
		});
	});

	it("still bounds complete frames at the shared SSE transport policy", () => {
		const frame = `event: message_stop\ndata: ${JSON.stringify({
			type: "message_stop",
			ignored: "x".repeat(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES),
		})}\n\n`;
		const outcome = track([frame]);

		expect(bytes(frame).byteLength).toBeGreaterThan(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);
		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			messageStopSeen: false,
			parseState: "limit_exceeded",
			limitKind: "sse_frame",
		});
	});

	it("handles arbitrary UTF-8 chunk splits and CRLF delimiters", () => {
		const wire =
			": keepalive\r\n\r\n" +
			'event: message_stop\r\ndata: {"type":"message_stop","ignored":"🌍"}\r\n\r\n';
		const encoded = bytes(wire);
		const tracker = new AnthropicStreamOutcomeTracker();
		for (const byte of encoded) tracker.push(new Uint8Array([byte]));

		expect(tracker.finish()).toMatchObject({
			status: "completed",
			messageStopSeen: true,
			frameCount: 2,
			commentFrameCount: 1,
			parseState: "clean",
		});
	});

	it("joins multiline data fields before parsing", () => {
		const outcome = track([
			"event: message_stop\n",
			'data: {"type":\n',
			'data: "message_stop"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "completed",
			messageStopSeen: true,
			malformedEventCount: 0,
		});
	});

	it("recognizes a synthesized message_stop by payload type", () => {
		const outcome = track(['data: {"type":"message_stop"}\n\n']);

		expect(outcome).toMatchObject({
			status: "completed",
			terminalEvidence: "message_stop",
			messageStopCount: 1,
		});
	});

	it("rejects an explicit message_stop without a data payload", () => {
		const outcome = track(["event: message_stop\n\n"]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			terminalEvidence: "none",
			messageStopSeen: false,
			messageStopCount: 0,
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("rejects an explicit message_stop with malformed JSON data", () => {
		const outcome = track([
			'event: message_stop\ndata: {"type":"message_stop"\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			terminalEvidence: "none",
			messageStopSeen: false,
			messageStopCount: 0,
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("rejects an explicit message_stop with a scalar JSON payload", () => {
		const outcome = track(['event: message_stop\ndata: "message_stop"\n\n']);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			terminalEvidence: "none",
			messageStopSeen: false,
			messageStopCount: 0,
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("rejects an explicit message_stop whose object payload type conflicts", () => {
		const outcome = track([
			'event: message_stop\ndata: {"type":"message_delta"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			terminalEvidence: "none",
			messageStopSeen: false,
			messageStopCount: 0,
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("reports a midstream error and retains only a bounded safe error type", () => {
		const outcome = track([
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"secret upstream details"}}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "midstream_error",
			terminalEvidence: "error_event",
			errorEventSeen: true,
			errorEventCount: 1,
			errorType: "overloaded_error",
		});
		expect(JSON.stringify(outcome)).not.toContain("secret upstream details");
	});

	it("uses an opaque error type for unsafe or oversized provider values", () => {
		const unsafe = track([
			'event: error\ndata: {"type":"error","error":{"type":"bad type\\nsecret"}}\n\n',
		]);
		const oversized = track([
			`event: error\ndata: ${JSON.stringify({
				type: "error",
				error: { type: "a".repeat(200) },
			})}\n\n`,
		]);

		expect(unsafe.errorType).toBe("unknown_error");
		expect(oversized.errorType).toBe("unknown_error");
	});

	it("lets any later error event override an earlier message_stop", () => {
		const outcome = track([
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "midstream_error",
			terminalEvidence: "error_and_message_stop",
			messageStopSeen: true,
			errorEventSeen: true,
			messageStopCount: 1,
			errorEventCount: 1,
			errorType: "api_error",
		});
	});

	it("keeps an earlier error terminal when a later message_stop arrives", () => {
		const outcome = track([
			'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "midstream_error",
			terminalEvidence: "error_and_message_stop",
			messageStopSeen: true,
			errorEventSeen: true,
			messageStopCount: 1,
			errorEventCount: 1,
			errorType: "api_error",
		});
	});

	it("treats conflicting explicit event and payload types as malformed and trusts event:error", () => {
		const outcome = track([
			'event: error\ndata: {"type":"message_stop","error":{"type":"overloaded_error"}}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "midstream_error",
			terminalEvidence: "error_event",
			messageStopSeen: false,
			errorEventSeen: true,
			errorType: "overloaded_error",
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("does not accept a payload message_stop that conflicts with an explicit event", () => {
		const outcome = track([
			'event: content_block_delta\ndata: {"type":"message_stop"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			messageStopSeen: false,
			parseState: "malformed",
		});
	});

	it("does not let a payload error override a conflicting explicit event", () => {
		const outcome = track([
			'event: future_event\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			errorEventSeen: false,
			parseState: "malformed",
			unknownEventCount: 1,
		});
	});

	it("counts ping and unknown forward-compatible events without treating them as malformed", () => {
		const outcome = track([
			'event: ping\ndata: {"type":"ping"}\n\n',
			'event: future_event\ndata: {"type":"future_event","value":"private"}\n\n',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			pingEventCount: 1,
			unknownEventCount: 1,
			malformedEventCount: 0,
			eventCount: 2,
		});
	});

	it("distinguishes malformed JSON without throwing from push or finish", () => {
		const tracker = new AnthropicStreamOutcomeTracker();

		expect(() =>
			tracker.push(bytes('event: content_block_delta\ndata: {"broken"\n\n')),
		).not.toThrow();
		expect(() => tracker.finish()).not.toThrow();
		expect(tracker.finish()).toMatchObject({
			status: "incomplete_eof",
			parseState: "malformed",
			malformedEventCount: 1,
		});
	});

	it("marks a truncated trailing event as malformed at EOF", () => {
		const outcome = track([
			'event: content_block_delta\ndata: {"type":"content_block_delta"',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			parseState: "malformed",
			truncatedTailSeen: true,
			malformedEventCount: 1,
		});
	});

	it("never derives message_stop evidence from an unterminated flush tail", () => {
		const outcome = track([
			'event: message_stop\ndata: {"type":"message_stop"}',
		]);

		expect(outcome).toMatchObject({
			status: "incomplete_eof",
			terminalEvidence: "none",
			messageStopSeen: false,
			messageStopCount: 0,
			truncatedTailSeen: true,
			parseState: "malformed",
		});
	});

	it("distinguishes frame and unterminated-tail limit failures and remains no-throw", () => {
		const oversizedFrame = new AnthropicStreamOutcomeTracker({
			maxFrameBytes: 16,
			maxBufferBytes: 64,
		});
		const firstChunk = bytes(`data: ${"x".repeat(20)}\n\n`);
		const secondChunk = bytes("not parsed after limit");
		expect(() => oversizedFrame.push(firstChunk)).not.toThrow();
		expect(() => oversizedFrame.push(secondChunk)).not.toThrow();
		expect(oversizedFrame.finish()).toMatchObject({
			chunkCount: 2,
			rawByteCount: firstChunk.byteLength + secondChunk.byteLength,
			status: "incomplete_eof",
			parseState: "limit_exceeded",
			limitKind: "sse_frame",
		});

		const oversizedTail = new AnthropicStreamOutcomeTracker({
			maxFrameBytes: 64,
			maxBufferBytes: 8,
		});
		expect(() => oversizedTail.push(bytes("unterminated"))).not.toThrow();
		expect(oversizedTail.finish()).toMatchObject({
			status: "incomplete_eof",
			parseState: "limit_exceeded",
			limitKind: "sse_tail",
		});
	});

	it("is idempotent after finish and ignores later chunks", () => {
		const tracker = new AnthropicStreamOutcomeTracker();
		tracker.push(
			bytes('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
		);
		const first = tracker.finish();

		expect(() =>
			tracker.push(
				bytes(
					'event: error\ndata: {"type":"error","error":{"type":"late_error"}}\n\n',
				),
			),
		).not.toThrow();
		expect(tracker.finish()).toEqual(first);
	});
});
