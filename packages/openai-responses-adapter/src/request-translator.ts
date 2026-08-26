import {
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	AnthropicContent,
	AnthropicMessage,
	AnthropicRequest,
	AnthropicTool,
	AnthropicToolChoice,
	ResponseItem,
	ResponsesRequest,
	ResponsesTool,
} from "./types";

const logger = new Logger("openai-responses-adapter");

// Map OpenAI model names to Claude family aliases so per-account model_mappings
// (opus/sonnet/haiku) resolve correctly when Codex CLI requests reach the proxy.
// Rules based on OpenAI naming conventions:
//   *-pro   → opus  (heavy reasoning tier, $30+/M input)
//   *-mini  → haiku (fast/cheap tier)
//   *-nano  → haiku (fast/cheap tier)
//   gpt-5*  → sonnet (default capable tier, everything else)
// Non-gpt-5 names (e.g. gpt-4) are passed through unchanged.
function mapGptModelToClaudeFamily(model: string): string {
	const lower = model.toLowerCase();
	if (!lower.startsWith("gpt-")) return model;
	if (lower.endsWith("-pro")) return LATEST_OPUS_MODEL;
	if (lower.endsWith("-mini") || lower.endsWith("-nano"))
		return LATEST_HAIKU_MODEL;
	return LATEST_SONNET_MODEL;
}

function parseArguments(args: string): unknown {
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function translateTools(tools: ResponsesTool[]): AnthropicTool[] {
	const result: AnthropicTool[] = [];
	for (const tool of tools) {
		if (tool.type !== "function") {
			logger.warn(`Skipping unsupported/built-in tool type: ${tool.type}`);
			continue;
		}
		result.push({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters ?? {},
		});
	}
	return result;
}

function translateToolChoice(
	choice: ResponsesRequest["tool_choice"],
): AnthropicToolChoice | undefined {
	if (choice === undefined) return undefined;
	if (choice === "auto") return { type: "auto" };
	if (choice === "required") return { type: "any" };
	if (choice === "none") return { type: "none" };
	if (typeof choice === "object" && choice.type === "function") {
		return { type: "tool", name: choice.name };
	}
	return undefined;
}

function translateContentItem(c: {
	type: string;
	text?: string;
	refusal?: string;
	image_url?: string;
	file_id?: string;
}): AnthropicContent {
	if (c.type === "input_text" || c.type === "output_text") {
		return { type: "text", text: c.text ?? "" };
	}

	if (c.type === "refusal") {
		return { type: "text", text: c.refusal ?? "" };
	}

	if (c.type === "input_image") {
		const imageUrl = c.image_url;
		if (typeof imageUrl === "string") {
			const trimmed = imageUrl.trim();
			const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(trimmed);
			if (dataUrlMatch) {
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: dataUrlMatch[1],
						data: dataUrlMatch[2],
					},
				};
			}
			if (trimmed.length > 0) {
				return { type: "image", source: { type: "url", url: trimmed } };
			}
		}

		if (typeof c.file_id === "string" && c.file_id.length > 0) {
			return { type: "text", text: `[image file_id: ${c.file_id}]` };
		}

		return { type: "text", text: "[image content omitted]" };
	}

	logger.warn(`Unknown content type "${c.type}" — content dropped`);
	return { type: "text", text: "" };
}

function mergeConsecutiveSameRole(
	messages: AnthropicMessage[],
): AnthropicMessage[] {
	const merged: AnthropicMessage[] = [];
	for (const msg of messages) {
		const last = merged[merged.length - 1];
		if (last && last.role === msg.role) {
			last.content.push(...msg.content);
		} else {
			merged.push({ role: msg.role, content: [...msg.content] });
		}
	}
	return merged;
}

