import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeProxyRequest } from "../request-handler";

/**
 * Bun's fetch arms its own 300 s idle timer unless `timeout: false` is passed.
 * On a reused keep-alive socket that timer runs from when the socket returned
 * to the pool, so a slow upstream was cut at 260-300 s with "TimeoutError: The
 * operation timed out." long before ccflare's 30-minute header deadline or the
 * precommit rescue's commitment window (#489). Both fetch calls must opt out so
 * ccflare's own deadlines govern, and the option must ride in fetch()'s init
 * argument, where Bun reads it.
 */
type BunFetchInit = RequestInit & { timeout?: boolean };

interface CapturedFetch {
	input: RequestInfo | URL;
	init: BunFetchInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: CapturedFetch[];

describe("makeProxyRequest disables Bun's built-in fetch timeout", () => {
	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: BunFetchInit,
		) => {
			calls.push({ input, init });
			return new Response("ok");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("passes timeout:false on the URL-target branch with a streamed body", async () => {
		const body = new TextEncoder().encode('{"model":"m"}');
		const response = await makeProxyRequest(
			"https://provider.test/v1/chat/completions",
			"POST",
			new Headers({ "content-type": "application/json" }),
			() => new Response(body).body ?? undefined,
			true,
		);

		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		const init = calls[0]?.init;
		expect(init?.timeout).toBe(false);
		expect(init?.method).toBe("POST");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
	});

	it("passes timeout:false on the URL-target branch without a body", async () => {
		await makeProxyRequest("https://provider.test/v1/models", "GET");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.timeout).toBe(false);
		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("passes timeout:false as fetch's second argument on the Request-target branch", async () => {
		const target = new Request("https://provider.test/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"model":"m"}',
		});

		await makeProxyRequest(target);

		expect(calls).toHaveLength(1);
		const { input, init } = calls[0] ?? {};
		expect(input).toBeInstanceOf(Request);
		// The derived Request still carries ccflare's combined abort signal.
		expect((input as Request).signal.aborted).toBe(false);
		expect((input as Request).method).toBe("POST");
		// Only the Bun option rides in init, so it cannot override the
		// Request's own headers, body, or signal.
		expect(init).toEqual({ timeout: false });
	});
});
