import type {
	CachePointBlock,
	Citation,
	ContentBlock,
	ConverseStreamCommandInput,
	Message,
	SystemContentBlock,
	Tool,
	ToolConfiguration,
	ToolInputSchema,
	ToolResultContentBlock,
	ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockRequestTransformer");

/**
 * Claude Messages API request format
 */
export interface ClaudeRequest {
	model: string;
	messages: Array<{
		role: string;
		content: string | ClaudeContentBlock[];
	}>;
	max_tokens: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	system?: string | ClaudeContentBlock[];
	tools?: ClaudeTool[];
	metadata?: unknown;
	stream?: boolean;
}

export interface ClaudeCacheControl {
	type: string;
	ttl?: string;
}

export interface ClaudeContentBlock {
	type: string;
	text?: string;
	cache_control?: ClaudeCacheControl;
	[key: string]: unknown;
}

export interface ClaudeTool {
	name: string;
	description?: string;
	input_schema: NonNullable<ToolInputSchema["json"]>;
	cache_control?: ClaudeCacheControl;
}

/**
 * Bedrock Converse API input (without modelId)
 * modelId is added separately in the provider after translation
 */
export interface BedrockConverseInput {
	messages?: Message[];
	system?: SystemContentBlock[];
	toolConfig?: ToolConfiguration;
	inferenceConfig?: {
		maxTokens?: number;
		temperature?: number;
		topP?: number;
		stopSequences?: string[];
	};
}

interface PromptCacheCapability {
	supportsOneHourTtl: boolean;
}

const PROMPT_CACHE_MODELS: ReadonlyArray<{
	modelIdFragment: string;
	supportsOneHourTtl: boolean;
}> = [
	{
		modelIdFragment: "anthropic.claude-opus-4-5-20251101-v1:0",
		supportsOneHourTtl: true,
	},
	{
		modelIdFragment: "anthropic.claude-opus-4-6-v1",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-sonnet-4-5-20250929-v1:0",
		supportsOneHourTtl: true,
	},
	{
		modelIdFragment: "anthropic.claude-sonnet-4-6",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-haiku-4-5-20251001-v1:0",
		supportsOneHourTtl: true,
	},
	{
		modelIdFragment: "anthropic.claude-opus-4-1-20250805-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-opus-4-20250514-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-sonnet-4-20250514-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-3-7-sonnet-20250219-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-3-5-haiku-20241022-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		supportsOneHourTtl: false,
	},
];

const SEARCH_RESULT_MODELS = [
	"anthropic.claude-opus-4-1-20250805-v1:0",
	"anthropic.claude-opus-4-20250514-v1:0",
	"anthropic.claude-sonnet-4-5-20250929-v1:0",
	"anthropic.claude-sonnet-4-20250514-v1:0",
	"anthropic.claude-3-7-sonnet-20250219-v1:0",
	"anthropic.claude-3-5-haiku-20241022-v1:0",
] as const;

function getPromptCacheCapability(
	modelId: string,
): PromptCacheCapability | null {
	const normalizedModelId = modelId.toLowerCase();
	const supportedModel = PROMPT_CACHE_MODELS.find(({ modelIdFragment }) =>
		normalizedModelId.includes(modelIdFragment),
	);

	return supportedModel
		? { supportsOneHourTtl: supportedModel.supportsOneHourTtl }
		: null;
}

function supportsSearchResults(modelId: string): boolean {
	const normalizedModelId = modelId.toLowerCase();
	return SEARCH_RESULT_MODELS.some((physicalModelId) => {
		if (!normalizedModelId.endsWith(physicalModelId)) {
			return false;
		}

		const prefixLength = normalizedModelId.length - physicalModelId.length;
		return (
			prefixLength === 0 ||
			normalizedModelId[prefixLength - 1] === "." ||
			normalizedModelId[prefixLength - 1] === "/"
		);
	});
}

/**
 * Bedrock evaluates checkpoints globally in tools -> system -> messages order.
 * Keeping one policy object for the complete transform enforces that order,
 * the four-checkpoint model limit, and the long-before-short TTL constraint.
 */
class PromptCachePolicy {
	private checkpointCount = 0;
	private emittedFiveMinuteCheckpoint = false;

	constructor(private readonly capability: PromptCacheCapability | null) {}

	createCachePoint(
		cacheControl: ClaudeCacheControl | undefined,
	): CachePointBlock | null {
		if (!this.capability || cacheControl?.type !== "ephemeral") {
			return null;
		}

		if (
			cacheControl.ttl !== undefined &&
			cacheControl.ttl !== "5m" &&
			cacheControl.ttl !== "1h"
		) {
			return null;
		}

		const effectiveTtl = cacheControl.ttl ?? "5m";
		if (
			effectiveTtl === "1h" &&
			(!this.capability.supportsOneHourTtl || this.emittedFiveMinuteCheckpoint)
		) {
			return null;
		}

		if (this.checkpointCount >= 4) {
			return null;
		}

		this.checkpointCount += 1;
		if (effectiveTtl === "5m") {
			this.emittedFiveMinuteCheckpoint = true;
		}

		return cacheControl.ttl
			? { type: "default", ttl: cacheControl.ttl }
			: { type: "default" };
	}
}

function transformTools(
	tools: ClaudeTool[] | undefined,
	cachePolicy: PromptCachePolicy,
): ToolConfiguration | undefined {
	if (!Array.isArray(tools)) {
		return undefined;
	}

	const transformedTools: Tool[] = [];
	for (const tool of tools) {
		if (
			!tool ||
			!isValidToolName(tool.name) ||
			!tool.input_schema ||
			typeof tool.input_schema !== "object" ||
			Array.isArray(tool.input_schema)
		) {
			continue;
		}

		transformedTools.push({
			toolSpec: {
				name: tool.name,
				...(typeof tool.description === "string" && tool.description.length > 0
					? { description: tool.description }
					: {}),
				inputSchema: { json: tool.input_schema },
			},
		});

		const cachePoint = cachePolicy.createCachePoint(tool.cache_control);
		if (cachePoint) {
			transformedTools.push({ cachePoint });
		}
	}

	return transformedTools.length > 0 ? { tools: transformedTools } : undefined;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIndex(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function decodeBase64(value: unknown): Uint8Array | null {
	if (typeof value !== "string") {
		return null;
	}

	try {
		const decoded = atob(value);
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

const IMAGE_FORMAT_BY_MEDIA_TYPE = {
	"image/gif": "gif",
	"image/jpeg": "jpeg",
	"image/png": "png",
	"image/webp": "webp",
} as const;

const DOCUMENT_FORMAT_BY_MEDIA_TYPE = {
	"application/msword": "doc",
	"application/pdf": "pdf",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"text/csv": "csv",
	"text/html": "html",
	"text/markdown": "md",
	"text/plain": "txt",
} as const;

function normalizeDocumentName(value: unknown): string {
	const source = isNonEmptyString(value) ? value.trim() : "document";
	const normalized = source
		.replace(/[^\p{L}\p{N}\s()\[\]-]/gu, "-")
		.replace(/\s+/g, " ")
		.replace(/-+/g, "-")
		.slice(0, 200);
	return normalized || "document";
}

function transformImageToolResult(
	item: Record<string, unknown>,
): ToolResultContentBlock | null {
	if (!isRecord(item.source) || item.source.type !== "base64") {
		return null;
	}

	const format =
		typeof item.source.media_type === "string"
			? IMAGE_FORMAT_BY_MEDIA_TYPE[
					item.source.media_type as keyof typeof IMAGE_FORMAT_BY_MEDIA_TYPE
				]
			: undefined;
	const bytes = decodeBase64(item.source.data);
	if (!format || !bytes) {
		return null;
	}

	return { image: { format, source: { bytes } } };
}

function transformDocumentToolResult(
	item: Record<string, unknown>,
): ToolResultContentBlock | null {
	if (!isRecord(item.source)) {
		return null;
	}

	const name = normalizeDocumentName(item.title);
	if (item.source.type === "text" && typeof item.source.data === "string") {
		return {
			document: {
				format: "txt",
				name,
				source: { text: item.source.data },
			},
		};
	}

	if (item.source.type !== "base64") {
		return null;
	}

	const format =
		typeof item.source.media_type === "string"
			? DOCUMENT_FORMAT_BY_MEDIA_TYPE[
					item.source.media_type as keyof typeof DOCUMENT_FORMAT_BY_MEDIA_TYPE
				]
			: undefined;
	const bytes = decodeBase64(item.source.data);
	if (!format || !bytes) {
		return null;
	}

	return { document: { format, name, source: { bytes } } };
}

function transformSearchResultToolResult(
	item: Record<string, unknown>,
): ToolResultContentBlock | null {
	if (
		!isNonEmptyString(item.source) ||
		!isNonEmptyString(item.title) ||
		!Array.isArray(item.content)
	) {
		return null;
	}

	const content = item.content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string"
			? [{ text: block.text }]
			: [],
	);
	if (content.length === 0) {
		return null;
	}

	const citations =
		isRecord(item.citations) && typeof item.citations.enabled === "boolean"
			? { enabled: item.citations.enabled }
			: undefined;

	return {
		searchResult: {
			source: item.source,
			title: item.title,
			content,
			...(citations ? { citations } : {}),
		},
	};
}

function transformToolResultContent(
	content: unknown,
	supportsSearchResult: boolean,
): ToolResultContentBlock[] | null {
	if (typeof content === "string") {
		return [{ text: content }];
	}

	if (isRecord(content) && isJsonValue(content)) {
		return [{ json: content }];
	}

	if (!Array.isArray(content)) {
		return null;
	}

	if (content.length === 0) {
		return [{ text: "" }];
	}

	const transformedContent: ToolResultContentBlock[] = [];
	for (const item of content) {
		if (!isRecord(item)) {
			return null;
		}

		if (item.type === "text" && typeof item.text === "string") {
			transformedContent.push({ text: item.text });
			continue;
		}

		if (item.type === "json" && isJsonValue(item.json)) {
			transformedContent.push({ json: item.json });
			continue;
		}

		let transformedItem: ToolResultContentBlock | null = null;
		if (item.type === "image") {
			transformedItem = transformImageToolResult(item);
		} else if (item.type === "document") {
			transformedItem = transformDocumentToolResult(item);
		} else if (item.type === "search_result") {
			const searchResult = transformSearchResultToolResult(item);
			if (searchResult) {
				transformedItem = supportsSearchResult
					? searchResult
					: { text: JSON.stringify(item) };
			}
		}

		if (!transformedItem) {
			return null;
		}
		transformedContent.push(transformedItem);
	}

	return transformedContent;
}

interface MessageTransformContext {
	validToolPairIds: Set<string>;
	emittedToolUseIds: Set<string>;
	supportsSearchResult: boolean;
}

const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidToolUseId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 64 &&
		TOOL_USE_ID_PATTERN.test(value)
	);
}

function isValidToolName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 64 &&
		TOOL_NAME_PATTERN.test(value)
	);
}

