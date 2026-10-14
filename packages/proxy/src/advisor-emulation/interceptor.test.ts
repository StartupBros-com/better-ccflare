import { describe, expect, it } from "bun:test";
import { createAdvisorEmulationStream } from "./interceptor";
import { SseFrameParser } from "./sse";
import {
	type AdvisorEmulationEvent,
	type AdvisorEmulationStreamDeps,
	type AdvisorOutcome,
	type AdvisorRoundInput,
	emulatedAdvisorIdFromCallId,
} from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- builders ----------

type BlockSpec =
	| { kind: "text"; text: string }
	| { kind: "thinking"; thinking: string; signature: string }
	| { kind: "tool"; id: string; name: string; input: Record<string, unknown> };

interface WorkerSpec {
	model?: string;
	blocks: BlockSpec[];
	stop?: string;
	startUsage?: Record<string, unknown>;
	deltaUsage?: Record<string, unknown>;
	noDelta?: boolean;
	extraAfterDelta?: string;
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function worker(spec: WorkerSpec): string {
	let s = frame("message_start", {
		type: "message_start",
		message: {
			id: "msg_x",
			type: "message",
			role: "assistant",
			model: spec.model ?? "gpt-worker",
			content: [],
			stop_reason: null,
			usage: spec.startUsage ?? { input_tokens: 1, output_tokens: 1 },
		},
	});
	spec.blocks.forEach((b, index) => {
		if (b.kind === "text") {
			s += frame("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			});
			s += frame("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: b.text },
			});
		} else if (b.kind === "thinking") {
			s += frame("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "thinking", thinking: "", signature: "" },
			});
			s += frame("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "thinking_delta", thinking: b.thinking },
			});
			s += frame("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "signature_delta", signature: b.signature },
			});
		} else {
			s += frame("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
			});
			s += frame("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(b.input),
				},
			});
		}
		s += frame("content_block_stop", { type: "content_block_stop", index });
	});
	if (!spec.noDelta) {
		s += frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: spec.stop ?? "end_turn", stop_sequence: null },
			usage: spec.deltaUsage ?? { output_tokens: 5 },
		});
		s += frame("message_stop", { type: "message_stop" });
	}
	return s + (spec.extraAfterDelta ?? "");
}

function advisorCall(id = "call_1"): BlockSpec {
	return { kind: "tool", id, name: "advisor", input: {} };
}

function streamOf(text: string, chunkSize = 0): ReadableStream<Uint8Array> {
	const bytes = enc.encode(text);
	return new ReadableStream({
		start(c) {
			if (chunkSize <= 0) c.enqueue(bytes);
			else {
				for (let i = 0; i < bytes.length; i += chunkSize) {
					c.enqueue(bytes.subarray(i, i + chunkSize));
				}
			}
			c.close();
		},
	});
}

