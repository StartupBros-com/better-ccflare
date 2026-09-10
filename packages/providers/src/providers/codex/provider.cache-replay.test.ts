// KTD6/KTD7/KTD13 -- native Codex Responses response-id continuation.
//
// Separate from provider.test.ts's turn-state coverage: these tests exercise
// the native-Responses-lane `previous_response_id` checkpoint mechanism
// (provider.ts's "Native response-id continuation" block), its exclusivity
// against the fork's own turn-state continuation, and its KTD13 retention
// ceilings. All assertions read the actual wire payload (the outbound
// `Request`'s JSON body / headers, and the transformed client-facing SSE
// stream), not internal state flags.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConversationIdentity } from "./orchestration-election";
import {
	CODEX_AUTHENTICATED_CALLER_HEADER,
	CODEX_DEFAULT_ENDPOINT,
	CODEX_NATIVE_RESPONSES_HEADER,
	CODEX_RESPONSE_ID_LANE_TTL_MS,
	CODEX_RESPONSE_ID_MAX_LANES,
	CODEX_RESPONSE_ID_PENDING_TTL_MS,
	CodexProvider,
} from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_HMAC_KEY_ENV } from "./trace";
import {
	CODEX_TURN_STATE_ACCOUNT_IDS_ENV,
	CODEX_TURN_STATE_COHORT_IDS_ENV,
	CODEX_TURN_STATE_MODELS_ENV,
	CODEX_TURN_STATE_PERCENT_ENV,
	deriveCodexTurnStateCohortId,
} from "./turn-state";

const readTraceRecords = (dir: string): Array<Record<string, unknown>> => {
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
	if (!file) return [];
	return readFileSync(join(dir, file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

const turnStateHeader = "x-codex-turn-state";
const account = {
	id: "account-response-id",
	name: "codex-response-id-test",
	provider: "codex",
	custom_endpoint: null,
	model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
} as Parameters<CodexProvider["transformRequestBody"]>[1];
const physicalModel = "gpt-5.6-sol";
const sessionId = "22222222-2222-4222-8222-222222222222";
const instructions = "Keep the same turn.";
const firstUserText = "inspect the cache";
const callerDigest =
	"caller-digest-0000000000000000000000000000000000000000000000000000000000";

const firstCodexInput = [
	{
		role: "user",
		content: [{ type: "input_text", text: firstUserText }],
	},
];
const conversationIdentity = deriveConversationIdentity(
	sessionId,
	instructions,
	firstCodexInput,
);
if (!conversationIdentity) {
	throw new Error("response-id fixture has no conversation identity");
}

function enableTurnStateTreatment(): void {
	process.env[CODEX_TURN_STATE_PERCENT_ENV] = "100";
	process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV] = account.id;
	process.env[CODEX_TURN_STATE_MODELS_ENV] = physicalModel;
	process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId({
		accountId: account.id,
		model: physicalModel,
		conversationIdentity,
	});
}

afterEach(() => {
	delete process.env[CODEX_TURN_STATE_PERCENT_ENV];
	delete process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV];
	delete process.env[CODEX_TURN_STATE_MODELS_ENV];
	delete process.env[CODEX_TURN_STATE_COHORT_IDS_ENV];
	delete process.env[CODEX_TRACE_DIR_ENV];
	delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
});

/**
 * Builds an incoming request exactly as proxy-operations.ts's
 * `prepareAttemptHeaders` would for a genuine, server-verified native
 * Responses-adapter request: the internal trust headers
 * (`CODEX_NATIVE_RESPONSES_HEADER`, `CODEX_AUTHENTICATED_CALLER_HEADER`) are
 * present, and the passthrough carrier's `continuation_strategy` opt-in is
 * set exactly as `openai-responses-adapter/src/handler.ts` sets it from the
 * client-facing `CODEX_CONTINUATION_HEADER` header. `native`/`optIn` let
 * individual tests simulate the header being absent (the default, untrusted
 * path) to prove opt-in is not, by itself, sufficient.
 */
function nativeResponseIdRequestFor(params: {
	requestId: string;
	attemptId: string;
	messages: unknown[];
	stream: boolean;
	native?: boolean;
	optIn?: boolean;
	additionalTools?: unknown[];
	passthroughTools?: unknown[];
}): Request {
	const {
		requestId,
		attemptId,
		messages,
		stream,
		native = true,
		optIn = true,
		additionalTools,
		passthroughTools,
	} = params;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-better-ccflare-request-id": requestId,
		"x-better-ccflare-attempt-id": attemptId,
		"x-better-ccflare-attempt-ordinal": "1",
		"x-better-ccflare-attempt-cause": "initial",
		"x-better-ccflare-final-model": physicalModel,
	};
	if (native) headers[CODEX_NATIVE_RESPONSES_HEADER] = "1";
	headers[CODEX_AUTHENTICATED_CALLER_HEADER] = callerDigest;
	const body: Record<string, unknown> = {
		model: "claude-sonnet-4-5",
		max_tokens: 100,
		stream,
		system: instructions,
		metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
		messages,
	};
	if (optIn || additionalTools || passthroughTools) {
		const passthrough: Record<string, unknown> = {};
		if (optIn) passthrough.continuation_strategy = "previous_response_id";
		if (additionalTools) passthrough.additional_tools = additionalTools;
		if (passthroughTools) passthrough.tools = passthroughTools;
		body.__better_ccflare_codex_passthrough = passthrough;
	}
	return new Request(CODEX_DEFAULT_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

/** A clean completed-response SSE body: one `response.completed` + one `[DONE]`, nothing else. */
function completedResponse(params: {
	requestId: string;
	attemptId: string;
	responseId: string;
	outputText: string;
	stream: boolean;
	extraFrames?: string[];
}): Response {
	const { requestId, attemptId, responseId, outputText, stream, extraFrames } =
		params;
	const frames = [
		...eventLine("response.created", {
			type: "response.created",
			response: { id: responseId, model: physicalModel },
		}),
		...eventLine("response.completed", {
			type: "response.completed",
			response: {
				id: responseId,
				model: physicalModel,
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: outputText }],
					},
				],
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		}),
		...eventLine("[DONE]", "[DONE]"),
		...(extraFrames ?? []),
	];
	return new Response(sseBody(frames), {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-id": requestId,
			"x-better-ccflare-attempt-id": attemptId,
			"x-better-ccflare-final-model": physicalModel,
			"x-better-ccflare-request-stream": stream ? "true" : "false",
		},
	});
}

