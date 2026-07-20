import {
	BUFFER_SIZES,
	SseFrameBuffer,
	StreamResourceLimitError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("openai-responses-adapter");

interface State {
	hasSentCreated: boolean;
	responseId: string;
	model: string;
	outputIndex: number;
	sequenceNumber: number;
	blockIndexToOutput: Map<number, number>;
	textByBlock: Map<number, { text: string }>;
	toolByBlock: Map<
		number,
		{ callId: string; name: string; argsBuf: string; bytes: number }
	>;
	inputTokens: number;
	outputTokens: number;
	doneSent: boolean;
	outputItems: Array<Record<string, unknown>>;
	streamError: { type: string; message: string } | null;
	/**
	 * Monotonic cumulative byte total of translated output (every text delta
	 * plus every tool-argument delta actually emitted downstream) produced
	 * for this stream so far. Unlike the per-block byte counts in
	 * textByBlock/toolByBlock, this total is never decremented when a
	 * block's buffer is freed after it closes (see the content_block_stop
	 * handling below): it bounds the whole stream's cumulative translated
	 * output, not any single block's peak size, so freeing one block's
	 * buffer must never let the total shrink back below where a later
	 * block could smuggle additional bytes past the cap.
	 */
	translatedOutputBytesTotal: number;
}

const encoder = new TextEncoder();

// Per-call cap on accumulated tool-call argument bytes for a single
// tool_use block. Text output has no per-block cap of its own: a long,
// legitimately large translated response routinely exceeds this size, so
// bounding it per block would reject ordinary traffic. See
// TRANSLATED_OUTPUT_TOTAL_BYTE_CAP below for the cap that does apply to
// text.
const TOOL_ARGS_PER_CALL_BYTE_CAP =
	BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES;

// Cumulative cap across the whole stream's translated output (every text
// delta plus every tool-argument delta actually emitted downstream),
// independent of any per-block accounting. This is the adapter's analogue
// of the codex provider's aggregate tool-argument cap, but scoped to all
// translated output rather than tool calls only: unlike the codex
// provider, which can have several tool calls open concurrently and no
// long-form text output, this translator's dominant unbounded-growth risk
// is a single very long text block, so the aggregate cap here is
// deliberately not tool-call-specific.
const TRANSLATED_OUTPUT_TOTAL_BYTE_CAP =
	BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES;

function emitSse(
	controller: TransformStreamDefaultController,
	eventType: string,
	data: unknown,
	state: State,
): void {
	const payload = Object.assign(
		{ sequence_number: state.sequenceNumber++ },
		data as object,
	);
	controller.enqueue(
		encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`),
	);
}

function emitDone(
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (state.doneSent) return;
	state.doneSent = true;

	emitSse(
		controller,
		"response.completed",
		{
			type: "response.completed",
			response: {
				id: state.responseId,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				model: state.model,
				status: "completed",
				output: state.outputItems,
				usage: {
					input_tokens: state.inputTokens,
					output_tokens: state.outputTokens,
					total_tokens: state.inputTokens + state.outputTokens,
				},
			},
		},
		state,
	);
}

function processEvent(
	eventType: string,
	data: Record<string, unknown>,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	// First terminal event wins, for every event type: once response.completed
	// (or an earlier response.failed) has been emitted, nothing may follow it.
	// A protocol-violating upstream that keeps sending framed events after
	// message_stop, or a cap trip arriving at flush() time, must not make the
	// terminal event non-terminal. Mirrors the Codex translator's
	// hasSentTerminalEvents pattern; handleLimitError still terminates the
	// stream unconditionally after this returns.
	if (state.doneSent) {
		return;
	}
	if (eventType === "message_start") {
		const message = data.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, number> | undefined;
		if (usage) {
			state.inputTokens = usage.input_tokens ?? 0;
		}

		if (!state.hasSentCreated) {
			state.hasSentCreated = true;
			const createdAt = Math.floor(Date.now() / 1000);
			const responseShape = {
				id: state.responseId,
				object: "response",
				created_at: createdAt,
				model: state.model,
				status: "in_progress",
				output: [],
			};
			emitSse(
				controller,
				"response.created",
				{ type: "response.created", response: responseShape },
				state,
			);
			emitSse(
				controller,
				"response.in_progress",
				{ type: "response.in_progress", response: responseShape },
				state,
			);
		}
		return;
	}

	if (eventType === "content_block_start") {
		const blockIndex = data.index as number;
		const contentBlock = data.content_block as Record<string, unknown>;

		// Only allocate an output slot for block types we emit events for.
		// Incrementing unconditionally (e.g. for "thinking" blocks) leaves gaps in
		// output_index that confuse clients expecting a contiguous sequence.
		if (contentBlock.type !== "text" && contentBlock.type !== "tool_use") {
			return;
		}

		const outputIdx = state.outputIndex++;
		state.blockIndexToOutput.set(blockIndex, outputIdx);

		if (contentBlock.type === "text") {
			state.textByBlock.set(blockIndex, { text: "" });
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: {
						type: "message",
						id: `${state.responseId}_msg_${outputIdx}`,
						role: "assistant",
						content: [],
						status: "in_progress",
					},
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.added",
				{
					type: "response.content_part.added",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
				state,
			);
		} else if (contentBlock.type === "tool_use") {
			state.toolByBlock.set(blockIndex, {
				callId: contentBlock.id as string,
				name: contentBlock.name as string,
				argsBuf: "",
				bytes: 0,
			});
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: {
						type: "function_call",
						id: `${state.responseId}_fc_${outputIdx}`,
						call_id: contentBlock.id as string,
						name: contentBlock.name as string,
						arguments: "",
						status: "in_progress",
					},
				},
				state,
			);
		}
		return;
	}

	if (eventType === "content_block_delta") {
		const blockIndex = data.index as number;
		const delta = data.delta as Record<string, unknown>;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			log.warn(`content_block_delta for unknown block index ${blockIndex}`);
			return;
		}

		if (delta.type === "text_delta") {
			const text = delta.text as string;
			const block = state.textByBlock.get(blockIndex);
			if (block) {
				// No per-block cap for text: only the cumulative
				// translated-output total (checked below) bounds it.
				state.translatedOutputBytesTotal += encoder.encode(text).length;
				if (
					state.translatedOutputBytesTotal > TRANSLATED_OUTPUT_TOTAL_BYTE_CAP
				) {
					throw new StreamResourceLimitError(
						`Translated output total of ${state.translatedOutputBytesTotal} bytes exceeds the ${TRANSLATED_OUTPUT_TOTAL_BYTE_CAP} byte cap`,
						"translated_output_total",
						TRANSLATED_OUTPUT_TOTAL_BYTE_CAP,
						state.translatedOutputBytesTotal,
					);
				}
				block.text += text;

				emitSse(
					controller,
					"response.output_text.delta",
					{
						type: "response.output_text.delta",
						item_id: `${state.responseId}_msg_${outputIdx}`,
						output_index: outputIdx,
						content_index: 0,
						delta: text,
					},
					state,
				);
			}
		} else if (delta.type === "input_json_delta") {
			const partial = (delta.partial_json as string) ?? "";
			const tool = state.toolByBlock.get(blockIndex);
			if (tool) {
				const partialBytes = encoder.encode(partial).length;
				tool.bytes += partialBytes;
				// Per-call cap: guards a single runaway tool call.
				if (tool.bytes > TOOL_ARGS_PER_CALL_BYTE_CAP) {
					throw new StreamResourceLimitError(
						`Tool call arguments for call_id ${tool.callId} totaled ${tool.bytes} bytes, exceeding the ${TOOL_ARGS_PER_CALL_BYTE_CAP} byte cap`,
						"tool_arguments_per_call",
						TOOL_ARGS_PER_CALL_BYTE_CAP,
						tool.bytes,
					);
				}
				// Aggregate cap: guards the whole stream's cumulative
				// translated output (text and tool arguments together), not
				// just this one tool call.
				state.translatedOutputBytesTotal += partialBytes;
				if (
					state.translatedOutputBytesTotal > TRANSLATED_OUTPUT_TOTAL_BYTE_CAP
				) {
					throw new StreamResourceLimitError(
						`Translated output total of ${state.translatedOutputBytesTotal} bytes exceeds the ${TRANSLATED_OUTPUT_TOTAL_BYTE_CAP} byte cap`,
						"translated_output_total",
						TRANSLATED_OUTPUT_TOTAL_BYTE_CAP,
						state.translatedOutputBytesTotal,
					);
				}
				tool.argsBuf += partial;
				emitSse(
					controller,
					"response.function_call_arguments.delta",
					{
						type: "response.function_call_arguments.delta",
						item_id: `${state.responseId}_fc_${outputIdx}`,
						output_index: outputIdx,
						call_id: tool.callId,
						delta: partial,
					},
					state,
				);
			}
		}
		return;
	}

	if (eventType === "content_block_stop") {
		const blockIndex = data.index as number;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			log.warn(`content_block_stop for unknown block index ${blockIndex}`);
			return;
		}

		if (state.textByBlock.has(blockIndex)) {
			const fullText = state.textByBlock.get(blockIndex)?.text ?? "";
			emitSse(
				controller,
				"response.output_text.done",
				{
					type: "response.output_text.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					text: fullText,
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.done",
				{
					type: "response.content_part.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part: { type: "output_text", text: fullText },
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: "message",
				id: `${state.responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [{ type: "output_text", text: fullText }],
				status: "completed",
			};
			state.outputItems.push(doneItem);
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
			// Free this block's buffered text now that it has been captured in
			// doneItem/outputItems above. translatedOutputBytesTotal is
			// deliberately left unchanged: it tracks cumulative stream output,
			// not currently-buffered memory.
			state.textByBlock.delete(blockIndex);
		} else if (state.toolByBlock.has(blockIndex)) {
			// biome-ignore lint/style/noNonNullAssertion: guarded by the has() check above — TS can't narrow Map.get() from a prior has() call.
			const tool = state.toolByBlock.get(blockIndex)!;
			emitSse(
				controller,
				"response.function_call_arguments.done",
				{
					type: "response.function_call_arguments.done",
					item_id: `${state.responseId}_fc_${outputIdx}`,
					output_index: outputIdx,
					call_id: tool.callId,
					name: tool.name,
					arguments: tool.argsBuf,
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: "function_call",
				id: `${state.responseId}_fc_${outputIdx}`,
				call_id: tool.callId,
				name: tool.name,
				arguments: tool.argsBuf,
				status: "completed",
			};
			state.outputItems.push(doneItem);
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
			// Free this call's buffered arguments now that they have been
			// captured in doneItem/outputItems above, mirroring the text-block
			// case just above.
			state.toolByBlock.delete(blockIndex);
		}
		return;
	}

	if (eventType === "message_delta") {
		const usage = data.usage as Record<string, number> | undefined;
		if (usage) {
			state.outputTokens = usage.output_tokens ?? 0;
		}
		return;
	}

	if (eventType === "message_stop") {
		emitDone(controller, state);
		return;
	}

	if (eventType === "error") {
		const err = data.error as Record<string, unknown> | undefined;
		const errType = (err?.type as string) ?? "api_error";
		const errMsg =
			(err?.message as string) ?? "An error occurred during streaming";
		state.streamError = { type: errType, message: errMsg };
		state.doneSent = true;
		emitSse(
			controller,
			"response.failed",
			{
				type: "response.failed",
				response: {
					id: state.responseId,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					model: state.model,
					status: "failed",
					error: { code: errType, message: errMsg },
					output: state.outputItems,
					usage: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						total_tokens: state.inputTokens + state.outputTokens,
					},
				},
			},
			state,
		);
		return;
	}
}

