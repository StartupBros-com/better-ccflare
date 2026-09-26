---
title: Codex model-unsupported errors can mean stale client identity
date: 2026-09-24
category: integration-issues
module: codex-provider
problem_type: integration_issue
component: proxy
symptoms:
  - "New models appear in a Codex CLI catalog but proxy inference rejects them."
  - "HTTP 400 says the model is not supported when using Codex with a ChatGPT account."
  - "A successful Astra fallback hides unsuccessful attempts to serve Sol."
root_cause: config_error
resolution_type: code_fix
severity: high
tags:
  - codex
  - client-identity
  - model-discovery
  - inference
  - fallback
  - chatgpt-backend
---

# Codex model-unsupported errors can mean stale client identity

## Problem

A newer installed Codex CLI advertised GPT-6 Sol and Luna, but better-ccflare's
older outbound client identity received model-unsupported errors. The error looked
like an account entitlement restriction; changing the proxy's client identity
allowed the same account to serve the same minimal requests.

Three facts must stay separate: the installed CLI version, the proxy's **upstream
client identity**, and successful inference. Catalog visibility is not proof of the
third, and updating the first does not necessarily change the second.

## Symptoms

The September 24, 2026 investigation obtained this upstream detail:

> The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.

Luna returned the corresponding model-specific message. Exactly four authorized
requests used one account and the same tiny, tool-free request shape. Only the
requested model and the coupled `Version`/`User-Agent` version fields varied:

| Requested model | Client identity | Observed result |
| --- | --- | --- |
| `gpt-6-sol` | `0.154.0` | HTTP 400, model-not-supported detail |
| `gpt-6-sol` | `0.156.0` | HTTP 200, `response.completed`, reported Sol |
| `gpt-6-luna` | `0.154.0` | HTTP 400, model-not-supported detail |
| `gpt-6-luna` | `0.156.0` | HTTP 200, `response.completed`, reported Luna |

After the fix was deployed, an independent read-only observation found **27/27
ordinary Sol requests successful and stream-complete on a different account**.
No natural Luna requests appeared in that observation window. The dated evidence
and deployment verification are recorded in [issue #378](https://github.com/StartupBros-com/better-ccflare/issues/378#issuecomment-5818899985).

## What Didn't Work

- **Updating only the installed CLI.** The proxy has its own compiled
  `CODEX_VERSION` and derived `CODEX_USER_AGENT`
  (`packages/providers/src/providers/codex/client-identity.ts:4-5`), and it never runs
  the installed CLI.
  - Since #384, the identity resolves from an explicit `CCFLARE_CODEX_CLIENT_VERSION`,
    then a verified-version record named by `CCFLARE_CODEX_VERIFIED_VERSION_FILE`, then
    that compiled default (`client-identity.ts:186-240`).
  - Nothing writes that record until the CLI updater (dotfiles #1377) exists, so a CLI
    update alone still leaves the proxy on the compiled version.
- **Treating a newer CLI's catalog as inference proof.** A listing establishes
  what that catalog request advertised, not what an older proxy identity can
  invoke. This investigation did not establish that the older identity's catalog
  advertised the same models.
- **Treating the final HTTP 200 as proof of the requested model.** Sonnet requests
  could fail on Sol and then complete on Astra. Check physical `routed_model`, the
  fallback rung, and stream completion, not just client-visible success.
- **Expecting existing traces to contain the rejected JSON body.** The planned
  model-unavailable path can retain a response for terminal delivery or discard
  it when superseded (`packages/proxy/src/handlers/proxy-operations.ts:6475-6501`).
  The non-SSE Codex trace records `http_<status>` and status text, not the parsed
  upstream error detail (`packages/providers/src/providers/codex/provider.ts:3331-3349`).
  Existing records recovered HTTP 400, but the precise reason required the bounded,
  explicitly authorized comparison. This observability limitation was **not**
  repaired by the identity change.

## Solution

[PR #377](https://github.com/StartupBros-com/better-ccflare/pull/377) advanced the
existing shared compatibility constant:

```diff
-export const CODEX_VERSION = "0.154.0";
+export const CODEX_VERSION = "0.156.0";
```

The proxy's catalog and inference paths already shared this constant; they were
consistently **stale**, not independently versioned. The change advanced all of them.
Since #384 the constant lives in `client-identity.ts`, and each path reads the resolved
identity rather than the constant directly:

- Inference `Version` and the derived `codex-cli/...` user agent:
  `packages/providers/src/providers/codex/provider.ts:2645-2648`.
- Provider model-list URL:
  `packages/providers/src/providers/codex/provider.ts:2610-2612`.
- Account catalog query and its distinct `codex_cli_rs/...` user agent:
  `packages/proxy/src/codex-model-catalog.ts:364-386`.

Regression tests assert the literal compiled version, replacement of stale inbound
identity headers, and catalog/inference version parity. The catalog response is
mocked: those assertions verify request construction, not live model entitlement
(`packages/providers/src/providers/codex/provider.test.ts:239-262`;
`packages/proxy/src/__tests__/codex-model-catalog.test.ts:208-239`). The fix is merged
and deployed; it did not change mappings, credentials, fallback policy, or tool schemas.

## Why This Works

The paired observations demonstrate acceptance of the newer coupled identity for
these requests where the older one was rejected. They do not identify which header
was decisive, establish a minimum supported version, or exclude time-dependent
backend behavior: there was one observation per cell, without randomized order.

The lesson is to investigate software identity before interpreting this error as
an account-wide prohibition—not to assume every model-unsupported error is caused
by a stale version. Natural Sol completions extend the evidence beyond the probe
account; they do not certify every account, full-context/tool path, or Luna's
post-deployment routing.

## Prevention

1. Compare the deployed proxy's outbound identity with the working client's
   identity. Do not infer production behavior from a locally installed CLI or a
   source branch that has not been deployed. Since #384, the admin
   `GET /api/config/provider-model-defaults` reports the effective identity as
   `codexClientIdentity`: version, source (`explicit`, `verified` or `default`) and freshness.
2. Keep version-parity tests across both catalog implementations and inference,
   while preserving their intentionally different user-agent formats. Literal
   expectations must supplement comparisons derived from the same constant.
3. Treat catalog visibility, account-scoped inference acceptance, and a completed
   physical-model stream as distinct evidence. A successful fallback proves only
   the lane that actually completed.
4. Investigate existing records first. If they cannot recover the failure, obtain
   explicit authorization for a bounded comparison on a non-Anthropic account;
   never replay customer conversations or treat an exhausted probe budget as reusable.
5. Keep automation separate from this static compatibility repair.
   [better-ccflare #370](https://github.com/StartupBros-com/better-ccflare/issues/370)
   shipped the proxy side in #384: one resolved identity is shared by inference and
   catalog negotiation, fed by a verified-version record.
   [dotfiles #1377](https://github.com/StartupBros-com/dotfiles/issues/1377), which
   writes that record after a verified CLI update, is still open. Until it ships and
   the service points at the record, the identity stays at the compiled default and a
   version bump still needs a code change. A new identity still does not prove support
   for arbitrary new protocol fields or hosted tools.

## Related Issues

- [Fix and regression coverage: #376](https://github.com/StartupBros-com/better-ccflare/issues/376).
- [Cache affinity needs a session-id header](codex-cache-affinity-needs-session-id-header.md):
  another wire-metadata problem, but a different cause and remedy; do not replace
  its cache evidence with this model-availability result.
- [Route-profile physical-model admission](route-profile-expected-physical-model-checked-before-provider-defaults.md):
  a pre-dispatch mapping constraint, distinct from this upstream rejection.
