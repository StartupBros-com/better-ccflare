import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { AnthropicDegradedResponseLifecycle } from "../../anthropic-degraded-response-lifecycle";
import { ANTHROPIC_DRAIN_DEADLINE_MS } from "../../anthropic-terminal-recovery";
import type { AnthropicDegradedRequestSendState } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

const { proxyWithAccount } = await import("../proxy-operations");

/**
 * The client's abort signal must reach the upstream fetch through the whole
 * proxy path — including provider body transforms that rebuild the Request from
 * its URL and thereby drop the signal. That rebuild is why the signal is passed
 * explicitly at the call site instead of riding along on the Request object.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-abort",
		name: "abort-test",
		provider: "openai-compatible",
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
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		requires_reauth: false,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-abort",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer as ArrayBuffer;
}

/**
 * @param transformRequestBody - lets a test inject a signal-dropping transform,
 *   mirroring what the real providers do (`new Request(request.url, …)`).
 */
function makeProxyContext(
	transformRequestBody:
		| ((req: Request, account: Account) => Promise<Request>)
		| null = null,
): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: () => "https://openrouter.ai/api/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "test-secret",
	};
}

/** A transform that rebuilds from the URL — the real signal-dropping shape. */
async function signalDroppingTransform(request: Request): Promise<Request> {
	const body = await request.clone().text();
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body,
	});
}

interface CapturedFetch {
	signal: AbortSignal | undefined;
	calls: number;
}

/**
 * Replaces global fetch, records the signal the upstream call was armed with,
 * and answers 429 so proxyWithAccount short-circuits into failover instead of
 * reaching forwardToClient (which needs an initialised UsageCollector).
 */
function captureUpstreamFetch(): CapturedFetch {
	const captured: CapturedFetch = { signal: undefined, calls: 0 };
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		captured.calls++;
		captured.signal ??=
			input instanceof Request ? input.signal : (init?.signal ?? undefined);
		return new Response(
			JSON.stringify({ error: { type: "api_error", message: "rate limited" } }),
			{ status: 429, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof globalThis.fetch;
	return captured;
}

async function runProxy(
	req: Request,
	ctx: ProxyContext,
	account = makeAccount(),
): Promise<void> {
	const bodyBuffer = makeRequestBody();
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch {
		// Downstream forwarding is out of scope here; the assertion is about the
		// signal that armed the upstream fetch.
	}
}

describe("proxyWithAccount: client abort signal reaches the upstream fetch", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("arms the upstream fetch with a signal that follows the client request", async () => {
		const captured = captureUpstreamFetch();
		const controller = new AbortController();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: makeRequestBody(),
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
		});

		await runProxy(req, makeProxyContext());

		expect(captured.calls).toBeGreaterThan(0);
		expect(captured.signal).toBeDefined();
		expect(captured.signal?.aborted).toBe(false);

		// The decisive assertion: aborting the CLIENT must abort what the upstream
		// fetch was armed with. Without the wiring these are unrelated objects.
		controller.abort();
		expect(captured.signal?.aborted).toBe(true);
	});

	it("keeps the wiring even when the provider transform rebuilds the Request and drops the signal", async () => {
		const captured = captureUpstreamFetch();
		const controller = new AbortController();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: makeRequestBody(),
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
		});

		await runProxy(req, makeProxyContext(signalDroppingTransform));

		expect(captured.signal).toBeDefined();
		expect(captured.signal?.aborted).toBe(false);

		controller.abort();
		expect(captured.signal?.aborted).toBe(true);
	});

	it("aborts the exact upstream fetch signal when terminal draining reaches its deadline", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [callback, delay, ...rest] = args;
			return originalSetTimeout(
				callback,
				delay === ANTHROPIC_DRAIN_DEADLINE_MS ? 10 : delay,
				...rest,
			);
		}) as typeof setTimeout);
		let upstreamSignal: AbortSignal | undefined;
		const streamBytes = new TextEncoder().encode(
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
		);
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				upstreamSignal =
					input instanceof Request ? input.signal : (init?.signal ?? undefined);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(streamBytes);
							// Deliberately stay open: only the terminal-drain deadline can
							// release this simulated upstream fetch body.
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		) as unknown as typeof globalThis.fetch;

		try {
			const bodyBuffer = makeRequestBody();
			const req = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: bodyBuffer,
				headers: {
					"Content-Type": "application/json",
					"x-better-ccflare-auto-refresh": "true",
					"x-better-ccflare-internal-probe-secret": "test-secret",
				},
			});
			const ctx = makeProxyContext();
			ctx.provider.isStreamingResponse = () => true;
			const response = await proxyWithAccount(
				req,
				new URL(req.url),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);

			expect(response).not.toBeNull();
			expect(upstreamSignal).toBeDefined();
			expect(upstreamSignal?.aborted).toBe(false);
			const reader = response?.body?.getReader();
			expect(reader).toBeDefined();
			await expect(reader?.read()).resolves.toMatchObject({ done: false });
			await reader?.cancel("client disconnect");

			// This is the signal observed by the final global.fetch(Request), after
			// every provider transform and request-handler signal composition. The
			// deadline controller passed to response-handler must therefore be one of
			// this exact signal's live abort sources, not an unrelated controller.
			expect(upstreamSignal?.aborted).toBe(true);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("does not abort the upstream fetch while the client stays connected", async () => {
		const captured = captureUpstreamFetch();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: makeRequestBody(),
			headers: { "Content-Type": "application/json" },
		});

		await runProxy(req, makeProxyContext());

		expect(captured.calls).toBeGreaterThan(0);
		expect(captured.signal?.aborted).toBe(false);
	});

	it("still forwards requests whose client signal is absent", async () => {
		// A Request built without an explicit signal exposes a non-aborted signal;
		// the upstream call must proceed normally rather than being skipped.
		const captured = captureUpstreamFetch();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: makeRequestBody(),
			headers: { "Content-Type": "application/json" },
		});

		await runProxy(req, makeProxyContext(signalDroppingTransform));

		expect(captured.calls).toBeGreaterThan(0);
	});
});

