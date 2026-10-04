import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, StrategyStore } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";

// Focused proxy tests must not load ignored embedded worker artifacts.
const { getProvider } = await import("@better-ccflare/providers");
const { SessionStrategy } = await import("@better-ccflare/load-balancer");
const accountSelectorModule = await import("../handlers/account-selector");
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"./helpers/server-tool-replay-runtime"
);
const READY_SERVER_TOOL_REPLAY_RUNTIME =
	await createReadyServerToolReplayRuntimeForTest();

const MODEL = "claude-sonnet-4-5";
const ADVISOR_BETA = "advisor-tool-2026-03-01";
const ADVISOR_PAIRING_400 = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message: `${MODEL} cannot be used as an advisor for this executor model`,
	},
};
const originalFetch = globalThis.fetch;
const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
let restoreUsageCollectors = (): void => {};

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "anthropic-a",
		name: "anthropic-a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "oauth-access-token",
		expires_at: Date.now() + 60 * 60_000,
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

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "codex-a",
		name: "codex-a",
		provider: "codex",
		priority: 5,
		...overrides,
	});
}

function makeContext(accounts: Account[]) {
	const mutations = {
		pauseAccount: mock(async () => undefined),
		markAccountRateLimited: mock(
			async (_accountId: string, _until: number, _reason: string) => ({
				consecutiveRateLimits: 1,
				applied: true,
			}),
		),
		updateAccountUsage: mock(async () => undefined),
		// Run queued durable writes so "no state written" assertions see them.
		asyncWrite: mock((job: () => Promise<unknown>) => {
			void job();
		}),
	};
	const ctx = {
		strategy: {
			select: mock(async (list: Account[]) => list),
			reportCandidateFailure: mock(() => undefined),
			reportCandidateSuccess: mock(() => undefined),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
			pauseAccount: mutations.pauseAccount,
			markAccountRateLimited: mutations.markAccountRateLimited,
			updateAccountUsage: mutations.updateAccountUsage,
		},
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider: getProvider("anthropic"),
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mutations.asyncWrite },
		serverToolReplay: READY_SERVER_TOOL_REPLAY_RUNTIME,
	} as unknown as ProxyContext;
	return { ctx, mutations };
}

// The advisor tool object exactly as Claude Code declares it, with every
// option the passthrough must not drop.
const ADVISOR_TOOL = {
	type: "advisor_20260301",
	name: "advisor",
	model: "claude-opus-5",
	max_uses: 3,
	caching: { type: "ephemeral", ttl: "5m" },
};
const OTHER_TOOL = {
	name: "get_weather",
	description: "Look up the weather",
	input_schema: { type: "object", properties: { city: { type: "string" } } },
};
// Advisor history as Claude Code replays it on a later turn.
const ADVISOR_HISTORY_MESSAGES = [
	{ role: "user", content: "review my plan" },
	{
		role: "assistant",
		content: [
			{
				type: "server_tool_use",
				id: "srvtoolu_advisor_1",
				name: "advisor",
				input: {},
			},
			{
				type: "advisor_tool_result",
				tool_use_id: "srvtoolu_advisor_1",
				content: { type: "advisor_result", text: "ship it" },
			},
			{ type: "text", text: "The advisor says to ship it." },
		],
	},
	{ role: "user", content: "thanks, continue" },
];

function makeAdvisorRequest(options: { stream: boolean }): {
	request: Request;
	clientBody: Record<string, unknown>;
} {
	const clientBody = {
		model: MODEL,
		max_tokens: 32,
		stream: options.stream,
		tools: [OTHER_TOOL, ADVISOR_TOOL],
		messages: ADVISOR_HISTORY_MESSAGES,
	};
	const request = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": ADVISOR_BETA,
			authorization: "Bearer advisor-test-client",
			"x-claude-code-session-id": "advisor-test-session",
		},
		body: JSON.stringify(clientBody),
	});
	return { request, clientBody };
}

interface UpstreamCall {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function installFetch(
	respond: (call: UpstreamCall, index: number) => Response,
): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			const call: UpstreamCall = {
				url: request.url,
				headers: request.headers,
				body: JSON.parse(await request.text()) as Record<string, unknown>,
			};
			calls.push(call);
			return respond(call, calls.length - 1);
		},
	) as unknown as typeof fetch;
	return calls;
}

