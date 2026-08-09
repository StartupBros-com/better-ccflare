import { describe, expect, it } from "bun:test";
import type { ProviderServerToolReplayIssuer } from "../types";
import {
	type AnthropicServerToolBaseContext,
	type AnthropicServerToolCompletion,
	type AnthropicServerToolEncoder,
	AnthropicServerToolEncodingError,
	type AnthropicServerToolJsonCompletion,
	type AnthropicServerToolSseEvent,
	createAnthropicServerToolJsonEncoder,
	createAnthropicServerToolSseEncoder,
} from "./anthropic-server-tool-encoder";
import {
	createHostedSearchLifecycleReducer,
	type HostedSearchLifecycleEvent,
	type HostedSearchLifecycleInput,
	type HostedSearchResultErrorCode,
} from "./hosted-search-lifecycle";

const BASE_CONTEXT = Object.freeze({
	messageId: "msg_proxy_fixture",
	model: "claude-opus-4-6",
	inputTokens: 41,
	cacheReadInputTokens: 7,
	cacheCreationInputTokens: 3,
	startContentBlockIndex: 0,
}) satisfies AnthropicServerToolBaseContext;

const TERMINAL_CONTEXT = Object.freeze({
	inputTokens: 41,
	cacheReadInputTokens: 7,
	cacheCreationInputTokens: 3,
	outputTokens: 19,
	clientFunctionPending: false,
});

const RESULT_ERROR_CODES = Object.freeze([
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
	"query_too_long",
	"request_too_large",
	"unavailable",
] satisfies readonly HostedSearchResultErrorCode[]);

type Issuance = Readonly<{
	binding: Parameters<ProviderServerToolReplayIssuer>[0];
	payload: Parameters<ProviderServerToolReplayIssuer>[1];
}>;

function replayIssuer(
	issuances: Issuance[],
	options: Readonly<{
		failAt?: number;
		onIssue?: (index: number) => void;
	}> = {},
): ProviderServerToolReplayIssuer {
	return async (binding, payload) => {
		const index = issuances.length;
		issuances.push({ binding, payload });
		options.onIssue?.(index);
		await Promise.resolve();
		if (options.failAt === index) {
			throw new Error("secret query and source must not escape");
		}
		return `replay_${binding.envelopeKind}_${binding.callId}_${binding.ordinal}_${index}`;
	};
}

function createJsonHarness(
	issuer: ProviderServerToolReplayIssuer,
	observeJsonSerialization?: (
		observation: Readonly<{ byteLength: number }>,
	) => void,
	base: AnthropicServerToolBaseContext = BASE_CONTEXT,
) {
	const lifecycle = createHostedSearchLifecycleReducer();
	const encoder = createAnthropicServerToolJsonEncoder({
		lifecycle,
		replayIssuer: issuer,
		replay: Object.freeze({
			physicalModel: "gpt-5.6-sol",
			fidelity: "proof-r17/decoder-r9",
		}),
		base,
		observeJsonSerialization,
	});
	return { lifecycle, encoder };
}

function expectAborted(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
): void {
	expect(lifecycle.snapshot()).toMatchObject({
		status: "aborted",
		terminalReason: null,
		activeCallAssemblies: 0,
		compactCallProvenance: 0,
		activeCitationAssemblies: 0,
		retainedAnswerProvenance: 0,
		retainedSourceProvenance: 0,
		retainedSemanticIdentityBytes: 0,
		liveSemanticBytes: 0,
	});
}

function createSseHarness(
	issuer: ProviderServerToolReplayIssuer,
	writeEvent?: (
		event: AnthropicServerToolSseEvent,
		signal: AbortSignal,
	) => void | Promise<void>,
	base: AnthropicServerToolBaseContext = BASE_CONTEXT,
) {
	const lifecycle = createHostedSearchLifecycleReducer();
	const events: AnthropicServerToolSseEvent[] = [];
	const encoder = createAnthropicServerToolSseEncoder({
		lifecycle,
		replayIssuer: issuer,
		replay: Object.freeze({
			physicalModel: "gpt-5.6-sol",
			fidelity: "proof-r17/decoder-r9",
		}),
		base,
		writeEvent: async (event, signal) => {
			await writeEvent?.(event, signal);
			if (signal.aborted) {
				throw new Error("test writer observed cancellation");
			}
			events.push(event);
		},
	});
	return { lifecycle, encoder, events };
}

async function accept(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
	input: HostedSearchLifecycleInput,
): Promise<HostedSearchLifecycleEvent> {
	const event = lifecycle.accept(input);
	await encoder.accept(event);
	return event;
}

async function oneCitedSearch(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
): Promise<void> {
	await accept(lifecycle, encoder, {
		type: "declared",
		callId: "srvtoolu_fixture_a",
	});
	await accept(lifecycle, encoder, {
		type: "dispatched",
		callId: "srvtoolu_fixture_a",
	});
	await accept(lifecycle, encoder, {
		type: "query_known",
		callId: "srvtoolu_fixture_a",
		queryOrdinal: 0,
		query: "Unicode weather",
	});
	await accept(lifecycle, encoder, {
		type: "searching",
		callId: "srvtoolu_fixture_a",
	});
	await accept(lifecycle, encoder, {
		type: "result",
		callId: "srvtoolu_fixture_a",
		sources: Object.freeze([
			Object.freeze({
				sourceRef: "source-a",
				url: "https://weather.example/unicode",
				title: "Unicode Weather",
				pageAge: "2026-08-05",
			}),
		]),
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_started",
		blockId: "srvtext_fixture_a",
		text: "A\ud83c\udf24\ufe0fB",
	});
	await accept(lifecycle, encoder, {
		type: "citation",
		blockId: "srvtext_fixture_a",
		callId: "srvtoolu_fixture_a",
		sourceRef: "source-a",
		citationOrdinal: 0,
		originalIndex: 0,
		startCharIndex: 1,
		endCharIndex: 4,
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_completed",
		blockId: "srvtext_fixture_a",
	});
	await accept(lifecycle, encoder, {
		type: "usage_observation",
		webSearchRequests: 1,
	});
	await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
}

async function mixedHostedSearchAndClientFunction(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
): Promise<void> {
	await accept(lifecycle, encoder, {
		type: "declared",
		callId: "srvtoolu_mixed",
	});
	await accept(lifecycle, encoder, {
		type: "dispatched",
		callId: "srvtoolu_mixed",
	});
	await accept(lifecycle, encoder, {
		type: "query_known",
		callId: "srvtoolu_mixed",
		queryOrdinal: 0,
		query: "mixed search",
	});
	await accept(lifecycle, encoder, {
		type: "searching",
		callId: "srvtoolu_mixed",
	});
	await accept(lifecycle, encoder, {
		type: "result",
		callId: "srvtoolu_mixed",
		sources: Object.freeze([]),
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_started",
		blockId: "srvtext_mixed",
		text: "Uncited preface",
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_completed",
		blockId: "srvtext_mixed",
	});
	await encoder.acceptClientFunction(
		Object.freeze({
			type: "start",
			callId: "call_client_fixture",
			name: "save_result",
		}),
	);
	await encoder.acceptClientFunction(
		Object.freeze({
			type: "arguments_delta",
			callId: "call_client_fixture",
			delta: '{"value":',
		}),
	);
	await encoder.acceptClientFunction(
		Object.freeze({
			type: "arguments_delta",
			callId: "call_client_fixture",
			delta: '"kept"}',
		}),
	);
	await encoder.acceptClientFunction(
		Object.freeze({
			type: "complete",
			callId: "call_client_fixture",
			normalizedArgumentsJson: '{"value":"kept"}',
		}),
	);
	await accept(lifecycle, encoder, {
		type: "usage_observation",
		webSearchRequests: 1,
	});
	await accept(lifecycle, encoder, { type: "terminal", reason: "tool_use" });
}

