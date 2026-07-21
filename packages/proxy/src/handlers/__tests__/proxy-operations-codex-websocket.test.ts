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
import {
	type CodexWebSocketReceipt,
	codexWebSocketTransport,
} from "../../codex-websocket-transport";
import type { ModelFallbackExecutionPolicy } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Source worktrees intentionally exclude generated database worker bundles.
// This harness injects dbOps and never constructs these classes.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../../usage-collector");
const { proxyWithAccount } = await import("../proxy-operations");

function makeCodexAccount(): Account {
	return {
		id: "codex-ws-account",
		name: "codex-ws-test",
		provider: "codex",
		api_key: null,
		refresh_token: "",
		access_token: "test-access-token",
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
		model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			metadata: {
				user_id:
					"user_11111111-1111-4111-8111-111111111111_account__session_11111111-1111-4111-8111-111111111111",
			},
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeRequest(body: ArrayBuffer): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
		},
	});
}

function makeRequestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makePolicy(deadlineMs = 100): ModelFallbackExecutionPolicy {
	const routeAbort = new AbortController();
	const deadlineAt = Date.now() + deadlineMs;
	return {
		routeCandidateId: "codex-ws-route",
		implicitFallbacksEnabled: false,
		forwardModelUnavailableResponse: true,
		isFinalSemanticAttempt: () => true,
		anthropicPreCommitRescue: {
			activate: () => undefined,
			signal: routeAbort.signal,
			commitmentDeadlineAt: deadlineAt,
			getAttemptCommitmentDeadlineAt: () => deadlineAt,
			registerTerminalRecorder: () => undefined,
			registerRequestLifecycle: () => undefined,
			releaseResponseLifecycle: () => undefined,
			reportTerminal: () => undefined,
		},
	};
}

function makeReceipt(onMark: () => void): CodexWebSocketReceipt {
	const receipt: CodexWebSocketReceipt = {
		connectionId: "conn_test",
		cohortId: "cohort_test",
		reused: false,
		frameWritten: true,
		stickyHttp: false,
		markPostWriteFailure: () => {
			onMark();
			receipt.stickyHttp = true;
		},
	};
	return receipt;
}

function installUsageCollector(): void {
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(() => Promise.resolve()),
	} as never);
}

async function runProxy(
	request: Request,
	body: ArrayBuffer,
	policy: ModelFallbackExecutionPolicy,
	requestId: string,
): Promise<Response | null> {
	return proxyWithAccount(
		request,
		new URL(request.url),
		makeCodexAccount(),
		makeRequestMeta(requestId),
		body,
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
		policy,
	);
}

describe("proxyWithAccount: Codex Responses WebSocket no-replay boundary", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalPromptCacheKey: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalPromptCacheKey = process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalPromptCacheKey === undefined) {
			delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		} else {
			process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = originalPromptCacheKey;
		}
		mock.restore();
	});

	it("never falls back to HTTP after response.create was written and the attempt deadline fires", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP fallback", { status: 500 });
		});

		let postWriteMarks = 0;
		const receipt = makeReceipt(() => postWriteMarks++);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			await new Promise<never>((_resolve, reject) => {
				const rejectFromAbort = () => reject(input.signal.reason);
				input.signal.addEventListener("abort", rejectFromAbort, { once: true });
				if (input.signal.aborted) rejectFromAbort();
			});
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(),
			"codex-ws-request",
		);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteMarks).toBe(1);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(504);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_semantic_stall" },
		});
	});

	it("does not replay over HTTP when a structurally-started WebSocket stream reaches its semantic deadline", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		let postWriteMarks = 0;
		const receipt = makeReceipt(() => postWriteMarks++);
		const encoder = new TextEncoder();
		const structurallyStarted = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_structural","model":"gpt-5.4"}}\n\n',
						),
					);
					// Deliberately no meaningful event and no terminal event.
				},
			}),
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			return { response: structurallyStarted, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(150),
			"codex-ws-structural-stall",
		);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteMarks).toBe(1);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(504);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_semantic_stall" },
		});
	});

	it("vetoes the official Codex api_error retry after response.create was written", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		let postWriteMarks = 0;
		const receipt = makeReceipt(() => postWriteMarks++);
		const encoder = new TextEncoder();
		const websocketFailure = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							[
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_failed","model":"gpt-5.4"}}\n\n',
								'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_failed","model":"gpt-5.4","status":"failed","error":{"type":"api_error","message":"bounded test failure"}}}\n\n',
								"data: [DONE]\n\n",
							].join(""),
						),
					);
					controller.close();
				},
			}),
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
		let websocketCalls = 0;
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			websocketCalls++;
			if (websocketCalls > 1) return null;
			input.onFrameWritten?.(receipt);
			return { response: websocketFailure, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(500),
			"codex-ws-api-error",
		);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteMarks).toBe(1);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(502);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_post_write_error" },
		});
	});
});
