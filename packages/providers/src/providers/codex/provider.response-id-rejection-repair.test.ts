// U5c Behavior 2 -- rejected-id repair. Exercises
// `isCodexResponseIdRejectionError` (pure classifier) and
// `CodexProvider.prepareCodexResponseIdRejectionRepair` (the KTD13-wired
// drain/retire/suppress gate proxy-operations.ts's shared physical-send
// boundary calls before dispatching the one-shot repair retry). Reuses the
// exact same KTD6 owner-selection / KTD13 retention machinery
// provider.cache-replay.test.ts already proves; these tests assert on that
// internal state directly (the repair method's whole contract IS internal
// state mutation -- draining, tombstoning, suppressing -- so, like
// provider.tail-validator.test.ts, this file reaches past the public API
// deliberately) plus the outbound wire shape of the resulting retry.
import { describe, expect, it } from "bun:test";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_RESPONSE_ID_MAX_AGGREGATE_BYTES,
	CODEX_RESPONSE_ID_REJECTED_TTL_MS,
	CodexProvider,
	isCodexResponseIdRejectionError,
} from "./provider";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

const account = {
	id: "account-rejection-repair",
	name: "codex-rejection-repair-test",
	provider: "codex",
	custom_endpoint: null,
	model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
} as Parameters<CodexProvider["transformRequestBody"]>[1];
const physicalModel = "gpt-5.6-sol";
const sessionId = "44444444-4444-4444-8444-444444444444";
const instructions = "Keep the same turn.";
const firstUserText = "inspect rejection repair";

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
		{
			lane: string;
			generation: number;
			chargedBytes: number;
			ts: number;
			continued: boolean;
		}
	>;
	continuationOwnerByAttempt: Map<string, { owner: string; ts: number }>;
	responseIdRejectedLanes: Map<string, number>;
	responseIdBudgetBytes: number;
};
function internals(provider: CodexProvider): CodexProviderInternalsForTest {
	return provider as unknown as CodexProviderInternalsForTest;
}

/**
 * Builds an incoming request exactly as proxy-operations.ts's
 * `prepareAttemptHeaders` would for a genuine, server-verified native
 * Responses-adapter request. Behavior 2 is lane-agnostic (it operates on
 * whichever lane the attempt already staged under KTD6), so exercising it
 * through the native lane is sufficient and keeps this file decoupled from
 * Behavior 1's own gate.
 */
function nativeResponseIdRequestFor(params: {
	requestId: string;
	attemptId: string;
	messages: unknown[];
	stream: boolean;
}): Request {
	const { requestId, attemptId, messages, stream } = params;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-better-ccflare-request-id": requestId,
		"x-better-ccflare-attempt-id": attemptId,
		"x-better-ccflare-attempt-ordinal": "1",
		"x-better-ccflare-attempt-cause": "initial",
		"x-better-ccflare-final-model": physicalModel,
		"x-better-ccflare-native-responses": "1",
	};
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

/**
 * Builds a native-Responses cold request whose converted `input` carries
 * `messageCount` distinct message items -- i.e. `messageCount` distinct
 * KTD13 digest entries -- so its `selectCodexResponseIdOwner` charge
 * estimate is large and deterministic (256 fixed "worst-case id" bytes plus
 * a fixed per-digest cost for each item; see `estimateCodexResponseIdCharge`
 * / `CODEX_RESPONSE_ID_ENTRY_OVERHEAD_BYTES` in provider.ts). Used only to
 * genuinely drive `responseIdBudgetBytes` toward
 * `CODEX_RESPONSE_ID_MAX_AGGREGATE_BYTES` through the real charge path --
 * never to stub or bypass `chargeCodexResponseIdBytes` itself.
 */
function bigColdRequestFor(params: {
	attemptId: string;
	messageCount: number;
}): Request {
	const { attemptId, messageCount } = params;
	const messages: unknown[] = [];
	for (let i = 0; i < messageCount; i++) {
		messages.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `budget filler message ${i}` }],
		});
	}
	return nativeResponseIdRequestFor({
		requestId: `rid-${attemptId}`,
		attemptId,
		messages,
		stream: true,
	});
}

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

