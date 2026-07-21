import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODEX_SINGLE_ORCHESTRATION_ROOT_ENV,
	resetOrchestrationElectionForTest,
} from "./orchestration-election";
import {
	CODEX_CACHE_KEY_MODE_ENV,
	CODEX_CACHE_KEY_SESSION_PERCENT_ENV,
	CODEX_PROMPT_CACHE_KEY_ENV,
	CodexProvider,
} from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_FULL_ENV } from "./trace";

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
		delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
		delete process.env[CODEX_CACHE_KEY_MODE_ENV];
		delete process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV];
		delete process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV];
		resetOrchestrationElectionForTest();
		rmSync(dir, { recursive: true, force: true });
	});

	test("transformRequestBody traces the physical attempt and strips internal identity", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE, "req_trace_1", {
				"x-better-ccflare-attempt-id": "attempt-1",
				"x-better-ccflare-attempt-ordinal": "2",
				"x-better-ccflare-attempt-cause": "model_fallback",
				"x-better-ccflare-final-model": "gpt-5.4-mini",
			}),
			undefined,
		);

		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBe(1);
		const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf8").trim());
		expect(rec.trace_schema_version).toBe(10);
		expect(rec.phase).toBe("request");
		expect(rec.orchestration_admission).toBe("no_orchestration_tools");
		expect(rec.request_id).toBe("req_trace_1");
		expect(rec.attempt_id).toBe("attempt-1");
		expect(rec.attempt_ordinal).toBe(2);
		expect(rec.attempt_cause).toBe("model_fallback");
		expect(rec.model_out).toBe("gpt-5.4-mini");
		expect((await transformed.clone().json()).model).toBe("gpt-5.4-mini");
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
		expect(records.every((record) => record.trace_schema_version === 10)).toBe(
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
			tools_before_count: 3,
			tools_after_count: 3,
			filtered_tool_names: [],
		});
		expect(byId.get("non-root")).toMatchObject({
			orchestration_admission: "non_root",
			tools_before_count: 3,
			tools_after_count: 1,
			filtered_tool_names: ["Agent", "Task"],
		});
		expect(byId.get("no-session").orchestration_admission).toBe("no_session");
		expect(byId.get("no-conversation").orchestration_admission).toBe(
			"no_conversation",
		);
		expect(byId.get("no-tools").orchestration_admission).toBe(
			"no_orchestration_tools",
		);
		expect(byId.get("disabled").orchestration_admission).toBe("disabled");
	});

	test("traces canary arm and cohort digest, then strips both headers", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE, "req_canary", {
				"x-better-ccflare-pacing-canary": "bypass",
				"x-better-ccflare-pacing-cohort-id": "0123456789abcdef",
				"x-better-ccflare-pacing-action": "bypassed",
			}),
			undefined,
		);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const rec = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
		expect(rec.pacing_canary).toBe("bypass");
		expect(rec.pacing_cohort_id).toBe("0123456789abcdef");
		expect(rec.pacing_action).toBe("bypassed");
		expect(
			transformed.headers.get("x-better-ccflare-pacing-canary"),
		).toBeNull();
		expect(
			transformed.headers.get("x-better-ccflare-pacing-cohort-id"),
		).toBeNull();
		expect(
			transformed.headers.get("x-better-ccflare-pacing-action"),
		).toBeNull();
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
