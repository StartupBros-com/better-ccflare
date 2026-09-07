---
title: "Dynamic Model Capacity Scheduler - Plan"
type: fix
date: 2026-07-16
topic: dynamic-model-capacity-scheduler
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
planning_base_sha: d7cc26c5
observed_runtime_sha: 2c5a3fbd
depends_on: 2026-07-16-001-fix-routing-reliability-plan
deepened: 2026-07-16
---

# Dynamic Model Capacity Scheduler - Plan

## Goal Capsule

- **Objective:** Route every request through the best eligible account/model lane so one exhausted model family cannot disable unrelated models on the same account, while configured priority, quota harvesting, active load, affinity, and fallback remain coherent.
- **Product authority:** The Product Contract below, synthesized from the July 16 production incident, the user's requirement to run Fable and Opus concurrently, the completed routing-reliability plan's intended invariants, current repository seams, and live runtime evidence.
- **Execution profile:** Test-first, four focused forward-fix PRs plus one observability PR. The change centralizes candidate construction and capacity decisions instead of adding another special-case Fable router.
- **Safety boundary:** Never generate scripted traffic against Anthropic or a Codex account. Use pure fixtures, fake upstreams, and explicitly force-routed non-Anthropic accounts; reserve real Claude/Codex traffic for operator-driven dogfooding.
- **Stop conditions:** Stop if a change lets affinity, utilization, or load cross a configured priority tier; separates an account from its concrete model or combo slot; converts stale evidence into a scoped exclusion; adds an in-proxy wait; or causes the guard to retry any response other than explicit whole-pool exhaustion.
- **Open blockers:** No product-design blocker. The prior reliability plan is completed work. There is one provenance gate because the checkout, remote main, and live service inspected during planning do not yet expose that completed implementation: resolve this worktree and deployment to its actual integration SHA before U1. If the required contracts are absent, stop and locate the correct branch/build; never recreate plan 001 inside this plan.

## Product Contract

### Summary

Ship one model-aware route planner with five properties:

1. Hard capacity is always-on and evaluated per atomic account/model attempt, independent of optional predictive pacing.
2. Numeric priority is lexicographically stronger than quota urgency, active load, and affinity; lower tiers remain immediate fallbacks for only the lanes that need them.
3. Direct failures are recorded at the narrowest positively proven scope. A Fable-only limit never writes the account-wide cooldown that also removes Opus.
4. Normal, combo, forced, and configured-model-fallback routes use the same candidate and capacity semantics.
5. Model-pool exhaustion, whole-pool exhaustion, and deterministic route unavailability are distinct terminal contracts; only whole-pool exhaustion is guard-retryable.

### Problem Frame

The live incident demonstrated a cross-model poisoning path:

- max-tertiary-will still had account-wide weekly headroom and successfully served Opus/Sonnet.
- Its Fable weekly scoped limit was at 100%.
- Fable requests reached upstream because hard usage eligibility is currently coupled to optional pacing flags, which were disabled.
- Headerless Fable 429 responses missed the exact out_of_credits special case and entered model_fallback_429.
- model_fallback_429 writes rate_limited_until, which is account-wide, so Opus became unavailable until the Fable reset.
- The host-local guard then treated the resulting errors as broadly retryable and held requests for up to 30 minutes.

Enabling weekly throttling is not the fix. That feature performs linear pacing below 100%; it would delay accounts that still have usable Fable capacity and conflicts with the user's consume-prioritized-capacity objective.

The implementation is fragmented today:

- Account strategies order accounts before request-model capacity is considered.
- Model usage filtering runs afterward in packages/proxy/src/proxy.ts.
- Combo accounts and model overrides travel in parallel positional structures.
- Exact model/beta depletion uses a bounded reactive marker, while generic 429s still use a global cooldown.
- Session affinity is keyed only by client session, so different model lanes can share one owner.
- There is no true in-flight attempt count; a 500 ms recent-pick penalty is the only burst-spreading signal.
- The existing pool terminal cannot distinguish a recoverable global cooldown from manual-pause-only or model-only exhaustion.

The desired state is dynamic, not a static mapping such as Fable to one named account and Opus to another. If account A is the best configured priority and has Fable at 100% but Opus available, Fable should spill to the next usable priority while Opus keeps consuming A. When A's Fable window resets, Fable should automatically snap back.

### Completed-Baseline Reconciliation Gate

The prior routing-reliability plan remains closed scope and supplies required invariants:

- priority is the outer ordering rule;
- same-tier affinity has legal snapback and anti-thrash;
- combo slot/account/model identity remains atomic;
- force-route is fail-closed;
- abandoned response bodies are released before failover;
- the source-controlled guard retries only explicit whole-pool exhaustion.

This plan makes one explicit forward refinement to that completed contract: plan 001 R9/AE4a forwarded a recognized final native-xAI capacity 402 intact. Because that raw 402 can still terminate a client conversation, a recognized capacity 402 now enters this plan's outcome ledger even on the final or forced candidate. Ordinary routing fails over or returns the classified terminal; force-routing returns force_route_unavailable with recovery metadata. Opaque/non-capacity and generic OpenAI-compatible 402 responses retain the prior raw-forwarding boundary.

At planning time, remote main was d7cc26c5, whose only change after deployed 2c5a3fbd was the prior plan document. Production still reported 2c5a3fbd, and the live guard still retried 429, 529, and broad 5xx for up to 30 minutes. Only the first SSE implementation slice was visible on a local unmerged branch.

Before U1 begins:

1. Name the final merged commit or integration branch that contains the prior plan's outputs.
2. Verify the source-controlled guard, priority/affinity, force-route, and combo invariants on that code.
3. Resolve the worktree to that already-completed SHA, rebase this work on it, and update only stale file pointers in this plan.
4. Verify that exact completed binary/guard pair is deployed before U2 or any later behavior-bearing slice. If it is missing, locate the correct artifact rather than reimplementing, cherry-picking guesses, or reopening plan 001.

### Actors

- **A1. Operator:** Configures accounts, numeric priorities, strategy, combos, model mappings, pacing flags, and deployment.
- **A2. Agent client:** Runs concurrent, long-lived Fable, Opus, Sonnet, Haiku, Codex, or compatible requests and expects recoverable, coherent terminal behavior.
- **A3. Route planner:** Resolves the effective model, builds atomic attempts, evaluates hard capacity, chooses a priority tier, and applies within-tier policy.
- **A4. Attempt executor:** Acquires an active-load lease, calls one upstream attempt, classifies the response, and settles the lease/body exactly once.
- **A5. Usage subsystem:** Supplies timestamped provider snapshots and bounded direct-evidence markers.
- **A6. Guard:** Waits and retries only when the proxy proves that the whole account pool is temporarily unavailable.

### Key Flows

#### F1. Concurrent Fable and Opus use different capacity lanes

- **Trigger:** Account A is priority 0 with Fable weekly scoped at 100% and account-wide weekly at 72%; account B is priority 1 with Fable at 56%.
- **Flow:** The planner removes only A/Fable, routes Fable through B, and independently retains A/Opus.
- **Terminal states:** Both requests complete; A's global cooldown remains null; each lane keeps its own affinity/load lifecycle.
- **Covered by:** R1-R10, R16-R18, AE1-AE2.

#### F2. Headerless scoped 429 fails over without poisoning the account

- **Trigger:** A pre-byte Anthropic 429 has no exact out_of_credits marker, but fresh usage proves the attempted family is at 100% while account-wide windows have headroom.
- **Flow:** The classifier records family-scoped direct evidence, discards the response body, and continues to the next eligible attempt.
- **Terminal states:** A sibling succeeds; or the route planner returns model_pool_exhausted after every matching lane is unavailable.
- **Covered by:** R19-R27, R32, AE3-AE6.

#### F3. Ambiguous or global capacity remains conservative

- **Trigger:** The response has a hard account-level header, an account-wide window at 100%, conflicting evidence, or no fresh matching scoped evidence.
- **Flow:** Existing account-wide cooldown semantics apply and the request fails over.
- **Terminal states:** A sibling succeeds or the proxy returns recoverable whole-pool exhaustion.
- **Covered by:** R19, R21-R25, R33, R35, AE4-AE5.

#### F4. Preferred priority tier spills and snaps back per lane

- **Trigger:** The best configured tier loses only one model lane.
- **Flow:** That lane uses the next eligible tier. Other lanes stay on the preferred tier. On reset or successful scoped recovery, the next request selects the preferred tier again.
- **Terminal states:** Temporary per-lane fallback or restored preferred service; no account-name rule and no manual re-enable.
- **Covered by:** R5, R9-R10, R17, R26-R27, AE2, AE9.

#### F5. Combo, force-route, and explicit model fallback preserve intent

