// Issue #324: preserve a Responses physical model through implicit admission
// and the Codex wire transform even when Claude family mappings differ.
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	usageCache,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import {
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	getCodexModels,
	getKnownCodexModels,
} from "../codex-model-catalog";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers";
import {
	isImplicitCodexDiscoveryEligible,
	selectAccountsForRequest,
} from "../handlers/account-selector";
import { RESPONSES_ADAPTER_SECRET_HEADER } from "../handlers/proxy-types";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";
import { handleProxy } from "../proxy";
import type { UsageCollector } from "../usage-collector";
import * as usageCollectorModule from "../usage-collector";

// This is the alias produced by the Responses translator for gpt-6-astra.
const CLAUDE_SONNET_5 = "claude-sonnet-5";
const ADAPTER_SECRET = "implicit-regression-process-secret";
const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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
	} as Account;
}

// The incident's account mappings send Sonnet to Sol, but Opus/Fable to Astra.
function makeCodexAccount(overrides: Partial<Account> = {}) {
	return makeAccount({
		id: "codex-1",
		provider: "codex",
		refresh_token: "codex-rt",
		model_mappings: JSON.stringify({
			opus: "gpt-6-astra",
			fable: "gpt-6-astra",
			sonnet: "gpt-5.6-sol",
			haiku: "gpt-5.6-terra",
		}),
		...overrides,
	});
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		routeLineage: { kind: "root", childHomeKey: null },
	};
}

