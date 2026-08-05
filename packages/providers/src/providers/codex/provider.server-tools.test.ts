import { describe, expect, test } from "bun:test";
import { encodeCodexWebSocketSseEvent } from "../../../../proxy/src/codex-websocket-wire";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PROMPT_CACHE_KEY_ENV,
	CodexProvider,
} from "./provider";
import {
	canonicalizeServerToolCharacterization,
	type ServerToolCharacterizationObserver,
	type ServerToolCharacterizationRecord,
	type ServerToolCharacterizationValue,
} from "./server-tool-characterization";

const PRIVATE_SENTINEL = "private-query-never-record-this";
const LARGE_INSTRUCTION_SENTINEL = "large-private-instruction-sentinel";
const PRIVATE_SCHEMA_SENTINEL = "privateStructuredResultSentinel";

function anthropicRequest(stream = true): Request {
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 64,
			stream,
			messages: [{ role: "user", content: PRIVATE_SENTINEL }],
		}),
	});
}

function promptCachedAnthropicRequest(): Request {
	return new Request(CODEX_DEFAULT_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 64,
			stream: true,
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			messages: [{ role: "user", content: PRIVATE_SENTINEL }],
		}),
	});
}

function boundaryAnthropicRequest(): Request {
	const tools = Array.from({ length: 145 }, (_, index) => {
		if (index === 0) {
			return {
				name: "StructuredOutput",
				description: "Return the validated payload.",
				input_schema: {
					type: "object",
					additionalProperties: false,
					$defs: {
						[PRIVATE_SCHEMA_SENTINEL]: {
							type: "object",
							additionalProperties: false,
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					},
					properties: {
						result: { $ref: `#/$defs/${PRIVATE_SCHEMA_SENTINEL}` },
					},
					required: ["result"],
				},
			};
		}
		return {
			name: `OrdinaryFunction${index}`,
			description: `private-description-${index}`,
			input_schema: {
				type: "object",
				additionalProperties: false,
				properties: { value: { type: "string" } },
				required: ["value"],
			},
		};
	});
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 64,
			stream: true,
			system: LARGE_INSTRUCTION_SENTINEL.repeat(180),
			messages: [{ role: "user", content: PRIVATE_SENTINEL }],
			tools,
		}),
	});
}

function aliasHeavyAnthropicRequest(prefix: string): Request {
	const tools = Array.from({ length: 64 }, (_, index) => ({
		name: `${prefix}-tool-${index}`,
		description: `private-${prefix}-description-${index}`,
		input_schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				[`${prefix}PrivateField${index}`]: { type: "string" },
			},
		},
	}));
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 64,
			stream: true,
			messages: [{ role: "user", content: PRIVATE_SENTINEL }],
			tools,
		}),
	});
}

function eventFrame(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

const UNKNOWN_NATIVE_EVENT = "response.web_search_call.searching";
const UNKNOWN_NATIVE_DATA = {
	type: UNKNOWN_NATIVE_EVENT,
	event: "response.embedded.mismatch",
	item_id: "web-search-call-private-id",
	query: PRIVATE_SENTINEL,
};
const COMPLETED_DATA = {
	type: "response.completed",
	response: {
		id: "response-private-id",
		model: "gpt-5.4",
		status: "completed",
		usage: {
			input_tokens: 150,
			output_tokens: 33,
			total_tokens: 183,
			input_tokens_details: {
				cached_tokens: 40,
				cache_write_tokens: 9,
				cache_creation_input_tokens: 7,
			},
			output_tokens_details: {
				reasoning_tokens: 11,
			},
		},
	},
};
const CREATED_DATA = {
	type: "response.created",
	response: {
		id: "response-private-id",
		model: "gpt-5.4",
		status: "in_progress",
	},
};

function serverToolFrames(): string {
	return [
		eventFrame("response.created", CREATED_DATA),
		eventFrame(UNKNOWN_NATIVE_EVENT, UNKNOWN_NATIVE_DATA),
		eventFrame("response.completed", COMPLETED_DATA),
	].join("");
}

function webSocketRewrappedServerToolFrames(): string {
	const decoder = new TextDecoder();
	return [
		encodeCodexWebSocketSseEvent("response.created", CREATED_DATA),
		encodeCodexWebSocketSseEvent(UNKNOWN_NATIVE_EVENT, UNKNOWN_NATIVE_DATA),
		encodeCodexWebSocketSseEvent("response.completed", COMPLETED_DATA),
	]
		.map((frame) => decoder.decode(frame))
		.join("");
}

async function processSse(
	provider: CodexProvider,
	frames: string,
	requestedStream = true,
): Promise<string> {
	const response = new Response(frames, {
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-stream": requestedStream ? "true" : "false",
		},
	});
	return (await provider.processResponse(response, null)).text();
}

