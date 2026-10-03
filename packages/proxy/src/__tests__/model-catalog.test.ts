import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUNDLED_MODELS_AS_OF,
	CLAUDE_MODEL_IDS,
	isAccountAvailable,
} from "@better-ccflare/core";
import { getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	clearNativeAutoCatalogEvidence,
	fetchLiveModels,
	getModelCatalog,
	getNativeAutoCatalogEvidence,
	getPendingNativeCatalogAcquisition,
	ingestModelsListing,
	initModelCatalogRefresh,
	type ModelCatalog,
	NativeCatalogObsoleteGenerationError,
	refreshModelCatalog,
	resetModelCatalogForTest,
	validateNativeAutoCatalogCredentials,
} from "../model-catalog";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-console-account",
		// Console (API-key) accounts are the default-eligible provider for
		// automatic catalog refreshes; override to "anthropic" for OAuth tests.
		provider: "claude-console-api",
		api_key: "sk-test-key",
		refresh_token: "rt",
		access_token: "at-valid",
		expires_at: Date.now() + 60 * 60 * 1000,
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
	};
}

function makeCtx(
	accounts: Account[],
	options?: { oauthRefreshEnabled?: boolean },
): ProxyContext {
	const oauthRefreshEnabled = options?.oauthRefreshEnabled ?? false;
	return {
		strategy: {} as never,
		dbOps: {
			getAllAccounts: async () => accounts,
			getAccount: async (id: string) =>
				accounts.find((a) => a.id === id) ?? null,
		} as ProxyContext["dbOps"],
		runtime: { port: 8080, clientId: "test-client" } as never,
		config: {
			getModelCatalogOAuthRefreshEnabled: () => oauthRefreshEnabled,
		} as never,
		// biome-ignore lint/style/noNonNullAssertion: anthropic provider is always registered in this test environment
		provider: getProvider("anthropic")!,
		refreshInFlight: new Map(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		asyncWriter: { enqueue: (fn: () => unknown) => fn() } as any,
	};
}

const TEST_CACHE_DIR = join(tmpdir(), "better-ccflare-test-model-catalog");

async function cleanCacheDir() {
	await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });
}

