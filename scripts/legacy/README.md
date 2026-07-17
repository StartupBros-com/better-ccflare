# Legacy guard/runner baseline

This directory holds a verbatim, historical snapshot of the pre-replacement
production guard and runner: the pair the incident described in
`docs/plans/2026-07-16-001-fix-routing-reliability-plan.md` implicated,
before commit `b7b23cb8`/`c89d9f04` replaced them with the source-controlled
`scripts/ccflare-guard.mjs`, `scripts/ccflare-guard-policy.mjs`, and
`scripts/run-ccflare-stack.sh`.

Neither file here is imported by anything, built, linted, or type-checked.
`scripts/` is outside the biome and tsconfig includes, and these two files
are day-zero historical reference only — do not wire them into any build,
test, or runtime path. Do not edit them; if this baseline is ever wrong, take
a fresh snapshot instead of patching the old one, so the provenance data
below stays truthful.

## Provenance

Snapshot date: 2026-07-17. Snapshots are exact copies (verified via `diff`
and matching SHA-256) of the following read-only host sources, which remain
unmodified on disk:

| Snapshot | Source path (host, read-only) | mtime (UTC) | Birth time (UTC) | SHA-256 |
| --- | --- | --- | --- | --- |
| `ccflare-guard.mjs` | `/home/will/.config/better-ccflare/ccflare-guard.mjs` | 2026-07-11T04:38:20Z | 2026-07-10T04:29:06Z | `76439f4d390cf7946d7eb845796799bf93cce4c5e10776831bada89235b9c771` |
| `run-ccflare-stack.sh` | `/home/will/.config/better-ccflare/run-ccflare-stack.sh` | 2026-07-11T23:32:07Z | 2026-07-11T23:32:07Z | `7c86a1b7a09da26c69b8778f4d049355ebf953cc6f0cb518e0c08a6c74f9311c` |

The oldest surviving systemd pin backup,
`/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf.bak`
(mtime 2026-07-16T18:33:50Z, SHA-256
`7e90e360dce04694a0d28a9fb72efa093bb30e326ce2d957a056e2e52935f45e`), predates
the guard-pinning deploy changes: it has no `GUARD_SCRIPT=`,
`GUARD_SOURCE_ID=`, `GUARD_POLICY_ID=`, or `ExecStart=` override lines. At
that point the base unit's hardcoded
`ExecStart=/home/will/.config/better-ccflare/run-ccflare-stack.sh` (the
runner snapshotted here) ran directly, and that runner internally defaulted
`GUARD_SCRIPT` to `/home/will/.config/better-ccflare/ccflare-guard.mjs` (the
guard snapshotted here) when the environment did not override it. Together
these two files are what the pin backup's `ExecStart=` line was actually
running — the day-zero baseline this snapshot documents.

## Divergences from the current source-controlled guard/runner

### Retry deadline and attempt bound (R19)

- Legacy: `maxWaitMs` default `30 * 60 * 1000` (30 minutes,
  `GUARD_MAX_WAIT_MS`/`CCFLARE_GUARD_MAX_WAIT_MS` env, defaulted to
  `1800000` by the legacy runner too), and **no attempt cap at all** — an
  unbounded `while (true)` loop bounded only by cumulative elapsed time
  against `maxWaitMs`.
- New (`scripts/ccflare-guard.mjs`, `scripts/ccflare-guard-policy.mjs`):
  `DEFAULT_GUARD_TOTAL_DEADLINE_MS = 120_000` (120 seconds) **and** a hard
  `DEFAULT_GUARD_MAX_ATTEMPTS = 3` cap, whichever is hit first. Worst-case
  client-visible exposure to a single hung request dropped roughly 15x.

### Retry jitter

- Legacy: `jitterMs` default `15_000` (up to 15s of added random delay per
  retry).
- New: `DEFAULT_GUARD_RETRY_JITTER_MS = 2_000`.

### Retry scope (R18)

- Legacy `retryDecision()` retries far more broadly than R18 allows as
  final-at-the-guard-layer:
  - Explicit 503 `pool_exhausted` (the one case that's in the same spirit as
    the new policy).
  - A **regex text match** `/overloaded_error|overloaded/i` against the raw
    response body, on **any status**, not just 503/529.
  - Raw 429, unconditionally.
  - **All** of `[500, 502, 503, 504]` generically, regardless of body shape.
  - Only a governor-marker header (`x-better-ccflare-governor`) short-circuits
    to immediate forwarding; otherwise most upstream error statuses get
    silently retried against the same account/session for up to 30 minutes.
