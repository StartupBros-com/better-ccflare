import { describe, expect, test } from "bun:test";

import {
	canonicalHostedSearchSourceIdentity,
	createHostedSearchLifecycleReducer,
	HOSTED_SEARCH_LIFECYCLE_LIMITS,
	HOSTED_SEARCH_SOURCE_RECONCILIATION_POLICY,
	HostedSearchLifecycleError,
	type HostedSearchLifecycleErrorCode,
	type HostedSearchResultErrorCode,
	type HostedSearchSourceInput,
} from "./hosted-search-lifecycle";

const RESULT_ERROR_CODES = [
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
	"query_too_long",
	"request_too_large",
	"unavailable",
] as const satisfies readonly HostedSearchResultErrorCode[];

const TERMINAL_REASONS = [
	"end_turn",
	"tool_use",
	"max_tokens",
	"refusal",
	"incomplete",
	"error",
] as const;

function callId(label: string): string {
	return `srvtoolu_${label}`;
}

function source(
	ref = "src-one",
	overrides: Partial<HostedSearchSourceInput> = {},
): HostedSearchSourceInput {
	return {
		sourceRef: ref,
		url: `https://example.com/${ref}`,
		title: `Source ${ref}`,
		pageAge: null,
		...overrides,
	};
}

function canonicalUrlWithBytes(byteLength: number, label = "u"): string {
	const prefix = `https://example.com/${label}/`;
	if (byteLength < prefix.length) throw new Error("URL fixture is too short");
	return `${prefix}${"a".repeat(byteLength - prefix.length)}`;
}

function expectLifecycleError(
	operation: () => unknown,
	code: HostedSearchLifecycleErrorCode,
): HostedSearchLifecycleError {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(HostedSearchLifecycleError);
		expect((error as HostedSearchLifecycleError).code).toBe(code);
		return error as HostedSearchLifecycleError;
	}
	throw new Error("expected hosted-search lifecycle error");
}

function startCall(
	reducer: ReturnType<typeof createHostedSearchLifecycleReducer>,
	label: string,
	query = `query ${label}`,
): string {
	const id = callId(label);
	reducer.accept({ type: "declared", callId: id });
	reducer.accept({ type: "dispatched", callId: id });
	reducer.accept({ type: "query_known", callId: id, queryOrdinal: 0, query });
	reducer.accept({ type: "searching", callId: id });
	return id;
}

function completeCall(
	reducer: ReturnType<typeof createHostedSearchLifecycleReducer>,
	label: string,
	sources: readonly HostedSearchSourceInput[] = [source(`src-${label}`)],
) {
	const id = startCall(reducer, label);
	return reducer.accept({ type: "result", callId: id, sources });
}

function completeErroredCall(
	reducer: ReturnType<typeof createHostedSearchLifecycleReducer>,
	label: string,
	errorCode: HostedSearchResultErrorCode = "unavailable",
): void {
	const id = startCall(reducer, label);
	reducer.accept({ type: "result_error", callId: id, errorCode });
}

