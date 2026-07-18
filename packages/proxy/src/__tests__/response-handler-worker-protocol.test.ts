import { describe, expect, it, mock, spyOn } from "bun:test";
import { requestEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME } from "../anthropic-semantic-liveness";
import {
	ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV,
	ANTHROPIC_TERMINAL_GRACE_ENV,
} from "../anthropic-semantic-preflight";
import * as modelCatalogModule from "../model-catalog";
import { forwardToClient } from "../response-handler";
import { clearSession, getServedAccount } from "../session-account-observer";
import * as usageCollectorModule from "../usage-collector";

describe("forwardToClient usage-collector protocol", () => {
	async function waitFor(
		predicate: () => boolean,
		timeoutMs = 1000,
	): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error("Timed out waiting for condition");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function createMockCollector() {
		const starts: Record<string, unknown>[] = [];
		const chunks: Array<{ requestId: string; data: Uint8Array }> = [];
		const ends: Record<string, unknown>[] = [];

		const collector = {
			handleStart: mock((msg: Record<string, unknown>) => {
				starts.push(msg);
			}),
			handleChunk: mock((requestId: string, data: Uint8Array) => {
				chunks.push({ requestId, data });
			}),
			handleEnd: mock((msg: Record<string, unknown>) => {
				ends.push(msg);
				return Promise.resolve();
			}),
		};

		// Spy on getUsageCollector to return our mock
		const spy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		return { collector, starts, chunks, ends, spy };
	}

	function createCtx(storePayloads = true) {
		return {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {
				getStorePayloads: () => storePayloads,
			},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
		} as unknown as import("../handlers").ProxyContext;
	}

	it("calls handleStart with messageId", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

		const response = await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(response.status).toBe(200);
		expect(starts.length).toBeGreaterThan(0);
		expect(starts[0].type).toBe("start");
		expect(typeof starts[0].messageId).toBe("string");
		expect((starts[0].messageId as string).length).toBeGreaterThan(0);
	});

	it("sends null requestBody when payload storage is disabled", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx(false);

		await forwardToClient(
			{
				requestId: "req-no-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ system: "test", messages: [] }),
				),
				project: "main-thread-project",
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(starts[0].type).toBe("start");
		expect(starts[0].requestBody).toBeNull();
		expect(starts[0].project).toBe("main-thread-project");
	});

	it("preserves requestBody when payload storage is enabled", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx(true);
		const requestBody = JSON.stringify({ system: "test", messages: [] });

		await forwardToClient(
			{
				requestId: "req-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(requestBody),
				project: null,
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(starts[0].type).toBe("start");
		expect(starts[0].requestBody).toBe(
			Buffer.from(requestBody).toString("base64"),
		);
		expect(starts[0].project).toBeNull();
	});

	it.each([
		{ label: "streaming", streaming: true, body: "data: ok\n\n" },
		{ label: "buffered", streaming: false, body: '{"ok":true}' },
		{ label: "bodyless", streaming: false, body: null },
	])("emits the recorder id for $label eligible responses", async ({
		streaming,
		body,
	}) => {
		const { starts } = createMockCollector();
		const ctx = createCtx(false);
		ctx.provider.name = "xai";
		ctx.provider.isStreamingResponse = () => streaming;
		const upstream = new Response(body, {
			status: 200,
			headers: {
				"content-type": streaming ? "text/event-stream" : "application/json",
			},
		});

		const response = await forwardToClient(
			{
				requestId: `req-recorder-${streaming ? "stream" : body ? "body" : "empty"}`,
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers(),
				requestBody: null,
				response: upstream,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				cacheFlightRecorderConversationId:
					"cfr_0123456789abcdef0123456789abcdef",
				cacheFlightRecorderEligible: true,
			},
			ctx,
		);

		expect(
			response.headers.get("x-better-ccflare-cache-flight-recorder-id"),
		).toBe("cfr_0123456789abcdef0123456789abcdef");
		expect(starts[0]).toMatchObject({
			cacheFlightRecorderConversationId: "cfr_0123456789abcdef0123456789abcdef",
			cacheFlightRecorderEligible: true,
		});
		if (body !== null) await response.text();
	});

	it("does not emit or plumb recorder metadata for ineligible routes", async () => {
		const { starts } = createMockCollector();
		const response = await forwardToClient(
			{
				requestId: "req-recorder-ineligible",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response("{}"),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				cacheFlightRecorderConversationId:
					"cfr_0123456789abcdef0123456789abcdef",
				cacheFlightRecorderEligible: false,
			},
			createCtx(false),
		);

		expect(
			response.headers.get("x-better-ccflare-cache-flight-recorder-id"),
		).toBeNull();
		expect(starts[0].cacheFlightRecorderConversationId).toBeUndefined();
	});

	it("does not throw when usage collector call succeeds", async () => {
		createMockCollector();
		const ctx = createCtx();

		await expect(
			forwardToClient(
				{
					requestId: "req-2",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			),
		).resolves.toBeInstanceOf(Response);
	});

	it("tees streaming responses instead of cloning", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const { starts, chunks, ends } = createMockCollector();
			const ctx = createCtx();
			ctx.provider.isStreamingResponse = () => true;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode("data: one\n\n"));
					controller.enqueue(encoder.encode("data: two\n\n"));
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: "req-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe("data: one\n\ndata: two\n\n");
			await waitFor(() => ends.length > 0);

			expect(chunks.length).toBe(2);
			expect(starts[0]).toMatchObject({
				type: "start",
				requestId: "req-stream-tee",
			});
			expect(ends[0]).toMatchObject({
				type: "end",
				requestId: "req-stream-tee",
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});

	it("records one failed end with partial usage when the downstream cancels", async () => {
		const { chunks, ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;
		const upstreamCancel = mock(() => undefined);
		let emitted = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!emitted) {
					emitted = true;
					controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
					return;
				}
				return new Promise(() => undefined);
			},
			cancel: upstreamCancel,
		});

		const response = await forwardToClient(
			{
				requestId: "req-stream-cancel",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(response.status).toBe(200);
		if (!response.body) throw new Error("Expected a streaming response body");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("data: partial\n\n");
		await reader.cancel("client disconnected");
		await waitFor(() => ends.length > 0);
		await Promise.resolve();

		expect(chunks).toHaveLength(1);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-stream-cancel",
			success: false,
			error: "downstream_cancelled",
		});
	});

	async function forwardNativeAnthropicStream(
		requestId: string,
		body: string,
	): Promise<{
		responseText: string;
		ends: Record<string, unknown>[];
	}> {
		const { ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;
		const response = await forwardToClient(
			{
				requestId,
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				}),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		const responseText = await response.text();
		await waitFor(() => ends.length > 0);
		return { responseText, ends };
	}

	async function withTerminalGrace<T>(
		graceMs: number,
		run: () => Promise<T>,
	): Promise<T> {
		const previous = process.env[ANTHROPIC_TERMINAL_GRACE_ENV];
		process.env[ANTHROPIC_TERMINAL_GRACE_ENV] = String(graceMs);
		try {
			return await run();
		} finally {
			if (previous === undefined) {
				delete process.env[ANTHROPIC_TERMINAL_GRACE_ENV];
			} else {
				process.env[ANTHROPIC_TERMINAL_GRACE_ENV] = previous;
			}
		}
	}

	async function withSemanticTimeout<T>(
		timeoutMs: number,
		run: () => Promise<T>,
	): Promise<T> {
		const previous = process.env[ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV];
		process.env[ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV] = String(timeoutMs);
		try {
			return await run();
		} finally {
			if (previous === undefined) {
				delete process.env[ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV];
			} else {
				process.env[ANTHROPIC_PRE_COMMIT_TIMEOUT_ENV] = previous;
			}
		}
	}

	async function forwardOpenNativeAnthropicStream(
		requestId: string,
		initialBody: string,
	): Promise<{
		response: Response;
		chunks: Array<{ requestId: string; data: Uint8Array }>;
		ends: Record<string, unknown>[];
		upstreamCancel: ReturnType<typeof mock>;
	}> {
		const { chunks, ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;
		const upstreamCancel = mock(() => undefined);
		let emitted = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!emitted) {
					emitted = true;
					controller.enqueue(new TextEncoder().encode(initialBody));
					return;
				}
				return new Promise(() => undefined);
			},
			cancel: upstreamCancel,
		});

		const response = await forwardToClient(
			{
				requestId,
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				}),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		return { response, chunks, ends, upstreamCancel };
	}

	async function forwardFailingNativeAnthropicStream(
		requestId: string,
		initialBody: string,
		transportError: Error,
	): Promise<{
		response: Response;
		ends: Record<string, unknown>[];
	}> {
		const { ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;
		let emitted = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!emitted) {
					emitted = true;
					controller.enqueue(new TextEncoder().encode(initialBody));
					return;
				}
				controller.error(transportError);
			},
		});

		const response = await forwardToClient(
			{
				requestId,
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				}),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		return { response, ends };
	}

	it("records terminal protocol success when the client cancels after message_stop but before transport EOF", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const { response, chunks, ends, upstreamCancel } =
			await forwardOpenNativeAnthropicStream(
				"req-anthropic-stop-then-cancel",
				body,
			);

		if (!response.body) throw new Error("Expected a streaming response body");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(body);
		await reader.cancel("client closed after terminal event");
		await waitFor(() => ends.length > 0);
		await Promise.resolve();

		expect(chunks).toHaveLength(1);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-stop-then-cancel",
			success: true,
		});
		expect(ends[0].error).toBeUndefined();
	});

	it("records downstream cancellation when the client cancels before message_stop", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n';
		const { response, chunks, ends, upstreamCancel } =
			await forwardOpenNativeAnthropicStream(
				"req-anthropic-cancel-before-stop",
				body,
			);

		if (!response.body) throw new Error("Expected a streaming response body");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(body);
		await reader.cancel("client closed before terminal event");
		await waitFor(() => ends.length > 0);
		await Promise.resolve();

		expect(chunks).toHaveLength(1);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-cancel-before-stop",
			success: false,
			error: "downstream_cancelled",
		});
	});

	it("does not accept an unterminated message_stop tail when the client cancels", async () => {
		const unterminatedStop =
			'event: message_stop\ndata: {"type":"message_stop"}';
		const { response, chunks, ends, upstreamCancel } =
			await forwardOpenNativeAnthropicStream(
				"req-anthropic-unterminated-stop-cancel",
				unterminatedStop,
			);

		if (!response.body) throw new Error("Expected a streaming response body");
		const reader = response.body.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			unterminatedStop,
		);
		await reader.cancel("client closed after truncated terminal-looking tail");
		await waitFor(() => ends.length > 0);

		expect(chunks).toHaveLength(1);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-unterminated-stop-cancel",
			success: false,
			error: "downstream_cancelled",
		});
	});

	it("records one end when message_stop cancellation races a pending transport read", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const { response, chunks, ends, upstreamCancel } =
			await forwardOpenNativeAnthropicStream(
				"req-anthropic-stop-cancel-race",
				body,
			);

		if (!response.body) throw new Error("Expected a streaming response body");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(body);
		const pendingRead = reader.read();
		await reader.cancel("client closed during pending transport read");
		await expect(pendingRead).resolves.toMatchObject({ done: true });
		await waitFor(() => ends.length > 0);
		await Promise.resolve();

		expect(chunks).toHaveLength(1);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-stop-cancel-race",
			success: true,
		});
		expect(ends[0].error).toBeUndefined();
	});

	it("records one successful end when the transport errors after message_stop", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const transportError = new Error(
			"upstream socket reset after terminal event",
		);
		const { response, ends } = await forwardFailingNativeAnthropicStream(
			"req-anthropic-stop-then-error",
			body,
			transportError,
		);

		await expect(response.text()).rejects.toThrow(transportError.message);
		await waitFor(() => ends.length > 0);

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-stop-then-error",
			success: true,
		});
		expect(ends[0].error).toBeUndefined();
	});

	it("records one failed end when the transport errors before message_stop", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n';
		const transportError = new Error("upstream socket reset mid-stream");
		const { response, ends } = await forwardFailingNativeAnthropicStream(
			"req-anthropic-error-before-stop",
			body,
			transportError,
		);

		await expect(response.text()).rejects.toThrow(transportError.message);
		await waitFor(() => ends.length > 0);

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-error-before-stop",
			success: false,
			error: transportError.message,
		});
	});

	it("does not accept an unterminated message_stop tail before a transport error", async () => {
		const unterminatedStop =
			'event: message_stop\ndata: {"type":"message_stop"}';
		const transportError = new Error(
			"upstream socket reset after truncated terminal-looking tail",
		);
		const { response, ends } = await forwardFailingNativeAnthropicStream(
			"req-anthropic-unterminated-stop-error",
			unterminatedStop,
			transportError,
		);

		await expect(response.text()).rejects.toThrow(transportError.message);
		await waitFor(() => ends.length > 0);

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-unterminated-stop-error",
			success: false,
			error: transportError.message,
		});
	});

	it("records the safe SSE error when an error event precedes a transport error", async () => {
		const body =
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private upstream message"}}\n\n';
		const transportError = new Error("private transport failure");
		const { response, ends } = await forwardFailingNativeAnthropicStream(
			"req-anthropic-sse-error-then-transport-error",
			body,
			transportError,
		);

		// A valid SSE error is itself terminal: the current bytes are forwarded,
		// then semantic liveness closes and cancels upstream before a later raw
		// transport failure can keep the response open.
		expect(await response.text()).toBe(body);
		await waitFor(() => ends.length > 0);

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-sse-error-then-transport-error",
			success: false,
			error: "anthropic_midstream_error:overloaded_error",
		});
		expect(JSON.stringify(ends[0])).not.toContain("private upstream message");
		expect(JSON.stringify(ends[0])).not.toContain(transportError.message);
	});

	it("records a later SSE error as failure even after message_stop", async () => {
		const body =
			'event: message_stop\ndata: {"type":"message_stop"}\n\n' +
			'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"private late error"}}\n\n';
		const { responseText, ends } = await forwardNativeAnthropicStream(
			"req-anthropic-stop-then-sse-error",
			body,
		);

		expect(responseText).toBe(body);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-stop-then-sse-error",
			success: false,
			error: "anthropic_midstream_error:api_error",
		});
		expect(JSON.stringify(ends[0])).not.toContain("private late error");
	});

	it("records one successful end for a native Anthropic stream with message_stop", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const { responseText, ends } = await forwardNativeAnthropicStream(
			"req-anthropic-real-stop",
			body,
		);

		expect(responseText).toBe(body);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-real-stop",
			success: true,
		});
		expect(ends[0].error).toBeUndefined();
	});

	it("records one successful end when terminal recovery synthesizes message_stop", async () => {
		const terminalDelta =
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
		const { responseText, ends } = await withTerminalGrace(5, () =>
			forwardNativeAnthropicStream(
				"req-anthropic-recovered-stop",
				terminalDelta,
			),
		);

		expect(responseText).toBe(
			`${terminalDelta}event: message_stop\ndata: {"type":"message_stop"}\n\n`,
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-recovered-stop",
			success: true,
		});
		expect(ends[0].error).toBeUndefined();
	});

	it("records one failed end when native Anthropic SSE reaches EOF without message_stop", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n';
		const { responseText, ends } = await forwardNativeAnthropicStream(
			"req-anthropic-incomplete-eof",
			body,
		);

		expect(responseText).toBe(body);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-incomplete-eof",
			success: false,
			error: "anthropic_incomplete_eof",
		});
	});

	it("records one failed end with only the safe Anthropic SSE error type", async () => {
		const body =
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private upstream message"}}\n\n';
		const { responseText, ends } = await forwardNativeAnthropicStream(
			"req-anthropic-midstream-error",
			body,
		);

		expect(responseText).toBe(body);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-midstream-error",
			success: false,
			error: "anthropic_midstream_error:overloaded_error",
		});
		expect(JSON.stringify(ends[0])).not.toContain("private upstream message");
	});

	it("records a postcommit semantic timeout as one sanitized failed outcome", async () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n' +
			'event: ping\ndata: {"type":"ping"}\n\n';
		const { response, ends, upstreamCancel } = await withSemanticTimeout(
			15,
			() =>
				forwardOpenNativeAnthropicStream(
					"req-anthropic-postcommit-timeout",
					body,
				),
		);

		const responseText = await withSemanticTimeout(15, () => response.text());
		await waitFor(() => ends.length > 0);

		expect(responseText).toBe(
			`${body}${ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME}`,
		);
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "end",
			requestId: "req-anthropic-postcommit-timeout",
			success: false,
			error: "anthropic_midstream_error:api_error",
		});
		expect(JSON.stringify(ends[0])).not.toContain("partial");
		expect(JSON.stringify(ends[0])).not.toContain(
			"Response stalled after partial output",
		);
	});

	it("tees non-streaming responses instead of cloning analytics body", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const { ends } = createMockCollector();
			const ctx = createCtx();
			const responseBody = JSON.stringify({ ok: true });

			const response = await forwardToClient(
				{
					requestId: "req-non-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(responseBody, {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe(responseBody);
			await waitFor(() => ends.length > 0);

			expect(ends[0]).toMatchObject({
				type: "end",
				requestId: "req-non-stream-tee",
				responseBody: Buffer.from(responseBody).toString("base64"),
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});

	it("non-streaming request with project+agent sources set in options produces a StartMessage carrying both source labels", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

		await forwardToClient(
			{
				requestId: "req-sources-non-stream",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				project: "acme-project",
				projectAttributionSource: "header_project",
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: "code-reviewer",
				agentAttributionSource: "prompt_agent",
			},
			ctx,
		);

		expect(starts[0].projectAttributionSource).toBe("header_project");
		expect(starts[0].agentAttributionSource).toBe("prompt_agent");
	});

	it("streaming request with project+agent sources set in options produces a StartMessage carrying both source labels", async () => {
		const { starts, ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: one\n\n"));
				controller.close();
			},
		});

		const response = await forwardToClient(
			{
				requestId: "req-sources-stream",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				project: "acme-project",
				projectAttributionSource: "path_project",
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: "code-reviewer",
				agentAttributionSource: "header_agent",
			},
			ctx,
		);

		await response.text();
		await waitFor(() => ends.length > 0);

		expect(starts[0].projectAttributionSource).toBe("path_project");
		expect(starts[0].agentAttributionSource).toBe("header_agent");
	});

	it("defaults source labels to 'none' when options omit them", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

		await forwardToClient(
			{
				requestId: "req-sources-default",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(starts[0].projectAttributionSource).toBe("none");
		expect(starts[0].agentAttributionSource).toBe("none");
	});

	it("SSE start event includes agentAttributionSource", async () => {
		const { collector: _collector } = createMockCollector();
		const ctx = createCtx();

		const events: Array<Record<string, unknown>> = [];
		const listener = (evt: Record<string, unknown>) => {
			if (evt.type === "start") events.push(evt);
		};
		requestEvents.on("event", listener);

		try {
			await forwardToClient(
				{
					requestId: "req-sse-source",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					agentUsed: "code-reviewer",
					agentAttributionSource: "header_agent",
				},
				ctx,
			);

			expect(events.length).toBeGreaterThan(0);
			expect(events[0].agentAttributionSource).toBe("header_agent");
		} finally {
			requestEvents.off("event", listener);
		}
	});

	it("accepts a legacy StartMessage without source fields without throwing, leaving them undefined", () => {
		const { collector, starts } = createMockCollector();

		// Simulates a message built by an older worker/producer that predates
		// the projectAttributionSource/agentAttributionSource fields. Both are
		// optional on StartMessage precisely so this legacy shape still type-checks.
		const legacyStartMessage: import("../worker-messages").StartMessage = {
			type: "start",
			messageId: "legacy-msg-1",
			requestId: "req-legacy",
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: false,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};

		expect(() => collector.handleStart(legacyStartMessage)).not.toThrow();
		expect(starts[0].projectAttributionSource).toBeUndefined();
		expect(starts[0].agentAttributionSource).toBeUndefined();
	});
});