- **Trigger:** A combo slot, forced account, or account-specific model fallback is configured.
- **Flow:** Each concrete account/model/slot attempt is evaluated atomically. Hard eligibility and effective configured priority order combo tiers; original slot order is stable inside a tier. Normal fallback re-enters the planner with the original effective request model. Force-route never substitutes another account.
- **Terminal states:** An eligible explicit attempt succeeds, the existing typed force_route_unavailable contract is returned for a forced failure, route_unavailable is returned for another deterministic no-route state, or ordinary fallback continues as configured.
- **Covered by:** R1-R2, R24, R29-R31, R34-R36, AE7-AE8, AE16, AE22.

#### F6. Streaming failure affects the next retry, not the bytes already sent

- **Trigger:** Scoped capacity evidence arrives after client-visible bytes.
- **Flow:** The current stream terminates once without replay. Proven scoped evidence records the matching marker, ambiguous evidence remains conservative, and the active lease settles on EOF/error/cancel. If the client sends a later request, it replans from current state.
- **Terminal states:** One client-visible terminal for the current attempt; a later request may succeed elsewhere without moving an unrelated model lane.
- **Covered by:** R15, R19-R28, R42, AE10, AE18.

#### F7. Exhaustion terminal is classified by why routing is empty

- **Trigger:** No attempt can serve the request.
- **Flow:** The planner distinguishes model-only exhaustion, temporally recoverable whole-pool exhaustion, and deterministic configuration/manual-pause unavailability.
- **Terminal states:** stable code model_pool_exhausted, existing pool_exhausted, or route_unavailable. Force-route failures retain their existing force_route_unavailable discriminator.
- **Covered by:** R32-R36, R42, AE11-AE12, AE14, AE17, AE20-AE21.

### Requirements

**Atomic route model and hard eligibility**

- **R1.** Every normal, combo, forced, and configured fallback attempt is represented as one immutable route candidate containing account identity, actual concrete model, canonical model family when known, beta/feature fingerprint, source, configured priority, stable base ordinal, and combo slot identity when applicable.
- **R2.** The account, concrete model, and combo slot never travel as separate reorderable arrays or account-ID-only sidecars.
- **R3.** Hard capacity eligibility is always evaluated, even when both predictive usage-throttling flags are false.
- **R4.** Account-wide session or weekly-all utilization at 100% excludes every lane on that account until a known reset or snapshot expiry permits recovery.
- **R5.** A matching weekly-scoped utilization at 100% excludes only attempts in that model family. An unrelated scoped cap never excludes the requested family.
- **R6.** Unknown or malformed scoped models fail open during proactive filtering; they must not become accidental all-model exclusions.
- **R7.** A reset known to be in the past cannot keep an account or lane excluded. A 100% snapshot without a reset is trusted only while the snapshot is fresh, after which one bounded recovery probe may be admitted.
- **R8.** Hard eligibility and optional predictive pacing share normalized usage-window parsing but remain separate decisions. Select the best hard-eligible priority tier before applying below-100 pacing. Pacing may delay candidates only inside that tier when enabled; if every candidate there is soft-paced, return the existing pacing 529 instead of promoting a lower tier. Lower tiers become eligible only after hard unavailability or an actual failed attempt.

**Priority, quota harvesting, load, and affinity**

- **R9.** Lowest numeric configured priority is the outer scheduling invariant after hard eligibility. No quota, pacing, load, recency, or affinity signal may promote a lower-priority account while any hard-eligible candidate in the requested lane or an explicitly configured account-local fallback chain exists in a better tier.
- **R10.** Lower tiers remain ordered reactive fallbacks. Exhausting Fable on a better tier does not remove its Opus lane and does not overwrite the better-tier owner needed for snapback.
- **R11.** Within the best eligible tier, compare quota pressure only from fresh subscription windows relevant to the requested model and sharing provider, billing/plan class, and selected weekly-window kind. Use the matching weekly-scoped window when present, otherwise the account-wide weekly window. Do not use the routinely sooner five-hour reset as the expiring-weekly-value comparator.
- **R12.** Required burn rate is `(100 - utilizationPct) / remainingHours` in percentage points per hour for a future reset. Rank higher bands first using these fixed boundaries: critical `>=4`, urgent `[2,4)`, hot `[1,2)`, warm `[0.5,1)`, steady `[0.25,0.5)`, and cold `[0,0.25)`. A hard-exhausted lane never reaches ranking. Ranking changes only on a band crossing; the prior plan's five-minute anti-thrash applies only after a failed better-tier snapback, not to ordinary pressure updates.
- **R13.** When snapshots are missing, stale, from incomparable provider/plan shapes, or tied in the same pressure band, the planner falls through to active load and the configured strategy instead of inventing numeric precision.
- **R14.** A process-local active-attempt lease is acquired synchronously immediately before a real upstream attempt. Same-tier new/unowned sessions and fallback peers can use active lease counts; an eligible session-affinity owner stays first inside its current tier and pressure band. Least-used applies active leases on every selection. In-place retries retain one lease, and load may evict affinity only if a separately specified hard concurrency limit is introduced in a later plan.
- **R15.** A lease is released exactly once on pre-stream failover, ordinary response completion, stream EOF, stream error, client cancellation, timeout, or thrown exception. Local/synthetic count-token paths do not acquire a lease.
- **R16.** Keep two distinct keys. `affinityLaneKey` is computed before account selection from conversation identity, normalized protocol family, post-agent-rewrite requested model, and canonical client-visible beta/features. `attemptScopeKey` is computed per candidate from account, actual concrete attempted model/family, and canonical upstream-relevant beta/features. Fable and Opus cannot share an owner merely because they share a session; bounded feature components are hashed in telemetry.
- **R17.** Session affinity is valid only inside the best eligible priority tier and highest pressure band. An existing eligible owner leads inside that class; active leases rank only new/unowned sessions and fallback peers. Recovery to a better tier preempts lower-tier ownership, and an unavailable better-tier mapping is preserved for legal snapback. For combos, priority orders tiers and ordinary affinity never reorders original slots inside a tier.
- **R18.** Strategy semantics remain explicit: sequential/session mode may drain an eligible preferred account; least-used uses active leases on every selection; session-affinity keeps an eligible lane sticky inside its tier/pressure class. The planner supplies a deduplicated same-tier normal-route account view plus pressure/load facts, then maps strategy order back to stable candidate groups. It never replaces strategies with an opaque weighted score or collapses combo slots.

**Failure scope and reactive state**

- **R19.** One pure classifier runs before every account-wide cooldown decision for initial-model, configured-fallback, and pre-byte response paths.
- **R20.** Exact provider evidence for model/beta depletion is candidate-scoped and retains the existing bounded marker behavior.
- **R21.** A headerless Anthropic 429 is family-scoped only when fresh usage shows the actually attempted family at 100%, account-wide windows positively below 100%, and no live hard account-level response signal.
- **R22.** A live hard account-level header, account-wide utilization at 100%, stale/missing/conflicting evidence, or an unmapped attempted model remains conservatively account-scoped.
- **R23.** Freshness for reactive inference is at most two effective usage-poll intervals and never more than the cache's ten-minute maximum; the default 90-second poll therefore yields a 180-second evidence window.
- **R24.** Configured model fallback is attributed to the concrete model actually attempted, not the original request model. An explicitly configured account-local chain is operator intent and is exhausted in order before advancing to a lower account-priority tier; the scheduler never invents an unconfigured substitution.
- **R25.** Scoped failures never call the account-wide cooldown mutation. Account-scoped failures continue through the single existing cooldown helper and durable persistence path. A recognized native-xAI capacity 402 and any positively classified model/family capacity response enter the request outcome ledger even on the final candidate; they are not forwarded as raw capacity errors. Opaque/non-capacity and generic OpenAI-compatible final responses retain their existing raw contract.
- **R26.** Scoped markers are bounded per account, expire at the earliest of direct reset, matching scoped reset, or five minutes, and are not erased by an older in-flight usage poll. While one scoped recovery-probe lease is active, concurrent requests keep that lane excluded with `available_at` equal to the lease expiry; scoped suppression contributes only to model-pool exhaustion.
- **R27.** A success clears only the exact model/beta marker and any matching inferred family marker. Opus success cannot clear a Fable marker; Fable success cannot clear an unrelated beta-specific marker.
- **R28.** After client-visible bytes, never replay or fail over the current request. Classify with the actual attempted model and current evidence: exact or fresh positive evidence may record scoped state, while ambiguous overload/429/529 remains account-scoped. Record state only for a later request, and settle the stream/lease exactly once on EOF, error, or cancellation even if state mutation fails.

**Route parity and terminal contracts**

