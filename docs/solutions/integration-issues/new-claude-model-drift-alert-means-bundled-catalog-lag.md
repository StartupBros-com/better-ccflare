---
title: A drift alert naming a new Claude model means the bundled catalog lags, not that routing failed
date: 2026-10-15
category: integration-issues
module: model-catalog
problem_type: integration_issue
component: proxy
symptoms:
  - "Discord repeats a model_routing_drift warning about once an hour, \"A requested model is missing from the bundled catalog\", naming model claude-haiku-5-5"
  - The alert's Affected line reads "account account" and its Impact line says service impact is unknown
  - Every request served as the new model returns 200, so the alert looks like a false alarm
  - Usage-window value for the new model's tokens is recorded as unpriced, and pickers and the haiku family alias still point at the older model
root_cause: missing_workflow_step
resolution_type: code_fix
severity: medium
related_components:
  - observability
  - providers
  - database
tags:
  - model-catalog
  - model-routing-drift
  - new-model-release
  - haiku-5-5
  - value-pricing
  - usage-window-ledger
  - long-context-pricing
  - alerts
---

# A drift alert naming a new Claude model means the bundled catalog lags, not that routing failed

## Problem

Claude Haiku 5.5 (`claude-haiku-5-5`) first appeared in production traffic on 2026-10-07. Until PR #515 registered it, the proxy raised a `model_routing_drift` warning about it every hour that Haiku 5.5 traffic flowed. The warning reads like a routing fault. It is actually a reminder that the compiled-in model catalog is behind a release. Routing was fine. The real costs were quiet ones that the alert mentions only in passing.

## Symptoms

- The Discord alert reads: "A requested model is missing from the bundled catalog. Affected: account account; model claude-haiku-5-5. Impact: Service impact is unknown; catalog absence alone does not establish a routing failure. Action: Check catalog freshness and the actual routed model in the dashboard."
- Production (prod DB, read-only, 2026-10-15) had 62 such alerts from 2026-10-07 18:51 to 2026-10-15 23:25 UTC, each in a different clock hour.
- The "account account" text is the Discord renderer's redaction. The `display` helper in `packages/http-api/src/services/alerts.ts` replaces any UUID with the word `account`, and before PR #517 drift alerts carried the raw account id.

## What Didn't Work

- **Reading the alert as a routing failure.** Before PR #515 was deployed (2026-10-16 00:04 UTC), Anthropic served 110 requests as `claude-haiku-5-5`, and every one returned 200. None was rewritten: `original_model` is empty and `routed_model` is `claude-haiku-5-5`. Of the 877 requests that asked for Haiku 5.5 in that period, 0 were served as Haiku 4.5. The other 767 went to `gpt-6-sol` (733) and `grok-4.7` (30) through session route profiles (`pro-primary-sol`, `codex-pool-astra`, `grok-primary`), and to `claude-fable-5-1` (4) through the Auto quality policy. The alert fires for those requests too, because it keys on the *requested* model, not the served one.
- **Trusting the alert's account label.** The alert id scope is `unknown_model:<family>`, with no account in it. One alert stands for every request of that family in its cooldown window, and the account it names is the one that served the request whose insert won. With route profiles active, that can be a Codex or xAI account rather than an Anthropic one.
- **Looking for the model in the live catalog.** `packages/proxy/src/model-catalog.ts` fetches Anthropic's `/v1/models` and can already list a new model. The alert's check, `isValidModelId` in `packages/core/src/models.ts`, reads only the compiled-in `CLAUDE_MODEL_IDS`. So "the live catalog has the model" and "the alert says it is missing" can both be true.
- **Pricing the new model at its base rate in the window ledger.** The first version of the registration did this. It passed its tests. Pro-gate review then caught it as a P1: a 150k-input / 10k-output request was valued at about $0.02 instead of $0.10 and reported as fully priced (session history). The bundled cost table in `packages/core/src/pricing.ts` already had the >100k tier, but the ledger's list-price era in `packages/core/src/value-pricing.ts` did not. These two price tables are separate, and the existing parity test only checks that an era exists.

