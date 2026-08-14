import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	hasDerivedProviderModelDefaults,
	resolveProviderModelDefault,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	getCodexModels,
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

describe("derived-default provenance", () => {
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

	it("does not let an old completion clear a newer in-flight ensure", async () => {
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
		clearCodexModelCacheForTests();
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
