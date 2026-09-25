import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Config,
	filterEnabledProviderModelDefaultOverrides,
} from "@better-ccflare/config";
import {
	clearDerivedProviderModelDefaults,
	getProviderModelDefaultOverrides,
	resolveProviderModelDefault,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import {
	CODEX_CLIENT_VERSION_ENV,
	resolveCodexRequestModel,
} from "@better-ccflare/providers/codex";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
	type ProxyContext,
} from "@better-ccflare/proxy";
import type { Account, APIContext } from "@better-ccflare/types";
import { createConfigHandlers } from "../config";

function makeCatalog(
	models: string[],
	source: "live" | "fallback" = "live",
): APIContext["modelCatalog"] {
	return {
		get: async () => ({
			models: models.map((id) => ({ id, displayName: id, createdAt: null })),
			fetchedAt: Date.now(),
			source,
		}),
		refresh: async () => ({ success: true }),
	};
}

function makeConfig() {
	return {
		getAllSettings: () => ({
			lb_strategy: "session",
			port: 8080,
			sessionDurationMs: 18_000_000,
			default_agent_model: "sonnet",
			system_prompt_cache_ttl_1h: false,
			usage_throttling_five_hour_enabled: true,
			usage_throttling_weekly_enabled: true,
		}),
		getSystemPromptCacheTtl1h: () => false,
		getUsageThrottlingFiveHourEnabled: () => true,
		getUsageThrottlingWeeklyEnabled: () => true,
		setUsageThrottlingFiveHourEnabled: mock(() => {}),
		setUsageThrottlingWeeklyEnabled: mock(() => {}),
		getStrategy: () => "session",
		getStrategySource: () => "default" as const,
		setStrategy: mock(() => {}),
		getDefaultAgentModel: () => "sonnet",
		setDefaultAgentModel: mock(() => {}),
		getDataRetentionDays: () => 3,
		getRequestRetentionDays: () => 90,
		getStorePayloads: () => true,
		setDataRetentionDays: mock(() => {}),
		setRequestRetentionDays: mock(() => {}),
		setStorePayloads: mock(() => {}),
		getCacheKeepaliveTtlMinutes: () => 0,
		setCacheKeepaliveTtlMinutes: mock(() => {}),
		setSystemPromptCacheTtl1h: mock(() => {}),
	} as unknown as import("@better-ccflare/config").Config;
}

describe("createConfigHandlers", () => {
	it("includes per-window usage throttling flags in config payload", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getConfig();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.usage_throttling_five_hour_enabled).toBe(true);
		expect(body.usage_throttling_weekly_enabled).toBe(true);
	});

	it("updates usage throttling windows from POST body", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setUsageThrottling(
			new Request("http://localhost/api/config/usage-throttling", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					fiveHourEnabled: false,
					weeklyEnabled: true,
				}),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setUsageThrottlingFiveHourEnabled).toHaveBeenCalledWith(
			false,
		);
		expect(config.setUsageThrottlingWeeklyEnabled).toHaveBeenCalledWith(true);
	});

	it("reports the current strategy with its source", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getStrategy();
		const body = (await response.json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body.strategy).toBe("session");
		expect(body.strategySource).toBe("default");
	});

	it("rejects a default agent model without a recognized Claude family substring", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "totally-not-a-claude-model" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});

	it("accepts a valid Claude model as the default agent model", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-sonnet-5" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(config.setDefaultAgentModel).toHaveBeenCalledWith("claude-sonnet-5");
	});

	it("accepts a non-pattern model id present in a live catalog", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(
			config,
			{ port: 8080, tlsEnabled: false },
			makeCatalog(["claude-nova-9"]),
		);

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(config.setDefaultAgentModel).toHaveBeenCalledWith("claude-nova-9");
	});

	it("rejects a non-pattern model id absent from a fallback catalog with 400", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(
			config,
			{ port: 8080, tlsEnabled: false },
			makeCatalog(["claude-nova-9"], "fallback"),
		);

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});

	it("rejects a non-pattern model id with 400 when no catalog is injected", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});
});

