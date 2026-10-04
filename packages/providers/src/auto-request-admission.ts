import { isDeepStrictEqual } from "node:util";
import {
	hasForcedToolChoice,
	supportsForcedToolChoice,
} from "@better-ccflare/core";
import type { QualityAdmissionDecision } from "@better-ccflare/types";
import {
	type AutoCatalogEvidence,
	type AutoModelCapabilities,
	type AutoModelTargetEvidence,
	isAutoCatalogEvidenceCurrent,
	positiveSafeCapacity,
	resolveAutoModelTargets,
} from "./auto-model-capabilities";
import {
	ADVISOR_SERVER_TOOL_NAME,
	deriveNativeAnthropicToolRequirement,
	deriveServerToolRequirement,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
	NATIVE_ANTHROPIC_PASSTHROUGH_TOOL_TYPES,
} from "./server-tool-capabilities";
import type {
	Provider,
	ProviderServerToolCapabilityMaterializationContext,
} from "./types";

/** Arithmetic only, NOT an evidence issuer or an admission override. The caller
 * supplies an accounted input budget (which may be an explicitly labelled estimate).
 * requestedOutput is an accounting reserve, not a wire-enforced generation cap.
 * A catalog outputLimit checks that reserve, but does not replace it in the budget.
 * Estimated fit does not guarantee actual generation stays within the reserve.
 */
export function decideAutoContextFit(input: {
	inputUpperBound: unknown;
	requestedOutput: unknown;
	contextLimit: unknown;
	outputLimit: unknown;
	/** Explicitly delegates acceptance/length control for a null ceiling; keeps the full reserve. */
	outputLimitMode?: "provider-managed";
}): QualityAdmissionDecision {
	const output = positiveSafeCapacity(input.requestedOutput);
	const ceiling = positiveSafeCapacity(input.outputLimit);
	if (output !== null && ceiling !== null && output > ceiling)
		return { status: "reject", reason: "output-unsupported" };
	const context = positiveSafeCapacity(input.contextLimit);
	const tokens = input.inputUpperBound;
	if (
		context === null ||
		output === null ||
		(ceiling === null &&
			!(
				input.outputLimitMode === "provider-managed" &&
				input.outputLimit === null
			)) ||
		typeof tokens !== "number" ||
		!Number.isSafeInteger(tokens) ||
		tokens < 0
	)
		return { status: "unknown", reason: "input-accounting-unknown" };
	return tokens > context - output
		? { status: "reject", reason: "context-unsupported" }
		: { status: "admit" };
}

const requirementsBrand: unique symbol = Symbol("AutoRequestRequirements");
export interface AutoRequestRequirements {
	readonly [requirementsBrand]: true;
}
// A private serialized snapshot cannot be weakened by translation or caller mutation.
const originals = new WeakMap<AutoRequestRequirements, string>();
export function captureAutoRequestRequirements(
	body: unknown,
): AutoRequestRequirements {
	const handle: AutoRequestRequirements = Object.freeze({
		[requirementsBrand]: true as const,
	});
	try {
		const serialized = JSON.stringify(body);
		if (serialized && record(JSON.parse(serialized)))
			originals.set(handle, serialized);
	} catch {
		/* Malformed/non-JSON input remains unknown. */
	}
	return handle;
}
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export interface AutoRequestAdmissionInput {
	readonly requirements: AutoRequestRequirements;
	readonly target: AutoModelTargetEvidence;
	readonly catalog: AutoCatalogEvidence | null;
	/** Exact parsed physical request, after provider transformation. */
	readonly finalBody: unknown;
	/** Whether the candidate account is first-party Anthropic (KTD2). Only such a
	 * candidate may carry advisor content; an absent value counts as false. */
	readonly firstPartyAnthropic?: boolean;
	/** Trusted provider implementation and selected account; not request-supplied proof. */
	readonly hostedTools?: {
		readonly provider: Provider;
		readonly context: Omit<
			ProviderServerToolCapabilityMaterializationContext,
			"requirements" | "physicalModel"
		>;
	};
}

