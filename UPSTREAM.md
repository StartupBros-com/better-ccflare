# Upstream relationship

- **Upstream:** https://github.com/tombii/better-ccflare
- **Fork type:** Product fork with intentional hard divergence
- **Sync cadence:** Manual, pinned source integration when an upstream release is worth adopting; targeted cherry-picks otherwise
- **Current sync record:** [PR #288](https://github.com/StartupBros-com/better-ccflare/pull/288), the [v3.5.70 resolution inventory](docs/plans/2026-08-30-issue-260-v3.5.70-resolution-inventory.json), and its [generated ledger](docs/plans/2026-08-30-issue-260-v3.5.70-resolution-ledger.md)

This repository is not a mirror. It substantially rewrites routing, provider,
persistence, provenance, and operator behavior for StartupBros. Default-branch
ahead/behind counts do not determine whether the fork is redundant or whether an
upstream update is safe.

## Protected fork contracts

A release sync must preserve, at minimum:

- routing precedence, exact-account/model fail-closed behavior, model-route profiles,
  capability pools, session affinity, and strict-drain semantics;
- response provenance, terminal recovery order, stream ownership, cancellation, and
  exactly-once usage collection;
- fork providers and defaults, canonical provider identities, model mappings, and
  compatible-endpoint validation;
- Config-authoritative controls and default-off behavior for new routing features;
- SQLite/PostgreSQL migration, repository, retention, and active-window parity;
- fork build/update provenance, runtime Git-SHA identity, deployment source gates,
  observability, and operator controls.

The v3.5.70 inventory and generated human ledger record the protected behavior,
selected resolution, evidence, and review state for every upstream-only commit,
textual conflict, and clean two-sided path in the current integration. Earlier
issue #260 artifacts remain immutable historical checkpoints.

## Release synchronization protocol

1. Create a tracking issue and pin the annotated tag object, peeled commit, direct
   fork parent, merge base, and required fork ancestors before integration.
2. Derive and audit every upstream-only commit, predicted conflict, and clean
   two-sided path. Resolve overlap semantically; do not replace either parent tree
   wholesale and do not use blanket `ours` or `theirs` resolution.
3. Integrate the exact peeled target as the second parent of one real two-parent
   merge commit. Preserve upstream history rather than replaying only release files.
4. Protect changed behavior with isolated tests, explicit caller sweeps, SQLite/PG
   parity and restore rehearsal, combined-diff review, static gates, and CI.
5. Treat deployment as a separate operator-authorized action from clean canonical
   `refs/heads/main`. A merge, package version, or successful source sync does not
   prove the installed binary or running service identity.

Ordinary dashboard, npm, binary, or Docker update paths may resolve mutable
upstream-controlled artifacts. They must not replace this fork unless provenance
proves the intended producer and artifact mode. The StartupBros managed-source
build is deliberately non-actionable through the ordinary updater.

## Why this file exists

An org-wide audit on 2026-07-24 found that comparing only the default branch made
several forks look like zero-delta mirrors when they actually carried unmerged
StartupBros fixes on side branches. Any future fork-pruning pass must enumerate and
author-check all branches and audit behavior, not just default-branch divergence.
This protocol permits reviewed release merges without promising automatic upstream
tracking or weakening intentional product-fork ownership.
