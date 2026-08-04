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
import type { ProxyContext } from "../handlers";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

// Focused proxy tests must not load ignored embedded worker artifacts.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { buildServerToolCapabilityProofKey, usageCache } = await import(
	"@better-ccflare/providers"
);
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");

const MODEL = "claude-sonnet-4-5";
const originalFetch = globalThis.fetch;
const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
const originalServerToolWebSearch = process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH;
let restoreUsageCollectors = (): void => {};

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
	return {
		candidateId: context.candidateId,
		provider: providerName,
		authMode: "oauth",
		endpointClass: "test-responses",
		normalizedEndpoint: "https://capability.invalid/v1/responses",
		model: context.physicalModel,
		toolType: "web_search_20250305",
		profile: context.requirements.profileId ?? "missing-profile",
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
		serverToolReplay: Object.freeze({ status: "disabled" }),
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
		forcedAccountId?: string;
		model?: string;
		query?: string;
	} = {},
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	});
	if (options.agentId) {
		headers.set("x-better-ccflare-agent-id", options.agentId);
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
			stream: false,
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					...(options.invalid
						? {
								allowed_domains: ["example.com"],
								blocked_domains: ["blocked.example"],
							}
						: {}),
				},
			],
		}),
	});
}

beforeEach(() => {
	process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
	process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH = "1";
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
	if (originalServerToolWebSearch === undefined) {
		delete process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH;
	} else {
		process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH = originalServerToolWebSearch;
	}
});

describe("server-tool routing integration", () => {
	it("preserves native server-tool passthrough while admission is default-off", async () => {
		delete process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH;
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

		expect(response.status).toBe(200);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
		expect(refreshCalls.value).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(forwardedBody?.tools).toEqual([
			{
				type: "web_search_20250305",
				name: "web_search",
				allowed_domains: ["example.com"],
				blocked_domains: ["blocked.example"],
			},
		]);
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

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			type: "service_unavailable",
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
	});

	it("stops a declaration-proven replay-ineligible pool before strategy, credentials, provider I/O, mutation, or dispatch", async () => {
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
				capability: {
					structuralCandidateCount: 2,
					provenCandidateCount: 2,
					unsupportedCandidateCount: 0,
					unknownCandidateCount: 0,
					replayIneligibleCandidateCount: 2,
					temporarilyUnavailableProvenCandidateCount: 0,
					eligibleCandidateCount: 0,
				},
			},
		});
		expect(resolveCapability).toHaveBeenCalledTimes(2);
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

		expect(response.status).toBe(503);
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

		expect(response.status).toBe(503);
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
			const request = makeServerToolRequest();
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
});
