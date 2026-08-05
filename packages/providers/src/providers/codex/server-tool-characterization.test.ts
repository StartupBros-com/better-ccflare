import { describe, expect, it } from "bun:test";
import {
	CHARACTERIZATION_LIMITS,
	canonicalizeServerToolCharacterization,
	createServerToolCharacterizationSanitizer,
	emitServerToolCharacterization,
	type ServerToolCharacterizationRecord,
	sanitizeServerToolCharacterization,
} from "./server-tool-characterization";

function expectDeepFrozen(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	expect(Object.isFrozen(value)).toBe(true);
	for (const child of Object.values(value)) expectDeepFrozen(child);
}

function countJsonNodes(value: unknown): number {
	if (value === null || typeof value !== "object") return 1;
	let nodes = 1;
	for (const child of Array.isArray(value) ? value : Object.values(value)) {
		nodes += countJsonNodes(child);
	}
	return nodes;
}

describe("server-tool characterization sanitizer", () => {
	it("produces deterministic canonical JSON without retaining content", () => {
		const first = sanitizeServerToolCharacterization("outbound_request", {
			status: "completed",
			model: "gpt-5-codex",
			prompt: "PROMPT_SENTINEL",
			type: "message",
			role: "user",
			event: "response.created",
		});

		const second = sanitizeServerToolCharacterization("outbound_request", {
			event: "response.created",
			role: "user",
			type: "message",
			prompt: "PROMPT_SENTINEL",
			model: "gpt-5-codex",
			status: "completed",
		});

		expect(first).not.toBeNull();
		expect(canonicalizeServerToolCharacterization(first!)).toBe(
			canonicalizeServerToolCharacterization(second!),
		);
		expect(canonicalizeServerToolCharacterization(first!)).toBe(
			'{"data":{"event":"response.created","model":"gpt-5-codex","prompt":{"type":"string","utf8_bytes":15},"role":"user","status":"completed","type":"message"},"kind":"outbound_request"}',
		);
		expect(canonicalizeServerToolCharacterization(first!)).not.toContain(
			"PROMPT_SENTINEL",
		);
		expectDeepFrozen(first);
	});

	it("keeps aliases linked across records in one bounded capture context", () => {
		const capture = createServerToolCharacterizationSanitizer();
		const outbound = capture.sanitize("outbound_request", {
			id: "SHARED_CALL_ID",
			name: "SHARED_USER_TOOL",
			url: "https://shared.private.example/path",
		});
		const event = capture.sanitize("upstream_event", {
			call_id: "SHARED_CALL_ID",
			id: "DISTINCT_CALL_ID",
			name: "SHARED_USER_TOOL",
			source_url: "https://distinct.private.example/path",
			url: "https://shared.private.example/path",
		});

		expect(outbound?.data).toEqual({
			id: "id-1",
			name: "tool-1",
			url: "https://source-1.example/",
		});
		expect(event?.data).toEqual({
			call_id: "id-1",
			id: "id-2",
			name: "tool-1",
			source_url: "https://source-2.example/",
			url: "https://source-1.example/",
		});
		expect(capture.canonicalize(event!)).toContain('"id":"id-2"');
		const serialized = `${capture.canonicalize(outbound!)}${capture.canonicalize(
			event!,
		)}`;
		for (const raw of [
			"SHARED_CALL_ID",
			"DISTINCT_CALL_ID",
			"SHARED_USER_TOOL",
			"shared.private.example",
			"distinct.private.example",
		]) {
			expect(serialized).not.toContain(raw);
		}
	});

	it("links repeated identifiers, tool names, and URLs through deterministic aliases", () => {
		const record = sanitizeServerToolCharacterization("upstream_event", {
			call_id: "CALL_SECRET_9000",
			item: {
				id: "CALL_SECRET_9000",
				name: "USER_TOOL_SECRET",
				type: "web_search_call",
				url: "https://private.example/path?q=secret",
			},
			other_name: "USER_TOOL_SECRET",
			related_id: "SECOND_ID_SECRET",
			source_url: "https://private.example/path?q=secret",
			tool_kind: "web_search",
		});

		expect(record).toEqual({
			kind: "upstream_event",
			data: {
				call_id: "id-1",
				item: {
					id: "id-1",
					name: "tool-1",
					type: "web_search_call",
					url: "https://source-1.example/",
				},
				other_name: "tool-1",
				related_id: "id-2",
				source_url: "https://source-1.example/",
				tool_kind: "web_search",
			},
		});
		const serialized = canonicalizeServerToolCharacterization(record!);
		for (const raw of [
			"CALL_SECRET_9000",
			"SECOND_ID_SECRET",
			"USER_TOOL_SECRET",
			"private.example",
			"?q=secret",
		]) {
			expect(serialized).not.toContain(raw);
		}
	});

	it("replaces every content-bearing string with type and UTF-8 length metadata", () => {
		const raw = {
			arguments: '{"secret":"ARGUMENT_SENTINEL"}',
			body: "BODY_SENTINEL",
			content: "CONTENT_SENTINEL",
			error: "ERROR_SENTINEL",
			query: "QUERY_SENTINEL",
			text: "TEXT_SENTINEL_😀",
			title: "TITLE_SENTINEL",
		};
		const record = sanitizeServerToolCharacterization("upstream_event", raw);

		expect(record).not.toBeNull();
		for (const [key, value] of Object.entries(raw)) {
			expect(record?.data[key]).toEqual({
				type: "string",
				utf8_bytes: new TextEncoder().encode(value).byteLength,
			});
			expect(JSON.stringify(record)).not.toContain(value);
		}
	});

	it("fails closed for every forbidden secret-bearing field spelling", () => {
		const forbidden = [
			"authorization",
			"cookie",
			"api_key",
			"apiKey",
			"correlation_id",
			"turn_state",
			"replay_payload",
			"ciphertext",
			"key",
			"key_id",
			"nonce",
			"access_token",
		] as const;

		for (const [index, field] of forbidden.entries()) {
			const secret = `FORBIDDEN_SECRET_${index}`;
			const result = sanitizeServerToolCharacterization("response_metadata", {
				status: "completed",
				[field]: secret,
			});
			expect(result).toBeNull();
			expect(JSON.stringify(result)).not.toContain(secret);
		}
	});

	it("aliases non-protocol keys and labels but rejects malformed structures", () => {
		const aliasedKey = sanitizeServerToolCharacterization("outbound_request", {
			"unsafe key": true,
		});
		expect(aliasedKey?.data).toEqual({
			"field-1": { type: "boolean" },
		});
		expect(JSON.stringify(aliasedKey)).not.toContain("unsafe key");
		const aliasedLabel = sanitizeServerToolCharacterization("upstream_event", {
			type: "SECRET_NOT_A_PROTOCOL_ENUM",
		});
		expect(aliasedLabel?.data.type).toBe("label-1");
		expect(JSON.stringify(aliasedLabel)).not.toContain(
			"SECRET_NOT_A_PROTOCOL_ENUM",
		);
		expect(
			sanitizeServerToolCharacterization("unknown" as "outbound_request", {}),
		).toBeNull();
		for (const malformed of [
			null,
			undefined,
			[],
			new Date(),
			new Map(),
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Symbol("bad"),
			() => undefined,
		]) {
			expect(
				sanitizeServerToolCharacterization("upstream_event", malformed),
			).toBeNull();
		}

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(
			sanitizeServerToolCharacterization("upstream_event", cyclic),
		).toBeNull();
		const throwing = Object.defineProperty({}, "safe", {
			enumerable: true,
			get() {
				throw new Error("ACCESSOR_SECRET");
			},
		});
		expect(() =>
			sanitizeServerToolCharacterization("upstream_event", throwing),
		).not.toThrow();
		expect(
			sanitizeServerToolCharacterization("upstream_event", throwing),
		).toBeNull();
	});

	it("retains bounded provider-native enum shapes before decoder support exists", () => {
		const record = sanitizeServerToolCharacterization("upstream_event", {
			event: "response.web_search_call.searching",
			tool_kind: "web_search",
			type: "response.web_search_call.searching",
		});

		expect(record?.data).toEqual({
			event: "response.web_search_call.searching",
			tool_kind: "web_search",
			type: "response.web_search_call.searching",
		});
	});

	it("retains only the exact outbound native web-search descriptor tokens", () => {
		const first = sanitizeServerToolCharacterization("outbound_request", {
			tools: [{ type: "web_search" }, { type: "function" }],
			include: ["web_search_call.action.sources"],
		});
		const second = sanitizeServerToolCharacterization("outbound_request", {
			include: ["web_search_call.action.sources"],
			tools: [{ type: "web_search" }, { type: "function" }],
		});
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		if (first === null || second === null) {
			throw new Error("expected native descriptor fixtures to sanitize");
		}

		const canonical = canonicalizeServerToolCharacterization(first);
		expect(canonical).toBe(
			'{"data":{"include":["web_search_call.action.sources"],"tools":[{"type":"web_search"},{"type":"function"}]},"kind":"outbound_request"}',
		);
		expect(canonical).toBe(canonicalizeServerToolCharacterization(second));

		const nearMissInclude = "web_search_call.action.source";
		const secretInclude = "RAW_INCLUDE_SECRET";
		const secretToolType = "RAW_TOOL_TYPE_SECRET";
		const nearMiss = sanitizeServerToolCharacterization("outbound_request", {
			include: [nearMissInclude, secretInclude],
			tools: [
				{ type: "web-search" },
				{ name: "RAW_TOOL_NAME_SECRET", type: secretToolType },
			],
		});
		expect(nearMiss?.data).toEqual({
			include: [
				{
					type: "string",
					utf8_bytes: new TextEncoder().encode(nearMissInclude).byteLength,
				},
				{
					type: "string",
					utf8_bytes: new TextEncoder().encode(secretInclude).byteLength,
				},
			],
			tools: [{ type: "label-1" }, { name: "tool-1", type: "label-2" }],
		});
		const nearMissJson = JSON.stringify(nearMiss);
		for (const raw of [
			nearMissInclude,
			secretInclude,
			"web-search",
			"RAW_TOOL_NAME_SECRET",
			secretToolType,
		]) {
			expect(nearMissJson).not.toContain(raw);
		}

		for (const wrongLocation of [
			sanitizeServerToolCharacterization("outbound_request", {
				data: { include: ["web_search_call.action.sources"] },
				type: "web_search",
			}),
			sanitizeServerToolCharacterization("outbound_request", {
				include: { "*": "web_search_call.action.sources" },
				"include.*": "web_search_call.action.sources",
			}),
			sanitizeServerToolCharacterization("outbound_request", {
				tools: [{ nested: { type: "web_search" } }],
			}),
			sanitizeServerToolCharacterization("outbound_request", {
				tools: { "*": { type: "web_search" } },
				"tools.*": { type: "web_search" },
			}),
			sanitizeServerToolCharacterization("upstream_event", {
				include: ["web_search_call.action.sources"],
				tools: [{ type: "web_search" }],
			}),
		]) {
			const serialized = JSON.stringify(wrongLocation);
			expect(serialized).not.toContain("web_search_call.action.sources");
			expect(serialized).not.toContain('"type":"web_search"');
		}
	});

	it("retains the exact bounded native candidate option contract", () => {
		const candidate = sanitizeServerToolCharacterization("outbound_request", {
			max_tool_calls: 8,
			tools: [
				{
					filters: { allowed_domains: ["d.example"] },
					type: "web_search",
					user_location: {
						city: "CITY",
						country: "CC",
						region: "RRR",
						timezone: "ZONE5",
						type: "approximate",
					},
				},
			],
		});
		expect(candidate).not.toBeNull();
		if (candidate === null) {
			throw new Error("expected native candidate fixture to sanitize");
		}
		expect(canonicalizeServerToolCharacterization(candidate)).toBe(
			'{"data":{"max_tool_calls":8,"tools":[{"filters":{"allowed_domains":[{"type":"string","utf8_bytes":9}]},"type":"web_search","user_location":{"city":{"type":"string","utf8_bytes":4},"country":{"type":"string","utf8_bytes":2},"region":{"type":"string","utf8_bytes":3},"timezone":{"type":"string","utf8_bytes":5},"type":"approximate"}}]},"kind":"outbound_request"}',
		);
		for (const rawValue of ["d.example", "CITY", "CC", "RRR", "ZONE5"]) {
			expect(JSON.stringify(candidate)).not.toContain(rawValue);
		}
		for (let maxToolCalls = 1; maxToolCalls <= 8; maxToolCalls++) {
			expect(
				sanitizeServerToolCharacterization("outbound_request", {
					max_tool_calls: maxToolCalls,
				})?.data.max_tool_calls,
			).toBe(maxToolCalls);
		}

		const blocked = sanitizeServerToolCharacterization("outbound_request", {
			tools: [
				{
					filters: { blocked_domains: ["blocked.example"] },
					type: "web_search",
				},
			],
		});
		expect(blocked?.data).toEqual({
			tools: [
				{
					filters: {
						blocked_domains: [{ type: "string", utf8_bytes: 15 }],
					},
					type: "web_search",
				},
			],
		});
		expect(JSON.stringify(blocked)).not.toContain("blocked.example");

		const nearMissLocation = sanitizeServerToolCharacterization(
			"outbound_request",
			{
				tools: [
					{
						type: "web_search",
						user_location: {
							city: "PRIVATE_CITY_SECRET",
							type: "approximately",
						},
					},
				],
			},
		);
		expect(
			(
				(nearMissLocation?.data.tools as readonly unknown[] | undefined)?.[0] as
					| { user_location?: { type?: unknown } }
					| undefined
			)?.user_location?.type,
		).toBe("label-1");
		expect(JSON.stringify(nearMissLocation)).not.toContain("approximately");
		expect(JSON.stringify(nearMissLocation)).not.toContain(
			"PRIVATE_CITY_SECRET",
		);

		for (const invalidMaxToolCalls of [0, 9, 1.5, "8", null, false]) {
			expect(
				sanitizeServerToolCharacterization("outbound_request", {
					max_tool_calls: invalidMaxToolCalls,
				}),
			).toBeNull();
		}
	});

	it("does not admit native candidate field names through spoofed or schema paths", () => {
		const wrongLocations = [
			{
				filters: { allowed_domains: ["ROOT_DOMAIN_SECRET"] },
				max_tool_calls_container: { max_tool_calls: 7 },
				user_location: { city: "ROOT_CITY_SECRET", type: "approximate" },
			},
			{
				tools: {
					"*": {
						filters: { blocked_domains: ["STAR_DOMAIN_SECRET"] },
						user_location: { country: "STAR_COUNTRY_SECRET" },
					},
				},
			},
			{
				"tools.*": {
					filters: { allowed_domains: ["DOTTED_DOMAIN_SECRET"] },
					user_location: { region: "DOTTED_REGION_SECRET" },
				},
			},
			{
				properties: {
					allowed_domains: { type: "array" },
					blocked_domains: { type: "array" },
					city: { type: "string" },
					country: { type: "string" },
					filters: { type: "object" },
					max_tool_calls: { type: "integer" },
					region: { type: "string" },
					timezone: { type: "string" },
					type: { type: "string" },
					user_location: { type: "object" },
				},
				type: "object",
			},
		] as const;
		for (const wrongLocation of wrongLocations) {
			const serialized = JSON.stringify(
				sanitizeServerToolCharacterization("outbound_request", wrongLocation),
			);
			for (const field of [
				"allowed_domains",
				"blocked_domains",
				"city",
				"country",
				"filters",
				"max_tool_calls",
				"region",
				"timezone",
				"user_location",
			]) {
				expect(serialized).not.toContain(`"${field}"`);
			}
			for (const secret of [
				"ROOT_DOMAIN_SECRET",
				"ROOT_CITY_SECRET",
				"STAR_DOMAIN_SECRET",
				"STAR_COUNTRY_SECRET",
				"DOTTED_DOMAIN_SECRET",
				"DOTTED_REGION_SECRET",
			]) {
				expect(serialized).not.toContain(secret);
			}
		}
		const schema = sanitizeServerToolCharacterization(
			"outbound_request",
			wrongLocations.at(-1),
		);
		const schemaPropertyKeys = Object.keys(
			(schema?.data.properties as Record<string, unknown> | undefined) ?? {},
		);
		expect(schemaPropertyKeys).toHaveLength(10);
		expect(
			schemaPropertyKeys.every((key) => /^field-[1-9][0-9]*$/.test(key)),
		).toBe(true);
	});

	it("retains only the closed proof-relevant Responses event family in order", () => {
		const knownEvents = [
			"response.created",
			"response.queued",
			"response.in_progress",
			"response.output_item.added",
			"response.reasoning_summary_part.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.reasoning_summary_part.done",
			"response.reasoning_text.delta",
			"response.reasoning_text.done",
			"response.web_search_call.in_progress",
			"response.web_search_call.searching",
			"response.web_search_call.completed",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.annotation.added",
			"response.output_text.done",
			"response.content_part.done",
			"response.function_call_arguments.delta",
			"response.function_call_arguments.done",
			"response.output_item.done",
			"response.completed",
			"response.incomplete",
			"response.failed",
			"error",
		] as const;
		const observed = knownEvents.map((eventName) => {
			const record = sanitizeServerToolCharacterization("upstream_event", {
				data: { type: eventName },
				event: eventName,
				type: eventName,
			});
			return {
				dataType: (record?.data.data as { type?: unknown } | undefined)?.type,
				event: record?.data.event,
				type: record?.data.type,
			};
		});
		expect(observed).toEqual(
			knownEvents.map((eventName) => ({
				dataType: eventName,
				event: eventName,
				type: eventName,
			})),
		);

		for (const unknownEvent of [
			"response.audio.delta",
			"response.code_interpreter_call.in_progress",
			"response.file_search_call.searching",
			"response.image_generation_call.in_progress",
			"response.mcp_call.in_progress",
			"response.refusal.delta",
			"response.web_search_call.private_secret",
			"response.output_text.annotation.private_secret",
			"response.output_item.added.private_secret",
			"response.any_regex_valid_but_unknown.delta",
		]) {
			const record = sanitizeServerToolCharacterization("upstream_event", {
				data: { type: unknownEvent },
				event: unknownEvent,
				type: unknownEvent,
			});
			const serialized = JSON.stringify(record);
			expect(serialized).not.toContain(unknownEvent);
			expect(serialized).toContain('"label-');
		}
	});

	it("aliases protocol-like labels unless their kind and path admit a closed value", () => {
		const capture = createServerToolCharacterizationSanitizer();
		const outbound = capture.sanitize("outbound_request", {
			model: "private-model-secret",
			reasoning: {
				effort: "private-effort-secret",
				summary: "private-summary-secret",
			},
			type: "private-type-secret",
			tool_kind: "private-tool-kind-secret",
		});
		const event = capture.sanitize("upstream_event", {
			event: "response.private-event-secret",
			model: "private-event-model-secret",
			type: "private-event-type-secret",
			tool_kind: "private-event-tool-kind-secret",
		});

		expect(outbound).not.toBeNull();
		expect(event).not.toBeNull();
		const canonical = `${capture.canonicalize(outbound!)}${capture.canonicalize(
			event!,
		)}`;
		for (const sentinel of [
			"private-model-secret",
			"private-effort-secret",
			"private-summary-secret",
			"private-type-secret",
			"private-tool-kind-secret",
			"response.private-event-secret",
			"private-event-model-secret",
			"private-event-type-secret",
			"private-event-tool-kind-secret",
		]) {
			expect(canonical).not.toContain(sentinel);
		}
		expect(canonical).toContain('"model":"label-');
		expect(canonical).toContain('"event":"label-');
	});

	it("preserves bounded StructuredOutput schema shape while aliasing private keys", () => {
		const capture = createServerToolCharacterizationSanitizer();
		const record = capture.sanitize("outbound_request", {
			tools: [
				{
					name: "StructuredOutput",
					parameters: {
						additionalProperties: false,
						$defs: {
							privateDefinitionSentinel: {
								additionalProperties: false,
								properties: {
									privateNestedSentinel: { type: "string" },
								},
								type: "object",
							},
						},
						properties: {
							privateResultSentinel: {
								$ref: "#/$defs/privateDefinitionSentinel",
							},
						},
						required: ["privateResultSentinel"],
						type: "object",
					},
					type: "function",
				},
			],
		});

		expect(record).not.toBeNull();
		const canonical = capture.canonicalize(record!);
		expect(canonical).toContain('"$defs"');
		expect(canonical).toContain('"$ref"');
		expect(canonical).toContain('"additionalProperties":false');
		for (const sentinel of [
			"privateDefinitionSentinel",
			"privateNestedSentinel",
			"privateResultSentinel",
		]) {
			expect(canonical).not.toContain(sentinel);
		}

		expect(
			sanitizeServerToolCharacterization("outbound_request", {
				properties: { access_token: { type: "string" } },
			}),
		).toBeNull();
		const pollutedProperties = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(pollutedProperties, "__proto__", {
			enumerable: true,
			value: { type: "string" },
		});
		expect(
			sanitizeServerToolCharacterization("outbound_request", {
				properties: pollutedProperties,
			}),
		).toBeNull();
		const accessorProperties = Object.defineProperty({}, "safeProperty", {
			enumerable: true,
			get: () => ({ type: "string" }),
		});
		expect(
			sanitizeServerToolCharacterization("outbound_request", {
				properties: accessorProperties,
			}),
		).toBeNull();
	});

	it("aliases user-defined object and schema property keys", () => {
		const capture = createServerToolCharacterizationSanitizer();
		const schema = capture.sanitize("outbound_request", {
			properties: {
				id: { type: "string" },
				user_defined_sentinel: { type: "string" },
			},
			required: ["id", "user_defined_sentinel"],
			type: "object",
		});

		expect(schema?.data).toEqual({
			properties: {
				"field-1": { type: "string" },
				"field-2": { type: "string" },
			},
			required: ["field-1", "field-2"],
			type: "object",
		});
		expect(capture.canonicalize(schema!)).not.toContain(
			"user_defined_sentinel",
		);

		for (const rawKey of [
			"customer_property_sentinel",
			"prompt_injection_marker",
			"schema_property_marker",
		]) {
			const record = sanitizeServerToolCharacterization("outbound_request", {
				[rawKey]: true,
			});
			expect(record?.data).toEqual({
				"field-1": { type: "boolean" },
			});
			expect(JSON.stringify(record)).not.toContain(rawKey);
		}
	});

	it("handles primitive values according to their semantic field mode", () => {
		const capture = createServerToolCharacterizationSanitizer();
		const numericIds = capture.sanitize("upstream_event", {
			id: 424_242,
			related_id: 424_242,
		});
		expect(numericIds?.data).toEqual({ id: "id-1", related_id: "id-1" });

		const coordinates = sanitizeServerToolCharacterization("outbound_request", {
			latitude_sentinel: 37.7749,
			longitude_sentinel: -122.4194,
		});
		expect(coordinates?.data).toEqual({
			"field-1": { type: "number" },
			"field-2": { type: "number" },
		});
		const coordinateJson = JSON.stringify(coordinates);
		expect(coordinateJson).not.toContain("37.7749");
		expect(coordinateJson).not.toContain("-122.4194");

		for (const input of [
			{ url: 8_675_309 },
			{ type: 8_675_309 },
			{ status: 8_675_309 },
			{ name: false },
			{ role: null },
			{ tool_kind: true },
		]) {
			expect(
				sanitizeServerToolCharacterization("upstream_event", input),
			).toBeNull();
		}

		expect(
			sanitizeServerToolCharacterization("response_metadata", {
				content_index: 3,
				ok: true,
				status: 200,
			}),
		).toEqual({
			kind: "response_metadata",
			data: { content_index: 3, ok: true, status: 200 },
		});
	});

	it("retains only the provider seam's safe response metadata classes", () => {
		const record = sanitizeServerToolCharacterization("response_metadata", {
			body_present: true,
			content_type_class: "event_stream",
			ok: true,
			requested_stream: false,
			status: 200,
			turn_state_present: true,
		});

		expect(record).toEqual({
			kind: "response_metadata",
			data: {
				body_present: true,
				content_type_class: "event_stream",
				ok: true,
				requested_stream: false,
				status: 200,
				turn_state_present: true,
			},
		});
		for (const contentTypeClass of [
			"event_stream",
			"json",
			"other",
			"missing",
		] as const) {
			expect(
				sanitizeServerToolCharacterization("response_metadata", {
					content_type_class: contentTypeClass,
				}),
			).not.toBeNull();
		}
		for (const contentTypeClass of [
			"text/event-stream",
			"RAW_SECRET",
		] as const) {
			const aliased = sanitizeServerToolCharacterization("response_metadata", {
				content_type_class: contentTypeClass,
			});
			expect(aliased?.data.content_type_class).toBe("label-1");
			expect(JSON.stringify(aliased)).not.toContain(contentTypeClass);
		}
	});

	it("sanitizes the complete minimal Codex outbound request without projection", () => {
		const record = sanitizeServerToolCharacterization("outbound_request", {
			input: [
				{
					content: [{ text: "RAW_USER_PROMPT", type: "input_text" }],
					role: "user",
				},
			],
			instructions: "RAW_SYSTEM_INSTRUCTIONS",
			max_output_tokens: 1_024,
			model: "gpt-5-codex",
			reasoning: { effort: "high", summary: "auto" },
			store: false,
			stream: true,
			tools: [
				{
					name: "RAW_USER_TOOL_NAME",
					parameters: {
						properties: {
							private_argument_name: { type: "string" },
						},
						type: "object",
					},
					type: "function",
				},
			],
		});

		expect(record).not.toBeNull();
		expect(record?.data.max_output_tokens).toBe(1_024);
		expect(record?.data.stream).toBe(true);
		expect(record?.data.store).toBe(false);
		expect((record?.data.reasoning as Record<string, unknown>)?.effort).toBe(
			"high",
		);
		const serialized = JSON.stringify(record);
		for (const raw of [
			"RAW_USER_PROMPT",
			"RAW_SYSTEM_INSTRUCTIONS",
			"RAW_USER_TOOL_NAME",
			"private_argument_name",
		]) {
			expect(serialized).not.toContain(raw);
		}
	});

	it("retains only opaque metadata for the root outbound prompt cache key", () => {
		const promptCacheKey = "RAW_PROMPT_CACHE_KEY_😀";
		const record = sanitizeServerToolCharacterization("outbound_request", {
			model: "gpt-5-codex",
			prompt_cache_key: promptCacheKey,
		});

		expect(record?.data).toEqual({
			model: "gpt-5-codex",
			prompt_cache_key: {
				type: "string",
				utf8_bytes: new TextEncoder().encode(promptCacheKey).byteLength,
			},
		});
		expect(JSON.stringify(record)).not.toContain(promptCacheKey);
		for (const wrongType of [0, false, null, {}, []]) {
			expect(
				sanitizeServerToolCharacterization("outbound_request", {
					prompt_cache_key: wrongType,
				}),
			).toBeNull();
		}
		expect(
			sanitizeServerToolCharacterization("upstream_event", {
				prompt_cache_key: promptCacheKey,
			}),
		).toBeNull();
		expect(
			sanitizeServerToolCharacterization("outbound_request", {
				input: [{ prompt_cache_key: promptCacheKey }],
			}),
		).toBeNull();
		expect(
			sanitizeServerToolCharacterization("outbound_request", {
				key: promptCacheKey,
			}),
		).toBeNull();
	});

	it("retains strict terminal usage counters and canonicalizes the event", () => {
		const usage = {
			cache_creation_input_tokens: 3,
			cache_read_input_tokens: 4,
			cache_write_tokens: 5,
			cached_input_tokens: 6,
			input_tokens: 42,
			input_tokens_details: {
				cache_creation_input_tokens: 3,
				cache_read_input_tokens: 4,
				cache_write_tokens: 5,
				cached_tokens: 7,
			},
			output_tokens: 13,
			output_tokens_details: { reasoning_tokens: 9 },
			total_tokens: 55,
		};
		const capture = createServerToolCharacterizationSanitizer();
		const record = capture.sanitize("upstream_event", {
			response: {
				id: "RAW_TERMINAL_RESPONSE_ID",
				status: "completed",
				usage,
			},
			sequence_number: 17,
			type: "response.completed",
		});

		expect((record?.data.response as Record<string, unknown>)?.usage).toEqual(
			usage,
		);
		const canonical = capture.canonicalize(record!);
		expect(canonicalizeServerToolCharacterization(record!)).toBe(canonical);
		expect(
			(JSON.parse(canonical!) as { data: { response: { usage: unknown } } })
				.data.response.usage,
		).toEqual(usage);
		expect(canonical).not.toContain("RAW_TERMINAL_RESPONSE_ID");

		for (const wrongDetails of [
			{ input_tokens_details: 0 },
			{ input_tokens_details: [] },
			{ input_tokens_details: { cached_tokens: "7" } },
			{ output_tokens_details: { reasoning_tokens: false } },
			{ output_tokens_details: { reasoning_tokens: -1 } },
			{ output_tokens_details: { reasoning_tokens: 1.5 } },
		]) {
			expect(
				sanitizeServerToolCharacterization("upstream_event", {
					response: { usage: wrongDetails },
					type: "response.completed",
				}),
			).toBeNull();
		}
	});

	it("omits only configured non-wire symbols by exact identity", () => {
		const sourceMessageIndex = Symbol("codex-source-message-index");
		const sourceCacheMarked = Symbol("codex-source-cache-marked");
		const capture = createServerToolCharacterizationSanitizer({
			ignoredSymbols: [sourceMessageIndex, sourceCacheMarked],
		});
		const contentItem = { text: "RAW_USER_PROMPT", type: "input_text" };
		Object.defineProperty(contentItem, sourceMessageIndex, {
			configurable: false,
			enumerable: false,
			value: 7,
			writable: false,
		});
		const message = { content: [contentItem], role: "user" };
		Object.defineProperty(message, sourceCacheMarked, {
			configurable: false,
			enumerable: false,
			value: true,
			writable: false,
		});
		const outbound = {
			input: [message],
			model: "gpt-5-codex",
			stream: true,
		};
		const record = capture.sanitize("outbound_request", outbound);

		expect(record).not.toBeNull();
		expect(
			sanitizeServerToolCharacterization("outbound_request", outbound),
		).toBeNull();
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("RAW_USER_PROMPT");
		expect(serialized).not.toContain("codex-source-message-index");
		expect(serialized).not.toContain("codex-source-cache-marked");
		expect(serialized).not.toContain('"7"');

		for (const symbol of [Symbol("arbitrary-internal-state")]) {
			const hostile = { type: "input_text" };
			Object.defineProperty(hostile, symbol, {
				enumerable: false,
				value: "RAW_SECRET",
			});
			expect(
				capture.sanitize("outbound_request", {
					input: [hostile],
				}),
			).toBeNull();
		}

		const enumerableIgnored = { type: "input_text" };
		Object.defineProperty(enumerableIgnored, sourceMessageIndex, {
			enumerable: true,
			value: 7,
		});
		expect(
			capture.sanitize("outbound_request", { input: [enumerableIgnored] }),
		).toBeNull();
		const accessorIgnored = { type: "input_text" };
		Object.defineProperty(accessorIgnored, sourceCacheMarked, {
			enumerable: false,
			get: () => true,
		});
		expect(
			capture.sanitize("outbound_request", { input: [accessorIgnored] }),
		).toBeNull();
	});

	it("canonicalizes only authentic records without touching forged proxies", () => {
		let trapCount = 0;
		const forgedProxy = new Proxy(
			{
				kind: "upstream_event",
				data: { type: "lowercase_secret" },
			} as ServerToolCharacterizationRecord,
			{
				get: () => {
					trapCount++;
					return "RAW_SECRET";
				},
				getOwnPropertyDescriptor: () => {
					trapCount++;
					return undefined;
				},
				getPrototypeOf: () => {
					trapCount++;
					return Object.prototype;
				},
				ownKeys: () => {
					trapCount++;
					return [];
				},
			},
		);
		expect(canonicalizeServerToolCharacterization(forgedProxy)).toBeNull();
		expect(trapCount).toBe(0);
		expect(
			canonicalizeServerToolCharacterization({
				kind: "upstream_event",
				data: { type: "lowercase_secret" },
			}),
		).toBeNull();

		const context = createServerToolCharacterizationSanitizer();
		const contextual = context.sanitize("upstream_event", { type: "message" });
		const convenient = sanitizeServerToolCharacterization("upstream_event", {
			type: "message",
		});
		expect(context.canonicalize(convenient!)).toBe(
			canonicalizeServerToolCharacterization(contextual!),
		);
	});

	it("round-trips semantic aliases after their raw keys are aliased", () => {
		const record = sanitizeServerToolCharacterization("upstream_event", {
			custom_id: "RAW_IDENTIFIER_SECRET",
		});

		expect(record?.data).toEqual({ "field-1": "id-1" });
		const canonical = canonicalizeServerToolCharacterization(record!);
		expect(canonical).toBe(
			'{"data":{"field-1":"id-1"},"kind":"upstream_event"}',
		);
		expect(canonical).not.toContain("RAW_IDENTIFIER_SECRET");
	});

	it("rejects overlong strings before UTF-8 allocation", () => {
		const oversized = "x".repeat(
			CHARACTERIZATION_LIMITS.maxStringUtf8Bytes + 1,
		);
		const originalEncode = TextEncoder.prototype.encode;
		let encodedOversizedInput = false;
		TextEncoder.prototype.encode = function encode(input?: string): Uint8Array {
			if (input === oversized) encodedOversizedInput = true;
			return originalEncode.call(this, input);
		};
		try {
			const record = sanitizeServerToolCharacterization("upstream_event", {
				text: oversized,
			});
			expect(record?.data.text).toEqual({
				type: "truncated",
				reason: "max_string_utf16_code_units",
				observed: oversized.length,
			});
			expect(encodedOversizedInput).toBe(false);
		} finally {
			TextEncoder.prototype.encode = originalEncode;
		}
	});

	it("enforces every structural and UTF-8 bound", () => {
		const tooDeep: Record<string, unknown> = {};
		let cursor = tooDeep;
		for (let index = 0; index <= CHARACTERIZATION_LIMITS.maxDepth; index++) {
			const next: Record<string, unknown> = {};
			cursor.child = next;
			cursor = next;
		}
		const depthRecord = sanitizeServerToolCharacterization(
			"upstream_event",
			tooDeep,
		);
		expect(depthRecord).not.toBeNull();
		expect(JSON.stringify(depthRecord)).toContain('"reason":"max_depth"');
		const arrayRecord = sanitizeServerToolCharacterization("upstream_event", {
			items: Array.from(
				{ length: CHARACTERIZATION_LIMITS.maxArrayItems + 1 },
				() => 1,
			),
		});
		expect(arrayRecord).not.toBeNull();
		expect(JSON.stringify(arrayRecord)).toContain('"reason":"max_array_items"');
		const objectRecord = sanitizeServerToolCharacterization(
			"upstream_event",
			Object.fromEntries(
				Array.from(
					{ length: CHARACTERIZATION_LIMITS.maxObjectKeys + 1 },
					(_, index) => [`field_${index}`, index],
				),
			),
		);
		expect(objectRecord).not.toBeNull();
		expect(JSON.stringify(objectRecord)).toContain(
			'"reason":"max_object_keys"',
		);
		const utf8Record = sanitizeServerToolCharacterization("upstream_event", {
			text: "é".repeat(
				Math.floor(CHARACTERIZATION_LIMITS.maxStringUtf8Bytes / 2) + 1,
			),
		});
		expect(utf8Record).not.toBeNull();
		expect(JSON.stringify(utf8Record)).toContain(
			'"reason":"max_string_utf8_bytes"',
		);
		const tooManyNodes = Array.from(
			{ length: CHARACTERIZATION_LIMITS.maxArrayItems },
			() => ({ a: 1, b: 2, c: 3, d: 4 }),
		);
		const nodeRecord = sanitizeServerToolCharacterization("upstream_event", {
			items: tooManyNodes,
		});
		expect(nodeRecord).not.toBeNull();
		expect(JSON.stringify(nodeRecord)).toContain('"reason":"max_nodes"');

		const capture = createServerToolCharacterizationSanitizer();
		for (let index = 0; index < CHARACTERIZATION_LIMITS.maxAliases; index++) {
			expect(
				capture.sanitize("upstream_event", { id: `CAPTURE_ID_${index}` }),
			).not.toBeNull();
		}
		expect(
			capture.sanitize("upstream_event", { id: "CAPTURE_ID_OVERFLOW" }),
		).toBeNull();
	});

	it("rejects arrays above the inspection ceiling before hidden properties can bypass validation", () => {
		const makeOversizedArray = () =>
			Array.from(
				{ length: CHARACTERIZATION_LIMITS.maxArrayInspectionItems + 1 },
				() => 0,
			);

		const secretNamed = makeOversizedArray();
		Object.defineProperty(secretNamed, "access_token", {
			value: "ARRAY_PROPERTY_SECRET",
			enumerable: true,
		});

		let accessorRead = false;
		const accessor = makeOversizedArray();
		Object.defineProperty(accessor, "extra", {
			get() {
				accessorRead = true;
				return "ARRAY_ACCESSOR_SECRET";
			},
			enumerable: true,
		});

		const symbolProperty = makeOversizedArray();
		Object.defineProperty(symbolProperty, Symbol("secret"), {
			value: "ARRAY_SYMBOL_SECRET",
		});

		for (const items of [secretNamed, accessor, symbolProperty]) {
			expect(
				sanitizeServerToolCharacterization("upstream_event", { items }),
			).toBeNull();
		}
		expect(accessorRead).toBe(false);
	});

	it("canonicalizes marker-heavy sanitized output within the snapshot node bound", () => {
		const oversizedObject = Object.fromEntries(
			Array.from(
				{ length: CHARACTERIZATION_LIMITS.maxObjectKeys + 1 },
				(_, index) => [`field_${index}`, index],
			),
		);
		const markerHeavyArray = () =>
			Array.from(
				{ length: CHARACTERIZATION_LIMITS.maxArrayItems + 1 },
				() => oversizedObject,
			);
		const input = {
			batch_a: markerHeavyArray(),
			batch_b: markerHeavyArray(),
			batch_c: markerHeavyArray(),
			batch_d: markerHeavyArray(),
		};
		const record = sanitizeServerToolCharacterization("upstream_event", input);

		expect(record).not.toBeNull();
		const canonical = canonicalizeServerToolCharacterization(record!);
		expect(canonical).not.toBeNull();
		const parsed = JSON.parse(canonical!) as { data: unknown };
		expect(countJsonNodes(parsed.data)).toBeLessThanOrEqual(
			CHARACTERIZATION_LIMITS.maxSnapshotNodes,
		);

		let emitted: ServerToolCharacterizationRecord | undefined;
		emitServerToolCharacterization(
			(record) => {
				emitted = record;
			},
			"upstream_event",
			input,
		);
		expect(emitted).toBeDefined();
		expect(canonicalizeServerToolCharacterization(emitted!)).not.toBeNull();
	});

	it("keeps observer and sanitizer failures content-free and inert", async () => {
		let observed: unknown;
		expect(() =>
			emitServerToolCharacterization(
				(record) => {
					observed = record;
					throw new Error("OBSERVER_SECRET");
				},
				"upstream_event",
				{ query: "OBSERVER_INPUT_SECRET", type: "message" },
			),
		).not.toThrow();
		expect(JSON.stringify(observed)).not.toContain("OBSERVER_INPUT_SECRET");
		expectDeepFrozen(observed);

		let thenRead = false;
		let thenCalled = false;
		const returnedThenable = {
			// biome-ignore lint/suspicious/noThenProperty: This proves observers are never awaited or assimilated as promises.
			get then() {
				thenRead = true;
				return () => {
					thenCalled = true;
				};
			},
		};
		expect(() =>
			emitServerToolCharacterization(
				() => returnedThenable as unknown as undefined,
				"upstream_event",
				{ status: "completed" },
			),
		).not.toThrow();
		await Bun.sleep(0);
		expect(thenRead).toBe(false);
		expect(thenCalled).toBe(false);

		let called = false;
		const throwingInput = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("SANITIZER_SECRET");
				},
			},
		);
		expect(() =>
			emitServerToolCharacterization(
				() => {
					called = true;
				},
				"upstream_event",
				throwingInput,
			),
		).not.toThrow();
		expect(called).toBe(false);
	});
});
