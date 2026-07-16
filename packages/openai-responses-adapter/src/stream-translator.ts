import {
	BUFFER_SIZES,
	SseFrameBuffer,
	SseLimitError,
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
	textByBlock: Map<number, { text: string; bytes: number }>;
	toolByBlock: Map<
		number,
		{ callId: string; name: string; argsBuf: string; bytes: number }
	>;
	inputTokens: number;
	outputTokens: number;
	doneSent: boolean;
	outputItems: Array<Record<string, unknown>>;
	streamError: { type: string; message: string } | null;
}

const encoder = new TextEncoder();

// Per-block cap on accumulated bytes, shared by both tool-call arguments and
// text output. Reuses the same constant as the SSE frame cap instead of
// introducing a new arbitrary number. An aggregate cap across concurrently
// open blocks is deliberately out of scope here, unlike the codex
// provider's stricter aggregate accounting.
const TOOL_ARGS_BYTE_CAP = BUFFER_SIZES.SSE_FRAME_MAX_BYTES;

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
			state.textByBlock.set(blockIndex, { text: "", bytes: 0 });
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
				block.bytes += encoder.encode(text).length;
				if (block.bytes > TOOL_ARGS_BYTE_CAP) {
					throw new SseLimitError(
						`Text output for block index ${blockIndex} totaled ${block.bytes} bytes, exceeding the ${TOOL_ARGS_BYTE_CAP} byte cap`,
						TOOL_ARGS_BYTE_CAP,
						block.bytes,
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
				tool.bytes += encoder.encode(partial).length;
				if (tool.bytes > TOOL_ARGS_BYTE_CAP) {
					throw new SseLimitError(
						`Tool call arguments for call_id ${tool.callId} totaled ${tool.bytes} bytes, exceeding the ${TOOL_ARGS_BYTE_CAP} byte cap`,
						TOOL_ARGS_BYTE_CAP,
						tool.bytes,
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
		} else if (state.toolByBlock.has(blockIndex)) {
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
 * any SseLimitError raised by processEvent (e.g. a tool-argument cap trip)
 * is intentionally left to propagate to the caller, which routes it through
 * the terminal error/cancellation path instead of being logged and ignored.
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
		maxFrameBytes: BUFFER_SIZES.SSE_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_BUFFER_MAX_BYTES,
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
	};

	/**
	 * Handle an SseLimitError raised while parsing or processing frames: emit
	 * a terminal response.failed event, then actively terminate the
	 * TransformStream. Terminating errors the writable side, which causes the
	 * upstream pipeTo() (feeding anthropicResponse.body into this transform)
	 * to cancel the source reader rather than leaving it dangling. A failed
	 * stream must never emit response.completed afterward: emitDone() already
	 * no-ops once state.doneSent is set by the "error" branch of
	 * processEvent, and flush() never runs once the writable side is errored.
	 */
	function handleLimitError(
		error: SseLimitError,
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
					if (err instanceof SseLimitError) {
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
					if (err instanceof SseLimitError) {
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
