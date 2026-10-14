import { describe, expect, it } from "bun:test";
import {
	ADVISOR_EMULATION_PROMPT_V1,
	buildAdvisorSubCallBody,
	classifyAdvisorSubCallFailure,
	deriveAdvisorCacheKey,
	extractAdvisorText,
	extractAdvisorUsage,
	flattenTranscript,
} from "./sub-call";

const history = [
	{ role: "user", content: "Fix the bug" },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret", signature: "x" },
			{ type: "text", text: "Looking" },
			{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
		],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
	},
];

describe("flattenTranscript", () => {
	it("is deterministic", () => {
		expect(flattenTranscript(history, [])).toBe(flattenTranscript(history, []));
	});

	it("labels roles and renders blocks", () => {
		const out = flattenTranscript(history, [{ type: "text", text: "now" }]);
		expect(out).toContain("## User\n\nFix the bug");
		expect(out).toContain('[tool_use Read {"path":"a.ts"}]');
		expect(out).toContain("[tool_result file body]");
		expect(out).not.toContain("secret");
		expect(out.endsWith("## Assistant\n\nnow")).toBe(true);
	});

	it("is append-only", () => {
		const more = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: "thanks" },
		];
		const a = flattenTranscript(history, []);
		const b = flattenTranscript(history.concat(more), []);
		expect(b.startsWith(a)).toBe(true);
	});

	it("truncates tool input and result per block", () => {
		const msgs = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t",
						name: "W",
						input: { s: "x".repeat(500) },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t", content: "y".repeat(500) },
				],
			},
		];
		const out = flattenTranscript(msgs, [], {
			maxToolInputChars: 50,
			maxToolResultChars: 60,
		});
		expect(out).toMatch(/… \[truncated \d+ chars\]/);
		expect(out).not.toContain("x".repeat(100));
		expect(out).not.toContain("y".repeat(100));
		const def = flattenTranscript(msgs, []);
		expect(def).not.toContain("truncated");
	});

	it("handles tool_result arrays, errors, images, documents", () => {
		const msgs = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t",
						is_error: true,
						content: [
							{ type: "text", text: "boom" },
							{ type: "image", source: {} },
						],
					},
					{ type: "image", source: {} },
					{ type: "document", source: {} },
					{ type: "redacted_thinking", data: "z" },
					{ type: "mystery" },
				],
			},
		];
		const out = flattenTranscript(msgs, []);
		expect(out).toContain("[tool_result [error] boom");
		expect(out).toContain("[image]");
		expect(out).toContain("[document]");
		expect(out).toContain("[mystery]");
		expect(out).not.toContain("redacted_thinking");
	});

	it("renders advisor blocks", () => {
		const out = flattenTranscript(
			[
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "s", name: "advisor", input: {} },
						{
							type: "advisor_tool_result",
							tool_use_id: "s",
							content: { type: "advisor_result", text: "do X" },
						},
						{
							type: "advisor_tool_result",
							tool_use_id: "s2",
							content: {
								type: "advisor_tool_result_error",
								error_code: "overloaded",
							},
						},
					],
				},
			],
			[],
		);
		expect(out).toContain("[advisor consulted]");
		expect(out).toContain("[advisor said: do X]");
		expect(out).toContain("[advisor unavailable: overloaded]");
	});
});

