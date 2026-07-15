import type { Account } from "@better-ccflare/types";
import { getEndpointUrl } from "./model-mappings";

const XAI_DEFAULT_ENDPOINT = "https://api.x.ai/v1";
const OFFICIAL_XAI_HOSTS = new Set(["api.x.ai"]);

/**
 * Resolve whether an account targets official xAI infrastructure.
 * Invalid custom endpoints fall back to the official default, matching
 * XaiProvider.buildUrl behavior.
 */
export function isOfficialXaiEndpoint(account?: Account | null): boolean {
	if (account && account.provider !== "xai") return false;

	let endpoint = XAI_DEFAULT_ENDPOINT;
	try {
		endpoint = account?.custom_endpoint
			? getEndpointUrl(account)
			: XAI_DEFAULT_ENDPOINT;
	} catch {
		endpoint = XAI_DEFAULT_ENDPOINT;
	}

	try {
		return OFFICIAL_XAI_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
	} catch {
		return false;
	}
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

/** Compact structured canary line for mechanism proof, without prompt content. */
export function formatXaiCacheCanary(fields: XaiCacheCanaryFields): string {
	const parts = [
		`official=${fields.officialEndpoint ? "1" : "0"}`,
		`key=${fields.keyPresent ? "1" : "0"}`,
		`outcome=${fields.cacheOutcome}`,
	];
	if (fields.requestId) parts.push(`req=${fields.requestId}`);
	if (fields.accountId) parts.push(`account=${fields.accountId}`);
	if (fields.accountName) parts.push(`account_name=${fields.accountName}`);
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
	if (!detailsPresent || typeof cachedTokens !== "number") return "unknown";
	return cachedTokens > 0 ? "hit" : "miss";
}
