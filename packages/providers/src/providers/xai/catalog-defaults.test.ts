import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	getCatalogModelSummaries,
	isModelPriced,
	resetNanoGPTPricingCacheForTest,
} from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import {
	clearDerivedProviderModelDefaults,
	registerProviderModelDefaultFactory,
	resolveProviderModelDefault,
} from "../../provider-model-defaults";
import {
	deriveXaiCatalogDefaults,
	resetXaiCatalogDefaultsForTest,
} from "./catalog-defaults";

/**
 * A synthetic factory default, deliberately distinct from any real xai
 * family mapping - this test suite exercises `catalog-defaults.ts` in
 * isolation from `./provider.ts` (whose XAI_MODEL_MAPPINGS value is a moving
 * target across this session's grok-4.5 -> grok-4.7 bump) and asserts only
 * that the catalog pick overrides it, and that its absence falls through to
 * it unchanged.
 */
const FACTORY_DEFAULT_MODEL = "factory-default-grok";

/**
 * Warm PriceCatalogue's in-memory snapshot with a synthetic xai catalogue so
 * `getCatalogModelSummaries("xai")` (the sync accessor `catalog-defaults.ts`
 * reads) sees it. Every synthetic model needs a non-zero cost or
 * `PriceCatalogue.shouldFilterProvider` drops the whole "xai" section.
 */
async function warmXaiCatalog(
	models: Record<string, Record<string, unknown>>,
): Promise<void> {
	const originalFetch = global.fetch;
	global.fetch = mock((input: string | URL | Request) => {
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
	}) as unknown as typeof global.fetch;
	try {
		await isModelPriced("warm-catalog-defaults-trigger");
	} finally {
		global.fetch = originalFetch;
	}
}

