import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
	ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS,
	ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
	ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
	getAnthropicStreamRuntimeConfig,
} from "../anthropic-semantic-preflight";
import type { ProxyContext } from "../handlers";
import type { UsageCollector } from "../usage-collector";

// Loading proxy.ts in a focused unit test must not require ignored embedded
// worker artifacts from the CLI build.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../usage-collector");
const { alignRouteCandidateIds, handleProxy } = await import("../proxy");

const MODEL = "claude-opus-4-8";
const SESSION = "semantic-failover-session";
const TIMEOUT_ENV = "CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS";
const TERMINAL_GRACE_ENV = "CCFLARE_ANTHROPIC_TERMINAL_GRACE_MS";
const BUFFER_ENV = "CCFLARE_ANTHROPIC_PRECOMMIT_MAX_BUFFER_BYTES";
const SUPPRESSION_ENV = "CCFLARE_ANTHROPIC_ROUTE_SUPPRESSION_MS";

const originalFetch = globalThis.fetch;
const originalEnv = new Map(
	[TIMEOUT_ENV, TERMINAL_GRACE_ENV, BUFFER_ENV, SUPPRESSION_ENV].map(
		(name) => [name, process.env[name]] as const,
	),
);
let restoreUsageCollector = (): void => {};

const encoder = new TextEncoder();
const PRELUDE = [
	"event: message_start",
	'data: {"type":"message_start","message":{"id":"msg-stalled","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
	"",
	"event: ping",
	'data: {"type":"ping"}',
	"",
	"",
].join("\n");
const SUCCESS = [
	"event: message_start",
	'data: {"type":"message_start","message":{"id":"msg-success","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
	"",
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}',
	"",
	"event: content_block_stop",
	'data: {"type":"content_block_stop","index":0}',
	"",
	"event: message_delta",
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
	"",
	"event: message_stop",
	'data: {"type":"message_stop"}',
	"",
	"",
].join("\n");
const TRANSIENT_ERROR = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: error",
	'data: {"type":"error","error":{"type":"api_error","message":"private upstream detail"}}',
	"",
	"",
].join("\n");
const NONRETRYABLE_ERROR = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: error",
	'data: {"type":"error","error":{"type":"authentication_error","message":"do not reroute"}}',
	"",
	"",
].join("\n");
const POSTCOMMIT_STALL = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
	"",
	"event: ping",
	'data: {"type":"ping"}',
	"",
	"",
].join("\n");

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: `key-${id}`,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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
	};
}

function byteStream(bytes: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(bytes));
			controller.close();
		},
	});
}

function stalledStream(onCancel: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(PRELUDE));
		},
		cancel() {
			onCancel();
		},
	});
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

function makeCombo(accounts: readonly Account[]): ComboWithSlots {
	return {
		id: "semantic-combo",
		name: "Semantic Opus",
		description: null,
		enabled: true,
		created_at: 0,
		updated_at: 0,
		slots: accounts.map((account, index) => ({
			id: `semantic-slot-${index}`,
			combo_id: "semantic-combo",
			account_id: account.id,
			model: MODEL,
			priority: index,
			enabled: true,
		})),
	};
}

function makeContext(accounts: Account[], combo: ComboWithSlots | null = null) {
	const reportCandidateFailure = mock(
		(
			_meta: RequestMeta,
			_failure: { candidateId: string; reason: string; suppressForMs: number },
		) => undefined,
	);
	const ctx = {
		strategy: {
			select: mock(async (selected: Account[]) => selected),
			peek: mock(() => accounts[0]?.id ?? null),
			reportCandidateFailure,
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			getAgentPreference: mock(async () => null),
		},
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string, account: Account) =>
				`https://upstream.test/${account.id}`,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) },
	} as unknown as ProxyContext;
	return { ctx, reportCandidateFailure };
}

function makeRequest(signal?: AbortSignal, forcedAccountId?: string): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (forcedAccountId) {
		headers["x-better-ccflare-account-id"] = forcedAccountId;
	}
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			metadata: { user_id: SESSION },
			max_tokens: 16,
		}),
		signal,
	});
}

