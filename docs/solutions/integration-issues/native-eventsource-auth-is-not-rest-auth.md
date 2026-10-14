---
title: Native EventSource authentication is not REST authentication
date: 2026-10-13
category: integration-issues
module: dashboard-stream-auth
problem_type: integration_issue
component: authentication
symptoms:
  - "Requests and Alerts history reads returned 200 while their native browser streams returned 401"
  - "Logs streamed successfully through an existing scoped-token path, hiding incomplete sibling coverage"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
tags: [dashboard, sse, eventsource, authentication, stream-token, reconnect, browser-validation]
---

# Native EventSource authentication is not REST authentication

## Problem

The dashboard's authenticated REST path and its native browser stream path were different authentication surfaces. Successful history reads, header-authenticated CLI stream checks, and tested reconnect behavior did not establish that the browser could authenticate every stream.

This matters when maintaining Requests, Alerts, or Logs, especially after importing upstream lifecycle changes. The durable lesson is the misleading evidence and sibling-caller gap, not the token implementation itself.

## Symptoms

- In [#479](https://github.com/StartupBros-com/better-ccflare/issues/479), normal stored-key Requests reads returned 200, the native Requests stream returned 401, and Logs worked through its existing token mechanism. The Requests gap was observed on the preceding deployment too; it was not established as a regression introduced by the upstream integration.
- After the Requests fix shipped, [#483](https://github.com/StartupBros-com/better-ccflare/issues/483) exposed the same REST-200/native-stream-401 split in Alerts. Fixing one caller had not covered its siblings.

## What Didn't Work

- **Using REST success as stream-auth evidence.** Those requests used different credential transports. A working history panel could conceal a permanently disconnected live feed.
- **Using a header-authenticated CLI SSE check as browser proof.** It proved the route accepted a header, not that native `EventSource` sent one. Adding global authentication headers in browser automation would similarly bypass the path being tested.
- **Treating lifecycle improvements as an authentication fix.** More reconnect attempts and keepalives could not make an unauthenticated initial connection succeed. The upstream lifecycle work and this pre-existing integration gap were separate.
- **Stopping at Requests because Logs already worked.** The subsequent Alerts failure demonstrated why the complete native-stream caller set mattered.

A later blocked dashboard run was a different limitation, not evidence that stream authentication still failed: the startup stats request did not complete, so the relevant UI children never mounted.

## Solution

Reuse the existing Logs mechanism for all three dashboard streams rather than adding an authentication exemption or putting a durable API key in a URL. [#482](https://github.com/StartupBros-com/better-ccflare/pull/482) and [#484](https://github.com/StartupBros-com/better-ccflare/pull/484) are merged; both fixes are present in the tree used for this capture.

The shared client entry point is `packages/dashboard-web/src/api.ts:981`: when a stored key exists, `createEventSource(audience)` authenticates a mint POST through the ordinary API client, then opens native `EventSource` with the returned ephemeral token. The router handles the mint only after normal authentication and authorization (`packages/http-api/src/router.ts:680`).

The server binds tokens to a stream audience, gives them a 60-second unused lifetime, and consumes them synchronously before database awaits. With authentication enabled, consumption checks the issuing key's current active admin authority; the token is not a snapshot of a previously granted role (`packages/http-api/src/services/auth-service.ts:85`, `packages/http-api/src/services/auth-service.ts:257`, `packages/http-api/src/services/auth-service.ts:457`). Ordinary header/Bearer authentication and no-key bootstrap behavior remain separate supported paths.

A reconnect must obtain a fresh token, not reuse the consumed URL. Token minting also makes connection creation asynchronous: an obsolete result must be closed instead of attached after disable/unmount. Alerts implements those checks and fresh-mint retries in `packages/dashboard-web/src/hooks/useAlertStream.ts:40`. This is not a claim that Alerts has the Requests hook's online/visibility listeners.

## Why This Works

The fix aligns the actual browser credential transport with the existing server authorization boundary. It does not infer stream access from a successful REST request, relax the stream routes, or require native `EventSource` to support custom headers. A single shared constructor also exposes the caller inventory instead of leaving each feature with an independent authentication path.

There are still two distinct live-evidence boundaries:

- **Native protocol acceptance:** the [post-deployment receipt](https://github.com/StartupBros-com/better-ccflare/issues/483#issuecomment-6158543691) records successful authenticated mint/stream responses for Alerts twice, Requests, and Logs, with four distinct tokens, four sources closed, and zero protocol errors. Anonymous Alerts mint and stream requests returned 401. These were non-inference checks.
- **Actual dashboard lifecycle acceptance:** not established by those connections. In the same validation, authenticated stats stayed pending across two 30-second waits, preventing dashboard children from mounting. The client awaits stats during its initial auth check and withholds routes until it completes (`packages/dashboard-web/src/App.tsx:243`, `packages/dashboard-web/src/App.tsx:316`, `packages/dashboard-web/src/App.tsx:358`). [#480's receipt](https://github.com/StartupBros-com/better-ccflare/issues/480#issuecomment-6158527029) leaves the latency cause unresolved.

Thus, no mint/stream request in a blocked UI run can mean the hook never ran; it does not identify an authentication failure. Conversely, opening native connections separately establishes transport behavior, not component mounting, offline recovery, or visual correctness.

## Prevention

1. Trace every native `EventSource` construction and every caller of the shared stream factory, including Logs, Requests, and Alerts. A shared helper is not proof that all consumers actually use it.
2. Check REST and native stream authentication independently using the browser's normal stored-key behavior. Do not inject global headers that make the test client more capable than the real client. Never include durable credentials in URLs or evidence output.
3. Preserve separate tests for mint authorization, audience/exact-method/exact-path confinement, expiration, single-use concurrency, issuer revocation/downgrade, and bootstrap/header compatibility. Relevant coverage is in `packages/http-api/src/services/__tests__/auth-service-logs-stream-token.test.ts` and `packages/http-api/src/__tests__/router-stream-token.test.ts`.
4. Exercise fresh-token reconnects and late asynchronous completion after disposal as well as initial connection success. The client factory and Alerts lifecycle suites are `packages/dashboard-web/src/api-stream.test.ts` and `packages/dashboard-web/src/hooks/__tests__/useAlertStream.lifecycle.test.ts`.
5. Before interpreting a missing stream, verify that the component mounted and attempted its mint/connection. Report blocked UI acceptance separately from protocol checks. Do not turn a successful isolated transport check into a claim that the dashboard works end to end.

This learning serves engineers changing dashboard stream authentication and its browser acceptance checks. Retire or rewrite the transport-specific diagnosis if the dashboard no longer uses native EventSource with header-authenticated REST; re-check the mounting discussion if startup stops depending on stats. It adds no separate release gate or evidence ledger.

## Related Issues

- [#479 Requests authentication](https://github.com/StartupBros-com/better-ccflare/issues/479), [#483 Alerts authentication](https://github.com/StartupBros-com/better-ccflare/issues/483), and [#480 unresolved stats latency](https://github.com/StartupBros-com/better-ccflare/issues/480).
- [Selected upstream integration closeout](https://github.com/StartupBros-com/better-ccflare/issues/473#issuecomment-6158857919): delivered integration scope is not a claim that every discovered dashboard problem is resolved.
- [Per-unit gates hide cross-unit regressions](../workflow-issues/per-unit-gates-hide-cross-unit-regressions.md): related evidence-completeness lesson, but isolated repository tests do not replace validation of browser credential transport.
