import { afterEach, expect, test } from "bun:test";
import { applyPrivateAiTraceContext } from "../private-ai-trace-context";

const original = process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
const id = "12345678-1234-4234-8234-123456789abc";
const requestId = "abcdef01-2345-4678-9abc-def012345678";
const account = { id, provider: "openai-compatible" };
const url = "https://private.example/v1/chat/completions";
const parent = "00-11111111111111111111111111111111-2222222222222222-00";
function enable() {
	process.env.PRIVATE_AI_TRACE_ROUTES_JSON = JSON.stringify({
		[id]: "https://private.example",
	});
}
afterEach(() => {
	if (original === undefined) delete process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
	else process.env.PRIVATE_AI_TRACE_ROUTES_JSON = original;
});

test("each send has a fresh child span and stable canonical logical identity", () => {
	enable();
	const source = new Headers({ traceparent: parent });
	const spans = new Set<string>();
	for (let i = 0; i < 20; i++) {
		const headers = new Headers({
			"x-private-ai-request-id": "forged",
			"x-private-ai-attempt-id": "forged",
			"x-private-ai-parent-span-id": "forged",
			"x-private-ai-extra": "forged",
		});
		applyPrivateAiTraceContext(headers, account, url, requestId, source);
		const span = headers.get("x-private-ai-attempt-id") ?? "";
		expect(span).toMatch(/^[0-9a-f]{16}$/);
		expect(span).not.toBe("0000000000000000");
		expect(headers.get("traceparent")).toBe(
			`00-11111111111111111111111111111111-${span}-00`,
		);
		expect(headers.get("x-private-ai-parent-span-id")).toBe("2222222222222222");
		expect(headers.get("x-private-ai-request-id")).toBe(requestId);
		expect(headers.has("x-private-ai-extra")).toBe(false);
		spans.add(span);
	}
	expect(spans.size).toBe(20);
	expect(source.get("traceparent")).toBe(parent);
});

test("missing and malformed parents fall back to the canonical UUID trace", () => {
	enable();
	for (const value of [
		"",
		"garbage",
		parent.toUpperCase().replace("1111", "ABCD"),
		`${parent},${parent}`,
		parent.replace("00-", "ff-"),
		parent.replace(
			"11111111111111111111111111111111",
			"00000000000000000000000000000000",
		),
		parent.replace("2222222222222222", "0000000000000000"),
		`${parent}-extra`,
	]) {
		const headers = new Headers({
			"x-private-ai-parent-span-id": "forged",
			traceparent: parent,
		});
		applyPrivateAiTraceContext(
			headers,
			account,
			url,
			requestId,
			new Headers({ traceparent: value }),
		);
		expect(headers.get("traceparent")).toBe(
			`00-abcdef01234546789abcdef012345678-${headers.get("x-private-ai-attempt-id")}-01`,
		);
		expect(headers.has("x-private-ai-parent-span-id")).toBe(false);
	}
});

test("default-off, invalid config, different origin/account/provider and null account are untouched", () => {
	const originalHeaders = {
		traceparent: parent,
		"x-private-ai-request-id": "existing",
		authorization: "test",
	};
	const cases = [
		{ config: undefined, account, url },
		{ config: "{", account, url },
		{
			config: JSON.stringify({ [id]: "https://private.example" }),
			account,
			url: "https://other.example/v1",
		},
		{
			config: JSON.stringify({ [id]: "https://private.example" }),
			account: { ...account, id: "other" },
			url,
		},
		...["openai", "kilo", "anthropic", "qwen"].map((provider) => ({
			config: JSON.stringify({ [id]: "https://private.example" }),
			account: { ...account, provider },
			url,
		})),
		{
			config: JSON.stringify({ [id]: "https://private.example" }),
			account: null,
			url,
		},
	];
	for (const entry of cases) {
		if (entry.config === undefined)
			delete process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
		else process.env.PRIVATE_AI_TRACE_ROUTES_JSON = entry.config;
		const headers = new Headers(originalHeaders);
		applyPrivateAiTraceContext(
			headers,
			entry.account,
			entry.url,
			requestId,
			new Headers(),
		);
		expect([...headers]).toEqual([...new Headers(originalHeaders)]);
	}
});
