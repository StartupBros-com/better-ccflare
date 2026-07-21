import { describe, expect, it, mock } from "bun:test";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";

mock.module("@better-ccflare/core", () => ({
	estimateCostUSD: async () => 0,
}));
mock.module("@better-ccflare/database", () => ({
	DatabaseFactory: {
		getInstance: mock(() => ({
			getDatabase: mock(() => ({})),
		})),
	},
	ModelTranslationRepository: mock(() => ({
		findSimilar: mock(() => []),
	})),
}));

const { BedrockProvider } = await import("../provider");

async function* toAsyncIterable(
	events: ConverseStreamOutput[],
): AsyncIterable<ConverseStreamOutput> {
	for (const event of events) {
		yield event;
	}
}

async function collectSseEvents(
	stream: ReadableStream,
): Promise<Array<{ event: string; data: unknown }>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const events: Array<{ event: string; data: unknown }> = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}

	for (const chunk of buffer.split("\n\n")) {
		if (!chunk.trim()) continue;
		const eventMatch = chunk.match(/^event: (.+)$/m);
		const dataMatch = chunk.match(/^data: (.+)$/m);
		if (eventMatch && dataMatch) {
			events.push({
				event: eventMatch[1],
				data: JSON.parse(dataMatch[1]),
			});
		}
	}

	return events;
}

function createAnthropicStream(events: ConverseStreamOutput[]): ReadableStream {
	const provider = new BedrockProvider();
	return (
		provider as unknown as {
			createAnthropicCompatibleStream: (
				bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
				clientModelName: string,
			) => ReadableStream;
		}
	).createAnthropicCompatibleStream(
		toAsyncIterable(events),
		"claude-sonnet-4-5",
	);
}

function citationDeltas(events: Array<{ event: string; data: unknown }>) {
	return events.flatMap((event) => {
		const data = event.data as {
			delta?: { citation?: Record<string, unknown>; type?: string };
		};
		return event.event === "content_block_delta" &&
			data.delta?.type === "citations_delta" &&
			data.delta.citation
			? [data.delta.citation]
			: [];
	});
}

