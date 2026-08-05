import { describe, expect, test } from "bun:test";
import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";

const EVIDENCE_IDS = [
	"request_acceptance",
	"endpoint_contract",
	"normalized_host_class",
	"auth_mode",
	"physical_model",
	"model_family",
	"client_version",
	"provider_version",
	"accepted_tool_declaration",
	"accepted_option_surface",
	"ordered_streaming_event_names",
	"sources_citations",
	"zero_result",
	"error_path",
	"usage_reconciliation",
	"mixed_tools",
	"continuation",
	"input_replay_direction",
	"input_replay_audience",
	"output_replay_direction",
	"output_replay_audience",
	"bccf2_provider_neutral_replay_wire_vectors",
	"bccf2_provider_neutral_replay_downgrade_behavior",
	"bccf2_provider_neutral_replay_nonce_tag_encoding",
	"bccf2_provider_neutral_replay_key_behavior",
	"bccf2_provider_neutral_replay_nonce_budget_rotation",
	"no_execution_status_code_headers",
	"no_execution_bounded_parse_rule",
	"no_execution_fixture_evidence",
	"declared_limits",
	"fixture_driven_profile_reductions",
	"sanitization",
	"redactions",
] as const;

const EXPECTED_PRE_GATE_MANIFEST = {
	schemaVersion: 1,
	capabilityStatus: "unknown",
	implementationGate: "blocked",
	proofRevision: 0,
	missingProofReason:
		"No operator-driven private endpoint capture has completed for the exact Codex endpoint/auth/model tuple.",
	evidence: EVIDENCE_IDS.map((id) => ({ id, status: "missing" })),
	artifacts: [],
	redactedFields: [
		"authorization_headers",
		"cookies",
		"access_tokens",
		"refresh_tokens",
		"api_keys",
		"account_identifiers",
		"user_identifiers",
		"session_identifiers",
		"conversation_identifiers",
		"request_identifiers",
		"response_identifiers",
		"call_identifiers",
		"project_identifiers",
		"organization_identifiers",
		"correlation_identifiers",
		"trace_identifiers",
		"prompt_system_and_query_text",
		"response_reasoning_and_output_text",
		"turn_state",
		"source_urls_titles_and_snippets",
		"user_location",
		"raw_transport_headers",
		"raw_request_and_response_bodies",
		"replay_plaintext",
		"replay_envelopes",
		"replay_nonces",
		"replay_key_material",
		"replay_key_ids",
		"encrypted_replay_payloads",
		"private_endpoint_origin",
	],
	ownerRole: "maintainer",
	verificationDate: null,
	lastVerifiedAt: null,
	revalidationTriggers: [
		"an operator-driven private endpoint capture completes",
		"the Codex endpoint, auth mode, model family, client version, or provider event contract changes",
		"provider-neutral replay, sanitization, or no-execution classifier contracts change",
	],
	supersedingRevisionRestoration: [
		"retain this blocked revision when a higher proof revision supersedes it",
		"restore this blocked revision if the superseding proof is invalidated, drifts, or cannot be reproduced",
	],
	providerNeutralReplayEvidence: {
		status: "missing",
		refs: [
			"packages/providers/src/server-tools/replay-envelope.test.ts",
			"packages/providers/src/server-tools/history-projection.test.ts",
			"packages/providers/src/provider-attempt-plan.test.ts",
			"packages/providers/src/server-tool-capabilities.test.ts",
		],
	},
} as const;

function readManifest(): unknown {
	return JSON.parse(
		readFileSync(
			new URL("./__fixtures__/server-tools/manifest.json", import.meta.url),
			"utf8",
		),
	);
}

function assertStrictPreGateManifest(
	manifest: unknown,
): asserts manifest is typeof EXPECTED_PRE_GATE_MANIFEST {
	deepStrictEqual(manifest, EXPECTED_PRE_GATE_MANIFEST);
}

describe("Codex server-tool characterization manifest", () => {
	test("records only the strict blocked pre-gate state", () => {
		assertStrictPreGateManifest(readManifest());
	});

	test("rejects proof-like in-memory mutations before private endpoint capture", () => {
		const mutated = structuredClone(readManifest()) as Record<string, unknown>;
		mutated.capabilityStatus = "proven";
		mutated.evidence = EVIDENCE_IDS.map((id) => ({
			id,
			status: "supported",
		}));
		mutated.artifacts = ["request.json", "events.jsonl"];
		mutated.providerNeutralReplayEvidence = {
			...EXPECTED_PRE_GATE_MANIFEST.providerNeutralReplayEvidence,
			status: "supported",
		};

		expect(() => assertStrictPreGateManifest(mutated)).toThrow();
	});
});
