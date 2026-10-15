---
title: Measure session-remap cache cost on sequential switches, not on a raw account-switch count
date: 2026-10-15
category: observability
module: session-affinity
problem_type: best_practice
component: observability
severity: medium
applies_when:
  - Sizing how much prompt-cache rewriting a routing strategy causes by moving sessions between Anthropic accounts
  - Verifying after a deploy that a session-affinity or drain-soonest change reduced cache-breaking remaps
  - Counting same-session account changes from the requests table
  - Choosing the per-request baseline that excess cache-write tokens are measured against
tags:
  - cache-health
  - prompt-cache
  - session-affinity
  - drain-soonest
  - pace-band
  - remap
  - measurement-methodology
  - observability
---

# Measure session-remap cache cost on sequential switches, not on a raw account-switch count

## Context

Issue #509 needed two numbers: how often `session-drain-soonest` moved a warm Anthropic
session to another account only because that account sat in a higher weekly pace band, and
how much prompt-cache rewriting those moves cost. The same numbers verify PR #510, the
warm-owner hold, after it has run in production. Routing decisions are not logged at the
default `LOG_LEVEL=warn` (issue #197), so the `requests` table in the production database is
the only durable record.

The first count looked alarming: 7,531 same-session account changes within five minutes over
14 days. Most of them are not remaps. A Claude Code session sends parallel requests
(subagents, tool calls), and those can land on different accounts at the same moment.
Nothing moved; the session was spread. A stickiness change cannot touch that population, so
counting it overstates what a hold can fix by roughly four to one.

The 2026-10-08 investigation into cache TTL policy reached the matching conclusion on the cost
side: judge cache cost by cache-write volume, not by hit rate, because a high hit rate alone
cannot show that one policy is cheaper (session history).

## Guidance

1. **Partition by `client_session_id` and `model`, and compare each request with the previous
   one.** A model change breaks the cache by itself, so a switch only counts within one
   model. Keep `success = 1` rows on accounts with `provider = 'anthropic'`.

2. **Drop requests that overlap a request still in flight.** A request is concurrent when it
   starts before the latest end (`timestamp + response_time_ms`) of every earlier request in
   its partition. That removes 71% of the raw count (5,367 of 7,531).

3. **Drop failovers.** `failover_attempts > 0` marks a move that routing made on purpose
   after an attempt failed. These are rare (282) but expensive (about 139k cache-write tokens
   each), and no stickiness rule should hold them.

4. **What remains is the session-remap population** (1,882 in the baseline window): sequential,
   non-failover changes of the serving account. Only this population responds to stickiness
   policy.

5. **Take the baseline from the same population.** Excess cache writes are
   `SUM(MAX(cache_creation_input_tokens - baseline, 0))`, where the baseline is the mean cache
   writes of *same-account, sequential, non-failover* pairs after the *same* idle gap.
   - Under 5 minutes that is 4,977 tokens (59,372 pairs).
   - Over 5 to 60 minutes it is 26,376 tokens (3,125 pairs), because a five-minute cache has
     expired by then whichever account serves.

   An earlier pass of this investigation used 5,391. That figure mixed in 133,191 overlapping
   same-account pairs (5,574 tokens each), so it described a different population and
   understated the excess.

6. **Classify each remap by weekly pace band.** Join the hourly `usage_snapshots` row
   (`window_key = 'seven_day'`) for the old and new account at the switch hour. Then band
   `(100 - utilization) / hours until resets_at` with the production thresholds:
   `quotaPressureBand`, `packages/proxy/src/handlers/usage-throttling.ts:888-895`, rate at
   `:949`. A remap to a strictly higher band is the population the warm-owner hold targets.

7. **Split the idle gap at 5 minutes.** The hold applies only while the owner served the
   previous turn less than `ANTHROPIC_WARM_CACHE_MS` ago, and for at most
   `ANTHROPIC_PRESSURE_HOLD_CAP_MS` (`packages/load-balancer/src/strategies/session-drain-soonest.ts:25`
   and `:27`). Remaps after 5 to 60 minutes are reported separately: by design the hold does
   not cover them.

8. **Read the production database only with `sqlite3 -readonly`.** Never size or verify this
   with scripted requests through Anthropic accounts; AGENTS.md prohibits scripted Anthropic
   inference.

### The queries

Both queries read the window `[start_ms, end_ms)` from one `VALUES` row. The values below
are the pre-#510 baseline window, 2026-10-01 19:13:49 UTC to 2026-10-15 19:13:49 UTC. It ends
at the deploy: the deploy script rewrote the production pin at 19:13:49 UTC, 51 seconds after
PR #510 merged. Run with
`sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db < remap-cost.sql`.

```sql
.headers on
.mode column
-- Window: [start_ms, end_ms). Edit the VALUES row only.
-- 1790882029000 = 2026-10-01T19:13:49Z, 1792091629000 = 2026-10-15T19:13:49Z (PR #510 deploy: pin rewrite, 51 s after merge).

-- Query 1: what a naive "same session changed account" count is made of.
WITH p(start_ms, end_ms) AS (VALUES (1790882029000, 1792091629000)),
r AS (
  SELECT r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.cache_creation_input_tokens, 0) cc,
         LAG(r.account_used) OVER w prev_acct,
         LAG(r.timestamp) OVER w prev_ts,
         MAX(r.timestamp + COALESCE(r.response_time_ms, 0)) OVER (
           PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  WINDOW w AS (PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp)
)
SELECT CASE
         WHEN prev_acct = acct AND prior_end > ts THEN '1 same account, overlapping'
         WHEN prev_acct = acct THEN '2 same account, sequential'
         WHEN prior_end > ts THEN '3 switch, overlaps in-flight request'
         WHEN fa > 0 THEN '4 switch, failover'
         ELSE '5 switch, sequential, no failover'
       END kind,
       COUNT(*) n, ROUND(AVG(cc)) avg_cache_write
FROM r
WHERE prev_acct IS NOT NULL AND ts - prev_ts < 300000
GROUP BY 1 ORDER BY 1;

-- Query 2: sequential non-failover switches by weekly pace band, with excess
-- cache writes over same-account sequential pairs after the same idle gap.
WITH p(start_ms, end_ms) AS (VALUES (1790882029000, 1792091629000)),
r AS (
  SELECT r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.cache_creation_input_tokens, 0) cc,
         LAG(r.account_used) OVER w prev_acct,
         LAG(r.timestamp) OVER w prev_ts,
         MAX(r.timestamp + COALESCE(r.response_time_ms, 0)) OVER (
           PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end
  FROM requests r JOIN accounts a ON a.id = r.account_used, p
  WHERE a.provider = 'anthropic' AND r.success = 1
    AND r.client_session_id IS NOT NULL
    AND r.timestamp >= p.start_ms AND r.timestamp < p.end_ms
  WINDOW w AS (PARTITION BY r.client_session_id, r.model ORDER BY r.timestamp)
),
seq AS (
  SELECT *, CASE WHEN ts - prev_ts < 300000 THEN 'a <5m' ELSE 'b 5-60m' END gap
  FROM r
  WHERE prev_acct IS NOT NULL AND ts - prev_ts < 3600000
    AND (prior_end IS NULL OR prior_end <= ts) AND fa = 0
),
base AS (
  SELECT gap, AVG(cc) b, COUNT(*) pairs FROM seq WHERE prev_acct = acct GROUP BY gap
),
snap AS (
  SELECT account_id, timestamp / 3600000 hb, MAX(utilization) u, MAX(resets_at) rs
  FROM usage_snapshots, p
  WHERE window_key = 'seven_day'
    AND timestamp >= p.start_ms - 86400000 AND timestamp < p.end_ms
  GROUP BY 1, 2
),
sw AS (
  SELECT seq.gap, seq.cc,
         (100 - so.u) / MAX((so.rs - seq.ts) / 3600000.0, 0.01) rate_old,
         (100 - sn.u) / MAX((sn.rs - seq.ts) / 3600000.0, 0.01) rate_new
  FROM seq
  LEFT JOIN snap so ON so.account_id = seq.prev_acct AND so.hb = seq.ts / 3600000
  LEFT JOIN snap sn ON sn.account_id = seq.acct AND sn.hb = seq.ts / 3600000
  WHERE seq.prev_acct <> seq.acct
),
banded AS (
  SELECT gap, cc,
    CASE WHEN rate_old IS NULL OR rate_new IS NULL THEN NULL
         WHEN rate_old >= 4 THEN 5 WHEN rate_old >= 2 THEN 4 WHEN rate_old >= 1 THEN 3
         WHEN rate_old >= 0.5 THEN 2 WHEN rate_old >= 0.25 THEN 1 ELSE 0 END band_old,
    CASE WHEN rate_old IS NULL OR rate_new IS NULL THEN NULL
         WHEN rate_new >= 4 THEN 5 WHEN rate_new >= 2 THEN 4 WHEN rate_new >= 1 THEN 3
         WHEN rate_new >= 0.5 THEN 2 WHEN rate_new >= 0.25 THEN 1 ELSE 0 END band_new
  FROM sw
)
SELECT banded.gap,
       CASE WHEN band_old IS NULL THEN 'unknown (no snapshot that hour)'
            WHEN band_new > band_old THEN 'to-higher-band'
            ELSE 'same-or-lower-band' END cls,
       COUNT(*) n,
       ROUND(SUM(cc) / 1e6, 1) cache_write_M,
       ROUND(SUM(MAX(cc - base.b, 0)) / 1e6, 1) excess_M,
       ROUND(base.b) baseline_per_req,
       base.pairs baseline_pairs
FROM banded JOIN base ON base.gap = banded.gap
GROUP BY 1, 2 ORDER BY 1, 2;
```

## Why This Matters

The raw count and the remap count lead to different decisions. Sized from the raw count, the
warm-owner hold looked like a fix for 7,531 events. Its real target is the 307 sequential
remaps under five minutes that moved to a higher pace band. Those cost about 10.7M excess
cache-write tokens in 14 days. That is still worth fixing, but it is a different claim, and
it is also the only number the post-deploy check can honestly be compared with.

The baseline matters as much as the filter. Excess cost is a difference, and a baseline taken
from another population moves it. The overlapping same-account pairs carry larger cache
writes than sequential ones, so mixing them in shrinks the excess and blurs the before/after
comparison.

## When to Apply

- Before quoting a cache-cost figure for any change to session stickiness, owner retention,
  drain ordering, or account priority on Anthropic routes.
- When verifying a deployed routing change: re-run both queries over a post-deploy window and
  compare like with like.
- When a dashboard or alert reports "session switches": check whether it separates concurrent
  spread and failover from sequential remaps.

## Examples

### Baseline, before PR #510 (14 days ending 2026-10-15 19:13:49 UTC)

Query 1, all same-session pairs under five minutes:

| Kind | Pairs | Avg cache writes |
|---|---:|---:|
| Same account, overlapping | 133,191 | 5,574 |
| Same account, sequential | 59,397 | 4,984 |
| Switch, overlaps an in-flight request | 5,367 | 21,558 |
| Switch, failover | 282 | 138,993 |
| Switch, sequential, no failover | 1,882 | 37,399 |

Query 2, sequential non-failover switches:

| Idle gap | Class | Switches | Cache writes | Excess | Baseline per request |
|---|---|---:|---:|---:|---:|
| < 5 min | same-or-lower-band | 1,575 | 58.7M | 54.5M | 4,977 |
| < 5 min | to-higher-band | 307 | 11.7M | 10.7M | 4,977 |
| 5–60 min | same-or-lower-band | 251 | 15.5M | 12.6M | 26,376 |
| 5–60 min | to-higher-band | 77 | 7.3M | 6.1M | 26,376 |

No switch fell in the `unknown` class: every switch hour had a weekly snapshot for both
accounts. An earlier rolling-window run of the same method, using the 5,391 baseline, gave
304 to-higher-band switches and 10.2M excess. The difference comes from the window edges and
the baseline population.

### How far each number can be trusted

- **`to-higher-band` under five minutes is an upper bound** on what the hold can address.
  - The query checks only the weekly band. It does not check tier, fallback rung, billing
    class, or whether the owner was still available. An owner that was rate-limited or paused
    moves regardless of the hold.
  - The hourly `MAX(utilization)` and `MAX(resets_at)` can pair a pre-rollover utilization
    with a post-rollover reset inside one hour.
  - 166 of the 1,882 sequential switches are Fable-family requests. The live strategy bands
    those by the model-scoped `seven_day_fable` window, not the all-model `seven_day` window
    the query uses.
- **The 5–60 minute bucket measures exposure, not cost.** The `requests` table does not record
  each request's cache TTL. The bucket therefore blends 1-hour-TTL main conversations, where
  a switch rewrites a still-warm cache, with 5-minute-TTL workers, whose cache was cold
  anyway.
- **The 1,575 same-or-lower-band remaps under five minutes are the largest pool, and the band
  does not explain them.** They are outside PR #510's scope. Attributing them needs
  per-request routing evidence that this classification does not use.
- **Concurrent spread has its own cost:** overlapping switches average 21,558 cache-write
  tokens against 5,574 for overlapping same-account pairs. Stickiness does not control that
  population, so it does not belong in a remap figure.

### Comparing after the deploy

1. Confirm that production serves a build containing PR #510: its merge commit must be an
   ancestor of the `git_sha` reported by `/health`. See
   [verify-fix-ancestry-before-citing-a-measured-rate.md](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).
2. Set the `VALUES` row to `(1792091629000, 1793301229000)`, the 14 days from
   2026-10-15 19:13:49 UTC to 2026-10-29 19:13:49 UTC.
   - For an earlier read, use 7 days (`1792696429000` as the end); the rates in step 3 make
     the two window lengths comparable.
3. Compare rates, not raw counts, because traffic volume changes. Two rates work:
   to-higher-band remaps per 1,000 sequential same-session pairs (Query 1 rows 2 and 5), and
   the to-higher-band share of sequential remaps (16.3% in the baseline window).
4. Expect the under-five-minute to-higher-band row to drop, not reach zero.
   - The hold is capped at 30 minutes per episode.
   - It applies only to Anthropic owners in sticky mode outclassed by pace band alone, at
     the same tier and fallback rung.
   - Owners that become unavailable still move.
   - The 5–60 minute to-higher-band row may rise. A held session moves once its owner has
     been idle for 5 minutes or more, so some remaps that used to land under five minutes now
     land in that bucket. That is the intended trade: the move happens once the five-minute
     cache has gone cold.

## Related

- [diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md](diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md)
  is the sibling rule for cache metrics: fix the population and token semantics before
  reading an aggregate.
- [verify-fix-ancestry-before-citing-a-measured-rate.md](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md)
  covers checking the measured build before citing a rate.
- [native-cache-ttl-policy-is-not-proxy-retention.md](../integration-issues/native-cache-ttl-policy-is-not-proxy-retention.md)
  explains why main conversations and workers carry different cache TTLs.
- [commit-bound-routing.md](../architecture-patterns/commit-bound-routing.md) describes
  session owner retention and re-pin reasons in the same strategy.
- `docs/load-balancing.md`, section "Drain ordering", states the routing order and the
  warm-owner hold's limits.
- Issue #509 is the originating issue. PR #510 shipped the warm-owner hold. Issue #197
  tracks routing decisions being invisible in production logs.
