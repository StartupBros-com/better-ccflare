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
- Zero rate was flat across account concurrency and idle gap (it is not flat across context size; that cut is confounded by model mix), but *lower* at 6-10 same-key requests per minute than at ≤5, and 68% after a previous miss versus 25% after a hit. That is consistent with a cache-locality failure, but does not identify the backend routing mechanism on its own.
- The degradation persisted under continuous activity. pro-secondary-bros resumed on Sept 20 at 18:00 UTC after 4.5 idle days and ran ~1,850 requests over the next nine hours at 19-82% zero-hit per hour (18-51% weighted), never recovering; pro-primary-wmgm was at 34-45% zero-hit nineteen hours after its first post-idle request on Sept 23. Sept 16 hourly baseline on the same accounts: 7-14% zero-hit, 74-90% weighted.
- Direct Codex CLI 0.153.2 sessions on the same host and days (`~/.codex/sessions`) kept 93-94% weighted cache on gpt-6-astra.

## What Didn't Work

- Blaming the dashboard formula. Source-correct calculations put Codex far below 90% in both persisted usage and raw traces; their denominators differ and are not interchangeable.
- Blaming account hopping, idle-gap decay, or the 15 req/min/key guidance. The `LAG()` analysis over `requests` and the trace pairs showed the misses happen on the same account within a second.
- Blaming prefix drift from ccflare's conversion. The trace's cumulative HMAC chain proved the wire bytes were an exact prefix. (Note: the fingerprint list keeps only the last 64 boundaries and `hmac` is cumulative, so compare by `index`, never by list position.)
- Reasoning-effort transitions do break the prefix (Sept 16 showed 33-100% misses on the rare `high -> xhigh` pairs), but every collapse-period pair kept the same effort. Open observation: on Sept 20 the zero rate varied by effort level (low 75%, high 23%, xhigh 45%) where Sept 16 was uniform (4-10%); every level got worse, so effort mix is not the cause, but the gradient is unexplained.
- Attributing the whole collapse to a brief cold-reconnect warm-up after multi-day account idleness. Both episodes did begin right after 4.5-7 idle days, but the zero rate stayed high across nine continuous hours on one account and nineteen hours into the other. That weakens a short warm-up explanation; it does not rule out every connection-related mechanism.

## Solution

The official client documents the contract in `openai/codex` `core/src/client.rs` (`responses_session_id`) and commit `bc5957ea` ("ChatGPT derives Responses cache affinity from the `session-id` header"). Codex CLI sends, on every Responses request and WebSocket handshake:

- `session-id` = its prompt cache key, `thread-id` = the thread id (`codex-api/src/requests/headers.rs`)
- `x-codex-routing-hint: model=<model>[;tier=<tier>]`

ccflare's `prepareHeaders` only set `Version`, `Openai-Beta`, `User-Agent`, and `originator`. `packages/providers/src/providers/codex/affinity-headers.ts` now owns the contract: `applyCodexAffinityHeaders` is called once in `CodexProvider.transformRequestBody` (the same place the per-turn `x-codex-turn-state` header is set), so eligible legacy requests and their WebSocket handshake copies carry `session-id`/`thread-id` = `prompt_cache_key` and the routing hint for the resolved physical model. On the subscription endpoint, a native `/v1/responses` client keeps a valid supplied session identity (its thread identity defaults to that session identity if absent or invalid); otherwise a valid body key supplies both identities. Legacy clients cannot steer affinity: their values are replaced or removed when no valid key exists. The routing hint independently uses the resolved physical model. Header tokens must be visible ASCII, 1-512 characters. Off the subscription endpoint, or with `CCFLARE_CODEX_AFFINITY_HEADERS=0`, the helper leaves headers untouched (pass-through). Schema-21 traces record `affinity_session_identity` and `affinity_routing_hint`.

### Design note: header granularity

