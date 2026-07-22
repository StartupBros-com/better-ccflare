import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUFFER_SIZES } from "@better-ccflare/core";
import { fetchCodexUsageOnDemand } from "./on-demand-fetch";
import {
	CODEX_SINGLE_ORCHESTRATION_ROOT_ENV,
	resetOrchestrationElectionForTest,
} from "./orchestration-election";
import {
	CODEX_CACHE_KEY_MODE_ENV,
	CODEX_CACHE_KEY_SESSION_PERCENT_ENV,
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PROMPT_CACHE_KEY_ENV,
	CODEX_VERSION,
	CodexProvider,
	codexEventCommitsOutput,
	deriveCodexCacheKeySessionBucket,
	readCodexCacheKeySessionPercent,
	resolveCodexRequestModel,
} from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_HMAC_KEY_ENV } from "./trace";
import { parseCodexUsageHeaders } from "./usage";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];
const readTraceRecords = (dir: string): Array<Record<string, unknown>> => {
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
	if (!file) return [];
	return readFileSync(join(dir, file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};

afterEach(() => {
	delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
	delete process.env[CODEX_CACHE_KEY_MODE_ENV];
	delete process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV];
	delete process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV];
	delete process.env[CODEX_TRACE_DIR_ENV];
	delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
	resetOrchestrationElectionForTest();
});

describe("CodexProvider request conversion", () => {
	it("keeps capability defaults in parity with the request model resolver", () => {
		const provider = new CodexProvider();
		for (const model of [
			"claude-opus-4-8",
			"claude-sonnet-5",
			"claude-haiku-4-5-20251001",
		]) {
			expect(
				provider.getLogicalModelCapability(model, {} as never).status,
			).toBe("supported");
			expect(resolveCodexRequestModel(model)).not.toBe(model);
		}
		expect(
			provider.getLogicalModelCapability("claude-fable-5", {} as never),
		).toMatchObject({ status: "unsupported", provenance: "provider_default" });
		expect(resolveCodexRequestModel("claude-fable-5")).toBe("claude-fable-5");
	});

	it("handles messages and synthetic count_tokens paths", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeTrue();
		expect(provider.canHandle("/v1/complete")).toBeFalse();
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

	it("adds a continuation nudge after Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.input).toContainEqual({
			role: "user",
			content: [
				{
					type: "input_text",
					text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
				},
			],
		});
	});

	it("does not add a continuation nudge after non-Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "search" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: { query: "news" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_search_1",
								content: [{ type: "text", text: "results" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("does not inject a Skill continuation nudge into replayed mid-history", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
					{ role: "assistant", content: "I will apply the plan skill." },
					{ role: "user", content: "continue" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
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

	it("uses role-appropriate text block types in Codex input", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
					{ role: "developer", content: "follow policy" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "hello" }],
		});
		expect(body.input[1]).toEqual({
			role: "assistant",
			content: [{ type: "output_text", text: "hi" }],
		});
		expect(body.input[2]).toEqual({
			role: "system",
			content: [{ type: "input_text", text: "follow policy" }],
		});
	});

	it("marks replayed tool call items as completed", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_1",
								name: "search",
								input: { query: "hello" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_1",
								content: [{ type: "text", text: "result" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_1",
			name: "search",
			arguments: JSON.stringify({ query: "hello" }),
			status: "completed",
		});
		expect(body.input[1]).toMatchObject({
			type: "function_call_output",
			call_id: "call_1",
			output: "result",
			status: "completed",
		});
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

	it("omits empty Read.pages when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_read_1",
								name: "Read",
								input: {
									file_path: "/tmp/full.diff",
									offset: 0,
									limit: 2000,
									pages: "",
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_read_1",
			name: "Read",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			file_path: "/tmp/full.diff",
			offset: 0,
			limit: 2000,
		});
	});

	it("normalizes stored WebSearch tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: {
									query: "latest earnings",
									allowed_domains: [" investors.example.com ", ""],
									blocked_domains: ["spam.example.com"],
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_search_1",
			name: "WebSearch",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			query: "latest earnings",
			allowed_domains: ["investors.example.com"],
		});
	});

	it("preserves falsy non-object tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_generic_1",
								name: "generic_tool",
								input: "",
							},
							{
								type: "tool_use",
								id: "call_generic_2",
								name: "generic_tool",
								input: null,
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_1",
			name: "generic_tool",
		});
		expect(body.input[0].arguments).toBe('""');
		expect(body.input[1]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_2",
			name: "generic_tool",
		});
		expect(body.input[1].arguments).toBe("null");
	});

	it("omits max_output_tokens for the ChatGPT subscription endpoint and URL variants", async () => {
		const provider = new CodexProvider();
		const cases = [
			{ url: CODEX_DEFAULT_ENDPOINT, maxTokens: 4096 },
			{ url: `${CODEX_DEFAULT_ENDPOINT}/`, maxTokens: 100.7 },
			{ url: `${CODEX_DEFAULT_ENDPOINT}?source=test`, maxTokens: 100.7 },
		];

		for (const { url, maxTokens } of cases) {
			const request = new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-3-5-sonnet-20241022",
					max_tokens: maxTokens,
					messages: [{ role: "user", content: "Hello" }],
				}),
			});

			const transformed = await provider.transformRequestBody(request);
			const body = await transformed.json();

			expect(body).not.toHaveProperty("max_output_tokens");
		}
	});

	it("preserves legacy max_output_tokens mapping for valid custom endpoints", async () => {
		const provider = new CodexProvider();
		const cases = [
			{ maxTokens: 4096, expected: 4096 },
			{ maxTokens: 100.7, expected: 100 },
			{ maxTokens: 0.7, expected: 0 },
			{ maxTokens: 0, expected: 1 },
			{ maxTokens: -1, expected: undefined },
			{ maxTokens: undefined, expected: undefined },
		];

		for (const { maxTokens, expected } of cases) {
			const requestBody: Record<string, unknown> = {
				model: "claude-3-5-sonnet-20241022",
				messages: [{ role: "user", content: "Hello" }],
			};
			if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;
			const request = new Request("https://example.test/codex/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody),
			});

			const transformed = await provider.transformRequestBody(request);
			const body = await transformed.json();

			if (expected === undefined) {
				expect(body).not.toHaveProperty("max_output_tokens");
			} else {
				expect(body.max_output_tokens).toBe(expected);
			}
		}
	});

	it("returns a local Anthropic error for max_tokens: 0 on the subscription endpoint", async () => {
		const provider = new CodexProvider();
		const request = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 0,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(transformed.url).toBe("https://better-ccflare.local/codex/response");
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex subscription requests do not support max_tokens: 0.",
			},
		});
	});

	it("rejects negative max_tokens locally for the subscription endpoint", async () => {
		const provider = new CodexProvider();
		const request = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: -1,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex subscription requests do not support max_tokens: -1.",
			},
		});
	});

	it("falls back from an invalid custom endpoint and applies subscription rules", async () => {
		const provider = new CodexProvider();
		const account = {
			name: "invalid-codex",
			custom_endpoint: "not-a-url",
		} as Parameters<typeof provider.buildUrl>[2];
		const resolvedUrl = provider.buildUrl("/v1/messages", "", account);
		expect(resolvedUrl).toBe(CODEX_DEFAULT_ENDPOINT);

		const request = new Request(resolvedUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 4096,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body).not.toHaveProperty("max_output_tokens");
	});
});

