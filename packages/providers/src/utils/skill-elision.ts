import { Config } from "@better-ccflare/config";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("SkillElision");

/** Injected-skill payloads below this size are never stubbed (not worth it). */
const SKILL_ELISION_MIN_CHARS = 10_000;
const SKILL_TEXT_MARKER = "Base directory for this skill: ";

// Native Anthropic passthrough never needs elision. Defense in depth: every
// real call site is already a non-Anthropic translation chokepoint, but this
// function is also reachable from the shared model-mapping utility that the
// real Anthropic provider itself calls, so the gate must live here too.
const ANTHROPIC_NATIVE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"claude-console-api",
]);

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SkillElisionRecord {
	readonly skillName: string;
	readonly originalLength: number;
}

export interface SkillElisionOutcome<T> {
	readonly body: T;
	readonly elided: readonly SkillElisionRecord[];
}

/**
 * Extract the lowercased basename of the directory named on the marker line,
 * or null if the marker isn't present anywhere in `text`. The marker match is
 * "contains", not "starts with" — Claude Code's skill bundle text can carry
 * other content before the marker line. Backslashes are normalized to
 * forward slashes first so a Windows client path basenames correctly, and a
 * trailing slash is filtered out rather than turning the basename into "".
 */
function extractSkillBasename(text: string): string | null {
	const markerIndex = text.indexOf(SKILL_TEXT_MARKER);
	if (markerIndex === -1) return null;
	const dirStart = markerIndex + SKILL_TEXT_MARKER.length;
	const lineEnd = text.indexOf("\n", dirStart);
	const dir = text
		.slice(dirStart, lineEnd === -1 ? text.length : lineEnd)
		.trim();
	const basename = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop();
	return basename ? basename.toLowerCase() : null;
}

function skillStub(skillName: string, originalLength: number): string {
	return `[better-ccflare] '${skillName}' skill document elided (${originalLength} chars). The skill was already loaded; continue applying its instructions.`;
}

/**
 * Evaluate one text payload for elision. Returns a record when it qualifies
 * (marker present, basename in the blocked set, length at or above the
 * floor), else null.
 */
function elideOne(
	text: string,
	blocked: ReadonlySet<string>,
): SkillElisionRecord | null {
	if (text.length < SKILL_ELISION_MIN_CHARS) return null;
	const basename = extractSkillBasename(text);
	if (basename === null || !blocked.has(basename)) return null;
	return { skillName: basename, originalLength: text.length };
}

/**
 * Handle one content block: a `{type:"text", text}` block, or a
 * `{type:"tool_result", content}` block whose content is either a string or
 * an array of sub-blocks (only `{type:"text", text}` sub-blocks are
 * scanned/elided within it, each independently). Returns the possibly-new
 * block (identity-preserved when untouched) plus any records produced.
 */
function elideBlock(
	block: unknown,
	blocked: ReadonlySet<string>,
): { block: unknown; records: SkillElisionRecord[] } {
	if (!isRec(block)) return { block, records: [] };

	if (block.type === "text" && typeof block.text === "string") {
		const record = elideOne(block.text, blocked);
		if (!record) return { block, records: [] };
		return {
			block: {
				...block,
				text: skillStub(record.skillName, record.originalLength),
			},
			records: [record],
		};
	}

	if (block.type === "tool_result") {
		const content = block.content;
		if (typeof content === "string") {
			const record = elideOne(content, blocked);
			if (!record) return { block, records: [] };
			return {
				block: {
					...block,
					content: skillStub(record.skillName, record.originalLength),
				},
				records: [record],
			};
		}
		if (Array.isArray(content)) {
			const records: SkillElisionRecord[] = [];
			let nextContent: unknown[] | null = null;
			for (let i = 0; i < content.length; i++) {
				const sub = content[i];
				if (isRec(sub) && sub.type === "text" && typeof sub.text === "string") {
					const record = elideOne(sub.text, blocked);
					if (record) {
						records.push(record);
						nextContent ??= content.slice(0, i);
						nextContent.push({
							...sub,
							text: skillStub(record.skillName, record.originalLength),
						});
						continue;
					}
				}
				nextContent?.push(sub);
			}
			if (!nextContent) return { block, records: [] };
			return { block: { ...block, content: nextContent }, records };
		}
	}

	return { block, records: [] };
}

