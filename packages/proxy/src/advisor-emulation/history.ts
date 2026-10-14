import { isEmulatedAdvisorId } from "./types";

const PLACEHOLDER = "[Advisor response]";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Single source of truth for the text a worker sees as the advisor's
 * tool_result, in both replayed history and the live continuation.
 */
export function advisorToolResultText(content: unknown): string {
	if (isRecord(content)) {
		if (content.type === "advisor_result" && typeof content.text === "string") {
			return content.text;
		}
		if (
			content.type === "advisor_tool_result_error" &&
			typeof content.error_code === "string"
		) {
			return `Advisor unavailable (${content.error_code}). Continue without advice.`;
		}
	}
	return "Advisor unavailable (unavailable). Continue without advice.";
}

function isAdvisorCall(block: unknown): block is Record<string, unknown> {
	return (
		isRecord(block) &&
		block.type === "server_tool_use" &&
		block.name === "advisor"
	);
}

function isAdvisorResult(block: unknown): block is Record<string, unknown> {
	return isRecord(block) && block.type === "advisor_tool_result";
}

function isThinkingLike(block: unknown): boolean {
	if (!isRecord(block)) return false;
	if (block.type === "thinking" || block.type === "redacted_thinking") {
		return true;
	}
	return (
		block.type === "text" &&
		!(typeof block.text === "string" && block.text.trim() !== "")
	);
}

/**
 * Rewrite emulated advisor pairs in history as ordinary tool_use/tool_result
 * turns for Codex, and drop native pairs. Returns null when the body has no
 * advisor blocks (caller forwards the original bytes). Does not mutate input.
 *
 * A thinking-only remainder after a pair is dropped rather than emitted as a
 * trailing assistant message.
 */
export function projectAdvisorHistoryForCodex(
	body: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
	const messages = body.messages;
	if (!Array.isArray(messages)) return null;

	let changed = false;
	const out: unknown[] = [];
	for (const message of messages) {
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content) ||
			!message.content.some((b) => isAdvisorCall(b) || isAdvisorResult(b))
		) {
			out.push(message);
			continue;
		}
		changed = true;
		const content: unknown[] = message.content;
		// Pair each emulated call with the first later unclaimed result of its id.
		const claimed = new Set<number>();
		const pairs = new Map<number, number>();
		for (let i = 0; i < content.length; i++) {
			const b = content[i];
			if (!isAdvisorCall(b) || !isEmulatedAdvisorId(b.id)) continue;
			for (let j = i + 1; j < content.length; j++) {
				const r = content[j];
				if (!claimed.has(j) && isAdvisorResult(r) && r.tool_use_id === b.id) {
					pairs.set(i, j);
					claimed.add(j);
					break;
				}
			}
		}
		let segment: unknown[] = [];
		for (let i = 0; i < content.length; i++) {
			const b = content[i];
			const resultIndex = pairs.get(i);
			if (resultIndex !== undefined) {
				const call = b as Record<string, unknown>;
				const res = content[resultIndex] as Record<string, unknown>;
				out.push({
					...message,
					content: [
						...segment,
						{ type: "tool_use", id: call.id, name: "advisor", input: {} },
					],
				});
				out.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: call.id,
							content: advisorToolResultText(res.content),
						},
					],
				});
				segment = [];
				continue;
			}
			// Claimed results, orphan emulated blocks and native advisor blocks
			// are all dropped.
			if (claimed.has(i) || isAdvisorCall(b) || isAdvisorResult(b)) continue;
			segment.push(b);
		}
		if (pairs.size === 0) {
			const kept =
				segment.length === 0 || segment.every(isThinkingLike)
					? [...segment, { type: "text", text: PLACEHOLDER, citations: [] }]
					: segment;
			out.push({ ...message, content: kept });
		} else if (segment.length > 0 && !segment.every(isThinkingLike)) {
			out.push({ ...message, content: segment });
		}
	}
	return changed ? { ...body, messages: out } : null;
}
