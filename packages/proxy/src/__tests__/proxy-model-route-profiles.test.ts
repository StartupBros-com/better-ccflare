import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { agentRegistry } from "@better-ccflare/agents";
import type { Account, Agent } from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";
import {
	clearSession,
	getServedAccountObservation,
} from "../session-account-observer";
import type { UsageCollector } from "../usage-collector";

const profileTestCatalog = Object.freeze({
	models: [],
	fetchedAt: 0,
	source: "fallback" as const,
});
let useProfileTestCatalog = false;
const actualModelCatalog = await import("../model-catalog");
const actualGetModelCatalog = actualModelCatalog.getModelCatalog;
const actualIngestModelsListing = actualModelCatalog.ingestModelsListing;

mock.module("../model-catalog", () => ({
	...actualModelCatalog,
	getModelCatalog: () =>
		useProfileTestCatalog
			? Promise.resolve(profileTestCatalog)
			: actualGetModelCatalog(),
	ingestModelsListing: (
		...args: Parameters<typeof actualIngestModelsListing>
	) =>
		useProfileTestCatalog
			? Promise.resolve()
			: actualIngestModelsListing(...args),
}));

const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");

const PROFILE_MODEL = "claude-bccf-route-pro-primary-sol";
const CAPABILITY_PROFILE_MODEL = "claude-bccf-route-sol-capability";
const LOGICAL_MODEL = "claude-opus-5";
const CHILD_MODEL = "claude-sonnet-4-5";
const HAIKU_MODEL = "claude-haiku-4-5";
const ROUTE_ACCOUNT_ID = "route-account-secret";
const SECOND_PROFILE_MODEL = "claude-bccf-route-second-route";
const SECOND_ROUTE_ACCOUNT_ID = "second-route-secret";
const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};
let usageHandleStart = mock(() => undefined);

beforeEach(() => {
	useProfileTestCatalog = true;
	usageHandleStart = mock(() => undefined);
	const collector = {
		handleStart: usageHandleStart,
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as UsageCollector;
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector);
	const tryCollectorSpy = spyOn(
		usageCollectorModule,
		"tryGetUsageCollector",
	).mockReturnValue(collector);
	restoreUsageCollector = () => {
		collectorSpy.mockRestore();
		tryCollectorSpy.mockRestore();
	};
});

afterEach(() => {
	useProfileTestCatalog = false;
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
});

function makeAccount(id = ROUTE_ACCOUNT_ID): Account {
	return {
		id,
		name: id,
		provider: "test-provider" as Account["provider"],
		api_key: "provider-secret",
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
	};
}

function makeRegistry(profileOverrides: Record<string, unknown> = {}) {
	return new ModelRouteSessionRegistry(
		parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "pro-primary-sol",
					displayName: "GPT-5.6 Sol · pro-primary",
					description: "must not leak",
					accountId: ROUTE_ACCOUNT_ID,
					logicalModel: LOGICAL_MODEL,
					defaultEffort: "xhigh",
					expectedProvider: "test-provider",
					...profileOverrides,
				},
			]),
		),
	);
}

function makeCapabilityRegistry() {
	return new ModelRouteSessionRegistry(
		parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "sol-capability",
					displayName: "GPT-5.6 Sol · available account",
					selection: "capability",
					logicalModel: LOGICAL_MODEL,
					defaultEffort: "xhigh",
					expectedProvider: "test-provider",
					expectedPhysicalModel: "gpt-5.6-sol",
				},
			]),
		),
	);
}

function makeTwoProfileRegistry(secondOverrides: Record<string, unknown> = {}) {
	return new ModelRouteSessionRegistry(
		parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "pro-primary-sol",
					displayName: "GPT-5.6 Sol · pro-primary",
					accountId: ROUTE_ACCOUNT_ID,
					logicalModel: LOGICAL_MODEL,
					defaultEffort: "xhigh",
					expectedProvider: "test-provider",
				},
				{
					id: "second-route",
					displayName: "Second route",
					accountId: SECOND_ROUTE_ACCOUNT_ID,
					logicalModel: "claude-fable-5",
					defaultEffort: "max",
					expectedProvider: "test-provider",
					...secondOverrides,
				},
			]),
		),
	);
}