function sseResponse(text: string): Response {
	return new Response(streamOf(text), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const ADVISOR_OK: AdvisorOutcome = {
	content: { type: "advisor_result", text: "Use a map." },
	model: "gpt-6-astra",
	usage: { input_tokens: 500, output_tokens: 60 },
};

interface Harness {
	deps: AdvisorEmulationStreamDeps;
	advisorCalls: AdvisorRoundInput[];
	contCalls: AdvisorRoundInput[];
	events: AdvisorEmulationEvent[];
}

function harness(
	continuations: Array<string | (() => Promise<Response>)>,
	over: Partial<AdvisorEmulationStreamDeps> & {
		advisor?: (input: AdvisorRoundInput) => Promise<AdvisorOutcome>;
	} = {},
): Harness {
	const advisorCalls: AdvisorRoundInput[] = [];
	const contCalls: AdvisorRoundInput[] = [];
	const events: AdvisorEmulationEvent[] = [];
	let n = 0;
	const { advisor, ...rest } = over;
	const deps: AdvisorEmulationStreamDeps = {
		advisorModel: "gpt-6-astra",
		pingIntervalMs: 60_000,
		runAdvisor: async (input) => {
			advisorCalls.push(input);
			return advisor ? advisor(input) : ADVISOR_OK;
		},
		runContinuation: async (input) => {
			contCalls.push(input);
			const next = continuations[n++];
			if (next === undefined) throw new Error("unexpected continuation");
			return typeof next === "string" ? sseResponse(next) : next();
		},
		onEvent: (e) => events.push(e),
		...rest,
	};
	return { deps, advisorCalls, contCalls, events };
}

async function readAll(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

interface Ev {
	event?: string;
	json: Record<string, any>;
}

function parseEvents(bytes: Uint8Array): Ev[] {
	const p = new SseFrameParser();
	return [...p.push(bytes), ...p.flush()].map((f) => ({
		event: f.event,
		json: (f.json ?? {}) as Record<string, any>,
	}));
}

async function run(
	upstream: string,
	h: Harness,
	chunkSize = 0,
): Promise<{ bytes: Uint8Array; events: Ev[]; text: string }> {
	const bytes = await readAll(
		createAdvisorEmulationStream(streamOf(upstream, chunkSize), h.deps),
	);
	return { bytes, events: parseEvents(bytes), text: dec.decode(bytes) };
}

function types(events: Ev[]): string[] {
	return events.map((e) => e.json.type);
}

function starts(events: Ev[]): Ev[] {
	return events.filter((e) => e.json.type === "content_block_start");
}

function expectContiguous(events: Ev[]): void {
	const startIdx = starts(events).map((e) => e.json.index);
	expect(startIdx).toEqual(startIdx.map((_, i) => i));
	for (const e of events) {
		if (
			e.json.type === "content_block_delta" ||
			e.json.type === "content_block_stop"
		) {
			expect(e.json.index).toBeLessThan(startIdx.length);
		}
	}
}

function count(events: Ev[], type: string): number {
	return events.filter((e) => e.json.type === type).length;
}

// ---------- tests ----------

describe("passthrough", () => {
	it("forwards a response with no tool_use byte-identically", async () => {
		const up =
			frame("ping", { type: "ping" }) +
			worker({ blocks: [{ kind: "text", text: "hello" }] });
		const h = harness([]);
		const { text } = await run(up, h, 11);
		expect(text).toBe(up);
		expect(h.advisorCalls).toHaveLength(0);
		expect(h.contCalls).toHaveLength(0);
	});

	it("forwards a non-advisor tool_use response byte-identically", async () => {
		const up = worker({
			blocks: [
				{ kind: "text", text: "reading" },
				{ kind: "tool", id: "t1", name: "Read", input: { path: "a" } },
			],
			stop: "tool_use",
		});
		const h = harness([]);
		const { text } = await run(up, h);
		expect(text).toBe(up);
	});

	it("passes pings through while blocks are buffered", async () => {
		const up =
			worker({ blocks: [], noDelta: true }) +
			frame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t", name: "Read", input: {} },
			}) +
			frame("ping", { type: "ping" }) +
			frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
			frame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 2 },
			}) +
			frame("message_stop", { type: "message_stop" });
		const { text } = await run(up, harness([]));
		expect(text.indexOf('"type":"ping"')).toBeLessThan(
			text.indexOf('"content_block_stop"'),
		);
	});
});

