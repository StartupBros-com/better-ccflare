import { api } from "../api";

/**
 * Adapter for ONE endpoint: the per-provider-and-family default model map
 * currently embedded in code (codex, xai, qwen, ...) and used as the LAST
 * word when neither the combo slot nor account mapping supplies a model. One
 * of these hardcoded maps caused the incident
 * `400 The 'gpt-5.3-codex' model is not supported when using Codex with a
 * ChatGPT account` — the account subscription cannot use that model, and
 * until now rebuilding was the only possible fix.
 *
 * Everything the dashboard knows about these response shapes lives here: if
 * the backend changes the contract, this is the only file to update.
 *
 *   GET  /api/config/provider-model-defaults
 *     -> per provider and family: factory value, override (if any), and
 *        effective value. Expected shape (tolerant of shape variation):
 *        { providers: [ { provider, fields: [
 *            { family, factory, override, effective },
 *        ] } ] }
 *     -> additive, Codex-only, both omitted unless dbOps was wired on the
 *        server (never triggers a catalog fetch):
 *        { accounts: [ { accountId, accountName, paused, catalog, families: [
 *            { family, effectiveModel, source, pinned, globalOverridePinsUnmappedAccount? },
 *        ] } ], codexClientIdentity: { version, source, fresh, verifiedAt?, error? } }
 *   POST /api/config/provider-model-defaults   body { overrides: [{ provider, family, model }] }
 *     -> saves overrides; model === "" removes the override for that
 *        provider and family (returns to the factory value).
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

export interface ProviderModelDefaultField {
	family: string;
	/** Value embedded in code — what applies with no override. */
	factory: string;
	/** Override saved today; null when there is no customization. */
	override: string | null;
	/** What the proxy actually uses now (override if present, otherwise factory). */
	effective: string;
}

export interface ProviderModelDefaults {
	provider: string;
	fields: ProviderModelDefaultField[];
}

export interface ProviderModelDefaultOverrideInput {
	provider: string;
	family: string;
	/** An empty string removes the override (returns to the factory value). */
	model: string;
}

/**
 * Where a Codex account's effective per-family model came from. The first
 * five are pins (something explicit set it); the last three are automatic
 * (nobody pinned this family, so a catalog or the compiled default fills it).
 * Kept as `string` rather than a closed union so an unrecognized value from a
 * newer backend degrades to its raw label instead of a type error.
 */
export type CodexAccountFamilySource =
	| "account_mapping_pin"
	| "custom_endpoint_mapping"
	| "model_fallbacks"
	| "environment_mapping"
	| "global_provider_override"
	| "account_catalog"
	| "provider_catalog_borrowed"
	| "compiled_default"
	| (string & {});

export interface CodexAccountFamilyDefault {
	family: string;
	effectiveModel: string;
	source: CodexAccountFamilySource;
	pinned: boolean;
	/** Set only when a global provider override pins an otherwise-unmapped account. */
	globalOverridePinsUnmappedAccount?: boolean;
}

export interface CodexAccountCatalogStatus {
	source: "own" | "borrowed" | "none" | (string & {});
	fetchedAt: number | null;
	stale: boolean;
	borrowedFrom?: string;
}

export interface CodexAccountEffectiveDefaults {
	accountId: string;
	accountName: string;
	paused: boolean;
	catalog: CodexAccountCatalogStatus;
	families: CodexAccountFamilyDefault[];
}

export interface CodexClientIdentityDiagnostics {
	version: string;
	source: string;
	fresh: boolean;
	verifiedAt?: string;
	error?: string;
}