describe("CodexProvider.parseRateLimit", () => {
	it("treats 529 with no reset headers as rate limited, with no synthesized resetTime", () => {
		const provider = new CodexProvider();
		const response = new Response(null, { status: 529 });

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBeTrue();
		expect(info.resetTime).toBeUndefined();
	});

	it("uses the soonest reset header when a 529 carries reset hints", () => {
		const provider = new CodexProvider();
		const secondaryResetSeconds = Math.floor(Date.now() / 1000) + 120;
		const primaryResetSeconds = Math.floor(Date.now() / 1000) + 60;
		const response = new Response(null, {
			status: 529,
			headers: {
				"x-codex-primary-reset-at": String(primaryResetSeconds),
				"x-codex-secondary-reset-at": String(secondaryResetSeconds),
			},
		});

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBeTrue();
		expect(info.resetTime).toBe(primaryResetSeconds * 1000);
	});

	it("keeps a 429 without an upstream reset unverified", () => {
		const provider = new CodexProvider();
		const response = new Response(null, { status: 429 });

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBeTrue();
		expect(info.resetTime).toBeUndefined();
		expect(info.reason).toBeUndefined();
	});

	it("does not treat a non-exhausted Codex usage-window reset as verified 429 provenance", () => {
		const provider = new CodexProvider();
		const resetSeconds = Math.floor(Date.now() / 1000) + 120;
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(resetSeconds),
			},
		});

		const info = provider.parseRateLimit(response);

		expect(info).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it("does not infer recovery from conflicting Codex usage windows", () => {
		const provider = new CodexProvider();
		const earlierSiblingReset = Math.floor(Date.now() / 1000) + 30;
		const exhaustedWindowReset = Math.floor(Date.now() / 1000) + 180;
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-reset-at": String(exhaustedWindowReset),
				"x-codex-secondary-used-percent": "42",
				"x-codex-secondary-reset-at": String(earlierSiblingReset),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it("uses only the reset paired with an exhausted Codex usage window", () => {
		const provider = new CodexProvider();
		const earlierNonExhaustedReset = Math.floor(Date.now() / 1000) + 30;
		const exhaustedWindowReset = Math.floor(Date.now() / 1000) + 180;
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(exhaustedWindowReset),
				"x-codex-secondary-used-percent": "42",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": String(earlierNonExhaustedReset),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: exhaustedWindowReset * 1000,
			reason: "upstream_429_with_reset",
		});
	});

	it("uses the latest reset when multiple Codex usage windows are exhausted", () => {
		const provider = new CodexProvider();
		const primaryReset = Math.floor(Date.now() / 1000) + 60;
		const secondaryReset = Math.floor(Date.now() / 1000) + 180;
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(primaryReset),
				"x-codex-secondary-used-percent": "101",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": String(secondaryReset),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: secondaryReset * 1000,
			reason: "upstream_429_with_reset",
		});
	});

	it("accepts a relative reset paired with an exhausted Codex usage window", () => {
		const provider = new CodexProvider();
		const before = Date.now();
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-after-seconds": "3600",
			},
		});

		const info = provider.parseRateLimit(response);

		expect(info.reason).toBe("upstream_429_with_reset");
		expect(info.resetTime).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(info.resetTime).toBeLessThan(before + 3_601_000);
	});

	it("keeps inferred recovery unverified when any exhausted Codex window lacks a valid reset", () => {
		const provider = new CodexProvider();
		const primaryReset = Math.floor(Date.now() / 1000) + 60;
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(primaryReset),
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "10080",
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it("does not infer verified 429 recovery from legacy Codex reset aliases", () => {
		const provider = new CodexProvider();
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-5h-reset-at": String(Math.floor(Date.now() / 1000) + 60),
				"x-codex-7d-reset-at": String(Math.floor(Date.now() / 1000) + 180),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it("accepts direct standard 429 recovery headers with verified provenance", () => {
		const provider = new CodexProvider();
		const before = Date.now();
		const retryAfter = provider.parseRateLimit(
			new Response(null, {
				status: 429,
				headers: { "retry-after": "120" },
			}),
		);
		const resetSeconds = Math.floor(before / 1000) + 180;
		const resetHeader = provider.parseRateLimit(
			new Response(null, {
				status: 429,
				headers: { "x-ratelimit-reset": String(resetSeconds) },
			}),
		);

		expect(retryAfter.reason).toBe("upstream_429_with_reset");
		expect(retryAfter.resetTime).toBeGreaterThanOrEqual(before + 120_000);
		expect(resetHeader).toMatchObject({
			resetTime: resetSeconds * 1000,
			reason: "upstream_429_with_reset",
		});
	});

	it("keeps Retry-After as a lower bound when earlier reset metadata conflicts", () => {
		const provider = new CodexProvider();
		const before = Date.now();
		const response = new Response(null, {
			status: 429,
			headers: {
				"retry-after": "120",
				"x-ratelimit-reset": String(Math.floor(before / 1000) + 60),
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-reset-at": String(Math.floor(before / 1000) + 30),
			},
		});

		const info = provider.parseRateLimit(response);

		expect(info.reason).toBe("upstream_429_with_reset");
		expect(info.resetTime).toBeGreaterThanOrEqual(before + 120_000);
		expect(info.resetTime).toBeLessThan(before + 121_000);
	});

	it("uses a valid direct recovery hint when its sibling is invalid", () => {
		const provider = new CodexProvider();
		const resetSeconds = Math.floor(Date.now() / 1000) + 180;
		const response = new Response(null, {
			status: 429,
			headers: {
				"retry-after": String(Number.MAX_SAFE_INTEGER),
				"x-ratelimit-reset": String(resetSeconds),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: resetSeconds * 1000,
			reason: "upstream_429_with_reset",
		});
	});

	it("keeps valid direct recovery when exhausted-window telemetry is incomplete", () => {
		const provider = new CodexProvider();
		const before = Date.now();
		const response = new Response(null, {
			status: 429,
			headers: {
				"retry-after": "120",
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
			},
		});

		const info = provider.parseRateLimit(response);

		expect(info.reason).toBe("upstream_429_with_reset");
		expect(info.resetTime).toBeGreaterThanOrEqual(before + 120_000);
		expect(info.resetTime).toBeLessThan(before + 121_000);
	});

	it("lets a verified exhausted-window horizon extend direct Retry-After", () => {
		const provider = new CodexProvider();
		const before = Date.now();
		const exhaustedReset = Math.floor(before / 1000) + 3600;
		const response = new Response(null, {
			status: 429,
			headers: {
				"retry-after": "120",
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(exhaustedReset),
				"x-codex-secondary-used-percent": "82",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": String(
					Math.floor(before / 1000) + 6 * 24 * 60 * 60,
				),
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: exhaustedReset * 1000,
			reason: "upstream_429_with_reset",
		});
	});

	it.each([
		"retry-after",
		"x-ratelimit-reset",
	])("rejects an overflowing %s recovery value", (header) => {
		const provider = new CodexProvider();
		const response = new Response(null, {
			status: 429,
			headers: { [header]: String(Number.MAX_SAFE_INTEGER) },
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it.each([
		[
			"retry-after",
			String(8 * 24 * 60 * 60 + 60),
			{} as Record<string, string>,
		],
		[
			"x-ratelimit-reset",
			String(Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60 + 60),
			{} as Record<string, string>,
		],
		[
			"x-codex-primary-reset-at",
			String(Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60 + 60),
			{
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
			},
		],
	])("rejects an out-of-horizon %s recovery value", (header, value, paired) => {
		const provider = new CodexProvider();
		const response = new Response(null, {
			status: 429,
			headers: { ...paired, [header]: value },
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it.each([
		["malformed", "not-a-timestamp"],
		["non-finite", "1e309"],
		["past", String(Math.floor(Date.now() / 1000) - 60)],
	])("does not trust a %s canonical Codex reset", (_label, resetAt) => {
		const provider = new CodexProvider();
		const response = new Response(null, {
			status: 429,
			headers: { "x-codex-primary-reset-at": resetAt },
		});

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBeTrue();
		expect(info.resetTime).toBeUndefined();
		expect(info.reason).toBeUndefined();
	});

	it("does not treat unrelated Codex window metadata as reset provenance", () => {
		const provider = new CodexProvider();
		const response = new Response(null, {
			status: 429,
			headers: {
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-used-percent": "100",
			},
		});

		expect(provider.parseRateLimit(response)).toEqual({
			isRateLimited: true,
			resetTime: undefined,
			reason: undefined,
		});
	});

	it("does not treat a plain 200 as rate limited even with reset headers present", () => {
		const provider = new CodexProvider();
		const resetSeconds = Math.floor(Date.now() / 1000) + 60;
		const response = new Response(null, {
			status: 200,
			headers: { "x-codex-primary-reset-at": String(resetSeconds) },
		});

		const info = provider.parseRateLimit(response);

		expect(info.isRateLimited).toBeFalse();
		expect(info.resetTime).toBe(resetSeconds * 1000);
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
		expect(transformedBody).toContain('"stop_reason":"tool_use"');
	});

	it("omits empty Read.pages from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"file_path":"/tmp/full.diff","offset":0,',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"limit":2000,"pages":""}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
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

		expect(transformedBody).toContain(
			'"partial_json":"{\\"file_path\\":\\"/tmp/full.diff\\",\\"offset\\":0,\\"limit\\":2000}"',
		);
		expect(transformedBody).not.toContain('\\"pages\\"');
	});

	it("omits invalid WebSearch domain filters from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"earnings","allowed_domains":[],',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"blocked_domains":[""]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
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

		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"earnings\\"}"',
		);
		expect(transformedBody).not.toContain("allowed_domains");
		expect(transformedBody).not.toContain("blocked_domains");
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
		expect(deltaLine).toContain('"index":0');
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

		// Collect events for block index 0 in order
		const block0Events = events
			.filter(
				(e) =>
					(e.type === "content_block_start" ||
						e.type === "content_block_stop" ||
						e.type === "content_block_delta") &&
					(e.index === 0 ||
						(e.type === "content_block_start" &&
							(e.content_block as Record<string, unknown>)?.type ===
								"tool_use")),
			)
			.map((e) => e.type);

		// Must be: start → delta → stop (no premature stop before delta)
		expect(block0Events).toEqual([
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
		]);

		// Text block (index 1) must come after function-call block opens
		const block1Start = events.findIndex(
			(e) => e.type === "content_block_start" && e.index === 1,
		);
		const block0Stop = events.findIndex(
			(e) => e.type === "content_block_stop" && e.index === 0,
		);
		expect(block1Start).toBeGreaterThan(-1);
		expect(block0Stop).toBeGreaterThan(block1Start);
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
		expect(messageDeltaLine).toContain('"input_tokens":8');
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
		expect(payload.stop_reason).toBe("tool_use");
	});

	it("omits invalid WebSearch domain filters from non-streaming tool_use input", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_websearch_domains";
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
						name: "WebSearch",
						description: "search",
						input_schema: {
							type: "object",
							properties: {
								allowed_domains: { type: "array", items: { type: "string" } },
								blocked_domains: { type: "array", items: { type: "string" } },
							},
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
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta:
					'{"query":"earnings","allowed_domains":["reuters.com"],"blocked_domains":["seekingalpha.com"]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
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
				name: "WebSearch",
				input: { query: "earnings", allowed_domains: ["reuters.com"] },
			},
		]);
	});

	it("preserves non-object tool arguments in non-streaming SSE-to-JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_non_object_tool_input";
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
						name: "generic_tool",
						description: "generic",
						input_schema: { type: "object" },
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
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: "null",
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
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
				name: "generic_tool",
				input: null,
			},
		]);
	});

	it.each([
		{
			label: "normal cached usage",
			total: 100,
			cached: 25,
			uncached: 65,
			cacheRead: 25,
			cacheCreation: 10,
		},
		{
			label: "zero usage",
			total: 0,
			cached: 0,
			uncached: 0,
			cacheRead: 0,
			cacheCreation: 0,
		},
		{
			label: "cached usage above total",
			total: 10,
			cached: 25,
			uncached: 0,
			cacheRead: 10,
			cacheCreation: 0,
		},
	])("maps response.completed $label into additive Anthropic usage", async ({
		total,
		cached,
		uncached,
		cacheRead,
		cacheCreation,
	}) => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.3-codex" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: total,
						output_tokens: 50,
						input_tokens_details: {
							cached_tokens: cached,
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
		const messageDelta = JSON.parse(
			(messageDeltaLine as string).slice("data: ".length),
		);

		expect(messageDelta.usage.input_tokens).toBe(uncached);
		expect(messageDelta.usage.cache_read_input_tokens).toBe(cacheRead);
		expect(messageDelta.usage.cache_creation_input_tokens).toBe(cacheCreation);
		expect(
			messageDelta.usage.input_tokens +
				messageDelta.usage.cache_read_input_tokens +
				messageDelta.usage.cache_creation_input_tokens,
		).toBe(total);
		expect(messageDelta.context_window.current_usage.input_tokens).toBe(
			uncached,
		);
		expect(
			messageDelta.context_window.current_usage.cache_read_input_tokens,
		).toBe(cacheRead);
		expect(
			messageDelta.context_window.current_usage.cache_creation_input_tokens,
		).toBe(cacheCreation);
		expect(messageDelta.context_window.context_window_size).toBe(272_000);
	});

	it.each([
		{
			label: "negative cached",
			total: 12,
			cached: -4,
			input: 12,
			cacheRead: 0,
		},
		{
			label: "non-finite cached",
			total: 12,
			cached: Number.POSITIVE_INFINITY,
			input: 12,
			cacheRead: 0,
		},
	])("sanitizes $label usage", async ({ total, cached, input, cacheRead }) => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: total,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: cached },
					},
				},
			}),
		]);
		const transformed = await provider.processResponse(
			new Response(upstreamBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		);
		const messageDeltaLine = (await transformed.text())
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));
		const messageDelta = JSON.parse(
			(messageDeltaLine as string).slice("data: ".length),
		);

		expect(messageDelta.usage.input_tokens).toBe(input);
		expect(messageDelta.usage.cache_read_input_tokens).toBe(cacheRead);
	});

	it("maps cached usage for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: {
						input_tokens: 20,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 8 },
					},
				},
			}),
		]);
		const transformed = await provider.processResponse(
			new Response(upstreamBody, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-stream": "false",
				},
			}),
			null,
		);
		const payload = JSON.parse(await transformed.text());

		expect(payload.usage.input_tokens).toBe(12);
		expect(payload.usage.cache_read_input_tokens).toBe(8);
	});

	it("reports the effective context window when CCFLARE_CODEX_EFFECTIVE_CONTEXT=1", async () => {
		process.env.CCFLARE_CODEX_EFFECTIVE_CONTEXT = "1";
		try {
			const provider = new CodexProvider();
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_test", model: "gpt-5.6-sol" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.6-sol",
						usage: { input_tokens: 100, output_tokens: 50 },
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

			// 372000 * 95% effective = 353400
			expect(messageDeltaLine).toContain('"context_window_size":353400');
		} finally {
			delete process.env.CCFLARE_CODEX_EFFECTIVE_CONTEXT;
		}
	});

	it("reports the 372k context_window for GPT-5.6 models", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.6-sol" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.6-sol",
					usage: { input_tokens: 100, output_tokens: 50 },
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

		expect(messageDeltaLine).toContain('"context_window_size":372000');
	});

	it("resolves dated model variants to their family context window", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.6-sol-2026-05-13" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.6-sol-2026-05-13",
					usage: { input_tokens: 100, output_tokens: 50 },
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

		expect(messageDeltaLine).toContain('"context_window_size":372000');
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

	it("fallback message_start includes top-level usage", async () => {
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
		const errorLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"abrupt_stream_eof"'));

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
		expect(errorLine).not.toBeUndefined();
		expect(transformedBody).not.toContain('"type":"message_delta"');
		expect(transformedBody).not.toContain('"type":"message_stop"');
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

	it("normalizes current cache_write_tokens to Anthropic cache creation usage", async () => {
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
							cache_write_tokens: 11,
							cache_creation_input_tokens: 99,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const transformedBody = await (
			await provider.processResponse(response, null)
		).text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		const messageDelta = JSON.parse(
			(messageDeltaLine as string).slice("data: ".length),
		);
		expect(messageDelta.usage).toEqual({
			input_tokens: 26,
			output_tokens: 7,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 11,
		});
		expect(messageDelta.context_window.current_usage).toEqual({
			input_tokens: 26,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 11,
		});
	});

	it.each([
		"response.created",
		"response.failed",
		"response.completed",
	])("uses the shared cache-write normalization for %s usage", async (eventName) => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-usage-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const responsePayload: Record<string, unknown> = {
				id: `resp_${eventName}`,
				model: "gpt-5.4",
				usage: {
					input_tokens: 42,
					output_tokens: 7,
					input_tokens_details: {
						cached_tokens: 5,
						cache_write_tokens: 99,
					},
				},
			};
			if (eventName === "response.failed") {
				responsePayload.error = {
					type: "api_error",
					message: "failed",
				};
			}
			const transformed = await provider.processResponse(
				new Response(
					sseBody(eventLine(eventName, { response: responsePayload })),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
				null,
			);
			await transformed.text();
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);

			expect(record).toMatchObject({
				input_tokens: 42,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 37,
			});
		} finally {
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("traces response protocol identities only as keyed markers", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-protocol-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "private-response-id", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						id: "private-response-id",
						model: "gpt-5.4",
						usage: {
							input_tokens: 10,
							output_tokens: 1,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-codex-turn-state": "private-turn-state",
				},
			});

			await (await provider.processResponse(response, null)).text();
			const rawTrace = readFileSync(
				join(
					traceDir,
					readdirSync(traceDir).find((name) =>
						name.endsWith(".jsonl"),
					) as string,
				),
				"utf8",
			);
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);

			expect(record).toMatchObject({
				codex_turn_state_present: true,
				response_id_present: true,
			});
			expect(record?.codex_turn_state_hmac).toBeString();
			expect(record?.response_id_hmac).toBeString();
			expect(rawTrace).not.toContain("private-turn-state");
			expect(rawTrace).not.toContain("private-response-id");
		} finally {
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	for (const contentType of [undefined, "text/event-stream"]) {
		it(`streams the first SSE event before upstream closes with ${contentType ?? "missing"} content-type`, async () => {
			const provider = new CodexProvider();
			const encoder = new TextEncoder();
			let closeUpstream!: () => void;
			const upstreamBody = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							sseBody(
								eventLine("response.created", {
									response: { id: "resp_live", model: "gpt-5.4" },
								}),
							),
						),
					);
					closeUpstream = () => controller.close();
				},
			});
			const headers = new Headers();
			if (contentType !== undefined) {
				headers.set("content-type", contentType);
			}
			const response = new Response(upstreamBody, { status: 200, headers });

			const transformed = await provider.processResponse(response, null);
			const reader = transformed.body?.getReader();
			expect(reader).toBeDefined();
			const firstRead = await reader?.read();
			expect(firstRead?.done).toBeFalse();
			expect(new TextDecoder().decode(firstRead?.value)).toContain(
				"event: message_start",
			);

			closeUpstream();
			while (!(await reader?.read())?.done) {
				// Drain the transformed stream so its writer can close cleanly.
			}
		});
	}

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

	it("preserves request id in traces for missing-content-type SSE streams", async () => {
		const provider = new CodexProvider();
		const requestId = "req_trace_stream_missing_content_type";
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_trace", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-request-stream": "true",
				},
			});

			const transformed = await provider.processResponse(response, null);
			await transformed.text();

			const responseRecord = readTraceRecords(traceDir).find(
				(r) => r.phase === "response",
			);
			expect(responseRecord?.request_id).toBe(requestId);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("preserves request id in traces for missing-content-type SSE to JSON", async () => {
		const provider = new CodexProvider();
		const requestId = "req_trace_json_missing_content_type";
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_trace", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-request-stream": "false",
				},
			});

			const transformed = await provider.processResponse(response, null);
			await transformed.text();

			const responseRecord = readTraceRecords(traceDir).find(
				(r) => r.phase === "response",
			);
			expect(responseRecord?.request_id).toBe(requestId);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("passes through successful explicitly typed JSON bodies", async () => {
		const provider = new CodexProvider();
		const response = new Response('{"ok":true}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await transformed.text()).toBe('{"ok":true}');
	});

	it("returns Anthropic JSON for non-streaming missing-content-type SSE bodies", async () => {
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
			headers: { "x-better-ccflare-request-stream": "false" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = await transformed.json();
		expect(payload.content).toEqual([{ type: "text", text: "hello" }]);
		expect(payload.usage).toEqual({
			input_tokens: 2,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("surfaces Codex SSE errors instead of fabricating an empty streaming success", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
						message: "Input is too large",
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

		expect(transformedBody).toContain("event: error");
		expect(transformedBody).toContain(
			"Prompt is too long. Codex reported: Input is too large",
		);
		expect(transformedBody).toContain("context_length_exceeded");
		expect(transformedBody).not.toContain("event: message_delta");
		expect(transformedBody).not.toContain("event: message_stop");
	});

	it("closes an open content block before surfacing a streaming Codex error", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "partial" }),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "Codex failed after partial output",
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

		const stopPos = transformedBody.indexOf("event: content_block_stop");
		const errorPos = transformedBody.indexOf("event: error");
		expect(stopPos).toBeGreaterThan(-1);
		expect(errorPos).toBeGreaterThan(stopPos);
		expect(transformedBody).toContain("Codex failed after partial output");
	});

	it("surfaces Codex SSE errors as JSON errors for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "Codex failed",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex failed",
			},
		});
	});

	it("normalizes the subscription endpoint context-window message for streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message:
							"Your input exceeds the context window of this model. Please adjust your input and try again.",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain(
			"Prompt is too long. Codex reported: Your input exceeds the context window of this model. Please adjust your input and try again.",
		);
	});

	it("normalizes the subscription endpoint context-window message for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message:
							"Your input exceeds the context window of this model. Please adjust your input and try again.",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"Prompt is too long. Codex reported: Your input exceeds the context window of this model. Please adjust your input and try again.",
			},
		});
	});

	it("forces message-detected context overflow to a non-retryable invalid request", async () => {
		const provider = new CodexProvider();
		const upstreamMessage =
			"Your input exceeds the context window of this model. Please adjust your input and try again.";
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: { type: "api_error", message: upstreamMessage },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body.error).toEqual({
			type: "invalid_request_error",
			message: `Prompt is too long. Codex reported: ${upstreamMessage}`,
		});
	});

	it("maps non-streaming Codex context-window SSE errors to non-retryable bad requests", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("error", {
				type: "error",
				code: "context_length_exceeded",
				message: "Input is too large",
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Prompt is too long. Codex reported: Input is too large",
				code: "context_length_exceeded",
			},
		});
	});

	it("maps generic Codex error events to a valid Anthropic api_error type", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("error", {
				type: "error",
				code: "some_other_code",
				message: "Generic Codex failure",
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(502);
		expect(body.error.type).toBe("api_error");
		expect(body.error.code).toBe("some_other_code");
	});

	it("maps Codex rate-limited status to a non-streaming 429", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "rate_limited",
					error: {
						type: "error",
						message: "Rate limited by Codex",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(429);
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.status).toBe("rate_limited");
	});

	it.each([
		["error", { type: "error", message: "Terminal error" }],
		[
			"response.failed",
			{
				response: {
					status: "failed",
					error: { type: "api_error", message: "Terminal failure" },
				},
			},
		],
		[
			"response.completed",
			{ response: { model: "gpt-5.5", status: "completed" } },
		],
		[
			"response.incomplete",
			{
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
		],
	] as const)("keeps missing usage unavailable for %s", async (event, data) => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const transformed = await provider.processResponse(
				new Response(sseBody(eventLine(event, data)), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				null,
			);
			await transformed.text();
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);

			expect(record).toMatchObject({
				usage_measurement_available: false,
				cache_measurement_available: false,
				input_tokens: null,
				output_tokens: null,
				cache_read_input_tokens: null,
				cache_creation_input_tokens: null,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it.each([
		"response.failed",
		"response.completed",
		"response.incomplete",
	])("keeps missing cached-token usage unavailable for %s", async (event) => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const responseData: Record<string, unknown> = {
				model: "gpt-5.5",
				status:
					event === "response.failed"
						? "failed"
						: event === "response.incomplete"
							? "incomplete"
							: "completed",
				usage: { input_tokens: 12, output_tokens: 3 },
			};
			if (event === "response.failed") {
				responseData.error = { type: "api_error", message: "Failure" };
			} else if (event === "response.incomplete") {
				responseData.incomplete_details = { reason: "max_output_tokens" };
			}
			const transformed = await provider.processResponse(
				new Response(sseBody(eventLine(event, { response: responseData })), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				null,
			);
			await transformed.text();
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);

			expect(record).toMatchObject({
				usage_measurement_available: true,
				cache_measurement_available: false,
				input_tokens: 12,
				output_tokens: 3,
				cache_read_input_tokens: null,
				cache_creation_input_tokens: null,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("emits and traces abrupt_stream_eof while preserving known usage", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: {
						id: "resp_abrupt",
						model: "gpt-5.5",
						usage: {
							input_tokens: 100,
							output_tokens: 7,
							input_tokens_details: {
								cached_tokens: 60,
								cache_creation_input_tokens: 5,
							},
						},
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "logical-abrupt",
					"x-better-ccflare-attempt-id": "attempt-abrupt",
				},
			});

			const body = await (
				await provider.processResponse(response, null)
			).text();
			expect(body).toContain("event: error");
			expect(body).toContain('"type":"abrupt_stream_eof"');
			expect(body).not.toContain("event: message_delta");
			expect(body).not.toContain("event: message_stop");
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);
			expect(record).toMatchObject({
				request_id: "logical-abrupt",
				attempt_id: "attempt-abrupt",
				stop_reason: "error",
				error_type: "abrupt_stream_eof",
				usage_measurement_available: true,
				cache_measurement_available: true,
				input_tokens: 100,
				output_tokens: 7,
				cache_read_input_tokens: 60,
				cache_creation_input_tokens: 5,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("keeps usage unavailable and uses final wire model on abrupt EOF", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const response = new Response(sseBody([]), {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "logical-empty",
					"x-better-ccflare-attempt-id": "attempt-empty",
					"x-better-ccflare-final-model": "gpt-5.4-mini",
				},
			});

			const body = await (
				await provider.processResponse(response, null)
			).text();
			expect(body).toContain('"model":"gpt-5.4-mini"');
			expect(body).toContain('"type":"abrupt_stream_eof"');
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);
			expect(record).toMatchObject({
				model_out: "gpt-5.4-mini",
				usage_measurement_available: false,
				cache_measurement_available: false,
				input_tokens: null,
				output_tokens: null,
				cache_read_input_tokens: null,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("cancels the upstream stream and traces downstream cancellation", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		let cancelled = false;
		try {
			const upstream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							[
								"event: response.created",
								'data: {"response":{"id":"resp_cancel","model":"gpt-5.5","usage":{"input_tokens":11,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}}',
								"",
								"",
							].join("\n"),
						),
					);
				},
				cancel() {
					cancelled = true;
				},
			});
			const transformed = await provider.processResponse(
				new Response(upstream, {
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": "logical-cancel",
						"x-better-ccflare-attempt-id": "attempt-cancel",
					},
				}),
				null,
			);
			const reader = transformed.body?.getReader();
			await reader?.cancel("client disconnected");
			await Bun.sleep(10);
			expect(cancelled).toBe(true);
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);
			expect(record).toMatchObject({
				request_id: "logical-cancel",
				attempt_id: "attempt-cancel",
				stop_reason: "error",
				error_type: "downstream_cancelled",
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("writes one terminal trace when cancellation races completion", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const transformed = await provider.processResponse(
				new Response(
					sseBody(
						eventLine("response.completed", {
							response: {
								model: "gpt-5.5",
								status: "completed",
								usage: {
									input_tokens: 20,
									output_tokens: 3,
									input_tokens_details: { cached_tokens: 8 },
								},
							},
						}),
					),
					{
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-better-ccflare-request-id": "logical-race",
							"x-better-ccflare-attempt-id": "attempt-race",
						},
					},
				),
				null,
			);
			const reader = transformed.body?.getReader();
			await reader?.read();
			await reader?.cancel("client disconnected");
			await Bun.sleep(10);

			const records = readTraceRecords(traceDir).filter(
				(candidate) =>
					candidate.phase === "response" &&
					candidate.attempt_id === "attempt-race",
			);
			expect(records).toHaveLength(1);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("pauses upstream reads until the downstream consumer pulls", async () => {
		const provider = new CodexProvider();
		let upstreamReads = 0;
		const chunk = (index: number) =>
			new TextEncoder().encode(
				[
					"event: response.output_text.delta",
					`data: {"delta":"chunk-${index}"}`,
					"",
					"",
				].join("\n"),
			);
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				upstreamReads++;
				if (upstreamReads > 64) {
					controller.close();
					return;
				}
				controller.enqueue(chunk(upstreamReads));
			},
		});
		const transformed = await provider.processResponse(
			new Response(upstream, {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "logical-backpressure",
					"x-better-ccflare-attempt-id": "attempt-backpressure",
				},
			}),
			null,
		);

		// No downstream reader yet: the transform must not drain the upstream.
		await Bun.sleep(25);
		const readsBeforeConsumption = upstreamReads;
		expect(readsBeforeConsumption).toBeLessThan(16);

		const reader = transformed.body?.getReader();
		while (true) {
			const { done } = (await reader?.read()) ?? { done: true };
			if (done) break;
		}
		expect(upstreamReads).toBeGreaterThan(readsBeforeConsumption);
	});

	it("traces upstream stream read failures as terminal errors", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstream = new ReadableStream<Uint8Array>({
				pull() {
					throw new Error("upstream reset");
				},
			});
			const transformed = await provider.processResponse(
				new Response(upstream, {
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": "logical-read-error",
						"x-better-ccflare-attempt-id": "attempt-read-error",
					},
				}),
				null,
			);
			const body = await transformed.text();
			expect(body).toContain('"type":"upstream_stream_read_error"');
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);
			expect(record).toMatchObject({
				request_id: "logical-read-error",
				attempt_id: "attempt-read-error",
				stop_reason: "error",
				error_type: "upstream_stream_read_error",
				usage_measurement_available: false,
				cache_measurement_available: false,
				input_tokens: null,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("does not emit terminal events after response.failed when response.completed follows", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: { type: "invalid_request_error", message: "Context exceeded" },
				},
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					usage: { input_tokens: 5, output_tokens: 0 },
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
		expect(body).not.toContain("event: message_delta");
		expect(body).not.toContain("event: message_stop");
	});

	it("traces failed response usage and context as a true error", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.failed", {
					response: {
						model: "gpt-5.5-2026-07-14",
						status: "failed",
						error: {
							type: "invalid_request_error",
							message: "Context exceeded",
						},
						usage: {
							input_tokens: 10000,
							output_tokens: 4,
							input_tokens_details: { cached_tokens: 7500 },
						},
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});

			await (await provider.processResponse(response, null)).text();
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "response",
			);
			expect(record?.stop_reason).toBe("error");
			expect(record?.input_tokens).toBe(10000);
			expect(record?.cache_read_input_tokens).toBe(7500);
			expect(record?.output_tokens).toBe(4);
			expect(record?.cache_hit_pct).toBe(75);
			expect(record?.context_utilization_pct).toBeGreaterThan(0);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("maps response.incomplete with a content_filter reason to a refusal stop_reason", async () => {
		const provider = new CodexProvider();
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5-2026-07-14" },
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5-2026-07-14",
					status: "incomplete",
					incomplete_details: { reason: "content_filter" },
					usage: { input_tokens: 3000, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"refusal"');
		expect(body).toContain("event: message_delta");
		const responseRecord = readTraceRecords(traceDir).find(
			(r) => r.phase === "response",
		);
		expect(responseRecord?.stop_reason).toBe("refusal");
		expect(responseRecord?.context_utilization_pct).toBeGreaterThan(0);
		expect(responseRecord?.error_type).toBeUndefined();
		expect(body).toContain("event: message_stop");
		delete process.env[CODEX_TRACE_DIR_ENV];
		rmSync(traceDir, { recursive: true, force: true });
	});

	it("maps response.incomplete with a non-content_filter reason to max_tokens", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 3, output_tokens: 512 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"max_tokens"');
	});

	it("treats a response.completed event carrying status incomplete the same as response.incomplete", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "unknown_future_reason" },
					usage: { input_tokens: 3, output_tokens: 10 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"max_tokens"');
	});

	it("never resolves an incomplete response with a pending tool call to a success stop_reason", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 3, output_tokens: 50 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).not.toContain('"stop_reason":"tool_use"');
		expect(body).not.toContain('"stop_reason":"end_turn"');
		expect(body).toContain('"stop_reason":"max_tokens"');
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

