import type { Citation, ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockResponseParser");

export interface BedrockUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
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
			content: ContentBlock[];
		};
	};
	stopReason: string;
	usage?: BedrockUsage;
	model?: string;
}

type ClaudeResponseContentBlock =
	| { type: "text"; text: string; citations?: ClaudeCitation[] }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

export type ClaudeCitation =
	| {
			type: "char_location";
			cited_text: string;
			document_index: number;
			document_title: string | null;
			file_id: null;
			start_char_index: number;
			end_char_index: number;
	  }
	| {
			type: "page_location";
			cited_text: string;
			document_index: number;
			document_title: string | null;
			file_id: null;
			start_page_number: number;
			end_page_number: number;
	  }
	| {
			type: "content_block_location";
			cited_text: string;
			document_index: number;
			document_title: string | null;
			file_id: null;
			start_block_index: number;
			end_block_index: number;
	  }
	| {
			type: "search_result_location";
			cited_text: string;
			search_result_index: number;
			source: string;
			title: string | null;
			start_block_index: number;
			end_block_index: number;
	  };

type BlockTransformResult =
	| { valid: true; blocks: ClaudeResponseContentBlock[] }
	| { valid: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isSafeIndex(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isCanonicalTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalBedrockUsage(value: unknown): value is BedrockUsage {
	if (!isRecord(value)) return false;
	if (
		!isCanonicalTokenCount(value.inputTokens) ||
		!isCanonicalTokenCount(value.outputTokens) ||
		!isCanonicalTokenCount(value.totalTokens)
	) {
		return false;
	}

	return ["cacheReadInputTokens", "cacheWriteInputTokens"].every(
		(field) =>
			value[field] === undefined || isCanonicalTokenCount(value[field]),
	);
}

const BEDROCK_CITATION_LOCATION_KINDS = new Set([
	"documentChar",
	"documentPage",
	"documentChunk",
	"searchResultLocation",
	"web",
	"$unknown",
]);

function encodeBase64(bytes: number[]): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function normalizeRedactedContent(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Uint8Array) {
		return encodeBase64(Array.from(value));
	}
	if (Array.isArray(value)) {
		return value.every(
			(byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
		)
			? encodeBase64(value)
			: undefined;
	}
	if (!isRecord(value)) return undefined;

	// Uint8Array is serialized by JSON.stringify as an object with numeric keys.
	const entries = Object.entries(value).sort(
		([left], [right]) => Number(left) - Number(right),
	);
	const bytes: number[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const [key, byte] = entries[index];
		if (
			key !== String(index) ||
			!Number.isInteger(byte) ||
			(byte as number) < 0 ||
			(byte as number) > 255
		) {
			return undefined;
		}
		bytes.push(byte as number);
	}
	return encodeBase64(bytes);
}

export function transformBedrockCitation(
	citation: Citation | unknown,
): ClaudeCitation | undefined {
	if (!isRecord(citation) || !Array.isArray(citation.sourceContent)) {
		return undefined;
	}
	const citedTextParts: string[] = [];
	for (const content of citation.sourceContent) {
		if (!isRecord(content) || typeof content.text !== "string") {
			return undefined;
		}
		citedTextParts.push(content.text);
	}
	const citedText = citedTextParts.join("");
	if (!isNonEmptyString(citedText) || !isRecord(citation.location)) {
		return undefined;
	}

	const documentTitle =
		typeof citation.title === "string" ? citation.title : null;
	const { location } = citation;
	const locationKinds = Object.entries(location)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([kind]) => kind);
	if (
		locationKinds.length !== 1 ||
		!BEDROCK_CITATION_LOCATION_KINDS.has(locationKinds[0])
	) {
		return undefined;
	}

	if (locationKinds[0] === "documentChar" && isRecord(location.documentChar)) {
		const { documentIndex, start, end } = location.documentChar;
		if (
			isSafeIndex(documentIndex) &&
			isSafeIndex(start) &&
			isSafeIndex(end) &&
			end > start
		) {
			return {
				type: "char_location",
				cited_text: citedText,
				document_index: documentIndex,
				document_title: documentTitle,
				file_id: null,
				start_char_index: start,
				end_char_index: end,
			};
		}
	}
	if (locationKinds[0] === "documentPage" && isRecord(location.documentPage)) {
		const { documentIndex, start, end } = location.documentPage;
		if (
			isSafeIndex(documentIndex) &&
			isSafeIndex(start, 1) &&
			isSafeIndex(end, 1) &&
			end > start
		) {
			return {
				type: "page_location",
				cited_text: citedText,
				document_index: documentIndex,
				document_title: documentTitle,
				file_id: null,
				start_page_number: start,
				end_page_number: end,
			};
		}
	}
	if (
		locationKinds[0] === "documentChunk" &&
		isRecord(location.documentChunk)
	) {
		const { documentIndex, start, end } = location.documentChunk;
		if (
			isSafeIndex(documentIndex) &&
			isSafeIndex(start) &&
			isSafeIndex(end) &&
			end > start
		) {
			return {
				type: "content_block_location",
				cited_text: citedText,
				document_index: documentIndex,
				document_title: documentTitle,
				file_id: null,
				start_block_index: start,
				end_block_index: end,
			};
		}
	}
	if (
		locationKinds[0] === "searchResultLocation" &&
		isRecord(location.searchResultLocation) &&
		isNonEmptyString(citation.source)
	) {
		const { searchResultIndex, start, end } = location.searchResultLocation;
		if (
			isSafeIndex(searchResultIndex) &&
			isSafeIndex(start) &&
			isSafeIndex(end) &&
			end > start
		) {
			return {
				type: "search_result_location",
				cited_text: citedText,
				search_result_index: searchResultIndex,
				source: citation.source,
				title: documentTitle,
				start_block_index: start,
				end_block_index: end,
			};
		}
	}

	// Bedrock web citations do not carry Anthropic's required encrypted index.
	return undefined;
}

function transformResponseContentBlock(
	block: ContentBlock | unknown,
): BlockTransformResult {
	if (!isRecord(block)) return { valid: false };

	if ("text" in block) {
		return typeof block.text === "string"
			? { valid: true, blocks: [{ type: "text", text: block.text }] }
			: { valid: false };
	}

	if ("toolUse" in block) {
		if (!isRecord(block.toolUse)) return { valid: false };
		const { toolUseId, name, input } = block.toolUse;
		if (
			isNonEmptyString(toolUseId) &&
			isNonEmptyString(name) &&
			typeof input === "object" &&
			input !== null &&
			!Array.isArray(input)
		) {
			return {
				valid: true,
				blocks: [
					{
						type: "tool_use",
						id: toolUseId,
						name,
						input: input as Record<string, unknown>,
					},
				],
			};
		}
		return { valid: false };
	}

	if ("reasoningContent" in block) {
		if (!isRecord(block.reasoningContent)) return { valid: false };
		const reasoning = block.reasoningContent;
		if ("reasoningText" in reasoning) {
			if (!isRecord(reasoning.reasoningText)) return { valid: false };
			const { text, signature } = reasoning.reasoningText;
			if (typeof text !== "string") return { valid: false };
			if (!isNonEmptyString(signature)) {
				return { valid: true, blocks: [] };
			}
			return {
				valid: true,
				blocks: [
					{
						type: "thinking",
						thinking: text,
						signature,
					},
				],
			};
		}
		if ("redactedContent" in reasoning) {
			const data = normalizeRedactedContent(reasoning.redactedContent);
			return data === undefined
				? { valid: false }
				: {
						valid: true,
						blocks: [{ type: "redacted_thinking", data }],
					};
		}
		if ("$unknown" in reasoning) return { valid: true, blocks: [] };
		return { valid: false };
	}

	if ("citationsContent" in block) {
		if (!isRecord(block.citationsContent)) return { valid: false };
		const generatedContent = block.citationsContent.content;
		if (generatedContent !== undefined && !Array.isArray(generatedContent)) {
			return { valid: false };
		}
		const textParts: string[] = [];
		for (const content of generatedContent ?? []) {
			if (!isRecord(content)) return { valid: false };
			if (typeof content.text === "string") {
				textParts.push(content.text);
			} else if (!("$unknown" in content)) {
				return { valid: false };
			}
		}

		const rawCitations = block.citationsContent.citations;
		if (rawCitations !== undefined && !Array.isArray(rawCitations)) {
			return { valid: false };
		}
		const citations = (rawCitations ?? []).flatMap((citation) => {
			const transformed = transformBedrockCitation(citation);
			return transformed ? [transformed] : [];
		});
		const text = textParts.join("");
		return {
			valid: true,
			blocks:
				textParts.length === 0
					? []
					: [
							{
								type: "text",
								text,
								...(citations.length > 0 ? { citations } : {}),
							},
						],
		};
	}

	// Converse supports input-only and provider-specific output unions that do
	// not have valid Anthropic assistant content equivalents. Omit those blocks
	// rather than leaking the AWS wire shape to Anthropic clients.
	for (const key of [
		"image",
		"document",
		"video",
		"audio",
		"toolResult",
		"guardContent",
		"cachePoint",
		"searchResult",
		"$unknown",
	]) {
		if (key in block) {
			return block[key] === null || block[key] === undefined
				? { valid: false }
				: { valid: true, blocks: [] };
		}
	}
	return { valid: false };
}

function invalidConverseResponse(headers: Headers): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "application/json");
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "api_error",
				message: "Bedrock returned an invalid Converse response.",
			},
		}),
		{ status: 502, statusText: "Bad Gateway", headers: responseHeaders },
	);
}

