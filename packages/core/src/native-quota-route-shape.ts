import type {
	Account,
	ComboFamily,
	EffectiveComboMember,
} from "@better-ccflare/types";
import {
	getEndpointUrl,
	getModelList,
	getStrictClaudeModelFamily,
} from "./model-mappings";
import { validateModelMappings } from "./validation";

export type NativeQuotaRouteShape =
	| { valid: true; primaryAccountIds: string[] }
	| { valid: false; reason: string };

/** Pure structural validation. Pausing affects availability, never membership. */
export function validateNativeQuotaRouteShape(input: {
	family: ComboFamily;
	members: readonly EffectiveComboMember[];
	accounts: readonly Account[];
}): NativeQuotaRouteShape {
	const accounts = new Map(
		input.accounts.map((account) => [account.id, account]),
	);
	const primary = input.members.filter(
		(member) =>
			getStrictClaudeModelFamily(member.logical_model) === input.family,
	);
	if (primary.length === 0)
		return {
			valid: false,
			reason: "Native quota wait requires a nonempty primary family lane.",
		};
	const primaryAccountIds = [
		...new Set(primary.map((member) => member.account_id)),
	];
	const lastPrimaryTier = Math.max(...primary.map((member) => member.tier));
	for (const member of input.members) {
		const account = accounts.get(member.account_id);
		const family = getStrictClaudeModelFamily(member.logical_model);
		if (
			!account ||
			account.provider !== "anthropic" ||
			account.api_key?.trim() ||
			!(account.refresh_token?.trim() || account.access_token?.trim()) ||
			(account.billing_type != null &&
				account.billing_type.trim() !== "" &&
				account.billing_type.trim().toLowerCase() !== "plan")
		) {
			return {
				valid: false,
				reason:
					"Native quota wait requires native Anthropic subscription accounts.",
			};
		}
		if (
			!Number.isFinite(member.tier) ||
			(family !== input.family &&
				!(
					input.family === "fable" &&
					family === "opus" &&
					primaryAccountIds.includes(member.account_id) &&
					member.tier > lastPrimaryTier
				))
		) {
			return {
				valid: false,
				reason:
					"Only Fable may use Opus backups, on primary-pool accounts and after all primary tiers.",
			};
		}
		try {
			// Legacy parsers fail open; strict policy must not ignore malformed route configuration.
			const embedded = account.custom_endpoint?.trim().startsWith("{")
				? JSON.parse(account.custom_endpoint)
				: null;
			if (account.model_mappings) {
				validateModelMappings(
					JSON.parse(account.model_mappings),
					"model_mappings",
				);
			}
			if (embedded?.modelMappings !== undefined) {
				validateModelMappings(
					embedded.modelMappings,
					"custom_endpoint.modelMappings",
				);
			}
			if (account.model_fallbacks) {
				const fallbacks = JSON.parse(account.model_fallbacks);
				validateModelMappings(fallbacks, "model_fallbacks");
				// The legacy fallback parser accepts single strings only, even when
				// an array would be valid in the current model_mappings field.
				if (Object.values(fallbacks).some(Array.isArray))
					throw new Error("Invalid legacy fallback mapping");
			}

			const endpoint = getEndpointUrl(account);
			if (endpoint) {
				const url = new URL(endpoint);
				if (
					url.protocol !== "https:" ||
					url.hostname !== "api.anthropic.com" ||
					url.port ||
					url.username ||
					url.password
				)
					throw new Error("Non-native endpoint");
			}
			const physicalModels = getModelList(member.logical_model, account) ?? [
				member.logical_model,
			];
			if (
				physicalModels.some(
					(model) => getStrictClaudeModelFamily(model) !== family,
				)
			)
				throw new Error("Non-native model destination");
		} catch {
			return {
				valid: false,
				reason:
					"Native quota wait requires valid native physical destinations in the slot's family.",
			};
		}
	}
	return { valid: true, primaryAccountIds };
}
