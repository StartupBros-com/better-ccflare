import type { RequestBodyContext } from "./request-body-context";

const DIRECTIVE = "Never push to main/master, force-push, or merge.";
const REPLACEMENT =
	"Never push directly to main/master or force-push. You may merge an operator-authorized pull request only after its required checks and review requirements are satisfied. A review-governor stop requires an explicit operator decision; never set operator-only override flags. Any separate session-specific or loop-authority prohibition on merging still applies.";

const HEADING = "# Background Session";
const ANCHOR = "If you made code changes in a worktree";
const SCRATCH_PREFIX = "Use `$CLAUDE_JOB_DIR/tmp` (`";

/**
 * One host prose set, as Claude Code 2.1.301 renders it. The host selects the
 * lean set per model and one isolation mode per session: entering a worktree,
 * configured `isolation: worktree`, or working in place.
 */
interface Prose {
	intro: string;
	scratchSuffix: string;
	isolation: Record<"enter" | "configured" | "inPlace", readonly string[]>;
	git: readonly string[];
	report: readonly string[];
}

const STANDARD: Prose = {
	intro:
		'This session runs as a background job. The user may be chatting with you live or may have stepped away to check results later — respond naturally either way, and don\'t refer to yourself as "a background agent."',
	scratchSuffix:
		"`) for any temporary files (scripts, query files, intermediate outputs) instead of `/tmp` — parallel bg jobs share `/tmp` and clobber each other's files. This directory already exists and is cleaned up when the job is deleted, so anything the user should keep belongs somewhere durable instead.",
	isolation: {
		enter: [
			"Before making any code changes, use the EnterWorktree tool to isolate your work from other parallel jobs and the user's working copy — unless your cwd is already under `.claude/worktrees/`, in which case you're already isolated. This is enforced: file edits in the shared checkout are rejected until you isolate, so call EnterWorktree before your first edit rather than after a rejected attempt. If you're only reading, searching, or answering questions, skip this and work in place. If EnterWorktree fails, continue in place.",
		],
		configured: [
			"This agent is configured with `isolation: worktree`. Call the EnterWorktree tool as your first action — before reading files or running commands — unless your cwd is already under `.claude/worktrees/`. If EnterWorktree fails, continue in place.",
		],
		inPlace: [
			"Edit files directly in your working directory — this session is configured to work in place rather than isolating into a worktree. Skip EnterWorktree unless the user explicitly asks to work in a worktree.",
		],
	},
	git: [
		"If you made code changes in a worktree you entered, commit before finishing — you don't need to ask — and push if the repository has a remote: the worktree can be deleted along with the session, and committed, pushed work survives. This holds unless the user's instructions, in the task, CLAUDE.md, or memory, reserve git for them. Never push to main/master, force-push, or merge. Open a draft PR when the task calls for one. If you didn't enter the worktree yourself this job, or you're in the user's own checkout, ask before committing or switching branches.",
	],
	report: [
		"End the job with a report the user can act on: what you did, where it lives — path, branch, PR, or the answer itself — and the next command if one is needed. If you're running as a subagent, the git guidance above and this report don't apply: return your work to your caller.",
	],
};

const LEAN: Prose = {
	intro:
		'This session runs as a background job. The user may be chatting with you live or may have stepped away to check results later. Please respond naturally either way - there\'s no need to refer to yourself as a "background agent", or anything like that.',
	scratchSuffix:
		"`) for any temporary files (scripts, query files, intermediate outputs) instead of `/tmp`. Parallel bg jobs share `/tmp` and clobber each other's files. This directory already exists and is cleaned up when the job is deleted, so anything the user should keep belongs somewhere durable instead.",
	isolation: {
		enter: [
			"Before making any code changes, use the EnterWorktree tool to isolate your work from other parallel jobs and the user's working copy. The only exception to this is if your cwd is already under `.claude/worktrees/`, in which case you're already isolated.",
			"This is enforced: file edits in the shared checkout are rejected until you isolate, so call EnterWorktree before your first edit rather than after a rejected attempt. If you're only reading, searching, or answering questions, skip this and work in place. If EnterWorktree fails, continue in place.",
		],
		configured: [
			"This agent is configured with `isolation: worktree`. Please call the EnterWorktree tool as your first action before reading files or running commands, unless your cwd is already under `.claude/worktrees/`. If EnterWorktree fails, continue in place.",
		],
		inPlace: [
			"Please edit files directly in your working directory — this session is configured to work in place rather than isolating into a worktree. Skip EnterWorktree unless the user explicitly asks to work in a worktree.",
		],
	},
	git: [
		"If you made code changes in a worktree you entered, commit them before finishing (you don't need to ask just to do this!) and push if the repository has a remote. This is because the worktree can be deleted along with the session, but work which has been committed and pushed will survive.",
		"The only case you don't want to do this in is if the user has clearly told you not to use git yourself, for example via their own instructions in this session, memory which you have access to, or their CLAUDE.md file.",
		"Never push to main/master, force-push, or merge. Be sure to open a draft PR when the task calls for one. If you didn't enter the worktree that you're currently in yourself, or you're in the user's own checkout, please ask before committing or switching branches.",
	],
	report: [
		"When you're done with your job, end it with a report that the user can act on, which contains what you did and where it lives. For example, the most relevant path, branch or PR, or, if you just have a raw answer, that answer itself. Make sure to also include the next command if one is needed!",
		"If you're running as a subagent, the git guidance above and this report don't apply, and you can simply return your work to your caller.",
	],
};