- **R29.** Combo filtering preserves slot identity, account, concrete override, effective configured priority, and original slot ordinal, including repeated-account slots with different models. Hard eligibility and effective priority (account priority or the existing explicit combo-slot override) select tiers first; original slot order is stable only within a tier. If all slots are unavailable, existing normal fallback semantics restart with the original effective request model and no stale combo metadata.
- **R30.** Force-route is one-account and fail-closed. Trusted internal refresh/probe traffic may use its existing explicit bypass; ordinary callers cannot bypass pause, global cooldown, or model-lane exhaustion. Forced failures, including a recognized direct capacity 402, preserve `error.type: force_route_unavailable` and `x-better-ccflare-force-route: unavailable`, may add lane reason/recovery metadata, never carry the whole-pool header, and are guard-forwarded once.
- **R31.** Applied post-agent-rewrite model drives normal routing. Combo override and account mapping then determine the concrete attempted model whose capacity and failures are evaluated.
- **R32.** model_pool_exhausted requires a non-empty compatible candidate set, at least one globally usable account, and capacity-derived exclusion of every candidate for the requested lane. Zero candidates, missing mappings, protocol incompatibility, and other deterministic filters cannot satisfy it. Return HTTP 503 with outer `type: error`, `error.type: service_unavailable`, stable `error.code: model_pool_exhausted`, effective model/family, nullable `next_available_at`, and bounded per-candidate reasons. `next_available_at` is the earliest future scoped reset, exact/family marker expiry, snapshot-freshness expiry, or scoped-probe lease expiry relevant to that requested lane; it is null when none is known, and past or unrelated resets are ignored. This fast terminal never emits `Retry-After` or `x-better-ccflare-pool-status: exhausted`.
- **R33.** Whole-pool exhaustion remains the existing typed pool_exhausted 503 with x-better-ccflare-pool-status: exhausted only when no compatible account is globally usable and at least one compatible account's complete blocker set will clear automatically at a finite time. Manual pause, auth failure, configuration, or protocol incompatibility disqualifies that account from automatic recovery. For one account, recovery is the latest expiry across all of its finite global blockers; pool recovery is the earliest such complete-account recovery.
- **R34.** Empty configuration, manual-pause-only pools, protocol incompatibility, and other non-forced deterministic no-route states return `error.type: service_unavailable` with stable `error.code: route_unavailable` and no whole-pool header. Invalid/unavailable force-route retains R30's existing discriminator instead of being relabeled.
- **R35.** Empty-route precedence is deterministic: (1) a non-empty compatible candidate set with at least one globally usable account and only capacity-derived requested-lane exclusions yields model_pool_exhausted; (2) otherwise, no globally usable compatible account plus at least one complete account that automatically recovers under R33 yields pool_exhausted; (3) otherwise yield route_unavailable. Zero candidates are always route_unavailable. Recovery-probe suppression uses the same scoped/global distinction. Existing authentication, context_length_exceeded, unclassified/non-capacity raw final-provider, and synthetic/count-token terminals bypass this classifier unchanged.
- **R36.** The guard forwards model_pool_exhausted, route_unavailable, force_route_unavailable, opaque/unclassified raw 402/429/529, and generic 5xx once. Only explicit pool_exhausted may consume a guard slot for bounded wait/retry. No proxy-internal sleep or sibling hold is added; capacity recovery is request-driven through fresh snapshots, scoped probe single-flight, and a later client request.

**Visibility and agent behavior**

- **R37.** Structured logs/event telemetry record the full bounded route decision: requested/applied/attempted model, lane/family, hashed beta/features, source/slot, configured tier, hard exclusion/reset/snapshot age, pressure band, active lease count, affinity result, classifier evidence, failure scope, and terminal code, without prompt bodies or tokens. Request history persists only concrete attempted model, existing status/reason fields, and failure scope where the current schema supports it; this plan adds no durable decision-JSON column.
- **R38.** Request-history reasons distinguish scoped model/family exhaustion from account-wide cooldown wherever representable; a scoped audit event never appears as an account-wide disabled state. Health/API/preview expose current derived state, not a reconstruction of every historical decision.
- **R39.** The accounts API and health detail derive per-family annotations from the same pure evaluator. Global readiness depends only on process health and account-global availability; one exhausted, unknown, or unlisted model family cannot mark the account or service globally down.
- **R40.** Route preview/Primary output becomes model-contextual or is replaced by per-family next-route summaries. Its dry-run comparator is the same comparator used by live selection and must not mutate affinity, leases, probes, or database state.
- **R41.** The accounts dashboard keeps the account enabled while showing scoped exhaustion, reset, and the next eligible tier. Unknown/legacy evidence renders safely.
- **R42.** A failed request is neither held nor replayed. If the client issues a later request with the same session identity, routing is recomputed from current state and is not pinned to the previously exhausted lane. Supported-client characterization must verify that the chosen 503 envelope does not tombstone the conversation; the proxy does not promise that every client will retry automatically.
- **R43.** Messages and relevant Responses-adapter paths preserve equivalent capacity semantics. Synthetic maintenance and count-token requests retain explicit, tested exemptions.

### Failure-Scope Decision Matrix

| Evidence | Proactive eligibility | Reactive failure scope | State mutation |
|---|---|---|---|
| Fresh matching weekly-scoped 100%, reset future | Exclude matching family only | Family when account-wide headroom is also proven | Bounded family marker |
| Exact out_of_credits signal | Exclude exact model/beta marker | Model/beta | Bounded exact marker |
| Fresh session or weekly-all 100% | Exclude whole account | Account | Existing global cooldown/cap state |
| Live hard account-level response header | Not applicable until response | Account, overrides cached scoped evidence | Existing global cooldown |
| Scoped 100% but account-wide evidence missing | Exclude known-doomed lane proactively | Account on ambiguous 429 | Conservative global cooldown |
| Stale, malformed, conflicting, or unmapped evidence | Fail open proactively | Account on 429 | Conservative global cooldown |
| Scoped recovery probe already active | Exclude only that scope until probe lease expires | Not applicable to suppressed request | Bounded scoped probe lease |
| Account-global recovery probe already active | Exclude account until probe lease expires | Not applicable to suppressed request | Existing global probe/cooldown state |
| Success on same exact lane | Eligible subject to fresh snapshot | Recovery | Clear only matching marker |
| Success on another family | No effect on exhausted lane | No recovery inference | Leave marker intact |

### Model-Pool Wire Contract

The model-only terminal has one exact envelope. Candidate summaries remain in planned order, are capped at 32 entries, and set `truncated: true` when more exclusions exist. Account IDs are local stable identifiers; raw provider bodies, tokens, prompts, and credentials are never included.

~~~json
{
  "type": "error",
  "error": {
    "type": "service_unavailable",
    "code": "model_pool_exhausted",
    "message": "No configured account can currently serve the requested model.",
    "model": "effective-request-model",
    "family": "normalized-family-or-null",
    "next_available_at": "future-ISO-timestamp-or-null",
    "candidates": [
      {
        "account_id": "stable-local-id",
        "attempted_model": "concrete-upstream-model",
        "scope": "model-or-family",
        "reason": "stable-reason-code",
        "available_at": "future-ISO-timestamp-or-null"
      }
    ],
    "truncated": false
  }
}
~~~

`next_available_at` is advisory for the operator/client. Omitting `Retry-After` is deliberate: model-only exhaustion is a prompt terminal, not permission for the guard or proxy to hold a request until a potentially distant reset.

### Acceptance Examples

- **AE1. Flags-off simultaneous routing**
  - **Given:** Both pacing flags are false. A is priority 0 with Fable 100%, weekly-all 72%; B is priority 1 with Fable 56%.
  - **When:** Fable and Opus requests arrive concurrently.
  - **Then:** Fable skips A and uses B; Opus uses A; A.rate_limited_until remains null.

- **AE2. Per-lane priority and snapback**
  - **Given:** A's Fable lane is exhausted but its Opus lane is healthy.
  - **When:** Fable falls to B and A's Fable reset later passes.
  - **Then:** The next Fable request returns to A automatically while existing Opus ownership was never displaced.

- **AE3. Headerless scoped 429**
  - **Given:** A Fable attempt returns headerless 429; a 120-second-old snapshot shows Fable 100% and weekly-all 72%.
  - **When:** The classifier runs.
  - **Then:** It records scoped evidence, does not call global cooldown, releases the body/lease, and attempts the next candidate.

- **AE4. Stale evidence stays conservative**
  - **Given:** The same response has a snapshot older than the computed freshness bound.
  - **When:** The classifier runs.
  - **Then:** It classifies account scope and preserves existing global cooldown behavior.

- **AE5. Global cap wins**
  - **Given:** Matching scoped utilization and weekly-all are both 100%, or the live response carries a hard account-level signal.
  - **When:** A request is planned or a 429 is classified.
  - **Then:** Every lane on that account is unavailable; no scoped-only exception is applied.

- **AE6. Actual fallback attribution**
  - **Given:** An account maps the request to concrete models M1 then M2; M2 returns 429.
  - **When:** Direct evidence is recorded.
  - **Then:** M2's lane receives the marker/audit attribution; M1 and the original alias are not mislabeled.

