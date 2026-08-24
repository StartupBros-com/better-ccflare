import { describe, expect, test } from "bun:test";
import {
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import {
	MAX_RESPONSES_CONTENT_PARTS,
	MAX_RESPONSES_INPUT_ITEMS,
} from "../request-limits";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponseItem, ResponsesRequest } from "../types";

function captureWarnings(fn: () => void): LogEvent[] {
	const captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		if (event.level === "WARN") captured.push(event);
	};
	logBus.on("log", handler);
	try {
		fn();
	} finally {
		logBus.off("log", handler);
	}
	return captured;
}

describe("translateRequestToAnthropic", () => {
	test("simple user message → single messages entry", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hello" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "Hello" },
		]);
	});

	test("user + assistant exchange → two messages", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hi" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Hello!" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[1].role).toBe("assistant");
		expect(result.messages[1].content).toEqual([
			{ type: "text", text: "Hello!" },
		]);
	});

	test("function_call item appended to assistant message", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Using tool..." }],
				},
				{
					type: "function_call",
					call_id: "call_123",
					name: "my_tool",
					arguments: '{"key":"value"}',
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[1]).toEqual({
			type: "tool_use",
			id: "call_123",
			name: "my_tool",
			input: { key: "value" },
		});
	});

	test("function_call_output → new user message with tool_result", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call_output",
					call_id: "call_abc",
					output: "result data",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toEqual([
			{ type: "tool_result", tool_use_id: "call_abc", content: "result data" },
		]);
	});

	test("mixed conversation: user, assistant+function_call, function_call_output, user", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Do the thing" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Calling tool..." }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "do_thing",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "done",
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Thanks" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		// Expected: [user, assistant(text+tool_use), user(tool_result+text)]
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toHaveLength(1);
		expect(result.messages[1].role).toBe("assistant");
		expect(result.messages[1].content).toHaveLength(2);
		expect(result.messages[1].content[1]).toMatchObject({
			type: "tool_use",
			name: "do_thing",
		});
		expect(result.messages[2].role).toBe("user");
		expect(result.messages[2].content).toHaveLength(2);
		expect(result.messages[2].content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call_1",
		});
		expect(result.messages[2].content[1]).toEqual({
			type: "text",
			text: "Thanks",
		});
	});

	test("consecutive same-role messages get merged", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "First" }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Second" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "First",
		});
		expect(result.messages[0].content[1]).toEqual({
			type: "text",
			text: "Second",
		});
	});

	test("instructions maps to system", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			instructions: "You are a helpful assistant.",
		};
		const result = translateRequestToAnthropic(req);
		expect(result.system).toBe("You are a helpful assistant.");
	});

	test("max_output_tokens=100 → max_tokens=100", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			max_output_tokens: 100,
		};
		const result = translateRequestToAnthropic(req);
		expect(result.max_tokens).toBe(100);
	});

	test("no max_output_tokens → max_tokens=4096", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.max_tokens).toBe(4096);
	});

	test('tool_choice "auto" → {type:"auto"}, "required" → {type:"any"}', () => {
		const fnTool = {
			type: "function" as const,
			name: "my_fn",
			description: "A function",
			parameters: {},
		};

		const req1: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [fnTool],
			tool_choice: "auto",
		};
		expect(translateRequestToAnthropic(req1).tool_choice).toEqual({
			type: "auto",
		});

		const req2: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [fnTool],
			tool_choice: "required",
		};
		expect(translateRequestToAnthropic(req2).tool_choice).toEqual({
			type: "any",
		});

		const req3: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [fnTool],
			tool_choice: "none",
		};
		expect(translateRequestToAnthropic(req3).tool_choice).toEqual({
			type: "none",
		});

		const req4: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [fnTool],
			tool_choice: { type: "function", name: "my_fn" },
		};
		expect(translateRequestToAnthropic(req4).tool_choice).toEqual({
			type: "tool",
			name: "my_fn",
		});

		const req5: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
		};
		expect(translateRequestToAnthropic(req5).tool_choice).toBeUndefined();

		// tool_choice without any function tools (only built-in) → suppressed to avoid Anthropic 400
		const req6: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tool_choice: "auto",
		};
		expect(translateRequestToAnthropic(req6).tool_choice).toBeUndefined();
	});

	test("tool schema: parameters field becomes input_schema", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [
				{
					type: "function",
					name: "my_tool",
					description: "Does something",
					parameters: { type: "object", properties: { x: { type: "string" } } },
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.tools).toHaveLength(1);
		expect(result.tools?.[0]).toEqual({
			name: "my_tool",
			description: "Does something",
			input_schema: { type: "object", properties: { x: { type: "string" } } },
		});
	});

	test("tool with no parameters → input_schema is empty object", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [
				{
					type: "function",
					name: "simple_tool",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.tools?.[0].input_schema).toEqual({});
	});

	test("function tool with null parameters keeps required tool choice and normalizes its schema", () => {
		const req = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [{ type: "function", name: "simple_tool", parameters: null }],
			tool_choice: "required",
		};
		const result = translateRequestToAnthropic(
			req as unknown as ResponsesRequest & { input: ResponseItem[] },
		);
		expect(result.tools).toEqual([
			{ name: "simple_tool", description: undefined, input_schema: {} },
		]);
		expect(result.tool_choice).toEqual({ type: "any" });
	});

	test("refusal content maps to text", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "refusal", refusal: "I cannot do that" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "I cannot do that",
		});
	});

	test("input_image URL maps to anthropic image url source", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "https://example.com/image.png",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "image",
			source: { type: "url", url: "https://example.com/image.png" },
		});
	});

	test("input_image data URL maps to anthropic base64 source", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "data:image/png;base64,abc123",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "abc123",
			},
		});
	});

	test("input_image with only file_id maps to placeholder text", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							file_id: "file_123",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "[image file_id: file_123]",
		});
	});

	test("mixed text + input_image preserves content order", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Before" },
						{ type: "input_image", image_url: "https://example.com/a.png" },
						{ type: "input_text", text: "After" },
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "Before" },
			{
				type: "image",
				source: { type: "url", url: "https://example.com/a.png" },
			},
			{ type: "text", text: "After" },
		]);
	});

	test("function_call with invalid JSON arguments falls back to {}", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call_bad",
					name: "broken_tool",
					arguments: "not valid json",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			input: unknown;
		};
		expect(toolUse.input).toEqual({});
	});

	test("custom_tool_call appended like function_call", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "custom_tool_call",
					call_id: "call_custom",
					name: "custom_fn",
					arguments: '{"a":1}',
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_use",
			id: "call_custom",
			name: "custom_fn",
			input: { a: 1 },
		});
	});

	test("custom_tool_call_output → user message with tool_result", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "custom_tool_call_output",
					call_id: "call_custom",
					output: "custom result",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "call_custom",
			content: "custom result",
		});
	});

	test("model passthrough for non-gpt-5 names", () => {
		const req: ResponsesRequest = {
			model: "claude-opus-4-5",
			input: [],
		};
		expect(translateRequestToAnthropic(req).model).toBe("claude-opus-4-5");
	});

	test("gpt-5 model mapping — *-pro maps to opus family alias", () => {
		for (const model of ["gpt-5.5-pro", "gpt-5.4-pro", "GPT-5.5-PRO"]) {
			expect(translateRequestToAnthropic({ model, input: [] }).model).toBe(
				LATEST_OPUS_MODEL,
			);
		}
	});

	test("gpt-5 model mapping — *-mini and *-nano map to haiku family alias", () => {
		for (const model of ["gpt-5.4-mini", "gpt-5.4-nano", "GPT-5.4-MINI"]) {
			expect(translateRequestToAnthropic({ model, input: [] }).model).toBe(
				LATEST_HAIKU_MODEL,
			);
		}
	});

	test("gpt model mapping — no suffix maps to sonnet family alias", () => {
		for (const model of [
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.3-codex",
			"gpt-5",
			"gpt-4",
			"gpt-4o",
		]) {
			expect(translateRequestToAnthropic({ model, input: [] }).model).toBe(
				LATEST_SONNET_MODEL,
			);
		}
	});

	test("non-gpt model names pass through unchanged", () => {
		expect(translateRequestToAnthropic({ model: "o3", input: [] }).model).toBe(
			"o3",
		);
	});

	test("stream passthrough", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			stream: true,
		};
		expect(translateRequestToAnthropic(req).stream).toBe(true);
	});

	test("local_shell_call → tool_use appended to trailing assistant message, action passed through unparsed", () => {
		const action = {
			type: "exec" as const,
			command: ["ls", "-la"],
			timeout_ms: 5000,
		};
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Running shell..." }],
				},
				{
					type: "local_shell_call",
					call_id: "shell_1",
					action,
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[1]).toEqual({
			type: "tool_use",
			id: "shell_1",
			name: "local_shell",
			input: action,
		});
		// Verify the exact same object reference/shape — not re-parsed via JSON.
		expect(
			(
				result.messages[0].content[1] as {
					input: typeof action;
				}
			).input,
		).toBe(action);
	});

	test("local_shell_call with no call_id or id → dropped with warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call",
					action: { type: "exec", command: ["echo", "hi"] },
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("local_shell_call");
	});

	test("local_shell_call_output with call_id → tool_result tool_use_id === call_id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call_output",
					call_id: "shell_1",
					output: "total 0",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "shell_1",
			content: "total 0",
		});
	});

	test("local_shell_call_output with only id (no call_id) → tool_result tool_use_id === id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call_output",
					id: "shell_out_1",
					output: "total 0",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "shell_out_1",
			content: "total 0",
		});
	});

	test("local_shell_call_output with neither call_id nor id → dropped with one warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call_output",
					output: "total 0",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("local_shell_call_output");
		expect(warnings[0].msg).toContain("call_id/id");
	});

	test("agent_message with input_text → new user message with formatted text", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [{ type: "input_text", text: "do X" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[agent message from planner to coder]: do X",
					},
				],
			},
		]);
	});

	test("agent_message with only encrypted_content → placeholder text + warning mentioning encrypted_content and author", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						{ type: "encrypted_content", encrypted_content: "abc123==" },
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "(sub-agent message received)" }],
				},
			]);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("encrypted_content");
		expect(warnings[0].msg).toContain("planner");
	});

	test("reasoning-only item is dropped to nothing, warns about signature", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [{ type: "reasoning" }],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("reasoning");
		expect(warnings[0].msg).toContain("signature");
	});

	test("reasoning after an assistant tool_use is dropped, not merged in as a thinking or extra tool_use block", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				// Establishes a trailing assistant message so the planted-negative
				// assertions below run against real content — a bare reasoning item
				// emits nothing, leaving no message to inspect.
				{
					type: "function_call",
					call_id: "call_1",
					name: "do_thing",
					arguments: "{}",
				},
				{ type: "reasoning" },
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			// The function_call produced exactly one assistant tool_use; the
			// dropped reasoning item must not have appended anything to it.
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("assistant");
			expect(result.messages[0].content).toHaveLength(1);
			expect(result.messages[0].content[0].type).toBe("tool_use");
			for (const msg of result.messages) {
				for (const c of msg.content) {
					expect(c.type).not.toBe("thinking");
				}
			}
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("reasoning");
		expect(warnings[0].msg).toContain("signature");
	});

	test("unknown/future item type does not throw, drops item, warns with the literal type string", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "web_search_call",
					// biome-ignore lint/suspicious/noExplicitAny: exercising an unmodeled future item type
				} as any,
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		const warnings = captureWarnings(() => {
			expect(() => {
				result = translateRequestToAnthropic(req);
			}).not.toThrow();
		});
		expect(result?.messages).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("web_search_call");
	});

	test("compaction_trigger and compaction items are dropped with type-specific warnings", () => {
		const triggerReq: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [{ type: "compaction_trigger" }],
		};
		const triggerWarnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(triggerReq);
			expect(result.messages).toHaveLength(0);
		});
		expect(triggerWarnings).toHaveLength(1);
		expect(triggerWarnings[0].msg).toContain("control signal");
		expect(triggerWarnings[0].msg).not.toContain(
			"no Anthropic mapping implemented",
		);

		const compactionReq: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [{ type: "compaction" }],
		};
		const compactionWarnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(compactionReq);
			expect(result.messages).toHaveLength(0);
		});
		expect(compactionWarnings).toHaveLength(1);
		expect(compactionWarnings[0].msg).toContain("encrypted_content");
		expect(compactionWarnings[0].msg).not.toContain(
			"no Anthropic mapping implemented",
		);
	});

	test("local_shell_call with an empty-string call_id and no id is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call",
					call_id: "",
					action: { type: "exec", command: ["ls"] },
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("local_shell_call");
		expect(warnings[0].msg).toContain("no usable");
	});

	test("local_shell_call_output with an empty-string call_id and no id is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call_output",
					call_id: "",
					output: "result text",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("local_shell_call_output");
		expect(warnings[0].msg).toContain("no usable");
	});

	test("agent_message with a non-array content is dropped without throwing, warns with the author", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed input missing the required content array
				} as any,
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		const warnings = captureWarnings(() => {
			expect(() => {
				result = translateRequestToAnthropic(req);
			}).not.toThrow();
		});
		expect(result?.messages).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("agent_message");
		expect(warnings[0].msg).toContain("planner");
	});

	test("local_shell_call missing its action still emits a tool_use with an empty-object input", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call",
					call_id: "call_sh",
					// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed input missing the required action
				} as any,
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.messages[0].content).toEqual([
			{ type: "tool_use", id: "call_sh", name: "local_shell", input: {} },
		]);
	});

	test("local_shell_call with a non-object action coerces input to an empty object", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call",
					call_id: "call_sh",
					// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed input whose action is a bare string, not an object
					action: "ls -la" as any,
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.messages[0].content).toEqual([
			{ type: "tool_use", id: "call_sh", name: "local_shell", input: {} },
		]);
	});

	test("message with a non-array content is dropped without throwing, warns with the role", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed input whose content is not an array
				} as any,
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		const warnings = captureWarnings(() => {
			expect(() => {
				result = translateRequestToAnthropic(req);
			}).not.toThrow();
		});
		expect(result?.messages).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("message");
		expect(warnings[0].msg).toContain("user");
	});

	test("function_call with an empty-string call_id is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "",
					name: "get_weather",
					arguments: "{}",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("function_call");
		expect(warnings[0].msg).toContain("no usable call_id");
	});

	test("function_call_output with an empty-string call_id is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call_output",
					call_id: "",
					output: "result",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("function_call_output");
		expect(warnings[0].msg).toContain("no usable call_id");
	});
	test("message with a null content element is dropped without throwing, keeps the valid element", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content element (null)
						null as any,
						{ type: "input_text", text: "keep me" },
					],
				},
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		const warnings = captureWarnings(() => {
			expect(() => {
				result = translateRequestToAnthropic(req);
			}).not.toThrow();
		});
		expect(result?.messages).toHaveLength(1);
		expect(result?.messages[0].content).toEqual([
			{ type: "text", text: "keep me" },
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("user");
	});

	test("agent_message with a null content element is dropped without throwing, keeps the valid element", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content element (null)
						null as any,
						{ type: "input_text", text: "hi" },
					],
				},
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		const warnings = captureWarnings(() => {
			expect(() => {
				result = translateRequestToAnthropic(req);
			}).not.toThrow();
		});
		expect(result?.messages).toHaveLength(1);
		const block = result?.messages[0].content[0] as {
			type: string;
			text: string;
		};
		expect(block.type).toBe("text");
		expect(block.text).toContain("hi");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("planner");
	});

	test("function_call with a non-string call_id (number) is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed call_id (number, not string)
					call_id: 1 as any,
					name: "get_weather",
					arguments: "{}",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("function_call");
		expect(warnings[0].msg).toContain("no usable call_id");
	});

	test("function_call_output with a non-string call_id (object) is dropped with a warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call_output",
					// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed call_id (object, not string)
					call_id: {} as any,
					output: "result",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("function_call_output");
		expect(warnings[0].msg).toContain("no usable call_id");
	});

	test("local_shell_call with a non-string call_id falls back to the string id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "local_shell_call",
					// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed call_id (number, not string)
					call_id: 123 as any,
					id: "real-id",
					action: { type: "exec", command: ["ls"] },
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		const block = result.messages[0].content[0] as { type: string; id: string };
		expect(block.type).toBe("tool_use");
		expect(block.id).toBe("real-id");
	});

	// --- Finding #2: string-form message content (OpenAI shorthand) ---

	test("message with string content → single text block, no warnings", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: "hello",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[0].content).toEqual([
				{ type: "text", text: "hello" },
			]);
		});
		expect(warnings).toHaveLength(0);
	});

	test("developer message with string content → merged into system, no messages entry", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					// biome-ignore lint/suspicious/noExplicitAny: exercising the Codex CLI "developer" role, which is outside the user|assistant role type
					role: "developer" as any,
					content: "system instr",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(0);
		expect(result.system).toContain("system instr");
	});

	// --- Findings #1 / #4: malformed-content warn batching + empty-content drop ---

	test("message with a single null content element (only element) is dropped entirely, not emitted as an empty-content message", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content element (null)
						null as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("user");
	});

	test("message with all-malformed content elements warns once with the count, not once per element", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content elements (null)
						null as any,
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content elements (null)
						null as any,
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content elements (null)
						null as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		const malformedWarnings = warnings.filter((w) =>
			w.msg.includes("malformed"),
		);
		expect(malformedWarnings).toHaveLength(1);
		expect(malformedWarnings[0].msg).toContain("3");
	});

	test("message with an empty content array is dropped with a 'no usable content' warning", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("no usable content");
	});

	test("agent_message with two malformed elements and one valid warns once for the malformed batch", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content elements (null)
						null as any,
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content elements (null)
						null as any,
						{ type: "input_text", text: "hi" },
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(1);
			const block = result.messages[0].content[0] as {
				type: string;
				text: string;
			};
			expect(block.text).toContain("hi");
		});
		const malformedWarnings = warnings.filter((w) =>
			w.msg.includes("malformed"),
		);
		expect(malformedWarnings).toHaveLength(1);
	});

	// --- Finding #3: tool id grammar sanitization ---

	test("function_call with a grammar-invalid call_id emits a sanitized tool_use id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call:1",
					name: "get_weather",
					arguments: "{}",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			id: string;
		};
		expect(toolUse.id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(toolUse.id).not.toBe("call:1");
	});

	test("function_call/function_call_output pairing survives id sanitization — both sides map to the same emitted id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call:1",
					name: "get_weather",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "call:1",
					output: "ok",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			id: string;
		};
		const toolResult = result.messages[1].content[0] as {
			type: string;
			tool_use_id: string;
		};
		expect(toolUse.id).toBe(toolResult.tool_use_id);
		expect(toolUse.id).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test("function_call with an already-grammar-valid call_id is emitted unchanged", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call_abc123",
					name: "get_weather",
					arguments: "{}",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			id: string;
		};
		expect(toolUse.id).toBe("call_abc123");
	});

	// --- P1 finding #1: quadratic tool-ID collision resolution ---

	test("many call_ids sanitizing to the same candidate all get distinct, grammar-valid emitted ids", () => {
		// Each call_id embeds a distinct single Unicode symbol (code points
		// starting at U+2200, "FOR ALL") that is grammar-invalid per
		// ANTHROPIC_TOOL_ID_RE. Sanitization replaces any single disallowed
		// char with one "_", so every call_id below — despite being pairwise
		// distinct originals — collapses to the identical sanitized candidate
		// ("call_1"), forcing the collision-resolution path on every item.
		const count = 50;
		const collidingInput = Array.from({ length: count }, (_, i) => ({
			type: "function_call" as const,
			call_id: `call${String.fromCodePoint(0x2200 + i)}1`,
			name: "get_weather",
			arguments: "{}",
		}));
		// Sanity check on the fixture itself: all originals distinct, all
		// sanitize to the same candidate.
		expect(new Set(collidingInput.map((i) => i.call_id)).size).toBe(count);
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: collidingInput,
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toHaveLength(count);
		const ids = result.messages[0].content.map((c) => {
			const block = c as { type: string; id: string };
			expect(block.type).toBe("tool_use");
			expect(block.id).toMatch(/^[A-Za-z0-9_-]+$/);
			return block.id;
		});
		expect(new Set(ids).size).toBe(count);
	});

	test("tool_use/tool_result pairing survives id sanitization under collision (call_id 'call:1')", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call:1",
					name: "get_weather",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "call:1",
					output: "ok",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			id: string;
		};
		const toolResult = result.messages[1].content[0] as {
			type: string;
			tool_use_id: string;
		};
		expect(toolUse.id).toBe(toolResult.tool_use_id);
	});

	// --- P1 finding #2: object-shaped malformed content bypasses validation ---

	test("message content with a non-string (number) text is dropped with no non-string text emitted, warns once", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content part (non-string text)
						{ type: "input_text", text: 1 } as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("invalid");
	});

	test("message content with one valid text part and one non-string ({}) text part keeps only the valid part, warns once", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "ok" },
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content part (non-string text)
						{ type: "input_text", text: {} } as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].content).toEqual([
				{ type: "text", text: "ok" },
			]);
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("invalid");
	});

	test("many unknown-type content parts in one message produce exactly one batched reject warning, not one per element", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content parts (unknown type)
						{ type: "nope" } as any,
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content parts (unknown type)
						{ type: "nope" } as any,
						// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content parts (unknown type)
						{ type: "nope" } as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		const rejectWarnings = warnings.filter((w) => w.msg.includes("invalid"));
		expect(rejectWarnings).toHaveLength(1);
	});

	test("unknown content type is dropped entirely (no empty text block emitted), keeps the valid sibling part", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime-malformed content part (unknown type)
						{ type: "weird" } as any,
						{ type: "input_text", text: "hi" },
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].content).toEqual([
				{ type: "text", text: "hi" },
			]);
		});
		const rejectWarnings = warnings.filter((w) => w.msg.includes("invalid"));
		expect(rejectWarnings).toHaveLength(1);
	});

	// --- P1 finding #3: empty text/refusal strings emit empty text blocks ---

	test("message with an empty-string input_text is dropped, not emitted as an empty text block", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "" }],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		const rejectWarnings = warnings.filter((w) => w.msg.includes("invalid"));
		expect(rejectWarnings).toHaveLength(1);
	});

	test("message with an empty string content (shorthand) is dropped, not emitted as an empty text block", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: "",
				},
			],
		};
		let result: ReturnType<typeof translateRequestToAnthropic> | undefined;
		expect(() => {
			result = translateRequestToAnthropic(req);
		}).not.toThrow();
		expect(result?.messages).toHaveLength(0);
	});

	test("message content with one empty text part and one valid text part keeps only the valid part", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "" },
						{ type: "input_text", text: "hi" },
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
	});

	test("message with an empty-string refusal is dropped, not emitted as an empty text block", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "refusal", refusal: "" }],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		const rejectWarnings = warnings.filter((w) => w.msg.includes("invalid"));
		expect(rejectWarnings).toHaveLength(1);
	});

	test("message with a non-empty string content (shorthand) still produces a text block unchanged (regression guard)", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: "hello",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
	});

	// --- P2 finding #4: agent_message with only unknown-type junk fabricates a placeholder ---

	test("agent_message with only unknown-type junk content is dropped entirely, does not fabricate the placeholder", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						// biome-ignore lint/suspicious/noExplicitAny: exercising an unmodeled/unknown agent_message content part type
						{ type: "nope" } as any,
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		const rejectWarnings = warnings.filter((w) =>
			w.msg.includes("unsupported"),
		);
		expect(rejectWarnings).toHaveLength(1);
		expect(
			warnings.some((w) => w.msg.includes("sub-agent message received")),
		).toBe(false);
	});

	test("agent_message with only encrypted_content still emits the placeholder (encrypted-only case preserved)", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						{ type: "encrypted_content", encrypted_content: "abc123==" },
					],
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "(sub-agent message received)" }],
				},
			]);
		});
		expect(warnings.some((w) => w.msg.includes("encrypted_content"))).toBe(
			true,
		);
	});

	test("agent_message with a real input_text produces the formatted agent-message text unchanged", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [{ type: "input_text", text: "do X" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[agent message from planner to coder]: do X",
					},
				],
			},
		]);
	});

	// --- P1 finding #1: request-wide log-amplification (item count + warn budget) ---

	test("does not truncate translator input; handler owns item-count admission", () => {
		const items: ResponseItem[] = Array.from(
			{ length: MAX_RESPONSES_INPUT_ITEMS + 5 },
			() => ({
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "x" }],
			}),
		);
		const result = translateRequestToAnthropic({
			model: "claude-3-5-sonnet-20241022",
			input: items,
		});
		const totalParts = result.messages.reduce(
			(sum, message) => sum + message.content.length,
			0,
		);
		expect(totalParts).toBe(MAX_RESPONSES_INPUT_ITEMS + 5);
	});

	test("does not truncate direct message content; handler owns content-part admission", () => {
		const partCount = MAX_RESPONSES_CONTENT_PARTS + 1;
		const result = translateRequestToAnthropic({
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: Array.from({ length: partCount }, () => ({
						type: "input_text" as const,
						text: "x",
					})),
				},
			],
		});
		expect(result.messages[0].content).toHaveLength(partCount);
	});

	test("request-scoped warn budget caps total warnings emitted from many per-item warns", () => {
		// Must match the module consts of the same name in request-translator.ts.
		const MAX_REQUEST_WARNS = 50;
		const items = Array.from({ length: 120 }, () => ({
			type: "message" as const,
			role: "user" as const,
			// Each item's sole content part is malformed (null), producing exactly
			// one "malformed" summary warn per item — 120 raw warn calls total.
			// biome-ignore lint/suspicious/noExplicitAny: exercising runtime-malformed content (null) at scale to exercise the warn budget
			content: [null as any],
		}));
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: items,
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(0);
		});
		// Budget + the single "further ... suppressed" summary — NOT ~120.
		expect(warnings.length).toBeLessThanOrEqual(MAX_REQUEST_WARNS + 1);
		expect(warnings.some((w) => w.msg.includes("suppressed"))).toBe(true);
	});

	test("keeps only the first call and result for a repeated original function call_id", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "one",
					arguments: "{}",
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "two",
					arguments: "{}",
				},
				{ type: "function_call_output", call_id: "call_1", output: "first" },
				{ type: "function_call_output", call_id: "call_1", output: "second" },
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toEqual([
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_1", name: "one", input: {} }],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "first" },
					],
				},
			]);
		});
		expect(warnings).toHaveLength(2);
		expect(warnings.every((warning) => warning.msg.includes("duplicate"))).toBe(
			true,
		);
	});

	test("deduplicates original IDs across function, custom, and local-shell call variants", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "shared",
					name: "one",
					arguments: "{}",
				},
				{
					type: "local_shell_call",
					call_id: "shared",
					action: { type: "exec", command: ["pwd"] },
				},
				{ type: "custom_tool_call_output", call_id: "shared", output: "first" },
				{
					type: "local_shell_call_output",
					call_id: "shared",
					output: "second",
				},
			],
		};
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(req);
			expect(result.messages).toHaveLength(2);
			expect(result.messages[0].content).toHaveLength(1);
			expect(result.messages[1].content).toEqual([
				{ type: "tool_result", tool_use_id: "shared", content: "first" },
			]);
		});
		expect(warnings).toHaveLength(2);
	});

	test("keeps one sanitized pair when an invalid original ID is repeated", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call:1",
					name: "one",
					arguments: "{}",
				},
				{
					type: "custom_tool_call",
					call_id: "call:1",
					name: "two",
					arguments: "{}",
				},
				{ type: "function_call_output", call_id: "call:1", output: "first" },
				{
					type: "custom_tool_call_output",
					call_id: "call:1",
					output: "second",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as { id: string };
		const toolResult = result.messages[1].content[0] as { tool_use_id: string };
		expect(toolUse.id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(toolUse.id).toBe(toolResult.tool_use_id);
		expect(result.messages[0].content).toHaveLength(1);
		expect(result.messages[1].content).toHaveLength(1);
	});

	test("drops null, primitive, and array top-level input items without throwing", () => {
		const req = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				null,
				7,
				[],
				{ type: "message", role: "user", content: "keep me" },
			],
		} as ResponsesRequest;
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(
				req as ResponsesRequest & { input: ResponseItem[] },
			);
			expect(result.messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "keep me" }] },
			]);
		});
		expect(warnings).toHaveLength(3);
	});

	test("does not fabricate an encrypted-agent placeholder from missing, empty, or non-string ciphertext", () => {
		const req = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "agent_message",
					author: "planner",
					recipient: "coder",
					content: [
						{ type: "encrypted_content" },
						{ type: "encrypted_content", encrypted_content: "" },
						{ type: "encrypted_content", encrypted_content: 1 },
					],
				},
			],
		} as ResponsesRequest;
		const warnings = captureWarnings(() => {
			const result = translateRequestToAnthropic(
				req as ResponsesRequest & { input: ResponseItem[] },
			);
			expect(result.messages).toHaveLength(0);
		});
		expect(warnings.some((warning) => warning.msg.includes("malformed"))).toBe(
			true,
		);
	});

	test("shares one warning budget between malformed input items and tools", () => {
		const req = {
			model: "claude-3-5-sonnet-20241022",
			input: Array.from({ length: 50 }, () => ({
				type: "message",
				role: "user",
				content: [null],
			})),
			tools: Array.from({ length: 10 }, () => null),
		} as ResponsesRequest;
		const warnings = captureWarnings(() => {
			expect(() =>
				translateRequestToAnthropic(
					req as ResponsesRequest & { input: ResponseItem[] },
				),
			).not.toThrow();
		});
		expect(warnings).toHaveLength(51);
		expect(warnings.at(-1)?.msg).toBe(
			"10 further translation warning(s) suppressed",
		);
	});
});
