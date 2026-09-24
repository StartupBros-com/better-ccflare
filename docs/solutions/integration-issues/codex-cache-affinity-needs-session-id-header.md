---
title: Codex prompt-cache affinity needs the session-id header, not just prompt_cache_key
date: 2026-09-23
category: integration-issues
module: codex-provider
problem_type: integration_issue
component: proxy
symptoms:
  - "Cache Efficiency Breakdown flags gpt-6-astra at 32% and gpt-5.6-sol at 41% while every Claude and Grok model sits above 93%"
  - "Byte-identical continuations on the same account, key, instructions, tools and effort return cached_tokens=0 about 45% of the time, gap under one second"
  - "Misses arrive in streaks and are less likely at higher per-key request rates, the opposite of key-affinity routing"
root_cause: missing_protocol_header
resolution_type: code_fix
severity: high
tags:
  - codex
  - prompt-cache
  - session-id
  - routing-hint
  - chatgpt-backend
  - cache-parity
---

# Codex prompt-cache affinity needs the session-id header, not just prompt_cache_key

## Problem

From 2026-09-20 the Codex lane's cache-read share collapsed from 80-90% to 26-45% on both remaining ChatGPT Pro accounts, with no ccflare deploy in between (the Sept 16 baseline and the Sept 20 collapse both ran build `db9f27ed`). The dashboard's additive formula was correct; the misses were real and reported by upstream.

## Symptoms

- `requests` table: 447 of 678 gpt-6-astra rows in 7 days had `cache_read_input_tokens = 0` at ~285k average context.
- Schema-20 Codex traces, index-aligned on the chained input-item fingerprints: on Sept 20, 392 of 871 pairs whose entire previous prompt was a byte-identical prefix (same key, account, instructions, tools, reasoning effort, 0.2 s median gap) still missed completely. Sept 16 baseline: 8%.
- Zero rate was flat across account concurrency and idle gap (it is not flat across context size; that cut is confounded by model mix), but *lower* at 6-10 same-key requests per minute than at ≤5, and 68% after a previous miss versus 25% after a hit. That is the signature of requests being spread across machines instead of pinned to the warm one.
- The degradation persisted under continuous activity. pro-secondary-bros resumed on Sept 20 at 18:00 UTC after 4.5 idle days and ran ~1,850 requests over the next nine hours at 19-82% zero-hit per hour (18-51% weighted), never recovering; pro-primary-wmgm was at 34-45% zero-hit nineteen hours after its first post-idle request on Sept 23. Sept 16 hourly baseline on the same accounts: 7-14% zero-hit, 74-90% weighted.
- Direct Codex CLI 0.153.2 sessions on the same host and days (`~/.codex/sessions`) kept 93-94% weighted cache on gpt-6-astra.

## What Didn't Work

- Blaming the dashboard formula. Both the additive and inclusive formulas put Codex far below 90%.
- Blaming account hopping, idle-gap decay, or the 15 req/min/key guidance. The `LAG()` analysis over `requests` and the trace pairs showed the misses happen on the same account within a second.
- Blaming prefix drift from ccflare's conversion. The trace's cumulative HMAC chain proved the wire bytes were an exact prefix. (Note: the fingerprint list keeps only the last 64 boundaries and `hmac` is cumulative, so compare by `index`, never by list position.)
- Reasoning-effort transitions do break the prefix (Sept 16 showed 33-100% misses on the rare `high -> xhigh` pairs), but every collapse-period pair kept the same effort. Open observation: on Sept 20 the zero rate varied by effort level (low 75%, high 23%, xhigh 45%) where Sept 16 was uniform (4-10%); every level got worse, so effort mix is not the cause, but the gradient is unexplained.
- Blaming a cold-reconnect transient after multi-day account idleness. Both collapse episodes did begin right after 4.5-7 idle days, but the hourly table above shows the zero rate staying high across nine continuous hours on one account and nineteen hours into the other, which a warm-up transient would not do.

## Solution

The official client documents the contract in `openai/codex` `core/src/client.rs` (`responses_session_id`) and commit `bc5957ea` ("ChatGPT derives Responses cache affinity from the `session-id` header"). Codex CLI sends, on every Responses request and WebSocket handshake:

- `session-id` = its prompt cache key, `thread-id` = the thread id (`codex-api/src/requests/headers.rs`)
- `x-codex-routing-hint: model=<model>[;tier=<tier>]`

