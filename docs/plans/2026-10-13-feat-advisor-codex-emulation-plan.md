---
title: Advisor Emulation on Codex Routes - Plan
type: feat
date: 2026-10-13
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Advisor Emulation on Codex Routes - Plan

## Goal Capsule

- **Objective:** A Claude Code session with `/advisor` on, pinned through an opted-in Codex route profile (worker `gpt-6.1-sol` or `gpt-6-astra`), gets advisor answers from a Codex model (`gpt-6-astra` for a Fable advisor, `gpt-6.1-sol` for an Opus advisor) instead of a 400 on every turn.
- **Means:** the proxy rewrites the typed advisor declaration into a plain `advisor` function tool for the Codex worker. When the worker calls it alone, the proxy holds the stream, runs a same-account advisor sub-call, emits the native `server_tool_use` / `advisor_tool_result` pair to the client, and splices a continuation worker call into the same response (KTD1-KTD6).
- **Authority:** Product Contract R-IDs win on behavior; KTDs win on mechanism; units override neither. `AGENTS.md` outranks the plan: no scripted traffic to Anthropic-backed accounts, every SQLite migration ported to PostgreSQL (none planned), no version bumps, never touch the `inline-*worker*.ts` files.
- **Stop conditions:** stop and report instead of improvising when any of these holds:
  - a test shows an emulated advisor declaration or emulated history reaching a first-party Anthropic upstream unstripped;
  - the splice cannot keep exactly one `message_start` and one terminal `message_delta` per client response;
  - admitting Codex for an advisor request changes routing for any request that is not on an opted-in profile (the #285 routing-integrity contract).
- **Execution profile:** test-first, one fresh subagent per unit (`AGENTS.md` Plan Execution). Worktree `.claude/worktrees/advisor-codex-emulation`, branch `advisor-codex-emulation`, tracked by StartupBros-com/better-ccflare#487.
- **Finish and ship:** PR against `StartupBros-com/better-ccflare` with "Refs #487", review ladder, CI. Deploy and the profile opt-in edit to `/etc/better-ccflare/model-route-profiles.env` happen only on operator instruction. The live check is the operator using `/advisor` in an interactive Claude Code session (no scripted traffic, AGENTS.md).

---

## Product Contract

### Summary

Today every request that carries Claude Code's `advisor_20260301` declaration is refused on any non-first-party account (`server_tool_advisor_declaration_unavailable`, #425/#439). Claude Code drops advisor for the conversation and retries, so Codex-pinned sessions never get advice. Over 14 days production logged 1,156 such 400s on `pro-primary-sol`, 895 on `codex-pool-astra`, and 34 on `grok-primary`. In the last 24h, 161 of 713 were followed by another 400.

This plan adds an opt-in emulation for Codex OAuth accounts reached through a route profile that sets `advisorEmulation: true`. Every other route keeps today's refusal byte-for-byte.

### Key Decisions

- **Opt-in per route profile, Codex OAuth only.** (session-settled: user asked for "advisor mode actually works with codex models"; scope cut to profiles keeps the #285 stock-route contract intact) Governs R1, R2, R9.
- **The model map is fixed: Fable → `gpt-6-astra`, Opus → `gpt-6.1-sol`.** (session-settled: user named astra as the fable-level advisor and 6.1-sol as opus-level) Any other advisor model keeps today's refusal. Governs R3.
- **The advisor runs on the worker's own account.** No reselection, no affinity write. A missing model surfaces as `advisor_tool_result_error{unavailable}`. Governs R5.
- **The splice is done in the proxy, not through `pause_turn`.** Verified 2026-10-13 in the Claude Code 2.1.296 binary: `pause_turn` appears only in stop-reason lists, schemas, a diagnostics enum, and the bundled SDK tool runner (`Pd`, `pause_turn`→`resume`). The interactive main loop has no `pause_turn` branch, so a `pause_turn` response would end the user's turn after the advice. Governs R4.

### Requirements

- **R1.** A request is emulation-eligible only when all hold: the request's route profile has `advisorEmulation: true`; the kill switch `BCCF_ADVISOR_EMULATION` is not `off` (read per request); the native requirement's declared types are exactly `[advisor_20260301]` with no unknown types and no hosted server-tool requirement; `stream === true`; `tool_choice` is absent, `auto`, or `none`; the body is not a sole-`StructuredOutput` request; no client tool is already named `advisor`; the declaration's `model` maps under R3.
- **R2.** An eligible request admits Codex OAuth accounts (`provider === "codex"`, no `api_key`, no `custom_endpoint`, an access token present) wherever the native-advisor constraint removes or refuses non-first-party accounts today: selection, forced pins, combo resolution, the final refusal, and the dispatch backstop. First-party Anthropic accounts stay admitted. No other provider is admitted.
- **R3.** The advisor model is resolved from the declaration's `model`, case-insensitively: contains `fable` → `gpt-6-astra`; contains `opus` → `gpt-6.1-sol`; anything else is not eligible.
- **R4.** On an admitted Codex attempt the client receives one Anthropic message:
  - the worker's own blocks;
  - for each advisor round, `server_tool_use{id:"srvtoolu_bccf_…",name:"advisor",input:{}}` (one `input_json_delta` of `{}`), then `advisor_tool_result{tool_use_id, content}` with no deltas;
  - the continuation's blocks, re-indexed contiguously;
  - exactly one `message_start` and one terminal `message_delta` + `message_stop`.
- **R5.** The advisor sub-call goes to the same account with the resolved model, no tools, a stable `prompt_cache_key` of its own, and `hosted:true` transform and process options (no turn-state, no response-id owner). Its result text becomes `content:{type:"advisor_result",text}`. Its failures map to `advisor_tool_result_error{error_code}`: 429 → `too_many_requests`; 529/503/overloaded → `overloaded`; the timeout (default 180 s) → `execution_time_exceeded`; a context-length error → `prompt_too_long`; any other failure → `unavailable`.
- **R6.** Interception decides at the worker's terminal `message_delta`, never at the first `tool_use` start (Codex may emit further `function_call` items after the advisor call, and `parallel_tool_calls` is not forced):
  - text and thinking blocks before the first `tool_use` stream immediately;
  - from the first `tool_use` `content_block_start` on, blocks are buffered (pings pass through);
  - no `advisor` call: flush unchanged;
  - `advisor` with sibling calls: drop the advisor block, re-index, flush, no sub-call;
  - `advisor` as the only call with `stop_reason: tool_use`: run the round.
- **R7.** Rounds are bounded. At most 2 advisor sub-calls and 4 worker calls per client request. A sole advisor call past the sub-call cap gets `advisor_tool_result_error{max_uses_exceeded}` and one more continuation. A sole advisor call at the worker-call cap gets the same error and the message ends with `end_turn`. No path returns an HTTP 400 after the 200 has been sent.
- **R8.** During a held round the client gets `ping` events at a fixed interval (default 15 s). A client abort cancels the in-flight sub-call or continuation and starts no further upstream call. A continuation failure is reported as an Anthropic `error` SSE event after closing any open block, the same shape the Codex translator emits for `response.failed`.
- **R9.** History. A block is emulated when its id or `tool_use_id` starts with `srvtoolu_bccf_`.
  - First-party Anthropic account: emulated pairs are stripped (any result shape) with the existing placeholder and thinking rules. Native pairs keep today's foreign-result logic.
  - Admitted Codex attempt: each emulated pair is projected to assistant `tool_use{id,name:"advisor",input:{}}`, then a user `tool_result{tool_use_id,content:advisorToolResultText(content)}`, then the assistant remainder. Native pairs are stripped to the placeholder.
  - Every other route keeps today's history refusal, so Claude Code strips and retries.
  - A body with neither emulated nor native advisor blocks is forwarded byte-identical.
- **R10.** The continuation request equals the R9 Codex projection of the original messages plus the in-flight assistant message, so the next client turn reproduces the continuation's prefix byte-for-byte.
- **R11.** Accounting. The terminal `message_delta.usage` carries the summed worker usage plus `iterations`: `[{type:"message",model,…w1}, {type:"advisor_message",model:<advisor>,…adv}, {type:"message",…w2}, …]`. `advisor_usage` is priced through the models.dev catalogue (`gpt-6-astra` $10/$50, `gpt-6.1-sol` $2/$10 per MTok, cache read present 2026-10-13).
- **R12.** `docs/routing-architecture.md` states the emulation as the one exception to "never translated", scoped to opted-in Codex profiles.

### Acceptance Examples

- **AE1 (R4, R5, R10).** Opted-in profile; the worker emits text then a sole `advisor` call. Three upstream fetches:
  - the worker call, whose tools include function `advisor`;
  - the sub-call, with model `gpt-6-astra` and no tools;
  - the continuation, whose input ends with `function_call` + `function_call_output` for the same `srvtoolu_bccf_` id.

  The client sees the text, the pair, then the continuation text. There is one `message_start`, and the final stop reason is the continuation's.
- **AE2 (R6).** The worker calls `advisor` and `Read` together. One upstream fetch. The client sees only `Read` with contiguous indices and `stop_reason: tool_use`.
- **AE3 (R5).** The sub-call returns 429. The client sees `advisor_tool_result_error{too_many_requests}`, and the continuation runs with the matching tool_result text.
- **AE4 (R1).** `BCCF_ADVISOR_EMULATION=off`: today's 400 declaration refusal, zero upstream fetches.
- **AE5 (R1, R2).** A profile without `advisorEmulation`, or an Auto request: today's refusal unchanged.
- **AE6 (R9, R10).** The next turn replays the emulated pair on Codex. The upstream input prefix equals AE1's continuation input.
- **AE7 (R9).** The same history routed to a first-party account: emulated pair stripped to `[Advisor response]`; a native redacted pair from the same account untouched.
- **AE8 (R8).** Client abort during the sub-call: the sub-call fetch is aborted and no continuation fetch is made.
- **AE9 (R7).** Rounds exhausted: `max_uses_exceeded` error block, bounded worker calls, clean `message_stop`.
- **AE10 (R1).** `tool_choice:{type:"any"}` with the declaration: today's refusal.

### Scope Boundaries

- Not emulated: non-streaming requests, forced `tool_choice`, sole `StructuredOutput`, advisor models other than Fable/Opus, Auto routes, GLM/xAI/openai-compatible routes.
- Not claimed: advisor quality parity with Anthropic's server-side advisor, live verification (operator-only), `count_tokens` accuracy for the rewritten tool (advisory today).
- Sub-call and continuation responses do not update account rate-limit metadata in v1. A 429 there becomes an advisor error or a mid-stream `error` event, and the account's next normal request observes the limit.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Admission rides the existing native-advisor seam.** `RequestMeta.advisorEmulation` (`{advisorModel, declarationModel}` or absent) is computed once in `proxy.ts` right after `nativeAnthropicToolRequirement` is set (~1741-1745). The selector gets `isNativeConstraintSatisfiedBy(meta, account) = isFirstPartyAnthropicAccount(account) || isAdvisorEmulationAdmitted(meta, account)`. It is used at `isServableNativeRemoval` (~2267), `applyNativeConstraint` (~2309), the forced-pin check (~3314), and combo resolution (~3966, ~4018). `getExcludedProviders` gains a second token so the admitted case does not exclude `codex`, and the dispatch backstop (`proxy-operations.ts` ~2677-2695) admits the same predicate. Auto admission is untouched.
- **KTD2. `isCodexOAuthAccount(account)` lives in `packages/core/src/model-mappings.ts`** beside `isFirstPartyAnthropicAccount`, exported from `core/src/index.ts`, mirroring `isCodexOAuthSubscription` in `providers/src/providers/codex/server-tools.ts:190-204`.
- **KTD3. The tool rewrite is Anthropic-level, before the provider transform.** On an admitted Codex attempt, after the existing advisor strip block (`proxy-operations.ts` ~3223-3245) and before `materializeAttemptPlan`, the typed declaration becomes `{name:"advisor",description,input_schema:{type:"object",properties:{},additionalProperties:false}}` with `defer_loading` dropped. The R9 projection runs in the same place, and the body is rebuilt with `RequestBodyContext.fromParsed`. `convertToCodexFormat` then sees an ordinary custom tool, so the provider needs no change.
- **KTD4. The interceptor is a pure stream transform.** `createAdvisorEmulationStream(clientSse, deps)` lives in a new `packages/proxy/src/advisor-emulation/` module and parses and re-serializes Anthropic SSE. The `deps` it takes are `runAdvisor(inflightBlocks) → Promise<AdvisorOutcome>`, `runContinuation(inflightAssistantContent) → Promise<Response>`, `pingIntervalMs`, `timeoutMs`, the caps, and `signal`. It wraps the committed client response after the pre-commit gate loop and before `processProxyResponse` / `forwardOptions`, so the usage collector tees the spliced bytes. Drain-transport handling follows `wrapAnthropicPrecommitGatedResponse` (`proxy-operations.ts` ~281-292).
- **KTD5. Internal dispatch reuses the provider, not the attempt loop.** A closure built inside `proxyWithAccount` sends an Anthropic body through `provider.prepareHeaders` → `transformRequestBody(…, {hosted:true})` → `fetch` → `processResponse(…, {hosted:true})` on the same account and access token. Precedent for the re-dispatch shape is the advisor backstop retry (`proxy-operations.ts` ~5336-5403). It runs no attempt-loop retry, no failover, no affinity write, no turn-state, and no `stampCodexAttempt`. Each internal call carries a derived request id (`<requestId>:adv<n>` / `<requestId>:cont<n>`), so the provider's per-request-id maps never collide with the client request. The model is pinned with `body.model` plus `x-better-ccflare-final-model`; `passthrough.model` alone loses to explicit account mappings (`provider.ts` ~4593-4599). The sub-call sends `stream:false`, so `processResponse` folds it to JSON; the continuation sends `stream:true`.
- **KTD6. The sub-call cache key** is `__better_ccflare_codex_passthrough.prompt_cache_key` = a stable derivation of the session (`bccf-adv-` + a hash of the worker's derived key or session id). `applyCodexAffinityHeaders` is pure (it mutates only the passed headers), so a different model on the same account cannot disturb the worker's affinity state.
- **KTD7. Sub-call input.**
  - `system` is `ADVISOR_EMULATION_PROMPT_V1`, followed by the worker's system prompt under a heading.
  - One user message carries the flattened transcript: role-labelled text; tool calls as `[tool_use name {json}]` and tool results as `[tool_result …]`, each truncated per block; images as `[image]`; thinking omitted. A final instruction asks for the review.
  - The flattening is deterministic and append-only, so rounds and turns share a cacheable prefix.
  - A middle-truncation guard keeps the transcript under a char cap with a visible marker.
- **KTD8. Ids.** The emulated id is `srvtoolu_bccf_` + the Codex `call_id` sanitized to `[\w-]`. The same id is used in the client block, the continuation `tool_use` / `function_call`, and every later replay (critique P1-1).

### High-Level Technical Design

```
client ──► proxy.ts: profile attach → requirement → advisorEmulation meta (U1)
            │
            ▼
        selector admits Codex OAuth when meta.advisorEmulation (U5)
            │
            ▼
  proxyWithAccount (Codex):  rewrite declaration + project history (U2, U4a, U6 hook a)
            │                worker call ──► Codex
            ▼
  committed 200 SSE ──► createAdvisorEmulationStream (U4b, U6 hook b)
            │   buffer from first tool_use … decide at message_delta
            │   sole advisor → runAdvisor (sub-call, U3) ──► Codex (astra/sol)
            │                → emit server_tool_use + advisor_tool_result
            │                → runContinuation (U2 projection) ──► Codex
            │                → splice, re-index, merge usage + iterations (U7)
            ▼
  usage collector tee ──► client
```

### Assumptions

- Claude Code replays the advisor `server_tool_use` / `advisor_tool_result` blocks unchanged in assistant history. This is inferred from the binary; R9 handles both the replayed and the stripped case.
- Codex accepts `function_call` input items whose `call_id` has the `srvtoolu_bccf_` prefix. Today Anthropic `toolu_…` ids pass as `call_id` unchanged.
- An astra sub-call fits the 180 s default; slower calls surface as `execution_time_exceeded`.

### Risks & Dependencies

- `proxyWithAccount` is about 6,000 lines. U6 adds two small hooks and one closure; the logic lives in the new module.
- Buffering tool_use blocks until `message_delta` delays tool calls only by the gap between `output_item.added` and `response.completed`. Codex already emits arguments only at `done`.
- Advisor `defer_loading` (the tool-search path) is dropped from the rewritten function, so the worker always sees it.

### Sources & Research

- Claude Code 2.1.296 binary read (`/tmp/advisor-codex-wf-53fb6b4c/out/r1-binary.md`; `pause_turn` sweep 2026-10-13).
- Adversarial critique (`/tmp/advisor-codex-wf-53fb6b4c/out/critique.md`): P0-1 (no mid-stream 400), P0-2 (no forced serial tools), P0-3 (strip by id prefix), and P1-1 through P1-9 are folded into R6-R9 and KTD5-KTD8.
- Fresh integration maps at 087a4fb4 (`/tmp/adv-impl-53fb6b4c/map-{partial,selector,proxy}.md`).
- Prior contract: `docs/plans/2026-10-03-1727-fix-advisor-native-passthrough-plan.md`; `docs/routing-architecture.md` 137-171.

---

## Implementation Units

Phases:
- **A, Pure pieces:** U1, then U2, U3 and U4 (disjoint files, may run in parallel).
- **B, Routing:** U5.
- **C, Wiring:** U6.
- **D, Accounting and docs:** U7.

### U1. Eligibility, model map, profile key, meta plumbing

- **Goal:** decide per request whether emulation applies, and on which accounts.
- **Requirements:** R1, R2 (predicate only), R3; KTD1, KTD2.
- **Files:** `packages/proxy/src/advisor-emulation/eligibility.ts` (+ test), `packages/core/src/model-mappings.ts` (+ test), `packages/core/src/index.ts`, `packages/proxy/src/model-route-profiles.ts` (+ test), `packages/types/src/api.ts`, `packages/proxy/src/proxy.ts` (set meta only).
- **Approach:**
  1. Add `advisorEmulation?: boolean` to `ModelRouteProfile` and `PROFILE_KEYS`, parsed with `optionalBoolean` and spread only when present, so existing profiles stay byte-identical. When it is true and `expectedProvider !== "codex"`, follow the parser's existing error path.
  2. Add `resolveAdvisorEmulationModel(declModel)` and `deriveAdvisorEmulation({body, requirement, serverToolRequirements, profile, env})`. It returns `{advisorModel, declarationModel}` or `{ineligible: reason}`, with one reason per R1 clause.
  3. Add `isCodexOAuthAccount` and `isAdvisorEmulationAdmitted(meta, account)`.
  4. Set `requestMeta.advisorEmulation` in `proxy.ts` right after the requirement assignment, and log the ineligible reason at debug.
- **Test scenarios:** each R1 clause flips eligibility on its own; the model map is case-insensitive, and `sonnet` / unknown models are ineligible; the kill switch is read per call; the profile parse covers true, false, absent (byte-identical), and true with a non-codex provider; the Codex OAuth predicate excludes an api_key, a custom_endpoint, no token, and other providers.
- **Verification:** pure functions; the `model-route-profiles` suite passes unchanged apart from the new cases.

### U2. History projection, emulated strip, shared result text

- **Goal:** one module that recognizes, strips, and projects emulated advisor pairs.
- **Requirements:** R9, R10; KTD8.
- **Files:** `packages/proxy/src/advisor-emulation/history.ts` (+ test), `packages/proxy/src/advisor-result-ownership.ts` (+ test).
- **Approach:**
  1. Generalize `stripAdvisorResults` to take a block predicate. Keep `stripForeignAdvisorResults` and `stripAllAdvisorResults` behavior identical, pinned by the existing tests.
  2. Add `stripEmulatedAdvisorResults(body)`, which matches by id prefix for any result shape.
  3. Add `projectAdvisorHistoryForCodex(body)`: split each assistant message at every emulated pair into `[assistant prefix + tool_use]`, `[user tool_result]`, `[assistant remainder]`, and strip native pairs to the placeholder. It returns `null` when nothing changed.
  4. Add `advisorToolResultText(content)` (`advisor_result` → text; error → `Advisor unavailable (<code>). Continue without advice.`) plus `isEmulatedAdvisorId` and `emulatedAdvisorIdFromCallId`.
- **Test scenarios:**
  - no markers → `null` (byte-identity);
  - one pair mid-message → three messages with thinking blocks kept in their segments;
  - two pairs in one message;
  - a pair at the end (no remainder);
  - an error result;
  - a mixed native + emulated history on first-party (only emulated stripped);
  - an empty-after-strip message gets the placeholder;
  - the foreign and all strips are unchanged.
- **Verification:** the existing `advisor-result-ownership` tests pass unmodified.

### U3. Advisor sub-call builder

- **Goal:** build the Anthropic body for the advisor sub-call.
- **Requirements:** R5; KTD6, KTD7.
- **Files:** `packages/proxy/src/advisor-emulation/sub-call.ts` (+ test).
- **Approach:** `ADVISOR_EMULATION_PROMPT_V1` (a constant, versioned name); `flattenTranscript(messages, inflightAssistantContent, opts)`; `buildAdvisorSubCallBody({body, inflightAssistantContent, advisorModel, cacheKey, maxChars})` → `{model, system, messages:[{role:"user",content:text}], max_tokens, stream:false, __better_ccflare_codex_passthrough:{prompt_cache_key}}`; `classifyAdvisorSubCallFailure(status, errorBody | timeout)` → R5 error code; `extractAdvisorText(json)`.
- **Test scenarios:**
  - deterministic output for identical input;
  - append-only, so turn N's flattened text is a prefix of turn N+1's;
  - per-block truncation and the middle-truncation marker under the cap;
  - images and thinking handled;
  - no `tools` key;
  - the passthrough carries the cache key;
  - every R5 failure mapping, including a context-length message → `prompt_too_long`.

### U4. Declaration rewrite and SSE interceptor

- **Goal:** the pure transforms for the request tools and the response stream.
- **Requirements:** R4, R6, R7, R8, R11 (merge only); KTD3, KTD4, KTD8.
- **Files:** `packages/proxy/src/advisor-emulation/rewrite.ts` (+ test), `packages/proxy/src/advisor-emulation/interceptor.ts` (+ test), `packages/proxy/src/advisor-emulation/sse.ts` (parser, encoder, and block accumulator, + test).
- **Approach:**
  1. `rewriteAdvisorDeclaration(body)` replaces the typed tool in place (order preserved, `defer_loading` dropped).
  2. The interceptor implements R6 and R7. It reconstructs in-flight assistant blocks from events (text, thinking + signature, redacted_thinking, tool_use + JSON).
  3. It runs each round with a ping timer and a per-call timeout through `deps`, and re-indexes the continuation's blocks.
  4. It drops the continuation's `message_start` and holds each worker `message_delta` until the last. The final delta carries summed token fields, the last call's `stop_reason`, and `iterations`.
  5. It propagates `cancel()` and `signal` to the in-flight dep calls. A failed continuation becomes an `error` event after closing any open block.
- **Test scenarios:** AE1, AE2, AE3, AE8, and AE9 with fake SSE streams and fake deps. Also:
  - no tool_use → byte-identical passthrough;
  - an `error` event while buffering → advisor dropped, error passed;
  - `stop_reason` other than `tool_use` with advisor → advisor dropped;
  - pings emitted during a slow dep;
  - index contiguity across two rounds;
  - exactly one `message_start` / `message_delta` / `message_stop`.
- **Execution note:** the planted negative "emit the continuation's `message_start`" must fail a test.

### U5. Selector and backstop admission

- **Goal:** let admitted requests reach Codex OAuth accounts without changing any other routing.
- **Requirements:** R2; KTD1.
- **Files:** `packages/proxy/src/handlers/account-selector.ts` (+ test), `packages/proxy/src/handlers/proxy-operations.ts` (backstop only), `packages/proxy/src/routing-terminal.ts`, and the proxy-level refusal sites at `proxy.ts` ~1073-1090 and ~4506-4517 where they key on the native constraint.
- **Approach:** add `isNativeConstraintSatisfiedBy` and use it at every removal and refusal site listed in KTD1. Update `filterRequestCompatibleAccounts` for message accuracy.
- **Test scenarios:**
  - an admitted request on an opted-in Codex profile selects the Codex account;
  - the same request without meta is refused exactly as today (the existing tests stay green);
  - an admitted request on a pool with a Codex api_key account excludes that account;
  - xAI and openai-compatible stay excluded;
  - the forced pin admits;
  - the backstop admits only with meta.
- **Planted negatives:**
  - make `isAdvisorEmulationAdmitted` return true without meta → an existing refusal test fails;
  - drop the backstop admission → the U6 integration test fails with `provider_unavailable`.

### U6. Proxy wiring and integration test

- **Goal:** connect U2-U4 inside `proxyWithAccount` and prove AE1-AE10 end to end with a fake Codex upstream.
- **Requirements:** R4-R10; KTD3, KTD4, KTD5.
- **Files:**
  - `packages/proxy/src/handlers/proxy-operations.ts`;
  - `packages/proxy/src/advisor-emulation/dispatch.ts` (the closure factory's pure parts);
  - `packages/proxy/src/advisor-emulation/index.ts`;
  - a new `packages/proxy/src/__tests__/advisor-codex-emulation.integration.test.ts` (or the repo's existing integration-test location, following `advisor-passthrough.integration.test.ts`).
- **Approach:**
  1. **Hook (a):** on an admitted Codex attempt, rewrite the declaration and project the history. On a first-party attempt, add `stripEmulatedAdvisorResults` beside `stripForeignAdvisorResults`.
  2. **Internal dispatch:** build the KTD5 closure, which serves `runAdvisor` and `runContinuation`.
  3. **Hook (b):** on an admitted Codex attempt with a 200 SSE response, wrap the response before `processProxyResponse` / `forwardOptions`.
  4. Restore `globalThis.fetch` in `afterEach` (memory: the fetch leak caused batch-only failures).
- **Test scenarios:** AE1-AE10 through the real handler with a Codex account fixture and a fake fetch that asserts each upstream body (tools, model, input tail, cache key) and the fetch count.
- **Planted negatives:**
  - remove the `srvtoolu_bccf_` check from the first-party strip → AE7 fails;
  - emulate on a non-opted profile → AE5 fails;
  - drop the advisor with no sibling present instead of running the round → AE1 fails.

### U7. Accounting and documentation

- **Goal:** advisor spend is recorded and priced; the routing contract documents the exception.
- **Requirements:** R11, R12.
- **Files:** `packages/proxy/src/usage-collector.ts` test (and code only if the test shows a gap), `docs/routing-architecture.md`, and `docs/solutions/` (one learning, via the `ce-compound` convention, only if a non-obvious fact turns up).
- **Approach:** feed the U4 terminal `message_delta` shape through `captureUsageIterations` and assert `advisorUsage` and `advisorIterations`, plus non-zero advisor cost with the models.dev catalogue stubbed to the 2026-10-13 rates. Assert that top-level usage equals the summed worker usage and that `billingIncomplete` is unset. Update `routing-architecture.md` 137-171.
- **Test scenarios:**
  - astra-priced advisor iteration;
  - 6.1-sol-priced advisor iteration;
  - an unpriced advisor model flags `billingIncomplete` (existing behavior kept);
  - two advisor rounds.

---

## Verification Contract

| Gate | Check | Applies to |
|---|---|---|
| Fresh worktree bootstrap | `bun run build:cli` already run in this worktree; rerun if the inline workers are missing | before tests |
| Focused suites | `bun test <file>`, one process per affected file | every unit |
| Baseline | affected suites at 087a4fb4 before the change: account-selector, advisor-passthrough.integration, server-tool-routing.integration, proxy-quality-routes, model-route-profiles, advisor-result-ownership, usage-collector, proxy-operations-failover | U1, U2, U5-U7 |
| Static gates | `bun run lint && bun run typecheck && bun run format`, then revert unrelated biome reformatting | every unit |
| Test call-site sweep | `grep -a` the test tree for changed signatures: `stripAdvisorResults`, `RequestMeta`, `ModelRouteProfile` | U1, U2, U5 |
| Planted negatives | as listed in U4, U5, U6 | U4-U6 |
| Full suite | `bun test` | before the PR |
| Live check | nothing scripted. After an operator-instructed deploy and profile opt-in, the operator runs `/advisor` interactively on the opted-in profile | after merge |

---

## Definition of Done

- R1-R12 each covered by a passing test named in its unit; every AE has a covering test.
- Static gates clean; affected suites pass per file at or above baseline; full `bun test` green, with the known flakes (`incrementalVacuumAdaptive`, `run-ccflare-stack`) rerun to green.
- Planted negatives fail as stated.
- No `inline-*worker*.ts` staged; no version bump; no migration.
- PR on `StartupBros-com/better-ccflare` says "Refs #487". The profile opt-in, deploy, and live `/advisor` check stay with the operator.
