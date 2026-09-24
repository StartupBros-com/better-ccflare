import { afterEach, describe, expect, test } from "bun:test";
import {
	applyCodexAffinityHeaders,
	CODEX_AFFINITY_HEADERS_ENV,
	CODEX_ROUTING_HINT_HEADER,
	CODEX_SESSION_ID_HEADER,
	CODEX_THREAD_ID_HEADER,
	codexAffinityHeadersEnabled,
} from "./affinity-headers";

const KEY = "ccflare-convo-0123456789abcdef0123456789abcdef0123456789abcdef";

function base(
	overrides: Partial<Parameters<typeof applyCodexAffinityHeaders>[1]> = {},
) {
	return {
		promptCacheKey: KEY,
		physicalModel: "gpt-6-astra",
		subscriptionEndpoint: true,
		preserveClientSessionIdentity: false,
		...overrides,
	};
}

afterEach(() => {
	delete process.env[CODEX_AFFINITY_HEADERS_ENV];
});

describe("applyCodexAffinityHeaders", () => {
	test("derives session-id and thread-id from the prompt cache key and hints the model", () => {
		const headers = new Headers();
		const decision = applyCodexAffinityHeaders(headers, base());
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(KEY);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(KEY);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe("model=gpt-6-astra");
		expect(decision).toEqual({ sessionIdentity: "derived", routingHint: true });
	});

	test("replaces client-supplied affinity headers on the legacy path", () => {
		const headers = new Headers({
			[CODEX_SESSION_ID_HEADER]: "client-session",
			[CODEX_THREAD_ID_HEADER]: "client-thread",
			[CODEX_ROUTING_HINT_HEADER]: "model=gpt-5.6-sol",
		});
		const decision = applyCodexAffinityHeaders(headers, base());
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(KEY);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(KEY);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe("model=gpt-6-astra");
		expect(decision.sessionIdentity).toBe("derived");
	});

	test("removes client affinity headers when no key is available", () => {
		const headers = new Headers({
			[CODEX_SESSION_ID_HEADER]: "client-session",
			[CODEX_THREAD_ID_HEADER]: "client-thread",
		});
		const decision = applyCodexAffinityHeaders(
			headers,
			base({ promptCacheKey: null }),
		);
		expect(headers.has(CODEX_SESSION_ID_HEADER)).toBe(false);
		expect(headers.has(CODEX_THREAD_ID_HEADER)).toBe(false);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe("model=gpt-6-astra");
		expect(decision).toEqual({ sessionIdentity: null, routingHint: true });
	});

	test("keeps a native client's own identity when asked, but always owns the routing hint", () => {
		const headers = new Headers({
			[CODEX_SESSION_ID_HEADER]: "01a0cde1-10f5-73b3-ab86-91727aaef071",
			[CODEX_THREAD_ID_HEADER]: "01a0cde1-a61d-7263-a120-d3ed3423b2b5",
			[CODEX_ROUTING_HINT_HEADER]: "model=gpt-6-astra",
		});
		const decision = applyCodexAffinityHeaders(
			headers,
			base({
				preserveClientSessionIdentity: true,
				physicalModel: "gpt-5.6-sol",
			}),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(
			"01a0cde1-10f5-73b3-ab86-91727aaef071",
		);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(
			"01a0cde1-a61d-7263-a120-d3ed3423b2b5",
		);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe("model=gpt-5.6-sol");
		expect(decision).toEqual({ sessionIdentity: "client", routingHint: true });
	});

	test("native client without its own identity falls back to the derived key", () => {
		const headers = new Headers();
		const decision = applyCodexAffinityHeaders(
			headers,
			base({ preserveClientSessionIdentity: true }),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(KEY);
		expect(decision.sessionIdentity).toBe("derived");
	});

	test("native client thread-id defaults to its session-id", () => {
		const headers = new Headers({ [CODEX_SESSION_ID_HEADER]: "cli-session" });
		applyCodexAffinityHeaders(
			headers,
			base({ preserveClientSessionIdentity: true }),
		);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe("cli-session");
	});

	test("rejects header-unsafe values instead of sending them", () => {
		const headers = new Headers({
			[CODEX_SESSION_ID_HEADER]: "has space",
		});
		const decision = applyCodexAffinityHeaders(
			headers,
			base({
				promptCacheKey: "badékey",
				physicalModel: "gpt 6",
				preserveClientSessionIdentity: true,
			}),
		);
		expect(headers.has(CODEX_SESSION_ID_HEADER)).toBe(false);
		expect(headers.has(CODEX_THREAD_ID_HEADER)).toBe(false);
		expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
		expect(decision).toEqual({ sessionIdentity: null, routingHint: false });
	});

	test("leaves headers untouched off the subscription endpoint", () => {
		const headers = new Headers({ [CODEX_SESSION_ID_HEADER]: "client" });
		const decision = applyCodexAffinityHeaders(
			headers,
			base({ subscriptionEndpoint: false }),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe("client");
		expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
		expect(decision).toEqual({ sessionIdentity: null, routingHint: false });
	});

	test("kill switch restores pass-through behavior", () => {
		process.env[CODEX_AFFINITY_HEADERS_ENV] = "0";
		expect(codexAffinityHeadersEnabled()).toBe(false);
		const headers = new Headers({ [CODEX_SESSION_ID_HEADER]: "client" });
		const decision = applyCodexAffinityHeaders(headers, base());
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe("client");
		expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
		expect(decision).toEqual({ sessionIdentity: null, routingHint: false });
	});

	test("any other env value keeps the contract on", () => {
		process.env[CODEX_AFFINITY_HEADERS_ENV] = "false";
		expect(codexAffinityHeadersEnabled()).toBe(true);
	});
});
