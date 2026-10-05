---
title: Claude Code WebSearch was refused locally as no_implementation although first-party Anthropic accounts run it
date: 2026-10-04
category: integration-issues
module: server-tool-routing
problem_type: integration_issue
component: proxy
symptoms:
  - "Claude Code WebSearch helper requests returned HTTP 400 server_tool_capability_unavailable (reason no_implementation) with zero upstream sends"
  - "Production rows showed 5 first-party Anthropic OAuth candidates, 0 proven, zeroAttemptReason all_unavailable"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
framework_version: claude-code 2.1.289
related_components:
  - providers
  - types
retire_when: "Claude Code changes the WebSearch helper request shape (forced web_search tool_choice, search_profile) or Anthropic starts accepting forced tool choice on Opus 5.5, Sonnet 5.5 and Fable 5.1; after a Claude Code upgrade, re-read the helper request in the binary"
tags:
  - web-search
  - claude-code
  - server-tools
  - native-passthrough
  - first-party-anthropic
  - tool-choice
  - search-profile
  - fail-closed
---

# Claude Code WebSearch was refused locally as no_implementation although first-party Anthropic accounts run it

## Problem

Claude Code's WebSearch tool sends a helper request: `POST /v1/messages?beta=true` with the main-loop model, one user message `Perform a web search for the query: ...`, `thinking: {type: "disabled"}`, `tool_choice: {type: "tool", name: "web_search"}`, no client tools, and one tool `{type: "web_search_20250305", name: "web_search", max_uses: 8, search_profile?: "fast", allowed_domains?, blocked_domains?}` (read from the Claude Code 2.1.289 binary). The proxy refused it before any send, although `api.anthropic.com` executes that tool itself (refs #279, #282, #431, #432).

