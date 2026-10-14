import { isCodexOAuthAccount } from "@better-ccflare/core";
import type {
	Account,
	NativeAnthropicToolRequirement,
} from "@better-ccflare/types";
import type { ModelRouteProfile } from "../model-route-profiles";
import type { AdvisorEmulationDecision } from "./types";

const ADVISOR_TOOL_TYPE = "advisor_20260301";
const KILL_SWITCH_ENV = "BCCF_ADVISOR_EMULATION";

export type AdvisorEmulationIneligibleReason =
	| "no_profile_opt_in"
	| "kill_switch"
	| "no_advisor_requirement"
	| "other_declared_types"
	| "unknown_declared_types"
	| "server_tool_requirements"
	| "not_streaming"
	| "forced_tool_choice"
	| "sole_structured_output"
	| "advisor_name_collision"
	| "unmapped_advisor_model";

export interface AdvisorEmulationDeriveInput {
	body: Record<string, unknown> | null;
	requirement: NativeAnthropicToolRequirement | undefined;
	hasServerToolRequirements: boolean;
	profile: ModelRouteProfile | undefined;
	env?: Record<string, string | undefined>;
}

export type AdvisorEmulationDerivation =
	| AdvisorEmulationDecision
	| { ineligible: AdvisorEmulationIneligibleReason };

/** Maps the declaration's `model` to the Codex model the advisor runs on. */
export function resolveAdvisorEmulationModel(
	declModel: unknown,
): "gpt-6-astra" | "gpt-6.1-sol" | null {
	if (typeof declModel !== "string") return null;
	const lowered = declModel.toLowerCase();
	if (lowered.includes("fable")) return "gpt-6-astra";
	if (lowered.includes("opus")) return "gpt-6.1-sol";
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deriveAdvisorEmulation(
	input: AdvisorEmulationDeriveInput,
): AdvisorEmulationDerivation {
	const { body, requirement, profile } = input;
	const env = input.env ?? process.env;
	if (profile?.advisorEmulation !== true) {
		return { ineligible: "no_profile_opt_in" };
	}
	if (env[KILL_SWITCH_ENV]?.trim().toLowerCase() === "off") {
		return { ineligible: "kill_switch" };
	}
	if (!requirement) return { ineligible: "no_advisor_requirement" };
	if (requirement.unknownDeclaredTypes.length > 0) {
		return { ineligible: "unknown_declared_types" };
	}
	const types = requirement.declaredToolTypes;
	if (types.length !== 1 || types[0] !== ADVISOR_TOOL_TYPE) {
		return { ineligible: "other_declared_types" };
	}
	if (input.hasServerToolRequirements) {
		return { ineligible: "server_tool_requirements" };
	}
	if (!body || body.stream !== true) return { ineligible: "not_streaming" };
	const choice = body.tool_choice;
	if (isRecord(choice) && (choice.type === "any" || choice.type === "tool")) {
		return { ineligible: "forced_tool_choice" };
	}
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const declaration = tools.find(
		(tool): tool is Record<string, unknown> =>
			isRecord(tool) && tool.type === ADVISOR_TOOL_TYPE,
	);
	if (!declaration) return { ineligible: "no_advisor_requirement" };
	const others = tools.filter((tool) => tool !== declaration);
	// Codex forces a lone StructuredOutput tool, which would starve the advisor.
	if (
		others.length === 1 &&
		isRecord(others[0]) &&
		others[0].name === "StructuredOutput"
	) {
		return { ineligible: "sole_structured_output" };
	}
	if (others.some((tool) => isRecord(tool) && tool.name === "advisor")) {
		return { ineligible: "advisor_name_collision" };
	}
	const advisorModel = resolveAdvisorEmulationModel(declaration.model);
	if (!advisorModel) return { ineligible: "unmapped_advisor_model" };
	return {
		advisorModel,
		declarationModel: declaration.model as string,
	};
}

export function isAdvisorEmulationAdmitted(
	meta: { advisorEmulation?: AdvisorEmulationDecision } | undefined,
	account: Pick<
		Account,
		"provider" | "api_key" | "custom_endpoint" | "access_token"
	>,
): boolean {
	return Boolean(meta?.advisorEmulation) && isCodexOAuthAccount(account);
}
