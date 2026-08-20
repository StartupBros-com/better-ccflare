import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODEX_SINGLE_ORCHESTRATION_ROOT_ENV,
	deriveConversationIdentity,
	resetOrchestrationElectionForTest,
} from "./orchestration-election";
import {
	CODEX_CACHE_KEY_MODE_ENV,
	CODEX_CACHE_KEY_SESSION_PERCENT_ENV,
	CODEX_DEFAULT_ENDPOINT,
	CODEX_LOGICAL_MODEL_FAMILY_HEADER,
	CODEX_PROMPT_CACHE_KEY_ENV,
	CodexProvider,
} from "./provider";
import {
	CODEX_TRACE_DIR_ENV,
	CODEX_TRACE_FULL_ENV,
	CODEX_TRACE_HMAC_KEY_ENV,
} from "./trace";
import {
	CODEX_TURN_STATE_ACCOUNT_IDS_ENV,
	CODEX_TURN_STATE_COHORT_IDS_ENV,
	CODEX_TURN_STATE_MODELS_ENV,
	CODEX_TURN_STATE_OBSERVE_ONLY_ENV,
	CODEX_TURN_STATE_PERCENT_ENV,
	deriveCodexTurnStateCohortId,
} from "./turn-state";

function messagesRequest(
	body: unknown,
	requestId?: string,
	internalHeaders?: Record<string, string>,
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		...internalHeaders,
	});
	if (requestId) headers.set("x-better-ccflare-request-id", requestId);
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

const SAMPLE = {
	model: "claude-opus-4-8",
	max_tokens: 10,
	messages: [
		{ role: "user", content: "review" },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "Task", input: { prompt: "a" } },
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [{ type: "text", text: "done" }],
				},
			],
		},
	],
};

