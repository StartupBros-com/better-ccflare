---
title: Authorization-Before-Ranking and Success-Conditioned Route Ownership
date: 2026-09-01
category: architecture-patterns
module: routing
problem_type: architecture_pattern
component: commit-bound routing
severity: high
applies_when:
  - Extending capability-profile descendant or trusted-helper routing
  - Adding pre-dispatch fallback, affinity, or route-home behavior
  - Changing provider-owned server-tool dispatch or failover
related_components:
  - session affinity
  - server-tool routing
  - request provenance
tags:
  - routing
  - route-profiles
  - session-affinity
  - server-tools
  - failover
  - authorization
---

# Authorization-Before-Ranking and Success-Conditioned Route Ownership

## Context

Route profiles establish **authorization**, not a standing preference that can be widened by whichever ranking mechanism runs next. A capability profile admits a root-capable pool from its expected provider and root logical-to-physical mapping; its descendants may use that pool without being pinned to the root physical model. The descendant ladder is requested model in the pool, root model in the pool, then the requested stock model through ordinary same-model routing; mapped providers are not eligible merely because they are available (`docs/configuration.md:392-398`).

This produces one combined invariant:

> **Compile the complete authorized candidate set before ranking it; commit a child home only after an accepted successful route.**

The two halves protect each other. If ranking runs before authorization, affinity, priority, probe recovery, or a cached owner can smuggle an ineligible account into the request. If ownership is written at selection or attempt time, an unusable candidate becomes a falsely sticky home. The candidate compiler expresses the three rungs as profile-requested, profile-root, and global-requested, applies the ordinary stock-model eligibility fence specifically to the global rung, deduplicates by account plus physical model, and only then passes eligible candidates to the strategy (`packages/proxy/src/handlers/account-selector.ts:1987-2127`).

Session history records why an exact account choice was not enough in earlier route-profile work: descendants could retain a logical model whose mapping did not satisfy the profile's physical or server-tool contract. It also records a routing-integrity correction where one late candidate mismatch incorrectly terminalized a request despite another authorized candidate. These are historical investigation findings rather than current-source claims; the current tree separately verifies candidate filtering and authorized-plan exhaustion. (session history)

This is intentionally not a general escape hatch. The selector rejects a public force route that conflicts with a capability profile (`packages/proxy/src/handlers/account-selector.ts:2314-2340`), and an unavailable force-routed account returns a typed error rather than normal-pool routing (`packages/proxy/src/handlers/account-selector.ts:2445-2460`). Ordinary stock-Claude traffic remains protected by the same-model integrity fence from PR #285, while the descendant behavior shipped in PR #286.

A child route home is narrower than a parent session binding: it is a process-local lane for one authenticated caller/session/child lineage. The affinity-lane key includes the profile and bounded child-home key for descendants, while marker-only descendants get no reusable key (`packages/proxy/src/handlers/account-selector.ts:778-820`). The shared vocabulary defines a child home as the first successful provider/account-class/physical-model lane for that child, stable until a genuine availability failure; parents and siblings remain independent (`CONCEPTS.md:22-26`).

Provider-owned hosted tools have the same boundary in a stricter form. The request-local ledger has a monotonic `undispatched → hosted_dispatched` claim that cannot be released by retry or failover (`packages/proxy/src/handlers/routing-attempt-ledger.ts:218-232`). Once a hosted dispatch may have occurred, proxy operations treat it as terminal rather than as an ordinary candidate miss (`packages/proxy/src/handlers/proxy-operations.ts:283-318`). The native Codex Hosted WebSearch foundation and this dispatch boundary shipped in PR #129.

## Guidance

1. **Authorize first.** Derive route class and hard boundaries from server-trusted state, then compile an immutable request-local candidate plan. A strategy may only reorder or temporarily suppress members of that plan; it must not add accounts, providers, models, or fallback rungs. The selector treats strategy output as ordering rather than authority and filters it back to the established eligible-account set (`packages/proxy/src/handlers/account-selector.ts:2199-2208`).

2. **Make rung order stronger than ranking.** Preserve semantic order between rungs; allow priority, load, probes, and affinity only to order candidates within a rung. The compiler emits rung specifications in semantic order before deduplication and capacity filtering (`packages/proxy/src/handlers/account-selector.ts:2006-2088`).

3. **Keep hard boundaries outside the ladder.** Exact-account, public force-routed, and bounded routes fail closed; do not compile their unavailable route into a global fallback. Trusted helpers may use only reviewed capability routes, and an active soft capability profile can use a global proven helper lane only before hosted dispatch (`docs/configuration.md:394-398`).

