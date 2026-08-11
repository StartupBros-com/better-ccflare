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
		}
	}

	if (!messages) return { body, strippedCount: 0 };

	return {
		body: { ...body, messages } as T,
		strippedCount,
	};
}
