export interface NormalizedOpenAIInputUsage {
	/** OpenAI-compatible inclusive prompt-token total. */
	totalInputTokens: number;
	/** Anthropic additive input tokens, excluding cache reads and writes. */
	inputTokens: number;
	/** Present only when the upstream reported cache-read telemetry. */
	cacheReadInputTokens?: number;
	/** Present only when the upstream reported cache-write telemetry. */
	cacheCreationInputTokens?: number;
}

function normalizeOptionalCount(
	value: unknown,
	maximum: number,
): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.min(value, maximum);
}

/**
 * Convert OpenAI-compatible inclusive prompt usage to Anthropic's additive
 * fields. `prompt_tokens` includes cache reads (and, for providers that expose
 * it, cache writes), while Anthropic reports those buckets separately from
 * `input_tokens`. Copying the inclusive total into `input_tokens` therefore
 * double-counts cached tokens in downstream totals and billing.
 *
 * Explicit zero cache measurements stay present; missing or invalid cache
 * telemetry stays absent. Counts are clamped to the inclusive total so a bad
 * provider payload cannot produce negative uncached input.
 */
export function normalizeOpenAIInputUsage(
	totalInputTokens: unknown,
	cacheReadInputTokens: unknown,
	cacheCreationInputTokens: unknown,
): NormalizedOpenAIInputUsage {
	const hasAuthoritativeTotal =
		typeof totalInputTokens === "number" &&
		Number.isFinite(totalInputTokens) &&
		totalInputTokens >= 0;
	if (!hasAuthoritativeTotal) {
		return {
			totalInputTokens: 0,
			inputTokens: 0,
		};
	}

	const total = totalInputTokens;
	const cacheRead = normalizeOptionalCount(cacheReadInputTokens, total);
	const remainingAfterRead = total - (cacheRead ?? 0);
	const cacheCreation = normalizeOptionalCount(
		cacheCreationInputTokens,
		remainingAfterRead,
	);

	return {
		totalInputTokens: total,
		inputTokens: remainingAfterRead - (cacheCreation ?? 0),
		...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
		...(cacheCreation !== undefined
			? { cacheCreationInputTokens: cacheCreation }
			: {}),
	};
}
