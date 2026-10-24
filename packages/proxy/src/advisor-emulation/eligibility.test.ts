import { describe, expect, test } from "bun:test";
import type { NativeAnthropicToolRequirement } from "@better-ccflare/types";
import type { ModelRouteProfile } from "../model-route-profiles";
import {
	deriveAdvisorEmulation,
	isAdvisorEmulationAdmitted,
	resolveAdvisorEmulationModel,
} from "./eligibility";

const profile = { advisorEmulation: true } as unknown as ModelRouteProfile;
const requirement: NativeAnthropicToolRequirement = {
	declaredToolTypes: ["advisor_20260301"],
	unknownDeclaredTypes: [],
	hasHistory: false,
};
const advisorTool = {
	type: "advisor_20260301",
	name: "advisor",
	model: "claude-fable-5",
};
function input(over: Record<string, unknown> = {}) {
	return {
		body: {
			stream: true,
			tools: [advisorTool, { name: "Read", input_schema: {} }],
		} as Record<string, unknown> | null,
		requirement: requirement as NativeAnthropicToolRequirement | undefined,
		hasServerToolRequirements: false,
		profile: profile as ModelRouteProfile | undefined,
		env: {} as Record<string, string | undefined>,
		...over,
	};
}

describe("resolveAdvisorEmulationModel", () => {
	test("maps fable and opus case-insensitively", () => {
		expect(resolveAdvisorEmulationModel("claude-fable-5")).toBe("gpt-6-astra");
		expect(resolveAdvisorEmulationModel("Claude-OPUS-5")).toBe("gpt-6.1-sol");
	});
	test("sonnet, unknown and non-strings are unmapped", () => {
		expect(resolveAdvisorEmulationModel("claude-sonnet-5")).toBeNull();
		expect(resolveAdvisorEmulationModel("gpt-5")).toBeNull();
		expect(resolveAdvisorEmulationModel(undefined)).toBeNull();
		expect(resolveAdvisorEmulationModel(42)).toBeNull();
	});
});

describe("deriveAdvisorEmulation", () => {
	test("eligible baseline", () => {
		expect(deriveAdvisorEmulation(input())).toEqual({
			advisorModel: "gpt-6-astra",
			declarationModel: "claude-fable-5",
		});
	});
	const cases: Array<[string, Record<string, unknown>]> = [
		["no_profile_opt_in", { profile: undefined }],
		[
			"no_profile_opt_in",
			{ profile: { advisorEmulation: false } as unknown as ModelRouteProfile },
		],
		["kill_switch", { env: { BCCF_ADVISOR_EMULATION: "OFF" } }],
		["no_advisor_requirement", { requirement: undefined }],
		[
			"other_declared_types",
			{
				requirement: {
					...requirement,
					declaredToolTypes: ["advisor_20260301", "web_search_20250305"],
				},
			},
		],
		[
			"other_declared_types",
			{ requirement: { ...requirement, declaredToolTypes: [] } },
		],
		[
			"unknown_declared_types",
			{ requirement: { ...requirement, unknownDeclaredTypes: ["advisor_9"] } },
		],
		["server_tool_requirements", { hasServerToolRequirements: true }],
		["not_streaming", { body: { tools: [advisorTool] } }],
		["not_streaming", { body: null }],
		[
			"forced_tool_choice",
			{
				body: {
					stream: true,
					tools: [advisorTool],
					tool_choice: { type: "any" },
				},
			},
		],
		[
			"forced_tool_choice",
			{
				body: {
					stream: true,
					tools: [advisorTool],
					tool_choice: { type: "tool", name: "Read" },
				},
			},
		],
		[
			"sole_structured_output",
			{
				body: {
					stream: true,
					tools: [advisorTool, { name: "StructuredOutput" }],
				},
			},
		],
		[
			"advisor_name_collision",
			{
				body: {
					stream: true,
					tools: [advisorTool, { name: "advisor", input_schema: {} }],
				},
			},
		],
		[
			"unmapped_advisor_model",
			{
				body: {
					stream: true,
					tools: [{ ...advisorTool, model: "claude-sonnet-5" }],
				},
			},
		],
	];
	for (const [reason, over] of cases) {
		test(`ineligible: ${reason}`, () => {
			expect(deriveAdvisorEmulation(input(over))).toEqual({
				ineligible: reason as never,
			});
		});
	}
	test("auto tool_choice and StructuredOutput beside other tools stay eligible", () => {
		const result = deriveAdvisorEmulation(
			input({
				body: {
					stream: true,
					tool_choice: { type: "auto" },
					tools: [advisorTool, { name: "StructuredOutput" }, { name: "Read" }],
				},
			}),
		);
		expect("advisorModel" in result).toBe(true);
	});
	test("kill switch is read per call", () => {
		const prev = process.env.BCCF_ADVISOR_EMULATION;
		try {
			const { env: _env, ...rest } = input();
			process.env.BCCF_ADVISOR_EMULATION = "off";
			expect(deriveAdvisorEmulation(rest)).toEqual({
				ineligible: "kill_switch",
			});
			delete process.env.BCCF_ADVISOR_EMULATION;
			expect("advisorModel" in deriveAdvisorEmulation(rest)).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.BCCF_ADVISOR_EMULATION;
			else process.env.BCCF_ADVISOR_EMULATION = prev;
		}
	});
});

describe("isAdvisorEmulationAdmitted", () => {
	const codex = {
		provider: "codex",
		api_key: null,
		custom_endpoint: null,
		access_token: "tok",
	};
	const meta = {
		advisorEmulation: { advisorModel: "m", declarationModel: "d" },
	};
	test("requires meta and a Codex OAuth account", () => {
		expect(isAdvisorEmulationAdmitted(meta, codex)).toBe(true);
		expect(isAdvisorEmulationAdmitted({}, codex)).toBe(false);
		expect(isAdvisorEmulationAdmitted(undefined, codex)).toBe(false);
		expect(
			isAdvisorEmulationAdmitted(meta, { ...codex, provider: "anthropic" }),
		).toBe(false);
		expect(isAdvisorEmulationAdmitted(meta, { ...codex, api_key: "k" })).toBe(
			false,
		);
	});
});