async function overlappingCitationFlow(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
): Promise<void> {
	const callId = "srvtoolu_citation_order";
	await accept(lifecycle, encoder, { type: "declared", callId });
	await accept(lifecycle, encoder, { type: "dispatched", callId });
	await accept(lifecycle, encoder, {
		type: "query_known",
		callId,
		queryOrdinal: 0,
		query: "citation order",
	});
	await accept(lifecycle, encoder, { type: "searching", callId });
	await accept(lifecycle, encoder, {
		type: "result",
		callId,
		sources: Object.freeze([
			Object.freeze({
				sourceRef: "source-first",
				url: "https://citations.example/first",
				title: "First",
				pageAge: null,
			}),
			Object.freeze({
				sourceRef: "source-second",
				url: "https://citations.example/second",
				title: "Second",
				pageAge: null,
			}),
		]),
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_started",
		blockId: "srvtext_citation_order",
		text: "abcdef",
	});
	// Native delivery can be out of final annotation order and ranges may overlap.
	await accept(lifecycle, encoder, {
		type: "citation",
		blockId: "srvtext_citation_order",
		callId,
		sourceRef: "source-second",
		citationOrdinal: 1,
		originalIndex: 1,
		startCharIndex: 2,
		endCharIndex: 6,
	});
	await accept(lifecycle, encoder, {
		type: "citation",
		blockId: "srvtext_citation_order",
		callId,
		sourceRef: "source-first",
		citationOrdinal: 0,
		originalIndex: 0,
		startCharIndex: 0,
		endCharIndex: 3,
	});
	await accept(lifecycle, encoder, {
		type: "answer_text_completed",
		blockId: "srvtext_citation_order",
	});
	await accept(lifecycle, encoder, {
		type: "usage_observation",
		webSearchRequests: 1,
	});
	await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
}

async function beginSearch(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
	callId: string,
	query: string,
): Promise<void> {
	await accept(lifecycle, encoder, { type: "declared", callId });
	await accept(lifecycle, encoder, { type: "dispatched", callId });
	await accept(lifecycle, encoder, {
		type: "query_known",
		callId,
		queryOrdinal: 0,
		query,
	});
	await accept(lifecycle, encoder, { type: "searching", callId });
}

async function finishSuccessfulSearch(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
): Promise<void> {
	await accept(lifecycle, encoder, {
		type: "usage_observation",
		webSearchRequests: 1,
	});
	await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
}

type EnvelopeFixtureSource = Readonly<{
	callId: string;
	sourceRef: string;
	sourceOrdinal: number;
	url: string;
	title: string;
	pageAge: null;
}>;

async function populateEnvelopeFixture(
	lifecycle: ReturnType<typeof createHostedSearchLifecycleReducer>,
	encoder: AnthropicServerToolEncoder<AnthropicServerToolCompletion>,
	sourceCount: number,
	citationCount: number,
): Promise<readonly EnvelopeFixtureSource[]> {
	const fixtureSources: EnvelopeFixtureSource[] = [];
	let globalSource = 0;
	for (let callIndex = 0; globalSource < sourceCount; callIndex += 1) {
		const callId = `srvtoolu_envelopes_${callIndex}`;
		await beginSearch(
			lifecycle,
			encoder,
			callId,
			`envelope query ${callIndex}`,
		);
		const perCall = Math.min(64, sourceCount - globalSource);
		const sources = Array.from({ length: perCall }, (_, sourceOrdinal) => {
			const sourceIndex = globalSource + sourceOrdinal;
			const source = Object.freeze({
				sourceRef: `source-${sourceIndex}`,
				url: `https://envelopes.example/${sourceIndex}`,
				title: `Source ${sourceIndex}`,
				pageAge: null,
			});
			fixtureSources.push(Object.freeze({ callId, sourceOrdinal, ...source }));
			return source;
		});
		globalSource += perCall;
		await accept(lifecycle, encoder, {
			type: "result",
			callId,
			sources: Object.freeze(sources),
		});
	}
	if (citationCount > 0) {
		const text = "z".repeat(citationCount);
		await accept(lifecycle, encoder, {
			type: "answer_text_started",
			blockId: "srvtext_envelopes",
			text,
		});
		for (
			let citationOrdinal = 0;
			citationOrdinal < citationCount;
			citationOrdinal += 1
		) {
			const source = fixtureSources[citationOrdinal % fixtureSources.length];
			if (source === undefined) throw new Error("fixture source missing");
			await accept(lifecycle, encoder, {
				type: "citation",
				blockId: "srvtext_envelopes",
				callId: source.callId,
				sourceRef: source.sourceRef,
				citationOrdinal,
				originalIndex: citationOrdinal,
				startCharIndex: citationOrdinal,
				endCharIndex: citationOrdinal + 1,
			});
		}
		await accept(lifecycle, encoder, {
			type: "answer_text_completed",
			blockId: "srvtext_envelopes",
		});
	}
	return Object.freeze(fixtureSources);
}

function semanticContentFromSse(
	events: readonly AnthropicServerToolSseEvent[],
): readonly unknown[] {
	const blocks = new Map<number, Record<string, unknown>>();
	for (const { event, data } of events) {
		const record = data as Record<string, unknown>;
		if (event === "content_block_start") {
			const index = record.index as number;
			blocks.set(index, structuredClone(record.content_block));
			continue;
		}
		if (event !== "content_block_delta") continue;
		const index = record.index as number;
		const block = blocks.get(index);
		const delta = record.delta as Record<string, unknown>;
		if (
			(block?.type === "server_tool_use" || block?.type === "tool_use") &&
			delta.type === "input_json_delta"
		) {
			block.input = JSON.parse(delta.partial_json as string);
		}
		if (block?.type === "text" && delta.type === "text_delta") {
			block.text = `${block.text ?? ""}${delta.text as string}`;
		}
		if (block?.type === "text" && delta.type === "citations_delta") {
			const citations = (block.citations ?? []) as unknown[];
			citations.push(delta.citation);
			block.citations = citations;
		}
	}
	return [...blocks.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, block]) => block);
}

function usageFromSse(events: readonly AnthropicServerToolSseEvent[]): unknown {
	return (
		events.find(({ event }) => event === "message_delta")?.data as Record<
			string,
			unknown
		>
	)?.usage;
}

