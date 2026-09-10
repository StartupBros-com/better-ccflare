// U5c Behavior 1 -- Messages-lane continuation
// (CCFLARE_CODEX_MESSAGES_CONTINUATION). Reuses the exact same KTD6/KTD7/
// KTD13 owner-selection, tail-validation, and retention machinery
// provider.cache-replay.test.ts already proves for the native-Responses
// lane; these tests exercise ONLY the Behavior 1 gate (flag, model filter)
// and the cross-lane isolation guarantee (protocol discriminator), plus
// the "no turn-state registration/capture" parity requirement. All
// assertions read the actual wire payload (the outbound `Request`'s JSON
// body / headers) or the response, never internal state directly.
import { afterEach, describe, expect, it } from "bun:test";
import { deriveConversationIdentity } from "./orchestration-election";
import {
	CODEX_AUTHENTICATED_CALLER_HEADER,
	CODEX_DEFAULT_ENDPOINT,
	CODEX_MESSAGES_CONTINUATION_ENV,
	CODEX_MESSAGES_CONTINUATION_MODELS_ENV,
	CODEX_NATIVE_RESPONSES_HEADER,
	CodexProvider,
} from "./provider";
import {
	CODEX_TURN_STATE_ACCOUNT_IDS_ENV,
	CODEX_TURN_STATE_COHORT_IDS_ENV,
	CODEX_TURN_STATE_MODELS_ENV,
	CODEX_TURN_STATE_PERCENT_ENV,
	deriveCodexTurnStateCohortId,
} from "./turn-state";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

const turnStateHeader = "x-codex-turn-state";
const account = {
	id: "account-messages-continuation",
	name: "codex-messages-continuation-test",
	provider: "codex",
	custom_endpoint: null,
	model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
} as Parameters<CodexProvider["transformRequestBody"]>[1];
const physicalModel = "gpt-5.6-sol";
const sessionId = "33333333-3333-4333-8333-333333333333";
const instructions = "Keep the same turn.";
const firstUserText = "inspect the messages lane";
const callerDigest =
	"caller-digest-1111111111111111111111111111111111111111111111111111111111";

afterEach(() => {
	delete process.env[CODEX_MESSAGES_CONTINUATION_ENV];
	delete process.env[CODEX_MESSAGES_CONTINUATION_MODELS_ENV];
	delete process.env[CODEX_TURN_STATE_PERCENT_ENV];
	delete process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV];
	delete process.env[CODEX_TURN_STATE_MODELS_ENV];
	delete process.env[CODEX_TURN_STATE_COHORT_IDS_ENV];
});

/**
 * Builds an incoming request exactly as a genuine plain Claude Messages
 * request reaches `transformRequestBody`: NEITHER internal trust header is
 * present (the Responses-adapter-only `CODEX_NATIVE_RESPONSES_HEADER`, and
 * `CODEX_AUTHENTICATED_CALLER_HEADER` which is only ever server-stamped for
 * an adapter request) and there is no passthrough `continuation_strategy`
 * opt-in carrier (that carrier is adapter-only too). `withCallerDigest` lets
 * scenario 4 (cross-lane isolation) deliberately override this -- an
 * unrealistic-for-production but stronger proof that the protocol
 * discriminator alone, not an incidentally-differing caller digest, is what
 * keeps the two lanes apart.
 */