/**
 * KTD6 eviction/tombstone proof-first tests (Defect 1) need to observe
 * `responseIdLanes`/`pendingResponseIdByAttempt`/`responseIdBudgetBytes`
 * directly: no public accessor exists, and the whole point of these
 * assertions is to prove an internal accounting invariant (generation
 * preserved across eviction, bytes released exactly once) that is not
 * otherwise wire-observable in a single request/response round trip. This
 * is the only place in this file that reaches past the public API; every
 * other test in this file asserts on the wire (request JSON / SSE body).
 */
type CodexProviderInternalsForTest = {
	responseIdLanes: Map<
		string,
		{
			generation: number;
			state?: { responseId: string; chargedBytes: number };
			tombstonedAt?: number;
		}
	>;
	pendingResponseIdByAttempt: Map<
		string,
		{ lane: string; generation: number; chargedBytes: number; ts: number }
	>;
	responseIdBudgetBytes: number;
	codexResponseIdLaneKey: (
		accountId: string | undefined,
		model: string,
		callerDigestArg: string | null,
		sessionIdentity: string | null,
	) => string;
	sweepCodexResponseIdState: () => void;
};
function internals(provider: CodexProvider): CodexProviderInternalsForTest {
	return provider as unknown as CodexProviderInternalsForTest;
}

/** Shallow-clones the fixture account with a distinct id (a distinct lane key). */
function accountWithId(
	id: string,
): Parameters<CodexProvider["transformRequestBody"]>[1] {
	return { ...account, id } as Parameters<
		CodexProvider["transformRequestBody"]
	>[1];
}

/** Bounded poll for the detached KTD7 tail validator to settle after processResponse resolves. */
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

