import { describe, expect, it } from "bun:test";
import type { UsageSnapshot } from "@better-ccflare/providers";
import type { Account, EffectiveComboMember } from "@better-ccflare/types";
import {
	createNativeQuotaContext,
	evaluateNativeQuotaPolicy,
	isNativeQuotaCandidateAdmitted,
} from "../native-quota-policy";
import {
	classifyPreByte429,
	nativeFamilyRejectionEvidence,
} from "../rate-limit-scope";

const now = 1_800_000_000_000;
const reset = now + 120_000;
const account = {
	id: "a",
	provider: "anthropic",
	refresh_token: "offline",
	api_key: null,
	paused: false,
	billing_type: "plan",
	custom_endpoint: null,
	model_mappings: null,
	model_fallbacks: null,
} as Account;
const members = [
	{ id: "primary", account_id: "a", logical_model: "claude-fable-5", tier: 0 },
	{ id: "backup", account_id: "a", logical_model: "claude-opus-5", tier: 10 },
] as EffectiveComboMember[];
const context = () =>
	createNativeQuotaContext({
		family: "fable",
		comboId: "combo",
		requestedModel: "claude-fable-5",
		accounts: [account],
		members,
	});
const snapshot = (isActive: unknown = true, percent = 100): UsageSnapshot =>
	({
		observedAt: now - 1000,
		data: {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					is_active: isActive,
					resets_at: new Date(reset).toISOString(),
					scope: { model: { id: "claude-fable-5" } },
				},
			],
		},
	}) as UsageSnapshot;

describe("native quota strict evidence boundaries", () => {
	it.each([
		{ id: "opus", display_name: "Fable" },
		{ id: "vendor-fable-custom" },
	])("ambiguous or noncanonical family identity %j cannot prove exhaustion", (model) => {
		const data = {
			observedAt: now,
			data: {
				spend: { enabled: false },
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						is_active: true,
						resets_at: new Date(reset).toISOString(),
						scope: { model },
					},
				],
			},
		} as UsageSnapshot;
		expect(
			evaluateNativeQuotaPolicy(context(), {
				now,
				getSnapshot: () => data,
				getFamilyMarker: () => null,
			}).backupAllowedAccountIds,
		).toEqual([]);
	});
	it("windowless family markers cannot authorize missing-overage backup, but native rejection can", () => {
		const data = {
			observedAt: now - 1000,
			data: {
				limits: [
					{
						kind: "session",
						percent: 20,
						resets_at: new Date(reset).toISOString(),
						is_active: true,
					},
					{
						kind: "weekly_all",
						percent: 30,
						resets_at: new Date(reset).toISOString(),
						is_active: true,
					},
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: new Date(reset).toISOString(),
						is_active: true,
						scope: { model: { id: "claude-fable-5" } },
					},
				],
			},
		} as UsageSnapshot;
		const marker = { family: "fable", markedAt: now, expiresAt: now + 60000 };
		const evaluate = (evidence?: {
			reason: "matching_scoped_limit";
			authoritativeNativeRejection: true;
		}) =>
			evaluateNativeQuotaPolicy(context(), {
				now,
				getSnapshot: () => data,
				getFamilyMarker: () => ({
					...marker,
					...(evidence ? { evidence } : {}),
				}),
			});
		expect(evaluate().backupAllowedAccountIds).toEqual([]);
		expect(
			evaluate({
				reason: "matching_scoped_limit",
				authoritativeNativeRejection: true,
			}).backupAllowedAccountIds,
		).toEqual(["a"]);
	});
	it.each([
		"false",
		0,
		1,
		{},
	])("malformed activity flag %s cannot authorize backup", (isActive) => {
		const result = evaluateNativeQuotaPolicy(context(), {
			now,
			getSnapshot: () => snapshot(isActive),
			getFamilyMarker: () => null,
		});
		expect(result.backupAllowedAccountIds).toEqual([]);
	});
	it("physical admission uses the freshly revalidated account mapping", () => {
		const captured = context();
		const updated = {
			...account,
			model_mappings: '{"fable":"claude-fable-5-1"}',
		};
		const result = evaluateNativeQuotaPolicy(captured, {
			accounts: [updated],
			now,
			getSnapshot: () => snapshot(true, 30),
			getFamilyMarker: () => null,
		});
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5",
				candidateId: "primary",
				physicalModel: "claude-fable-5",
			}),
		).toBe(false);
		expect(
			isNativeQuotaCandidateAdmitted(captured, result, {
				accountId: "a",
				model: "claude-fable-5-1",
				candidateId: "primary",
				physicalModel: "claude-fable-5-1",
			}),
		).toBe(true);
	});
	it("a rollover invalidates proof exactly at reset and readmits Fable", () => {
		const captured = context();
		const options = {
			getSnapshot: () => snapshot(),
			getFamilyMarker: () => null,
		};
		const before = evaluateNativeQuotaPolicy(captured, {
			...options,
			now: reset - 1,
		});
		expect(before.backupAllowedAccountIds).toEqual(["a"]);
		const after = evaluateNativeQuotaPolicy(captured, {
			...options,
			now: reset,
		});
		expect(after.backupAllowedAccountIds).toEqual([]);
		expect(after.admittedCandidateIds).toEqual(["primary"]);
	});
	it("unknown reset is separate from the finite next recheck", () => {
		const data = {
			observedAt: now,
			data: { limits: [{ kind: "session", percent: 100, resets_at: null }] },
		} as UsageSnapshot;
		const result = evaluateNativeQuotaPolicy(context(), {
			now,
			getSnapshot: () => data,
			getFamilyMarker: () => null,
		});
		expect(result.wait).toMatchObject({
			kind: "quota_wait",
			reason: "shared_capacity",
			resetAt: null,
			nextRecheckAt: now + 60_000,
		});
	});
	it("runtime route edits fail closed for newly foreign endpoints", () => {
		const result = evaluateNativeQuotaPolicy(context(), {
			accounts: [{ ...account, custom_endpoint: "https://offline.invalid" }],
			now,
			getSnapshot: () => snapshot(),
			getFamilyMarker: () => null,
		});
		expect(result.structuralError).not.toBeNull();
		expect(result.wait).toBeNull();
		expect(result.admittedCandidateIds).toEqual([]);
	});
});