describe("codexEventCommitsOutput", () => {
	// Wraps a downstream reader with a `drain(idleMs)` method that returns
	// whatever SSE frames are currently available, stopping as soon as no
	// further frame shows up within `idleMs`. Because the upstream is never
	// closed in these fixtures, the transform's unconditional end-of-stream
	// flush (which always calls ensureMessageStart, regardless of whether
	// anything actually committed) never fires, so any frame observed here is
	// provably caused by the event that was just pushed, not by
	// stream-teardown bookkeeping.
	//
	// A single in-flight `read()` promise is kept across drain() calls
	// (instead of issuing a fresh read() each time and abandoning whichever
	// one didn't resolve before the idle timeout): ReadableStreamDefaultReader
	// resolves concurrent read() calls in FIFO order, so abandoning a pending
	// read and issuing a new one on the next drain() would queue the new read
	// behind the abandoned one, silently misattributing the next chunk to the
	// wrong drain() call.
	const makeFrameReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
		const decoder = new TextDecoder();
		let buffer = "";
		let pending: ReturnType<typeof reader.read> | null = null;
		const drain = async (idleMs = 40): Promise<string[]> => {
			const frames: string[] = [];
			while (true) {
				if (!pending) pending = reader.read();
				const inFlight = pending;
				const winner = await Promise.race([
					inFlight.then((r) => ({ timedOut: false as const, ...r })),
					Bun.sleep(idleMs).then(() => ({ timedOut: true as const })),
				]);
				if (winner.timedOut) break;
				pending = null;
				if (winner.done) break;
				buffer += decoder.decode(winner.value, { stream: true });
				let idx = buffer.indexOf("\n\n");
				while (idx !== -1) {
					const frameText = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					const eventLine = frameText
						.split(/\r?\n/)
						.find((l) => l.startsWith("event:"));
					if (eventLine) frames.push(eventLine.slice("event:".length).trim());
					idx = buffer.indexOf("\n\n");
				}
			}
			return frames;
		};
		return { drain };
	};

	type PushableUpstream = {
		response: Response;
		push: (lines: string[]) => void;
	};
	const makePushableUpstream = (): PushableUpstream => {
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const encoder = new TextEncoder();
		return {
			response: new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "commit-predicate-corpus",
				},
			}),
			push: (lines: string[]) => {
				controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
			},
		};
	};

	// Runs `setupEvents` then `targetEvent` against a real transform, on a
	// stream that is never closed, and returns whether the target event alone
	// caused any new downstream frame to appear. Setup events are drained
	// (and discarded) before the target event is pushed, so only the target's
	// own marginal contribution is observed.
	const targetEventCommittedOutput = async (
		setupEvents: string[][],
		targetEvent: string[],
	): Promise<boolean> => {
		const provider = new CodexProvider();
		const upstream = makePushableUpstream();
		const transformed = await provider.processResponse(upstream.response, null);
		const reader = transformed.body?.getReader();
		if (!reader) throw new Error("transformed response has no body reader");
		const frameReader = makeFrameReader(reader);
		try {
			for (const setupEvent of setupEvents) {
				upstream.push(setupEvent);
			}
			if (setupEvents.length > 0) {
				await frameReader.drain();
			}
			upstream.push(targetEvent);
			const framesAfterTarget = await frameReader.drain();
			return framesAfterTarget.length > 0;
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	};

	it("response.created commits (eagerly emits message_start, not just at stream end)", async () => {
		const committed = await targetEventCommittedOutput(
			[],
			eventLine("response.created", {
				response: { id: "resp_1", model: "gpt-5.4" },
			}),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.created", {
				response: { id: "resp_1", model: "gpt-5.4" },
			}),
		);
		expect(committed).toBeTrue();
	});

	it("response.output_item.added commits for function_call items", async () => {
		const data = {
			item: { type: "function_call", call_id: "call_1", name: "Bash" },
		};
		const committed = await targetEventCommittedOutput(
			[eventLine("response.created", { response: { id: "resp_1" } })],
			eventLine("response.output_item.added", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.output_item.added", data),
		);
		expect(committed).toBeTrue();
	});

	it("response.output_item.added does not commit for message items", async () => {
		const data = { item: { type: "message" } };
		const committed = await targetEventCommittedOutput(
			[eventLine("response.created", { response: { id: "resp_1" } })],
			eventLine("response.output_item.added", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.output_item.added", data),
		);
		expect(committed).toBeFalse();
	});

	it("response.content_part.added commits for output_text parts", async () => {
		const data = { part: { type: "output_text" } };
		const committed = await targetEventCommittedOutput(
			[
				eventLine("response.created", { response: { id: "resp_1" } }),
				eventLine("response.output_item.added", { item: { type: "message" } }),
			],
			eventLine("response.content_part.added", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.content_part.added", data),
		);
		expect(committed).toBeTrue();
	});

	it("response.content_part.added does not commit for non-text parts", async () => {
		const data = { part: { type: "refusal" } };
		const committed = await targetEventCommittedOutput(
			[
				eventLine("response.created", { response: { id: "resp_1" } }),
				eventLine("response.output_item.added", { item: { type: "message" } }),
			],
			eventLine("response.content_part.added", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.content_part.added", data),
		);
		expect(committed).toBeFalse();
	});

	it("response.output_text.delta commits when delta is non-empty", async () => {
		const data = { delta: "Hello" };
		const committed = await targetEventCommittedOutput(
			[
				eventLine("response.created", { response: { id: "resp_1" } }),
				eventLine("response.output_item.added", { item: { type: "message" } }),
				eventLine("response.content_part.added", {
					part: { type: "output_text" },
				}),
			],
			eventLine("response.output_text.delta", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.output_text.delta", data),
		);
		expect(committed).toBeTrue();
	});

	it("response.output_text.delta does not commit when delta is empty", async () => {
		const data = { delta: "" };
		const committed = await targetEventCommittedOutput(
			[
				eventLine("response.created", { response: { id: "resp_1" } }),
				eventLine("response.output_item.added", { item: { type: "message" } }),
				eventLine("response.content_part.added", {
					part: { type: "output_text" },
				}),
			],
			eventLine("response.output_text.delta", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.output_text.delta", data),
		);
		expect(committed).toBeFalse();
	});

	it("response.function_call_arguments.delta never commits", async () => {
		const data = { delta: '{"command":', output_index: 0 };
		const committed = await targetEventCommittedOutput(
			[
				eventLine("response.created", { response: { id: "resp_1" } }),
				eventLine("response.output_item.added", {
					item: { type: "function_call", call_id: "call_1", name: "Bash" },
					output_index: 0,
				}),
			],
			eventLine("response.function_call_arguments.delta", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.function_call_arguments.delta", data),
		);
		expect(committed).toBeFalse();
	});

	it("unknown event names never commit", async () => {
		const data = { anything: true };
		const committed = await targetEventCommittedOutput(
			[eventLine("response.created", { response: { id: "resp_1" } })],
			eventLine("response.some_future_event", data),
		);
		expect(committed).toBe(
			codexEventCommitsOutput("response.some_future_event", data),
		);
		expect(committed).toBeFalse();
	});

	// The remaining switch cases (output_item.done, error/response.failed,
	// response.completed/response.incomplete) gate their writes on stream
	// STATE (hasSentContentBlockStart, hasSentTerminalEvents, upstreamError),
	// not on the event's own data, so they cannot be answered by a pure
	// (eventName, data) predicate the way the four ensureMessageStart() call
	// sites can. They are intentionally outside codexEventCommitsOutput's
	// scope (it only covers "the same decision points [the transform]
	// currently uses inline") and keep their existing independent gating,
	// verified separately by the pre-existing CodexProvider.processResponse
	// suite above. Assert the documented default here so any future case
	// added to the predicate without a matching corpus fixture is caught.
	it("state-gated switch cases fall through to the documented false default", () => {
		expect(
			codexEventCommitsOutput("response.output_item.done", {
				item: { type: "function_call" },
			}),
		).toBeFalse();
		expect(
			codexEventCommitsOutput("error", { error: { message: "boom" } }),
		).toBeFalse();
		expect(
			codexEventCommitsOutput("response.failed", {
				response: { error: { message: "boom" } },
			}),
		).toBeFalse();
		expect(
			codexEventCommitsOutput("response.completed", {
				response: { status: "completed" },
			}),
		).toBeFalse();
		expect(
			codexEventCommitsOutput("response.incomplete", {
				response: { status: "incomplete" },
			}),
		).toBeFalse();
	});
});

describe("CodexProvider SSE frame bounds", () => {
	const normalizeMessageId = (text: string) =>
		text.replace(/msg_[0-9a-f]{24}/g, "msg_TEST");

	// Counts how many times a given SSE event name appears in a translated
	// body, so cap-trip tests can assert exactly one terminal failure instead
	// of only "at least one".
	const countEventOccurrences = (body: string, eventName: string): number =>
		(body.match(new RegExp(`event: ${eventName}\\n`, "g")) ?? []).length;

	const crlfSseBody = (events: Array<[string, unknown]>) =>
		`${events
			.map(
				([name, data]) =>
					`event: ${name}\r\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\r\n`,
			)
			.join("\r\n")}\r\n`;

	it("produces identical output for CRLF-terminated frames as for LF-terminated frames", async () => {
		const events: Array<[string, unknown]> = [
			["response.created", { response: { id: "resp_crlf", model: "gpt-5.4" } }],
			[
				"response.output_item.added",
				{ item: { type: "message" }, output_index: 0 },
			],
			["response.content_part.added", { part: { type: "output_text" } }],
			["response.output_text.delta", { delta: "hello" }],
			[
				"response.completed",
				{
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		];

		const lfBody = sseBody(
			events.flatMap(([name, data]) => eventLine(name, data)),
		);
		const lfResponse = new Response(lfBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const lfText = normalizeMessageId(
			await (
				await new CodexProvider().processResponse(lfResponse, null)
			).text(),
		);

		const crlfResponse = new Response(crlfSseBody(events), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const crlfText = normalizeMessageId(
			await (
				await new CodexProvider().processResponse(crlfResponse, null)
			).text(),
		);

		expect(crlfText).toBe(lfText);
	});

	it("closes the open content block before an error when a single frame exceeds the per-frame cap", async () => {
		const provider = new CodexProvider();
		const encoder = new TextEncoder();
		let cancelReason: unknown;
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				// First chunk: opens a text content block, fully processed on its own.
				controller.enqueue(
					encoder.encode(
						sseBody([
							...eventLine("response.created", {
								response: { id: "resp_frame_cap", model: "gpt-5.4" },
							}),
							...eventLine("response.output_item.added", {
								item: { type: "message" },
								output_index: 0,
							}),
							...eventLine("response.content_part.added", {
								part: { type: "output_text" },
							}),
							...eventLine("response.output_text.delta", { delta: "partial" }),
						]),
					),
				);
				// Second chunk: a single complete frame whose payload alone exceeds
				// the per-frame cap. Sized against the new 4MiB transport frame
				// cap (SSE_TRANSPORT_FRAME_MAX_BYTES), not the old 64KiB shared
				// cap: a frame this size is now legal traffic well below the
				// ceiling everywhere except right here where it is the ceiling
				// itself that is being tripped.
				const oversizedPayload = "x".repeat(
					BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES + 1024,
				);
				controller.enqueue(
					encoder.encode(
						sseBody(
							eventLine("response.output_text.delta", {
								delta: oversizedPayload,
							}),
						),
					),
				);
				// Deliberately left open: a real upstream connection just idles
				// after the cap trip. The reader must be actively cancelled by
				// the consumer rather than relying on EOF that never arrives.
			},
			cancel(reason) {
				cancelReason = reason ?? "cancelled";
			},
		});

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).toContain('"code":"sse_limit_exceeded"');
		expect(countEventOccurrences(body, "error")).toBe(1);
		expect(body).not.toContain("event: message_delta");
		const startPos = body.indexOf("event: message_start");
		const stopPos = body.indexOf("event: content_block_stop");
		const errorPos = body.indexOf("event: error");
		expect(startPos).toBeGreaterThanOrEqual(0);
		expect(stopPos).toBeGreaterThan(startPos);
		expect(errorPos).toBeGreaterThan(stopPos);
		// The upstream source is always cancelled on a cap trip, never left
		// dangling for the caller to clean up.
		expect(cancelReason).toBeDefined();
	});

	// AE1: this is the exact real-world scenario that motivated raising the
	// SSE transport frame cap from 64KiB to 4MiB (see
	// packages/core/src/constants.ts, SSE_TRANSPORT_FRAME_MAX_BYTES). Under
	// the pre-U2 shared 64KiB cap this frame alone would have tripped the
	// per-frame limit and the stream would never have reached
	// response.completed; it must now translate successfully end to end,
	// with no limit error and no early upstream cancellation.
	it("accepts a 110,079-byte response.created frame (the largest complete frame observed in the field) and completes normally", async () => {
		const provider = new CodexProvider();
		const encoder = new TextEncoder();
		const targetFrameBytes = 110_079;
		const buildCreatedFrame = (padding: string) =>
			`event: response.created\ndata: ${JSON.stringify({
				response: {
					id: "resp_incident",
					model: "gpt-5.4",
					instructions: padding,
				},
			})}`;
		const baseBytes = encoder.encode(buildCreatedFrame("")).length;
		const padLength = targetFrameBytes - baseBytes;
		expect(padLength).toBeGreaterThan(0);
		const createdFrame = buildCreatedFrame("x".repeat(padLength));
		expect(encoder.encode(createdFrame).length).toBe(targetFrameBytes);

		const upstreamBody = sseBody([
			...createdFrame.split("\n"),
			"",
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).not.toContain("event: error");
		expect(body).not.toContain("sse_limit_exceeded");
		expect(body).toContain("event: message_start");
		expect(body).toContain("event: message_stop");
	});

	it("closes the open content block before an error when an unterminated tail exceeds the buffer cap", async () => {
		const provider = new CodexProvider();
		const encoder = new TextEncoder();
		let cancelReason: unknown;
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						sseBody([
							...eventLine("response.created", {
								response: { id: "resp_buffer_cap", model: "gpt-5.4" },
							}),
							...eventLine("response.output_item.added", {
								item: { type: "message" },
								output_index: 0,
							}),
							...eventLine("response.content_part.added", {
								part: { type: "output_text" },
							}),
							...eventLine("response.output_text.delta", { delta: "partial" }),
						]),
					),
				);
				// Never terminated: no blank-line delimiter arrives, so the tail
				// keeps growing past the unterminated-buffer cap.
				const runaway = `event: response.output_text.delta\ndata: {"delta":"${"y".repeat(
					BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1024,
				)}`;
				controller.enqueue(encoder.encode(runaway));
				// Deliberately left open: see the frame-cap test above for why
				// closing here would make cancellation a spec-mandated no-op.
			},
			cancel(reason) {
				cancelReason = reason ?? "cancelled";
			},
		});

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).toContain('"code":"sse_limit_exceeded"');
		expect(countEventOccurrences(body, "error")).toBe(1);
		expect(body).not.toContain("event: message_delta");
		const startPos = body.indexOf("event: message_start");
		const stopPos = body.indexOf("event: content_block_stop");
		const errorPos = body.indexOf("event: error");
		expect(startPos).toBeGreaterThanOrEqual(0);
		expect(stopPos).toBeGreaterThan(startPos);
		expect(errorPos).toBeGreaterThan(stopPos);
		expect(cancelReason).toBeDefined();
	});

	it("trips the aggregate tool-args cap when five parallel calls each stay under the per-call cap but exceed it together", async () => {
		const provider = new CodexProvider();
		const perCallArgBytes = 15_000;
		expect(perCallArgBytes).toBeLessThan(
			BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
		);
		expect(perCallArgBytes * 5).toBeGreaterThan(
			BUFFER_SIZES.TOOL_ARGUMENTS_TOTAL_MAX_BYTES,
		);

		const lines: string[] = [
			...eventLine("response.created", {
				response: { id: "resp_aggregate_cap", model: "gpt-5.4" },
			}),
		];
		for (let i = 0; i < 5; i++) {
			lines.push(
				...eventLine("response.output_item.added", {
					item: {
						type: "function_call",
						call_id: `call_${i}`,
						name: `tool_${i}`,
					},
					output_index: i,
				}),
			);
		}
		for (let i = 0; i < 5; i++) {
			lines.push(
				...eventLine("response.function_call_arguments.delta", {
					delta: "a".repeat(perCallArgBytes),
					output_index: i,
				}),
			);
		}

		const encoder = new TextEncoder();
		let cancelReason: unknown;
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody(lines)));
				// Deliberately left open: see the frame-cap test above for why
				// closing here would make cancellation a spec-mandated no-op.
			},
			cancel(reason) {
				cancelReason = reason ?? "cancelled";
			},
		});

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).toContain('"code":"sse_limit_exceeded"');
		expect(body).toContain("Aggregate tool call arguments totaled");
		expect(countEventOccurrences(body, "error")).toBe(1);
		expect(body).not.toContain("event: message_delta");
		expect(cancelReason).toBeDefined();
	});

	// AE2: a single tool call's own arguments alone exceed the per-call cap,
	// even though the frame ceiling is 4MiB and this call's individual delta
	// frames are nowhere near it.
	it("trips the per-call tool-args cap when a single call's own arguments alone exceed it", async () => {
		const provider = new CodexProvider();

		// Each individual delta frame stays well under the per-frame SSE cap
		// (now 4MiB); only their accumulated total for this one call exceeds
		// the per-call argument byte cap (still 64KiB, but sourced from the
		// dedicated TOOL_ARGUMENTS_PER_CALL_MAX_BYTES constant). This is
		// distinct from the aggregate-cap test above, which requires several
		// concurrently open calls that each individually stay under the
		// per-call cap.
		const chunkSize = 4096;
		const chunkCount =
			Math.ceil(BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES / chunkSize) + 2;

		const lines: string[] = [
			...eventLine("response.created", {
				response: { id: "resp_single_call_cap", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: {
					type: "function_call",
					call_id: "call_0",
					name: "tool_0",
				},
				output_index: 0,
			}),
		];
		for (let i = 0; i < chunkCount; i++) {
			lines.push(
				...eventLine("response.function_call_arguments.delta", {
					delta: "a".repeat(chunkSize),
					output_index: 0,
				}),
			);
		}

		const encoder = new TextEncoder();
		let cancelReason: unknown;
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody(lines)));
				// Deliberately left open: see the frame-cap test above for why
				// closing here would make cancellation a spec-mandated no-op.
			},
			cancel(reason) {
				cancelReason = reason ?? "cancelled";
			},
		});

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).toContain('"type":"api_error"');
		expect(body).toContain('"code":"sse_limit_exceeded"');
		expect(body).toContain("Tool call arguments for output_index 0 totaled");
		expect(body).not.toContain("Aggregate tool call arguments");
		expect(countEventOccurrences(body, "error")).toBe(1);
		expect(cancelReason).toBeDefined();
	});

	it("emits message_start before an error that arrives as the literal first SSE event", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody(
			eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "immediate failure",
					},
				},
			}),
		);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		const messageStartPos = body.indexOf("event: message_start");
		const errorPos = body.indexOf("event: error");
		expect(messageStartPos).toBeGreaterThanOrEqual(0);
		expect(errorPos).toBeGreaterThan(messageStartPos);
	});
});

