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
	Provider,
	ProviderServerToolCapabilityContext,
	ProviderServerToolCapabilityEndpointContract,
} from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	RequestMeta,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
} from "@better-ccflare/types";
import officialSearchStream from "../../../providers/src/providers/codex/__fixtures__/server-tools/official-search-stream.sanitized.json";
import type { ProxyContext } from "../handlers";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

// Focused proxy tests must not load ignored embedded worker artifacts.
const { supportsForcedToolChoice } = await import("@better-ccflare/core");
const { buildServerToolCapabilityProofKey, getProvider, usageCache } =
	await import("@better-ccflare/providers");
const { selectAccountsForRequest } = await import(
	"../handlers/account-selector"
);
const usageCollectorModule = await import("../usage-collector");
const { handleProxy, isHelperShapedServerToolPreview } = await import(
	"../proxy"
);
const { RequestBodyContext } = await import("../request-body-context");
const { codexWebSocketTransport } = await import(
	"../codex-websocket-transport"
);
const {
	createDurableServerToolReplayWriterAdmission,
	createServerToolReplayRuntime,
} = await import("../server-tool-replay-runtime");
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"./helpers/server-tool-replay-runtime"
);
const READY_SERVER_TOOL_REPLAY_RUNTIME =
	await createReadyServerToolReplayRuntimeForTest();

