import { describe, expect, test } from "bun:test";
import {
	analyzeCodexCacheExperiments,
	formatCacheExperimentReport,
	parseCodexWebSocketObservationsJsonl,
	type TraceRecord,
} from "./analyze-trace";

function tracePair(
	requestId: string,
	attemptId: string,
	response: Partial<TraceRecord> = {},
	request: Partial<TraceRecord> = {},
): TraceRecord[] {
	return [
		{
			trace_schema_version: 11,
			phase: "request",
			ts: "2026-07-22T12:00:00.000Z",
			request_id: requestId,
			attempt_id: attemptId,
			...request,
		},
		{
			trace_schema_version: 11,
			phase: "response",
			ts: "2026-07-22T12:00:01.000Z",
			request_id: requestId,
			attempt_id: attemptId,
			stop_reason: "end_turn",
			input_tokens: 100,
			cache_read_input_tokens: 20,
			cache_creation_input_tokens: 0,
			cache_creation_measurement_available: true,
			...response,
		},
	];
}

function observation(
	requestId: string,
	attemptId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		requestId,
		attemptId,
		assignment: "treatment",
		effectiveTransport: "websocket",
		frameWritten: true,
		fallbackReason: null,
		fallbackAllowedBeforeWrite: false,
		closeCategory: null,
		terminalMs: 500,
		inputTokens: 1_000,
		cachedReadTokens: 800,
		cacheWriteTokens: 100,
		cacheWriteMeasurementAvailable: true,
		...overrides,
	};
}

function loggerJsonl(...observations: Record<string, unknown>[]): string {
	return observations
		.map((data) => JSON.stringify({ msg: "codex_ws_transport", data }))
		.join("\n");
}