/**
 * Parse and process a single already-delimited SSE frame (the text between
 * two blank-line delimiters, with the delimiters themselves stripped).
 *
 * Only JSON.parse failures are swallowed here (malformed upstream payload):
 * any StreamResourceLimitError raised by processEvent (e.g. a tool-argument
 * or translated-output-total cap trip) is intentionally left to propagate to
 * the caller, which routes it through the terminal error/cancellation path
 * instead of being logged and ignored.
 */
function processSseFrame(
	rawEvent: string,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (!rawEvent.trim()) return;

	const lines = rawEvent.split(/\r?\n/);
	let eventType = "";
	let dataStr = "";

	for (const line of lines) {
		if (line.startsWith("event: ")) {
			eventType = line.slice(7).trim();
		} else if (line.startsWith("data: ")) {
			dataStr = line.slice(6).trim();
		}
	}

	if (!eventType || !dataStr) return;

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(dataStr) as Record<string, unknown>;
	} catch {
		log.warn(
			`Failed to parse SSE data for event ${eventType}: ${dataStr.slice(0, 200)}`,
		);
		return;
	}

	processEvent(eventType, data, controller, state);
}

export function translateAnthropicStreamToResponses(
	anthropicResponse: Response,
	responseId: string,
	model: string,
): Response {
	if (!anthropicResponse.body) {
		return new Response(null, { status: anthropicResponse.status });
	}

	// Bounded, CRLF-tolerant frame buffer (see packages/core/src/sse-frame-buffer.ts).
	// Owns its own TextDecoder internally, so no separate decoder is needed here.
	const sseFrameBuffer = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});

	const state: State = {
		hasSentCreated: false,
		responseId,
		model,
		outputIndex: 0,
		sequenceNumber: 0,
		blockIndexToOutput: new Map(),
		textByBlock: new Map(),
		toolByBlock: new Map(),
		inputTokens: 0,
		outputTokens: 0,
		doneSent: false,
		outputItems: [],
		streamError: null,
		translatedOutputBytesTotal: 0,
	};

	/**
	 * Handle a StreamResourceLimitError (SseLimitError, or a
	 * tool_arguments_per_call/translated_output_total violation raised
	 * directly by processEvent) raised while parsing or processing frames:
	 * emit a terminal response.failed event, then actively terminate the
	 * TransformStream. Terminating errors the writable side, which causes the
	 * upstream pipeTo() (feeding anthropicResponse.body into this transform)
	 * to cancel the source reader rather than leaving it dangling. A failed
	 * stream must never emit response.completed afterward: emitDone() already
	 * no-ops once state.doneSent is set by the "error" branch of
	 * processEvent, and flush() never runs once the writable side is errored.
	 */
	function handleLimitError(
		error: StreamResourceLimitError,
		controller: TransformStreamDefaultController,
	): void {
		processEvent(
			"error",
			{
				type: "error",
				error: { type: "sse_limit_exceeded", message: error.message },
			},
			controller,
			state,
		);
		controller.terminate();
	}

	const transformedBody = anthropicResponse.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				try {
					const frames = sseFrameBuffer.push(chunk);
					for (const frame of frames) {
						processSseFrame(frame, controller, state);
					}
				} catch (err) {
					if (err instanceof StreamResourceLimitError) {
						handleLimitError(err, controller);
						return;
					}
					log.warn(`Stream transform error: ${String(err)}`);
				}
			},

			flush(controller) {
				try {
					const remaining = sseFrameBuffer.flush();
					if (remaining.trim()) {
						processSseFrame(remaining, controller, state);
					}
					// Ensure done event is always emitted
					emitDone(controller, state);
				} catch (err) {
					if (err instanceof StreamResourceLimitError) {
						handleLimitError(err, controller);
						return;
					}
					log.warn(`Stream flush error: ${String(err)}`);
				}
			},
		}),
	);

	return new Response(transformedBody, {
		status: anthropicResponse.status,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
