---
title: Verify a capacity-exhausted provider lane by running the deployed and previous binaries side by side against a mock upstream
date: 2026-09-25
category: workflow-issues
module: capacity-exhausted-lane-verification
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Verifying a provider-lane proxy fix when every account on that provider is at capacity and force-routed requests fail closed before the lane runs
  - Comparing a newly deployed binary's behavior against the previous production build for the same code path
  - Needing production-shaped evidence (trace records, the upstream request body, a scratch database row) without spending any account's real quota
  - AGENTS.md forbids scripted traffic to Anthropic-backed accounts, so verification must run against a mock upstream or a non-Anthropic account
  - A provider's custom_endpoint field accepts any http host, making a local mock upstream substitutable for the real backend
symptoms:
  - force_route_account_capacity_exhausted returned for every Codex-pinned request while every Codex Pro account sat at 100% of its seven-day window
  - The Codex trace directory recorded nothing for the verification window, indistinguishable at a glance from no traffic having been sent
  - The verification session itself was interrupted by Anthropic gateway 503s when the shared pool ran thin mid-harness
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - providers
tags:
  - codex
  - fail-closed
  - anthropic-account-safety
  - proxy
  - capacity-exhausted
  - mock-upstream
  - dual-binary-comparison
  - custom-endpoint
---

# Verify a capacity-exhausted provider lane by running the deployed and previous binaries side by side against a mock upstream

## Context

PR #381 (issue #380) fixed the Codex-lane containment decision so that the session-id attribution fallback no longer counts as agent evidence (the bug and fix are in `docs/solutions/integration-issues/codex-lane-session-attribution-fallback-mistaken-for-agent-evidence.md`). The fix was merged and deployed as build `b8276363`. But on the day of the deploy every Codex Pro account in production was at 100% of its seven-day usage window. A Codex-pinned request force-routes with `x-better-ccflare-account-id` and fails closed before the Codex provider ever runs: `packages/proxy/src/handlers/account-selector.ts:2665-2687` throws `ForceRouteUnavailableError` (the `ForceRouteUnavailableReason` union at `account-selector.ts:613-623` includes `account_capacity_exhausted`), `packages/proxy/src/proxy.ts:943-948` labels the routing terminal `force_route_${error.reason}`, which is the literal `force_route_account_capacity_exhausted`, and `packages/proxy/src/proxy.ts:235-255` turns it into an HTTP 503. None of that touches the Codex provider, so `CCFLARE_CODEX_TRACE_DIR` (`packages/providers/src/providers/codex/trace.ts:42`) recorded nothing. Organic verification was impossible for days.

The prior pattern in this repo was to verify a deployed provider-lane fix from health-endpoint identity plus natural traffic in the `requests` table, never from manufactured requests; one earlier fix stayed unverified for a whole session because no natural traffic for that model ever arrived (session history). This practice is the bounded alternative.

The practice: run the deployed binary and the previous kept production binary side by side against a local mock of the Codex upstream, force-route identical Claude Code-shaped requests to a scratch `codex` account pointed at the mock, and diff the exact production evidence: trace records, the JSON body and headers the mock actually received, and the `requests` row's `agent_attribution_source`. A separate read-only verifier re-derived every check from the raw artifacts on disk and confirmed. This turned an unrunnable smoke test into a same-day regression proof, entirely on non-Anthropic infrastructure.

## Guidance

**1. Get two binaries.** `scripts/deploy-ccflare.sh` keeps the last five production binaries (`KEEP_BINARIES=5` at line 66, prune block at lines 674-685) named `better-ccflare-v<version>-<short-sha>` (`BIN_NAME="better-ccflare-v${VERSION}-${SHORT}"`, line 323) under `~/.config/better-ccflare/`. Pick the deployed one and the immediately prior one that predates the fix commit.

**2. Build a mock Codex upstream.** A small Bun server listening on `127.0.0.1:18790`:

