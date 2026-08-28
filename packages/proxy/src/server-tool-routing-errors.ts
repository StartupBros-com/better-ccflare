import type { ServerToolRoutingCapabilitySummary } from "@better-ccflare/types";

export type ServerToolRoutingErrorReason =
	| "invalid_requirement"
	| "unsupported_requirement"
	| "no_implementation"
	| "replay_unavailable"
	| "temporary_unavailable"
	| "forced_incapable";

export type ServerToolCandidateCapabilityFailureReason =
	| "candidate_binding_missing"
	| "candidate_binding_mismatch"
	| "provider_unavailable"
	| "tuple_unavailable"
	| "resolver_unavailable"
	| "resolver_invalid"
	| "capability_unproven"
	| "replay_unavailable"
	| "proof_mismatch"
	| "proof_drift";

interface ServerToolRoutingErrorOptions {
	readonly reason: ServerToolRoutingErrorReason;
	readonly accountId?: string;
	readonly capabilitySummary?: ServerToolRoutingCapabilitySummary;
	readonly requestedToolTypes?: readonly string[];
}

const ERROR_SPEC = Object.freeze({
	invalid_requirement: Object.freeze({
		status: 400,
		type: "invalid_request_error",
		code: "server_tool_invalid_requirement",
		message: "The requested server-tool options are invalid.",
	}),
	unsupported_requirement: Object.freeze({
		status: 400,
		type: "invalid_request_error",
		code: "server_tool_unsupported_requirement",
		message: "The requested server-tool semantics are not supported.",
	}),
	no_implementation: Object.freeze({
		status: 400,
		type: "invalid_request_error",
		code: "server_tool_capability_unavailable",
		message:
			"No configured provider route implements the requested server-tool semantics. This is a permanent capability gap in this proxy's account pool, not a transient failure - retrying cannot succeed until an operator adds a server-tool-capable route. Fall back to a client-side alternative tool instead of retrying.",
	}),
	replay_unavailable: Object.freeze({
		status: 503,
		type: "service_unavailable",
		code: "server_tool_replay_unavailable",
		message: "Server-tool replay configuration cannot satisfy this request.",
	}),
	temporary_unavailable: Object.freeze({
		status: 503,
		type: "service_unavailable",
		code: "route_unavailable",
		message:
			"Proven server-tool capacity is temporarily unavailable for this request.",
	}),
	forced_incapable: Object.freeze({
		status: 503,
		type: "force_route_unavailable",
		code: "server_tool_force_route_unavailable",
		message:
			"The force-routed account cannot satisfy the requested server-tool semantics.",
	}),
} as const satisfies Record<
	ServerToolRoutingErrorReason,
	{
		readonly status: number;
		readonly type: string;
		readonly code: string;
		readonly message: string;
	}
>);

function snapshotCapabilitySummary(
	summary: ServerToolRoutingCapabilitySummary | undefined,
): ServerToolRoutingCapabilitySummary | undefined {
	if (!summary) return undefined;
	return Object.freeze({
		structuralCandidateCount: summary.structuralCandidateCount,
		provenCandidateCount: summary.provenCandidateCount,
		unsupportedCandidateCount: summary.unsupportedCandidateCount,
		unknownCandidateCount: summary.unknownCandidateCount,
		replayIneligibleCandidateCount: summary.replayIneligibleCandidateCount,
		temporarilyUnavailableProvenCandidateCount:
			summary.temporarilyUnavailableProvenCandidateCount,
		eligibleCandidateCount: summary.eligibleCandidateCount,
	});
}

function snapshotRequestedToolTypes(
	requestedToolTypes: readonly string[] | undefined,
): readonly string[] | undefined {
	const deduped = Array.from(
		new Set(requestedToolTypes?.filter((toolType) => toolType !== "") ?? []),
	);
	return deduped.length > 0 ? Object.freeze(deduped) : undefined;
}

/** Typed, request-local capability terminal. It never mutates route/account state. */
export class ServerToolRoutingError extends Error {
	readonly reason: ServerToolRoutingErrorReason;
	readonly accountId: string | undefined;
	readonly capabilitySummary: ServerToolRoutingCapabilitySummary | undefined;
	readonly requestedToolTypes: readonly string[] | undefined;

	constructor(options: ServerToolRoutingErrorOptions) {
		const spec = ERROR_SPEC[options.reason];
		const requestedToolTypes = snapshotRequestedToolTypes(
			options.requestedToolTypes,
		);
		super(
			requestedToolTypes
				? `${spec.message} Requested server tool(s): ${requestedToolTypes.join(", ")}.`
				: spec.message,
		);
		this.name = "ServerToolRoutingError";
		this.reason = options.reason;
		this.accountId = options.accountId;
		this.capabilitySummary = snapshotCapabilitySummary(
			options.capabilitySummary,
		);
		this.requestedToolTypes = requestedToolTypes;
	}
}

/**
 * Internal request-local signal for one candidate whose exact proof cannot be
 * honored. The request orchestrator may continue to a sibling proven route;
 * this signal is never serialized directly.
 */
export class ServerToolCandidateCapabilityError extends Error {
	readonly accountId: string;
	readonly candidateId: string;
	readonly reason: ServerToolCandidateCapabilityFailureReason;

	constructor(options: {
		readonly accountId: string;
		readonly candidateId: string;
		readonly reason: ServerToolCandidateCapabilityFailureReason;
	}) {
		super(
			"Server-tool capability proof is no longer valid for this candidate.",
		);
		this.name = "ServerToolCandidateCapabilityError";
		this.accountId = options.accountId;
		this.candidateId = options.candidateId;
		this.reason = options.reason;
	}
}

/** Serialize the stable Anthropic-compatible machine-readable local terminal. */
export function createServerToolRoutingErrorResponse(
	error: ServerToolRoutingError,
): Response {
	const spec = ERROR_SPEC[error.reason];
	const bodyError: Record<string, unknown> = {
		type: spec.type,
		code: spec.code,
		reason: error.reason,
		message: error.message,
	};
	if (error.accountId !== undefined) bodyError.account_id = error.accountId;
	if (error.requestedToolTypes !== undefined) {
		bodyError.requested_tools = error.requestedToolTypes;
	}
	if (error.capabilitySummary !== undefined) {
		bodyError.capability = error.capabilitySummary;
	}
	const headers = new Headers({ "content-type": "application/json" });
	if (error.reason === "forced_incapable") {
		headers.set("x-better-ccflare-force-route", "unavailable");
	}
	return new Response(
		JSON.stringify({
			type: "error",
			error: bodyError,
		}),
		{ status: spec.status, headers },
	);
}