describe("AE1: sole advisor round", () => {
	const w1 = worker({
		model: "gpt-worker",
		blocks: [
			{ kind: "thinking", thinking: "hm", signature: "sig1" },
			{ kind: "text", text: "Let me check." },
			advisorCall("call_1"),
		],
		stop: "tool_use",
		startUsage: { input_tokens: 100, output_tokens: 1 },
		deltaUsage: { output_tokens: 20 },
	});
	const w2 = worker({
		model: "gpt-worker",
		blocks: [{ kind: "text", text: "All done." }],
		stop: "end_turn",
		startUsage: { input_tokens: 150, output_tokens: 1 },
		deltaUsage: { output_tokens: 30 },
	});

	it("splices the pair and the continuation into one message", async () => {
		const h = harness([w2]);
		const { events } = await run(w1, h, 13);
		expect(count(events, "message_start")).toBe(1);
		expect(count(events, "message_delta")).toBe(1);
		expect(count(events, "message_stop")).toBe(1);
		expectContiguous(events);
		const s = starts(events).map((e) => e.json.content_block);
		expect(s.map((b) => b.type)).toEqual([
			"thinking",
			"text",
			"server_tool_use",
			"advisor_tool_result",
			"text",
		]);
		const id = emulatedAdvisorIdFromCallId("call_1");
		expect(s[2]).toEqual({
			type: "server_tool_use",
			id,
			name: "advisor",
			input: {},
		});
		expect(s[3]).toEqual({
			type: "advisor_tool_result",
			tool_use_id: id,
			content: { type: "advisor_result", text: "Use a map." },
		});
		// server_tool_use carries exactly one {} input_json_delta
		const stIdx = starts(events)[2].json.index;
		const deltas = events.filter(
			(e) => e.json.type === "content_block_delta" && e.json.index === stIdx,
		);
		expect(deltas.map((d) => d.json.delta)).toEqual([
			{ type: "input_json_delta", partial_json: "{}" },
		]);
		// advisor_tool_result has no deltas
		const resIdx = starts(events)[3].json.index;
		expect(
			events.filter(
				(e) => e.json.type === "content_block_delta" && e.json.index === resIdx,
			),
		).toHaveLength(0);
		const delta = events.find((e) => e.json.type === "message_delta")?.json;
		expect(delta?.delta.stop_reason).toBe("end_turn");
		expect(types(events).at(-1)).toBe("message_stop");
	});

	it("sums worker usage and reports iterations", async () => {
		const h = harness([w2]);
		const { events } = await run(w1, h);
		const usage = events.find((e) => e.json.type === "message_delta")?.json
			.usage;
		expect(usage.input_tokens).toBe(250);
		expect(usage.output_tokens).toBe(50);
		expect(usage.iterations).toEqual([
			{
				type: "message",
				model: "gpt-worker",
				input_tokens: 100,
				output_tokens: 20,
			},
			{
				type: "advisor_message",
				model: "gpt-6-astra",
				input_tokens: 500,
				output_tokens: 60,
			},
			{
				type: "message",
				model: "gpt-worker",
				input_tokens: 150,
				output_tokens: 30,
			},
		]);
	});

	it("hands the deps the exact in-flight assistant content", async () => {
		const h = harness([w2]);
		await run(w1, h);
		const id = emulatedAdvisorIdFromCallId("call_1");
		expect(h.advisorCalls).toHaveLength(1);
		expect(h.advisorCalls[0].round).toBe(1);
		expect(h.advisorCalls[0].inflightAssistantContent).toEqual([
			{ type: "thinking", thinking: "hm", signature: "sig1" },
			{ type: "text", text: "Let me check." },
		]);
		expect(h.contCalls).toHaveLength(1);
		expect(h.contCalls[0].inflightAssistantContent).toEqual([
			{ type: "thinking", thinking: "hm", signature: "sig1" },
			{ type: "text", text: "Let me check." },
			{ type: "server_tool_use", id, name: "advisor", input: {} },
			{
				type: "advisor_tool_result",
				tool_use_id: id,
				content: { type: "advisor_result", text: "Use a map." },
			},
		]);
		expect(h.events.map((e) => e.kind)).toEqual([
			"advisor_round_started",
			"advisor_round_finished",
		]);
	});

	it("forwards a streamed text block's frames unchanged when indices are identity", async () => {
		const h = harness([w2]);
		const { text } = await run(w1, h);
		const expectedPrefix = w1.slice(
			0,
			w1.indexOf(
				'event: content_block_start\ndata: {"type":"content_block_start","index":2',
			),
		);
		expect(text.startsWith(expectedPrefix)).toBe(true);
	});
});