/** Drives a provider through cold -> committed checkpoint -> continued (response-id-owned, `continued: true`) attempt. Returns the continued attemptId. */
async function primeContinuedAttempt(
	provider: CodexProvider,
	suffix: string,
): Promise<{ attemptId: string }> {
	const coldRequest = await provider.transformRequestBody(
		nativeResponseIdRequestFor({
			requestId: `rid-${suffix}-cold`,
			attemptId: `aid-${suffix}-cold`,
			messages: [{ role: "user", content: firstUserText }],
			stream: true,
		}),
		account,
	);
	await coldRequest.json();
	const coldResponse = await provider.processResponse(
		completedResponse({
			requestId: `rid-${suffix}-cold`,
			attemptId: `aid-${suffix}-cold`,
			responseId: `resp-${suffix}-cold-1`,
			outputText: "hello",
			stream: true,
		}),
		null,
	);
	await coldResponse.text();

	const continuedAttemptId = `aid-${suffix}-continued`;
	const continuedRequest = await provider.transformRequestBody(
		nativeResponseIdRequestFor({
			requestId: `rid-${suffix}-continued`,
			attemptId: continuedAttemptId,
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
	expect(continuedBody.previous_response_id).toBe(`resp-${suffix}-cold-1`);
	return { attemptId: continuedAttemptId };
}

const readJson = async (response: Response): Promise<unknown | null> => {
	try {
		return await response.json();
	} catch {
		return null;
	}
};

const rejectedIdResponse = (
	shape: "code-not-found" | "code-invalid" | "param-type",
): Response => {
	const body =
		shape === "code-not-found"
			? { error: { code: "previous_response_not_found" } }
			: shape === "code-invalid"
				? { error: { code: "invalid_previous_response_id" } }
				: {
						error: {
							param: "previous_response_id",
							type: "invalid_request_error",
						},
					};
	return new Response(JSON.stringify(body), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
};

describe("isCodexResponseIdRejectionError (pure classifier)", () => {
	it("recognizes all three upstream-matched rejection shapes on 400", async () => {
		expect(
			await isCodexResponseIdRejectionError(
				rejectedIdResponse("code-not-found"),
				readJson,
			),
		).toBe(true);
		expect(
			await isCodexResponseIdRejectionError(
				rejectedIdResponse("code-invalid"),
				readJson,
			),
		).toBe(true);
		expect(
			await isCodexResponseIdRejectionError(
				rejectedIdResponse("param-type"),
				readJson,
			),
		).toBe(true);
	});

	it("recognizes the same code on 404 too", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "previous_response_not_found" } }),
			{ status: 404, headers: { "content-type": "application/json" } },
		);
		expect(await isCodexResponseIdRejectionError(response, readJson)).toBe(
			true,
		);
	});

	it("rejects a generic 400 that does not name previous_response_id (scenario 7)", async () => {
		const response = new Response(
			JSON.stringify({
				error: { code: "invalid_request_error", param: "model" },
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
		expect(await isCodexResponseIdRejectionError(response, readJson)).toBe(
			false,
		);
	});

	it("rejects a generic 404 (scenario 7)", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "not_found" } }),
			{
				status: 404,
				headers: { "content-type": "application/json" },
			},
		);
		expect(await isCodexResponseIdRejectionError(response, readJson)).toBe(
			false,
		);
	});

	it("rejects a malformed (non-JSON) error body (scenario 7)", async () => {
		const response = new Response("not json", {
			status: 400,
			headers: { "content-type": "application/json" },
		});
		expect(await isCodexResponseIdRejectionError(response, readJson)).toBe(
			false,
		);
	});

	it("rejects any other status code even with a matching error shape", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "previous_response_not_found" } }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
		expect(await isCodexResponseIdRejectionError(response, readJson)).toBe(
			false,
		);
	});
});

