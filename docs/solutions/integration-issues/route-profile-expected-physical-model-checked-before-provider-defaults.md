---
title: Route-profile expectedPhysicalModel is checked against raw account mappings, before the provider fills in its defaults
date: 2026-09-22
last_updated: 2026-09-26
category: integration-issues
module: model-route-profiles
problem_type: integration_issue
component: proxy
symptoms:
  - Every request on the grok-primary route profile returned HTTP 503 force_route_model_mapping_mismatch before xAI was called
  - The first break happened when the account's model_mappings moved to grok-4.7 while the profile still asserted grok-4.6
  - Clearing an xAI account's model_mappings makes any profile that sets expectedPhysicalModel fail closed, even though the model that would be sent upstream is correct
  - The Codex pin-to-automatic migration cleared every Codex account's model_mappings, so an exact-model Codex capability pool could admit no account, and the migration preview reported zero route-profile advisories
root_cause: incorrect_assumption
resolution_type: config_change
severity: high
related_components:
  - providers
  - http-api
tags:
  - route-profiles
  - expected-physical-model
  - model-mappings
  - provider-defaults
  - fail-closed
  - catalog-role
  - codex
  - xai-provider
---

# Route-profile expectedPhysicalModel is checked against raw account mappings, before the provider fills in its defaults

## Problem

A route profile's optional `expectedPhysicalModel` is a second model pin that lives outside `accounts.model_mappings`. The profile guard evaluates it against the account's raw mappings during account selection. The provider fills in its real model only later: xAI during request conversion, Codex from each account's own model catalog.

Any change to the account's mapping that the profile doesn't mirror makes every request on the profile fail closed. That includes *clearing* the mapping so the account follows the provider's catalog-derived default. It happened twice:

- **xAI, accountId-pinned profile (2026-09-22).** Clearing the Grok account's mapping to follow models.dev (#361) would have broken `grok-primary`.
- **Codex, capability pools (2026-09-26).** The pin-to-automatic migration (#370, shipped in #384) clears Codex accounts' mappings by design. Every exact-model Codex capability pool on those accounts stopped admitting any account the moment it applied, and the migration preview didn't warn.

The two shapes have different fixes. An accountId-pinned profile can simply drop the pin, because the account and provider stay pinned. A capability pool can't: it must name a model, unless it uses `physicalModelPolicy: "catalog-role"`, which follows each account's catalog role instead (#384).

## Symptoms

- On 2026-09-22 at 07:09 UTC, every request on `route_profile_id = grok-primary` returned HTTP 503, recorded as `force_route_model_mapping_mismatch`, before xAI was called (session history).
  - The `grok` account's `model_mappings` had been changed from `grok-4.6` to `grok-4.7`, but the profile in `/etc/better-ccflare/model-route-profiles.env` still said `expectedPhysicalModel: "grok-4.6"`.
  - The terminal label comes from `force_route_${error.reason}` (`packages/proxy/src/proxy.ts:953`), and the 503 comes from `forceRouteUnavailableResponse` (`packages/proxy/src/proxy.ts:237`).
- The same break was about to recur that evening. The post-deploy plan for #361 was to clear the account's mapping so it would follow the derived default. The resolver predicted `model_mapping_mismatch` for that state.
- The request that would have gone upstream was correct in both Grok cases. Only the account-selection guard rejected it.
- **Codex, 2026-09-26.** The migration apply (routing revision 161→162) left all three Codex accounts with no `model_mappings`, `model_fallbacks` or custom-endpoint mappings. The service doesn't set `OPENAI_COMPATIBLE_MODEL_MAPPINGS`. The preview beforehand returned `routeProfileAdvisories: []`, although two capability pools pinned a model:
  - `codex-pool-astra` (`logicalModel: claude-opus-5`, `expectedPhysicalModel: gpt-6-astra`) worked before the migration only because each account mapped opus to `gpt-6-astra`. After it, the pool's only candidate was the raw logical name `claude-opus-5`, so no account was admitted. The request log shows no request on the profile between 00:57Z and 02:25Z, so the break (roughly 01:58Z until the 02:23Z restart below) was never hit.
  - `pro-primary-sol` (`expectedPhysicalModel: gpt-5.6-sol`) was already dead before the migration. The accounts mapped sonnet to `gpt-6-sol`, and its last success was 2026-09-23.

## What Didn't Work

- **Changing the account mapping and the profile together.** The morning fix (session history) edited both the DB mapping and the profile's `expectedPhysicalModel`, then restarted immediately so the two disagreed only during the restart. It worked, but it kept both pins. Every future Grok release would need the same two-place edit plus a restart, because the env file is read only at process start.
- **The literal post-deploy plan: "clear the grok account's `model_mappings` once prod shows the derived default is `grok-4.7`."** It would have broken `grok-primary` again. An offline run of the real `getRouteProfileConstraintViolation` against the real account row returned `ok` with the mapping as stored and `model_mapping_mismatch` with it cleared. It was caught only because the guard was read before the DB was mutated.
- **Trusting the Codex migration preview to flag affected profiles.** `routeProfileAdvisories` (`packages/http-api/src/services/codex-model-migration.ts:332-360`) skips every profile with `selection` set (line 342). It examines only exact-account profiles, so capability pools never appear, however they are pinned.
- **Assuming an exact Codex pool keeps working until the catalog moves.** The first read after the migration was "`codex-pool-astra` still works, because opus still resolves to `gpt-6-astra`". That was wrong. Exact-policy capability admission never sees the catalog-derived model. It compares the profile's model against the raw mapping, which the migration had just removed (see Why This Works).
- **Considered, not done: a `"provider-default"` sentinel for `expectedPhysicalModel`.** It needs a new parse branch in `packages/proxy/src/model-route-profiles.ts` and a new match branch in the guard. The config-only fix below gives the same result for an accountId-pinned profile, with no code change. For Codex pools, `physicalModelPolicy: "catalog-role"` (#384) later shipped a per-account version of the idea.
- **Considered, not done: make the guard resolve provider defaults whenever an account has no mapping.** Capability admission uses the same guard (`matchesCapabilityRouteProfile`, `packages/proxy/src/handlers/account-selector.ts:2328`), so every Codex account with no mapping would start matching capability profiles. That is an admission change well beyond this fix.

## Solution

### xAI: drop the pin from an accountId-pinned profile

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

### Codex: convert a pinned capability pool to `physicalModelPolicy: "catalog-role"`

Before:

```json
{"id":"codex-pool-astra","displayName":"Codex pool: GPT-6 Astra (all Pro accounts, 1M)","selection":"capability","expectedProvider":"codex","expectedPhysicalModel":"gpt-6-astra","logicalModel":"claude-opus-5","clientContextWindowHint":"1m"}
```

After:

```json
{"id":"codex-pool-astra","displayName":"Codex pool: Opus-tier, auto-updating (all Pro accounts, 1M)","selection":"capability","expectedProvider":"codex","logicalModel":"claude-opus-5","clientContextWindowHint":"1m","physicalModelPolicy":"catalog-role"}
```

The `id` is unchanged, so the picker ID `claude-bccf-route-codex-pool-astra[1m]` is stable. The display name and description name a role rather than a model version, since the version now changes without an edit. `pro-primary-sol` (sonnet role) was converted the same way in the same change. The profile's `description` values were rewritten too (omitted above), and must not contain an apostrophe (step 4 below).

Applied on 2026-09-26 with operator approval, in two phases. Phase one was read-only:

1. Copy the live env file into a mode-700 scratch directory, and assert it is exactly one `CCFLARE_MODEL_ROUTE_PROFILES_JSON='...'` line.
2. Extract the running service's value from `/proc/<MainPID>/environ`, printing only this variable, and `cmp` it with the file. That catches an edit that was made but never restarted into.
3. Compare-and-set on the fields being changed: the old `expectedPhysicalModel`, `selection: "capability"`, `expectedProvider: "codex"`, and no `physicalModelPolicy` yet.
4. Transform with `jq -c`; `del(...)` plus object addition keeps key order. Then:
   - Reject any `'` in the result: the value is single-quoted in an `EnvironmentFile`, so an apostrophe in a description breaks the quoting.
   - Rebuild the line with `awk` reading the JSON from `ENVIRON`, not `-v`, because `-v` interprets backslash escapes.
   - Assert that the rebuilt line round-trips to the same JSON.
5. Validate the old *and* new JSON by importing the deployed `parseModelRouteProfiles`. Assert the same profile count, the same IDs in the same order, the same `discoveryModelId`s, and deep-equality of every profile not being changed.

Phase two wrote and restarted:

6. Repeat the compare-and-set against the live file.
7. `cp -p` a backup, then `install -m 600 -o root -g root`, and verify the installed bytes. `EnvironmentFile` content needs no `daemon-reload`.
8. `systemctl restart ccflare-stack.service`, and poll `/health` for 200. If it never comes up, reinstall the backup and restart again.
9. Check `git_sha`, guard health, and `NRestarts`, then `cmp` the new MainPID's environ value against the JSON validated in step 5.

Observed: the file matched the running value; the parser accepted both versions, with only the two intended profiles changed. The restart began at 02:22:51Z and was healthy at 02:23:39Z, on the same build, with the running value byte-identical to the validated JSON.

The info-level `Model route profiles configured: N` line (`apps/server/src/server.ts:1803`) did not appear in `journalctl -u ccflare-stack.service`. Production probably logs above info, but that wasn't checked. Don't treat the line's absence as a failure, or its presence as the check.

**Not yet proven:** no request has been served under catalog-role admission (`routed_model` equal to the catalog target). All three Codex accounts were out of weekly quota until about 2026-09-29 23:36Z. The first request on `codex-pool-astra` after the restart (02:25:07Z) returned `503 force_route_account_capacity_exhausted`. That's consistent with the fix, but not proof, because the order of the capacity check relative to catalog-role admission was not checked. `docs/solutions/workflow-issues/verify-capacity-exhausted-provider-lane-fixes-against-a-mock-upstream.md` describes how to prove such a lane without waiting for quota.

## Why This Works

Two layers answer "which physical model does this account serve?" at different times:

- **Account selection (the guard).** `getRouteProfileConstraintViolation` (`packages/proxy/src/handlers/account-selector.ts:198`) checks the provider first (`:225-231`). For any policy other than catalog-role, it calls `getExactPhysicalModelViolation` (`:257-283`). With no concrete model supplied, that builds candidates from `getModelList(logicalModel, account)` (`packages/core/src/model-mappings.ts:442`).
  - `getModelList` returns `null` when `hasAccountModelMappings` (`packages/core/src/model-mappings.ts:408`) finds no `model_mappings`, `model_fallbacks`, custom-endpoint mappings or `OPENAI_COMPATIBLE_MODEL_MAPPINGS`.
  - The guard then falls back to candidates `[logicalModel]`, for example `["claude-opus-5"]`, which can never equal `grok-4.7` or `gpt-6-astra`.
  - Capability admission uses the same path. For an exact-policy pool, `matchesCapabilityRouteProfile` (`account-selector.ts:2328-2360`) calls the guard with the profile's `expectedPhysicalModel` and logical model, and no concrete model. So a Codex account following its catalog, with no mapping, fails the pool exactly as the Grok account failed its profile.
- **Request conversion (the provider).** `XaiProvider.beforeConvert` (`packages/providers/src/providers/xai/provider.ts:239`) replaces a null mapping with `resolvedXaiModelMappings()`, the derived or factory default that actually gets sent. For Codex, the model comes from the account's own catalog. The guard runs on the raw DB row, before either, so it never sees that default.

Dropping the field is safe for an **accountId-pinned** profile:

- **The account and provider are still pinned.** The guard still returns `provider_mismatch` when the account's provider differs from `expectedProvider` (`account-selector.ts:225-231`).
- **The field is optional there.** `expectedPhysicalModel` is required only for `selection: "capability"` profiles, and not even there under catalog-role (`packages/proxy/src/model-route-profiles.ts:360-373`).
- **Route-profile traffic is exempt from the ordinary stock-model fence.** `applyOrdinaryStockModelEligibility` (`account-selector.ts:2278`) returns early when `meta.routeProfileId != null` (`:2286`). So a provider-default model reaching this account through the profile is allowed.
- **Capability pools are untouched.** Capability admission (`account-selector.ts:2328`) and implicit-codex admission (`:3091`, `:3129`) apply only to `selection: "capability"` and `"implicit-codex"` profiles, so neither sees this change.

The profile's contract narrows from "this account, this provider, this exact model" to "this account, this provider". The model is then governed by the account's own mapping, or by the provider's catalog default when there is none.

A side effect: xAI's `getLogicalModelCapability` reports "supported" only when `model_mappings` is null (`packages/providers/src/providers/xai/provider.ts:83`). So clearing the mapping also makes the account visible to capability checks as a provider-default account.

Catalog-role is the capability-pool equivalent:

- **It names a role, not a model.** A catalog-role pool follows the model at the logical family's role in each account's own catalog. The parser requires `expectedProvider: "codex"`, forbids `expectedPhysicalModel`, `contextWindow` and `maxOutputTokens`, and requires a fable, opus, sonnet or haiku `logicalModel` (`model-route-profiles.ts:374-403`).
- **Admission reads the catalog.** `matchesCapabilityRouteProfile` admits an account only when its catalog has a target for the role and the account's concrete model list resolves to it (`evaluateCatalogRoleConstraint`, `account-selector.ts:156-190`). A missing or different target fails closed with `catalog_role_unavailable` or `catalog_role_mismatch`, never another provider.
- **Cold catalogs are primed.** Catalogs live in memory, so every process start is cold:
  - Catalog-role requests prime cold candidates before selection, bounded by the selection deadline (`packages/proxy/src/proxy.ts:1674-1710`). Exact-policy requests skip this.
  - A refresh heartbeat (`packages/proxy/src/codex-model-catalog.ts:839-918`) fetches every eligible Codex account's catalog 30–120 s after start, then about every 15 minutes.
- **A malformed profile stops startup.** `parseModelRouteProfiles` throws on a malformed non-empty value (`model-route-profiles.ts:186-206`), and the server calls it before the database, background jobs and listener start (`apps/server/src/server.ts:1332`). A healthy `/health` after a restart therefore implies the profiles parsed.

## Prevention

- **Before changing or clearing any account's `model_mappings`, find every profile that pins a physical model**, not only those that name the account. Capability pools have no `accountId` (the parser rejects one, `model-route-profiles.ts:271-275`), so an accountId-scoped search misses them:

  ```bash
  sudo cat /etc/better-ccflare/model-route-profiles.env | python3 -c '
  import json, sys
  line = sys.stdin.read().strip()
  profiles = json.loads(line.split("=", 1)[1].strip("\x27"))
  for p in profiles:
      if "expectedPhysicalModel" in p:
          print(p["id"], p.get("accountId") or "capability:" + str(p.get("expectedProvider")),
                "->", p["expectedPhysicalModel"])
  '
  ```

  Any hit on an affected account or provider must change in the same change, with a restart, or that profile fails closed.
- **Convert exact Codex capability pools to `catalog-role` before running the Codex migration**, not after. Don't rely on the preview's `routeProfileAdvisories`, which never lists capability pools. By the code (not exercised), a catalog-role pool admits a still-pinned account whose pin equals the catalog target. Converting and restarting first should therefore leave no window in which the pool admits nobody.
- **Don't set `expectedPhysicalModel` on a profile that should follow the latest model.** Use no pin on an accountId-pinned profile, and `physicalModelPolicy: "catalog-role"` on a Codex capability pool. Keep an exact pin only where one exact model is the point, for example a local model with a calibrated window.
- **Know what a model switch touches.** The hand-rolled grok-4.6 → 4.7 switch touched three places:
  - the account mapping
  - the profile's `expectedPhysicalModel` and `displayName`
  - the xAI context-window table, which was missed and hotfixed in #360

  After #361, a new Grok release needs none of them for this profile shape. After #362, a new Anthropic release needs no code bump for same-family routing. After #384, a new Codex generation needs none for Automatic accounts behind catalog-role pools.
- **If xAI's plan can't serve a newly listed model yet (#364),** re-pin the account's `model_mappings` to the previous model. Because the profile no longer asserts a model, that pin passes the guard with no profile edit. On 2026-09-22 a mapping change made through the dashboard took effect without a restart (session history). A direct DB edit was not tested that way.
- **Edit the profiles file with the two-phase checklist above**, not by hand. The file is root-owned, read only at start, and fails the whole service closed if malformed.
- **Watch for the general shape of this bug.** It is an admission check reading state that a later layer fills in. #325 is the same shape for Codex capability profiles: admission read a catalog that only dispatch populated. #384 primes catalogs for catalog-role pools and adds the startup heartbeat, but exact-policy pools still get no inline priming. #325 stays open pending live confirmation.

## Related Issues

- #360: Grok 4.7 context-window hotfix (the missed third place).
- #361: xAI default model, context window and >200k pricing from the models.dev catalog.
- #362: Anthropic same-family pass-through in bare-alias combo slots.
- #364: stop using a catalog-derived Grok model the plan rejects (open).
- #365: cross-family combo fallback still serves the latest model to older clients (open).
- #370: follow current Codex provider models (open). Implemented by #384: catalog-role profiles, the pin-to-automatic migration, catalog priming and the refresh heartbeat.
- #325: Codex capability profiles fail closed until the catalog is primed (same bug shape; narrowed by #384 for catalog-role pools; open).
- `docs/solutions/architecture-patterns/commit-bound-routing.md`: same function family, different bug class (over-admission ordering).
- `docs/solutions/workflow-issues/verify-capacity-exhausted-provider-lane-fixes-against-a-mock-upstream.md`: how to prove a Codex lane fix while every account is out of quota.
- `docs/configuration.md` (route profile fields, including `physicalModelPolicy`) and `docs/providers.md` (xAI default model mapping).