function jsonOk(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: MODEL,
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 3, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function sseOk(): Response {
	const events = [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	];
	return new Response(events.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

beforeEach(() => {
	process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
	const collector = {
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	};
	const required = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector as never);
	const optional = spyOn(
		usageCollectorModule,
		"tryGetUsageCollector",
	).mockReturnValue(collector as never);
	restoreUsageCollectors = () => {
		required.mockRestore();
		optional.mockRestore();
	};
});

afterEach(() => {
	restoreUsageCollectors();
	restoreUsageCollectors = (): void => {};
	globalThis.fetch = originalFetch;
	if (originalPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = originalPassthrough;
	}
});

describe("advisor native passthrough dispatch", () => {
	for (const stream of [true, false]) {
		it(`forwards the advisor tool, history and beta unchanged to the first-party account only (stream=${stream})`, async () => {
			const first = makeAccount();
			const codex = makeCodexAccount();
			const { ctx } = makeContext([first, codex]);
			const calls = installFetch(() => (stream ? sseOk() : jsonOk()));
			const { request, clientBody } = makeAdvisorRequest({ stream });

			const response = await handleProxy(
				request,
				new URL(request.url),
				ctx,
				"key-1",
			);
			await response.text();

			expect(response.status).toBe(200);
			expect(calls).toHaveLength(1);
			expect(new URL(calls[0]?.url ?? "").host).toBe("api.anthropic.com");
			expect(calls[0]?.body.tools).toEqual(clientBody.tools as never);
			expect(calls[0]?.body.messages).toEqual(clientBody.messages as never);
			const beta = (calls[0]?.headers.get("anthropic-beta") ?? "").split(",");
			expect(beta).toContain(ADVISOR_BETA);
			expect(beta).toContain("oauth-2025-04-20");
		});
	}

	it("never attempts a non-first-party capacity-deferred route for an advisor request", async () => {
		// Selection is made to miss: the only deferred route points at Codex. The
		// dispatch backstop must refuse it, so no fetch is ever made.
		const codex = makeCodexAccount();
		const { ctx } = makeContext([]);
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const deferred = spyOn(
			accountSelectorModule,
			"getCapacityDeferredModelRoutes",
		).mockReturnValue([
			{
				account: codex,
				model: "gpt-5.6-sol",
				candidateId: `capacity-deferred:${encodeURIComponent(codex.id)}`,
				fallbackRank: 0,
				familyOccurrence: null,
			},
		]);
		const calls = installFetch(() => jsonOk());
		const { request } = makeAdvisorRequest({ stream: false });

		try {
			const response = await handleProxy(
				request,
				new URL(request.url),
				ctx,
				"key-1",
			);
			await response.text();
			expect(deferred).toHaveBeenCalled();
			expect(calls).toHaveLength(0);
			expect(response.status).toBeGreaterThanOrEqual(400);
		} finally {
			deferred.mockRestore();
		}
	});
});

describe("advisor upstream error handling on a first-party account", () => {
	it("passes the advisor-pairing 400 through verbatim after one fetch, with no failover or state written", async () => {
		const a = makeAccount({ id: "anthropic-a", name: "anthropic-a" });
		const b = makeAccount({
			id: "anthropic-b",
			name: "anthropic-b",
			priority: 1,
		});
		const { ctx, mutations } = makeContext([a, b]);
		const calls = installFetch(
			() =>
				new Response(JSON.stringify(ADVISOR_PAIRING_400), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		const { request } = makeAdvisorRequest({ stream: false });

		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(ADVISOR_PAIRING_400);
		expect(calls).toHaveLength(1);
		await Bun.sleep(5);
		expect(mutations.markAccountRateLimited).not.toHaveBeenCalled();
		expect(mutations.pauseAccount).not.toHaveBeenCalled();
		expect(ctx.strategy.reportCandidateFailure).not.toHaveBeenCalled();
		expect(a.rate_limited_until).toBeNull();
		expect(a.paused).toBe(false);
	});

	it("fails a 429 over only to another first-party account and records the rate limit for the first", async () => {
		const a = makeAccount({ id: "anthropic-a", name: "anthropic-a" });
		const b = makeAccount({
			id: "anthropic-b",
			name: "anthropic-b",
			priority: 1,
			access_token: "oauth-access-token-b",
		});
		const codex = makeCodexAccount();
		const { ctx, mutations } = makeContext([a, b, codex]);
		// The real strategy owns availability, so the rate-limit state the 429
		// writes is what makes the later request skip the limited account.
		const strategy = new SessionStrategy();
		strategy.initialize({
			resetAccountSession: mock(() => {}),
			resumeAccount: mock(async () => ({ resumed: true, pauseReason: null })),
		} as unknown as StrategyStore);
		ctx.strategy = strategy;
		const calls = installFetch((call) =>
			call.headers.get("authorization") === "Bearer oauth-access-token"
				? new Response(
						JSON.stringify({
							type: "error",
							error: { type: "rate_limit_error", message: "rate limited" },
						}),
						{
							status: 429,
							headers: {
								"content-type": "application/json",
								"retry-after": "60",
								"anthropic-ratelimit-unified-status": "rejected",
								"anthropic-ratelimit-unified-reset": String(
									Math.floor(Date.now() / 1000) + 3600,
								),
							},
						},
					)
				: jsonOk(),
		);
		const { request } = makeAdvisorRequest({ stream: false });

		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);
		await response.text();

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(new URL(call.url).host).toBe("api.anthropic.com");
		}
		expect(calls[1]?.headers.get("authorization")).toBe(
			"Bearer oauth-access-token-b",
		);
		await Bun.sleep(5);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(1);
		expect(mutations.markAccountRateLimited.mock.calls[0]?.[0]).toBe(
			"anthropic-a",
		);
		expect(a.rate_limited_until).not.toBeNull();

		// A later advisor request skips the limited account and still stays
		// first-party.
		const next = makeAdvisorRequest({ stream: false });
		const nextResponse = await handleProxy(
			next.request,
			new URL(next.request.url),
			ctx,
			"key-1",
		);
		await nextResponse.text();
		expect(nextResponse.status).toBe(200);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.headers.get("authorization")).toBe(
			"Bearer oauth-access-token-b",
		);
	});
});

// A conversation past the hosted replay scan's visit caps gets a hosted replay
// requirement from main's scanHistoricalReplay (it fails closed on truncation),
// and the Anthropic provider owns no hosted server-tool capability, so main
// refuses it with server_tool_capability_unavailable on every route. That is
// main behavior (R16). The advisor gate must not add its own refusal on top: a
// refusal carrying the advisor history text sends Claude Code into a strip and
// retry loop for history that does not exist.
describe("long conversations without advisor content (R16)", () => {
	const LONG_COUNT = 4_200;
	const ADVISOR_PHRASES = [
		"the advisor tool is not available",
		"Advisor tool result content could not be processed",
	];
	const plain = () =>
		Array.from({ length: LONG_COUNT }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: "x",
		}));
	const longRequest = (messages: unknown[]) =>
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				authorization: "Bearer advisor-test-client",
				"x-claude-code-session-id": "advisor-long-session",
			},
			body: JSON.stringify({ model: MODEL, max_tokens: 32, messages }),
		});
	async function send(messages: unknown[]) {
		const { ctx } = makeContext([makeAccount()]);
		const calls = installFetch(() => jsonOk());
		const request = longRequest(messages);
		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);
		const text = await response.text();
		return { calls, status: response.status, text };
	}

	it("does not attach the advisor history refusal to a plain long conversation", async () => {
		const { calls, status, text } = await send(plain());
		for (const phrase of ADVISOR_PHRASES) expect(text).not.toContain(phrase);
		expect(JSON.parse(text).error.code).toBe(
			"server_tool_capability_unavailable",
		);
		expect(status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("refuses long advisor history with the recoverable text, and stripping it removes the advisor refusal", async () => {
		const withHistory = await send([
			...plain(),
			...ADVISOR_HISTORY_MESSAGES.slice(1),
		]);
		expect(withHistory.status).toBe(400);
		expect(withHistory.text).toContain(
			"Advisor tool result content could not be processed",
		);
		expect(withHistory.calls).toHaveLength(0);

		// Claude Code strips the advisor blocks and retries: the retry must not hit
		// the advisor refusal again (it reaches main's own long-conversation
		// behavior instead of looping).
		const stripped = await send([
			...plain(),
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "thanks, continue" },
		]);
		for (const phrase of ADVISOR_PHRASES) {
			expect(stripped.text).not.toContain(phrase);
		}
	});
});
