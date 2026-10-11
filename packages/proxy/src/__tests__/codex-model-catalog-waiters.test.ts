import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type CodexCatalogEvt, codexCatalogEvents } from "@better-ccflare/core";
import {
	clearDerivedProviderModelDefaults,
	hasDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	CATALOG_REFRESH_INTERVAL_MS,
	CODEX_CATALOG_STALE_ALERT_MS,
	clearCodexModelCacheForAccount,
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	evaluateCodexCatalogStaleness,
	getCodexAutoCatalogEvidence,
	getKnownCodexModels,
	prepareCodexAutoCatalog,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";
import * as tokenManager from "../handlers/token-manager";
import { resetModelCatalogForTest } from "../model-catalog";

const originalFetch = globalThis.fetch;
let now = 1_000_000;
let clock: ReturnType<typeof spyOn>;
let tokenSpy: ReturnType<typeof spyOn>;
let row: Account;
let ctx: ProxyContext;
let reads: number;
let tokens: number;
let eligible: boolean;
let unexpected: string[];
let signals: (AbortSignal | null)[];
let onRead: (count: number) => Promise<void>;
let onToken: (count: number) => Promise<void>;
let onBody: (count: number) => Promise<void>;
let failure: "401" | "fetch" | null;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function turns() {
	for (let n = 0; n < 100; n++) await Promise.resolve();
}
async function waitFor(predicate: () => boolean) {
	for (let n = 0; n < 100 && !predicate(); n++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	expect(predicate()).toBe(true);
}
function auto(controller: AbortController) {
	// Same request-owned contract used by Auto's shared preparation queue.
	return prepareCodexAutoCatalog(row.id, ctx, {
		signal: controller.signal,
		deadlineAt: now + 10_000,
		accountEligible: () => eligible,
	}).catch(() => {});
}
function hold(stage: "reload" | "token" | "body", ordinaryOwner = false) {
	const entered = deferred();
	const release = deferred();
	// Auto resolves and revalidates its initial row/token before registering
	// its shared ensure. Hold the first await inside that registered attempt.
	const target = ordinaryOwner ? 1 : stage === "reload" ? 4 : 3;
	const hook = async (count: number) => {
		if (count === (stage === "body" ? 1 : target)) {
			entered.resolve();
			await release.promise;
		}
	};
	if (stage === "reload") onRead = hook;
	if (stage === "token") onToken = hook;
	if (stage === "body") onBody = hook;
	return { entered: entered.promise, release: release.resolve };
}
function expectOwnCatalog() {
	expect(getKnownCodexModels(row.id)?.models.map((model) => model.id)).toEqual([
		"gpt-6-astra",
	]);
	expect(hasDerivedProviderModelDefaults("codex", row.id)).toBe(true);
	expect(getCodexAutoCatalogEvidence(row.id)).not.toBeNull();
}

beforeEach(() => {
	now = 1_000_000;
	clock = spyOn(Date, "now").mockImplementation(() => now);
	row = {
		id: "synthetic-catalog-waiter",
		name: "synthetic-catalog-waiter",
		provider: "codex",
		api_key: null,
		access_token: "synthetic-access",
		refresh_token: "synthetic-refresh",
		expires_at: 100_000_000,
		created_at: 1,
		priority: 0,
		paused: false,
		requires_reauth: false,
		rate_limited_until: null,
		custom_endpoint: null,
	} as Account;
	reads = 0;
	tokens = 0;
	eligible = true;
	unexpected = [];
	signals = [];
	failure = null;
	onRead = async () => {};
	onToken = async () => {};
	onBody = async () => {};
	ctx = {
		dbOps: {
			getAccount: async () => {
				await onRead(++reads);
				return { ...row };
			},
		},
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	resetModelCatalogForTest();
	tokenSpy = spyOn(tokenManager, "getValidAccessToken").mockImplementation(
		async () => {
			await onToken(++tokens);
			return row.access_token ?? "";
		},
	);
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.origin !== "https://chatgpt.com" ||
			url.pathname !== "/backend-api/codex/models" ||
			(init?.method ?? "GET") !== "GET"
		) {
			unexpected.push(`${init?.method ?? "GET"} ${url}`);
			throw new Error("Unexpected network request");
		}
		signals.push(init?.signal ?? null);
		if (failure === "fetch") throw new Error("synthetic fetch failure");
		if (failure === "401") return new Response(null, { status: 401 });
		const count = signals.length;
		return {
			ok: true,
			json: async () => {
				await onBody(count);
				return {
					models: [
						{
							slug: "gpt-6-astra",
							visibility: "list",
							context_window: 200_000,
						},
					],
				};
			},
		} as Response;
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	tokenSpy.mockRestore();
	clock.mockRestore();
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	resetModelCatalogForTest();
	expect(unexpected).toEqual([]);
});

describe("ordinary cold waiters on request-owned Codex acquisition", () => {
	for (const stage of ["reload", "token", "body"] as const) {
		for (const stop of ["abort", "deadline", "policy"] as const) {
			test(`${stage}: ${stop} permits one independently owned coalesced replacement`, async () => {
				const gate = hold(stage);
				const controller = new AbortController();
				const owner = auto(controller);
				try {
					await gate.entered;
					const first = ensureCodexModelDefaults(row, ctx);
					const second = ensureCodexModelDefaults(row, ctx);
					if (stop === "abort") controller.abort();
					if (stop === "deadline") now += 10_000;
					if (stop === "policy") eligible = false;
					gate.release();
					await Promise.all([first, second, owner]);
					expectOwnCatalog();
					expect(signals.length).toBe(stage === "body" ? 2 : 1);
					if (stop === "abort" && stage === "body")
						expect(signals[0]?.aborted).toBe(true);
					expect(signals.at(-1)?.aborted).toBe(false);
					await ensureCodexModelDefaults(row, ctx);
					expect(signals.length).toBe(stage === "body" ? 2 : 1);
				} finally {
					gate.release();
					await owner;
				}
			});
		}

		test(`${stage}: late canceled completion cannot clear the replacement or publish`, async () => {
			const gate = hold(stage);
			const replacementBody = deferred();
			const oldBodyHook = onBody;
			onBody = async (count) => {
				await oldBodyHook(count);
				if (count === (stage === "body" ? 2 : 1)) await replacementBody.promise;
			};
			const controller = new AbortController();
			const owner = auto(controller);
			try {
				await gate.entered;
				const ordinary = ensureCodexModelDefaults(row, ctx);
				controller.abort();
				await owner;
				await waitFor(() => signals.length === (stage === "body" ? 2 : 1));
				const replacement = ensureCodexModelDefaults(row, ctx);
				expect(getKnownCodexModels(row.id)).toBeNull();
				gate.release();
				await turns();
				expect(getKnownCodexModels(row.id)).toBeNull();
				expect(ensureCodexModelDefaults(row, ctx)).toBe(replacement);
				expect(signals.length).toBe(stage === "body" ? 2 : 1);
				replacementBody.resolve();
				await Promise.all([ordinary, replacement]);
				expectOwnCatalog();
			} finally {
				gate.release();
				replacementBody.resolve();
				await owner;
			}
		});

		test(`${stage}: scoped stop alone neither starts late GETs nor publishes`, async () => {
			const gate = hold(stage);
			const controller = new AbortController();
			const owner = auto(controller);
			try {
				await gate.entered;
				controller.abort();
				await owner;
				gate.release();
				await turns();
				expect(signals.length).toBe(stage === "body" ? 1 : 0);
				expect(getKnownCodexModels(row.id)).toBeNull();
				expect(hasDerivedProviderModelDefaults("codex", row.id)).toBe(false);
			} finally {
				gate.release();
				await owner;
			}
		});

		test(`${stage}: ordinary owner survives an aborted Auto waiter`, async () => {
			const gate = hold(stage, true);
			const ordinary = ensureCodexModelDefaults(row, ctx);
			const controller = new AbortController();
			try {
				await gate.entered;
				const waiter = auto(controller);
				await turns();
				controller.abort();
				expect(signals.every((signal) => !signal?.aborted)).toBe(true);
				gate.release();
				await Promise.all([ordinary, waiter]);
				expectOwnCatalog();
				expect(signals.length).toBe(1);
			} finally {
				gate.release();
				await ordinary;
			}
		});
	}

	test("a deadline crossed during a rejected reload is still a scoped stop", async () => {
		const gate = deferred();
		onRead = async (count) => {
			if (count === 4) {
				await gate.promise;
				throw new Error("synthetic delayed reload rejection");
			}
		};
		const owner = auto(new AbortController());
		try {
			await waitFor(() => reads === 4);
			const ordinary = ensureCodexModelDefaults(row, ctx);
			now += 10_000;
			gate.resolve();
			await Promise.all([owner, ordinary]);
			expectOwnCatalog();
			expect(signals.length).toBe(1);
		} finally {
			gate.resolve();
			await owner;
		}
	});

	for (const kind of ["401", "fetch"] as const) {
		test(`${kind} failure retains backoff without retrying cold joiners`, async () => {
			const gate = hold("token");
			failure = kind;
			const owner = auto(new AbortController());
			try {
				await gate.entered;
				const first = ensureCodexModelDefaults(row, ctx);
				const second = ensureCodexModelDefaults(row, ctx);
				gate.release();
				await Promise.all([owner, first, second]);
				expect(signals.length).toBe(1);
				expect(getKnownCodexModels(row.id)).toBeNull();
				failure = null;
				await ensureCodexModelDefaults(row, ctx);
				now += 59_999;
				await ensureCodexModelDefaults(row, ctx);
				expect(signals.length).toBe(1);
				now++;
				await ensureCodexModelDefaults(row, ctx);
				expect(signals.length).toBe(2);
				expectOwnCatalog();
			} finally {
				gate.release();
				await owner;
			}
		});
	}

	test("a failed replacement is bounded and retains the provider backoff", async () => {
		const gate = hold("token");
		const controller = new AbortController();
		const owner = auto(controller);
		try {
			await gate.entered;
			const first = ensureCodexModelDefaults(row, ctx);
			const second = ensureCodexModelDefaults(row, ctx);
			failure = "401";
			controller.abort();
			gate.release();
			await Promise.all([owner, first, second]);
			expect(signals.length).toBe(1);
			await ensureCodexModelDefaults(row, ctx);
			expect(signals.length).toBe(1);
			expect(getKnownCodexModels(row.id)).toBeNull();
		} finally {
			gate.release();
			await owner;
		}
	});

	test("deletion does not let an old ordinary waiter reacquire for a replacement account", async () => {
		const gate = hold("token");
		const controller = new AbortController();
		const owner = auto(controller);
		try {
			await gate.entered;
			const ordinary = ensureCodexModelDefaults(row, ctx);
			clearCodexModelCacheForAccount(row.id);
			row = { ...row, created_at: 2, access_token: "synthetic-replacement" };
			controller.abort();
			gate.release();
			await Promise.all([owner, ordinary]);
			expect(signals.length).toBe(0);
			expect(getKnownCodexModels(row.id)).toBeNull();
			await ensureCodexModelDefaults(row, ctx);
			expectOwnCatalog();
			expect(signals.length).toBe(1);
		} finally {
			gate.release();
			await owner;
		}
	});

	test("warm ordinary callers remain nonblocking and a policy stop is not a failed refresh", async () => {
		await ensureCodexModelDefaults(row, ctx);
		now += CODEX_CATALOG_STALE_ALERT_MS + 1;
		reads = 0;
		tokens = 0;
		const gate = hold("token");
		const controller = new AbortController();
		const owner = auto(controller);
		const staleEvents: unknown[] = [];
		const listener = (event: CodexCatalogEvt) => {
			if (event.type === "catalog_stale") staleEvents.push(event);
		};
		codexCatalogEvents.on("event", listener);
		try {
			await gate.entered;
			let settled = false;
			void ensureCodexModelDefaults(row, ctx).then(() => {
				settled = true;
			});
			await turns();
			expect(settled).toBe(true);
			eligible = false;
			gate.release();
			await owner;
			evaluateCodexCatalogStaleness([row], now);
			expect(staleEvents).toEqual([]);
			expect(signals.length).toBe(1);
			expect(getKnownCodexModels(row.id)?.models[0].id).toBe("gpt-6-astra");
			expect(hasDerivedProviderModelDefaults("codex", row.id)).toBe(true);
			await ensureCodexModelDefaults(row, ctx);
			await waitFor(() => signals.length === 2);
			await turns();
			expectOwnCatalog();
			expect(CATALOG_REFRESH_INTERVAL_MS).toBeLessThan(
				CODEX_CATALOG_STALE_ALERT_MS,
			);
		} finally {
			codexCatalogEvents.off("event", listener);
			gate.release();
			await owner;
		}
	});
});