- `POST /backend-api/codex/responses` saves the full JSON request body and redacted headers to disk, keyed by `x-mock-label` and `x-mock-scenario` request headers the test client sets, then answers a minimal valid `text/event-stream` Responses payload (`response.created`, one message output item, `response.completed` with usage, `[DONE]`).
- `GET /backend-api/codex/models` answers a tolerant empty catalog so the provider's best-effort catalog refresh does not need the real network.
- Anything else gets a 200 `{ok:true}`.

Redact the authorization header (`k.toLowerCase() === "authorization" ? "[REDACTED]" : v`) before writing to disk; never persist a token even in a scratch dir.

**3. Boot each binary against a throwaway DB and config, twice.** One runner script (`run-label.sh <label> <binary>`), run once per binary, on the same fixed proxy port both times so only one process can hold the port. Start the second binary only after the first has logged shutdown.

```bash
export BETTER_CCFLARE_DB_PATH="$LABEL_DIR/dev.db"
export BETTER_CCFLARE_CONFIG_PATH="$LABEL_DIR/config.json"
export CCFLARE_CODEX_TRACE_DIR="$LABEL_DIR/traces"
export CCFLARE_CODEX_TRACE_FULL=0
export LOG_LEVEL=debug

# Pass 1: boot only, to create the schema. /health legitimately answers 503
# here (no accounts yet); any non-"000" curl code proves the listener and
# schema are up. Kill it before touching the DB directly.
"$BINARY" --serve --port 18081 &
BOOT_PID=$!
# poll: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/health  until != "000"
kill "$BOOT_PID"; wait "$BOOT_PID"

# Insert a scratch codex account pointed at the mock upstream. custom_endpoint
# accepts any http/https host: validateEndpointUrl only checks the protocol
# and a non-empty hostname (packages/core/src/validation.ts:376-405), and
# resolveCodexEndpoint calls it (packages/providers/src/providers/codex/provider.ts:370-386).
sqlite3 "$DB_PATH" <<SQL
INSERT INTO accounts (
  id, name, provider, api_key, refresh_token, access_token, expires_at,
  created_at, priority, paused, custom_endpoint, auto_refresh_enabled,
  model_mappings, billing_type
) VALUES (
  '$ACCOUNT_ID', 'mock-codex', 'codex', NULL, 'mock-refresh', 'mock-access', $EXPIRES_MS,
  $NOW_MS, 0, 0, 'http://127.0.0.1:18790/backend-api/codex/responses', 0,
  '{"fable":"gpt-5.1-codex-mock","opus":"gpt-5.1-codex-mock","sonnet":"gpt-5.1-codex-mock","haiku":"gpt-5.1-codex-mock"}', ''
);
SQL

# Pass 2: the real run. Poll /health again, then save it as health-boot.json:
# that file binds this run's evidence to a build SHA (health.git_sha,
# packages/http-api/src/handlers/health.ts:254).
"$BINARY" --serve --port 18081 &
SERVE_PID=$!
```

The `--serve` flag is parsed at `apps/cli/src/main.ts:691` and `--port <number>` at `apps/cli/src/main.ts:694-696` (help text at `apps/cli/src/main.ts:159-160`).

**4. Send Claude Code-shaped requests, force-routed to the scratch account, never to Anthropic.** Three scenarios from one client script (`send-scenario.mjs <label> <scenario> <proxyPort> <accountId> <resultsDir>`):

- **s1-main**: plain main-conversation headers, no subagent markers.
- **s2-subagent**: adds `x-claude-code-parent-agent-id: parent-root-session` and `x-claude-code-agent-id: child-agent-<sessionId>`, real header evidence for `isClaudeCodeSubagent` (`packages/proxy/src/claude-code-request.ts:78-100`, which checks `CLAUDE_CODE_PARENT_AGENT_HEADER` and `CLAUDE_CODE_AGENT_HEADER` from lines 7-8, or the `cc_is_subagent` billing-header field).
- **s3-second-main**: a second, independent main conversation (fresh session id, no subagent markers), the case that most directly exercises the old bug, since a second main session is exactly what a broken session fallback misclassifies.

