import { describe, expect, it } from "bun:test";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { QwenProvider } from "../provider";

type CacheControl = { type: string };
type CacheableTool = NonNullable<OpenAIRequest["tools"]>[number] & {
	cache_control?: CacheControl;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "qwen-1",
		name: "qwen-test",
		provider: "qwen",
		api_key: null,
		refresh_token: "",
		access_token: "at-xyz",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		...overrides,
	};
}

function makeOpenAIRequest(
	systemContent: OpenAIRequest["messages"][number]["content"],
): OpenAIRequest {
	return {
		model: "coder-model",
		messages: [
			{ role: "system", content: systemContent },
			{ role: "user", content: "Hello" },
		],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QwenProvider", () => {
	let provider: QwenProvider;

	// Use a fresh instance per test group — beforeEach not strictly needed
	// since QwenProvider has no mutable state, but it mirrors other test files.
	provider = new QwenProvider();

	// -------------------------------------------------------------------------
	// 1. name
	// -------------------------------------------------------------------------
	describe("name", () => {
		it('should be "qwen"', () => {
			expect(provider.name).toBe("qwen");
		});
	});

	// -------------------------------------------------------------------------
	// 2. parseRateLimit
	// -------------------------------------------------------------------------
	describe("parseRateLimit", () => {
		it("returns isRateLimited: false and statusHeader: allowed for a 200", () => {
			const response = new Response(null, { status: 200 });
			const result = provider.parseRateLimit(response);
			expect(result.isRateLimited).toBe(false);
			expect(result.statusHeader).toBe("allowed");
		});

		it("returns isRateLimited: false even for a 429", () => {
			const response = new Response(null, {
				status: 429,
				headers: { "retry-after": "60" },
			});
			const result = provider.parseRateLimit(response);
			expect(result.isRateLimited).toBe(false);
			expect(result.statusHeader).toBe("allowed");
		});

		it("returns isRateLimited: false for a 403", () => {
			const response = new Response(null, { status: 403 });
			const result = provider.parseRateLimit(response);
			expect(result.isRateLimited).toBe(false);
		});

		it("ignores x-ratelimit-* headers and still returns allowed", () => {
			const headers = new Headers({
				"x-ratelimit-remaining-requests": "0",
				"x-ratelimit-reset-requests": "1640995200",
			});
			const response = new Response(null, { status: 200, headers });
			const result = provider.parseRateLimit(response);
			expect(result.isRateLimited).toBe(false);
			expect(result.statusHeader).toBe("allowed");
		});
	});

	// -------------------------------------------------------------------------
	// 3. supportsOAuth
	// -------------------------------------------------------------------------
	describe("supportsOAuth", () => {
		it("returns true", () => {
			expect(provider.supportsOAuth()).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// 4. prepareHeaders
	// -------------------------------------------------------------------------
	describe("prepareHeaders", () => {
		it("sets Authorization: Bearer <accessToken> when accessToken provided", () => {
			const headers = provider.prepareHeaders(new Headers(), "my-token");
			expect(headers.get("Authorization")).toBe("Bearer my-token");
		});

		it("does not set Authorization header when no accessToken provided", () => {
			const headers = provider.prepareHeaders(new Headers());
			expect(headers.get("Authorization")).toBeNull();
		});

		it("always sets Content-Type: application/json", () => {
			const headers = provider.prepareHeaders(new Headers(), "tok");
			expect(headers.get("Content-Type")).toBe("application/json");
		});

		it("always sets a User-Agent containing QwenCode", () => {
			const headers = provider.prepareHeaders(new Headers(), "tok");
			expect(headers.get("User-Agent")).toContain("QwenCode");
		});

		it("always sets X-DashScope-AuthType: qwen-oauth", () => {
			const headers = provider.prepareHeaders(new Headers(), "tok");
			expect(headers.get("X-DashScope-AuthType")).toBe("qwen-oauth");
		});

		it("sets Stainless SDK header X-Stainless-Lang: js", () => {
			const headers = provider.prepareHeaders(new Headers(), "tok");
			expect(headers.get("X-Stainless-Lang")).toBe("js");
		});

		it("does NOT forward incoming headers (clean header set)", () => {
			const incoming = new Headers({
				"x-ratelimit-remaining": "42",
				"anthropic-version": "2023-06-01",
				"x-custom-client-header": "secret",
				authorization: "Bearer old-client-token",
			});
			const headers = provider.prepareHeaders(incoming, "new-token");

			// Forwarded headers must NOT appear
			expect(headers.get("x-ratelimit-remaining")).toBeNull();
			expect(headers.get("anthropic-version")).toBeNull();
			expect(headers.get("x-custom-client-header")).toBeNull();
			// The new token replaces the old one
			expect(headers.get("Authorization")).toBe("Bearer new-token");
		});

		it("does NOT forward x-ratelimit-* headers from incoming set", () => {
			const incoming = new Headers({
				"x-ratelimit-limit": "1000",
				"x-ratelimit-reset": "1700000000",
			});
			const headers = provider.prepareHeaders(incoming, "tok");
			expect(headers.get("x-ratelimit-limit")).toBeNull();
			expect(headers.get("x-ratelimit-reset")).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// 5. beforeConvert
	// -------------------------------------------------------------------------
	describe("beforeConvert", () => {
		it("returns undefined when account is undefined", () => {
			const result = provider.beforeConvert({}, undefined);
			expect(result).toBeUndefined();
		});

		it("injects default Qwen model mappings when model_mappings is null", () => {
			const account = makeAccount({ model_mappings: null });
			const result = provider.beforeConvert({}, account);
			expect(result).toBeDefined();
			const mappings = JSON.parse(result?.model_mappings as string);
			expect(mappings.opus).toBe("coder-model");
			expect(mappings.sonnet).toBe("coder-model");
			expect(mappings.haiku).toBe("coder-model");
		});

		it("preserves existing model_mappings when already set", () => {
			const custom = JSON.stringify({
				opus: "my-opus",
				sonnet: "my-sonnet",
				haiku: "my-haiku",
			});
			const account = makeAccount({ model_mappings: custom });
			const result = provider.beforeConvert({}, account);
			expect(result?.model_mappings).toBe(custom);
		});

		it("does not mutate the original account", () => {
			const account = makeAccount({ model_mappings: null });
			const original = { ...account };
			provider.beforeConvert({}, account);
			expect(account.model_mappings).toBeNull();
			expect(account.id).toBe(original.id);
		});
	});

	// -------------------------------------------------------------------------
	// 6. afterConvert — system prompt sanitization
	// -------------------------------------------------------------------------
	describe("afterConvert", () => {
		// -----------------------------------------------------------------------
		// a) Strip x-anthropic-* billing header blocks
		// -----------------------------------------------------------------------
		describe("strips x-anthropic-* billing header blocks", () => {
			it("removes text blocks starting with x-anthropic-", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "x-anthropic-billing-header: some-value" },
					{ type: "text", text: "Normal system instruction." },
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content).toHaveLength(1);
				expect(content[0].text).toBe("Normal system instruction.");
			});

			it("removes multiple x-anthropic-* blocks", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "x-anthropic-foo: a" },
					{ type: "text", text: "Keep this." },
					{ type: "text", text: "x-anthropic-bar: b" },
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content).toHaveLength(1);
				expect(content[0].text).toBe("Keep this.");
			});
		});

		// -----------------------------------------------------------------------
		// b) Replace Claude identity strings with Qwen equivalents
		// -----------------------------------------------------------------------
		describe("replaces Claude identity strings", () => {
			it("replaces the primary Claude Code identity line", () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toBe(
					"You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
				);
			});

			it("replaces the Claude Agent SDK identity variant", () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
					},
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toBe(
					"You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
				);
			});
		});

		// -----------------------------------------------------------------------
		// c) Drop lines matching drop patterns
		// -----------------------------------------------------------------------
		describe("drops lines matching drop patterns", () => {
			const dropPatterns = [
				"You are powered by the model named claude-opus-4",
				"The most recent Claude model family is Claude 4.",
				"Claude Code is available as a CLI tool for developers.",
				"Fast mode for Claude Code is enabled.",
				"Visit https://claude.ai/code for more info.",
			];

			for (const line of dropPatterns) {
				it(`drops line: "${line.slice(0, 60)}..."`, () => {
					const body = makeOpenAIRequest([
						{ type: "text", text: `Keep this.\n${line}\nAlso keep this.` },
					]);
					provider.afterConvert(body);
					const content = body.messages[0].content as Array<{
						type: string;
						text: string;
					}>;
					expect(content[0].text).not.toContain(line);
					expect(content[0].text).toContain("Keep this.");
					expect(content[0].text).toContain("Also keep this.");
				});
			}
		});

		// -----------------------------------------------------------------------
		// d) Replace CLAUDE.md -> QWEN.md in non-identity blocks
		// -----------------------------------------------------------------------
		describe("replaces CLAUDE.md references with QWEN.md", () => {
			it("replaces CLAUDE.md in regular system blocks", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "Read the CLAUDE.md file for instructions." },
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toContain("QWEN.md");
				expect(content[0].text).not.toContain("CLAUDE.md");
			});

			it("replaces multiple CLAUDE.md occurrences", () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "See CLAUDE.md for config. Also CLAUDE.md has examples.",
					},
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toBe(
					"See QWEN.md for config. Also QWEN.md has examples.",
				);
			});
		});

		// -----------------------------------------------------------------------
		// e) Replace feedback link
		// -----------------------------------------------------------------------
		describe("replaces the feedback/bug report link", () => {
			it("replaces the github issues URL line with /bug command text", () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
					},
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toBe(
					"To report a bug or provide feedback, please use the /bug command",
				);
			});
		});

		// -----------------------------------------------------------------------
		// f) Replace "Get help with using Claude Code"
		// -----------------------------------------------------------------------
		describe("replaces Claude Code help text", () => {
			it('replaces "Get help with using Claude Code" with Qwen Code variant', () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "Get help with using Claude Code by running /help.",
					},
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				expect(content[0].text).toContain("Get help with using Qwen Code");
				expect(content[0].text).not.toContain(
					"Get help with using Claude Code",
				);
			});
		});

		// -----------------------------------------------------------------------
		// g) Drop blocks that are empty after sanitization
		// -----------------------------------------------------------------------
		describe("drops empty blocks after sanitization", () => {
			it("removes blocks that become empty strings after sanitization", () => {
				const body = makeOpenAIRequest([
					// This block will be fully consumed by drop patterns
					{
						type: "text",
						text: "You are powered by the model named claude-opus-4",
					},
					{ type: "text", text: "Surviving instruction." },
				]);
				provider.afterConvert(body);
				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;
				// The first block becomes whitespace-only -> dropped
				expect(content).toHaveLength(1);
				expect(content[0].text).toBe("Surviving instruction.");
			});

			it('sets msg.content to "" when all blocks become empty', () => {
				const body = makeOpenAIRequest([
					{
						type: "text",
						text: "x-anthropic-billing: foo",
					},
				]);
				provider.afterConvert(body);
				const msg = body.messages[0];
				expect(msg.content).toBe("");
			});
		});

		// -----------------------------------------------------------------------
		// h) Sets vl_high_resolution_images = true
		// -----------------------------------------------------------------------
		describe("sets vl_high_resolution_images", () => {
			it("adds vl_high_resolution_images: true on the body", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "Instruction." },
				]);
				provider.afterConvert(body);
				expect(
					(body as OpenAIRequest & { vl_high_resolution_images?: boolean })
						.vl_high_resolution_images,
				).toBe(true);
			});

			it("sets vl_high_resolution_images even when no system message exists", () => {
				const body: OpenAIRequest = {
					model: "coder-model",
					messages: [{ role: "user", content: "Hello" }],
				};
				provider.afterConvert(body);
				expect(
					(body as OpenAIRequest & { vl_high_resolution_images?: boolean })
						.vl_high_resolution_images,
				).toBe(true);
			});
		});

		// -----------------------------------------------------------------------
		// i) Marks string system content for DashScope caching
		// -----------------------------------------------------------------------
		describe("marks string system content", () => {
			it("normalizes the first string system message and marks its final block", () => {
				const body: OpenAIRequest = {
					model: "coder-model",
					messages: [
						{ role: "system", content: "You are a helpful assistant." },
						{ role: "user", content: "Hi" },
					],
				};
				provider.afterConvert(body);
				expect(body.messages[0].content).toEqual([
					{
						type: "text",
						text: "You are a helpful assistant.",
						cache_control: { type: "ephemeral" },
					},
				]);
			});
		});

		// -----------------------------------------------------------------------
		// j) Leaves non-system messages unchanged
		// -----------------------------------------------------------------------
		describe("leaves non-system messages unchanged", () => {
			it("does not touch user message content", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "System instruction." },
				]);
				const originalUserContent = body.messages[1].content;
				provider.afterConvert(body);
				expect(body.messages[1].content).toBe(originalUserContent);
			});

			it("does not touch assistant message content", () => {
				const body: OpenAIRequest = {
					model: "coder-model",
					messages: [
						{ role: "user", content: "Hi" },
						{
							role: "assistant",
							content:
								"You are Claude Code, Anthropic's official CLI for Claude.",
						},
					],
				};
				provider.afterConvert(body);
				// Assistant message must remain untouched
				expect(body.messages[1].content).toBe(
					"You are Claude Code, Anthropic's official CLI for Claude.",
				);
			});
		});

		// -----------------------------------------------------------------------
		// Combined scenario
		// -----------------------------------------------------------------------
		describe("combined sanitization scenario", () => {
			it("applies all transformations in a single pass", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "x-anthropic-billing: xyz" }, // strip
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					}, // identity replace
					{
						type: "text",
						text: [
							"You are powered by the model named claude-opus-4", // drop line
							"Read CLAUDE.md for guidance.", // CLAUDE.md -> QWEN.md
							"To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", // feedback
							"Get help with using Claude Code by running /help.", // help text
						].join("\n"),
					},
				]);

				provider.afterConvert(body);

				const content = body.messages[0].content as Array<{
					type: string;
					text: string;
				}>;

				// First block (billing) should be gone -> only 2 remaining
				expect(content).toHaveLength(2);

				// Identity block replaced
				expect(content[0].text).toBe(
					"You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
				);

				// Third block: line dropped, CLAUDE.md replaced, feedback replaced, help replaced
				expect(content[1].text).not.toContain(
					"You are powered by the model named",
				);
				expect(content[1].text).toContain("QWEN.md");
				expect(content[1].text).not.toContain("CLAUDE.md");
				expect(content[1].text).toContain(
					"To report a bug or provide feedback, please use the /bug command",
				);
				expect(content[1].text).toContain("Get help with using Qwen Code");
			});
		});

		// -----------------------------------------------------------------------
		// Cache marker placement (mirrors Qwen Code's DashScope provider)
		// -----------------------------------------------------------------------
		describe("places DashScope cache markers", () => {
			it("marks only the first system message for a non-streaming request", () => {
				const tools: CacheableTool[] = [
					{
						type: "function",
						function: { name: "first" },
					},
					{
						type: "function",
						function: { name: "last" },
					},
				];
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: false,
					messages: [
						{ role: "system", content: "First system" },
						{ role: "system", content: "Second system" },
						{ role: "user", content: "Latest message" },
					],
					tools,
				};

				provider.afterConvert(body);

				expect(body.messages[0].content).toEqual([
					{
						type: "text",
						text: "First system",
						cache_control: { type: "ephemeral" },
					},
				]);
				expect(body.messages[1].content).toBe("Second system");
				expect(body.messages[2].content).toBe("Latest message");
				expect(tools[0].cache_control).toBeUndefined();
				expect(tools[1].cache_control).toBeUndefined();
			});

			it("also marks the latest message's final content block when streaming", () => {
				const priorContent = [{ type: "text", text: "Prior response" }];
				const firstLatestBlock = { type: "text", text: "Latest prompt" };
				const finalLatestBlock = { type: "image_url" };
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: true,
					messages: [
						{
							role: "system",
							content: [
								{ type: "text", text: "Stable prefix" },
								{ type: "text", text: "System boundary" },
							],
						},
						{ role: "assistant", content: priorContent },
						{
							role: "user",
							content: [firstLatestBlock, finalLatestBlock],
						},
					],
				};

				provider.afterConvert(body);

				const systemContent = body.messages[0].content;
				expect(Array.isArray(systemContent)).toBe(true);
				if (!Array.isArray(systemContent)) throw new Error("expected blocks");
				expect(systemContent[0].cache_control).toBeUndefined();
				expect(systemContent[1].cache_control).toEqual({ type: "ephemeral" });
				expect(body.messages[1].content).toBe(priorContent);

				const latestContent = body.messages[2].content;
				expect(Array.isArray(latestContent)).toBe(true);
				if (!Array.isArray(latestContent)) throw new Error("expected blocks");
				expect(latestContent[0]).toBe(firstLatestBlock);
				expect(latestContent[1]).toEqual({
					type: "image_url",
					cache_control: { type: "ephemeral" },
				});
				expect(finalLatestBlock).toEqual({ type: "image_url" });
			});

			it("marks only the final tool definition when streaming", () => {
				const firstTool: CacheableTool = {
					type: "function",
					function: { name: "first" },
				};
				const finalTool: CacheableTool = {
					type: "function",
					function: { name: "final" },
				};
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: true,
					messages: [{ role: "user", content: "Run a tool" }],
					tools: [firstTool, finalTool],
				};

				provider.afterConvert(body);

				const tools = body.tools as CacheableTool[];
				expect(tools[0]).toBe(firstTool);
				expect(tools[0].cache_control).toBeUndefined();
				expect(tools[1]).not.toBe(finalTool);
				expect(tools[1]).toEqual({
					type: "function",
					function: { name: "final" },
					cache_control: { type: "ephemeral" },
				});
				expect(finalTool.cache_control).toBeUndefined();
			});

			it("places the system marker after sanitization on the final surviving block", () => {
				const body = makeOpenAIRequest([
					{ type: "text", text: "x-anthropic-billing: remove me" },
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
					{ type: "text", text: "Read CLAUDE.md before acting." },
				]);

				provider.afterConvert(body);

				const content = body.messages[0].content;
				expect(Array.isArray(content)).toBe(true);
				if (!Array.isArray(content)) throw new Error("expected blocks");
				expect(content).toHaveLength(2);
				expect(content[0]).toEqual({
					type: "text",
					text: "You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.",
				});
				expect(content[1]).toEqual({
					type: "text",
					text: "Read QWEN.md before acting.",
					cache_control: { type: "ephemeral" },
				});
			});

			it("preserves valid markers and is idempotent", () => {
				const systemCacheControl = { type: "ephemeral" };
				const existingToolCacheControl = { type: "ephemeral" };
				const tools: CacheableTool[] = [
					{
						type: "function",
						function: { name: "already-cached" },
						cache_control: existingToolCacheControl,
					},
					{
						type: "function",
						function: { name: "new-boundary" },
					},
				];
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: true,
					messages: [
						{
							role: "system",
							content: [
								{
									type: "text",
									text: "Stable system",
									cache_control: systemCacheControl,
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "Latest prompt",
								},
							],
						},
					],
					tools,
				};

				provider.afterConvert(body);
				const latestContentAfterFirstPass = body.messages[1].content;
				const toolsAfterFirstPass = body.tools as CacheableTool[];
				expect(Array.isArray(latestContentAfterFirstPass)).toBe(true);
				if (!Array.isArray(latestContentAfterFirstPass)) {
					throw new Error("expected blocks");
				}
				expect(latestContentAfterFirstPass[0].cache_control).toEqual({
					type: "ephemeral",
				});
				expect(toolsAfterFirstPass[1].cache_control).toEqual({
					type: "ephemeral",
				});
				const latestBoundaryAfterFirstPass = latestContentAfterFirstPass[0];
				const finalToolAfterFirstPass = toolsAfterFirstPass[1];
				const afterFirstPass = structuredClone(body);
				provider.afterConvert(body);

				expect(body).toEqual(afterFirstPass);
				const systemContent = body.messages[0].content;
				const latestContent = body.messages[1].content;
				expect(Array.isArray(systemContent)).toBe(true);
				expect(Array.isArray(latestContent)).toBe(true);
				if (!Array.isArray(systemContent) || !Array.isArray(latestContent)) {
					throw new Error("expected blocks");
				}
				expect(systemContent[0].cache_control).toBe(systemCacheControl);
				expect(latestContent[0]).toBe(latestBoundaryAfterFirstPass);
				const finalTools = body.tools as CacheableTool[];
				expect(finalTools[0].cache_control).toBe(existingToolCacheControl);
				expect(finalTools[1]).toBe(finalToolAfterFirstPass);
			});

			it("skips empty and missing message content without inventing blocks", () => {
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: true,
					messages: [
						{ role: "system", content: "" },
						{ role: "assistant", content: null },
						{ role: "user", content: [] },
					],
					tools: [],
				};

				provider.afterConvert(body);

				expect(body.messages[0].content).toBe("");
				expect(body.messages[1].content).toBeNull();
				expect(body.messages[2].content).toEqual([]);
				expect(body.tools).toEqual([]);
			});

			it("does not double-mark a system-only streaming request", () => {
				const body: OpenAIRequest = {
					model: "coder-model",
					stream: true,
					messages: [{ role: "system", content: "Only system" }],
				};

				provider.afterConvert(body);

				expect(body.messages[0].content).toEqual([
					{
						type: "text",
						text: "Only system",
						cache_control: { type: "ephemeral" },
					},
				]);
			});
		});
	});
});
