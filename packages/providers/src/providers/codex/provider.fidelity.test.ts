/**
 * Fidelity tests for the Codex request transform: these assert DESIRED
 * behavior for the translation-parity gaps identified in the 2026-07 fan-out
 * incident review. A failing test here is a confirmed defect; once fixed,
 * these serve as permanent regressions.
 *
 * Covered dimensions:
 *  - tool_result content robustness (missing/null/non-array content)
 *  - source-order preservation of blocks within a message
 *  - disable_parallel_tool_use mapping
 *  - Skill continuation nudge in mixed parallel final turns
 *  - prompt_cache_key hygiene (length, casing, modern UUID versions)
 *  - bounded serialization of oversized structured blocks
 *  - tool_choice strictness (unknown variants, missing tools)
 *  - is_error signal preservation
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrchestrationElectionForTest } from "./orchestration-election";
import { CODEX_PROMPT_CACHE_KEY_ENV, CodexProvider } from "./provider";
import { CODEX_TRACE_DIR_ENV } from "./trace";

const CONTINUATION_NUDGE = "Continue the user's original request now";

interface CodexBody {
	model: string;
	input: Array<Record<string, unknown>>;
	store: boolean;
	instructions?: string;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
	prompt_cache_key?: string;
}

function makeRequest(body: unknown): Request {
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function transform(body: unknown): Promise<CodexBody> {
	const provider = new CodexProvider();
	const out = await provider.transformRequestBody(makeRequest(body), undefined);
	return (await out.json()) as CodexBody;
}

const outputs = (input: CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call_output");
const calls = (input: CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call");

function readTraceRecords(dir: string): Array<Record<string, unknown>> {
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
	if (!file) return [];
	return readFileSync(join(dir, file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function nudges(input: CodexBody["input"]): number {
	return input.filter(
		(it) =>
			it.role === "user" &&
			Array.isArray(it.content) &&
			(it.content as Array<Record<string, unknown>>).some(
				(c) =>
					typeof c.text === "string" && c.text.includes(CONTINUATION_NUDGE),
			),
	).length;
}

/** Minimal valid history: one Task call awaiting its result. */
function taskTurn(
	resultContent: unknown,
	extra: Record<string, unknown> = {},
): unknown {
	return {
		model: "claude-opus-4-8",
		max_tokens: 10,
		messages: [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						...(resultContent === "__omit__" ? {} : { content: resultContent }),
						...extra,
					},
				],
			},
		],
	};
}

afterEach(() => {
	delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
	resetOrchestrationElectionForTest();
});

describe("Codex transform, tool_result content robustness", () => {
	test("missing content field degrades to empty output, not a dropped translation", async () => {
		const body = await transform(taskTurn("__omit__"));
		// A throw here is swallowed upstream and the RAW Anthropic body is
		// forwarded to Codex; body.input would be undefined in that case.
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("null content degrades to empty output", async () => {
		const body = await transform(taskTurn(null));
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("non-array object content degrades to empty output", async () => {
		const body = await transform(taskTurn({ oops: true }));
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("null elements inside a content array are skipped, text survives", async () => {
		const body = await transform(
			taskTurn([null, { type: "text", text: "ok" }]),
		);
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("ok");
	});
});

describe("Codex transform, source-order preservation", () => {
	test("user message with tool_result then text keeps the result before the text", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "finding" }],
						},
						{ type: "text", text: "now summarize the finding" },
					],
				},
			],
		});
		const outputIdx = body.input.findIndex(
			(it) => it.type === "function_call_output",
		);
		const followupIdx = body.input.findIndex(
			(it) =>
				it.role === "user" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "now summarize the finding",
				),
		);
		expect(outputIdx).toBeGreaterThanOrEqual(0);
		expect(followupIdx).toBeGreaterThanOrEqual(0);
		expect(outputIdx).toBeLessThan(followupIdx);
	});

	test("assistant message with tool_use then text keeps the call before the text", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t1", name: "Bash", input: {} },
						{ type: "text", text: "dispatched, waiting" },
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
		});
		const callIdx = body.input.findIndex((it) => it.type === "function_call");
		const textIdx = body.input.findIndex(
			(it) =>
				it.role === "assistant" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "dispatched, waiting",
				),
		);
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(textIdx).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeLessThan(textIdx);
	});
});