describe("CodexProvider native response-id continuation (KTD6/KTD7/KTD13)", () => {
	it("stages no previous_response_id on a cold attempt, then truncates history and carries previous_response_id on the wire after a clean completion (scenario 1, 2)", async () => {
		const provider = new CodexProvider();
		const coldMessages = [{ role: "user", content: firstUserText }];
		const coldRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-cold",
				attemptId: "aid-cold",
				messages: coldMessages,
				stream: true,
			}),
			account,
		);
		const coldBody = (await coldRequest.json()) as Record<string, unknown>;
		expect(coldBody.previous_response_id).toBeUndefined();
		expect((coldBody.input as unknown[]).length).toBe(1);
		// KTD6: response-id owns this attempt, so turn-state must not have been
		// invoked -- no turn-state token on the wire.
		expect(coldRequest.headers.get(turnStateHeader)).toBeNull();
		// Internal trust headers never reach the outbound (real-upstream) request.
		expect(coldRequest.headers.get(CODEX_NATIVE_RESPONSES_HEADER)).toBeNull();
		expect(
			coldRequest.headers.get(CODEX_AUTHENTICATED_CALLER_HEADER),
		).toBeNull();

		const coldResponse = await provider.processResponse(
			completedResponse({
				requestId: "rid-cold",
				attemptId: "aid-cold",
				responseId: "resp-cold-1",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		await coldResponse.text();

		const continuedMessages = [
			...coldMessages,
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: "continue please" },
		];
		const continuedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-continued",
				attemptId: "aid-continued",
				messages: continuedMessages,
				stream: true,
			}),
			account,
		);
		const continuedBody = (await continuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(continuedBody.previous_response_id).toBe("resp-cold-1");
		// Only response-id projection truncates: the matched two-item prefix
		// (original user turn + echoed assistant turn) is sliced away, leaving
		// only the new tail on the wire.
		const continuedInput = continuedBody.input as Array<
			Record<string, unknown>
		>;
		expect(continuedInput.length).toBe(1);
		expect(continuedInput[0].role).toBe("user");
	});

	it("does not activate without the server-verified native-Responses trust header, even with client opt-in (trust boundary, scenario 4)", async () => {
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-untrusted",
				attemptId: "aid-untrusted",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
				native: false,
				optIn: true,
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		expect(body.previous_response_id).toBeUndefined();
	});

	it("does not activate without the client opt-in header, even on a trusted native-Responses request (defaults do not change, scenario 3)", async () => {
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-no-optin",
				attemptId: "aid-no-optin",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
				native: true,
				optIn: false,
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		expect(body.previous_response_id).toBeUndefined();
	});

	it("response-id ownership excludes the fork's turn-state on the SAME attempt, even when turn-state treatment is enabled (KTD6 exclusivity)", async () => {
		enableTurnStateTreatment();
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-exclusive",
				attemptId: "aid-exclusive",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		// response-id owns the attempt (native + opt-in): turn-state's
		// beginAttempt must not have run, so no turn-state header is set.
		expect(request.headers.get(turnStateHeader)).toBeNull();
	});

	it("a request declaring custom (additional_tools) tools never claims response-id ownership, and releases any staged charge via the passthrough branch (KTD13 leak guard)", async () => {
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-custom-tools",
				attemptId: "aid-custom-tools",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
				additionalTools: [
					{
						type: "additional_tools",
						tools: [{ type: "computer_use_preview" }],
					},
				],
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		expect(body.previous_response_id).toBeUndefined();
		// hasCustomTools routes processResponse through the passthrough branch,
		// which never runs processEvents; confirm the client still gets an
		// ordinary response (not stuck / not erroring) via that branch.
		const upstream = new Response(
			JSON.stringify({ id: "resp-passthrough-1", output: [] }),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": "rid-custom-tools",
					"x-better-ccflare-attempt-id": "aid-custom-tools",
					"x-better-ccflare-final-model": physicalModel,
					"x-better-ccflare-request-stream": "false",
				},
			},
		);
		const transformed = await provider.processResponse(upstream, null);
		expect(transformed.status).toBe(200);
	});

	it("a request declaring a non-function tool via the raw tools passthrough never claims response-id ownership -- turn-state still runs for it -- even though the plain-text input digest alone would otherwise qualify (KTD13 leak guard, tools-array path)", async () => {
		enableTurnStateTreatment();
		const traceDir = mkdtempSync(
			join(tmpdir(), "codex-response-id-custom-tools-"),
		);
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		try {
			const provider = new CodexProvider();
			const request = await provider.transformRequestBody(
				nativeResponseIdRequestFor({
					requestId: "rid-custom-tools-array",
					attemptId: "aid-custom-tools-array",
					messages: [{ role: "user", content: firstUserText }],
					stream: true,
					// Declared only via codexBody.tools (not an input item), so the
					// input digest itself is plain, digestible text -- proving this
					// exclusion is load-bearing and not just a side effect of the
					// digest already failing closed on an "additional_tools" item.
					passthroughTools: [{ type: "computer_use_preview" }],
				}),
				account,
			);
			const body = (await request.json()) as Record<string, unknown>;
			expect(body.previous_response_id).toBeUndefined();
			// Wire-observable proof of exclusivity, not just an internal flag:
			// with turn-state treatment enabled and response-id correctly
			// excluded, turn-state's own beginAttempt must have actually run
			// for this attempt (arm/action are NOT the "response_id_owned"
			// stub `selectCodexResponseIdOwner` would otherwise have produced).
			const record = readTraceRecords(traceDir).find(
				(r) => r.attempt_id === "aid-custom-tools-array",
			);
			expect(record).toBeDefined();
			expect(record?.codex_turn_state_request_action).not.toBe(
				"response_id_owned",
			);
		} finally {
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("a same-chunk trailing frame after response.completed disqualifies the checkpoint, but still delivers the terminal event to the client (KTD7 scenario 10/6)", async () => {
		const provider = new CodexProvider();
		const coldRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-taint",
				attemptId: "aid-taint",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		await coldRequest.json();

		// A duplicate response.completed frame arrives in the SAME chunk right
		// after the first one -- the whole SSE body is pushed to the frame
		// buffer as a single read, so this reliably lands in one chunk.
		const taintedUpstream = completedResponse({
			requestId: "rid-taint",
			attemptId: "aid-taint",
			responseId: "resp-taint-1",
			outputText: "hello",
			stream: true,
			extraFrames: eventLine("response.completed", {
				type: "response.completed",
				response: {
					id: "resp-taint-1",
					model: physicalModel,
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "hello-again" }],
						},
					],
				},
			}),
		});
		const transformed = await provider.processResponse(taintedUpstream, null);
		const text = await transformed.text();
		// Client delivery still happens at the normal boundary.
		expect(text).toContain("message_stop");

		// The tainted checkpoint must not have been promoted: a follow-up
		// request on the same lane cannot receive previous_response_id.
		const continuedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-taint-2",
				attemptId: "aid-taint-2",
				messages: [
					{ role: "user", content: firstUserText },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
					{ role: "user", content: "continue please" },
				],
				stream: true,
			}),
			account,
		);
		const continuedBody = (await continuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(continuedBody.previous_response_id).toBeUndefined();
	});

	it("an incomplete response never stages a checkpoint (response.incomplete output is not a trustworthy replay tail)", async () => {
		const provider = new CodexProvider();
		const coldRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-incomplete",
				attemptId: "aid-incomplete",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		await coldRequest.json();

		const upstream = new Response(
			sseBody([
				...eventLine("response.created", {
					type: "response.created",
					response: { id: "resp-incomplete-1", model: physicalModel },
				}),
				...eventLine("response.incomplete", {
					type: "response.incomplete",
					response: {
						id: "resp-incomplete-1",
						model: physicalModel,
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "cut off" }],
							},
						],
					},
				}),
				...eventLine("[DONE]", "[DONE]"),
			]),
			{
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "rid-incomplete",
					"x-better-ccflare-attempt-id": "aid-incomplete",
					"x-better-ccflare-final-model": physicalModel,
					"x-better-ccflare-request-stream": "true",
				},
			},
		);
		await (await provider.processResponse(upstream, null)).text();

		const continuedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-incomplete-2",
				attemptId: "aid-incomplete-2",
				messages: [
					{ role: "user", content: firstUserText },
					{ role: "assistant", content: [{ type: "text", text: "cut off" }] },
					{ role: "user", content: "continue please" },
				],
				stream: true,
			}),
			account,
		);
		const continuedBody = (await continuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(continuedBody.previous_response_id).toBeUndefined();
	});

	it("more than the KTD13 digest-item ceiling falls back safely without truncating input or failing the client request", async () => {
		const provider = new CodexProvider();
		const manyMessages: unknown[] = [];
		// Alternate user/assistant text turns past CODEX_RESPONSE_ID_MAX_DIGEST_ITEMS
		// (2,048) input items. Each Anthropic message here becomes one Codex
		// input item, so 2,100 turns comfortably exceeds the ceiling.
		for (let i = 0; i < 2_100; i++) {
			manyMessages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `turn ${i}`,
			});
		}
		const request = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-oversized",
				attemptId: "aid-oversized",
				messages: manyMessages,
				stream: true,
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		// Capture skipped: no previous_response_id claimed for this attempt.
		expect(body.previous_response_id).toBeUndefined();
		// Never truncated: every input item the client supplied is still present.
		expect((body.input as unknown[]).length).toBe(manyMessages.length);
	});
});

