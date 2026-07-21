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
import type { ProxyContext } from "../proxy-types";

// Source worktrees intentionally exclude generated database worker bundles.
// This focused proxy harness supplies dbOps directly and never constructs these
// classes, so keep the unit test independent from generated build artifacts.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { usageCache } = await import("@better-ccflare/providers");
const { AnthropicProvider } = await import(
	"../../../../providers/src/providers/anthropic/provider"
);
const { proxyWithAccount } = await import("../proxy-operations");
const { getAnthropicRateLimitResetAt, getRequestRateLimitOutcomes } =
	await import("../rate-limit-scope");
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");

// Anthropic account fixture — the out_of_credits header is Anthropic-specific.
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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeProxyContextWithAsyncExec(): ProxyContext {
	const markAccountRateLimited = mock(
		(_accountId: string, _until: number, _reason: string) => Promise.resolve(1),
	);
	const saveRequest = mock((..._args: unknown[]) => Promise.resolve());
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited,
			saveRequest,
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
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

// 429 with the out_of_credits overage-disabled-reason header (no reset header).
function outOfCreditsResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "request rate limit exceeded",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
				"x-should-retry": "true",
			},
		},
	);
}

describe("proxyWithAccount — out_of_credits (issue #261)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.delete("acc-anthropic-1");
	});

	it("does NOT bench the account and fails over on out_of_credits 429", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

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

		// Failed over to the next account.
		expect(result).toBeNull();

		// Account was NOT benched, but the exact model/beta candidate is marked
		// reactively so the next request can skip this known failed route.
		expect(account.rate_limited_until).toBeNull();
		const marker = usageCache.getModelScopedExhaustion(
			account.id,
			"claude-sonnet-4-5",
			null,
		);
		expect(marker).not.toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				status: 429,
				scope: "model",
				family: "sonnet",
				attemptedModel: "claude-sonnet-4-5",
				reason: "out_of_credits",
				availableAt: marker?.expiresAt,
			}),
		]);
		expect(account.consecutive_rate_limits).toBe(0);

		// markAccountRateLimited was never called (no bench).
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);

		// saveRequest was called once with reason "out_of_credits" and
		// usage { model: <requested model> }.
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		// 7th positional arg is the `reason` parameter.
		expect(args[6]).toBe("out_of_credits");
		// 10th positional arg is the `usage` parameter.
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
	});

	it("keeps fallback-model out_of_credits scoped instead of benching the account", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return calls === 1
				? new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "not_found_error",
								message: "model not found",
							},
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					)
				: outOfCreditsResponse();
		});
		const ctx = makeProxyContextWithAsyncExec();
		const markScoped = spyOn(usageCache, "markModelScopedExhausted");
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["claude-sonnet-4-5", "claude-opus-4-8"],
			}),
		});
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

		expect(result).toBeNull();
		expect(calls).toBe(2);
		expect(account.rate_limited_until).toBeNull();
		expect(markScoped).toHaveBeenCalledWith(
			account.id,
			"claude-opus-4-8",
			null,
		);
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		expect(args[6]).toBe("out_of_credits");
		expect(args[9]).toEqual({ model: "claude-opus-4-8" });
		const marker = usageCache.getModelScopedExhaustion(
			account.id,
			"claude-opus-4-8",
			null,
		);
		expect(marker).not.toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				status: 429,
				scope: "model",
				family: "opus",
				attemptedModel: "claude-opus-4-8",
				reason: "out_of_credits",
				availableAt: marker?.expiresAt,
			}),
		]);
		markScoped.mockRestore();
	});

	it("returns null without recording an audit row on keepalive out_of_credits 429", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});

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

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();

		// keepalive path skips the audit row and does not create routing evidence.
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(0);
		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-sonnet-4-5",
				null,
			),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([]);
	});

	it("treats a literal false keepalive header as real traffic", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "false",
			},
		});

		await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-sonnet-4-5",
				null,
			),
		).not.toBeNull();
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
	});

	it("does not trust an out_of_credits header from a non-Anthropic provider", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			custom_endpoint: "https://example.test/v1",
			model_mappings: JSON.stringify({ sonnet: ["claude-sonnet-4-5"] }),
		});
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_until).not.toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-sonnet-4-5",
				null,
			),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([]);
	});

	it("persists null/null originalModel/appliedModel (not the equal pair) when requestMeta carries an unmodified pair (P2: isModelRewrite guard)", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			{
				...makeRequestMeta(),
				// Agent-detected but NOT rewritten: original === applied. Before the
				// fix, the three direct 429 saveRequest call sites persisted this
				// equal pair unconditionally, bypassing isModelRewrite and
				// corrupting observability.
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-sonnet-4-5",
			},
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		// 17th/18th positional args are originalModel/appliedModel.
		expect(args[16]).toBeNull();
		expect(args[17]).toBeNull();
	});
});

