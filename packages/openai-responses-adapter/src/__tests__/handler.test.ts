import { describe, expect, it, test } from "bun:test";
import * as zlib from "node:zlib";
import { handleResponsesRequest } from "../handler";
import {
	MAX_RESPONSES_INPUT_ITEMS,
	MAX_RESPONSES_TOOLS,
} from "../request-limits";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

describe("handleResponsesRequest", () => {
	test("Test 1: invalid request (no input field) → 400", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("should not be called", { status: 200 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5" }), // no input
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(400);

		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	test("Test 2: non-streaming path → calls handleProxy with /v1/messages, returns translated response", async () => {
		let capturedPath = "";

		const mockHandleProxy: HandleProxyFn = async (_req, url) => {
			capturedPath = url.pathname;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(capturedPath).toBe("/v1/messages");
		expect(resp.status).toBe(200);

		const body = await resp.json();
		expect(body.object).toBe("response");
		expect(Array.isArray(body.output)).toBe(true);
		expect(body.output[0].type).toBe("message");
	});

	test("surfaces a privacy-safe Codex CLI session identity as metadata.user_id", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			forwardedBody = (await req2.json()) as Record<string, unknown>;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const makeReq = (extra: Record<string, unknown>) =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-haiku-4-5",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Hi" }],
						},
					],
					stream: false,
					...extra,
				}),
				headers: { "Content-Type": "application/json" },
			});

		// prompt_cache_key is Codex CLI's stable conversation identity; without
		// surfacing it, /v1/responses traffic is anonymous to the session
		// governor and load-balancer session affinity.
		const req = makeReq({ prompt_cache_key: "conv-abc123" });
		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
		const forwardedUserId = (
			forwardedBody as unknown as { metadata?: { user_id?: string } }
		)?.metadata?.user_id;
		expect(forwardedUserId).not.toContain("conv-abc123");
		expect(JSON.parse(forwardedUserId ?? "{}").session_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);

		// Without any identity the body stays metadata-free (anonymous).
		const anonReq = makeReq({});
		await handleResponsesRequest(
			anonReq,
			new URL(anonReq.url),
			mockHandleProxy,
			{},
		);
		expect(
			(forwardedBody as unknown as { metadata?: unknown })?.metadata,
		).toBeUndefined();
	});

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", { status: 429 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(429);
	});

	test("preserves stable routing error codes and only finite pool recovery headers", async () => {
		const request = () =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-fable-4-5",
					input: "Hi",
				}),
				headers: { "Content-Type": "application/json" },
			});

		const poolResp = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "pool_exhausted",
							code: "pool_exhausted",
							message: "Temporarily unavailable",
							next_available_at: "2026-07-17T12:01:00.000Z",
						},
					}),
					{
						status: 503,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "pool",
						},
					},
				),
			{},
		);
		const poolBody = (await poolResp.json()) as {
			error: { type: string; code: string };
		};
		expect(poolBody.error.type).toBe("pool_exhausted");
		expect(poolBody.error.code).toBe("pool_exhausted");
		expect(poolResp.headers.get("retry-after")).toBe("60");
		expect(poolResp.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(poolResp.headers.get("x-better-ccflare-recovery-scope")).toBe(
			"pool",
		);

		const modelResp = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "service_unavailable",
							code: "model_pool_exhausted",
							message: "Fable exhausted",
						},
					}),
					{
						status: 503,
						headers: {
							"content-type": "application/json",
							// The proxy's reserved marker pair makes this finite
							// request-compatible model-pool recovery authoritative.
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "model",
						},
					},
				),
			{},
		);
		const modelBody = (await modelResp.json()) as {
			error: { type: string; code: string };
		};
		expect(modelBody.error.type).toBe("service_unavailable");
		expect(modelBody.error.code).toBe("model_pool_exhausted");
		expect(modelResp.headers.get("retry-after")).toBe("60");
		expect(modelResp.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(modelResp.headers.get("x-better-ccflare-recovery-scope")).toBe(
			"model",
		);

		for (const { code, headers: invalidHeaders } of [
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "0",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{ code: "model_pool_exhausted", headers: { "retry-after": "60" } },
			{
				code: "model_pool_exhausted",
				headers: {
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "60",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "pool",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "01",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "model_pool_exhausted",
				headers: {
					"retry-after": "9007199254741",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
			{
				code: "route_unavailable",
				headers: {
					"retry-after": "60",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				},
			},
		]) {
			const invalidModelResp = await handleResponsesRequest(
				request(),
				new URL("http://localhost/v1/responses"),
				async () =>
					new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "service_unavailable",
								code,
								message: "Fable exhausted",
							},
						}),
						{ status: 503, headers: invalidHeaders },
					),
				{},
			);
			expect(invalidModelResp.headers.get("retry-after")).toBeNull();
			expect(
				invalidModelResp.headers.get("x-better-ccflare-pool-status"),
			).toBeNull();
			expect(
				invalidModelResp.headers.get("x-better-ccflare-recovery-scope"),
			).toBeNull();
		}

		const non503 = await handleResponsesRequest(
			request(),
			new URL("http://localhost/v1/responses"),
			async () =>
				new Response(
					JSON.stringify({
						error: {
							type: "service_unavailable",
							code: "model_pool_exhausted",
							message: "not a retryable terminal",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
							"x-better-ccflare-pool-status": "exhausted",
							"x-better-ccflare-recovery-scope": "model",
						},
					},
				),
			{},
		);
		expect(non503.headers.get("retry-after")).toBeNull();
		expect(non503.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(non503.headers.get("x-better-ccflare-recovery-scope")).toBeNull();
	});

	test("Test 4: streaming path → returns a text/event-stream response", async () => {
		const sseBody =
			"event: message_start\ndata: " +
			JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}) +
			"\n\n" +
			"event: content_block_start\ndata: " +
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}) +
			"\n\n" +
			"event: content_block_delta\ndata: " +
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}) +
			"\n\n" +
			"event: content_block_stop\ndata: " +
			JSON.stringify({
				type: "content_block_stop",
				index: 0,
			}) +
			"\n\n" +
			"event: message_delta\ndata: " +
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			}) +
			"\n\n" +
			"event: message_stop\ndata: " +
			JSON.stringify({ type: "message_stop" }) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");

		// Read body and verify the translation actually ran
		const rawBody = await resp.text();
		expect(rawBody).toContain("response.created");
		expect(rawBody).toContain("response.completed");
	});
});

