import { describe, expect, test } from "bun:test";
import { BoundedJsonTooLargeError } from "@better-ccflare/core";
import {
	getCustomToolNames,
	getRequestTools,
	getResponseToolIdentity,
	getTranslatedToolName,
} from "../custom-tools";
import { translateRequestToAnthropic } from "../request-translator";
import { translateAnthropicResponseToResponses } from "../response-translator";
import type { ResponseItem, ResponsesRequest, ResponsesTool } from "../types";

describe("Responses Lite tool declarations", () => {
	test("extracts additional_tools namespaces and round-trips calls with their identities", () => {
		const req: ResponsesRequest = {
			model: "gpt-6-astra",
			input: [
				{
					type: "additional_tools",
					id: "at_1",
					role: "developer",
					tools: [
						{
							type: "namespace",
							name: "functions",
							tools: [
								{
									type: "custom",
									name: "exec",
									description: "Execute JavaScript.",
								},
								{
									type: "function",
									name: "wait",
									parameters: { type: "object" },
								},
							],
						},
						{
							type: "namespace",
							name: "clock",
							description: "Time tools",
							tools: [
								{
									type: "function",
									name: "wait",
									parameters: { type: "object" },
								},
							],
						},
					],
				},
				{ type: "message", role: "user", content: "Edit a file" },
			],
		};
		const original = structuredClone(req);
		const translated = translateRequestToAnthropic(req);
		const tools = getRequestTools(req);
		const exec = getTranslatedToolName("exec", "functions");
		const functionWait = getTranslatedToolName("wait", "functions");
		const clockWait = getTranslatedToolName("wait", "clock");
		expect(translated.tools?.map((tool) => tool.name)).toEqual([
			exec,
			functionWait,
			clockWait,
		]);
		expect(functionWait).not.toBe(clockWait);
		expect(translated.tools?.[0].input_schema).toMatchObject({
			properties: { input: { type: "string" } },
		});
		expect(translated.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Edit a file" }] },
		]);
		expect(req).toEqual(original);

		const code =
			'text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));';
		const response = translateAnthropicResponseToResponses(
			{
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [
					{
						type: "tool_use",
						id: "call_exec",
						name: exec,
						input: { input: code },
					},
					{
						type: "tool_use",
						id: "call_wait",
						name: clockWait,
						input: { duration_ms: 10 },
					},
				],
				stop_reason: "tool_use",
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 20 },
			},
			"resp_1",
			req.model,
			tools,
		);
		expect(response.output[0]).toMatchObject({
			type: "custom_tool_call",
			name: "exec",
			namespace: "functions",
			input: code,
		});
		expect(response.output[1]).toMatchObject({
			type: "function_call",
			name: "wait",
			namespace: "clock",
			arguments: '{"duration_ms":10}',
		});
		const replay = translateRequestToAnthropic({
			...req,
			input: [
				...(original.input as Exclude<ResponsesRequest["input"], string>),
				...response.output,
			],
		});
		expect(replay.messages[1].content).toEqual([
			{ type: "tool_use", id: "call_exec", name: exec, input: { input: code } },
			{
				type: "tool_use",
				id: "call_wait",
				name: clockWait,
				input: { duration_ms: 10 },
			},
		]);
	});

	test("later tool declarations replace repeated names while keeping distinct namespaces", () => {
		const tools = getRequestTools({
			input: [
				{
					type: "additional_tools",
					role: "developer",
					tools: [
						{ type: "custom", name: "exec", description: "old" },
						{
							type: "namespace",
							name: "functions",
							tools: [{ type: "custom", name: "exec" }],
						},
					],
				},
			],
			tools: [{ type: "custom", name: "exec", description: "new" }],
		});
		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({ name: "exec", description: "new" });
		expect(tools[1]).toMatchObject({ name: "exec", namespace: "functions" });
	});

	test("namespace aliases meet Anthropic limits and resolve exactly for long names", () => {
		const name = "tool_".repeat(40);
		const namespace = "mcp__app.with.special/chars";
		const alias = getTranslatedToolName(name, namespace);
		expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(
			getResponseToolIdentity(alias, [{ type: "custom", name, namespace }]),
		).toEqual({ name, namespace });
	});
});

