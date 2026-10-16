---
title: Claude Code background jobs got a 409 when Claude Code rendered a Background Session variant the merge policy did not recognize
date: 2026-10-16
category: integration-issues
module: claude-code-background-merge-policy
problem_type: integration_issue
component: proxy
symptoms:
  - "Every turn of a Claude Code background job returned `API Error: 409 The Claude Code background template is incompatible with the configured merge policy. Operator review of the host template is required.`"
  - "The job had run normally for about 19 hours; the first 409 appeared about nine minutes after a context compaction"
  - "Four consecutive turns over about 70 minutes all returned the same 409, and the job did no work in between"
  - "The failing requests had no rows in the `requests` table or the dashboard"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
framework_version: claude-code 2.1.301
tags: [claude-code, background-session, merge-policy, system-prompt, http-409, fail-closed, fixtures, compaction]
---

# Claude Code background jobs got a 409 when Claude Code rendered a Background Session variant the merge policy did not recognize

## Problem

With the opt-in Claude Code background merge policy enabled, a background job failed every request with HTTP 409 once Claude Code wrote its `# Background Session` system-prompt section in a wording the policy did not know. The policy (PR #414) recognized only the one render it had been captured from. Claude Code 2.1.301 produces six.

## Symptoms

- Claude Code showed `API Error: 409 The Claude Code background template is incompatible with the configured merge policy. Operator review of the host template is required.` on every turn.
- Job 5ec380f4 had run normally for about 19 hours. Its first 409 came about nine minutes after a context compaction, followed by three more over about 70 minutes with no work in between (session history).
- The failing requests had no rows in the `requests` table or the dashboard.

## What Didn't Work

- **Reading it as an Anthropic or Claude Code error.** The wording ("host template", "configured merge policy") sounds like it comes from upstream. It is better-ccflare's own response, `backgroundMergePolicyIncompatibilityResponse()` in `packages/proxy/src/claude-code-background-merge-policy.ts:302`, with error code `claude_code_background_merge_policy_incompatible`. Search the repo for the error code first.
- **Looking for the failing requests in `requests`.** The policy runs at ingress, and the 409 returns at `packages/proxy/src/proxy.ts:1233`, before account selection and before any usage recording. These requests leave no row, so request-history queries and the dashboard show nothing for the failing turns. Find the session through its Claude Code transcript instead.
- **Waiting, or nudging the job.** A session keeps sending the same cached system prompt. Every retry carried the same unrecognized section and got the same 409 (session history: four in a row). Per this session's diagnosis, Claude Code also retries a 409 for several minutes before showing it, which is why the first error surfaced about nine minutes after the compaction. The job only recovers once the proxy accepts its render.

## Solution

PR #524 replaced the single hard-coded section with a table of every render Claude Code 2.1.301 can produce. That is two prose sets (standard, and a lean set Claude Code picks per model) times three isolation modes (enter a worktree, configured `isolation: worktree`, work in place):

```ts
// packages/proxy/src/claude-code-background-merge-policy.ts:85
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
```

What each render gets:

- **Git-bearing renders** (enter, configured) still have the merge ban sentence, `Never push to main/master, force-push, or merge.`, replaced with the operator merge grant (`REPLACEMENT`, line 4).
- **Work-in-place renders** carry no Git paragraph, so they have no merge ban. They are forwarded byte-for-byte (`return "unchanged"`, line 287), and nothing is injected.
- **The anchor rule was relaxed, deliberately.** The old code required exactly one line starting `If you made code changes in a worktree`, the Git paragraph's first sentence. Work-in-place renders have none, so the rule is now "at most one" (line 256). An anchor that appears alongside a work-in-place section is rejected as drift (line 275): a Git paragraph outside the recognized section was not written there by the host.
- **Every other refusal stays.** There must be exactly one heading, the whole section must match a known render, the only variable part is the scratch path, limited to `/…/.claude/jobs/<id>/tmp` (lines 112-120), and later system blocks before the next heading must be empty.

The tests read one fixture per render from `packages/proxy/src/__tests__/fixtures/known-background-section*.txt`. Each was rendered from the installed Claude Code binary, not typed by hand. The incompatible cases include "work in place with a Git paragraph", "changed work-in-place paragraph" and "lean prose with standard Git paragraph".

To recover a stuck job after deploying, send it one more turn. Its next request carries the same render, which now passes. A job whose working directory is the home directory may refuse to open from Agent View with "Workspace not trusted", because Claude Code does not save trust for the home directory. Reopen it with `cd ~ && claude --resume <full-session-id>` and no other flags; extra flags start a copy instead.

## Why This Works

The policy has a narrow job. It rewrites one sentence the host wrote and refuses anything it cannot prove the host wrote. An unknown render gets a 409 by design. Forwarding it silently would hide host drift behind the very ban the operator configured the proxy to replace, and editing text it cannot recognize could hand the grant to lookalike text.

Claude Code builds the section at runtime from parts. It picks the prose set by model and the isolation mode by session, and it rebuilds the section when it rebuilds the system prompt after a compaction. Job 5ec380f4's state recorded `bgIsolation: "none"`. Its rebuilt prompt came out as the work-in-place render, which PR #414's single fixture did not cover (auto memory [claude]). So a job could pass for hours and then fail mid-run with no change on the proxy side. Recognizing the full set, rendered from the binary, closes that gap for 2.1.301 without loosening what counts as host-written text.

## Prevention

- **Re-render every variant from the installed binary when Claude Code updates, or at the next 409.** The method (auto memory [claude]):
  1. Read `.../@anthropic-ai/claude-code/bin/claude.exe` as latin1.
  2. Find the string literal containing `# Background Session` and the builder function around it. Minified names change every release, so anchor on the string content, not on identifiers.
  3. Evaluate the builder with stubbed `CLAUDE_CODE_SESSION_KIND=bg`, `CLAUDE_JOB_DIR` and `CLAUDE_BG_ISOLATION` plus a stubbed isolation getter. Call it once per prose set and isolation mode.
  4. Before trusting the others, `cmp` the default render against `known-background-section.txt` to prove the method reproduces a known fixture.
- **Don't hand-type fixtures from a captured prompt.** A captured prompt shows the one variant that session happened to get. The binary shows all of them, and a byte-for-byte match against an existing fixture proves the extraction (see [validate-against-live-payloads.md](../validate-against-live-payloads.md)).
- **Extend the table, not the matcher.** A new variant means a prose set or isolation mode in `KNOWN_SECTIONS` plus one fixture per new render. A render without a merge ban should forward unchanged, never get a grant added to it.
- **Expect a fail-closed policy to fire on host upgrades, and diagnose from the client side.** The 409 is the intended outcome for unknown text. The evidence lives in the Claude Code transcript, not in `requests`.

## Related Issues

- PR #414 added the policy; PR #524 fixed this. Both are merged.
- [claude-code-advisor-refused-as-unsupported-server-tool.md](claude-code-advisor-refused-as-unsupported-server-tool.md) and [claude-code-websearch-refused-as-no-implementation.md](claude-code-websearch-refused-as-no-implementation.md) cover other cases where the proxy refuses Claude Code traffic locally, before any upstream send.
- [new-claude-model-drift-alert-means-bundled-catalog-lag.md](new-claude-model-drift-alert-means-bundled-catalog-lag.md) is the same pattern: knowledge bundled in the proxy lags a new Claude release.
- [measure-session-remap-cache-cost-from-the-requests-table.md](../observability/measure-session-remap-cache-cost-from-the-requests-table.md) diagnoses sessions from `requests`, which this failure never reaches.