describe("hosted-search lifecycle semantics", () => {
	test("accepts only public opaque call IDs and enforces monotonic transitions", () => {
		const invalid = createHostedSearchLifecycleReducer();
		expectLifecycleError(
			() => invalid.accept({ type: "declared", callId: "private-item-id" }),
			"invalid_event",
		);

		const reducer = createHostedSearchLifecycleReducer();
		const id = callId("monotonic");
		expectLifecycleError(
			() => reducer.accept({ type: "searching", callId: id }),
			"out_of_order_event",
		);
		reducer.accept({ type: "declared", callId: id });
		expect(
			reducer.accept({
				type: "query_known",
				callId: id,
				queryOrdinal: 0,
				query: "visible query",
			}),
		).toEqual({
			type: "query_known",
			callId: id,
			queryOrdinal: 0,
			query: "visible query",
		});
		reducer.accept({ type: "dispatched", callId: id });
		reducer.accept({ type: "searching", callId: id });
		expectLifecycleError(
			() =>
				reducer.accept({
					type: "query_known",
					callId: id,
					queryOrdinal: 0,
					query: "changed",
				}),
			"duplicate_event",
		);

		const invalidOrdinal = createHostedSearchLifecycleReducer();
		const invalidOrdinalId = callId("invalid-query-ordinal");
		invalidOrdinal.accept({ type: "declared", callId: invalidOrdinalId });
		expectLifecycleError(
			() =>
				invalidOrdinal.accept({
					type: "query_known",
					callId: invalidOrdinalId,
					queryOrdinal: 1,
					query: "second query profile is disabled",
				} as never),
			"invalid_event",
		);

		const event = reducer.accept({
			type: "result",
			callId: id,
			sources: [source("src-monotonic")],
		});
		expect(event).toEqual({
			type: "result",
			callId: id,
			queryOrdinal: 0,
			query: "visible query",
			state: "result",
			sources: [
				{
					...source("src-monotonic"),
					ordinal: 0,
				},
			],
		});
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.isFrozen(event.sources)).toBe(true);
		expect(Object.isFrozen(event.sources[0])).toBe(true);
	});

	test("exports one call-scoped exact source reconciliation policy", () => {
		const identity = canonicalHostedSearchSourceIdentity({
			callId: callId("identity"),
			sourceRef: "src-7",
		});
		expect(identity).toEqual({
			callId: callId("identity"),
			sourceRef: "src-7",
		});
		expect(Object.isFrozen(identity)).toBe(true);
		expect(HOSTED_SEARCH_SOURCE_RECONCILIATION_POLICY).toEqual({
			scope: "call",
			identity: "source_ref",
			duplicate: "exact_visible_evidence_only",
			conflict: "reject",
			ordinal: "first_finalized_result_order",
		});
	});

	test("deduplicates an exact sourceRef observation and rejects conflicting reuse", () => {
		const reducer = createHostedSearchLifecycleReducer();
		const repeated = source("src-repeat", { pageAge: "today" });
		const result = completeCall(reducer, "source-reconcile", [
			repeated,
			{ ...repeated },
			source("src-distinct", {
				url: repeated.url,
				title: repeated.title,
				pageAge: repeated.pageAge,
			}),
		]);
		expect(
			result.sources.map(({ sourceRef, ordinal }) => ({ sourceRef, ordinal })),
		).toEqual([
			{ sourceRef: "src-repeat", ordinal: 0 },
			{ sourceRef: "src-distinct", ordinal: 1 },
		]);
		expect(result.sources[0]?.pageAge).toBe("today");

		const conflict = createHostedSearchLifecycleReducer();
		const id = startCall(conflict, "source-conflict");
		expectLifecycleError(
			() =>
				conflict.accept({
					type: "result",
					callId: id,
					sources: [
						source("src-conflict"),
						source("src-conflict", { title: "Conflicting title" }),
					],
				}),
			"invalid_event",
		);
		expect(conflict.snapshot().activeCallAssemblies).toBe(1);
	});

	test("represents honest zero results distinctly", () => {
		const reducer = createHostedSearchLifecycleReducer();
		const result = completeCall(reducer, "empty", []);
		expect(result).toEqual({
			type: "result",
			callId: callId("empty"),
			queryOrdinal: 0,
			query: "query empty",
			state: "empty",
			sources: [],
		});
		expect(reducer.snapshot()).toMatchObject({
			completedSearchCalls: 1,
			successfulSearchCalls: 1,
			emptySearchCalls: 1,
			erroredSearchCalls: 0,
		});
	});

	test("accepts only six result errors after declared, query-known, and searching", () => {
		for (const errorCode of RESULT_ERROR_CODES) {
			const reducer = createHostedSearchLifecycleReducer();
			const id = startCall(reducer, `error-${errorCode}`);
			expect(
				reducer.accept({ type: "result_error", callId: id, errorCode }),
			).toEqual({
				type: "result_error",
				callId: id,
				queryOrdinal: 0,
				query: `query error-${errorCode}`,
				errorCode,
			});
			expect(reducer.snapshot()).toMatchObject({
				activeCallAssemblies: 0,
				compactCallProvenance: 1,
				erroredSearchCalls: 1,
			});
		}

		const missingQuery = createHostedSearchLifecycleReducer();
		const queryId = callId("missing-query");
		missingQuery.accept({ type: "declared", callId: queryId });
		missingQuery.accept({ type: "dispatched", callId: queryId });
		missingQuery.accept({ type: "searching", callId: queryId });
		expectLifecycleError(
			() =>
				missingQuery.accept({
					type: "result_error",
					callId: queryId,
					errorCode: "unavailable",
				}),
			"out_of_order_event",
		);

		const missingSearch = createHostedSearchLifecycleReducer();
		const searchId = callId("missing-search");
		missingSearch.accept({ type: "declared", callId: searchId });
		missingSearch.accept({ type: "dispatched", callId: searchId });
		missingSearch.accept({
			type: "query_known",
			callId: searchId,
			queryOrdinal: 0,
			query: "known",
		});
		expectLifecycleError(
			() =>
				missingSearch.accept({
					type: "result_error",
					callId: searchId,
					errorCode: "unavailable",
				}),
			"out_of_order_event",
		);
	});
});

