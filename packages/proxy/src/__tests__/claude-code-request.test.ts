import { describe, expect, it } from "bun:test";
import {
	attributionSourceIdentifiesAgent,
	deriveClaudeCodeRouteLineage,
	isClaudeCodeSubagent,
} from "../claude-code-request";

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

describe("attributionSourceIdentifiesAgent", () => {
	it.each([
		["prompt_agent", "prompt_agent", true],
		["header_agent", "header_agent", true],
		["session_header", "session_header", false],
		["none", "none", false],
		["undefined", undefined, false],
		["null", null, false],
	] as const)("returns %s for source %s", (_label, source, expected) => {
		expect(attributionSourceIdentifiesAgent(source)).toBe(expected);
	});
});

describe("deriveClaudeCodeRouteLineage", () => {
	const scope = {
		callerIdentity: "api-key-id:caller-a",
		sessionId: "session-a",
	};

	it("derives distinct opaque child-home keys for sibling agents", () => {
		const first = deriveClaudeCodeRouteLineage(
			new Headers({ "x-claude-code-agent-id": "child-a" }),
			scope,
		);
		const second = deriveClaudeCodeRouteLineage(
			new Headers({ "x-claude-code-agent-id": "child-b" }),
			scope,
		);

		expect(first).toMatchObject({ kind: "descendant" });
		expect(first.childHomeKey).toBeString();
		expect(first.childHomeKey).not.toContain("child-a");
		expect(first.childHomeKey).not.toBe(second.childHomeKey);
	});

	it("scopes the same child agent to its authenticated caller and session", () => {
		const headers = new Headers({
			"x-claude-code-agent-id": "shared-child",
		});
		const baseline = deriveClaudeCodeRouteLineage(headers, scope);
		const otherCaller = deriveClaudeCodeRouteLineage(headers, {
			...scope,
			callerIdentity: "api-key-id:caller-b",
		});
		const otherSession = deriveClaudeCodeRouteLineage(headers, {
			...scope,
			sessionId: "session-b",
		});

		expect(baseline.childHomeKey).not.toBe(otherCaller.childHomeKey);
		expect(baseline.childHomeKey).not.toBe(otherSession.childHomeKey);
	});

	it("classifies marker-only descendants without a reusable child-home key", () => {
		expect(
			deriveClaudeCodeRouteLineage(
				new Headers({
					"x-anthropic-billing-header": "cc_is_subagent=true",
				}),
				scope,
			),
		).toEqual({ kind: "descendant", childHomeKey: null });
	});

	it.each([
		["empty", "   "],
		["control-character", `child${String.fromCharCode(31)}agent`],
		["oversized", "a".repeat(257)],
	])("rejects a %s agent id as reusable lineage", (_label, agentId) => {
		const lineage = deriveClaudeCodeRouteLineage(
			new Headers({ "x-claude-code-agent-id": agentId }),
			scope,
		);

		expect(lineage.childHomeKey).toBeNull();
	});

	it("does not derive child lineage for parent traffic or incomplete scope", () => {
		expect(deriveClaudeCodeRouteLineage(new Headers(), scope)).toEqual({
			kind: "root",
			childHomeKey: null,
		});
		expect(
			deriveClaudeCodeRouteLineage(
				new Headers({ "x-claude-code-agent-id": "child-a" }),
				{ ...scope, callerIdentity: null },
			),
		).toEqual({ kind: "descendant", childHomeKey: null });
		expect(
			deriveClaudeCodeRouteLineage(
				new Headers({ "x-claude-code-agent-id": "child-a" }),
				{ ...scope, sessionId: null },
			),
		).toEqual({ kind: "descendant", childHomeKey: null });
	});
});
