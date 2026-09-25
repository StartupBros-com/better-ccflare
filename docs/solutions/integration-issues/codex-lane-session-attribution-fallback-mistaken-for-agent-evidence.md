---
title: Codex-lane containment treated the session-id attribution fallback as real agent evidence
date: 2026-09-25
category: integration-issues
module: codex-agent-attribution
problem_type: logic_error
component: proxy
severity: high
symptoms:
  - "0 of 70,911 Codex-routed responses in the September 13 to 24 trace called the Agent tool, while the Anthropic lane issued 1,691 Agent calls in 133,269 turns over the same 21 days"
  - "Every Claude Code main conversation routed to a Codex account was classified as an attributed descendant and had its Agent and Task tool declarations stripped before orchestration election, with no log line marking the strip"
  - "requestMeta.agentUsed was set by the session-id attribution fallback (agentAttributionSource = session_header) for the runaway-loop alert, and the Codex-lane containment decision separately read the same flag as Boolean(agentUsed), so a session id alone counted as agent evidence"
root_cause: logic_error
resolution_type: code_fix
tags:
  - codex
  - agent-attribution
  - attributed-descendant
  - orchestration-election
  - session-id-fallback
  - overloaded-flag
  - proxy
  - containment
related_components:
  - providers
---

# Codex-lane containment treated the session-id attribution fallback as real agent evidence

## Problem

Claude Code main conversations routed by better-ccflare to a Codex (ChatGPT Pro) account never called the Agent tool. The 21-day `requests` sample cited in the same-evening ideation pass (`docs/ideation/2026-09-24-codex-routed-claude-code-parity-ideation.html`) showed 1,691 Agent calls across 133,269 Anthropic-routed turns versus 0 across 10,441 Codex-routed turns, in every one of the 51 Codex sessions sampled. The operator's framing was "subagents do not launch under Codex routing."

Root cause: since commit `490a5bc55` (2026-07-31, "fix(alerts): restore project as runaway-loop key component and add x-claude-code-session-id header fallback"), the agent interceptor's `sessionFallback()` closure in `packages/proxy/src/handlers/agent-interceptor.ts:173-189` sets `agentUsed` to the Claude Code session-id header value with `agentAttributionSource: "session_header"` on every Claude Code request that matches no registered agent by prompt or header, which is every ordinary main conversation. That field was introduced for a different consumer: the runaway-loop anomaly detector keys its alert id on `agentUsed` so distinct workers sharing one account, model, and project do not collapse into one bucket (`packages/http-api/src/services/alerts.ts:300-306`, `buildRunawayLoopAlertId`). The Codex-lane containment decision in `packages/proxy/src/handlers/proxy-operations.ts` read that same field as agent evidence. Before the fix (per the PR #381 commit message; the pre-fix line no longer exists in the tree) the check was `Boolean(requestMeta.agentUsed) || isClaudeCodeSubagent(req.headers)`. A session id is always truthy, so every main conversation on the Codex lane evaluated `isAttributedAgent = true`, set `x-better-ccflare-attributed-agent: true` (`proxy-operations.ts:3566`), and the Codex provider stripped `Agent` and `Task` from the tool list before the request ever reached the orchestration election (`packages/providers/src/providers/codex/provider.ts`, `convertToCodexFormat`, gated on `isAttributedAgent` read from that header at `provider.ts:2776-2777`). One flag served two consumers with incompatible meanings: for alert keying, "which session is this" (any truthy value is fine); for containment, "is this a subagent" (only a real agent match is fine).

## Symptoms

- 0 of 70,911 Codex-routed responses in the September 13 to 24 production trace contained an Agent-tool call; the Anthropic lane over the same 21 days issued 1,691 Agent calls in 133,269 turns.
- Every one of 51 sampled Codex sessions showed the same pattern: `Agent` and `Task` present in the client's tool list, absent from what the Codex upstream request actually carried (`filtered_tool_names: ["Agent"]` on every stripped turn).
- Workflow-tool calls kept firing on the Codex lane (1,043 in the same trace window) while Agent calls stayed at zero, so the signal pointed at something Agent-tool-specific, not a blanket model incapability.

## What Didn't Work

The first hypothesis, written up in the ideation pass before the trace was pulled, blamed the Codex provider's single-orchestration-root election: `orchestration-election.ts`'s `admit()` keeps root for a request whose conversation id the elected root already recognizes, or, for a new conversation id, only when its `instructionHash` matches the root's and its lineage overlaps, and it performs no mutation on rejection; a rejected turn is demoted to `non_root` and logged without being surfaced (`provider.ts:4419-4429`, the `orchestration demotion observed` warn line), and the demoted turn has its orchestration tool declarations filtered out. The proposed fix was a "de-ratchet": relax the exact-match requirement so a turn that drifts from the elected root's instruction hash could be re-admitted.

