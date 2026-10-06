---
title: Claude Code WebSearch was refused locally as no_implementation although first-party Anthropic accounts run it
date: 2026-10-04
last_updated: 2026-10-06
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
  - route-profiles
---

# Claude Code WebSearch was refused locally as no_implementation although first-party Anthropic accounts run it

## Problem

Claude Code's WebSearch tool sends a helper request: `POST /v1/messages?beta=true` with the main-loop model, one user message `Perform a web search for the query: ...`, `thinking: {type: "disabled"}`, `tool_choice: {type: "tool", name: "web_search"}`, no client tools, and one tool `{type: "web_search_20250305", name: "web_search", max_uses: 8, search_profile?: "fast", allowed_domains?, blocked_domains?}` (read from the Claude Code 2.1.289 binary). `search_profile: "fast"` is conditional: the client sends it only when the tool input's `mode` is `"standard"` and its web-search-mode config is enabled (the `tengu_sleepy_shore` flag or `CLAUDE_CODE_WEB_SEARCH_FAST_ARG`). "Main-loop model" means the session's `/model` choice as sent, so in a session on a route profile the helper's model is the picker id `claude-bccf-route-<id>`. The proxy refused it before any send, although `api.anthropic.com` executes that tool itself (refs #279, #282, #431, #432).

The design is in [routing-architecture.md, "Hosted WebSearch routing contract"](../../routing-architecture.md#hosted-websearch-routing-contract) and [CONCEPTS.md](../../../CONCEPTS.md). This doc covers how it looked, what did not work, and how to check it in production.

## Symptoms

- HTTP 400, code `server_tool_capability_unavailable` (reason `no_implementation`, `packages/proxy/src/server-tool-routing-errors.ts`). The message starts `No configured provider route implements the requested server-tool semantics.` and says it is a permanent capability gap in the account pool.
- Production helper rows for 2026-09-20 to 2026-10-04, 3 to 83 a day, had 5 first-party Anthropic OAuth candidates, 0 proven, and `zeroAttemptReason: all_unavailable`. No account was used and nothing reached upstream. The helper models in those rows were `claude-opus-5-5` and `claude-fable-5-1`.

## What Didn't Work

- **PR #282, the honest error only.** It replaced a misleading failure with the typed `no_implementation` refusal and deferred "implementing Anthropic native-passthrough capability tuples". The refusal was accurate for the pool as modelled, but the pool model was wrong, so every helper request still failed.
- **Hosted proof for Anthropic.** A candidate counted only when its provider built a capability tuple. Only Codex does, and only for physical model `gpt-5.6-sol` (`CODEX_SERVER_TOOL_MODEL` in `packages/providers/src/providers/codex/server-tools.ts`). As of 2026-10-05, production Codex rows over the previous 7 days show only `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol` and `gpt-6-luna` as `routed_model` (`requests.routed_provider = 'codex'`). So the hosted lane could prove no current Codex account, whatever the declaration carried, and no production row records a hosted web_search success. Re-check both before relying on them, because the Codex catalog moves. The anthropic provider has no capability hooks, so `provenCandidateCount` stayed 0 in `capabilityPoolErrorReason`.
- **Reusing the advisor machinery.** `NATIVE_ANTHROPIC_ONLY_EXCLUSION` and `nativeAnthropicToolRequirement` make a tool first-party only. Applied to web_search they would also strip the Codex hosted lane, so web_search got its own predicate instead.

## Solution

web_search has two lanes: the proven hosted lane (Codex, unchanged and fail-closed) and a native passthrough on first-party Anthropic accounts. In outline (the routing doc has the details):

- `isNativeWebSearchPassthroughEligible(requirements, firstPartyAnthropic)` is the one shared predicate, used by selection, dispatch, Auto admission and the Auto candidate loop. It needs a first-party account, exactly one valid `web_search_20250305` declaration, and replay atoms that are empty or `native-Anthropic` only. `proxy-evidence-v1` (`bccf...`) history and truncated scans exclude the native lane.
- Selection admits a first-party candidate as `proven` with `lane: "native_passthrough"` and a sentinel proof key, only when its physical-model preview is non-null. Order is not changed.
- Dispatch skips tuple, proof and replay resolution on the native lane, keeps the `?beta=true` query, and never claims the hosted-dispatch ledger.
- One search per request: after a native send begins, hosted candidates are skipped, and after a hosted claim, native candidates are skipped (`other_lane_dispatched`, a per-candidate skip). In the Auto loop only that reason is a skip; any other capability error keeps `attempt-unavailable`.
- Known limits: a native send that fails with a 429 or 5xx still makes hosted candidates skip for the rest of the request (lost availability, never a second search), and a natively served request still reserves one request-private replay range at bind (no envelope is issued). Native search results are very likely bound to the producing Anthropic organization (verified for advisor in #439, inferred for web search). History that carries them, such as a `pause_turn` continuation, can get a 400 after failover to another first-party account. The owner-preference and strip seam is #439's.
- If the replay bind fails, a native-eligible request continues native-only (`serverToolReplayBound = false`). Hosted-only pools keep `replay_unavailable`.
- `search_profile` is accepted (1 to 64 printable ASCII characters) and forwarded on the native lane. The Codex tuple builder refuses a declaration carrying it.
- Route-profile sessions (PR #447, `ceef6bf0`): a helper-shaped request gets helper lineage whatever its model id or child headers say, and under a soft capability profile it can fall to the native lane. A request is helper-shaped only when it has a declared hosted server tool (valid or not), no client functions, and no unrecognized typed tool (`isHelperShapedServerToolPreview` in `proxy.ts`). A client function is an untyped tool with a `name` and an `input_schema`. A client tool labelled `type: "custom"` is not one: the classifier files it as an unrecognized typed tool (`unsupported`), so it disqualifies the shape. A helper-shaped request withdraws its own root-intent reservation at classification and takes the profile's `logicalModel` but never its `defaultEffort`. Details and the two remaining limits are in [routing-architecture.md, "Claude Code Model Route Profiles"](../../routing-architecture.md#claude-code-model-route-profiles).
- Fail-closed outcomes when no lane can take a helper. `capabilityPoolErrorReason` in `account-selector.ts` counts proven candidates across both lanes, native and hosted. No proven candidate in either lane (no first-party Anthropic account and no hosted-proven candidate): 400 `server_tool_capability_unavailable`. A missing first-party account alone is not enough: a hosted-proven candidate serves the helper, or the request gets a 503 when that candidate is unavailable. Candidates prove it but none is available for this request: 503 `route_unavailable`. An exact-account profile whose account cannot serve it: 503 `server_tool_force_route_unavailable` (codes in `packages/proxy/src/server-tool-routing-errors.ts`).

### Findings behind the design

- **Forced tool_choice.** Anthropic's docs ("Forcing tool use") reject `tool_choice` `any` or `tool` with a 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1, with no server-tool exemption. Claude Code 2.1.289 demotes a forced choice to `auto` itself when thinking is on, and also when the helper asks for disabled thinking on a model whose client capability table carries `rejects_disabled_thinking`: it then omits `thinking` and sends `auto`. Opus 5.5, Sonnet 5.5, Fable 5, Fable 5.1 and Mythos 5.1 carry that tag. This was read from the binary, not observed on the wire. So for a helper whose model is one of those, the client already sends `auto`, and the proxy logs nothing. The proxy's demotion is the backstop for a helper whose model the proxy changes before sending, for example through an account model mapping, a route profile's `logicalModel` or a combo. On the native lane the proxy rewrites a `tool_choice` that is exactly `{type: "tool", name: "web_search"}` to `{type: "auto"}` when `supportsForcedToolChoice` is false for the model actually sent (`demoteForcedWebSearchChoice` in `proxy-operations.ts`), and logs once per request at warn level. Other forced choices pass through. Auto admission accepts only that demotable shape. `supportsForcedToolChoice` matches the three undated ids exactly, so a dated or suffixed alias of those models would reach Anthropic undemoted and get its visible 400. Neither the repo nor the production helper rows carry such an alias today. The function is shared with three other callers (the Responses translator, Auto admission and the agent interceptor), so widening its match belongs to its own change.
- **`search_profile`.** The helper may send `search_profile: "fast"`. Before this fix the field made the declaration invalid options. It now derives as a valid hosted requirement that Codex still refuses to prove, so such requests are servable only on the native lane.
- **Replay keyring.** Production has `CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE`, so the replay bind succeeds and the bind-failure path is a degraded case. A natively served request still binds and burns one counter range it never uses; the claimant is an in-memory closure, so no lease is left outstanding.

## Verification

No scripted request may reach a real Anthropic account (`AGENTS.md`). Tests use fake upstreams only (`websearch-native-passthrough.integration.test.ts`). After deploy, the operator runs one interactive WebSearch in Claude Code, then checks it read-only.

**Served helpers carry no marker in `requests`.** Only a refusal records the routing decision (`routing_attempt_summary.decision.origin = "trusted_helper"`). A served helper stores the plain attempt summary, and production stores no request payloads. Do not count served helpers by token shape either: "large uncached input, no cache, one attempt" also matches WebFetch's summarizer requests. Start from the transcript instead:

1. Find the WebSearch `tool_use` in the session transcript (`~/.claude/projects/<project>/<session>.jsonl`, plus `<session>/subagents/**/agent-*.jsonl` for subagents and workflow agents).
2. Its `tool_result` shows `Web search results for query: ...` with links when served, or `API Error: 400 No configured provider route implements the requested server-tool semantics` when refused.
3. The proxy row is the session's `/v1/messages` row that starts when that assistant turn ends (`agent_used` is the session id). `requests.timestamp` is the row's completion time, not its start: on 498 of the latest 500 production rows on 2026-10-06 it equalled the last attempt's `outcomeObservedAt`. The start is `timestamp - response_time_ms`.

Join each `tool_result` to its `tool_use` by id. Do not grep transcripts for the success or refusal string: sessions that discuss this fix quote both strings, so a plain grep over-counts.

Refusals, including those in route-profile sessions, can be counted directly:

```sql
-- sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db
SELECT date(timestamp/1000,'unixepoch','localtime') d, coalesce(route_profile_id,'-') profile,
       substr(error_message,1,40) err, count(*)
FROM requests
WHERE error_message LIKE '%server_tool%'
GROUP BY 1,2,3 ORDER BY 1 DESC LIMIT 20;
```

**Falsification observation.** A 200 helper row with no search results in the transcript would mean the `auto` demotion degraded the helper. The fallback design is then to forward the forced choice unchanged and retry once with `auto` on Anthropic's forced-tool-use 400. Live, as of 2026-10-05 at `023a82f2`: one interactive Opus 5.5 WebSearch returned real results. The journal (`LOG_LEVEL=warn`) has no `Demoted forced web_search` line for it, which matches the client sending `auto` itself on that model (see the forced tool_choice finding above). So an `auto` choice has served a real search once, but the proxy's own demotion has not been seen firing live. The first route-profile WebSearch was served on 2026-10-06 at `a6341d04`, which contains #447, from a `codex-pool-astra` session whose main loop stayed on Codex. Its helper row has `route_profile_id = codex-pool-astra` and `original_model = claude-bccf-route-codex-pool-astra`, and it was served in one attempt on a first-party Anthropic account as `claude-opus-5`. Opus 5 accepts a forced choice, so that search did not exercise the demotion either.

## Prevention

- **Before refusing a typed Anthropic tool, check who can execute it.** If the upstream executes it, the question is which accounts may carry the request, not which provider implements it. A hosted-proof requirement with a pool of providers that cannot prove it is a refusal that no configuration fixes.
- **Check a refusal against production rows.** Five candidates and zero proven, with `all_unavailable`, was visible for two weeks.
- **Re-read the helper request after a Claude Code upgrade.** The forced choice, `thinking: disabled` and `search_profile` are facts about one client version (see `retire_when`).
- **Keep the native lane per-candidate.** Cross-lane exclusion is a skip, never a terminal error, or a failed native send would end a request that a hosted lane could still serve.
- **A request that must not change session routing must withdraw its own reservation, by identity, as soon as it is classified.** Before #447, call-site gates stopped a route-profile helper from committing, but its reservation stayed pending. A same-session root that was still selecting when the helper arrived was then no longer the newest reservation, and its commit was rejected as stale. Withdrawing at classification fixed that, but withdrawal still worked only while the reservation was the newest. A helper classified behind a newer root kept its reservation, and if that root aborted, the helper's generation became current again and could bind the session to its picker. Withdrawal now removes the request's own generation wherever it sits in the pending list. Both fixes are in #447.
- **Known gaps.** `usage.server_tool_use.web_search_requests` is not priced (subscription accounts include it, API-key accounts are undercounted; #452), and cache-keepalive staging is not applicable to the helper, which sends no `cache_control`.

## Related Issues

- #279: the original WebSearch no-implementation report.
- #282: made the refusal honest and deferred native tuples.
- #441: the native passthrough lane on first-party Anthropic accounts (`023a82f2`).
- #447: route-profile helpers reach the native lane under a soft profile (`ceef6bf0`).
- #452: pricing `web_search_requests` for API-key accounts.
- #431: long conversations past the replay-scan caps may be refused with `server_tool_no_implementation`; out of scope here.
- #432: advisor native passthrough, the pattern this reuses. See [Claude Code /advisor was refused as an unsupported server tool](./claude-code-advisor-refused-as-unsupported-server-tool.md).
