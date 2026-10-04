import {
	hasForcedToolChoice,
	supportsForcedToolChoice,
} from "@better-ccflare/core";
import { resolveAnthropicReasoningEffort } from "@better-ccflare/openai-formats";
import type { QualityAdmissionDecision } from "@better-ccflare/types";
import {
	type AutoCatalogEvidence,
	type AutoModelCapabilities,
	type AutoModelTargetEvidence,
	isAutoCatalogEvidenceCurrent,
	positiveSafeCapacity,
	resolveAutoModelTargets,
} from "./auto-model-capabilities";
import { estimateAnthropicAdmissionTokens } from "./request-capabilities";
import {
	deriveServerToolRequirement,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
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

function modalities(body: Record<string, unknown>): Set<string> | null {
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
			case "thinking":
			case "redacted_thinking":
				// Provider reasoning is not portable: the Codex adapter drops it, so it
				// carries no modality and is not content the target must accept.
				return true;
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
					// The adapter replaces a tool_result image with a placeholder:
					// that is lossy content, not a modality to match.
					codexToolResultContent(block.content) &&
					(block.content === undefined || visit(block.content))
				);
			case "tool_reference":
				// ToolSearch's pointer to a declared tool: no modality.
				return toolReferenceBlock(block);
			case "tool_use":
				found.add("text");
				return (
					typeof block.id === "string" &&
					typeof block.name === "string" &&
					record(block.input) !== null &&
					onlyKeys(block, ["type", "id", "name", "input", "cache_control"])
				);
			default:
				return false;
		}
	};
	if (
		body.system !== undefined &&
		(textBlocks(body.system, "") === null || !visit(body.system))
	)
		return null;
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

/** Client function tools supported by Codex's existing function adapter. This
 * does NOT infer hosted-tool support from a flag. Unknown tool variants/schemas
 * are deliberately outside this contract. `defer_loading` is a Claude Code
 * tool-search hint the adapter drops while still sending the full function.
 */
