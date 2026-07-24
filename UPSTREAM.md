# Upstream relationship

- **Upstream:** https://github.com/tombii/better-ccflare
- **Divergence (as of 2026-07-24):** +367 ahead / -25 behind upstream default branch
- **Fork type:** Product fork (intentional hard divergence)
- **Sync cadence:** Manual cherry-pick only; divergence is intentional.

## StartupBros-specific delta

De-facto hard fork, substantially rewritten. Original StartupBros engineering: xAI cache handling, Codex WebSocket support, telemetry fixes. NOT a mirror.

## Why this file exists

An org-wide audit on 2026-07-24 found that comparing only the *default* branch made
several forks look like zero-delta mirrors when they actually carried unmerged
StartupBros fixes on side branches. Any future fork-pruning pass must enumerate and
author-check **all** branches, not just default-branch ahead/behind.