describe("AE2: advisor with siblings", () => {
	it("drops the advisor block, re-indexes and never runs the advisor", async () => {
		const up = worker({
			blocks: [
				{ kind: "text", text: "go" },
				advisorCall(),
				{ kind: "tool", id: "t1", name: "Read", input: { p: 1 } },
			],
			stop: "tool_use",
		});
		const h = harness([]);
		const { events } = await run(up, h);
		expectContiguous(events);
		const s = starts(events).map((e) => e.json.content_block);
		expect(s.map((b) => b.type)).toEqual(["text", "tool_use"]);
		expect(s[1].name).toBe("Read");
		const readIdx = starts(events)[1].json.index;
		expect(readIdx).toBe(1);
		expect(
			events.find((e) => e.json.type === "message_delta")?.json.delta
				.stop_reason,
		).toBe("tool_use");
		expect(h.advisorCalls).toHaveLength(0);
		expect(h.contCalls).toHaveLength(0);
		expect(h.events).toEqual([
			{ kind: "advisor_dropped_with_siblings", round: 1 },
		]);
		expect(JSON.stringify(events)).not.toContain('"advisor"');
		// no iterations when no round ran
		expect(
			events.find((e) => e.json.type === "message_delta")?.json.usage
				.iterations,
		).toBeUndefined();
	});

	it("drops an advisor call when stop_reason is not tool_use", async () => {
		const up = worker({
			blocks: [{ kind: "text", text: "a" }, advisorCall()],
			stop: "end_turn",
		});
		const h = harness([]);
		const { events } = await run(up, h);
		expect(starts(events).map((e) => e.json.content_block.type)).toEqual([
			"text",
		]);
		expect(h.advisorCalls).toHaveLength(0);
		expect(h.events[0]?.kind).toBe("advisor_dropped_with_siblings");
	});
});

describe("AE3: advisor failure outcome", () => {
	it("emits the error block and still runs the continuation", async () => {
		const w1 = worker({ blocks: [advisorCall("c9")], stop: "tool_use" });
		const w2 = worker({ blocks: [{ kind: "text", text: "ok" }] });
		const h = harness([w2], {
			advisor: async () => ({
				content: {
					type: "advisor_tool_result_error",
					error_code: "too_many_requests",
				},
				model: "gpt-6-astra",
			}),
		});
		const { events } = await run(w1, h);
		const res = starts(events)
			.map((e) => e.json.content_block)
			.find((b) => b.type === "advisor_tool_result");
		expect(res.content).toEqual({
			type: "advisor_tool_result_error",
			error_code: "too_many_requests",
		});
		expect(h.contCalls).toHaveLength(1);
		const usage = events.find((e) => e.json.type === "message_delta")?.json
			.usage;
		// no usage on the failure -> no advisor_message iteration
		expect(usage.iterations.map((i: { type: string }) => i.type)).toEqual([
			"message",
			"message",
		]);
		expect(
			h.events.find((e) => e.kind === "advisor_round_finished"),
		).toMatchObject({
			outcome: "advisor_tool_result_error",
			errorCode: "too_many_requests",
		});
	});

	it("maps a throwing runAdvisor to unavailable", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness([worker({ blocks: [{ kind: "text", text: "ok" }] })], {
			advisor: async () => {
				throw new Error("boom");
			},
		});
		const { events } = await run(w1, h);
		const res = starts(events)
			.map((e) => e.json.content_block)
			.find((b) => b.type === "advisor_tool_result");
		expect(res.content.error_code).toBe("unavailable");
	});

	it("maps a runAdvisor timeout to execution_time_exceeded and aborts its signal", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		let sig: AbortSignal | undefined;
		const h = harness([worker({ blocks: [{ kind: "text", text: "ok" }] })], {
			advisorTimeoutMs: 20,
			advisor: (input) => {
				sig = input.signal;
				return new Promise(() => {});
			},
		});
		const { events } = await run(w1, h);
		const res = starts(events)
			.map((e) => e.json.content_block)
			.find((b) => b.type === "advisor_tool_result");
		expect(res.content.error_code).toBe("execution_time_exceeded");
		expect(sig?.aborted).toBe(true);
		expect(h.contCalls).toHaveLength(1);
	});
});