- **AE7. Duplicate-account combo slots**
  - **Given:** One combo contains slot S1=(A,Fable), S2=(A,Opus), and S3=(B,Fable).
  - **When:** A/Fable is exhausted.
  - **Then:** S1 is removed, S2 remains A/Opus, S3 remains B/Fable, and no reorder detaches a model from its slot.

- **AE8. Force-route is lane-aware and fail-closed**
  - **Given:** A is explicitly forced.
  - **When:** A/Fable is exhausted but A/Opus is usable.
  - **Then:** Forced Fable returns `force_route_unavailable` with the force-route header and a lane-specific reason; forced Opus may proceed; neither request silently selects B or emits the pool header.

- **AE9. Same-tier burst and quota harvesting**
  - **Given:** Same-priority comparable accounts have different weekly reset pressure and active leases.
  - **When:** New sessions arrive concurrently.
  - **Then:** Higher quota-waste pressure leads; active leases spread new/unowned sessions and fallback peers inside the same pressure band; an existing eligible session-affinity owner remains first; deterministic ties do not oscillate.

- **AE10. Midstream scoped failure**
  - **Given:** A Fable stream has emitted client bytes before scoped failure evidence arrives.
  - **When:** The stream terminates.
  - **Then:** The request is not replayed, the lease releases once, the next Fable retry uses a backup, and simultaneous Opus remains eligible on A.

- **AE11. Three terminal classes**
  - **Given:** Three separate fixtures: all Fable lanes exhausted; all accounts globally cooled with a future reset and no manual/auth/config blocker; all accounts manually paused, including one with an earlier cooldown expiry.
  - **When:** Each request is planned.
  - **Then:** They return `error.code: model_pool_exhausted` without Retry-After or the pool header, existing `error.type: pool_exhausted` with the pool header, and `error.code: route_unavailable` without the pool header, respectively.

- **AE12. Guard forwarding**
  - **Given:** The fake upstream returns each of the three terminal classes.
  - **When:** Requests pass through the guard.
  - **Then:** Only pool_exhausted is retried; the other two are forwarded after one proxy attempt with no slot hold.

- **AE13. Poll/direct-evidence race**
  - **Given:** An older usage poll is in flight when direct scoped failure is recorded.
  - **When:** That poll completes.
  - **Then:** It cannot clear the newer marker; only expiry, matching success, or explicit reset recovery can.

- **AE14. Same chat recovers**
  - **Given:** A session receives model_pool_exhausted.
  - **When:** Capacity later resets and the client sends another request with the same session identity.
  - **Then:** The planner re-evaluates and routes successfully; the proxy has stored no chat/session tombstone or exhausted-lane pin. A supported-client characterization separately proves that client can issue the later turn.

- **AE15. Pacing cannot cross priority**
  - **Given:** Pacing is enabled, every otherwise healthy priority-0 candidate is temporarily soft-paced, and priority 1 is healthy.
  - **When:** A request is planned.
  - **Then:** The proxy returns the existing pacing 529 for priority 0 and does not consume priority 1; with pacing disabled, the same priority-0 lane remains hard-eligible.

- **AE16. Explicit fallback stays inside account priority**
  - **Given:** Priority-0 account A explicitly maps Fable to M1 then Sonnet, while priority-1 account B can serve exact Fable.
  - **When:** A/M1 is unavailable but A/Sonnet is eligible.
  - **Then:** A/Sonnet is attempted before B/Fable because the configured chain is account-local operator intent; removing that explicit mapping causes B/Fable to be the next route.

- **AE17. Mixed scoped/global terminal precedence**
  - **Given:** A is globally usable but Fable-scoped exhausted, while B is globally cooled with a future reset.
  - **When:** Fable has no eligible attempt.
  - **Then:** The proxy returns model_pool_exhausted and the guard forwards once; B's global reset cannot relabel the mixed state as whole-pool exhaustion.

- **AE18. Ambiguous midstream failure stays conservative**
  - **Given:** A stream emitted bytes and then ends with ambiguous overload/429/529 evidence lacking fresh positive model scope.
  - **When:** The response lifecycle settles.
  - **Then:** The stream is never replayed, the lease releases even if state persistence fails, and any recorded cooldown is account-scoped. Exact or fresh positive scoped evidence in the paired fixture records only the attempted lane.

- **AE19. Discarded pre-pacing plan has no side effects**
  - **Given:** A side-effect-free plan is computed before a pacing wait and capacity changes during that wait.
  - **When:** Routing resumes.
  - **Then:** The stale plan is discarded without affinity, probe, or lease residue; a fresh plan is committed immediately before the real upstream fetch.

- **AE20. Recognized final capacity 402 is normalized**
  - **Given:** The only compatible, unpaused native-xAI account is the final ordinary candidate and returns a recognized capacity 402 that establishes a finite cooldown; a paired forced fixture does the same; a generic OpenAI-compatible fixture returns an opaque 402.
  - **When:** Each response is classified before client bytes.
  - **Then:** Ordinary native xAI persists global capacity state and returns pool_exhausted rather than raw 402; after cooldown recovery, a later same-session request replans. Forced native xAI returns force_route_unavailable with recovery metadata; the opaque generic response retains raw forwarding and the guard forwards it once.

- **AE21. Zero candidates and incomplete recovery stay deterministic**
  - **Given:** Separate fixtures have no configured candidate, a missing model mapping, protocol incompatibility, and a paused account whose cooldown expires soon.
  - **When:** Routing is empty.
  - **Then:** Every fixture returns route_unavailable without the pool header; a finite condition on an account that remains manually/auth/config blocked cannot create pool_exhausted.

- **AE22. Combo priority precedes slot order**
  - **Given:** Combo slot S1 has worse effective configured priority than later slot S2, while S2 and S3 share the better tier.
  - **When:** All three are hard-eligible.
  - **Then:** S2 and S3 run before S1, retain their original relative order inside the better tier, and every model override remains attached to its slot.

### Success Criteria

- The exact AE1 scenario passes with pacing disabled and no global cooldown mutation.
- All account selection paths consume atomic route candidates.
- Priority remains monotonic in normal, combo, fallback, affinity, and route-preview tests.
- Predictive pacing cannot bypass a healthy higher-priority tier, and explicit account-local fallback order is preserved before lower-tier spill.
- Existing eligible session owners remain stable inside their tier/pressure class while active leases spread new/unowned and fallback work.
- Scoped versus global classification is deterministic under fresh, stale, conflicting, fallback-model, and live-header evidence.
- Active lease counts return to zero across every terminal/cancellation path.
- Discarded pre-pacing and preview plans leave no affinity, probe, lease, or database state.
- The guard retries only explicit whole-pool exhaustion.
- Operators can explain a route from API/dashboard/log evidence without reading raw provider responses.
- No production validation sends automated Anthropic/Codex traffic.

### Scope Boundaries

**Now**

- Always-on hard account/model capacity.
- Atomic normal/combo/forced/fallback candidates.
- Requested-lane priority, quota pressure, active load, and affinity.
- Scoped reactive 429 classification and bounded recovery state.
- Three terminal contracts and guard parity.
- Per-family route visibility and agent-client recovery tests.

**Later**

- Historical-demand forecasting or token-volume prediction.
- Absolute plan-size normalization across unlike subscription tiers/providers.
- Distributed leases or durable shared scoped breakers for multiple proxy processes.
- Adaptive exploration of accounts with unknown usage.
- Operator-tunable scoring weights or per-project quality-of-service controls.
- A configurable combo fallback-to-default policy; this plan preserves current fallback semantics.

**Never / non-goals**

- Account-name rules such as routing Fable to secondary and Opus to tertiary.
- Silent model substitution outside explicit mappings/fallbacks/combos.
- Enabling predictive weekly pacing as a substitute for hard eligibility.
- Affinity, utilization, or load overriding configured priority.
- Treating stale ambiguous evidence as model-scoped.
- Proxy sleeps or guard replay after client-visible bytes.
- Reimplementation of the completed routing-reliability plan.

### Dependencies and Assumptions

- The prior plan's implementation SHA is identified and contains the priority, affinity, force-route, combo, body-release, and guard contracts described above.
- Usage polling remains refresh-backed with an effective interval available to the freshness policy.
- The proxy production topology remains one upstream process behind the guard. Process-local leases and scoped markers are sufficient for this slice; distributed coordination is deferred explicitly.
- Provider usage percentages are compared for quota pressure only when their source/window/plan shape is comparable.
- No schema migration is required. If implementation discovers a need for durable scoped state, stop and revise the plan because SQLite and PostgreSQL parity would become mandatory.

### Outstanding Questions

No product blocker remains. Implementation must record, not silently guess, if the prior plan's landed code exposes a different candidate/affinity seam than the one documented here. The invariant and acceptance examples stay authoritative; file placement may adapt to the actual integration SHA.

### Sources and Research