All three declare the same four tools (`Agent`, `Task`, `Bash`, `Read`) so `tools_before_count` is always 4 and any filtering is visible in `tools_after_count` and `filtered_tool_names`. Every request carries `x-better-ccflare-account-id: <scratch account id>`. That header is what keeps the harness inside the repo's testing restriction: force-routing fails closed to the named account, so there is no path to a real provider.

```js
const headers = {
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.280 (external, cli)",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
  "x-claude-code-session-id": sessionId,
  "x-better-ccflare-account-id": accountId,
  "x-mock-label": label,
  "x-mock-scenario": scenario,
  // s2-subagent only:
  "x-claude-code-parent-agent-id": "parent-root-session",
  "x-claude-code-agent-id": `child-agent-${sessionId}`,
};
const body = {
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  stream: true,
  system: "You are a coding assistant CLI. Ordinary session, not a registered subagent prompt.",
  messages: [{ role: "user", content: "reply ok" }],
  tools: [/* Agent, Task, Bash, Read declarations */],
  metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
};
```

**5. Collect evidence per run at three independent layers.**

- **Production trace record** (`$CCFLARE_CODEX_TRACE_DIR/codex-trace-<date>.jsonl`): read `orchestration_admission`, `filtered_tool_names`, `is_descendant`, `tools_before_count`, `tools_after_count`, and `request_id`, all written by `writeCodexTrace` (`packages/providers/src/providers/codex/trace.ts:484`), called from `CodexProvider.transformRequestBody` (`packages/providers/src/providers/codex/provider.ts:2917`), a request-preparation method that only runs once an account has been selected. That placement is why a capacity fail-closed request leaves no trace record.
- **Upstream capture**: the mock's saved `<label>-<scenario>.json` (check the `tools` array for `Agent` and `Task`) and `.headers.json` (wire shape: `originator: codex_cli_rs`, `openai-beta: responses=experimental`, `authorization: [REDACTED]`, and no `x-better-ccflare-*` header, which proves the proxy processed and rewrote the request rather than passing it through).
- **Scratch DB `requests` row**: `SELECT agent_attribution_source FROM requests WHERE id = '<trace request_id>'`. Query by the trace record's `request_id`, which is the `requests.id` primary key. The first version of the collector queried by `agent_used = sessionId` and always read back null; that was a harness bug, not a finding.

**6. Build the A/B table.** Pair each scenario's old-build and new-build evidence on `orchestration_admission`, `tools_before_count` to `tools_after_count`, `filtered_tool_names`, whether `Agent` and `Task` reached the upstream body, and `agent_attribution_source`. A regression proof requires the old binary to reproduce the bug under the identical harness, not just the new binary to look correct in isolation. Keep the runner and client as script files on disk: on the day this ran, the agent driving the harness was killed mid-run by the gateway's own `route_unavailable` 503s when the shared Anthropic pool ran thin, and the second pass finished from the scripts and artifacts already written.

## Why This Matters

A capacity-exhausted force-route is fail-closed by design (`ForceRouteUnavailableError` is thrown in `packages/proxy/src/handlers/account-selector.ts` before any provider code runs), and correctly so. But it means the one observability channel that would normally prove a Codex-lane fix, the Codex trace, goes silent exactly when it is needed, for as long as the pool stays saturated, which on a shared production pool can be days. Waiting out the exhaustion is not a verification strategy with a bounded timeline. Standing up the exact runtime, same binary, same schema, same env contract, same request path down to the provider's `transformRequestBody`, against a mock upstream is the only way to get the production evidence format (trace JSONL schema, `requests` columns, health JSON) from a binary that currently has zero real capacity. Comparing against the prior build that the deploy script's retention already keeps on disk turns "does the new binary look right" into "did the new binary fix what the old binary got wrong" under one harness, one mock, one set of inputs, which is what makes it a regression proof rather than a smoke test.

