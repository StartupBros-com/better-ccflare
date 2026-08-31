---
title: Authenticate upstream sync closeout against the locally reviewed result
date: 2026-08-31
category: workflow-issues
module: upstream-sync-ledger
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Closing a release synchronization after its integration merge and review fixes
  - A final inventory or ledger claims an upstream tag, exact merge topology, and complete evidence
  - Reviewing a descendant of the integration merge rather than the integration commit itself
symptoms:
  - A ledger can identify the peeled upstream release while accepting a lightweight tag or an unrelated tag object.
  - A syntactically valid two-parent merge can be recorded even when its parents are reversed, substituted, or detached from the reviewed HEAD.
  - A green typecheck or focused suite leaves stale test callers and hand-built module mock barrels unverified.
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - testing_framework
tags:
  - upstream-sync
  - release-provenance
  - annotated-tags
  - merge-topology
  - reviewed-head
  - semantic-remap
  - incremental-evidence
  - caller-sweep
---

# Authenticate upstream sync closeout against the locally reviewed result

## Context

An upstream release closeout is a provenance and behavior proof, not a version bump or a claim that a conflict-free merge was safe. PR #288 shipped the v3.5.70 integration. Its final locally reviewed result contains a dedicated two-parent integration merge; those object IDs are useful topology examples, but the durable shipment reference is PR #288. Here, “reviewed” means the completed local review-fix rounds recorded in the PR, not a GitHub approval review.

This repository is a deliberately divergent product fork, not a mirror (`UPSTREAM.md:5-10`). Its synchronization protocol requires a pinned annotated tag and peeled commit, a genuine two-parent merge, semantic resolution, isolated tests and caller sweeps, and separately authorized deployment (`UPSTREAM.md:32-45`). Treat the finalized inventory, ledger, rerere capture, and test manifest as append-only checkpoints. Add a later checkpoint rather than rewriting a finalized claim.

Earlier synchronization sessions showed why the final object matters (session history). A merge command once reported a rerere failure after it had already created the merge commit. Another apparently successful review produced no usable terminal receipt. A later conflict-free merge still failed an independent review. Exit status, clean conflict state, and branch narrative were each weaker than direct inspection of the reviewed graph and tree.

## Guidance

1. **Freeze the source identity before integration.** Record the explicit `refs/tags/vX.Y.Z` ref, its annotated tag object, the peeled commit, the fork parent, required fork ancestors, the merge base, and the ordered upstream commit set. Schema v2 resolves the tag object, requires object type `tag`, and verifies that peeling produces the recorded target (`scripts/verify-upstream-sync-ledger.ts:411-433`). A release label never substitutes for immutable source identity.

2. **Use a machine inventory plus a generated human ledger.** Derive upstream commits, conflicts, and clean shared paths rather than listing only what happened to conflict. The validator assigns deterministic item IDs and anchors, then rejects a ledger whose records or anchors diverge from the inventory (`scripts/verify-upstream-sync-ledger.ts:537-685`, `scripts/verify-upstream-sync-ledger.ts:1054-1119`). Every final item needs a non-pending disposition, focused evidence, complete acceptance evidence, applicable combined-diff evidence, and an accepted reviewer (`scripts/verify-upstream-sync-ledger.ts:851-900`).

3. **Authenticate the integration graph, not the merge message.** Validate that the recorded integration is a commit, that Git reports exactly `[forkParent, target]` in that order, and that the integration is an ancestor of the reviewed ref (`scripts/verify-upstream-sync-ledger.ts:1125-1177`). Read parents through Git's parent-only format; parsing `cat-file -p` lines can mistake a commit-message line beginning `parent ` for topology. Regression coverage must include reversed and extra parents, a detached otherwise-valid merge, a reviewed descendant, and a valid merge whose message contains such a line (`scripts/__tests__/verify-upstream-sync-ledger.test.ts:840-954`).

4. **Resolve intent, not files.** For every upstream commit, conflict, and clean shared path, record upstream intent, protected fork behavior, selected resolution, a focused regression oracle, and both-parent or combined-diff evidence. A clean path can still overwrite fork semantics. PR #288 retained stricter method- and shape-aware authentication while preserving the upstream bypass-hardening intent, and extended upstream stream-drain ordering through the fork's transport-ownership rules.

