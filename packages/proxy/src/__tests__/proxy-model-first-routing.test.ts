import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
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
const { usageCache } = await import("@better-ccflare/providers");
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");

const FABLE = "claude-fable-5";
const FABLE_SIBLING = "claude-fable-5-20260701";
const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-5";

const originalFetch = globalThis.fetch;
const originalOverloadRetry = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
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
			getActiveComboForFamily: mock(async () => combo),
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
	installUsageCollector();
	process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
});

afterEach(() => {
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
});

describe("global model-first routing", () => {
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
		ctx.dbOps.getActiveComboForFamily = mock(async () => null);
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
