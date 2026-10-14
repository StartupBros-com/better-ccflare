import { describe, expect, it } from "bun:test";
import {
	ADVISOR_FUNCTION_DESCRIPTION,
	rewriteAdvisorDeclaration,
} from "./rewrite";

describe("rewriteAdvisorDeclaration", () => {
	it("replaces the typed declaration in place and keeps tool order", () => {
		const body = {
			model: "claude-fable-5",
			tools: [
				{ name: "Read", input_schema: { type: "object" } },
				{
					type: "advisor_20260301",
					name: "advisor",
					model: "claude-fable-5",
					defer_loading: true,
				},
				{ name: "Bash", input_schema: { type: "object" } },
			],
		};
		const snapshot = JSON.stringify(body);
		const out = rewriteAdvisorDeclaration(body);
		expect(out).not.toBeNull();
		expect(JSON.stringify(body)).toBe(snapshot);
		const tools = (out as typeof body).tools as Record<string, unknown>[];
		expect(tools.map((t) => t.name)).toEqual(["Read", "advisor", "Bash"]);
		expect(tools[1]).toEqual({
			name: "advisor",
			description: ADVISOR_FUNCTION_DESCRIPTION,
			input_schema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		});
		expect(out).not.toBe(body);
	});

	it("carries cache_control over and drops type/model/defer_loading", () => {
		const out = rewriteAdvisorDeclaration({
			tools: [
				{
					type: "advisor_20260301",
					name: "advisor",
					model: "m",
					defer_loading: false,
					cache_control: { type: "ephemeral" },
				},
			],
		}) as { tools: Record<string, unknown>[] };
		const tool = out.tools[0];
		expect(tool.cache_control).toEqual({ type: "ephemeral" });
		expect("type" in tool).toBe(false);
		expect("model" in tool).toBe(false);
		expect("defer_loading" in tool).toBe(false);
	});

	it("returns null when no advisor declaration exists", () => {
		expect(rewriteAdvisorDeclaration({ tools: [{ name: "Read" }] })).toBeNull();
		expect(rewriteAdvisorDeclaration({})).toBeNull();
		expect(rewriteAdvisorDeclaration({ tools: "nope" })).toBeNull();
		expect(rewriteAdvisorDeclaration(null)).toBeNull();
	});

	it("describes a parameterless sole-call reviewer", () => {
		expect(ADVISOR_FUNCTION_DESCRIPTION.length).toBeGreaterThan(40);
		expect(ADVISOR_FUNCTION_DESCRIPTION.toLowerCase()).toContain("alone");
	});
});