This is a deliberate divergence from the CLI, not parity. In the reference client `session_id` is "the identity shared by the root thread and all descendant threads" (`core/src/session/session.rs`): one `session-id` stays constant for the life of a session and every subagent thread inherits it; only `thread-id` varies per thread, and for user threads the header equals the body `prompt_cache_key` (internal threads such as compaction send a composite key under the root's header). ccflare's derived `session-id` instead mirrors the body `prompt_cache_key`, whose default granularity is the conversation rather than the entire session tree; existing eligible continuity decisions remain part of key selection. For derived identities, the invariant ccflare keeps is header = key; the granularity it does not keep is one-key-per-session-plus-subagents. A Claude Code session fans out far more conversations than a Codex session does, and the per-conversation key exists because one shared key measurably thrashed a single cache machine under that fan-out (170+ conversations in five minutes, `derivePromptCacheKey` doc comment in `provider.ts`). The compatibility setting `CCFLARE_CODEX_CACHE_KEY_MODE=session` moves the derived key and header together. Keep the existing per-conversation setting unless new evidence warrants a change: neither a residual gap nor a short-window recovery establishes the optimal granularity. A session-scoped header over a per-conversation body key remains an untested alternative, not an established remedy; the schema-21 fields expose the actual header decision without proving which granularity the backend favors.

### What the traces cannot show

An adversarial review rated the causal claim inconclusive, and the limits remain after the initial recovery. The header set predates the collapse (Codex CLI 0.153.2 already sent it). A backend-side change during the Sept 17-19 no-traffic gap is a hypothesis, not an observed trigger. Native `/v1/responses` clients through ccflare already forwarded their own `session-id`/`thread-id` (the adapter only strips `session_id`/`x-session-id`), but there was none of that traffic for gpt-6-astra or gpt-5.6-sol in the collapse window, so it supplied no same-window header contrast. The direct-CLI control differs in connection path as well as headers and is not a randomized control.

The exact-prefix, same-account/key/effort cohorts show that prefix drift, account hopping, effort transitions, and ordinary idle expiry do not explain those rapid continuation misses. The sustained nine-/nineteen-hour histories weaken a brief warm-up explanation without excluding all connection mechanisms. The post-deploy improvement supports the protocol remediation; absent a same-window randomized contrast it does not prove a particular backend change, that the headers were the exclusive cause, or that the chosen granularity is optimal.

## Verification

### Initial natural-traffic check (historical observation)

[PR #367](https://github.com/StartupBros-com/better-ccflare/pull/367) deployed as `c184709ceeff81161e27de188c87fd651d6498e4` at **2026-09-24T01:27:53Z**. The recorded check ended at **02:12:37Z** and covered **one account**, not the whole fleet:

| Measured cohort | Successful requests | Token-weighted cache-read share |
|---|---:|---:|
| All measured requests | 431 | 92.46% |
| Earlier completed response on the same account/model/key | 387 | 95.15% |
| Strict preserved-prefix continuations: same account/model/key/instructions/tools/effort | 370 | 95.66% |

The strict 370-request cohort had **3 zero-hit results**; that is not an overall-cohort zero-hit count.

Persisted usage and joined response traces agreed on **33,429,888 cache-read tokens / 36,154,272 total input tokens** for the 431-request cohort. Persisted `requests.input_tokens` is uncached/additive, so its denominator is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Raw Codex response-trace `input_tokens` already includes cached tokens: divide trace `cache_read_input_tokens` by that inclusive total, without adding cache reads again. The upstream Responses field supplying cache reads is `input_tokens_details.cached_tokens`. Durable usage describes logical-final requests; traces describe physical attempts. The agreement was for the matched successful measured sample, not a license to mix unjoined populations or count error/unmatched trace records as successes.

All 431 measured attempts recorded derived affinity identity and a routing hint. This is an initial observed recovery, **not** a randomized causal test, sustained validation, or a multi-account guarantee. It does not close [issue #174](https://github.com/StartupBros-com/better-ccflare/issues/174): the [original parity plan](../../plans/2026-08-20-0549-perf-openai-cache-parity-plan.md#success-criteria) still requires a qualified rolling seven-day follow-up cohort at >=96% weighted reuse, >=99% positive hits, <=1% zero hits, and its other model/comparison/regression gates.

### Repeatable checks (natural traffic only)

- `packages/providers/src/providers/codex/affinity-headers.test.ts`, `provider.affinity-headers.test.ts`, `packages/proxy/src/codex-websocket-wire.test.ts`.
- Post-deploy, on naturally initiated traffic only (never scripted traffic against Codex accounts). The following is a broad persisted-usage summary with the additive denominator, not the matched trace/prefix cohort above or the seven-day parity verdict. Its `gpt%` model filter alone does not establish the Codex provider/account, and `success = 1` alone does not establish measured-usage availability; interpret it only after confirming those cohort properties. Replace the epoch with the deploy time in ms:

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

  Read short-window recovery separately from sustained parity. The pre-collapse ccflare baseline on this formula was 74-90% weighted per hour (Sept 16, both accounts), below the direct CLI's 93-94%. Recovery toward or above that range supports remediation but does not close the residual gap, identify granularity as its cause, or satisfy the seven-day parity contract. The later [cache-health alerts (PR #369)](https://github.com/StartupBros-com/better-ccflare/pull/369) use a 90% warning threshold for degradation detection, not a replacement for the 96% parity floor. Confirm the wire carried the headers with `jq -r 'select(.phase=="request") | .affinity_session_identity' codex-trace-<date>.jsonl | sort | uniq -c` (expect `derived` for Claude Code traffic). If weighted share stays in the 30-40% band while `derived` is present, the header is not the whole contract; roll back with `CCFLARE_CODEX_AFFINITY_HEADERS=0` and compare.

## Prevention

- When Codex cache locality regresses without a ccflare change, diff ccflare's outbound headers against the current `openai/codex` client before reading it as backend physics. The header set is the protocol; the body is not the whole contract.
- Use existing direct `~/.codex/sessions` rollouts as a no-new-traffic comparison for the same days and models, while retaining the connection-path confound; do not present them as a randomized control.
