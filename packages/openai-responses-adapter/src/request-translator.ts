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

// Bounds per-item content-array iteration so a huge malformed content array
// (e.g. millions of nulls) cannot turn into unbounded synchronous log calls
// or unbounded iteration — a request→log amplification DoS.
const MAX_MESSAGE_CONTENT_PARTS = 100_000;

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

// Tool IDs (call_id / id) are pairing keys emitted verbatim onto the wire as
// Anthropic id/tool_use_id, which MUST be strings — a truthy non-string
// (number, object, array) would otherwise pass a bare truthiness check and
// get emitted, and Anthropic 400s the whole request. Centralize the
// string-and-nonempty check so every call site drops-with-warn consistently.
function asToolId(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Anthropic tool_use/tool_result ids must match this grammar. OpenAI call_ids
// are not guaranteed to (e.g. "call:1"), so a non-conforming id must be
// sanitized rather than emitted verbatim — an unsanitized id 400s the whole
// request.
const ANTHROPIC_TOOL_ID_RE = /^[A-Za-z0-9_-]+$/;

// Builds a request-scoped id mapper: sanitizes grammar-invalid tool ids while
// keeping tool_use/tool_result pairing intact (same original id → same
// emitted id) and collision-free across the request. Scoped per-request
// (not module-level) so unrelated requests never share mapping state.
function makeToolIdMapper(): (original: string) => string {
	const seen = new Map<string, string>(); // original -> emitted (preserves tool_use/tool_result pairing)
	const used = new Set<string>(); // emitted values, for collision-free assignment
	return (original) => {
		const existing = seen.get(original);
		if (existing !== undefined) return existing;
		let candidate = ANTHROPIC_TOOL_ID_RE.test(original)
			? original
			: original.replace(/[^A-Za-z0-9_-]/g, "_");
		if (candidate.length === 0) candidate = "tool_id";
		let unique = candidate;
		let n = 1;
		while (used.has(unique)) unique = `${candidate}_${n++}`;
		seen.set(original, unique);
		used.add(unique);
		return unique;
	};
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

// Append an assistant-authored block (a tool_use) to the trailing assistant
// message, or open a new assistant message when the previous item was not the
// assistant's. Shared by the function_call/custom_tool_call and
// local_shell_call branches so both keep identical merge behavior.
function appendAssistantBlock(
	messages: AnthropicMessage[],
	block: AnthropicContent,
): void {
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") {
		last.content.push(block);
	} else {
		messages.push({ role: "assistant", content: [block] });
	}
}

export function translateRequestToAnthropic(
	req: ResponsesRequest & { input: ResponseItem[] },
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	const developerBlocks: string[] = [];
	// Request-scoped: pairing (function_call <-> function_call_output etc.)
	// must survive sanitization, so the mapper is built once per request, not
	// globally.
	const mapToolId = makeToolIdMapper();

	for (const item of req.input) {
		// Captured before any narrowing so the generic catch-all below can log
		// the real runtime type string without needing a cast: once every
		// literal member of the ResponseItem union has been excluded by the
		// branches below, `item` itself narrows to `never`, and `never` has no
		// properties to read from.
		const itemType = item.type;

		if (item.type === "message") {
			// OpenAI permits content as either a string (shorthand for a single
			// input_text part) or an array of structured parts; normalize both
			// into a parts array before validating each part below. Anything
			// else is runtime-malformed input (content is type-required) that
			// would throw on the loop below — drop-with-warn instead.
			let parts: unknown[];
			if (typeof item.content === "string") {
				parts = [{ type: "input_text", text: item.content }];
			} else if (Array.isArray(item.content)) {
				parts = item.content as unknown[];
			} else {
				logger.warn(
					`Dropping message with role "${item.role}" — content is neither a string nor an array, cannot translate`,
				);
				continue;
			}

			// Bound the work below: a huge malformed content array (e.g.
			// millions of nulls) must not turn into unbounded iteration or
			// unbounded synchronous log calls (a request→log amplification DoS).
			if (parts.length > MAX_MESSAGE_CONTENT_PARTS) {
				logger.warn(
					`Message with role "${item.role}" has ${parts.length} content parts — truncating to the first ${MAX_MESSAGE_CONTENT_PARTS}`,
				);
				parts = parts.slice(0, MAX_MESSAGE_CONTENT_PARTS);
			}

			const content: AnthropicContent[] = [];
			let malformedCount = 0;
			for (const rawC of parts) {
				if (rawC === null || typeof rawC !== "object" || Array.isArray(rawC)) {
					malformedCount++;
					continue;
				}
				content.push(
					translateContentItem(
						rawC as {
							type: string;
							text?: string;
							refusal?: string;
							image_url?: string;
							file_id?: string;
						},
					),
				);
			}
			if (malformedCount > 0) {
				// One summary warn for the whole batch, not one per element — see
				// MAX_MESSAGE_CONTENT_PARTS comment above.
				logger.warn(
					`Dropped ${malformedCount} malformed content part(s) in message with role "${item.role}" — not objects`,
				);
			} else if (content.length === 0) {
				// Only warn here when nothing was malformed either (i.e. the parts
				// array was empty to begin with) — the malformed-count warn above
				// already explains an all-malformed empty result.
				logger.warn(
					`Dropping message with role "${item.role}" — no usable content parts after filtering`,
				);
			}

			if (content.length === 0) {
				// Anthropic rejects a message with an empty content array.
				continue;
			}

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
			// call_id is the sole pairing key with the matching *_output item
			// (its type has no `id` fallback), so an empty-string call_id would
			// emit a tool_use whose id collides with any other empty-id call and
			// can never pair with its result — drop-with-warn instead.
			const toolUseId = asToolId(item.call_id);
			if (toolUseId === undefined) {
				logger.warn(
					`Dropping ${item.type} with no usable call_id — cannot fabricate a tool_use id`,
				);
				continue;
			}
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: mapToolId(toolUseId),
				name: item.name,
				input: parseArguments(item.arguments),
			};
			appendAssistantBlock(messages, toolUseBlock);
			continue;
		}

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			// Empty-string call_id would emit a tool_result whose tool_use_id can
			// never match a real tool_use block (mirrors the call-side guard above).
			const toolUseId = asToolId(item.call_id);
			if (toolUseId === undefined) {
				logger.warn(
					`Dropping ${item.type} with no usable call_id — cannot map to a tool_result`,
				);
				continue;
			}
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: mapToolId(toolUseId),
						content: item.output,
					},
				],
			});
			continue;
		}

		if (item.type === "local_shell_call") {
			// asToolId (not `??`/`||` on the raw values) so an empty-string or
			// non-string call_id/id — which would produce an unusable or
			// invalid tool_use id on the wire — falls through to the
			// drop-with-warn below instead of being treated as present.
			const toolUseId = asToolId(item.call_id) ?? asToolId(item.id);
			if (toolUseId === undefined) {
				logger.warn(
					"Dropping local_shell_call with no usable call_id or id — cannot fabricate a tool_use id",
				);
				continue;
			}
			// action is type-required, but runtime-malformed input can omit it or
			// send a non-object (e.g. a bare command string); Anthropic
			// tool_use.input must be a JSON object, so coerce anything else to {}.
			const rawAction: unknown = item.action;
			const input =
				rawAction !== null &&
				typeof rawAction === "object" &&
				!Array.isArray(rawAction)
					? rawAction
					: {};
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: mapToolId(toolUseId),
				name: "local_shell",
				input,
			};
			appendAssistantBlock(messages, toolUseBlock);
			continue;
		}

		if (item.type === "local_shell_call_output") {
			// asToolId (not `??`/`||` on the raw values) so an empty-string or
			// non-string call_id/id falls through to the drop-with-warn
			// instead of producing a tool_result whose tool_use_id can never
			// match a real tool_use block.
			const toolUseId = asToolId(item.call_id) ?? asToolId(item.id);
			if (toolUseId === undefined) {
				logger.warn(
					"Dropping local_shell_call_output with no usable call_id/id — cannot map to a tool_result",
				);
				continue;
			}
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: mapToolId(toolUseId),
						content: item.output,
					},
				],
			});
			continue;
		}

		if (item.type === "agent_message") {
			// Guard runtime-malformed input: content is type-required, but a
			// non-array (undefined/null) here would throw on the for..of below.
			if (!Array.isArray(item.content)) {
				logger.warn(
					`Dropping agent_message from "${item.author}" — content is not an array, cannot synthesize text`,
				);
				continue;
			}
			let parts = item.content as unknown[];
			// Bound the work below — see MAX_MESSAGE_CONTENT_PARTS comment in the
			// message branch above.
			if (parts.length > MAX_MESSAGE_CONTENT_PARTS) {
				logger.warn(
					`agent_message from "${item.author}" has ${parts.length} content parts — truncating to the first ${MAX_MESSAGE_CONTENT_PARTS}`,
				);
				parts = parts.slice(0, MAX_MESSAGE_CONTENT_PARTS);
			}
			const textParts: string[] = [];
			let malformedCount = 0;
			let encryptedCount = 0;
			for (const rawC of parts) {
				if (rawC === null || typeof rawC !== "object" || Array.isArray(rawC)) {
					malformedCount++;
					continue;
				}
				const c = rawC as { type: string; text: string };
				if (c.type === "input_text") {
					textParts.push(c.text);
				} else if (c.type === "encrypted_content") {
					encryptedCount++;
				}
			}
			// One summary warn per batch, not one per element — see
			// MAX_MESSAGE_CONTENT_PARTS comment in the message branch above.
			if (malformedCount > 0) {
				logger.warn(
					`Dropped ${malformedCount} malformed content part(s) of agent_message from "${item.author}" — not objects`,
				);
			}
			if (encryptedCount > 0) {
				logger.warn(
					`Dropped ${encryptedCount} encrypted_content part(s) of agent_message from "${item.author}" — cannot decode encrypted_content`,
				);
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
