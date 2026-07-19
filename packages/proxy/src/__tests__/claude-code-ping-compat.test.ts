import { describe, expect, it, mock } from "bun:test";
import { BUFFER_SIZES } from "@better-ccflare/core";
import {
	ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
	coordinateAnthropicPreCommitRescue,
	createAnthropicPreCommitRescueActivation,
} from "../anthropic-precommit-rescue";
import { adaptAnthropicSsePingsForClaudeCode } from "../claude-code-ping-compat";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLAUDE_CODE_2_1_212_UA = "claude-cli/2.1.212 (external, cli)";

function claudeRequest(userAgent = CLAUDE_CODE_2_1_212_UA): Request {
	return new Request("http://localhost:8788/v1/messages", {
		method: "POST",
		headers: {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"user-agent": userAgent,
		},
		body: JSON.stringify({
			model: "claude-opus-4-6",
			messages: [{ role: "user", content: "continue" }],
			stream: true,
		}),
	});
}

function sseResponse(body: BodyInit): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"x-upstream": "preserved",
		},
	});
}

function chunkedStream(
	chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
	});
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/**
 * Compatibility fixture copied from the installed Claude Code 2.1.212
 * (build 8b2783a8) Stream.fromSSEResponse dispatch behavior. Its SDK drops
 * named `ping` events before yielding, while generic named `message` events
 * are parsed and yielded to Claude Code's outer watchdog/consumer.
 */
function parseLikeInstalledClaudeCode212(body: string): unknown[] {
	const yielded: unknown[] = [];
	const yieldable = new Set([
		"message_start",
		"message_delta",
		"message_stop",
		"content_block_start",
		"content_block_delta",
		"content_block_stop",
		"message",
	]);
	for (const frame of body.split(/\r?\n\r?\n/)) {
		if (!frame) continue;
		let event: string | null = null;
		const data: string[] = [];
		for (const rawLine of frame.split("\n")) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "event") event = value;
			if (field === "data") data.push(value);
		}
		if (event && yieldable.has(event))
			yielded.push(JSON.parse(data.join("\n")));
		if (event === "ping") continue;
	}
	return yielded;
}