## Solution

PR #515 registered the model. Each of these places keys off a model id, and each goes stale silently until it is updated:

- **`packages/core/src/models.ts`:**
  - Add the id to `CLAUDE_MODEL_IDS` and to `MODEL_DISPLAY_NAMES` / `MODEL_SHORT_NAMES`.
  - Move the family's `LATEST_*_MODEL` alias (`LATEST_HAIKU_MODEL`).
  - Bump `BUNDLED_MODELS_AS_OF`.

  The `CLAUDE_MODEL_IDS` entry is what silences the alert.
- **`packages/core/src/pricing.ts`:** add the model's bundled rates, including any context tier. Haiku 5.5 bills a whole request at the higher tier once its prompt passes 100,000 tokens.
- **`packages/core/src/value-pricing.ts`:**
  - Add a `LIST_PRICE_ERAS` entry, with `longContext` rates when the model has a tier.
  - Bump `VALUE_PRICING_VERSION`. At startup the ledger re-prices every closed window stamped with another version (`revalueStaleClosedWindows`).
- **Model lists:** add the model to `COMMON_MODELS` in `packages/types/src/agent.ts` and to the `--set-model` map in `apps/cli/src/main.ts`.
- **Forced tool choice:** check the model against Anthropic's tool-use docs before deciding whether it belongs in `FORCED_TOOL_CHOICE_UNSUPPORTED` in `models.ts`. Haiku 5.5 accepts a forced `tool_choice`, unlike Opus 5.5, Sonnet 5.5 and Fable 5.1, so it is not in that set (auto memory [claude]).
- **Auto lane:** check `SUPPORTED_IDENTITIES` in `packages/providers/src/auto-model-capabilities.ts`. PR #515 did not extend it, because the adapter requires reviewed support evidence before an identity joins. `claude-haiku` still lists only Haiku 4.5 ids, so Haiku 5.5 workers escalate to Fable (issue #513, open).
- **Responses-adapter sampling parameters:** `temperature` and `top_p` are still forwarded to 5.5 targets that reject them (issue #514, open).

A pro-gate fix round in PR #515 added the long-context ledger pricing:

- `LONG_CONTEXT_PROMPT_TOKENS = 100_000` and an optional `ListPriceEra.longContext` were added in `value-pricing.ts`.
- `RequestRepository.aggregateTokensByModel` splits each model's totals per request. A request counts as long-context when its prompt (input + cache read + cache creation) is strictly greater than the threshold. The split is stored in the window's `model_breakdown`.
- `priceTokensAtListPrice(model, atMs, tokens, longContextTokens?)` prices the long-context subset at the tier and the rest at base. It returns `null` when the era has `longContext` rates and the split is `undefined`. The ledger records a `null` as `unpriced_tokens`.

PR #517 resolves the alert's account id to the account name (`lookupAccountName` in `AlertService`). It does this after the pure alert builders run. If the account row is missing, the id stays and Discord keeps redacting it.

## Why This Works

The alert fires when a requested model matches the Claude id shape (`CLAUDE_MODEL_SHAPE_RE`), is not in `CLAUDE_MODEL_IDS`, and has a family. It never measures routing, so the only way to clear it is to add the id to the catalog.

PR #362 removed most of the routing risk the alert used to stand for. Before it, a bare-alias combo slot rewrote every request to `LATEST_MODEL_BY_FAMILY`: at Opus 5.5's launch, 449 requests were served as the older `claude-opus-5`. Since #362, a well-formed same-family id passes straight through. The guard behind this, `CONCRETE_CLAUDE_MODEL_ID_PATTERN` in `packages/core/src/model-mappings.ts`, deliberately ignores catalog membership. Two routes are still not covered, and the alert's own message names them: a cross-family fallback slot and a version-pinned account can still send an older model. Three things go stale on every route: offline pricing, list-price eras, and the pickers and aliases.

The alert's list leaves out one more cost, and it applies only where Anthropic degraded mode is turned on (its default mode is `off`). That protection builds cohorts only from `CLAUDE_MODEL_IDS`. For any other model, `buildAnthropicDegradedCohortKey` in `packages/proxy/src/anthropic-degraded-mode.ts` returns `null`, which the code treats as fail-open. So during an Anthropic degradation, requests for an uncatalogued model are never held back.

The alert repeats hourly because of how its id is built. The id is `model_routing_drift:unknown_model:<family>:<bucket>`, where the bucket is the timestamp divided by the cooldown (default 60 minutes, `ALERT_COOLDOWN_MINUTES`). `persistAndEmit` inserts with `INSERT OR IGNORE` (`ON CONFLICT (id) DO NOTHING` on PostgreSQL), and only the insert that wins emits. The result is one Discord message per family for every cooldown window that has traffic, until the registration is deployed. After the deploy, a Haiku 5.5 request at 00:46 UTC returned 200 and raised no drift alert, and none had fired by the time this was written.

The long-context fix has to work per request. The tier depends on each request's prompt size, but the ledger values a window from per-model token sums, and a sum cannot say which tokens came from tiered requests. So the split is computed per request during aggregation and stored with the window. Pricing at base when the split is unknown would look complete while understating, by 5x in the example above. Returning `null` keeps the gap visible in `unpriced_tokens` instead. The fix chose an unknown split as unpriced over a guessed base price (session history).

## Prevention

- **Treat the alert as a registration task, not an incident.** When the drift alert names a new same-family Claude id, check the served model before anything else. Compare `original_model` with `model` / `routed_model` in the requests table (prod DB, `sqlite3 -readonly`). A wrong served model is the only routing signal. Then register the model using every item in the Solution list, in one PR.
- **Register fast for a tiered model.** A window that closes during the lag stores a breakdown without the long-context split. It re-prices as unpriced, and nothing rebuilds a closed window from the requests table: `--rebuild-windows` never re-closes a closed row. Two `seven_day` windows with Haiku 5.5 tokens closed during the lag. They were unpriced then because the model had no era. After PR #515 they re-price as unpriced again, because their stored breakdown has no split (issue #520, open). Advisor usage has a related limit: `advisor_usage` sums iterations, so its long-context classification is per entry, not per call (issue #519, open).
- **Guardrails that exist (from PR #390):**
  - `packages/core/src/pricing.test.ts`, "has complete bundled rates for every bundled Claude model id".
  - `packages/core/src/value-pricing.test.ts`, "has a list-price era for every bundled Claude model id".

  Both fail when an id joins `CLAUDE_MODEL_IDS` without rates or an era. `packages/core/src/model-mappings.test.ts` also checks that every bundled id passes the pass-through shape guard.
- **The gap with no general guardrail.** Nothing fails when a model has a bundled pricing tier (`cost.tiers` in `pricing.ts`) but no matching `longContext` rates on its list-price era. The era parity test passes an empty long-context subset, so a flat era still passes, and today only a Haiku-5.5-specific assertion covers the pairing. When a model has a tier, add both halves together, plus a test that values a request above the threshold at the tier rate. `LONG_CONTEXT_PROMPT_TOKENS` is a single global threshold. A model whose tier starts at a different size needs the split extended, not a second constant.

## Related Issues

- PR #515: Haiku 5.5 registration, plus the long-context ledger pricing fix.
- PR #517: request-derived alerts name the account instead of its id.
- PR #362: same-family pass-through on bare-alias combo slots.
- PR #390: the Sonnet 5.5 registration, which added the two parity tests.
- Open issues: #513 (Auto lightweight lane does not admit Haiku 5.5), #514 (`temperature`/`top_p` forwarded to 5.5 targets), #519 (advisor tier classification is per entry), #520 (pre-split closed windows stay unpriced).
- `docs/solutions/observability/diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md`: the other alert that follows a new model release.
- `docs/solutions/integration-issues/route-profile-expected-physical-model-checked-before-provider-defaults.md`: route profiles, which carried most of this traffic to other providers.
- `docs/solutions/integration-issues/claude-code-websearch-refused-as-no-implementation.md`: forced tool choice on the 5.5 models.
