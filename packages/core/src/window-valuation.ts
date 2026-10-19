/**
 * Pure valuation helper for the Window Value Ledger (issue #252, task P1.3).
 *
 * Turns a per-model token aggregate (typically
 * `dbOps.aggregateTokensByModel`'s output for one window's life) into a
 * priced total using the era-versioned list-price table in ./value-pricing.
 * Deliberately pure and synchronous — no DB access, no Date.now() — so it
 * can be unit tested with synthetic fixtures and reused unchanged by the
 * live ledger (packages/http-api/src/services/usage-window-ledger.ts) and
 * the later backfill CLI.
 */
import { priceTokensAtListPrice } from "./value-pricing";

/** The subset of one model's window totals contributed by requests whose
 * prompt (input + cache read + cache creation) exceeded
 * LONG_CONTEXT_PROMPT_TOKENS (see ./value-pricing). Same fields and units as
 * the parent totals; each field is <= the parent's. */
export interface LongContextTokenSubset {
	requestCount: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

/** One model's token/request totals over some time range — the shape
 * `RequestRepository.aggregateTokensByModel` returns. */
export interface WindowTokenAggregate {
	model: string;
	requestCount: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	/** Absent only when the split is unknown (a `model_breakdown` stored
	 * before the split existed); a model with long-context list-price rates
	 * then prices as `null`. */
	longContext?: LongContextTokenSubset;
}

/** Per-model line in a `WindowValuation.modelBreakdown`. `valueUsd` is
 * `null` when this model could not be priced at `atMs` (see
 * `priceTokensAtListPrice`) — its tokens are folded into the parent
 * `unpricedTokens` total instead of contributing to `valueUsd`. */
export interface ModelValueBreakdownEntry {
	requestCount: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	valueUsd: number | null;
	/** Persisted in `model_breakdown` so re-valuation can re-apply the tier;
	 * absent on rows written before the split existed. */
	longContext?: LongContextTokenSubset;
}

export interface WindowValuation {
	/** Sum of every PRICED model's value, in dollars. Never null — a window
	 * with zero priced spend (everything unpriced, or no aggregates at all)
	 * values at exactly 0, distinct from "unpriced" which is tracked
	 * separately via `unpricedTokens`. */
	valueUsd: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	requestCount: number;
	/** Total token count (input + cacheRead + cacheCreation + output) across
	 * every model that could NOT be priced at `atMs`. A loud signal that
	 * `valueUsd` understates the window's real value — never silently
	 * dropped. */
	unpricedTokens: number;
	/** Per-model breakdown, keyed by model id. */
	modelBreakdown: Record<string, ModelValueBreakdownEntry>;
}

function emptyEntry(): ModelValueBreakdownEntry {
	return {
		requestCount: 0,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		valueUsd: null,
	};
}

/**
 * Prices each model in `aggregates` at the list price in effect at `atMs`
 * (see `priceTokensAtListPrice`) and rolls the results up into a single
 * window valuation.
 *
 * A model that cannot be priced at `atMs` (unknown model, or `atMs` before
 * its earliest era — see `priceTokensAtListPrice`) sends its full token
 * total into `unpricedTokens` and records `valueUsd: null` on its
 * `modelBreakdown` entry; every other, priceable model still contributes to
 * `valueUsd` normally. Two aggregate rows for the same model are merged
 * (summed) rather than the later one clobbering the earlier — defensive
 * against a caller that hasn't pre-grouped by model.
 *
 * Each row's `longContext` subset (requests over the long-context prompt
 * threshold) is passed to the pricer so a model with a long-context tier
 * prices that subset at the tier rates; a row without it prices as `null`
 * for such a model. Subsets are summed field-wise into the breakdown entry,
 * which carries `longContext` only if some row for the model had one.
 */
export function valueWindowAggregates(
	aggregates: readonly WindowTokenAggregate[],
	atMs: number,
	resolveModel: (model: string) => string = (model) => model,
): WindowValuation {
	let valueUsd = 0;
	let inputTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let outputTokens = 0;
	let requestCount = 0;
	let unpricedTokens = 0;
	const modelBreakdown: Record<string, ModelValueBreakdownEntry> = {};

	for (const item of aggregates) {
		inputTokens += item.inputTokens;
		cacheReadInputTokens += item.cacheReadInputTokens;
		cacheCreationInputTokens += item.cacheCreationInputTokens;
		outputTokens += item.outputTokens;
		requestCount += item.requestCount;

		const price = priceTokensAtListPrice(
			resolveModel(item.model),
			atMs,
			{
				inputTokens: item.inputTokens,
				cacheReadInputTokens: item.cacheReadInputTokens,
				cacheCreationInputTokens: item.cacheCreationInputTokens,
				outputTokens: item.outputTokens,
			},
			item.longContext
				? {
						inputTokens: item.longContext.inputTokens,
						cacheReadInputTokens: item.longContext.cacheReadInputTokens,
						cacheCreationInputTokens: item.longContext.cacheCreationInputTokens,
						outputTokens: item.longContext.outputTokens,
					}
				: undefined,
		);

		const entry = modelBreakdown[item.model] ?? emptyEntry();
		entry.requestCount += item.requestCount;
		entry.inputTokens += item.inputTokens;
		entry.cacheReadInputTokens += item.cacheReadInputTokens;
		entry.cacheCreationInputTokens += item.cacheCreationInputTokens;
		entry.outputTokens += item.outputTokens;
		if (item.longContext) {
			const subset = entry.longContext ?? {
				requestCount: 0,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
			};
			subset.requestCount += item.longContext.requestCount;
			subset.inputTokens += item.longContext.inputTokens;
			subset.cacheReadInputTokens += item.longContext.cacheReadInputTokens;
			subset.cacheCreationInputTokens +=
				item.longContext.cacheCreationInputTokens;
			subset.outputTokens += item.longContext.outputTokens;
			entry.longContext = subset;
		}

		if (price === null) {
			const modelTotal =
				item.inputTokens +
				item.cacheReadInputTokens +
				item.cacheCreationInputTokens +
				item.outputTokens;
			unpricedTokens += modelTotal;
			// A model that was priced on an earlier row and unpriced on a later
			// one (or vice versa) shouldn't happen in practice (price depends
			// only on model+atMs, both fixed per call), but `valueUsd` staying
			// non-null once set, rather than being reset to null here, keeps
			// the merge associative regardless of row order.
		} else {
			valueUsd += price;
			entry.valueUsd = (entry.valueUsd ?? 0) + price;
		}
		modelBreakdown[item.model] = entry;
	}

	return {
		valueUsd,
		inputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		outputTokens,
		requestCount,
		unpricedTokens,
		modelBreakdown,
	};
}