const INCIDENT_NOW = 1_800_000_000_000;

function cacheIncidentUsage(
	accountId: string,
	observedAt: number,
	overrides: {
		weeklyAll?: number;
		family?: string;
		accountWindowsActive?: boolean;
	} = {},
): void {
	const realDateNow = Date.now;
	Date.now = () => observedAt;
	try {
		usageCache.set(accountId, {
			limits: [
				{
					kind: "session",
					percent: 0,
					resets_at: new Date(INCIDENT_NOW + 60 * 60 * 1000).toISOString(),
					is_active: overrides.accountWindowsActive ?? true,
				},
				{
					kind: "weekly_all",
					percent: overrides.weeklyAll ?? 72,
					resets_at: new Date(
						INCIDENT_NOW + 6 * 24 * 60 * 60 * 1000,
					).toISOString(),
					is_active: overrides.accountWindowsActive ?? true,
				},
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(
						INCIDENT_NOW + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: {
						model: {
							id: null,
							display_name: overrides.family ?? "Fable",
						},
					},
					is_active: true,
				},
			],
		});
	} finally {
		Date.now = realDateNow;
	}
}

function generic429Response(headers: HeadersInit = {}): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "An error occurred" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

function successfulClaudeResponse(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg-success",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function proxyUntilSuccessfulTransport(
	req: Request,
	account: Account,
	ctx: ProxyContext,
	bodyBuffer: ArrayBuffer,
): Promise<Response | null> {
	try {
		return await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch (error) {
		// A successful transport reaches forwardToClient, whose global collector is
		// intentionally not initialized by this focused unit-test harness.
		if (
			!(error instanceof Error) ||
			!error.message.includes("UsageCollector not initialized")
		) {
			throw error;
		}
		return null;
	}
}

describe("proxyWithAccount — generic Anthropic 429 scope", () => {
	let originalFetch: typeof globalThis.fetch;
	let realDateNow: typeof Date.now;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		realDateNow = Date.now;
		Date.now = () => INCIDENT_NOW;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Date.now = realDateNow;
		usageCache.delete("acc-anthropic-1");
	});

	for (const fixture of [
		{ name: "numeric delay", headers: { "retry-after": "45" } },
		{
			name: "HTTP-date",
			headers: {
				"retry-after": new Date(INCIDENT_NOW + 45_000).toUTCString(),
			},
		},
		{ name: "invalid value", headers: { "retry-after": "not-a-reset" } },
		{
			name: "past value",
			headers: { "x-ratelimit-reset": String(INCIDENT_NOW / 1000 - 1) },
		},
		{
			name: "x-ratelimit reset",
			headers: { "x-ratelimit-reset": String(INCIDENT_NOW / 1000 + 45) },
		},
		{
			name: "unified reset",
			headers: {
				"anthropic-ratelimit-unified-reset": String(INCIDENT_NOW / 1000 + 45),
			},
		},
		{
			name: "earliest precedence",
			headers: {
				"retry-after": "90",
				"x-ratelimit-reset": String(INCIDENT_NOW / 1000 + 30),
				"anthropic-ratelimit-unified-reset": String(INCIDENT_NOW / 1000 + 60),
			},
		},
	] as const) {
		it(`keeps provider and proxy reset parsing aligned for ${fixture.name}`, () => {
			const rateLimitResponse = new Response(null, {
				status: 529,
				headers: fixture.headers,
			});
			const proxyReset = getAnthropicRateLimitResetAt(
				rateLimitResponse,
				INCIDENT_NOW,
			);
			expect(
				new AnthropicProvider().parseRateLimit(rateLimitResponse).resetTime,
			).toBe(proxyReset ?? undefined);
		});
	}

	it("isolates the Fable100 / weekly-all72 incident without benching Opus", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		globalThis.fetch = mock(async () => generic429Response());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-fable-5-20260701",
				INCIDENT_NOW,
			),
		).toMatchObject({ family: "fable", expiresAt: INCIDENT_NOW + 60_000 });
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-5",
			}),
		]);
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls[0]?.[6]).toBe("model_scoped_429");
		expect(saveMock.mock.calls[0]?.[9]).toEqual({ model: "claude-fable-5" });
	});

	it("isolates the exact inactive-account-window live fixture to Fable", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000, {
			weeklyAll: 84,
			accountWindowsActive: false,
		});
		globalThis.fetch = mock(async () =>
			generic429Response({ "retry-after": "120" }),
		);
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-fable-5",
				INCIDENT_NOW,
			),
		).toMatchObject({ family: "fable", expiresAt: INCIDENT_NOW + 60_000 });
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				scope: "family",
				family: "fable",
				reason: "matching_scoped_limit",
				availableAt: INCIDENT_NOW + 60_000,
			}),
		]);
	});

	it("keeps the live startup-empty generic 429 exact to Fable and leaves Opus eligible", async () => {
		usageCache.delete("acc-anthropic-1");
		globalThis.fetch = mock(async () =>
			generic429Response({ "retry-after": "120" }),
		);
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"anthropic-beta": "feature-b,feature-a",
			},
		});

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		const marker = usageCache.getModelScopedExhaustion(
			account.id,
			"claude-fable-5",
			"feature-a,feature-b",
			INCIDENT_NOW,
		);
		expect(marker).toMatchObject({ expiresAt: INCIDENT_NOW + 120_000 });
		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				"feature-a,feature-b",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				scope: "model",
				family: "fable",
				attemptedModel: "claude-fable-5",
				reason: "missing_usage",
				availableAt: INCIDENT_NOW + 120_000,
			}),
		]);
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls[0]?.[6]).toBe("model_scoped_429");
		expect(saveMock.mock.calls[0]?.[9]).toEqual({ model: "claude-fable-5" });
	});

	it("cancels the discarded body for a model-scoped no-fallback 429", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const state = { cancelled: false };
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				state.cancelled = true;
			},
		});
		globalThis.fetch = mock(
			async () =>
				new Response(body, {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody("claude-fable-5");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(state.cancelled).toBe(true);
	});

	it("keeps the same fixture exact-model scoped when its snapshot is 181 seconds old", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 181_000);
		globalThis.fetch = mock(async () => generic429Response());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-fable-5",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-fable-5",
				null,
				INCIDENT_NOW,
			),
		).not.toBeNull();
	});

	it("keeps weekly-all100 and a hard response signal account-scoped", async () => {
		for (const fixture of [
			{ weeklyAll: 100, headers: {} },
			{
				weeklyAll: 72,
				headers: {
					"anthropic-ratelimit-unified-status": "rate_limited",
				},
			},
		]) {
			usageCache.delete("acc-anthropic-1");
			cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000, {
				weeklyAll: fixture.weeklyAll,
			});
			globalThis.fetch = mock(async () => generic429Response(fixture.headers));
			const ctx = makeProxyContextWithAsyncExec();
			const account = makeAccount();
			const bodyBuffer = makeRequestBody("claude-fable-5");
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
			expect(account.rate_limited_until).not.toBeNull();
			expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
		}
	});

	it("keeps an unknown concrete model account-scoped", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		globalThis.fetch = mock(async () => generic429Response());
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("custom-model-without-family");
		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		expect(account.rate_limited_until).not.toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
	});

	it("attributes a configured fallback 429 to its concrete Fable model", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		let calls = 0;
		const fallbackBodyState = { cancelled: false };
		globalThis.fetch = mock(async () => {
			calls++;
			return calls === 1
				? new Response(
						JSON.stringify({
							type: "error",
							error: { type: "not_found_error", message: "model not found" },
						}),
						{
							status: 404,
							headers: { "content-type": "application/json" },
						},
					)
				: new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								fallbackBodyState.cancelled = true;
							},
						}),
						{
							status: 429,
							headers: { "content-type": "application/json" },
						},
					);
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["claude-sonnet-4-5", "claude-fable-5-20260701"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(calls).toBe(2);
		expect(fallbackBodyState.cancelled).toBe(true);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)[0]).toMatchObject({
			scope: "family",
			family: "fable",
			attemptedModel: "claude-fable-5-20260701",
		});
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls[0]?.[6]).toBe("model_scoped_429");
		expect(saveMock.mock.calls[0]?.[9]).toEqual({
			model: "claude-fable-5-20260701",
		});
	});

	it("a concrete success clears only the matching exact beta and family", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						type: "message",
						content: [{ type: "text", text: "ok" }],
						model: "claude-fable-5",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		usageCache.markModelScopedExhausted(
			"acc-anthropic-1",
			"claude-fable-5",
			"beta-a",
			INCIDENT_NOW + 300_000,
		);
		usageCache.markModelScopedExhausted(
			"acc-anthropic-1",
			"claude-fable-5",
			"beta-b",
			INCIDENT_NOW + 300_000,
		);
		usageCache.markFamilyScopedExhausted(
			"acc-anthropic-1",
			"claude-fable-5",
			INCIDENT_NOW + 300_000,
		);
		usageCache.markFamilyScopedExhausted(
			"acc-anthropic-1",
			"claude-opus-4-8",
			INCIDENT_NOW + 300_000,
		);
		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"content-type": "application/json",
				"anthropic-beta": "beta-a",
			},
		});

		try {
			await proxyWithAccount(
				req,
				new URL(req.url),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (error) {
			// The scoped-success clear happens before forwardToClient; this focused
			// unit fixture intentionally does not initialize the global collector.
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector not initialized")
			) {
				throw error;
			}
		}

		expect(
			usageCache.getModelScopedExhaustion(
				"acc-anthropic-1",
				"claude-fable-5",
				"beta-a",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				"acc-anthropic-1",
				"claude-fable-5",
				"beta-b",
				INCIDENT_NOW,
			),
		).not.toBeNull();
		expect(
			usageCache.getFamilyScopedExhaustion(
				"acc-anthropic-1",
				"claude-fable-5",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(
			usageCache.getFamilyScopedExhaustion(
				"acc-anthropic-1",
				"claude-opus-4-8",
				INCIDENT_NOW,
			),
		).not.toBeNull();
	});
});