describe("CodexProvider.prepareCodexResponseIdRejectionRepair", () => {
	it("a recognized rejected id on a continued attempt drains the owner, retires the checkpoint, and suppresses the lane, consuming exactly one call (scenario 6)", async () => {
		const provider = new CodexProvider();
		const { attemptId } = await primeContinuedAttempt(provider, "repair");
		const lane =
			internals(provider).pendingResponseIdByAttempt.get(attemptId)?.lane;
		expect(lane).toBeDefined();
		expect(
			internals(provider).responseIdLanes.get(lane as string)?.state,
		).toBeDefined();

		expect(
			await isCodexResponseIdRejectionError(
				rejectedIdResponse("code-not-found"),
				readJson,
			),
		).toBe(true);
		const repaired = provider.prepareCodexResponseIdRejectionRepair(attemptId);
		expect(repaired).toBe(true);

		// Drained through its exact owner: neither map still holds this
		// attempt (matches `releaseCodexResponseIdAttempt`'s own contract).
		expect(internals(provider).continuationOwnerByAttempt.has(attemptId)).toBe(
			false,
		);
		expect(internals(provider).pendingResponseIdByAttempt.has(attemptId)).toBe(
			false,
		);
		// Retired (tombstoned), not deleted: generation preserved, state
		// cleared -- exactly the eviction shape sweepCodexResponseIdState uses.
		const laneEntry = internals(provider).responseIdLanes.get(lane as string);
		expect(laneEntry?.state).toBeUndefined();
		expect(laneEntry?.generation).toBeGreaterThan(0);
		expect(laneEntry?.tombstonedAt).toBeDefined();
		// Suppressed for the lane: selectCodexResponseIdOwner must refuse
		// response-id ownership on this lane again immediately.
		expect(
			internals(provider).responseIdRejectedLanes.get(lane as string),
		).toBeGreaterThan(Date.now());
	});

	it("a second rejection on the same (now-suppressed) lane performs no repair (scenario 7)", async () => {
		const provider = new CodexProvider();
		const { attemptId } = await primeContinuedAttempt(provider, "second");
		expect(provider.prepareCodexResponseIdRejectionRepair(attemptId)).toBe(
			true,
		);
		// Calling again with the SAME (already-drained) attemptId: idempotent
		// no-op, matching the method's own documented contract.
		expect(provider.prepareCodexResponseIdRejectionRepair(attemptId)).toBe(
			false,
		);

		// And the lane itself cannot get a fresh response-id-owned attempt at
		// all while suppressed, so a follow-up genuinely-new physical attempt
		// on the same lane cannot ever reach a "continued" state to repair
		// a second time.
		const followUpRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-second-followup",
				attemptId: "aid-second-followup",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		const followUpBody = (await followUpRequest.json()) as Record<
			string,
			unknown
		>;
		expect(followUpBody.previous_response_id).toBeUndefined();
	});

	it("a cold (never-continued) attempt performs no repair even if misclassified as rejected (scenario 7)", async () => {
		const provider = new CodexProvider();
		const coldAttemptId = "aid-cold-no-repair";
		const coldRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-cold-no-repair",
				attemptId: coldAttemptId,
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		const coldBody = (await coldRequest.json()) as Record<string, unknown>;
		expect(coldBody.previous_response_id).toBeUndefined();

		expect(provider.prepareCodexResponseIdRejectionRepair(coldAttemptId)).toBe(
			false,
		);
	});

	it("an attempt owned by turn-state (not response-id) performs no repair", async () => {
		const provider = new CodexProvider();
		// No native header, no opt-in: response-id never owns this attempt.
		const request = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": "rid-turn-state-owned",
				"x-better-ccflare-attempt-id": "aid-turn-state-owned",
				"x-better-ccflare-attempt-ordinal": "1",
				"x-better-ccflare-attempt-cause": "initial",
				"x-better-ccflare-final-model": physicalModel,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 100,
				stream: true,
				system: instructions,
				metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
				messages: [{ role: "user", content: firstUserText }],
			}),
		});
		await provider.transformRequestBody(request, account);
		expect(
			provider.prepareCodexResponseIdRejectionRepair("aid-turn-state-owned"),
		).toBe(false);
	});

	it("an unknown attemptId, null, or undefined performs no repair", () => {
		const provider = new CodexProvider();
		expect(provider.prepareCodexResponseIdRejectionRepair("nope")).toBe(false);
		expect(provider.prepareCodexResponseIdRejectionRepair(null)).toBe(false);
		expect(provider.prepareCodexResponseIdRejectionRepair(undefined)).toBe(
			false,
		);
	});

	it("a successful repair can establish its own fresh checkpoint once the suppression window has elapsed, and no stale state survives the repair (scenario 8)", async () => {
		const provider = new CodexProvider();
		const { attemptId } = await primeContinuedAttempt(provider, "fresh");
		const lane = internals(provider).pendingResponseIdByAttempt.get(attemptId)
			?.lane as string;
		expect(provider.prepareCodexResponseIdRejectionRepair(attemptId)).toBe(
			true,
		);
		// No stale state survives the repair: the old checkpoint is gone
		// immediately (already asserted structurally above), and the
		// per-attempt bookkeeping this repair drained cannot leak into a
		// later attempt on the same lane.
		expect(
			internals(provider).responseIdLanes.get(lane)?.state,
		).toBeUndefined();

		// Directly clear the suppression window (equivalent to
		// CODEX_RESPONSE_ID_REJECTED_TTL_MS having elapsed) rather than
		// waiting the real 5 minutes -- CODEX_RESPONSE_ID_REJECTED_TTL_MS is
		// exported for exactly this kind of deterministic fast-forward.
		expect(CODEX_RESPONSE_ID_REJECTED_TTL_MS).toBeGreaterThan(0);
		internals(provider).responseIdRejectedLanes.delete(lane);

		// A fresh cold send on the same lane now establishes its OWN new
		// checkpoint under the normal promotion rules.
		const freshColdRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-fresh-cold-2",
				attemptId: "aid-fresh-cold-2",
				messages: [{ role: "user", content: firstUserText }],
				stream: true,
			}),
			account,
		);
		const freshColdBody = (await freshColdRequest.json()) as Record<
			string,
			unknown
		>;
		expect(freshColdBody.previous_response_id).toBeUndefined();
		const freshColdResponse = await provider.processResponse(
			completedResponse({
				requestId: "rid-fresh-cold-2",
				attemptId: "aid-fresh-cold-2",
				responseId: "resp-fresh-2",
				outputText: "hello again",
				stream: true,
			}),
			null,
		);
		await freshColdResponse.text();
		const freshContinuedRequest = await provider.transformRequestBody(
			nativeResponseIdRequestFor({
				requestId: "rid-fresh-continued-2",
				attemptId: "aid-fresh-continued-2",
				messages: [
					{ role: "user", content: firstUserText },
					{
						role: "assistant",
						content: [{ type: "text", text: "hello again" }],
					},
					{ role: "user", content: "continue please" },
				],
				stream: true,
			}),
			account,
		);
		const freshContinuedBody = (await freshContinuedRequest.json()) as Record<
			string,
			unknown
		>;
		expect(freshContinuedBody.previous_response_id).toBe("resp-fresh-2");
	});
});

