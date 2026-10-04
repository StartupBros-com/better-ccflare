import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import type {
	Account,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";

// Focused proxy tests must not load ignored embedded worker artifacts.
const { getProvider } = await import("@better-ccflare/providers");
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"./helpers/server-tool-replay-runtime"
);
const READY_SERVER_TOOL_REPLAY_RUNTIME =
	await createReadyServerToolReplayRuntimeForTest();

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

// A hosted-lane stand-in: a registered fake provider whose capability tuple is
// genuinely proven, so selection sees a proven hosted candidate without any
// Codex transport. Its URL echoes the query it was planned with.
function makeHostedAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "hosted-a",
		name: "hosted-a",
		provider: "capability-test",
		priority: 5,
		access_token: "hosted-token",
		expires_at: Date.now() + 60 * 60_000,
		custom_endpoint: "https://capability.invalid/v1/responses",
		model_mappings: JSON.stringify({ sonnet: "claude-sonnet-4-5" }),
		...overrides,
	});
}

function makeHostedProvider(): Provider {
	const provider: Provider = {
		name: "capability-test",
		canHandle: () => true,
		async refreshToken(account) {
			return {
				accessToken: "hosted-token",
				expiresAt: Date.now() + 60_000,
				refreshToken: account.refresh_token ?? "refresh-token",
			};
		},
		buildUrl: (_path, query) =>
			`https://capability.invalid/v1/responses${query}`,
		prepareHeaders: (headers) => new Headers(headers),
		processResponse: async (response) => response,
		parseRateLimit: () => ({ isRateLimited: false }),
		transformRequestBody: async (request) => request,
		createServerToolCapabilityTuple(context): ServerToolCapabilityTuple {
			const { optionProfileId, responseMode, mixedToolMode } =
				context.requirements;
			if (!optionProfileId || !responseMode || !mixedToolMode) {
				throw new Error("Expected exact server-tool requirement profile");
			}
			return {
				candidateId: context.candidateId,
				provider: provider.name,
				authMode: "oauth",
				endpointClass: "test-responses",
				normalizedEndpoint: "https://capability.invalid/v1/responses",
				model: context.physicalModel,
				toolType: "web_search_20250305",
				profile: context.requirements.profileId ?? "missing-profile",
				optionProfile: optionProfileId,
				responseMode,
				mixedToolMode,
				inputReplay: ["native-Anthropic", "proxy-evidence-v1"],
				outputReplay: ["native-Anthropic", "proxy-evidence-v1"],
				providerContractRevision: "capability-test-v1",
				replayDecoderRevision: "server-tool-replay-v1",
				requestTransport: "test-responses-json",
				responseTransport: "test-responses-json",
			};
		},
		resolveServerToolCapability: (_requirements, tuple) => ({
			decision: "proven",
			proof: Object.freeze({
				revision: `proof:${tuple.candidateId}`,
				tuple,
				decision: "proven",
				provenance: "sanitized-test-fixture",
				owner: "websearch-native-passthrough-integration",
				verifiedAt: "2026-07-29T00:00:00.000Z",
				revalidateAfter: "2035-07-29T00:00:00.000Z",
				fixtureRevision: "fixture-v1",
				contractRevision: "capability-test-v1",
				revalidationTriggers: Object.freeze([
					"tuple_change",
					"contract_change",
					"decoder_change",
					"observed_behavior_change",
				]),
			} satisfies ServerToolCapabilityProof),
		}),
	};
	return provider;
}

function makeContext(
	accounts: Account[],
	serverToolReplay: unknown = READY_SERVER_TOOL_REPLAY_RUNTIME,
	hostedProvider?: Provider,
) {
	const mutations = {
		pauseAccount: mock(async () => undefined),
		markAccountRateLimited: mock(
			async (_accountId: string, _until: number, _reason: string) => ({
				consecutiveRateLimits: 1,
				applied: true,
			}),
		),
		updateAccountUsage: mock(async () => undefined),
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
		provider: hostedProvider ?? getProvider("anthropic"),
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mutations.asyncWrite },
		serverToolReplay,
	} as unknown as ProxyContext;
	return { ctx, mutations };
}