describe("answer text and citations", () => {
	test("resolves citations only through exact finalized call/source refs", () => {
		const reducer = createHostedSearchLifecycleReducer();
		completeCall(reducer, "citation", [source("src-citation")]);
		reducer.accept({
			type: "answer_text_started",
			blockId: "answer-1",
			text: "A😀B source",
		});
		const citation = reducer.accept({
			type: "citation",
			blockId: "answer-1",
			callId: callId("citation"),
			sourceRef: "src-citation",
			citationOrdinal: 0,
			originalIndex: 7,
			startCharIndex: 1,
			endCharIndex: 3,
		});
		expect(citation).toEqual({
			type: "citation",
			blockId: "answer-1",
			callId: callId("citation"),
			sourceRef: "src-citation",
			sourceOrdinal: 0,
			citationOrdinal: 0,
			originalIndex: 7,
			startCharIndex: 1,
			endCharIndex: 3,
			citedText: "😀",
			source: {
				...source("src-citation"),
				ordinal: 0,
			},
		});

		expectLifecycleError(
			() =>
				reducer.accept({
					type: "citation",
					blockId: "answer-1",
					callId: callId("citation"),
					sourceRef: "src-absent",
					citationOrdinal: 1,
					originalIndex: 8,
					startCharIndex: 3,
					endCharIndex: 4,
				}),
			"invalid_event",
		);

		const other = createHostedSearchLifecycleReducer();
		completeCall(other, "call-a", [source("src-shared")]);
		completeCall(other, "call-b", [source("src-shared")]);
		other.accept({
			type: "answer_text_started",
			blockId: "ambiguous",
			text: "x",
		});
		expectLifecycleError(
			() =>
				other.accept({
					type: "citation",
					blockId: "ambiguous",
					callId: callId("missing-call"),
					sourceRef: "src-shared",
					citationOrdinal: 0,
					originalIndex: 0,
					startCharIndex: 0,
					endCharIndex: 1,
				}),
			"invalid_event",
		);
	});

	test("includes originalIndex in exact citation identity and preserves ordering", () => {
		const reducer = createHostedSearchLifecycleReducer();
		completeCall(reducer, "ordering", [source("src-ordering")]);
		reducer.accept({
			type: "answer_text_started",
			blockId: "ordering-block",
			text: "abcdef",
		});
		const base = {
			type: "citation" as const,
			blockId: "ordering-block",
			callId: callId("ordering"),
			sourceRef: "src-ordering",
			citationOrdinal: 0,
			originalIndex: 3,
			startCharIndex: 0,
			endCharIndex: 3,
		};
		reducer.accept(base);
		expectLifecycleError(() => reducer.accept({ ...base }), "duplicate_event");
		expectLifecycleError(
			() =>
				reducer.accept({
					...base,
					originalIndex: 4,
					startCharIndex: 2,
					endCharIndex: 5,
				}),
			"invalid_event",
		);
		expectLifecycleError(
			() =>
				reducer.accept({
					...base,
					citationOrdinal: 1,
					startCharIndex: 2,
					endCharIndex: 5,
				}),
			"invalid_event",
		);
		reducer.accept({
			...base,
			citationOrdinal: 1,
			originalIndex: 4,
			startCharIndex: 2,
			endCharIndex: 5,
		});
		const completed = reducer.accept({
			type: "answer_text_completed",
			blockId: "ordering-block",
		});
		expect(completed.type).toBe("cited_answer_text");
		expect(
			completed.citations.map(({ originalIndex }) => originalIndex),
		).toEqual([3, 4]);
		expect(completed.citations.map(({ citedText }) => citedText)).toEqual([
			"abc",
			"cde",
		]);
		expect(reducer.snapshot()).toMatchObject({
			activeCitationAssemblies: 0,
			releasedCitationAssemblies: 1,
			citationCount: 2,
		});
	});

	test("allows a completed answer-text block with zero citations", () => {
		const reducer = createHostedSearchLifecycleReducer();
		reducer.accept({
			type: "answer_text_started",
			blockId: "uncited-answer",
			text: "Plain answer",
		});
		expect(
			reducer.accept({
				type: "answer_text_completed",
				blockId: "uncited-answer",
			}),
		).toEqual({
			type: "cited_answer_text",
			blockId: "uncited-answer",
			text: "Plain answer",
			citations: [],
		});
	});

	test("rejects offsets that split a Unicode scalar", () => {
		const reducer = createHostedSearchLifecycleReducer();
		completeCall(reducer, "unicode", [source("src-unicode")]);
		reducer.accept({
			type: "answer_text_started",
			blockId: "unicode-block",
			text: "A😀B",
		});
		expectLifecycleError(
			() =>
				reducer.accept({
					type: "citation",
					blockId: "unicode-block",
					callId: callId("unicode"),
					sourceRef: "src-unicode",
					citationOrdinal: 0,
					originalIndex: 0,
					startCharIndex: 1,
					endCharIndex: 2,
				}),
			"invalid_event",
		);
	});
});

