import { Logger } from "@better-ccflare/logger";

const log = new Logger("AdvisorResultOwnership");

export const ADVISOR_RESULT_UNPROCESSABLE_MARKERS: readonly string[] = [
	"Advisor tool result content could not be processed",
	"found in advisor_tool_result blocks",
];

export function isAdvisorResultUnprocessableMessage(message: string): boolean {
	return ADVISOR_RESULT_UNPROCESSABLE_MARKERS.some((m) => message.includes(m));
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_B64_CHARS = 160;
const SCAN_BYTES = 128;

/**
 * The encrypted advisor blob is a protobuf whose prefix embeds a lowercase UUID
 * (tag 0x22, length 0x24) identifying the producing account. Only a bounded
 * prefix is decoded.
 */
export function readAdvisorResultOwnerKey(
	encryptedContent: unknown,
): string | null {
	if (typeof encryptedContent !== "string" || encryptedContent.length === 0) {
		return null;
	}
	try {
		const bytes = Buffer.from(
			encryptedContent.slice(0, PREFIX_B64_CHARS),
			"base64",
		);
		const limit = Math.min(bytes.length - 37, SCAN_BYTES);
		for (let i = 0; i < limit; i++) {
			if (bytes[i] === 0x22 && bytes[i + 1] === 0x24) {
				const candidate = bytes.toString("latin1", i + 2, i + 38);
				if (UUID_RE.test(candidate)) return candidate;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRedactedResult(block: unknown): block is Record<string, unknown> {
	return (
		isRecord(block) &&
		block.type === "advisor_tool_result" &&
		isRecord(block.content) &&
		block.content.type === "advisor_redacted_result"
	);
}

export function advisorResultOwnerKeyFromBlock(block: unknown): string | null {
	if (!isRedactedResult(block)) return null;
	return readAdvisorResultOwnerKey(
		(block.content as Record<string, unknown>).encrypted_content,
	);
}

// Each account has one current key. A key may be shared by several accounts
// (seats in one organization can decrypt each other's results), so the
// reverse index holds a set rather than evicting the earlier account.
const keyByAccount = new Map<string, string>();
const accountsByKey = new Map<string, Set<string>>();

export function recordAdvisorResultOwner(
	accountId: string,
	ownerKey: string,
): void {
	const previousKey = keyByAccount.get(accountId);
	if (previousKey === ownerKey) return;
	if (previousKey !== undefined) {
		const previousOwners = accountsByKey.get(previousKey);
		previousOwners?.delete(accountId);
		if (previousOwners?.size === 0) accountsByKey.delete(previousKey);
	}
	keyByAccount.set(accountId, ownerKey);
	const owners = accountsByKey.get(ownerKey) ?? new Set<string>();
	owners.add(accountId);
	accountsByKey.set(ownerKey, owners);
	log.info(`Advisor result owner key mapped to account ${accountId}`);
}

export function getAdvisorResultOwnerKey(
	accountId: string,
): string | undefined {
	return keyByAccount.get(accountId);
}

export function getAdvisorResultOwnerAccounts(
	ownerKey: string,
): ReadonlySet<string> | undefined {
	return accountsByKey.get(ownerKey);
}

export function resetAdvisorResultOwnershipForTests(): void {
	keyByAccount.clear();
	accountsByKey.clear();
}

export function mayContainAdvisorResult(buffer: ArrayBuffer | null): boolean {
	if (!buffer) return false;
	return Buffer.from(buffer).includes("advisor_tool_result");
}

export type AdvisorResultStrip = Readonly<{
	body: Record<string, unknown>;
	strippedResults: number;
	thinkingStrippedMessages: number;
}>;

function isBlankText(block: unknown): boolean {
	if (!isRecord(block) || block.type !== "text") return false;
	return !(typeof block.text === "string" && block.text.trim() !== "");
}

function isThinking(block: unknown): boolean {
	return (
		isRecord(block) &&
		(block.type === "thinking" || block.type === "redacted_thinking")
	);
}

function isThinkingLike(block: unknown): boolean {
	return isThinking(block) || isBlankText(block);
}

export function stripAdvisorResults(
	body: Readonly<Record<string, unknown>>,
	shouldStrip: (ownerKey: string | null) => boolean,
): AdvisorResultStrip | null {
	const messages = body.messages;
	if (!Array.isArray(messages)) return null;

	const strippedBlocks = new Set<unknown>();
	const strippedIds = new Set<string>();
	for (const message of messages) {
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		for (const block of message.content) {
			if (!isRedactedResult(block)) continue;
			if (!shouldStrip(advisorResultOwnerKeyFromBlock(block))) continue;
			strippedBlocks.add(block);
			if (typeof block.tool_use_id === "string") {
				strippedIds.add(block.tool_use_id);
			}
		}
	}
	if (strippedBlocks.size === 0) return null;

	const newMessages: unknown[] = [...messages];
	let firstModified = -1;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		const kept = message.content.filter(
			(block: unknown) =>
				!strippedBlocks.has(block) &&
				!(
					isRecord(block) &&
					block.type === "server_tool_use" &&
					block.name === "advisor" &&
					typeof block.id === "string" &&
					strippedIds.has(block.id)
				),
		);
		if (kept.length === message.content.length) continue;
		if (firstModified < 0) firstModified = i;
		if (kept.length === 0 || kept.every(isThinkingLike)) {
			kept.push({ type: "text", text: "[Advisor response]", citations: [] });
		}
		newMessages[i] = { ...message, content: kept };
	}

	let thinkingStrippedMessages = 0;
	const thinking = body.thinking;
	const thinkingEnabled = isRecord(thinking) && thinking.type === "enabled";
	if (!thinkingEnabled && firstModified >= 0) {
		for (let i = firstModified; i < newMessages.length; i++) {
			const message = newMessages[i];
			if (
				!isRecord(message) ||
				message.role !== "assistant" ||
				!Array.isArray(message.content) ||
				// Claude Code's BNt() leaves a message without thinking untouched,
				// blank text included.
				!message.content.some(isThinking)
			) {
				continue;
			}
			const kept = message.content.filter(
				(block: unknown) => !isThinkingLike(block),
			);
			if (kept.length === 0) {
				kept.push({ type: "text", text: "[Thinking removed]", citations: [] });
			}
			newMessages[i] = { ...message, content: kept };
			thinkingStrippedMessages++;
		}
	}

	return {
		body: { ...body, messages: newMessages },
		strippedResults: strippedBlocks.size,
		thinkingStrippedMessages,
	};
}

export function stripForeignAdvisorResults(
	body: Readonly<Record<string, unknown>>,
	targetAccountId: string,
): AdvisorResultStrip | null {
	const targetKey = getAdvisorResultOwnerKey(targetAccountId);
	return stripAdvisorResults(body, (key) => {
		if (key === null) return false;
		if (targetKey !== undefined) return key !== targetKey;
		const owners = getAdvisorResultOwnerAccounts(key);
		return owners !== undefined && !owners.has(targetAccountId);
	});
}

export function stripAllAdvisorResults(
	body: Readonly<Record<string, unknown>>,
): AdvisorResultStrip | null {
	return stripAdvisorResults(body, () => true);
}
