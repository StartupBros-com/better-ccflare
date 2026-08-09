/** One independently supported replay representation at provider capability seams. */
export type ServerToolReplayAtom = "native-Anthropic" | "proxy-evidence-v1";

/** Closed client response representation for one capability-bearing request. */
export type ServerToolResponseMode = "json" | "streaming";

/** Whether the request combines ordinary client functions with a server tool. */
export type ServerToolMixedToolMode =
	| "server_only"
	| "server_and_client_functions";

export interface ServerToolReplayRequirement {
	readonly input: readonly ServerToolReplayAtom[];
	readonly output: readonly ServerToolReplayAtom[];
	readonly requiresOutputReplay: boolean;
}

export interface ApproximateUserLocation {
	readonly type: "approximate";
	readonly city?: string;
	readonly region?: string;
	readonly country?: string;
	readonly timezone?: string;
}

export interface WebSearchServerToolDeclaration {
	readonly type: "web_search_20250305";
	readonly maxUses?: number;
	readonly allowedDomains?: readonly string[];
	readonly blockedDomains?: readonly string[];
	readonly userLocation?: ApproximateUserLocation;
}

export interface InvalidServerToolRequirement {
	readonly type: string;
	readonly reason: "invalid_options";
}

export interface UnsupportedServerToolRequirement {
	readonly type: string;
}

/**
 * Content-minimal immutable routing requirements derived from one final request
 * body. It deliberately excludes messages, client-function schemas, and model.
 */
export interface ServerToolRequirements {
	readonly revision: 2;
	/** Intentionally low-cardinality, value-free telemetry profile. */
	readonly profileId?: string;
	/** Collision-resistant identity of the exact normalized admitted options. */
	readonly optionProfileId?: string;
	readonly responseMode?: ServerToolResponseMode;
	readonly mixedToolMode?: ServerToolMixedToolMode;
	readonly hasClientFunctions?: true;
	readonly declarations?: readonly WebSearchServerToolDeclaration[];
	readonly invalid?: readonly InvalidServerToolRequirement[];
	readonly unsupported?: readonly UnsupportedServerToolRequirement[];
	readonly replay: ServerToolReplayRequirement;
}

/** Exact candidate and transport contract to which one proof applies. */
export interface ServerToolCapabilityTuple {
	readonly candidateId: string;
	readonly provider: string;
	readonly authMode: string;
	readonly endpointClass: string;
	readonly normalizedEndpoint?: string;
	readonly model: string;
	readonly toolType: string;
	/** Intentionally low-cardinality, value-free telemetry profile. */
	readonly profile: string;
	/** Exact normalized option profile; distinct from `profile`. */
	readonly optionProfile: string;
	readonly responseMode: ServerToolResponseMode;
	readonly mixedToolMode: ServerToolMixedToolMode;
	readonly inputReplay: readonly ServerToolReplayAtom[];
	readonly outputReplay: readonly ServerToolReplayAtom[];
	readonly providerContractRevision: string;
	readonly replayDecoderRevision: string;
	readonly requestTransport: string;
	readonly responseTransport: string;
}

export type ServerToolProofRevalidationTrigger =
	| "tuple_change"
	| "contract_change"
	| "decoder_change"
	| "observed_behavior_change";

export interface ServerToolCapabilityProof {
	readonly revision: string;
	readonly tuple: ServerToolCapabilityTuple;
	readonly decision: "proven" | "unsupported";
	readonly provenance: string;
	readonly owner: string;
	readonly verifiedAt: string;
	readonly revalidateAfter: string;
	readonly fixtureRevision?: string;
	readonly contractRevision?: string;
	readonly revalidationTriggers?: readonly ServerToolProofRevalidationTrigger[];
	readonly supersededBy?: string;
}

export type ServerToolCapabilityProofIndexEntry =
	| {
			readonly state: "selected";
			readonly proof: ServerToolCapabilityProof;
	  }
	| { readonly state: "superseded" }
	| { readonly state: "ambiguous" };

/** Immutable lookup seam built once from the configured proof registry. */
export interface ServerToolCapabilityProofIndex {
	readonly lookup: (
		tuple: ServerToolCapabilityTuple,
	) => ServerToolCapabilityProofIndexEntry | undefined;
}

export type ServerToolCapabilityDecision =
	| {
			readonly decision: "proven" | "unsupported";
			readonly proof: ServerToolCapabilityProof;
	  }
	| {
			readonly decision: "unknown";
			readonly reason:
				| "no_exact_proof"
				| "proof_expired"
				| "proof_superseded"
				| "proof_incomplete"
				| "proof_ambiguous"
				| "requirement_mismatch"
				| "invalid_requirement"
				| "unsupported_requirement";
	  };

/** Pure, candidate-scoped provider seam. Implementations must not perform I/O. */
export type ServerToolCapabilityResolver = (
	requirement: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
) => ServerToolCapabilityDecision;
