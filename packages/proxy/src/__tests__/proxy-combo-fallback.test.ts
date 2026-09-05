import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers";
import type { UsageCollector } from "../usage-collector";

const { usageCache } = await import("@better-ccflare/providers");
const { getProvider, registerProvider } = await import(
	"@better-ccflare/providers"
);
const usageCollectorModule = await import("../usage-collector");
const { clearRoutingObservations, getRoutingObservations } = await import(
	"../handlers/routing-observations"
);
const { handleProxy } = await import("../proxy");

function makeAccount(id: string): Account {
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeMockRoutingProvider(name: string): Provider {
	return {
		name,
		canHandle: () => true,
		refreshToken: async (account) => ({
			accessToken: account.access_token || "mock-access-token",
			expiresAt: Date.now() + 60 * 60 * 1000,
			refreshToken: account.refresh_token || "mock-refresh-token",
		}),
		buildUrl: (_path, _search, account) =>
			`https://upstream.test/${name}/${account?.id ?? "anonymous"}`,
		prepareHeaders: (headers, accessToken, apiKey) => {
			const prepared = new Headers(headers);
			if (accessToken) prepared.set("authorization", `Bearer ${accessToken}`);
			if (apiKey) prepared.set("x-api-key", apiKey);
			return prepared;
		},
		transformRequestBody: async (request) => request,
		processResponse: async (response) => response,
		parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		isStreamingResponse: () => false,
	};
}

function installMockRoutingProviders(names: readonly string[]): () => void {
	const previous = names.map((name) => ({ name, provider: getProvider(name) }));
	for (const name of names) registerProvider(makeMockRoutingProvider(name));
	return () => {
		for (const entry of previous) {
			if (entry.provider) registerProvider(entry.provider);
		}
	};
}

function makeOpenRouterAccount(id: string): Account {
	const account = makeAccount(id);
	account.provider = "openrouter";
	account.api_key = "openrouter-test-key";
	account.refresh_token = "";
	account.access_token = null;
	account.custom_endpoint = "https://upstream.test/openrouter";
	return account;
}

function makeCodexOAuthAccount(id: string): Account {
	const account = makeAccount(id);
	account.provider = "codex";
	account.api_key = null;
	account.refresh_token = "codex-test-refresh";
	account.access_token = "codex-test-access";
	account.expires_at = Date.now() + 60 * 60 * 1000;
	account.custom_endpoint = null;
	return account;
}

const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};
const cachedUsageAccountIds = new Set<string>();

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	clearRoutingObservations();
	for (const accountId of cachedUsageAccountIds) usageCache.delete(accountId);
	cachedUsageAccountIds.clear();
	globalThis.fetch = originalFetch;
});

function installUsageCollector(): ReturnType<typeof mock> {
	const handleStart = mock(() => undefined);
	const collector = {
		handleStart,
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as UsageCollector;
	const requiredCollectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector);
	const optionalCollectorSpy = spyOn(
		usageCollectorModule,
		"tryGetUsageCollector",
	).mockReturnValue(collector);
	restoreUsageCollector = () => {
		requiredCollectorSpy.mockRestore();
		optionalCollectorSpy.mockRestore();
	};
	return handleStart;
}

function makeRoutingPolicy(
	combo: ComboWithSlots,
	family: ComboFamily,
): ComboRoutingPolicySnapshot {
	const { slots, ...comboRecord } = combo;
	return {
		assignment: {
			family,
			combo_id: combo.id,
			enabled: true,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: comboRecord,
		slots,
		rules: [],
		exclusions: [],
	};
}

function makeDisabledDegradedModeContext(): Pick<
	ProxyContext,
	"anthropicDegradedMode" | "degradedOwnerOverlay"
> {
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
	return {
		anthropicDegradedMode,
		degradedOwnerOverlay: new DegradedOwnerOverlay({
			evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
		}),
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots,
	strategySelect: (accounts: Account[], meta: unknown) => Account[],
): ProxyContext {
	return {
		...makeDisabledDegradedModeContext(),
		strategy: { select: mock(strategySelect) },
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
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		},
		provider: {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string, account: Account) =>
				`https://upstream.test/${account.id}`,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: null,
			}),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) },
	} as unknown as ProxyContext;
}

function makeProxyRequest(
	model = "claude-opus-4-5",
	synthetic = true,
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (synthetic) headers["x-better-ccflare-auto-refresh"] = "true";
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function outOfCreditsResponse(): Response {
	return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
		status: 429,
		headers: {
			"content-type": "application/json",
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		},
	});
}

function addSensitivePersistenceHeaders(request: Request): Request {
	request.headers.set("authorization", "Bearer client-secret");
	request.headers.set("cookie", "session=client-secret");
	request.headers.set("x-api-key", "client-secret");
	request.headers.set(
		"x-better-ccflare-guard-request-id",
		"v1.00000000-0000-4000-8000-000000000001.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	);
	request.headers.set(
		"x-better-ccflare-guard-correlation-secret",
		"spoofed-guard-secret",
	);
	request.headers.set(
		"x-better-ccflare-internal-probe-secret",
		"spoofed-probe-secret",
	);
	request.headers.set("x-client-visible", "kept");
	return request;
}

function expectSanitizedComboTerminalHeaders(
	handleStart: ReturnType<typeof mock>,
): void {
	const terminalStart = handleStart.mock.calls
		.map(
			(call) =>
				call[0] as
					| {
							accountId: string | null;
							responseStatus: number;
							requestHeaders: Record<string, string>;
					  }
					| undefined,
		)
		.find(
			(message) =>
				message?.accountId === null && message.responseStatus === 503,
		);

	expect(terminalStart).toBeDefined();
	expect(terminalStart?.requestHeaders).toEqual({
		"content-type": "application/json",
		"x-client-visible": "kept",
	});
}

describe("routing observations", () => {
	it("records the ordinary selected account order", async () => {
		installUsageCollector();
		const first = makeAccount("ordinary-first");
		const second = makeAccount("ordinary-second");
		const unusedCombo: ComboWithSlots = {
			id: "unused-combo",
			name: "Unused combo",
			description: null,
			enabled: false,
			created_at: 0,
			updated_at: 0,
			slots: [],
		};
		const ctx = makeContext([first, second], unusedCombo, () => [
			second,
			first,
		]);
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) => {
			const policy = makeRoutingPolicy(unusedCombo, family);
			policy.assignment.enabled = false;
			return policy;
		});
		globalThis.fetch = mock(
			async () =>
				new Response('{"type":"message","content":[]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(getRoutingObservations().opus?.order).toEqual([
			{ id: second.id, name: second.name },
			{ id: first.id, name: first.name },
		]);
	});
});

