import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
	Provider,
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
	ProviderServerToolCapabilityContext,
} from "@better-ccflare/providers";
import type {
	Account,
	RequestMeta,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
	ServerToolReplayAtom,
	ServerToolRequirements,
} from "@better-ccflare/types";
import { ServerToolCandidateCapabilityError } from "../../server-tool-routing-errors";
import type { ProxyContext } from "../proxy-types";

// Source worktrees intentionally omit generated database worker bundles. This
// harness injects dbOps and never constructs the database classes.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

// Records every response handed to cancelDiscardedResponseBody, so the
// "releases the rate-limit-check clone" test below (529 failover describe
// block) can observe the release. Since the v3.5.48 sync, that call site
// (disposing `responseForRateLimitCheck` after classification) migrated
// from discardUnusedResponse(responseForRateLimitCheck,
// "rate_limit_check_clone") (real body.cancel(reason)) to
// cancelDiscardedResponseBody (chunked drain-to-done, no reason arg --
// body.cancel() is a measured leak no-op on released Bun). A global
// `ReadableStream.prototype.cancel` reason-string spy can no longer see
// this release, so we spy at the module boundary instead. Reimplements the
// real chunked-drain behaviour (rather than delegating to the actual
// module) so every other discard site funnelled through this same helper
// elsewhere in this file keeps working identically.
const discardedResponses: Response[] = [];
async function drainBody(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}
mock.module("../discard-body-cancel", () => ({
	// Also re-exported for response-processor.ts, which imports `drainBody`
	// directly (not through `cancelDiscardedResponseBody`).
	drainBody,
	cancelDiscardedResponseBody(response: Response | null | undefined): void {
		if (!response) return;
		const body = response.body;
		if (!body || body.locked) return;
		discardedResponses.push(response);
		void drainBody(body).catch(() => {});
	},
}));

const { buildServerToolCapabilityProofKey, getProvider } = await import(
	"@better-ccflare/providers"
);
const {
	boundResponseBodyForClassification,
	isModelUnavailableError,
	proxyWithAccount,
} = await import("../proxy-operations");
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");
const { bindRequestPrivateServerToolReplay } = await import(
	"../../server-tool-replay-runtime"
);
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"../../__tests__/helpers/server-tool-replay-runtime"
);
const { opaqueRuntimeId } = await import("../../opaque-runtime-id");

const TEST_REPLAY_CREDENTIAL = "Bearer proxy-operations-server-tool-test";
const TEST_REPLAY_LINEAGE = "proxy-operations-server-tool-session";
const TEST_SERVER_TOOL_REPLAY_RUNTIME =
	await createReadyServerToolReplayRuntimeForTest();

// Minimal Account fixture for openai-compatible provider
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "kilo-test",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
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
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

// Native xAI account fixture (R5-R10): provider "xai" resolves to the real
// registered XaiProvider via getProvider() inside proxyWithAccount (not the
// ctx.provider override used by the generic/anthropic fixtures above), since
// importing proxy-operations.ts transitively registers all built-in
// providers. custom_endpoint/model_mappings are left unset so XaiProvider's
// beforeConvert() supplies its own xAI defaults.
function makeXaiAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		provider: "xai",
		custom_endpoint: null,
		model_mappings: null,
		...overrides,
	});
}

function makeZaiAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		provider: "zai",
		custom_endpoint: null,
		model_mappings: null,
		...overrides,
	});
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://openrouter.ai/api/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

function enableServerToolReplay(ctx: ProxyContext): ProxyContext {
	ctx.serverToolReplay = TEST_SERVER_TOOL_REPLAY_RUNTIME;
	return ctx;
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: {
			"Content-Type": "application/json",
			authorization: TEST_REPLAY_CREDENTIAL,
			"x-claude-code-session-id": TEST_REPLAY_LINEAGE,
		},
	});
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeAttemptPlanningProvider(
	options: {
		onPlan?: (context: ProviderAttemptPlanContext) => void;
		onRefresh?: () => void;
		onPlanHook?: (hook: string, plan: ProviderAttemptPlan) => void;
		throwDuringPlanning?: boolean;
	} = {},
): Provider {
	const provider = {
		name: "attempt-plan-test",
		cacheReplayModelStrategy: "transformed-body" as const,
		canHandle: () => true,
		refreshToken: async (account: Account) => {
			options.onRefresh?.();
			return {
				accessToken: "refreshed-token",
				expiresAt: Date.now() + 60 * 60 * 1000,
				refreshToken: account.refresh_token ?? "refresh-token",
			};
		},
		buildUrl: () => "https://legacy.invalid/v1/messages",
		prepareHeaders: (headers: Headers) => new Headers(headers),
		transformRequestBody: async (request: Request) => request,
		processResponse: async (response: Response) => response,
		parseRateLimit: (response: Response) => ({
			isRateLimited: response.status === 529,
		}),
		isStreamingResponse: () => false,
		createAttemptPlan(context: ProviderAttemptPlanContext) {
			options.onPlan?.(context);
			if (options.throwDuringPlanning) {
				throw new Error("intentional planning failure");
			}

			const targetUrl = `https://planned.invalid/${encodeURIComponent(
				context.account.id,
			)}/${encodeURIComponent(context.physicalModel ?? "none")}`;
			const candidate: ProviderAttemptPlan = {
				providerName: provider.name,
				targetUrl,
				apiFamily: "test-responses",
				physicalModel: context.physicalModel,
				capabilityProofKey: context.capabilityProofKey,
				inputReplayMode: context.inputReplayMode,
				outputReplayMode: context.outputReplayMode,
				dataRetryPolicy: { mode: "reuse-same-plan", maxAttempts: 3 },
				classifyNoExecution: async () => ({
					decision: "executing_or_ambiguous",
				}),
				cacheReplayModelStrategy: "transformed-body",
				prepareHeaders(headers, accessToken, apiKey) {
					options.onPlanHook?.("prepareHeaders", this);
					const prepared = new Headers(headers);
					prepared.set(
						"authorization",
						`Bearer ${accessToken || apiKey || "plan-test"}`,
					);
					return prepared;
				},
				async transformRequestBody(request) {
					options.onPlanHook?.("transformRequestBody", this);
					return request;
				},
				async processResponse(response) {
					options.onPlanHook?.("processResponse", this);
					return response;
				},
				parseRateLimit(response) {
					options.onPlanHook?.("parseRateLimit", this);
					return { isRateLimited: response.status === 529 };
				},
				isStreamingResponse(response) {
					options.onPlanHook?.("isStreamingResponse", this);
					return (
						response.headers
							.get("content-type")
							?.includes("text/event-stream") ?? false
					);
				},
				async extractUsageInfo() {
					options.onPlanHook?.("extractUsageInfo", this);
					return null;
				},
			};
			return candidate;
		},
	} satisfies Provider;
	return provider;
}

const SERVER_TOOL_REQUIREMENTS: ServerToolRequirements = Object.freeze({
	revision: 2,
	profileId:
		"web-search-20250305-v1:domains-none:max-none:location-absent:client-no",
	optionProfileId:
		"server-tool-option-profile-v1.sha256.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	responseMode: "json",
	mixedToolMode: "server_only",
	declarations: Object.freeze([
		Object.freeze({ type: "web_search_20250305" as const }),
	]),
	replay: Object.freeze({
		input: Object.freeze(["native-Anthropic" as const]),
		output: Object.freeze(["proxy-evidence-v1" as const]),
		requiresOutputReplay: true,
	}),
});

const PROVEN_INPUT_REPLAY = Object.freeze([
	"native-Anthropic",
	"proxy-evidence-v1",
] as const satisfies readonly ServerToolReplayAtom[]);
const PROVEN_OUTPUT_REPLAY = Object.freeze([
	"native-Anthropic",
	"proxy-evidence-v1",
] as const satisfies readonly ServerToolReplayAtom[]);

