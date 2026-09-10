// KTD7 (Defect 2) -- the attempt-scoped tail validator and the move-only
// handoff that hands it the upstream reader, the SSE parser's partial
// buffer, and the transport abort capability once a response-id-owned
// attempt reaches its terminal boundary.
//
// Two layers of coverage, deliberately kept separate:
//
// 1. Direct unit tests of `runCodexResponseIdTailValidator` itself, called
//    through a minimal white-box cast. The validator's own outcome
//    (clean EOF / invalid tail / deadline / read error / cancellation) is a
//    private, exactly-once, race-sensitive state machine that is only
//    reliably testable by controlling exactly when a fabricated reader's
//    read() calls resolve -- doing that through the full HTTP/SSE/
//    processResponse stack would make the "later read" / "deadline" /
//    "cancellation-after-resolution" scenarios inherently timing-fragile
//    (real streaming Responses in Bun typically deliver an entire small
//    string body as a single read(), so there is no reliable black-box way
//    to force a SECOND read() to land after the first from outside).
// 2. Integration tests through the real `provider.processResponse` ->
//    `processEvents` -> move-only handoff path, proving the actual
//    production wiring (not just the validator in isolation): the client
//    stream really does close at the terminal boundary without waiting for
//    the tail, and the non-eligible (failed handoff) path really does still
//    tear the transport down via the pre-existing cleanup code.
import { describe, expect, it, spyOn } from "bun:test";
import { BUFFER_SIZES, SseFrameBuffer } from "@better-ccflare/core";
import {
	CODEX_AUTHENTICATED_CALLER_HEADER,
	CODEX_DEFAULT_ENDPOINT,
	CODEX_NATIVE_RESPONSES_HEADER,
	CodexProvider,
} from "./provider";

const physicalModel = "gpt-5.6-sol";
const callerDigest =
	"caller-digest-tail-validator-0000000000000000000000000000000000000000";
const account = {
	id: "account-tail-validator",
	name: "codex-tail-validator-test",
	provider: "codex",
	custom_endpoint: null,
	model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
} as Parameters<CodexProvider["transformRequestBody"]>[1];

/**
 * White-box bridge: only the private surface these tests actually touch.
 * `runCodexResponseIdTailValidator` is not otherwise reachable -- it is
 * launched detached (`void ...`, never returned or awaited) from
 * `processEvents` -- so calling it directly through this cast is the only
 * way to control read timing precisely enough for the deadline/cancellation/
 * later-read scenarios below.
 */
type StreamStateForTest = {
	traceAttemptId?: string;
	responseIdTerminal: { responseId: string; output: unknown[] } | null;
	responseIdTailTainted?: boolean;
	responseIdDoneSeenAfterTerminal?: boolean;
};
type LaneStateForTest = {
	responseId: string;
	digests: string[];
	configDigest: string;
	expiresAt: number;
	chargedBytes: number;
	lastUsedAt: number;
};
type LaneEntryForTest = {
	generation: number;
	state?: LaneStateForTest;
	tombstonedAt?: number;
};
type PendingCandidateForTest = {
	lane: string;
	generation: number;
	requestDigests: string[];
	configDigest: string;
	chargedBytes: number;
	ts: number;
};
type CodexProviderInternalsForTest = {
	responseIdLanes: Map<string, LaneEntryForTest>;
	pendingResponseIdByAttempt: Map<string, PendingCandidateForTest>;
	codexResponseIdLaneKey: (
		accountId: string | undefined,
		model: string,
		callerDigestArg: string | null,
		sessionIdentity: string | null,
	) => string;
	releaseCodexResponseIdAttempt: (attemptId: string | null | undefined) => void;
	commitCodexResponseIdCheckpoint: (state: StreamStateForTest) => void;
	runCodexResponseIdTailValidator: (params: {
		state: StreamStateForTest;
		reader: ReadableStreamDefaultReader<Uint8Array>;
		sseFrameBuffer: SseFrameBuffer;
		drainAbort?: AbortController;
		deadlineMs: number;
		cancelSignal: AbortSignal;
	}) => Promise<void>;
};
function internals(provider: CodexProvider): CodexProviderInternalsForTest {
	return provider as unknown as CodexProviderInternalsForTest;
}

