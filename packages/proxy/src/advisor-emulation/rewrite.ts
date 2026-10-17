/**
 * Request-side half of advisor emulation (plan KTD3): turn Claude Code's typed
 * `advisor_20260301` declaration into an ordinary custom function tool the
 * Codex transform already understands.
 */

import {
	ADVISOR_SERVER_TOOL_NAME,
	ADVISOR_TOOL_TYPE,
} from "@better-ccflare/providers/server-tool-capabilities";

export const ADVISOR_FUNCTION_DESCRIPTION =
	"Consult a stronger reviewer model that sees the whole conversation so far, including every tool call and result. Takes no parameters. Call it alone, never in the same turn as other tool calls.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a new body whose advisor declaration is a function tool, or null when
 * no tool has type `advisor_20260301`. The input is never mutated; the
 * declaration is replaced in place so tool order (and so prompt-cache prefix
 * order) is preserved.
 */
export function rewriteAdvisorDeclaration(body: unknown): unknown | null {
	if (!isRecord(body) || !Array.isArray(body.tools)) return null;
	const tools = body.tools as unknown[];
	if (!tools.some((t) => isRecord(t) && t.type === ADVISOR_TOOL_TYPE)) {
		return null;
	}
	const rewritten = tools.map((tool) => {
		if (!isRecord(tool) || tool.type !== ADVISOR_TOOL_TYPE) return tool;
		const replacement: Record<string, unknown> = {
			name: ADVISOR_SERVER_TOOL_NAME,
			description: ADVISOR_FUNCTION_DESCRIPTION,
			input_schema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		};
		if (tool.cache_control !== undefined) {
			replacement.cache_control = tool.cache_control;
		}
		return replacement;
	});
	return { ...body, tools: rewritten };
}
