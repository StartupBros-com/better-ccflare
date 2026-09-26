import {
	getModelFamily,
	isForceAccountModelEnabled,
	parseCustomEndpointData,
	parseModelFallbacks,
	parseModelMappings,
	validateModelMappings,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { getProviderModelDefaultOverrides } from "@better-ccflare/providers";
import {
	getCodexCatalogRoleTarget,
	type ModelRouteProfile,
} from "@better-ccflare/proxy";
import type { Account, GuardedModelMappingsWrite } from "@better-ccflare/types";
import { Conflict, NotFound } from "../utils/http-error";
import {
	type CodexAccountCatalogInfo,
	type CodexAccountCatalogView,
	type CodexAccountFamilySource,
	describeCodexAccountCatalog,
	resolveCodexAccountFamilyDefault,
} from "./codex-effective-defaults";

/**
 * Codex "pin → automatic" migration: for each Codex account and family, show
 * the stored pin, what the family would inherit with only that pin removed,
 * and the role target in the account's OWN catalog; then remove exactly the
 * pins an operator selects, atomically and only if nothing changed since the
 * preview.
 *
 * Nothing here decides that a pin is unwanted. A stored value equal to an old
 * or even the current default is still reported as a pin, and only explicit
 * selections are ever applied.
 */

export const CODEX_MIGRATION_FAMILIES = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
] as const;
export type CodexMigrationFamily = (typeof CODEX_MIGRATION_FAMILIES)[number];

export const STALE_CODEX_MIGRATION_PREVIEW = "stale_codex_migration_preview";
export const CODEX_MIGRATION_SELECTION_NOT_APPLICABLE =
	"codex_migration_selection_not_applicable";

/**
 * Why removing a family's account pin would not hand the family to the
 * account's own catalog role. `inherited_target_mismatch` is reported only
 * when none of the named layers explains it, so a non-applicable entry is
 * never left without a reason.
 */
export type CodexMigrationBlocker =
	| "no_account_pin"
	| "force_account_model_mode"
	| "custom_endpoint_mapping"
	| "environment_mapping"
	| "model_fallbacks"
	| "global_provider_override"
	| "no_own_catalog"
	| "inherited_target_mismatch";

/** Apply-time rejection reasons: the preview blockers plus unknown accounts. */
export type CodexMigrationRejection =
	| CodexMigrationBlocker
	| "unknown_account"
	| "not_codex_account";

type StoredPin = string | string[];

export interface CodexMigrationFamilyEntry {
	family: CodexMigrationFamily;
	currentModel: string;
	currentSource: CodexAccountFamilySource;
	/** The stored `model_mappings` value for this family key, as stored. */
	accountPin: StoredPin | null;
	/** What the family resolves to with only this family key removed. */
	inheritedModel: string;
	inheritedSource: CodexAccountFamilySource;
	/** The family's role target in the account's own catalog, never a borrowed one. */
	roleTarget: string | null;
	applicable: boolean;
	blockers: CodexMigrationBlocker[];
}

export interface CodexMigrationAccountEntry {
	accountId: string;
	accountName: string;
	/** The raw stored `model_mappings` string; echo it as each selection's guard. */
	expected_old_value: string | null;
	catalog: CodexAccountCatalogView;
	families: CodexMigrationFamilyEntry[];
}

/** An env-configured route profile that still fixes one of these accounts' physical model. */
export interface CodexMigrationRouteProfileAdvisory {
	profileId: string;
	displayName: string;
	accountId: string;
	logicalModel: string;
	family: CodexMigrationFamily | null;
	expectedPhysicalModel: string;
}

export interface CodexModelMigrationPreview {
	revision: number;
	accounts: CodexMigrationAccountEntry[];
	/** Read-only: route profiles are environment configuration, never applied here. */
	routeProfileAdvisories: CodexMigrationRouteProfileAdvisory[];
}

export interface CodexModelMigrationSelection {
	accountId: string;
	family: CodexMigrationFamily;
	expected_old_value: string | null;
}

export interface CodexModelMigrationApplyInput {
	expected_revision: number;
	selections: CodexModelMigrationSelection[];
}

/**
 * Minimal recovery snapshot for one account. The item can be POSTed unchanged
 * to `POST /api/accounts/:id/model-mappings`, which reads `modelMappings` and
 * replaces the field. `exactRoundTrip` says whether that endpoint's own
 * serialization reproduces `model_mappings` byte-for-byte; when false it
 * restores the same mappings in the endpoint's normalized form.
 */
export interface CodexMigrationRecoveryItem {
	accountId: string;
	model_mappings: string;
	modelMappings: Record<string, unknown>;
	exactRoundTrip: boolean;
}