describe("CodexProvider upstream error code classification", () => {
	const errorForCode = async (code: string) => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("error", {
				type: "error",
				code,
				message: `Codex reported ${code}`,
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = (await transformed.json()) as {
			error: { type: string; code?: string };
		};
		return { status: transformed.status, body };
	};

	it("maps insufficient_quota to rate_limit_error", async () => {
		const { status, body } = await errorForCode("insufficient_quota");
		expect(body.error.type).toBe("rate_limit_error");
		expect(status).toBe(429);
	});

	it("maps server_is_overloaded to overloaded_error", async () => {
		const { status, body } = await errorForCode("server_is_overloaded");
		expect(body.error.type).toBe("overloaded_error");
		expect(status).toBe(529);
	});

	it("maps slow_down to overloaded_error", async () => {
		const { status, body } = await errorForCode("slow_down");
		expect(body.error.type).toBe("overloaded_error");
		expect(status).toBe(529);
	});

	it("maps cyber_policy to invalid_request_error", async () => {
		const { status, body } = await errorForCode("cyber_policy");
		expect(body.error.type).toBe("invalid_request_error");
		expect(status).toBe(400);
	});

	it("maps usage_not_included to permission_error", async () => {
		const { status, body } = await errorForCode("usage_not_included");
		expect(body.error.type).toBe("permission_error");
		expect(status).toBe(403);
	});

	it("maps server_error to api_error", async () => {
		const { status, body } = await errorForCode("server_error");
		expect(body.error.type).toBe("api_error");
		expect(status).toBe(502);
	});
});

describe("CodexProvider.transformRequestBody", () => {
	it("returns a synthetic Anthropic count_tokens response", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				messages: [{ role: "user", content: "hello world" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"200",
		);
		expect(body.input_tokens).toBeNumber();
		expect(body.input_tokens).toBeGreaterThan(0);
		expect(body).not.toHaveProperty("input");
		expect(body).not.toHaveProperty("stream");
		expect(body).not.toHaveProperty("store");
	});

	it("estimates count_tokens from prompt material instead of the full JSON envelope", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.input_tokens).toBeGreaterThan(0);
		expect(body.input_tokens).toBeLessThan(10);
	});

	it("returns a synthetic error for malformed count_tokens requests", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not-json",
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex count_tokens requires a valid JSON request body.",
			},
		});
	});

	it("returns a synthetic error for non-JSON count_tokens requests", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "hello",
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(body.error.message).toBe(
			"Codex count_tokens requires an application/json request body.",
		);
	});

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

	it("forces StructuredOutput tool_choice when the Claude Code schema tool is present", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				messages: [{ role: "user", content: "return structured output" }],
				tools: [
					{
						name: "StructuredOutput",
						description: "Return the validated payload.",
						input_schema: {
							type: "object",
							additionalProperties: false,
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.tools.map((t: { name: string }) => t.name)).toContain(
			"StructuredOutput",
		);
		expect(body.tool_choice).toEqual({
			type: "function",
			name: "StructuredOutput",
		});
	});

	it("does not force tool_choice for ordinary tool-enabled requests", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				messages: [{ role: "user", content: "read a file" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: {
							type: "object",
							properties: { file_path: { type: "string" } },
							required: ["file_path"],
						},
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.tool_choice).toBeUndefined();
	});

	it.each([
		[{ type: "auto" }, "auto"],
		[{ type: "any" }, "required"],
		[{ type: "none" }, "none"],
		[
			{ type: "tool", name: "Read" },
			{ type: "function", name: "Read" },
		],
	] as const)("maps Anthropic tool_choice %j to Codex", async (toolChoice, expected) => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "read a file" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: toolChoice,
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.tool_choice).toEqual(expected);
	});

	it("preserves tool-choice controls even when no tools are declared", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "answer directly" }],
				tool_choice: { type: "auto", disable_parallel_tool_use: true },
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
	});

	it("preserves explicit tool_choice precedence over StructuredOutput fallback", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "return text" }],
				tools: [
					{
						name: "StructuredOutput",
						description: "Return structured output.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: { type: "none" },
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.tool_choice).toBe("none");
	});

	it("rejects a named tool_choice that is absent from tools", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "search" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: { type: "tool", name: "WebSearch" },
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"tool_choice references unknown tool: WebSearch",
		);
	});

	it("elects one stable orchestration root per session independently of prompt caching", async () => {
		const provider = new CodexProvider();
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const transform = async (content: string, includeTools = true) => {
			const transformed = await provider.transformRequestBody(
				new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "claude-opus-4-8",
						max_tokens: 10,
						metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
						messages: [{ role: "user", content }],
						...(includeTools
							? {
									tools: ["Agent", "Task", "Read"].map((name) => ({
										name,
										input_schema: { type: "object" },
									})),
								}
							: {}),
					}),
				}),
			);
			return transformed.json();
		};

		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
		const root = await transform("root task");
		await transform("tool-less turn", false);
		const sibling = await transform("sibling task");
		const stableRoot = await transform("root task");
		const stableSibling = await transform("sibling task");

		expect(root.prompt_cache_key).toBeUndefined();
		expect(root.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"Agent",
			"Task",
			"Read",
		]);
		expect(sibling.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"Read",
		]);
		expect(stableRoot.tools.map((tool: { name: string }) => tool.name)).toEqual(
			["Agent", "Task", "Read"],
		);
		expect(
			stableSibling.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["Read"]);
	});

	it("documents today's bug: a compaction-shaped follow-up turn loses Agent/Task at the provider boundary", async () => {
		const provider = new CodexProvider();
		const sessionId = "44444444-4444-4444-8444-444444444444";
		const tools = ["Agent", "Task", "Read"].map((name) => ({
			name,
			input_schema: { type: "object" },
		}));
		const send = async (
			messages: unknown[],
			headers: Record<string, string> = {},
		) => {
			const transformed = await provider.transformRequestBody(
				new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({
						model: "claude-opus-4-8",
						max_tokens: 10,
						metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
						messages,
						tools,
					}),
				}),
			);
			return transformed.json();
		};

		const originalMessages = [
			{ role: "user", content: "start the task" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "agent-1",
						name: "Agent",
						input: { prompt: "look into it" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "agent-1", content: "findings" },
				],
			},
		];

		const root = await send(originalMessages);
		expect(root.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"Agent",
			"Task",
			"Read",
		]);

		// Compaction drops the earliest input item, keeps the tail, and appends
		// a new turn. Same session and instructions, still the same logical
		// conversation continuing, but the first surviving item is now what
		// used to be item[1], so admission's derived identity changes anyway.
		const compactedMessages = [
			...originalMessages.slice(1),
			{ role: "user", content: "continue the task" },
		];

		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		let compacted: { tools: Array<{ name: string }> };
		try {
			compacted = await send(compactedMessages, {
				"x-better-ccflare-request-id": "compacted-follow-up",
			});
			const requestTrace = readTraceRecords(traceDir).find(
				(record) =>
					record.phase === "request" &&
					record.request_id === "compacted-follow-up",
			);
			// BUG (documented, not fixed here): the demotion diagnostics confirm
			// this was a session that already had an elected root.
			expect(requestTrace).toMatchObject({
				trace_schema_version: 10,
				orchestration_admission: "non_root",
				orchestration_demotion_observed: true,
			});
			expect(requestTrace?.elapsed_ms_since_root).toBeTypeOf("number");
			expect(
				requestTrace?.elapsed_ms_since_root as number,
			).toBeGreaterThanOrEqual(0);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}

		// BUG (documented, not fixed here): Agent/Task are incorrectly filtered
		// out of the request for what is still logically the orchestrator's own
		// session, purely because compaction reshaped the derived identity.
		expect(compacted.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"Read",
		]);
	});

	it("only an exact zero disables orchestration election", async () => {
		const provider = new CodexProvider();
		const sessionId = "22222222-2222-4222-8222-222222222222";
		const transform = async (content: string) => {
			const transformed = await provider.transformRequestBody(
				new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "claude-opus-4-8",
						max_tokens: 10,
						metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
						messages: [{ role: "user", content }],
						tools: ["Agent", "Task"].map((name) => ({
							name,
							input_schema: { type: "object" },
						})),
					}),
				}),
			);
			return transformed.json();
		};

		process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV] = "0";
		const disabledA = await transform("a");
		const disabledB = await transform("b");
		expect(disabledA.tools).toHaveLength(2);
		expect(disabledB.tools).toHaveLength(2);

		process.env[CODEX_SINGLE_ORCHESTRATION_ROOT_ENV] = "false";
		const root = await transform("c");
		const sibling = await transform("d");
		expect(root.tools).toHaveLength(2);
		expect(sibling.tools).toHaveLength(0);
	});

	it("filters current Agent and Task tools for attributed descendants only", async () => {
		const provider = new CodexProvider();
		const payload = {
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "agent-history",
							name: "Agent",
							input: { prompt: "historical call" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "agent-history",
							content: "historical result",
						},
					],
				},
			],
			tools: ["Agent", "Task", "Read"].map((name) => ({
				name,
				description: `${name} tool`,
				input_schema: { type: "object" },
			})),
		};
		const transform = (attributed: boolean) =>
			provider.transformRequestBody(
				new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(attributed
							? { "x-better-ccflare-attributed-agent": "true" }
							: {}),
					},
					body: JSON.stringify(payload),
				}),
			);

		const topLevel = await transform(false);
		const topLevelBody = await topLevel.json();
		expect(
			topLevelBody.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["Agent", "Task", "Read"]);

		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		let descendant: Request;
		try {
			descendant = await provider.transformRequestBody(
				new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-attributed-agent": "true",
						"x-better-ccflare-request-id": "descendant-trace",
					},
					body: JSON.stringify(payload),
				}),
			);
			const requestTrace = readTraceRecords(traceDir).find(
				(record) => record.phase === "request",
			);
			expect(requestTrace).toMatchObject({
				trace_schema_version: 10,
				orchestration_admission: "no_session",
				is_descendant: true,
				tools_before_count: 3,
				tools_after_count: 1,
				filtered_tool_names: ["Agent", "Task"],
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
		const descendantBody = await descendant.json();
		expect(
			descendant.headers.get("x-better-ccflare-attributed-agent"),
		).toBeNull();
		expect(
			descendantBody.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["Read"]);
		expect(descendantBody.input).toContainEqual(
			expect.objectContaining({
				type: "function_call",
				name: "Agent",
				call_id: "agent-history",
			}),
		);
		expect(descendantBody.input).toContainEqual(
			expect.objectContaining({
				type: "function_call_output",
				call_id: "agent-history",
				output: "historical result",
			}),
		);
	});

	it.each([
		"Agent",
		"Task",
	])("rejects explicit %s tool_choice after descendant filtering", async (toolName) => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-attributed-agent": "true",
			},
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "delegate" }],
				tools: [
					{
						name: toolName,
						description: "Delegate work.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: { type: "tool", name: toolName },
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			`tool_choice references unknown tool: ${toolName}`,
		);
	});

	describe("session cache-key canary", () => {
		const sessionA = "11111111-1111-4111-8111-111111111111";
		const sessionB = "22222222-2222-4222-8222-222222222222";
		const transform = async (
			sessionId: string,
			content = "task A",
			system = "shared system prompt",
			messages?: Array<Record<string, unknown>>,
			account?: Parameters<CodexProvider["transformRequestBody"]>[1],
		) => {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					system,
					metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
					messages: messages ?? [{ role: "user", content }],
				}),
			});
			return new CodexProvider()
				.transformRequestBody(request, account)
				.then((response) => response.json());
		};

		it.each([
			[undefined, 0],
			["", 0],
			["0", 0],
			["37", 37],
			["100", 100],
			["101", 100],
			["999", 100],
			["-1", 0],
			["+1", 0],
			["1.5", 0],
			["1e2", 0],
			[" 10", 0],
			["10 ", 0],
			["nope", 0],
		] as const)("strictly parses session percentage %p", (raw, expected) => {
			expect(readCodexCacheKeySessionPercent(raw)).toBe(expected);
		});

		it("uses stable domain-separated bucket fixtures and normalizes UUID case", () => {
			expect(deriveCodexCacheKeySessionBucket(sessionA)).toBe(39);
			expect(deriveCodexCacheKeySessionBucket(sessionB)).toBe(31);
			expect(deriveCodexCacheKeySessionBucket(sessionA.toUpperCase())).toBe(
				deriveCodexCacheKeySessionBucket(sessionA),
			);
		});

		it("keeps 0 percent in conversation mode and 100 percent in session mode", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "0";
			const control = await transform(sessionA);
			expect(control.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);

			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "100";
			const treatment = await transform(sessionA);
			expect(treatment.prompt_cache_key).toMatch(
				/^ccflare-session-[0-9a-f]{48}$/,
			);
		});

		it("assigns fixed sessions on opposite sides of a deterministic boundary", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "35";
			const control = await transform(sessionA);
			const treatment = await transform(sessionB);
			expect(control.prompt_cache_key).toMatch(/^ccflare-convo-/);
			expect(treatment.prompt_cache_key).toMatch(/^ccflare-session-/);
		});

		it("keeps assignment stable across turns, providers, restarts, and sibling conversations", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "35";
			const first = await transform(sessionA, "task A");
			const later = await transform(
				sessionA,
				"task A",
				"shared system prompt",
				[
					{ role: "user", content: "task A" },
					{ role: "assistant", content: "working" },
					{ role: "user", content: "continue" },
				],
			);
			const sibling = await transform(sessionA, "task B");
			expect(first.prompt_cache_key).toMatch(/^ccflare-convo-/);
			expect(later.prompt_cache_key).toBe(first.prompt_cache_key);
			expect(sibling.prompt_cache_key).toMatch(/^ccflare-convo-/);
			expect(sibling.prompt_cache_key).not.toBe(first.prompt_cache_key);
		});

		it("shares one session key across sibling conversations in treatment", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "100";
			const first = await transform(sessionA, "task A");
			const sibling = await transform(
				sessionA,
				"task B",
				"other system prompt",
			);
			expect(sibling.prompt_cache_key).toBe(first.prompt_cache_key);
		});

		it("gives the explicit session override precedence over canary control", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "0";
			process.env[CODEX_CACHE_KEY_MODE_ENV] = "session";
			const body = await transform(sessionA);
			expect(body.prompt_cache_key).toMatch(/^ccflare-session-/);
		});

		it("preserves the session-key empty-input fallback", async () => {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "0";
			const body = await transform(sessionA, "", "shared system prompt", []);
			expect(body.prompt_cache_key).toMatch(/^ccflare-session-/);
		});

		it("keeps zero percent byte-for-byte compatible with the unset canary", async () => {
			const baseline = await transform(sessionA);
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "0";
			const explicitZero = await transform(sessionA);
			expect(explicitZero).toEqual(baseline);
		});

		it("re-evaluates endpoint eligibility for the selected account", async () => {
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "100";
			const eligible = await transform(sessionA);
			const customAccount = {
				name: "custom-codex",
				custom_endpoint: "https://my-openai-proxy.example.com/v1/responses",
			} as Parameters<CodexProvider["transformRequestBody"]>[1];
			const ineligible = await transform(
				sessionA,
				"task A",
				"shared system prompt",
				undefined,
				customAccount,
			);
			expect(eligible.prompt_cache_key).toMatch(/^ccflare-session-/);
			expect(ineligible.prompt_cache_key).toBeUndefined();
		});

		it("does not assign malformed metadata or bypass explicit disable", async () => {
			process.env[CODEX_CACHE_KEY_SESSION_PERCENT_ENV] = "100";
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
			const disabled = await transform(sessionA);
			expect(disabled.prompt_cache_key).toBeUndefined();

			delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
			const malformed = await transform("not-a-uuid");
			expect(malformed.prompt_cache_key).toBeUndefined();
		});
	});

	it("attaches prompt_cache_key by default", async () => {
		const provider = new CodexProvider();
		const request = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
	});

	it("rotates only an official subscription cache key for a cache-lane rescue", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const provider = new CodexProvider();
		const payload = JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 10,
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			messages: [{ role: "user", content: "hello" }],
		});
		const transform = async (
			cause: "initial" | "cache_lane_rescue",
			requestId: string,
			endpoint = CODEX_DEFAULT_ENDPOINT,
			account?: Parameters<CodexProvider["transformRequestBody"]>[1],
		) => {
			const request = new Request(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-attempt-id": `${cause}-attempt`,
					"x-better-ccflare-attempt-ordinal": cause === "initial" ? "1" : "2",
					"x-better-ccflare-attempt-cause": cause,
				},
				body: payload,
			});
			return provider
				.transformRequestBody(request, account)
				.then((response) => response.json()) as Promise<{
				prompt_cache_key?: string;
			}>;
		};

		const initial = await transform("initial", "logical-request-a");
		const repeatedInitial = await transform("initial", "logical-request-a");
		const rescue = await transform("cache_lane_rescue", "logical-request-a");
		const repeatedRescue = await transform(
			"cache_lane_rescue",
			"logical-request-a",
		);
		const otherRequestRescue = await transform(
			"cache_lane_rescue",
			"logical-request-b",
		);

		expect(initial.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(repeatedInitial.prompt_cache_key).toBe(initial.prompt_cache_key);
		expect(rescue.prompt_cache_key).toMatch(/^ccflare-rescue-[0-9a-f]{48}$/);
		expect(rescue.prompt_cache_key).not.toBe(initial.prompt_cache_key);
		expect(repeatedRescue.prompt_cache_key).toBe(rescue.prompt_cache_key);
		expect(otherRequestRescue.prompt_cache_key).not.toBe(
			rescue.prompt_cache_key,
		);

		const customAccount = {
			name: "custom-codex",
			custom_endpoint: "https://my-openai-proxy.example.com/v1/responses",
		} as Parameters<CodexProvider["transformRequestBody"]>[1];
		const customRescue = await transform(
			"cache_lane_rescue",
			"logical-request-a",
			customAccount.custom_endpoint ?? undefined,
			customAccount,
		);
		expect(customRescue.prompt_cache_key).toBeUndefined();
	});

	it("traces cache-lane rescue as a distinct physical attempt cause", async () => {
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const request = new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": "logical-rescue",
					"x-better-ccflare-attempt-id": "physical-rescue",
					"x-better-ccflare-attempt-ordinal": "2",
					"x-better-ccflare-attempt-cause": "cache_lane_rescue",
				},
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: {
						user_id: JSON.stringify({
							session_id: "11111111-1111-4111-8111-111111111111",
						}),
					},
					messages: [{ role: "user", content: "hello" }],
				}),
			});

			await new CodexProvider().transformRequestBody(request);
			const record = readTraceRecords(traceDir).find(
				(candidate) => candidate.phase === "request",
			);

			expect(record).toMatchObject({
				request_id: "logical-rescue",
				attempt_id: "physical-rescue",
				attempt_ordinal: 2,
				attempt_cause: "cache_lane_rescue",
				prompt_cache_key_set: true,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("rotates and traces a precommit SSE retry under its own attempt cause", async () => {
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		const payload = JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 10,
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			messages: [{ role: "user", content: "hello" }],
		});
		const transform = async (
			cause: "initial" | "precommit_sse_retry",
			attemptId: string,
		) => {
			const request = new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": "logical-sse-retry",
					"x-better-ccflare-attempt-id": attemptId,
					"x-better-ccflare-attempt-ordinal": cause === "initial" ? "1" : "2",
					"x-better-ccflare-attempt-cause": cause,
				},
				body: payload,
			});
			return (await new CodexProvider()
				.transformRequestBody(request)
				.then((response) => response.json())) as {
				prompt_cache_key?: string;
			};
		};

		try {
			const initial = await transform("initial", "physical-initial");
			const retry = await transform(
				"precommit_sse_retry",
				"physical-sse-retry",
			);

			expect(initial.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
			expect(retry.prompt_cache_key).toMatch(/^ccflare-rescue-[0-9a-f]{48}$/);
			expect(retry.prompt_cache_key).not.toBe(initial.prompt_cache_key);
			const retryRecord = readTraceRecords(traceDir).find(
				(candidate) => candidate.attempt_id === "physical-sse-retry",
			);
			expect(retryRecord).toMatchObject({
				request_id: "logical-sse-retry",
				attempt_id: "physical-sse-retry",
				attempt_ordinal: 2,
				attempt_cause: "precommit_sse_retry",
				prompt_cache_key_set: true,
			});
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("omits prompt_cache_key when explicitly disabled", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
		const provider = new CodexProvider();
		const request = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("omits prompt_cache_key for custom endpoints", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const provider = new CodexProvider();
		const account = {
			name: "custom-codex",
			custom_endpoint: "https://my-openai-proxy.example.com/v1/responses",
		} as Parameters<typeof provider.buildUrl>[2];
		const request = new Request(
			"https://my-openai-proxy.example.com/v1/responses",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: {
						user_id: JSON.stringify({
							session_id: "11111111-1111-4111-8111-111111111111",
						}),
					},
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("derives a deterministic prompt_cache_key from Claude Code session metadata when enabled", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const transform = async (sessionId: string) => {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
					messages: [{ role: "user", content: "hello" }],
				}),
			});
			return new CodexProvider()
				.transformRequestBody(request)
				.then((r) => r.json());
		};

		const first = await transform("11111111-1111-4111-8111-111111111111");
		const repeated = await transform("11111111-1111-4111-8111-111111111111");
		const different = await transform("22222222-2222-4222-8222-222222222222");

		expect(first.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(repeated.prompt_cache_key).toBe(first.prompt_cache_key);
		expect(different.prompt_cache_key).not.toBe(first.prompt_cache_key);
		expect(first.prompt_cache_key).not.toContain("11111111");
	});

	it("conversation keys are stable across turns and distinct across conversations", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const transform = async (payload: Record<string, unknown>) => {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: {
						user_id: JSON.stringify({
							session_id: "11111111-1111-4111-8111-111111111111",
						}),
					},
					...payload,
				}),
			});
			return new CodexProvider()
				.transformRequestBody(request)
				.then((r) => r.json());
		};

		const turn1 = await transform({
			system: "main loop system prompt",
			messages: [{ role: "user", content: "task A" }],
		});
		// Same conversation, one turn later: identical first message, longer tail.
		const turn2 = await transform({
			system: "main loop system prompt",
			messages: [
				{ role: "user", content: "task A" },
				{ role: "assistant", content: "working on it" },
				{ role: "user", content: "continue" },
			],
		});
		// Sibling subagent: same session and system, different first message.
		const sibling = await transform({
			system: "main loop system prompt",
			messages: [{ role: "user", content: "task B" }],
		});
		// Different agent type: same first message, different system prompt.
		const otherAgent = await transform({
			system: "subagent system prompt",
			messages: [{ role: "user", content: "task A" }],
		});

		expect(turn1.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(turn2.prompt_cache_key).toBe(turn1.prompt_cache_key);
		expect(sibling.prompt_cache_key).not.toBe(turn1.prompt_cache_key);
		expect(otherAgent.prompt_cache_key).not.toBe(turn1.prompt_cache_key);
	});

	it("session mode restores the coarse per-session key", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		process.env[CODEX_CACHE_KEY_MODE_ENV] = "session";
		const transform = async (content: string) => {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: {
						user_id: JSON.stringify({
							session_id: "11111111-1111-4111-8111-111111111111",
						}),
					},
					messages: [{ role: "user", content }],
				}),
			});
			return new CodexProvider()
				.transformRequestBody(request)
				.then((r) => r.json());
		};

		const first = await transform("task A");
		const other = await transform("completely different task");

		expect(first.prompt_cache_key).toMatch(/^ccflare-session-[0-9a-f]{48}$/);
		expect(other.prompt_cache_key).toBe(first.prompt_cache_key);
	});

	it("omits prompt_cache_key for malformed session metadata", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				metadata: { user_id: "not-json" },
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toBeUndefined();
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
		expect(headers.get("Version")).toBe(CODEX_VERSION);
		expect(headers.get("Openai-Beta")).toBe("responses=experimental");
		expect(headers.get("User-Agent")).toContain(`codex-cli/${CODEX_VERSION}`);
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
		expect(recorded?.init.signal?.aborted).toBe(true);
	});

	it("omits max_output_tokens for default subscription usage refreshes", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", { status: 200 }),
		) as unknown as typeof fetch;

		await fetchCodexUsageOnDemand("test-token");

		expect(recorded?.url).toBe(CODEX_DEFAULT_ENDPOINT);
		const body = JSON.parse(recorded?.init.body as string);
		expect(body).not.toHaveProperty("max_output_tokens");
	});

	it("falls back from an invalid usage endpoint and applies subscription rules", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", { status: 200 }),
		) as unknown as typeof fetch;

		await fetchCodexUsageOnDemand("test-token", "not-a-url");

		expect(recorded?.url).toBe(CODEX_DEFAULT_ENDPOINT);
		const body = JSON.parse(recorded?.init.body as string);
		expect(body).not.toHaveProperty("max_output_tokens");
	});

	it("preserves the response snapshot when body cancellation throws", async () => {
		const body = new ReadableStream({
			cancel() {
				throw new Error("cancel failed");
			},
		});
		globalThis.fetch = makeMockFetch(
			new Response(body, {
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1775000000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(recorded?.init.signal?.aborted).toBe(true);
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
		expect(result.data?.five_hour.utilization).toBe(100);
	});

	it("aborts a pending usage refresh when the request timeout fires", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		let timeoutCallback: (() => void) | null = null;
		let observedSignal: AbortSignal | null = null;
		let clearTimeoutCalls = 0;

		globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
			timeoutCallback = () => callback();
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = (() => {
			clearTimeoutCalls += 1;
		}) as typeof clearTimeout;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			recorded = { url: String(input), init: init ?? {} };
			observedSignal = init?.signal ?? null;
			return await new Promise<Response>((_resolve, reject) => {
				observedSignal?.addEventListener(
					"abort",
					() =>
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						),
					{ once: true },
				);
			});
		}) as typeof fetch;

		try {
			const pending = fetchCodexUsageOnDemand("test-token");
			expect(timeoutCallback).not.toBeNull();
			timeoutCallback?.();

			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			expect(observedSignal?.aborted).toBe(true);
			expect(clearTimeoutCalls).toBe(1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	it("aborts before cancelling the body and preserves the response snapshot", async () => {
		let cancelCalled = 0;
		let signalWasAbortedDuringCancel = false;
		const body = new ReadableStream({
			cancel() {
				cancelCalled += 1;
				signalWasAbortedDuringCancel = recorded?.init.signal?.aborted === true;
			},
		});
		globalThis.fetch = makeMockFetch(
			new Response(body, {
				status: 202,
				headers: {
					"x-codex-primary-used-percent": "42",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1775000000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand("test-token");

		expect(cancelCalled).toBe(1);
		expect(signalWasAbortedDuringCancel).toBe(true);
		expect(recorded?.init.signal?.aborted).toBe(true);
		expect(result.response.status).toBe(202);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
		expect(result.data?.five_hour.utilization).toBe(42);
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