- User incident report and desired state: concurrent Fable/Opus, consume prioritized limits, no static account mapping.
- Current origin/main d7cc26c5 and live health at observed SHA 2c5a3fbd.
- packages/proxy/src/proxy.ts: post-selection usage throttling and generic pool terminal.
- packages/proxy/src/handlers/account-selector.ts: account-only selection, force route, combo positional metadata.
- packages/proxy/src/handlers/usage-throttling.ts: normalized windows and predictive pacing.
- packages/proxy/src/handlers/proxy-operations.ts: exact out_of_credits path, concrete fallback attempts, generic model_fallback_429 cooldown.
- packages/providers/src/usage-fetcher.ts: timestamped cache internals and bounded model/beta markers.
- packages/load-balancer/src/strategies/: priority, session, least-used, and affinity behavior.
- packages/http-api/src/handlers/health.ts and rate-limit-status.ts: current global health/display semantics.
- docs/plans/2026-07-16-001-fix-routing-reliability-plan.md: dependency invariants and guard contract.
- Divergent commits f127367f and 063f294b: useful positive-evidence family gating and reactive classification ideas, not cherry-pick candidates.
- Divergent commit e6008004: rejected in-proxy sibling hold.
- Historical FEFO work 8ffefcc8 and 8e6670c4: weekly-reset urgency lesson; rejected affinity/priority behavior.
- No CONCEPTS.md, STRATEGY.md, or docs/solutions corpus exists for this repository.
- External research was not used; current code, live runtime, and incident evidence are authoritative.

## Planning Contract

### High-Level Technical Design

This sketch is architectural, not implementation code. Names and file placement may adapt after the baseline reconciliation gate.

~~~mermaid
flowchart TD
  C["Agent request"] --> M["Resolve applied request model and lane key"]
  M --> X["Expand atomic attempts: normal, combo, forced, configured fallback"]
  X --> E["Evaluate always-on hard capacity from fresh snapshot and scoped markers"]
  E -->|"eligible attempts"| T["Choose lowest eligible configured priority tier"]
  T --> Q["Compare requested-lane weekly quota-pressure bands"]
  Q --> A["Apply configured strategy and eligible lane-specific owner"]
  A --> L["Use active leases for new/unowned and fallback peers"]
  L --> U["Commit fresh plan, acquire attempt lease, and call upstream"]
  U -->|"success"| S["Clear only matching scoped recovery state; settle lease"]
  U -->|"pre-byte scoped failure"| SF["Record scoped breaker; discard body; try next attempt"]
  U -->|"pre-byte account failure"| GF["Persist global cooldown; discard body; try next attempt"]
  U -->|"post-byte failure"| MS["Terminate once; record scope for next retry; settle stream lease"]
  SF --> E
  GF --> E
  E -->|"no eligible attempt"| Z{"Why is the route empty?"}
  Z -->|"model lanes only"| MP["503 model_pool_exhausted; no whole-pool header"]
  Z -->|"temporary global cooldowns"| PP["503 pool_exhausted; explicit whole-pool header"]
  Z -->|"manual/config deterministic"| RU["503 route_unavailable; no whole-pool header"]
  MP --> G["Guard forwards once"]
  RU --> G
  PP --> H["Guard bounded whole-pool wait/retry"]
~~~

### Key Technical Decisions

- **KTD1. Use one atomic route-candidate ledger.** The planner returns eligible attempts plus exclusions and their evidence. Parallel account/model arrays and WeakMap sidecars are rejected because filtering or affinity can desynchronize them.
- **KTD2. Separate hard eligibility from pacing.** Shared normalization avoids parser drift, but a 100% hard cap is correctness and always-on; below-100 linear pacing is optional policy.
- **KTD3. Scope proactive and reactive evidence differently.** A fresh scoped 100% snapshot is enough to avoid sending a known-doomed lane. Avoiding a global cooldown after a real 429 requires additional positive proof of account-wide headroom or an exact provider signal.
- **KTD4. Use lexicographic scheduling, not an opaque weighted score.** Hard eligibility, priority tier, comparable quota-pressure band, then the configured strategy's ownership/load policy make operator intent explainable. Session affinity keeps an eligible existing owner first inside the class; active leases spread only new/unowned and fallback peers. Least-used applies lease counts on every selection.
- **KTD5. Harvest the requested lane's weekly value.** Weekly-scoped reset/headroom is the first comparison, with weekly-all fallback. Five-hour reset is not used as the weekly-harvest key because it almost always expires sooner and would mask the value actually at risk.
- **KTD6. Separate owner identity from failure scope.** The pre-selection affinityLaneKey uses post-agent-rewrite client-visible request context. The per-attempt attemptScopeKey uses actual account/model/upstream features. Both are bounded and privacy-safe, but only the latter may drive capacity markers. Affinity cannot cross priority or pressure classes; ordinary quota updates rely on fixed pressure bands, while the inherited five-minute anti-thrash applies only to failed better-tier snapback.
- **KTD7. Add real active-attempt leases without token reservations.** Synchronous process-local counts address burst convergence. Predicting token cost or coordinating multiple processes is deferred until evidence justifies it.
- **KTD8. Direct evidence is a short bridge, not a second durable quota database.** Existing bounded markers generalize to model/beta and family scopes. Fresh provider snapshots enforce long windows; marker expiry/probe prevents permanent local lockout.
- **KTD9. Fail conservative when scope is ambiguous.** False account-wide cooldown is damaging, but falsely scoped global exhaustion can repeatedly hammer upstream. Scoped classification therefore requires positive, fresh, non-conflicting evidence.
- **KTD10. Preserve explicit fallback intent.** Account model arrays remain account-local order and are exhausted before the scheduler advances to a lower account-priority tier. Each concrete fallback is planned, evaluated, transported, and attributed as the same immutable candidate; no unconfigured substitution is invented.
- **KTD11. Distinguish empty-route wire contracts and precedence.** Model-only emptiness is HTTP 503 `service_unavailable` with code model_pool_exhausted, current model metadata, and no Retry-After/pool header. Existing pool_exhausted is reserved for an all-globally-unavailable compatible pool with at least one complete account that recovers automatically at a finite time. Non-forced deterministic or zero-candidate emptiness uses code route_unavailable; forced emptiness preserves force_route_unavailable. Recognized capacity 402 enters this classification instead of escaping raw. Only pool_exhausted is a guard wait contract.
- **KTD12. No in-proxy holding.** The abandoned sibling-hold experiment is rejected because missing/stale evidence made it wait and recreated stalled chats. The proxy decides and returns; the guard owns only bounded whole-pool waiting.
- **KTD13. Share evaluator and comparator with visibility.** Health, dashboard, and route preview must explain the same decision the live planner would make. Dry-run surfaces are side-effect-free.
- **KTD14. Agent lifecycle is a first-class verification boundary.** Once bytes are visible, no replay occurs. Proven scope changes only a later request's route. The proxy guarantees stateless replanning, while supported-client characterization—not assumption—proves the client can issue that later turn.
- **KTD15. Split planning from commitment.** Pre-pacing plans and U5 previews are pure snapshots. Only a fresh plan immediately before a real fetch may commit affinity, a recovery probe, or an active lease; discarded plans leave no state.
- **KTD16. Classify terminals from a request outcome ledger.** Initial exclusions and failures discovered during the same request share one bounded ledger. Empty-route classification sees the final scoped/global/deterministic reasons without rewriting raw final-provider, authentication, context, maintenance, or count-token responses.

### Scheduling Semantics

| Stage | Input | Output | May override prior stage? |
|---|---|---|---|
| Hard capacity | Account/model/beta attempt plus fresh evidence | Eligible or excluded with scope/reset | Not applicable |
| Configured priority | Eligible attempts | Lowest numeric tier plus ordered lower fallbacks | No later stage may cross it |
| Quota pressure | Comparable requested-lane weekly windows | Stable pressure bands | Cannot cross priority |
| Strategy owner | Existing eligible owner and strategy mode | Sticky owner first for session-affinity; no owner for new/fallback work | Cannot cross priority/pressure |
| Active load | Process-local leases | Spread new/unowned and fallback peers; every choice for least-used | Cannot evict an eligible session owner or cross prior stages |
| Stable tie | Base ordinal and stable identity | Deterministic complete order | No |

### Sequencing and PR Boundaries

0. **Completed-baseline gate:** Resolve the worktree/deployment to the already-landed plan-001 integration SHA and verify its contracts. If any are absent, stop and locate the correct branch/build rather than reimplementing old scope. The source-controlled narrow guard must be live before U2 or any later behavior-bearing slice.
1. **PR A — Capacity domain (U1):** Add pure normalized capacity/scope/freshness primitives and tests with no routing behavior change.
2. **PR B — Reactive isolation (U2):** Insert the pure scope classifier before global cooldown paths and generalize bounded scoped recovery state.
3. **PR C — Scheduler vertical slice (U3-U4):** Land atomic candidates, always-on proactive eligibility, priority/quota/load/affinity ordering, terminal classification, and guard parity together so no half-contract can deploy.
4. **PR D — Visibility parity (U5):** Expose per-lane decisions through API, health detail, request history, route preview, and dashboard.
5. **PR E — Integration hardening (U6):** Close cross-protocol/stream lifecycle gaps, run the full matrix, deploy from main, and dogfood.

