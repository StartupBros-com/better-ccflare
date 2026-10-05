# Serve Claude Code WebSearch natively on first-party Anthropic accounts

Refs #279. Follows the advisor native-passthrough work in #432 (`9cac661b`).

## Problem

Claude Code's WebSearch tool sends a helper request: `POST /v1/messages?beta=true`, `model` = the main-loop model (production rows: `claude-opus-5-5`, `claude-fable-5-1`), one user message `Perform a web search for the query: …`, system `You are an assistant for performing a web search tool use`, `thinking: {type: "disabled"}`, `tool_choice: {type: "tool", name: "web_search"}`, no client tools, and exactly one tool `{type: "web_search_20250305", name: "web_search", allowed_domains?, blocked_domains?, max_uses: 8, search_profile?: "fast"}` (read from the Claude Code 2.1.289 binary).

better-ccflare refuses it locally: HTTP 400 `server_tool_capability_unavailable` (reason `no_implementation`), zero upstream sends. Production rows (2026-09-20 to 2026-10-04, 3–83 a day) show 5 first-party Anthropic OAuth candidates, 0 proven, `zeroAttemptReason: all_unavailable`.

Root cause: `deriveServerToolRequirement` turns `web_search_20250305` into a hosted requirement, and a candidate counts only when its provider builds a capability tuple. Only the Codex provider does, and only with a `claude-* → gpt-5.6-sol` mapping that production does not have. The anthropic provider has no capability hooks, so `provenCandidateCount === 0` (`packages/proxy/src/handlers/account-selector.ts` `capabilityPoolErrorReason`). But `api.anthropic.com` executes `web_search_20250305` itself. PR #282 made the refusal honest and deferred "implementing Anthropic native-passthrough capability tuples"; this plan does that.

## Decisions

1. **Two lanes.** A web_search requirement may be served by a proven hosted lane (Codex, unchanged and fail-closed) **or** by a first-party Anthropic account as a native passthrough. Advisor stays "first-party only"; do not reuse `NATIVE_ANTHROPIC_ONLY_EXCLUSION` or `nativeAnthropicToolRequirement` for web search, because they would strip the Codex lane.
2. **One shared predicate**, `isNativeWebSearchPassthroughEligible(requirements, firstPartyAnthropic)` in `packages/providers/src/server-tool-capabilities.ts`, used by selection, dispatch, Auto admission and the Auto candidate loop. It is true only when all hold:
   - `firstPartyAnthropic === true`, computed by the caller as `isFirstPartyAnthropicAccount(account)` (`packages/core/src/model-mappings.ts`) from the live account, never from the request;
   - requirements defined, `invalid` and `unsupported` empty;
   - exactly one declaration, type `web_search_20250305`;
   - replay input and output atoms contain only `native-Anthropic` (or are empty). Any `proxy-evidence-v1` atom (Codex-hosted `bccf…` history Anthropic cannot read) excludes the native lane, and so does a truncated scan, which already forces every atom on. Issue #431 (long conversations with no declaration) stays out of scope.