4. **Select provisionally; commit conditionally.** A candidate is not a home because it was ranked first, selected, acquired credentials, or started an attempt. Commit only at the accepted-candidate seam after terminal arbitration has chosen a successful response. `settleRoutedResponse` calls the home-commit callback only for successful accepted responses, so a failed terminal cannot own a descendant home (`packages/proxy/src/proxy.ts:2403-2465`).

5. **Use compare-and-set replacement semantics.** Retain a healthy child home first. Permit replacement only when the exact old home was observed unavailable, excluded, structurally removed, capacity/credential blocked, or circuit-open. `SessionAffinityStrategy` retains a valid descendant owner ahead of other candidates and sets a concrete re-pin reason otherwise (`packages/load-balancer/src/strategies/session-affinity.ts:960-1041`); its commit operation refuses a different owner unless the expected old candidate and replacement authorization match (`packages/load-balancer/src/strategies/session-affinity.ts:462-518`).

6. **Treat irreversible dispatch as a separate ownership boundary.** Revalidate the exact hosted-tool proof immediately before transport, assert the physical budget, then synchronously claim hosted dispatch. HTTP and WebSocket hooks place the claim before their irreversible send points (`packages/proxy/src/handlers/proxy-operations.ts:3147-3174`, `packages/proxy/src/handlers/proxy-operations.ts:3278-3289`, `packages/proxy/src/handlers/proxy-operations.ts:4031-4116`). No later candidate, guard replay, model fallback, or account failover may repeat that inbound hosted operation.

A TypeScript-shaped implementation keeps the authority boundary visible:

```ts
type AuthorizedCandidate = {
  id: string;
  accountId: string;
  logicalModel: string;
  physicalModel: string;
  rung: "profile_requested_model" | "profile_root_model" | "global_requested_model";
};

function compileAuthorizedPlan(input: RouteInput): AuthorizedCandidate[] {
  assertHardBoundary(input); // exact/force/bounded: permit one route or fail

  const profilePool = accounts.filter((account) =>
    provesRootCapability(account, input.profile),
  );
  const globalStockPool = accounts.filter((account) =>
    servesOrdinaryStockModel(account, input.requestedModel),
  );

  return dedupeAccountPhysical([
    ...profilePool.map((account) =>
      candidate(account, input.requestedModel, "profile_requested_model"),
    ),
    ...profilePool.map((account) =>
      candidate(account, input.profile.rootModel, "profile_root_model"),
    ),
    ...globalStockPool.map((account) =>
      candidate(account, input.requestedModel, "global_requested_model"),
    ),
  ]);
}

async function routeDescendant(input: RouteInput) {
  const authorized = compileAuthorizedPlan(input);
  const ordered = rankWithinRung(preferHealthyHome(authorized, input.childLane));

  for (const candidate of ordered) {
    const result = await attempt(candidate);
    if (!result.accepted) continue;

    commitHomeIfExpected(input.childLane, candidate, result.replacementEvidence);
    return result.response;
  }
  return typedAuthorizedExhaustion(authorized);
}
```

The pseudocode models existing behavior: candidate metadata includes the rung and effective logical model (`packages/proxy/src/handlers/account-selector.ts:2045-2060`), and route provenance constrains allowed rungs, home actions, and re-pin reasons (`packages/types/src/request.ts:30-64`).

## Why This Matters

Authorization and ownership are security and correctness properties, not optimizations.

- **No eligibility laundering.** A high-priority account, recovered account, affinity owner, or probe target cannot become eligible because it ranks well. The global descendant rung applies ordinary stock-model eligibility before implicit fallback policy (`packages/proxy/src/handlers/account-selector.ts:1995-2005`).
- **No false stickiness.** A credential failure, pre-dispatch rejection, or losing provisional response must not strand future turns. The request loop invokes `commitDescendantAffinityOwner` only through the settled winner callback (`packages/proxy/src/proxy.ts:2467-2475`, `packages/proxy/src/proxy.ts:3002-3023`).
- **Continuity without snapback.** A healthy home stays preferred despite priority changes or recovery of a preferred rung. Re-pinning is driven by concrete unavailability evidence, and the allowed reasons are structurally bounded (`packages/load-balancer/src/strategies/session-affinity.ts:965-1012`, `packages/types/src/request.ts:45-53`).
- **At-most-once hosted work.** Server-owned operations can be non-idempotent or produce provider-owned state. The ledger's synchronous first-claim-wins transition prevents replay through a sibling lane after the dispatch boundary (`packages/proxy/src/handlers/routing-attempt-ledger.ts:218-232`).
- **Truthful diagnostics.** Response metadata exposes only coarse fallback and routed-model facts (`packages/proxy/src/response-handler.ts:272-305`), while durable request provenance preserves bounded operator details with preserve-first updates (`packages/database/src/repositories/request.repository.ts:175-287`). SQLite and PostgreSQL define matching route-provenance columns (`packages/database/src/migrations.ts:430-459`, `packages/database/src/migrations-pg.ts:560-590`).