function makeServerToolCapabilityTuple(
	context: ProviderServerToolCapabilityContext,
	providerName: string,
	inputReplay: readonly ServerToolReplayAtom[] = PROVEN_INPUT_REPLAY,
	outputReplay: readonly ServerToolReplayAtom[] = PROVEN_OUTPUT_REPLAY,
): ServerToolCapabilityTuple {
	const capabilityAccount = context.account as unknown as {
		customEndpoint?: string | null;
		custom_endpoint?: string | null;
	};
	const { optionProfileId, responseMode, mixedToolMode } = context.requirements;
	if (!optionProfileId || !responseMode || !mixedToolMode) {
		throw new Error("Expected exact server-tool requirement profile");
	}
	return Object.freeze({
		candidateId: context.candidateId,
		provider: providerName,
		authMode: "api-key",
		endpointClass: "test-responses",
		normalizedEndpoint:
			capabilityAccount.customEndpoint ??
			capabilityAccount.custom_endpoint ??
			"https://planned.invalid/v1/responses",
		model: context.physicalModel,
		toolType: "web_search_20250305",
		profile: context.requirements.profileId ?? "missing-profile",
		optionProfile: optionProfileId,
		responseMode,
		mixedToolMode,
		inputReplay: Object.freeze([...inputReplay]),
		outputReplay: Object.freeze([...outputReplay]),
		providerContractRevision: "test-provider-contract-v1",
		replayDecoderRevision: "server-tool-replay-v1",
		requestTransport: "test-responses-json",
		responseTransport: "test-responses-json",
	});
}

function makeServerToolCapabilityProof(
	tuple: ServerToolCapabilityTuple,
	revision: string,
): ServerToolCapabilityProof {
	return Object.freeze({
		revision,
		tuple,
		decision: "proven",
		provenance: "sanitized-test-fixture",
		owner: "proxy-test",
		verifiedAt: "2026-07-29T00:00:00.000Z",
		revalidateAfter: "2035-07-29T00:00:00.000Z",
		fixtureRevision: "fixture-v1",
		contractRevision: "test-provider-contract-v1",
		revalidationTriggers: Object.freeze([
			"tuple_change",
			"contract_change",
			"decoder_change",
			"observed_behavior_change",
		]),
	});
}

async function bindServerToolCandidate(
	meta: RequestMeta,
	input: {
		provider: string;
		physicalModel: string;
		proof: ServerToolCapabilityProof;
		requirements?: ServerToolRequirements;
		replayRuntimeStatus?:
			| "not_required"
			| "ready"
			| "input_unavailable"
			| "output_unavailable";
	},
): Promise<RequestMeta> {
	const proofKey = buildServerToolCapabilityProofKey(
		input.proof.revision,
		input.proof.tuple,
	);
	expect(proofKey).toBeDefined();
	const boundMeta = {
		...meta,
		serverToolRequirements: input.requirements ?? SERVER_TOOL_REQUIREMENTS,
		routingCandidates: [
			{
				candidateId: input.proof.tuple.candidateId,
				accountId: "acc-1",
				tier: 0,
				ordinal: 0,
				comboSlotId: null,
				modelOverride: input.physicalModel,
				quotaPressure: null,
				serverToolCapability: {
					resolvedProvider: input.provider,
					physicalModel: input.physicalModel,
					decision: "proven",
					reason: null,
					proofKey,
					inputReplayMode: input.proof.tuple.inputReplay,
					outputReplayMode: input.proof.tuple.outputReplay,
					replayRuntimeStatus: input.replayRuntimeStatus ?? "ready",
				},
			},
		],
	} as RequestMeta;
	const identityRequest = makeRequest(makeRequestBody(input.physicalModel));
	expect(
		await bindRequestPrivateServerToolReplay(
			boundMeta,
			TEST_SERVER_TOOL_REPLAY_RUNTIME,
			{
				request: identityRequest,
				apiKeyId: null,
				audience: opaqueRuntimeId("model-route-caller", TEST_REPLAY_CREDENTIAL),
				lineage: TEST_REPLAY_LINEAGE,
			},
		),
	).toBe(true);
	return boundMeta;
}

async function makeHostedDispatchFixture() {
	const provider = makeAttemptPlanningProvider();
	provider.createServerToolCapabilityTuple = (context) =>
		makeServerToolCapabilityTuple(context, provider.name);
	provider.resolveServerToolCapability = (_requirements, tuple) => ({
		decision: "proven",
		proof: makeServerToolCapabilityProof(tuple, "proof:dispatch-matrix"),
	});
	const account = makeAccount({
		provider: provider.name,
		model_mappings: JSON.stringify({ primary: ["primary", "fallback"] }),
	});
	const tuple = makeServerToolCapabilityTuple(
		{
			candidateId: "account:acc-1",
			account,
			path: "/v1/messages",
			query: "",
			physicalModel: "primary",
			requirements: SERVER_TOOL_REQUIREMENTS,
		},
		provider.name,
	);
	const meta = await bindServerToolCandidate(makeRequestMeta(), {
		provider: provider.name,
		physicalModel: "primary",
		proof: makeServerToolCapabilityProof(tuple, "proof:dispatch-matrix"),
	});
	const ctx = enableServerToolReplay(makeProxyContext());
	ctx.provider = provider;
	return {
		account,
		bodyBuffer: makeRequestBody("primary"),
		ctx,
		ledger: new RoutingAttemptLedger(),
		meta,
	};
}

