import type { Account } from "@better-ccflare/types";
import { getEndpointUrl } from "./model-mappings";
import { getCatalogModelSummaries } from "./pricing";

const OFFICIAL_XAI_HOSTS = new Set(["api.x.ai"]);

/**
 * Official xAI context windows for Grok 4.5 / 4.6 / 4.7 (docs.x.ai: 500,000 tokens).
 * Original grok-4 is intentionally absent — it is a different, smaller window
 * and must not inherit 500k via a `grok-4` prefix match on `grok-4.6`.
 *
 * This bundled table is now the fallback, not the primary source: a new xAI
 * release's window comes from the models.dev catalog first (see
 * `resolveXaiContextWindowFromCatalog`), so a future model needs no edit
 * here. This table only matters when the catalog has no usable entry for a
 * given model (offline, unfetched, or the model simply predates this table).
 */
const XAI_CONTEXT_WINDOW_BY_FAMILY: Readonly<Record<string, number>> = {
	"grok-4.7": 500_000,
	"grok-4.6": 500_000,
	"grok-4.5": 500_000,
};
const XAI_CONTEXT_WINDOW_FAMILIES = Object.keys(
	XAI_CONTEXT_WINDOW_BY_FAMILY,
).sort((a, b) => b.length - a.length);

/**
 * Sanity bounds for a catalog-published `limit.context` value. models.dev is
 * an unvalidated, community-editable document; a context window outside
 * these bounds is treated as a data error rather than trusted verbatim -
 * bounds chosen well outside any real model's window (smallest published
 * context windows are in the low tens of thousands; no model publishes a
 * window anywhere near 10M).
 */
const XAI_CATALOG_CONTEXT_WINDOW_MIN = 8_000;
const XAI_CATALOG_CONTEXT_WINDOW_MAX = 10_000_000;

function isSaneCatalogContextWindow(
	value: number | undefined,
): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= XAI_CATALOG_CONTEXT_WINDOW_MIN &&
		value <= XAI_CATALOG_CONTEXT_WINDOW_MAX
	);
}

export interface XaiContextWindowResolution {
	family: string;
	contextWindow: number;
	match: "exact" | "prefix" | "catalog-exact" | "catalog-prefix";
}

/**
 * Catalog-first context window lookup: consults the most recently loaded
 * models.dev "xai" section (synchronously, via `getCatalogModelSummaries` -
 * see its own doc comment for the memory/disk/bundled fallback order) before
 * ever touching the bundled table. An exact catalog id wins outright; failing
 * that, the longest catalog id that `model` extends by a `-` boundary wins.
 * A catalog value outside the sanity bounds is treated as absent so a bad
 * catalog entry cannot silently ship: the caller falls through to the
 * bundled table.
 */
function resolveXaiContextWindowFromCatalog(
	model: string,
): XaiContextWindowResolution | undefined {
	const summaries = getCatalogModelSummaries("xai");
	if (summaries.length === 0) return undefined;

	const exactEntry = summaries.find((entry) => entry.id === model);
	if (exactEntry && isSaneCatalogContextWindow(exactEntry.contextWindow)) {
		return {
			family: exactEntry.id,
			contextWindow: exactEntry.contextWindow,
			match: "catalog-exact",
		};
	}

	let bestPrefixEntry: (typeof summaries)[number] | undefined;
	for (const entry of summaries) {
		if (!entry.id || !model.startsWith(`${entry.id}-`)) continue;
		if (!bestPrefixEntry || entry.id.length > bestPrefixEntry.id.length) {
			bestPrefixEntry = entry;
		}
	}
	if (
		bestPrefixEntry &&
		isSaneCatalogContextWindow(bestPrefixEntry.contextWindow)
	) {
		return {
			family: bestPrefixEntry.id,
			contextWindow: bestPrefixEntry.contextWindow,
			match: "catalog-prefix",
		};
	}

	return undefined;
}

