import { describe, expect, it } from "bun:test";
import { isClaudeCodeSubagent } from "../claude-code-request";

describe("isClaudeCodeSubagent", () => {
	it("classifies a root Claude Code request when no child signal is present", () => {
		expect(isClaudeCodeSubagent(new Headers())).toBeFalse();
		expect(
			isClaudeCodeSubagent(
				new Headers({
					"x-claude-code-parent-agent-id": "   ",
					"x-claude-code-agent-id": "   ",
					"x-anthropic-billing-header": "cc_is_subagent=false",
				}),
			),
		).toBeFalse();
	});

	it.each([
		[
			"parent-agent header",
			{ "x-claude-code-parent-agent-id": "parent-agent" },
		],
		["agent header", { "x-claude-code-agent-id": "agent" }],
		[
			"case-insensitive billing metadata",
			{
				"x-anthropic-billing-header": "cc_version=2.1.207; CC_IS_SUBAGENT=TrUe",
			},
		],
	])("classifies a child from the %s", (_label, headers) => {
		expect(isClaudeCodeSubagent(new Headers(headers))).toBeTrue();
	});
});