describe("proxyWithAccount — immutable provider attempt plans", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalOverloadEnabled: string | undefined;
	let originalOverloadAttempts: string | undefined;
	let originalOverloadBaseMs: string | undefined;
	let originalOverloadMaxMs: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalOverloadEnabled = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		originalOverloadAttempts = process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		originalOverloadBaseMs = process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		originalOverloadMaxMs = process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of [
			["CCFLARE_OVERLOAD_RETRY_ENABLED", originalOverloadEnabled],
			["CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS", originalOverloadAttempts],
			["CCFLARE_OVERLOAD_RETRY_BASE_MS", originalOverloadBaseMs],
			["CCFLARE_OVERLOAD_RETRY_MAX_MS", originalOverloadMaxMs],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("bypasses a custom planner for an ordinary proof-null attempt", async () => {
		const planningContexts: Array<{
			bodyModel: string | undefined;
			physicalModel: string | null;
			inputReplayMode: readonly string[];
			outputReplayMode: readonly string[];
		}> = [];
		let refreshCalls = 0;
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: "unexpected" }, 500),
		);
		const provider = makeAttemptPlanningProvider({
			throwDuringPlanning: true,
			onRefresh: () => refreshCalls++,
			onPlan: (context) => {
				const body = context.requestBodyBuffer
					? (JSON.parse(
							new TextDecoder().decode(context.requestBodyBuffer),
						) as {
							model?: string;
						})
					: {};
				planningContexts.push({
					bodyModel: body.model,
					physicalModel: context.physicalModel,
					inputReplayMode: context.inputReplayMode,
					outputReplayMode: context.outputReplayMode,
				});
			},
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const account = makeAccount({
			provider: "attempt-plan-test",
			api_key: null,
			access_token: null,
			expires_at: null,
			refresh_token: "refresh-token",
		});
		const bodyBuffer = makeRequestBody("source-model");
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				"combo-final-model",
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector")
			) {
				throw error;
			}
		}

		expect(result).toBeNull();
		expect(planningContexts).toEqual([]);
		expect(refreshCalls).toBe(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps ordinary physical-model fallbacks on the legacy plan path", async () => {
		const planned: Array<{
			physicalModel: string | null;
			bodyModel: string | undefined;
		}> = [];
		const fetched: Array<{ url: string; model: string | undefined }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const body = (await request.clone().json()) as { model?: string };
			fetched.push({ url: request.url, model: body.model });
			return fetched.length === 1
				? jsonResponse({ error: { message: "rate limited" } }, 429)
				: jsonResponse({ ok: true }, 200);
		});
		const provider = makeAttemptPlanningProvider({
			onPlan: (context) => {
				const body = context.requestBodyBuffer
					? (JSON.parse(
							new TextDecoder().decode(context.requestBodyBuffer),
						) as {
							model?: string;
						})
					: {};
				planned.push({
					physicalModel: context.physicalModel,
					bodyModel: body.model,
				});
			},
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const account = makeAccount({
			provider: "attempt-plan-test",
			model_mappings: JSON.stringify({
				primary: ["primary", "fallback"],
			}),
		});
		const bodyBuffer = makeRequestBody("primary");
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector")
			) {
				throw error;
			}
		}

		expect(planned).toEqual([]);
		expect(fetched).toEqual([
			{
				url: "https://legacy.invalid/v1/messages",
				model: "primary",
			},
			{
				url: "https://legacy.invalid/v1/messages",
				model: "fallback",
			},
		]);
	});

	it("does not invoke a proof-only planner for ordinary fallback rematerialization", async () => {
		let planningCount = 0;
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: { message: "rate limited" } }, 429),
		);
		const provider = makeAttemptPlanningProvider({
			onPlan: () => {
				planningCount++;
				if (planningCount === 2) {
					throw new Error("fallback planning failed");
				}
			},
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const account = makeAccount({
			provider: "attempt-plan-test",
			model_mappings: JSON.stringify({
				primary: ["primary", "fallback"],
			}),
		});
		const bodyBuffer = makeRequestBody("primary");
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(planningCount).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it("does not invoke a proof-only planner across ordinary account failover", async () => {
		const plannedAccountIds: string[] = [];
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: "unauthorized" }, 401),
		);
		const provider = makeAttemptPlanningProvider({
			onPlan: (context) => plannedAccountIds.push(context.account.id),
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const bodyBuffer = makeRequestBody("primary");
		for (const accountId of ["account-a", "account-b"]) {
			const result = await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				makeAccount({ id: accountId, provider: "attempt-plan-test" }),
				makeRequestMeta({ id: `request-${accountId}` }),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
			expect(result).toBeNull();
		}

		expect(plannedAccountIds).toEqual([]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it("captures one ordinary legacy plan for in-place retry and response finalization", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		let planningCount = 0;
		let sourceProviderHookCalls = 0;
		const hookPlans: Array<{ hook: string; plan: ProviderAttemptPlan }> = [];
		const provider = makeAttemptPlanningProvider({
			onPlan: () => planningCount++,
			onPlanHook: (hook, plan) => hookPlans.push({ hook, plan }),
		});
		globalThis.fetch = mock(async () => {
			if (
				(globalThis.fetch as ReturnType<typeof mock>).mock.calls.length === 1
			) {
				// Planning has already captured every downstream hook. Mutating the
				// source singleton now must not affect retry parsing or finalization.
				provider.processResponse = async (response) => {
					sourceProviderHookCalls++;
					return response;
				};
				provider.parseRateLimit = () => {
					sourceProviderHookCalls++;
					return { isRateLimited: false };
				};
				provider.extractUsageInfo = async () => {
					sourceProviderHookCalls++;
					return null;
				};
				return jsonResponse({ error: { type: "overloaded_error" } }, 529);
			}
			return jsonResponse({ ok: true }, 200);
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const bodyBuffer = makeRequestBody("primary");
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				makeAccount({ provider: "attempt-plan-test" }),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector")
			) {
				throw error;
			}
		}

		expect(planningCount).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(hookPlans).toHaveLength(0);
		expect(sourceProviderHookCalls).toBe(0);
	});

	it("never exposes legacy request-scoped account mutations on the shared account", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: "unauthorized" }, 401),
		);
		const provider = makeAttemptPlanningProvider();
		Reflect.deleteProperty(provider, "createAttemptPlan");
		provider.prepareRequest = (_request, _body, attemptAccount) => {
			attemptAccount.custom_endpoint = "https://request-local.invalid";
			attemptAccount.model_mappings = JSON.stringify({
				primary: "request-local",
			});
		};
		provider.buildUrl = (_path, _query, attemptAccount) =>
			`${attemptAccount?.custom_endpoint}/v1/messages`;
		const ctx = makeProxyContext();
		ctx.provider = provider;
		const account = makeAccount({
			provider: "attempt-plan-test",
			custom_endpoint: "https://shared.invalid",
			model_mappings: JSON.stringify({ primary: "shared" }),
		});
		const originalEndpoint = account.custom_endpoint;
		const originalMappings = account.model_mappings;
		const bodyBuffer = makeRequestBody("primary");
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.custom_endpoint).toBe(originalEndpoint);
		expect(account.model_mappings).toBe(originalMappings);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(
			(globalThis.fetch as ReturnType<typeof mock>).mock.calls[0]?.[0],
		).toBeInstanceOf(Request);
		expect(
			(
				(globalThis.fetch as ReturnType<typeof mock>).mock
					.calls[0]?.[0] as Request
			).url,
		).toBe("https://request-local.invalid/v1/messages");
	});
});