export function resolveXaiContextWindow(
	model: string,
): XaiContextWindowResolution | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;

	const catalogResolution = resolveXaiContextWindowFromCatalog(model);
	if (catalogResolution) return catalogResolution;

	const exact = XAI_CONTEXT_WINDOW_BY_FAMILY[model];
	if (exact !== undefined) {
		return { family: model, contextWindow: exact, match: "exact" };
	}
	const family =
		XAI_CONTEXT_WINDOW_FAMILIES.find((key) => model.startsWith(`${key}-`)) ??
		"";
	const contextWindow = family
		? XAI_CONTEXT_WINDOW_BY_FAMILY[family]
		: undefined;
	if (contextWindow === undefined) return undefined;
	return { family, contextWindow, match: "prefix" };
}

/**
 * Resolve whether an account targets official xAI infrastructure.
 * Invalid custom endpoints are not official, even though XaiProvider.buildUrl
 * falls them back to the official default for transport safety.
 */
export function isOfficialXaiEndpoint(account?: Account | null): boolean {
	if (account && account.provider !== "xai") return false;
	if (account?.custom_endpoint) {
		let endpoint: string | null;
		try {
			endpoint = getEndpointUrl(account);
		} catch {
			return false;
		}
		if (!endpoint) return false;
		try {
			return OFFICIAL_XAI_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
		} catch {
			return false;
		}
	}
	return true;
}

export type XaiCacheOutcome = "hit" | "miss" | "unknown" | "fail_closed";

export interface XaiCacheCanaryFields {
	requestId?: string;
	accountId?: string;
	accountName?: string;
	officialEndpoint: boolean;
	keyPresent: boolean;
	identityFingerprint?: string;
	prefixFingerprint?: string;
	cacheOutcome: XaiCacheOutcome;
	cachedTokens?: number;
	inputTokens?: number;
	failClosedReason?: string;
}

/** Compact structured canary line for mechanism proof, without prompt content. */
export function formatXaiCacheCanary(fields: XaiCacheCanaryFields): string {
	const parts = [
		`official=${fields.officialEndpoint ? "1" : "0"}`,
		`key=${fields.keyPresent ? "1" : "0"}`,
		`outcome=${fields.cacheOutcome}`,
	];
	if (fields.requestId) parts.push(`req=${fields.requestId}`);
	if (fields.accountId) parts.push(`account=${fields.accountId}`);
	if (fields.accountName) parts.push(`account_name=${fields.accountName}`);
	if (fields.identityFingerprint)
		parts.push(`id=${fields.identityFingerprint}`);
	if (fields.prefixFingerprint)
		parts.push(`prefix=${fields.prefixFingerprint}`);
	if (fields.cachedTokens !== undefined)
		parts.push(`cached=${fields.cachedTokens}`);
	if (fields.inputTokens !== undefined)
		parts.push(`input=${fields.inputTokens}`);
	if (fields.failClosedReason) parts.push(`reason=${fields.failClosedReason}`);
	return parts.join(" ");
}

/**
 * Classify cache outcome from provider token telemetry.
 *
 * xAI (and other automatic-prefix caches) can return a tiny positive
 * `cached_tokens` value even when the useful conversation prefix was
 * evicted. Treat those near-zero ratios as misses so flight-recorder and
 * canary paths surface the collapse instead of a false hit.
 *
 * Threshold is intentionally low (5%): warm multi-turn traffic sits at
 * 99%+, while cold starts and post-eviction collapses land well below 5%.
 */
export const XAI_EFFECTIVE_CACHE_HIT_MIN_RATIO = 0.05;

export function cacheOutcomeFromTokens(
	cachedTokens: number | undefined | null,
	detailsPresent: boolean,
	totalInputTokens?: number | null,
): XaiCacheOutcome {
	if (!detailsPresent || typeof cachedTokens !== "number") return "unknown";
	if (cachedTokens <= 0) return "miss";
	if (
		typeof totalInputTokens === "number" &&
		Number.isFinite(totalInputTokens) &&
		totalInputTokens > 0 &&
		cachedTokens / totalInputTokens < XAI_EFFECTIVE_CACHE_HIT_MIN_RATIO
	) {
		return "miss";
	}
	return "hit";
}