export interface CodexModelMigrationApplyResult {
	revision: number;
	applied: Array<{
		accountId: string;
		family: CodexMigrationFamily;
		previousPin: StoredPin;
	}>;
	recovery: CodexMigrationRecoveryItem[];
}

const COHERENT_READ_ATTEMPTS = 3;

type StoredMappings = Record<string, unknown>;

/**
 * The stored object exactly as written, or null when the column holds
 * nothing routing reads as a mapping (NULL, empty or invalid). Validity is
 * judged by core's own parser so this never sees a pin routing ignores.
 */
function readStoredMappings(raw: string | null): StoredMappings | null {
	if (raw === null || parseModelMappings(raw) === null) return null;
	return JSON.parse(raw.trim()) as StoredMappings;
}

/** Core trims keys when parsing, so a stored " opus " key pins `opus` too. */
function isFamilyKey(key: string, family: string): boolean {
	return key.trim() === family;
}

function storedPin(
	stored: StoredMappings | null,
	family: string,
): StoredPin | null {
	if (!stored) return null;
	let pin: StoredPin | null = null;
	for (const [key, value] of Object.entries(stored)) {
		// Last matching key wins, as in core's parse.
		if (isFamilyKey(key, family)) pin = value as StoredPin;
	}
	return pin;
}

/**
 * Remove the given family keys and keep every other stored key and value
 * exactly as stored, in stored order (exact model-ID keys, ordered arrays,
 * one-element arrays and unrelated families included). NULL when nothing
 * is left. `Object.fromEntries` keeps a literal `__proto__` key as data.
 */
function withoutFamilies(
	stored: StoredMappings,
	families: readonly string[],
): string | null {
	const remaining = Object.entries(stored).filter(
		([key]) => !families.some((family) => isFamilyKey(key, family)),
	);
	return remaining.length > 0
		? JSON.stringify(Object.fromEntries(remaining))
		: null;
}

/** Whether the model-mappings endpoint would store `raw` back byte-for-byte. */
function endpointReproduces(raw: string): boolean {
	try {
		const validated = validateModelMappings(JSON.parse(raw), "modelMappings");
		return (
			Object.keys(validated).length > 0 && JSON.stringify(validated) === raw
		);
	} catch {
		return false;
	}
}

interface ResolutionContext {
	catalog: CodexAccountCatalogInfo;
	globalOverrides: Record<string, string> | undefined;
	envMappings: Record<string, string | string[]> | null;
	forceMode: boolean;
}

function readProcessContext(): Omit<ResolutionContext, "catalog"> {
	const envRaw = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
	return {
		// The process-wide registry resolveCodexRequestModel reads, not Config's
		// persisted copy, so the blocker cannot disagree with the resolved model.
		globalOverrides: getProviderModelDefaultOverrides().codex,
		envMappings: envRaw ? parseModelMappings(envRaw) : null,
		forceMode: isForceAccountModelEnabled(),
	};
}

function resolveFamily(
	account: Account,
	family: CodexMigrationFamily,
	context: ResolutionContext,
) {
	return resolveCodexAccountFamilyDefault(account, family, {
		globalOverride: context.globalOverrides?.[family],
		catalog: context.catalog,
	});
}

function describeFamily(
	account: Account,
	stored: StoredMappings | null,
	family: CodexMigrationFamily,
	context: ResolutionContext,
): CodexMigrationFamilyEntry {
	const accountPin = storedPin(stored, family);
	const current = resolveFamily(account, family, context);
	// Resolve inheritance on a clone with only this family key removed; the
	// stored row is never touched here.
	const inherited =
		stored && accountPin !== null
			? resolveFamily(
					{ ...account, model_mappings: withoutFamilies(stored, [family]) },
					family,
					context,
				)
			: current;
	const roleTarget = getCodexCatalogRoleTarget(account.id, family);

	const blockers: CodexMigrationBlocker[] = [];
	if (accountPin === null) blockers.push("no_account_pin");
	if (context.forceMode) blockers.push("force_account_model_mode");
	if (
		parseCustomEndpointData(account.custom_endpoint)?.modelMappings?.[
			family
		] !== undefined
	) {
		blockers.push("custom_endpoint_mapping");
	}
	if (context.envMappings?.[family] !== undefined) {
		blockers.push("environment_mapping");
	}
	if (parseModelFallbacks(account.model_fallbacks)?.[family] !== undefined) {
		blockers.push("model_fallbacks");
	}
	if (context.globalOverrides?.[family] !== undefined) {
		blockers.push("global_provider_override");
	}
	if (roleTarget === null) blockers.push("no_own_catalog");
	if (
		blockers.length === 0 &&
		(inherited.source !== "account_catalog" ||
			inherited.effectiveModel !== roleTarget)
	) {
		blockers.push("inherited_target_mismatch");
	}

	return {
		family,
		currentModel: current.effectiveModel,
		currentSource: current.source,
		accountPin,
		inheritedModel: inherited.effectiveModel,
		inheritedSource: inherited.source,
		roleTarget,
		applicable: blockers.length === 0,
		blockers,
	};
}

