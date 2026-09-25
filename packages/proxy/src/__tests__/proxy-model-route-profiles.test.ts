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
import { type CodexCatalogEvt, codexCatalogEvents } from "@better-ccflare/core";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import { handleResponsesRequest } from "@better-ccflare/openai-responses-adapter";
import {
	clearDerivedProviderModelDefaults,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, Agent } from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import {
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
} from "../codex-model-catalog";
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
const codexModelCatalogModule = await import("../codex-model-catalog");
const serverToolReplayRuntimeModule = await import(
	"../server-tool-replay-runtime"
);
const { handleProxy } = await import("../proxy");

const PROFILE_MODEL = "claude-bccf-route-pro-primary-sol";
const PROFILE_MODEL_1M = `${PROFILE_MODEL}[1m]`;
const CAPABILITY_PROFILE_MODEL = "claude-bccf-route-sol-capability";
const LOGICAL_MODEL = "claude-opus-5";
const CHILD_MODEL = "claude-sonnet-4-5";
const HAIKU_MODEL = "claude-haiku-4-5";
const ROUTE_ACCOUNT_ID = "route-account-secret";
const SECOND_PROFILE_MODEL = "claude-bccf-route-second-route";
const SECOND_ROUTE_ACCOUNT_ID = "second-route-secret";
const ADAPTER_SECRET = "profile-test-process-secret";
const ADAPTER_SECRET_HEADER = "x-better-ccflare-responses-adapter-secret";
const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};
let usageHandleStart = mock(
	(_event: Parameters<UsageCollector["handleStart"]>[0]) => undefined,
);
let usageHandleEnd = mock(
	async (_event: Parameters<UsageCollector["handleEnd"]>[0]) => undefined,
);

