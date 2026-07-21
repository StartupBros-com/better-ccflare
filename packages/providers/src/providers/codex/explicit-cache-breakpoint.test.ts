import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@better-ccflare/types";
import { deriveConversationIdentity } from "./orchestration-election";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV,
	CODEX_PROMPT_CACHE_KEY_ENV,
	CodexProvider,
	deriveCodexExplicitBreakpointBucket,
	readCodexExplicitCacheBreakpointPercent,
	resetCodexExplicitBreakpointSuppressionsForTest,
	suppressCodexExplicitCacheBreakpoint,
} from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_HMAC_KEY_ENV } from "./trace";

const SESSION_A = "11111111-1111-4111-8111-111111111111";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-breakpoint-account",
		name: "codex-breakpoint-test",
		provider: "codex",
		custom_endpoint: null,
		...overrides,
	} as Account;
}

async function transform(
	options: {
		percent?: string;
		model?: string;
		endpoint?: string;
		account?: Account;
		messages?: Array<Record<string, unknown>>;
		requestId?: string;
		finalModel?: string;
		attemptCause?: string;
		system?: unknown;
		tools?: Array<Record<string, unknown>>;
		metadataUserId?: string;
	} = {},
): Promise<Record<string, unknown>> {
	if (options.percent === undefined) {
		delete process.env[CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV];
	} else {
		process.env[CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV] = options.percent;
	}
	const endpoint = options.endpoint ?? CODEX_DEFAULT_ENDPOINT;
	const request = new Request(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(options.requestId
				? { "x-better-ccflare-request-id": options.requestId }
				: {}),
			...(options.finalModel
				? { "x-better-ccflare-final-model": options.finalModel }
				: {}),
			...(options.attemptCause
				? { "x-better-ccflare-attempt-cause": options.attemptCause }
				: {}),
		},
		body: JSON.stringify({
			model: options.model ?? "gpt-5.6-sol",
			max_tokens: 64,
			metadata: {
				user_id:
					options.metadataUserId ?? JSON.stringify({ session_id: SESSION_A }),
			},
			...(options.system === undefined ? {} : { system: options.system }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			messages: options.messages ?? [
				{ role: "user", content: "stable first request" },
				{ role: "assistant", content: "prior response" },
				{ role: "user", content: "current request" },
			],
		}),
	});
	return (await new CodexProvider()
		.transformRequestBody(request, options.account ?? makeAccount())
		.then((response) => response.json())) as Record<string, unknown>;
}

function breakpoints(body: Record<string, unknown>): Array<{
	inputIndex: number;
	contentIndex: number;
	block: Record<string, unknown>;
}> {
	const found: Array<{
		inputIndex: number;
		contentIndex: number;
		block: Record<string, unknown>;
	}> = [];
	const input = Array.isArray(body.input) ? body.input : [];
	for (const [inputIndex, item] of input.entries()) {
		if (!item || typeof item !== "object") continue;
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const [contentIndex, block] of content.entries()) {
			if (
				block &&
				typeof block === "object" &&
				"prompt_cache_breakpoint" in block
			) {
				found.push({
					inputIndex,
					contentIndex,
					block: block as Record<string, unknown>,
				});
			}
		}
	}
	return found;
}

function readTrace(dir: string): Record<string, unknown> {
	const file = readdirSync(dir).find((candidate) =>
		candidate.endsWith(".jsonl"),
	);
	if (!file) throw new Error("missing trace file");
	return JSON.parse(readFileSync(join(dir, file), "utf8").trim()) as Record<
		string,
		unknown
	>;
}

afterEach(() => {
	delete process.env[CODEX_EXPLICIT_CACHE_BREAKPOINT_PERCENT_ENV];
	delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
	delete process.env[CODEX_TRACE_DIR_ENV];
	delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
	resetCodexExplicitBreakpointSuppressionsForTest();
});

