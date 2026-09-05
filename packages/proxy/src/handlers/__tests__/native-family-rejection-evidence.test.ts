import { describe, expect, it } from "bun:test";
import {
	nativeFamilyRejectionEvidence,
	type RateLimitScopeDecision,
} from "../rate-limit-scope";

const now = 1_800_000_000_000;
const decision: RateLimitScopeDecision = {
	scope: "family",
	family: "fable",
	attemptedModel: "claude-fable-5",
	reason: "matching_scoped_limit",
	markerExpiresAt: now + 60000,
	snapshotAgeMs: 1000,
	accountWindowResetAt: null,
};

describe("native family rejection evidence", () => {
	it.each([
		{ "anthropic-ratelimit-unified-status": "rejected" },
		{ "anthropic-ratelimit-unified-7d-status": "rate_limited" },
		{
			"anthropic-ratelimit-unified-7d-status": "rejected",
			"anthropic-ratelimit-unified-7d-reset": String((now + 60000) / 1000),
		},
	])("native limiter signal %j supplies trusted provenance", (headers) => {
		expect(
			nativeFamilyRejectionEvidence(
				new Response(null, { status: 429, headers }),
				decision,
			),
		).toEqual({
			reason: "matching_scoped_limit",
			authoritativeNativeRejection: true,
		});
	});
	it.each([
		{},
		{ "retry-after": "60" },
		{ "x-ratelimit-reset": String((now + 60000) / 1000) },
		{ "anthropic-ratelimit-unified-status": "allowed" },
		{ "anthropic-ratelimit-unified-reset": String((now + 60000) / 1000) },
		{
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-7d-reset": String((now + 60000) / 1000),
		},
		{
			"anthropic-ratelimit-unified-7d-status": "allowed_warning",
			"anthropic-ratelimit-unified-7d-reset": String((now + 60000) / 1000),
		},
		{
			"anthropic-ratelimit-unified-status": "allowed_warning",
			"anthropic-ratelimit-unified-7d-status": "rejected",
			"anthropic-ratelimit-unified-7d-reset": String((now + 60000) / 1000),
		},
		{
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-reset": String((now + 60000) / 1000),
		},
		{ "anthropic-ratelimit-unified-reset": "invalid" },
		{ "anthropic-ratelimit-unified-reset": String((now - 1) / 1000) },
		{ "anthropic-ratelimit-unified-status": "payment_required" },
		{
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		},
		{ "anthropic-ratelimit-unified-spend-status": "rejected" },
	])("generic, windowless or billing signal %j cannot authorize Opus", (headers) => {
		expect(
			nativeFamilyRejectionEvidence(
				new Response(null, { status: 429, headers }),
				decision,
			),
		).toBeUndefined();
	});
	it.each([
		400, 404, 529,
	])("status%s is not a family quota rejection", (status) => {
		expect(
			nativeFamilyRejectionEvidence(
				new Response(null, {
					status,
					headers: { "anthropic-ratelimit-unified-status": "rejected" },
				}),
				decision,
			),
		).toBeUndefined();
	});
	it("affirmative family scope is required in addition to native headers", () => {
		expect(
			nativeFamilyRejectionEvidence(
				new Response(null, {
					status: 429,
					headers: { "anthropic-ratelimit-unified-status": "rejected" },
				}),
				{ ...decision, scope: "model", reason: "missing_usage" },
			),
		).toBeUndefined();
	});
});