beforeEach(() => {
	useProfileTestCatalog = true;
	usageCache.clear();
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	usageHandleStart = mock(
		(_event: Parameters<UsageCollector["handleStart"]>[0]) => undefined,
	);
	usageHandleEnd = mock(
		async (_event: Parameters<UsageCollector["handleEnd"]>[0]) => undefined,
	);
	const collector = {
		handleStart: usageHandleStart,
		handleChunk: mock(() => undefined),
		handleEnd: usageHandleEnd,
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
	usageCache.clear();
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
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

function makeClock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function makeRegistry(
	profileOverrides: Record<string, unknown> = {},
	options?: ConstructorParameters<typeof ModelRouteSessionRegistry>[1],
) {
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
		options,
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
		strategy?: ProxyContext["strategy"];
	} = {},
) {
	const accounts = options.accounts ?? [makeAccount()];
	const firstAccount = accounts[0];
	if (!firstAccount)
		throw new Error("Test context requires at least one account");
	const normalAccount =
		accounts.find((account) => account.id === options.normalAccountId) ??
		firstAccount;
	const strategySelect = mock<(accounts: Account[]) => Account[]>(() => [
		normalAccount,
	]);
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
		strategy: options.strategy ?? { select: strategySelect },
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
			getCodexImplicitRouteEnabled: () =>
				process.env.CCFLARE_CODEX_IMPLICIT_ROUTE !== "0",
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
		internalProbeSecret: ADAPTER_SECRET,
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
		headers: {
			"content-type": "application/json",
			// Carrier fixtures represent the adapter's synthetic requests by default.
			...(body.__better_ccflare_codex_passthrough
				? { [ADAPTER_SECRET_HEADER]: ADAPTER_SECRET }
				: {}),
			...headers,
		},
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
	responsesSse = false,
) {
	const requests: Request[] = [];
	const fetchMock = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			requests.push(request.clone());
			const serialized = JSON.stringify(payload);
			return new Response(
				responsesSse
					? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`
					: serialized,
				{
					status: 200,
					headers: {
						"content-type": responsesSse
							? "text/event-stream"
							: "application/json",
					},
				},
			);
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
	it.each([
		{ label: "missing marker", marker: undefined, secret: ADAPTER_SECRET },
		{ label: "wrong marker", marker: "client-forgery", secret: ADAPTER_SECRET },
		{ label: "empty process secret", marker: "", secret: "" },
		{
			label: "missing process secret",
			marker: ADAPTER_SECRET,
			secret: undefined,
		},
	])("ignores a forged direct Messages carrier with $label", async ({
		marker,
		secret,
	}) => {
		const normal = makeAccount("ordinary-account");
		const codex = makeAccount("unprimed-codex-account");
		codex.provider = "codex";
		codex.access_token = "codex-test-token";
		codex.expires_at = Date.now() + 3_600_000;
		const harness = makeContext(undefined, {
			accounts: [normal, codex],
			normalAccountId: normal.id,
		});
		harness.ctx.internalProbeSecret = secret;
		const { requests } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			"claude-sonnet-5",
			{},
			{
				__better_ccflare_codex_passthrough: { model: "gpt-6-astra" },
			},
		);
		if (marker === undefined) request.headers.delete(ADAPTER_SECRET_HEADER);
		else request.headers.set(ADAPTER_SECRET_HEADER, marker);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain(`/${normal.id}/v1/messages`);
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: "claude-sonnet-5",
		});
		expect(
			requests.every((sent) => !new URL(sent.url).pathname.endsWith("/models")),
		).toBe(true);
		expect(harness.strategySelect).toHaveBeenCalledTimes(1);
	});

	it.each([
		"gpt-6-astra",
		"codex-auto-review",
	])("routes the physical Responses model %s to Codex and preserves its wire model", async (rawModel) => {
		const codex = makeAccount("implicit-codex-account");
		codex.provider = "codex";
		codex.access_token = "codex-test-token";
		codex.expires_at = Date.now() + 3_600_000;
		codex.model_mappings = JSON.stringify({
			opus: rawModel,
			sonnet: "gpt-5.6-sol",
		});
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [codex],
		});
		const discover = async () => {
			const request = new Request("https://proxy.local/v1/models");
			const response = await handleProxy(
				request,
				new URL(request.url),
				harness.ctx,
				"key-1",
			);
			return response.text();
		};
		const discoveryBefore = await discover();
		harness.getAllAccounts.mockClear();
		const { requests } = installJsonUpstream(
			{
				id: "resp-implicit",
				object: "response",
				status: "completed",
				model: rawModel,
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
			true,
		);
		const request = new Request("https://proxy.local/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[ADAPTER_SECRET_HEADER]: "client-forgery",
			},
			body: JSON.stringify({ model: rawModel, input: "hello" }),
		});

		const response = await handleResponsesRequest(
			request,
			new URL(request.url),
			(syntheticRequest, url) =>
				handleProxy(syntheticRequest, url, harness.ctx, "key-1"),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(await fetchedJson(requests[0])).toMatchObject({ model: rawModel });
		expect(
			harness.strategySelect.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual([codex.id]);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(1);
		expect(await discover()).toBe(discoveryBefore);
	});

	it.each([
		"account lookup",
		"catalog discovery",
		"resolver self-expiry",
	] as const)("returns a retryable selection timeout when implicit route %s exceeds its deadline", async (phase) => {
		const previous = process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
		process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = "5";
		const codex = makeAccount("implicit-timeout-codex");
		codex.provider = "codex";
		codex.api_key = null;
		codex.access_token = "codex-test-token";
		codex.expires_at = Date.now() + 3_600_000;
		const harness = makeContext(undefined, { accounts: [codex] });
		harness.ctx.dbOps.getAccount = mock(async () => codex);
		let clockSpy: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
		let settleCatalog: ((response: Response) => void) | undefined;
		try {
			if (phase === "account lookup") {
				harness.getAllAccounts.mockImplementation(() => new Promise(() => {}));
			} else if (phase === "resolver self-expiry") {
				let now = Date.now();
				clockSpy = spyOn(Date, "now").mockImplementation(() => now);
				harness.getAllAccounts.mockImplementation(async () => {
					// Expire before the resolver runs, without yielding to its timer.
					now += 100;
					return [codex];
				});
			}
			const catalogResponse = new Promise<Response>((resolve) => {
				settleCatalog = resolve;
			});
			const fetchMock = mock((_input: RequestInfo | URL) => catalogResponse);
			globalThis.fetch = fetchMock as unknown as typeof fetch;
			const request = apiRequest(
				"/v1/messages",
				"claude-sonnet-5",
				{},
				{
					__better_ccflare_codex_passthrough: { model: "gpt-6-astra" },
				},
			);

			const response = await handleProxy(
				request,
				new URL(request.url),
				harness.ctx,
				"key-1",
			);

			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("1");
			expect(await response.json()).toMatchObject({
				error: {
					code: "route_unavailable",
					routing_diagnostics: { zero_attempt_reason: "selection_timeout" },
				},
			});
			expect(harness.strategySelect).toHaveBeenCalledTimes(0);
			expect(fetchMock).toHaveBeenCalledTimes(
				phase === "catalog discovery" ? 1 : 0,
			);
			if (phase === "catalog discovery") {
				expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
					"/backend-api/codex/models?",
				);
			}
		} finally {
			clockSpy?.mockRestore();
			settleCatalog?.(new Response(null, { status: 503 }));
			if (phase === "catalog discovery") {
				// Settle the shared catalog work before the next test clears its cache.
				await ensureCodexModelDefaults(codex, harness.ctx);
			}
			if (previous === undefined)
				delete process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
			else process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = previous;
		}
	});

	it("leaves ordinary routing active when the implicit route kill switch is off", async () => {
		const previous = process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
		process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = "0";
		try {
			const harness = makeContext();
			const { requests } = installJsonUpstream();
			const request = apiRequest(
				"/v1/messages",
				"claude-sonnet-5",
				{},
				{
					__better_ccflare_codex_passthrough: { model: "gpt-6-astra" },
				},
			);

			const response = await handleProxy(
				request,
				new URL(request.url),
				harness.ctx,
				"key-1",
			);

			expect(response.status).toBe(200);
			expect(await fetchedJson(requests[0])).toMatchObject({
				model: "claude-sonnet-5",
			});
		} finally {
			if (previous === undefined)
				delete process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
			else process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = previous;
		}
	});

	it("rejects physical Responses routing on a child lineage before account selection", async () => {
		const harness = makeContext();
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			"claude-sonnet-5",
			{
				"x-claude-code-agent-id": "implicit-child",
			},
			{
				__better_ccflare_codex_passthrough: { model: "gpt-6-astra" },
			},
		);

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
				message: "Model route gpt-6-astra is unavailable",
				reason: "model_mapping_mismatch",
			},
		});
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it("keeps an operator profile authoritative when a Responses carrier names a physical Codex model", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{},
			{
				__better_ccflare_codex_passthrough: { model: "gpt-6-astra" },
			},
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests[0]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/v1/messages`);
		expect(await fetchedJson(requests[0])).toMatchObject({
			model: LOGICAL_MODEL,
			output_config: { effort: "xhigh" },
		});
	});

	it("leaves model discovery byte-identical with the implicit route enabled or disabled", async () => {
		const previous = process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
		try {
			const harness = makeContext(makeCapabilityRegistry());
			const { fetchMock } = installJsonUpstream();
			const discover = async () => {
				const request = new Request("https://proxy.local/v1/models");
				return handleProxy(request, new URL(request.url), harness.ctx, "key-1");
			};
			process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = "0";
			const before = await discover();
			process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = "1";
			const after = await discover();

			expect(before.status).toBe(200);
			expect(after.status).toBe(200);
			expect(await after.text()).toBe(await before.text());
			expect([...after.headers]).toEqual([...before.headers]);
			expect(fetchMock).toHaveBeenCalledTimes(0);
		} finally {
			if (previous === undefined)
				delete process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
			else process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = previous;
		}
	});

	it("rejects an unsupported physical Responses model with its original id", async () => {
		const harness = makeContext();
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			"claude-sonnet-5",
			{},
			{
				__better_ccflare_codex_passthrough: { model: "gpt-unknown-physical" },
			},
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "model_route_unavailable",
				message: "Model route gpt-unknown-physical is unavailable",
				reason: "model_mapping_mismatch",
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

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

	it("discovers only the hinted Sol picker locally without leaking route metadata", async () => {
		const harness = makeContext(
			makeRegistry({
				expectedPhysicalModel: "physical-model-secret",
				clientContextWindowHint: "1m",
			}),
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
					id: PROFILE_MODEL_1M,
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

	it("routes legacy and hinted Sol picker ids through the same profile", async () => {
		const harness = makeContext(
			makeRegistry({ clientContextWindowHint: "1m" }),
		);
		const { requests } = installJsonUpstream();

		for (const model of [PROFILE_MODEL, PROFILE_MODEL_1M]) {
			const request = apiRequest("/v1/messages", model);
			expect(
				(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.url).toBe(
				`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			);
			expect(await fetchedJson(request)).toMatchObject({
				model: LOGICAL_MODEL,
				output_config: { effort: "xhigh" },
			});
		}
	});

	it("inherits legacy and hinted Sol picker spellings as the same profile", async () => {
		const harness = makeContext(
			makeRegistry({ clientContextWindowHint: "1m" }),
		);
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "hinted-child-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL_1M, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		for (const model of [PROFILE_MODEL, PROFILE_MODEL_1M]) {
			const child = apiRequest("/v1/messages", model, {
				...session,
				"x-claude-code-agent-id": `hinted-child-${model}`,
			});
			expect(
				(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.url).toBe(
				`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
			);
			expect((await fetchedJson(request)).model).toBe(LOGICAL_MODEL);
		}
		expect(harness.strategySelect).not.toHaveBeenCalled();
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
			models: {
				requestedModel: PROFILE_MODEL,
				appliedModel: LOGICAL_MODEL,
				upstreamModel: LOGICAL_MODEL,
			},
		});
		clearSession(sessionId);
	});

	it("lets an earlier buffered root commit after a later same-lineage streamed overflow", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "buffered-root-session" };
		const encoder = new TextEncoder();
		let markFirstRead!: () => void;
		const firstReadStarted = new Promise<void>((resolve) => {
			markFirstRead = resolve;
		});
		let releaseFirstBody!: () => void;
		const firstBodyReleased = new Promise<void>((resolve) => {
			releaseFirstBody = resolve;
		});
		const earlier = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...session },
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					markFirstRead();
					await firstBodyReleased;
					controller.enqueue(
						encoder.encode(
							JSON.stringify({
								model: PROFILE_MODEL,
								messages: [{ role: "user", content: "hello" }],
								max_tokens: 16,
							}),
						),
					);
					controller.close();
				},
			}),
		});
		const earlierResponse = handleProxy(
			earlier,
			new URL(earlier.url),
			harness.ctx,
			"key-1",
		);
		await firstReadStarted;

		const oversized = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...session },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
				},
			}),
		});
		const oversizedResponse = await handleProxy(
			oversized,
			new URL(oversized.url),
			harness.ctx,
			"key-1",
		);
		expect(oversizedResponse.status).toBe(413);

		releaseFirstBody();
		expect((await earlierResponse).status).toBe(200);
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-overflow",
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

	it("lets an earlier buffered root commit after a later malformed same-lineage root", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "malformed-root-session" };
		const encoder = new TextEncoder();
		let markFirstRead!: () => void;
		const firstReadStarted = new Promise<void>((resolve) => {
			markFirstRead = resolve;
		});
		let releaseFirstBody!: () => void;
		const firstBodyReleased = new Promise<void>((resolve) => {
			releaseFirstBody = resolve;
		});
		const earlier = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...session },
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					markFirstRead();
					await firstBodyReleased;
					controller.enqueue(
						encoder.encode(
							JSON.stringify({
								model: PROFILE_MODEL,
								messages: [{ role: "user", content: "hello" }],
								max_tokens: 16,
							}),
						),
					);
					controller.close();
				},
			}),
		});
		const earlierResponse = handleProxy(
			earlier,
			new URL(earlier.url),
			harness.ctx,
			"key-1",
		);
		await firstReadStarted;

		const malformed = apiRequest("/v1/messages", PROFILE_MODEL, session, {
			messages: { malformed: true },
		});
		expect(
			(
				await handleProxy(
					malformed,
					new URL(malformed.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(400);

		releaseFirstBody();
		expect((await earlierResponse).status).toBe(200);
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-malformed-root",
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

	it("lets an earlier buffered root commit after a later body abort", async () => {
		const harness = makeContext(makeRegistry());
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "aborted-root-session" };
		const encoder = new TextEncoder();
		let markFirstRead!: () => void;
		const firstReadStarted = new Promise<void>((resolve) => {
			markFirstRead = resolve;
		});
		let releaseFirstBody!: () => void;
		const firstBodyReleased = new Promise<void>((resolve) => {
			releaseFirstBody = resolve;
		});
		const earlier = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...session },
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					markFirstRead();
					await firstBodyReleased;
					controller.enqueue(
						encoder.encode(
							JSON.stringify({
								model: PROFILE_MODEL,
								messages: [{ role: "user", content: "hello" }],
								max_tokens: 16,
							}),
						),
					);
					controller.close();
				},
			}),
		});
		const earlierResponse = handleProxy(
			earlier,
			new URL(earlier.url),
			harness.ctx,
			"key-1",
		);
		await firstReadStarted;

		const aborted = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", ...session },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("fixture body abort"));
				},
			}),
		});
		await expect(
			handleProxy(aborted, new URL(aborted.url), harness.ctx, "key-1"),
		).rejects.toThrow("fixture body abort");

		releaseFirstBody();
		expect((await earlierResponse).status).toBe(200);
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "child-after-aborted-root",
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

	it("forwards bounded profile output requests rematerialized at the 4k cap", async () => {
		const harness = makeContext(
			makeRegistry({ contextWindow: 24_000, maxOutputTokens: 4_000 }),
		);
		const { requests } = installJsonUpstream();

		for (const maxTokens of [4_000, 8_000]) {
			const request = apiRequest(
				"/v1/messages",
				PROFILE_MODEL,
				{},
				{
					max_tokens: maxTokens,
				},
			);
			expect(
				(await handleProxy(request, new URL(request.url), harness.ctx, "key-1"))
					.status,
			).toBe(200);
		}

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect((await fetchedJson(request)).max_tokens).toBe(4_000);
		}
	});

	it("rejects invalid bounded requests before account selection or session commit", async () => {
		const registry = makeRegistry({
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
		const harness = makeContext(registry);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{ "x-claude-code-session-id": "invalid-bounded-session" },
			{ max_tokens: 0 },
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		const payload = await response.json();
		expect(payload).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"This bounded route profile requires a valid JSON request with a messages array and a finite positive max_tokens.",
				code: "bounded_profile_invalid_request",
			},
		});
		expect(JSON.stringify(payload)).not.toContain(ROUTE_ACCOUNT_ID);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(registry.size).toBe(0);
	});

	it("reports malformed explicit bounded requests with the stable error code", async () => {
		const registry = makeRegistry({
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
		const harness = makeContext(registry);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{},
			{
				messages: { malformed: true },
			},
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"This bounded route profile requires a valid JSON request with a messages array and a finite positive max_tokens.",
				code: "bounded_profile_invalid_request",
			},
		});
		expect(harness.getAllAccounts).not.toHaveBeenCalled();
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(registry.size).toBe(0);
	});

	it("preserves the generic malformed-message response for non-profile requests", async () => {
		const harness = makeContext(makeRegistry());
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			CHILD_MODEL,
			{},
			{
				messages: { malformed: true },
			},
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
			},
		});
		expect(harness.getAllAccounts).not.toHaveBeenCalled();
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects over-limit bounded requests before account selection or session commit", async () => {
		const registry = makeRegistry({
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
		const harness = makeContext(registry);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{ "x-claude-code-session-id": "overflow-bounded-session" },
			{
				max_tokens: 4_000,
				messages: [{ role: "user", content: "x".repeat(40_100) }],
			},
		);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		const payload = await response.json();
		expect(payload).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"This request exceeds the bounded route profile context limit.",
				code: "bounded_profile_context_length_exceeded",
			},
		});
		expect(JSON.stringify(payload)).not.toContain(ROUTE_ACCOUNT_ID);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(registry.size).toBe(0);
	});

	it("rejects deferred custom tools on bounded profiles before selection or server-tool handling", async () => {
		const registry = makeRegistry({
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
		const harness = makeContext(registry);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			{ "x-claude-code-session-id": "deferred-tool-bounded-session" },
			{
				tools: [
					{
						name: "deferred_lookup",
						input_schema: { type: "object" },
						defer_loading: true,
					},
				],
			},
		);

		const replayBindingSpy = spyOn(
			serverToolReplayRuntimeModule,
			"bindRequestPrivateServerToolReplay",
		);
		try {
			const response = await handleProxy(
				request,
				new URL(request.url),
				harness.ctx,
				"key-1",
			);

			expect(response.status).toBe(400);
			const payload = await response.json();
			expect(payload).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message:
						"This profile does not support deferred custom tools. Select a native Anthropic route or start a fresh non-Anthropic client with ENABLE_TOOL_SEARCH=0.",
					code: "bounded_profile_deferred_tools_unsupported",
				},
			});
			expect(JSON.stringify(payload)).not.toContain(ROUTE_ACCOUNT_ID);
			expect(harness.getAllAccounts).toHaveBeenCalledTimes(0);
			expect(harness.strategySelect).toHaveBeenCalledTimes(0);
			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(registry.size).toBe(0);
			expect(replayBindingSpy).not.toHaveBeenCalled();
		} finally {
			replayBindingSpy.mockRestore();
		}
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

	it("clamps inherited child profile output without changing its model pin", async () => {
		const fallback = makeAccount("normal-route");
		const harness = makeContext(
			makeRegistry({ contextWindow: 24_000, maxOutputTokens: 4_000 }),
			{
				accounts: [makeAccount(), fallback],
				normalAccountId: fallback.id,
			},
		);
		const { requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "bounded-child-session" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const child = apiRequest(
			"/v1/messages",
			CHILD_MODEL,
			{
				...session,
				"x-claude-code-agent-id": "bounded-child",
			},
			{ max_tokens: 8_000 },
		);
		expect(
			(await handleProxy(child, new URL(child.url), harness.ctx, "key-1"))
				.status,
		).toBe(200);

		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/`);
		expect(await fetchedJson(requests[1])).toMatchObject({
			model: CHILD_MODEL,
			max_tokens: 4_000,
		});
		expect(harness.strategySelect).toHaveBeenCalledTimes(0);
	});

	it("reports malformed inherited bounded requests with the stable error code", async () => {
		const registry = makeRegistry({
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
		const harness = makeContext(registry);
		const { fetchMock, requests } = installJsonUpstream();
		const session = { "x-claude-code-session-id": "malformed-bounded-child" };
		const root = apiRequest("/v1/messages", PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const child = apiRequest(
			"/v1/messages",
			CHILD_MODEL,
			{
				...session,
				"x-claude-code-agent-id": "malformed-bounded-child-agent",
			},
			{ messages: { malformed: true } },
		);
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"This bounded route profile requires a valid JSON request with a messages array and a finite positive max_tokens.",
				code: "bounded_profile_invalid_request",
			},
		});
		expect(requests).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(harness.getAllAccounts).toHaveBeenCalledTimes(1);
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(registry.size).toBe(1);
	});

	it("does not refresh a bounded inherited binding for an unparseable child, while admitted children refresh it", async () => {
		const clock = makeClock();
		const registry = makeRegistry(
			{ contextWindow: 24_000, maxOutputTokens: 4_000 },
			{ ttlMs: 1_000, now: clock.now },
		);
		const fallback = makeAccount("normal-route");
		const harness = makeContext(registry, {
			accounts: [makeAccount(), fallback],
			normalAccountId: fallback.id,
		});
		const { requests } = installJsonUpstream();
		const malformedSession = {
			"x-claude-code-session-id": "unparseable-bounded-child",
		};
		const malformedRoot = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			malformedSession,
		);
		expect(
			(
				await handleProxy(
					malformedRoot,
					new URL(malformedRoot.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);

		clock.advance(999);
		const malformedChild = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...malformedSession,
				"x-claude-code-agent-id": "unparseable-bounded-child-agent",
			},
			body: "not-json",
		});
		const rejected = await handleProxy(
			malformedChild,
			new URL(malformedChild.url),
			harness.ctx,
			"key-1",
		);
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({
			error: { code: "bounded_profile_invalid_request" },
		});

		clock.advance(1);
		const expiredChild = apiRequest("/v1/messages", CHILD_MODEL, {
			...malformedSession,
			"x-claude-code-agent-id": "child-after-unparseable-expiry",
		});
		expect(
			(
				await handleProxy(
					expiredChild,
					new URL(expiredChild.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);
		expect(requests[1]?.url).toContain("/normal-route/");

		const admittedSession = {
			"x-claude-code-session-id": "admitted-bounded-child",
		};
		const admittedRoot = apiRequest(
			"/v1/messages",
			PROFILE_MODEL,
			admittedSession,
		);
		expect(
			(
				await handleProxy(
					admittedRoot,
					new URL(admittedRoot.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);
		clock.advance(999);
		const admittedChild = apiRequest("/v1/messages", CHILD_MODEL, {
			...admittedSession,
			"x-claude-code-agent-id": "admitted-bounded-child-agent",
		});
		expect(
			(
				await handleProxy(
					admittedChild,
					new URL(admittedChild.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);
		clock.advance(1);
		const refreshedChild = apiRequest("/v1/messages", CHILD_MODEL, {
			...admittedSession,
			"x-claude-code-agent-id": "child-after-admitted-refresh",
		});
		expect(
			(
				await handleProxy(
					refreshedChild,
					new URL(refreshedChild.url),
					harness.ctx,
					"key-1",
				)
			).status,
		).toBe(200);
		expect(
			requests
				.slice(2)
				.every((request) => request.url.includes(`/${ROUTE_ACCOUNT_ID}/`)),
		).toBe(true);
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

	it("keeps the prior pin when a picker injected into a native root is rejected", async () => {
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
			`https://upstream.test/${ROUTE_ACCOUNT_ID}/v1/messages`,
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

	it("fails an unconfigured hinted reserved picker before provider, account, or fetch work", async () => {
		const harness = makeContext(
			makeRegistry({ clientContextWindowHint: "1m" }),
		);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", `${PROFILE_MODEL}[2m]`);
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
		expect(harness.providerCanHandle).toHaveBeenCalledTimes(1);
		expect(harness.providerCanHandle).toHaveBeenCalledWith("/v1/messages");
		expect(harness.getAllAccounts).not.toHaveBeenCalled();
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
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
			tools: [
				{
					name: "deferred_lookup",
					input_schema: { type: "object" },
					defer_loading: true,
				},
			],
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

	it("rejects an exact profile when a later configured physical fallback differs", async () => {
		const routed = makeAccount();
		routed.model_mappings = JSON.stringify({
			opus: ["gpt-5.6-sol", "gpt-5.6-terra"],
		});
		const harness = makeContext(
			makeRegistry({ expectedPhysicalModel: "gpt-5.6-sol" }),
			{ accounts: [routed] },
		);
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", PROFILE_MODEL);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { reason: "model_mapping_mismatch" },
		});
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleStart.mock.calls[0]?.[0]).toMatchObject({
			accountId: null,
			responseStatus: 503,
		});
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd.mock.calls[0]?.[0]).toMatchObject({
			success: false,
			error: "force_route_model_mapping_mismatch",
		});
	});

	it("rejects a capability profile when a later configured physical fallback differs", async () => {
		const candidate = makeAccount("capability-multi-map");
		candidate.model_mappings = JSON.stringify({
			opus: ["gpt-5.6-sol", "gpt-5.6-terra"],
		});
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [candidate],
		});
		const { fetchMock } = installJsonUpstream();
		const request = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL);

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { reason: "model_mapping_mismatch" },
		});
		expect(harness.strategySelect).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets an inherited capability child use its family mapping inside the root-capable pool", async () => {
		const routed = makeAccount();
		routed.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [routed],
		});
		const { fetchMock, requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "capability-child-family-mapping",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);
		expect(
			getServedAccountObservation(session["x-claude-code-session-id"]),
		).toMatchObject({
			accountId: ROUTE_ACCOUNT_ID,
			routeProfileId: "sol-capability",
		});

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "capability-child-family-mapping",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
	});

	it("keeps an inherited child on the first root-capable account despite a different family mapping", async () => {
		// A capability profile constrains pool membership through the root model.
		// The child family mapping is then an executable lane inside that pool, not
		// a reason to skip to a sibling whose child happens to map back to root Sol.
		const terraMapped = makeAccount();
		terraMapped.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const compliant = makeAccount("capability-child-compliant-secondary");
		compliant.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-sol",
		});
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [terraMapped, compliant],
		});
		harness.strategySelect.mockImplementation(
			(accounts: Account[]) => accounts,
		);
		const { fetchMock, requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "capability-child-second-candidate",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);
		expect(
			getServedAccountObservation(session["x-claude-code-session-id"]),
		).toMatchObject({
			accountId: ROUTE_ACCOUNT_ID,
			routeProfileId: "sol-capability",
		});

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "capability-child-second-candidate",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/v1/messages`);
		expect(requests[1]?.url).toContain(`/${ROUTE_ACCOUNT_ID}/v1/messages`);
	});

	it("falls from an exhausted child model to the root model inside the profile pool", async () => {
		const routed = makeAccount();
		routed.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [routed],
		});
		harness.strategySelect.mockImplementation(
			(accounts: Account[]) => accounts,
		);
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "capability-child-root-fallback",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		usageCache.markModelScopedExhausted(
			routed.id,
			CHILD_MODEL,
			"",
			Date.now() + 60_000,
		);
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "capability-child-root-fallback",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests).toHaveLength(2);
		expect((await fetchedJson(requests[1])).model).toBe(LOGICAL_MODEL);
	});

	it("falls from an unavailable profile pool to native global same-model routing", async () => {
		const routed = makeAccount();
		routed.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const mappedGlobal = makeAccount("mapped-global-must-stay-fenced");
		mappedGlobal.provider = "xai";
		mappedGlobal.priority = -1;
		mappedGlobal.model_mappings = JSON.stringify({ sonnet: "grok-4.6" });
		const nativeGlobal = makeAccount("native-global-sonnet");
		nativeGlobal.provider = "anthropic";
		nativeGlobal.priority = 20;
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [routed, mappedGlobal, nativeGlobal],
		});
		harness.strategySelect.mockImplementation(
			(accounts: Account[]) => accounts,
		);
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "capability-child-global-fallback",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		routed.paused = true;
		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "capability-child-global-fallback",
		});
		const response = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect((await fetchedJson(requests[1])).model).toBe(CHILD_MODEL);
		expect(
			requests.some((request) => request.url.includes(mappedGlobal.id)),
		).toBe(false);
	});

	it("commits the first winning child candidate and retains it across priority changes", async () => {
		const first = makeAccount();
		first.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const challenger = makeAccount("capability-child-priority-challenger");
		challenger.model_mappings = first.model_mappings;
		const strategy = new SessionAffinityStrategy();
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [first, challenger],
			strategy,
		});
		const { requests } = installJsonUpstream();
		const session = {
			"x-claude-code-session-id": "capability-child-sticky-session",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session, {
			metadata: { user_id: "capability-root-affinity" },
		});
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);

		const childHeaders = {
			...session,
			"x-claude-code-agent-id": "capability-child-sticky-agent",
		};
		const firstChild = apiRequest("/v1/messages", CHILD_MODEL, childHeaders, {
			metadata: { user_id: "capability-child-affinity" },
		});
		const firstChildResponse = await handleProxy(
			firstChild,
			new URL(firstChild.url),
			harness.ctx,
			"key-1",
		);
		expect(firstChildResponse.status).toBe(200);
		expect(usageHandleStart.mock.calls[1]?.[0]).toMatchObject({
			routeProvenance: {
				fallbackRung: "profile_requested_model",
				homeAction: "initial_commit",
			},
		});
		expect(
			firstChildResponse.headers.get("x-better-ccflare-route-fallback"),
		).toBe("profile_requested_model");
		const firstChildUrl = requests[1]?.url;
		expect(firstChildUrl).toBeString();
		if (firstChildUrl?.includes(`/${ROUTE_ACCOUNT_ID}/`)) {
			challenger.priority = -100;
		} else {
			first.priority = -100;
		}
		const nextChild = apiRequest("/v1/messages", CHILD_MODEL, childHeaders, {
			metadata: { user_id: "capability-child-affinity" },
		});
		const nextChildResponse = await handleProxy(
			nextChild,
			new URL(nextChild.url),
			harness.ctx,
			"key-1",
		);
		expect(nextChildResponse.status).toBe(200);
		expect(usageHandleStart.mock.calls[2]?.[0]).toMatchObject({
			routeProvenance: {
				fallbackRung: "profile_requested_model",
				homeAction: "retained",
			},
		});
		expect(requests[2]?.url).toBe(firstChildUrl);
	});

	it("does not make an unsuccessful terminal the descendant home", async () => {
		const routed = makeAccount();
		routed.model_mappings = JSON.stringify({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
		});
		const strategy = new SessionAffinityStrategy();
		const harness = makeContext(makeCapabilityRegistry(), {
			accounts: [routed],
			strategy,
		});
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				JSON.stringify(
					fetchCount === 1
						? { id: "root-success", type: "message", content: [] }
						: { type: "error", error: { type: "api_error" } },
				),
				{
					status: fetchCount === 1 ? 200 : 500,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;
		const session = {
			"x-claude-code-session-id": "capability-child-failed-home-session",
		};
		const root = apiRequest("/v1/messages", CAPABILITY_PROFILE_MODEL, session);
		expect(
			(await handleProxy(root, new URL(root.url), harness.ctx, "key-1")).status,
		).toBe(200);
		const affinityEntriesAfterRoot = strategy.affinityEntries;

		const child = apiRequest("/v1/messages", CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "capability-child-failed-home-agent",
		});
		const failed = await handleProxy(
			child,
			new URL(child.url),
			harness.ctx,
			"key-1",
		);

		expect(failed.status).toBe(500);
		expect(strategy.affinityEntries).toBe(affinityEntriesAfterRoot);
		expect(usageHandleStart.mock.calls.at(-1)?.[0]).toMatchObject({
			routeProvenance: { homeAction: "none" },
		});
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

describe("catalog-role Codex route profiles", () => {
	// A fictitious next generation: the policy must follow the catalog order,
	// never a model name this repository has seen before.
	const NEXT_GENERATION = ["gpt-7-nova", "gpt-7-sol", "gpt-7-luna"] as const;
	const REORDERED = ["gpt-7-sol", "gpt-7-nova", "gpt-7-luna"] as const;
	const ROLE_PICKER = "claude-bccf-route-codex-opus";
	const ROLE_POOL_PICKER = "claude-bccf-route-codex-opus-pool";
	const ROLE_ACCOUNT_ID = "codex-role-account-secret";

	function makeRoleAccount(id = ROLE_ACCOUNT_ID): Account {
		const account = makeAccount(id);
		account.provider = "codex";
		account.api_key = null;
		account.access_token = "codex-test-token";
		account.expires_at = Date.now() + 3_600_000;
		return account;
	}

	function makeRoleRegistry(accountId = ROLE_ACCOUNT_ID) {
		return new ModelRouteSessionRegistry(
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "codex-opus",
						displayName: "Codex · opus",
						description: "role-profile-description-secret",
						accountId,
						logicalModel: LOGICAL_MODEL,
						expectedProvider: "codex",
						physicalModelPolicy: "catalog-role",
					},
					{
						id: "codex-opus-pool",
						displayName: "Codex pool · opus",
						selection: "capability",
						logicalModel: LOGICAL_MODEL,
						expectedProvider: "codex",
						physicalModelPolicy: "catalog-role",
					},
				]),
			),
		);
	}

	function makeRoleContext(accounts: Account[]) {
		const harness = makeContext(makeRoleRegistry(), { accounts });
		harness.strategySelect.mockImplementation(
			(candidates: Account[]) => candidates,
		);
		harness.ctx.dbOps.getAccount = mock(
			async (id: string) =>
				accounts.find((account) => account.id === id) ?? null,
		);
		return harness;
	}

	function installCodexRoleUpstream(
		initial: readonly string[] = NEXT_GENERATION,
	) {
		let catalog: readonly string[] = initial;
		let catalogFailure: "rejects" | "hangs" | null = null;
		const catalogReads: string[] = [];
		const hungCatalogReads: Array<(response: Response) => void> = [];
		const responses: Request[] = [];
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				if (new URL(request.url).pathname.endsWith("/codex/models")) {
					// The bearer token identifies which account's own listing was read.
					catalogReads.push(request.headers.get("authorization") ?? "");
					if (catalogFailure === "rejects") {
						throw new TypeError("catalog read failed");
					}
					if (catalogFailure === "hangs") {
						return new Promise<Response>((resolve) => {
							hungCatalogReads.push(resolve);
						});
					}
					return Response.json({
						models: catalog.map((slug, index) => ({
							slug,
							display_name: slug,
							visibility: "list",
							priority: index + 1,
						})),
					});
				}
				responses.push(request.clone());
				return new Response(
					`event: response.completed\ndata: ${JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp-catalog-role",
							object: "response",
							status: "completed",
							model: "gpt-7-nova",
							output: [],
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		return {
			responses,
			fetchMock,
			catalogReads,
			setCatalog: (models: readonly string[]) => {
				catalog = models;
			},
			/** Every later own-listing read fails (null restores them); responses are unaffected. */
			failCatalog: (mode: "rejects" | "hangs" | null) => {
				catalogFailure = mode;
			},
			/** Settle hung listing reads so no shared catalog work outlives a test. */
			releaseHungCatalogReads: () => {
				for (const resolve of hungCatalogReads.splice(0)) {
					resolve(new Response(null, { status: 503 }));
				}
			},
		};
	}

	async function publish(
		upstream: ReturnType<typeof installCodexRoleUpstream>,
		account: Account,
		ctx: ProxyContext,
		models: readonly string[],
	): Promise<void> {
		upstream.setCatalog(models);
		const listing = await codexModelCatalogModule.getCodexModels(
			account.id,
			ctx,
		);
		expect(listing?.source).toBe("live");
	}

	async function send(
		ctx: ProxyContext,
		model: string,
		headers: Record<string, string> = {},
		body: Record<string, unknown> = {},
	) {
		const request = apiRequest("/v1/messages", model, headers, body);
		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);
		const text = await response.text();
		return { response, text };
	}

	async function upstreamModels(requests: Request[]): Promise<unknown[]> {
		return Promise.all(
			requests.map(async (request) => {
				expect(new URL(request.url).pathname).toEndWith("/codex/responses");
				return (await fetchedJson(request.clone())).model;
			}),
		);
	}

	it("routes an explicit role picker to the account's own role target and follows a catalog publication", async () => {
		const account = makeRoleAccount();
		const harness = makeRoleContext([account]);
		const upstream = installCodexRoleUpstream();
		await publish(upstream, account, harness.ctx, NEXT_GENERATION);

		const first = await send(harness.ctx, ROLE_PICKER);
		expect(first.response.status, first.text).toBe(200);

		// A publication that reorders the catalog moves the role target with no
		// profile, mapping, or picker-id change.
		await publish(upstream, account, harness.ctx, REORDERED);
		const second = await send(harness.ctx, ROLE_PICKER);
		expect(second.response.status, second.text).toBe(200);

		expect(await upstreamModels(upstream.responses)).toEqual([
			"gpt-7-nova",
			"gpt-7-sol",
		]);
		expect(harness.strategySelect).not.toHaveBeenCalled();
	});

	it("keeps an inherited picker on the role target and a native child on its own family", async () => {
		const account = makeRoleAccount();
		const harness = makeRoleContext([account]);
		const upstream = installCodexRoleUpstream();
		await publish(upstream, account, harness.ctx, NEXT_GENERATION);
		const session = { "x-claude-code-session-id": "catalog-role-lineage" };

		const root = await send(harness.ctx, ROLE_PICKER, session);
		expect(root.response.status, root.text).toBe(200);
		const pickerChild = await send(harness.ctx, ROLE_PICKER, {
			...session,
			"x-claude-code-agent-id": "catalog-role-picker-child",
		});
		expect(pickerChild.response.status, pickerChild.text).toBe(200);
		const nativeChild = await send(harness.ctx, CHILD_MODEL, {
			...session,
			"x-claude-code-agent-id": "catalog-role-native-child",
		});
		expect(nativeChild.response.status, nativeChild.text).toBe(200);

		await publish(upstream, account, harness.ctx, REORDERED);
		const laterPickerChild = await send(harness.ctx, ROLE_PICKER, {
			...session,
			"x-claude-code-agent-id": "catalog-role-picker-child-later",
		});
		expect(laterPickerChild.response.status, laterPickerChild.text).toBe(200);

		expect(await upstreamModels(upstream.responses)).toEqual([
			"gpt-7-nova",
			"gpt-7-nova",
			// The native child keeps the existing child-family lane: sonnet's
			// role in this account's own catalog.
			"gpt-7-sol",
			"gpt-7-sol",
		]);
		for (const request of upstream.responses) {
			expect(request.url).not.toContain("upstream.test");
		}
	});

	it("applies the role guard to an inherited server-tool helper", async () => {
		const account = makeRoleAccount();
		const harness = makeRoleContext([account]);
		const { createReadyServerToolReplayRuntimeForTest } = await import(
			"./helpers/server-tool-replay-runtime"
		);
		harness.ctx.serverToolReplay =
			await createReadyServerToolReplayRuntimeForTest();
		const upstream = installCodexRoleUpstream();
		await publish(upstream, account, harness.ctx, NEXT_GENERATION);
		const session = { "x-claude-code-session-id": "catalog-role-helper" };
		const helperBody = {
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		};

		const root = await send(harness.ctx, ROLE_PICKER, session);
		expect(root.response.status, root.text).toBe(200);

		// Admitted: the helper passes the role guard and reaches the ordinary
		// server-tool capability decision. No hosted-search proof exists for a
		// fictitious model, so that later stage (not the role guard) refuses it.
		const admitted = await send(harness.ctx, CHILD_MODEL, session, helperBody);
		expect(JSON.parse(admitted.text)).toMatchObject({
			error: {
				code: "server_tool_force_route_unavailable",
				reason: "forced_incapable",
			},
		});

		account.model_mappings = JSON.stringify({ opus: "gpt-7-luna" });
		const pinned = await send(harness.ctx, CHILD_MODEL, session, helperBody);
		expect(pinned.response.status).toBe(503);
		expect(JSON.parse(pinned.text)).toMatchObject({
			error: {
				type: "force_route_unavailable",
				reason: "catalog_role_mismatch",
			},
		});

		account.model_mappings = null;
		codexModelCatalogModule.clearCodexModelCacheForAccount(account.id);
		// A cold account is primed at request time; it stays unlisted only when
		// that read of its own listing fails too.
		upstream.failCatalog("rejects");
		const unlisted = await send(harness.ctx, CHILD_MODEL, session, helperBody);
		expect(unlisted.response.status).toBe(503);
		expect(JSON.parse(unlisted.text)).toMatchObject({
			error: {
				type: "force_route_unavailable",
				reason: "catalog_role_unavailable",
			},
		});
		expect(await upstreamModels(upstream.responses)).toEqual(["gpt-7-nova"]);
	});

	it("binds an attempt to its admission target across a racing catalog publication", async () => {
		const account = makeRoleAccount();
		const harness = makeRoleContext([account]);
		const upstream = installCodexRoleUpstream();
		await publish(upstream, account, harness.ctx, NEXT_GENERATION);
		const actualEnsure = codexModelCatalogModule.ensureCodexModelDefaults;
		let raced = false;
		// The account was admitted on gpt-7-nova. A refresh lands after
		// selection, before the attempt resolves its physical model.
		const ensureSpy = spyOn(
			codexModelCatalogModule,
			"ensureCodexModelDefaults",
		).mockImplementation(async (...args) => {
			if (!raced) {
				raced = true;
				await publish(upstream, account, harness.ctx, REORDERED);
			}
			return actualEnsure(...args);
		});
		try {
			const racing = await send(harness.ctx, ROLE_PICKER);
			expect(racing.response.status, racing.text).toBe(200);
			expect(raced).toBe(true);
		} finally {
			ensureSpy.mockRestore();
		}

		// The refreshed catalog governs the next request with no config change.
		const later = await send(harness.ctx, ROLE_PICKER);
		expect(later.response.status, later.text).toBe(200);

		expect(await upstreamModels(upstream.responses)).toEqual([
			"gpt-7-nova",
			"gpt-7-sol",
		]);
	});

	describe("descendants of a role capability pool", () => {
		// Moves opus to gpt-7-sol and sonnet to gpt-7-luna, so the admitted opus
		// target, the child's pre-race role and its raced role all differ.
		const RACED = ["gpt-7-sol", "gpt-7-luna", "gpt-7-nova"] as const;

		/** Admit a root on the role pool and return a descendant's headers. */
		async function bindPoolLineage(
			ctx: ProxyContext,
			lineage: string,
		): Promise<Record<string, string>> {
			const session = { "x-claude-code-session-id": lineage };
			const root = await send(ctx, ROLE_POOL_PICKER, session);
			expect(root.response.status, root.text).toBe(200);
			return { ...session, "x-claude-code-agent-id": `${lineage}-child` };
		}

		/**
		 * Publish `models` from the account's next catalog ensure: the attempt's
		 * own, which runs after selection has already admitted the account.
		 */
		async function withRacingPublication<T>(
			upstream: ReturnType<typeof installCodexRoleUpstream>,
			account: Account,
			ctx: ProxyContext,
			models: readonly string[],
			run: () => Promise<T>,
		): Promise<T> {
			const actualEnsure = codexModelCatalogModule.ensureCodexModelDefaults;
			let raced = false;
			const ensureSpy = spyOn(
				codexModelCatalogModule,
				"ensureCodexModelDefaults",
			).mockImplementation(async (...args) => {
				if (!raced) {
					raced = true;
					await publish(upstream, account, ctx, models);
				}
				return actualEnsure(...args);
			});
			try {
				const result = await run();
				expect(raced).toBe(true);
				return result;
			} finally {
				ensureSpy.mockRestore();
			}
		}

		it("binds a descendant's root-model rung to its admission target across a racing catalog publication", async () => {
			const account = makeRoleAccount("role-descendant-root-rung");
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();
			await publish(upstream, account, harness.ctx, NEXT_GENERATION);
			const child = await bindPoolLineage(
				harness.ctx,
				"role-descendant-root-rung",
			);
			// The child's own family is exhausted, so it runs the root-model rung.
			usageCache.markModelScopedExhausted(
				account.id,
				CHILD_MODEL,
				"",
				Date.now() + 60_000,
			);

			const racing = await withRacingPublication(
				upstream,
				account,
				harness.ctx,
				RACED,
				() => send(harness.ctx, CHILD_MODEL, child),
			);
			expect(racing.response.status, racing.text).toBe(200);
			expect(
				racing.response.headers.get("x-better-ccflare-route-fallback"),
			).toBe("profile_root_model");

			// The refreshed catalog governs the next descendant request.
			const later = await send(harness.ctx, CHILD_MODEL, child);
			expect(later.response.status, later.text).toBe(200);
			expect(
				later.response.headers.get("x-better-ccflare-route-fallback"),
			).toBe("profile_root_model");

			expect(await upstreamModels(upstream.responses)).toEqual([
				"gpt-7-nova",
				// The target that admitted the account, not the raced gpt-7-sol.
				"gpt-7-nova",
				"gpt-7-sol",
			]);
		});

		it("leaves a descendant's other-family requested-model rung on the child's own resolution", async () => {
			const account = makeRoleAccount("role-descendant-child-rung");
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();
			await publish(upstream, account, harness.ctx, NEXT_GENERATION);
			const child = await bindPoolLineage(
				harness.ctx,
				"role-descendant-child-rung",
			);

			const racing = await withRacingPublication(
				upstream,
				account,
				harness.ctx,
				RACED,
				() => send(harness.ctx, CHILD_MODEL, child),
			);

			expect(racing.response.status, racing.text).toBe(200);
			expect(
				racing.response.headers.get("x-better-ccflare-route-fallback"),
			).toBe("profile_requested_model");
			expect(await upstreamModels(upstream.responses)).toEqual([
				"gpt-7-nova",
				// Sonnet's role in the live catalog, never the carried opus target.
				"gpt-7-luna",
			]);
		});

		it("leaves a descendant's global rung to ordinary routing", async () => {
			const account = makeRoleAccount("role-descendant-global-codex");
			const native = makeAccount("role-descendant-global-native");
			native.provider = "anthropic";
			native.priority = 20;
			const harness = makeRoleContext([account, native]);
			const upstream = installCodexRoleUpstream();
			await publish(upstream, account, harness.ctx, NEXT_GENERATION);
			const child = await bindPoolLineage(
				harness.ctx,
				"role-descendant-global-rung",
			);
			// Both profile rungs are exhausted on the only role-capable account.
			const exhaustedUntil = Date.now() + 60_000;
			usageCache.markModelScopedExhausted(
				account.id,
				CHILD_MODEL,
				"",
				exhaustedUntil,
			);
			usageCache.markModelScopedExhausted(
				account.id,
				LOGICAL_MODEL,
				"",
				exhaustedUntil,
			);

			const global = await send(harness.ctx, CHILD_MODEL, child);

			expect(global.response.status, global.text).toBe(200);
			expect(
				global.response.headers.get("x-better-ccflare-route-fallback"),
			).toBe("global_requested_model");
			expect(upstream.responses).toHaveLength(2);
			expect(new URL(upstream.responses[0]?.url ?? "").pathname).toEndWith(
				"/codex/responses",
			);
			expect(upstream.responses[1]?.url).toBe(
				"https://api.anthropic.com/v1/messages",
			);
			expect((await fetchedJson(upstream.responses[1])).model).toBe(
				CHILD_MODEL,
			);
		});
	});

	it("routes a role capability pool only through own-catalog Codex accounts", async () => {
		const pinnedAway = makeRoleAccount("role-pool-pinned-away");
		pinnedAway.model_mappings = JSON.stringify({ opus: "gpt-7-luna" });
		const borrower = makeRoleAccount("role-pool-borrower");
		const owner = makeRoleAccount("role-pool-owner");
		owner.priority = 5;
		const nonCodex = makeAccount("role-pool-non-codex");
		nonCodex.model_mappings = JSON.stringify({ opus: "gpt-7-nova" });
		const harness = makeRoleContext([pinnedAway, borrower, nonCodex, owner]);
		const upstream = installCodexRoleUpstream();
		await publish(upstream, pinnedAway, harness.ctx, NEXT_GENERATION);
		await publish(upstream, owner, harness.ctx, REORDERED);
		// The borrower's request-time read of its own listing fails, so it keeps
		// only the borrowed listing; warm accounts read nothing more.
		upstream.failCatalog("rejects");

		const routed = await send(harness.ctx, ROLE_POOL_PICKER);
		expect(routed.response.status, routed.text).toBe(200);

		expect(
			harness.strategySelect.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual([owner.id]);
		expect(await upstreamModels(upstream.responses)).toEqual(["gpt-7-sol"]);
	});

	it.each([
		{
			reason: "catalog_role_mismatch",
			arrange: (account: Account) => {
				account.model_mappings = JSON.stringify({ opus: "gpt-7-luna" });
			},
		},
		{
			reason: "catalog_role_unavailable",
			arrange: (account: Account) => {
				codexModelCatalogModule.clearCodexModelCacheForAccount(account.id);
			},
		},
	] as const)("fails an exact role route closed with force_route_$reason", async ({
		reason,
		arrange,
	}) => {
		const account = makeRoleAccount();
		const harness = makeRoleContext([account]);
		const upstream = installCodexRoleUpstream();
		await publish(upstream, account, harness.ctx, NEXT_GENERATION);
		arrange(account);
		// A cleared account is primed at request time, so it stays unlisted only
		// when that read fails too. The warm mismatch case reads nothing.
		upstream.failCatalog("rejects");

		const failed = await send(harness.ctx, ROLE_PICKER);

		expect(failed.response.status).toBe(503);
		expect(failed.response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		const payload = JSON.parse(failed.text) as {
			error: Record<string, unknown>;
		};
		expect(payload.error).toMatchObject({
			type: "force_route_unavailable",
			reason,
		});
		expect(payload.error).not.toHaveProperty("account_id");
		expect(failed.text).not.toContain(ROLE_ACCOUNT_ID);
		expect(upstream.responses).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageHandleEnd).toHaveBeenCalledTimes(1);
		expect(usageHandleEnd.mock.calls[0]?.[0]).toMatchObject({
			success: false,
			error: `force_route_${reason}`,
		});
	});

	it("fails a role capability pool with no own-catalog account closed", async () => {
		const lender = makeRoleAccount("role-pool-lender");
		const borrower = makeRoleAccount("role-pool-only-borrower");
		const harness = makeRoleContext([borrower]);
		const upstream = installCodexRoleUpstream();
		const lenderHarness = makeRoleContext([lender]);
		await publish(upstream, lender, lenderHarness.ctx, NEXT_GENERATION);
		// The borrower's request-time read of its own listing fails.
		upstream.failCatalog("rejects");

		const failed = await send(harness.ctx, ROLE_POOL_PICKER);

		expect(failed.response.status).toBe(503);
		expect(JSON.parse(failed.text)).toMatchObject({
			error: {
				type: "force_route_unavailable",
				reason: "catalog_role_unavailable",
			},
		});
		expect(upstream.responses).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageHandleEnd.mock.calls.at(-1)?.[0]).toMatchObject({
			error: "force_route_catalog_role_unavailable",
		});
	});

	it("reports each catalog-role fail-closed route on the Codex catalog event bus", async () => {
		const events: CodexCatalogEvt[] = [];
		const listener = (event: CodexCatalogEvt) => {
			events.push(event);
		};
		codexCatalogEvents.on("event", listener);
		try {
			// Exact profile: its account's own target differs from its pin.
			const account = makeRoleAccount();
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();
			await publish(upstream, account, harness.ctx, NEXT_GENERATION);
			account.model_mappings = JSON.stringify({ opus: "gpt-7-luna" });
			const exact = await send(harness.ctx, ROLE_PICKER);
			expect(exact.response.status).toBe(503);

			// Pool profile: no candidate has a catalog of its own.
			const borrower = makeRoleAccount("role-pool-event-borrower");
			const poolHarness = makeRoleContext([borrower]);
			upstream.failCatalog("rejects");
			const pool = await send(poolHarness.ctx, ROLE_POOL_PICKER);
			expect(pool.response.status).toBe(503);

			expect(
				events.filter((event) => event.type === "route_role_unavailable"),
			).toEqual([
				{
					type: "route_role_unavailable",
					profileId: "codex-opus",
					accountId: ROLE_ACCOUNT_ID,
					reason: "catalog_role_mismatch",
				},
				{
					type: "route_role_unavailable",
					profileId: "codex-opus-pool",
					reason: "catalog_role_unavailable",
				},
			]);
		} finally {
			codexCatalogEvents.off("event", listener);
		}
	});

	it("discovers role pickers like any other profile without leaking route metadata", async () => {
		const harness = makeRoleContext([makeRoleAccount()]);
		const { fetchMock } = installCodexRoleUpstream();
		const request = new Request("https://proxy.local/v1/models");

		const response = await handleProxy(
			request,
			new URL(request.url),
			harness.ctx,
			"key-1",
		);

		expect(response.status).toBe(200);
		const raw = await response.text();
		expect(JSON.parse(raw)).toEqual({
			data: [
				{ id: ROLE_PICKER, display_name: "Codex · opus" },
				{ id: ROLE_POOL_PICKER, display_name: "Codex pool · opus" },
			],
			has_more: false,
		});
		for (const secret of [
			ROLE_ACCOUNT_ID,
			LOGICAL_MODEL,
			"catalog-role",
			"role-profile-description-secret",
		]) {
			expect(raw).not.toContain(secret);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(harness.getAllAccounts).not.toHaveBeenCalled();
	});

	describe("request-time priming of cold own catalogs", () => {
		// Own listings live in memory only, so every process start is cold. No
		// test here starts the refresh heartbeat: the request itself must prime.
		function coldRoleAccount(id = ROLE_ACCOUNT_ID): Account {
			const account = makeRoleAccount(id);
			account.access_token = `token-${id}`;
			return account;
		}

		const bearer = (account: Account) => `Bearer ${account.access_token}`;

		async function withSelectionTimeout<T>(
			timeoutMs: string,
			run: () => Promise<T>,
		): Promise<T> {
			const previous = process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
			process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = timeoutMs;
			try {
				return await run();
			} finally {
				if (previous === undefined)
					delete process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
				else process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = previous;
			}
		}

		it("primes a cold exact-account role route and sends the role target on the first request", async () => {
			const account = coldRoleAccount();
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();
			expect(codexModelCatalogModule.getKnownCodexModels(account.id)).toBe(
				null,
			);

			const first = await send(harness.ctx, ROLE_PICKER);

			expect(first.response.status, first.text).toBe(200);
			expect(upstream.catalogReads).toEqual([bearer(account)]);
			expect(await upstreamModels(upstream.responses)).toEqual(["gpt-7-nova"]);
		});

		it("adds no catalog read for a second request once the account is warm", async () => {
			const account = coldRoleAccount();
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();

			const first = await send(harness.ctx, ROLE_PICKER);
			expect(first.response.status, first.text).toBe(200);
			const second = await send(harness.ctx, ROLE_PICKER);
			expect(second.response.status, second.text).toBe(200);

			expect(upstream.catalogReads).toEqual([bearer(account)]);
			expect(await upstreamModels(upstream.responses)).toEqual([
				"gpt-7-nova",
				"gpt-7-nova",
			]);
		});

		it("primes every cold candidate of a role capability pool and admits them on the first request", async () => {
			const first = coldRoleAccount("role-prime-pool-first");
			const second = coldRoleAccount("role-prime-pool-second");
			const nonCodex = makeAccount("role-prime-pool-non-codex");
			const harness = makeRoleContext([first, nonCodex, second]);
			const upstream = installCodexRoleUpstream();

			const routed = await send(harness.ctx, ROLE_POOL_PICKER);

			expect(routed.response.status, routed.text).toBe(200);
			expect([...upstream.catalogReads].sort()).toEqual(
				[bearer(first), bearer(second)].sort(),
			);
			expect(
				harness.strategySelect.mock.calls[0]?.[0]
					.map((account) => account.id)
					.sort(),
			).toEqual([first.id, second.id].sort());
			expect(await upstreamModels(upstream.responses)).toEqual(["gpt-7-nova"]);
		});

		it.each([
			"rejects",
			"hangs",
		] as const)("fails a cold role route closed with catalog_role_unavailable when its prime %s", async (mode) => {
			const account = coldRoleAccount();
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();
			upstream.failCatalog(mode);
			try {
				// A hung read is bounded by the account-selection deadline; a
				// rejected read settles on its own and needs no short deadline.
				await withSelectionTimeout(
					mode === "hangs" ? "5" : "20000",
					async () => {
						const startedAt = Date.now();
						const failed = await send(harness.ctx, ROLE_PICKER);
						// The shared single-flight or retry backoff absorbs a second
						// request instead of starting another read.
						const retried = await send(harness.ctx, ROLE_PICKER);
						expect(Date.now() - startedAt).toBeLessThan(2_000);

						for (const outcome of [failed, retried]) {
							expect(outcome.response.status).toBe(503);
							expect(JSON.parse(outcome.text)).toMatchObject({
								error: {
									type: "force_route_unavailable",
									reason: "catalog_role_unavailable",
								},
							});
						}
					},
				);
				expect(upstream.catalogReads).toEqual([bearer(account)]);
				expect(upstream.responses).toHaveLength(0);
				expect(codexModelCatalogModule.getKnownCodexModels(account.id)).toBe(
					null,
				);
			} finally {
				upstream.releaseHungCatalogReads();
				upstream.failCatalog(null);
				// Settle the shared catalog work before the next test clears it, so
				// a late completion cannot leave retry state for the same account id.
				await ensureCodexModelDefaults(account, harness.ctx);
			}
		});

		it("keeps a cold account whose own prime fails unavailable despite a shared listing", async () => {
			const borrower = coldRoleAccount();
			const lender = coldRoleAccount("role-prime-lender");
			const harness = makeRoleContext([borrower, lender]);
			const upstream = installCodexRoleUpstream();
			await publish(upstream, lender, harness.ctx, NEXT_GENERATION);
			expect(
				codexModelCatalogModule.getKnownOrSharedCodexModels(borrower.id)
					?.source,
			).toBe("shared");
			upstream.failCatalog("rejects");

			const failed = await send(harness.ctx, ROLE_PICKER);

			expect(failed.response.status).toBe(503);
			expect(JSON.parse(failed.text)).toMatchObject({
				error: {
					type: "force_route_unavailable",
					reason: "catalog_role_unavailable",
				},
			});
			expect(upstream.catalogReads).toEqual([bearer(lender), bearer(borrower)]);
			expect(upstream.responses).toHaveLength(0);
			expect(codexModelCatalogModule.getKnownCodexModels(borrower.id)).toBe(
				null,
			);
		});

		it("never primes for an exact-policy profile or a plain request", async () => {
			const codex = coldRoleAccount("exact-policy-cold-codex");
			const normal = makeAccount("exact-policy-normal");
			const exactProfile = {
				displayName: "Codex exact",
				accountId: codex.id,
				logicalModel: LOGICAL_MODEL,
				expectedProvider: "codex",
				expectedPhysicalModel: "gpt-7-nova",
			};
			const harness = makeContext(
				new ModelRouteSessionRegistry(
					parseModelRouteProfiles(
						JSON.stringify([
							{ ...exactProfile, id: "codex-exact-default" },
							{
								...exactProfile,
								id: "codex-exact-explicit",
								physicalModelPolicy: "exact",
							},
							// A configured role profile must not prime unrelated requests.
							{
								id: "codex-opus",
								displayName: "Codex · opus",
								accountId: codex.id,
								logicalModel: LOGICAL_MODEL,
								expectedProvider: "codex",
								physicalModelPolicy: "catalog-role",
							},
						]),
					),
				),
				{ accounts: [normal, codex], normalAccountId: normal.id },
			);
			// A prime would read the listing through this lookup; without it a
			// wrongly started prime would fail silently and look like no prime.
			harness.ctx.dbOps.getAccount = mock(async (id: string) =>
				id === codex.id ? codex : id === normal.id ? normal : null,
			);
			const upstream = installCodexRoleUpstream();

			const exactDefault = await send(
				harness.ctx,
				"claude-bccf-route-codex-exact-default",
			);
			const exactExplicit = await send(
				harness.ctx,
				"claude-bccf-route-codex-exact-explicit",
			);
			const plain = await send(harness.ctx, CHILD_MODEL);

			for (const exact of [exactDefault, exactExplicit]) {
				expect(exact.response.status).toBe(503);
				expect(JSON.parse(exact.text)).toMatchObject({
					error: {
						type: "force_route_unavailable",
						reason: "model_mapping_mismatch",
					},
				});
			}
			expect(plain.response.status, plain.text).toBe(200);
			expect(upstream.catalogReads).toEqual([]);
			expect(codexModelCatalogModule.getKnownCodexModels(codex.id)).toBe(null);
		});

		it("never primes for a descendant of an exact-policy pool, a descendant of a catalog-role pool, or an unbound child", async () => {
			const codex = coldRoleAccount("exact-pool-descendant-codex");
			codex.model_mappings = JSON.stringify({ opus: "gpt-7-nova" });
			const normal = makeAccount("exact-pool-descendant-normal");
			const harness = makeContext(
				new ModelRouteSessionRegistry(
					parseModelRouteProfiles(
						JSON.stringify([
							{
								id: "codex-exact-pool",
								displayName: "Codex exact pool",
								selection: "capability",
								logicalModel: LOGICAL_MODEL,
								expectedProvider: "codex",
								expectedPhysicalModel: "gpt-7-nova",
							},
							// A configured role pool must not prime unrelated requests.
							{
								id: "codex-opus-pool",
								displayName: "Codex pool · opus",
								selection: "capability",
								logicalModel: LOGICAL_MODEL,
								expectedProvider: "codex",
								physicalModelPolicy: "catalog-role",
							},
						]),
					),
				),
				{ accounts: [normal, codex], normalAccountId: normal.id },
			);
			harness.ctx.dbOps.getAccount = mock(async (id: string) =>
				id === codex.id ? codex : id === normal.id ? normal : null,
			);
			const upstream = installCodexRoleUpstream();
			// Priming runs before selection, and an attempt reads a cold listing
			// only after it. Record the reads each selection has already seen.
			const readsAtSelection: number[] = [];
			harness.strategySelect.mockImplementation((candidates: Account[]) => {
				readsAtSelection.push(upstream.catalogReads.length);
				return candidates;
			});
			const session = { "x-claude-code-session-id": "exact-pool-descendant" };

			const root = await send(
				harness.ctx,
				"claude-bccf-route-codex-exact-pool",
				session,
			);
			expect(root.response.status, root.text).toBe(200);
			codexModelCatalogModule.clearCodexModelCacheForAccount(codex.id);
			const descendant = await send(harness.ctx, CHILD_MODEL, {
				...session,
				"x-claude-code-agent-id": "exact-pool-descendant-child",
			});
			expect(descendant.response.status, descendant.text).toBe(200);
			codexModelCatalogModule.clearCodexModelCacheForAccount(codex.id);
			const unbound = await send(harness.ctx, CHILD_MODEL, {
				"x-claude-code-session-id": "exact-pool-unbound",
				"x-claude-code-agent-id": "exact-pool-unbound-child",
			});
			expect(unbound.response.status, unbound.text).toBe(200);

			// Every read came from a Codex attempt after its selection: the root's
			// and the descendant's. None came from a prime ahead of selection.
			expect(readsAtSelection).toEqual([0, 1, 2]);
			expect(upstream.catalogReads).toEqual([bearer(codex), bearer(codex)]);

			// A catalog-role pool root primes its cold candidate ahead of selection.
			// Only roots prime: a descendant meeting the pool cold under a live
			// lineage binding reads nothing and fails closed.
			const roleSession = {
				"x-claude-code-session-id": "role-pool-descendant",
			};
			const roleRoot = await send(harness.ctx, ROLE_POOL_PICKER, roleSession);
			expect(roleRoot.response.status, roleRoot.text).toBe(200);
			expect(readsAtSelection).toEqual([0, 1, 2, 3]);
			codexModelCatalogModule.clearCodexModelCacheForAccount(codex.id);
			const roleDescendant = await send(harness.ctx, CHILD_MODEL, {
				...roleSession,
				"x-claude-code-agent-id": "role-pool-descendant-child",
			});
			expect(roleDescendant.response.status).toBe(503);
			expect(JSON.parse(roleDescendant.text)).toMatchObject({
				error: {
					type: "force_route_unavailable",
					reason: "catalog_role_unavailable",
				},
			});
			expect(upstream.catalogReads).toEqual([
				bearer(codex),
				bearer(codex),
				bearer(codex),
			]);
			expect(codexModelCatalogModule.getKnownCodexModels(codex.id)).toBe(null);
		});

		it("primes only refresh-eligible Codex candidates of a role pool", async () => {
			const paused = coldRoleAccount("role-prime-paused");
			paused.paused = true;
			const reauth = coldRoleAccount("role-prime-reauth");
			reauth.requires_reauth = true;
			const custom = coldRoleAccount("role-prime-custom-endpoint");
			custom.custom_endpoint = "https://codex-gateway.example.test";
			const eligible = coldRoleAccount("role-prime-eligible");
			const harness = makeRoleContext([paused, reauth, custom, eligible]);
			const upstream = installCodexRoleUpstream();

			const routed = await send(harness.ctx, ROLE_POOL_PICKER);

			expect(routed.response.status, routed.text).toBe(200);
			expect(upstream.catalogReads).toEqual([bearer(eligible)]);
			expect(
				harness.strategySelect.mock.calls[0]?.[0].map((account) => account.id),
			).toEqual([eligible.id]);
			expect(await upstreamModels(upstream.responses)).toEqual(["gpt-7-nova"]);
		});

		it.each([
			"paused",
			"requires_reauth",
			"custom_endpoint",
		] as const)("does not prime an exact role route to a %s account", async (kind) => {
			const account = coldRoleAccount();
			if (kind === "paused") account.paused = true;
			else if (kind === "requires_reauth") account.requires_reauth = true;
			else account.custom_endpoint = "https://codex-gateway.example.test";
			const harness = makeRoleContext([account]);
			const upstream = installCodexRoleUpstream();

			const failed = await send(harness.ctx, ROLE_PICKER);

			expect(failed.response.status).toBe(503);
			expect(upstream.catalogReads).toEqual([]);
			expect(upstream.responses).toHaveLength(0);
		});
	});
});
