import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createHostedSearchLifecycleReducer,
	type HostedSearchLifecycleInput,
} from "../../server-tools/hosted-search-lifecycle";
import {
	CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES,
	CODEX_SERVER_TOOL_RESPONSE_LIMITS,
	CodexServerToolResponseError,
	createCodexServerToolResponseDecoder,
} from "./server-tool-response";

type JsonRecord = Record<string, unknown>;

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/server-tools/${name}`, import.meta.url),
			"utf8",
		),
	);
}

function deterministicRandomBytes(): (length: number) => Uint8Array {
	let call = 0;
	return (length) => {
		call += 1;
		return Uint8Array.from(
			{ length },
			(_, index) => (call * 31 + index) & 0xff,
		);
	};
}

function decoder() {
	return createCodexServerToolResponseDecoder({
		randomBytes: deterministicRandomBytes(),
	});
}

function flattenStream(
	events: readonly unknown[],
): HostedSearchLifecycleInput[] {
	const result: HostedSearchLifecycleInput[] = [];
	const instance = decoder();
	for (const event of events) result.push(...instance.acceptSseEvent(event));
	return result;
}

function assertLifecycleAccepts(
	events: readonly HostedSearchLifecycleInput[],
): void {
	const reducer = createHostedSearchLifecycleReducer();
	for (const event of events) reducer.accept(event);
	expect(reducer.snapshot().status).toBe("terminal");
	expect(reducer.finalize().status).toBe("ready_for_encoding");
}

function searchItem(
	id: string,
	query: string,
	urls: readonly string[],
): JsonRecord {
	return {
		id,
		type: "web_search_call",
		status: "completed",
		action: {
			type: "search",
			query,
			queries: [query],
			sources: urls.map((url) => ({ type: "url", url })),
		},
	};
}

function messageItem(
	id: string,
	text: string,
	annotations: readonly JsonRecord[],
): JsonRecord {
	return {
		id,
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text, annotations }],
	};
}

function completedResponse(output: readonly JsonRecord[]): JsonRecord {
	return { id: "resp_fake", status: "completed", output };
}

function expectContentFreeFailure(
	run: () => unknown,
): CodexServerToolResponseError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(CodexServerToolResponseError);
		expect(JSON.stringify(error)).toBe(
			'{"code":"codex_server_tool_response_invalid"}',
		);
		expect((error as Error).message).toBe(
			"Codex server-tool response decoding failed",
		);
		return error as CodexServerToolResponseError;
	}
	throw new Error("expected content-free decoder failure");
}

describe("Codex native hosted-search response decoder", () => {
	it("decodes official sanitized SSE and JSON fixtures with semantic parity", () => {
		const stream = fixture(
			"official-search-stream.sanitized.json",
		) as unknown[];
		const response = fixture("official-search-response.sanitized.json");
		const streamEvents = flattenStream(stream);
		const jsonEvents = decoder().acceptResponse(response);

		expect(streamEvents).toEqual(jsonEvents);
		expect(streamEvents.map((event) => event.type)).toEqual([
			"declared",
			"dispatched",
			"searching",
			"query_known",
			"result",
			"answer_text_started",
			"citation",
			"answer_text_completed",
			"usage_observation",
			"terminal",
		]);
		const serialized = JSON.stringify(streamEvents);
		expect(serialized).not.toContain("ws_fixture_alpha");
		expect(serialized).not.toContain("msg_fixture_alpha");
		expect(serialized).not.toContain("resp_fixture_alpha");
		expect(serialized).not.toContain("not-authoritative-until-item-done");
		expect(serialized).not.toContain("untrusted-progress.example.test");

		const declared = streamEvents[0] as Extract<
			HostedSearchLifecycleInput,
			{ type: "declared" }
		>;
		expect(declared.callId).toMatch(/^srvtoolu_[A-Za-z0-9_-]{24}$/);
		const result = streamEvents.find(
			(event) => event.type === "result",
		) as Extract<HostedSearchLifecycleInput, { type: "result" }>;
		const queryKnown = streamEvents.find(
			(event) => event.type === "query_known",
		) as Extract<HostedSearchLifecycleInput, { type: "query_known" }>;
		expect(queryKnown).toMatchObject({ queryOrdinal: 0 });
		expect(result).toMatchObject({ queryOrdinal: 0 });
		expect(result.sources.map((source) => source.url)).toEqual([
			"https://docs.example.test/launch",
			"https://status.example.test/archive",
		]);
		const started = streamEvents.find(
			(event) => event.type === "answer_text_started",
		) as Extract<HostedSearchLifecycleInput, { type: "answer_text_started" }>;
		expect(started.blockId).toMatch(/^srvtext_[A-Za-z0-9_-]{24}$/);
		const citation = streamEvents.find(
			(event) => event.type === "citation",
		) as Extract<HostedSearchLifecycleInput, { type: "citation" }>;
		expect(citation).toMatchObject({
			callId: declared.callId,
			blockId: started.blockId,
			sourceRef: "source_0",
			citationOrdinal: 0,
			originalIndex: 0,
			startCharIndex: 4,
			endCharIndex: 13,
		});
		assertLifecycleAccepts(streamEvents);
	});

	it("extracts no query or sources from progress snapshots", () => {
		const stream = fixture(
			"official-search-stream.sanitized.json",
		) as unknown[];
		const instance = decoder();
		expect(instance.acceptSseEvent(stream[0])).toEqual([]);
		const added = instance.acceptSseEvent(stream[1]);
		expect(added.map((event) => event.type)).toEqual([
			"declared",
			"dispatched",
		]);
		expect(JSON.stringify(added)).not.toContain("not-authoritative");
		expect(JSON.stringify(added)).not.toContain("not-evidence");
	});

	it("accepts an item-done-only search and an honest zero result", () => {
		const instance = decoder();
		const doneEvents = instance.acceptSseEvent({
			type: "response.output_item.done",
			sequence_number: 7,
			output_index: 0,
			item: searchItem("ws_done_only", "zero fixture", []),
		});
		expect(doneEvents.map((event) => event.type)).toEqual([
			"declared",
			"dispatched",
			"searching",
			"query_known",
			"result",
		]);
		expect(
			(doneEvents[4] as Extract<HostedSearchLifecycleInput, { type: "result" }>)
				.sources,
		).toEqual([]);
		const terminal = instance.acceptSseEvent({
			type: "response.completed",
			sequence_number: 8,
			response: completedResponse([
				searchItem("ws_done_only", "zero fixture", []),
			]),
		});
		expect(terminal).toEqual([
			{ type: "usage_observation", webSearchRequests: 1 },
			{ type: "terminal", reason: "end_turn" },
		]);
	});

	it("keeps multiple searches distinct and preserves annotation original indices", () => {
		const response = completedResponse([
			searchItem("ws_first", "first", ["https://one.example.test/a"]),
			searchItem("ws_second", "second", ["https://two.example.test/b"]),
			messageItem("msg_multi", "Alpha and beta", [
				{
					type: "file_citation",
					file_id: "file_fake",
					filename: "fake",
					index: 0,
				},
				{
					type: "url_citation",
					start_index: 0,
					end_index: 5,
					title: "One",
					url: "https://one.example.test/a",
				},
				{
					type: "url_citation",
					start_index: 10,
					end_index: 14,
					title: "Two",
					url: "https://two.example.test/b",
				},
			]),
		]);
		const events = decoder().acceptResponse(response);
		const calls = events
			.filter((event) => event.type === "declared")
			.map((event) => event.callId);
		expect(new Set(calls).size).toBe(2);
		const citations = events.filter(
			(
				event,
			): event is Extract<HostedSearchLifecycleInput, { type: "citation" }> =>
				event.type === "citation",
		);
		expect(citations.map((citation) => citation.originalIndex)).toEqual([1, 2]);
		expect(citations.map((citation) => citation.callId)).toEqual(calls);
		expect(citations.map((citation) => citation.citationOrdinal)).toEqual([
			0, 0,
		]);
		assertLifecycleAccepts(events);
	});

	it("assigns citation ordinals per finalized result source", () => {
		const url = "https://one.example.test/a";
		const events = decoder().acceptResponse(
			completedResponse([
				searchItem("ws_one", "one", [url]),
				messageItem("msg_one", "one two", [
					{
						type: "url_citation",
						start_index: 0,
						end_index: 3,
						title: "One",
						url,
					},
					{
						type: "url_citation",
						start_index: 4,
						end_index: 7,
						title: "One again",
						url,
					},
				]),
			]),
		);
		const citations = events.filter(
			(
				event,
			): event is Extract<HostedSearchLifecycleInput, { type: "citation" }> =>
				event.type === "citation",
		);
		expect(citations.map((citation) => citation.sourceRef)).toEqual([
			"source_0",
			"source_0",
		]);
		expect(citations.map((citation) => citation.citationOrdinal)).toEqual([
			0, 1,
		]);
		assertLifecycleAccepts(events);
	});

	it("rejects more native searches than the admitted first-release bound", () => {
		const output = Array.from({ length: 9 }, (_, index) =>
			searchItem(`ws_${index}`, `query ${index}`, []),
		);
		expectContentFreeFailure(() =>
			decoder().acceptResponse(completedResponse(output)),
		);
	});

	it("enforces per-call and aggregate source N/N+1 bounds", () => {
		const urls = (call: number, count: number) =>
			Array.from(
				{ length: count },
				(_, index) => `https://sources.example.test/${call}/${index}`,
			);
		const exactPerCall = decoder().acceptResponse(
			completedResponse([
				searchItem(
					"ws_sources_exact",
					"sources exact",
					urls(0, CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall),
				),
			]),
		);
		const exactResult = exactPerCall.find(
			(event) => event.type === "result",
		) as Extract<HostedSearchLifecycleInput, { type: "result" }>;
		expect(exactResult.sources).toHaveLength(
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall,
		);

		expectContentFreeFailure(() =>
			decoder().acceptResponse(
				completedResponse([
					searchItem(
						"ws_sources_over",
						"sources over",
						urls(1, CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall + 1),
					),
				]),
			),
		);

		const aggregateExact = Array.from({ length: 4 }, (_, call) =>
			searchItem(
				`ws_aggregate_${call}`,
				`aggregate ${call}`,
				urls(call, CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall),
			),
		);
		expect(() =>
			decoder().acceptResponse(completedResponse(aggregateExact)),
		).not.toThrow();
		expectContentFreeFailure(() =>
			decoder().acceptResponse(
				completedResponse([
					...aggregateExact,
					searchItem("ws_aggregate_over", "aggregate over", urls(9, 1)),
				]),
			),
		);
	});

	it("admits only the fixture-backed generic nonsemantic event allowlist", () => {
		const generic = fixture(
			"official-generic-events.sanitized.json",
		) as JsonRecord[];
		expect(
			generic
				.filter((event) =>
					CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES.includes(
						event.type as (typeof CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES)[number],
					),
				)
				.map((event) => event.type),
		).toEqual(CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES);
		const instance = decoder();
		for (const event of generic)
			expect(instance.acceptSseEvent(event)).toEqual([]);
		expectContentFreeFailure(() =>
			instance.acceptSseEvent({
				type: "response.audio.delta",
				sequence_number: generic.length,
				delta: "private-native-data",
			}),
		);
	});

	it("validates item identity for every allowlisted item-scoped family", () => {
		const reasoning = decoder();
		reasoning.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: { id: "reason_one", type: "reasoning" },
		});
		expectContentFreeFailure(() =>
			reasoning.acceptSseEvent({
				type: "response.reasoning_text.delta",
				sequence_number: 1,
				item_id: "reason_other",
				output_index: 0,
				content_index: 0,
				delta: "native-private",
			}),
		);

		const message = decoder();
		message.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: {
				id: "msg_one",
				type: "message",
				status: "in_progress",
				role: "assistant",
				content: [],
			},
		});
		expectContentFreeFailure(() =>
			message.acceptSseEvent({
				type: "response.output_text.delta",
				sequence_number: 1,
				item_id: "msg_one",
				output_index: 1,
				content_index: 0,
				delta: "native-private",
			}),
		);

		const global = decoder();
		expectContentFreeFailure(() =>
			global.acceptSseEvent({
				type: "response.in_progress",
				sequence_number: 0,
				item_id: "native-private",
				output_index: 0,
				response: {},
			}),
		);
	});

	it("poisons and atomically clears every native assembly after parser failure", () => {
		const instance = decoder();
		instance.acceptSseEvent({
			type: "response.output_item.done",
			sequence_number: 0,
			output_index: 0,
			item: searchItem("ws_private", "private query", [
				"https://private.example.test/source",
			]),
		});
		instance.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 1,
			item: {
				id: "msg_private",
				type: "message",
				status: "in_progress",
				role: "assistant",
				content: [],
			},
		});
		instance.acceptSseEvent({
			type: "response.output_text.annotation.added",
			sequence_number: 2,
			output_index: 1,
			content_index: 0,
			annotation_index: 0,
			item_id: "msg_private",
			annotation: {
				type: "url_citation",
				start_index: 0,
				end_index: 1,
				title: "Private title",
				url: "https://private.example.test/source",
			},
		});
		instance.acceptSseEvent({
			type: "response.output_item.done",
			sequence_number: 3,
			output_index: 1,
			item: messageItem("msg_private", "x", [
				{
					type: "url_citation",
					start_index: 0,
					end_index: 1,
					title: "Private title",
					url: "https://private.example.test/source",
				},
			]),
		});
		instance.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 4,
			output_index: 2,
			item: { id: "reason_private", type: "reasoning" },
		});
		expect(instance.snapshot()).toMatchObject({
			status: "open",
			searchCalls: 1,
			messageItems: 1,
			genericOutputs: 1,
			outputItems: 3,
			streamedAnnotations: 1,
		});

		expectContentFreeFailure(() =>
			instance.acceptSseEvent({
				type: "response.web_search_call.private",
				sequence_number: 5,
			}),
		);
		expect(instance.snapshot()).toEqual({
			status: "poisoned",
			searchCalls: 0,
			messageItems: 0,
			genericOutputs: 0,
			outputItems: 0,
			streamedAnnotations: 0,
			retainedBytes: 0,
		});
		expectContentFreeFailure(() =>
			instance.acceptSseEvent({
				type: "response.created",
				sequence_number: 6,
				response: {},
			}),
		);
		expect(instance.snapshot().status).toBe("poisoned");
	});

	it("enforces aggregate message, generic, output, and annotation N/N+1 bounds", () => {
		const messages = decoder();
		for (
			let index = 0;
			index < CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages;
			index += 1
		) {
			const id = `msg_${index}`;
			expect(
				messages.acceptSseEvent({
					type: "response.output_item.added",
					sequence_number: index * 2,
					output_index: index,
					item: {
						id,
						type: "message",
						status: "in_progress",
						role: "assistant",
						content: [],
					},
				}),
			).toEqual([]);
			expect(
				messages.acceptSseEvent({
					type: "response.output_item.done",
					sequence_number: index * 2 + 1,
					output_index: index,
					item: {
						id,
						type: "message",
						status: "completed",
						role: "assistant",
						content: [],
					},
				}),
			).toEqual([]);
		}
		expect(messages.snapshot().messageItems).toBe(
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages,
		);
		expectContentFreeFailure(() =>
			messages.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages * 2,
				output_index: CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages,
				item: {
					id: "msg_over",
					type: "message",
					status: "in_progress",
					role: "assistant",
					content: [],
				},
			}),
		);

		const generic = decoder();
		for (
			let index = 0;
			index < CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs;
			index += 1
		) {
			const id = `reason_${index}`;
			generic.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: index * 2,
				output_index: index,
				item: { id, type: "reasoning" },
			});
			generic.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: index * 2 + 1,
				output_index: index,
				item: { id, type: "reasoning" },
			});
		}
		expect(generic.snapshot().genericOutputs).toBe(
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs,
		);
		expectContentFreeFailure(() =>
			generic.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs * 2,
				output_index: CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs,
				item: { id: "reason_over", type: "reasoning" },
			}),
		);

		const outputs = decoder();
		let outputSequence = 0;
		for (
			let index = 0;
			index < CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages;
			index += 1
		) {
			const id = `output_msg_${index}`;
			outputs.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: outputSequence++,
				output_index: index,
				item: {
					id,
					type: "message",
					status: "in_progress",
					role: "assistant",
					content: [],
				},
			});
			outputs.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: outputSequence++,
				output_index: index,
				item: {
					id,
					type: "message",
					status: "completed",
					role: "assistant",
					content: [],
				},
			});
		}
		for (
			let index = 0;
			index < CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs;
			index += 1
		) {
			const outputIndex = CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages + index;
			const id = `output_reason_${index}`;
			outputs.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: outputSequence++,
				output_index: outputIndex,
				item: { id, type: "reasoning" },
			});
			outputs.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: outputSequence++,
				output_index: outputIndex,
				item: { id, type: "reasoning" },
			});
		}
		expect(outputs.snapshot().outputItems).toBe(
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.outputItems,
		);
		expectContentFreeFailure(() =>
			outputs.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: outputSequence,
				output_index: CODEX_SERVER_TOOL_RESPONSE_LIMITS.outputItems,
				item: searchItem("ws_output_over", "output over", []),
			}),
		);

		const annotations = decoder();
		annotations.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: {
				id: "msg_annotations",
				type: "message",
				status: "in_progress",
				role: "assistant",
				content: [],
			},
		});
		for (
			let index = 0;
			index < CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations;
			index += 1
		) {
			annotations.acceptSseEvent({
				type: "response.output_text.annotation.added",
				sequence_number: index + 1,
				output_index: 0,
				content_index: 0,
				annotation_index: index,
				item_id: "msg_annotations",
				annotation: {
					type: "url_citation",
					start_index: 0,
					end_index: 1,
					title: "Fixture",
					url: "https://fixture.example.test/source",
				},
			});
		}
		expect(annotations.snapshot().streamedAnnotations).toBe(
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations,
		);
		expectContentFreeFailure(() =>
			annotations.acceptSseEvent({
				type: "response.output_text.annotation.added",
				sequence_number: CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations + 1,
				output_index: 0,
				content_index: 0,
				annotation_index: CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations,
				item_id: "msg_annotations",
				annotation: {
					type: "url_citation",
					start_index: 0,
					end_index: 1,
					title: "Fixture",
					url: "https://fixture.example.test/source",
				},
			}),
		);
	});

	it("accepts exactly 1 MiB transient text, rejects N+1, and retains only a digest", () => {
		const prepare = () => {
			const instance = decoder();
			instance.acceptSseEvent({
				type: "response.output_item.added",
				sequence_number: 0,
				output_index: 0,
				item: {
					id: "msg_text",
					type: "message",
					status: "in_progress",
					role: "assistant",
					content: [],
				},
			});
			return instance;
		};

		const exact = prepare();
		const exactTextBytes =
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.retainedBytes -
			exact.snapshot().retainedBytes;
		expect(
			exact.acceptSseEvent({
				type: "response.output_text.done",
				sequence_number: 1,
				output_index: 0,
				content_index: 0,
				item_id: "msg_text",
				text: "x".repeat(exactTextBytes),
			}),
		).toEqual([]);
		expect(exact.snapshot().retainedBytes).toBeLessThan(1024);

		const over = prepare();
		const overTextBytes =
			CODEX_SERVER_TOOL_RESPONSE_LIMITS.retainedBytes -
			over.snapshot().retainedBytes +
			1;
		expectContentFreeFailure(() =>
			over.acceptSseEvent({
				type: "response.output_text.done",
				sequence_number: 1,
				output_index: 0,
				content_index: 0,
				item_id: "msg_text",
				text: "x".repeat(overTextBytes),
			}),
		);
		expect(over.snapshot().retainedBytes).toBe(0);
	});

	it("uses compact identities without accepting terminal semantic drift", () => {
		const search = decoder();
		search.acceptSseEvent({
			type: "response.output_item.done",
			sequence_number: 0,
			output_index: 0,
			item: searchItem("ws_digest", "original query", []),
		});
		expectContentFreeFailure(() =>
			search.acceptSseEvent({
				type: "response.completed",
				sequence_number: 1,
				response: completedResponse([
					searchItem("ws_digest", "changed query", []),
				]),
			}),
		);

		const message = decoder();
		message.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: {
				id: "msg_digest",
				type: "message",
				status: "in_progress",
				role: "assistant",
				content: [],
			},
		});
		message.acceptSseEvent({
			type: "response.output_text.done",
			sequence_number: 1,
			output_index: 0,
			content_index: 0,
			item_id: "msg_digest",
			text: "original text",
		});
		expectContentFreeFailure(() =>
			message.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: 2,
				output_index: 0,
				item: messageItem("msg_digest", "changed text", []),
			}),
		);
	});

	it("keeps SSE opaque-ID order equal to JSON and rejects reversed or gapped first-seen output", () => {
		const output = [
			searchItem("ws_first", "first", []),
			searchItem("ws_second", "second", []),
		];
		const streamDecoder = decoder();
		const streamEvents = [
			...streamDecoder.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: 0,
				output_index: 0,
				item: output[0],
			}),
			...streamDecoder.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: 1,
				output_index: 1,
				item: output[1],
			}),
			...streamDecoder.acceptSseEvent({
				type: "response.completed",
				sequence_number: 2,
				response: completedResponse(output),
			}),
		];
		expect(streamEvents).toEqual(
			decoder().acceptResponse(completedResponse(output)),
		);

		const reversed = decoder();
		expectContentFreeFailure(() =>
			reversed.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: 0,
				output_index: 1,
				item: output[1],
			}),
		);

		const gapped = decoder();
		gapped.acceptSseEvent({
			type: "response.output_item.done",
			sequence_number: 0,
			output_index: 0,
			item: output[0],
		});
		expectContentFreeFailure(() =>
			gapped.acceptSseEvent({
				type: "response.output_item.done",
				sequence_number: 1,
				output_index: 2,
				item: output[1],
			}),
		);
	});

	it("rejects added(0), added(1), done(1) overlap before it can reorder semantics", () => {
		const instance = decoder();
		const overlappingSequence = [
			{
				type: "response.output_item.added",
				sequence_number: 0,
				output_index: 0,
				item: {
					id: "ws_overlap_zero",
					type: "web_search_call",
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 1,
				item: {
					id: "ws_overlap_one",
					type: "web_search_call",
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				sequence_number: 2,
				output_index: 1,
				item: searchItem("ws_overlap_one", "overlap one", []),
			},
		];
		expectContentFreeFailure(() => {
			for (const event of overlappingSequence) instance.acceptSseEvent(event);
		});
		expect(instance.snapshot().status).toBe("poisoned");
	});

	it("keeps sequential added/progress/done SSE semantics equal to JSON", () => {
		const output = [
			searchItem("ws_sequential_zero", "sequential zero", []),
			searchItem("ws_sequential_one", "sequential one", []),
		];
		const stream: JsonRecord[] = [];
		let sequenceNumber = 0;
		for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
			const item = output[outputIndex] as JsonRecord;
			const itemId = item.id as string;
			stream.push(
				{
					type: "response.output_item.added",
					sequence_number: sequenceNumber++,
					output_index: outputIndex,
					item: {
						id: itemId,
						type: "web_search_call",
						status: "in_progress",
					},
				},
				{
					type: "response.web_search_call.in_progress",
					sequence_number: sequenceNumber++,
					output_index: outputIndex,
					item_id: itemId,
				},
				{
					type: "response.web_search_call.searching",
					sequence_number: sequenceNumber++,
					output_index: outputIndex,
					item_id: itemId,
				},
				{
					type: "response.web_search_call.completed",
					sequence_number: sequenceNumber++,
					output_index: outputIndex,
					item_id: itemId,
				},
				{
					type: "response.output_item.done",
					sequence_number: sequenceNumber++,
					output_index: outputIndex,
					item,
				},
			);
		}
		stream.push({
			type: "response.completed",
			sequence_number: sequenceNumber,
			response: completedResponse(output),
		});

		const streamEvents = flattenStream(stream);
		const responseEvents = decoder().acceptResponse(completedResponse(output));
		expect(streamEvents).toEqual(responseEvents);
		assertLifecycleAccepts(streamEvents);
	});

	it.each([
		["open_page", { type: "open_page", url: "https://one.example.test/a" }],
		[
			"find_in_page",
			{
				type: "find_in_page",
				url: "https://one.example.test/a",
				pattern: "fixture",
			},
		],
		[
			"multiple queries",
			{
				type: "search",
				query: "first",
				queries: ["first", "second"],
				sources: [],
			},
		],
		["missing query", { type: "search", sources: [] }],
		["missing sources", { type: "search", query: "fixture" }],
		[
			"malformed source",
			{
				type: "search",
				query: "fixture",
				sources: [{ type: "url", url: "https://user@example.test/a" }],
			},
		],
	])("rejects unsupported complete action: %s", (_label, action) => {
		const item = searchItem("ws_private", "fixture", []);
		item.action = action;
		expectContentFreeFailure(() =>
			decoder().acceptResponse(completedResponse([item])),
		);
	});

	it("rejects unknown hosted events, duplicates, and out-of-order identities", () => {
		expectContentFreeFailure(() =>
			decoder().acceptSseEvent({
				type: "response.web_search_call.private",
				sequence_number: 0,
				item_id: "native-private-id",
			}),
		);

		const instance = decoder();
		const added = {
			type: "response.output_item.added",
			sequence_number: 2,
			output_index: 0,
			item: {
				id: "ws_private",
				type: "web_search_call",
				status: "in_progress",
				action: { type: "search", query: "private", sources: [] },
			},
		};
		instance.acceptSseEvent(added);
		expectContentFreeFailure(() => instance.acceptSseEvent(added));

		const other = decoder();
		expectContentFreeFailure(() =>
			other.acceptSseEvent({
				type: "response.web_search_call.searching",
				sequence_number: 0,
				output_index: 0,
				item_id: "ws_never_added",
			}),
		);

		const duplicateDone = decoder();
		const done = {
			type: "response.output_item.done",
			sequence_number: 0,
			output_index: 0,
			item: searchItem("ws_done", "done", []),
		};
		duplicateDone.acceptSseEvent(done);
		expectContentFreeFailure(() =>
			duplicateDone.acceptSseEvent({ ...done, sequence_number: 1 }),
		);
	});

	it("rejects unproved fields in complete hosted evidence", () => {
		const search = searchItem("ws_future", "future", []);
		(search.action as JsonRecord).future_semantic = "native-private-value";
		expectContentFreeFailure(() =>
			decoder().acceptResponse(completedResponse([search])),
		);

		const url = "https://one.example.test/a";
		const annotation = {
			type: "url_citation",
			start_index: 0,
			end_index: 3,
			title: "One",
			url,
			future_semantic: "native-private-value",
		};
		expectContentFreeFailure(() =>
			decoder().acceptResponse(
				completedResponse([
					searchItem("ws_one", "one", [url]),
					messageItem("msg_one", "one", [annotation]),
				]),
			),
		);
	});

	it("rejects unresolved normal terminals", () => {
		const instance = decoder();
		instance.acceptSseEvent({
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: {
				id: "ws_unresolved",
				type: "web_search_call",
				status: "in_progress",
				action: { type: "search", query: "private", sources: [] },
			},
		});
		expectContentFreeFailure(() =>
			instance.acceptSseEvent({
				type: "response.completed",
				sequence_number: 1,
				response: completedResponse([]),
			}),
		);
	});

	it("emits lifecycle-complete usage for resolved failed terminals", () => {
		const events = decoder().acceptResponse({
			id: "resp_failed",
			status: "failed",
			output: [],
			error: { message: "native-private-error" },
		});
		expect(events).toEqual([
			{ type: "usage_observation", webSearchRequests: 0 },
			{ type: "terminal", reason: "error" },
		]);
		assertLifecycleAccepts(events);

		const sseEvents = decoder().acceptSseEvent({
			type: "error",
			sequence_number: 0,
			error: { message: "native-private-error" },
		});
		expect(sseEvents).toEqual(events);
		assertLifecycleAccepts(sseEvents);
	});

	it("maps a resolved incomplete Response JSON terminal without inventing usage", () => {
		const events = decoder().acceptResponse({
			id: "resp_incomplete",
			status: "incomplete",
			output: [],
			incomplete_details: { reason: "max_output_tokens" },
		});
		expect(events).toEqual([
			{ type: "usage_observation", webSearchRequests: 0 },
			{ type: "terminal", reason: "max_tokens" },
		]);
		assertLifecycleAccepts(events);
	});

	it("rejects ambiguous cross-call citation matches", () => {
		const shared = "https://shared.example.test/a";
		const response = completedResponse([
			searchItem("ws_first", "first", [shared]),
			searchItem("ws_second", "second", [shared]),
			messageItem("msg_ambiguous", "shared", [
				{
					type: "url_citation",
					start_index: 0,
					end_index: 6,
					title: "Shared",
					url: shared,
				},
			]),
		]);
		expectContentFreeFailure(() => decoder().acceptResponse(response));
	});

	it.each([
		[
			"unknown annotation",
			{ type: "private_annotation", private: "native-secret" },
		],
		[
			"missing title",
			{
				type: "url_citation",
				start_index: 0,
				end_index: 4,
				url: "https://one.example.test/a",
			},
		],
		[
			"split surrogate offset",
			{
				type: "url_citation",
				start_index: 1,
				end_index: 3,
				title: "One",
				url: "https://one.example.test/a",
			},
		],
	])("rejects malformed annotations: %s", (_label, annotation) => {
		const response = completedResponse([
			searchItem("ws_one", "one", ["https://one.example.test/a"]),
			messageItem("msg_one", "🚀 ok", [annotation]),
		]);
		expectContentFreeFailure(() => decoder().acceptResponse(response));
	});

	it("normalizes hostile reflection and random-source failures without content", () => {
		const hostile = Object.create(null) as JsonRecord;
		Object.defineProperty(hostile, "type", {
			get() {
				throw new Error("native-private-getter-value");
			},
		});
		expectContentFreeFailure(() => decoder().acceptSseEvent(hostile));

		expectContentFreeFailure(() =>
			createCodexServerToolResponseDecoder({
				randomBytes() {
					throw new Error("random-private-failure");
				},
			}).acceptResponse(
				completedResponse([searchItem("ws_private", "private-query", [])]),
			),
		);
	});

	it("aborts idempotently before data and permanently rejects later input", () => {
		const instance = decoder();
		const first = instance.abort();
		const second = instance.abort();

		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first).toEqual({
			status: "aborted",
			searchCalls: 0,
			messageItems: 0,
			genericOutputs: 0,
			outputItems: 0,
			streamedAnnotations: 0,
			retainedBytes: 0,
		});
		expectContentFreeFailure(() =>
			instance.acceptSseEvent({
				type: "response.created",
				sequence_number: 0,
			}),
		);
		expectContentFreeFailure(() =>
			instance.acceptResponse(completedResponse([])),
		);
		expect(instance.snapshot()).toBe(first);
	});

	it.each([
		["native item", 1],
		["message text and annotation", 7],
	] as const)("releases every retained buffer when aborted mid %s", (_label, end) => {
		const stream = fixture(
			"official-search-stream.sanitized.json",
		) as unknown[];
		const instance = decoder();
		for (const event of stream.slice(0, end + 1)) {
			instance.acceptSseEvent(event);
		}
		expect(instance.snapshot().retainedBytes).toBeGreaterThan(0);

		const aborted = instance.abort();
		expect(aborted).toMatchObject({
			status: "aborted",
			searchCalls: 0,
			messageItems: 0,
			genericOutputs: 0,
			outputItems: 0,
			streamedAnnotations: 0,
			retainedBytes: 0,
		});
		expectContentFreeFailure(() => instance.acceptSseEvent(stream[end + 1]));
		expect(instance.abort()).toBe(aborted);
	});

	it("can be aborted safely after a normal terminal", () => {
		const instance = decoder();
		instance.acceptResponse(completedResponse([]));
		expect(instance.snapshot().status).toBe("terminal");
		expect(instance.abort()).toEqual({
			status: "aborted",
			searchCalls: 0,
			messageItems: 0,
			genericOutputs: 0,
			outputItems: 0,
			streamedAnnotations: 0,
			retainedBytes: 0,
		});
	});
});

