import { describe, expect, it, mock } from "bun:test";
import { BUFFER_SIZES } from "@better-ccflare/core";
import {
	ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
	AnthropicPreCommitAbortedError,
	AnthropicPreCommitStallError,
	AnthropicPreCommitTransientError,
	gateAnthropicSsePreCommit,
} from "../anthropic-semantic-preflight";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function immediateStream(
	chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function controllableStream(
	onCancel: (reason?: unknown) => void | Promise<void> = () => undefined,
) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = mock(onCancel);
	const stream = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
		},
		cancel,
	});

	return { stream, controller: () => controller, cancel };
}

async function stallFrom(
	result: Promise<ReadableStream<Uint8Array>>,
): Promise<AnthropicPreCommitStallError> {
	try {
		await result;
		throw new Error("Expected the pre-commit gate to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(AnthropicPreCommitStallError);
		return error as AnthropicPreCommitStallError;
	}
}

const messageStart =
	'event: message_start\ndata: {"type":"message_start","message":{"content":[]},"usage":{"output_tokens":1}}\n\n';
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const comment = ": keepalive\n\n";
const terminalDelta =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("gateAnthropicSsePreCommit", () => {
	it("derives default retention from the shared frame and tail policies", () => {
		expect(ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES).toBe(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES +
				BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
		);
	});

	it("times out ping/comment-only streams without exposing buffered bytes", async () => {
		const source = controllableStream();
		let released = false;
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 35,
			terminalGraceMs: 10,
			maxBufferedBytes: 1024,
		}).then((stream) => {
			released = true;
			return stream;
		});

		source.controller().enqueue(bytes(comment));
		source.controller().enqueue(bytes(ping));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(released).toBe(false);

		const error = await stallFrom(result);
		expect(error.reason).toBe("semantic_timeout");
		expect(error.bufferedBytes).toBe(bytes(`${comment}${ping}`).byteLength);
		expect(error.framesSeen).toBe(2);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("does not commit a message_start-only stream", async () => {
		const source = controllableStream();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 25,
			terminalGraceMs: 10,
			maxBufferedBytes: 1024,
		});

		source.controller().enqueue(bytes(messageStart));

		const error = await stallFrom(result);
		expect(error.reason).toBe("semantic_timeout");
		expect(error.terminalEvidenceSeen).toBe(false);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("keeps setup and non-terminal lifecycle events behind the gate", async () => {
		const source = controllableStream();
		const setupOnly =
			`${messageStart}` +
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null}}\n\n';
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 20,
			terminalGraceMs: 10,
			maxBufferedBytes: 2048,
		});

		source.controller().enqueue(bytes(setupOnly));

		const error = await stallFrom(result);
		expect(error.reason).toBe("semantic_timeout");
		expect(error.framesSeen).toBe(4);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("treats a message_start stop_reason as terminal evidence requiring message_stop", async () => {
		const source = controllableStream();
		const terminalMessageStart =
			'event: message_start\ndata: {"type":"message_start","message":{"content":[],"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 60,
			terminalGraceMs: 10,
			maxBufferedBytes: 1024,
		});

		source.controller().enqueue(bytes(terminalMessageStart));

		const error = await stallFrom(result);
		expect(error.reason).toBe("terminal_grace_timeout");
		expect(error.terminalEvidenceSeen).toBe(true);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("uses the shorter terminal grace after message_delta and never synthesizes message_stop", async () => {
		const source = controllableStream();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 500,
			terminalGraceMs: 50,
			maxBufferedBytes: 2048,
		});

		source.controller().enqueue(bytes(`${messageStart}${terminalDelta}`));
		source.controller().enqueue(bytes(ping));

		const settled = await Promise.race([
			result.catch((error: unknown) => error),
			new Promise<"terminal_grace_was_not_short">((resolve) =>
				setTimeout(() => resolve("terminal_grace_was_not_short"), 250),
			),
		]);
		expect(settled).not.toBe("terminal_grace_was_not_short");
		expect(settled).toBeInstanceOf(AnthropicPreCommitStallError);
		const error = settled as AnthropicPreCommitStallError;
		expect(error.reason).toBe("terminal_grace_timeout");
		expect(error.terminalEvidenceSeen).toBe(true);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("honors the full terminal grace when terminal evidence arrives near the semantic deadline", async () => {
		const source = controllableStream();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 300,
			terminalGraceMs: 300,
			maxBufferedBytes: 2048,
		});

		source.controller().enqueue(bytes(messageStart));
		await new Promise((resolve) => setTimeout(resolve, 220));
		source.controller().enqueue(bytes(terminalDelta));

		const afterOriginalDeadline = await Promise.race([
			result.then(
				() => "released_early" as const,
				(error: unknown) => error,
			),
			new Promise<"still_waiting_for_message_stop">((resolve) =>
				setTimeout(() => resolve("still_waiting_for_message_stop"), 160),
			),
		]);
		expect(afterOriginalDeadline).toBe("still_waiting_for_message_stop");

		source.controller().enqueue(bytes(messageStop));
		source.controller().close();
		const released = await result;
		await expect(new Response(released).text()).resolves.toBe(
			`${messageStart}${terminalDelta}${messageStop}`,
		);
		expect(source.cancel).not.toHaveBeenCalled();
	});

	for (const [name, delta] of [
		[
			"text",
			'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\r\n\r\n',
		],
		[
			"thinking",
			'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"work"}}\r\n\r\n',
		],
		[
			"tool input",
			'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}\r\n\r\n',
		],
	] as const) {
		it(`releases byte-identical buffered and remaining bytes on the first ${name} delta`, async () => {
			const prefix = messageStart.replaceAll("\n", "\r\n");
			const suffix = `${ping}${terminalDelta}${messageStop}`;
			const source = controllableStream();
			const result = gateAnthropicSsePreCommit(source.stream, {
				semanticTimeoutMs: 100,
				terminalGraceMs: 20,
				maxBufferedBytes: 4096,
			});

			const beforeCommit = bytes(`${prefix}${delta}`);
			for (const byte of beforeCommit) {
				source.controller().enqueue(new Uint8Array([byte]));
			}

			const released = await result;
			const output = new Response(released).text();
			source.controller().enqueue(bytes(suffix));
			source.controller().close();

			await expect(output).resolves.toBe(`${prefix}${delta}${suffix}`);
			expect(source.cancel).not.toHaveBeenCalled();
		});
	}

	it("releases a valid empty response at message_stop", async () => {
		const original = `${messageStart}${messageStop}`;
		const released = await gateAnthropicSsePreCommit(
			immediateStream([bytes(original)]),
			{
				semanticTimeoutMs: 100,
				terminalGraceMs: 20,
				maxBufferedBytes: 2048,
			},
		);

		await expect(new Response(released).text()).resolves.toBe(original);
	});

	it("releases a policy-valid content frame larger than the legacy 1 MiB cap", async () => {
		const largeDelta = `event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "commit" },
			ignored: "x".repeat(1024 * 1024 + 128),
		})}\n\n`;
		const original = `${messageStart}${largeDelta}`;

		expect(bytes(largeDelta).byteLength).toBeGreaterThan(1024 * 1024);
		expect(bytes(largeDelta).byteLength).toBeLessThanOrEqual(
			BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		);

		const released = await gateAnthropicSsePreCommit(
			immediateStream([bytes(original)]),
			{ semanticTimeoutMs: 100, terminalGraceMs: 20 },
		);

		await expect(new Response(released).text()).resolves.toBe(original);
	});

	it("fails safely when one complete frame exceeds the shared transport policy", async () => {
		const oversizedFrame = `event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			delta: { type: "text_delta", text: "commit" },
			ignored: "x".repeat(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES),
		})}\n\n`;
		const result = gateAnthropicSsePreCommit(
			immediateStream([bytes(oversizedFrame)]),
			{ semanticTimeoutMs: 100, terminalGraceMs: 20 },
		);

		const error = await stallFrom(result);
		expect(error.reason).toBe("buffer_limit");
		expect(error.limitBytes).toBe(BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES);
	});

	it("fails retryably and privately on allowlisted transient SSE errors before commitment", async () => {
		for (const errorType of [
			"overloaded_error",
			"rate_limit_error",
			"api_error",
		] as const) {
			const privateMessage = `private-${errorType}-details`;
			const frame = `event: error\ndata: ${JSON.stringify({
				type: "error",
				error: { type: errorType, message: privateMessage },
			})}\n\n`;
			const result = gateAnthropicSsePreCommit(
				immediateStream([bytes(`${messageStart}${frame}`)]),
				{
					semanticTimeoutMs: 100,
					terminalGraceMs: 20,
					maxBufferedBytes: 2048,
				},
			);

			let caught: unknown;
			try {
				await result;
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AnthropicPreCommitTransientError);
			expect((caught as AnthropicPreCommitTransientError).errorType).toBe(
				errorType,
			);
			expect((caught as Error).message).not.toContain(privateMessage);
		}
	});

	it("conservatively commits valid unknown extensions and nonretryable error events unchanged", async () => {
		for (const frame of [
			'id: extension-1\nevent: future_event\ndata: {"type":"future_event"}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"private"}}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"private"}}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"permission_error"}}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"future_error"}}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"api_error!"}}\n\n',
		]) {
			const original = `${messageStart}${frame}`;
			const released = await gateAnthropicSsePreCommit(
				immediateStream([bytes(original)]),
				{
					semanticTimeoutMs: 100,
					terminalGraceMs: 20,
					maxBufferedBytes: 2048,
				},
			);

			await expect(new Response(released).text()).resolves.toBe(original);
		}
	});

	for (const [name, frame] of [
		["opaque non-SSE bytes", '{"not":"an SSE response"}'],
		[
			"an unterminated content delta",
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"must not escape"}}',
		],
		[
			"an unterminated message_stop",
			'event: message_stop\ndata: {"type":"message_stop"}',
		],
		[
			"an unterminated transient error",
			'event: error\ndata: {"type":"error","error":{"type":"api_error"}}',
		],
	] as const) {
		it(`fails retryably as upstream_eof for ${name}`, async () => {
			const result = gateAnthropicSsePreCommit(
				immediateStream([bytes(frame.slice(0, 4)), bytes(frame.slice(4))]),
				{
					semanticTimeoutMs: 100,
					terminalGraceMs: 20,
					maxBufferedBytes: 2048,
				},
			);

			const error = await stallFrom(result);
			expect(error.reason).toBe("upstream_eof");
			expect(error.framesSeen).toBe(0);
			expect(error.terminalEvidenceSeen).toBe(false);
			expect(error).not.toBeInstanceOf(AnthropicPreCommitTransientError);
		});
	}

	it("preserves buffer_limit when final decoder flush crosses the tail policy", async () => {
		const almostFullTail = bytes(
			"x".repeat(BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES - 2),
		);
		// TextDecoder retains this truncated three-byte sequence during streaming.
		// flush() materializes one three-byte replacement character, taking the
		// parser tail from two bytes under the cap to one byte over it.
		const truncatedUtf8 = new Uint8Array([0xe2, 0x82]);
		const result = gateAnthropicSsePreCommit(
			immediateStream([almostFullTail, truncatedUtf8]),
			{
				semanticTimeoutMs: 100,
				terminalGraceMs: 20,
				maxBufferedBytes: ANTHROPIC_PRE_COMMIT_MAX_BUFFERED_BYTES,
			},
		);

		const error = await stallFrom(result);
		expect(error.reason).toBe("buffer_limit");
		expect(error.limitBytes).toBe(BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES);
	});

	it("keeps malformed complete frames behind the precommit gate", async () => {
		for (const malformedFrame of [
			"event: future_event\ndata: {not-json}\n\n",
			'event: future_event\ndata: {"type":"different_event"}\n\n',
			'event: message_stop\ndata: {"not_type":"message_stop"}\n\n',
			"event: ping\n\n",
			"opaque-field: value\n\n",
		]) {
			const result = gateAnthropicSsePreCommit(
				immediateStream([bytes(malformedFrame)]),
				{
					semanticTimeoutMs: 100,
					terminalGraceMs: 20,
					maxBufferedBytes: 2048,
				},
			);

			const error = await stallFrom(result);
			expect(error.reason).toBe("upstream_eof");
			expect(error.framesSeen).toBe(1);
			expect(error.terminalEvidenceSeen).toBe(false);
		}
	});

	it("fails retryably before commitment when total buffered bytes exceed the cap", async () => {
		const source = controllableStream();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 100,
			terminalGraceMs: 20,
			maxBufferedBytes: 16,
		});

		source.controller().enqueue(bytes(messageStart));

		const error = await stallFrom(result);
		expect(error.reason).toBe("buffer_limit");
		expect(error.bufferedBytes).toBe(bytes(messageStart).byteLength);
		expect(error.limitBytes).toBe(16);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels the upstream reader exactly once when cancellation rejects", async () => {
		const source = controllableStream(() =>
			Promise.reject(new Error("cancel transport failure")),
		);
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 15,
			terminalGraceMs: 10,
			maxBufferedBytes: 1024,
		});

		source.controller().enqueue(bytes(ping));
		const error = await stallFrom(result);

		expect(error.reason).toBe("semantic_timeout");
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("settles a semantic timeout even when transport cancellation never settles", async () => {
		const source = controllableStream(() => new Promise<void>(() => undefined));
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 15,
			terminalGraceMs: 10,
			maxBufferedBytes: 1024,
		});

		source.controller().enqueue(bytes(ping));
		const settled = await Promise.race([
			result.catch((error: unknown) => error),
			new Promise<"cancel_blocked">((resolve) =>
				setTimeout(() => resolve("cancel_blocked"), 75),
			),
		]);

		expect(settled).toBeInstanceOf(AnthropicPreCommitStallError);
		expect((settled as AnthropicPreCommitStallError).reason).toBe(
			"semantic_timeout",
		);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels once and rejects distinctly when the caller aborts before commitment", async () => {
		const source = controllableStream();
		const abortController = new AbortController();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 100,
			terminalGraceMs: 20,
			maxBufferedBytes: 1024,
			signal: abortController.signal,
		});

		source.controller().enqueue(bytes(messageStart));
		await new Promise((resolve) => setTimeout(resolve, 0));
		abortController.abort("private caller reason");

		let caught: unknown;
		try {
			await result;
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AnthropicPreCommitAbortedError);
		expect(caught).not.toBeInstanceOf(AnthropicPreCommitStallError);
		expect((caught as Error).message).not.toContain("private caller reason");
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("releases the raw upstream when the committed downstream is cancelled with a pending pull", async () => {
		const source = controllableStream();
		const delta =
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n';
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 100,
			terminalGraceMs: 20,
			maxBufferedBytes: 2048,
		});
		source.controller().enqueue(bytes(delta));
		const released = await result;
		const reader = released.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(delta);

		const pendingRead = reader.read();
		await reader.cancel("semantic timeout");
		await expect(pendingRead).resolves.toMatchObject({ done: true });
		const deadline = Date.now() + 100;
		while (source.cancel.mock.calls.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("settles caller abort even when transport cancellation never settles", async () => {
		const source = controllableStream(() => new Promise<void>(() => undefined));
		const abortController = new AbortController();
		const result = gateAnthropicSsePreCommit(source.stream, {
			semanticTimeoutMs: 100,
			terminalGraceMs: 20,
			maxBufferedBytes: 1024,
			signal: abortController.signal,
		});

		source.controller().enqueue(bytes(messageStart));
		await new Promise((resolve) => setTimeout(resolve, 0));
		abortController.abort();
		const settled = await Promise.race([
			result.catch((error: unknown) => error),
			new Promise<"cancel_blocked">((resolve) =>
				setTimeout(() => resolve("cancel_blocked"), 75),
			),
		]);

		expect(settled).toBeInstanceOf(AnthropicPreCommitAbortedError);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});
});