describe("terminal, finalization, and cleanup", () => {
	test("rejects every terminal reason while a call or answer block is unresolved", () => {
		for (const reason of TERMINAL_REASONS) {
			const active = createHostedSearchLifecycleReducer();
			active.accept({ type: "declared", callId: callId(`active-${reason}`) });
			expectLifecycleError(
				() => active.accept({ type: "terminal", reason }),
				"invalid_terminal",
			);
			expect(active.snapshot()).toMatchObject({
				status: "open",
				activeCallAssemblies: 1,
			});

			const text = createHostedSearchLifecycleReducer();
			text.accept({
				type: "answer_text_started",
				blockId: `text-${reason}`,
				text: "pending",
			});
			expectLifecycleError(
				() => text.accept({ type: "terminal", reason }),
				"invalid_terminal",
			);
			expect(text.snapshot().activeCitationAssemblies).toBe(1);
		}
	});

	test("finalize rejects missing/duplicate terminals and usage mismatch", () => {
		const missing = createHostedSearchLifecycleReducer();
		expectLifecycleError(() => missing.finalize(), "invalid_terminal");

		const mismatch = createHostedSearchLifecycleReducer();
		completeCall(mismatch, "usage-mismatch", []);
		mismatch.accept({ type: "usage_observation", webSearchRequests: 1 });
		mismatch.accept({ type: "usage_provider_report", webSearchRequests: 2 });
		mismatch.accept({ type: "terminal", reason: "end_turn" });
		expectLifecycleError(() => mismatch.finalize(), "invalid_terminal");
		expect(mismatch.snapshot().compactCallProvenance).toBe(1);

		const duplicate = createHostedSearchLifecycleReducer();
		duplicate.accept({ type: "usage_observation", webSearchRequests: 0 });
		duplicate.accept({ type: "terminal", reason: "end_turn" });
		expectLifecycleError(
			() => duplicate.accept({ type: "terminal", reason: "end_turn" }),
			"duplicate_event",
		);
	});

	test("reconciles usage to successful normal and empty searches, excluding errors", () => {
		const reducer = createHostedSearchLifecycleReducer();
		completeCall(reducer, "usage-result", [source("src-usage-result")]);
		completeCall(reducer, "usage-empty", []);
		completeErroredCall(reducer, "usage-error");
		reducer.accept({ type: "usage_observation", webSearchRequests: 2 });
		reducer.accept({ type: "usage_provider_report", webSearchRequests: 2 });
		reducer.accept({ type: "terminal", reason: "end_turn" });

		expect(reducer.finalize()).toMatchObject({
			status: "ready_for_encoding",
			completedSearchCalls: 3,
			observedWebSearchRequests: 2,
			providerReportedWebSearchRequests: 2,
			usageReconciliation: "match",
		});
		expect(reducer.snapshot()).toMatchObject({
			completedSearchCalls: 3,
			successfulSearchCalls: 2,
			emptySearchCalls: 1,
			erroredSearchCalls: 1,
		});
	});

	test("retains provenance through verdict and releases only after encoding completes", () => {
		const reducer = createHostedSearchLifecycleReducer();
		completeCall(reducer, "finalize", [source("src-finalize")]);
		reducer.accept({ type: "usage_observation", webSearchRequests: 1 });
		reducer.accept({ type: "usage_provider_report", webSearchRequests: 1 });
		reducer.accept({ type: "terminal", reason: "end_turn" });
		const before = reducer.snapshot();
		expect(before).toMatchObject({
			status: "terminal",
			compactCallProvenance: 1,
			retainedSourceProvenance: 1,
		});

		const verdict = reducer.finalize();
		expect(verdict).toEqual({
			status: "ready_for_encoding",
			terminalReason: "end_turn",
			completedSearchCalls: 1,
			observedWebSearchRequests: 1,
			providerReportedWebSearchRequests: 1,
			usageReconciliation: "match",
			uniqueSourceCount: 1,
			citationCount: 0,
			replayEnvelopeCount: 0,
		});
		expect(Object.isFrozen(verdict)).toBe(true);
		expect(reducer.snapshot()).toMatchObject({
			status: "finalized",
			compactCallProvenance: 1,
			retainedSourceProvenance: 1,
		});
		expectLifecycleError(() => reducer.finalize(), "duplicate_event");

		const complete = reducer.completeEncoding();
		expect(complete).toMatchObject({
			status: "complete",
			compactCallProvenance: 0,
			retainedSourceProvenance: 0,
			retainedSemanticIdentityBytes: 0,
			liveSemanticBytes: 0,
		});
	});

	test("abort releases unresolved state without fabricating a terminal", () => {
		const reducer = createHostedSearchLifecycleReducer();
		reducer.accept({ type: "declared", callId: callId("abort-active") });
		reducer.accept({
			type: "answer_text_started",
			blockId: "abort-text",
			text: "unresolved",
		});
		const aborted = reducer.abort();
		expect(aborted).toMatchObject({
			status: "aborted",
			terminalReason: null,
			activeCallAssemblies: 0,
			activeCitationAssemblies: 0,
			compactCallProvenance: 0,
			retainedSourceProvenance: 0,
			retainedSemanticIdentityBytes: 0,
			liveSemanticBytes: 0,
		});
		expectLifecycleError(() => reducer.abort(), "duplicate_event");
		expectLifecycleError(() => reducer.finalize(), "invalid_terminal");
	});
});

