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
	// Per-candidate next-suffix-to-try, so N originals colliding on the same
	// sanitized candidate cost amortized O(1) each instead of O(N) (which
	// makes N such originals O(N^2) overall) — restarting the suffix counter
	// at 1 for every collision was the bug.
	const nextSuffix = new Map<string, number>();
	return (original) => {
		const existing = seen.get(original);
		if (existing !== undefined) return existing;
		let candidate = ANTHROPIC_TOOL_ID_RE.test(original)
			? original
			: original.replace(/[^A-Za-z0-9_-]/g, "_");
		if (candidate.length === 0) candidate = "tool_id";
		let unique = candidate;
		if (used.has(unique)) {
			let n = nextSuffix.get(candidate) ?? 1;
			unique = `${candidate}_${n}`;
			while (used.has(unique)) {
				n++;
				unique = `${candidate}_${n}`;
			}
			nextSuffix.set(candidate, n + 1);
		}
		seen.set(original, unique);
		used.add(unique);
		return unique;
	};
}

function translateTools(
	tools: unknown[],
	emitWarn: (message: string) => void,
): AnthropicTool[] {
	const result: AnthropicTool[] = [];
	for (const rawTool of tools) {
		if (
			rawTool === null ||
			typeof rawTool !== "object" ||
			Array.isArray(rawTool)
		) {
			emitWarn("Dropping malformed tool definition — expected an object");
			continue;
		}
		const tool = rawTool as Record<string, unknown>;
		if (tool.type !== "function") {
			emitWarn(`Skipping unsupported/built-in tool type: ${String(tool.type)}`);
			continue;
		}
		if (typeof tool.name !== "string" || tool.name.length === 0) {
			emitWarn("Dropping malformed function tool with no usable name");
			continue;
		}
		if (
			tool.description !== undefined &&
			typeof tool.description !== "string"
		) {
			emitWarn(`Dropping malformed function tool "${tool.name}" description`);
			continue;
		}
		if (
			tool.parameters !== undefined &&
			tool.parameters !== null &&
			(typeof tool.parameters !== "object" || Array.isArray(tool.parameters))
		) {
			emitWarn(`Dropping malformed function tool "${tool.name}" parameters`);
			continue;
		}
		result.push({
			name: tool.name,
			description: tool.description,
			input_schema:
				(tool.parameters as Record<string, unknown> | undefined) ?? {},
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

// Validates and translates a single message content part. Deliberately does
// NOT call logger.warn — a huge malformed content array (e.g. 100k objects of
// an unknown/invalid shape) must not turn into 100k synchronous log calls (a
// request→log amplification DoS); callers batch rejections into a single
// summary warn instead. Also deliberately rejects rather than coercing
// non-string text/refusal fields (e.g. `{type:"input_text", text:1}`) — `??`
// alone lets a truthy non-string value pass through and reach Anthropic,
// which 400s the whole request on a non-string content field.
function translateContentItem(c: {
	type: unknown;
	text?: unknown;
	refusal?: unknown;
	image_url?: unknown;
	file_id?: unknown;
}): { ok: true; block: AnthropicContent } | { ok: false; reason: string } {
	if (typeof c.type !== "string") {
		return { ok: false, reason: "content type is not a string" };
	}
	if (c.type === "input_text" || c.type === "output_text") {
		if (typeof c.text !== "string") {
			return { ok: false, reason: `${c.type} has non-string text` };
		}
		if (c.text.length === 0) {
			// Anthropic 400s a request containing an empty text block.
			return { ok: false, reason: `${c.type} has empty text` };
		}
		return { ok: true, block: { type: "text", text: c.text } };
	}

	if (c.type === "refusal") {
		if (typeof c.refusal !== "string") {
			return { ok: false, reason: "refusal has non-string refusal" };
		}
		if (c.refusal.length === 0) {
			// Anthropic 400s a request containing an empty text block.
			return { ok: false, reason: "refusal has empty refusal" };
		}
		return { ok: true, block: { type: "text", text: c.refusal } };
	}

	if (c.type === "input_image") {
		const imageUrl = c.image_url;
		if (typeof imageUrl === "string") {
			const trimmed = imageUrl.trim();
			const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(trimmed);
			if (dataUrlMatch) {
				return {
					ok: true,
					block: {
						type: "image",
						source: {
							type: "base64",
							media_type: dataUrlMatch[1],
							data: dataUrlMatch[2],
						},
					},
				};
			}
			if (trimmed.length > 0) {
				return {
					ok: true,
					block: { type: "image", source: { type: "url", url: trimmed } },
				};
			}
		}

		if (typeof c.file_id === "string" && c.file_id.length > 0) {
			return {
				ok: true,
				block: { type: "text", text: `[image file_id: ${c.file_id}]` },
			};
		}

		return {
			ok: true,
			block: { type: "text", text: "[image content omitted]" },
		};
	}

	return { ok: false, reason: `unknown content type "${c.type}"` };
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
	// must survive sanitization, so the mapper and side-specific consumption
	// tracking are built once per request, never globally.
	const mapToolId = makeToolIdMapper();
	const consumedCallIds = new Set<string>();
	const consumedResultIds = new Set<string>();

	// Request-scoped warning budget covers both input and tool translation.
	// This prevents either independently bounded collection from amplifying a
	// single admitted request into unbounded synchronous logging.
	let warnCount = 0;
	const MAX_REQUEST_WARNS = 50;
	const emitWarn = (msg: string) => {
		warnCount++;
		if (warnCount <= MAX_REQUEST_WARNS) logger.warn(msg);
	};

	for (const rawItem of req.input as unknown[]) {
		if (
			rawItem === null ||
			typeof rawItem !== "object" ||
			Array.isArray(rawItem)
		) {
			emitWarn("Dropping malformed Responses input item — expected an object");
			continue;
		}
		const item = rawItem as ResponseItem;
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
				emitWarn(
					`Dropping message with role "${item.role}" — content is neither a string nor an array, cannot translate`,
				);
				continue;
			}

			const content: AnthropicContent[] = [];
			let malformedCount = 0;
			let rejectedCount = 0;
			for (const rawC of parts) {
				if (rawC === null || typeof rawC !== "object" || Array.isArray(rawC)) {
					malformedCount++;
					continue;
				}
				const res = translateContentItem(
					rawC as {
						type: unknown;
						text?: unknown;
						refusal?: unknown;
						image_url?: unknown;
						file_id?: unknown;
					},
				);
				if (res.ok) {
					content.push(res.block);
				} else {
					rejectedCount++;
				}
			}
			// At most two summary warns for the whole batch, never one per element.
			if (malformedCount > 0) {
				emitWarn(
					`Dropped ${malformedCount} malformed content part(s) in message with role "${item.role}" — not objects`,
				);
			}
			if (rejectedCount > 0) {
				emitWarn(
					`Dropped ${rejectedCount} unsupported/invalid content part(s) in message with role "${item.role}"`,
				);
			}
			if (malformedCount === 0 && rejectedCount === 0 && content.length === 0) {
				// Only warn here when nothing was malformed or rejected either (i.e.
				// the parts array was empty to begin with) — the two summary warns
				// above already explain a filtered-to-empty result.
				emitWarn(
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
				emitWarn(
					`Dropping ${item.type} with no usable call_id — cannot fabricate a tool_use id`,
				);
				continue;
			}
			if (consumedCallIds.has(toolUseId)) {
				emitWarn(
					`Dropping duplicate ${item.type} call_id "${toolUseId}" — tool_use already emitted`,
				);
				continue;
			}
			consumedCallIds.add(toolUseId);
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
				emitWarn(
					`Dropping ${item.type} with no usable call_id — cannot map to a tool_result`,
				);
				continue;
			}
			if (consumedResultIds.has(toolUseId)) {
				emitWarn(
					`Dropping duplicate ${item.type} call_id "${toolUseId}" — tool_result already emitted`,
				);
				continue;
			}
			consumedResultIds.add(toolUseId);
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
				emitWarn(
					"Dropping local_shell_call with no usable call_id or id — cannot fabricate a tool_use id",
				);
				continue;
			}
			if (consumedCallIds.has(toolUseId)) {
				emitWarn(
					`Dropping duplicate local_shell_call call_id "${toolUseId}" — tool_use already emitted`,
				);
				continue;
			}
			consumedCallIds.add(toolUseId);
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
				emitWarn(
					"Dropping local_shell_call_output with no usable call_id/id — cannot map to a tool_result",
				);
				continue;
			}
			if (consumedResultIds.has(toolUseId)) {
				emitWarn(
					`Dropping duplicate local_shell_call_output call_id "${toolUseId}" — tool_result already emitted`,
				);
				continue;
			}
			consumedResultIds.add(toolUseId);
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
				emitWarn(
					`Dropping agent_message from "${item.author}" — content is not an array, cannot synthesize text`,
				);
				continue;
			}
			const parts = item.content as unknown[];
			const textParts: string[] = [];
			let malformedCount = 0;
			let encryptedCount = 0;
			let rejectedCount = 0;
			for (const rawC of parts) {
				if (rawC === null || typeof rawC !== "object" || Array.isArray(rawC)) {
					malformedCount++;
					continue;
				}
				const c = rawC as {
					type: string;
					text: unknown;
					encrypted_content: unknown;
				};
				if (c.type === "input_text" && typeof c.text === "string") {
					textParts.push(c.text);
				} else if (
					c.type === "encrypted_content" &&
					typeof c.encrypted_content === "string" &&
					c.encrypted_content.length > 0
				) {
					encryptedCount++;
				} else if (c.type === "encrypted_content" || c.type === "input_text") {
					// input_text with a non-string text field — same malformed-input
					// guard as the message branch's translateContentItem, folded into
					// this branch's existing single summary warn rather than a new
					// per-element one.
					malformedCount++;
				} else {
					// A truly-unknown-type object (not input_text, not
					// encrypted_content) — counted separately from malformedCount
					// (non-objects) so it can't silently fall through and still
					// trigger the "(sub-agent message received)" placeholder below.
					rejectedCount++;
				}
			}
			// One summary warn per batch, not one per element.
			if (malformedCount > 0) {
				emitWarn(
					`Dropped ${malformedCount} malformed content part(s) of agent_message from "${item.author}" — invalid shape`,
				);
			}
			if (encryptedCount > 0) {
				emitWarn(
					`Dropped ${encryptedCount} encrypted_content part(s) of agent_message from "${item.author}" — cannot decode encrypted_content`,
				);
			}
			if (rejectedCount > 0) {
				emitWarn(
					`Dropped ${rejectedCount} unsupported content part(s) of agent_message from "${item.author}"`,
				);
			}
			if (textParts.length > 0) {
				const text = `[agent message from ${item.author} to ${item.recipient}]: ${textParts.join("\n\n")}`;
				messages.push({ role: "user", content: [{ type: "text", text }] });
				continue;
			}
			if (encryptedCount > 0) {
				// A real encrypted part was present but undecodable — surface that
				// something was received rather than dropping it silently.
				messages.push({
					role: "user",
					content: [{ type: "text", text: "(sub-agent message received)" }],
				});
			}
			// Nothing usable (only junk/malformed, no encrypted part either) — do
			// not fabricate a placeholder message from pure junk; drop the item.
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
			emitWarn(
				"Dropping reasoning item — OpenAI reasoning has no signature field and Anthropic verifies thinking-block signatures server-side, so a fabricated signature would 400",
			);
			continue;
		}

		if (item.type === "compaction" || item.type === "compaction_summary") {
			emitWarn(
				`Dropping ${item.type} item — opaque server-encrypted_content blob, cannot decode`,
			);
			continue;
		}

		if (item.type === "compaction_trigger") {
			emitWarn(
				"Dropping compaction_trigger item — zero-payload control signal, no Anthropic mapping",
			);
			continue;
		}

		emitWarn(
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
		Array.isArray(req.tools) && req.tools.length > 0
			? translateTools(req.tools, emitWarn)
			: [];
	if (translatedTools.length > 0) {
		result.tools = translatedTools;
		const toolChoice = translateToolChoice(req.tool_choice);
		if (toolChoice !== undefined) {
			result.tool_choice = toolChoice;
		}
	}

	if (warnCount > MAX_REQUEST_WARNS) {
		logger.warn(
			`${warnCount - MAX_REQUEST_WARNS} further translation warning(s) suppressed`,
		);
	}

	return result;
}
