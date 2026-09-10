import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Zai reports "service overloaded" (error.code 1305) INSIDE a successful SSE
 * stream — HTTP 200, content-type text/event-stream, error as the first SSE
 * event. Nothing in the status line or headers marks it a failure. This
 * exercises the proxy-operations.ts wiring (peekSseForZai1305 + in-place
 * retry through the existing physical-attempt reservation machinery +
 * synthetic-429 conversion on exhaustion), as opposed to zai-1305.test.ts
 * which exercises the detector/peek helper directly.
 *
 * account.provider = "zai" resolves to the REAL registered ZaiProvider
 * (importing proxy-operations.ts registers all built-in providers), so
 * these tests exercise the actual buildUrl/transformRequestBody/
 * processResponse pipeline against a mocked global fetch — no network
 * traffic leaves the process.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "zai-1305-test",
		provider: "zai",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeOpenAICompatAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		provider: "stub-non-zai",
		...overrides,
	});
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function sse1305() {
	return new Response(
		'data: {"error":{"code":1305,"message":"The service is overloaded"}}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function sseOk() {
	return new Response(
		'data: {"type":"message_start","message":{"id":"msg_1"}}\n\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\ndata: {"type":"message_stop"}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function makeProxyContext(stubProvider?: unknown): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			saveRoutingAttempt: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: (stubProvider ?? {
			name: "stub-non-zai",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: async (request: Request) => request,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => true,
		}) as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

async function run(
	account: Account,
	fetchImpl: () => Promise<Response>,
	ctx: ProxyContext,
	requestMeta: RequestMeta = makeRequestMeta(),
) {
	globalThis.fetch = mock(fetchImpl) as never;
	const bodyBuffer = makeRequestBody();
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: requestMeta.headers,
	});
	let result: Response | null | undefined;
	try {
		result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	}
	return result;
}

describe("proxyWithAccount — Zai in-stream 1305 overload detection", () => {
	let originalFetch: typeof globalThis.fetch;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"CCFLARE_OVERLOAD_RETRY_ENABLED",
		"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
		"CCFLARE_OVERLOAD_RETRY_BASE_MS",
		"CCFLARE_OVERLOAD_RETRY_MAX_MS",
	];

	beforeEach(() => {
		expect(getProvider("zai")).toBeDefined();
		originalFetch = globalThis.fetch;
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("retries in place on a 1305-overloaded SSE stream and forwards the resolved retry", async () => {
		// Reaching the success/forward path in this minimal harness hits
		// getUsageCollector() (never initialized here — that needs a real
		// DatabaseOperations, out of scope for this unit test), which throws
		// and is swallowed by run()'s catch. That happens only *after* the
		// physical-attempt loop below has already run to completion, so
		// fetchCount is still the correct, fully-formed signal that exactly
		// one retry occurred and the second (resolved) attempt is what would
		// have been forwarded.
		let fetchCount = 0;
		await run(
			makeAccount(),
			async () => {
				fetchCount++;
				return fetchCount === 1 ? sse1305() : sseOk();
			},
			makeProxyContext(),
		);
		expect(fetchCount).toBe(2);
	});

	it("converts to a synthetic 429 after exhausting 1305 retries and fails over (no next account)", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		let fetchCount = 0;
		const result = await run(
			makeAccount(),
			async () => {
				fetchCount++;
				return sse1305();
			},
			makeProxyContext(),
		);
		expect(fetchCount).toBe(3);
		expect(result).toBeNull();
	});

	it("does not touch a 1305-shaped body for a non-zai account", async () => {
		// Same UsageCollector caveat as above: fetchCount is the load-bearing
		// assertion — a second fetch would mean the gate fired despite
		// account.provider !== "zai".
		let fetchCount = 0;
		await run(
			makeOpenAICompatAccount(),
			async () => {
				fetchCount++;
				return sse1305();
			},
			makeProxyContext(),
		);
		expect(fetchCount).toBe(1);
	});

	it("does not peek or retry for a synthetic keepalive request", async () => {
		let fetchCount = 0;
		await run(
			makeAccount(),
			async () => {
				fetchCount++;
				return sse1305();
			},
			makeProxyContext(),
			makeRequestMeta({
				headers: new Headers({ "x-better-ccflare-keepalive": "true" }),
			}),
		);
		// The unrecognized 1305 stream passes straight through untouched: a
		// second fetch would mean the gate fired despite the synthetic-internal
		// bypass (isSyntheticInternal / isSyntheticInternalRequest headers).
		expect(fetchCount).toBe(1);
	});
});