/**
 * Transform Bedrock Converse response to Claude Messages API format
 *
 * Converts raw Bedrock JSON response to strict Claude Messages API compatibility.
 * This transformation enables clients to consume Bedrock responses identically
 * to native Claude API responses.
 *
 * Transformation mapping:
 * - output.message.content → valid Anthropic text, tool-use, and thinking blocks
 * - stopReason → stop_reason
 * - usage.inputTokens → usage.input_tokens
 * - usage.outputTokens → usage.output_tokens
 * - AWS-specific metadata dropped entirely (no additionalModelResponseFields, metrics.latencyMs)
 *
 * Error handling:
 * - Returns a deliberate 502 when the upstream envelope cannot be validated
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
 *       "content": [{ "text": "Hello" }]
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
		const json = (await clone.json()) as unknown;
		if (!isRecord(json) || !isRecord(json.output)) {
			return invalidConverseResponse(response.headers);
		}
		const outputMessage = json.output.message;
		if (!isRecord(outputMessage) || !Array.isArray(outputMessage.content)) {
			return invalidConverseResponse(response.headers);
		}
		const content: ClaudeResponseContentBlock[] = [];
		for (const block of outputMessage.content) {
			const transformed = transformResponseContentBlock(block);
			if (!transformed.valid) {
				return invalidConverseResponse(response.headers);
			}
			content.push(...transformed.blocks);
		}

		// Extract fields from Bedrock format
		if (
			!isNonEmptyString(json.stopReason) ||
			!isCanonicalBedrockUsage(json.usage)
		) {
			return invalidConverseResponse(response.headers);
		}
		const stopReason = json.stopReason;
		const normalizedUsage = normalizeBedrockUsage(json.usage);

		// Transform to Claude Messages API format
		const claudeResponse = {
			id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
			type: "message",
			role: "assistant",
			content,
			model: typeof json.model === "string" ? json.model : "claude-bedrock",
			stop_reason: stopReason,
			usage: {
				input_tokens: normalizedUsage.inputTokens,
				output_tokens: normalizedUsage.outputTokens,
				cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
				cache_creation_input_tokens: normalizedUsage.cacheCreationInputTokens,
			},
		};

		// Return new Response with transformed JSON body
		return new Response(JSON.stringify(claudeResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		log.error(
			`Failed to transform Bedrock response: ${(error as Error).message}`,
		);
		return invalidConverseResponse(response.headers);
	}
}