describe("deriveXaiCatalogDefaults", () => {
	let originalFetch: typeof global.fetch;
	let logs: LogEvent[];
	let logListener: (event: LogEvent) => void;

	beforeEach(() => {
		originalFetch = global.fetch;
		resetNanoGPTPricingCacheForTest();
		clearDerivedProviderModelDefaults();
		resetXaiCatalogDefaultsForTest();
		registerProviderModelDefaultFactory("xai", {
			opus: FACTORY_DEFAULT_MODEL,
			sonnet: FACTORY_DEFAULT_MODEL,
			haiku: FACTORY_DEFAULT_MODEL,
			fable: FACTORY_DEFAULT_MODEL,
		});
		logs = [];
		logListener = (event) => logs.push(event);
		logBus.on("log", logListener);
	});

	afterEach(() => {
		global.fetch = originalFetch;
		logBus.off("log", logListener);
		resetNanoGPTPricingCacheForTest();
		clearDerivedProviderModelDefaults();
		resetXaiCatalogDefaultsForTest();
	});

	it("picks the newest bare grok-N(.N) model by release_date, ignoring non-bare variants", async () => {
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
			// Decoy: a naive numeric/string comparison of the id ("grok-4.20" >
			// "grok-5" lexicographically, and 4.20 > 4.7 if misread as two
			// decimals) must not win over grok-5's later release_date.
			"grok-4.20": {
				id: "grok-4.20",
				name: "Grok 4.20 (decoy)",
				cost: { input: 1, output: 1 },
				release_date: "2026-01-01",
				tool_call: true,
			},
		});

		deriveXaiCatalogDefaults();

		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-5");
		expect(resolveProviderModelDefault("xai", "opus")).toBe("grok-5");
		expect(resolveProviderModelDefault("xai", "haiku")).toBe("grok-5");
		expect(resolveProviderModelDefault("xai", "fable")).toBe("grok-5");
	});

	it("excludes entries with no release_date", async () => {
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
			"grok-5": {
				id: "grok-5",
				name: "Grok 5 (undated - excluded)",
				cost: { input: 1, output: 1 },
				tool_call: true,
			},
		});

		deriveXaiCatalogDefaults();

		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-4.7");
	});

	it("excludes entries explicitly marked tool_call: false", async () => {
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
			"grok-5": {
				id: "grok-5",
				name: "Grok 5 (no tool calling - excluded)",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: false,
			},
		});

		deriveXaiCatalogDefaults();

		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-4.7");
	});

	it("does not exclude an entry with tool_call left unset (absence is not evidence of false)", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				// tool_call intentionally omitted.
			},
		});

		deriveXaiCatalogDefaults();

		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-5");
	});

	it("never regresses to an older release_date pick across repeated derivations", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-5");

		// A later catalog load that (erroneously, or via a stale mirror) omits
		// grok-5 and only offers an older model must not roll the default back.
		// A fresh PriceCatalogue singleton forces a genuine reload here instead
		// of a same-process memory-cache hit that would silently skip it (the
		// in-memory cache only re-fetches once CF_PRICING_REFRESH_HOURS elapses).
		resetNanoGPTPricingCacheForTest();
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();

		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-5");
	});

	it("logs once at warn level naming the old and new model when the pick changes", async () => {
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();

		// Fresh singleton: see the comment in the "never regresses" test above
		// for why this is required to force a genuine second load.
		resetNanoGPTPricingCacheForTest();
		await warmXaiCatalog({
			"grok-4.7": {
				id: "grok-4.7",
				name: "Grok 4.7",
				cost: { input: 1, output: 1 },
				release_date: "2026-08-01",
				tool_call: true,
			},
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();

		const warnLogs = logs.filter(
			(event) =>
				event.level === "WARN" &&
				typeof event.msg === "string" &&
				event.msg.includes("grok-4.7") &&
				event.msg.includes("grok-5"),
		);
		expect(warnLogs.length).toBe(1);
	});

	it("does not log again on a repeated derivation that keeps the same pick", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();
		logs = [];

		deriveXaiCatalogDefaults();
		deriveXaiCatalogDefaults();

		const warnLogs = logs.filter((event) => event.level === "WARN");
		expect(warnLogs.length).toBe(0);
	});

	it("leaves defaults untouched when the catalog has no matching bare grok model", async () => {
		await warmXaiCatalog({
			"grok-4.7-beta": {
				id: "grok-4.7-beta",
				name: "Grok 4.7 Beta (not a bare version)",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
		});

		deriveXaiCatalogDefaults();

		// Falls through to the registered factory default, since no bare-version
		// catalog candidate exists to derive from.
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe(
			FACTORY_DEFAULT_MODEL,
		);
	});

	it("an account's own derived default still wins over the catalog-wide pick", async () => {
		await warmXaiCatalog({
			"grok-5": {
				id: "grok-5",
				name: "Grok 5",
				cost: { input: 1, output: 1 },
				release_date: "2026-09-15",
				tool_call: true,
			},
		});
		deriveXaiCatalogDefaults();
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-5");

		const { setDerivedAccountModelDefaults } = await import(
			"../../provider-model-defaults"
		);
		setDerivedAccountModelDefaults("xai", "acct-1", { sonnet: "grok-4.5" });

		expect(resolveProviderModelDefault("xai", "sonnet", "acct-1")).toBe(
			"grok-4.5",
		);
		// A different account with no listing of its own still gets the
		// catalog-wide pick.
		expect(resolveProviderModelDefault("xai", "sonnet", "acct-2")).toBe(
			"grok-5",
		);
	});
});

describe("getCatalogModelSummaries availability used by deriveXaiCatalogDefaults", () => {
	// Sanity check that the accessor this module depends on is reachable from
	// @better-ccflare/core with the shape catalog-defaults.ts expects - guards
	// against a barrel-export regression silently breaking derivation.
	it("is exported and returns an array", () => {
		expect(Array.isArray(getCatalogModelSummaries("xai"))).toBe(true);
	});
});