/**
 * Pure core: scans `body.messages[].content[]` (each message's content
 * array; string-content messages have nothing block-shaped to scan and are
 * left alone). Never mutates. Returns the original `body` by identity when
 * nothing changes.
 */
export function elideSkillBundles<T>(
	body: T,
	blockedSkills: readonly string[],
): SkillElisionOutcome<T> {
	const blocked = new Set(blockedSkills.map((s) => s.toLowerCase()));
	if (
		blocked.size === 0 ||
		!isRec(body) ||
		!Array.isArray((body as Rec).messages)
	) {
		return { body, elided: [] };
	}

	const originalMessages = (body as Rec).messages as unknown[];
	const allRecords: SkillElisionRecord[] = [];
	let nextMessages: unknown[] | null = null;

	for (let i = 0; i < originalMessages.length; i++) {
		const message = originalMessages[i];
		if (!isRec(message) || !Array.isArray(message.content)) {
			nextMessages?.push(message);
			continue;
		}

		const originalContent = message.content;
		let nextContent: unknown[] | null = null;
		for (let j = 0; j < originalContent.length; j++) {
			const { block, records } = elideBlock(originalContent[j], blocked);
			if (records.length > 0) {
				allRecords.push(...records);
				nextContent ??= originalContent.slice(0, j);
			}
			nextContent?.push(block);
		}

		if (!nextContent) {
			nextMessages?.push(message);
			continue;
		}

		nextMessages ??= originalMessages.slice(0, i);
		nextMessages.push({ ...message, content: nextContent });
	}

	if (!nextMessages) return { body, elided: [] };

	return {
		body: { ...body, messages: nextMessages } as T,
		elided: allRecords,
	};
}

/**
 * Orchestrator used at the actual call sites: gates on provider name, no-ops
 * fast when the blocklist is empty (the default), and logs one line per
 * elision (skill name + original length only — never content).
 */
export function applySkillElision<T>(
	providerName: string,
	body: T,
	blockedSkills: readonly string[],
): T {
	if (blockedSkills.length === 0) return body;
	if (ANTHROPIC_NATIVE_PROVIDERS.has(providerName)) return body;
	const { body: nextBody, elided } = elideSkillBundles(body, blockedSkills);
	for (const record of elided) {
		log.info(
			`Elided '${record.skillName}' skill bundle (${record.originalLength} chars) for provider ${providerName}`,
		);
	}
	return nextBody;
}

// --- Config plumbing for the hot path ---
// transformRequestBody has no config-injection seam across the Provider
// interface (it's `transformRequestBody(request, account?)`, fixed by the
// shared Provider type), so there's no clean way to thread a resolved
// ProxyContext-level config value in. This lazily-constructed, module-level
// Config singleton is the smallest-diff path, precedented by the existing
// CCFLARE_CODEX_* env-read pattern in the Codex provider
// (getCodexReasoningRetention in @better-ccflare/config), extended here to
// also cover the file-backed field. Restart-scoped like every other policy
// resolved this way in this codebase: the config FILE is read once and
// cached for the process lifetime, but CCFLARE_SKILL_ELISION_BLOCKED is
// re-read live on every call (Config#getSkillElisionBlockedSkills already
// does this), so the env override still works without a restart.
let cachedConfig: Config | null = null;
function getConfig(): Config {
	cachedConfig ??= new Config();
	return cachedConfig;
}

export function resolveSkillElisionBlockedSkills(): readonly string[] {
	return getConfig().getSkillElisionBlockedSkills();
}