describe("Codex WebSocket cache experiment analysis", () => {
	test("aggregates selected treatment, observe-only and non-allowlisted controls, pre-write fallback, and post-write terminal error", () => {
		const parsed = parseCodexWebSocketObservationsJsonl(
			loggerJsonl(
				observation("treatment", "treatment-attempt"),
				observation("observe", "observe-attempt", {
					assignment: "control",
					effectiveTransport: "http",
					frameWritten: false,
					fallbackReason: "observe_only",
					terminalMs: null,
					inputTokens: null,
					cachedReadTokens: null,
					cacheWriteTokens: null,
					cacheWriteMeasurementAvailable: false,
				}),
				observation("not-allowed", "not-allowed-attempt", {
					assignment: "control",
					effectiveTransport: "http",
					frameWritten: false,
					fallbackReason: "cohort_not_allowlisted",
					terminalMs: null,
					inputTokens: null,
					cachedReadTokens: null,
					cacheWriteTokens: null,
					cacheWriteMeasurementAvailable: false,
				}),
				observation("pre-write", "pre-write-attempt", {
					effectiveTransport: "http",
					frameWritten: false,
					fallbackReason: "handshake_timeout",
					fallbackAllowedBeforeWrite: true,
					terminalMs: null,
					inputTokens: null,
					cachedReadTokens: null,
					cacheWriteTokens: null,
					cacheWriteMeasurementAvailable: false,
				}),
				observation("post-write", "post-write-attempt", {
					fallbackReason: "upstream_terminal_error",
					closeCategory: "response.failed",
					terminalMs: 750,
					inputTokens: null,
					cachedReadTokens: null,
					cacheWriteTokens: null,
					cacheWriteMeasurementAvailable: false,
				}),
			),
		);
		const report = analyzeCodexCacheExperiments(
			[
				...tracePair("treatment", "treatment-attempt"),
				...tracePair("observe", "observe-attempt", {
					input_tokens: 200,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 25,
				}),
				...tracePair("not-allowed", "not-allowed-attempt"),
				...tracePair("pre-write", "pre-write-attempt", {
					input_tokens: 400,
					cache_read_input_tokens: 300,
				}),
				...tracePair("post-write", "post-write-attempt", {
					stop_reason: "error",
				}),
			],
			parsed,
		);

		expect(report.websocket.assignmentCounts).toEqual({
			control: 2,
			treatment: 3,
		});
		expect(report.websocket.effectiveTransportCounts).toEqual({
			http: 3,
			websocket: 2,
		});
		expect(report.websocket.ingestion).toMatchObject({
			acceptedObservations: 5,
			uniqueObservations: 5,
			joinedObservations: 5,
			unjoinedObservations: 0,
		});

		const treatment = report.websocket.rows.find(
			(row) => row.action === "websocket_terminal",
		);
		expect(treatment).toMatchObject({
			assignment: "treatment",
			effectiveTransport: "websocket",
			observations: 1,
			cache: {
				measuredResponses: 1,
				inputTokens: 1_000,
				cachedReadTokens: 800,
				weightedCachedReadPct: 80,
				cacheWriteMeasuredResponses: 1,
				cacheWriteTokens: 100,
			},
			latency: { availableResponses: 1, p50Ms: 500, p95Ms: 500 },
			outcomes: {
				terminalResponses: 1,
				terminalErrors: 0,
				preWriteHttpFallbacks: 0,
				postWriteFailures: 0,
				fallbackCategories: { none: 1 },
			},
		});

		const observe = report.websocket.rows.find(
			(row) => row.action === "observe_only",
		);
		expect(observe).toMatchObject({
			assignment: "control",
			effectiveTransport: "http",
			cache: {
				inputTokens: 200,
				cachedReadTokens: 100,
				cacheWriteMeasuredResponses: 1,
				cacheWriteTokens: 25,
			},
			latency: { availableResponses: 1, p50Ms: 1_000 },
			outcomes: { fallbackCategories: { control: 1 } },
		});
		expect(
			report.websocket.rows.find(
				(row) => row.action === "cohort_not_allowlisted",
			),
		).toMatchObject({ assignment: "control", observations: 1 });
		expect(
			report.websocket.rows.find((row) => row.action === "handshake_timeout"),
		).toMatchObject({
			outcomes: {
				preWriteHttpFallbacks: 1,
				postWriteFailures: 0,
				fallbackCategories: { pre_write: 1 },
			},
		});
		expect(
			report.websocket.rows.find(
				(row) => row.action === "upstream_terminal_error",
			),
		).toMatchObject({
			outcomes: {
				terminalResponses: 1,
				terminalErrors: 1,
				preWriteHttpFallbacks: 0,
				postWriteFailures: 1,
				fallbackCategories: { post_write: 1 },
			},
		});
	});

	test("keeps measured zero cache writes distinct from unavailable cache writes", () => {
		const parsed = parseCodexWebSocketObservationsJsonl(
			loggerJsonl(
				observation("zero", "zero-attempt", {
					cacheWriteTokens: 0,
					cacheWriteMeasurementAvailable: true,
				}),
				observation("missing", "missing-attempt", {
					cacheWriteTokens: null,
					cacheWriteMeasurementAvailable: false,
				}),
			),
		);
		const report = analyzeCodexCacheExperiments(
			[
				...tracePair("zero", "zero-attempt"),
				...tracePair("missing", "missing-attempt"),
			],
			parsed,
		);

		expect(report.websocket.rows).toHaveLength(1);
		expect(report.websocket.rows[0]?.cache).toMatchObject({
			cacheWriteMeasuredResponses: 1,
			cacheWriteUnavailableResponses: 1,
			cacheWriteTokens: 0,
		});
	});

	test("excludes duplicate observations, future schemas, malformed records, and ambiguous exact joins", () => {
		const duplicate = observation("duplicate", "duplicate-attempt");
		const parsed = parseCodexWebSocketObservationsJsonl(
			[
				JSON.stringify({ msg: "codex_ws_transport", data: duplicate }),
				JSON.stringify({ msg: "codex_ws_transport", data: duplicate }),
				JSON.stringify({
					msg: "codex_ws_transport",
					data: {
						...observation("future", "future-attempt"),
						observationSchemaVersion: 2,
					},
				}),
				JSON.stringify({
					msg: "codex_ws_transport",
					data: { assignment: "treatment" },
				}),
				"not-json",
				JSON.stringify({ msg: "unrelated", data: duplicate }),
				JSON.stringify({
					MESSAGE: JSON.stringify({
						msg: "codex_ws_transport",
						data: observation("ambiguous", "ambiguous-attempt"),
					}),
				}),
			].join("\n"),
		);
		const ambiguousPair = tracePair("ambiguous", "ambiguous-attempt");
		const report = analyzeCodexCacheExperiments(
			[
				...tracePair("duplicate", "duplicate-attempt"),
				...ambiguousPair,
				{ ...ambiguousPair[1] },
			],
			parsed,
		);

		expect(parsed.diagnostics).toEqual({
			lines: 7,
			acceptedLines: 3,
			ignoredLines: 1,
			malformedLines: 2,
			futureSchemaLines: 1,
		});
		expect(report.websocket.ingestion).toMatchObject({
			duplicateObservationGroups: 1,
			uniqueObservations: 1,
			joinedObservations: 0,
			unjoinedObservations: 1,
			ambiguousTraceJoins: 1,
		});
		expect(report.websocket.assignmentCounts).toEqual({
			control: 0,
			treatment: 1,
		});
		expect(report.websocket.rows[0]).toMatchObject({
			observations: 1,
			joinedTraceResponses: 0,
			unjoinedObservations: 1,
		});
	});

	test("joins only when both request and attempt identities match exactly", () => {
		const parsed = parseCodexWebSocketObservationsJsonl(
			loggerJsonl(
				observation("logical-a", "attempt-shared"),
				observation("logical-good", "attempt-good"),
			),
		);
		const mismatched = tracePair("logical-b", "attempt-shared");
		const report = analyzeCodexCacheExperiments(
			[...mismatched, ...tracePair("logical-good", "attempt-good")],
			parsed,
		);

		expect(report.websocket.ingestion).toMatchObject({
			joinedObservations: 1,
			unjoinedObservations: 1,
		});
		expect(report.websocket.rows[0]).toMatchObject({
			observations: 2,
			joinedTraceResponses: 1,
			unjoinedObservations: 1,
		});
	});

	test("accepts direct, logger, journald-json, and pretty journal records without formatting private fields", () => {
		const privateObservation = {
			...observation("private-request", "private-attempt", {
				fallbackReason: "private-future-reason",
			}),
			accountId: "private-account",
			model: "private-model",
			cohortId: "private-cohort",
			connectionId: "private-connection",
			endpoint: "https://private.example.test/responses",
			prompt: "private prompt body",
		};
		const pretty = `[2026-07-22T12:00:00.000Z] WARN: [CodexWebSocketTransport] codex_ws_transport ${JSON.stringify(
			observation("pretty-request", "pretty-attempt"),
		)}`;
		const parsed = parseCodexWebSocketObservationsJsonl(
			[
				JSON.stringify(privateObservation),
				JSON.stringify({
					msg: "codex_ws_transport",
					data: observation("logger-request", "logger-attempt"),
				}),
				JSON.stringify({
					MESSAGE: JSON.stringify({
						msg: "codex_ws_transport",
						data: observation("journal-request", "journal-attempt"),
					}),
				}),
				JSON.stringify({ MESSAGE: pretty }),
			].join("\n"),
		);
		const report = analyzeCodexCacheExperiments(
			[
				...tracePair("private-request", "private-attempt"),
				...tracePair("logger-request", "logger-attempt"),
				...tracePair("journal-request", "journal-attempt"),
				...tracePair("pretty-request", "pretty-attempt"),
			],
			parsed,
		);
		const text = formatCacheExperimentReport(report);

		expect(parsed.diagnostics.acceptedLines).toBe(4);
		expect(text).toContain("WEBSOCKET TRANSPORT CANARY");
		expect(text).toContain('"action":"other"');
		for (const secret of [
			"private-request",
			"private-attempt",
			"private-account",
			"private-model",
			"private-cohort",
			"private-connection",
			"private.example.test",
			"private prompt body",
			"private-future-reason",
		]) {
			expect(text).not.toContain(secret);
		}
	});
});
