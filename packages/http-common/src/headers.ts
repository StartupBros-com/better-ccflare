import {
	RECOVERY_SCOPE_HEADER,
	RECOVERY_STATUS_HEADER,
} from "@better-ccflare/types/routing-recovery";

/** Private hop-by-hop request correlation installed by ccflare-guard. */
export const GUARD_REQUEST_ID_HEADER =
	"x-better-ccflare-guard-request-id" as const;

/**
 * Reserved defense-in-depth name for the env-only guard credential.
 * Legitimate stack components never transmit the credential over HTTP.
 */
export const GUARD_CORRELATION_SECRET_HEADER =
	"x-better-ccflare-guard-correlation-secret" as const;

/** Private proxy-to-provider carrier for the normalized logical Claude family. */
export const CODEX_LOGICAL_MODEL_FAMILY_HEADER =
	"x-better-ccflare-logical-model-family" as const;

/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body, and reserved,
 * guard-trusted headers that must never originate from an upstream provider.
 *
 * Removes: content-encoding, content-length, transfer-encoding,
 * x-better-ccflare-pool-status, x-better-ccflare-recovery-scope,
 * x-better-ccflare-guard-request-id,
 * x-better-ccflare-logical-model-family, x-codex-turn-state
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	sanitized.delete("transfer-encoding");

	// x-better-ccflare-pool-status is a reserved header the ccflare-guard
	// trusts, at header time, to authorize retrying a 503 (R17). Only the
	// proxy's own synthesized pool-exhausted responses may set it. An
	// upstream provider response must never be allowed to carry it through
	// to the client: doing so would let a spoofed (or merely misconfigured)
	// upstream force the guard into replaying a possibly non-idempotent
	// request, or falsely deny an actual pool-exhaustion retry.
	sanitized.delete(RECOVERY_STATUS_HEADER);
	// Scope is part of the same atomic trust contract. Never preserve it without
	// the proxy's own synthesized marker and stable routing error code.
	sanitized.delete(RECOVERY_SCOPE_HEADER);

	// Defense in depth: the proxy does not intentionally put the guard's private
	// request header on responses, and an upstream must not be able to introduce
	// a same-named value that the client or guard could mistake for internal state.
	sanitized.delete(GUARD_REQUEST_ID_HEADER);
	sanitized.delete(GUARD_CORRELATION_SECRET_HEADER);
	sanitized.delete(CODEX_LOGICAL_MODEL_FAMILY_HEADER);

	// Codex's per-turn sticky-routing token is provider-private process state and
	// must never reach a client. The Codex provider strips it from every response
	// it transforms, but terminal 400/404 and retained responses are returned raw
	// through this helper, so the guard belongs here as well.
	// keep in sync with CODEX_TURN_STATE_HEADER in @better-ccflare/providers
	// (http-common is the lower layer; importing the providers constant here
	// would invert the package dependency)
	sanitized.delete("x-codex-turn-state");

	return sanitized;
}

/**
 * Removes hop-by-hop + compression negotiation headers and sensitive auth
 * headers from the ORIGINAL client request before it is persisted for
 * analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length,
 * authorization, x-api-key, cookie, x-better-ccflare-guard-request-id,
 * x-better-ccflare-logical-model-family
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	// Strip sensitive auth headers from persisted payloads
	h.delete("authorization");
	h.delete("x-api-key");
	h.delete("cookie");
	// This hop-local join key is useful in live structured logs only. Persisting it
	// with request payload metadata would unnecessarily widen its trust boundary.
	h.delete(GUARD_REQUEST_ID_HEADER);
	h.delete(GUARD_CORRELATION_SECRET_HEADER);
	h.delete(CODEX_LOGICAL_MODEL_FAMILY_HEADER);
	// keep in sync with INTERNAL_PROBE_SECRET_HEADER
	// (@better-ccflare/proxy already depends on http-common, so importing the
	// proxy package's constant here would create an import cycle)
	h.delete("x-better-ccflare-internal-probe-secret");
	return h;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});
}
