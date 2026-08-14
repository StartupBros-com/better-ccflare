---
title: A green typecheck does not prove callers are safe — test files are excluded
date: 2026-08-13
category: workflow-issues
module: shared-persistence-contracts
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Changing a parameter shape on a repository, facade, or other cross-package contract
  - "`bun run typecheck` passes immediately after a shared-signature change"
  - Merging main into a long-lived branch that touches shared persistence code
  - A test file gates its whole suite on an env var such as DATABASE_URL
symptoms:
  - "TypeError: {} is not iterable thrown from recordSnapshot after merging main"
  - 12 fleet-history tests failed at rebase on a branch that never touched the changed signature
  - bun run typecheck reported zero errors while four stale test call sites existed
  - A live-PostgreSQL suite skipped itself and reported green with broken call sites inside
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - database
  - testing_framework
tags:
  - typecheck
  - tsconfig-exclude
  - contract-drift
  - test-call-sites
  - canonical-usage-windows
  - pg-live-queries
  - database-url-gate
  - baseline-diff
---

# A green typecheck does not prove callers are safe — test files are excluded

## Context

The root `tsconfig.json` excludes every test file:

```json
// tsconfig.json:27
"exclude": ["**/__tests__", "**/*.test.ts", "**/*.test.tsx"]
```

`bun run typecheck` runs `tsc --noEmit` against that config, so **test files never
participate in the type checker's caller analysis**. When a shared signature changes,
`tsc` has no opinion at all about stale test call sites — not a warning, not an error.

This is narrower than "typecheck is unreliable." Typecheck catches this defect class
perfectly well when the stale caller is *production* code: an earlier session hit a
`DatabaseOperations` method-name mismatch in `packages/proxy/src/handlers/token-manager.ts`
and `bun run typecheck` failed immediately. The exclusion is precisely what removes test
files from that same protection.

PR #168 (canonical usage windows, closes #136) narrowed the persistence write path from an
untyped provider payload to one typed shape:

```ts
// packages/database/src/repositories/usage-history.repository.ts:89
async recordSnapshot(
	accountId: string,
	windows: CanonicalUsageWindow[],
	now: number,
): Promise<void> {
	const params: unknown[] = [];
	const count = windows.length;      // line 99 — undefined for a raw object, no throw
	for (const window of windows) {    // line 100 — throws here
		...
	}
	if (count === 0) return;
	...
}
```

Passing the pre-refactor shape — `{ five_hour: { utilization: 12, resets_at: 123 } }` —
does not fail at line 99: a plain object simply has no `.length`. It fails at line 100,
because the object is not iterable, producing `TypeError: {} is not iterable`.
`DatabaseOperations.recordUsageSnapshot` (`packages/database/src/database-operations.ts:1075`)
is a thin pass-through to the same signature, so it fails identically.

A second layer of invisibility applies to one of the affected files. `pg-live-queries.test.ts`
gates its entire live block on an env var:

```ts
// packages/http-api/src/__tests__/pg-live-queries.test.ts:238
const url = process.env.DATABASE_URL;
...
describe.skipIf(!livePgAvailable)("PostgreSQL queries (live, requires DATABASE_URL)", ...)
```

Any run without `DATABASE_URL` skips that block and reports green. Stale call sites inside
it were therefore doubly hidden: excluded from typecheck, and inside a suite that
self-skips by default.

## Guidance

**1. After changing a shared repository/facade signature, grep the test call sites yourself.**
Typecheck structurally cannot do it:

```bash
grep -ran "recordUsageSnapshot(\|recordSnapshot(" --include='*.ts' packages apps
```

**The `-a` is not optional in this repo.**
`packages/database/src/repositories/usage-history.repository.ts` contains a committed NUL
byte at line 261, where a composite key is built with a NUL delimiter. `file` reports that
path as `data` rather than text, so plain `grep` applies its binary-file heuristic and
skips it **silently, with no warning** — meaning the file that *defines* the contract is
the one missing from your sweep. Without `-a` you get a confident, complete-looking result
that has quietly omitted the most important file.