/** Re-resolve the exact retained target; never trust a target alone or a copied
 * capability payload. This still does not establish selected-credential epoch.
 */
export function revalidateAutoTarget(
	input: Pick<AutoRequestAdmissionInput, "target" | "catalog">,
): AutoModelTargetEvidence | null {
	const { target, catalog } = input;
	if (
		!catalog ||
		!isAutoCatalogEvidenceCurrent(catalog) ||
		catalog.accountId !== target.accountId ||
		catalog.provider !== target.provider ||
		catalog.revision !== target.catalogRevision
	)
		return null;
	const current = resolveAutoModelTargets(
		catalog,
		target.line,
		target.physicalModel,
	).stored;
	return current?.evidenceRef === target.evidenceRef ? current : null;
}

function modalities(
	body: Record<string, unknown>,
	native: boolean,
	advisor: boolean,
): Set<string> | null {
	const found = new Set<string>();
	const visit = (value: unknown): boolean => {
		if (typeof value === "string") {
			found.add("text");
			return true;
		}
		if (Array.isArray(value)) return value.every(visit);
		const block = record(value);
		if (!block) return false;
		switch (block.type) {
			case "text":
				found.add("text");
				return (
					typeof block.text === "string" &&
					onlyKeys(block, ["type", "text", "cache_control"])
				);
			case "thinking":
				found.add("text");
				return (
					native &&
					typeof block.thinking === "string" &&
					typeof block.signature === "string" &&
					block.signature.length > 0 &&
					onlyKeys(block, ["type", "thinking", "signature"])
				);
			case "image":
				found.add("image");
				return true;
			case "audio":
				found.add("audio");
				return true;
			case "video":
				found.add("video");
				return true;
			case "document": {
				const source = record(block.source);
				if (source?.media_type === "application/pdf") {
					found.add("pdf");
					return true;
				}
				return false; // A URL/file has no established content type.
			}
			case "tool_result":
				return (
					typeof block.tool_use_id === "string" &&
					onlyKeys(block, [
						"type",
						"tool_use_id",
						"content",
						"is_error",
						"cache_control",
					]) &&
					(block.is_error === undefined ||
						typeof block.is_error === "boolean") &&
					visit(block.content)
				);
			case "tool_use":
				found.add("text");
				return (
					typeof block.id === "string" &&
					typeof block.name === "string" &&
					record(block.input) !== null &&
					onlyKeys(block, ["type", "id", "name", "input", "cache_control"])
				);
			case "server_tool_use":
				if (!advisor || block.name !== ADVISOR_SERVER_TOOL_NAME) return false;
				found.add("text");
				return (
					typeof block.id === "string" &&
					record(block.input) !== null &&
					onlyKeys(block, ["type", "id", "name", "input", "cache_control"])
				);
			case "advisor_tool_result":
				if (!advisor) return false;
				found.add("text");
				return (
					typeof block.tool_use_id === "string" &&
					record(block.content) !== null &&
					onlyKeys(block, ["type", "tool_use_id", "content", "cache_control"])
				);
			default:
				return false;
		}
	};
	if (body.system !== undefined && !visit(body.system)) return null;
	if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
	for (const message of body.messages) {
		const entry = record(message);
		if (!entry || !visit(entry.content)) return null;
	}
	return found;
}

function onlyKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/** Client function tools are supported by the native protocol and Codex's
 * existing function adapter. This does NOT infer hosted-tool support from a flag.
 * Unknown tool variants/schemas are deliberately outside this contract.
 */
