---
title: Settle an outstanding stream read before releasing a deadline-expired lock
date: 2026-08-31
category: performance-issues
module: stream-drain
problem_type: performance_issue
component: providers
severity: high
applies_when:
  - A helper races a stream read or liveness-owned handoff against a cleanup deadline
  - The deadline path owns the abort controller for the exact fetch transport that produced the reader
  - Cleanup must release a reader lock without leaving a native fetch body touched but unobserved
symptoms:
  - A deadline wins while the read remains pending, and immediate lock release rejects only the JavaScript promise rather than settling the native source lifecycle.
  - Bun native-fetch cleanup can show growing RSS or retained off-heap buffering while the JavaScript heap remains comparatively flat.
  - A Codex liveness reconciliation can still own a pending read when drain cleanup reaches its deadline.
root_cause: concurrency
resolution_type: code_fix
related_components:
  - proxy
  - codex_provider
  - anthropic_terminal_recovery
tags:
  - readable-stream
  - reader-read
  - release-lock
  - deadline
  - abort-controller
  - bun-native-fetch
  - response-clone
  - weakmap-ownership
---

# Settle an outstanding stream read before releasing a deadline-expired lock

## Problem

A cleanup deadline can win while `ReadableStreamDefaultReader.read()` is still pending. The broken shape races an anonymous read against the deadline, aborts the transport, and falls through to `reader.releaseLock()` without retaining the promise that represents the in-flight operation.

Releasing a reader lock rejects an outstanding read but does not itself abandon the underlying transport. A native fetch source can therefore outlive the JavaScript reader. The current implementation records this “touched then abandoned” distinction in `packages/providers/src/utils/stream-drain.ts:191-200`.

PR #288 shipped the complete fix: both shared drain helpers and the Codex liveness handoff now retain every outstanding read, abort the exact owning transport, wait one bounded settlement-grace window, and only then release the lock.

## Symptoms

- Deadline cleanup releases the lock before a pending read's fulfillment or rejection is observed.
- A liveness handoff such as Codex `beforeDrain` still owns a read when the cleanup deadline expires.
- Bun native-fetch workloads may show comparatively flat JavaScript heap with rising native RSS or off-heap buffers after streams are touched and abandoned.

The ordering defect is proven by deterministic tests. The RSS shape is compatible operational context, not proof that this race caused any particular live RSS episode. A separate production investigation associated large-context traffic with Bun native/backing-store high-water near the physical fetch boundary; clone/rewrite experiments did not prove this lock-release path was the cause (session history).

## What Didn't Work

1. **Race an anonymous read.** If `reader.read()` is placed directly in `Promise.race()`, the deadline path has no retained promise to observe or await.
2. **Abort and release immediately.** Transport abort is asynchronous; it is not a settlement barrier.
3. **Wait indefinitely.** A source can ignore abort. Cleanup must remain bounded rather than turning shutdown or retry disposal into a hang.
4. **Share abort authority across clones.** A discarded `Response.clone()` tee must not abort its live sibling. One earlier evidence-capture path left an abandoned tee branch and blocked Codex failover cleanup (session history).
5. **Treat `beforeDrain` as unrelated pre-work.** Codex uses it to reconcile a liveness-owned read. When that promise loses the deadline race, it needs the same post-abort settlement grace as a read started inside the helper.
6. **Trust every extra failing suite immediately.** One discard-body test failed because a fresh worktree loaded provider utilities from another checkout, creating two response-ownership `WeakMap` instances. That was a module-resolution artifact, not a production ownership regression (session history).

## Solution

Apply one ownership protocol to every read the cleanup lifecycle can leave outstanding.

1. Resolve the deadline once. `drainReader` validates/defaults it (`packages/providers/src/utils/stream-drain.ts:16-21`); `drainReaderWithDeadline` shares its supplied budget across the liveness handoff and read loop (`packages/providers/src/utils/stream-drain.ts:122-131`).
2. Retain the exact promise before racing it:

   ```ts
   const pendingRead = reader.read();
   const outcome = await Promise.race([pendingRead, deadline]);
   ```

   Both helpers retain their read promises before the race (`packages/providers/src/utils/stream-drain.ts:104-113`, `187-206`).
