/** Prefix used for retained reasoning blocks minted by the Codex provider. */
export const CODEX_REASONING_RETENTION_PREFIX = "bccfr1.";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProxyMintedCodexReasoningBlock(block: unknown): boolean {
	return (
		isRecord(block) &&
		block.type === "redacted_thinking" &&
		typeof block.data === "string" &&
		block.data.startsWith(CODEX_REASONING_RETENTION_PREFIX)
	);
}

/**
 * Repair role alternation after a stripped-empty assistant message is dropped.
 *
 * Dropping a reasoning-only assistant turn can leave two adjacent user turns.
 * Native Anthropic documents combining consecutive same-role turns server-side,
 * but this helper also runs for every Anthropic-COMPATIBLE upstream (minimax,
 * zai, ollama, nanogpt, muse-spark, alibaba-coding-plan, ...), and those are
 * third-party validators with no such guarantee — Muse Spark's own notes
 * describe a strict validator behind the shim. Merging here keeps a valid
 * history for all of them and preserves content that a server-side merge would
 * silently collapse. Mirrors mergeConsecutiveSameRole in
 * packages/openai-responses-adapter/src/request-translator.ts.
 *
 * Only array-content messages are merged: string content is left untouched
 * rather than guessing at a concatenation the upstream may format differently.
 */
function canMergeAcrossDrop(previous: unknown, next: unknown): boolean {
	return (
		isRecord(previous) &&
		isRecord(next) &&
		previous.role === next.role &&
		Array.isArray(previous.content) &&
		Array.isArray(next.content)
	);
}

function mergeAcrossDrop(previous: JsonRecord, next: JsonRecord): JsonRecord {
	return {
		...previous,
		content: [
			...(previous.content as unknown[]),
			...(next.content as unknown[]),
		],
	};
}

/**
 * Remove proxy-minted Codex reasoning from an Anthropic Messages request. The
 * input is never mutated; when nothing is removed, the original body object is
 * returned by identity.
 */
export function stripCodexReasoningRetention<T>(body: T): {
	body: T;
	strippedCount: number;
} {
	if (!isRecord(body) || !Array.isArray(body.messages)) {
		return { body, strippedCount: 0 };
	}

	const originalMessages = body.messages;
	let strippedCount = 0;
	let messages: unknown[] | null = null;

	for (
		let messageIndex = 0;
		messageIndex < originalMessages.length;
		messageIndex++
	) {
		const message = originalMessages[messageIndex];
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		) {
			messages?.push(message);
			continue;
		}

		let retainedContent: unknown[] | null = null;
		for (
			let contentIndex = 0;
			contentIndex < message.content.length;
			contentIndex++
		) {
			const block = message.content[contentIndex];
			if (isProxyMintedCodexReasoningBlock(block)) {
				strippedCount++;
				retainedContent ??= message.content.slice(0, contentIndex);
			} else {
				retainedContent?.push(block);
			}
		}

		if (!retainedContent) {
			messages?.push(message);
			continue;
		}

		messages ??= originalMessages.slice(0, messageIndex);
		const soleBlock = retainedContent[0];
		const isEffectivelyEmpty =
			retainedContent.length === 0 ||
			(retainedContent.length === 1 &&
				isRecord(soleBlock) &&
				soleBlock.type === "text" &&
				soleBlock.text === "");
		if (!isEffectivelyEmpty) {
			messages.push({ ...message, content: retainedContent });
			continue;
		}

		// The message is being DROPPED. If that exposes two same-role neighbours,
		// merge them so no upstream sees a broken role sequence. Scoped to the
		// drop site: messages that were already adjacent before this strip are
		// left exactly as the caller sent them.
		const previous = messages[messages.length - 1];
		const next = originalMessages[messageIndex + 1];
		if (canMergeAcrossDrop(previous, next)) {
			messages[messages.length - 1] = mergeAcrossDrop(
				previous as JsonRecord,
				next as JsonRecord,
			);
			messageIndex++;
		}
	}

	if (!messages) return { body, strippedCount: 0 };

	return {
		body: { ...body, messages } as T,
		strippedCount,
	};
}