describe("bounded namespace expansion", () => {
	test("rejects aggregate sibling expansion before copying any leaf", () => {
		let payloadCopies = 0;
		const leaf = (name: string): ResponsesTool => ({
			type: "function",
			name,
			get parameters() {
				payloadCopies++;
				return { type: "object" };
			},
		});
		const request = {
			input: "hello",
			tools: [
				{
					type: "namespace" as const,
					name: "tools",
					description: "x".repeat(80),
					tools: [leaf("a"), leaf("b")],
				},
			],
		};
		// Each leaf fits; their combined inherited descriptions do not.
		expect(() => getRequestTools(request, 100)).toThrow(
			BoundedJsonTooLargeError,
		);
		expect(payloadCopies).toBe(0);
	});

	test("counts nested namespace names, UTF-8 descriptions and separators at the byte boundary", () => {
		const request = {
			input: "hello",
			tools: [
				{
					type: "namespace" as const,
					name: "tools",
					description: "é",
					tools: [
						{
							type: "namespace" as const,
							name: "nested",
							description: "子",
							tools: [
								{ type: "custom" as const, name: "exec", description: "🙂" },
							],
						},
					],
				},
			],
		};
		const expectedBytes =
			Buffer.byteLength("tools.nested") +
			Buffer.byteLength("exec") +
			Buffer.byteLength("é\n\n子\n\n🙂");
		expect(() => getRequestTools(request, expectedBytes - 1)).toThrow(
			BoundedJsonTooLargeError,
		);
		expect(getRequestTools(request, expectedBytes)).toEqual([
			{
				type: "custom",
				name: "exec",
				namespace: "tools.nested",
				description: "é\n\n子\n\n🙂",
			},
		]);
	});

	test("budgets duplicate leaves before deduplication and inherited names without descriptions", () => {
		const request = {
			input: "hello",
			tools: [
				{
					type: "namespace" as const,
					name: "long_namespace",
					tools: [
						{ type: "function" as const, name: "exec" },
						{ type: "function" as const, name: "exec" },
					],
				},
			],
		};
		expect(() => getRequestTools(request, 20)).toThrow(
			BoundedJsonTooLargeError,
		);
	});

	test("translation and repeated response lookups reuse prepared declarations", () => {
		const request: ResponsesRequest & { input: ResponseItem[] } = {
			model: "test",
			input: [{ type: "message", role: "user", content: "hello" }],
			tools: [
				{
					type: "namespace",
					name: "tools",
					description: "Tools",
					tools: [{ type: "custom", name: "exec", description: "Execute" }],
				},
			],
		};
		const prepared = getRequestTools(request, 1024);
		Object.defineProperty(request, "tools", {
			get() {
				throw new Error("Repeated namespace expansion");
			},
		});
		const translated = translateRequestToAnthropic(
			request,
			undefined,
			prepared,
		);
		expect(translated.tools?.[0].description).toStartWith("Tools\n\nExecute");
		Object.defineProperty(prepared[0], "description", {
			get() {
				throw new Error("Response lookup copied a declaration");
			},
		});
		const alias = getTranslatedToolName("exec", "tools");
		for (let i = 0; i < 3; i++) {
			expect(getCustomToolNames(prepared)).toEqual(new Set([alias]));
			expect(getResponseToolIdentity(alias, prepared)).toEqual({
				name: "exec",
				namespace: "tools",
			});
		}
	});
});

test("direct translation and response helpers retain the default expansion ceiling", () => {
	const tools: ResponsesTool[] = [
		{
			type: "namespace",
			name: "tools",
			description: "x".repeat(4096),
			tools: Array.from({ length: 8193 }, () => ({
				type: "custom",
				name: "exec",
			})),
		},
	];
	const request: ResponsesRequest & { input: ResponseItem[] } = {
		model: "test",
		tools,
		input: [{ type: "message", role: "user", content: "hello" }],
	};
	expect(() => translateRequestToAnthropic(request)).toThrow(
		BoundedJsonTooLargeError,
	);
	expect(() => getCustomToolNames(tools)).toThrow(BoundedJsonTooLargeError);
	expect(() => getResponseToolIdentity("exec", tools)).toThrow(
		BoundedJsonTooLargeError,
	);
});

test("unknown namespaced declarations cannot bypass the expansion ceiling", () => {
	const tools = [
		{
			type: "namespace",
			name: "x".repeat(80),
			tools: [{ type: "web_search" }, { type: "web_search" }],
		},
	] as ResponsesTool[];
	expect(() => getRequestTools({ input: "hello", tools }, 100)).toThrow(
		BoundedJsonTooLargeError,
	);
});
