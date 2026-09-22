---
title: Route-profile expectedPhysicalModel is checked against raw account mappings, before the provider fills in its defaults
date: 2026-09-22
category: integration-issues
module: model-route-profiles
problem_type: integration_issue
component: service_layer
symptoms:
  - Every request on the grok-primary route profile returned HTTP 503 force_route_model_mapping_mismatch before xAI was called
  - The first break happened when the account's model_mappings moved to grok-4.7 while the profile still asserted grok-4.6
  - Clearing an xAI account's model_mappings makes any profile that sets expectedPhysicalModel fail closed, even though the model that would be sent upstream is correct
root_cause: incorrect_assumption
resolution_type: config_change
severity: high
related_components:
  - proxy
  - providers
tags:
  - route-profiles
  - expected-physical-model
  - model-mappings
  - xai-provider
  - account-selector
  - fail-closed
  - provider-defaults
  - exact-account-routing
---

# Route-profile expectedPhysicalModel is checked against raw account mappings, before the provider fills in its defaults

## Problem

A route profile's optional `expectedPhysicalModel` is a second model pin that lives outside `accounts.model_mappings`. The profile guard evaluates it against the account's raw mappings during account selection, but xAI fills in its default model only later, during request conversion.

Any change to the account's mapping that the profile doesn't mirror makes every request on the profile fail closed. That includes *clearing* the mapping so the account follows xAI's models.dev-derived default (#361).

## Symptoms

- On 2026-09-22 at 07:09 UTC, every request on `route_profile_id = grok-primary` returned HTTP 503, recorded as `force_route_model_mapping_mismatch`, before xAI was called (session history).
  - The `grok` account's `model_mappings` had been changed from `grok-4.6` to `grok-4.7`, but the profile in `/etc/better-ccflare/model-route-profiles.env` still said `expectedPhysicalModel: "grok-4.6"`.
  - The terminal label comes from `force_route_${error.reason}` (`packages/proxy/src/proxy.ts:948`), and the 503 comes from `forceRouteUnavailableResponse` (`packages/proxy/src/proxy.ts:249`).
- The same break was about to recur that evening. The post-deploy plan for #361 was to clear the account's mapping so it would follow the derived default. The resolver predicted `model_mapping_mismatch` for that state.
- The request that would have gone upstream was correct in both cases. Only the account-selection guard rejected it.

## What Didn't Work

- **Changing the account mapping and the profile together.** The morning fix (session history) edited both the DB mapping and the profile's `expectedPhysicalModel`, then restarted immediately so the two disagreed only during the restart. It worked, but it kept both pins. Every future Grok release would need the same two-place edit plus a restart, because the env file is read only at process start.
- **The literal post-deploy plan: "clear the grok account's `model_mappings` once prod shows the derived default is `grok-4.7`."** It would have broken `grok-primary` again. An offline run of the real `getRouteProfileConstraintViolation` against the real account row returned `ok` with the mapping as stored and `model_mapping_mismatch` with it cleared. It was caught only because the guard was read before the DB was mutated.
- **Considered, not done: a `"provider-default"` sentinel for `expectedPhysicalModel`.** It needs a new parse branch in `packages/proxy/src/model-route-profiles.ts` and a new match branch in the guard. The config-only fix below gives the same result for an accountId-pinned profile, with no code change.
- **Considered, not done: make the guard resolve provider defaults whenever an account has no mapping.** `matchesCapabilityRouteProfile` (`packages/proxy/src/handlers/account-selector.ts:2189`) admits accounts into `selection: "capability"` pools through the same guard. So Codex accounts with null mappings would start matching capability profiles. That is an admission change well beyond this fix.

## Solution

Drop the optional `expectedPhysicalModel` from the accountId-pinned profile, then clear the account mapping, then restart once.

Before:

```json
{"id":"grok-primary","displayName":"Grok 4.7 · grok","description":"Pins this Claude Code session tree to Grok 4.7","accountId":"<grok account id>","logicalModel":"claude-opus-5","expectedProvider":"xai","expectedPhysicalModel":"grok-4.7"}
```

After:

```json
{"id":"grok-primary","displayName":"Grok (latest) · grok","description":"Pins this Claude Code session tree to the newest Grok (ccflare follows the models.dev catalog)","accountId":"<grok account id>","logicalModel":"claude-opus-5","expectedProvider":"xai"}
```

Order of operations used on 2026-09-22 (~21:11 UTC):

1. Back up `/etc/better-ccflare/model-route-profiles.env`.
2. Write the edited `CCFLARE_MODEL_ROUTE_PROFILES_JSON` to a candidate file, and parse it with the real `parseModelRouteProfiles`. It returned all 6 profiles, with the other 5 unchanged.
3. Install the candidate.
4. Set the account's `model_mappings` to NULL, guarded on the old value (1 row changed).
5. Restart the service once. The env file is read only at process start.

Verification was offline, with the deployed commit's real functions and no provider traffic:

- `getRouteProfileConstraintViolation`, run with the live row, returned `ok` for `claude-opus-5` and `claude-sonnet-5`. With a non-xAI provider it returned `provider_mismatch`.
- `XaiProvider.beforeConvert` + `mapModelName`, run after a models.dev catalog load, mapped every family to `grok-4.7`. `resolveXaiContextWindow("grok-4.7")` returned 500,000 (`catalog-exact`).
- The running process's environment showed the profile without `expectedPhysicalModel`. The prod log showed `xai catalog-derived default changed from factory default to grok-4.7` about 6s after start.
- **Not yet proven end to end:** a live Grok request through the profile. The plan's usage limits were exhausted that day.

## Why This Works

Two layers answer "which physical model does this account serve?" at different times:

- **Account selection (the guard).** `getRouteProfileConstraintViolation` (`packages/proxy/src/handlers/account-selector.ts:103`) builds its candidates from `getModelList(logicalModel, account)` (`packages/core/src/model-mappings.ts:442`).
  - That returns `null` when `hasAccountModelMappings` (`packages/core/src/model-mappings.ts:408`) finds no `model_mappings`, `model_fallbacks`, custom-endpoint mappings or `OPENAI_COMPATIBLE_MODEL_MAPPINGS`.
  - The guard then falls back to candidates `[logicalModel]`, for example `["claude-opus-5"]`, which can never equal `grok-4.7`.
- **Request conversion (the provider).** `XaiProvider.beforeConvert` (`packages/providers/src/providers/xai/provider.ts:239`) replaces a null mapping with `resolvedXaiModelMappings()`. That is the derived or factory default, which is what actually gets sent.

The guard runs on the raw DB row, before conversion, so it never sees the provider's default.

Dropping the field is safe for an **accountId-pinned** profile:

- **The account and provider are still pinned.** The guard still returns `provider_mismatch` when the account's provider differs from `expectedProvider` (`account-selector.ts:118-123`).
- **The field is optional there.** `expectedPhysicalModel` is required only for `selection: "capability"` profiles (`packages/proxy/src/model-route-profiles.ts:323-338`).
- **Route-profile traffic is exempt from the ordinary stock-model fence.** `applyOrdinaryStockModelEligibility` returns early when `meta.routeProfileId != null` (`account-selector.ts:2139-2150`). So a provider-default model reaching this account through the profile is allowed.
- **Capability pools are untouched.** Capability admission (`account-selector.ts:2189`) and implicit-codex admission (`account-selector.ts:2898`) apply only to `selection: "capability"` and `"implicit-codex"` profiles, so neither sees this change.

The profile's contract narrows from "this account, this provider, this exact model" to "this account, this provider". The model is then governed by the account's own mapping, or by the provider's catalog default when there is none.

A side effect: xAI's `getLogicalModelCapability` reports "supported" only when `model_mappings` is null (`packages/providers/src/providers/xai/provider.ts:83`). So clearing the mapping also makes the account visible to capability checks as a provider-default account.

## Prevention

- **Before changing or clearing any account's `model_mappings`, find the profiles that pin that account with an `expectedPhysicalModel`:**

  ```bash
  sudo cat /etc/better-ccflare/model-route-profiles.env | python3 -c '
  import json, sys
  line = sys.stdin.read().strip()
  profiles = json.loads(line.split("=", 1)[1].strip("\x27"))
  target = "<accountId>"
  for p in profiles:
      if p.get("accountId") == target and "expectedPhysicalModel" in p:
          print(p["id"], "->", p["expectedPhysicalModel"])
  '
  ```

  Any hit must be edited in the same change, and the service restarted, or that profile fails closed.
- **Don't set `expectedPhysicalModel` on an accountId-pinned profile that should follow the latest model.** Keep it for `selection: "capability"` profiles, which require it, and for profiles whose whole point is one exact model (for example a local model with a calibrated window).
- **Know what a model switch touches.** The hand-rolled grok-4.6 → 4.7 switch touched three places:
  - the account mapping
  - the profile's `expectedPhysicalModel` and `displayName`
  - the xAI context-window table, which was missed and hotfixed in #360

  After #361, a new Grok release needs none of them for this profile shape: the default model, context window and long-context pricing come from the models.dev catalog. After #362, a new Anthropic release needs no code bump for same-family routing.
- **If xAI's plan can't serve a newly listed model yet (#364),** re-pin the account's `model_mappings` to the previous model. Because the profile no longer asserts a model, that pin passes the guard with no profile edit. On 2026-09-22 a mapping change made through the dashboard took effect without a restart (session history). A direct DB edit was not tested that way.
- **Watch for the general shape of this bug.** It is an admission check reading state that a later layer fills in. #325 is the same shape for Codex capability profiles: admission reads a model catalog that only dispatch populates.

## Related Issues

- #360: Grok 4.7 context-window hotfix (the missed third place).
- #361: xAI default model, context window and >200k pricing from the models.dev catalog.
- #362: Anthropic same-family pass-through in bare-alias combo slots.
- #364: stop using a catalog-derived Grok model the plan rejects (open).
- #365: cross-family combo fallback still serves the latest model to older clients (open).
- #325: Codex capability profiles fail closed until the catalog is primed (same bug shape, open).
- `docs/solutions/architecture-patterns/commit-bound-routing.md`: same function family, different bug class (over-admission ordering).
- `docs/configuration.md` (route profile fields table) and `docs/providers.md` (xAI default model mapping).
