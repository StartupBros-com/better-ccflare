import type {
	CachePointBlock,
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
		modelIdFragment: "anthropic.claude-opus-4-20250514-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-3-7-sonnet-20250219-v1:0",
		supportsOneHourTtl: false,
	},
	{
		modelIdFragment: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		supportsOneHourTtl: false,
	},
];

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
			typeof tool.name !== "string" ||
			tool.name.trim().length === 0 ||
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

function transformToolResultContent(
	content: unknown,
): ToolResultContentBlock[] {
	if (isNonEmptyString(content)) {
		return [{ text: content }];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const transformedContent: ToolResultContentBlock[] = [];
	for (const item of content) {
		if (
			typeof item === "object" &&
			item !== null &&
			"type" in item &&
			item.type === "text" &&
			"text" in item &&
			isNonEmptyString(item.text)
		) {
			transformedContent.push({ text: item.text });
		}
	}

	return transformedContent;
}

function transformMessageContentBlock(
	block: ClaudeContentBlock,
): ContentBlock | null {
	if (block.type === "text" && isNonEmptyString(block.text)) {
		return { text: block.text.trim() };
	}

	if (
		block.type === "tool_use" &&
		isNonEmptyString(block.id) &&
		isNonEmptyString(block.name) &&
		typeof block.input === "object" &&
		block.input !== null &&
		!Array.isArray(block.input)
	) {
		return {
			toolUse: {
				toolUseId: block.id,
				name: block.name,
				input: block.input as NonNullable<ToolUseBlock["input"]>,
			},
		};
	}

	if (block.type === "tool_result" && isNonEmptyString(block.tool_use_id)) {
		const content = transformToolResultContent(block.content);
		if (content.length === 0) {
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
			const text = msg.content.trim();
			if (text.length > 0) {
				content = [{ text }];
			}
		} else if (Array.isArray(msg.content)) {
			// Transform supported content blocks and place
			// cache points immediately after their marked source block.
			for (const block of msg.content) {
				const transformedBlock = transformMessageContentBlock(block);
				if (!transformedBlock) {
					continue;
				}

				content.push(transformedBlock);
				const cachePoint = cachePolicy.createCachePoint(block.cache_control);
				if (cachePoint) {
					content.push({ cachePoint });
				}
			}
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
