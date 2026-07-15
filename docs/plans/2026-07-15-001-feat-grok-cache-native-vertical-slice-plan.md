---
title: "Grok Cache-Native Vertical Slice - Plan"
type: feat
date: 2026-07-15
topic: grok-cache-native-vertical-slice
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Grok Cache-Native Vertical Slice - Plan

## Goal Capsule

- **Objective:** Prove a correct, opt-in native Grok Chat cache path on official xAI: conversation-partitioned identity, sticky account ownership, fail-closed force-route, and fixture-backed cache-token telemetry.
- **Product authority:** This Product Contract. Seeded from `docs/ideation/2026-07-15-native-grok-cache-routing-ideation.html` idea 1.
- **Open blockers:** None. Ready for implementation planning.

## Product Contract

### Summary

Ship an opt-in Grok Chat vertical slice that attaches a conversation-partitioned native affinity identifier on official xAI, binds that conversation to a sticky account owner, fails closed when a forced owner is unavailable, and proves mechanism correctness with fixtures plus structured canary telemetry. Done means the mechanism works, not that hit rate already improved.

### Problem Frame

better-ccflare already routes Claude Code traffic to xAI through a thin Chat Completions adapter. Official xAI documents automatic exact-prefix caching and a Chat-native affinity control, but the current provider emits no native identity, does not bind that identity to account locality, and has no xAI-specific proof that cached-token usage is observed correctly.

The Codex path already solved the related failure mode where one Claude session multiplexes many conversations. Without conversation partitioning and ownership, a Grok cache feature can look enabled while still colliding subagents or bouncing between accounts that do not share warm state. The cheapest useful product step is therefore a mechanism proof, not a broader scheduler or protocol rewrite.

### Key Decisions

- **Mechanism proof is the done bar.** The slice is complete when identity, ownership, official-endpoint gating, force-route fail-closed behavior, cached-token fixtures, and canary telemetry all work. A production hit-rate lift is a later success signal, not a release gate.
- **Opt-in first.** The feature stays off by default and is enabled through an explicit configuration or environment flag for canaries.
- **Conversation-partitioned identity.** Native identity is derived from a validated Claude session ID plus a stable conversation seed, not from the whole Claude session alone. Sibling and subagent conversations get different IDs.
- **Sticky ownership is required when enabled.** When the feature is on, the conversation has a sticky xAI account owner. Temporary failover may still serve availability, but the owner mapping is preserved for restore rather than forgotten.
- **Force-route fails closed under the feature.** If a request force-routes to an unavailable account while the feature is on, the system returns an explicit unavailable outcome instead of silently selecting another account.
- **Telemetry is logs and traces for v1.** Structured canary telemetry is required. Dashboard and cache-insights wiring are deferred unless planning finds them free.
- **Official xAI only at first.** Custom or self-hosted xAI-compatible endpoints stay gated off until capability is verified.

### Actors

- A1. Operator running better-ccflare with one or more official xAI accounts.
- A2. Claude Code client sending multi-turn and multi-conversation traffic through the proxy.
- A3. Official xAI Chat Completions endpoint receiving the adapted request and returning usage.

### Key Flows

- F1. Opt-in official Grok turn
  - **Trigger:** Feature flag enabled; request routes to an official xAI Chat account.
  - **Actors:** A1, A2, A3
  - **Steps:** Derive conversation identity; ensure sticky account ownership; attach native Chat affinity identifier; forward request; record canary telemetry including identity hash, serving account, prefix fingerprint, and cache outcome.
  - **Covered by:** R1, R2, R3, R4, R8, R9

- F2. Sibling or subagent separation
  - **Trigger:** Two concurrent conversations share a Claude session but differ in conversation seed.
  - **Actors:** A2, A3
  - **Steps:** Each conversation receives a distinct native identity; each keeps its own sticky owner contract.
  - **Covered by:** R2, R3, R4

- F3. Unavailable force-route
  - **Trigger:** Feature flag enabled and request force-routes to an unavailable xAI account.
  - **Actors:** A1, A2
  - **Steps:** Do not silently fall back to another account; return an explicit unavailable outcome; emit telemetry that the ownership contract blocked fallback.
  - **Covered by:** R5, R9

- F4. Custom endpoint request
  - **Trigger:** Feature flag enabled but the account targets a non-official or unverified endpoint.
  - **Actors:** A1, A2
  - **Steps:** Do not attach the native affinity identifier; do not claim the feature is active for that request.
  - **Covered by:** R6

### Requirements

**Activation and identity**

- R1. The feature is off by default and becomes active only through an explicit operator-controlled opt-in.
- R2. When active for an official xAI Chat request, the system derives a privacy-safe conversation identity from a validated Claude session ID plus a stable conversation seed.
- R3. Successive turns of the same conversation reuse the same native identity; sibling or subagent conversations under the same Claude session receive different identities.
- R4. When the feature is active, the conversation is bound to sticky xAI account ownership for the duration of the cache lineage, with temporary failover allowed only under the existing restore-preserving ownership model.

**Routing safety**

- R5. When the feature is active and a request force-routes to an unavailable account, the system fails closed with an explicit unavailable outcome rather than silently selecting another account.
- R6. The native Chat affinity identifier is attached only for verified official xAI endpoints. Custom or self-hosted endpoints remain ungated for this feature until separately verified.
- R7. When identity cannot be derived safely from request metadata, the system omits the native identifier rather than inventing an unstable or colliding one.

