/**
 * Era-versioned list-price module for the Window Value Ledger
 * (github.com/StartupBros-com/better-ccflare issue #252).
 *
 * Window-over-window "API-equivalent value" comparisons need CONSTANT,
 * dated pricing. The live models.dev catalogue (see ./pricing.ts) drifts
 * over time — e.g. OpenAI's Sol model dropped its list price >20% on
 * 2026-08-21 — and `findModel` in ./pricing.ts currently resolves some
 * model IDs to reseller sheets rather than the canonical provider section
 * (see the `// source:` comments below for a concrete example: models.dev
 * lists a dozen different rates for "gpt-5.6-sol" across resellers before
 * you even reach the "openai" section). Summing frozen `cost_usd` recorded
 * at request time therefore produces phantom value changes whenever list
 * prices move or a lookup drifts to a different sheet — a window's total
 * "value" would silently change even though nothing about the account's
 * usage did.
 *
 * This module is the deliberate, reviewable alternative: a small,
 * hand-maintained table of dated price eras, edited only by a human PR
 * (with a `// source:` comment per entry), never by a background fetch.
 * Given a model, a timestamp, and a token breakdown, `priceTokensAtListPrice`
 * returns what that usage would have cost at the list price in effect at
 * that instant — constant forever after, regardless of what the live
 * catalogue later reports.
 *
 * Pure and deterministic: no fetch, no Date.now(). The caller always
 * supplies `atMs` (typically a window's `started_at`/`closed_at` or a
 * request's `timestamp`).
 */

import { CLAUDE_MODEL_IDS } from "./models";
import type { TokenBreakdown } from "./pricing";

/**
 * Bump this whenever LIST_PRICE_ERAS changes (new model, new era, corrected
 * rate). The ledger stamps this onto each materialized window row as
 * `projection_version` so a later rate correction can trigger an idempotent
 * recompute instead of silently leaving stale values on old rows.
 */
export const VALUE_PRICING_VERSION = "2026-09-01.1";

/**
 * One dated list-price era for a single model, in dollars per 1,000,000
 * tokens (matching the models.dev / pricing.ts convention).
 */
export interface ListPriceEra {
	/**
	 * Era start, inclusive, Unix ms. Lookup picks the last era in a model's
	 * array with `sinceMs <= atMs`. A timestamp before every era's `sinceMs`
	 * has no applicable price and resolves to `null`.
	 */
	sinceMs: number;
	inputPerM: number;
	cacheReadPerM: number;
	/**
	 * Cache-creation (cache write) rate, when the provider publishes one.
	 * Left `undefined` (not `0`) when unknown or not applicable — see
	 * `priceTokensAtListPrice`, which treats "tokens supplied but no rate"
	 * as a loud `null` rather than a silent underprice.
	 */
	cacheCreationPerM?: number;
	outputPerM: number;
}

/**
 * Conservative floor for every model's first era: 2026-06-01T00:00:00Z.
 *
 * This is not any model's real price-effective date — it is the earliest
 * point the window ledger's backfill can currently reach with confidence
 * (see issue #252's backfill reach: anthropic to 2026-07-11, codex to
 * 2026-08-08) and predates any precise price-change history we have on
 * file. A request timestamped before this floor gets `null` rather than a
 * guessed price — an unpriced gap is loud and visible; a guessed price
 * quietly poisons a window's total.
 */
const INITIAL_ERA_FLOOR_MS = Date.parse("2026-06-01T00:00:00Z");

/**
 * Per-model list-price eras, sorted ascending by `sinceMs`. Exported as a
 * plain mutable object so tests can register synthetic models without
 * touching the seed data (see value-pricing.test.ts).
 */