describe("AE8: cancellation", () => {
	it("cancel during runAdvisor aborts its signal and starts no continuation", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		let sig: AbortSignal | undefined;
		let entered!: () => void;
		const enteredP = new Promise<void>((r) => {
			entered = r;
		});
		const h = harness([worker({ blocks: [] })], {
			advisor: (input) => {
				sig = input.signal;
				entered();
				return new Promise(() => {});
			},
		});
		const stream = createAdvisorEmulationStream(streamOf(w1), h.deps);
		const reader = stream.getReader();
		const first = reader.read();
		await enteredP;
		await first;
		await reader.cancel("client gone");
		await new Promise((r) => setTimeout(r, 20));
		expect(sig?.aborted).toBe(true);
		expect(h.contCalls).toHaveLength(0);
	});

	it("deps.signal abort cancels the in-flight continuation and ends the stream", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const ctl = new AbortController();
		let contSig: AbortSignal | undefined;
		const h = harness(
			[
				() => {
					return new Promise<Response>(() => {});
				},
			],
			{ signal: ctl.signal },
		);
		const origCont = h.deps.runContinuation;
		h.deps.runContinuation = (input) => {
			contSig = input.signal;
			setTimeout(() => ctl.abort(), 10);
			return origCont(input);
		};
		const { events } = await run(w1, h);
		expect(contSig?.aborted).toBe(true);
		expect(count(events, "message_stop")).toBe(0);
		expect(count(events, "error")).toBe(0);
	});

	it("an already-aborted signal makes no dep calls", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const ctl = new AbortController();
		ctl.abort();
		const h = harness([], { signal: ctl.signal });
		await run(w1, h);
		expect(h.advisorCalls).toHaveLength(0);
		expect(h.contCalls).toHaveLength(0);
	});
});

describe("AE9: caps", () => {
	it("a third sole advisor call gets max_uses_exceeded without a sub-call", async () => {
		const adv = (id: string) =>
			worker({ blocks: [advisorCall(id)], stop: "tool_use" });
		const h = harness([
			adv("c2"),
			adv("c3"),
			worker({ blocks: [{ kind: "text", text: "end" }] }),
		]);
		const { events } = await run(adv("c1"), h);
		expect(h.advisorCalls).toHaveLength(2);
		expect(h.contCalls).toHaveLength(3);
		const results = starts(events)
			.map((e) => e.json.content_block)
			.filter((b) => b.type === "advisor_tool_result");
		expect(results).toHaveLength(3);
		expect(results[2].content).toEqual({
			type: "advisor_tool_result_error",
			error_code: "max_uses_exceeded",
		});
		expectContiguous(events);
		expect(count(events, "message_start")).toBe(1);
		expect(count(events, "message_stop")).toBe(1);
		expect(h.events.some((e) => e.kind === "caps_reached")).toBe(true);
		const usage = events.find((e) => e.json.type === "message_delta")?.json
			.usage;
		// capped round has no usage -> only two advisor_message iterations
		expect(
			usage.iterations.filter(
				(i: { type: string }) => i.type === "advisor_message",
			),
		).toHaveLength(2);
	});

	it("at the worker-call cap the message ends with end_turn and no continuation", async () => {
		const adv = (id: string) =>
			worker({ blocks: [advisorCall(id)], stop: "tool_use" });
		const h = harness([adv("c2")], { maxWorkerCalls: 2 });
		const { events } = await run(adv("c1"), h);
		expect(h.advisorCalls).toHaveLength(1);
		expect(h.contCalls).toHaveLength(1);
		const results = starts(events)
			.map((e) => e.json.content_block)
			.filter((b) => b.type === "advisor_tool_result");
		expect(results[1].content.error_code).toBe("max_uses_exceeded");
		const delta = events.find((e) => e.json.type === "message_delta")?.json;
		expect(delta.delta.stop_reason).toBe("end_turn");
		expect(types(events).slice(-2)).toEqual(["message_delta", "message_stop"]);
	});
});