const MODEL = "claude-sonnet-4-5";
const originalFetch = globalThis.fetch;
const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
let restoreUsageCollectors = (): void => {};
let usageHandleStart = mock(() => undefined);
let usageHandleEnd = mock(async () => undefined);

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "capability-account",
		name: "capability-account",
		provider: "capability-test",
		api_key: null,
		refresh_token: "refresh-token",
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
		custom_endpoint: "https://capability.invalid/v1/responses",
		model_mappings: JSON.stringify({ sonnet: MODEL }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeTuple(
	context: ProviderServerToolCapabilityContext,
	providerName: string,
): ServerToolCapabilityTuple {
	const { optionProfileId, responseMode, mixedToolMode } = context.requirements;
	if (!optionProfileId || !responseMode || !mixedToolMode) {
		throw new Error("Expected exact server-tool requirement profile");
	}
	return {
		candidateId: context.candidateId,
		provider: providerName,
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
}

function makeProof(
	tuple: ServerToolCapabilityTuple,
	revision: string,
): ServerToolCapabilityProof {
	return Object.freeze({
		revision,
		tuple,
		decision: "proven",
		provenance: "sanitized-test-fixture",
		owner: "server-tool-routing-integration",
		verifiedAt: "2026-07-29T00:00:00.000Z",
		revalidateAfter: "2035-07-29T00:00:00.000Z",
		fixtureRevision: "fixture-v1",
		contractRevision: tuple.providerContractRevision,
		revalidationTriggers: Object.freeze([
			"tuple_change",
			"contract_change",
			"decoder_change",
			"observed_behavior_change",
		]),
	});
}

function makeProvider(refreshCalls: { value: number }): Provider {
	const provider: Provider = {
		name: "capability-test",
		canHandle: () => true,
		async refreshToken(account) {
			refreshCalls.value++;
			if (account.refresh_token === null) {
				throw new Error(
					"server-tool routing refresh mock requires a refresh token",
				);
			}
			return {
				accessToken: "unexpected-token",
				expiresAt: Date.now() + 60_000,
				refreshToken: account.refresh_token,
			};
		},
		buildUrl: () => "https://capability.invalid/v1/responses",
		prepareHeaders: (headers) => new Headers(headers),
		processResponse: async (response) => response,
		parseRateLimit: () => ({ isRateLimited: false }),
		transformRequestBody: async (request) => request,
		createServerToolCapabilityTuple(context) {
			return makeTuple(context, provider.name);
		},
		resolveServerToolCapability: () => ({
			decision: "unknown",
			reason: "no_exact_proof",
		}),
	};
	return provider;
}

function installDriftingProofResolver(
	provider: Provider,
	driftAccountIds: ReadonlySet<string>,
): Map<string, number> {
	const resolutionCounts = new Map<string, number>();
	provider.resolveServerToolCapability = (_requirements, tuple) => {
		const count = (resolutionCounts.get(tuple.candidateId) ?? 0) + 1;
		resolutionCounts.set(tuple.candidateId, count);
		const accountId = tuple.candidateId.replace(/^account:/, "");
		const revision =
			driftAccountIds.has(accountId) && count > 1
				? `proof-drifted:${tuple.candidateId}`
				: `proof-stable:${tuple.candidateId}`;
		return { decision: "proven", proof: makeProof(tuple, revision) };
	};
	return resolutionCounts;
}

function makeContext(
	accountInput: Account | readonly Account[],
	configureProvider?: (provider: Provider) => void,
) {
	const accounts = Array.isArray(accountInput)
		? [...accountInput]
		: [accountInput];
	const refreshCalls = { value: 0 };
	const mutations = {
		pauseAccount: mock(async () => undefined),
		markAccountRateLimited: mock(async () => undefined),
		updateAccountUsage: mock(async () => undefined),
		asyncWrite: mock(() => undefined),
		reportFailure: mock(
			(_meta: RequestMeta, _failure: Record<string, unknown>) => undefined,
		),
	};
	const getAgentPreference = mock(async () => null as { model: string } | null);
	const provider = makeProvider(refreshCalls);
	configureProvider?.(provider);
	const ctx = {
		strategy: {
			select: mock(async (accounts: Account[]) => accounts),
			reportCandidateFailure: mutations.reportFailure,
			reportCandidateSuccess: mock(() => undefined),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference,
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
		provider,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mutations.asyncWrite },
		serverToolReplay: READY_SERVER_TOOL_REPLAY_RUNTIME,
	} as unknown as ProxyContext;
	return { ctx, refreshCalls, mutations, getAgentPreference, provider };
}

function makeComboRoutingPolicy(
	account: Account,
	options: { comboId?: string; slotId?: string; model?: string } = {},
): ComboRoutingPolicySnapshot {
	const comboId = options.comboId ?? "server-tool-combo";
	const slotId = options.slotId ?? "server-tool-combo-slot";
	const family: ComboFamily = "sonnet";
	return {
		assignment: {
			family,
			combo_id: comboId,
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: {
			id: comboId,
			name: comboId,
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
		},
		slots: [
			{
				id: slotId,
				combo_id: comboId,
				account_id: account.id,
				model: options.model ?? MODEL,
				priority: 0,
				enabled: true,
			},
		],
		rules: [],
		exclusions: [],
	};
}

function installComboRoutingPolicy(
	ctx: ProxyContext,
	policy: ComboRoutingPolicySnapshot,
): void {
	ctx.dbOps.getComboRoutingPolicy = mock(async () => policy);
}

function makeServerToolRequest(
	options: {
		invalid?: boolean;
		agentId?: string;
		claudeCodeAgentId?: string;
		sessionId?: string;
		forcedAccountId?: string;
		model?: string;
		query?: string;
		claudeCodeForcedChoice?: boolean;
		clientFunction?: boolean;
		replayIdentity?: "valid" | "missing" | "ambiguous";
	} = {},
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	});
	if (options.replayIdentity !== "missing") {
		headers.set("authorization", "Bearer server-tool-test-client");
		headers.set(
			"x-claude-code-session-id",
			options.sessionId ?? "server-tool-test-session",
		);
	}
	if (options.replayIdentity === "ambiguous") {
		headers.set("x-api-key", "second-server-tool-test-client");
	}
	if (options.agentId) {
		headers.set("x-better-ccflare-agent-id", options.agentId);
	}
	if (options.claudeCodeAgentId) {
		headers.set("x-claude-code-agent-id", options.claudeCodeAgentId);
	}
	if (options.forcedAccountId) {
		headers.set("x-better-ccflare-account-id", options.forcedAccountId);
	}
	const query = options.query ? `?${options.query.replace(/^\?/, "")}` : "";
	return new Request(`https://proxy.local/v1/messages${query}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: options.model ?? MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			stream: options.claudeCodeForcedChoice === true,
			tools: [
				...(options.clientFunction
					? [
							{
								name: "client_lookup",
								description: "A client-side function tool",
								input_schema: { type: "object", properties: {} },
							},
						]
					: []),
				{
					type: "web_search_20250305",
					name: "web_search",
					...(options.claudeCodeForcedChoice ? { max_uses: 8 } : {}),
					...(options.invalid
						? {
								allowed_domains: ["example.com"],
								blocked_domains: ["blocked.example"],
							}
						: {}),
				},
			],
			...(options.claudeCodeForcedChoice
				? { tool_choice: { type: "tool", name: "web_search" } }
				: {}),
		}),
	});
}

beforeEach(() => {
	process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
	usageHandleStart = mock(() => undefined);
	usageHandleEnd = mock(async () => undefined);
	const collector = {
		handleStart: usageHandleStart,
		handleChunk: mock(() => undefined),
		handleEnd: usageHandleEnd,
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

describe("server-tool routing integration", () => {
	it("inherits an active capability profile for a same-session helper without child markers", async () => {
		const physicalModel = "gpt-5.6-sol";
		const account = makeAccount({
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
			model_mappings: JSON.stringify({
				opus: physicalModel,
				sonnet: MODEL,
			}),
		});
		const tuples: ServerToolCapabilityTuple[] = [];
		const { ctx } = makeContext(account, (provider) => {
			provider.createServerToolCapabilityTuple = (context) => {
				const tuple = makeTuple(context, provider.name);
				tuples.push(tuple);
				return tuple;
			};
			provider.resolveServerToolCapability = (_requirements, tuple) => ({
				decision: "proven",
				proof: makeProof(tuple, `profile-helper:${tuple.candidateId}`),
			});
		});
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "server-tool-sol",
						displayName: "Server tool Sol",
						selection: "capability",
						logicalModel: "claude-opus-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: physicalModel,
					},
				]),
			),
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const root = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer server-tool-test-client",
				"x-claude-code-session-id": "server-tool-test-session",
			},
			body: JSON.stringify({
				model: "claude-bccf-route-server-tool-sol",
				messages: [{ role: "user", content: "establish profile" }],
				max_tokens: 16,
			}),
		});
		expect(
			(await handleProxy(root, new URL(root.url), ctx, "key-1")).status,
		).toBe(200);

		const helper = makeServerToolRequest({ claudeCodeForcedChoice: true });
		const response = await handleProxy(
			helper,
			new URL(helper.url),
			ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(tuples.length).toBeGreaterThan(0);
		expect(tuples.every((tuple) => tuple.model === physicalModel)).toBe(true);
	});

	it("falls from an unavailable capability profile to a global proven helper route", async () => {
		const physicalModel = "gpt-5.6-sol";
		const profileAccount = makeAccount({
			id: "profile-helper-account",
			name: "profile-helper-account",
			access_token: "profile-token",
			expires_at: Date.now() + 60 * 60_000,
			model_mappings: JSON.stringify({ opus: physicalModel, sonnet: MODEL }),
		});
		const globalAccount = makeAccount({
			id: "global-helper-account",
			name: "global-helper-account",
			access_token: "global-token",
			expires_at: Date.now() + 60 * 60_000,
			priority: 10,
			model_mappings: JSON.stringify({
				opus: "global-search-model",
				sonnet: MODEL,
			}),
		});
		const { ctx } = makeContext([profileAccount, globalAccount], (provider) => {
			provider.resolveServerToolCapability = (_requirements, tuple) => ({
				decision: "proven",
				proof: makeProof(tuple, `global-helper:${tuple.candidateId}`),
			});
		});
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "server-tool-soft-profile",
						displayName: "Server tool soft profile",
						selection: "capability",
						logicalModel: "claude-opus-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: physicalModel,
					},
				]),
			),
		);
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ url: request.url }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const root = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer server-tool-test-client",
				"x-claude-code-session-id": "server-tool-test-session",
			},
			body: JSON.stringify({
				model: "claude-bccf-route-server-tool-soft-profile",
				messages: [{ role: "user", content: "establish profile" }],
				max_tokens: 16,
			}),
		});
		expect(
			(await handleProxy(root, new URL(root.url), ctx, "key-1")).status,
		).toBe(200);

		profileAccount.paused = true;
		const helper = makeServerToolRequest();
		const response = await handleProxy(
			helper,
			new URL(helper.url),
			ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: "https://capability.invalid/v1/responses",
		});
	});

	it("validates server-tool requirements without an activation flag", async () => {
		const account = makeAccount({
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
		});
		const { ctx, refreshCalls, mutations } = makeContext(account);
		let forwardedBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (request: Request) => {
			forwardedBody = (await request.clone().json()) as Record<string, unknown>;
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const request = makeServerToolRequest({ invalid: true });

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { type: string; code: string; reason: string };
		};

		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			type: "invalid_request_error",
			code: "server_tool_invalid_requirement",
			reason: "invalid_requirement",
		});
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(forwardedBody).toBeUndefined();
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
	});

	it("validates the winning post-interception requirement locally", async () => {
		const account = makeAccount();
		const { ctx, refreshCalls, mutations, getAgentPreference } =
			makeContext(account);
		getAgentPreference.mockImplementation(async () => ({
			model: "claude-opus-4-8",
		}));
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest({
			invalid: true,
			agentId: "invalid-server-tool-agent",
		});

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { type: string; code: string; reason: string };
		};

		expect(getAgentPreference).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			type: "invalid_request_error",
			code: "server_tool_invalid_requirement",
			reason: "invalid_requirement",
		});
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
	});

	it.each([
		"missing",
		"ambiguous",
	] as const)("fails a %s request-private replay identity before selection or provider I/O", async (replayIdentity) => {
		const account = makeAccount({
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
		});
		const providerIo = {
			buildUrl: mock(() => "https://capability.invalid/v1/responses"),
			prepareHeaders: mock((headers: Headers) => new Headers(headers)),
			processResponse: mock(async (response: Response) => response),
			transformRequestBody: mock(async (request: Request) => request),
		};
		const { ctx, refreshCalls, mutations } = makeContext(
			account,
			(provider) => {
				provider.buildUrl = providerIo.buildUrl;
				provider.prepareHeaders = providerIo.prepareHeaders;
				provider.processResponse = providerIo.processResponse;
				provider.transformRequestBody = providerIo.transformRequestBody;
			},
		);
		globalThis.fetch = mock(async () => new Response(null, { status: 500 }));
		const request = makeServerToolRequest({ replayIdentity });

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			type: "error",
			error: {
				code: "server_tool_replay_unavailable",
				reason: "replay_unavailable",
			},
		});
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(providerIo.buildUrl).toHaveBeenCalledTimes(0);
		expect(providerIo.prepareHeaders).toHaveBeenCalledTimes(0);
		expect(providerIo.processResponse).toHaveBeenCalledTimes(0);
		expect(providerIo.transformRequestBody).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("fails the first durable replay reservation before selection or any provider I/O", async () => {
		const account = makeAccount({
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
		});
		const providerIo = {
			buildUrl: mock(() => "https://capability.invalid/v1/responses"),
			prepareHeaders: mock((headers: Headers) => new Headers(headers)),
			processResponse: mock(async (response: Response) => response),
			transformRequestBody: mock(async (request: Request) => request),
		};
		const { ctx, refreshCalls, mutations } = makeContext(
			account,
			(provider) => {
				provider.buildUrl = providerIo.buildUrl;
				provider.prepareHeaders = providerIo.prepareHeaders;
				provider.processResponse = providerIo.processResponse;
				provider.transformRequestBody = providerIo.transformRequestBody;
			},
		);
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async () => {
				reservationCalls += 1;
				throw new Error("durable issuance unavailable");
			},
		});
		ctx.serverToolReplay = await createServerToolReplayRuntime(
			{
				status: "ready",
				activeKeyId: "integration-active",
				keys: [
					{
						id: "integration-active",
						status: "active",
						key: Array.from({ length: 32 }, (_, index) => index + 1),
					},
				],
			},
			{ writerAdmission: admission.writerAdmission },
		);
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockImplementation(async () => null);
		globalThis.fetch = mock(async () => new Response(null, { status: 500 }));
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			type: "error",
			error: {
				code: "server_tool_replay_unavailable",
				reason: "replay_unavailable",
			},
		});
		expect(reservationCalls).toBe(1);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(providerIo.buildUrl).toHaveBeenCalledTimes(0);
		expect(providerIo.prepareHeaders).toHaveBeenCalledTimes(0);
		expect(providerIo.processResponse).toHaveBeenCalledTimes(0);
		expect(providerIo.transformRequestBody).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(websocketAttempt).toHaveBeenCalledTimes(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		websocketAttempt.mockRestore();
	});

	it("stops an incapable pool before refresh, transport, mutation, or unauthenticated passthrough", async () => {
		const account = makeAccount();
		const { ctx, refreshCalls, mutations } = makeContext(account);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: {
				type: string;
				code: string;
				reason: string;
				capability: Record<string, number>;
			};
		};

		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			type: "invalid_request_error",
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
			capability: {
				structuralCandidateCount: 1,
				provenCandidateCount: 0,
				eligibleCandidateCount: 0,
			},
		});
		expect(refreshCalls.value).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
		expect(response.headers.has("x-better-ccflare-pool-status")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBeFalse();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleStart.mock.calls[0]?.[0]).toMatchObject({
			accountId: null,
			responseStatus: 400,
		});
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd.mock.calls[0]?.[0]).toMatchObject({
			success: false,
			error: "server_tool_no_implementation",
		});
	});

	it("stops a writer-disabled replay runtime before capability work or provider I/O", async () => {
		const first = makeAccount({
			id: "replay-ineligible-first",
			name: "replay-ineligible-first",
		});
		const second = makeAccount({
			id: "replay-ineligible-second",
			name: "replay-ineligible-second",
			priority: 1,
		});
		const providerIo = {
			buildUrl: mock(() => "https://capability.invalid/v1/responses"),
			prepareHeaders: mock((headers: Headers) => new Headers(headers)),
			processResponse: mock(async (response: Response) => response),
			parseRateLimit: mock(() => ({ isRateLimited: false })),
			transformRequestBody: mock(async (request: Request) => request),
		};
		const resolveCapability = mock(
			(
				_requirements: Parameters<
					NonNullable<Provider["resolveServerToolCapability"]>
				>[0],
				tuple: ServerToolCapabilityTuple,
			) => ({
				decision: "proven" as const,
				proof: makeProof(tuple, `proxy-output-only:${tuple.candidateId}`),
			}),
		);
		const { ctx, refreshCalls, mutations } = makeContext(
			[first, second],
			(provider) => {
				provider.buildUrl = providerIo.buildUrl;
				provider.prepareHeaders = providerIo.prepareHeaders;
				provider.processResponse = providerIo.processResponse;
				provider.parseRateLimit = providerIo.parseRateLimit;
				provider.transformRequestBody = providerIo.transformRequestBody;
				provider.createServerToolCapabilityTuple = (context) => ({
					...makeTuple(context, provider.name),
					inputReplay: [],
					outputReplay: ["proxy-evidence-v1"],
				});
				provider.resolveServerToolCapability = resolveCapability;
			},
		);
		ctx.serverToolReplay = await createServerToolReplayRuntime({
			status: "ready",
			activeKeyId: "writer-disabled-active",
			keys: [
				{
					id: "writer-disabled-active",
					status: "active",
					key: Array.from({ length: 32 }, (_, index) => index + 1),
				},
			],
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "service_unavailable",
				code: "server_tool_replay_unavailable",
				reason: "replay_unavailable",
				message:
					"Server-tool replay configuration cannot satisfy this request.",
			},
		});
		expect(resolveCapability).toHaveBeenCalledTimes(0);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(ctx.strategy.reportCandidateSuccess).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(providerIo.buildUrl).toHaveBeenCalledTimes(0);
		expect(providerIo.prepareHeaders).toHaveBeenCalledTimes(0);
		expect(providerIo.processResponse).toHaveBeenCalledTimes(0);
		expect(providerIo.parseRateLimit).toHaveBeenCalledTimes(0);
		expect(providerIo.transformRequestBody).toHaveBeenCalledTimes(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(response.headers.has("retry-after")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-pool-status")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBeFalse();
	});

	it("skips a locally drifted candidate and succeeds through a proven sibling", async () => {
		const first = makeAccount({
			id: "capability-first",
			name: "capability-first",
			api_key: "first-key",
			refresh_token: "",
		});
		const sibling = makeAccount({
			id: "capability-sibling",
			name: "capability-sibling",
			api_key: "sibling-key",
			refresh_token: "",
			priority: 1,
		});
		const { ctx, refreshCalls, mutations } = makeContext(
			[first, sibling],
			(provider) => {
				installDriftingProofResolver(provider, new Set([first.id]));
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("returns one semantic capability terminal when every selected proof drifts locally", async () => {
		const first = makeAccount({
			id: "capability-first",
			name: "capability-first",
			api_key: "first-key",
			refresh_token: "",
		});
		const second = makeAccount({
			id: "capability-second",
			name: "capability-second",
			api_key: "second-key",
			refresh_token: "",
			priority: 1,
		});
		const { ctx, refreshCalls, mutations } = makeContext(
			[first, second],
			(provider) => {
				installDriftingProofResolver(provider, new Set([first.id, second.id]));
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: {
				code: string;
				reason: string;
				capability: Record<string, number>;
			};
		};

		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
			capability: {
				provenCandidateCount: 0,
				unknownCandidateCount: 2,
				eligibleCandidateCount: 0,
			},
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
		expect(response.headers.has("x-better-ccflare-pool-status")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBeFalse();
	});

	it("keeps mixed structural and temporary failures retryable", async () => {
		const provenPaused = makeAccount({
			id: "mixed-proven-paused",
			name: "mixed-proven-paused",
			paused: true,
			pause_reason: "manual",
		});
		const structurallyUnknown = makeAccount({
			id: "mixed-structurally-unknown",
			name: "mixed-structurally-unknown",
			priority: 1,
		});
		const { ctx, refreshCalls, mutations } = makeContext(
			[provenPaused, structurallyUnknown],
			(provider) => {
				provider.resolveServerToolCapability = (_requirements, tuple) =>
					tuple.candidateId === `account:${provenPaused.id}`
						? {
								decision: "proven",
								proof: makeProof(tuple, "mixed-proven-proof"),
							}
						: { decision: "unknown", reason: "no_exact_proof" };
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: {
				code: string;
				reason: string;
				capability: Record<string, number>;
			};
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "route_unavailable",
			reason: "temporary_unavailable",
			capability: {
				structuralCandidateCount: 2,
				provenCandidateCount: 1,
				unknownCandidateCount: 1,
				temporarilyUnavailableProvenCandidateCount: 1,
				eligibleCandidateCount: 0,
			},
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("does not substitute another account when a force-routed proof drifts", async () => {
		const forced = makeAccount({
			id: "capability-forced",
			name: "capability-forced",
			api_key: "forced-key",
			refresh_token: "",
		});
		const substitute = makeAccount({
			id: "capability-substitute",
			name: "capability-substitute",
			api_key: "substitute-key",
			refresh_token: "",
			priority: 1,
		});
		const { ctx, refreshCalls, mutations } = makeContext(
			[forced, substitute],
			(provider) => {
				installDriftingProofResolver(provider, new Set([forced.id]));
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest({ forcedAccountId: forced.id });

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { type: string; code: string; reason: string; account_id: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			type: "force_route_unavailable",
			code: "server_tool_force_route_unavailable",
			reason: "forced_incapable",
			account_id: forced.id,
		});
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("redacts a profile account id when its force-routed proof drifts", async () => {
		const forced = makeAccount({
			id: "profile-capability-forced",
			name: "profile-capability-forced",
			api_key: "forced-key",
			refresh_token: "",
		});
		const substitute = makeAccount({
			id: "profile-capability-substitute",
			name: "profile-capability-substitute",
			api_key: "substitute-key",
			refresh_token: "",
			priority: 1,
		});
		const { ctx, refreshCalls, mutations } = makeContext(
			[forced, substitute],
			(provider) => {
				installDriftingProofResolver(provider, new Set([forced.id]));
			},
		);
		const publicModelId = "claude-bccf-route-server-tool-profile";
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "server-tool-profile",
						displayName: "Server-tool profile",
						accountId: forced.id,
						logicalModel: MODEL,
						expectedProvider: forced.provider,
					},
				]),
			),
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest({ model: publicModelId });

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: Record<string, unknown>;
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			type: "force_route_unavailable",
			code: "server_tool_force_route_unavailable",
			reason: "forced_incapable",
		});
		expect(body.error).not.toHaveProperty("account_id");
		expect(JSON.stringify(body)).not.toContain(forced.id);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("turns an account database exception into a typed local server-tool terminal", async () => {
		const { ctx, refreshCalls, mutations } = makeContext(makeAccount());
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("account database unavailable");
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { code: string; reason: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "route_unavailable",
			reason: "temporary_unavailable",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("turns a combo policy database exception into a typed local server-tool terminal", async () => {
		const { ctx, refreshCalls, mutations } = makeContext(makeAccount());
		ctx.dbOps.getActiveComboForFamily = mock(async () => {
			throw new Error("combo database unavailable");
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { code: string; reason: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "route_unavailable",
			reason: "temporary_unavailable",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("turns a strategy exception into a typed local server-tool terminal", async () => {
		const { ctx, refreshCalls, mutations } = makeContext(
			makeAccount(),
			(provider) => {
				provider.resolveServerToolCapability = (_requirements, tuple) => ({
					decision: "proven",
					proof: makeProof(tuple, "strategy-proof"),
				});
			},
		);
		ctx.strategy.select = mock(async () => {
			throw new Error("strategy unavailable");
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { code: string; reason: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "route_unavailable",
			reason: "temporary_unavailable",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("turns a capability factory exception into a typed local semantic terminal", async () => {
		const { ctx, refreshCalls, mutations } = makeContext(
			makeAccount(),
			(provider) => {
				provider.createServerToolCapabilityTuple = () => {
					throw new Error("capability factory unavailable");
				};
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		const request = makeServerToolRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { code: string; reason: string };
		};

		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});

	it("delivers one retained upstream terminal before a post-combo capability error", async () => {
		const account = makeAccount({
			id: "retained-combo-account",
			name: "retained-combo-account",
			api_key: "retained-key",
			refresh_token: "",
		});
		let fetchCount = 0;
		const { ctx, provider } = makeContext(account, (candidateProvider) => {
			candidateProvider.resolveServerToolCapability = (_requirements, tuple) =>
				fetchCount === 0
					? {
							decision: "proven",
							proof: makeProof(tuple, "retained-proof"),
						}
					: { decision: "unknown", reason: "no_exact_proof" };
		});
		installComboRoutingPolicy(
			ctx,
			makeComboRoutingPolicy(account, {
				comboId: "retained-server-tool-combo",
				slotId: "retained-server-tool-slot",
			}),
		);
		provider.parseRateLimit = (response) => ({
			isRateLimited: response.status === 529,
			resetTime: null,
		});
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "overloaded_error" },
				}),
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-server-tool",
					},
				},
			);
		});
		const previousOverloadRetry = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		try {
			const request = makeServerToolRequest({ claudeCodeForcedChoice: true });
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(fetchCount).toBe(1);
			expect(response.status).toBe(529);
			expect(response.headers.get("x-upstream-proof")).toBe(
				"retained-server-tool",
			);
			expect(await response.json()).toEqual({
				type: "error",
				error: { type: "overloaded_error" },
			});
		} finally {
			if (previousOverloadRetry === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = previousOverloadRetry;
			}
		}
	});

	it("keeps combo-local proof failures disjoint from the active normal fallback wave", async () => {
		const comboAccount = makeAccount({
			id: "wave-combo-account",
			name: "wave-combo-account",
			api_key: "combo-key",
			refresh_token: "",
		});
		const fallbackAccount = makeAccount({
			id: "wave-normal-account",
			name: "wave-normal-account",
			api_key: "normal-key",
			refresh_token: "",
			priority: 1,
		});
		const comboSlotId = "wave-combo-slot";
		const comboCandidateId = `combo:wave-combo:slot:${comboSlotId}`;
		const resolutionCounts = new Map<string, number>();
		const observedCandidateIds: string[] = [];
		const { ctx } = makeContext([comboAccount, fallbackAccount], (provider) => {
			provider.createServerToolCapabilityTuple = (context) => {
				observedCandidateIds.push(context.candidateId);
				return makeTuple(context, provider.name);
			};
			provider.resolveServerToolCapability = (_requirements, tuple) => {
				const count = (resolutionCounts.get(tuple.candidateId) ?? 0) + 1;
				resolutionCounts.set(tuple.candidateId, count);
				const revision =
					tuple.candidateId === comboCandidateId && count > 1
						? "combo-proof-drifted"
						: `proof:${tuple.candidateId}`;
				return { decision: "proven", proof: makeProof(tuple, revision) };
			};
		});
		installComboRoutingPolicy(
			ctx,
			makeComboRoutingPolicy(comboAccount, {
				comboId: "wave-combo",
				slotId: comboSlotId,
			}),
		);
		let strategyCalls = 0;
		ctx.strategy.select = mock(async (accounts) => {
			strategyCalls++;
			return strategyCalls === 1
				? accounts
				: accounts.filter((account) => account.id === fallbackAccount.id);
		});
		ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
		usageCache.set(fallbackAccount.id, {
			five_hour: {
				utilization: 80,
				resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: null },
		});
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ unexpected: true }), { status: 500 }),
		);
		try {
			const request = makeServerToolRequest();
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(529);
			expect(response.headers.has("retry-after")).toBeTrue();
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			expect(observedCandidateIds).toContain(comboCandidateId);
			expect(observedCandidateIds).toContain(`account:${fallbackAccount.id}`);
			expect(comboCandidateId).not.toBe(`account:${fallbackAccount.id}`);
		} finally {
			usageCache.delete(fallbackAccount.id);
		}
	});

	it("binds one proof across selection query form and pretransport URL.search form", async () => {
		const endpointContracts: ProviderServerToolCapabilityEndpointContract[] =
			[];
		const proofKeys: string[] = [];
		const account = makeAccount({
			id: "query-proof-account",
			name: "query-proof-account",
			api_key: "query-key",
			refresh_token: "",
		});
		const { ctx, provider, refreshCalls } = makeContext(
			account,
			(candidateProvider) => {
				candidateProvider.createServerToolCapabilityTuple = (context) => {
					endpointContracts.push(context.endpointContract);
					const base = makeTuple(context, candidateProvider.name);
					return {
						...base,
						endpointClass: context.endpointContract.queryPresent
							? "test-responses-query"
							: "test-responses-no-query",
						providerContractRevision: `capability-test-v1:${context.endpointContract.routeClass}:${context.endpointContract.queryPresent}`,
					};
				};
				candidateProvider.resolveServerToolCapability = (
					_requirements,
					tuple,
				) => {
					const proof = makeProof(tuple, "query-proof");
					const proofKey = buildServerToolCapabilityProofKey(
						proof.revision,
						proof.tuple,
					);
					if (proofKey) proofKeys.push(proofKey);
					return { decision: "proven", proof };
				};
			},
		);
		provider.parseRateLimit = () => ({ isRateLimited: false });
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const request = makeServerToolRequest({ query: "api_key=private-value" });

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(request.url).toContain("?api_key=private-value");
		expect(endpointContracts.length).toBeGreaterThanOrEqual(3);
		expect(endpointContracts).toEqual(
			endpointContracts.map(() => ({
				routeClass: "anthropic_messages",
				queryPresent: true,
			})),
		);
		expect(new Set(proofKeys).size).toBe(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(refreshCalls.value).toBe(0);
	});

	it("treats Claude Code's exact beta Messages query as capability-equivalent", async () => {
		const endpointContracts: ProviderServerToolCapabilityEndpointContract[] =
			[];
		const account = makeAccount({
			id: "claude-code-beta-query-account",
			name: "claude-code-beta-query-account",
			api_key: "query-key",
			refresh_token: "",
		});
		const { ctx, provider } = makeContext(account, (candidateProvider) => {
			candidateProvider.createServerToolCapabilityTuple = (context) => {
				endpointContracts.push(context.endpointContract);
				return makeTuple(context, candidateProvider.name);
			};
			candidateProvider.resolveServerToolCapability = (
				_requirements,
				tuple,
			) => ({
				decision: "proven",
				proof: makeProof(tuple, "beta-query-proof"),
			});
		});
		provider.parseRateLimit = () => ({ isRateLimited: false });
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const request = makeServerToolRequest({
			query: "beta=true",
			claudeCodeForcedChoice: true,
		});

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(request.url).toEndWith("/v1/messages?beta=true");
		expect(endpointContracts.length).toBeGreaterThanOrEqual(3);
		expect(endpointContracts).toEqual(
			endpointContracts.map(() => ({
				routeClass: "anthropic_messages",
				queryPresent: false,
			})),
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps a real Codex hosted-tool profile on its proven physical model", async () => {
		const originalContextAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		try {
			const physicalModel = "gpt-5.6-sol";
			const account = makeAccount({
				id: "real-codex-profile-account",
				name: "real-codex-profile-account",
				provider: "codex",
				api_key: null,
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: Date.now() + 60 * 60_000,
				custom_endpoint: null,
				model_mappings: JSON.stringify({
					opus: physicalModel,
					sonnet: "gpt-5.6-terra",
				}),
			});
			const { ctx } = makeContext(account);
			const codexProvider = getProvider("codex");
			if (!codexProvider) throw new Error("expected registered Codex provider");
			ctx.provider = codexProvider;
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
				parseModelRouteProfiles(
					JSON.stringify([
						{
							id: "real-codex-sol",
							displayName: "Real Codex Sol",
							selection: "capability",
							logicalModel: "claude-opus-5",
							expectedProvider: "codex",
							expectedPhysicalModel: physicalModel,
						},
					]),
				),
			);
			const outboundBodies: Array<Record<string, unknown>> = [];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const outbound = input instanceof Request ? input : new Request(input);
				outboundBodies.push(
					(await outbound.clone().json()) as Record<string, unknown>,
				);
				return new Response(
					officialSearchStream
						.map((event) => {
							const type = (event as { type: string }).type;
							return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
						})
						.join(""),
					{
						headers: {
							"content-type": "text/event-stream",
							"x-better-ccflare-final-model": physicalModel,
						},
					},
				);
			});
			const request = makeServerToolRequest({
				model: "claude-bccf-route-real-codex-sol",
				query: "beta=true",
				claudeCodeForcedChoice: true,
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				ctx,
				"key-1",
			);

			expect(response.status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(outboundBodies).toHaveLength(1);
			expect(outboundBodies[0]).toMatchObject({
				model: physicalModel,
				tools: [{ type: "web_search" }],
				tool_choice: "required",
			});
			expect(outboundBodies[0]).not.toHaveProperty("max_tool_calls");
			expect(outboundBodies[0].include).toEqual([
				"reasoning.encrypted_content",
			]);
		} finally {
			if (originalContextAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = originalContextAdmission;
			}
		}
	});
});

describe("xAI count helpers preserve exact provider intent", () => {
	it.each([
		false,
		true,
	])("returns unsupported without hosted execution or a sibling route (hosted=%s)", async (hosted) => {
		const xai = makeAccount({
			id: "forced-xai-count",
			provider: "xai",
			access_token: null,
			expires_at: null,
			custom_endpoint: null,
			model_mappings: null,
		});
		const sibling = makeAccount({ id: "count-sibling" });
		const { ctx, refreshCalls, mutations } = makeContext([xai, sibling]);
		const provider = getProvider("xai");
		if (!provider) throw new Error("xAI provider missing");
		const refresh = spyOn(provider, "refreshToken").mockResolvedValue({
			accessToken: "mock-token",
			expiresAt: Date.now() + 60_000,
		});
		globalThis.fetch = mock(
			async () => new Response("not expected", { status: 500 }),
		);
		const request = new Request(
			"https://proxy.local/v1/messages/count_tokens",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-account-id": xai.id,
				},
				body: JSON.stringify({
					model: MODEL,
					messages: [{ role: "user", content: "hello" }],
					...(hosted
						? { tools: [{ type: "web_search_20250305", name: "web_search" }] }
						: {}),
				}),
			},
		);
		try {
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(501);
			expect(await response.json()).toMatchObject({
				error: { code: "count_tokens_unsupported", provider: "xai" },
			});
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			expect(refresh).toHaveBeenCalledTimes(0);
			expect(refreshCalls.value).toBe(0);
			expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
			expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
			expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
			expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
			expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
		} finally {
			refresh.mockRestore();
		}
	});
	it("keeps forced xAI hosted generation fail-closed", async () => {
		const xai = makeAccount({
			id: "forced-xai-generation",
			provider: "xai",
			custom_endpoint: null,
			model_mappings: null,
		});
		const { ctx, refreshCalls } = makeContext([
			xai,
			makeAccount({ id: "generation-sibling" }),
		]);
		globalThis.fetch = mock(
			async () => new Response("not expected", { status: 500 }),
		);
		const request = makeServerToolRequest({ forcedAccountId: xai.id });
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				code: "server_tool_force_route_unavailable",
				reason: "forced_incapable",
			},
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
	});
});

describe("count helper declaration validation", () => {
	it("rejects malformed hosted declaration options before credentials without executing them", async () => {
		const xai = makeAccount({
			id: "invalid-xai-count",
			provider: "xai",
			custom_endpoint: null,
			model_mappings: null,
		});
		const { ctx, refreshCalls } = makeContext(xai);
		globalThis.fetch = mock(
			async () => new Response("not expected", { status: 500 }),
		);
		const generation = makeServerToolRequest({
			forcedAccountId: xai.id,
			invalid: true,
		});
		const request = new Request(
			"https://proxy.local/v1/messages/count_tokens",
			{
				method: "POST",
				headers: generation.headers,
				body: await generation.text(),
			},
		);
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "server_tool_invalid_requirement" },
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
	});
	it("fails a forced unknown xAI path locally without URL forwarding or sibling routing", async () => {
		const xai = makeAccount({
			id: "unknown-xai-path",
			provider: "xai",
			custom_endpoint: null,
			model_mappings: null,
		});
		const { ctx, refreshCalls, mutations } = makeContext([
			xai,
			makeAccount({ id: "unknown-sibling" }),
		]);
		globalThis.fetch = mock(
			async () => new Response("not expected", { status: 500 }),
		);
		const request = new Request("https://proxy.local/v1/arbitrary", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": xai.id,
			},
			body: JSON.stringify({ model: MODEL, messages: [] }),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: { code: "provider_path_unknown", provider: "xai" },
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
	});
});

describe("count helper capability before ranking", () => {
	it.each([
		"ordinary",
		"profile",
		"combo",
	] as const)("rejects an all-unsupported %s enrollment before ranking without borrowing another pool", async (enrollment) => {
		const xai = makeAccount({
			id: "enrolled-xai-count",
			provider: "xai",
			custom_endpoint: null,
			model_mappings: JSON.stringify({
				sonnet: enrollment === "profile" ? "grok-count-test" : MODEL,
			}),
		});
		const outside = makeAccount({ id: "outside-count-pool" });
		const { ctx, refreshCalls, mutations } = makeContext(
			enrollment === "ordinary" ? [xai] : [xai, outside],
		);
		if (enrollment === "profile") {
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
				parseModelRouteProfiles(
					JSON.stringify([
						{
							id: "count-only-xai",
							displayName: "Count only xAI",
							selection: "capability",
							logicalModel: MODEL,
							expectedProvider: "xai",
							expectedPhysicalModel: "grok-count-test",
						},
					]),
				),
			);
		} else if (enrollment === "combo") {
			installComboRoutingPolicy(ctx, makeComboRoutingPolicy(xai));
		}
		const xaiProvider = getProvider("xai");
		if (!xaiProvider) throw new Error("xAI provider missing");
		const refresh = spyOn(xaiProvider, "refreshToken").mockResolvedValue({
			accessToken: "unexpected-token",
			expiresAt: Date.now() + 60_000,
		});
		globalThis.fetch = mock(async () => new Response(null, { status: 500 }));
		const request = new Request(
			"https://proxy.local/v1/messages/count_tokens",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model:
						enrollment === "profile"
							? "claude-bccf-route-count-only-xai"
							: MODEL,
					messages: [{ role: "user", content: "hello" }],
					tools: [{ type: "web_search_20250305", name: "web_search" }],
				}),
			},
		);
		try {
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(501);
			expect(await response.json()).toMatchObject({
				error: { code: "count_tokens_unsupported", provider: "xai" },
			});
			expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
			expect(refresh).toHaveBeenCalledTimes(0);
			expect(refreshCalls.value).toBe(0);
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
			expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
			expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
			expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
			expect(mutations.reportFailure).toHaveBeenCalledTimes(0);
		} finally {
			refresh.mockRestore();
		}
	});
	it.each([
		false,
		true,
	])("returns typed unsupported with a default xAI adapter (empty=%s)", async (empty) => {
		const xai = makeAccount({ id: "default-xai-count", provider: "xai" });
		const { ctx, refreshCalls, mutations } = makeContext(empty ? [] : [xai]);
		const provider = getProvider("xai");
		if (!provider) throw new Error("xAI provider missing");
		ctx.provider = provider;
		globalThis.fetch = mock(async () => new Response(null, { status: 500 }));
		const request = new Request(
			"https://proxy.local/v1/messages/count_tokens",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: MODEL,
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({
			error: { code: "count_tokens_unsupported", provider: "xai" },
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		if (!empty) expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
	});
	it("rejects an unsupported descendant root before constructing a global count fallback", async () => {
		const xai = makeAccount({
			id: "descendant-count-root",
			provider: "xai",
			model_mappings: JSON.stringify({ sonnet: "grok-count-test" }),
		});
		const outside = makeAccount({ id: "outside-descendant-count" });
		const { ctx, refreshCalls, mutations } = makeContext([xai, outside]);
		const meta = {
			id: "descendant-count-fixture",
			path: "/v1/messages/count_tokens",
			headers: new Headers(),
			originalModel: MODEL,
			appliedModel: null,
			routeProfileId: "count-xai-profile",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: MODEL,
			routeExpectedProvider: "xai",
			routeExpectedPhysicalModel: "grok-count-test",
			routeProfileExpectedPhysicalModel: "grok-count-test",
			routeLineage: { kind: "descendant" },
		} as RequestMeta;
		await expect(
			selectAccountsForRequest(meta, ctx, MODEL),
		).rejects.toMatchObject({
			name: "CountTokensUnsupportedError",
			providers: ["xai"],
		});
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(meta.routingCandidateCatalog).toBeNull();
		expect(meta.quotaPressureByAccountId).toBeNull();
		expect(refreshCalls.value).toBe(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
	});
	it.each([
		"count_tokens",
		"generation",
	] as const)("filters only count helpers and preserves enrolled unknown compatibility (%s)", async (operation) => {
		const xai = makeAccount({ id: "unsupported-count", provider: "xai" });
		const legacy = makeAccount({ id: "unknown-count" });
		const { ctx } = makeContext([xai, legacy]);
		const seen: string[][] = [];
		ctx.strategy.select = mock(async (accounts: Account[]) => {
			seen.push(accounts.map((account) => account.id));
			// Ordering cannot reintroduce an account excluded by helper capability.
			return [xai, legacy];
		});
		const meta = {
			id: "helper-ranking-fixture",
			path:
				operation === "count_tokens"
					? "/v1/messages/count_tokens"
					: "/v1/messages",
			headers: new Headers(),
			originalModel: MODEL,
			appliedModel: null,
		} as RequestMeta;
		const accounts = await selectAccountsForRequest(meta, ctx, MODEL);
		expect(seen).toEqual([
			operation === "count_tokens" ? [legacy.id] : [xai.id, legacy.id],
		]);
		expect(accounts.map((account) => account.id)).toEqual(
			operation === "count_tokens" ? [legacy.id] : [xai.id, legacy.id],
		);
	});
});

describe("advisor native passthrough request gate", () => {
	const ADVISOR_TOOL = {
		type: "advisor_20260301",
		name: "advisor",
		model: "claude-opus-5",
	};
	const ADVISOR_HISTORY = [
		{
			role: "assistant",
			content: [
				{
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "advisor",
					input: {},
				},
			],
		},
		{ role: "user", content: "continue" },
	];

	function makeFirstPartyAccount(): Account {
		return makeAccount({
			id: "first-party",
			name: "first-party",
			provider: "anthropic",
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
			custom_endpoint: null,
			model_mappings: null,
		});
	}

	function makeAdvisorRequest(
		options: {
			tools?: Array<Record<string, unknown>>;
			messages?: unknown[];
			path?: string;
			replayIdentity?: "valid" | "missing";
		} = {},
	): Request {
		const headers = new Headers({
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
		});
		if (options.replayIdentity !== "missing") {
			headers.set("authorization", "Bearer server-tool-test-client");
			headers.set("x-claude-code-session-id", "server-tool-test-session");
		}
		return new Request(`https://proxy.local${options.path ?? "/v1/messages"}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 16,
				messages: options.messages ?? [{ role: "user", content: "hello" }],
				tools: options.tools ?? [ADVISOR_TOOL],
			}),
		});
	}

	async function refusal(request: Request, accounts: Account[]) {
		const { ctx, refreshCalls, mutations } = makeContext(accounts);
		globalThis.fetch = mock(
			async () => new Response("{}", { status: 500 }),
		) as unknown as typeof fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { code: string; reason: string; message: string };
		};
		return { ctx, refreshCalls, mutations, response, body };
	}

	it("admits an advisor-only request and reaches upstream in exactly one fetch", async () => {
		const { ctx } = makeContext(makeFirstPartyAccount());
		let forwarded: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const outbound = input instanceof Request ? input : new Request(input);
			forwarded = (await outbound.clone().json()) as Record<string, unknown>;
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = makeAdvisorRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(forwarded?.tools).toEqual([ADVISOR_TOOL]);
	});

	it("refuses advisor plus a hosted web_search declaration before replay binding", async () => {
		// A missing replay identity would yield replay_unavailable if binding ran.
		const request = makeAdvisorRequest({
			tools: [
				ADVISOR_TOOL,
				{ type: "web_search_20250305", name: "web_search" },
			],
			replayIdentity: "missing",
		});
		const { ctx, refreshCalls, mutations, response, body } = await refusal(
			request,
			[makeFirstPartyAccount()],
		);

		expect(response.status).toBe(400);
		expect(body.error.reason).toBe("advisor_declaration_unavailable");
		expect(body.error.message).toContain("the advisor tool is not available");
		expect(body.error.message).not.toContain(
			"not available for this organization",
		);
		expect(body.error.message).not.toContain("Input tag");
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(response.headers.has("x-better-ccflare-pool-status")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBeFalse();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageHandleEnd.mock.calls[0]?.[0]).toMatchObject({
			success: false,
			error: "server_tool_advisor_declaration_unavailable",
		});
	});

	it("refuses advisor history beside web-search replay history with the history phrase", async () => {
		const request = makeAdvisorRequest({
			tools: [],
			replayIdentity: "missing",
			messages: [
				...ADVISOR_HISTORY,
				{
					role: "assistant",
					content: [
						{
							type: "web_search_tool_result",
							tool_use_id: "srvtoolu_2",
							content: [
								{
									type: "web_search_result",
									encrypted_content: "bccf1.A256GCM.proxy-envelope",
								},
							],
						},
					],
				},
			],
		});
		const { ctx, response, body } = await refusal(request, [
			makeFirstPartyAccount(),
		]);

		expect(response.status).toBe(400);
		expect(body.error.reason).toBe("advisor_history_unavailable");
		expect(body.error.message).toContain(
			"Advisor tool result content could not be processed",
		);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("refuses a declared unknown advisor type with the declaration phrase", async () => {
		const request = makeAdvisorRequest({
			tools: [{ type: "advisor_20270101", name: "advisor" }],
		});
		const { response, body } = await refusal(request, [
			makeFirstPartyAccount(),
		]);

		expect(response.status).toBe(400);
		expect(body.error.reason).toBe("advisor_declaration_unavailable");
		expect(body.error.code).not.toBe("server_tool_unsupported_requirement");
		expect(body.error.message).toContain("the advisor tool is not available");
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("keeps an unrelated typed tool on server_tool_unsupported_requirement", async () => {
		const request = makeAdvisorRequest({
			tools: [{ type: "code_execution_20250825", name: "code_execution" }],
		});
		const { response, body } = await refusal(request, [
			makeFirstPartyAccount(),
		]);

		expect(response.status).toBe(400);
		expect(body.error.code).toBe("server_tool_unsupported_requirement");
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	it("keeps an advisor-only main-chain request a root while a web_search request stays a helper", async () => {
		async function selectedLineage(request: Request, account: Account) {
			const { ctx } = makeContext(account, (provider) => {
				provider.resolveServerToolCapability = (_requirements, tuple) => ({
					decision: "proven",
					proof: makeProof(tuple, `lineage:${tuple.candidateId}`),
				});
			});
			const lineages: Array<RequestMeta["routeLineage"]> = [];
			ctx.strategy.select = mock(
				async (accounts: Account[], meta: RequestMeta) => {
					lineages.push(meta.routeLineage);
					return accounts;
				},
			);
			globalThis.fetch = mock(
				async () =>
					new Response(JSON.stringify({ type: "message", content: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			) as unknown as typeof fetch;
			await handleProxy(request, new URL(request.url), ctx);
			return lineages;
		}

		const advisor = await selectedLineage(
			makeAdvisorRequest(),
			makeFirstPartyAccount(),
		);
		const hosted = await selectedLineage(
			makeServerToolRequest(),
			makeAccount(),
		);

		expect(advisor.length).toBeGreaterThan(0);
		expect(advisor.every((lineage) => lineage?.kind === "root")).toBe(true);
		expect(hosted.length).toBeGreaterThan(0);
		expect(hosted.every((lineage) => lineage?.kind === "helper")).toBe(true);
	});

	it("neither filters nor refuses count_tokens that declares advisor", async () => {
		const { ctx } = makeContext(makeFirstPartyAccount());
		let seenMeta: RequestMeta | undefined;
		ctx.strategy.select = mock(
			async (accounts: Account[], meta: RequestMeta) => {
				seenMeta = meta;
				return accounts;
			},
		);
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ input_tokens: 3 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const request = makeAdvisorRequest({ path: "/v1/messages/count_tokens" });

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(seenMeta?.nativeAnthropicToolRequirement).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("advisor native-only selection through handleProxy", () => {
	const ADVISOR_TOOL = {
		type: "advisor_20260301",
		name: "advisor",
		model: "claude-opus-5",
	};
	const ADVISOR_BETA = "advisor-tool-2026-03-01";
	const DECLARATION_PHRASE = "the advisor tool is not available";
	const HISTORY_PHRASE = "Advisor tool result content could not be processed";

	function firstParty(): Account {
		return makeAccount({
			id: "advisor-first-party",
			name: "advisor-first-party",
			provider: "anthropic",
			access_token: "test-token",
			expires_at: Date.now() + 60 * 60_000,
			custom_endpoint: null,
			model_mappings: null,
			priority: 5,
		});
	}

	// The default fixture provider is not first-party; it sorts ahead of the
	// first-party account, so only the native constraint keeps it off the request.
	function gateway(overrides: Partial<Account> = {}): Account {
		return makeAccount({
			id: "advisor-gateway",
			name: "advisor-gateway",
			priority: 0,
			api_key: "gateway-key",
			refresh_token: "",
			...overrides,
		});
	}

	function advisorRequest(
		options: {
			model?: string;
			headers?: Record<string, string>;
			tools?: Array<Record<string, unknown>>;
			messages?: unknown[];
		} = {},
	): Request {
		return new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: new Headers({
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": ADVISOR_BETA,
				authorization: "Bearer server-tool-test-client",
				"x-claude-code-session-id": "server-tool-test-session",
				...options.headers,
			}),
			body: JSON.stringify({
				model: options.model ?? MODEL,
				max_tokens: 16,
				messages: options.messages ?? [{ role: "user", content: "hello" }],
				tools: options.tools ?? [ADVISOR_TOOL],
			}),
		});
	}

	async function refused(request: Request, accounts: Account[]) {
		const { ctx, refreshCalls, mutations } = makeContext(accounts);
		globalThis.fetch = mock(
			async () => new Response("{}", { status: 500 }),
		) as unknown as typeof fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: Record<string, unknown> & { message: string };
		};
		return { ctx, refreshCalls, mutations, response, body };
	}

	it("sends the request, tool object and beta header only to the first-party account in a mixed pool (AE1)", async () => {
		const { ctx } = makeContext([gateway(), firstParty()]);
		const fetched: Array<{
			url: string;
			beta: string | null;
			body: Record<string, unknown>;
		}> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const outbound = input instanceof Request ? input : new Request(input);
			fetched.push({
				url: outbound.url,
				beta: outbound.headers.get("anthropic-beta"),
				body: (await outbound.clone().json()) as Record<string, unknown>,
			});
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = advisorRequest();

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetched).toHaveLength(1);
		expect(new URL(fetched[0].url).host).toBe("api.anthropic.com");
		expect(fetched[0].beta).toContain(ADVISOR_BETA);
		expect(fetched[0].body.tools).toEqual([ADVISOR_TOOL]);
		const offered = (ctx.strategy.select as ReturnType<typeof mock>).mock.calls
			.flatMap((call) => call[0] as Account[])
			.map((account) => account.id);
		expect(offered).not.toContain("advisor-gateway");
	});

	it("refuses a route profile pinned to a non-first-party account with no account id and zero fetches (AE2)", async () => {
		const pinned = gateway({ id: "advisor-pinned-gateway" });
		const { ctx, refreshCalls, mutations } = makeContext([
			pinned,
			firstParty(),
		]);
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "advisor-pinned-profile",
						displayName: "Advisor pinned profile",
						accountId: pinned.id,
						logicalModel: MODEL,
						expectedProvider: pinned.provider,
					},
				]),
			),
		);
		globalThis.fetch = mock(
			async () => new Response("{}", { status: 500 }),
		) as unknown as typeof fetch;
		const request = advisorRequest({
			model: "claude-bccf-route-advisor-pinned-profile",
		});

		const response = await handleProxy(request, new URL(request.url), ctx);
		const body = (await response.json()) as {
			error: { message: string; reason: string };
		};

		expect(response.status).toBe(400);
		expect(body.error.reason).toBe("advisor_declaration_unavailable");
		expect(body.error.message).toContain(DECLARATION_PHRASE);
		expect(body.error).not.toHaveProperty("account_id");
		expect(JSON.stringify(body)).not.toContain(pinned.id);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
	});

	it("refuses a header force to a non-first-party account with zero fetches", async () => {
		const request = advisorRequest({
			headers: { "x-better-ccflare-account-id": "advisor-gateway" },
		});
		const { response, body } = await refused(request, [
			gateway(),
			firstParty(),
		]);

		expect(response.status).toBe(400);
		expect(body.error.message).toContain(DECLARATION_PHRASE);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
	});

	describe("when throttling empties the native-filtered pool", () => {
		const throttleFirstParty = (ctx: ProxyContext, account: Account) => {
			ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
			usageCache.set(account.id, {
				five_hour: {
					utilization: 80,
					resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
				},
				seven_day: { utilization: 10, resets_at: null },
			});
		};
		const depleteFirstParty = (account: Account) => {
			usageCache.markModelScopedExhausted(
				account.id,
				MODEL,
				ADVISOR_BETA,
				Date.now() + 60_000,
			);
		};
		const fetchSpy = () => {
			globalThis.fetch = mock(
				async () => new Response("{}", { status: 500 }),
			) as unknown as typeof fetch;
		};
		const cleanup = (account: Account) => {
			usageCache.delete(account.id);
		};

		it("refuses instead of the 529 when the first-party account is predictively throttled and a gateway is available", async () => {
			const first = firstParty();
			const { ctx, mutations } = makeContext([gateway(), first]);
			throttleFirstParty(ctx, first);
			fetchSpy();
			try {
				const request = advisorRequest();
				const response = await handleProxy(request, new URL(request.url), ctx);
				const body = (await response.json()) as {
					error: { message: string; reason: string };
				};

				expect(response.status).toBe(400);
				expect(body.error.reason).toBe("advisor_declaration_unavailable");
				expect(body.error.message).toContain(DECLARATION_PHRASE);
				expect(response.headers.has("retry-after")).toBeFalse();
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
				expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
			} finally {
				cleanup(first);
			}
		});

		it("keeps the 529 when the first-party account is predictively throttled and no other account is available", async () => {
			const first = firstParty();
			const { ctx } = makeContext([first]);
			throttleFirstParty(ctx, first);
			fetchSpy();
			try {
				const request = advisorRequest();
				const response = await handleProxy(request, new URL(request.url), ctx);

				expect(response.status).toBe(529);
				expect(response.headers.has("retry-after")).toBeTrue();
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				cleanup(first);
			}
		});

		it("refuses instead of the model-pool 503 when the first-party account is reactively model-depleted and a gateway is available", async () => {
			const first = firstParty();
			const { ctx } = makeContext([gateway(), first]);
			depleteFirstParty(first);
			fetchSpy();
			try {
				const request = advisorRequest();
				const response = await handleProxy(request, new URL(request.url), ctx);
				const body = (await response.json()) as {
					error: { message: string; reason: string };
				};

				expect(response.status).toBe(400);
				expect(body.error.reason).toBe("advisor_declaration_unavailable");
				expect(body.error.message).toContain(DECLARATION_PHRASE);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				cleanup(first);
			}
		});

		it("keeps the model-pool 503 when the first-party account is reactively model-depleted and no other account is available", async () => {
			const first = firstParty();
			const { ctx } = makeContext([first]);
			depleteFirstParty(first);
			fetchSpy();
			try {
				const request = advisorRequest();
				const response = await handleProxy(request, new URL(request.url), ctx);

				expect(response.status).toBe(503);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				cleanup(first);
			}
		});

		it("refuses with zero fetches under CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1 rather than passing through to Anthropic", async () => {
			process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
			const first = firstParty();
			const { ctx } = makeContext([gateway(), first]);
			throttleFirstParty(ctx, first);
			fetchSpy();
			try {
				const request = advisorRequest();
				const response = await handleProxy(request, new URL(request.url), ctx);

				expect(response.status).toBe(400);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				cleanup(first);
			}
		});
	});

	describe("when the removed non-first-party account is itself usage-blocked", () => {
		const throttleAccount = (ctx: ProxyContext, account: Account) => {
			ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
			usageCache.set(account.id, {
				five_hour: {
					utilization: 80,
					resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
				},
				seven_day: { utilization: 10, resets_at: null },
			});
		};
		const deplete = (account: Account) => {
			usageCache.markModelScopedExhausted(
				account.id,
				MODEL,
				ADVISOR_BETA,
				Date.now() + 60_000,
			);
		};
		const send = async (request: Request, ctx: ProxyContext) => {
			globalThis.fetch = mock(
				async () => new Response("{}", { status: 500 }),
			) as unknown as typeof fetch;
			const response = await handleProxy(request, new URL(request.url), ctx);
			const text = await response.text();
			return { response, text };
		};
		const expectNoAdvisorPhrase = (text: string) => {
			expect(text).not.toContain(DECLARATION_PHRASE);
			expect(text).not.toContain(HISTORY_PHRASE);
		};
		const plainRequest = () => advisorRequest({ tools: [] });

		it("returns the usage-throttle 529, not the refusal, when the only non-first-party account is predictively throttled", async () => {
			const gw = gateway();
			const { ctx } = makeContext([gw]);
			throttleAccount(ctx, gw);
			try {
				const { response, text } = await send(advisorRequest(), ctx);
				expect(response.status).toBe(529);
				expectNoAdvisorPhrase(text);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);

				const control = makeContext([gw]);
				throttleAccount(control.ctx, gw);
				const plain = await send(plainRequest(), control.ctx);
				expect(plain.response.status).toBe(response.status);
			} finally {
				usageCache.delete(gw.id);
			}
		});

		it("returns the model-pool terminal, not the refusal, when the only non-first-party account is reactively depleted", async () => {
			const gw = gateway();
			const { ctx } = makeContext([gw]);
			deplete(gw);
			try {
				const { response, text } = await send(advisorRequest(), ctx);
				expect(response.status).toBe(503);
				expectNoAdvisorPhrase(text);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				usageCache.delete(gw.id);
			}
		});

		it("keeps the 529 when both the first-party and the non-first-party account are throttled", async () => {
			const first = firstParty();
			const gw = gateway();
			const { ctx } = makeContext([gw, first]);
			throttleAccount(ctx, first);
			throttleAccount(ctx, gw);
			try {
				const { response, text } = await send(advisorRequest(), ctx);
				expect(response.status).toBe(529);
				expectNoAdvisorPhrase(text);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				usageCache.delete(first.id);
				usageCache.delete(gw.id);
			}
		});

		it("still refuses when an unthrottled non-first-party account is available and no first-party account is", async () => {
			const first = firstParty();
			const { ctx } = makeContext([gateway(), first]);
			throttleAccount(ctx, first);
			try {
				const { response, text } = await send(advisorRequest(), ctx);
				expect(response.status).toBe(400);
				expect(text).toContain(DECLARATION_PHRASE);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);
			} finally {
				usageCache.delete(first.id);
			}
		});

		it("still refuses when the only non-first-party account is unthrottled", async () => {
			const { ctx } = makeContext([gateway()]);
			const { response, text } = await send(advisorRequest(), ctx);
			expect(response.status).toBe(400);
			expect(text).toContain(DECLARATION_PHRASE);
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		});

		it("returns the usage-throttle 529 for a force-routed non-first-party pin that is predictively throttled", async () => {
			const gw = gateway();
			const forced = { "x-better-ccflare-account-id": gw.id };
			const { ctx } = makeContext([gw, firstParty()]);
			throttleAccount(ctx, gw);
			try {
				const { response, text } = await send(
					advisorRequest({ headers: forced }),
					ctx,
				);
				expect(response.status).toBe(529);
				expectNoAdvisorPhrase(text);
				expect(globalThis.fetch).toHaveBeenCalledTimes(0);

				const control = makeContext([gw, firstParty()]);
				throttleAccount(control.ctx, gw);
				const plain = await send(
					advisorRequest({ tools: [], headers: forced }),
					control.ctx,
				);
				expect(plain.response.status).toBe(response.status);
			} finally {
				usageCache.delete(gw.id);
			}
		});

		it("still refuses a force-routed non-first-party pin that is not throttled", async () => {
			const gw = gateway();
			const { ctx } = makeContext([gw, firstParty()]);
			const { response, text } = await send(
				advisorRequest({ headers: { "x-better-ccflare-account-id": gw.id } }),
				ctx,
			);
			expect(response.status).toBe(400);
			expect(text).toContain(DECLARATION_PHRASE);
			expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		});
	});

	it("refuses a history-only request when only a non-first-party account is available (AE3)", async () => {
		const request = advisorRequest({
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_1",
							name: "advisor",
							input: {},
						},
					],
				},
				{ role: "user", content: "continue" },
			],
		});
		const { ctx, refreshCalls, mutations, response, body } = await refused(
			request,
			[gateway()],
		);

		expect(response.status).toBe(400);
		expect(body.error.reason).toBe("advisor_history_unavailable");
		expect(body.error.message).toContain(HISTORY_PHRASE);
		expect(body.error.message).not.toContain(
			"not available for this organization",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(refreshCalls.value).toBe(0);
		expect(mutations.pauseAccount).toHaveBeenCalledTimes(0);
		expect(mutations.markAccountRateLimited).toHaveBeenCalledTimes(0);
		expect(mutations.updateAccountUsage).toHaveBeenCalledTimes(0);
		expect(mutations.asyncWrite).toHaveBeenCalledTimes(0);
		expect(
			(ctx.strategy.select as ReturnType<typeof mock>).mock.calls.flatMap(
				(call) => call[0] as Account[],
			),
		).toEqual([]);
	});
});

