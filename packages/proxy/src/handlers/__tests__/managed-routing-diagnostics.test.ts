import { describe, expect, it } from "bun:test";
import type { ComboMembershipResolution } from "@better-ccflare/types";
import { buildComboMembershipDiagnostics } from "../managed-routing-diagnostics";

const ALLOWED_DIAGNOSTIC_KEYS = [
	"active",
	"comboId",
	"eligibleCandidateCount",
	"family",
	"memberCount",
	"membershipMode",
	"reasonCounts",
	"selectedSource",
	"selectedTier",
	"sourceCounts",
].sort();

const FORBIDDEN_DIAGNOSTIC_FRAGMENTS = [
	"account-secret-id",
	"Secret Account Name",
	"https://private.example.test/v1",
	"vendor/private-custom-model",
	"private-model-mapping",
	"do not log this prompt",
	"credential-secret",
	"candidate-secret-id",
	"slot-secret-id",
	"rule-secret-id",
];

function secretLadenResolution(): ComboMembershipResolution {
	return {
		family: "opus",
		combo_id: "combo-visible",
		active: true,
		reason: "included",
		members: [
			{
				id: "candidate-secret-id",
				account_id: "account-secret-id-1",
				combo_id: "combo-visible",
				family: "opus",
				included: true,
				logical_model: "vendor/private-custom-model",
				tier: 4,
				source: "managed",
				reason: "included",
				slot_id: "slot-secret-id",
				rule_id: "rule-secret-id",
				accountName: "Secret Account Name",
				endpoint: "https://private.example.test/v1",
				modelMappings: { opus: "private-model-mapping" },
				prompt: "do not log this prompt",
				apiKey: "credential-secret",
			},
			{
				id: "candidate-secret-id-2",
				account_id: "account-secret-id-2",
				combo_id: "combo-visible",
				family: "opus",
				included: true,
				logical_model: "vendor/private-custom-model-2",
				tier: 8,
				source: "manual",
				reason: "manual_override",
				slot_id: "slot-secret-id-2",
				rule_id: null,
				refreshToken: "credential-secret-2",
			},
		],
		decisions: [
			{
				account_id: "account-secret-id-1",
				combo_id: "combo-visible",
				family: "opus",
				included: true,
				logical_model: "vendor/private-custom-model",
				tier: 4,
				source: "managed",
				reason: "included",
				slot_id: "slot-secret-id",
				rule_id: "rule-secret-id",
			},
			{
				account_id: "account-secret-id-2",
				combo_id: "combo-visible",
				family: "opus",
				included: true,
				logical_model: "vendor/private-custom-model-2",
				tier: 8,
				source: "manual",
				reason: "manual_override",
				slot_id: "slot-secret-id-2",
				rule_id: null,
			},
			{
				account_id: "account-secret-id-3",
				combo_id: "combo-visible",
				family: "opus",
				included: false,
				logical_model: null,
				tier: null,
				source: null,
				reason: "excluded",
				slot_id: null,
				rule_id: null,
			},
		],
		accountName: "Secret Account Name",
		endpoint: "https://private.example.test/v1",
		credentials: "credential-secret",
	} as unknown as ComboMembershipResolution;
}

function expectAggregateOnly(payload: object): void {
	expect(Object.keys(payload).sort()).toEqual(ALLOWED_DIAGNOSTIC_KEYS);
	const serialized = JSON.stringify(payload);
	for (const forbidden of FORBIDDEN_DIAGNOSTIC_FRAGMENTS) {
		expect(serialized).not.toContain(forbidden);
	}
}

describe("managed routing membership diagnostics", () => {
	it("emits only aggregate fields for a selected candidate", () => {
		const payload = buildComboMembershipDiagnostics(
			secretLadenResolution(),
			"managed",
			{ source: "managed", tier: 4, eligibleCandidateCount: 2 },
		);

		expect(payload).toEqual({
			family: "opus",
			comboId: "combo-visible",
			active: true,
			membershipMode: "managed",
			memberCount: 2,
			sourceCounts: { manual: 1, managed: 1 },
			reasonCounts: { included: 1, manual_override: 1, excluded: 1 },
			selectedSource: "managed",
			selectedTier: 4,
			eligibleCandidateCount: 2,
		});
		expectAggregateOnly(payload);
	});

	it("uses the same aggregate-only shape when no candidate is selected", () => {
		const payload = buildComboMembershipDiagnostics(
			secretLadenResolution(),
			"managed",
			null,
		);

		expect(payload.selectedSource).toBeNull();
		expect(payload.selectedTier).toBeNull();
		expect(payload.eligibleCandidateCount).toBe(0);
		expect(payload.sourceCounts).toEqual({ manual: 1, managed: 1 });
		expect(payload.reasonCounts).toEqual({
			included: 1,
			manual_override: 1,
			excluded: 1,
		});
		expectAggregateOnly(payload);
	});
});
