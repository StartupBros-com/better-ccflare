---
title: Measure session-remap cache cost on remaps of a conversation, not on raw or partition-order account switches
date: 2026-10-15
last_updated: 2026-10-15
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
  - Attributing why a session's conversation moved accounts before proposing a stickiness fix
tags:
  - cache-health
  - prompt-cache
  - session-affinity
  - drain-soonest
  - pace-band
  - remap
  - affinity-lane
  - conversation-parent
  - measurement-methodology
  - observability
---

# Measure session-remap cache cost on remaps of a conversation, not on raw or partition-order account switches

## Context

Issue #509 needed two numbers: how often `session-drain-soonest` moved a warm Anthropic
session to another account only because that account sat in a higher weekly pace band, and
how much prompt-cache rewriting those moves cost. The same numbers verify PR #510, the
warm-owner hold, after it has run in production. Routing decisions are not logged at the
default `LOG_LEVEL=warn` (issue #197), so the `requests` table in the production database is
the only durable record.

Two populations look like remaps and are not.

- **Concurrent spread.** The first count looked alarming: 7,531 same-session account changes
  within five minutes over 14 days. A Claude Code session sends parallel requests (subagents,
  tool calls), and those can land on different accounts at the same moment. Nothing moved;
  the session was spread. Filtering to sequential, non-failover switches leaves 1,882.
- **Lane interleaving.** Issue #516 then attributed those 1,882 switches and found that most
  of them still are not remaps. Session affinity does not pin an owner per session and model.
  It pins one per *affinity lane*, so one `(client_session_id, model)` partition interleaves
  several lanes, each with its own owner. Comparing a request with the previous row of its
  partition often compares two lanes. Reconstructing each request's own conversation parent
  shows that 1,571 of the 1,882 switches (83%) were not remaps of a warm conversation.

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

4. **What remains is the candidate population** (1,882 under five minutes in the baseline
   window): sequential, non-failover changes of the serving account in partition order. It
   is not yet a remap count.

5. **Reconstruct each candidate's conversation parent.**
   - **Why the partition is not enough.** Affinity is keyed by
     `deriveAffinityLaneKey` (`packages/proxy/src/handlers/account-selector.ts:1223`).
     The key combines the session, protocol family, path, model family, effective model and
     canonical `anthropic-beta` signature, plus the route profile when one applies. Of
     these, the `requests` table cannot reconstruct the `anthropic-beta` signature.
   - **The parent.** It is the latest earlier request, in the same session and model and
     within the past hour, that had finished before this one started and whose prompt
     total this one extends:
     `total(parent) <= total(r) <= 1.10 * total(parent) + 20000`, where
     `total = input + cache_read + cache_creation`.
   - **Three cases are not remaps.** The parent is already on the new account. The new
     account is already warm, with cache reads at least half the prompt. Or there is no
     continuation parent. Everything else is a remap of a warm conversation, either off the
     previous account or off a third account.
   - **The split barely depends on the tolerance.** At k = 1.05, 1.10 and 1.25, the
     parent-already-on-new-account class holds 702, 694 and 687 of the 1,575
     same-or-lower-band candidates.

6. **Take the baseline from the same population.** Excess cache writes are
   `SUM(MAX(cache_creation_input_tokens - baseline, 0))`, where the baseline is the mean cache
   writes of *same-account, sequential, non-failover* pairs after the *same* idle gap.
   - Under 5 minutes that is 4,977 tokens (59,372 pairs).
   - Over 5 to 60 minutes it is 26,376 tokens (3,125 pairs), because a five-minute cache has
     expired by then whichever account serves.

   An earlier pass of this investigation used 5,391. That figure mixed in 133,191 overlapping
   same-account pairs (5,574 tokens each), so it described a different population and
   understated the excess.

7. **Classify each candidate by weekly pace band.** Join the hourly `usage_snapshots` row
   (`window_key = 'seven_day'`) for the old and new account at the switch hour. Then band
   `(100 - utilization) / hours until resets_at` with the production thresholds:
   `quotaPressureBand`, `packages/proxy/src/handlers/usage-throttling.ts:888-895`, rate at
   `:949`. A remap to a strictly higher band is the population the warm-owner hold targets.

8. **Split the idle gap at 5 minutes.** The hold applies only while the owner served the
   previous turn less than `ANTHROPIC_WARM_CACHE_MS` ago, and for at most
   `ANTHROPIC_PRESSURE_HOLD_CAP_MS` (`packages/load-balancer/src/strategies/session-drain-soonest.ts:25`
   and `:27`). Remaps after 5 to 60 minutes are reported separately: by design the hold does
   not cover them.

9. **Count process restarts in every window you compare.**
   - **Why restarts matter.** The affinity map is an in-process `Map`
     (`packages/load-balancer/src/strategies/session-affinity.ts:257`). A restart therefore
     forgets every owner, and each lane's next request is routed as a new session.
   - **The size of the effect.** In the baseline window, same-partition pairs that spanned
     an upstream start switched accounts 52% of the time (74 of 142), against about 3%
     otherwise. Remaps that followed a restart carried 12.15M of the 47.37M same-or-lower-band
     remap excess.
   - **How to count.** Count upstream starts from `journalctl -u ccflare-stack.service`:
     there is one `Dashboard will be available` line per start. The journal retained the
     baseline window only from 2026-10-02 23:33 UTC, and it shows 56 starts from then to the
     window's end.
     A window with more deploys or memory recycles shows more remaps for reasons unrelated
     to routing policy.

10. **Read the production database only with `sqlite3 -readonly`.** Never size or verify this
    with scripted requests through Anthropic accounts; AGENTS.md prohibits scripted Anthropic
    inference.

### The queries

Queries 1 and 2 read the window `[start_ms, end_ms)` from one `VALUES` row; Query 3 reads it
from the one-row temp table `p`. The values below are the pre-#510 baseline window,
2026-10-01 19:13:49 UTC to 2026-10-15 19:13:49 UTC. It ends at the deploy: the deploy script
rewrote the production pin at 19:13:49 UTC, 51 seconds after PR #510 merged. Run each with
`sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db < query.sql`.

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

Query 3 splits Query 2's under-five-minute switches into non-remaps and remaps of a warm
conversation. It builds temp tables, which `sqlite3 -readonly` allows because the temp
database is separate from the opened file. It takes about two minutes on the production
database.

```sql
.headers on
.mode column
-- Query 3: split Query 2's under-5-minute switches into "not a remap" and "remap of a
-- warm conversation" by reconstructing each request's conversation parent.
-- Window: [start_ms, end_ms). Edit the p row only. Temp tables work under -readonly.
CREATE TEMP TABLE p AS SELECT 1790882029000 start_ms, 1792091629000 end_ms;

CREATE TEMP TABLE sw AS
WITH r AS (
  SELECT r.id, r.client_session_id sid, r.model, r.timestamp ts, r.account_used acct,
         COALESCE(r.failover_attempts, 0) fa,
         COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
           + COALESCE(r.cache_creation_input_tokens, 0) total,
         COALESCE(r.cache_read_input_tokens, 0) cr,
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
  SELECT * FROM r
  WHERE prev_acct IS NOT NULL AND ts - prev_ts < 300000
    AND (prior_end IS NULL OR prior_end <= ts) AND fa = 0
),
snap AS (
  SELECT account_id, timestamp / 3600000 hb, MAX(utilization) u, MAX(resets_at) rs
  FROM usage_snapshots, p
  WHERE window_key = 'seven_day'
    AND timestamp >= p.start_ms - 86400000 AND timestamp < p.end_ms
  GROUP BY 1, 2
),
rated AS (
  SELECT seq.*,
         (100 - so.u) / MAX((so.rs - seq.ts) / 3600000.0, 0.01) rate_old,
         (100 - sn.u) / MAX((sn.rs - seq.ts) / 3600000.0, 0.01) rate_new
  FROM seq
  LEFT JOIN snap so ON so.account_id = seq.prev_acct AND so.hb = seq.ts / 3600000
  LEFT JOIN snap sn ON sn.account_id = seq.acct AND sn.hb = seq.ts / 3600000
)
SELECT id, sid, model, ts, acct, prev_acct, total, cr, cc,
  CASE WHEN acct = prev_acct THEN 'same'
       WHEN rate_old IS NULL OR rate_new IS NULL THEN 'unknown'
       WHEN (CASE WHEN rate_new >= 4 THEN 5 WHEN rate_new >= 2 THEN 4 WHEN rate_new >= 1 THEN 3
                  WHEN rate_new >= 0.5 THEN 2 WHEN rate_new >= 0.25 THEN 1 ELSE 0 END)
          > (CASE WHEN rate_old >= 4 THEN 5 WHEN rate_old >= 2 THEN 4 WHEN rate_old >= 1 THEN 3
                  WHEN rate_old >= 0.5 THEN 2 WHEN rate_old >= 0.25 THEN 1 ELSE 0 END)
       THEN 'to-higher-band' ELSE 'same-or-lower-band' END cls
FROM rated;

-- Baseline: mean cache writes of same-account sequential pairs under 5 minutes. The rate
-- denominator is every sequential non-failover pair under 5 minutes.
CREATE TEMP TABLE base AS
SELECT AVG(CASE WHEN cls = 'same' THEN cc END) b, COUNT(*) pairs FROM sw;
DELETE FROM sw WHERE cls = 'same';

-- Candidate parents: every successful Anthropic request of those sessions, from an hour
-- before the window.
CREATE TEMP TABLE cand AS
SELECT r.id, r.client_session_id sid, r.model, r.timestamp ts,
       r.timestamp + COALESCE(r.response_time_ms, 0) te, r.account_used acct,
       COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0)
         + COALESCE(r.cache_creation_input_tokens, 0) total
FROM requests r JOIN accounts a ON a.id = r.account_used, p
WHERE a.provider = 'anthropic' AND r.success = 1
  AND r.timestamp >= p.start_ms - 3600000 AND r.timestamp < p.end_ms
  AND r.client_session_id IN (SELECT DISTINCT sid FROM sw);
CREATE INDEX temp.cand_sm ON cand(sid, model, ts);

-- Conversation parent: the latest earlier, already finished request in the same session and
-- model whose prompt total this request extends by at most 10% + 20k tokens.
CREATE TEMP TABLE par AS
SELECT s.*,
  (SELECT q.acct FROM cand q
   WHERE q.sid = s.sid AND q.model = s.model AND q.ts < s.ts AND q.ts >= s.ts - 3600000
     AND q.te <= s.ts AND q.id <> s.id
     AND q.total <= s.total AND s.total <= q.total * 1.10 + 20000
   ORDER BY q.ts DESC LIMIT 1) parent_acct
FROM sw s;

SELECT cls,
  CASE WHEN parent_acct = acct THEN '1 not a remap: parent already on the new account'
       WHEN cr >= 0.5 * total THEN '2 not a remap: new account already warm'
       WHEN parent_acct IS NULL THEN '3 not a remap: no continuation parent'
       WHEN parent_acct = prev_acct THEN '4 remap: off the previous account'
       ELSE '5 remap: off a third account' END kind,
  COUNT(*) n,
  ROUND(1000.0 * COUNT(*) / base.pairs, 2) per_1k_pairs,
  ROUND(SUM(MAX(cc - base.b, 0)) / 1e6, 2) excess_M,
  ROUND(SUM(MAX(cc - base.b, 0)) / base.pairs) excess_per_pair,
  ROUND(base.b) baseline_per_req,
  base.pairs pairs
FROM par, base
GROUP BY 1, 2 ORDER BY 1, 2;
```

## Why This Matters

Each filter changes the decision the number supports. Sized from the raw count, the
warm-owner hold looked like a fix for 7,531 events. Partition-order filtering cut that to 307
to-higher-band switches. Conversation parents cut it again, to 73 remaps of a warm
conversation, and only 59 of those were moves the hold addresses (8.47M excess). The other
14 followed a restart, left a spent owner, or are unexplained.

The two kinds of figure fail differently. Row counts from Query 2 overstate remaps four to
seven times. Its excess tokens overstate them by only 7 to 13%, because the non-remap rows
are cheap: they average a few thousand cache-write tokens, while a remap of a warm
conversation rewrites about 200k. So:

- Quote excess tokens.
- Never quote a Query 2 row count, or a rate of Query 2 rows, as a remap count.
- Attribute a remap only after the conversation-parent split. Otherwise lane interleaving
  dominates every per-row cause.

The baseline matters as much as the filter. Excess cost is a difference, and a baseline taken
from another population moves it. The overlapping same-account pairs carry larger cache
writes than sequential ones, so mixing them in shrinks the excess and blurs the before/after
comparison.

## When to Apply

- Before quoting a cache-cost figure for any change to session stickiness, owner retention,
  drain ordering, or account priority on Anthropic routes.
- When verifying a deployed routing change: re-run the queries over a post-deploy window and
  compare like with like, including the restart count.
- When a dashboard or alert reports "session switches": check whether it separates concurrent
  spread, failover and lane interleaving from remaps of a conversation.

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

Query 3, the under-five-minute switches split by conversation parent (denominator: 61,254
sequential non-failover pairs; baseline 4,977):

| Band class | Kind | Rows | Per 1,000 pairs | Excess | Excess per pair |
|---|---|---:|---:|---:|---:|
| same-or-lower-band | Not a remap: parent already on the new account | 694 | 11.33 | 3.53M | 58 |
| same-or-lower-band | Not a remap: new account already warm | 634 | 10.35 | 2.82M | 46 |
| same-or-lower-band | Not a remap: no continuation parent | 9 | 0.15 | 0.80M | 13 |
| same-or-lower-band | Remap off the previous account | 203 | 3.31 | 40.28M | 658 |
| same-or-lower-band | Remap off a third account | 35 | 0.57 | 7.09M | 116 |
| to-higher-band | Not a remap: parent already on the new account | 82 | 1.34 | 0.13M | 2 |
| to-higher-band | Not a remap: new account already warm | 149 | 2.43 | 0.61M | 10 |
| to-higher-band | Not a remap: no continuation parent | 3 | 0.05 | 0.01M | 0 |
| to-higher-band | Remap off the previous account | 71 | 1.16 | 9.70M | 158 |
| to-higher-band | Remap off a third account | 2 | 0.03 | 0.31M | 5 |

The to-higher-band remaps total 73 rows, 1.19 per 1,000 pairs and 10.01M excess, or 163
excess tokens per pair. Query 2's 307 rows are 5.01 per 1,000.

### Where the remaps came from

The full attribution is in the
[#516 comment](https://github.com/StartupBros-com/better-ccflare/issues/516#issuecomment-6203127045),
with every query. It adds a restart timeline from the journal, burst detection and the
router's own banding to Query 3's split, and assigns each row to the first class it matches.

- **Same-or-lower-band remaps, 238 rows, about 47.4M:**
  - 12.15M followed a process restart.
  - 2.61M fell in process-wide cold-switch bursts with no recorded restart.
  - 3.84M left an owner whose usage window was spent.
  - 1.07M were higher-band moves under the router's own banding.
  - 0.15M changed route profile.
  - **27.56M is unexplained.** In 136 of those 140 rows the owner was tied for the best band
    under the router's banding, and the strategy does not move an owner out of a tie. So the
    cause is not a band comparison. Attributing it needs the affinity decision recorded on
    each request.
- **To-higher-band remaps, 73 rows, 10.01M:**
  - 59 rows (8.47M) are moves the warm-owner hold addresses: 44 confirmed by the router's
    banding and 15 in a burst whose owner was also outranked.
  - The rest followed a restart (7 rows, 0.81M), left a spent owner (4 rows, 0.46M), or are
    residual (3 rows, 0.26M).

### How far each number can be trusted

- **Query 3's to-higher-band remaps are an upper bound** on what the hold can address.
  - The query checks only the weekly band. It does not check tier, fallback rung, billing
    class, restarts, or whether the owner was still available. An owner that was
    rate-limited or paused moves regardless of the hold.
  - The hourly `MAX(utilization)` and `MAX(resets_at)` can pair a pre-rollover utilization
    with a post-rollover reset inside one hour.
  - 166 of the 1,882 sequential switches are Fable-family requests. The live strategy bands
    those by the model-scoped `seven_day_fable` window, not the all-model `seven_day` window
    the query uses.
- **The conversation parent is matched on token totals, not on a prompt hash.** A parent that
  failed over or used another model is not found, and the row lands in the no-parent class.
- **The 5–60 minute bucket measures exposure, not cost.** The `requests` table does not record
  each request's cache TTL. The bucket therefore blends 1-hour-TTL main conversations, where
  a switch rewrites a still-warm cache, with 5-minute-TTL workers, whose cache was cold
  anyway.
- **Concurrent spread has its own cost:** overlapping switches average 21,558 cache-write
  tokens against 5,574 for overlapping same-account pairs. Stickiness does not control that
  population, so it does not belong in a remap figure.

### Comparing after the deploy

1. Confirm that production serves a build containing PR #510: its merge commit must be an
   ancestor of the `git_sha` reported by `/health`. See
   [verify-fix-ancestry-before-citing-a-measured-rate.md](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).
2. Set the window to `(1792091629000, 1793301229000)`, the 14 days from
   2026-10-15 19:13:49 UTC to 2026-10-29 19:13:49 UTC.
   - For an earlier read, use 7 days (`1792696429000` as the end); the rates in step 3 make
     the two window lengths comparable.
3. Compare Query 3's to-higher-band remap rows (kinds 4 and 5), not Query 2's row counts.
   Use the per-1,000-pairs rate and the excess per pair, because traffic volume changes.
   The baseline is 1.19 remaps per 1,000 pairs and 163 excess tokens per pair.
4. Count upstream starts in the post-deploy window and set them beside the baseline's 56
   (over the 12.8 days of the baseline window that the journal retained).
   A large difference in restarts moves remaps whatever the hold does. For an exact
   comparison, re-run the #516 waterfall and compare its class 7 and 5b rows.
5. Expect the under-five-minute to-higher-band remaps to drop, not reach zero.
   - The hold is capped at 30 minutes per episode.
   - It applies only to Anthropic owners in sticky mode outclassed by pace band alone, at
     the same tier and fallback rung.
   - Owners that become unavailable still move, and a restart still forgets every owner.
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
- Issue #509 is the originating issue. PR #510 shipped the warm-owner hold. Issue #516
  attributes the same-or-lower-band remaps. Issue #197 tracks routing decisions being
  invisible in production logs.
