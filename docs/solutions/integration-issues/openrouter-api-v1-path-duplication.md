---
title: OpenRouter Anthropic fallback 404s on a duplicated /v1 path
date: 2026-08-12
category: integration-issues
module: openrouter-provider
problem_type: integration_issue
component: tooling
symptoms:
  - "Claude Code shows There's an issue with the selected model (claude-opus-5[1m]) when falling back to OpenRouter"
  - Every OpenRouter /v1/messages attempt records HTTP 404
  - The quoted model name is the local Claude Code picker, not the upstream model
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - openrouter
  - fusion
  - model-mapping
  - url-builder
  - claude-code
---

# OpenRouter Anthropic fallback 404s on a duplicated /v1 path

## Problem

When Anthropic-backed accounts are exhausted, Claude Code fallback through the OpenRouter provider never reaches a real model. The client shows a selected-model access error that names the local picker id.

## Symptoms

- Claude Code banner: `There's an issue with the selected model (claude-opus-5[1m]). It may not exist or you may not have access to it.`
- Live request history for the OpenRouter account is all 404s on `/v1/messages` and `/v1/messages/count_tokens`.
- The same banner appears no matter which OpenRouter model mapping is intended.

## What Didn't Work

- Treating `[1m]` as a mapping miss. `getModelFamily("claude-opus-5[1m]")` still returns `opus`, and a family mapping still rewrites the body.
- Deleting `OpenRouterProvider.buildUrl` so the generic Anthropic-compatible join runs. That helper only strips a pathname prefix that already equals the full base path (`/api/v1`), so `/v1/messages` still becomes `/api/v1/v1/messages`.
- Using the quoted Claude model name as proof that OpenRouter received that string. Claude Code interpolates the locally selected picker into a generic `model_not_found` template.

## Solution

Strip a duplicate `/v1` when the OpenRouter base already ends in `/v1`. The documented Anthropic endpoint is `https://openrouter.ai/api/v1/messages`.

Fix opened in #164, unmerged as of this writing. Coverage lives in `packages/providers/src/providers/openrouter/__tests__/provider.test.ts`.

## Why This Works

`OPENROUTER_DEFAULT_ENDPOINT` is `https://openrouter.ai/api/v1`. Claude Code sends pathname `/v1/messages`. Naive concatenation produced `/api/v1/v1/messages`, which 404s before model resolution. After the join, the request hits OpenRouter's Anthropic Messages path.

## Prevention

- Any provider whose base already ends in `/api/v1` or `/v1` needs a unit test that `buildUrl("/v1/messages", "")` does not contain `/v1/v1/`.
- Do not diagnose Claude Code "selected model (X)" banners as upstream model ids. X is the local picker name.

## Related Issues

- Draft PR #164 restores the OpenRouter Anthropic path join.
- Separate operational residuals, not fixed by #164: the live account maps every family to bare `fusion` (OpenRouter documents `openrouter/fusion`), and service logs later show OpenRouter 401s.
