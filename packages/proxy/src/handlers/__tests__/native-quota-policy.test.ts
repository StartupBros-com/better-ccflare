import { describe, expect, it } from "bun:test";
import type { UsageSnapshot } from "@better-ccflare/providers";
import type {
	Account,
	ComboRoutingPolicySnapshot,
	EffectiveComboMember,
} from "@better-ccflare/types";
import {
	createNativeQuotaContext,
	evaluateNativeQuotaPolicy,
	isNativeQuotaCandidateAdmitted,
	type NativeQuotaFamilyMarker,
	resolveNativeQuotaContext,
} from "../native-quota-policy";

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;
const account = (id: string, overrides: Partial<Account> = {}) =>
	({
		id,
		provider: "anthropic",
		refresh_token: "offline",
		api_key: null,
		billing_type: "plan",
		paused: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		...overrides,
	}) as Account;
const member = (id: string, model: string, tier = 0) =>
	({
		id: `${id}:${model}`,
		account_id: id,
		logical_model: model,
		tier,
	}) as EffectiveComboMember;
const accounts = [account("a"), account("b")];
const members = [
	member("a", "claude-fable-5"),
	member("b", "claude-fable-5"),
	member("a", "claude-opus-5", 10),
	member("b", "claude-opus-5", 10),
];
const policy = {
	assignment: {
		family: "fable",
		combo_id: "combo",
		enabled: true,
		exhaustion_policy: "native_quota_wait",
	},
	combo: { id: "combo", enabled: true },
} as ComboRoutingPolicySnapshot;
const context = () =>
	createNativeQuotaContext({
		family: "fable",
		comboId: "combo",
		members,
		accounts,
		requestedModel: "claude-fable-5",
	});
interface TestUsageData {
	limits: Array<{
		kind: string;
		percent: unknown;
		is_active: unknown;
		resets_at: unknown;
		scope: { model: { id?: string; display_name?: string } };
	}>;
	spend?: { enabled: boolean };
}
const usage = (
	fable = 50,
	session = 20,
	overage: boolean | undefined = false,
	observedAt = NOW - 1000,
): UsageSnapshot => ({
	observedAt,
	data: {
		limits: [
			{
				kind: "session",
				percent: session,
				resets_at: new Date(RESET).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 20,
				resets_at: new Date(RESET + 10000).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_scoped",
				percent: fable,
				resets_at: new Date(RESET + 20000).toISOString(),
				is_active: true,
				scope: { model: { id: "claude-fable-5" } },
			},
		],
		...(overage === undefined ? {} : { spend: { enabled: overage } }),
	} as UsageSnapshot["data"],
});
const evaluate = (
	a = usage(),
	b = usage(),
	marker: Partial<NativeQuotaFamilyMarker> | null = null,
) =>
	evaluateNativeQuotaPolicy(context(), {
		now: NOW,
		getSnapshot: (id) => (id === "a" ? a : b),
		getFamilyMarker: () => marker as NativeQuotaFamilyMarker | null,
	});