function makeCtx(opts: { accounts: Account[]; forceAccountModel?: boolean }) {
	const strategySelect = mock((accounts: Account[]) => accounts);
	const anthropicDegradedMode = new AnthropicDegradedModeCoordinator({
		config: { mode: "off" },
	});
	return {
		strategy: { select: strategySelect },
		anthropicDegradedMode,
		degradedOwnerOverlay: new DegradedOwnerOverlay({
			evidenceWindowMs: anthropicDegradedMode.config.evidenceWindowMs,
		}),
		dbOps: {
			getAllAccounts: async () => opts.accounts,
			getActiveComboForFamily: async () => null,
			getAgentPreference: async () => null,
			getAccount: async (id: string) =>
				opts.accounts.find((account) => account.id === id) ?? null,
		},
		refreshInFlight: new Map(),
		internalProbeSecret: ADAPTER_SECRET,
		asyncWriter: { enqueue: () => {} },
		runtime: { port: 8080, clientId: "implicit-regression" },
		config: {
			getForceAccountModel: () => opts.forceAccountModel ?? false,
			getCombosEnabled: () => true,
			getCodexImplicitRouteEnabled: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider: {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: (path: string, search: string, account?: Account) =>
				`https://upstream.test/${account?.id ?? "anonymous"}${path}${search}`,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
	} as unknown as ProxyContext & {
		strategy: { select: typeof strategySelect };
	};
}

function makeOrdinaryDecoy(): Account {
	// If the selector loses its implicit capability gate this ordinary provider
	// enters the candidate pool ahead of the Codex account.
	return makeAccount({
		id: "ordinary-decoy",
		provider: "test-provider" as Account["provider"],
		api_key: "fake-decoy-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
	});
}

function installUpstream() {
	const requests: Request[] = [];
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			if (new URL(request.url).pathname.endsWith("/models")) {
				return Response.json({
					models: [
						{
							slug: "gpt-6-astra",
							display_name: "Astra",
							visibility: "list",
							priority: 1,
						},
					],
				});
			}
			requests.push(request.clone());
			if (new URL(request.url).pathname.endsWith("/responses")) {
				return new Response(
					`event: response.completed\ndata: ${JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp-implicit-regression",
							object: "response",
							status: "completed",
							model: "gpt-6-astra",
							output: [],
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return Response.json({
				id: "msg-ordinary-regression",
				type: "message",
				role: "assistant",
				content: [],
			});
		},
	) as unknown as typeof fetch;
	return requests;
}

async function proxyModel(
	ctx: ProxyContext,
	model: string,
	physicalModel?: string,
	options: {
		headers?: Record<string, string>;
		signal?: AbortSignal;
		status?: number;
	} = {},
) {
	const request = new Request("https://proxy.test/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(physicalModel
				? {
						[RESPONSES_ADAPTER_SECRET_HEADER]: ADAPTER_SECRET,
						"x-better-ccflare-exclude-providers": "anthropic-oauth",
					}
				: {}),
			...options.headers,
		},
		signal: options.signal,
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			...(physicalModel
				? { __better_ccflare_codex_passthrough: { model: physicalModel } }
				: {}),
		}),
	});
	const response = await handleProxy(request, new URL(request.url), ctx, "key");
	// Drain response processing before restoring shared spies and fetch.
	const responseBody = await response.text();
	expect(response.status, responseBody).toBe(options.status ?? 200);
	return { response, body: responseBody };
}

async function expectCodexWireRequest(requests: Request[]) {
	expect(requests).toHaveLength(1);
	expect(new URL(requests[0].url).pathname).toEndWith("/codex/responses");
	expect(await requests[0].json()).toMatchObject({ model: "gpt-6-astra" });
}

describe("issue #324 — Codex CLI physical model implicit route", () => {
	beforeEach(() => {
		usageCache.clear();
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
		const collector = {
			handleStart: () => undefined,
			handleChunk: () => undefined,
			handleEnd: async () => undefined,
		} as unknown as UsageCollector;
		const getSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(collector);
		const tryGetSpy = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue(collector);
		restoreUsageCollector = () => {
			getSpy.mockRestore();
			tryGetSpy.mockRestore();
		};
	});

	afterEach(() => {
		usageCache.clear();
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
		restoreUsageCollector();
		globalThis.fetch = originalFetch;
	});

	it("A: the carrier restores physical admission and the raw wire model despite a different sonnet mapping", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [makeOrdinaryDecoy(), codex] });
		const requests = installUpstream();

		await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");

		expect(
			ctx.strategy.select.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual(["codex-1"]);
		await expectCodexWireRequest(requests);
	});

	it("B: the same account is admitted when the adapter carries the physical id straight through", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [makeOrdinaryDecoy(), codex] });
		const requests = installUpstream();

		await proxyModel(ctx, "gpt-6-astra", "gpt-6-astra");

		expect(
			ctx.strategy.select.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual(["codex-1"]);
		await expectCodexWireRequest(requests);
	});

	it("C (control): an ordinary Claude family request keeps its ordinary Claude account", async () => {
		const claude = makeAccount({ id: "claude-1", provider: "anthropic" });
		const ctx = makeCtx({ accounts: [claude] });
		const requests = installUpstream();

		await proxyModel(ctx, CLAUDE_SONNET_5);

		expect(
			ctx.strategy.select.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual(["claude-1"]);
		expect(requests).toHaveLength(1);
		expect(await requests[0].json()).toMatchObject({ model: CLAUDE_SONNET_5 });
	});

	it("D: an account's primed catalog admits the physical id even when all its mappings differ", async () => {
		const codex = makeCodexAccount({
			model_mappings: JSON.stringify({
				opus: "gpt-5.6-sol",
				sonnet: "gpt-5.6-sol",
			}),
		});
		const ctx = makeCtx({ accounts: [makeOrdinaryDecoy(), codex] });
		const requests = installUpstream();
		const listing = await getCodexModels(codex.id, ctx);
		expect(listing?.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);

		await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");

		expect(
			ctx.strategy.select.mock.calls[0]?.[0].map((account) => account.id),
		).toEqual(["codex-1"]);
		await expectCodexWireRequest(requests);
	});

	it.each([
		["Sol", "gpt-5.6-sol"],
		["Astra then Sol", ["gpt-6-astra", "gpt-5.6-sol"]],
		["Sol then Astra", ["gpt-5.6-sol", "gpt-6-astra"]],
	])("discovers cold Astra capacity when a cached Astra account maps the physical id to %s", async (_label, mapping) => {
		const known = makeCodexAccount({
			model_mappings: JSON.stringify({ "gpt-6-astra": mapping }),
		});
		const cold = makeCodexAccount({
			id: "cold-astra",
			model_mappings: null,
			access_token: "cold-astra-token",
		});
		const ctx = makeCtx({ accounts: [known, cold] });
		const requests = installUpstream();
		const listing = await getCodexModels(known.id, ctx);
		expect(listing?.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
		expect(getKnownCodexModels(cold.id)).toBeNull();

		for (let attempt = 0; attempt < 2; attempt++) {
			await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");
			await expectCodexWireRequest(requests.slice(attempt));
			expect(
				ctx.strategy.select.mock.calls[attempt]?.[0].map(
					(account) => account.id,
				),
			).toEqual([cold.id]);
			expect(requests[attempt].headers.get("authorization")).toBe(
				`Bearer ${cold.access_token}`,
			);
		}
		expect(
			getKnownCodexModels(cold.id)?.models.map((model) => model.id),
		).toEqual(["gpt-6-astra"]);
	});

	it.each([
		null,
		JSON.stringify({ "gpt-6-astra": "gpt-6-astra" }),
		JSON.stringify({ "gpt-6-astra": [" gpt-6-astra ", "gpt-6-astra"] }),
	])("uses cached Astra capacity without priming a cold account for a compatible mapping (%s)", async (modelMappings) => {
		const known = makeCodexAccount({ model_mappings: modelMappings });
		const cold = makeCodexAccount({
			id: "unneeded-cold",
			model_mappings: null,
		});
		const ctx = makeCtx({ accounts: [known, cold] });
		const requests = installUpstream();
		await getCodexModels(known.id, ctx);

		await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");

		await expectCodexWireRequest(requests);
		expect(requests[0].headers.get("authorization")).toBe(
			`Bearer ${known.access_token}`,
		);
		expect(getKnownCodexModels(cold.id)).toBeNull();
	});

	it.each([
		["codex", true],
		["test-provider", false],
	] as const)("evaluates prospective %s route eligibility without mutating request metadata or inventing support", (provider, eligible) => {
		const account = makeCodexAccount({
			provider: provider as Account["provider"],
			model_mappings: null,
		});
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();
		const original = { ...meta };
		Object.freeze(meta);

		expect(
			isImplicitCodexDiscoveryEligible(account, meta, ctx, "gpt-6-astra"),
		).toBe(eligible);
		expect(meta).toEqual(original);
		expect(getKnownCodexModels(account.id)).toBeNull();
	});

	it.each([
		true,
		false,
	])("dispatches the mapped account without priming a stalled cold account (paused=%s)", async (paused) => {
		const healthy = makeCodexAccount();
		const cold = makeCodexAccount({
			id: "cold-codex",
			model_mappings: null,
			paused,
		});
		const ctx = makeCtx({ accounts: [cold, healthy] });
		const requests = installUpstream();
		const lookup = Promise.withResolvers<Account | null>();
		let coldReads = 0;
		ctx.dbOps.getAccount = async (id) => {
			if (id === cold.id) {
				coldReads++;
				return lookup.promise;
			}
			return healthy;
		};
		const previous = process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
		process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = "100";
		try {
			await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");
			expect(coldReads).toBe(0);
			expect(
				ctx.strategy.select.mock.calls[0]?.[0].map((account) => account.id),
			).toEqual([healthy.id]);
			await expectCodexWireRequest(requests);
		} finally {
			lookup.resolve(null);
			if (coldReads > 0) await ensureCodexModelDefaults(cold, ctx);
			if (previous === undefined)
				delete process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS;
			else process.env.CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS = previous;
		}
	});

	it.each([
		"hard quota",
		"reactive depletion",
		"predictive throttle",
		"profile only",
	])("discovers eligible cold capacity when the known account is blocked by %s", async (blocker) => {
		const known = makeCodexAccount();
		const cold = makeCodexAccount({
			id: "cold-capacity",
			model_mappings: null,
			access_token: "cold-token",
		});
		const ctx = makeCtx({ accounts: [known, cold] });
		const requests = installUpstream();
		if (blocker === "profile only") {
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
				parseModelRouteProfiles(
					JSON.stringify([
						{
							id: "reserved",
							displayName: "Reserved",
							accountId: known.id,
							logicalModel: CLAUDE_SONNET_5,
							expectedProvider: "codex",
							exclusiveAccount: true,
						},
					]),
				),
			);
		} else if (blocker === "reactive depletion") {
			usageCache.markModelScopedExhausted(
				known.id,
				"gpt-6-astra",
				"",
				Date.now() + 60_000,
			);
		} else {
			usageCache.set(known.id, {
				seven_day: { utilization: 0, resets_at: null },
				five_hour: {
					utilization: blocker === "hard quota" ? 100 : 80,
					resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
				},
			} as never);
			ctx.config.getUsageThrottlingFiveHourEnabled = () =>
				blocker === "predictive throttle";
		}
		await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra");
		await expectCodexWireRequest(requests);
		expect(
			getKnownCodexModels(cold.id)?.models.map((model) => model.id),
		).toEqual(["gpt-6-astra"]);
		expect(requests[0].headers.get("authorization")).toBe(
			`Bearer ${cold.access_token}`,
		);
	});

	it.each([
		"provider exclusion",
		"force conflict",
		"profile only",
	])("never primes an ineligible cold account for %s", async (reason) => {
		const cold = makeCodexAccount({
			id: "ineligible-cold",
			model_mappings: null,
		});
		const ctx = makeCtx({ accounts: [cold] });
		const requests = installUpstream();
		const reads = mock(async () => cold);
		ctx.dbOps.getAccount = reads;
		if (reason === "profile only") {
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
				parseModelRouteProfiles(
					JSON.stringify([
						{
							id: "reserved",
							displayName: "Reserved",
							accountId: cold.id,
							logicalModel: CLAUDE_SONNET_5,
							expectedProvider: "codex",
							exclusiveAccount: true,
						},
					]),
				),
			);
		}
		await proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra", {
			status: 503,
			headers:
				reason === "provider exclusion"
					? { "x-better-ccflare-exclude-providers": "codex" }
					: reason === "force conflict"
						? { "x-better-ccflare-account-id": cold.id }
						: {},
		});
		expect(reads).toHaveBeenCalledTimes(0);
		expect(requests).toHaveLength(0);
	});

	it.each([
		"already aborted",
		"aborted after lookup",
		"expired after lookup",
	])("never primes or dispatches an %s selection", async (state) => {
		const known = makeCodexAccount();
		const cold = makeCodexAccount({
			id: "cancelled-cold",
			model_mappings: null,
		});
		const ctx = makeCtx({ accounts: [known, cold] });
		const requests = installUpstream();
		const reads = mock(async () => cold);
		ctx.dbOps.getAccount = reads;
		const controller = new AbortController();
		const reason = new DOMException("client left", "AbortError");
		let now = Date.now();
		const clockSpy = spyOn(Date, "now").mockImplementation(() => now);
		ctx.dbOps.getAllAccounts = async () => {
			if (state === "expired after lookup") now += 100_000;
			else controller.abort(reason);
			return [known, cold];
		};
		if (state === "already aborted") controller.abort(reason);
		try {
			const result = proxyModel(ctx, CLAUDE_SONNET_5, "gpt-6-astra", {
				signal: controller.signal,
				status: 503,
			});
			if (state === "expired after lookup") {
				expect(JSON.parse((await result).body)).toMatchObject({
					error: {
						routing_diagnostics: { zero_attempt_reason: "selection_timeout" },
					},
				});
			} else {
				await expect(result).rejects.toBe(reason);
			}
			expect(reads).toHaveBeenCalledTimes(0);
			expect(ctx.strategy.select).toHaveBeenCalledTimes(0);
			expect(requests).toHaveLength(0);
		} finally {
			clockSpy.mockRestore();
		}
	});

	it("E: an unprimed Codex catalog fails closed for a made-up physical id under forceAccountModel", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [codex], forceAccountModel: true });

		// No getCodexModels() call — getKnownCodexModels("codex-1") is null here.
		const result = await selectAccountsForRequest(
			makeRequestMeta() as never,
			ctx as never,
			"gpt-totally-made-up-model-id",
		);

		expect(result).toEqual([]);
	});
});