interface ObservableErrorResponse {
	response: Response;
	cancelCount: () => number;
}

describe("proxyWithAccount — durable account cooldown ordering", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.delete("acc-anthropic-1");
	});

	it("waits for generic non-xAI 402 cooldown persistence while request audit stays async", async () => {
		const cooldownPersist = deferred<number>();
		const cooldownStarted = deferred<void>();
		const auditPersist = deferred<void>();
		const ctx = makeProxyContextWithAsyncExec();
		ctx.dbOps.markAccountRateLimited = mock(() => {
			cooldownStarted.resolve();
			return cooldownPersist.promise;
		});
		ctx.dbOps.saveRequest = mock(() => auditPersist.promise);
		const paymentRequired = observableErrorResponse(402);
		globalThis.fetch = mock(async () => paymentRequired.response);
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		const operation = proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		let operationSettled = false;
		void operation.then(() => {
			operationSettled = true;
		});

		await cooldownStarted.promise;
		await Promise.resolve();
		expect(operationSettled).toBe(false);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();

		cooldownPersist.resolve(1);
		await expect(operation).resolves.toBeNull();
		expect(ctx.dbOps.saveRequest).toHaveBeenCalledTimes(1);
		let auditSettled = false;
		void auditPersist.promise.then(() => {
			auditSettled = true;
		});
		await Promise.resolve();
		expect(auditSettled).toBe(false);

		auditPersist.resolve();
		await auditPersist.promise;
	});

	it("waits for hard account-scoped Anthropic 429 cooldown persistence while request audit stays async", async () => {
		const cooldownPersist = deferred<number>();
		const cooldownStarted = deferred<void>();
		const auditPersist = deferred<void>();
		const ctx = makeProxyContextWithAsyncExec();
		ctx.dbOps.markAccountRateLimited = mock(() => {
			cooldownStarted.resolve();
			return cooldownPersist.promise;
		});
		ctx.dbOps.saveRequest = mock(() => auditPersist.promise);
		const hardAccount429 = observableErrorResponse(429, {
			"anthropic-ratelimit-unified-status": "rate_limited",
			"retry-after": "120",
		});
		globalThis.fetch = mock(async () => hardAccount429.response);
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		const operation = proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		let operationSettled = false;
		void operation.then(() => {
			operationSettled = true;
		});

		await cooldownStarted.promise;
		await Promise.resolve();
		expect(operationSettled).toBe(false);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();

		cooldownPersist.resolve(1);
		await expect(operation).resolves.toBeNull();
		expect(ctx.dbOps.saveRequest).toHaveBeenCalledTimes(1);
		let auditSettled = false;
		void auditPersist.promise.then(() => {
			auditSettled = true;
		});
		await Promise.resolve();
		expect(auditSettled).toBe(false);

		auditPersist.resolve();
		await auditPersist.promise;
	});
});

