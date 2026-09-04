---
title: Bun 1.4.0 matched the streams spec and Node socket semantics, breaking tests that relied on 1.3 quirks
date: 2026-09-04
category: workflow-issues
module: test-suite
problem_type: workflow_issue
component: testing_framework
severity: high
applies_when:
  - Bumping the Bun version the CI gate runs on (`bun-version:` in `.github/workflows/managed-routing-postgres.yml`)
  - Asserting that an upstream `ReadableStream` cancel hook ran after cancelling a stream that goes through `pipeThrough` / `TransformStream` / `tee`
  - Spying on a `Response.body` instance captured before `response.clone()`
  - Writing a `node:net` server fixture whose teardown awaits `server.close()`
  - A fixture carries a hard-coded `verifiedAt` / `revalidateAfter` window
symptoms:
  - "claude-code-ping-compat: expect(cancelled).toHaveBeenCalledWith('client gone') fails only on Bun 1.4.0"
  - "deploy-ccflare gateway probes time out at 5s/15s on Bun 1.4.0 (and Node); server.close() never calls back"
  - "process-response: getReaderCalls is 0 on Bun 1.4.0, 1 on Bun 1.3.14"
  - "server-tool-capabilities throws 'Invalid provider server-tool capability decision' on every Bun version from 2026-09-04"
  - "run-ccflare-stack 'never triggers from a stale PID' logs 'RSS recycle trigger' in CI but passes locally"
root_cause: runtime_semantics_change
resolution_type: test_fix
related_components:
  - proxy
  - providers
  - scripts
  - ci
tags:
  - bun-1.4
  - whatwg-streams
  - cancel-propagation
  - node-net
  - response-clone
  - time-bomb-fixture
  - toctou
---

# Bun 1.4.0 matched the streams spec and Node socket semantics, breaking tests that relied on 1.3 quirks

## Context

Issue #231: `bun-version: latest` on the managed-routing gate silently moved to Bun 1.4.0,
which reimplemented web streams natively ("pass 100% of the Web Platform Tests") and rewrote
`node:net` / `node:http` for Node parity. Three suites that no PR had touched went red, and the gate was
pinned to 1.3.14 in PR #230 to stay usable. PR #319 removed the pin after fixing the root
causes below. Every finding was reproduced on an unchanged tree with both
`~/.local/share/mise/installs/bun/1.3.14/bin/bun` and `.../1.4.0/bin/bun`.

### 1. Cancel through a `TransformStream` propagates one microtask *after* `await reader.cancel()`

```ts
const out = new Response(new Response(src).body.pipeThrough(new TransformStream())).body;
await out.getReader().cancel("client gone");
// Bun 1.3.14: src.cancel("client gone") has already run.
// Bun 1.4.0 and Node 24: it runs after one more microtask.
```

This is the spec, not a regression. `TransformStreamDefaultSourceCancelAlgorithm` errors the
writable side inside a "React to cancelPromise" step, and `ReadableStreamPipeTo` cancels the
source in its own reaction to the writable becoming errored. At least one promise-reaction hop
is mandatory, so no engine may run the source hook synchronously. Bun 1.3.x was the outlier.
Production code is unaffected: the proxy only needs eventual propagation. A test that asserts
the hook *immediately* after `await cancel()` is asserting a non-guarantee.

### 2. A `node:net` server socket that never reads its input stays open after `socket.end(data)`

A `net.createServer((socket) => socket.end(raw))` fixture answers curl correctly, but the
server-side socket never surfaces the peer's FIN: no `end`, no `close`, and `server.close(cb)`
waits for that connection until the test times out. Measured on the same script:

| runtime | `end(raw)`, never read | `on("data")` or `resume()` first | `end(raw, () => destroy())` |
|---|---|---|---|
| Node 24.12 | hangs | end, close | close |
| Bun 1.3.14 | end, close | end, close | end, close |
| Bun 1.4.0 | hangs | end, close | end, close |