Before every PR review, compute its merge base against current origin/main and inspect overlapping post-branch changes. Request routing, provider response handling, and the guard are high-churn surfaces.

### System-Wide Impact

- **Interfaces:** The internal selection result changes from account arrays plus sidecars to a route-plan/candidate ledger. The strategy receives only eligible same-tier peers plus model-context/load facts. Public terminal bodies gain stable codes.
- **State lifecycle:** Global cooldown remains durable account state. Scoped markers and active leases remain bounded process state. No schema or migration is planned.
- **Failure propagation:** Pre-byte scoped failures stay inside failover. Pre-byte account failures use global cooldown. Post-byte failures terminate once and influence only the next request.
- **Caching and affinity:** Session and xAI cache locality become model-lane-aware. The prior plan's single authoritative owner store remains authoritative; this plan enriches its key/context rather than creating another owner map.
- **Combos:** Slot identity, account, model override, and priority are inseparable through filtering and ordering.
- **Performance:** Candidate evaluation is bounded by accounts times configured concrete fallbacks. Snapshot normalization should be cached per request/account. Active lease bookkeeping is constant-time and must not scan streams.
- **Operations:** A global health response stays healthy when one family is exhausted. Operators gain lane-level explanations and can distinguish capacity from manual pause or misconfiguration.
- **Agent behavior:** Concurrent subagents/models can occupy different owners. A scoped terminal is recoverable on a later turn; no permanent session poison is introduced.
- **Security/privacy:** Beta/features are canonicalized and hashed for logs. No prompt/tool body, raw token, access token, or raw provider error body is logged.

### Risks and Mitigations

- **Stale snapshot misclassification:** Bound age, require positive headroom for reactive scoping, let live hard headers win, and retain conservative account scope on ambiguity.
- **Affinity churn:** Use separate affinity/scope keys and fixed pressure bands. Preserve better-tier mappings during temporary fallback; apply the inherited five-minute anti-thrash only after failed snapback, not ordinary quota updates.
- **Quota comparator false precision:** Compare only fresh compatible windows. Fall back to load/strategy when plan size or window shape is incomparable.
- **Burst convergence:** Acquire leases synchronously only for the fresh committed plan and release on every stream/cancellation path. Spread new/unowned and fallback peers without displacing a legal session owner; keep stable recency as the final tie.
- **Stream lease leaks:** Transfer lease ownership explicitly to the response lifecycle and add EOF/error/cancel/abort tests. Never rely on success-only completion callbacks.
- **Combo desynchronization:** Replace positional sidecars with candidate records and test repeated-account/different-model slots.
- **Scope regression in fallback loops:** Carry the actual attempted model through every response classifier/audit path.
- **Guard amplification:** Make guard-forwarding tests a merge gate and deploy the narrow guard before model terminal behavior.
- **Stale pre-pacing decisions:** Treat pre-wait planning as pure, discard it after the wait, and commit affinity/probe/lease state only from the fresh plan immediately before fetch.
- **Terminal clobbering:** Build the empty-route result from the request outcome ledger, but bypass it for existing auth, context, raw final-provider, maintenance, and count-token terminals.
- **Half-landed scheduler contract:** Land U3 and U4 in one PR; do not expose proactive filtering with an old generic terminal.
- **Multi-process inconsistency:** Production is currently one upstream process. Document process-local scope and defer distributed leases/breakers rather than pretending they are shared.
- **Formatting churn:** Record status, run required gates, inspect the final diff, and stage only intended files. Never include protected generated artifacts.

## Implementation Units

### U1. Define the normalized capacity and failure-scope domain

- **Goal:** Create pure, clock-injected primitives for usage evidence, hard eligibility, freshness, quota pressure, and failure scope without changing live routing.
- **Requirements:** R3-R8, R11-R13, R19-R23.
- **Flows and acceptance:** F1-F3; AE1, AE3-AE5, AE15.
- **Dependencies:** Completed-baseline reconciliation gate.
- **Likely files:**
  - create a shared capacity type module under packages/types/src/
  - create a normalized provider-capacity helper under packages/providers/src/
  - modify packages/providers/src/providers/anthropic/provider.ts to export/reuse its typed hard-account-evidence predicate rather than duplicating HARD_LIMIT_STATUSES or exact depletion parsing
  - modify packages/providers/src/usage-fetcher.ts to expose snapshot timestamp/age safely
  - refactor packages/proxy/src/handlers/usage-throttling.ts to consume shared normalized windows
  - create pure classifier tests alongside provider/proxy usage tests
- **Approach:** Normalize account-wide and scoped windows once, preserving source kind, scope, utilization, reset, and observed time. Keep unknown scoped families explicit. Implement proactive eligibility and reactive failure classification as separate pure decisions over the same evidence. Add a comparable-window quota-pressure result rather than a universal number.
- **Patterns to follow:** Existing limits array parsing, getModelFamily, isUsageExhausted reset guard, exact out_of_credits detection, and injected-time tests.
- **Test scenarios:**
  - session 100% and weekly-all 100% produce account scope.
  - Fable scoped 100% produces only the Fable family scope.
  - Fable scoped 100% does not match Opus.
  - Unknown scoped display/model remains unknown and fails open proactively.
  - Known-past reset is not exhausted; missing reset expires with snapshot freshness.
  - Default polling yields 180-second reactive freshness; configured intervals remain capped by cache maximum.
  - Exact provider evidence beats cache; live hard account evidence beats scoped cache.
  - Fresh scoped 100% plus global 72% is reactive family scope; missing/stale global headroom is account scope.
  - Weekly pressure uses matching scoped or weekly-all reset, never the five-hour reset.
  - Required-burn boundaries at 0.25, 0.5, 1, 2, and 4 percentage points/hour select the documented bands exactly.
  - Incomparable provider/plan shapes return no quota comparison.
- **Verification:** Pure suites prove the decision matrix with no database, timers, or network and existing predictive pacing tests remain unchanged below 100%.

### U2. Isolate reactive scoped failures before global cooldown

- **Goal:** Stop a confidently model/family-scoped direct failure from writing account-wide cooldown while preserving conservative global behavior.
- **Requirements:** R19-R28, R37-R38.
- **Flows and acceptance:** F2-F3, F6; AE3-AE6, AE10, AE13, AE18.
- **Dependencies:** U1 and the verified live plan-001 narrow guard.
- **Likely files:**
  - modify packages/proxy/src/handlers/proxy-operations.ts
  - modify packages/proxy/src/handlers/rate-limit-cooldown.ts only to enforce the global-scope boundary
  - modify packages/proxy/src/handlers/response-processor.ts and midstream response handling
  - modify packages/proxy/src/response-handler.ts for the actual midstream cooldown seam
  - reuse packages/providers/src/providers/anthropic/provider.ts hard-limit evidence helpers
  - modify packages/providers/src/usage-fetcher.ts for generalized bounded markers and scoped probe single-flight
  - modify packages/types/src/account.ts for audit reasons
  - extend proxy operation, response processor, body cancellation, and incident regression tests
- **Approach:** Call the U1 classifier immediately before each existing global cooldown mutation. On scoped pre-byte evidence, settle/discard the response, record the actual attempted model, mark the scoped key, and continue ordinary failover. On account scope, retain the existing durable cooldown path. Post-byte evidence records state for the next request but never replays.
- **Patterns to follow:** Exact out_of_credits handling, bounded 64-entry/five-minute marker cache, single cooldown helper, response-body cancellation, and final-attempt attribution.
- **Test scenarios:**
  - AE3-AE6 and AE10.
  - Scoped failure never calls applyRateLimitCooldown and leaves rate_limited_until null.
  - Account-wide or stale evidence calls the existing global path exactly once.
  - Opus success does not clear Fable state; matching Fable success does.
  - An older poll completion cannot erase newer direct evidence.
  - One scoped recovery probe is admitted after marker expiry; concurrent probes are rejected.
  - Initial model, configured fallback, final fallback, keepalive/internal, and midstream paths all use explicit tested semantics.
  - Every discarded response body/finalizer settles exactly once; active-lease ownership is introduced and tested in U3, not here.
  - Replace the incident characterization that asserts model_fallback_429 always benches the whole account with scoped/global split regressions.
- **Verification:** Focused proxy/provider tests prove no cross-model cooldown poisoning and preserve exact-header, global cooldown, body release, and audit behavior.

### U3. Build the atomic capacity-aware route planner

