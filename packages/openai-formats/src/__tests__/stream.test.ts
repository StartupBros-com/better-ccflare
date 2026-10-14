import { describe, expect, it } from "bun:test";
import { sanitizeHeaders, transformStreamingResponse } from "../stream";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all bytes from a ReadableStream into a string.
 * Accepts a possibly-null body (as typed by the DOM lib on `Response.body`)
 * and throws a clear error if the stream under test didn't produce one.
 */
async function readStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) {
		throw new Error("expected response body, got null");
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

/**
 * Build a fake OpenAI SSE stream from an array of raw data payloads.
 * Each payload is wrapped in `data: <payload>\n\n`. The last element
 * of `chunks` can be "[DONE]" to send the stream terminator.
 */
function makeOpenAIStream(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const lines = chunks.map((c) => `data: ${c}\n\n`).join("");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(lines));
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function parseSSEEvents(raw: string): Array<{ event?: string; data?: string }> {
	const events: Array<{ event?: string; data?: string }> = [];
	const blocks = raw.split("\n\n").filter((b) => b.trim());
	for (const block of blocks) {
		const lines = block.split("\n");
		const ev: { event?: string; data?: string } = {};
		for (const line of lines) {
			if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
			if (line.startsWith("data: ")) ev.data = line.slice(6).trim();
		}
		events.push(ev);
	}
	return events;
}

/**
 * Parse the JSON `data` payload of a parsed SSE event. Throws a clear error
 * if the event has no data field, instead of relying on a non-null assertion
 * at each of the ~40 call sites in this file. Return type mirrors
 * `JSON.parse`'s own (implicit `any`) signature since call sites assert on
 * arbitrary, ad-hoc shapes of the decoded Anthropic SSE payload.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors JSON.parse's own return type; call sites assert on ad-hoc payload shapes
function parseEventData(event: { event?: string; data?: string }): any {
	if (event.data === undefined) {
		throw new Error(
			`expected SSE event to have a data field (event: ${event.event ?? "<none>"})`,
		);
	}
	return JSON.parse(event.data);
}

// ── sanitizeHeaders ──────────────────────────────────────────────────────────

describe("sanitizeHeaders", () => {
	it("removes x-ratelimit-* headers", () => {
		const h = new Headers({
			"x-ratelimit-limit-requests": "100",
			"content-type": "text/event-stream",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("x-ratelimit-limit-requests")).toBeNull();
		expect(result.get("content-type")).toBe("text/event-stream");
	});

	it("removes openai-* headers", () => {
		const h = new Headers({
			"openai-organization": "org-123",
			"content-type": "application/json",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("openai-organization")).toBeNull();
	});

	it("removes access-control-expose-headers", () => {
		const h = new Headers({
			"access-control-expose-headers": "x-ratelimit-limit-requests",
			"content-type": "application/json",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("access-control-expose-headers")).toBeNull();
	});

	it("preserves non-provider headers", () => {
		const h = new Headers({
			"content-type": "text/event-stream",
			"transfer-encoding": "chunked",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("transfer-encoding")).toBe("chunked");
	});

	it("defaults content-type to application/json when absent", () => {
		const result = sanitizeHeaders(new Headers());
		expect(result.get("content-type")).toBe("application/json");
	});
});

// ── transformStreamingResponse — passthrough when no body ────────────────────

describe("transformStreamingResponse — no body", () => {
	it("returns the response as-is when body is null", () => {
		const response = new Response(null, { status: 200 });
		const result = transformStreamingResponse(response);
		expect(result).toBe(response);
	});
});

// ── transformStreamingResponse — text stream ──────────────────────────────────

describe("transformStreamingResponse — text responses", () => {
	it("emits message_start + ping on the first chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("message_start");
		expect(types).toContain("ping");
	});

	it("emits content_block_start before first text delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("content_block_start");
	});

	it("emits content_block_delta with text_delta for each text chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: " world" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const deltas = events.filter((e) => e.event === "content_block_delta");
		expect(deltas.length).toBeGreaterThanOrEqual(2);
		const texts = deltas.map((e) => parseEventData(e).delta.text);
		expect(texts).toContain("Hello");
		expect(texts).toContain(" world");
	});

	it("emits message_delta with stop_reason end_turn on [DONE]", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Done" }, finish_reason: "stop" },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);
		expect(parsed.delta.stop_reason).toBe("end_turn");
	});

	it("emits message_stop after message_delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		const msgDeltaIdx = types.lastIndexOf("message_delta");
		const msgStopIdx = types.indexOf("message_stop");
		expect(msgStopIdx).toBeGreaterThan(msgDeltaIdx);
	});

	it("forwards usage tokens from the upstream stream", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);
		expect(parsed.usage.input_tokens).toBe(20);
		expect(parsed.usage.output_tokens).toBe(5);
	});

	it("forwards xAI cached tokens from prompt token details", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 12 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).usage).toEqual({
			input_tokens: 8,
			output_tokens: 5,
			cache_read_input_tokens: 12,
		});
	});

	it("normalizes cache reads and writes out of inclusive prompt tokens", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "qwen-plus",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: {
						cached_tokens: 12,
						cache_creation_input_tokens: 3,
					},
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).usage).toEqual({
			input_tokens: 5,
			output_tokens: 5,
			cache_read_input_tokens: 12,
			cache_creation_input_tokens: 3,
		});
	});

	it("preserves an explicit zero cached-token count", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).usage).toHaveProperty(
			"cache_read_input_tokens",
			0,
		);
		expect(parseEventData(msgDelta).usage.input_tokens).toBe(20);
	});

	it("omits cache usage when upstream cache details are absent", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).usage).not.toHaveProperty(
			"cache_read_input_tokens",
		);
	});

	it("advertises the official 500k Grok 4.6 window on message_delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 12 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			contextWindowForModel: (model) =>
				model === "grok-4.6" ? 500_000 : undefined,
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).context_window).toEqual({
			current_usage: {
				input_tokens: 8,
				cache_read_input_tokens: 12,
				cache_creation_input_tokens: 0,
			},
			context_window_size: 500_000,
		});
	});

	it("does not infer context capacity from an upstream model name", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(parseEventData(msgDelta)).not.toHaveProperty("context_window");
	});

	it("omits context capacity when current prompt usage is unavailable", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			contextWindowForModel: () => 500_000,
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(parseEventData(msgDelta)).not.toHaveProperty("context_window");
	});

	it.each([
		{ label: "missing", promptTokens: undefined },
		{ label: "invalid", promptTokens: -1 },
	])("keeps positive cache details unknown when prompt tokens are $label", async ({
		promptTokens,
	}) => {
		const usage: Record<string, unknown> = {
			completion_tokens: 5,
			prompt_tokens_details: {
				cached_tokens: 12,
				cache_creation_input_tokens: 3,
			},
		};
		if (promptTokens !== undefined) usage.prompt_tokens = promptTokens;
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "qwen-plus",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage,
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((event) => event.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");

		expect(parseEventData(msgDelta).usage).toEqual({
			input_tokens: 0,
			output_tokens: 5,
		});
	});

	it("includes content_block_stop for text block", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("content_block_stop");
	});

	it("surfaces an upstream SSE error object without fabricating success", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				error: {
					type: "permission_error",
					code: "login_required",
					message: "Sign-in is required",
				},
			}),
			"[DONE]",
		]);

		const transformed = transformStreamingResponse(upstream);
		const events = parseSSEEvents(await readStream(transformed.body));
		const errorEvent = events.find((event) => event.event === "error");

		expect(errorEvent).toBeDefined();
		if (!errorEvent) throw new Error("expected an Anthropic error event");
		expect(parseEventData(errorEvent)).toEqual({
			type: "error",
			error: {
				type: "permission_error",
				code: "login_required",
				message: "Sign-in is required",
			},
		});
		expect(events.some((event) => event.event === "message_start")).toBe(true);
		expect(events.some((event) => event.event === "message_delta")).toBe(false);
		expect(events.some((event) => event.event === "message_stop")).toBe(false);
	});

	it("closes committed content before a streaming provider error", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				model: "grok-4",
				choices: [{ delta: { content: "partial" }, finish_reason: null }],
			}),
			JSON.stringify({
				error: {
					type: "permission_error",
					code: "usage_not_included",
					message: "Plan does not include usage",
				},
			}),
			"[DONE]",
		]);

		const transformed = transformStreamingResponse(upstream);
		const events = parseSSEEvents(await readStream(transformed.body));
		const types = events.map((event) => event.event);
		const errorIndex = types.indexOf("error");
		const stopIndex = types.indexOf("content_block_stop");

		expect(stopIndex).toBeGreaterThan(-1);
		expect(stopIndex).toBeLessThan(errorIndex);
		expect(types.filter((type) => type === "error")).toHaveLength(1);
		expect(types).not.toContain("message_stop");
	});

	it("bounds unsafe streaming provider error fields", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				error: {
					type: "permission error with spaces",
					code: "bad code\nwith controls",
					message: "x".repeat(2_000),
				},
			}),
		]);

		const transformed = transformStreamingResponse(upstream);
		const events = parseSSEEvents(await readStream(transformed.body));
		const errorEvent = events.find((event) => event.event === "error");

		expect(errorEvent).toBeDefined();
		if (!errorEvent) throw new Error("expected an Anthropic error event");
		const payload = parseEventData(errorEvent);
		expect(payload.error.type).toBe("api_error");
		expect(payload.error.code).toBeUndefined();
		expect(payload.error.message).toHaveLength(1_024);
	});
});

// ── transformStreamingResponse — tool call stream ────────────────────────────

describe("transformStreamingResponse — tool calls", () => {
	it("emits content_block_start with tool_use type on first tool call chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "search", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"q":"bun"}' } },
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const blockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(blockStart).toBeDefined();
		if (!blockStart) throw new Error("expected block_start event");
		const blockStartData = JSON.parse(blockStart.data);
		expect(blockStartData.content_block.name).toBe("search");
		expect(blockStartData.content_block.id).toBe("call_abc");
	});

	it("buffers all argument chunks and emits a single input_json_delta at [DONE]", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "search", arguments: '{"q"' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: ':"bun"}' } }],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const deltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		// Should be exactly one buffered emission
		expect(deltas).toHaveLength(1);
		const delta0 = deltas[0];
		expect(delta0).toBeDefined();
		if (!delta0) throw new Error("expected input_json_delta event");
		expect(JSON.parse(delta0.data).delta.partial_json).toBe('{"q":"bun"}');
	});

	it("emits message_delta with stop_reason tool_use for tool calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "fn", arguments: "{}" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(JSON.parse(msgDelta.data).delta.stop_reason).toBe("tool_use");
	});

	it("handles multiple parallel tool calls (indexes 0 and 1)", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_a",
									type: "function",
									function: { name: "search", arguments: '{"q":"a"}' },
								},
								{
									index: 1,
									id: "call_b",
									type: "function",
									function: { name: "lookup", arguments: '{"id":"1"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStarts).toHaveLength(2);
	});

	it("drops tool call chunks with invalid index (too large)", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 999,
									id: "call_overflow",
									type: "function",
									function: { name: "overflow", arguments: "{}" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		// Should not throw; stream terminates cleanly
		expect(raw).toBeDefined();
	});
});

// ── transformStreamingResponse — flush (stream truncated without [DONE]) ─────

describe("transformStreamingResponse — flush path (no [DONE])", () => {
	it("emits stop events when stream ends without [DONE] for text content", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Send a text chunk but no [DONE]
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "c1",
							model: "gpt-4",
							choices: [
								{ index: 0, delta: { content: "Hello" }, finish_reason: null },
							],
						})}\n\n`,
					),
				);
				controller.close(); // close without [DONE]
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		// Should emit message_stop and message_delta even without [DONE]
		expect(types).toContain("message_delta");
		expect(types).toContain("message_stop");
	});

	it("emits buffered tool call JSON on flush without [DONE]", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "c1",
							model: "gpt-4",
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_flush",
												type: "function",
												function: { name: "fn", arguments: '{"x":1}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						})}\n\n`,
					),
				);
				controller.close(); // truncated stream
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
	});
});

// ── transformStreamingResponse — thinking/reasoning blocks ───────────────────

describe("transformStreamingResponse — reasoning_content (thinking blocks)", () => {
	it("emits content_block_start with type thinking before first reasoning_content chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Let me think..." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();
		if (!thinkingStart) throw new Error("expected thinking block_start event");
		expect(JSON.parse(thinkingStart.data).index).toBe(0);
	});

	it("emits content_block_delta with type thinking_delta for reasoning_content chunks", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "First thought." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: " Second thought." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "thinking_delta",
		);
		expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
		const thoughts = thinkingDeltas.map(
			(e) => parseEventData(e).delta.thinking,
		);
		expect(thoughts).toContain("First thought.");
		expect(thoughts).toContain(" Second thought.");
	});

	it("emits content_block_start for thinking only once across multiple chunks", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { reasoning_content: "A" }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { reasoning_content: "B" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStarts).toHaveLength(1);
	});

	it("closes thinking block (content_block_stop at index 0) before opening text block when text follows", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Thinking..." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Answer." }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);

		// content_block_stop at index 0 must appear before content_block_start for text
		const stops = events
			.map((e, i) => ({ e, i }))
			.filter(
				({ e }) =>
					e.event === "content_block_stop" && parseEventData(e).index === 0,
			);
		const textStart = events
			.map((e, i) => ({ e, i }))
			.find(
				({ e }) =>
					e.event === "content_block_start" &&
					parseEventData(e).content_block?.type === "text",
			);
		expect(stops).toHaveLength(1);
		expect(textStart).toBeDefined();
		expect(stops[0]?.i).toBeLessThan(textStart?.i);

		// text block must be at index 1
		expect(JSON.parse(textStart?.e.data).index).toBe(1);
		expect(types).toContain("message_start");
	});

	it("emits text block at index 1 when thinking preceded it", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Reply." }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const textBlockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textBlockStart).toBeDefined();
		if (!textBlockStart) throw new Error("expected text block_start event");
		expect(JSON.parse(textBlockStart.data).index).toBe(1);

		// text_delta should also be at index 1
		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThanOrEqual(1);
		const textDelta0 = textDeltas[0];
		expect(textDelta0).toBeDefined();
		if (!textDelta0) throw new Error("expected text_delta event");
		expect(JSON.parse(textDelta0.data).index).toBe(1);
	});

	it("emits content_block_stop at index 1 on stream end when thinking+text both present", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Answer." }, finish_reason: "stop" },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		// Exactly 2 content_block_stop events: thinking (index 0) and text (index 1)
		const allStops = events.filter((e) => e.event === "content_block_stop");
		expect(allStops).toHaveLength(2);
		expect(allStops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});

	it("handles reasoning_content only (no text) — thinking block without text block", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Pure thought." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		// Thinking block start was emitted
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();

		// No text block start emitted
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textStart).toBeUndefined();

		// Thinking block must be closed exactly once and message terminated
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(1);
		const stop0 = stops[0];
		expect(stop0).toBeDefined();
		if (!stop0) throw new Error("expected content_block_stop event");
		expect(JSON.parse(stop0.data).index).toBe(0);
		const types = events.map((e) => e.event);
		expect(types).toContain("message_stop");
	});

	it("closes thinking block before first tool_use block when reasoning_content precedes tool_calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Thinking..." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tc1",
									type: "function",
									function: { name: "search", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"q":"hi"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		const thinkingStop = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const toolStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(thinkingStart).toBeGreaterThanOrEqual(0);
		expect(thinkingStop).toBeGreaterThanOrEqual(0);
		expect(toolStart).toBeGreaterThanOrEqual(0);
		// thinking must be closed before tool opens
		expect(thinkingStop).toBeLessThan(toolStart);
		// tool block gets index 1 (thinking consumed 0)
		const toolStartEvent = events[toolStart];
		expect(toolStartEvent).toBeDefined();
		if (!toolStartEvent)
			throw new Error("expected tool_use block_start event at index");
		expect(JSON.parse(toolStartEvent.data).index).toBe(1);
	});

	it("closes text block before first tool_use block when text precedes tool_calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: { content: "Let me check." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tc1",
									type: "function",
									function: { name: "search", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const toolStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(toolStartIdx).toBeGreaterThanOrEqual(0);
		// text block (idx=0) must be closed before tool block opens
		expect(textStopIdx).toBeLessThan(toolStartIdx);
		// tool block gets index 1
		const toolStartEvent2 = events[toolStartIdx];
		expect(toolStartEvent2).toBeDefined();
		if (!toolStartEvent2)
			throw new Error("expected tool_use block_start event at index");
		expect(JSON.parse(toolStartEvent2.data).index).toBe(1);
	});

	it("closes text block before thinking block when content precedes reasoning_content", async () => {
		// text chunk → reasoning_content chunk → [DONE]
		// Text block (index 0) must be closed before thinking block (index 1) opens.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Intro." }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Now thinking." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		// text block (index 0) closed before thinking block opens
		expect(textStopIdx).toBeLessThan(thinkingStartIdx);
		// thinking block gets index 1
		const thinkingStartEvent = events[thinkingStartIdx];
		expect(thinkingStartEvent).toBeDefined();
		if (!thinkingStartEvent)
			throw new Error("expected thinking block_start event at index");
		expect(JSON.parse(thinkingStartEvent.data).index).toBe(1);
		// exactly 2 content_block_stop events: one for text (index 0), one for thinking (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});

	it("handles same-delta reasoning_content + content: emits thinking block then text block", async () => {
		// Single delta chunk carries both reasoning_content and content.
		// Thinking block (index 0) must come before text block (index 1).
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think.", content: "Answer." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);

		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		// thinking block (index 0) before text block (index 1)
		expect(thinkingStartIdx).toBeLessThan(textStartIdx);
		const thinkingStartEv = events[thinkingStartIdx];
		expect(thinkingStartEv).toBeDefined();
		if (!thinkingStartEv)
			throw new Error("expected thinking block_start event at index");
		const textStartEv = events[textStartIdx];
		expect(textStartEv).toBeDefined();
		if (!textStartEv)
			throw new Error("expected text block_start event at index");
		expect(JSON.parse(thinkingStartEv.data).index).toBe(0);
		expect(JSON.parse(textStartEv.data).index).toBe(1);

		// thinking block closed before text block opens
		const thinkingStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStopIdx).toBeLessThan(textStartIdx);
		// exactly 2 content_block_stop events: one for thinking (index 0), one for text (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});
});

// ── transformStreamingResponse — model extraction ────────────────────────────

describe("transformStreamingResponse — model extraction", () => {
	it("extracts model from first chunk and includes it in message_start", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "claude-sonnet-4-5",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgStart = events.find((e) => e.event === "message_start");
		expect(msgStart).toBeDefined();
		if (!msgStart) throw new Error("expected message_start event");
		const parsed = JSON.parse(msgStart.data);
		expect(parsed.message.model).toBe("claude-sonnet-4-5");
	});
});

// ── transformStreamingResponse — response metadata ───────────────────────────

describe("transformStreamingResponse — response metadata", () => {
	it("preserves the upstream status code", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		expect(transformed.status).toBe(200);
	});
});

// ── transformStreamingResponse — block index collision ───────────────────────

describe("transformStreamingResponse — block index assignment", () => {
	it("text-only: text block gets index 0", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textStart).toBeDefined();
		if (!textStart) throw new Error("expected text block_start event");
		expect(JSON.parse(textStart.data).index).toBe(0);

		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "text_delta",
		);
		for (const d of textDeltas) {
			expect(parseEventData(d).index).toBe(0);
		}
	});

	it("tool-only: first tool call (OpenAI index 0) gets Anthropic block index 0", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "search", arguments: '{"q":"test"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStart).toBeDefined();
		if (!toolStart) throw new Error("expected tool_use block_start event");
		expect(JSON.parse(toolStart.data).index).toBe(0);
	});

	it("text then tool: text gets index 0, tool gets index 1 — no collision", async () => {
		// OpenAI sends text content first, then tool_calls[0] — both naively map to index 0.
		// The fix ensures the tool call is assigned the next monotonic block index (1).
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "thinking..." }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_xyz",
									type: "function",
									function: { name: "lookup", arguments: '{"id":1}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(textStart).toBeDefined();
		expect(toolStart).toBeDefined();
		if (!textStart) throw new Error("expected text block_start event");
		if (!toolStart) throw new Error("expected tool_use block_start event");

		const textIdx = JSON.parse(textStart.data).index;
		const toolIdx = JSON.parse(toolStart.data).index;

		// Indices must be distinct — no collision
		expect(textIdx).not.toBe(toolIdx);
		// Text block came first: index 0; tool block came second: index 1
		expect(textIdx).toBe(0);
		expect(toolIdx).toBe(1);

		// The input_json_delta must carry the same Anthropic index as the tool block_start
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
		if (!jsonDelta) throw new Error("expected input_json_delta event");
		expect(JSON.parse(jsonDelta.data).index).toBe(toolIdx);

		// The content_block_stop for the tool must match too
		const stops = events.filter((e) => e.event === "content_block_stop");
		const stopIndices = stops.map((e) => parseEventData(e).index);
		expect(stopIndices).toContain(toolIdx);
	});

	it("multiple tool calls: each gets a distinct monotonic Anthropic block index", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_a",
									type: "function",
									function: { name: "search", arguments: '{"q":"a"}' },
								},
								{
									index: 1,
									id: "call_b",
									type: "function",
									function: { name: "lookup", arguments: '{"id":"1"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStarts).toHaveLength(2);

		const indices = toolStarts.map((e) => parseEventData(e).index);
		// All indices must be unique
		expect(new Set(indices).size).toBe(2);
		// Must be 0 and 1 (monotonically assigned)
		expect(indices.sort()).toEqual([0, 1]);
	});
});

// ── U5 canary contract: AE3 streamed xhigh reasoning + tool turn ───────────
//
// ALL fixtures in this describe block are CONSTRUCTED from the provider's
// documented streaming shape, not captured from live traffic. The success
// shape (reasoning_content + tool_calls + usage + [DONE]) mirrors what a
// Vercel AI Gateway compatible stream would emit for a GLM model serving a
// Claude Code turn with xhigh reasoning intent and a function tool. No live
// capture was available (KTD7), so this fixture is explicitly labelled as
// constructed rather than observed.

describe("U5 canary: AE3 streamed xhigh reasoning + function tool turn (constructed fixture)", () => {
	/**
	 * CONSTRUCTED fixture: a complete OpenAI SSE stream representing a Claude
	 * Code turn with xhigh reasoning intent. The stream carries:
	 *   1. reasoning_content (thinking) — the xhigh reasoning intent
	 *   2. a tool_call (function round trip)
	 *   3. terminal usage (prompt_tokens, completion_tokens)
	 *   4. anormal termination)
	 *
	 * Built from the documented OpenAI-compatible streaming shape, not from a
	 * live capture. Credentials, trace IDs, team IDs, and billed amounts are
	 * absent by construction.
	 */
	function makeXhighToolTurnStream(): Response {
		return makeOpenAIStream([
			// 1. Reasoning content (xhigh thinking)
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Analyzing the request " },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "before tool use." },
						finish_reason: null,
					},
				],
			}),
			// 2. Function tool call (start)
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_canary_constructed",
									type: "function",
									function: { name: "read_file", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			// 3. Function tool call (argument fragments)
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"path":"src' } },
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '/index.ts"}' } },
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			// 4. Terminal usage
			JSON.stringify({
				id: "chatcmpl-canary-constructed",
				object: "chat.completion.chunk",
				model: "zai/glm-5.2-fast",
				choices: [],
				usage: { prompt_tokens: 42, completion_tokens: 13 },
			}),
			// 5. Normal termination
			"[DONE]",
		]);
	}

	it("emits thinking blocks from reasoning_content (xhigh reasoning intent)", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStarts).toHaveLength(1);
		expect(parseEventData(thinkingStarts[0]).index).toBe(0);

		const thinkingDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "thinking_delta",
		);
		expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
		const thoughts = thinkingDeltas.map(
			(e) => parseEventData(e).delta.thinking,
		);
		expect(thoughts).toContain("Analyzing the request ");
		expect(thoughts).toContain("before tool use.");
	});

	it("emits a tool_use block with the function round trip", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStart).toBeDefined();
		if (!toolStart) throw new Error("expected tool_use block_start event");
		const toolStartData = parseEventData(toolStart);
		expect(toolStartData.content_block.name).toBe("read_file");
		expect(toolStartData.content_block.id).toBe("call_canary_constructed");
		// Tool block follows thinking at index 1
		expect(toolStartData.index).toBe(1);

		// Buffered input_json_delta emitted with complete arguments
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
		if (!jsonDelta) throw new Error("expected input_json_delta event");
		expect(parseEventData(jsonDelta).delta.partial_json).toBe(
			'{"path":"src/index.ts"}',
		);
	});

	it("emits terminal usage from the upstream usage chunk", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const usage = parseEventData(msgDelta).usage;
		expect(usage.input_tokens).toBe(42);
		expect(usage.output_tokens).toBe(13);
	});

	it("terminates normally with tool_use stop_reason and message_stop as the final event", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);

		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(parseEventData(msgDelta).delta.stop_reason).toBe("tool_use");

		// message_stop must be the final event
		expect(types).toContain("message_stop");
		const msgStopIdx = types.lastIndexOf("message_stop");
		expect(msgStopIdx).toBe(types.length - 1);
	});

	it("closes the thinking block before opening the tool_use block", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const toolStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
		expect(toolStartIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStopIdx).toBeLessThan(toolStartIdx);
	});

	it("emits content_block_stop for every block (thinking + tool_use)", async () => {
		const upstream = makeXhighToolTurnStream();
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const stops = events.filter((e) => e.event === "content_block_stop");
		// Exactly 2: thinking (index 0) + tool_use (index 1)
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});
});