describe("bounds, enrichment budget, and redaction", () => {
	test("bounds active calls, per-call sources, response sources, and citations", () => {
		const active = createHostedSearchLifecycleReducer();
		for (
			let index = 0;
			index < HOSTED_SEARCH_LIFECYCLE_LIMITS.activeCalls;
			index += 1
		) {
			active.accept({ type: "declared", callId: callId(`active-${index}`) });
		}
		expectLifecycleError(
			() => active.accept({ type: "declared", callId: callId("active-over") }),
			"resource_limit_exceeded",
		);

		const perCall = createHostedSearchLifecycleReducer();
		const perCallId = startCall(perCall, "source-over");
		expectLifecycleError(
			() =>
				perCall.accept({
					type: "result",
					callId: perCallId,
					sources: Array.from(
						{ length: HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerCall + 1 },
						(_, index) => source(`src-over-${index}`),
					),
				}),
			"resource_limit_exceeded",
		);

		const response = createHostedSearchLifecycleReducer();
		for (let callIndex = 0; callIndex < 4; callIndex += 1) {
			completeCall(
				response,
				`response-${callIndex}`,
				Array.from(
					{ length: HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerCall },
					(_, sourceIndex) => source(`src-${callIndex}-${sourceIndex}`),
				),
			);
		}
		const responseId = startCall(response, "response-over");
		expectLifecycleError(
			() =>
				response.accept({
					type: "result",
					callId: responseId,
					sources: [source("src-256")],
				}),
			"resource_limit_exceeded",
		);

		const citations = createHostedSearchLifecycleReducer();
		completeCall(citations, "citation-limit", [source("src-citation-limit")]);
		const text = "x".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.citations + 1);
		citations.accept({
			type: "answer_text_started",
			blockId: "citations",
			text,
		});
		for (
			let index = 0;
			index < HOSTED_SEARCH_LIFECYCLE_LIMITS.citations;
			index += 1
		) {
			citations.accept({
				type: "citation",
				blockId: "citations",
				callId: callId("citation-limit"),
				sourceRef: "src-citation-limit",
				citationOrdinal: index,
				originalIndex: index,
				startCharIndex: index,
				endCharIndex: index + 1,
			});
		}
		expectLifecycleError(
			() =>
				citations.accept({
					type: "citation",
					blockId: "citations",
					callId: callId("citation-limit"),
					sourceRef: "src-citation-limit",
					citationOrdinal: 256,
					originalIndex: 256,
					startCharIndex: 256,
					endCharIndex: 257,
				}),
			"resource_limit_exceeded",
		);
	});

	test("enforces byte-exact N-1/N/N+1 URL and multibyte title caps", () => {
		const exercise = (
			label: string,
			overrides: Partial<HostedSearchSourceInput>,
			accepted: boolean,
		): void => {
			const reducer = createHostedSearchLifecycleReducer();
			const id = startCall(reducer, label);
			const operation = () =>
				reducer.accept({
					type: "result" as const,
					callId: id,
					sources: [source(`src-${label}`, overrides)],
				});
			if (accepted) expect(operation().type).toBe("result");
			else expectLifecycleError(operation, "resource_limit_exceeded");
		};

		for (const bytes of [
			HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes - 1,
			HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes,
		]) {
			exercise(
				`url-${bytes}`,
				{ url: canonicalUrlWithBytes(bytes, `url-${bytes}`) },
				true,
			);
		}
		exercise(
			"url-plus-one",
			{
				url: canonicalUrlWithBytes(
					HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes + 1,
					"url-plus-one",
				),
			},
			false,
		);

		const titleN = "é".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.titleBytes / 2);
		exercise("title-minus-one", { title: `${titleN.slice(0, -1)}a` }, true);
		exercise("title-n", { title: titleN }, true);
		exercise("title-plus-one", { title: `${titleN}a` }, false);
	});

	test("enforces byte-exact N-1/N/N+1 multibyte query caps", () => {
		const exercise = (
			label: string,
			query: string,
			accepted: boolean,
		): void => {
			const reducer = createHostedSearchLifecycleReducer();
			const id = callId(label);
			reducer.accept({ type: "declared", callId: id });
			const operation = () =>
				reducer.accept({
					type: "query_known" as const,
					callId: id,
					queryOrdinal: 0 as const,
					query,
				});
			if (accepted) {
				expect(operation()).toMatchObject({ queryOrdinal: 0, query });
			} else {
				expectLifecycleError(operation, "resource_limit_exceeded");
			}
		};
		const exact = "😀".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.queryBytes / 4);
		exercise("query-minus-one", `${exact.slice(0, -2)}aaa`, true);
		exercise("query-n", exact, true);
		exercise("query-plus-one", `${exact}a`, false);
	});

	test("enforces byte-exact N-1/N/N+1 multibyte cited text", () => {
		const exercise = (label: string, text: string, accepted: boolean): void => {
			const reducer = createHostedSearchLifecycleReducer();
			completeCall(reducer, label, [source(`src-${label}`)]);
			reducer.accept({ type: "answer_text_started", blockId: label, text });
			const operation = () =>
				reducer.accept({
					type: "citation" as const,
					blockId: label,
					callId: callId(label),
					sourceRef: `src-${label}`,
					citationOrdinal: 0,
					originalIndex: 0,
					startCharIndex: 0,
					endCharIndex: text.length,
				});
			if (accepted) expect(operation().type).toBe("citation");
			else expectLifecycleError(operation, "resource_limit_exceeded");
		};
		const exact = "😀".repeat(
			HOSTED_SEARCH_LIFECYCLE_LIMITS.citedTextBytes / 4,
		);
		exercise("cited-minus-one", `${exact.slice(0, -2)}aaa`, true);
		exercise("cited-n", exact, true);
		exercise("cited-plus-one", `${exact}a`, false);
	});

	test("keeps replay tokens out of native events while enforcing token and 512-envelope budgets", () => {
		const native = createHostedSearchLifecycleReducer();
		const nativeId = startCall(native, "native-token-reject");
		expectLifecycleError(
			() =>
				native.accept({
					type: "result",
					callId: nativeId,
					sources: [
						{
							...source("src-native-token"),
							replayToken: "must-not-enter-native-state",
						},
					],
				} as never),
			"invalid_event",
		);

		const reducer = createHostedSearchLifecycleReducer();
		const exact = "😀".repeat(
			HOSTED_SEARCH_LIFECYCLE_LIMITS.replayTokenBytes / 4,
		);
		expect(
			reducer.recordReplayEnvelope(`${exact.slice(0, -2)}aaa`),
		).toMatchObject({
			byteLength: HOSTED_SEARCH_LIFECYCLE_LIMITS.replayTokenBytes - 1,
		});
		expect(reducer.recordReplayEnvelope(exact)).toMatchObject({
			byteLength: HOSTED_SEARCH_LIFECYCLE_LIMITS.replayTokenBytes,
		});
		expectLifecycleError(
			() => reducer.recordReplayEnvelope(`${exact}a`),
			"resource_limit_exceeded",
		);

		const aggregate = createHostedSearchLifecycleReducer();
		for (
			let index = 0;
			index < HOSTED_SEARCH_LIFECYCLE_LIMITS.replayEnvelopes;
			index += 1
		) {
			aggregate.recordReplayEnvelope("x");
		}
		expectLifecycleError(
			() => aggregate.recordReplayEnvelope("x"),
			"resource_limit_exceeded",
		);
		expect(aggregate.snapshot().replayEnvelopeCount).toBe(512);
	});

	test("accepts exactly 1 MiB live semantic state and rejects one byte more", () => {
		const buildFillBase = () => {
			const reducer = createHostedSearchLifecycleReducer();
			let sourceIndex = 0;
			while (
				HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes -
					reducer.snapshot().liveSemanticBytes >
				100_000
			) {
				const label = `semantic-source-${sourceIndex.toString().padStart(4, "0")}`;
				completeCall(reducer, label, [
					source(`src-${label}`, {
						url: canonicalUrlWithBytes(
							HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes,
							label,
						),
						title: "é".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.titleBytes / 2),
					}),
				]);
				sourceIndex += 1;
			}
			let errorIndex = 0;
			while (
				HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes -
					reducer.snapshot().liveSemanticBytes >
				7_800
			) {
				completeErroredCall(
					reducer,
					`semantic-error-${errorIndex.toString().padStart(5, "0")}`,
				);
				errorIndex += 1;
			}
			const fillId = callId("semantic-exact-fill");
			reducer.accept({ type: "declared", callId: fillId });
			reducer.accept({ type: "dispatched", callId: fillId });
			return { reducer, fillId };
		};

		const probe = createHostedSearchLifecycleReducer();
		probe.accept({ type: "declared", callId: callId("query-overhead") });
		const before = probe.snapshot().liveSemanticBytes;
		probe.accept({
			type: "query_known",
			callId: callId("query-overhead"),
			queryOrdinal: 0,
			query: "",
		});
		const queryOverhead = probe.snapshot().liveSemanticBytes - before;

		const exact = buildFillBase();
		const fillBytes =
			HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes -
			exact.reducer.snapshot().liveSemanticBytes -
			queryOverhead;
		expect(fillBytes).toBeGreaterThanOrEqual(0);
		expect(fillBytes).toBeLessThan(HOSTED_SEARCH_LIFECYCLE_LIMITS.queryBytes);
		exact.reducer.accept({
			type: "query_known",
			callId: exact.fillId,
			queryOrdinal: 0,
			query: "q".repeat(fillBytes),
		});
		expect(exact.reducer.snapshot().liveSemanticBytes).toBe(
			HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes,
		);

		const overflow = buildFillBase();
		expectLifecycleError(
			() =>
				overflow.reducer.accept({
					type: "query_known",
					callId: overflow.fillId,
					queryOrdinal: 0,
					query: "q".repeat(fillBytes + 1),
				}),
			"resource_limit_exceeded",
		);
	});

	test("keeps the former 3.68 MiB repeated citation-key shape compact", () => {
		const reducer = createHostedSearchLifecycleReducer();
		const largeSource = source("src-repeated-key", {
			url: canonicalUrlWithBytes(
				HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes,
				"repeated-key",
			),
			title: "é".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.titleBytes / 2),
		});
		completeCall(reducer, "repeated-key", [largeSource]);
		reducer.recordReplayEnvelope(
			"😀".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.replayTokenBytes / 4),
		);
		const text = "x".repeat(HOSTED_SEARCH_LIFECYCLE_LIMITS.citations);
		reducer.accept({
			type: "answer_text_started",
			blockId: "repeated-key-block",
			text,
		});
		for (
			let index = 0;
			index < HOSTED_SEARCH_LIFECYCLE_LIMITS.citations;
			index += 1
		) {
			reducer.accept({
				type: "citation",
				blockId: "repeated-key-block",
				callId: callId("repeated-key"),
				sourceRef: "src-repeated-key",
				citationOrdinal: index,
				originalIndex: index,
				startCharIndex: index,
				endCharIndex: index + 1,
			});
		}
		const snapshot = reducer.snapshot();
		expect(snapshot.citationCount).toBe(256);
		expect(snapshot.retainedSemanticIdentityBytes).toBeLessThan(128 * 1024);
		expect(snapshot.retainedSemanticIdentityBytes).toBeLessThanOrEqual(
			snapshot.liveSemanticBytes,
		);
	});

	test("reconstructs forged typed errors without leaking hostile content", () => {
		const reducer = createHostedSearchLifecycleReducer();
		const secret = "PRIVATE_SENTINEL_91e7";
		const proxyThrowing = (thrown: unknown): unknown =>
			new Proxy(Object.create(null) as object, {
				getOwnPropertyDescriptor() {
					throw thrown;
				},
			});

		for (const external of [
			new HostedSearchLifecycleError("resource_limit_exceeded"),
			new (class extends HostedSearchLifecycleError {})("duplicate_event"),
			Object.assign(
				Object.create(HostedSearchLifecycleError.prototype) as object,
				{ code: "out_of_order_event" },
			),
		]) {
			Object.assign(external, {
				message: `hostile:${secret}`,
				stack: `hostile-stack:${secret}`,
			});
			const expectedCode = (
				external as { code: HostedSearchLifecycleErrorCode }
			).code;
			const reconstructed = expectLifecycleError(
				() => reducer.accept(proxyThrowing(external)),
				expectedCode,
			);
			expect(reconstructed).not.toBe(external);
			expect(reconstructed.message).not.toContain(secret);
			expect(reconstructed.stack).not.toContain(secret);
			expect(JSON.stringify(reconstructed)).not.toContain(secret);
		}

		const revocable = Proxy.revocable(Object.create(null) as object, {});
		revocable.revoke();
		const revoked = expectLifecycleError(
			() => reducer.accept(revocable.proxy),
			"invalid_event",
		);
		expect(revoked.message).not.toContain(secret);

		const generic = expectLifecycleError(
			() => reducer.accept(proxyThrowing(new Error(`generic:${secret}`))),
			"invalid_event",
		);
		expect(generic.message).not.toContain(secret);
		expect(generic.stack).not.toContain(secret);

		const recycledSecret = "PRIVATE_RECYCLED_SENTINEL_5d34";
		const recycled = expectLifecycleError(
			() => reducer.accept({ type: "declared", callId: "private-recycled" }),
			"invalid_event",
		);
		Object.assign(recycled, {
			message: `hostile:${recycledSecret}`,
			stack: `hostile-stack:${recycledSecret}`,
		});
		const reconstructed = expectLifecycleError(
			() => reducer.accept(proxyThrowing(recycled)),
			"invalid_event",
		);
		expect(reconstructed).not.toBe(recycled);
		expect(reconstructed.message).not.toContain(recycledSecret);
		expect(reconstructed.stack).not.toContain(recycledSecret);
		expect(JSON.stringify(reconstructed)).not.toContain(recycledSecret);
	});
});
