import { describe, expect, test } from "bun:test";
import { analyzeCodexTrace, parseTraceJsonl } from "./analyze-trace";

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