function transformClaudeCitation(citation: unknown): Citation | null {
	if (!isRecord(citation) || !isNonEmptyString(citation.cited_text)) {
		return null;
	}
	const title = citation.document_title ?? citation.title ?? undefined;
	if (title !== undefined && title !== null && typeof title !== "string") {
		return null;
	}
	const common = {
		...(typeof title === "string" ? { title } : {}),
		sourceContent: [{ text: citation.cited_text }],
	};

	if (
		citation.type === "char_location" &&
		citation.file_id === null &&
		isSafeIndex(citation.document_index) &&
		isSafeIndex(citation.start_char_index) &&
		isSafeIndex(citation.end_char_index) &&
		citation.end_char_index > citation.start_char_index
	) {
		return {
			...common,
			location: {
				documentChar: {
					documentIndex: citation.document_index,
					start: citation.start_char_index,
					end: citation.end_char_index,
				},
			},
		};
	}

	if (
		citation.type === "page_location" &&
		citation.file_id === null &&
		isSafeIndex(citation.document_index) &&
		isSafeIndex(citation.start_page_number, 1) &&
		isSafeIndex(citation.end_page_number, 1) &&
		citation.end_page_number > citation.start_page_number
	) {
		return {
			...common,
			location: {
				documentPage: {
					documentIndex: citation.document_index,
					start: citation.start_page_number,
					end: citation.end_page_number,
				},
			},
		};
	}

	if (
		citation.type === "content_block_location" &&
		citation.file_id === null &&
		isSafeIndex(citation.document_index) &&
		isSafeIndex(citation.start_block_index) &&
		isSafeIndex(citation.end_block_index) &&
		citation.end_block_index > citation.start_block_index
	) {
		return {
			...common,
			location: {
				documentChunk: {
					documentIndex: citation.document_index,
					start: citation.start_block_index,
					end: citation.end_block_index,
				},
			},
		};
	}

	if (
		citation.type === "search_result_location" &&
		isNonEmptyString(citation.source) &&
		isSafeIndex(citation.search_result_index) &&
		isSafeIndex(citation.start_block_index) &&
		isSafeIndex(citation.end_block_index) &&
		citation.end_block_index > citation.start_block_index
	) {
		return {
			...common,
			source: citation.source,
			location: {
				searchResultLocation: {
					searchResultIndex: citation.search_result_index,
					start: citation.start_block_index,
					end: citation.end_block_index,
				},
			},
		};
	}

	return null;
}

