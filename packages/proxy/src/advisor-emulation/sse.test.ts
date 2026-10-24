import { describe, expect, it } from "bun:test";
import {
	AnthropicBlockAccumulator,
	encodeSseFrame,
	SseFrameParser,
} from "./sse";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("SseFrameParser", () => {
	it("keeps raw bytes per frame and parses event/data", () => {
		const text =
			'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
		const p = new SseFrameParser();
		const frames = p.push(enc.encode(text));
		expect(frames).toHaveLength(2);
		expect(frames[0].event).toBe("message_start");
		expect((frames[0].json as { type: string }).type).toBe("message_start");
		expect(dec.decode(frames[0].raw) + dec.decode(frames[1].raw)).toBe(text);
	});

	it("reassembles frames split across arbitrary chunk boundaries", () => {
		const text = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"x":2}\n\n';
		const bytes = enc.encode(text);
		const p = new SseFrameParser();
		const out: string[] = [];
		for (let i = 0; i < bytes.length; i++) {
			for (const f of p.push(bytes.subarray(i, i + 1)))
				out.push(dec.decode(f.raw));
		}
		expect(out.join("")).toBe(text);
		expect(out).toHaveLength(2);
	});

	it("tolerates CRLF, comments and multi-line data", () => {
		const p = new SseFrameParser();
		const frames = p.push(
			enc.encode(
				': keepalive\r\nevent: x\r\ndata: {"a":\r\ndata: 1}\r\n\r\n: only comment\n\n',
			),
		);
		expect(frames).toHaveLength(2);
		expect(frames[0].event).toBe("x");
		expect(frames[0].json).toEqual({ a: 1 });
		expect(frames[1].event).toBeUndefined();
		expect(frames[1].json).toBeUndefined();
	});

	it("leaves non-JSON data unparsed and flush() returns a trailing partial frame", () => {
		const p = new SseFrameParser();
		const frames = p.push(
			enc.encode("event: x\ndata: not json\n\nevent: y\ndata: 1"),
		);
		expect(frames).toHaveLength(1);
		expect(frames[0].json).toBeUndefined();
		const rest = p.flush();
		expect(rest).toHaveLength(1);
		expect(dec.decode(rest[0].raw)).toBe("event: y\ndata: 1");
	});
});

describe("encodeSseFrame", () => {
	it("encodes event + compact JSON data with a blank-line terminator", () => {
		expect(dec.decode(encodeSseFrame("ping", { type: "ping" }))).toBe(
			'event: ping\ndata: {"type":"ping"}\n\n',
		);
	});
});

describe("AnthropicBlockAccumulator", () => {
	it("rebuilds text, thinking+signature and tool_use input", () => {
		const acc = new AnthropicBlockAccumulator();
		acc.start(0, { type: "text", text: "" });
		acc.delta(0, { type: "text_delta", text: "he" });
		acc.delta(0, { type: "text_delta", text: "llo" });
		expect(acc.stop(0)).toEqual({ type: "text", text: "hello" });

		acc.start(1, { type: "thinking", thinking: "", signature: "" });
		acc.delta(1, { type: "thinking_delta", thinking: "hm" });
		acc.delta(1, { type: "signature_delta", signature: "sig" });
		expect(acc.stop(1)).toEqual({
			type: "thinking",
			thinking: "hm",
			signature: "sig",
		});

		acc.start(2, { type: "tool_use", id: "t1", name: "Read", input: {} });
		acc.delta(2, { type: "input_json_delta", partial_json: '{"a":' });
		acc.delta(2, { type: "input_json_delta", partial_json: "1}" });
		expect(acc.stop(2)).toEqual({
			type: "tool_use",
			id: "t1",
			name: "Read",
			input: { a: 1 },
		});
	});

	it("keeps empty input for a tool_use with no deltas and complete-at-start blocks", () => {
		const acc = new AnthropicBlockAccumulator();
		acc.start(0, { type: "tool_use", id: "t", name: "advisor", input: {} });
		expect(acc.stop(0)).toEqual({
			type: "tool_use",
			id: "t",
			name: "advisor",
			input: {},
		});
		acc.start(1, { type: "redacted_thinking", data: "abc" });
		expect(acc.stop(1)).toEqual({ type: "redacted_thinking", data: "abc" });
		acc.start(2, {
			type: "advisor_tool_result",
			tool_use_id: "x",
			content: { type: "advisor_result", text: "t" },
		});
		expect(acc.stop(2)?.type).toBe("advisor_tool_result");
	});

	it("returns undefined for an unknown index and exposes partial blocks", () => {
		const acc = new AnthropicBlockAccumulator();
		expect(acc.stop(9)).toBeUndefined();
		acc.start(0, { type: "text", text: "" });
		acc.delta(0, { type: "text_delta", text: "x" });
		expect(acc.peek(0)).toEqual({ type: "text", text: "x" });
	});
});
