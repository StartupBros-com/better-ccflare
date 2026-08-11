/**
 * Success-conditioned combo-override model observability at the
 * proxyWithAccount level (packages/proxy/src/handlers/proxy-operations.ts).
 *
 * This exercises the exact mechanism the task warned about: applied_model
 * (and the comboModelOverride delta) must be tied to the attempt whose
 * response is actually returned, never blindly written from a mutable
 * requestMeta field inside the per-attempt loop. Here we simulate the state
 * proxy.ts would have already established before this attempt — an earlier
 * agent-preference rewrite baseline in requestMeta.appliedModel — and verify
 * a combo slot's modelOverride correctly wins (last rewrite wins) without
 * losing track of original_model or the delta's "from" baseline.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { CacheFlightCohortSealReceipt } from "@better-ccflare/core";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import type { StartMessage } from "../../worker-messages";
import {
	type ModelFallbackExecutionPolicy,
	proxyWithAccount,
} from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "combo-observability-test",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
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
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeRequestBody(model: string) {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(1),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://openrouter.ai/api/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeOpenAiChatCompletion(model: string): object {
	return {
		id: "chatcmpl_route_candidate",
		object: "chat.completion",
		created: 1_700_000_000,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "hi" },
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: 1,
			completion_tokens: 1,
			total_tokens: 2,
		},
	};
}

function makeSealReceipt(
	id = "cohort_observation_partition_proxy_success",
): CacheFlightCohortSealReceipt {
	const serviceEpoch = Object.freeze({
		id: "cohort_service_epoch_proxy_success",
		occurrenceId: "cohort_service_occurrence_proxy_success",
		sealContractVersion: 1,
		deploymentRevision: "abcdef123456",
		serviceInstanceId: "cohort_service_instance_proxy_success",
		processStartedAt: "2026-08-08T00:00:00.000Z",
		nativeCacheState: "enabled" as const,
		recorderState: "enabled" as const,
		keepalivePolicy: Object.freeze({
			globalTtlMinutes: 5,
			xaiTtlMinutes: 0,
			effectiveXaiEnabled: true,
			effectiveXaiTtlMinutes: 5,
		}),
		completeness: "complete" as const,
		unavailableDimensions: Object.freeze([]),
	});
	return Object.freeze({
		serviceEpoch,
		observationPartition: Object.freeze({
			id,
			serviceEpochId: serviceEpoch.id,
			servingAccountScope: "cohort_serving_account_scope_proxy_success",
			routeModelEpoch: "cohort_route_model_epoch_proxy_success",
			completeness: "complete" as const,
			unavailableDimensions: Object.freeze([]),
		}),
		completeness: "complete" as const,
		unavailableDimensions: Object.freeze([]),
	});
}

function installCohortSeal(
	ctx: ProxyContext,
	receipt: CacheFlightCohortSealReceipt,
) {
	const captureReceipt = mock(() => receipt);
	(
		ctx as ProxyContext & {
			cacheFlightCohortSeal: { captureReceipt: typeof captureReceipt };
		}
	).cacheFlightCohortSeal = { captureReceipt };
	return captureReceipt;
}

describe("proxyWithAccount — combo override success-conditioning / observability", () => {
	let originalFetch: typeof globalThis.fetch;
	let restoreUsageCollector = (): void => {};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		restoreUsageCollector();
		restoreUsageCollector = (): void => {};
	});

	function installUsageCollector(): ReturnType<typeof mock> {
		const handleStart = mock(() => undefined);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart,
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as unknown as usageCollectorModule.UsageCollector);
		restoreUsageCollector = () => collectorSpy.mockRestore();
		return handleStart;
	}

	it("combo override wins over an earlier agent rewrite: applied_model = combo override, original_model = client model, delta.from = agent baseline", async () => {
		const handleStart = installUsageCollector();
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: "combo-override-model",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody("client-requested-model");
		const req = makeRequest(bodyBuffer);
		const requestMeta = makeRequestMeta({
			// Simulates what agent-interception already established BEFORE combo
			// routing runs: client asked for "client-requested-model", an agent
			// preference rewrote it to "agent-preferred-model" — the
			// pre-combo-override baseline (effectiveModel).
			originalModel: "client-requested-model",
			appliedModel: "agent-preferred-model",
			comboName: "test-combo",
			comboSlotIndex: 0,
		});
		const modelFallbackPolicy: ModelFallbackExecutionPolicy = {
			routeCandidateId: "candidate-1",
			// Populated only by the genuine combo-slot call site in proxy.ts:
			// the pre-override baseline (effectiveModel) at the time this
			// attempt was planned.
			comboModelOverrideFrom: "agent-preferred-model",
		};

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			"combo-override-model", // modelOverride: the combo slot's override
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			modelFallbackPolicy,
		);

		expect(result?.status).toBe(200);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		// Last rewrite wins: the combo override beats the earlier agent
		// rewrite, but original_model still reflects the true client request.
		expect(startMessage.originalModel).toBe("client-requested-model");
		expect(startMessage.appliedModel).toBe("combo-override-model");
		expect(startMessage.comboModelOverrideFrom).toBe("agent-preferred-model");
		expect(startMessage.comboModelOverrideTo).toBe("combo-override-model");
	});

	it("does not attribute a combo override when the account/slot desync guard leaves modelOverride null", async () => {
		const handleStart = installUsageCollector();
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_2",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: "client-requested-model",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody("client-requested-model");
		const req = makeRequest(bodyBuffer);
		const requestMeta = makeRequestMeta({
			originalModel: "client-requested-model",
			appliedModel: "client-requested-model",
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			null, // no modelOverride (e.g. desync guard tripped upstream in proxy.ts)
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			undefined, // no modelFallbackPolicy at all
		);

		expect(result?.status).toBe(200);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		expect(startMessage.originalModel == null).toBe(true);
		expect(startMessage.appliedModel == null).toBe(true);
		expect(startMessage.comboModelOverrideFrom == null).toBe(true);
		expect(startMessage.comboModelOverrideTo == null).toBe(true);
	});

	it("captures an xAI success receipt with the exact model fallback route candidate", async () => {
		const handleStart = installUsageCollector();
		globalThis.fetch = mock(async () =>
			jsonResponse(makeOpenAiChatCompletion("grok-4"), 200),
		);

		const bodyBuffer = makeRequestBody("grok-4");
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		const receipt = makeSealReceipt();
		const captureReceipt = installCohortSeal(ctx, receipt);
		const account = makeAccount({
			id: "xai-success-account",
			name: "xAI Success Account",
			provider: "xai",
			custom_endpoint: null,
			model_mappings: null,
		});
		const requestMeta = makeRequestMeta({
			id: "req-xai-route-candidate-success",
			cacheFlightRecorderConversationId: "cfr_success0000000000000000000000",
			xaiCacheIdentityFingerprint: "identity12345678",
			xaiCachePrefixFingerprint: "prefix123456789",
			xaiCacheNativeActive: true,
		});
		const modelFallbackPolicy: ModelFallbackExecutionPolicy = {
			routeCandidateId: "route-candidate-policy-success",
		};

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			modelFallbackPolicy,
		);

		expect(result?.status).toBe(200);
		await result?.text();
		expect(captureReceipt).toHaveBeenCalledTimes(1);
		const captureInput = captureReceipt.mock.calls[0]?.[0] as {
			finalServingAccount: Account;
			attemptedTransportModel: string | null;
			routeCandidateId: string | null;
		};
		expect(captureInput.finalServingAccount).toBe(account);
		expect(captureInput.attemptedTransportModel).toBe("grok-4");
		expect(captureInput.routeCandidateId).toBe(
			"route-candidate-policy-success",
		);
		expect(handleStart).toHaveBeenCalledTimes(1);
		const startMessage = handleStart.mock.calls[0]?.[0] as StartMessage;
		expect(startMessage.cacheFlightCohortSealReceipt).toBe(receipt);
		expect("attemptedModel" in startMessage).toBe(false);
		expect("routeCandidateId" in startMessage).toBe(false);
	});
});