describe("proxyWithAccount — exact server-tool capability binding", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("binds the selected candidate's exact proof and proof-owned replay modes before credentials", async () => {
		const events: string[] = [];
		const planContexts: ProviderAttemptPlanContext[] = [];
		let refreshCalls = 0;
		const provider = makeAttemptPlanningProvider({
			throwDuringPlanning: true,
			onRefresh: () => {
				refreshCalls++;
				events.push("refresh");
			},
			onPlan: (context) => {
				planContexts.push(context);
				events.push("plan");
			},
		});
		provider.createServerToolCapabilityTuple = (context) => {
			events.push("tuple");
			return makeServerToolCapabilityTuple(context, provider.name);
		};
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			events.push("resolve");
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(tuple, "proof-initial"),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			api_key: null,
			access_token: null,
			expires_at: null,
			refresh_token: "refresh-token",
			model_mappings: JSON.stringify({ primary: "primary" }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const initialProof = makeServerToolCapabilityProof(
			initialTuple,
			"proof-initial",
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: initialProof,
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const bodyBuffer = makeRequestBody("primary");
		globalThis.fetch = mock(async () =>
			jsonResponse({ unexpected: true }, 500),
		);

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			meta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ routeCandidateId: "account:acc-1" },
		);

		expect(result).toBeNull();
		expect(events).toEqual(["tuple", "resolve", "plan"]);
		expect(refreshCalls).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(planContexts).toHaveLength(1);
		expect(planContexts[0]?.capabilityProofKey).toBe(
			buildServerToolCapabilityProofKey(
				initialProof.revision,
				initialProof.tuple,
			),
		);
		expect(planContexts[0]?.inputReplayMode).toEqual(PROVEN_INPUT_REPLAY);
		expect(planContexts[0]?.outputReplayMode).toEqual(PROVEN_OUTPUT_REPLAY);
		expect(planContexts[0]?.inputReplayMode).not.toEqual(
			SERVER_TOOL_REQUIREMENTS.replay.input,
		);
		expect(planContexts[0]?.serverToolHistoryProjector).toBeFunction();
		expect(planContexts[0]?.serverToolReplayIssuer).toBeFunction();
		expect(
			Object.isFrozen(planContexts[0]?.serverToolHistoryProjector as object),
		).toBe(true);
		expect(
			Object.isFrozen(planContexts[0]?.serverToolReplayIssuer as object),
		).toBe(true);
		expect(JSON.stringify(meta)).not.toContain("serverToolReplayIssuer");
		expect(JSON.stringify(meta)).not.toContain("serverToolHistoryProjector");
	});

	it("revalidates request-private identity immediately before transform", async () => {
		let planningCount = 0;
		let transformCalls = 0;
		let resolutionCount = 0;
		const bodyBuffer = makeRequestBody("primary");
		const request = makeRequest(bodyBuffer);
		const provider = makeAttemptPlanningProvider({
			onPlan: () => {
				planningCount += 1;
				request.headers.set("authorization", "Bearer rematerialized-identity");
			},
			onPlanHook: (hook) => {
				if (hook === "transformRequestBody") transformCalls += 1;
			},
		});
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(context, provider.name);
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			resolutionCount += 1;
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(tuple, "proof-stable"),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: "primary" }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: makeServerToolCapabilityProof(initialTuple, "proof-stable"),
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		globalThis.fetch = mock(async () =>
			jsonResponse({ unexpected: true }, 500),
		);

		let caught: unknown;
		try {
			await proxyWithAccount(
				request,
				new URL("https://proxy.local/v1/messages"),
				account,
				meta,
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				{ routeCandidateId: "account:acc-1" },
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ServerToolCandidateCapabilityError);
		expect((caught as ServerToolCandidateCapabilityError).reason).toBe(
			"replay_unavailable",
		);
		expect(planningCount).toBe(1);
		expect(resolutionCount).toBe(2);
		expect(transformCalls).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
	});

	it("fails locally when the exact proof identity drifts immediately before transform", async () => {
		let resolutionCount = 0;
		let transformCalls = 0;
		const provider = makeAttemptPlanningProvider({
			onPlanHook: (hook) => {
				if (hook === "transformRequestBody") transformCalls++;
			},
		});
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(context, provider.name);
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			resolutionCount++;
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(
					tuple,
					resolutionCount === 1 ? "proof-stable" : "proof-drifted",
				),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: "primary" }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: makeServerToolCapabilityProof(initialTuple, "proof-stable"),
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const bodyBuffer = makeRequestBody("primary");
		globalThis.fetch = mock(async () =>
			jsonResponse({ unexpected: true }, 500),
		);

		await expect(
			proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				meta,
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				{ routeCandidateId: "account:acc-1" },
			),
		).rejects.toBeInstanceOf(ServerToolCandidateCapabilityError);
		expect(resolutionCount).toBe(2);
		expect(transformCalls).toBe(0);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
	});

	it("terminates a hosted request before any physical-model fallback can plan or send", async () => {
		const plans: Array<{
			model: string | null;
			proofKey: string | null;
			inputReplay: readonly ServerToolReplayAtom[];
			outputReplay: readonly ServerToolReplayAtom[];
		}> = [];
		const resolutionModels: string[] = [];
		const provider = makeAttemptPlanningProvider({
			onPlan: (context) => {
				plans.push({
					model: context.physicalModel,
					proofKey: context.capabilityProofKey,
					inputReplay: context.inputReplayMode,
					outputReplay: context.outputReplayMode,
				});
			},
		});
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(
				context,
				provider.name,
				context.physicalModel === "fallback"
					? (["native-Anthropic"] as const)
					: PROVEN_INPUT_REPLAY,
				context.physicalModel === "fallback"
					? (["proxy-evidence-v1"] as const)
					: PROVEN_OUTPUT_REPLAY,
			);
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			resolutionModels.push(tuple.model);
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(tuple, `proof:${tuple.model}`),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: ["primary", "fallback"] }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const initialProof = makeServerToolCapabilityProof(
			initialTuple,
			"proof:primary",
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: initialProof,
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const ledger = new RoutingAttemptLedger();
		const bodyBuffer = makeRequestBody("primary");
		globalThis.fetch = mock(async () =>
			(globalThis.fetch as ReturnType<typeof mock>).mock.calls.length === 1
				? jsonResponse({ error: { message: "rate limited" } }, 429)
				: jsonResponse({ ok: true }, 200),
		);

		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				meta,
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
				{ routeCandidateId: "account:acc-1" },
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector")
			) {
				throw error;
			}
		}

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(
			(
				(globalThis.fetch as ReturnType<typeof mock>).mock
					.calls[0]?.[0] as Request
			).redirect,
		).toBe("manual");
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
		// Initial resolution, pre-transform revalidation, and the final pre-dispatch
		// revalidation all bind the same proof before the one physical send.
		expect(resolutionModels).toEqual(["primary", "primary", "primary"]);
		expect(plans).toEqual([
			{
				model: "primary",
				proofKey: buildServerToolCapabilityProofKey(
					"proof:primary",
					initialTuple,
				),
				inputReplay: PROVEN_INPUT_REPLAY,
				outputReplay: PROVEN_OUTPUT_REPLAY,
			},
		]);
	});

	it.each([
		"before",
		"after",
	] as const)("aborting %s the hosted claim keeps physical dispatch bounded", async (phase) => {
		const provider = makeAttemptPlanningProvider();
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(context, provider.name);
		provider.resolveServerToolCapability = (_requirements, tuple) => ({
			decision: "proven",
			proof: makeServerToolCapabilityProof(tuple, "proof:abort"),
		});
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: "primary" }),
		});
		const tuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: makeServerToolCapabilityProof(tuple, "proof:abort"),
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const ledger = new RoutingAttemptLedger();
		const bodyBuffer = makeRequestBody("primary");
		const controller = new AbortController();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				authorization: TEST_REPLAY_CREDENTIAL,
				"x-claude-code-session-id": TEST_REPLAY_LINEAGE,
			},
		});
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			if (phase === "after") controller.abort("after hosted claim");
			throw new DOMException("aborted", "AbortError");
		});
		if (phase === "before") controller.abort("before hosted claim");

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			meta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			{ routeCandidateId: "account:acc-1" },
		);

		expect(result?.status).toBe(499);
		expect(fetchCalls).toBe(phase === "before" ? 0 : 1);
		expect(ledger.hostedDispatchState).toBe(
			phase === "before" ? "undispatched" : "hosted_dispatched",
		);
	});

	it.each([
		[400, { error: { message: "cache_control is not supported" } }],
		[401, { error: { message: "invalid credentials" } }],
		[429, { error: { message: "rate limited" } }],
		[529, { error: { type: "overloaded_error" } }],
		[500, { error: { message: "upstream failure" } }],
		[302, { redirect: true }],
	] as const)("keeps a hosted %i response terminal at one manual-redirect HTTP send", async (status, responseBody) => {
		const { account, bodyBuffer, ctx, ledger, meta } =
			await makeHostedDispatchFixture();
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			expect(request.redirect).toBe("manual");
			return new Response(JSON.stringify(responseBody), {
				status,
				headers: {
					"content-type": "application/json",
					...(status === 302
						? { location: "https://redirect.invalid/second-send" }
						: {}),
				},
			});
		});

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			meta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			{ routeCandidateId: "account:acc-1" },
		);

		expect(result?.status).toBe(502);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(ledger.physicalAttemptCount).toBe(1);
		expect(ledger.hostedDispatchState).toBe("hosted_dispatched");
	});

	it("requires the explicit recompute flag when a deferred route changes the admitted physical model", async () => {
		const primaryModel = "claude-sonnet-4-5";
		const deferredModel = "claude-opus-4-5";
		const resolutionModels: string[] = [];
		const provider = makeAttemptPlanningProvider();
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(context, provider.name);
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			resolutionModels.push(tuple.model);
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(tuple, `proof:${tuple.model}`),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			custom_endpoint: "https://planned.invalid/v1/responses",
			model_mappings: JSON.stringify({
				sonnet: primaryModel,
				opus: deferredModel,
			}),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account: {
					provider: provider.name,
					apiKeyConfigured: true,
					refreshTokenConfigured: false,
					accessTokenConfigured: false,
					legacyMirroredApiKey: false,
					customEndpoint: "https://planned.invalid/v1/responses",
					customEndpointConfigured: true,
					unsafeCustomEndpoint: false,
					crossRegionMode: null,
					billingType: null,
				},
				endpointContract: {
					routeClass: "anthropic_messages",
					queryPresent: false,
				},
				physicalModel: primaryModel,
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: primaryModel,
			proof: makeServerToolCapabilityProof(
				initialTuple,
				`proof:${primaryModel}`,
			),
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const bodyBuffer = makeRequestBody(primaryModel);
		globalThis.fetch = mock(async () => jsonResponse({ ok: true }, 200));

		await expect(
			proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				meta,
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				deferredModel,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				{ routeCandidateId: "account:acc-1" },
			),
		).rejects.toBeInstanceOf(ServerToolCandidateCapabilityError);
		expect(globalThis.fetch).toHaveBeenCalledTimes(0);

		resolutionModels.length = 0;
		const recomputedLedger = new RoutingAttemptLedger();
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				meta,
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				deferredModel,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				recomputedLedger,
				{
					routeCandidateId: "account:acc-1",
					recomputeServerToolCapability: true,
				},
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("UsageCollector")
			) {
				throw error;
			}
		}

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(recomputedLedger.hostedDispatchState).toBe("hosted_dispatched");
		expect(resolutionModels).toEqual([
			deferredModel,
			deferredModel,
			deferredModel,
		]);
	});

	it("does not recheck or plan fallback replay after hosted dispatch", async () => {
		const replayFlexibleRequirements: ServerToolRequirements = Object.freeze({
			...SERVER_TOOL_REQUIREMENTS,
			replay: Object.freeze({
				input: Object.freeze([]),
				output: Object.freeze([]),
				requiresOutputReplay: true,
			}),
		});
		const plannedModels: Array<string | null> = [];
		const resolutionModels: string[] = [];
		const provider = makeAttemptPlanningProvider({
			onPlan: (context) => plannedModels.push(context.physicalModel),
		});
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(
				context,
				provider.name,
				["native-Anthropic"],
				context.physicalModel === "fallback"
					? ["proxy-evidence-v1"]
					: ["native-Anthropic"],
			);
		provider.resolveServerToolCapability = (_requirements, tuple) => {
			resolutionModels.push(tuple.model);
			return {
				decision: "proven",
				proof: makeServerToolCapabilityProof(tuple, `proof:${tuple.model}`),
			};
		};
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: ["primary", "fallback"] }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: replayFlexibleRequirements,
			},
			provider.name,
			["native-Anthropic"],
			["native-Anthropic"],
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: makeServerToolCapabilityProof(initialTuple, "proof:primary"),
			requirements: replayFlexibleRequirements,
			replayRuntimeStatus: "not_required",
		});
		const ctx = makeProxyContext();
		ctx.provider = provider;
		ctx.serverToolReplay = Object.freeze({ status: "disabled" });
		const ledger = new RoutingAttemptLedger();
		const bodyBuffer = makeRequestBody("primary");
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: { message: "rate limited" } }, 429),
		);

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			meta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			{ routeCandidateId: "account:acc-1" },
		);

		expect(result?.status).toBe(502);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(ledger.attemptedCount).toBe(1);
		expect(ledger.physicalAttemptCount).toBe(1);
		expect(plannedModels).toEqual(["primary"]);
		expect(resolutionModels).toEqual(["primary", "primary", "primary"]);
	});

	it("never resolves an incapable physical fallback after hosted dispatch", async () => {
		const plannedModels: Array<string | null> = [];
		const transformedModels: string[] = [];
		const provider = makeAttemptPlanningProvider({
			onPlan: (context) => plannedModels.push(context.physicalModel),
			onPlanHook: (hook, plan) => {
				if (hook === "transformRequestBody") {
					transformedModels.push(plan.physicalModel ?? "none");
				}
			},
		});
		provider.createServerToolCapabilityTuple = (context) =>
			makeServerToolCapabilityTuple(context, provider.name);
		provider.resolveServerToolCapability = (_requirements, tuple) =>
			tuple.model === "fallback"
				? ({
						decision: "unknown",
						reason: "no_exact_proof",
					} satisfies ServerToolCapabilityDecision)
				: {
						decision: "proven",
						proof: makeServerToolCapabilityProof(tuple, "proof:primary"),
					};
		const account = makeAccount({
			provider: provider.name,
			model_mappings: JSON.stringify({ primary: ["primary", "fallback"] }),
		});
		const initialTuple = makeServerToolCapabilityTuple(
			{
				candidateId: "account:acc-1",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "primary",
				requirements: SERVER_TOOL_REQUIREMENTS,
			},
			provider.name,
		);
		const meta = await bindServerToolCandidate(makeRequestMeta(), {
			provider: provider.name,
			physicalModel: "primary",
			proof: makeServerToolCapabilityProof(initialTuple, "proof:primary"),
		});
		const ctx = enableServerToolReplay(makeProxyContext());
		ctx.provider = provider;
		const ledger = new RoutingAttemptLedger();
		const bodyBuffer = makeRequestBody("primary");
		globalThis.fetch = mock(async () =>
			jsonResponse({ error: { message: "rate limited" } }, 429),
		);

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			meta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			{ routeCandidateId: "account:acc-1" },
		);
		expect(result?.status).toBe(502);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(ledger.attemptedCount).toBe(1);
		expect(ledger.physicalAttemptCount).toBe(1);
		expect(plannedModels).toEqual(["primary"]);
		expect(transformedModels).toEqual(["primary"]);
	});

	it("uses the same canonical provider alias identity for transport execution", async () => {
		const canonicalAnthropic = getProvider("anthropic");
		expect(canonicalAnthropic).toBeDefined();
		const fallbackProvider = makeAttemptPlanningProvider();
		const ctx = makeProxyContext();
		ctx.provider = fallbackProvider;
		const account = makeAccount({
			provider: "claude-console-api",
			api_key: "test-anthropic-key",
			custom_endpoint: null,
			model_mappings: null,
		});
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const fetchedUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			fetchedUrls.push(request.url);
			return jsonResponse({ error: { type: "authentication_error" } }, 401);
		});

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(fetchedUrls).toHaveLength(1);
		expect(fetchedUrls[0]).toStartWith("https://api.anthropic.com/");
		expect(fetchedUrls[0]).not.toStartWith("https://planned.invalid/");
	});
});

