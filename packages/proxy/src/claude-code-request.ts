import type {
	AgentAttributionSource,
	RouteLineageMetadata,
} from "@better-ccflare/types";
import { opaqueRuntimeId } from "./opaque-runtime-id";

const CLAUDE_CODE_PARENT_AGENT_HEADER = "x-claude-code-parent-agent-id";
const CLAUDE_CODE_AGENT_HEADER = "x-claude-code-agent-id";
const ANTHROPIC_BILLING_HEADER = "x-anthropic-billing-header";
const SUBAGENT_BILLING_FIELD = "cc_is_subagent";
const MAX_CLAUDE_CODE_AGENT_ID_BYTES = 256;

export interface ClaudeCodeRouteLineageScope {
	readonly callerIdentity: string | null | undefined;
	readonly sessionId: string | null | undefined;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function boundedAgentId(value: string | null): string | null {
	if (
		value === null ||
		value.length === 0 ||
		value.trim() !== value ||
		hasControlCharacter(value) ||
		new TextEncoder().encode(value).byteLength > MAX_CLAUDE_CODE_AGENT_ID_BYTES
	) {
		return null;
	}
	return value;
}

/**
 * Compile-time exhaustiveness guard for `AgentAttributionSource`. Adding a
 * new source to the union without classifying it below in
 * `attributionSourceIdentifiesAgent` is a TypeScript error at the
 * `default: return assertNeverAttributionSource(source)` call, not a silent
 * runtime default.
 */
function assertNeverAttributionSource(source: never): never {
	throw new Error(
		`Unclassified agent attribution source \`${String(source)}\`: attributionSourceIdentifiesAgent's switch is non-exhaustive.`,
	);
}

/**
 * Return whether an attribution source -- as classified upstream by the
 * request interceptor -- actually identifies a real agent. This is the
 * trust boundary: `session_header` means the interceptor found nothing but
 * a session id, and a session identifies a conversation, not an agent, so
 * it must never count as agent evidence here or at any decision that
 * consumes this value.
 */
export function attributionSourceIdentifiesAgent(
	source: AgentAttributionSource | null | undefined,
): boolean {
	switch (source) {
		case "prompt_agent":
		case "header_agent":
			return true;
		case "session_header":
		case "none":
		case undefined:
		case null:
			return false;
		default:
			return assertNeverAttributionSource(source);
	}
}

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

/**
 * Derive privacy-safe child lineage only inside an authenticated caller and
 * Claude Code session scope. Marker-only descendants remain classified as
 * children but deliberately receive no reusable home key.
 */
export function deriveClaudeCodeRouteLineage(
	headers: Headers,
	scope: ClaudeCodeRouteLineageScope,
): RouteLineageMetadata {
	if (!isClaudeCodeSubagent(headers)) {
		return { kind: "root", childHomeKey: null };
	}

	const agentId = boundedAgentId(headers.get(CLAUDE_CODE_AGENT_HEADER));
	const callerIdentity = scope.callerIdentity?.trim();
	const sessionId = scope.sessionId?.trim();
	if (!agentId || !callerIdentity || !sessionId) {
		return { kind: "descendant", childHomeKey: null };
	}

	return {
		kind: "descendant",
		childHomeKey: opaqueRuntimeId(
			"claude-code-child-home",
			callerIdentity,
			sessionId,
			agentId,
		),
	};
}