describe("opaque id shape (issue #149)", () => {
	// base64url's alphabet ends in '-' (62) and '_' (63), but PUBLIC_CALL_ID in
	// server-tools/hosted-search-lifecycle.ts requires the character right after
	// the prefix to be alphanumeric. Before the fix, a leading '-'/'_' minted an
	// id that failed its own downstream validation on ~2/64 of draws, surfacing
	// as "Codex server-tool response decoding failed" for the entire response
	// (and as an intermittent CI failure). The mint-side retry loop re-drew only
	// on duplicate ids, never on a bad shape.

	// base64url takes the top 6 bits of byte 0 for the first output character.
	function firstByteFor(sextet: number): number {
		return (sextet << 2) & 0xff;
	}

	function riggedRandomBytes(
		leadingSextets: readonly number[],
	): (length: number) => Uint8Array {
		let call = 0;
		return (length) => {
			const sextet = leadingSextets[call] ?? 0;
			call += 1;
			const bytes = Uint8Array.from(
				{ length },
				(_, index) => (call * 31 + index) & 0xff,
			);
			bytes[0] = firstByteFor(sextet);
			return bytes;
		};
	}

	function declaredCallId(randomBytes: (length: number) => Uint8Array): string {
		const stream = fixture(
			"official-search-stream.sanitized.json",
		) as unknown[];
		const instance = createCodexServerToolResponseDecoder({ randomBytes });
		const events: HostedSearchLifecycleInput[] = [];
		for (const event of stream) events.push(...instance.acceptSseEvent(event));
		const declared = events.find((event) => event.type === "declared") as
			| Extract<HostedSearchLifecycleInput, { type: "declared" }>
			| undefined;
		if (!declared) throw new Error("expected a declared hosted-search call");
		return declared.callId;
	}

	it("re-draws instead of minting a call id that fails PUBLIC_CALL_ID", () => {
		// First draw yields '-', second '_', third an alphanumeric character.
		const callId = declaredCallId(riggedRandomBytes([62, 63, 0]));
		expect(callId).toMatch(/^srvtoolu_[A-Za-z0-9][A-Za-z0-9_-]*$/u);
	});

	it("keeps an alphanumeric leading character on the first draw", () => {
		const callId = declaredCallId(riggedRandomBytes([0]));
		expect(callId).toMatch(/^srvtoolu_A/u);
	});
});
