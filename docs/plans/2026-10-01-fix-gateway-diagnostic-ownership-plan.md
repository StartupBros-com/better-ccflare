# Preserve routing decisions and truthful cancellation ownership

Status: implementation-ready for Units 1 and 2; conditional investigations require new evidence.
Source: fresh `origin/main` at `085adb508ee977f8472c7fadedf27b3ba725a5e8`.
Evidence cutoff: 2026-10-01 06:36:58 UTC; live identity verified at 06:53:40 UTC.
Backend `085adb50` was served by guard/runner `fce5fa55`, generation 3; 07:04:22 UTC remained serving with unchanged final-error count and zero transport/deadline errors.
This investigation changed no production process, provider traffic, quota, routing or client setting.

This follows the [delivered architecture plan](2026-09-30-1957-fix-gateway-reliability-architecture-plan.md).
PRs #406, #408 and #409 already shipped attempt ownership, cleanup repair and retained handoff.
PR #407 subsequently changed Auto provider capability admission; it is included in this source.
Implement the two remaining diagnostic gaps below rather than repeat those shipped units.

## Evidence and limits

- **Proven:** selection diagnostics and requested logical model disappear at terminal persistence.
  The actual-module mock passed 20 assertions across two paths, with no providers/DB writes; wire `policy_excluded` survives while stored reason/model intent disappear.
- **Proven:** guard `handleAbort` labels an injected generic `AbortError` as `client_aborted` when
  `abortCause=null` and `signal.aborted=false`. The exact-source fixture used no sockets or providers.
  This proves a classifier defect, not the original cause or count of historical cancellations.
- **Source-confirmed:** selection timeout returns without the terminal recorder; history can omit it.
- **Historical, unresolved:** 18 Sol semantic-stall roots comprised 16 failures and two later successes.
  Valid protocol frames do not establish productive output. All preceded the corrected guard epoch.
  Current code already saves both attempts, the specific timeout cause and native/wire status distinction.
- **Unqualified:** three historical memory recycles do not prove a leak; 14 large Astra zero reads,
  including 13 with earlier same-cohort hits, do not prove identical serialized prefixes or a cache defect.
- The 49 zero-dispatch refusals were all `POST /v1/messages`, ending at 05:07:52.957 UTC.
  Path is preserved already. Caller purpose and the original rejection predicates remain unknown.
  Their stored cohort also had 453 successes; it does not establish identical inputs or one agent.

## Architecture constraints

Use the existing request lifecycle, typed selection diagnostics, attempt ledger and terminal finalizer.
Keep decision intent separate from real physical attempts and the serving winner.
Preserve one finalization/upsert authority; late selection, cancellation and cleanup cannot replace it.
Do not introduce a second ledger, arbitrary telemetry strings, raw payload retention or a DB side writer.
Preserve force-route, selected profile/model/provider, context, quota, billing and hosted replay rules.
The shared 840-second deadline includes at most one safe cache rescue of at most 30 seconds.
Do not extend deadlines, manufacture meaningful output, or replay an irreversible dispatch.

## Unit 1 — Retain the decision that produced a local terminal

**Ownership:** proxy selection/terminal path, request summary types/sanitizer and existing persistence protocol.

1. Extend the existing bounded `routing_attempt_summary` JSON/TEXT envelope with an optional decision.
   Keep the existing sixteen-KiB envelope; propose a two-KiB decision cap and 128-character safe identifiers.
   These are proposed decision-schema bounds, not already implemented fields; retain old-record compatibility.
   Use fixed keys/enums and integer counters; missing evidence stays unknown.
2. Freeze requested logical model and declared route constraints before model mutation.
   Reuse method/path already present; derive a fixed operation enum without storing a duplicate caller path.
   Distinguish trusted helper origin only where existing request metadata establishes it; otherwise unknown.
   Serving account/provider/model/winner remain null if no physical dispatch occurred.
3. Carry immutable `RoutingSelectionDiagnostics` directly from the observed selection/admission transition.
   Preserve exact/inferred/unknown provenance, selection cardinalities, zero-attempt reason and inventory outcome.
   Reuse existing Auto `qualityDecision`; never recompute its admission policy for telemetry.
   Emit fixed exclusion counters at actual predicates, including unavailable mappings/catalog role,
   explicit policy/provider/profile constraints and known scoped capacity exclusions.
   Count only the first observed exclusion per candidate and fixed stage; declare that stage denominator.
   Same-stage reasons partition those observed exclusions; do not sum stages or reconstruct missing account state.
   Mark incomplete inventory explicitly; inferred cardinality-based reasons remain inferred.
   Keep stale/unknown capacity separate from observed exhaustion; bound freshness/expiry metadata.
   Do not retain account names, arbitrary quota-window strings, full capacity objects or error messages.
