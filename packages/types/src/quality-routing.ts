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
	/** Shown in /v1/models discovery. An unlisted id still resolves for saved defaults. */
	readonly listed: boolean;
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
	| "lane-unavailable"
	| "provider-capacity-exhausted"
	| "capacity-evidence-unknown"
	| "billing-evidence-unknown"
	| "catalog-evidence-stale"
	| "credential-evidence-unknown"
	| "input-accounting-unknown"
	| "output-unsupported"
	| "modality-unsupported"
	| "tools-unsupported"
	| "request-preservation-unknown";

/** Safe bounded diagnostics; never contains raw requests or provider payloads. */
export type QualityAdmissionDecision = (
	| Readonly<{ status: "admit" }>
	| Readonly<{ status: "reject" | "unknown"; reason: QualityAdmissionReason }>
) &
	Readonly<{
		accounting?: {
			/**
			 * local-envelope-v1 (before #429): UTF-8 bytes of the whole final envelope,
			 * 25% plus 1024 headroom, the caller's full reserve. stock-codex-estimate-v1:
			 * stock Codex admission's estimate of the original request, no headroom,
			 * and the reserve the wire carries. Persisted rows keep their label.
			 */
			readonly source: "local-envelope-v1" | "stock-codex-estimate-v1";
			readonly kind: "estimate";
			/** Bytes of the final envelope (local-envelope-v1) or the original request. */
			readonly envelopeBytes: number;
			readonly inputEstimate: number;
			readonly headroom: number;
			/** Output reserved for the estimated fit; not a wire-enforced Codex subscription cap. */
			readonly requestedOutput: number;
			/** Model ceiling metadata, not a per-request cap; null delegates acceptance/length to the provider. */
			readonly outputLimit?:
				| Readonly<{ kind: "provider-managed"; tokens: null }>
				| Readonly<{ kind: "catalog"; tokens: number }>;
		};
	}>;

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

/** Durable diagnostics only; catalog/evidence references never cross this boundary. */
export interface QualityDecisionRecord
	extends Omit<QualityDecisionEnvelope, "selected"> {
	readonly selected: Pick<
		QualityPhysicalTarget,
		"accountId" | "provider" | "lane" | "line" | "physicalModel"
	> | null;
	readonly accounting?: QualityAdmissionDecision["accounting"];
}

const QUALITY_LANES = ["fable", "astra", "opus", "standard", "lightweight"];
const QUALITY_LINES = [
	"claude-fable",
	"gpt-astra",
	"claude-opus",
	"gpt-sol",
	"claude-sonnet",
	"claude-haiku",
];
const QUALITY_REASONS = [
	"account-not-enrolled",
	"line-not-approved",
	"account-unavailable",
	"model-unsupported",
	"evidence-missing",
	"context-unsupported",
	"subscription-exhausted",
	"spend-not-authorized",
	"lane-unavailable",
	"provider-capacity-exhausted",
	"capacity-evidence-unknown",
	"billing-evidence-unknown",
	"catalog-evidence-stale",
	"credential-evidence-unknown",
	"input-accounting-unknown",
	"output-unsupported",
	"modality-unsupported",
	"tools-unsupported",
	"request-preservation-unknown",
];
function qualityObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function qualityKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function qualityEnum(
	value: unknown,
	allowed: readonly string[],
): value is string {
	return typeof value === "string" && allowed.includes(value);
}
function qualityId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
	);
}
/** 8KiB JSON, 3 ordered lanes, 19 enumerated reasons/lane, counts <= 1e6.
 * Reject unknown fields/enums and invalid scalars; return a fresh allowlisted value.
 * References on an internal target are accepted only to discard them. Never route on this data.
 */
