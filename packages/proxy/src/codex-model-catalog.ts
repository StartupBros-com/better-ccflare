import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	clearCodexAccountModelContextMetadata,
	clearDerivedAccountModelDefaults,
	hasDerivedProviderModelDefaults,
	resolveCodexClientIdentity,
	setCodexAccountModelContextMetadata,
	setDerivedAccountModelDefaults,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";

const log = new Logger("CodexModelCatalog");

/**
 * Models a Codex account can actually call, straight from OpenAI.
 *
 * `api.openai.com/v1/models` is the documented listing, and it is the WRONG
 * question here: it answers for API-key organisations and returns HTTP 403
 * (`Missing scopes: api.model.read`) for a ChatGPT-subscription token. The
 * endpoint below is what the Codex CLI itself calls, and it answers per
 * subscription — measured against a real account, `gpt-5.3-codex` is absent
 * from it, which is exactly the model whose refusal started this whole line of
 * work.
 *
 * It is not part of OpenAI's public REST reference, so it is treated as
 * best-effort: every success is written to disk, and a later failure serves the
 * last known-good list rather than a generic catalogue that would happily list
 * models this plan cannot call.
 */
export interface CodexModelEntry {
	id: string;
	displayName: string;
	description: string | null;
	/**
	 * Catalog `context_window`: the DEFAULT/recommended window, not capacity.
	 * Kept under its historical name for API compatibility; capacity lives in
	 * {@link maxContextWindow}. Conflating the two is how issue #205's local
	 * prompt-too-long failures happened.
	 */
	contextWindow: number | null;
	/** Catalog `max_context_window`: capacity a client may opt into. */
	maxContextWindow: number | null;
	/** Catalog `effective_context_window_percent` (usable share of capacity). */
	effectiveContextPercent: number | null;
	/** Validated scalar effort levels; never a claim about tools or orchestration. */
	supportedReasoningEfforts?: string[];
	defaultReasoningEffort?: string | null;
	/**
	 * Model OpenAI says will replace this one, when it has announced a
	 * deprecation. Worth surfacing: picking a model that is on its way out is
	 * a decision someone will have to undo.
	 */
	supersededBy: string | null;
}

export interface CodexModelListing {
	accountId: string;
	models: CodexModelEntry[];
	fetchedAt: number;
	/**
	 * "live" straight from OpenAI, "cached" this account's own earlier read,
	 * "shared" another account of the same provider — see the note on
	 * providerWide below.
	 */
	source: "live" | "cached" | "shared";
	/** Account the list actually came from, when it was not this one. */
	borrowedFrom?: string;
}

const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_REFRESH_INTERVAL_MS = 15 * 60_000;
const ENSURE_RETRY_DELAYS_MS = [
	60_000, 120_000, 240_000, 480_000, 900_000,
] as const;
const MAX_ENSURE_RETRY_ENTRIES = 1_000;

interface EnsureRetryState {
	failureCount: number;
	nextAttemptAt: number;
}

/**
 * Last good listing and its publication generation per account, for this
 * process only.
 *
 * Deliberately not written to disk: a snapshot that outlives the process is a
 * second place where the truth can quietly go stale. A failed refresh keeps
 * serving what is already here; a restart starts empty and stays empty until
 * a read succeeds, which is honest about what is actually known.
 */
interface CachedAccountCatalog {
	listing: CodexModelListing;
	generation: number;
}

const lastGood = new Map<string, CachedAccountCatalog>();

/**
 * Per-account deletion generation. A request captures this before any await;
 * clearing increments it so a pre-delete completion may answer its own caller
 * but cannot repopulate state for a same-ID replacement.
 */
const invalidationGenerationByAccount = new Map<string, number>();

function invalidationGenerationFor(accountId: string): number {
	return invalidationGenerationByAccount.get(accountId) ?? 0;
}

function isCurrentInvalidationGeneration(
	accountId: string,
	generation: number,
): boolean {
	return invalidationGenerationFor(accountId) === generation;
}