describe("proxyWithAccount — 429 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 429 and no fallback is configured", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc123",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("retries with fallback model on 429, returns response when fallback succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			// Capture request body to verify model was swapped on retry
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length === 1) {
				// Primary model: 429
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message:
								"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
						},
					},
					429,
				);
			}
			// Fallback model: success
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_fallbacks: JSON.stringify({
						sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(2);
		// Second call should use the fallback model
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
	});

	it("returns null (failover) when both primary and fallback model return 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_fallbacks: JSON.stringify({
					sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("cycles through 3-model array: first two 429, third succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length < 3) {
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					},
					429,
				);
			}
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_mappings: JSON.stringify({
						sonnet: [
							"qwen/qwen3.6-plus:free",
							"bytedance-seed/dola-seed-2.0-pro:free",
							"meta-llama/llama-3.3-70b:free",
						],
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(3);
		expect(fetchCalls[0]).toBe("qwen/qwen3.6-plus:free");
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
		expect(fetchCalls[2]).toBe("meta-llama/llama-3.3-70b:free");
	});

	it("skips a preclaimed fallback model and reaches the next distinct model", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const body = (await request.json()) as { model: string };
			fetchCalls.push(body.model);
			return fetchCalls.length === 1
				? jsonResponse({ error: { message: "rate limited" } }, 429)
				: jsonResponse(
						{
							id: "msg_ledger",
							type: "message",
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							model: body.model,
							stop_reason: "end_turn",
							usage: { input_tokens: 1, output_tokens: 1 },
						},
						200,
					);
		});

		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					"qwen/qwen3.6-plus:free",
					"bytedance-seed/dola-seed-2.0-pro:free",
					"meta-llama/llama-3.3-70b:free",
				],
			}),
		});
		const ledger = new RoutingAttemptLedger();
		expect(
			ledger.claim(account.id, "bytedance-seed/dola-seed-2.0-pro:free"),
		).toBe(true);
		const bodyBuffer = makeRequestBody();
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("UsageCollector not initialized")) throw error;
		}

		expect(fetchCalls).toEqual([
			"qwen/qwen3.6-plus:free",
			"meta-llama/llama-3.3-70b:free",
		]);
	});

	it("returns null when all models in the array are exhausted", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});
});

function makeProxyContextWithAsyncExec(): ProxyContext {
	const ctx = makeProxyContext();
	return {
		...ctx,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

describe("proxyWithAccount — rate limit audit trail (issue #178)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("calls markAccountRateLimited with reason='model_fallback_429' on no-fallback 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The asyncWriter.enqueue mock captures calls; markAccountRateLimited
		// is called inside the enqueued job. Since asyncWriter.enqueue is mocked
		// (does not execute the job), we verify via markAccountRateLimited directly.
		// The feature requires markAccountRateLimited to receive a third `reason` arg.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBeGreaterThan(0);
		const [, , reason] = markMock.mock.calls[0] as [string, number, string];
		expect(reason).toBe("model_fallback_429");
	});

	it("calls markAccountRateLimited with reason='all_models_exhausted_429' when all models fail", async () => {
		// All fetch calls return 429 — primary + every fallback model
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		// At least one call should carry the all_models_exhausted_429 reason
		const reasons = markMock.mock.calls.map(
			(args: unknown[]) => args[2] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
	});
});

describe("proxyWithAccount — attribution source pass-through to saveRequest (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("passes requestMeta.projectAttributionSource/agentAttributionSource through to saveRequest at positions 18/19 on the model_fallback_429 failover path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				projectAttributionSource: "header_project",
				agentAttributionSource: "header_agent",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		// Full positional order (0-indexed): id, method, path, accountUsed,
		// statusCode, success, errorMessage, responseTime, failoverAttempts,
		// usage, agentUsed, apiKeyId, apiKeyName, project, billingType,
		// comboName, originalModel, appliedModel, projectAttributionSource,
		// agentAttributionSource.
		expect(args[18]).toBe("header_project");
		expect(args[19]).toBe("header_agent");
	});

	it("passes null attribution sources through to saveRequest when requestMeta omits them", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(), // no attribution source overrides
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const reasons = saveRequestMock.mock.calls.map(
			(args: unknown[]) => args[6] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call[18]).toBeNull();
		expect(call[19]).toBeNull();
	});
});

describe("proxyWithAccount — originalModel/appliedModel gated by isModelRewrite on direct 429 saveRequest paths (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("persists null/null (not the equal pair) on the model_fallback_429 path when requestMeta carries an unmodified originalModel/appliedModel pair", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				// Agent-detected but NOT rewritten: original === applied. Before the
				// fix this bypassed isModelRewrite and persisted the equal pair,
				// making an untouched request look like a real rewrite.
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-sonnet-4-5",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		expect(args[16]).toBeNull();
		expect(args[17]).toBeNull();
	});

	it("still persists a genuine originalModel/appliedModel rewrite pair on the all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta({
				originalModel: "claude-sonnet-4-5",
				appliedModel: "qwen/qwen3.6-plus:free",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call).toBeDefined();
		expect(call[16]).toBe("claude-sonnet-4-5");
		expect(call[17]).toBe("qwen/qwen3.6-plus:free");
	});
});