function makeContext(
	registry?: ModelRouteSessionRegistry,
	options: {
		accounts?: Account[];
		normalAccountId?: string;
	} = {},
) {
	const accounts = options.accounts ?? [makeAccount()];
	const firstAccount = accounts[0];
	if (!firstAccount)
		throw new Error("Test context requires at least one account");
	const normalAccount =
		accounts.find((account) => account.id === options.normalAccountId) ??
		firstAccount;
	const strategySelect = mock(() => [normalAccount]);
	const getAllAccounts = mock(async () => accounts);
	const getActiveComboForFamily = mock(async () => null);
	const getAgentPreference = mock(
		async (_agentId: string): Promise<{ model: string } | null> => null,
	);
	const providerCanHandle = mock(() => true);
	const providerBuildUrl = mock(
		(path: string, search: string, account?: Account) =>
			`https://upstream.test/${account?.id ?? "anonymous"}${path}${search}`,
	);
	const anthropicDegradedMode = new AnthropicDegradedModeCoordinator({
		config: {
			mode: "off",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			evidenceWindowMs: 30_000,
			quorum: 2,
			retryMinMs: 5_000,
			retryFallbackMs: 10_000,
			retryMaxMs: 60_000,
			recoveryWindowMs: 30_000,
			probeLeaseMs: 10 * 60_000,
			maxCohorts: 1_024,
		},
	});
	const ctx = {
		strategy: { select: strategySelect },
		anthropicDegradedMode,
		degradedOwnerOverlay: new DegradedOwnerOverlay({
			evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
		}),
		dbOps: {
			getAllAccounts,
			getActiveComboForFamily,
			getAgentPreference,
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
			name: "test-provider",
			canHandle: providerCanHandle,
			buildUrl: providerBuildUrl,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) },
		modelRouteSessionRegistry: registry,
	} as unknown as ProxyContext;
	return {
		ctx,
		strategySelect,
		getAllAccounts,
		getActiveComboForFamily,
		getAgentPreference,
		providerCanHandle,
		providerBuildUrl,
	};
}

