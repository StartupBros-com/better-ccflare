/**
 * Response-side half of advisor emulation (plan R4, R6, R7, R8, R11).
 *
 * A pure stream transform: it parses the worker's Anthropic SSE, and when the
 * worker ends its turn with a sole `advisor` tool_use it runs an advisor round
 * through `deps`, then splices the continuation's blocks into the SAME
 * client-visible message (one message_start, contiguous block indices, one
 * terminal message_delta/message_stop).
 *
 * Frames that need no change are forwarded as their original bytes, so a
 * response that never involves the advisor is byte-identical to its input.
 *
 * Usage accounting (R11, read against usage-collector.ts
 * `captureUsageIterations` and the advisor-pricing block that follows it):
 * - Worker iterations are `{type:"message", model, ...tokens}` and always
 *   carry the worker model. They are NOT `fallback_message`, so
 *   `fallbackIterationSeen` stays false and no fallback billing split or
 *   repricing happens; one distinct non-advisor model keeps the
 *   "attribution ambiguous / billingIncomplete" check quiet.
 * - Top-level usage is the SUM of worker usage only. The collector prices it
 *   at the serving model and states that advisor tokens are never rolled into
 *   the top level.
 * - `advisor_message` iterations carry the advisor model and are priced one by
 *   one at their own model. A round without usage (timeout, error,
 *   max_uses_exceeded) emits no advisor_message: the collector skips
 *   zero-output entries anyway, so nothing billable is lost.
 * - The iteration array is only emitted when a round ran, and always in the
 *   last message_delta, so it is the newest usage payload (not stale).
 */

import { ADVISOR_SERVER_TOOL_NAME } from "@better-ccflare/providers/server-tool-capabilities";
import type { SseFrame } from "./sse";
import {
	AnthropicBlockAccumulator,
	encodeSseFrame,
	SseFrameParser,
} from "./sse";
import {
	type AdvisorEmulationStreamDeps,
	type AdvisorOutcome,
	type AdvisorResultContent,
	type AnthropicBlock,
	emulatedAdvisorIdFromCallId,
} from "./types";

const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_ADVISOR_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_ADVISOR_CALLS = 2;
const DEFAULT_MAX_WORKER_CALLS = 4;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const TOKEN_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_read_input_tokens",
	"cache_creation_input_tokens",
] as const;

const PING_BYTES = new TextEncoder().encode(
	'event: ping\ndata: {"type":"ping"}\n\n',
);

type Json = Record<string, any>;

/** Thrown inside the runner when the stream's lifetime ends (cancel / abort). */
class LifeEnded extends Error {}

/** One content block of the current worker call. */
interface BlockRec {
	/** Upstream block index; -1 for a non-block frame kept in order. */
	up: number;
	frames: SseFrame[];
	start?: Json;
	final?: AnthropicBlock;
	isAdvisor: boolean;
	/** Buffered (true) or already streamed to the client (false). */
	buffered: boolean;
	/** Client index of a block that was streamed immediately. */
	client?: number;
}

type CallResult =
	/** `truncated`: upstream closed or failed before any terminal event. */
	| { kind: "end"; truncated?: boolean }
	| {
			kind: "round";
			recs: BlockRec[];
			advisor: BlockRec;
			acc: AnthropicBlockAccumulator;
	  };

