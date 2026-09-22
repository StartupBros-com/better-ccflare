import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isModelPriced, resetNanoGPTPricingCacheForTest } from "./pricing";
import { isOfficialXaiEndpoint, resolveXaiContextWindow } from "./xai";

/**
 * Warm PriceCatalogue's in-memory snapshot with a synthetic xai catalogue so
 * that the synchronous `resolveXaiContextWindow` can read it via
 * `getCatalogModelSummaries`. Every model needs a non-zero cost - an
 * all-zero-cost provider section is dropped entirely by
 * `PriceCatalogue.shouldFilterProvider`.
 */
async function warmXaiCatalog(
	models: Record<string, Record<string, unknown>>,
): Promise<void> {
	const originalFetch = global.fetch;
	global.fetch = vi.fn((input: string | URL | Request) => {
		if (String(input) === "https://models.dev/api.json") {
			return Promise.resolve({
				ok: true,
				json: async () => ({ xai: { models } }),
			} as Response);
		}
		return Promise.resolve({
			ok: true,
			json: async () => ({ object: "list", data: [] }),
		} as Response);
	}) as typeof global.fetch;
	try {
		await isModelPriced("warm-catalog-trigger");
	} finally {
		global.fetch = originalFetch;
	}
}

describe("resolveXaiContextWindow", () => {
	it("resolves grok-4.5 and grok-4.6 at the official 500k window", () => {
		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
		expect(resolveXaiContextWindow("grok-4.5")).toEqual({
			family: "grok-4.5",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("resolves grok-4.7 at the official 500k window", () => {
		expect(resolveXaiContextWindow("grok-4.7")).toEqual({
			family: "grok-4.7",
			contextWindow: 500_000,
			match: "exact",
		});
		expect(resolveXaiContextWindow("grok-4.7-beta")).toEqual({
			family: "grok-4.7",
			contextWindow: 500_000,
			match: "prefix",
		});
	});

	it("resolves dated or suffixed grok-4.6 variants by the longest family prefix", () => {
		expect(resolveXaiContextWindow("grok-4.6-beta")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "prefix",
		});
	});

	it("does not treat original grok-4 as a 500k model", () => {
		expect(resolveXaiContextWindow("grok-4")).toBeUndefined();
		expect(resolveXaiContextWindow("grok-4-0709")).toBeUndefined();
	});

	it("returns undefined for empty or unrelated model ids", () => {
		expect(resolveXaiContextWindow("")).toBeUndefined();
		expect(resolveXaiContextWindow("gpt-5.6-sol")).toBeUndefined();
		expect(resolveXaiContextWindow("claude-fable-5")).toBeUndefined();
	});
});

describe("isOfficialXaiEndpoint", () => {
	const xaiAccount = (overrides: Partial<Account> = {}): Account =>
		({
			id: "xai-1",
			name: "xai-test",
			provider: "xai",
			custom_endpoint: null,
			...overrides,
		}) as Account;

	it("returns true for an xAI account with no custom endpoint (default is official)", () => {
		expect(isOfficialXaiEndpoint(xaiAccount())).toBe(true);
	});

	it("returns true for an xAI account with the official endpoint", () => {
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({ custom_endpoint: "https://api.x.ai/v1" }),
			),
		).toBe(true);
	});

	it("returns false for an xAI account with a non-official endpoint", () => {
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({ custom_endpoint: "https://proxy.example.com/v1" }),
			),
		).toBe(false);
	});

	it("returns false for malformed custom endpoints", () => {
		expect(
			isOfficialXaiEndpoint(xaiAccount({ custom_endpoint: "not-a-valid-url" })),
		).toBe(false);
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({
					custom_endpoint: JSON.stringify({
						modelMappings: { opus: "grok-4.5" },
					}),
				}),
			),
		).toBe(false);
	});

	it("returns false for a non-xAI account", () => {
		expect(
			isOfficialXaiEndpoint(xaiAccount({ provider: "openai-compatible" })),
		).toBe(false);
	});

	it("returns true when no account is provided (defaults to official xAI)", () => {
		expect(isOfficialXaiEndpoint(undefined)).toBe(true);
		expect(isOfficialXaiEndpoint(null)).toBe(true);
	});
});

describe("resolveXaiContextWindow with a catalog-derived window", () => {
	let originalFetch: typeof global.fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
		resetNanoGPTPricingCacheForTest();
	});

	afterEach(() => {
		global.fetch = originalFetch;
		resetNanoGPTPricingCacheForTest();
	});

	it("resolves an exact catalog id ahead of the bundled table", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				limit: { context: 1_000_000, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("grok-5")).toEqual({
			family: "grok-5",
			contextWindow: 1_000_000,
			match: "catalog-exact",
		});
	});

	it("resolves a dated/suffixed model by the longest catalog-id prefix", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				limit: { context: 1_000_000, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("grok-5-fast-beta")).toEqual({
			family: "grok-5",
			contextWindow: 1_000_000,
			match: "catalog-prefix",
		});
	});

	it("prefers the catalog value over the bundled table when both cover the same id", async () => {
		// grok-4.6 is 500k in the bundled table; the catalog says otherwise here
		// to prove catalog-first precedence, not just catalog-fills-a-gap.
		await warmXaiCatalog({
			"grok-4.6": {
				id: "grok-4.6",
				name: "Grok 4.6",
				cost: { input: 1, output: 1 },
				limit: { context: 750_000, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 750_000,
			match: "catalog-exact",
		});
	});

	it("falls back to the bundled table when the catalog has no matching model", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				limit: { context: 1_000_000, output: 1 },
			},
		});

		// Not present in the synthetic catalog above - must still resolve via
		// the bundled table.
		expect(resolveXaiContextWindow("grok-4.7")).toEqual({
			family: "grok-4.7",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("rejects a catalog window below the sanity floor and falls back to the bundled table", async () => {
		await warmXaiCatalog({
			"grok-4.6": {
				id: "grok-4.6",
				name: "Grok 4.6",
				cost: { input: 1, output: 1 },
				// Implausibly tiny - a data error, not a real window.
				limit: { context: 100, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("rejects a catalog window above the sanity ceiling and falls back to the bundled table", async () => {
		await warmXaiCatalog({
			"grok-4.6": {
				id: "grok-4.6",
				name: "Grok 4.6",
				cost: { input: 1, output: 1 },
				// Implausibly huge - a data error, not a real window.
				limit: { context: 50_000_000, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("ignores a catalog entry with no published limit.context", async () => {
		await warmXaiCatalog({
			"grok-4.6": {
				id: "grok-4.6",
				name: "Grok 4.6",
				cost: { input: 1, output: 1 },
				// No `limit` at all - falls through to the bundled table.
			},
		});

		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("still returns undefined for a model absent from both the catalog and the bundled table", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				limit: { context: 1_000_000, output: 1 },
			},
		});

		expect(resolveXaiContextWindow("gpt-5.6-sol")).toBeUndefined();
	});
});
