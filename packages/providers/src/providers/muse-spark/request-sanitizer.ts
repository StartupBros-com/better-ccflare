/**
 * Meta Model API (Muse Spark) request sanitization.
 *
 * `POST https://api.meta.ai/v1/messages` is a thin wire-format adapter over
 * Meta's Responses pipeline, not a full Anthropic implementation. It validates
 * the request against a strict allowlist and answers HTTP 400 for anything it
 * does not recognise — including *unknown top-level fields*. Claude Code and
 * other Anthropic clients routinely send fields that trip this, so every
 * outbound body is normalised here before it leaves the proxy.
 *
 * Documented constraints (https://dev.meta.ai/docs/features/messages):
 *  - `stop_sequences`, `top_k`, `container`, `inference_geo` -> 400
 *  - unknown top-level fields -> 400
 *  - `thinking: {type: "disabled"}` -> 400 (Muse Spark always reasons)
 *  - `thinking: {type: "enabled"}` needs `1024 <= budget_tokens < max_tokens`
 *  - named `tool_choice` (`{type: "tool"}`) -> 400
 *  - `web_search` carrying `allowed_domains` / `blocked_domains` / `max_uses` -> 400
 *  - `system` blocks of any type other than `text` -> 400
 *  - `service_tier` outside {`auto`, `standard_only`} -> 400
 *  - `temperature` is enforced to Anthropic's 0-1 range
 */

/** Maximum output tokens Muse Spark will generate in one response. */
export const MUSE_SPARK_MAX_OUTPUT_TOKENS = 131_072;

/** Muse Spark context window, in tokens. */
export const MUSE_SPARK_CONTEXT_WINDOW = 1_048_576;

/** Minimum `thinking.budget_tokens` the Messages adapter accepts. */
export const MUSE_SPARK_MIN_THINKING_BUDGET_TOKENS = 1_024;

/**
 * Top-level fields the Messages adapter accepts. Anything else is dropped
 * rather than forwarded, because unknown fields are a hard 400.
 */
const ALLOWED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"max_tokens",
	"system",
	"temperature",
	"top_p",
	"stream",
	"metadata",
	"service_tier",
	"thinking",
	"output_config",
	"tools",
	"tool_choice",
]);

const ALLOWED_SERVICE_TIERS: ReadonlySet<string> = new Set([
	"auto",
	"standard_only",
]);

const ALLOWED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
	"low",
	"medium",
	"high",
	"xhigh",
]);

/**
 * `web_search` sub-fields Anthropic accepts but Meta rejects outright. Meta
 * exposes no domain filtering or use cap on its built-in search tool.
 */
const WEB_SEARCH_UNSUPPORTED_FIELDS = [
	"allowed_domains",
	"blocked_domains",
	"max_uses",
] as const;

export interface MuseSparkSanitizeResult {
	/** A new body object safe to send to the Messages adapter. */
	body: Record<string, unknown>;
	/** Stable, non-secret descriptions of each edit, for debug logging. */
	changes: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translate an Anthropic thinking budget into a Muse Spark reasoning effort.
 *
 * Meta accepts `thinking.budget_tokens` "for compatibility" but never
 * translates it into reasoning depth — only `output_config.effort` moves that
 * dial. Without this mapping a client's think / think-harder / ultrathink
 * levels would all silently collapse to the default effort.
 */
export function effortForThinkingBudget(budgetTokens: number): string {
	if (budgetTokens < 4_096) return "low";
	if (budgetTokens < 16_384) return "medium";
	if (budgetTokens < 32_768) return "high";
	return "xhigh";
}

/** Keep only the `text` blocks Meta permits in `system`. */
function sanitizeSystem(
	system: unknown,
	changes: string[],
): unknown | undefined {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) {
		if (system === undefined) return undefined;
		changes.push("dropped_system:unsupported_shape");
		return undefined;
	}

	const textBlocks = system.filter(
		(block) => isPlainObject(block) && block.type === "text",
	);
	if (textBlocks.length !== system.length) {
		changes.push(`dropped_system_blocks:${system.length - textBlocks.length}`);
	}
	return textBlocks.length > 0 ? textBlocks : undefined;
}

/**
 * Normalise `thinking`, returning the replacement value plus a derived
 * reasoning effort when one can be inferred.
 */
