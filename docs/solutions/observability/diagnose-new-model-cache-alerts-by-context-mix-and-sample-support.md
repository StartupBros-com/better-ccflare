---
title: Diagnose new-model cache alerts by context mix and sample support
date: 2026-09-29
category: observability
module: cache-health
problem_type: best_practice
component: observability
severity: medium
applies_when:
  - A new physical model has a cache-efficiency alert or worse aggregate reuse than its predecessor
  - Compared traffic has different context-size distributions or request support
tags:
  - cache-health
  - prompt-cache
  - observability
  - cohort-analysis
  - sample-size
---

# Diagnose new-model cache alerts by context mix and sample support

## Context

The Sonnet 5.5 incident on September 29 initially suggested a model-specific caching regression. The investigation instead found a substantial traffic-composition difference and a thin critical bucket. The durable lesson is to **inspect sample support and compare context-size bands before attributing an aggregate reuse gap to routing or warmed-cache behavior**. Neither a low aggregate nor an alert's recovery proves the cause.

The saved investigation reconstructed the 04:20–04:30 UTC bucket behind the provider alert recorded at 04:35:20 UTC: 10 measured requests, 52,209 uncached input tokens, 93,279 cache-read tokens, and 83,090 cache-write tokens. Its additive denominator was 228,578 tokens, giving `93,279 / 228,578 = 40.8%`. The reconstruction reported positive cache reads on all ten requests: low token reuse was not synonymous with zero-hit requests. This was a reported bucket reconstruction, not a replay of the complete detector state machine.

The early model-specific fork/side-query explanation did not survive the investigation's refutation. Rather than changing routing to address that hypothesis, the shipped response in [PR #389](https://github.com/StartupBros-com/better-ccflare/pull/389) narrowed the immediate-critical path's sample qualification. That changes alert sensitivity, not the provider's cache.

## Guidance

1. **Fix the population and token semantics first.** Record UTC bounds, serving model, provider/path, request outcomes, measured/eligible counts, and exclusions. For native Anthropic additive usage, token-weighted reuse is `SUM(cache_read_input_tokens) / SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`. It is not the mean of per-request percentages. A cache-inclusive input total requires a different denominator; do not combine Codex trace input with this additive formula.

2. **Keep missing telemetry separate from measured zero.** The detector computes coverage as measured/eligible and zero-hit share as zero-hit/measured (`packages/http-api/src/services/cache-health.ts:139-152`). Use the repository's normalization and classification when reconstructing detector eligibility (`packages/database/src/repositories/cache-health.repository.ts`), rather than converting every missing counter to zero. Report coverage and zero-hit share as countermetrics alongside reuse.

3. **Inspect request support independently of token volume.** Ten medium-sized requests can satisfy a token floor while remaining a thin request sample. Show request counts, input-token totals, zero-hit share, and neighboring buckets before deciding that one low bucket warrants an immediate critical or a routing change.

4. **Compare within total-input bands.** For each model and band, show request count, summed read/total ratio, and the band's share of that model's total input tokens. Recorded session/cohort information can refine the comparison, but context size is not an exact measurement of session age, identical prefixes, client-process pinning, or equivalent workloads. Do not explain those mechanisms solely from a band table.

5. **Standardize with token-share weights.** Let `r_new,b` be the new model's read/total ratio in band `b`, and `w_ref,b` the reference model's fraction of total additive input tokens in that band. The descriptive standardized rate is `SUM(w_ref,b * r_new,b)`. Use unrounded totals when available. Request-share weights answer a different question. Preserve residual within-band gaps and flag sparse comparator bands rather than declaring equivalence from one standardized number.