function captureRecords(): {
	records: ServerToolCharacterizationRecord[];
	observer: ServerToolCharacterizationObserver;
} {
	const records: ServerToolCharacterizationRecord[] = [];
	return {
		records,
		observer(record) {
			records.push(record);
		},
	};
}

function upstreamRecords(
	records: readonly ServerToolCharacterizationRecord[],
): ServerToolCharacterizationRecord[] {
	return records.filter((record) => record.kind === "upstream_event");
}

function asCharacterizationObject(
	value: ServerToolCharacterizationValue | undefined,
): Readonly<Record<string, ServerToolCharacterizationValue>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected a characterization object");
	}
	return value;
}

describe("CodexProvider server-tool characterization seam", () => {
	test("an absent observer preserves exact outbound bytes", async () => {
		const baseline = await new CodexProvider().transformRequestBody(
			anthropicRequest(),
		);
		const explicitlyAbsent = await new CodexProvider({
			characterizationObserver: undefined,
		}).transformRequestBody(anthropicRequest());

		expect(await explicitlyAbsent.text()).toBe(await baseline.text());
	});

	test("observes the final outbound shape once without retaining private content", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});
		const transformed = await provider.transformRequestBody(anthropicRequest());
		const outbound = capture.records.filter(
			(record) => record.kind === "outbound_request",
		);

		expect(outbound).toHaveLength(1);
		expect(JSON.stringify(outbound[0])).not.toContain(PRIVATE_SENTINEL);
		expect((await transformed.json()).stream).toBe(true);
	});

	test("observes a bounded 145-tool StructuredOutput envelope without changing bytes", async () => {
		const baseline = await new CodexProvider().transformRequestBody(
			boundaryAnthropicRequest(),
		);
		const capture = captureRecords();
		const observed = await new CodexProvider({
			characterizationObserver: capture.observer,
		}).transformRequestBody(boundaryAnthropicRequest());
		const baselineText = await baseline.text();
		const observedText = await observed.text();

		expect(observedText).toBe(baselineText);
		const wireBody = JSON.parse(observedText) as {
			tool_choice?: { name?: string };
			tools?: unknown[];
		};
		expect(wireBody.tools).toHaveLength(145);
		expect(wireBody.tool_choice?.name).toBe("StructuredOutput");
		const outbound = capture.records.filter(
			(record) => record.kind === "outbound_request",
		);
		expect(outbound).toHaveLength(1);
		const canonical = canonicalizeServerToolCharacterization(outbound[0]!);
		expect(canonical).not.toBeNull();
		expect(canonical).toContain('"type":"truncated"');
		expect(canonical).toContain('"additionalProperties":false');
		expect(canonical).toContain('"$defs"');
		expect(canonical).toContain('"$ref"');
		for (const sentinel of [
			PRIVATE_SENTINEL,
			LARGE_INSTRUCTION_SENTINEL,
			PRIVATE_SCHEMA_SENTINEL,
			"private-description-",
		]) {
			expect(canonical).not.toContain(sentinel);
		}
	});

	test("retains only safe prompt-cache-key presence and length facts", async () => {
		const previousPromptCacheSetting = process.env[CODEX_PROMPT_CACHE_KEY_ENV];
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		try {
			const capture = captureRecords();
			const provider = new CodexProvider({
				characterizationObserver: capture.observer,
			});
			const transformed = await provider.transformRequestBody(
				promptCachedAnthropicRequest(),
			);
			const wireBody = (await transformed.json()) as {
				prompt_cache_key?: string;
			};
			const rawPromptCacheKey = wireBody.prompt_cache_key;
			if (!rawPromptCacheKey) {
				throw new Error("provider did not produce a prompt cache key");
			}
			const outbound = capture.records.filter(
				(record) => record.kind === "outbound_request",
			);

			expect(outbound).toHaveLength(1);
			expect(outbound[0]?.data.prompt_cache_key).toEqual({
				type: "string",
				utf8_bytes: new TextEncoder().encode(rawPromptCacheKey).byteLength,
			});
			expect(JSON.stringify(outbound[0])).not.toContain(rawPromptCacheKey);
		} finally {
			if (previousPromptCacheSetting === undefined) {
				delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
			} else {
				process.env[CODEX_PROMPT_CACHE_KEY_ENV] = previousPromptCacheSetting;
			}
		}
	});

	test("observes safe response metadata without reading the response body", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("downstream-body"));
				controller.close();
			},
		});
		const response = new Response(body, {
			status: 418,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"x-codex-turn-state": "private-turn-state",
			},
		});

		await provider.processResponse(response, null);

		expect(response.bodyUsed).toBe(false);
		expect(capture.records).toContainEqual({
			kind: "response_metadata",
			data: {
				status: 418,
				ok: false,
				body_present: true,
				requested_stream: true,
				content_type_class: "json",
				turn_state_present: true,
			},
		});
		expect(JSON.stringify(capture.records)).not.toContain("private-turn-state");
	});

	test("observes an unknown native event before the decoder drops it", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});

		await processSse(provider, serverToolFrames());

		const raw = upstreamRecords(capture.records).find(
			(record) => record.data.event === UNKNOWN_NATIVE_EVENT,
		);
		expect(raw).toBeDefined();
		expect(raw?.data.data).toBeDefined();
		expect(JSON.stringify(raw)).not.toContain(PRIVATE_SENTINEL);
		expect(JSON.stringify(raw)).not.toContain("web-search-call-private-id");
	});

	test("retains exact terminal usage counters for reconciliation", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});

		await processSse(provider, serverToolFrames());

		const terminal = upstreamRecords(capture.records).filter(
			(record) => record.data.event === "response.completed",
		);
		expect(terminal).toHaveLength(1);
		const terminalData = asCharacterizationObject(terminal[0]?.data.data);
		const response = asCharacterizationObject(terminalData.response);
		const usage = asCharacterizationObject(response.usage);
		expect(usage).toEqual(COMPLETED_DATA.response.usage);
	});

	test("does not observe malformed JSON or DONE sentinels as raw events", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});
		const malformedAndDone = [
			eventFrame(UNKNOWN_NATIVE_EVENT, "{not-json"),
			eventFrame(UNKNOWN_NATIVE_EVENT, "[DONE]"),
		].join("");

		await processSse(provider, malformedAndDone);

		expect(upstreamRecords(capture.records)).toEqual([]);
	});

	test("stream:false observes each upstream event only once", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});

		await processSse(provider, serverToolFrames(), false);

		expect(
			upstreamRecords(capture.records).filter(
				(record) => record.data.event === UNKNOWN_NATIVE_EVENT,
			),
		).toHaveLength(1);
		expect(
			capture.records.filter((record) => record.kind === "response_metadata"),
		).toHaveLength(1);
	});

	test("a throwing and mutating observer cannot alter outbound or downstream bytes", async () => {
		const hostileObserver: ServerToolCharacterizationObserver = (record) => {
			Reflect.set(record.data, "model", "mutated");
			throw new Error("observer failure");
		};
		const baselineOutbound = await new CodexProvider().transformRequestBody(
			anthropicRequest(),
		);
		const hostileOutbound = await new CodexProvider({
			characterizationObserver: hostileObserver,
		}).transformRequestBody(anthropicRequest());

		expect(await hostileOutbound.text()).toBe(await baselineOutbound.text());

		const baselineDownstream = await processSse(
			new CodexProvider(),
			serverToolFrames(),
		);
		const hostileDownstream = await processSse(
			new CodexProvider({ characterizationObserver: hostileObserver }),
			serverToolFrames(),
		);
		expect(hostileDownstream).toBe(baselineDownstream);
	});

	test("checks the test-only observation gate before sanitizer alias allocation", async () => {
		const capture = captureRecords();
		let suppressMarkerOutbound = true;
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
			characterizationObservationGate(kind) {
				return !(suppressMarkerOutbound && kind === "outbound_request");
			},
		});

		for (let index = 0; index < 8; index += 1) {
			await provider.transformRequestBody(
				aliasHeavyAnthropicRequest(`marker-${index}`),
			);
		}
		expect(
			capture.records.filter((record) => record.kind === "outbound_request"),
		).toEqual([]);

		suppressMarkerOutbound = false;
		await provider.transformRequestBody(anthropicRequest());
		const finalOutbound = capture.records.filter(
			(record) => record.kind === "outbound_request",
		);
		expect(finalOutbound).toHaveLength(1);
		expect(finalOutbound[0]?.data.model).toMatch(/^label-[0-9]+$/);
		await processSse(provider, serverToolFrames());
		const raw = upstreamRecords(capture.records).find(
			(record) => record.data.event === UNKNOWN_NATIVE_EVENT,
		);
		expect(raw).toBeDefined();
		const rawData = asCharacterizationObject(raw?.data.data);
		expect(rawData.item_id).toMatch(/^id-[0-9]+$/);
	});

	test("a throwing observation gate remains invisible to provider bytes", async () => {
		let observerCalls = 0;
		const baseline = await new CodexProvider().transformRequestBody(
			anthropicRequest(),
		);
		const gated = await new CodexProvider({
			characterizationObserver: () => {
				observerCalls += 1;
			},
			characterizationObservationGate() {
				throw new Error("injected gate failure");
			},
		}).transformRequestBody(anthropicRequest());

		expect(await gated.text()).toBe(await baseline.text());
		expect(observerCalls).toBe(0);
	});

	test("uses the existing lazy stream reader without an extra read or tee", async () => {
		const capture = captureRecords();
		const provider = new CodexProvider({
			characterizationObserver: capture.observer,
		});
		const response = new Response(serverToolFrames(), {
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "true",
			},
		});
		const body = response.body;
		if (!body) throw new Error("test response is missing its body");
		let getReaderCalls = 0;
		let teeCalls = 0;
		const originalGetReader = body.getReader.bind(body);
		const originalTee = body.tee.bind(body);
		Object.defineProperty(body, "getReader", {
			configurable: true,
			value: () => {
				getReaderCalls++;
				return originalGetReader();
			},
		});
		Object.defineProperty(body, "tee", {
			configurable: true,
			value: () => {
				teeCalls++;
				return originalTee();
			},
		});

		await (await provider.processResponse(response, null)).text();

		expect(getReaderCalls).toBe(1);
		expect(teeCalls).toBe(0);
	});

	test("HTTP SSE and the production WebSocket frame encoder expose the same sanitized event facts", async () => {
		const http = captureRecords();
		const websocket = captureRecords();

		await processSse(
			new CodexProvider({ characterizationObserver: http.observer }),
			serverToolFrames(),
		);
		// Exercise the encoder called by CodexWebSocketTransport after it parses a
		// native WebSocket frame. Socket lifecycle coverage remains in proxy tests.
		await processSse(
			new CodexProvider({ characterizationObserver: websocket.observer }),
			webSocketRewrappedServerToolFrames(),
		);

		expect(upstreamRecords(http.records).length).toBeGreaterThan(0);
		expect(upstreamRecords(websocket.records)).toEqual(
			upstreamRecords(http.records),
		);
	});
});