export interface ProviderModelDefaultsResponse {
	providers: ProviderModelDefaults[];
	/** Absent unless the server had DB access wired for this endpoint. */
	accounts?: CodexAccountEffectiveDefaults[];
	/** Absent unless Codex is an enabled provider-model-defaults provider. */
	codexClientIdentity?: CodexClientIdentityDiagnostics;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(raw: unknown): string {
	return typeof raw === "string" ? raw.trim() : "";
}

function normalizeField(raw: unknown): ProviderModelDefaultField | null {
	const entry = asRecord(raw);
	const family = asString(entry.family);
	if (!family) return null;
	const factory = asString(entry.factory);
	const overrideRaw = entry.override;
	const override =
		typeof overrideRaw === "string" && overrideRaw.trim()
			? overrideRaw.trim()
			: null;
	// effective tolerates being absent: falls back to override, then factory.
	const effective = asString(entry.effective) || override || factory;
	return { family, factory, override, effective };
}

function normalizeProvider(raw: unknown): ProviderModelDefaults | null {
	const entry = asRecord(raw);
	const provider = asString(entry.provider);
	if (!provider) return null;
	const list: unknown[] = Array.isArray(entry.fields) ? entry.fields : [];
	const fields: ProviderModelDefaultField[] = [];
	for (const item of list) {
		const field = normalizeField(item);
		if (field) fields.push(field);
	}
	return { provider, fields };
}

function normalizeCatalogStatus(raw: unknown): CodexAccountCatalogStatus {
	const entry = asRecord(raw);
	const source = asString(entry.source) || "none";
	const fetchedAt =
		typeof entry.fetchedAt === "number" ? entry.fetchedAt : null;
	const borrowedFrom = asString(entry.borrowedFrom);
	return {
		source,
		fetchedAt,
		stale: entry.stale === true,
		...(borrowedFrom ? { borrowedFrom } : {}),
	};
}

function normalizeFamilyDefault(
	raw: unknown,
): CodexAccountFamilyDefault | null {
	const entry = asRecord(raw);
	const family = asString(entry.family);
	if (!family) return null;
	return {
		family,
		effectiveModel: asString(entry.effectiveModel),
		source: asString(entry.source) || "compiled_default",
		pinned: entry.pinned === true,
		...(entry.globalOverridePinsUnmappedAccount === true
			? { globalOverridePinsUnmappedAccount: true }
			: {}),
	};
}

function normalizeAccountEffectiveDefaults(
	raw: unknown,
): CodexAccountEffectiveDefaults | null {
	const entry = asRecord(raw);
	const accountId = asString(entry.accountId);
	if (!accountId) return null;
	const familiesRaw: unknown[] = Array.isArray(entry.families)
		? entry.families
		: [];
	const families: CodexAccountFamilyDefault[] = [];
	for (const item of familiesRaw) {
		const family = normalizeFamilyDefault(item);
		if (family) families.push(family);
	}
	return {
		accountId,
		accountName: asString(entry.accountName) || accountId,
		paused: entry.paused === true,
		catalog: normalizeCatalogStatus(entry.catalog),
		families,
	};
}

function normalizeCodexClientIdentity(
	raw: unknown,
): CodexClientIdentityDiagnostics | undefined {
	if (raw === undefined) return undefined;
	const entry = asRecord(raw);
	const version = asString(entry.version);
	if (!version) return undefined;
	const verifiedAt = asString(entry.verifiedAt);
	const error = asString(entry.error);
	return {
		version,
		source: asString(entry.source) || "default",
		fresh: entry.fresh === true,
		...(verifiedAt ? { verifiedAt } : {}),
		...(error ? { error } : {}),
	};
}

/**
 * Single fetcher for the whole endpoint response: providers (all consumers),
 * plus the additive Codex-only `accounts`/`codexClientIdentity` fields (only
 * present when the server wired dbOps and Codex is enabled). Malformed or
 * absent additive fields normalize to `undefined`/empty rather than throwing,
 * so an older server or a provider list without Codex still renders the
 * provider-level screen.
 */
export async function fetchProviderModelDefaultsResponse(): Promise<ProviderModelDefaultsResponse> {
	const body = asRecord(
		await api.get<unknown>("/api/config/provider-model-defaults"),
	);
	const providerList: unknown[] = Array.isArray(body.providers)
		? body.providers
		: [];
	const providers: ProviderModelDefaults[] = [];
	for (const item of providerList) {
		const provider = normalizeProvider(item);
		if (provider) providers.push(provider);
	}

	const response: ProviderModelDefaultsResponse = { providers };

	if (Array.isArray(body.accounts)) {
		const accounts: CodexAccountEffectiveDefaults[] = [];
		for (const item of body.accounts) {
			const account = normalizeAccountEffectiveDefaults(item);
			if (account) accounts.push(account);
		}
		response.accounts = accounts;
	}

	const identity = normalizeCodexClientIdentity(body.codexClientIdentity);
	if (identity) response.codexClientIdentity = identity;

	return response;
}

/** Default model map for all providers. Malformed input becomes an empty list. */
export async function fetchProviderModelDefaults(): Promise<
	ProviderModelDefaults[]
> {
	return (await fetchProviderModelDefaultsResponse()).providers;
}

/**
 * Saves overrides in one operation, triggered by explicit action (the Save
 * button): this card does not save on every keystroke. A field with
 * model === "" removes that provider-and-family override (returns to factory).
 */
export async function saveProviderModelDefaultOverrides(
	overrides: ProviderModelDefaultOverrideInput[],
): Promise<void> {
	await api.post("/api/config/provider-model-defaults", { overrides });
}