function clientTools(body: Record<string, unknown>): boolean {
	return (
		body.tools === undefined ||
		(Array.isArray(body.tools) &&
			body.tools.every((value) => {
				const tool = record(value);
				return (
					tool &&
					onlyKeys(tool, [
						"name",
						"description",
						"input_schema",
						"cache_control",
						"defer_loading",
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

const CODEX_REQUEST_KEYS = [
	"model",
	"messages",
	"system",
	"tools",
	"tool_choice",
	"max_tokens",
	"stream",
	"metadata",
	"output_config",
	// Accepted but ignored by the adapter: it neither forwards nor depends on them.
	"thinking",
	"context_management",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
] as const;

function textBlockOnly(block: Record<string, unknown>): boolean {
	return (
		block.type === "text" &&
		typeof block.text === "string" &&
		onlyKeys(block, ["type", "text", "cache_control"])
	);
}

function toolReferenceBlock(block: Record<string, unknown>): boolean {
	return (
		block.type === "tool_reference" &&
		typeof block.tool_name === "string" &&
		onlyKeys(block, ["type", "tool_name", "cache_control"])
	);
}

/** tool_result content the adapter carries intact: text, or ToolSearch's
 * tool_reference blocks, which it serializes as JSON text. It replaces an image
 * with a placeholder and omits large structured blocks, so those do not qualify.
 */
function codexToolResultContent(content: unknown): boolean {
	if (content === undefined || typeof content === "string") return true;
	return (
		Array.isArray(content) &&
		content.every((item) => {
			const block = record(item);
			return (
				block !== null && (textBlockOnly(block) || toolReferenceBlock(block))
			);
		})
	);
}

/** One message content block the Codex adapter translates without dropping user
 * content. Reasoning is dropped by design (it is not portable across providers),
 * so it is not loss; images, documents and hosted-tool blocks are.
 */
function codexTranslatableBlock(
	block: Record<string, unknown>,
	role: string,
): boolean {
	switch (block.type) {
		case "text":
			return textBlockOnly(block);
		case "thinking":
			return (
				role === "assistant" &&
				onlyKeys(block, ["type", "thinking", "signature"])
			);
		case "redacted_thinking":
			return role === "assistant" && onlyKeys(block, ["type", "data"]);
		case "tool_use":
			return (
				role === "assistant" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				record(block.input) !== null &&
				onlyKeys(block, ["type", "id", "name", "input", "cache_control"])
			);
		case "tool_result":
			return (
				role === "user" &&
				typeof block.tool_use_id === "string" &&
				onlyKeys(block, [
					"type",
					"tool_use_id",
					"content",
					"is_error",
					"cache_control",
				]) &&
				(block.is_error === undefined || typeof block.is_error === "boolean") &&
				codexToolResultContent(block.content)
			);
		default:
			return false;
	}
}

/** Original-side check that the Codex adapter translates this request without
 * silently losing user content. It deliberately does NOT rebuild or compare the
 * adapter's output: stock routing applies stateful, deterministic transforms (the
 * Agent/Task orchestration filter, the Skill nudge, forced StructuredOutput
 * tool_choice, skill elision, cache breakpoints, schema sanitising, tool_use
 * input sanitising) that a rebuild cannot mirror, and Auto must not refuse what
 * stock would send. Stricter than stock only where the adapter drops content
 * (images, PDFs, hosted-tool blocks, non-text system blocks) or where a request
 * shape is unknown.
 */
function codexTranslatesWithoutLoss(
	original: Record<string, unknown>,
): boolean {
	if (!onlyKeys(original, CODEX_REQUEST_KEYS)) return false;
	if (original.system !== undefined && typeof original.system !== "string") {
		if (!Array.isArray(original.system)) return false;
		for (const value of original.system) {
			const block = record(value);
			if (!block || !textBlockOnly(block)) return false;
		}
	}
	if (!Array.isArray(original.messages) || original.messages.length === 0)
		return false;
	for (const value of original.messages) {
		const message = record(value);
		if (
			!message ||
			!onlyKeys(message, ["role", "content"]) ||
			typeof message.role !== "string" ||
			!["user", "assistant", "system", "developer"].includes(message.role)
		)
			return false;
		if (typeof message.content === "string") continue;
		if (!Array.isArray(message.content)) return false;
		for (const item of message.content) {
			const block = record(item);
			if (!block || !codexTranslatableBlock(block, message.role)) return false;
		}
	}
	if (original.tool_choice !== undefined) {
		const choice = record(original.tool_choice);
		if (
			!choice ||
			!onlyKeys(choice, ["type", "name", "disable_parallel_tool_use"])
		)
			return false;
		if (choice.type === "tool") {
			const tools = Array.isArray(original.tools) ? original.tools : [];
			if (!tools.some((tool) => record(tool)?.name === choice.name))
				return false;
		} else if (!["auto", "any", "none"].includes(String(choice.type)))
			return false;
	}
	if (Object.hasOwn(original, "output_config")) {
		const output = record(original.output_config);
		if (
			!output ||
			!onlyKeys(output, ["effort"]) ||
			typeof output.effort !== "string"
		)
			return false;
	}
	return true;
}

/** The adapter clamps effort against the account's reasoning snapshot, which a
 * catalog refresh republishes independently of the revision this target was
 * resolved from. The wire must carry exactly the effort the pinned evidence
 * yields: a clamp both agree on is stock's deterministic transform, while a
 * disagreement means the body was built from another catalog generation.
 */
function codexWireEffortDecision(
	original: Record<string, unknown>,
	final: Record<string, unknown>,
	capabilities: AutoModelCapabilities | null,
	physicalModel: string,
): QualityAdmissionDecision | null {
	const wire = record(final.reasoning)?.effort;
	if (typeof wire !== "string")
		return { status: "unknown", reason: "request-preservation-unknown" };
	const supported = capabilities?.supportedReasoningEfforts;
	if (supported?.length && !supported.some((effort) => effort === wire))
		return { status: "unknown", reason: "catalog-evidence-stale" };
	if (!Object.hasOwn(original, "output_config")) return null;
	let resolved: string | undefined;
	try {
		// The adapter clamps to the nearest supported effort and throws on an
		// invalid value; resolve exactly as convertToCodexFormat does.
		resolved = resolveAnthropicReasoningEffort(original, {
			sourceModel:
				typeof original.model === "string" ? original.model : undefined,
			targetModel: physicalModel,
			supportedTargetEfforts: supported ?? undefined,
		}).effort;
	} catch {
		return { status: "unknown", reason: "request-preservation-unknown" };
	}
	return resolved === wire
		? null
		: { status: "unknown", reason: "catalog-evidence-stale" };
}

/** Hosted server tools are proven per target by the provider materializer, the
 * same decision stock routing makes per candidate in account-selector.
 */
function hostedToolsDecision(
	input: AutoRequestAdmissionInput,
	target: AutoModelTargetEvidence,
	hosted: NonNullable<ReturnType<typeof deriveServerToolRequirement>>,
): QualityAdmissionDecision | null {
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
	return null;
}

/** Native Anthropic pass-through. Stock routing applies no request-shape,
 * modality, or context admission for the same account and model, so Auto must
 * not refuse what stock would send: only proven rejections skip a lane. The
 * request body is deliberately not compared with the original (stock legitimately
 * rewrites it: system cache TTL, clear_thinking strip), and no local token
 * accounting is claimed; upstream returns its own "prompt is too long" exactly
 * as it does for stock.
 */
function evaluateNativeAnthropicAdmission(
	input: AutoRequestAdmissionInput,
	target: AutoModelTargetEvidence,
	original: Record<string, unknown>,
	final: Record<string, unknown> | null,
): QualityAdmissionDecision {
	if (!final || final.model !== target.physicalModel)
		return { status: "reject", reason: "model-unsupported" };
	if (
		(hasForcedToolChoice(original) || hasForcedToolChoice(final)) &&
		!supportsForcedToolChoice(target.physicalModel)
	)
		return { status: "reject", reason: "tools-unsupported" };
	const output = positiveSafeCapacity(original.max_tokens);
	if (output !== null) {
		const ceiling = target.capabilities?.maxOutputTokens;
		if (ceiling != null && output > ceiling)
			return { status: "reject", reason: "output-unsupported" };
		const finalOutput = positiveSafeCapacity(final.max_tokens);
		if (finalOutput !== null && finalOutput < output)
			return { status: "reject", reason: "output-unsupported" };
	}
	const hosted = deriveServerToolRequirement(original);
	if (hosted) {
		const decision = hostedToolsDecision(input, target, hosted);
		if (decision) return decision;
	}
	return { status: "admit" };
}

/** Evaluate original requirements before final representation, so translation
 * cannot hide images, tools, or the requested output.
 *
 * Codex target contract: Auto must not refuse what the stock Codex route would
 * translate and send deterministically. It is stricter than stock only where the
 * adapter silently loses content (see codexTranslatesWithoutLoss). The final body
 * is checked only to prove it was actually translated (a Responses body, not the
 * untranslated Anthropic one), to carry the same model and output cap, and to
 * carry the reasoning effort the pinned catalog evidence resolves. Context
 * fit uses stock's estimator and reserve: fail open when the window is unknown,
 * and no output reserve where the subscription endpoint drops max_output_tokens.
 * A missing max_tokens is admitted (the adapter forwards no cap).
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
	if (target.provider === "anthropic")
		return evaluateNativeAnthropicAdmission(input, target, original, final);
	if (!final || final.model !== target.physicalModel)
		return { status: "reject", reason: "model-unsupported" };
	if (target.provider !== "codex")
		return { status: "unknown", reason: "request-preservation-unknown" };
	// A swallowed translation failure forwards the untranslated Anthropic body.
	if (!Array.isArray(final.input) || Object.hasOwn(final, "messages"))
		return { status: "unknown", reason: "request-preservation-unknown" };
	const capabilities = target.capabilities;
	const output = positiveSafeCapacity(original.max_tokens);
	if (output !== null) {
		if (
			capabilities?.maxOutputTokens != null &&
			output > capabilities.maxOutputTokens
		)
			return { status: "reject", reason: "output-unsupported" };
		if (
			final.max_output_tokens !== undefined &&
			positiveSafeCapacity(final.max_output_tokens) !== output
		)
			return { status: "reject", reason: "output-unsupported" };
	}
	const requestedModalities = modalities(original);
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
		const decision = hostedToolsDecision(input, target, hosted);
		if (decision) return decision;
	}
	if (!hosted && !clientTools(original))
		return { status: "unknown", reason: "tools-unsupported" };
	if (!codexTranslatesWithoutLoss(original))
		return { status: "unknown", reason: "request-preservation-unknown" };
	const effort = codexWireEffortDecision(
		original,
		final,
		capabilities,
		target.physicalModel,
	);
	if (effort) return effort;
	if (capabilities?.maxContextWindow == null) return { status: "admit" };
	// Mirrors stock admitConcreteCodexModel: the same estimator, no local
	// headroom, and the reserve the wire carries (the subscription endpoint
	// deletes max_output_tokens, so it reserves 0). This is an estimate, not a
	// tokenizer guarantee. Unlike stock, which defers a low-confidence overflow
	// to the provider, Auto skips the lane: it has another rung to try.
	const inputEstimate = estimateAnthropicAdmissionTokens(original).tokens;
	const reserve = positiveSafeCapacity(final.max_output_tokens) ?? 0;
	// Stock's window (resolveModelContextCapability): the maximum window at the
	// effective percent.
	const contextLimit = Math.floor(
		(capabilities.maxContextWindow *
			(capabilities.effectiveContextPercent ?? 100)) /
			100,
	);
	const ceiling = capabilities.maxOutputTokens;
	const accounting: NonNullable<QualityAdmissionDecision["accounting"]> = {
		source: "stock-codex-estimate-v1",
		kind: "estimate",
		envelopeBytes: new TextEncoder().encode(JSON.stringify(original)).length,
		inputEstimate,
		headroom: 0,
		requestedOutput: reserve,
		outputLimit:
			ceiling === null
				? { kind: "provider-managed", tokens: null }
				: { kind: "catalog", tokens: ceiling },
	};
	return inputEstimate > contextLimit - reserve
		? { status: "reject", reason: "context-unsupported", accounting }
		: { status: "admit", accounting };
}