describe("CodexProvider KTD6 defect fix: LRU-cap eviction preserves lane generation (Defect 1)", () => {
	it("a lane evicted while an attempt is pending: the stale attempt's late completion does not publish, a fresh attempt on the same lane works normally afterward, and eviction releases retention bytes exactly once", async () => {
		const provider = new CodexProvider();
		const laneMessages = [{ role: "user", content: firstUserText }];

		// Step 1: seed committed state on lane X (generation 1).
		const seedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-lanex-seed",
				attemptId: "aid-lanex-seed",
				messages: laneMessages,
				stream: true,
			}),
			account,
		);
		await seedRequest.json();
		await (
			await provider.processResponse(
				completedResponse({
					requestId: "rid-lanex-seed",
					attemptId: "aid-lanex-seed",
					responseId: "resp-lanex-seed",
					outputText: "hello",
					stream: true,
				}),
				null,
			)
		).text();

		const sessionIdentity = conversationIdentity as unknown as string;
		const laneKeyX = internals(provider).codexResponseIdLaneKey(
			account.id,
			physicalModel,
			callerDigest,
			sessionIdentity,
		);
		const seedEntry = internals(provider).responseIdLanes.get(laneKeyX);
		expect(seedEntry?.generation).toBe(1);
		expect(seedEntry?.state?.responseId).toBe("resp-lanex-seed");
		const seedStateChargedBytes = seedEntry?.state?.chargedBytes ?? 0;
		expect(seedStateChargedBytes).toBeGreaterThan(0);

		// Step 2: stage a second, still-pending attempt P on the SAME lane
		// (generation 2) -- deliberately never completed yet.
		const continuedMessages = [
			...laneMessages,
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: "continue please" },
		];
		await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-lanex-pending",
				attemptId: "aid-lanex-pending",
				messages: continuedMessages,
				stream: true,
			}),
			account,
		);
		const pendingEntryP =
			internals(provider).pendingResponseIdByAttempt.get("aid-lanex-pending");
		expect(pendingEntryP?.generation).toBe(2);
		const pendingPChargedBytes = pendingEntryP?.chargedBytes ?? 0;
		expect(pendingPChargedBytes).toBeGreaterThan(0);
		expect(internals(provider).responseIdLanes.get(laneKeyX)?.generation).toBe(
			2,
		);

		// Step 3: force real LRU-cap eviction. Lane X is the only lane with
		// committed `state` (every filler lane below is left pending-only,
		// so it is never eviction-eligible), so it is guaranteed to be the
		// lane picked for eviction once `responseIdLanes.size` exceeds
		// CODEX_RESPONSE_ID_MAX_LANES. `sweepCodexResponseIdState` runs at
		// the top of every `transformRequestBody` call and only evicts once
		// size is ALREADY over the cap, so exactly MAX_LANES + 1 filler
		// calls are needed to push the sweep on the very last one past the
		// threshold.
		for (let i = 0; i <= CODEX_RESPONSE_ID_MAX_LANES; i++) {
			await provider.transformRequestBody(
				nativeResponseIdRequestFor({
					requestId: `rid-filler-${i}`,
					attemptId: `aid-filler-${i}`,
					messages: laneMessages,
					stream: true,
				}),
				accountWithId(`account-filler-${i}`),
			);
		}

		const evictedEntry = internals(provider).responseIdLanes.get(laneKeyX);
		// The defect: eviction used to `Map.delete()` the whole entry,
		// resetting generation to 0/undefined on the next attempt. The fix:
		// the entry survives as a tombstone, `state` cleared but
		// `generation` preserved at its pre-eviction high-water mark.
		expect(evictedEntry).toBeDefined();
		expect(evictedEntry?.state).toBeUndefined();
		expect(evictedEntry?.tombstonedAt).toBeGreaterThan(0);
		expect(evictedEntry?.generation).toBe(2);

		const budgetJustAfterEviction = internals(provider).responseIdBudgetBytes;
		// Retention bytes released exactly once: re-running the sweep
		// (idempotent -- state is already cleared, so nothing left to
		// evict/release on this lane) must not decrement the budget again.
		for (let i = 0; i < 5; i++) {
			internals(provider).sweepCodexResponseIdState();
		}
		expect(internals(provider).responseIdBudgetBytes).toBe(
			budgetJustAfterEviction,
		);

		// The filler lanes did their job (forcing real LRU-cap eviction
		// pressure) and are no longer needed. Left in place, every one of
		// them is a still-pending-only, never-state-holding, never-removed
		// entry, so `responseIdLanes.size` would stay permanently over
		// CODEX_RESPONSE_ID_MAX_LANES -- meaning the sweep this test
		// triggers on EVERY subsequent transformRequestBody call would keep
		// re-picking lane X (the only entry that ever holds `state`) for
		// eviction again and again, which would falsify the rest of this
		// scenario for a reason that has nothing to do with the fix under
		// test. Drop them directly; lane X's own tombstone (just asserted
		// above) is left untouched.
		for (const key of [...internals(provider).responseIdLanes.keys()]) {
			if (key !== laneKeyX) internals(provider).responseIdLanes.delete(key);
		}

		// Step 4: a fresh attempt N on the SAME lane key after eviction must
		// work normally -- no previous_response_id (the committed state was
		// tombstoned away, which is correct, not a bug), and generation
		// continues climbing from its preserved high-water mark rather than
		// resetting.
		const freshRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-lanex-fresh",
				attemptId: "aid-lanex-fresh",
				messages: laneMessages,
				stream: true,
			}),
			account,
		);
		const freshBody = (await freshRequest.json()) as Record<string, unknown>;
		expect(freshBody.previous_response_id).toBeUndefined();
		expect(internals(provider).responseIdLanes.get(laneKeyX)?.generation).toBe(
			3,
		);
		await (
			await provider.processResponse(
				completedResponse({
					requestId: "rid-lanex-fresh",
					attemptId: "aid-lanex-fresh",
					responseId: "resp-lanex-fresh",
					outputText: "fresh reply",
					stream: true,
				}),
				null,
			)
		).text();
		const freshCommittedEntry =
			internals(provider).responseIdLanes.get(laneKeyX);
		expect(freshCommittedEntry?.state?.responseId).toBe("resp-lanex-fresh");
		expect(freshCommittedEntry?.tombstonedAt).toBeUndefined();
		const budgetAfterFreshCommit = internals(provider).responseIdBudgetBytes;

		// Step 5: the stale, pre-eviction attempt P (staged at generation 2,
		// long superseded by N's generation 3) now completes LATE. Without
		// the fix this would restart the evicted lane at generation 1 and
		// let this generation-2 attempt pass `laneEntry.generation >
		// pending.generation` and overwrite N's fresh state. With the fix,
		// generation 3 > 2 rejects it.
		await (
			await provider.processResponse(
				completedResponse({
					requestId: "rid-lanex-pending",
					attemptId: "aid-lanex-pending",
					responseId: "resp-lanex-pending-STALE",
					outputText: "stale late reply",
					stream: true,
				}),
				null,
			)
		).text();
		// The KTD7 move-only handoff (Defect 2) resolves this candidate
		// asynchronously (detached, never awaited by processResponse) even
		// on the clean-EOF path, so wait for it to actually settle before
		// asserting the outcome -- otherwise a reintroduced bug that DOES
		// publish late could race past this test's own assertions.
		await waitUntil(
			() =>
				!internals(provider).pendingResponseIdByAttempt.has(
					"aid-lanex-pending",
				),
		);

		const finalEntry = internals(provider).responseIdLanes.get(laneKeyX);
		// Must NOT publish: the stale attempt's response id never overwrote
		// N's committed checkpoint.
		expect(finalEntry?.state?.responseId).toBe("resp-lanex-fresh");
		expect(finalEntry?.state?.responseId).not.toBe("resp-lanex-pending-STALE");
		// Retention bytes released exactly once across evict-then-complete:
		// P's own staged (pending-time) charge is released unconditionally
		// by commitCodexResponseIdCheckpoint regardless of outcome, but the
		// stale-generation rejection returns before ever touching
		// `laneEntry.state`, so N's already-committed state charge must be
		// completely untouched -- the only budget delta is P's own pending
		// charge going away exactly once.
		expect(internals(provider).responseIdBudgetBytes).toBe(
			budgetAfterFreshCommit - pendingPChargedBytes,
		);

		// Wire-observable confirmation of "must NOT publish": the next
		// request on this lane still continues from N's response id.
		const verifyRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-lanex-verify",
				attemptId: "aid-lanex-verify",
				messages: [
					...laneMessages,
					{
						role: "assistant",
						content: [{ type: "text", text: "fresh reply" }],
					},
					{ role: "user", content: "one more" },
				],
				stream: true,
			}),
			account,
		);
		const verifyBody = (await verifyRequest.json()) as Record<string, unknown>;
		expect(verifyBody.previous_response_id).toBe("resp-lanex-fresh");
	}, 20_000);

	it("tombstoned lanes are eventually deleted, bounding responseIdLanes growth instead of accumulating forever", async () => {
		const provider = new CodexProvider();
		const laneMessages = [{ role: "user", content: firstUserText }];
		const baseNow = Date.now();
		const nowSpy = spyOn(Date, "now").mockImplementation(() => baseNow);
		try {
			const seedRequest = await provider.transformRequestBody(
				nativeResponseIdRequestFor({
					requestId: "rid-tombstone-seed",
					attemptId: "aid-tombstone-seed",
					messages: laneMessages,
					stream: true,
				}),
				account,
			);
			await seedRequest.json();
			await (
				await provider.processResponse(
					completedResponse({
						requestId: "rid-tombstone-seed",
						attemptId: "aid-tombstone-seed",
						responseId: "resp-tombstone-seed",
						outputText: "hello",
						stream: true,
					}),
					null,
				)
			).text();

			const sessionIdentity = conversationIdentity as unknown as string;
			const laneKey = internals(provider).codexResponseIdLaneKey(
				account.id,
				physicalModel,
				callerDigest,
				sessionIdentity,
			);
			expect(internals(provider).responseIdLanes.has(laneKey)).toBe(true);

			// Advance past the committed-state TTL and trigger a sweep (any
			// transformRequestBody call runs one): state expires and the lane
			// becomes a tombstone, but is NOT deleted yet.
			nowSpy.mockImplementation(
				() => baseNow + CODEX_RESPONSE_ID_LANE_TTL_MS + 1,
			);
			await provider.transformRequestBody(
				nativeResponseIdRequestFor({
					requestId: "rid-tombstone-trigger-1",
					attemptId: "aid-tombstone-trigger-1",
					messages: laneMessages,
					stream: true,
				}),
				accountWithId("account-tombstone-trigger-1"),
			);
			const tombstoned = internals(provider).responseIdLanes.get(laneKey);
			expect(tombstoned).toBeDefined();
			expect(tombstoned?.state).toBeUndefined();
			expect(tombstoned?.tombstonedAt).toBe(
				baseNow + CODEX_RESPONSE_ID_LANE_TTL_MS + 1,
			);

			// Advance past the tombstone's own retention window and sweep again:
			// the tombstone itself must now be fully deleted, proving the
			// bookkeeping cannot grow unbounded.
			nowSpy.mockImplementation(
				() =>
					baseNow +
					CODEX_RESPONSE_ID_LANE_TTL_MS +
					1 +
					CODEX_RESPONSE_ID_PENDING_TTL_MS +
					1,
			);
			await provider.transformRequestBody(
				nativeResponseIdRequestFor({
					requestId: "rid-tombstone-trigger-2",
					attemptId: "aid-tombstone-trigger-2",
					messages: laneMessages,
					stream: true,
				}),
				accountWithId("account-tombstone-trigger-2"),
			);
			expect(internals(provider).responseIdLanes.has(laneKey)).toBe(false);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
