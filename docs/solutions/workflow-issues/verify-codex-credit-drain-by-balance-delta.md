---
title: Verify a Codex credit drain by credit-balance deltas, and keep the 100% gate stricter than OpenAI's flags
date: 2026-10-03
category: workflow-issues
module: codex-credit-drain
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Verifying or debugging the per-account Codex credit drain (codex_credit_drain_enabled, the Accounts-page Drain credits switch)
  - Changing the hard capacity gate, or tempted to admit a Codex account at 100% because wham still reports allowed
  - A Codex account whose credits should be kept is losing OpenAI credits
  - An Auto or quality route refuses a Codex account that ordinary routes serve on credits
symptoms:
  - A forced request to a drain-enabled account returns 200 but credits_balance does not move
  - wham reports used_percent 100 with allowed true and limitReached false, then flips both after one more request
  - A kept account's credits_balance falls while no ccflare request reaches it
  - A spent drain-off Codex account is admitted right after a restart or while usage polls are failing
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - providers
tags:
  - codex
  - credit-drain
  - openai-credits
  - wham-usage
  - capacity-gate
  - force-route
  - codex-cli
---

# Verify a Codex credit drain by credit-balance deltas, and keep the 100% gate stricter than OpenAI's flags

## Context

A ChatGPT Pro (Codex) account can hold purchased OpenAI credits. Once its plan windows are spent, OpenAI keeps serving it and bills the credits instead. ccflare used to refuse every such account at 100%.

PR #421 (issue #419, deployed 2026-10-03) added a per-account opt-in, `accounts.codex_credit_drain_enabled`. Two ways to set it:
- the Accounts page's **Drain credits** switch (`packages/dashboard-web/src/components/accounts/AccountListItem.tsx:129`);
- `POST /api/accounts/:id/codex-credit-drain` with `{"enabled":0|1}` (`packages/http-api/src/router.ts:841`).

An opted-in account with fresh credit evidence keeps serving client traffic past its spent windows. Every other account is still refused once a fresh usage reading shows a spent window; §3 covers the gaps where that reading is missing.

The code and unit tests prove the gate. They don't show how to prove *billing*, how OpenAI's own flags behave at the boundary, or how credits can leave a kept account without passing through ccflare. Live validation on 2026-10-03 answered those questions. It used force-routed `gpt-6-astra` requests sent with `x-better-ccflare-account-id`, with all three Codex Pro accounts at 100% of `seven_day`. Codex's adversarial review of the implementation also caught one way the drain could spend credits nobody asked it to (session history).

## Guidance

### 1. Prove billing with `credits_balance` deltas, not status codes

Read `GET /api/accounts` (admin key) before and after a request. For each account, check:
- `usageData.credits_balance`;
- `usageData.codex_subscription.{allowed, limitReached, hasCredits}`;
- `codexCreditDrainEnabled`, `codexCreditDrainActive` and `codexCreditDrainServing` (`packages/http-api/src/handlers/accounts.ts:775-777`).

The balance changes only on the next wham poll, so re-read after one poll interval.

| Request (2026-10-03, every account at seven_day 100%) | Drain | Result | Balance change |
|---|---|---|---|
| Short forced request (16-token output cap), right after enabling | on | 200 | 0 |
| 1,276 output tokens, wham still `allowed:true` | on | 200 | −0.5205, then wham flipped to `allowed:false`, `limitReached:true` |
| 1,282 output tokens, sent while `limitReached:true` | on | 200 | −1.612 |
| Short forced request to a drain-off account | off | 503, `x-better-ccflare-force-route: unavailable`, `account_capacity_exhausted` | none |

The first 200 billed nothing: a 200 shows only that the gate admitted the request, not that credits paid for it. The third row is the only clean credits-only rate, about 1.6 credits for about 1.3k output tokens on that model. The second row's 0.52 credits may be the last of the plan allowance spilling into credits, but that is an inference; it wasn't measured.

Attribute a delta before trusting it. Any other client logged into the same ChatGPT account moves `credits_balance` too (§5). During the measurements above, the local Codex CLI was logged into a different account, and the requests table showed no other ccflare request to the measured one. Spending from other machines was not ruled out.

Routing never reads the balance. Credit evidence is `has_credits === true || unlimited === true`, and `balance` is used only for display (`packages/providers/src/providers/codex/api-usage.ts:185-203`).

### 2. Keep the 100% gate: OpenAI's flags lag `used_percent`

`evaluateHardCapacity` (`packages/proxy/src/handlers/usage-throttling.ts:712`) refuses a session or weekly window once its utilization reaches 100 (`:776`). It never reads wham's `allowed` or `limit_reached`, which are parsed at `api-usage.ts:144-145`. Only the Auto path reads those flags (`usage-throttling.ts:69-73`). The gate's own comments don't say why it is stricter than OpenAI; this doc is that explanation.

