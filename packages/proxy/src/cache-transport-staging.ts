import { cacheBodyStore, hasCacheControlHint } from "./cache-body-store";

export const CACHE_REPLAY_MODEL_HEADER = "x-better-ccflare-cache-replay-model";

export type CacheBodyStagingAction = "stage" | "discard" | "skip";

export interface CacheBodyStagingInput {
	requestId: string;
	accountId: string | null;
	providerName: string;
	body: ArrayBuffer | null;
	headers: Headers;
	path: string;
	/** Exact post-transform body used only to decide whether this attempt wrote cache. */
	cacheIdentityBody?: ArrayBuffer | null;
	/** Precomputed exact-body marker probe, avoiding another full-body copy. */
	cacheIdentityHasCacheControl?: boolean;
	/** Physical model resolved for the upstream cache-writing transport. */
	resolvedModel?: string | null;
}

export interface CacheTransportStagingInput {
	requestId: string;
	accountId: string | null;
	providerName: string;
	/**
	 * Replay-safe request body after combo/admission/retry model selection and
	 * before provider conversion. Re-entering the proxy transforms this once.
	 */
	replayBody: ArrayBuffer | null;
	/** Exact sanitized concrete request that is about to be sent upstream. */
	transportRequest: Request;
	/** Original client headers; the store strips credentials and proxy metadata. */
	clientHeaders: Headers;
	path: string;
	/** Precomputed from the final transport body when it is already materialized. */
	cacheIdentityHasCacheControl?: boolean;
	/** Provider performed upstream work during transform and returned its response. */
	isSyntheticProviderTransport?: boolean;
	/** Physical model resolved for the upstream cache-writing transport. */
	resolvedModel?: string | null;
}

export function hasCacheControlHintInJsonText(body: string): boolean {
	return body.includes('"cache_control"') || body.includes('"cache-control"');
}

function removeCacheControl(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) removeCacheControl(item);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key === "cache_control" || key === "cache-control") {
			delete record[key];
		} else {
			removeCacheControl(record[key]);
		}
	}
}

/**
 * Removes rejected cache markers while preserving the normalized source shape
 * that must pass through exactly one provider transform on keepalive replay.
 */
export function stripCacheControlFromReplayBody(
	body: ArrayBuffer | null,
): ArrayBuffer | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body));
		removeCacheControl(parsed);
		return new TextEncoder().encode(JSON.stringify(parsed)).buffer;
	} catch {
		return null;
	}
}

function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-better-ccflare-keepalive") ||
		!!headers.get("x-better-ccflare-auto-refresh")
	);
}

/**
 * Chooses how one provider attempt should affect cache-keepalive staging.
 * Synthetic non-Codex requests retain the historical truthy-header skip
 * semantics. Every Codex attempt discards any entry staged by an earlier
 * provider because a Codex Responses body cannot be replayed through Messages.
 */
export function getCacheBodyStagingAction(
	headers: Headers,
	providerName: string,
): CacheBodyStagingAction {
	if (providerName === "codex") return "discard";
	if (isSyntheticInternalRequest(headers)) return "skip";
	return "stage";
}

/** Official xAI Chat caches by exact prefix without Anthropic cache_control markers. */
export function providerUsesAutomaticPrefixCache(
	providerName: string,
): boolean {
	return providerName === "xai";
}

/** Applies the cache-body staging policy to an already materialized projection. */
export function applyCacheBodyStagingPolicy(
	input: CacheBodyStagingInput,
): CacheBodyStagingAction {
	const action = getCacheBodyStagingAction(input.headers, input.providerName);

	if (action === "stage") {
		cacheBodyStore.stageRequest(
			input.requestId,
			input.accountId,
			input.body,
			input.headers,
			input.path,
			input.cacheIdentityBody,
			input.cacheIdentityHasCacheControl,
			input.resolvedModel,
			{
				automaticPrefixCache: providerUsesAutomaticPrefixCache(
					input.providerName,
				),
			},
		);
	} else if (action === "discard") {
		cacheBodyStore.discardStaged(input.requestId);
	}

	return action;
}

/**
 * Stages one physical upstream attempt at the last safe point before fetch.
 *
 * The exact post-transform body controls marker eligibility, while the stored
 * body remains the normalized pre-transform source. This preserves provider-
 * injected cache markers without double-transforming Bedrock/OpenAI request
 * shapes when the keepalive later re-enters the proxy. Only sanitized client
 * headers are retained; provider credentials never enter the store.
 */
export async function stageCacheBodyForTransportAttempt(
	input: CacheTransportStagingInput,
): Promise<CacheBodyStagingAction> {
	const action = getCacheBodyStagingAction(
		input.clientHeaders,
		input.providerName,
	);
	if (action === "discard") {
		cacheBodyStore.discardStaged(input.requestId);
		return action;
	}
	if (action === "skip" || !cacheBodyStore.isEnabled()) return action;

	const cacheIdentityHasCacheControl =
		input.cacheIdentityHasCacheControl ??
		(input.isSyntheticProviderTransport
			? Boolean(input.replayBody && hasCacheControlHint(input.replayBody))
			: undefined);
	const cacheIdentityBody =
		cacheIdentityHasCacheControl === undefined
			? await input.transportRequest.clone().arrayBuffer()
			: null;
	cacheBodyStore.stageRequest(
		input.requestId,
		input.accountId,
		input.replayBody,
		input.clientHeaders,
		input.path,
		cacheIdentityBody,
		cacheIdentityHasCacheControl,
		input.resolvedModel,
		{
			automaticPrefixCache: providerUsesAutomaticPrefixCache(
				input.providerName,
			),
		},
	);
	return action;
}