describe("proxyWithAccount — scoped same-account model continuation", () => {
	let originalFetch: typeof globalThis.fetch;
	let realDateNow: typeof Date.now;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		realDateNow = Date.now;
		Date.now = () => INCIDENT_NOW;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Date.now = realDateNow;
		usageCache.delete("acc-anthropic-1");
	});

	it("stops before a sibling-model fallback when the first 429 proves account exhaustion", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const hardAccount429 = observableErrorResponse(429, {
			"anthropic-ratelimit-unified-status": "rate_limited",
			"retry-after": "120",
		});
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			return attemptedModels.length === 1
				? hardAccount429.response
				: generic429Response();
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);
		const routingAttemptLedger = new RoutingAttemptLedger();

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
			routingAttemptLedger,
		);

		expect(result).toBeNull();
		expect(attemptedModels).toEqual(["claude-fable-5"]);
		expect(hardAccount429.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBe(INCIDENT_NOW + 120_000);
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				accountId: account.id,
				status: 429,
				scope: "account",
				family: "fable",
				attemptedModel: "claude-fable-5",
				reason: "hard_response_signal",
				availableAt: INCIDENT_NOW + 120_000,
			}),
		]);
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock).toHaveBeenCalledTimes(1);
		expect(saveMock.mock.calls[0]?.[6]).toBe("model_fallback_429");
		expect(routingAttemptLedger.claim(account.id, "claude-opus-4-8")).toBe(
			false,
		);
		expect(
			usageCache.getModelScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				null,
				INCIDENT_NOW,
			),
		).toBeNull();
	});

	it("continues from an initial Fable family failure to distinct Opus", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const scopedFable = observableErrorResponse(429);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			return attemptedModels.length === 1
				? scopedFable.response
				: successfulClaudeResponse(model);
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		await proxyUntilSuccessfulTransport(req, account, ctx, bodyBuffer);

		expect(attemptedModels).toEqual(["claude-fable-5", "claude-opus-4-8"]);
		expect(scopedFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-5",
			}),
		]);
	});

	it("continues past an intermediate Fable family failure to Opus", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const scopedFable = observableErrorResponse(429);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			if (attemptedModels.length === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "not_found_error", message: "model not found" },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return attemptedModels.length === 2
				? scopedFable.response
				: successfulClaudeResponse(model);
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["claude-sonnet-4-5", "claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		await proxyUntilSuccessfulTransport(req, account, ctx, bodyBuffer);

		expect(attemptedModels).toEqual([
			"claude-sonnet-4-5",
			"claude-fable-5",
			"claude-opus-4-8",
		]);
		expect(scopedFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-5",
			}),
		]);
	});

	it("an exact-model failure still permits a distinct model in the same family", async () => {
		const exactFable = observableErrorResponse(429, {
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		});
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			return attemptedModels.length === 1
				? exactFable.response
				: successfulClaudeResponse(model);
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-fable-5-20260701", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		await proxyUntilSuccessfulTransport(req, account, ctx, bodyBuffer);

		expect(attemptedModels).toEqual([
			"claude-fable-5",
			"claude-fable-5-20260701",
		]);
		expect(exactFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				scope: "model",
				family: "fable",
				attemptedModel: "claude-fable-5",
			}),
		]);
	});

	it("preserves keepalive termination without probing a configured fallback", async () => {
		const exactFable = observableErrorResponse(429, {
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		});
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			attemptedModels.push(body.model ?? "missing");
			return exactFable.response;
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(attemptedModels).toEqual(["claude-fable-5"]);
		expect(exactFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(getRequestRateLimitOutcomes(req)).toEqual([]);
		expect(
			usageCache.getModelScopedExhaustion(account.id, "claude-fable-5", null),
		).toBeNull();
	});

	it("a family marker skips later same-family candidates before trying Opus", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const scopedFable = observableErrorResponse(429);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			const model = body.model ?? "missing";
			attemptedModels.push(model);
			return attemptedModels.length === 1
				? scopedFable.response
				: successfulClaudeResponse(model);
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-fable-5-20260701", "claude-opus-4-8"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		await proxyUntilSuccessfulTransport(req, account, ctx, bodyBuffer);

		expect(attemptedModels).toEqual(["claude-fable-5", "claude-opus-4-8"]);
		expect(scopedFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("fails over without account cooldown when family pruning leaves no candidate", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const scopedFable = observableErrorResponse(429);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const body = (await request.clone().json()) as { model?: string };
			attemptedModels.push(body.model ?? "missing");
			return scopedFable.response;
		});
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-fable-5-20260701"],
			}),
		});
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(attemptedModels).toEqual(["claude-fable-5"]);
		expect(scopedFable.cancelCount()).toBe(1);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});
});

