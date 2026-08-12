import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import type { CacheFlightCohortSealReceipt } from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import type { StartMessage } from "../worker-messages";

interface PricingTokens {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

type PricingImplementation = (
	model: string,
	tokens: PricingTokens,
) => Promise<number>;

let pricingImplementation: PricingImplementation = async () => 0;
const estimateCostUSD = mock((model: string, tokens: PricingTokens) =>
	pricingImplementation(model, tokens),
);

// Spread the real module so every other export (constants, isValidClaudeModel,
// isOverloadReason, computeRateLimitBackoffMs, ...) stays intact for the rest
// of the process — mock.module replaces the WHOLE module globally and across
// file boundaries in Bun, so a partial stub here silently breaks unrelated
// modules imported later in the same test run. Only estimateCostUSD needs
// interception here (routed through a controllable pricingImplementation per
// test case).
const actualCore = await import("@better-ccflare/core");

mock.module("@better-ccflare/core", () => ({
	...actualCore,
	estimateCostUSD,
}));

// Unlike @better-ccflare/core above, this file never touches
// @better-ccflare/database's real exports at runtime: every test constructs
// UsageCollector directly with hand-rolled fake dbOps/asyncWriter objects
// (see makeHarness below), so getUsageCollector()'s internal
// `new DatabaseOperations()` / `new AsyncDbWriter()` fallback is never
// reached. Stubbing DatabaseOperations/AsyncDbWriter here bought nothing and
// cost every other test file in the process a broken DatabaseFactory
// singleton (mock.module has no per-file isolation without --isolate, and
// bun pre-evaluates every file's top-level mock.module calls before running
// any test, so even an afterAll restore here can't protect a file whose
// beforeAll runs first). Do not reintroduce this mock without also auditing
// bun's cross-file mock.module ordering.

// Restore @better-ccflare/core once this file's tests finish so later test
// files in the same process (mock.module has no per-file isolation without
// --isolate) resolve the real exports again instead of the stub registered
// above.
afterAll(() => {
	mock.module("@better-ccflare/core", () => actualCore);
});

const { UsageCollector } = await import("../usage-collector");
type UsageCollectorInstance = InstanceType<typeof UsageCollector>;

const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

interface RecorderWrite {
	recorderConversationId: string;
	turn: import("@better-ccflare/core").TurnEvidence;
	sealReceipt?: CacheFlightCohortSealReceipt | null;
}

interface TestHarness {
	collector: UsageCollectorInstance;
	saveRequestIds: string[];
	savedUsages: Map<string, Record<string, number | undefined>>;
	payloads: Map<string, string>;
	recorderWrites: RecorderWrite[];
	markedIncomplete: Array<{
		id: string;
		dropped: boolean;
		droppedCount?: number;
	}>;
	summaryCosts: Map<string, number | undefined>;
	summaries: string[];
	summaryDetails: import("@better-ccflare/types").RequestResponse[];
}

interface HarnessOptions {
	acceptMetadata?: boolean;
	recorderFailure?: Error;
	storePayloads?: boolean;
}

interface TestRequestState {
	startMessage: StartMessage;
	buffer: string;
	chunks: Uint8Array[];
	chunksBytes: number;
	usagePayloadSeq?: number;
	usage: {
		iterations?: unknown[];
		iterationsSeq?: number;
		fallbackIterationSeen?: boolean;
		fallbackIterationModel?: string;
		iterationsTruncated?: boolean;
	};
}

interface TestableCollector {
	cleanupStaleRequests(): void;
	missingStateWarnings: Set<string>;
	pricingTimeoutMs: number;
	requests: Map<string, TestRequestState>;
}

function makeStartMessage(
	requestId: string,
	overrides: Partial<StartMessage> = {},
): StartMessage {
	return {
		type: "start",
		messageId: `message-${requestId}`,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "text/event-stream" },
		isStream: true,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		originalModel: null,
		appliedModel: null,
		comboName: null,
		comboModelOverrideFrom: null,
		comboModelOverrideTo: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		...overrides,
		requestId,
	};
}

function createHarness(options: HarnessOptions | boolean = {}): TestHarness {
	const resolved =
		typeof options === "boolean" ? { storePayloads: options } : options;
	const saveRequestIds: string[] = [];
	const savedUsages = new Map<string, Record<string, number | undefined>>();
	const payloads = new Map<string, string>();
	const recorderWrites: RecorderWrite[] = [];
	const markedIncomplete: Array<{
		id: string;
		dropped: boolean;
		droppedCount?: number;
	}> = [];
	const summaryCosts = new Map<string, number | undefined>();
	const summaries: string[] = [];
	const summaryDetails: import("@better-ccflare/types").RequestResponse[] = [];
	const pendingWrites = new Set<Promise<void>>();

	const dbOps = {
		async updateAccountUsage(): Promise<void> {},
		async saveRequest(requestId: string, ...args: unknown[]): Promise<void> {
			saveRequestIds.push(requestId);
			const usage = args[8];
			if (usage && typeof usage === "object") {
				savedUsages.set(requestId, usage as Record<string, number | undefined>);
			}
		},
		async saveRequestPayloadRaw(
			requestId: string,
			payload: string,
		): Promise<void> {
			payloads.set(requestId, payload);
		},
		async appendCacheFlightRecorderTurn(
			recorderConversationId: string,
			turn: import("@better-ccflare/core").TurnEvidence,
			_recordedAt?: number,
			sealReceipt?: CacheFlightCohortSealReceipt | null,
		): Promise<void> {
			if (resolved.recorderFailure) throw resolved.recorderFailure;
			recorderWrites.push({
				recorderConversationId,
				turn,
				...(sealReceipt !== undefined ? { sealReceipt } : {}),
			});
		},
		async markCacheFlightRecorderIncomplete(
			recorderConversationId: string,
			options?: { dropped?: boolean; droppedCount?: number },
		): Promise<void> {
			markedIncomplete.push({
				id: recorderConversationId,
				dropped: options?.dropped === true,
				droppedCount: options?.droppedCount,
			});
		},
	};

	const asyncWriter = {
		enqueue(task: () => Promise<void> | void): boolean {
			if (resolved.acceptMetadata === false) return false;
			const pending = Promise.resolve().then(task);
			pendingWrites.add(pending);
			void pending.finally(() => pendingWrites.delete(pending));
			return true;
		},
		async dispose(): Promise<void> {
			await Promise.allSettled([...pendingWrites]);
		},
		canAcceptPayload(): boolean {
			return true;
		},
		enqueuePayload(
			_requestId: string,
			_bytes: number,
			task: () => Promise<void> | void,
		): boolean {
			this.enqueue(task);
			return true;
		},
	};

	const collector = new UsageCollector(
		dbOps as never,
		asyncWriter as never,
		() => resolved.storePayloads === true,
		(summary) => {
			summaries.push(summary.id);
			summaryCosts.set(summary.id, summary.costUsd);
			summaryDetails.push(summary);
		},
	);

	return {
		collector,
		markedIncomplete,
		payloads,
		recorderWrites,
		saveRequestIds,
		savedUsages,
		summaries,
		summaryDetails,
		summaryCosts,
	};
}

function testable(collector: UsageCollectorInstance): TestableCollector {
	return collector as unknown as TestableCollector;
}

function modelBearingChunk(): Uint8Array {
	return new TextEncoder().encode(
		'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
	);
}

const FABLE_MODEL = "claude-fable-test";
const HAIKU_MODEL = "claude-haiku-test";
const OPUS_MODEL = "claude-opus-test";

function useDeterministicModelPricing(): void {
	pricingImplementation = async (model, tokens) => {
		const modelFactor =
			model === FABLE_MODEL
				? 1
				: model === OPUS_MODEL
					? 2
					: model === HAIKU_MODEL
						? 3
						: undefined;
		if (modelFactor === undefined) {
			throw new Error(`Unexpected model passed to pricing: ${model}`);
		}

		return (
			modelFactor *
			((tokens.inputTokens ?? 0) +
				(tokens.outputTokens ?? 0) * 10 +
				(tokens.cacheReadInputTokens ?? 0) * 100 +
				(tokens.cacheCreationInputTokens ?? 0) * 1_000)
		);
	};
}

function captureFallbackUsageLogs(): {
	events: LogEvent[];
	stop: () => void;
} {
	const events: LogEvent[] = [];
	const onLog = (event: LogEvent) => {
		if (event.msg === "anthropic_server_side_fallback") events.push(event);
	};
	logBus.on("log", onLog);

	return {
		events,
		stop: () => logBus.off("log", onLog),
	};
}

function makeSealReceipt(
	id = "cohort_observation_partition_safe",
): CacheFlightCohortSealReceipt {
	const serviceEpoch = Object.freeze({
		id: "cohort_service_epoch_safe",
		occurrenceId: "cohort_service_occurrence_safe",
		sealContractVersion: 1,
		deploymentRevision: "abcdef123456",
		serviceInstanceId: "cohort_service_instance_safe",
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
			servingAccountScope: "cohort_serving_account_scope_safe",
			routeModelEpoch: "cohort_route_model_epoch_safe",
			completeness: "complete" as const,
			unavailableDimensions: Object.freeze([]),
		}),
		completeness: "complete" as const,
		unavailableDimensions: Object.freeze([]),
	});
}

