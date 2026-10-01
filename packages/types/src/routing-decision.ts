/** Bounded observational intent. These facts grant no dispatch/replay authority. */
export const MAX_ROUTING_DECISION_CHARS = 2048;
export const ROUTING_DECISION_REASONS = [
	"policy_excluded",
	"no_eligible_candidates",
	"all_unavailable",
	"selection_timeout",
	"inventory_failed",
	"model_pool_exhausted",
	"pool_exhausted",
	"predictive_throttle",
	"force_model_denied",
	"force_route_denied",
	"count_tokens_unsupported",
	"context_length_exceeded",
	"server_tool_denied",
	"route_unavailable",
	"unknown",
] as const;
export const ROUTING_SELECTION_STAGES = [
	"route_intent",
	"provider_constraint",
	"profile_constraint",
	"model_mapping",
	"implicit_policy",
	"capacity",
	"count_helper",
	"usage_throttle",
] as const;
export const ROUTING_EXCLUSION_REASONS = [
	"profile_only",
	"provider_excluded",
	"provider_mismatch",
	"model_mapping_mismatch",
	"catalog_role_unavailable",
	"catalog_role_mismatch",
	"policy_denied",
	"policy_unknown",
	"model_ineligible",
	"account_capacity",
	"model_capacity",
	"paused",
	"unavailable",
	"count_unsupported",
	"reactive_depletion",
	"predictive_throttle",
] as const;
export type RoutingDecisionReason = (typeof ROUTING_DECISION_REASONS)[number];
export type RoutingSelectionStage = (typeof ROUTING_SELECTION_STAGES)[number];
export type RoutingExclusionReason = (typeof ROUTING_EXCLUSION_REASONS)[number];
export interface RoutingSelectionStageEvidence {
	readonly stage: RoutingSelectionStage;
	/** Unique candidates observed at this stage; stages are never additive. */
	readonly observed: number | null;
	readonly excluded: number | null;
	readonly complete: boolean;
	readonly reasons: Partial<Record<RoutingExclusionReason, number>>;
}
export interface RoutingDecision {
	readonly version: 1;
	readonly requestedLogicalModel: string | null;
	readonly operation: "messages" | "count_tokens" | "other";
	readonly origin:
		| "trusted_auto_refresh"
		| "trusted_keepalive"
		| "trusted_helper"
		| "unknown";
	readonly reason: RoutingDecisionReason;
	readonly evidence: "exact" | "inferred" | "unknown";
	readonly inventory: "complete" | "failed" | "unknown";
	readonly constraints: {
		readonly forcedRoute: boolean;
		readonly capabilityProfile: boolean;
		readonly routeProfile: boolean;
		readonly profileId: string | null;
		readonly provider: string | null;
		readonly physicalModel: string | null;
	};
	readonly selection: {
		readonly mode: "off" | "observe" | "enforce";
		readonly structuralCandidateCount: number | null;
		readonly eligibleCandidateCount: number | null;
		readonly excludedCandidateCount: number | null;
		readonly selectedCandidateCount: number | null;
		readonly zeroAttemptReason:
			| "policy_excluded"
			| "no_eligible_candidates"
			| "all_unavailable"
			| "selection_timeout"
			| null;
	} | null;
	readonly stages: readonly RoutingSelectionStageEvidence[];
	readonly capacity?: {
		readonly observed: number | null;
		readonly missingSnapshot: number | null;
		readonly oldestSnapshotAgeMs: number | null;
		readonly earliestBlockerExpiryMs: number | null;
		readonly saturated: boolean;
	};
}
export type RoutingDecisionGap = "oversize" | "invalid";
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function identity(value: unknown): string | null {
	return typeof value === "string" &&
		value.length <= 128 &&
		/^[a-zA-Z0-9_.:/[\]@+-]+$/.test(value)
		? value
		: null;
}
function count(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 1_000_000
		? value
		: null;
}
/** Reads and writes share one privacy/budget boundary; legacy absent decision is unchanged. */
export function sanitizeRoutingDecision(value: unknown): {
	decision: RoutingDecision | null;
	gap: RoutingDecisionGap | null;
} {
	if (value == null) return { decision: null, gap: null };
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return { decision: null, gap: "invalid" };
	}
	if (encoded === undefined) return { decision: null, gap: "invalid" };
	if (encoded.length > MAX_ROUTING_DECISION_CHARS)
		return { decision: null, gap: "oversize" };
	const s = record(value);
	if (!s || s.version !== 1) return { decision: null, gap: "invalid" };
	const c = record(s.constraints) ?? {};
	const selection = record(s.selection);
	let invalid = false;
	if (
		!ROUTING_DECISION_REASONS.includes(s.reason as RoutingDecisionReason) ||
		!["messages", "count_tokens", "other"].includes(s.operation as string) ||
		![
			"trusted_auto_refresh",
			"trusted_keepalive",
			"trusted_helper",
			"unknown",
		].includes(s.origin as string) ||
		!["exact", "inferred", "unknown"].includes(s.evidence as string) ||
		!["complete", "failed", "unknown"].includes(s.inventory as string) ||
		!Array.isArray(s.stages) ||
		s.stages.length > ROUTING_SELECTION_STAGES.length
	)
		invalid = true;
	if (
		selection &&
		(!["off", "observe", "enforce"].includes(selection.mode as string) ||
			(selection.zeroAttemptReason !== null &&
				![
					"policy_excluded",
					"no_eligible_candidates",
					"all_unavailable",
					"selection_timeout",
				].includes(selection.zeroAttemptReason as string)))
	)
		invalid = true;

	const safeIdentity = (v: unknown) => {
		const result = identity(v);
		if (v != null && result === null) invalid = true;
		return result;
	};
	const safeCount = (v: unknown) => {
		const result = count(v);
		if (v != null && result === null) invalid = true;
		return result;
	};
	const stages: RoutingSelectionStageEvidence[] = [];
	const seen = new Set<string>();
	if (Array.isArray(s.stages))
		for (const raw of s.stages.slice(0, ROUTING_SELECTION_STAGES.length)) {
			const st = record(raw);
			if (
				!st ||
				!ROUTING_SELECTION_STAGES.includes(st.stage as RoutingSelectionStage) ||
				seen.has(st.stage as string)
			) {
				invalid = true;
				continue;
			}
			seen.add(st.stage as string);
			const reasons = record(st.reasons) ?? {};
			const bounded: Partial<Record<RoutingExclusionReason, number>> = {};
			for (const reason of ROUTING_EXCLUSION_REASONS)
				if (reasons[reason] != null) {
					const n = safeCount(reasons[reason]);
					if (n !== null) bounded[reason] = n;
				}
			const observed = safeCount(st.observed),
				excluded = safeCount(st.excluded);
			const partition = Object.values(bounded).reduce((a, b) => a + b, 0);
			const complete =
				st.complete === true &&
				observed !== null &&
				excluded !== null &&
				excluded <= observed &&
				partition === excluded;
			if (st.complete === true && !complete) invalid = true;
			stages.push({
				stage: st.stage as RoutingSelectionStage,
				observed,
				excluded,
				complete,
				reasons: bounded,
			});
		}
	const capacity = record(s.capacity);
	const millis = (v: unknown): number | null => {
		if (v == null) return null;
		if (
			typeof v === "number" &&
			Number.isSafeInteger(v) &&
			v >= 0 &&
			v <= 86_400_000
		)
			return v;
		invalid = true;
		return null;
	};
	const decision: RoutingDecision = {
		version: 1,
		requestedLogicalModel: safeIdentity(s.requestedLogicalModel),
		operation:
			s.operation === "messages" || s.operation === "count_tokens"
				? s.operation
				: "other",
		origin:
			s.origin === "trusted_auto_refresh" ||
			s.origin === "trusted_keepalive" ||
			s.origin === "trusted_helper"
				? s.origin
				: "unknown",
		reason: ROUTING_DECISION_REASONS.includes(s.reason as RoutingDecisionReason)
			? (s.reason as RoutingDecisionReason)
			: "unknown",
		evidence:
			s.evidence === "exact" || s.evidence === "inferred"
				? s.evidence
				: "unknown",
		inventory:
			s.inventory === "complete" || s.inventory === "failed"
				? s.inventory
				: "unknown",
		constraints: {
			forcedRoute: c.forcedRoute === true,
			capabilityProfile: c.capabilityProfile === true,
			routeProfile: c.routeProfile === true,
			profileId: safeIdentity(c.profileId),
			provider: safeIdentity(c.provider),
			physicalModel: safeIdentity(c.physicalModel),
		},
		selection: selection
			? {
					mode:
						selection.mode === "observe" || selection.mode === "enforce"
							? selection.mode
							: "off",
					structuralCandidateCount: safeCount(
						selection.structuralCandidateCount,
					),
					eligibleCandidateCount: safeCount(selection.eligibleCandidateCount),
					excludedCandidateCount: safeCount(selection.excludedCandidateCount),
					selectedCandidateCount: safeCount(selection.selectedCandidateCount),
					zeroAttemptReason: [
						"policy_excluded",
						"no_eligible_candidates",
						"all_unavailable",
						"selection_timeout",
					].includes(selection.zeroAttemptReason as string)
						? (selection.zeroAttemptReason as NonNullable<
								RoutingDecision["selection"]
							>["zeroAttemptReason"])
						: null,
				}
			: null,
		stages,
		...(capacity
			? {
					capacity: {
						observed: safeCount(capacity.observed),
						missingSnapshot: safeCount(capacity.missingSnapshot),
						oldestSnapshotAgeMs: millis(capacity.oldestSnapshotAgeMs),
						earliestBlockerExpiryMs: millis(capacity.earliestBlockerExpiryMs),
						saturated: capacity.saturated === true,
					},
				}
			: {}),
	};
	if (JSON.stringify(decision).length > MAX_ROUTING_DECISION_CHARS)
		return { decision: null, gap: "oversize" };
	return { decision, gap: invalid ? "invalid" : null };
}