function observableErrorResponse(
	status: number,
	headers: HeadersInit = {},
): ObservableErrorResponse {
	let cancellations = 0;
	const payload = new TextEncoder().encode(
		JSON.stringify({
			type: "error",
			error: {
				type: status === 529 ? "overloaded_error" : "rate_limit_error",
				message: status === 529 ? "Overloaded" : "An error occurred",
			},
		}),
	);
	return {
		response: new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(payload);
				},
				cancel() {
					cancellations++;
				},
			}),
			{
				status,
				headers: { "content-type": "application/json", ...headers },
			},
		),
		cancelCount: () => cancellations,
	};
}

function make529RetryContext(): ProxyContext {
	const ctx = makeProxyContextWithAsyncExec();
	(ctx as { provider: typeof ctx.provider }).provider = {
		...ctx.provider,
		parseRateLimit: (response: Response) => ({
			isRateLimited: response.status === 429 || response.status === 529,
			resetTime: undefined,
			statusHeader: undefined,
			remaining: undefined,
		}),
	} as typeof ctx.provider;
	return ctx;
}

describe("proxyWithAccount — scoped failures returned by a 529 retry", () => {
	let originalFetch: typeof globalThis.fetch;
	let realDateNow: typeof Date.now;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		realDateNow = Date.now;
		Date.now = () => INCIDENT_NOW;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Date.now = realDateNow;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		usageCache.delete("acc-anthropic-1");
	});

	it("keeps 529 -> exact out_of_credits model-scoped and drains the retry once", async () => {
		const initial529 = observableErrorResponse(529);
		const retry429 = observableErrorResponse(429, {
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		});
		let calls = 0;
		globalThis.fetch = mock(async () =>
			++calls === 1 ? initial529.response : retry429.response,
		);
		const ctx = make529RetryContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(calls).toBe(2);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(retry429.cancelCount()).toBe(1);
		expect(
			usageCache.getModelScopedExhaustion(account.id, "claude-fable-5", null),
		).not.toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(account.id, "claude-opus-4-8", null),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				status: 429,
				scope: "model",
				family: "fable",
				attemptedModel: "claude-fable-5",
				reason: "out_of_credits",
			}),
		]);
		const exactSave = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(exactSave).toHaveBeenCalledTimes(1);
		expect(exactSave.mock.calls[0]?.[6]).toBe("out_of_credits");
		expect(exactSave.mock.calls[0]?.[9]).toEqual({ model: "claude-fable-5" });
	});

	it("keeps 529 -> fresh positive family evidence scoped and leaves Opus eligible", async () => {
		cacheIncidentUsage("acc-anthropic-1", INCIDENT_NOW - 120_000);
		const initial529 = observableErrorResponse(529);
		const retry429 = observableErrorResponse(429);
		let calls = 0;
		globalThis.fetch = mock(async () =>
			++calls === 1 ? initial529.response : retry429.response,
		);
		const ctx = make529RetryContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-fable-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(calls).toBe(2);
		expect(account.rate_limited_until).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(retry429.cancelCount()).toBe(1);
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-fable-5",
				INCIDENT_NOW,
			),
		).toMatchObject({ family: "fable" });
		expect(
			usageCache.getFamilyScopedExhaustion(
				account.id,
				"claude-opus-4-8",
				INCIDENT_NOW,
			),
		).toBeNull();
		expect(getRequestRateLimitOutcomes(req)).toEqual([
			expect.objectContaining({
				status: 429,
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-5",
			}),
		]);
		const familySave = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(familySave).toHaveBeenCalledTimes(1);
		expect(familySave.mock.calls[0]?.[6]).toBe("model_scoped_429");
		expect(familySave.mock.calls[0]?.[9]).toEqual({ model: "claude-fable-5" });
	});

	it("keeps stale usage model-scoped but explicit hard signals account-scoped after a 529", async () => {
		for (const fixture of [
			{
				observedAt: INCIDENT_NOW - 181_000,
				headers: {},
				expectAccountCooldown: false,
			},
			{
				observedAt: INCIDENT_NOW - 120_000,
				headers: {
					"anthropic-ratelimit-unified-status": "rate_limited",
				},
				expectAccountCooldown: true,
			},
		]) {
			usageCache.delete("acc-anthropic-1");
			cacheIncidentUsage("acc-anthropic-1", fixture.observedAt);
			const initial529 = observableErrorResponse(529);
			const retry429 = observableErrorResponse(429, fixture.headers);
			let calls = 0;
			globalThis.fetch = mock(async () =>
				++calls === 1 ? initial529.response : retry429.response,
			);
			const ctx = make529RetryContext();
			const account = makeAccount();
			const bodyBuffer = makeRequestBody("claude-fable-5");
			const req = makeRequest(bodyBuffer);

			const result = await proxyWithAccount(
				req,
				new URL(req.url),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);

			expect(result).toBeNull();
			expect(calls).toBe(2);
			if (fixture.expectAccountCooldown) {
				expect(account.rate_limited_until).not.toBeNull();
				expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
				expect(getRequestRateLimitOutcomes(req)).toEqual([
					expect.objectContaining({
						scope: "account",
						reason: "hard_response_signal",
						availableAt: account.rate_limited_until,
					}),
				]);
			} else {
				expect(account.rate_limited_until).toBeNull();
				expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
				expect(
					usageCache.getModelScopedExhaustion(
						account.id,
						"claude-fable-5",
						null,
						INCIDENT_NOW,
					),
				).not.toBeNull();
				expect(getRequestRateLimitOutcomes(req)).toEqual([
					expect.objectContaining({
						scope: "model",
						reason: "stale_usage",
					}),
				]);
			}
			expect(
				usageCache.getFamilyScopedExhaustion(
					account.id,
					"claude-fable-5",
					INCIDENT_NOW,
				),
			).toBeNull();
		}
	});
});
