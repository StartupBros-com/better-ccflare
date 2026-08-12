# Rate-limit holds: scope, duration, and evidence must name the same window

**Status:** partially fixed. Read "What is still open" before changing this code.
**Incidents:** 2026-07-09, 2026-07-30, 2026-08-11 (x2).
**Issues:** #155 (umbrella), #157 (fixed), #160 (fixed by #161).
**Code:** `packages/proxy/src/handlers/rate-limit-scope.ts`,
`rate-limit-cooldown.ts`, `proxy-operations.ts`, `response-handler.ts`.

## The invariant

> An account may only be withheld from a request lane by a hold whose **scope**,
> **duration**, and **evidence** all refer to the same capacity window.

Four production incidents have been one violation of that sentence. If you are changing
bench/cooldown logic, this is the rule to hold in your head.

## Why this keeps happening

The system's failure modes are asymmetric, and the asymmetry is easy to forget:

| Error | Cost |
|---|---|
| Withholding an account that could serve | capacity loss; at the limit, a pool-wide outage |
| Routing to an account that cannot serve | one wasted 429, then failover |

Every incident has been the first kind. So **the cheap error must be the default**: when
evidence is missing or ambiguous, prefer the narrower scope and the shorter hold.

Historically the code did the opposite. Scope and durability were inversely correlated —
the broadest scope (`account`) was the only durable one (`accounts.rate_limited_until`,
12h ceiling), while narrower `family`/`model` holds lived in an in-memory map with a
5-minute TTL. Uncertainty therefore resolved toward the most destructive, longest-lived,
restart-surviving state.

## The three distinct mistakes, in the order they were found

### 1. A header that does not name its window (fixed in #156)

Anthropic returns its hard unified status (`rate_limited`, `rejected`,
`unified-remaining: 0`) on **per-model** weekly caps as well as account-wide ones, and the
header never says which. `classifyPreByte429` short-circuited on it and benched the whole
account.

Now it narrows to family scope on affirmative proof — a fresh snapshot showing that
family's cap spent while account windows retain headroom — and keeps the account-wide
reading otherwise.

### 2. No evidence still bought a long hold (fixed in #158)

The usage cache is **in-memory**, so a restart empties it. With no snapshot the classifier
correctly reads account-wide, but the reset it then honoured was the per-model window days
out, clamped to the 12h ceiling. Three healthy accounts were benched 19 seconds after a
deploy; the pool fell to one routable account and ~60 requests returned
`503 route_unavailable`.

`ResetTimeScope` now marks an unattributed reset, and those take the backoff ramp
(30s doubling, capped 5min) instead of the ceiling.

### 3. Proving the scope is not proving the timestamp (fixed in #161)

The subtlest one, and it survived a five-reviewer pass. #158 verified that the *evidence*
was account-wide, then passed `extractCooldownUntil`'s value — which independently picks
the response header, the usage-poller value, or a synthetic fallback, none checked against
the window that justified the verdict. A spent 2-hour session window paired with a
per-model reset days out still wrote a 12h bench.

`RateLimitScopeDecision.accountWindowResetAt` now carries the proving window's reset, and
the bench sites use that or nothing.

## Two rules that are easy to get backwards

**An upstream instruction may only ever SHORTEN a hold, never lengthen it.**
`boundedAccountHoldReset` enforces this. The first attempt at #161 preferred the proven
window unconditionally and turned a `retry-after: 120` next to a six-day weekly window
into a 12h bench — the same over-benching, merely sourced from our own snapshot instead of
the header. The existing suite caught it.

**An optional safety field defaults to unsafe.** #158 made attribution optional
(`omitted = confirmed`) for backward compatibility, which silently left
`handleAnthropicSseRateLimit` writing 12h benches. If you add a flag that prevents harm,
assume every caller that can forget it will.

## The trap that looks like a bug fix

`getRepresentativeUtilizationForProvider` excludes model-scoped windows. This looks wrong —
it is why the dashboard read 84% while the Fable lane was unroutable — and "fixing" it will
cause an outage.

That function feeds `StrategyStore.getAccountUtilization` (`server.ts`) and the shared
exhaustion predicate (`health.ts:44`). Counting a Fable-only cap there makes the whole
account read as exhausted and removes **every** lane. Routing and operators are asking
different questions of the same data:

- routing: *how much account-wide capacity is left?* -> account windows only
- operator: *what is stopping me right now?* -> include per-model caps

`getBindingConstraint` (`usage-throttling.ts`) is the display-side answer. Keep them apart.

## What is still open

- **Pool-floor alarm.** Nothing logs when a bench takes routable candidates to zero. On
  2026-08-11 that cost four minutes of blind 503s before anyone knew.
- **`bindingConstraint` is exposed on `/api/accounts` but the dashboard does not render it**
  (PR #159).
- **One eligibility predicate.** `isAccountAvailable`, `evaluateHardCapacity` and
  `getAccountUtilization` still compute overlapping answers separately, which is how the
  dashboard and the router came to disagree.
- **Last-route protection** was scoped and then dropped: once wrong holds are capped at
  5 minutes it only helps when a *confirmed* hold is wrong on the last route (rare), and
  when the hold is correct the capacity genuinely is not there. Re-derive before building.

## How to verify a change here

Do not trust hand-built fixtures for this code. See
[validate-against-live-payloads.md](./validate-against-live-payloads.md) — every fixture in
the repo modelled Anthropic's payload incorrectly, in the same way, and two of the bugs
above were only visible against real data.