describe("Codex GPT-5.6 explicit prompt-cache breakpoint canary", () => {
	it("defaults to a dark zero-percent control and preserves implicit caching", async () => {
		const body = await transform();
		expect(body.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(body.prompt_cache_options).toBeUndefined();
		expect(breakpoints(body)).toHaveLength(0);
	});

	it("places exactly one explicit breakpoint on the first stable user text at 100 percent", async () => {
		const body = await transform({ percent: "100" });
		const markers = breakpoints(body);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({
			inputIndex: 0,
			contentIndex: 0,
			block: {
				type: "input_text",
				text: "stable first request",
				prompt_cache_breakpoint: { mode: "explicit" },
			},
		});
		expect(body.prompt_cache_options).toBeUndefined();
		expect(body.prompt_cache_key).toMatch(/^ccflare-convo-/);
	});

	it("prefers a source cache marker without changing text order or tools", async () => {
		const messages = [
			{ role: "user", content: "first unmarked text" },
			{
				role: "user",
				content: [
					{ type: "text", text: "before marked text" },
					{
						type: "text",
						text: "source-marked stable text",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			},
			{ role: "user", content: "active latest request" },
		];
		const tools = [
			{
				name: "Lookup",
				description: "Lookup a value",
				input_schema: {
					type: "object",
					properties: { id: { type: "string" } },
				},
			},
		];
		const body = await transform({ percent: "100", messages, tools });
		const markers = breakpoints(body);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.block.text).toBe("source-marked stable text");
		const textOrder = (body.input as Array<Record<string, unknown>>).flatMap(
			(item) =>
				Array.isArray(item.content)
					? item.content.map((block) => (block as Record<string, unknown>).text)
					: [],
		);
		expect(textOrder).toEqual([
			"first unmarked text",
			"before marked text",
			"source-marked stable text",
			"active latest request",
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "Lookup",
				description: "Lookup a value",
				parameters: {
					type: "object",
					properties: { id: { type: "string" } },
				},
			},
		]);
	});

	it("leaves GPT-5.5, custom proxies, and markerless inputs untouched", async () => {
		const older = await transform({ percent: "100", model: "gpt-5.5-codex" });
		expect(breakpoints(older)).toHaveLength(0);

		const customEndpoint = "https://proxy.example.com/v1/responses";
		const custom = await transform({
			percent: "100",
			endpoint: customEndpoint,
			account: makeAccount({ custom_endpoint: customEndpoint }),
		});
		expect(breakpoints(custom)).toHaveLength(0);

		const noEligibleText = await transform({
			percent: "100",
			messages: [{ role: "assistant", content: "assistant-only history" }],
		});
		expect(breakpoints(noEligibleText)).toHaveLength(0);
	});

	it("allows the exact official OpenAI Responses endpoint", async () => {
		const endpoint = "https://api.openai.com/v1/responses";
		const body = await transform({
			percent: "100",
			endpoint,
			account: makeAccount({ custom_endpoint: endpoint }),
		});
		expect(breakpoints(body)).toHaveLength(1);
	});

	it.each([
		undefined,
		"",
		"-1",
		"1.5",
		" 10",
		"10 ",
		"nope",
	] as const)("strictly parses invalid percentage %p as zero", (raw) => {
		expect(readCodexExplicitCacheBreakpointPercent(raw)).toBe(0);
	});

	it("never duplicates the implicit breakpoint on the active latest message", async () => {
		const oneTurn = await transform({
			percent: "100",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "active text",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		});
		expect(breakpoints(oneTurn)).toHaveLength(0);
	});

	it("maps a system cache hint to the first eligible historical user text without translating TTL", async () => {
		const body = await transform({
			percent: "100",
			system: [
				{
					type: "text",
					text: "stable system instructions",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		});
		expect(breakpoints(body)).toHaveLength(1);
		expect(breakpoints(body)[0]?.block.text).toBe("stable first request");
		expect(body.prompt_cache_options).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain('"ttl":"1h"');
	});

	it("emits at most one marker when several historical source blocks are marked", async () => {
		const body = await transform({
			percent: "100",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "marked one",
							cache_control: { type: "ephemeral" },
						},
						{
							type: "text",
							text: "marked two",
							cache_control: { type: "ephemeral" },
						},
					],
				},
				{ role: "user", content: "active" },
			],
		});
		expect(breakpoints(body)).toHaveLength(1);
		expect(breakpoints(body)[0]?.block.text).toBe("marked one");
	});

	it("skips assistant, tool, empty, and malformed text blocks", async () => {
		const body = await transform({
			percent: "100",
			messages: [
				{ role: "assistant", content: "assistant output" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "Lookup",
							input: {},
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: 42 },
					],
				},
				{ role: "user", content: "active" },
			],
		});
		expect(breakpoints(body)).toHaveLength(0);
	});

	it("requires a server-derived cache key and valid session metadata", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
		const keyDisabled = await transform({ percent: "100" });
		expect(keyDisabled.prompt_cache_key).toBeUndefined();
		expect(breakpoints(keyDisabled)).toHaveLength(0);
		delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];

		const noSession = await transform({
			percent: "100",
			metadataUserId: "not-session-json",
		});
		expect(noSession.prompt_cache_key).toBeUndefined();
		expect(breakpoints(noSession)).toHaveLength(0);
	});

	it.each([
		"gpt-5.60",
		"gpt-5.6x",
		"gpt-5.5",
		"claude-gpt-5.6",
	])("rejects non-family model %s", async (model) => {
		const body = await transform({ percent: "100", model });
		expect(breakpoints(body)).toHaveLength(0);
	});

	it.each([
		"https://api.openai.com.evil.example/v1/responses",
		"https://api.openai.com/v1/responses?beta=1",
		"https://api.openai.com:8443/v1/responses",
		"https://chatgpt.com/backend-api/codex/responses#fragment",
		"http://api.openai.com/v1/responses",
	])("rejects endpoint lookalike or mutation %s", async (endpoint) => {
		const body = await transform({
			percent: "100",
			endpoint,
			account: makeAccount({ custom_endpoint: endpoint }),
		});
		expect(breakpoints(body)).toHaveLength(0);
	});

	it("gates on the final physical model selected after fallback", async () => {
		const promoted = await transform({
			percent: "100",
			model: "gpt-5.5",
			finalModel: "gpt-5.6-sol",
		});
		expect(breakpoints(promoted)).toHaveLength(1);

		const demoted = await transform({
			percent: "100",
			model: "gpt-5.6-sol",
			finalModel: "gpt-5.5",
		});
		expect(breakpoints(demoted)).toHaveLength(0);
	});

	it("skips salted cache-lane and precommit rescue attempts", async () => {
		for (const cause of ["cache_lane_rescue", "precommit_sse_retry"]) {
			const body = await transform({
				percent: "100",
				requestId: `request-${cause}`,
				attemptCause: cause,
			});
			expect(body.prompt_cache_key).toMatch(/^ccflare-rescue-/);
			expect(breakpoints(body)).toHaveLength(0);
		}
	});

	it("uses a stable conversation-scoped deterministic assignment", async () => {
		const identity = "0".repeat(64);
		expect(deriveCodexExplicitBreakpointBucket(identity)).toBe(
			deriveCodexExplicitBreakpointBucket(identity),
		);
		expect(
			deriveCodexExplicitBreakpointBucket(identity),
		).toBeGreaterThanOrEqual(0);
		expect(deriveCodexExplicitBreakpointBucket(identity)).toBeLessThan(100);
		const first = await transform({ percent: "38" });
		const repeated = await transform({ percent: "38" });
		expect(breakpoints(repeated).length).toBe(breakpoints(first).length);
		const compacted = await transform({
			percent: "38",
			messages: [
				{ role: "user", content: "compacted historical turn" },
				{ role: "assistant", content: "compacted response" },
				{ role: "user", content: "active after compaction" },
			],
		});
		const firstConversationIdentity = deriveConversationIdentity(
			SESSION_A,
			first.instructions as string,
			first.input as readonly unknown[],
		);
		const compactedConversationIdentity = deriveConversationIdentity(
			SESSION_A,
			compacted.instructions as string,
			compacted.input as readonly unknown[],
		);
		expect(firstConversationIdentity).not.toBeNull();
		expect(compactedConversationIdentity).not.toBeNull();
		const wrongScopeBuckets = [
			deriveCodexExplicitBreakpointBucket(firstConversationIdentity as string),
			deriveCodexExplicitBreakpointBucket(
				compactedConversationIdentity as string,
			),
		];
		expect(wrongScopeBuckets).toEqual([92, 37]);
		expect(wrongScopeBuckets[0] < 38).not.toBe(wrongScopeBuckets[1] < 38);
		expect(breakpoints(compacted).length).toBe(breakpoints(first).length);
	});

	it("suppresses a rejected account/model capability without removing the cache key", async () => {
		const account = makeAccount();
		suppressCodexExplicitCacheBreakpoint(account.id, "gpt-5.6-sol");
		const body = await transform({ percent: "100", account });
		expect(breakpoints(body)).toHaveLength(0);
		expect(body.prompt_cache_key).toMatch(/^ccflare-convo-/);

		const otherModel = await transform({
			percent: "100",
			account,
			model: "gpt-5.6-alt",
		});
		expect(breakpoints(otherModel)).toHaveLength(1);

		const apiEndpoint = "https://api.openai.com/v1/responses";
		const otherEndpoint = await transform({
			percent: "100",
			endpoint: apiEndpoint,
			account: makeAccount({
				id: account.id,
				custom_endpoint: apiEndpoint,
			}),
		});
		expect(breakpoints(otherEndpoint)).toHaveLength(1);
	});

	it("traces treatment/control and placement reason without prompt or key values", async () => {
		const traceDir = mkdtempSync(join(tmpdir(), "codex-breakpoint-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "breakpoint-test-secret";
		try {
			await transform({
				percent: "100",
				requestId: "breakpoint-trace-request",
			});
			const trace = readTrace(traceDir);
			expect(trace).toMatchObject({
				explicit_breakpoint_canary: "treatment",
				explicit_breakpoint_action: "placed_first_user_text",
			});
			expect(trace.explicit_breakpoint_cohort_id).toMatch(/^[0-9a-f]{16}$/);
			expect(trace).not.toHaveProperty("explicit_breakpoint_prompt");
			expect(trace).not.toHaveProperty("explicit_breakpoint_key");
		} finally {
			rmSync(traceDir, { recursive: true, force: true });
		}
	});
});