function sanitizeThinking(
	thinking: unknown,
	maxTokens: number | undefined,
	changes: string[],
): { thinking?: unknown; derivedEffort?: string } {
	if (thinking === undefined) return {};
	if (!isPlainObject(thinking)) {
		changes.push("dropped_thinking:unsupported_shape");
		return {};
	}

	const type = thinking.type;

	// Muse Spark cannot disable reasoning; forwarding this is a guaranteed 400.
	if (type === "disabled") {
		changes.push("dropped_thinking:disabled_unsupported");
		return {};
	}

	if (type === "adaptive") return { thinking };

	if (type === "enabled") {
		const rawBudget = thinking.budget_tokens;
		if (typeof rawBudget !== "number" || !Number.isFinite(rawBudget)) {
			changes.push("dropped_thinking:missing_budget_tokens");
			return {};
		}

		// Meta requires 1024 <= budget_tokens < max_tokens. When max_tokens
		// leaves no room, drop `thinking` entirely rather than send a 400.
		const upperBound =
			typeof maxTokens === "number" && Number.isFinite(maxTokens)
				? maxTokens - 1
				: Number.POSITIVE_INFINITY;
		if (upperBound < MUSE_SPARK_MIN_THINKING_BUDGET_TOKENS) {
			changes.push("dropped_thinking:max_tokens_too_small");
			return {};
		}

		const budget = Math.min(
			Math.max(Math.floor(rawBudget), MUSE_SPARK_MIN_THINKING_BUDGET_TOKENS),
			upperBound,
		);
		if (budget !== rawBudget) {
			changes.push(`clamped_thinking_budget:${rawBudget}->${budget}`);
		}

		return {
			thinking: { ...thinking, budget_tokens: budget },
			derivedEffort: effortForThinkingBudget(budget),
		};
	}

	changes.push(`dropped_thinking:unsupported_type_${String(type)}`);
	return {};
}