/**
 * The last listing any account of this provider managed to read.
 *
 * Two of three measured accounts answer HTTP 401 on the models endpoint while
 * serving traffic perfectly — for them, their own list will never exist. Login
 * accounts of one provider generally see the same models, so one account's
 * read is a far better answer than nothing.
 *
 * "Generally" is doing work in that sentence: the provider's payload carries
 * `available_in_plans`, so different plans can differ. A borrowed list is
 * therefore labelled as borrowed rather than passed off as this account's own.
 */
let providerWide: CodexModelListing | null = null;

/** Retry only unresolved accounts; exact live or cached-own evidence stops it. */
const ensureRetryByAccount = new Map<string, EnsureRetryState>();

/** One best-effort listing request per account at a time. */
const ensureInFlight = new Map<string, Promise<void>>();
const unknownRevalidationAt = new Map<string, number>();
const UNKNOWN_REVALIDATION_COOLDOWN_MS = 60_000;

/**
 * Successful live reads publish in start order, not completion order.
 *
 * Direct catalog reads and the best-effort ensure path can overlap for the
 * same account, and independent account reads can overlap with one another. A
 * slower older response is still a valid answer for its own caller and exact
 * account state, but it must not roll the provider-wide cache and defaults
 * back after a newer response has already landed.
 *
 * The counter deliberately survives the test reset. That keeps attempts that
 * were already running before a reset distinct from attempts started after it.
 */
let nextCatalogFetchGeneration = 0;
let publishedProviderCatalogGeneration = 0;

/**
 * Test seam: forget every process-wide catalog registry between cases.
 * Already-running fetches are not cancelled and may still record their result.
 */
export function clearCodexModelCacheForTests(): void {
	lastGood.clear();
	clearCodexAccountModelContextMetadata();
	invalidationGenerationByAccount.clear();
	providerWide = null;
	ensureRetryByAccount.clear();
	ensureInFlight.clear();
	unknownRevalidationAt.clear();
	publishedProviderCatalogGeneration = 0;
}

/**
 * Retire every account-local catalog projection after deletion.
 *
 * Provider-wide evidence is intentionally advisory and may have come from a
 * different account, so it survives. The generation fence prevents a request
 * which started before this clear from restoring any exact or provider-wide
 * evidence after a same-ID account replacement.
 */
export function clearCodexModelCacheForAccount(accountId: string): void {
	invalidationGenerationByAccount.set(
		accountId,
		invalidationGenerationFor(accountId) + 1,
	);
	lastGood.delete(accountId);
	ensureRetryByAccount.delete(accountId);
	ensureInFlight.delete(accountId);
	unknownRevalidationAt.delete(accountId);
	clearDerivedAccountModelDefaults("codex", accountId);
	clearCodexAccountModelContextMetadata(accountId);
}

function scheduleEnsureRetry(accountId: string, now: number): void {
	const previous = ensureRetryByAccount.get(accountId);
	const failureCount = Math.min(
		(previous?.failureCount ?? 0) + 1,
		ENSURE_RETRY_DELAYS_MS.length,
	);

	if (!previous && ensureRetryByAccount.size >= MAX_ENSURE_RETRY_ENTRIES) {
		const oldestAccountId = ensureRetryByAccount.keys().next().value;
		if (oldestAccountId !== undefined) {
			ensureRetryByAccount.delete(oldestAccountId);
		}
	}

	ensureRetryByAccount.set(accountId, {
		failureCount,
		nextAttemptAt: now + ENSURE_RETRY_DELAYS_MS[failureCount - 1],
	});
}

/**
 * Return only first-hand evidence for an account. Shared provider listings are
 * useful advisory defaults but must never exclude a model for another account.
 */
export function getKnownCodexModels(
	accountId: string,
): CodexModelListing | null {
	const own = lastGood.get(accountId)?.listing;
	return own ? { ...own, source: "cached" } : null;
}

function readCache(accountId: string): CodexModelListing | null {
	const own = getKnownCodexModels(accountId);
	if (own) return own;
	// Nothing of this account's own: fall back to whatever another account of
	// the same provider read, labelled so nobody mistakes it for this one's.
	if (providerWide) {
		return {
			...providerWide,
			accountId,
			source: "shared",
			borrowedFrom: providerWide.accountId,
		};
	}
	return null;
}

