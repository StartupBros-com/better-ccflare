import { Logger } from "@better-ccflare/logger";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import type { RateLimitInfo } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";

const _log = new Logger("QwenProvider");

const _DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_USER_AGENT = "QwenCode/sdk-typescript-v0.1.7 (darwin; arm64)";

type OpenAIMessage = OpenAIRequest["messages"][number];
type CacheControl = { type: string };
type CacheableTool = NonNullable<OpenAIRequest["tools"]>[number] & {
	cache_control?: CacheControl;
};

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
const QWEN_MODEL_MAPPINGS = {
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
function markMessageForCaching(message: OpenAIMessage): void {
	if (typeof message.content === "string") {
		if (message.content.length === 0) return;

		message.content = [
			{
				type: "text",
				text: message.content,
				cache_control: { type: "ephemeral" },
			},
		];
		return;
	}

	if (!Array.isArray(message.content) || message.content.length === 0) return;

	const lastIndex = message.content.length - 1;
	const lastPart = message.content[lastIndex];
	if (hasEphemeralCacheControl(lastPart)) return;

	const updatedContent = [...message.content];
	updatedContent[lastIndex] = {
		...lastPart,
		cache_control: { type: "ephemeral" },
	};
	message.content = updatedContent;
}

/**
 * Mirror Qwen Code's DashScope cache policy: always mark the first system
 * message; for streaming requests, also mark the latest message and final tool.
 */
function addDashScopeCacheControl(body: OpenAIRequest): void {
	const firstSystemMessage = body.messages.find(
		(message) => message.role === "system",
	);
	if (firstSystemMessage) {
		markMessageForCaching(firstSystemMessage);
	}

	if (!body.stream) return;

	const latestMessage = body.messages[body.messages.length - 1];
	if (latestMessage && latestMessage !== firstSystemMessage) {
		markMessageForCaching(latestMessage);
	}

	const tools = body.tools as CacheableTool[] | undefined;
	if (!tools || tools.length === 0) return;

	const lastIndex = tools.length - 1;
	const finalTool = tools[lastIndex];
	if (hasEphemeralCacheControl(finalTool)) return;

	const updatedTools = [...tools];
	updatedTools[lastIndex] = {
		...finalTool,
		cache_control: { type: "ephemeral" },
	};
	body.tools = updatedTools;
}

export class QwenProvider extends OpenAICompatibleProvider {
	override name = "qwen";

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

		// Apply cache boundaries only after the system prompt has been sanitized,
		// so the marker always lands on the final content actually sent upstream.
		addDashScopeCacheControl(body);

		// Enable vision support (coder-model supports vision)
		(body as unknown as Record<string, unknown>).vl_high_resolution_images =
			true;
	}
}
