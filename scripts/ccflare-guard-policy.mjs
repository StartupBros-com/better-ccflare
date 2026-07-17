export const DEFAULT_GUARD_POLICY_ID = "pool-exhaustion-finite-recovery-v1";

function headerValue(headers, name) {
	if (typeof headers?.get === "function") return headers.get(name);
	if (!headers || typeof headers !== "object") return null;
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && value != null) return String(value);
	}
	return null;
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function parseFutureTimestampMs(value, nowMs) {
	if (typeof value !== "string" || value.trim() === "") return null;
	const timestampMs = Date.parse(value);
	if (!Number.isFinite(timestampMs)) return null;
	const delayMs = timestampMs - nowMs;
	return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : null;
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
	if (typeof value !== "string" || value.trim() === "") return null;
	const normalized = value.trim();
	if (/^\d+$/.test(normalized)) {
		const seconds = Number(normalized);
		const delayMs = seconds * 1_000;
		return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : null;
	}
	return parseFutureTimestampMs(normalized, nowMs);
}

function noRetry(reason) {
	return { retry: false, reason, delayMs: 0, recoverySource: null };
}

/**
 * The guard may hold a client connection only for an explicit whole-pool
 * terminal with a concrete automatic recovery time. All other responses are
 * forwarded exactly once so model-scoped and provider-specific errors remain
 * visible to the caller and the router can own fallback policy.
 */
export function evaluateGuardRetry({
	status,
	headers,
	bodyText,
	nowMs = Date.now(),
}) {
	if (status !== 503) return noRetry("status_not_retryable");

	const poolStatus = headerValue(
		headers,
		"x-better-ccflare-pool-status",
	)?.trim();
	if (poolStatus !== "exhausted") return noRetry("pool_not_exhausted");

	const body = parseJson(bodyText);
	if (!body || typeof body !== "object") return noRetry("malformed_body");
	if (body.error?.type !== "pool_exhausted") {
		return noRetry("not_pool_exhausted_terminal");
	}

	const candidates = [];
	const retryAfterMs = parseRetryAfterMs(
		headerValue(headers, "retry-after"),
		nowMs,
	);
	if (retryAfterMs != null) {
		candidates.push({ delayMs: retryAfterMs, source: "retry-after" });
	}

	const nextAvailableMs = parseFutureTimestampMs(
		body.error.next_available_at,
		nowMs,
	);
	if (nextAvailableMs != null) {
		candidates.push({
			delayMs: nextAvailableMs,
			source: "error.next_available_at",
		});
	}

	const accounts = [
		...(Array.isArray(body.error.accounts) ? body.error.accounts : []),
		...(Array.isArray(body.accounts) ? body.accounts : []),
	];
	for (const account of accounts) {
		const accountAvailableMs = parseFutureTimestampMs(
			account?.available_at,
			nowMs,
		);
		if (accountAvailableMs != null) {
			candidates.push({
				delayMs: accountAvailableMs,
				source: "account.available_at",
			});
		}
	}

	if (candidates.length === 0) return noRetry("no_finite_future_recovery");
	candidates.sort((left, right) => left.delayMs - right.delayMs);
	const earliest = candidates[0];
	return {
		retry: true,
		reason: "pool_exhausted",
		delayMs: earliest.delayMs,
		recoverySource: earliest.source,
	};
}