describe("combo fallback disabled terminal persistence", () => {
	it("sanitizes request headers when no combo slot is available", async () => {
		const previousFallbackSetting =
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const handleStart = installUsageCollector();
		const unavailable = makeAccount("unavailable-combo-account");
		unavailable.rate_limited_until = Date.now() + 60_000;
		const combo: ComboWithSlots = {
			id: "combo-unavailable",
			name: "Unavailable combo",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-unavailable",
					combo_id: "combo-unavailable",
					account_id: unavailable.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([unavailable], combo, (accounts) => accounts);
		ctx.config.getComboSessionFallback = () => false;
		const upstreamFetch = mock(async () => {
			throw new Error("unavailable combo must not reach upstream");
		});
		globalThis.fetch = upstreamFetch as unknown as typeof fetch;

		try {
			const request = addSensitivePersistenceHeaders(
				makeProxyRequest("claude-opus-4-5", false),
			);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(503);
			expect(upstreamFetch).not.toHaveBeenCalled();
			expectSanitizedComboTerminalHeaders(handleStart);
		} finally {
			if (previousFallbackSetting === undefined) {
				delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
			} else {
				process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK =
					previousFallbackSetting;
			}
		}
	});

	it("sanitizes request headers after every combo slot fails", async () => {
		const previousFallbackSetting =
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const handleStart = installUsageCollector();
		const account = makeAccount("failed-combo-account");
		const combo: ComboWithSlots = {
			id: "combo-failed",
			name: "Failed combo",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-failed",
					combo_id: "combo-failed",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([account], combo, (accounts) => accounts);
		ctx.config.getComboSessionFallback = () => false;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response('{"error":"expired"}', {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const request = addSensitivePersistenceHeaders(
				makeProxyRequest("claude-opus-4-5", false),
			);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(503);
			expect(fetchCount).toBe(1);
			expectSanitizedComboTerminalHeaders(handleStart);
		} finally {
			if (previousFallbackSetting === undefined) {
				delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
			} else {
				process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK =
					previousFallbackSetting;
			}
		}
	});
});

describe("post-combo normal fallback", () => {
	it("runs the active combo once, then selects normal accounts without re-entering it", async () => {
		const handleStart = mock(() => undefined);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart,
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as unknown as UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		const comboAccount = makeAccount("combo-account");
		const normalAccount = makeAccount("normal-account");
		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const getComboRoutingPolicy = mock(async (family: ComboFamily) =>
			makeRoutingPolicy(combo, family),
		);
		const strategySelect = mock(
			(
				accounts: Account[],
				meta: { routingCandidates?: readonly unknown[] },
			) =>
				meta.routingCandidates?.some(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						"comboSlotId" in candidate &&
						candidate.comboSlotId !== null,
				)
					? accounts
					: [normalAccount],
		);
		const ctx = {
			...makeDisabledDegradedModeContext(),
			strategy: { select: strategySelect },
			dbOps: {
				getAllAccounts: mock(async () => [comboAccount, normalAccount]),
				getComboRoutingPolicy,
			},
			runtime: { port: 8080, clientId: "test" },
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getComboSessionFallback: () => true,
				getStorePayloads: () => false,
			},
			provider: {
				name: "test-provider",
				canHandle: () => true,
				buildUrl: (_path: string, _search: string, account: Account) =>
					`https://upstream.test/${account.id}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
				processResponse: async (response: Response) => response,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: null,
				}),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => undefined) },
		} as unknown as ProxyContext;

		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			if (upstreamUrls.length === 1) {
				return new Response(JSON.stringify({ error: "expired" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ type: "message", content: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			"https://upstream.test/combo-account",
			"https://upstream.test/normal-account",
		]);
		expect(getComboRoutingPolicy).toHaveBeenCalledTimes(1);
		expect(strategySelect).toHaveBeenCalledTimes(2);
		expect(getRoutingObservations().opus?.order).toEqual([
			{ id: normalAccount.id, name: normalAccount.name },
		]);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it("skips duplicate combo slots but still reaches a later distinct route", async () => {
		installUsageCollector();
		const repeated = makeAccount("repeated-account");
		const later = makeAccount("later-account");
		const combo: ComboWithSlots = {
			id: "combo-duplicates",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-repeated-1",
					combo_id: "combo-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-repeated-2",
					combo_id: "combo-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-z-later",
					combo_id: "combo-duplicates",
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([repeated, later], combo, (accounts) => accounts);
		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			return upstreamUrls.length === 1
				? new Response('{"error":"expired"}', { status: 401 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			"https://upstream.test/repeated-account",
			"https://upstream.test/later-account",
		]);
	});

	it("allows a sibling model after model-scoped exhaustion", async () => {
		const handleStart = installUsageCollector();
		const shared = makeAccount("shared-account");
		const combo: ComboWithSlots = {
			id: "combo-models",
			name: "Opus priority",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-opus-45",
					combo_id: "combo-models",
					account_id: shared.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-opus-48",
					combo_id: "combo-models",
					account_id: shared.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared], combo, (accounts) => accounts);
		// out_of_credits is an Anthropic-only signal. PR #57 deliberately ignores
		// the same header/body shape from arbitrary compatible providers, so keep
		// this cross-slot regression on the provider that owns the contract.
		ctx.provider.name = "anthropic";
		const attemptedModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attemptedModels.push(
				((await request.clone().json()) as { model: string }).model,
			);
			return attemptedModels.length === 1
				? outOfCreditsResponse()
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attemptedModels).toEqual(["claude-opus-4-5", "claude-opus-4-8"]);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it.each([
		401, 402, 429,
	])("blocks sibling-model slots after account-wide status %i", async (accountWideStatus) => {
		installUsageCollector();
		const shared = makeAccount(`shared-account-${accountWideStatus}`);
		const later = makeAccount(`later-account-${accountWideStatus}`);
		const combo: ComboWithSlots = {
			id: `combo-account-wide-${accountWideStatus}`,
			name: "Account-wide exclusion",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-shared-opus",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: shared.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-shared-sonnet",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: shared.id,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-z-later",
					combo_id: `combo-account-wide-${accountWideStatus}`,
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared, later], combo, (accounts) => accounts);
		const upstreamUrls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			upstreamUrls.push(request.url);
			return upstreamUrls.length === 1
				? new Response('{"error":"account-wide"}', {
						status: accountWideStatus,
						headers: { "content-type": "application/json" },
					})
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(upstreamUrls).toEqual([
			`https://upstream.test/${shared.id}`,
			`https://upstream.test/${later.id}`,
		]);
	});

	it("deduplicates aliases that transform to the same physical model", async () => {
		installUsageCollector();
		const shared = makeAccount("mapped-shared");
		const later = makeAccount("mapped-later");
		const combo: ComboWithSlots = {
			id: "combo-mapped-aliases",
			name: "Mapped aliases",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-alias-opus",
					combo_id: "combo-mapped-aliases",
					account_id: shared.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-alias-sonnet",
					combo_id: "combo-mapped-aliases",
					account_id: shared.id,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-distinct",
					combo_id: "combo-mapped-aliases",
					account_id: later.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([shared, later], combo, (accounts) => accounts);
		ctx.provider.transformRequestBody = async (request, account) => {
			const body = (await request.json()) as Record<string, unknown>;
			body.model = account?.id === shared.id ? "grok-4.3" : "grok-4-fast";
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			});
		};
		const attempted: Array<{ account: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attempted.push({
				account: new URL(request.url).pathname.slice(1),
				model: ((await request.json()) as { model: string }).model,
			});
			return attempted.length === 1
				? outOfCreditsResponse()
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attempted).toEqual([
			{ account: shared.id, model: "grok-4.3" },
			{ account: later.id, model: "grok-4-fast" },
		]);
	});

	it("persists only completed upstream failures after duplicate skips", async () => {
		const handleStart = installUsageCollector();
		const repeated = makeAccount("metric-repeated");
		const later = makeAccount("metric-later");
		const combo: ComboWithSlots = {
			id: "combo-metric-duplicates",
			name: "Metric duplicates",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "metric-1",
					combo_id: "combo-metric-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "metric-duplicate",
					combo_id: "combo-metric-duplicates",
					account_id: repeated.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
				{
					id: "metric-success",
					combo_id: "combo-metric-duplicates",
					account_id: later.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([repeated, later], combo, (accounts) => accounts);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return fetchCount === 1
				? new Response('{"error":"expired"}', { status: 401 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetchCount).toBe(2);
		expect(handleStart).toHaveBeenCalledTimes(1);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(1);
	});

	it("counts internal model fallback before post-combo normal account failover", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("internal-model-fallback");
		comboAccount.model_mappings = JSON.stringify({
			"claude-opus-4-5": ["claude-opus-4-5", "provider-opus-fallback"],
		});
		const normalAccount = makeAccount("normal-after-model-fallback");
		const combo: ComboWithSlots = {
			id: "combo-internal-model-fallback",
			name: "Internal model fallback",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-internal-model-fallback",
					combo_id: "combo-internal-model-fallback",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[comboAccount, normalAccount],
			combo,
			(accounts, meta) =>
				(
					meta as { routingCandidates?: readonly unknown[] }
				).routingCandidates?.some(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						"comboSlotId" in candidate &&
						candidate.comboSlotId !== null,
				)
					? accounts
					: [normalAccount],
		);
		const attempts: Array<{ account: string; model: string }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			attempts.push({
				account: new URL(request.url).pathname.slice(1),
				model: ((await request.json()) as { model: string }).model,
			});
			return attempts.length < 3
				? new Response('{"error":"rate limited"}', { status: 429 })
				: new Response('{"type":"message","content":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(attempts).toEqual([
			{ account: comboAccount.id, model: "claude-opus-4-5" },
			{ account: comboAccount.id, model: "provider-opus-fallback" },
			{ account: normalAccount.id, model: "claude-opus-4-5" },
		]);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(2);
	});

	it("preserves the last upstream 529 when normal fallback only repeats the same physical route", async () => {
		installUsageCollector();
		const account = makeAccount("retained-529-account");
		const combo: ComboWithSlots = {
			id: "combo-retained-529",
			name: "Retained overload",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-529",
					combo_id: "combo-retained-529",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([account], combo, (accounts) => accounts);
		// Model the allowed race where cooldown persistence is still queued when
		// post-combo normal routing refreshes account rows from the database.
		ctx.dbOps.getAllAccounts = mock(async () => [
			{
				...account,
				rate_limited_until: null,
				rate_limited_at: null,
				consecutive_rate_limits: 0,
			},
		]);
		ctx.provider.parseRateLimit = (response) => ({
			isRateLimited: response.status === 529,
			resetTime: null,
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained",
					},
				},
			);
		}) as unknown as typeof fetch;

		const previousRetrySetting = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		try {
			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(fetchCount).toBe(1);
			expect(response.status).toBe(529);
			expect(response.headers.get("x-upstream-proof")).toBe("retained");
			expect(await response.json()).toEqual({
				type: "error",
				error: { type: "overloaded_error" },
			});
		} finally {
			if (previousRetrySetting === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = previousRetrySetting;
			}
		}
	});

	it("preserves a native xAI 402 when normal fallback only repeats the same physical route", async () => {
		installUsageCollector();
		const account = makeAccount("retained-xai-402-account");
		account.provider = "xai";
		account.custom_endpoint = null;
		account.model_mappings = null;
		const combo: ComboWithSlots = {
			id: "combo-retained-xai-402",
			name: "Retained xAI capacity",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-xai-402",
					combo_id: "combo-retained-xai-402",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext([account], combo, (accounts) => accounts);
		ctx.dbOps.getAllAccounts = mock(async () => [
			{
				...account,
				rate_limited_until: null,
				rate_limited_at: null,
				consecutive_rate_limits: 0,
			},
		]);
		ctx.dbOps.markAccountRateLimited = mock(async () => 1);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"error":{"type":"rate_limit_error","message":"insufficient credits","code":"xai_402"}}',
				{
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-xai",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(402);
		expect(response.headers.get("x-upstream-proof")).toBe("retained-xai");
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "insufficient credits",
				code: "xai_402",
			},
		});
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
	});

	it("prefers a retained 529 when fallback accounts become reactively depleted before throttling", async () => {
		const handleStart = installUsageCollector();
		const comboAccount = makeAccount("retained-529-reactive-combo");
		const depletedFallback = makeAccount("reactive-fallback");
		const combo: ComboWithSlots = {
			id: "combo-retained-529-reactive",
			name: "Retained overload before reactive terminal",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-529-reactive",
					combo_id: "combo-retained-529-reactive",
					account_id: comboAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[comboAccount, depletedFallback],
			combo,
			(accounts, meta) => {
				const isComboPass = (
					meta as {
						routingCandidates?: readonly { comboSlotId?: string | null }[];
					}
				).routingCandidates?.some((candidate) => candidate.comboSlotId != null);
				if (isComboPass) return accounts;

				// Model a marker arriving after normal selection evaluated hard
				// capacity but before the outer proxy applies its final throttle pass.
				usageCache.markModelScopedExhausted(
					depletedFallback.id,
					"claude-opus-4-5",
					null,
					Date.now() + 60_000,
				);
				cachedUsageAccountIds.add(depletedFallback.id);
				return accounts.filter((account) => account.id === depletedFallback.id);
			},
		);
		ctx.provider.parseRateLimit = (response) => ({
			isRateLimited: response.status === 529,
			resetTime: null,
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error","message":"retained reactive proof"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-reactive-529",
					},
				},
			);
		}) as unknown as typeof fetch;

		const previousRetrySetting = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		try {
			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(fetchCount).toBe(1);
			expect(response.status).toBe(529);
			expect(response.headers.get("x-upstream-proof")).toBe(
				"retained-reactive-529",
			);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "overloaded_error",
					message: "retained reactive proof",
				},
			});
			expect(handleStart).toHaveBeenCalledTimes(1);
			expect(
				(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
					.failoverAttempts,
			).toBe(0);
		} finally {
			if (previousRetrySetting === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = previousRetrySetting;
			}
		}
	});

	it("prefers a retained native xAI 402 when every fallback account is predictively throttled", async () => {
		const handleStart = installUsageCollector();
		const xaiAccount = makeAccount("retained-xai-predictive-combo");
		xaiAccount.provider = "xai";
		xaiAccount.custom_endpoint = null;
		xaiAccount.model_mappings = null;
		const throttledFallback = makeAccount("predictive-fallback");
		const combo: ComboWithSlots = {
			id: "combo-retained-xai-predictive",
			name: "Retained xAI before predictive terminal",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "slot-retained-xai-predictive",
					combo_id: "combo-retained-xai-predictive",
					account_id: xaiAccount.id,
					model: "claude-opus-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};
		const ctx = makeContext(
			[xaiAccount, throttledFallback],
			combo,
			(accounts, meta) =>
				(
					meta as {
						routingCandidates?: readonly { comboSlotId?: string | null }[];
					}
				).routingCandidates?.some((candidate) => candidate.comboSlotId != null)
					? accounts
					: accounts.filter((account) => account.id === throttledFallback.id),
		);
		ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
		ctx.dbOps.markAccountRateLimited = mock(async () => 1);
		usageCache.set(throttledFallback.id, {
			five_hour: {
				utilization: 80,
				resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: null },
		});
		cachedUsageAccountIds.add(throttledFallback.id);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				'{"error":{"type":"rate_limit_error","message":"retained predictive proof","code":"xai_402"}}',
				{
					status: 402,
					headers: {
						"content-type": "application/json",
						"x-upstream-proof": "retained-predictive-xai",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = makeProxyRequest("claude-opus-4-5", false);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(402);
		expect(response.headers.get("x-upstream-proof")).toBe(
			"retained-predictive-xai",
		);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "retained predictive proof",
				code: "xai_402",
			},
		});
		expect(handleStart).toHaveBeenCalledTimes(1);
		expect(
			(handleStart.mock.calls[0]?.[0] as { failoverAttempts: number })
				.failoverAttempts,
		).toBe(0);
		expect(ctx.dbOps.markAccountRateLimited).toHaveBeenCalledTimes(1);
	});
});