The design is in [routing-architecture.md, "Hosted WebSearch routing contract"](../../routing-architecture.md#hosted-websearch-routing-contract) and [CONCEPTS.md](../../../CONCEPTS.md). This doc covers how it looked, what did not work, and how to check it in production.

## Symptoms

- HTTP 400, code `server_tool_capability_unavailable` (reason `no_implementation`, `packages/proxy/src/server-tool-routing-errors.ts`). The message starts `No configured provider route implements the requested server-tool semantics.` and says it is a permanent capability gap in the account pool.
- Production helper rows for 2026-09-20 to 2026-10-04, 3 to 83 a day, had 5 first-party Anthropic OAuth candidates, 0 proven, and `zeroAttemptReason: all_unavailable`. No account was used and nothing reached upstream. The helper models in those rows were `claude-opus-5-5` and `claude-fable-5-1`.

## What Didn't Work

- **PR #282, the honest error only.** It replaced a misleading failure with the typed `no_implementation` refusal and deferred "implementing Anthropic native-passthrough capability tuples". The refusal was accurate for the pool as modelled, but the pool model was wrong, so every helper request still failed.
- **Hosted proof for Anthropic.** A candidate counted only when its provider built a capability tuple. Only Codex does, and only with a `claude-* -> gpt-5.6-sol` mapping that production does not have. The anthropic provider has no capability hooks, so `provenCandidateCount` stayed 0 in `capabilityPoolErrorReason`.
- **Reusing the advisor machinery.** `NATIVE_ANTHROPIC_ONLY_EXCLUSION` and `nativeAnthropicToolRequirement` make a tool first-party only. Applied to web_search they would also strip the Codex hosted lane, so web_search got its own predicate instead.

## Solution

web_search has two lanes: the proven hosted lane (Codex, unchanged and fail-closed) and a native passthrough on first-party Anthropic accounts. In outline (the routing doc has the details):

- `isNativeWebSearchPassthroughEligible(requirements, firstPartyAnthropic)` is the one shared predicate, used by selection, dispatch, Auto admission and the Auto candidate loop. It needs a first-party account, exactly one valid `web_search_20250305` declaration, and replay atoms that are empty or `native-Anthropic` only. `proxy-evidence-v1` (`bccf...`) history and truncated scans exclude the native lane.
- Selection admits a first-party candidate as `proven` with `lane: "native_passthrough"` and a sentinel proof key, only when its physical-model preview is non-null. Order is not changed.
- Dispatch skips tuple, proof and replay resolution on the native lane, keeps the `?beta=true` query, and never claims the hosted-dispatch ledger.
- One search per request: after a native send begins, hosted candidates are skipped, and after a hosted claim, native candidates are skipped (`other_lane_dispatched`, a per-candidate skip). In the Auto loop only that reason is a skip; any other capability error keeps `attempt-unavailable`.
- Known limits: a native send that fails with a 429 or 5xx still makes hosted candidates skip for the rest of the request (lost availability, never a second search), and a natively served request still reserves one request-private replay range at bind (no envelope is issued).
- If the replay bind fails, a native-eligible request continues native-only (`serverToolReplayBound = false`). Hosted-only pools keep `replay_unavailable`.
- `search_profile` is accepted (1 to 64 printable ASCII characters) and forwarded on the native lane. The Codex tuple builder refuses a declaration carrying it.

### Findings behind the design

- **Forced tool_choice.** Anthropic's docs ("Forcing tool use") reject `tool_choice` `any` or `tool` with a 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1, with no server-tool exemption. Claude Code 2.1.289 demotes a forced choice only when extended thinking is on, and the helper sends `thinking: disabled`, so it sends the forced choice on exactly those models. On the native lane the proxy rewrites a `tool_choice` that is exactly `{type: "tool", name: "web_search"}` to `{type: "auto"}` when `supportsForcedToolChoice` is false for the model actually sent (`demoteForcedWebSearchChoice` in `proxy-operations.ts`), and logs once per request at warn level. Other forced choices pass through. Auto admission accepts only that demotable shape.
- **`search_profile`.** The helper may send `search_profile: "fast"`. Before this fix the field made the declaration invalid options. It now derives as a valid hosted requirement that Codex still refuses to prove, so such requests are servable only on the native lane.
- **Replay keyring.** Production has `CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE`, so the replay bind succeeds and the bind-failure path is a degraded case. A natively served request still binds and burns one counter range it never uses; the claimant is an in-memory closure, so no lease is left outstanding.

## Verification

No scripted request may reach a real Anthropic account (`AGENTS.md`). Tests use fake upstreams only (`websearch-native-passthrough.integration.test.ts`). After deploy, the operator runs one interactive WebSearch in Claude Code, then reads read-only:

```sql
-- sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db
SELECT datetime(timestamp/1000,'unixepoch','localtime') t, model, account_used, status_code, error_message
FROM requests
WHERE routing_attempt_summary LIKE '%trusted_helper%'
ORDER BY timestamp DESC LIMIT 10;
```

The helper row should have an `account_used`, `status_code = 200` and no `server_tool_*` error. The Claude Code transcript for that turn must show real search results (`Web search results for query: ...` with links).

**Falsification observation.** A 200 helper row with no search results in the transcript would mean the `auto` demotion degraded the helper. The fallback design is then to forward the forced choice unchanged and retry once with `auto` on Anthropic's forced-tool-use 400. Only the operator can make that observation, and until then the demotion is unconfirmed live.

## Prevention

- **Before refusing a typed Anthropic tool, check who can execute it.** If the upstream executes it, the question is which accounts may carry the request, not which provider implements it. A hosted-proof requirement with a pool of providers that cannot prove it is a refusal that no configuration fixes.
- **Check a refusal against production rows.** Five candidates and zero proven, with `all_unavailable`, was visible for two weeks.
- **Re-read the helper request after a Claude Code upgrade.** The forced choice, `thinking: disabled` and `search_profile` are facts about one client version (see `retire_when`).
- **Keep the native lane per-candidate.** Cross-lane exclusion is a skip, never a terminal error, or a failed native send would end a request that a hosted lane could still serve.
- **Known gaps.** `usage.server_tool_use.web_search_requests` is not priced (subscription accounts include it, API-key accounts are undercounted), and cache-keepalive staging is not applicable to the helper, which sends no `cache_control`.

## Related Issues

- #279: the original WebSearch no-implementation report.
- #282: made the refusal honest and deferred native tuples.
- #431: long conversations past the replay-scan caps may be refused with `server_tool_no_implementation`; out of scope here.
- #432: advisor native passthrough, the pattern this reuses. See [Claude Code /advisor was refused as an unsupported server tool](./claude-code-advisor-refused-as-unsupported-server-tool.md).
