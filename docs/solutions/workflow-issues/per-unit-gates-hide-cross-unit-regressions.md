---
title: Per-unit green gates hide cross-unit regressions — sweep the whole repo, then diff against a baseline worktree
date: 2026-09-10
category: workflow-issues
module: upstream-integration
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Landing a multi-unit change where each unit runs its own curated suite list
  - Integrating an upstream release by composing intent across several commits
  - A large change touches migrations, providers, and proxy handlers in separate units
  - You need to tell "I broke this" apart from "this was already broken"
symptoms:
  - Every per-unit gate passed, plus lint, typecheck and format, while six real regressions were live
  - A whole-repo sweep reported 33 failing files with no obvious common cause
  - A suite that passed earlier in the same session failed later under identical code
  - Four failures shared one root cause in a file no single unit's suite list covered
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - database
  - testing_framework
  - proxy
tags:
  - whole-repo-sweep
  - baseline-worktree
  - regression-triage
  - curated-suite-lists
  - upstream-integration
  - migrations-pg
  - pre-existing-failure
---

# Per-unit green gates hide cross-unit regressions

## Context

During the upstream v3.5.78 integration (PR #339), work was split into units, each
with its own curated list of test suites plus `lint`, `typecheck` and `format`.
**Every unit passed every gate.** A whole-repo isolated sweep run at the end still
found **six genuine regressions** the session had introduced.

A curated suite list only proves the suites someone thought to name. The misses
were PostgreSQL fresh-vs-upgrade DDL parity tests living in packages the unit did
not obviously touch.

## The two-part practice

### 1. Sweep the whole repo before declaring done

Run every test file, one per process — this repo's module mocks leak across batched
files, so a batch-only failure is an artifact and must be re-run alone before it is
diagnosed:

```bash
mapfile -t ALL < <(git ls-files '*.test.ts' '*.test.tsx' | sort)
for suite in "${ALL[@]}"; do
  mise exec bun@1.4.2 -- bun test --timeout 30000 "$suite"
done
```

Budget for this. Per-unit green is not sufficient evidence for a multi-unit change.

### 2. Diff failures against a baseline worktree

A sweep that reports failures is only half an answer — you still cannot tell your
regressions from pre-existing ones. Add a detached worktree at the pre-session
baseline and run the failing suites there:

```bash
# from inside your own worktree
git worktree add --detach ../baseline-check <pre-session-baseline-sha>
git -C ../baseline-check ...   # build first: a fresh worktree has no inline workers
```

A fresh worktree lacks the generated inline workers and `bun test` crashes on import
until `bun run build:cli` runs there once.

Then classify: **BASELINE-PASS and fails now = you broke it. BASELINE-FAIL = pre-existing.**

This turned 33 unexplained failures into a precise split:

| Class | Count | Cause |
|---|---|---|
| Harness artifact | 26 | An exported `DATABASE_URL` made SQLite-native suites fail |
| Real regressions | 6 | Genuinely introduced by the session |
| Pre-existing | 1 | Failed identically at baseline |

Four of the six shared a single root cause: an unguarded `row.definition`
dereference in `migrations-pg.ts` that threw out of `runMigrationsPg` — the upgrade
path for existing PostgreSQL installs. A live `psql` check had passed earlier
because real PostgreSQL 16 returned the expected row shape; the parity tests used a
different adapter shape.

## Why per-unit gates missed it

The failing suites asserted that the fresh `ensureSchemaPg` path and the upgrade
`runMigrationsPg` path emit identical DDL. They were not in any unit's list because
no unit's stated scope named them, even though a unit changed the file they assert
on. The signature is: **unchanged test + changed source + now failing.**

## Applicability

Highest value when a change spans packages with independent suites, and whenever the
question "did I break this or was it already broken?" is expensive to answer by
reading. For a single-package change with a suite that genuinely covers it, the
per-unit gate is fine.

Related: [a green typecheck does not prove callers are safe](typecheck-does-not-cover-test-call-sites.md)
— the same underlying failure, that a gate's coverage is narrower than its reputation.