describe("buildAdvisorSubCallBody", () => {
	const base = {
		body: { system: "SYS", messages: history, tools: [{ name: "x" }] },
		inflightAssistantContent: [{ type: "text", text: "pending" }],
		advisorModel: "gpt-6-astra",
		cacheKey: "k1",
	};

	it("builds the contract shape with no tools", () => {
		const b = buildAdvisorSubCallBody(base);
		expect(b.model).toBe("gpt-6-astra");
		expect(b.stream).toBe(false);
		expect(b.max_tokens).toBe(8192);
		for (const k of ["tools", "tool_choice", "metadata", "thinking"]) {
			expect(k in b).toBe(false);
		}
		expect(b.__better_ccflare_codex_passthrough).toEqual({
			prompt_cache_key: "k1",
		});
		expect(b.system as string).toContain(ADVISOR_EMULATION_PROMPT_V1);
		expect(b.system as string).toContain("# Worker system prompt\n\nSYS");
		const msgs = b.messages as { role: string; content: string }[];
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].content).toContain("Fix the bug");
		expect(msgs[0].content).toContain("pending");
	});

	it("flattens array system prompts and truncates", () => {
		const b = buildAdvisorSubCallBody({
			...base,
			body: {
				system: [
					{ type: "text", text: "A".repeat(50) },
					{ type: "text", text: "B".repeat(50) },
				],
				messages: [],
			},
			maxSystemChars: 60,
		});
		const sys = b.system as string;
		expect(sys).toContain("A".repeat(50));
		expect(sys).not.toContain("B".repeat(50));
	});

	it("middle-truncates over maxChars keeping a tail-heavy budget", () => {
		const big = [{ role: "user", content: `HEAD${"m".repeat(5000)}TAIL` }];
		const b = buildAdvisorSubCallBody({
			...base,
			body: { messages: big },
			inflightAssistantContent: [],
			maxChars: 1000,
		});
		const c = (b.messages as { content: string }[])[0].content;
		expect(c).toMatch(
			/\[\.\.\. \d+ characters of earlier transcript omitted \.\.\.\]/,
		);
		expect(c).toContain("TAIL");
		expect(c.startsWith("## User")).toBe(true);
		expect(c.length).toBeLessThan(1000 + 1500);
	});

	it("is deterministic", () => {
		expect(JSON.stringify(buildAdvisorSubCallBody(base))).toBe(
			JSON.stringify(buildAdvisorSubCallBody(base)),
		);
	});
});

describe("deriveAdvisorCacheKey", () => {
	it("is stable, prefixed, and seed-sensitive", () => {
		const k = deriveAdvisorCacheKey("seed");
		expect(k).toMatch(/^bccf-adv-[0-9a-f]{24}$/);
		expect(deriveAdvisorCacheKey("seed")).toBe(k);
		expect(deriveAdvisorCacheKey("other")).not.toBe(k);
	});
});

describe("classifyAdvisorSubCallFailure", () => {
	const c = classifyAdvisorSubCallFailure;
	it("maps failures", () => {
		expect(c({ timedOut: true, status: 429 })).toBe("execution_time_exceeded");
		expect(c({ status: 429 })).toBe("too_many_requests");
		expect(c({ errorType: "rate_limit_error" })).toBe("too_many_requests");
		expect(c({ status: 529 })).toBe("overloaded");
		expect(c({ status: 503 })).toBe("overloaded");
		expect(c({ errorType: "overloaded_error" })).toBe("overloaded");
		expect(c({ errorCode: "context_length_exceeded" })).toBe("prompt_too_long");
		expect(c({ message: "prompt is too long: 300000 tokens" })).toBe(
			"prompt_too_long",
		);
		expect(c({ message: "exceeds the context window" })).toBe(
			"prompt_too_long",
		);
		expect(c({ status: 500 })).toBe("unavailable");
		expect(c({ aborted: true })).toBe("unavailable");
		expect(c({})).toBe("unavailable");
	});
});

describe("extractAdvisorText / extractAdvisorUsage", () => {
	it("concatenates text blocks", () => {
		expect(
			extractAdvisorText({
				content: [
					{ type: "text", text: " hi " },
					{ type: "tool_use" },
					{ type: "text", text: "there " },
				],
			}),
		).toBe("hi there");
	});
	it("returns null on none", () => {
		expect(extractAdvisorText(null)).toBeNull();
		expect(extractAdvisorText({})).toBeNull();
		expect(
			extractAdvisorText({ content: [{ type: "text", text: "  " }] }),
		).toBeNull();
		expect(extractAdvisorText({ content: "x" })).toBeNull();
	});
	it("extracts usage", () => {
		expect(
			extractAdvisorUsage({
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					cache_read_input_tokens: 3,
					cache_creation_input_tokens: "x",
				},
			}),
		).toEqual({
			input_tokens: 5,
			output_tokens: 2,
			cache_read_input_tokens: 3,
		});
		expect(extractAdvisorUsage({ usage: { input_tokens: 5 } })).toBeUndefined();
		expect(extractAdvisorUsage({})).toBeUndefined();
		expect(extractAdvisorUsage(null)).toBeUndefined();
	});
});