interface TokenFields {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function pickTokens(...sources: Array<Json | undefined>): TokenFields {
	const out: TokenFields = {};
	for (const field of TOKEN_FIELDS) {
		for (const src of sources) {
			if (src && isNum(src[field])) out[field] = src[field];
		}
	}
	return out;
}

function errorOutcome(
	code: Extract<
		AdvisorResultContent,
		{ type: "advisor_tool_result_error" }
	>["error_code"],
	model: string,
): AdvisorOutcome {
	return {
		content: { type: "advisor_tool_result_error", error_code: code },
		model,
	};
}

export function createAdvisorEmulationStream(
	upstream: ReadableStream<Uint8Array>,
	deps: AdvisorEmulationStreamDeps,
): ReadableStream<Uint8Array> {
	const pingMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
	const timeoutMs = deps.advisorTimeoutMs ?? DEFAULT_ADVISOR_TIMEOUT_MS;
	const maxAdvisorCalls = deps.maxAdvisorCalls ?? DEFAULT_MAX_ADVISOR_CALLS;
	const maxWorkerCalls = deps.maxWorkerCalls ?? DEFAULT_MAX_WORKER_CALLS;

	const life = new AbortController();
	let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	const lifeEnded = new Promise<never>((_, reject) => {
		life.signal.addEventListener("abort", () => reject(new LifeEnded()), {
			once: true,
		});
	});
	lifeEnded.catch(() => {});

	const out = (bytes: Uint8Array): void => {
		if (closed) return;
		try {
			controllerRef.enqueue(bytes);
		} catch {
			closed = true;
		}
	};
	const finish = (): void => {
		if (closed) return;
		closed = true;
		try {
			controllerRef.close();
		} catch {
			// already closed or errored
		}
	};
	const releaseUpstream = (reason?: unknown): void => {
		const reader = currentReader;
		currentReader = null;
		reader?.cancel(reason).catch(() => {});
	};
	const endLife = (reason?: unknown): void => {
		if (!life.signal.aborted) life.abort(reason);
		releaseUpstream(reason);
	};

	// ---- client-facing state -------------------------------------------
	let nextClientIndex = 0;
	const sent: AnthropicBlock[] = [];
	const openClient = new Set<number>();
	let messageStartSent = false;
	let rounds = 0;
	let advisorSubcalls = 0;
	const iterations: Json[] = [];
	const totals: TokenFields = {};
	let lastDelta: Json | undefined;
	let lastWorkerModel: string | undefined;

	const emit = (event: string, data: Json): void => {
		if (data.type === "content_block_start") openClient.add(data.index);
		else if (data.type === "content_block_stop") openClient.delete(data.index);
		out(encodeSseFrame(event, data));
	};

	/** Forward a block frame under a (possibly different) client index. */
	const outFrame = (frame: SseFrame, clientIndex: number): void => {
		const json = frame.json as Json | undefined;
		if (!json || typeof json !== "object") {
			out(frame.raw);
			return;
		}
		if (json.type === "content_block_start") openClient.add(clientIndex);
		else if (json.type === "content_block_stop") openClient.delete(clientIndex);
		if (json.index === clientIndex) {
			out(frame.raw);
			return;
		}
		out(
			encodeSseFrame(frame.event ?? String(json.type), {
				...json,
				index: clientIndex,
			}),
		);
	};

	const flushRecs = (
		recs: BlockRec[],
		acc: AnthropicBlockAccumulator,
	): void => {
		for (const rec of recs) {
			if (rec.up < 0) {
				for (const f of rec.frames) out(f.raw);
				continue;
			}
			const clientIndex = nextClientIndex++;
			for (const f of rec.frames) outFrame(f, clientIndex);
			const block = rec.final ?? acc.peek(rec.up);
			if (block) sent.push(block);
		}
	};

	const emitBlock = (block: AnthropicBlock, partialJson?: string): void => {
		const index = nextClientIndex++;
		emit("content_block_start", {
			type: "content_block_start",
			index,
			content_block: block,
		});
		if (partialJson !== undefined) {
			emit("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: partialJson },
			});
		}
		emit("content_block_stop", { type: "content_block_stop", index });
	};

	const closeOpenBlocks = (): void => {
		for (const index of [...openClient].sort((a, b) => a - b)) {
			emit("content_block_stop", { type: "content_block_stop", index });
		}
	};

	const emitTerminal = (stopReasonOverride?: string): void => {
		const base: Json = lastDelta ?? { type: "message_delta", delta: {} };
		const lastUsage: Json =
			base.usage && typeof base.usage === "object" ? base.usage : {};
		const usage: Json = {};
		for (const [k, v] of Object.entries(lastUsage)) {
			if (k === "iterations") continue;
			if ((TOKEN_FIELDS as readonly string[]).includes(k)) continue;
			usage[k] = v;
		}
		Object.assign(usage, totals);
		if (rounds > 0) usage.iterations = iterations;
		const delta: Json = { ...(base.delta ?? {}) };
		if (stopReasonOverride) {
			delta.stop_reason = stopReasonOverride;
			delta.stop_sequence = null;
		}
		out(
			encodeSseFrame("message_delta", {
				...base,
				type: "message_delta",
				delta,
				usage,
			}),
		);
		out(encodeSseFrame("message_stop", { type: "message_stop" }));
	};

