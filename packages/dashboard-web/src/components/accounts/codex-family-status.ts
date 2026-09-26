import type {
	CodexAccountCatalogStatus,
	CodexAccountFamilyDefault,
} from "../../lib/provider-model-defaults-api";

const SOURCE_LABELS: Record<string, string> = {
	account_mapping_pin: "account mapping",
	custom_endpoint_mapping: "legacy custom endpoint mapping",
	model_fallbacks: "deprecated model fallback",
	environment_mapping: "environment mapping",
	global_provider_override: "global provider override",
	account_catalog: "this account’s catalog",
	provider_catalog_borrowed: "shared catalog (borrowed)",
	compiled_default: "compiled default",
};

function sourceLabel(source: string): string {
	return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

function freshnessSuffix(
	catalog: CodexAccountCatalogStatus | undefined,
): string {
	if (!catalog || catalog.source === "none") return "";
	return catalog.stale ? ", stale" : ", fresh";
}

/**
 * Human copy for one Codex account's per-family effective-default status, as
 * returned by GET /api/config/provider-model-defaults's additive `accounts`
 * field. Pure and DOM-free so it is unit-testable without rendering the
 * dialog; `AccountModelMappingsDialog` only formats this string into markup.
 *
 * Returns null when there is no data for this family yet (e.g. the query is
 * still loading, or the account has no Codex effective-defaults entry at
 * all) so the caller can render nothing rather than a misleading placeholder.
 */
export function describeCodexFamilyStatus(
	family: CodexAccountFamilyDefault | undefined,
	catalog: CodexAccountCatalogStatus | undefined,
): string | null {
	if (!family) return null;
	if (family.pinned) {
		const reason = family.globalOverridePinsUnmappedAccount
			? `${sourceLabel(family.source)}, no account-level mapping`
			: sourceLabel(family.source);
		return `Pinned — ${family.effectiveModel} (${reason})`;
	}
	return `Automatic — current default ${family.effectiveModel} (${sourceLabel(
		family.source,
	)}${freshnessSuffix(catalog)})`;
}
