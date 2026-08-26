# Issue #260 — v3.5.67 Parent-Delta Review

> This is a source-review artifact, not deployment authorization. It compares
> the staged merge result with both exact parents without reading the prohibited
> `apps/cli/README.md`; that path was resolved separately by exact first-parent retention.

- Fork parent: `94cfc55bcdcce59fc94f4a85f1ac5b131486bc1a`
- Upstream parent: `ebc904903dc828338cd2d5da707b0d3dd2d0922f`
- Merge base: `0ad2f93d9e0c75e7b575006d12433d33a358df50`
- Reviewed permitted conflict/shared paths: **106**
- Relation counts: `{"composed-result":97,"deleted-in-result":1,"same-as-both":2,"same-as-fork-parent":6}`
- Mechanically retained excluded path: `apps/cli/README.md` (index stages `[0]`; exact first-parent retention recorded separately)
- Target-only test paths classified: **39**

## Path-by-path comparison

| Kind | Path | Conflict class | Result relation | Delta vs fork parent | Delta vs upstream parent |
|---|---|---|---|---|---|
| conflict | `apps/server/src/server.ts` | content | composed-result | M +93/-7 | M +960/-155 |
| conflict | `docs/combos.md` | content | composed-result | M +3/-1 | M +290/-224 |
| conflict | `docs/configuration.md` | content | composed-result | M +32/-5 | M +467/-17 |
| conflict | `docs/providers.md` | content | composed-result | M +15/-7 | M +183/-35 |
| conflict | `docs/routing-architecture.md` | content | composed-result | M +6/-14 | M +157/-61 |
| conflict | `packages/cli-commands/src/commands/account.ts` | content | composed-result | M +16/-19 | M +240/-94 |
| conflict | `packages/cli-commands/src/commands/help.ts` | content | composed-result | M +2/-2 | M +30/-1 |
| conflict | `packages/cli-commands/src/runner.ts` | content | composed-result | M +2/-2 | M +625/-24 |
| conflict | `packages/config/src/index.ts` | content | composed-result | M +165/-0 | M +1340/-235 |
| conflict | `packages/config/src/strategy-source.test.ts` | content | composed-result | M +11/-0 | M +15/-4 |
| conflict | `packages/core/src/index.ts` | content | composed-result | M +3/-0 | M +63/-3 |
| conflict | `packages/core/src/model-mappings.ts` | content | composed-result | M +15/-0 | M +216/-51 |
| conflict | `packages/core/src/pricing.ts` | content | same-as-fork-parent | unchanged | M +42/-3 |
| conflict | `packages/core/src/xai.test.ts` | add/add | composed-result | M +2/-5 | M +59/-1 |
| conflict | `packages/core/src/xai.ts` | add/add | composed-result | M +16/-17 | M +98/-0 |
| conflict | `packages/dashboard-web/src/components/accounts/AccountAddForm.tsx` | content | composed-result | M +16/-22 | M +2167/-1825 |
| conflict | `packages/dashboard-web/src/components/accounts/RateLimitProgress.tsx` | content | composed-result | M +72/-5 | M +52/-41 |
| conflict | `packages/dashboard-web/src/components/AccountsTab.tsx` | content | composed-result | M +13/-10 | M +338/-227 |
| conflict | `packages/dashboard-web/src/components/navigation.tsx` | content | composed-result | M +4/-11 | M +136/-271 |
| conflict | `packages/dashboard-web/src/components/overview/pool-usage-shared.tsx` | content | composed-result | A +325/-0 | M +44/-62 |
| conflict | `packages/dashboard-web/src/components/overview/RoutingCard.test.tsx` | content | composed-result | M +64/-29 | M +8/-26 |
| conflict | `packages/dashboard-web/src/components/overview/RoutingCard.tsx` | content | composed-result | M +75/-26 | M +9/-12 |
| conflict | `packages/dashboard-web/src/hooks/queries.ts` | content | composed-result | M +30/-0 | M +511/-39 |
| conflict | `packages/database/src/database-operations.ts` | content | composed-result | M +7/-0 | M +549/-78 |
| conflict | `packages/database/src/migrations.ts` | content | composed-result | M +353/-45 | M +943/-56 |
| conflict | `packages/database/src/repositories/usage-history.repository.ts` | content | composed-result | M +59/-29 | M +378/-119 |
| conflict | `packages/http-api/src/handlers/accounts.ts` | content | composed-result | M +117/-29 | M +184/-132 |
| conflict | `packages/http-api/src/handlers/combos.ts` | content | composed-result | M +18/-0 | M +788/-60 |
| conflict | `packages/http-api/src/handlers/config.ts` | content | composed-result | M +113/-0 | M +77/-121 |
| conflict | `packages/http-api/src/router.ts` | content | composed-result | M +40/-6 | M +195/-24 |
| conflict | `packages/http-api/src/services/__tests__/alerts.test.ts` | content | composed-result | M +544/-0 | M +325/-0 |
| conflict | `packages/load-balancer/src/strategies/index.ts` | content | composed-result | M +20/-4 | M +112/-55 |
| conflict | `packages/load-balancer/src/strategies/least-used.ts` | content | composed-result | M +12/-1 | M +62/-19 |
| conflict | `packages/load-balancer/src/strategies/session-affinity.ts` | content | composed-result | M +35/-9 | M +1312/-63 |
| conflict | `packages/load-balancer/src/strategies/session-drain-soonest.ts` | content | composed-result | M +154/-18 | M +195/-428 |
| conflict | `packages/openai-formats/src/__tests__/stream.test.ts` | content | same-as-fork-parent | unchanged | M +477/-22 |
| conflict | `packages/openai-formats/src/stream.ts` | content | same-as-fork-parent | unchanged | M +148/-58 |
| conflict | `packages/openai-responses-adapter/src/handler.ts` | content | composed-result | M +100/-0 | M +308/-84 |
| conflict | `packages/providers/src/index.ts` | content | composed-result | M +2/-2 | M +16/-4 |
| conflict | `packages/providers/src/providers/codex/on-demand-fetch.ts` | content | composed-result | M +14/-6 | M +16/-55 |
| conflict | `packages/providers/src/providers/codex/provider.test.ts` | content | composed-result | M +242/-130 | M +7399/-693 |
| conflict | `packages/providers/src/providers/codex/provider.ts` | content | composed-result | M +379/-56 | M +2935/-746 |
| conflict | `packages/providers/src/providers/index.ts` | content | composed-result | M +15/-14 | M +40/-3 |
| conflict | `packages/providers/src/providers/openai/provider.ts` | content | composed-result | M +16/-10 | M +134/-82 |
| conflict | `packages/providers/src/providers/xai/provider.test.ts` | content | composed-result | M +17/-16 | M +393/-2 |
| conflict | `packages/providers/src/providers/xai/provider.ts` | content | same-as-fork-parent | unchanged | M +182/-25 |
| conflict | `packages/providers/src/utils/model-mapping.ts` | content | composed-result | M +15/-2 | M +121/-89 |
| conflict | `packages/providers/src/utils/stream-drain.ts` | content | composed-result | M +87/-9 | M +77/-4 |
| conflict | `packages/proxy/src/__tests__/codex-model-catalog.test.ts` | content | composed-result | M +63/-0 | M +471/-14 |
| conflict | `packages/proxy/src/__tests__/proxy-model-capacity.test.ts` | modify/delete | deleted-in-result | unchanged | D +0/-457 |
| conflict | `packages/proxy/src/__tests__/usage-collector-lifecycle.test.ts` | content | composed-result | M +54/-0 | M +3733/-326 |
| conflict | `packages/proxy/src/anthropic-terminal-recovery.ts` | content | composed-result | M +17/-26 | M +106/-273 |
| conflict | `packages/proxy/src/auto-refresh-scheduler.ts` | content | composed-result | M +120/-14 | M +153/-184 |
| conflict | `packages/proxy/src/codex-model-catalog.ts` | content | composed-result | M +27/-2 | M +157/-58 |
| conflict | `packages/proxy/src/handlers/account-selector.ts` | content | composed-result | M +56/-9 | M +2508/-762 |
| conflict | `packages/proxy/src/handlers/index.ts` | content | composed-result | M +10/-0 | M +31/-17 |
| conflict | `packages/proxy/src/handlers/proxy-operations.ts` | content | composed-result | M +77/-10 | M +6318/-765 |
| conflict | `packages/proxy/src/index.ts` | content | composed-result | M +16/-1 | M +130/-3 |
| conflict | `packages/proxy/src/proxy.ts` | content | composed-result | M +71/-14 | M +3281/-429 |
| conflict | `packages/proxy/src/response-handler.ts` | content | composed-result | M +9/-0 | M +1238/-192 |
| conflict | `packages/types/src/account.ts` | content | composed-result | M +2/-2 | M +131/-5 |
| conflict | `packages/types/src/constants.ts` | content | composed-result | M +3/-3 | M +1/-1 |
| conflict | `packages/types/src/provider-config.ts` | content | composed-result | M +2/-2 | M +4/-4 |
| conflict | `README.md` | content | composed-result | M +3/-3 | M +110/-35 |
| shared-path | `.gitignore` | clean | composed-result | M +1/-0 | M +3/-4 |
| shared-path | `apps/cli/package.json` | clean | composed-result | M +1/-1 | M +7/-7 |
| shared-path | `docs/api-http.md` | clean | composed-result | M +85/-0 | M +122/-10 |
| shared-path | `package.json` | clean | composed-result | M +1/-1 | M +3/-0 |
| shared-path | `packages/config/src/alerts-config.test.ts` | clean | composed-result | M +13/-0 | M +15/-0 |
| shared-path | `packages/core/src/version.ts` | clean | composed-result | M +1/-1 | M +42/-0 |
| shared-path | `packages/dashboard-web/src/api.ts` | clean | composed-result | M +90/-25 | M +453/-172 |
| shared-path | `packages/dashboard-web/src/App.tsx` | clean | composed-result | M +9/-36 | M +17/-0 |
| shared-path | `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` | clean | composed-result | M +5/-0 | M +192/-8 |
| shared-path | `packages/dashboard-web/src/components/accounts/RateLimitProgress.test.tsx` | clean | composed-result | M +152/-0 | M +149/-1 |
| shared-path | `packages/dashboard-web/src/components/combos/CombosTab.tsx` | clean | composed-result | M +3/-0 | M +61/-10 |
| shared-path | `packages/dashboard-web/src/components/OverviewTab.tsx` | clean | composed-result | M +71/-16 | M +21/-0 |
| shared-path | `packages/dashboard-web/src/lib/query-keys.ts` | clean | composed-result | M +6/-3 | M +15/-0 |
| shared-path | `packages/database/src/__tests__/multi-instance-guard.test.ts` | clean | same-as-both | unchanged | unchanged |
| shared-path | `packages/database/src/adapters/bun-sql-adapter.ts` | clean | composed-result | M +26/-1 | M +129/-9 |
| shared-path | `packages/database/src/index.ts` | clean | same-as-fork-parent | unchanged | M +40/-0 |
| shared-path | `packages/database/src/migrations-pg.ts` | clean | composed-result | M +329/-33 | M +888/-52 |
| shared-path | `packages/database/src/multi-instance-guard.ts` | clean | same-as-both | unchanged | unchanged |
| shared-path | `packages/database/src/repositories/__tests__/usage-history.repository.test.ts` | clean | composed-result | M +441/-0 | M +525/-28 |
| shared-path | `packages/database/src/repositories/request.repository.ts` | clean | composed-result | M +12/-5 | M +76/-19 |
| shared-path | `packages/http-api/src/handlers/alerts.ts` | clean | composed-result | M +4/-0 | M +4/-0 |
| shared-path | `packages/http-api/src/handlers/insights.ts` | clean | composed-result | M +13/-2 | M +215/-0 |
| shared-path | `packages/http-api/src/services/__tests__/auth-failure-alert.test.ts` | clean | composed-result | M +1/-0 | M +144/-7 |
| shared-path | `packages/http-api/src/services/alerts.ts` | clean | composed-result | M +70/-11 | M +632/-19 |
| shared-path | `packages/load-balancer/src/index.ts` | clean | composed-result | M +1/-0 | M +1/-0 |
| shared-path | `packages/load-balancer/src/strategies/__tests__/session-drain-soonest.test.ts` | clean | composed-result | M +87/-0 | M +319/-621 |
| shared-path | `packages/load-balancer/src/strategies/__tests__/session-strategy.test.ts` | clean | composed-result | M +136/-0 | M +120/-57 |
| shared-path | `packages/openai-formats/src/types.ts` | clean | same-as-fork-parent | unchanged | M +11/-3 |
| shared-path | `packages/openai-responses-adapter/src/__tests__/handler.test.ts` | clean | composed-result | M +193/-0 | M +618/-9 |
| shared-path | `packages/openai-responses-adapter/src/stream-translator.ts` | clean | composed-result | M +8/-0 | M +262/-66 |
| shared-path | `packages/providers/src/providers/codex/provider.fidelity.test.ts` | clean | composed-result | M +83/-0 | M +501/-0 |
| shared-path | `packages/providers/src/providers/vertex-ai/provider.ts` | clean | composed-result | M +5/-2 | M +26/-34 |
| shared-path | `packages/providers/src/types.ts` | clean | composed-result | M +1/-0 | M +261/-24 |
| shared-path | `packages/providers/src/utils/__tests__/model-mapping.test.ts` | clean | composed-result | M +20/-0 | M +143/-3 |
| shared-path | `packages/proxy/src/handlers/__tests__/account-selector.test.ts` | clean | composed-result | M +6/-2 | M +4839/-78 |
| shared-path | `packages/proxy/src/handlers/agent-interceptor.ts` | clean | composed-result | M +19/-2 | M +4/-4 |
| shared-path | `packages/proxy/src/handlers/response-processor.ts` | clean | composed-result | M +33/-4 | M +187/-78 |
| shared-path | `packages/proxy/src/stream-tee.ts` | clean | composed-result | M +2/-0 | M +38/-21 |
| shared-path | `packages/proxy/src/usage-collector.ts` | clean | composed-result | M +58/-0 | M +1093/-317 |
| shared-path | `packages/types/src/alerts.ts` | clean | composed-result | M +7/-0 | M +55/-1 |
| shared-path | `packages/types/src/insights.ts` | clean | composed-result | M +58/-6 | M +148/-0 |
| shared-path | `packages/types/src/strategy.ts` | clean | composed-result | M +4/-0 | M +21/-6 |