	const emitError = (error: Json): void => {
		out(encodeSseFrame("error", { type: "error", error }));
	};

	const recordWorkerCall = (
		model: string | undefined,
		startUsage: Json | undefined,
		delta: Json,
	): void => {
		const tokens = pickTokens(startUsage, delta.usage);
		for (const field of TOKEN_FIELDS) {
			const v = tokens[field];
			if (v !== undefined) totals[field] = (totals[field] ?? 0) + v;
		}
		const iteration: Json = { type: "message" };
		if (model) iteration.model = model;
		Object.assign(iteration, tokens);
		iterations.push(iteration);
		lastDelta = delta;
	};

	// ---- waiting helpers ------------------------------------------------
	const withPings = async <T>(work: Promise<T>): Promise<T> => {
		const timer = setInterval(() => out(PING_BYTES), pingMs);
		try {
			return await Promise.race([work, lifeEnded]);
		} finally {
			clearInterval(timer);
		}
	};

	// ---- reading one worker call ---------------------------------------
	const readCall = async (
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<CallResult> => {
		const parser = new SseFrameParser();
		const acc = new AnthropicBlockAccumulator();
		const recs = new Map<number, BlockRec>();
		const order: BlockRec[] = [];
		let buffering = false;
		let model: string | undefined;
		let startUsage: Json | undefined;
		// "raw": no round ever ran, so delta/stop forward as received.
		// "synthetic": terminal already emitted by us; swallow the rest.
		let terminal: "raw" | "synthetic" | undefined;

		const withoutAdvisor = (): BlockRec[] => order.filter((r) => !r.isAdvisor);

		const handle = (frame: SseFrame): CallResult | undefined => {
			const json = frame.json as Json | undefined;
			const type: string | undefined =
				(json && typeof json.type === "string" ? json.type : undefined) ??
				frame.event;
			if (terminal === "synthetic") return undefined;
			if (terminal === "raw") {
				out(frame.raw);
				return undefined;
			}
			switch (type) {
				case "ping":
					out(frame.raw);
					return undefined;
				case "message_start": {
					model = json?.message?.model;
					lastWorkerModel = model ?? lastWorkerModel;
					startUsage = json?.message?.usage;
					if (!messageStartSent) {
						messageStartSent = true;
						out(frame.raw);
					}
					return undefined;
				}
				case "content_block_start": {
					if (!json) {
						out(frame.raw);
						return undefined;
					}
					const up: number = json.index;
					const block = json.content_block as Json;
					acc.start(up, block);
					const isTool = block?.type === "tool_use";
					if (!buffering && !isTool) {
						const rec: BlockRec = {
							up,
							frames: [],
							start: block,
							isAdvisor: false,
							buffered: false,
						};
						rec.client = nextClientIndex++;
						recs.set(up, rec);
						outFrame(frame, rec.client);
						return undefined;
					}
					buffering = true;
					const rec: BlockRec = {
						up,
						frames: [frame],
						start: block,
						isAdvisor: isTool && block.name === ADVISOR_SERVER_TOOL_NAME,
						buffered: true,
					};
					recs.set(up, rec);
					order.push(rec);
					return undefined;
				}
				case "content_block_delta":
				case "content_block_stop": {
					const up: number | undefined = json?.index;
					const rec = up === undefined ? undefined : recs.get(up);
					if (up === undefined || !rec) {
						if (buffering)
							order.push({
								up: -1,
								frames: [frame],
								isAdvisor: false,
								buffered: true,
							});
						else out(frame.raw);
						return undefined;
					}
					if (type === "content_block_delta") acc.delta(up, json?.delta);
					const stopped =
						type === "content_block_stop" ? acc.stop(up) : undefined;
					if (rec.buffered) {
						rec.frames.push(frame);
						if (stopped) rec.final = stopped;
					} else {
						outFrame(frame, rec.client ?? 0);
						if (stopped) sent.push(stopped);
					}
					return undefined;
				}
				case "message_delta": {
					if (!json) {
						out(frame.raw);
						return undefined;
					}
					return decide(frame, json);
				}
				case "message_stop":
					// Only reached before any message_delta: a malformed stream.
					out(frame.raw);
					return undefined;
				case "error": {
					flushRecs(withoutAdvisor(), acc);
					out(frame.raw);
					terminal = "synthetic";
					return { kind: "end" };
				}
				default:
					if (buffering) {
						order.push({
							up: -1,
							frames: [frame],
							isAdvisor: false,
							buffered: true,
						});
					} else out(frame.raw);
					return undefined;
			}
		};

		const decide = (frame: SseFrame, delta: Json): CallResult | undefined => {
			recordWorkerCall(model, startUsage, delta);
			const advisors = order.filter((r) => r.isAdvisor);
			const toolUses = order.filter((r) => r.start?.type === "tool_use");
			const stop = delta.delta?.stop_reason;
			if (advisors.length === 0) {
				flushRecs(order, acc);
			} else if (toolUses.length !== advisors.length || stop !== "tool_use") {
				deps.onEvent?.({
					kind: "advisor_dropped_with_siblings",
					round: rounds + 1,
				});
				flushRecs(withoutAdvisor(), acc);
			} else {
				return { kind: "round", recs: order, advisor: advisors[0], acc };
			}
			if (rounds === 0) {
				out(frame.raw);
				terminal = "raw";
			} else {
				emitTerminal();
				terminal = "synthetic";
				return { kind: "end" };
			}
			return undefined;
		};

		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (life.signal.aborted) throw new LifeEnded("life ended");
				const frames = done ? parser.flush() : parser.push(value);
				for (const frame of frames) {
					const result = handle(frame);
					if (result) return result;
				}
				if (done) break;
			}
		} catch (err) {
			if (err instanceof LifeEnded || life.signal.aborted)
				throw new LifeEnded("life ended", { cause: err });
			if (terminal === undefined) flushRecs(withoutAdvisor(), acc);
			// A continuation failing mid-body is a continuation failure (R8):
			// the client already holds this message, so end it with an event.
			if (rounds > 0) return { kind: "end", truncated: true };
			throw err;
		}
		// Upstream closed. Without a delta nothing was decided: flush what we
		// hold (minus the advisor call) and let the stream end as it ended.
		if (terminal === undefined) {
			flushRecs(withoutAdvisor(), acc);
			return { kind: "end", truncated: true };
		}
		return { kind: "end" };
	};

	// ---- one advisor round ---------------------------------------------
	const runAdvisorOutcome = async (
		round: number,
		inflight: AnthropicBlock[],
	): Promise<AdvisorOutcome> => {
		const roundCtl = new AbortController();
		const signal = AbortSignal.any([life.signal, roundCtl.signal]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const startedAt = Date.now();
		deps.onEvent?.({ kind: "advisor_round_started", round });
		let outcome: AdvisorOutcome;
		try {
			const result = await withPings(
				Promise.race([
					Promise.resolve().then(() =>
						deps.runAdvisor({
							round,
							inflightAssistantContent: inflight,
							signal,
						}),
					),
					timedOut,
				]),
			);
			if (result === "timeout") {
				roundCtl.abort();
				outcome = errorOutcome("execution_time_exceeded", deps.advisorModel);
			} else {
				outcome = result;
			}
		} catch (err) {
			if (err instanceof LifeEnded) throw err;
			outcome = errorOutcome("unavailable", deps.advisorModel);
		} finally {
			if (timer) clearTimeout(timer);
		}
		const content = outcome.content;
		deps.onEvent?.({
			kind: "advisor_round_finished",
			round,
			outcome: content.type,
			errorCode:
				content.type === "advisor_tool_result_error"
					? content.error_code
					: undefined,
			durationMs: Date.now() - startedAt,
		});
		return outcome;
	};

	const failContinuation = async (
		round: number,
		response: Response | undefined,
	): Promise<void> => {
		deps.onEvent?.({
			kind: "continuation_failed",
			round,
			status: response?.status,
		});
		closeOpenBlocks();
		let error: Json | undefined;
		if (response) {
			try {
				const text = await Promise.race([readCapped(response), lifeEnded]);
				const parsed = JSON.parse(text);
				if (
					parsed?.type === "error" &&
					parsed.error &&
					typeof parsed.error.type === "string" &&
					typeof parsed.error.message === "string"
				) {
					error = {
						type: parsed.error.type,
						message: parsed.error.message,
					};
				}
			} catch (err) {
				if (err instanceof LifeEnded) throw err;
			}
		}
		emitError(
			error ?? {
				type: "api_error",
				message: response
					? `Advisor continuation failed with upstream status ${response.status}`
					: "Advisor continuation request failed",
			},
		);
	};

	// ---- main loop -------------------------------------------------------
	const runAll = async (): Promise<void> => {
		let reader = upstream.getReader();
		currentReader = reader;
		let callNo = 1;
		for (;;) {
			const result = await readCall(reader);
			if (result.kind === "end") {
				if (result.truncated && rounds > 0) {
					deps.onEvent?.({ kind: "continuation_failed", round: rounds });
					closeOpenBlocks();
					emitError({
						type: "api_error",
						message: "Advisor continuation ended before the response completed",
					});
				}
				return;
			}
			releaseUpstream();

			const { recs, advisor } = result;
			rounds++;
			const round = rounds;
			const idx = recs.indexOf(advisor);
			// Blocks before the advisor call reach the client now, so the
			// advisor round sees exactly what the client has been sent. The
			// advisor takes no input, so any further advisor calls in the same
			// message are duplicates of this one and are dropped.
			flushRecs(
				recs.slice(0, idx).filter((r) => !r.isAdvisor),
				result.acc,
			);
			const inflightBefore = [...sent];
			const callId =
				typeof advisor.start?.id === "string" ? advisor.start.id : "";
			const emulatedId = emulatedAdvisorIdFromCallId(callId);
			const serverToolUse: AnthropicBlock = {
				type: "server_tool_use",
				id: emulatedId,
				name: ADVISOR_SERVER_TOOL_NAME,
				input: {},
			};
			emitBlock(serverToolUse, "{}");
			sent.push(serverToolUse);

			const workerCapReached = callNo >= maxWorkerCalls;
			let outcome: AdvisorOutcome;
			if (advisorSubcalls >= maxAdvisorCalls || workerCapReached) {
				deps.onEvent?.({
					kind: "caps_reached",
					advisorCalls: advisorSubcalls,
					workerCalls: callNo,
				});
				outcome = errorOutcome("max_uses_exceeded", deps.advisorModel);
			} else {
				advisorSubcalls++;
				outcome = await runAdvisorOutcome(round, inflightBefore);
			}

			const resultBlock: AnthropicBlock = {
				type: "advisor_tool_result",
				tool_use_id: emulatedId,
				content: outcome.content,
			};
			emitBlock(resultBlock);
			sent.push(resultBlock);
			if (outcome.usage) {
				iterations.push({
					type: "advisor_message",
					model: outcome.model,
					...pickTokens(outcome.usage as unknown as Json),
				});
			}
			// Blocks the worker emitted after the advisor call (rare) follow
			// the pair so the message stays in worker order around it.
			flushRecs(
				recs.slice(idx + 1).filter((r) => !r.isAdvisor),
				result.acc,
			);

			if (workerCapReached) {
				emitTerminal("end_turn");
				return;
			}

			let response: Response;
			try {
				response = await withPings(
					Promise.resolve().then(() =>
						deps.runContinuation({
							round,
							inflightAssistantContent: [...sent],
							signal: life.signal,
						}),
					),
				);
			} catch (err) {
				if (err instanceof LifeEnded) throw err;
				await failContinuation(round, undefined);
				return;
			}
			if (!response.ok || !response.body) {
				await failContinuation(round, response);
				return;
			}
			reader = response.body.getReader();
			currentReader = reader;
			callNo++;
		}
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
			const onAbort = (): void => {
				endLife(deps.signal?.reason);
				finish();
			};
			if (deps.signal?.aborted) {
				onAbort();
				upstream.cancel().catch(() => {});
				return;
			}
			deps.signal?.addEventListener("abort", onAbort, { once: true });
			void runAll()
				.then(finish)
				.catch((err) => {
					if (err instanceof LifeEnded || life.signal.aborted) {
						finish();
						return;
					}
					if (!closed) {
						closed = true;
						try {
							controller.error(err);
						} catch {
							// already closed
						}
					}
				})
				.finally(() => {
					deps.signal?.removeEventListener("abort", onAbort);
					releaseUpstream();
				});
		},
		cancel(reason) {
			closed = true;
			endLife(reason);
		},
	});
}

async function readCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		bytes += value.length;
		text += decoder.decode(value, { stream: true });
		if (bytes > MAX_ERROR_BODY_BYTES) {
			reader.cancel().catch(() => {});
			break;
		}
	}
	return text;
}
