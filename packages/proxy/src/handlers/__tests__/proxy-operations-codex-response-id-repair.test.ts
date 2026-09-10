// U5c Behavior 2 (KTD6/KTD13 rejected-id repair) -- no-buffered-body edge case.
//
// proxy-operations.ts's repair block retires a rejected previous_response_id
// lane unconditionally (a rejected checkpoint must never be offered again),
// but only resends full history when this physical attempt actually buffered
// a replay body (`currentReplayBody`). A prior version of this block did
// `body: new Uint8Array(currentReplayBody)` unconditionally, which threw a
// TypeError on a live rejection with no buffered replay body -- see the git
// history on the "Behavior 2" block in proxy-operations.ts. This file proves
// the guarded branch: a recognized rejection arriving on a Codex attempt
// with NO buffered replay body must (a) not throw, (b) not dispatch a
// repair retry (no extra physical-send, no extra attempt-budget slot), (c)
// still retire/suppress the lane so a later turn cannot re-offer the
// rejected id, and (d) let the original rejection response reach normal
// error handling intact instead of being drained and lost.
//
// Construction note (see also provider.response-id-rejection-repair.test.ts's
// own header): a single physical attempt cannot naturally have BOTH a null
// `currentReplayBody` AND genuine response-id ownership staged for it,
// because both are derived from the exact same buffer --
// `CodexProvider.transformRequestBody` stages ownership by parsing the same
// body proxy-operations.ts uses to build `currentReplayBody`, and a bodyless
// request makes that parse throw before any attempt-id-keyed ownership state
// is ever touched (transformRequestBody's try/catch returns the request
// unchanged on a JSON-parse failure, see provider.ts). So this test primes
// the real, unmocked CodexProvider SINGLETON (the exact instance
// proxy-operations.ts's resolveProviderForAccount resolves for a "codex"
// account) through a genuine cold -> committed-checkpoint -> continued
// exchange under a fixed attempt id, then mocks ONLY `crypto.randomUUID` so
// `proxyWithAccount`'s internally-generated "initial" attempt id for a
// SEPARATE, later, fully bodyless physical send collides with that primed
// id. `crypto.randomUUID` determinism is a standard test technique
// unrelated to the guard itself: `prepareCodexResponseIdRejectionRepair`
// and the guarded `if (repairReplayBody)` fork it feeds are both exercised
// completely unmocked, on their real return values, against real internal
// provider state.
//
// This condition WAS verified reachable through the genuine, unmocked code
// path (confirmed empirically before writing this file): a fully bodyless
// `proxyWithAccount` call for a codex account still resolves a physical
// model from the account's own model_mappings default and reaches the
// physical send -- it does not short-circuit earlier for lack of a request
// body. The `crypto.randomUUID` mock is therefore only a determinism aid
// for correlating the attempt id across two independent calls, not a
// bypass of anything the guard depends on.
import { describe, expect, it, mock, spyOn } from "bun:test";
import { getProvider } from "@better-ccflare/providers";
import {
	CODEX_DEFAULT_ENDPOINT,
	type CodexProvider,
} from "@better-ccflare/providers/codex";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const usageCollectorModule = await import("../../usage-collector");
const { codexWebSocketTransport } = await import(
	"../../codex-websocket-transport"
);
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");
const { proxyWithAccount } = await import("../proxy-operations");

const FIXED_ATTEMPT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const physicalModel = "gpt-5.4";
const sessionId = "55555555-5555-4555-8555-555555555555";

function makeCodexAccount(): Account {
	return {
		id: "codex-no-buffered-body-repair-account",
		name: "codex-no-buffered-body-repair-test",
		provider: "codex",
		api_key: null,
		refresh_token: "",
		access_token: "test-access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: JSON.stringify({ sonnet: physicalModel }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeRequestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

function completedResponse(params: {
	requestId: string;
	attemptId: string;
	responseId: string;
	outputText: string;
}): Response {
	const { requestId, attemptId, responseId, outputText } = params;
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
			"x-better-ccflare-request-stream": "true",
		},
	});
}

