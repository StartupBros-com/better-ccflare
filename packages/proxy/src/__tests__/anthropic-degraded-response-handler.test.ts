import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../usage-collector");
spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
	handleStart: mock(() => undefined),
	handleChunk: mock(() => undefined),
	handleEnd: mock(async () => undefined),
} as unknown as usageCollectorModule.UsageCollector);

const { ANTHROPIC_TERMINAL_GRACE_ENV } = await import(
	"../anthropic-semantic-preflight"
);
const { AnthropicDegradedResponseLifecycle } = await import(
	"../anthropic-degraded-response-lifecycle"
);
const { DegradedModeObservability } = await import(
	"../anthropic-degraded-observability"
);
const {
	finishDegradedRequestFromPermitOutcome,
	trackDegradedResponseTerminal,
} = await import("../anthropic-degraded-runtime");
const { forwardToClient } = await import("../response-handler");

function createContext(streaming: boolean) {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: {
			name: "anthropic",
			isStreamingResponse: () => streaming,
		},
		refreshInFlight: new Map(),
		asyncWriter: {},
	} as never;
}

function createLifecycle() {
	const settlements: Array<{ outcome: string; retryAfter: unknown }> = [];
	return {
		settlements,
		transferToResponse: mock(() => true),
		settle: mock((outcome: string, retryAfter?: unknown) => {
			settlements.push({ outcome, retryAfter });
			return true;
		}),
	};
}

function createTrackedLifecycle() {
	const observability = new DegradedModeObservability({
		mode: "enforce",
		largeRequestTokenThreshold: 100_000,
		largeRequestByteThreshold: 256 * 1024,
	});
	const tracker = observability.beginRequest({
		correlationKey: crypto.randomUUID(),
		replayRisk: "large",
		sizeBucket: "large",
	});
	const lifecycle = new AnthropicDegradedResponseLifecycle({
		permit: {
			kind: "probe",
			leaseExpiresAt: null,
			commit: () => true,
			cancel: () => true,
			complete: () => true,
			expire: () => true,
		},
		accountId: "account",
		cohortKey: "cohort" as never,
		enforced: true,
		onSettled: (outcome) => {
			finishDegradedRequestFromPermitOutcome(tracker, outcome);
		},
	});
	return { lifecycle, observability, tracker };
}

function makeOptions(
	response: Response,
	lifecycle: ReturnType<typeof createLifecycle>,
) {
	return {
		requestId: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		account: null,
		requestHeaders: new Headers({
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		}),
		requestBody: new TextEncoder().encode("{}"),
		response,
		timestamp: Date.now(),
		retryAttempt: 0,
		failoverAttempts: 0,
		anthropicDegradedLifecycle: lifecycle,
	} as never;
}

afterEach(() => {
	delete process.env[ANTHROPIC_TERMINAL_GRACE_ENV];
});

describe("Anthropic degraded-mode response lifecycle evidence", () => {
	it("defers nonstream success until full body consumption", async () => {
		const lifecycle = createLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				lifecycle,
			),
			createContext(false),
		);

		expect(lifecycle.transferToResponse).toHaveBeenCalledTimes(1);
		expect(lifecycle.settlements).toEqual([]);
		await response.text();
		expect(lifecycle.settlements).toEqual([
			{ outcome: "success", retryAfter: undefined },
		]);
	});

	it("requires real message_stop plus clean EOF for streaming success", async () => {
		const lifecycle = createLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"content":[]}}',
						"",
						"event: message_delta",
						'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
						"",
						"event: message_stop",
						'data: {"type":"message_stop"}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
				lifecycle,
			),
			createContext(true),
		);

		await response.text();
		expect(lifecycle.settlements).toEqual([
			{ outcome: "success", retryAfter: undefined },
		]);
	});

	it("rejects a terminal-recovery synthesized stop", async () => {
		process.env[ANTHROPIC_TERMINAL_GRACE_ENV] = "0";
		const lifecycle = createLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"content":[]}}',
						"",
						"event: message_delta",
						'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
				lifecycle,
			),
			createContext(true),
		);

		await response.text();
		expect(lifecycle.settlements).toEqual([
			{ outcome: "truncated", retryAfter: undefined },
		]);
	});

	it("maps stop followed by downstream cancellation to cancelled", async () => {
		const lifecycle = createLifecycle();
		let emitted = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted) return new Promise(() => undefined);
				emitted = true;
				controller.enqueue(
					new TextEncoder().encode(
						[
							"event: message_delta",
							'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
							"",
							"event: message_stop",
							'data: {"type":"message_stop"}',
							"",
							"",
						].join("\n"),
					),
				);
			},
		});
		const response = await forwardToClient(
			makeOptions(
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				lifecycle,
			),
			createContext(true),
		);
		if (!response.body) throw new Error("expected response body");
		const reader = response.body.getReader();
		await reader.read();
		await reader.cancel("client disconnected");
		await Promise.resolve();
		await Promise.resolve();

		expect(lifecycle.settlements).toEqual([
			{ outcome: "cancelled", retryAfter: undefined },
		]);
	});

	it("does not recover when message_stop is followed by an upstream error", async () => {
		const lifecycle = createLifecycle();
		let pullCount = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pullCount++ === 0) {
					controller.enqueue(
						new TextEncoder().encode(
							[
								"event: message_delta",
								'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
								"",
								"event: message_stop",
								'data: {"type":"message_stop"}',
								"",
								"",
							].join("\n"),
						),
					);
					return;
				}
				controller.error(new Error("upstream disconnected"));
			},
		});
		const response = await forwardToClient(
			makeOptions(
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				lifecycle,
			),
			createContext(true),
		);

		await expect(response.text()).rejects.toThrow("upstream disconnected");
		expect(lifecycle.settlements).toEqual([
			{ outcome: "failed", retryAfter: undefined },
		]);
	});

	it("maps a fully consumed 529 separately as overloaded", async () => {
		const lifecycle = createLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response('{"type":"error"}', {
					status: 529,
					headers: {
						"content-type": "application/json",
						"retry-after": "17",
					},
				}),
				lifecycle,
			),
			createContext(false),
		);

		await response.text();
		expect(lifecycle.settlements).toEqual([
			{ outcome: "overloaded", retryAfter: "17" },
		]);
	});

	it("counts an authoritative semantic overload instead of the outer HTTP 200 fallback", async () => {
		const { lifecycle, observability, tracker } = createTrackedLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"content":[]}}',
						"",
						"event: error",
						'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
				lifecycle,
			),
			createContext(true),
		);

		await trackDegradedResponseTerminal(response, tracker).text();
		expect(observability.snapshot()).toMatchObject({
			terminalRequests: 1,
			terminalOverloads: 1,
			terminalSuccesses: 0,
		});
	});

	it("counts an authoritative truncated stream instead of the outer HTTP 200 fallback", async () => {
		const { lifecycle, observability, tracker } = createTrackedLifecycle();
		const response = await forwardToClient(
			makeOptions(
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"content":[]}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
				lifecycle,
			),
			createContext(true),
		);

		await trackDegradedResponseTerminal(response, tracker).text();
		expect(observability.snapshot()).toMatchObject({
			terminalRequests: 1,
			terminalFailures: 1,
			terminalSuccesses: 0,
		});
	});
});
