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

function bodyConfirmsPoolExhausted(body) {
	return !!body && typeof body === "object" && body.error?.type === "pool_exhausted";
}

/**
 * Collect finite future recovery-delay candidates from whatever signals are
 * present, independent of whether the body's error type matches. Retry-After
 * is an authoritative minimum: body metadata may extend that wait, never
 * shorten it. Among body signals, the earliest available account remains the
 * useful pool-recovery candidate because only one compatible account needs to
 * recover. The absence of any valid hint is not itself a reason to refuse the
 * retry.
 */
function collectDelayCandidates(headers, body, nowMs) {
	const candidates = [];
	const retryAfterMs = parseRetryAfterMs(
		headerValue(headers, "retry-after"),
		nowMs,
	);
	if (retryAfterMs != null) {
		candidates.push({ delayMs: retryAfterMs, source: "retry-after" });
	}

	if (!body || typeof body !== "object") return candidates;
	const errorBody =
		body.error && typeof body.error === "object" ? body.error : null;

	const nextAvailableMs = parseFutureTimestampMs(
		errorBody?.next_available_at,
		nowMs,
	);
	if (nextAvailableMs != null) {
		candidates.push({
			delayMs: nextAvailableMs,
			source: "error.next_available_at",
		});
	}

	const accounts = [
		...(Array.isArray(errorBody?.accounts) ? errorBody.accounts : []),
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

	return candidates;
}

/**
 * Classifies the proxy's stable x-better-ccflare-pool-status header for a
 * response, independent of any body I/O (R17/P1). This is deliberately the
 * ONLY signal evaluated at header time: an oversized, stalled, or malformed
 * body must never cost a header-confirmed retry its authorization, and must
 * never silently grant one either. Callers should settle retry authority
 * from this result alone before touching the response body; the body may
 * only be consulted afterwards, as a bounded, best-effort delay hint.
 *
 * Returns:
 * - "confirmed": a 503 whose header explicitly says the whole pool is
 *   exhausted. Sufficient on its own to authorize a retry.
 * - "denied": a 503 whose header is present but says something else (e.g.
 *   "available"). Never retryable, regardless of body.
 * - "absent": a 503 with no pool-status header at all, e.g. from an older,
 *   not-yet-redeployed proxy. Retry authority falls to the caller's
 *   rolling-upgrade policy (see allowLegacyBody on evaluateGuardRetry).
 * - "not_applicable": any non-503 status. Never retryable.
 */
export function poolHeaderStatus({ status, headers }) {
	if (status !== 503) return "not_applicable";
	const poolStatus = headerValue(
		headers,
		"x-better-ccflare-pool-status",
	)?.trim();
	if (poolStatus === "exhausted") return "confirmed";
	if (poolStatus == null || poolStatus === "") return "absent";
	return "denied";
}

/**
 * The guard consumes the proxy's stable x-better-ccflare-pool-status:
 * exhausted header as the primary, sufficient whole-pool-exhaustion signal
 * (R17), evaluated at header time via poolHeaderStatus, before any body I/O.
 * Bounded structured-body detection (already capped by the caller's 64 KiB
 * inspection limit) is only a TEMPORARY rolling-upgrade escape hatch for
 * when that header is absent, e.g. against an older proxy that has not yet
 * been redeployed. It is OFF by default (allowLegacyBody = false): any
 * upstream 503 body can be shaped like a pool_exhausted error, and trusting
 * it without the header would let a spoofed or coincidentally-shaped body
 * authorize replays of a possibly non-idempotent request. Operators who
 * need the fallback during a rolling upgrade must opt in explicitly (e.g.
 * via GUARD_ALLOW_LEGACY_POOL_BODY=1) and should disable it again once all
 * proxies are current.
 *
 * Once a response is classified retryable, an unparseable, absent, or
 * non-finite recovery body degrades the wait, not the decision: delay
 * resolution falls back to Retry-After, or to no delay at all, so the
 * guard's own bounded attempts/deadline own worst-case exposure. All other
 * responses are forwarded exactly once so model-scoped and provider-specific
 * errors remain visible to the caller and the router can own fallback
 * policy.
 */
export function evaluateGuardRetry({
	status,
	headers,
	bodyText,
	nowMs = Date.now(),
	allowLegacyBody = false,
}) {
	if (status !== 503) return noRetry("status_not_retryable");

	const poolStatus = headerValue(
		headers,
		"x-better-ccflare-pool-status",
	)?.trim();
	const headerConfirmed = poolStatus === "exhausted";
	const headerAbsent = poolStatus == null || poolStatus === "";

	const body = parseJson(bodyText);

	if (!headerConfirmed) {
		if (!headerAbsent) return noRetry("pool_not_exhausted");
		if (!allowLegacyBody) return noRetry("header_absent_legacy_body_disabled");
		if (!bodyConfirmsPoolExhausted(body)) {
			return noRetry(body == null ? "malformed_body" : "not_pool_exhausted_terminal");
		}
	}

	const candidates = collectDelayCandidates(headers, body, nowMs);
	if (candidates.length === 0) {
		return { retry: true, reason: "pool_exhausted", delayMs: 0, recoverySource: null };
	}
	const retryAfter = candidates.find(
		(candidate) => candidate.source === "retry-after",
	);
	const bodyCandidates = candidates
		.filter((candidate) => candidate.source !== "retry-after")
		.sort((left, right) => left.delayMs - right.delayMs);
	const earliestBody = bodyCandidates[0];
	const recovery =
		retryAfter == null
			? earliestBody
			: earliestBody == null || retryAfter.delayMs >= earliestBody.delayMs
				? retryAfter
				: earliestBody;
	return {
		retry: true,
		reason: "pool_exhausted",
		delayMs: recovery.delayMs,
		recoverySource: recovery.source,
	};
}
