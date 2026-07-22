import { getModelFamily } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account, LogicalModelCapability } from "@better-ccflare/types";
import type { RateLimitInfo } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";

const _log = new Logger("QwenProvider");

const _DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_USER_AGENT = "QwenCode/sdk-typescript-v0.1.7 (darwin; arm64)";

type OpenAIMessage = OpenAIRequest["messages"][number];
type CacheControl = { type: string };
type CacheableContentPart = {
	type: string;
	text?: string;
	cache_control?: CacheControl;
};
type CacheableTool = NonNullable<OpenAIRequest["tools"]>[number] & {
	cache_control?: CacheControl;
};

const MAX_DASHSCOPE_CACHE_MARKERS = 4;

// Stainless SDK headers injected by the official OpenAI Node SDK (v5.x).
// portal.qwen.ai validates these to confirm the official client is being used.
const STAINLESS_HEADERS: Record<string, string> = {
	"X-Stainless-Lang": "js",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v22.17.0",
	"X-Stainless-Os": "MacOS",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Package-Version": "5.11.0",
	"X-Stainless-Retry-Count": "0",
};

// All Anthropic model tiers map to coder-model (Qwen's unified coding model)
export const QWEN_MODEL_MAPPINGS = {
	opus: "coder-model",
	sonnet: "coder-model",
	haiku: "coder-model",
};

// Lines in the Claude Code system prompt that are environment/model-specific
// and should be dropped entirely when proxying to Qwen.
const DROP_LINE_PATTERNS = [
	/You are powered by the model named/,
	/The most recent Claude model family is/,
	/Claude Code is available as a CLI/,
	/Fast mode for Claude Code/,
	/claude\.ai\/code/,
];

/**
 * Adapt a Claude Code system prompt block for Qwen/DashScope:
 * - Replace Claude Code identity with Qwen Code identity
 * - Replace CLAUDE.md references with QWEN.md
 * - Replace /help feedback link with qwen-code's /bug command
 * - Drop lines that reference Claude-specific model names or availability
 */
function sanitizeForQwen(text: string): string {
	// Replace identity line (block [1] is exactly this string)
	if (
		text === "You are Claude Code, Anthropic's official CLI for Claude." ||
		text ===
			"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." ||
		text === "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	) {
		return "You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.";
	}

	// Process line-by-line for the main instructions block
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		// Drop Claude-specific environment/model lines entirely
		if (DROP_LINE_PATTERNS.some((re) => re.test(line))) continue;

		let l = line;
		// CLAUDE.md → QWEN.md
		l = l.replace(/\bCLAUDE\.md\b/g, "QWEN.md");
		// /help feedback line
		l = l.replace(
			/To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/,
			"To report a bug or provide feedback, please use the /bug command",
		);
		// "Get help with using Claude Code"
		l = l.replace(
			/Get help with using Claude Code/,
			"Get help with using Qwen Code",
		);
		out.push(l);
	}
	return out.join("\n");
}

function hasEphemeralCacheControl(value: {
	cache_control?: CacheControl;
}): boolean {
	return value.cache_control?.type === "ephemeral";
}

/**
 * Put a DashScope cache boundary on the final content block of a message.
 * Existing valid boundaries are left intact so this remains idempotent.
 */
function markMessageForCaching(message: OpenAIMessage): number | undefined {
	if (typeof message.content === "string") {
		if (message.content.length === 0) return undefined;

		message.content = [
			{
				type: "text",
				text: message.content,
				cache_control: { type: "ephemeral" },
			},
		];
		return 0;
	}

	if (!Array.isArray(message.content) || message.content.length === 0) {
		return undefined;
	}

	const lastIndex = message.content.length - 1;
	const lastPart = message.content[lastIndex];
	if (hasEphemeralCacheControl(lastPart)) return lastIndex;

	const updatedContent = [...message.content];
	updatedContent[lastIndex] = {
		...lastPart,
		cache_control: { type: "ephemeral" },
	};
	message.content = updatedContent;
	return lastIndex;
}

function messageMarkerKey(messageIndex: number, partIndex: number): string {
	return `message:${messageIndex}:${partIndex}`;
}

function toolMarkerKey(toolIndex: number): string {
	return `tool:${toolIndex}`;
}

/**
 * DashScope accepts at most four explicit cache breakpoints. Keep all of the
 * canonical boundaries selected by this provider, then retain the earliest
 * inherited boundaries that fit in the remaining budget. Only excess inherited
 * markers are removed, and their source objects are not mutated.
 */