// ── transformStreamingResponse — block lifecycle across kind switches ────────

/**
 * Check the content-block lifecycle of an Anthropic stream: blocks start at
 * contiguous indices in order, each block completes before the next one
 * starts, every delta targets a started, not-yet-stopped block of the
 * matching kind, blocks stop in index order, and every started block is
 * stopped exactly once before the terminal event. Claude Code assembles one
 * assistant message per block as it stops, so out-of-order stops reorder the
 * reply even where a client tolerates the overlap.
 *
 * One overlap is allowed: tool_use blocks over tool_use blocks. The translator
 * opens each parallel tool call on its first chunk and closes them together at
 * stream end (pre-existing design, tracked in #498); their stops still arrive
 * in index order.
 */
function blockLifecycleViolations(
	events: Array<{ event?: string; data?: string }>,
): string[] {
	const violations: string[] = [];
	const kinds = new Map<number, string>();
	const stopped = new Set<number>();
	const deltaKind: Record<string, string> = {
		thinking_delta: "thinking",
		text_delta: "text",
		input_json_delta: "tool_use",
	};
	const openBlocks = () =>
		[...kinds.keys()].filter((index) => !stopped.has(index));
	let terminal: string | undefined;
	for (const ev of events) {
		if (terminal) {
			violations.push(`${ev.event} after ${terminal}`);
			continue;
		}
		if (ev.event === "message_stop" || ev.event === "error") {
			terminal = ev.event;
			for (const index of kinds.keys()) {
				if (!stopped.has(index))
					violations.push(`block ${index} never stopped`);
			}
			continue;
		}
		if (
			ev.event !== "content_block_start" &&
			ev.event !== "content_block_delta" &&
			ev.event !== "content_block_stop"
		) {
			continue;
		}
		const data = parseEventData(ev);
		const index: number = data.index;
		if (ev.event === "content_block_start") {
			if (index !== kinds.size) {
				violations.push(
					`block ${index} started out of order (expected ${kinds.size})`,
				);
			}
			const kind: string = data.content_block?.type;
			for (const open of openBlocks()) {
				if (kind === "tool_use" && kinds.get(open) === "tool_use") continue;
				violations.push(
					`${kind} block ${index} started while ${kinds.get(open)} block ${open} is still open`,
				);
			}
			kinds.set(index, kind);
		} else if (!kinds.has(index)) {
			violations.push(`${ev.event} for unstarted block ${index}`);
		} else if (stopped.has(index)) {
			violations.push(`${ev.event} for already-stopped block ${index}`);
		} else if (ev.event === "content_block_stop") {
			const lowestOpen = openBlocks()[0];
			if (index !== lowestOpen) {
				violations.push(
					`block ${index} stopped before open block ${lowestOpen}`,
				);
			}
			stopped.add(index);
		} else if (deltaKind[data.delta?.type] !== kinds.get(index)) {
			violations.push(
				`${data.delta?.type} on ${kinds.get(index)} block ${index}`,
			);
		}
	}
	if (!terminal) violations.push("stream ended without message_stop or error");
	return violations;
}

