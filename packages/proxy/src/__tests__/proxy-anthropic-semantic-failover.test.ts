import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_ENV,
	ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
	ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS,
	ANTHROPIC_PRECOMMIT_RESCUE_DEADLINE_ENV,
	ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
	ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
	ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_ENV,
	ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
	getAnthropicPreCommitRescueConfig,
} from "../anthropic-precommit-rescue";
import {
	ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_ENV,
	ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS,
	ANTHROPIC_POST_COMMIT_MEANINGFUL_PROGRESS_TIMEOUT_ENV,
	ANTHROPIC_POST_COMMIT_MEANINGFUL_PROGRESS_TIMEOUT_MS,
	ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
	ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS,
	ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
	ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
	getAnthropicStreamRuntimeConfig,
	isDownstreamAnthropicMessagesSse,
	isNativeAnthropicMessagesSse,
} from "../anthropic-semantic-preflight";
import { AnthropicStreamOutcomeTracker } from "../anthropic-stream-outcome";
import type { ProxyContext } from "../handlers";
import { stampInternalAutoRefreshAuth } from "../internal-probe-auth";
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
const { usageCache } = await import("@better-ccflare/providers");
const { alignRouteCandidateIds, handleProxy } = await import("../proxy");

const MODEL = "claude-opus-4-8";
const OPUS_SIBLING = "claude-opus-4-8-20260701";
const FABLE = "claude-fable-5";
const SESSION = "semantic-failover-session";
const TIMEOUT_ENV = "CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS";
const MEANINGFUL_PROGRESS_ENV = ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_ENV;
const POST_COMMIT_MEANINGFUL_PROGRESS_ENV =
	ANTHROPIC_POST_COMMIT_MEANINGFUL_PROGRESS_TIMEOUT_ENV;
const TERMINAL_GRACE_ENV = "CCFLARE_ANTHROPIC_TERMINAL_GRACE_MS";
const BUFFER_ENV = "CCFLARE_ANTHROPIC_PRECOMMIT_MAX_BUFFER_BYTES";
const SUPPRESSION_ENV = "CCFLARE_ANTHROPIC_ROUTE_SUPPRESSION_MS";
const RESCUE_ACTIVATION_ENV = ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_ENV;
const RESCUE_PING_ENV = ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_ENV;
const RESCUE_DEADLINE_ENV = ANTHROPIC_PRECOMMIT_RESCUE_DEADLINE_ENV;
const CONTEXT_ADMISSION_ENV = "CCFLARE_CONTEXT_ADMISSION";
const CODEX_PROMPT_CACHE_KEY_ENV = "CCFLARE_CODEX_PROMPT_CACHE_KEY";

const originalFetch = globalThis.fetch;
const originalEnv = new Map(
	[
		TIMEOUT_ENV,
		MEANINGFUL_PROGRESS_ENV,
		POST_COMMIT_MEANINGFUL_PROGRESS_ENV,
		TERMINAL_GRACE_ENV,
		BUFFER_ENV,
		SUPPRESSION_ENV,
		RESCUE_ACTIVATION_ENV,
		RESCUE_PING_ENV,
		RESCUE_DEADLINE_ENV,
		CONTEXT_ADMISSION_ENV,
		CODEX_PROMPT_CACHE_KEY_ENV,
	].map((name) => [name, process.env[name]] as const),
);
let restoreUsageCollector = (): void => {};
let usageHandleStart = mock((_message: unknown) => undefined);
let usageHandleChunk = mock(
	(_requestId: string, _data: Uint8Array) => undefined,
);
let usageHandleEnd = mock(async (_message: unknown) => undefined);

function installPersistingUsageCollector() {
	const savedRequests: unknown[][] = [];
	const pendingWrites = new Set<Promise<void>>();
	const collector = new usageCollectorModule.UsageCollector(
		{
			async saveRequest(...args: unknown[]): Promise<void> {
				savedRequests.push(args);
			},
			async updateAccountUsage(): Promise<void> {},
		} as never,
		{
			enqueue(task: () => Promise<void> | void): boolean {
				const pending = Promise.resolve().then(task);
				pendingWrites.add(pending);
				void pending.finally(() => pendingWrites.delete(pending));
				return true;
			},
			enqueuePayload(): boolean {
				return false;
			},
			canAcceptPayload(): boolean {
				return false;
			},
			async dispose(): Promise<void> {
				await Promise.allSettled([...pendingWrites]);
			},
		} as never,
		() => false,
		() => undefined,
	);
	const handleStart = spyOn(collector, "handleStart");
	const handleEnd = spyOn(collector, "handleEnd");
	restoreUsageCollector();
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector);
	restoreUsageCollector = () => {
		collectorSpy.mockRestore();
		collector.dispose();
	};
	return { collector, handleStart, handleEnd, savedRequests };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
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
const POSTCOMMIT_TERMINAL = [
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"complete"}}',
	"",
	"event: content_block_stop",
	'data: {"type":"content_block_stop","index":0}',
	"",
	"event: message_delta",
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
	"",
	"event: message_stop",
	'data: {"type":"message_stop"}',
	"",
	"",
].join("\n");
const PRECOMMIT_SUCCESS_AFTER_WATCHDOG = [
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"survived-180s"}}',
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
const POSTCOMMIT_PROTOCOL_ACTIVITY = [
	'event: ping\ndata: {"type":"ping"}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque"}}\n\n',
	'event: ping\ndata: {"type":"ping"}\n\n',
];

const OPENAI_STRUCTURAL_CHUNK = JSON.stringify({
	id: "chatcmpl-structural",
	model: "grok-4.3",
	choices: [
		{
			index: 0,
			delta: { role: "assistant" },
			finish_reason: null,
		},
	],
});

const CODEX_SESSION = "11111111-1111-4111-8111-111111111111";
const CODEX_STRUCTURAL_FRAMES = [
	{
		event: "response.created",
		data: { response: { id: "resp-stalled", model: "gpt-5.4" } },
	},
	{
		event: "response.in_progress",
		data: { response: { id: "resp-stalled", model: "gpt-5.4" } },
	},
] as const;

