import { describe, expect, it } from "bun:test";
import type {
	AccountRoutingOverview,
	ComboFamily,
	ComboMembershipReasonCode,
	ComboMembershipSource,
	ComboRoutingAvailabilityReason,
} from "@better-ccflare/types";
import { getAccountFamilyRoutingStates } from "../../../../dashboard-web/src/components/accounts/account-routing";
import {
	type ManagedRoutingAccountProjection,
	projectManagedRoutingAccounts,
} from "../managed-routing";
import {
	CONTRACT_ACCOUNT_IDS,
	managedRoutingContractAccounts,
	managedRoutingContractOverview,
} from "./managed-routing-contract.fixture";

interface RoutingContractTuple {
	account_id: string;
	family: ComboFamily;
	source: ComboMembershipSource | null;
	tier: number | null;
	logical_model: string | null;
	reason: ComboMembershipReasonCode;
	availability: ComboRoutingAvailabilityReason;
}

function tupleKey(tuple: RoutingContractTuple): string {
	return `${tuple.account_id}\u0000${tuple.family}`;
}

function sorted(tuples: RoutingContractTuple[]): RoutingContractTuple[] {
	return tuples.sort((left, right) =>
		tupleKey(left).localeCompare(tupleKey(right)),
	);
}

function normalizeHttpOverview(
	overview: AccountRoutingOverview,
): RoutingContractTuple[] {
	const byAccountFamily = new Map<string, RoutingContractTuple>();
	for (const view of overview.effective) {
		for (const decision of view.resolution.decisions) {
			const tuple: RoutingContractTuple = {
				account_id: decision.account_id,
				family: decision.family,
				source: decision.source,
				tier: decision.tier,
				logical_model: decision.logical_model,
				reason: decision.reason,
				availability: decision.availability.reason,
			};
			byAccountFamily.set(tupleKey(tuple), tuple);
		}
		// Effective membership is the current card/list fact when the resolver's
		// audit trail also contains the corresponding included decision.
		for (const member of view.resolution.members) {
			const tuple: RoutingContractTuple = {
				account_id: member.account_id,
				family: member.family,
				source: member.source,
				tier: member.tier,
				logical_model: member.logical_model,
				reason: member.reason,
				availability: member.availability.reason,
			};
			byAccountFamily.set(tupleKey(tuple), tuple);
		}
	}
	return sorted([...byAccountFamily.values()]);
}

function normalizeDashboard(
	over: AccountRoutingOverview,
): RoutingContractTuple[] {
	const tuples: RoutingContractTuple[] = [];
	for (const account of managedRoutingContractAccounts) {
		for (const state of getAccountFamilyRoutingStates(account.id, over)) {
			if (state.reason === null || state.availability === null) continue;
			tuples.push({
				account_id: account.id,
				family: state.family,
				source:
					state.membershipLabel === "Manual"
						? "manual"
						: state.membershipLabel === "Managed"
							? "managed"
							: null,
				tier: state.tier,
				logical_model: state.logicalModel,
				reason: state.reason,
				availability: state.availability,
			});
		}
	}
	return sorted(tuples);
}

function normalizeCli(
	accounts: ManagedRoutingAccountProjection[],
): RoutingContractTuple[] {
	const byAccountFamily = new Map<string, RoutingContractTuple>();
	for (const account of accounts) {
		for (const decision of account.decisions) {
			const tuple: RoutingContractTuple = {
				account_id: account.account_id,
				family: decision.family,
				source: decision.source,
				tier: decision.tier,
				logical_model: decision.logical_model,
				reason: decision.reason as ComboMembershipReasonCode,
				availability: decision.availability
					.reason as ComboRoutingAvailabilityReason,
			};
			byAccountFamily.set(tupleKey(tuple), tuple);
		}
		for (const member of account.memberships) {
			const tuple: RoutingContractTuple = {
				account_id: account.account_id,
				family: member.family,
				source: member.source,
				tier: member.tier,
				logical_model: member.logical_model,
				reason: member.reason as ComboMembershipReasonCode,
				availability: member.availability
					.reason as ComboRoutingAvailabilityReason,
			};
			byAccountFamily.set(tupleKey(tuple), tuple);
		}
	}
	return sorted([...byAccountFamily.values()]);
}

describe("managed routing cross-layer contract", () => {
	it("keeps dashboard and CLI tuples identical to the authoritative HTTP overview", () => {
		const cliProjection = projectManagedRoutingAccounts(
			managedRoutingContractAccounts,
			managedRoutingContractOverview,
		);
		const authoritative = normalizeHttpOverview(managedRoutingContractOverview);

		expect(normalizeDashboard(managedRoutingContractOverview)).toEqual(
			authoritative,
		);
		expect(normalizeCli(cliProjection)).toEqual(authoritative);

		expect(
			managedRoutingContractAccounts.filter(
				(account) =>
					account.provider === "anthropic" && account.hasRefreshToken,
			),
		).toHaveLength(4);
		expect(
			managedRoutingContractOverview.effective.map((view) => [
				view.family,
				view.policy.assignment.membership_mode,
				view.policy.rules.some((rule) => rule.enabled),
			]),
		).toEqual([
			["opus", "managed", true],
			["fable", "managed", true],
		]);
		expect(new Set(authoritative.map((tuple) => tuple.availability))).toEqual(
			new Set([
				"available",
				"paused",
				"rate_limited",
				"model_exhausted",
				"requires_reauth",
			]),
		);
		expect(authoritative).toContainEqual(
			expect.objectContaining({
				account_id: CONTRACT_ACCOUNT_IDS.codexManual,
				family: "opus",
				source: "manual",
			}),
		);
		expect(authoritative).toContainEqual(
			expect.objectContaining({
				account_id: CONTRACT_ACCOUNT_IDS.xaiManual,
				family: "fable",
				source: "manual",
			}),
		);
		expect(authoritative).toContainEqual(
			expect.objectContaining({
				account_id: CONTRACT_ACCOUNT_IDS.nonNativeSupported,
				source: "managed",
			}),
		);
		expect(authoritative).toContainEqual(
			expect.objectContaining({
				account_id: CONTRACT_ACCOUNT_IDS.anthropicReauth,
				family: "opus",
				reason: "excluded",
			}),
		);
		expect(authoritative).toContainEqual(
			expect.objectContaining({
				account_id: CONTRACT_ACCOUNT_IDS.nonNativeUnknown,
				reason: "unknown",
			}),
		);

		const zeroMembership = cliProjection.find(
			(account) => account.account_id === CONTRACT_ACCOUNT_IDS.zeroMembership,
		);
		expect(zeroMembership).toMatchObject({
			memberships: [],
			decisions: [],
			opportunities: [],
		});
		expect(
			getAccountFamilyRoutingStates(
				CONTRACT_ACCOUNT_IDS.zeroMembership,
				managedRoutingContractOverview,
			),
		).toEqual([]);
	});
});