/** Blocks in start order, each with its concatenated delta payload. */
function collectBlocks(
	events: Array<{ event?: string; data?: string }>,
): Array<{ type: string; content: string }> {
	const blocks: Array<{ type: string; content: string }> = [];
	for (const ev of events) {
		if (ev.event === "content_block_start") {
			blocks[parseEventData(ev).index] = {
				type: parseEventData(ev).content_block?.type,
				content: "",
			};
		} else if (ev.event === "content_block_delta") {
			const data = parseEventData(ev);
			const block = blocks[data.index];
			if (block) {
				block.content +=
					data.delta?.thinking ??
					data.delta?.text ??
					data.delta?.partial_json ??
					"";
			}
		}
	}
	return blocks;
}

function glmChunk(delta: Record<string, unknown>): string {
	return JSON.stringify({
		id: "c1",
		model: "glm-5.3-flash",
		choices: [{ index: 0, delta, finish_reason: null }],
	});
}

async function transformChunks(chunks: string[]) {
	const transformed = transformStreamingResponse(makeOpenAIStream(chunks));
	return parseSSEEvents(await readStream(transformed.body));
}

/** Hand-built Anthropic SSE events, so the checker itself can be exercised. */
function sseEvents(
	payloads: Array<Record<string, unknown>>,
): Array<{ event?: string; data?: string }> {
	return payloads.map((payload) => ({
		event: String(payload.type),
		data: JSON.stringify(payload),
	}));
}