describe("Codex trace wiring (integration)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-trace-"));
	});
	afterEach(() => {
		delete process.env[CODEX_TRACE_DIR_ENV];
		delete process.env[CODEX_TRACE_FULL_ENV];
		delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
		delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
		delete process.env[CODEX_CACHE_KEY_MODE_ENV];
		delete process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV];
		delete process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV];
		delete process.env[CODEX_TURN_STATE_PERCENT_ENV];
		delete process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV];
		delete process.env[CODEX_TURN_STATE_MODELS_ENV];
		delete process.env[CODEX_TURN_STATE_COHORT_IDS_ENV];
		delete process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV];
		resetOrchestrationElectionForTest();
		rmSync(dir, { recursive: true, force: true });
	});

	test("traces reasoning response metadata without retaining its payload", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const event = (name: string, data: unknown) =>
			`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
		const upstreamBody = [
			event("response.created", {
				response: { id: "resp_reasoning_private", model: "gpt-5.6-sol" },
			}),
			event("response.output_item.done", {
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_reasoning_private",
					encrypted_content: "encrypted-private-payload",
				},
			}),
			event("response.output_item.done", {
				output_index: 1,
				item: { type: "reasoning", id: "rs_without_encrypted_content" },
			}),
			event("response.output_item.done", {
				output_index: 2,
				item: {
					type: "reasoning",
					id: "private.invalid-id",
					encrypted_content: "another-private-payload",
				},
			}),
			event("response.completed", {
				response: {
					model: "gpt-5.6-sol",
					usage: { input_tokens: 12, output_tokens: 3 },
				},
			}),
		].join("");

		const transformed = await new CodexProvider().processResponse(
			new Response(upstreamBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		);
		await transformed.text();

		const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		const rawTrace = readFileSync(join(dir, file as string), "utf8");
		const record = JSON.parse(rawTrace.trim());
		expect(record).toMatchObject({
			trace_schema_version: 20,
			phase: "response",
			reasoning_output_item_count: 3,
			reasoning_encrypted_present: true,
			reasoning_unrepresentable_id_skip_count: 1,
		});
		expect(rawTrace).not.toContain("rs_reasoning_private");
		expect(rawTrace).not.toContain("encrypted-private-payload");
		expect(rawTrace).not.toContain("private.invalid-id");
		expect(rawTrace).not.toContain("another-private-payload");
	});

	test("traces replayed reasoning input counts without retaining its payload", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		await new CodexProvider().transformRequestBody(
			messagesRequest({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "start" },
					{
						role: "assistant",
						content: [
							{
								type: "redacted_thinking",
								data: "bccfr1.rs_request_private.encrypted.request.private",
							},
							{ type: "text", text: "answer" },
						],
					},
					{ role: "user", content: "continue" },
				],
			}),
		);

		const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		const rawTrace = readFileSync(join(dir, file as string), "utf8");
		const record = JSON.parse(rawTrace.trim());
		expect(record).toMatchObject({
			trace_schema_version: 20,
			phase: "request",
			reasoning_input_item_count: 1,
		});
		expect(rawTrace).not.toContain("rs_request_private");
		expect(rawTrace).not.toContain("encrypted.request.private");
	});

	test("traces a treatment capture and same-turn replay without private state", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-turn-state-hmac-key";
		process.env[CODEX_TURN_STATE_PERCENT_ENV] = "100";
		process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV] = "private-account-id";
		process.env[CODEX_TURN_STATE_MODELS_ENV] = "gpt-5.6-sol";

		const sessionId = "99999999-9999-4999-8999-999999999999";
		const instructions = "Keep this private turn together.";
		const firstUserText = "inspect this private cache turn";
		const conversationIdentity = deriveConversationIdentity(
			sessionId,
			instructions,
			[
				{
					role: "user",
					content: [{ type: "input_text", text: firstUserText }],
				},
			],
		);
		expect(conversationIdentity).not.toBeNull();
		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId(
			{
				accountId: "private-account-id",
				model: "gpt-5.6-sol",
				conversationIdentity,
			},
		);

		const account = {
			id: "private-account-id",
			name: "codex-test",
			provider: "codex",
			custom_endpoint: null,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		} as Parameters<CodexProvider["transformRequestBody"]>[1];
		const provider = new CodexProvider();
		const requestFor = (
			requestId: string,
			attemptId: string,
			messages: unknown[],
		) =>
			new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-attempt-id": attemptId,
					"x-better-ccflare-attempt-ordinal": "1",
					"x-better-ccflare-attempt-cause": "initial",
					"x-better-ccflare-final-model": "gpt-5.6-sol",
					"x-codex-turn-state": "client-supplied-turn-state",
				},
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 100,
					stream: true,
					system: instructions,
					metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
					tools: [
						{
							name: "search",
							description: "search",
							input_schema: { type: "object", properties: {} },
						},
					],
					messages,
				}),
			});
		const event = (name: string, data: unknown) =>
			`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
		const toolResponse = (
			requestId: string,
			attemptId: string,
			callId: string,
		) =>
			new Response(
				[
					event("response.created", {
						response: { id: `resp_${attemptId}`, model: "gpt-5.6-sol" },
					}),
					event("response.output_item.added", {
						item: { type: "function_call", call_id: callId, name: "search" },
						output_index: 0,
					}),
					event("response.function_call_arguments.delta", {
						delta: "{}",
						output_index: 0,
					}),
					event("response.output_item.done", {
						item: { type: "function_call", call_id: callId, name: "search" },
						output_index: 0,
					}),
					event("response.completed", {
						response: {
							id: `resp_${attemptId}`,
							model: "gpt-5.6-sol",
							usage: {
								input_tokens: 10,
								output_tokens: 1,
								input_tokens_details: { cached_tokens: 9 },
							},
						},
					}),
				].join(""),
				{
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": requestId,
						"x-better-ccflare-attempt-id": attemptId,
						"x-better-ccflare-final-model": "gpt-5.6-sol",
						"x-better-ccflare-request-stream": "true",
						"x-codex-turn-state": "private-server-turn-state",
					},
				},
			);

		const initialMessages = [{ role: "user", content: firstUserText }];
		const initial = await provider.transformRequestBody(
			requestFor("turn-request-1", "turn-attempt-1", initialMessages),
			account,
		);
		expect(initial.headers.get("x-codex-turn-state")).toBeNull();
		const initialResponse = await provider.processResponse(
			toolResponse("turn-request-1", "turn-attempt-1", "private-call-1"),
			null,
		);
		expect(initialResponse.headers.get("x-codex-turn-state")).toBeNull();
		await initialResponse.text();

		const continuationMessages = [
			...initialMessages,
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "private-call-1",
						name: "search",
						input: {},
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "private-call-1",
						content: "private tool result",
					},
				],
			},
		];
		const continuation = await provider.transformRequestBody(
			requestFor("turn-request-2", "turn-attempt-2", continuationMessages),
			account,
		);
		expect(continuation.headers.get("x-codex-turn-state")).toBe(
			"private-server-turn-state",
		);
		const continuationResponse = await provider.processResponse(
			toolResponse("turn-request-2", "turn-attempt-2", "private-call-2"),
			null,
		);
		expect(continuationResponse.headers.get("x-codex-turn-state")).toBeNull();
		await continuationResponse.text();

		const traceFile = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		expect(traceFile).toBeString();
		const rawTrace = readFileSync(join(dir, traceFile as string), "utf8");
		const records = rawTrace
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const byAttemptAndPhase = new Map(
			records.map((record) => [`${record.attempt_id}:${record.phase}`, record]),
		);
		const initialRequest = byAttemptAndPhase.get("turn-attempt-1:request");
		const initialTerminal = byAttemptAndPhase.get("turn-attempt-1:response");
		const replayRequest = byAttemptAndPhase.get("turn-attempt-2:request");
		const replayTerminal = byAttemptAndPhase.get("turn-attempt-2:response");

		expect(initialRequest).toMatchObject({
			trace_schema_version: 20,
			codex_turn_state_arm: "treatment",
			codex_turn_state_request_action: "new_turn",
			codex_turn_state_replay_applied: false,
			codex_turn_state_request_hmac: null,
		});
		expect(initialRequest?.codex_turn_state_cohort_id).toMatch(
			/^[0-9a-f]{16}$/,
		);
		expect(initialTerminal).toMatchObject({
			trace_schema_version: 20,
			codex_turn_state_terminal_action: "captured",
			codex_turn_state_present: true,
		});
		expect(replayRequest).toMatchObject({
			trace_schema_version: 20,
			codex_turn_state_arm: "treatment",
			codex_turn_state_request_action: "replay",
			codex_turn_state_replay_applied: true,
		});
		expect(replayTerminal).toMatchObject({
			trace_schema_version: 20,
			codex_turn_state_terminal_action: "advanced",
			codex_turn_state_present: true,
		});
		expect(replayRequest?.codex_turn_state_request_hmac).toBeString();
		expect(replayRequest?.codex_turn_state_request_hmac).toBe(
			initialTerminal?.codex_turn_state_hmac,
		);
		expect(replayRequest?.codex_turn_state_request_hmac).toBe(
			replayTerminal?.codex_turn_state_hmac,
		);
		for (const privateValue of [
			"private-server-turn-state",
			"client-supplied-turn-state",
			"private-call-1",
			"private-call-2",
			"private-account-id",
			sessionId,
		]) {
			expect(rawTrace).not.toContain(privateValue);
		}
	});

	test("transformRequestBody traces the physical attempt and strips internal identity", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(
				{
					...SAMPLE,
					output_config: { effort: "max" },
					reasoning: { effort: "max" },
				},
				"req_trace_1",
				{
					"x-better-ccflare-attempt-id": "attempt-1",
					"x-better-ccflare-attempt-ordinal": "2",
					"x-better-ccflare-attempt-cause": "model_fallback",
					"x-better-ccflare-final-model": "gpt-5.4-mini",
				},
			),
			undefined,
		);

		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBe(1);
		const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf8").trim());
		expect(rec.trace_schema_version).toBe(20);
		expect(rec.phase).toBe("request");
		expect(rec.orchestration_admission).toBe("no_orchestration_tools");
		expect(rec.request_id).toBe("req_trace_1");
		expect(rec.attempt_id).toBe("attempt-1");
		expect(rec.attempt_ordinal).toBe(2);
		expect(rec.attempt_cause).toBe("model_fallback");
		expect(rec.model_out).toBe("gpt-5.4-mini");
		expect(rec.logical_reasoning_effort_requested).toBe("max");
		expect(rec.logical_reasoning_effort_source).toBe("output_config");
		expect(rec.physical_reasoning_effort_applied).toBe("medium");
		const transformedBody = await transformed.clone().json();
		expect(transformedBody.model).toBe("gpt-5.4-mini");
		expect(transformedBody.reasoning).toEqual({ effort: "medium" });
		expect(transformedBody.output_config).toBeUndefined();
		expect(transformedBody.logical_reasoning_effort_requested).toBeUndefined();
		expect(transformedBody.logical_reasoning_effort_source).toBeUndefined();
		expect(transformedBody.physical_reasoning_effort_applied).toBeUndefined();
		// Cache-key experiment is off by default in this test environment.
		expect(rec.prompt_cache_key_set).toBe(false);
		expect(rec.prompt_cache_key_id).toBeNull();
		expect(rec.cache_key_mode).toBeNull();
		expect(rec.is_descendant).toBe(false);
		expect(rec.tools_before_count).toBe(rec.tools_after_count);
		expect(rec.filtered_tool_names).toEqual([]);
		expect(rec.model_in).toBe("claude-opus-4-8");
		expect(rec.input_bytes).toBeGreaterThan(0);
		expect(rec.input_hmac).toBeNull();
		expect(rec.instructions_bytes).toBeGreaterThan(0);
		expect(rec.instructions_hmac).toBeNull();
		expect(rec.history_function_call_count).toBe(1);
		expect(rec.history_tool_use_by_name).toEqual({ Task: 1 });
		for (const header of [
			"x-better-ccflare-request-id",
			"x-better-ccflare-attempt-id",
			"x-better-ccflare-attempt-ordinal",
			"x-better-ccflare-attempt-cause",
			"x-better-ccflare-final-model",
		]) {
			expect(transformed.headers.get(header)).toBeNull();
		}
		// full bodies must be absent unless FULL is set
		expect(rec.anthropic_request).toBeUndefined();
	});

	test("traces omitted Fable-origin GPT-5.6 Sol effort as the xhigh default without leaking metadata", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(
				{
					model: "claude-fable-5",
					max_tokens: 10,
					messages: [{ role: "user", content: "review" }],
				},
				"req_trace_fable_default",
				{
					[CODEX_LOGICAL_MODEL_FAMILY_HEADER]: "fable",
					"x-better-ccflare-final-model": "gpt-5.6-sol",
				},
			),
		);

		const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		const record = JSON.parse(
			readFileSync(join(dir, file as string), "utf8").trim(),
		);
		expect(record).toMatchObject({
			trace_schema_version: 20,
			request_id: "req_trace_fable_default",
			model_in: "claude-fable-5",
			model_out: "gpt-5.6-sol",
			logical_reasoning_effort_requested: null,
			logical_reasoning_effort_source: "default",
			physical_reasoning_effort_applied: "xhigh",
		});

		const transformedBody = await transformed.clone().json();
		expect(transformedBody.reasoning).toEqual({ effort: "xhigh" });
		expect(transformedBody.output_config).toBeUndefined();
		expect(transformedBody.logical_reasoning_effort_requested).toBeUndefined();
		expect(transformedBody.logical_reasoning_effort_source).toBeUndefined();
		expect(transformedBody.physical_reasoning_effort_applied).toBeUndefined();
		expect(
			transformed.headers.get(CODEX_LOGICAL_MODEL_FAMILY_HEADER),
		).toBeNull();
	});

	test("traces stable canary decisions across sibling conversations", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "100";
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const metadata = { user_id: JSON.stringify({ session_id: sessionId }) };
		const provider = new CodexProvider();
		for (const [requestId, content] of [
			["sibling-a", "first conversation"],
			["sibling-b", "second conversation"],
		] as const) {
			const transformed = await provider.transformRequestBody(
				messagesRequest(
					{
						model: "claude-opus-4-8",
						max_tokens: 10,
						metadata,
						messages: [{ role: "user", content }],
					},
					requestId,
				),
			);
			const upstream = await transformed.json();
			expect(upstream).not.toHaveProperty("cache_key_assignment");
			expect(upstream).not.toHaveProperty("cache_key_cohort_id");
			expect(upstream).not.toHaveProperty("conversation_id");
			expect(upstream).not.toHaveProperty("cache_key_assignment_source");
		}

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const records = readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.every((record) => record.trace_schema_version === 20)).toBe(
			true,
		);
		expect(records.map((record) => record.cache_key_assignment)).toEqual([
			"session",
			"session",
		]);
		expect(records.map((record) => record.cache_key_assignment_source)).toEqual(
			["canary", "canary"],
		);
		expect(records[0].cache_key_cohort_id).toMatch(/^[0-9a-f]{16}$/);
		expect(records[1].cache_key_cohort_id).toBe(records[0].cache_key_cohort_id);
		expect(records[0].conversation_id).toMatch(/^[0-9a-f]{16}$/);
		expect(records[1].conversation_id).not.toBe(records[0].conversation_id);
		expect(records.map((record) => record.cache_key_mode)).toEqual([
			"session",
			"session",
		]);
		expect(records[1].prompt_cache_key_id).toBe(records[0].prompt_cache_key_id);
	});

	test("traces conversation control and explicit session crossover", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "0";
		const metadata = {
			user_id: JSON.stringify({
				session_id: "22222222-2222-4222-8222-222222222222",
			}),
		};
		const provider = new CodexProvider();
		await provider.transformRequestBody(
			messagesRequest({ ...SAMPLE, metadata }, "control"),
		);
		process.env[CODEX_CACHE_KEY_MODE_ENV] = "session";
		await provider.transformRequestBody(
			messagesRequest({ ...SAMPLE, metadata }, "override"),
		);

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const records = readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({
			cache_key_assignment: "conversation",
			cache_key_assignment_source: "canary",
			cache_key_mode: "conversation",
		});
		expect(records[1]).toMatchObject({
			cache_key_assignment: "conversation",
			cache_key_assignment_source: "explicit_session_override",
			cache_key_mode: "session",
		});
		expect(records[1].cache_key_cohort_id).toBe(records[0].cache_key_cohort_id);
		expect(records[1].conversation_id).toBe(records[0].conversation_id);
	});

	test("traces null experiment fields for malformed or disabled metadata", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const provider = new CodexProvider();
		await provider.transformRequestBody(
			messagesRequest(
				{ ...SAMPLE, metadata: { user_id: "not-json" } },
				"disabled",
			),
		);
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		await provider.transformRequestBody(
			messagesRequest(
				{ ...SAMPLE, metadata: { user_id: "not-json" } },
				"malformed",
			),
		);

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const records = readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const record of records) {
			expect(record).toMatchObject({
				cache_key_assignment: null,
				cache_key_cohort_id: null,
				conversation_id: null,
				cache_key_assignment_source: null,
				cache_key_mode: null,
				prompt_cache_key_set: false,
			});
		}
	});

	test("traces every orchestration admission status and exact removals", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const provider = new CodexProvider();
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const transform = async (
			requestId: string,
			content: string,
			options: {
				tools?: string[];
				metadata?: unknown;
				disabled?: boolean;
			} = {},
		) => {
			if (options.disabled) {
				process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV] = "0";
			} else {
				delete process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV];
			}
			await provider.transformRequestBody(
				messagesRequest(
					{
						model: "claude-opus-4-8",
						max_tokens: 10,
						messages: [{ role: "user", content }],
						...(options.metadata === undefined
							? {}
							: { metadata: options.metadata }),
						...(options.tools
							? {
									tools: options.tools.map((name) => ({
										name,
										input_schema: { type: "object" },
									})),
								}
							: {}),
					},
					requestId,
				),
			);
		};

		const metadata = { user_id: JSON.stringify({ session_id: sessionId }) };
		await transform("root", "root", {
			tools: ["Agent", "Task", "Read"],
			metadata,
		});
		await transform("non-root", "sibling", {
			tools: ["Agent", "Task", "Read"],
			metadata,
		});
		await transform("no-session", "missing", { tools: ["Agent"] });
		await provider.transformRequestBody(
			messagesRequest(
				{
					model: "claude-opus-4-8",
					max_tokens: 10,
					messages: [],
					metadata,
					tools: [{ name: "Agent", input_schema: { type: "object" } }],
				},
				"no-conversation",
			),
		);
		await transform("no-tools", "ordinary", { tools: ["Read"], metadata });
		await transform("disabled", "disabled", {
			tools: ["Task"],
			metadata,
			disabled: true,
		});

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const records = readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const byId = new Map(records.map((record) => [record.request_id, record]));
		expect(byId.get("root")).toMatchObject({
			orchestration_admission: "root",
			orchestration_basis: "initial_claim",
			tools_before_count: 3,
			tools_after_count: 3,
			filtered_tool_names: [],
		});
		expect(byId.get("non-root")).toMatchObject({
			orchestration_admission: "non_root",
			orchestration_basis: "rejected",
			tools_before_count: 3,
			tools_after_count: 1,
			filtered_tool_names: ["Agent", "Task"],
		});
		expect(byId.get("no-session").orchestration_admission).toBe("no_session");
		expect(byId.get("no-session").orchestration_basis).toBeNull();
		expect(byId.get("no-conversation").orchestration_admission).toBe(
			"no_conversation",
		);
		expect(byId.get("no-conversation").orchestration_basis).toBeNull();
		expect(byId.get("no-tools").orchestration_admission).toBe(
			"no_orchestration_tools",
		);
		expect(byId.get("no-tools").orchestration_basis).toBeNull();
		expect(byId.get("disabled").orchestration_admission).toBe("disabled");
		expect(byId.get("disabled").orchestration_basis).toBeNull();
	});

	test("traces stable-root identity_match, compacted-continuation lineage_match, and a null basis for attributed descendants", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const provider = new CodexProvider();
		const sessionId = "33333333-3333-4333-8333-333333333333";
		const tools = ["Agent", "Task", "Read"].map((name) => ({
			name,
			input_schema: { type: "object" },
		}));
		const metadata = { user_id: JSON.stringify({ session_id: sessionId }) };
		const send = async (
			requestId: string,
			messages: unknown[],
			headers: Record<string, string> = {},
		) =>
			provider.transformRequestBody(
				messagesRequest(
					{
						model: "claude-opus-4-8",
						max_tokens: 10,
						metadata,
						messages,
						tools,
					},
					requestId,
					headers,
				),
			);

		const initialMessages = [
			{ role: "user", content: "start the task" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "shared-call",
						name: "Agent",
						input: { prompt: "look into it" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "shared-call", content: "ok" },
				],
			},
		];
		await send("initial-root", initialMessages);
		// Identical messages re-sent for the same session derive the same
		// conversation identity, so this turn re-affirms the existing root
		// rather than initially claiming it.
		await send("stable-root", initialMessages);
		// Compaction reshapes the derived identity (a new first input item) but
		// the surviving call_id lineage still overlaps the elected root's.
		const compactedMessages = [
			...initialMessages.slice(1),
			{ role: "user", content: "continue the task" },
		];
		await send("compacted-continuation", compactedMessages);

		await send("descendant", initialMessages, {
			"x-better-ccflare-attributed-agent": "true",
		});

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const records = readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const byId = new Map(records.map((record) => [record.request_id, record]));

		expect(byId.get("initial-root")).toMatchObject({
			orchestration_admission: "root",
			orchestration_basis: "initial_claim",
		});
		expect(byId.get("stable-root")).toMatchObject({
			orchestration_admission: "root",
			orchestration_basis: "identity_match",
		});
		expect(byId.get("compacted-continuation")).toMatchObject({
			orchestration_admission: "root",
			orchestration_basis: "lineage_match",
		});
		expect(byId.get("descendant")).toMatchObject({
			orchestration_admission: "attributed_descendant",
			orchestration_basis: null,
			filtered_tool_names: ["Agent", "Task"],
		});

		// No raw call ids, instructions, or the session UUID ever appear in the
		// sink, regardless of which admission/basis category produced a record.
		const rawTrace = readFileSync(join(dir, file), "utf8");
		expect(rawTrace).not.toContain("shared-call");
		expect(rawTrace).not.toContain(sessionId);
		expect(rawTrace).not.toContain("You are a helpful assistant");
	});

	test("traces canary arm and cohort digest, then strips both headers", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE, "req_canary", {
				"x-better-ccflare-pacing-canary": "bypass",
				"x-better-ccflare-pacing-cohort-id": "0123456789abcdef",
				"x-better-ccflare-pacing-action": "paced",
				"x-better-ccflare-pacing-role": "follower",
				"x-better-ccflare-pacing-wait-ms": "60000",
				"x-better-ccflare-pacing-release-reason": "cap",
			}),
			undefined,
		);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const rec = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
		expect(rec.pacing_canary).toBe("bypass");
		expect(rec.pacing_cohort_id).toBe("0123456789abcdef");
		expect(rec.pacing_action).toBe("paced");
		expect(rec.pacing_role).toBe("follower");
		expect(rec.pacing_wait_ms).toBe(60000);
		expect(rec.pacing_release_reason).toBe("cap");
		for (const header of [
			"x-better-ccflare-pacing-canary",
			"x-better-ccflare-pacing-cohort-id",
			"x-better-ccflare-pacing-action",
			"x-better-ccflare-pacing-role",
			"x-better-ccflare-pacing-wait-ms",
			"x-better-ccflare-pacing-release-reason",
		]) {
			expect(transformed.headers.get(header)).toBeNull();
		}
	});

	test("embeds full bodies only when CCFLARE_CODEX_TRACE_FULL=1", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_TRACE_FULL_ENV] = "1";
		await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE),
			undefined,
		);

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const rec = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
		expect(rec.anthropic_request).toBeDefined();
		expect(rec.codex_request).toBeDefined();
	});

	test("writes nothing when the trace dir env is unset", async () => {
		await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE),
			undefined,
		);
		expect(readdirSync(dir).length).toBe(0);
	});
});
