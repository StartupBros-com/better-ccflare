import { describe, expect, mock, test } from "bun:test";
import { BUFFER_SIZES } from "@better-ccflare/core";
import { translateAnthropicStreamToResponses } from "../stream-translator";

async function collectSseEvents(
	response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
	const text = await response.text();
	const events: Array<{ event: string; data: unknown }> = [];
	const rawEvents = text.split("\n\n").filter((s) => s.trim().length > 0);

	for (const rawEvent of rawEvents) {
		const lines = rawEvent.split("\n");
		let eventType = "message";
		let dataStr = "";
		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				dataStr = line.slice(6).trim();
			}
		}
		if (dataStr) {
			events.push({ event: eventType, data: JSON.parse(dataStr) });
		}
	}

	return events;
}

function makeAnthropicStream(eventStrings: string[]): Response {
	const body = `${eventStrings.join("\n\n")}\n\n`;
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function sseEvent(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}`;
}

describe("translateAnthropicStreamToResponses", () => {
	test("simple text streaming — correct event sequence and content", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: " world" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_001",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.headers.get("content-type")).toBe("text/event-stream");

		const parsed = await collectSseEvents(result);

		// First event: response.created
		expect(parsed[0].event).toBe("response.created");
		const created = parsed[0].data as Record<string, unknown>;
		expect(created.type).toBe("response.created");
		expect((created.response as Record<string, unknown>).status).toBe(
			"in_progress",
		);

		// Second event: response.in_progress
		expect(parsed[1].event).toBe("response.in_progress");

		// Third event: response.output_item.added (message item)
		expect(parsed[2].event).toBe("response.output_item.added");
		const added = parsed[2].data as Record<string, unknown>;
		expect((added.item as Record<string, unknown>).type).toBe("message");
		expect((added.item as Record<string, unknown>).role).toBe("assistant");

		// Fourth: response.content_part.added
		expect(parsed[3].event).toBe("response.content_part.added");

		// Fifth + sixth: response.output_text.delta
		expect(parsed[4].event).toBe("response.output_text.delta");
		const delta1 = parsed[4].data as Record<string, unknown>;
		expect(delta1.delta).toBe("Hello");

		expect(parsed[5].event).toBe("response.output_text.delta");
		const delta2 = parsed[5].data as Record<string, unknown>;
		expect(delta2.delta).toBe(" world");

		// Seventh: response.output_text.done with full accumulated text
		expect(parsed[6].event).toBe("response.output_text.done");
		const textDone = parsed[6].data as Record<string, unknown>;
		expect(textDone.type).toBe("response.output_text.done");
		expect(textDone.item_id).toBe("resp_001_msg_0");
		expect(textDone.output_index).toBe(0);
		expect(textDone.content_index).toBe(0);
		expect(textDone.text).toBe("Hello world");

		// Eighth: response.content_part.done
		expect(parsed[7].event).toBe("response.content_part.done");

		// Ninth: response.output_item.done with full text
		expect(parsed[8].event).toBe("response.output_item.done");
		const done = parsed[8].data as Record<string, unknown>;
		const doneItem = done.item as Record<string, unknown>;
		expect(doneItem.type).toBe("message");
		expect(doneItem.status).toBe("completed");
		const content = doneItem.content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe("Hello world");

		// Last: response.completed with usage
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
		const doneFinal = lastEvent.data as Record<string, unknown>;
		const usage = (doneFinal.response as Record<string, unknown>)
			.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(10);
		expect(usage.output_tokens).toBe(5);
		expect(usage.total_tokens).toBe(15);
	});

	test("tool call streaming — correct function_call item events", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_2", usage: { input_tokens: 20, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_1", name: "read_file" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":' },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 8 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_002",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		// output_item.added should be a function_call
		const addedEvent = parsed.find(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvent).toBeDefined();
		const addedItem = (addedEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(addedItem.type).toBe("function_call");
		expect(addedItem.call_id).toBe("call_1");
		expect(addedItem.name).toBe("read_file");

		// function_call_arguments.delta events
		const argDeltas = parsed.filter(
			(e) => e.event === "response.function_call_arguments.delta",
		);
		expect(argDeltas.length).toBeGreaterThan(0);

		// output_item.done should have complete arguments
		const doneEvent = parsed.find(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvent).toBeDefined();
		const doneItem = (doneEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(doneItem.type).toBe("function_call");
		expect(doneItem.status).toBe("completed");
		expect(doneItem.arguments).toBe('{"path":"/tmp/x"}');

		// response.completed at end
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
	});

	test("mixed text + tool — both message and function_call items emitted in order", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_3", usage: { input_tokens: 15, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Sure!" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "call_2", name: "search" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 1,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 12 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_003",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		const addedEvents = parsed.filter(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvents).toHaveLength(2);
		expect(
			(
				(addedEvents[0].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("message");
		expect(
			(
				(addedEvents[1].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("function_call");

		const doneEvents = parsed.filter(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvents).toHaveLength(2);

		// Last event is response.completed
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
	});

	test("response.completed usage stats — input, output, total correct", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_4", usage: { input_tokens: 42, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 17 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_004",
			"test-model",
		);

		const parsed = await collectSseEvents(result);
		const doneEvent = parsed.find((e) => e.event === "response.completed");
		expect(doneEvent).toBeDefined();

		const resp = (doneEvent?.data as Record<string, unknown>)
			.response as Record<string, unknown>;
		const usage = resp.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(42);
		expect(usage.output_tokens).toBe(17);
		expect(usage.total_tokens).toBe(59);
		expect(resp.id).toBe("resp_004");
		expect(resp.model).toBe("test-model");
		expect(resp.status).toBe("completed");
	});
});

describe("translateAnthropicStreamToResponses SSE frame bounds", () => {
	const rawEncoder = new TextEncoder();

	/**
	 * Build an upstream Response backed by a custom ReadableStream that never
	 * closes on its own, so any observed close/cancel is attributable to the
	 * consumer side actively terminating it, not the source reaching EOF.
	 */
	function makeChunkedStream(chunks: string[]): {
		response: Response;
		cancelSpy: ReturnType<typeof mock>;
	} {
		const cancelSpy = mock((_reason?: unknown) => {});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(rawEncoder.encode(chunk));
				}
				// Deliberately left open: a real upstream connection just idles
				// after the cap trip. The reader must be actively cancelled by
				// the consumer rather than relying on EOF that never arrives.
			},
			cancel(reason) {
				cancelSpy(reason);
			},
		});
		return {
			response: new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			}),
			cancelSpy,
		};
	}

	/** Re-frame an array of LF-formatted sseEvent() strings as CRLF. */
	function crlfSseBody(eventStrings: string[]): string {
		return `${eventStrings
			.map((event) => event.replace(/\n/g, "\r\n"))
			.join("\r\n\r\n")}\r\n\r\n`;
	}

	test("CRLF-terminated stream produces the same event sequence and content as LF", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: {
					id: "msg_crlf",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: " world" },
			}),
			sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const lfUpstream = makeAnthropicStream(events);
		const lfResult = translateAnthropicStreamToResponses(
			lfUpstream,
			"resp_crlf_lf",
			"claude-3-5-sonnet-20241022",
		);
		const lfParsed = await collectSseEvents(lfResult);

		const crlfUpstream = new Response(crlfSseBody(events), {
			headers: { "Content-Type": "text/event-stream" },
		});
		const crlfResult = translateAnthropicStreamToResponses(
			crlfUpstream,
			"resp_crlf_lf",
			"claude-3-5-sonnet-20241022",
		);
		const crlfParsed = await collectSseEvents(crlfResult);

		// This fails today: lineBuffer.lastIndexOf("\n\n") never matches inside
		// a \r\n\r\n delimiter, so the CRLF stream never finds a frame boundary
		// in transform() and only the flush() path (treating the entire
		// buffered blob as one event) runs, producing a different event
		// sequence than the LF stream.
		expect(crlfParsed.map((e) => e.event)).toEqual(
			lfParsed.map((e) => e.event),
		);
		expect(crlfParsed[crlfParsed.length - 1].event).toBe("response.completed");
		const textDone = crlfParsed.find(
			(e) => e.event === "response.output_text.done",
		);
		expect((textDone?.data as Record<string, unknown>).text).toBe(
			"Hello world",
		);
	});

	test("oversized single frame emits response.failed, no response.completed after, and cancels the upstream reader", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_oversize",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const oversizedFrame = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "text_delta",
				text: "x".repeat(BUFFER_SIZES.SSE_FRAME_MAX_BYTES + 1024),
			},
		});

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStart}\n\n`,
			`${oversizedFrame}\n\n`,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_oversize",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.failed");

		// Allow the upstream cancellation (triggered via the writable side
		// erroring from controller.terminate()) to propagate a task tick.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("unterminated oversized tail emits response.failed, no response.completed after, and cancels the upstream reader", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_tail",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		// No terminating "\n\n" anywhere in this chunk or after it: this
		// exercises the unterminated-tail cap rather than the per-frame cap.
		const unterminated = "x".repeat(BUFFER_SIZES.SSE_BUFFER_MAX_BYTES + 1024);

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStart}\n\n`,
			unterminated,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_tail",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("per-call tool argument cap trip emits response.failed with no response.completed after", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_tool_cap",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call_big", name: "write_file" },
		});

		// Each individual delta frame stays well under the per-frame SSE cap;
		// only their accumulated total (tracked per tool call) exceeds the
		// per-call argument byte cap.
		const chunkSize = 4096;
		const chunkCount =
			Math.ceil(BUFFER_SIZES.SSE_FRAME_MAX_BYTES / chunkSize) + 2;
		const deltaFrames = Array.from({ length: chunkCount }, () =>
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: "a".repeat(chunkSize),
				},
			}),
		)
			.map((event) => `${event}\n\n`)
			.join("");

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStart}\n\n`,
			deltaFrames,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_tool_cap",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("per-block text argument cap trip emits response.failed with no response.completed after, and cancels the upstream reader", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_text_cap",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});

		// Each individual delta frame stays well under the per-frame SSE cap;
		// only their accumulated total (tracked per text block) exceeds the
		// per-block byte cap.
		const chunkSize = 4096;
		const chunkCount =
			Math.ceil(BUFFER_SIZES.SSE_FRAME_MAX_BYTES / chunkSize) + 2;
		const deltaFrames = Array.from({ length: chunkCount }, () =>
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "text_delta",
					text: "a".repeat(chunkSize),
				},
			}),
		)
			.map((event) => `${event}\n\n`)
			.join("");

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStart}\n\n`,
			deltaFrames,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_text_cap",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.failed");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("cap trip surfaced via flush() (unterminated final frame at natural stream EOF) emits response.failed with no response.completed after", async () => {
		// Unlike the transform()-path cap tests above, this exercises the
		// flush() branch (~line 508-522 in stream-translator.ts): the frame
		// carrying the over-cap delta never gets a trailing blank-line
		// delimiter, so SseFrameBuffer.push() never extracts it as a complete
		// frame (it just sits in the buffered tail, well under the
		// unterminated-buffer cap). The limit is only discovered once the
		// upstream source reaches a real EOF and the TransformStream's
		// flush() hands that leftover tail to processSseFrame().
		//
		// Because the source has already legitimately finished (closed
		// itself, as a real upstream connection does once it has sent all
		// its bytes) by the time flush() runs, there is nothing left to
		// cancel: verified directly against the Streams spec (cancelling an
		// already-closed ReadableStream is a no-op that never reaches the
		// underlying source's cancel algorithm), so this test does not
		// assert upstream cancellation the way the transform()-path cap
		// tests do.
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_flush_cap",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const oversizedDelta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "text_delta",
				text: "x".repeat(BUFFER_SIZES.SSE_FRAME_MAX_BYTES + 1024),
			},
		});

		const encoder = new TextEncoder();
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(`${messageStart}\n\n${blockStart}\n\n`),
				);
				// No trailing "\n\n": this frame is never extracted by push(),
				// only recovered by flush() once the stream below closes.
				controller.enqueue(encoder.encode(oversizedDelta));
				controller.close();
			},
		});

		const result = translateAnthropicStreamToResponses(
			new Response(upstream, {
				headers: { "Content-Type": "text/event-stream" },
			}),
			"resp_flush_cap",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.failed");
	});
});