3. **Selection.** In `evaluateCandidateServerToolCapability` add a native branch after the logical-model guard: when the predicate holds **and** `previewCandidatePhysicalModel(...)` is non-null (never fall back to the logical model; that would admit `gpt-*` helpers onto Anthropic), return a `proven` candidate capability marked `lane: "native_passthrough"` with a sentinel proof key, empty replay modes and replay status `not_required`. Native candidates count in `provenCandidateCount`, so "first-party accounts exist but are all unavailable" yields `temporary_unavailable` (503) and "none exist" stays `no_implementation` (400). Grep every consumer of `serverToolCapability.proofKey` and make each tolerate the sentinel. **No reordering**: strategy and priority order decide between lanes.
4. **Replay bind.** Production has a replay keyring, so the bind succeeds and nothing changes there. A successful bind acquires a writer issuance lease (`packages/proxy/src/server-tool-replay-runtime.ts` ~350-371); confirm the lease is released when a natively served request completes, fails or is cancelled, and pin that with a test, because a leak would surface only as slow degradation after deploy. When the bind fails and the request could be served natively, continue with native candidates only (`requestMeta.serverToolReplayBound = false`; non-native proven candidates become replay-ineligible in selection) instead of returning `replay_unavailable`. When the bind fails and native is impossible, keep `replay_unavailable`. Same rule in Auto (`quality-route-candidates.ts`).
5. **Dispatch** (`packages/proxy/src/handlers/proxy-operations.ts`). Compute the native lane once per attempt from the live account. For it: skip tuple/proof/replay resolution and the proof-drift assertion, keep the inbound query (`?beta=true`), never claim the hosted-dispatch ledger, never issue replay envelopes, and keep ordinary retry, refresh and failover. A non-first-party account that is not hosted-proven keeps throwing its candidate capability error (the existing backstop); add tests, not a new check.
6. **One search per request across lanes.** Once a native physical send for the request has begun, hosted candidates are skipped (a per-candidate skip, never a terminal error); once a hosted dispatch is claimed, native candidates are skipped. Native-to-native failover keeps ordinary semantics.
7. **Forced tool choice.** Anthropic rejects `tool_choice` `any`/`tool` with a 400 on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 regardless of thinking (platform.claude.com, "Forcing tool use"), and lists no server-tool exemption. Claude Code 2.1.289 demotes a forced choice only when extended thinking is on, so it sends the forced web_search choice on those models. On the native lane only, when the request's tool choice is exactly `{type: "tool", name: "web_search"}` and `supportsForcedToolChoice(<physical model sent upstream>)` is false (`packages/core/src/models.ts`), rewrite `tool_choice` to `{type: "auto"}` and change nothing else. Key the check on the exact physical model string the attempt sends upstream (after the provider's model mapping); the set holds the literal ids `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1` (`packages/core/src/models.ts:118-122`). Production runs `LOG_LEVEL=warn`, so log the demotion once per request at **warn** level with the model name, so the operator can see whether it fired. Every other field passes through byte-for-byte. Auto admission must not reject what dispatch will demote.
8. **`search_profile`.** Accept an optional `search_profile` string (bounded length, printable) in `normalizeExactDeclaration`, stored as `searchProfile`. A hosted Codex tuple must not prove a declaration carrying `searchProfile` (fail closed). The native lane forwards it untouched.
9. **Auto parity.** `evaluateAutoRequestAdmission` admits a web_search request on a first-party Anthropic target when the predicate holds (including the forced web_search choice that dispatch demotes); Codex rungs stay tuple-proven only. In the Auto candidate loop, a `ServerToolCandidateCapabilityError` on a web_search request is a per-candidate skip, not a whole-request failure.
10. **Out of scope.** #431's no-declaration truncation; history-only requests; advisor plus web_search (still refused); pricing `usage.server_tool_use.web_search_requests` (subscription accounts include it; API-key accounts are undercounted, so file a follow-up); combo/model-mapping forced-choice guards for non-web-search requests; cache-keepalive staging (the helper sends `enablePromptCaching: false`, so it carries no `cache_control` and is never staged; a non-Claude-Code client that combines web_search with `cache_control` would get a `max_tokens: 1` keepalive replay, which cannot complete a search).

## Tests (write first, watch them fail)

Use the real integration harness (`packages/proxy/src/__tests__/advisor-passthrough.integration.test.ts` and `server-tool-routing.integration.test.ts` patterns), fake upstreams only. AGENTS.md forbids any traffic to real Anthropic accounts.

Unit (`packages/providers/src/server-tool-capabilities.test.ts`): predicate accepts fresh helper shape, auto choice, forced web_search choice, domains, `user_location`, `max_uses: 8`, `search_profile`; rejects non-first-party, invalid, unsupported, duplicate declarations, `bccf` history, truncated scans, history-only, a second typed tool, advisor beside web_search. `normalizeExactDeclaration` accepts `search_profile`; the Codex tuple builder refuses a declaration with it.

