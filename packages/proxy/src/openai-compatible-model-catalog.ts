import { resolveCompatibleEndpoint } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	clearDerivedAccountModelDefaults,
	setDerivedAccountModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";

const log = new Logger("OpenAICompatibleModelCatalog");

/**
 * Models one `openai-compatible` account can actually call, read straight from
 * that account's own endpoint via the standard OpenAI `GET /v1/models` shape.
 *
 * Unlike Codex, every account here points at an operator-chosen, arbitrary
 * endpoint — there is no single upstream all accounts share — so, unlike
 * `codex-model-catalog.ts`, listings are never borrowed between accounts.
 * Each account's cache answers only for itself.
 */
export interface OpenAICompatibleModelEntry {
	id: string;
	displayName: string;
}

export interface OpenAICompatibleModelListing {
	accountId: string;
	models: OpenAICompatibleModelEntry[];
	fetchedAt: number;
	source: "live" | "cached";
}

const FETCH_TIMEOUT_MS = 15_000;

/** Hard limits for untrusted OpenAI-compatible model listings. */
export const OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const OPENAI_COMPATIBLE_MODEL_MAX_UNIQUE_IDS = 10_000;
export const OPENAI_COMPATIBLE_MODEL_MAX_ID_BYTES = 1_024;

export interface OpenAICompatibleModelPreviewListing {
	models: OpenAICompatibleModelEntry[];
	fetchedAt: number;
	source: "preview";
}

export type OpenAICompatibleModelDiscoveryErrorKind =
	| "upstream"
	| "malformed"
	| "empty"
	| "size-limit"
	| "count-limit"
	| "id-limit"
	| "timeout";

/** A credential-free, caller-safe discovery failure. */
export class OpenAICompatibleModelDiscoveryError extends Error {
	constructor(
		public readonly kind: OpenAICompatibleModelDiscoveryErrorKind,
		message: string,
	) {
		super(message);
		this.name = "OpenAICompatibleModelDiscoveryError";
	}
}

/**
 * One active account's cache and request ordering. The object identity is the
 * invalidation fence: clearing removes it from the map, so old requests cannot
 * affect a later account with the same id without retaining tombstones.
 */
interface AccountCatalogState {
	lastGood: OpenAICompatibleModelListing | null;
	latestFetchGeneration: number;
}

const stateByAccount = new Map<string, AccountCatalogState>();

function stateFor(accountId: string): AccountCatalogState {
	let state = stateByAccount.get(accountId);
	if (!state) {
		state = { lastGood: null, latestFetchGeneration: 0 };
		stateByAccount.set(accountId, state);
	}
	return state;
}

/** Test seam: process-wide registry leaks between cases. */
export function clearOpenAICompatibleModelCacheForTests(): void {
	stateByAccount.clear();
}

/** Test seam: verifies clears do not retain account-id tombstones. */
export function getOpenAICompatibleModelCatalogStateCountForTests(): number {
	return stateByAccount.size;
}

/** Drops a removed or endpoint-changed account's catalog projection. */
export function clearOpenAICompatibleModelCacheForAccount(
	accountId: string,
): void {
	const state = stateByAccount.get(accountId);
	if (state) {
		state.lastGood = null;
		stateByAccount.delete(accountId);
	}
	clearDerivedAccountModelDefaults("openai-compatible", accountId);
}

function readCache(
	state: AccountCatalogState,
): OpenAICompatibleModelListing | null {
	return state.lastGood ? { ...state.lastGood, source: "cached" } : null;
}

interface OpenAIModelsResponse {
	data: unknown[];
}

function normalize(body: OpenAIModelsResponse): OpenAICompatibleModelEntry[] {
	const seen = new Set<string>();
	const entries: OpenAICompatibleModelEntry[] = [];
	const encoder = new TextEncoder();
	for (const raw of body.data) {
		if (!raw || typeof raw !== "object") continue;
		const rawId = (raw as { id?: unknown }).id;
		const id = typeof rawId === "string" ? rawId.trim() : "";
		if (!id || seen.has(id)) continue;
		if (encoder.encode(id).byteLength > OPENAI_COMPATIBLE_MODEL_MAX_ID_BYTES) {
			throw new OpenAICompatibleModelDiscoveryError(
				"id-limit",
				"OpenAI-compatible model discovery contained a model ID over 1,024 UTF-8 bytes",
			);
		}
		seen.add(id);
		if (seen.size > OPENAI_COMPATIBLE_MODEL_MAX_UNIQUE_IDS) {
			throw new OpenAICompatibleModelDiscoveryError(
				"count-limit",
				"OpenAI-compatible model discovery returned more than 10,000 unique model IDs",
			);
		}
		entries.push({ id, displayName: id });
	}
	return entries;
}

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The body may already be locked or closed. Aborting the fetch is the
		// remaining disposal signal in that case.
	}
}

