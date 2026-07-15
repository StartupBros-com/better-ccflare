import { createHash } from "node:crypto";
import type {
	XaiCacheCanaryFields,
	XaiCacheOutcome,
} from "@better-ccflare/core";
import {
	cacheOutcomeFromTokens,
	formatXaiCacheCanary,
	isOfficialXaiEndpoint,
} from "@better-ccflare/core";

/** Opt-in: set to "1" to enable the Grok Chat cache-native vertical slice. */
export const XAI_CACHE_NATIVE_ENV = "CCFLARE_XAI_CACHE_NATIVE";

/** Independent opt-in for privacy-safe cache flight recorder evidence. */
export const CACHE_FLIGHT_RECORDER_ENV = "CCFLARE_CACHE_FLIGHT_RECORDER";

/** Official Chat Completions affinity header (xAI docs). */
export const XAI_CONV_ID_HEADER = "x-grok-conv-id";

const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isXaiCacheNativeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[XAI_CACHE_NATIVE_ENV] === "1";
}

export function isCacheFlightRecorderEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[CACHE_FLIGHT_RECORDER_ENV] === "1";
}

export type { XaiCacheCanaryFields, XaiCacheOutcome };
export { cacheOutcomeFromTokens, formatXaiCacheCanary, isOfficialXaiEndpoint };

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

interface ConversationPartitionMaterial {
	sessionId: string;
	instructions: string;
	firstMessage: string;
}

function conversationPartitionMaterial(
	body: Record<string, unknown>,
): ConversationPartitionMaterial | undefined {
	const sessionId = extractClaudeSessionId(body);
	if (!sessionId) return undefined;
	const firstMessage = firstMessageSeed(body.messages);
	if (firstMessage === undefined) return undefined;
	return {
		sessionId,
		instructions: systemSeed(body.system),
		firstMessage,
	};
}

function hashConversationPartition(
	domain: string,
	material: ConversationPartitionMaterial,
): string {
	return createHash("sha256")
		.update(domain)
		.update("\0")
		.update(material.sessionId)
		.update("\0")
		.update(material.instructions)
		.update("\0")
		.update(material.firstMessage)
		.digest("hex");
}

/** Stable lookup ID that never exposes the native affinity key or raw partition input. */
export function deriveCacheFlightRecorderId(
	body: Record<string, unknown>,
): string | undefined {
	const material = conversationPartitionMaterial(body);
	if (!material) return undefined;
	return `cfr_${hashConversationPartition("better-ccflare/cache-flight-recorder/v1", material).slice(0, 32)}`;
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
	const material = conversationPartitionMaterial(body);
	if (!material) return undefined;
	const { sessionId, instructions, firstMessage } = material;

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
