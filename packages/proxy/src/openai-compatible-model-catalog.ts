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
	data?: Array<{ id?: string }>;
}

function normalize(body: OpenAIModelsResponse): OpenAICompatibleModelEntry[] {
	const seen = new Set<string>();
	const entries: OpenAICompatibleModelEntry[] = [];
	for (const raw of body.data ?? []) {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, displayName: id });
	}
	return entries;
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
	const endpoint = resolvedEndpoint.endpoint;
	const url = `${endpoint}${endpoint.endsWith("/v1") ? "" : "/v1"}/models`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${account.api_key}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return normalize((await response.json()) as OpenAIModelsResponse);
	} finally {
		clearTimeout(timeout);
	}
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
