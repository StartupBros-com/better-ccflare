---
title: Gateway Reliability Architecture - Plan
type: fix
date: 2026-09-30
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
source_revision: 7ca65643b9ee2e397ddf29f02607621d103c78da
---

# Gateway Reliability Architecture - Plan

## Goal Capsule

- **Objective:** Clients receive truthfully attributed, bounded request outcomes, and operators can diagnose recurring stalls, memory growth, deployment interruptions, cache misses, and unsupported xAI helper requests.
- **Means:** Preserve attempt evidence, close maintenance resource ownership, prove remaining causes, and deliver a verified backend replacement transaction (KTD1–KTD8).
- **Authority:** Product requirements govern behavior. Existing capability, quota, force-route, billing, hosted-operation, and commit-bound routing authority remains authoritative over observations.
- **Execution profile:** Implementation is test-first and subagent-driven in feature worktrees. This artifact plans future work; the current authorization covers read-only diagnostics and planning.
- **Stop conditions:** A unit stops at its unmet research gate. This planning task executes no production rollout, service changes, provider probes, quota changes, or interruption of real sessions. Existing session authorization remains in force for later work; proof gates and repository rules do not automatically require renewed permission.
- **Tail ownership:** Each unit can ship separately through a draft PR after fresh overlap review. The release owner performs exact-head review, landing, deployment within existing authorization, and passive natural-traffic evaluation.

---

## Product Contract

### Summary

Repair attribution and maintenance ownership first. Diagnose remaining stall and memory mechanisms with bounded evidence, then implement verified replacement of a single backend while keeping public ingress available. Qualify cache cohorts and classify xAI token-count support through existing capability contracts.

### Problem Frame

The September 30 audit found long requests with no usable Sol output, provider-unattributed terminal records, memory-driven backend dispatch pauses, and a full-deployment public admission gap. Clients and operators cannot distinguish an upstream stall from a local routing failure when terminal records discard attempted identity and semantic cause.

The same audit found large Astra zero-cache-read cohorts and unsupported xAI token-count requests. Similar input size is insufficient proof of stable prefix or cache residency. Missing hosted-tool implementation is an intentional capability rejection and must retain its meaning.

The audit covers September 30, 2026, midnight–7:10 p.m. America/New_York, corresponding to [04:00,23:10) UTC. Source research is pinned to revision 7ca65643b9ee2e397ddf29f02607621d103c78da. These measurements are dated evidence, not permanent workload constants.

### Requirements

**Attempt truth and bounded progress**

- R1. Preserve attempted account, provider, logical model, physical model, and semantic terminal cause when a dispatched request fails.
- R2. Distinguish physical attempts, selected serving identity, and the logical-final result; a preselection rejection has no physical attempt.
- R3. Preserve separate protocol-activity and meaningful-progress clocks under one finite accepted-request budget.
- R4. Recovery may use only already authorized, replay-safe candidates; irreversible WebSocket writes, hosted dispatch, meaningful output, force routes, billing intent, and genuine quota limits retain their fences.

**Memory and lifecycle**

- R5. Give each maintenance worker, compiled object URL, timer, pending job, reader, and transport one disposal owner with bounded settlement.
- R6. Diagnose production memory growth before claiming a causal repair; preserve finite request-body, queue, stream, and recycle limits.
- R7. Replace backend generations with verified candidate identity, a single database/routing authority, and schema-safe recovery.
- R8. Report admission availability, dispatch availability, existing-stream completion, and forced retirement separately.

**Cache and provider capabilities**

- R9. Diagnose Astra misses using bounded final-wire structural cohorts; preserve unknown cache-write usage and upstream residency.
- R10. Handle unsupported xAI token counting before upstream dispatch, with a typed local unsupported result and no credential refresh or capacity penalty.
- R11. Hosted-tool capability is proven before ranking; exact forced lanes fail closed until the existing provider implementation proves the exact tuple.

**Cross-cutting safeguards**

- R12. Observational records cannot authorize dispatch, mutate quota, rewrite prompts, warm caches, change flags, or repeat inference after a persistence failure.
- R13. New metadata uses fixed fields and bounded retention, and aggregate reports exclude raw prompts, tool arguments, credentials, upstream content, and request/session/account identifiers.
- R14. Preserve SQLite/PostgreSQL parity for any persistent schema change, first-writer terminal semantics, and compatibility with concurrent owned routing work.

### Scope Boundaries

The five approved priorities remain in scope. Diagnostic units precede causal fixes where the evidence is incomplete.

#### Deferred to Follow-Up Work

Continuous backend dispatch through overlapping generations is conditional work in U6. Its authority and resource proof must pass before an executor extraction is activated.