function clientTools(
	body: Record<string, unknown>,
	native: boolean,
	advisor: boolean,
): boolean {
	return (
		body.tools === undefined ||
		(Array.isArray(body.tools) &&
			body.tools.every((value) => {
				const tool = record(value);
				// The advisor declaration is a typed passthrough tool, not a client
				// function: the first-party upstream executes it and the preservation
				// check below keeps it byte-equal.
				if (
					advisor &&
					tool &&
					typeof tool.type === "string" &&
					NATIVE_ANTHROPIC_PASSTHROUGH_TOOL_TYPES.includes(tool.type)
				)
					return (
						tool.name === ADVISOR_SERVER_TOOL_NAME &&
						typeof tool.model === "string" &&
						onlyKeys(tool, [
							"type",
							"name",
							"model",
							"max_uses",
							"caching",
							"cache_control",
						])
					);
				return (
					tool &&
					onlyKeys(tool, [
						"name",
						"description",
						"input_schema",
						"cache_control",
						...(native ? ["defer_loading"] : []),
					]) &&
					(tool.defer_loading === undefined ||
						typeof tool.defer_loading === "boolean") &&
					typeof tool.name === "string" &&
					tool.name.length > 0 &&
					(tool.description === undefined ||
						typeof tool.description === "string") &&
					record(tool.input_schema)?.type === "object"
				);
			}))
	);
}

/** Native protocol shapes whose entire JSON representation can be conservatively
 * counted. This is not permission to rewrite an unsupported combination to fit.
 */
function nativeTextConfiguration(body: Record<string, unknown>): boolean {
	if (body.thinking !== undefined) {
		const thinking = record(body.thinking);
		if (
			!thinking ||
			!onlyKeys(thinking, ["type"]) ||
			!["adaptive", "disabled"].includes(String(thinking.type))
		)
			return false;
	}
	if (body.output_config !== undefined) {
		const output = record(body.output_config);
		if (
			!output ||
			!onlyKeys(output, ["effort"]) ||
			!["low", "medium", "high", "max"].includes(String(output.effort))
		)
			return false;
	}
	if (body.context_management !== undefined) {
		const context = record(body.context_management);
		if (
			!context ||
			!onlyKeys(context, ["edits"]) ||
			!Array.isArray(context.edits)
		)
			return false;
		for (const value of context.edits) {
			const edit = record(value);
			if (!edit || !onlyKeys(edit, ["type"])) return false;
			if (edit.type === "clear_thinking_20251015") {
				if (record(body.thinking)?.type !== "adaptive") return false;
			} else if (edit.type !== "clear_tool_uses_20250919") return false;
		}
	}
	return true;
}

function textBlocks(value: unknown, separator: string): string | null {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return null;
	const texts: string[] = [];
	for (const item of value) {
		const block = record(item);
		if (
			!block ||
			block.type !== "text" ||
			typeof block.text !== "string" ||
			!onlyKeys(block, ["type", "text", "cache_control"])
		)
			return null;
		texts.push(block.text);
	}
	return texts.join(separator);
}

/** Compare semantic content against the existing Codex adapter's supported
 * ordinary text/function mapping. This does not translate or re-run its stateful
 * orchestration machinery. Dropped tools, sanitized arguments, truncated input,
 * opaque replay items and schema changes all fail this comparison.
 */