/** Drop invalid `output_config.effort` values and apply a derived effort. */
function sanitizeOutputConfig(
	outputConfig: unknown,
	derivedEffort: string | undefined,
	changes: string[],
): unknown | undefined {
	let config: Record<string, unknown> | undefined;

	if (outputConfig === undefined) {
		config = undefined;
	} else if (isPlainObject(outputConfig)) {
		config = { ...outputConfig };
		if (
			config.effort !== undefined &&
			!(
				typeof config.effort === "string" &&
				ALLOWED_REASONING_EFFORTS.has(config.effort)
			)
		) {
			changes.push(`dropped_effort:${String(config.effort)}`);
			delete config.effort;
		}
	} else {
		changes.push("dropped_output_config:unsupported_shape");
		config = undefined;
	}

	// An explicit effort from the client always wins over the derived one.
	if (derivedEffort && config?.effort === undefined) {
		config = { ...(config ?? {}), effort: derivedEffort };
		changes.push(`derived_effort_from_thinking_budget:${derivedEffort}`);
	}

	return config && Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Meta rejects a named tool choice. `any` is the closest surviving semantic:
 * both compel the model to call a tool, `any` just does not pin which one.
 */
function sanitizeToolChoice(
	toolChoice: unknown,
	changes: string[],
): unknown | undefined {
	if (toolChoice === undefined) return undefined;
	if (!isPlainObject(toolChoice)) {
		changes.push("dropped_tool_choice:unsupported_shape");
		return undefined;
	}

	if (toolChoice.type === "tool") {
		changes.push("rewrote_tool_choice:tool->any");
		const rewritten: Record<string, unknown> = { type: "any" };
		if (toolChoice.disable_parallel_tool_use !== undefined) {
			rewritten.disable_parallel_tool_use =
				toolChoice.disable_parallel_tool_use;
		}
		return rewritten;
	}

	if (
		toolChoice.type === "auto" ||
		toolChoice.type === "any" ||
		toolChoice.type === "none"
	) {
		return toolChoice;
	}

	changes.push(`dropped_tool_choice:${String(toolChoice.type)}`);
	return undefined;
}

/** Strip `web_search` options Meta rejects, leaving the tool itself intact. */
function sanitizeTools(tools: unknown, changes: string[]): unknown | undefined {
	if (tools === undefined) return undefined;
	if (!Array.isArray(tools)) {
		changes.push("dropped_tools:unsupported_shape");
		return undefined;
	}

	return tools.map((tool) => {
		if (!isPlainObject(tool)) return tool;
		const type = typeof tool.type === "string" ? tool.type : "";
		const name = typeof tool.name === "string" ? tool.name : "";
		const isWebSearch = type.startsWith("web_search") || name === "web_search";
		if (!isWebSearch) return tool;

		const sanitized = { ...tool };
		for (const field of WEB_SEARCH_UNSUPPORTED_FIELDS) {
			if (field in sanitized) {
				delete sanitized[field];
				changes.push(`dropped_web_search_field:${field}`);
			}
		}
		return sanitized;
	});
}

/**
 * Normalise an Anthropic Messages body for the Meta Model API.
 *
 * Pure: `body` is never mutated. Fields Meta accepts pass through untouched so
 * this stays a compatibility shim rather than a request rewriter.
 */
export function sanitizeMuseSparkRequestBody(
	body: unknown,
): MuseSparkSanitizeResult {
	if (!isPlainObject(body)) {
		return { body: {}, changes: [] };
	}

	const changes: string[] = [];
	const sanitized: Record<string, unknown> = {};

	// 1. Allowlist. Unknown top-level fields are a hard 400, so anything not
	//    explicitly supported is dropped instead of forwarded.
	for (const [key, value] of Object.entries(body)) {
		if (ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
			sanitized[key] = value;
		} else {
			changes.push(`dropped_unsupported_field:${key}`);
		}
	}

	// 2. max_tokens: Muse Spark caps output at 131,072 tokens.
	if (typeof sanitized.max_tokens === "number") {
		const requested = sanitized.max_tokens;
		const clamped = Math.min(
			Math.max(Math.floor(requested), 1),
			MUSE_SPARK_MAX_OUTPUT_TOKENS,
		);
		if (clamped !== requested) {
			changes.push(`clamped_max_tokens:${requested}->${clamped}`);
			sanitized.max_tokens = clamped;
		}
	}

	// 3. temperature is enforced to Anthropic's 0-1 range.
	if (typeof sanitized.temperature === "number") {
		const requested = sanitized.temperature;
		const clamped = Math.min(Math.max(requested, 0), 1);
		if (clamped !== requested) {
			changes.push(`clamped_temperature:${requested}->${clamped}`);
			sanitized.temperature = clamped;
		}
	}

	// 4. system accepts text blocks only.
	if ("system" in sanitized) {
		const system = sanitizeSystem(sanitized.system, changes);
		if (system === undefined) delete sanitized.system;
		else sanitized.system = system;
	}

	// 5. service_tier accepts auto | standard_only.
	if ("service_tier" in sanitized) {
		const tier = sanitized.service_tier;
		if (!(typeof tier === "string" && ALLOWED_SERVICE_TIERS.has(tier))) {
			changes.push(`dropped_service_tier:${String(tier)}`);
			delete sanitized.service_tier;
		}
	}

	// 6. thinking, and the reasoning effort derived from its budget.
	const maxTokens =
		typeof sanitized.max_tokens === "number" ? sanitized.max_tokens : undefined;
	const { thinking, derivedEffort } = sanitizeThinking(
		sanitized.thinking,
		maxTokens,
		changes,
	);
	if (thinking === undefined) delete sanitized.thinking;
	else sanitized.thinking = thinking;

	// 7. output_config.
	const outputConfig = sanitizeOutputConfig(
		sanitized.output_config,
		derivedEffort,
		changes,
	);
	if (outputConfig === undefined) delete sanitized.output_config;
	else sanitized.output_config = outputConfig;

	// 8. tool_choice.
	if ("tool_choice" in sanitized) {
		const toolChoice = sanitizeToolChoice(sanitized.tool_choice, changes);
		if (toolChoice === undefined) delete sanitized.tool_choice;
		else sanitized.tool_choice = toolChoice;
	}

	// 9. tools.
	if ("tools" in sanitized) {
		const tools = sanitizeTools(sanitized.tools, changes);
		if (tools === undefined) delete sanitized.tools;
		else sanitized.tools = tools;
	}

	return { body: sanitized, changes };
}