function transformTextBlock(block: ClaudeContentBlock): ContentBlock | null {
	if (block.type !== "text" || typeof block.text !== "string") {
		return null;
	}
	if (block.text.length === 0) {
		return null;
	}
	if (block.citations === undefined) {
		return { text: block.text };
	}
	if (!Array.isArray(block.citations) || block.citations.length === 0) {
		return { text: block.text };
	}

	const citations = block.citations.map(transformClaudeCitation);
	if (citations.some((citation) => citation === null)) {
		return { text: block.text };
	}
	return {
		citationsContent: {
			content: [{ text: block.text }],
			citations: citations as Citation[],
		},
	};
}

function isValidToolUseBlock(
	block: ClaudeContentBlock,
): block is ClaudeContentBlock & {
	id: string;
	input: Record<string, JsonValue>;
	name: string;
	type: "tool_use";
} {
	return (
		block.type === "tool_use" &&
		isValidToolUseId(block.id) &&
		isValidToolName(block.name) &&
		isRecord(block.input) &&
		isJsonValue(block.input)
	);
}

function isValidToolResultBlock(
	block: ClaudeContentBlock,
	supportsSearchResult: boolean,
): boolean {
	return (
		block.type === "tool_result" &&
		isValidToolUseId(block.tool_use_id) &&
		(block.is_error === undefined || typeof block.is_error === "boolean") &&
		transformToolResultContent(block.content, supportsSearchResult) !== null
	);
}

