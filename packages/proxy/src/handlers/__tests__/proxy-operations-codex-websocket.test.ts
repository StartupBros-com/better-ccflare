import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LOGICAL_MODEL_FAMILY_HEADER } from "@better-ccflare/http-common";
import type {
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { ANTHROPIC_DRAIN_DEADLINE_MS } from "../../anthropic-terminal-recovery";
import { CACHE_REPLAY_MODEL_HEADER } from "../../cache-transport-staging";
import {
	type CodexWebSocketReceipt,
	codexWebSocketTransport,
} from "../../codex-websocket-transport";
import type { ModelFallbackExecutionPolicy } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Source worktrees intentionally exclude generated database worker bundles.
// This harness injects dbOps and never constructs these classes.
const usageCollectorModule = await import("../../usage-collector");
const {
	deriveServerToolRequirement,
	getProvider,
	isCodexExplicitCacheBreakpointSuppressed,
	resetCodexExplicitBreakpointSuppressionsForTest,
} = await import("@better-ccflare/providers");
const { ForceRouteUnavailableError, selectAccountsForRequest } = await import(
	"../account-selector"
);
const { proxyWithAccount } = await import("../proxy-operations");
const { createRoutingTerminalResponse } = await import("../routing-terminal");
const {
	MAX_REQUEST_PHYSICAL_ATTEMPTS,
	PhysicalAttemptBudgetExceededError,
	RoutingAttemptLedger,
} = await import("../routing-attempt-ledger");
const { bindRequestPrivateServerToolReplay } = await import(
	"../../server-tool-replay-runtime"
);
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"../../__tests__/helpers/server-tool-replay-runtime"
);
const { opaqueRuntimeId } = await import("../../opaque-runtime-id");

const HOSTED_REPLAY_CREDENTIAL = "Bearer codex-websocket-hosted-test";
const HOSTED_REPLAY_LINEAGE = "codex-websocket-hosted-session";
const HOSTED_REPLAY_RUNTIME = await createReadyServerToolReplayRuntimeForTest();

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
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
		model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			saveRoutingAttempt: mock(() => Promise.resolve()),
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
			tools: [
				{
					name: "Lookup",
					description: "Lookup a value",
					input_schema: { type: "object" },
				},
			],
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeConversationRequestBody(
	messages: unknown[],
	sessionId = "11111111-1111-4111-8111-111111111111",
): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages,
			metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
			tools: [
				{
					name: "Lookup",
					description: "Lookup a value",
					input_schema: { type: "object" },
				},
			],
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeRequest(
	body: ArrayBuffer,
	extraHeaders: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			...extraHeaders,
		},
	});
}

function makeRequestMeta(
	id: string,
	overrides: Partial<RequestMeta> = {},
): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makePolicy(
	deadlineMs = 100,
	options: {
		attemptDeadlineMs?: number;
		isFinalAttempt?: boolean;
		routeAbort?: AbortController;
	} = {},
): ModelFallbackExecutionPolicy {
	const routeAbort = options.routeAbort ?? new AbortController();
	const startedAt = Date.now();
	const deadlineAt = startedAt + deadlineMs;
	const attemptDeadlineAt =
		startedAt + (options.attemptDeadlineMs ?? deadlineMs);
	return {
		routeCandidateId: "codex-ws-route",
		implicitFallbacksEnabled: false,
		forwardModelUnavailableResponse: true,
		isFinalSemanticAttempt: () => options.isFinalAttempt ?? true,
		anthropicPreCommitRescue: {
			activate: () => undefined,
			signal: routeAbort.signal,
			isRescueCommitted: () => false,
			markRescueCommitted: () => undefined,
			commitmentDeadlineAt: deadlineAt,
			getAttemptCommitmentDeadlineAt: (isFinalAttempt) =>
				isFinalAttempt ? deadlineAt : attemptDeadlineAt,
			registerTerminalRecorder: () => undefined,
			registerRequestLifecycle: () => undefined,
			releaseResponseLifecycle: () => undefined,
			reportTerminal: () => undefined,
		},
	};
}

function makeReceipt(
	onMark: (
		category: Parameters<CodexWebSocketReceipt["markPostWriteFailure"]>[0],
	) => void,
): CodexWebSocketReceipt {
	const receipt: CodexWebSocketReceipt = {
		connectionId: "conn_test",
		cohortId: "cohort_test",
		reused: false,
		frameWritten: true,
		stickyHttp: false,
		markPostWriteFailure: (category) => {
			onMark(category);
			receipt.stickyHttp = true;
		},
	};
	return receipt;
}

async function waitForCondition(
	condition: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadlineAt = Date.now() + timeoutMs;
	while (!condition()) {
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) {
			throw new Error(`condition did not become true within ${timeoutMs}ms`);
		}
		await Bun.sleep(Math.min(10, remainingMs));
	}
}

function installUsageCollector(): void {
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(() => Promise.resolve()),
	} as never);
}

function installCountingCodexAttemptPlanner(
	onPlan: (context: ProviderAttemptPlanContext) => void,
): () => void {
	const provider = getProvider("codex");
	if (!provider) throw new Error("Codex provider is not registered");
	const originalCreateAttemptPlan = provider.createAttemptPlan;
	provider.createAttemptPlan = (context) => {
		onPlan(context);
		const candidate: ProviderAttemptPlan = {
			providerName: provider.name,
			targetUrl: provider.buildUrl(
				context.path,
				context.query,
				context.account,
			),
			apiFamily: "codex-responses",
			physicalModel: context.physicalModel,
			capabilityProofKey: context.capabilityProofKey,
			inputReplayMode: context.inputReplayMode,
			outputReplayMode: context.outputReplayMode,
			dataRetryPolicy: { mode: "none", maxAttempts: 0 },
			classifyNoExecution: async () => ({
				decision: "executing_or_ambiguous",
			}),
			cacheReplayModelStrategy:
				provider.cacheReplayModelStrategy ?? "normalized-source",
			prepareHeaders: (headers, accessToken, apiKey) =>
				provider.prepareHeaders(headers, accessToken, apiKey),
			transformRequestBody: (request) =>
				provider.transformRequestBody
					? provider.transformRequestBody(request, context.account)
					: Promise.resolve(request),
			processResponse: (response, requestHeaders) =>
				provider.processResponse(response, context.account, requestHeaders),
			parseRateLimit: (response) => provider.parseRateLimit(response),
			...(provider.isStreamingResponse
				? {
						isStreamingResponse: (response: Response) =>
							provider.isStreamingResponse?.(response) ?? false,
					}
				: {}),
			...(provider.extractTierInfo
				? {
						extractTierInfo: (response: Response) =>
							provider.extractTierInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
			...(provider.extractUsageInfo
				? {
						extractUsageInfo: (response: Response) =>
							provider.extractUsageInfo?.(response) ?? Promise.resolve(null),
					}
				: {}),
			...(provider.parseUsage
				? {
						parseUsage: (response: Response) =>
							provider.parseUsage?.(response) ?? Promise.resolve(null),
					}
				: {}),
		};
		return candidate;
	};
	return () => {
		if (originalCreateAttemptPlan) {
			provider.createAttemptPlan = originalCreateAttemptPlan;
		} else {
			delete provider.createAttemptPlan;
		}
	};
}

async function runProxy(
	request: Request,
	body: ArrayBuffer,
	policy: ModelFallbackExecutionPolicy,
	requestId: string,
	account = makeCodexAccount(),
	requestMetaOverrides: Partial<RequestMeta> = {},
	comboModel?: string,
	routingAttemptLedger?: InstanceType<typeof RoutingAttemptLedger>,
	proxyContext = makeProxyContext(),
): Promise<Response | null> {
	return proxyWithAccount(
		request,
		new URL(request.url),
		account,
		makeRequestMeta(requestId, requestMetaOverrides),
		body,
		() => undefined,
		0,
		proxyContext,
		comboModel,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		routingAttemptLedger,
		policy,
	);
}

function makeHostedRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "find the source" }],
			tools: [{ type: "web_search_20250305", name: "web_search" }],
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function makeGpt56RequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "stable cached prefix",
							cache_control: { type: "ephemeral" },
						},
					],
				},
				{ role: "user", content: "current turn" },
			],
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			max_tokens: 16,
			stream: true,
		}),
	).buffer;
}