function enforceDashScopeCacheMarkerBudget(
	body: OpenAIRequest,
	canonicalMarkers: Set<string>,
): void {
	const markerKeys: string[] = [];
	for (const [messageIndex, message] of body.messages.entries()) {
		if (!Array.isArray(message.content)) continue;
		for (const [partIndex, part] of message.content.entries()) {
			if (hasEphemeralCacheControl(part)) {
				markerKeys.push(messageMarkerKey(messageIndex, partIndex));
			}
		}
	}

	const tools = body.tools as CacheableTool[] | undefined;
	for (const [toolIndex, tool] of (tools ?? []).entries()) {
		if (hasEphemeralCacheControl(tool)) {
			markerKeys.push(toolMarkerKey(toolIndex));
		}
	}

	if (markerKeys.length <= MAX_DASHSCOPE_CACHE_MARKERS) return;

	const inheritedMarkers = markerKeys.filter(
		(key) => !canonicalMarkers.has(key),
	);
	const inheritedBudget = Math.max(
		0,
		MAX_DASHSCOPE_CACHE_MARKERS - canonicalMarkers.size,
	);
	const markersToPrune = new Set(inheritedMarkers.slice(inheritedBudget));
	if (markersToPrune.size === 0) return;

	let messagesChanged = false;
	const updatedMessages = body.messages.map((message, messageIndex) => {
		if (!Array.isArray(message.content)) return message;

		let contentChanged = false;
		const updatedContent = message.content.map((part, partIndex) => {
			if (!markersToPrune.has(messageMarkerKey(messageIndex, partIndex))) {
				return part;
			}
			contentChanged = true;
			const updatedPart: CacheableContentPart = { ...part };
			delete updatedPart.cache_control;
			return updatedPart;
		});

		if (!contentChanged) return message;
		messagesChanged = true;
		return { ...message, content: updatedContent };
	});
	if (messagesChanged) body.messages = updatedMessages;

	if (!tools) return;
	let toolsChanged = false;
	const updatedTools = tools.map((tool, toolIndex) => {
		if (!markersToPrune.has(toolMarkerKey(toolIndex))) return tool;
		toolsChanged = true;
		const updatedTool = { ...tool };
		delete updatedTool.cache_control;
		return updatedTool;
	});
	if (toolsChanged) body.tools = updatedTools;
}

function isToollessGlmRequest(body: OpenAIRequest): boolean {
	if (!body.model.toLowerCase().startsWith("glm-")) return false;
	if (body.tools && body.tools.length > 0) return false;

	return !body.messages.some(
		(message) =>
			message.role === "tool" ||
			(message.role === "assistant" &&
				Array.isArray(message.tool_calls) &&
				message.tool_calls.length > 0),
	);
}

/**
 * Tool-less glm-* requests on DashScope silently discard structured text
 * arrays. Remove inherited cache markers and collapse text-only arrays to the
 * plain-string form the model reliably consumes. Media-bearing arrays remain
 * structured, but are still sent without cache markers.
 */
function flattenToollessGlmContent(body: OpenAIRequest): void {
	body.messages = body.messages.map((message) => {
		if (!Array.isArray(message.content) || message.content.length === 0) {
			return message;
		}

		let removedCacheMarker = false;
		const content = message.content.map((part) => {
			if (part.cache_control === undefined) return part;
			removedCacheMarker = true;
			const updatedPart: CacheableContentPart = { ...part };
			delete updatedPart.cache_control;
			return updatedPart;
		});

		if (content.every((part) => part.type === "text")) {
			return {
				...message,
				content: content.map((part) => part.text ?? "").join("\n\n"),
			};
		}

		return removedCacheMarker ? { ...message, content } : message;
	});
}

/**
 * Mirror Qwen Code's DashScope cache policy: always mark the first system
 * message; for streaming requests, also mark the latest message and final tool.
 */
function addDashScopeCacheControl(body: OpenAIRequest): void {
	const canonicalMarkers = new Set<string>();
	const firstSystemIndex = body.messages.findIndex(
		(message) => message.role === "system",
	);
	if (firstSystemIndex !== -1) {
		const partIndex = markMessageForCaching(body.messages[firstSystemIndex]);
		if (partIndex !== undefined) {
			canonicalMarkers.add(messageMarkerKey(firstSystemIndex, partIndex));
		}
	}

	if (body.stream) {
		const latestMessageIndex = body.messages.length - 1;
		if (latestMessageIndex >= 0 && latestMessageIndex !== firstSystemIndex) {
			const partIndex = markMessageForCaching(
				body.messages[latestMessageIndex],
			);
			if (partIndex !== undefined) {
				canonicalMarkers.add(messageMarkerKey(latestMessageIndex, partIndex));
			}
		}

		const tools = body.tools as CacheableTool[] | undefined;
		if (tools && tools.length > 0) {
			const lastIndex = tools.length - 1;
			const finalTool = tools[lastIndex];
			if (!hasEphemeralCacheControl(finalTool)) {
				const updatedTools = [...tools];
				updatedTools[lastIndex] = {
					...finalTool,
					cache_control: { type: "ephemeral" },
				};
				body.tools = updatedTools;
			}
			canonicalMarkers.add(toolMarkerKey(lastIndex));
		}
	}

	enforceDashScopeCacheMarkerBudget(body, canonicalMarkers);
}