describe("native quota admission evidence", () => {
	it("shares the selector context and terminal contracts", () => {
		const captured = createNativeQuotaContext({
			family: "fable",
			comboId: "combo",
			comboName: "Native pool",
			requestedModel: "claude-fable-5",
			members,
			accounts,
		});
		const result = evaluateNativeQuotaPolicy(captured, {
			now: NOW,
			getSnapshot: () => usage(51, 100),
			getFamilyMarker: () => null,
		});
		expect(captured.comboName).toBe("Native pool");
		expect(result.capacities.get("a:claude-fable-5")).toMatchObject([
			{ scope: "account", window: "five_hour" },
		]);
		expect(result.wait).toMatchObject({
			kind: "quota_wait",
			reason: "shared_capacity",
			comboId: "combo",
		});
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5",
			}),
		).toBe(false);
	});
	it("opts in only active assigned combos and leaves legacy or explicit routes alone", () => {
		for (const patch of [
			{ exhaustion_policy: undefined },
			{ enabled: false },
			{ combo_id: null },
		])
			expect(
				resolveNativeQuotaContext({
					snapshot: {
						...policy,
						assignment: { ...policy.assignment, ...patch },
					},
					members,
					accounts,
					requestedModel: "claude-fable-5",
				}),
			).toBeNull();
		expect(
			resolveNativeQuotaContext({
				snapshot: policy,
				members,
				accounts,
				requestedModel: "claude-fable-5",
				explicitRoute: true,
			}),
		).toBeNull();
		expect(
			resolveNativeQuotaContext({
				snapshot: policy,
				members,
				accounts,
				requestedModel: "claude-fable-5",
				combosEnabled: false,
			}),
		).toBeNull();
	});
	it("native family aliases retain the requested model while non-Claude routes opt out", () => {
		expect(
			resolveNativeQuotaContext({
				snapshot: policy,
				members,
				accounts,
				requestedModel: "fable",
			})?.requestedModel,
		).toBe("fable");
		expect(
			resolveNativeQuotaContext({
				snapshot: policy,
				members,
				accounts,
				requestedModel: "other-fable-model",
			}),
		).toBeNull();
	});
	it.each([
		null,
		undefined,
		7,
		"broken",
	])("malformed usage data %s does not throw or prove exhaustion", (data) => {
		const snapshot = { observedAt: NOW - 1, data } as UsageSnapshot;
		expect(evaluate(snapshot, snapshot).backupAllowedAccountIds).toEqual([]);
	});
	it("keeps available Fable and locks Opus", () => {
		const result = evaluate();
		expect(result.backupAllowedAccountIds).toEqual([]);
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "a",
				model: "claude-fable-5",
			}),
		).toBe(true);
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "a",
				model: "claude-opus-5",
			}),
		).toBe(false);
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "outside",
				model: "claude-fable-5",
			}),
		).toBe(false);
	});
	it("admits proven B Opus when A is shared-blocked without family exhaustion", () => {
		const result = evaluate(usage(51, 100), usage(100));
		expect(result.backupAllowedAccountIds).toEqual(["b"]);
		expect(result.wait).toBeNull();
	});
	it("final admission checks primary and backup own shared and family caps", () => {
		const result = evaluate(usage(40, 100), usage(100));
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "a",
				model: "claude-fable-5",
			}),
		).toBe(false);
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "b",
				model: "claude-fable-5",
			}),
		).toBe(false);
		expect(
			isNativeQuotaCandidateAdmitted(context(), result, {
				accountId: "b",
				model: "claude-opus-5",
			}),
		).toBe(true);
		const data = usage(100);
		(data.data as unknown as TestUsageData).limits.push({
			...(data.data as unknown as TestUsageData).limits[2],
			scope: { model: { id: "claude-opus-5" } },
		});
		expect(
			isNativeQuotaCandidateAdmitted(context(), evaluate(data, data), {
				accountId: "b",
				model: "claude-opus-5",
			}),
		).toBe(false);
	});
	it("reset metadata describes the earliest route after all its simultaneous blockers clear", () => {
		const data = usage(50, 100);
		(data.data as unknown as TestUsageData).limits[1].percent = 100;
		expect(evaluate(data, data).wait?.resetAt).toBe(RESET + 10000);
	});
	it("all Fable exhausted admits only configured same-pool Opus", () => {
		expect(evaluate(usage(100), usage(100)).backupAllowedAccountIds).toEqual([
			"a",
			"b",
		]);
	});
	it("shared exhaustion waits without asserting family exhaustion", () => {
		const result = evaluate(usage(50, 100), usage(50, 100));
		expect(result.wait).toMatchObject({
			kind: "quota_wait",
			reason: "shared_capacity",
			resetAt: RESET,
			nextRecheckAt: NOW + 60000,
		});
		expect(result.backupAllowedAccountIds).toEqual([]);
	});
	it.each([
		undefined,
		true,
	])("overage %s cannot proactively prove exhaustion", (overage) => {
		const snapshot = usage(100, 20, overage);
		if (overage === undefined)
			delete (snapshot.data as unknown as TestUsageData).spend;
		expect(evaluate(snapshot, snapshot).backupAllowedAccountIds).toEqual([]);
	});
	it.each([
		NOW + 1,
		NOW - 180000,
		NOW - 1000000,
	])("observation %s is not fresh evidence", (observedAt) => {
		expect(
			evaluate(
				usage(100, 20, false, observedAt),
				usage(100, 20, false, observedAt),
			).backupAllowedAccountIds,
		).toEqual([]);
	});
	it.each([
		"inactive",
		"malformed",
		"conflicting",
		"expired",
		"identity_conflict",
		"alias_identity_conflict",
		"identity_ambiguous",
		"invalid_active",
	])("%s rows do not prove exhaustion", (kind) => {
		const data = usage(100);
		const rows = (data.data as unknown as TestUsageData).limits;
		if (kind === "inactive") rows[2].is_active = false;
		if (kind === "malformed") rows.push({ ...rows[2], percent: null });
		if (kind === "conflicting") rows.push({ ...rows[2], percent: 5 });
		if (kind === "expired") rows[2].resets_at = new Date(NOW - 1).toISOString();
		if (kind === "identity_conflict")
			rows[2].scope.model.display_name = "Claude Opus";
		if (kind === "alias_identity_conflict")
			rows[2].scope.model = { id: "opus", display_name: "Claude Fable" };
		if (kind === "identity_ambiguous")
			rows[2].scope.model.display_name = "Claude Fable and Opus";
		if (kind === "invalid_active") rows[2].is_active = "false";
		expect(evaluate(data, data).backupAllowedAccountIds).toEqual([]);
	});
	it("affirmative family marker overcomes missing overage but needs fresh active headroom", () => {
		const data = usage(100);
		delete (data.data as unknown as TestUsageData).spend;
		const marker = {
			evidence: {
				reason: "matching_scoped_limit" as const,
				authoritativeNativeRejection: true as const,
			},
			family: "fable",
			markedAt: NOW - 100,
			expiresAt: NOW + 60000,
		};
		expect(evaluate(data, data, marker).backupAllowedAccountIds).toEqual([
			"a",
			"b",
		]);
		(data.data as unknown as TestUsageData).limits[0].is_active = false;
		expect(evaluate(data, data, marker).backupAllowedAccountIds).toEqual([]);
	});
	it("contradictory enabled overage signals cannot prove hard family exhaustion", () => {
		const data = usage(100);
		Object.assign(data.data, { extra_usage: { is_enabled: true } });
		const marker = {
			evidence: {
				reason: "matching_scoped_limit" as const,
				authoritativeNativeRejection: true as const,
			},
			family: "fable",
			markedAt: NOW - 100,
			expiresAt: NOW + 60000,
		};
		expect(evaluate(data, data).backupAllowedAccountIds).toEqual([]);
		expect(evaluate(data, data, marker).backupAllowedAccountIds).toEqual([]);
	});
	it.each([
		"missing_weekly",
		"negative_headroom",
		"missing_reset",
		"expired_reset",
		"malformed_percent",
		"enabled_overage",
		"future_marker",
		"stale_marker",
		"future_usage",
		"inactive_family",
	])("reactive proof rejects %s", (kind) => {
		const data = usage(100);
		delete (data.data as unknown as TestUsageData).spend;
		const rows = (data.data as unknown as TestUsageData).limits;
		const marker = {
			evidence: {
				reason: "matching_scoped_limit" as const,
				authoritativeNativeRejection: true as const,
			},
			family: "fable",
			markedAt: NOW - 100,
			expiresAt: NOW + 60000,
		};
		if (kind === "missing_weekly") rows.splice(1, 1);
		if (kind === "negative_headroom") rows[0].percent = -1;
		if (kind === "missing_reset") rows[2].resets_at = null;
		if (kind === "expired_reset")
			rows[2].resets_at = new Date(NOW).toISOString();
		if (kind === "malformed_percent") rows[0].percent = NaN;
		if (kind === "enabled_overage")
			(data.data as unknown as TestUsageData).spend = { enabled: true };
		if (kind === "future_marker") marker.markedAt = NOW + 1;
		if (kind === "stale_marker") marker.markedAt = NOW - 180000;
		if (kind === "future_usage")
			(data as { observedAt: number }).observedAt = NOW + 1;
		if (kind === "inactive_family") rows[2].is_active = false;
		expect(evaluate(data, data, marker).backupAllowedAccountIds).toEqual([]);
	});
	it("generic or exact-model markers cannot stand in for family evidence", () => {
		const data = usage(100);
		delete (data.data as unknown as TestUsageData).spend;
		expect(
			evaluate(data, data, { markedAt: NOW - 100, expiresAt: NOW + 60000 })
				.backupAllowedAccountIds,
		).toEqual([]);
	});
	it("recovered newer snapshot and expired markers close the backup gate", () => {
		const marker = {
			evidence: {
				reason: "matching_scoped_limit" as const,
				authoritativeNativeRejection: true as const,
			},
			family: "fable",
			markedAt: NOW - 100,
			expiresAt: NOW + 60000,
		};
		expect(
			evaluate(usage(10, 20, false, NOW), usage(10, 20, false, NOW), marker)
				.backupAllowedAccountIds,
		).toEqual([]);
		const data = usage(100);
		delete (data.data as unknown as TestUsageData).spend;
		expect(
			evaluate(data, data, { ...marker, expiresAt: NOW })
				.backupAllowedAccountIds,
		).toEqual([]);
	});
	it("temporary cooldowns do not remove primary accounts while all-paused is structural", () => {
		const result = evaluateNativeQuotaPolicy(context(), {
			accounts: [account("a", { rate_limited_until: RESET }), account("b")],
			now: NOW,
			getSnapshot: () => usage(),
			getFamilyMarker: () => null,
		});
		expect(result.primaryAccountIds).toEqual(["a", "b"]);
		const paused = evaluateNativeQuotaPolicy(context(), {
			accounts: accounts.map((a) => ({ ...a, paused: true })),
			now: NOW,
			getSnapshot: () => usage(100),
			getFamilyMarker: () => null,
		});
		expect(paused.structuralError).toBeTruthy();
		expect(paused.wait).toBeNull();
	});
	it("admission rechecks physical model mappings from the current account snapshot", () => {
		const captured = createNativeQuotaContext({
			family: "fable",
			comboId: "combo",
			requestedModel: "claude-fable-5",
			members: [member("a", "claude-fable-5")],
			accounts: [
				account("a", {
					model_mappings: JSON.stringify({
						"claude-fable-5": "claude-fable-5-old",
					}),
				}),
			],
		});
		const result = evaluateNativeQuotaPolicy(captured, {
			now: NOW,
			accounts: [
				account("a", {
					model_mappings: JSON.stringify({
						"claude-fable-5": "claude-fable-5-new",
					}),
				}),
			],
			getSnapshot: () => usage(),
			getFamilyMarker: () => null,
		});
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5-old",
				candidateId: "a:claude-fable-5",
			}),
		).toBe(false);
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5-new",
				candidateId: "a:claude-fable-5",
			}),
		).toBe(true);
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5",
				physicalModel: "claude-opus-5",
			}),
		).toBe(false);
	});
	it("runtime native destination drift is structural instead of retryable quota", () => {
		const captured = context();
		const result = evaluateNativeQuotaPolicy(captured, {
			now: NOW,
			accounts: [
				account("a", { custom_endpoint: "https://example.invalid" }),
				account("b"),
			],
			getSnapshot: () => usage(100),
			getFamilyMarker: () => null,
		});
		expect(result.structuralError).toBeTruthy();
		expect(result.wait).toBeNull();
		expect(result.admittedCandidateIds).toEqual([]);
	});
});