describe("route-profile WebSearch helper falls to the global proven lane", () => {
	const PROFILE_ID = "helper-soft-profile";
	const PICKER = `claude-bccf-route-${PROFILE_ID}`;
	const PHYSICAL = "gpt-5.6-sol";
	const ROOT_BODY = {
		messages: [{ role: "user", content: "establish" }],
		max_tokens: 16,
	};

	function makeNativeAccount(): Account {
		return makeAccount({
			id: "first-party-anthropic",
			name: "first-party-anthropic",
			provider: "anthropic",
			priority: 10,
			custom_endpoint: null,
			model_mappings: null,
			access_token: "anthropic-oauth-token",
			expires_at: Date.now() + 60 * 60_000,
		});
	}

	// The pool account has no hosted proof, so the profile cannot serve a
	// web_search helper itself; only the global lane can.
	function makeSoftProfileHarness(
		logicalModel = "claude-opus-5",
		withNative = true,
		configureProvider?: (provider: Provider) => void,
	) {
		const pool = makeAccount({
			id: "helper-pool-account",
			name: "helper-pool-account",
			access_token: "pool-token",
			expires_at: Date.now() + 60 * 60_000,
			model_mappings: JSON.stringify({ opus: PHYSICAL, sonnet: MODEL }),
		});
		const accounts = withNative ? [pool, makeNativeAccount()] : [pool];
		const harness = makeContext(accounts, configureProvider);
		harness.ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: PROFILE_ID,
						displayName: "Helper soft profile",
						selection: "capability",
						logicalModel,
						expectedProvider: "capability-test",
						expectedPhysicalModel: PHYSICAL,
					},
				]),
			),
		);
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			calls.push({
				url: request.url,
				body: (await request.clone().json()) as Record<string, unknown>,
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		return { ...harness, calls, accounts };
	}

	async function sendRoot(
		ctx: ProxyContext,
		model: string,
		sessionId = "server-tool-test-session",
	): Promise<Response> {
		const root = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer server-tool-test-client",
				"x-claude-code-session-id": sessionId,
			},
			body: JSON.stringify({ model, ...ROOT_BODY }),
		});
		return handleProxy(root, new URL(root.url), ctx, "key-1");
	}

	async function sendHelper(
		ctx: ProxyContext,
		options: Parameters<typeof makeServerToolRequest>[0],
	): Promise<Response> {
		const helper = makeServerToolRequest({
			claudeCodeForcedChoice: true,
			query: "beta=true",
			...options,
		});
		return handleProxy(helper, new URL(helper.url), ctx, "key-1");
	}

	function expectServedNatively(
		calls: { url: string; body: Record<string, unknown> }[],
		sentModelOverride?: string,
	): void {
		const native = calls.slice(1);
		expect(native).toHaveLength(1);
		const url = new URL(native[0]?.url ?? "");
		expect(url.host).toBe("api.anthropic.com");
		expect(url.searchParams.get("beta")).toBe("true");
		const body = native[0]?.body ?? {};
		const model = String(body.model);
		expect(model.startsWith("claude-")).toBe(true);
		if (sentModelOverride) expect(model).toBe(sentModelOverride);
		expect(body.tools).toEqual([
			expect.objectContaining({ type: "web_search_20250305" }),
		]);
		const choice = body.tool_choice as { type: string; name?: string };
		if (supportsForcedToolChoice(model)) {
			expect(choice).toEqual({ type: "tool", name: "web_search" });
		} else {
			expect(choice).toEqual({ type: "auto" });
		}
	}

	it("serves a picker-model helper natively when the profile pool has no hosted proof", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);

		const response = await sendHelper(ctx, { model: PICKER });

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expectServedNatively(calls, "claude-opus-5");
	});

	it("serves a subagent helper inheriting the binding natively, with the profile logical model", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);

		const response = await sendHelper(ctx, {
			model: "claude-opus-5-5",
			claudeCodeAgentId: "agent-1",
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expectServedNatively(calls, "claude-opus-5");
	});

	it("serves a subagent helper that uses the picker model natively", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);

		const response = await sendHelper(ctx, {
			model: PICKER,
			claudeCodeAgentId: "agent-1",
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expectServedNatively(calls, "claude-opus-5");
	});

	it("demotes the forced choice only when the sent model rejects it", async () => {
		const { ctx, calls } = makeSoftProfileHarness("claude-opus-5-5");
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);

		const response = await sendHelper(ctx, { model: PICKER });

		expect(response.status).toBe(200);
		expectServedNatively(calls, "claude-opus-5-5");
		expect((calls[1]?.body.tool_choice as { type: string }).type).toBe("auto");
	});

	it("keeps a legacy exact-account profile fail-closed for a picker-model helper", async () => {
		const exact = makeAccount({
			id: "exact-profile-account",
			name: "exact-profile-account",
			access_token: "exact-token",
			expires_at: Date.now() + 60 * 60_000,
		});
		const { ctx, calls } = makeSoftProfileHarness();
		ctx.dbOps.getAllAccounts = mock(async () => [exact, makeNativeAccount()]);
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "exact-helper-profile",
						displayName: "Exact helper profile",
						accountId: exact.id,
						logicalModel: MODEL,
						expectedProvider: exact.provider,
					},
				]),
			),
		);
		const exactPicker = "claude-bccf-route-exact-helper-profile";
		calls.length = 0;

		const response = await sendHelper(ctx, { model: exactPicker });
		const body = (await response.json()) as {
			error: { type: string; reason: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			type: "force_route_unavailable",
			reason: "forced_incapable",
		});
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		expect(calls).toHaveLength(0);
	});

	it("does not let a served helper rebind the session or disturb the next root", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		const other = "claude-bccf-route-helper-other-profile";
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: PROFILE_ID,
						displayName: "Helper soft profile",
						selection: "capability",
						logicalModel: "claude-opus-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: PHYSICAL,
					},
					{
						id: "helper-other-profile",
						displayName: "Other helper profile",
						selection: "capability",
						logicalModel: "claude-opus-5-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: PHYSICAL,
					},
				]),
			),
		);

		// A helper naming another profile is not a root choice: it must not rebind
		// the session away from the profile the last root picked.
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);
		expect((await sendHelper(ctx, { model: other })).status).toBe(200);
		calls.length = 0;
		const stillBound = await sendHelper(ctx, {
			model: "claude-sonnet-5-5",
			claudeCodeAgentId: "agent-1",
		});
		expect(stillBound.status).toBe(200);
		expect(String(calls[0]?.body.model)).toBe("claude-opus-5");

		// explicit root -> helper -> native root clears the binding.
		expect((await sendHelper(ctx, { model: PICKER })).status).toBe(200);
		expect((await sendRoot(ctx, MODEL)).status).toBe(200);
		calls.length = 0;
		const cleared = await sendHelper(ctx, {
			model: "claude-opus-5-5",
			claudeCodeAgentId: "agent-1",
		});
		expect(cleared.status).toBe(200);
		// No binding is left to inherit, so the body model is not rewritten to
		// the profile's logical model.
		expect(String(calls.at(-1)?.body.model)).toBe("claude-opus-5-5");

		// native root -> helper -> explicit root binds the new profile.
		expect((await sendHelper(ctx, { model: PICKER })).status).toBe(200);
		expect((await sendRoot(ctx, other)).status).toBe(200);
		calls.length = 0;
		const bound = await sendHelper(ctx, {
			model: "claude-sonnet-5-5",
			claudeCodeAgentId: "agent-1",
		});
		expect(bound.status).toBe(200);
		expect(String(calls[0]?.body.model)).toBe("claude-opus-5-5");
	});
	function twoProfileRegistry(
		defaultEffort?: string,
	): ModelRouteSessionRegistry {
		return new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: PROFILE_ID,
						displayName: "Helper soft profile",
						selection: "capability",
						logicalModel: "claude-opus-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: PHYSICAL,
						...(defaultEffort ? { defaultEffort } : {}),
					},
					{
						id: "helper-p2-profile",
						displayName: "Second helper profile",
						selection: "capability",
						logicalModel: "claude-opus-5-5",
						expectedProvider: "capability-test",
						expectedPhysicalModel: PHYSICAL,
					},
				]),
			),
		);
	}

	it("does not let a helper reservation make a concurrent selecting root's commit stale", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		ctx.modelRouteSessionRegistry = twoProfileRegistry();
		const p2Picker = "claude-bccf-route-helper-p2-profile";
		// Hold the native helper's upstream call so its request (and, before the
		// fix, its root-intent reservation) is still live when the root commits.
		let releaseHelper: () => void = () => {};
		const helperGate = new Promise<void>((resolve) => {
			releaseHelper = resolve;
		});
		// Signals that the helper reached its upstream call, so it has already been
		// classified; waiting on this keeps the test free of timing assumptions.
		let helperArrived: () => void = () => {};
		const helperInFlight = new Promise<void>((resolve) => {
			helperArrived = resolve;
		});
		const gatedFetch = globalThis.fetch;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (new URL(url).host === "api.anthropic.com") {
				helperArrived();
				await helperGate;
			}
			return gatedFetch(input);
		}) as unknown as typeof fetch;
		let releaseRoot: () => void = () => {};
		const delayed = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer server-tool-test-client",
				"x-claude-code-session-id": "server-tool-test-session",
			},
			body: new ReadableStream({
				start(controller) {
					releaseRoot = () => {
						controller.enqueue(
							new TextEncoder().encode(
								JSON.stringify({ model: p2Picker, ...ROOT_BODY }),
							),
						);
						controller.close();
					};
				},
			}),
			duplex: "half",
		} as RequestInit);
		const pendingRoot = handleProxy(
			delayed,
			new URL(delayed.url),
			ctx,
			"key-1",
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		// A non-subagent picker-model helper for P1 is classified and in flight
		// while the root still selects.
		const pendingHelper = sendHelper(ctx, { model: PICKER });
		await helperInFlight;
		releaseRoot();
		expect((await pendingRoot).status).toBe(200);
		releaseHelper();
		expect((await pendingHelper).status).toBe(200);

		calls.length = 0;
		const inherited = await sendHelper(ctx, {
			model: "claude-sonnet-5-5",
			claudeCodeAgentId: "agent-1",
		});
		expect(inherited.status).toBe(200);
		// The session is bound to P2 (logicalModel claude-opus-5-5), not P1/none.
		expect(String(calls[0]?.body.model)).toBe("claude-opus-5-5");
	});

	it("does not inject the profile defaultEffort into a picker-model helper, but still into a root", async () => {
		const { ctx, calls } = makeSoftProfileHarness();
		ctx.modelRouteSessionRegistry = twoProfileRegistry("xhigh");
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);
		const rootBody = calls[0]?.body as {
			output_config?: { effort?: string };
		};
		expect(rootBody.output_config?.effort).toBe("xhigh");

		calls.length = 0;
		const response = await sendHelper(ctx, { model: PICKER });
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		const body = calls[0]?.body as { output_config?: { effort?: string } };
		expect(body.output_config?.effort).toBeUndefined();
	});

	it("refuses a picker-model helper with a typed server-tool error when no lane exists", async () => {
		const { ctx, calls } = makeSoftProfileHarness("claude-opus-5", false);
		const response = await sendHelper(ctx, { model: PICKER });
		const body = (await response.json()) as {
			error: { code: string; reason: string };
		};
		expect(response.status).toBe(400);
		expect(body.error).toMatchObject({
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
		});
		expect(calls).toHaveLength(0);
	});

	it("fails a helper-shaped child closed under a bound exact-account profile", async () => {
		const exact = makeAccount({
			id: "exact-profile-account",
			name: "exact-profile-account",
			access_token: "exact-token",
			expires_at: Date.now() + 60 * 60_000,
		});
		const { ctx, calls } = makeSoftProfileHarness();
		ctx.dbOps.getAllAccounts = mock(async () => [exact, makeNativeAccount()]);
		ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "exact-helper-profile",
						displayName: "Exact helper profile",
						accountId: exact.id,
						logicalModel: MODEL,
						expectedProvider: exact.provider,
					},
				]),
			),
		);
		const exactPicker = "claude-bccf-route-exact-helper-profile";
		expect((await sendRoot(ctx, exactPicker)).status).toBe(200);
		calls.length = 0;

		const response = await sendHelper(ctx, {
			model: "claude-opus-5-5",
			claudeCodeAgentId: "agent-1",
		});
		const body = (await response.json()) as {
			error: { type: string; reason: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			type: "force_route_unavailable",
			reason: "forced_incapable",
		});
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		expect(calls).toHaveLength(0);
	});

	it("requires a declared hosted server tool for helper shape", () => {
		const preview = (body: Record<string, unknown>) =>
			new RequestBodyContext(
				new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
			).previewServerToolRequirements();
		const history = [
			{ role: "user", content: "search" },
			{
				role: "assistant",
				content: [
					{
						type: "server_tool_use",
						id: "srvtoolu_hist",
						name: "web_search",
						input: { query: "x" },
					},
				],
			},
			{ role: "user", content: "continue" },
		];
		// No declaration: history replay atoms alone are not a helper.
		const historyOnly = preview({
			model: PICKER,
			max_tokens: 16,
			messages: history,
		});
		expect(historyOnly).toBeDefined();
		expect(isHelperShapedServerToolPreview(historyOnly)).toBe(false);
		const declared = {
			type: "web_search_20250305",
			name: "web_search",
		};
		expect(
			isHelperShapedServerToolPreview(
				preview({
					model: PICKER,
					max_tokens: 16,
					messages: history,
					tools: [declared],
				}),
			),
		).toBe(true);
		// An invalid declaration is still a helper declaration.
		expect(
			isHelperShapedServerToolPreview(
				preview({
					model: PICKER,
					max_tokens: 16,
					messages: history,
					tools: [
						{
							...declared,
							allowed_domains: ["a.example"],
							blocked_domains: ["b.example"],
						},
					],
				}),
			),
		).toBe(true);
		// Client functions alongside the declaration: a real main-loop turn.
		expect(
			isHelperShapedServerToolPreview(
				preview({
					model: PICKER,
					max_tokens: 16,
					messages: history,
					tools: [
						declared,
						{ name: "client_lookup", input_schema: { type: "object" } },
					],
				}),
			),
		).toBe(false);
		// An unrecognized typed tool (here a client tool labelled type "custom",
		// which the classifier files as unsupported) means the request cannot be
		// proven a helper, so it keeps root-intent and lineage behaviour.
		expect(
			isHelperShapedServerToolPreview(
				preview({
					model: PICKER,
					max_tokens: 16,
					messages: history,
					tools: [
						declared,
						{
							type: "custom",
							name: "client_lookup",
							input_schema: { type: "object" },
						},
					],
				}),
			),
		).toBe(false);
		expect(isHelperShapedServerToolPreview(undefined)).toBe(false);
	});

	it("keeps a picker-model main-loop root that declares web_search plus client functions a root", async () => {
		const { ctx, calls } = makeSoftProfileHarness(
			"claude-opus-5",
			true,
			(provider) => {
				provider.resolveServerToolCapability = (_requirements, tuple) => ({
					decision: "proven",
					proof: makeProof(tuple, `pool-proof:${tuple.candidateId}`),
				});
			},
		);
		const profileIds: Array<string | null | undefined> = [];
		const lineages: Array<RequestMeta["routeLineage"]> = [];
		ctx.strategy.select = mock(
			async (accounts: Account[], meta: RequestMeta) => {
				profileIds.push(meta.routeProfileId);
				lineages.push(meta.routeLineage);
				return accounts;
			},
		);

		const root = await sendHelper(ctx, {
			model: PICKER,
			clientFunction: true,
			claudeCodeForcedChoice: false,
		});
		expect(root.status).toBe(200);
		expect(new URL(calls[0]?.url ?? "").host).toBe("capability.invalid");
		expect(lineages.every((lineage) => lineage?.kind === "root")).toBe(true);

		// The root committed the profile binding: a later stock-model subagent
		// helper inherits it.
		profileIds.length = 0;
		const helper = await sendHelper(ctx, {
			model: "claude-opus-5-5",
			claudeCodeAgentId: "agent-1",
		});
		expect(helper.status).toBe(200);
		expect(profileIds.length).toBeGreaterThan(0);
		expect(profileIds.every((id) => id === PROFILE_ID)).toBe(true);
	});

	it("keeps a subagent request that declares web_search plus client functions a descendant", async () => {
		const { ctx } = makeSoftProfileHarness(
			"claude-opus-5",
			true,
			(provider) => {
				provider.resolveServerToolCapability = (_requirements, tuple) => ({
					decision: "proven",
					proof: makeProof(tuple, `pool-proof:${tuple.candidateId}`),
				});
			},
		);
		const lineages: Array<RequestMeta["routeLineage"]> = [];
		ctx.strategy.select = mock(
			async (accounts: Account[], meta: RequestMeta) => {
				lineages.push(meta.routeLineage);
				return accounts;
			},
		);
		expect((await sendRoot(ctx, PICKER)).status).toBe(200);
		lineages.length = 0;

		const response = await sendHelper(ctx, {
			model: PICKER,
			claudeCodeAgentId: "agent-1",
			clientFunction: true,
			claudeCodeForcedChoice: false,
		});

		expect(response.status).toBe(200);
		expect(lineages.length).toBeGreaterThan(0);
		expect(lineages.every((lineage) => lineage?.kind === "descendant")).toBe(
			true,
		);
	});
});
