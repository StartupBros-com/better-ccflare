---
title: A composed upstream sync silently drops improvements unless you survey untouched paths and review merge commits by combined diff
date: 2026-09-10
category: workflow-issues
module: upstream-integration
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Integrating an upstream release by composing intent rather than taking upstream files
  - Preparing a two-parent merge whose tree equals the fork parent's tree
  - Deciding whether upstream merge commits can be treated as content-free
  - About to resolve a conflicted sync with "ours" across the board
symptoms:
  - A ledger marked every item covered while real upstream improvements were missing
  - Upstream merge commits assumed empty because each had two parents and a matching diffstat
  - A trial merge showed files auto-merging that the fork had never reviewed
  - Documentation describing routing behavior the fork does not actually have
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - providers
  - documentation
tags:
  - upstream-integration
  - combined-diff
  - silent-drop
  - two-parent-merge
  - ours-merge
  - ledger-evidence
---

# A composed upstream sync silently drops improvements

## Context

This fork integrates upstream by **composing intent into its own architecture**, not
by taking upstream files. That preserves fork-only behavior, but it breaks the usual
safety net: because no upstream file is ever adopted verbatim, nothing structurally
forces you to notice an upstream change you simply never looked at.

A 141-item resolution ledger with per-item evidence was still not enough. Three
further checks found real gaps.

## Check 1 — review upstream merge commits by combined diff

Verifying that each upstream merge commit has two parents and a diffstat equal to the
sum of its branch commits is **topology verification, not content verification**. A
merge's conflict resolution exists in neither parent.

```bash
git show --cc <merge-sha>    # empty output = genuinely content-free
```

Of fourteen upstream merges, thirteen were genuinely empty and one carried real
conflict-resolution content that existed nowhere else.

## Check 2 — survey every upstream-changed path the fork has not touched

This is where silent drops live. Any path upstream changed that the fork never
modified will either auto-merge without review or be discarded by an `ours`
resolution — in both cases with nobody reading it.

```bash
comm -23 \
  <(git diff --name-only <merge-base>..<upstream-target> | sort) \
  <(git diff --name-only <fork-baseline>..HEAD | sort)
```

On one release this surfaced, all genuinely missing:

- a request-observation hook, whose absence left pool-exhausted refusals invisible to
  telemetry that already allowlisted those exact events
- eleven internal control headers missing from the pre-fetch strip list, including an
  authenticated-caller header whose forgery is the actual risk
- a bench reason written to the account row but absent from the API's allowlist, so
  it was silently nulled and never reached the dashboard
- a payload-leaking parse-failure log
- three documents that were **factually wrong about this fork's own routing
  strategies**, claiming one strategy exists where four do

## Check 3 — decide `ours` on evidence, never as a default

An `ours`-shaped merge permanently marks every upstream commit up to the target as
integrated, so anything genuinely missing will never be offered again. That is
correct **only** after checks 1 and 2 come back clean, and it should be stated
explicitly in the merge message rather than left implicit.

Two things a trial merge will try to bring in that policy forbids here: upstream's
version manifests, and `apps/cli/README.md`. Abort and inspect rather than letting
them ride along — run `git merge --no-commit --no-ff` first and read what auto-merged.

## The disposition that hides the most

Of the four dispositions a ledger item can take — imported, adapted, already-satisfied,
excluded — **`already-satisfied` is the dangerous one**. An adversarial re-check found
one item marked already-satisfied whose evidence cited the wrong file entirely; the
behavior was genuinely missing. When auditing a sync ledger, spend the effort there.

## Applicability

Every fork-preserving upstream sync in this repository. Skip none of the three checks
because the ledger looks complete — the ledger is what these checks audit.

Related: [per-unit green gates hide cross-unit regressions](per-unit-gates-hide-cross-unit-regressions.md).