describe("KTD13 aggregate byte budget exhaustion (scenario 7)", () => {
	/**
	 * Drives `responseIdBudgetBytes` to the real `chargeCodexResponseIdBytes`
	 * boundary by repeatedly staging genuine pending response-id candidates
	 * (never releasing or promoting them) through the real
	 * `selectCodexResponseIdOwner` charge path -- the exact code KTD13 uses in
	 * production, unmocked. Every iteration sends an identically-shaped
	 * request (same message count, same headers, only a fresh attemptId), so
	 * the only thing that changes call to call is the accumulated aggregate
	 * charge; the first call that fails to stage is therefore attributable
	 * to the budget alone, not to any other eligibility gate. Bounded by
	 * `maxIterations` so a future change to the retention constants fails
	 * loudly (via the thrown error) instead of looping forever.
	 */
	async function primeUntilBudgetVetoed(
		provider: CodexProvider,
		maxIterations = 400,
	): Promise<{
		vetoedAttemptId: string;
		chargePerAttempt: number;
		primedCount: number;
	}> {
		let chargePerAttempt = 0;
		for (let i = 0; i < maxIterations; i++) {
			const attemptId = `budget-prime-${i}`;
			const request = await provider.transformRequestBody(
				bigColdRequestFor({ attemptId, messageCount: 2048 }),
				account,
			);
			await request.json();
			const pending =
				internals(provider).pendingResponseIdByAttempt.get(attemptId);
			if (!pending) {
				return { vetoedAttemptId: attemptId, chargePerAttempt, primedCount: i };
			}
			chargePerAttempt = pending.chargedBytes;
		}
		throw new Error(
			"budget never exhausted within maxIterations -- KTD13 retention constants likely changed; update this test's message size/iteration bound",
		);
	}

	it("a budget-vetoed attempt is never staged as response-id-owned, and a rejection arriving on it performs no repair and consumes no budget slot", async () => {
		const provider = new CodexProvider();
		const { vetoedAttemptId, chargePerAttempt, primedCount } =
			await primeUntilBudgetVetoed(provider);

		// Sanity: this genuinely exercised the real aggregate ceiling -- the
		// veto happened because the next real charge would overflow it, not
		// for any unrelated reason (all priming requests were identically
		// shaped).
		expect(primedCount).toBeGreaterThan(0);
		expect(chargePerAttempt).toBeGreaterThan(0);
		const budgetBeforeVetoedAttempt = internals(provider).responseIdBudgetBytes;
		expect(budgetBeforeVetoedAttempt + chargePerAttempt).toBeGreaterThan(
			CODEX_RESPONSE_ID_MAX_AGGREGATE_BYTES,
		);

		// (a) A budget-vetoed attempt is never staged as response-id-owned:
		// no pending candidate, and the attempt is recorded as turn-state-
		// owned (the fork's normal fallback), never response-id.
		expect(
			internals(provider).pendingResponseIdByAttempt.has(vetoedAttemptId),
		).toBe(false);
		expect(
			internals(provider).continuationOwnerByAttempt.get(vetoedAttemptId)
				?.owner,
		).toBe("turn-state");

		// (b) A rejection arriving on this (never-staged) attempt performs no
		// repair and consumes no budget slot.
		expect(
			await isCodexResponseIdRejectionError(
				rejectedIdResponse("code-not-found"),
				readJson,
			),
		).toBe(true);
		expect(
			provider.prepareCodexResponseIdRejectionRepair(vetoedAttemptId),
		).toBe(false);
		expect(internals(provider).responseIdBudgetBytes).toBe(
			budgetBeforeVetoedAttempt,
		);
		expect(
			internals(provider).pendingResponseIdByAttempt.has(vetoedAttemptId),
		).toBe(false);
		expect(
			internals(provider).continuationOwnerByAttempt.get(vetoedAttemptId)
				?.owner,
		).toBe("turn-state");
	}, 20_000);
});