/** Native-Responses request exactly as prepareAttemptHeaders would build it. */
function nativeResponseIdRequestFor(params: {
	requestId: string;
	attemptId: string;
	messages: unknown[];
}): Request {
	const { requestId, attemptId, messages } = params;
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
		stream: true,
		system: "keep the same turn",
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
 * Primes the REAL CodexProvider registry singleton (the exact instance
 * proxy-operations.ts's `resolveProviderForAccount` resolves for a "codex"
 * account) through a genuine cold -> committed-checkpoint -> continued
 * exchange, staging response-id ownership for `attemptId` entirely via real,
 * unmocked provider code. Mirrors
 * provider.response-id-rejection-repair.test.ts's own `primeContinuedAttempt`
 * helper, adapted to drive the shared singleton rather than a fresh instance.
 */
async function primeSingletonContinuedAttempt(
	provider: CodexProvider,
	account: Parameters<CodexProvider["transformRequestBody"]>[1],
	attemptId: string,
	suffix: string,
): Promise<{ lane: string; coldResponseId: string }> {
	const coldRequest = await provider.transformRequestBody(
		nativeResponseIdRequestFor({
			requestId: `rid-${suffix}-cold`,
			attemptId: `aid-${suffix}-cold`,
			messages: [{ role: "user", content: "inspect no-buffered-body repair" }],
		}),
		account,
	);
	await coldRequest.json();
	const coldResponseId = `resp-${suffix}-cold-1`;
	const coldResponse = await provider.processResponse(
		completedResponse({
			requestId: `rid-${suffix}-cold`,
			attemptId: `aid-${suffix}-cold`,
			responseId: coldResponseId,
			outputText: "hello",
		}),
		null,
	);
	await coldResponse.text();

	const continuedRequest = await provider.transformRequestBody(
		nativeResponseIdRequestFor({
			requestId: `rid-${suffix}-continued`,
			attemptId,
			messages: [
				{ role: "user", content: "inspect no-buffered-body repair" },
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
				{ role: "user", content: "continue please" },
			],
		}),
		account,
	);
	const continuedBody = (await continuedRequest.json()) as Record<
		string,
		unknown
	>;
	expect(continuedBody.previous_response_id).toBe(coldResponseId);

	type CodexProviderInternalsForTest = {
		pendingResponseIdByAttempt: Map<string, { lane: string }>;
	};
	const lane = (
		provider as unknown as CodexProviderInternalsForTest
	).pendingResponseIdByAttempt.get(attemptId)?.lane;
	if (!lane) {
		throw new Error(
			"priming failed to stage response-id ownership for the fixed attempt id",
		);
	}
	return { lane, coldResponseId };
}

type CodexProviderInternalsForTest = {
	pendingResponseIdByAttempt: Map<string, unknown>;
	continuationOwnerByAttempt: Map<string, unknown>;
	responseIdLanes: Map<
		string,
		{ state?: unknown; tombstonedAt?: number; generation: number }
	>;
	responseIdRejectedLanes: Map<string, number>;
};

describe("proxyWithAccount Codex rejected-id repair -- no buffered replay body", () => {
	it("does not throw, does not dispatch a repair retry, retires the lane, and preserves the original rejection response", async () => {
		const provider = getProvider("codex") as unknown as CodexProvider;
		const primingAccount = makeCodexAccount() as Parameters<
			CodexProvider["transformRequestBody"]
		>[1];

		const { lane } = await primeSingletonContinuedAttempt(
			provider,
			primingAccount,
			FIXED_ATTEMPT_ID,
			"no-buffered-body",
		);
		const internals = provider as unknown as CodexProviderInternalsForTest;
		// Sanity: priming genuinely staged an owned checkpoint before the call
		// under test runs.
		expect(internals.pendingResponseIdByAttempt.has(FIXED_ATTEMPT_ID)).toBe(
			true,
		);
		expect(internals.responseIdLanes.get(lane)?.state).toBeDefined();

		const randomUUIDSpy = spyOn(crypto, "randomUUID").mockReturnValue(
			FIXED_ATTEMPT_ID as never,
		);
		const originalFetch = globalThis.fetch;
		const outboundRequests: Request[] = [];
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);
		const usageCollector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(() => Promise.resolve()),
		} as never);

		try {
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request =
					input instanceof Request ? input : new Request(String(input));
				outboundRequests.push(request.clone());
				return new Response(
					JSON.stringify({ error: { code: "previous_response_not_found" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			});

			// The regression condition itself: a genuinely bodyless client
			// request with a null requestBodyBuffer. proxy-operations.ts
			// resolves a physical model from the account's own defaults and
			// still reaches the physical send -- it does not short-circuit
			// earlier for lack of a request body (confirmed empirically before
			// writing this test).
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "anthropic-version": "2023-06-01" },
			});
			const ledger = new RoutingAttemptLedger();

			let thrown: unknown;
			let response: unknown;
			try {
				response = await proxyWithAccount(
					request,
					new URL(request.url),
					makeCodexAccount(),
					makeRequestMeta("no-buffered-body-repair"),
					null,
					() => undefined,
					0,
					makeProxyContext(),
					undefined,
					undefined,
					undefined,
					undefined,
					false,
					undefined,
					ledger,
				);
			} catch (err) {
				thrown = err;
			}

			// (a) No exception is thrown.
			expect(thrown).toBeUndefined();
			expect(response).toBeInstanceOf(Response);

			// (b) No repair retry is dispatched: the physical-send boundary is
			// not re-entered a second time, and no extra attempt-budget slot is
			// consumed.
			expect(outboundRequests).toHaveLength(1);
			expect(websocketAttempt).toHaveBeenCalledTimes(1);
			expect(ledger.physicalAttemptCount).toBe(1);
			expect(ledger.attemptedCount).toBe(1);
			// The one physical send that did happen genuinely carried no body --
			// confirms `currentReplayBody` really was null for this attempt,
			// not merely empty-but-present.
			expect(outboundRequests[0]?.body).toBeNull();

			// (c) The lane IS still retired/suppressed: a subsequent turn must
			// not be able to re-offer the rejected id.
			expect(internals.pendingResponseIdByAttempt.has(FIXED_ATTEMPT_ID)).toBe(
				false,
			);
			expect(internals.continuationOwnerByAttempt.has(FIXED_ATTEMPT_ID)).toBe(
				false,
			);
			const laneEntry = internals.responseIdLanes.get(lane);
			expect(laneEntry?.state).toBeUndefined();
			expect(laneEntry?.tombstonedAt).toBeDefined();
			expect(internals.responseIdRejectedLanes.get(lane)).toBeGreaterThan(
				Date.now(),
			);

			// (d) The original rejection response still reaches normal error
			// handling rather than being drained and lost: status and body are
			// exactly what upstream sent.
			const finalResponse = response as Response;
			expect(finalResponse.status).toBe(400);
			expect(await finalResponse.clone().json()).toEqual({
				error: { code: "previous_response_not_found" },
			});
		} finally {
			globalThis.fetch = originalFetch;
			websocketAttempt.mockRestore();
			usageCollector.mockRestore();
			randomUUIDSpy.mockRestore();
		}
	});
});