describe("proxyWithAccount: a client disconnect must not look like an account failure", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function abortError(): Error {
		// Shape of what fetch rejects with once its signal fires.
		const err = new Error("The operation was aborted.");
		err.name = "AbortError";
		return err;
	}

	async function run(req: Request): Promise<Response | null> {
		const bodyBuffer = makeRequestBody();
		return await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);
	}

	it("returns 499 instead of null when the client disconnected", async () => {
		const controller = new AbortController();
		globalThis.fetch = mock(async () => {
			// The client goes away while the upstream call is in flight.
			controller.abort();
			throw abortError();
		}) as unknown as typeof globalThis.fetch;

		const result = await run(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: makeRequestBody(),
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
			}),
		);

		// null would send the caller through every remaining account and
		// fallback route for a request nobody is listening to.
		expect(result).not.toBeNull();
		expect(result?.status).toBe(499);
	});

	it("settles a committed degraded lifecycle as cancelled before returning 499", async () => {
		const controller = new AbortController();
		const settlements: string[] = [];
		let committed = false;
		const permit = {
			kind: "recovery_send" as const,
			leaseExpiresAt: null,
			commit() {
				committed = true;
				return true;
			},
			cancel: () => false,
			complete(outcome: string) {
				if (!committed) return false;
				settlements.push(outcome);
				return true;
			},
			expire: () => false,
		};
		expect(permit.commit()).toBe(true);
		const degradedState: AnthropicDegradedRequestSendState = {
			admission: {} as never,
			lifecycle: new AnthropicDegradedResponseLifecycle({
				permit,
				accountId: "acc-abort",
				cohortKey: "cohort-abort" as never,
				enforced: true,
			}),
			tracker: null,
		};
		globalThis.fetch = mock(async () => {
			controller.abort();
			throw abortError();
		}) as unknown as typeof globalThis.fetch;
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
		});

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			undefined,
			degradedState,
		);

		expect(result?.status).toBe(499);
		expect(settlements).toEqual(["cancelled"]);
		expect(degradedState.lifecycle?.isSettled).toBe(true);
	});

	it("still fails over when an abort did NOT come from the client", async () => {
		// The header-phase timeout aborts only the internal controller, so
		// req.signal stays untouched. Such a failure must keep failing over —
		// this is the discriminator the fix relies on.
		globalThis.fetch = mock(async () => {
			throw abortError();
		}) as unknown as typeof globalThis.fetch;

		const result = await run(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: makeRequestBody(),
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(result).toBeNull();
	});

	it("still fails over on ordinary upstream errors", async () => {
		globalThis.fetch = mock(async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		const result = await run(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: makeRequestBody(),
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(result).toBeNull();
	});
});
