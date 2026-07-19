const MAX_RESET_MS = 24 * 60 * 60 * 1000;

function clampFutureReset(candidateMs: number, now: number): number | null {
	if (!Number.isFinite(candidateMs) || candidateMs <= now) return null;
	return Math.min(candidateMs, now + MAX_RESET_MS);
}

function parseRetryAfter(value: string | null, now: number): number | null {
	if (!value) return null;
	const numeric = Number(value);
	if (!Number.isNaN(numeric)) {
		if (!Number.isFinite(numeric) || numeric <= 0) return null;
		return clampFutureReset(now + numeric * 1000, now);
	}
	return clampFutureReset(new Date(value).getTime(), now);
}

function parseEpochSeconds(value: string | null, now: number): number | null {
	if (!value) return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return clampFutureReset(numeric * 1000, now);
}

/**
 * Parse Anthropic reset headers without inferring failure scope. RFC numeric
 * `Retry-After` values are always delay-seconds; vendor reset headers are Unix
 * epoch-seconds. The earliest usable candidate wins and is capped at 24 hours.
 */
export function parseAnthropicRateLimitResetAt(
	headers: Headers,
	now: number = Date.now(),
): number | null {
	const candidates = [
		parseRetryAfter(headers.get("retry-after"), now),
		parseEpochSeconds(headers.get("x-ratelimit-reset"), now),
		parseEpochSeconds(headers.get("anthropic-ratelimit-unified-reset"), now),
	].filter((candidate): candidate is number => candidate !== null);
	return candidates.length > 0 ? Math.min(...candidates) : null;
}
