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
- Zero rate was flat across context size, account concurrency, and idle gap, but *lower* at 6-10 same-key requests per minute than at ≤5, and 68% after a previous miss versus 25% after a hit. That is the signature of requests being spread across machines instead of pinned to the warm one.
- Direct Codex CLI 0.153.2 sessions on the same host and days (`~/.codex/sessions`) kept 93-94% weighted cache on gpt-6-astra.

## What Didn't Work

- Blaming the dashboard formula. Both the additive and inclusive formulas put Codex far below 90%.
- Blaming account hopping, idle-gap decay, or the 15 req/min/key guidance. The `LAG()` analysis over `requests` and the trace pairs showed the misses happen on the same account within a second.
- Blaming prefix drift from ccflare's conversion. The trace's cumulative HMAC chain proved the wire bytes were an exact prefix. (Note: the fingerprint list keeps only the last 64 boundaries and `hmac` is cumulative, so compare by `index`, never by list position.)
- Reasoning-effort transitions do break the prefix (Sept 16 showed 33-100% misses on the rare `high -> xhigh` pairs), but every collapse-period pair kept the same effort.

## Solution

The official client documents the contract in `openai/codex` `core/src/client.rs` (`responses_session_id`) and commit `bc5957ea` ("ChatGPT derives Responses cache affinity from the `session-id` header"). Codex CLI sends, on every Responses request and WebSocket handshake:

- `session-id` = its prompt cache key (root threads), `thread-id` = the thread id (`codex-api/src/requests/headers.rs`)
- `x-codex-routing-hint: model=<model>[;tier=<tier>]`

ccflare's `prepareHeaders` only set `Version`, `Openai-Beta`, `User-Agent`, and `originator`. `packages/providers/src/providers/codex/affinity-headers.ts` now owns the contract: `applyCodexAffinityHeaders` is called once in `CodexProvider.transformRequestBody` (the same place the per-turn `x-codex-turn-state` header is set), so the HTTP request and the WebSocket handshake copy both carry `session-id`/`thread-id` = `prompt_cache_key` and the routing hint for the resolved physical model. A native `/v1/responses` client keeps its own identity; legacy clients cannot steer affinity. `CCFLARE_CODEX_AFFINITY_HEADERS=0` restores pass-through. Schema-21 traces record `affinity_session_identity` and `affinity_routing_hint`.

## Verification

- `packages/providers/src/providers/codex/affinity-headers.test.ts`, `provider.affinity-headers.test.ts`, `packages/proxy/src/codex-websocket-wire.test.ts`.
- Post-deploy: rerun the index-aligned pair analysis on the day's `codex-trace-*.jsonl`; the append-only zero-hit rate should return to the single digits and `affinity_session_identity` should read `derived` on Claude Code traffic.

## Prevention

- When Codex cache locality regresses without a ccflare change, diff ccflare's outbound headers against the current `openai/codex` client before reading it as backend physics. The header set is the protocol; the body is not the whole contract.
- Use direct `~/.codex/sessions` rollouts as a no-traffic control group for the same days and models.
