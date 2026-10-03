import type { RequestBodyContext } from "./request-body-context";

const DIRECTIVE = "Never push to main/master, force-push, or merge.";
const PARAGRAPH =
	"If you made code changes in a worktree you entered, commit before finishing — you don't need to ask — and push if the repository has a remote: the worktree can be deleted along with the session, and committed, pushed work survives. This holds unless the user's instructions, in the task, CLAUDE.md, or memory, reserve git for them. Never push to main/master, force-push, or merge. Open a draft PR when the task calls for one. If you didn't enter the worktree yourself this job, or you're in the user's own checkout, ask before committing or switching branches.";
const REPLACEMENT =
	"Never push directly to main/master or force-push. You may merge an operator-authorized pull request only after its required checks and review requirements are satisfied. A review-governor stop requires an explicit operator decision; never set operator-only override flags. Any separate session-specific or loop-authority prohibition on merging still applies.";

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
	const anchors = lines.filter((line) =>
		line.text.startsWith("If you made code changes in a worktree"),
	);
	if (headings.length === 0 && anchors.length === 0) return "unchanged";
	if (headings.length !== 1 || anchors.length !== 1) return "incompatible";
	const heading = headings[0];
	const paragraph = anchors[0];
	if (
		heading.text !== "# Background Session" ||
		paragraph.text !== PARAGRAPH ||
		heading.block !== paragraph.block ||
		heading.offset >= paragraph.offset
	)
		return "incompatible";
	// The paragraph must belong to this section, not a subsequent section or
	// nested example. Require a separate paragraph rather than a substring match.
	const text = texts.find((entry) => entry.block === paragraph.block)?.text;
	if (text === undefined) return "incompatible";
	const between = text.slice(
		heading.offset + heading.text.length,
		paragraph.offset,
	);
	if (/^\s*#{1,6}\s/m.test(between) || !/\n\r?\n$/.test(between)) {
		return "incompatible";
	}
	const after = text.slice(paragraph.offset + PARAGRAPH.length);
	if (after !== "" && !/^(?:\r?\n){2}/.test(after) && !/^\r?\n$/.test(after)) {
		return "incompatible";
	}
	const start = paragraph.offset + PARAGRAPH.indexOf(DIRECTIVE);
	const edited =
		text.slice(0, start) + REPLACEMENT + text.slice(start + DIRECTIVE.length);
	context.mutateParsedJson((body) => {
		body.system = !Array.isArray(system)
			? edited
			: system.map((block, index) =>
					index === paragraph.block ? { ...block, text: edited } : block,
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