describe("proxyWithAccount — in-memory cooldown mutation (issue #178 fix)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sets account.rate_limited_until on model_fallback_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// In-memory mutation should be set immediately (before DB write completes)
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});

	it("sets account.rate_limited_until on all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					"qwen/qwen3.6-plus:free",
					"bytedance-seed/dola-seed-2.0-pro:free",
				],
			}),
		});
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});
});

describe("getModelList — model_fallbacks merge", () => {
	it("merges model_fallbacks into the model list", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
			model_fallbacks: JSON.stringify({
				sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"bytedance-seed/dola-seed-2.0-pro:free",
		]);
	});

	it("returns single-element list when no fallbacks", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const list = getModelList("claude-sonnet-4-5", makeAccount());
		expect(list).toEqual(["qwen/qwen3.6-plus:free"]);
	});

	it("returns array directly when model_mappings value is an array", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["qwen/qwen3.6-plus:free", "meta-llama/llama-3.3-70b:free"],
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"meta-llama/llama-3.3-70b:free",
		]);
	});
});

describe("proxyWithAccount — 529 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 529 and provider parseRateLimit says isRateLimited:true", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		// Override the proxy context to have a provider that treats 529 as rate-limited
		// (matching the Anthropic provider's parseRateLimit behaviour for 529).
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529 || r.status === 429,
				resetTime: r.status === 529 ? Date.now() + 60_000 : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
	});

	it("returns upstream 529 on the final account attempt instead of pool exhaustion", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		// proxyWithAccount reaches forwardToClient on the final-attempt passthrough,
		// which requires UsageCollector initialization (not wired in unit tests).
		// Catch that specific error while still verifying the passthrough path
		// (not pool exhaustion) was reached.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(529);
			const body = (await result.json()) as {
				error: { type: string; message: string };
			};
			expect(body.error.type).toBe("overloaded_error");
			expect(body.error.message).toBe("Overloaded");
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the final-attempt passthrough was taken, not pool
			// exhaustion (which would return null without reaching forwardToClient).
			expect(threwUsageCollectorError).toBe(true);
		}
	});

	it("releases the rate-limit-check clone on the final-attempt 529 passthrough", async () => {
		// Reset the shared discard-site recorder (module-scoped, see the
		// mock.module("../discard-body-cancel", ...) call above) so counts
		// below reflect only this test's request.
		discardedResponses.length = 0;
		// CCFLARE_OVERLOAD_RETRY_ENABLED defaults to true (core/src/constants.ts),
		// so the 529 in-place retry loop also runs here and discards its own
		// superseded `response` via a *different* call site (proxy-operations.ts
		// line ~4817) before this test's target call site (the
		// responseForRateLimitCheck classification-clone disposal, line ~5385)
		// ever runs. Both funnel through the same cancelDiscardedResponseBody
		// primitive, so discardedResponses can contain more than one entry; tag
		// each fetch response with its attempt number so the assertion below
		// can isolate the *last* attempt's response -- the only one that ever
		// reaches the rate-limit-check clone path.
		let fetchCallCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCallCount++;
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-test-fetch-attempt": String(fetchCallCount),
					},
				},
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		try {
			await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// The drain is fire-and-forget (settles on microtasks after
		// proxyWithAccount returns), so yield before observing release.
		await Bun.sleep(0);
		const lastAttemptDiscards = discardedResponses.filter(
			(r) => r.headers.get("x-test-fetch-attempt") === String(fetchCallCount),
		);
		expect(lastAttemptDiscards.length).toBe(1);
	});

	it("isModelUnavailableError returns false for 529 overloaded responses", async () => {
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{ status: 529, headers: { "content-type": "application/json" } },
		);
		expect(await isModelUnavailableError(response)).toBe(false);
	});
});

describe("proxyWithAccount — 529 in-place retry", () => {
	let originalFetch: typeof globalThis.fetch;
	const overloadBody =
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
	const successBody =
		'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	function make529NoResetCtx() {
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529,
				resetTime: undefined, // no reset — triggers in-place retry path
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;
		return ctx;
	}

	it("retries in-place on 529 no-reset and makes exactly 2 fetch calls before succeeding", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const attemptLedger = new RoutingAttemptLedger();
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				attemptLedger,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// fetch was called twice: initial 529 + 1 in-place retry
		expect(callCount).toBe(2);
		expect(attemptLedger.attemptedCount).toBe(1);
		// markAccountRateLimited should NOT have been called — no cooldown on successful retry
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("falls through to cooldown/failover when all retries are exhausted", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				}),
		);

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// All retries exhausted → null (cooldown applied, failover to next account)
		expect(result).toBeNull();
	});

	it("skips in-place retry when CCFLARE_OVERLOAD_RETRY_ENABLED=false", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Disabled — only the initial request, no retries
		expect(callCount).toBe(1);
	});

	it("skips in-place retry for synthetic keepalive requests", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const keepaliveReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
				"x-better-ccflare-internal-probe-secret": "test-secret",
			},
		});
		await proxyWithAccount(
			keepaliveReq,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Keepalive — only the initial request, no in-place retries
		expect(callCount).toBe(1);
	});
});

describe("proxyWithAccount — non-codex 529 in-place retry releases superseded responses (P1)", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalStreamCancel: typeof ReadableStream.prototype.cancel;
	let cancelReasons: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		cancelReasons = [];
		originalStreamCancel = ReadableStream.prototype.cancel;
		ReadableStream.prototype.cancel = function (
			this: ReadableStream,
			reason?: unknown,
		) {
			cancelReasons.push(String(reason));
			return originalStreamCancel.call(this, reason);
		};
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		ReadableStream.prototype.cancel = originalStreamCancel;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	it("cancels both superseded 529 response bodies for a non-codex (anthropic) account, and still forwards the eventual success to the client", async () => {
		const overloadBody =
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
		const successBody =
			'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount <= 2) {
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying both superseded 529 responses
		// were released.
		try {
			await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// Initial 529 + 2 in-place retries (the second retry succeeds).
		expect(callCount).toBe(3);
		const supersededCancels = cancelReasons.filter(
			(r) => r === "in_place_529_retry_superseded",
		);
		expect(supersededCancels.length).toBe(2);
	});
});

