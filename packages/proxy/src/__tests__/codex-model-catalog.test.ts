import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexCatalogEvt, codexCatalogEvents } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	CodexProvider,
	clearDerivedAccountModelDefaults,
	clearDerivedProviderModelDefaults,
	hasDerivedProviderModelDefaults,
	resolveModelContextCapability,
	resolveProviderModelDefault,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	CODEX_CATALOG_STALE_ALERT_MS,
	clearCodexModelCacheForAccount,
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	evaluateCodexCatalogStaleness,
	evaluateCodexClientIdentityRecord,
	getCodexModels,
	getKnownCodexModels,
	initCodexModelCatalogRefresh,
	lowestTierCodexModel,
	CATALOG_REFRESH_INTERVAL_MS as REFRESH_INTERVAL_MS,
	reportCatalogRoleRouteFailClosed,
	revalidateUnknownCodexModel,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";

/**
 * The per-subscription model list, and what happens when OpenAI stops
 * answering.
 *
 * This endpoint is not part of OpenAI's public REST reference — it is what the
 * Codex CLI itself calls — so the interesting case is not the happy path. It is
 * the day it changes shape or goes away: the answer must then be the last list
 * OpenAI gave for that account, not a generic catalogue that lists models the
 * subscription cannot call.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-codex",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		...overrides,
	} as Account;
}

function makeCtx(account: Account | null): ProxyContext {
	return {
		dbOps: {
			getAccount: async () => account,
		},
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
}

// Shaped after what a real subscription account returned on 2026-08-09,
// including the two entries OpenAI marks `hide` and the deprecation notices.
const LIVE_BODY = {
	models: [
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			description: "Latest frontier agentic coding model.",
			context_window: 272_000,
			max_context_window: 872_000,
			effective_context_window_percent: 95,
			visibility: "list",
			priority: 1,
		},
		{
			slug: "gpt-5.6-sol-wm",
			display_name: "GPT-5.6-Sol-WM",
			description: "Work Mode routing alias for GPT-5.6 Sol.",
			visibility: "hide",
			priority: 1,
		},
		{
			slug: "gpt-5.4-mini",
			display_name: "GPT-5.4-Mini",
			visibility: "list",
			priority: 23,
			upgrade: { model: "gpt-5.6-luna" },
		},
		{
			slug: "codex-auto-review",
			display_name: "Codex Auto Review",
			visibility: "hide",
			priority: 43,
		},
		// Duplicated and empty ids do not become entries.
		{ slug: "gpt-5.6-sol", visibility: "list" },
		{ slug: "  ", visibility: "list" },
	],
};

const NEW_FRONTIER_BODY = {
	models: [
		{
			slug: "gpt-6-codex",
			display_name: "GPT-6-Codex",
			visibility: "list",
			priority: 1,
		},
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			visibility: "list",
			priority: 2,
		},
	],
};

async function waitForFetchCount(
	readCount: () => number,
	expected: number,
): Promise<void> {
	for (let i = 0; i < 20 && readCount() < expected; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(readCount()).toBe(expected);
}

// A real (unmocked) wall-clock wait, for tests that mock Date.now to control
// application-level scheduling math while still needing the real
// setInterval-backed heartbeat to actually fire between waypoints.
async function waitRealMs(totalMs: number, stepMs = 5): Promise<void> {
	const steps = Math.max(1, Math.ceil(totalMs / stepMs));
	for (let i = 0; i < steps; i++) {
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

async function waitForWarnCall(
	warnSpy: { mock: { calls: unknown[][] } },
	substring: string,
	iterations = 20,
): Promise<void> {
	for (
		let i = 0;
		i < iterations &&
		!warnSpy.mock.calls.some((call) => String(call[0]).includes(substring));
		i++
	) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(
		warnSpy.mock.calls.some((call) => String(call[0]).includes(substring)),
	).toBe(true);
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	// getCodexModels() writes into the process-wide derived-defaults registry
	// (provider-model-defaults.ts); left uncleared it leaks into any other
	// test file that runs in the same bun process, e.g. provider.test.ts.
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
});

describe("getCodexModels", () => {
	it("pairs catalog version and user agent across credential awaits", async () => {
		const oldVersion = process.env.CCFLARE_CODEX_CLIENT_VERSION;
		const requests: Request[] = [];
		try {
			process.env.CCFLARE_CODEX_CLIENT_VERSION = "0.171.0";
			globalThis.fetch = (async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json(LIVE_BODY);
			}) as typeof globalThis.fetch;
			const pending = getCodexModels("acc-codex", makeCtx(makeAccount()));
			// Allow the account lookup to complete; fetchLive snapshots before its token await.
			await Promise.resolve();
			process.env.CCFLARE_CODEX_CLIENT_VERSION = "0.172.0";
			await pending;
			expect(new URL(requests[0].url).searchParams.get("client_version")).toBe(
				"0.171.0",
			);
			expect(requests[0].headers.get("User-Agent")).toBe(
				"codex_cli_rs/0.171.0",
			);
			expect(requests[0].headers.get("originator")).toBe("codex_cli_rs");
		} finally {
			if (oldVersion === undefined)
				delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
			else process.env.CCFLARE_CODEX_CLIENT_VERSION = oldVersion;
		}
	});
	it("uses the current inference version when discovering Sol and Luna", async () => {
		const requests: Request[] = [];
		globalThis.fetch = (async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(
				JSON.stringify({
					models: [
						{ slug: "gpt-6-sol", visibility: "list", priority: 1 },
						{ slug: "gpt-6-luna", visibility: "list", priority: 2 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));
		const inferenceHeaders = new CodexProvider().prepareHeaders(
			new Headers(),
			"test-token",
		);

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			"https://chatgpt.com/backend-api/codex/models?client_version=0.156.0",
		);
		expect(requests[0].headers.get("User-Agent")).toBe("codex_cli_rs/0.156.0");
		expect(requests[0].headers.get("originator")).toBe("codex_cli_rs");
		expect(inferenceHeaders.get("Version")).toBe("0.156.0");
		expect(new URL(requests[0].url).searchParams.get("client_version")).toBe(
			inferenceHeaders.get("Version"),
		);
		expect(listing?.source).toBe("live");
		expect(listing?.models.map((model) => model.id)).toEqual([
			"gpt-6-sol",
			"gpt-6-luna",
		]);
	});

	it("reads the subscription's own list and keeps the useful fields", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(listing?.source).toBe("live");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
		expect(listing?.models[0].contextWindow).toBe(272_000);
		// The catalog's default and max are DIFFERENT concepts: keep both, so
		// consumers stop treating the 272k recommendation as capacity (#205).
		expect(listing?.models[0].maxContextWindow).toBe(872_000);
		expect(listing?.models[0].effectiveContextPercent).toBe(95);
		// Absent fields stay null rather than inventing values.
		expect(listing?.models[1].maxContextWindow).toBeNull();
		expect(listing?.models[1].effectiveContextPercent).toBeNull();
		// OpenAI's own ordering, not alphabetical — which would have opened the
		// list with the mini model.
		expect(listing?.models[0].id).toBe("gpt-5.6-sol");
		expect(listing?.models[0].description).toContain("frontier");
		expect(listing?.models[1].displayName).toBe("GPT-5.4-Mini");
	});

	// The payload marks routing aliases and internal models as `hide`. Reading
	// the flag beats matching on the name: the next alias OpenAI ships is
	// excluded without anyone having to learn its suffix.
	it("leaves out the entries OpenAI marks as hidden", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));
		const ids = listing?.models.map((m) => m.id) ?? [];

		expect(ids).not.toContain("gpt-5.6-sol-wm");
		expect(ids).not.toContain("codex-auto-review");
		expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
	});

	// A model on its way out is a choice someone will have to undo later.
	it("carries the replacement OpenAI names for a deprecated model", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));
		const mini = listing?.models.find((m) => m.id === "gpt-5.4-mini");

		expect(mini?.supersededBy).toBe("gpt-5.6-luna");
		expect(listing?.models[0].supersededBy).toBeNull();
	});

	// The reason the cache exists.
	it("serves the last successful list when OpenAI stops answering", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(listing?.source).toBe("cached");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
	});

	// Measured on real accounts: two of three answer HTTP 401 here while serving
	// traffic perfectly. Their own list will never exist, and an empty field
	// forever is worse than another account's list plainly labelled as such.
	it("inherits from another account of the provider when it cannot read", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;
		const listing = await getCodexModels(
			"acc-blind",
			makeCtx(makeAccount({ id: "acc-blind" })),
		);

		expect(listing?.source).toBe("shared");
		expect(listing?.borrowedFrom).toBe("acc-codex");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
	});

	it("does not present a shared catalog as first-hand account knowledge", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(getKnownCodexModels("acc-codex")?.source).toBe("cached");
		expect(getKnownCodexModels("acc-blind")).toBeNull();
	});

	// A 200 carrying nothing usable is not an answer. Recording it would mark the
	// account as resolved and stop every later attempt, freezing it with no
	// defaults because of one odd response.
	it("treats a listing with no usable models as a failure", async () => {
		clearCodexModelCacheForTests();
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ models: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		expect(
			await getCodexModels(
				"acc-empty",
				makeCtx(makeAccount({ id: "acc-empty" })),
			),
		).toBeNull();

		// And the account is not stuck: a later real answer still lands.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		const listing = await getCodexModels(
			"acc-empty",
			makeCtx(makeAccount({ id: "acc-empty" })),
		);

		expect(listing?.source).toBe("live");
	});

	it("returns nothing when no account of the provider has ever read", async () => {
		clearCodexModelCacheForTests();
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;

		expect(
			await getCodexModels(
				"acc-never-read",
				makeCtx(makeAccount({ id: "acc-never-read" })),
			),
		).toBeNull();
	});

	it("refuses an account that is not a Codex account", async () => {
		const listing = await getCodexModels(
			"acc-codex",
			makeCtx(makeAccount({ provider: "anthropic" })),
		);

		expect(listing).toBeNull();
	});

	it("returns nothing for an account that does not exist", async () => {
		expect(await getCodexModels("ghost", makeCtx(null))).toBeNull();
	});
});

describe("periodic Codex catalog freshness", () => {
	it("coalesces unknown-model revalidation and observes an account cooldown", async () => {
		const account = makeAccount();
		const ctx = makeCtx(account);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json(calls === 1 ? LIVE_BODY : NEW_FRONTIER_BODY);
		}) as typeof globalThis.fetch;
		await getCodexModels(account.id, ctx);
		await Promise.all(
			Array.from({ length: 12 }, () =>
				revalidateUnknownCodexModel(account, "gpt-6-codex", ctx),
			),
		);
		expect(calls).toBe(2);
		await revalidateUnknownCodexModel(account, "unlisted-next", ctx);
		expect(calls).toBe(2);
		expect(getKnownCodexModels(account.id)?.models[0].id).toBe("gpt-6-codex");
	});

	it("schedules only active Codex accounts and stops on shutdown", async () => {
		const codex = makeAccount();
		const paused = makeAccount({ id: "paused", paused: true });
		const foreign = makeAccount({ id: "foreign", provider: "xai" });
		const ctx = makeCtx(codex);
		ctx.dbOps.getAllAccounts = async () => [codex, paused, foreign];
		const calls: string[] = [];
		globalThis.fetch = (async () => {
			calls.push("fetch");
			return Response.json(LIVE_BODY);
		}) as typeof globalThis.fetch;
		const stop = initCodexModelCatalogRefresh(ctx, {
			initialDelayMs: 1,
			tickSeconds: 1,
		});
		try {
			await waitForFetchCount(() => calls.length, 1);
			expect(getKnownCodexModels(paused.id)).toBeNull();
			expect(getKnownCodexModels(foreign.id)).toBeNull();
		} finally {
			stop();
		}
		expect(calls).toHaveLength(1);
	});

	// nextRefreshAt used to be pinned at *tick-start* + 15min (+ jitter),
	// independent of how long that tick's own fetch actually took. Any
	// account whose fetch finishes late within its tick misses the next
	// tick's own per-account freshness check (it isn't 15 real minutes
	// stale *yet*, by ensureCodexModelDefaults's own fetchedAt-based
	// clock) and then gets rescheduled a further 15 minutes out from that
	// *skipped* tick's start -- silently doubling its true refresh
	// interval. Anchoring nextRefreshAt to tick *completion* keeps the
	// heartbeat's own due-check aligned with the per-account check it
	// gates, for every account touched that tick.
	it("does not skip an account's next refresh when its fetch finishes late in a tick", async () => {
		const BASE_NOW = 1_800_000_000_000;
		const CATALOG_REFRESH_INTERVAL_MS = 15 * 60_000;
		const FETCH_DELAY_MS = 2 * 60_000;
		let currentNow = BASE_NOW;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => currentNow);
		const randomSpy = spyOn(Math, "random").mockReturnValue(0);
		try {
			const account = makeAccount({
				expires_at: BASE_NOW + 10 * 3_600_000,
			});
			const ctx = makeCtx(account);
			ctx.dbOps.getAllAccounts = async () => [account];
			let fetchCount = 0;
			globalThis.fetch = (async () => {
				fetchCount++;
				// This account's own fetch takes real (simulated) time; its
				// fetchedAt is stamped only once this resolves, inside
				// getCodexModels -- not at tick start.
				currentNow += FETCH_DELAY_MS;
				return Response.json(LIVE_BODY);
			}) as typeof globalThis.fetch;

			const stop = initCodexModelCatalogRefresh(ctx, {
				initialDelayMs: 1,
				tickSeconds: 0.01,
			});
			try {
				await waitForFetchCount(() => fetchCount, 1);
				const firstFetchedAt = getKnownCodexModels(account.id)?.fetchedAt;
				expect(firstFetchedAt).toBe(BASE_NOW + FETCH_DELAY_MS);

				// The old tick-start-anchored nextRefreshAt would open here.
				// The account is not yet 15 real minutes past its own
				// fetchedAt, so a correct per-account check still holds it.
				currentNow = BASE_NOW + CATALOG_REFRESH_INTERVAL_MS;
				await waitRealMs(40);

				// The account's true due point: 15 minutes after its own
				// fetchedAt (not after tick start). Bounded polling (rather than a
				// fixed real-time wait) for this positive assertion: it only needs
				// the heartbeat to fire at least once more, so it should not force
				// every run to pay a fixed 60ms regardless of how quickly that
				// actually happens, nor risk flaking on a slower CI host.
				currentNow = BASE_NOW + FETCH_DELAY_MS + CATALOG_REFRESH_INTERVAL_MS;
				await waitForFetchCount(() => fetchCount, 2);

				expect(getKnownCodexModels(account.id)?.fetchedAt).toBe(
					BASE_NOW + CATALOG_REFRESH_INTERVAL_MS + 2 * FETCH_DELAY_MS,
				);
			} finally {
				stop();
			}
		} finally {
			nowSpy.mockRestore();
			randomSpy.mockRestore();
		}
	});

	it("warns when the eligible Codex account list exceeds the refresh cap", async () => {
		const accounts = Array.from({ length: 103 }, (_, i) =>
			makeAccount({ id: `acc-${i}` }),
		);
		const ctx = makeCtx(accounts[0]);
		ctx.dbOps.getAllAccounts = async () => accounts;
		globalThis.fetch = (async () =>
			Response.json(LIVE_BODY)) as typeof globalThis.fetch;
		const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
			() => undefined,
		);
		const stop = initCodexModelCatalogRefresh(ctx, {
			initialDelayMs: 1,
			tickSeconds: 1,
		});
		try {
			await waitForWarnCall(warnSpy, "100 of 103");
			const call = warnSpy.mock.calls.find((c) =>
				String(c[0]).includes("100 of 103"),
			);
			expect(String(call?.[0])).toContain("3");
		} finally {
			stop();
			warnSpy.mockRestore();
		}
	});

	it("does not warn when the eligible Codex account list is within the refresh cap", async () => {
		const codex = makeAccount();
		const ctx = makeCtx(codex);
		ctx.dbOps.getAllAccounts = async () => [codex];
		globalThis.fetch = (async () =>
			Response.json(LIVE_BODY)) as typeof globalThis.fetch;
		const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
			() => undefined,
		);
		const stop = initCodexModelCatalogRefresh(ctx, {
			initialDelayMs: 1,
			tickSeconds: 1,
		});
		try {
			await waitRealMs(30);
			expect(
				warnSpy.mock.calls.some((c) => String(c[0]).includes("eligible")),
			).toBe(false);
		} finally {
			stop();
			warnSpy.mockRestore();
		}
	});
	it("returns the warm listing without waiting for a stalled stale refresh and coalesces callers", async () => {
		const account = makeAccount();
		const ctx = makeCtx(account);
		let calls = 0;
		let release!: () => void;
		globalThis.fetch = (async () => {
			calls++;
			if (calls === 1) return Response.json(LIVE_BODY);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return Response.json(NEW_FRONTIER_BODY);
		}) as typeof globalThis.fetch;
		await getCodexModels(account.id, ctx);
		const due = () => Date.now() + 16 * 60_000;
		const first = ensureCodexModelDefaults(account, ctx, due);
		await waitForFetchCount(() => calls, 2);
		let settled = false;
		void first.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		await ensureCodexModelDefaults(account, ctx, due);
		expect(calls).toBe(2);
		expect(getKnownCodexModels(account.id)?.models[0].id).toBe("gpt-5.6-sol");
		release();
		await waitForFetchCount(
			() =>
				getKnownCodexModels(account.id)?.models[0].id === "gpt-6-codex" ? 1 : 0,
			1,
		);
	});

	it("refreshes an existing own listing after fifteen minutes and retains it on failure", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return calls === 1
				? new Response(JSON.stringify(LIVE_BODY), { status: 200 })
				: new Response("unavailable", { status: 503 });
		}) as typeof globalThis.fetch;
		const account = makeAccount();
		const ctx = makeCtx(account);
		await ensureCodexModelDefaults(account, ctx);
		expect(calls).toBe(1);
		await ensureCodexModelDefaults(
			account,
			ctx,
			() => Date.now() + 16 * 60_000,
		);
		// A warm request returns before the advisory fetch settles.
		await waitForFetchCount(() => calls, 2);
		expect(calls).toBe(2);
		expect(getKnownCodexModels(account.id)?.models[0].id).toBe("gpt-5.6-sol");
	});
});

describe("catalog-backed capacities", () => {
	it("accepts safe large catalog windows and never invents capacity for missing scalars", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				models: [
					{
						slug: "gpt-6-wide",
						visibility: "list",
						context_window: 272_000,
						max_context_window: 4_000_000,
						effective_context_window_percent: 95,
					},
					{ slug: "gpt-5.6-sol", visibility: "list", context_window: 272_000 },
				],
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));
		expect(
			resolveModelContextCapability("codex", "gpt-6-wide", "acc-codex")
				?.effectiveContextWindow,
		).toBe(3_800_000);
		expect(
			resolveModelContextCapability("codex", "gpt-5.6-sol", "acc-codex"),
		).toBeUndefined();
	});

	it("publishes bounded model capacity per account without leaking to other accounts", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-6-luna",
							visibility: "list",
							priority: 1,
							context_window: 272000,
							max_context_window: 872000,
							effective_context_window_percent: 95,
						},
						{
							slug: "bad-window",
							visibility: "list",
							priority: 2,
							context_window: -1,
							max_context_window: 1e30,
							effective_context_window_percent: 105,
						},
					],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));
		expect(
			resolveModelContextCapability("codex", "gpt-6-luna", "acc-codex"),
		).toMatchObject({
			defaultContextWindow: 272000,
			maxContextWindow: 872000,
			effectiveContextWindow: 828400,
			match: "exact",
		});
		expect(
			resolveModelContextCapability("codex", "gpt-6-luna", "other-account"),
		).toBeUndefined();
		expect(
			resolveModelContextCapability("codex", "bad-window", "acc-codex"),
		).toBeUndefined();
	});
});

describe("lowestTierCodexModel", () => {
	it("names the weakest visible model in provider priority order", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(lowestTierCodexModel(listing)).toBe("gpt-5.4-mini");
		expect(lowestTierCodexModel(listing)).not.toBe("gpt-5.6-sol");
	});

	it("returns the only model when a plan lists one", () => {
		expect(
			lowestTierCodexModel({
				accountId: "acc-codex",
				models: [
					{
						id: "gpt-5.6-sol",
						displayName: "GPT-5.6-Sol",
						description: null,
						contextWindow: null,
						maxContextWindow: null,
						effectiveContextPercent: null,
						supersededBy: null,
					},
				],
				fetchedAt: 0,
				source: "live",
			}),
		).toBe("gpt-5.6-sol");
	});

	it("returns null when there is no listing to read", () => {
		expect(lowestTierCodexModel(null)).toBeNull();
		expect(lowestTierCodexModel(undefined)).toBeNull();
		expect(
			lowestTierCodexModel({
				accountId: "acc-codex",
				models: [],
				fetchedAt: 0,
				source: "live",
			}),
		).toBeNull();
	});
});

describe("derived-default provenance", () => {
	it("clears exact-account defaults without discarding provider-wide advice", () => {
		setDerivedProviderModelDefaults("codex", "acc-cleared-default", {
			fable: "gpt-6-codex",
			opus: "gpt-6-codex",
			sonnet: "gpt-5.6-sol",
			haiku: "gpt-5.6-sol",
		});

		clearDerivedAccountModelDefaults("codex", "acc-cleared-default");

		expect(
			hasDerivedProviderModelDefaults("codex", "acc-cleared-default"),
		).toBe(false);
		expect(
			resolveProviderModelDefault("codex", "fable", "acc-cleared-default"),
		).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
	});

	it("does not mark a borrowed listing as exact or change provider defaults", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels(
			"acc-source",
			makeCtx(makeAccount({ id: "acc-source" })),
		);

		// Keep the shared catalog on the older source account while advancing the
		// provider-wide default independently. A borrowed result must mutate neither.
		setDerivedProviderModelDefaults("codex", "acc-frontier", {
			fable: "gpt-6-codex",
			opus: "gpt-6-codex",
			sonnet: "gpt-5.6-sol",
			haiku: "gpt-5.6-sol",
		});
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;

		const listing = await getCodexModels(
			"acc-borrower",
			makeCtx(makeAccount({ id: "acc-borrower" })),
		);

		expect(listing?.source).toBe("shared");
		expect(hasDerivedProviderModelDefaults("codex", "acc-borrower")).toBe(
			false,
		);
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
	});

	it("restores a cached account default without rolling back the provider frontier", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-a", makeCtx(makeAccount({ id: "acc-a" })));

		globalThis.fetch = (async () =>
			new Response(JSON.stringify(NEW_FRONTIER_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-b", makeCtx(makeAccount({ id: "acc-b" })));
		// Simulate a later consumer rebuilding derived defaults from current
		// provider evidence while the per-account catalog cache survives.
		clearDerivedProviderModelDefaults();
		setDerivedProviderModelDefaults("codex", "acc-b", {
			fable: "gpt-6-codex",
			opus: "gpt-6-codex",
			sonnet: "gpt-5.6-sol",
			haiku: "gpt-5.6-sol",
		});

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const cached = await getCodexModels(
			"acc-a",
			makeCtx(makeAccount({ id: "acc-a" })),
		);

		expect(cached?.source).toBe("cached");
		expect(resolveProviderModelDefault("codex", "fable", "acc-a")).toBe(
			"gpt-5.6-sol",
		);
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
	});

	it("keeps newer provider-wide evidence when an older account finishes later", async () => {
		let fetches = 0;
		const pending: Array<(response: Response) => void> = [];
		const olderAccount = makeAccount({ id: "acc-older-publication" });
		const newerAccount = makeAccount({ id: "acc-newer-publication" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => pending.push(resolve));
		}) as typeof globalThis.fetch;

		const olderRequest = getCodexModels(olderAccount.id, makeCtx(olderAccount));
		await waitForFetchCount(() => fetches, 1);
		const newerRequest = getCodexModels(newerAccount.id, makeCtx(newerAccount));
		await waitForFetchCount(() => fetches, 2);

		pending[1](
			new Response(JSON.stringify(NEW_FRONTIER_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const newerListing = await newerRequest;
		expect(newerListing?.models[0].id).toBe("gpt-6-codex");

		pending[0](
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const olderListing = await olderRequest;
		expect(olderListing?.models[0].id).toBe("gpt-5.6-sol");
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable", olderAccount.id)).toBe(
			"gpt-5.6-sol",
		);
		expect(resolveProviderModelDefault("codex", "fable", newerAccount.id)).toBe(
			"gpt-6-codex",
		);

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const shared = await getCodexModels(
			"acc-publication-borrower",
			makeCtx(makeAccount({ id: "acc-publication-borrower" })),
		);
		expect(shared?.source).toBe("shared");
		expect(shared?.borrowedFrom).toBe(newerAccount.id);
		expect(shared?.models[0].id).toBe("gpt-6-codex");

		const olderCached = await getCodexModels(
			olderAccount.id,
			makeCtx(olderAccount),
		);
		expect(olderCached?.source).toBe("cached");
		expect(olderCached?.models[0].id).toBe("gpt-5.6-sol");
	});

	it("keeps post-reset provider evidence ahead of an older pre-reset request", async () => {
		let fetches = 0;
		const pending: Array<(response: Response) => void> = [];
		const preResetAccount = makeAccount({ id: "acc-pre-reset" });
		const postResetAccount = makeAccount({ id: "acc-post-reset" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => pending.push(resolve));
		}) as typeof globalThis.fetch;

		const preResetRequest = getCodexModels(
			preResetAccount.id,
			makeCtx(preResetAccount),
		);
		await waitForFetchCount(() => fetches, 1);
		clearCodexModelCacheForTests();
		clearDerivedProviderModelDefaults();
		const postResetRequest = getCodexModels(
			postResetAccount.id,
			makeCtx(postResetAccount),
		);
		await waitForFetchCount(() => fetches, 2);

		pending[1](
			new Response(JSON.stringify(NEW_FRONTIER_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const postResetListing = await postResetRequest;
		expect(postResetListing?.models[0].id).toBe("gpt-6-codex");

		pending[0](
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const preResetListing = await preResetRequest;
		expect(preResetListing?.models[0].id).toBe("gpt-5.6-sol");
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
		expect(
			resolveProviderModelDefault("codex", "fable", preResetAccount.id),
		).toBe("gpt-5.6-sol");
		expect(
			resolveProviderModelDefault("codex", "fable", postResetAccount.id),
		).toBe("gpt-6-codex");

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const shared = await getCodexModels(
			"acc-reset-borrower",
			makeCtx(makeAccount({ id: "acc-reset-borrower" })),
		);
		expect(shared?.source).toBe("shared");
		expect(shared?.borrowedFrom).toBe(postResetAccount.id);
		expect(shared?.models[0].id).toBe("gpt-6-codex");
	});

	it("does not publish a deleted account's stale fetch but retains provider advice", async () => {
		let resolveStaleFetch: ((response: Response) => void) | undefined;
		const source = makeAccount({ id: "acc-advisory-source" });
		const deleted = makeAccount({ id: "acc-deleted-during-fetch" });
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels(deleted.id, makeCtx(deleted));
		expect(getKnownCodexModels(deleted.id)).not.toBeNull();
		await getCodexModels(source.id, makeCtx(source));

		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				resolveStaleFetch = resolve;
			})) as typeof globalThis.fetch;
		const staleRequest = getCodexModels(deleted.id, makeCtx(deleted));
		await waitForFetchCount(() => (resolveStaleFetch ? 1 : 0), 1);

		clearCodexModelCacheForAccount(deleted.id);
		resolveStaleFetch?.(
			new Response(JSON.stringify(NEW_FRONTIER_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const staleListing = await staleRequest;

		expect(staleListing?.source).toBe("live");
		expect(staleListing?.models[0].id).toBe("gpt-6-codex");
		expect(getKnownCodexModels(deleted.id)).toBeNull();
		expect(hasDerivedProviderModelDefaults("codex", deleted.id)).toBe(false);
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-5.6-sol");

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const shared = await getCodexModels(deleted.id, makeCtx(deleted));
		expect(shared?.source).toBe("shared");
		expect(shared?.borrowedFrom).toBe(source.id);
	});
});

describe("ensureCodexModelDefaults", () => {
	it("suppresses immediate retries and follows the capped retry schedule", async () => {
		let now = 10_000;
		let fetches = 0;
		const account = makeAccount({ id: "acc-backoff" });
		globalThis.fetch = (async () => {
			fetches++;
			return new Response("nope", { status: 401 });
		}) as typeof globalThis.fetch;

		await ensureCodexModelDefaults(account, makeCtx(account), () => now);
		expect(fetches).toBe(1);

		let expectedFetches = 1;
		for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
			now += delay - 1;
			await ensureCodexModelDefaults(account, makeCtx(account), () => now);
			expect(fetches).toBe(expectedFetches);
			now += 1;
			await ensureCodexModelDefaults(account, makeCtx(account), () => now);
			expectedFetches++;
			expect(fetches).toBe(expectedFetches);
		}
	});

	it("keeps retrying a shared result because it is not exact for the account", async () => {
		let now = 20_000;
		let fetches = 0;
		const source = makeAccount({ id: "acc-source" });
		globalThis.fetch = (async () => {
			fetches++;
			return new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		await getCodexModels(source.id, makeCtx(source));

		const borrower = makeAccount({ id: "acc-borrower" });
		globalThis.fetch = (async () => {
			fetches++;
			return new Response("nope", { status: 401 });
		}) as typeof globalThis.fetch;
		await ensureCodexModelDefaults(borrower, makeCtx(borrower), () => now);
		expect(fetches).toBe(2);
		expect(hasDerivedProviderModelDefaults("codex", borrower.id)).toBe(false);

		await ensureCodexModelDefaults(borrower, makeCtx(borrower), () => now);
		expect(fetches).toBe(2);
		now += 60_000;
		await ensureCodexModelDefaults(borrower, makeCtx(borrower), () => now);
		expect(fetches).toBe(3);
	});

	it("shares one live fetch between concurrent ensures for an account", async () => {
		let fetches = 0;
		let resolveFetch: ((response: Response) => void) | undefined;
		const account = makeAccount({ id: "acc-concurrent" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
		}) as typeof globalThis.fetch;

		const first = ensureCodexModelDefaults(account, makeCtx(account));
		const second = ensureCodexModelDefaults(account, makeCtx(account));
		await waitForFetchCount(() => fetches, 1);
		resolveFetch?.(
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await Promise.all([first, second]);

		expect(fetches).toBe(1);
		expect(hasDerivedProviderModelDefaults("codex", account.id)).toBe(true);
	});

	it("does not let an older direct fetch overwrite a newer ensured listing", async () => {
		let fetches = 0;
		const pending: Array<(response: Response) => void> = [];
		const account = makeAccount({ id: "acc-publication-order" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => pending.push(resolve));
		}) as typeof globalThis.fetch;

		const olderDirect = getCodexModels(account.id, makeCtx(account));
		await waitForFetchCount(() => fetches, 1);
		const newerEnsure = ensureCodexModelDefaults(account, makeCtx(account));
		await waitForFetchCount(() => fetches, 2);

		pending[1](
			new Response(JSON.stringify(NEW_FRONTIER_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await newerEnsure;
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable", account.id)).toBe(
			"gpt-6-codex",
		);

		pending[0](
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const olderListing = await olderDirect;
		expect(olderListing?.models[0].id).toBe("gpt-5.6-sol");
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable", account.id)).toBe(
			"gpt-6-codex",
		);

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const cached = await getCodexModels(account.id, makeCtx(account));
		expect(cached?.source).toBe("cached");
		expect(cached?.models[0].id).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable")).toBe("gpt-6-codex");
		expect(resolveProviderModelDefault("codex", "fable", account.id)).toBe(
			"gpt-6-codex",
		);
	});

	it("does not recreate deletion-cleared retry state when a stale ensure fails", async () => {
		let fetches = 0;
		let resolveStaleFetch: ((response: Response) => void) | undefined;
		const account = makeAccount({ id: "acc-stale-retry" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => {
				resolveStaleFetch = resolve;
			});
		}) as typeof globalThis.fetch;

		const staleEnsure = ensureCodexModelDefaults(
			account,
			makeCtx(account),
			() => 50_000,
		);
		await waitForFetchCount(() => fetches, 1);
		clearCodexModelCacheForAccount(account.id);
		resolveStaleFetch?.(new Response("nope", { status: 401 }));
		await staleEnsure;

		const replacementEnsure = ensureCodexModelDefaults(
			account,
			makeCtx(account),
			() => 50_000,
		);
		await waitForFetchCount(() => fetches, 2);
		resolveStaleFetch?.(
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await replacementEnsure;
	});

	it("lets a replacement ensure own the in-flight slot after account deletion", async () => {
		let now = 30_000;
		let fetches = 0;
		const pending: Array<(response: Response) => void> = [];
		const account = makeAccount({ id: "acc-identity" });
		globalThis.fetch = (() => {
			fetches++;
			return new Promise<Response>((resolve) => pending.push(resolve));
		}) as typeof globalThis.fetch;

		const oldEnsure = ensureCodexModelDefaults(
			account,
			makeCtx(account),
			() => now,
		);
		await waitForFetchCount(() => fetches, 1);
		clearCodexModelCacheForAccount(account.id);
		const currentEnsure = ensureCodexModelDefaults(
			account,
			makeCtx(account),
			() => now,
		);
		await waitForFetchCount(() => fetches, 2);

		pending[0](new Response("nope", { status: 401 }));
		await oldEnsure;
		now += 60_000;
		const joinedEnsure = ensureCodexModelDefaults(
			account,
			makeCtx(account),
			() => now,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetches).toBe(2);

		pending[1](new Response("nope", { status: 401 }));
		await Promise.all([currentEnsure, joinedEnsure]);
	});

	it("caps retry bookkeeping at 1000 accounts and evicts by insertion order", async () => {
		let lookups = 0;
		const now = 40_000;
		const throwingCtx = (): ProxyContext =>
			({
				dbOps: {
					getAccount: async () => {
						lookups++;
						throw new Error("database unavailable");
					},
				},
				refreshInFlight: new Map(),
			}) as unknown as ProxyContext;

		for (let i = 0; i < 1_001; i++) {
			const account = makeAccount({ id: `acc-cap-${i}` });
			await ensureCodexModelDefaults(account, throwingCtx(), () => now);
		}
		expect(lookups).toBe(1_001);

		// The oldest key was evicted and retries; the newest remains suppressed.
		const oldest = makeAccount({ id: "acc-cap-0" });
		await ensureCodexModelDefaults(oldest, throwingCtx(), () => now);
		expect(lookups).toBe(1_002);
		const newest = makeAccount({ id: "acc-cap-1000" });
		await ensureCodexModelDefaults(newest, throwingCtx(), () => now);
		expect(lookups).toBe(1_002);
	});

	it("clears retry suppression with the catalog test reset", async () => {
		let fetches = 0;
		const account = makeAccount({ id: "acc-reset" });
		globalThis.fetch = (async () => {
			fetches++;
			return new Response("nope", { status: 401 });
		}) as typeof globalThis.fetch;

		await ensureCodexModelDefaults(account, makeCtx(account), () => 50_000);
		await ensureCodexModelDefaults(account, makeCtx(account), () => 50_000);
		expect(fetches).toBe(1);

		clearCodexModelCacheForTests();
		await ensureCodexModelDefaults(account, makeCtx(account), () => 50_000);
		expect(fetches).toBe(2);
	});
});

/**
 * The catalog side of the Codex alerts (issue #370 unit 6): the proxy only
 * emits typed events on the core bus; AlertService turns them into alerts.
 */