describe("Responses request body admission", () => {
	const limit = 4 * 1024;
	const encoder = new TextEncoder();

	function validBody(input = "Hi"): Record<string, unknown> {
		return { model: "claude-haiku-4-5", input, stream: false };
	}

	async function compressWithRuntimeStream(
		bytes: Uint8Array,
		format: "gzip" | "deflate",
	): Promise<Uint8Array> {
		const source = new Response(copiedArrayBuffer(bytes)).body;
		if (!source) throw new Error("Missing compression source stream");
		return new Uint8Array(
			await new Response(
				source.pipeThrough(new CompressionStream(format)),
			).arrayBuffer(),
		);
	}

	function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		return copy.buffer;
	}

	function responseRequest(
		body: BodyInit | Uint8Array,
		contentEncoding?: string,
		controller?: AbortController,
	): Request {
		const headers = new Headers({ "content-type": "application/json" });
		if (contentEncoding) headers.set("content-encoding", contentEncoding);
		return new Request("http://localhost/v1/responses", {
			method: "POST",
			headers,
			body: body instanceof Uint8Array ? copiedArrayBuffer(body) : body,
			signal: controller?.signal,
		});
	}

	function countingProxy(): [HandleProxyFn, () => number] {
		let calls = 0;
		return [
			async () => {
				calls += 1;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			() => calls,
		];
	}

	async function handleWithLimit(
		req: Request,
		proxy: HandleProxyFn,
		requestBodyLimit = limit,
		onBodySizeKnown?: (bytes: number) => void | Promise<void>,
	): Promise<Response> {
		return handleResponsesRequest(
			req,
			new URL(req.url),
			proxy,
			{},
			undefined,
			undefined,
			{ requestBodyLimit, onBodySizeKnown },
		);
	}

	async function expectRejectedWithoutProxy(
		req: Request,
		status: 400 | 413,
		requestBodyLimit = limit,
	): Promise<void> {
		const [proxy, calls] = countingProxy();
		const response = await handleWithLimit(req, proxy, requestBodyLimit);
		expect(response.status).toBe(status);
		expect(calls()).toBe(0);
		const payload = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(payload.type).toBe("error");
		expect(payload.error.type).toBe("invalid_request_error");
		expect(payload.error.message).not.toContain("x".repeat(20));
	}

	it("admits an identity body at the exact encoded limit and rejects one byte over", async () => {
		const serialized = JSON.stringify(validBody());
		const exact = encoder.encode(
			serialized + " ".repeat(limit - Buffer.byteLength(serialized, "utf8")),
		);
		const [proxy, calls] = countingProxy();
		const exactResponse = await handleWithLimit(responseRequest(exact), proxy);
		expect(exactResponse.status).toBe(200);
		expect(calls()).toBe(1);
		await expectRejectedWithoutProxy(
			responseRequest(encoder.encode(`${new TextDecoder().decode(exact)} `)),
			413,
			limit,
		);
	});

	it("translates identity, gzip, deflate, and zstd requests from bounded input", async () => {
		const encoded = encoder.encode(JSON.stringify(validBody()));
		const compressed: Array<[string | undefined, Uint8Array]> = [
			[undefined, encoded],
			["gzip", await compressWithRuntimeStream(encoded, "gzip")],
			["deflate", await compressWithRuntimeStream(encoded, "deflate")],
			["zstd", Bun.zstdCompressSync(encoded)],
		];

		for (const [contentEncoding, bytes] of compressed) {
			const [proxy, calls] = countingProxy();
			const response = await handleWithLimit(
				responseRequest(bytes, contentEncoding),
				proxy,
			);
			expect(response.status).toBe(200);
			expect(calls()).toBe(1);
		}
	});

	it("rejects a zstd frame whose declared window exceeds the decoded limit", async () => {
		const oversizedWindowFrame = copiedArrayBuffer(
			new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xa0]),
		);

		await expectRejectedWithoutProxy(
			responseRequest(oversizedWindowFrame, "zstd"),
			413,
		);
	});

	it("rejects a zstd checksum mismatch without invoking the proxy", async () => {
		const compressed = zlib.zstdCompressSync(
			encoder.encode(JSON.stringify(validBody())),
			{
				params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
			},
		);
		const corruptChecksum = new Uint8Array(compressed.byteLength);
		corruptChecksum.set(compressed);
		const finalByte = corruptChecksum.byteLength - 1;
		corruptChecksum[finalByte] ^= 0xff;

		await expectRejectedWithoutProxy(
			responseRequest(copiedArrayBuffer(corruptChecksum), "zstd"),
			400,
		);
	});

	it("rejects declared encoded overflow before decompression", async () => {
		const req = responseRequest(
			encoder.encode(JSON.stringify(validBody())),
			"gzip",
		);
		Object.defineProperty(req, "headers", {
			value: new Headers({
				"content-type": "application/json",
				"content-encoding": "gzip",
				"content-length": String(limit + 1),
			}),
		});
		await expectRejectedWithoutProxy(req, 413);
	});

	it("rejects gzip, deflate, and zstd decoded expansion without invoking the proxy", async () => {
		const expanded = encoder.encode(
			JSON.stringify(validBody("x".repeat(limit))),
		);
		const compressed: Array<[string, Uint8Array]> = [
			["gzip", await compressWithRuntimeStream(expanded, "gzip")],
			["deflate", await compressWithRuntimeStream(expanded, "deflate")],
			["zstd", Bun.zstdCompressSync(expanded)],
		];

		for (const [contentEncoding, bytes] of compressed) {
			await expectRejectedWithoutProxy(
				responseRequest(bytes, contentEncoding),
				413,
			);
		}
	});

	it("returns 400 for corrupt and truncated recognized encodings without parsing compressed bytes", async () => {
		const encoded = encoder.encode(JSON.stringify(validBody()));
		const cases: Array<[string, Uint8Array]> = [
			["gzip", Bun.gzipSync(encoded).subarray(0, -2)],
			["deflate", Bun.deflateSync(encoded).subarray(0, -2)],
			["zstd", Bun.zstdCompressSync(encoded).subarray(0, -1)],
			// These are valid JSON bodies, so forwarding them proves a recognized
			// decompression error cannot fall through to identity parsing.
			["gzip", encoded],
			["deflate", encoded],
			["zstd", encoded],
		];

		for (const [contentEncoding, bytes] of cases) {
			await expectRejectedWithoutProxy(
				responseRequest(bytes, contentEncoding),
				400,
			);
		}
	});

	it("keeps unsupported encoding compatibility by parsing the bounded identity bytes", async () => {
		const [proxy, calls] = countingProxy();
		const response = await handleWithLimit(
			responseRequest(encoder.encode(JSON.stringify(validBody())), "br"),
			proxy,
		);
		expect(response.status).toBe(200);
		expect(calls()).toBe(1);
	});

	it("reports the larger decoded or synthetic body before forwarding", async () => {
		const source = JSON.stringify(validBody("Hi"));
		let knownBytes: number | undefined;
		let callbackFinished = false;
		let forwardedBytes: number | undefined;
		const proxy: HandleProxyFn = async (request) => {
			expect(callbackFinished).toBe(true);
			forwardedBytes = Buffer.byteLength(await request.text(), "utf8");
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				headers: { "content-type": "application/json" },
			});
		};

		const response = await handleWithLimit(
			responseRequest(source),
			proxy,
			limit,
			async (bytes) => {
				knownBytes = bytes;
				callbackFinished = true;
			},
		);

		expect(response.status).toBe(200);
		expect(knownBytes).toBe(
			Math.max(Buffer.byteLength(source, "utf8"), forwardedBytes ?? 0),
		);
	});

	it("fails before proxy work when the size callback fails", async () => {
		let proxyCalled = false;
		await expect(
			handleWithLimit(
				responseRequest(JSON.stringify(validBody())),
				async () => {
					proxyCalled = true;
					return new Response(ANTHROPIC_MESSAGE_BODY);
				},
				limit,
				() => {
					throw new Error("lease update failed");
				},
			),
		).rejects.toThrow("lease update failed");
		expect(proxyCalled).toBe(false);
	});

	it("rejects a translated synthetic body that exceeds the same limit", async () => {
		const source = encoder.encode(JSON.stringify(validBody("x".repeat(64))));
		await expectRejectedWithoutProxy(
			responseRequest(source),
			413,
			source.byteLength + 1,
		);
	});

	it("stops admission on client abort before parsing or calling the proxy", async () => {
		const controller = new AbortController();
		const reason = new DOMException("client disconnected", "AbortError");
		let startReading: (() => void) | undefined;
		const reading = new Promise<void>((resolve) => {
			startReading = resolve;
		});
		let cancellations = 0;
		const delayedBody = new ReadableStream<Uint8Array>({
			pull() {
				startReading?.();
				return new Promise<void>(() => {});
			},
			cancel() {
				cancellations += 1;
			},
		});
		const [proxy, calls] = countingProxy();
		const response = handleWithLimit(
			responseRequest(delayedBody, undefined, controller),
			proxy,
		);
		await reading;
		controller.abort(reason);

		await expect(response).rejects.toBe(reason);
		expect(calls()).toBe(0);
		expect(cancellations).toBe(1);
	});

	it("preserves the client abort signal on the synthetic proxy request", async () => {
		const controller = new AbortController();
		let forwarded: Request | undefined;
		const proxy: HandleProxyFn = async (req) => {
			forwarded = req;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const req = responseRequest(
			encoder.encode(JSON.stringify(validBody())),
			undefined,
			controller,
		);

		const response = await handleWithLimit(req, proxy);
		expect(response.status).toBe(200);
		expect(forwarded).toBeDefined();
		expect(forwarded?.signal.aborted).toBe(false);
		controller.abort();
		expect(forwarded?.signal.aborted).toBe(true);
	});

	describe("Responses structural request admission", () => {
		function request(body: Record<string, unknown>): Request {
			return new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}

		function countingProxy(): [HandleProxyFn, () => number] {
			let calls = 0;
			return [
				async () => {
					calls += 1;
					return new Response(ANTHROPIC_MESSAGE_BODY, {
						headers: { "content-type": "application/json" },
					});
				},
				() => calls,
			];
		}

		test("rejects more than the input-item limit without truncating or proxying", async () => {
			const [proxy, calls] = countingProxy();
			const req = request({
				model: "claude-haiku-4-5",
				input: Array.from({ length: MAX_RESPONSES_INPUT_ITEMS + 1 }, () => ({
					type: "message",
					role: "user",
					content: "x",
				})),
			});

			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				proxy,
				{},
			);
			expect(response.status).toBe(413);
			expect(calls()).toBe(0);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Too many input items",
				},
			});
		});

		test("accepts exactly the input-item limit", async () => {
			const [proxy, calls] = countingProxy();
			const req = request({
				model: "claude-haiku-4-5",
				input: Array.from({ length: MAX_RESPONSES_INPUT_ITEMS }, () => ({
					type: "message",
					role: "user",
					content: "x",
				})),
			});

			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				proxy,
				{},
			);
			expect(response.status).toBe(200);
			expect(calls()).toBe(1);
		});

		test("rejects non-array tools with the invalid-request envelope before proxying", async () => {
			for (const tools of [null, {}, "not-an-array"]) {
				const [proxy, calls] = countingProxy();
				const req = request({ model: "claude-haiku-4-5", input: "Hi", tools });
				const response = await handleResponsesRequest(
					req,
					new URL(req.url),
					proxy,
					{},
				);
				expect(response.status).toBe(400);
				expect(calls()).toBe(0);
				expect(await response.json()).toEqual({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "tools must be an array",
					},
				});
			}
		});

		test("forwards a null-parameter function tool with required choice", async () => {
			let forwarded: Record<string, unknown> | undefined;
			const proxy: HandleProxyFn = async (request) => {
				forwarded = (await request.json()) as Record<string, unknown>;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					headers: { "content-type": "application/json" },
				});
			};
			const req = request({
				model: "claude-haiku-4-5",
				input: "Hi",
				tools: [{ type: "function", name: "lookup", parameters: null }],
				tool_choice: "required",
			});

			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				proxy,
				{},
			);

			expect(response.status).toBe(200);
			expect(forwarded?.tools).toEqual([{ name: "lookup", input_schema: {} }]);
			expect(forwarded?.tool_choice).toEqual({ type: "any" });
		});

		test("rejects malformed function tools before proxying", async () => {
			for (const tool of [
				{ type: "function", name: "" },
				{ type: "function", name: 1 },
				{ type: "function", name: "lookup", description: 1 },
				{ type: "function", name: "lookup", parameters: "schema" },
				{ type: "function", name: "lookup", parameters: [] },
			]) {
				const [proxy, calls] = countingProxy();
				const req = request({
					model: "claude-haiku-4-5",
					input: "Hi",
					tools: [tool],
				});
				const response = await handleResponsesRequest(
					req,
					new URL(req.url),
					proxy,
					{},
				);
				expect(response.status).toBe(400);
				expect(calls()).toBe(0);
				expect(await response.json()).toEqual({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "Invalid function tool definition",
					},
				});
			}
		});

		test("keeps unsupported non-function built-ins skippable", async () => {
			const [proxy, calls] = countingProxy();
			const req = request({
				model: "claude-haiku-4-5",
				input: "Hi",
				tools: [{ type: "web_search_preview" }],
			});
			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				proxy,
				{},
			);
			expect(response.status).toBe(200);
			expect(calls()).toBe(1);
		});

		test("rejects more than the tool limit without proxying", async () => {
			const [proxy, calls] = countingProxy();
			const req = request({
				model: "claude-haiku-4-5",
				input: "Hi",
				tools: Array.from({ length: MAX_RESPONSES_TOOLS + 1 }, () => ({
					type: "function",
					name: "tool",
				})),
			});

			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				proxy,
				{},
			);
			expect(response.status).toBe(413);
			expect(calls()).toBe(0);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Too many tools",
				},
			});
		});
	});
});
