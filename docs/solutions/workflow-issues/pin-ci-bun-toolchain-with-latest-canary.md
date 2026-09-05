---
title: Pin the CI Bun toolchain to .bun-version and detect drift with a non-blocking latest canary
date: 2026-09-05
category: workflow-issues
module: ci
problem_type: workflow_issue
component: ci
severity: medium
applies_when:
  - Deciding how a CI workflow should install Bun (`bun-version:` vs `bun-version-file:` on `oven-sh/setup-bun@v2`)
  - A release or signing workflow still floats `bun-version: latest` after the merge gate has been pinned
  - Wondering whether a new Bun patch release (e.g. 1.4.1, 1.4.2) is safe to adopt in CI
  - Adding a new workflow that installs Bun and needing to know which set it belongs to (pinned vs canary)
symptoms:
  - "`bun-version: latest` on the managed-routing gate silently resolved to Bun 1.4.0 and broke three suites with no code change (#231/#232)"
  - "release.yml, release-dispatch.yml, signpath-release.yml, and signpath-test.yml kept floating `latest` even after the gate itself was pinned, so a release build could still land on an unproven Bun version"
  - "PR #319 removed the gate's pin back to `latest` after fixing the root causes, reopening the same exposure (#321)"
  - "oven-sh/setup-bun@v2 silently falls back to `latest` if `bun-version-file` points at a missing file, with only a warning — a deleted or typo'd `.bun-version` would not be caught without an explicit assertion step"
  - "Bun 1.4.1 and 1.4.2 shipped 2026-09-04 and 2026-09-05, two days after #319's unpin, with no CI signal on whether either is safe"
root_cause: floating_toolchain_version
resolution_type: ci_policy
related_components:
  - ci
  - test-suite
tags:
  - bun
  - ci
  - toolchain-pin
  - canary
  - setup-bun
---

# Pin the CI Bun toolchain to .bun-version and detect drift with a non-blocking latest canary

## Context

Floating `bun-version: latest` on a `oven-sh/setup-bun@v2` step means the merge gate's toolchain
can change with no commit, no diff, and no review: issue #231 was exactly that failure mode
(tracked further in #232) — Bun 1.4.0 reimplemented web streams and rewrote `node:net`/`node:http`
for Node parity, and three suites that no PR had touched went red. PR #230 pinned the gate to
1.3.14 to stay usable; PR #319 fixed the underlying test/production issues and then removed the
pin, restoring `bun-version: latest` on the gate. That unpin reopened the exact exposure #231 had
already demonstrated, which is the gap issue #321 tracks: nothing stopped the gate (or the
release/signing workflows, which had been floating `latest` the whole time) from silently picking
up a new Bun version again. Bun 1.4.1 and 1.4.2 shipped 2026-09-04 and 2026-09-05 — two days after
#319's unpin — with no CI signal on whether either is safe to run on.

## Decision

Pin every Bun install in CI to one source of truth, `.bun-version` (exact `1.4.2`), and add a
scheduled, non-blocking "Bun Latest Canary" workflow that runs the merge gate's exact steps on
Bun `latest` and files or updates a tracking issue when latest fails. Upgrades become a deliberate
one-line edit of `.bun-version`, made with the canary's evidence already in hand.

Rejected alternatives:
- **Ceiling `1.4.x`**: patch releases also change semantics — 1.4.1 and 1.4.2 landed 2026-09-04/05
  and the gate has never been proven on `.x`. A ceiling would auto-adopt one of them without
  anyone having run the gate on it.
- **Accept drift**: the status quo restored by PR #319. It is a repeat of the exact failure mode
  #231 already caused once.

## Mechanism

- **`.bun-version`** at the repo root holds the exact pinned version and is the only file the gate,
  release, and signing workflows read, via `oven-sh/setup-bun@v2`'s `bun-version-file` input.
- **Installed-equals-pinned assertion**: `setup-bun` only warns and silently falls back to `latest`
  if `bun-version-file` points at a missing file, so every pinned workflow runs an explicit
  `test "$(bun --version)" = "$(tr -d '[:space:]' < .bun-version)"` step immediately after Setup Bun.
- **`.github/actions/managed-routing-gate/action.yml`** is a composite action holding the gate's
  install/build/test/lint/typecheck/format/clean-checkout steps, moved verbatim out of
  `managed-routing-postgres.yml` so both the blocking gate and the canary run identically the same
  steps — the canary is only meaningful if it exercises exactly what the gate does.
- **`bun-latest-canary.yml`** is the only workflow allowed to float a Bun version
  (`bun-version: ${{ inputs.bun-version || 'latest' }}`). It has no `pull_request` trigger, so it can
  never block a merge; it runs on a daily schedule, on `workflow_dispatch` (with an optional
  candidate version and a `run-when-pinned` override), and on `push` to `main` for the files that
  define it. It never edits `.bun-version`.
- **`scripts/bun-latest-canary-report.sh`** turns the canary's outcome into at most one write:
  a failing gate files or updates a single tracking issue, identified only by the
  `<!-- bun-latest-canary -->` marker in its body (never by title, so a rename doesn't orphan it);
  a `<!-- bun-latest-canary:state resolved=<v> outcome=<success|failure> -->` marker embedded in the
  issue body and every comment lets the script dedupe — the same verdict for the same resolved
  version writes nothing twice. A passing gate on a version with no open issue writes only a
  `::notice::`. The script never closes, edits, or labels an existing issue.
- **`auto-rerun-failed.yml`** excludes "Bun Latest Canary" from its rerun set: a scheduled
  toolchain verdict does not change on rerun, the report is already deduplicated per version, and
  each rerun would cost a full gate run for no new information.
- **`tests/bun-toolchain-pin.test.ts`** is the contract test that keeps this policy honest: it
  fails if any workflow other than `bun-latest-canary.yml` uses `bun-version:` instead of
  `bun-version-file: .bun-version`, if a pinned workflow is missing its installed-equals-pinned
  assertion, or if `.bun-version` falls below the `>=` lower bound of `package.json`'s `engines.bun`.

## Bump procedure

1. Dispatch the canary against the candidate — `gh workflow run bun-latest-canary.yml -f
   bun-version=<candidate>` — or wait for its daily scheduled run. A failing candidate files or
   updates a tracking issue labelled `bug`.
2. If the canary is green, change `.bun-version` in a PR. The canary run is the proof; nothing
   else needs to re-verify the new version.
3. If the canary is red, fix the affected suites and/or production code first, following
   `docs/solutions/workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md` §6 — never
   restore `bun-version: latest` as a workaround on the gate or a release/signing workflow.
4. Close the canary's tracking issue once the pin moves past the failing version; the canary
   itself never closes it.

## Evidence

- Run 33952100329, this branch's start commit (tree-identical to main `aeac1fd1`), resolved
  `bun-v1.4.2` and passed the full gate on 2026-09-05.
- Run 33948101728, on `main`, passed the full gate on Bun 1.4.1.
- PR #319 verified the gate's fixes on both Bun 1.3.14 and 1.4.0 locally.

## Verification

```bash
bun test tests/bun-toolchain-pin.test.ts
bun test scripts/__tests__/bun-latest-canary-report.test.ts
actionlint
gh workflow run bun-latest-canary.yml -f run-when-pinned=true
```