- **Goal:** Centralize normal, combo, force-route, and configured-fallback planning around immutable account/model attempts.
- **Requirements:** R1-R18, R24, R28-R31, R36.
- **Flows and acceptance:** F1, F4-F6; AE1-AE2, AE7-AE10, AE15-AE16, AE18-AE19, AE22.
- **Dependencies:** U1-U2 and prior plan's landed priority/affinity/force-route/combo work.
- **Likely files:**
  - extend the landed plan-001 proxy-local route candidate and authoritative owner catalog; do not add a second candidate type or affinity map
  - refactor packages/proxy/src/handlers/account-selector.ts
  - refactor packages/proxy/src/proxy.ts
  - refactor packages/core/src/model-mappings.ts getModelList expansion
  - refactor packages/proxy/src/handlers/proxy-operations.ts fallback execution and final attempted-model attribution
  - update packages/load-balancer/src/strategies/ and StrategyStore context
  - extend the landed packages/proxy/src/cache-affinity-orderer.ts authoritative xAI owner store instead of creating parallel ownership state
  - modify stream settlement utilities for active lease ownership
  - expand account selector, strategy, cache-affinity, combo, and stream lifecycle tests
- **Approach:** Resolve the effective request lane and expand one immutable candidate per concrete configured model. Choose the minimum hard-eligible tier first. Only for normal routes, invoke stateful strategy on a deduplicated same-tier account view and map its result back to stable candidate groups; never reorder Account[] and reconstruct account/model/slot identity afterward. Force route remains one group. Combo candidates are tiered by effective configured priority and retain original slot order inside each tier, including repeated account IDs. The executor consumes the planned candidate/chain without recomputing fallback order, and the final transport model must equal the candidate used for capacity and classification. Pre-pacing planning is pure; after any wait, discard it and commit affinity/probe/lease state only from a fresh plan immediately before fetch.
- **Patterns to follow:** Prior plan's priority outer invariant and owner store, RequestBodyContext model resolution, getModelList explicit order, strategy peek side-effect boundary, and recent-pick burst spreading.
- **Test scenarios:**
  - AE1-AE2, AE7-AE9.
  - Hard scoped/global gates operate with pacing flags off.
  - Enabling pacing affects only below-100 eligible candidates; the hard set is identical.
  - Strategy state is not mutated for an account whose every concrete attempt is hard-excluded.
  - Same client session has independent Fable and Opus owners.
  - Priority beats quota pressure, load, affinity, and recent pick.
  - Comparable same-tier weekly pressure beats lower-pressure peers; incomparable snapshots fall back cleanly; fixed band transitions are exact.
  - Session-affinity retains an eligible owner inside its tier/band; synchronous leases spread only new/unowned and fallback peers. Least-used applies leases every time.
  - Leases return to zero after transform throw, pre-header fetch abort, in-place fallback, response-processor throw, EOF, stream error, client cancellation, and failover; a barrier-based concurrent same-tier test proves synchronous spread and zero residue.
  - In-place retries retain one lease; a move to another account transfers ownership exactly once.
  - Applied agent rewrite, combo override, and account mapping produce the expected concrete attempt in that order.
  - Priority-0's explicit configured fallback is exhausted before priority-1's exact requested model; an absent mapping never creates substitution.
  - A capacity change during pacing discards the old plan and leaves no affinity, probe, or lease residue.
  - Cross-priority combos choose effective priority first and preserve original slot order only within a tier.
  - Trusted internal probes retain explicit bypass; ordinary force routes fail closed.
- **Existing-terminal exclusions:** Context admission remains the existing 400 context_length_exceeded with no lease/affinity mutation. Authentication, cooldown reentry/probe suppression, synthetic maintenance, and count-token paths retain explicit semantics and cannot be relabeled as model-pool exhaustion.
- **Verification:** Planner/strategy integration suites prove one explainable total order and exact candidate identity without live providers.

### U4. Classify empty routes and lock the guard contract

- **Goal:** Return the right terminal for model-only, globally temporary, and deterministic no-route states, with no retry amplification.
- **Requirements:** R32-R36, R42-R43.
- **Flows and acceptance:** F5, F7; AE8, AE11-AE12, AE14, AE17, AE20-AE21.
- **Dependencies:** U2-U3 and the prior source-controlled guard.
- **Likely files:**
  - modify packages/proxy/src/proxy.ts
  - extend the existing pool terminal helper in packages/proxy/src/handlers/proxy-operations.ts or split a terminal factory
  - modify packages/proxy/src/__tests__/pool-exhausted.test.ts
  - characterize scripts/ccflare-guard-policy.mjs and scripts/ccflare-guard.mjs through scripts/__tests__/ccflare-guard-policy.test.ts and scripts/__tests__/ccflare-guard.integration.test.ts; modify policy only if those assertions expose a contract bug
  - extend session-account clear and guard integration tests
- **Approach:** Carry one request outcome ledger containing initial exclusions plus scoped/global failures learned during the attempt loop. Apply the R35 precedence only when candidate exhaustion owns the terminal. Emit the exact R32 envelope for model_pool_exhausted; preserve existing pool_exhausted and force_route_unavailable wire contracts; use route_unavailable only for non-forced deterministic emptiness. Recognized native-xAI capacity 402 and positively classified scoped-capacity responses enter the ledger even on the final candidate. Opaque/non-capacity raw provider responses (including generic OpenAI-compatible 402), authentication failures, context_length_exceeded, maintenance, and count-token results bypass the empty-route factory unchanged. The already-narrow guard recognizes only the existing whole-pool header/body fallback; if the expected plan-001 guard files are absent, stop at completed-baseline reconciliation.
- **Patterns to follow:** Existing pool response, force-route marker, governor deterministic responses, narrow guard classification, and session badge clear-before-fallible-work.
- **Test scenarios:**
  - AE11-AE12 and AE14.
  - One unpaused compatible account whose complete blocker set is a finite global cooldown produces whole-pool recovery even if peers are paused; an account that is both paused and cooled does not count.
  - Model exclusions plus globally healthy unrelated lanes produce model_pool_exhausted.
  - Earliest model reset is derived only from relevant excluded attempts.
  - Known scoped reset, no known reset, past reset, marker expiry, snapshot-freshness expiry, probe expiry, and an unrelated earlier reset produce exact next_available_at behavior. Model terminals never carry Retry-After or x-better-ccflare-pool-status.
  - Every initially eligible candidate becoming scoped during one request yields model_pool_exhausted; every candidate becoming globally cooled yields pool_exhausted only when finite recovery exists.
  - Mixed scoped/global state follows AE17 and never makes the guard wait on a globally usable account.
  - Recognized final/forced native-xAI capacity 402 follows AE20; opaque/generic 402 preserves the completed plan's raw boundary.
  - Guard fake-upstream tests prove one attempt for model_pool_exhausted, route_unavailable, force_route_unavailable, and opaque raw 402.
  - A supported-client characterization proves both the R32 envelope and the recognized-402 pool terminal permit a later same-conversation turn; the proxy stores no permanent failure state.
  - Session/account display associations clear on every empty-route terminal.
- **Verification:** Proxy and guard suites demonstrate that only a genuinely temporary whole pool waits; every deterministic/model result returns promptly.

### U5. Make capacity decisions observable and model-contextual

- **Goal:** Let operators see why each lane is or is not routable and preview the same decision the live scheduler will make.
- **Requirements:** R37-R41.
- **Flows and acceptance:** F1, F4, F7; AE1-AE2, AE11, AE17.
- **Dependencies:** U1, U3-U4.
- **Likely files:**
  - modify packages/http-api/src/handlers/accounts.ts
  - modify packages/http-api/src/handlers/health.ts and rate-limit-status.ts
  - modify apps/server/src/server.ts and shared API response types where utilization/strategy context is injected
  - add a model-contextual route-preview handler or extend the existing safe preview seam
  - modify packages/dashboard-web/src/components/accounts/ and overview error metadata
  - extend account API, health, route-preview, request-history, and dashboard tests
- **Approach:** Reuse U1's evaluator and U3's pure planning phase. Keep readiness and global pool status account-global. Add per-family annotations with eligible tier/account, exhausted reasons, reset, evidence age, and terminal interpretation; unknown/unlisted families never affect readiness. Full decision detail goes to bounded structured logs. Request history uses only existing model/status/reason fields, so no schema migration is needed. A dry run reports the current snapshot, not a future guarantee, and never creates affinity, leases, probes, or writes.
- **Patterns to follow:** Health detail gating, accounts raw usage rows, safe unknown-reason rendering, current peek side-effect contract, and request-history error metadata.
- **Test scenarios:**
  - Fable exhausted/Opus available renders the account enabled with distinct lane states.
  - Global health depends only on process health and account-global availability; an exhausted, unknown, or unlisted model annotation cannot degrade it.
  - Model preview matches live selection for priority, pressure, load snapshot, and exclusions without mutating state.
  - Unknown scope/provider data renders unknown rather than exhausted.
  - Scoped audit reason never appears as account-wide disabled/cooldown.
  - Error metadata explains model_pool_exhausted, route_unavailable, and recovery action.