export function sanitizeQualityDecision(
	raw: unknown,
): QualityDecisionRecord | null {
	try {
		const json = typeof raw === "string" ? raw : JSON.stringify(raw);
		if (
			!json ||
			json.length > 8192 ||
			new TextEncoder().encode(json).length > 8192
		)
			return null;
		const value: unknown = JSON.parse(json);
		if (
			!qualityObject(value) ||
			!qualityKeys(value, [
				"version",
				"policyRevision",
				"requested",
				"selected",
				"skippedLanes",
				"accounting",
			]) ||
			value.version !== 1 ||
			!qualityId(value.policyRevision) ||
			!value.policyRevision.startsWith("quality-policy-v1:")
		)
			return null;
		const requested = value.requested;
		if (!qualityObject(requested)) return null;
		if (requested.kind === "main") {
			if (
				!qualityKeys(requested, ["kind", "preference"]) ||
				!qualityEnum(requested.preference, ["auto", "fable", "astra", "opus"])
			)
				return null;
		} else if (requested.kind === "worker") {
			if (
				!qualityKeys(requested, ["kind", "role"]) ||
				!qualityEnum(requested.role, QUALITY_LANES)
			)
				return null;
		} else return null;
		let selected: QualityDecisionRecord["selected"] = null;
		if (value.selected !== null) {
			const target = value.selected;
			if (
				!qualityObject(target) ||
				!qualityKeys(target, [
					"accountId",
					"provider",
					"lane",
					"line",
					"physicalModel",
					"catalogRevision",
					"evidenceRef",
				]) ||
				!qualityId(target.accountId) ||
				!qualityId(target.physicalModel) ||
				!qualityEnum(target.provider, ["anthropic", "codex"]) ||
				!qualityEnum(target.lane, QUALITY_LANES) ||
				!qualityEnum(target.line, QUALITY_LINES)
			)
				return null;
			selected = {
				accountId: target.accountId,
				physicalModel: target.physicalModel,
				provider: target.provider as QualityProvider,
				lane: target.lane as QualityLane,
				line: target.line as QualityApprovedLine,
			};
		}
		if (!Array.isArray(value.skippedLanes) || value.skippedLanes.length > 3)
			return null;
		const skipped: QualitySkippedLaneSummary[] = [];
		for (const entry of value.skippedLanes) {
			if (
				!qualityObject(entry) ||
				!qualityKeys(entry, ["lane", "reasons"]) ||
				!qualityEnum(entry.lane, QUALITY_LANES) ||
				!qualityObject(entry.reasons) ||
				!qualityKeys(entry.reasons, QUALITY_REASONS)
			)
				return null;
			const reasons: Partial<Record<QualityAdmissionReason, number>> = {};
			for (const [reason, count] of Object.entries(entry.reasons)) {
				if (
					typeof count !== "number" ||
					!Number.isSafeInteger(count) ||
					count < 1 ||
					count > 1_000_000
				)
					return null;
				reasons[reason as QualityAdmissionReason] = count;
			}
			skipped.push({ lane: entry.lane as QualityLane, reasons });
		}
		let accounting: QualityDecisionRecord["accounting"];
		if (value.accounting !== undefined) {
			const a = value.accounting;
			const numbers = [
				"envelopeBytes",
				"inputEstimate",
				"headroom",
				"requestedOutput",
			] as const;
			if (
				!qualityObject(a) ||
				!qualityKeys(a, ["source", "kind", "outputLimit", ...numbers]) ||
				(a.source !== "local-envelope-v1" &&
					a.source !== "stock-codex-estimate-v1") ||
				a.kind !== "estimate" ||
				numbers.some(
					(key) =>
						typeof a[key] !== "number" ||
						!Number.isSafeInteger(a[key]) ||
						Number(a[key]) < 0 ||
						Number(a[key]) > 1_000_000_000,
				)
			)
				return null;
			let outputLimit: NonNullable<
				QualityDecisionRecord["accounting"]
			>["outputLimit"];
			if (a.outputLimit !== undefined) {
				const limit = a.outputLimit;
				if (!qualityObject(limit) || !qualityKeys(limit, ["kind", "tokens"]))
					return null;
				if (limit.kind === "provider-managed" && limit.tokens === null) {
					outputLimit = { kind: "provider-managed", tokens: null };
				} else if (
					limit.kind === "catalog" &&
					typeof limit.tokens === "number" &&
					Number.isSafeInteger(limit.tokens) &&
					limit.tokens > 0
				) {
					outputLimit = { kind: "catalog", tokens: limit.tokens };
				} else return null;
			}
			accounting = {
				source:
					a.source === "local-envelope-v1"
						? "local-envelope-v1"
						: "stock-codex-estimate-v1",
				kind: "estimate",
				envelopeBytes: Number(a.envelopeBytes),
				inputEstimate: Number(a.inputEstimate),
				headroom: Number(a.headroom),
				requestedOutput: Number(a.requestedOutput),
				...(outputLimit ? { outputLimit } : {}),
			};
		}
		return {
			version: 1,
			policyRevision: value.policyRevision as QualityPolicyRevision,
			requested: requested as unknown as QualityRequestIntent,
			selected,
			skippedLanes: skipped as unknown as QualitySkippedLanes,
			...(accounting ? { accounting } : {}),
		};
	} catch {
		return null;
	}
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