type CatalogEventOf<T extends CodexCatalogEvt["type"]> = Extract<
	CodexCatalogEvt,
	{ type: T }
>;

function collectCatalogEvents() {
	const events: CodexCatalogEvt[] = [];
	const listener = (event: CodexCatalogEvt) => {
		events.push(event);
	};
	codexCatalogEvents.on("event", listener);
	return {
		events,
		of<T extends CodexCatalogEvt["type"]>(type: T): CatalogEventOf<T>[] {
			return events.filter(
				(event): event is CatalogEventOf<T> => event.type === type,
			);
		},
		stop() {
			codexCatalogEvents.off("event", listener);
		},
	};
}

function serve(body: unknown, status = 200): void {
	globalThis.fetch = (async () =>
		typeof body === "string"
			? new Response(body, { status })
			: new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof globalThis.fetch;
}

/** Bounded polling for a positive assertion; never a fixed real-time wait. */
async function waitUntil(
	predicate: () => boolean,
	iterations = 400,
): Promise<void> {
	for (let i = 0; i < iterations && !predicate(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(predicate()).toBe(true);
}

describe("Codex catalog alert events", () => {
	let collected: ReturnType<typeof collectCatalogEvents>;

	beforeEach(() => {
		collected = collectCatalogEvents();
	});

	afterEach(() => {
		collected.stop();
	});

	it("publishes a first own catalog without reporting a role change", async () => {
		serve(LIVE_BODY);
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(collected.of("role_target_changed")).toEqual([]);
		expect(collected.of("own_catalog_published")).toEqual([
			{
				type: "own_catalog_published",
				accountId: "acc-codex",
				accountName: "codex-account",
				models: ["gpt-5.6-sol", "gpt-5.4-mini"],
				roleTargets: {
					fable: "gpt-5.6-sol",
					opus: "gpt-5.6-sol",
					sonnet: "gpt-5.4-mini",
					haiku: "gpt-5.4-mini",
				},
			},
		]);
	});

	it("reports each changed role target exactly once and nothing on a same-value republish", async () => {
		const ctx = makeCtx(makeAccount());
		serve(LIVE_BODY);
		await getCodexModels("acc-codex", ctx);
		serve(NEW_FRONTIER_BODY);
		await getCodexModels("acc-codex", ctx);

		const changes = [
			{ family: "fable", from: "gpt-5.6-sol", to: "gpt-6-codex" },
			{ family: "opus", from: "gpt-5.6-sol", to: "gpt-6-codex" },
			{ family: "sonnet", from: "gpt-5.4-mini", to: "gpt-5.6-sol" },
			{ family: "haiku", from: "gpt-5.4-mini", to: "gpt-5.6-sol" },
		] as const;
		const expected = changes.map(
			(change): CatalogEventOf<"role_target_changed"> => ({
				type: "role_target_changed",
				accountId: "acc-codex",
				accountName: "codex-account",
				...change,
			}),
		);
		expect(collected.of("role_target_changed")).toEqual(expected);

		await getCodexModels("acc-codex", ctx);
		expect(collected.of("role_target_changed")).toEqual(expected);
		expect(collected.of("own_catalog_published")).toHaveLength(3);
	});

	it("emits nothing for a failed, empty or malformed refresh", async () => {
		const ctx = makeCtx(makeAccount());
		serve(LIVE_BODY);
		await getCodexModels("acc-codex", ctx);
		collected.events.length = 0;

		const replies: Array<[unknown, number]> = [
			["unavailable", 503],
			[{ models: [] }, 200],
			["{not json", 200],
			[{ models: "gpt-9" }, 200],
			[null, 200],
			[{ models: [{ slug: 42, visibility: "list" }] }, 200],
		];
		for (const [body, status] of replies) {
			serve(body, status);
			const listing = await getCodexModels("acc-codex", ctx);
			expect(listing?.source).toBe("cached");
		}

		expect(collected.events).toEqual([]);
		expect(
			getKnownCodexModels("acc-codex")?.models.map((model) => model.id),
		).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
	});

	it("never publishes a borrowed listing as the borrower's own", async () => {
		serve(LIVE_BODY);
		await getCodexModels("acc-codex", makeCtx(makeAccount()));
		collected.events.length = 0;

		serve("nope", 401);
		const listing = await getCodexModels(
			"acc-blind",
			makeCtx(makeAccount({ id: "acc-blind" })),
		);

		expect(listing?.source).toBe("shared");
		expect(collected.events).toEqual([]);
	});

	it("treats a recreated account's first publication as a first load", async () => {
		const ctx = makeCtx(makeAccount());
		serve(LIVE_BODY);
		await getCodexModels("acc-codex", ctx);
		clearCodexModelCacheForAccount("acc-codex");
		serve(NEW_FRONTIER_BODY);
		await getCodexModels("acc-codex", ctx);

		expect(collected.of("role_target_changed")).toEqual([]);
		expect(collected.of("own_catalog_published")).toHaveLength(2);
	});

	describe("stale own catalogs", () => {
		const BASE_NOW = 1_800_000_000_000;

		it("uses a conservative threshold of four refresh intervals", () => {
			expect(CODEX_CATALOG_STALE_ALERT_MS).toBe(4 * REFRESH_INTERVAL_MS);
		});

		it("reports a stale own catalog only past the threshold after a failed attempt", async () => {
			let now = BASE_NOW;
			const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const account = makeAccount({ expires_at: BASE_NOW + 10 * 3_600_000 });
				const ctx = makeCtx(account);
				serve(LIVE_BODY);
				await getCodexModels(account.id, ctx);

				// Old but healthy: the latest attempt succeeded.
				evaluateCodexCatalogStaleness(
					[account],
					BASE_NOW + 10 * CODEX_CATALOG_STALE_ALERT_MS,
				);
				expect(collected.of("catalog_stale")).toEqual([]);

				now = BASE_NOW + REFRESH_INTERVAL_MS + 1;
				serve("unavailable", 503);
				await getCodexModels(account.id, ctx);

				// Failed, but not yet past the threshold.
				evaluateCodexCatalogStaleness(
					[account],
					BASE_NOW + CODEX_CATALOG_STALE_ALERT_MS,
				);
				expect(collected.of("catalog_stale")).toEqual([]);

				evaluateCodexCatalogStaleness(
					[account],
					BASE_NOW + CODEX_CATALOG_STALE_ALERT_MS + 1,
				);
				expect(collected.of("catalog_stale")).toEqual([
					{
						type: "catalog_stale",
						accountId: account.id,
						accountName: account.name,
						ageMs: CODEX_CATALOG_STALE_ALERT_MS + 1,
					},
				]);

				// An account the refresh would skip is never reported.
				evaluateCodexCatalogStaleness(
					[{ ...account, paused: true }],
					BASE_NOW + 2 * CODEX_CATALOG_STALE_ALERT_MS,
				);
				expect(collected.of("catalog_stale")).toHaveLength(1);

				// A later success clears the failed-attempt state.
				serve(LIVE_BODY);
				await getCodexModels(account.id, ctx);
				evaluateCodexCatalogStaleness(
					[account],
					now + 2 * CODEX_CATALOG_STALE_ALERT_MS,
				);
				expect(collected.of("catalog_stale")).toHaveLength(1);
			} finally {
				nowSpy.mockRestore();
			}
		});

		it("never reports an account that has no catalog of its own", async () => {
			const account = makeAccount({ id: "acc-never-listed" });
			serve("nope", 401);
			await getCodexModels(account.id, makeCtx(account));

			evaluateCodexCatalogStaleness(
				[account],
				Date.now() + 10 * CODEX_CATALOG_STALE_ALERT_MS,
			);

			expect(collected.events).toEqual([]);
		});

		it("is evaluated by the refresh heartbeat after its own attempt fails", async () => {
			let now = BASE_NOW;
			const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
			const randomSpy = spyOn(Math, "random").mockReturnValue(0);
			const account = makeAccount({ expires_at: BASE_NOW + 10 * 3_600_000 });
			const ctx = makeCtx(account);
			ctx.dbOps.getAllAccounts = async () => [account];
			let stop = (): void => {};
			try {
				serve(LIVE_BODY);
				await getCodexModels(account.id, ctx);
				serve("unavailable", 503);
				now = BASE_NOW + CODEX_CATALOG_STALE_ALERT_MS + 60_000;

				stop = initCodexModelCatalogRefresh(ctx, {
					initialDelayMs: 1,
					tickSeconds: 0.01,
				});
				await waitUntil(() => collected.of("catalog_stale").length > 0);

				expect(collected.of("catalog_stale")[0]).toEqual({
					type: "catalog_stale",
					accountId: account.id,
					accountName: account.name,
					ageMs: CODEX_CATALOG_STALE_ALERT_MS + 60_000,
				});
			} finally {
				stop();
				nowSpy.mockRestore();
				randomSpy.mockRestore();
			}
		});
	});

	describe("verified Codex CLI version record", () => {
		const previousPath = process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE;
		const previousVersion = process.env.CCFLARE_CODEX_CLIENT_VERSION;
		let dir: string;

		function writeRecord(name: string, verifiedAt: string): string {
			const file = join(dir, name);
			writeFileSync(
				file,
				JSON.stringify({
					schemaVersion: 1,
					packageName: "@openai/codex",
					version: "0.190.0",
					verifiedAt,
				}),
			);
			return file;
		}

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "ccflare-codex-identity-alert-"));
			delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
			delete process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE;
		});

		afterEach(() => {
			if (previousPath === undefined)
				delete process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE;
			else process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = previousPath;
			if (previousVersion === undefined)
				delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
			else process.env.CCFLARE_CODEX_CLIENT_VERSION = previousVersion;
			rmSync(dir, { recursive: true, force: true });
		});

		it("stays silent for an install without the updater", () => {
			evaluateCodexClientIdentityRecord();
			expect(collected.events).toEqual([]);
		});

		it("stays silent while a configured record is fresh", () => {
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = writeRecord(
				"fresh",
				new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
			);
			evaluateCodexClientIdentityRecord();
			expect(collected.events).toEqual([]);
		});

		it("reports a configured record that has gone stale", () => {
			const verifiedAt = new Date(
				Date.now() - 40 * 24 * 60 * 60_000,
			).toISOString();
			const file = writeRecord("stale", verifiedAt);
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;

			evaluateCodexClientIdentityRecord();

			expect(collected.of("identity_record_stale")).toEqual([
				{
					type: "identity_record_stale",
					error: "stale_record",
					version: "0.190.0",
					verifiedAt,
				},
			]);
			expect(JSON.stringify(collected.events)).not.toContain(dir);
		});

		it("reports a configured record that is missing", () => {
			const file = join(dir, "missing");
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;

			evaluateCodexClientIdentityRecord();

			const [event] = collected.of("identity_record_stale");
			expect(event).toMatchObject({
				type: "identity_record_stale",
				error: "unavailable_record",
			});
			expect(typeof event?.version).toBe("string");
			expect(JSON.stringify(collected.events)).not.toContain(dir);
		});

		it("defers to an explicit client version", () => {
			process.env.CCFLARE_CODEX_CLIENT_VERSION = "0.200.0";
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = join(dir, "missing");
			evaluateCodexClientIdentityRecord();
			expect(collected.events).toEqual([]);
		});

		it("is evaluated once per refresh cycle by the heartbeat, never per tick", async () => {
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = join(dir, "missing");
			const ctx = makeCtx(null);
			ctx.dbOps.getAllAccounts = async () => [];
			const stop = initCodexModelCatalogRefresh(ctx, {
				initialDelayMs: 1,
				tickSeconds: 0.01,
			});
			try {
				await waitUntil(() => collected.of("identity_record_stale").length > 0);
				// Later heartbeat ticks inside the same refresh cycle stay quiet.
				await waitRealMs(60);
				expect(collected.of("identity_record_stale")).toHaveLength(1);
			} finally {
				stop();
			}
		});
	});

	describe("catalog-role route fail-closed reports", () => {
		const T = 1_000_000;

		it("reports each profile, account and reason once per throttle window", () => {
			const mismatch = {
				accountId: "acc-role",
				reason: "catalog_role_mismatch",
			};
			reportCatalogRoleRouteFailClosed("codex-opus", mismatch, T);
			reportCatalogRoleRouteFailClosed("codex-opus", mismatch, T + 1_000);
			expect(collected.of("route_role_unavailable")).toEqual([
				{
					type: "route_role_unavailable",
					profileId: "codex-opus",
					accountId: "acc-role",
					reason: "catalog_role_mismatch",
				},
			]);

			reportCatalogRoleRouteFailClosed(
				"codex-opus",
				{ accountId: "acc-role", reason: "catalog_role_unavailable" },
				T + 1_000,
			);
			expect(collected.of("route_role_unavailable")).toHaveLength(2);

			reportCatalogRoleRouteFailClosed("codex-opus", mismatch, T + 60_001);
			expect(collected.of("route_role_unavailable")).toHaveLength(3);
		});

		it("omits the account for a pool profile, whose error names the profile", () => {
			reportCatalogRoleRouteFailClosed(
				"codex-opus-pool",
				{ accountId: "codex-opus-pool", reason: "catalog_role_unavailable" },
				T,
			);
			expect(collected.of("route_role_unavailable")).toEqual([
				{
					type: "route_role_unavailable",
					profileId: "codex-opus-pool",
					reason: "catalog_role_unavailable",
				},
			]);
		});

		it("ignores other fail-closed reasons and routes without a profile", () => {
			reportCatalogRoleRouteFailClosed(
				"codex-opus",
				{ accountId: "acc-role", reason: "paused" },
				T,
			);
			reportCatalogRoleRouteFailClosed(
				null,
				{ accountId: "acc-role", reason: "catalog_role_mismatch" },
				T,
			);
			reportCatalogRoleRouteFailClosed(
				undefined,
				{ accountId: "acc-role", reason: "catalog_role_unavailable" },
				T,
			);
			expect(collected.events).toEqual([]);
		});
	});
});
