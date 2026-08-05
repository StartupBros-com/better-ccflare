import { describe, expect, test } from "bun:test";
import { CodexProvider } from "../../packages/providers/src/providers/codex/provider";
import {
	canonicalizeServerToolCharacterization,
	type ServerToolCharacterizationObserver,
	type ServerToolCharacterizationRecord,
} from "../../packages/providers/src/providers/codex/server-tool-characterization";
import {
	CharacterizationRequestRejectedError,
	createCodexCharacterizationProvider,
} from "../codex-server-tool-characterization-request-adapter";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function clientFunction(name = "Lookup") {
	return {
		name,
		description: "Look up a public identifier",
		input_schema: {
			type: "object",
			properties: { identifier: { type: "string" } },
			required: ["identifier"],
		},
	};
}

function webSearch(overrides: Record<string, unknown> = {}) {
	return {
		type: "web_search_20250305",
		name: "web_search",
		...overrides,
	};
}

function requestWith(
	tools: readonly unknown[],
	overrides: Record<string, unknown> = {},
	contentType = "application/json",
): Request {
	return new Request(ENDPOINT, {
		method: "POST",
		headers: { "content-type": contentType },
		body: JSON.stringify({
			model: "claude-sonnet-4-20250514",
			max_tokens: 128,
			messages: [{ role: "user", content: "Find the public source." }],
			stream: true,
			tools,
			...overrides,
		}),
	});
}

function collectRecords(): {
	records: ServerToolCharacterizationRecord[];
	observer: ServerToolCharacterizationObserver;
} {
	const records: ServerToolCharacterizationRecord[] = [];
	return { records, observer: (record) => records.push(record) };
}

