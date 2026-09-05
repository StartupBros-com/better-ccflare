import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	accountServesPhysicalModel,
	getCodexPassthroughPhysicalModel,
	resolveImplicitCodexRoute,
} from "../codex-implicit-route";
import {
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	getCodexModels,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";

const PHYSICAL_MODEL = "gpt-6-codex";
const originalFetch = globalThis.fetch;
const originalMappings = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "implicit-codex-account",
		name: "implicit-codex-account",
		provider: "codex",
		api_key: null,
		access_token: "test-access-token",
		refresh_token: "test-refresh-token",
		expires_at: Date.now() + 3_600_000,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		...overrides,
	} as Account;
}

function makeContext(account: Account): ProxyContext {
	return {
		dbOps: { getAccount: async () => account },
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
}

function catalogResponse(...ids: string[]): Response {
	return Response.json({
		models: ids.map((slug, priority) => ({
			slug,
			priority,
			visibility: "list",
		})),
	});
}

async function primeCatalog(account: Account, ...ids: string[]): Promise<void> {
	globalThis.fetch = (async () =>
		catalogResponse(...ids)) as typeof globalThis.fetch;
	await getCodexModels(account.id, makeContext(account));
}

beforeEach(() => {
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
	globalThis.fetch = (async () => {
		throw new Error("Unexpected catalog fetch");
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	if (originalMappings === undefined) {
		delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
	} else {
		process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = originalMappings;
	}
});

const carrier = (model: unknown) => ({
	__better_ccflare_codex_passthrough: { model },
});

describe("accountServesPhysicalModel evidence", () => {
	it("accepts the account's own primed catalog before any configured mapping", async () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: "another-model" }),
		});
		await primeCatalog(account, PHYSICAL_MODEL);
		expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
			true,
		);
	});

	it("rejects a model missing from its own catalog even if statically mapped", async () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: PHYSICAL_MODEL }),
		});
		await primeCatalog(account, "another-model");
		expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
			false,
		);
	});

	it("hardcodes codex even when another provider has matching static evidence", async () => {
		for (const provider of [
			"anthropic",
			"anthropic-oauth",
			"openai-compatible",
		]) {
			const account = makeAccount({
				provider,
				model_mappings: JSON.stringify({ sonnet: PHYSICAL_MODEL }),
			});
			expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
				false,
			);
		}
	});

	it("admits matching explicit Claude family candidates without a catalog", async () => {
		for (const family of ["fable", "opus", "sonnet", "haiku"]) {
			const account = makeAccount({
				model_mappings: JSON.stringify({
					[family]: ["another-model", PHYSICAL_MODEL],
				}),
			});
			expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
				true,
			);
		}
	});

	it("recognizes exact Claude ids and legacy static mapping storage", async () => {
		for (const mapping of [
			{ model_mappings: JSON.stringify({ "claude-sonnet-5": PHYSICAL_MODEL }) },
			{ model_mappings: JSON.stringify({ "claude-opus-4-6": PHYSICAL_MODEL }) },
			{ model_fallbacks: JSON.stringify({ haiku: PHYSICAL_MODEL }) },
			{
				custom_endpoint: JSON.stringify({
					modelMappings: { opus: PHYSICAL_MODEL },
				}),
			},
		]) {
			expect(
				await accountServesPhysicalModel(makeAccount(mapping), PHYSICAL_MODEL),
			).toBe(true);
		}
	});

	it("does not treat raw-id passthrough or provider-wide defaults as account evidence", async () => {
		const account = makeAccount();
		setDerivedProviderModelDefaults("codex", "another-account", {
			sonnet: PHYSICAL_MODEL,
		});
		expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
			false,
		);
		await primeCatalog(makeAccount({ id: "another-account" }), PHYSICAL_MODEL);
		expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
			false,
		);
	});

	it("rejects global environment mappings as proof for an unprimed account", async () => {
		const previous = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
		process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
			sonnet: PHYSICAL_MODEL,
		});
		try {
			const account = makeAccount();
			expect(await accountServesPhysicalModel(account, PHYSICAL_MODEL)).toBe(
				false,
			);
			expect(
				await resolveImplicitCodexRoute(carrier(PHYSICAL_MODEL), [account]),
			).toBeNull();
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
			} else {
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = previous;
			}
		}
	});

	it("resolves only independently proven codex accounts and returns null when none match", async () => {
		const matching = makeAccount({
			model_mappings: JSON.stringify({ sonnet: PHYSICAL_MODEL }),
		});
		const unknown = makeAccount({ id: "unknown" });
		const otherProvider = makeAccount({
			...matching,
			id: "other-provider",
			provider: "anthropic",
		});
		expect(
			await resolveImplicitCodexRoute(carrier(PHYSICAL_MODEL), [
				unknown,
				matching,
				otherProvider,
			]),
		).toEqual({
			id: PHYSICAL_MODEL,
			matchingAccounts: [matching],
		});
		expect(
			await resolveImplicitCodexRoute(carrier(PHYSICAL_MODEL), [unknown]),
		).toBeNull();
		expect(
			await resolveImplicitCodexRoute(carrier("claude-opus-5"), [matching]),
		).toBeNull();
	});
});