describe("blockLifecycleViolations (pro-gate round 2 P1 checker)", () => {
	const start = (index: number, type: string) => ({
		type: "content_block_start",
		index,
		content_block:
			type === "tool_use" ? { type, id: `t${index}`, name: "fn" } : { type },
	});
	const stop = (index: number) => ({ type: "content_block_stop", index });
	const done = { type: "message_stop" };

	it("rejects a thinking block that starts while a tool_use block is still open", () => {
		const events = sseEvents([
			start(0, "tool_use"),
			start(1, "thinking"),
			stop(1),
			stop(0),
			done,
		]);
		expect(blockLifecycleViolations(events)).toEqual([
			"thinking block 1 started while tool_use block 0 is still open",
			"block 1 stopped before open block 0",
		]);
	});

	it("rejects stops that arrive out of block order", () => {
		const events = sseEvents([
			start(0, "tool_use"),
			start(1, "tool_use"),
			stop(1),
			stop(0),
			done,
		]);
		expect(blockLifecycleViolations(events)).toEqual([
			"block 1 stopped before open block 0",
		]);
	});

	it("allows parallel tool_use blocks that stop in index order", () => {
		const events = sseEvents([
			start(0, "tool_use"),
			start(1, "tool_use"),
			stop(0),
			stop(1),
			done,
		]);
		expect(blockLifecycleViolations(events)).toEqual([]);
	});

	it("rejects a text block that starts while a thinking block is still open", () => {
		const events = sseEvents([
			start(0, "thinking"),
			start(1, "text"),
			stop(0),
			stop(1),
			done,
		]);
		expect(blockLifecycleViolations(events)).toEqual([
			"text block 1 started while thinking block 0 is still open",
		]);
	});
});