describe("errors", () => {
	it("an upstream error while buffering drops the advisor, flushes and forwards the error", async () => {
		const up =
			frame("message_start", {
				type: "message_start",
				message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
			}) +
			frame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}) +
			frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
			frame("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "a",
					name: "advisor",
					input: {},
				},
			}) +
			frame("content_block_stop", { type: "content_block_stop", index: 1 }) +
			frame("error", {
				type: "error",
				error: { type: "overloaded_error", message: "busy" },
			});
		const h = harness([]);
		const { events } = await run(up, h);
		expect(starts(events).map((e) => e.json.content_block.type)).toEqual([
			"text",
		]);
		expect(types(events).at(-1)).toBe("error");
		expect(h.advisorCalls).toHaveLength(0);
	});

	it("upstream ending without message_delta flushes the buffer minus advisor", async () => {
		const up = worker({
			blocks: [
				{ kind: "text", text: "t" },
				{ kind: "tool", id: "r", name: "Read", input: {} },
				advisorCall(),
			],
			noDelta: true,
		});
		const h = harness([]);
		const { events } = await run(up, h);
		expect(starts(events).map((e) => e.json.content_block.type)).toEqual([
			"text",
			"tool_use",
		]);
		expect(h.advisorCalls).toHaveLength(0);
	});

	it("a continuation ending without message_delta closes blocks and ends with an error event", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const w2 = worker({
			blocks: [{ kind: "text", text: "partial" }],
			noDelta: true,
		});
		const h = harness([w2]);
		const { events } = await run(w1, h);
		const last = events.at(-1)?.json;
		expect(last?.type).toBe("error");
		expect(last?.error?.type).toBe("api_error");
		expect(count(events, "message_stop")).toBe(0);
		expect(count(events, "content_block_start")).toBe(
			count(events, "content_block_stop"),
		);
		expect(h.events.find((e) => e.kind === "continuation_failed")).toEqual({
			kind: "continuation_failed",
			round: 1,
			status: undefined,
		});
	});

	it("a continuation whose body read throws ends with an error event, not a stream error", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness([
			async () => {
				const head = enc.encode(
					worker({
						blocks: [{ kind: "text", text: "partial" }],
						noDelta: true,
					}),
				);
				let sentHead = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(c) {
							if (!sentHead) {
								sentHead = true;
								c.enqueue(head);
								return;
							}
							c.error(new Error("socket reset"));
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
		]);
		const { events } = await run(w1, h);
		const last = events.at(-1)?.json;
		expect(last?.type).toBe("error");
		expect(count(events, "message_stop")).toBe(0);
		expect(count(events, "content_block_start")).toBe(
			count(events, "content_block_stop"),
		);
	});

	it("a non-ok continuation becomes an error event (Anthropic-shaped body mapped)", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness([
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: "slow down" },
					}),
					{ status: 529 },
				),
		]);
		const { events } = await run(w1, h);
		const last = events.at(-1)?.json;
		expect(last).toEqual({
			type: "error",
			error: { type: "overloaded_error", message: "slow down" },
		});
		expect(count(events, "message_stop")).toBe(0);
		expect(count(events, "message_delta")).toBe(0);
		expect(h.events.find((e) => e.kind === "continuation_failed")).toEqual({
			kind: "continuation_failed",
			round: 1,
			status: 529,
		});
		expectContiguous(events);
	});

	it("a rejecting continuation yields a generic api_error event", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness([
			async () => {
				throw new Error("socket closed");
			},
		]);
		const { events } = await run(w1, h);
		const last = events.at(-1)?.json;
		expect(last.type).toBe("error");
		expect(last.error.type).toBe("api_error");
		expect(typeof last.error.message).toBe("string");
		// every opened block was stopped before the error
		const opened = count(events, "content_block_start");
		expect(count(events, "content_block_stop")).toBe(opened);
	});

	it("a non-ok continuation with a non-JSON body yields api_error", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness([
			async () => new Response("<html>bad gateway</html>", { status: 502 }),
		]);
		const { events } = await run(w1, h);
		expect(events.at(-1)?.json.error.type).toBe("api_error");
		expect(events.at(-1)?.json.error.message).not.toContain("<html>");
	});
});

