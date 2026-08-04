import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { ProviderServerToolCapabilityContext } from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	ComboWithSlots,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import type { UsageCollector } from "../usage-collector";

// Unit-test loading must not require the CLI build's ignored embedded worker
// artifacts. handleProxy does not use DatabaseFactory; keep that package at its
// boundary before dynamically loading the proxy module.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));
const providersModule = await import("@better-ccflare/providers");
const { usageCache } = providersModule;
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");
const { getRateLimitProbeAdmission, resetRateLimitProbeGatesForTests } =
	await import("../handlers/rate-limit-cooldown");

const FABLE = "claude-fable-5";
const FABLE_SIBLING = "claude-fable-5-20260701";
const OPUS = "claude-opus-4-8";
const OPUS_NEXT = "claude-opus-5";
const SONNET = "claude-sonnet-4-5";

const originalFetch = globalThis.fetch;
const originalOverloadRetry = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
const originalServerToolWebSearch = process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH;
const cachedUsageAccountIds = new Set<string>();
let restoreUsageCollector = (): void => {};
let usageHandleStart = mock(() => undefined);
let usageHandleEnd = mock(async () => undefined);

function makeAccount(id: string, fallbacks: string[] = [FABLE, OPUS]): Account {
	return {
		id,
		name: id,
		provider: "test-provider" as Account["provider"],
		api_key: "test-key",
		refresh_token: "",
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
		model_mappings: JSON.stringify({ fable: fallbacks }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeCombo(
	...routes: Array<{ account: Account; model?: string }>
): ComboWithSlots {
	return {
		id: "model-first-combo",
		name: "Priority Fable",
		description: null,
		enabled: true,
		created_at: 0,
		updated_at: 0,
		slots: routes.map(({ account, model }, index) => ({
			id: `slot-${index}`,
			combo_id: "model-first-combo",
			account_id: account.id,
			model: model ?? FABLE,
			priority: 0,
			enabled: true,
		})),
	};
}

function makeRoutingPolicy(
	combo: ComboWithSlots | null,
	family: ComboFamily,
): ComboRoutingPolicySnapshot {
	const { slots = [], ...comboRecord } = combo ?? {};
	return {
		assignment: {
			family,
			combo_id: combo?.id ?? null,
			enabled: combo !== null,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: combo ? (comboRecord as ComboRoutingPolicySnapshot["combo"]) : null,
		slots,
		rules: [],
		exclusions: [],
	};
}

function installUsageCollector(): void {
	usageHandleStart = mock(() => undefined);
	usageHandleEnd = mock(async () => undefined);
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
}

function makeContext(accounts: Account[], combo: ComboWithSlots): ProxyContext {
	return {
		strategy: { select: mock((selected: Account[]) => selected) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getComboRoutingPolicy: mock(async (family: ComboFamily) =>
				makeRoutingPolicy(combo, family),
			),
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
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: null,
			}),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) },
	} as unknown as ProxyContext;
}

function makeRequest(extraHeaders: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...extraHeaders },
		body: JSON.stringify({
			model: FABLE,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function makeServerToolRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: FABLE,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			stream: false,
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		}),
	});
}

function makeServerToolTuple(
	context: ProviderServerToolCapabilityContext,
): ServerToolCapabilityTuple {
	return {
		candidateId: context.candidateId,
		provider: context.account.provider,
		authMode: "api-key",
		endpointClass: "test-messages",
		normalizedEndpoint: "https://upstream.test/v1/messages",
		model: context.physicalModel,
		toolType: context.requirements.declarations?.[0]?.type ?? "unknown",
		profile: context.requirements.profileId ?? "unknown",
		inputReplay: context.requirements.replay.input,
		outputReplay: ["native-Anthropic"],
		providerContractRevision: "model-first-test-v1",
		replayDecoderRevision: "server-tool-replay-v1",
		requestTransport: "test-messages-json",
		responseTransport: "test-messages-json",
	};
}