describe("transformStreamingResponse — block lifecycle across kind switches", () => {
	it("opens a fresh text block for the answer after leading content then reasoning", async () => {
		// A reasoning model can emit a stray newline of content before its
		// reasoning. The answer that follows must not reuse the text block that
		// the reasoning closed.
		const events = await transformChunks([
			glmChunk({ content: "\n" }),
			glmChunk({ reasoning_content: "Let me think." }),
			glmChunk({ reasoning_content: " More." }),
			glmChunk({ content: "Answer." }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "text", content: "\n" },
			{ type: "thinking", content: "Let me think. More." },
			{ type: "text", content: "Answer." },
		]);
		const messageDelta = events.find((e) => e.event === "message_delta");
		expect(parseEventData(messageDelta ?? {}).delta.stop_reason).toBe(
			"end_turn",
		);
	});

	it("opens fresh blocks when reasoning and text alternate", async () => {
		const events = await transformChunks([
			glmChunk({ reasoning_content: "First thought." }),
			glmChunk({ content: "Partial answer." }),
			glmChunk({ reasoning_content: "Second thought." }),
			glmChunk({ content: "Final answer." }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "thinking", content: "First thought." },
			{ type: "text", content: "Partial answer." },
			{ type: "thinking", content: "Second thought." },
			{ type: "text", content: "Final answer." },
		]);
	});

	it("pro-gate round 2 P1: replays reasoning and text that arrive after a tool call started as sequential blocks once the tool block closes", async () => {
		// Tool arguments are buffered until stream end, so the tool block stays
		// open; post-tool reasoning/text must not open blocks over it. They are
		// deferred and replayed after the tool block stops, keeping the single
		// active block the Anthropic stream format defines.
		const events = await transformChunks([
			glmChunk({ reasoning_content: "Need a tool." }),
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":' },
					},
				],
			}),
			glmChunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
			glmChunk({ reasoning_content: "Thinking after" }),
			glmChunk({ reasoning_content: " the call." }),
			glmChunk({ content: "Calling it now." }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "thinking", content: "Need a tool." },
			{ type: "tool_use", content: '{"q":"x"}' },
			{ type: "thinking", content: "Thinking after the call." },
			{ type: "text", content: "Calling it now." },
		]);
		const types = events.map((e) => e.event);
		const toolStop = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 1,
		);
		const replayStart = events.findIndex(
			(e) => e.event === "content_block_start" && parseEventData(e).index === 2,
		);
		expect(toolStop).toBeGreaterThan(-1);
		expect(replayStart).toBeGreaterThan(toolStop);
		expect(types.indexOf("message_delta")).toBeGreaterThan(
			types.lastIndexOf("content_block_stop"),
		);
		const messageDelta = events.find((e) => e.event === "message_delta");
		expect(parseEventData(messageDelta ?? {}).delta.stop_reason).toBe(
			"tool_use",
		);
	});

	it("pro-gate round 2 P1: replays post-tool text after parallel tool blocks close, stops in index order", async () => {
		const events = await transformChunks([
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_a",
						type: "function",
						function: { name: "search", arguments: '{"q":"a"}' },
					},
					{
						index: 1,
						id: "call_b",
						type: "function",
						function: { name: "lookup", arguments: '{"id":"1"}' },
					},
				],
			}),
			glmChunk({ content: "Running both." }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "tool_use", content: '{"q":"a"}' },
			{ type: "tool_use", content: '{"id":"1"}' },
			{ type: "text", content: "Running both." },
		]);
		const stopOrder = events
			.filter((e) => e.event === "content_block_stop")
			.map((e) => parseEventData(e).index);
		expect(stopOrder).toEqual([0, 1, 2]);
	});

	it("pro-gate round 2 P1: stops tool blocks in Anthropic block order when OpenAI tool_call indices arrive out of order", async () => {
		// OpenAI index 1 arrives first and takes Anthropic block 0; index 0 then
		// takes block 1. Stops must follow block order, not OpenAI index order.
		const events = await transformChunks([
			glmChunk({
				tool_calls: [
					{
						index: 1,
						id: "call_b",
						type: "function",
						function: { name: "lookup", arguments: '{"id":"1"}' },
					},
				],
			}),
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_a",
						type: "function",
						function: { name: "search", arguments: '{"q":"a"}' },
					},
				],
			}),
			glmChunk({ content: "Done." }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "tool_use", content: '{"id":"1"}' },
			{ type: "tool_use", content: '{"q":"a"}' },
			{ type: "text", content: "Done." },
		]);
		const stopOrder = events
			.filter((e) => e.event === "content_block_stop")
			.map((e) => parseEventData(e).index);
		expect(stopOrder).toEqual([0, 1, 2]);
	});

	it("pro-gate round 2 P1: replays deferred post-tool text on the flush path when the stream ends without [DONE]", async () => {
		const events = await transformChunks([
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					},
				],
			}),
			glmChunk({ content: "Partial note." }),
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "tool_use", content: '{"q":"x"}' },
			{ type: "text", content: "Partial note." },
		]);
		expect(events.at(-1)?.event).toBe("message_stop");
	});

	it("pro-gate round 2 P1: closes the tool block and replays deferred text before a provider error", async () => {
		const events = await transformChunks([
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					},
				],
			}),
			glmChunk({ content: "Partial note." }),
			JSON.stringify({ error: { type: "api_error", message: "boom" } }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events).map((b) => b.type)).toEqual([
			"tool_use",
			"text",
		]);
		expect(events.at(-1)?.event).toBe("error");
		expect(events.some((e) => e.event === "message_stop")).toBe(false);
	});

	it("opens a fresh thinking block for reasoning flushed after content, before a complete tool call", async () => {
		// oMLX holds back a reasoning suffix while tools are present and flushes it
		// at stream end, after content has already streamed; its tool calls then
		// arrive last as complete chunks.
		const events = await transformChunks([
			glmChunk({ reasoning_content: "Plan the call" }),
			glmChunk({ content: "\n\n" }),
			glmChunk({ content: "Checking the seed." }),
			glmChunk({ reasoning_content: " <" }),
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "Bash", arguments: '{"command":"ls"}' },
					},
				],
			}),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "thinking", content: "Plan the call" },
			{ type: "text", content: "\n\nChecking the seed." },
			{ type: "thinking", content: " <" },
			{ type: "tool_use", content: '{"command":"ls"}' },
		]);
	});

	it("closes a reopened block on the flush path when the stream ends without [DONE]", async () => {
		const events = await transformChunks([
			glmChunk({ content: "\n" }),
			glmChunk({ reasoning_content: "Thinking." }),
			glmChunk({ content: "Answer." }),
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events).map((b) => b.type)).toEqual([
			"text",
			"thinking",
			"text",
		]);
		expect(events.at(-1)?.event).toBe("message_stop");
	});

	it("closes the open block before a provider error that follows a kind switch", async () => {
		const events = await transformChunks([
			glmChunk({ reasoning_content: "Thinking." }),
			glmChunk({ content: "Partial." }),
			glmChunk({ reasoning_content: "More thinking." }),
			JSON.stringify({ error: { type: "api_error", message: "boom" } }),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(events.at(-1)?.event).toBe("error");
		expect(events.some((e) => e.event === "message_stop")).toBe(false);
	});
});

