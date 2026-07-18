import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME,
	createAnthropicSemanticLivenessStream,
} from "../anthropic-semantic-liveness";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const content = (text: string) =>
	`event: content_block_delta\ndata: ${JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	})}\n\n`;
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const comment = ": keepalive\n\n";
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const apiError =
	'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

describe("createAnthropicSemanticLivenessStream", () => {
	it("ignores repeated ping/comment bytes after content, emits one stable error, and cancels upstream once", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const semanticTimeoutMs = 400;
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs,
			onTimeout,
		}).getReader();

		source.controller().enqueue(encoder.encode(content("first")));
		expect(decoder.decode((await reader.read()).value)).toBe(content("first"));

		for (const keepalive of [ping, comment, ping, comment]) {
			await delay(35);
			source.controller().enqueue(encoder.encode(keepalive));
			expect(decoder.decode((await reader.read()).value)).toBe(keepalive);
		}

		// The original content deadline should fire before this bound. If a ping
		// or comment incorrectly reset liveness, its later deadline would lose
		// this race instead.
		const timeoutEvent = await Promise.race([
			reader.read(),
			delay(330).then(() => "keepalive_reset_the_deadline" as const),
		]);
		expect(timeoutEvent).not.toBe("keepalive_reset_the_deadline");
		if (timeoutEvent === "keepalive_reset_the_deadline") {
			throw new Error("keepalive bytes reset the semantic deadline");
		}
		expect(decoder.decode(timeoutEvent.value)).toBe(
			ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME,
		);
		expect(await reader.read()).toMatchObject({ done: true });
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("resets the deadline on each meaningful text/thinking/tool delta", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 45,
			onTimeout,
		}).getReader();
		const frames = [
			content("one"),
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"two"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"three\\":"}}\n\n',
		];

		for (const frame of frames) {
			source.controller().enqueue(encoder.encode(frame));
			expect(decoder.decode((await reader.read()).value)).toBe(frame);
			await delay(30);
		}
		source.controller().enqueue(encoder.encode(messageStop));
		source.controller().close();
		expect(decoder.decode((await reader.read()).value)).toBe(messageStop);
		expect(await reader.read()).toMatchObject({ done: true });
		expect(onTimeout).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("pauses the semantic budget under downstream backpressure and resumes observation safely", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 25,
			onTimeout,
		}).getReader();

		source.controller().enqueue(encoder.encode(content("first")));
		expect(decoder.decode((await reader.read()).value)).toBe(content("first"));

		// Let the wrapper observe and queue a keepalive. Its downstream queue is
		// now full, so later upstream bytes cannot be observed until demand resumes.
		source.controller().enqueue(encoder.encode(ping));
		await delay(5);
		source.controller().enqueue(encoder.encode(content("after pause")));
		source.controller().enqueue(encoder.encode(messageStop));

		await delay(45);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();

		expect(decoder.decode((await reader.read()).value)).toBe(ping);
		expect(decoder.decode((await reader.read()).value)).toBe(
			content("after pause"),
		);
		expect(decoder.decode((await reader.read()).value)).toBe(messageStop);
		source.controller().close();
		expect(await reader.read()).toMatchObject({ done: true });
		expect(onTimeout).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("does not arm postcommit liveness for a pre-content keepalive stream", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 20,
			onTimeout,
		}).getReader();

		source.controller().enqueue(encoder.encode(ping));
		expect(decoder.decode((await reader.read()).value)).toBe(ping);
		await delay(45);
		expect(onTimeout).not.toHaveBeenCalled();

		source.controller().enqueue(encoder.encode(messageStop));
		source.controller().close();
		expect(decoder.decode((await reader.read()).value)).toBe(messageStop);
		expect(await reader.read()).toMatchObject({ done: true });
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("does not accept a malformed message_stop payload as terminal evidence", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 20,
			onTimeout,
		}).getReader();
		const malformedStop =
			'event: message_stop\ndata: {"not_type":"message_stop"}\n\n';

		source
			.controller()
			.enqueue(encoder.encode(`${content("partial")}${malformedStop}${ping}`));
		expect(decoder.decode((await reader.read()).value)).toBe(
			`${content("partial")}${malformedStop}${ping}`,
		);
		expect(decoder.decode((await reader.read()).value)).toBe(
			ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME,
		);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it("does not let repeated malformed complete frames postpone semantic timeout", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const semanticTimeoutMs = 400;
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs,
			onTimeout,
		}).getReader();
		const malformedFrame = "event: future_event\ndata: {not-json}\n\n";

		source.controller().enqueue(encoder.encode(content("partial")));
		expect(decoder.decode((await reader.read()).value)).toBe(
			content("partial"),
		);

		for (let index = 0; index < 4; index += 1) {
			await delay(35);
			source.controller().enqueue(encoder.encode(malformedFrame));
			expect(decoder.decode((await reader.read()).value)).toBe(malformedFrame);
		}

		const timeoutEvent = await Promise.race([
			reader.read(),
			delay(330).then(() => "malformed_frames_reset_the_deadline" as const),
		]);
		expect(timeoutEvent).not.toBe("malformed_frames_reset_the_deadline");
		if (timeoutEvent === "malformed_frames_reset_the_deadline") {
			throw new Error("malformed frames reset the semantic deadline");
		}
		expect(decoder.decode(timeoutEvent.value)).toBe(
			ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME,
		);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it("treats a structurally valid unknown extension as conservative progress", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const semanticTimeoutMs = 250;
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs,
			onTimeout,
		}).getReader();
		const extension =
			'event: future_progress\ndata: {"type":"future_progress","detail":{"phase":1}}\n\n';

		source.controller().enqueue(encoder.encode(content("partial")));
		expect(decoder.decode((await reader.read()).value)).toBe(
			content("partial"),
		);
		await delay(160);
		source.controller().enqueue(encoder.encode(extension));
		expect(decoder.decode((await reader.read()).value)).toBe(extension);

		// This crosses the original content deadline but remains within the
		// conservative deadline reset by the valid forward-compatible event.
		await delay(150);
		expect(onTimeout).not.toHaveBeenCalled();

		source.controller().enqueue(encoder.encode(messageStop));
		source.controller().close();
		expect(decoder.decode((await reader.read()).value)).toBe(messageStop);
		expect(await reader.read()).toMatchObject({ done: true });
		expect(onTimeout).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("forwards an SSE error chunk exactly, then closes and cancels upstream once", async () => {
		const source = controllableStream();
		const onTimeout = mock(() => undefined);
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 20,
			onTimeout,
		}).getReader();

		source.controller().enqueue(encoder.encode(content("partial")));
		expect(decoder.decode((await reader.read()).value)).toBe(
			content("partial"),
		);

		const terminalChunk = `${apiError}${ping}`;
		source.controller().enqueue(encoder.encode(terminalChunk));
		expect(decoder.decode((await reader.read()).value)).toBe(terminalChunk);
		const settled = await Promise.race([
			reader.read(),
			delay(75).then(() => "still_open" as const),
		]);
		expect(settled).not.toBe("still_open");
		expect(settled).toMatchObject({ done: true });
		expect(onTimeout).not.toHaveBeenCalled();
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("clears without timeout suppression on downstream cancel, EOF, or upstream error", async () => {
		for (const termination of ["cancel", "eof", "error"] as const) {
			const source = controllableStream();
			const onTimeout = mock(() => undefined);
			const reader = createAnthropicSemanticLivenessStream(source.stream, {
				semanticTimeoutMs: 25,
				onTimeout,
			}).getReader();
			source.controller().enqueue(encoder.encode(content(termination)));
			await reader.read();

			if (termination === "cancel") {
				await reader.cancel("downstream done");
			} else if (termination === "eof") {
				source.controller().close();
				expect(await reader.read()).toMatchObject({ done: true });
			} else {
				source.controller().error(new Error("upstream failed"));
				await expect(reader.read()).rejects.toThrow("upstream failed");
			}
			await delay(35);
			expect(onTimeout).not.toHaveBeenCalled();
		}
	});

	it("settles the timeout even when upstream cancellation never settles", async () => {
		const source = controllableStream(() => new Promise<void>(() => undefined));
		const reader = createAnthropicSemanticLivenessStream(source.stream, {
			semanticTimeoutMs: 15,
		}).getReader();
		source.controller().enqueue(encoder.encode(content("partial")));
		await reader.read();

		const settled = await Promise.race([
			reader.read(),
			delay(75).then(() => "cancel_blocked" as const),
		]);
		expect(settled).not.toBe("cancel_blocked");
		expect(
			decoder.decode((settled as ReadableStreamReadResult<Uint8Array>).value),
		).toBe(ANTHROPIC_SEMANTIC_LIVENESS_ERROR_FRAME);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});
});