function breakpointRejectionResponse(
	message = "Unknown field: prompt_cache_breakpoint is not supported for this model",
): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function readRequestTrace(
	dir: string,
	requestId: string,
): Record<string, unknown> {
	for (const file of readdirSync(dir).filter((name) =>
		name.endsWith(".jsonl"),
	)) {
		for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			const trace = JSON.parse(line) as Record<string, unknown>;
			if (trace.phase === "request" && trace.request_id === requestId) {
				return trace;
			}
		}
	}
	throw new Error(`missing request trace for ${requestId}`);
}

describe("proxyWithAccount: Codex Responses WebSocket no-replay boundary", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalPromptCacheKey: string | undefined;
	let originalCacheKeyMode: string | undefined;
	let originalPrefixShardPercent: string | undefined;
	let originalAnthropicPrecommitTimeout: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalPromptCacheKey = process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		originalCacheKeyMode = process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		originalPrefixShardPercent =
			process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT;
		originalAnthropicPrecommitTimeout =
			process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS;
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
	});

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		if (originalPromptCacheKey === undefined) {
			delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		} else {
			process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = originalPromptCacheKey;
		}
		if (originalCacheKeyMode === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_MODE = originalCacheKeyMode;
		}
		if (originalPrefixShardPercent === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT =
				originalPrefixShardPercent;
		}
		if (originalAnthropicPrecommitTimeout === undefined) {
			delete process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS;
		} else {
			process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS =
				originalAnthropicPrecommitTimeout;
		}
		mock.restore();
	});

	it("keeps ordinary Codex WebSocket success and HTTP fallback behavior on one coherent plan per request", async () => {
		installUsageCollector();
		const plannedModels: Array<string | null> = [];
		const restorePlanner = installCountingCodexAttemptPlanner((context) => {
			plannedModels.push(context.physicalModel);
		});
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_http","model":"gpt-5.4"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"http"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_http","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		let websocketCalls = 0;
		spyOn(codexWebSocketTransport, "tryRequest").mockImplementation(
			async (input) => {
				websocketCalls++;
				if (websocketCalls > 1) return null;
				const receipt = makeReceipt(() => undefined);
				input.onFrameWritten(receipt);
				return {
					receipt,
					response: new Response(
						[
							'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ws","model":"gpt-5.4"}}\n\n',
							'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ws"}\n\n',
							'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ws","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
							"data: [DONE]\n\n",
						].join(""),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					),
				};
			},
		);

		try {
			for (const [index, expectedText] of ["ws", "http"].entries()) {
				const body = makeRequestBody();
				const response = await runProxy(
					makeRequest(body),
					body,
					makePolicy(1_000),
					`codex-plan-transport-${index}`,
				);
				expect(response?.status).toBe(200);
				expect(await response?.text()).toContain(expectedText);
			}
		} finally {
			restorePlanner();
		}

		// The Codex custom planner is proof-only. Ordinary proof-null requests keep
		// the legacy plan while retaining the same WS/HTTP transport behavior.
		expect(plannedModels).toEqual([]);
		expect(websocketCalls).toBe(2);
		expect(httpCalls).toBe(1);
	});

	it("aborts a Codex attempt when its commitment budget expires before dispatch", async () => {
		installUsageCollector();
		const provider = getProvider("codex") as
			| (NonNullable<ReturnType<typeof getProvider>> & {
					abortTurnStateAttempt(attemptId: string | null | undefined): void;
			  })
			| undefined;
		if (!provider) throw new Error("Codex provider is not registered");
		const originalAbortAttempt = provider.abortTurnStateAttempt;
		const abortedAttemptIds: Array<string | null | undefined> = [];
		provider.abortTurnStateAttempt = (attemptId) => {
			abortedAttemptIds.push(attemptId);
			originalAbortAttempt.call(provider, attemptId);
		};
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);
		const httpAttempt = mock(async () =>
			Promise.resolve(new Response("must not dispatch", { status: 500 })),
		);
		globalThis.fetch = httpAttempt as never;

		try {
			const body = makeRequestBody();
			const response = await runProxy(
				makeRequest(body),
				body,
				makePolicy(0),
				"codex-zero-commitment-budget",
			);
			expect(response).toBeNull();
		} finally {
			provider.abortTurnStateAttempt = originalAbortAttempt;
		}

		expect(websocketAttempt).not.toHaveBeenCalled();
		expect(httpAttempt).not.toHaveBeenCalled();
		expect(abortedAttemptIds).toHaveLength(1);
		expect(abortedAttemptIds[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("restores the previous Codex route stamp when an attempt is abandoned pre-dispatch", async () => {
		installUsageCollector();
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);
		const httpAttempt = mock(async () =>
			Promise.resolve(new Response("must not dispatch", { status: 500 })),
		);
		globalThis.fetch = httpAttempt as never;

		const body = makeRequestBody();
		const request = makeRequest(body);
		const meta = makeRequestMeta("codex-stamp-rollback", {
			codexTransportAttemptOrdinal: 1,
			codexLastAttemptAccountId: "codex-previous-account",
			codexLastAttemptModel: "gpt-5.4",
		});

		const response = await proxyWithAccount(
			request,
			new URL(request.url),
			makeCodexAccount(),
			meta,
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
			makePolicy(0),
		);

		expect(response).toBeNull();
		expect(websocketAttempt).not.toHaveBeenCalled();
		expect(httpAttempt).not.toHaveBeenCalled();
		// The attempt stamped itself as the request's last route before its body was
		// transformed, then died before dispatch. Left stamped, the first attempt
		// that actually reaches the wire compares itself against a route that never
		// sent and reads as an account or model fallback.
		expect(meta.codexLastAttemptAccountId).toBe("codex-previous-account");
		expect(meta.codexLastAttemptModel).toBe("gpt-5.4");
	});

	it("releases a Codex attempt whose transport fails after dispatch", async () => {
		installUsageCollector();
		const provider = getProvider("codex") as
			| (NonNullable<ReturnType<typeof getProvider>> & {
					abortTurnStateAttempt(attemptId: string | null | undefined): void;
					releaseDispatchedTurnStateAttempt(
						attemptId: string | null | undefined,
					): void;
			  })
			| undefined;
		if (!provider) throw new Error("Codex provider is not registered");
		const originalAbort = provider.abortTurnStateAttempt;
		const originalRelease = provider.releaseDispatchedTurnStateAttempt;
		const aborted: Array<string | null | undefined> = [];
		const released: Array<string | null | undefined> = [];
		provider.abortTurnStateAttempt = (attemptId) => {
			aborted.push(attemptId);
			originalAbort.call(provider, attemptId);
		};
		provider.releaseDispatchedTurnStateAttempt = (attemptId) => {
			released.push(attemptId);
			originalRelease?.call(provider, attemptId);
		};
		spyOn(codexWebSocketTransport, "tryRequest").mockResolvedValue(null);
		globalThis.fetch = mock(async () => {
			throw new Error("socket hang up");
		}) as never;

		try {
			const body = makeRequestBody();
			await runProxy(
				makeRequest(body),
				body,
				makePolicy(5_000),
				"codex-post-dispatch-failure",
			).catch(() => undefined);
		} finally {
			provider.abortTurnStateAttempt = originalAbort;
			provider.releaseDispatchedTurnStateAttempt = originalRelease;
		}

		// The send really happened, so no "never sent" tombstone may be written --
		// but the attempt must still be released. Left registered it keeps its
		// logical request's lease held, and every later turn on the scope is
		// suppressed until the attempt TTL expires.
		expect(aborted).toHaveLength(0);
		expect(released).toHaveLength(1);
		expect(released[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("treats the first dispatched Codex send as initial after a pre-dispatch abort", async () => {
		installUsageCollector();
		spyOn(codexWebSocketTransport, "tryRequest").mockResolvedValue(null);
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		// The cause never reaches the wire -- the transport sanitizer strips every
		// x-better-ccflare-* header -- so observe it where it is actually consumed.
		const causes: Array<string | null> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			causes.push(request.headers.get("x-better-ccflare-attempt-cause"));
			return originalTransformRequestBody.call(provider, request, account);
		};
		globalThis.fetch = mock(async () => {
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_initial","model":"gpt-5.4"}}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_initial","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as never;

		// One logical request, two route candidates sharing its metadata. The first
		// is abandoned before dispatch; the second is the first send that actually
		// happens, so it is this request's initial attempt, not a fallback from a
		// route that never reached upstream.
		const body = makeRequestBody();
		const meta = makeRequestMeta("codex-initial-after-abort");
		try {
			const abandoned = await proxyWithAccount(
				makeRequest(body),
				new URL(makeRequest(body).url),
				makeCodexAccount(),
				meta,
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
				makePolicy(0),
			);
			expect(abandoned).toBeNull();

			await proxyWithAccount(
				makeRequest(body),
				new URL(makeRequest(body).url),
				makeCodexAccount(),
				meta,
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
				makePolicy(5_000),
			);
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		// The abandoned candidate incremented the attempt ordinal, which must not be
		// mistaken for evidence that a route already went out.
		expect(causes.at(-1)).toBe("initial");
	});

	it("keeps a provider-owned Codex turn-state replay on HTTP", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			const transformed = await originalTransformRequestBody.call(
				provider,
				request,
				account,
			);
			const headers = new Headers(transformed.headers);
			headers.set("x-codex-turn-state", "trusted-provider-turn-state");
			return new Request(transformed, { headers });
		};

		const upstreamTurnStates: Array<string | null> = [];
		globalThis.fetch = mock(async (request: Request) => {
			upstreamTurnStates.push(request.headers.get("x-codex-turn-state"));
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_http_turn_state","model":"gpt-5.4"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"http"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_http_turn_state","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);

		try {
			const body = makeRequestBody();
			const response = await runProxy(
				makeRequest(body, {
					"x-codex-turn-state": "client-controlled-turn-state",
				}),
				body,
				makePolicy(1_000),
				"codex-http-turn-state-only",
			);
			expect(response?.status).toBe(200);
			expect(await response?.text()).toContain("http");
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(websocketAttempt).not.toHaveBeenCalled();
		expect(upstreamTurnStates).toEqual(["trusted-provider-turn-state"]);
	});

	it("stamps a same-account model fallback before its request is transformed", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		// The Codex provider registers each attempt's turn-state context during the
		// transform, reading the attempt identity the proxy stamped into these
		// headers. Capture what every transform actually observes.
		const transformedAttempts: Array<{
			attemptId: string | null;
			cause: string | null;
		}> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			transformedAttempts.push({
				attemptId: request.headers.get("x-better-ccflare-attempt-id"),
				cause: request.headers.get("x-better-ccflare-attempt-cause"),
			});
			return originalTransformRequestBody.call(provider, request, account);
		};

		const upstreamModels: string[] = [];
		globalThis.fetch = mock(async (request: Request) => {
			const body = (await request.clone().json()) as { model?: string };
			upstreamModels.push(body.model ?? "");
			if (upstreamModels.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: "model_not_found",
							message: "The model gpt-5.4 does not exist",
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fallback","model":"gpt-5.4-codex"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fallback"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fallback","model":"gpt-5.4-codex","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		spyOn(codexWebSocketTransport, "tryRequest").mockResolvedValue(null);

		try {
			const body = makeRequestBody();
			await runProxy(
				makeRequest(body),
				body,
				// Deliberately not `makePolicy`: that policy forwards a
				// model-unavailable response instead of falling back in place, which
				// is the path under test here.
				{ routeCandidateId: "codex-model-fallback-route" },
				"codex-model-fallback-attempt-stamp",
				makeCodexAccount({
					model_fallbacks: JSON.stringify({ sonnet: "gpt-5.4-codex" }),
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("UsageCollector not initialized")) throw error;
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(upstreamModels).toEqual(["gpt-5.4", "gpt-5.4-codex"]);
		expect(transformedAttempts).toHaveLength(2);
		expect(transformedAttempts[0]?.cause).toBe("initial");
		expect(transformedAttempts[0]?.attemptId).toBeTruthy();
		// The fallback must reach the transform already stamped. Stamping it
		// afterwards registered the attempt under an identity its response never
		// carries, and hid the route change behind the default `initial` cause.
		expect(transformedAttempts[1]?.cause).toBe("model_fallback");
		expect(transformedAttempts[1]?.attemptId).toBeTruthy();
		expect(transformedAttempts[1]?.attemptId).not.toBe(
			transformedAttempts[0]?.attemptId,
		);
	});

	it("classifies a Codex re-entry as a retry only when account and model both hold", async () => {
		installUsageCollector();
		const provider = getProvider("codex");
		if (!provider?.transformRequestBody) {
			throw new Error("Codex provider transformation is unavailable");
		}
		const causes: Array<string | null> = [];
		const originalTransformRequestBody = provider.transformRequestBody;
		provider.transformRequestBody = async (request, account) => {
			causes.push(request.headers.get("x-better-ccflare-attempt-cause"));
			return originalTransformRequestBody.call(provider, request, account);
		};
		globalThis.fetch = mock(
			async () =>
				new Response(
					[
						'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_reentry","model":"gpt-5.4"}}\n\n',
						'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
						'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_reentry","model":"gpt-5.4","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
						"data: [DONE]\n\n",
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		spyOn(codexWebSocketTransport, "tryRequest").mockResolvedValue(null);

		const account = makeCodexAccount();
		try {
			// A second physical send on the same account and model: the bounded 401
			// retry after a credential refresh looks exactly like this. Its turn
			// state is still valid, so it must not be classified as a route change.
			const sameAccountBody = makeRequestBody();
			await runProxy(
				makeRequest(sameAccountBody),
				sameAccountBody,
				makePolicy(5_000),
				"codex-reentry-same-account",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: account.id,
					codexLastAttemptModel: "gpt-5.4",
				},
			);
			// Same account, different physical model: a deferred cross-family
			// fallback re-enters exactly like this. The route changed, so turn state
			// must be invalidated rather than replayed.
			const sameAccountOtherModelBody = makeRequestBody();
			await runProxy(
				makeRequest(sameAccountOtherModelBody),
				sameAccountOtherModelBody,
				makePolicy(5_000),
				"codex-reentry-same-account-other-model",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: account.id,
					codexLastAttemptModel: "gpt-5.4-codex",
				},
			);
			const otherAccountBody = makeRequestBody();
			await runProxy(
				makeRequest(otherAccountBody),
				otherAccountBody,
				makePolicy(5_000),
				"codex-reentry-other-account",
				account,
				{
					codexTransportAttemptOrdinal: 1,
					codexLastAttemptAccountId: "codex-some-other-account",
					codexLastAttemptModel: "gpt-5.4",
				},
			);
		} finally {
			provider.transformRequestBody = originalTransformRequestBody;
		}

		expect(causes).toEqual([
			"other_retry",
			"model_fallback",
			"account_failover",
		]);
	});

	it("counts a non-hosted WebSocket frame at its pre-write transport boundary", async () => {
		installUsageCollector();
		const ledger = new RoutingAttemptLedger();
		const fetchMock = mock(
			async () => new Response("unexpected HTTP fallback"),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
		spyOn(codexWebSocketTransport, "tryRequest").mockImplementation(
			async (input) => {
				input.onBeforeFrameSend?.();
				input.onBeforeFrameWrite?.();
				const receipt = makeReceipt(() => undefined);
				input.onFrameWritten?.(receipt);
				return {
					receipt,
					response: new Response(
						[
							'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ws_budget","model":"gpt-5.4"}}\n\n',
							'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ws_budget","model":"gpt-5.4","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
							"data: [DONE]\n\n",
						].join(""),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					),
				};
			},
		);

		const body = makeRequestBody();
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-ws-physical-boundary",
			undefined,
			undefined,
			undefined,
			ledger,
		);

		expect(response?.status).toBe(200);
		expect(ledger.physicalAttemptCount).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a hosted WebSocket undispatched when the physical budget vetoes pre-write", async () => {
		installUsageCollector();
		const ledger = new RoutingAttemptLedger();
		for (let attempt = 0; attempt < MAX_REQUEST_PHYSICAL_ATTEMPTS; attempt++) {
			ledger.recordPhysicalAttempt();
		}
		const proxyContext = makeProxyContext();
		proxyContext.serverToolReplay = HOSTED_REPLAY_RUNTIME as never;
		const fetchMock = mock(async () => new Response("unexpected HTTP rescue"));
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
		let frameWrites = 0;
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onBeforeFrameSend?.();
			input.onBeforeFrameWrite?.();
			frameWrites++;
			return null;
		});

		const body = makeHostedRequestBody();
		const request = makeRequest(body, {
			authorization: HOSTED_REPLAY_CREDENTIAL,
			"x-claude-code-session-id": HOSTED_REPLAY_LINEAGE,
		});
		const requirements = deriveServerToolRequirement(
			JSON.parse(new TextDecoder().decode(body)),
		);
		if (!requirements) throw new Error("expected hosted-search requirements");
		const meta = makeRequestMeta("codex-ws-hosted-physical-budget", {
			serverToolRequirements: requirements,
		});
		expect(
			await bindRequestPrivateServerToolReplay(meta, HOSTED_REPLAY_RUNTIME, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId(
					"model-route-caller",
					HOSTED_REPLAY_CREDENTIAL,
				),
				lineage: HOSTED_REPLAY_LINEAGE,
			}),
		).toBe(true);

		await expect(
			proxyWithAccount(
				request,
				new URL(request.url),
				makeCodexAccount({
					model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
				}),
				meta,
				body,
				() => undefined,
				0,
				proxyContext,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
				{
					...makePolicy(500),
					recomputeServerToolCapability: true,
				},
			),
		).rejects.toBeInstanceOf(PhysicalAttemptBudgetExceededError);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(frameWrites).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ledger.hostedDispatchState).toBe("undispatched");
		expect(ledger.physicalAttemptCount).toBe(MAX_REQUEST_PHYSICAL_ATTEMPTS);
	});

	it("claims before response.create and never rescues an ambiguous hosted write to HTTP", async () => {
		installUsageCollector();
		const ledger = new RoutingAttemptLedger();
		const proxyContext = makeProxyContext();
		proxyContext.serverToolReplay = HOSTED_REPLAY_RUNTIME as never;
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP rescue", { status: 500 });
		});
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onBeforeFrameSend?.();
			input.onBeforeFrameWrite?.();
			throw new Error("ambiguous response.create write");
		});

		const body = makeHostedRequestBody();
		const request = makeRequest(body, {
			authorization: HOSTED_REPLAY_CREDENTIAL,
			"x-claude-code-session-id": HOSTED_REPLAY_LINEAGE,
		});
		const requirements = deriveServerToolRequirement(
			JSON.parse(new TextDecoder().decode(body)),
		);
		if (!requirements) throw new Error("expected hosted-search requirements");
		const meta = makeRequestMeta("codex-ws-hosted-ambiguous-write", {
			serverToolRequirements: requirements,
		});
		expect(
			await bindRequestPrivateServerToolReplay(meta, HOSTED_REPLAY_RUNTIME, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId(
					"model-route-caller",
					HOSTED_REPLAY_CREDENTIAL,
				),
				lineage: HOSTED_REPLAY_LINEAGE,
			}),
		).toBe(true);
		const policy: ModelFallbackExecutionPolicy = {
			...makePolicy(500),
			recomputeServerToolCapability: true,
		};
		const response = await proxyWithAccount(
			request,
			new URL(request.url),
			makeCodexAccount({
				model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
			}),
			meta,
			body,
			() => undefined,
			0,
			proxyContext,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			policy,
		);

		expect(response?.status).toBe(502);
		expect(await response?.json()).toMatchObject({
			error: { code: "server_tool_dispatch_terminal" },
		});

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
		expect(ledger.physicalAttemptCount).toBe(0);
	});

	it("keeps WebSocket function-call lineages distinct when sibling conversations share a prefix shard", async () => {
		installUsageCollector();
		process.env.CCFLARE_CODEX_CACHE_KEY_PREFIX_SHARD_PERCENT = "100";
		const upstreamConversationHeaders: Array<string | null> = [];
		globalThis.fetch = mock(async (request: Request) => {
			upstreamConversationHeaders.push(
				request.headers.get("x-better-ccflare-codex-conversation-id"),
			);
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","model":"gpt-5.4"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		const attempts: Array<{
			conversationIdentity: string | null | undefined;
			logicalModelFamily: string | null;
			promptCacheKey: string | undefined;
		}> = [];
		spyOn(codexWebSocketTransport, "tryRequest").mockImplementation(
			async (input) => {
				const payload = (await input.request.clone().json()) as {
					prompt_cache_key?: string;
				};
				attempts.push({
					conversationIdentity: (
						input as typeof input & { conversationIdentity?: string | null }
					).conversationIdentity,
					logicalModelFamily: input.request.headers.get(
						CODEX_LOGICAL_MODEL_FAMILY_HEADER,
					),
					promptCacheKey: payload.prompt_cache_key,
				});
				return null;
			},
		);

		for (let index = 0; index < 96; index++) {
			const messages = [
				{ role: "user", content: `sibling task ${index}` },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: `tool-lineage-sibling-${index}`,
							name: "Lookup",
							input: { value: `sibling-${index}` },
						},
					],
				},
			];
			const body = makeConversationRequestBody(messages);
			const response = await runProxy(
				makeRequest(body),
				body,
				makePolicy(1_000),
				`codex-ws-conversation-${index}`,
			);
			expect(response?.status).toBe(200);
			await response?.text();
		}

		expect(attempts).toHaveLength(96);
		expect(attempts.map((attempt) => attempt.logicalModelFamily)).toEqual(
			Array(96).fill(null),
		);
		expect(upstreamConversationHeaders).toEqual(Array(96).fill(null));
		const attemptsByKey = new Map<string, typeof attempts>();
		for (const attempt of attempts) {
			const key = attempt.promptCacheKey;
			expect(key).toMatch(/^[0-9a-f]{64}$/);
			attemptsByKey.set(key ?? "", [
				...(attemptsByKey.get(key ?? "") ?? []),
				attempt,
			]);
		}
		expect(attemptsByKey.size).toBe(8);
		const siblings = [...attemptsByKey.values()].find(
			(group) => group.length > 1,
		);
		expect(siblings).toBeDefined();
		expect(siblings?.[0]?.conversationIdentity).toMatch(/^[0-9a-f]{64}$/);
		expect(siblings?.[1]?.conversationIdentity).toMatch(/^[0-9a-f]{64}$/);
		expect(siblings?.[1]?.conversationIdentity).not.toBe(
			siblings?.[0]?.conversationIdentity,
		);
	});

	it("keeps Fable effort through an Opus-overridden WebSocket request without leaking the carrier", async () => {
		installUsageCollector();
		let observedWebSocketRequest: Request | null = null;
		spyOn(codexWebSocketTransport, "tryRequest").mockImplementation(
			async (input) => {
				observedWebSocketRequest = input.request.clone();
				return null;
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(
					[
						'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","model":"gpt-5.6-sol"}}\n\n',
						'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
						'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.6-sol","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
						"data: [DONE]\n\n",
					].join(""),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
		);

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-fable-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
				stream: true,
			}),
		).buffer;
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-ws-fable-opus-override",
			makeCodexAccount({
				model_mappings: JSON.stringify({
					fable: "gpt-5.6-sol",
					opus: "gpt-5.6-sol",
				}),
			}),
			{
				originalModel: "claude-fable-5",
				appliedModel: "claude-fable-5",
			},
			"claude-opus-5",
		);
		expect(response?.status).toBe(200);
		await response?.text();

		expect(observedWebSocketRequest).not.toBeNull();
		const webSocketRequest = observedWebSocketRequest as unknown as Request;
		const payload = (await webSocketRequest.clone().json()) as {
			model?: string;
			reasoning?: { effort?: string };
		};
		expect(payload.model).toBe("gpt-5.6-sol");
		expect(payload.reasoning).toEqual({ effort: "xhigh" });
		expect(
			webSocketRequest.headers.get(CODEX_LOGICAL_MODEL_FAMILY_HEADER),
		).toBeNull();
	});

	it("aborts the WebSocket transport signal when terminal draining reaches its deadline", async () => {
		installUsageCollector();
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
		let webSocketSignal: AbortSignal | undefined;
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP fallback", { status: 500 });
		});
		const receipt = makeReceipt(() => undefined);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			webSocketSignal = input.signal;
			input.onFrameWritten?.(receipt);
			return {
				receipt,
				response: new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
								),
							);
							// Stay open until terminal recovery's drain deadline.
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
			};
		});

		try {
			const body = makeRequestBody();
			const response = await runProxy(
				makeRequest(body),
				body,
				makePolicy(1_000),
				"codex-ws-drain-abort",
			);
			expect(response).not.toBeNull();
			expect(websocketAttempt).toHaveBeenCalledTimes(1);
			expect(httpCalls).toBe(0);
			expect(webSocketSignal).toBeDefined();
			expect(webSocketSignal?.aborted).toBe(false);
			const reader = response?.body?.getReader();
			expect(reader).toBeDefined();
			await expect(reader?.read()).resolves.toMatchObject({ done: false });
			await reader?.cancel("client disconnect");

			expect(webSocketSignal?.aborted).toBe(true);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("keeps the private attempt deadline for pre-write WebSocket fallback and HTTP", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async (input) => {
			httpCalls++;
			const signal = input instanceof Request ? input.signal : undefined;
			await new Promise<never>((_resolve, reject) => {
				const rejectFromAbort = () => reject(signal?.reason);
				signal?.addEventListener("abort", rejectFromAbort, { once: true });
				if (signal?.aborted) rejectFromAbort();
			});
		});

		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);

		const body = makeRequestBody();
		const request = makeRequest(body);
		const startedAt = Date.now();
		const response = await runProxy(
			request,
			body,
			makePolicy(350, { attemptDeadlineMs: 90, isFinalAttempt: false }),
			"codex-ws-prewrite-http-deadline",
		);
		const elapsedMs = Date.now() - startedAt;

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(60);
		expect(elapsedMs).toBeLessThan(250);
		expect(response).toBeNull();
	});

	it("does not replay over HTTP when a structurally-started WebSocket stream reaches its semantic deadline", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
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
				cancel() {
					upstreamCancels++;
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
		const startedAt = Date.now();
		const response = await runProxy(
			request,
			body,
			makePolicy(180),
			"codex-ws-structural-stall",
		);
		const elapsedMs = Date.now() - startedAt;

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual(["semantic_stall"]);
		expect(upstreamCancels).toBe(0);
		expect(elapsedMs).toBeGreaterThanOrEqual(140);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(504);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_semantic_stall" },
		});
	});

	it("allows event-silent WebSocket reasoning past protocol idle to commit before the request-wide deadline", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			const encoder = new TextEncoder();
			let successTimer: ReturnType<typeof setTimeout> | undefined;
			const eventSilentReasoning = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_silent_reasoning","model":"gpt-5.4"}}\n\n',
							),
						);
						successTimer = setTimeout(() => {
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"eventual output"}\n\n',
										'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_silent_reasoning","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
										"data: [DONE]\n\n",
									].join(""),
								),
							);
							controller.close();
						}, 120);
					},
					cancel() {
						if (successTimer !== undefined) clearTimeout(successTimer);
						upstreamCancels++;
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
			return { response: eventSilentReasoning, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(350),
			"codex-ws-event-silent-reasoning",
		);
		const responseBody = await response?.text();

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual([]);
		expect(upstreamCancels).toBe(0);
		expect(receipt.stickyHttp).toBe(false);
		expect(response?.status).toBe(200);
		expect(responseBody).toContain('"text":"eventual output"');
	});

	it("promotes a written non-final WebSocket attempt to the request-wide commitment deadline", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			const encoder = new TextEncoder();
			let successTimer: ReturnType<typeof setTimeout> | undefined;
			const delayedWinner = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_promoted","model":"gpt-5.4"}}\n\n',
							),
						);
						successTimer = setTimeout(() => {
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"promoted winner"}\n\n',
										'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_promoted","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
										"data: [DONE]\n\n",
									].join(""),
								),
							);
							controller.close();
						}, 160);
					},
					cancel() {
						if (successTimer !== undefined) clearTimeout(successTimer);
						upstreamCancels++;
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
			return { response: delayedWinner, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(350, { attemptDeadlineMs: 90, isFinalAttempt: false }),
			"codex-ws-promote-non-final-attempt",
		);
		const responseBody = await response?.text();

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual([]);
		expect(upstreamCancels).toBe(0);
		expect(receipt.stickyHttp).toBe(false);
		expect(response?.status).toBe(200);
		expect(responseBody).toContain('"text":"promoted winner"');
	});

	it("preserves downstream cancellation after promoting the written WebSocket deadline", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const routeAbort = new AbortController();
		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		let webSocketSignal: AbortSignal | undefined;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			webSocketSignal = input.signal;
			input.onFrameWritten?.(receipt);
			const encoder = new TextEncoder();
			return {
				receipt,
				response: new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancelled","model":"gpt-5.4"}}\n\n',
								),
							);
						},
						cancel() {
							upstreamCancels++;
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
			};
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const proxyPromise = runProxy(
			request,
			body,
			makePolicy(350, {
				attemptDeadlineMs: 90,
				isFinalAttempt: false,
				routeAbort,
			}),
			"codex-ws-promoted-downstream-cancel",
		);
		const abortTimer = setTimeout(
			() =>
				routeAbort.abort(
					new DOMException("downstream cancelled", "AbortError"),
				),
			130,
		);
		let thrown: unknown;
		try {
			await proxyPromise;
		} catch (error) {
			thrown = error;
		} finally {
			clearTimeout(abortTimer);
		}

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual([]);
		expect(webSocketSignal?.aborted).toBe(true);
		expect(upstreamCancels).toBe(0);
		expect(receipt.stickyHttp).toBe(false);
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).name).toBe("AnthropicPreCommitAbortedError");
	});

	it("terminates once when the request-wide deadline expires during frame-write promotion", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const encoder = new TextEncoder();
		const structurallyStarted = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_expired_promotion","model":"gpt-5.4"}}\n\n',
						),
					);
				},
				cancel() {
					upstreamCancels++;
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
			// Advance wall time without advancing the still-pending private timer.
			// Promotion must synchronously abort the same controller at the expired
			// request-wide boundary, then the normal gate owns one final 504.
			setSystemTime(Date.now() + 5_000);
			try {
				input.onFrameWritten?.(receipt);
				expect(input.signal.aborted).toBe(true);
			} finally {
				setSystemTime();
			}
			return { response: structurallyStarted, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(1_000, {
				attemptDeadlineMs: 500,
				isFinalAttempt: false,
			}),
			"codex-ws-expired-frame-promotion",
		);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual(["semantic_stall"]);
		expect(upstreamCancels).toBe(0);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(504);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_semantic_stall" },
		});
	});

	it("does not treat a transport-first structural output item as semantic progress", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "40";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		let upstreamCancels = 0;
		let webSocketSignal: AbortSignal | undefined;
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const encoder = new TextEncoder();
		const structurallyStarted = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							[
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_structural_item","model":"gpt-5.4"}}\n\n',
								'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_structural","type":"message","role":"assistant","content":[]}}\n\n',
							].join(""),
						),
					);
				},
				cancel() {
					upstreamCancels++;
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
			webSocketSignal = input.signal;
			input.onFrameWritten?.(receipt);
			return { response: structurallyStarted, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const startedAt = Date.now();
		const response = await runProxy(
			request,
			body,
			makePolicy(180, { attemptDeadlineMs: 90, isFinalAttempt: false }),
			"codex-ws-structural-output-item",
		);
		const elapsedMs = Date.now() - startedAt;

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteCategories).toEqual(["semantic_stall"]);
		expect(webSocketSignal?.aborted).toBe(true);
		expect(upstreamCancels).toBe(0);
		expect(elapsedMs).toBeGreaterThanOrEqual(140);
		expect(receipt.stickyHttp).toBe(true);
		expect(response?.status).toBe(504);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_semantic_stall" },
		});
	});

	it("keeps a progressing WebSocket response alive across the protocol-idle window without HTTP replay", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "200";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		let postWriteMarks = 0;
		const receipt = makeReceipt(() => postWriteMarks++);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			const encoder = new TextEncoder();
			let progressTimer: ReturnType<typeof setTimeout> | undefined;
			let successTimer: ReturnType<typeof setTimeout> | undefined;
			const stopTimers = () => {
				if (progressTimer !== undefined) clearTimeout(progressTimer);
				if (successTimer !== undefined) clearTimeout(successTimer);
			};
			const progressing = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_progress","model":"gpt-5.4"}}\n\n',
							),
						);
						progressTimer = setTimeout(() => {
							controller.enqueue(
								encoder.encode(
									'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_progress","model":"gpt-5.4"}}\n\n',
								),
							);
						}, 140);
						successTimer = setTimeout(() => {
							stopTimers();
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"still alive"}\n\n',
										'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_progress","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
										"data: [DONE]\n\n",
									].join(""),
								),
							);
							controller.close();
						}, 280);
					},
					cancel() {
						stopTimers();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
			return { response: progressing, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			makePolicy(500),
			"codex-ws-progress-liveness",
		);
		const responseBody = await response?.text();

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteMarks).toBe(0);
		expect(receipt.stickyHttp).toBe(false);
		expect(response?.status).toBe(200);
		expect(responseBody).toContain('event: ping\ndata: {"type":"ping"}\n\n');
		expect(responseBody).not.toContain("event: response.in_progress");
		expect(responseBody).toContain('"text":"still alive"');
	});

	it("keeps progress pings noncommitting at the absolute deadline without HTTP replay", async () => {
		installUsageCollector();
		process.env.CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS = "1300";
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});

		let postWriteMarks = 0;
		let upstreamCancels = 0;
		let progressEventsSent = 0;
		let webSocketSignal: AbortSignal | undefined;
		const receipt = makeReceipt(() => postWriteMarks++);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			webSocketSignal = input.signal;
			input.onFrameWritten?.(receipt);
			const encoder = new TextEncoder();
			let progressTimer: ReturnType<typeof setInterval> | undefined;
			const progressingWithoutContent = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						progressEventsSent++;
						controller.enqueue(
							encoder.encode(
								[
									'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_progress_deadline","model":"gpt-5.4"}}\n\n',
									'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_progress_deadline","model":"gpt-5.4"}}\n\n',
								].join(""),
							),
						);
						progressTimer = setInterval(() => {
							progressEventsSent++;
							controller.enqueue(
								encoder.encode(
									'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_progress_deadline","model":"gpt-5.4"}}\n\n',
								),
							);
						}, 1_100);
					},
					cancel() {
						if (progressTimer !== undefined) clearInterval(progressTimer);
						upstreamCancels++;
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
			return { response: progressingWithoutContent, receipt };
		});

		const body = makeRequestBody();
		const request = makeRequest(body);
		const startedAt = Date.now();
		const response = await runProxy(
			request,
			body,
			makePolicy(1_600),
			"codex-ws-progress-absolute-deadline",
		);
		const elapsedMs = Date.now() - startedAt;

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(postWriteMarks).toBe(1);
		expect(receipt.stickyHttp).toBe(true);
		await waitForCondition(() => webSocketSignal?.aborted === true);
		expect(webSocketSignal?.aborted).toBe(true);
		expect(upstreamCancels).toBe(0);
		expect(progressEventsSent).toBeGreaterThanOrEqual(2);
		expect(elapsedMs).toBeGreaterThanOrEqual(1_450);
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

	it("vetoes authoritative context-overflow replay to a safe xAI candidate after response.create was written", async () => {
		installUsageCollector();
		let httpOrXaiCalls = 0;
		globalThis.fetch = mock(async () => {
			httpOrXaiCalls++;
			return new Response("unexpected HTTP or xAI replay", { status: 500 });
		});

		const postWriteCategories: string[] = [];
		const receipt = makeReceipt((category) =>
			postWriteCategories.push(category),
		);
		const encoder = new TextEncoder();
		const authoritativeOverflow = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							[
								'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_context_overflow","model":"gpt-5.4"}}\n\n',
								'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_context_overflow","model":"gpt-5.4","status":"failed","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Input is too large"}}}\n\n',
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
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			return { response: authoritativeOverflow, receipt };
		});
		const canReplayToXai = mock(() => true);
		const xaiCandidatePolicy: ModelFallbackExecutionPolicy = {
			...makePolicy(500, { isFinalAttempt: false }),
			canReplayContextOverflow: canReplayToXai,
		};

		const body = makeRequestBody();
		const request = makeRequest(body);
		const response = await runProxy(
			request,
			body,
			xaiCandidatePolicy,
			"codex-ws-context-overflow-xai-candidate",
		);

		expect(canReplayToXai).toHaveBeenCalled();
		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpOrXaiCalls).toBe(0);
		expect(postWriteCategories).toEqual(["post_write_error"]);
		expect(receipt.stickyHttp).toBe(true);
		expect(response).not.toBeNull();
		expect(response?.status).toBe(502);
		expect(await response?.json()).toMatchObject({
			error: { code: "codex_websocket_post_write_error" },
		});
	});
});