function staleConflict(details: Record<string, unknown>) {
	return Conflict(
		"Codex model mappings changed since the preview; preview again",
		{ code: STALE_CODEX_MIGRATION_PREVIEW, ...details },
	);
}

/**
 * All accounts plus the routing-policy revision they were read at. Every
 * `model_mappings`, `model_fallbacks`, `custom_endpoint`, provider or
 * account-set change advances that revision, so an unchanged revision around
 * the read proves the rows belong to it.
 */
async function readCoherentAccounts(
	dbOps: DatabaseOperations,
): Promise<{ revision: number; accounts: Account[] }> {
	for (let attempt = 0; attempt < COHERENT_READ_ATTEMPTS; attempt++) {
		const before = await dbOps.getRoutingPolicyRevision();
		const accounts = await dbOps.getAllAccounts();
		const after = await dbOps.getRoutingPolicyRevision();
		if (before === after) return { revision: after, accounts };
	}
	throw staleConflict({ reason: "revision" });
}

function codexAccountsByName(accounts: readonly Account[]): Account[] {
	return accounts
		.filter((account) => account.provider === "codex")
		.sort((a, b) => a.name.localeCompare(b.name));
}

function routeProfileAdvisories(
	profiles: readonly ModelRouteProfile[],
	accountIds: ReadonlySet<string>,
): CodexMigrationRouteProfileAdvisory[] {
	const advisories: CodexMigrationRouteProfileAdvisory[] = [];
	for (const profile of profiles) {
		// Only exact-account profiles pin an account, and only the exact policy
		// carries a fixed physical model; catalog-role profiles already follow
		// the catalog and have no expectedPhysicalModel.
		if (
			profile.selection !== undefined ||
			profile.accountId === undefined ||
			!accountIds.has(profile.accountId) ||
			profile.physicalModelPolicy === "catalog-role" ||
			profile.expectedPhysicalModel === undefined
		) {
			continue;
		}
		advisories.push({
			profileId: profile.id,
			displayName: profile.displayName,
			accountId: profile.accountId,
			logicalModel: profile.logicalModel,
			family: getModelFamily(profile.logicalModel),
			expectedPhysicalModel: profile.expectedPhysicalModel,
		});
	}
	return advisories;
}

/** Read-only preview. Never writes, never fetches a catalog. */
export async function previewCodexModelMigration(
	dbOps: DatabaseOperations,
	options: {
		accountIds?: readonly string[];
		routeProfiles?: readonly ModelRouteProfile[];
	} = {},
): Promise<CodexModelMigrationPreview> {
	const { revision, accounts } = await readCoherentAccounts(dbOps);
	let selected = codexAccountsByName(accounts);
	if (options.accountIds) {
		const known = new Set(selected.map((account) => account.id));
		const unknown = options.accountIds.filter((id) => !known.has(id));
		if (unknown.length > 0) {
			throw NotFound("Unknown Codex account id(s)", { accountIds: unknown });
		}
		const wanted = new Set(options.accountIds);
		selected = selected.filter((account) => wanted.has(account.id));
	}

	const processContext = readProcessContext();
	const now = Date.now();
	const entries = selected.map((account): CodexMigrationAccountEntry => {
		const catalog = describeCodexAccountCatalog(account.id, now);
		const context = { ...processContext, catalog: catalog.info };
		const stored = readStoredMappings(account.model_mappings);
		return {
			accountId: account.id,
			accountName: account.name,
			expected_old_value: account.model_mappings,
			catalog: catalog.view,
			families: CODEX_MIGRATION_FAMILIES.map((family) =>
				describeFamily(account, stored, family, context),
			),
		};
	});

	return {
		revision,
		accounts: entries,
		routeProfileAdvisories: routeProfileAdvisories(
			options.routeProfiles ?? [],
			new Set(selected.map((account) => account.id)),
		),
	};
}

