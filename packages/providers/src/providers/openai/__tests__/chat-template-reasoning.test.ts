import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getChatTemplateReasoningAccountIds } from "@better-ccflare/config";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../provider";

const ENV = "CCFLARE_CHAT_TEMPLATE_REASONING_ACCOUNTS";

function makeAccount(id: string): Account {
	return {
		id,
		name: `name-${id}`,
		provider: "openai-compatible",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		api_key: "test-api-key",
		custom_endpoint: JSON.stringify({ endpoint: "http://localhost:4000/v1" }),
		model_mappings: JSON.stringify({ sonnet: "chat", opus: "chat" }),
		rate_limited_until: null,
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limit_remaining: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
	};
}

async function transform(
	account: Account,
	effort?: string,
): Promise<Record<string, unknown>> {
	const anthropicBody: Record<string, unknown> = {
		model: "claude-sonnet-4-5",
		max_tokens: 100,
		messages: [{ role: "user", content: "hi" }],
		thinking: { type: "adaptive" },
		...(effort !== undefined ? { output_config: { effort } } : {}),
	};
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(anthropicBody),
	});
	const out = await new OpenAICompatibleProvider().transformRequestBody(
		request,
		account,
	);
	return (await out.json()) as Record<string, unknown>;
}

describe("chat-template reasoning opt-in", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[ENV];
		delete process.env[ENV];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[ENV];
		else process.env[ENV] = saved;
	});

	const cases: Array<[string, string]> = [
		["low", "low"],
		["medium", "high"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	];
	for (const [from, to] of cases) {
		it(`allowlisted account: ${from} -> chat_template_kwargs.reasoning_effort=${to}`, async () => {
			process.env[ENV] = "acct-a";
			const body = await transform(makeAccount("acct-a"), from);
			expect(body.chat_template_kwargs).toEqual({ reasoning_effort: to });
			expect(body.reasoning).toBeUndefined();
			expect(body.model).toBe("chat");
		});
	}

	it("allowlisted account without effort leaves the body identical to env unset", async () => {
		const baseline = await transform(makeAccount("acct-a"));
		process.env[ENV] = "acct-a";
		const body = await transform(makeAccount("acct-a"));
		expect(body).toEqual(baseline);
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
	});

	it("allowlisted account with an unmapped effort leaves the body unchanged", async () => {
		const baseline = await transform(makeAccount("acct-a"), "minimal");
		process.env[ENV] = "acct-a";
		const body = await transform(makeAccount("acct-a"), "minimal");
		expect(body).toEqual(baseline);
		expect(body.reasoning).toEqual({ effort: "minimal" });
		expect(body.chat_template_kwargs).toBeUndefined();
	});

	it("non-allowlisted account is unchanged (nested reasoning kept)", async () => {
		const baseline = await transform(makeAccount("acct-b"), "medium");
		process.env[ENV] = "acct-a";
		const body = await transform(makeAccount("acct-b"), "medium");
		expect(body).toEqual(baseline);
		expect(body.reasoning).toEqual({ effort: "medium" });
		expect(body.chat_template_kwargs).toBeUndefined();
	});

	it("env unset keeps nested reasoning", async () => {
		const body = await transform(makeAccount("acct-a"), "high");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.chat_template_kwargs).toBeUndefined();
	});

	it("matches on account id, not name", async () => {
		process.env[ENV] = "name-acct-a";
		const body = await transform(makeAccount("acct-a"), "high");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.chat_template_kwargs).toBeUndefined();
	});

	it("parser trims whitespace and drops empty entries", () => {
		process.env[ENV] = " , id-a ,, ";
		expect([...getChatTemplateReasoningAccountIds()]).toEqual(["id-a"]);
	});

	it("parser returns empty set when unset or empty", () => {
		expect(getChatTemplateReasoningAccountIds().size).toBe(0);
		process.env[ENV] = "";
		expect(getChatTemplateReasoningAccountIds().size).toBe(0);
	});

	it("reads the env live between calls", async () => {
		const account = makeAccount("acct-a");
		const before = await transform(account, "low");
		expect(before.reasoning).toEqual({ effort: "low" });
		process.env[ENV] = "acct-a";
		const during = await transform(account, "low");
		expect(during.chat_template_kwargs).toEqual({ reasoning_effort: "low" });
		delete process.env[ENV];
		const after = await transform(account, "low");
		expect(after.reasoning).toEqual({ effort: "low" });
	});
});