const WEB_SEARCH_TOOL = {
	type: "web_search_20250305",
	name: "web_search",
	max_uses: 8,
	allowed_domains: ["example.com"],
	search_profile: "fast",
};
const FORCED_CHOICE = { type: "tool", name: "web_search" };
const CLIENT_BETA = "claude-code-20250219,interleaved-thinking-2025-05-14";

// The WebSearch helper request exactly as Claude Code 2.1.289 sends it.
function makeHelperRequest(
	options: {
		model?: string;
		stream?: boolean;
		toolChoice?: unknown;
		query?: string;
		messages?: unknown[];
		sessionId?: string;
	} = {},
): { request: Request; clientBody: Record<string, unknown> } {
	const clientBody: Record<string, unknown> = {
		model: options.model ?? "claude-opus-5-5",
		max_tokens: 64,
		stream: options.stream ?? false,
		system: [
			{
				type: "text",
				text: "You are an assistant for performing a web search tool use",
			},
		],
		thinking: { type: "disabled" },
		tool_choice: options.toolChoice ?? FORCED_CHOICE,
		tools: [WEB_SEARCH_TOOL],
		messages: options.messages ?? [
			{
				role: "user",
				content: "Perform a web search for the query: bun test isolation",
			},
		],
	};
	const request = new Request(
		`https://proxy.local/v1/messages${options.query ?? "?beta=true"}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": CLIENT_BETA,
				authorization: "Bearer websearch-test-client",
				"x-claude-code-session-id": options.sessionId ?? "websearch-session",
			},
			body: JSON.stringify(clientBody),
		},
	);
	return { request, clientBody };
}

interface UpstreamCall {
	url: string;
	headers: Headers;
	rawBody: string;
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
			const rawBody = await request.text();
			const call: UpstreamCall = {
				url: request.url,
				headers: request.headers,
				rawBody,
				body: JSON.parse(rawBody) as Record<string, unknown>,
			};
			calls.push(call);
			return respond(call, calls.length - 1);
		},
	) as unknown as typeof fetch;
	return calls;
}

function jsonOk(model = "claude-opus-5-5"): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 3, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

const SEARCH_SSE = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{}}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"bun test isolation\\"}"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_01","content":[{"type":"web_search_result","title":"Bun","url":"https://example.com/bun","encrypted_content":"EqgfCioIARgB-anthropic-opaque","page_age":"1 day"}]}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Bun isolates files."}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/bun","title":"Bun","encrypted_index":"Eo8BCioIAhgB-anthropic-opaque","cited_text":"Bun isolates files."}}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":1}}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function sseOk(body = SEARCH_SSE): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function run(
	ctx: ProxyContext,
	request: Request,
): Promise<{ response: Response; text: string }> {
	const response = await handleProxy(
		request,
		new URL(request.url),
		ctx,
		"key-1",
	);
	return { response, text: await response.text() };
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

describe("native web_search passthrough dispatch", () => {
	for (const stream of [true, false]) {
		it(`forwards the whole helper body to the first-party account with beta=true and client betas kept (stream=${stream})`, async () => {
			const { ctx } = makeContext([makeAccount()]);
			const calls = installFetch(() => (stream ? sseOk() : jsonOk()));
			// claude-opus-5 accepts a forced choice, so nothing is demoted here.
			const { request, clientBody } = makeHelperRequest({
				stream,
				model: "claude-opus-5",
			});

			const { response } = await run(ctx, request);

			expect(response.status).toBe(200);
			expect(calls).toHaveLength(1);
			const url = new URL(calls[0]?.url ?? "");
			expect(url.host).toBe("api.anthropic.com");
			expect(url.pathname).toBe("/v1/messages");
			expect(url.searchParams.get("beta")).toBe("true");
			expect(calls[0]?.body).toEqual(clientBody);
			const beta = (calls[0]?.headers.get("anthropic-beta") ?? "").split(",");
			for (const flag of CLIENT_BETA.split(",")) expect(beta).toContain(flag);
			expect(beta).toContain("oauth-2025-04-20");
		});
	}

	it("keeps the forced web_search choice unchanged for a model that supports forced tool choice", async () => {
		const { ctx } = makeContext([makeAccount()]);
		const calls = installFetch(() => jsonOk("claude-opus-5"));
		const { request } = makeHelperRequest({ model: "claude-opus-5" });

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.tool_choice).toEqual(FORCED_CHOICE);
	});

	for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
		it(`demotes only the forced web_search choice to auto for ${model} and forwards everything else`, async () => {
			const { ctx } = makeContext([makeAccount()]);
			const calls = installFetch(() => jsonOk(model));
			const { request, clientBody } = makeHelperRequest({ model });

			const { response } = await run(ctx, request);

			expect(response.status).toBe(200);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.body).toEqual({
				...clientBody,
				tool_choice: { type: "auto" },
			});
		});
	}

	it("leaves an auto tool choice untouched on a model that rejects forced choice", async () => {
		const { ctx } = makeContext([makeAccount()]);
		const calls = installFetch(() => jsonOk());
		const toolChoice = { type: "auto", disable_parallel_tool_use: false };
		const { request, clientBody } = makeHelperRequest({ toolChoice });

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls[0]?.rawBody).toBe(JSON.stringify(clientBody));
	});

	it("logs the demotion at warn level with the model, once for the request", async () => {
		const { Logger } = await import("@better-ccflare/logger");
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(
			() => undefined,
		);
		try {
			const { ctx } = makeContext([makeAccount()]);
			installFetch(() => jsonOk());
			const { request } = makeHelperRequest({ model: "claude-opus-5-5" });

			await run(ctx, request);

			const demotions = warn.mock.calls.filter((call) =>
				String(call[0]).includes("tool_choice"),
			);
			expect(demotions).toHaveLength(1);
			expect(String(demotions[0]?.[0])).toContain("claude-opus-5-5");
		} finally {
			warn.mockRestore();
		}
	});

	it("serves a first-party account with the replay runtime disabled", async () => {
		const { ctx } = makeContext([makeAccount()], { status: "disabled" });
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest();

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]?.url ?? "").host).toBe("api.anthropic.com");
	});

	it("keeps replay_unavailable with zero sends when only a hosted route exists and the runtime is disabled", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const { ctx } = makeContext(
			[makeHostedAccount()],
			{ status: "disabled" },
			makeHostedProvider(),
		);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest({ model: "claude-sonnet-4-5" });

		const { response, text } = await run(ctx, request);

		expect(calls).toHaveLength(0);
		expect(response.status).toBe(503);
		expect(JSON.parse(text).error).toMatchObject({
			code: "server_tool_replay_unavailable",
			reason: "replay_unavailable",
		});
	});

	it("refuses proxy-opaque history with zero sends", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const { ctx } = makeContext([makeAccount()]);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest({
			messages: [
				{ role: "user", content: "search" },
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_x",
							name: "web_search",
							input: { query: "q" },
						},
						{
							type: "web_search_tool_result",
							tool_use_id: "srvtoolu_x",
							content: [
								{
									type: "web_search_result",
									title: "t",
									url: "https://example.com",
									encrypted_content: "bccf1.A256GCM.proxy-envelope",
								},
							],
						},
					],
				},
				{ role: "user", content: "continue" },
			],
		});

		const { response, text } = await run(ctx, request);

		expect(calls).toHaveLength(0);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(JSON.parse(text).error.code).toBe(
			"server_tool_capability_unavailable",
		);
	});

	it("keeps anthropic-compatible and custom-endpoint anthropic accounts at no_implementation", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const compatible = makeAccount({
			id: "compat",
			name: "compat",
			provider: "anthropic-compatible",
			custom_endpoint: "https://compat.example.com",
		});
		const custom = makeAccount({
			id: "custom",
			name: "custom",
			priority: 1,
			custom_endpoint: "https://anthropic-gateway.example.com",
		});
		const { ctx } = makeContext([compatible, custom]);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest();

		const { response, text } = await run(ctx, request);

		expect(calls).toHaveLength(0);
		expect(response.status).toBe(400);
		expect(JSON.parse(text).error).toMatchObject({
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
		});
	});

	it("answers 503 temporary_unavailable with zero fetches when every first-party account is excluded", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const { ctx } = makeContext([
			makeAccount({ id: "a", name: "a", paused: true }),
			makeAccount({ id: "b", name: "b", priority: 1, paused: true }),
		]);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest();

		const { response, text } = await run(ctx, request);

		expect(calls).toHaveLength(0);
		expect(response.status).toBe(503);
		expect(JSON.parse(text).error).toMatchObject({
			code: "route_unavailable",
			reason: "temporary_unavailable",
		});
	});

	it("serves from the available account when the other first-party account is throttled", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const throttled = makeAccount({
			id: "throttled",
			name: "throttled",
			rate_limited_until: Date.now() + 60 * 60_000,
		});
		const available = makeAccount({
			id: "available",
			name: "available",
			priority: 1,
			access_token: "oauth-access-token-available",
		});
		const { ctx } = makeContext([throttled, available]);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest();

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer oauth-access-token-available",
		);
	});

	it("passes streamed server_tool_use, web_search_tool_result and citation bytes to the client unchanged", async () => {
		const { ctx } = makeContext([makeAccount()]);
		installFetch(() => sseOk());
		const { request } = makeHelperRequest({ stream: true });

		const { response, text } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(text).toBe(SEARCH_SSE);
		expect(text).not.toContain("bccf");
	});

	it("passes a non-streamed search response through unchanged", async () => {
		const { ctx } = makeContext([makeAccount()]);
		const upstream = {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [
				{
					type: "server_tool_use",
					id: "srvtoolu_01",
					name: "web_search",
					input: { query: "q" },
				},
				{
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_01",
					content: [
						{
							type: "web_search_result",
							url: "https://example.com",
							title: "t",
							encrypted_content: "EqgfCioIARgB-anthropic-opaque",
						},
					],
				},
			],
			stop_reason: "end_turn",
			usage: {
				input_tokens: 3,
				output_tokens: 1,
				server_tool_use: { web_search_requests: 1 },
			},
		};
		installFetch(
			() =>
				new Response(JSON.stringify(upstream), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const { request } = makeHelperRequest();

		const { response, text } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(JSON.parse(text)).toEqual(upstream);
	});

	it("fails over to the next first-party account on a 429 with ordinary semantics", async () => {
		const a = makeAccount({ id: "a", name: "a" });
		const b = makeAccount({
			id: "b",
			name: "b",
			priority: 1,
			access_token: "oauth-access-token-b",
		});
		const { ctx } = makeContext([a, b]);
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
							},
						},
					)
				: jsonOk(),
		);
		const { request } = makeHelperRequest();

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(new URL(call.url).host).toBe("api.anthropic.com");
			expect(new URL(call.url).searchParams.get("beta")).toBe("true");
		}
	});
});

describe("hosted web_search request contrast", () => {
	it("drops the beta=true query for a hosted candidate, which the native lane keeps", async () => {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		const { ctx } = makeContext(
			[makeHostedAccount()],
			READY_SERVER_TOOL_REPLAY_RUNTIME,
			makeHostedProvider(),
		);
		const calls = installFetch(() => jsonOk());
		const { request } = makeHelperRequest({ model: "claude-sonnet-4-5" });

		const { response } = await run(ctx, request);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]?.url ?? "").host).toBe("capability.invalid");
		expect(new URL(calls[0]?.url ?? "").search).toBe("");
	});
});