- **Verification:** API and dashboard fixtures produce one consistent explanation for AE1 and AE11.

### U6. Integrate, deploy, and dogfood the complete scheduler

- **Goal:** Close protocol and lifecycle gaps, validate the full matrix, and deploy from main without risking Anthropic accounts.
- **Requirements:** All.
- **Flows and acceptance:** F1-F7; AE1-AE22.
- **Dependencies:** U1-U5.
- **Likely files:**
  - integration tests under packages/proxy/src/__tests__/
  - relevant Messages/Responses adapter fixtures
  - scripts/deploy-ccflare.sh only if the prior plan's deployment verifier needs new terminal/guard assertions
  - root README.md only if operator-facing route semantics require documentation
- **Approach:** Build one fake-upstream incident suite that runs simultaneous lanes, direct/stale/global failures, stream cancellation, reset/snapback, pacing discard/replan, explicit fallback priority, combo, force-route, terminal precedence, supported-client recovery, and guard forwarding. Preserve and name the existing regression seams: proxy-operations-failover.test.ts, proxy-operations-out-of-credits.test.ts, incident-2026-07-09-health-flap.test.ts, proxy-usage-throttling.test.ts, response-handler-midstream.test.ts, proxy-operations-count-tokens.test.ts, and the landed plan-001 affinity/force-route/guard suites. Deploy only merged main through the repository path and verify binary plus guard identity before operator dogfood.
- **Patterns to follow:** Incident regression fixtures, fake local upstreams, main-only SHA verification, focused rollback boundaries, and operator-driven real-client validation.
- **Test scenarios:**
  - Full AE1-AE22 story under one deterministic clock.
  - Messages and relevant Responses-adapter routes make the same eligibility/scope decision.
  - Restart loses only bounded process-local markers/leases; fresh 100% snapshots still prevent doomed attempts.
  - No protected generated file changes and no schema diff.
  - Non-Anthropic forced fixture proves guard and terminal behavior on isolated ports.
  - Operator starts simultaneous real Fable and Opus chats; no scripted provider call is used.
- **Verification:** Full suite and required quality gates pass; main deploy reports the expected binary/guard identities; operator dogfood confirms Fable spillover, Opus continuity, and automatic recovery.

## Verification Contract

| Gate | Command or check | Observable result |
|---|---|---|
| Capacity domain | Focused provider/proxy capacity and usage-throttling tests | Decision matrix, freshness, reset, comparability, and pressure rules are deterministic. |
| Reactive isolation | Focused proxy-operations, response processor, midstream, cooldown, and incident tests | Scoped failures never write global cooldown; ambiguous/global failures still do. |
| Candidate planner | Account selector, load-balancer strategy, cache-affinity, combo, and model-mapping tests | Atomic pairings, priority, pressure bands, lane affinity, and load leases hold. |
| Terminals | Pool/session terminal and request-outcome-ledger tests | Stable code model_pool_exhausted, existing pool_exhausted, route_unavailable, and force_route_unavailable have exact precedence, envelopes, headers, complete-account recovery, and recovery metadata; recognized xAI 402 never escapes raw. |
| Guard | Existing guard policy/process fake-upstream suites | Only explicit whole-pool exhaustion retries; model/deterministic errors forward once. |
| Existing terminals | Auth, context admission, raw-final-provider, cooldown reentry, maintenance, and count-token regressions | Capacity exhaustion never relabels an existing terminal or acquires state on a synthetic path. |
| Visibility | Accounts, health, preview, request-history, and dashboard tests | Global and per-family state agree with the live comparator without dry-run mutation. |
| Agent lifecycle | Fake streaming and supported-client same-session integration tests | No post-byte replay, no lease leak, no proxy tombstone, and a later client-issued turn can recover. |
| Named incident regressions | proxy-operations-failover, proxy-operations-out-of-credits, incident-2026-07-09-health-flap, proxy-usage-throttling, response-handler-midstream, and proxy-operations-count-tokens suites | Historical failover/scope/context behavior is preserved or intentionally flipped by a named acceptance example. |
| Full regression | bun test | Repository suite passes without real upstream traffic. |
| Required quality gates | bun run lint && bun run typecheck && bun run format | All required gates pass; inspect the resulting diff and keep only intended files. |
| Protected-file audit | Inspect final changed-file list | No protected generated artifact or prohibited README is modified or staged. |
| Main-only deploy | Run scripts/deploy-ccflare.sh only after each behavior PR lands on refs/heads/main | Runtime git SHA and source-controlled guard identity match the landed commit. |
| Safe smoke | Fake/local or force-routed non-Anthropic account only | Route and guard contracts work without automated Anthropic traffic. |
| Operator dogfood | Run simultaneous real Fable and Opus chats through localhost:8788 | Fable spills to a capable sibling, Opus continues on the preferred account, and reset snaps back. |

### Deployment Go/No-Go and Rollback

**Before each behavior deploy**

- Confirm the target includes the prior plan's landed integration SHA.
- Record current binary SHA, guard source/digests/config, process identity, active/queued counts, account priorities, pacing flags, and per-family usage snapshot ages.
- Confirm direct 8789 health and guarded 8788 health both answer.
- Stop if the live guard still retries raw 429/529/5xx or lacks source identity.
- Stop if any targeted/full gate fails, if priority or account/model pairing regresses, or if protected files changed.
- Preserve the prior binary/guard pin as the rollback set.

**After each behavior deploy**

- Verify a new process identity and exact landed binary/guard SHA.
- Run fake/non-Anthropic checks for terminal classification and guard one-attempt behavior.
- Inspect structured decisions for priority tier, attempted model, scope, and lease settlement.
- Use ambient/operator-driven traffic for Anthropic validation; never manufacture it.
- Do not advance until the slice has at least 15 minutes of stable ordinary traffic and its focused acceptance scenario passes.

**Rollback triggers**

- Fable-only evidence removes Opus or writes account-wide cooldown.
- A lower priority leads while the requested lane is eligible in a better tier.
- Account/model/slot identity diverges.
- Active lease count remains nonzero after settled traffic.
- A stale snapshot is classified as scoped.
- A recognized native-xAI capacity 402 reaches the ordinary or forced client as raw 402.
- The guard retries model_pool_exhausted, route_unavailable, force_route_unavailable, raw 402/429/529, or generic 5xx.
- Global health becomes degraded solely because one model family is exhausted.
- A later request with the same session identity remains pinned to an exhausted lane after capacity or routing recovers.

**Rollback method**

- Revert only the offending focused PR on refs/heads/main and redeploy from main.
- Restore and verify the prior complete binary/guard pin if startup or identity verification fails.
- Re-run the slice's focused gates plus direct/guarded health after rollback.
- No data restoration is expected because this plan adds no migration.

### Monitoring Window

For 24 hours after final deployment, review at +1h, +4h, and +24h:

- Hard exclusions by account, family, reset, and evidence age.
- Scoped versus global 429 classifications and fallback success.
- Serving distribution by configured tier and quota-pressure band.
- Priority spill/snapback and affinity override reasons.
- Active lease current/high-water counts and any nonzero settled remainder.
- model_pool_exhausted, pool_exhausted, and route_unavailable counts.
- Recognized native-xAI capacity 402 classifications versus opaque/raw 402 forwarding.
- Guard attempts by terminal class; any non-pool retry is an invariant violation.
- Same-session recovery after scoped terminal/reset.
- Binary/guard identity after any restart.

## Definition of Done

- [ ] The worktree and deployment are resolved to the already-completed prior reliability integration SHA and its contracts are verified without reopening plan 001.
- [ ] R1-R43 are traced to implemented units and passing acceptance coverage.
- [ ] All routing paths use atomic account/model candidates.
- [ ] Hard account and scoped capacity work with pacing flags off.
- [ ] AE1 proves simultaneous Fable/Opus behavior and no global cooldown poisoning.
- [ ] AE1-AE22 pass, including pacing isolation, explicit fallback priority, combo priority, final-capacity-402 normalization, terminal precedence, supported-client recovery, and discarded-plan purity.
- [ ] Priority, quota pressure, strategy ownership, active load, and lane affinity obey the documented staged order.
- [ ] Scoped/global failure classification covers fresh, stale, conflicting, fallback, and post-byte evidence.
- [ ] Active leases settle exactly once across every response lifecycle.
- [ ] The three terminal contracts are mutually correct and guard behavior is exact.
- [ ] API, health detail, preview, request history, and dashboard share the evaluator/comparator.
- [ ] No schema migration, protected generated change, or prohibited README edit is present.
- [ ] Focused suites, bun test, lint, typecheck, and format pass.
- [ ] Each behavior change lands on refs/heads/main and deploy identity matches.
- [ ] Non-Anthropic fixture verification and operator-driven simultaneous Fable/Opus dogfood pass.
- [ ] Rollback artifacts and monitoring checkpoints are recorded.
