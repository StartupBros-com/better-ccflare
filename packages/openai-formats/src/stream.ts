import { Logger } from "@better-ccflare/logger";
import type { TransformStreamContext } from "./types";
import { normalizeOpenAIInputUsage } from "./usage";
import { repairTruncatedToolJson } from "./utils";

const log = new Logger("openai-formats");

const SAFE_STREAM_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_STREAM_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STREAM_ERROR_MESSAGE_LENGTH = 1_024;

export interface TransformStreamingResponseOptions {
	contextWindowForModel?: (model: string) => number | undefined;
}

/**
 * Sanitize headers by removing provider-specific headers
 */
export function sanitizeHeaders(headers: Headers): Headers {
	const sanitized = new Headers();

	for (const [key, value] of headers.entries()) {
		// Skip provider-specific headers
		if (
			!key.startsWith("x-ratelimit-") &&
			!key.startsWith("openai-") &&
			key !== "access-control-expose-headers"
		) {
			sanitized.set(key, value);
		}
	}

	// Add back important headers that should be preserved
	sanitized.set(
		"content-type",
		headers.get("content-type") || "application/json",
	);

	return sanitized;
}

/**
 * Emit a single content_block_delta event with the complete accumulated JSON.
 * Mirrors qwen-code's StreamingToolCallParser: buffer all chunks, emit at stream end.
 */
function emitToolCallJson(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	index: number,
	accumulated: string,
) {
	const repair = repairTruncatedToolJson(accumulated);
	const finalJson = accumulated + repair;

	// Validate the result is parseable JSON
	try {
		JSON.parse(finalJson);
	} catch {
		log.warn(
			`Tool call JSON at index ${index} still invalid after repair: ${finalJson.slice(0, 200)}`,
		);
	}

	const contentBlockDelta = {
		type: "content_block_delta",
		index,
		delta: {
			type: "input_json_delta",
			partial_json: finalJson,
		},
	};
	controller.enqueue(encoder.encode(`event: content_block_delta\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(contentBlockDelta)}\n\n`),
	);
}

/**
 * Emit content_block_stop, message_delta, and message_stop events.
 * Shared between [DONE] handler and flush handler.
 *
 * @param endTurnBlockIndex - Anthropic block index to close when stopReason is "end_turn".
 *   May be a text block or a thinking block depending on the stream pattern.
 *   Tool-call responses close every block (see emitToolCallBlocks and
 *   replayDeferredBlocks) before calling this, so nothing is closed here.
 */
function emitStreamEnd(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	contextWindowSize: number | undefined,
	stopReason: "tool_use" | "end_turn",
	promptTokens: number | undefined,
	completionTokens: number,
	cacheReadInputTokens: number | undefined,
	cacheCreationInputTokens: number | undefined,
	endTurnBlockIndex = 0,
) {
	const normalizedInput = normalizeOpenAIInputUsage(
		promptTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
	);

	if (stopReason === "end_turn") {
		// Text or thinking block — use the assigned Anthropic block index
		const contentBlockStop = {
			type: "content_block_stop",
			index: endTurnBlockIndex,
		};
		controller.enqueue(
			encoder.encode(`event: content_block_stop
`),
		);
		controller.enqueue(
			encoder.encode(`data: ${JSON.stringify(contentBlockStop)}

`),
		);
	}

	// Send message_delta with appropriate stop_reason
	const advertisedContextWindow =
		typeof promptTokens === "number" &&
		Number.isFinite(promptTokens) &&
		promptTokens >= 0 &&
		typeof contextWindowSize === "number" &&
		Number.isFinite(contextWindowSize) &&
		contextWindowSize > 0
			? contextWindowSize
			: undefined;
	const messageDelta = {
		type: "message_delta",
		delta: {
			stop_reason: stopReason,
			stop_sequence: null,
		},
		usage: {
			input_tokens: normalizedInput.inputTokens,
			output_tokens: completionTokens,
			...(normalizedInput.cacheReadInputTokens !== undefined
				? { cache_read_input_tokens: normalizedInput.cacheReadInputTokens }
				: {}),
			...(normalizedInput.cacheCreationInputTokens !== undefined
				? {
						cache_creation_input_tokens:
							normalizedInput.cacheCreationInputTokens,
					}
				: {}),
		},
		...(advertisedContextWindow
			? {
					context_window: {
						current_usage: {
							input_tokens: normalizedInput.inputTokens,
							cache_read_input_tokens:
								normalizedInput.cacheReadInputTokens ?? 0,
							cache_creation_input_tokens:
								normalizedInput.cacheCreationInputTokens ?? 0,
						},
						context_window_size: advertisedContextWindow,
					},
				}
			: {}),
	};
	controller.enqueue(encoder.encode(`event: message_delta\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`),
	);

	// Send message_stop
	const messageStop = {
		type: "message_stop",
	};
	controller.enqueue(encoder.encode(`event: message_stop\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`),
	);
}