Pulling the actual Codex trace refuted this before any de-ratchet code was written. Production trace records for September 13 to 24 showed the election never demoted a root: 0 `non_root`, 15 `root`. Instead, 34,692 Agent-offering Codex requests were classified `attributed_descendant`, a value the election path itself never produces (`trace.ts:340`: `no_orchestration_tools`, `attributed_descendant`, `disabled`, `no_session`, `no_conversation` are all no-election states). `attributed_descendant` on every one of those requests, paired with an observed `filtered_tool_names` of `["Agent"]`, meant something upstream of the election was marking them as descendants before `admit()` ever ran. That pointed at the containment check in `proxy-operations.ts`, not the election logic, and the election-ratchet fix was dropped without being implemented.

## Solution

Before (per PR #381's own commit message, since the pre-fix line no longer exists in this tree): the Codex-lane containment decision in `prepareAttemptHeaders` read

```ts
const isAttributedAgent =
  Boolean(requestMeta.agentUsed) || isClaudeCodeSubagent(req.headers);
```

After, at `packages/proxy/src/handlers/proxy-operations.ts:3549-3552`:

```ts
const isAttributedAgent =
  attributionSourceIdentifiesAgent(
    requestMeta.agentAttributionSource,
  ) || isClaudeCodeSubagent(req.headers);
```

`attributionSourceIdentifiesAgent` is a new exported predicate in `packages/proxy/src/claude-code-request.ts:60-75`, switching over the `AgentAttributionSource` union:

```ts
export function attributionSourceIdentifiesAgent(
  source: AgentAttributionSource | null | undefined,
): boolean {
  switch (source) {
    case "prompt_agent":
    case "header_agent":
      return true;
    case "session_header":
    case "none":
    case undefined:
    case null:
      return false;
    default:
      return assertNeverAttributionSource(source);
  }
}
```

`assertNeverAttributionSource` (`claude-code-request.ts:42-49`) takes a `never`-typed parameter, so adding a new member to `AgentAttributionSource` without classifying it here is a compile error at that `default` arm, not a silent runtime fallthrough. `isClaudeCodeSubagent(headers)` (`claude-code-request.ts:78-100`) is unchanged: it looks for a non-blank `x-claude-code-parent-agent-id` or `x-claude-code-agent-id`, or a case-insensitive `cc_is_subagent=true` field inside the `;`-delimited `x-anthropic-billing-header` metadata string.

Nothing else moved. The interceptor's `sessionFallback()` still sets `agentUsed` to the session id with source `session_header` (`agent-interceptor.ts:173-189`); that data still persists to `requests.agent_attribution_source` and is still exactly what the runaway-loop alert keys on (`alerts.ts:300-306`). The Codex provider's strip logic and its unconditional header delete (`newHeaders.delete("x-better-ccflare-attributed-agent")` at `provider.ts:3024`, so the internal marker never reaches the upstream wire either way) are untouched; only the boolean feeding `isAttributedAgent` changed.

## Why This Works

The bug was never in the election, the interceptor, or the provider. `agentUsed` was an overloaded signal with two readers expecting different semantics from the same value. The alert-keying consumer (`buildRunawayLoopAlertId`) only needs some stable per-conversation identity, so "session id present" is a good signal there. The containment consumer needs to know "is this specific request a spawned subagent that should lose orchestration tools," and a session id answers a different question ("which conversation is this") that is true for every Claude Code request with a session header, which is all of them.

The fix stops asking the overloaded field the wrong question. `attributionSourceIdentifiesAgent` reads `agentAttributionSource`, a field the interceptor already sets to a distinguishing value at the point of detection: `"prompt_agent"` and `"header_agent"` only when `agentRegistry.findAgentByPrompt` or the explicit agent header actually matched a registered agent, `"session_header"` for the id-only fallback, `"none"` when neither fired (the four `agentAttributionSource` values the interceptor's `AgentInterceptResult` return sites set in `agent-interceptor.ts`). The predicate is a pure classification over that enum and touches nothing else: the alert consumer never reads `agentAttributionSource`, so its behavior is unchanged by construction rather than by inspection. That is also why the fix is a one-line call-site swap plus a small predicate rather than a schema change, a new field, or a migration: the distinguishing information already existed on `requestMeta`, it just was not being read at the decision that needed it.

## Prevention

**Diagnosis order for "Codex behaves differently than Anthropic" complaints.** Read the Codex trace before touching the election or blaming the model. With `CCFLARE_CODEX_TRACE_DIR` set (env constant `CODEX_TRACE_DIR_ENV`, `packages/providers/src/providers/codex/trace.ts:42`; on in production through a systemd drop-in), inspect `orchestration_admission` and `filtered_tool_names` per request (`trace.ts:558-566`) before hypothesizing about the election, the model, or a client bug. `attributed_descendant` and `non_root` are distinct states, no-election versus rejected-election (`trace.ts:340`); conflating them is exactly the mistake the election-ratchet hypothesis made. Two gotchas that otherwise waste a diagnosis pass:

- A request that fails closed on account capacity before a Codex account is dispatched never reaches the provider's trace write path (`writeCodexTrace` is called from inside `provider.ts`, only once a Codex account has been selected), so an empty trace window can mean "no capacity", not "no traffic". Check the pool's usage-window state for the window before concluding traffic did not route to Codex.
- The demotion warn line (`orchestration demotion observed: request=${requestId ?? "unknown"} ...`, `provider.ts:4429`) is warn-level, so it reaches the log file at the logger's default level (`packages/logger/src/index.ts:73`); per this session's notes, production runs with routing and affinity debug lines silenced, so this line may be the only routing signal in the log (auto memory [claude]). `request=unrelated-sibling` is a literal test fixture id (`provider.test.ts:8714`), so if that string shows up in `$TMPDIR/better-ccflare-logs/app.log` it is unit-test output sharing the log file, not production traffic.

**Trace-to-attribution join.** The trace request record does not carry the attribution source itself; join on `request_id`. The trace's `request_id` field (`trace.ts:511`) is the same id persisted as `requests.id`, and `agent_attribution_source` lives on that row (`packages/database/src/migrations.ts:451`, `:2429`). `requests.client_session_id` stores the client's `metadata.user_id` verbatim after control-character sanitization (`packages/proxy/src/request-body-context.ts:87-95`, `packages/database/src/repositories/request.repository.ts:32-42`); for Claude Code that value is a JSON string with `device_id`, `account_uuid`, and `session_id`, and `session_id` is the Claude Code transcript filename, which gives exact per-session provider labeling. Concrete recipe once a trace JSONL line is in hand:

```bash
req_id=$(jq -r '.request_id' one-trace-line.json)
sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db \
  "SELECT id, agent_attribution_source, agent_used,
          json_extract(client_session_id, '$.session_id') AS claude_session
   FROM requests WHERE id = '$req_id';"
```

**Test discriminators for this bug class.** Two things make this regression easy to reintroduce and hard to catch generically:

- The Codex provider deletes `x-better-ccflare-attributed-agent` unconditionally before the upstream request goes out (`provider.ts:3024`), so a containment test must never assert on that header reaching the wire; assert on the upstream tool list instead. `packages/proxy/src/handlers/__tests__/proxy-operations-count-tokens.test.ts` names this pattern: the AE1 case (`:400`, "does not treat the interceptor's session-id fallback as agent evidence") sends `agentAttributionSource: "session_header"` with no Claude Code subagent headers and asserts `Agent` and `Read` both survive in the upstream `tools` array; the AE2 cases (`:686-722`) assert the inverse, that a `header_agent` source, or any of the three `isClaudeCodeSubagent` marker shapes paired with `session_header`, still strips to `[]`. These two tests guard different halves of the bug class, and neither substitutes for the other. Widening the predicate itself — for example editing `attributionSourceIdentifiesAgent`'s switch (`claude-code-request.ts:60-75`) so the `session_header`, `none`, `undefined`, or `null` arms also return `true` — flips exactly those four `attributionSourceIdentifiesAgent` unit rows (`packages/proxy/src/__tests__/claude-code-request.test.ts:40-49`) from `false` to `true`, because that suite calls the predicate directly with literal `AgentAttributionSource` values and never imports from `proxy-operations.ts`. Reverting the call site instead — restoring `Boolean(requestMeta.agentUsed) || isClaudeCodeSubagent(req.headers)` at `proxy-operations.ts:3549-3552` without touching the predicate — leaves every one of those unit rows green, since the predicate they exercise never changes; only the AE1 case (`packages/proxy/src/handlers/__tests__/proxy-operations-count-tokens.test.ts:400`, which drives `proxyWithAccount` through the real call site) observes that regression. The unit rows guard the predicate's own truth table, not the call site that reads it — they do not detect a call-site revert, and AE1 is the only test here that does.
- Persistence of the attribution fields is proven separately in `packages/proxy/src/handlers/__tests__/agent-interceptor.header.test.ts` (`"x-claude-code-session-id fallback"` describe block, `:299-424`), because the count-tokens suite replaces the usage collector with no-op mocks and never reaches `saveRequest`.

**Accepted tradeoff.** A subagent that carries none of Claude Code's own markers and whose system prompt does not match a registered agent is no longer force-contained on the Codex lane by this decision alone. The election (`orchestration-election.ts`'s identity-or-lineage admission, which a new conversation id passes only with a matching `instructionHash` and overlapping lineage), the fan-out demotion warn line, and the runaway-loop alert remain the operative bounds on that case. This fix narrows one false-positive source; it does not add a new containment mechanism.

## Related Issues

- Issue #380 (work spec; stays open for the post-deploy measurement week) and PR #381 (the fix). PR #379 is the ideation pass whose election-ratchet hypothesis this doc corrects.
- `docs/solutions/integration-issues/codex-cache-affinity-needs-session-id-header.md`: the same session-id header on the same lane, used as a cache-routing hint. Different mechanism; do not conflate "session-id header for cache affinity" with "session-id attribution fallback for alert keying".
- `docs/solutions/architecture-patterns/commit-bound-routing.md`: the sibling invariant that a weaker routing signal must not launder into a stronger guarantee, on the account-selection side of the same handler.
- `docs/solutions/observability/codex-trace-input-tokens-are-cache-inclusive.md`: the other trace-versus-`requests` join pitfall on this lane.
- `CONCEPTS.md`, "Attributed descendant": the invariant this fix restores.