function freshSseFrameBuffer(): SseFrameBuffer {
	return new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});
}

/** A reader whose read() resolves immediately to EOF -- true clean end of stream. */
function eofOnlyReader(): ReadableStreamDefaultReader<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	}).getReader();
}

/** Delivers each string as its OWN separate read() result, then EOF. */
function queuedChunkReader(
	chunks: string[],
): ReadableStreamDefaultReader<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	}).getReader();
}

/** A reader whose read() never resolves on its own -- only deadline/cancel can end it. */
function hungForeverReader(): ReadableStreamDefaultReader<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start() {
			/* never enqueue, never close */
		},
	}).getReader();
}

function terminalFor(responseId: string, outputText: string) {
	return {
		responseId,
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: outputText }],
			},
		],
	};
}

function seedPendingCandidate(
	provider: CodexProvider,
	attemptId: string,
	lane: string,
	generation: number,
): PendingCandidateForTest {
	const candidate: PendingCandidateForTest = {
		lane,
		generation,
		requestDigests: ["digest-req-1"],
		configDigest: "cfg-1",
		chargedBytes: 128,
		ts: Date.now(),
	};
	internals(provider).pendingResponseIdByAttempt.set(attemptId, candidate);
	return candidate;
}

async function waitUntil(
	predicate: () => boolean,
	{ timeoutMs = 2_000, intervalMs = 10 } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("waitUntil: condition never became true within timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

describe("CodexProvider KTD7 tail validator (Defect 2) -- direct unit tests of runCodexResponseIdTailValidator", () => {
	it("completion then [DONE] then clean EOF promotes", async () => {
		const provider = new CodexProvider();
		const attemptId = "aid-clean-eof";
		const lane = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			"session-clean-eof",
		);
		seedPendingCandidate(provider, attemptId, lane, 1);
		const state: StreamStateForTest = {
			traceAttemptId: attemptId,
			responseIdTerminal: terminalFor("resp-clean-eof", "hello"),
		};

		await internals(provider).runCodexResponseIdTailValidator({
			state,
			reader: eofOnlyReader(),
			sseFrameBuffer: freshSseFrameBuffer(),
			drainAbort: new AbortController(),
			deadlineMs: 1_000,
			cancelSignal: new AbortController().signal,
		});

		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);
		expect(
			internals(provider).responseIdLanes.get(lane)?.state?.responseId,
		).toBe("resp-clean-eof");
	});

	it("a duplicate completion / data-bearing frame arriving on the validator's own (later) read does not promote, and aborts the transport", async () => {
		const provider = new CodexProvider();
		const attemptId = "aid-later-frame";
		const lane = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			"session-later-frame",
		);
		seedPendingCandidate(provider, attemptId, lane, 1);
		const state: StreamStateForTest = {
			traceAttemptId: attemptId,
			responseIdTerminal: terminalFor("resp-later-frame", "hello"),
		};
		const drainAbort = new AbortController();

		await internals(provider).runCodexResponseIdTailValidator({
			state,
			// The validator's very own first read() IS "a later read" relative
			// to the chunk processEvents already scanned for a same-chunk tail
			// before handing off -- this data-bearing frame simulates exactly
			// that later-read case.
			reader: queuedChunkReader([
				'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-dup"}}\n\n',
			]),
			sseFrameBuffer: freshSseFrameBuffer(),
			drainAbort,
			deadlineMs: 1_000,
			cancelSignal: new AbortController().signal,
		});

		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);
		expect(
			internals(provider).responseIdLanes.get(lane)?.state,
		).toBeUndefined();
		expect(state.responseIdTailTainted).toBe(true);
		expect(drainAbort.signal.aborted).toBe(true);
	});

	it("a partial trailing frame straddling the read boundary does not promote", async () => {
		const provider = new CodexProvider();
		const attemptId = "aid-partial-frame";
		const lane = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			"session-partial-frame",
		);
		seedPendingCandidate(provider, attemptId, lane, 1);
		const state: StreamStateForTest = {
			traceAttemptId: attemptId,
			responseIdTerminal: terminalFor("resp-partial-frame", "hello"),
		};

		await internals(provider).runCodexResponseIdTailValidator({
			state,
			// First read: a frame with no terminating blank line (never
			// completes) -- sseFrameBuffer.push returns zero complete frames
			// and retains it as a carried partial. Second read: true EOF, so
			// flush() at EOF returns those leftover bytes non-empty.
			reader: queuedChunkReader([
				'event: response.output_text.delta\ndata: {"partial":true}',
			]),
			sseFrameBuffer: freshSseFrameBuffer(),
			drainAbort: new AbortController(),
			deadlineMs: 1_000,
			cancelSignal: new AbortController().signal,
		});

		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);
		expect(
			internals(provider).responseIdLanes.get(lane)?.state,
		).toBeUndefined();
	});

	it("a stalled tail hits the deadline, does not promote, and still tears the transport down", async () => {
		const provider = new CodexProvider();
		const attemptId = "aid-deadline";
		const lane = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			"session-deadline",
		);
		seedPendingCandidate(provider, attemptId, lane, 1);
		const state: StreamStateForTest = {
			traceAttemptId: attemptId,
			responseIdTerminal: terminalFor("resp-deadline", "hello"),
		};
		const drainAbort = new AbortController();

		const startedAt = Date.now();
		await internals(provider).runCodexResponseIdTailValidator({
			state,
			reader: hungForeverReader(),
			sseFrameBuffer: freshSseFrameBuffer(),
			drainAbort,
			deadlineMs: 25,
			cancelSignal: new AbortController().signal,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);
		expect(
			internals(provider).responseIdLanes.get(lane)?.state,
		).toBeUndefined();
		expect(drainAbort.signal.aborted).toBe(true);
		// One monotonic budget: the loop's own deadline (25ms) plus at most
		// one settlement grace of the same size (mirrors, never stacks
		// beyond, drainReaderWithDeadline's read-plus-settlement shape) --
		// generously bounded well under a real 30s production deadline.
		expect(elapsedMs).toBeLessThan(2_000);
	}, 5_000);

	it("cancellation resolves the candidate, and a redundant cancel signal arriving AFTER resolution is a pure no-op (exactly-once CAS, no second release)", async () => {
		const provider = new CodexProvider();
		const attemptId = "aid-cancel-once";
		const lane = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			"session-cancel-once",
		);
		seedPendingCandidate(provider, attemptId, lane, 1);
		const state: StreamStateForTest = {
			traceAttemptId: attemptId,
			responseIdTerminal: terminalFor("resp-cancel-once", "hello"),
		};
		const drainAbort = new AbortController();
		const releaseSpy = spyOn(
			internals(provider),
			"releaseCodexResponseIdAttempt",
		);
		const commitSpy = spyOn(
			internals(provider),
			"commitCodexResponseIdCheckpoint",
		);

		// Deadline (not cancellation) resolves this one -- deliberately shorter
		// than the cancel below arrives, so the outcome is already settled by
		// the time the "late" cancel signal fires.
		const cancelController = new AbortController();
		await internals(provider).runCodexResponseIdTailValidator({
			state,
			reader: hungForeverReader(),
			sseFrameBuffer: freshSseFrameBuffer(),
			drainAbort,
			deadlineMs: 20,
			cancelSignal: cancelController.signal,
		});

		expect(releaseSpy.mock.calls.length + commitSpy.mock.calls.length).toBe(1);
		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);

		// The validator has already fully returned (its `finally` already ran
		// and released the reader lock). A cancel signal arriving now must not
		// re-invoke anything: no second terminal trace, no double release.
		cancelController.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(releaseSpy.mock.calls.length + commitSpy.mock.calls.length).toBe(1);
	});
});