describe("transformStreamingResponse — text sharing a delta with tool_calls", () => {
	it("emits the text of a delta that also starts a tool call, before the tool block", async () => {
		// One OpenAI delta can carry both content and tool_calls. The text must
		// not be dropped, and it goes first, matching the non-streaming
		// converter's thinking, text, tool_use order for the same message.
		const events = await transformChunks([
			glmChunk({
				content: "Calling",
				tool_calls: [
					{
						index: 0,
						id: "c",
						type: "function",
						function: { name: "f", arguments: "{}" },
					},
				],
			}),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "text", content: "Calling" },
			{ type: "tool_use", content: "{}" },
		]);
		const messageDelta = events.find((e) => e.event === "message_delta");
		expect(parseEventData(messageDelta ?? {}).delta.stop_reason).toBe(
			"tool_use",
		);
	});

	it("emits reasoning and text that share a delta with a tool start as thinking, text, tool_use", async () => {
		const events = await transformChunks([
			glmChunk({
				reasoning_content: "Need a lookup.",
				content: "Looking it up.",
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					},
				],
			}),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "thinking", content: "Need a lookup." },
			{ type: "text", content: "Looking it up." },
			{ type: "tool_use", content: '{"q":"x"}' },
		]);
	});

	it("defers text that shares a delta with a tool-argument continuation and replays it after the tool block", async () => {
		// Once a tool block is open, same-delta text takes the existing deferral
		// path instead of opening a block over it.
		const events = await transformChunks([
			glmChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":' },
					},
				],
			}),
			glmChunk({
				content: "Still calling.",
				tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
			}),
			"[DONE]",
		]);

		expect(blockLifecycleViolations(events)).toEqual([]);
		expect(collectBlocks(events)).toEqual([
			{ type: "tool_use", content: '{"q":"x"}' },
			{ type: "text", content: "Still calling." },
		]);
	});
});