async function writeCacheFile(catalog: ModelCatalog): Promise<void> {
	await fs.mkdir(TEST_CACHE_DIR, { recursive: true });
	await fs.writeFile(
		join(TEST_CACHE_DIR, "anthropic-models.json"),
		JSON.stringify(catalog, null, 2),
	);
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("model-catalog", () => {
	const originalFetch = global.fetch;
	// The test preload sets this for the whole process, and bun runs every test
	// file in one process, so restore it rather than deleting it.
	const savedCacheDir = process.env.BETTER_CCFLARE_MODELS_CACHE_DIR;

	beforeEach(async () => {
		process.env.BETTER_CCFLARE_MODELS_CACHE_DIR = TEST_CACHE_DIR;
		delete process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS;
		delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
		await cleanCacheDir();
		resetModelCatalogForTest();
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		if (savedCacheDir === undefined)
			delete process.env.BETTER_CCFLARE_MODELS_CACHE_DIR;
		else process.env.BETTER_CCFLARE_MODELS_CACHE_DIR = savedCacheDir;
		delete process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS;
		delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
		await cleanCacheDir();
		resetModelCatalogForTest();
	});

	it("validates actual native credentials and incarnation without rediscovery", async () => {
		const account = makeAccount({ provider: "anthropic", api_key: null });
		global.fetch = Object.assign(
			async () =>
				Response.json({
					data: [{ id: "claude-fable-5-1" }],
					has_more: false,
				}),
			{ preconnect: () => {} },
		);
		await fetchLiveModels(makeCtx([account]), { allowOAuth: true });
		const evidence = getNativeAutoCatalogEvidence(account.id);
		const selected = { account, accessToken: "at-valid" };
		expect(validateNativeAutoCatalogCredentials(evidence, selected)).toBe(true);
		expect(
			validateNativeAutoCatalogCredentials(evidence, {
				...selected,
				accessToken: "replaced",
			}),
		).toBe(false);
		expect(
			validateNativeAutoCatalogCredentials(evidence, {
				...selected,
				account: { ...account, created_at: account.created_at + 1 },
			}),
		).toBe(false);
		expect(
			validateNativeAutoCatalogCredentials(
				evidence && { ...evidence },
				selected,
			),
		).toBe(false);
		await fetchLiveModels(makeCtx([account]), { allowOAuth: true });
		expect(validateNativeAutoCatalogCredentials(evidence, selected)).toBe(true);
		clearNativeAutoCatalogEvidence(account.id);
		await fetchLiveModels(makeCtx([account]), { allowOAuth: true });
		expect(validateNativeAutoCatalogCredentials(evidence, selected)).toBe(
			false,
		);
		expect(
			validateNativeAutoCatalogCredentials(
				getNativeAutoCatalogEvidence(account.id),
				selected,
			),
		).toBe(true);
	});
	it.each([
		undefined,
		"1",
		"0",
		"9999",
	])("bounds native Auto freshness with refresh hours %s without changing advisory caches", async (hours) => {
		if (hours !== undefined)
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = hours;
		const duration = hours === "1" ? 3_600_000 : 168 * 3_600_000;
		const start = 1_000_000;
		const clock = spyOn(Date, "now").mockReturnValue(start);
		const first = makeAccount({ id: "expiry-first" });
		const second = makeAccount({ id: "expiry-second" });
		const live = (async () =>
			Response.json({
				data: [{ id: "claude-opus-5-5" }],
				has_more: false,
			})) as typeof fetch;
		global.fetch = live;
		try {
			expect((await refreshModelCatalog(makeCtx([first]))).success).toBe(true);
			const evidence = getNativeAutoCatalogEvidence(first.id);
			expect(evidence?.fetchedAt).toBe(start);
			expect(evidence?.expiresAt).toBe(start + duration);
			clock.mockReturnValue(start - 1);
			expect(getNativeAutoCatalogEvidence(first.id)).toBeNull();
			clock.mockReturnValue(start + duration - 1);
			expect(getNativeAutoCatalogEvidence(first.id)).toBe(evidence);
			expect(getNativeAutoCatalogEvidence(first.id)).toBe(evidence);
			await fetchLiveModels(makeCtx([second]));
			global.fetch = (async () =>
				new Response("unavailable", { status: 503 })) as typeof fetch;
			expect((await refreshModelCatalog(makeCtx([first]))).success).toBe(false);
			expect(getNativeAutoCatalogEvidence(first.id)).toBe(evidence);
			clock.mockReturnValue(start + duration);
			expect((await refreshModelCatalog(makeCtx([first]))).success).toBe(false);
			expect(getNativeAutoCatalogEvidence(first.id)).toBeNull();
			expect((await getModelCatalog()).fetchedAt).toBe(start);
			expect(getNativeAutoCatalogEvidence(second.id)).not.toBeNull();
			global.fetch = live;
			await fetchLiveModels(makeCtx([first]));
			const renewed = getNativeAutoCatalogEvidence(first.id);
			expect(renewed?.revision).toBe(evidence?.revision);
			expect(renewed?.fetchedAt).toBe(start + duration);
			expect(renewed).not.toBe(evidence);
		} finally {
			clock.mockRestore();
		}
	});

	it("retains passive facts as advisory rather than unfenced owned entitlement", async () => {
		const first = makeAccount({ id: "passive-first" });
		const second = makeAccount({ id: "passive-second" });
		await ingestModelsListing(
			JSON.stringify({
				data: [
					{
						id: "claude-opus-5-5",
						max_input_tokens: 1000000,
						max_tokens: 128000,
					},
				],
				has_more: false,
			}),
			first,
		);
		await ingestModelsListing(
			JSON.stringify({
				data: [
					{
						id: "claude-haiku-4-5",
						max_input_tokens: 200000,
						max_tokens: 64000,
					},
				],
				has_more: false,
			}),
			second,
		);
		expect(getNativeAutoCatalogEvidence(first.id)).toBeNull();
		expect(getNativeAutoCatalogEvidence(second.id)).toBeNull();
		expect(
			(await getModelCatalog()).models[0].capabilities?.maxOutputTokens,
		).toBe(64000);
		await ingestModelsListing(
			JSON.stringify({
				data: [{ id: "claude-sonnet-5-5", max_tokens: 128000 }],
				has_more: true,
			}),
			makeAccount({ id: "partial-only" }),
		);
		expect(getNativeAutoCatalogEvidence("partial-only")).toBeNull();
	});

	it("does not authorize late passive responses after account deletion", async () => {
		const account = makeAccount();
		clearNativeAutoCatalogEvidence(account.id);
		await ingestModelsListing(
			JSON.stringify({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			account,
		);
		expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
	});

	describe("fetchLiveModels", () => {
		it.each([
			false,
			true,
		])("cancels a pending body promptly without late publication or pagination (has_more=%s)", async (hasMore) => {
			const controller = new AbortController();
			const reading = deferred<void>();
			const body = deferred<unknown>();
			const fetchMock = mock(async () => {
				const response = Response.json({});
				response.json = async () => {
					reading.resolve();
					return body.promise;
				};
				return response;
			});
			global.fetch = Object.assign(fetchMock, { preconnect: () => {} });
			const pending = fetchLiveModels(makeCtx([makeAccount()]), {
				signal: controller.signal,
			});
			const outcome = pending.then(
				() => "resolved",
				() => "cancelled",
			);
			await reading.promise;
			controller.abort(new Error("caller cancelled"));
			try {
				expect(
					await Promise.race([
						outcome,
						new Promise((resolve) =>
							setTimeout(() => resolve("still pending"), 25),
						),
					]),
				).toBe("cancelled");
			} finally {
				body.resolve({
					data: [{ id: "claude-late" }],
					has_more: hasMore,
					last_id: "claude-late",
				});
				await outcome;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(getNativeAutoCatalogEvidence("acc-1")).toBeNull();
		});

		it("shares one ten-second deadline across pagination and body reading, rejecting late success", async () => {
			const reading = deferred<void>();
			const body = deferred<unknown>();
			const fetchSignals: (AbortSignal | null | undefined)[] = [];
			global.fetch = Object.assign(
				async (_url: unknown, init?: RequestInit) => {
					fetchSignals.push(init?.signal);
					if (fetchSignals.length === 1) {
						await new Promise((resolve) => setTimeout(resolve, 1_500));
						return Response.json({
							data: [{ id: "first-page" }],
							has_more: true,
							last_id: "first-page",
						});
					}
					const response = Response.json({});
					response.json = async () => {
						reading.resolve();
						return body.promise;
					};
					return response;
				},
				{ preconnect: () => {} },
			);
			const pending = fetchLiveModels(makeCtx([makeAccount()]));
			const outcome = pending.then(
				() => "resolved",
				() => "timed out",
			);
			await reading.promise;
			try {
				expect(
					await Promise.race([
						outcome,
						new Promise((resolve) =>
							setTimeout(() => resolve("still pending"), 9_000),
						),
					]),
				).toBe("timed out");
				expect(fetchSignals).toHaveLength(2);
				expect(fetchSignals[0]?.aborted).toBe(true);
				expect(fetchSignals[1]?.aborted).toBe(true);
			} finally {
				body.resolve({ data: [{ id: "claude-late" }], has_more: false });
				await outcome;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			expect(getNativeAutoCatalogEvidence("acc-1")).toBeNull();
		}, 15_000);
		it.each([
			"lookup",
			"headers",
		])("cancels pending %s without late body reads or new traffic", async (phase) => {
			const controller = new AbortController();
			const entered = deferred<void>();
			const resume = deferred<void>();
			const account = makeAccount();
			const ctx = makeCtx([account]);
			if (phase === "lookup") {
				ctx.dbOps.getAccount = async () => {
					entered.resolve();
					await resume.promise;
					return account;
				};
			}
			const readBody = mock(async () => ({
				data: [{ id: "claude-late" }],
				has_more: false,
			}));
			const fetchMock = mock(async () => {
				entered.resolve();
				await resume.promise;
				const response = Response.json({});
				response.json = readBody;
				return response;
			});
			global.fetch = Object.assign(fetchMock, { preconnect: () => {} });
			const pending = fetchLiveModels(ctx, {
				accountId: account.id,
				signal: controller.signal,
			});
			const outcome = pending.then(
				() => "resolved",
				() => "cancelled",
			);
			await entered.promise;
			controller.abort();
			try {
				expect(
					await Promise.race([
						outcome,
						new Promise((resolve) =>
							setTimeout(() => resolve("still pending"), 25),
						),
					]),
				).toBe("cancelled");
			} finally {
				resume.resolve();
				await outcome;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			expect(fetchMock).toHaveBeenCalledTimes(phase === "lookup" ? 0 : 1);
			expect(readBody).not.toHaveBeenCalled();
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});

		it("rejects an already-cancelled lookup without upstream traffic", async () => {
			const controller = new AbortController();
			controller.abort(new Error("caller cancelled"));
			const fetchMock = mock(async () =>
				Response.json({ data: [], has_more: false }),
			);
			global.fetch = Object.assign(fetchMock, { preconnect: () => {} });
			await expect(
				fetchLiveModels(makeCtx([makeAccount()]), {
					signal: controller.signal,
				}),
			).rejects.toThrow("caller cancelled");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(getNativeAutoCatalogEvidence("acc-1")).toBeNull();
		});
		it.each([
			["missing", null],
			["paused", { paused: true }],
			["wrong provider", { provider: "zai" }],
			["mismatched ID", { id: "another-account" }],
			["custom endpoint", { custom_endpoint: "https://example.test" }],
			["OAuth without opt-in", { provider: "anthropic" }],
		] as const)("denies a targeted %s account without fallback", async (_label, overrides) => {
			const target =
				overrides === null ? null : makeAccount({ id: "target", ...overrides });
			const ctx = makeCtx([
				makeAccount({ id: "fallback" }),
				...(target ? [target] : []),
			]);
			const lookup = spyOn(ctx.dbOps, "getAccount").mockResolvedValue(target);
			const enumerate = spyOn(ctx.dbOps, "getAllAccounts");
			const fetchMock = mock(async () => Response.json({ data: [] }));
			global.fetch = fetchMock as unknown as typeof fetch;
			await expect(
				fetchLiveModels(ctx, { accountId: "target" }),
			).rejects.toThrow(
				"No active anthropic account available to fetch models (console/API-key accounts only; set BETTER_CCFLARE_MODELS_OAUTH_REFRESH=1 or use a manual refresh to allow an OAuth account fallback)",
			);
			expect(lookup).toHaveBeenCalledWith("target");
			expect(enumerate).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it.each([
			undefined,
			"",
		])("enumerates accounts for untargeted ID %s", async (accountId) => {
			const ctx = makeCtx([
				makeAccount({ id: "low", priority: 10 }),
				makeAccount({ id: "preferred", api_key: "preferred-key" }),
			]);
			const lookup = spyOn(ctx.dbOps, "getAccount");
			const enumerate = spyOn(ctx.dbOps, "getAllAccounts");
			const seen: Array<string | null> = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					seen.push(new Headers(init?.headers).get("authorization"));
					return Response.json({ data: [] });
				},
			) as unknown as typeof fetch;
			expect(await fetchLiveModels(ctx, { accountId })).toEqual([]);
			expect(seen).toEqual(["Bearer preferred-key"]);
			expect(enumerate).toHaveBeenCalledTimes(1);
			expect(lookup).not.toHaveBeenCalled();
		});

		it.each([
			["rate-limited", { rate_limited_until: Date.now() + 60_000 }],
			["requires reauth", { pause_reason: "oauth_invalid_grant" }],
		] as const)("request-eligibility predicate rejects a freshly reloaded %s target before any fetch or publication", async (_label, overrides) => {
			const target = makeAccount({ id: "target", ...overrides });
			const ctx = makeCtx([target]);
			const fetchMock = mock(async () => Response.json({ data: [] }));
			global.fetch = fetchMock as unknown as typeof fetch;
			const seen: string[] = [];
			await expect(
				fetchLiveModels(ctx, {
					accountId: "target",
					accountEligible: (a) => {
						seen.push(a.id);
						return isAccountAvailable(a) && !a.requires_reauth;
					},
				}),
			).rejects.toThrow("not eligible for this request");
			expect(seen).toEqual(["target"]);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(getNativeAutoCatalogEvidence("target")).toBeNull();
		});

		it("without a request-eligibility predicate a rate-limited target is still fetched (unchanged default)", async () => {
			const target = makeAccount({
				id: "target",
				rate_limited_until: Date.now() + 60_000,
			});
			const fetchMock = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			);
			global.fetch = fetchMock as unknown as typeof fetch;
			const models = await fetchLiveModels(makeCtx([target]), {
				accountId: "target",
			});
			expect(models).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("fences deletion while targeted lookup is pending", async () => {
			const account = makeAccount();
			const lookup = deferred<Account | null>();
			const ctx = makeCtx([account]);
			ctx.dbOps.getAccount = () => lookup.promise;
			const fetchMock = mock(async () => Response.json({ data: [] }));
			global.fetch = fetchMock as unknown as typeof fetch;
			const pending = fetchLiveModels(ctx, { accountId: account.id });
			clearNativeAutoCatalogEvidence(account.id);
			lookup.resolve(account);
			await expect(pending).rejects.toThrow(
				"obsolete native catalog generation",
			);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});

		it("fences an older targeted lookup that resolves after a newer refresh", async () => {
			const account = makeAccount();
			const lookup = deferred<Account | null>();
			const ctx = makeCtx([account]);
			ctx.dbOps.getAccount = () => lookup.promise;
			const fetchMock = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }] }),
			);
			global.fetch = fetchMock as unknown as typeof fetch;
			const pending = fetchLiveModels(ctx, { accountId: account.id });
			await fetchLiveModels(makeCtx([account]), { accountId: account.id });
			const evidence = getNativeAutoCatalogEvidence(account.id);
			expect(evidence).not.toBeNull();
			lookup.resolve(account);
			await expect(pending).rejects.toThrow(
				"obsolete native catalog generation",
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(getNativeAutoCatalogEvidence(account.id)).toBe(evidence);
		});

		it("throws a typed obsolete error for the superseded caller, which never publishes", async () => {
			const account = makeAccount();
			const lookup = deferred<Account | null>();
			const ctx = makeCtx([account]);
			ctx.dbOps.getAccount = () => lookup.promise;
			const fetchMock = mock(async () => Response.json({ data: [] }));
			global.fetch = fetchMock as unknown as typeof fetch;
			const pending = fetchLiveModels(ctx, { accountId: account.id });
			clearNativeAutoCatalogEvidence(account.id);
			lookup.resolve(account);
			const error = await pending.catch((e) => e);
			expect(error).toBeInstanceOf(NativeCatalogObsoleteGenerationError);
			expect(error.message).toBe("obsolete native catalog generation");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});

		it("exposes the newest pending acquisition; only the owning generation clears it", async () => {
			const account = makeAccount();
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
			const oldLookup = deferred<Account | null>();
			const oldCtx = makeCtx([account]);
			oldCtx.dbOps.getAccount = () => oldLookup.promise;
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			) as unknown as typeof fetch;
			const older = fetchLiveModels(oldCtx, { accountId: account.id });
			const olderSignal = getPendingNativeCatalogAcquisition(account.id);
			expect(olderSignal).toBeInstanceOf(Promise);
			const newLookup = deferred<Account | null>();
			const newCtx = makeCtx([account]);
			newCtx.dbOps.getAccount = () => newLookup.promise;
			const newer = fetchLiveModels(newCtx, { accountId: account.id });
			const newerSignal = getPendingNativeCatalogAcquisition(account.id);
			expect(newerSignal).not.toBe(olderSignal);
			// Older settles (obsolete) while the newer one is still pending.
			oldLookup.resolve(account);
			newLookup.resolve(account);
			// Make the older one obsolete: it reaches the token await after the newer set its generation.
			await older.catch(() => undefined);
			await olderSignal;
			await newer.catch(() => undefined);
			await newerSignal;
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
		});

		it("an older settling acquisition does not delete the newer pending entry", async () => {
			const account = makeAccount();
			const oldLookup = deferred<Account | null>();
			const oldCtx = makeCtx([account]);
			oldCtx.dbOps.getAccount = () => oldLookup.promise;
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			) as unknown as typeof fetch;
			const older = fetchLiveModels(oldCtx, { accountId: account.id });
			const newLookup = deferred<Account | null>();
			const newCtx = makeCtx([account]);
			newCtx.dbOps.getAccount = () => newLookup.promise;
			const newer = fetchLiveModels(newCtx, { accountId: account.id });
			const newerSignal = getPendingNativeCatalogAcquisition(account.id);
			oldLookup.resolve(account);
			await older.catch(() => undefined);
			expect(getPendingNativeCatalogAcquisition(account.id)).toBe(newerSignal);
			newLookup.resolve(account);
			await newer;
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
		});

		it("untargeted lookups register once the account is selected and clear on settle", async () => {
			const account = makeAccount();
			const lookup = deferred<Account[]>();
			const ctx = makeCtx([account]);
			ctx.dbOps.getAllAccounts = () => lookup.promise;
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			) as unknown as typeof fetch;
			const pending = fetchLiveModels(ctx);
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
			lookup.resolve([account]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await pending;
			expect(getNativeAutoCatalogEvidence(account.id)).not.toBeNull();
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
		});

		it("an older untargeted lookup registering late never replaces a newer targeted entry", async () => {
			const account = makeAccount();
			const allAccounts = deferred<Account[]>();
			const untargetedCtx = makeCtx([account]);
			untargetedCtx.dbOps.getAllAccounts = () => allAccounts.promise;
			const targetLookup = deferred<Account | null>();
			const targetedCtx = makeCtx([account]);
			targetedCtx.dbOps.getAccount = () => targetLookup.promise;
			const fetchStarted = deferred<void>();
			const gate = deferred<void>();
			global.fetch = mock(async () => {
				fetchStarted.resolve();
				await gate.promise;
				return Response.json({
					data: [{ id: "claude-opus-5-5" }],
					has_more: false,
				});
			}) as unknown as typeof fetch;
			// Older generation (untargeted) starts first, newer (targeted) second.
			const older = fetchLiveModels(untargetedCtx);
			const newer = fetchLiveModels(targetedCtx, { accountId: account.id });
			const newerSignal = getPendingNativeCatalogAcquisition(account.id);
			expect(newerSignal).toBeInstanceOf(Promise);
			let newerSettled = false;
			void newerSignal?.then(() => {
				newerSettled = true;
			});
			// The older lookup selects the account and reaches its fetch while the
			// newer one is still waiting on its own account lookup.
			allAccounts.resolve([account]);
			await fetchStarted.promise;
			expect(getPendingNativeCatalogAcquisition(account.id)).toBe(newerSignal);
			expect(newerSettled).toBe(false);
			targetLookup.resolve(account);
			gate.resolve();
			await older.catch(() => undefined);
			await newer.catch(() => undefined);
			await newerSignal;
			expect(getPendingNativeCatalogAcquisition(account.id)).toBeUndefined();
		});

		it("fences deletion while account lookup is pending", async () => {
			const account = makeAccount();
			const lookup = deferred<Account[]>();
			const ctx = makeCtx([account]);
			ctx.dbOps.getAllAccounts = () => lookup.promise;
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }] }),
			) as unknown as typeof fetch;
			const pending = fetchLiveModels(ctx);
			clearNativeAutoCatalogEvidence(account.id);
			lookup.resolve([account]);
			await pending.catch(() => undefined);
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});
		it("retires native ownership after credential replacement even if discovery fails", async () => {
			const account = makeAccount();
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			) as unknown as typeof fetch;
			await fetchLiveModels(makeCtx([account]));
			expect(getNativeAutoCatalogEvidence(account.id)).not.toBeNull();
			account.api_key = "replacement-key";
			global.fetch = mock(
				async () => new Response("unavailable", { status: 503 }),
			) as unknown as typeof fetch;
			await expect(fetchLiveModels(makeCtx([account]))).rejects.toThrow("503");
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});
		it("fences native discovery completion after deletion and after a newer refresh", async () => {
			const account = makeAccount();
			const slow = deferred<Response>();
			const started = deferred<void>();
			global.fetch = mock(async () => {
				started.resolve();
				return slow.promise;
			}) as unknown as typeof fetch;
			const old = fetchLiveModels(makeCtx([account]));
			await started.promise;
			clearNativeAutoCatalogEvidence(account.id);
			slow.resolve(
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			);
			await old;
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
			const slowAgain = deferred<Response>();
			const startedAgain = deferred<void>();
			global.fetch = mock(async () => {
				startedAgain.resolve();
				return slowAgain.promise;
			}) as unknown as typeof fetch;
			const older = fetchLiveModels(makeCtx([account]));
			await startedAgain.promise;
			global.fetch = mock(async () =>
				Response.json({ data: [{ id: "claude-fable-5-1" }], has_more: false }),
			) as unknown as typeof fetch;
			await fetchLiveModels(makeCtx([account]));
			slowAgain.resolve(
				Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
			);
			await older;
			expect(
				getNativeAutoCatalogEvidence(account.id)?.models.map(
					(entry) => entry.id,
				),
			).toEqual(["claude-fable-5-1"]);
		});
		it("fences deleted and out-of-order native catalog completions", async () => {
			const account = makeAccount({ id: "native-race" });
			const old = deferred<Response>();
			let calls = 0;
			global.fetch = mock(async () => {
				calls++;
				return calls === 1
					? old.promise
					: Response.json({
							data: [{ id: "claude-opus-5-5", max_tokens: 128000 }],
						});
			}) as unknown as typeof fetch;
			const pending = fetchLiveModels(makeCtx([account]));
			while (calls < 1) await Promise.resolve();
			await fetchLiveModels(makeCtx([account]));
			old.resolve(
				Response.json({
					data: [{ id: "claude-sonnet-5-5", max_tokens: 64000 }],
				}),
			);
			await pending;
			expect(getNativeAutoCatalogEvidence(account.id)?.models[0].id).toBe(
				"claude-opus-5-5",
			);
			const deleted = deferred<Response>();
			global.fetch = mock(async () => {
				calls++;
				return deleted.promise;
			}) as unknown as typeof fetch;
			const beforeDelete = fetchLiveModels(makeCtx([account]));
			while (calls < 3) await Promise.resolve();
			clearNativeAutoCatalogEvidence(account.id);
			deleted.resolve(Response.json({ data: [{ id: "claude-sonnet-5-5" }] }));
			await beforeDelete;
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});
		it("does not keep native owned evidence across credential replacement", async () => {
			const account = makeAccount({ id: "native-rotating" });
			global.fetch = mock(async () =>
				Response.json({
					data: [{ id: "claude-opus-5-5", max_tokens: 128000 }],
				}),
			) as unknown as typeof fetch;
			await fetchLiveModels(makeCtx([account]), { accountId: account.id });
			expect(getNativeAutoCatalogEvidence(account.id)).not.toBeNull();
			account.api_key = "replacement";
			global.fetch = mock(
				async () => new Response("unavailable", { status: 503 }),
			) as unknown as typeof fetch;
			await expect(
				fetchLiveModels(makeCtx([account]), { accountId: account.id }),
			).rejects.toThrow("503");
			expect(getNativeAutoCatalogEvidence(account.id)).toBeNull();
		});
		it("preserves selected-account native capability evidence without global entitlement", async () => {
			const first = makeAccount({
				id: "first",
				api_key: "first-key",
				access_token: null,
				refresh_token: null,
			});
			const second = makeAccount({
				id: "second",
				api_key: "second-key",
				access_token: null,
				refresh_token: null,
				priority: 10,
			});
			const seen: Array<string | null> = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					seen.push(new Headers(init?.headers).get("authorization"));
					return Response.json({
						data: [
							{
								id: "claude-opus-5-5",
								max_input_tokens: 1000000,
								max_tokens: 128000,
								capabilities: { image_input: { supported: true } },
							},
						],
						has_more: false,
					});
				},
			) as unknown as typeof fetch;
			const ctx = makeCtx([first, second]);
			const lookup = spyOn(ctx.dbOps, "getAccount");
			const enumerate = spyOn(ctx.dbOps, "getAllAccounts");
			const models = await fetchLiveModels(ctx, { accountId: second.id });
			expect(models.map((entry) => entry.id)).toEqual(["claude-opus-5-5"]);
			expect(seen).toEqual(["Bearer second-key"]);
			expect(lookup).toHaveBeenCalledWith(second.id);
			expect(lookup).toHaveBeenCalledTimes(1);
			expect(enumerate).not.toHaveBeenCalled();
			const evidence = getNativeAutoCatalogEvidence(second.id);
			expect(evidence?.models[0].capabilities?.maxOutputTokens).toBe(128000);
			expect(evidence?.models[0].capabilities?.nativeCapabilities).toEqual({
				image_input: { supported: true },
			});
			expect(getNativeAutoCatalogEvidence(first.id)).toBeNull();
			clearNativeAutoCatalogEvidence(second.id);
			expect(getNativeAutoCatalogEvidence(second.id)).toBeNull();
		});
		it("selects an active console account and fetches models", async () => {
			global.fetch = mock(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toContain("/v1/models");
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-sonnet-5",
								display_name: "Claude Sonnet 5",
								created_at: "2026-01-01T00:00:00Z",
							},
						],
						has_more: false,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: "2026-01-01T00:00:00Z",
				},
			]);
		});

		it("skips paused accounts and accounts of other providers", async () => {
			let calledUrl: string | undefined;
			global.fetch = mock(async (input: RequestInfo | URL) => {
				calledUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [], has_more: false }), {
					status: 200,
				});
			}) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({ id: "paused", paused: true, priority: -1 }),
				makeAccount({ id: "other-provider", provider: "zai", priority: -1 }),
				makeAccount({ id: "eligible", priority: 5 }),
			]);
			await fetchLiveModels(ctx);

			expect(calledUrl).toContain("/v1/models");
		});

		it("prefers the account with the lowest priority number", async () => {
			const usedAccountIds: string[] = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					usedAccountIds.push(headers.get("authorization") ?? "");
					return new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					});
				},
			) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({ id: "low-prio", priority: 10, api_key: "sk-low" }),
				makeAccount({ id: "high-prio", priority: 0, api_key: "sk-high" }),
			]);
			await fetchLiveModels(ctx);

			expect(usedAccountIds[0]).toBe("Bearer sk-high");
		});

		it("paginates using after_id until has_more is false", async () => {
			const seenAfterIds: (string | null)[] = [];
			global.fetch = mock(async (input: RequestInfo | URL) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				seenAfterIds.push(url.searchParams.get("after_id"));
				if (!url.searchParams.has("after_id")) {
					return new Response(
						JSON.stringify({
							data: [{ id: "model-a", display_name: "Model A" }],
							has_more: true,
							last_id: "model-a",
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						data: [{ id: "model-b", display_name: "Model B" }],
						has_more: false,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
			expect(seenAfterIds).toEqual([null, "model-a"]);
		});

		it("stops after a defensive maximum of 5 pages", async () => {
			let callCount = 0;
			global.fetch = mock(async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						data: [
							{ id: `model-${callCount}`, display_name: `Model ${callCount}` },
						],
						has_more: true,
						last_id: `model-${callCount}`,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(callCount).toBe(5);
			expect(models).toHaveLength(5);
		});

		it("throws when no eligible anthropic account exists", async () => {
			const ctx = makeCtx([
				makeAccount({ provider: "zai" }),
				makeAccount({ paused: true }),
			]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
		});

		it("skips accounts with a custom_endpoint override", async () => {
			let calledUrl: string | undefined;
			global.fetch = mock(async (input: RequestInfo | URL) => {
				calledUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [], has_more: false }), {
					status: 200,
				});
			}) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({
					id: "custom-endpoint",
					custom_endpoint: "https://compatible.example.com",
					priority: -1,
				}),
				makeAccount({ id: "eligible", priority: 5 }),
			]);
			await fetchLiveModels(ctx);

			expect(calledUrl).toContain("/v1/models");
		});

		it("throws when only accounts with a custom_endpoint override exist", async () => {
			const ctx = makeCtx([
				makeAccount({ custom_endpoint: "https://compatible.example.com" }),
			]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
		});

		it("throws when the upstream returns a non-ok response", async () => {
			global.fetch = mock(
				async () => new Response("boom", { status: 500 }),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(/500/);
		});

		it("throws with OAuth-opt-in guidance when only an OAuth account exists and allowOAuth is not requested", async () => {
			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/BETTER_CCFLARE_MODELS_OAUTH_REFRESH/,
			);
		});

		it("allows an OAuth account when allowOAuth is explicitly requested", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			await expect(fetchLiveModels(ctx, { allowOAuth: true })).resolves.toEqual(
				[],
			);
		});

		it("prefers a console account over an OAuth account even when allowOAuth is requested", async () => {
			const usedAccountIds: string[] = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					usedAccountIds.push(headers.get("authorization") ?? "");
					return new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					});
				},
			) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({
					id: "oauth-high-prio",
					provider: "anthropic",
					priority: 0,
					access_token: "at-oauth",
				}),
				makeAccount({
					id: "console-low-prio",
					provider: "claude-console-api",
					priority: 10,
					api_key: "sk-console",
				}),
			]);
			await fetchLiveModels(ctx, { allowOAuth: true });

			expect(usedAccountIds[0]).toBe("Bearer sk-console");
		});
	});

	describe("refreshModelCatalog / getModelCatalog", () => {
		it("returns source 'fallback' with no cache and no accounts", async () => {
			const ctx = makeCtx([]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.length).toBeGreaterThan(0);
		});

		it("derives Fable 5.1 from the bundled registry for offline fallback", async () => {
			const catalog = await getModelCatalog();

			expect(catalog.source).toBe("fallback");
			expect(catalog.fetchedAt).toBe(Date.parse(BUNDLED_MODELS_AS_OF));
			expect(catalog.models).toContainEqual({
				id: CLAUDE_MODEL_IDS.FABLE_5_1,
				displayName: "Claude Fable 5.1",
				createdAt: null,
			});
		});

		it("stores a live catalog after a successful refresh", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(true);
			expect(result.catalog.nextRefreshAt).toBeGreaterThan(
				result.catalog.fetchedAt,
			);
			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: null,
				},
			]);
		});

		it("keeps the old cache when a later refresh fails (fail-open)", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await refreshModelCatalog(ctx);

			global.fetch = mock(
				async () => new Response("boom", { status: 500 }),
			) as unknown as typeof fetch;
			const failedResult = await refreshModelCatalog(ctx);

			expect(failedResult.success).toBe(false);
			expect(failedResult.error).toBeTruthy();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});

		it("treats BETTER_CCFLARE_MODELS_OFFLINE=1 as a no-op refresh", async () => {
			process.env.BETTER_CCFLARE_MODELS_OFFLINE = "1";
			const fetchMock = mock(async () => new Response("{}", { status: 200 }));
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("persists the catalog to disk and reloads it in a fresh store instance", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await refreshModelCatalog(ctx);

			// Simulate a process restart: drop the in-memory singleton, keep the file.
			resetModelCatalogForTest();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});

		it("fails an automatic-trigger refresh against an OAuth-only account when the opt-in is not set", async () => {
			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			const result = await refreshModelCatalog(ctx, { trigger: "automatic" });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/BETTER_CCFLARE_MODELS_OAUTH_REFRESH/);
		});

		it("succeeds an automatic-trigger refresh against an OAuth-only account once the opt-in is enabled", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })], {
				oauthRefreshEnabled: true,
			});
			const result = await refreshModelCatalog(ctx, { trigger: "automatic" });

			expect(result.success).toBe(true);
		});

		it("always succeeds a manual-trigger refresh against an OAuth-only account, opt-in or not", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			const result = await refreshModelCatalog(ctx, { trigger: "manual" });

			expect(result.success).toBe(true);
		});

		it("persists nextRefreshAt computed from the configured refresh interval", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "2";
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(true);
			const twoHoursMs = 2 * 60 * 60 * 1000;
			const oneDayMs = 24 * 60 * 60 * 1000;
			expect(result.catalog.nextRefreshAt).toBeGreaterThanOrEqual(
				result.catalog.fetchedAt + twoHoursMs,
			);
			expect(result.catalog.nextRefreshAt).toBeLessThanOrEqual(
				result.catalog.fetchedAt + twoHoursMs + oneDayMs,
			);
		});
	});

	describe("initModelCatalogRefresh", () => {
		it("disables the scheduler entirely when refresh hours is 0 (no fetch, inert unregister)", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0";
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
			expect(typeof unregister).toBe("function");
		});

		it("fires the initial refresh once the freshly-derived due time has already passed", async () => {
			// A tiny refresh interval makes the freshly-derived due time
			// (fetchedAt-of-the-fallback-catalog + interval + jitter) due almost
			// immediately, without needing to seed a disk cache.
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 30));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("live");
		});

		it("does not fire before the freshly-derived due time (persisted recent fetchedAt, default interval)", async () => {
			// Default 168h interval: seed a disk cache with fetchedAt "now" so
			// the derived due time is deterministically far in the future.
			// (Deliberately not relying on the bundled fallback catalog here —
			// since Part D, its fetchedAt is the fixed BUNDLED_MODELS_AS_OF
			// snapshot date rather than "now", which may itself already be more
			// than 168h in the past.)
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now(),
				source: "live",
			});
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 60));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("resumes a refresh from a persisted nextRefreshAt that has already passed", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "168";
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
				nextRefreshAt: Date.now() - 500,
			});

			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).models[0]?.id).toBe("claude-sonnet-5");
		});

		it("does not refresh before a persisted future nextRefreshAt", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "1";
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now(),
				source: "live",
				nextRefreshAt: Date.now() + 60 * 60 * 1000,
			});

			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
			expect((await getModelCatalog()).models[0]?.id).toBe("old-model");
		});

		it("clamps a stale persisted nextRefreshAt down when the refresh interval has been lowered since it was written", async () => {
			const fetchedAt = Date.now();
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt,
				source: "live",
				// Computed under a long-since-abandoned much larger interval.
				nextRefreshAt: fetchedAt + 1000 * 60 * 60 * 1000,
			});
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";

			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
		});

		it("does not run overlapping refreshes while a refresh is still in flight (in-progress guard)", async () => {
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			let fetchCallCount = 0;
			const gate = deferred<Response>();
			global.fetch = mock(async () => {
				fetchCallCount++;
				return gate.promise;
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});

			// Several heartbeat ticks elapse while the first fetch is still
			// pending; none of them should start a second overlapping refresh.
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(fetchCallCount).toBe(1);

			gate.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
						has_more: false,
					}),
					{ status: 200 },
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			unregister();

			expect((await getModelCatalog()).source).toBe("live");
		});

		it("recovers on a later tick once an eligible account becomes available after a failed refresh", async () => {
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			const accounts: Account[] = [];
			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx(accounts);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.03,
			});

			// First tick: no eligible account, refresh fails; fetch never runs.
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(fetchMock).not.toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("fallback");

			// A console account becomes available; a later tick should pick it
			// up rather than waiting out the (already tiny) nominal interval.
			accounts.push(makeAccount());
			await new Promise((resolve) => setTimeout(resolve, 100));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("live");
		});

		it("does not fire if unregistered before the initial refresh check resolves", async () => {
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			unregister();

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("ingestModelsListing", () => {
		it("replaces the catalog outright for a complete listing (has_more: false, no after_id)", async () => {
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: null,
				},
			]);
		});

		it("merges by id (upsert, no deletions) for a partial listing observed while the catalog is already live", async () => {
			await writeCacheFile({
				models: [
					{ id: "model-a", displayName: "Model A", createdAt: null },
					{ id: "model-b", displayName: "Model B (old name)", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "model-b", display_name: "Model B" }],
					has_more: true,
					last_id: "model-b",
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{ id: "model-a", displayName: "Model A", createdAt: null },
				{ id: "model-b", displayName: "Model B", createdAt: null },
			]);
		});

		it("skips a partial listing observed while the existing catalog is still the bundled fallback", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-partial-model", display_name: "Partial Model" }],
					has_more: true,
					last_id: "test-partial-model",
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-partial-model")).toBe(
				false,
			);
		});

		it("treats a request carrying after_id as partial even when the observed page's has_more is false", async () => {
			await writeCacheFile({
				models: [{ id: "model-a", displayName: "Model A", createdAt: null }],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "model-b", display_name: "Model B" }],
					has_more: false,
				}),
				makeAccount(),
				"?after_id=model-a",
			);

			const catalog = await getModelCatalog();
			expect(catalog.models).toEqual([
				{ id: "model-a", displayName: "Model A", createdAt: null },
				{ id: "model-b", displayName: "Model B", createdAt: null },
			]);
		});

		it("does not capture from an account whose provider is not an eligible Anthropic provider", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-exotic-model", display_name: "Exotic Model" }],
					has_more: false,
				}),
				makeAccount({ provider: "zai" }),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-exotic-model")).toBe(
				false,
			);
		});

		it("does not capture from an account with a custom_endpoint override (third-party poisoning gate)", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-foreign-model", display_name: "Foreign Model" }],
					has_more: false,
				}),
				makeAccount({ custom_endpoint: "https://compatible.example.com" }),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-foreign-model")).toBe(
				false,
			);
		});

		it("is a no-op when BETTER_CCFLARE_MODELS_OFFLINE=1", async () => {
			process.env.BETTER_CCFLARE_MODELS_OFFLINE = "1";

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-offline-model", display_name: "Offline Model" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-offline-model")).toBe(
				false,
			);
		});

		it("never throws on a malformed JSON body and leaves the catalog untouched", async () => {
			await expect(
				ingestModelsListing("{not valid json", makeAccount(), null),
			).resolves.toBeUndefined();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
		});

		it("is a no-op when the observed data array is empty", async () => {
			await ingestModelsListing(
				JSON.stringify({ data: [], has_more: false }),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
		});

		it("is a no-op when no account is present", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-no-account-model", display_name: "No Account" }],
					has_more: false,
				}),
				null,
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-no-account-model")).toBe(
				false,
			);
		});

		it("recomputes and persists nextRefreshAt on a successful replace", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.nextRefreshAt).toBeGreaterThan(catalog.fetchedAt);
		});

		it("persists the replaced catalog to disk and reloads it in a fresh store instance", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			resetModelCatalogForTest();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});
	});
});