interface KnownSection {
	intro: string;
	scratchSuffix: string;
	/** Every paragraph after the scratch-path slot. */
	rest: readonly string[];
	/** Work-in-place renders carry no Git guidance, so no directive to edit. */
	git: boolean;
}

const KNOWN_SECTIONS: readonly KnownSection[] = [STANDARD, LEAN].flatMap(
	(prose) =>
		(["enter", "configured", "inPlace"] as const).map((mode) => ({
			intro: prose.intro,
			scratchSuffix: prose.scratchSuffix,
			rest: [
				...prose.isolation[mode],
				...(mode === "inPlace" ? [] : prose.git),
				...prose.report,
			],
			git: mode !== "inPlace",
		})),
);

/** All section text is fixed except the host-rendered, backtick-delimited scratch path. */
function knownSection(section: string): KnownSection | undefined {
	const parts = section.replace(/\r\n/g, "\n").trimEnd().split("\n\n");
	return KNOWN_SECTIONS.find(
		(known) =>
			parts.length === known.rest.length + 3 &&
			parts[0] === HEADING &&
			parts[1] === known.intro &&
			known.rest.every((paragraph, index) => parts[index + 3] === paragraph) &&
			isScratch(parts[2], known.scratchSuffix),
	);
}

function isScratch(scratch: string, suffix: string): boolean {
	if (!scratch.startsWith(SCRATCH_PREFIX) || !scratch.endsWith(suffix))
		return false;
	const path = scratch.slice(SCRATCH_PREFIX.length, -suffix.length);
	// Delimiters and control characters cannot become instructions through this variable slot.
	return /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+\.claude\/jobs\/[A-Za-z0-9_-]+\/tmp$/.test(
		path,
	);
}

interface Line {
	text: string;
	block: number;
	offset: number;
}

/**
 * Read only plain instruction lines. Quoted examples, fenced code, and XML
 * wrappers (including repository/tool material) are not host instructions.
 * Carry quoting state across text blocks; splitting a wrapper cannot promote it.
 * This is deliberately not a general Markdown parser or an authority evaluator.
 */
function instructionLines(
	texts: { text: string; block: number }[],
): Line[] | null {
	const lines: Line[] = [];
	let fence: { marker: string; length: number } | undefined;
	let wrapper: string | undefined;
	let ambiguousClose = false;
	let comment = false;
	for (const { text, block } of texts) {
		let offset = 0;
		for (const raw of text.split("\n")) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			const current = { text: line, block, offset };
			offset += raw.length + 1;
			if (wrapper && line.includes(`</${wrapper}>`)) ambiguousClose = true;
			const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence) {
				if (
					delimiter?.[1][0] === fence.marker &&
					delimiter[1].length >= fence.length &&
					delimiter[2].trim() === ""
				)
					fence = undefined;
				continue;
			}
			const wasWrapped = wrapper !== undefined;
			let hasTag = false;
			let cursor = 0;
			// Consume markup in source order: a comment excludes only its own
			// contents, not an adjacent wrapper transition or the following text.
			while (cursor < line.length) {
				if (comment) {
					const end = line.indexOf("-->", cursor);
					if (end === -1) break;
					comment = false;
					cursor = end + 3;
					continue;
				}
				const remaining = line.slice(cursor);
				if (/^(?: {4}|\t|\s*>)/.test(remaining)) break;
				const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(remaining);
				if (openingFence && !hasTag) {
					fence = {
						marker: openingFence[1][0],
						length: openingFence[1].length,
					};
					break;
				}
				// Only block-leading markup can change an exclusion. Inline mentions
				// in prose or inline code cannot open or close a host wrapper.
				const match = /^ {0,3}(?:<!--|<(\/?)([A-Za-z][\w:.-]*)\b[^>]*>)/.exec(
					remaining,
				);
				if (!match) {
					if (!wasWrapped && !hasTag)
						lines.push({
							text: remaining,
							block,
							offset: current.offset + cursor,
						});
					break;
				}
				cursor += match.index + match[0].length;
				if (match[0].trimStart() === "<!--") {
					if (wrapper) {
						// Only skip comments on this boundary line. An unmatched
						// literal in the opaque body must not hide the real close.
						const end = line.indexOf("-->", cursor);
						if (end === -1) break;
						cursor = end + 3;
						continue;
					}
					comment = true;
					continue;
				}
				hasTag = true;
				if (match[1]) {
					if (wrapper === match[2]) {
						wrapper = undefined;
						ambiguousClose = false;
					}
				} else if (!wrapper && !match[0].endsWith("/>")) {
					// The outer wrapper owns the exclusion. Interior generic tags,
					// including unmatched tags and HTML void elements, are opaque.
					wrapper = match[2];
				}
			}
		}
	}
	// A quoted/fenced close cannot establish host authority. If no real close
	// follows it, reject the ambiguity instead of silently forwarding the ban.
	return wrapper && ambiguousClose ? null : lines;
}