Operational observation belongs in the implementation closeout record, not in this invariant. Automated boundary tests remain the proof of the authorization, ownership, and at-most-once properties.

## When to Apply

Apply this invariant when changing any of these areas:

- Capability-profile descendant models, root-model substitution, or global fallback rungs.
- `SessionAffinityStrategy`, route circuits, candidate metadata, or strategy ordering.
- Trusted helpers or provider-owned tools, especially when a helper model is not an operator-selected model.
- Attempt-plan construction, credential/pretransport flow, HTTP dispatch, WebSocket writes, retries, guard recovery, or response arbitration.
- Route-selection provenance or its database migrations; update both SQLite and PostgreSQL schemas and upgrade paths.

Do **not** apply it by silently broadening existing route classes. Ordinary stock-Claude roots remain subject to the same-model fence, and exact-account, force-routed, and bounded profiles remain fail-closed.

## Examples

### Authorized fallback, then ranking

```ts
const plan = compileAuthorizedPlan({
  profile: solCapabilityProfile,
  requestedModel: "claude-sonnet-5",
  childLane,
});

// Correct: reorder only candidates already proven by their rung.
const ranked = rankWithinEachRung(plan, { affinity, priority, probeState });

// Incorrect: grants eligibility because an unrelated route is available.
const unsafe = [...ranked, ...allAvailableAccounts];
```

Test with a higher-priority mapped provider: it must remain absent from an ordinary stock root and the global requested-model rung unless it independently satisfies ordinary eligibility.

### Selection is not ownership

```ts
const candidate = strategy.select(authorized)[0];
// Do not: homes.set(childLane, candidate);

const attempt = await transport(candidate);
if (attempt.acceptedWinner) {
  homes.compareAndSet({
    lane: childLane,
    expected: currentUnavailableHomeOrNull,
    next: candidate,
  });
}
```

Test rejected-before-dispatch, credential failure, pre-acceptance upstream failure, accepted success, concurrent first successes, priority change, recovered preferred rung, every enumerated re-pin reason, sibling isolation, and restart/TTL expiry.

### Hosted tool: authorize before dispatch; never replay after dispatch

```ts
const candidate = nextAuthorizedProvenHostedCandidate();
assertExactCapabilityProof(candidate);
ledger.assertPhysicalAttemptAvailable({ accountId: candidate.accountId });
if (!ledger.claimHostedDispatch()) return terminalAlreadyDispatched();

return sendHostedRequest(candidate); // irreversible boundary
// Never select another hosted candidate for this inbound request after this point.
```

Test one-and-only-one transport across HTTP, WebSocket, in-process retries, failover, cancellation before and after claim, guard recovery, and ambiguous writes.

### Observable outcome without leaking topology

```ts
persistOperatorProvenance({
  profileId,
  requestedModel,
  routedProvider,
  routedModel,
  fallbackRung: winner.rung,
  homeAction: "repinned",
  repinReason: "route_circuit_open",
  candidateId: winner.id,
});

return addClientHeaders(response, {
  fallbackRung: winner.rung,
  routedModel,
});
```

Response-facing metadata excludes account and candidate identifiers, while authenticated operator history retains the bounded route facts needed to reconstruct the decision.

## Related

- [Account Routing Architecture](../../routing-architecture.md)
- [Configuration](../../configuration.md#claude-code-model-route-profiles)
- [Commit-Bound Capability Profile Descendant Routing Plan](../../plans/2026-08-30-1854-fix-route-profile-descendant-routing-plan.md)
- [Codex Native Hosted Web Search Plan](../../plans/2026-07-29-001-fix-provider-server-tool-capability-architecture-plan.md)
- [Rate-Limit Scope and Duration](../rate-limit-scope-and-duration.md)
