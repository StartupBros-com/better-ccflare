/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body, and reserved,
 * guard-trusted headers that must never originate from an upstream provider.
 *
 * Removes: content-encoding, content-length, transfer-encoding,
 * x-better-ccflare-pool-status
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
	sanitized.delete("x-better-ccflare-pool-status");

	return sanitized;
}

/**
 * Removes hop-by-hop + compression negotiation headers and sensitive auth
 * headers from the ORIGINAL client request before it is persisted for
 * analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length,
 * authorization, x-api-key, cookie
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