interface CodexModelsResponse {
	models?: Array<{
		slug?: string;
		display_name?: string;
		description?: string;
		context_window?: number;
		max_context_window?: number;
		effective_context_window_percent?: number;
		supported_reasoning_levels?: Array<{ effort?: string }>;
		default_reasoning_level?: string;
		/** "list" to be offered; "hide" for routing aliases and internal models. */
		visibility?: string;
		/** OpenAI's own ordering, frontier first. */
		priority?: number;
		upgrade?: { model?: string } | null;
	}>;
}

function normalize(body: CodexModelsResponse): CodexModelEntry[] {
	const seen = new Set<string>();
	const entries: Array<CodexModelEntry & { priority: number }> = [];
	for (const raw of body.models ?? []) {
		const id = typeof raw.slug === "string" ? raw.slug.trim() : "";
		if (!id || seen.has(id)) continue;

		// OpenAI marks what is meant to be offered. Two of the eight entries a
		// live account returns are `hide`: a Work Mode routing alias and the
		// automatic review model — neither is something to pick in a mapping.
		// Reading the flag rather than matching on the name means the next alias
		// OpenAI ships is excluded without anyone learning its suffix.
		if (raw.visibility && raw.visibility !== "list") continue;

		seen.add(id);
		entries.push({
			id,
			priority: typeof raw.priority === "number" ? raw.priority : 1_000,
			supersededBy:
				typeof raw.upgrade?.model === "string" ? raw.upgrade.model : null,
			displayName:
				typeof raw.display_name === "string" && raw.display_name.trim()
					? raw.display_name
					: id,
			description:
				typeof raw.description === "string" && raw.description.trim()
					? raw.description
					: null,
			contextWindow:
				typeof raw.context_window === "number" ? raw.context_window : null,
			maxContextWindow:
				typeof raw.max_context_window === "number"
					? raw.max_context_window
					: null,
			effectiveContextPercent:
				typeof raw.effective_context_window_percent === "number"
					? raw.effective_context_window_percent
					: null,
			supportedReasoningEfforts: Array.isArray(raw.supported_reasoning_levels)
				? raw.supported_reasoning_levels.map((level) => level?.effort ?? "")
				: undefined,
			defaultReasoningEffort:
				typeof raw.default_reasoning_level === "string"
					? raw.default_reasoning_level
					: null,
		});
	}

	// OpenAI's own ordering puts the frontier models first; alphabetical would
	// open the list with `codex-auto-review` and `gpt-5.4-mini`.
	return entries
		.sort((a, b) => a.priority - b.priority)
		.map(({ priority: _priority, ...entry }) => entry);
}

/**
 * One live call for one account. The token comes from the normal refresh path,
 * because a stored access token is routinely stale — measured: two of three
 * accounts answered 401 with the token as stored, and 200 once refreshed.
 */
async function fetchLive(
	account: Account,
	ctx: ProxyContext,
): Promise<CodexModelEntry[]> {
	const identity = resolveCodexClientIdentity();
	const accessToken = await getValidAccessToken(account, ctx);
	if (!accessToken) throw new Error("no access token for this account");

	const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(identity.version)}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/json",
				// The endpoint rejects the request without a client version, and
				// identifies the caller by originator — mirroring the CLI keeps us
				// on the path OpenAI actually serves.
				originator: "codex_cli_rs",
				"user-agent": identity.catalogUserAgent,
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return normalize((await response.json()) as CodexModelsResponse);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Make sure this account has a derived default map before anything tries to
 * map a Claude family onto one of the provider's models.
 *
 * A no-op for every other provider, and for a Codex account with an exact live
 * or cached-own map. A shared listing is intentionally not exact, so its
 * account remains eligible for a bounded later retry.
 */