function apiRequest(
	path: "/v1/messages" | "/v1/messages/count_tokens",
	model: string,
	headers: Record<string, string> = {},
	body: Record<string, unknown> = {},
): Request {
	return new Request(`https://proxy.local${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			...(path === "/v1/messages" ? { max_tokens: 16 } : {}),
			...body,
		}),
	});
}

function installJsonUpstream(
	payload: unknown = {
		id: "msg",
		type: "message",
		role: "assistant",
		content: [],
	},
) {
	const requests: Request[] = [];
	const fetchMock = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			requests.push(request.clone());
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return { requests, fetchMock };
}

async function fetchedJson(
	request: Request | undefined,
): Promise<Record<string, unknown>> {
	if (!request) throw new Error("Expected an upstream request to be captured");
	return (await request.json()) as Record<string, unknown>;
}

describe("Claude Code gateway model route profiles", () => {
	it("routes a capability profile through the currently available matching account", async () => {
		const pausedPrimary = makeAccount("paused-primary");
		pausedPrimary.paused = true;
		pausedPrimary.model_mappings = JSON.stringify({ opus: "gpt-5.6-sol" });
		const healthySecondary = makeAccount("healthy-secondary");
		healthySecondary.model_mappings = JSON.stringify({ opus: "gpt-5.6-sol" });
		const unrelated = makeAccount("unrelated-terra");
		unrelated.model_mappings = JSON.stringify({ opus: "gpt-5.6-terra" });
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [pausedPrimary, healthySecondary, unrelated],
		});
		harness.strategySelect.mockImplementation(
			(accounts: Account[]) => accounts,
		);
		const { requests } = installJsonUpstream();
		const request = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, {
			"x-claude-code-session-id": "capability-session",
		});

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests[0]?.url).toContain("/healthy-secondary/v1/messages");
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: LOGICAL_MODEL,
			output_config: { effort: "xhigh" },
		});
	});

	it("serves exact safe discovery rows locally with no provider, database, strategy, or fetch work", async () => {
		const harness = makeContext(
			makeRegistry({ expectedPhysicalModel: "physical-model-secret" }),
		);
		const { fetchMock } = installJsonUpstream();
		const request = new Request(
			"https://proxy.local/v1/models?after=provider-cursor&limit=100",
		);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toContain("application/json");
		const raw = await response.text();
		expect(JSON.parse(raw)).toEqual({
			data: [
				{
					id: PROFILE_MODEL,
					display_name: "GPT-5.6 Sol · pro-primary",
				},
			],
			has_more: false,
		});
		for (const secret of [
			"must not leak",
			ROUTE_ACCOUNT_ID,
			LOGICAL_MODEL,
			"physical-model-secret",
		]) {
			expect(raw).not.toContain(secret);
		}
		expect(harness.providerCanHandle).toHaveBeenCalledTimes(0);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.getActiveComboForFamily).toHaveBeenCalledTimes(0);
		expect(harness.getAgentPreference).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it.each([
		"absent",
		"empty",
	] as const)("preserves upstream /v1/models and its query when discovery is %s", async (mode) => {
		const harness = makeContext(
			mode === "empty" ? new ModelRouteSessionRegistry([]) : undefined,
		);
		const upstreamPayload = {
			data: [{ id: "provider-model", display_name: "Provider model" }],
			has_more: true,
		};
		const { requests, fetchMock } = installJsonUpstream(upstreamPayload);
		const request = new Request(
			"https://proxy.local/v1/models?after=provider-cursor&limit=7",
		);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(upstreamPayload);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requests[0]?.url).toBe(
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/models?after=provider-cursor&limit=7`,
		);
		expect(harness.providerCanHandle).toHaveBeenCalledWith("/v1/models");
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it("rewrites an explicit route, pins its account, defaults effort, and records provenance", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const sessionId = "session-1";
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{ "x-claude-code-session-id": sessionId },
			{ output_config: { service_tier: "auto" } },
		);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(1);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: LOGICAL_MODEL,
			output_config: { effort: "xhigh", service_tier: "auto" },
		});
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleStart.mock.calls[0]?.[0]).toMatchObject({
			accountId: ROUTE_ACCOUNT_ID,
			originalModel: PROFILE_MODEL,
			appliedModel: LOGICAL_MODEL,
		});
		expect(getServedAccountObservation(sessionId)).toEqual({
			accountId: ROUTE_ACCOUNT_ID,
			routeProfileId: "pro-primary-sol",
		});
		clearSession(sessionId);
	});

	it("preserves explicit max effort and every other output_config field", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{},
			{
				output_config: {
					effort: "max",
					service_tier: "auto",
					custom_future_field: { enabled: true },
				},
			},
		);
		expect(
			(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect((await fetchedJson(requests[0])).output_config).toEqual({
			effort: "max",
			service_tier: "auto",
			custom_future_field: { enabled: true },
		});
	});

	it("does not override an explicit legacy reasoning effort", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{},
			{
				reasoning: { effort: "high", summary: "auto" },
			},
		);
		expect(
			(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		const upstream = await fetchedJson(requests[0]);
		expect(upstream.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(upstream.output_config).toBeUndefined();
	});

	it.each([
		["parent header", { "x-claude-code-parent-agent-id": "parent-agent" }],
		["agent id", { "x-claude-code-agent-id": "child-agent" }],
		[
			"billing marker",
			{
				"x-anthropic-billing-header": "cc_version=2.1.221; cc_is_subagent=true",
			},
		],
	] as const)("inherits only the account pin for a child detected by %s", async (_label, childMarker) => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const sessionId = `session-${_label.replaceAll(" ", "-")}`;
		const root = apiRequest("/v1/messages", PROFILE_MODEL, {
			"x-claude-code-session-id": sessionId,
		});
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			"x-claude-code-session-id": sessionId,
			...childMarker,
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
		const upstream = await fetchedJson(requests[1]);
		expect(upstream.model).toBe(CHILD_MODEL);
		expect(upstream.output_config).toBeUndefined();
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("clears a session binding on a native root model selection", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "clear-session" };

		for (const request of [
			apiRequest("/v1/messages", PROFILE_MODEL, session),
			apiRequest("/v1/messages", LOGICAL_MODEL, session),
			apiRequest("/v1/messages", CHILD_MODEL, {
				...session,
				"x-claude-code-agent-id": "child-after-clear",
			}),
		]) {
			expect(
				(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		expect(requests.map((request) => request.url)).toEqual([
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			"https://upstream.test/normal-route/v1/messages",
			"https://upstream.test/normal-route/v1/messages",
		]);
		expect(harness.strategySelect).toHaveBeenCalledTimes(2);
	});

	it("does not let a native child request clear the session binding", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "child-keeps-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		await handleProxy(root, new URL(root.url), harness.ctx, "key-1");

		for (const agentId of ["first-child", "second-child"]) {
			const child = apiRequest("/v1/messages", CHILD_MODEL, {
				...session,
				"x-claude-code-agent-id": agentId,
			});
			expect(
				(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		expect(
			requests.every((request) =>
				request.url.includes(`/${ROUTE_ACCOUNT_ID}/`),
			),
		).toBe(true);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("normalizes inherited same-profile picker ids without applying root defaults", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "same-profile-child" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		for (const [label, model] of [
			["leading", ` \t${PROFILE_MODEL}`],
			["trailing", `${PROFILE_MODEL}\n `],
		] as const) {
			const child = apiRequest(
				"/v1/messages",
				model,
				{
					...session,
					"x-claude-code-agent-id": `${label}-same-profile-picker-child`,
				},
				{ output_config: { effort: "low", service_tier: "auto" } },
			);
			expect(
				(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		for (const upstreamRequest of requests.slice(1)) {
			expect(upstreamRequest.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
			expect(await fetchedJson(upstreamRequest)).toMatchObject({
				model: LOGICAL_MODEL,
				output_config: { effort: "low", service_tier: "auto" },
			});
		}
		expect(requests).toHaveLength(3);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("preserves a header-attributed child model rewrite under the inherited account pin", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(
			makeRegistry({ expectedPhysicalModel: LOGICAL_MODEL }),
			{
				accounts: [makeAccount(), fallback],
				normalAccountId: fallback.id,
			},
		);
		harness.getAgentPreference.mockResolvedValue({ model: CHILD_MODEL });
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "header-agent-rewrite" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const child = apiRequest("/v1/messages", PROFILE_MODEL, {
			...session,
			"x-claude-code-agent-id": "claude-code-child",
			"x-better-ccflare-agent-id": "preferred-header-agent",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
		expect(harness.getAgentPreference).toHaveBeenCalledWith(
			"preferred-header-agent",
		);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("normalizes a same-profile picker introduced by a child header preference", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "effective-same-picker-session",
		};
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		harness.getAgentPreference.mockResolvedValue({ model: PROFILE_MODEL });
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "effective-same-picker-child",
			"x-better-ccflare-agent-id": "same-picker-preference",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
		expect((await fetchedJson(requests[1])).model).toBe(LOGICAL_MODEL);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("rejects a different configured picker introduced by a child header preference", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeTwoProfileRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests, fetchMock } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "effective-conflicting-picker-session",
		};
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		harness.getAgentPreference.mockResolvedValue({
			model: SECOND_PROFILE_MODEL,
		});
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "effective-conflicting-picker-child",
			"x-better-ccflare-agent-id": "conflicting-picker-preference",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				type: "model_route_unavailable",
				reason: "conflicting_child_profile",
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
	});

	it("rejects an unknown reserved picker introduced by a child header preference", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests, fetchMock } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "effective-unknown-picker-session",
		};
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		harness.getAgentPreference.mockResolvedValue({
			model: "claude-bccf-route-unknown-preference",
		});
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "effective-unknown-picker-child",
			"x-better-ccflare-agent-id": "unknown-picker-preference",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: "model_route_unavailable", reason: "unknown_profile" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
	});

	it("rejects a picker injected into a native root and clears the prior pin", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests, fetchMock } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "native-root-injected-picker-session",
		};
		const initialRoot = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(
				await handleProxy(
					initialRoot,
					new URL(initialRoot.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);

		harness.getAgentPreference.mockResolvedValue({ model: PROFILE_MODEL });
		const nativeRoot = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-better-ccflare-agent-id": "injected-picker-preference",
		});
		const rejected = await handleProxy(
			nativeRoot,
			new URL(nativeRoot.url),
			harness.ctx,
			"key-1",
		);
		expect(rejected.status).toBe(503);
		expect(await rejected.json()).toMatchObject({
			error: { type: "model_route_unavailable" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-rejected-picker-injection",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[1]?.url).toBe(
			"https://upstream.test/normal-route/v1/messages",
		);
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
	});

	it("keeps the original root picker authoritative over interception", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		harness.getAgentPreference.mockResolvedValue({ model: CHILD_MODEL });
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "authoritative-picker-root-session",
		};
		const root = apiRequest("/v1/messages", PROFILE_MODEL, {
			...session,
			"x-better-ccflare-agent-id": "native-rewrite-preference",
		});
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-authoritative-picker-root",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests.map((request) => request.url)).toEqual([
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
		]);
		expect((await fetchedJson(requests[0])).model).toBe(LOGICAL_MODEL);
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
	});

	it("preserves a prompt-detected child model rewrite under the inherited account pin", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(
			makeRegistry({ expectedPhysicalModel: LOGICAL_MODEL }),
			{
				accounts: [makeAccount(), fallback],
				normalAccountId: fallback.id,
			},
		);
		harness.getAgentPreference.mockResolvedValue({ model: HAIKU_MODEL });
		const promptAgent = {
			id: "fixture-prompt-agent",
			name: "Fixture Prompt Agent",
			description: "Prompt-detected route-profile fixture",
			color: "gray",
			model: null,
			systemPrompt: "You are the fixture prompt agent.",
			source: "global",
			filePath: "/tmp/fixture-prompt-agent.md",
		} satisfies Agent;
		const findAgentSpy = spyOn(
			agentRegistry,
			"findAgentByPrompt",
		).mockResolvedValue(promptAgent);
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "prompt-agent-rewrite" };

		try {
			const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
			expect(
				(await handleProxy(root, new URL(root.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);

			const child = apiRequest(
				"/v1/messages",
				PROFILE_MODEL,
				{
					...session,
					"x-claude-code-agent-id": "prompt-detected-child",
				},
				{ system: promptAgent.systemPrompt },
			);
			expect(
				(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);

			expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
			expect((await fetchedJson(requests[1])).model).toBe(HAIKU_MODEL);
			expect(harness.getAgentPreference).toHaveBeenCalledWith(promptAgent.id);
			expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		} finally {
			findAgentSpy.mockRestore();
		}
	});

	it("rejects a conflicting child picker id locally without replacing the admitted root binding", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeTwoProfileRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests, fetchMock } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "child-profile-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		for (const [label, model] of [
			["leading", ` \t${SECOND_PROFILE_MODEL}`],
			["trailing", `${SECOND_PROFILE_MODEL}\n `],
		] as const) {
			const child = apiRequest(
				"/v1/messages",
				model,
				{
					...session,
					"x-claude-code-agent-id": `${label}-profile-carrying-child`,
				},
				{ output_config: { effort: "low", service_tier: "auto" } },
			);
			const response = await handleProxy(
				child,
				new URL(child.url),
				harness.ctx,
				"key-1",
			);

			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: {
					type: "model_route_unavailable",
					reason: "conflicting_child_profile",
				},
			});
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(1);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);

		const ordinaryChild = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "ordinary-child-after-conflict",
		});
		expect(
			(
				await handleProxy(
					ordinaryChild,
					new URL(ordinaryChild.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);
		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
	});

	it("fails an unbound child profile locally without account or provider work", async () => {
		const harness = makeContext(makeRegistry());
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", PROFILE_MODEL, {
			"x-claude-code-session-id": "unbound-child-session",
			"x-claude-code-agent-id": "unbound-child",
		});
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				type: "model_route_unavailable",
				reason: "unbound_child_profile",
			},
		});
		expect(harness.getAllAccounts).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("isolates identical Claude sessions by authenticated api key id", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "shared-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		await handleProxy(root, new URL(root.url), harness.ctx, "api-key-a");

		const otherCallerChild = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "other-caller-child",
		});
		expect(
			(
				await handleProxy(
					otherCallerChild,
					new URL(otherCallerChild.url),
					harness.ctx,
					"api-key-b",
				)
			).status,
		).toBe(200);

		expect(requests[1]?.url).toContain("/normal-route/");
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it("keeps an explicit route without a session request-scoped", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const explicit = apiRequest("/v1/messages", PROFILE_MODEL);
		await handleProxy(explicit, new URL(explicit.url), harness.ctx, "key-1");

		const unrelatedChild = apiRequest("/v1/messages", CHILD_MODEL, {
			"x-claude-code-session-id": "later-session",
			"x-claude-code-agent-id": "later-child",
		});
		await handleProxy(
			unrelatedChild,
			new URL(unrelatedChild.url),
			harness.ctx,
			"key-1",
		);

		expect(requests.map((request) => request.url)).toEqual([
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			"https://upstream.test/normal-route/v1/messages",
		]);
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it("keeps a credentialless explicit route request-scoped even with a session id", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "credentialless-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx)).status,
		).toBe(200);

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "credentialless-child",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx)).status,
		).toBe(200);
		expect(requests.map((request) => request.url)).toEqual([
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			"https://upstream.test/normal-route/v1/messages",
		]);
		expect(harness.ctx.modelRouteSessionRegistry?.size).toBe(0);
	});

	it.each([
		["absent", undefined],
		["empty", new ModelRouteSessionRegistry([])],
	] as const)("fails an unknown reserved model locally with no database or fetch when the registry is %s", async (_mode, registry) => {
		const harness = makeContext(registry);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			"claude-bccf-route-stale-or-unknown",
		);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: "model_route_unavailable", reason: "unknown_profile" },
		});
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it.each([
		["leading", " \tclaude-bccf-route-stale-or-unknown"],
		["trailing", "claude-bccf-route-stale-or-unknown\n "],
	] as const)("fails a reserved model with %s whitespace locally", async (_label, model) => {
		const harness = makeContext(makeRegistry());
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", model);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: "model_route_unavailable", reason: "unknown_profile" },
		});
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it("fails a configured route whose target account is stale without falling back", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [fallback],
			normalAccountId: fallback.id,
		});
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", PROFILE_MODEL);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		const payload = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(payload.error).toMatchObject({
			type: "force_route_unavailable",
			reason: "not_found",
		});
		expect(payload.error).not.toHaveProperty("account_id");
		expect(JSON.stringify(payload)).not.toContain(ROUTE_ACCOUNT_ID);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it("fails a conflicting public account header closed before database lookup or fetch", async () => {
		const harness = makeContext(makeRegistry());
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", PROFILE_MODEL, {
			"x-better-ccflare-account-id": "some-other-account",
		});
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		const payload = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(payload.error).toMatchObject({
			type: "force_route_unavailable",
			reason: "conflicting_force_route",
		});
		expect(payload.error).not.toHaveProperty("account_id");
		expect(JSON.stringify(payload)).not.toContain(ROUTE_ACCOUNT_ID);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it("keeps the prior admitted binding after a replacement profile fails closed", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeTwoProfileRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "failed-replacement-session",
		};
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const replacement = apiRequest(
			"/v1/messages",
			SECOND_PROFILE_MODEL,
			session,
		);
		const failed = await handleProxy(
			replacement,
			new URL(replacement.url),
			harness.ctx,
			"key-1",
		);
		expect(failed.status).toBe(503);
		expect(JSON.stringify(await failed.json())).not.toContain(
			SECOND_ROUTE_ACCOUNT_ID,
		);

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-failed-replacement",
		});
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);
		expect(requests.map((request) => request.url)).toEqual([
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
		]);
	});

	it("retains account_id for a caller-supplied public force route failure", async () => {
		const harness = makeContext(makeRegistry());
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", CHILD_MODEL, {
			"x-better-ccflare-account-id": "public-missing-account",
		});
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				type: "force_route_unavailable",
				account_id: "public-missing-account",
				reason: "not_found",
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("leaves ordinary non-profile requests on the existing routing path", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const body = {
			output_config: { effort: "medium", service_tier: "auto" },
		};
		const request = apiRequest("/v1/messages", CHILD_MODEL, {}, body);
		expect(
			(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[0]?.url).toContain("/normal-route/");
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: CHILD_MODEL,
			...body,
		});
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it("applies the exact route rewrite, account pin, and default effort to count_tokens", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(makeRegistry(), {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream({ input_tokens: 7 });
		const request = apiRequest(
			"/v1/messages/count_tokens",
			PROFILE_MODEL,
			{ "x-claude-code-session-id": "count-session" },
			{ output_config: { service_tier: "auto" } },
		);
		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ input_tokens: 7 });
		expect(requests[0]?.url).toContain(
			`/${ROUTE_ACCOUNT_ID}/v1/messages/count_tokens`,
		);
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: LOGICAL_MODEL,
			output_config: { effort: "xhigh", service_tier: "auto" },
		});
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});
});