function emitMessageStart(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
): void {
	if (context.hasSentStart) return;
	context.hasSentStart = true;
	const messageStart = {
		type: "message_start",
		message: {
			id: `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			content: [],
			model: context.extractedModel,
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
			},
		},
	};
	controller.enqueue(encoder.encode(`event: message_start\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(messageStart)}\n\n`),
	);
	const ping = { type: "ping" };
	controller.enqueue(encoder.encode(`event: ping\n`));
	controller.enqueue(encoder.encode(`data: ${JSON.stringify(ping)}\n\n`));
}

function emitContentBlockStop(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	index: number,
): void {
	const contentBlockStop = { type: "content_block_stop", index };
	controller.enqueue(encoder.encode(`event: content_block_stop\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`),
	);
}

function closeOpenBlock(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
): void {
	if (!context.openBlock) return;
	emitContentBlockStop(controller, encoder, context.openBlock.index);
	context.openBlock = null;
}

function emitContentBlockStart(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	index: number,
	kind: "thinking" | "text",
): void {
	const contentBlockStart = {
		type: "content_block_start",
		index,
		content_block:
			kind === "thinking"
				? { type: "thinking", thinking: "" }
				: { type: "text", text: "" },
	};
	controller.enqueue(encoder.encode(`event: content_block_start\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(contentBlockStart)}\n\n`),
	);
}

function emitContentBlockDelta(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	index: number,
	kind: "thinking" | "text",
	value: string,
): void {
	const contentBlockDelta = {
		type: "content_block_delta",
		index,
		delta:
			kind === "thinking"
				? { type: "thinking_delta", thinking: value }
				: { type: "text_delta", text: value },
	};
	controller.enqueue(encoder.encode(`event: content_block_delta\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(contentBlockDelta)}\n\n`),
	);
}

/**
 * Emit a thinking or text delta, opening a fresh block at the next monotonic
 * index whenever the open block is of the other kind (or none is open).
 * Reasoning providers can switch back and forth within one response (e.g. a
 * leading "\n" of content, then reasoning, then the answer). A delta must never
 * target a block that was already stopped: Claude Code aborts the stream on it.
 *
 * Once a tool_use block has started it stays open until its buffered arguments
 * are emitted at stream end, and an Anthropic stream completes each block
 * before the next one starts, so thinking/text arriving after that point is
 * deferred and replayed by replayDeferredBlocks after the tool blocks close.
 */
function emitContentDelta(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
	kind: "thinking" | "text",
	value: string,
): void {
	if (Object.keys(context.toolCallBlockIndices).length > 0) {
		const last = context.deferredBlocks.at(-1);
		if (last?.kind === kind) {
			last.content += value;
		} else {
			context.deferredBlocks.push({ kind, content: value });
		}
		return;
	}

	if (context.openBlock?.kind !== kind) {
		closeOpenBlock(controller, encoder, context);
		const index = context.nextBlockIndex++;
		context.openBlock = { kind, index };
		emitContentBlockStart(controller, encoder, index, kind);
	}

	emitContentBlockDelta(
		controller,
		encoder,
		context.openBlock.index,
		kind,
		value,
	);
}

/**
 * tool_use blocks as [openaiIdx, anthropicIdx] pairs in Anthropic block order.
 * Object iteration order is OpenAI tool_call index order, which only matches
 * block (arrival) order when the provider numbers its tool calls ascending.
 */
function toolCallBlocksInOrder(
	context: TransformStreamContext,
): Array<[number, number]> {
	return Object.entries(context.toolCallBlockIndices)
		.map(([openaiIdx, anthropicIdx]): [number, number] => [
			Number.parseInt(openaiIdx, 10),
			anthropicIdx,
		])
		.sort((a, b) => a[1] - b[1]);
}

/**
 * Emit each tool_use block's buffered JSON and close it, in block order. Uses
 * Anthropic block indices (from toolCallBlockIndices), not OpenAI tool_call
 * indices.
 */
function emitToolCallBlocks(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
): void {
	for (const [openaiIdx, anthropicIdx] of toolCallBlocksInOrder(context)) {
		const accumulated = context.toolCallAccumulators[openaiIdx] || "";
		emitToolCallJson(controller, encoder, anthropicIdx, accumulated);
		emitContentBlockStop(controller, encoder, anthropicIdx);
	}
}

/**
 * Replay thinking/text deferred behind open tool_use blocks as fresh,
 * sequential blocks (start, one delta, stop each). Call only after every
 * tool_use block has been closed.
 */
function replayDeferredBlocks(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
): void {
	for (const { kind, content } of context.deferredBlocks) {
		const index = context.nextBlockIndex++;
		emitContentBlockStart(controller, encoder, index, kind);
		emitContentBlockDelta(controller, encoder, index, kind, content);
		emitContentBlockStop(controller, encoder, index);
	}
	context.deferredBlocks = [];
}

function emitStreamError(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	context: TransformStreamContext,
	errorValue: unknown,
): void {
	if (context.terminalErrorSeen) return;
	emitMessageStart(controller, encoder, context);

	// Close any blocks that were opened before the provider reported the error
	// and replay content held behind them, so every block is complete before
	// the error; never follow the error with a synthetic message_delta/
	// message_stop pair.
	closeOpenBlock(controller, encoder, context);
	for (const [, anthropicIndex] of toolCallBlocksInOrder(context)) {
		emitContentBlockStop(controller, encoder, anthropicIndex);
	}
	replayDeferredBlocks(controller, encoder, context);

	const error =
		typeof errorValue === "object" && errorValue !== null
			? (errorValue as Record<string, unknown>)
			: {};
	const rawType = typeof error.type === "string" ? error.type : "";
	const type = SAFE_STREAM_ERROR_TYPE.test(rawType) ? rawType : "api_error";
	const rawMessage = typeof error.message === "string" ? error.message : "";
	const message =
		rawMessage.slice(0, MAX_STREAM_ERROR_MESSAGE_LENGTH) ||
		"Upstream provider error";
	const rawCode = typeof error.code === "string" ? error.code : "";
	const code = SAFE_STREAM_ERROR_CODE.test(rawCode) ? rawCode : undefined;
	const payload = {
		type: "error",
		error: {
			type,
			message,
			...(code ? { code } : {}),
		},
	};
	controller.enqueue(encoder.encode(`event: error\n`));
	controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
	context.terminalErrorSeen = true;
}

/**
 * Transform OpenAI Server-Sent Events (SSE) streaming response to Anthropic SSE format.
 *
 * Tool call handling mirrors qwen-code's StreamingToolCallParser:
 * ALL argument chunks are buffered (appended), no deltas are emitted during streaming.
 * The complete accumulated JSON is emitted as a single input_json_delta at [DONE] or flush.
 */
export function transformStreamingResponse(
	response: Response,
	options: TransformStreamingResponseOptions = {},
): Response {
	if (!response.body) {
		return response;
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	// Use pipeThrough to transform the stream while preserving clonability.
	// Streaming state lives in this closure variable (rather than `this` on the
	// handler object) so it can be fully typed without `any` — the DOM lib's
	// Transformer callbacks don't allow attaching arbitrary properties to `this`.
	let streamContext: TransformStreamContext | null = null;
	const transformedBody = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(_controller) {
				// Initialize context object for streaming state
				streamContext = {
					buffer: "",
					hasStarted: false,
					extractedModel: "unknown",
					contextWindowSize: undefined,
					hasSentStart: false,
					openBlock: null,
					deferredBlocks: [],
					promptTokens: undefined,
					completionTokens: 0,
					encounteredToolCall: false,
					terminalErrorSeen: false,
					toolCallAccumulators: {},
					nextBlockIndex: 0,
					toolCallBlockIndices: {},
					maxToolCallLength: 1_000_000,
					maxToolCallIndex: 100,
				};
			},
			transform(chunk, controller) {
				try {
					if (!streamContext) {
						log.error("TransformStream context not initialized");
						return;
					}
					// Bind to a non-null local so TypeScript's null-narrowing holds for
					// the rest of this call. The outer `streamContext` is itself
					// reassigned later in this same function (on [DONE]) and in
					// `flush`, which would otherwise widen it back to `T | null` at
					// every use below.
					const context = streamContext;
					// Decode the chunk and add to buffer
					context.buffer += decoder.decode(chunk, { stream: true });
					const lines = context.buffer.split("\n");
					// Keep incomplete line in buffer
					context.buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed?.startsWith("data:")) continue;

						const dataStr = trimmed.slice(5).trim();

						// Handle [DONE] marker
						if (dataStr === "[DONE]") {
							if (context.terminalErrorSeen) {
								streamContext = null;
								continue;
							}
							if (context.encounteredToolCall) {
								// Close a live thinking/text block (only possible when no
								// tool block was actually opened), emit buffered JSON and
								// stop for each tool block, then replay thinking/text that
								// was deferred behind the tool blocks.
								closeOpenBlock(controller, encoder, context);
								emitToolCallBlocks(controller, encoder, context);
								replayDeferredBlocks(controller, encoder, context);
								emitStreamEnd(
									controller,
									encoder,
									context.contextWindowSize,
									"tool_use",
									context.promptTokens,
									context.completionTokens,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
								);
							} else if (context.openBlock) {
								// emitStreamEnd closes the open thinking/text block via its
								// end_turn branch; every earlier block was closed on switch.
								emitStreamEnd(
									controller,
									encoder,
									context.contextWindowSize,
									"end_turn",
									context.promptTokens,
									context.completionTokens,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
									context.openBlock.index,
								);
								context.openBlock = null;
							}

							// Cleanup entire context after stream completion
							streamContext = null;
							continue;
						}

						// Parse OpenAI chunk
						try {
							const data = JSON.parse(dataStr);
							if (context.terminalErrorSeen) continue;

							// Extract model from first chunk
							if (!context.hasStarted && typeof data.model === "string") {
								context.extractedModel = data.model;
								context.contextWindowSize = options.contextWindowForModel?.(
									data.model,
								);
								context.hasStarted = true;
							}

							// OpenAI-compatible providers can send an error object inside an
							// nominally successful SSE transport. Surface it as an Anthropic
							// terminal error instead of manufacturing a normal completion.
							if (data.error !== null && typeof data.error === "object") {
								emitStreamError(controller, encoder, context, data.error);
								continue;
							}

							// Extract usage data if present (typically in last chunk before [DONE])
							if (data.usage) {
								if (data.usage.prompt_tokens !== undefined) {
									context.promptTokens = data.usage.prompt_tokens;
								}
								if (data.usage.completion_tokens !== undefined) {
									context.completionTokens = data.usage.completion_tokens;
								}
								// Extract cache statistics from prompt_tokens_details (Qwen/DashScope)
								if (data.usage.prompt_tokens_details) {
									const details = data.usage.prompt_tokens_details as {
										cache_creation_input_tokens?: number;
										cached_tokens?: number;
									};
									if (details.cache_creation_input_tokens !== undefined) {
										context.cacheCreationInputTokens =
											details.cache_creation_input_tokens;
									}
									if (details.cached_tokens !== undefined) {
										context.cacheReadInputTokens = details.cached_tokens;
									}
								}
							}

							// Send message_start on the first ordinary chunk.
							emitMessageStart(controller, encoder, context);

							const delta = data.choices?.[0]?.delta;

							// Handle tool call deltas — always buffer, never emit
							if (delta?.tool_calls) {
								for (const toolCall of delta.tool_calls) {
									context.encounteredToolCall = true;
									const idx = toolCall.index;

									// Validate tool call index bounds
									if (
										typeof idx !== "number" ||
										idx < 0 ||
										idx >= context.maxToolCallIndex
									) {
										log.warn(
											`Invalid tool call index: ${idx} (max: ${context.maxToolCallIndex})`,
										);
										continue;
									}

									// Send content_block_start on first tool call chunk.
									// Assign a monotonic Anthropic block index — do NOT reuse the
									// OpenAI tool_call delta index, which always starts at 0 and
									// would collide with a text content block also at index 0.
									if (context.toolCallAccumulators[idx] === undefined) {
										if (!toolCall.id || !toolCall.function?.name) {
											log.warn(
												`Missing tool call id or name for index: ${idx}`,
											);
											continue;
										}
										// Close the open thinking/text block before the tool block
										closeOpenBlock(controller, encoder, context);
										context.toolCallAccumulators[idx] = "";
										const anthropicBlockIdx = context.nextBlockIndex++;
										context.toolCallBlockIndices[idx] = anthropicBlockIdx;
										const contentBlockStart = {
											type: "content_block_start",
											index: anthropicBlockIdx,
											content_block: {
												type: "tool_use",
												id: toolCall.id,
												name: toolCall.function.name,
												input: {},
											},
										};
										controller.enqueue(
											encoder.encode(`event: content_block_start\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(contentBlockStart)}\n\n`,
											),
										);
									}

									// Buffer argument chunk (mirrors qwen-code's StreamingToolCallParser:
									// currentBuffer + chunk, emit complete JSON at stream end)
									const newArgs = toolCall.function?.arguments || "";
									if (newArgs.length > context.maxToolCallLength) {
										log.warn(
											`Tool call arguments exceed max length for index ${idx} (${newArgs.length}/${context.maxToolCallLength})`,
										);
										continue;
									}
									context.toolCallAccumulators[idx] =
										(context.toolCallAccumulators[idx] || "") + newArgs;
								}
							} else {
								// reasoning_content and content can coexist in one delta — handle both
								if (delta?.reasoning_content) {
									emitContentDelta(
										controller,
										encoder,
										context,
										"thinking",
										delta.reasoning_content,
									);
								}
								if (delta?.content) {
									emitContentDelta(
										controller,
										encoder,
										context,
										"text",
										delta.content,
									);
								}
							}
						} catch (_parseError) {
							// Ignore JSON parse errors for malformed chunks
						}
					}
				} catch (error) {
					log.error("Error in transform:", error);
				}
			},
			flush(controller) {
				if (!streamContext) return;
				// Bind to a non-null local so TypeScript's null-narrowing holds for
				// the rest of this call (see `transform` above for why).
				const context = streamContext;
				if (context.terminalErrorSeen) {
					streamContext = null;
					return;
				}

				// Stream ended without [DONE] (e.g. timeout/truncation).
				// Emit buffered JSON + stop events so the client gets a valid response.
				if (
					context.encounteredToolCall &&
					Object.keys(context.toolCallAccumulators).length > 0
				) {
					log.warn(
						"Stream terminated without [DONE] — emitting buffered tool calls + stop events",
					);
					closeOpenBlock(controller, encoder, context);
					emitToolCallBlocks(controller, encoder, context);
					replayDeferredBlocks(controller, encoder, context);
					emitStreamEnd(
						controller,
						encoder,
						context.contextWindowSize,
						"tool_use",
						context.promptTokens,
						context.completionTokens,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
					);
				} else if (context.openBlock) {
					log.warn(
						"Stream terminated without [DONE] — closing last open block",
					);
					// emitStreamEnd closes the block via end_turn branch — no manual emit needed
					emitStreamEnd(
						controller,
						encoder,
						context.contextWindowSize,
						"end_turn",
						context.promptTokens,
						context.completionTokens,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
						context.openBlock.index,
					);
					context.openBlock = null;
				}

				streamContext = null;
			},
		}),
	);

	return new Response(transformedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: sanitizeHeaders(response.headers),
	});
}