describe("implicit fallback policy integration", () => {
	it("drains an OpenRouter API-key route across combo and normal fallback while preserving an OAuth sibling", async () => {
		installUsageCollector();
		const restoreProviders = installMockRoutingProviders([
			"openrouter",
			"codex",
		]);
		try {
			const openRouter = makeOpenRouterAccount("openrouter-drained");
			const oauthSibling = makeCodexOAuthAccount("oauth-sibling");
			const combo: ComboWithSlots = {
				id: "combo-openrouter-drain",
				name: "OpenRouter drain",
				description: null,
				enabled: true,
				created_at: 0,
				updated_at: 0,
				slots: [
					{
						id: "slot-openrouter-drain",
						combo_id: "combo-openrouter-drain",
						account_id: openRouter.id,
						model: "claude-opus-4-5",
						priority: 0,
						enabled: true,
					},
				],
			};
			const ctx = makeContext(
				[openRouter, oauthSibling],
				combo,
				(accounts) => accounts,
			);
			ctx.implicitFallbackPolicy = {
				mode: "enforce",
				allowedClasses: [],
				deniedClasses: ["api-key"],
			};

			const upstreamUrls: string[] = [];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request = input instanceof Request ? input : new Request(input);
				upstreamUrls.push(request.url);
				return new Response(JSON.stringify({ type: "message", content: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect(response.status).toBe(200);
			expect(upstreamUrls).toEqual([
				"https://upstream.test/codex/oauth-sibling",
			]);
			expect(upstreamUrls.some((url) => url.includes(openRouter.id))).toBe(
				false,
			);
		} finally {
			restoreProviders();
		}
	});

	it("returns a zero-attempt terminal when every implicit candidate is policy-denied", async () => {
		const restoreProviders = installMockRoutingProviders(["openrouter"]);
		const previousPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		// The enforce policy must close the legacy passthrough escape hatch too;
		// otherwise a paid route can still receive the request after selection
		// reports policy_excluded.
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		try {
			const openRouter = makeOpenRouterAccount("openrouter-only-denied");
			const combo: ComboWithSlots = {
				id: "combo-openrouter-only-denied",
				name: "OpenRouter-only drain",
				description: null,
				enabled: true,
				created_at: 0,
				updated_at: 0,
				slots: [
					{
						id: "slot-openrouter-only-denied",
						combo_id: "combo-openrouter-only-denied",
						account_id: openRouter.id,
						model: "claude-opus-4-5",
						priority: 0,
						enabled: true,
					},
				],
			};
			const ctx = makeContext([openRouter], combo, (accounts) => accounts);
			ctx.implicitFallbackPolicy = {
				mode: "enforce",
				allowedClasses: [],
				deniedClasses: ["api-key"],
			};
			const upstreamFetch = mock(async () => {
				throw new Error("policy-denied account must not reach upstream");
			});
			globalThis.fetch = upstreamFetch as unknown as typeof fetch;

			const request = makeProxyRequest("claude-opus-4-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			const payload = (await response.json()) as {
				error?: {
					attempted_routes?: number;
					routing_diagnostics?: {
						mode?: string;
						structural_candidate_count?: number;
						eligible_candidate_count?: number;
						zero_attempt_reason?: string;
					};
				};
			};

			expect(response.status).toBe(503);
			expect(upstreamFetch).not.toHaveBeenCalled();
			expect(payload.error?.attempted_routes).toBe(0);
			expect(payload.error?.routing_diagnostics).toMatchObject({
				mode: "enforce",
				structural_candidate_count: 1,
				eligible_candidate_count: 0,
				zero_attempt_reason: "policy_excluded",
			});
		} finally {
			restoreProviders();
			if (previousPassthrough === undefined) {
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			} else {
				process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previousPassthrough;
			}
		}
	});
});

describe("native quota wait execution", () => {
	function nativePool() {
		const accounts = ["native-a", "native-b"].map(
			(id) =>
				({
					...makeAccount(id),
					provider: "anthropic",
					api_key: null,
					access_token: "offline-token",
					refresh_token: "offline-refresh",
					expires_at: Date.now() + 3_600_000,
				}) as Account,
		);
		const combo: ComboWithSlots = {
			id: "native-combo",
			name: "Native Fable",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: accounts.flatMap((account, index) => [
				{
					id: `native-fable-${index}`,
					combo_id: "native-combo",
					account_id: account.id,
					model: "claude-fable-5",
					priority: 0,
					enabled: true,
				},
				{
					id: `native-opus-${index}`,
					combo_id: "native-combo",
					account_id: account.id,
					model: "claude-opus-4-8",
					priority: 10,
					enabled: true,
				},
			]),
		};
		const ctx = makeContext(accounts, combo, (candidates) => candidates);
		ctx.config.getModelScopedCapacityRouting = () => "exhausted";
		ctx.dbOps.getComboRoutingPolicy = mock(async (family: ComboFamily) => ({
			...makeRoutingPolicy(combo, family),
			assignment: {
				...makeRoutingPolicy(combo, family).assignment,
				exhaustion_policy: "native_quota_wait",
			},
		}));
		const restore = installMockRoutingProviders(["anthropic"]);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
		});
		const handleStart = installUsageCollector();
		const calls: Array<{ account: string; model: string }> = [];
		return { accounts, combo, ctx, restore, calls, handleStart };
	}

	function putUsage(
		account: Account,
		familyPercent: number,
		sharedPercent = 10,
	) {
		cachedUsageAccountIds.add(account.id);
		usageCache.set(account.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "session",
					percent: sharedPercent,
					is_active: true,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				},
				{
					kind: "weekly_all",
					percent: 10,
					is_active: true,
					resets_at: new Date(Date.now() + 86_400_000).toISOString(),
				},
				{
					kind: "weekly_scoped",
					percent: familyPercent,
					is_active: true,
					resets_at: new Date(Date.now() + 86_400_000).toISOString(),
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
				},
			],
		} as never);
	}

	it.each([
		"anthropic-oauth",
		"anthropic",
		"implicit",
	])("never restores request-denied native routes from the structural pool: %s", async (denial) => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 100);
		ctx.config.getComboSessionFallback = () => true;
		ctx.config.getAgentFrontmatterModelFallback = () => true;
		if (denial === "implicit") {
			ctx.implicitFallbackPolicy = {
				mode: "enforce",
				allowedClasses: [],
				deniedClasses: ["oauth-subscription"],
			};
		}
		const previous = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		const transport = mock(async () =>
			Response.json({ type: "message", content: [] }),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			if (denial !== "implicit")
				request.headers.set("x-better-ccflare-exclude-providers", denial);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
			expect(response.headers.get("x-should-retry")).toBeNull();
		} finally {
			restore();
			if (previous === undefined)
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previous;
		}
	});

	it.each([
		"provider",
		"implicit",
		"route-intent",
	])("rechecks native request authority after asynchronous preparation: %s", async (denial) => {
		const { ModelRouteSessionRegistry } = await import(
			"../model-route-profiles"
		);
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		const registry = new ModelRouteSessionRegistry([]);
		ctx.modelRouteSessionRegistry = registry;
		let denied = false;
		const routeIntent = spyOn(
			registry,
			"isProfileOnlyAccount",
		).mockImplementation(() => denied && denial === "route-intent");
		let meta: RequestMeta | undefined;
		ctx.strategy.select = mock((candidates: Account[], input: RequestMeta) => {
			meta = input;
			return candidates;
		});
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				denied = true;
				if (denial === "provider")
					meta?.headers?.set(
						"x-better-ccflare-exclude-providers",
						"anthropic-oauth",
					);
				if (denial === "implicit")
					ctx.implicitFallbackPolicy = {
						mode: "enforce",
						allowedClasses: [],
						deniedClasses: ["oauth-subscription"],
					};
				return request;
			},
		});
		const transport = mock(async () =>
			Response.json({ type: "message", content: [] }),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(denied).toBe(true);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			routeIntent.mockRestore();
			restore();
		}
	});

	it("does not defer native backups that lack the request's server-tool capability", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 100);
		const transport = mock(async () =>
			Response.json({ type: "message", content: [] }),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-fable-5",
					messages: [{ role: "user", content: "offline capability fixture" }],
					max_tokens: 16,
					tools: [{ type: "web_search_20250305", name: "web_search" }],
				}),
			});
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("x-should-retry")).not.toBe("true");
		} finally {
			restore();
		}
	});

	it.each([
		"public-force",
		"profile",
		"excluded-profile",
	])("preserves existing explicit route authority with a native assignment: %s", async (mode) => {
		const { ModelRouteSessionRegistry, parseModelRouteProfiles } = await import(
			"../model-route-profiles"
		);
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		ctx.implicitFallbackPolicy = {
			mode: "enforce",
			allowedClasses: [],
			deniedClasses: ["oauth-subscription"],
		};
		if (mode !== "public-force")
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
				parseModelRouteProfiles(
					JSON.stringify([
						{
							id: "offline-native",
							displayName: "Offline native",
							accountId: accounts[0].id,
							logicalModel: "claude-fable-5",
							expectedProvider: "anthropic",
							expectedPhysicalModel: "claude-fable-5",
						},
					]),
				),
			);
		const transport = mock(async () =>
			Response.json({ type: "message", content: [] }),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest(
				mode === "public-force"
					? "claude-fable-5"
					: "claude-bccf-route-offline-native",
				false,
			);
			if (mode === "public-force")
				request.headers.set("x-better-ccflare-account-id", accounts[0].id);
			if (mode !== "profile")
				request.headers.set(
					"x-better-ccflare-exclude-providers",
					"anthropic-oauth",
				);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(mode === "excluded-profile" ? 503 : 200);
			expect(transport).toHaveBeenCalledTimes(
				mode === "excluded-profile" ? 0 : 1,
			);
		} finally {
			restore();
		}
	});

	it("preserves finite native overload across requests while exact-model markers remain active", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request) => {
			const model = (await input.clone().json()).model;
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model,
			});
			return new Response(
				'{"type":"error","error":{"type":"rate_limit_error"}}',
				{
					status: 429,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;
		let restoreClock = () => {};
		try {
			const first = makeProxyRequest("claude-fable-5", false);
			const firstResponse = await handleProxy(first, new URL(first.url), ctx);
			expect(firstResponse.status).toBe(529);
			expect(calls).toHaveLength(2);
			const markers = accounts.map((account) =>
				usageCache.getModelScopedExhaustion(account.id, "claude-fable-5"),
			);
			expect(markers.every((marker) => marker !== null)).toBe(true);
			const second = makeProxyRequest("claude-fable-5", false);
			const secondResponse = await handleProxy(
				second,
				new URL(second.url),
				ctx,
			);
			expect(secondResponse.status).toBe(529);
			expect(await secondResponse.json()).toMatchObject({
				error: { type: "overloaded_error" },
			});
			expect(
				Number(secondResponse.headers.get("retry-after")),
			).toBeGreaterThanOrEqual(1);
			expect(
				Number(secondResponse.headers.get("retry-after")),
			).toBeLessThanOrEqual(60);
			expect(calls).toHaveLength(2);
			expect(calls.every((call) => call.model === "claude-fable-5")).toBe(true);
			const expiry = Math.max(
				...markers.map((marker) => marker?.expiresAt ?? 0),
			);
			const clock = spyOn(Date, "now").mockReturnValue(expiry + 1);
			restoreClock = () => clock.mockRestore();
			for (const account of accounts) putUsage(account, 20);
			globalThis.fetch = mock(async (input: Request) => {
				calls.push({
					account: new URL(input.url).pathname.split("/").at(-1) ?? "",
					model: (await input.clone().json()).model,
				});
				return Response.json({ type: "message", content: [] });
			}) as typeof fetch;
			const third = makeProxyRequest("claude-fable-5", false);
			const thirdResponse = await handleProxy(third, new URL(third.url), ctx);
			expect(thirdResponse.status).toBe(200);
			expect(calls).toHaveLength(3);
			expect(calls[2].model).toBe("claude-fable-5");
		} finally {
			restoreClock();
			restore();
		}
	});

	it("preserves session affinity through Fable to Opus and back to recovered Fable", async () => {
		const { SessionAffinityStrategy } = await import(
			"@better-ccflare/load-balancer"
		);
		const { clearSession, getServedAccountObservation } = await import(
			"../session-account-observer"
		);
		const { accounts, combo, ctx, restore, calls, handleStart } = nativePool();
		const strategy = new SessionAffinityStrategy();
		strategy.initialize({ resetAccountSession: () => undefined });
		ctx.strategy = strategy;
		const select = spyOn(strategy, "select");
		const sessionId = "offline-native-quota-affinity";
		globalThis.fetch = mock(async (request: Request) => {
			const model = (await request.clone().json()).model;
			calls.push({
				account: new URL(request.url).pathname.split("/").at(-1) ?? "",
				model,
			});
			return Response.json({ type: "message", model, content: [] });
		}) as typeof fetch;
		try {
			const expectedModels = [
				"claude-fable-5",
				"claude-opus-4-8",
				"claude-fable-5",
			];
			for (const [index, familyPercent] of [20, 100, 20].entries()) {
				for (const account of accounts) putUsage(account, familyPercent);
				const request = new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-claude-code-session-id": sessionId,
					},
					body: JSON.stringify({
						model: "claude-fable-5",
						metadata: { user_id: sessionId },
						messages: [{ role: "user", content: "offline fixture" }],
						max_tokens: 16,
					}),
				});
				const response = await handleProxy(request, new URL(request.url), ctx);
				expect(response.status).toBe(200);
				expect((await response.json()).model).toBe(expectedModels[index]);
				const meta = select.mock.calls[index]?.[1] as RequestMeta;
				expect(meta.clientSessionId).toBe(sessionId);
				expect(meta.comboName).toBe(combo.name);
				expect(meta.routingCandidateCatalog).toHaveLength(4);
				expect(
					meta.routingCandidateCatalog?.filter(
						(candidate) => candidate.tier === 0,
					),
				).toHaveLength(2);
				expect(meta.routingCandidates?.[0]?.modelOverride).toBe(
					expectedModels[index],
				);
				expect(getServedAccountObservation(sessionId)).toMatchObject({
					accountId: calls[index].account,
					models: {
						requestedModel: "claude-fable-5",
						appliedModel: expectedModels[index],
						upstreamModel: expectedModels[index],
					},
				});
				expect(handleStart.mock.calls[index]?.[0]).toMatchObject({
					originalModel: index === 1 ? "claude-fable-5" : null,
					appliedModel: index === 1 ? expectedModels[index] : null,
					comboName: combo.name,
					clientSessionId: sessionId,
				});
			}
			expect(calls.map((call) => call.model)).toEqual(expectedModels);
			expect(calls[2].account).toBe(calls[0].account);
			const firstMeta = select.mock.calls[0]?.[1] as RequestMeta;
			const finalMeta = select.mock.calls[2]?.[1] as RequestMeta;
			expect(strategy.snapshotAffinityOwner(finalMeta)).toEqual({
				candidateId: firstMeta.routingCandidates?.[0]?.candidateId,
				accountId: calls[0].account,
			});
			expect(handleStart.mock.calls[1]?.[0]).toMatchObject({
				comboModelOverrideFrom: "claude-fable-5",
				comboModelOverrideTo: "claude-opus-4-8",
			});
		} finally {
			clearSession(sessionId);
			select.mockRestore();
			restore();
		}
	});

	it("uses Opus B despite shared exhaustion on A without dropping request attribution", async () => {
		const { accounts, ctx, restore, calls, handleStart } = nativePool();
		putUsage(accounts[0], 51, 100);
		putUsage(accounts[1], 100, 20);
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const request = input as Request;
			calls.push({
				account: new URL(request.url).pathname.split("/").at(-1) ?? "",
				model: ((await request.clone().json()) as { model: string }).model,
			});
			return new Response(
				'{"type":"message","model":"claude-opus-4-8","content":[]}',
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[1].id, model: "claude-opus-4-8" },
			]);
			expect(handleStart.mock.calls[0]?.[0]).toMatchObject({
				appliedModel: "claude-opus-4-8",
				comboModelOverrideFrom: "claude-fable-5",
				comboModelOverrideTo: "claude-opus-4-8",
			});
		} finally {
			restore();
		}
	});

	it("blocks destination drift introduced while preparing a native request", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				for (const account of accounts)
					account.custom_endpoint = "https://unrelated.example/v1/messages";
				return request;
			},
		});
		const transport = mock(async () => {
			throw new Error("drifted native route must not dispatch");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			restore();
		}
	});

	it("reports pre-header transport failures as temporary native overload without unlocking Opus", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const request = input as Request;
			calls.push({
				account: new URL(request.url).pathname.split("/").at(-1) ?? "",
				model: ((await request.clone().json()) as { model: string }).model,
			});
			throw new Error("offline connection reset before response");
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(calls.map((call) => call.model)).toEqual([
				"claude-fable-5",
				"claude-fable-5",
			]);
			expect(response.status).toBe(529);
			expect(await response.json()).toMatchObject({
				error: {
					type: "overloaded_error",
					code: "native_route_temporarily_unavailable",
				},
			});
		} finally {
			restore();
		}
	});

	it("allows a configured same-family native model mapping", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) {
			putUsage(account, 20);
			account.model_mappings = JSON.stringify({
				"claude-fable-5": "claude-fable-5-20260901",
			});
		}
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				const body = await request.json();
				return new Request(request, {
					body: JSON.stringify({ ...body, model: "claude-fable-5-20260901" }),
				});
			},
		});
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: accounts[0].id,
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls.map((call) => call.model)).toEqual([
				"claude-fable-5-20260901",
			]);
		} finally {
			restore();
		}
	});

	it("snaps back to recovered Fable when quota changes while preparing Opus", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 100);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				for (const account of accounts) putUsage(account, 0);
				return request;
			},
		});
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[0].id, model: "claude-fable-5" },
			]);
		} finally {
			restore();
		}
	});

	it("honors cancellation during request preparation without sending or quota retry", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		const cancellation = new AbortController();
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				cancellation.abort();
				return request;
			},
		});
		const transport = mock(async () => {
			throw new Error("cancelled fixture must not send");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = new Request(makeProxyRequest("claude-fable-5", false), {
				signal: cancellation.signal,
			});
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(499);
			expect(transport).not.toHaveBeenCalled();
			expect(response.headers.get("x-should-retry")).toBeNull();
		} finally {
			restore();
		}
	});

	it("does not authorize Opus after generic windowless primary 429s", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response(
				'{"type":"error","error":{"type":"rate_limit_error","message":"busy"}}',
				{ status: 429, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(calls.map((call) => call.model)).toEqual([
				"claude-fable-5",
				"claude-fable-5",
			]);
			expect([429, 529]).toContain(response.status);
		} finally {
			restore();
		}
	});

	it("returns a structural nonretrying terminal when every configured account is paused", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) {
			account.paused = true;
			putUsage(account, 100, 100);
		}
		const transport = mock(async () => {
			throw new Error("paused fixture must not send");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
			expect(response.headers.get("x-should-retry")).toBeNull();
		} finally {
			restore();
		}
	});

	it("retains native ownership when the account read fails with passthrough enabled", async () => {
		const { ctx, restore } = nativePool();
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("offline account database failure");
		});
		const previous = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		const transport = mock(async () => {
			throw new Error(
				"native account read failure cannot authorize passthrough",
			);
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			restore();
			if (previous === undefined)
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previous;
		}
	});

	it("does not deliver a retained retryable response after native destination drift", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				if (request.url.endsWith(accounts[1].id))
					accounts[1].custom_endpoint = "https://unrelated.example";
				return request;
			},
		});
		const transport = mock(
			async () =>
				new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBeNull();
			expect(response.headers.get("x-should-retry")).toBeNull();
		} finally {
			restore();
		}
	});

	it("can retry a recovered primary that was vetoed before its first physical send", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		let firstPreparation = true;
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				if (firstPreparation && request.url.endsWith(accounts[0].id)) {
					firstPreparation = false;
					putUsage(accounts[0], 20, 100);
				}
				return request;
			},
		});
		globalThis.fetch = mock(async (input: Request) => {
			const id = new URL(input.url).pathname.split("/").at(-1) ?? "";
			calls.push({ account: id, model: (await input.clone().json()).model });
			if (id === accounts[1].id) {
				putUsage(accounts[0], 20);
				putUsage(accounts[1], 100);
				return new Response(
					'{"type":"error","error":{"type":"rate_limit_error"}}',
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[1].id, model: "claude-fable-5" },
				{ account: accounts[0].id, model: "claude-fable-5" },
			]);
		} finally {
			restore();
		}
	});

	it("does not turn generic primary failures into Opus or unrelated-provider fallback", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		const unrelated = makeOpenRouterAccount("native-unrelated");
		ctx.dbOps.getAllAccounts = mock(async () => [...accounts, unrelated]);
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const request = input as Request;
			calls.push({
				account: new URL(request.url).pathname.split("/").at(-1) ?? "",
				model: ((await request.clone().json()) as { model: string }).model,
			});
			return new Response(
				'{"type":"error","error":{"type":"invalid_request_error","message":"invalid fixture"}}',
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(calls.length).toBeGreaterThan(0);
			expect(
				calls.every(
					(call) =>
						call.model === "claude-fable-5" && call.account !== unrelated.id,
				),
			).toBe(true);
			expect(response.status).not.toBe(429);
		} finally {
			restore();
		}
	});

	it("returns native 429 for shared five-hour exhaustion without passthrough or guard authorization", async () => {
		const { accounts, ctx, restore, handleStart } = nativePool();
		for (const account of accounts) putUsage(account, 20, 100);
		const previous = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		const transport = mock(async () => {
			throw new Error("offline transport must remain unused");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({
				type: "error",
				error: { type: "rate_limit_error", code: "native_quota_wait" },
			});
			expect(response.headers.get("x-should-retry")).toBe("true");
			expect(
				Number(response.headers.get("retry-after")),
			).toBeGreaterThanOrEqual(1);
			expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(
				60,
			);
			expect(response.headers.has("x-better-ccflare-pool-status")).toBe(false);
			expect(response.headers.has("x-better-ccflare-recovery-scope")).toBe(
				false,
			);
			expect(
				handleStart.mock.calls.some(
					(call) =>
						(call[0] as { responseStatus?: number; accountId?: string | null })
							?.responseStatus === 429 &&
						(call[0] as { accountId?: string | null })?.accountId === null,
				),
			).toBe(true);
		} finally {
			restore();
			if (previous === undefined)
				delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
			else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = previous;
		}
	});

	it("uses only B's Opus when A is shared-blocked and B has proven Fable exhaustion", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		putUsage(accounts[0], 20, 100);
		putUsage(accounts[1], 100);
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[1].id, model: "claude-opus-4-8" },
			]);
		} finally {
			restore();
		}
	});

	it("keeps usable Fable first even when a custom strategy reverses its inputs", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		putUsage(accounts[0], 20);
		putUsage(accounts[1], 100);
		ctx.strategy.select = mock(async (candidates: Account[]) =>
			[...candidates].reverse(),
		);
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[0].id, model: "claude-fable-5" },
			]);
		} finally {
			restore();
		}
	});

	it("rechecks quota after provider transformation before the physical send", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 100);
		const provider = makeMockRoutingProvider("anthropic");
		provider.buildUrl = (_path, _search, account) =>
			`https://api.anthropic.com/offline/${account?.id}`;
		provider.transformRequestBody = async (request) => {
			for (const account of accounts) putUsage(account, 100, 100);
			return request;
		};
		registerProvider(provider);
		const transport = mock(async () => {
			throw new Error("quota changed before physical send");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect(response.status).toBe(429);
		} finally {
			restore();
		}
	});

	it("returns an honest native 529 after offline transport failures without unlocking Opus", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			throw new TypeError("fetch failed: offline fixture");
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(529);
			expect(await response.json()).toMatchObject({
				error: { type: "overloaded_error" },
			});
			expect(calls.map((call) => call.model)).toEqual([
				"claude-fable-5",
				"claude-fable-5",
			]);
			expect(response.headers.has("x-better-ccflare-pool-status")).toBe(false);
		} finally {
			restore();
		}
	});

	it.each([
		401, 402, 400,
	])("does not let a retained native 529 conceal a later permanent %s failure", async (permanentStatus) => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			parseRateLimit: (response) => ({
				isRateLimited: response.status === 529,
				resetTime: Date.now() + 10_000,
			}),
		});
		globalThis.fetch = mock(async (input: Request) => {
			const id = new URL(input.url).pathname.split("/").at(-1) ?? "";
			calls.push({ account: id, model: (await input.clone().json()).model });
			const status = id === accounts[0].id ? 529 : permanentStatus;
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type:
							status === 529
								? "overloaded_error"
								: status === 401
									? "authentication_error"
									: "invalid_request_error",
						message:
							status === 402 ? "Credit balance is too low" : "offline fixture",
					},
				}),
				{ status, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(new Set(calls.map((call) => call.account)).size).toBe(2);
			expect(calls.every((call) => call.model === "claude-fable-5")).toBe(true);
			expect([429, 529]).not.toContain(response.status);
			expect(response.headers.get("x-should-retry")).not.toBe("true");
		} finally {
			restore();
		}
	});

	it("does not turn persisted reauthentication failure plus exhausted usage into quota retries", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) {
			account.requires_reauth = true;
			putUsage(account, 20, 100);
			usageCache.markModelScopedExhausted(account.id, "claude-fable-5");
		}
		const transport = mock(async () => {
			throw new Error("auth-blocked fixture");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect([429, 529]).not.toContain(response.status);
			expect(response.headers.get("x-should-retry")).not.toBe("true");
		} finally {
			restore();
		}
	});

	it("does not synthesize capacity retry from a persisted billing cooldown", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) {
			putUsage(account, 20);
			account.rate_limited_until = Date.now() + 60_000;
			account.rate_limited_reason = "out_of_credits";
			usageCache.markModelScopedExhausted(account.id, "claude-fable-5");
		}
		const transport = mock(async () => {
			throw new Error("billing-blocked offline fixture");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(transport).not.toHaveBeenCalled();
			expect([429, 529]).not.toContain(response.status);
			expect(response.headers.has("x-better-ccflare-pool-status")).toBe(false);
		} finally {
			restore();
		}
	});

	it("stops after client cancellation without sending another native route", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		const controller = new AbortController();
		const transport = mock(async () => {
			controller.abort();
			throw new DOMException("offline caller cancelled", "AbortError");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = new Request(makeProxyRequest("claude-fable-5", false), {
				signal: controller.signal,
			});
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(499);
			expect(transport).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it("does not replay an already delivered partial native stream", async () => {
		const { accounts, ctx, restore } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		const provider = makeMockRoutingProvider("anthropic");
		provider.buildUrl = (_path, _search, account) =>
			`https://api.anthropic.com/offline/${account?.id}`;
		provider.isStreamingResponse = () => true;
		registerProvider(provider);
		let streamController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
		const transport = mock(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								new TextEncoder().encode(
									'event: message_start\ndata: {"type":"message_start","message":{"id":"offline-message","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"already delivered"}}\n\n',
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-fable-5",
					stream: true,
					messages: [{ role: "user", content: "offline stream" }],
					max_tokens: 16,
				}),
			});
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(200);
			if (!response.body || !streamController)
				throw new Error("Expected a streaming response fixture");
			const reader = response.body.getReader();
			const first = await reader.read();
			expect(first.done).toBe(false);
			streamController.error(
				new TypeError("offline stream interruption after delivery"),
			);
			try {
				while (!(await reader.read()).done) {
					/* Drain the already committed stream. */
				}
			} catch {
				/* Transport failure cannot authorize replay. */
			}
			expect(transport).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it("keeps the existing physical attempt ceiling for a large opted-in native pool", async () => {
		const { accounts, combo, ctx, restore } = nativePool();
		const template = accounts[0];
		accounts.splice(
			0,
			accounts.length,
			...Array.from({ length: 34 }, (_, index) => ({
				...template,
				id: `native-budget-${index}`,
				name: `native-budget-${index}`,
			})),
		);
		combo.slots = accounts.map((account, index) => ({
			id: `native-budget-slot-${index}`,
			combo_id: combo.id,
			account_id: account.id,
			model: "claude-fable-5",
			priority: 0,
			enabled: true,
		}));
		for (const account of accounts) putUsage(account, 20);
		const transport = mock(async () => {
			throw new TypeError("offline transport unavailable");
		});
		globalThis.fetch = transport as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: { code: "physical_attempt_budget_exhausted" },
			});
			expect(transport).toHaveBeenCalledTimes(32);
		} finally {
			restore();
		}
	});

	it.each([
		false,
		true,
	])("missing overage needs authoritative native family rejection before Opus: %s", async (authoritative) => {
		const { accounts, ctx, restore, calls } = nativePool();
		const withoutOverage = (account: Account, percent: number) => {
			putUsage(account, percent);
			const snapshot = usageCache.getSnapshot(account.id);
			if (!snapshot) throw new Error("Expected cached native usage fixture");
			const data = { ...snapshot.data } as Record<string, unknown>;
			delete data.spend;
			usageCache.set(account.id, data as never);
		};
		for (const account of accounts) withoutOverage(account, 20);
		globalThis.fetch = mock(async (input: Request) => {
			const id = new URL(input.url).pathname.split("/").at(-1) ?? "";
			const model = (await input.clone().json()).model;
			calls.push({ account: id, model });
			if (model === "claude-fable-5") {
				const matched = accounts.find((account) => account.id === id);
				if (!matched) throw new Error("Unknown native account fixture");
				withoutOverage(matched, 100);
				return new Response(
					'{"type":"error","error":{"type":"rate_limit_error"}}',
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							...(authoritative
								? {
										"anthropic-ratelimit-unified-7d-status": "rejected",
										"anthropic-ratelimit-unified-reset": String(
											Math.floor(Date.now() / 1000) + 600,
										),
									}
								: {}),
						},
					},
				);
			}
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(calls.map((call) => call.model)).toEqual(
				authoritative
					? ["claude-fable-5", "claude-fable-5", "claude-opus-4-8"]
					: ["claude-fable-5", "claude-fable-5"],
			);
			if (authoritative) expect(response.status).toBe(200);
		} finally {
			restore();
		}
	});

	it("revisits recovered Fable when deferred Opus preparation occurs after the primary wave", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 100);
		ctx.strategy.select = mock(async () => []);
		registerProvider({
			...makeMockRoutingProvider("anthropic"),
			buildUrl: (_path, _search, account) =>
				`https://api.anthropic.com/offline/${account?.id}`,
			transformRequestBody: async (request) => {
				putUsage(accounts[0], 20);
				return request;
			},
		});
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[0].id, model: "claude-fable-5" },
			]);
		} finally {
			restore();
		}
	});

	it("retains usable primary routes when the strategy suppresses the primary wave", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		putUsage(accounts[0], 20);
		putUsage(accounts[1], 100);
		ctx.strategy.select = mock(async () => []);
		globalThis.fetch = mock(async (input: Request) => {
			calls.push({
				account: new URL(input.url).pathname.split("/").at(-1) ?? "",
				model: (await input.clone().json()).model,
			});
			return new Response('{"type":"message","content":[]}', {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			expect(
				(await handleProxy(request, new URL(request.url), ctx)).status,
			).toBe(200);
			expect(calls).toEqual([
				{ account: accounts[0].id, model: "claude-fable-5" },
			]);
		} finally {
			restore();
		}
	});

	it("admits configured Opus after every primary gains authoritative family evidence during this request", async () => {
		const { accounts, ctx, restore, calls } = nativePool();
		for (const account of accounts) putUsage(account, 20);
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const request = input as Request;
			const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
			const model = ((await request.clone().json()) as { model: string }).model;
			calls.push({ account: id, model });
			if (model === "claude-fable-5") {
				const account = accounts.find((candidate) => candidate.id === id);
				if (!account) throw new Error("Unknown native account fixture");
				putUsage(account, 100);
				return new Response(
					'{"type":"error","error":{"type":"rate_limit_error"}}',
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				'{"type":"message","model":"claude-opus-4-8","content":[]}',
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const request = makeProxyRequest("claude-fable-5", false);
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(response.status).toBe(200);
			expect(calls.map((call) => call.model)).toEqual([
				"claude-fable-5",
				"claude-fable-5",
				"claude-opus-4-8",
			]);
			expect(
				new Set(calls.map((call) => `${call.account}:${call.model}`)).size,
			).toBe(calls.length);
		} finally {
			restore();
		}
	});
});