describe("proxyWithAccount: Codex 529 in-place retry drains discarded streaming responses", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep, matching the generic
		// "529 in-place retry" describe block above.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * Builds a spy-wrapped Codex SSE upstream Response with two committing
	 * events (self-closing). With the transform's default backpressure
	 * (highWaterMark = 1), the second event blocks CodexProvider's
	 * background processEvents() task inside writeSSE() until something
	 * actively reads or cancels the transformed response: per
	 * provider-stream-abandonment.test.ts, a stream stuck at that point
	 * never notices its own raw upstream closing, because processEvents()
	 * is parked in awaitDownstreamCapacity() and never issues the next
	 * upstream read. So releasing this spy's reader genuinely requires the
	 * retry loop's `await response.arrayBuffer()` drain (or the
	 * discardUnusedResponse hook) to actively consume/cancel the transformed
	 * response; it is not an artifact of the raw upstream eventually
	 * closing on its own. The upstream itself still self-closes (rather than
	 * staying open forever like the abandonment test's fixture) because this
	 * test's drain calls are meant to complete, not merely be checked for
	 * having had no effect within a bounded window.
	 */
	function makeLiveSpiedCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_1", model: "gpt-5.4" } })}\n\n`,
		);
		const frame2 = encoder.encode(
			`event: response.output_item.added\ndata: ${JSON.stringify({ item: { type: "function_call", call_id: "call_1", name: "Bash" } })}\n\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				controller.enqueue(frame2);
				controller.close();
			},
		});
		let releaseLockCalls = 0;
		let cancelCalls = 0;
		const originalGetReader = stream.getReader.bind(stream);
		// biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of a built-in
		(stream as any).getReader = (...args: unknown[]) => {
			// biome-ignore lint/suspicious/noExplicitAny: forwarding getReader() args
			const reader = (originalGetReader as any)(...args);
			const originalReleaseLock = reader.releaseLock.bind(reader);
			const originalCancel = reader.cancel.bind(reader);
			reader.releaseLock = (...a: unknown[]) => {
				releaseLockCalls++;
				return originalReleaseLock(...a);
			};
			reader.cancel = (...a: unknown[]) => {
				cancelCalls++;
				return originalCancel(...a);
			};
			return reader;
		};
		const response = new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
		return {
			response,
			getReleaseLockCalls: () => releaseLockCalls,
			getCancelCalls: () => cancelCalls,
		};
	}

	/**
	 * The final, successful upstream: a real, self-closing Codex SSE stream
	 * that completes normally (response.created -> function_call item ->
	 * arguments -> done -> response.completed), so it can flow all the way
	 * through to forwardToClient without getting stuck on backpressure.
	 */
	function makeSuccessCodexUpstream() {
		const encoder = new TextEncoder();
		const events: Array<[string, unknown]> = [
			["response.created", { response: { id: "resp_2", model: "gpt-5.4" } }],
			[
				"response.output_item.added",
				{ item: { type: "message", id: "msg_1" } },
			],
			[
				"response.content_part.added",
				{ part: { type: "output_text" }, content_index: 0 },
			],
			["response.output_text.delta", { delta: "hi" }],
			["response.output_item.done", { item: { type: "message" } }],
			[
				"response.completed",
				{
					response: {
						id: "resp_2",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			],
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const [event, data] of events) {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it(
		"drains both discarded 529 streaming responses (no unresolved upstream " +
			"reader left open) and completes the retry loop with a third success",
		async () => {
			const overloadBody =
				'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
			const upstream1 = makeLiveSpiedCodexUpstream(529);
			const upstream2 = makeLiveSpiedCodexUpstream(529);
			let callCount = 0;
			globalThis.fetch = mock(async () => {
				callCount++;
				if (callCount === 1) return upstream1.response;
				if (callCount === 2) return upstream2.response;
				if (callCount === 3) return makeSuccessCodexUpstream();
				// Any further call is unexpected for this test's fixture.
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			});

			// CodexProvider.transformRequestBody records whether the ORIGINAL
			// client request asked to stream (body.stream === true) in a
			// requestId-keyed map, and processResponse consults that map to
			// decide whether to run the live SSE transform under test
			// (transformStreamingResponse) or a buffering non-streaming
			// fallback (transformSseResponseToJson). Without stream: true here,
			// every response.processResponse call in this test would silently
			// take the buffering path instead of the one this test exists to
			// exercise.
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 10,
					stream: true,
				}),
			).buffer;
			const req = makeRequest(bodyBuffer);
			// proxyWithAccount reaches forwardToClient on success, which requires
			// UsageCollector initialization (not wired in unit tests). Catch that
			// specific error while still verifying the retry drained both
			// discarded 529 responses before the final success was handed off.
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					makeAccount({
						provider: "codex",
						api_key: "test-key",
						access_token: null,
						refresh_token: "",
					}),
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}

			// Exactly 2 in-place retries fired before the third call succeeded.
			expect(callCount).toBe(3);

			// Neither discarded 529 response's upstream reader was left open:
			// the retry loop's own `await response.arrayBuffer()` drain (for
			// the first) and the reassignment to the second retry response
			// (drained the same way on the next loop iteration) must have
			// released both. A stuck reader here means the loop reassigned
			// `response` without consuming the prior value.
			expect(
				upstream1.getCancelCalls() > 0 || upstream1.getReleaseLockCalls() > 0,
			).toBe(true);
			expect(
				upstream2.getCancelCalls() > 0 || upstream2.getReleaseLockCalls() > 0,
			).toBe(true);
		},
	);
});

describe("proxyWithAccount: Codex 529 rate-limited failover does not hang on abandoned clone tee branches", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Retries disabled so the 529 falls straight through to
		// processProxyResponse -> rate_limited_failover instead of the
		// in-place retry loop, keeping the repro minimal and deterministic.
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * A live, spy-wrapped Codex SSE upstream whose body deliberately never
	 * closes (no controller.close() call), mirroring a real Codex connection
	 * that stays open until the server sends a terminal event or the socket
	 * drops. Nothing in this test ever naturally terminates the stream on its
	 * own: the only way `proxyWithAccount` can resolve at all is for the
	 * fix's cancel-on-abandon paths to actively cancel (or fully release) the
	 * upstream reader.
	 */
	function makeLiveNeverClosingCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_hang", model: "gpt-5.4" } })}\n\n`,
		);
		let releaseLockCalls = 0;
		let cancelCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				// Deliberately never close().
			},
		});
		const originalGetReader = stream.getReader.bind(stream);
		// biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of a built-in
		(stream as any).getReader = (...args: unknown[]) => {
			// biome-ignore lint/suspicious/noExplicitAny: forwarding getReader() args
			const reader = (originalGetReader as any)(...args);
			const originalReleaseLock = reader.releaseLock.bind(reader);
			const originalCancel = reader.cancel.bind(reader);
			reader.releaseLock = (...a: unknown[]) => {
				releaseLockCalls++;
				return originalReleaseLock(...a);
			};
			reader.cancel = (...a: unknown[]) => {
				cancelCalls++;
				return originalCancel(...a);
			};
			return reader;
		};
		const response = new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
		return {
			response,
			getReleaseLockCalls: () => releaseLockCalls,
			getCancelCalls: () => cancelCalls,
		};
	}

	it("resolves null within 2s instead of hanging on discardUnusedResponse, and " +
		"eventually cancels or releases the abandoned upstream reader", async () => {
		const upstream = makeLiveNeverClosingCodexUpstream(529);
		globalThis.fetch = mock(async () => upstream.response);

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
				stream: true,
			}),
		).buffer;
		const req = makeRequest(bodyBuffer);

		const account = makeAccount({
			provider: "codex",
			api_key: "test-key",
			access_token: null,
			refresh_token: "",
		});

		const resultPromise = proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		const TIMEOUT = Symbol("timeout");
		const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) =>
			setTimeout(() => resolve(TIMEOUT), 2000),
		);
		const outcome = await Promise.race([resultPromise, timeoutPromise]);

		// Before the fix: discardUnusedResponse awaits an unboundable
		// body.cancel() on a tee branch whose siblings (the parseRateLimit
		// and extractUsageInfo clones) were abandoned without ever being
		// read or cancelled, so this races the 2s timeout and loses.
		expect(outcome).not.toBe(TIMEOUT);
		expect(outcome).toBeNull();

		// Give the transform's background processEvents() task a tick to
		// observe the cancellation and run its own cleanup.
		await Bun.sleep(20);
		expect(
			upstream.getCancelCalls() > 0 || upstream.getReleaseLockCalls() > 0,
		).toBe(true);
	}, 3000);
});