OpenAI's flags don't flip at 100:
- On 2026-10-03 one account read `used_percent` 100 with `allowed:true, limitReached:false`. The next sizeable request billed 0.5205 credits, and only then did the flags flip.
- On 2026-10-01, two other accounts already read `allowed:false` at 100% (session history). That fits flags that flip after the overflow, not at the boundary.

The gate's margin therefore protects accounts whose credits you are keeping. A gate that trusted `allowed:true` would have admitted that request on a kept account and spent its credits. Don't "fix" the gate to follow the flags. Whether wham rounds 99.x up to 100 was not measured.

### 3. Drain needs fresh, poll-owned evidence, checked on every request

`isCodexCreditDrainActive` (`usage-throttling.ts:215-232`) returns true only when all of these hold:
- the account's provider is `codex`;
- the flag is on;
- `usageCache.getCodexCreditEvidence(...)` returns `true` within `DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS`, which is three minutes (`:208`).

That evidence comes only from the account's own wham poll. It is `null` when missing, replaced or stale (`packages/providers/src/usage-fetcher.ts:1853-1874`), and passive header writes cannot produce it (`usage-throttling.ts:210-214`).

- **The refusal drain falls back to needs fresh evidence too.** Drain and the spent-window refusal run on different clocks:
  - Credit evidence is set only by the poll.
  - The usage snapshot the gate refuses from is set by the poll and also by the headers of every proxied Codex response that carries rate-limit headers (`packages/proxy/src/handlers/response-processor.ts:235`).
  - When that snapshot is older than three minutes, `evaluateHardCapacity` admits (`usage-throttling.ts:722-730`). With no snapshot at all, `evaluateCandidateCapacity` adds no capacity blocker (`account-selector.ts:1336`).

  This holds for every Codex account, drained or kept.
- **After a restart or deploy, the cache is empty until the first poll.** The first poll runs as soon as an account registers (`usage-fetcher.ts:1149-1156`) and writes the snapshot, plus the credit evidence when the payload carries credit facts, in one step (`:1003-1013`). Polls then repeat every 90 s ±20% (`:1138`, `:1064-1072`).
  - Before that first poll, any spent Codex account can be admitted.
  - Exception: a dashboard read of `GET /api/accounts` in that gap can seed the cache from stored response headers under a current timestamp (`packages/http-api/src/handlers/accounts.ts:202`, `:253`). Any Codex account whose recovered headers show a spent window is then refused until the first poll lands, drain-enabled accounts included, because none has credit evidence yet.
- **If polling fails, kept credits can leak.**
  1. Drain lapses three minutes after the last good poll.
  2. The account is refused while its snapshot is fresh.
  3. A refused account gets no responses, so its snapshot goes stale as well.
  4. The gate then admits it again, until an admitted response's headers refresh the snapshot.

  So during a poll outage a kept account can spend credits through ccflare. This is the gate's general stale-evidence behaviour, not something drain added.
- **Internal probes never drain.** Synthetic probes and trusted auto-refresh requests keep the spent-window gate (`packages/proxy/src/handlers/account-selector.ts:1337-1348`). Codex's adversarial review of PR #421 found that an earlier revision let an auto-refresh probe for an opted-in account spend credits (session history).

### 4. Know which routes drain

- **Drain applies wherever `evaluateCandidateCapacity` runs** (`account-selector.ts:1324`). That includes:
  - ordinary routing (`:1613`, `:1670`);
  - force routes (`:3168`);
  - combo members (`:3727`);
  - capability route-profile selection (`:2716`).

  Drain skips only the session and weekly-all windows. It does not lift per-model weekly caps (`usage-throttling.ts:775`), which bind wherever model-scoped capacity is enforced: on force routes, or when model-scoped capacity routing is set to `exhausted` (`account-selector.ts:1315-1322`).
- **Auto and quality routes never read the toggle.** They use `evaluateAutoCapacity` (`usage-throttling.ts:36`), called from `packages/proxy/src/handlers/quality-route-admission.ts:74` and `packages/proxy/src/quality-route-candidates.ts:364` and `:666`.
  - **A spent Codex account is refused with `provider-capacity-exhausted`** when wham reports `allowed:false` or `limitReached:true`, or when a window reads 100 (`usage-throttling.ts:68-70`, `:90-91`). That check runs before any spend grant is read, so no grant can route a spent Codex account through Auto.
  - **A Codex account with headroom needs an operator-approved `outside-subscription` spend grant**, unless its own poll shows no credits at all. Without the grant it is held as `spend-not-authorized` (`:173-179`, `:201-202`), because only owned no-credit evidence proves subscription-only safety (`:199-200`).
  - **This is by design.** Subscription-only Codex admission on those routes is the design of PR #404, so an Auto refusal of a spent account with credits is expected, not a drain bug.

