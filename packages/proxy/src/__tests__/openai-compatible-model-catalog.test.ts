import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	resolveProviderModelDefault,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	clearOpenAICompatibleModelCacheForAccount,
	clearOpenAICompatibleModelCacheForTests,
	deriveFamilyDefaults,
	fetchOpenAICompatibleModelsPreview,
	getOpenAICompatibleModelCatalogStateCountForTests,
	getOpenAICompatibleModels,
	OPENAI_COMPATIBLE_MODEL_MAX_ID_BYTES,
	OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES,
} from "../openai-compatible-model-catalog";

/**
 * The per-account model list for openai-compatible accounts, read from that
 * account's own `/v1/models` endpoint, and what happens when it stops
 * answering.
 *
 * Unlike Codex, every account here points at an arbitrary, operator-chosen
 * endpoint — there is no shared upstream — so, unlike codex-model-catalog,
 * a listing is never borrowed from another account.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oai",
		name: "oai-account",
		provider: "openai-compatible",
		api_key: "sk-test",
		custom_endpoint: "https://api.example.com/v1",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
		...overrides,
	} as Account;
}

function makeCtx(account: Account | null): ProxyContext {
	return {
		dbOps: {
			getAccount: async () => account,
		},
	} as unknown as ProxyContext;
}

const LIVE_BODY = {
	data: [
		{ id: "gpt-oss-120b" },
		{ id: "gpt-oss-20b" },
		{ id: "gpt-oss-8b" },
		// Duplicated and empty ids do not become entries.
		{ id: "gpt-oss-120b" },
		{ id: "  " },
	],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	setProviderModelDefaultOverrides({});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	// getOpenAICompatibleModels() writes into the process-wide derived-defaults
	// registry (provider-model-defaults.ts); left uncleared it leaks into any
	// other test file that runs in the same bun process.
	clearDerivedProviderModelDefaults();
	setProviderModelDefaultOverrides({});
	clearOpenAICompatibleModelCacheForTests();
});

describe("getOpenAICompatibleModels", () => {
	it("reads the account's own list and dedupes ids", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("live");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-oss-120b",
			"gpt-oss-20b",
			"gpt-oss-8b",
		]);
	});

	it("requests the standard /v1/models path with a bearer token", async () => {
		let requestedUrl: string | undefined;
		let requestedAuth: string | null | undefined;
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			requestedUrl = String(input);
			requestedAuth = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		expect(requestedUrl).toBe("https://api.example.com/v1/models");
		expect(requestedAuth).toBe("Bearer sk-test");
	});

	it("appends /v1/models when the endpoint has no /v1 suffix", async () => {
		let requestedUrl: string | undefined;
		globalThis.fetch = (async (input: string | URL | Request) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount({ custom_endpoint: "https://api.example.com" })),
		);

		expect(requestedUrl).toBe("https://api.example.com/v1/models");
	});

	it("fails closed without fetching when the endpoint is missing or invalid", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response(JSON.stringify(LIVE_BODY), { status: 200 });
		}) as typeof globalThis.fetch;

		expect(
			await getOpenAICompatibleModels(
				"acc-oai",
				makeCtx(makeAccount({ custom_endpoint: null })),
			),
		).toBeNull();
		expect(
			await getOpenAICompatibleModels(
				"acc-oai",
				makeCtx(makeAccount({ custom_endpoint: "not a URL" })),
			),
		).toBeNull();
		expect(fetchCalls).toBe(0);
	});

	// The reason the cache exists.
	it("serves the last successful list when the endpoint stops answering", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("cached");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-oss-120b",
			"gpt-oss-20b",
			"gpt-oss-8b",
		]);
	});

	// Unlike Codex, a second account never inherits a first account's listing —
	// each openai-compatible account points at an arbitrary, unrelated endpoint.
	it("does not borrow another account's listing", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-other",
			makeCtx(makeAccount({ id: "acc-other" })),
		);

		expect(listing).toBeNull();
	});

	// Regression for the leak Fix 1 closes: setDerivedProviderModelDefaults used
	// to always also write the provider-wide fallback, so a second account with
	// no listing of its own could resolve to the first account's private
	// endpoint's model ids. openai-compatible must opt out of that sharing.
	it("does not let one account's derived defaults resolve for another account", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		expect(
			resolveProviderModelDefault("openai-compatible", "opus", "acc-oai"),
		).toBe("gpt-oss-120b");
		expect(
			resolveProviderModelDefault(
				"openai-compatible",
				"opus",
				"acc-other-account",
			),
		).toBeUndefined();
		// No accountId at all resolves through the (now never-populated)
		// provider-wide map — must also stay empty.
		expect(
			resolveProviderModelDefault("openai-compatible", "opus"),
		).toBeUndefined();
	});

	it("does not override an explicit mapping with discovery", async () => {
		setProviderModelDefaultOverrides({
			"openai-compatible": { opus: "operator-pinned" },
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		expect(
			resolveProviderModelDefault("openai-compatible", "opus", "acc-oai"),
		).toBe("operator-pinned");
	});

	it("treats a listing with no usable models as a failure", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		expect(
			await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount())),
		).toBeNull();

		// And the account is not stuck: a later real answer still lands.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("live");
	});

	it("returns nothing for an account with no API key", async () => {
		expect(
			await getOpenAICompatibleModels(
				"acc-oai",
				makeCtx(makeAccount({ api_key: null })),
			),
		).toBeNull();
	});

	it("refuses an account that is not openai-compatible", async () => {
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount({ provider: "anthropic" })),
		);

		expect(listing).toBeNull();
	});

	it("returns nothing for an account that does not exist", async () => {
		expect(await getOpenAICompatibleModels("ghost", makeCtx(null))).toBeNull();
	});

	it("does not retain state or fetch for unknown accounts", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response(JSON.stringify(LIVE_BODY), { status: 200 });
		}) as typeof globalThis.fetch;

		for (let index = 0; index < 100; index++) {
			expect(
				await getOpenAICompatibleModels(`missing-${index}`, makeCtx(null)),
			).toBeNull();
		}

		expect(getOpenAICompatibleModelCatalogStateCountForTests()).toBe(0);
		expect(fetchCalls).toBe(0);
	});

	it("does not fetch or republish after a cache clear during account lookup", async () => {
		let resolveAccount: ((account: Account | null) => void) | undefined;
		let fetchCalls = 0;
		const account = makeAccount({ id: "acc-cleared-during-lookup" });
		const ctx = {
			dbOps: {
				getAccount: () =>
					new Promise<Account | null>((resolve) => {
						resolveAccount = resolve;
					}),
			},
		} as unknown as ProxyContext;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response(JSON.stringify(LIVE_BODY), { status: 200 });
		}) as typeof globalThis.fetch;

		const request = getOpenAICompatibleModels(account.id, ctx);
		clearOpenAICompatibleModelCacheForAccount(account.id);
		resolveAccount?.(account);

		expect(await request).toBeNull();
		expect(fetchCalls).toBe(0);
		expect(getOpenAICompatibleModelCatalogStateCountForTests()).toBe(0);
	});

	it("does not republish a listing or defaults after account deletion during a fetch", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		const account = makeAccount({ id: "acc-cleared-during-fetch" });
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			})) as typeof globalThis.fetch;

		const staleRequest = getOpenAICompatibleModels(
			account.id,
			makeCtx(account),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		clearOpenAICompatibleModelCacheForAccount(account.id);
		resolveFetch?.(
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		expect(await staleRequest).toBeNull();
		expect(
			resolveProviderModelDefault("openai-compatible", "opus", account.id),
		).toBeUndefined();

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		expect(
			await getOpenAICompatibleModels(account.id, makeCtx(account)),
		).toBeNull();
	});

	it("returns null when a stale fetch fails after the account is recreated", async () => {
		let rejectStaleFetch: ((reason?: unknown) => void) | undefined;
		let fetches = 0;
		const account = makeAccount({ id: "acc-recreated-after-clear" });
		globalThis.fetch = (() => {
			fetches++;
			if (fetches === 1) {
				return new Promise<Response>((_resolve, reject) => {
					rejectStaleFetch = reject;
				});
			}
			return Promise.resolve(
				new Response(JSON.stringify({ data: [{ id: "replacement-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}) as typeof globalThis.fetch;

		const staleRequest = getOpenAICompatibleModels(
			account.id,
			makeCtx(account),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		clearOpenAICompatibleModelCacheForAccount(account.id);

		expect(
			(await getOpenAICompatibleModels(account.id, makeCtx(account)))?.models[0]
				.id,
		).toBe("replacement-model");
		rejectStaleFetch?.(new Error("stale endpoint failed"));

		expect(await staleRequest).toBeNull();
		expect(
			resolveProviderModelDefault("openai-compatible", "opus", account.id),
		).toBe("replacement-model");
	});

	it("garbage-collects state after repeated unique account clears", () => {
		for (let index = 0; index < 100; index++) {
			clearOpenAICompatibleModelCacheForAccount(`acc-cleared-${index}`);
		}

		expect(getOpenAICompatibleModelCatalogStateCountForTests()).toBe(0);
	});

	it("keeps newer completion evidence when an older fetch resolves last", async () => {
		const pending: Array<(response: Response) => void> = [];
		const account = makeAccount({ id: "acc-publication-order" });
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) =>
				pending.push(resolve),
			)) as typeof globalThis.fetch;

		const older = getOpenAICompatibleModels(account.id, makeCtx(account));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const newer = getOpenAICompatibleModels(account.id, makeCtx(account));
		await new Promise((resolve) => setTimeout(resolve, 0));

		pending[1](
			new Response(JSON.stringify({ data: [{ id: "new-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await newer;
		expect(
			resolveProviderModelDefault("openai-compatible", "opus", account.id),
		).toBe("new-model");

		pending[0](
			new Response(JSON.stringify({ data: [{ id: "old-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		expect((await older)?.models[0].id).toBe("old-model");
		expect(
			resolveProviderModelDefault("openai-compatible", "opus", account.id),
		).toBe("new-model");

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		expect(
			(await getOpenAICompatibleModels(account.id, makeCtx(account)))?.models[0]
				.id,
		).toBe("new-model");
	});
});

describe("fetchOpenAICompatibleModelsPreview", () => {
	it("returns isolated live models for each unsaved credential tuple", async () => {
		const authorizations: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			const authorization =
				new Headers(init?.headers).get("authorization") ?? "";
			authorizations.push(authorization);
			const id = authorization.endsWith("first-key")
				? "first-model"
				: "second-model";
			return new Response(JSON.stringify({ data: [{ id }] }));
		}) as typeof globalThis.fetch;

		const first = await fetchOpenAICompatibleModelsPreview(
			"first-key",
			"http://127.0.0.1:11434",
		);
		const second = await fetchOpenAICompatibleModelsPreview(
			"second-key",
			"http://localhost:4000/v1",
		);

		expect(first.models.map((model) => model.id)).toEqual(["first-model"]);
		expect(second.models.map((model) => model.id)).toEqual(["second-model"]);
		expect(authorizations).toEqual(["Bearer first-key", "Bearer second-key"]);
		expect(getOpenAICompatibleModelCatalogStateCountForTests()).toBe(0);
	});

	it("rejects malformed and empty model responses without partial results", async () => {
		for (const response of [
			new Response("not-json"),
			new Response(JSON.stringify({ data: "not-an-array" })),
			new Response(JSON.stringify({ data: [] })),
		]) {
			globalThis.fetch = (async () => response) as typeof globalThis.fetch;
			await expect(
				fetchOpenAICompatibleModelsPreview(
					"preview-key",
					"http://localhost:4000/v1",
				),
			).rejects.toThrow(/model discovery/i);
		}
	});

	it("redacts upstream error bodies and submitted credentials", async () => {
		const secret = "preview-secret-key";
		globalThis.fetch = (async () =>
			new Response(`upstream leaked ${secret}`, {
				status: 401,
			})) as typeof fetch;

		try {
			await fetchOpenAICompatibleModelsPreview(
				secret,
				"http://localhost:4000/v1",
			);
			throw new Error("expected preview to fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("401");
			expect(message).not.toContain(secret);
			expect(message).not.toContain("upstream leaked");
		}
	});

	it("rejects decoded bodies over 8 MiB despite a false Content-Length and cancels them", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new Uint8Array(OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES),
				);
				controller.enqueue(new Uint8Array([0x20]));
			},
			cancel() {
				cancelled = true;
			},
		});
		globalThis.fetch = (async () =>
			new Response(body, {
				headers: { "content-length": "1" },
			})) as typeof fetch;

		await expect(
			fetchOpenAICompatibleModelsPreview(
				"preview-key",
				"http://localhost:4000/v1",
			),
		).rejects.toThrow("8 MiB");
		expect(cancelled).toBe(true);
	});

	it("rejects a declared oversized response before consuming it", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([0x7b]));
			},
			cancel() {
				cancelled = true;
			},
		});
		globalThis.fetch = (async () =>
			new Response(body, {
				headers: {
					"content-length": String(
						OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES + 1,
					),
				},
			})) as typeof fetch;

		await expect(
			fetchOpenAICompatibleModelsPreview(
				"preview-key",
				"http://localhost:4000/v1",
			),
		).rejects.toThrow("8 MiB");
		expect(cancelled).toBe(true);
	});

	it("rejects more than 10,000 unique model IDs", async () => {
		const data = Array.from({ length: 10_001 }, (_, index) => ({
			id: `model-${index}`,
		}));
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data }))) as typeof fetch;

		await expect(
			fetchOpenAICompatibleModelsPreview(
				"preview-key",
				"http://localhost:4000/v1",
			),
		).rejects.toThrow("10,000");
	});

	it("rejects model IDs over 1,024 UTF-8 bytes", async () => {
		const oversizedId = "é".repeat(
			OPENAI_COMPATIBLE_MODEL_MAX_ID_BYTES / 2 + 1,
		);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ data: [{ id: oversizedId }] }),
			)) as typeof fetch;

		await expect(
			fetchOpenAICompatibleModelsPreview(
				"preview-key",
				"http://localhost:4000/v1",
			),
		).rejects.toThrow("1,024 UTF-8 bytes");
	});

	it("times out and aborts a request that never settles", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let observedSignal: AbortSignal | undefined;
		globalThis.setTimeout = ((callback: TimerHandler) => {
			queueMicrotask(() => {
				if (typeof callback === "function") callback();
			});
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.fetch = ((_input, init) => {
			observedSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				observedSignal?.addEventListener("abort", () =>
					reject(new DOMException("Aborted", "AbortError")),
				);
			});
		}) as typeof fetch;

		try {
			await expect(
				fetchOpenAICompatibleModelsPreview(
					"preview-key",
					"http://localhost:4000/v1",
				),
			).rejects.toThrow(/timed out/i);
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});
});

describe("deriveFamilyDefaults", () => {
	it("maps fable/opus to the frontier model, sonnet next, haiku after", () => {
		const defaults = deriveFamilyDefaults([
			{ id: "big", displayName: "big" },
			{ id: "mid", displayName: "mid" },
			{ id: "small", displayName: "small" },
		]);

		expect(defaults).toEqual({
			fable: "big",
			opus: "big",
			sonnet: "mid",
			haiku: "small",
		});
	});

	it("degrades to the last available model for a shorter list", () => {
		const defaults = deriveFamilyDefaults([
			{ id: "only", displayName: "only" },
		]);

		expect(defaults).toEqual({
			fable: "only",
			opus: "only",
			sonnet: "only",
			haiku: "only",
		});
	});

	it("returns an empty map for an empty list", () => {
		expect(deriveFamilyDefaults([])).toEqual({});
	});
});
