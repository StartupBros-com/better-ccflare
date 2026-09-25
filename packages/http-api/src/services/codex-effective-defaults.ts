import {
	isForceAccountModelEnabled,
	parseCustomEndpointData,
	parseModelFallbacks,
	parseModelMappings,
} from "@better-ccflare/core";
import { resolveCodexRequestModel } from "@better-ccflare/providers/codex";
import type { Account } from "@better-ccflare/types";

/**
 * Where a Codex account's effective per-family model came from, ranked most
 * specific first. The first five are all "pins" — something an operator (or
 * the environment) explicitly configured, in the same precedence order
 * `mergeAccountModelMappings`/`getModelMappings` (packages/core/src/model-mappings.ts)
 * already apply when actually routing a request. The last three are
 * "automatic": nobody pinned this family, so a catalog or compiled default
 * fills the gap.
 */
export type CodexAccountFamilySource =
	| "account_mapping_pin"
	| "custom_endpoint_mapping"
	| "model_fallbacks"
	| "environment_mapping"
	| "global_provider_override"
	| "account_catalog"
	| "provider_catalog_borrowed"
	| "compiled_default";

export interface CodexAccountFamilyDefault {
	family: string;
	effectiveModel: string;
	source: CodexAccountFamilySource;
	/** True for every source except the three catalog/compiled "automatic" ones. */
	pinned: boolean;
	/**
	 * Set only when `source` is "global_provider_override": the account has no
	 * mapping of its own, and a provider-wide override is the thing pinning it.
	 */
	globalOverridePinsUnmappedAccount?: boolean;
}

/** Own-vs-borrowed-vs-none read of a Codex account's model catalog, with no fetch triggered. */
export interface CodexAccountCatalogInfo {
	source: "own" | "borrowed" | "none";
	borrowedFrom?: string;
}

/**
 * Resolve one family's effective default for one Codex account, and label
 * which layer produced it.
 *
 * `effectiveModel` is always `resolveCodexRequestModel(family, account)` —
 * the exact function request transformation calls — so there is only ever
 * one resolver for what a family actually maps to; this function only adds
 * the `source`/`pinned`/`globalOverridePinsUnmappedAccount` attribution on
 * top, mirroring the precedence `mergeAccountModelMappings` already applies
 * at request time (custom_endpoint.modelMappings overwrites model_mappings
 * overwrites the environment mapping; model_fallbacks only fills a family
 * still left empty by the other three).
 *
 * `resolveCodexRequestModel` calls `mapModelName`, which returns its input
 * unchanged whenever `isForceAccountModelEnabled()` — in that mode none of
 * the account/env/custom-endpoint/model_fallbacks pins below are actually
 * applied, so this function skips straight to the (still force-mode-active)
 * global override and catalog/compiled attribution instead of claiming one
 * of those four pins. `resolveProviderModelDefault` (the global-override and
 * catalog/compiled source of truth `resolveCodexRequestModel` falls back to)
 * is not gated by force mode, so those two attributions stay accurate in
 * both modes.
 */
export function resolveCodexAccountFamilyDefault(
	account: Account,
	family: string,
	options: {
		/**
		 * `getProviderModelDefaultOverrides().codex?.[family]` from
		 * `@better-ccflare/providers` — the process-wide registry
		 * `resolveCodexRequestModel` resolves from, not Config's persisted
		 * copy, so this label cannot disagree with `effectiveModel`.
		 */
		globalOverride?: string;
		catalog: CodexAccountCatalogInfo;
	},
): CodexAccountFamilyDefault {
	const effectiveModel = resolveCodexRequestModel(family, account);

	if (!isForceAccountModelEnabled()) {
		const modelMappingsMap = parseModelMappings(account.model_mappings);
		const customEndpointMap = parseCustomEndpointData(
			account.custom_endpoint,
		)?.modelMappings;
		const fallbacksMap = parseModelFallbacks(account.model_fallbacks);
		const envRaw =
			typeof process !== "undefined"
				? process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
				: undefined;
		const envMap = envRaw ? parseModelMappings(envRaw) : null;

		if (customEndpointMap?.[family] !== undefined) {
			return {
				family,
				effectiveModel,
				source: "custom_endpoint_mapping",
				pinned: true,
			};
		}
		if (modelMappingsMap?.[family] !== undefined) {
			return {
				family,
				effectiveModel,
				source: "account_mapping_pin",
				pinned: true,
			};
		}
		if (envMap?.[family] !== undefined) {
			return {
				family,
				effectiveModel,
				source: "environment_mapping",
				pinned: true,
			};
		}
		if (fallbacksMap?.[family] !== undefined) {
			return {
				family,
				effectiveModel,
				source: "model_fallbacks",
				pinned: true,
			};
		}
	}
	if (options.globalOverride !== undefined) {
		return {
			family,
			effectiveModel,
			source: "global_provider_override",
			pinned: true,
			globalOverridePinsUnmappedAccount: true,
		};
	}
	const source: CodexAccountFamilySource =
		options.catalog.source === "own"
			? "account_catalog"
			: options.catalog.source === "borrowed"
				? "provider_catalog_borrowed"
				: "compiled_default";
	return {
		family,
		effectiveModel,
		source,
		pinned: false,
	};
}