function makeCodexProviderDefaultsConfig(overrides?: {
	enabled?: string[];
	providerOverrides?: Record<string, Record<string, string>>;
}) {
	return {
		getEnabledProviderModelDefaultProviders: () =>
			overrides?.enabled ?? ["codex"],
		getProviderModelDefaultOverrides: () => overrides?.providerOverrides ?? {},
	} as unknown as import("@better-ccflare/config").Config;
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-codex-1",
		name: "codex-account-1",
		provider: "codex",
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
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: true,
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

function makeDbOpsWithAccounts(accounts: Account[]) {
	return {
		getAllAccounts: async () => accounts,
	} as unknown as import("@better-ccflare/database").DatabaseOperations;
}

/**
 * Seed the process-wide override registry exactly as boot does
 * (apps/server/src/server.ts): Config's saved overrides, filtered to the
 * enabled providers. The GET handler only reads that registry — boot and the
 * POST handler own writing it — so a test that relies on an override must
 * establish it the same way production does.
 */
function seedOverrideRegistryLikeBoot(config: Config) {
	setProviderModelDefaultOverrides(
		filterEnabledProviderModelDefaultOverrides(
			config.getEnabledProviderModelDefaultProviders(),
			config.getProviderModelDefaultOverrides(),
		),
	);
}

describe("createConfigHandlers - Codex effective defaults (accounts field)", () => {
	const originalClientVersion = process.env[CODEX_CLIENT_VERSION_ENV];

	beforeEach(() => {
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
	});

	afterEach(() => {
		setProviderModelDefaultOverrides({});
		if (originalClientVersion === undefined) {
			delete process.env[CODEX_CLIENT_VERSION_ENV];
		} else {
			process.env[CODEX_CLIENT_VERSION_ENV] = originalClientVersion;
		}
	});

	it("omits the accounts field (back-compat) when no dbOps is supplied", async () => {
		const handlers = createConfigHandlers(
			makeCodexProviderDefaultsConfig(),
			{ port: 8080, tlsEnabled: false },
			undefined,
		);
		const response = await handlers.getProviderModelDefaults();
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.providers).toBeDefined();
		expect(body.accounts).toBeUndefined();
	});

	it("preserves the existing `providers` field shape byte-for-byte when accounts are added", async () => {
		const config = makeCodexProviderDefaultsConfig();
		const withoutAccounts = await (
			await createConfigHandlers(config, {
				port: 8080,
				tlsEnabled: false,
			}).getProviderModelDefaults()
		).json();
		const withAccounts = await (
			await createConfigHandlers(
				config,
				{ port: 8080, tlsEnabled: false },
				undefined,
				makeDbOpsWithAccounts([makeCodexAccount()]),
			).getProviderModelDefaults()
		).json();
		expect((withAccounts as { providers: unknown }).providers).toEqual(
			(withoutAccounts as { providers: unknown }).providers,
		);
	});

	it("lists each Codex account with a pinned family sourced from its own model_mappings", async () => {
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-pinned" }),
		});
		const handlers = createConfigHandlers(
			makeCodexProviderDefaultsConfig(),
			{ port: 8080, tlsEnabled: false },
			undefined,
			makeDbOpsWithAccounts([account]),
		);
		const body = (await (await handlers.getProviderModelDefaults()).json()) as {
			accounts: Array<{
				accountId: string;
				accountName: string;
				catalog: { source: string; fetchedAt: number | null; stale: boolean };
				families: Array<{
					family: string;
					effectiveModel: string;
					source: string;
					pinned: boolean;
				}>;
			}>;
		};
		expect(body.accounts).toHaveLength(1);
		const [entry] = body.accounts;
		expect(entry.accountId).toBe(account.id);
		expect(entry.accountName).toBe(account.name);
		expect(entry.catalog).toEqual({
			source: "none",
			fetchedAt: null,
			stale: false,
		});
		const opus = entry.families.find((f) => f.family === "opus");
		expect(opus).toEqual({
			family: "opus",
			effectiveModel: "gpt-5.3-codex-pinned",
			source: "account_mapping_pin",
			pinned: true,
		});
		const haiku = entry.families.find((f) => f.family === "haiku");
		expect(haiku?.pinned).toBe(false);
		expect(haiku?.source).toBe("compiled_default");
	});

	it("labels an unmapped family as global_provider_override and flags the unmapped-account pin", async () => {
		const account = makeCodexAccount();
		const config = makeCodexProviderDefaultsConfig({
			providerOverrides: { codex: { opus: "operator-override-model" } },
		});
		seedOverrideRegistryLikeBoot(config);
		const handlers = createConfigHandlers(
			config,
			{ port: 8080, tlsEnabled: false },
			undefined,
			makeDbOpsWithAccounts([account]),
		);
		const body = (await (await handlers.getProviderModelDefaults()).json()) as {
			accounts: Array<{
				families: Array<{
					family: string;
					effectiveModel: string;
					source: string;
					pinned: boolean;
					globalOverridePinsUnmappedAccount?: boolean;
				}>;
			}>;
		};
		const opus = body.accounts[0].families.find((f) => f.family === "opus");
		expect(opus).toEqual({
			family: "opus",
			effectiveModel: "operator-override-model",
			source: "global_provider_override",
			pinned: true,
			globalOverridePinsUnmappedAccount: true,
		});
	});

	it("GET never writes the process-wide override registry, and account attribution follows that registry rather than Config", async () => {
		// The dashboard polls this GET; only boot and the POST handler may write
		// the registry request routing reads. Seed a registry that deliberately
		// disagrees with Config in all three directions: a family both hold with
		// different values (opus), a family only the registry holds (haiku), and a
		// family only Config holds (sonnet).
		const registryBefore = {
			codex: { opus: "registry-opus", haiku: "registry-haiku" },
		};
		setProviderModelDefaultOverrides(registryBefore);
		const account = makeCodexAccount();
		const handlers = createConfigHandlers(
			makeCodexProviderDefaultsConfig({
				providerOverrides: {
					codex: { opus: "config-opus", sonnet: "config-sonnet" },
				},
			}),
			{ port: 8080, tlsEnabled: false },
			undefined,
			makeDbOpsWithAccounts([account]),
		);

		const response = await handlers.getProviderModelDefaults();
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			providers: Array<{
				provider: string;
				fields: Array<{
					family: string;
					override: string | null;
					effective: string;
				}>;
			}>;
			accounts: Array<{
				families: Array<{
					family: string;
					effectiveModel: string;
					source: string;
					pinned: boolean;
					globalOverridePinsUnmappedAccount?: boolean;
				}>;
			}>;
		};

		// The read left the registry exactly as it found it.
		expect(getProviderModelDefaultOverrides()).toEqual(registryBefore);

		// Account attribution reads the same registry resolveCodexRequestModel
		// does, so the label and the effective model always agree.
		const family = (name: string) =>
			body.accounts[0].families.find((entry) => entry.family === name);
		expect(family("opus")).toEqual({
			family: "opus",
			effectiveModel: "registry-opus",
			source: "global_provider_override",
			pinned: true,
			globalOverridePinsUnmappedAccount: true,
		});
		expect(family("haiku")).toEqual({
			family: "haiku",
			effectiveModel: "registry-haiku",
			source: "global_provider_override",
			pinned: true,
			globalOverridePinsUnmappedAccount: true,
		});
		// A Config-only override is not what routing applies, so it must not be
		// reported as the account's global-override pin.
		const sonnet = family("sonnet");
		expect(sonnet?.source).toBe("compiled_default");
		expect(sonnet?.pinned).toBe(false);
		expect(sonnet?.globalOverridePinsUnmappedAccount).toBeUndefined();
		expect(sonnet?.effectiveModel).toBe(
			resolveCodexRequestModel("sonnet", account),
		);
		expect(sonnet?.effectiveModel).not.toBe("config-sonnet");

		// Provider-level fields keep their original semantics: `override` is
		// Config's persisted value, `effective` is the resolver's answer.
		const codex = body.providers.find((entry) => entry.provider === "codex");
		const field = (name: string) =>
			codex?.fields.find((entry) => entry.family === name);
		expect(field("opus")).toMatchObject({
			override: "config-opus",
			effective: "registry-opus",
		});
		expect(field("haiku")).toMatchObject({
			override: null,
			effective: "registry-haiku",
		});
		expect(field("sonnet")).toMatchObject({
			override: "config-sonnet",
			effective: resolveProviderModelDefault("codex", "sonnet") ?? "",
		});
		expect(field("sonnet")?.effective).not.toBe("config-sonnet");
	});

	it("reports an account's own catalog as the source once it has a live listing, with fetchedAt and non-stale freshness", async () => {
		const account = makeCodexAccount({ id: "acc-with-catalog" });
		const ctx = {
			dbOps: { getAccount: async () => account },
			refreshInFlight: new Map(),
		} as unknown as ProxyContext;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json({
				models: [
					{
						slug: "gpt-5.6-sol",
						display_name: "GPT-5.6-Sol",
						visibility: "list",
						priority: 1,
					},
				],
			})) as typeof globalThis.fetch;
		try {
			await getCodexModels(account.id, ctx);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const handlers = createConfigHandlers(
			makeCodexProviderDefaultsConfig(),
			{ port: 8080, tlsEnabled: false },
			undefined,
			makeDbOpsWithAccounts([account]),
		);
		const body = (await (await handlers.getProviderModelDefaults()).json()) as {
			accounts: Array<{
				catalog: { source: string; fetchedAt: number | null; stale: boolean };
				families: Array<{
					family: string;
					effectiveModel: string;
					source: string;
				}>;
			}>;
		};
		const entry = body.accounts[0];
		expect(entry.catalog.source).toBe("own");
		expect(entry.catalog.fetchedAt).toEqual(expect.any(Number));
		expect(entry.catalog.stale).toBe(false);
		const opus = entry.families.find((f) => f.family === "opus");
		expect(opus).toEqual({
			family: "opus",
			effectiveModel: "gpt-5.6-sol",
			source: "account_catalog",
			pinned: false,
		});
	});

	it("does not trigger a catalog fetch from the GET handler", async () => {
		const account = makeCodexAccount();
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("the GET handler must never fetch");
		}) as typeof globalThis.fetch;
		try {
			const handlers = createConfigHandlers(
				makeCodexProviderDefaultsConfig(),
				{ port: 8080, tlsEnabled: false },
				undefined,
				makeDbOpsWithAccounts([account]),
			);
			await handlers.getProviderModelDefaults();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(fetchCalled).toBe(false);
	});

	it("includes safe Codex client identity diagnostics without leaking the verified-version file path", async () => {
		process.env[CODEX_CLIENT_VERSION_ENV] = "9.9.9";
		const handlers = createConfigHandlers(
			makeCodexProviderDefaultsConfig(),
			{ port: 8080, tlsEnabled: false },
			undefined,
			makeDbOpsWithAccounts([]),
		);
		const body = (await (await handlers.getProviderModelDefaults()).json()) as {
			codexClientIdentity: Record<string, unknown>;
		};
		expect(body.codexClientIdentity).toEqual({
			version: "9.9.9",
			source: "explicit",
			fresh: true,
		});
		expect(Object.keys(body.codexClientIdentity).sort()).toEqual(
			["fresh", "source", "version"].sort(),
		);
	});
});