beforeEach(() => {
	process.env[TIMEOUT_ENV] = "20";
	process.env[TERMINAL_GRACE_ENV] = "10";
	process.env[BUFFER_ENV] = "1048576";
	process.env[SUPPRESSION_ENV] = "12345";
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as UsageCollector);
	restoreUsageCollector = () => collectorSpy.mockRestore();
});

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
	for (const [name, value] of originalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("native Anthropic semantic pre-commit routing", () => {
	it("fails over an HTTP-200 transient SSE error before leaking any first-route bytes", async () => {
		const first = makeAccount("transient-a");
		const second = makeAccount("healthy-b");
		const { ctx, reportCandidateFailure } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const accountId = request.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			return sseResponse(
				byteStream(accountId === first.id ? TRANSIENT_ERROR : SUCCESS),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toBe(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		expect(reportCandidateFailure.mock.calls[0][1]).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_precommit_transient_sse_error:api_error",
			suppressForMs: 12345,
		});
	});

	it("reuses account cooldown policy for a precommit rate_limit_error", async () => {
		const first = makeAccount("limited-a");
		const second = makeAccount("healthy-b");
		const { ctx } = makeContext([first, second], makeCombo([first, second]));
		const rateLimitError = TRANSIENT_ERROR.replace(
			'"type":"api_error"',
			'"type":"rate_limit_error"',
		);
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const accountId = request.headers.get("x-api-key")?.slice(4) ?? "";
			return sseResponse(
				byteStream(accountId === first.id ? rateLimitError : SUCCESS),
			);
		}) as unknown as typeof fetch;

		const before = Date.now();
		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toBe(SUCCESS);
		expect(first.rate_limited_until).toBeGreaterThan(before);
		expect(first.consecutive_rate_limits).toBe(1);
	});

	it("commits nonretryable SSE errors byte-identically without trying another route", async () => {
		const first = makeAccount("auth-error-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(NONRETRYABLE_ERROR));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toBe(NONRETRYABLE_ERROR);
		expect(fetchCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("returns the stable route-unavailable 503 when every route emits a transient precommit error", async () => {
		const first = makeAccount("transient-a");
		const second = makeAccount("transient-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		globalThis.fetch = mock(async () =>
			sseResponse(byteStream(TRANSIENT_ERROR)),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { type: string; code: string };
		};

		expect(response.status).toBe(503);
		expect(payload.error).toMatchObject({
			type: "service_unavailable",
			code: "route_unavailable",
		});
		expect(reportCandidateFailure).toHaveBeenCalledTimes(2);
	});

	it("cancels a stalled prelude once and reroutes without leaking its bytes", async () => {
		const first = makeAccount("anthropic-a");
		const second = makeAccount("anthropic-b");
		const { ctx, reportCandidateFailure } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		let firstCancelCount = 0;
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const accountId = request.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			return accountId === first.id
				? sseResponse(stalledStream(() => firstCancelCount++))
				: sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(firstCancelCount).toBe(1);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		const [reportedMeta, failure] = reportCandidateFailure.mock.calls[0];
		expect(failure).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_precommit_semantic_timeout",
			suppressForMs: 12345,
		});
		const lane = JSON.parse(
			reportedMeta.affinityLaneKey ?? "null",
		) as unknown[];
		expect(lane[1]).toBe(SESSION);
		expect(lane[5]).toBe(MODEL);
	});

	it("commits on the first real content delta and never retries another account", async () => {
		const first = makeAccount("commit-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toBe(SUCCESS);
		expect(fetchCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("never retries after content commitment and suppresses the exact route for the next turn", async () => {
		const first = makeAccount("postcommit-a");
		const second = makeAccount("must-not-splice-b");
		const { ctx, reportCandidateFailure } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(POSTCOMMIT_STALL));
					},
					cancel() {
						cancelCount++;
					},
				}),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const responseText = await response.text();
		const cancelDeadline = Date.now() + 250;
		while (cancelCount === 0 && Date.now() < cancelDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(1);
		expect(responseText).toStartWith(POSTCOMMIT_STALL);
		expect(responseText).toEndWith(
			'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response stalled after partial output"}}\n\n',
		);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		expect(reportCandidateFailure.mock.calls[0][1]).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_postcommit_semantic_timeout",
			suppressForMs: 12345,
		});
	});

	it("stops on caller abort during preflight without retrying or penalizing", async () => {
		const first = makeAccount("abort-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		const abortController = new AbortController();
		let cancelCount = 0;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			queueMicrotask(() => abortController.abort("test_abort"));
			return sseResponse(stalledStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		const request = makeRequest(abortController.signal);
		await expect(
			handleProxy(request, new URL(request.url), ctx),
		).rejects.toBeDefined();

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("returns route_unavailable after every candidate stalls", async () => {
		const first = makeAccount("stall-a");
		const second = makeAccount("stall-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		let cancelCount = 0;
		globalThis.fetch = mock(async () =>
			sseResponse(stalledStream(() => cancelCount++)),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { type: string; code: string };
		};

		expect(response.status).toBe(503);
		expect(payload.error.type).toBe("service_unavailable");
		expect(payload.error.code).toBe("route_unavailable");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(cancelCount).toBe(2);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(2);
	});

	it("never escapes an explicitly forced account after a semantic stall", async () => {
		const forced = makeAccount("forced-a");
		const unrelated = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure } = makeContext([forced, unrelated]);
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			fetchedAccounts.push(request.headers.get("x-api-key")?.slice(4) ?? "");
			return sseResponse(stalledStream(() => undefined));
		}) as unknown as typeof fetch;

		const request = makeRequest(undefined, forced.id);
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { type: string; code: string };
		};

		expect(response.status).toBe(503);
		expect(payload.error.type).toBe("service_unavailable");
		expect(payload.error.code).toBe("route_unavailable");
		expect(fetchedAccounts).toEqual([forced.id]);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
	});
});

describe("Anthropic stream runtime configuration", () => {
	it("falls back to module defaults for invalid values", () => {
		process.env[TIMEOUT_ENV] = "0";
		process.env[TERMINAL_GRACE_ENV] = "not-a-number";
		process.env[BUFFER_ENV] = "-1";
		process.env[SUPPRESSION_ENV] = "1.5";

		expect(getAnthropicStreamRuntimeConfig()).toEqual({
			semanticTimeoutMs: ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
			terminalGraceMs: ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
			maxBufferedBytes: ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
			routeSuppressionMs: ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS,
		});
	});

	it("clamps oversized values to finite operational bounds", () => {
		process.env[TIMEOUT_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[TERMINAL_GRACE_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[BUFFER_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[SUPPRESSION_ENV] = String(Number.MAX_SAFE_INTEGER);

		expect(getAnthropicStreamRuntimeConfig()).toEqual({
			semanticTimeoutMs: 10 * 60 * 1000,
			terminalGraceMs: 60 * 1000,
			maxBufferedBytes: 16 * 1024 * 1024,
			routeSuppressionMs: 24 * 60 * 60 * 1000,
		});
	});
});

describe("route candidate identity reconciliation", () => {
	it("keeps the exact candidate after account-only filtering shifts indexes", () => {
		const filtered = makeAccount("filtered-a");
		const retained = makeAccount("retained-b");

		expect(
			alignRouteCandidateIds(
				[retained],
				[
					{ accountId: filtered.id, candidateId: "combo:c:slot:a" },
					{ accountId: retained.id, candidateId: "combo:c:slot:b" },
				],
			),
		).toEqual(["combo:c:slot:b"]);
	});

	it("consumes repeated same-account combo candidates occurrence by occurrence", () => {
		const repeated = makeAccount("repeated-a");
		const other = makeAccount("other-b");

		expect(
			alignRouteCandidateIds(
				[repeated, repeated, other],
				[
					{ accountId: repeated.id, candidateId: "combo:c:slot:a0" },
					{ accountId: repeated.id, candidateId: "combo:c:slot:a1" },
					{ accountId: other.id, candidateId: "combo:c:slot:b" },
				],
			),
		).toEqual(["combo:c:slot:a0", "combo:c:slot:a1", "combo:c:slot:b"]);
	});
});