/**
 * Bedrock rejects dangling or ambiguous tool history. Preflight the complete
 * conversation so a tool use and its result are either both emitted exactly
 * once, in order, or both omitted. This also prevents cache points attached to
 * a rejected half-pair from consuming the global checkpoint budget.
 */
function collectValidToolPairIds(
	messages: ClaudeRequest["messages"],
	supportsSearchResult: boolean,
): Set<string> {
	const candidateGroups: string[][] = [];

	for (const [messageIndex, assistantMessage] of messages.entries()) {
		if (
			assistantMessage.role !== "assistant" ||
			!Array.isArray(assistantMessage.content)
		) {
			continue;
		}

		const firstToolUseIndex = assistantMessage.content.findIndex(
			(block) => block.type === "tool_use",
		);
		if (firstToolUseIndex < 0) {
			continue;
		}

		const toolUses = assistantMessage.content.slice(firstToolUseIndex);
		if (
			toolUses.length === 0 ||
			toolUses.some((block) => block.type !== "tool_use") ||
			toolUses.some((block) => !isValidToolUseBlock(block))
		) {
			continue;
		}

		const resultMessage = messages[messageIndex + 1];
		if (
			resultMessage?.role !== "user" ||
			!Array.isArray(resultMessage.content)
		) {
			continue;
		}

		let resultPrefixLength = 0;
		while (resultMessage.content[resultPrefixLength]?.type === "tool_result") {
			resultPrefixLength += 1;
		}
		const toolResults = resultMessage.content.slice(0, resultPrefixLength);
		if (
			toolResults.length !== toolUses.length ||
			resultMessage.content
				.slice(resultPrefixLength)
				.some((block) => block.type === "tool_result") ||
			toolResults.some(
				(block) => !isValidToolResultBlock(block, supportsSearchResult),
			)
		) {
			continue;
		}

		const toolUseIds = toolUses.map((block) => block.id as string);
		const toolResultIds = toolResults.map(
			(block) => block.tool_use_id as string,
		);
		if (
			new Set(toolUseIds).size !== toolUseIds.length ||
			new Set(toolResultIds).size !== toolResultIds.length ||
			toolUseIds.some((id, index) => id !== toolResultIds[index])
		) {
			continue;
		}

		candidateGroups.push(toolUseIds);
	}

	const idCounts = new Map<string, number>();
	for (const group of candidateGroups) {
		for (const id of group) {
			idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		}
	}

	return new Set(
		candidateGroups.flatMap((group) =>
			group.every((id) => idCounts.get(id) === 1) ? group : [],
		),
	);
}