describe("strategy source (real config)", () => {
	const originalEnv = process.env.LB_STRATEGY;
	const tmpDirs: string[] = [];

	function realConfig(): Config {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-handler-"));
		tmpDirs.push(dir);
		return new Config(join(dir, "config.json"));
	}

	function handlersWithRealConfig() {
		return createConfigHandlers(realConfig(), {
			port: 8080,
			tlsEnabled: false,
		});
	}

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.LB_STRATEGY;
		} else {
			process.env.LB_STRATEGY = originalEnv;
		}
		while (tmpDirs.length > 0) {
			rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("reports source 'file' and strategy 'session' for a freshly created config", async () => {
		// loadConfig() eagerly seeds a brand-new config file with
		// `lb_strategy: DEFAULT_STRATEGY`, so a fresh Config already has a valid
		// file value here — unlike model-capacity-routing, "default" is only
		// reachable when the on-disk file predates the lb_strategy field.
		delete process.env.LB_STRATEGY;
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body).toEqual({ strategy: "session", strategySource: "file" });
	});

	it("reports source 'file' after a POST writes the config file", async () => {
		delete process.env.LB_STRATEGY;
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setStrategy(
			new Request("http://localhost/api/config/strategy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strategy: "session-affinity" }),
			}),
		);
		expect(postResponse.status).toBe(200);

		const getBody = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(getBody).toEqual({
			strategy: "session-affinity",
			strategySource: "file",
		});
	});

	it("reports source 'env' and the env strategy when LB_STRATEGY overrides the file", async () => {
		process.env.LB_STRATEGY = "least-used";
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body).toEqual({ strategy: "least-used", strategySource: "env" });
	});

	it("keeps reporting the env-sourced strategy after a POST that writes the (ineffective) file value", async () => {
		process.env.LB_STRATEGY = "least-used";
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setStrategy(
			new Request("http://localhost/api/config/strategy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strategy: "session" }),
			}),
		);
		expect(postResponse.status).toBe(200);

		const getBody = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(getBody).toEqual({ strategy: "least-used", strategySource: "env" });
	});
});
