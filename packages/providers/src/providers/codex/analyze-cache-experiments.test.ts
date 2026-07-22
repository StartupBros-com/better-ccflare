import { describe, expect, test } from "bun:test";
import {
	analyzeCodexCacheExperiments,
	analyzeCodexTrace,
	formatCacheExperimentReport,
	formatReport,
} from "./analyze-trace";

describe("analyzeCodexCacheExperiments", () => {
	test("groups the pacing canary by arm, model, turn, and gap band", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 9,
				phase: "request",
				ts: "2026-07-21T00:00:00.000Z",
				request_id: "private-request-first",
				attempt_id: "private-attempt-first",
				attempt_ordinal: 1,
				attempt_cause: "initial",
				model_out: "gpt-5.6-sol",
				pacing_canary: "bypass",
				pacing_cohort_id: "0123456789abcdef",
				pacing_action: "bypassed",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				ts: "2026-07-21T00:00:01.000Z",
				request_id: "private-request-first",
				attempt_id: "private-attempt-first",
				stop_reason: "end_turn",
				input_tokens: 100,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 100,
			},
			{
				trace_schema_version: 9,
				phase: "request",
				ts: "2026-07-21T00:02:00.000Z",
				request_id: "private-request-follow-up",
				attempt_id: "private-attempt-follow-up",
				attempt_ordinal: 1,
				attempt_cause: "initial",
				model_out: "gpt-5.6-sol",
				pacing_canary: "bypass",
				pacing_cohort_id: "0123456789abcdef",
				pacing_action: "bypassed",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				ts: "2026-07-21T00:02:03.500Z",
				request_id: "private-request-follow-up",
				attempt_id: "private-attempt-follow-up",
				stop_reason: "error",
				error_status: "400",
				input_tokens: 1_000,
				cache_read_input_tokens: 800,
				cache_creation_input_tokens: 50,
			},
			{
				trace_schema_version: 9,
				phase: "request",
				ts: "2026-07-21T00:00:10.000Z",
				request_id: "private-control-first",
				attempt_id: "private-control-attempt",
				attempt_ordinal: 2,
				attempt_cause: "model_fallback",
				model_out: "gpt-5.5",
				pacing_canary: "control",
				pacing_cohort_id: "fedcba9876543210",
				pacing_action: "paced",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				ts: "2026-07-21T00:00:12.000Z",
				request_id: "private-control-first",
				attempt_id: "private-control-attempt",
				stop_reason: "end_turn",
				input_tokens: 200,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 25,
			},
		]);

		expect(report.schemaVersion).toBe(1);
		expect(report.attribution.unit).toBe("final_observed_codex_attempt");
		expect(report.attribution.pacingWaitMs).toBe("unavailable");
		expect(report.pacing.assignmentCounts).toEqual({
			treatment: 2,
			control: 1,
			ineligible: 0,
			unassigned: 0,
		});
		expect(report.pacing.rows).toMatchObject([
			{
				arm: "control",
				model: "gpt-5.5",
				turn: "first_observed",
				gapBand: "unknown",
				observedCodexAttempts: 1,
				joinedObservedCodexResponses: 1,
				unjoinedObservedCodexAttempts: 0,
				cache: {
					measuredResponses: 1,
					inputTokens: 200,
					cachedReadTokens: 100,
					weightedCachedReadPct: 50,
					cacheWriteMeasuredResponses: 1,
					cacheWriteTokens: 25,
					positiveHitResponses: 1,
					positiveHitRatePct: 100,
				},
				elapsed: {
					availableResponses: 1,
					unavailableResponses: 0,
					p50Ms: 2_000,
					p95Ms: 2_000,
				},
				outcomes: {
					observedCodex400Responses: 0,
					observedCodexErrorResponses: 0,
					finalObservedCodexAttemptFallbacks: 1,
					observedCodexFallbackAttempts: 1,
				},
				pacing: {
					pacedRequests: 1,
					bypassedRequests: 0,
					crossoverPacedRequests: 0,
					unknownRequests: 0,
					waitMsAvailableRequests: 0,
					waitMsUnavailableRequests: 1,
				},
				actions: { paced: 1 },
			},
			{
				arm: "treatment",
				model: "gpt-5.6-sol",
				turn: "first_observed",
				gapBand: "unknown",
				observedCodexAttempts: 1,
				joinedObservedCodexResponses: 1,
				unjoinedObservedCodexAttempts: 0,
				cache: {
					measuredResponses: 1,
					inputTokens: 100,
					cachedReadTokens: 0,
					weightedCachedReadPct: 0,
					cacheWriteMeasuredResponses: 1,
					cacheWriteTokens: 100,
					positiveHitResponses: 0,
					positiveHitRatePct: 0,
				},
				elapsed: {
					availableResponses: 1,
					unavailableResponses: 0,
					p50Ms: 1_000,
					p95Ms: 1_000,
				},
				outcomes: {
					observedCodex400Responses: 0,
					observedCodexErrorResponses: 0,
					finalObservedCodexAttemptFallbacks: 0,
					observedCodexFallbackAttempts: 0,
				},
				pacing: {
					pacedRequests: 0,
					bypassedRequests: 1,
					crossoverPacedRequests: 0,
					unknownRequests: 0,
					waitMsAvailableRequests: 0,
					waitMsUnavailableRequests: 0,
				},
				actions: { bypassed: 1 },
			},
			{
				arm: "treatment",
				model: "gpt-5.6-sol",
				turn: "follow_up_observed",
				gapBand: "from_1m_to_5m",
				observedCodexAttempts: 1,
				joinedObservedCodexResponses: 1,
				unjoinedObservedCodexAttempts: 0,
				cache: {
					measuredResponses: 1,
					inputTokens: 1_000,
					cachedReadTokens: 800,
					weightedCachedReadPct: 80,
					cacheWriteMeasuredResponses: 1,
					cacheWriteTokens: 50,
					positiveHitResponses: 1,
					positiveHitRatePct: 100,
				},
				elapsed: {
					availableResponses: 1,
					unavailableResponses: 0,
					p50Ms: 3_500,
					p95Ms: 3_500,
				},
				outcomes: {
					observedCodex400Responses: 1,
					observedCodexErrorResponses: 1,
					finalObservedCodexAttemptFallbacks: 0,
					observedCodexFallbackAttempts: 0,
				},
				pacing: {
					pacedRequests: 0,
					bypassedRequests: 1,
					crossoverPacedRequests: 0,
					unknownRequests: 0,
					waitMsAvailableRequests: 0,
					waitMsUnavailableRequests: 0,
				},
				actions: { bypassed: 1 },
			},
		]);
	});

	test("accepts future explicit-breakpoint fields and buckets unknown values", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 9,
				phase: "request",
				ts: "2026-07-21T01:00:00Z",
				request_id: "request-treatment",
				attempt_id: "attempt-treatment",
				model_out: "gpt-5.6-sol",
				explicit_breakpoint_canary: "treatment",
				explicit_breakpoint_cohort_id: "aaaaaaaaaaaaaaaa",
				explicit_breakpoint_action: "placed_source_marker",
				pacing_action: "crossover-paced",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				ts: "2026-07-21T01:00:05Z",
				request_id: "request-treatment",
				attempt_id: "attempt-treatment",
				stop_reason: "end_turn",
				input_tokens: 500,
				cache_read_input_tokens: 250,
				cache_creation_input_tokens: 10,
			},
			{
				trace_schema_version: 9,
				phase: "request",
				ts: "2026-07-21T01:01:00Z",
				request_id: "request-unknown",
				attempt_id: "attempt-unknown",
				model_out: "not safe model \n private",
				explicit_breakpoint_canary: "future-arm",
				explicit_breakpoint_cohort_id: "raw-private-cohort",
				explicit_breakpoint_action: "future-action-private",
				pacing_action: "future-pacing-private",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				ts: "not-a-timestamp",
				request_id: "request-unknown",
				attempt_id: "attempt-unknown",
				stop_reason: "error",
				error_status: "500",
			},
		]);

		expect(report.explicitBreakpoint.assignmentCounts).toEqual({
			treatment: 1,
			control: 0,
			ineligible: 0,
			unassigned: 1,
		});
		expect(report.explicitBreakpoint.rows[0]).toMatchObject({
			arm: "treatment",
			model: "gpt-5.6-sol",
			turn: "first_observed",
			gapBand: "unknown",
			actions: { placed_source_marker: 1 },
			pacing: {
				crossoverPacedRequests: 1,
				waitMsUnavailableRequests: 1,
			},
		});
		expect(report.explicitBreakpoint.rows[1]).toMatchObject({
			arm: "unassigned",
			model: "other_or_custom",
			turn: "unknown",
			gapBand: "unknown",
			actions: { unknown: 1 },
			elapsed: { availableResponses: 0, unavailableResponses: 1 },
		});
	});

	test("computes weighted cache and elapsed percentiles across matching rows", () => {
		const records = [
			["aaaaaaaaaaaaaaaa", "request-a", "attempt-a", 100, 0, 10, 1_000],
			["bbbbbbbbbbbbbbbb", "request-b", "attempt-b", 900, 450, 20, 9_000],
		] as const;
		const report = analyzeCodexCacheExperiments(
			records.flatMap(
				([cohort, requestId, attemptId, input, cached, written, elapsed]) => [
					{
						trace_schema_version: 10,
						phase: "request" as const,
						ts: "2026-07-21T02:00:00.000Z",
						request_id: requestId,
						attempt_id: attemptId,
						model_out: "gpt-5.6-sol",
						pacing_canary: "bypass",
						pacing_cohort_id: cohort,
						pacing_action: "bypassed",
					},
					{
						trace_schema_version: 10,
						phase: "response" as const,
						ts: new Date(
							Date.parse("2026-07-21T02:00:00.000Z") + elapsed,
						).toISOString(),
						request_id: requestId,
						attempt_id: attemptId,
						stop_reason: "end_turn" as const,
						input_tokens: input,
						cache_read_input_tokens: cached,
						cache_creation_input_tokens: written,
					},
				],
			),
		);

		expect(report.pacing.rows).toHaveLength(1);
		expect(report.pacing.rows[0]).toMatchObject({
			observedCodexAttempts: 2,
			cache: {
				measuredResponses: 2,
				inputTokens: 1_000,
				cachedReadTokens: 450,
				weightedCachedReadPct: 45,
				cacheWriteMeasuredResponses: 2,
				cacheWriteTokens: 30,
				positiveHitResponses: 1,
				positiveHitRatePct: 50,
			},
			elapsed: {
				availableResponses: 2,
				unavailableResponses: 0,
				p50Ms: 1_000,
				p95Ms: 9_000,
			},
		});
	});

	test("recognizes explicit-breakpoint control and ineligible actions", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-21T03:00:00Z",
				request_id: "control-request",
				attempt_id: "control-attempt",
				model_out: "gpt-5.6-sol",
				explicit_breakpoint_canary: "control",
				explicit_breakpoint_cohort_id: "cccccccccccccccc",
				explicit_breakpoint_action: "skip_rotated_cache_key_attempt",
			},
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-21T03:00:00Z",
				request_id: "ineligible-request",
				attempt_id: "ineligible-attempt",
				model_out: "gpt-5.6-sol",
				explicit_breakpoint_canary: "ineligible",
				explicit_breakpoint_cohort_id: "dddddddddddddddd",
				explicit_breakpoint_action: "skip_non_gpt56",
			},
		]);

		expect(report.explicitBreakpoint.assignmentCounts).toEqual({
			treatment: 0,
			control: 1,
			ineligible: 1,
			unassigned: 0,
		});
		expect(report.explicitBreakpoint.rows[0]?.actions).toEqual({
			skip_rotated_cache_key_attempt: 1,
		});
		expect(report.explicitBreakpoint.rows[1]?.actions).toEqual({
			skip_non_gpt56: 1,
		});
	});

	test("formats only aggregate, privacy-safe experiment data", () => {
		const sensitive = {
			phase: "request" as const,
			request_id: "raw-request-id",
			attempt_id: "raw-attempt-id",
			model_out: "gpt-5.6-sol",
			pacing_canary: "bypass",
			pacing_cohort_id: "0123456789abcdef",
			pacing_action: "bypassed",
			prompt_cache_key_id: "raw-cache-key",
			history_tool_calls: [
				{ name: "private-tool", arg_preview: "private-tool-arguments" },
			],
		};
		const text = formatCacheExperimentReport(
			analyzeCodexCacheExperiments([sensitive]),
		);

		expect(text).toContain("CODEX CACHE EXPERIMENTS");
		expect(text).toContain("pacing_wait_ms=unavailable");
		for (const secret of [
			"raw-request-id",
			"raw-attempt-id",
			"0123456789abcdef",
			"raw-cache-key",
			"private-tool",
			"private-tool-arguments",
		]) {
			expect(text).not.toContain(secret);
		}
	});

	test("keeps the legacy analyzer output unchanged unless explicitly selected", () => {
		const records = [
			{
				phase: "request" as const,
				pacing_canary: "bypass",
				pacing_cohort_id: "0123456789abcdef",
			},
		];
		const legacy = formatReport(analyzeCodexTrace(records));
		const experiments = formatCacheExperimentReport(
			analyzeCodexCacheExperiments(records),
		);

		expect(legacy).not.toContain("CODEX CACHE EXPERIMENTS");
		expect(experiments).toContain("CODEX CACHE EXPERIMENTS");
	});

	test("labels file-boundary turns and Codex-only outcomes honestly", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-22T00:00:02Z",
				request_id: "after-midnight",
				attempt_id: "after-midnight-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
				pacing_cohort_id: "eeeeeeeeeeeeeeee",
				pacing_action: "paced",
			},
			{
				trace_schema_version: 10,
				phase: "response",
				ts: "2026-07-22T00:00:03Z",
				request_id: "after-midnight",
				attempt_id: "after-midnight-attempt",
				stop_reason: "end_turn",
			},
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-22T00:02:02Z",
				request_id: "observed-follow-up",
				attempt_id: "observed-follow-up-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
				pacing_cohort_id: "eeeeeeeeeeeeeeee",
				pacing_action: "paced",
			},
		]);

		expect(report.attribution).toMatchObject({
			unit: "final_observed_codex_attempt",
			responseScope: "codex_trace_only_no_cross_provider_terminal_visibility",
		});
		expect(report.pacing.rows[0]).toMatchObject({
			turn: "first_observed",
			gapBand: "unknown",
			observedCodexAttempts: 1,
			joinedObservedCodexResponses: 1,
			unjoinedObservedCodexAttempts: 0,
		});
		expect(report.pacing.rows[1]).toMatchObject({
			turn: "follow_up_observed",
			gapBand: "from_1m_to_5m",
			observedCodexAttempts: 1,
			joinedObservedCodexResponses: 0,
			unjoinedObservedCodexAttempts: 1,
		});
		const text = formatCacheExperimentReport(report);
		expect(text).toContain("scope=codex_trace_only");
		expect(text).not.toContain("final_logical_request");
	});

	test("counts ordinary http_400 errors without an error status", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-21T04:00:00Z",
				request_id: "http-400-request",
				attempt_id: "http-400-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "bypass",
				pacing_cohort_id: "ffffffffffffffff",
			},
			{
				trace_schema_version: 10,
				phase: "response",
				ts: "2026-07-21T04:00:01Z",
				request_id: "http-400-request",
				attempt_id: "http-400-attempt",
				stop_reason: "error",
				error_type: "http_400",
			},
		]);

		expect(report.pacing.rows[0]?.outcomes).toMatchObject({
			observedCodex400Responses: 1,
			observedCodexErrorResponses: 1,
		});
	});

	test("rejects a response join when its logical request ID mismatches", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-21T05:00:00Z",
				request_id: "logical-a",
				attempt_id: "shared-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
				pacing_cohort_id: "1111111111111111",
			},
			{
				trace_schema_version: 10,
				phase: "response",
				ts: "2026-07-21T05:00:01Z",
				request_id: "logical-b",
				attempt_id: "shared-attempt",
				stop_reason: "end_turn",
			},
		]);

		expect(report.pacing.rows[0]).toMatchObject({
			joinedObservedCodexResponses: 0,
			unjoinedObservedCodexAttempts: 1,
		});
	});

	test("buckets official model families and never emits custom model strings", () => {
		const secretModel = "gpt-5.6-sol-private-customer-secret";
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				request_id: "official",
				attempt_id: "official-attempt",
				model_out: "gpt-5.6-sol-2026-05-13",
				pacing_canary: "control",
				pacing_cohort_id: "2222222222222222",
			},
			{
				trace_schema_version: 10,
				phase: "request",
				request_id: "custom",
				attempt_id: "custom-attempt",
				model_out: secretModel,
				pacing_canary: "control",
				pacing_cohort_id: "3333333333333333",
			},
		]);

		expect(report.pacing.rows.map((row) => row.model).sort()).toEqual([
			"gpt-5.6-sol",
			"other_or_custom",
		]);
		expect(formatCacheExperimentReport(report)).not.toContain(secretModel);
	});

	test("rejects unsafe token numbers and reports aggregate overflow", () => {
		const fixture = (
			cohort: string,
			requestId: string,
			input: number,
			cached: number,
			written: number,
		) => [
			{
				trace_schema_version: 10,
				phase: "request" as const,
				ts: "2026-07-21T06:00:00Z",
				request_id: requestId,
				attempt_id: `${requestId}-attempt`,
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
				pacing_cohort_id: cohort,
			},
			{
				trace_schema_version: 10,
				phase: "response" as const,
				ts: "2026-07-21T06:00:01Z",
				request_id: requestId,
				attempt_id: `${requestId}-attempt`,
				stop_reason: "end_turn" as const,
				input_tokens: input,
				cache_read_input_tokens: cached,
				cache_creation_input_tokens: written,
			},
		];
		const report = analyzeCodexCacheExperiments([
			...fixture("4444444444444444", "unsafe", 1e308, 1e308, 1e308),
			...fixture(
				"5555555555555555",
				"safe-max",
				Number.MAX_SAFE_INTEGER,
				0,
				Number.MAX_SAFE_INTEGER,
			),
			...fixture("6666666666666666", "overflow", 1, 1, 1),
		]);

		expect(report.pacing.rows).toHaveLength(1);
		expect(report.pacing.rows[0]?.cache).toEqual({
			measuredResponses: 1,
			unavailableResponses: 1,
			overflowResponses: 1,
			inputTokens: Number.MAX_SAFE_INTEGER,
			cachedReadTokens: 0,
			weightedCachedReadPct: 0,
			cacheWriteMeasuredResponses: 1,
			cacheWriteUnavailableResponses: 1,
			cacheWriteOverflowResponses: 1,
			cacheWriteTokens: Number.MAX_SAFE_INTEGER,
			positiveHitResponses: 0,
			positiveHitRatePct: 0,
		});
		const text = formatCacheExperimentReport(report);
		expect(text).not.toContain("1e+308");
		expect(text).not.toContain("Infinity");
	});

	test("accepts the schema-v10 non-eligible-endpoint action", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				request_id: "endpoint-skip",
				attempt_id: "endpoint-skip-attempt",
				model_out: "gpt-5.6-sol",
				explicit_breakpoint_canary: "ineligible",
				explicit_breakpoint_cohort_id: "7777777777777777",
				explicit_breakpoint_action: "skip_non_eligible_endpoint",
			},
		]);

		expect(report.explicitBreakpoint.rows[0]?.actions).toEqual({
			skip_non_eligible_endpoint: 1,
		});
	});

	test("does not count an ambiguous legacy zero cache write as a measurement", () => {
		const report = analyzeCodexCacheExperiments([
			{
				trace_schema_version: 10,
				phase: "request",
				ts: "2026-07-21T08:00:00Z",
				request_id: "legacy-zero",
				attempt_id: "legacy-zero-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
			},
			{
				trace_schema_version: 10,
				phase: "response",
				ts: "2026-07-21T08:00:01Z",
				request_id: "legacy-zero",
				attempt_id: "legacy-zero-attempt",
				stop_reason: "end_turn",
				input_tokens: 100,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			{
				trace_schema_version: 11,
				phase: "request",
				ts: "2026-07-21T08:01:00Z",
				request_id: "measured-zero",
				attempt_id: "measured-zero-attempt",
				model_out: "gpt-5.6-sol",
				pacing_canary: "control",
			},
			{
				trace_schema_version: 11,
				phase: "response",
				ts: "2026-07-21T08:01:01Z",
				request_id: "measured-zero",
				attempt_id: "measured-zero-attempt",
				stop_reason: "end_turn",
				input_tokens: 100,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_creation_measurement_available: true,
			},
		]);

		expect(report.pacing.rows[0]?.cache).toMatchObject({
			cacheWriteMeasuredResponses: 1,
			cacheWriteUnavailableResponses: 1,
			cacheWriteTokens: 0,
		});
	});
});