An xAI advisory token estimate is a separate optional policy change. U8 selects local unsupported behavior because the inspected adapter has no supported native count path. An estimate cannot establish tokenizer accuracy, context capability, entitlement, or hosted-tool support. xAI documents a native /v1/tokenize-text endpoint taking text/model and returning token_ids; this is not a structured Anthropic-envelope count contract. A later provider-owned bridge needs envelope, entitlement, and parity validation. See [xAI tokenization](https://docs.x.ai/developers/rest-api-reference/inference/other).

Guard binary upgrades require a stable listener and accepted-connection ownership design beyond backend-only replacement. A retained listening socket alone does not preserve established streams.

Actual server-tool adapter implementation continues the existing provider-server-tools workstream. This plan changes helper classification and preserves its capability authority.

#### Outside This Plan

Synthetic provider traffic, live heap snapshots, forced live GC, quota resets, timeout increases as a remedy, raw payload collection, automatic provider/model substitution, and ordinary shared-database blue/green backends are excluded.

### Acceptance Examples

- AE1. **Covers R1–R3.** An encrypted-only initial attempt and failed rescue end with the semantic cause meaningful_progress_timeout and both attempted identities, even if outer terminal rescue sends HTTP 200 SSE after a native 503.
- AE2. **Covers R2, R4.** A safe initial stall followed by successful rescue retains the initial failure and final winner, counts physical sends independently, and accounts logical-final usage once.
- AE3. **Covers R4, R11.** An unavailable forced xAI lane or unsupported hosted-tool tuple rejects before dispatch and does not select another provider.
- AE4. **Covers R5–R8.** Backend replacement keeps ingress accepting within finite limits, lets old owned streams settle until the reviewed cutoff, and classifies expiry or forced retirement without replay.
- AE5. **Covers R9, R13.** A large same-session cache miss with missing prefix/effort evidence remains unqualified; missing creation usage remains unknown.
- AE6. **Covers R10–R12.** An xAI count helper produces a typed local unsupported result with zero upstream sends and no account capacity/circuit impact.

---

## Planning Contract

### Evidence and Hypothesis Register

| ID | Classification | September 30 evidence | Design implication |
|---|---|---|---|
| E1 | Confirmed local defect | Generic terminal recording nulls attempted account/routed provider/model and persists generic kind. providerName is only an in-process parsing hint. | U1 repairs typed provenance end to end. |
| E2 | Confirmed symptom | Ten exact joined Sol requests ran roughly 840 seconds, including two on current source; raw events show encrypted reasoning without usable text, summary, tool output, or completion. | U2 exposes discriminating evidence. Upstream cause remains unknown. |
| E3 | Confirmed ownership gap | optimizeAsync spawns a worker each minute; compiled Blob URLs have no explicit revoke owner. | U3 closes churn and URL lifetime independently of memory causality. |
| E4 | Confirmed operational impact | Three earlier-build RSS+swap recycles exceeded 4 GiB, paused dispatch 1,326.602 seconds total, and forced one outstanding request in two drains. | U4 investigates retention; U5 improves replacement. This does not prove a leak or WAL causality. |
| E5 | Confirmed deployment impact | Full new-build deployment caused a 423.788-second public admission gap; same-build full restart took about 3.8 seconds. | U5 separates ingress from backend deployment. |
| E6 | Unqualified candidate cohort | 281 large Astra zero-read records consumed 25.456M uncached tokens; 70 / 6.853M followed a recent hit on same account/model/session with similar size. | U7 adds qualification, not automatic cache optimization. |
| E7 | Confirmed endpoint contract defect | xAI inherits canHandle=true and translates messages only; count_tokens is forwarded unchanged. Audit shows 55 HTTP 404 count failures. | U8 rejects unsupported helper locally. |
| E8 | Confirmed intentional boundary | xAI has no source-owned hosted-tool capability implementation; five generation failures reported this rejection. | Preserve R11 and reuse existing workstream. |
| H1 | Unresolved upstream mechanism | Model behavior, account state, history interaction, cache/session state, and client identity may distinguish Sol stalls. | Matched natural cohorts; no model-completion guarantee. |
| H2 | Unresolved memory mechanism | Native fetch/backing stores, worker/URL churn, unsettled reads/jobs, and intentional retention remain candidates. | Causal offline fixture before production repair. |
| H3 | Conditional architecture | Stateless overlapping executors could preserve dispatch while one durable authority owns mutable state. | U6 requires full ownership inventory and failure proof. |

The production memory incidents occurred on earlier build 7f34d6ce. Relevant lifecycle files are unchanged at inspected source, but the original audit cutoff recorded no current-7ca natural recycle. A prior Bun 1.4.2 disposable fixture completed ten short waves at low concurrency under 512 MiB with forced GC controls; it did not reproduce production growth or sustained concurrent native-fetch retention.

Physical stream errors without an exact retained logical final are coverage gaps. Policy refusals, quota exhaustion, client cancellation, helper failures, and cleanup timeouts remain separate populations.

Current source explains why the 600-second guard setting can coexist with an approximately 840-second backend outcome: scripts/ccflare-guard.mjs clears its response-start timer in beginResponse before piping the final stream. After response commitment, the separate 120-second response-idle cap applies; twenty-five-second rescue keepalives can satisfy it while the backend commitment clock continues. Those backend and ingress clocks start independently. This is a source-permitted path, not proof that every dated stall used identical admission and first-byte timings. One accepted-request deadline is a target contract, not a demonstrated current guarantee.

### Key Technical Decisions

- KTD1. **Use the existing request ledger seam for bounded observational attempt snapshots.** Keep these snapshots separate from the ledger's authoritative claims and dispatch fences. The terminal arbiter consumes immutable outcomes and finalizes once (R1, R2, R12). Ad hoc last-error variables would lose retries and alternate terminal paths.
- KTD2. **Retain current semantic and rescue policy while improving evidence.** Classify the semantic outcome before cancellation cleanup. Retain the existing fourteen-minute backend commitment budget and at-most-once thirty-second rescue share (R3, R4). Guard response-start and stream-idle caps remain separate until G3a proves a compatible end-to-end contract. Encrypted reasoning is structural activity and cannot prove productivity.
- KTD3. **One serialized lifecycle-owned maintenance worker per database owner.** Own worker creation, compiled URL creation/revocation, jobs, fault replacement, and disposal together (R5). Bun termination is asynchronous; marked close is not proof every native allocation has gone. See [Bun workers](https://bun.sh/docs/runtime/workers) and [URL revocation](https://bun.sh/reference/globals/URL/revokeObjectURL).
- KTD4. **Measure ownership and native/JSC memory separately.** Use cheap fixed aggregate gauges and terminal retirement balances (R6, R13). Do not sum aliasing buffers, external plus arrayBuffers, or heapSize plus extraMemorySize. Bun documents separate JavaScript/native heaps, and extraMemorySize is included in heapSize/heapCapacity. Full object counting walks the heap and stays an offline tool. See [Bun memory guidance](https://bun.sh/docs/project/benchmarking) and [heapStats](https://bun.sh/reference/bun/jsc/heapStats).
- KTD5. **Ship retained ingress with a verified single-backend deployment transaction first.** Extend existing authenticated generation handoff to reviewed candidate builds while retaining one mutable authority (R7, R8). Cold replacement necessarily pauses dispatch; bounded queueing can preserve acceptance but cannot guarantee uninterrupted completion.
- KTD6. **Treat central authority and replaceable stateless executors as conditional target architecture.** U6 must prove the owner inventory, versioned command boundaries, durable ambiguous-send fences, global budgets, and control-channel failure behavior before overlap (R4, R7, R14). Shared SQLite alone cannot coordinate process-local decisions. Revoking a lease cannot revoke an already-open external transport or make a possibly sent attempt safe to resubmit. Owner epochs fence future sends; durable physical-send or ambiguous-send receipts reconcile uncertain work without replay.
- KTD7. **Extend existing CodexCacheDiagnostics and codex.cache_event.v1.** Their current TTL, count, hashing, file-size, and retention controls are the base (R9, R13). Add only dimensions required for strict qualification; never turn diagnostic failure into inference failure.
- KTD8. **Provider-owned path support precedes routing ranking.** Use a source-owned unsupported count classification for xAI (R10, R11). Native counting, local advisory estimates, unsupported, and unknown are distinct capability states; runtime observations cannot promote authority.

### Assumptions

These are unvalidated planning bets, not user-confirmed product decisions.

- A small typed attempt summary plus existing per-attempt trace/journal coverage is sufficient; a new general durable attempt table is unnecessary unless implementation proves an unmet requirement.
- The single-backend transaction is the lowest-risk useful deployment improvement. U5 must verify its crash and ownership invariants before this becomes release policy.
- Executor overlap may be unnecessary after the memory repair and U5. Its adoption requires a demonstrated continuous-dispatch need and an acceptable authority-service latency/resource envelope.
- Quantitative performance baselines will be selected from matched offline fixtures and natural traffic. The dated audit does not supply a universal latency or RSS threshold.

### High-Level Technical Design

The diagrams show the proposed boundaries and required state transitions. Conditional executor overlap is explicitly gated by U6.

#### Attempt flow and decision authority

~~~mermaid
flowchart TB
  I[Authenticated request and accepted deadline] --> C[Provider path and exact capability contract]
  C --> A[Authorized candidate plan]
  A --> F[Quota billing and irreversible dispatch fences]
  F --> D[Physical attempt]
  D --> S[Protocol and meaningful-progress classification]
  S --> O[Bounded observational outcome snapshot]
  O --> T[Once-only logical terminal arbiter]
  T --> P[First-writer persistence and usage]
  T --> W[Client wire status and terminal SSE]
  S --> Q{Already authorized and replay safe?}
  Q -->|Yes within remaining budget| D
  Q -->|No| T
~~~

There is no edge from observation to capability or dispatch authority. Preserve the actual output-origin identity once output is committed, including a stream that later fails. A successful final winner is a separate outcome. Native persisted status and client wire status are separate fields.

#### Backend replacement lifecycle

~~~mermaid
stateDiagram-v2
  [*] --> Serving
  Serving --> Prepared: Verified immutable candidate and durable intent
  Prepared --> Draining: Fence dispatch and retain bounded ingress
  Draining --> Reaped: Old work finalizes and old owner exits
  Reaped --> Starting: Candidate acquires sole authority
  Starting --> Verified: PID start hash source listener readiness agree
  Verified --> Committed: Persist active pin then unfence
  Committed --> Serving
  Prepared --> Reconcile: Crash or failure
  Draining --> Reconcile: Crash or cutoff
  Starting --> Reconcile: Crash or verification failure
  Reconcile --> Serving: Reap candidate and restore compatible reviewed pin
  Reconcile --> Held: Rollback incompatible or owner ambiguous
~~~

#### Resource ownership and retirement

~~~mermaid
flowchart TB
  G[Backend generation owner] --> DB[Database and maintenance owner]
  DB --> MW[Serialized worker plus compiled URL]
  G --> R[Request lifecycle owner]
  R --> B[Original rewritten and provider body leases]
  R --> X[Exact fetch controller and reader]
  R --> U[Usage finalization job]
  X --> Z[Bounded pending-read settlement]
  U --> Y[Writer queued and in-flight charge]
  MW --> E[Terminate and revoke once]
  Z --> E
  Y --> E
  B --> E
  E --> M[Aggregate acquired minus retired balances]
~~~

Cache-retained body leases require their own charge after request admission is released. Stream clones do not acquire their sibling's transport abort authority.

#### Conditional cross-generation authority

~~~mermaid
flowchart TB
  IN[Stable ingress and global admission] --> AU[Single durable routing quota session and DB authority]
  AU --> FP[Versioned immutable attempt plan plus dispatch fence]
  FP --> OLD[Old stateless inference executor]
  FP --> NEW[New stateless inference executor]
  OLD --> SR[Authenticated receipt and idempotent settlement]
  NEW --> SR
  SR --> AU
  AU --> GB[Global body queue stream retry and maintenance budgets]
~~~

No executor owns account polling, OAuth refresh, mutable homes, cache affinity election, DB writes, or quota authority. Executor-owned transport and parser state still consume global leases until retirement.

#### Diagnostic decision tree

~~~mermaid
flowchart TB
  D{Physical send receipt?} -->|No| L[Local admission selection or capability rejection]
  D -->|Yes| R{Raw visible events but no meaningful frames?}
  R -->|Yes| X[Translation or gating fixture]
  R -->|No| E{Encrypted-only activity?}
  E -->|Yes| H[Unresolved upstream stall cohort]
  E -->|No| P{Explicit provider error or protocol cap?}
  P -->|Yes| C[Typed policy quota context protocol cause]
  P -->|No| G[Coverage or transport ownership investigation]
  X --> F{Irreversible dispatch or committed output?}
  H --> F
  C --> F
  G --> F
  F -->|Yes| T[Finalize original attempt without replay]
  F -->|No| A[Evaluate existing authorized recovery within deadline]
~~~

### Deployment Transaction Contract

KTD5 requires these stages, with durable phase and immutable identity sufficient to reconcile crashes. acceptedAt is the first ingress request-header acceptance, before queued upload, parsing, authentication, quota checks, and dispatch. The monotonic remaining budget covers those phases, semantic gates, rescue, and a finite cleanup reserve.

1. **Prepare:** Build before drain. Verify binary hash, source SHA, ingress compatibility, runner/policy identity, candidate nonce, and schema rollback compatibility. Authenticate private control and persist intent atomically.
2. **Drain:** Fence old-generation dispatch before admission transition. Queued acceptance retains its absolute deadline and unread-body/reservation bounds. Old dispatched streams retain their original owner and correlation secret.
3. **Reap:** Await request terminals, usage/writer jobs, and maintenance disposal. Reconcile backend cleanup budget with supervisor stop budget. Prove old PID/start identity gone and authority lease fenced.
4. **Start and verify:** Start candidate at a generation-specific private endpoint. Verify actual listener owner, PID/start, hash, source, generation, ready health, and compatible DB state. A health response alone is insufficient.
5. **Commit:** Persist exact active pin and commit phase before attaching/unfencing. Use the verified generation's new control/correlation secret.
6. **Recover:** Reap a failed candidate before restoring the reviewed previous pin. An irreversible migration or ambiguous owner leaves dispatch held for operator action.

Full ingress shutdown remains distinct from retained-ingress replacement. Node server.close stops new connections; see [Node 24 HTTP lifecycle](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback). A [systemd socket](https://github.com/systemd/systemd/blob/main/man/systemd.socket.xml) can retain the listener and pending connections, but established stream/request ownership needs a separate design.

### Proof Gates and Sequencing

| Gate | Required proof | Enables |
|---|---|---|
| G0 | Fresh source/PR overlap checks and preserved behavior contracts | Each implementation unit |
| G1 | Failing deterministic ownership/provenance fixture with exact terminal ordering | U1, U3 fixes |
| G2 | Matched memory/stall evidence distinguishes one mechanism from alternatives | U4 causal repair or any future U2 behavior change |
| G3a | Trusted timing owner, authenticated acceptedAt/deadline handoff, exact compatible defaults, and post-commit expiry settled in fixtures | U5 transaction implementation |
| G3 | Candidate transaction crash/identity/rollback/queue proofs | U5 full-stack rehearsal |
| G4 | Complete mutable-owner inventory, versioned authority RPC, fenced sends, global leases and resource limits | U6 executor boundary prototype |
| G5 | Disposable stack rehearsal validates listener/dispatch/completion separately | Release review for U5/U6 |
| G6 | Exact reviewed head, affected tests, lint/typecheck/format and compatible artifacts | Landing |
| G7 | Production within existing session authorization, exact pin verification, and passive natural traffic | Production rollout |

U1 and U3 are immediately implementation-ready after G0 and their test-first G1 fixtures. U2, U7, and U8 can proceed independently where source overlaps are coordinated. U4 begins with diagnostics and unlocks only its causally demonstrated repair. U5 is independently useful but design-gated by G3a, then follows U3 and G3. U6 remains conditional even after U5 ships.

### Bounded Offline Diagnostic Contract

Future fixtures use disposable databases and private network namespaces with loopback mocks only. Default aggregate envelope is 512 MiB memory, no swap, 64 PIDs, a 40-second hard runtime cap, and 256 KiB/200 aggregate-record output cap. Compress the 840-second semantic clock with fake time. No fixture reaches a provider or the live DB.

The existing lifecycle research proposed longer 120/150-second bounds. This plan retains the previously reviewed 40-second envelope; a longer run requires a concrete experiment objective and reviewed resource justification before execution. Resource termination is a recorded failure, not permission for unbounded retries or larger limits.

Record exact runtime/build/generation, completed phase, peak and post-quiet RSS+swap, cheap JSC metrics, owner counts/bytes, retirement balances, pending settlement, and cleanup completion. Use normal GC for representative comparisons. Forced GC and full heap counting may appear only in separate offline controls, never as the sole reproduction.

### Existing Work and System-Wide Impact

PR #269, fix: reuse WAL maintenance worker, directly overlaps U3. Its historical head is 0c5d4de3f58105b1302e07c89d8b18995e89bafc and its merge base is old. Reuse its reviewed intent only after comparing current main hunks. Do not assume it is deployed or revive its branch blindly.

PR #404, fix(routing): add owned Codex subscription-only admission, overlaps server and admission authority. Its inspected head is bac421141f54df3a29f996f583dc6d9538aca19d. Coordinate with its owner before touching shared integration points.

The codex-session-attribution-fix workstream overlaps proxy-operations and count helpers. The attribution closeout documentation supplies vocabulary. Provider-server-tools work is the owner of exact hosted-tool implementation. The cache-parity plan remains the authority for parity success, distinct from degradation alerts or short-window recovery.

Changes cross request handling, provider translation, usage finalization, both DB adapters, deployment control, and operator health. First-writer request history, storage-after-output behavior, streaming/nonstreaming parity, and agent session continuity require integration coverage.

---

## Implementation Units

### U1. Preserve bounded physical-attempt and terminal attribution

**Goal:** Repair the confirmed end-to-end attribution defect.

**Requirements:** R1, R2, R12–R14; AE1, AE2.

**Dependencies:** G0 and G1. Ready to begin.

**Files:** packages/proxy/src/handlers/routing-attempt-ledger.ts; packages/proxy/src/handlers/proxy-operations.ts; packages/proxy/src/proxy.ts; packages/proxy/src/routing-terminal-recorder.ts; packages/proxy/src/worker-messages.ts; packages/proxy/src/usage-collector.ts; packages/types/src/request.ts; packages/database/src/repositories/request.repository.ts; packages/database/src/migrations.ts; packages/database/src/migrations-pg.ts if additive columns are required. Tests: packages/proxy/src/handlers/__tests__/routing-attempt-ledger.test.ts; packages/proxy/src/__tests__/routing-terminal-observability.test.ts; packages/proxy/src/__tests__/usage-collector-stream-terminal-state.test.ts; packages/proxy/src/__tests__/proxy-anthropic-semantic-failover.test.ts.

**Approach:**

1. Add immutable observational outcome snapshots at the existing ledger seam under KTD1.
2. Keep physical-send ordinal, route count, serving winner, selected failure, semantic cause, cancellation origin, and completeness distinct.
3. Pass the typed terminal summary through the worker/repository boundary. Preserve first-terminal decision against late usage enrichment.
4. Use existing persistent fields first. Any new persistent summary fields receive matching migrations and compatibility reads.

**Patterns:** RoutingAttemptLedger, once-only terminal recorder, bounded provider diagnostics, request-private hosted dispatch fence.

**Execution note:** First reproduce encrypted-only exhausted rescue with a failing persistence integration fixture.

**Test scenarios:**

1. Covers AE1. Two stalled physical sends persist exact identities and meaningful_progress_timeout with native/wire status separate.
2. Covers AE2. Rescue succeeds; first failure remains, serving winner is correct, and usage is charged once.
3. Preselection forced-route rejection emits no invented attempted identity.
4. Multi-provider failures retain each capped snapshot and mark truncation explicitly.
5. Late usage or storage retry cannot replace cause, duplicate finalization, or send inference again.
6. Serialization rejects arbitrary event names/content; counters saturate and no raw payload survives.
7. Both DB adapters preserve null, completeness, and first-writer semantics.

**Verification:** Exact physical-to-logical joins identify these failures without mislabeling a failed serving account; existing outer rescue behavior remains compatible.

### U2. Make semantic-stall diagnostics actionable without changing recovery authority

**Goal:** Distinguish upstream no-usable-output from translation defects and cancellation.

**Requirements:** R1–R4, R12, R13; AE1, AE2, AE3.

**Dependencies:** U1 for basic diagnostics. The natural-cohort comparison in Approach 3 additionally requires U7 qualification; U7 does not block basic observation. Any changed recovery policy additionally requires G2.

**Files:** packages/proxy/src/anthropic-semantic-preflight.ts; packages/proxy/src/anthropic-precommit-rescue.ts; packages/proxy/src/anthropic-sse-frame-classifier.ts; packages/proxy/src/handlers/proxy-operations.ts; packages/providers/src/providers/codex/provider.ts. Tests: packages/proxy/src/__tests__/anthropic-semantic-preflight.test.ts; packages/proxy/src/__tests__/anthropic-precommit-rescue.test.ts; packages/proxy/src/__tests__/proxy-anthropic-semantic-failover.test.ts; packages/providers/src/providers/codex/provider.stream-bounds.test.ts; packages/proxy/src/handlers/__tests__/proxy-operations-codex-websocket.test.ts.

**Approach:**

1. Join raw fixed categories to transformed meaningful-frame counters through KTD2.
2. Add bounded completion/cancellation and budget evidence at the terminal arbiter, retaining first-attempt observations.
3. Compare exact natural stalled attempts with structurally matched successful attempts under U7 qualification.
4. Keep recovery behavior unchanged until a separate tested policy proves a benefit within R4.

**Patterns:** Schema-22 stream diagnostics and deferred-reasoning bounds; existing semantic preflight/rescue.

**Test scenarios:**

1. Encrypted-only or signature-only frames refresh protocol activity but never extend meaningful-progress deadline.
2. Raw visible event with zero meaningful output is classified as a translation/gating candidate.
3. One rescue consumes remaining shared budget; cleanup and another candidate cannot reset accepted deadline.
4. Caller abort, semantic deadline, provider cancellation, and maintenance retirement retain distinct causes.
5. Written WebSocket or hosted dispatch forbids replay even without usable output.
6. Cap failure remains authoritative when cancellation arrives later.

**Verification:** The diagnostic tree classifies fixtures with one terminal and bounded cleanup. No outcome claims to identify productive thinking from encrypted counts alone.

### U3. Own singleton maintenance worker and compiled URL lifecycle

**Goal:** Close the confirmed worker churn and compiled object-URL ownership gap.

**Requirements:** R5, R6, R14; AE4.

**Dependencies:** G0, G1, and fresh PR #269 overlap review. Ready to begin.

**Files:** packages/database/src/database-operations.ts; packages/database/src/incremental-vacuum-worker.ts; apps/server/src/server.ts. Tests: packages/database/src/__tests__/optimize-async.test.ts; packages/proxy/src/__tests__/usage-collector-lifecycle.test.ts where disposal ordering crosses finalization.

**Approach:**

1. Reconcile PR #269 against current worker and shutdown paths.
2. Give each database owner one serialized maintenance lifecycle under KTD3.
3. Charge and retire worker/URL creation explicitly, including failed spawn, worker fault, cancellation, and shutdown.
4. Dispose maintenance before DB close; replacement cannot overlap active job ownership.

**Patterns:** Async writer disposal and existing worker job response conventions. Generated inline worker files remain excluded.

**Execution note:** Write lifecycle balance tests before changing worker reuse.

**Test scenarios:**

1. Repeated minute ticks and concurrent calls use one worker and serialize jobs.
2. Failed creation revokes its URL and leaves no active worker lease.
3. Worker error settles pending callers once and permits only one fenced replacement.
4. Shutdown rejects new jobs and retires worker and URL once before database close.
5. Source and compiled build modes satisfy the same lifecycle contract.
6. SQLite busy job and disposal stay bounded without closing the database under a live owner.

**Verification:** Worker/URL acquired-minus-retired balances return to the declared baseline. Report the ownership repair without claiming it explains the production 4 GiB incidents.

### U4. Diagnose resource retention and repair only the proved owner

**Goal:** Establish a causal memory mechanism and remove its retention path.

**Requirements:** R5, R6, R8, R13; AE4.

**Dependencies:** U3 establishes the maintenance control. Diagnostic work starts before causal repair; G2 gates the repair.

**Files:** packages/core/src/memory-monitor.ts; apps/server/src/server.ts; apps/server/src/body-admission.ts; packages/proxy/src/request-body-context.ts; packages/proxy/src/usage-collector.ts; packages/database/src/async-writer.ts; bench/proxy-request-memory-harness.ts; bench/fixtures/proxy-request-memory-upstream.ts. The causal fix touches only the demonstrated owner. Tests: apps/server/src/body-admission.test.ts; packages/providers/src/utils/__tests__/stream-drain.test.ts; packages/proxy/src/__tests__/usage-collector-lifecycle.test.ts; packages/proxy/src/__tests__/cache-body-store.test.ts.

**Approach:**

1. Add cheap fixed owner gauges and retirement balances under KTD4.
2. Compare maintenance-only, equal-body waves, rewrite/retry, slow-reader/cancellation, deferred reasoning, and writer-busy controls within the offline envelope.
3. Separate live-owner growth from native growth and allocator high-water using post-quiet matched phases.
4. Land the smallest owner-specific repair only after its failing causal fixture exists.

**Patterns:** Exact-response fetch ownership, bounded pending-read settlement, payload queued/in-flight charge, deferred-reasoning caps.

**Test scenarios:**

1. Equal 2 MiB waves with one 8 MiB peak distinguish post-quiet retention from peak allocation.
2. Idle SQLite maintenance versus idle control measures worker/URL balances independently.
3. Abort before headers, during body, precommit, retry, and drain returns owned counters to baseline once.
4. Uncooperative read consumes a finite settlement grace; sibling clones retain their own abort authority.
5. Promoted cache bodies retain their independent byte lease after request admission release.
6. Delayed writer/SQLITE_BUSY job remains charged through final settlement and shutdown.
7. Resource cap termination preserves the last complete phase and never claims successful workload/process exit.

**Verification:** The selected causal fixture fails before and passes after repair, without regression in terminal, aliasing, or disposal contracts. If no mechanism is reproduced, return the bounded diagnostic result and keep causal repair gated.

### U5. Add verified backend-only deployment transaction with retained ingress

**Goal:** Remove full-build listener interruption while preserving one active backend authority.

**Requirements:** R3, R5, R7, R8, R14; AE4.

**Dependencies:** U3, G3a, G3, G5. Design-gated: settle the timing contract before transaction implementation. Coordinate PR #404 server integration.

**Files:** scripts/ccflare-guard.mjs; scripts/ccflare-guard-policy.mjs; scripts/run-ccflare-stack.sh; scripts/deploy-ccflare.sh; scripts/deploy-ccflare-lib.sh; apps/server/src/server.ts; docs/deployment.md; CONCEPTS.md. Tests: scripts/__tests__/ccflare-guard-handoff.test.ts; scripts/__tests__/run-ccflare-stack.test.ts; scripts/__tests__/deploy-ccflare.test.ts; scripts/__tests__/ccflare-guard-policy.test.ts; apps/server/src/body-admission-server.test.ts.

**Approach:**

1. Resolve G3a first: choose the trusted timing authority and a versioned authenticated acceptedAt/deadline handoff, with exact defaults and post-commit expiry. Strip untrusted caller timing metadata; a caller may request a narrower budget but cannot extend a policy cap. Preserve existing stage caps and backend rescue policy until compatibility is proved, then extend generation authentication to the KTD5 candidate transaction.
2. Preserve one DB/routing owner, queued-request deadline origin, and ownership of old streams.
3. Align application drain/finalization budgets with supervisor retirement.
4. Expose accepted, queued, dispatched, expired, naturally completed, and forced outcomes separately.
5. Update the glossary distinction between terminal full-service shutdown and retained-ingress replacement.

**Execution note:** Prove the crash state machine with local processes before full-stack rehearsal.

**Test scenarios:**

1. Candidate with wrong manifest, hash, SHA, PID/start, listener, nonce, or compatibility is rejected.
2. Stale or replayed control command cannot attach or unfence a generation.
3. Crash at each durable phase reconciles to at most one authority and an exact pin.
4. Old process not reaped prevents candidate database ownership.
5. Queue upload, byte reservation, auth, quota, and dispatch use remaining accepted deadline; expiry sends no provider request.
6. Existing stream finishes naturally; cutoff produces a classified forced retirement without replay.
7. Failure before commit restores a compatible previous pin only after candidate reaping.
8. Irreversible migration or identity ambiguity holds dispatch and reports operator action.
9. Cold startup shows listener continuity and a measured dispatch pause.
10. Mixed ingress/backend source identities are reported and validated explicitly.
11. Forged timing metadata, old contract versions, post-commit expiry, and queue-to-backend clock transfer cannot reset a deadline. Exact default fixtures demonstrate which existing stage behavior is retained and identify any intended change before release.

**Verification:** Disposable rehearsal proves single ownership, bounded queue/cancel behavior, immutable identity, and schema-safe recovery. No claim of zero dispatch or completion pause.

### U6. Prove the authority/executor boundary before generation overlap

**Goal:** Determine whether stateless inference executors can overlap safely without duplicating mutable authority.

**Requirements:** R3–R8, R12–R14.

**Dependencies:** U1, U3, U5, G4, G5, and a demonstrated continuous-dispatch need. Conditional, not an automatic overhaul.

**Files:** Inventory existing owners in packages/proxy/src/handlers/routing-attempt-ledger.ts; packages/proxy/src/handlers/quality-route-admission.ts; packages/proxy/src/session-governor.ts; packages/proxy/src/cache-affinity-orderer.ts; packages/proxy/src/codex-websocket-transport.ts; packages/proxy/src/usage-collector.ts; packages/database/src/database-operations.ts; apps/server/src/server.ts. Boundary proposal: packages/proxy/src/executor-authority-contract.ts and docs/routing-architecture.md. Tests proposed: packages/proxy/src/__tests__/executor-authority-contract.test.ts and scripts/__tests__/executor-generation-overlap.test.ts.

**Approach:**

1. Inventory every mutable owner: selection, homes, quotas, OAuth refresh/pollers, circuits, session election, affinity, cache state, dispatch fences, usage writes, and maintenance.
2. Design authenticated, versioned immutable attempt commands and authenticated receipts/settlement under KTD6. Bind each command to authority epoch, executor generation, attempt identity, intent revision, and dispatch fence; reject altered, stale, or replayed commands before provider send.
3. Keep global leases for request/body/queue/stream/retry/worker/memory resources across generations. Current guard 256 MiB and backend 1 GiB admission budgets cannot be multiplied per executor; body charges remain estimates distinct from RSS.
4. Prototype with disposable mocks only after the inventory has no unresolved owner. Adopt or reject extraction based on safety and measured overhead.

**Test scenarios:**

1. Two executor generations consume one global budget; combined admission cannot double a limit.
2. Duplicate command, lost receipt, ambiguous send, authority restart, and executor death never replay irreversible work.
3. Stale generation or intent revision cannot settle or commit a home.
4. Authority/control channel loss before send fails closed; loss after send preserves bounded stream ownership and durable uncertainty.
5. Old/new command versions negotiate compatibility without weakening capability tuples. Altered, unauthenticated, stale-epoch, wrong-generation, or replayed commands never reach the provider.
6. OAuth refresh, polling, DB writes, and maintenance occur only in the authority.
7. Executor retirement releases leases after settlement, including orphan reconciliation.
8. Schema migration and rollback preserve one owner and do not corrupt in-flight settlement.

**Verification:** The design has no mutable-owner gap, no duplicated cross-generation budget, and no unsafe resend path. If these fail, retain U5 as the delivered architecture and defer overlap with evidence.

### U7. Qualify cache observation through the existing bounded journal

**Goal:** Produce defensible cache cohorts before proposing optimization.

**Requirements:** R2, R9, R12, R13; AE5.

**Dependencies:** U1 attempt joins. Fresh overlap review with cache-parity workstream.

**Files:** packages/providers/src/providers/codex/cache-diagnostics.ts; packages/providers/src/providers/codex/cache-telemetry.ts; packages/providers/src/providers/codex/provider.ts; packages/proxy/src/codex-websocket-transport.ts; docs/plans/2026-08-20-0549-perf-openai-cache-parity-plan.md as reference. Tests: packages/providers/src/providers/codex/cache-diagnostics.test.ts; packages/providers/src/providers/codex/cache-telemetry.test.ts; packages/providers/src/providers/codex/cache-wire.test.ts; packages/providers/src/providers/codex/provider.affinity-headers.test.ts; packages/proxy/src/codex-websocket-wire.test.ts; packages/proxy/src/__tests__/cache-telemetry.test.ts.

**Approach:**

1. Extend the existing opt-in diagnostics/journal under KTD7 where concrete missing dimensions prevent qualification.
2. Separate prepared, physical dispatch, terminal, and prior-completed-attempt gaps.
3. Qualify account, physical model, key, instructions, tools, effort, parameters, client/build epoch, transport, capability revision, and exact preserved input prefix.
4. Reconcile digest/key epochs and emit aggregate cohort support, coverage gaps, truncation, and context/idle bands.

**Patterns:** Final-wire observeUpstream seam; keyed structural fingerprints; bounded codex.cache_event.v1 serialization.

**Test scenarios:**

1. Similar size without exact preserved prefix stays unqualified.
2. Changed tools, instructions, effort, physical lane, or digest epoch excludes a strict comparison.
3. Missing native writes stay null; upstream residency remains unknown.
4. Physical inclusive input and logical additive usage reconcile only for matched populations.
5. Hashing, item, TTL, file, and dropped-event limits remain bounded with explicit coverage.
6. Failed observation cannot alter inference result, request body, affinity decision, or dispatch.
7. Native HTTP and WebSocket fixtures report physical transport separately from response SSE mode.

**Verification:** Candidate Astra misses receive a qualified or unknown verdict with support counts. Sustained parity uses its existing seven-day contract; warning absence or short-window recovery is insufficient.

### U8. Classify xAI count helper support before dispatch

**Goal:** Eliminate unsupported xAI count endpoint sends while preserving exact provider intent.

**Requirements:** R4, R10–R12; AE3, AE6.

**Dependencies:** G0 and coordination with count/session-attribution and provider-server-tools work.

**Files:** packages/providers/src/providers/xai/provider.ts; packages/providers/src/providers/openai/provider.ts; packages/providers/src/provider-attempt-plan.ts where path classification is owned; packages/proxy/src/handlers/proxy-operations.ts; packages/providers/src/server-tool-capabilities.ts as authority reference. Tests: packages/providers/src/providers/xai/provider.test.ts; packages/proxy/src/handlers/__tests__/proxy-operations-count-tokens.test.ts; packages/proxy/src/server-tool-routing-errors.test.ts; packages/proxy/src/__tests__/server-tool-routing.integration.test.ts.

**Approach:**

1. Represent count support in the provider-owned path contract under KTD8.
2. Return xAI unsupported before credentials, upstream send, hosted admission, and capacity/circuit accounting.
3. Keep helper syntax validation bounded; a count helper containing hosted declarations does not execute them.
4. Preserve server-tool fail-closed behavior and reuse the existing implementation workstream.

**Test scenarios:**

1. Covers AE6. Exact xAI count request has zero sends/refreshes/capacity penalties and a typed unsupported result.
2. Covers AE3. Forced xAI request cannot count through another provider.
3. Count helper with hosted declaration is classified independently from hosted execution.
4. Generation request with missing exact server-tool tuple retains intentional rejection.
5. Native/local-advisory/unsupported/unknown contracts remain distinct; estimates cannot prove context or entitlement.
6. Unknown path fails safely without arbitrary URL forwarding or an invented supported endpoint.

**Verification:** Local fixtures reproduce the old passthrough and prove it is blocked; no live provider probe is required.

---

## Verification Contract

This plan executed no tests, builds, fixtures, or provider probes. Future implementation follows the gates below.

| Scope | Repository checks | Done signal |
|---|---|---|
| Every code-bearing unit | bun run lint; bun run typecheck; bun run format; affected isolated bun test suites | Required checks pass on the exact reviewed head |
| Shared facade/worker signature | Inspect test call sites and execute affected suites, including PostgreSQL fixtures when applicable | Root typecheck exclusions cannot hide stale test callers |
| Database imports in a fresh worktree | Repository build prerequisite creates ignored workers before relevant suites | Generated files remain excluded from reads/edits/commits |
| U1/U2 | Named proxy terminal, semantic, rescue, usage, WebSocket and provider bounds fixtures | Exact identity/cause, one final, finite budget, no unsafe replay |
| U3/U4 | Named maintenance and resource fixtures within bounded offline contract | Retirement balance and causal fixture evidence; no RSS-only verdict |
| U5/U6 | Named lifecycle/transaction/authority fixtures and disposable rehearsal | Identity and single authority survive every failure phase |
| U7/U8 | Named cache/wire/capability/count fixtures | Bounded truth, unknown semantics, zero unsupported sends |
| Production | Later authorized exact-pin deployment and passive natural-traffic cohorts | No inference failure attributable to the patch; unobserved paths named |

Root package scripts have no release:validate command. Do not invent one. The repository excludes tests from the root TypeScript check.

### Rollout and Rollback Criteria

U1 and U3 can release independently. U4's diagnostic gauges land before its causal repair. U5 releases only after its timing contract is settled and local transaction and disposable stack proofs pass. U6 cannot piggyback on U5 readiness.

Before rollout, confirm fresh main ancestry, current overlapping PR hunks, reviewed source/hash artifacts, immutable pin identity, compatible DB schema, and cleanup budgets. Keep previous reviewed artifacts available. Any diagnostic enablement is a separately authorized bounded configuration action.

Observe natural traffic with generation-specific denominators for terminal coverage, semantic stalls, worker/URL balance, owner gauges, RSS+swap slopes, dispatch pause, admission/queue expiry, forced requests, cache qualification, and helper sends. A green health check is insufficient.

Stop rollout on incorrect attempt attribution, repeated finalization, unsafe resend, capability/quota drift, resource budget multiplication, listener identity mismatch, schema incompatibility, or new ownership imbalance. Roll back only when the transaction proves candidate reaped and previous schema/data compatibility. Otherwise hold dispatch and use reviewed rollforward or operator intervention.

### Research Questions

| Question | Disposition | Required resolution |
|---|---|---|
| Which timing authority/defaults preserve current stage behavior while bounding accepted requests? | Deferred; blocks U5 transaction implementation, not U1/U3 | Authenticated versioned timing contract, exact default fixtures, and post-commit expiry proof under G3a |
| Why did ten Sol attempts produce only encrypted reasoning? | Deferred; blocks new recovery behavior, not U1/U2 observation | Joined structural natural cohorts and discriminating offline translation fixtures |
| What caused production RSS+swap growth? | Deferred; blocks U4 causal patch | Matched bounded ownership/native/JSC evidence and failing fixture |
| Does continuous dispatch justify central authority extraction? | Deferred; blocks U6 adoption | Owner inventory, failure proof, global budget proof, measured overhead and operational need |
| Can a future xAI estimator satisfy caller expectations? | Deferred follow-up policy | Explicit advisory contract; no context/entitlement accuracy claims |
| What guard upgrade design preserves established connections? | Deferred follow-up | Stable listener plus accepted stream ownership and one admission authority |

---

## Definition of Done

The architecture work is complete only when the implemented units satisfy their traced requirements and proof gates, required repository checks pass, and approved releases have exact artifact evidence. Research-dependent mechanisms remain explicit gates until established.

- U1 preserves truthful attempted/serving/terminal identity with first-writer semantics.
- U2 distinguishes stall classes without widening recovery authority.
- U3 has one maintenance owner and balanced worker/URL retirement.
- U4 produces a causal repair with its reproducer, or a bounded diagnostic result that keeps repair deferred.
- U5 survives candidate/crash/rollback faults with one backend authority and measured acceptance/dispatch/completion.
- U6 is adopted only after all authority and budget proofs; a documented evidence-based rejection leaves U5 intact.
- U7 produces qualified cache cohorts and reports unknown/partial evidence honestly.
- U8 sends no unsupported xAI count request and preserves hosted-tool capability rejection.
- Abandoned experiments and dead-end code are removed from delivered diffs. No generated files, credentials, raw payloads, or unrelated work enter commits.

---

## Appendix

### Sources and Research

Aggregate evidence bundle ccflare-traffic-audit-20260930: REPORT.md; reliability.json; cache.json; lifecycle.json; architecture-stalls.json; architecture-lifecycle.json; architecture-cache-capabilities.json. These are operator-local dated aggregates, not portable repository dependencies. The evidence register carries their load-bearing facts.

Repository grounding:

- CONCEPTS.md: force route, commit-bound routing, logical/physical models, logical-final/physical-attempt usage, memory recycle, managed pin.
- docs/solutions/performance-issues/codex-deferred-reasoning-bounds-and-stall-diagnostics.md: preserve shipped bounded reasoning and fixed event categories.
- docs/solutions/performance-issues/stream-reader-deadline-settlement-before-lock-release.md: preserve exact-owner abort and bounded read settlement.
- docs/solutions/integration-issues/codex-cache-affinity-needs-session-id-header.md: preserve existing affinity contract; residual misses do not prove new granularity.
- docs/solutions/performance-issues/rss-watchdog-blind-to-swap-evicted-memory.md: RSS+swap containment is already implemented.
- docs/solutions/workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md: validate settlement ordering on the pinned runtime.
- docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md: run real affected suites.
- docs/plans/2026-08-20-0549-perf-openai-cache-parity-plan.md: sustained parity criteria.
- docs/plans/2026-07-29-001-fix-provider-server-tool-capability-architecture-plan.md: existing hosted-tool workstream.