describe("Codex server-tool characterization request adapter", () => {
	test("is not reachable through ordinary CodexProvider configuration", async () => {
		const transformed = await new CodexProvider().transformRequestBody(
			requestWith([webSearch()]),
		);
		const body = (await transformed.json()) as {
			include?: unknown;
			tools?: Array<{ name?: string; type?: string }>;
		};

		expect(body.include).toBeUndefined();
		expect(body.tools).toContainEqual(
			expect.objectContaining({ name: "web_search", type: "function" }),
		);
		expect(body.tools?.some((tool) => tool.type === "web_search")).toBe(false);
	});

	test("keeps ordinary request bytes identical and retains its single base observation", async () => {
		const baseline = await new CodexProvider().transformRequestBody(
			requestWith([clientFunction()]),
		);
		const capture = collectRecords();
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			capture.observer,
		);
		const adapted = await provider.transformRequestBody(
			requestWith([clientFunction()]),
		);

		expect(await adapted.text()).toBe(await baseline.text());
		expect(
			capture.records.filter((record) => record.kind === "outbound_request"),
		).toHaveLength(1);
	});

	test("maps only the exact candidate profile and preserves mixed client functions", async () => {
		const capture = collectRecords();
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			capture.observer,
		);
		const transformed = await provider.transformRequestBody(
			requestWith(
				[
					clientFunction("Lookup"),
					webSearch({
						allowed_domains: ["example.com/docs", "openai.com/research"],
						max_uses: 3,
						user_location: {
							type: "approximate",
							city: "Miami",
							region: "Florida",
							country: "US",
							timezone: "America/New_York",
						},
					}),
				],
				{ tool_choice: { type: "auto" } },
			),
		);
		const body = (await transformed.json()) as {
			include?: unknown;
			max_tool_calls?: number;
			tools?: unknown[];
		};

		expect(body.include).toEqual(["web_search_call.action.sources"]);
		expect(body.max_tool_calls).toBe(3);
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "Lookup",
				description: "Look up a public identifier",
				parameters: {
					type: "object",
					properties: { identifier: { type: "string" } },
					required: ["identifier"],
				},
			},
			{
				type: "web_search",
				filters: {
					allowed_domains: ["example.com/docs", "openai.com/research"],
				},
				user_location: {
					type: "approximate",
					city: "Miami",
					region: "Florida",
					country: "US",
					timezone: "America/New_York",
				},
			},
		]);

		const outbound = capture.records.filter(
			(record) => record.kind === "outbound_request",
		);
		expect(outbound).toHaveLength(1);
		const canonical = canonicalizeServerToolCharacterization(outbound[0]!);
		expect(canonical).toContain('"type":"web_search"');
		expect(canonical).toContain("web_search_call.action.sources");
		expect(canonical).not.toContain("characterization_marker");
	});

	test("maps blocked-domain profiles without inventing an allow-list", async () => {
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			() => {},
		);
		const transformed = await provider.transformRequestBody(
			requestWith([
				webSearch({ blocked_domains: ["example.com/private"] }),
			]),
		);
		const body = (await transformed.json()) as {
			tools?: Array<{ filters?: Record<string, unknown> }>;
		};

		expect(body.tools?.[0]?.filters).toEqual({
			blocked_domains: ["example.com/private"],
		});
	});

	test("normalizes JSON media-type case and parameters before adapting", async () => {
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			() => {},
		);
		const transformed = await provider.transformRequestBody(
			requestWith(
				[webSearch()],
				{},
				"Application/JSON; Charset=UTF-8",
			),
		);
		const body = (await transformed.json()) as {
			include?: unknown;
			tools?: Array<{ type?: string }>;
		};

		expect(body.include).toEqual(["web_search_call.action.sources"]);
		expect(body.tools?.[0]?.type).toBe("web_search");
	});

	test("keeps an ordinary case-variant JSON request byte-compatible", async () => {
		const contentType = "Application/JSON; Charset=UTF-8";
		const baseline = await new CodexProvider().transformRequestBody(
			requestWith([clientFunction()], {}, contentType),
		);
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			() => {},
		);
		const adapted = await provider.transformRequestBody(
			requestWith([clientFunction()], {}, contentType),
		);

		expect(await adapted.text()).toBe(await baseline.text());
	});

	test("rejects invalid and unsupported typed profiles before invoking the base transform", async () => {
		let baseTransforms = 0;
		class CountingProvider {
			constructor(_options: {
				characterizationObserver: ServerToolCharacterizationObserver;
			}) {}

			async transformRequestBody(request: Request): Promise<Request> {
				baseTransforms += 1;
				return request;
			}
		}
		const provider = createCodexCharacterizationProvider(
			CountingProvider,
			() => {},
		);
		const invalidProfiles = [
			[webSearch({ max_uses: 0 })],
			[webSearch({ extra: true })],
			[
				webSearch({
					allowed_domains: ["example.com"],
					blocked_domains: ["x.test"],
				}),
			],
			[{ type: "web_search_20260209", name: "web_search" }],
			[webSearch(), { type: "computer_20250124", name: "computer" }],
			[webSearch(), webSearch()],
		] as const;

		for (const tools of invalidProfiles) {
			await expect(
				provider.transformRequestBody(requestWith(tools)),
			).rejects.toBeInstanceOf(CharacterizationRequestRejectedError);
		}
		await expect(
			provider.transformRequestBody(
				requestWith([webSearch()], {
					tool_choice: { type: "tool", name: "web_search" },
				}),
			),
		).rejects.toBeInstanceOf(CharacterizationRequestRejectedError);
		await expect(
			provider.transformRequestBody(
				requestWith([webSearch()], { parallel_tool_calls: true }),
			),
		).rejects.toBeInstanceOf(CharacterizationRequestRejectedError);
		expect(baseTransforms).toBe(0);
	});

	test("rejects malformed JSON and ambiguous typed-tool structures before the base transform", async () => {
		let baseTransforms = 0;
		class CountingProvider {
			constructor(_options: {
				characterizationObserver: ServerToolCharacterizationObserver;
			}) {}

			async transformRequestBody(request: Request): Promise<Request> {
				baseTransforms += 1;
				return request;
			}
		}
		const provider = createCodexCharacterizationProvider(
			CountingProvider,
			() => {},
		);
		const malformed = new Request(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "Application/JSON; Charset=UTF-8" },
			body: "{not-json",
		});
		const ambiguous = new Request(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				max_tokens: 128,
				messages: [],
				tools: webSearch(),
			}),
		});

		await expect(provider.transformRequestBody(malformed)).rejects.toBeInstanceOf(
			CharacterizationRequestRejectedError,
		);
		await expect(provider.transformRequestBody(ambiguous)).rejects.toBeInstanceOf(
			CharacterizationRequestRejectedError,
		);
		expect(baseTransforms).toBe(0);
	});

	test("rejects native and proxy replay obligations before the base transform", async () => {
		let baseTransforms = 0;
		class CountingProvider {
			constructor(_options: {
				characterizationObserver: ServerToolCharacterizationObserver;
			}) {}

			async transformRequestBody(request: Request): Promise<Request> {
				baseTransforms += 1;
				return request;
			}
		}
		const provider = createCodexCharacterizationProvider(
			CountingProvider,
			() => {},
		);
		const replayMessages = [
			[
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_private",
							name: "web_search",
							input: { query: "private" },
						},
					],
				},
			],
			[
				{
					role: "assistant",
					content: [
						{
							type: "web_search_tool_result",
							content: [
								{
									type: "web_search_result",
									encrypted_content: "bccf1.A256GCM.proxy-envelope",
								},
							],
						},
					],
				},
			],
		] as const;

		for (const messages of replayMessages) {
			await expect(
				provider.transformRequestBody(requestWith([webSearch()], { messages })),
			).rejects.toBeInstanceOf(CharacterizationRequestRejectedError);
		}
		expect(baseTransforms).toBe(0);
	});

	test("preserves response metadata and raw upstream event observations", async () => {
		const capture = collectRecords();
		const provider = createCodexCharacterizationProvider(
			CodexProvider,
			capture.observer,
		);
		const upstream = new Response(
			[
				"event: response.web_search_call.in_progress",
				'data: {"type":"response.web_search_call.in_progress","item_id":"private-id"}',
				"",
				"",
			].join("\n"),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const downstream = await provider.processResponse(upstream, null);
		await downstream.text();

		expect(
			capture.records.filter((record) => record.kind === "response_metadata"),
		).toHaveLength(1);
		expect(
			capture.records.filter((record) => record.kind === "upstream_event"),
		).toHaveLength(1);
		expect(JSON.stringify(capture.records)).not.toContain("private-id");
	});
});