function messagesRequestFor(params: {
	requestId: string;
	attemptId: string;
	messages: unknown[];
	stream: boolean;
	model?: string;
	withCallerDigest?: boolean;
}): Request {
	const {
		requestId,
		attemptId,
		messages,
		stream,
		model = "claude-sonnet-4-5",
		withCallerDigest = false,
	} = params;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-better-ccflare-request-id": requestId,
		"x-better-ccflare-attempt-id": attemptId,
		"x-better-ccflare-attempt-ordinal": "1",
		"x-better-ccflare-attempt-cause": "initial",
		"x-better-ccflare-final-model": physicalModel,
	};
	if (withCallerDigest)
		headers[CODEX_AUTHENTICATED_CALLER_HEADER] = callerDigest;
	const body: Record<string, unknown> = {
		model,
		max_tokens: 100,
		stream,
		system: instructions,
		metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
		messages,
	};
	return new Request(CODEX_DEFAULT_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

/**
 * Same builder, but stamped as a genuine trusted native-Responses adapter
 * request (server-verified header + explicit client opt-in), used only by
 * scenario 4 to prove cross-lane isolation from the other direction.
 */
function nativeRequestFor(params: {
	requestId: string;
	attemptId: string;
	messages: unknown[];
	stream: boolean;
	withCallerDigest?: boolean;
}): Request {
	const {
		requestId,
		attemptId,
		messages,
		stream,
		withCallerDigest = false,
	} = params;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-better-ccflare-request-id": requestId,
		"x-better-ccflare-attempt-id": attemptId,
		"x-better-ccflare-attempt-ordinal": "1",
		"x-better-ccflare-attempt-cause": "initial",
		"x-better-ccflare-final-model": physicalModel,
		[CODEX_NATIVE_RESPONSES_HEADER]: "1",
	};
	if (withCallerDigest)
		headers[CODEX_AUTHENTICATED_CALLER_HEADER] = callerDigest;
	const body: Record<string, unknown> = {
		model: "claude-sonnet-4-5",
		max_tokens: 100,
		stream,
		system: instructions,
		metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
		messages,
		__better_ccflare_codex_passthrough: {
			continuation_strategy: "previous_response_id",
		},
	};
	return new Request(CODEX_DEFAULT_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

/** A clean completed-response SSE body: one `response.completed` + exactly one `[DONE]`. */
function completedResponse(params: {
	requestId: string;
	attemptId: string;
	responseId: string;
	outputText: string;
	stream: boolean;
}): Response {
	const { requestId, attemptId, responseId, outputText, stream } = params;
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

const firstCodexInput = [
	{ role: "user", content: [{ type: "input_text", text: firstUserText }] },
];
const conversationIdentity = deriveConversationIdentity(
	sessionId,
	instructions,
	firstCodexInput,
);
if (!conversationIdentity) {
	throw new Error("messages-continuation fixture has no conversation identity");
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

describe("CodexProvider Behavior 1 -- Messages-lane continuation (CCFLARE_CODEX_MESSAGES_CONTINUATION)", () => {
	it("flag off: Messages requests behave exactly as before, with no continuation state created (scenario 1)", async () => {
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-flag-off",
				attemptId: "aid-flag-off",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		expect(body.previous_response_id).toBeUndefined();
		// No pending candidate is staged at all when ineligible -- confirmed
		// on the wire: a follow-up "continued" request on the identical
		// session still carries no previous_response_id, proving no
		// checkpoint could have been created for this lane.
		const followUp = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-flag-off-2",
				attemptId: "aid-flag-off-2",
				messages: [
					{ role: "user", content: firstUserText },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
					{ role: "user", content: "continue please" },
				],
				stream: true,
			}),
			account,
		);
		const followUpBody = (await followUp.json()) as Record<string, unknown>;
		expect(followUpBody.previous_response_id).toBeUndefined();
	});

	it("flag on: cold then continued Messages flows reuse a checkpoint, surviving the single trailing [DONE] after completion (scenario 2)", async () => {
		process.env[CODEX_MESSAGES_CONTINUATION_ENV] = "1";
		const provider = new CodexProvider();
		const coldMessages = [{ role: "user", content: firstUserText }];
		const coldRequest = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-on-cold",
				attemptId: "aid-on-cold",
				messages: coldMessages,
				stream: true,
			}),
			account,
		);
		const coldBody = (await coldRequest.json()) as Record<string, unknown>;
		expect(coldBody.previous_response_id).toBeUndefined();

		const coldResponse = await provider.processResponse(
			completedResponse({
				requestId: "rid-on-cold",
				attemptId: "aid-on-cold",
				responseId: "resp-messages-cold-1",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		// Fully drains the client-facing stream, including the single
		// trailing [DONE] emitted by completedResponse() above -- upstream
		// 8056fdbb's fix is exactly that this [DONE] must not discard the
		// checkpoint the response.completed frame just staged.
		await coldResponse.text();

		const continuedMessages = [
			...coldMessages,
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: "continue please" },
		];
		const continuedRequest = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-on-continued",
				attemptId: "aid-on-continued",
				messages: continuedMessages,
				stream: true,
			}),
			account,
		);
		const continuedBody = (await continuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(continuedBody.previous_response_id).toBe("resp-messages-cold-1");
	});

	it("the optional model filter admits only listed models when set (scenario 3)", async () => {
		process.env[CODEX_MESSAGES_CONTINUATION_ENV] = "1";
		process.env[CODEX_MESSAGES_CONTINUATION_MODELS_ENV] =
			"some-other-model,yet-another-model";
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-filtered-out",
				attemptId: "aid-filtered-out",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		const body = (await request.json()) as Record<string, unknown>;
		// physicalModel ("gpt-5.6-sol") is not in the allowlist above --
		// continuation must not activate even though the flag is on.
		expect(body.previous_response_id).toBeUndefined();

		// Now admit it explicitly and confirm the SAME physical model is
		// admitted once listed.
		process.env[CODEX_MESSAGES_CONTINUATION_MODELS_ENV] = physicalModel;
		const admittedProvider = new CodexProvider();
		const coldRequest = await admittedProvider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-filtered-in-cold",
				attemptId: "aid-filtered-in-cold",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		await coldRequest.json();
		const coldResponse = await admittedProvider.processResponse(
			completedResponse({
				requestId: "rid-filtered-in-cold",
				attemptId: "aid-filtered-in-cold",
				responseId: "resp-filtered-in-1",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		await coldResponse.text();
		const continuedRequest = await admittedProvider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-filtered-in-continued",
				attemptId: "aid-filtered-in-continued",
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
		expect(continuedBody.previous_response_id).toBe("resp-filtered-in-1");
	});

	it("a Messages-lane checkpoint is never reachable from the native lane, and vice versa, for identical account/model/caller/session (scenario 4)", async () => {
		process.env[CODEX_MESSAGES_CONTINUATION_ENV] = "1";

		// Commit a checkpoint via the Messages lane (with a caller digest
		// deliberately set, to isolate protocol as the acting discriminator).
		const providerA = new CodexProvider();
		const messagesColdRequest = await providerA.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-cross-a-cold",
				attemptId: "aid-cross-a-cold",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
				withCallerDigest: true,
			}),
			account,
		);
		await messagesColdRequest.json();
		const messagesColdResponse = await providerA.processResponse(
			completedResponse({
				requestId: "rid-cross-a-cold",
				attemptId: "aid-cross-a-cold",
				responseId: "resp-messages-lane-only",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		await messagesColdResponse.text();

		// A native-lane request on the IDENTICAL account/model/caller/session
		// must not see that checkpoint.
		const nativeContinuedRequest = await providerA.transformRequestBody(
			nativeRequestFor({
				requestId: "rid-cross-a-native",
				attemptId: "aid-cross-a-native",
				messages: [
					{ role: "user", content: firstUserText },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
					{ role: "user", content: "continue please" },
				],
				stream: true,
				withCallerDigest: true,
			}),
			account,
		);
		const nativeContinuedBody = (await nativeContinuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(nativeContinuedBody.previous_response_id).toBeUndefined();

		// And the reverse: commit a checkpoint via the native lane, confirm
		// the Messages lane cannot see it either.
		const providerB = new CodexProvider();
		const nativeColdRequest = await providerB.transformRequestBody(
			nativeRequestFor({
				requestId: "rid-cross-b-cold",
				attemptId: "aid-cross-b-cold",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
				withCallerDigest: true,
			}),
			account,
		);
		await nativeColdRequest.json();
		const nativeColdResponse = await providerB.processResponse(
			completedResponse({
				requestId: "rid-cross-b-cold",
				attemptId: "aid-cross-b-cold",
				responseId: "resp-native-lane-only",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		await nativeColdResponse.text();

		const messagesContinuedRequest = await providerB.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-cross-b-messages",
				attemptId: "aid-cross-b-messages",
				messages: [
					{ role: "user", content: firstUserText },
					{ role: "assistant", content: [{ type: "text", text: "hello" }] },
					{ role: "user", content: "continue please" },
				],
				stream: true,
				withCallerDigest: true,
			}),
			account,
		);
		const messagesContinuedBody =
			(await messagesContinuedRequest.json()) as Record<string, unknown>;
		expect(messagesContinuedBody.previous_response_id).toBeUndefined();
	});

	it("a Messages-lane response-id-owned attempt performs no turn-state registration or capture (scenario 5)", async () => {
		process.env[CODEX_MESSAGES_CONTINUATION_ENV] = "1";
		// Turn-state treatment is deliberately enabled at 100% for this exact
		// account/model/cohort -- if response-id ownership did not actually
		// exclude turn-state, turn-state WOULD register/capture for this
		// attempt. Its absence below is therefore load-bearing proof, not
		// just a default.
		enableTurnStateTreatment();
		const provider = new CodexProvider();
		const request = await provider.transformRequestBody(
			messagesRequestFor({
				requestId: "rid-no-turn-state",
				attemptId: "aid-no-turn-state",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		expect(request.headers.get(turnStateHeader)).toBeNull();
		// Internal trust headers never reach the outbound (real-upstream)
		// request either way.
		expect(request.headers.get(CODEX_NATIVE_RESPONSES_HEADER)).toBeNull();
		expect(request.headers.get(CODEX_AUTHENTICATED_CALLER_HEADER)).toBeNull();

		const response = await provider.processResponse(
			completedResponse({
				requestId: "rid-no-turn-state",
				attemptId: "aid-no-turn-state",
				responseId: "resp-no-turn-state-1",
				outputText: "hello",
				stream: true,
			}),
			null,
		);
		// Completes cleanly -- no turn-state capture stalls or errors the
		// response.
		const text = await response.text();
		expect(text).toContain("message_stop");
	});
});
