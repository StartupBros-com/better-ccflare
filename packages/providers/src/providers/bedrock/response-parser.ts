import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockResponseParser");

export interface BedrockUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheWriteInputTokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_write_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export interface NormalizedBedrockUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

function normalizeTokenCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/**
 * Normalize native Bedrock and Claude-compatible usage payloads into one
 * cache-aware contract. Bedrock inputTokens contains uncached input only when
 * prompt caching is active, so cache reads and writes must be added exactly
 * once to obtain promptTokens.
 */
export function normalizeBedrockUsage(
	usage: BedrockUsage,
): NormalizedBedrockUsage {
	const inputTokens = normalizeTokenCount(
		usage.inputTokens ?? usage.input_tokens,
	);
	const outputTokens = normalizeTokenCount(
		usage.outputTokens ?? usage.output_tokens,
	);
	const cacheReadInputTokens = normalizeTokenCount(
		usage.cacheReadInputTokens ?? usage.cache_read_input_tokens,
	);
	const cacheCreationInputTokens = normalizeTokenCount(
		usage.cacheWriteInputTokens ??
			usage.cache_write_input_tokens ??
			usage.cache_creation_input_tokens,
	);
	const promptTokens =
		inputTokens + cacheReadInputTokens + cacheCreationInputTokens;

	return {
		inputTokens,
		outputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		promptTokens,
		completionTokens: outputTokens,
		totalTokens: promptTokens + outputTokens,
	};
}

/**
 * Bedrock Converse API response structure
 *
 * This represents the raw response from Bedrock's Converse API.
 * Phase 4 transforms this to Claude Messages API format for client compatibility.
 */
export interface BedrockConverseResponse {
	output: {
		message: {
			role: string;
			content: Array<{ type: string; text?: string; [key: string]: unknown }>;
		};
	};
	stopReason: string;
	usage?: BedrockUsage;
	model?: string;
}

/**
 * Transform Bedrock Converse response to Claude Messages API format
 *
 * Converts raw Bedrock JSON response to strict Claude Messages API compatibility.
 * This transformation enables clients to consume Bedrock responses identically
 * to native Claude API responses.
 *
 * Transformation mapping:
 * - output.message.content → content (1:1 array mapping, preserves text and tool blocks)
 * - stopReason → stop_reason
 * - usage.inputTokens → usage.input_tokens
 * - usage.outputTokens → usage.output_tokens
 * - AWS-specific metadata dropped entirely (no additionalModelResponseFields, metrics.latencyMs)
 *
 * Error handling:
 * - Falls back to original response on transformation errors (graceful degradation)
 * - Logs transformation errors for debugging
 * - Clones response to preserve body for retry/logging
 *
 * @param response - Bedrock Converse API response (application/json)
 * @returns Response with Claude Messages API format body
 *
 * Example input (Bedrock):
 * ```json
 * {
 *   "output": {
 *     "message": {
 *       "role": "assistant",
 *       "content": [{ "type": "text", "text": "Hello" }]
 *     }
 *   },
 *   "stopReason": "end_turn",
 *   "usage": { "inputTokens": 10, "outputTokens": 5 }
 * }
 * ```
 *
 * Example output (Claude):
 * ```json
 * {
 *   "id": "msg_1770381324000",
 *   "type": "message",
 *   "role": "assistant",
 *   "content": [{ "type": "text", "text": "Hello" }],
 *   "model": "claude-3-5-sonnet-20241022",
 *   "stop_reason": "end_turn",
 *   "usage": { "input_tokens": 10, "output_tokens": 5 }
 * }
 * ```
 */
export async function transformNonStreamingResponse(
	response: Response,
): Promise<Response> {
	try {
		// Clone response to avoid consuming body (preserves for retry/logging)
		const clone = response.clone();
		const json = (await clone.json()) as BedrockConverseResponse;

		// Extract fields from Bedrock format
		const content = json.output?.message?.content || [];
		const stopReason = json.stopReason;
		const usage = json.usage;
		const normalizedUsage = usage ? normalizeBedrockUsage(usage) : undefined;

		// Transform to Claude Messages API format
		const claudeResponse = {
			id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
			type: "message",
			role: "assistant",
			content: content, // 1:1 mapping, preserve as-is
			model: json.model || "claude-bedrock",
			stop_reason: stopReason,
			usage: normalizedUsage
				? {
						input_tokens: normalizedUsage.inputTokens,
						output_tokens: normalizedUsage.outputTokens,
						cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
						cache_creation_input_tokens:
							normalizedUsage.cacheCreationInputTokens,
					}
				: undefined,
		};

		// Return new Response with transformed JSON body
		return new Response(JSON.stringify(claudeResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		// Graceful degradation: return original response on transformation error
		log.error(
			`Failed to transform Bedrock response: ${(error as Error).message}`,
		);
		return response;
	}
}