async function readBoundedResponseBody(
	response: Response,
	controller: AbortController,
): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES
	) {
		controller.abort();
		await cancelBody(response);
		throw new OpenAICompatibleModelDiscoveryError(
			"size-limit",
			"OpenAI-compatible model discovery response exceeded 8 MiB",
		);
	}

	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > OPENAI_COMPATIBLE_MODEL_MAX_RESPONSE_BYTES) {
				controller.abort();
				await reader.cancel();
				throw new OpenAICompatibleModelDiscoveryError(
					"size-limit",
					"OpenAI-compatible model discovery response exceeded 8 MiB",
				);
			}
			chunks.push(value);
		}
	} catch (error) {
		try {
			await reader.cancel();
		} catch {
			// Best-effort disposal after stream errors.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function fetchModelsFromEndpoint(
	apiKey: string,
	endpoint: string,
): Promise<OpenAICompatibleModelEntry[]> {
	const url = `${endpoint}${endpoint.endsWith("/v1") ? "" : "/v1"}/models`;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			await cancelBody(response);
			throw new OpenAICompatibleModelDiscoveryError(
				"upstream",
				`OpenAI-compatible model discovery failed with HTTP ${response.status}`,
			);
		}

		const bytes = await readBoundedResponseBody(response, controller);
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new OpenAICompatibleModelDiscoveryError(
				"malformed",
				"OpenAI-compatible model discovery returned malformed data",
			);
		}
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!Array.isArray((parsed as { data?: unknown }).data)
		) {
			throw new OpenAICompatibleModelDiscoveryError(
				"malformed",
				"OpenAI-compatible model discovery returned malformed data",
			);
		}

		const models = normalize(parsed as OpenAIModelsResponse);
		if (models.length === 0) {
			throw new OpenAICompatibleModelDiscoveryError(
				"empty",
				"OpenAI-compatible model discovery returned no usable models",
			);
		}
		return models;
	} catch (error) {
		if (timedOut) {
			throw new OpenAICompatibleModelDiscoveryError(
				"timeout",
				"OpenAI-compatible model discovery timed out",
			);
		}
		if (error instanceof OpenAICompatibleModelDiscoveryError) throw error;
		throw new OpenAICompatibleModelDiscoveryError(
			"upstream",
			"OpenAI-compatible model discovery failed",
		);
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchLive(
	account: Account,
): Promise<OpenAICompatibleModelEntry[]> {
	if (!account.api_key) {
		throw new Error("no API key for this account");
	}
	const resolvedEndpoint = resolveCompatibleEndpoint(account);
	if (!resolvedEndpoint.ok) {
		throw new Error("no valid endpoint for this account");
	}
	return fetchModelsFromEndpoint(account.api_key, resolvedEndpoint.endpoint);
}

/**
 * Read models using an unsaved credential tuple. This has deliberately no
 * account-cache, persistence, or derived-routing-default side effects.
 */
export async function fetchOpenAICompatibleModelsPreview(
	apiKey: string,
	endpoint: string,
): Promise<OpenAICompatibleModelPreviewListing> {
	const models = await fetchModelsFromEndpoint(apiKey, endpoint);
	return { models, fetchedAt: Date.now(), source: "preview" };
}

/**
 * The family -> model map an account's own listing implies.
 *
 * There is no cross-provider priority signal on this endpoint (unlike Codex's
 * `priority` field), so position is whatever order the account's own server
 * returned — the best available signal without a table of ours to keep
 * current. A shorter list degrades to the last available model rather than
 * leaving a family unmapped.
 */
export function deriveFamilyDefaults(
	models: OpenAICompatibleModelEntry[],
): Record<string, string> {
	if (models.length === 0) return {};
	const at = (index: number): string =>
		models[Math.min(index, models.length - 1)].id;
	return {
		fable: at(0),
		opus: at(0),
		sonnet: at(1),
		haiku: at(2),
	};
}

/**
 * The model list for one openai-compatible account: live when the account's
 * endpoint answers, otherwise the last list it gave us. Returns null only
 * when both are unavailable — a brand new account whose first fetch failed.
 */
export async function getOpenAICompatibleModels(
	accountId: string,
	ctx: ProxyContext,
): Promise<OpenAICompatibleModelListing | null> {
	const state = stateFor(accountId);
	const fetchGeneration = ++state.latestFetchGeneration;
	const account = await ctx.dbOps.getAccount(accountId);

	// An account clear/update can occur while the database lookup is pending.
	// Object identity fences this request from a newer account with the same id.
	if (stateByAccount.get(accountId) !== state) return null;
	if (!account || account.provider !== "openai-compatible") {
		// Do not leave unbounded state behind for nonexistent or incompatible ids.
		// The identity check prevents a concurrent old lookup from deleting a
		// replacement state, and a usable cache remains available for its owner.
		if (state.lastGood === null && stateByAccount.get(accountId) === state) {
			stateByAccount.delete(accountId);
		}
		return null;
	}

	try {
		const models = await fetchLive(account);
		if (models.length === 0) {
			throw new Error("the listing came back with no usable models");
		}
		const listing: OpenAICompatibleModelListing = {
			accountId,
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		// A clear or replacement invalidates this caller as well as publication.
		// A superseded fetch on the same state may still answer its own caller, but
		// must not replace the newer listing/default evidence.
		if (stateByAccount.get(accountId) !== state) return null;
		if (fetchGeneration === state.latestFetchGeneration) {
			state.lastGood = listing;
			// This endpoint is arbitrary and operator-chosen, so its listing is exact
			// account evidence only — never a provider-wide fallback.
			setDerivedAccountModelDefaults(
				"openai-compatible",
				accountId,
				deriveFamilyDefaults(models),
			);
		}
		return listing;
	} catch (error) {
		const cached =
			stateByAccount.get(accountId) === state ? readCache(state) : null;
		if (cached) {
			setDerivedAccountModelDefaults(
				"openai-compatible",
				accountId,
				deriveFamilyDefaults(cached.models),
			);
		}
		log.warn(
			`Live model list failed for ${account.name} (${error}); ` +
				(cached
					? `serving the list from ${new Date(cached.fetchedAt).toISOString()}`
					: "and there is no cached list to fall back to"),
		);
		return cached;
	}
}