export function ensureCodexModelDefaults(
	account: Account | null | undefined,
	ctx: ProxyContext,
	now: () => number = Date.now,
	forceRevalidation = false,
): Promise<void> {
	if (account?.provider !== "codex") return Promise.resolve();
	const invalidationGeneration = invalidationGenerationFor(account.id);
	const ownListing = lastGood.get(account.id)?.listing;
	if (
		ownListing &&
		!forceRevalidation &&
		now() < ownListing.fetchedAt + CATALOG_REFRESH_INTERVAL_MS
	)
		return Promise.resolve();
	if (!ownListing && hasDerivedProviderModelDefaults("codex", account.id)) {
		return Promise.resolve();
	}

	const current = ensureInFlight.get(account.id);
	// First-hand evidence makes refresh advisory: never hold a warm request on
	// a stalled credential refresh or catalog fetch. Cold accounts still wait.
	if (current) return ownListing ? Promise.resolve() : current;

	const retry = ensureRetryByAccount.get(account.id);
	if (retry && now() < retry.nextAttemptAt) return Promise.resolve();

	let attempt: Promise<void>;
	attempt = (async () => {
		try {
			const listing = await getCodexModels(account.id, ctx);
			if (
				listing?.source === "live" &&
				hasDerivedProviderModelDefaults("codex", account.id)
			) {
				ensureRetryByAccount.delete(account.id);
				return;
			}
			if (isCurrentInvalidationGeneration(account.id, invalidationGeneration)) {
				scheduleEnsureRetry(account.id, now());
			}
		} catch (err) {
			// Never blocks the request: without a map the family falls through and
			// the provider gets to say what it thinks, which the record then learns.
			if (isCurrentInvalidationGeneration(account.id, invalidationGeneration)) {
				scheduleEnsureRetry(account.id, now());
			}
			log.debug(`Could not load the model list for ${account.name}: ${err}`);
		}
	})().finally(() => {
		// The test reset can forget a still-running attempt without cancelling it,
		// then let a new one start. Only the promise currently registered may clear
		// itself; the older completion may still record its best-effort outcome.
		if (ensureInFlight.get(account.id) === attempt) {
			ensureInFlight.delete(account.id);
		}
	});
	ensureInFlight.set(account.id, attempt);
	return ownListing ? Promise.resolve() : attempt;
}

/** One account-scoped revalidation per cooldown, shared with regular refresh. */
export function revalidateUnknownCodexModel(
	account: Account,
	model: string,
	ctx: ProxyContext,
	now: () => number = Date.now,
): Promise<void> {
	if (
		account.provider !== "codex" ||
		!lastGood.has(account.id) ||
		lastGood.get(account.id)?.listing.models.some((entry) => entry.id === model)
	) {
		return Promise.resolve();
	}
	const previous = unknownRevalidationAt.get(account.id);
	if (
		previous !== undefined &&
		now() < previous + UNKNOWN_REVALIDATION_COOLDOWN_MS
	) {
		return ensureInFlight.get(account.id) ?? Promise.resolve();
	}
	if (
		unknownRevalidationAt.size >= MAX_ENSURE_RETRY_ENTRIES &&
		!unknownRevalidationAt.has(account.id)
	) {
		const oldest = unknownRevalidationAt.keys().next().value;
		if (oldest !== undefined) unknownRevalidationAt.delete(oldest);
	}
	unknownRevalidationAt.set(account.id, now());
	const wait = ensureCodexModelDefaults(account, ctx, now, true);
	return ensureInFlight.get(account.id) ?? wait;
}

/**
 * The family -> model map an account's own listing implies.
 *
 * The listing arrives ordered by the provider's `priority`, so position IS
 * the tier and there is no table of ours to keep current: whatever OpenAI
 * promotes to the top becomes the frontier default by itself.
 *
 * `opus` and `fable` take the frontier model, `sonnet` the next one and
 * `haiku` the one after — matching what each Anthropic family is for. A
 * shorter list degrades to the last available model rather than leaving a
 * family unmapped, because an unmapped family falls through to the Claude
 * name and the provider answers 400.
 */
