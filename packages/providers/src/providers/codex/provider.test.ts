import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchCodexUsageOnDemand } from "./on-demand-fetch";
import { CodexProvider } from "./provider";
import { parseCodexUsageHeaders } from "./usage";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];
const searchTool = {
	name: "search",
	description: "search",
	input_schema: {
		type: "object",
		properties: { query: { type: "string" } },
	},
};

describe("CodexProvider request conversion", () => {
	it("handles only /v1/messages path", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeFalse();
	});

	it("forwards Claude reasoning effort to Codex reasoning.effort", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "high" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "high" });
	});

	it("forwards xhigh reasoning effort to Codex unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "xhigh" });
	});

	it("keeps default Codex reasoning effort when Claude effort is absent", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	it("rejects unsupported reasoning effort values", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "extreme" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("downgrades efforts unsupported by the mapped Codex model", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.4-mini" }),
		} as Parameters<typeof provider.transformRequestBody>[1];

		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();
		expect(body.reasoning).toEqual({ effort: "medium" });
	});
});

describe("CodexProvider.processResponse", () => {
	it("buffers tool-call arguments and emits them once before content_block_stop", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(
			transformedBody.match(/event: content_block_delta/g)?.length ?? 0,
		).toBe(1);
		expect(transformedBody).toContain('"index":0');
		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"hello\\"}"',
		);
		const deltaPos = transformedBody.indexOf("event: content_block_delta");
		const stopPos = transformedBody.indexOf("event: content_block_stop");
		expect(deltaPos).toBeGreaterThanOrEqual(0);
		expect(stopPos).toBeGreaterThan(deltaPos);
	});

	it("uses the function_call block index rather than the current text block index", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const deltaLine = transformedBody
			.split("\n")
			.find(
				(line) =>
					line.includes('"type":"content_block_delta"') &&
					line.includes('"input_json_delta"'),
			);

		expect(deltaLine).not.toBeUndefined();
		// Text streams first at index 0; the tool block is emitted atomically
		// at output_item.done as index 1, carrying the buffered arguments.
		expect(deltaLine).toContain('"index":1');
		expect(deltaLine).toContain('"partial_json":"{\\"query\\":\\"hello\\"}"');
	});

	it("does not emit premature content_block_stop for function-call when text block opens concurrently", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"q":1}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const events = transformedBody
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map(
				(l) =>
					JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>,
			);

		// Block lifecycles must be strictly sequential: text streams at index 0,
		// then the tool block is emitted atomically at index 1.
		const blockEvents = events
			.filter(
				(e) =>
					e.type === "content_block_start" ||
					e.type === "content_block_delta" ||
					e.type === "content_block_stop",
			)
			.map((e) => `${e.type}:${e.index}`);
		expect(blockEvents).toEqual([
			"content_block_start:0",
			"content_block_delta:0",
			"content_block_stop:0",
			"content_block_start:1",
			"content_block_delta:1",
			"content_block_stop:1",
		]);

		// The tool block carries the buffered arguments exactly once
		const toolStart = events.find(
			(e) =>
				e.type === "content_block_start" &&
				(e.content_block as Record<string, unknown>)?.type === "tool_use",
		);
		expect(toolStart?.index).toBe(1);
		expect(transformedBody).toContain('"partial_json":"{\\"q\\":1}"');
	});

	it("includes input_tokens when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"usage":{');
		expect(messageDeltaLine).toContain('"output_tokens":3');
		expect(messageDeltaLine).toContain('"input_tokens":12');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":4');
	});

	it("normalizes message_delta usage and delta defaults when missing", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 5, output_tokens: 2 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		const dataPrefix = "data: ";
		expect(messageDeltaLine?.startsWith(dataPrefix)).toBeTrue();
		const payload = JSON.parse(
			(messageDeltaLine as string).slice(dataPrefix.length),
		);
		expect(payload.usage.input_tokens).toBe(5);
		expect(payload.usage.output_tokens).toBe(2);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.delta.stop_reason).toBe("end_turn");
		expect(payload.delta.stop_sequence).toBe(null);
	});

	it("successful JSON responses pass through unchanged", async () => {
		const provider = new CodexProvider();
		const body = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [] },
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await transformed.text()).toBe(body);
	});

	it("returns Anthropic JSON for non-streaming requests when upstream returns SSE", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "Hi" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 7, output_tokens: 2 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.type).toBe("message");
		expect(payload.role).toBe("assistant");
		expect(payload.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(payload.usage).toEqual({
			input_tokens: 7,
			output_tokens: 2,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("preserves tool_use content in non-streaming SSE->JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_tool_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "search",
						description: "search",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "search",
				input: { query: "hello" },
			},
		]);
	});

	it("maps response.completed usage into Claude-compatible context_window using model metadata", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.3-codex" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						input_tokens_details: {
							cached_tokens: 25,
							cache_creation_input_tokens: 10,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":25');
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":10');
		expect(messageDeltaLine).toContain('"context_window_size":272000');
	});

	it("omits context_window when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"output_tokens":3');
	});

	it("emits zeroed message_start usage then errors when no terminal event arrives", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageStartLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_start"'));

		expect(messageStartLine).not.toBeUndefined();
		const payload = JSON.parse(
			(messageStartLine as string).slice("data: ".length),
		);
		expect(payload.usage.input_tokens).toBe(0);
		expect(payload.usage.output_tokens).toBe(0);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.message.usage.input_tokens).toBe(0);
		expect(payload.message.usage.output_tokens).toBe(0);
		// A stream without response.completed/incomplete/failed is unverifiable:
		// no synthesized success terminal, an error event instead
		expect(transformedBody).toContain("event: error");
		expect(transformedBody).not.toContain("event: message_delta");
		expect(transformedBody).not.toContain("event: message_stop");
	});

	it("normalizes upstream error events preserving the failure class", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("error", {
				type: "error",
				code: "rate_limit_exceeded",
				message: "slow down",
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"type":"rate_limit_error"');
		expect(body).toContain("slow down");
		expect(body.match(/event: error/g)?.length ?? 0).toBe(1);
		expect(body).not.toContain("event: message_stop");
	});

	it("maps known Codex failure codes to their Anthropic error classes", async () => {
		const provider = new CodexProvider();
		const cases: Array<[string, string]> = [
			["insufficient_quota", "rate_limit_error"],
			["slow_down", "overloaded_error"],
			["context_length_exceeded", "invalid_request_error"],
			["usage_not_included", "permission_error"],
		];
		for (const [code, expectedType] of cases) {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.4" },
				}),
				...eventLine("error", { type: "error", code, message: code }),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});

			const transformed = await provider.processResponse(response, null);
			const body = await transformed.text();

			expect(body).toContain(`"type":"${expectedType}"`);
		}
	});

	it("maps upstream error class to HTTP status for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_rate_limit";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("error", {
				type: "error",
				code: "rate_limit_exceeded",
				message: "slow down",
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.status).toBe(429);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			any
		>;
		expect(payload.error.type).toBe("rate_limit_error");
	});

	it("surfaces response.failed as an SSE error with the upstream message", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "partial" }),
			...eventLine("response.failed", {
				response: {
					model: "gpt-5.4",
					status: "failed",
					error: { code: "server_error", message: "upstream exploded" },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain("upstream exploded");
		expect(body).not.toContain("event: message_stop");
		expect(body.match(/event: error/g)?.length ?? 0).toBe(1);
	});

	it("propagates mid-stream processing failures as an error event", async () => {
		const provider = new CodexProvider();
		const encoder = new TextEncoder();
		const firstChunk = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
		]);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(firstChunk));
				controller.error(new Error("connection reset"));
			},
		});
		const response = new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).not.toContain("event: message_stop");
	});

	it("includes cache_creation_input_tokens in synthesized context_window when present", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: {
						input_tokens: 42,
						output_tokens: 7,
						input_tokens_details: {
							cached_tokens: 5,
							cache_creation_input_tokens: 9,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":9');
		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"context_window_size":272000');
	});

	it("treats successful missing-content-type SSE bodies as streams", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const transformedBody = await transformed.text();
		expect(transformedBody).toContain("event: message_start");
		expect(transformedBody).toContain("event: message_delta");
		expect(transformedBody).toContain(
			'"usage":{"input_tokens":2,"output_tokens":1',
		);
	});

	it("passes through successful missing-content-type unknown bodies", async () => {
		const provider = new CodexProvider();
		const response = new Response("ok", {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toBeNull();
		expect(await transformed.text()).toBe("ok");
	});

	it("passes through non-streaming error responses", async () => {
		const provider = new CodexProvider();
		const response = new Response('{"error":"bad_request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		const processed = await provider.processResponse(response, null);

		expect(processed.status).toBe(400);
		expect(await processed.text()).toBe('{"error":"bad_request"}');
	});
});

describe("CodexProvider.transformRequestBody", () => {
	it("maps sonnet-family models to the default Codex model", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses account sonnet mapping for sonnet-family models", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses first model when account mapping value is an ordered array", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({
				sonnet: ["gpt-5.3-codex", "gpt-5.4"],
			}),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses default Codex mapping for families missing from account mappings", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-haiku",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});

	it("passes through unknown model names unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});
});

describe("CodexProvider tool-call request protocol", () => {
	const makeRequest = (body: Record<string, unknown>) =>
		new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	it("forwards max_tokens as max_output_tokens", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 4096,
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.max_output_tokens).toBe(4096);
	});

	it("omits max_output_tokens when max_tokens is absent", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.max_output_tokens).toBeUndefined();
	});

	it("clamps prewarm max_tokens 0 to a 1-token cap instead of dropping it", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 0,
				messages: [{ role: "user", content: "warmup" }],
			}),
		);
		const body = await transformed.json();

		expect(body.max_output_tokens).toBe(1);
	});

	it("defaults to auto tool_choice with parallel tool calls when tools are present", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 100,
				tools: [searchTool],
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(true);
	});

	it("maps tool_choice any to required and honours disable_parallel_tool_use", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 100,
				tools: [searchTool],
				tool_choice: { type: "any", disable_parallel_tool_use: true },
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.tool_choice).toBe("required");
		expect(body.parallel_tool_calls).toBe(false);
	});

	it("maps tool_choice none to none", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 100,
				tools: [searchTool],
				tool_choice: { type: "none" },
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.tool_choice).toBe("none");
	});

	it("narrows tools to the named tool and requires a call for named tool_choice", async () => {
		const provider = new CodexProvider();
		const otherTool = {
			name: "other",
			description: "other",
			input_schema: { type: "object", properties: {} },
		};
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 100,
				tools: [searchTool, otherTool],
				tool_choice: { type: "tool", name: "search" },
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.tool_choice).toBe("required");
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].name).toBe("search");
	});

	it("rejects forcing tool_choice without tools", async () => {
		const provider = new CodexProvider();
		await expect(
			provider.transformRequestBody(
				makeRequest({
					model: "claude-3-7-sonnet",
					max_tokens: 100,
					tools: [],
					tool_choice: { type: "any" },
					messages: [{ role: "user", content: "hello" }],
				}),
			),
		).rejects.toThrow(
			'tool_choice type "any" requires a non-empty tools array',
		);
	});

	it("rejects named tool_choice that matches no tool", async () => {
		const provider = new CodexProvider();
		await expect(
			provider.transformRequestBody(
				makeRequest({
					model: "claude-3-7-sonnet",
					max_tokens: 100,
					tools: [searchTool],
					tool_choice: { type: "tool", name: "missing" },
					messages: [{ role: "user", content: "hello" }],
				}),
			),
		).rejects.toThrow('tool_choice.name "missing" does not match any tool');
	});

	it("omits tool_choice and parallel_tool_calls when no tools are present", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeRequest({
				model: "claude-3-7-sonnet",
				max_tokens: 100,
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const body = await transformed.json();

		expect(body.tool_choice).toBeUndefined();
		expect(body.parallel_tool_calls).toBeUndefined();
	});
});

