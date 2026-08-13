import { describe, expect, it, mock } from "bun:test";
import { BUFFER_SIZES } from "@better-ccflare/core";
import {
	ANTHROPIC_MESSAGE_STOP_FRAME,
	createAnthropicTerminalRecoveryStream,
} from "../anthropic-terminal-recovery";

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

/**
 * Simulates what actually happens in production when the downstream
 * consumer stops reading: `reader.cancel()` (a Bun no-op, oven-sh/bun#35093)
 * is no longer called, so the pending `reader.read()` inside the drain loop
 * only settles once the upstream connection itself ends — in `stream-tee.ts`
 * this is bounded by the caller's fetch() abort signal rejecting the read
 * (see its `cancel()` comment). A `controllableStream()` has no real network
 * connection to abort, so tests that exercise the post-cancel drain must
 * close the source explicitly, standing in for that eventual abort/EOF.
 */
async function settleDrain(
	source: ReturnType<typeof controllableStream>,
): Promise<void> {
	try {
		source.controller().close();
	} catch {
		// Already closed/errored — fine, the drain loop will still resolve.
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
}

const terminalDelta =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\n';
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const error =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream failed"}}\n\n';

describe("createAnthropicTerminalRecoveryStream", () => {
	it("leaves a healthy stream byte-for-byte unchanged", async () => {
		const original = `${terminalDelta}${messageStop}`;
		const chunks = [
			bytes(original.slice(0, 7)),
			bytes(original.slice(7, 63)),
			bytes(original.slice(63)),
		];
		const onRecovery = mock(() => undefined);

		const body = createAnthropicTerminalRecoveryStream(
			immediateStream(chunks),
			{ gracePeriodMs: 10, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("parses arbitrary chunk splits and recovers a terminal delta missing message_stop", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		for (const byte of bytes(terminalDelta)) {
			source.controller().enqueue(new Uint8Array([byte]));
		}
		source.controller().enqueue(bytes(ping));

		await expect(result).resolves.toBe(
			`${terminalDelta}${ping}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
		// The fix must not call the upstream reader's cancel() — draining
		// alone releases the native buffer (Bun's cancel() is a no-op,
		// oven-sh/bun#35093, issue #382).
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("does not let ping events defer recovery", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 25,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		const interval = setInterval(() => {
			try {
				source.controller().enqueue(bytes(ping));
			} catch {
				clearInterval(interval);
			}
		}, 3);

		try {
			const output = await result;
			expect(output.startsWith(terminalDelta)).toBe(true);
			expect(output.endsWith(ANTHROPIC_MESSAGE_STOP_FRAME)).toBe(true);
			expect(onRecovery).toHaveBeenCalledTimes(1);
		} finally {
			clearInterval(interval);
		}
	});

	it("separates a partial post-terminal ping before timeout recovery", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const partialPing = ping.slice(0, -2);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(partialPing));

		await expect(result).resolves.toBe(
			`${terminalDelta}${partialPing}\n\n${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("does not duplicate a real message_stop buffered at the timeout boundary", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const partialMessageStop = messageStop.slice(0, -2);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(partialMessageStop));

		await expect(result).resolves.toBe(
			`${terminalDelta}${partialMessageStop}\n\n`,
		);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("preserves a message_stop that completes shortly before the timeout", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 50,
			onRecovery,
		});
		const result = new Response(body).text();
		const split = messageStop.length - 2;

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(messageStop.slice(0, split)));
		await new Promise((resolve) => setTimeout(resolve, 20));
		source.controller().enqueue(bytes(messageStop.slice(split)));
		source.controller().close();

		await expect(result).resolves.toBe(`${terminalDelta}${messageStop}`);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("disables recovery after an over-policy undelimited tail", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const oversizedTail = "x".repeat(
			BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES + 1,
		);
		const original = `${terminalDelta}${oversizedTail}`;
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 40,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		for (let offset = 0; offset < oversizedTail.length; offset += 16 * 1024) {
			source
				.controller()
				.enqueue(bytes(oversizedTail.slice(offset, offset + 16 * 1024)));
		}
		setTimeout(() => {
			try {
				source.controller().close();
			} catch {
				// A broken implementation may close/cancel early; keep this regression
				// isolated so its timer cannot fail a later test.
			}
		}, 80);

		await expect(result).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	}, 10_000);

	it("treats an SSE error after terminal delta as terminal at EOF", async () => {
		const original = `${terminalDelta}${error}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("recognizes a split SSE error and keeps recovery disabled past grace", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		for (const byte of bytes(error)) {
			source.controller().enqueue(new Uint8Array([byte]));
		}
		setTimeout(() => {
			try {
				source.controller().close();
			} catch {
				// See the over-policy test above.
			}
		}, 40);

		await expect(result).resolves.toBe(`${terminalDelta}${error}`);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("never synthesizes for message_delta without a stop reason", async () => {
		const original =
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null}}\n\n' +
			ping;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("passes valid JSON null and scalar data through unchanged", async () => {
		const original =
			"event: ping\ndata: null\n\n" +
			'event: message_delta\ndata: "scalar"\n\n' +
			"data: 42\n\n";
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("synthesizes exactly once on clean EOF after a terminal delta", async () => {
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(terminalDelta)]),
			{ gracePeriodMs: 50, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("recovers a terminal delta buffered at EOF without a blank-line delimiter", async () => {
		const terminalDeltaWithoutDelimiter = terminalDelta.slice(0, -2);
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(terminalDeltaWithoutDelimiter)]),
			{ gracePeriodMs: 50, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(
			`${terminalDeltaWithoutDelimiter}\n\n${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("propagates upstream errors without masking them as successful completion", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		source.controller().error(new Error("upstream failed"));
		await expect(reader.read()).rejects.toThrow("upstream failed");
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("drains upstream in the background and disarms recovery when downstream cancels", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 10,
			onRecovery,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		// The outer cancel resolves immediately while the native-buffer cleanup
		// drain continues in the background. Closing the test source settles that
		// drain without making client cancellation wait on upstream behavior.
		await reader.cancel("client disconnected");
		await settleDrain(source);

		// The fix must not call the upstream reader's cancel() — draining
		// alone releases the native buffer.
		expect(source.cancel).not.toHaveBeenCalled();
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("does not propagate a background drain failure to downstream cancel", async () => {
		const source = controllableStream();
		const onCancelError = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onCancelError,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await expect(reader.cancel("client disconnected")).resolves.toBeUndefined();
		source.controller().error(new Error("drain failed"));
		await Promise.resolve();

		expect(source.cancel).not.toHaveBeenCalled();
		expect(onCancelError).not.toHaveBeenCalled();
	});

	it("reports a recovery drain failure after completing downstream", async () => {
		const source = controllableStream();
		const onCancelError = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onCancelError,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(result).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		// recover() fires the background drain via cancelAfterForcedClose;
		// error the source so the drain's pending read rejects, exercising
		// the onCancelError reporting path.
		source.controller().error(new Error("recovery drain failed"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(onCancelError).toHaveBeenCalledTimes(1);
		expect(onCancelError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "recovery drain failed" }),
			"timeout",
		);
	});

	it("gives up on the background drain once drainDeadlineMs elapses, without erroring", async () => {
		// A stuck-but-open upstream (never closes, never errors, never sends
		// another byte) is exactly the case recover()'s timeout path exists
		// for. Before the deadline bound, drainUpstreamReader's `reader.read()`
		// would hang forever here — holding the socket open indefinitely
		// where the no-op `reader.cancel()` it replaced would have resolved
		// instantly (issue #382 follow-up, Greptile review on PR #406).
		const source = controllableStream();
		const onCancelError = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 5,
			drainDeadlineMs: 15,
			onCancelError,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(result).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		// Deliberately never close/error/enqueue on `source` — the drain must
		// still settle on its own via the deadline.
		await new Promise((resolve) => setTimeout(resolve, 40));

		// The deadline path is a clean give-up, not a failure: it must not be
		// reported through onCancelError.
		expect(onCancelError).not.toHaveBeenCalled();
	});

	it("aborts drainAbort once drainDeadlineMs elapses, to actually terminate the stuck fetch", async () => {
		// releaseLock() alone only frees the reader object for another
		// consumer — it does not touch the underlying connection. The only way
		// to actually kill an in-flight fetch is to abort a signal that was
		// part of its `init.signal` at creation time (Greptile follow-up on
		// PR #406, second review pass).
		const source = controllableStream();
		const drainAbort = new AbortController();
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 5,
			drainDeadlineMs: 15,
			drainAbort,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(result).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		// Deliberately never close/error/enqueue on `source` — only the
		// deadline can end this drain.
		expect(drainAbort.signal.aborted).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(drainAbort.signal.aborted).toBe(true);
	});

	it("emits 'client_cancelled' via onTerminalState when downstream cancels before terminal events", async () => {
		// Claude Code cancels streams routinely (Esc, tool interrupts).
		// The wrapper must classify client-side cancellation distinctly
		// from upstream failure or truncation, so response-handler can
		// preserve the prior header-based success and avoid poisoning the
		// success-rate metrics.
		const source = controllableStream();
		const onTerminalState = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 50,
			onTerminalState,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		// onTerminalState fires synchronously inside cancel(), before the
		// background drain of the inner upstream reader — no need to wait
		// for the drain (which only settles once the source closes) to
		// observe it.
		void reader.cancel("client disconnect");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("client_cancelled");
	});

	it("emits 'client_cancelled' even when no SSE events were observed", async () => {
		// Cancelling before any bytes flow should still classify as
		// client_cancelled, not truncated — disambiguates "client
		// disconnected" from "upstream TCP closed mid-content".
		const source = controllableStream();
		const onTerminalState = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 50,
			onTerminalState,
		});
		const reader = body.getReader();

		void reader.cancel("client disconnect");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("client_cancelled");
	});

	it("emits 'truncated' via onTerminalState when upstream EOF lands without a stop_reason", async () => {
		// Mirrors the anthropic 8-second 200 with 0 output tokens:
		// stream closed mid-content with no terminal event ever observed.
		const original =
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n' +
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
		const onTerminalState = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onTerminalState },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("truncated");
	});

	it("emits 'recovered' via onTerminalState when stop_reason lands but message_stop never arrives", async () => {
		const onTerminalState = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(terminalDelta)]),
			{ gracePeriodMs: 50, onTerminalState },
		);

		await expect(new Response(body).text()).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("recovered");
	});

	it("emits 'complete' via onTerminalState when both stop_reason and message_stop are observed", async () => {
		const onTerminalState = mock(() => undefined);
		const original = `${terminalDelta}${messageStop}`;
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onTerminalState },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("complete");
	});

	it("emits 'error' via onTerminalState when upstream reader rejects mid-stream", async () => {
		// Transport/stream-level rejection from upstream (e.g. connection
		// reset, AbortError from upstream cancellation, fetch failure)
		// must be classified as "error", NOT "truncated". A premature EOF
		// looks similar on the wire (no message_stop, no error event) but
		// carries no failure signal in-band — only a clean mid-content TCP
		// close. The whole point of the stream_terminal_state column is
		// to distinguish these two failure modes so an explicit upstream
		// error isn't recorded as a silent truncation.
		const source = controllableStream();
		const onTerminalState = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onTerminalState,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		source.controller().error(new Error("upstream connection reset"));

		await expect(reader.read()).rejects.toThrow("upstream connection reset");
		expect(onTerminalState).toHaveBeenCalledTimes(1);
		expect(onTerminalState).toHaveBeenCalledWith("error");
	});
});