describe("proxyWithAccount: GPT-5.6 explicit breakpoint compatibility retry", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalPercent: string | undefined;
	let originalCacheKeyMode: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalPercent =
			process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT;
		originalCacheKeyMode = process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "100";
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
		resetCodexExplicitBreakpointSuppressionsForTest();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalPercent === undefined) {
			delete process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT;
		} else {
			process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT =
				originalPercent;
		}
		delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		if (originalCacheKeyMode === undefined) {
			delete process.env.CCFLARE_CODEX_CACHE_KEY_MODE;
		} else {
			process.env.CCFLARE_CODEX_CACHE_KEY_MODE = originalCacheKeyMode;
		}
		delete process.env.CCFLARE_CODEX_TRACE_DIR;
		resetCodexExplicitBreakpointSuppressionsForTest();
		mock.restore();
	});

	it("gates and traces the breakpoint from the trusted cache-replay physical model", async () => {
		installUsageCollector();
		for (const testCase of [
			{
				name: "demotion",
				mappedModel: "gpt-5.6-sol",
				physicalModel: "gpt-5.5",
				expectsBreakpoint: false,
				expectedCanary: "ineligible",
				expectedAction: "skip_non_gpt56",
			},
			{
				name: "promotion",
				mappedModel: "gpt-5.5",
				physicalModel: "gpt-5.6-sol",
				expectsBreakpoint: true,
				expectedCanary: "treatment",
				expectedAction: "placed_source_marker",
			},
		] as const) {
			const traceDir = mkdtempSync(join(tmpdir(), "codex-breakpoint-replay-"));
			try {
				process.env.CCFLARE_CODEX_TRACE_DIR = traceDir;
				const outbound: Array<{
					body: Record<string, unknown>;
					finalModelHeader: string | null;
				}> = [];
				globalThis.fetch = mock(async (request: Request) => {
					outbound.push({
						body: (await request.clone().json()) as Record<string, unknown>,
						finalModelHeader: request.headers.get(
							"x-better-ccflare-final-model",
						),
					});
					return new Response(
						JSON.stringify({
							id: `response-${testCase.name}`,
							model: testCase.physicalModel,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				});

				const account = makeCodexAccount({
					id: `codex-replay-${testCase.name}`,
					name: `codex-replay-${testCase.name}`,
					model_mappings: JSON.stringify({ sonnet: testCase.mappedModel }),
				});
				const body = makeGpt56RequestBody();
				const requestId = `codex-breakpoint-replay-${testCase.name}`;
				const response = await runProxy(
					makeRequest(body, {
						[CACHE_REPLAY_MODEL_HEADER]: testCase.physicalModel,
					}),
					body,
					makePolicy(1_000),
					requestId,
					account,
				);

				expect(response?.status).toBe(200);
				expect(outbound).toHaveLength(1);
				expect(outbound[0]?.body.model).toBe(testCase.physicalModel);
				expect(outbound[0]?.finalModelHeader).toBeNull();
				expect(
					JSON.stringify(outbound[0]?.body).includes("prompt_cache_breakpoint"),
				).toBe(testCase.expectsBreakpoint);

				const trace = readRequestTrace(traceDir, requestId);
				expect(trace.model_out).toBe(testCase.physicalModel);
				expect(trace.explicit_breakpoint_canary).toBe(testCase.expectedCanary);
				expect(trace.explicit_breakpoint_action).toBe(testCase.expectedAction);
			} finally {
				delete process.env.CCFLARE_CODEX_TRACE_DIR;
				rmSync(traceDir, { recursive: true, force: true });
			}
		}
	});

	it("retries one pre-content 400 without the marker and suppresses that account/model", async () => {
		installUsageCollector();
		process.env.CCFLARE_CODEX_CACHE_KEY_MODE = "session";
		const websocketAttempts: Array<{
			conversationIdentity: string | null | undefined;
			reservedHeaderNames: string[];
		}> = [];
		spyOn(codexWebSocketTransport, "tryRequest").mockImplementation(
			async (input) => {
				websocketAttempts.push({
					conversationIdentity: (
						input as typeof input & {
							conversationIdentity?: string | null;
						}
					).conversationIdentity,
					reservedHeaderNames: [...input.request.headers.keys()].filter(
						(name) => name.startsWith("x-better-ccflare-"),
					),
				});
				return null;
			},
		);
		const outbound: Array<Record<string, unknown>> = [];
		const httpReservedHeaderNames: string[][] = [];
		globalThis.fetch = mock(async (request: Request) => {
			httpReservedHeaderNames.push(
				[...request.headers.keys()].filter((name) =>
					name.startsWith("x-better-ccflare-"),
				),
			);
			outbound.push((await request.clone().json()) as Record<string, unknown>);
			if (outbound.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							message:
								"Unknown field: prompt_cache_breakpoint is not supported for this model",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","model":"gpt-5.6-sol"}}\n\n',
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.6-sol","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}}\n\n',
					"data: [DONE]\n\n",
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const body = makeConversationRequestBody([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "stable cached prefix",
						cache_control: { type: "ephemeral" },
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-lineage-breakpoint-retry",
						name: "Lookup",
						input: { value: "retry" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-lineage-breakpoint-retry",
						content: "retry result",
					},
				],
			},
		]);
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-400",
			account,
		);

		expect(outbound).toHaveLength(2);
		expect(websocketAttempts).toHaveLength(2);
		expect(websocketAttempts[0]?.conversationIdentity).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(websocketAttempts[1]?.conversationIdentity).toBe(
			websocketAttempts[0]?.conversationIdentity,
		);
		expect(
			websocketAttempts.map((attempt) => attempt.reservedHeaderNames),
		).toEqual([[], []]);
		expect(httpReservedHeaderNames).toEqual([[], []]);
		expect(response?.status).toBe(200);
		expect(JSON.stringify(outbound[0])).toContain("prompt_cache_breakpoint");
		expect(JSON.stringify(outbound[1])).not.toContain(
			"prompt_cache_breakpoint",
		);
		expect(outbound[1]?.prompt_cache_key).toBe(outbound[0]?.prompt_cache_key);
		const firstWithoutMarker = structuredClone(outbound[0]);
		for (const item of firstWithoutMarker.input as Array<
			Record<string, unknown>
		>) {
			if (!Array.isArray(item.content)) continue;
			for (const block of item.content as Array<Record<string, unknown>>) {
				delete block.prompt_cache_breakpoint;
			}
		}
		expect(outbound[1]?.input).toEqual(firstWithoutMarker.input);
		expect(outbound[1]?.tools).toEqual(outbound[0]?.tools);
		expect(
			isCodexExplicitCacheBreakpointSuppressed(account.id, "gpt-5.6-sol"),
		).toBeTrue();
	});

	it("learns a post-frame breakpoint rejection without replaying it", async () => {
		installUsageCollector();
		let httpCalls = 0;
		globalThis.fetch = mock(async () => {
			httpCalls++;
			return new Response("unexpected HTTP replay", { status: 500 });
		});
		const receipt = makeReceipt(() => undefined);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async (input) => {
			input.onFrameWritten?.(receipt);
			return {
				receipt,
				response: new Response(
					JSON.stringify({
						error: { message: "unknown field prompt_cache_breakpoint" },
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				),
			};
		});

		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const body = makeGpt56RequestBody();
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-ws-400",
			account,
		);

		expect(websocketAttempt).toHaveBeenCalledTimes(1);
		expect(httpCalls).toBe(0);
		expect(response?.status).toBe(400);
		expect(
			isCodexExplicitCacheBreakpointSuppressed(account.id, "gpt-5.6-sol"),
		).toBeTrue();

		const followUpBody = makeGpt56RequestBody();
		const followUp = await runProxy(
			makeRequest(followUpBody),
			followUpBody,
			makePolicy(1_000),
			"codex-breakpoint-ws-400-follow-up",
			account,
		);
		expect(websocketAttempt).toHaveBeenCalledTimes(2);
		expect(httpCalls).toBe(0);
		expect(followUp?.status).toBe(400);
		const followUpWireBody = await websocketAttempt.mock.calls[1]?.[0].request
			.clone()
			.json();
		expect(JSON.stringify(followUpWireBody)).not.toContain(
			"prompt_cache_breakpoint",
		);
	});

	it("never retries a generic 400 or a prompt literal without an injected marker", async () => {
		installUsageCollector();
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "0";
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return breakpointRejectionResponse();
		});
		const parsed = JSON.parse(
			new TextDecoder().decode(makeGpt56RequestBody()),
		) as Record<string, unknown>;
		const messages = parsed.messages as Array<Record<string, unknown>>;
		messages[0] = {
			role: "user",
			content:
				'The string "prompt_cache_breakpoint" is only ordinary prompt text.',
		};
		const body = new TextEncoder().encode(JSON.stringify(parsed)).buffer;
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-prompt-literal",
			account,
		);
		expect(calls).toBe(1);
		expect(response?.status).toBe(400);

		calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return new Response(
				JSON.stringify({ error: { message: "unrelated invalid parameter" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		});
		process.env.CCFLARE_CODEX_GPT56_EXPLICIT_CACHE_BREAKPOINT_PERCENT = "100";
		const genericBody = makeGpt56RequestBody();
		const generic = await runProxy(
			makeRequest(genericBody),
			genericBody,
			makePolicy(1_000),
			"codex-breakpoint-generic-400",
			account,
		);
		expect(calls).toBe(1);
		expect(generic?.status).toBe(400);
	});

	it("bounds an exact compatibility rejection to one retry", async () => {
		installUsageCollector();
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return breakpointRejectionResponse();
		});
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
		});
		const body = makeGpt56RequestBody();
		const response = await runProxy(
			makeRequest(body),
			body,
			makePolicy(1_000),
			"codex-breakpoint-second-400",
			account,
		);
		expect(calls).toBe(2);
		expect(response?.status).toBe(400);
	});
});