async function settlementWithin(
	promise: Promise<unknown>,
	timeoutMs = 40,
): Promise<"fulfilled" | "rejected" | "timeout"> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => "fulfilled" as const,
				() => "rejected" as const,
			),
			new Promise<"timeout">((resolve) => {
				timeout = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

describe("Anthropic hosted-search encoder", () => {
	it("emits exact direct JSON and direct SSE semantic parity with replay evidence", async () => {
		const jsonIssuances: Issuance[] = [];
		const sseIssuances: Issuance[] = [];
		let serializations = 0;
		const json = createJsonHarness(replayIssuer(jsonIssuances), () => {
			serializations += 1;
		});
		const sse = createSseHarness(replayIssuer(sseIssuances));

		await oneCitedSearch(json.lifecycle, json.encoder);
		await oneCitedSearch(sse.lifecycle, sse.encoder);
		const jsonCompletion = await json.encoder.complete(TERMINAL_CONTEXT);
		const sseCompletion = await sse.encoder.complete(TERMINAL_CONTEXT);

		expect(serializations).toBe(1);
		expect(JSON.parse(jsonCompletion.json)).toEqual(jsonCompletion.body);
		expect(semanticContentFromSse(sse.events)).toEqual(
			jsonCompletion.body.content,
		);
		expect(usageFromSse(sse.events)).toEqual(jsonCompletion.body.usage);
		expect(sseCompletion.stopReason).toBe("end_turn");
		expect(jsonCompletion.lifecycle.status).toBe("complete");
		expect(jsonCompletion.lifecycle.compactCallProvenance).toBe(0);
		expect(jsonCompletion.lifecycle.retainedAnswerProvenance).toBe(0);
		expect(jsonCompletion.body.content).toEqual([
			{
				type: "server_tool_use",
				id: "srvtoolu_fixture_a",
				name: "web_search",
				caller: { type: "direct" },
				input: { query: "Unicode weather" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_fixture_a",
				caller: { type: "direct" },
				content: [
					{
						type: "web_search_result",
						url: "https://weather.example/unicode",
						title: "Unicode Weather",
						page_age: "2026-08-05",
						encrypted_content: "replay_source_srvtoolu_fixture_a_0_0",
					},
				],
			},
			{
				type: "text",
				text: "A\ud83c\udf24\ufe0fB",
				citations: [
					{
						type: "web_search_result_location",
						url: "https://weather.example/unicode",
						title: "Unicode Weather",
						cited_text: "\ud83c\udf24\ufe0f",
						encrypted_index: "replay_citation_srvtoolu_fixture_a_0_1",
					},
				],
			},
		]);
		expect(jsonCompletion.body.usage).toEqual({
			input_tokens: 41,
			output_tokens: 19,
			cache_read_input_tokens: 7,
			cache_creation_input_tokens: 3,
			server_tool_use: { web_search_requests: 1 },
		});
		expect(jsonIssuances).toEqual(sseIssuances);
		expect(jsonIssuances).toEqual([
			{
				binding: {
					envelopeKind: "source",
					toolType: "web_search_20250305",
					callId: "srvtoolu_fixture_a",
					visibleQuery: "Unicode weather",
					resultState: "result",
					ordinal: 0,
					linkage: null,
					visibleEvidence: [
						{
							url: "https://weather.example/unicode",
							title: "Unicode Weather",
							citedText: "",
							pageAge: "2026-08-05",
						},
					],
				},
				payload: {
					provider: "codex",
					model: "gpt-5.6-sol",
					fidelity: "proof-r17/decoder-r9",
				},
			},
			{
				binding: {
					envelopeKind: "citation",
					toolType: "web_search_20250305",
					callId: "srvtoolu_fixture_a",
					visibleQuery: "Unicode weather",
					resultState: "result",
					ordinal: 0,
					linkage: "citation:0",
					visibleEvidence: [
						{
							url: "https://weather.example/unicode",
							title: "Unicode Weather",
							citedText: "\ud83c\udf24\ufe0f",
							pageAge: "2026-08-05",
						},
					],
				},
				payload: {
					provider: "codex",
					model: "gpt-5.6-sol",
					fidelity: "proof-r17/decoder-r9",
				},
			},
		]);
		expect(jsonCompletion.lifecycle.replayEnvelopeCount).toBe(2);
	});

	it("preserves multiple-call/source order and duplicate visible records by ordinal", async () => {
		const issuances: Issuance[] = [];
		const { lifecycle, encoder } = createJsonHarness(replayIssuer(issuances));
		for (const callId of ["srvtoolu_one", "srvtoolu_two"] as const) {
			await accept(lifecycle, encoder, { type: "declared", callId });
			await accept(lifecycle, encoder, { type: "dispatched", callId });
			await accept(lifecycle, encoder, {
				type: "query_known",
				callId,
				queryOrdinal: 0,
				query: `query-${callId}`,
			});
			await accept(lifecycle, encoder, { type: "searching", callId });
			await accept(lifecycle, encoder, {
				type: "result",
				callId,
				sources: Object.freeze([
					Object.freeze({
						sourceRef: `${callId}-a`,
						url: "https://duplicate.example/item",
						title: "Same visible source",
						pageAge: null,
					}),
					Object.freeze({
						sourceRef: `${callId}-b`,
						url: "https://duplicate.example/item",
						title: "Same visible source",
						pageAge: null,
					}),
				]),
			});
		}
		await accept(lifecycle, encoder, {
			type: "usage_observation",
			webSearchRequests: 2,
		});
		await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
		const completion = await encoder.complete(TERMINAL_CONTEXT);

		expect(completion.body.content.map((block) => block.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"server_tool_use",
			"web_search_tool_result",
		]);
		expect(issuances.map(({ binding }) => binding.linkage)).toEqual([
			null,
			"0",
			null,
			"0",
		]);
		expect(issuances.map(({ binding }) => binding.ordinal)).toEqual([
			0, 1, 0, 1,
		]);
		expect(completion.lifecycle.uniqueSourceCount).toBe(4);
	});

	it("orders adjacent and overlapping citations and honors a nonzero SSE block index", async () => {
		const base = Object.freeze({ ...BASE_CONTEXT, startContentBlockIndex: 7 });
		const json = createJsonHarness(replayIssuer([]), undefined, base);
		const sse = createSseHarness(replayIssuer([]), undefined, base);
		await overlappingCitationFlow(json.lifecycle, json.encoder);
		await overlappingCitationFlow(sse.lifecycle, sse.encoder);
		const jsonCompletion = await json.encoder.complete(TERMINAL_CONTEXT);
		await sse.encoder.complete(TERMINAL_CONTEXT);

		expect(semanticContentFromSse(sse.events)).toEqual(
			jsonCompletion.body.content,
		);
		expect(
			sse.events
				.filter(({ event }) => event === "content_block_start")
				.map(({ data }) => (data as { index: number }).index),
		).toEqual([7, 8, 9]);
		const text = jsonCompletion.body.content[2];
		expect(text).toMatchObject({
			type: "text",
			citations: [
				{
					url: "https://citations.example/first",
					cited_text: "abc",
				},
				{
					url: "https://citations.example/second",
					cited_text: "cdef",
				},
			],
		});
	});

	it("distinguishes empty success and all six exact in-band errors without issuing evidence", async () => {
		for (const errorCode of [null, ...RESULT_ERROR_CODES] as const) {
			const scenario = errorCode === null ? "empty" : errorCode;
			const issuances: Issuance[] = [];
			const { lifecycle, encoder } = createJsonHarness(replayIssuer(issuances));
			await accept(lifecycle, encoder, {
				type: "declared",
				callId: `srvtoolu_${scenario}`,
			});
			await accept(lifecycle, encoder, {
				type: "dispatched",
				callId: `srvtoolu_${scenario}`,
			});
			await accept(lifecycle, encoder, {
				type: "query_known",
				callId: `srvtoolu_${scenario}`,
				queryOrdinal: 0,
				query: `${scenario} query`,
			});
			await accept(lifecycle, encoder, {
				type: "searching",
				callId: `srvtoolu_${scenario}`,
			});
			await accept(
				lifecycle,
				encoder,
				errorCode === null
					? {
							type: "result",
							callId: `srvtoolu_${scenario}`,
							sources: Object.freeze([]),
						}
					: {
							type: "result_error",
							callId: `srvtoolu_${scenario}`,
							errorCode,
						},
			);
			await accept(lifecycle, encoder, {
				type: "usage_observation",
				webSearchRequests: errorCode === null ? 1 : 0,
			});
			await accept(lifecycle, encoder, {
				type: "terminal",
				reason: "end_turn",
			});
			const completion = await encoder.complete(TERMINAL_CONTEXT);
			const result = completion.body.content[1];
			expect(result).toEqual(
				errorCode === null
					? {
							type: "web_search_tool_result",
							tool_use_id: `srvtoolu_${scenario}`,
							caller: { type: "direct" },
							content: [],
						}
					: {
							type: "web_search_tool_result",
							tool_use_id: `srvtoolu_${scenario}`,
							caller: { type: "direct" },
							content: {
								type: "web_search_tool_result_error",
								error_code: errorCode,
							},
						},
			);
			expect(issuances).toHaveLength(0);
		}
	});

	it("keeps mixed hosted search, uncited text, and client functions in direct SSE/JSON order", async () => {
		const json = createJsonHarness(replayIssuer([]));
		const sse = createSseHarness(replayIssuer([]));
		await mixedHostedSearchAndClientFunction(json.lifecycle, json.encoder);
		await mixedHostedSearchAndClientFunction(sse.lifecycle, sse.encoder);
		const terminal = Object.freeze({
			...TERMINAL_CONTEXT,
			outputTokens: 4,
			clientFunctionPending: true,
		});
		const jsonCompletion = await json.encoder.complete(terminal);
		const sseCompletion = await sse.encoder.complete(terminal);

		expect(jsonCompletion.body.content).toEqual([
			{
				type: "server_tool_use",
				id: "srvtoolu_mixed",
				name: "web_search",
				caller: { type: "direct" },
				input: { query: "mixed search" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_mixed",
				caller: { type: "direct" },
				content: [],
			},
			{ type: "text", text: "Uncited preface" },
			{
				type: "tool_use",
				id: "call_client_fixture",
				name: "save_result",
				input: { value: "kept" },
			},
		]);
		expect(semanticContentFromSse(sse.events)).toEqual(
			jsonCompletion.body.content,
		);
		expect(
			sse.events
				.filter(({ event }) => event === "content_block_start")
				.map(({ data }) => (data as { index: number }).index),
		).toEqual([0, 1, 2, 3]);
		expect(jsonCompletion.body.stop_reason).toBe("tool_use");
		expect(sseCompletion.stopReason).toBe("tool_use");
		expect(jsonCompletion.body.usage.server_tool_use.web_search_requests).toBe(
			1,
		);
	});

	it("maps every terminal explicitly and aborts the non-message error policy", async () => {
		const cases = [
			["end_turn", "end_turn"],
			["max_tokens", "max_tokens"],
			["incomplete", "max_tokens"],
			["refusal", "refusal"],
		] as const;
		for (const [terminalReason, expectedStopReason] of cases) {
			const harness = createJsonHarness(replayIssuer([]));
			await accept(harness.lifecycle, harness.encoder, {
				type: "usage_observation",
				webSearchRequests: 0,
			});
			await accept(harness.lifecycle, harness.encoder, {
				type: "terminal",
				reason: terminalReason,
			});
			const completion = await harness.encoder.complete({
				...TERMINAL_CONTEXT,
				outputTokens: 0,
				clientFunctionPending: false,
			});
			expect(completion.stopReason).toBe(expectedStopReason);
		}

		const toolUse = createJsonHarness(replayIssuer([]));
		await toolUse.encoder.acceptClientFunction(
			Object.freeze({
				type: "start",
				callId: "call_terminal",
				name: "terminal_tool",
			}),
		);
		await toolUse.encoder.acceptClientFunction(
			Object.freeze({
				type: "complete",
				callId: "call_terminal",
				normalizedArgumentsJson: "{}",
			}),
		);
		await accept(toolUse.lifecycle, toolUse.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(toolUse.lifecycle, toolUse.encoder, {
			type: "terminal",
			reason: "tool_use",
		});
		expect(
			(
				await toolUse.encoder.complete({
					...TERMINAL_CONTEXT,
					outputTokens: 0,
					clientFunctionPending: true,
				})
			).stopReason,
		).toBe("tool_use");

		const error = createJsonHarness(replayIssuer([]));
		await accept(error.lifecycle, error.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(error.lifecycle, error.encoder, {
			type: "terminal",
			reason: "error",
		});
		await expect(
			error.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(error.lifecycle);
	});

	it("records every envelope before dependent output and snapshots event inputs", async () => {
		const order: string[] = [];
		const issuances: Issuance[] = [];
		const issuer = replayIssuer(issuances, {
			onIssue: (index) => order.push(`issue:${index}`),
		});
		const { lifecycle, encoder, events } = createSseHarness(issuer, (event) => {
			if (event.event === "content_block_start") {
				const block = (event.data as Record<string, unknown>)
					.content_block as Record<string, unknown>;
				order.push(`write:${block.type}`);
			}
		});
		await accept(lifecycle, encoder, {
			type: "declared",
			callId: "srvtoolu_snapshot",
		});
		await accept(lifecycle, encoder, {
			type: "dispatched",
			callId: "srvtoolu_snapshot",
		});
		await accept(lifecycle, encoder, {
			type: "query_known",
			callId: "srvtoolu_snapshot",
			queryOrdinal: 0,
			query: "snapshot query",
		});
		await accept(lifecycle, encoder, {
			type: "searching",
			callId: "srvtoolu_snapshot",
		});
		const result = lifecycle.accept({
			type: "result",
			callId: "srvtoolu_snapshot",
			sources: Object.freeze([
				Object.freeze({
					sourceRef: "snapshot-source",
					url: "https://snapshot.example/original",
					title: "Original",
					pageAge: null,
				}),
			]),
		});
		const pending = encoder.accept(result);
		await pending;
		await accept(lifecycle, encoder, {
			type: "usage_observation",
			webSearchRequests: 1,
		});
		await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
		await encoder.complete(TERMINAL_CONTEXT);

		expect(order.indexOf("issue:0")).toBeLessThan(
			order.indexOf("write:web_search_tool_result"),
		);
		expect(events.some(({ event }) => event === "message_stop")).toBe(true);
		expect(issuances[0]?.binding.visibleEvidence[0]?.url).toBe(
			"https://snapshot.example/original",
		);
		expect(lifecycle.snapshot().replayEnvelopeCount).toBe(1);
	});

	it("accepts replay tokens at N-1/N and aborts at the N+1 byte bound", async () => {
		for (const tokenBytes of [4095, 4096]) {
			const harness = createJsonHarness(async () => "t".repeat(tokenBytes));
			await beginSearch(
				harness.lifecycle,
				harness.encoder,
				`srvtoolu_token_${tokenBytes}`,
				"token boundary",
			);
			await accept(harness.lifecycle, harness.encoder, {
				type: "result",
				callId: `srvtoolu_token_${tokenBytes}`,
				sources: Object.freeze([
					Object.freeze({
						sourceRef: "token-source",
						url: "https://bounds.example/token",
						title: "Token",
						pageAge: null,
					}),
				]),
			});
			await finishSuccessfulSearch(harness.lifecycle, harness.encoder);
			const completion = await harness.encoder.complete(TERMINAL_CONTEXT);
			expect(completion.lifecycle.replayEnvelopeBytes).toBe(tokenBytes);
		}

		const overflow = createJsonHarness(async () => "t".repeat(4097));
		await beginSearch(
			overflow.lifecycle,
			overflow.encoder,
			"srvtoolu_token_overflow",
			"token overflow",
		);
		await expect(
			accept(overflow.lifecycle, overflow.encoder, {
				type: "result",
				callId: "srvtoolu_token_overflow",
				sources: Object.freeze([
					Object.freeze({
						sourceRef: "overflow-source",
						url: "https://bounds.example/overflow",
						title: "Overflow",
						pageAge: null,
					}),
				]),
			}),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(overflow.lifecycle);
	});

	it("accepts query fields at N-1/N and aborts a forged N+1 event", async () => {
		for (const queryBytes of [8191, 8192]) {
			const harness = createJsonHarness(replayIssuer([]));
			const callId = `srvtoolu_query_${queryBytes}`;
			await beginSearch(
				harness.lifecycle,
				harness.encoder,
				callId,
				"q".repeat(queryBytes),
			);
			await accept(harness.lifecycle, harness.encoder, {
				type: "result",
				callId,
				sources: Object.freeze([]),
			});
			await finishSuccessfulSearch(harness.lifecycle, harness.encoder);
			await expect(
				harness.encoder.complete(TERMINAL_CONTEXT),
			).resolves.toMatchObject({ stopReason: "end_turn" });
		}

		const overflow = createJsonHarness(replayIssuer([]));
		await accept(overflow.lifecycle, overflow.encoder, {
			type: "declared",
			callId: "srvtoolu_query_overflow",
		});
		await accept(overflow.lifecycle, overflow.encoder, {
			type: "dispatched",
			callId: "srvtoolu_query_overflow",
		});
		await expect(
			overflow.encoder.accept(
				Object.freeze({
					type: "query_known",
					callId: "srvtoolu_query_overflow",
					queryOrdinal: 0,
					query: "q".repeat(8193),
				}) as never,
			),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(overflow.lifecycle);
	});

	it("enforces translated JSON output at N-1/N/N+1 with one canonical serialization", async () => {
		const outputLimit = 4 * 1024 * 1024;
		const blockCount = 64;
		const maxPayloadBytes = 64 * 1024 - JSON.stringify({ value: "" }).length;
		const expectedBody = (payloadLengths: readonly number[]) => ({
			id: BASE_CONTEXT.messageId,
			type: "message",
			role: "assistant",
			model: BASE_CONTEXT.model,
			content: payloadLengths.map((length, index) => ({
				type: "tool_use",
				id: `call_output_${index}`,
				name: "output_boundary",
				input: { value: "x".repeat(length) },
			})),
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: {
				input_tokens: BASE_CONTEXT.inputTokens,
				output_tokens: 0,
				cache_read_input_tokens: BASE_CONTEXT.cacheReadInputTokens,
				cache_creation_input_tokens: BASE_CONTEXT.cacheCreationInputTokens,
				server_tool_use: { web_search_requests: 0 },
			},
		});
		const emptyLengths = Array.from({ length: blockCount }, () => 0);
		const emptyBytes = new TextEncoder().encode(
			JSON.stringify(expectedBody(emptyLengths)),
		).byteLength;

		for (const targetBytes of [outputLimit - 1, outputLimit, outputLimit + 1]) {
			const payloadLengths = [
				...Array.from({ length: blockCount - 1 }, () => maxPayloadBytes),
				targetBytes - emptyBytes - (blockCount - 1) * maxPayloadBytes,
			];
			expect(payloadLengths.at(-1)).toBeGreaterThanOrEqual(0);
			expect(payloadLengths.at(-1)).toBeLessThanOrEqual(maxPayloadBytes);
			let observations = 0;
			const harness = createJsonHarness(replayIssuer([]), () => {
				observations += 1;
			});
			for (let index = 0; index < payloadLengths.length; index += 1) {
				const callId = `call_output_${index}`;
				await harness.encoder.acceptClientFunction(
					Object.freeze({
						type: "start",
						callId,
						name: "output_boundary",
					}),
				);
				await harness.encoder.acceptClientFunction(
					Object.freeze({
						type: "complete",
						callId,
						normalizedArgumentsJson: JSON.stringify({
							value: "x".repeat(payloadLengths[index] ?? 0),
						}),
					}),
				);
			}
			await accept(harness.lifecycle, harness.encoder, {
				type: "usage_observation",
				webSearchRequests: 0,
			});
			await accept(harness.lifecycle, harness.encoder, {
				type: "terminal",
				reason: "tool_use",
			});
			const completion = harness.encoder.complete({
				...TERMINAL_CONTEXT,
				outputTokens: 0,
				clientFunctionPending: true,
			});
			if (targetBytes <= outputLimit) {
				const result = await completion;
				expect(new TextEncoder().encode(result.json).byteLength).toBe(
					targetBytes,
				);
				expect(observations).toBe(1);
			} else {
				await expect(completion).rejects.toBeInstanceOf(
					AnthropicServerToolEncodingError,
				);
				expect(observations).toBe(0);
				expectAborted(harness.lifecycle);
			}
		}
	});

	it("records replay envelopes at N-1/N and aborts before emitting N+1", async () => {
		for (const sourceCount of [255, 256]) {
			let tokenOrdinal = 0;
			const harness = createJsonHarness(async () => `token_${tokenOrdinal++}`);
			await populateEnvelopeFixture(
				harness.lifecycle,
				harness.encoder,
				sourceCount,
				256,
			);
			await accept(harness.lifecycle, harness.encoder, {
				type: "usage_observation",
				webSearchRequests: 4,
			});
			await accept(harness.lifecycle, harness.encoder, {
				type: "terminal",
				reason: "end_turn",
			});
			const completion = await harness.encoder.complete(TERMINAL_CONTEXT);
			expect(completion.lifecycle.replayEnvelopeCount).toBe(sourceCount + 256);
		}

		let tokenOrdinal = 0;
		const overflow = createJsonHarness(async () => `token_${tokenOrdinal++}`);
		const sources = await populateEnvelopeFixture(
			overflow.lifecycle,
			overflow.encoder,
			256,
			256,
		);
		const source = sources[0];
		if (source === undefined) throw new Error("fixture source missing");
		const forgedSource = Object.freeze({
			sourceRef: source.sourceRef,
			url: source.url,
			title: source.title,
			pageAge: source.pageAge,
			ordinal: source.sourceOrdinal,
		});
		await expect(
			overflow.encoder.accept(
				Object.freeze({
					type: "cited_answer_text",
					blockId: "srvtext_envelope_overflow",
					text: "z",
					citations: Object.freeze([
						Object.freeze({
							callId: source.callId,
							sourceRef: source.sourceRef,
							sourceOrdinal: source.sourceOrdinal,
							citationOrdinal: 256,
							originalIndex: 256,
							startCharIndex: 0,
							endCharIndex: 1,
							citedText: "z",
							source: forgedSource,
						}),
					]),
				}) as never,
			),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(tokenOrdinal).toBe(513);
		expectAborted(overflow.lifecycle);
	});

	it("normalizes async issuer and sink failures without leaking hostile content", async () => {
		const issuances: Issuance[] = [];
		const failedIssuer = createJsonHarness(
			replayIssuer(issuances, { failAt: 0 }),
		);
		await accept(failedIssuer.lifecycle, failedIssuer.encoder, {
			type: "declared",
			callId: "srvtoolu_secret",
		});
		await accept(failedIssuer.lifecycle, failedIssuer.encoder, {
			type: "dispatched",
			callId: "srvtoolu_secret",
		});
		await accept(failedIssuer.lifecycle, failedIssuer.encoder, {
			type: "query_known",
			callId: "srvtoolu_secret",
			queryOrdinal: 0,
			query: "private query",
		});
		await accept(failedIssuer.lifecycle, failedIssuer.encoder, {
			type: "searching",
			callId: "srvtoolu_secret",
		});
		await expect(
			accept(failedIssuer.lifecycle, failedIssuer.encoder, {
				type: "result",
				callId: "srvtoolu_secret",
				sources: Object.freeze([
					Object.freeze({
						sourceRef: "private-source",
						url: "https://private.example/secret",
						title: "Secret title",
						pageAge: null,
					}),
				]),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				name: "AnthropicServerToolEncodingError",
				code: "anthropic_server_tool_encoding_failed",
				message: "Anthropic server-tool response encoding failed.",
			}),
		);
		expectAborted(failedIssuer.lifecycle);

		const sink = createSseHarness(replayIssuer([]), async () => {
			throw new Error("private sink details");
		});
		await expect(
			accept(sink.lifecycle, sink.encoder, {
				type: "declared",
				callId: "srvtoolu_sink",
			}),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(sink.lifecycle);
		try {
			await accept(sink.lifecycle, sink.encoder, {
				type: "query_known",
				callId: "srvtoolu_sink",
				queryOrdinal: 0,
				query: "not emitted",
			});
		} catch (error) {
			expect(String(error)).not.toContain("private sink details");
			expect(String(error)).not.toContain("not emitted");
		}
	});

	it("aborts on hostile getters and revoked client events", async () => {
		const hostile = createJsonHarness(replayIssuer([]));
		const hostileEvent = Object.freeze(
			Object.defineProperty({}, "type", {
				get() {
					throw new Error("getter secret");
				},
			}),
		);
		await expect(
			hostile.encoder.accept(hostileEvent as never),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(hostile.lifecycle);

		const revoked = createJsonHarness(replayIssuer([]));
		const revocable = Proxy.revocable(
			{ type: "start", callId: "call_revoked", name: "revoked" },
			{},
		);
		revocable.revoke();
		await expect(
			revoked.encoder.acceptClientFunction(revocable.proxy as never),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(revoked.lifecycle);
	});

	it("snapshots base, replay, binding, and payload before delayed issuance", async () => {
		const base = {
			...BASE_CONTEXT,
			messageId: "msg_before_mutation",
			model: "claude-before",
		};
		const replay = {
			physicalModel: "gpt-before",
			fidelity: "proof-before/decoder-before",
		};
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let observed: Issuance | undefined;
		const issuer: ProviderServerToolReplayIssuer = async (binding, payload) => {
			observed = { binding, payload };
			await gate;
			return "delayed_token";
		};
		const lifecycle = createHostedSearchLifecycleReducer();
		const encoder = createAnthropicServerToolJsonEncoder({
			lifecycle,
			replayIssuer: issuer,
			replay,
			base,
		});
		for (const input of [
			{ type: "declared", callId: "srvtoolu_delayed" },
			{ type: "dispatched", callId: "srvtoolu_delayed" },
			{
				type: "query_known",
				callId: "srvtoolu_delayed",
				queryOrdinal: 0,
				query: "before mutation",
			},
			{ type: "searching", callId: "srvtoolu_delayed" },
		] as const) {
			await accept(lifecycle, encoder, input);
		}
		const result = lifecycle.accept({
			type: "result",
			callId: "srvtoolu_delayed",
			sources: Object.freeze([
				Object.freeze({
					sourceRef: "delayed-source",
					url: "https://delayed.example/source",
					title: "Before",
					pageAge: null,
				}),
			]),
		});
		const pending = encoder.accept(result);
		await Promise.resolve();
		base.messageId = "msg_after_mutation";
		base.model = "claude-after";
		replay.physicalModel = "gpt-after";
		replay.fidelity = "proof-after/decoder-after";
		expect(Object.isFrozen(observed?.binding)).toBe(true);
		expect(Object.isFrozen(observed?.binding.visibleEvidence)).toBe(true);
		expect(Object.isFrozen(observed?.payload)).toBe(true);
		release?.();
		await pending;
		await accept(lifecycle, encoder, {
			type: "usage_observation",
			webSearchRequests: 1,
		});
		await accept(lifecycle, encoder, { type: "terminal", reason: "end_turn" });
		const completion = await encoder.complete(TERMINAL_CONTEXT);
		expect(completion.body.id).toBe("msg_before_mutation");
		expect(completion.body.model).toBe("claude-before");
		expect(observed?.payload).toEqual({
			provider: "codex",
			model: "gpt-before",
			fidelity: "proof-before/decoder-before",
		});
	});

	it("rejects terminal, usage, and completion mismatches content-free", async () => {
		const missingTerminal = createJsonHarness(replayIssuer([]));
		await accept(missingTerminal.lifecycle, missingTerminal.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await expect(
			missingTerminal.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(missingTerminal.lifecycle);

		const usageMismatch = createJsonHarness(replayIssuer([]));
		await accept(usageMismatch.lifecycle, usageMismatch.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(usageMismatch.lifecycle, usageMismatch.encoder, {
			type: "usage_provider_report",
			webSearchRequests: 1,
		});
		await accept(usageMismatch.lifecycle, usageMismatch.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await expect(
			usageMismatch.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(usageMismatch.lifecycle);

		const terminalMismatch = createJsonHarness(replayIssuer([]));
		await accept(terminalMismatch.lifecycle, terminalMismatch.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(terminalMismatch.lifecycle, terminalMismatch.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await expect(
			terminalMismatch.encoder.complete({
				...TERMINAL_CONTEXT,
				outputTokens: 0,
				clientFunctionPending: true,
			}),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expectAborted(terminalMismatch.lifecycle);

		const complete = createJsonHarness(replayIssuer([]));
		await accept(complete.lifecycle, complete.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(complete.lifecycle, complete.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		const result: AnthropicServerToolJsonCompletion =
			await complete.encoder.complete(TERMINAL_CONTEXT);
		expect(result.lifecycle.status).toBe("complete");
		await expect(
			complete.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
	});

	it("rejects invalid base state and never serializes JSON through SSE", async () => {
		expect(() =>
			createAnthropicServerToolJsonEncoder({
				lifecycle: createHostedSearchLifecycleReducer(),
				replayIssuer: replayIssuer([]),
				replay: { physicalModel: "gpt-5.6-sol", fidelity: "fidelity" },
				base: {
					...BASE_CONTEXT,
					messageId: "resp_native_must_not_escape",
				},
			}),
		).toThrow(AnthropicServerToolEncodingError);

		let serializations = 0;
		const harness = createJsonHarness(replayIssuer([]), () => {
			serializations += 1;
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await harness.encoder.complete(TERMINAL_CONTEXT);
		expect(serializations).toBe(1);
	});

	it("aborts finalized state when the JSON serialization observer fails", async () => {
		const harness = createJsonHarness(replayIssuer([]), async () => {
			await Promise.resolve();
			throw new Error("observer secret");
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await expect(harness.encoder.complete(TERMINAL_CONTEXT)).rejects.toEqual(
			expect.objectContaining({
				name: "AnthropicServerToolEncodingError",
				message: "Anthropic server-tool response encoding failed.",
			}),
		);
		expectAborted(harness.lifecycle);
	});

	it("rejects malformed observers and canonical serialization failures with cleanup", async () => {
		const malformedLifecycle = createHostedSearchLifecycleReducer();
		expect(() =>
			createAnthropicServerToolJsonEncoder({
				lifecycle: malformedLifecycle,
				replayIssuer: replayIssuer([]),
				replay: { physicalModel: "gpt-5.6-sol", fidelity: "fidelity" },
				base: BASE_CONTEXT,
				observeJsonSerialization: {} as never,
			}),
		).toThrow(AnthropicServerToolEncodingError);
		expectAborted(malformedLifecycle);

		const serialization = createJsonHarness(replayIssuer([]));
		await accept(serialization.lifecycle, serialization.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(serialization.lifecycle, serialization.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		const originalStringify = JSON.stringify;
		let caught: unknown;
		try {
			JSON.stringify = (() => {
				throw new Error("serializer secret");
			}) as typeof JSON.stringify;
			await serialization.encoder.complete(TERMINAL_CONTEXT);
		} catch (error) {
			caught = error;
		} finally {
			JSON.stringify = originalStringify;
		}
		expect(caught).toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(String(caught)).not.toContain("serializer secret");
		expectAborted(serialization.lifecycle);
	});

	it("aborts idempotently before data without starting or completing SSE", async () => {
		const harness = createSseHarness(replayIssuer([]));
		const first = harness.encoder.abort();
		const second = harness.encoder.abort();

		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first).toMatchObject({
			status: "aborted",
			retainedHostedQueries: 0,
			retainedHostedCalls: 0,
			retainedAnswerBlocks: 0,
			retainedClientFunctions: 0,
			retainedClientFunctionArgumentBytes: 0,
			lifecycle: {
				status: "aborted",
				activeCallAssemblies: 0,
				compactCallProvenance: 0,
				activeCitationAssemblies: 0,
				retainedAnswerProvenance: 0,
				retainedSourceProvenance: 0,
				retainedSemanticIdentityBytes: 0,
				liveSemanticBytes: 0,
			},
		});
		expect(harness.events).toEqual([]);
		await expect(
			harness.encoder.accept(
				Object.freeze({ type: "usage_observation", webSearchRequests: 0 }),
			),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		await expect(
			harness.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(harness.events).toEqual([]);
	});

	it("cancels pending replay issuance and emits nothing after abort", async () => {
		let releaseIssuer: (() => void) | undefined;
		let observeIssuer: (() => void) | undefined;
		const issuerStarted = new Promise<void>((resolve) => {
			observeIssuer = resolve;
		});
		const issuerGate = new Promise<void>((resolve) => {
			releaseIssuer = resolve;
		});
		const issuer: ProviderServerToolReplayIssuer = async () => {
			observeIssuer?.();
			await issuerGate;
			return "replay_must_not_be_emitted";
		};
		const harness = createSseHarness(issuer);
		const callId = "srvtoolu_pending_abort";
		await accept(harness.lifecycle, harness.encoder, {
			type: "declared",
			callId,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "dispatched",
			callId,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "query_known",
			callId,
			queryOrdinal: 0,
			query: "cancel pending replay",
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "searching",
			callId,
		});
		const result = harness.lifecycle.accept({
			type: "result",
			callId,
			sources: Object.freeze([
				Object.freeze({
					sourceRef: "pending-source",
					url: "https://pending.example/source",
					title: "Pending",
					pageAge: null,
				}),
			]),
		});
		const pending = harness.encoder.accept(result);
		await issuerStarted;
		const emittedBeforeAbort = harness.events.length;
		const aborted = harness.encoder.abort();
		releaseIssuer?.();

		await expect(pending).rejects.toBeInstanceOf(
			AnthropicServerToolEncodingError,
		);
		expect(harness.events).toHaveLength(emittedBeforeAbort);
		expect(
			harness.events.some(({ wire }) =>
				wire.includes("replay_must_not_be_emitted"),
			),
		).toBe(false);
		expect(aborted).toMatchObject({
			status: "aborted",
			retainedHostedQueries: 0,
			retainedHostedCalls: 0,
			retainedAnswerBlocks: 0,
			retainedClientFunctions: 0,
			retainedClientFunctionArgumentBytes: 0,
		});
		expect(harness.encoder.abort()).toBe(aborted);
	});

	it("clears a partial client function without writing a stop or terminal", async () => {
		const harness = createSseHarness(replayIssuer([]));
		await harness.encoder.acceptClientFunction(
			Object.freeze({
				type: "start",
				callId: "call_partial_abort",
				name: "partial",
			}),
		);
		await harness.encoder.acceptClientFunction(
			Object.freeze({
				type: "arguments_delta",
				callId: "call_partial_abort",
				delta: '{"secret":',
			}),
		);
		const emittedBeforeAbort = harness.events.length;
		const snapshot = harness.encoder.abort();

		expect(snapshot).toMatchObject({
			status: "aborted",
			retainedClientFunctions: 0,
			retainedClientFunctionArgumentBytes: 0,
		});
		await expect(
			harness.encoder.acceptClientFunction(
				Object.freeze({
					type: "complete",
					callId: "call_partial_abort",
					normalizedArgumentsJson: '{"secret":"must-not-emit"}',
				}),
			),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(harness.events).toHaveLength(emittedBeforeAbort);
		expect(
			harness.events.some(({ event }) =>
				["content_block_stop", "message_delta", "message_stop"].includes(event),
			),
		).toBe(false);
	});

	it("stops an in-flight SSE block when the writer cancels synchronously", async () => {
		let cancel: (() => void) | undefined;
		const harness = createSseHarness(replayIssuer([]), (event) => {
			if (
				event.event === "content_block_start" &&
				(event.data as { content_block: { type: string } }).content_block
					.type === "server_tool_use"
			) {
				cancel?.();
			}
		});
		cancel = () => {
			harness.encoder.abort();
		};
		const callId = "srvtoolu_writer_abort";
		await accept(harness.lifecycle, harness.encoder, {
			type: "declared",
			callId,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "dispatched",
			callId,
		});

		await expect(
			accept(harness.lifecycle, harness.encoder, {
				type: "query_known",
				callId,
				queryOrdinal: 0,
				query: "writer cancellation",
			}),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(harness.events.map(({ event }) => event)).toEqual(["message_start"]);
		expect(harness.encoder.abort().status).toBe("aborted");
		expectAborted(harness.lifecycle);
	});

	it("aborts safely after completion and releases the JSON sink", async () => {
		const harness = createJsonHarness(replayIssuer([]));
		await accept(harness.lifecycle, harness.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await harness.encoder.complete(TERMINAL_CONTEXT);

		const aborted = harness.encoder.abort();
		expect(aborted).toMatchObject({
			status: "aborted",
			retainedHostedQueries: 0,
			retainedHostedCalls: 0,
			retainedAnswerBlocks: 0,
			retainedClientFunctions: 0,
			retainedClientFunctionArgumentBytes: 0,
			lifecycle: {
				status: "complete",
				compactCallProvenance: 0,
				retainedAnswerProvenance: 0,
				retainedSourceProvenance: 0,
				liveSemanticBytes: 0,
			},
		});
		expect(harness.encoder.abort()).toBe(aborted);
		await expect(
			harness.encoder.complete(TERMINAL_CONTEXT),
		).rejects.toBeInstanceOf(AnthropicServerToolEncodingError);
	});

	it("uses authoritative terminal token usage with direct SSE and JSON parity", async () => {
		const json = createJsonHarness(replayIssuer([]));
		const sse = createSseHarness(replayIssuer([]));
		await oneCitedSearch(json.lifecycle, json.encoder);
		await oneCitedSearch(sse.lifecycle, sse.encoder);
		const terminal = Object.freeze({
			inputTokens: 101,
			cacheReadInputTokens: 102,
			cacheCreationInputTokens: 103,
			outputTokens: 104,
			clientFunctionPending: false,
		});

		const jsonCompletion = await json.encoder.complete(terminal);
		await sse.encoder.complete(terminal);
		const finalUsage = {
			input_tokens: 101,
			output_tokens: 104,
			cache_read_input_tokens: 102,
			cache_creation_input_tokens: 103,
			server_tool_use: { web_search_requests: 1 },
		};
		expect(jsonCompletion.body.usage).toEqual(finalUsage);
		expect(usageFromSse(sse.events)).toEqual(finalUsage);
		const startUsage = (
			sse.events.find(({ event }) => event === "message_start")?.data as {
				message: { usage: unknown };
			}
		).message.usage;
		expect(startUsage).toEqual({
			input_tokens: BASE_CONTEXT.inputTokens,
			output_tokens: 0,
			cache_read_input_tokens: BASE_CONTEXT.cacheReadInputTokens,
			cache_creation_input_tokens: BASE_CONTEXT.cacheCreationInputTokens,
		});
	});

	it.each([
		["negative", -1],
		["fractional", 1.5],
		["infinite", Number.POSITIVE_INFINITY],
		["unsafe", Number.MAX_SAFE_INTEGER + 1],
		["string", "1"],
	] as const)("rejects hostile final usage %s content-free", async (_label, value) => {
		const harness = createJsonHarness(replayIssuer([]));
		await accept(harness.lifecycle, harness.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		await expect(
			harness.encoder.complete({
				...TERMINAL_CONTEXT,
				inputTokens: value,
			} as never),
		).rejects.toEqual(
			expect.objectContaining({
				name: "AnthropicServerToolEncodingError",
				code: "anthropic_server_tool_encoding_failed",
				message: "Anthropic server-tool response encoding failed.",
			}),
		);
		expectAborted(harness.lifecycle);
	});

	it("normalizes throwing final usage accessors without leaking content", async () => {
		const harness = createJsonHarness(replayIssuer([]));
		await accept(harness.lifecycle, harness.encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		const hostile = Object.defineProperty(
			{ ...TERMINAL_CONTEXT },
			"cacheReadInputTokens",
			{
				get() {
					throw new Error("private usage getter value");
				},
			},
		);
		let caught: unknown;
		try {
			await harness.encoder.complete(hostile as never);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AnthropicServerToolEncodingError);
		expect(String(caught)).not.toContain("private usage getter value");
		expectAborted(harness.lifecycle);
	});

	it("aborts a never-resolving replay issuer without waiting for it", async () => {
		let issuerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			issuerStarted = resolve;
		});
		const harness = createJsonHarness(async () => {
			issuerStarted?.();
			return await new Promise<string>(() => {});
		});
		const callId = "srvtoolu_never_resolving";
		await accept(harness.lifecycle, harness.encoder, {
			type: "declared",
			callId,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "dispatched",
			callId,
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "query_known",
			callId,
			queryOrdinal: 0,
			query: "never resolve",
		});
		await accept(harness.lifecycle, harness.encoder, {
			type: "searching",
			callId,
		});
		const pending = harness.encoder.accept(
			harness.lifecycle.accept({
				type: "result",
				callId,
				sources: Object.freeze([
					Object.freeze({
						sourceRef: "never-source",
						url: "https://never.example/source",
						title: "Never",
						pageAge: null,
					}),
				]),
			}),
		);
		await started;
		harness.encoder.abort();

		expect(await settlementWithin(pending)).toBe("rejected");
		expectAborted(harness.lifecycle);
	});

	it("aborts multiple replay races and consumes late resolution and rejection", async () => {
		type DeferredIssuer = {
			resolve(value: string): void;
			reject(error: unknown): void;
		};
		const deferred: DeferredIssuer[] = [];
		let bothStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const harness = createJsonHarness(
				() =>
					new Promise<string>((resolve, reject) => {
						deferred.push({ resolve, reject });
						if (deferred.length === 2) bothStarted?.();
					}),
			);
			const pending: Promise<void>[] = [];
			for (const suffix of ["resolve", "reject"] as const) {
				const callId = `srvtoolu_late_${suffix}`;
				await accept(harness.lifecycle, harness.encoder, {
					type: "declared",
					callId,
				});
				await accept(harness.lifecycle, harness.encoder, {
					type: "dispatched",
					callId,
				});
				await accept(harness.lifecycle, harness.encoder, {
					type: "query_known",
					callId,
					queryOrdinal: 0,
					query: `late ${suffix}`,
				});
				await accept(harness.lifecycle, harness.encoder, {
					type: "searching",
					callId,
				});
				pending.push(
					harness.encoder.accept(
						harness.lifecycle.accept({
							type: "result",
							callId,
							sources: Object.freeze([
								Object.freeze({
									sourceRef: `${suffix}-source`,
									url: `https://${suffix}.example/source`,
									title: suffix,
									pageAge: null,
								}),
							]),
						}),
					),
				);
			}
			await started;
			const firstAbort = harness.encoder.abort();
			const secondAbort = harness.encoder.abort();
			const settlements = await Promise.all(pending.map(settlementWithin));

			deferred[0]?.resolve("late_resolution_must_be_ignored");
			deferred[1]?.reject(new Error("late rejection must be consumed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(firstAbort).toBe(secondAbort);
			expect(settlements).toEqual(["rejected", "rejected"]);
			expect(unhandled).toEqual([]);
			expectAborted(harness.lifecycle);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("passes a request abort signal to a deferred writer before delivery", async () => {
		let releaseWriter: (() => void) | undefined;
		let writerStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const started = new Promise<void>((resolve) => {
			writerStarted = resolve;
		});
		const delivered: AnthropicServerToolSseEvent[] = [];
		let observedSignal: AbortSignal | undefined;
		const lifecycle = createHostedSearchLifecycleReducer();
		const encoder = createAnthropicServerToolSseEncoder({
			lifecycle,
			replayIssuer: replayIssuer([]),
			replay: Object.freeze({
				physicalModel: "gpt-5.6-sol",
				fidelity: "proof-r17/decoder-r9",
			}),
			base: BASE_CONTEXT,
			writeEvent: async (
				event: AnthropicServerToolSseEvent,
				signal: AbortSignal,
			) => {
				observedSignal = signal;
				writerStarted?.();
				await gate;
				if (signal.aborted) return;
				delivered.push(event);
			},
		});
		const pending = encoder.accept(
			lifecycle.accept({
				type: "declared",
				callId: "srvtoolu_deferred_writer",
			}),
		);
		await started;
		encoder.abort();
		const settlement = await settlementWithin(pending);
		const signalWasAbortedBeforeReturn = observedSignal?.aborted;
		releaseWriter?.();
		await Promise.resolve();

		expect(settlement).toBe("rejected");
		expect(signalWasAbortedBeforeReturn).toBe(true);
		expect(delivered).toEqual([]);
		expectAborted(lifecycle);
	});

	it("aborts a never-resolving JSON observer and consumes its late work", async () => {
		let observerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			observerStarted = resolve;
		});
		const lifecycle = createHostedSearchLifecycleReducer();
		const encoder = createAnthropicServerToolJsonEncoder({
			lifecycle,
			replayIssuer: replayIssuer([]),
			replay: Object.freeze({
				physicalModel: "gpt-5.6-sol",
				fidelity: "proof-r17/decoder-r9",
			}),
			base: BASE_CONTEXT,
			observeJsonSerialization: async (
				_observation: Readonly<{ byteLength: number }>,
				_signal: AbortSignal,
			) => {
				observerStarted?.();
				await new Promise<void>(() => {});
			},
		});
		await accept(lifecycle, encoder, {
			type: "usage_observation",
			webSearchRequests: 0,
		});
		await accept(lifecycle, encoder, {
			type: "terminal",
			reason: "end_turn",
		});
		const pending = encoder.complete(TERMINAL_CONTEXT);
		await started;
		encoder.abort();

		expect(await settlementWithin(pending)).toBe("rejected");
		expectAborted(lifecycle);
	});
});
