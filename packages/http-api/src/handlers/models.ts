import {
	listCatalogueModels,
	validateApiKey,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { ValidationError } from "@better-ccflare/errors";
import {
	BadGateway,
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import {
	fetchOpenAICompatibleModelsPreview,
	OpenAICompatibleModelDiscoveryError,
} from "@better-ccflare/proxy";
import type { APIContext } from "../types";

/**
 * Where a listed model id came from — the whole point of the endpoint.
 *
 *  - "builtin"   ccflare itself knows this model for that provider (it is in
 *                the provider adapter's own table). Strongest signal there is.
 *  - "catalog"   the provider's own live listing (Anthropic /v1/models),
 *                fetched with a real account's credentials.
 *  - "reference" the public models.dev catalogue. Says the model EXISTS at
 *                the vendor and says NOTHING about whether a given account's
 *                plan may call it: ChatGPT-subscription accounts reject
 *                gpt-5.3-codex with HTTP 400 while OpenAI lists it happily.
 *                Never collapse this into the other two.
 */
export type ModelListingSource =
	| "builtin"
	| "catalog"
	| "reference"
	/**
	 * The provider's own listing for THIS account. The only source that can
	 * tell an entitled model from one the plan does not reach — which is the
	 * distinction that matters when the choice ends up in a request.
	 */
	| "account";

export interface ProviderModelEntry {
	id: string;
	displayName: string;
	source: ModelListingSource;
}

/**
 * ccflare provider name -> models.dev top-level section. Only names that
 * differ need an entry; anything else falls through to the provider name
 * itself, which models.dev uses verbatim for "anthropic", "zai", "minimax",
 * and friends.
 */
const MODELS_DEV_SECTION_BY_PROVIDER: Record<string, string> = {
	// Intentionally empty for providers that answer with a listing of their
	// own. Add an entry only for a provider whose models ccflare cannot ask
	// for — the catalogue is the fallback of last resort, not a second opinion.
};

/**
 * Model ids ccflare ships knowledge of, per provider.
 *
 * Empty for codex on purpose: the account's own listing supersedes anything
 * compiled in, and the compiled list contained `gpt-5.3-codex`, which a
 * ChatGPT-subscription account refuses. A built-in list is a guess about
 * entitlement, and a guess is exactly what fails silently.
 */
const BUILTIN_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {};

/**
 * Providers served by the live Anthropic catalog. Both auth modes (OAuth and
 * console API key) talk to the same /v1/models listing, so both get it.
 */
function isAnthropicProvider(provider: string): boolean {
	return provider === "anthropic" || provider === "claude-console-api";
}

/**
 * GET /api/models[?provider=<name>] — list the models available for one
 * provider, each entry tagged with where the knowledge came from.
 *
 * Without a provider/account scope the body is exactly what this endpoint has
 * always returned — the cached live catalog, or the bundled static fallback —
 * so existing callers keep working. Explicit provider/account queries use the
 * stricter entitlement-aware response below.
 *
 * For every other provider the answer is the union of what ccflare knows
 * built in and what the public models.dev catalogue lists, deduplicated by
 * id with the stronger marking winning, builtin entries first. A failed or
 * unavailable catalogue fetch degrades to the builtin list plus a warning —
 * it never fails the request.
 */
export function createModelsHandler(context: APIContext) {
	return async (url?: URL): Promise<Response> => {
		const requested = url?.searchParams.get("provider")?.trim() || "";
		const accountId = url?.searchParams.get("accountId")?.trim() || "";
		const hasScopedQuery = requested.length > 0 || accountId.length > 0;

		if (!hasScopedQuery) {
			if (!context.modelCatalog) {
				return errorResponse("Model catalog is not available");
			}
			return jsonResponse(await context.modelCatalog.get());
		}

		// Account listings are entitlement evidence, so select their discovery
		// path by the requested provider. In particular, an arbitrary
		// openai-compatible endpoint must never answer a Codex (or other) query.
		if (accountId && requested === "codex") {
			const listing = await context.modelCatalog?.codexModels?.(accountId);
			if (listing) {
				return jsonResponse({
					provider: "codex",
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
						description: model.description,
						contextWindow: model.contextWindow,
						maxContextWindow: model.maxContextWindow,
						effectiveContextPercent: model.effectiveContextPercent,
						supersededBy: model.supersededBy,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
					...(listing.source === "shared"
						? {
								warning:
									"This account cannot read its own model list, so this is " +
									"another account of the same provider. Accounts on " +
									"different plans can differ.",
							}
						: {}),
				});
			}
		}

		if (accountId && requested === "openai-compatible") {
			const listing =
				await context.modelCatalog?.openaiCompatibleModels?.(accountId);
			if (listing) {
				return jsonResponse({
					provider: "openai-compatible",
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
				});
			}
		}

		if (accountId) {
			return jsonResponse({
				provider: requested,
				models: [],
				fetchedAt: Date.now(),
				source: "unavailable",
				warning:
					"No account-specific listing is available for this provider/account combination.",
			});
		}

		if (requested === "" || isAnthropicProvider(requested)) {
			if (!context.modelCatalog) {
				return errorResponse("Model catalog is not available");
			}
			const catalog = await context.modelCatalog.get();
			// `fallback` means an on-disk copy or the list bundled into the binary
			// answered — not the provider. After a restart that would make the
			// field look answered when nothing has been read.
			const live = catalog.source === "live";
			return jsonResponse({
				provider: requested || "anthropic",
				models: live
					? catalog.models.map((model) => ({
							...model,
							source: "catalog" as const,
						}))
					: [],
				fetchedAt: catalog.fetchedAt,
				source: live ? "live" : "unavailable",
				...(live
					? {}
					: {
							warning:
								"No listing read from the provider yet. The field takes any model id meanwhile.",
						}),
			});
		}

		const builtinIds = BUILTIN_MODELS_BY_PROVIDER[requested] ?? [];
		const section = MODELS_DEV_SECTION_BY_PROVIDER[requested] ?? requested;
		const reference = await listCatalogueModels(section);

		const builtinById = new Map<string, ProviderModelEntry>();
		for (const id of builtinIds) {
			builtinById.set(id, { id, displayName: id, source: "builtin" });
		}

		// A reference entry never overwrites a builtin one — the stronger
		// marking wins, and the UI shows the two groups apart on purpose.
		const referenceById = new Map<string, ProviderModelEntry>();
		for (const entry of reference) {
			if (!entry.id) continue;
			if (builtinById.has(entry.id) || referenceById.has(entry.id)) continue;
			referenceById.set(entry.id, {
				id: entry.id,
				displayName: entry.name || entry.id,
				source: "reference",
			});
		}

		const referenceEntries = Array.from(referenceById.values()).sort((a, b) =>
			a.id.localeCompare(b.id),
		);
		const models = [...builtinById.values(), ...referenceEntries];

		const hasBuiltin = builtinById.size > 0;
		const hasReference = referenceEntries.length > 0;
		const source = hasBuiltin
			? hasReference
				? "mixed"
				: "builtin"
			: hasReference
				? "reference"
				: "unavailable";

		return jsonResponse({
			provider: requested,
			models,
			fetchedAt: Date.now(),
			source,
			referenceSection: section,
			...(hasReference
				? {}
				: {
						warning: `No reference models for "${section}" in the models.dev catalogue (unknown provider, catalogue offline, or fetch failed)`,
					}),
		});
	};
}

/**
 * POST /api/models/refresh — force an immediate live model catalog refresh.
 * Never throws: refreshModelCatalog is fail-open, so this always returns
 * 200 with the outcome (success flag + optional error) plus the resulting
 * catalog.
 */
export function createModelsRefreshHandler(context: APIContext) {
	return async (): Promise<Response> => {
		if (!context.modelCatalog) {
			return errorResponse("Model catalog is not available");
		}
		const result = await context.modelCatalog.refresh();
		const catalog = await context.modelCatalog.get();
		return jsonResponse({ ...result, catalog });
	};
}

/**
 * POST /api/models/preview — list the models one unsaved OpenAI-compatible
 * credential/endpoint tuple can call, without ever persisting an account.
 *
 * The caller supplies `apiKey`/`endpoint` directly in the body rather than an
 * account id: this exists precisely for the moment before an account is
 * saved, in the add-account wizard. It shares no cache, state, or derived
 * routing-default plumbing with the saved-account discovery path above —
 * see fetchOpenAICompatibleModelsPreview in @better-ccflare/proxy. A
 * successful call is not capability evidence: it grants no routing
 * eligibility and creates nothing.
 *
 * Route registration relies on the router's normal auth/authz gate running
 * before this handler is ever invoked (management-role semantics identical
 * to every other /api/* route: admin or no-key bootstrap may call it,
 * api-only and unauthenticated callers are rejected before any outbound
 * fetch happens).
 */
export function createModelsPreviewHandler() {
	return async (req: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return errorResponse(BadRequest("Request body must be valid JSON"));
		}

		let apiKey: string;
		let endpoint: string;
		try {
			const candidate = (body ?? {}) as {
				apiKey?: unknown;
				endpoint?: unknown;
			};
			apiKey = validateApiKey(candidate.apiKey, "apiKey");
			endpoint = validateEndpointUrl(candidate.endpoint, "endpoint");
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			return errorResponse(BadRequest("Invalid preview request"));
		}

		try {
			const listing = await fetchOpenAICompatibleModelsPreview(
				apiKey,
				endpoint,
			);
			return jsonResponse({
				provider: "openai-compatible",
				source: "preview",
				models: listing.models.map((model) => ({
					id: model.id,
					displayName: model.displayName,
					source: "preview" as const,
				})),
				fetchedAt: listing.fetchedAt,
			});
		} catch (error) {
			// fetchOpenAICompatibleModelsPreview already redacts credentials and
			// upstream bodies from its thrown message — never forward anything
			// else (e.g. a raw non-Error throw) that might not be redacted.
			const message =
				error instanceof OpenAICompatibleModelDiscoveryError
					? error.message
					: "Model preview failed";
			return errorResponse(BadGateway(message));
		}
	};
}
