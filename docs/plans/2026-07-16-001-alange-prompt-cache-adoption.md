# Adopt ALange prompt-cache optimization suite

Status: design review completed 2026-07-16, decisions recorded below. This PR remains open as the tracking unit until the implementation PRs land (issues are disabled on this repo).

## Source

Fork: https://github.com/ALange/better-ccflare (11 commits ahead of tombii main as of 2026-07-16).

## Pieces, in porting order

### 1. Multi-fingerprint keepalive slots (bug fix, port first)

Source commit: `d26d61a6`. Replaces the single `lastCachedRequest` per account in `cache-body-store.ts` with accountId -> fingerprint -> entry (FNV-1a hash over the system+tools byte prefix, per-account LRU of 5 slots, global cap 500). Fixes a real bug: an account serving multiple distinct system/tools prompts only keeps one warm; whichever request completes last overwrites the keepalive slot.

Design decisions (2026-07-16 review):

- Replay volume: keep the per-account LRU of 5, add a global per-tick replay cap (config `cache_keepalive_max_replays_per_tick`, default 15), draining most recently promoted slots first. When the cap truncates, log a warn with the dropped count. No silent truncation.
- Pacing exemption: keepalive replays already carry `x-better-ccflare-keepalive`. The proxy must skip `observeCachePacing()` and `recordCachePacingRoute()` for tagged requests so synthetic replays never become pacing leaders and never pollute route or canary stats. Add a regression test for both exemptions.
- API change: `getLastCachedRequest(accountId)` becomes a list-returning accessor. Update the keepalive scheduler and cache-watch tooling in the same PR, no compatibility shim.
- Memory bound: with up to 500 global entries, add a per-entry body size guard (skip staging bodies above a fixed constant, default 2 MB) so the store has an explicit worst-case ceiling instead of an implicit one.

### 2. Multi-turn message breakpoint (opt-in flag)

Source commit: `21f46dc0`, ported together with budget fix `a9815e38` (the base commit undercounts `messages[]` breakpoints and can exceed the 4-breakpoint budget, producing upstream 400s).

Design decisions:

- Ships opt-in via `message_cache_breakpoint`, default off, matching the source design. No account-level override in v1.
- Placement on the second-to-last message (never the volatile latest turn) is sound. Idempotency must be covered by a test that runs injection twice over the same body and asserts a single breakpoint.
- `warnOnLookbackRisk` in `cache-telemetry.ts` reads the raw body before injection; keep that ordering so the lookback warning reflects what the client actually sent.

### 3. Auto-inject cache_control with self-learning effectiveness gate (largest)

Source commits: `28bdcf53`, `a9815e38`.

Design decisions:

- Ships opt-in (`auto_inject_cache_control`, default off). Revisit default-on only after 2+ weeks on the dogfood instance with positive net savings in the cache insights stats.
- The effectiveness tracker and cache pacing act on different axes and share no state (tracker: per account+model injection on/off, 5 minute cadence; pacing: per session+model request timing, per request). Guard rails so the two loops cannot fight:
  - Tracker sampling must exclude keepalive-tagged synthetic requests. Otherwise the 5x replay traffic from piece 1 skews hit rates upward and masks ineffective injection.
  - Minimum sample size per decision window (at least 20 real requests per account+model pair) and hysteresis: disable only after 2 consecutive bad windows, re-probe after 30 minutes. Decisions must not flap, and a disabled pair must always retain a path back to enabled.
- The new `aggregateCacheStatsByAccountModel()` query lands with SQLite and PostgreSQL implementations in the same PR, per the repo dual-database policy. No schema change is expected (it aggregates existing `requests` columns); if one becomes necessary it follows the 5-step migration checklist in CLAUDE.md.
- Body mutation ordering: auto-injection runs before `stageRequest()` so the staged keepalive body matches what was actually sent upstream, and before payload storage so stored payloads reflect the true request.

## Sequence

1. Port piece 1 with the replay cap and the pacing/stats exemption tests.
2. Port piece 2 together with the `a9815e38` budget fix.
3. Port piece 3 (tracker plus aggregate query, both databases) behind its flag.
4. Let each piece bake on the dogfood instance, then evaluate upstream contribution.

Each piece is its own implementation PR referencing this tracker. Every PR requires focused unit tests, `bun run lint && bun run typecheck && bun run format`, and the standard review ladder including a pro-gate before merge.