describe("Codex transform, disable_parallel_tool_use mapping", () => {
	const base = {
		model: "claude-opus-4-8",
		max_tokens: 10,
		messages: [{ role: "user", content: "hi" }],
		tools: [{ name: "Read", input_schema: { type: "object" } }],
	};

	test("auto + disable_parallel_tool_use maps to parallel_tool_calls false", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
	});

	test("any + disable_parallel_tool_use maps to required + parallel_tool_calls false", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "any", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("required");
		expect(body.parallel_tool_calls).toBe(false);
	});

	test("absent flag leaves parallel_tool_calls unset", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "auto" },
		});
		expect(body.parallel_tool_calls).toBeUndefined();
	});
});

describe("Codex transform, Skill nudge in mixed parallel final turns", () => {
	function skillPlusTaskTurn(order: "skill-first" | "skill-last"): unknown {
		const skillResult = {
			type: "tool_result",
			tool_use_id: "s1",
			content: [{ type: "text", text: "skill loaded" }],
		};
		const taskResult = {
			type: "tool_result",
			tool_use_id: "t1",
			content: [{ type: "text", text: "task done" }],
		};
		return {
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "s1", name: "Skill", input: {} },
						{ type: "tool_use", id: "t1", name: "Task", input: {} },
					],
				},
				{
					role: "user",
					content:
						order === "skill-first"
							? [skillResult, taskResult]
							: [taskResult, skillResult],
				},
			],
		};
	}

	test("skill result followed by a task result still nudges exactly once", async () => {
		const body = await transform(skillPlusTaskTurn("skill-first"));
		expect(nudges(body.input)).toBe(1);
	});

	test("skill result as the last of mixed results nudges exactly once", async () => {
		const body = await transform(skillPlusTaskTurn("skill-last"));
		expect(nudges(body.input)).toBe(1);
	});

	test("nudge lands at the tail so the cached prefix stays stable", async () => {
		const body = await transform(skillPlusTaskTurn("skill-first"));
		expect(nudges([body.input[body.input.length - 1]])).toBe(1);
	});
});

describe("Codex transform, prompt_cache_key hygiene", () => {
	function withSession(sessionId: string): unknown {
		return {
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
		};
	}

	test("generated key fits the 64-char API bound", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const body = await transform(
			withSession("123e4567-e89b-42d3-a456-426614174000"),
		);
		expect(typeof body.prompt_cache_key).toBe("string");
		expect((body.prompt_cache_key as string).length).toBeLessThanOrEqual(64);
	});

	test("UUID casing is normalized to a single key", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const lower = await transform(
			withSession("123e4567-e89b-42d3-a456-426614174abc"),
		);
		const upper = await transform(
			withSession("123E4567-E89B-42D3-A456-426614174ABC"),
		);
		expect(lower.prompt_cache_key).toBe(upper.prompt_cache_key as string);
	});

	test("UUIDv7 session ids are accepted", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const body = await transform(
			withSession("01890a5d-ac96-774b-bcce-b302099a8057"),
		);
		expect(typeof body.prompt_cache_key).toBe("string");
	});
});

describe("Codex transform, bounded structured block serialization", () => {
	test("oversized structured blocks are omitted with a bounded marker", async () => {
		const bigData = "A".repeat(200_000);
		const body = await transform(
			taskTurn([
				{
					type: "document",
					source: {
						type: "base64",
						media_type: "application/pdf",
						data: bigData,
					},
				},
			]),
		);
		const out = outputs(body.input)[0]?.output as string;
		expect(out.length).toBeLessThan(10_000);
		expect(out).not.toContain(bigData);
		expect(out).toContain("omitted");
	});

	test("small structured blocks remain fully serialized", async () => {
		const body = await transform(
			taskTurn([{ type: "tool_reference", tool_name: "TaskCreate" }]),
		);
		expect(outputs(body.input)[0]?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}',
		);
	});
});

describe("Codex transform, tool_choice strictness", () => {
	test("unknown tool_choice variants are rejected, not coerced to a forced tool", async () => {
		const provider = new CodexProvider();
		const request = makeRequest({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: { type: "bogus", name: "Read" },
		});
		await expect(
			provider.transformRequestBody(request, undefined),
		).rejects.toThrow(/tool_choice/);
	});

	test("named tool_choice without any tools is rejected", async () => {
		const provider = new CodexProvider();
		const request = makeRequest({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tool_choice: { type: "tool", name: "Read" },
		});
		await expect(
			provider.transformRequestBody(request, undefined),
		).rejects.toThrow(/tool_choice/);
	});
});

