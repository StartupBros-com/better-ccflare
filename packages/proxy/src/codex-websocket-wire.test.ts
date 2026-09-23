import { describe, expect, test } from "bun:test";
import { buildCodexWebSocketHandshakeHeaders } from "./codex-websocket-wire";

describe("buildCodexWebSocketHandshakeHeaders", () => {
	test("carries the affinity headers from the transformed request and drops per-turn and internal ones", () => {
		const request = new Request(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"session-id": "ccflare-convo-abc",
					"thread-id": "ccflare-convo-abc",
					"x-codex-routing-hint": "model=gpt-6-astra",
					"x-codex-turn-state": "turn-token",
					"x-better-ccflare-request-id": "req-1",
					cookie: "client=1",
				},
				body: "{}",
			},
		);
		const headers = buildCodexWebSocketHandshakeHeaders(request, () => {});
		expect(headers.get("session-id")).toBe("ccflare-convo-abc");
		expect(headers.get("thread-id")).toBe("ccflare-convo-abc");
		expect(headers.get("x-codex-routing-hint")).toBe("model=gpt-6-astra");
		expect(headers.has("x-codex-turn-state")).toBe(false);
		expect(headers.has("x-better-ccflare-request-id")).toBe(false);
		expect(headers.has("content-type")).toBe(false);
		expect(headers.has("cookie")).toBe(false);
		expect(headers.get("openai-beta")).toContain("responses");
	});
});