describe("Claude Code custom-base ping compatibility", () => {
	it("turns a real Anthropic ping into an installed-client-yieldable, UI-empty event", async () => {
		expect(
			parseLikeInstalledClaudeCode212(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME),
		).toEqual([]);

		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME),
		);
		const body = await response.text();
		const events = parseLikeInstalledClaudeCode212(body);

		expect(body).toBe('event: message\ndata: {"type":"ping"}\n\n');
		expect(events).toEqual([{ type: "ping" }]);
		expect(JSON.stringify(events)).not.toContain("text");
		expect(JSON.stringify(events)).not.toContain("thinking");
	});

	it("rewrites fragmented LF and CRLF ping frames without changing their data or delimiters", async () => {
		const chunks = [
			encoder.encode("event: pi"),
			encoder.encode('ng\ndata: {"type":"pi'),
			encoder.encode('ng"}\n\nevent: ping\r'),
			encoder.encode('\ndata: {"type":"ping"}\r\n\r'),
			encoder.encode("\n"),
		];
		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(chunkedStream(chunks)),
		);

		expect(await response.text()).toBe(
			'event: message\ndata: {"type":"ping"}\n\n' +
				'event: message\r\ndata: {"type":"ping"}\r\n\r\n',
		);
	});

	it("rewrites the ping correctly at every possible transport split", async () => {
		for (const original of [
			'event: ping\ndata: {"type":"ping"}\n\n',
			'event: ping\r\ndata: {"type":"ping"}\r\n\r\n',
		]) {
			const bytes = encoder.encode(original);
			for (let split = 0; split <= bytes.byteLength; split++) {
				const response = adaptAnthropicSsePingsForClaudeCode(
					claudeRequest(),
					new URL("http://localhost:8788/v1/messages"),
					sseResponse(
						chunkedStream([bytes.slice(0, split), bytes.slice(split)]),
					),
				);
				expect(await response.text()).toBe(
					original.replace("event: ping", "event: message"),
				);
			}
		}
	});

	it("keeps every non-ping byte identical, including malformed and incomplete frames", async () => {
		const chunks = [
			encoder.encode(
				': comment\r\n\r\nevent: message_start\r\ndata: {"type":"message_start","message":{"content":[]}}\r\n\r\n',
			),
			new Uint8Array([0xff, 0xfe, 0x00, 0x61, 0x62]),
			encoder.encode('\nevent: ping\ndata: {"type":"not_ping"}\n\npartial'),
		];
		const expected = concatenate(chunks);
		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(chunkedStream(chunks)),
		);

		expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
	});

	it("fails open for CR-only framing and ping-like text outside an exact event field", async () => {
		for (const body of [
			'event: ping\rdata: {"type":"ping"}\r\r',
			': event: ping\ndata: {"type":"ping"}\n\n',
			'event: message\ndata: {"type":"ping","note":"event: ping"}\n\n',
			'event: ping \ndata: {"type":"ping"}\n\n',
			'event: Ping\ndata: {"type":"ping"}\n\n',
			'Event: ping\ndata: {"type":"ping"}\n\n',
		]) {
			const response = adaptAnthropicSsePingsForClaudeCode(
				claudeRequest(),
				new URL("http://localhost:8788/v1/messages"),
				sseResponse(body),
			);
			expect(await response.text()).toBe(body);
		}
	});

	it("returns the original response for generic clients and non-SSE responses", () => {
		const generic = sseResponse(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME);
		expect(
			adaptAnthropicSsePingsForClaudeCode(
				claudeRequest("curl/8.0"),
				new URL("http://localhost:8788/v1/messages"),
				generic,
			),
		).toBe(generic);

		const json = new Response('{"ok":true}', {
			headers: { "content-type": "application/json" },
		});
		expect(
			adaptAnthropicSsePingsForClaudeCode(
				claudeRequest(),
				new URL("http://localhost:8788/v1/messages"),
				json,
			),
		).toBe(json);
	});

	it("requires matching ping event and data types and removes stale content-length only when wrapped", async () => {
		const mismatched = 'event: ping\ndata: {"type":"not_ping"}\n\n';
		const original = new Response(mismatched, {
			headers: {
				"content-type": "text/event-stream",
				"content-length": String(encoder.encode(mismatched).byteLength),
				"x-preserved": "yes",
			},
		});
		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			original,
		);

		expect(response).not.toBe(original);
		expect(response.headers.get("content-length")).toBeNull();
		expect(response.headers.get("x-preserved")).toBe("yes");
		expect(await response.text()).toBe(mismatched);
	});

	it("fails open byte-identically when an unterminated frame exceeds the parser tail limit", async () => {
		const oversized = new Uint8Array(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1,
		);
		oversized.fill(0x78);
		const suffix = encoder.encode('event: ping\ndata: {"type":"ping"}\n\n');
		const expected = concatenate([oversized, suffix]);
		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(chunkedStream([oversized, suffix])),
		);

		expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
	});

	it("processes a single transport chunk over 4 MiB when it contains only bounded complete frames", async () => {
		const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
		const delta = [
			"event: content_block_delta",
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "x".repeat(900) },
			}),
			"",
			"",
		].join("\n");
		const pair = ping + delta;
		const repeatCount =
			Math.floor(BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES / pair.length) + 2;
		const body = pair.repeat(repeatCount);
		expect(encoder.encode(body).byteLength).toBeGreaterThan(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		);

		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(chunkedStream([encoder.encode(body)])),
		);

		expect(await response.text()).toBe(
			body.replaceAll("event: ping", "event: message"),
		);
	});

	it("finishes a near-limit buffered frame before applying the tail cap to a following ping", async () => {
		const framePrefix = 'event: future\ndata: {"type":"future","blob":"';
		const frameSuffix = '"}';
		const firstChunk =
			framePrefix +
			"x".repeat(
				BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES -
					framePrefix.length -
					frameSuffix.length -
					8,
			) +
			frameSuffix;
		const secondChunk = '\n\nevent: ping\ndata: {"type":"ping"}\n\n';
		expect(encoder.encode(firstChunk).byteLength).toBeLessThanOrEqual(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);
		expect(encoder.encode(firstChunk + secondChunk).byteLength).toBeGreaterThan(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		);

		const response = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(
				chunkedStream([
					encoder.encode(firstChunk),
					encoder.encode(secondChunk),
				]),
			),
		);

		expect(await response.text()).toBe(
			`${firstChunk}\n\nevent: message\ndata: {"type":"ping"}\n\n`,
		);
	});

	it("keeps delimiter lookahead across every LF and CRLF split after an exact-limit frame", async () => {
		const framePrefix = 'event: future\ndata: {"type":"future","blob":"';
		const frameSuffix = '"}';
		const frame = encoder.encode(
			framePrefix +
				"x".repeat(
					BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES -
						framePrefix.length -
						frameSuffix.length,
				) +
				frameSuffix,
		);
		const ping = encoder.encode('event: ping\ndata: {"type":"ping"}\n\n');
		const rewrittenPing = 'event: message\ndata: {"type":"ping"}\n\n';
		expect(frame.byteLength).toBe(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES);

		for (const delimiterText of ["\n\n", "\r\n\r\n"]) {
			const delimiter = encoder.encode(delimiterText);
			for (let split = 1; split < delimiter.byteLength; split++) {
				const response = adaptAnthropicSsePingsForClaudeCode(
					claudeRequest(),
					new URL("http://localhost:8788/v1/messages"),
					sseResponse(
						chunkedStream([
							frame,
							delimiter.subarray(0, split),
							concatenate([delimiter.subarray(split), ping]),
						]),
					),
				);
				const output = new Uint8Array(await response.arrayBuffer());

				expect(output.subarray(0, frame.byteLength)).toEqual(frame);
				expect(
					output.subarray(
						frame.byteLength,
						frame.byteLength + delimiter.byteLength,
					),
				).toEqual(delimiter);
				expect(
					decoder.decode(
						output.subarray(frame.byteLength + delimiter.byteLength),
					),
				).toBe(rewrittenPing);
			}
		}
	});

	it("wraps rescue-generated pings after the outer coordinator", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		activation.activate();
		const rescue = await coordinateAnthropicPreCommitRescue({
			response: new Promise<Response>(() => undefined),
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 1_000,
				commitmentDeadlineMs: 100,
			},
		});
		const wrapped = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			rescue,
		);
		const reader = wrapped.body?.getReader();
		const first = await reader?.read();
		await reader?.cancel("test complete");

		expect(decoder.decode(first?.value)).toBe(
			'event: message\ndata: {"type":"ping"}\n\n',
		);
	});

	it("propagates downstream cancellation to the upstream stream", async () => {
		const cancelled = mock((_reason?: unknown) => undefined);
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode("event: pi"));
			},
			cancel(reason) {
				cancelled(reason);
			},
		});
		const wrapped = adaptAnthropicSsePingsForClaudeCode(
			claudeRequest(),
			new URL("http://localhost:8788/v1/messages"),
			sseResponse(upstream),
		);
		const reader = wrapped.body?.getReader();
		await reader?.cancel("client gone");

		expect(cancelled).toHaveBeenCalledWith("client gone");
	});
});