describe("proxyWithAccount: Codex 529 in-place retry drain is bounded by a timeout (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_IN_PLACE_RETRY_DRAIN_TIMEOUT_MS = "50";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_IN_PLACE_RETRY_DRAIN_TIMEOUT_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	});

	/**
	 * A live Codex SSE upstream whose body deliberately never closes,
	 * mirroring a real connection that never emits a terminal frame. Before
	 * the fix, the retry loop's `await response.arrayBuffer()` drain of the
	 * superseded response has no bound and would hang forever on a body
	 * like this.
	 */
	function makeLiveNeverClosingCodexUpstream(status: number) {
		const encoder = new TextEncoder();
		const frame1 = encoder.encode(
			`event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_drain_hang", model: "gpt-5.4" } })}\n\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame1);
				// Deliberately never close().
			},
		});
		return new Response(stream, {
			status,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("proceeds to the in-place retry instead of hanging when the superseded 529 body never closes", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return makeLiveNeverClosingCodexUpstream(529);
		});

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
				stream: true,
			}),
		).buffer;
		const req = makeRequest(bodyBuffer);

		const resultPromise = proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "codex",
				api_key: "test-key",
				access_token: null,
				refresh_token: "",
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		).catch((e) => {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("UsageCollector not initialized")) return null;
			throw e;
		});

		const TIMEOUT = Symbol("timeout");
		const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) =>
			setTimeout(() => resolve(TIMEOUT), 2000),
		);
		const outcome = await Promise.race([resultPromise, timeoutPromise]);

		// Before the fix: `await response.arrayBuffer()` on the never-closing
		// first 529 body blocks forever, so the retry loop never reaches its
		// second fetch call and this races the 2s timeout and loses.
		expect(outcome).not.toBe(TIMEOUT);
		expect(callCount).toBe(2);
	}, 3000);
});

describe("proxyWithAccount — 401 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 401", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{ error: { type: "authentication_error", message: "Invalid API key" } },
				401,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("does not failover on successful 200 response", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: "qwen/qwen3.6-plus:free",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying no failover (null) occurred.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(200);
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the success path was taken and no failover (null) occurred.
			expect(threwUsageCollectorError).toBe(true);
		}
	});
});

describe("proxyWithAccount - attempt-bound Zai rate-limit parsing", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("captures Zai body-reset parsing in the plan before transport and ignores later source-provider mutation", async () => {
		type ZaiBodyParserProvider = Provider & {
			parseRateLimitFromBody: (
				response: Response,
			) => Promise<number | undefined>;
		};

		const sourceProvider = getProvider("zai") as
			| ZaiBodyParserProvider
			| undefined;
		expect(sourceProvider).toBeDefined();
		if (!sourceProvider) throw new Error("registered Zai provider is required");

		const originalOwnDescriptor = Object.getOwnPropertyDescriptor(
			sourceProvider,
			"parseRateLimitFromBody",
		);
		const originalProcessResponseDescriptor = Object.getOwnPropertyDescriptor(
			sourceProvider,
			"processResponse",
		);
		const originalBodyParser = sourceProvider.parseRateLimitFromBody;
		let plannedBodyParserCalls = 0;
		let mutatedBodyParserCalls = 0;
		Object.defineProperty(sourceProvider, "parseRateLimitFromBody", {
			configurable: true,
			writable: true,
			value: async (response: Response) => {
				plannedBodyParserCalls++;
				return originalBodyParser.call(sourceProvider, response);
			},
		});
		Object.defineProperty(sourceProvider, "processResponse", {
			configurable: true,
			writable: true,
			// Let the raw transport pass the model-fallback loop as a 200, then
			// expose the upstream 429 at the response-processing seam under test.
			value: async (response: Response) =>
				new Response(response.body, {
					status: 429,
					headers: response.headers,
				}),
		});

		const account = makeZaiAccount();
		try {
			globalThis.fetch = mock(async () => {
				// Planning has already completed when transport begins. A shared
				// provider mutation here must not change this physical attempt's hooks.
				sourceProvider.parseRateLimitFromBody = async () => {
					mutatedBodyParserCalls++;
					return undefined;
				};
				return jsonResponse(
					{
						type: "error",
						error: {
							type: "1308",
							message:
								"Usage limit reached for 5 hour. Your limit will reset at 2099-01-02 03:04:05",
						},
					},
					200,
				);
			});

			const bodyBuffer = makeRequestBody();
			const result = await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);

			expect(result).toBeNull();
			expect(plannedBodyParserCalls).toBe(1);
			expect(mutatedBodyParserCalls).toBe(0);
			expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		} finally {
			if (originalOwnDescriptor) {
				Object.defineProperty(
					sourceProvider,
					"parseRateLimitFromBody",
					originalOwnDescriptor,
				);
			} else {
				Reflect.deleteProperty(sourceProvider, "parseRateLimitFromBody");
			}
			if (originalProcessResponseDescriptor) {
				Object.defineProperty(
					sourceProvider,
					"processResponse",
					originalProcessResponseDescriptor,
				);
			} else {
				Reflect.deleteProperty(sourceProvider, "processResponse");
			}
		}
	});
});

describe("proxyWithAccount - native xAI capacity failover (R5-R10, AE3/AE4a)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("AE3: middle-candidate xAI 402 releases the body, persists cooldown with reason=xai_capacity_402, and fails over (returns null)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"insufficient credits"}', {
					status: 402,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeXaiAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			// modelOverride, apiKeyId, apiKeyName, requestBodyContext,
			// returnRateLimitedResponseOnExhaustion left at defaults: this is a
			// MIDDLE candidate (not the final one), matching AE3's "candidate two
			// serves the request" setup.
		);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("xai_capacity_402");
	});

	it("middle-candidate xAI 429 also fails over and persists the standard reason (never relabeled as xai_capacity_402)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"rate limited"}', {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeXaiAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("upstream_429_no_reset_probe_cooldown");
	});

	it("AE4a: final-candidate xAI 402 updates cooldown from a clone and forwards the original status/headers/body intact", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"insufficient credits","code":"xai_402"}', {
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-marker": "xai-402-original",
					},
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true, // returnRateLimitedResponseOnExhaustion: final candidate
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(402);
			expect(result.headers.get("x-upstream-marker")).toBe("xai-402-original");
			const body = (await result.json()) as { error: string; code: string };
			expect(body.error).toBe("insufficient credits");
			expect(body.code).toBe("xai_402");
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the final-candidate passthrough was taken, not the
			// middle-candidate discard/failover (which returns null without
			// reaching forwardToClient).
			expect(threwUsageCollectorError).toBe(true);
		}

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
		const [, , reason] = markMock.mock.calls[0];
		expect(reason).toBe("xai_capacity_402");
	});

	it("AE4a: final-candidate xAI 429 forwards the original status/headers/body intact", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"rate limited"}', {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "30",
					},
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(429);
			const body = (await result.json()) as { error: string };
			expect(body.error).toBe("rate limited");
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
	});

	it("does not fail over on a native xAI 400 (not classified as rate-limited)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response('{"error":"bad request"}', {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		// A 400 is not a rate limit signal for xAI: it must be forwarded as-is
		// (or reach forwardToClient), never treated as a failover trigger.
		if (result) {
			expect(result.status).toBe(400);
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).not.toHaveBeenCalled();
	});

	it("64 KiB cap: an oversized final-candidate xAI 402 body is still forwarded to the client byte-for-byte, unenriched", async () => {
		// One byte over the 64 KiB classification cap.
		const oversizedPayload = `{"error":"${"x".repeat(64 * 1024 + 1)}"}`;
		globalThis.fetch = mock(
			async () =>
				new Response(oversizedPayload, {
					status: 402,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();

		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeXaiAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(402);
			const text = await result.text();
			expect(text).toBe(oversizedPayload);
			expect(text.length).toBeGreaterThan(64 * 1024);
		} else {
			expect(threwUsageCollectorError).toBe(true);
		}
		// Classification still ran (status-only for xAI) and still persisted a
		// cooldown despite the oversized body exceeding the classification cap.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock<
				(id: string, until: number, reason: string) => Promise<number>
			>
		>;
		expect(markMock).toHaveBeenCalled();
	});
});

describe("boundResponseBodyForClassification (64 KiB final-candidate classification cap)", () => {
	it("returns a response whose body is preserved byte-for-byte when under the cap", async () => {
		const original = new Response('{"error":"small body"}', {
			status: 402,
			headers: { "content-type": "application/json", "x-test": "1" },
		});

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		expect(bounded.headers.get("x-test")).toBe("1");
		const text = await bounded.text();
		expect(text).toBe('{"error":"small body"}');
	});

	it("returns a headers-only (no body) response when the body exceeds the 64 KiB cap", async () => {
		const oversized = "x".repeat(64 * 1024 + 1);
		const original = new Response(oversized, {
			status: 402,
			headers: { "content-type": "application/json", "x-test": "2" },
		});

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		expect(bounded.headers.get("x-test")).toBe("2");
		const text = await bounded.text();
		expect(text).toBe("");
	});

	it("preserves a body exactly at the 64 KiB boundary", async () => {
		const exact = "y".repeat(64 * 1024);
		const original = new Response(exact, { status: 429 });

		const bounded = await boundResponseBodyForClassification(original);

		const text = await bounded.text();
		expect(text).toBe(exact);
	});

	it("passes through a response with no body unchanged", async () => {
		const original = new Response(null, { status: 402 });

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		const text = await bounded.text();
		expect(text).toBe("");
	});

	it("falls back to a headers-only response when the body stream rejects mid-read", async () => {
		const failingStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"partial":'));
			},
			pull() {
				throw new Error("simulated read failure");
			},
		});
		const original = new Response(failingStream, {
			status: 402,
			headers: { "content-type": "application/json", "x-test": "3" },
		});

		const bounded = await boundResponseBodyForClassification(original);

		expect(bounded.status).toBe(402);
		expect(bounded.headers.get("x-test")).toBe("3");
		const text = await bounded.text();
		expect(text).toBe("");
	});
});
