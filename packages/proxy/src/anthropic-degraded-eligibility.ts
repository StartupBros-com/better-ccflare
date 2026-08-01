import { deriveComboRouteClass } from "@better-ccflare/providers/request-capabilities";
import type { Account } from "@better-ccflare/types";

export type NativeAnthropicOAuthDegradedModeAccount = Pick<
	Account,
	"provider" | "billing_type" | "api_key" | "refresh_token" | "access_token"
>;

/**
 * One fail-closed enrollment boundary shared by owner selection and the
 * physical-send choke point.
 */
export function isNativeAnthropicOAuthDegradedModeEligible(
	account: NativeAnthropicOAuthDegradedModeAccount,
): boolean {
	return (
		account.provider === "anthropic" &&
		!account.api_key?.trim() &&
		Boolean(account.refresh_token?.trim()) &&
		deriveComboRouteClass(account) === "oauth-subscription"
	);
}