describe("forwardToClient passive model-catalog capture", () => {
	function createIngestSpy() {
		return spyOn(modelCatalogModule, "ingestModelsListing").mockResolvedValue(
			undefined,
		);
	}

	function makeAccount(overrides: Partial<Account> = {}): Account {
		return {
			id: "acc-1",
			name: "test-console-account",
			provider: "claude-console-api",
			api_key: "sk-test",
			refresh_token: "rt",
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
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			auto_pause_on_overage_enabled: false,
			peak_hours_pause_enabled: false,
			custom_endpoint: null,
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

	function createCtx() {
		return {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: { getStorePayloads: () => true },
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
		} as unknown as import("../handlers").ProxyContext;
	}

	it("captures a GET /v1/models 200 response with an account present", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();
			const bodyText = JSON.stringify({
				data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
				has_more: false,
			});

			const response = await forwardToClient(
				{
					requestId: "req-capture-1",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					query: "?after_id=model-a",
					response: new Response(bodyText, {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).toHaveBeenCalledTimes(1);
			expect(ingestSpy).toHaveBeenCalledWith(
				bodyText,
				account,
				"?after_id=model-a",
			);
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a non-GET response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-post",
					method: "POST",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a non-200 response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-500",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ error: "boom" }), {
						status: 500,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a streaming response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();
			ctx.provider.isStreamingResponse = () => true;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"data":[]}'));
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: "req-capture-stream",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture when no account is present", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-no-account",
					method: "GET",
					path: "/v1/models",
					account: null,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("delivers the client response unaffected by a malformed capture body (real ingestModelsListing, no mock)", async () => {
		const account = makeAccount();
		const ctx = createCtx();
		const malformedBody = "{not valid json";

		const response = await forwardToClient(
			{
				requestId: "req-capture-malformed",
				method: "GET",
				path: "/v1/models",
				account,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(malformedBody, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		await expect(response.text()).resolves.toBe(malformedBody);
	});
});

describe("forwardToClient session-account recording", () => {
	function createCtx() {
		return {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: { getStorePayloads: () => true },
			provider: { name: "anthropic", isStreamingResponse: () => false },
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
		} as unknown as import("../handlers").ProxyContext;
	}

	// forwardToClient reads only a few account fields on the record path.
	function acct(id: string): Account {
		return {
			id,
			name: id,
			provider: "anthropic",
			billing_type: null,
			auto_pause_on_overage_enabled: false,
		} as unknown as Account;
	}

	async function forward(
		account: Account | null,
		headers: Record<string, string>,
	) {
		// Mock the usage collector but do NOT restore it (matching this file's
		// createMockCollector): the broader proxy suite relies on getUsageCollector
		// staying mocked across files, and a mockRestore here would re-expose the
		// uninitialized collector to later tests, failing them.
		const collector = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};
		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
		await forwardToClient(
			{
				requestId: `req-${Math.round(performance.now())}`,
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders: new Headers(headers),
				requestBody: null,
				response: new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			createCtx(),
		);
	}

	it("records the serving account for a real request carrying the session header", async () => {
		const sid = "rhwp-real-session";
		clearSession(sid);
		await forward(acct("acc-real"), { "x-claude-code-session-id": sid });
		expect(getServedAccount(sid)).toBe("acc-real");
		clearSession(sid);
	});

	it("does NOT record a cache-keepalive replay that carries the session header", async () => {
		const sid = "rhwp-keepalive-session";
		clearSession(sid);

		// A prior real request pinned the session to acc-A.
		await forward(acct("acc-A"), { "x-claude-code-session-id": sid });
		expect(getServedAccount(sid)).toBe("acc-A");

		// A cache-keepalive replay for acc-B carries the SAME session id
		// (STRIP_HEADERS keeps it) — it must NOT overwrite the active session's
		// observed account.
		await forward(acct("acc-B"), {
			"x-claude-code-session-id": sid,
			"x-better-ccflare-keepalive": "true",
		});
		expect(getServedAccount(sid)).toBe("acc-A");
		clearSession(sid);
	});
});