describe("pings", () => {
	it("emits pings while awaiting a slow advisor and a slow continuation", async () => {
		const w1 = worker({ blocks: [advisorCall()], stop: "tool_use" });
		const h = harness(
			[
				async () => {
					await new Promise((r) => setTimeout(r, 60));
					return sseResponse(worker({ blocks: [{ kind: "text", text: "z" }] }));
				},
			],
			{
				pingIntervalMs: 10,
				advisor: async () => {
					await new Promise((r) => setTimeout(r, 60));
					return ADVISOR_OK;
				},
			},
		);
		const { events } = await run(w1, h);
		expect(count(events, "ping")).toBeGreaterThanOrEqual(4);
		// pings sit between server_tool_use stop and advisor_tool_result start
		const t = types(events);
		const iStop = t.indexOf(
			"content_block_stop",
			t.indexOf("content_block_start"),
		);
		expect(iStop).toBeGreaterThan(-1);
		expect(count(events, "message_start")).toBe(1);
	});
});

describe("two rounds", () => {
	it("keeps indices contiguous across both rounds", async () => {
		const w1 = worker({
			blocks: [{ kind: "text", text: "one" }, advisorCall("c1")],
			stop: "tool_use",
		});
		const w2 = worker({
			blocks: [{ kind: "text", text: "two" }, advisorCall("c2")],
			stop: "tool_use",
		});
		const w3 = worker({ blocks: [{ kind: "text", text: "three" }] });
		const h = harness([w2, w3]);
		const { events } = await run(w1, h, 17);
		expectContiguous(events);
		expect(starts(events).map((e) => e.json.content_block.type)).toEqual([
			"text",
			"server_tool_use",
			"advisor_tool_result",
			"text",
			"server_tool_use",
			"advisor_tool_result",
			"text",
		]);
		expect(count(events, "message_start")).toBe(1);
		expect(count(events, "message_delta")).toBe(1);
		expect(count(events, "message_stop")).toBe(1);
		expect(h.advisorCalls.map((c) => c.round)).toEqual([1, 2]);
		expect(h.contCalls[1].inflightAssistantContent.map((b) => b.type)).toEqual([
			"text",
			"server_tool_use",
			"advisor_tool_result",
			"text",
			"server_tool_use",
			"advisor_tool_result",
		]);
		// round-2 advisor sees everything before its pending call
		expect(
			h.advisorCalls[1].inflightAssistantContent.map((b) => b.type),
		).toEqual(["text", "server_tool_use", "advisor_tool_result", "text"]);
	});

	it("a later worker call with no advisor flushes its other tools with remapped indices", async () => {
		const w1 = worker({ blocks: [advisorCall("c1")], stop: "tool_use" });
		const w2 = worker({
			blocks: [
				{ kind: "text", text: "now reading" },
				{ kind: "tool", id: "r1", name: "Read", input: { a: 1 } },
			],
			stop: "tool_use",
		});
		const h = harness([w2]);
		const { events } = await run(w1, h);
		expectContiguous(events);
		const tail = starts(events).at(-1)?.json;
		expect(tail.content_block.name).toBe("Read");
		expect(tail.index).toBe(3);
		expect(
			events.find((e) => e.json.type === "message_delta")?.json.delta
				.stop_reason,
		).toBe("tool_use");
	});
});