describe("CodexProvider KTD7 tail validator (Defect 2) -- integration through processResponse", () => {
	const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
	const eventLine = (name: string, data: unknown) => [
		`event: ${name}`,
		`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
		"",
	];

	/**
	 * Mirrors `provider.cache-replay.test.ts`'s helper of the same name: the
	 * lane-continuation prefix match (`isDigestPrefixMatch` inside
	 * `selectCodexResponseIdOwner`) requires the NEXT request's digested
	 * `input` to carry the committed checkpoint's
	 * `[...requestDigests, ...outputDigests]` as a literal prefix -- so a
	 * "verify" call proving/disproving promotion must resend the prior user
	 * turn AND echo the prior assistant turn verbatim (matching the SSE
	 * fixture's `outputText`), not just repeat the first user message. Callers
	 * pass the full `messages` array directly for exactly this reason.
	 */
	function nativeResponseIdRequestFor(params: {
		requestId: string;
		attemptId: string;
		messages: unknown[];
	}): Request {
		const { requestId, attemptId, messages } = params;
		return new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-attempt-id": attemptId,
				"x-better-ccflare-attempt-ordinal": "1",
				"x-better-ccflare-attempt-cause": "initial",
				"x-better-ccflare-final-model": physicalModel,
				[CODEX_NATIVE_RESPONSES_HEADER]: "1",
				[CODEX_AUTHENTICATED_CALLER_HEADER]: callerDigest,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 100,
				stream: true,
				system: "Keep the same turn.",
				metadata: {
					user_id: JSON.stringify({
						session_id: "33333333-3333-4333-8333-333333333333",
					}),
				},
				messages,
				__better_ccflare_codex_passthrough: {
					continuation_strategy: "previous_response_id",
				},
			}),
		});
	}

	/** A controllable upstream SSE stream: bytes are pushed on demand, never auto-closed. */
	function controllableUpstream(headers: Record<string, string>): {
		response: Response;
		push: (text: string) => void;
		close: () => void;
	} {
		const encoder = new TextEncoder();
		let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controllerRef = controller;
			},
		});
		return {
			response: new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream", ...headers },
			}),
			push: (text: string) => controllerRef.enqueue(encoder.encode(text)),
			close: () => controllerRef.close(),
		};
	}

	it("delivers the client terminal frame without waiting for upstream EOF, and a data-bearing frame that arrives on the upstream's later, still-pending read does not promote the checkpoint", async () => {
		const provider = new CodexProvider();
		const requestId = "rid-tail-integration";
		const attemptId = "aid-tail-integration";
		const outputText = "hello";
		const coldMessages = [
			{ role: "user", content: "inspect the tail lifecycle" },
		];

		const seedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId,
				attemptId,
				messages: coldMessages,
			}),
			account,
		);
		await seedRequest.json();

		const upstream = controllableUpstream({
			"x-better-ccflare-request-id": requestId,
			"x-better-ccflare-attempt-id": attemptId,
			"x-better-ccflare-final-model": physicalModel,
			"x-better-ccflare-request-stream": "true",
		});
		const transformed = await provider.processResponse(upstream.response, null);

		// The terminal chunk: response.created + response.completed + [DONE],
		// nothing else -- a same-chunk-clean terminal that is eligible for the
		// move-only handoff.
		upstream.push(
			sseBody([
				...eventLine("response.created", {
					type: "response.created",
					response: { id: "resp-tail-integration", model: physicalModel },
				}),
				...eventLine("response.completed", {
					type: "response.completed",
					response: {
						id: "resp-tail-integration",
						model: physicalModel,
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: outputText }],
							},
						],
						usage: { input_tokens: 5, output_tokens: 1 },
					},
				}),
				...eventLine("[DONE]", "[DONE]"),
			]),
		);

		// Client delivery must not wait for checkpoint validation: this
		// resolves even though the upstream stream above is still open (never
		// closed) and no further bytes have been pushed yet.
		const clientText = await transformed.text();
		expect(clientText).toContain("message_stop");
		// no error should have been emitted on the clean path
		expect(clientText).not.toContain("abrupt_stream_eof");

		// NOW, well after the client already has its full terminal response, a
		// duplicate completion arrives on the upstream's own later read.
		upstream.push(
			sseBody([
				...eventLine("response.completed", {
					type: "response.completed",
					response: { id: "resp-tail-integration-dup", model: physicalModel },
				}),
			]),
		);
		upstream.close();

		await waitUntil(
			() => !internals(provider).pendingResponseIdByAttempt.has(attemptId),
		);

		// Wire-observable proof of "must not promote": a genuine continuation
		// of this exact conversation (prior user turn + echoed assistant turn,
		// matching `isDigestPrefixMatch`'s required prefix) still gets no
		// previous_response_id, because the checkpoint was never promoted.
		const continuedMessages = [
			...coldMessages,
			{ role: "assistant", content: [{ type: "text", text: outputText }] },
			{ role: "user", content: "continue please" },
		];
		const verifyRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-tail-integration-verify",
				attemptId: "aid-tail-integration-verify",
				messages: continuedMessages,
			}),
			account,
		);
		const verifyBody = (await verifyRequest.json()) as Record<string, unknown>;
		expect(verifyBody.previous_response_id).toBeUndefined();
	});

	it("a same-chunk-tainted terminal (failed/ineligible handoff) still tears the upstream transport down via the existing cleanup path -- no leaked reader", async () => {
		const provider = new CodexProvider();
		const requestId = "rid-failed-handoff";
		const attemptId = "aid-failed-handoff";
		const outputText = "hello";
		const coldMessages = [
			{ role: "user", content: "inspect the failed handoff path" },
		];

		const seedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId,
				attemptId,
				messages: coldMessages,
			}),
			account,
		);
		await seedRequest.json();

		const frames = [
			...eventLine("response.created", {
				type: "response.created",
				response: { id: "resp-failed-handoff", model: physicalModel },
			}),
			...eventLine("response.completed", {
				type: "response.completed",
				response: {
					id: "resp-failed-handoff",
					model: physicalModel,
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: outputText }],
						},
					],
				},
			}),
			...eventLine("[DONE]", "[DONE]"),
			// A duplicate completion in the SAME chunk taints the tail
			// same-chunk scan, making the move-only handoff ineligible: this
			// exercises "If the handoff cannot complete atomically, discard the
			// candidate and keep the existing cleanup path unchanged."
			...eventLine("response.completed", {
				type: "response.completed",
				response: { id: "resp-failed-handoff-dup", model: physicalModel },
			}),
		];
		const upstream = new Response(sseBody(frames), {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-attempt-id": attemptId,
				"x-better-ccflare-final-model": physicalModel,
				"x-better-ccflare-request-stream": "true",
			},
		});

		const transformed = await provider.processResponse(upstream, null);
		const clientText = await transformed.text();
		expect(clientText).toContain("message_stop");

		// The existing (non-handoff) cleanup path's own drain-then-release
		// (`cancelUpstreamOnce` -> `drainUpstream`) is intentionally launched
		// detached (`void drainUpstream().catch(...)`, never awaited by
		// `processEvents` itself) so the client-facing stream is not held open
		// waiting for it -- so proving "no leaked reader" here means polling
		// the lock itself, not just the candidate bookkeeping (which clears
		// synchronously, before that detached drain has necessarily settled).
		await waitUntil(() => upstream.body?.locked === false);
		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);

		// Tainted checkpoint must not have been promoted either.
		const continuedMessages = [
			...coldMessages,
			{ role: "assistant", content: [{ type: "text", text: outputText }] },
			{ role: "user", content: "continue please" },
		];
		const verifyRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-failed-handoff-verify",
				attemptId: "aid-failed-handoff-verify",
				messages: continuedMessages,
			}),
			account,
		);
		const verifyBody = (await verifyRequest.json()) as Record<string, unknown>;
		expect(verifyBody.previous_response_id).toBeUndefined();
	});
});