export class QwenProvider extends OpenAICompatibleProvider {
	override name = "qwen";

	getLogicalModelCapability(
		logicalModel: string,
		account: Account,
	): LogicalModelCapability {
		const family = getModelFamily(logicalModel);
		if (!family) {
			return {
				status: "unknown",
				provenance: "undeclared",
				reason: "unknown",
			};
		}
		const usesDefaults = account.model_mappings == null;
		return usesDefaults && family in QWEN_MODEL_MAPPINGS
			? {
					status: "supported",
					provenance: "provider_default",
					reason: "included",
				}
			: {
					status: "unsupported",
					provenance: "provider_default",
					reason: "unsupported",
				};
	}

	/*
	 * Override to save raw Qwen SSE to /tmp for debugging tool call chunks.
	 * Remove once incremental argument handling is confirmed working.
	 *
	 * override async refreshToken(...) { ... }
	 * override buildUrl(...) { ... }
	 */

	override prepareHeaders(
		_headers: Headers,
		accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Start from a clean set — DashScope is sensitive to unexpected headers
		// (e.g. x-stainless-*, anthropic-*, accept-encoding) causing 429s.
		const newHeaders = new Headers();

		// Set Qwen auth headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}

		// Qwen/DashScope SDK headers (verified against qwen-code repo)
		newHeaders.set("Content-Type", "application/json");
		newHeaders.set("User-Agent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-CacheControl", "enable");
		newHeaders.set("X-DashScope-UserAgent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-AuthType", "qwen-oauth");

		// Stainless SDK headers — portal.qwen.ai validates these to confirm
		// the official OpenAI Node SDK is being used (mimics openai npm pkg v5.x)
		for (const [key, value] of Object.entries(STAINLESS_HEADERS)) {
			newHeaders.set(key, value);
		}
		newHeaders.set("Accept-Language", "*");
		newHeaders.set("Accept-Encoding", "gzip, deflate");
		newHeaders.set("Sec-Fetch-Mode", "cors");
		newHeaders.set("Connection", "keep-alive");

		return newHeaders;
	}

	override parseRateLimit(_response: Response): RateLimitInfo {
		// Qwen handles its own rate limiting — never mark as rate-limited
		// Quota errors come as 403s and are handled inline by the API
		return {
			isRateLimited: false,
			statusHeader: "allowed",
		};
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	/**
	 * Inject Qwen-specific model mappings when the account has no custom mappings.
	 */
	override beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		if (!account) return account;
		return {
			...account,
			model_mappings:
				account.model_mappings ?? JSON.stringify(QWEN_MODEL_MAPPINGS),
		};
	}

	/**
	 * Inject Qwen-specific fields after converting to OpenAI format.
	 */
	override afterConvert(body: OpenAIRequest): void {
		for (const msg of body.messages) {
			if (msg.role === "system" && Array.isArray(msg.content)) {
				msg.content = msg.content
					// Strip Anthropic billing header blocks
					.filter(
						(block) =>
							!(
								block.type === "text" &&
								typeof block.text === "string" &&
								block.text.startsWith("x-anthropic-")
							),
					)
					// Replace Claude-specific identity and environment blocks
					.map((block) => {
						if (block.type !== "text" || typeof block.text !== "string")
							return block;
						return { ...block, text: sanitizeForQwen(block.text) };
					})
					// Drop blocks that became empty after sanitization
					.filter(
						(block) =>
							block.type !== "text" ||
							typeof block.text !== "string" ||
							block.text.trim() !== "",
					);

				if (msg.content.length === 0) {
					msg.content = "";
				}
			}
		}

		// Tool-less GLM requests cannot reliably consume structured content arrays
		// on DashScope. Every other request gets the canonical cache boundaries,
		// applied after system-prompt sanitization so they land on final content.
		if (isToollessGlmRequest(body)) {
			flattenToollessGlmContent(body);
		} else {
			addDashScopeCacheControl(body);
		}

		// Enable vision support (coder-model supports vision)
		(body as unknown as Record<string, unknown>).vl_high_resolution_images =
			true;
	}
}
