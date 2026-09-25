import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CodexAccountEffectiveDefaults,
	type CodexClientIdentityDiagnostics,
	fetchProviderModelDefaultsResponse,
	type ProviderModelDefaultOverrideInput,
	saveProviderModelDefaultOverrides,
} from "../lib/provider-model-defaults-api";
import { queryKeys } from "../lib/query-keys";

/**
 * Per-provider-and-family default model map (the one embedded in code, the
 * last word in the resolution chain). Few records: short staleTime only to
 * avoid duplicate calls between re-renders, with no polling.
 *
 * Shares one query (same key + fetcher) with `useCodexAccountEffectiveDefaults`
 * below via `select`, so both hooks read one network response instead of two.
 */
export const useProviderModelDefaults = () =>
	useQuery({
		queryKey: queryKeys.providerModelDefaults(),
		queryFn: fetchProviderModelDefaultsResponse,
		staleTime: 30 * 1000,
		select: (data) => data.providers,
	});

/**
 * Codex-only, additive: per-account, per-family effective defaults and safe
 * client-identity diagnostics. Both are `undefined` when the server didn't
 * wire dbOps for this endpoint or Codex isn't an enabled provider — callers
 * should treat an undefined `accounts` list as "no data yet", not "no Codex
 * accounts exist".
 */
export const useCodexAccountEffectiveDefaults = () =>
	useQuery({
		queryKey: queryKeys.providerModelDefaults(),
		queryFn: fetchProviderModelDefaultsResponse,
		staleTime: 30 * 1000,
		select: (
			data,
		): {
			accounts: CodexAccountEffectiveDefaults[] | undefined;
			codexClientIdentity: CodexClientIdentityDiagnostics | undefined;
		} => ({
			accounts: data.accounts,
			codexClientIdentity: data.codexClientIdentity,
		}),
	});

/**
 * Saves the overrides edited on screen in one operation. Invalidates the query
 * above to reload the effective value after saving.
 */
export const useSaveProviderModelDefaults = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (overrides: ProviderModelDefaultOverrideInput[]) =>
			saveProviderModelDefaultOverrides(overrides),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.providerModelDefaults(),
			});
		},
	});
};