**Proof and telemetry**

- R8. Streaming and non-streaming official xAI responses that report cached-token usage are translated into the proxy's existing cache-read accounting path, with fixtures covering both cases.
- R9. While the feature is active, each canary-eligible request records structured telemetry for native identity hash, serving account, prefix fingerprint, and cache outcome, including an explicit unknown state when cache telemetry is absent.
- R10. Acceptance for this slice is mechanism correctness under fixtures and canary telemetry. A production cached-token or latency lift is not required for done.

### Acceptance Examples

- AE1. Same conversation, two turns
  - **Covers:** R2, R3, R4, R9
  - **Given:** Feature enabled, official xAI account, valid Claude session metadata, and a stable conversation seed.
  - **When:** Two successive turns of the same conversation are sent.
  - **Then:** Both turns use the same native identity, stay under the sticky owner contract, and emit canary telemetry for that identity and account.

- AE2. Sibling conversations under one Claude session
  - **Covers:** R2, R3
  - **Given:** Feature enabled and one Claude session containing two conversations with different seeds.
  - **When:** Both conversations send a turn.
  - **Then:** Each receives a different native identity.

- AE3. Force-route to unavailable owner
  - **Covers:** R5, R9
  - **Given:** Feature enabled and a force-route targeting an unavailable xAI account.
  - **When:** The request is processed.
  - **Then:** The proxy does not silently select another account, returns an explicit unavailable outcome, and records that the ownership contract blocked fallback.

- AE4. Custom endpoint remains inert
  - **Covers:** R6
  - **Given:** Feature enabled and an xAI-provider account pointed at an unverified custom endpoint.
  - **When:** A request is processed.
  - **Then:** No native Chat affinity identifier is attached and the request is not counted as an active official-xAI canary.

- AE5. Cached-token translation
  - **Covers:** R8, R10
  - **Given:** Official xAI streaming and non-streaming fixtures that include cached-token usage details.
  - **When:** Those responses are translated.
  - **Then:** Cache-read accounting is populated correctly, and a fixture with absent cache details records unknown rather than inventing a zero-hit result if the path can distinguish absence.

### Success Criteria

- An operator can enable the feature, send repeated official xAI Chat turns through Claude Code-shaped requests, and inspect structured telemetry proving identity stability, account ownership, and cache-outcome recording.
- Fixture coverage proves conversation partitioning, official-endpoint gating, force-route fail-closed behavior, and streaming plus non-streaming cached-token translation.
- No real Anthropic account is required or used for automated validation of this slice.

### Scope Boundaries

**In scope**

- Official xAI Chat Completions path only.
- Conversation-partitioned native affinity identity.
- Sticky account ownership for active conversations.
- Fail-closed force-route when the feature is active.
- Cached-token translation fixtures.
- Structured logs/traces canary telemetry.

**Deferred for later**

- xAI Responses API path and `prompt_cache_key`.
- Compaction-aware cache epochs.
- Dashboard or cache-insights UI for the new fields.
- Value-aware scheduling, working-set admission, or continuous policy tournaments.
- Durable reasoning-history WAL beyond what is required to keep current Chat conversion correct.
- Custom-endpoint enablement after capability verification.

**Outside this product slice**

- Automated traffic against real Anthropic accounts.
- Free secondary-account prewarming or multi-account cache insurance.
- A provider-wide rewrite of all cache systems beyond the Grok vertical slice.

### Dependencies / Assumptions

- Official xAI Chat continues to accept a conversation affinity identifier and continues to report cached tokens through an OpenAI-compatible usage path or a fixture-provable equivalent.
- Claude Code continues to expose enough session metadata for validated conversation identity derivation on the requests better-ccflare already handles.
- Existing session-affinity ownership semantics are sufficient as the sticky-owner foundation when the feature is enabled.
- Existing shared OpenAI-compatible usage translation is a viable base for cached-token proof, subject to fixture confirmation for actual xAI response shapes.

### Outstanding Questions

**Deferred to Planning**

- Exact opt-in flag name and configuration surface.
- Exact stable conversation-seed inputs and hashing details, reusing Codex lessons without copying OpenAI-specific wire constraints blindly.
- Exact structured telemetry channel and field names for canary events.
- Whether temporary normal-path failover should emit a distinct lineage-break event in v1 telemetry or only force-route fail-closed events.
- How official-endpoint verification is represented for accounts with custom endpoint overrides that still resolve to official xAI.

### Sources / Research

- `docs/ideation/2026-07-15-native-grok-cache-routing-ideation.html` — ranked idea 1 and sequencing rationale.
- `packages/providers/src/providers/xai/provider.ts` — current thin Chat Completions adapter with no native affinity field.
- `packages/providers/src/providers/codex/provider.ts` and related tests — conversation-partitioned cache identity, opt-in posture, endpoint gating, and fixture patterns.
- `packages/load-balancer/src/strategies/session-affinity.ts` — sticky account ownership and temporary failover restore semantics.
- `packages/proxy/src/handlers/account-selector.ts` — current force-route fallback behavior for unavailable targets.
- `packages/providers/src/providers/openai/provider.ts` and `packages/openai-formats/src/stream.ts` — existing `cached_tokens` translation path.
- xAI prompt-caching documentation — automatic exact-prefix caching and Chat affinity control.