describe("proxyWithAccount: verified Codex 429 recovery provenance", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("awaits a verified exhausted x-codex window reset before terminal and follow-up selection consume the cooldown", async () => {
		const resetSeconds = Math.floor(Date.now() / 1000) + 120;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"x-codex-primary-used-percent": "100",
						"x-codex-primary-window-minutes": "300",
						"x-codex-primary-reset-at": String(resetSeconds),
					},
				}),
		);

		const account = makeCodexAccount();
		const persistedAccount = { ...account };
		let releasePersist!: (value: number) => void;
		let markStarted!: () => void;
		const markStartedPromise = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const persistPromise = new Promise<number>((resolve) => {
			releasePersist = resolve;
		});
		const ctx = makeProxyContext();
		ctx.asyncWriter = {
			enqueue: mock((job: () => void | Promise<void>) => {
				void job();
			}),
		} as never;
		ctx.dbOps.markAccountRateLimited = mock(
			async (_accountId: string, until: number, reason: string) => {
				markStarted();
				await persistPromise;
				persistedAccount.rate_limited_until = until;
				persistedAccount.rate_limited_reason = reason as never;
				persistedAccount.rate_limited_at = Date.now();
				persistedAccount.consecutive_rate_limits = 1;
				return 1;
			},
		) as never;

		const bodyBuffer = makeRequestBody();
		const proxyPromise = proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta("codex-verified-reset"),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		await markStartedPromise;

		const stateBeforePersist = await Promise.race([
			proxyPromise.then(() => "settled" as const),
			new Promise<"pending">((resolve) =>
				setTimeout(() => resolve("pending"), 10),
			),
		]);
		expect(stateBeforePersist).toBe("pending");

		releasePersist(1);
		expect(await proxyPromise).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledWith(
			account.id,
			expect.any(Number),
			"upstream_429_with_reset",
			// Upstream v3.5.44 added the incrementStreak parameter. A real
			// upstream 429 with a reset is genuine quota exhaustion, so the
			// consecutive-rate-limit streak must advance (unlike a 529
			// overload, which passes false).
			true,
		);
		expect(account.rate_limited_until).toBeGreaterThan(Date.now());
		expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(ctx.dbOps.saveRoutingAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				parentRequestId: "codex-verified-reset",
				accountId: account.id,
				attemptedModel: "gpt-5.4",
				modelFamily: null,
				statusCode: 429,
				reason: "upstream_429_with_reset",
				scope: "account",
				accountBenched: true,
				routeSuppressed: false,
				circuitCounted: false,
			}),
		);
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
		expect(persistedAccount.rate_limited_until).toBeGreaterThan(Date.now());

		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [account],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 1,
		});
		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).not.toBeNull();
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-recovery-scope"),
		).toBe("pool");

		const followUpCtx = makeProxyContext();
		followUpCtx.dbOps.getAllAccounts = mock(async () => [
			persistedAccount,
		]) as never;
		const followUpMeta = makeRequestMeta("codex-immediate-follow-up", {
			headers: new Headers({
				"x-better-ccflare-account-id": persistedAccount.id,
			}),
		});
		await expect(
			selectAccountsForRequest(followUpMeta, followUpCtx),
		).rejects.toBeInstanceOf(ForceRouteUnavailableError);
	});

	it("keeps a reset-less Codex 429 unverified and non-retryable", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const ctx = makeProxyContext();
		const persistedAccount = makeCodexAccount();
		ctx.asyncWriter = {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never;
		ctx.dbOps.markAccountRateLimited = mock(
			async (_accountId: string, until: number, reason: string) => {
				persistedAccount.rate_limited_until = until;
				persistedAccount.rate_limited_reason = reason as never;
				return 1;
			},
		) as never;
		const bodyBuffer = makeRequestBody();

		expect(
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				persistedAccount,
				makeRequestMeta("codex-resetless"),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			),
		).toBeNull();
		expect(persistedAccount.rate_limited_reason).toBe("model_fallback_429");

		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [persistedAccount],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 1,
		});
		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
	});
});