4. Pass the typed decision alongside the terminal response into the existing lifecycle; never parse wire JSON.
   Route all local selection terminals through that once-only recorder: reactive model exhaustion
   (`proxy.ts:2545–2556`), predictive throttle (`2559–2563`), force-model denial (`2574–2577`),
   deferred throttle (`4640–4644`), phase timeout and inventory failure.
   Preserve trusted internal-probe exclusions and unchanged wire/retry behavior.
   A late selector cannot send a provider request, overwrite the frozen decision or create a second record.
5. Carry the decision through sanitizer → Start/End protocol → UsageCollector → RequestRepository
   and existing REST/live summary reads. Preserve physical attempt causes and native/wire statuses.
   Inventory read failure is explicit unknown evidence, not a fabricated empty pool or quota diagnosis.
   If the decision exceeds its budget, omit it with an explicit evidence gap while retaining attempts.
   Existing TEXT storage requires no migration; justify any proposed new column before adding it.

**Source seams:** `packages/proxy/src/proxy.ts` (selection deadline and empty pool),
`packages/proxy/src/handlers/routing-terminal.ts`, `packages/proxy/src/routing-terminal-recorder.ts`,
`packages/proxy/src/handlers/routing-attempt-ledger.ts`, `packages/proxy/src/handlers/routing-selection-diagnostics.ts`,
`packages/proxy/src/handlers/account-selector.ts`, `packages/types/src/api.ts`, `packages/types/src/request.ts`,
`packages/proxy/src/usage-collector.ts`, `packages/database/src/repositories/request.repository.ts` and protocol consumers.

**Red → green tests:** `packages/proxy/src/__tests__/routing-terminal-observability.test.ts` and
`packages/database/src/repositories/__tests__/request-attempt-summary.test.ts`, plus affected routing/collector suites.

- Extend actual-module refusal coverage: policy-excluded request sends zero providers and saves exact reason,
  requested logical model and operation once, with null serving identity and unchanged wire/retry behavior.
- Same cardinalities with unavailable/stale capacity retain their actual evidence and inferred provenance.
  Inventory read rejection records failed/unknown, not zero accounts or exhausted quota.
- Delayed fake selector expires once; late fulfillment/rejection produces no send, overwrite or duplicate upsert.
- Cover every listed local-return path through one lifecycle/record; preserve trusted internal-probe exclusions.
- Cover messages, count_tokens and trusted helper use of messages without changing provider contracts.
- Attempted failure/rescue still preserves physical identity, specific cause and wire-200/native-503 facts.
- Sanitizer boundary cases reject unsafe identities, nonfinite/fractional/negative counts and malformed data;
  old records remain readable and oversize decisions cannot break response delivery or erase attempt evidence.
- Run affected collector/repository suites, including PostgreSQL-gated callers if shared signatures change.

## Unit 2 — Attribute aborts from observed ownership; preserve cleanup as secondary evidence

**Ownership:** existing guard abort context, body cleanup telemetry and their regression tests.

1. Select the earliest explicit abort owner using the existing monotonic request context.
   Fixed sources include observed downstream abort/close, accepted/header deadline, maintenance,
   provider failure and unknown. A generic `AbortError` or unowned aborted signal remains unknown.
   Observe request/response/socket transitions separately; a normal close after completion is not client abort.
   Do not infer Esc, client idle timeout or client crash from a server exception or UI warning.
2. Snapshot first cause/event and bounded age before cancellation propagates through other layers.
   Existing accepted/semantic/maintenance terminal authority takes precedence over derivative cancellation.
   Do not change retry eligibility, guard deadlines, wire handling or routing behavior in this repair.
   Retain aggregate abort totals; add explicit/unknown categories and document any denominator definition change.
3. Add fixed cleanup phase, bounded discarded bytes and response committed/completed facts to existing events.
   Keep body cleanup timeout secondary: completed/failed primary outcomes and their original causes survive it.
   Use the current private guard journal and backend summary where each owns observations.
   Correlate their existing identities for aggregate analysis; do not give the guard a second persistence writer.
4. Release every owned listener, timer, reader/body lease and cleanup promise exactly once on every path.
   Preserve recent best-effort cleanup behavior: cleanup errors cannot mask a completed response or earlier error.

**Source seams:** `scripts/ccflare-guard.mjs` (`handleAbort`, request context and body cleanup),
`packages/proxy/src/anthropic-semantic-preflight.ts`, existing attempt ledger and request cause types.
**Tests:** `scripts/__tests__/ccflare-guard.test.ts`, `scripts/__tests__/ccflare-guard-handoff.test.ts`,
`packages/proxy/src/__tests__/semantic-stall-evidence.test.ts`,
`packages/proxy/src/handlers/__tests__/routing-attempt-ledger.test.ts`.

Mock generic AbortError/unowned signal, explicit downstream abort, normal completed close,
competing deadline/maintenance/client events, late cancellation after selected semantic cause,
cleanup deadline after success/failure and blocked discard. Assert immutable earliest owner,
once-only terminal/counters, retained primary outcome, bounded bytes and zero leftover timers/listeners/leases.