### 5. Look outside ccflare when kept credits fall

The toggle governs only traffic ccflare routes. A Codex CLI on the same host calls OpenAI directly and bills whichever account it is logged into when both of these hold in `~/.codex/config.toml`:
- it uses ChatGPT auth (`preferred_auth_method = "chatgpt"`);
- no top-level `model_provider` selects the ccflare provider block.

What happened on 2026-10-03:
- A kept account lost about 160 credits between 21:15 and 21:24Z. The requests table shows no ccflare-routed request to it from 21:18:40Z.
- The local CLI was logged into that account, and the balance stopped falling once the CLI was logged into a different one.
- The CLI is the likely source. The start of the decline predates the CLI's credit snapshots, so that part remains unattributed.

To attribute spending without reading secrets:

- **Match balances.** Codex rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carry `"credits":{"has_credits":…,"balance":"…"}` snapshots. Match those balances to each account's `credits_balance` from `GET /api/accounts`.
- **Map accounts to identities.** Decode only the claims part of each Codex account's stored access-token JWT (`sqlite3 -readonly`), and of the `id_token` in `~/.codex/auth.json`. Print the email and a short account-id suffix, never a token. `codex login status` prints only "Logged in using ChatGPT".
- **Re-check after every CLI login.** Check the decoded email each time. On 2026-10-03 a re-login meant for one account landed on another.

## Why This Matters

- **Misread status codes.** Taking a 200 as proof of billing lets a drain "pass" when plan allowance actually paid. A balance drop that another client caused lets it pass when ccflare billed nothing.
- **Assuming the refusal fails closed.** The spent-window refusal needs a fresh usage reading. It has none right after a restart or during a poll outage, and in those gaps a kept account can still be admitted and billed.
- **Spending protected credits.** Relaxing the gate to trust `allowed:true` would quietly spend credits on exactly the accounts the operator chose to protect, and no code comment says why the margin exists.
- **Misdiagnosis.** Credit loss from a direct CLI login looks like a ccflare routing bug. Hours go into the proxy when the cause sits in `~/.codex`.

## When to Apply

- Before claiming a credit drain works.
- When a drain-enabled account returns 503, or a drain-off account loses credits.
- Before touching `evaluateHardCapacity`'s 100% threshold, or wiring wham's `allowed` / `limit_reached` into routing.
- When Auto refuses a Codex account that ordinary routes serve on credits.
- When ccflare has just restarted or its usage polls are failing, and a kept account must not spend credits.

## Examples

A live check that proves billing and never touches Anthropic-backed accounts (see the testing restriction in AGENTS.md):

1. Rule out other spenders. Confirm the local Codex CLI is logged into a different account (Guidance §5), and that nothing else uses the target account during the test.
2. Read `GET /api/accounts` and record the target account's `credits_balance`, `codex_subscription` flags and `codexCreditDrainActive`. If a drain-on account at 100% shows `codexCreditDrainActive: false`, there is no fresh credit evidence yet; wait one poll.
3. Send a request force-routed with `x-better-ccflare-account-id: <codex account id>`, with output large enough to move the balance (about 1k tokens).
4. Re-read after one poll interval (about 90 s). The check passes only if both of these hold:
   - `credits_balance` fell;
   - the requests table shows no other ccflare request to that account in the interval.
5. Control: send a short request (16-token cap) to a drain-off account at 100%.
   - It must return 503 with `x-better-ccflare-force-route: unavailable` (`packages/proxy/src/proxy.ts:268`) and reason `account_capacity_exhausted` (`account-selector.ts:3204`).
   - A 200 means that account's snapshot was missing or stale (§3), and the request may have billed its credits. Keep the request short for that reason.
6. If a kept account's balance moves during step 4, check which account the local Codex CLI is logged into (Guidance §5) before suspecting routing.

## Related

- [Verify a capacity-exhausted provider lane against a mock upstream](./verify-capacity-exhausted-provider-lane-fixes-against-a-mock-upstream.md): the no-spend way to exercise this gate. A drain-active account is not "exhausted" in the gate's sense, so that doc's fail-closed rule still holds.
- [Validate provider logic against live payloads](../validate-against-live-payloads.md): the same lesson for usage payloads in general.
- [Rate-limit holds: scope, duration, and evidence](../rate-limit-scope-and-duration.md): the other capacity rules this gate sits beside.
- Issue #419 and PR #421 (the toggle); PR #404 (owned Codex subscription-only admission); issue #398 (approved-quality Auto routing, open as of this writing).