3. If the deadline wins, abort only the controller that owns that transport. `drainReader` uses `transportAbort` and keeps `reader.cancel()` as a secondary best-effort signal (`packages/providers/src/utils/stream-drain.ts:88-101`). The deadline helper uses `drainAbort` (`packages/providers/src/utils/stream-drain.ts:199-203`).
4. Give the retained promise one additional interval equal to the resolved deadline. `awaitPendingReadSettlement` observes either fulfillment or rejection, races it against the grace timer, and clears the timer when either wins (`packages/providers/src/utils/stream-drain.ts:24-40`).
5. Release only in the outer `finally`, after normal draining, error propagation, or bounded deadline cleanup (`packages/providers/src/utils/stream-drain.ts:116-119`, `209-216`).
6. Retain `beforeDrain()` too. If that promise loses, abort the owning transport, await that same promise through one equal grace interval, then release the shared reader (`packages/providers/src/utils/stream-drain.ts:174-184`). Codex supplies its liveness handoff and explicitly selects best-effort swallowing (`packages/providers/src/providers/codex/provider.ts:3622-3637`).

Transport ownership is response-specific. The proxy registers the exact response-to-controller relationship when fetch returns (`packages/proxy/src/handlers/request-handler.ts:120-167`), and discard cleanup supplies that controller to the drain helper (`packages/proxy/src/handlers/discard-body-cancel.ts:68-92`). Same-body or sole-owner wrappers may transfer ownership; concurrent clones may not (`packages/providers/src/utils/stream-drain.ts:43-70`).

## Why This Works

The retained promise creates a completion boundary between “deadline fired” and “lock may release.” When abort settles the read, cleanup observes that settlement first. When a source does not cooperate, the grace timer preserves a hard upper bound: one primary deadline plus one equal settlement interval.

The settlement helper observes both fulfillment and rejection, so a late rejection cannot become unhandled, and it clears its timer whichever side wins (`packages/providers/src/utils/stream-drain.ts:24-40`). The outer helpers separately clear their primary timers and release the lock in `finally`.

Existing error contracts remain distinct:

- `drainReader` is cleanup-only and swallows read errors (`packages/providers/src/utils/stream-drain.ts:73-81`, `114-115`).
- `drainReaderWithDeadline` propagates by default; `swallowErrors: true` retains Codex's detached best-effort behavior (`packages/providers/src/utils/stream-drain.ts:141-152`, `209-214`).
- Anthropic terminal recovery omits `swallowErrors`, so its caller still owns errors (`packages/proxy/src/anthropic-terminal-recovery.ts:171-188`).

This protocol closes an ownership lifecycle. It does not claim that cancellation alone fixes every Bun RSS high-water case; draining to `done` remains the normal release path, while abort plus bounded settlement handles overdue outstanding operations.

## Prevention

### Start with event ordering, not RSS

Write deterministic proof-first tests that record events. The red test should show `release` before `read-rejection-observed` or before a retained pre-step settles. The green order is:

1. `read-started` or `prestep-started`
2. exact-transport `abort`
3. read fulfillment/rejection observed
4. `release`

Run the contract through both drain helpers (`packages/providers/src/utils/__tests__/stream-drain.test.ts:21-32`, `195-224`) and the dedicated `beforeDrain` case (`packages/providers/src/utils/__tests__/stream-drain.test.ts:370-410`).

Also prove:

- an unabortable read consumes exactly one primary deadline and one equal grace interval;
- early settlement clears primary and grace timers and emits no unhandled rejection;
- an unabortable `beforeDrain` starts no second read and remains bounded;
- finite streams do not abort and release exactly once;
- a clone has no inherited transport ownership and cannot consume or abort its live sibling; and
- default propagation and explicit `swallowErrors` behavior remain different.

### Review checklist

- Never inline a read or liveness handoff in a race when cleanup may need to settle it later.
- Abort the per-response or per-fetch controller only; do not infer ownership across a clone tee.
- Use one resolved deadline for exactly one settlement-grace interval—no retry loop and no unbounded wait.
- Keep lock release and timer cleanup in `finally`.
- Treat RSS as a follow-up signal, not proof of the ordering invariant.
- When a worktree-only test fails, verify module identity before changing ownership code; duplicated `WeakMap` state can mimic lost transport ownership.

## Related Issues

- PR #288 — shipped the two-helper settlement and liveness-handoff coverage.
- Issue #382 — earlier unread-clone and stream-lock work that established the native-buffer warning context.
- [SSE translation hot path and benchmark noise](sse-translation-hot-path-and-benchmark-noise.md) — related streaming performance guidance, but a different root cause and solution.