export function translateRequestToAnthropic(
	req: ResponsesRequest & { input: ResponseItem[] },
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	const developerBlocks: string[] = [];

	for (const item of req.input) {
		// Captured before any narrowing so the generic catch-all below can log
		// the real runtime type string without needing a cast: once every
		// literal member of the ResponseItem union has been excluded by the
		// branches below, `item` itself narrows to `never`, and `never` has no
		// properties to read from.
		const itemType = item.type;

		if (item.type === "message") {
			const content: AnthropicContent[] = item.content.map((c) =>
				translateContentItem(c),
			);
			// developer role is used by Codex CLI for system-level instructions.
			// Anthropic /v1/messages does not accept this role in the messages array
			// so we extract the text and merge it into the system prompt instead.
			if ((item.role as string) === "developer") {
				for (const c of content) {
					if (c.type === "text") developerBlocks.push(c.text);
				}
				continue;
			}
			messages.push({ role: item.role, content });
			continue;
		}

		if (item.type === "function_call" || item.type === "custom_tool_call") {
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: item.call_id,
				name: item.name,
				input: parseArguments(item.arguments),
			};
			const last = messages[messages.length - 1];
			if (last && last.role === "assistant") {
				last.content.push(toolUseBlock);
			} else {
				messages.push({ role: "assistant", content: [toolUseBlock] });
			}
			continue;
		}

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: item.call_id,
						content: item.output,
					},
				],
			});
			continue;
		}

		if (item.type === "local_shell_call") {
			const toolUseId = item.call_id ?? item.id;
			if (toolUseId === undefined) {
				logger.warn(
					"Dropping local_shell_call with no call_id or id — cannot fabricate a tool_use id",
				);
				continue;
			}
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: toolUseId,
				name: "local_shell",
				input: item.action,
			};
			const last = messages[messages.length - 1];
			if (last && last.role === "assistant") {
				last.content.push(toolUseBlock);
			} else {
				messages.push({ role: "assistant", content: [toolUseBlock] });
			}
			continue;
		}

		if (item.type === "local_shell_call_output") {
			const toolUseId = item.call_id ?? item.id;
			if (toolUseId === undefined) {
				logger.warn(
					"Dropping local_shell_call_output with no call_id/id — cannot map to a tool_result",
				);
				continue;
			}
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: item.output,
					},
				],
			});
			continue;
		}

		if (item.type === "agent_message") {
			const textParts: string[] = [];
			for (const c of item.content) {
				if (c.type === "input_text") {
					textParts.push(c.text);
				} else if (c.type === "encrypted_content") {
					logger.warn(
						`Dropping encrypted_content part of agent_message from "${item.author}" — cannot decode encrypted_content`,
					);
				}
			}
			const text =
				textParts.length > 0
					? `[agent message from ${item.author} to ${item.recipient}]: ${textParts.join("\n\n")}`
					: "(sub-agent message received)";
			messages.push({ role: "user", content: [{ type: "text", text }] });
			continue;
		}

		// reasoning/compaction/compaction_summary/compaction_trigger are
		// modeled as real ResponseItem union members (see types.ts) purely so
		// each gets its own type-specific drop-warning below — they are never
		// translated to Anthropic content. Once these and every other literal
		// member has been excluded, `item` narrows to `never` for the generic
		// catch-all that follows; `itemType` was captured before any
		// narrowing began, so it still holds the real runtime type string.
		if (item.type === "reasoning") {
			logger.warn(
				"Dropping reasoning item — OpenAI reasoning has no signature field and Anthropic verifies thinking-block signatures server-side, so a fabricated signature would 400",
			);
			continue;
		}

		if (item.type === "compaction" || item.type === "compaction_summary") {
			logger.warn(
				`Dropping ${item.type} item — opaque server-encrypted_content blob, cannot decode`,
			);
			continue;
		}

		if (item.type === "compaction_trigger") {
			logger.warn(
				"Dropping compaction_trigger item — zero-payload control signal, no Anthropic mapping",
			);
			continue;
		}

		if (item.type === "additional_tools") {
			// The handler preserves this item in the private Codex passthrough carrier.
			// It intentionally has no Anthropic message-content representation here.
			continue;
		}

		logger.warn(
			`Dropping unhandled Responses input item type "${itemType}" — no Anthropic mapping implemented`,
		);
	}

	const mergedMessages = mergeConsecutiveSameRole(messages);

	const result: AnthropicRequest = {
		model: mapGptModelToClaudeFamily(req.model),
		messages: mergedMessages,
		max_tokens: req.max_output_tokens ?? 4096,
	};

	// Merge developer-role blocks and req.instructions into system prompt.
	const systemParts: string[] = [];
	if (developerBlocks.length > 0)
		systemParts.push(developerBlocks.join("\n\n"));
	if (req.instructions !== undefined) systemParts.push(req.instructions);
	if (systemParts.length > 0) result.system = systemParts.join("\n\n");

	if (req.stream !== undefined) {
		result.stream = req.stream;
	}

	const translatedTools =
		req.tools && req.tools.length > 0 ? translateTools(req.tools) : [];
	if (translatedTools.length > 0) {
		result.tools = translatedTools;
		const toolChoice = translateToolChoice(req.tool_choice);
		if (toolChoice !== undefined) {
			result.tool_choice = toolChoice;
		}
	}

	return result;
}