describe("BedrockProvider.createAnthropicCompatibleStream", () => {
	it("emits input_json_delta events from toolUse.input deltas", async () => {
		const provider = new BedrockProvider();

		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: '{"location":' } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: '"NYC"}' } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-3-5-sonnet",
		);

		const events = await collectSseEvents(stream);
		const deltaEvents = events.filter((e) => e.event === "content_block_delta");

		expect(deltaEvents).toHaveLength(2);
		expect(deltaEvents[0].data).toMatchObject({
			delta: { type: "input_json_delta", partial_json: '{"location":' },
		});
		expect(deltaEvents[1].data).toMatchObject({
			delta: { type: "input_json_delta", partial_json: '"NYC"}' },
		});
	});

	it("does not emit a delta event when toolUse.input is absent", async () => {
		const provider = new BedrockProvider();

		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: {} },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-3-5-sonnet",
		);

		const events = await collectSseEvents(stream);
		const deltaEvents = events.filter((e) => e.event === "content_block_delta");

		expect(deltaEvents).toHaveLength(0);
	});

	it("maps Bedrock reasoning text and signature deltas to Anthropic thinking events", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { reasoningContent: { text: "Reasoning" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { reasoningContent: { signature: "sig_opaque" } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);

		expect(
			events.filter((event) => event.event.startsWith("content_block")),
		).toEqual([
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "Reasoning" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "sig_opaque" },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
		]);
	});

	it("buffers Bedrock redacted reasoning into one Anthropic redacted-thinking block", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array([1, 2]),
						},
					},
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array([3, 4]),
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);

		expect(
			events.filter((event) => event.event.startsWith("content_block")),
		).toEqual([
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "redacted_thinking",
						data: "AQIDBA==",
					},
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
		]);
	});

	it("terminates with an API error when a redacted-reasoning block exceeds its byte cap", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array(1024 * 1024 + 1),
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);

		expect(events.filter((event) => event.event === "error")).toEqual([
			{
				event: "error",
				data: {
					type: "error",
					error: {
						type: "api_error",
						message: "Bedrock returned invalid redacted reasoning data.",
					},
				},
			},
		]);
		expect(events.some((event) => event.event === "message_stop")).toBe(false);
	});

	it("terminates malformed and mixed-kind redacted reasoning as protocol errors", async () => {
		const fixtures: Array<{
			name: string;
			events: ConverseStreamOutput[];
		}> = [
			{
				name: "malformed redacted payload",
				events: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								reasoningContent: {
									redactedContent: "not-bytes",
								} as never,
							},
						},
					},
				],
			},
			{
				name: "redacted then text",
				events: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								reasoningContent: {
									redactedContent: new Uint8Array([1]),
								},
							},
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { text: "mixed" },
						},
					},
				],
			},
			{
				name: "text then redacted",
				events: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { text: "mixed" },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								reasoningContent: {
									redactedContent: new Uint8Array([1]),
								},
							},
						},
					},
				],
			},
		];

		for (const fixture of fixtures) {
			const events = await collectSseEvents(
				createAnthropicStream([
					{ messageStart: { role: "assistant" } },
					...fixture.events,
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
				]),
			);
			expect(
				events.filter((event) => event.event === "error"),
				fixture.name,
			).toHaveLength(1);
			expect(
				events.some((event) => event.event === "message_stop"),
				fixture.name,
			).toBe(false);
		}
	});

	it("enforces redacted-reasoning chunk, active-block, and total-response caps", async () => {
		const chunkFlood: ConverseStreamOutput[] = Array.from(
			{ length: 257 },
			() => ({
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						reasoningContent: { redactedContent: new Uint8Array() },
					},
				},
			}),
		);
		const activeBlockFlood: ConverseStreamOutput[] = Array.from(
			{ length: 17 },
			(_, contentBlockIndex) => ({
				contentBlockDelta: {
					contentBlockIndex,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array([contentBlockIndex]),
						},
					},
				},
			}),
		);
		const totalResponseFlood: ConverseStreamOutput[] = [
			...Array.from({ length: 16 }, (_, contentBlockIndex) => ({
				contentBlockDelta: {
					contentBlockIndex,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array(256 * 1024),
						},
					},
				},
			})),
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{
				contentBlockDelta: {
					contentBlockIndex: 16,
					delta: {
						reasoningContent: {
							redactedContent: new Uint8Array([1]),
						},
					},
				},
			},
		];

		for (const fixture of [
			["chunk cap", chunkFlood],
			["active-block cap", activeBlockFlood],
			["total-response cap", totalResponseFlood],
		] as const) {
			const events = await collectSseEvents(
				createAnthropicStream([
					{ messageStart: { role: "assistant" } },
					...fixture[1],
					{ messageStop: { stopReason: "end_turn" } },
				]),
			);
			expect(
				events.filter((event) => event.event === "error"),
				fixture[0],
			).toHaveLength(1);
			expect(
				events.some((event) => event.event === "message_stop"),
				fixture[0],
			).toBe(false);
		}
	});

	it("releases redacted-reasoning state on block stop and protocol abort", async () => {
		const sequentialBlocks: ConverseStreamOutput[] = [];
		for (
			let contentBlockIndex = 0;
			contentBlockIndex < 17;
			contentBlockIndex++
		) {
			sequentialBlocks.push(
				{
					contentBlockDelta: {
						contentBlockIndex,
						delta: {
							reasoningContent: {
								redactedContent: new Uint8Array([contentBlockIndex]),
							},
						},
					},
				},
				{ contentBlockStop: { contentBlockIndex } },
			);
		}

		const sequentialEvents = await collectSseEvents(
			createAnthropicStream([
				{ messageStart: { role: "assistant" } },
				...sequentialBlocks,
				{ messageStop: { stopReason: "end_turn" } },
			]),
		);
		expect(sequentialEvents.some((event) => event.event === "error")).toBe(
			false,
		);
		expect(
			sequentialEvents.some((event) => event.event === "message_stop"),
		).toBe(true);

		let upstreamFinalized = false;
		async function* overflowingStream(): AsyncIterable<ConverseStreamOutput> {
			try {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: {
							reasoningContent: {
								redactedContent: new Uint8Array(1024 * 1024 + 1),
							},
						},
					},
				};
				yield { messageStop: { stopReason: "end_turn" } };
			} finally {
				upstreamFinalized = true;
			}
		}

		const provider = new BedrockProvider();
		const abortedEvents = await collectSseEvents(
			(
				provider as unknown as {
					createAnthropicCompatibleStream: (
						bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
						clientModelName: string,
					) => ReadableStream;
				}
			).createAnthropicCompatibleStream(
				overflowingStream(),
				"claude-sonnet-4-5",
			),
		);
		expect(upstreamFinalized).toBe(true);
		expect(
			abortedEvents.filter((event) => event.event === "error"),
		).toHaveLength(1);
		expect(abortedEvents.some((event) => event.event === "message_stop")).toBe(
			false,
		);
	});

	it("preserves visible text but omits citation metadata split across events", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { text: "Grounded answer" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							title: "Example document",
							source: "document-2",
							sourceContent: [{ text: "Grounded " }],
						},
					},
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							location: {
								documentChar: {
									documentIndex: 2,
									start: 4,
									end: 20,
								},
							},
						},
					},
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							sourceContent: [{ text: "excerpt" }],
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);
		const citationEvent = events.find(
			(event) =>
				event.event === "content_block_delta" &&
				(event.data as { delta?: { type?: string } }).delta?.type ===
					"citations_delta",
		);

		expect(citationEvent).toBeUndefined();
		expect(
			events.some(
				(event) =>
					event.event === "content_block_delta" &&
					(event.data as { delta?: { text?: string } }).delta?.text ===
						"Grounded answer",
			),
		).toBe(true);
	});

	it("keeps independently self-contained citations separate when title and source are identical", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { text: "Two grounded claims" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							title: "Same document",
							source: "document-1",
							sourceContent: [{ text: "First excerpt" }],
							location: {
								documentChar: { documentIndex: 1, start: 0, end: 13 },
							},
						},
					},
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							title: "Same document",
							source: "document-1",
							sourceContent: [{ text: "Second excerpt" }],
							location: {
								documentChar: { documentIndex: 1, start: 20, end: 34 },
							},
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);
		const citations = citationDeltas(events);

		expect(citations).toEqual([
			{
				type: "char_location",
				cited_text: "First excerpt",
				document_index: 1,
				document_title: "Same document",
				file_id: null,
				start_char_index: 0,
				end_char_index: 13,
			},
			{
				type: "char_location",
				cited_text: "Second excerpt",
				document_index: 1,
				document_title: "Same document",
				file_id: null,
				start_char_index: 20,
				end_char_index: 34,
			},
		]);
	});

	it("omits ambiguous citation orderings without suppressing visible text", async () => {
		const location = {
			documentChar: { documentIndex: 0, start: 0, end: 7 },
		};
		const completeCitation = {
			title: "Same document",
			source: "document-1",
			sourceContent: [{ text: "Excerpt" }],
			location,
		};
		const fixtures: Array<{
			name: string;
			citationEvents: ConverseStreamOutput[];
		}> = [
			{
				name: "late title after source and location",
				citationEvents: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								citation: {
									sourceContent: [{ text: "Excerpt" }],
									location,
								},
							},
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: { title: "Same document" } },
						},
					},
				],
			},
			{
				name: "next citation starts source-content-only",
				citationEvents: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: completeCitation },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								citation: { sourceContent: [{ text: "Second" }] },
							},
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: { location } },
						},
					},
				],
			},
			{
				name: "location first",
				citationEvents: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: { location } },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								citation: {
									title: "Same document",
									sourceContent: [{ text: "Excerpt" }],
								},
							},
						},
					},
				],
			},
			{
				name: "duplicate location",
				citationEvents: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: completeCitation },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								citation: {
									...completeCitation,
									sourceContent: [{ text: "Updated excerpt" }],
								},
							},
						},
					},
				],
			},
			{
				name: "repeated metadata",
				citationEvents: [
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { citation: completeCitation },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: {
								citation: {
									title: "Same document",
									source: "document-1",
								},
							},
						},
					},
				],
			},
		];

		for (const fixture of fixtures) {
			const events = await collectSseEvents(
				createAnthropicStream([
					{ messageStart: { role: "assistant" } },
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { text: `Visible: ${fixture.name}` },
						},
					},
					...fixture.citationEvents,
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
				]),
			);
			expect(citationDeltas(events), fixture.name).toEqual([]);
			expect(
				events.some(
					(event) =>
						event.event === "content_block_delta" &&
						(event.data as { delta?: { text?: string } }).delta?.text ===
							`Visible: ${fixture.name}`,
				),
				fixture.name,
			).toBe(true);
		}
	});

	it("keeps each streaming block on its declared Anthropic delta kind", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { text: "must not leak into a tool block" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: "{}" } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{
				contentBlockDelta: {
					contentBlockIndex: 1,
					delta: { reasoningContent: { text: "think" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 1,
					delta: { text: "must not leak into thinking" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 1,
					delta: { reasoningContent: { signature: "signed" } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 1 } },
			{
				contentBlockDelta: {
					contentBlockIndex: 2,
					delta: { text: "visible text" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 2,
					delta: { toolUse: { input: '{"bad":true}' } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 2,
					delta: { reasoningContent: { text: "also hidden" } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 2 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);
		const deltas = events
			.filter((event) => event.event === "content_block_delta")
			.map((event) => (event.data as { delta: { type: string } }).delta.type);

		expect(deltas).toEqual([
			"input_json_delta",
			"thinking_delta",
			"signature_delta",
			"text_delta",
		]);
	});

	it("bounds oversized streaming citation accumulation without emitting partial metadata", async () => {
		const provider = new BedrockProvider();
		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { text: "Grounded answer" },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							sourceContent: [{ text: "x".repeat(64 * 1024 + 1) }],
						},
					},
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						citation: {
							sourceContent: [{ text: "must remain suppressed" }],
							location: {
								documentChar: { documentIndex: 0, start: 0, end: 1 },
							},
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-sonnet-4-5",
		);
		const events = await collectSseEvents(stream);

		expect(
			events.some(
				(event) =>
					event.event === "content_block_delta" &&
					(event.data as { delta?: { type?: string } }).delta?.type ===
						"citations_delta",
			),
		).toBe(false);
	});
});