export const LIST_PRICE_ERAS: Record<string, ListPriceEra[]> = {
	// --- OpenAI ---
	// Verified against the models.dev 'openai' provider section specifically
	// (not first-match): the shared models.dev catalogue lists many reseller
	// sections (ai-router, cortecs, nano-gpt, openrouter, azure, ...) with
	// different rates for these same model ids, and ./pricing.ts's
	// `findModel` walks providers in object-insertion order, so a first-match
	// lookup can silently resolve to a reseller sheet instead of OpenAI's own
	// listed price.
	"gpt-5.6-terra": [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 2.0,
			cacheReadPerM: 0.2,
			outputPerM: 12.0,
			// source: models.dev 'openai' provider section, gpt-5.6-terra.cost
			// (input=2, cache_read=0.2, output=12), cross-checked against
			// /tmp/better-ccflare/models.dev.json on 2026-08-22.
		},
	],
	"gpt-5.6-luna": [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 0.2,
			cacheReadPerM: 0.02,
			outputPerM: 1.2,
			// source: models.dev 'openai' provider section, gpt-5.6-luna.cost
			// (input=0.2, cache_read=0.02, output=1.2), cross-checked against
			// /tmp/better-ccflare/models.dev.json on 2026-08-22.
		},
	],
	"gpt-5.6-sol": [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5.0,
			cacheReadPerM: 0.5,
			outputPerM: 30.0,
			// source: models.dev 'openai' provider section, gpt-5.6-sol.cost
			// (input=5, cache_read=0.5, output=30), cross-checked against
			// /tmp/better-ccflare/models.dev.json on 2026-08-22. OpenAI
			// announced a >20% Sol price drop on 2026-08-21
			// (openai.com/index/gpt-5-6); the models.dev snapshot above still
			// reflects the pre-drop rate as of this seeding, so this stays the
			// single current era. Add a second era dated 2026-08-21 (not an
			// edit to this one) once the canonical catalogue reflects the new
			// rate.
		},
	],

	// --- Anthropic ---
	// Copied from BUNDLED_PRICING in ./pricing.ts (lines ~43-279), which is
	// itself Anthropic's directly-published list pricing (not a models.dev
	// lookup), so anthropic windows price without depending on the drifting
	// live catalogue at all.
	[CLAUDE_MODEL_IDS.HAIKU_4_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 1,
			cacheReadPerM: 0.1,
			cacheCreationPerM: 1.25,
			outputPerM: 5,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.HAIKU_4_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.SONNET_4]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 3,
			cacheReadPerM: 0.3,
			cacheCreationPerM: 3.75,
			outputPerM: 15,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.SONNET_4].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.SONNET_4_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 3,
			cacheReadPerM: 0.3,
			cacheCreationPerM: 3.75,
			outputPerM: 15,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.SONNET_4_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.SONNET_4_6]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 3,
			cacheReadPerM: 0.3,
			cacheCreationPerM: 3.75,
			outputPerM: 15,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.SONNET_4_6].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.SONNET_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 3,
			cacheReadPerM: 0.3,
			cacheCreationPerM: 3.75,
			outputPerM: 15,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.SONNET_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 15,
			cacheReadPerM: 1.5,
			cacheCreationPerM: 18.75,
			outputPerM: 75,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4_1]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 15,
			cacheReadPerM: 1.5,
			cacheCreationPerM: 18.75,
			outputPerM: 75,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4_1].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5,
			cacheReadPerM: 0.5,
			cacheCreationPerM: 6.25,
			outputPerM: 25,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4_6]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5,
			cacheReadPerM: 0.5,
			cacheCreationPerM: 6.25,
			outputPerM: 25,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4_6].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4_7]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5,
			cacheReadPerM: 0.5,
			cacheCreationPerM: 6.25,
			outputPerM: 25,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4_7].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_4_8]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5,
			cacheReadPerM: 0.5,
			cacheCreationPerM: 6.25,
			outputPerM: 25,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_4_8].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.OPUS_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 5,
			cacheReadPerM: 0.5,
			cacheCreationPerM: 6.25,
			outputPerM: 25,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.FABLE_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 10,
			cacheReadPerM: 1,
			cacheCreationPerM: 12.5,
			outputPerM: 50,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.FABLE_5].cost in packages/core/src/pricing.ts
		},
	],
	[CLAUDE_MODEL_IDS.FABLE_5_1]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 10,
			cacheReadPerM: 0.25,
			// Published 5-minute write rate applied to aggregate cache creation until TTL buckets are preserved end-to-end.
			cacheCreationPerM: 12.5,
			outputPerM: 50,
			// source: https://platform.claude.com/docs/en/about-claude/pricing
		},
	],
};

/**
 * Select the applicable era: the last entry in `eras` with
 * `sinceMs <= atMs`. Does not assume `eras` is sorted (defensive — the
 * exported table is documented and maintained sorted ascending, but a
 * caller-injected test table should not be able to violate this silently).
 * Returns `null` when `atMs` precedes every era's `sinceMs`.
 */
function selectEra(
	eras: readonly ListPriceEra[],
	atMs: number,
): ListPriceEra | null {
	let selected: ListPriceEra | null = null;
	for (const era of eras) {
		if (era.sinceMs <= atMs && (!selected || era.sinceMs > selected.sinceMs)) {
			selected = era;
		}
	}
	return selected;
}

/**
 * Price a token breakdown at the list price in effect for `model` at
 * `atMs`, in dollars.
 *
 * Returns `null` — never `0` — when:
 * - the model has no era table at all (unknown model), or
 * - `atMs` precedes every era's `sinceMs` (unknown era for a known model), or
 * - `tokens.cacheCreationInputTokens` is positive but the selected era has
 *   no `cacheCreationPerM` rate. A partial total that silently drops
 *   cache-creation spend would understate the window's real value; the
 *   caller must record this as unpriced rather than getting a number that
 *   looks complete but isn't.
 *
 * A caller that gets `null` should record the corresponding tokens as
 * `unpriced_tokens` on the window row rather than treating the request as
 * free.
 */
export function priceTokensAtListPrice(
	model: string,
	atMs: number,
	tokens: TokenBreakdown,
): number | null {
	const eras = LIST_PRICE_ERAS[model];
	if (!eras || eras.length === 0) return null;

	const era = selectEra(eras, atMs);
	if (!era) return null;

	const cacheCreationTokens = tokens.cacheCreationInputTokens ?? 0;
	if (cacheCreationTokens > 0 && era.cacheCreationPerM === undefined) {
		return null;
	}

	let total = 0;
	total += ((tokens.inputTokens ?? 0) * era.inputPerM) / 1_000_000;
	total += ((tokens.cacheReadInputTokens ?? 0) * era.cacheReadPerM) / 1_000_000;
	if (era.cacheCreationPerM !== undefined) {
		total += (cacheCreationTokens * era.cacheCreationPerM) / 1_000_000;
	}
	total += ((tokens.outputTokens ?? 0) * era.outputPerM) / 1_000_000;

	return total;
}
