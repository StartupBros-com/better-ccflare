/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { getModelFamily, ValidationError } from "@better-ccflare/core";

export const REASONING_EFFORT_VALUES = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

const EFFORT_RANK: Record<ReasoningEffort, number> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 5,
};

const CLAUDE_REASONING_EFFORTS: Record<
	"fable" | "opus" | "sonnet" | "haiku",
	readonly ReasoningEffort[]
> = {
	fable: ["low", "medium", "high", "xhigh", "max"],
	opus: ["low", "medium", "high", "xhigh", "max"],
	sonnet: ["low", "medium", "high", "xhigh", "max"],
	haiku: ["low", "medium"],
};

const TARGET_REASONING_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
	"gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.6": ["minimal", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.3-codex": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["low", "medium"],
};

function normalizeTargetModelName(model: string): string {
	return model.toLowerCase().trim().replace(/^.*\//, "");
}

export function isGpt56SolModel(model: string): boolean {
	return /^gpt-5\.6-sol(?:$|-)/.test(normalizeTargetModelName(model));
}

export function getSupportedReasoningEfforts(
	model: string,
): readonly ReasoningEffort[] | null {
	const normalized = normalizeTargetModelName(model);
	const family = getModelFamily(normalized);
	if (family) {
		return CLAUDE_REASONING_EFFORTS[family];
	}

	if (normalized in TARGET_REASONING_EFFORTS) {
		return TARGET_REASONING_EFFORTS[normalized];
	}

	if (/^gpt-5\.6(?:$|-)/.test(normalized)) {
		return TARGET_REASONING_EFFORTS["gpt-5.6"];
	}

	if (normalized.startsWith("gpt-5")) {
		return TARGET_REASONING_EFFORTS["gpt-5"];
	}

	return null;
}

export interface ReasoningEffortResolution {
	effort: ReasoningEffort | undefined;
	downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}>;
}

interface ReasoningEffortModels {
	sourceModel?: string;
	targetModel?: string;
}

export interface AnthropicReasoningEffortInput {
	output_config?: { effort?: unknown };
	reasoning?: { effort?: unknown };
}

export type AnthropicReasoningEffortSource =
	| "output_config"
	| "reasoning"
	| "default";

export interface AnthropicReasoningEffortResolution
	extends ReasoningEffortResolution {
	requestedEffort: ReasoningEffort | undefined;
	source: AnthropicReasoningEffortSource;
}

function validateReasoningEffortValue(
	effort: unknown,
	field: "output_config.effort" | "reasoning.effort",
): ReasoningEffort {
	if (
		typeof effort !== "string" ||
		!REASONING_EFFORT_VALUES.includes(effort as ReasoningEffort)
	) {
		throw new ValidationError(
			`${field} must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`,
			field,
			effort,
		);
	}

	return effort as ReasoningEffort;
}

function resolveValidatedReasoningEffort(
	effort: ReasoningEffort,
	models: ReasoningEffortModels,
): ReasoningEffortResolution {
	let resolvedEffort = effort;
	const downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}> = [];

	const modelContexts = [{ model: models.targetModel }].filter(
		(context): context is { model: string } =>
			typeof context.model === "string" && context.model.length > 0,
	);

	for (const { model } of modelContexts) {
		const supportedEfforts = getSupportedReasoningEfforts(model);
		if (!supportedEfforts) {
			// Unknown model (source or target) — pass through unchanged
			continue;
		}

		if (supportedEfforts.includes(resolvedEffort)) {
			continue;
		}

		// Find nearest supported effort (prefer nearest lower; fall back to minimum)
		const currentRank = EFFORT_RANK[resolvedEffort];
		let nearest: ReasoningEffort | undefined;
		for (const supported of supportedEfforts) {
			const rank = EFFORT_RANK[supported];
			if (rank <= currentRank) {
				if (nearest === undefined || rank > EFFORT_RANK[nearest]) {
					nearest = supported;
				}
			}
		}

		if (nearest === undefined) {
			// Requested effort is below model minimum — clamp up to minimum
			nearest = supportedEfforts[0];
		}

		// Only record as a downgrade when rank actually decreases
		if (EFFORT_RANK[nearest] < currentRank) {
			downgrades.push({
				model,
				from: resolvedEffort,
				to: nearest,
			});
		}
		resolvedEffort = nearest;
	}

	return { effort: resolvedEffort, downgrades };
}

// sourceModel is accepted for API symmetry but only targetModel is used for
// downgrade resolution — the source model's effort ceiling must not further
// constrain the value sent to a capable target.
export function resolveReasoningEffort(
	effort: unknown,
	models: ReasoningEffortModels,
): ReasoningEffortResolution {
	if (effort === undefined) {
		return { effort: undefined, downgrades: [] };
	}

	return resolveValidatedReasoningEffort(
		validateReasoningEffortValue(effort, "reasoning.effort"),
		models,
	);
}

/**
 * Resolve Anthropic's official effort field while retaining compatibility with
 * the legacy better-ccflare reasoning field. Matching dual values are safe;
 * conflicting values are rejected instead of silently changing caller intent.
 */
export function resolveAnthropicReasoningEffort(
	input: AnthropicReasoningEffortInput,
	models: ReasoningEffortModels,
): AnthropicReasoningEffortResolution {
	const officialEffort = input.output_config?.effort;
	const legacyEffort = input.reasoning?.effort;

	if (
		officialEffort !== undefined &&
		legacyEffort !== undefined &&
		officialEffort !== legacyEffort
	) {
		throw new ValidationError(
			"output_config.effort conflicts with reasoning.effort",
			"output_config.effort",
			officialEffort,
		);
	}

	const hasOfficialEffort = officialEffort !== undefined;
	const effort = hasOfficialEffort ? officialEffort : legacyEffort;
	if (effort === undefined) {
		return {
			effort: undefined,
			downgrades: [],
			requestedEffort: undefined,
			source: "default",
		};
	}

	const field = hasOfficialEffort ? "output_config.effort" : "reasoning.effort";
	const requestedEffort = validateReasoningEffortValue(effort, field);
	return {
		...resolveValidatedReasoningEffort(requestedEffort, models),
		requestedEffort,
		source: hasOfficialEffort ? "output_config" : "reasoning",
	};
}

export function validateReasoningEffort(
	effort: unknown,
	models: ReasoningEffortModels,
): ReasoningEffort | undefined {
	return resolveReasoningEffort(effort, models).effort;
}