function codexPreserves(
	original: Record<string, unknown>,
	final: Record<string, unknown>,
	capabilities: AutoModelCapabilities | null,
): boolean {
	if (Object.hasOwn(original, "output_config")) {
		const output = record(original.output_config);
		const reasoning = record(final.reasoning);
		if (
			!output ||
			!onlyKeys(output, ["effort"]) ||
			typeof output.effort !== "string" ||
			!capabilities?.supportedReasoningEfforts?.some(
				(effort) => effort === output.effort,
			) ||
			!reasoning ||
			!onlyKeys(reasoning, ["effort"]) ||
			reasoning.effort !== output.effort
		)
			return false;
	}
	if (
		!onlyKeys(original, [
			"model",
			"messages",
			"system",
			"tools",
			"tool_choice",
			"max_tokens",
			"stream",
			"metadata",
			"output_config",
		]) ||
		!onlyKeys(final, [
			"model",
			"input",
			"instructions",
			"tools",
			"tool_choice",
			"parallel_tool_calls",
			"max_output_tokens",
			"stream",
			"store",
			"reasoning",
			"include",
			"prompt_cache_key",
		])
	)
		return false;
	const system =
		original.system === undefined ? "" : textBlocks(original.system, "\n\n");
	if (
		system === null ||
		final.instructions !== (system || "You are a helpful assistant.")
	)
		return false;
	if (!Array.isArray(original.messages) || !Array.isArray(final.input))
		return false;
	const expected: unknown[] = [];
	for (const value of original.messages) {
		const message = record(value);
		if (
			!message ||
			!onlyKeys(message, ["role", "content"]) ||
			!["user", "assistant", "system", "developer"].includes(
				String(message.role),
			)
		)
			return false;
		const role = message.role === "developer" ? "system" : message.role;
		const blocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		if (!Array.isArray(blocks)) return false;
		for (const value of blocks) {
			const block = record(value);
			if (!block) return false;
			if (
				block.type === "text" &&
				typeof block.text === "string" &&
				onlyKeys(block, ["type", "text", "cache_control"])
			) {
				expected.push(["text", role, block.text]);
			} else if (
				block.type === "tool_use" &&
				role === "assistant" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				record(block.input) &&
				onlyKeys(block, ["type", "id", "name", "input", "cache_control"])
			) {
				expected.push(["call", block.id, block.name, block.input]);
			} else if (
				block.type === "tool_result" &&
				role === "user" &&
				typeof block.tool_use_id === "string" &&
				onlyKeys(block, [
					"type",
					"tool_use_id",
					"content",
					"is_error",
					"cache_control",
				])
			) {
				const content = textBlocks(block.content, "\n");
				if (content === null) return false;
				expected.push([
					"result",
					block.tool_use_id,
					`${block.is_error === true ? "[tool error] " : ""}${content}`,
				]);
			} else return false;
		}
	}
	const actual: unknown[] = [];
	for (const value of final.input) {
		const item = record(value);
		if (!item) return false;
		if (
			(item.type === undefined || item.type === "message") &&
			Array.isArray(item.content) &&
			onlyKeys(item, ["type", "role", "content"])
		) {
			for (const value of item.content) {
				const block = record(value);
				if (
					!block ||
					block.type !==
						(item.role === "assistant" ? "output_text" : "input_text") ||
					typeof block.text !== "string" ||
					!onlyKeys(block, ["type", "text"])
				)
					return false;
				actual.push(["text", item.role, block.text]);
			}
		} else if (
			item.type === "function_call" &&
			typeof item.arguments === "string" &&
			onlyKeys(item, ["type", "call_id", "name", "arguments", "status"])
		) {
			try {
				actual.push([
					"call",
					item.call_id,
					item.name,
					JSON.parse(item.arguments),
				]);
			} catch {
				return false;
			}
		} else if (
			item.type === "function_call_output" &&
			typeof item.output === "string" &&
			onlyKeys(item, ["type", "call_id", "output", "status"])
		) {
			actual.push(["result", item.call_id, item.output]);
		} else return false;
	}
	if (!isDeepStrictEqual(expected, actual)) return false;
	const tools = (original.tools ?? []) as Record<string, unknown>[];
	const finalTools = final.tools ?? [];
	if (!Array.isArray(finalTools) || tools.length !== finalTools.length)
		return false;
	for (const [index, tool] of tools.entries()) {
		const translated = record(finalTools[index]);
		if (
			!translated ||
			!onlyKeys(translated, [
				"type",
				"name",
				"description",
				"parameters",
				"strict",
			]) ||
			translated.type !== "function" ||
			translated.name !== tool.name ||
			translated.description !== tool.description ||
			translated.strict !== false ||
			!isDeepStrictEqual(translated.parameters, tool.input_schema)
		)
			return false;
	}
	const choice = record(original.tool_choice);
	if (
		original.tool_choice !== undefined &&
		(!choice ||
			!onlyKeys(choice, ["type", "name", "disable_parallel_tool_use"]))
	)
		return false;
	let expectedChoice: unknown;
	if (choice) {
		if (
			choice.type === "tool" &&
			tools.some((tool) => tool.name === choice.name)
		)
			expectedChoice = { type: "function", name: choice.name };
		else if (choice.type === "any") expectedChoice = "required";
		else if (choice.type === "auto" || choice.type === "none")
			expectedChoice = choice.type;
		else return false;
	}
	return (
		isDeepStrictEqual(expectedChoice, final.tool_choice) &&
		(choice?.disable_parallel_tool_use === true
			? final.parallel_tool_calls === false
			: final.parallel_tool_calls === undefined)
	);
}

