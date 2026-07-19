import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_SSE_FRAME_KINDS,
	classifyAnthropicSseFrame,
	createAnthropicSseFrameKindCounts,
	incrementAnthropicSseFrameKindCount,
} from "../anthropic-sse-frame-classifier";

describe("classifyAnthropicSseFrame protocol activity", () => {
	it("accepts only complete parsed protocol events as idle-refresh evidence", () => {
		for (const frame of [
			'event: ping\ndata: {"type":"ping"}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":2}}\n\n',
		]) {
			expect(classifyAnthropicSseFrame(frame).validProtocolActivity).toBeTrue();
		}

		for (const frame of [
			": keepalive\n\n",
			"event: ping\n\n",
			"event: future_event\ndata: {not-json}\n\n",
			'event: message_start\ndata: {"type":"message_start"}\n\n',
		]) {
			expect(
				classifyAnthropicSseFrame(frame).validProtocolActivity,
			).toBeUndefined();
		}
	});

	it("uses fixed sanitized keys and saturates counters", () => {
		const counts = createAnthropicSseFrameKindCounts();
		expect(Object.keys(counts)).toEqual([...ANTHROPIC_SSE_FRAME_KINDS]);

		counts.unknown = Number.MAX_SAFE_INTEGER;
		incrementAnthropicSseFrameKindCount(counts, "unknown");
		expect(counts.unknown).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("treats signature_delta as structural integrity metadata", () => {
		const frame =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-integrity-metadata"}}\n\n';

		expect(classifyAnthropicSseFrame(frame)).toEqual({
			kind: "structural",
			validProtocolActivity: true,
		});
	});
});