The scenario set must preserve the distinction the fix encodes. `isClaudeCodeSubagent` (header evidence) is legitimate containment evidence and must keep working; treating a bare `session_header` fallback as agent evidence was the bug. A harness that only sent subagent-shaped requests could not tell these apart. It needs at least one scenario with zero subagent markers (s1, and a second independent one, s3) to prove the old build over-contained ordinary main conversations, and one with real subagent headers (s2) to prove the fix did not regress genuine containment.

## When to Apply

- A Codex-lane, or any force-routed provider-specific, fix needs same-day verification and the account pool it depends on has no live capacity: usage-window exhaustion, every account paused or rate-limited, or an empty scratch pool.
- The provider has a `custom_endpoint`-style override that `validateEndpointUrl` accepts for any http or https host, an env-gated trace or observability sink, and a force-route header for exact-account selection; the recipe generalizes to any provider with those three.
- Not when the thing under test is the live provider's own behavior (rate limits, real model output, real auth). The mock only proves what better-ccflare does with a request before it leaves the process and what it does with the response after.
- Before concluding "no traffic" from an empty trace file, rule out "no capacity" first: check `/health` `pool.usage_exhausted` and `pool.routable`, or the `usage_windows` table (`peak_utilization`, `resets_at`) for the accounts in question. An empty trace window is consistent with both, and only one of them means the fix is unverified rather than unexercised.

## Examples

Six runs on 2026-09-25, fixed port 18081, mock upstream on 127.0.0.1:18790, three scenarios by two builds. Build `b4fd66d4` is the previous production build (predates #381); build `b8276363` is the deployed build (#381 merged).

| scenario | build | orchestration_admission | tools before to after | filtered_tool_names | upstream got Agent+Task | agent_attribution_source |
|---|---|---|---|---|---|---|
| s1-main (no subagent headers) | b4fd66d4 (old) | attributed_descendant | 4 to 2 | Agent, Task | no (Bash, Read only) | session_header |
| s1-main (no subagent headers) | b8276363 (new) | root | 4 to 4 | (none) | yes | session_header |
| s2-subagent (real parent and agent headers) | b4fd66d4 (old) | attributed_descendant | 4 to 2 | Agent, Task | no (Bash, Read only) | session_header |
| s2-subagent (real parent and agent headers) | b8276363 (new) | attributed_descendant | 4 to 2 | Agent, Task | no (Bash, Read only) | session_header |
| s3-second-main (independent second conversation) | b4fd66d4 (old) | attributed_descendant | 4 to 2 | Agent, Task | no (Bash, Read only) | session_header |
| s3-second-main (independent second conversation) | b8276363 (new) | root | 4 to 4 | (none) | yes | session_header |

All six `requests` rows carry `agent_attribution_source = session_header` regardless of build: the fallback classification itself is unchanged, and what changed is whether `session_header` is treated as agent evidence downstream (old: yes for every scenario; new: no, except where real header evidence independently marks s2 as a descendant). Upstream header captures confirm the proxy processed every request rather than passing it through: `originator: codex_cli_rs`, `openai-beta: responses=experimental`, `authorization: [REDACTED]`, and no `x-better-ccflare-*` header on the wire.

## Related

- `docs/solutions/integration-issues/codex-lane-session-attribution-fallback-mistaken-for-agent-evidence.md`: the bug this practice verified on the deployed binary.
- `docs/solutions/workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md`: the same rule of binding a claim to the runtime's `git_sha`, applied to measured rates.
- `docs/solutions/workflow-issues/never-poll-an-unknown-path-against-a-local-ccflare.md`: keeping scripted verification traffic off real accounts when a local ccflare is involved.
- `docs/solutions/validate-against-live-payloads.md`: verification is only as good as the fidelity of what you feed in and read back.
- `docs/solutions/observability/codex-trace-input-tokens-are-cache-inclusive.md`: trace-field semantics to respect when reading the same JSONL.
- Issue #380 (measurement week tracker) and PR #381 (the fix).
