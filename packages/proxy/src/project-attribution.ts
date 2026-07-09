import { Logger } from "@better-ccflare/logger";
import type { ProjectAttributionSource } from "@better-ccflare/types";
import type { RequestJsonBody } from "./request-body-context";

const log = new Logger("ProjectAttribution");

export interface ProjectExtractionResult {
	project: string | null;
	projectAttributionSource: ProjectAttributionSource;
}

// Project names are persisted to a single TEXT column and surfaced in the UI.
// Cap length and strip control chars so a hostile system prompt can't smuggle
// newlines, ANSI escapes, or megabyte-long blobs into the database.
export const PROJECT_NAME_MAX_LEN = 64;

export function sanitizeProjectName(
	raw: string | undefined | null,
): string | null {
	if (!raw) return null;
	// Strip ASCII control chars (incl. newlines/tabs) — keep Unicode letters,
	// dashes, dots, and spaces that real project directories use.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > PROJECT_NAME_MAX_LEN
		? cleaned.slice(0, PROJECT_NAME_MAX_LEN)
		: cleaned;
}

export function extractSystemPromptFromJson(
	body: RequestJsonBody | null,
): string | null {
	if (!body) return null;
	const system = body.system;

	if (typeof system === "string") {
		return system;
	}

	if (Array.isArray(system)) {
		return system
			.filter(
				(item): item is { type?: string; text: string } =>
					typeof item === "object" &&
					item !== null &&
					(item as { type?: string }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}

	return null;
}

export function extractSystemPromptFromBase64(
	requestBody: string | null,
): string | null {
	if (!requestBody) return null;

	try {
		// Decode base64 request body, then reuse the SAME extraction as the
		// parsed-body path so the legacy/direct fallback never diverges (R7) —
		// e.g. `system: [null, {type:"text", text:"..."}]` is tolerated here
		// exactly as extractSystemPromptFromJson tolerates it, not thrown on.
		const decodedBody = Buffer.from(requestBody, "base64").toString("utf-8");
		const parsed = JSON.parse(decodedBody) as RequestJsonBody;
		return extractSystemPromptFromJson(parsed);
	} catch (error) {
		// Malformed/undecodable body — treat as no system prompt, but keep it
		// diagnosable on the legacy usage-collector recompute path.
		log.debug("Failed to extract system prompt from request body:", error);
	}

	return null;
}

// Matches bearer/API-key-ish tokens such as sk-..., pk_..., rk-..., ak_...
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9]{8,}/i;
// AWS access-key-id shape.
const AWS_KEY_RE = /AKIA[0-9A-Z]{12,}/;
// An unbroken run of 20+ alphanumeric chars — the shape of a raw secret, hash,
// or high-entropy token. Excludes separators (-, _, /) on purpose so ordinary
// hyphenated slugs like "attribution-source-tags" are NOT rejected, while still
// catching bare tokens the old 32-char base64-class pattern missed (16-31 char
// hex/base32 secrets, session ids, etc.).
const LONG_TOKEN_RE = /[A-Za-z0-9]{20,}/;
// Bare IPv4 address — an internal host, never a real project name.
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
// UUID / raw trace-id shape (explicitly prohibited as attribution metadata).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A leading URI scheme or Windows drive letter (file:, http:, mailto:, C:, ...).
// Matches "scheme:" anchored at the start; ordinary slugs have no leading scheme.
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// Allowed low-risk project-slug shape: starts with a word char or dot, then
// word chars, dots, spaces, or dashes, capped at 64 chars. Slashes and colons
// are intentionally excluded — they enable path, URI, host:port, and drive-letter
// shapes that must never be surfaced as a project label.
const SLUG_SHAPE_RE = /^[\w.][\w .-]{0,63}$/;

/**
 * Conservative validator for heading-derived project labels (R10a).
 *
 * Validates the FULL cleaned heading (control-stripped, trimmed, but NEVER
 * length-capped) so a secret positioned near the 64-char truncation boundary
 * cannot be shortened below a detector threshold and slip through. Rejects
 * values that look like they could carry a secret, a raw trace/UUID id, a URL
 * or URI scheme, an absolute/drive/traversal path, an email address, or
 * free-form sentence/incident text. Accepts ordinary repo-name-shaped labels
 * (e.g. "better-ccflare", "Harness", "eval-suite", "My Project").
 */
export function isLowRiskProjectSlug(value: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return false;
	const lower = cleaned.toLowerCase();

	// URLs / URI schemes / hosts (case-insensitive — WWW.EXAMPLE.COM must fail too).
	if (
		lower.includes("://") ||
		lower.includes("www.") ||
		URI_SCHEME_RE.test(cleaned)
	) {
		return false;
	}

	// Absolute, Windows-drive, UNC, or traversal paths.
	if (
		cleaned.startsWith("/") ||
		cleaned.startsWith("\\") ||
		cleaned.includes("..")
	) {
		return false;
	}

	// Email address.
	const atIndex = cleaned.indexOf("@");
	if (atIndex !== -1 && cleaned.indexOf(".", atIndex) !== -1) return false;

	// Raw trace / UUID identifiers.
	if (UUID_RE.test(cleaned)) return false;

	// Secrets, keys, IPs, and high-entropy tokens.
	if (
		SECRET_TOKEN_RE.test(cleaned) ||
		lower.includes("bearer ") ||
		AWS_KEY_RE.test(cleaned) ||
		IPV4_RE.test(cleaned) ||
		LONG_TOKEN_RE.test(cleaned)
	) {
		return false;
	}

	// Sentence / incident-shaped free text.
	if (cleaned.split(/\s+/).filter(Boolean).length > 6) return false;

	// Strict slug grammar on the FULL value (no slashes/colons; a >64-char value
	// fails the {0,63} bound and is rejected wholesale rather than truncated).
	return SLUG_SHAPE_RE.test(cleaned);
}

const WORKSPACE_PATH_RE =
	/\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\//;
const HEADING_RE = /^#\s+([^\n\r]{1,100})/m;

/**
 * Core project attribution extraction. Accepts a header accessor so it works
 * uniformly for both the proxy's `Headers` object and the usage collector's
 * `Record<string, string>` header map.
 *
 * Precedence:
 *  1. `x-better-ccflare-project` header, then legacy `x-project` header.
 *  2. Workspace path embedded in the system prompt.
 *  3. First eligible non-Claude, low-risk-slug H1 heading in the system prompt.
 *  4. No project.
 */
export function extractProjectAttribution(
	getHeader: (name: string) => string | null | undefined,
	systemPrompt: string | null,
): ProjectExtractionResult {
	const namespacedHeader = sanitizeProjectName(
		getHeader("x-better-ccflare-project"),
	);
	if (namespacedHeader) {
		return {
			project: namespacedHeader,
			projectAttributionSource: "header_project",
		};
	}

	const legacyHeader = sanitizeProjectName(getHeader("x-project"));
	if (legacyHeader) {
		return {
			project: legacyHeader,
			projectAttributionSource: "header_project",
		};
	}

	if (systemPrompt) {
		const pathMatch = systemPrompt.match(WORKSPACE_PATH_RE);
		const sanitizedPath = sanitizeProjectName(pathMatch?.[1]);
		if (sanitizedPath) {
			return {
				project: sanitizedPath,
				projectAttributionSource: "path_project",
			};
		}

		const headingMatch = systemPrompt.match(HEADING_RE);
		if (headingMatch) {
			// Validate the FULL captured heading, then length-cap only after it
			// passes — truncating first could shorten a boundary-straddling secret
			// below a detector threshold and let a partial secret through.
			const rawHeading = headingMatch[1];
			if (
				!rawHeading.trim().toLowerCase().startsWith("claude") &&
				isLowRiskProjectSlug(rawHeading)
			) {
				const heading = sanitizeProjectName(rawHeading);
				if (heading) {
					return {
						project: heading,
						projectAttributionSource: "heading_project",
					};
				}
			}
		}
	}

	return { project: null, projectAttributionSource: "none" };
}

/**
 * Convenience wrapper for the proxy's parsed-JSON-body request path.
 */
export function extractProjectAttributionFromRequest(
	headers: Headers,
	body: RequestJsonBody | null,
): ProjectExtractionResult {
	const systemPrompt = extractSystemPromptFromJson(body);
	return extractProjectAttribution((n) => headers.get(n), systemPrompt);
}

/**
 * Convenience wrapper for the usage collector's `StartMessage`-shaped input,
 * where headers arrive as a plain `Record<string, string>` and the body is a
 * base64-encoded JSON string.
 */
export function extractProjectAttributionFromParts(
	requestHeaders: Record<string, string> | null | undefined,
	requestBodyBase64: string | null,
): ProjectExtractionResult {
	const headerMap: Record<string, string> = {};
	if (requestHeaders) {
		for (const [key, value] of Object.entries(requestHeaders)) {
			headerMap[key.toLowerCase()] = value;
		}
	}
	const systemPrompt = extractSystemPromptFromBase64(requestBodyBase64);
	return extractProjectAttribution(
		(n) => headerMap[n.toLowerCase()],
		systemPrompt,
	);
}
