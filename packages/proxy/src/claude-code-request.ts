const CLAUDE_CODE_PARENT_AGENT_HEADER = "x-claude-code-parent-agent-id";
const CLAUDE_CODE_AGENT_HEADER = "x-claude-code-agent-id";
const ANTHROPIC_BILLING_HEADER = "x-anthropic-billing-header";
const SUBAGENT_BILLING_FIELD = "cc_is_subagent";

/** Return whether trusted Claude Code request metadata identifies a child agent. */
export function isClaudeCodeSubagent(headers: Headers): boolean {
	if (
		headers.get(CLAUDE_CODE_PARENT_AGENT_HEADER)?.trim() ||
		headers.get(CLAUDE_CODE_AGENT_HEADER)?.trim()
	) {
		return true;
	}

	const billing = headers.get(ANTHROPIC_BILLING_HEADER);
	if (!billing) return false;
	return billing.split(";").some((field) => {
		const separator = field.indexOf("=");
		if (separator <= 0) return false;
		return (
			field.slice(0, separator).trim().toLowerCase() ===
				SUBAGENT_BILLING_FIELD &&
			field
				.slice(separator + 1)
				.trim()
				.toLowerCase() === "true"
		);
	});
}