ccflare's `prepareHeaders` only set `Version`, `Openai-Beta`, `User-Agent`, and `originator`. `packages/providers/src/providers/codex/affinity-headers.ts` now owns the contract: `applyCodexAffinityHeaders` is called once in `CodexProvider.transformRequestBody` (the same place the per-turn `x-codex-turn-state` header is set), so the HTTP request and the WebSocket handshake copy both carry `session-id`/`thread-id` = `prompt_cache_key` and the routing hint for the resolved physical model. A native `/v1/responses` client keeps its own identity; legacy clients cannot steer affinity. `CCFLARE_CODEX_AFFINITY_HEADERS=0` restores pass-through. Schema-21 traces record `affinity_session_identity` and `affinity_routing_hint`.

### Design note: header granularity

This is a deliberate divergence from the CLI, not parity. In the reference client `session_id` is "the identity shared by the root thread and all descendant threads" (`core/src/session/session.rs`): one `session-id` stays constant for the life of a session and every subagent thread inherits it; only `thread-id` varies per thread, and for user threads the header equals the body `prompt_cache_key` (internal threads such as compaction send a composite key under the root's header). ccflare's `session-id` instead spans one conversation: it changes with every new Claude Code conversation and every subagent, because it mirrors the per-conversation `prompt_cache_key`. The invariant ccflare keeps is header = key; the granularity it does not keep is one-key-per-session-plus-subagents. A Claude Code session fans out far more conversations than a Codex session does, and the per-conversation key exists because one shared key measurably thrashed a single cache machine under that fan-out (170+ conversations in five minutes, `derivePromptCacheKey` doc comment in `provider.ts`). If the coarse shape ever needs testing, `CCFLARE_CODEX_CACHE_KEY_MODE=session` moves the key and the header together. A session-scoped `session-id` over a per-conversation body key (the raw session UUID from `extractSessionId` would supply it) is the first candidate if the lane stabilises below the CLI's 93-94%; validate it against the schema-21 trace fields rather than assuming the header routes with a different granularity than the body key did.

### What the traces cannot show

An adversarial review rated the causal claim inconclusive, and the limits are real. The header set predates the collapse (Codex CLI 0.153.2 already sent it), so the trigger was a backend-side change during the Sept 17-19 gap, in which ccflare carried no Codex traffic to date it. Native `/v1/responses` clients through ccflare already forwarded their own `session-id`/`thread-id` (the adapter only strips `session_id`/`x-session-id`), which would have been the same-window with/without contrast, but there was none of that traffic for gpt-6-astra or gpt-5.6-sol in the collapse window. The direct-CLI control differs in connection path as well as headers. What the data does rule out is prefix drift, idle decay, account hopping, effort transitions, and a reconnect transient. The post-deploy check below is the discriminating test.

## Verification

- `packages/providers/src/providers/codex/affinity-headers.test.ts`, `provider.affinity-headers.test.ts`, `packages/proxy/src/codex-websocket-wire.test.ts`.
- Post-deploy, on naturally initiated traffic only (never scripted traffic against Codex accounts). Durable usage, additive formula, replace the epoch with the deploy time in ms:

  ```sql
  SELECT model, COUNT(*) AS n,
    ROUND(100.0 * SUM(cache_read_input_tokens)
      / NULLIF(SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0), 1) AS weighted_pct,
    ROUND(100.0 * SUM(cache_read_input_tokens = 0) / COUNT(*), 1) AS zero_hit_pct
  FROM requests
  -- 1790208000000 is 2026-09-24T00:00:00Z; use the actual deploy time
  WHERE model LIKE 'gpt%' AND success = 1 AND timestamp > 1790208000000
  GROUP BY model;
  ```

  Baseline, 7 days to 2026-09-23 (all pre-fix):

  | model | weighted cache read | zero-hit requests |
  |---|---|---|
  | gpt-6-astra | 32.0% | 65.9% |
  | gpt-5.6-sol | 40.7% | 26.9% |

  Read the result against two lines, not one. The pre-collapse ccflare baseline on this formula was 74-90% weighted per hour (Sept 16, both accounts), below the 90% target and below the direct CLI's 93-94%. Landing at 80-90% with `derived` present means the collapse is fixed and the residual gap is the separate granularity question in the design note. Landing above 90% means both are closed. Confirm the wire carried the headers with `jq -r 'select(.phase=="request") | .affinity_session_identity' codex-trace-<date>.jsonl | sort | uniq -c` (expect `derived` for Claude Code traffic). If weighted share stays in the 30-40% band while `derived` is present, the header is not the whole contract; roll back with `CCFLARE_CODEX_AFFINITY_HEADERS=0` and compare.

## Prevention

- When Codex cache locality regresses without a ccflare change, diff ccflare's outbound headers against the current `openai/codex` client before reading it as backend physics. The header set is the protocol; the body is not the whole contract.
- Use direct `~/.codex/sessions` rollouts as a no-traffic control group for the same days and models.