function codexEventStream(
	events: readonly { event: string; data: unknown }[],
	complete = false,
): string {
	return `${events
		.map(
			({ event, data }) =>
				`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
		)
		.join("")}${complete ? "data: [DONE]\n\n" : ""}`;
}

const CODEX_SUCCESS_STREAM = codexEventStream(
	[
		{
			event: "response.created",
			data: { response: { id: "resp-success", model: "gpt-5.4" } },
		},
		{
			event: "response.output_text.delta",
			data: { delta: "codex recovered" },
		},
		{
			event: "response.completed",
			data: {
				response: {
					id: "resp-success",
					model: "gpt-5.4",
					usage: { input_tokens: 10, output_tokens: 2 },
				},
			},
		},
	],
	true,
);

function codexFailureStream(
	errorType: "api_error" | "rate_limit_error" | "overloaded_error",
): string {
	return codexEventStream(
		[
			CODEX_STRUCTURAL_FRAMES[0],
			{
				event: "response.failed",
				data: {
					response: {
						status: "failed",
						error: {
							type: errorType,
							message: "bounded test failure",
						},
					},
				},
			},
		],
		true,
	);
}

function openAiContentChunk(text: string): string {
	return JSON.stringify({
		id: "chatcmpl-content",
		model: "grok-4.3",
		choices: [
			{
				index: 0,
				delta: { content: text },
				finish_reason: null,
			},
		],
	});
}

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

function makeXaiAccount(id: string): Account {
	return { ...makeAccount(id), provider: "xai" };
}

function makeCodexAccount(
	id: string,
	customEndpoint: string | null = null,
): Account {
	return {
		...makeAccount(id),
		provider: "codex",
		api_key: null,
		access_token: `access-${id}`,
		refresh_token: null,
		expires_at: Date.now() + 60 * 60 * 1000,
		custom_endpoint: customEndpoint,
	};
}

function stalledCodexEventStream(
	events: readonly { event: string; data: unknown }[],
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(codexEventStream(events)));
		},
		cancel() {
			onCancel();
		},
	});
}

function stalledCodexStream(onCancel: () => void): ReadableStream<Uint8Array> {
	return stalledCodexEventStream(CODEX_STRUCTURAL_FRAMES, onCancel);
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

function protocolActivityOnlyStream(
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(PRELUDE));
			activityTimer = setInterval(() => {
				controller.enqueue(
					encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'),
				);
			}, 20);
		},
		cancel() {
			if (activityTimer !== undefined) clearInterval(activityTimer);
			onCancel();
		},
	});
}

function productionCadenceStructuralStream(options: {
	onCancel: () => void;
	succeedAfterMs?: number;
}): ReadableStream<Uint8Array> {
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	let successTimer: ReturnType<typeof setTimeout> | undefined;
	const stopTimers = () => {
		if (activityTimer !== undefined) clearInterval(activityTimer);
		if (successTimer !== undefined) clearTimeout(successTimer);
		activityTimer = undefined;
		successTimer = undefined;
	};
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(PRELUDE));
			// Stay well inside the independent 120s protocol-idle limit without
			// producing text/tool progress that would commit the route.
			activityTimer = setInterval(() => {
				controller.enqueue(
					encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'),
				);
			}, 50_000);
			if (options.succeedAfterMs !== undefined) {
				successTimer = setTimeout(() => {
					stopTimers();
					controller.enqueue(encoder.encode(PRECOMMIT_SUCCESS_AFTER_WATCHDOG));
					controller.close();
				}, options.succeedAfterMs);
			}
		},
		cancel() {
			stopTimers();
			options.onCancel();
		},
	});
}

function silentPrecommitStream(
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		cancel() {
			onCancel();
		},
	});
}

function postcommitProtocolActivityOnlyStream(
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(POSTCOMMIT_STALL));
			activityTimer = setInterval(() => {
				controller.enqueue(
					encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'),
				);
			}, 20);
		},
		cancel() {
			if (activityTimer !== undefined) clearInterval(activityTimer);
			onCancel();
		},
	});
}

function postcommitProtocolActivityThenSuccessStream(
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	let activityIndex = 0;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(POSTCOMMIT_STALL));
			activityTimer = setInterval(() => {
				if (activityIndex < POSTCOMMIT_PROTOCOL_ACTIVITY.length) {
					controller.enqueue(
						encoder.encode(POSTCOMMIT_PROTOCOL_ACTIVITY[activityIndex++]),
					);
					return;
				}
				if (activityTimer !== undefined) clearInterval(activityTimer);
				activityTimer = undefined;
				controller.enqueue(encoder.encode(POSTCOMMIT_TERMINAL));
				controller.close();
			}, 30);
		},
		cancel() {
			if (activityTimer !== undefined) clearInterval(activityTimer);
			onCancel();
		},
	});
}

function stalledOpenAiStream(
	chunks: readonly string[],
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
			}
		},
		cancel() {
			onCancel();
		},
	});
}

function completedOpenAiStream(
	chunks: readonly string[],
): ReadableStream<Uint8Array> {
	return byteStream(
		`${chunks.map((chunk) => `data: ${chunk}\n\n`).join("")}data: [DONE]\n\n`,
	);
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

function exactModelExhaustedResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "An error occurred" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
			},
		},
	);
}

function extraUsageExhaustedResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
			},
		}),
		{
			status: 400,
			headers: { "content-type": "application/json" },
		},
	);
}

function cacheControlRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message:
					"cache_control: Extra inputs are not permitted for this provider",
			},
		}),
		{
			status: 400,
			headers: { "content-type": "application/json" },
		},
	);
}

function neverEndingJsonResponse(onCancel: () => void): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				onCancel();
			},
		}),
		{
			status: 400,
			headers: { "content-type": "application/json" },
		},
	);
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
	const reportCandidateSuccess = mock(
		(_meta: RequestMeta, _success: { candidateId: string }) => undefined,
	);
	const ctx = {
		strategy: {
			select: mock(async (selected: Account[]) => selected),
			peek: mock(() => accounts[0]?.id ?? null),
			reportCandidateFailure,
			reportCandidateSuccess,
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
	return { ctx, reportCandidateFailure, reportCandidateSuccess };
}

function makeRequest(
	signal?: AbortSignal,
	forcedAccountId?: string,
	stream = true,
	model = MODEL,
	userAgent?: string,
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (forcedAccountId) {
		headers["x-better-ccflare-account-id"] = forcedAccountId;
	}
	if (userAgent) headers["user-agent"] = userAgent;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			metadata: { user_id: SESSION },
			max_tokens: 16,
			stream,
		}),
		signal,
	});
}

function makeCodexRequest(
	options: { includeSessionMetadata?: boolean } = {},
): Request {
	const request = makeRequest();
	const includeSessionMetadata = options.includeSessionMetadata ?? true;
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			...(includeSessionMetadata
				? {
						metadata: {
							user_id: JSON.stringify({ session_id: CODEX_SESSION }),
						},
					}
				: {}),
			max_tokens: 16,
			stream: true,
		}),
	});
}

beforeEach(() => {
	process.env[TIMEOUT_ENV] = "20";
	delete process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV];
	process.env[TERMINAL_GRACE_ENV] = "10";
	process.env[BUFFER_ENV] = "1048576";
	process.env[SUPPRESSION_ENV] = "12345";
	process.env[RESCUE_ACTIVATION_ENV] = "1000";
	process.env[RESCUE_PING_ENV] = "10";
	process.env[RESCUE_DEADLINE_ENV] = "5000";
	usageHandleStart = mock((_message: unknown) => undefined);
	usageHandleChunk = mock((_requestId: string, _data: Uint8Array) => undefined);
	usageHandleEnd = mock(async (_message: unknown) => undefined);
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: usageHandleStart,
		handleChunk: usageHandleChunk,
		handleEnd: usageHandleEnd,
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

describe("downstream Anthropic Messages SSE routing", () => {
	it("retries one official Codex precommit api_error on the same account and model", async () => {
		const account = makeCodexAccount("codex-precommit-api-error");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
			makeCombo([account]),
		);
		const outboundBodies: Array<{
			model: string;
			prompt_cache_key: string;
			[key: string]: unknown;
		}> = [];
		const outboundAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			outboundAccounts.push(upstreamRequest.headers.get("authorization") ?? "");
			outboundBodies.push(
				(await upstreamRequest
					.clone()
					.json()) as (typeof outboundBodies)[number],
			);
			return sseResponse(
				byteStream(
					outboundBodies.length === 1
						? codexFailureStream("api_error")
						: CODEX_SUCCESS_STREAM,
				),
			);
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(outboundAccounts).toEqual([
			`Bearer access-${account.id}`,
			`Bearer access-${account.id}`,
		]);
		expect(outboundBodies).toHaveLength(2);
		const [first, retry] = outboundBodies;
		expect(first.prompt_cache_key).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(retry.prompt_cache_key).toMatch(/^ccflare-rescue-[0-9a-f]{48}$/);
		expect(retry.prompt_cache_key).not.toBe(first.prompt_cache_key);
		const { prompt_cache_key: _firstKey, ...firstPayload } = first;
		const { prompt_cache_key: _retryKey, ...retryPayload } = retry;
		expect(retryPayload).toEqual(firstPayload);
		expect(retry.model).toBe(first.model);
		expect(body).toContain('"text":"codex recovered"');
		expect(body.match(/event: message_start/g)).toHaveLength(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
	});

	it.each([
		"cache_disabled",
		"session_metadata_absent",
	] as const)("retries one official Codex precommit api_error with no cache key when %s", async (scenario) => {
		if (scenario === "cache_disabled") {
			process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
		}
		const account = makeCodexAccount(`codex-no-key-${scenario}`);
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
			makeCombo([account]),
		);
		const outboundBodies: Array<{
			model: string;
			prompt_cache_key?: string;
			[key: string]: unknown;
		}> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			outboundBodies.push(
				(await upstreamRequest
					.clone()
					.json()) as (typeof outboundBodies)[number],
			);
			return sseResponse(
				byteStream(
					outboundBodies.length === 1
						? codexFailureStream("api_error")
						: CODEX_SUCCESS_STREAM,
				),
			);
		}) as unknown as typeof fetch;

		const request = makeCodexRequest({
			includeSessionMetadata: scenario !== "session_metadata_absent",
		});
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(outboundBodies).toHaveLength(2);
		expect(outboundBodies[0].prompt_cache_key).toBeUndefined();
		expect(outboundBodies[1].prompt_cache_key).toBeUndefined();
		expect(outboundBodies[1]).toEqual(outboundBodies[0]);
		expect(body).toContain('"text":"codex recovered"');
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
	});

	it("keeps timeout cache-lane rescue disabled when no cache key exists", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "0";
		process.env[TIMEOUT_ENV] = "20";
		process.env[MEANINGFUL_PROGRESS_ENV] = "500";
		const account = makeCodexAccount("codex-timeout-no-key");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchCount++;
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as {
				prompt_cache_key?: string;
			};
			expect(body.prompt_cache_key).toBeUndefined();
			return sseResponse(stalledCodexStream(() => undefined));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(response.status).toBe(503);
		expect(fetchCount).toBe(1);
	});

	it("shares one retry cap between timeout rescue and precommit SSE retry", async () => {
		process.env[TIMEOUT_ENV] = "20";
		process.env[MEANINGFUL_PROGRESS_ENV] = "500";
		const account = makeCodexAccount("codex-shared-precommit-retry-cap");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return fetchCount === 1
				? sseResponse(stalledCodexStream(() => undefined))
				: sseResponse(byteStream(codexFailureStream("api_error")));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { attempted_routes: number };
		};

		expect(response.status).toBe(503);
		expect(fetchCount).toBe(2);
		expect(payload.error.attempted_routes).toBe(1);
	});

	it("stops after one Codex precommit api_error retry and reports one logical route failure", async () => {
		const account = makeCodexAccount("codex-precommit-api-error-twice");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
			makeCombo([account]),
		);
		const outboundKeys: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as {
				prompt_cache_key: string;
			};
			outboundKeys.push(body.prompt_cache_key);
			return sseResponse(byteStream(codexFailureStream("api_error")));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { code: string; attempted_routes: number };
		};

		expect(response.status).toBe(503);
		expect(outboundKeys).toHaveLength(2);
		expect(outboundKeys[0]).toMatch(/^ccflare-convo-/);
		expect(outboundKeys[1]).toMatch(/^ccflare-rescue-/);
		expect(payload.error).toMatchObject({
			code: "route_unavailable",
			attempted_routes: 1,
		});
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		expect(reportCandidateFailure.mock.calls[0][1]).toMatchObject({
			reason: "anthropic_precommit_transient_sse_error:api_error",
		});
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
		expect(usageHandleStart).not.toHaveBeenCalled();
		expect(usageHandleEnd).not.toHaveBeenCalled();
	});

	it("does not retry a Codex precommit api_error after its candidate budget expires", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "1000";
		process.env[RESCUE_DEADLINE_ENV] = "1000";
		const account = makeCodexAccount("codex-precommit-api-error-expired");
		const { ctx, reportCandidateFailure } = makeContext([account]);
		const realDateNow = Date.now;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							Date.now = () => realDateNow() + 60_000;
							controller.enqueue(
								encoder.encode(codexFailureStream("api_error")),
							);
							controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
			);
		}) as unknown as typeof fetch;

		let status = 0;
		try {
			const request = makeCodexRequest();
			const response = await handleProxy(request, new URL(request.url), ctx);
			status = response.status;
			await response.text();
		} finally {
			Date.now = realDateNow;
		}

		expect(status).toBe(503);
		expect(fetchCount).toBe(1);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		expect(reportCandidateFailure.mock.calls[0][1]).toMatchObject({
			reason: "anthropic_precommit_transient_sse_error:api_error",
		});
	});

	it("does not in-place retry a native Anthropic precommit api_error", async () => {
		const account = makeAccount("anthropic-precommit-api-error");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(TRANSIENT_ERROR));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(response.status).toBe(503);
		expect(fetchCount).toBe(1);
	});

	it.each([
		"custom_endpoint",
		"synthetic_internal",
	] as const)("does not in-place retry a Codex precommit api_error for %s traffic", async (scenario) => {
		const account = makeCodexAccount(
			`codex-precommit-api-error-${scenario}`,
			scenario === "custom_endpoint"
				? "https://custom-codex.example.com/v1/responses"
				: null,
		);
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(codexFailureStream("api_error")));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		if (scenario === "synthetic_internal") {
			request.headers.set("x-better-ccflare-keepalive", "true");
			stampInternalAutoRefreshAuth(request.headers);
		}
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(response.status).toBe(503);
		expect(fetchCount).toBe(1);
	});

	it("does not retry a Codex api_error after meaningful output commits", async () => {
		const account = makeCodexAccount("codex-postcommit-api-error");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				byteStream(
					codexEventStream(
						[
							CODEX_STRUCTURAL_FRAMES[0],
							{
								event: "response.output_text.delta",
								data: { delta: "committed before failure" },
							},
							{
								event: "response.failed",
								data: {
									response: {
										status: "failed",
										error: {
											type: "api_error",
											message: "failed after commit",
										},
									},
								},
							},
						],
						true,
					),
				),
			);
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchCount).toBe(1);
		expect(body).toContain('"text":"committed before failure"');
		expect(body).toContain("failed after commit");
	});

	it("retries one official Codex precommit stall on the same route with a rotated cache lane", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		const account = makeCodexAccount("codex-stall-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
			makeCombo([account]),
		);
		const outboundKeys: string[] = [];
		const outboundModels: string[] = [];
		let firstCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as {
				model: string;
				prompt_cache_key: string;
			};
			outboundKeys.push(body.prompt_cache_key);
			outboundModels.push(body.model);
			if (outboundKeys.length === 1) {
				return sseResponse(stalledCodexStream(() => firstCancelCount++));
			}
			return sseResponse(byteStream(CODEX_SUCCESS_STREAM));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(outboundKeys).toHaveLength(2);
		expect(outboundKeys[0]).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(outboundKeys[1]).toMatch(/^ccflare-rescue-[0-9a-f]{48}$/);
		expect(outboundKeys[1]).not.toBe(outboundKeys[0]);
		expect(outboundModels[1]).toBe(outboundModels[0]);
		expect(firstCancelCount).toBe(1);
		expect(body).toContain('"text":"codex recovered"');
		expect(body.match(/event: message_start/g)).toHaveLength(1);
		expect(body).not.toContain("resp-stalled");
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
	});

	it("bounds Codex cache-lane rescue to one retry and preserves fallback time", async () => {
		process.env[TIMEOUT_ENV] = "30";
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		process.env[RESCUE_DEADLINE_ENV] = "500";
		const stalled = makeCodexAccount("codex-stall-twice");
		const fallback = makeCodexAccount("codex-fallback");
		const { ctx } = makeContext(
			[stalled, fallback],
			makeCombo([stalled, fallback]),
		);
		const fetchedAccounts: string[] = [];
		let cancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const bearer = upstreamRequest.headers.get("authorization") ?? "";
			const accountId = bearer.replace(/^Bearer access-/, "");
			fetchedAccounts.push(accountId);
			if (accountId === stalled.id) {
				return sseResponse(stalledCodexStream(() => cancelCount++));
			}
			return sseResponse(byteStream(CODEX_SUCCESS_STREAM));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchedAccounts).toEqual([stalled.id, stalled.id, fallback.id]);
		expect(cancelCount).toBe(2);
		expect(response.status).toBe(200);
		expect(body).toContain('"text":"codex recovered"');
	});

	it("returns the existing 503 after exactly two stalled Codex cache-lane attempts", async () => {
		process.env[TIMEOUT_ENV] = "20";
		process.env[MEANINGFUL_PROGRESS_ENV] = "500";
		const account = makeCodexAccount("codex-both-stall");
		const { ctx } = makeContext([account]);
		const outboundKeys: string[] = [];
		let cancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as {
				prompt_cache_key: string;
			};
			outboundKeys.push(body.prompt_cache_key);
			return sseResponse(stalledCodexStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { code: string; attempted_routes: number };
		};

		expect(response.status).toBe(503);
		expect(outboundKeys).toHaveLength(2);
		expect(outboundKeys[0]).toMatch(/^ccflare-convo-/);
		expect(outboundKeys[1]).toMatch(/^ccflare-rescue-/);
		expect(cancelCount).toBe(2);
		expect(payload.error).toMatchObject({
			code: "route_unavailable",
			attempted_routes: 1,
		});
	});

	it("keeps the rescue inside the original Codex candidate deadline", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[MEANINGFUL_PROGRESS_ENV] = "200";
		const account = makeCodexAccount("codex-rescue-deadline");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		let rescueStartedAt: number | null = null;
		const startedAt = Date.now();
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchCount++;
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			if (fetchCount === 1) {
				return sseResponse(stalledCodexStream(() => undefined));
			}
			rescueStartedAt = Date.now();
			return await new Promise<Response>((_resolve, reject) => {
				const rejectOnAbort = () =>
					reject(new DOMException("candidate deadline", "AbortError"));
				if (upstreamRequest.signal.aborted) rejectOnAbort();
				else {
					upstreamRequest.signal.addEventListener("abort", rejectOnAbort, {
						once: true,
					});
				}
			});
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();
		const elapsedMs = Date.now() - startedAt;

		expect(fetchCount).toBe(2);
		expect(rescueStartedAt).not.toBeNull();
		expect((rescueStartedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(140);
		expect(
			(rescueStartedAt ?? Number.POSITIVE_INFINITY) - startedAt,
		).toBeLessThan(200);
		expect(elapsedMs).toBeGreaterThanOrEqual(150);
		expect(elapsedMs).toBeLessThan(400);
		expect(body).toContain(
			"No compatible account route committed before the recovery deadline",
		);
	});

	it("does not cache-lane retry a custom Codex endpoint", async () => {
		const account = makeCodexAccount(
			"codex-custom-stall",
			"https://custom-codex.example.com/v1/responses",
		);
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(stalledCodexStream(() => undefined));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(503);
	});

	it.each([
		"rate_limit_error",
		"overloaded_error",
	] as const)("does not in-place retry a Codex %s SSE error", async (errorType) => {
		const account = makeCodexAccount(`codex-${errorType}`);
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(codexFailureStream(errorType)));
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.text();

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(503);
	});

	it("does not cache-lane retry after Codex meaningful output commits", async () => {
		process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV] = "30";
		const account = makeCodexAccount("codex-postcommit-stall");
		const { ctx } = makeContext([account]);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				stalledCodexEventStream(
					[
						CODEX_STRUCTURAL_FRAMES[0],
						{
							event: "response.output_text.delta",
							data: { delta: "committed partial" },
						},
					],
					() => cancelCount++,
				),
			);
		}) as unknown as typeof fetch;

		const request = makeCodexRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(1);
		expect(body).toContain('"text":"committed partial"');
		expect(body).toContain("Response stalled after partial output");
	});
	it("keeps recognized Claude Code protocol-live past 180s while generic commitment and true-silence limits remain bounded", async () => {
		delete process.env[TIMEOUT_ENV];
		delete process.env[MEANINGFUL_PROGRESS_ENV];
		delete process.env[RESCUE_ACTIVATION_ENV];
		delete process.env[RESCUE_PING_ENV];
		delete process.env[RESCUE_DEADLINE_ENV];

		// Preserve production ordering while reducing 120s/135s/150s/180s/210s
		// to 1.2s/1.35s/1.5s/1.8s/2.1s. The application still receives the
		// unmodified production configuration; only timer scheduling is scaled.
		const timerScale = 100;
		const realSetTimeout = globalThis.setTimeout.bind(globalThis);
		const realSetInterval = globalThis.setInterval.bind(globalThis);
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			(callback, delay = 0, ...args) =>
				realSetTimeout(callback, Math.max(0, delay / timerScale), ...args),
		);
		const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
			(callback, delay = 0, ...args) =>
				realSetInterval(callback, Math.max(0, delay / timerScale), ...args),
		);

		const claudeAccount = makeAccount("long-precommit-claude");
		const genericAccount = makeAccount("generic-precommit-deadline");
		const silentAccount = makeAccount("true-silence-idle");
		const claudeContext = makeContext([claudeAccount]).ctx;
		const genericContext = makeContext([genericAccount]).ctx;
		const silentContext = makeContext([silentAccount]).ctx;
		let claudeCancelCount = 0;
		let genericCancelCount = 0;
		let silentCancelCount = 0;

		try {
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const upstreamRequest =
					input instanceof Request ? input : new Request(input);
				const accountId = upstreamRequest.headers.get("x-api-key")?.slice(4);
				if (accountId === claudeAccount.id) {
					return sseResponse(
						productionCadenceStructuralStream({
							onCancel: () => claudeCancelCount++,
							succeedAfterMs: 210_000,
						}),
					);
				}
				if (accountId === genericAccount.id) {
					return sseResponse(
						productionCadenceStructuralStream({
							onCancel: () => genericCancelCount++,
						}),
					);
				}
				return sseResponse(silentPrecommitStream(() => silentCancelCount++));
			}) as unknown as typeof fetch;

			const claudeRequest = makeRequest(
				undefined,
				undefined,
				true,
				MODEL,
				"claude-cli/2.1.212 (external, cli)",
			);
			const genericRequest = makeRequest(
				undefined,
				undefined,
				true,
				MODEL,
				"curl/8.0",
			);
			const silentRequest = makeRequest(
				undefined,
				undefined,
				true,
				MODEL,
				"claude-cli/2.1.212 (external, cli)",
			);

			const [claude, generic, silent] = await Promise.all(
				[
					[claudeRequest, claudeContext],
					[genericRequest, genericContext],
					[silentRequest, silentContext],
				].map(async ([request, context]) => {
					const response = await handleProxy(
						request as Request,
						new URL((request as Request).url),
						context as ProxyContext,
					);
					return { response, body: await response.text() };
				}),
			);

			expect(claude.response.status).toBe(200);
			expect(
				claude.response.headers.get("x-better-ccflare-precommit-rescue"),
			).toBe("active");
			expect(claude.body).toContain("survived-180s");
			expect(claude.body).not.toContain(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
			expect(claude.body).toContain(
				'event: message\ndata: {"type":"ping"}\n\n',
			);
			expect(claude.body).not.toContain("event: ping");
			expect(claudeCancelCount).toBe(0);

			expect(generic.response.status).toBe(200);
			expect(
				generic.response.headers.get("x-better-ccflare-precommit-rescue"),
			).toBe("active");
			expect(generic.body).toContain(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
			expect(generic.body).toContain(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME);
			expect(genericCancelCount).toBe(1);

			expect(silent.response.status).toBe(503);
			expect(
				silent.response.headers.get("x-better-ccflare-precommit-rescue"),
			).toBeNull();
			expect(silent.body).not.toContain(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
			expect(silentCancelCount).toBe(1);
		} finally {
			timeoutSpy.mockRestore();
			intervalSpy.mockRestore();
		}
	}, 10_000);

	it("adapts the outer coordinator's rescue ping for the Claude Code stream iterator", async () => {
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "1000";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const account = makeAccount("selection-blocked-claude-ping");
		const { ctx } = makeContext([account]);
		ctx.strategy.select = mock(() => new Promise<Account[]>(() => undefined));

		const request = makeRequest(
			undefined,
			undefined,
			true,
			MODEL,
			"claude-cli/2.1.212 (external, cli)",
		);
		const response = await handleProxy(request, new URL(request.url), ctx);
		const reader = response.body?.getReader();
		const first = await reader?.read();
		await reader?.cancel("test complete");

		expect(response.headers.get("x-better-ccflare-precommit-rescue")).toBe(
			"active",
		);
		expect(decoder.decode(first?.value)).toBe(
			'event: message\ndata: {"type":"ping"}\n\n',
		);
	});

	it("keeps analytics on canonical pings while adapting only downstream Claude Code bytes", async () => {
		const account = makeAccount("canonical-analytics-ping");
		const { ctx } = makeContext([account]);
		const canonicalPing = 'event: ping\ndata: {"type":"ping"}\n\n';
		globalThis.fetch = mock(async () =>
			sseResponse(byteStream(canonicalPing + SUCCESS)),
		) as unknown as typeof fetch;

		const request = makeRequest(
			undefined,
			undefined,
			true,
			MODEL,
			"claude-cli/2.1.212 (external, cli)",
		);
		const response = await handleProxy(request, new URL(request.url), ctx);
		const downstreamBody = await response.text();
		const accountedChunks = usageHandleChunk.mock.calls.map(
			([, bytes]) => bytes,
		);
		const accountedBody = accountedChunks
			.map((bytes) => decoder.decode(bytes))
			.join("");
		const outcome = new AnthropicStreamOutcomeTracker();
		for (const bytes of accountedChunks) outcome.push(bytes);

		expect(downstreamBody).toStartWith(
			'event: message\ndata: {"type":"ping"}\n\n',
		);
		expect(downstreamBody).not.toContain(canonicalPing);
		expect(accountedBody).toStartWith(canonicalPing);
		expect(outcome.finish()).toMatchObject({
			status: "completed",
			parseState: "clean",
			pingEventCount: 1,
			malformedEventCount: 0,
		});
	});

	it("starts precommit rescue while account selection is still blocked", async () => {
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const account = makeAccount("selection-blocked-a");
		const { ctx } = makeContext([account]);
		const strategySelect = mock(() => new Promise<Account[]>(() => undefined));
		ctx.strategy.select = strategySelect;
		const providerFetch = mock(async () => sseResponse(byteStream(SUCCESS)));
		globalThis.fetch = providerFetch as unknown as typeof fetch;

		const request = makeRequest();
		const routedResponse = handleProxy(request, new URL(request.url), ctx);
		const rescueDidNotStart = Symbol("rescue did not start");
		const first = await Promise.race([
			routedResponse,
			new Promise<typeof rescueDidNotStart>((resolve) =>
				setTimeout(() => resolve(rescueDidNotStart), 30),
			),
		]);

		expect(strategySelect).toHaveBeenCalledTimes(1);
		expect(first).toBeInstanceOf(Response);
		if (!(first instanceof Response)) return;
		expect(first.headers.get("x-better-ccflare-precommit-rescue")).toBe(
			"active",
		);
		expect(providerFetch).not.toHaveBeenCalled();
		const reader = first.body?.getReader();
		const ping = await reader?.read();
		expect(decoder.decode(ping?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		await reader?.cancel("test complete");
	});

	it("preserves stream:false exactly when account selection outlives rescue grace", async () => {
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		const account = makeAccount("non-stream-selection-blocked-a");
		const { ctx } = makeContext([account]);
		ctx.strategy.select = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return [account];
		});
		const expectedBody = JSON.stringify({ exact: "non-stream" });
		globalThis.fetch = mock(
			async () =>
				new Response(expectedBody, {
					status: 202,
					statusText: "Selection completed",
					headers: {
						"content-type": "application/json; charset=utf-8",
						"x-selection-path": "preserved",
					},
				}),
		) as unknown as typeof fetch;

		const request = makeRequest(undefined, undefined, false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Selection completed");
		expect(response.headers.get("x-selection-path")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(expectedBody);
	});

	it("does not translate a slow stream:false response when the streaming deadline elapses", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "20";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		delete process.env[RESCUE_DEADLINE_ENV];
		const account = makeAccount("non-stream-beyond-deadline-a");
		const { ctx } = makeContext([account]);
		const expectedBody = JSON.stringify({ exact: "slow-non-stream" });
		globalThis.fetch = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return new Response(expectedBody, {
				status: 202,
				statusText: "Slow response preserved",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"x-slow-non-stream": "preserved",
				},
			});
		}) as unknown as typeof fetch;

		const request = makeRequest(undefined, undefined, false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Slow response preserved");
		expect(response.headers.get("x-slow-non-stream")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(expectedBody);
	});

	it("preserves non-Messages routes exactly even when their body requests streaming", async () => {
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		const account = makeAccount("non-messages-selection-blocked-a");
		const { ctx } = makeContext([account]);
		ctx.strategy.select = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return [account];
		});
		const expectedBody = JSON.stringify({ exact: "non-messages" });
		globalThis.fetch = mock(
			async () =>
				new Response(expectedBody, {
					status: 207,
					statusText: "Route preserved",
					headers: {
						"content-type": "application/json; charset=utf-8",
						"x-non-messages-path": "preserved",
					},
				}),
		) as unknown as typeof fetch;
		const request = new Request("https://proxy.local/v1/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: MODEL,
				prompt: "hello",
				max_tokens: 16,
				stream: true,
			}),
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(207);
		expect(response.statusText).toBe("Route preserved");
		expect(response.headers.get("x-non-messages-path")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(expectedBody);
	});

	it("distinguishes downstream Anthropic Messages SSE from native upstream Anthropic SSE", () => {
		const response = sseResponse(byteStream(SUCCESS));
		const shared = {
			method: "POST",
			path: "/v1/messages",
			requestHeaders: new Headers({
				"anthropic-version": "2023-06-01",
			}),
			response,
		};

		expect(isDownstreamAnthropicMessagesSse(shared)).toBe(true);
		expect(
			isNativeAnthropicMessagesSse({ ...shared, providerName: "xai" }),
		).toBe(false);
		expect(
			isNativeAnthropicMessagesSse({ ...shared, providerName: "anthropic" }),
		).toBe(true);
		expect(
			isDownstreamAnthropicMessagesSse({
				...shared,
				requestHeaders: new Headers(),
			}),
		).toBe(false);
		expect(
			isDownstreamAnthropicMessagesSse({
				...shared,
				response: new Response("not sse", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			}),
		).toBe(false);
		expect(isDownstreamAnthropicMessagesSse({ ...shared, method: "GET" })).toBe(
			false,
		);
		expect(
			isDownstreamAnthropicMessagesSse({ ...shared, path: "/v1/models" }),
		).toBe(false);
		expect(
			isDownstreamAnthropicMessagesSse({
				...shared,
				response: new Response(byteStream(SUCCESS), {
					status: 503,
					headers: { "content-type": "text/event-stream" },
				}),
			}),
		).toBe(false);
	});

	it("keeps a transformed xAI structural-only prelude private and reroutes without poisoning its circuit", async () => {
		const first = makeXaiAccount("xai-stall-a");
		const second = makeXaiAccount("xai-healthy-b");
		const third = makeXaiAccount("must-not-run-c");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second, third],
			makeCombo([first, second, third]),
		);
		const fetchedAccounts: string[] = [];
		let stalledCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const accountId = request.headers
				.get("authorization")
				?.replace(/^Bearer key-/, "");
			fetchedAccounts.push(accountId ?? "");
			return sseResponse(
				accountId === first.id
					? stalledOpenAiStream(
							[OPENAI_STRUCTURAL_CHUNK],
							() => stalledCancelCount++,
						)
					: completedOpenAiStream([openAiContentChunk("xai recovered")]),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(stalledCancelCount).toBe(1);
		expect(body).toContain('"text":"xai recovered"');
		expect(body.match(/event: message_start/g)).toHaveLength(1);
		expect(body.match(/event: ping/g)).toHaveLength(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		const accountedBody = usageHandleChunk.mock.calls
			.map(([, bytes]) => decoder.decode(bytes))
			.join("");
		expect(accountedBody).toContain('"text":"xai recovered"');
		expect(accountedBody.match(/event: message_start/g)).toHaveLength(1);
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		expect(reportCandidateSuccess.mock.calls[0][1]).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-1",
		});
	});

	it("fails over endless valid precommit activity before the outer rescue cap", async () => {
		process.env[TIMEOUT_ENV] = "100";
		process.env[MEANINGFUL_PROGRESS_ENV] = "80";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		process.env[RESCUE_DEADLINE_ENV] = "500";
		const first = makeAccount("protocol-live-no-progress-a");
		const second = makeAccount("healthy-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		const fetchedAccounts: string[] = [];
		let firstCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			return sseResponse(
				accountId === first.id
					? protocolActivityOnlyStream(() => firstCancelCount++)
					: byteStream(SUCCESS),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(firstCancelCount).toBe(1);
		expect(body).toEndWith(SUCCESS);
		expect(body).not.toContain("msg-stalled");
		expect(body.match(/event: message_start/g)).toHaveLength(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		expect(reportCandidateSuccess.mock.calls[0][1]).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-1",
		});
	});

	it("commits a fallback or emits its terminal error before the client semantic watchdog", async () => {
		// Scale Claude Code's observed 180s watchdog to 180ms. The shared proxy
		// commitment boundary is 150ms, preserving the same 30/180 headroom ratio.
		process.env[MEANINGFUL_PROGRESS_ENV] = "150";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		delete process.env[RESCUE_DEADLINE_ENV];
		const first = makeAccount("request-budget-stalled-a");
		const second = makeAccount("request-budget-delayed-b");
		const { ctx } = makeContext([first, second], makeCombo([first, second]));
		const fetchedAccounts: string[] = [];
		let firstCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === first.id) {
				return sseResponse(
					protocolActivityOnlyStream(() => firstCancelCount++),
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 60));
			return sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const terminalBody = handleProxy(request, new URL(request.url), ctx).then(
			(response) => response.text(),
		);
		const clientStalled = Symbol("client semantic watchdog elapsed");
		const outcome = await Promise.race([
			terminalBody,
			new Promise<typeof clientStalled>((resolve) =>
				setTimeout(() => resolve(clientStalled), 180),
			),
		]);

		expect(outcome).not.toBe(clientStalled);
		if (outcome === clientStalled) return;
		expect(
			outcome.endsWith(SUCCESS) ||
				outcome.endsWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME),
		).toBe(true);
		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(firstCancelCount).toBe(1);
	});

	it("reserves fallback time when a non-final route never returns response headers", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "150";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		delete process.env[RESCUE_DEADLINE_ENV];
		const first = makeAccount("header-stalled-a");
		const second = makeAccount("header-fallback-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		let firstAbortElapsedMs: number | null = null;
		const startedAt = Date.now();
		globalThis.fetch = mock((input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === second.id) {
				return Promise.resolve(sseResponse(byteStream(SUCCESS)));
			}
			return new Promise<Response>((_resolve, reject) => {
				const rejectOnAbort = () => {
					firstAbortElapsedMs = Date.now() - startedAt;
					reject(
						upstreamRequest.signal.reason ??
							new DOMException("aborted", "AbortError"),
					);
				};
				if (upstreamRequest.signal.aborted) rejectOnAbort();
				else {
					upstreamRequest.signal.addEventListener("abort", rejectOnAbort, {
						once: true,
					});
				}
			});
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const body = await (
			await handleProxy(request, new URL(request.url), ctx)
		).text();

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(body).toEndWith(SUCCESS);
		expect(firstAbortElapsedMs).not.toBeNull();
		if (firstAbortElapsedMs === null) return;
		expect(firstAbortElapsedMs).toBeGreaterThanOrEqual(100);
		expect(firstAbortElapsedMs).toBeLessThan(150);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("does not let a cache-control retry swallow its private attempt deadline", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "150";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		delete process.env[RESCUE_DEADLINE_ENV];
		const first = makeAccount("cache-retry-stalled-a");
		const second = makeAccount("cache-retry-fallback-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		let firstAttemptCount = 0;
		let retryAbortElapsedMs: number | null = null;
		const startedAt = Date.now();
		globalThis.fetch = mock((input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === second.id) {
				return Promise.resolve(sseResponse(byteStream(SUCCESS)));
			}
			firstAttemptCount++;
			if (firstAttemptCount === 1) {
				return Promise.resolve(cacheControlRejectionResponse());
			}
			return new Promise<Response>((_resolve, reject) => {
				const rejectOnAbort = () => {
					retryAbortElapsedMs = Date.now() - startedAt;
					reject(
						upstreamRequest.signal.reason ??
							new DOMException("aborted", "AbortError"),
					);
				};
				if (upstreamRequest.signal.aborted) rejectOnAbort();
				else {
					upstreamRequest.signal.addEventListener("abort", rejectOnAbort, {
						once: true,
					});
				}
			});
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const body = await (
			await handleProxy(request, new URL(request.url), ctx)
		).text();

		expect(fetchedAccounts).toEqual([first.id, first.id, second.id]);
		expect(body).toEndWith(SUCCESS);
		expect(retryAbortElapsedMs).not.toBeNull();
		if (retryAbortElapsedMs === null) return;
		expect(retryAbortElapsedMs).toBeGreaterThanOrEqual(100);
		expect(retryAbortElapsedMs).toBeLessThan(150);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("bounds hanging JSON classifiers inside the same private attempt deadline", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "150";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		delete process.env[RESCUE_DEADLINE_ENV];
		const first = makeAccount("classifier-stalled-a");
		const second = makeAccount("classifier-fallback-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		let firstBodyCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			return accountId === first.id
				? neverEndingJsonResponse(() => firstBodyCancelCount++)
				: sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		const request = makeRequest();
		const body = await (
			await handleProxy(request, new URL(request.url), ctx)
		).text();
		const elapsedMs = Date.now() - startedAt;

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(body).toEndWith(SUCCESS);
		expect(firstBodyCancelCount).toBe(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(100);
		expect(elapsedMs).toBeLessThan(150);
		expect(first.paused).toBe(false);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("releases classifier clone readers after an ordinary body read rejection", async () => {
		const account = makeAccount("classifier-read-error-a");
		const { ctx } = makeContext([account]);
		const probeReader = new ReadableStream<Uint8Array>().getReader();
		const readerPrototype = Object.getPrototypeOf(probeReader) as {
			releaseLock: () => void;
		};
		probeReader.releaseLock();
		const releaseLock = spyOn(readerPrototype, "releaseLock");
		globalThis.fetch = mock(async () => {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(nextController) {
					controller = nextController;
				},
			});
			queueMicrotask(() =>
				controller.error(new Error("classifier read failed")),
			);
			return new Response(body, {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const request = makeRequest();
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(400);
			expect(releaseLock).toHaveBeenCalled();
		} finally {
			releaseLock.mockRestore();
		}
	});

	it("fails over a request-local extra-usage 400 to a later account and disposes the retained body", async () => {
		const first = makeAccount("extra-usage-a");
		const second = makeAccount("healthy-b");
		const { ctx } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		let firstResponse: Response | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === first.id) {
				firstResponse = extraUsageExhaustedResponse();
				return firstResponse;
			}
			return sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toEndWith(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(firstResponse?.bodyUsed).toBe(true);
		expect(first.rate_limited_until).toBeNull();
		expect(first.consecutive_rate_limits).toBe(0);
		expect(
			usageCache.getModelScopedExhaustion(first.id, MODEL, null),
		).toBeNull();
	});

	it("continues from extra-usage rejection to a distinct model slot on the same account", async () => {
		const account = makeAccount("extra-usage-model-slots");
		account.model_mappings = JSON.stringify({
			opus: [MODEL, OPUS_SIBLING],
		});
		const { ctx } = makeContext([account]);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as { model: string };
			attemptedModels.push(body.model);
			return body.model === MODEL
				? extraUsageExhaustedResponse()
				: sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toEndWith(SUCCESS);
		expect(attemptedModels).toEqual([MODEL, OPUS_SIBLING]);
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(
			usageCache.getModelScopedExhaustion(account.id, MODEL, null),
		).toBeNull();
	});

	it("classifies extra-usage returned by an intermediate model fallback before continuing", async () => {
		const account = makeAccount("extra-usage-intermediate-fallback");
		account.model_mappings = JSON.stringify({
			opus: [MODEL, OPUS_SIBLING, FABLE],
		});
		const { ctx } = makeContext([account]);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as { model: string };
			attemptedModels.push(body.model);
			if (body.model === MODEL) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "not_found_error", message: "model not found" },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return body.model === OPUS_SIBLING
				? extraUsageExhaustedResponse()
				: sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toEndWith(SUCCESS);
		expect(attemptedModels).toEqual([MODEL, OPUS_SIBLING, FABLE]);
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
	});

	it("returns a retained upstream extra-usage 400 after every route is exhausted", async () => {
		const first = makeAccount("extra-usage-a");
		const second = makeAccount("extra-usage-b");
		const { ctx } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			fetchedAccounts.push(
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "",
			);
			return extraUsageExhaustedResponse();
		}) as unknown as typeof fetch;

		const request = makeRequest(undefined, undefined, false);
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error?: { type?: string; message?: string };
		};

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(response.status).toBe(400);
		expect(payload.error).toEqual({
			type: "invalid_request_error",
			message:
				"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
		});
	});

	it("preserves an earlier extra-usage 400 when a later route fails without retaining a terminal", async () => {
		const first = makeAccount("extra-usage-retained-a");
		const second = makeAccount("payment-required-b");
		const { ctx } = makeContext([first, second]);
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === first.id) return extraUsageExhaustedResponse();
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "billing_error", message: "payment required" },
				}),
				{ status: 402, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const request = makeRequest(undefined, undefined, false);
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error?: { type?: string; message?: string };
		};

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(response.status).toBe(400);
		expect(payload.error).toEqual({
			type: "invalid_request_error",
			message:
				"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
		});
	});

	it("reserves while a final account can discover deferred model work, then gives the deferred route the final boundary", async () => {
		process.env[MEANINGFUL_PROGRESS_ENV] = "150";
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "10";
		process.env[CONTEXT_ADMISSION_ENV] = "1";
		delete process.env[RESCUE_DEADLINE_ENV];
		const account = makeAccount("dynamic-finality-a");
		account.model_mappings = JSON.stringify({
			opus: [MODEL, OPUS_SIBLING, FABLE],
		});
		const { ctx, reportCandidateFailure } = makeContext([account]);
		const attemptedModels: string[] = [];
		let siblingAbortElapsedMs: number | null = null;
		const startedAt = Date.now();
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as { model: string };
			attemptedModels.push(body.model);
			if (body.model === MODEL) return exactModelExhaustedResponse();
			if (body.model === FABLE) {
				return sseResponse(byteStream(SUCCESS));
			}
			return new Promise<Response>((_resolve, reject) => {
				const rejectOnAbort = () => {
					siblingAbortElapsedMs = Date.now() - startedAt;
					reject(
						upstreamRequest.signal.reason ??
							new DOMException("aborted", "AbortError"),
					);
				};
				if (upstreamRequest.signal.aborted) rejectOnAbort();
				else {
					upstreamRequest.signal.addEventListener("abort", rejectOnAbort, {
						once: true,
					});
				}
			});
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const responseBody = await response.text();

		expect(responseBody).toEndWith(SUCCESS);
		expect(attemptedModels).toEqual([MODEL, OPUS_SIBLING, FABLE]);
		expect(siblingAbortElapsedMs).not.toBeNull();
		if (siblingAbortElapsedMs === null) return;
		expect(siblingAbortElapsedMs).toBeGreaterThanOrEqual(100);
		expect(siblingAbortElapsedMs).toBeLessThan(150);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("commits a transformed xAI meaningful delta without opening another route", async () => {
		const first = makeXaiAccount("xai-content-a");
		const second = makeXaiAccount("must-not-run-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
		);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				completedOpenAiStream([openAiContentChunk("commit xai")]),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchCount).toBe(1);
		expect(body).toContain('"text":"commit xai"');
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		expect(reportCandidateSuccess.mock.calls[0][1]).toEqual({
			candidateId: `account:${first.id}`,
		});
	});

	it("suppresses only the exact transformed route after a postcommit protocol idle without replay", async () => {
		const first = makeXaiAccount("xai-postcommit-a");
		const second = makeXaiAccount("must-not-splice-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				stalledOpenAiStream(
					[openAiContentChunk("partial xai")],
					() => cancelCount++,
				),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(1);
		expect(body).toContain('"text":"partial xai"');
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).toEndWith(
			'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response stalled after partial output"}}\n\n',
		);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		const [reportedMeta, failure] = reportCandidateFailure.mock.calls[0];
		expect(failure).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_postcommit_protocol_idle_timeout",
			suppressForMs: 12345,
		});
		const lane = JSON.parse(
			reportedMeta.affinityLaneKey ?? "null",
		) as unknown[];
		expect(lane[1]).toBe(SESSION);
		expect(lane[5]).toBe(MODEL);
		expect(first.paused).toBe(false);
		expect(first.rate_limited_until).toBeNull();
		expect(first.consecutive_rate_limits).toBe(0);
		expect(
			usageCache.getModelScopedExhaustion(first.id, MODEL, null),
		).toBeNull();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

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

	it("preserves canonical beta scope for a precommit rate_limit_error", async () => {
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

		const request = makeRequest();
		request.headers.set("anthropic-beta", "feature-b, feature-a,feature-b");
		try {
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(await response.text()).toBe(SUCCESS);
			expect(first.rate_limited_until).toBeNull();
			expect(first.consecutive_rate_limits).toBe(0);
			expect(
				usageCache.getModelScopedExhaustion(
					first.id,
					MODEL,
					"feature-a,feature-b",
				),
			).not.toBeNull();
			expect(
				usageCache.getModelScopedExhaustion(first.id, MODEL, null),
			).toBeNull();
		} finally {
			usageCache.delete(first.id);
		}
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
			error: {
				type: string;
				code: string;
				message: string;
				attempted_routes: number;
			};
		};

		expect(response.status).toBe(503);
		expect(payload.error).toMatchObject({
			type: "service_unavailable",
			code: "route_unavailable",
			attempted_routes: 2,
			message:
				"All compatible upstream routes failed to proxy the request (2 unique account/model routes attempted)",
		});
		expect(reportCandidateFailure).toHaveBeenCalledTimes(2);
	});

	it("reports only ledger-claimed transports when a deferred route follows a duplicate candidate skip", async () => {
		const account = makeAccount("deferred-ledger-a");
		account.model_mappings = JSON.stringify({
			opus: [MODEL, OPUS_SIBLING],
		});
		const { ctx } = makeContext([account]);
		ctx.strategy.select = mock(async () => [account, account]);
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const body = (await upstreamRequest.clone().json()) as { model: string };
			attemptedModels.push(body.model);
			return body.model === MODEL
				? exactModelExhaustedResponse()
				: sseResponse(byteStream(TRANSIENT_ERROR));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: {
				code: string;
				message: string;
				attempted_routes: number;
			};
		};

		expect(response.status).toBe(503);
		expect(attemptedModels).toEqual([MODEL, OPUS_SIBLING]);
		expect(payload.error).toMatchObject({
			code: "route_unavailable",
			attempted_routes: 2,
			message:
				"All compatible upstream routes failed to proxy the request (2 unique account/model routes attempted)",
		});
	});

	it("carries a route-circuit recovery hint through handleProxy without a pool-exhausted marker", async () => {
		const account = makeAccount("circuit-open-a");
		const { ctx } = makeContext([account]);
		const retryAt = Date.now() + 30_000;
		ctx.strategy.select = mock(async () => []);
		ctx.strategy.getRouteCircuitRecoveryHint = mock(() => ({
			allCandidatesOpen: true,
			candidateCount: 2,
			probeLeased: true,
			retryAt,
			reason: "semantic_stream_stall",
		}));
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: {
				code: string;
				next_available_at: string;
				route_circuit: Record<string, unknown>;
			};
		};

		expect(fetchCount).toBe(0);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("30");
		expect(response.headers.get("x-better-ccflare-route-status")).toBe(
			"circuit-open",
		);
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(payload.error).toMatchObject({
			code: "route_unavailable",
			next_available_at: new Date(retryAt).toISOString(),
			route_circuit: {
				all_candidates_open: true,
				candidate_count: 2,
				probe_leased: true,
				reason: "semantic_stream_stall",
			},
		});
	});

	it("cancels a stalled prelude once and reroutes without leaking bytes or poisoning its circuit", async () => {
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
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("keeps sequential failover alive beyond the client watchdog window and exposes only the gated winner", async () => {
		process.env[TIMEOUT_ENV] = "100";
		process.env[RESCUE_ACTIVATION_ENV] = "10";
		process.env[RESCUE_PING_ENV] = "15";
		process.env[RESCUE_DEADLINE_ENV] = "1000";
		const first = makeAccount("slow-stall-a");
		const second = makeAccount("delayed-healthy-b");
		const { ctx } = makeContext([first, second], makeCombo([first, second]));
		const fetchedAccounts: string[] = [];
		let firstCancelCount = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const accountId = request.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === first.id) {
				return sseResponse(stalledStream(() => firstCancelCount++));
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			return sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(179);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-better-ccflare-precommit-rescue")).toBe(
			"active",
		);
		expect(body).toStartWith(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME);
		expect(body.match(/event: ping/g)?.length ?? 0).toBeGreaterThan(2);
		expect(body).not.toContain(PRELUDE);
		expect(body).toEndWith(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(firstCancelCount).toBe(1);
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		const accountedBytes = usageHandleChunk.mock.calls
			.map(([, bytes]) => decoder.decode(bytes))
			.join("");
		expect(accountedBytes).toContain('"text":"recovered"');
		expect(accountedBytes).not.toContain(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME);
	});

	it("subtracts slow upstream headers from the request-scoped rescue activation grace", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "50";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "500";
		const account = makeAccount("slow-headers-a");
		const { ctx } = makeContext([account]);
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 45));
			return sseResponse(stalledStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const responseElapsedMs = Date.now() - startedAt;

		expect(response.headers.get("x-better-ccflare-precommit-rescue")).toBe(
			"active",
		);
		expect(responseElapsedMs).toBeGreaterThanOrEqual(45);
		expect(responseElapsedMs).toBeLessThan(75);
		await response.body?.cancel("test complete");
		expect(cancelCount).toBe(1);
	});

	it("activates rescue while native Anthropic response headers are still pending", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "10";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "500";
		const account = makeAccount("hanging-headers-a");
		const { ctx, reportCandidateFailure } = makeContext([account]);
		let fetchCount = 0;
		let fetchAbortCount = 0;
		globalThis.fetch = mock((input: RequestInfo | URL) => {
			fetchCount++;
			const request = input instanceof Request ? input : new Request(input);
			return new Promise<Response>((_resolve, reject) => {
				const handleAbort = (): void => {
					fetchAbortCount++;
					reject(request.signal.reason);
				};
				if (request.signal.aborted) {
					handleAbort();
					return;
				}
				request.signal.addEventListener("abort", handleAbort, { once: true });
			});
		}) as unknown as typeof fetch;

		const callerAbort = new AbortController();
		const request = makeRequest(callerAbort.signal);
		const responsePromise = handleProxy(request, new URL(request.url), ctx);
		const outcome = await Promise.race([
			responsePromise.then(
				(response) => ({ kind: "response", response }) as const,
				(error: unknown) => ({ kind: "error", error }) as const,
			),
			new Promise<{ readonly kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 75),
			),
		]);

		if (outcome.kind !== "response") {
			callerAbort.abort("test cleanup");
			await responsePromise.catch(() => undefined);
			throw new Error(
				`Expected rescue response before timeout; got ${outcome.kind}`,
			);
		}
		expect(outcome.response.status).toBe(200);
		expect(
			outcome.response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBe("active");
		const reader = outcome.response.body?.getReader();
		expect(decoder.decode((await reader?.read())?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		await reader?.cancel("client left during upstream headers");
		const cancellationDeadline = Date.now() + 100;
		while (fetchAbortCount === 0 && Date.now() < cancellationDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		// Let the privately-running route executor observe the abort too, so this
		// assertion would catch a late circuit penalty instead of racing it.
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(fetchCount).toBe(1);
		expect(fetchAbortCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("activates rescue while transformed-provider response headers are still pending", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "10";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "500";
		const account = makeXaiAccount("xai-hanging-headers-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
		);
		let fetchCount = 0;
		let fetchAbortCount = 0;
		globalThis.fetch = mock((input: RequestInfo | URL) => {
			fetchCount++;
			const request = input instanceof Request ? input : new Request(input);
			return new Promise<Response>((_resolve, reject) => {
				const handleAbort = (): void => {
					fetchAbortCount++;
					reject(request.signal.reason);
				};
				if (request.signal.aborted) {
					handleAbort();
					return;
				}
				request.signal.addEventListener("abort", handleAbort, { once: true });
			});
		}) as unknown as typeof fetch;

		const callerAbort = new AbortController();
		const request = makeRequest(callerAbort.signal);
		const responsePromise = handleProxy(request, new URL(request.url), ctx);
		const outcome = await Promise.race([
			responsePromise.then(
				(response) => ({ kind: "response", response }) as const,
				(error: unknown) => ({ kind: "error", error }) as const,
			),
			new Promise<{ readonly kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 75),
			),
		]);

		if (outcome.kind !== "response") {
			callerAbort.abort("test cleanup");
			await responsePromise.catch(() => undefined);
			throw new Error(
				`Expected transformed-provider rescue before timeout; got ${outcome.kind}`,
			);
		}
		expect(outcome.response.status).toBe(200);
		expect(
			outcome.response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBe("active");
		const reader = outcome.response.body?.getReader();
		expect(decoder.decode((await reader?.read())?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		await reader?.cancel("client left during transformed-provider headers");
		const cancellationDeadline = Date.now() + 100;
		while (fetchAbortCount === 0 && Date.now() < cancellationDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(fetchCount).toBe(1);
		expect(fetchAbortCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("translates delayed route exhaustion to one in-band SSE error after rescue activation", async () => {
		process.env[TIMEOUT_ENV] = "15";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const first = makeAccount("stall-a");
		const second = makeAccount("stall-b");
		const { ctx, reportCandidateSuccess } = makeContext([first, second]);
		globalThis.fetch = mock(async () =>
			sseResponse(stalledStream(() => undefined)),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).not.toContain("route_unavailable");
		expect(body).not.toContain("service_unavailable");
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	for (const responseBody of [
		{ label: "with a body", body: '{"private":"must-not-forward"}' },
		{ label: "with a null body", body: null },
	] as const) {
		it(`records a delayed HTTP-200 non-SSE response ${responseBody.label} once as the rescue terminal`, async () => {
			process.env[TIMEOUT_ENV] = "1000";
			process.env[RESCUE_ACTIVATION_ENV] = "1";
			process.env[RESCUE_PING_ENV] = "5";
			process.env[RESCUE_DEADLINE_ENV] = "100";
			const persistence = installPersistingUsageCollector();
			const account = makeAccount(
				`non-sse-${responseBody.body === null ? "null" : "body"}`,
			);
			const { ctx } = makeContext([account]);
			globalThis.fetch = mock(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return new Response(responseBody.body, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const request = makeRequest();
			const response = await handleProxy(request, new URL(request.url), ctx);
			const body = await response.text();
			await persistence.collector.drain();

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain(
				"text/event-stream",
			);
			expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
			expect(body).not.toContain("must-not-forward");
			expect(persistence.handleStart).toHaveBeenCalledTimes(1);
			expect(persistence.handleEnd).toHaveBeenCalledTimes(1);
			expect(persistence.handleEnd).toHaveBeenCalledWith({
				type: "end",
				requestId: expect.any(String),
				success: false,
				error: "anthropic_rescue_non_sse_response",
			});
			expect(persistence.savedRequests).toHaveLength(1);
			expect(persistence.savedRequests[0]?.[4]).toBe(200);
			expect(persistence.savedRequests[0]?.[5]).toBe(false);
			expect(persistence.savedRequests[0]?.[6]).toBe(
				"anthropic_rescue_non_sse_response",
			);
		});
	}

	it("propagates the shared deadline through a reserved fallback without penalizing either route", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		// Keep the wall-clock integration budget above Bun's cold-start/JIT stalls.
		// Exact 20ms proportional allocation is covered synchronously by the route
		// context unit test; this case proves the routed handoff and shared boundary.
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const first = makeAccount("deadline-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
		);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(stalledStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(fetchCount).toBe(2);
		expect(cancelCount).toBe(2);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("keeps a transport-aborted private deadline circuit-neutral and fails over", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const first = makeAccount("transport-deadline-a");
		const second = makeAccount("transport-deadline-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
		);
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			const accountId =
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "";
			fetchedAccounts.push(accountId);
			if (accountId === second.id) {
				return sseResponse(byteStream(SUCCESS));
			}
			return sseResponse(
				new ReadableStream<Uint8Array>({
					start(controller) {
						const failOnTransportAbort = () =>
							controller.error(new Error("transport aborted response body"));
						if (upstreamRequest.signal.aborted) failOnTransportAbort();
						else {
							upstreamRequest.signal.addEventListener(
								"abort",
								failOnTransportAbort,
								{ once: true },
							);
						}
					},
				}),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const body = await (
			await handleProxy(request, new URL(request.url), ctx)
		).text();

		expect(fetchedAccounts).toEqual([first.id, second.id]);
		expect(body).toEndWith(SUCCESS);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
	});

	it("propagates rescued downstream cancellation through the combined signal exactly once", async () => {
		process.env[TIMEOUT_ENV] = "1000";
		process.env[RESCUE_ACTIVATION_ENV] = "1";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const first = makeAccount("cancel-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
		);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(stalledStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		await response.body?.cancel("client left");
		const cancellationDeadline = Date.now() + 100;
		while (cancelCount === 0 && Date.now() < cancellationDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(1);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("leaves the fast native Anthropic response object semantics unchanged", async () => {
		const account = makeAccount("fast-a");
		const { ctx } = makeContext([account]);
		globalThis.fetch = mock(
			async () =>
				new Response(byteStream(SUCCESS), {
					status: 200,
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"x-upstream-fast": "preserved",
					},
				}),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(response.headers.get("x-upstream-fast")).toBe("preserved");
		expect(await response.text()).toBe(SUCCESS);
	});

	it("preserves a slow non-streaming Messages response beyond rescue grace", async () => {
		process.env[RESCUE_ACTIVATION_ENV] = "5";
		process.env[RESCUE_PING_ENV] = "5";
		process.env[RESCUE_DEADLINE_ENV] = "100";
		const account = makeAccount("slow-non-stream-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
		);
		const expectedBody = JSON.stringify({
			id: "msg-non-stream",
			type: "message",
			content: [{ type: "text", text: "slow JSON preserved" }],
		});
		globalThis.fetch = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return new Response(expectedBody, {
				status: 202,
				statusText: "Accepted upstream",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"x-upstream-non-stream": "preserved",
				},
			});
		}) as unknown as typeof fetch;

		const request = makeRequest(undefined, undefined, false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Accepted upstream");
		expect(response.headers.get("content-type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(response.headers.get("x-upstream-non-stream")).toBe("preserved");
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(await response.text()).toBe(expectedBody);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("closes only the exact route circuit after clean native terminal completion", async () => {
		const account = makeAccount("clean-success-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
			makeCombo([account]),
		);
		globalThis.fetch = mock(async () =>
			sseResponse(byteStream(SUCCESS)),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(reportCandidateSuccess).not.toHaveBeenCalled();

		expect(await response.text()).toBe(SUCCESS);
		const successDeadline = Date.now() + 100;
		while (
			reportCandidateSuccess.mock.calls.length === 0 &&
			Date.now() < successDeadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
		const [reportedMeta, success] = reportCandidateSuccess.mock.calls[0];
		expect(success).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
		});
		const lane = JSON.parse(
			reportedMeta.affinityLaneKey ?? "null",
		) as unknown[];
		expect(lane[1]).toBe(SESSION);
		expect(lane[5]).toBe(MODEL);
	});

	it("does not close a route circuit for a recovery-synthesized terminal", async () => {
		const account = makeAccount("recovered-terminal-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
		);
		const withoutMessageStop = SUCCESS.slice(
			0,
			SUCCESS.indexOf("event: message_stop"),
		);
		globalThis.fetch = mock(async () =>
			sseResponse(byteStream(withoutMessageStop)),
		) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(body).toStartWith(withoutMessageStop);
		expect(body).toEndWith(
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("leaves a non-native request outside rescue even when the provider returns SSE", async () => {
		const account = makeAccount("non-native-a");
		const { ctx } = makeContext([account]);
		globalThis.fetch = mock(
			async () =>
				new Response(byteStream(SUCCESS), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-non-native": "unchanged",
					},
				}),
		) as unknown as typeof fetch;
		const request = makeRequest();
		request.headers.delete("anthropic-version");

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
		expect(response.headers.get("x-non-native")).toBe("unchanged");
		expect(await response.text()).toContain('"text":"recovered"');
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

	it("keeps a committed route alive by default while valid protocol activity continues", async () => {
		process.env[TIMEOUT_ENV] = "70";
		delete process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV];
		const account = makeAccount("postcommit-active-a");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[account],
		);
		let fetchCount = 0;
		let cancelCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(
				postcommitProtocolActivityThenSuccessStream(() => cancelCount++),
			);
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.text();

		expect(fetchCount).toBe(1);
		expect(cancelCount).toBe(0);
		expect(body).toStartWith(POSTCOMMIT_STALL);
		expect(body).toEndWith(POSTCOMMIT_TERMINAL);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).toHaveBeenCalledTimes(1);
	});

	it("reroutes the next same-lane turn after a postcommit meaningful-progress timeout while leaving sibling lanes isolated", async () => {
		process.env[TIMEOUT_ENV] = "50";
		process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV] = "90";
		const first = makeAccount("postcommit-a");
		const second = makeAccount("postcommit-b");
		const { ctx } = makeContext([first, second], makeCombo([first, second]));
		const strategy = new SessionAffinityStrategy();
		strategy.initialize({ resetAccountSession: () => undefined });
		const reportCandidateFailure = spyOn(strategy, "reportCandidateFailure");
		const reportCandidateSuccess = spyOn(strategy, "reportCandidateSuccess");
		ctx.strategy = strategy;
		let fetchCount = 0;
		let cancelCount = 0;
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchCount++;
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			fetchedAccounts.push(
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "",
			);
			return fetchCount === 1
				? sseResponse(postcommitProtocolActivityOnlyStream(() => cancelCount++))
				: sseResponse(byteStream(SUCCESS));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const responseText = await response.text();
		const cancelDeadline = Date.now() + 250;
		while (cancelCount < 1 && Date.now() < cancelDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}

		expect(fetchCount).toBe(1);
		expect(fetchedAccounts).toEqual([first.id]);
		expect(cancelCount).toBe(1);
		expect(responseText).toStartWith(POSTCOMMIT_STALL);
		expect(responseText).toEndWith(
			'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response stalled after partial output"}}\n\n',
		);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		const [reportedMeta, failure] = reportCandidateFailure.mock.calls[0];
		expect(failure).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_postcommit_meaningful_progress_timeout",
			suppressForMs: 12345,
		});
		const lane = JSON.parse(
			reportedMeta.affinityLaneKey ?? "null",
		) as unknown[];
		expect(lane[1]).toBe(SESSION);
		expect(lane[5]).toBe(MODEL);
		expect(first.paused).toBe(false);
		expect(first.rate_limited_until).toBeNull();
		expect(first.consecutive_rate_limits).toBe(0);
		expect(
			usageCache.getModelScopedExhaustion(first.id, MODEL, null),
		).toBeNull();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();

		const nextRequest = makeRequest();
		const nextResponse = await handleProxy(
			nextRequest,
			new URL(nextRequest.url),
			ctx,
		);
		expect(await nextResponse.text()).toBe(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id]);

		const siblingRequest = makeRequest(
			undefined,
			undefined,
			true,
			OPUS_SIBLING,
		);
		const siblingResponse = await handleProxy(
			siblingRequest,
			new URL(siblingRequest.url),
			ctx,
		);
		expect(await siblingResponse.text()).toBe(SUCCESS);
		expect(fetchedAccounts).toEqual([first.id, second.id, first.id]);
		expect(strategy.routeSuppressionEntries).toBe(1);
	});

	it("suppresses the exact route once for a committed upstream transient SSE error without replay", async () => {
		const first = makeAccount("postcommit-error-a");
		const second = makeAccount("must-not-splice-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
			makeCombo([first, second]),
		);
		const postcommitError = `${POSTCOMMIT_STALL}${TRANSIENT_ERROR.replace(
			/^event: message_start[\\s\\S]*?\\n\\n/,
			"",
		)}`;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return sseResponse(byteStream(postcommitError));
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(await response.text()).toBe(postcommitError);
		expect(fetchCount).toBe(1);
		expect(reportCandidateFailure).toHaveBeenCalledTimes(1);
		const [reportedMeta, failure] = reportCandidateFailure.mock.calls[0];
		expect(failure).toEqual({
			candidateId: "combo:semantic-combo:slot:semantic-slot-0",
			reason: "anthropic_postcommit_transient_sse_error:api_error",
			suppressForMs: 12345,
		});
		const lane = JSON.parse(
			reportedMeta.affinityLaneKey ?? "null",
		) as unknown[];
		expect(lane[1]).toBe(SESSION);
		expect(lane[5]).toBe(MODEL);
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("stops on caller abort during preflight without retrying or penalizing", async () => {
		const first = makeAccount("abort-a");
		const second = makeAccount("must-not-run-b");
		const { ctx, reportCandidateFailure, reportCandidateSuccess } = makeContext(
			[first, second],
		);
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
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
	});

	it("returns route_unavailable after every candidate idles without poisoning circuits", async () => {
		const first = makeAccount("stall-a");
		const second = makeAccount("stall-b");
		const { ctx, reportCandidateFailure } = makeContext([first, second]);
		let cancelCount = 0;
		const fetchedAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			fetchedAccounts.push(
				upstreamRequest.headers.get("x-api-key")?.slice(4) ?? "",
			);
			return sseResponse(stalledStream(() => cancelCount++));
		}) as unknown as typeof fetch;

		for (let turn = 0; turn < 2; turn += 1) {
			const request = makeRequest();
			const response = await handleProxy(request, new URL(request.url), ctx);
			const payload = (await response.json()) as {
				error: { type: string; code: string };
			};

			expect(response.status).toBe(503);
			expect(payload.error.type).toBe("service_unavailable");
			expect(payload.error.code).toBe("route_unavailable");
			expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		}

		expect(fetchedAccounts).toEqual([first.id, second.id, first.id, second.id]);
		expect(cancelCount).toBe(4);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});

	it("never escapes an explicitly forced account after protocol idle or poisons its circuit", async () => {
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
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});
});

describe("Anthropic stream runtime configuration", () => {
	it("disables the postcommit progress cap when absent or invalid", () => {
		delete process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV];
		expect(
			getAnthropicStreamRuntimeConfig().postCommitMeaningfulProgressTimeoutMs,
		).toBeNull();

		process.env[TIMEOUT_ENV] = "0";
		process.env[MEANINGFUL_PROGRESS_ENV] = "not-a-number";
		process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV] = "not-a-number";
		process.env[TERMINAL_GRACE_ENV] = "not-a-number";
		process.env[BUFFER_ENV] = "-1";
		process.env[SUPPRESSION_ENV] = "1.5";

		expect(ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS).toBe(120_000);
		expect(ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS).toBe(150_000);
		expect(ANTHROPIC_POST_COMMIT_MEANINGFUL_PROGRESS_TIMEOUT_MS).toBeNull();
		expect(getAnthropicStreamRuntimeConfig()).toEqual({
			semanticTimeoutMs: ANTHROPIC_PRE_COMMIT_SEMANTIC_TIMEOUT_MS,
			meaningfulProgressTimeoutMs: ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS,
			postCommitMeaningfulProgressTimeoutMs: null,
			terminalGraceMs: ANTHROPIC_PRE_COMMIT_TERMINAL_GRACE_MS,
			maxBufferedBytes: ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
			routeSuppressionMs: ANTHROPIC_PRE_COMMIT_ROUTE_SUPPRESSION_MS,
		});
	});

	it("clamps oversized values to finite operational bounds", () => {
		process.env[TIMEOUT_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[MEANINGFUL_PROGRESS_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[POST_COMMIT_MEANINGFUL_PROGRESS_ENV] = String(
			Number.MAX_SAFE_INTEGER,
		);
		process.env[TERMINAL_GRACE_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[BUFFER_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[SUPPRESSION_ENV] = String(Number.MAX_SAFE_INTEGER);

		expect(getAnthropicStreamRuntimeConfig()).toEqual({
			semanticTimeoutMs: 10 * 60 * 1000,
			meaningfulProgressTimeoutMs: 7 * 60 * 1000,
			postCommitMeaningfulProgressTimeoutMs: 9 * 60 * 1000,
			terminalGraceMs: 60 * 1000,
			maxBufferedBytes: 16 * 1024 * 1024,
			routeSuppressionMs: 24 * 60 * 60 * 1000,
		});
	});
});

describe("Anthropic precommit rescue runtime configuration", () => {
	it("restores the bounded eight-minute commitment only for Claude Code clients", () => {
		delete process.env[MEANINGFUL_PROGRESS_ENV];
		delete process.env[RESCUE_ACTIVATION_ENV];
		delete process.env[RESCUE_PING_ENV];
		delete process.env[RESCUE_DEADLINE_ENV];

		const claudeCodeRequest = makeRequest(
			undefined,
			undefined,
			true,
			MODEL,
			"claude-cli/2.1.212 (external, cli)",
		);
		const genericRequest = makeRequest(
			undefined,
			undefined,
			true,
			MODEL,
			"curl/8.0",
		);

		expect(getAnthropicPreCommitRescueConfig(claudeCodeRequest)).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
			pingIntervalMs: ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
			commitmentDeadlineMs: 8 * 60 * 1000,
		});
		expect(getAnthropicPreCommitRescueConfig(genericRequest)).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
			pingIntervalMs: ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
			commitmentDeadlineMs: ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS,
		});
	});

	it("falls back to watchdog-safe defaults for invalid values", () => {
		process.env[RESCUE_ACTIVATION_ENV] = "0";
		process.env[RESCUE_PING_ENV] = "not-a-number";
		process.env[RESCUE_DEADLINE_ENV] = "-1";

		expect(getAnthropicPreCommitRescueConfig()).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
			pingIntervalMs: ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
			commitmentDeadlineMs: ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS,
		});
	});

	it("clamps a legacy-only rescue deadline to the generic-client default", () => {
		delete process.env[MEANINGFUL_PROGRESS_ENV];
		process.env[RESCUE_ACTIVATION_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[RESCUE_PING_ENV] = String(Number.MAX_SAFE_INTEGER);
		process.env[RESCUE_DEADLINE_ENV] = String(Number.MAX_SAFE_INTEGER);

		expect(getAnthropicPreCommitRescueConfig()).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS - 1,
			pingIntervalMs: 30_000,
			commitmentDeadlineMs: ANTHROPIC_PRECOMMIT_RESCUE_COMMITMENT_DEADLINE_MS,
		});
	});

	it("clamps rescue activation inside a deliberately tiny shared deadline", () => {
		process.env[RESCUE_ACTIVATION_ENV] = "100";
		process.env[RESCUE_PING_ENV] = "20";
		process.env[RESCUE_DEADLINE_ENV] = "1";

		expect(getAnthropicPreCommitRescueConfig()).toEqual({
			activationGraceMs: 0,
			pingIntervalMs: 20,
			commitmentDeadlineMs: 1,
		});
	});

	it("uses the existing meaningful-progress override as the shared request deadline", () => {
		delete process.env[RESCUE_ACTIVATION_ENV];
		delete process.env[RESCUE_PING_ENV];
		delete process.env[RESCUE_DEADLINE_ENV];
		process.env[MEANINGFUL_PROGRESS_ENV] = "420000";

		expect(getAnthropicPreCommitRescueConfig()).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
			pingIntervalMs: ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
			commitmentDeadlineMs: 420_000,
		});
	});

	it("lets the canonical override win over the deprecated rescue deadline", () => {
		delete process.env[RESCUE_ACTIVATION_ENV];
		delete process.env[RESCUE_PING_ENV];
		process.env[MEANINGFUL_PROGRESS_ENV] = "420000";
		process.env[RESCUE_DEADLINE_ENV] = "1";

		expect(getAnthropicPreCommitRescueConfig()).toEqual({
			activationGraceMs: ANTHROPIC_PRECOMMIT_RESCUE_ACTIVATION_MS,
			pingIntervalMs: ANTHROPIC_PRECOMMIT_RESCUE_PING_INTERVAL_MS,
			commitmentDeadlineMs: 420_000,
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
