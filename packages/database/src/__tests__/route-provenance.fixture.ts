import type { RequestRoutingAttemptSummary } from "@better-ccflare/types";

// Shared by the SQLite/PostgreSQL column parity test, the SQLite freeze tests
// and the live PostgreSQL freeze test, so all three pin the same columns.
export const ROUTE_PROVENANCE_COLUMNS = [
	"route_profile_id",
	"requested_route_model",
	"routed_provider",
	"routed_model",
	"route_fallback_rung",
	"route_home_action",
	"route_repin_reason",
	"route_candidate_id",
] as const;

// Discovers provenance columns from a real schema by name. Filtering a schema
// through the pinned list above would hide a column added on one path only.
export function isRouteProvenanceColumn(column: string): boolean {
	return /^(?:route|routed|requested_route)_\w+$/.test(column);
}

// A terminal request with a routing attempt summary, the state in which the
// upsert freezes route provenance.
export const attemptSummary: RequestRoutingAttemptSummary = {
	version: 1,
	decision: {
		version: 1,
		requestedLogicalModel: "test-logical",
		operation: "messages",
		origin: "unknown",
		reason: "route_unavailable",
		evidence: "inferred",
		inventory: "complete",
		constraints: {
			forcedRoute: false,
			capabilityProfile: false,
			routeProfile: false,
			profileId: null,
			provider: null,
			physicalModel: null,
		},
		selection: null,
		stages: [],
	},
	decisionGap: null,
	physicalAttemptCount: 2,
	routeCount: 1,
	truncated: false,
	completeness: "complete",
	outputOriginOrdinal: null,
	winnerOrdinal: null,
	nativeStatus: 503,
	wireStatus: 200,
	terminalCause: "meaningful_progress_timeout",
	cancellationOrigin: null,
	attempts: [1, 2].map((ordinal) => ({
		ordinal,
		accountId: "test-account",
		provider: "codex",
		logicalModel: "test-logical",
		physicalModel: "test-physical",
		outcome: "failed",
		cause: "meaningful_progress_timeout",
		startedAt: null,
		outcomeObservedAt: null,
		nativeStatus: 200,
		protocolFrames: 79,
		meaningfulProgress: "absent",
		terminalEvidenceSeen: false,
	})),
};

export const attemptRequest = {
	id: "attempt-terminal",
	method: "POST",
	path: "/v1/messages",
	accountUsed: null,
	statusCode: 503,
	success: false,
	errorMessage: "meaningful_progress_timeout",
	responseTime: 100,
	failoverAttempts: 0,
};

export const provenanceA = {
	profileId: "profile-a",
	requestedModel: "requested-a",
	routedProvider: "provider-a",
	routedModel: "model-a",
	fallbackRung: "profile_root_model",
	homeAction: "repinned",
	repinReason: "route_circuit_open",
	candidateId: "candidate-a",
} as const;

export const provenanceB = {
	profileId: "profile-b",
	requestedModel: "requested-b",
	routedProvider: "provider-b",
	routedModel: "model-b",
	fallbackRung: "global_requested_model",
	homeAction: "initial_commit",
	repinReason: "hard_exclusion",
	candidateId: "candidate-b",
} as const;

export const expectedA = {
	route_profile_id: "profile-a",
	requested_route_model: "requested-a",
	routed_provider: "provider-a",
	routed_model: "model-a",
	route_fallback_rung: "profile_root_model",
	route_home_action: "repinned",
	route_repin_reason: "route_circuit_open",
	route_candidate_id: "candidate-a",
};

export const expectedB = {
	route_profile_id: "profile-b",
	requested_route_model: "requested-b",
	routed_provider: "provider-b",
	routed_model: "model-b",
	route_fallback_rung: "global_requested_model",
	route_home_action: "initial_commit",
	route_repin_reason: "hard_exclusion",
	route_candidate_id: "candidate-b",
};