Enumerate every hit, subtract the definitions, and confirm each remaining call site passes
the new shape. Do this *before* declaring the refactor done. On PR #168 an adversarial
review pass found two stale live-PG call sites by inspection — that catch was review, not
tooling, and review does not scale to this.

**2. Run env-gated suites explicitly before merging changes to the code they exercise.**
A gate like `DATABASE_URL` is a coverage blind spot for exactly this defect class:

```bash
# throwaway Postgres container, then:
DATABASE_URL=postgres://user:pass@localhost:5432/db \
  bun test packages/http-api/src/__tests__/pg-live-queries.test.ts
```

Three test files currently gate on `DATABASE_URL`, so this is a repo-wide pattern rather
than a quirk of one file:

- `packages/http-api/src/__tests__/pg-live-queries.test.ts`
- `packages/database/src/__tests__/multi-instance-guard.test.ts`
- `packages/database/src/migrations-pg.test.ts`

Report a skipped gated block as *skipped*, never as passed. A locally green run proves
nothing about a block that never executed.

**3. When a long-lived branch merges `main`, diff failing test _names_ against a fresh
base baseline — not pass/fail counts.** Counts cannot separate "my merge broke something"
from "main already had N known failures" or from batch-isolation flakes. Capture the
failing names on the branch and on the base commit, strip ANSI escapes and timings, sort
both, and diff. An empty diff is the only thing that demonstrates zero regressions.

**4. Do not substitute editor/LSP diagnostics for the real gate.** LSP in a worktree can
resolve against the wrong checkout and produce false "not exported" errors. `bun run
typecheck` is the authority — and even that authority has the hole documented here, so
the only trustworthy signal for this defect class is running the affected test files.

## Why This Matters

Every individual gate was green at the moment it should have caught the problem:

- `bun run typecheck` reported zero errors on PR #168 — correctly, since the exclude list
  meant it never saw the stale call sites.