export type BackgroundMergePolicyResult =
	| "unchanged"
	| "replaced"
	| "incompatible";

/** Caller must establish server opt-in and native Claude Code ingress first. */
export function applyClaudeCodeBackgroundMergePolicy(
	context: RequestBodyContext,
): BackgroundMergePolicyResult {
	const system = context.getParsedJson()?.system;
	const texts: { text: string; block: number }[] = [];
	if (typeof system === "string") texts.push({ text: system, block: 0 });
	else if (Array.isArray(system)) {
		for (const [block, value] of system.entries()) {
			if (value?.type === "text" && typeof value.text === "string") {
				texts.push({ text: value.text, block });
			}
		}
	}
	const lines = instructionLines(texts);
	if (lines === null) return "incompatible";
	const headings = lines.filter((line) =>
		/^\s*(?:#{1,6}\s*background[\s_-]+session\b.*|background[\s_-]+session\s*)$/i.test(
			line.text,
		),
	);
	const anchors = lines.filter((line) => line.text.startsWith(ANCHOR));
	if (headings.length === 0 && anchors.length === 0) return "unchanged";
	if (headings.length !== 1 || anchors.length > 1) return "incompatible";
	const heading = headings[0];
	if (heading.text !== HEADING) return "incompatible";
	// Validate the whole active section. A quoted/nested heading cannot hide drift
	// by ending it early, and a later block without a genuine heading is still its content.
	const text = texts.find((entry) => entry.block === heading.block)?.text;
	if (text === undefined) return "incompatible";
	const nextHeading = lines.find(
		(line) =>
			(line.block > heading.block ||
				(line.block === heading.block && line.offset > heading.offset)) &&
			/^ {0,3}#(?:\s|$)/.test(line.text),
	);
	const sectionEnd =
		nextHeading?.block === heading.block ? nextHeading.offset : text.length;
	const section = text.slice(heading.offset, sectionEnd);
	const known = knownSection(section);
	// A Git-bearing section holds the only anchor. Work-in-place renders have
	// none, so an anchor elsewhere is drift rather than a no-op.
	if (known === undefined || (!known.git && anchors.length > 0))
		return "incompatible";
	for (const entry of texts) {
		if (entry.block <= heading.block) continue;
		if (nextHeading !== undefined && entry.block > nextHeading.block) break;
		const end =
			nextHeading?.block === entry.block
				? nextHeading.offset
				: entry.text.length;
		if (entry.text.slice(0, end).trim() !== "") return "incompatible";
		if (nextHeading?.block === entry.block) break;
	}
	if (!known.git) return "unchanged";
	// Every Git-bearing known section holds the directive exactly once.
	const start = heading.offset + section.indexOf(DIRECTIVE);
	const edited =
		text.slice(0, start) + REPLACEMENT + text.slice(start + DIRECTIVE.length);
	context.mutateParsedJson((body) => {
		body.system = !Array.isArray(system)
			? edited
			: system.map((block, index) =>
					index === heading.block ? { ...block, text: edited } : block,
				);
	});
	return "replaced";
}

export function backgroundMergePolicyIncompatibilityResponse(): Response {
	return Response.json(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "claude_code_background_merge_policy_incompatible",
				message:
					"The Claude Code background template is incompatible with the configured merge policy. Operator review of the host template is required.",
			},
		},
		{ status: 409 },
	);
}
