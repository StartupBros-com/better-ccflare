import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Private hop-by-hop credential used only between in-process schedulers and the
 * localhost proxy listener. Public probe/session headers are routing hints, not
 * authorization, and must never grant access to a paused or cooling account.
 */
export const INTERNAL_AUTO_REFRESH_HEADER =
	"x-better-ccflare-internal-auto-refresh-token";

// Generated once per process. A restart invalidates every previously observed
// value, and the value is never exported or written to logs/configuration.
const internalAutoRefreshToken = randomBytes(32).toString("base64url");

/** Stamp a scheduler-owned localhost request with the process credential. */
export function stampInternalAutoRefreshAuth(headers: Headers): void {
	headers.set(INTERNAL_AUTO_REFRESH_HEADER, internalAutoRefreshToken);
}

/**
 * Validate and consume the credential at proxy ingress. Deletion happens before
 * comparison so invalid values cannot reach metadata, logs, cache staging, or
 * an upstream provider either.
 */
export function consumeInternalAutoRefreshAuth(headers: Headers): boolean {
	const candidate = headers.get(INTERNAL_AUTO_REFRESH_HEADER);
	headers.delete(INTERNAL_AUTO_REFRESH_HEADER);
	if (!candidate || candidate.length !== internalAutoRefreshToken.length) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(candidate, "utf8"),
		Buffer.from(internalAutoRefreshToken, "utf8"),
	);
}