/** Evaluate original requirements before final representation, so translation
 * cannot hide images, tools, or the requested output. Local accounting is an
 * explicitly labelled operational estimate, not an exact tokenizer guarantee.
 * Codex subscription translation omits max_output_tokens: retaining the caller's
 * reserve here does not enforce a generation cap, even with a known catalog ceiling.
 */
export function evaluateAutoRequestAdmission(
	input: AutoRequestAdmissionInput,
): QualityAdmissionDecision {
	const target = revalidateAutoTarget(input);
	if (!target) return { status: "unknown", reason: "catalog-evidence-stale" };
	const serialized = originals.get(input.requirements);
	if (!serialized)
		return { status: "unknown", reason: "request-preservation-unknown" };
	const original = JSON.parse(serialized) as Record<string, unknown>;
	const final = record(input.finalBody);
	if (!final || final.model !== target.physicalModel)
		return { status: "reject", reason: "model-unsupported" };
	if (
		target.provider === "anthropic" &&
		(hasForcedToolChoice(original) || hasForcedToolChoice(final)) &&
		!supportsForcedToolChoice(target.physicalModel)
	)
		return { status: "reject", reason: "tools-unsupported" };
	// Advisor runs only where api.anthropic.com executes it (KTD8). Any other
	// candidate, including an anthropic one on a custom endpoint, is unsuitable.
	const advisorRequired =
		deriveNativeAnthropicToolRequirement(original) !== undefined;
	if (
		advisorRequired &&
		(input.firstPartyAnthropic !== true || target.provider !== "anthropic")
	)
		return { status: "reject", reason: "tools-unsupported" };
	const capabilities = target.capabilities;
	const output = positiveSafeCapacity(original.max_tokens);
	if (output === null)
		return { status: "unknown", reason: "output-unsupported" };
	if (
		capabilities?.maxOutputTokens != null &&
		output > capabilities.maxOutputTokens
	)
		return { status: "reject", reason: "output-unsupported" };
	const requestedModalities = modalities(
		original,
		target.provider === "anthropic",
		advisorRequired,
	);
	if (
		requestedModalities &&
		capabilities?.inputModalities &&
		[...requestedModalities].some(
			(value) => !capabilities.inputModalities?.includes(value),
		)
	)
		return { status: "reject", reason: "modality-unsupported" };
	const hosted = deriveServerToolRequirement(original);
	if (hosted) {
		const source = input.hostedTools;
		if (
			!source ||
			source.context.account.id !== target.accountId ||
			source.context.account.provider !== target.provider
		)
			return { status: "unknown", reason: "tools-unsupported" };
		try {
			const tuple = materializeProviderServerToolCapabilityTuple(
				source.provider,
				{
					...source.context,
					requirements: hosted,
					physicalModel: target.physicalModel,
				},
			);
			if (!tuple) return { status: "unknown", reason: "tools-unsupported" };
			const decision = materializeProviderServerToolCapabilityDecision(
				source.provider,
				hosted,
				tuple,
			);
			if (decision.decision !== "proven")
				return {
					status: decision.decision === "unsupported" ? "reject" : "unknown",
					reason: "tools-unsupported",
				};
		} catch {
			return { status: "unknown", reason: "tools-unsupported" };
		}
	}
	if (
		!hosted &&
		!clientTools(original, target.provider === "anthropic", advisorRequired)
	)
		return { status: "unknown", reason: "tools-unsupported" };
	if (target.provider === "anthropic") {
		const finalOutput = positiveSafeCapacity(final.max_tokens);
		if (finalOutput !== null && finalOutput < output)
			return { status: "reject", reason: "output-unsupported" };
		// JSON key order and the streaming transport flag are not prompt semantics.
		const { model: _originalModel, stream: _originalStream, ...a } = original;
		const { model: _physicalModel, stream: _physicalStream, ...b } = final;
		if (!isDeepStrictEqual(a, b))
			return { status: "unknown", reason: "request-preservation-unknown" };
	} else if (target.provider === "codex") {
		if (
			final.max_output_tokens !== undefined &&
			positiveSafeCapacity(final.max_output_tokens) !== output
		)
			return { status: "reject", reason: "output-unsupported" };
		if (!codexPreserves(original, final, capabilities))
			return { status: "unknown", reason: "request-preservation-unknown" };
	} else return { status: "unknown", reason: "request-preservation-unknown" };
	if (!requestedModalities || !capabilities?.inputModalities)
		return { status: "unknown", reason: "modality-unsupported" };
	const providerManagedOutput =
		target.provider === "codex" && capabilities.providerManagedOutput === true;
	if (capabilities.maxOutputTokens === null && !providerManagedOutput)
		return { status: "unknown", reason: "output-unsupported" };
	if (capabilities.maxContextWindow === null)
		return { status: "unknown", reason: "context-unsupported" };
	// Operational policy, NOT a tokenizer guarantee: one token per UTF-8 byte of
	// the entire final JSON envelope, plus 25% and 1024 tokens of framing headroom.
	// This intentionally overcounts JSON/schema/protocol fields. It is independent
	// of request/header token claims. No media or server-tool hidden prompt estimate.
	// Provider count_tokens is itself an estimate; no request-bound trusted count
	// owner exists here yet, so do not accept a caller-supplied count or valid=true.
	if (
		hosted ||
		(target.provider === "anthropic" && !nativeTextConfiguration(original)) ||
		[...requestedModalities].some((value) => value !== "text") ||
		Object.keys(original).some(
			(key) =>
				![
					"model",
					"messages",
					"system",
					"tools",
					"tool_choice",
					"max_tokens",
					"stream",
					"metadata",
					"temperature",
					"top_p",
					"top_k",
					"stop_sequences",
					...(target.provider === "anthropic"
						? ["thinking", "output_config", "context_management"]
						: ["output_config"]),
				].includes(key),
		)
	)
		return { status: "unknown", reason: "input-accounting-unknown" };
	const envelopeBytes = new TextEncoder().encode(JSON.stringify(final)).length;
	const inputEstimate = envelopeBytes;
	const headroom = Math.ceil(inputEstimate / 4) + 1024;
	// Use the smaller advertised current/maximum window; a larger maximum is
	// not permission to silently opt into a different context configuration.
	const rawContextLimit = Math.min(
		capabilities.maxContextWindow,
		capabilities.contextWindow ?? capabilities.maxContextWindow,
	);
	const contextLimit = Math.floor(
		(rawContextLimit * (capabilities.effectiveContextPercent ?? 100)) / 100,
	);
	return {
		...decideAutoContextFit({
			inputUpperBound: inputEstimate + headroom,
			requestedOutput: output,
			contextLimit,
			outputLimit: capabilities.maxOutputTokens,
			...(providerManagedOutput
				? { outputLimitMode: "provider-managed" as const }
				: {}),
		}),
		accounting: {
			source: "local-envelope-v1",
			kind: "estimate",
			envelopeBytes,
			inputEstimate,
			headroom,
			requestedOutput: output,
			outputLimit:
				capabilities.maxOutputTokens === null
					? { kind: "provider-managed", tokens: null }
					: { kind: "catalog", tokens: capabilities.maxOutputTokens },
		},
	};
}