Selector (`packages/proxy/src/handlers/__tests__/account-selector.test.ts`, reuse `mixedPool()`): first-party accounts proven with per-candidate reasons asserted for every pool member (anthropic-compatible, custom-endpoint anthropic, xai, codex stay unproven); unsupported logical model on first-party stays unproven; `no_implementation` when no first-party account exists; `temporary_unavailable` with body `code`/`reason` asserted when every first-party account is excluded; `serverToolReplayBound === false` offers native only.

Integration:
- helper shape reaches the first-party account with the **whole** forwarded body deep-equal to the client body except the documented `tool_choice` demotion and the model-name mapping, URL keeps `beta=true`, `anthropic-beta` keeps the client's betas plus `oauth-2025-04-20`, `calls.length === 1`, streaming and JSON;
- forced choice is forwarded unchanged when the physical model supports it (e.g. `claude-opus-5`) and demoted to `auto` for `claude-opus-5-5`;
- a hosted request still drops the query (contrast);
- disabled replay runtime: first-party serves; Codex-only pool still returns `replay_unavailable` with zero sends;
- proxy-opaque history refused with zero sends; a capacity-deferred non-first-party route bypassing selection never fetches (dispatch backstop);
- anthropic-compatible and custom-endpoint anthropic still `no_implementation`;
- all first-party excluded → 503 `temporary_unavailable`, zero fetches; one throttled and one available → served;
- mixed pool with a genuinely proven Codex fixture (`makeServerToolTuple`) ordered **ahead** by priority executes exactly one search; native first failing after transport → no Codex transport (spy on the Codex attempt path, not only `fetch`);
- force-route header to a first-party account admitted; to a non-first-party account stays `forced_incapable`;
- response passthrough: streamed `server_tool_use` / `web_search_tool_result` / citations bytes reach the client unchanged and no replay envelope is issued.

Auto (`packages/providers/src/auto-request-admission.test.ts`, `packages/proxy/src/__tests__/proxy-quality-routes.test.ts`): first-party target admitted, non-first-party rejected, Codex tuple-only, candidate-loop capability error skips the candidate.

Existing tests that encode the bug (`proxy-quality-routes.test.ts` "unsupported hosted work remains typed unavailable…", `proxy-combo-fallback.test.ts` "does not defer native backups that lack the request's server-tool capability"): re-derive each expectation before changing it, keep its original intent on a non-first-party fixture, and never weaken a still-valid assertion.

## Docs

- `docs/routing-architecture.md`: rewrite the hosted contract's "proofless routes fail closed with zero provider sends" sentence to describe both lanes, the predicate, the replay-atom exclusion, the bind rule, the one-search rule and the forced-choice demotion; update the Auto section.
- `CONCEPTS.md`: native web-search passthrough versus hosted WebSearch versus advisor.
- `docs/solutions/integration-issues/claude-code-websearch-refused-as-no-implementation.md`: symptom, cause, fix, read-only production check.

## Verification boundary

No scripted request may reach a real Anthropic account. After deploy, the operator runs one interactive WebSearch and checks, read-only, that the helper row has an `account_used`, `status_code = 200` and no `server_tool_*` error:

```sql
-- sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db
SELECT datetime(timestamp/1000,'unixepoch','localtime') t, model, account_used, status_code, error_message
FROM requests
WHERE routing_attempt_summary LIKE '%trusted_helper%'
ORDER BY timestamp DESC LIMIT 10;
```

The Claude Code transcript for that turn must show real search results (`Web search results for query: …` with links). A 200 helper row with no search results would mean the `auto` demotion degraded the helper; the fallback design is then "forward the forced choice unchanged and retry once with `auto` on Anthropic's forced-tool-use 400". That observation is the one that can falsify decision 7, and only the operator can make it.