describe("CodexProvider stop_reason protocol", () => {
	const parseEventPayload = (body: string, type: string) => {
		const line = body
			.split("\n")
			.find((l) => l.startsWith("data:") && l.includes(`"type":"${type}"`));
		expect(line).not.toBeUndefined();
		return JSON.parse((line as string).slice("data:".length).trim()) as Record<
			string,
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			any
		>;
	};

	const functionCallTurn = [
		...eventLine("response.created", {
			response: { id: "resp_test", model: "gpt-5.4" },
		}),
		...eventLine("response.output_item.added", {
			item: { type: "function_call", call_id: "call_1", name: "search" },
			output_index: 0,
		}),
		...eventLine("response.function_call_arguments.delta", {
			delta: '{"query":"hello"}',
			output_index: 0,
		}),
		...eventLine("response.output_item.done", {
			item: { type: "function_call", call_id: "call_1", name: "search" },
			output_index: 0,
		}),
	];

	it("emits stop_reason tool_use when the turn contains function calls", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...functionCallTurn,
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const payload = parseEventPayload(
			await transformed.text(),
			"message_delta",
		);

		expect(payload.delta.stop_reason).toBe("tool_use");
	});

	it("keeps stop_reason end_turn for text-only turns", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const payload = parseEventPayload(
			await transformed.text(),
			"message_delta",
		);

		expect(payload.delta.stop_reason).toBe("end_turn");
	});

	it("errors instead of synthesizing success when a tool turn ends without a terminal event", async () => {
		const provider = new CodexProvider();
		// No response.completed: even though the observed call finished, the
		// turn's completeness is unverifiable (a parallel call may be missing)
		const upstreamBody = sseBody(functionCallTurn);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).not.toContain("event: message_stop");
	});

	it("maps unknown incomplete reasons to max_tokens rather than success", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...functionCallTurn.slice(3),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.4",
					status: "incomplete",
					incomplete_details: { reason: "some_future_reason" },
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const payload = parseEventPayload(
			await transformed.text(),
			"message_delta",
		);

		expect(payload.delta.stop_reason).toBe("max_tokens");
	});

	it("maps response.incomplete max_output_tokens to stop_reason max_tokens", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "truncated tex" }),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.4",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 11, output_tokens: 64 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();
		const payload = parseEventPayload(body, "message_delta");

		expect(payload.delta.stop_reason).toBe("max_tokens");
		expect(payload.usage.output_tokens).toBe(64);
		expect(payload.usage.input_tokens).toBe(11);
		// Terminal events must not be duplicated by the stream-end fallback
		expect(body.match(/event: message_delta/g)?.length ?? 0).toBe(1);
		expect(body.match(/event: message_stop/g)?.length ?? 0).toBe(1);
	});

	it("preserves each parallel call's arguments including deltas arriving after the next call starts", async () => {
		const provider = new CodexProvider();
		// call_1's second argument delta arrives after call_2 has already started
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"a"',
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_2", name: "search" },
				output_index: 1,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: ":1}",
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"b":2}',
				output_index: 1,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_2", name: "search" },
				output_index: 1,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();
		const events = body
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map(
				(l) =>
					JSON.parse(l.slice("data:".length).trim()) as Record<
						string,
						// biome-ignore lint/suspicious/noExplicitAny: test helper
						any
					>,
			);

		// Complete arguments for both calls, exactly one stop per block
		expect(body).toContain('"partial_json":"{\\"a\\":1}"');
		expect(body).toContain('"partial_json":"{\\"b\\":2}"');
		expect(
			events.filter((e) => e.type === "content_block_stop" && e.index === 0)
				.length,
		).toBe(1);
		expect(
			events.filter((e) => e.type === "content_block_stop" && e.index === 1)
				.length,
		).toBe(1);
		// Each call's block is emitted atomically at its own output_item.done,
		// so block 0 completes before block 1 starts (strictly sequential)
		const delta0 = events.findIndex(
			(e) => e.type === "content_block_delta" && e.index === 0,
		);
		const stop0 = events.findIndex(
			(e) => e.type === "content_block_stop" && e.index === 0,
		);
		const start1 = events.findIndex(
			(e) => e.type === "content_block_start" && e.index === 1,
		);
		expect(delta0).toBeGreaterThan(-1);
		expect(stop0).toBeGreaterThan(delta0);
		expect(start1).toBeGreaterThan(stop0);
		const messageDelta = events.find((e) => e.type === "message_delta");
		expect(messageDelta?.delta.stop_reason).toBe("tool_use");
	});

	it("emits an error instead of finalizing tool calls when the stream is cut mid-arguments", async () => {
		const provider = new CodexProvider();
		// Stream dies after a partial argument delta: no output_item.done, no terminal
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"trunc',
				output_index: 0,
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).not.toContain("event: message_stop");
		expect(body).not.toContain('"input_json_delta"');
	});

	it("maps response.incomplete content_filter to stop_reason refusal", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "partial" }),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.4",
					status: "incomplete",
					incomplete_details: { reason: "content_filter" },
					usage: { input_tokens: 5, output_tokens: 3 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const payload = parseEventPayload(
			await transformed.text(),
			"message_delta",
		);

		expect(payload.delta.stop_reason).toBe("refusal");
	});

	it("returns an error response for non-streaming requests when the stream is cut mid-arguments", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_cut";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [searchTool],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_cut", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"trunc',
				output_index: 0,
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.status).toBe(502);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			any
		>;
		expect(payload.type).toBe("error");
		expect(payload.error.type).toBe("api_error");
	});

	it("flushes orphaned function_call blocks at response.completed", async () => {
		const provider = new CodexProvider();
		// output_item.done never arrives for the function call
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"q":"x"}',
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body.match(/"input_json_delta"/g)?.length ?? 0).toBe(1);
		expect(body).toContain('"partial_json":"{\\"q\\":\\"x\\"}"');
		const stopPos = body.indexOf("event: content_block_stop");
		const deltaPos = body.indexOf("event: message_delta");
		expect(stopPos).toBeGreaterThan(-1);
		expect(deltaPos).toBeGreaterThan(stopPos);
		const payload = parseEventPayload(body, "message_delta");
		expect(payload.delta.stop_reason).toBe("tool_use");
	});

	it("sets stop_reason tool_use in non-streaming SSE to JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_tool_stop_reason";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [searchTool],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...functionCallTurn,
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;

		expect(payload.stop_reason).toBe("tool_use");
	});
});