function transformMessageContentBlock(
	block: ClaudeContentBlock,
	context: MessageTransformContext,
): ContentBlock | null {
	if (block.type === "text") {
		return transformTextBlock(block);
	}

	if (block.type === "thinking") {
		if (
			typeof block.thinking === "string" &&
			isNonEmptyString(block.signature)
		) {
			return {
				reasoningContent: {
					reasoningText: {
						text: block.thinking,
						signature: block.signature,
					},
				},
			};
		}
		return null;
	}

	if (block.type === "redacted_thinking") {
		const redactedContent = decodeBase64(block.data);
		return redactedContent ? { reasoningContent: { redactedContent } } : null;
	}

	if (block.type === "tool_use") {
		if (isValidToolUseBlock(block) && context.validToolPairIds.has(block.id)) {
			context.emittedToolUseIds.add(block.id);
			return {
				toolUse: {
					toolUseId: block.id,
					name: block.name,
					input: block.input as NonNullable<ToolUseBlock["input"]>,
				},
			};
		}
		return null;
	}

	if (block.type === "tool_result" && isNonEmptyString(block.tool_use_id)) {
		if (
			!context.validToolPairIds.has(block.tool_use_id) ||
			!context.emittedToolUseIds.delete(block.tool_use_id)
		) {
			log.warn(
				`Dropping orphan Bedrock tool result for tool_use_id ${block.tool_use_id}`,
			);
			return null;
		}

		const content = transformToolResultContent(
			block.content,
			context.supportsSearchResult,
		);
		if (!content) {
			return null;
		}
		return {
			toolResult: {
				toolUseId: block.tool_use_id,
				content,
				status: block.is_error === true ? "error" : "success",
			},
		};
	}

	return null;
}

