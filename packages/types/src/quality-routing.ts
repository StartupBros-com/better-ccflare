/** Quality routes are additive; they do not reinterpret claude-bccf-route-* IDs. */
export type QualityRootPreference = "auto" | "fable" | "astra" | "opus";
export type QualityWorkerRole =
	| "standard"
	| "lightweight"
	| "fable"
	| "astra"
	| "opus";
export type QualityLane =
	| Exclude<QualityRootPreference, "auto">
	| "standard"
	| "lightweight";
export type QualityPublicModelId =
	`claude-bccf-quality-${QualityRootPreference}`;
export type QualityPolicyRevision = `quality-policy-v1:${string}`;
/** Catalog changes do not constitute operator policy approval. */
export type QualityCatalogRevision = string;
export type QualityProvider = "anthropic" | "codex";
export type QualityApprovedLine =
	| "claude-fable"
	| "gpt-astra"
	| "claude-opus"
	| "gpt-sol"
	| "claude-sonnet"
	| "claude-haiku";

export interface QualityLineAssignment {
	readonly line: QualityApprovedLine;
	readonly lane: QualityLane;
	/** Lower first, within this lane only; ties use the stable line ID. */
	readonly priority: number;
	readonly upgrade: "exact-only" | "same-line-supported";
}

export interface QualityAccountEnrollment {
	readonly accountId: string;
	readonly provider: QualityProvider;
	readonly lines: readonly QualityApprovedLine[];
	/** Lower first within a lane; never promotes a line into another lane. */
	readonly priority: number;
}

export interface QualityPermittedFallback {
	readonly from: QualityLane;
	readonly to: QualityLane;
}

/** Only trusted operator configuration can create a grant. Provider flags cannot. */
export interface QualitySpendGrant {
	readonly accountId: string;
	readonly line: QualityApprovedLine;
	readonly authorization: "operator-approved";
	readonly scope: "outside-subscription";
}

/**
 * V1 accepts only the six initially approved named line/lane pairs. New lines
 * or cross-role assignments need a separately approved policy schema change.
 * Every field is explicit: no account discovery or implicit spend enrollment.
 */
export interface QualityRoutingPolicyConfig {
	readonly version: 1;
	readonly assignments: readonly QualityLineAssignment[];
	readonly accounts: readonly QualityAccountEnrollment[];
	readonly fallbacks: readonly QualityPermittedFallback[];
	readonly spendGrants: readonly QualitySpendGrant[];
}

export interface QualityRouteChoice {
	readonly preference: QualityRootPreference;
	readonly publicModelId: QualityPublicModelId;
	readonly displayName: string;
	readonly description: string;
}

/** Compilation is pure. A revision change is not a retry or home-change command. */
export interface QualityRoutingPolicy extends QualityRoutingPolicyConfig {
	readonly revision: QualityPolicyRevision;
	readonly choices: readonly QualityRouteChoice[];
	readonly lanes: Readonly<Record<QualityLane, readonly QualityApprovedLine[]>>;
	readonly mainLadders: Readonly<
		Record<QualityRootPreference, readonly QualityLane[]>
	>;
	readonly workerLanes: Readonly<
		Record<QualityWorkerRole, readonly QualityLane[]>
	>;
}

export interface QualitySuccessorTarget {
	readonly accountId: string;
	readonly line: QualityApprovedLine;
	readonly predecessorModel: string;
	readonly successorModel: string;
}

/**
 * Produced by the later evidence adapter, never by a name/rank heuristic.
 * Even release evidence must establish support on this enrolled account.
 * An approved successor does not evict a healthy exact predecessor home.
 */
export interface QualitySameLineEvidence extends QualitySuccessorTarget {
	readonly provider: QualityProvider;
	readonly source: "provider-catalog" | "authoritative-release";
	readonly catalogRevision: QualityCatalogRevision;
	readonly evidenceRef: string;
	readonly supported: boolean;
}

export type QualityRequestIntent =
	| Readonly<{ kind: "main"; preference: QualityRootPreference }>
	| Readonly<{ kind: "worker"; role: QualityWorkerRole }>;

export type QualityAdmissionReason =
	| "account-not-enrolled"
	| "line-not-approved"
	| "account-unavailable"
	| "model-unsupported"
	| "evidence-missing"
	| "context-unsupported"
	| "subscription-exhausted"
	| "spend-not-authorized"
	| "lane-unavailable";

/** Counts only: no prompt, secrets, arbitrary messages or raw quota payloads. */
export interface QualitySkippedLaneSummary {
	readonly lane: QualityLane;
	readonly reasons: Readonly<Partial<Record<QualityAdmissionReason, number>>>;
}

/** Ordered in attempted ladder order; at most the three main lanes. */
export type QualitySkippedLanes =
	| readonly []
	| readonly [QualitySkippedLaneSummary]
	| readonly [QualitySkippedLaneSummary, QualitySkippedLaneSummary]
	| readonly [
			QualitySkippedLaneSummary,
			QualitySkippedLaneSummary,
			QualitySkippedLaneSummary,
	  ];

/** Target and evidence are frozen together per attempt by the later dispatcher. */
export interface QualityPhysicalTarget {
	readonly accountId: string;
	readonly provider: QualityProvider;
	readonly lane: QualityLane;
	readonly line: QualityApprovedLine;
	readonly physicalModel: string;
	readonly catalogRevision: QualityCatalogRevision;
	readonly evidenceRef: string;
}

/** Dedicated provenance, distinct from upstream_evidence and legacy repin/rungs. */
export interface QualityDecisionEnvelope {
	readonly version: 1;
	readonly policyRevision: QualityPolicyRevision;
	readonly requested: QualityRequestIntent;
	readonly selected: QualityPhysicalTarget | null;
	readonly skippedLanes: QualitySkippedLanes;
}

/** Filled only after the control boundary verifies principal/session ownership. */
export interface QualityVerifiedSession {
	readonly verified: true;
	readonly principalId: string;
	readonly sessionId: string;
}

export type QualityControlRequest =
	| Readonly<{ action: "status"; session: QualityVerifiedSession }>
	| Readonly<{
			action: "retry";
			session: QualityVerifiedSession;
			incarnation: string;
			expectedIntentRevision: number;
			idempotencyToken: string;
	  }>;

/** Status/retry never performs inference or grants spend. Duplicates return the original outcome. */
export interface QualityControlOutcome {
	readonly status: "ready" | "unavailable" | "conflict";
	readonly incarnation: string;
	readonly intentRevision: number;
	readonly decision: QualityDecisionEnvelope | null;
}