/** Captured Anthropic layout: only the binding scoped limit is active. */
function mixedUsage() {
	return {
		observedAt: now - 1000,
		data: {
			five_hour: { utilization: 20, resets_at: new Date(reset).toISOString() },
			seven_day: { utilization: 30, resets_at: new Date(reset).toISOString() },
			limits: [
				{
					kind: "session",
					percent: 20,
					is_active: false,
					resets_at: new Date(reset).toISOString(),
				},
				{
					kind: "weekly_all",
					percent: 30,
					is_active: false,
					resets_at: new Date(reset).toISOString(),
				},
				{
					kind: "weekly_scoped",
					percent: 100,
					is_active: true,
					resets_at: new Date(reset).toISOString(),
					scope: { model: { id: "fable", display_name: "Fable" } },
				},
			],
		},
	};
}
function evaluateReactiveHeadroom(data: UsageSnapshot) {
	return evaluateNativeQuotaPolicy(context(), {
		now,
		getSnapshot: () => data,
		getFamilyMarker: () => ({
			family: "fable",
			markedAt: now - 1000,
			expiresAt: now + 60_000,
			evidence: {
				reason: "matching_scoped_limit",
				authoritativeNativeRejection: true,
			},
		}),
	});
}

describe("native reactive headroom for mixed Anthropic usage", () => {
	it("supplements inactive generic windows from affirmative flat account headroom", () => {
		const result = evaluateReactiveHeadroom(mixedUsage() as UsageSnapshot);
		expect(result.backupAllowedAccountIds).toEqual(["a"]);
		expect(result.admittedCandidateIds).toEqual(["backup"]);
		expect(result.familyProofs.get("a")?.source).toBe("reactive_family");
	});

	it("accepts flat headroom when generic limit rows are absent", () => {
		const snapshot = mixedUsage();
		snapshot.data.limits = snapshot.data.limits.filter(
			(row) => row.kind === "weekly_scoped",
		);
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual(["a"]);
	});
	it("ignores invalid inactive generic rows when flat windows prove headroom", () => {
		const snapshot = mixedUsage();
		Object.assign(snapshot.data.limits[0], { percent: null, resets_at: null });
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual(["a"]);
	});

	it.each([
		"session",
		"weekly_all",
	])("active %s headroom takes precedence over its flat window", (kind) => {
		const snapshot = mixedUsage();
		const index = kind === "session" ? 0 : 1;
		Object.assign(snapshot.data.limits[index], { is_active: true });
		snapshot.data[kind === "session" ? "five_hour" : "seven_day"].utilization =
			100;
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual(["a"]);
	});
	it.each([
		{ percent: null },
		{ percent: undefined },
		{ percent: "20" },
		{ percent: Number.NaN },
		{ percent: Number.POSITIVE_INFINITY },
		{ percent: -1 },
		{ percent: 100 },
		{ resets_at: null },
		{ resets_at: "invalid" },
		{ resets_at: new Date(now).toISOString() },
		{ resets_at: new Date(now - 1000).toISOString() },
	])("active invalid account evidence %j cannot be replaced by optimistic flat headroom", (patch) => {
		for (const index of [0, 1]) {
			const snapshot = mixedUsage();
			Object.assign(snapshot.data.limits[index], patch, { is_active: true });
			expect(
				evaluateReactiveHeadroom(snapshot as UsageSnapshot)
					.backupAllowedAccountIds,
			).toEqual([]);
		}
	});
	it("a conflicting active duplicate cannot disappear behind a usable account row", () => {
		const snapshot = mixedUsage();
		Object.assign(snapshot.data.limits[0], { is_active: true });
		snapshot.data.limits.push({
			...snapshot.data.limits[0],
			percent: Number.NaN,
		});
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual([]);
	});
	it.each([
		{ utilization: null },
		{ utilization: undefined },
		{ utilization: "20" },
		{ utilization: Number.NaN },
		{ utilization: Number.POSITIVE_INFINITY },
		{ utilization: -1 },
		{ utilization: 100 },
		{ resets_at: null },
		{ resets_at: undefined },
		{ resets_at: "invalid" },
		{ resets_at: new Date(now).toISOString() },
		{ resets_at: new Date(now - 1000).toISOString() },
	])("invalid flat account evidence %j cannot prove reactive headroom", (patch) => {
		for (const key of ["five_hour", "seven_day"] as const) {
			const snapshot = mixedUsage();
			Object.assign(snapshot.data[key], patch);
			expect(
				evaluateReactiveHeadroom(snapshot as UsageSnapshot)
					.backupAllowedAccountIds,
			).toEqual([]);
		}
	});
	it.each([
		null,
		undefined,
	])("inactive-only account windows without flat evidence (%s) cannot prove headroom", (value) => {
		const snapshot = mixedUsage();
		Object.assign(snapshot.data, { five_hour: value, seven_day: value });
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual([]);
	});
	it.each([
		now - 180_000,
		now + 1,
		Number.NaN,
	])("snapshot time %s cannot prove current headroom", (observedAt) => {
		const snapshot = mixedUsage();
		snapshot.observedAt = observedAt;
		expect(
			evaluateReactiveHeadroom(snapshot as UsageSnapshot)
				.backupAllowedAccountIds,
		).toEqual([]);
	});
	it.each([
		"allowed",
		"allowed_warning",
		"rejected",
	])("scoped %s response with future reset preserves the native proof boundary", (status) => {
		const snapshot = mixedUsage() as UsageSnapshot;
		const response = new Response(null, {
			status: 429,
			headers: {
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
				"anthropic-ratelimit-unified-7d-status": status,
				"anthropic-ratelimit-unified-7d-reset": String(reset / 1000),
			},
		});
		const decision = classifyPreByte429({
			isAnthropic: true,
			response,
			attemptedModel: "claude-fable-5",
			snapshot,
			now,
		});
		expect(decision.scope).toBe("family");
		const evidence = nativeFamilyRejectionEvidence(response, decision);
		const result = evaluateNativeQuotaPolicy(context(), {
			now,
			getSnapshot: () => snapshot,
			getFamilyMarker: () => ({
				family: "fable",
				markedAt: now,
				expiresAt: decision.markerExpiresAt ?? now,
				evidence,
			}),
		});
		expect(result.backupAllowedAccountIds).toEqual(
			status === "rejected" ? ["a"] : [],
		);
	});
});
