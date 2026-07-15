import { describe, expect, test } from "bun:test";
import {
	analyzeCodexTrace,
	formatReport,
	parseTraceJsonl,
} from "./analyze-trace";

describe("analyzeCodexTrace", () => {
	test("separates request history load from response new fan-out", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "2026-07-10T00:00:01Z",
				history_function_call_count: 171,
				input_item_count: 412,
				approx_input_chars: 573629,
				nudge_count: 0,
			},
			{
				phase: "response",
				ts: "2026-07-10T00:00:02Z",
				new_tool_call_count: 2,
				new_tool_use_by_name: { Task: 2 },
				new_tool_calls: [
					{ name: "Task", arg_preview: "a" },
					{ name: "Task", arg_preview: "b" },
				],
				stop_reason: "tool_use",
				input_tokens: 300,
				cache_read_input_tokens: 700,
				cache_hit_pct: 70,
			},
		]);

		expect(report.requests).toBe(1);
		expect(report.responses).toBe(1);
		// history bloat is large but is NOT counted as new fan-out
		expect(report.request.maxHistoryToolCalls).toBe(171);
		expect(report.response.maxNewFanOut).toBe(2);
		expect(report.response.totalNewToolCalls).toBe(2);
		expect(report.response.newToolUseByName).toEqual({ Task: 2 });
		expect(report.response.cacheHitPctAvg).toBe(70);
		expect(report.response.respawnResponses).toBe(0);
	});

	test("flags within-response duplicate new tool call as a true re-spawn", () => {
		const report = analyzeCodexTrace([
			{
				phase: "response",
				request_id: "r1",
				new_tool_call_count: 3,
				new_tool_calls: [
					{ name: "Task", arg_preview: "review auth" },
					{ name: "Task", arg_preview: "review db" },
					{ name: "Task", arg_preview: "review auth" },
				],
			},
		]);
		expect(report.response.respawnResponses).toBe(1);
		expect(report.response.worstRespawns[0]).toEqual({
			request_id: "r1",
			tool: "Task::review auth",
			count: 2,
		});
	});

	test("counts text-only responses and upstream errors", () => {
		const report = analyzeCodexTrace([
			{ phase: "response", new_tool_call_count: 0, stop_reason: "end_turn" },
			{ phase: "response", new_tool_call_count: 0, stop_reason: "end_turn" },
			{
				phase: "response",
				new_tool_call_count: 0,
				stop_reason: "error",
				error_type: "rate_limit_error",
			},
			{
				phase: "response",
				new_tool_call_count: 0,
				stop_reason: "error",
				input_tokens: 123,
			},
		]);
		expect(report.response.textOnlyResponses).toBe(2);
		expect(report.response.stopReasons).toEqual({ end_turn: 2, error: 2 });
		expect(report.response.errors).toEqual({
			rate_limit_error: 1,
			unclassified_upstream_error: 1,
		});
	});

	test("treats records without a phase as request (back-compat)", () => {
		const report = analyzeCodexTrace([
			{ history_function_call_count: 5, input_item_count: 9 },
		]);
		expect(report.requests).toBe(1);
		expect(report.request.maxHistoryToolCalls).toBe(5);
	});

	test("aggregates subagent spawns, deriving from tool names for old records", () => {
		const report = analyzeCodexTrace([
			{
				phase: "response",
				new_tool_call_count: 5,
				new_subagent_spawn_count: 3,
				new_tool_use_by_name: { Task: 1, Agent: 2, Bash: 2 },
			},
			// schema-v2 record without the explicit field: derived Task+Agent
			{
				phase: "response",
				new_tool_call_count: 6,
				new_tool_use_by_name: { Task: 6 },
			},
		]);
		expect(report.response.totalSubagentSpawns).toBe(9);
		expect(report.response.maxSubagentSpawns).toBe(6);
	});

	test("joins responses to requests for cache-key cohorts and sessions", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "r-on",
				prompt_cache_key_set: true,
				session_key_hash: "aaaa1111",
			},
			{
				phase: "request",
				request_id: "r-off",
				prompt_cache_key_set: false,
				session_key_hash: "aaaa1111",
			},
			{
				phase: "request",
				request_id: "r-other",
				session_key_hash: "bbbb2222",
			},
			{
				phase: "response",
				request_id: "r-on",
				cache_hit_pct: 80,
				input_tokens: 60_000,
			},
			{
				phase: "response",
				request_id: "r-off",
				cache_hit_pct: 0,
				input_tokens: 60_000,
			},
			// no matching request record
			{ phase: "response", request_id: "r-missing", cache_hit_pct: 50 },
		]);

		expect(report.response.cacheCohorts.keyOn.responses).toBe(1);
		expect(report.response.cacheCohorts.keyOn.avgCacheHitPct).toBe(80);
		expect(report.response.cacheCohorts.keyOn.largeResponses).toBe(1);
		expect(report.response.cacheCohorts.keyOff.responses).toBe(1);
		expect(report.response.cacheCohorts.keyOff.zeroHitResponses).toBe(1);
		expect(report.response.cacheCohorts.keyOff.largeZeroHitResponses).toBe(1);
		expect(report.response.unjoinedResponses).toBe(1);
		expect(report.request.distinctSessions).toBe(2);
		expect(report.request.topSessions[0]).toEqual({
			session: "aaaa1111",
			requests: 2,
		});
	});

	test("reports fingerprint coverage and cache-key transitions in timestamp order", () => {
		const fp = (index: number, hmac: string) => ({
			index,
			bytes: index + 1,
			hmac,
		});
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "2026-07-10T00:00:03Z",
				prompt_cache_key_id: "key-a",
				input_item_total_count: 3,
				input_item_fingerprints: [fp(0, "a"), fp(1, "b"), fp(2, "c")],
				input_item_fingerprints_truncated: false,
				instructions_hmac: "instructions-2",
				tools_hmac: "tools-1",
			},
			{
				phase: "request",
				ts: "2026-07-10T00:00:01Z",
				prompt_cache_key_id: "key-a",
				input_item_total_count: 2,
				input_item_fingerprints: [fp(0, "a"), fp(1, "b")],
				input_item_fingerprints_truncated: false,
				instructions_hmac: "instructions-1",
				tools_hmac: "tools-1",
			},
			{
				phase: "request",
				ts: "2026-07-10T00:00:04Z",
				prompt_cache_key_id: "key-a",
				input_item_total_count: 100,
				input_item_fingerprints: [fp(36, "x")],
				input_item_fingerprints_truncated: true,
				instructions_hmac: null,
				tools_hmac: null,
			},
			{
				phase: "request",
				ts: "2026-07-10T00:00:02Z",
				prompt_cache_key_id: null,
				input_item_total_count: 1,
				input_item_fingerprints: [fp(0, "a")],
				instructions_hmac: null,
				tools_hmac: null,
			},
			{
				phase: "request",
				ts: "2026-07-10T00:00:05Z",
				prompt_cache_key_id: "key-b",
				input_item_total_count: 1,
				input_item_fingerprints: [],
				input_item_fingerprints_truncated: false,
			},
			{
				phase: "request",
				ts: "2026-07-10T00:00:06Z",
				prompt_cache_key_id: "key-b",
				input_item_total_count: 2,
				input_item_fingerprints: [],
				input_item_fingerprints_truncated: false,
			},
		]);

		expect(report.request.fingerprintCoverage).toEqual({
			usable: 4,
			missing: 2,
			truncated: 1,
		});
		expect(report.request.prefixTransitions).toEqual({
			retainedExactPriorFullPrefix: 1,
			measurableChanged: 0,
			unavailableAbsentFingerprints: 1,
			unavailableRetentionWindow: 1,
		});
		expect(report.request.instructionStability).toEqual({
			stable: 0,
			changed: 1,
			unavailable: 2,
		});
		expect(report.request.toolStability).toEqual({
			stable: 1,
			changed: 0,
			unavailable: 2,
		});
	});

	test("classifies changed prefixes and never matches null cache keys or HMACs", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "1",
				prompt_cache_key_id: "key",
				input_item_total_count: 1,
				input_item_fingerprints: [{ index: 0, bytes: 1, hmac: "old" }],
				instructions_hmac: null,
				tools_hmac: null,
			},
			{
				phase: "request",
				ts: "2",
				prompt_cache_key_id: "key",
				input_item_total_count: 2,
				input_item_fingerprints: [{ index: 0, bytes: 1, hmac: "new" }],
				instructions_hmac: null,
				tools_hmac: null,
			},
			{ phase: "request", ts: "3", prompt_cache_key_id: null },
			{ phase: "request", ts: "4", prompt_cache_key_id: null },
		]);
		expect(report.request.prefixTransitions.measurableChanged).toBe(1);
		expect(report.request.instructionStability.stable).toBe(0);
		expect(report.request.toolStability.stable).toBe(0);
	});

	test("reports context boundaries, terminals, weighted reuse, usage, and true errors", () => {
		const report = analyzeCodexTrace([
			{
				phase: "response",
				context_utilization_pct: 49.9,
				stop_reason: "end_turn",
				input_tokens: 100,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 2,
			},
			{
				phase: "response",
				context_utilization_pct: 50,
				stop_reason: "max_tokens",
				input_tokens: 300,
				output_tokens: 2,
				cache_read_input_tokens: 150,
			},
			{
				phase: "response",
				context_utilization_pct: 80,
				stop_reason: "refusal",
				input_tokens: 0,
				output_tokens: 3,
				cache_read_input_tokens: 0,
			},
			{
				phase: "response",
				context_utilization_pct: 95,
				stop_reason: "tool_use",
				input_tokens: 100,
				output_tokens: 4,
				cache_read_input_tokens: 100,
			},
			{
				phase: "response",
				context_utilization_pct: null,
				stop_reason: "error",
				error_type: "rate_limit_error",
				error_code: "rate_limit_exceeded",
				error_status: "rate_limited",
				input_tokens: 0,
				output_tokens: 0,
			},
		]);
		expect(report.response.contextBands).toEqual({
			under50: {
				responses: 1,
				terminals: { end_turn: 1 },
				zeroCacheResponses: 1,
				weightedCacheReusePct: 0,
			},
			from50To80: {
				responses: 1,
				terminals: { max_tokens: 1 },
				zeroCacheResponses: 0,
				weightedCacheReusePct: 50,
			},
			from80To95: {
				responses: 1,
				terminals: { refusal: 1 },
				zeroCacheResponses: 1,
				weightedCacheReusePct: null,
			},
			atLeast95: {
				responses: 1,
				terminals: { tool_use: 1 },
				zeroCacheResponses: 0,
				weightedCacheReusePct: 100,
			},
			unavailable: {
				responses: 1,
				terminals: { error: 1 },
				zeroCacheResponses: 0,
				weightedCacheReusePct: null,
			},
		});
		expect(report.response.stopReasons).toEqual({
			end_turn: 1,
			max_tokens: 1,
			refusal: 1,
			tool_use: 1,
			error: 1,
		});
		expect(report.response.zeroCacheResponses).toBe(2);
		expect(report.response.weightedCacheReusePct).toBe(50);
		expect(report.response.usage).toEqual({
			inputTokens: 500,
			outputTokens: 10,
			cacheReadInputTokens: 250,
			cacheCreationInputTokens: 2,
			availableResponses: 5,
			unavailableResponses: 0,
		});
		expect(report.response.errors).toEqual({ rate_limit_error: 1 });
		expect(report.response.errorCodes).toEqual({ rate_limit_exceeded: 1 });
		expect(report.response.errorStatuses).toEqual({ rate_limited: 1 });
	});

	test("keeps schema 6 and schema 7 records compatible in one report", () => {
		const report = analyzeCodexTrace([
			{
				trace_schema_version: 6,
				phase: "response",
				stop_reason: "error",
				error_type: "legacy",
			},
			{ trace_schema_version: 7, phase: "response", stop_reason: "max_tokens" },
		]);
		expect(report.response.stopReasons).toEqual({ error: 1, max_tokens: 1 });
		expect(report.response.errors).toEqual({ legacy: 1 });
	});

	test("classifies a shorter complete input as measurably changed", () => {
		const fingerprints = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				index,
				bytes: index + 1,
				hmac: `fp-${index}`,
			}));
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "1",
				prompt_cache_key_id: "key",
				input_item_total_count: 3,
				input_item_fingerprints: fingerprints(3),
				input_item_fingerprints_truncated: false,
			},
			{
				phase: "request",
				ts: "2",
				prompt_cache_key_id: "key",
				input_item_total_count: 2,
				input_item_fingerprints: fingerprints(2),
				input_item_fingerprints_truncated: false,
			},
		]);
		expect(report.request.prefixTransitions.measurableChanged).toBe(1);
		expect(report.request.prefixTransitions.unavailableAbsentFingerprints).toBe(
			0,
		);
	});

	test("excludes missing cache telemetry from zero-cache and weighted reuse", () => {
		const report = analyzeCodexTrace([
			{ phase: "response", input_tokens: 900 },
			{
				phase: "response",
				input_tokens: 100,
				cache_read_input_tokens: 50,
			},
		]);
		expect(report.response.zeroCacheResponses).toBe(0);
		expect(report.response.weightedCacheReusePct).toBe(50);
	});

	test("classifies a missing retained boundary as a measurable prefix change", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "1",
				prompt_cache_key_id: "key",
				input_item_total_count: 2,
				input_item_fingerprints: [
					{ index: 0, bytes: 1, hmac: "a" },
					{ index: 1, bytes: 2, hmac: "b" },
				],
			},
			{
				phase: "request",
				ts: "2",
				prompt_cache_key_id: "key",
				input_item_total_count: 3,
				input_item_fingerprints: [
					{ index: 0, bytes: 1, hmac: "a" },
					{ index: 2, bytes: 3, hmac: "c" },
				],
			},
		]);
		expect(report.request.prefixTransitions.measurableChanged).toBe(1);
		expect(report.request.prefixTransitions.unavailableAbsentFingerprints).toBe(
			0,
		);
	});

	test("compares schema 8 canary arms with measured denominators and turn statistics", () => {
		const report = analyzeCodexTrace([
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "c1",
				ts: "1",
				cache_key_assignment: "conversation",
				cache_key_assignment_source: "canary",
				cache_key_mode: "conversation",
				conversation_id: "conversation-a",
				model_out: "gpt-control",
				account: "account-control",
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "c2",
				ts: "2",
				cache_key_assignment: "conversation",
				cache_key_assignment_source: "explicit_session_override",
				cache_key_mode: "session",
				conversation_id: "conversation-a",
				model_out: "gpt-control",
				account: "account-control",
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "s1",
				ts: "3",
				cache_key_assignment: "session",
				cache_key_assignment_source: "canary",
				cache_key_mode: "conversation",
				conversation_id: "conversation-b",
				model_out: "gpt-treatment",
				account: "account-treatment",
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "s2",
				ts: "4",
				cache_key_assignment: "session",
				cache_key_assignment_source: "canary",
				cache_key_mode: "session",
				conversation_id: "conversation-b",
				model_out: "gpt-treatment",
				account: "account-treatment",
			},
			{
				phase: "response",
				request_id: "c1",
				stop_reason: "end_turn",
				input_tokens: 100,
				output_tokens: 10,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 5,
			},
			{
				phase: "response",
				request_id: "c2",
				stop_reason: "error",
				input_tokens: 900,
				output_tokens: 20,
				cache_read_input_tokens: 900,
			},
			{
				phase: "response",
				request_id: "s1",
				stop_reason: "refusal",
				input_tokens: 200,
				output_tokens: 30,
			},
			{
				phase: "response",
				request_id: "s2",
				stop_reason: "max_tokens",
				input_tokens: 300,
				output_tokens: 40,
				cache_read_input_tokens: 150,
			},
		]);

		expect(report.canary.conversation.assignedRequests).toBe(2);
		expect(report.canary.conversation.joinedTerminalResponses).toBe(2);
		expect(report.canary.conversation.missingTerminalRequests).toBe(0);
		expect(report.canary.conversation.cacheMeasuredResponses).toBe(2);
		expect(report.canary.conversation.weightedCacheReusePct).toBe(90);
		expect(report.canary.conversation.cachePositiveResponses).toBe(1);
		expect(report.canary.conversation.cachePositiveRatePct).toBe(50);
		expect(report.canary.conversation.usage).toEqual({
			inputTokens: 1_000,
			outputTokens: 30,
			cacheReadInputTokens: 900,
			cacheCreationInputTokens: 5,
			availableResponses: 2,
			unavailableResponses: 0,
		});
		expect(report.canary.conversation.terminals).toEqual({
			end_turn: 1,
			error: 1,
		});
		expect(report.canary.conversation.effectiveModes).toEqual({
			conversation: 1,
			session: 1,
		});
		expect(report.canary.conversation.explicitCrossovers).toEqual({
			conversationToSession: 1,
			sessionToConversation: 0,
		});
		expect(report.canary.conversation.models).toEqual({ "gpt-control": 2 });
		expect(report.canary.conversation.accounts).toEqual({
			"account-control": 2,
		});
		expect(report.canary.conversation.logicalConversations).toBe(1);
		expect(report.canary.conversation.turns.first).toMatchObject({
			requests: 1,
			cacheMeasuredResponses: 1,
			weightedCacheReusePct: 0,
			cachePositiveRatePct: 0,
		});
		expect(report.canary.conversation.turns.followUp).toMatchObject({
			requests: 1,
			cacheMeasuredResponses: 1,
			weightedCacheReusePct: 100,
			cachePositiveRatePct: 100,
		});
		expect(report.canary.conversation.conversationTurnBands).toEqual({
			"2": 2,
		});
		expect(report.canary.session.terminals).toEqual({
			refusal: 1,
			max_tokens: 1,
		});
		expect(report.canary.session.cacheMeasuredResponses).toBe(1);
		expect(report.canary.session.weightedCacheReusePct).toBe(50);
		expect(report.canary.session.cachePositiveRatePct).toBe(100);
		expect(report.canary.session.effectiveModes).toEqual({
			conversation: 1,
			session: 1,
		});
		expect(report.canary.session.explicitCrossovers).toEqual({
			conversationToSession: 0,
			sessionToConversation: 1,
		});
		expect(report.canary.session.turns.first.cacheMeasuredResponses).toBe(0);
		expect(report.canary.session.turns.followUp.weightedCacheReusePct).toBe(50);
	});

	test("uses retained conversation records for turn bands and mode-independent indexing", () => {
		const report = analyzeCodexTrace([
			{
				trace_schema_version: 7,
				phase: "request",
				request_id: "old",
				ts: "1",
				conversation_id: "shared",
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "assigned-1",
				ts: "2",
				cache_key_assignment: "session",
				cache_key_mode: "conversation",
				conversation_id: "shared",
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "assigned-2",
				ts: "3",
				cache_key_assignment: "session",
				cache_key_mode: "session",
				conversation_id: "shared",
			},
			{
				phase: "response",
				request_id: "assigned-1",
				input_tokens: 100,
				cache_read_input_tokens: 25,
			},
		]);

		expect(report.canary.session.turns.first.requests).toBe(0);
		expect(report.canary.session.turns.followUp.requests).toBe(2);
		expect(report.canary.session.conversationTurnBands).toEqual({ "3": 2 });
		expect(report.canary.session.missingTerminalRequests).toBe(1);
		expect(report.canary.unassigned.assignedRequests).toBe(1);
	});

	test("keeps compatibility traffic unassigned and reports orphan responses", () => {
		const report = analyzeCodexTrace([
			{ trace_schema_version: 6, phase: "request", request_id: "legacy-6" },
			{ trace_schema_version: 7, phase: "request", request_id: "legacy-7" },
			{ trace_schema_version: 7, phase: "request" },
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "eligible",
				cache_key_assignment: "conversation",
				cache_key_mode: "conversation",
			},
			{ phase: "response", request_id: "legacy-6", stop_reason: "end_turn" },
			{ phase: "response", request_id: "orphan", stop_reason: "error" },
		]);

		expect(report.canary.unassigned.assignedRequests).toBe(3);
		expect(report.canary.unassigned.joinedTerminalResponses).toBe(1);
		expect(report.canary.unassigned.missingTerminalRequests).toBe(2);
		expect(report.canary.conversation.missingTerminalRequests).toBe(1);
		expect(report.canary.unjoinedResponses).toBe(1);
	});

	test("retains duplicate logical IDs as distinct attempts without ambiguous joins", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "duplicate",
				attempt_id: "attempt-1",
				attempt_ordinal: 1,
				cache_key_assignment: "conversation",
				cache_key_mode: "conversation",
			},
			{
				phase: "request",
				request_id: "duplicate",
				attempt_id: "attempt-2",
				attempt_ordinal: 2,
				cache_key_assignment: "session",
				cache_key_mode: "session",
			},
			{
				phase: "response",
				request_id: "duplicate",
				attempt_id: "attempt-1",
				input_tokens: 100,
				cache_read_input_tokens: 0,
			},
			{
				phase: "response",
				request_id: "duplicate",
				attempt_id: "attempt-2",
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
		]);

		expect(report.logicalRequests).toBe(1);
		expect(report.attempts).toBe(2);
		expect(report.joins).toEqual({ missing: 0, ambiguous: 0 });
		expect(report.canary.conversation.assignedRequests).toBe(0);
		expect(report.canary.session.assignedRequests).toBe(1);
		expect(report.canary.conversation.weightedCacheReusePct).toBeNull();
		expect(report.canary.session.weightedCacheReusePct).toBe(100);
		expect(report.cacheDenominators.attemptInclusive.measuredResponses).toBe(2);
		expect(report.cacheDenominators.finalResponseOnly.measuredResponses).toBe(
			1,
		);
		expect(
			report.cacheDenominators.finalResponseOnly.weightedCacheReusePct,
		).toBe(100);
	});

	test("reports experiment readiness with sliding request-rate concentration", () => {
		const records = Array.from({ length: 16 }, (_, index) => ({
			phase: "request" as const,
			request_id: `r-${index}`,
			attempt_id: `a-${index}`,
			ts: new Date(
				Date.parse("2026-07-10T00:00:55Z") + index * 1000,
			).toISOString(),
			cache_key_assignment: "conversation" as const,
			cache_key_mode:
				index === 0 ? ("session" as const) : ("conversation" as const),
			prompt_cache_key_id: "concentrated-key",
		}));
		const report = analyzeCodexTrace(records);
		expect(report.readiness.treatmentAbsent).toBe(true);
		expect(report.readiness.assignmentEffectiveCrossovers).toBe(1);
		expect(report.readiness.keysOver15RequestsPerMinute).toBe(1);
		expect(report.readiness.maxRequestsPerKeyMinute).toBe(16);
	});

	test("counts one canary turn per logical request and selects its final joined attempt", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "logical",
				attempt_id: "first",
				attempt_ordinal: 1,
				ts: "2026-07-10T00:00:00Z",
				conversation_id: "conversation",
				cache_key_assignment: "conversation",
				cache_key_mode: "conversation",
			},
			{
				phase: "request",
				request_id: "logical",
				attempt_id: "final",
				attempt_ordinal: 2,
				ts: "2026-07-10T00:00:01Z",
				conversation_id: "conversation",
				cache_key_assignment: "session",
				cache_key_mode: "session",
			},
			{
				phase: "response",
				request_id: "logical",
				attempt_id: "first",
				usage_measurement_available: true,
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 0,
			},
			{
				phase: "response",
				request_id: "logical",
				attempt_id: "final",
				usage_measurement_available: true,
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 80,
			},
		]);
		expect(report.canary.conversation.assignedRequests).toBe(0);
		expect(report.canary.session.assignedRequests).toBe(1);
		expect(report.canary.session.turns.first.requests).toBe(1);
		expect(report.canary.session.weightedCacheReusePct).toBe(80);
	});

	test("excludes ambiguous attempt IDs and unknown cache measurements", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "ambiguous",
				attempt_id: "duplicate",
				cache_key_assignment: "session",
			},
			{
				phase: "request",
				request_id: "ambiguous",
				attempt_id: "duplicate",
				cache_key_assignment: "session",
			},
			{
				phase: "response",
				request_id: "ambiguous",
				attempt_id: "duplicate",
				usage_measurement_available: true,
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
			{
				phase: "request",
				request_id: "unknown-usage",
				attempt_id: "unknown-attempt",
				cache_key_assignment: "session",
			},
			{
				phase: "response",
				request_id: "unknown-usage",
				attempt_id: "unknown-attempt",
				usage_measurement_available: false,
				cache_measurement_available: false,
				input_tokens: null,
				cache_read_input_tokens: null,
			},
		]);
		expect(report.canary.session.assignedRequests).toBe(2);
		expect(report.canary.session.cacheMeasuredResponses).toBe(0);
		expect(report.cacheDenominators.attemptInclusive.measuredResponses).toBe(0);
		expect(report.cacheDenominators.finalResponseOnly.measuredResponses).toBe(
			0,
		);
	});

	test("uses only unambiguous one-to-one joins for attempt-inclusive cache stats", () => {
		const report = analyzeCodexTrace([
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "schema9-good",
				attempt_id: "attempt-good",
				attempt_ordinal: 1,
			},
			{
				trace_schema_version: 9,
				phase: "response",
				request_id: "schema9-good",
				attempt_id: "attempt-good",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 50,
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "legacy-good",
			},
			{
				trace_schema_version: 8,
				phase: "response",
				request_id: "legacy-good",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 25,
			},
			{
				trace_schema_version: 9,
				phase: "response",
				request_id: "orphan",
				attempt_id: "orphan-attempt",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "duplicate-request",
				attempt_id: "duplicate-attempt",
			},
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "duplicate-request",
				attempt_id: "duplicate-attempt",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				request_id: "duplicate-request",
				attempt_id: "duplicate-attempt",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
			{
				trace_schema_version: 8,
				phase: "request",
				request_id: "duplicate-response",
			},
			{
				trace_schema_version: 8,
				phase: "response",
				request_id: "duplicate-response",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
			{
				trace_schema_version: 8,
				phase: "response",
				request_id: "duplicate-response",
				cache_measurement_available: true,
				input_tokens: 100,
				cache_read_input_tokens: 100,
			},
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "request-only",
				attempt_id: "request-only-attempt",
			},
		]);

		expect(report.cacheDenominators.attemptInclusive.measuredResponses).toBe(2);
		expect(
			report.cacheDenominators.attemptInclusive.weightedCacheReusePct,
		).toBe(37.5);
	});

	test("computes key concentration for large distinct key sets without spreading", () => {
		const records = Array.from({ length: 150_000 }, (_, index) => ({
			phase: "request" as const,
			request_id: `r-${index}`,
			ts: "2026-07-10T00:00:00Z",
			prompt_cache_key_id: `key-${index}`,
		}));
		const report = analyzeCodexTrace(records);
		expect(report.readiness.maxRequestsPerKeyMinute).toBe(1);
		expect(report.readiness.keysOver15RequestsPerMinute).toBe(0);
	});

	test("reports usage availability counts that distinguish unavailable from measured zero", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "available-zero",
				attempt_id: "available-attempt",
				cache_key_assignment: "conversation",
				cache_key_mode: "conversation",
			},
			{
				phase: "response",
				request_id: "available-zero",
				attempt_id: "available-attempt",
				usage_measurement_available: true,
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			{
				phase: "request",
				request_id: "unavailable",
				attempt_id: "unavailable-attempt",
				cache_key_assignment: "conversation",
				cache_key_mode: "conversation",
			},
			{
				phase: "response",
				request_id: "unavailable",
				attempt_id: "unavailable-attempt",
				usage_measurement_available: false,
				input_tokens: null,
				output_tokens: null,
				cache_creation_input_tokens: null,
			},
		]);

		expect(report.response.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			availableResponses: 1,
			unavailableResponses: 1,
		});
		expect(report.canary.conversation.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			availableResponses: 1,
			unavailableResponses: 1,
		});
	});

	test("does not substitute an earlier joined retry when the final attempt is missing", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				request_id: "logical-missing-final",
				attempt_id: "joined-earlier",
				attempt_ordinal: 1,
				cache_key_assignment: "conversation",
			},
			{
				phase: "response",
				request_id: "logical-missing-final",
				attempt_id: "joined-earlier",
				input_tokens: 100,
				cache_read_input_tokens: 90,
			},
			{
				phase: "request",
				request_id: "logical-missing-final",
				attempt_id: "missing-final",
				attempt_ordinal: 2,
				cache_key_assignment: "session",
			},
		]);

		expect(report.canary.conversation.assignedRequests).toBe(0);
		expect(report.canary.session.assignedRequests).toBe(1);
		expect(report.canary.session.joinedTerminalResponses).toBe(0);
		expect(report.canary.session.missingTerminalRequests).toBe(1);
		expect(report.canary.session.cacheMeasuredResponses).toBe(0);
		expect(report.cacheDenominators.finalResponseOnly.measuredResponses).toBe(
			0,
		);
	});

	test("counts mixed schema 6-8 duplicate logical IDs as ambiguous joins", () => {
		const report = analyzeCodexTrace([
			{ trace_schema_version: 6, phase: "request", request_id: "legacy" },
			{ trace_schema_version: 8, phase: "request", request_id: "legacy" },
			{ trace_schema_version: 8, phase: "response", request_id: "legacy" },
		]);
		expect(report.logicalRequests).toBe(1);
		expect(report.attempts).toBe(2);
		expect(report.joins.ambiguous).toBe(1);
	});

	test("counts missing request and response sides without last-write-wins", () => {
		const report = analyzeCodexTrace([
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "missing-response",
				attempt_id: "request-only",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				request_id: "missing-request",
				attempt_id: "response-only",
			},
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "duplicate-attempt",
				attempt_id: "duplicate-id",
			},
			{
				trace_schema_version: 9,
				phase: "request",
				request_id: "duplicate-attempt",
				attempt_id: "duplicate-id",
			},
			{
				trace_schema_version: 9,
				phase: "response",
				request_id: "duplicate-attempt",
				attempt_id: "duplicate-id",
			},
		]);
		expect(report.joins).toEqual({ missing: 2, ambiguous: 1 });
		expect(report.response.unjoinedResponses).toBe(2);
	});

	test("formats explicit canary denominators and crossover labels", () => {
		const text = formatReport(
			analyzeCodexTrace([
				{
					phase: "request",
					request_id: "r1",
					cache_key_assignment: "conversation",
					cache_key_assignment_source: "explicit_session_override",
					cache_key_mode: "session",
				},
				{
					phase: "response",
					request_id: "r1",
					input_tokens: 100,
					cache_read_input_tokens: 50,
				},
			]),
		);

		expect(text).toContain("CONVERSATION VS SESSION CANARY");
		expect(text).toContain("cache positive: 1/1 measured (100%)");
		expect(text).toContain("conversation->session=1");
		expect(text).toContain("session->conversation=0");
		expect(text).toContain("unjoined responses: 0");
	});

	test("handles request volumes above the engine argument limit", () => {
		const request = { phase: "request" as const, input_item_count: 1 };
		const report = analyzeCodexTrace(
			Array.from({ length: 150_000 }, () => request),
		);
		expect(report.requests).toBe(150_000);
		expect(report.request.maxInputItems).toBe(1);
	});

	test("parseTraceJsonl skips blank, malformed, and non-object lines", () => {
		const recs = parseTraceJsonl(
			'{"phase":"request"}\n\nnot-json\nnull\n42\n[]\n{"phase":"response"}\n',
		);
		expect(recs.length).toBe(2);
		expect(() => analyzeCodexTrace(recs)).not.toThrow();
	});
});
