---
title: Claude Code's Fable usage-credits prompt was armed by a proxied response header, not the login account's quota
date: 2026-10-05
category: integration-issues
module: upstream-integration
problem_type: integration_issue
component: proxy
symptoms:
  - "Background Claude Code sessions on Fable 5.1 switched model or ended the turn with 'Fable 5.1 now uses usage credits · the prompt to confirm went unanswered — nothing was sent'"
  - "The session log recorded a model_consent_fallback event after the consent dialog expired unanswered"
  - "It hit 2 of 84 background Fable sessions between 2026-10-01 and 2026-10-05, and the proxy returned no 4xx or 429 to either session near the switch"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
framework_version: claude-code 2.1.289
related_components:
  - guard
  - usage-collector
  - quality-routing
retire_when: "Claude Code changes which responses set its Fable usage-credits latch; after a Claude Code upgrade, check the installed binary's strings for 'fableCreditsRequired' and 'anthropic-ratelimit-unified-overage-in-use' (both strings still present in 2.1.290; setter behavior not re-read there)"
tags:
  - claude-code
  - fable
  - usage-credits
  - consent-latch
  - response-headers
  - guard
  - overage-in-use
  - client-trigger
---

# Claude Code's Fable usage-credits prompt was armed by a proxied response header, not the login account's quota

## Problem

Now and then, a background Claude Code session running Fable 5.1 behind the proxy stopped using Fable. Claude Code held the next Fable turn on a "Fable now uses usage credits" consent dialog. In a background session nobody answers it, so it expired and the session switched model or ended the turn.

#444 and PR #445 assumed the Claude Code login account's own weekly Fable allowance drove the prompt. They built a per-account cap to keep that account from draining. Nobody checked that premise against the client. Reading the client showed that proxied responses arm the prompt, so PR #451 reverted the cap and drops one response header at the guard. The tracking issue is #450.

Status as of this writing: PR #451 was deployed on 2026-10-06 at 01:25Z. Confirmation is pending on #450. The bar is zero `model_consent_fallback` events in background Fable sessions through 2026-10-13.

## Symptoms

- Two background Claude Code 2.1.289 sessions on Fable 5.1 showed the synthetic message "Fable 5.1 now uses usage credits · the prompt to confirm went unanswered — nothing was sent" (auto memory [claude]):
  - The first, on 2026-10-04 at 00:33Z, ended the turn (`choice: cancelled`).
  - The second, on 2026-10-05 at 01:56Z, switched to the default model (`choice: switch_default`).
  - Both session logs recorded event subtype `model_consent_fallback`.
- These were 2 of 84 background Fable sessions from 2026-10-01 to 2026-10-05.
- The proxy side looked healthy. Every proxied Fable call near both switches returned 200, and the proxy sent neither session a 4xx or a 429 (auto memory [claude]).
- One fact pointed at the wrong cause. The Claude Code login is itself one of the pool's Max accounts, and both its weekly Fable window and its all-models window were at 100% at both incidents.

## What Didn't Work

- **Capping the login account's usage windows (#444, PR #445).**
  - What it built: an `account_window_caps` config, an evaluator that read inactive `limits[]` rows, and a blocker on every route path, including the native quota-wait combo. It also added a 503 lane for cap-only exhaustion and an engage/release logger.
  - It was deployed on 2026-10-05 at 21:01Z with caps on the login account. PR #451 reverted it the same night.
  - It aimed at the wrong channel: the consent dialog never reads the login account's quota (see Why This Works).
  - The plan is kept, marked superseded, at `docs/plans/2026-10-05-0117-feat-account-usage-window-cap-plan.md`. Its follow-ups #446 and #448 were closed as not planned, since the code they described is gone.
- **Treating any response from an exhausted account as the trigger.** Since 2026-10-01, 61 of 204 sessions got responses from Fable-exhausted accounts, and only 2 switched. So exhaustion headers alone do not arm the prompt (auto memory [claude]).
- **Consenting once.** Claude Code stores consent globally in `~/.claude.json` (`fableOverageConsentV2`). It honours that consent only when extra usage is enabled, or disabled for one of a few recoverable reasons. The login's org has extra usage disabled at the org level (`org_level_disabled`), so consenting changes nothing. This was read in the 2.1.289 binary.
- **Quality routing policy lines.** `quality_routing_policy.accounts[].lines` applies to Auto routes only. Claude Code sends the native `claude-fable-5-1` model, which never goes through Auto (auto memory [claude]).

## Solution

PR #451 makes the guard drop one response header. The guard is the last hop before the client.

```js
// scripts/ccflare-guard.mjs:106
export const UNIFIED_OVERAGE_IN_USE_HEADER =
	"anthropic-ratelimit-unified-overage-in-use";

// responseHeaders() (:403) skips it alongside the guard's internal headers (:414)
	lower === UNIFIED_OVERAGE_IN_USE_HEADER
```

