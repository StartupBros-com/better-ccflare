---
title: Keep native cache TTL policy separate from proxy injection
date: 2026-10-08
category: integration-issues
module: claude-code-cache-policy
problem_type: tooling_decision
component: proxy
severity: medium
applies_when:
  - "Choosing main-conversation and worker cache TTLs for Claude Code through better-ccflare"
  - "Interpreting Anthropic cache markers on OpenAI-compatible or Codex routes"
tags: [claude-code, prompt-cache, cache-ttl, codex, gateway, configuration]
---

# Keep native cache TTL policy separate from proxy injection

## Context

The dashboard's **System Prompt Cache TTL** switch appeared to control caching even on OpenAI routes. The misleading assumption was that one proxy switch selected every backend's retention policy. It actually modifies an Anthropic-shaped request before account selection; later protocol conversion determines what survives.

The original October 2026 investigation recorded a client/upstream distinction: this host's `claude auth status` reported `authMethod: "api_key"` through the gateway, despite the upstream accounts using subscription plans. These are observations from that investigation, not defaults for every gateway. Leaving native TTL controls unset therefore did not express this host's intended one-hour main-conversation policy.

## Guidance

Let Claude Code select the requested TTL by request bucket, and keep that decision separate from proxy injection and provider retention. The adopted policy, persisted in [dotfiles PR #1698](https://github.com/StartupBros-com/dotfiles/pull/1698), was:

```json
{
  "promptCacheTtl": "1h",
  "subagentPromptCacheTtl": "5m"
}
```

The proxy's `system_prompt_cache_ttl_1h` was separately set to `false`. Main conversations benefit from surviving breaks; short, active workers can refresh a five-minute cache through normal reuse. These settings request native TTLs, not a universal backend retention guarantee. An explicit main `1h` also overrides the cheaper automatic default on paid API/usage-credit turns; reconsider it if the billing context changes.

[Claude Code's TTL documentation](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets) distinguishes main and helper buckets and their billing-dependent defaults. Bucket environment variables can override settings. Check the client's classification and overrides rather than inferring them from the provider account's plan. The installed client examined was 2.1.293.

### What the proxy switch does—and does not do

| Boundary | Verified behavior |
|---|---|
| Proxy injector | Runs without a provider predicate, before account selection. It adds `1h` only to array-form system blocks with an ephemeral marker and a missing/falsy TTL. Explicit `5m` and `1h` remain unchanged. Disabling the switch skips this mutation; it does **not** strip client TTLs or force five minutes. See [`proxy.ts:1135–1138`](../../../packages/proxy/src/proxy.ts#L1135-L1138) and [`:5143–5184`](../../../packages/proxy/src/proxy.ts#L5143-L5184). |
| OpenAI-compatible chat conversion | Copies the system text block's `cache_control` object. That proves preservation at this converter, not backend acceptance or a retention promise. See [`converters.ts:169–201`](../../../packages/openai-formats/src/converters.ts#L169-L201). |
| Codex conversion | Extracts system text without TTL metadata. An ephemeral marker's presence can influence the separate explicit-breakpoint feature; its `1h` value is not translated into a retention setting by this path. See [`provider.ts:3737–3747`](../../../packages/providers/src/providers/codex/provider.ts#L3737-L3747), [`:4808–4839`](../../../packages/providers/src/providers/codex/provider.ts#L4808-L4839), and the [TTL-removal test](../../../packages/providers/src/providers/codex/explicit-cache-breakpoint.test.ts#L281-L296). |

## Why This Matters

A switch-off comparison is not necessarily a one-hour-versus-five-minute comparison: Claude Code may already send `1h`. Likewise, seeing `1h` in an intermediate request does not establish Codex retention.

[Anthropic documents](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) five-minute writes at 1.25× ordinary input price and one-hour writes at 2×. Hits refresh the lifetime, measured from request start. Longer retention helps only when it preserves a reusable prefix that the shorter policy would lose. A high aggregate cache-read share or mostly short session gaps cannot establish that counterfactual: parallel agents, changing prefixes, account selection, and shared refreshes confound it. API prices also do not establish subscription-allowance weighting.

The original investigation's recorded checks covered saved native settings, the proxy's effective API value and persisted file, and the adapter source—not an end-to-end capture of every running session. They establish **neither causal savings, quota improvement, nor sustained cache parity**. The operational observations are historical; the merged dotfiles change proves the tracked policy, not current live uptake on another host.

## When to Apply

Use this distinction when changing a gateway, authentication mode, client version, or cache policy. Recheck the native controls and the actual outbound adapter before carrying a TTL assumption across providers.

Do not enable synthetic keepalives to prove the policy. This repository forbids scripted inference against Anthropic-backed accounts.

## Examples

To inspect client classification without exposing account identity or credentials:

```sh
claude auth status --json | jq '{authMethod, apiProvider, subscriptionType}'
```

For an approved policy change, verify native settings first, disable injection through the existing config API, and check both its effective value and persisted JSON. A later comparison should use ordinary authorized traffic and actual five-minute/one-hour write counters—not the toggle label alone.

## Related

- [Codex affinity needs the session-id header](codex-cache-affinity-needs-session-id-header.md): affinity is distinct from TTL intent.
- [Diagnose cache alerts by context mix and sample support](../observability/diagnose-new-model-cache-alerts-by-context-mix-and-sample-support.md): descriptive reuse is not causal evidence.
- [Codex trace input is cache-inclusive](../observability/codex-trace-input-tokens-are-cache-inclusive.md): use source-correct denominators.
- [Cache parity](../../../CONCEPTS.md#cache-parity) and [issue #174](https://github.com/StartupBros-com/better-ccflare/issues/174): their separate sustained-validation obligation is not completed by this settings change.