export function deriveFamilyDefaults(
	models: CodexModelEntry[],
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
 * The weakest model of a listing, or null when there is no listing to read.
 *
 * `normalize` sorts by the provider's own priority, so the tail is the lowest
 * tier the plan can call. Usage probes prefer it because their response body is
 * discarded and quota headers describe the subscription rather than the model.
 */
export function lowestTierCodexModel(
	listing: CodexModelListing | null | undefined,
): string | null {
	const models = listing?.models ?? [];
	return models.length > 0 ? models[models.length - 1].id : null;
}

/**
 * The model list for one Codex account: live when OpenAI answers, otherwise the
 * last list it gave us. Returns null only when both are unavailable — a brand
 * new account whose first fetch failed.
 */
export async function getCodexModels(
	accountId: string,
	ctx: ProxyContext,
): Promise<CodexModelListing | null> {
	const invalidationGeneration = invalidationGenerationFor(accountId);
	const account = await ctx.dbOps.getAccount(accountId);
	if (!account || account.provider !== "codex") return null;
	const fetchGeneration = ++nextCatalogFetchGeneration;

	try {
		const models = await fetchLive(account, ctx);
		// An answer with nothing usable in it is not an answer. Recording it
		// would mark the account as resolved and stop every later attempt, so a
		// single odd response would freeze the account with no defaults at all.
		if (models.length === 0) {
			throw new Error("the listing came back with no usable models");
		}
		const listing: CodexModelListing = {
			accountId,
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		const families = deriveFamilyDefaults(models);
		const publishedAccountGeneration = lastGood.get(accountId)?.generation;
		if (isCurrentInvalidationGeneration(accountId, invalidationGeneration)) {
			if (
				publishedAccountGeneration === undefined ||
				fetchGeneration > publishedAccountGeneration
			) {
				// This account's exact evidence advances independently of the shared
				// frontier, so a late response from another account still remains useful.
				lastGood.set(accountId, { listing, generation: fetchGeneration });
				setCodexAccountModelContextMetadata(accountId, models);
				setDerivedAccountModelDefaults("codex", accountId, families);
			}
			if (fetchGeneration > publishedProviderCatalogGeneration) {
				providerWide = listing;
				setDerivedProviderModelDefaults("codex", accountId, families);
				publishedProviderCatalogGeneration = fetchGeneration;
			}
		}
		return listing;
	} catch (error) {
		const cached = readCache(accountId);
		// The cached listing is still this account's own answer, just an older
		// one — far better than a map compiled months ago.
		if (
			cached?.source === "cached" &&
			isCurrentInvalidationGeneration(accountId, invalidationGeneration)
		) {
			setCodexAccountModelContextMetadata(accountId, cached.models);
			setDerivedAccountModelDefaults(
				"codex",
				accountId,
				deriveFamilyDefaults(cached.models),
			);
		}
		log.warn(
			`Live Codex model list failed for ${account.name} (${error}); ` +
				(cached
					? `serving the list from ${new Date(cached.fetchedAt).toISOString()}`
					: "and there is no cached list to fall back to"),
		);
		return cached;
	}
}

/** Account-local heartbeat; at most two catalog calls run concurrently. */
export function initCodexModelCatalogRefresh(
	ctx: ProxyContext,
	testOverrides?: { initialDelayMs?: number; tickSeconds?: number },
): () => void {
	let stopped = false;
	let running = false;
	let nextRefreshAt = 0;
	const tick = async (): Promise<void> => {
		if (stopped || running || Date.now() < nextRefreshAt) return;
		running = true;
		// Bound jitter to two minutes around the fifteen-minute cadence.
		nextRefreshAt =
			Date.now() +
			CATALOG_REFRESH_INTERVAL_MS +
			Math.floor(Math.random() * 120_000);
		try {
			const accounts = (await ctx.dbOps.getAllAccounts())
				.filter(
					(account) =>
						account.provider === "codex" &&
						!account.paused &&
						!account.requires_reauth &&
						!account.custom_endpoint,
				)
				.slice(0, 100);
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(2, accounts.length) }, async () => {
					while (!stopped && next < accounts.length) {
						const account = accounts[next++];
						await ensureCodexModelDefaults(account, ctx);
						// Warm callers return immediately; scheduler workers must still wait
						// for the actual fetch before starting another account.
						await ensureInFlight.get(account.id);
					}
				}),
			);
		} catch (error) {
			log.warn(`Could not schedule Codex model refresh: ${error}`);
		} finally {
			running = false;
		}
	};
	const initial = setTimeout(
		() => {
			void tick();
		},
		testOverrides?.initialDelayMs ?? 30_000 + Math.random() * 90_000,
	);
	const unregister = registerHeartbeat({
		id: "codex-model-catalog-refresh",
		callback: tick,
		seconds: testOverrides?.tickSeconds ?? 60,
		description: "Codex account model catalog freshness check",
	});
	return () => {
		stopped = true;
		clearTimeout(initial);
		unregister();
	};
}
