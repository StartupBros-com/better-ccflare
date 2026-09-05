// Issue #324: preserve a Responses physical model through implicit admission
// and the Codex wire transform even when Claude family mappings differ.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearDerivedProviderModelDefaults } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { CodexProvider } from "../../../providers/src/providers/codex/provider";
import { resolveImplicitCodexRoute } from "../codex-implicit-route";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers";
import { selectAccountsForRequest } from "../handlers/account-selector";
import { RequestBodyContext } from "../request-body-context";

// LATEST_SONNET_MODEL / CLAUDE_MODEL_IDS.SONNET_5 (packages/core/src/models.ts).
// This is what request-translator.ts's mapGptModelToClaudeFamily() produces
// for ANY "gpt-*" model that isn't suffixed -pro/-mini/-nano — including both
// "gpt-6-astra" and "gpt-5.6-sol" from the live incident.
const CLAUDE_SONNET_5 = "claude-sonnet-5";

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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	} as Account;
}

// One of the three live provider=codex ChatGPT Pro accounts: account-level
// modelMappings translate the Claude logical family into a physical Codex
// model id — opus/fable -> gpt-6-astra, sonnet -> gpt-5.6-sol, haiku ->
// gpt-5.6-terra — exactly as described in the issue.
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
	return {
		strategy: {
			select: async (all: unknown[]) => all,
		},
		dbOps: {
			getAllAccounts: async () => opts.accounts,
			getActiveComboForFamily: async () => null,
			getAccount: async (id: string) =>
				opts.accounts.find((a) => (a as { id: string }).id === id) ?? null,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => {} },
		config: {
			getForceAccountModel: () => opts.forceAccountModel ?? false,
			getCombosEnabled: () => true,
		},
	} as unknown as ProxyContext;
}

async function selectImplicitRoute(ctx: ProxyContext, id = "gpt-6-astra") {
	const bodyContext = RequestBodyContext.fromParsed(null, {
		model: CLAUDE_SONNET_5,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16,
		__better_ccflare_codex_passthrough: { model: id },
	});
	const route = await resolveImplicitCodexRoute(
		bodyContext.getParsedJson(),
		await ctx.dbOps.getAllAccounts(),
		{ prime: false },
	);
	if (!route) throw new Error("Expected a proven implicit Codex route");
	const meta: RequestMeta = {
		...makeRequestMeta(),
		routeProfileId: `implicit-codex:${route.id}`,
		routeProfileSelection: "implicit-codex",
		routeProfileLogicalModel: route.id,
		routeProfileExpectedPhysicalModel: route.id,
		routeExpectedProvider: "codex",
		routeExpectedPhysicalModel: route.id,
		forcedAccountId: null,
	};
	meta.headers?.set("x-better-ccflare-exclude-providers", "anthropic-oauth");
	bodyContext.setModel(route.id);
	const accounts = await selectAccountsForRequest(meta, ctx, route.id);
	const wireRequest = await new CodexProvider().transformRequestBody(
		new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: bodyContext.getBuffer(),
		}),
		accounts[0],
	);
	return { accounts, wireModel: (await wireRequest.json()).model };
}

describe("issue #324 — Codex CLI physical model implicit route", () => {
	beforeEach(() => {
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
	});
	afterEach(() => {
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
	});

	it("A: the carrier restores physical admission and the raw wire model despite a different sonnet mapping", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [codex] });

		const result = await selectImplicitRoute(ctx);

		expect(result.accounts.map((account) => account.id)).toEqual(["codex-1"]);
		expect(result.wireModel).toBe("gpt-6-astra");
	});

	it("B: the SAME account with the SAME mapping is admitted when the caller passes the physical id straight through", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [codex] });

		const result = await selectAccountsForRequest(
			makeRequestMeta() as never,
			ctx as never,
			"gpt-6-astra",
		);

		expect(result.map((a: { id: string }) => a.id)).toEqual(["codex-1"]);
	});

	it("C (control): a genuine Claude account is unaffected by the same call — proves the fence is specific to identity-changing mappings, not the model family", async () => {
		const claude = makeAccount({ id: "claude-1", provider: "anthropic" });
		const ctx = makeCtx({ accounts: [claude] });

		const result = await selectAccountsForRequest(
			makeRequestMeta() as never,
			ctx as never,
			CLAUDE_SONNET_5,
		);

		expect(result.map((a: { id: string }) => a.id)).toEqual(["claude-1"]);
	});

	it("D: a primed account catalog also admits the physical id and preserves its wire identity", async () => {
		const codex = makeCodexAccount();
		const ctx = makeCtx({ accounts: [codex] });

		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-6-astra",
								display_name: "Astra",
								visibility: "list",
								priority: 1,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)) as typeof globalThis.fetch;

			const listing = await getCodexModels("codex-1", ctx as never);
			expect(listing?.models.map((m) => m.id)).toEqual(["gpt-6-astra"]);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const result = await selectImplicitRoute(ctx);

		expect(result.accounts.map((account) => account.id)).toEqual(["codex-1"]);
		expect(result.wireModel).toBe("gpt-6-astra");
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