describe("Codex transform, is_error signal preservation", () => {
	test("errored tool results carry an explicit error marker", async () => {
		const body = await transform(
			taskTurn([{ type: "text", text: "boom" }], { is_error: true }),
		);
		expect(outputs(body.input)[0]?.output).toBe("[tool error] boom");
	});

	test("successful tool results carry no marker", async () => {
		const body = await transform(taskTurn([{ type: "text", text: "fine" }]));
		expect(outputs(body.input)[0]?.output).toBe("fine");
	});
});

// ── Sanitized direct-Messages planning-session regression ─────────────────
//
// Shaped after a reported Claude Code planning session, with every prompt,
// tool input, and result text replaced by generic, non-sensitive placeholder
// content. No real credentials, endpoints, or external calls are involved:
// every request in this section targets the same in-process CodexProvider
// transform used elsewhere in this file.
describe("Codex transform, sanitized Claude Code planning session regression", () => {
	const PLANNING_SESSION_ID = "77777777-7777-4777-8777-777777777777";
	const PLANNING_SESSION_INSTRUCTIONS =
		"You are Claude Code, an AI assistant for software engineering tasks. You can read files, run tools, and delegate work to specialized subagents.";
	const PLANNING_SESSION_TOOLS = [
		{
			name: "Agent",
			description: "Delegate work to a specialized subagent.",
			input_schema: { type: "object" },
		},
		{
			name: "Task",
			description: "Run a parallel background task.",
			input_schema: { type: "object" },
		},
		{
			name: "Skill",
			description: "Load a named skill's additional instructions.",
			input_schema: { type: "object" },
		},
		{
			name: "Read",
			description: "Read a file from the workspace.",
			input_schema: { type: "object" },
		},
		{
			name: "StructuredOutput",
			description: "Return the final response as structured JSON.",
			input_schema: { type: "object" },
		},
	];
	// Sanitized stand-in for the connector-auth warning class reported in the
	// incident: plain text carried inside a tool_result, which the transform
	// must pass through byte-for-byte rather than parse or rewrite.
	const CONNECTOR_AUTH_WARNING_TEXT =
		"Warning: connector authentication for the external issue tracker expired mid-session; results may reflect cached data until re-authorization completes.";

	/**
	 * One logical root session: an initial user turn, a parallel Agent/Task
	 * dispatch whose results return out of call order, a ToolSearch round trip
	 * returning tool_reference blocks, and a final turn that mixes a Skill
	 * result with another tool's result.
	 */
	function planningSessionRootMessages(): unknown[] {
		return [
			{
				role: "user",
				content:
					"Plan and coordinate the rollout of the requested feature across the repository, delegating research and implementation work as needed.",
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_agent_1",
						name: "Agent",
						input: { prompt: "research the affected modules" },
					},
					{
						type: "tool_use",
						id: "call_task_1",
						name: "Task",
						input: { prompt: "draft the implementation outline" },
					},
				],
			},
			{
				role: "user",
				content: [
					// Results are supplied in the opposite order from the calls above
					// (Task before Agent), paired only by tool_use_id.
					{
						type: "tool_result",
						tool_use_id: "call_task_1",
						content: [
							{
								type: "text",
								text: "Task complete: identified the modules requiring changes.",
							},
						],
					},
					{
						type: "tool_result",
						tool_use_id: "call_agent_1",
						content: [
							{ type: "text", text: CONNECTOR_AUTH_WARNING_TEXT },
							{
								type: "text",
								text: "Subagent research complete: proposed a 3-step implementation plan.",
							},
						],
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_toolsearch_1",
						name: "ToolSearch",
						input: { query: "task management tools" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_toolsearch_1",
						content: [
							{ type: "tool_reference", tool_name: "TaskCreate" },
							{ type: "tool_reference", tool_name: "TaskUpdate" },
						],
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_skill_1",
						name: "Skill",
						input: { skill: "planning-mode" },
					},
					{
						type: "tool_use",
						id: "call_read_1",
						name: "Read",
						input: { file_path: "docs/plan.md" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_read_1",
						content: [
							{
								type: "text",
								text: "plan.md contents: outline of proposed workstreams.",
							},
						],
					},
					// Skill result mixed with another (Read) result in the same, final
					// turn: exactly one continuation nudge should be appended.
					{
						type: "tool_result",
						tool_use_id: "call_skill_1",
						content: [{ type: "text", text: "planning-mode skill loaded." }],
					},
				],
			},
		];
	}

	/**
	 * A fresh parallel Skill/Read round trip, appended as the new turn after
	 * compaction. This is what makes the compacted request's final message a
	 * genuine new Skill completion, independent of the (now mid-history)
	 * Skill result carried over from the root turn.
	 */
	function planningSessionContinuationTurn(): unknown[] {
		return [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_skill_2",
						name: "Skill",
						input: { skill: "execution-mode" },
					},
					{
						type: "tool_use",
						id: "call_read_2",
						name: "Read",
						input: { file_path: "docs/execution-notes.md" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_read_2",
						content: [
							{
								type: "text",
								text: "execution-notes.md contents: no blocking issues found.",
							},
						],
					},
					{
						type: "tool_result",
						tool_use_id: "call_skill_2",
						content: [{ type: "text", text: "execution-mode skill loaded." }],
					},
				],
			},
		];
	}

	async function sendPlanningSession(
		provider: CodexProvider,
		messages: unknown[],
		headers: Record<string, string> = {},
	): Promise<CodexBody> {
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				system: PLANNING_SESSION_INSTRUCTIONS,
				metadata: {
					user_id: JSON.stringify({ session_id: PLANNING_SESSION_ID }),
				},
				messages,
				tools: PLANNING_SESSION_TOOLS,
			}),
		});
		const transformed = await provider.transformRequestBody(request, undefined);
		return (await transformed.json()) as CodexBody;
	}

	test("root turn establishes admission and preserves parallel-fan-out fidelity", async () => {
		const provider = new CodexProvider();
		const body = await sendPlanningSession(
			provider,
			planningSessionRootMessages(),
		);

		// Agent and Task are offered for the elected root, alongside every other
		// current tool, in source order.
		expect(body.tools?.map((t) => t.name)).toEqual([
			"Agent",
			"Task",
			"Skill",
			"Read",
			"StructuredOutput",
		]);
		// StructuredOutput coexists with other current working tools, so the
		// implicit forced tool_choice must stay unset.
		expect(body.tool_choice).toBeUndefined();

		// Calls preserve source order (Agent dispatched before Task).
		const callAgent = calls(body.input).find(
			(c) => c.call_id === "call_agent_1",
		);
		const callTask = calls(body.input).find((c) => c.call_id === "call_task_1");
		expect(callAgent?.name).toBe("Agent");
		expect(callTask?.name).toBe("Task");
		expect(body.input.indexOf(callAgent as never)).toBeLessThan(
			body.input.indexOf(callTask as never),
		);

		// Results pair correctly by tool_use_id despite arriving in the opposite
		// order from the calls, and that authored order (Task before Agent) is
		// preserved rather than re-sorted to match call order.
		const taskOutput = outputs(body.input).find(
			(o) => o.call_id === "call_task_1",
		);
		const agentOutput = outputs(body.input).find(
			(o) => o.call_id === "call_agent_1",
		);
		expect(taskOutput?.output).toBe(
			"Task complete: identified the modules requiring changes.",
		);
		expect(agentOutput?.output).toBe(
			`${CONNECTOR_AUTH_WARNING_TEXT}\nSubagent research complete: proposed a 3-step implementation plan.`,
		);
		expect(body.input.indexOf(taskOutput as never)).toBeLessThan(
			body.input.indexOf(agentOutput as never),
		);

		// The connector-auth warning-shaped text survives byte-for-byte: it is
		// opaque payload to the transform, never parsed or rewritten.
		expect(agentOutput?.output as string).toContain(
			CONNECTOR_AUTH_WARNING_TEXT,
		);

		// ToolSearch's tool_reference result blocks remain fully serialized.
		const toolSearchOutput = outputs(body.input).find(
			(o) => o.call_id === "call_toolsearch_1",
		);
		expect(toolSearchOutput?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}\n' +
				'{"type":"tool_reference","tool_name":"TaskUpdate"}',
		);

		// Exactly one Skill nudge, appended at the tail so the cached prefix
		// stays stable.
		expect(nudges(body.input)).toBe(1);
		expect(nudges([body.input[body.input.length - 1]])).toBe(1);
	});

	test("compaction-shaped continuation stays root via lineage and preserves the same fidelity", async () => {
		const provider = new CodexProvider();
		// Establish root admission for this session first.
		await sendPlanningSession(provider, planningSessionRootMessages());

		// Compaction drops the original first user item but keeps every
		// function_call/function_call_output pair (including call_agent_1 and
		// call_task_1, which the election store recorded as this session's
		// lineage), and appends a brand-new Skill/Read turn.
		const compactedMessages = [
			...planningSessionRootMessages().slice(1),
			...planningSessionContinuationTurn(),
		];

		const traceDir = mkdtempSync(
			join(tmpdir(), "codex-fidelity-planning-trace-"),
		);
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		let body: CodexBody;
		try {
			body = await sendPlanningSession(provider, compactedMessages, {
				"x-better-ccflare-request-id": "planning-session-continuation",
			});
			const requestTrace = readTraceRecords(traceDir).find(
				(record) =>
					record.phase === "request" &&
					record.request_id === "planning-session-continuation",
			);
			// No demotion at the provider boundary: the compacted turn is
			// re-admitted as root via the surviving call_id lineage, not rejected
			// and not silently downgraded.
			expect(requestTrace).toMatchObject({
				orchestration_admission: "root",
				orchestration_basis: "lineage_match",
				orchestration_demotion_observed: false,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}

		// Agent/Task remain offered for what is still logically the same root.
		expect(body.tools?.map((t) => t.name)).toEqual([
			"Agent",
			"Task",
			"Skill",
			"Read",
			"StructuredOutput",
		]);
		expect(body.tool_choice).toBeUndefined();

		// Source/pair ordering from the retained history is unchanged.
		const taskOutput = outputs(body.input).find(
			(o) => o.call_id === "call_task_1",
		);
		const agentOutput = outputs(body.input).find(
			(o) => o.call_id === "call_agent_1",
		);
		expect(taskOutput?.output).toBe(
			"Task complete: identified the modules requiring changes.",
		);
		expect(agentOutput?.output).toBe(
			`${CONNECTOR_AUTH_WARNING_TEXT}\nSubagent research complete: proposed a 3-step implementation plan.`,
		);
		expect(body.input.indexOf(taskOutput as never)).toBeLessThan(
			body.input.indexOf(agentOutput as never),
		);

		// The warning text is still preserved opaquely after compaction.
		expect(agentOutput?.output as string).toContain(
			CONNECTOR_AUTH_WARNING_TEXT,
		);

		// The structured tool-reference result blocks remain serialized.
		const toolSearchOutput = outputs(body.input).find(
			(o) => o.call_id === "call_toolsearch_1",
		);
		expect(toolSearchOutput?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}\n' +
				'{"type":"tool_reference","tool_name":"TaskUpdate"}',
		);

		// Exactly one Skill nudge: the replayed, now mid-history call_skill_1
		// result does not double-fire, and the new final call_skill_2 result
		// fires exactly once, at the tail.
		expect(nudges(body.input)).toBe(1);
		expect(nudges([body.input[body.input.length - 1]])).toBe(1);
	});

	test("attributed descendant form removes current Agent/Task but preserves history, other tools, and unset tool_choice", async () => {
		const provider = new CodexProvider();
		const body = await sendPlanningSession(
			provider,
			planningSessionRootMessages(),
			{ "x-better-ccflare-attributed-agent": "true" },
		);

		// Current Agent/Task declarations are removed for the attributed
		// descendant; every other current tool is preserved, in source order.
		expect(body.tools?.map((t) => t.name)).toEqual([
			"Skill",
			"Read",
			"StructuredOutput",
		]);
		// Multiple non-orchestration tools remain (Skill, Read, StructuredOutput),
		// so the implicit forced tool_choice must stay unset.
		expect(body.tool_choice).toBeUndefined();

		// Historical Agent/Task calls and their results are preserved: filtering
		// only ever touches the *declared* current tools, never already-authored
		// history.
		const callNames = calls(body.input)
			.map((c) => c.name)
			.sort();
		expect(callNames).toEqual(
			["Agent", "Read", "Skill", "Task", "ToolSearch"].sort(),
		);

		const outs = outputs(body.input);
		expect(outs.find((o) => o.call_id === "call_task_1")?.output).toBe(
			"Task complete: identified the modules requiring changes.",
		);
		expect(outs.find((o) => o.call_id === "call_agent_1")?.output).toBe(
			`${CONNECTOR_AUTH_WARNING_TEXT}\nSubagent research complete: proposed a 3-step implementation plan.`,
		);
		expect(outs.find((o) => o.call_id === "call_toolsearch_1")?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}\n' +
				'{"type":"tool_reference","tool_name":"TaskUpdate"}',
		);
		expect(outs.find((o) => o.call_id === "call_skill_1")?.output).toBe(
			"planning-mode skill loaded.",
		);
		expect(outs.find((o) => o.call_id === "call_read_1")?.output).toBe(
			"plan.md contents: outline of proposed workstreams.",
		);

		// The final Skill result mixed with the Read result still nudges exactly
		// once for an attributed descendant, same as for the root.
		expect(nudges(body.input)).toBe(1);
	});
});