/**
 * Transform Claude Messages API request to Bedrock Converse API format
 *
 * Field mappings:
 * - messages → messages (requires content transformation)
 * - model → NOT in ConverseCommandInput (model specified separately in invokeModel())
 * - max_tokens → inferenceConfig.maxTokens
 * - temperature → inferenceConfig.temperature
 * - top_p → inferenceConfig.topP
 * - stop_sequences → inferenceConfig.stopSequences
 * - system → system (array format: [{ text: string }])
 *
 * Unsupported parameters (stripped with warnings):
 * - top_k - Bedrock doesn't support
 * - metadata - Not supported
 * - stream - Handled separately, not in transformation
 *
 * @param claudeRequest - Claude Messages API request
 * @returns Bedrock Converse API input (modelId added separately)
 */
export function transformMessagesRequest(
	claudeRequest: ClaudeRequest,
	bedrockModelId = claudeRequest.model,
): BedrockConverseInput {
	// Warn about unsupported parameters
	if (claudeRequest.top_k) {
		log.warn("Bedrock does not support top_k parameter, stripping");
	}
	if (claudeRequest.metadata) {
		log.warn("Bedrock does not support metadata parameter, stripping");
	}

	const cachePolicy = new PromptCachePolicy(
		getPromptCacheCapability(bedrockModelId),
	);
	const supportsSearchResult = supportsSearchResults(bedrockModelId);
	const messageTransformContext: MessageTransformContext = {
		validToolPairIds: collectValidToolPairIds(
			claudeRequest.messages,
			supportsSearchResult,
		),
		emittedToolUseIds: new Set<string>(),
		supportsSearchResult,
	};

	// Bedrock processes cache checkpoints in tools -> system -> messages order.
	const toolConfig = transformTools(claudeRequest.tools, cachePolicy);

	// Transform system prompt to Bedrock format
	let systemPrompt: SystemContentBlock[] | undefined;
	if (claudeRequest.system) {
		if (typeof claudeRequest.system === "string") {
			systemPrompt = [{ text: claudeRequest.system }];
		} else {
			systemPrompt = [];
			for (const item of claudeRequest.system) {
				if (item.type !== "text" || typeof item.text !== "string") {
					continue;
				}

				systemPrompt.push({ text: item.text });
				const cachePoint = cachePolicy.createCachePoint(item.cache_control);
				if (cachePoint) {
					systemPrompt.push({ cachePoint });
				}
			}
			if (systemPrompt.length === 0) {
				systemPrompt = undefined;
			}
		}
	}

	// Transform messages to Bedrock format
	// Bedrock requires content to be an array of { text: string } objects
	const transformedMessages: Message[] = [];
	for (const [index, msg] of claudeRequest.messages.entries()) {
		let content: ContentBlock[] = [];

		if (typeof msg.content === "string") {
			// Simple string content
			if (msg.content.length > 0) {
				content = [{ text: msg.content }];
			}
		} else if (Array.isArray(msg.content)) {
			// Keep Bedrock's required parallel tool suffix/prefix contiguous. Cache
			// points follow the complete group instead of splitting tool blocks.
			const leadingToolResultCount = msg.content.findIndex(
				(block) => block.type !== "tool_result",
			);
			const normalizedLeadingToolResultCount =
				leadingToolResultCount < 0
					? msg.content.length
					: leadingToolResultCount;
			const deferredToolUseCachePoints: CachePointBlock[] = [];
			const deferredToolResultCachePoints: CachePointBlock[] = [];
			for (const [blockIndex, block] of msg.content.entries()) {
				if (blockIndex === normalizedLeadingToolResultCount) {
					content.push(
						...deferredToolResultCachePoints.map((cachePoint) => ({
							cachePoint,
						})),
					);
					deferredToolResultCachePoints.length = 0;
				}

				const transformedBlock = transformMessageContentBlock(
					block,
					messageTransformContext,
				);
				if (!transformedBlock) {
					continue;
				}

				content.push(transformedBlock);
				const cachePoint = cachePolicy.createCachePoint(block.cache_control);
				if (cachePoint) {
					if (block.type === "tool_use") {
						deferredToolUseCachePoints.push(cachePoint);
					} else if (
						block.type === "tool_result" &&
						blockIndex < normalizedLeadingToolResultCount
					) {
						deferredToolResultCachePoints.push(cachePoint);
					} else {
						content.push({ cachePoint });
					}
				}
			}
			content.push(
				...deferredToolResultCachePoints.map((cachePoint) => ({ cachePoint })),
			);
			content.push(
				...deferredToolUseCachePoints.map((cachePoint) => ({ cachePoint })),
			);
		} else {
			log.warn(
				`Unexpected message content type at index ${index}: ${typeof msg.content}, dropping message`,
			);
		}

		// Bedrock rejects messages with empty content arrays.
		// Skip empty messages to avoid ValidationException.
		if (content.length === 0) {
			log.warn(
				`Dropping empty message at index ${index} (role: ${msg.role}) before Bedrock transform`,
			);
			continue;
		}

		transformedMessages.push({
			role: msg.role,
			content,
		} as Message);
	}

	if (transformedMessages.length === 0) {
		throw new Error(
			"All messages were empty or contained only non-text content and were dropped. Bedrock requires at least one non-empty message.",
		);
	}

	return {
		messages: transformedMessages,
		system: systemPrompt,
		toolConfig,
		inferenceConfig: {
			maxTokens: claudeRequest.max_tokens,
			temperature: claudeRequest.temperature,
			topP: claudeRequest.top_p,
			stopSequences: claudeRequest.stop_sequences,
		},
	};
}