describe("parseCodexUsageHeaders", () => {
	it("normalizes primary and secondary codex quota headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "4",
			"x-codex-secondary-window-minutes": "300",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(usage?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
	});

	it("treats zero secondary window as an empty placeholder", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).toEqual({
			five_hour: {
				utilization: 0,
				resets_at: new Date(1774600000 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 11,
				resets_at: new Date(1775000000 * 1000).toISOString(),
			},
		});
	});

	it("returns null when no Codex usage headers are present", () => {
		expect(parseCodexUsageHeaders(new Headers())).toBeNull();
	});

	it("drops invalid reset timestamps instead of throwing", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1e309",
		});

		expect(parseCodexUsageHeaders(headers)).toEqual({
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
		});
	});
});

describe("parseCodexUsageHeaders reset-after handling", () => {
	it("uses the supplied base time for relative reset headers", () => {
		const baseTimeMs = Date.UTC(2026, 2, 27, 16, 0, 0);
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "600",
		});

		const usage = parseCodexUsageHeaders(headers, {
			baseTimeMs,
			allowRelativeResetAfter: true,
		});

		expect(usage?.five_hour?.resets_at).toBe(
			new Date(baseTimeMs + 600_000).toISOString(),
		);
	});
});

describe("fetchCodexUsageOnDemand", () => {
	let originalFetch: typeof fetch;
	let recorded: { url: string; init: RequestInit } | null;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		recorded = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const makeMockFetch = (response: Response) => {
		return async (input: RequestInfo | URL, init?: RequestInit) => {
			recorded = { url: String(input), init: init ?? {} };
			return response;
		};
	};

	it("sends a minimal codex request and parses usage headers", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", {
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "11",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": "1775000000",
					"x-codex-secondary-used-percent": "4",
					"x-codex-secondary-window-minutes": "300",
					"x-codex-secondary-reset-at": "1774600000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(recorded).not.toBeNull();
		expect(recorded?.url).toBe("https://example.test/codex/responses");
		expect(recorded?.init.method).toBe("POST");

		const body = JSON.parse(recorded?.init.body as string);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.max_output_tokens).toBe(1);
		expect(body.reasoning?.effort).toBe("minimal");
		expect(body.input).toHaveLength(1);
		expect(body.input[0].role).toBe("user");

		const headersInit = recorded?.init.headers as Record<string, string>;
		const headers = new Headers(headersInit);
		expect(headers.get("Authorization")).toBe("Bearer test-token");
		expect(headers.get("Openai-Beta")).toBe("responses=experimental");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("Content-Type")).toBe("application/json");

		expect(result.data?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(result.data?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
		expect(result.response.status).toBe(200);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
	});

	it("returns null data when no Codex usage headers are present", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", { status: 200 }),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(result.data).toBeNull();
		expect(result.response.status).toBe(200);
	});

	it("preserves headers and status on a 429 so callers can persist rate_limit_reset", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("rate limited", {
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1775000000",
					"x-codex-secondary-used-percent": "82",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-at": "1774700000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(result.response.status).toBe(429);
		expect(result.data?.five_hour.utilization).toBe(100);
		expect(result.data?.five_hour.resets_at).toBe(
			new Date(1775000000 * 1000).toISOString(),
		);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
	});

	it("rejects an empty access token before issuing a request", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		await expect(fetchCodexUsageOnDemand("")).rejects.toThrow(
			/non-empty access token/,
		);
		expect(called).toBe(false);
	});
});
