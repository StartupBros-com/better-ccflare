import { createHash } from "node:crypto";
import { getEndpointUrl } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

/** Opt-in: set to "1" to enable the Grok Chat cache-native vertical slice. */
export const XAI_CACHE_NATIVE_ENV = "CCFLARE_XAI_CACHE_NATIVE";

/** Official Chat Completions affinity header (xAI docs). */
export const XAI_CONV_ID_HEADER = "x-grok-conv-id";

/** Keep aligned with XaiProvider default endpoint host. */
const XAI_DEFAULT_ENDPOINT = "https://api.x.ai/v1";

const OFFICIAL_XAI_HOSTS = new Set(["api.x.ai"]);

const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isXaiCacheNativeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[XAI_CACHE_NATIVE_ENV] === "1";
}

/**
 * Resolve whether an account targets official xAI Chat Completions.
 * Invalid custom endpoints fall back to the default official host, matching
 * XaiProvider.buildUrl behaviour.
 */
export function isOfficialXaiEndpoint(account?: Account | null): boolean {
	let endpoint = XAI_DEFAULT_ENDPOINT;
	try {
		endpoint = account?.custom_endpoint
			? getEndpointUrl(account)
			: XAI_DEFAULT_ENDPOINT;
	} catch {
		endpoint = XAI_DEFAULT_ENDPOINT;
	}
	try {
		const host = new URL(endpoint).hostname.toLowerCase();
		return OFFICIAL_XAI_HOSTS.has(host);
	} catch {
		return false;
	}
}

export function extractClaudeSessionId(
	body: Record<string, unknown>,
): string | undefined {
	const meta = body.metadata;
	if (!meta || typeof meta !== "object") return undefined;
	const rawUserId = (meta as Record<string, unknown>).user_id;
	if (typeof rawUserId !== "string") return undefined;
	try {
		const parsed = JSON.parse(rawUserId) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const sessionId = (parsed as Record<string, unknown>).session_id;
		if (typeof sessionId !== "string" || !SESSION_UUID_RE.test(sessionId)) {
			return undefined;
		}
		return sessionId.toLowerCase();
	} catch {
		return undefined;
	}
}

function systemSeed(system: unknown): string {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	return system
		.filter(
			(block): block is { type: string; text?: string } =>
				!!block && typeof block === "object",
		)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n\n");
}

function firstMessageSeed(messages: unknown): string | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	try {
		const serialized = JSON.stringify(messages[0]);
		return serialized === undefined ? undefined : serialized;
	} catch {
		return undefined;
	}
}

export interface XaiConversationIdentity {
	/** Full privacy-safe header value (no raw session UUID). */
	headerValue: string;
	/** Truncated fingerprint for logs/telemetry. */
	identityFingerprint: string;
	/** Truncated prefix fingerprint for logs/telemetry. */
	prefixFingerprint: string;
	/** Sticky ownership key (same as header value). */
	affinityKey: string;
}

/**
 * Derive a conversation-partitioned Grok identity from Claude request body.
 * Returns undefined when metadata is missing/malformed or the seed is empty.
 */
export function deriveXaiConversationIdentity(
	body: Record<string, unknown>,
): XaiConversationIdentity | undefined {
	const sessionId = extractClaudeSessionId(body);
	if (!sessionId) return undefined;

	const instructions = systemSeed(body.system);
	const firstMessage = firstMessageSeed(body.messages);
	if (firstMessage === undefined) return undefined;

	const digest = createHash("sha256")
		.update(sessionId)
		.update("\0")
		.update(instructions)
		.update("\0")
		.update(firstMessage)
		.digest("hex");

	const headerValue = `ccflare-xai-${digest.slice(0, 48)}`;
	const prefixFingerprint = createHash("sha256")
		.update(instructions)
		.update("\0")
		.update(firstMessage)
		.digest("hex")
		.slice(0, 16);

	return {
		headerValue,
		identityFingerprint: digest.slice(0, 16),
		prefixFingerprint,
		affinityKey: headerValue,
	};
}

export type XaiCacheOutcome = "hit" | "miss" | "unknown" | "fail_closed";

export interface XaiCacheCanaryFields {
	requestId?: string;
	accountId?: string;
	accountName?: string;
	officialEndpoint: boolean;
	keyPresent: boolean;
	identityFingerprint?: string;
	prefixFingerprint?: string;
	cacheOutcome: XaiCacheOutcome;
	cachedTokens?: number;
	inputTokens?: number;
	failClosedReason?: string;
}

/** Compact structured canary line for mechanism proof (no prompt content). */
export function formatXaiCacheCanary(fields: XaiCacheCanaryFields): string {
	const parts = [
		`official=${fields.officialEndpoint ? "1" : "0"}`,
		`key=${fields.keyPresent ? "1" : "0"}`,
		`outcome=${fields.cacheOutcome}`,
	];
	if (fields.requestId) parts.push(`req=${fields.requestId}`);
	if (fields.accountId) parts.push(`account=${fields.accountId}`);
	if (fields.identityFingerprint)
		parts.push(`id=${fields.identityFingerprint}`);
	if (fields.prefixFingerprint)
		parts.push(`prefix=${fields.prefixFingerprint}`);
	if (fields.cachedTokens !== undefined)
		parts.push(`cached=${fields.cachedTokens}`);
	if (fields.inputTokens !== undefined)
		parts.push(`input=${fields.inputTokens}`);
	if (fields.failClosedReason) parts.push(`reason=${fields.failClosedReason}`);
	return parts.join(" ");
}

export function cacheOutcomeFromTokens(
	cachedTokens: number | undefined | null,
	detailsPresent: boolean,
): XaiCacheOutcome {
	if (!detailsPresent) return "unknown";
	if (typeof cachedTokens !== "number") return "unknown";
	return cachedTokens > 0 ? "hit" : "miss";
}