function makeServerToolProof(
	tuple: ServerToolCapabilityTuple,
): ServerToolCapabilityProof {
	return Object.freeze({
		revision: `proof:${tuple.candidateId}:${tuple.model}`,
		tuple,
		decision: "proven",
		provenance: "model-first-routing-test-fixture",
		owner: "proxy-model-first-routing",
		verifiedAt: "2026-08-04T00:00:00.000Z",
		revalidateAfter: "2099-01-01T00:00:00.000Z",
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

function exactModelExhausted(): Response {
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

function generic429(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "An error occurred" },
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);
}

function modelNotFound(proof: string): Response {
	return new Response(
		'{"type":"error","error":{"type":"not_found_error","message":"model not found"}}',
		{
			status: 404,
			headers: {
				"content-type": "application/json",
				"x-upstream-proof": proof,
			},
		},
	);
}

function success(): Response {
	return new Response('{"type":"message","content":[]}', {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function codexEventStream(
	events: readonly { event: string; data: unknown }[],
): Response {
	const body = `${events
		.map(
			({ event, data }) =>
				`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
		)
		.join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function codexContextOverflow(model: string): Response {
	return codexEventStream([
		{
			event: "response.created",
			data: { response: { id: `resp-${model}`, model } },
		},
		{
			event: "response.failed",
			data: {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
						message: "Input is too large",
					},
				},
			},
		},
	]);
}

function codexStreamingSuccess(model: string): Response {
	return codexEventStream([
		{
			event: "response.created",
			data: { response: { id: `resp-${model}`, model } },
		},
		{
			event: "response.output_text.delta",
			data: { delta: "larger model recovered" },
		},
		{
			event: "response.completed",
			data: {
				response: {
					id: `resp-${model}`,
					model,
					usage: { input_tokens: 10, output_tokens: 3 },
				},
			},
		},
	]);
}

function cacheFreshFableExhaustion(accountId: string): void {
	const now = Date.now();
	const realDateNow = Date.now;
	Date.now = () => now - 120_000;
	try {
		usageCache.set(accountId, {
			limits: [
				{
					kind: "session",
					percent: 0,
					resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_all",
					percent: 72,
					resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
					scope: { model: { id: null, display_name: "Fable" } },
					is_active: true,
				},
			],
		});
		cachedUsageAccountIds.add(accountId);
	} finally {
		Date.now = realDateNow;
	}
}

function cacheCurrentFamilyExhaustion(
	accountId: string,
	...displayNames: string[]
): void {
	usageCache.set(accountId, {
		spend: { enabled: false },
		limits: displayNames.map((displayName) => ({
			kind: "weekly_scoped",
			percent: 100,
			resets_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
			scope: { model: { id: null, display_name: displayName } },
			is_active: true,
		})),
	});
	cachedUsageAccountIds.add(accountId);
}

function cacheCurrentFableExhaustion(accountId: string): void {
	cacheCurrentFamilyExhaustion(accountId, "Fable");
}

type Attempt = { account: string; model: string };

function installFetch(
	respond: (attempt: Attempt, ordinal: number) => Response,
): Attempt[] {
	const attempts: Attempt[] = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		const attempt = {
			account: new URL(request.url).pathname.slice(1),
			model: ((await request.clone().json()) as { model: string }).model,
		};
		attempts.push(attempt);
		return respond(attempt, attempts.length - 1);
	}) as unknown as typeof fetch;
	return attempts;
}

async function run(
	ctx: ProxyContext,
	request: Request = makeRequest(),
): Promise<Response> {
	return handleProxy(request, new URL(request.url), ctx);
}

beforeEach(() => {
	resetRateLimitProbeGatesForTests();
	installUsageCollector();
	process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
	process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH = "1";
});

afterEach(() => {
	resetRateLimitProbeGatesForTests();
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
	for (const accountId of cachedUsageAccountIds) usageCache.delete(accountId);
	cachedUsageAccountIds.clear();
	if (originalOverloadRetry === undefined) {
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
	} else {
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = originalOverloadRetry;
	}
	if (originalServerToolWebSearch === undefined) {
		delete process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH;
	} else {
		process.env.CCFLARE_SERVER_TOOL_WEB_SEARCH = originalServerToolWebSearch;
	}
});

describe("global model-first routing", () => {
	it("preserves baseline routing when the degraded-mode runtime is absent", async () => {
		const account = makeAccount("legacy-context");
		const ctx = makeContext([account], makeCombo({ account }));
		const attempts = installFetch(() => success());

		expect(
			(ctx as Partial<ProxyContext>).anthropicDegradedMode,
		).toBeUndefined();

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: account.id, model: FABLE }]);
	});

	it("tries B/Fable after A/Fable scoped failure without attempting A/Opus", async () => {
		const accountA = makeAccount("account-a");
		const accountB = makeAccount("account-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountA.id && attempt.model === FABLE
				? exactModelExhausted()
				: success(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
		]);
	});

	it("runs queued cross-family fallbacks only after all Fable routes in stable order", async () => {
		const accountA = makeAccount("stable-a");
		const accountB = makeAccount("stable-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountB.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountA.id, model: OPUS },
			{ account: accountB.id, model: OPUS },
		]);
		expect(
			(usageHandleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(3);
	});

	it("tries a post-combo normal Fable route before queued degradation", async () => {
		const comboAccount = makeAccount("combo-only-a");
		const normalAccount = makeAccount("normal-only-b");
		const ctx = makeContext(
			[comboAccount, normalAccount],
			makeCombo({ account: comboAccount }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === normalAccount.id && attempt.model === FABLE
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: comboAccount.id, model: FABLE },
			{ account: normalAccount.id, model: FABLE },
		]);
	});

	it("applies model-first ordering without an active combo", async () => {
		const accountA = makeAccount("normal-a");
		const accountB = makeAccount("normal-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountB.id && attempt.model === FABLE
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
		]);
	});

	it("never escapes a force-routed account while draining its model queue", async () => {
		const forced = makeAccount("forced-a");
		const unrelated = makeAccount("must-not-run-b");
		const ctx = makeContext(
			[forced, unrelated],
			makeCombo({ account: forced }, { account: unrelated }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === forced.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(
			ctx,
			makeRequest({ "x-better-ccflare-account-id": forced.id }),
		);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: forced.id, model: FABLE },
			{ account: forced.id, model: OPUS },
		]);
	});

	it("executes multiple degradation families as global fallback-rank waves", async () => {
		const accountA = makeAccount("waves-a", [FABLE, OPUS, SONNET]);
		const accountB = makeAccount("waves-b", [FABLE, OPUS, SONNET]);
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountB.id && attempt.model === SONNET
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountA.id, model: OPUS },
			{ account: accountB.id, model: OPUS },
			{ account: accountA.id, model: SONNET },
			{ account: accountB.id, model: SONNET },
		]);
	});

	it("keeps fallback waves aligned when accounts have asymmetric same-family siblings", async () => {
		const accountA = makeAccount("asymmetric-a", [FABLE, OPUS, SONNET]);
		const accountB = makeAccount("asymmetric-b", [
			FABLE,
			FABLE_SIBLING,
			OPUS,
			SONNET,
		]);
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountB.id && attempt.model === SONNET
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountB.id, model: FABLE_SIBLING },
			{ account: accountA.id, model: OPUS },
			{ account: accountB.id, model: OPUS },
			{ account: accountA.id, model: SONNET },
			{ account: accountB.id, model: SONNET },
		]);
	});

	it("continues after a non-final deferred model-not-found response", async () => {
		const accountA = makeAccount("not-found-a");
		const accountB = makeAccount("not-found-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) => {
			if (attempt.model === FABLE) return exactModelExhausted();
			if (attempt.account === accountA.id) {
				return new Response(
					'{"type":"error","error":{"type":"not_found_error","message":"model not found"}}',
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return success();
		});

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountA.id, model: OPUS },
			{ account: accountB.id, model: OPUS },
		]);
	});

	it("continues from requested-model 404 on A to requested-model success on B", async () => {
		const accountA = makeAccount("requested-not-found-a");
		const accountB = makeAccount("requested-not-found-b");
		accountA.model_mappings = null;
		accountB.model_mappings = null;
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountA.id ? modelNotFound("a") : success(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-upstream-proof")).toBeNull();
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
		]);
	});

	it("retains only the final requested-model 404 after every route is exhausted", async () => {
		const accountA = makeAccount("requested-terminal-a");
		const accountB = makeAccount("requested-terminal-b");
		accountA.model_mappings = null;
		accountB.model_mappings = null;
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) => modelNotFound(attempt.account));

		const response = await run(ctx);

		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
		]);
		expect(response.status).toBe(404);
		expect(response.headers.get("x-upstream-proof")).toBe(accountB.id);
		expect(await response.json()).toEqual({
			type: "error",
			error: { type: "not_found_error", message: "model not found" },
		});
	});

	it("defers low-confidence capacity to the first requested-family Codex route", async () => {
		const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		try {
			const accountA = makeAccount("admission-a", [
				"gpt-5.3-codex-spark",
				"gpt-5.6-sol",
			]);
			const accountB = makeAccount("admission-b", ["gpt-5.6-sol"]);
			for (const [account, token] of [
				[accountA, "token-a"],
				[accountB, "token-b"],
			] as const) {
				account.provider = "codex";
				account.api_key = null;
				account.access_token = token;
				account.expires_at = Date.now() + 60 * 60 * 1000;
			}
			const ctx = makeContext(
				[accountA, accountB],
				makeCombo({ account: accountA }, { account: accountB }),
			);
			const fetched: Array<{ authorization: string | null; model: string }> =
				[];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request = input instanceof Request ? input : new Request(input);
				fetched.push({
					authorization: request.headers.get("authorization"),
					model: ((await request.clone().json()) as { model: string }).model,
				});
				return new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: FABLE,
					messages: [{ role: "user", content: "x".repeat(440_000) }],
					max_tokens: 50_000,
				}),
			});

			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(200);
			expect(fetched).toEqual([
				{
					authorization: "Bearer token-a",
					model: "gpt-5.3-codex-spark",
				},
			]);
		} finally {
			if (previousAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
			}
		}
	});

	it("routes a pre-content Codex context overflow to a known larger deferred model", async () => {
		const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		try {
			const account = makeAccount("admission-context-fallback", [
				"gpt-5.3-codex-spark",
				"gpt-5.6-sol",
			]);
			account.provider = "codex";
			account.api_key = null;
			account.access_token = "token-context-fallback";
			account.expires_at = Date.now() + 60 * 60 * 1000;
			const ctx = makeContext([account], makeCombo({ account }));
			const reportCandidateFailure = mock(() => undefined);
			ctx.strategy.reportCandidateFailure = reportCandidateFailure;
			const fetchedModels: string[] = [];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request = input instanceof Request ? input : new Request(input);
				const model = ((await request.clone().json()) as { model: string })
					.model;
				fetchedModels.push(model);
				return model === "gpt-5.3-codex-spark"
					? codexContextOverflow(model)
					: codexStreamingSuccess(model);
			}) as unknown as typeof fetch;
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: FABLE,
					messages: [{ role: "user", content: "x".repeat(440_000) }],
					max_tokens: 50_000,
					stream: true,
				}),
			});

			const response = await handleProxy(request, new URL(request.url), ctx);
			const body = await response.text();

			expect(fetchedModels).toEqual(["gpt-5.3-codex-spark", "gpt-5.6-sol"]);
			expect(response.status).toBe(200);
			expect(body).toContain("larger model recovered");
			expect(reportCandidateFailure).toHaveBeenCalledTimes(0);
			expect(account.rate_limited_until).toBeNull();
			expect(account.consecutive_rate_limits).toBe(0);
		} finally {
			if (previousAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
			}
		}
	});

	it("preserves a Codex context overflow when no larger model is configured", async () => {
		const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		try {
			const account = makeAccount("admission-context-terminal", [
				"gpt-5.3-codex-spark",
			]);
			account.provider = "codex";
			account.api_key = null;
			account.access_token = "token-context-terminal";
			account.expires_at = Date.now() + 60 * 60 * 1000;
			const ctx = makeContext([account], makeCombo({ account }));
			const reportCandidateFailure = mock(() => undefined);
			ctx.strategy.reportCandidateFailure = reportCandidateFailure;
			const fetchedModels: string[] = [];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request = input instanceof Request ? input : new Request(input);
				const model = ((await request.clone().json()) as { model: string })
					.model;
				fetchedModels.push(model);
				return codexContextOverflow(model);
			}) as unknown as typeof fetch;
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: FABLE,
					messages: [{ role: "user", content: "x".repeat(440_000) }],
					max_tokens: 50_000,
					stream: true,
				}),
			});

			const response = await handleProxy(request, new URL(request.url), ctx);
			const body = await response.text();

			expect(fetchedModels).toEqual(["gpt-5.3-codex-spark"]);
			expect(response.status).toBe(400);
			expect(body).toContain("context_length_exceeded");
			expect(reportCandidateFailure).toHaveBeenCalledTimes(0);
			expect(account.rate_limited_until).toBeNull();
			expect(account.consecutive_rate_limits).toBe(0);
		} finally {
			if (previousAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
			}
		}
	});

	for (const requestedModel of [FABLE, OPUS]) {
		it(`forwards a large ${requestedModel} combo request to the ChatGPT subscription endpoint`, async () => {
			const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
			process.env.CCFLARE_CONTEXT_ADMISSION = "1";
			try {
				const account = makeAccount(`subscription-${requestedModel}`);
				account.provider = "codex";
				account.api_key = null;
				account.access_token = `token-${requestedModel}`;
				account.expires_at = Date.now() + 60 * 60 * 1000;
				account.model_mappings = JSON.stringify({
					fable: "gpt-5.6-sol",
					opus: "gpt-5.6-sol",
				});
				const ctx = makeContext(
					[account],
					makeCombo({ account, model: requestedModel }),
				);
				const fetchedBodies: Array<Record<string, unknown>> = [];
				globalThis.fetch = mock(async (input: RequestInfo | URL) => {
					const request = input instanceof Request ? input : new Request(input);
					fetchedBodies.push(
						(await request.clone().json()) as Record<string, unknown>,
					);
					return new Response('{"ok":true}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}) as unknown as typeof fetch;
				const request = new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: requestedModel,
						messages: [{ role: "user", content: "x".repeat(660_000) }],
						max_tokens: 50_000,
					}),
				});

				const response = await handleProxy(request, new URL(request.url), ctx);

				expect(response.status).toBe(200);
				expect(fetchedBodies).toHaveLength(1);
				expect(fetchedBodies[0]?.model).toBe("gpt-5.6-sol");
				expect(fetchedBodies[0]).not.toHaveProperty("max_output_tokens");
			} finally {
				if (previousAdmission === undefined) {
					delete process.env.CCFLARE_CONTEXT_ADMISSION;
				} else {
					process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
				}
			}
		});

		it(`fails open and keeps the output reserve for a large ${requestedModel} custom-endpoint combo request`, async () => {
			const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
			process.env.CCFLARE_CONTEXT_ADMISSION = "1";
			try {
				const account = makeAccount(`custom-${requestedModel}`);
				account.provider = "codex";
				account.api_key = null;
				account.access_token = `token-${requestedModel}`;
				account.expires_at = Date.now() + 60 * 60 * 1000;
				account.custom_endpoint = "https://api.openai.com/v1/responses";
				account.model_mappings = JSON.stringify({
					fable: "gpt-5.6-sol",
					opus: "gpt-5.6-sol",
				});
				const ctx = makeContext(
					[account],
					makeCombo({ account, model: requestedModel }),
				);
				const fetchedBodies: Array<Record<string, unknown>> = [];
				const fetchMock = mock(async (input: RequestInfo | URL) => {
					const request = input instanceof Request ? input : new Request(input);
					fetchedBodies.push(
						(await request.clone().json()) as Record<string, unknown>,
					);
					return new Response('{"ok":true}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				});
				globalThis.fetch = fetchMock as unknown as typeof fetch;
				const request = new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: requestedModel,
						messages: [{ role: "user", content: "x".repeat(660_000) }],
						max_tokens: 50_000,
					}),
				});

				const response = await handleProxy(request, new URL(request.url), ctx);

				expect(response.status).toBe(200);
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(fetchedBodies).toHaveLength(1);
				expect(fetchedBodies[0]?.model).toBe("gpt-5.6-sol");
				expect(fetchedBodies[0]?.max_output_tokens).toBe(50_000);
			} finally {
				if (previousAdmission === undefined) {
					delete process.env.CCFLARE_CONTEXT_ADMISSION;
				} else {
					process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
				}
			}
		});
	}

	for (const [provider, contextAdmissionEnabled] of [
		["anthropic", false],
		["anthropic", true],
		["codex", false],
		["codex", true],
	] as const) {
		it(`discovers deferred work for provider=${provider} with context admission=${contextAdmissionEnabled ? "on" : "off"}`, async () => {
			const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
			if (contextAdmissionEnabled) {
				process.env.CCFLARE_CONTEXT_ADMISSION = "1";
			} else {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			}
			try {
				const account = makeAccount(
					`discovery-${provider}-${contextAdmissionEnabled ? "on" : "off"}`,
				);
				account.provider = provider;
				let expectedModels: string[];
				if (provider === "codex") {
					account.api_key = null;
					account.access_token = `token-${account.id}`;
					account.expires_at = Date.now() + 60 * 60 * 1000;
					expectedModels = ["gpt-5.3-codex", "gpt-5.4-mini"];
					account.model_mappings = JSON.stringify({
						fable: expectedModels,
					});
				} else {
					expectedModels = [FABLE, OPUS];
				}
				const ctx = makeContext([account], makeCombo({ account }));
				const attemptedModels: string[] = [];
				globalThis.fetch = mock(async (input: RequestInfo | URL) => {
					const request = input instanceof Request ? input : new Request(input);
					attemptedModels.push(
						((await request.clone().json()) as { model: string }).model,
					);
					return attemptedModels.length === 1
						? modelNotFound("discovery")
						: success();
				}) as unknown as typeof fetch;

				const response = await run(ctx);

				expect(attemptedModels).toEqual(expectedModels);
				expect(response.status).toBe(200);
			} finally {
				if (previousAdmission === undefined) {
					delete process.env.CCFLARE_CONTEXT_ADMISSION;
				} else {
					process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
				}
			}
		});
	}

	it("uses the account's configured native Opus fallback when its normal Fable lane is already exhausted", async () => {
		const account = makeAccount("preselected-capacity-fallback");
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(account.id);
		const attempts = installFetch((attempt) =>
			attempt.model === OPUS ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: account.id, model: OPUS }]);
		expect(usageHandleStart).toHaveBeenCalledTimes(1);
		expect(usageHandleStart.mock.calls[0]?.[0]).toMatchObject({
			originalModel: FABLE,
			appliedModel: OPUS,
			comboModelOverrideFrom: null,
			comboModelOverrideTo: null,
		});
	});

	it("runs a blocked earlier account's Opus only after a healthy Fable route fails", async () => {
		const blocked = makeAccount("blocked-primary");
		const healthy = makeAccount("healthy-lower-priority");
		blocked.priority = 0;
		healthy.priority = 1;
		const ctx = makeContext(
			[blocked, healthy],
			makeCombo({ account: blocked }, { account: healthy }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(blocked.id);
		const attempts = installFetch((attempt) =>
			attempt.account === blocked.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: healthy.id, model: FABLE },
			{ account: blocked.id, model: OPUS },
		]);
	});

	it("runs only the exact proven Opus tail when a server-tool Fable route is capacity-blocked", async () => {
		const blocked = makeAccount("server-tool-capacity-tail");
		const ctx = makeContext([blocked], makeCombo({ account: blocked }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.provider.name = blocked.provider;
		ctx.provider.getLogicalModelCapability = () => ({
			status: "supported",
			provenance: "native_passthrough",
			reason: "included",
		});
		const observedTuples: ServerToolCapabilityTuple[] = [];
		const observedProofs: ServerToolCapabilityProof[] = [];
		ctx.provider.createServerToolCapabilityTuple = (context) => {
			const tuple = makeServerToolTuple(context);
			observedTuples.push(tuple);
			return tuple;
		};
		ctx.provider.resolveServerToolCapability = (_requirements, tuple) => {
			const proof = makeServerToolProof(tuple);
			observedProofs.push(proof);
			return { decision: "proven", proof };
		};
		cacheCurrentFableExhaustion(blocked.id);
		const attempts = installFetch(() => success());

		const response = await run(ctx, makeServerToolRequest());

		const deferredCandidateId = `capacity-deferred:${encodeURIComponent(
			blocked.id,
		)}:${encodeURIComponent(OPUS)}`;
		const deferredTuples = observedTuples.filter(
			(tuple) => tuple.model === OPUS,
		);
		const deferredProofs = observedProofs.filter(
			(proof) => proof.tuple.model === OPUS,
		);
		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: blocked.id, model: OPUS }]);
		expect(deferredTuples.length).toBeGreaterThan(0);
		expect(new Set(deferredTuples.map((tuple) => tuple.candidateId))).toEqual(
			new Set([deferredCandidateId]),
		);
		expect(deferredProofs.length).toBeGreaterThan(0);
		expect(new Set(deferredProofs.map((proof) => proof.revision))).toEqual(
			new Set([`proof:${deferredCandidateId}:${OPUS}`]),
		);
	});

	it("returns a capability terminal when the only deferred server-tool proof drifts before transport", async () => {
		const blocked = makeAccount("server-tool-drifted-capacity-tail");
		const ctx = makeContext([blocked], makeCombo({ account: blocked }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.provider.name = blocked.provider;
		ctx.provider.getLogicalModelCapability = () => ({
			status: "supported",
			provenance: "native_passthrough",
			reason: "included",
		});
		const resolutionCounts = new Map<string, number>();
		ctx.provider.createServerToolCapabilityTuple = makeServerToolTuple;
		ctx.provider.resolveServerToolCapability = (_requirements, tuple) => {
			const count = (resolutionCounts.get(tuple.candidateId) ?? 0) + 1;
			resolutionCounts.set(tuple.candidateId, count);
			if (tuple.model === OPUS && count > 1) {
				return { decision: "unknown", reason: "no_exact_proof" };
			}
			return { decision: "proven", proof: makeServerToolProof(tuple) };
		};
		cacheCurrentFableExhaustion(blocked.id);
		const attempts = installFetch(() => success());

		const response = await run(ctx, makeServerToolRequest());
		const body = (await response.json()) as {
			error: {
				code: string;
				reason: string;
				capability: Record<string, number>;
			};
		};
		const deferredCandidateId = `capacity-deferred:${encodeURIComponent(
			blocked.id,
		)}:${encodeURIComponent(OPUS)}`;

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "server_tool_capability_unavailable",
			reason: "no_implementation",
			capability: {
				provenCandidateCount: 1,
				unknownCandidateCount: 1,
				eligibleCandidateCount: 0,
			},
		});
		expect(attempts).toEqual([]);
		expect(resolutionCounts.get(deferredCandidateId)).toBe(2);
	});

	it("orders deferred families by their minimum configured fallback rank", async () => {
		const earlier = makeAccount("ranked-family-a", [FABLE, OPUS, SONNET]);
		const later = makeAccount("ranked-family-b", [FABLE, OPUS]);
		const ctx = makeContext(
			[earlier, later],
			makeCombo({ account: earlier }, { account: later }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFamilyExhaustion(earlier.id, "Fable", "Opus");
		cacheCurrentFableExhaustion(later.id);
		const attempts = installFetch((attempt) =>
			attempt.account === later.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: later.id, model: OPUS }]);
	});

	it("globally promotes a later account's requested-family sibling over cross-family routes", async () => {
		const earlier = makeAccount("ranked-sibling-a", [FABLE, OPUS]);
		const later = makeAccount("ranked-sibling-b", [FABLE, OPUS, FABLE_SIBLING]);
		const ctx = makeContext(
			[earlier, later],
			makeCombo({ account: earlier }, { account: later }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		for (const account of [earlier, later]) {
			usageCache.markModelScopedExhausted(
				account.id,
				FABLE,
				"",
				Date.now() + 60_000,
			);
			cachedUsageAccountIds.add(account.id);
		}
		const attempts = installFetch((attempt) =>
			attempt.account === later.id && attempt.model === FABLE_SIBLING
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: later.id, model: FABLE_SIBLING }]);
	});

	it("retries an all-suppressed deferred pool once without the probe gate", async () => {
		const account = makeAccount("suppressed-deferred");
		account.rate_limited_until = Date.now() - 1;
		account.rate_limited_reason = "upstream_529_overloaded_no_reset";
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(account.id);
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		const attempts = installFetch(() => success());

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: account.id, model: OPUS }]);
	});

	it("returns context overflow when the rescued deferred route is rejected before transport", async () => {
		const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		const previousWindow =
			process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW = "64";
		const estimateSpy = spyOn(
			providersModule,
			"estimateAnthropicAdmissionTokens",
		).mockReturnValue({
			tokens: 100,
			method: "test-authoritative",
			confidence: "authoritative",
		});
		try {
			const account = makeAccount("suppressed-admission-deferred");
			account.provider = "codex";
			account.api_key = null;
			account.access_token = "token-suppressed-admission-deferred";
			account.expires_at = Date.now() + 60 * 60 * 1000;
			account.model_mappings = JSON.stringify({
				fable: [FABLE, "gpt-5.3-codex-spark"],
			});
			account.rate_limited_until = Date.now() - 1;
			account.rate_limited_reason = "upstream_529_overloaded_no_reset";
			const ctx = makeContext([account], makeCombo({ account }));
			ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
				makeRoutingPolicy(null, family),
			);
			cacheCurrentFableExhaustion(account.id);
			expect(getRateLimitProbeAdmission(account)).toBe("admitted");
			const attempts = installFetch(() => success());

			const response = await run(ctx);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: "error",
				error: { code: "context_length_exceeded" },
			});
			expect(attempts).toEqual([]);
		} finally {
			estimateSpy.mockRestore();
			if (previousAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
			}
			if (previousWindow === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW =
					previousWindow;
			}
		}
	});

	it("rescues a later probe-suppressed deferred route after a pre-transport admission rejection", async () => {
		const previousAdmission = process.env.CCFLARE_CONTEXT_ADMISSION;
		const previousWindow =
			process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW;
		process.env.CCFLARE_CONTEXT_ADMISSION = "1";
		process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW = "64";
		const estimateSpy = spyOn(
			providersModule,
			"estimateAnthropicAdmissionTokens",
		).mockReturnValue({
			tokens: 100,
			method: "test-authoritative",
			confidence: "authoritative",
		});
		try {
			const rejected = makeAccount("admission-rejected-deferred", [
				FABLE,
				"gpt-5.3-codex-spark",
			]);
			rejected.provider = "codex";
			rejected.api_key = null;
			rejected.access_token = "token-admission-rejected-deferred";
			rejected.expires_at = Date.now() + 60 * 60 * 1000;
			const suppressed = makeAccount("probe-suppressed-deferred");
			suppressed.priority = 1;
			suppressed.rate_limited_until = Date.now() - 1;
			suppressed.rate_limited_reason = "upstream_529_overloaded_no_reset";
			const ctx = makeContext(
				[rejected, suppressed],
				makeCombo({ account: rejected }, { account: suppressed }),
			);
			ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
				makeRoutingPolicy(null, family),
			);
			cacheCurrentFableExhaustion(rejected.id);
			cacheCurrentFableExhaustion(suppressed.id);
			expect(getRateLimitProbeAdmission(suppressed)).toBe("admitted");
			const attempts = installFetch(() => success());

			const response = await run(ctx);

			expect(response.status).toBe(200);
			expect(attempts).toEqual([{ account: suppressed.id, model: OPUS }]);
		} finally {
			estimateSpy.mockRestore();
			if (previousAdmission === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION = previousAdmission;
			}
			if (previousWindow === undefined) {
				delete process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW;
			} else {
				process.env.CCFLARE_CONTEXT_ADMISSION_TEST_EFFECTIVE_WINDOW =
					previousWindow;
			}
		}
	});

	it("continues from an ungated requested-route overload to a deferred route", async () => {
		const requested = makeAccount("suppressed-requested");
		requested.model_mappings = null;
		requested.rate_limited_until = Date.now() - 1;
		requested.rate_limited_reason = "upstream_529_overloaded_no_reset";
		const deferred = makeAccount("deferred-after-requested");
		deferred.priority = 1;
		const ctx = makeContext(
			[requested, deferred],
			makeCombo({ account: requested }, { account: deferred }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(deferred.id);
		expect(getRateLimitProbeAdmission(requested)).toBe("admitted");
		const attempts = installFetch((attempt) =>
			attempt.account === deferred.id && attempt.model === OPUS
				? success()
				: new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
						status: 529,
						headers: { "content-type": "application/json" },
					}),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: requested.id, model: FABLE },
			{ account: deferred.id, model: OPUS },
		]);
	});

	it("preserves side-effect-free strategy order for routes deferred before selection", async () => {
		const repositoryFirst = makeAccount("deferred-repository-first");
		repositoryFirst.priority = 0;
		const strategyFirst = makeAccount("deferred-strategy-first");
		strategyFirst.priority = 10;
		const ctx = makeContext(
			[repositoryFirst, strategyFirst],
			makeCombo({ account: repositoryFirst }, { account: strategyFirst }),
		);
		ctx.strategy.select = mock(async (selected: Account[]) =>
			[strategyFirst, repositoryFirst].filter((account) =>
				selected.some((candidate) => candidate.id === account.id),
			),
		);
		ctx.strategy.peek = mock((selected: Account[]) =>
			selected.some((candidate) => candidate.id === strategyFirst.id)
				? strategyFirst.id
				: (selected[0]?.id ?? null),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(repositoryFirst.id);
		cacheCurrentFableExhaustion(strategyFirst.id);
		const attempts = installFetch((attempt) =>
			attempt.account === strategyFirst.id ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: strategyFirst.id, model: OPUS }]);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
		expect(ctx.strategy.select).toHaveBeenCalledWith([], expect.anything());
	});

	it("preserves strategy order across mixed preplanned and dynamic normal routes", async () => {
		const preplanned = makeAccount("mixed-preplanned-a");
		preplanned.priority = 1;
		const dynamic = makeAccount("mixed-dynamic-b");
		dynamic.priority = 0;
		const ctx = makeContext(
			[preplanned, dynamic],
			makeCombo({ account: preplanned }, { account: dynamic }),
		);
		ctx.strategy.select = mock(async (selected: Account[]) =>
			[dynamic, preplanned].filter((account) =>
				selected.some((candidate) => candidate.id === account.id),
			),
		);
		ctx.strategy.peek = mock((selected: Account[]) =>
			selected.some((candidate) => candidate.id === dynamic.id)
				? dynamic.id
				: (selected[0]?.id ?? null),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(preplanned.id);
		const attempts = installFetch((attempt) =>
			attempt.account === dynamic.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: dynamic.id, model: FABLE },
			{ account: dynamic.id, model: OPUS },
		]);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
	});

	it.each([
		["null", null],
		["invalid", "missing-account"],
	] as const)("keeps stable deferred order when strategy.peek returns %s", async (label, peekedAccountId) => {
		const first = makeAccount(`peek-${label}-a`);
		const second = makeAccount(`peek-${label}-b`);
		const ctx = makeContext(
			[first, second],
			makeCombo({ account: first }, { account: second }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.strategy.peek = mock(() => peekedAccountId);
		cacheCurrentFableExhaustion(first.id);
		cacheCurrentFableExhaustion(second.id);
		const attempts = installFetch((attempt) =>
			attempt.account === second.id ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: first.id, model: OPUS },
			{ account: second.id, model: OPUS },
		]);
	});

	it("keeps repeated occurrences of one family in configured fallback epochs", async () => {
		const account = makeAccount("repeated-family", [
			FABLE,
			OPUS,
			SONNET,
			OPUS_NEXT,
		]);
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(account.id);
		const attempts = installFetch((attempt) =>
			attempt.model === OPUS_NEXT ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: account.id, model: OPUS },
			{ account: account.id, model: SONNET },
			{ account: account.id, model: OPUS_NEXT },
		]);
	});

	it("counts a blocked mapped model in its configured family epoch", async () => {
		const repeated = makeAccount("blocked-family-occurrence-a", [
			FABLE,
			OPUS,
			SONNET,
			OPUS_NEXT,
		]);
		const peer = makeAccount("blocked-family-occurrence-b", [FABLE, OPUS]);
		const ctx = makeContext(
			[repeated, peer],
			makeCombo({ account: repeated }, { account: peer }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(repeated.id);
		cacheCurrentFableExhaustion(peer.id);
		usageCache.markModelScopedExhausted(
			repeated.id,
			OPUS,
			"",
			Date.now() + 60_000,
		);
		const attempts = installFetch((attempt) =>
			attempt.account === repeated.id && attempt.model === OPUS_NEXT
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: peer.id, model: OPUS },
			{ account: repeated.id, model: SONNET },
			{ account: repeated.id, model: OPUS_NEXT },
		]);
	});

	it("includes a capacity-deferred OAuth account in aged-token diagnosis", async () => {
		const account = makeAccount("aged-deferred-oauth");
		account.provider = "anthropic";
		account.api_key = null;
		account.refresh_token = "aged-refresh-token";
		account.access_token = "expired-access-token";
		account.expires_at = Date.now() + 60_000;
		account.refresh_token_issued_at = Date.now() - 100 * 24 * 60 * 60 * 1000;
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(account.id);
		const attempts = installFetch(
			() =>
				new Response(
					'{"type":"error","error":{"type":"authentication_error"}}',
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		);

		await expect(run(ctx)).rejects.toThrow(
			"OAuth tokens have expired for accounts: aged-deferred-oauth",
		);
		expect(attempts).toEqual([]);
	});

	it("returns deferred predictive throttle after a prior requested-route attempt", async () => {
		const account = makeAccount("predictive-after-attempt");
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.config.getUsageThrottlingWeeklyEnabled = () => true;
		usageCache.set(account.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 90,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Opus" } },
					is_active: true,
				},
			],
		});
		cachedUsageAccountIds.add(account.id);
		const attempts = installFetch(
			() =>
				new Response(
					'{"type":"error","error":{"type":"authentication_error"}}',
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const response = await run(ctx);

		expect(response.status).toBe(529);
		expect(attempts).toEqual([{ account: account.id, model: FABLE }]);
	});

	it("prefers a hard deferred reactive terminal over a soft predictive throttle", async () => {
		const predictive = makeAccount("mixed-terminal-predictive");
		const reactive = makeAccount("mixed-terminal-reactive");
		const ctx = makeContext(
			[predictive, reactive],
			makeCombo({ account: predictive }, { account: reactive }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.config.getUsageThrottlingWeeklyEnabled = () => true;
		usageCache.set(predictive.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Fable" } },
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent: 90,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Opus" } },
					is_active: true,
				},
			],
		});
		cachedUsageAccountIds.add(predictive.id);
		cacheCurrentFableExhaustion(reactive.id);
		let installedReactiveEvidence = false;
		ctx.strategy.peek = mock((selected: Account[]) => {
			if (!installedReactiveEvidence) {
				installedReactiveEvidence = true;
				usageCache.markModelScopedExhausted(
					reactive.id,
					OPUS,
					"",
					Date.now() + 60_000,
				);
			}
			return selected[0]?.id ?? null;
		});
		const attempts = installFetch(() => success());

		const response = await run(ctx);
		const body = (await response.json()) as {
			error?: { code?: string };
		};

		expect(response.status).toBe(503);
		expect(body.error?.code).toBe("model_pool_exhausted");
		expect(attempts).toEqual([]);
	});

	it("prefers post-combo deferred depletion over a soft normal-fallback throttle", async () => {
		const comboAccount = makeAccount("post-combo-reactive-deferred");
		const predictiveFallback = makeAccount("post-combo-predictive-fallback");
		predictiveFallback.priority = 1;
		const ctx = makeContext(
			[comboAccount, predictiveFallback],
			makeCombo({ account: comboAccount }),
		);
		ctx.strategy.select = mock(
			(
				selected: Account[],
				meta: {
					routingCandidates?: readonly { comboSlotId?: string | null }[];
				},
			) =>
				meta.routingCandidates?.some(
					(candidate) => candidate.comboSlotId != null,
				)
					? selected.filter((account) => account.id === comboAccount.id)
					: selected.filter((account) => account.id === predictiveFallback.id),
		);
		ctx.config.getUsageThrottlingWeeklyEnabled = () => true;
		usageCache.set(predictiveFallback.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 90,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Fable" } },
					is_active: true,
				},
			],
		});
		cachedUsageAccountIds.add(predictiveFallback.id);
		const attempts = installFetch((attempt) => {
			usageCache.markModelScopedExhausted(
				comboAccount.id,
				OPUS,
				"",
				Date.now() + 60_000,
			);
			cachedUsageAccountIds.add(comboAccount.id);
			return attempt.account === comboAccount.id && attempt.model === FABLE
				? exactModelExhausted()
				: success();
		});

		const response = await run(ctx);
		const body = (await response.json()) as {
			error?: { code?: string };
		};

		expect(response.status).toBe(503);
		expect(body.error?.code).toBe("model_pool_exhausted");
		expect(attempts).toEqual([{ account: comboAccount.id, model: FABLE }]);
	});

	it("returns hard deferred depletion after a prior requested-model transport", async () => {
		const account = makeAccount("reactive-deferred-after-transport");
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		const attempts = installFetch(() => {
			usageCache.markModelScopedExhausted(
				account.id,
				OPUS,
				"",
				Date.now() + 60_000,
			);
			cachedUsageAccountIds.add(account.id);
			return exactModelExhausted();
		});

		const response = await run(ctx);
		const body = (await response.json()) as {
			error?: { code?: string };
		};

		expect(response.status).toBe(503);
		expect(body.error?.code).toBe("model_pool_exhausted");
		expect(attempts).toEqual([{ account: account.id, model: FABLE }]);
	});

	it("skips a reactively depleted deferred route and tries the next clear peer", async () => {
		const depleted = makeAccount("deferred-reactive-depleted");
		const clear = makeAccount("deferred-reactive-clear");
		const ctx = makeContext(
			[depleted, clear],
			makeCombo({ account: depleted }, { account: clear }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(depleted.id);
		cacheCurrentFableExhaustion(clear.id);
		let installedReactiveEvidence = false;
		ctx.strategy.peek = mock((selected: Account[]) => {
			if (!installedReactiveEvidence) {
				installedReactiveEvidence = true;
				usageCache.markModelScopedExhausted(
					depleted.id,
					OPUS,
					"",
					Date.now() + 60_000,
				);
			}
			return selected[0]?.id ?? null;
		});
		const attempts = installFetch(() => success());

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: clear.id, model: OPUS }]);
	});

	it("returns model-pool exhaustion when every deferred route is reactively depleted", async () => {
		const first = makeAccount("deferred-reactive-all-a");
		const second = makeAccount("deferred-reactive-all-b");
		const ctx = makeContext(
			[first, second],
			makeCombo({ account: first }, { account: second }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(first.id);
		cacheCurrentFableExhaustion(second.id);
		let installedReactiveEvidence = false;
		ctx.strategy.peek = mock((selected: Account[]) => {
			if (!installedReactiveEvidence) {
				installedReactiveEvidence = true;
				for (const account of [first, second]) {
					usageCache.markModelScopedExhausted(
						account.id,
						OPUS,
						"",
						Date.now() + 60_000,
					);
				}
			}
			return selected[0]?.id ?? null;
		});
		const attempts = installFetch(() => success());

		const response = await run(ctx);
		const body = (await response.json()) as {
			error?: { code?: string };
		};

		expect(response.status).toBe(503);
		expect(body.error?.code).toBe("model_pool_exhausted");
		expect(attempts).toEqual([]);
	});

	it("ignores an excluded healthy Anthropic OAuth route when planning an allowed blocked fallback", async () => {
		const excludedHealthy = makeAccount("excluded-healthy-oauth");
		excludedHealthy.provider = "anthropic";
		excludedHealthy.api_key = null;
		excludedHealthy.refresh_token = "oauth-refresh";
		const allowedBlocked = makeAccount("allowed-blocked-fallback");
		const ctx = makeContext(
			[excludedHealthy, allowedBlocked],
			makeCombo({ account: excludedHealthy }, { account: allowedBlocked }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(allowedBlocked.id);
		const attempts = installFetch((attempt) =>
			attempt.account === allowedBlocked.id && attempt.model === OPUS
				? success()
				: exactModelExhausted(),
		);

		const response = await run(
			ctx,
			makeRequest({
				"x-better-ccflare-exclude-providers": "anthropic-oauth",
			}),
		);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: allowedBlocked.id, model: OPUS }]);
	});

	it("keeps asymmetric fallback families in stable waves when an earlier account starts blocked", async () => {
		const blocked = makeAccount("blocked-asymmetric-a", [FABLE, OPUS, SONNET]);
		const healthy = makeAccount("healthy-asymmetric-b", [
			FABLE,
			FABLE_SIBLING,
			SONNET,
			OPUS,
		]);
		blocked.priority = 0;
		healthy.priority = 1;
		const ctx = makeContext(
			[blocked, healthy],
			makeCombo({ account: blocked }, { account: healthy }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(blocked.id);
		const attempts = installFetch((attempt) =>
			attempt.account === healthy.id && attempt.model === SONNET
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: healthy.id, model: FABLE },
			{ account: healthy.id, model: FABLE_SIBLING },
			{ account: blocked.id, model: OPUS },
			{ account: healthy.id, model: OPUS },
			{ account: blocked.id, model: SONNET },
			{ account: healthy.id, model: SONNET },
		]);
	});

	it("runs a capacity-clear requested-family sibling before every cross-family fallback", async () => {
		const blocked = makeAccount("blocked-same-family-a", [
			FABLE,
			OPUS,
			FABLE_SIBLING,
		]);
		const healthy = makeAccount("healthy-same-family-b");
		const ctx = makeContext(
			[blocked, healthy],
			makeCombo({ account: blocked }, { account: healthy }),
		);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		usageCache.markModelScopedExhausted(
			blocked.id,
			FABLE,
			"",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(blocked.id);
		const attempts = installFetch((attempt) =>
			attempt.account === blocked.id && attempt.model === FABLE_SIBLING
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: healthy.id, model: FABLE },
			{ account: blocked.id, model: FABLE_SIBLING },
		]);
	});

	it("preserves a three-model tail so Sonnet runs after deferred Opus fails", async () => {
		const account = makeAccount("capacity-three-model-tail", [
			FABLE,
			OPUS,
			SONNET,
		]);
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFableExhaustion(account.id);
		const attempts = installFetch((attempt) =>
			attempt.model === SONNET ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: account.id, model: OPUS },
			{ account: account.id, model: SONNET },
		]);
	});

	it("records a hard-blocked fallback model and skips it while draining the remaining tail", async () => {
		const account = makeAccount("capacity-blocked-opus-tail", [
			FABLE,
			OPUS,
			SONNET,
		]);
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		cacheCurrentFamilyExhaustion(account.id, "Fable", "Opus");
		const attempts = installFetch((attempt) =>
			attempt.model === SONNET ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: account.id, model: SONNET }]);
		expect(usageHandleStart.mock.calls[0]?.[0]).toMatchObject({
			originalModel: FABLE,
			appliedModel: SONNET,
		});
	});

	it("uses each exact deferred model for predictive usage checks", async () => {
		const account = makeAccount("capacity-predictive-tail", [
			FABLE,
			OPUS,
			SONNET,
		]);
		const ctx = makeContext([account], makeCombo({ account }));
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(null, family),
		);
		ctx.config.getUsageThrottlingWeeklyEnabled = () => true;
		usageCache.set(account.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Fable" } },
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent: 90,
					resets_at: new Date(
						Date.now() + 2 * 24 * 60 * 60 * 1000,
					).toISOString(),
					scope: { model: { id: null, display_name: "Opus" } },
					is_active: true,
				},
			],
		});
		cachedUsageAccountIds.add(account.id);
		const attempts = installFetch((attempt) =>
			attempt.model === SONNET ? success() : exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([{ account: account.id, model: SONNET }]);
	});

	it("allows an exact-failure same-family sibling before accounts but defers cross-family", async () => {
		const accountA = makeAccount("exact-a", [FABLE, FABLE_SIBLING, OPUS]);
		const accountB = makeAccount("exact-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) =>
			attempt.account === accountB.id && attempt.model === FABLE
				? success()
				: exactModelExhausted(),
		);

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountA.id, model: FABLE_SIBLING },
			{ account: accountB.id, model: FABLE },
		]);
	});

	it("prunes a family only on the failing account", async () => {
		const accountA = makeAccount("family-a", [FABLE, FABLE_SIBLING, OPUS]);
		const accountB = makeAccount("family-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) => {
			if (attempt.account === accountA.id && attempt.model === FABLE) {
				// Selection has already admitted the route. Install fresh evidence only
				// now so the raw-response classifier can scope this generic 429 without
				// the hard-capacity selector preemptively excluding A/Fable.
				cacheFreshFableExhaustion(accountA.id);
				return generic429();
			}
			return success();
		});

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
		]);
		expect(
			usageCache.getFamilyScopedExhaustion(accountA.id, FABLE_SIBLING),
		).not.toBeNull();
		expect(
			usageCache.getFamilyScopedExhaustion(accountB.id, FABLE_SIBLING),
		).toBeNull();
	});

	it.each([
		401, 402,
	])("blocks deferred sibling models after account-wide status %i", async (accountWideStatus) => {
		const accountA = makeAccount(`blocked-a-${accountWideStatus}`);
		const accountB = makeAccount(`blocked-b-${accountWideStatus}`);
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo(
				{ account: accountA },
				{ account: accountA, model: FABLE_SIBLING },
				{ account: accountB },
			),
		);
		const attempts = installFetch((attempt) => {
			if (attempt.account === accountA.id && attempt.model === FABLE_SIBLING) {
				return new Response('{"error":"account-wide"}', {
					status: accountWideStatus,
					headers: { "content-type": "application/json" },
				});
			}
			if (attempt.account === accountB.id && attempt.model === OPUS) {
				return success();
			}
			return exactModelExhausted();
		});

		const response = await run(ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountA.id, model: FABLE_SIBLING },
			{ account: accountB.id, model: FABLE },
			{ account: accountB.id, model: OPUS },
		]);
	});

	it("preserves the final deferred upstream 529 response", async () => {
		const accountA = makeAccount("terminal-a");
		const accountB = makeAccount("terminal-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		const attempts = installFetch((attempt) => {
			if (attempt.account === accountB.id && attempt.model === OPUS) {
				return new Response(
					'{"type":"error","error":{"type":"overloaded_error"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"x-upstream-proof": "deferred-terminal",
						},
					},
				);
			}
			return exactModelExhausted();
		});

		const response = await run(ctx);

		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountA.id, model: OPUS },
			{ account: accountB.id, model: OPUS },
		]);
		expect(response.status).toBe(529);
		expect(response.headers.get("x-upstream-proof")).toBe("deferred-terminal");
		expect(await response.json()).toEqual({
			type: "error",
			error: { type: "overloaded_error" },
		});
	});

	it("drains deferred routes before a retained post-combo terminal", async () => {
		const accountA = makeAccount("drain-a");
		const accountB = makeAccount("drain-b");
		const ctx = makeContext(
			[accountA, accountB],
			makeCombo({ account: accountA }, { account: accountB }),
		);
		ctx.strategy.select = mock(
			(
				selected: Account[],
				meta: {
					routingCandidates?: readonly { comboSlotId?: string | null }[];
				},
			) =>
				meta.routingCandidates?.some(
					(candidate) => candidate.comboSlotId != null,
				)
					? selected
					: [],
		);
		const attempts = installFetch((attempt) => {
			if (attempt.account === accountA.id && attempt.model === OPUS) {
				return success();
			}
			if (attempt.account === accountB.id && attempt.model === FABLE) {
				return new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"must stay internal"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"x-upstream-proof": "must-not-leak",
						},
					},
				);
			}
			return exactModelExhausted();
		});

		const response = await run(ctx);

		expect(attempts).toEqual([
			{ account: accountA.id, model: FABLE },
			{ account: accountB.id, model: FABLE },
			{ account: accountA.id, model: OPUS },
		]);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-upstream-proof")).toBeNull();
		expect(await response.json()).toEqual({ type: "message", content: [] });
	});
});
