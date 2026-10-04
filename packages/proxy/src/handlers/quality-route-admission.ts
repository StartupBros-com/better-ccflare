import { isFirstPartyAnthropicAccount } from "@better-ccflare/core";
import {
	type AutoRequestAdmissionInput,
	evaluateAutoRequestAdmission,
	revalidateAutoTarget,
} from "@better-ccflare/providers";
import type {
	Account,
	QualityAdmissionDecision,
	QualityRoutingPolicy,
} from "@better-ccflare/types";
import { validateCodexAutoCatalogCredentials } from "../codex-model-catalog";
import {
	type AutoResolvedCredentials,
	validateNativeAutoCatalogCredentials,
} from "../model-catalog";
import { evaluateAutoCapacity } from "./usage-throttling";

export interface QualityRouteAdmissionInput {
	readonly account: Pick<
		Account,
		"id" | "provider" | "paused" | "rate_limited_until" | "custom_endpoint"
	>;
	/** Re-read trusted compiled policy after credential preparation. */
	readonly policy: Pick<
		QualityRoutingPolicy,
		"accounts" | "assignments" | "spendGrants"
	>;
	/** The candidate's first-party status is derived here from `account`. */
	readonly request: Omit<AutoRequestAdmissionInput, "firstPartyAnthropic">;
	/** Actual transport credentials, resolved by the server after all preparation.
	 * Never populate from request headers/body. Missing credentials fail closed.
	 */
	readonly selectedCredentials?: AutoResolvedCredentials;
	/** Re-read selected account usage; a snapshot from another account is not proof. */
	readonly usage: {
		readonly accountId: string;
		readonly provider: string;
		readonly observedAt: number;
		readonly data: unknown;
	};
}

/** Shared selection/physical pre-dispatch guard. U5 must invoke again after
 * credential preparation with current policy, usage, catalog and final envelope.
 * This function performs no routing, preparation, inference or transport.
 */
export function evaluateQualityRouteAdmission(
	input: QualityRouteAdmissionInput,
): QualityAdmissionDecision {
	const { account, policy, request, usage } = input;
	const { target } = request;
	if (
		account.id !== target.accountId ||
		account.provider !== target.provider ||
		!policy.accounts.some(
			(entry) =>
				entry.accountId === account.id &&
				entry.provider === target.provider &&
				entry.lines.includes(target.line),
		)
	)
		return { status: "reject", reason: "account-not-enrolled" };
	if (!policy.assignments.some((entry) => entry.line === target.line))
		return { status: "reject", reason: "line-not-approved" };
	if (
		account.paused ||
		(account.rate_limited_until !== null &&
			account.rate_limited_until > Date.now())
	)
		return { status: "reject", reason: "account-unavailable" };
	if (!revalidateAutoTarget(request))
		return { status: "unknown", reason: "catalog-evidence-stale" };
	if (usage.accountId !== account.id || usage.provider !== account.provider)
		return { status: "unknown", reason: "capacity-evidence-unknown" };
	const capacity = evaluateAutoCapacity(usage.data, {
		accountId: account.id,
		provider: target.provider,
		line: target.line,
		requestModel: target.physicalModel,
		observedAt: usage.observedAt,
		spendGrants: policy.spendGrants,
		accessToken: input.selectedCredentials?.accessToken ?? null,
	});
	if (capacity.status !== "admit") return capacity;
	const fit = evaluateAutoRequestAdmission({
		...request,
		firstPartyAnthropic: isFirstPartyAnthropicAccount(account),
	});
	if (fit.status === "reject") return fit;
	const selected = input.selectedCredentials;
	if (
		!selected ||
		selected.account.id !== account.id ||
		selected.account.provider !== account.provider ||
		!(target.provider === "anthropic"
			? validateNativeAutoCatalogCredentials(request.catalog, selected)
			: validateCodexAutoCatalogCredentials(request.catalog, selected))
	)
		return { status: "unknown", reason: "credential-evidence-unknown" };
	return fit;
}
