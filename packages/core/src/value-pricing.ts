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
 * rate). The ledger stamps it onto each closed window as
 * `projection_version`; at server startup it re-prices every closed window
 * stamped with any other version from its stored model breakdown
 * (UsageWindowLedger.revalueStaleClosedWindows), so history follows the
 * current rates instead of keeping the price it was closed at.
 */
export const VALUE_PRICING_VERSION = "2026-10-18.1";

/**
 * Prompt-token threshold (input + cache read + cache creation, per request)
 * above which a model with `longContext` rates bills the WHOLE request at
 * those rates — Anthropic's published Haiku 5.5 tier.
 * `RequestRepository.aggregateTokensByModel` splits each model's totals at
 * this threshold so window valuation can apply a tier without per-request
 * rows. It is one global threshold: a future model whose tier starts
 * elsewhere needs the split extended, not a second constant.
 */
export const LONG_CONTEXT_PROMPT_TOKENS = 100_000;

/**
 * Long-context rates, in dollars per 1,000,000 tokens. Same meaning as the
 * owning era's own fields, including the "undefined `cacheCreationPerM` =
 * unknown rate" rule.
 */
export interface LongContextListPrice {
	inputPerM: number;
	cacheReadPerM: number;
	cacheCreationPerM?: number;
	outputPerM: number;
}

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
	/**
	 * Rates for requests whose prompt exceeded `LONG_CONTEXT_PROMPT_TOKENS`;
	 * omitted for models with no published long-context tier.
	 */
	longContext?: LongContextListPrice;
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
			// /tmp/better-ccflare/models.dev.json on 2026-08-22. This is the
			// pre-2026-08-21 rate; the dated era below supersedes it from that day.
		},
		{
			sinceMs: Date.parse("2026-08-21T00:00:00Z"),
			inputPerM: 4.0,
			cacheReadPerM: 0.4,
			cacheCreationPerM: 5.0,
			outputPerM: 20.0,
			// source: https://developers.openai.com/api/docs/pricing
			// "| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |"
			// and https://developers.openai.com/api/docs/models/gpt-5.6-sol (Input $4,
			// Cached input $0.4, Output $20; "Cache writes are billed at 1.25x the
			// uncached input token rate"); changelog 2026-08-21: "GPT-5.6 Sol now
			// costs $4 per million input tokens and $20 per million output tokens".
			// Promotional, available "at least through November 21, 2026".
			// checked 2026-10-18. No longContext: see the OpenAI note below.
		},
	],

	// OpenAI's >272K-prompt surcharge (2x input/cache, 1.5x output for the WHOLE
	// request) is deliberately NOT modelled for any OpenAI entry. A stored
	// model_breakdown keeps only the subset of tokens from requests over the
	// global 100K LONG_CONTEXT_PROMPT_TOKENS split, so re-valuation cannot tell a
	// 100K-272K request (standard rate) from a >272K one. Pricing everything at
	// standard rates is a conservative lower bound: never overcharge.
	// Terra/Luna: the current eras above come from models.dev's 'openai' section
	// and were NOT re-verified against OpenAI's pricing page. The 2026-07-30
	// changelog ("GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20%
	// less") gives no figures, so no pre-07-30 era is recorded (that window may
	// be mispriced). No cache-write rate is confirmed for either model, so
	// cache-creation tokens return null (unpriced) rather than a guessed rate.
	"gpt-6-astra": [
		{
			sinceMs: Date.parse("2026-09-03T00:00:00Z"),
			inputPerM: 10.0,
			cacheReadPerM: 1.0,
			cacheCreationPerM: 12.5,
			outputPerM: 50.0,
			// source: https://developers.openai.com/api/docs/pricing
			// "| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |"
			// and https://developers.openai.com/api/docs/models/gpt-6-astra (same base
			// rates); launch 2026-09-03 per https://developers.openai.com/api/docs/changelog.
			// checked 2026-10-18.
		},
	],
	"gpt-6-sol": [
		{
			sinceMs: Date.parse("2026-09-22T00:00:00Z"),
			inputPerM: 2.0,
			cacheReadPerM: 0.2,
			cacheCreationPerM: 2.5,
			outputPerM: 10.0,
			// source: https://developers.openai.com/api/docs/pricing
			// "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |"
			// and https://developers.openai.com/api/docs/models/gpt-6-sol (same base
			// rates); launch 2026-09-22 per https://developers.openai.com/api/docs/changelog.
			// checked 2026-10-18.
		},
	],
	"gpt-6.1-sol": [
		{
			sinceMs: Date.parse("2026-09-29T00:00:00Z"),
			inputPerM: 2.0,
			cacheReadPerM: 0.1,
			cacheCreationPerM: 2.5,
			outputPerM: 10.0,
			// source: https://developers.openai.com/api/docs/pricing
			// "| gpt-6.1-sol | $2.00 | $0.10 | $2.50 | $10.00 | $4.00 | $0.20 | $5.00 | $15.00 |"
			// and https://developers.openai.com/api/docs/models/gpt-6.1-sol (same base
			// rates); launch 2026-09-29 per https://developers.openai.com/api/docs/changelog.
			// checked 2026-10-18.
		},
	],
	"gpt-6-luna": [
		{
			sinceMs: Date.parse("2026-09-22T00:00:00Z"),
			inputPerM: 0.1,
			cacheReadPerM: 0.01,
			cacheCreationPerM: 0.125,
			outputPerM: 0.5,
			// source: https://developers.openai.com/api/docs/pricing
			// "| gpt-6-luna | $0.10 | $0.01 | $0.125 | $0.50 | $0.20 | $0.02 | $0.25 | $0.75 |"
			// and https://developers.openai.com/api/docs/models/gpt-6-luna (same base
			// rates); launch 2026-09-22 per https://developers.openai.com/api/docs/changelog.
			// checked 2026-10-18.
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
	[CLAUDE_MODEL_IDS.HAIKU_5_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 0.1,
			cacheReadPerM: 0.01,
			// Published 5-minute write rate applied to aggregate cache creation until TTL buckets are preserved end-to-end.
			cacheCreationPerM: 0.125,
			outputPerM: 0.5,
			// source: https://platform.claude.com/docs/en/about-claude/pricing
			longContext: {
				inputPerM: 0.5,
				cacheReadPerM: 0.05,
				cacheCreationPerM: 0.625,
				outputPerM: 2.5,
			},
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
			inputPerM: 2,
			cacheReadPerM: 0.2,
			// Published 5-minute write rate applied to aggregate cache creation until TTL buckets are preserved end-to-end.
			cacheCreationPerM: 2.5,
			outputPerM: 10,
			// $2/$10 is the standard price; the planned $3/$15 increase never took effect, so this corrects the single era rather than adding a dated one.
			// source: https://platform.claude.com/docs/en/about-claude/pricing
		},
	],
	[CLAUDE_MODEL_IDS.SONNET_5_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 2,
			cacheReadPerM: 0.2,
			// Published 5-minute write rate applied to aggregate cache creation until TTL buckets are preserved end-to-end.
			cacheCreationPerM: 2.5,
			outputPerM: 10,
			// source: https://platform.claude.com/docs/en/about-claude/pricing
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
	[CLAUDE_MODEL_IDS.OPUS_5_5]: [
		{
			sinceMs: INITIAL_ERA_FLOOR_MS,
			inputPerM: 4,
			cacheReadPerM: 0.2,
			cacheCreationPerM: 5,
			outputPerM: 20,
			// source: BUNDLED_PRICING[anthropic].models[CLAUDE_MODEL_IDS.OPUS_5_5].cost in packages/core/src/pricing.ts
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
 * `tokens` are the FULL totals. `longContextTokens` is the subset of
 * `tokens` contributed by requests whose prompt exceeded
 * `LONG_CONTEXT_PROMPT_TOKENS`; `undefined` means the split is unknown.
 * When the selected era has no `longContext` rates the subset is ignored
 * (its tokens are already inside `tokens`). When it does, the subset is
 * priced at the long-context rates and the remainder at the base rates.
 *
 * Returns `null` — never `0` — when:
 * - the model has no era table at all (unknown model), or
 * - `atMs` precedes every era's `sinceMs` (unknown era for a known model), or
 * - cache-creation tokens are positive but the rate that applies to them
 *   (base for the base portion, `longContext` for the long portion) is
 *   undefined. A partial total that silently drops cache-creation spend
 *   would understate the window's real value; the caller must record this
 *   as unpriced rather than getting a number that looks complete but isn't, or
 * - the era has `longContext` rates and `longContextTokens` is `undefined`
 *   (the caller cannot tell which requests crossed the tier, and a
 *   base-tier number would look complete while understating), or
 * - the era has `longContext` rates and any `longContextTokens` field
 *   exceeds its `tokens` counterpart (malformed split).
 *
 * A caller that gets `null` should record the corresponding tokens as
 * `unpriced_tokens` on the window row rather than treating the request as
 * free.
 */
export function priceTokensAtListPrice(
	model: string,
	atMs: number,
	tokens: TokenBreakdown,
	longContextTokens?: TokenBreakdown,
): number | null {
	const eras = LIST_PRICE_ERAS[model];
	if (!eras || eras.length === 0) return null;

	const era = selectEra(eras, atMs);
	if (!era) return null;

	const longRates = era.longContext;
	if (longRates && longContextTokens === undefined) return null;

	const longIn = longRates ? (longContextTokens?.inputTokens ?? 0) : 0;
	const longRead = longRates
		? (longContextTokens?.cacheReadInputTokens ?? 0)
		: 0;
	const longWrite = longRates
		? (longContextTokens?.cacheCreationInputTokens ?? 0)
		: 0;
	const longOut = longRates ? (longContextTokens?.outputTokens ?? 0) : 0;

	const baseIn = (tokens.inputTokens ?? 0) - longIn;
	const baseRead = (tokens.cacheReadInputTokens ?? 0) - longRead;
	const baseWrite = (tokens.cacheCreationInputTokens ?? 0) - longWrite;
	const baseOut = (tokens.outputTokens ?? 0) - longOut;
	if (baseIn < 0 || baseRead < 0 || baseWrite < 0 || baseOut < 0) return null;

	if (baseWrite > 0 && era.cacheCreationPerM === undefined) return null;
	if (longWrite > 0 && longRates?.cacheCreationPerM === undefined) return null;

	let total = 0;
	total += (baseIn * era.inputPerM) / 1_000_000;
	total += (baseRead * era.cacheReadPerM) / 1_000_000;
	if (era.cacheCreationPerM !== undefined) {
		total += (baseWrite * era.cacheCreationPerM) / 1_000_000;
	}
	total += (baseOut * era.outputPerM) / 1_000_000;
	if (longRates) {
		total += (longIn * longRates.inputPerM) / 1_000_000;
		total += (longRead * longRates.cacheReadPerM) / 1_000_000;
		if (longRates.cacheCreationPerM !== undefined) {
			total += (longWrite * longRates.cacheCreationPerM) / 1_000_000;
		}
		total += (longOut * longRates.outputPerM) / 1_000_000;
	}

	return total;
}
