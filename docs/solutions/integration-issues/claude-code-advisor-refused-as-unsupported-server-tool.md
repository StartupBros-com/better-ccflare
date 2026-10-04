---
title: Claude Code /advisor was refused as an unsupported server tool, and /advisor off did not unstick the chat
date: 2026-10-04
category: integration-issues
module: server-tool-routing
problem_type: integration_issue
component: proxy
symptoms:
  - "Every request in a chat with /advisor on returned `API Error: 400 The requested server-tool semantics are not supported.` (server_tool_unsupported_requirement)"
  - "Turning the advisor off with /advisor off in the stuck chat did not stop the 400s (Claude Code 2.1.288)"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
framework_version: claude-code 2.1.288
related_components:
  - providers
  - usage-collector
  - database
retire_when: "Claude Code changes how it holds a declared advisor tool or which refusal text makes it drop one; after a Claude Code upgrade, check the installed binary's strings for 'the advisor tool is not available' and 'until /clear or /compact'"
tags:
  - advisor
  - claude-code
  - server-tools
  - native-passthrough
  - first-party-anthropic
  - advisor-usage
  - usage-accounting
  - fail-closed
---

# Claude Code /advisor was refused as an unsupported server tool, and /advisor off did not unstick the chat

## Problem

Claude Code's `/advisor` declares the typed Anthropic server tool `advisor_20260301` (beta `advisor-tool-2026-03-01`). The proxy assumed every typed server tool other than `web_search_20250305` was a hosted tool it had to run itself. It had no implementation for advisor, so it refused every request in the chat. The obvious client-side escape didn't work either, which left the chat stuck until the proxy was fixed (#425, fixed in PR #432).

The design of the fix is in [routing-architecture.md, "Advisor native routing contract"](../../routing-architecture.md#advisor-native-routing-contract) and in [CONCEPTS.md](../../../CONCEPTS.md). This doc covers what the code doesn't show: how the failure looked, what didn't work, and how to check advisor in production.

## Symptoms

- From 2026-10-03 20:43 UTC, every request in a Claude Code chat with `/advisor` on returned `API Error: 400 The requested server-tool semantics are not supported.` (auto memory [claude]). The proxy refused it itself with code `server_tool_unsupported_requirement` (`packages/proxy/src/server-tool-routing-errors.ts:45-46`).
- Running `/advisor off` in that chat did not stop the 400s (Claude Code 2.1.288, observed by the operator).

## What Didn't Work

- **`/advisor off` as the stopgap.** Claude Code keeps a conversation's declared advisor tool, so the prompt prefix stays stable, until `/clear` or `/compact` (auto memory [claude]). Turning the setting off didn't remove the tool from the chat that was already failing.
  - The 2.1.289 `/advisor` message says turning the advisor on or off "applies right away", and that only a model change waits for `/clear` or `/compact`. Newer clients may therefore behave differently.
  - The escape that works on both versions is `/clear`, or relaunching the session with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 claude --resume <id>`.
- **Treating advisor like hosted web search.** The proxy runs `web_search_20250305` itself through its hosted-tool layer. It can't do the same for advisor, because only `api.anthropic.com` executes an advisor call. So advisor became a constraint on which accounts may carry the request, not a capability some provider implements. The routing doc gives the full reasoning.
- **Totalling advisor tokens from the iterations kept for pricing.** The first cut of `advisor_usage` summed only the advisor iterations retained for pricing, which stop at `MAX_USAGE_ITERATIONS = 64` (`packages/proxy/src/usage-collector.ts:194`). Billable advisor tokens past the 64th iteration were silently dropped. A cross-model review caught it before merge. The totals are now built over the full raw `usage.iterations` array (`usage-collector.ts:96-99`, `:359`).
- **Two traps in the first production check.**
  - It looked up the Claude Code session ID in `requests.client_session_id`. That column holds the client ID from the request body (`packages/proxy/src/proxy.ts:1845`), which for Claude Code is a JSON object with a `device_id`. The session ID showed up in `agent_used` (observed in production rows).
  - It ran while the advisor turn was still streaming. The request row, with its `advisor_usage`, appeared only after the response finished (observed: no row at 14:47:21, then the row at 14:47:38 EDT). An empty result during a long advisor turn is not proof that recording is broken.

## Solution

Advisor is now a native Anthropic passthrough requirement. In outline (the routing doc has the details):

- `deriveNativeAnthropicToolRequirement` (`packages/providers/src/server-tool-capabilities.ts:467`) detects the advisor declaration. Account selection, the dispatch backstop and Auto admission then keep the request on first-party Anthropic accounts.
- When no first-party account can serve it, the refusal uses the exact text Claude Code recovers from. `the advisor tool is not available` makes Claude Code drop the tool and retry, and `Advisor tool result content could not be processed` makes it strip advisor history (`packages/proxy/src/server-tool-routing-errors.ts:84`, `:91`).
- Advisor tokens are stored per model in `requests.advisor_usage`, a `TEXT` column in both SQLite and PostgreSQL (`packages/database/src/migrations.ts:496`, `:1578`; `packages/database/src/migrations-pg.ts:701`, `:1622`).

Checking it live: the operator runs `/advisor` in an interactive Claude Code session (`AGENTS.md` forbids scripted traffic to Anthropic accounts), then reads the result without writing anything:

```sql
-- sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db
SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') AS t,
       model, agent_used, advisor_usage
FROM requests
WHERE advisor_usage IS NOT NULL AND advisor_usage != ''
ORDER BY timestamp DESC LIMIT 5;
```

The first live call came on 2026-10-04 at 14:47:38 EDT, with Fable 5.1 as both the main model and the advisor. It returned 200 and recorded `[{"model":"claude-fable-5-1","inputTokens":199528,"outputTokens":6556,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}]`. That matches the `advisor_message` iteration in the Claude Code transcript.

## Why This Works

The root cause was an incorrect assumption: that every typed server tool is something the proxy must execute. For advisor that is impossible, so the right question is "which accounts may carry this request", not "which implementation serves this tool".

The refusals work because Claude Code recovers from advisor errors by matching substrings. A refusal whose text it doesn't recognise, like the old generic message, gives it no way out, and it repeats the same request until the user clears the chat. Matching its recovery text turns a stuck chat into one where advisor quietly drops off.

## Prevention

- **Before refusing any new typed Anthropic tool, check whether Claude Code can recover from the refusal.** Decide whether the proxy can run the tool (a hosted requirement) or only Anthropic can (a native requirement). Then make the refusal text match a client recovery path, or the chat stays stuck. The advisor phrases are pinned in `packages/proxy/src/server-tool-routing-errors.test.ts`, and in `advisor-passthrough.integration.test.ts`, `server-tool-routing.integration.test.ts` and `proxy-quality-routes.test.ts` under `packages/proxy/src/__tests__/`.
- **Re-check the recovery phrases after a Claude Code upgrade.** They are a contract with the client's version (see `retire_when`).
- **Never total billable usage from a capped snapshot.** Cap what you keep for display or pricing detail, but build the totals over the full array.
- **Know the client-side advisor facts when reading a report.** These were checked in the Claude Code 2.1.289 binary:
  - `/advisor <model>` in a terminal saves `advisorModel` to user settings, so it applies to every new session on the machine. `/advisor off` there is global too.
  - The per-session controls are the `--advisor <model>` launch flag and `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`.
  - The advisor must rank at least as high as the main model on the catalog's `advisor_rank`: Haiku 4.5 = 1, Sonnet 5 = 4, Sonnet 5.5 = 6, Opus 5 and 5.5 = 7, Fable 5.1 = 9. Equal ranks are allowed, so a Fable chat gets Fable advising Fable. Opus can't advise a Fable chat, and the client quietly leaves the advisor out instead.
  - Subagents check the same setting against their own model. This comes from reading the code; no subagent advisor call has been observed yet.
- **Expect large, uncached advisor input.** Each advisor call sends the whole transcript to the advisor model with no cache: the first live call read 199,528 input tokens and 0 cached. It counts against the advisor model's quota, not the main model's.

## Related Issues

- #425: the original report (closed after the live check). Fixed in PR #432.
- #437: review items PR #432 deferred, including a PostgreSQL test for `advisor_usage`.
- #431: a nearby server-tool refusal. Long conversations past the replay-scan caps may be refused with `server_tool_no_implementation`.
- [Commit-bound routing](../architecture-patterns/commit-bound-routing.md): the advisor filter applies its rule of checking which candidates are allowed before ranking them.
- [Codex trace input tokens are cache-inclusive](../observability/codex-trace-input-tokens-are-cache-inclusive.md): another case where token fields need care before you read cache behaviour from them.