Every row above was resolved at index stage 0 and compared to both parents by
blob identity, name status, and line delta. A `composed-result` differs from both
parents; a one-parent match is listed below for explicit semantic inspection.

## One-parent matches requiring explicit inspection

- `packages/core/src/pricing.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: the candidate already has upstream's `meta` pricing entries, while the upstream parent drops bundled Opus 5 pricing, removes `openai` from canonical-provider precedence (reintroducing reseller-first mispricing), and removes `isModelPriced()`, which distinguishes unknown models from genuinely free models. Focused evidence and reviewer acceptance remain U8 gates.
- `packages/openai-formats/src/__tests__/stream.test.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: these tests already verify the upstream 500k Grok window and cache-inclusive current-usage normalization, and also preserve absent-vs-zero cache semantics, cache read/write normalization, bounded terminal SSE errors without synthetic success, and the constructed xhigh reasoning/tool canary that the upstream parent removes. Focused evidence and reviewer acceptance remain U8 gates.
- `packages/openai-formats/src/stream.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: the candidate invokes shared `normalizeOpenAIInputUsage()` for cache-inclusive prompt accounting, advertises the upstream Grok context window only when usage is trustworthy, and preserves optional unknown usage, explicit zero cache values, bounded terminal provider errors, and no synthetic success after an SSE error. The upstream parent removes those stronger contracts. Focused evidence and reviewer acceptance remain U8 gates.
- `packages/providers/src/providers/xai/provider.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: the candidate already calls `resolveXaiContextWindow()` for official endpoints, while the upstream parent regresses default mappings from Grok 4.5 to 4.3 and removes logical capability declarations, bounded/typed OAuth refresh errors, 402/429 capacity classification, safe endpoint fallback, reasoning-effort translation, and opt-in native conversation affinity. Focused evidence and reviewer acceptance remain U8 gates.
- `packages/database/src/index.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: the upstream change is formatting-only, but the upstream parent also drops public exports for cache-flight recording, device-setup jobs, server-tool replay issuance, and usage windows because those fork repositories are absent there. Retaining the fork barrel preserves existing callers while keeping shared multi-instance exports and formatting. Focused evidence and reviewer acceptance remain U8 gates.
- `packages/openai-formats/src/types.ts`: **same-as-fork-parent** — Exact-parent comparison confirms deliberate fork preservation: the upstream parent narrows prompt/cache counters to required zero defaults and removes `output_config`, message `reasoning_content`, terminal-error state/code, and response cache usage fields. The fork keeps those optional distinctions so missing usage remains unknown rather than false zero and so streamed provider errors stay bounded and terminal. Focused evidence and reviewer acceptance remain U8 gates.

## Upstream-only test classification

| Test path | Candidate classification |
|---|---|
| `packages/config/src/combos-enabled.test.ts` | retained-with-candidate-composition |
| `packages/config/src/force-account-model.test.ts` | retained-verbatim |
| `packages/core/src/force-account-model-browser-bundle.test.ts` | retained-verbatim |
| `packages/core/src/force-account-model.test.ts` | retained-verbatim |
| `packages/core/src/probe-backoff.test.ts` | retained-verbatim |
| `packages/dashboard-web/src/components/overview/__tests__/ObservedRoutingTable.test.tsx` | retained-verbatim |
| `packages/dashboard-web/src/components/overview/__tests__/PoolCapacitySection.test.tsx` | retained-verbatim |
| `packages/dashboard-web/src/components/overview/__tests__/pool-usage-shared.test.ts` | retained-verbatim |
| `packages/dashboard-web/src/hooks/__tests__/usePersistedExpansion.test.ts` | retained-verbatim |
| `packages/dashboard-web/src/lib/__tests__/pool-usage.test.ts` | retained-verbatim |
| `packages/database/src/__tests__/cleanup-config.test.ts` | retained-verbatim |
| `packages/database/src/__tests__/cleanup-old-requests.test.ts` | retained-verbatim |
| `packages/database/src/__tests__/usage-history-cleanup.test.ts` | retained-verbatim |
| `packages/http-api/src/handlers/__tests__/accounts-codex-usage-history.test.ts` | retained-verbatim |
| `packages/http-api/src/handlers/__tests__/insights.test.ts` | retained-verbatim |
| `packages/http-api/src/handlers/__tests__/routing-observations.test.ts` | retained-verbatim |
| `packages/http-api/src/services/__tests__/anomaly-insights.test.ts` | retained-verbatim |
| `packages/load-balancer/src/strategies/__tests__/probe-backoff-penalty.test.ts` | retained-verbatim |
| `packages/load-balancer/src/strategies/__tests__/session-drain-soonest-active-selection.test.ts` | retained-with-candidate-composition |
| `packages/providers/src/providers/codex/provider.responses.test.ts` | retained-with-candidate-composition |
| `packages/providers/src/providers/meta/__tests__/provider.test.ts` | retained-with-candidate-composition |
| `packages/providers/src/providers/meta/__tests__/request-sanitizer.test.ts` | retained-verbatim |
| `packages/providers/src/utils/model-mapping-force-account-model.test.ts` | retained-verbatim |
| `packages/providers/src/utils/stream-drain.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/auto-refresh-prompt-pool.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/auto-refresh-uncounted-failure-cooldown.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/force-account-model-probe-exemption.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/force-account-model-refusal-order.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/project-attribution.test.ts` | retained-verbatim |
| `packages/proxy/src/__tests__/stream-reader-lock-release-382.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/account-selector-combos-enabled.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/account-selector-force-model.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/agent-interceptor.rewrite-guard.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/codex-usage-history.test.ts` | retained-with-candidate-composition |
| `packages/proxy/src/handlers/__tests__/codex-window-rollover.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/combo-session-fallback-source.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/proxy-operations-529-retry-clone-regression.test.ts` | retained-verbatim |
| `packages/proxy/src/handlers/__tests__/proxy-operations-529-retry-header-tagging.test.ts` | retained-with-candidate-composition |
| `packages/proxy/src/handlers/__tests__/routing-observations.test.ts` | retained-verbatim |

No upstream-only test path is missing from the staged result.

## Review boundary

This report proves exact parent/index comparisons and test-path retention only.
Behavioral acceptance comes from the isolated U2–U7 packets and final U8 gates;
reviewer acceptance and the real merge combined diff remain separate gates.