6. **Change only the mechanism supported by the evidence.** Current defaults have a separate `criticalMinimumRequests=30` for the single-bucket below-50% reuse opening/escalation path; ordinary qualification still uses `minimumRequests=10`, and warnings still require three qualifying bad buckets (`packages/types/src/cache-health.ts:84-102`; `packages/http-api/src/services/cache-health.ts:203-212`; `packages/http-api/src/services/cache-health.ts:316-328`). Critical also needs two retained healthy baseline buckets. Thin traffic can still accumulate a warning. Thirty is an operational floor, not a statistical guarantee; the tradeoff is fewer thin-sample criticals versus less immediate critical detection on low-traffic scopes. See the [configuration reference](../../configuration.md#recorded-cache-health) for the rest of the policy.

## Why This Matters

Aggregate reuse is weighted by the traffic's input-token distribution. Small contexts can devote a larger fraction to fresh input and cache writes. A newer model serving more small contexts can therefore have a lower overall cache-read share without a similarly large difference in larger-context bands. That is a hypothesis to measure, not a rule that new-model alerts are harmless.

The evaluator's thresholds and regression tests do not preserve this diagnostic reasoning. Without the composition comparison, a future launch can repeat the already-refuted inference that the aggregate gap alone proves a model-specific routing, fork, or warmed-cache failure. If a substantial difference remains within matched populations, investigate prefix construction, account affinity, model-specific behavior, gaps/TTL, and routing next.

## When to Apply

- A new serving model triggers cache-efficiency alerts or looks worse in an aggregate dashboard comparison.
- Workload or context-size mix changes even without a model release.
- A thin single bucket prompts a cache-policy or routing intervention.

This is not a reason to dismiss sustained within-band degradation or poor telemetry coverage. It does not establish sustained cache parity, identical-prefix reuse, causal equivalence, or completion of the separate Codex parity/measurement work.

## Examples

### Saved September 29 context-size comparison

The primary band table was verified against the original saved SQL output. Its population was **successful POST `/v1/messages` rows**, with `model` exactly `claude-sonnet-5` or `claude-sonnet-5-5`, from **2026-09-28 18:00:00 UTC inclusive to 2026-09-29 04:40:00 UTC exclusive**. It contained 7,923 Sonnet 5 requests and 1,729 Sonnet 5.5 requests.

This exploratory query coalesced missing input/read/write counters to zero and did **not** reproduce all detector provider, account-generation, completion, internal-origin, and measured-coverage filters. It supports descriptive composition analysis, not exact alert eligibility. The bucket reconstruction above used a different, broader observation window and stricter filters; do not silently merge their populations.

Each reuse percentage below is summed reads divided by summed additive input **within the model and band**. Token share is the band's fraction of that model's total additive input across all six bands. Zero-read share is the percentage of band requests with coalesced read tokens equal to zero; because NULL was coalesced, it is not a clean measured-cold metric.

| Total input band | Sonnet 5 requests | Reuse % | Zero-read % | Token share % | Sonnet 5.5 requests | Reuse % | Zero-read % | Token share % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| <10k | 98 | 40.6 | 35.7 | 0.1 | 169 | 49.4 | 26.0 | 1.1 |
| 10k–<25k | 485 | 79.0 | 3.7 | 1.2 | 301 | 69.1 | 2.0 | 5.1 |
| 25k–<50k | 1,171 | 81.7 | 3.9 | 6.8 | 416 | 78.9 | 5.3 | 15.7 |
| 50k–<100k | 3,145 | 92.9 | 0.6 | 35.1 | 520 | 91.7 | 0.6 | 34.8 |
| 100k–<200k | 3,023 | 96.5 | 0.1 | 56.7 | 302 | 97.5 | 0.3 | 38.7 |
| ≥200k | 1 | 5.0 | 0.0 | 0.0 | 21 | 99.0 | 0.0 | 4.5 |

Under-50k contexts contributed about **21.9%** of Sonnet 5.5 input tokens versus **8.1%** for Sonnet 5, summing the displayed rounded shares. Reuse was broadly close in the two well-supported larger bands, not identical. The smaller bands retained differences, and the ≥200k reference band had only one request.

Applying the displayed Sonnet 5 token shares to the displayed Sonnet 5.5 rates and normalizing their rounded 99.9% weight sum gives approximately **93.8%**. This is a derived illustration from rounded output, **not a separately measured unrounded standardized rate**. The saved table lacks absolute token totals per band, so those cannot be reconstructed from the percentages.

The table is enough to show why a blanket model-level caching-collapse diagnosis was poorly supported. It is not an A/B test, an identical-prefix comparison, or proof that routing can never affect cache reuse.

### Implementation anchors, not new live proof

PR #389 is merged and reachable from the source revision inspected for this learning. Its tests cover the 29-versus-30 boundary, sustained thin-bucket warnings, and thin-bucket escalation suppression (`packages/http-api/src/services/__tests__/cache-health.test.ts:146-190`). Test coverage of the alert policy does not demonstrate live Discord receipt or the provider's cache semantics.

## Related

- [Cache-inclusive Codex trace input versus additive persisted usage](codex-trace-input-tokens-are-cache-inclusive.md).
- [Codex cache affinity and the session-id header](../integration-issues/codex-cache-affinity-needs-session-id-header.md): a different incident with a protocol-header cause; do not transplant its exact-prefix conclusions here.
- [Verify fix ancestry before citing a measured rate](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).
- [Cache-health alert work spec #368](https://github.com/StartupBros-com/better-ccflare/issues/368), which remains open pending operator confirmation.