- The two stale live-PG sites on #168 were fixed in review before it merged. But PR #188
  (fleet usage history, refs #137) had *independently* added two more raw-payload seeds to
  the same file while #168 was still open, plus its own `seed()` helper in a different test
  file using the same stale shape. Neither branch could see the other's in-flight changes.
- `bun test` on #188 was green before it merged `main` — the signature had not changed on
  that branch yet.

The break surfaced only when #188 merged `origin/main` at `ac5aaf2b`: 12 tests in
`usage-history-fleet.repository.test.ts` failed with `TypeError: {} is not iterable`, and
the two newly-added live-PG seeds would have thrown identically the moment `DATABASE_URL`
was set — an outcome nobody would see until a PG-backed run.

That is the shape of the risk: a structurally-invisible break that surfaces not at
authoring time and not at merge time, but at **rebase time on an unrelated branch**,
attributed to whoever touches that file next even though they did not cause it. Two
independent PRs hit the identical defect class in the identical file within about twenty
minutes of each other merging, which marks this as a gap in the verification gate rather
than an authoring mistake.

## When to Apply

- Any signature change on a repository, facade, or cross-package contract — anything under
  `packages/*/src/repositories/` or `packages/*/src/database-operations.ts`.
- Any time `bun run typecheck` passes clean right after such a change. Treat that as
  necessary, not sufficient, evidence of caller safety.
- Before merging `main` into a long-lived branch that touches shared persistence, and
  before merging that branch back.
- Any test file with a `describe.skipIf` or `if (!process.env.X) skip` gate wrapping calls
  into changed code.

## Examples

The fix (`8ded6907`, merged to `main` via PR #188 at `dc59df03`) treated the two files
differently, and the difference is the point.

`usage-history-fleet.repository.test.ts` builds the canonical shape **directly**:

```ts
// packages/database/src/repositories/__tests__/usage-history-fleet.repository.test.ts:54
function canonicalWindow(windowKey: string, utilization: number): CanonicalUsageWindow {
	return {
		windowKey, utilization, resetsAtMs: null,
		scope: "account", modelFamily: null, active: true,
	};
}
```

`UsageHistoryRepository` is provider-agnostic by design (see its docstring at
`usage-history.repository.ts:82-87`: "adding a provider must never mean editing
persistence"). Its tests should not need to know which provider emits a given window key,
so constructing the canonical window directly is the *more* correct fix, not a shortcut.

`pg-live-queries.test.ts`, by contrast, exercises the fleet read path end-to-end, so its
seeds go through the normalizer — matching the two sites #168 had already fixed:

```ts
// packages/http-api/src/__tests__/pg-live-queries.test.ts:972
await dbOps.recordUsageSnapshot(
	id,
	normalizeProviderUsageWindows(
		{
			five_hour: { utilization: 12, resets_at: now + HOUR },
			seven_day: { utilization: 34, resets_at: now + 24 * HOUR },
		},
		"anthropic",
	),
	now - HOUR,
);
```

**Rule of thumb:** use `CanonicalUsageWindow` directly when the code under test is
provider-agnostic; reserve `normalizeProviderUsageWindows(payload, provider)` for tests
that specifically exercise provider-shape parsing.

All four normalizer call sites in that file now agree with the contract (lines 940, 972,
1017, 1463). Repo-wide, `grep -a` finds 14 matches across 8 files; two are the definitions
themselves (`usage-history.repository.ts:89` and the `DatabaseOperations` facade at
`database-operations.ts:1075`), leaving **12 real call sites across 7 files**, all of which
pass the canonical shape. Five of those are production code (`server.ts` twice,
`accounts.ts`, `auto-refresh-scheduler.ts`, and the facade's own inner call) and are
guaranteed by `tsc`. The other seven live in test files and are guaranteed only by having
been checked by hand — which is the whole point of this document.

### Verification that was actually performed

- Re-running the two files the fix changed, plus the sibling repository suite, with no
  `DATABASE_URL` set: **32 pass, 53 skip, 0 fail** across 3 files. Report the 53 skips
  out loud — that is the gated live-PG block declining to run, and calling this result
  "32 passing" without the skip count is precisely the mistake this document warns about.
- The full `database` + `http-api` + `dashboard-web` + `core` suite failed the identical
  29 test names as `origin/main` at `2018a9af` — a sorted-name diff came back empty, so
  zero regressions were attributable to the fix.
- Against a throwaway Postgres 16 container, the branch showed 4 failures in
  `pg-live-queries.test.ts` versus 5 on base; the fleet tests passed 3/3. The missing
  failure was a stale `400`-expectation the fleet handler had made obsolete, fixed as a
  drive-by in the same PR.
- After deploying `dc59df03` (confirmed via `/health` `git_sha`), fresh `usage_snapshots`
  rows showed utilization bounded at exactly `100.0` and never above, across all recorded
  window keys.

### The structural fix not yet taken

A second config — `tsconfig.typecheck.json` that `include`s test files, run as its own
`tsc --noEmit -p` step — would have caught all four stale call sites at authoring time on
both PRs. Nothing in the tree does this today. It is a candidate, not a decision: test
files use looser typing patterns (mocks, `as any`), so enabling it will surface a wave of
pre-existing noise that needs triage before the step can gate anything.

## Related

- [rate-limit-scope-and-duration.md](../rate-limit-scope-and-duration.md) — the invariant
  that scope, duration, and evidence must name the same window.
- [validate-against-live-payloads.md](../validate-against-live-payloads.md) — the sibling
  gap: hand-built fixtures that pass while describing a payload the provider never sends.
  Same lesson one layer up, and it carries the baseline-compare technique referenced above.
- [guard-phantom-heartbeat.md](../../reports/guard-phantom-heartbeat.md) — an
  earlier report that correctly logs its `DATABASE_URL`-gated skips as skips rather than
  passes. That is the reporting discipline this doc asks for, already practised.

Origin issues: #136 (the canonical-window contract, shipped in PR #168) and #137 (the
fleet history read, shipped in PR #188). No issue tracks the verification gap itself —
this document is its record.