- New (`evaluateGuardRetry` in `scripts/ccflare-guard-policy.mjs`): retries
  only a 503 that is header-confirmed (`x-better-ccflare-pool-status:
  exhausted`) or, as a rolling-upgrade fallback when that header is absent,
  a body that structurally matches `error.type === "pool_exhausted"`. Raw
  402/429/500/502/504/529 and generic 503s are forwarded to the caller
  exactly once, so model-scoped and provider-specific errors stay visible
  and the router owns fallback policy instead of the guard silently eating
  them.

### `proxy_success` mislabeling

- Legacy (lines ~322-333): a response is logged as `event: "proxy_success"`
  whenever `upstreamRes.ok || ![429, 500, 502, 503, 504, 529].includes(status)`
  is true. That condition is true for **any** status not in that specific
  retry-candidate list — including 400, 402, 403, and 404 — so a genuine
  client error like an insufficient-balance 402 gets logged as
  `proxy_success` even though it is an error response. There is no separate
  event or field distinguishing a true 2xx success from a terminal
  non-retryable error forwarded once.
- New: `scripts/ccflare-guard.mjs`'s `proxy_response` log event carries an
  explicit `outcome` field (`"success"` for 2xx, `"final_error"` otherwise;
  see R21 / GAP 4), so a 402 can never be mistaken for a success in the
  guard's own logs.

### Runner shutdown-grace mismatch (guard drain safety)

- Legacy runner (`stop_child()`, lines 29-46): a **fixed** `seq 1 25` x
  `sleep 0.2` = 5-second stop budget for every child uniformly (guard,
  upstream, tunnel) — `stop_child "ccflare guard" "${guard_pid}"` passes no
  budget override. This directly contradicts the legacy guard's **own**
  internal `shutdownGraceMs` default of 75 seconds
  (`GUARD_SHUTDOWN_GRACE_MS || 75_000`): on a restart/deploy, the runner
  would SIGKILL the guard after only 5s even though the guard's shutdown
  handler wanted up to 75s to drain active client streams, risking severed
  SSE streams mid-restart.
- New runner (`scripts/run-ccflare-stack.sh`): computes
  `GUARD_STOP_BUDGET_MS = GUARD_SHUTDOWN_GRACE_MS + GUARD_SHUTDOWN_CUSHION_MS`
  (75s + 5s by default) and passes that budget specifically for the guard
  child, while upstream and the tunnel keep the fixed 5s budget. The guard's
  own shutdown-grace default is asserted statically in
  `scripts/__tests__/deploy-ccflare.test.ts` to guard against this
  regressing silently.

### Abort-listener leak in `sleep()`

- Legacy `sleep(ms, signal)` (lines 97-111): on normal (non-aborted)
  resolution, the `setTimeout` callback calls `resolve` directly without
  removing the `abort` listener it registered on `signal`. The listener is
  only ever auto-removed via `{ once: true }` when abort actually fires.
  Across multiple retry iterations of one request (up to the unbounded
  legacy attempt count), listeners accumulate on the shared per-request
  `AbortController.signal` until the whole request completes.
- New guard's `sleep()`: uses a shared `finish()`/`settled` guard that
  removes the listener on both the resolve and the abort path, so no
  listener accumulation is possible regardless of how many attempts a
  request takes.

### No per-fetch deadline

- Legacy `fetchUpstream()`: passes only the overall per-request abort
  `signal` (client disconnect) to `fetch()`, with no per-attempt
  timeout/`AbortController` deadline of its own. A hung upstream connection
  is unbounded per attempt unless the client itself disconnects.
- New guard: layers `ensureBudget()` pre-fetch deadline checks and a
  response-idle-timeout watchdog (`DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS`)
  on top of the client-abort signal, so a hung upstream cannot indefinitely
  hold a guard slot.

### Indefinite pool-exhaustion delay fallback

- Legacy: when a `pool_exhausted` body carries no finite recovery
  candidates, `retryDecision()` falls back to a fixed `15_000`ms
  (15s) wait rather than declining to retry.
- New: the same "retry rather than refuse" philosophy carries over (R17),
  but the fallback is now `delayMs: 0` (no wait) when no concrete recovery
  signal is present; the guard's own bounded attempts/deadline, not an
  arbitrary fixed wait, own the worst-case exposure.

### What is *not* a divergence

- Admission control (`acquire()`/`release()`, the 12-active-slot default via
  `GUARD_MAX_ACTIVE`/`CCFLARE_GUARD_MAX_ACTIVE`) matches R20's requirement to
  preserve legacy admission behavior and is intentionally unchanged.
