import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

/**
 * Builds an upstream Response whose body is a live ReadableStream (never
 * closed by this helper) that yields two SSE events guaranteed to trigger
 * two separate writeSSE() calls in transformStreamingResponse
 * (message_start, then a content_block_start for a function_call item).
 * With the transform's default (highWaterMark = 1) downstream backpressure,
 * the first writeSSE() call is allowed through immediately but the second
 * blocks in awaitDownstreamCapacity() until a consumer reads from the
 * transformed response. If nobody ever reads (or cancels) the transformed
 * body, the background processEvents() loop should, per this test, stay
 * parked forever inside that second writeSSE() call and never reach its
 * `finally { upstreamReader?.releaseLock(); }` cleanup.
 *
 * The returned reader spy tracks whether releaseLock()/cancel() are ever
 * called on the actual reader the transform obtains via
 * response.body.getReader().
 */
function makeSpiedTwoEventUpstream() {
	const encoder = new TextEncoder();
	const frame1 = encoder.encode(
		`${eventLine("response.created", { response: { id: "resp_1", model: "gpt-5.4" } }).join("\n")}\n`,
	);
	const frame2 = encoder.encode(
		`${eventLine("response.output_item.added", { item: { type: "function_call", call_id: "call_1", name: "Bash" } }).join("\n")}\n`,
	);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			// Enqueue both frames up front; the point under test is what
			// happens on the *downstream* side once the transform has more
			// than one committed event queued up, not upstream pacing.
			controller.enqueue(frame1);
			controller.enqueue(frame2);
			// Deliberately never close(): a real Codex connection stays open
			// until the server sends a terminal event or the socket drops.
			// Closing here would let the transform's end-of-stream cleanup
			// run on its own, which is exactly the codepath this test wants
			// to rule out (the transform must have no OTHER way to reach
			// cleanup once downstream stops being read).
		},
	});

	let releaseLockCalls = 0;
	let cancelCalls = 0;
	const originalGetReader = stream.getReader.bind(stream);
	// biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of a built-in
	(stream as any).getReader = (...args: unknown[]) => {
		// biome-ignore lint/suspicious/noExplicitAny: forwarding getReader() args
		const reader = (originalGetReader as any)(...args);
		const originalReleaseLock = reader.releaseLock.bind(reader);
		const originalCancel = reader.cancel.bind(reader);
		reader.releaseLock = (...a: unknown[]) => {
			releaseLockCalls++;
			return originalReleaseLock(...a);
		};
		reader.cancel = (...a: unknown[]) => {
			cancelCalls++;
			return originalCancel(...a);
		};
		return reader;
	};

	const response = new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-id": "abandonment-test",
			"x-better-ccflare-attempt-id": "attempt-abandonment",
		},
	});

	return {
		response,
		getReleaseLockCalls: () => releaseLockCalls,
		getCancelCalls: () => cancelCalls,
	};
}

describe("CodexProvider stream abandonment", () => {
	it(
		"documents that an abandoned transformed stream (never read, never cancelled) " +
			"leaks the upstream reader: releaseLock/cancel are never called",
		async () => {
			const provider = new CodexProvider();
			const upstream = makeSpiedTwoEventUpstream();

			const transformed = await provider.processResponse(
				upstream.response,
				null,
			);
			// Sanity: this must actually be the live SSE transform, not a
			// buffered JSON passthrough, or the test would prove nothing.
			expect(transformed.headers.get("content-type")).toBe("text/event-stream");

			// The critical step: never call transformed.body.getReader(),
			// never read(), never cancel(). Just let the background
			// processEvents() task run as far as it can on its own.
			await Bun.sleep(75);

			// If this ever starts failing because releaseLock/cancel DO get
			// called, that means an abandon/discard hook was added upstream
			// of transformStreamingResponse (or the transform grew its own
			// self-cleanup) and this is no longer a leak: flip this test's
			// expectations to lock in the fix instead of deleting it, since
			// it is the only regression guard for this invariant.
			expect(upstream.getReleaseLockCalls()).toBe(0);
			expect(upstream.getCancelCalls()).toBe(0);
		},
	);

	it(
		"confirms the held reader is a real leak, not a timing artifact: reading the " +
			"transformed body to completion DOES release the upstream reader",
		async () => {
			const provider = new CodexProvider();
			const upstream = makeSpiedTwoEventUpstream();

			const transformed = await provider.processResponse(
				upstream.response,
				null,
			);
			const reader = transformed.body?.getReader();
			if (!reader) throw new Error("transformed response has no body reader");

			// Drain fully. The upstream never closes on its own (see
			// makeSpiedTwoEventUpstream), so cancel the downstream once we've
			// observed the two committed events plus whatever the transform
			// appends. This is the "well-behaved consumer" control case.
			let sawContentBlockStart = false;
			const decoder = new TextDecoder();
			let buffer = "";
			const deadline = Date.now() + 2000;
			while (!sawContentBlockStart && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (buffer.includes("content_block_start")) {
					sawContentBlockStart = true;
				}
			}
			expect(sawContentBlockStart).toBeTrue();

			await reader.cancel();

			expect(upstream.getCancelCalls()).toBeGreaterThan(0);
		},
	);

	it(
		"proves the remediation for the leak above: cancelling the transformed " +
			"body immediately (no prior read at all) also releases the upstream " +
			"reader, matching the fix applied at proxy-operations.ts abandonment points",
		async () => {
			const provider = new CodexProvider();
			const upstream = makeSpiedTwoEventUpstream();

			const transformed = await provider.processResponse(
				upstream.response,
				null,
			);

			// Simulate the fix: instead of leaving the response untouched before
			// discarding it (as the first test in this file does), cancel its
			// body immediately, with no read() calls at all. This exercises the
			// exact remediation proxy-operations.ts applies at its abandonment
			// points (first 401 check, post-retry 401 check, rate-limit-exhaustion
			// early return).
			await transformed.body?.cancel("abandoned by caller");

			expect(upstream.getCancelCalls()).toBeGreaterThan(0);

			// releaseLock() happens inside processEvents()'s own finally block,
			// a separate background task that only observes the cancellation
			// once its pending upstreamReader.read() settles. Give it a tick.
			await Bun.sleep(10);
			expect(upstream.getReleaseLockCalls()).toBeGreaterThan(0);
		},
	);
});