describe("implicit Codex catalog priming", () => {
	it("primes an unprimed account once within the selection deadline", async () => {
		const account = makeAccount();
		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount++;
			return catalogResponse(PHYSICAL_MODEL);
		}) as typeof globalThis.fetch;
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				ctx: makeContext(account),
				deadlineAt: Date.now() + 1_000,
			}),
		).toBe(true);
		expect(fetchCount).toBe(1);
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				prime: false,
			}),
		).toBe(true);
		expect(fetchCount).toBe(1);
	});

	it("does not prime when static configuration already proves the account", async () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: PHYSICAL_MODEL }),
		});
		let accountReads = 0;
		const ctx = makeContext(account);
		ctx.dbOps.getAccount = async () => {
			accountReads++;
			return account;
		};
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				ctx,
				deadlineAt: Date.now() + 1_000,
			}),
		).toBe(true);
		expect(accountReads).toBe(0);
	});

	it("never starts an unbounded prime or primes an evidence-only selector recheck", async () => {
		const account = makeAccount();
		let accountReads = 0;
		const ctx = makeContext(account);
		ctx.dbOps.getAccount = async () => {
			accountReads++;
			return account;
		};
		for (const options of [
			{ ctx },
			{ ctx, deadlineAt: Number.POSITIVE_INFINITY },
			{ ctx, deadlineAt: Number.NaN },
			{ deadlineAt: Date.now() + 1_000 },
			{ ctx, deadlineAt: Date.now() + 1_000, prime: false },
		]) {
			expect(
				await accountServesPhysicalModel(account, PHYSICAL_MODEL, options),
			).toBe(false);
		}
		expect(accountReads).toBe(0);
	});

	it("fails closed when priming only borrows another account's provider-wide catalog", async () => {
		await primeCatalog(makeAccount({ id: "donor-account" }), PHYSICAL_MODEL);
		const account = makeAccount();
		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount++;
			throw new Error("catalog denied");
		}) as typeof globalThis.fetch;
		expect(
			await resolveImplicitCodexRoute(carrier(PHYSICAL_MODEL), [account], {
				ctx: makeContext(account),
				deadlineAt: Date.now() + 1_000,
			}),
		).toBeNull();
		expect(fetchCount).toBe(1);
	});

	it("fails closed without starting work when the selection deadline has expired", async () => {
		const account = makeAccount();
		let accountReads = 0;
		const ctx = makeContext(account);
		ctx.dbOps.getAccount = async () => {
			accountReads++;
			return account;
		};
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				ctx,
				deadlineAt: Date.now() - 1,
			}),
		).toBe(false);
		expect(accountReads).toBe(0);
	});

	it("does not admit existing static or catalog evidence after the selection deadline", async () => {
		const mapped = makeAccount({
			model_mappings: JSON.stringify({ sonnet: PHYSICAL_MODEL }),
		});
		const catalogued = makeAccount({ id: "catalogued-account" });
		await primeCatalog(catalogued, PHYSICAL_MODEL);
		const options = { deadlineAt: Date.now() - 1 };
		for (const account of [mapped, catalogued]) {
			expect(
				await accountServesPhysicalModel(account, PHYSICAL_MODEL, options),
			).toBe(false);
		}
		expect(
			await resolveImplicitCodexRoute(
				carrier(PHYSICAL_MODEL),
				[mapped, catalogued],
				options,
			),
		).toBeNull();
	});

	it("bounds a slow catalog prime and does not admit its late result", async () => {
		const account = makeAccount();
		const ctx = makeContext(account);
		const response = Promise.withResolvers<Response>();
		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount++;
			return response.promise;
		}) as typeof globalThis.fetch;
		const startedAt = Date.now();
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				ctx,
				deadlineAt: startedAt + 20,
			}),
		).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(fetchCount).toBe(1);
		// The account's shared ensure may finish for a subsequent request, but it
		// cannot change the already-rejected selection after its deadline.
		response.resolve(catalogResponse(PHYSICAL_MODEL));
		await ensureCodexModelDefaults(account, ctx);
		expect(
			await accountServesPhysicalModel(account, PHYSICAL_MODEL, {
				prime: false,
			}),
		).toBe(true);
	});

	it("fails closed on client cancellation while the shared catalog read completes", async () => {
		const account = makeAccount();
		const ctx = makeContext(account);
		const response = Promise.withResolvers<Response>();
		const controller = new AbortController();
		globalThis.fetch = (async () =>
			response.promise) as typeof globalThis.fetch;
		const resolution = accountServesPhysicalModel(account, PHYSICAL_MODEL, {
			ctx,
			deadlineAt: Date.now() + 1_000,
			signal: controller.signal,
		});
		controller.abort();
		expect(await resolution).toBe(false);
		response.resolve(catalogResponse(PHYSICAL_MODEL));
		await ensureCodexModelDefaults(account, ctx);
	});
});

describe("getCodexPassthroughPhysicalModel", () => {
	it("extracts a trimmed physical id, including real codex-auto catalog slugs", () => {
		expect(getCodexPassthroughPhysicalModel(carrier("  gpt-6-codex  "))).toBe(
			"gpt-6-codex",
		);
		expect(getCodexPassthroughPhysicalModel(carrier("codex-auto-review"))).toBe(
			"codex-auto-review",
		);
	});

	it("rejects missing, malformed, empty, and non-string carriers", () => {
		for (const body of [
			null,
			undefined,
			[],
			"gpt-6-codex",
			{},
			{ model: "gpt-6-codex" },
			{ __better_ccflare_codex_passthrough: null },
			{ __better_ccflare_codex_passthrough: "gpt-6-codex" },
			carrier(undefined),
			carrier(42),
			carrier(""),
			carrier("   "),
		]) {
			expect(getCodexPassthroughPhysicalModel(body)).toBeNull();
		}
	});

	it("leaves every Claude family id and stock alias outside implicit routing", () => {
		for (const id of [
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-haiku-4-5",
			"opus",
			" SONNET ",
			"haiku",
			"fable",
			"provider/claude-opus-5",
		]) {
			expect(getCodexPassthroughPhysicalModel(carrier(id))).toBeNull();
		}
	});
});
