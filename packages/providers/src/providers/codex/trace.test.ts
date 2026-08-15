import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODEX_TRACE_DIR_ENV,
	CODEX_TRACE_HMAC_KEY_ENV,
	contextUtilizationPct,
	summarizeCodexResponse,
	summarizeCodexTransform,
	writeCodexAbortedAttemptTrace,
	writeCodexResponseTrace,
	writeCodexTrace,
} from "./trace";

afterEach(() => {
	delete process.env[CODEX_TRACE_DIR_ENV];
	delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
});

describe("Codex HTTP turn-state telemetry (schema 18)", () => {
	test("annuls an attempt that never reached the wire", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-abort-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			// An attempt with no ID cannot be annulled and must not write a record.
			writeCodexAbortedAttemptTrace({
				attemptId: null,
				requestId: "logical-1",
			});
			expect(readdirSync(dir)).toHaveLength(0);

			writeCodexAbortedAttemptTrace({
				attemptId: "private-attempt-abandoned",
				requestId: "private-logical",
			});
			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const [tombstone] = readFileSync(join(dir, file as string), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(tombstone).toMatchObject({
				trace_schema_version: 18,
				// The analyzer duplicates this literal (it imports nothing from the
				// provider); both sides are pinned so either one drifting fails here.
				phase: "attempt_aborted",
				request_id: "private-logical",
				attempt_id: "private-attempt-abandoned",
			});
			// Neither an existing request nor an existing response reader may pick
			// this record up.
			expect(tombstone.phase).not.toBe("request");
			expect(tombstone.phase).not.toBe("response");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes only bounded request and response attribution", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-turn-state-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "trace-test-key";
		try {
			writeCodexTrace({
				codexInput: [],
				turnStateArm: "treatment",
				turnStateCohortId: "0123456789abcdef",
				turnStateRequestAction: "replay",
				turnStateReplayApplied: true,
				turnState: "private-request-turn-state",
			});
			writeCodexResponseTrace({
				turnStateTerminalAction: "advanced",
				summary: summarizeCodexResponse([], {}, "end_turn"),
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const rawTrace = readFileSync(join(dir, file as string), "utf8");
			const [request, response] = rawTrace
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(request).toMatchObject({
				trace_schema_version: 18,
				codex_turn_state_arm: "treatment",
				codex_turn_state_cohort_id: "0123456789abcdef",
				codex_turn_state_request_action: "replay",
				codex_turn_state_replay_applied: true,
			});
			expect(request.codex_turn_state_request_hmac).toMatch(/^[0-9a-f]{64}$/);
			expect(response).toMatchObject({
				trace_schema_version: 18,
				codex_turn_state_terminal_action: "advanced",
			});
			expect(rawTrace).not.toContain("private-request-turn-state");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("collapses invalid or future attribution instead of echoing it", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-turn-state-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				turnStateArm: "future" as never,
				turnStateCohortId: "private-cohort-value",
				turnStateRequestAction: "private-action" as never,
				turnStateReplayApplied: true,
			});
			writeCodexResponseTrace({
				turnStateTerminalAction: "private-terminal" as never,
				summary: summarizeCodexResponse([], {}, "end_turn"),
			});
			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const rawTrace = readFileSync(join(dir, file as string), "utf8");
			const [request, response] = rawTrace
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(request.codex_turn_state_arm).toBe("ineligible");
			expect(request.codex_turn_state_cohort_id).toBeNull();
			expect(request.codex_turn_state_request_action).toBe("missing_binding");
			expect(request.codex_turn_state_replay_applied).toBe(false);
			expect(response.codex_turn_state_terminal_action).toBe("ineligible");
			expect(rawTrace).not.toContain("private-cohort-value");
			expect(rawTrace).not.toContain("private-action");
			expect(rawTrace).not.toContain("private-terminal");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reasoning retention telemetry (schema 18)", () => {
	test("writes a counts-only request record", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-reasoning-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [
					{
						type: "reasoning",
						id: "rs_private",
						summary: [],
						encrypted_content: "must-not-appear-in-trace",
					},
				],
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const rawTrace = readFileSync(join(dir, file as string), "utf8");
			const record = JSON.parse(rawTrace.trim());
			expect(record).toMatchObject({
				trace_schema_version: 18,
				phase: "request",
				reasoning_input_item_count: 1,
			});
			expect(rawTrace).not.toContain("rs_private");
			expect(rawTrace).not.toContain("must-not-appear-in-trace");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes a counts-only response record", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-reasoning-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexResponseTrace({
				summary: summarizeCodexResponse([], {}, "end_turn", undefined, {
					outputItemCount: 3,
					encryptedPresent: true,
					unrepresentableIdSkipCount: 2,
				}),
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record).toMatchObject({
				trace_schema_version: 18,
				phase: "response",
				reasoning_output_item_count: 3,
				reasoning_encrypted_present: true,
				reasoning_unrepresentable_id_skip_count: 2,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeCodexTrace schema 18 cache experiments", () => {
	test("writes bounded decision fields without reconstructing their semantics", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-schema-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				requestId: "logical-1",
				attemptId: "attempt-1",
				attemptOrdinal: 2,
				attemptCause: "model_fallback",
				promptCacheKeySet: true,
				promptCacheKeyId: "not-a-semantic-prefix",
				cacheKeyMode: "session",
				cacheKeyAssignment: "conversation",
				cacheKeyCohortId: "0123456789abcdef",
				conversationId: "fedcba9876543210",
				cacheKeyAssignmentSource: "explicit_session_override",
				cacheKeyContinuityApplied: false,
				continuityEvidenceId: "0123456789abcdef",
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record).toMatchObject({
				trace_schema_version: 18,
				cache_key_continuity_applied: false,
				continuity_evidence_id: "0123456789abcdef",
				request_id: "logical-1",
				attempt_id: "attempt-1",
				attempt_ordinal: 2,
				attempt_cause: "model_fallback",
				cache_key_assignment: "conversation",
				cache_key_cohort_id: "0123456789abcdef",
				conversation_id: "fedcba9876543210",
				cache_key_assignment_source: "explicit_session_override",
				cache_key_mode: "session",
				prompt_cache_key_id: "not-a-semantic-prefix",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes null decision fields for ineligible traffic", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-schema-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({ codexInput: [] });
			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record.cache_key_assignment).toBeNull();
			expect(record.cache_key_cohort_id).toBeNull();
			expect(record.conversation_id).toBeNull();
			expect(record.cache_key_assignment_source).toBeNull();
			expect(record.cache_key_continuity_applied).toBeNull();
			expect(record.continuity_evidence_id).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("orchestration demotion diagnostics (preserved in schema 18)", () => {
	test("writes the demotion signal and elapsed time when supplied", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-schema-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				orchestrationDemotionObserved: true,
				elapsedMsSinceRoot: 4_242,
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record).toMatchObject({
				trace_schema_version: 18,
				orchestration_demotion_observed: true,
				elapsed_ms_since_root: 4_242,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults both fields to null in the current schema", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-schema-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({ codexInput: [] });

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record.trace_schema_version).toBe(18);
			expect(record.orchestration_demotion_observed).toBeNull();
			expect(record.elapsed_ms_since_root).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves an explicit false without collapsing it to null", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-schema-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				orchestrationDemotionObserved: false,
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record.orchestration_demotion_observed).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("orchestration admission basis (introduced in schema 13, preserved in schema 18)", () => {
	test("writes an explicit categorical basis alongside its admission", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-basis-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				orchestrationAdmission: "root",
				orchestrationBasis: "lineage_match",
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record).toMatchObject({
				trace_schema_version: 18,
				orchestration_admission: "root",
				orchestration_basis: "lineage_match",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults the basis to null when omitted", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-basis-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({ codexInput: [] });

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record.orchestration_basis).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves an explicit null basis without collapsing a falsy check", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-basis-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				orchestrationAdmission: "attributed_descendant",
				orchestrationBasis: null,
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record).toMatchObject({
				// No cast required at the call site: "attributed_descendant" is a
				// first-class member of the imported OrchestrationAdmission union.
				orchestration_admission: "attributed_descendant",
				orchestration_basis: null,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.each([
		"initial_claim",
		"identity_match",
		"lineage_match",
		"rejected",
	] as const)("accepts the %s categorical basis verbatim", (basis) => {
		const dir = mkdtempSync(join(tmpdir(), "codex-trace-basis-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexTrace({
				codexInput: [],
				orchestrationAdmission: basis === "rejected" ? "non_root" : "root",
				orchestrationBasis: basis,
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const record = JSON.parse(
				readFileSync(join(dir, file as string), "utf8").trim(),
			);
			expect(record.orchestration_basis).toBe(basis);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("summarizeCodexTransform (request/history phase)", () => {
	test("counts historical tool calls, outputs, empties, and nudges", () => {
		const s = summarizeCodexTransform([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: '{"prompt":"review a"}',
			},
			{
				type: "function_call",
				call_id: "t2",
				name: "Task",
				arguments: '{"prompt":"review b"}',
			},
			{
				type: "function_call",
				call_id: "s1",
				name: "Skill",
				arguments: '{"skill":"ce-plan"}',
			},
			{ type: "function_call_output", call_id: "t1", output: "finding a" },
			{ type: "function_call_output", call_id: "t2", output: "" },
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Continue the user's original request now, applying those instructions.",
					},
				],
			},
		]);

		expect(s.history_function_call_count).toBe(3);
		expect(s.history_function_call_output_count).toBe(2);
		expect(s.history_empty_output_count).toBe(1);
		expect(s.nudge_count).toBe(1);
		expect(s.history_tool_use_by_name).toEqual({ Task: 2, Skill: 1 });
	});

	test("captures per-call argument previews, truncated to 120 chars", () => {
		const longArg = `{"prompt":"${"x".repeat(500)}"}`;
		const s = summarizeCodexTransform([
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: longArg,
			},
		]);
		expect(s.history_tool_calls[0].arg_preview.length).toBe(120);
	});

	test("ignores malformed items without throwing", () => {
		const s = summarizeCodexTransform([null, undefined, 42, "str", {}]);
		expect(s.history_function_call_count).toBe(0);
		expect(s.reasoning_input_item_count).toBe(0);
		expect(s.input_item_count).toBe(5);
	});

	test("counts replayed reasoning input items without retaining their content", () => {
		const s = summarizeCodexTransform([
			{
				type: "reasoning",
				id: "rs_first",
				summary: [],
				encrypted_content: "private-first",
			},
			{ role: "assistant", content: [{ type: "output_text", text: "answer" }] },
			{
				type: "reasoning",
				id: "rs_second",
				summary: [],
				encrypted_content: "private-second",
			},
		]);

		expect(s.reasoning_input_item_count).toBe(2);
		expect(JSON.stringify(s)).not.toContain("private-first");
		expect(JSON.stringify(s)).not.toContain("private-second");
	});

	test("records byte sizes but no fingerprints without an HMAC key", () => {
		const s = summarizeCodexTransform([{ role: "user", content: "héllo" }]);
		expect(s.input_bytes).toBeGreaterThan(0);
		expect(s.input_hmac).toBeNull();
		expect(s.input_first_item_bytes).toBeGreaterThan(0);
		expect(s.input_first_item_hmac).toBeNull();
		expect(s.input_except_last_item_bytes).toBeNull();
		expect(s.input_except_last_item_hmac).toBeNull();
	});

	test("creates deterministic HMAC fingerprints for full input and structural slices", () => {
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		const input = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
		];
		const first = summarizeCodexTransform(input);
		const second = summarizeCodexTransform(input);
		const changed = summarizeCodexTransform([
			input[0],
			{ role: "assistant", content: "changed" },
		]);

		expect(first.input_hmac).toHaveLength(64);
		expect(first.input_hmac).toBe(second.input_hmac);
		expect(first.input_except_last_item_hmac).toBe(
			changed.input_except_last_item_hmac,
		);
		expect(first.input_hmac).not.toBe(changed.input_hmac);
		expect(first.input_first_item_hmac).toBe(changed.input_first_item_hmac);
	});

	test("emits per-item HMACs that prove an earlier full input is a later prefix", () => {
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		const earlierInput = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
		];
		const earlier = summarizeCodexTransform(earlierInput);
		const later = summarizeCodexTransform([
			...earlierInput,
			{ role: "user", content: "third" },
		]);

		expect(earlier.input_item_fingerprints.at(-1)).toEqual(
			later.input_item_fingerprints.find(
				(fingerprint) => fingerprint.index === earlierInput.length - 1,
			),
		);
		expect(earlier.input_item_total_count).toBe(2);
		expect(earlier.input_item_fingerprints_truncated).toBe(false);
	});

	test("keeps per-item telemetry empty without a key and caps trace growth", () => {
		const disabled = summarizeCodexTransform([{ value: "private" }]);
		expect(disabled.input_item_fingerprints).toEqual([]);

		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		const baseInput = Array.from({ length: 100 }, (_, index) => ({ index }));
		const many = summarizeCodexTransform(baseInput);
		const appended = summarizeCodexTransform([...baseInput, { index: 100 }]);
		expect(many.input_item_fingerprints).toHaveLength(64);
		expect(many.input_item_fingerprints[0]?.index).toBe(36);
		expect(many.input_item_fingerprints.at(-1)).toEqual(
			appended.input_item_fingerprints.find(
				(fingerprint) => fingerprint.index === 99,
			),
		);
		expect(many.input_item_total_count).toBe(100);
		expect(many.input_item_fingerprints_truncated).toBe(true);
	});
});

describe("summarizeCodexResponse (response phase)", () => {
	test("records reasoning output counts and encrypted payload presence", () => {
		const s = summarizeCodexResponse(
			[],
			{ input_tokens: 10 },
			"end_turn",
			undefined,
			{ outputItemCount: 2, encryptedPresent: true },
		);

		expect(s.reasoning_output_item_count).toBe(2);
		expect(s.reasoning_encrypted_present).toBe(true);
		expect(s.reasoning_unrepresentable_id_skip_count).toBe(0);
	});

	test("counts newly emitted tool calls and computes cache hit pct", () => {
		const s = summarizeCodexResponse(
			[
				{ name: "Task", arg_preview: '{"prompt":"a"}' },
				{ name: "Task", arg_preview: '{"prompt":"b"}' },
				{ name: "Bash", arg_preview: '{"command":"ls"}' },
			],
			{ input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 700 },
			"tool_use",
		);
		expect(s.new_tool_call_count).toBe(3);
		expect(s.new_tool_use_by_name).toEqual({ Task: 2, Bash: 1 });
		expect(s.stop_reason).toBe("tool_use");
		// Cached tokens are a subset of total input tokens.
		expect(s.cache_hit_pct).toBe(70);
	});

	test("counts Task and Agent calls as subagent spawns, other tools excluded", () => {
		const s = summarizeCodexResponse(
			[
				{ name: "Task", arg_preview: "{}" },
				{ name: "Agent", arg_preview: "{}" },
				{ name: "Agent", arg_preview: "{}" },
				{ name: "Bash", arg_preview: "{}" },
				{ name: "Read", arg_preview: "{}" },
			],
			{ input_tokens: 100 },
			"tool_use",
		);
		expect(s.new_tool_call_count).toBe(5);
		expect(s.new_subagent_spawn_count).toBe(3);
	});

	test("text-only responses report zero subagent spawns", () => {
		const s = summarizeCodexResponse([], { input_tokens: 10 }, "end_turn");
		expect(s.new_subagent_spawn_count).toBe(0);
		expect(s.reasoning_output_item_count).toBe(0);
		expect(s.reasoning_encrypted_present).toBe(false);
	});

	test("contextUtilizationPct reports input pressure against the window", () => {
		expect(contextUtilizationPct(186_000, 372_000)).toBe(50);
		expect(contextUtilizationPct(360_310, 372_000)).toBe(96.9);
		expect(contextUtilizationPct(0, 372_000)).toBeNull();
		expect(contextUtilizationPct(1000, undefined)).toBeNull();
		expect(contextUtilizationPct(1000, 0)).toBeNull();
	});

	test("keeps trace cache hit and context utilization based on total occupied input", () => {
		const s = summarizeCodexResponse(
			[],
			{ input_tokens: 100, cache_read_input_tokens: 25 },
			"end_turn",
		);
		expect(s.input_tokens).toBe(100);
		expect(s.cache_hit_pct).toBe(25);
		expect(contextUtilizationPct(s.input_tokens, 200)).toBe(50);
	});

	test("clamps malformed cached token counts to the total input", () => {
		const s = summarizeCodexResponse(
			[],
			{ input_tokens: 100, cache_read_input_tokens: 700 },
			"end_turn",
		);
		expect(s.cache_hit_pct).toBe(100);
	});

	test("preserves missing usage as unavailable rather than measured zero", () => {
		const s = summarizeCodexResponse([], {}, "end_turn");
		expect(s.new_tool_call_count).toBe(0);
		expect(s.usage_measurement_available).toBe(false);
		expect(s.cache_measurement_available).toBe(false);
		expect(s.input_tokens).toBeNull();
		expect(s.output_tokens).toBeNull();
		expect(s.cache_read_input_tokens).toBeNull();
		expect(s.cache_creation_input_tokens).toBeNull();
		expect(s.cache_creation_measurement_available).toBe(false);
		expect(s.cache_hit_pct).toBeNull();
	});

	test("distinguishes measured zero cache usage from unavailable cache usage", () => {
		const s = summarizeCodexResponse(
			[],
			{ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 },
			"end_turn",
		);
		expect(s.usage_measurement_available).toBe(true);
		expect(s.cache_measurement_available).toBe(true);
		expect(s.cache_read_input_tokens).toBe(0);
		expect(s.cache_hit_pct).toBe(0);
	});

	test("distinguishes measured zero cache writes from unavailable cache writes", () => {
		const measured = summarizeCodexResponse(
			[],
			{
				input_tokens: 10,
				cache_creation_input_tokens: 0,
				cache_creation_measurement_available: true,
			},
			"end_turn",
		);
		const unavailable = summarizeCodexResponse(
			[],
			{
				input_tokens: 10,
				cache_creation_input_tokens: 0,
				cache_creation_measurement_available: false,
			},
			"end_turn",
		);

		expect(measured.cache_creation_measurement_available).toBe(true);
		expect(measured.cache_creation_input_tokens).toBe(0);
		expect(unavailable.cache_creation_measurement_available).toBe(false);
		expect(unavailable.cache_creation_input_tokens).toBeNull();
	});

	test("carries normalized upstream error details", () => {
		const s = summarizeCodexResponse([], { input_tokens: 10 }, "error", {
			type: "rate_limit_error",
			message: "429",
			code: "rate_limit_exceeded",
			status: "rate_limited",
		});
		expect(s.stop_reason).toBe("error");
		expect(s.error_type).toBe("rate_limit_error");
		expect(s.error_message).toBe("429");
		expect(s.error_code).toBe("rate_limit_exceeded");
		expect(s.error_status).toBe("rate_limited");
	});

	test.each([
		"end_turn",
		"tool_use",
		"max_tokens",
		"refusal",
	] as const)("preserves the %s terminal reason without error metadata", (stopReason) => {
		const s = summarizeCodexResponse([], { input_tokens: 10 }, stopReason, {
			type: "must_not_leak",
			message: "not an error",
		});
		expect(s.stop_reason).toBe(stopReason);
		expect(s.error_type).toBeUndefined();
		expect(s.error_message).toBeUndefined();
	});

	test("classifies metadata-free error stops without guessing a cause", () => {
		const s = summarizeCodexResponse([], { input_tokens: 10 }, "error");
		expect(s.stop_reason).toBe("error");
		expect(s.error_type).toBe("unclassified_upstream_error");
		expect(s.error_message).toBeUndefined();
	});
});

describe("writeCodexResponseTrace protocol identity telemetry", () => {
	test("writes stable keyed rotation markers without retaining raw values", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-response-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		const summary = summarizeCodexResponse([], {}, "end_turn");
		try {
			writeCodexResponseTrace({
				summary,
				turnStateHeaderPresent: true,
				turnState: "private-turn-state-a",
				responseId: "private-response-a",
			});
			writeCodexResponseTrace({
				summary,
				turnStateHeaderPresent: true,
				turnState: "private-turn-state-a",
				responseId: "private-response-b",
			});
			writeCodexResponseTrace({
				summary,
				turnStateHeaderPresent: true,
				turnState: "private-turn-state-b",
				responseId: "private-response-c",
			});

			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const rawTrace = readFileSync(join(dir, file as string), "utf8");
			const records = rawTrace
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));

			expect(records[0].codex_turn_state_present).toBe(true);
			expect(records[0].codex_turn_state_hmac).toHaveLength(64);
			expect(records[0].codex_turn_state_hmac).toBe(
				records[1].codex_turn_state_hmac,
			);
			expect(records[0].codex_turn_state_hmac).not.toBe(
				records[2].codex_turn_state_hmac,
			);
			expect(records[0].response_id_present).toBe(true);
			expect(records[0].response_id_hmac).toHaveLength(64);
			expect(records[0].response_id_hmac).not.toBe(records[1].response_id_hmac);
			expect(rawTrace).not.toContain("private-turn-state");
			expect(rawTrace).not.toContain("private-response");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("records presence but no digest when keyed tracing is unavailable", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-response-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		try {
			writeCodexResponseTrace({
				summary: summarizeCodexResponse([], {}, "end_turn"),
				turnStateHeaderPresent: true,
				turnState: "must-not-be-written",
			});
			const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
			const rawTrace = readFileSync(join(dir, file as string), "utf8");
			const record = JSON.parse(rawTrace.trim());
			expect(record.codex_turn_state_present).toBe(true);
			expect(record.codex_turn_state_hmac).toBeNull();
			expect(record.response_id_present).toBe(false);
			expect(record.response_id_hmac).toBeNull();
			expect(rawTrace).not.toContain("must-not-be-written");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
