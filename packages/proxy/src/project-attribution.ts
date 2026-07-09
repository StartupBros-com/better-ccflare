import type { ProjectAttributionSource } from "@better-ccflare/types";
import type { RequestJsonBody } from "./request-body-context";

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
		// Decode base64 request body
		const decodedBody = Buffer.from(requestBody, "base64").toString("utf-8");
		const parsed = JSON.parse(decodedBody);

		// Check if there's a system property in the request
		if (parsed.system) {
			// Handle both string and array formats
			if (typeof parsed.system === "string") {
				return parsed.system;
			} else if (Array.isArray(parsed.system)) {
				// Concatenate all text from system messages
				return parsed.system
					.filter(
						(item: { type?: string; text?: string }) =>
							item.type === "text" && item.text,
					)
					.map((item: { type?: string; text?: string }) => item.text)
					.join("\n");
			}
		}
	} catch {
		// Silent fail — malformed/undecodable body, treat as no system prompt.
	}

	return null;
}

// Matches bearer/API-key-ish tokens such as sk-..., pk_..., rk-..., ak_...
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9]{8,}/i;
// AWS access-key-id shape.
const AWS_KEY_RE = /AKIA[0-9A-Z]{12,}/;
// A long run of base64/hex-ish characters (high-entropy token shape).
const LONG_TOKEN_RE = /[A-Za-z0-9+/_-]{32,}/;
// Allowed low-risk project-slug shape: starts with a word char or dot, then
// word chars, dots, spaces, colons, slashes, or dashes, capped at 64 chars.
const SLUG_SHAPE_RE = /^[\w.][\w .:/-]{0,63}$/;

/**
 * Conservative validator for heading-derived project labels (R10a).
 *
 * Rejects values that look like they could carry a secret, a URL, an email
 * address, or free-form sentence/incident text. Accepts ordinary
 * repo-name-shaped labels (e.g. "better-ccflare", "Harness", "eval-suite",
 * "My Project").
 */
export function isLowRiskProjectSlug(value: string): boolean {
	if (value.includes("://") || value.includes("www.")) return false;

	const atIndex = value.indexOf("@");
	if (atIndex !== -1 && value.indexOf(".", atIndex) !== -1) return false;

	if (
		SECRET_TOKEN_RE.test(value) ||
		value.toLowerCase().includes("bearer ") ||
		AWS_KEY_RE.test(value) ||
		LONG_TOKEN_RE.test(value)
	) {
		return false;
	}

	const wordCount = value.split(/\s+/).filter(Boolean).length;
	if (wordCount > 6) return false;

	const sanitized = sanitizeProjectName(value);
	if (!sanitized || !SLUG_SHAPE_RE.test(sanitized)) return false;

	return true;
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
			const heading = sanitizeProjectName(headingMatch[1]);
			if (
				heading &&
				!heading.toLowerCase().startsWith("claude") &&
				isLowRiskProjectSlug(heading)
			) {
				return {
					project: heading,
					projectAttributionSource: "heading_project",
				};
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