/**
 * Re-verify every selection against current state, then remove the selected
 * family keys in one guarded batch (one write per account). Rejects the whole
 * request, writing nothing, on any stale or non-applicable selection.
 *
 * No explicit post-write refresh is needed or available to reuse: the
 * existing model-mappings endpoint triggers none either, because the proxy
 * reads accounts from the database on every request, and the account update
 * trigger advances the routing-policy revision for revision-keyed readers.
 */
export async function applyCodexModelMigration(
	dbOps: DatabaseOperations,
	input: CodexModelMigrationApplyInput,
): Promise<CodexModelMigrationApplyResult> {
	const { revision, accounts } = await readCoherentAccounts(dbOps);
	if (revision !== input.expected_revision) {
		throw staleConflict({ reason: "revision" });
	}
	const byId = new Map(accounts.map((account) => [account.id, account]));

	const groups = new Map<string, CodexModelMigrationSelection[]>();
	for (const selection of input.selections) {
		const group = groups.get(selection.accountId);
		if (group) group.push(selection);
		else groups.set(selection.accountId, [selection]);
	}

	// A row that no longer holds the previewed value is stale, whatever else.
	for (const [accountId, selections] of groups) {
		const account = byId.get(accountId);
		if (!account) continue;
		if (
			selections.some(
				(selection) => selection.expected_old_value !== account.model_mappings,
			)
		) {
			throw staleConflict({ reason: "row", accountId });
		}
	}

	const processContext = readProcessContext();
	const rejected: Array<{
		accountId: string;
		family: CodexMigrationFamily;
		blockers: CodexMigrationRejection[];
	}> = [];
	const writes: GuardedModelMappingsWrite[] = [];
	const applied: CodexModelMigrationApplyResult["applied"] = [];
	const recovery: CodexMigrationRecoveryItem[] = [];

	for (const [accountId, selections] of groups) {
		const account = byId.get(accountId);
		if (!account || account.provider !== "codex") {
			for (const selection of selections) {
				rejected.push({
					accountId,
					family: selection.family,
					blockers: [account ? "not_codex_account" : "unknown_account"],
				});
			}
			continue;
		}
		const context = {
			...processContext,
			catalog: describeCodexAccountCatalog(account.id).info,
		};
		const stored = readStoredMappings(account.model_mappings);
		const entries = selections.map((selection) =>
			describeFamily(account, stored, selection.family, context),
		);
		const blocked = entries.filter((entry) => !entry.applicable);
		for (const entry of blocked) {
			rejected.push({
				accountId,
				family: entry.family,
				blockers: entry.blockers,
			});
		}
		// Applicable implies a pin exists, so the stored value is a valid object.
		if (blocked.length > 0 || !stored || account.model_mappings === null) {
			continue;
		}

		const families = entries.map((entry) => entry.family);
		const newValue = withoutFamilies(stored, families);
		// Each family was verified with only its own key removed; also verify
		// the combined removal lands every selected family on its role target.
		const migrated = { ...account, model_mappings: newValue };
		for (const entry of entries) {
			const resolved = resolveFamily(migrated, entry.family, context);
			if (
				resolved.source !== "account_catalog" ||
				resolved.effectiveModel !== entry.roleTarget
			) {
				rejected.push({
					accountId,
					family: entry.family,
					blockers: ["inherited_target_mismatch"],
				});
			}
		}

		// Guard on the caller's previewed value (checked equal above), so the
		// batch itself enforces the preview even if a row changes after this read.
		writes.push({
			account_id: accountId,
			expected_old_value: selections[0]?.expected_old_value ?? null,
			new_value: newValue,
		});
		for (const entry of entries) {
			if (entry.accountPin === null) continue;
			applied.push({
				accountId,
				family: entry.family,
				previousPin: entry.accountPin,
			});
		}
		recovery.push({
			accountId,
			model_mappings: account.model_mappings,
			modelMappings: stored,
			exactRoundTrip: endpointReproduces(account.model_mappings),
		});
	}

	if (rejected.length > 0) {
		throw Conflict(
			"One or more selections cannot be migrated to the account's own catalog; nothing was changed",
			{ code: CODEX_MIGRATION_SELECTION_NOT_APPLICABLE, selections: rejected },
		);
	}

	let result: { revision: number };
	try {
		result = await dbOps.applyGuardedModelMappingsWrites({
			expected_revision: input.expected_revision,
			writes,
		});
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === "stale_model_mappings_write"
		) {
			const conflict = error as { reason?: unknown; accountId?: unknown };
			throw staleConflict({
				reason: conflict.reason,
				...(typeof conflict.accountId === "string"
					? { accountId: conflict.accountId }
					: {}),
			});
		}
		throw error;
	}

	return { revision: result.revision, applied, recovery };
}