5. **Make checkpoints incremental and replayable.** Capture pre-merge derivation, open-merge/rerere state, focused red-to-green proofs, parent-delta review, final validator output, and a refreshed-main check. The final validator compares the inventory rerere applications with an authoritative capture and requires a complete capture state (`scripts/verify-upstream-sync-ledger.ts:1340-1384`). In a clean clone, fetch the exact annotated tag ref before replaying the validator; the merge commit does not carry the tag ref.

6. **Sweep callers and test doubles in addition to typechecking.** The root TypeScript configuration excludes tests (`tsconfig.json:30-31`), so typecheck cannot validate test call sites or manual `mock.module` barrels. Use a byte-safe caller search because committed NUL bytes can make ordinary grep silently skip files. Then run every affected suite in an isolated process. PR #288's first CI run failed because a hand-built `@better-ccflare/http-api` mock omitted the new `classifyAuthPath` export; adding the mock export and the lifecycle suite to replayable test evidence closed the gap.

7. **Close against the reviewed result and current main.** Run the final inventory/ledger/rerere check, semantic-oracle tests, lint, typecheck, format, and both-parent review. Then prove the reviewed result is reachable from the current default branch. A post-integration review fix is acceptable only when the original two-parent integration remains reachable and the final review covers the descendant.

## Why This Matters

Weaker closeout signals fail in distinct ways:

- **Version-only or cherry-pick assumptions** do not prove the annotated release object, exact target, upstream history, or retained fork behavior.
- **Conflict-only review** ignores clean shared paths that can still change semantics.
- **Self-reported evidence** can describe a result as reviewed without binding it to a graph, tree, or deterministic item set.
- **Typecheck-only verification** misses test-only callers and manual module barrels by design.
- **Merge-command success or failure** is not proof of the object left behind; inspect the commit and reachability directly.

PR #288's local review-fix rounds hardened these boundaries only after counterexamples showed that the original validator could accept a detached valid merge object or misread commit-message prose. A closeout process that cannot reject those cases has not authenticated the reviewed result.

## When to Apply

Apply this pattern whenever a fork integrates an upstream release or non-trivial commit range, especially when:

- the fork protects routing, provider, migration, provenance, or operator behavior absent upstream;
- the release tag could be lightweight, mutable, locally absent, or confused with its peeled commit;
- integration uses semantic remapping, clean two-sided paths, rerere, or later review fixes;
- a shared export or facade changes while tests use manual module mocks;
- current main is merged after the upstream integration; or
- review approves a descendant rather than the raw integration commit.

A pure mirror may need less machinery. This repository's protected-contract list makes semantic integration and graph authentication the default (`UPSTREAM.md:15-26`).

## Examples

### Replay a final checkpoint

```bash
git fetch --no-tags https://github.com/tombii/better-ccflare.git \
  refs/tags/v3.5.70:refs/tags/v3.5.70

bun scripts/verify-upstream-sync-ledger.ts check \
  --repo . \
  --inventory docs/plans/2026-08-30-issue-260-v3.5.70-resolution-inventory.json \
  --ledger docs/plans/2026-08-30-issue-260-v3.5.70-resolution-ledger.md \
  --rerere-capture docs/plans/2026-08-30-issue-260-v3.5.70-rerere-capture.json
```

The committed manifest records this as a schema-v2 check of tag identity, exact ordered parents, integration reachability, item completeness, and rerere parity.

### Check topology without parsing commit text

```bash
git show -s --format=%P 60005baa
gh pr view 288 --repo StartupBros-com/better-ccflare --json state,mergeCommit
git merge-base --is-ancestor 60005baa origin/main
```

The production validator is stronger because it validates recorded object identity and fails when an otherwise-valid integration object is detached from the reviewed ref.

### Protect a semantic remap and mock callers

When upstream introduces a shared classifier or export, retain the fork-owned policy seam and add an upstream-derived behavior oracle rather than selecting either parent file wholesale. Enumerate imports, re-exports, and manual module mocks with a byte-safe search. Run every affected test file separately, including suites whose mocks replace the whole exported module.

## Related

- [A green typecheck does not prove callers are safe](typecheck-does-not-cover-test-call-sites.md)
- [OpenRouter `/v1` path duplication](../integration-issues/openrouter-api-v1-path-duplication.md)
- PR #288
