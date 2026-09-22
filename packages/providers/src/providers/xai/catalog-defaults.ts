import {
	type CatalogModelSummary,
	getCatalogModelSummaries,
	onPricingCatalogLoaded,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { setDerivedProviderWideModelDefaults } from "../../provider-model-defaults";

const log = new Logger("XaiCatalogDefaults");

/**
 * Hardcoded rather than imported from `./provider` (XAI_MODEL_MAPPINGS'
 * keys): `./provider.ts` imports this module for its reactive side effect
 * (see bottom of file), so importing back from it here would create a
 * circular module dependency. These four families are xai's whole surface;
 * duplicating the list is a smaller cost than a cycle.
 */
const XAI_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * A "bare" Grok release id: `grok-<major>` or `grok-<major>.<minor>`, with no
 * date suffix, beta/preview tag, or other qualifier. Matches the models.dev
 * convention for a provider's primary release id (e.g. `grok-4.7`, `grok-5`);
 * excludes fixture/decoy-shaped ids like `grok-4.7-beta` or
 * `grok-4-fast-reasoning`, which are variants of a release, not a release
 * pick in their own right.
 */
const BARE_GROK_RELEASE_ID_RE = /^grok-\d+(\.\d+)?$/;

interface XaiCatalogCandidate {
	id: string;
	releaseDate: string;
}

/**
 * The newest xai release the catalog currently supports as a provider
 * default, by `release_date` - deliberately a plain string comparison, not a
 * parsed-version-number comparison. A version-number comparison is the wrong
 * tool here: it would let a decoy id like `grok-4.20` (parsed as major 4,
 * minor 20) outrank `grok-5`, when models.dev's actual release timeline is
 * the only fact this derivation is allowed to trust.
 *
 * Excluded from consideration:
 *   - non-"bare" ids (see `BARE_GROK_RELEASE_ID_RE`)
 *   - entries with no `release_date` published (absence of the fact this
 *     entire derivation depends on, not evidence of anything)
 *   - entries explicitly marked `tool_call: false` (Claude Code traffic is
 *     tool-call-shaped end to end; `tool_call` left unset is not evidence of
 *     `false` and does not exclude an entry)
 */
function pickNewestXaiCatalogCandidate(): XaiCatalogCandidate | undefined {
	const summaries: CatalogModelSummary[] = getCatalogModelSummaries("xai");
	let newest: XaiCatalogCandidate | undefined;
	for (const entry of summaries) {
		if (!entry.id || !BARE_GROK_RELEASE_ID_RE.test(entry.id)) continue;
		if (entry.toolCall === false) continue;
		if (!entry.releaseDate) continue;
		if (!newest || entry.releaseDate > newest.releaseDate) {
			newest = { id: entry.id, releaseDate: entry.releaseDate };
		}
	}
	return newest;
}

let lastAcceptedModel: string | undefined;
let lastAcceptedReleaseDate: string | undefined;

/** Test seam: this module's derivation state is process-wide and leaks between cases. */
export function resetXaiCatalogDefaultsForTest(): void {
	lastAcceptedModel = undefined;
	lastAcceptedReleaseDate = undefined;
}

/**
 * Recompute xai's provider-wide model defaults from the most recently loaded
 * models.dev catalog and, if the pick changed, publish it via
 * `setDerivedProviderWideModelDefaults`.
 *
 * Monotonic by design: a candidate older (by `release_date`) than the
 * already-accepted pick is ignored outright, so a catalog that transiently
 * loses its newest entry (a stale mirror, a fetch that only partially
 * refreshed) can never roll xai's default backward. Only a strictly-newer
 * candidate updates the pick; re-deriving the same id again is a no-op with
 * no log line - the operator-facing warning fires exactly once per actual
 * change, naming the old and new model.
 *
 * Public (not module-private) so tests can call it deterministically instead
 * of depending on `onPricingCatalogLoaded` firing order; production reaches
 * it only through the reactive subscription at the bottom of this file.
 */
export function deriveXaiCatalogDefaults(): void {
	const candidate = pickNewestXaiCatalogCandidate();
	if (!candidate) return;

	if (
		lastAcceptedReleaseDate !== undefined &&
		candidate.releaseDate < lastAcceptedReleaseDate
	) {
		return;
	}
	lastAcceptedReleaseDate = candidate.releaseDate;

	if (candidate.id === lastAcceptedModel) return;

	const previous = lastAcceptedModel;
	lastAcceptedModel = candidate.id;

	const families: Record<string, string> = {};
	for (const family of XAI_FAMILIES) families[family] = candidate.id;
	setDerivedProviderWideModelDefaults("xai", families);

	log.warn(
		`xai catalog-derived default changed from ${previous ?? "factory default"} to ${candidate.id} (release_date=${candidate.releaseDate})`,
	);
}

// Reactive by design (see module doc): xai's derived default only updates
// when some other code path (dashboard model listing, cost estimation, an
// account listing refresh, etc.) triggers a models.dev catalog load. There is
// deliberately no eager warmup at import time here - neither an async
// fetch-triggering warmup (would put network I/O on this module's import
// path) nor a synchronous disk-cache read (would make xai's default depend on
// this process's machine-local cache state at import time, rather than on an
// actual catalog load this process observed).
onPricingCatalogLoaded(() => {
	deriveXaiCatalogDefaults();
});
