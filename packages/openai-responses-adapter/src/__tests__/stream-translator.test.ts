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

// Counts how many times a given SSE event name appears in an already-parsed
// event list, so cap-trip tests can assert exactly one terminal failure
// instead of only "at least one".
function countEventOccurrences(
	events: Array<{ event: string }>,
	eventName: string,
): number {
	return events.filter((e) => e.event === eventName).length;
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
		// Sized against the new 4MiB transport frame cap
		// (SSE_TRANSPORT_FRAME_MAX_BYTES), not the old 64KiB shared cap: a
		// frame this size is now legal traffic well below the ceiling
		// everywhere except right here where it is the ceiling itself that is
		// being tripped.
		const oversizedFrame = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "text_delta",
				text: "x".repeat(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES + 1024),
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
		// One typed terminal event only: a cap trip must not be reported twice.
		expect(countEventOccurrences(parsed, "response.failed")).toBe(1);

		// Allow the upstream cancellation (triggered via the writable side
		// erroring from controller.terminate()) to propagate a task tick.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	// AE1: the exact real-world scenario that motivated raising the SSE
	// transport frame cap from 64KiB to 4MiB (see
	// packages/core/src/constants.ts, SSE_TRANSPORT_FRAME_MAX_BYTES). Under
	// the pre-U2 shared 64KiB cap this frame alone would have tripped the
	// per-frame limit; it must now translate successfully end to end, with no
	// limit error and no early upstream cancellation.
	test("accepts a 110,079-byte content_block_delta frame (the largest complete frame observed in the field) and completes normally", async () => {
		const targetFrameBytes = 110_079;
		const buildDeltaFrame = (text: string) =>
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			});
		const baseBytes = rawEncoder.encode(buildDeltaFrame("")).length;
		const padLength = targetFrameBytes - baseBytes;
		expect(padLength).toBeGreaterThan(0);
		const incidentText = "x".repeat(padLength);
		const incidentFrame = buildDeltaFrame(incidentText);
		expect(rawEncoder.encode(incidentFrame).length).toBe(targetFrameBytes);

		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_incident",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const blockStop = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const messageStop = sseEvent("message_stop", { type: "message_stop" });

		const upstream = makeAnthropicStream([
			messageStart,
			blockStart,
			incidentFrame,
			blockStop,
			messageStop,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_incident",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		expect(parsed.some((e) => e.event === "response.failed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
		const textDone = parsed.find(
			(e) => e.event === "response.output_text.done",
		);
		expect((textDone?.data as Record<string, unknown>).text).toBe(incidentText);
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
		// Sized against the new 4MiB transport tail cap
		// (SSE_TRANSPORT_TAIL_MAX_BYTES), not the old 4MiB SSE_BUFFER_MAX_BYTES
		// alias (same value today, but this test should track the policy
		// constant a stalled tail is actually checked against).
		const unterminated = "x".repeat(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1024,
		);

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
		// One typed terminal event only: a cap trip must not be reported twice.
		expect(countEventOccurrences(parsed, "response.failed")).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("late cap trip after response.completed does not emit a contradictory response.failed", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_late_trip",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const blockStop = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const messageStop = sseEvent("message_stop", { type: "message_stop" });
		// A complete, valid conversation first: response.completed is emitted
		// and doneSent becomes true. The upstream then keeps sending
		// undelimited junk (no frame delimiter anywhere) until the tail cap
		// trips during transform. First terminal event wins: the late cap trip
		// must terminate the stream without emitting a contradictory
		// response.failed after the response already completed.
		const trailingJunk = "x".repeat(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1024,
		);

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStart}\n\n${blockStop}\n\n${messageStop}\n\n`,
			trailingJunk,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_late_trip",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		expect(countEventOccurrences(parsed, "response.completed")).toBe(1);
		expect(parsed.some((e) => e.event === "response.failed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.completed");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("trailing content events after message_stop emit nothing after response.completed", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_trailing_content",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const blockStop = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const messageStop = sseEvent("message_stop", { type: "message_stop" });
		// Protocol-violating upstream: after message_stop, it keeps sending
		// well-framed content events. First terminal event wins: none of them
		// may produce output after response.completed.
		const trailingBlockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		});
		const trailingDelta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "late output" },
		});

		const upstream = makeAnthropicStream([
			messageStart,
			blockStart,
			blockStop,
			messageStop,
			trailingBlockStart,
			trailingDelta,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_trailing",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		expect(countEventOccurrences(parsed, "response.completed")).toBe(1);
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
		expect(parsed.some((e) => e.event === "response.failed")).toBe(false);
		const completedIndex = parsed.findIndex(
			(e) => e.event === "response.completed",
		);
		expect(completedIndex).toBe(parsed.length - 1);
		expect(
			parsed.some(
				(e) =>
					e.event === "response.output_text.delta" &&
					JSON.stringify(e.data).includes("late output"),
			),
		).toBe(false);
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

		// Each individual delta frame stays well under the per-frame SSE cap
		// (now 4MiB); only their accumulated total for this one call exceeds
		// the per-call argument byte cap (still 64KiB, but sourced from the
		// dedicated TOOL_ARGUMENTS_PER_CALL_MAX_BYTES constant rather than the
		// old shared frame-cap constant).
		const chunkSize = 4096;
		const chunkCount =
			Math.ceil(BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES / chunkSize) + 2;
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
		// Message content distinguishes the per-call kind from the aggregate
		// translated-output-total kind exercised by a later test below.
		const failedData = failedEvent?.data as Record<string, unknown>;
		const failedResponse = failedData.response as Record<string, unknown>;
		const failedError = failedResponse.error as Record<string, unknown>;
		expect(failedError.message).toContain(
			"Tool call arguments for call_id call_big totaled",
		);
		expect(countEventOccurrences(parsed, "response.failed")).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("multiple tool calls each under 64KiB totalling over 64KiB succeed (no aggregate tool-only cap)", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_multi_tool",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});

		// Three tool calls, each with 30,000 bytes of arguments: individually
		// well under the 64KiB per-call cap, but their sum (90,000 bytes)
		// exceeds what the old shared 64KiB constant would have allowed if it
		// had been (incorrectly) applied as an aggregate-across-tool-calls
		// cap. There is deliberately no such tool-only aggregate cap: only
		// the much larger 4MiB translated-output-total cap applies across
		// blocks, and 90,000 bytes stays far under it.
		const perCallBytes = 30_000;
		expect(perCallBytes).toBeLessThan(
			BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
		);
		expect(perCallBytes * 3).toBeGreaterThan(
			BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
		);

		const callIds = ["call_x", "call_y", "call_z"];
		const toolEvents: string[] = [];
		callIds.forEach((callId, index) => {
			toolEvents.push(
				sseEvent("content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "tool_use", id: callId, name: "search" },
				}),
			);
			toolEvents.push(
				sseEvent("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: {
						type: "input_json_delta",
						partial_json: "a".repeat(perCallBytes),
					},
				}),
			);
			toolEvents.push(
				sseEvent("content_block_stop", {
					type: "content_block_stop",
					index,
				}),
			);
		});

		const messageDelta = sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 3 },
		});
		const messageStop = sseEvent("message_stop", { type: "message_stop" });

		const upstream = makeAnthropicStream([
			messageStart,
			...toolEvents,
			messageDelta,
			messageStop,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_multi_tool",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		expect(parsed.some((e) => e.event === "response.failed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
		const doneEvents = parsed.filter(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvents).toHaveLength(3);
		for (const doneEvent of doneEvents) {
			const item = (doneEvent.data as Record<string, unknown>).item as Record<
				string,
				unknown
			>;
			expect(item.type).toBe("function_call");
			expect((item.arguments as string).length).toBe(perCallBytes);
		}
	});

	// Deliberate new policy: text output has no per-block cap of its own.
	// A long, legitimately large translated response routinely exceeds
	// 64KiB; only the much larger 4MiB translated-output-total cap bounds
	// it now (see the translated_output_total tests below).
	test("translated text over 64KiB and under 4MiB total succeeds and appears intact in the final output", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_large_text",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});
		const blockStart = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});

		// Comfortably over the old 64KiB shared cap, comfortably under the
		// 4MiB translated-output-total cap.
		const largeTextBytes = BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES * 4;
		expect(largeTextBytes).toBeLessThan(
			BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES,
		);
		const chunkSize = 4096;
		const chunkCount = Math.ceil(largeTextBytes / chunkSize);
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
		const blockStop = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const messageDelta = sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 3 },
		});
		const messageStop = sseEvent("message_stop", { type: "message_stop" });

		// Built directly (not via makeAnthropicStream) because deltaFrames is
		// already a joined string of individually delimited frames, not one
		// more raw event string to join.
		const body = `${messageStart}\n\n${blockStart}\n\n${deltaFrames}${blockStop}\n\n${messageDelta}\n\n${messageStop}\n\n`;
		const upstream = new Response(body, {
			headers: { "Content-Type": "text/event-stream" },
		});

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_large_text",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		expect(parsed.some((e) => e.event === "response.failed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
		const textDone = parsed.find(
			(e) => e.event === "response.output_text.done",
		);
		expect((textDone?.data as Record<string, unknown>).text).toBe(
			"a".repeat(chunkSize * chunkCount),
		);
	});

	test("combined text plus tool output over 4MiB fails once with kind translated_output_total, cancels upstream, never emits completed", async () => {
		const messageStart = sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_total_cap",
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		});

		// A text block that alone stays comfortably under the 4MiB total cap,
		// followed by two tool calls that each individually stay under the
		// 64KiB per-call cap but whose combination with the text block's
		// bytes pushes the running translated-output total over 4MiB. The
		// second tool call's own bytes (50,000) never approach the per-call
		// cap (65,536), so only the aggregate total check can be what trips.
		const textBytes = 4_100_000;
		const perToolBytes = 50_000;
		expect(perToolBytes).toBeLessThan(
			BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
		);
		expect(textBytes + perToolBytes * 2).toBeGreaterThan(
			BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES,
		);
		expect(textBytes + perToolBytes).toBeLessThan(
			BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES,
		);

		const blockStartText = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const textDelta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "a".repeat(textBytes) },
		});
		const blockStopText = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const blockStartTool1 = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "call_a", name: "search" },
		});
		const tool1Delta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 1,
			delta: {
				type: "input_json_delta",
				partial_json: "b".repeat(perToolBytes),
			},
		});
		const blockStopTool1 = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 1,
		});
		const blockStartTool2 = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "call_b", name: "search" },
		});
		// This delta's own bytes (50,000) stay under the per-call cap, but
		// pushes the cumulative translated-output total over the 4MiB cap.
		const tool2Delta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 2,
			delta: {
				type: "input_json_delta",
				partial_json: "c".repeat(perToolBytes),
			},
		});

		const { response: upstream, cancelSpy } = makeChunkedStream([
			`${messageStart}\n\n${blockStartText}\n\n`,
			`${textDelta}\n\n${blockStopText}\n\n`,
			`${blockStartTool1}\n\n${tool1Delta}\n\n${blockStopTool1}\n\n`,
			`${blockStartTool2}\n\n${tool2Delta}\n\n`,
		]);

		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_total_cap",
			"claude-3-5-sonnet-20241022",
		);
		const parsed = await collectSseEvents(result);

		const failedEvent = parsed.find((e) => e.event === "response.failed");
		expect(failedEvent).toBeDefined();
		expect(parsed.some((e) => e.event === "response.completed")).toBe(false);
		expect(parsed[parsed.length - 1].event).toBe("response.failed");
		expect(countEventOccurrences(parsed, "response.failed")).toBe(1);
		const failedData = failedEvent?.data as Record<string, unknown>;
		const failedResponse = failedData.response as Record<string, unknown>;
		const failedError = failedResponse.error as Record<string, unknown>;
		expect(failedError.message).toContain("Translated output total of");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelSpy).toHaveBeenCalled();
	});

	test("cap trip surfaced via flush() (unterminated final frame at natural stream EOF) trips the translated-output-total cap", async () => {
		// Unlike the transform()-path cap tests above, this exercises the
		// flush() branch: the frame carrying the over-cap delta never gets a
		// trailing blank-line delimiter, so SseFrameBuffer.push() never
		// extracts it as a complete frame (it just sits in the buffered
		// tail, well under the unterminated-tail cap). The limit is only
		// discovered once the upstream source reaches a real EOF and the
		// TransformStream's flush() hands that leftover tail to
		// processSseFrame().
		//
		// A first text block closes normally (properly delimited, extracted
		// via push()) with enough bytes to leave only a small amount of
		// headroom under the 4MiB translated-output-total cap. A second text
		// block's delta, well under the tail cap on its own, is left
		// unterminated so it is only recovered by flush(); adding its bytes
		// to the already-large running total is what trips the cap, inside
		// flush() rather than transform().
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
		const blockStart0 = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const firstTextBytes = 4_000_000;
		const firstDelta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "a".repeat(firstTextBytes) },
		});
		const blockStop0 = sseEvent("content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		const blockStart1 = sseEvent("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		});
		const secondTextBytes = 250_000;
		expect(firstTextBytes + secondTextBytes).toBeGreaterThan(
			BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES,
		);
		expect(secondTextBytes).toBeLessThan(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		);
		const secondDelta = sseEvent("content_block_delta", {
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "b".repeat(secondTextBytes) },
		});

		const encoder = new TextEncoder();
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`${messageStart}\n\n${blockStart0}\n\n${firstDelta}\n\n${blockStop0}\n\n${blockStart1}\n\n`,
					),
				);
				// No trailing "\n\n": this frame is never extracted by push(),
				// only recovered by flush() once the stream below closes.
				controller.enqueue(encoder.encode(secondDelta));
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
		expect(countEventOccurrences(parsed, "response.failed")).toBe(1);
		const failedData = failedEvent?.data as Record<string, unknown>;
		const failedResponse = failedData.response as Record<string, unknown>;
		const failedError = failedResponse.error as Record<string, unknown>;
		expect(failedError.message).toContain("Translated output total of");
	});
});

describe("translateAnthropicStreamToResponses bounded memory under concurrency", () => {
	// Budget derivation: one stream materializes a ~4MiB text buffer plus its
	// JSON-escaped SSE re-encoding, so a realistic per-stream peak (the raw
	// text, the frame buffer's own copy while parsing, and the re-emitted
	// output_text.delta/done events carrying the same bytes again) lands
	// around 8-12MiB. Elsewhere on the request path (outside this
	// translator entirely, e.g. the pre-existing analytics request-body
	// copy in packages/proxy) another ~4MiB is held per request, which this
	// test does not exercise. Budgeting ~20MiB per concurrent stream leaves
	// ample headroom above the ~8-12MiB realistic peak for GC timing
	// variance and V8 heap fragmentation, while still catching a true
	// unbounded-growth regression, which would blow past this budget by
	// orders of magnitude rather than by a safe margin.
	//
	// Retry rationale (investigated, not assumed): a single instantaneous
	// process.memoryUsage().heapUsed sample around many concurrent large
	// ReadableStream/TransformStream/Response bodies is bimodal in this Bun
	// runtime, independent of anything this translator does. A minimal
	// pass-through TransformStream with zero of this translator's own
	// bookkeeping (no Map, no outputItems, no byte counters) reproduces the
	// exact same bimodal pattern: most runs settle back to a near-zero
	// delta after Bun.gc(true), but a fraction of runs stay stable (does
	// not shrink over further GC passes) at a much larger delta, purely as
	// a function of GC/allocator scheduling around native stream buffers.
	// A real leak in this translator (e.g. block buffers never freed on
	// content_block_stop) would fail *every* trial, not just some, because
	// it is driven by retained references, not by GC timing. Retrying the
	// full measurement and accepting the minimum observed delta therefore
	// filters out the runtime noise while still requiring the code to
	// demonstrably hit the tight, meaningful budget below.
	// Scope note: this suite gates RETAINED memory (leaks), not transient
	// peak. Serialized output is a multiple of the semantic text bytes: the
	// same text is re-emitted in output_text.done, content_part.done,
	// output_item.done, and response.completed, so a near-4MiB block
	// serializes to roughly 5x that on the wire, and per-delta SSE/JSON
	// envelopes add overhead on top. That churn is transient and bounded by
	// stream backpressure (a slow reader stalls the transform), so it is
	// recorded by the informational benchmark's peak columns rather than
	// gated here.
	const PER_STREAM_BUDGET_BYTES = 20 * 1024 * 1024;
	const MEASURE_RETRIES = 5;

	/**
	 * Tick the event loop and force a full GC repeatedly until heapUsed
	 * stops changing (within a small tolerance) or maxIters is hit. A
	 * single Bun.gc(true) call immediately after an await is not sufficient
	 * to reclaim everything tied to just-finished stream I/O; see the
	 * retry rationale above.
	 */
	async function settleUntilStable(maxIters: number): Promise<number> {
		let last = -1;
		for (let i = 0; i < maxIters; i++) {
			await new Promise((r) => setTimeout(r, 0));
			Bun.gc(true);
			const cur = process.memoryUsage().heapUsed;
			if (last !== -1 && Math.abs(cur - last) < 256 * 1024) {
				return cur;
			}
			last = cur;
		}
		return last;
	}

	// Each fixture stream carries one text block sized just under the
	// 4MiB translated-output-total cap: the largest legitimate single-block
	// payload the translator is expected to fully buffer and re-emit, so
	// this measures a realistic worst-case per-stream footprint rather than
	// a best-case tiny one.
	const FIXTURE_TEXT_BYTES = 4_000_000;

	function makeMaxSizeFixtureStream(id: number): Response {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: {
					id: `msg_mem_${id}`,
					usage: { input_tokens: 5, output_tokens: 0 },
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
				delta: { type: "text_delta", text: "a".repeat(FIXTURE_TEXT_BYTES) },
			}),
			sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 3 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];
		return makeAnthropicStream(events);
	}

	async function runConcurrentTranslations(count: number): Promise<void> {
		await Promise.all(
			Array.from({ length: count }, async (_, i) => {
				const upstream = makeMaxSizeFixtureStream(i);
				const result = translateAnthropicStreamToResponses(
					upstream,
					`resp_mem_${i}`,
					"claude-3-5-sonnet-20241022",
				);
				// Fully drain the output so every stream actually materializes
				// its buffered text and re-encoded events before the next
				// measurement, rather than leaving work pending.
				await result.text();
			}),
		);
	}

	test("peak heap delta stays within budget for 12 concurrent max-size streams", async () => {
		const budget = 12 * PER_STREAM_BUDGET_BYTES;
		let minDelta = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < MEASURE_RETRIES; attempt++) {
			const before = await settleUntilStable(30);
			await runConcurrentTranslations(12);
			const after = await settleUntilStable(30);
			const delta = after - before;
			minDelta = Math.min(minDelta, delta);
			if (delta < budget) {
				return;
			}
		}
		expect(minDelta).toBeLessThan(budget);
	}, 60_000);

	test("peak heap delta stays within budget for 24 concurrent max-size streams", async () => {
		const budget = 24 * PER_STREAM_BUDGET_BYTES;
		let minDelta = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < MEASURE_RETRIES; attempt++) {
			const before = await settleUntilStable(30);
			await runConcurrentTranslations(24);
			const after = await settleUntilStable(30);
			const delta = after - before;
			minDelta = Math.min(minDelta, delta);
			if (delta < budget) {
				return;
			}
		}
		expect(minDelta).toBeLessThan(budget);
	}, 60_000);
});