## Conditional investigations — no causal repair before proof

**Sol progress:** consume the deployed per-attempt ledger at the next natural recurrence.
Join accepted request/generation/attempt chronology, native event categories and productive counts,
translated meaningful output, selected terminal owner and cleanup. Add only absent bounded ages/buffer facts.
Native productive output with zero translated progress is a translation/gating candidate requiring a local mock;
structural/opaque native events with no productive delta indicate a different upstream/workload hypothesis.
Reuse `packages/proxy/src/__tests__/semantic-stall-evidence.test.ts`,
`packages/proxy/src/__tests__/proxy-anthropic-semantic-failover.test.ts` and
`packages/providers/src/providers/codex/provider.stream-bounds.test.ts`.
Only after a reproduced cause should repeated-failure recovery be designed with a bounded TTL/LRU,
structural selected-route scope and already authorized alternatives inside the unchanged shared deadline.
It must fail explicitly when no legal alternative exists and preserve observed legitimate long successes;
model switching alone is not causal proof.

**Memory:** sample existing health/JSC/body/writer/stream/worker gauges and RSS+swap every 30 seconds
for one fixed 60-minute natural-traffic window, at most 120 samples per backend generation.
Compare nonoverlapping 20-minute workloads with at least 200 completions when available.
Low-water comparisons require naturally empty admission/writer/tracked streams; otherwise inconclusive.
Do not sum `external` and its included `arrayBuffers`, mix process generations, disable the watchdog,
force GC or take sensitive synchronous production heap snapshots. Prove retained ownership/heap residual
under comparable quiescent workloads and reproduce it locally before calling it a leak or changing owners.

**Cache:** the 07:08 UTC live audit on backend `085adb50`, generation 3, found
`CCFLARE_CODEX_CACHE_DIAGNOSTICS` disabled/unset and `CCFLARE_CODEX_CACHE_TELEMETRY_PATH` unset.
Prepare/dispatch/terminal/drop/rotation/qualified-residual counts are unavailable, not zero.
No activation occurred. Source audit shows unchanged provider headers/body/model/cache controls, with hashing/cloning and synchronous journal writes/fsync overhead.
Later opt-in uses the official backend environment/configuration seam for one fixed 60-minute natural window; a path alone does not enable the observer.
Require a private 0700 directory/0600 single-writer regular file, reject symlink/multilink/permissive targets, and preserve private HMAC, 64-entry/30-minute/8-MiB, 16-KiB event and 4×16-MiB rotation bounds.
First run existing Codex cache-qualification/cache-wire/cache-telemetry privacy, byte-preservation and rotation tests; compare a baseline and stop on overhead/reliability/storage regressions.
Require a completed prior positive hit and unchanged entire ordered prior prefix, controls, instructions,
tools, account, physical model, transport, cache/client/build/digest epochs and dispatch chronology.
Upstream residency remains unknown. Reproduce a local transformation discrepancy before a cache fix.
Stop without silently extending if no qualified recurrence; no warming or cache-optimization flag changes.

**Client timeout:** the exact Linux mock proved ~360-second default cancellation versus ~390-second success with the worktree override; live adoption/effectiveness remained inconclusive.
Do not prescribe a global flag change or restart an active agent to validate it.

## Implementation, rollout and acceptance

Implement Unit 1 then Unit 2 in fresh feature worktrees with mock tests first and focused independent review.
Before review/merge, fetch current main and inspect overlapping changes; preserve every recent repair.
Run affected suites plus repository-required `bun run lint`, `bun run typecheck` and `bun run format`.
Typecheck excludes tests: inspect shared-signature callers and execute affected suites. Ship clean draft PRs; builds use merged main via `scripts/deploy-ccflare.sh` only.
Validate binary/guard/runner policy and generation identity, then observe natural traffic; no provider probes.

For each change, compare completed nonoverlapping persistence windows separated by exact build/guard epochs.
Report generation/helper/diagnostic/failure counts separately, including guard-only refusals and cleanup events.
Acceptance is retained typed decisions for natural no-dispatch terminals when present, no invented winner,
truthful explicit/unknown abort categories, unchanged primary outcomes and healthy writer/storage/stream completion.
Check retries, cancellations, policy/quota refusals, transport/429/5xx, queue/body leases and finalization duplicates.
Absence of a rare natural case is unvalidated coverage, not proof; mock regressions provide the bounded proof.
Cache reuse is token-weighted `read / (uncached input + read + write)` with sample/usage coverage;
normalize inclusive native input before storage and never claim cross-workload ratio changes as causality.
Record admission/drain/recovery times and separate deployment interruptions from request/cache causes.
If telemetry grows unbounded, changes response semantics or duplicates finalization, roll back through the
official script to a verified merged-main artifact, preserving active work and recording new epochs.
No quota reset, policy bypass, synthetic warming, silent route change or cache-optimization/experimental routing flag change.
A potential bounded diagnostic-observer opt-in requires the verification above and is not currently active.