describe("UsageCollector request lifecycle", () => {
	const realDateNow = Date.now;
	const previousPricingTimeout = process.env.CF_PRICING_TIMEOUT_MS;
	const previousStreamTimeout = process.env.CF_STREAM_TIMEOUT_MS;
	let now = 1_700_000_000_000;
	const collectors: UsageCollectorInstance[] = [];

	beforeEach(() => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		delete process.env.CF_PRICING_TIMEOUT_MS;
		process.env.CF_STREAM_TIMEOUT_MS = String(INACTIVITY_TIMEOUT_MS);
		pricingImplementation = async () => 0;
		estimateCostUSD.mockClear();
	});

	afterEach(() => {
		for (const collector of collectors.splice(0)) collector.dispose();
		Date.now = realDateNow;
		if (previousPricingTimeout === undefined) {
			delete process.env.CF_PRICING_TIMEOUT_MS;
		} else {
			process.env.CF_PRICING_TIMEOUT_MS = previousPricingTimeout;
		}
		if (previousStreamTimeout === undefined) {
			delete process.env.CF_STREAM_TIMEOUT_MS;
		} else {
			process.env.CF_STREAM_TIMEOUT_MS = previousStreamTimeout;
		}
	});

	function harness(storePayloads = false): TestHarness {
		const value = createHarness(storePayloads);
		collectors.push(value.collector);
		return value;
	}

	describe("fallback usage attribution", () => {
		it("uses fresh top-level totals when the retained fallback iteration snapshot is stale", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-stale-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 10,
									output_tokens: 0,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 10,
											output_tokens: 0,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 10,
											output_tokens: 0,
										},
									],
								},
							},
						})}\n\nevent: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							usage: { input_tokens: 10, output_tokens: 500 },
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 10,
				completionTokens: 500,
				totalTokens: 510,
				costUsd: 10_020,
				inputTokens: 10,
				outputTokens: 500,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 10,
				outputTokens: 500,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "top_level",
				iterationsStale: true,
				// Both retained iterations are pre-output declines (output_tokens:
				// 0), so the aggregate built alongside the stale snapshot is
				// empty, not usable-and-nonempty — top-level pricing applies, and
				// billingIncomplete marks the row as potentially under-billed
				// rather than silently dropping the advisor-spend question.
				billingIncomplete: true,
			});
		});

		it("keeps splitting fallback pricing when the terminal iteration snapshot is current", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-current-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();
			let capturedSequence:
				| { usagePayloadSeq?: number; iterationsSeq?: number }
				| undefined;

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 10,
									output_tokens: 0,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 10,
											output_tokens: 0,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 10,
											output_tokens: 0,
										},
									],
								},
							},
						})}\n\nevent: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							usage: {
								input_tokens: 10,
								output_tokens: 500,
								iterations: [
									{
										type: "message",
										model: FABLE_MODEL,
										input_tokens: 10,
										output_tokens: 100,
									},
									{
										type: "fallback_message",
										model: OPUS_MODEL,
										input_tokens: 10,
										output_tokens: 400,
									},
								],
							},
						})}\n\n`,
					),
				);
				const state = testable(collector).requests.get(requestId);
				capturedSequence = {
					usagePayloadSeq: state?.usagePayloadSeq,
					iterationsSeq: state?.usage.iterationsSeq,
				};

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 10,
				completionTokens: 500,
				totalTokens: 510,
				costUsd: 9_030,
				inputTokens: 10,
				outputTokens: 500,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 10,
				outputTokens: 100,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, OPUS_MODEL, {
				inputTokens: 10,
				outputTokens: 400,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
			expect(capturedSequence).toEqual({
				usagePayloadSeq: 2,
				iterationsSeq: 2,
			});
		});

		it("keeps fallback attribution when a non-stream response has an empty top-level model", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "json-empty-model-fallback-block";
			const fallbackLogs = captureFallbackUsageLogs();
			const responseBody = Buffer.from(
				JSON.stringify({
					model: "",
					content: [
						{
							type: "fallback",
							from: { model: FABLE_MODEL },
							to: { model: OPUS_MODEL },
						},
					],
					usage: { input_tokens: 5, output_tokens: 7 },
				}),
			).toString("base64");

			try {
				collector.handleStart(
					makeStartMessage(requestId, {
						isStream: false,
						responseHeaders: { "content-type": "application/json" },
					}),
				);
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody,
				});
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 5,
				completionTokens: 7,
				totalTokens: 12,
				costUsd: 150,
				inputTokens: 5,
				outputTokens: 7,
			});
			expect(savedUsages.get(requestId)?.costUsd).toBeGreaterThan(0);
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 5,
				outputTokens: 7,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("attributes a fallback stream to the final model and sums its final iteration snapshot", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages, summaryDetails } = harness();
			const requestId = "stream-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${HAIKU_MODEL}"}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"fallback","from":{"model":"${HAIKU_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"fallback","from":{"model":""},"to":{"model":"${OPUS_MODEL}"}}}\n\nevent: response.completed\ndata: {"usage":{"iterations":[{"type":"message","model":"${OPUS_MODEL}","input_tokens":1,"output_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}]}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7},{"type":"message","model":"${OPUS_MODEL}","input_tokens":11,"output_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}]}}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 91,
				completionTokens: 29,
				totalTokens: 120,
				costUsd: 49_214,
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(
				summaryDetails.find((summary) => summary.id === requestId),
			).toMatchObject({ model: OPUS_MODEL, costUsd: 49_214 });
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]).toMatchObject({
				level: "INFO",
				data: {
					requestId,
					from: HAIKU_MODEL,
					to: OPUS_MODEL,
					iterationCount: 2,
					priced: "iterations",
				},
			});
		});

		it("attributes the documented non-stream usage body to its iteration models", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages, summaryDetails } = harness();
			const requestId = "json-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();
			const responseBody = Buffer.from(
				JSON.stringify({
					id: "msg_fallback",
					type: "message",
					role: "assistant",
					model: OPUS_MODEL,
					content: [
						{
							type: "fallback",
							from: { model: HAIKU_MODEL },
							to: { model: FABLE_MODEL },
						},
						{ type: "text", text: "done" },
					],
					stop_reason: "end_turn",
					usage: {
						input_tokens: 23,
						output_tokens: 29,
						cache_read_input_tokens: 31,
						cache_creation_input_tokens: 37,
						iterations: [
							{
								type: "message",
								model: FABLE_MODEL,
								input_tokens: 2,
								output_tokens: 3,
								cache_read_input_tokens: 5,
								cache_creation_input_tokens: 7,
							},
							{
								type: "message",
								model: OPUS_MODEL,
								input_tokens: 11,
								output_tokens: 13,
								cache_read_input_tokens: 17,
								cache_creation_input_tokens: 19,
							},
						],
					},
				}),
			).toString("base64");

			try {
				collector.handleStart(
					makeStartMessage(requestId, {
						isStream: false,
						responseHeaders: { "content-type": "application/json" },
					}),
				);
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody,
				});
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 91,
				completionTokens: 29,
				totalTokens: 120,
				costUsd: 49_214,
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(
				summaryDetails.find((summary) => summary.id === requestId),
			).toMatchObject({ model: OPUS_MODEL, costUsd: 49_214 });
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: HAIKU_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("keeps the non-stream top-level model authoritative over a fallback iteration", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "json-top-level-model-over-fallback-iteration";
			const fallbackLogs = captureFallbackUsageLogs();
			const responseBody = Buffer.from(
				JSON.stringify({
					model: OPUS_MODEL,
					usage: {
						input_tokens: 5,
						output_tokens: 7,
						iterations: [
							{
								type: "fallback_message",
								model: HAIKU_MODEL,
								input_tokens: 5,
								output_tokens: 7,
							},
						],
					},
				}),
			).toString("base64");

			try {
				collector.handleStart(
					makeStartMessage(requestId, {
						isStream: false,
						responseHeaders: { "content-type": "application/json" },
					}),
				);
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody,
				});
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 225,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(HAIKU_MODEL, {
				inputTokens: 5,
				outputTokens: 7,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: OPUS_MODEL,
				to: OPUS_MODEL,
				iterationCount: 1,
				priced: "iterations",
			});
		});

		it("lets a fallback iteration override message_start's requested model", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-message-start-fallback-iteration";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 23,
									output_tokens: 29,
									cache_read_input_tokens: 31,
									cache_creation_input_tokens: 37,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 2,
											output_tokens: 3,
											cache_read_input_tokens: 5,
											cache_creation_input_tokens: 7,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 11,
											output_tokens: 13,
											cache_read_input_tokens: 17,
											cache_creation_input_tokens: 19,
										},
									],
								},
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				promptTokens: 91,
				completionTokens: 29,
				totalTokens: 120,
				costUsd: 49_214,
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 7,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, OPUS_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: 17,
				cacheCreationInputTokens: 19,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("uses the late fallback iteration from a truncated message_start as the serving model", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-message-start-capped-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();
			const iterations = [
				...Array.from({ length: 64 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 1,
				},
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 65,
									output_tokens: 0,
									iterations,
								},
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Every one of the 65 raw entries lacks output_tokens (all
			// pre-output declines), so none is billable: the aggregate built
			// alongside this truncated snapshot is valid but empty, and prices
			// to $0 — not the old top-level fallback of $130, which would have
			// billed 65 FABLE-counted input tokens at OPUS rates for work that
			// was never actually produced.
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 0,
			});
			expect(estimateCostUSD).not.toHaveBeenCalled();
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 64,
				priced: "aggregate",
				iterationsTruncated: true,
			});
		});

		it("keeps a later fallback content-block target over message_start iteration metadata", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-message-start-iteration-before-fallback-block";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 11,
									output_tokens: 13,
									iterations: [
										{
											type: "fallback_message",
											model: HAIKU_MODEL,
											input_tokens: 11,
											output_tokens: 13,
										},
									],
								},
							},
						})}\n\nevent: content_block_start\ndata: ${JSON.stringify({
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "fallback",
								from: { model: FABLE_MODEL },
								to: { model: OPUS_MODEL },
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 423,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(HAIKU_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 1,
				priced: "iterations",
			});
		});

		it("keeps a non-stream top-level model authoritative when content is empty", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "json-empty-content-top-level-model-over-fallback";
			const fallbackLogs = captureFallbackUsageLogs();
			const responseBody = Buffer.from(
				JSON.stringify({
					model: OPUS_MODEL,
					content: [],
					usage: {
						input_tokens: 5,
						output_tokens: 7,
						iterations: [
							{
								type: "fallback_message",
								model: HAIKU_MODEL,
								input_tokens: 5,
								output_tokens: 7,
							},
						],
					},
				}),
			).toString("base64");

			try {
				collector.handleStart(
					makeStartMessage(requestId, {
						isStream: false,
						responseHeaders: { "content-type": "application/json" },
					}),
				);
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody,
				});
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 225,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(HAIKU_MODEL, {
				inputTokens: 5,
				outputTokens: 7,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: OPUS_MODEL,
				to: OPUS_MODEL,
				iterationCount: 1,
				priced: "iterations",
			});
		});

		it("preserves current single-model attribution for a normal stream", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-single-model";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":2,"output_tokens":0,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 7_532,
			});
			expect(fallbackLogs.events).toEqual([]);
		});

		it("replaces an earlier valid iteration snapshot before falling back to single-model pricing", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-malformed-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":2,"output_tokens":0,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}}\n\nevent: response.completed\ndata: {"usage":{"iterations":[{"type":"message","model":"${OPUS_MODEL}","input_tokens":100,"output_tokens":100}]}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7,"iterations":[{"type":"message","input_tokens":100},{"type":"message","model":""},{"type":"message","model":"   "},{"type":"message","model":42}]}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 7_532,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 7,
			});
			expect(fallbackLogs.events).toEqual([]);
		});

		it("shares one pricing deadline across all fallback iterations", async () => {
			process.env.CF_PRICING_TIMEOUT_MS = "20";
			pricingImplementation = () => new Promise<number>(() => {});
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-pricing-timeout";
			const pricingWarnings: LogEvent[] = [];
			const onLog = (event: LogEvent) => {
				if (
					event.msg === "Pricing estimate timed out; using zero-cost fallback"
				) {
					pricingWarnings.push(event);
				}
			};
			logBus.on("log", onLog);

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":2,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":13,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":2,"output_tokens":3},{"type":"fallback_message","model":"${OPUS_MODEL}","input_tokens":11,"output_tokens":13}]}}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();

				expect(savedUsages.get(requestId)).toMatchObject({
					model: OPUS_MODEL,
					costUsd: 0,
				});
				expect(estimateCostUSD).toHaveBeenCalledTimes(2);
				expect(pricingWarnings).toHaveLength(1);
				expect(pricingWarnings[0]?.data).toEqual({
					model: OPUS_MODEL,
					requestId,
					timeoutMs: 20,
				});
			} finally {
				logBus.off("log", onLog);
			}
		});

		it("captures iterations from a generic streaming usage event", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-generic-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":"invalid","output_tokens":null,"cache_read_input_tokens":{},"cache_creation_input_tokens":false},{"type":"message","model":"${OPUS_MODEL}","input_tokens":11,"output_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}]}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 40_413,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(fallbackLogs.events).toEqual([]);
		});

		it("prices model-less compaction usage at the serving model during fallback", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-compaction-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${OPUS_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"compaction","input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7},{"type":"fallback_message","model":"${OPUS_MODEL}","input_tokens":11,"output_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}]}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 56_746,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, OPUS_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 7,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, OPUS_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: 17,
				cacheCreationInputTokens: 19,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: OPUS_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("uses legacy top-level pricing for compaction-only iterations", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-compaction-only-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"compaction","input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}]}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 40_413,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(fallbackLogs.events).toEqual([]);
		});

		it("detects fallback beyond the retained iteration cap without partial pricing", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-capped-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();
			const iterationWarnings: LogEvent[] = [];
			const onLog = (event: LogEvent) => {
				if (event.msg === "Usage iterations exceeded limit; truncating") {
					iterationWarnings.push(event);
				}
			};
			logBus.on("log", onLog);
			const iterations = [
				...Array.from({ length: 64 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 1,
				},
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":65,"output_tokens":0}}}\n\nevent: response.completed\ndata: ${JSON.stringify({ usage: { input_tokens: 65, output_tokens: 0, iterations } })}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				logBus.off("log", onLog);
				fallbackLogs.stop();
			}

			// As in the message_start variant of this scenario: all 65 raw
			// entries lack output_tokens, so the aggregate is valid but empty
			// and prices to $0, not the stale top-level fallback of $130.
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 0,
			});
			expect(estimateCostUSD).not.toHaveBeenCalled();
			expect(iterationWarnings).toHaveLength(1);
			expect(iterationWarnings[0]).toMatchObject({
				level: "WARN",
				data: {
					requestId,
					observedLength: 65,
					maxIterations: 64,
				},
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 64,
				priced: "aggregate",
				iterationsTruncated: true,
			});
		});

		it("prices a truncated fallback snapshot from the aggregate, capturing dropped advisor spend", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-truncated-aggregate-advisor-billing";
			const fallbackLogs = captureFallbackUsageLogs();
			const iterations = [
				{
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 5,
					output_tokens: 7,
				},
				{
					type: "advisor_message",
					model: HAIKU_MODEL,
					input_tokens: 11,
					output_tokens: 13,
				},
				{
					type: "advisor_message",
					model: HAIKU_MODEL,
					input_tokens: 17,
					output_tokens: 19,
				},
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 23,
					output_tokens: 29,
				},
				...Array.from({ length: 61 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":5,"output_tokens":0}}}\n\nevent: response.completed\ndata: ${JSON.stringify(
							{ usage: { input_tokens: 5, output_tokens: 7, iterations } },
						)}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Top-level totals only reflect the executor's own tokens (5 in / 7
			// out); the two advisor_message entries at HAIKU_MODEL and the
			// fallback_message at OPUS_MODEL would be silently dropped if this
			// truncated snapshot fell back to top-level pricing.
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 1_745,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(3);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 5,
				outputTokens: 7,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, HAIKU_MODEL, {
				inputTokens: 28,
				outputTokens: 32,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(3, OPUS_MODEL, {
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 64,
				priced: "aggregate",
				iterationsTruncated: true,
			});
		});

		it("excludes zero-output entries from the aggregate while summing billable ones", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-truncated-aggregate-billable-predicate";
			const fallbackLogs = captureFallbackUsageLogs();
			const iterations = [
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 10,
					output_tokens: 20,
				},
				{
					type: "advisor_message",
					model: HAIKU_MODEL,
					input_tokens: 5,
					output_tokens: 0,
				},
				{
					type: "advisor_message",
					model: HAIKU_MODEL,
					input_tokens: 8,
					output_tokens: 6,
				},
				...Array.from({ length: 62 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":2,"output_tokens":0}}}\n\nevent: response.completed\ndata: ${JSON.stringify(
							{ usage: { input_tokens: 2, output_tokens: 0, iterations } },
						)}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// The declined advisor_message entry (output_tokens: 0) must never
			// reach the aggregate sum — only the billable HAIKU entry does.
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 624,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, OPUS_MODEL, {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, HAIKU_MODEL, {
				inputTokens: 8,
				outputTokens: 6,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 64,
				priced: "aggregate",
				iterationsTruncated: true,
			});
		});

		it("marks the aggregate unusable past the distinct-model cap and falls back to top-level pricing", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-truncated-aggregate-model-cap-exceeded";
			const fallbackLogs = captureFallbackUsageLogs();
			const billableModels = Array.from(
				{ length: 17 },
				(_, i) => `cap-test-model-${i}`,
			);
			const iterations = [
				...billableModels.map((model) => ({
					type: "message",
					model,
					input_tokens: 1,
					output_tokens: 1,
				})),
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 1,
					output_tokens: 0,
				},
				...Array.from({ length: 47 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":65,"output_tokens":0}}}\n\nevent: response.completed\ndata: ${JSON.stringify(
							{ usage: { input_tokens: 65, output_tokens: 0, iterations } },
						)}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 130,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 65,
				outputTokens: 0,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 64,
				priced: "top_level",
				iterationsTruncated: true,
				billingIncomplete: true,
			});
		});

		it("lets a later empty iteration snapshot clear an earlier overflowing fallback signal", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-replaced-overflowing-fallback-iterations";
			const fallbackLogs = captureFallbackUsageLogs();
			const iterations = [
				...Array.from({ length: 64 }, () => ({
					type: "message",
					model: FABLE_MODEL,
					input_tokens: 1,
				})),
				{
					type: "fallback_message",
					model: OPUS_MODEL,
					input_tokens: 1,
				},
			];

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 65,
									output_tokens: 0,
									iterations,
								},
							},
						})}\n\n`,
					),
				);
				const overflowingState = testable(collector).requests.get(requestId);
				expect(overflowingState?.usage.fallbackIterationModel).toBe(OPUS_MODEL);
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":3,"iterations":[]}}\n\n',
					),
				);

				const state = testable(collector).requests.get(requestId);
				expect(state?.usage.iterations).toEqual([]);
				expect(state?.usage.fallbackIterationSeen).toBe(false);
				expect(state?.usage.fallbackIterationModel).toBeUndefined();
				expect(state?.usage.iterationsTruncated).toBe(false);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 32,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toEqual([]);
		});

		it("keeps the fallback content-block target authoritative over iteration metadata", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-non-empty-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":23,"output_tokens":29,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":2,"output_tokens":3},{"type":"fallback_message","model":"${HAIKU_MODEL}","input_tokens":11,"output_tokens":13}]}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 455,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, HAIKU_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("uses serving-model top-level pricing when fallback iterations are missing", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-without-iterations";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37}}\n\n`,
					),
				);
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 80_826,
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 23,
				outputTokens: 29,
				cacheReadInputTokens: 31,
				cacheCreationInputTokens: 37,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("prices a fallback stream with no later usage payload at the counters-owner model, not zero or the new model's rate", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-no-later-usage-payload";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":500,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\n`,
					),
				);
				// Stream dies here: no later message_delta refreshes the
				// counters after the fallback rewrite. The retained 500
				// FABLE-counted input tokens are real and authoritative — they
				// must be priced at FABLE (the model that actually produced
				// them), not at OPUS's rate and not zeroed out (see Fix 1:
				// message_start.usage.output_tokens is a placeholder, but
				// input_tokens is not, and $0 would silently drop real spend).
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 500,
				inputTokens: 500,
				outputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 500,
				outputTokens: 0,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("prices fallback-seam input at FABLE (the counters owner) when message_start ships a nonzero output placeholder", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-seam-placeholder-output";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":500,"output_tokens":2}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\n`,
					),
				);
				// message_start's output_tokens:2 is Anthropic's documented
				// nonzero PLACEHOLDER before any real content — it must not be
				// read as "output happened" or gate anything. No message_delta
				// ever arrives to refresh the counters after the seam.
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 520,
				inputTokens: 500,
				outputTokens: 2,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 500,
				outputTokens: 2,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("flags billingIncomplete when real content streamed before a fallback seam left it unaccounted for", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-seam-real-content-unaccounted";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":500,"output_tokens":2}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\n`,
					),
				);
				// Real text streamed via content_block_delta BEFORE the seam —
				// but content_block_delta never updates state.usage.outputTokens
				// (see usage-collector.ts note near extractUsageFromData), and no
				// message_delta ever arrives afterward either. That real content
				// is genuinely invisible to the counters: the row must be
				// flagged billingIncomplete, not silently priced as if nothing
				// happened.
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 520,
				inputTokens: 500,
				outputTokens: 2,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(FABLE_MODEL, {
				inputTokens: 500,
				outputTokens: 2,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
				billingIncomplete: true,
			});
		});

		it("prices a fallback seam with no real content and no billable counters at a genuine zero", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fallback-seam-genuine-zero";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":0,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\n`,
					),
				);
				// No real content block, and the retained counters carry
				// nothing billable either — this is the one case that survives
				// as a direct, non-estimated $0 (no estimateCostUSD call).
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 0,
			});
			expect(estimateCostUSD).not.toHaveBeenCalled();
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "unpriced_pre_output",
			});
		});

		it("non-stream fallback content block still prices through top_level at the serving model (structurally unreachable seam, unchanged)", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "json-fallback-seam-unreachable-control";
			const fallbackLogs = captureFallbackUsageLogs();
			const responseBody = Buffer.from(
				JSON.stringify({
					content: [
						{
							type: "fallback",
							from: { model: FABLE_MODEL },
							to: { model: OPUS_MODEL },
						},
					],
					usage: { input_tokens: 500, output_tokens: 2 },
				}),
			).toString("base64");

			try {
				collector.handleStart(
					makeStartMessage(requestId, {
						isStream: false,
						responseHeaders: { "content-type": "application/json" },
					}),
				);
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody,
				});
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Mirrors the streaming seam test above (same input/output values)
			// but as the non-stream JSON body: extractUsageFromJson records
			// fallbackModelRewriteSeq BEFORE incrementing usagePayloadSeq in
			// the same call, so the seam condition can never match here (see
			// comment at its call site) — this must keep pricing at OPUS (the
			// serving model) through plain top_level, never at FABLE like the
			// streaming case above.
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 1_040,
				inputTokens: 500,
				outputTokens: 2,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 500,
				outputTokens: 2,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("flags ambiguous model-less attribution when a model-less entry co-occurs with two or more distinct models", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-compaction-ambiguous-multi-model";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},{"type":"compaction","input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7},{"type":"fallback_message","model":"${OPUS_MODEL}","input_tokens":11,"output_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}]}}\n\n`,
					),
				);
				// The compaction entry has no model field at all, and TWO
				// distinct modeled entries (FABLE, OPUS) are also present —
				// Anthropic's docs give no rule for which side a model-less
				// entry belongs to here, so this must be flagged rather than
				// silently priced as if the serving-model estimate were
				// certain.
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 56_806,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(3);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, OPUS_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 7,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(3, OPUS_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: 17,
				cacheCreationInputTokens: 19,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 3,
				priced: "iterations",
				billingIncomplete: true,
				unresolvedIterationModels: 1,
			});
		});

		it("does not flag model-less attribution as ambiguous when only one model is in play", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-compaction-single-model-no-ambiguity";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":23,"output_tokens":0}}}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":23,"output_tokens":29,"cache_read_input_tokens":31,"cache_creation_input_tokens":37,"iterations":[{"type":"message","model":"${FABLE_MODEL}","input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},{"type":"compaction","input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7},{"type":"fallback_message","model":"${FABLE_MODEL}","input_tokens":11,"output_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}]}}\n\n`,
					),
				);
				// Same shape as the ambiguity test above, but the
				// fallback_message entry is also FABLE — only one model is
				// actually in play, so attributing the model-less compaction
				// entry to it is unambiguous. No flag.
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			expect(savedUsages.get(requestId)).toMatchObject({
				model: FABLE_MODEL,
				costUsd: 28_433,
			});
			expect(estimateCostUSD).toHaveBeenCalledTimes(3);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, FABLE_MODEL, {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 7,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(3, FABLE_MODEL, {
				inputTokens: 11,
				outputTokens: 13,
				cacheReadInputTokens: 17,
				cacheCreationInputTokens: 19,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: FABLE_MODEL,
				iterationCount: 3,
				priced: "iterations",
			});
		});

		it("detects fallback from SSE event context without starting token timing", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-event-context-fallback";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				now += 1_000;
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: {"type":"message_start","message":{"model":"${FABLE_MODEL}","usage":{"input_tokens":2,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"${FABLE_MODEL}"},"to":{"model":"${OPUS_MODEL}"}}}\n\n`,
					),
				);
				now += 1_000;
				// A real (non-fallback) content block: this is the one that
				// should start the token-timing clock, not the fallback seam
				// above (a content_block_start/stop pair with no deltas).
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
					),
				);
				now += 2_000;
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":10}}\n\n',
					),
				);
				now += 2_000;
				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// firstTokenTimestamp must come from the real content block (2s
			// in), not the fallback seam (1s in): 10 output tokens over the
			// 2s from the real block to message_delta is 5 tok/s, not the
			// 2.5 tok/s a fallback-seam-started clock would report (10/4s).
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				tokensPerSecond: 5,
				costUsd: 204,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 0,
				priced: "top_level",
			});
		});

		it("excludes a pre-output declined iteration from the split price (documented shape)", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-pre-output-decline-excluded";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 947,
									output_tokens: 264,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 535,
											output_tokens: 0,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 412,
											output_tokens: 264,
										},
									],
								},
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Only the OPUS entry actually produced output; the FABLE entry
			// declined before producing any and must never reach pricing.
			expect(estimateCostUSD).toHaveBeenCalledTimes(1);
			expect(estimateCostUSD).toHaveBeenCalledWith(OPUS_MODEL, {
				inputTokens: 412,
				outputTokens: 264,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 6_104,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("still bills a mid-output decline for the tokens it actually produced", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-mid-output-decline-billed";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 220,
									output_tokens: 240,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 100,
											output_tokens: 40,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 120,
											output_tokens: 200,
										},
									],
								},
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Both iterations produced output, so both are billed and summed —
			// this is the case a stop_reason-based rule would wrongly drop.
			expect(estimateCostUSD).toHaveBeenCalledTimes(2);
			expect(estimateCostUSD).toHaveBeenNthCalledWith(1, FABLE_MODEL, {
				inputTokens: 100,
				outputTokens: 40,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(estimateCostUSD).toHaveBeenNthCalledWith(2, OPUS_MODEL, {
				inputTokens: 120,
				outputTokens: 200,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
			});
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 4_740,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
			});
		});

		it("prices a fully pre-output-refused chain at zero without pricing any iteration", async () => {
			useDeterministicModelPricing();
			const { collector, savedUsages } = harness();
			const requestId = "stream-fully-refused-chain-zero-cost";
			const fallbackLogs = captureFallbackUsageLogs();

			try {
				collector.handleStart(makeStartMessage(requestId));
				collector.handleChunk(
					requestId,
					new TextEncoder().encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: FABLE_MODEL,
								usage: {
									input_tokens: 80,
									output_tokens: 0,
									iterations: [
										{
											type: "message",
											model: FABLE_MODEL,
											input_tokens: 50,
											output_tokens: 0,
										},
										{
											type: "fallback_message",
											model: OPUS_MODEL,
											input_tokens: 30,
											output_tokens: 0,
										},
									],
								},
							},
						})}\n\n`,
					),
				);

				await collector.handleEnd({ type: "end", requestId, success: true });
				await collector.drain();
			} finally {
				fallbackLogs.stop();
			}

			// Every iteration declined before producing output — genuinely $0,
			// but it must be a deliberate branch, never the legacy empty-sum bug.
			expect(estimateCostUSD).toHaveBeenCalledTimes(0);
			expect(savedUsages.get(requestId)).toMatchObject({
				model: OPUS_MODEL,
				costUsd: 0,
			});
			expect(fallbackLogs.events).toHaveLength(1);
			expect(fallbackLogs.events[0]?.data).toEqual({
				requestId,
				from: FABLE_MODEL,
				to: OPUS_MODEL,
				iterationCount: 2,
				priced: "iterations",
				billableIterations: 0,
			});
		});
	});

	it.each([
		{
			label: "hit",
			cacheUsage: ',"cache_read_input_tokens":12',
			expected: "outcome=hit",
			expectedCached: "cached=12",
		},
		{
			label: "miss",
			cacheUsage: ',"cache_read_input_tokens":0',
			expected: "outcome=miss",
			expectedCached: "cached=0",
		},
		{
			label: "unknown",
			cacheUsage: "",
			expected: "outcome=unknown",
			expectedCached: null,
		},
	])("emits one privacy-safe Grok cache canary for a $label outcome", async ({
		cacheUsage,
		expected,
		expectedCached,
	}) => {
		const { collector } = harness();
		const canaryEvents: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg.startsWith("Grok cache canary ")) {
				canaryEvents.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleStart(
				makeStartMessage(`cache-${expected}`, {
					accountId: "xai-account",
					accountName: "Grok Primary",
					providerName: "xai",
					xaiCacheIdentityFingerprint: "identity12345678",
					xaiCachePrefixFingerprint: "prefix123456789",
					xaiCacheOfficialEndpoint: true,
					xaiCacheKeyPresent: true,
				}),
			);
			collector.handleChunk(
				`cache-${expected}`,
				new TextEncoder().encode(
					`event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5${cacheUsage}}}\n\n`,
				),
			);
			await collector.handleEnd({
				type: "end",
				requestId: `cache-${expected}`,
				success: true,
			});
			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		expect(canaryEvents).toHaveLength(1);
		const message = canaryEvents[0]?.msg ?? "";
		expect(message).toContain(expected);
		expect(message).toContain("official=1");
		expect(message).toContain("key=1");
		expect(message).toContain("account=xai-account");
		expect(message).toContain("account_name=Grok Primary");
		expect(message).toContain("id=identity12345678");
		expect(message).toContain("prefix=prefix123456789");
		if (expectedCached) {
			expect(message).toContain(expectedCached);
		} else {
			expect(message).not.toContain("cached=");
		}
		expect(message).not.toContain("session_id");
		expect(message).not.toContain("raw prompt");
	});

	it("persists and promotes cache creation reported only in the terminal message_delta", async () => {
		const { collector, savedUsages, summaryDetails } = harness();
		const requestId = "terminal-cache-creation";
		const accountId = "anthropic-cache-account";
		const bodyBytes = new TextEncoder().encode(
			'{"model":"claude-sonnet-4-5","cache_control":{"type":"ephemeral"}}',
		);
		const body = bodyBytes.buffer.slice(
			bodyBytes.byteOffset,
			bodyBytes.byteOffset + bodyBytes.byteLength,
		) as ArrayBuffer;

		cacheBodyStore.setEnabled(false);
		cacheBodyStore.setEnabled(true);
		try {
			cacheBodyStore.stageRequest(
				requestId,
				accountId,
				body,
				new Headers({ "content-type": "application/json" }),
				"/v1/messages",
			);
			collector.handleStart(
				makeStartMessage(requestId, {
					accountId,
					accountName: "Anthropic Cache Account",
				}),
			);
			collector.handleChunk(
				requestId,
				new TextEncoder().encode(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":7}}\n\n',
				),
			);
			await collector.handleEnd({ type: "end", requestId, success: true });
			await collector.drain();

			expect(savedUsages.get(requestId)).toMatchObject({
				promptTokens: 27,
				inputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 7,
				totalTokens: 32,
			});
			expect(
				summaryDetails.find((summary) => summary.id === requestId),
			).toMatchObject({
				promptTokens: 27,
				inputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 7,
				totalTokens: 32,
			});
			expect(cacheBodyStore.getLastCachedRequest(accountId)).not.toBeNull();
		} finally {
			cacheBodyStore.setEnabled(false);
		}
	});

	it("forwards terminal cache-read usage so a read-only hit refreshes the staged body", async () => {
		const { collector, summaryDetails } = harness();
		const requestId = "terminal-cache-read";
		const accountId = "anthropic-cache-read-account";
		const bodyBytes = new TextEncoder().encode(
			'{"model":"claude-sonnet-4-5","system":[{"type":"text","text":"latest","cache_control":{"type":"ephemeral"}}]}',
		);
		const body = bodyBytes.buffer.slice(
			bodyBytes.byteOffset,
			bodyBytes.byteOffset + bodyBytes.byteLength,
		) as ArrayBuffer;

		cacheBodyStore.setEnabled(false);
		cacheBodyStore.setEnabled(true);
		try {
			cacheBodyStore.stageRequest(
				requestId,
				accountId,
				body,
				new Headers({ "content-type": "application/json" }),
				"/v1/messages",
			);
			collector.handleStart(
				makeStartMessage(requestId, {
					accountId,
					accountName: "Anthropic Cache Read Account",
				}),
			);
			collector.handleChunk(
				requestId,
				new TextEncoder().encode(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":13,"cache_creation_input_tokens":0}}\n\n',
				),
			);
			await collector.handleEnd({ type: "end", requestId, success: true });
			await collector.drain();

			expect(
				summaryDetails.find((summary) => summary.id === requestId),
			).toMatchObject({
				cacheReadInputTokens: 13,
				cacheCreationInputTokens: 0,
			});
			const promoted = cacheBodyStore.getLastCachedRequest(accountId);
			expect(promoted).not.toBeNull();
			expect(Buffer.from(promoted?.body ?? []).toString()).toContain("latest");
		} finally {
			cacheBodyStore.setEnabled(false);
		}
	});

	it("keeps prompt tokens unknown for a model-only stream with no usage telemetry", async () => {
		const { collector, savedUsages, summaryDetails } = harness();
		const requestId = "model-only-no-usage";
		collector.handleStart(makeStartMessage(requestId));
		collector.handleChunk(
			requestId,
			new TextEncoder().encode(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929"}}\n\n',
			),
		);

		await collector.handleEnd({ type: "end", requestId, success: true });
		await collector.drain();

		expect(savedUsages.get(requestId)?.promptTokens).toBeUndefined();
		expect(
			summaryDetails.find((summary) => summary.id === requestId)?.promptTokens,
		).toBeUndefined();
	});

	it("preserves an authoritative explicit-zero inclusive prompt total", async () => {
		const { collector, savedUsages, summaryDetails } = harness();
		const requestId = "explicit-zero-usage";
		collector.handleStart(makeStartMessage(requestId));
		collector.handleChunk(
			requestId,
			new TextEncoder().encode(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
			),
		);

		await collector.handleEnd({ type: "end", requestId, success: true });
		await collector.drain();

		expect(savedUsages.get(requestId)).toMatchObject({
			promptTokens: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
		expect(
			summaryDetails.find((summary) => summary.id === requestId),
		).toMatchObject({
			promptTokens: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	it("appends one full privacy-safe terminal turn while preserving the native canary", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		const canaryEvents: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg.startsWith("Grok cache canary ")) canaryEvents.push(event);
		};
		logBus.on("log", onLog);
		try {
			collector.handleStart(
				makeStartMessage("recorder-full", {
					accountId: "xai-account",
					providerName: "xai",
					xaiCacheIdentityFingerprint: "identity12345678",
					xaiCachePrefixFingerprint: "prefix123456789",
					xaiCacheOfficialEndpoint: true,
					xaiCacheKeyPresent: true,
					cacheFlightRecorderConversationId:
						"cfr_0123456789abcdef0123456789abcdef",
					cacheFlightRecorderEligible: true,
					cacheFlightRecorderNativeActive: true,
				}),
			);
			collector.handleChunk(
				"recorder-full",
				new TextEncoder().encode(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":12}}\n\n',
				),
			);
			await collector.handleEnd({
				type: "end",
				requestId: "recorder-full",
				success: true,
			});
			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		expect(recorderWrites).toEqual([
			{
				recorderConversationId: "cfr_0123456789abcdef0123456789abcdef",
				turn: {
					sequence: 0,
					timestamp: new Date(now).toISOString(),
					identityFingerprint: "identity12345678",
					servingAccountId: "xai-account",
					prefixFingerprint: "prefix123456789",
					cacheOutcome: "hit",
					inputTokens: 32,
					cachedTokens: 12,
					completeness: "complete",
					unavailableDimensions: [],
				},
			},
		]);
		expect(canaryEvents).toHaveLength(1);
		expect(canaryEvents[0]?.msg).toContain(
			"recorder=cfr_0123456789abcdef0123456789abcdef",
		);
	});

	it.each([
		{ label: "streaming", streaming: true },
		{ label: "non-streaming", streaming: false },
	])("passes the exact frozen cohort receipt to the recorder append for a completed $label turn", async ({
		streaming,
	}) => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		const receipt = makeSealReceipt(
			`cohort_observation_partition_${streaming ? "stream" : "body"}`,
		);
		const requestId = `recorder-sealed-${streaming ? "stream" : "body"}`;

		collector.handleStart(
			makeStartMessage(requestId, {
				accountId: "xai-account",
				providerName: "xai",
				responseHeaders: {
					"content-type": streaming ? "text/event-stream" : "application/json",
				},
				isStream: streaming,
				xaiCacheIdentityFingerprint: "identity12345678",
				xaiCachePrefixFingerprint: "prefix123456789",
				xaiCacheOfficialEndpoint: true,
				xaiCacheKeyPresent: true,
				cacheFlightRecorderConversationId: "cfr_sealed000000000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: true,
				cacheFlightCohortSealReceipt: receipt,
			}),
		);

		if (streaming) {
			collector.handleChunk(
				requestId,
				new TextEncoder().encode(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":12}}\n\n',
				),
			);
			await collector.handleEnd({ type: "end", requestId, success: true });
		} else {
			await collector.handleEnd({
				type: "end",
				requestId,
				responseBody: Buffer.from(
					JSON.stringify({
						model: "grok-4",
						usage: {
							input_tokens: 20,
							output_tokens: 5,
							cache_read_input_tokens: 12,
						},
					}),
				).toString("base64"),
				success: true,
			});
		}
		await collector.drain();

		expect(recorderWrites).toHaveLength(1);
		expect(recorderWrites[0]?.sealReceipt).toBe(receipt);
		expect(recorderWrites[0]?.turn).toMatchObject({
			cacheOutcome: "hit",
			inputTokens: 32,
			cachedTokens: 12,
			completeness: "complete",
			unavailableDimensions: [],
		});
	});

	it.each([
		{
			label: "stream error",
			requestId: "recorder-sealed-stream-error",
			partitionId: "cohort_observation_partition_stream_error",
			end: {
				type: "end" as const,
				requestId: "recorder-sealed-stream-error",
				success: false,
				error: "upstream socket reset",
				streamTerminalState: "error" as const,
			},
		},
		{
			label: "truncated",
			requestId: "recorder-sealed-truncated",
			partitionId: "cohort_observation_partition_truncated",
			end: {
				type: "end" as const,
				requestId: "recorder-sealed-truncated",
				success: false,
				error: "Response stalled after partial output",
				streamTerminalState: "truncated" as const,
			},
		},
		{
			label: "client-cancelled",
			requestId: "recorder-sealed-client-cancelled",
			partitionId: "cohort_observation_partition_client_cancelled",
			end: {
				type: "end" as const,
				requestId: "recorder-sealed-client-cancelled",
				success: false,
				error: "downstream_cancelled",
				streamTerminalState: "client_cancelled" as const,
			},
		},
	])("keeps the frozen receipt on an incomplete $label terminal turn without making the turn complete", async ({
		requestId,
		partitionId,
		end,
	}) => {
		const { collector, recorderWrites, summaries } = createHarness();
		collectors.push(collector);
		const receipt = makeSealReceipt(partitionId);
		collector.handleStart(
			makeStartMessage(requestId, {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheIdentityFingerprint: "identity12345678",
				xaiCachePrefixFingerprint: "prefix123456789",
				xaiCacheOfficialEndpoint: true,
				xaiCacheKeyPresent: true,
				cacheFlightRecorderConversationId: "cfr_incomplete0000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: true,
				cacheFlightCohortSealReceipt: receipt,
			}),
		);

		await collector.handleEnd(end);
		await collector.drain();

		expect(summaries).toContain(requestId);
		expect(recorderWrites).toHaveLength(1);
		expect(recorderWrites[0]?.sealReceipt).toBe(receipt);
		expect(recorderWrites[0]?.turn.completeness).toBe("partial");
		expect(recorderWrites[0]?.turn.unavailableDimensions).toEqual([
			"cache_outcome",
			"token_accounting",
		]);
	});

	it("keeps the frozen receipt on contradictory cache telemetry without upgrading partial evidence", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		const receipt = makeSealReceipt(
			"cohort_observation_partition_contradictory",
		);
		const requestId = "recorder-sealed-contradictory";
		collector.handleStart(
			makeStartMessage(requestId, {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheIdentityFingerprint: "identity12345678",
				xaiCachePrefixFingerprint: "prefix123456789",
				xaiCacheOfficialEndpoint: true,
				xaiCacheKeyPresent: false,
				cacheFlightRecorderConversationId:
					"cfr_contradictory000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: false,
				cacheFlightCohortSealReceipt: receipt,
			}),
		);
		collector.handleChunk(
			requestId,
			new TextEncoder().encode(
				'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":12}}\n\n',
			),
		);
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
		});
		await collector.drain();

		expect(recorderWrites).toHaveLength(1);
		expect(recorderWrites[0]?.sealReceipt).toBe(receipt);
		expect(recorderWrites[0]?.turn).toMatchObject({
			cacheOutcome: "hit",
			inputTokens: 32,
			cachedTokens: 12,
			completeness: "partial",
			unavailableDimensions: ["identity", "cacheable_prefix"],
		});
	});

	it("does not pass a seal receipt when no frozen receipt was captured", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-unsealed-eligible", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheIdentityFingerprint: "identity12345678",
				xaiCachePrefixFingerprint: "prefix123456789",
				xaiCacheOfficialEndpoint: true,
				xaiCacheKeyPresent: true,
				cacheFlightRecorderConversationId: "cfr_unsealed000000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: true,
			}),
		);
		collector.handleChunk(
			"recorder-unsealed-eligible",
			new TextEncoder().encode(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":12}}\n\n',
			),
		);
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-unsealed-eligible",
			success: true,
		});
		await collector.drain();

		expect(recorderWrites).toHaveLength(1);
		expect(Object.hasOwn(recorderWrites[0] ?? {}, "sealReceipt")).toBe(false);
	});

	it("records partial recorder-only evidence without inventing native dimensions", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-partial", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId:
					"cfr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: false,
			}),
		);
		collector.handleChunk(
			"recorder-partial",
			new TextEncoder().encode(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":0}}\n\n',
			),
		);
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-partial",
			success: true,
		});
		await collector.drain();

		expect(recorderWrites[0]?.turn).toEqual({
			sequence: 0,
			timestamp: new Date(now).toISOString(),
			servingAccountId: "xai-account",
			cacheOutcome: "miss",
			inputTokens: 20,
			cachedTokens: 0,
			completeness: "partial",
			unavailableDimensions: ["identity", "cacheable_prefix"],
		});
	});

	it("keeps missing cache telemetry unknown and omits cached tokens", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-unknown", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId:
					"cfr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: false,
			}),
		);
		collector.handleChunk("recorder-unknown", modelBearingChunk());
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-unknown",
			success: true,
		});
		await collector.drain();

		expect(recorderWrites[0]?.turn.cacheOutcome).toBe("unknown");
		expect(recorderWrites[0]?.turn.cachedTokens).toBeUndefined();
		expect(recorderWrites[0]?.turn.unavailableDimensions).toContain(
			"cache_outcome",
		);
	});

	it("omits invented input tokens and marks the turn partial when no token telemetry was observed", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-no-telemetry", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId: "cfr_notelemetry000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: false,
			}),
		);
		// No handleChunk call at all: no token usage telemetry is ever observed
		// for this request, so no numeric total should be invented.
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-no-telemetry",
			success: true,
		});
		await collector.drain();

		const turn = recorderWrites[0]?.turn;
		expect(turn).toBeDefined();
		expect(turn && "inputTokens" in turn).toBe(false);
		expect(turn?.inputTokens).toBeUndefined();
		expect(turn?.cachedTokens).toBeUndefined();
		expect(turn?.unavailableDimensions).toContain("token_accounting");
		expect(turn?.completeness).toBe("partial");
	});

	it("keeps the normalized input token sum when telemetry was observed", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-telemetry-observed", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheIdentityFingerprint: "identity12345678",
				xaiCachePrefixFingerprint: "prefix123456789",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId: "cfr_observed0000000000000000000000",
				cacheFlightRecorderEligible: true,
				cacheFlightRecorderNativeActive: true,
			}),
		);
		collector.handleChunk(
			"recorder-telemetry-observed",
			new TextEncoder().encode(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"grok-4","usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":12}}\n\n',
			),
		);
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-telemetry-observed",
			success: true,
		});
		await collector.drain();

		const turn = recorderWrites[0]?.turn;
		expect(turn?.inputTokens).toBe(32);
		expect(turn?.cachedTokens).toBe(12);
		expect(turn?.unavailableDimensions).not.toContain("token_accounting");
		expect(turn?.completeness).toBe("complete");
	});

	it("does not collect non-official or non-xAI recorder metadata", async () => {
		const { collector, recorderWrites } = createHarness();
		collectors.push(collector);
		for (const [requestId, providerName, official] of [
			["custom-xai", "xai", false],
			["other-provider", "codex", true],
		] as const) {
			collector.handleStart(
				makeStartMessage(requestId, {
					providerName,
					xaiCacheOfficialEndpoint: official,
					cacheFlightRecorderConversationId:
						"cfr_cccccccccccccccccccccccccccccccc",
					cacheFlightRecorderEligible: false,
				}),
			);
			collector.handleChunk(requestId, modelBearingChunk());
			await collector.handleEnd({ type: "end", requestId, success: true });
		}
		await collector.drain();
		expect(recorderWrites).toEqual([]);
	});

	it("leaves the response lifecycle successful when recorder admission is rejected", async () => {
		const { collector, markedIncomplete, recorderWrites, summaries } =
			createHarness({
				acceptMetadata: false,
			});
		collectors.push(collector);
		collector.handleStart(
			makeStartMessage("recorder-rejected", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId:
					"cfr_dddddddddddddddddddddddddddddddd",
				cacheFlightRecorderEligible: true,
				cacheFlightCohortSealReceipt: makeSealReceipt(
					"cohort_observation_partition_rejected",
				),
			}),
		);
		collector.handleChunk("recorder-rejected", modelBearingChunk());
		await collector.handleEnd({
			type: "end",
			requestId: "recorder-rejected",
			success: true,
		});
		// The dropped marker is buffered off the request path, not written
		// synchronously: it must not appear before an explicit flush.
		expect(markedIncomplete).toEqual([]);
		await collector.drain();

		expect(recorderWrites).toEqual([]);
		expect(summaries).toContain("recorder-rejected");
		expect(markedIncomplete).toEqual([
			{
				id: "cfr_dddddddddddddddddddddddddddddddd",
				dropped: true,
				droppedCount: 1,
			},
		]);
	});

	it("warns without payload content and preserves success on repository failure", async () => {
		const { collector, markedIncomplete, recorderWrites, summaries } =
			createHarness({
				recorderFailure: new Error("repository unavailable"),
			});
		collectors.push(collector);
		const warnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg === "Cache flight recorder write failed")
				warnings.push(event);
		};
		logBus.on("log", onLog);
		try {
			collector.handleStart(
				makeStartMessage("recorder-failure", {
					accountId: "xai-account",
					providerName: "xai",
					xaiCacheOfficialEndpoint: true,
					cacheFlightRecorderConversationId:
						"cfr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
					cacheFlightRecorderEligible: true,
					cacheFlightCohortSealReceipt: makeSealReceipt(
						"cohort_observation_partition_failure",
					),
				}),
			);
			collector.handleChunk("recorder-failure", modelBearingChunk());
			await collector.handleEnd({
				type: "end",
				requestId: "recorder-failure",
				success: true,
			});
			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		expect(recorderWrites).toEqual([]);
		expect(summaries).toContain("recorder-failure");
		expect(warnings).toHaveLength(1);
		// The error message is the whole point of the observability fix: without
		// it, a seal-contract rejection is indistinguishable from a transient DB
		// error. Only the message may be logged, never payload/prompt content.
		expect(JSON.stringify(warnings[0])).toContain("repository unavailable");
		expect(JSON.stringify(warnings[0])).not.toContain("raw prompt");
		expect(markedIncomplete).toEqual([
			{ id: "cfr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", dropped: true },
		]);
	});

	it("treats explicit cache tokens from a generic usage event as present", async () => {
		const { collector } = harness();
		const canaryEvents: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg.startsWith("Grok cache canary ")) {
				canaryEvents.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleStart(
				makeStartMessage("cache-generic-usage", {
					accountId: "xai-account",
					providerName: "xai",
					xaiCacheIdentityFingerprint: "identity12345678",
					xaiCacheOfficialEndpoint: true,
					xaiCacheKeyPresent: true,
				}),
			);
			collector.handleChunk("cache-generic-usage", modelBearingChunk());
			collector.handleChunk(
				"cache-generic-usage",
				new TextEncoder().encode(
					'event: response.completed\ndata: {"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":0}}\n\n',
				),
			);
			await collector.handleEnd({
				type: "end",
				requestId: "cache-generic-usage",
				success: true,
			});
			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		expect(canaryEvents).toHaveLength(1);
		expect(canaryEvents[0]?.msg).toContain("outcome=miss");
		expect(canaryEvents[0]?.msg).toContain("cached=0");
	});

	it("does not count a custom or non-xAI serving route as an active Grok canary", async () => {
		const { collector } = harness();
		const canaryEvents: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg.startsWith("Grok cache canary ")) {
				canaryEvents.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleStart(
				makeStartMessage("cache-ineligible-route", {
					accountId: "custom-account",
					providerName: "xai",
					xaiCacheIdentityFingerprint: "identity12345678",
					xaiCacheOfficialEndpoint: false,
					xaiCacheKeyPresent: false,
				}),
			);
			collector.handleChunk("cache-ineligible-route", modelBearingChunk());
			await collector.handleEnd({
				type: "end",
				requestId: "cache-ineligible-route",
				success: true,
			});
			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		expect(canaryEvents).toHaveLength(0);
	});

	it("keeps an actively chunking stream beyond two minutes and persists it on end", async () => {
		const { collector, saveRequestIds, summaries } = harness();
		collector.handleStart(makeStartMessage("active-stream"));

		for (const elapsed of [30_000, 60_000, 90_000, 121_000]) {
			now = 1_700_000_000_000 + elapsed;
			collector.handleChunk(
				"active-stream",
				new TextEncoder().encode(": ping\n\n"),
			);
			testable(collector).cleanupStaleRequests();
		}

		expect(testable(collector).requests.has("active-stream")).toBe(true);
		await collector.handleEnd({
			type: "end",
			requestId: "active-stream",
			success: true,
		});
		await collector.drain();

		expect(saveRequestIds).toEqual(["active-stream"]);
		expect(summaries).toEqual(["active-stream"]);
		expect(testable(collector).requests.has("active-stream")).toBe(false);
	});

	it("detaches a finalizing stream before pricing yields so capacity eviction cannot free it", async () => {
		const { collector, payloads } = harness(true);
		const requestBody = Buffer.from("old request body").toString("base64");
		collector.handleStart(
			makeStartMessage("finalizing-stream", {
				requestBody,
				requestHeaders: { "x-lifecycle": "old" },
			}),
		);
		collector.handleChunk("finalizing-stream", modelBearingChunk());
		const finalizingState =
			testable(collector).requests.get("finalizing-stream");
		expect(finalizingState).toBeDefined();

		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "finalizing-stream",
			success: true,
		});
		const detachedBeforePricingResolved =
			!testable(collector).requests.has("finalizing-stream");

		now += 1;
		for (let i = 0; i <= 10_000; i++) {
			collector.handleStart(makeStartMessage(`race-capacity-${i}`));
		}
		const stateSurvivedCapacityEviction =
			(finalizingState?.chunks.length ?? 0) > 0 &&
			finalizingState?.startMessage.requestBody === requestBody &&
			finalizingState?.startMessage.requestHeaders["x-lifecycle"] === "old";

		await endPromise;
		await collector.drain();

		const savedPayload = JSON.parse(
			payloads.get("finalizing-stream") ?? "null",
		);
		expect(detachedBeforePricingResolved).toBe(true);
		expect(stateSurvivedCapacityEviction).toBe(true);
		expect(savedPayload.request.body).toBe(requestBody);
		expect(savedPayload.request.headers).toEqual({ "x-lifecycle": "old" });
		expect(
			Buffer.from(savedPayload.response.body, "base64").toString("utf8"),
		).toContain("message_start");
	});

	it("does not delete a new same-ID lifecycle when the old finalizer completes", async () => {
		const { collector, payloads } = harness(true);
		const oldRequestBody = Buffer.from("old lifecycle").toString("base64");
		const newRequestBody = Buffer.from("new lifecycle").toString("base64");
		collector.handleStart(
			makeStartMessage("reused-finalizing-id", {
				requestBody: oldRequestBody,
			}),
		);
		collector.handleChunk("reused-finalizing-id", modelBearingChunk());

		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "reused-finalizing-id",
			success: true,
		});
		const detachedBeforeReuse = !testable(collector).requests.has(
			"reused-finalizing-id",
		);

		now += 1;
		collector.handleStart(
			makeStartMessage("reused-finalizing-id", {
				requestBody: newRequestBody,
			}),
		);
		const newLifecycle = testable(collector).requests.get(
			"reused-finalizing-id",
		);
		await endPromise;
		await collector.drain();

		const savedPayload = JSON.parse(
			payloads.get("reused-finalizing-id") ?? "null",
		);
		expect(detachedBeforeReuse).toBe(true);
		expect(testable(collector).requests.get("reused-finalizing-id")).toBe(
			newLifecycle,
		);
		expect(newLifecycle?.startMessage.requestBody).toBe(newRequestBody);
		expect(savedPayload.request.body).toBe(oldRequestBody);
	});

	it("bounds a hung pricing estimate and releases detached request state", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "20";
		pricingImplementation = () => new Promise<number>(() => {});
		const { collector, saveRequestIds, summaryCosts } = harness(true);
		const largeRequestBody = Buffer.alloc(256 * 1024, "r").toString("base64");
		collector.handleStart(
			makeStartMessage("pricing-timeout", {
				requestBody: largeRequestBody,
				requestHeaders: { "x-large-state": "true" },
			}),
		);
		collector.handleChunk("pricing-timeout", modelBearingChunk());
		collector.handleChunk(
			"pricing-timeout",
			new Uint8Array(128 * 1024).fill(120),
		);
		const detachedState = testable(collector).requests.get("pricing-timeout");
		expect(detachedState?.chunksBytes).toBeGreaterThan(128 * 1024);
		expect(detachedState?.startMessage.requestBody).toBe(largeRequestBody);

		const pricingWarnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (
				event.msg === "Pricing estimate timed out; using zero-cost fallback"
			) {
				pricingWarnings.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			const endPromise = collector.handleEnd({
				type: "end",
				requestId: "pricing-timeout",
				success: true,
			});
			const completedWithinBound = await Promise.race([
				endPromise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			if (completedWithinBound) await collector.drain();

			expect(completedWithinBound).toBe(true);
			expect(saveRequestIds).toContain("pricing-timeout");
			expect(summaryCosts.get("pricing-timeout")).toBe(0);
			expect(detachedState?.chunks).toEqual([]);
			expect(detachedState?.chunksBytes).toBe(0);
			expect(detachedState?.buffer).toBe("");
			expect(detachedState?.startMessage.requestBody).toBeNull();
			expect(detachedState?.startMessage.requestHeaders).toEqual({});
			expect(pricingWarnings).toHaveLength(1);
			expect(pricingWarnings[0]?.data).toEqual({
				model: "claude-sonnet-4-5-20250929",
				requestId: "pricing-timeout",
				timeoutMs: 20,
			});
		} finally {
			logBus.off("log", onLog);
		}
	});

	it("clears the pricing deadline timer when estimation finishes quickly", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "20";
		pricingImplementation = async () => 0.25;
		const { collector, summaryCosts } = harness();
		const pricingWarnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (
				event.msg === "Pricing estimate timed out; using zero-cost fallback"
			) {
				pricingWarnings.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleStart(makeStartMessage("fast-pricing"));
			collector.handleChunk("fast-pricing", modelBearingChunk());
			await collector.handleEnd({
				type: "end",
				requestId: "fast-pricing",
				success: true,
			});
			await collector.drain();
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(summaryCosts.get("fast-pricing")).toBe(0.25);
			expect(pricingWarnings).toEqual([]);
		} finally {
			logBus.off("log", onLog);
		}
	});

	it("falls back to the default pricing deadline for an invalid override", () => {
		process.env.CF_PRICING_TIMEOUT_MS = "60001";
		const { collector } = harness();
		expect(testable(collector).pricingTimeoutMs).toBe(5_000);
	});

	it("evicts a stream that exceeds the inactivity timeout", async () => {
		const { collector, saveRequestIds } = harness();
		collector.handleStart(makeStartMessage("inactive-stream"));

		now += INACTIVITY_TIMEOUT_MS + 1;
		testable(collector).cleanupStaleRequests();

		expect(testable(collector).requests.has("inactive-stream")).toBe(false);
		await collector.handleEnd({
			type: "end",
			requestId: "inactive-stream",
			success: false,
			error: "downstream disconnected",
		});
		await collector.drain();
		expect(saveRequestIds).toEqual([]);
	});

	it("marks an evicted recorder-eligible stream as dropped incomplete evidence", async () => {
		const { collector, markedIncomplete, recorderWrites } = harness();
		collector.handleStart(
			makeStartMessage("recorder-evicted", {
				accountId: "xai-account",
				providerName: "xai",
				xaiCacheOfficialEndpoint: true,
				cacheFlightRecorderConversationId:
					"cfr_ffffffffffffffffffffffffffffffff",
				cacheFlightRecorderEligible: true,
			}),
		);

		now += INACTIVITY_TIMEOUT_MS + 1;
		testable(collector).cleanupStaleRequests();
		await collector.drain();

		expect(testable(collector).requests.has("recorder-evicted")).toBe(false);
		expect(recorderWrites).toEqual([]);
		expect(markedIncomplete).toEqual([
			{
				id: "cfr_ffffffffffffffffffffffffffffffff",
				dropped: true,
				droppedCount: 1,
			},
		]);
	});

	it("coalesces repeated drops for one conversation into a single summed marker", async () => {
		const { collector, markedIncomplete, recorderWrites } = createHarness({
			acceptMetadata: false,
		});
		collectors.push(collector);
		const conversationId = "cfr_coalesce00000000000000000000";

		for (let i = 0; i < 3; i++) {
			collector.handleStart(
				makeStartMessage(`recorder-coalesce-${i}`, {
					accountId: "xai-account",
					providerName: "xai",
					xaiCacheOfficialEndpoint: true,
					cacheFlightRecorderConversationId: conversationId,
					cacheFlightRecorderEligible: true,
				}),
			);
			collector.handleChunk(`recorder-coalesce-${i}`, modelBearingChunk());
			await collector.handleEnd({
				type: "end",
				requestId: `recorder-coalesce-${i}`,
				success: true,
			});
		}

		// Still buffered: three drops for the same conversation have not yet
		// produced any write, proving the hot path never calls the DB directly.
		expect(markedIncomplete).toEqual([]);

		await collector.drain();

		expect(recorderWrites).toEqual([]);
		expect(markedIncomplete).toEqual([
			{ id: conversationId, dropped: true, droppedCount: 3 },
		]);
	});

	it("caps the pending drop-marker buffer at 1024 distinct conversations and warns without throwing", async () => {
		const { collector, markedIncomplete } = createHarness({
			acceptMetadata: false,
		});
		collectors.push(collector);
		const warnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (event.msg.includes("Dropped recorder evidence marker buffer full")) {
				warnings.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			for (let i = 0; i < 1025; i++) {
				const conversationId = `cfr_overflow${String(i).padStart(21, "0")}`;
				const requestId = `recorder-overflow-${i}`;
				collector.handleStart(
					makeStartMessage(requestId, {
						accountId: "xai-account",
						providerName: "xai",
						xaiCacheOfficialEndpoint: true,
						cacheFlightRecorderConversationId: conversationId,
						cacheFlightRecorderEligible: true,
					}),
				);
				collector.handleChunk(requestId, modelBearingChunk());
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
				});
			}

			expect(warnings.length).toBeGreaterThan(0);

			await collector.drain();
		} finally {
			logBus.off("log", onLog);
		}

		// The buffer never grows past its cap; the 1025th distinct ID is lost
		// (logged, not thrown) rather than allowed to write unboundedly.
		expect(markedIncomplete.length).toBeLessThanOrEqual(1024);
	});

	it("retains the capacity safeguard and frees the oldest evicted state", () => {
		const { collector } = harness(true);
		const oldestBody = Buffer.from("oldest request").toString("base64");
		collector.handleStart(
			makeStartMessage("capacity-oldest", {
				requestBody: oldestBody,
				requestHeaders: { "x-oldest": "true" },
				responseHeaders: { "x-response": "oldest" },
			}),
		);
		collector.handleChunk(
			"capacity-oldest",
			new TextEncoder().encode("partial-event"),
		);
		const oldestState = testable(collector).requests.get("capacity-oldest");
		expect(oldestState).toBeDefined();
		expect(oldestState?.chunks.length).toBe(1);
		expect(oldestState?.buffer).toBe("partial-event");

		now += 1;
		for (let i = 0; i < 9_999; i++) {
			collector.handleStart(makeStartMessage(`capacity-filler-${i}`));
		}
		collector.handleStart(makeStartMessage("capacity-newest"));

		expect(testable(collector).requests.size).toBe(9_001);
		expect(testable(collector).requests.has("capacity-oldest")).toBe(false);
		expect(testable(collector).requests.has("capacity-newest")).toBe(true);
		expect(oldestState?.chunks).toEqual([]);
		expect(oldestState?.chunksBytes).toBe(0);
		expect(oldestState?.buffer).toBe("");
		expect(oldestState?.startMessage.requestBody).toBeNull();
		expect(oldestState?.startMessage.requestHeaders).toEqual({});
		expect(oldestState?.startMessage.responseHeaders).toEqual({});
	});

	it("warns only once for repeated chunks after state is missing", async () => {
		const { collector } = harness();
		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("missing-stream")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);

		try {
			for (let i = 0; i < 100; i++) {
				collector.handleChunk("missing-stream", new Uint8Array([i]));
			}
			await collector.handleEnd({
				type: "end",
				requestId: "missing-stream",
				success: false,
				error: "stream state was already evicted",
			});
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toHaveLength(1);
		expect(testable(collector).missingStateWarnings.size).toBe(1);
	});

	it("keeps exactly the newest 1000 missing-state warning tombstones in FIFO order", () => {
		const { collector } = harness();
		for (let i = 0; i < 1_100; i++) {
			collector.handleChunk(`unknown-${i}`, new Uint8Array([i % 256]));
		}

		const tombstones = testable(collector).missingStateWarnings;
		expect(tombstones.size).toBe(1_000);
		expect(tombstones.has("unknown-99")).toBe(false);
		expect(tombstones.has("unknown-100")).toBe(true);
		expect(tombstones.has("unknown-1099")).toBe(true);

		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("unknown-")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);
		try {
			collector.handleChunk("unknown-100", new Uint8Array([1]));
			collector.handleChunk("unknown-0", new Uint8Array([2]));
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toEqual(["No state found for request unknown-0"]);
	});

	it("resets missing-state warning eligibility when a request ID is reused", async () => {
		const { collector } = harness();
		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("reused-warning-id")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleChunk("reused-warning-id", new Uint8Array([1]));
			collector.handleChunk("reused-warning-id", new Uint8Array([2]));
			collector.handleStart(makeStartMessage("reused-warning-id"));
			expect(
				testable(collector).missingStateWarnings.has("reused-warning-id"),
			).toBe(false);
			await collector.handleEnd({
				type: "end",
				requestId: "reused-warning-id",
				success: true,
			});
			collector.handleChunk("reused-warning-id", new Uint8Array([3]));
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toEqual([
			"No state found for request reused-warning-id",
			"No state found for request reused-warning-id",
		]);
	});
});
