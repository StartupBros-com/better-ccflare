import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { RoutingAttemptLedger } from "../routing-attempt-ledger";

// Anthropic account fixture — the extra_usage_exhausted body is Anthropic-specific.
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-anthropic-1",
		name: "claude-pro",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
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

function makeProxyContextWithAsyncExec(): ProxyContext {
	const markAccountRateLimited = mock(
		(_accountId: string, _until: number, _reason: string) =>
			Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
	);
	const saveRoutingAttempt = mock((..._args: unknown[]) => Promise.resolve());
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited,
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			saveRoutingAttempt,
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://api.anthropic.com/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
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
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

const EXTRA_USAGE_MESSAGE =
	"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";

// 400 invalid_request_error with the extra-usage-exhausted message.
function extraUsageExhaustedResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		}),
		{
			status: 400,
			headers: {
				"content-type": "application/json",
			},
		},
	);
}

describe("proxyWithAccount — extra_usage_exhausted (issue #293)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("does NOT bench the account and passes the 400 through to the client unchanged", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Response is passed through to the client, not swallowed/nulled for failover.
		expect(result).not.toBeNull();
		expect(result?.status).toBe(400);
		const responseBody = await result?.json();
		expect(responseBody).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		});

		// Account was NOT benched.
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);

		// markAccountRateLimited was never called (no bench).
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);

		const saveMock = ctx.dbOps.saveRoutingAttempt as ReturnType<typeof mock>;
		expect(saveMock).toHaveBeenCalledTimes(1);
		const attempt = saveMock.mock.calls[0]?.[0];
		expect(attempt).toMatchObject({
			parentRequestId: "req-1",
			provider: "anthropic",
			accountId: account.id,
			attemptedModel: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			statusCode: 400,
			reason: "extra_usage_exhausted",
			scope: "request",
			availableAt: null,
			failoverAttempts: 0,
			physicalAttempt: null,
			accountBenched: false,
			routeSuppressed: false,
			circuitCounted: false,
		});
		expect(attempt?.id).toEqual(expect.any(String));
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
	});

	it("keeps terminal request persistence separate from an attempt write", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();

		const response = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(response?.status).toBe(400);
		expect(ctx.dbOps.saveRoutingAttempt).toHaveBeenCalledTimes(1);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
	});

	it("delivers the retained client error when the async attempt write rejects", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());
		const ctx = makeProxyContextWithAsyncExec();
		ctx.dbOps.saveRoutingAttempt = mock(async () => {
			throw new Error("attempt database unavailable");
		});
		const bodyBuffer = makeRequestBody();

		const response = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({ type: "error" });
		expect(ctx.dbOps.saveRoutingAttempt).toHaveBeenCalledTimes(1);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
	});

	it("classifies extra usage returned by an in-place 529 recovery through the shared boundary", async () => {
		const previousBase = process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		const previousMax = process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		const previousAttempts = process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";

		try {
			let calls = 0;
			globalThis.fetch = mock(async () => {
				calls++;
				if (calls === 1) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "overloaded_error", message: "overloaded" },
						}),
						{ status: 529, headers: { "content-type": "application/json" } },
					);
				}
				return extraUsageExhaustedResponse();
			});

			const ctx = makeProxyContextWithAsyncExec();
			ctx.provider.parseRateLimit = (response: Response) =>
				({
					isRateLimited: response.status === 529,
					resetTime: undefined,
					statusHeader: undefined,
					remaining: undefined,
				}) as never;
			const account = makeAccount();
			const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
			const req = makeRequest(bodyBuffer);
			const ledger = new RoutingAttemptLedger();

			const result = await proxyWithAccount(
				req,
				new URL(req.url),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
			);

			expect(result).toBeNull();
			expect(calls).toBe(2);
			expect(account.rate_limited_until).toBeNull();
			expect(account.consecutive_rate_limits).toBe(0);
			expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
			const retained = ledger.takeTerminalResponse();
			expect(retained).not.toBeNull();
			const terminal = await retained?.deliver(1);
			expect(terminal?.status).toBe(400);
			expect(await terminal?.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: EXTRA_USAGE_MESSAGE,
				},
			});
		} finally {
			if (previousBase === undefined)
				delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
			else process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = previousBase;
			if (previousMax === undefined)
				delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
			else process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = previousMax;
			if (previousAttempts === undefined)
				delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
			else process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = previousAttempts;
		}
	});
});
