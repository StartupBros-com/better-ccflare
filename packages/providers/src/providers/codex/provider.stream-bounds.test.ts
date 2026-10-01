import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateAnthropicSsePreCommit } from "../../../../proxy/src/anthropic-semantic-preflight";
import { readStreamEvidence } from "../../utils/stream-evidence";
import { CodexProvider } from "./provider";
import {
	CODEX_TRACE_DIR_ENV,
	type CodexStreamDiagnostics,
	summarizeCodexResponse,
	writeCodexResponseTrace,
} from "./trace";

const enc = new TextEncoder();
const frame = (name: string, data: unknown) =>
	`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const openTool = frame("response.output_item.added", {
	output_index: 0,
	item: { type: "function_call", name: "Read", call_id: "private-call" },
});
const reasoning = (value: string) =>
	frame("response.output_item.done", {
		output_index: 1,
		item: { type: "reasoning", id: "rs_private", encrypted_content: value },
	});
const completed = frame("response.completed", {
	response: { usage: { input_tokens: 1, output_tokens: 1 } },
});
const byteCap = 4 * 1024 * 1024;
const itemCap = 1024;
const wrapBytes = Buffer.byteLength("bccfr1.rs_private.");

let dir: string;
let oldTrace: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codex-stream-bounds-"));
	oldTrace = process.env[CODEX_TRACE_DIR_ENV];
	process.env[CODEX_TRACE_DIR_ENV] = dir;
});
afterEach(() => {
	if (oldTrace === undefined) delete process.env[CODEX_TRACE_DIR_ENV];
	else process.env[CODEX_TRACE_DIR_ENV] = oldTrace;
	rmSync(dir, { recursive: true, force: true });
});
function records() {
	return readdirSync(dir).flatMap((f) =>
		readFileSync(join(dir, f), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	);
}
type BufferState = {
	pendingReasoningBlocks: string[];
	pendingReasoningBytes: number;
	functionCallBlocks: Map<number, unknown>;
	functionCallBytesTotal: number;
	rawEventCounts: Record<string, number>;
	argumentDeltaBytes: number;
};
async function convert(
	frames: string[],
	inspect?: (state: BufferState) => void,
) {
	let index = 0;
	const upstream = new ReadableStream<Uint8Array>({
		pull(c) {
			if (index < frames.length) c.enqueue(enc.encode(frames[index++]));
			else c.close();
		},
	});
	const provider = new CodexProvider();
	const internals = provider as unknown as {
		handleCodexEvent: (
			event: string,
			data: Record<string, unknown>,
			state: BufferState,
			...rest: unknown[]
		) => Promise<void>;
	};
	const original = internals.handleCodexEvent.bind(provider);
	let held: BufferState | undefined;
	const spy = spyOn(internals, "handleCodexEvent").mockImplementation(
		async (event, data, state, ...rest) => {
			held = state;
			inspect?.(state);
			await original(event, data, state, ...rest);
		},
	);
	const body = await (
		await provider.processResponse(
			new Response(upstream, {
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		)
	).text();
	spy.mockRestore();
	if (held) {
		expect(held.pendingReasoningBlocks.length).toBe(0);
		expect(held.pendingReasoningBytes).toBe(0);
		expect(held.functionCallBlocks.size).toBe(0);
		expect(held.functionCallBytesTotal).toBe(0);
	}
	return { body, trace: records().filter((r) => r.phase === "response") };
}
function exactBytes(target: number) {
	const result: string[] = [];
	// Keep each frame below the parser cap, but the aggregate at exactly target.
	while (target > 0) {
		const total = Math.min(target, 65536);
		result.push(
			reasoning(
				"é".repeat(Math.floor((total - wrapBytes) / 2)) +
					"x".repeat((total - wrapBytes) % 2),
			),
		);
		target -= total;
	}
	return result;
}

describe("Codex stream retention bounds", () => {
	it("rejects the next deferred UTF-8 byte before retaining it and records one terminal", async () => {
		const { body, trace } = await convert([
			openTool,
			...exactBytes(byteCap),
			reasoning("private-overflow"),
			completed,
		]);
		expect(body.includes("sse_limit_exceeded")).toBe(true);
		expect(body).not.toContain("private-overflow");
		expect(body).not.toContain("message_stop");
		expect(trace).toHaveLength(1);
		expect(trace[0].error_type).toBe("sse_limit_exceeded");
		expect(trace[0].stream_diagnostics.pending_reasoning_bytes).toBe(byteCap);
		expect(trace[0].stream_diagnostics.peak_pending_reasoning_bytes).toBe(
			byteCap,
		);
	});
	it("preserves exact content and ordering at the deferred byte boundary", async () => {
		const pending = exactBytes(byteCap);
		const { body, trace } = await convert([
			openTool,
			...pending,
			frame("response.function_call_arguments.delta", {
				output_index: 0,
				delta: "{}",
			}),
			frame("response.output_item.done", {
				output_index: 0,
				item: { type: "function_call", call_id: "private-call" },
			}),
			completed,
		]);
		expect(body).not.toContain("sse_limit_exceeded");
		const blocks = body
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => JSON.parse(l.slice(5)))
			.filter((x) => x.type === "content_block_start");
		expect(blocks[0].content_block.type).toBe("tool_use");
		expect(blocks.slice(1).map((x) => x.content_block.data)).toEqual(
			pending.map(
				(p) =>
					`bccfr1.rs_private.${JSON.parse(p.split("data: ")[1]).item.encrypted_content}`,
			),
		);
		expect(trace[0].stream_diagnostics.pending_reasoning_bytes).toBe(0);
		expect(trace[0].stream_diagnostics.peak_pending_reasoning_bytes).toBe(
			byteCap,
		);
	});
	it("bounds tiny deferred items independently of bytes", async () => {
		const { body, trace } = await convert([
			openTool,
			...Array.from({ length: itemCap + 1 }, () => reasoning("x")),
			completed,
		]);
		expect(body.includes("sse_limit_exceeded")).toBe(true);
		expect(trace).toHaveLength(1);
		expect(trace[0].stream_diagnostics.pending_reasoning_count).toBe(itemCap);
		expect(trace[0].stream_diagnostics.pending_reasoning_bytes).toBe(
			itemCap * (wrapBytes + 1),
		);
	});
	it("records only fixed raw categories and byte counts, including ignored summaries and malformed frames", async () => {
		const { body, trace } = await convert([
			frame("response.created", { response: { id: "private-response" } }),
			frame("response.in_progress", {}),
			openTool,
			frame("response.function_call_arguments.delta", {
				output_index: 0,
				delta: "private-args",
			}),
			reasoning("private-encrypted"),
			frame("response.reasoning_summary_text.delta", {
				delta: "private-summary",
			}),
			frame("private-event-name", { secret: "private-payload" }),
			"event: broken\ndata: {bad\n\n",
			": ignored\n\n",
			frame("response.failed", { error: { message: "fixture ended" } }),
		]);
		expect(body).not.toContain("private-summary");
		expect(trace).toHaveLength(1);
		const d = trace[0].stream_diagnostics;
		expect(d.event_counts).toMatchObject({
			created: 1,
			in_progress: 1,
			function_call_added: 1,
			argument_delta: 1,
			encrypted_reasoning_done: 1,
			visible_summary_delta: 1,
			other: 1,
			malformed_frame: 1,
			ignored_frame: 1,
			failed: 1,
		});
		expect(d.argument_delta_bytes).toBe(12);
		expect(d.pending_tool_bytes).toBe(12);
		expect(d.peak_pending_tool_bytes).toBe(12);
		expect(d.last_argument_event_age_ms).toBeNumber();
		expect(d.last_visible_event_age_ms).toBeNumber();
		expect(JSON.stringify(d)).not.toContain("private-");
	});
	it("accepts exactly the count limit and resets its charge after flushing", async () => {
		const batch = Array.from({ length: itemCap }, () => reasoning("x"));
		const closeTool = frame("response.output_item.done", {
			output_index: 0,
			item: { type: "function_call", call_id: "private-call" },
		});
		const { body, trace } = await convert([
			openTool,
			...batch,
			closeTool,
			openTool,
			...batch,
			closeTool,
			completed,
		]);
		expect(body.includes("sse_limit_exceeded")).toBe(false);
		expect(trace[0].stream_diagnostics.peak_pending_reasoning_count).toBe(
			itemCap,
		);
		expect(trace[0].stream_diagnostics.pending_reasoning_count).toBe(0);
		expect(body.match(/"type":"redacted_thinking"/g)).toHaveLength(itemCap * 2);
	});
	it("keeps counters saturated rather than overflowing on long-lived streams", async () => {
		let seeded = false;
		const { trace } = await convert(
			[
				frame("response.created", {}),
				frame("response.function_call_arguments.delta", { delta: "x" }),
				completed,
			],
			(state) => {
				if (!seeded) {
					state.rawEventCounts.argument_delta = Number.MAX_SAFE_INTEGER;
					state.argumentDeltaBytes = Number.MAX_SAFE_INTEGER;
					seeded = true;
				}
			},
		);
		expect(trace[0].stream_diagnostics.event_counts.argument_delta).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		expect(trace[0].stream_diagnostics.argument_delta_bytes).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
	it("aborts its owned transport and frees buffers when downstream cancels", async () => {
		const abort = new AbortController();
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				source = c;
				c.enqueue(enc.encode(openTool + reasoning("retained")));
			},
		});
		abort.signal.addEventListener("abort", () => source?.close(), {
			once: true,
		});
		const provider = new CodexProvider();
		let retainedState: BufferState | undefined;
		const handler = provider as unknown as {
			handleCodexEvent: (
				event: string,
				data: Record<string, unknown>,
				state: BufferState,
				...rest: unknown[]
			) => Promise<void>;
		};
		const original = handler.handleCodexEvent.bind(provider);
		const spy = spyOn(handler, "handleCodexEvent").mockImplementation(
			async (event, data, state, ...rest) => {
				retainedState = state;
				await original(event, data, state, ...rest);
			},
		);
		const internals = provider as unknown as {
			transformStreamingResponse: (
				response: Response,
				request: string,
				attempt: string,
				model: string,
				hosted: boolean,
				abort: AbortController,
			) => Response;
		};
		const response = internals.transformStreamingResponse(
			new Response(upstream),
			"cancel-fixture",
			"cancel-attempt",
			"fixture-model",
			false,
			abort,
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");
		await reader.read();
		await reader.read();
		await Bun.sleep(1);
		await reader.cancel("fixture cancelled");
		await Bun.sleep(5);
		expect(abort.signal.aborted).toBe(true);
		expect(retainedState?.pendingReasoningBlocks.length).toBe(0);
		expect(retainedState?.pendingReasoningBytes).toBe(0);
		expect(retainedState?.functionCallBlocks.size).toBe(0);
		spy.mockRestore();
		const terminal = records().filter((r) => r.phase === "response");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].error_type).toBe("downstream_cancelled");
	});
	it("allowlists diagnostics at serialization even when runtime input has extra keys", () => {
		writeCodexResponseTrace({
			summary: summarizeCodexResponse([], {}, "error"),
			streamDiagnostics: {
				event_counts: {
					created: Number.MAX_SAFE_INTEGER * 2,
					private_event: "private-payload",
				},
				private_field: "private-tool-args",
				raw_bytes: -1,
				pending_reasoning_bytes: Number.NaN,
				last_raw_event_age_ms: null,
			} as unknown as CodexStreamDiagnostics,
		});
		const d = records()[0].stream_diagnostics;
		expect(d.event_counts.created).toBe(Number.MAX_SAFE_INTEGER);
		expect(d.raw_bytes).toBe(0);
		expect(d.pending_reasoning_bytes).toBe(0);
		expect(d.last_raw_event_age_ms).toBeNull();
		expect(JSON.stringify(d).includes("private")).toBe(false);
	});
	it("terminates and aborts an endless upstream after the deferred reasoning cap", async () => {
		const abort = new AbortController();
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const frames = [
			openTool,
			...Array.from({ length: itemCap + 1 }, () => reasoning("x")),
		];
		let index = 0;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				source = c;
			},
			pull(c) {
				if (index < frames.length) c.enqueue(enc.encode(frames[index++]));
			},
		});
		abort.signal.addEventListener("abort", () => source?.close(), {
			once: true,
		});
		const provider = new CodexProvider({ streamDrainDeadlineMs: 10 });
		const internals = provider as unknown as {
			transformStreamingResponse: (
				response: Response,
				request: string,
				attempt: string,
				model: string,
				hosted: boolean,
				abort: AbortController,
			) => Response;
		};
		const response = internals.transformStreamingResponse(
			new Response(upstream),
			"cap-fixture",
			"cap-attempt",
			"fixture-model",
			false,
			abort,
		);
		const body = await response.text();
		expect(body.includes("sse_limit_exceeded")).toBe(true);
		await Bun.sleep(30);
		expect(abort.signal.aborted).toBe(true);
		expect(upstream.locked).toBe(false);
		expect(records().filter((r) => r.phase === "response")).toHaveLength(1);
	});

	it("applies the item cap behind an open text block as well", async () => {
		const { body, trace } = await convert([
			frame("response.content_part.added", { part: { type: "output_text" } }),
			...Array.from({ length: itemCap + 1 }, () => reasoning("x")),
			completed,
		]);
		expect(body.includes("sse_limit_exceeded")).toBe(true);
		expect(trace[0].stream_diagnostics.pending_reasoning_count).toBe(itemCap);
	});
	it("cleans up a capped upstream while the downstream stops reading the error", async () => {
		const abort = new AbortController();
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const frames = [
			openTool,
			...Array.from({ length: itemCap + 1 }, () => reasoning("x")),
		];
		let index = 0;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				source = c;
			},
			pull(c) {
				if (index < frames.length) c.enqueue(enc.encode(frames[index++]));
			},
		});
		abort.signal.addEventListener("abort", () => source?.close(), {
			once: true,
		});
		const provider = new CodexProvider({ streamDrainDeadlineMs: 10 });
		const internals = provider as unknown as {
			transformStreamingResponse: (
				response: Response,
				request: string,
				attempt: string,
				model: string,
				hosted: boolean,
				abort: AbortController,
			) => Response;
		};
		const response = internals.transformStreamingResponse(
			new Response(upstream),
			"stalled-cap-fixture",
			"stalled-cap-attempt",
			"fixture-model",
			false,
			abort,
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");
		try {
			// Consume the opening protocol frames, then stop entirely. The cap's
			// close/error writes must not hold the upstream cleanup deadline hostage.
			await reader.read();
			await reader.read();
			await Bun.sleep(100);
			expect(index).toBe(frames.length);
			const terminal = records().filter((r) => r.phase === "response");
			expect(terminal).toHaveLength(1);
			expect(terminal[0].error_type).toBe("sse_limit_exceeded");
			expect(abort.signal.aborted).toBe(true);
			expect(upstream.locked).toBe(false);
		} finally {
			await reader.cancel("fixture cleanup");
			await Bun.sleep(5);
		}
		const terminal = records().filter((r) => r.phase === "response");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].error_type).toBe("sse_limit_exceeded");
	});
});

describe("Codex raw-to-transformed observation", () => {
	it("joins a visible raw argument with zero meaningful transformed frames without diagnosing cause", async () => {
		const provider = new CodexProvider();
		const raw = frame("response.function_call_arguments.delta", {
			output_index: 99,
			delta: "private-argument",
		});
		const response = await provider.processResponse(
			new Response(enc.encode(raw + completed), {
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		);
		const transformedBody = response.body;
		if (!transformedBody) throw new Error("Expected transformed stream");
		let observed: unknown;
		const body = await gateAnthropicSsePreCommit(transformedBody, {
			observe: (e) => {
				observed = e;
			},
		});
		await new Response(body).text();
		expect(observed).toMatchObject({
			rawVisibleEvents: 1,
			meaningfulFrames: 0,
			rawEventCounts: { argument_delta: 1, completed: 1 },
			providerTerminal: "completed",
			diagnosis: "translation_or_gating_candidate",
		});
		expect(readStreamEvidence(transformedBody)).toMatchObject({
			providerTerminal: "completed",
		});
		expect(JSON.stringify(observed)).not.toContain("private-argument");
	});
});