/**
 * Detect if request is streaming based on stream parameter in body
 *
 * Per CONTEXT.md decision: "Detection method: Client stream parameter in request body (not headers)"
 * Default: false (non-streaming) when parameter missing
 *
 * @param request - Request object
 * @returns true if streaming mode requested
 */
export async function detectStreamingMode(request: Request): Promise<boolean> {
	try {
		const bodyText = await request.text();
		const body = JSON.parse(bodyText) as { stream?: boolean };
		return body.stream === true; // Default to false if missing
	} catch (error) {
		log.warn(
			`Failed to parse request body for streaming detection: ${(error as Error).message}`,
		);
		return false; // Default to non-streaming on error
	}
}

/**
 * Transform Claude Messages API request to Bedrock ConverseStream API format
 *
 * ConverseStreamCommandInput has the same structure as ConverseCommandInput:
 * - messages
 * - system
 * - inferenceConfig (maxTokens, temperature, topP, stopSequences)
 *
 * The only difference is the command used (ConverseStreamCommand vs ConverseCommand).
 *
 * @param claudeRequest - Claude Messages API request
 * @returns Bedrock ConverseStream API input (modelId added separately)
 */
export function transformStreamingRequest(
	claudeRequest: ClaudeRequest,
	bedrockModelId = claudeRequest.model,
): ConverseStreamCommandInput {
	// Bedrock uses same input format for streaming and non-streaming
	// Reuse the existing transformation logic
	const nonStreamingInput = transformMessagesRequest(
		claudeRequest,
		bedrockModelId,
	);

	// ConverseStreamCommandInput has same structure as ConverseCommandInput
	// Cast is safe because fields are identical
	return nonStreamingInput as ConverseStreamCommandInput;
}

/**
 * Check if a model supports streaming
 *
 * Heuristic for determining if model supports streaming:
 * - All Anthropic Claude models support streaming
 * - Check if modelId contains "anthropic" or "claude"
 * - Default to true (attempt streaming, fall back on error)
 *
 * @param modelId - Model identifier
 * @returns true if model likely supports streaming
 */
export function supportsStreaming(modelId: string): boolean {
	// All Claude models support streaming
	if (modelId.includes("anthropic") || modelId.includes("claude")) {
		return true;
	}
	// Default to true, will fall back on error
	return true;
}
