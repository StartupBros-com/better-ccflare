# Adopt ALange prompt-cache optimization suite (design review required)

Status: proposed, awaiting design review. Tracking unit for the deferred HIGH-value findings from the 2026-07-16 sibling-fork audit.

## Source

Fork: https://github.com/ALange/better-ccflare (11 commits ahead of tombii main as of 2026-07-16).

## Pieces, in porting order

### 1. Multi-fingerprint keepalive slots (bug fix, port first)

Source commit: `d26d61a6`. Replaces the single `lastCachedRequest` per account in `cache-body-store.ts` with accountId -> fingerprint -> entry (FNV-1a hash over the system+tools byte prefix, per-account LRU of 5 slots, global cap 500). Fixes a real bug: an account serving multiple distinct system/tools prompts only keeps one warm; whichever request completes last overwrites the keepalive slot.

Design questions: our keepalive scheduler and cache-watch tooling consume `getLastCachedRequest`; the replacement returns all slots per account. Keepalive replay volume multiplies by up to 5x per account, which interacts with cache pacing counters.

### 2. Multi-turn message breakpoint (opt-in flag)

Source commit: `21f46dc0`. Places a `cache_control` breakpoint on the last content block of the second-to-last message (never the volatile latest turn), converting string content to text-block arrays as needed, idempotent, gated by a `message_cache_breakpoint` config flag defaulting off. Adds `countCacheControlBreakpoints()` to respect the 4-breakpoint budget across system+tools+messages. We currently have no conversation-history caching at all.

### 3. Auto-inject cache_control with self-learning effectiveness gate (largest)

Source commits: `28bdcf53`, `a9815e38`. Injects an ephemeral 1h breakpoint on the last system/tools block when the client sent none and estimated size exceeds a per-model-family threshold (1024/2048 tokens), respecting the budget. Paired with `AutoInjectEffectivenessTracker`: every 5 minutes, samples real cache-hit rate per (account, model) via a new `aggregateCacheStatsByAccountModel()` DB query and disables injection for pairs where it does not help, self-healing when hit rates improve. ~750 lines of tests in the source fork.

Design questions: the tracker adds a second feedback loop next to our cache pacing; they must not fight. Auto-injection mutates client request bodies; decide default-on-with-gate vs opt-in. Confirm interaction with attribution and payload storage. The new DB aggregate query needs SQLite and PostgreSQL parity per repo policy.

## Suggested sequence

1. Design doc comparing the tracker loop with our pacing counters and keepalive scheduler.
2. Port piece 1 (smallest, a bug fix), then piece 2 (opt-in), then piece 3.
3. Evaluate upstream contribution of each piece after it bakes here.