So this is Node parity, not a regression. Bun 1.3.x auto-resumed accepted sockets; Bun 1.4.0
stopped doing that (breaking-changes tracker oven-sh/bun#28792, PR #36332: "An accepted socket
with buffered payload + peer FIN now stays open until the app reads (then 'end' fires and the
normal allowHalfOpen / autoDestroy path closes it) or destroys it, matching Node."). The
fixture never reads curl's request bytes, so the paused socket holds them and the
FIN is never observed. `closeAllConnections()` is an `http.Server` method and does not exist
on `net.Server`. In-process `node:http` fixtures in this repo already track and destroy their
sockets, and the runner fixtures execute under a child Node/Bun process, so nothing else moved.

### 3. `Response.clone()` now swaps in a tee branch, per spec

```ts
const body = resp.body; resp.clone();
resp.body === body   // Bun 1.3.14: true (and `body` stays unlocked)
                     // Bun 1.4.0: false (`body` is locked by the tee; resp.body is a new branch)
```

An instance spy installed on the pre-clone stream therefore never sees the post-clone read.
The OpenAI JSON drain test counted `getReader()` on that instance and read 0.

### Two unrelated failures surfaced by the same gate run

- `server-tool-capabilities` shared a proof fixture with `revalidateAfter: "2026-09-04T00:00:00Z"`
  and one test let `materializeProviderServerToolCapabilityDecision` default `now` to the wall
  clock. Green on 2026-09-01, red on 2026-09-04, on every Bun version.
- `run-ccflare-stack` "never triggers from a stale PID" raced the watchdog: `rss_watchdog` read
  the `/proc` start-time identity, then several subshells later read `VmRSS`. A stale identity
  written between the two reads was charged with the new RSS. Seen once in CI (run 33838897966),
  never locally.

## Guidance

**1. Await propagation; never assume ordering across a pipe.** Resolve a promise from the
source's `cancel` hook and await it with a bounded deadline (see `settledWithin` in
`packages/proxy/src/__tests__/claude-code-ping-compat.test.ts`). Mutation-check the test:
passing `{ preventCancel: true }` to the pipe must make it fail with the deadline error.

**2. `node:net` fixtures hang up explicitly.** `socket.end(raw, () => socket.destroy())`.
The flush callback fires after the data reached the kernel, so the peer still receives the
full response on Node and both Bun versions. A fixture that never reads its input cannot rely
on the peer's FIN to release `server.close()`; reading (`resume()`) would also work, but
destroying is the honest expression of `Connection: close`.

**3. Spy on `ReadableStream.prototype`, not on a body instance you captured before `clone()`.**
Record `this` per call and assert the reader was taken on `response.body` (the discarded
original branch) with zero `cancel()` calls anywhere. Restore the prototype in `finally`.

**4. Fixtures with validity windows must pin `now`.** Pass an explicit in-window instant to
anything that defaults to `new Date()`; never let a hard-coded `revalidateAfter` decide when
the suite starts failing. Grep for near-future ISO dates before they expire:
`grep -rn "2026-1[0-2]-\|2027-" --include='*.test.ts' packages apps scripts tests`.

**5. Non-atomic `/proc` reads re-check identity after the sample.** The watchdog now
re-reads the start-time identity after `VmRSS` and discards the sample on mismatch, which also
makes the stale-PID test deterministic because its stale write strictly precedes its RSS bump.

**6. Bun version bumps: run the gate's own loop, not `bun test`.** A single `bun test` over
the repo reported ~1,600 failures under 1.4.0 that are batch-only `mock.module` artefacts. The
gate runs each file in its own process; mirror that (`for f in ...; bun test --timeout 15000 "$f"`)
to get the real breakage list, then re-run each failure alone under both versions to separate
deterministic regressions from load flakes (`incremental-vacuum-adaptive` needs ~16s per test
on a loaded WSL2 box against a 15s timeout on either version).

## Verification

```bash
for v in 1.3.14 1.4.0; do B=~/.local/share/mise/installs/bun/$v/bin/bun
  $B test packages/proxy/src/__tests__/claude-code-ping-compat.test.ts
  $B test scripts/__tests__/deploy-ccflare.test.ts
  $B test packages/providers/src/providers/openai/__tests__/process-response.test.ts
  $B test packages/providers/src/server-tool-capabilities.test.ts
  $B test scripts/__tests__/run-ccflare-stack.test.ts
done
```

All five suites pass on both versions after PR #319; `proxy-operations-failover` had already
been fixed for 1.4.0 by `1e343ddd` (drain deadline no longer releases the lock ahead of the
outstanding read).