- **The backend still records the upstream value before the guard strips it.** The `requests.unified_ratelimit_headers` column holds the bounded `anthropic-ratelimit-unified-*` headers of each successful Fable 2xx (`captureUnifiedRatelimitHeaders`, `packages/proxy/src/usage-collector.ts:233`). This capture came with #445 and was kept.
- **The cap is gone.** #445's cap was removed from both the code and the live config.
- **A test pins the strip.** `scripts/__tests__/ccflare-guard.test.ts:1091` checks that the header is dropped and that the other unified headers still reach the client.

## Why This Works

What follows was read in the Claude Code 2.1.289 binary on 2026-10-05. It describes client internals, not code in this repo.

- **Two things raise the dialog.** One is a GrowthBook flag, `tengu_saffron_lattice`. The other is a process-wide latch, `accountCreditLatches.fableCreditsRequired`. The flag was cached as off on the machine where this was read.
- **The latch has exactly two setters**, and both act on `/v1/messages` responses, which all pass through the proxy:
  1. a Fable 200 that carries `anthropic-ratelimit-unified-overage-in-use: true` while the client is not itself using overage;
  2. a 429 whose body says `credits_required`, or says `seven_day_overage_included` with no rate-limit type.
- **Even the quota probe goes through the proxy.** The client's quota probe is a 1-token `/v1/messages` call.
- **Only a reset clears the latch.** A background process that runs for days therefore stays latched after one bad response.

The header describes the pool account that served that request, not the client's login. So behind a pool, one response served by an account with overage in use arms the prompt for the whole client process. Dropping the header at the last hop closes setter 1. The login account's quota never reaches either setter, which is why capping it could not help.

Not covered:

- **Setter 2 is still open.** A `credits_required` 429 still reaches the client on a quality route, because quality attempts deliver unproven 429s rather than fail over (`packages/proxy/src/handlers/proxy-operations.ts:8143`). None of the 56 quality-routed requests on record by 2026-10-05 was a 429.
- **The server flag.** No proxy change can affect it.
- **The header has not been seen in traffic.** No captured Fable response has carried `overage-in-use: true` yet: 0 of 45 by 2026-10-05. This channel was closed by reading the client code.

## Prevention

- **For a client-side symptom, find the client's actual trigger before building proxy machinery.** When Claude Code shows a prompt, a banner or a model switch, search the installed binary for the message text and read what sets it. #445 shipped a config, an evaluator, route blockers, a 503 lane and a logger on a premise nobody had checked. Searching the client would have pointed at the response headers. The fix at the proxy edge was a few lines.
- **Behind a pool, a rate-limit header describes the serving account, not the client.** Any `anthropic-ratelimit-unified-*` header that Claude Code acts on can mislead it. When an upgrade makes the client start acting on a new one, decide whether the guard should pass it through.
- **If it comes back, check in this order.** Do not treat it as pool exhaustion, and do not re-add a per-account cap.
  1. Check that the deployed guard still strips the header: run `rg -F UNIFIED_OVERAGE_IN_USE_HEADER` on the pinned `guards/<sha>/ccflare-guard.mjs` under `~/.config/better-ccflare`.
  2. Check whether a 429 carrying `credits_required` or `seven_day_overage_included` reached the session through a quality route.
  3. Check for `tengu_saffron_lattice` among the cached GrowthBook features in `~/.claude.json`.

  For steps 1 and 2, this query reads the database without writing anything:

  ```sql
  -- sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db
  SELECT datetime(timestamp/1000, 'unixepoch') AS t_utc, model, status_code,
         unified_ratelimit_headers, error_message
  FROM requests
  WHERE unified_ratelimit_headers LIKE '%overage-in-use":"true"%'
     OR status_code = 429
  ORDER BY timestamp DESC LIMIT 20;
  ```

- **Re-check the latch setters after a Claude Code upgrade.** The `retire_when` field gives the strings to look for.

## Related Issues

- #450: the tracking issue for the fix. It stays open until the confirmation window closes on 2026-10-13.
- PR #451: the guard strip, plus the revert of the cap.
- #444 (closed as not planned) and PR #445: the per-account cap and its premise.
- #446 and #448: follow-ups to the cap, closed as not planned when the cap was removed.
- Two other cases where the fix depended on what the Claude Code client does with a proxy response:
  - [Claude Code /advisor was refused as an unsupported server tool](claude-code-advisor-refused-as-unsupported-server-tool.md)
  - [Claude Code WebSearch was refused as no_implementation](claude-code-websearch-refused-as-no-implementation.md)
- [Rate-limit holds: scope, duration, and evidence](../rate-limit-scope-and-duration.md): how the proxy reads rate-limit headers when it holds an account back. This doc is about what the client does with them.
- [Validate provider logic against live payloads](../validate-against-live-payloads.md): why #445's evaluator had to read inactive `limits[]` rows.
