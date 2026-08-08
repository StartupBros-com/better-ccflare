---
title: "Codex Native Hosted Web Search on Current Main - Implementation Plan"
type: fix
date: 2026-07-29
reconciled: 2026-08-08
topic: provider-server-tool-capabilities
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
planning_base_sha: 93fc8e17f36e83de529ba785ba7676fe85467eef
---

# Codex Native Hosted Web Search on Current Main - Implementation Plan

## Goal Capsule

- **Objective:** Preserve Anthropic server-tool semantics when Claude Code is routed through a Codex OAuth account: send a native Codex hosted-search request, translate its native lifecycle back into valid Anthropic server-tool output, and support a later turn without permitting duplicate hosted execution.
- **Current-main finding:** `origin/main` already contains provider-neutral server-tool requirements, exact capability tuples, candidate filtering, immutable attempt plans, authenticated `bccf2` replay readers, request-body reuse, route deduplication, circuit admission, WebSocket transport, client-abort propagation, response disposal, and the latest Codex usage-polling fixes through PR #125. Codex still has no capability tuple, hosted-search request mapper, native response decoder, or working attempt-plan integration, and the proxy still hides requirement extraction behind `CCFLARE_SERVER_TOOL_WEB_SEARCH`.
- **Decision:** The plan remains relevant, but its former pair-canary/proof-control system is not. Admission authority is reviewed embedded code plus the deployed git SHA. Request-scoped at-most-one dispatch belongs in `RoutingAttemptLedger`. The only new durable state is the bounded fleet issuance count required to enable the already-landed AES-GCM replay writer safely.
- **Execution profile:** Test-first in a branch rooted directly at current `origin/main`; selectively port isolated protocol modules from the old branch and manually integrate them against current routing, circuit, abort, drain, and WebSocket behavior.
- **Performance posture:** Ordinary requests add no network or database work. Server-tool requirements are derived once from the already-buffered body. Capability resolution is frozen and synchronous. The replay issuance counter is touched only after a capability-bearing response emits an authenticated replay envelope.
- **Safety boundary:** Never automate or `curl` Anthropic or a Codex subscription account. Use unit tests, sanitized fixtures, and fake upstreams until the merged main deployment. Final proof uses a naturally initiated Claude Code two-turn search through the existing service.
- **Deployment posture:** No feature flag, manual arm, parallel service, alternate database, or shadow install. Unsupported tuples fail locally before provider I/O. A failed live canary is handled by reverting main and deploying the prior reader-compatible build.

## Why the Previous Plan Was Reduced

The former design added a second durable qualification system: pair claims, owner generations, cohort and lineage HMACs, runtime snapshots, quarantine, startup reload, maintenance, and an evidence inspector. That machinery was designed to learn and promote capability at runtime across restarts and overlapping processes.

That property is unnecessary here. The supported Codex tuple and declaration profiles are finite and reviewed in source. The deployed SHA is the authorization boundary. A process-local ledger is sufficient to prevent duplicate physical sends within one inbound request; a proxy crash or ambiguous transport is terminal and is never automatically replayed. Separate client resubmissions cannot be deduplicated without a trusted client idempotency key and are outside this change.

The reduced architecture therefore keeps:

1. exact typed capability admission;
2. native request, response, lifecycle, and Anthropic encoding;
3. request-private authenticated continuation evidence;
4. one monotonic final-send claim for HTTP and WebSocket;
5. fake-upstream and natural-client proof;
6. immediate main rollback.

It removes characterization capture scripts, runtime promotion, pair canaries, proof lineage, proof-control database rows, control HMACs, quarantine state, control maintenance, and a separate inspection CLI.

## Product Contract

### User-visible behavior

When Claude Code sends `web_search_20250305`, better-ccflare must preserve it as a server-owned operation. The client must observe an Anthropic-compatible server-tool lifecycle and citations, not a client `tool_use` that Claude Code cannot execute. A later turn in the same task must be able to consume authenticated, content-bounded replay evidence without performing a second search unless the new request itself explicitly asks for one.

### Functional requirements

- **R1 — Protocol identity:** Classify tools by protocol type, never display name. Ordinary functions named `web_search` remain ordinary client functions.
- **R2 — Exact admission:** A supported tuple binds provider, OAuth subscription endpoint class, physical model, normalized declaration profile, response mode, mixed-tool mode, and replay shape. Unknown provider, endpoint, query-bearing route, model, declaration revision, option field, mode, or replay shape fails locally before provider I/O.
- **R3 — Finite Codex authority:** Codex owns one embedded, deep-frozen capability matrix derived from committed sanitized fixtures. Provider hooks materialize only those exact tuples; callers cannot forge support by constructing a structurally similar object.
- **R4 — Options:** Preserve and validate the supported `max_uses`, domain filter, and location contract with byte-based bounds, deterministic normalization, duplicate handling, mutual-exclusion rules, and unknown-field rejection. Never silently drop a restriction.
- **R5 — Request mapping:** A capability-bearing Codex attempt maps the Anthropic declaration to the exact native hosted-search request and removes the client-function surrogate. Non-capability attempts retain current Codex behavior byte-for-byte.
- **R6 — Native decoding:** Decode both Responses SSE and JSON into one bounded lifecycle. Reject unknown, malformed, duplicate, out-of-order, contradictory, or incomplete events. Raw provider events never pass through as valid Anthropic server-tool output.
- **R7 — Anthropic encoding:** Emit valid streaming and non-streaming Anthropic server-tool blocks, citations, usage, error, and terminal ordering. Never invent a successful result, citation, locator, usage count, or zero-search predicate.
- **R8 — Continuation:** Emit authenticated `bccf2` source/citation envelopes through request-private closures, and project only valid prior evidence back into the native Codex history shape. Invalid, expired, mismatched, oversized, or unknown envelopes fail locally.
- **R9 — Replay writer accounting:** Enable the existing AES-GCM writer only when a persistent fleet issuance count is available. Atomically reserve one issuance before nonce generation and encryption so concurrent writers can never exceed the fleet bound. A later encryption failure may conservatively burn that count; it never refunds or reuses it. Enforce the existing rotation/exhaustion thresholds. Store counts only; never store request, query, result, URL, citation, token, or envelope content.
- **R10 — At-most-one hosted dispatch:** Extend `RoutingAttemptLedger` with a monotonic `undispatched -> hosted_dispatched` claim. The first capability-bearing HTTP fetch or WebSocket `response.create` pre-write wins. After the claim, every thinking retry, cache retry, prompt-breakpoint retry, model fallback, account failover, 529 retry, WS-to-HTTP rescue, recovery marker, redirect, and ambiguous transport path is terminal for that inbound request.
- **R11 — Final-send ordering:** Current route/circuit eligibility and physical-send reservation complete before the hosted claim. Immediately before irreversible provider I/O, revalidate the immutable attempt-plan capability, claim hosted dispatch synchronously, record physical telemetry, and perform exactly one manual-redirect HTTP fetch or one WebSocket frame write. A failed claim performs zero provider I/O.
- **R12 — WebSocket parity:** WebSocket ownership is claimed before the first `response.create` frame is written, not in the existing post-write callback. A frame-write error remains ambiguous and cannot fall back to HTTP.
- **R13 — Guard replay:** Guard recovery headers and 503 retry authorization are emitted only while the ledger remains `undispatched`. Once hosted dispatch is claimed, the proxy must not authorize guard replay.
- **R14 — Cancellation and resources:** Cancellation before the claim performs zero hosted sends. Cancellation after the claim performs at most one, aborts the upstream, and cannot reopen retry. Every response clone, body, stream reader, circuit reservation, and WebSocket resource is released on success, error, refusal, timeout, malformed data, and abort.
- **R15 — No flag:** Remove `CCFLARE_SERVER_TOOL_WEB_SEARCH`, its config export, proxy gate, flag-dependent tests, and default-off README text. Exact capability admission itself is the gate.
- **R16 — Ordinary-path invariance:** Requests without a server-tool requirement perform no replay issuance database operation and no hosted-dispatch claim. Existing Anthropic, OpenAI-compatible, xAI, WebFetch, function-tool, cache, routing, circuit, rate-limit, cancellation, and streaming behavior remains unchanged.
- **R17 — Scope:** WebFetch is explicitly outside this fix. No reverse Responses adapter, generic web-search fallback ladder, model pricing research, UI, version bump, generated worker, or provider automation is included.
- **R18 — Deployment proof:** Merge through the existing draft-PR workflow, deploy only from `refs/heads/main` with `scripts/deploy-ccflare.sh`, verify `/health.git_sha`, then use natural Claude Code traffic for one fresh hosted search and one continuation turn. Never send a scripted Anthropic/Codex canary.

### Failure behavior

- Invalid or unsupported declarations return the existing typed local routing error with zero upstream sends.
- A capability-plan mismatch at pretransport is local and sends nothing.
- Once dispatch is claimed, any HTTP response, redirect, EOF, timeout, protocol error, decoder/encoder error, cancellation, resource loss, refusal, or unknown lifecycle is non-replayable for that inbound request.
- A response that cannot be translated honestly terminates as an error; it is never converted to a client function and never retried on another provider.
- A missing/unavailable replay key or issuance counter makes continuation-capable Codex tuples ineligible locally; it does not affect ordinary traffic.

## Current-Main Reconciliation

### Reuse unchanged

- `packages/types/src/provider-capabilities.ts`
- `packages/providers/src/server-tool-capabilities.ts`
- `packages/providers/src/provider-attempt-plan.ts`
- `packages/providers/src/server-tools/replay-envelope.ts`
- `packages/providers/src/server-tools/history-projection.ts`
- `packages/proxy/src/request-body-context.ts`
- `packages/proxy/src/handlers/account-selector.ts`
- current circuit, rate-limit, request-abort, response-disposal, and WebSocket transport foundations

### Port selectively from the old branch

- atomic replay-envelope issuance/age correction from `33d1dadf`
- lifecycle reducer from `83473825`
- native Codex response decoder and sanitized fixtures from `6d555a5e`
- Anthropic encoder from `8727c53d`
- cancellation hardening from `d3aed9d4`, reconciled against current main

### Rebuild against current main

- Codex exact capability ownership and request mapper
- request-private history projector and replay issuer
- narrow replay-issuance repository and server bootstrap
- hosted dispatch claim in HTTP and WebSocket paths
- guard recovery suppression after hosted dispatch
- attempt-plan request/response integration

### Do not port

- characterization/capture harness and preload scripts
- `server_tool_proof_controls` migrations and repository APIs
- proof-control runtime, pair claims, cohort/lineage hashes, owner generations, quarantine, contract observer, control maintenance, and inspector
- stale proxy/server/database integration hunks that overlap current circuit, abort, retention, or routing behavior

## Implementation Units

### U1 — Exact Codex capability and request mapping

**Files**

- `packages/providers/src/providers/codex/server-tools.ts`
- `packages/providers/src/providers/codex/provider.ts`
- `packages/providers/src/providers/codex/provider.server-tools.test.ts`
- `packages/providers/src/server-tool-capabilities.test.ts`

**Test first**

- exact endpoint/model/declaration/mode/replay matrix admits;
- near misses and unknown fields reject locally;
- ordinary functions named `web_search` remain functions;
- normalized restrictions survive native mapping exactly;
- mapper output is deeply immutable and request-local;
- no provider hook exposes a generic callback capable of blessing a forged tuple.

**Implementation**

- Define the finite embedded Codex profile matrix.
- Implement `CodexProvider.createServerToolCapabilityTuple`, `resolveServerToolCapability`, and `createAttemptPlan`.
- Map only a proven capability-bearing request to native hosted search.
- Preserve existing Codex request behavior for every non-capability attempt.

### U2 — Hosted lifecycle, native decoder, and Anthropic encoder

**Files**

- `packages/providers/src/server-tools/hosted-search-lifecycle.ts`
- `packages/providers/src/server-tools/hosted-search-lifecycle.test.ts`
- `packages/providers/src/server-tools/anthropic-server-tool-encoder.ts`
- `packages/providers/src/server-tools/anthropic-server-tool-encoder.test.ts`
- `packages/providers/src/providers/codex/server-tool-response.ts`
- `packages/providers/src/providers/codex/server-tool-response.test.ts`
- `packages/providers/src/providers/codex/__fixtures__/server-tools/*`
- necessary provider barrel exports

**Test first**

- complete SSE and JSON success;
- empty result, native tool error, refusal, max-token terminal, and usage accounting;
- citations and source ordering;
- fragmented SSE, UTF-8 splits, malformed JSON, duplicate/out-of-order/unknown events, premature EOF, timeout, and cancellation;
- streaming and non-streaming Anthropic parity;
- no unbounded event or text retention.

**Implementation**

- Port the standalone reducer, decoder, encoder, and sanitized fixtures.
- Keep provider-native parsing separate from Anthropic wire encoding.
- Dispose all parser, stream, and response resources on every terminal.

### U3 — Request-private continuation and fleet issuance accounting

**Files**

- `packages/database/src/migrations.ts`
- `packages/database/src/migrations-pg.ts`
- `packages/database/src/repositories/server-tool-replay-issuance.repository.ts`
- repository and migration tests for SQLite and PostgreSQL
- `packages/database/src/database-operations.ts`
- `packages/database/src/index.ts`
- `packages/proxy/src/server-tool-replay-runtime.ts`
- `packages/proxy/src/server-tool-replay-runtime.test.ts`
- `apps/server/src/server.ts`
- `apps/server/src/device-setup-lifecycle.test.ts`

**Test first**

- SQLite and PostgreSQL new-install and upgrade parity;
- atomic monotonic issuance count under concurrency;
- unknown future schema remains reader-compatible;
- writer unavailable when count read/write is unavailable;
- rotation/exhaustion thresholds and failed-record behavior;
- no content columns and no ordinary-request repository calls;
- request-private history projection and issuer closures reject reuse or forgery.

**Implementation**

- Add only the bounded `server_tool_replay_issuance` counter table to both database backends.
- Bind it to the existing replay runtime without exposing the codec or key material globally.
- Build request-private history projector and replay issuer closures in the Codex attempt plan.

### U4 — Remove the default-off gate and preserve exact routing

**Files**

- `packages/config/src/server-tool-web-search.ts` (remove)
- `packages/config/src/server-tool-web-search.test.ts` (remove)
- `packages/config/src/index.ts`
- `packages/proxy/src/proxy.ts`
- `packages/proxy/src/__tests__/server-tool-routing.integration.test.ts`
- affected flag-dependent proxy tests
- `README.md`

**Test first**

- server-tool requirements are always derived from the final request body;
- exact unsupported declarations fail locally with zero provider calls;
- ordinary traffic sees no database access and unchanged candidate order;
- replay-unavailable candidates are ineligible without affecting unrelated accounts;
- no environment value can disable or broaden exact capability admission.

**Implementation**

- Remove the environment flag and unconditionalize requirement derivation.
- Keep exact candidate and pretransport capability revalidation as the sole admission gate.
- Replace README flag instructions with the replay-key operational prerequisite and exact fail-closed behavior.

### U5 — Monotonic hosted-dispatch ownership

**Files**

- `packages/proxy/src/handlers/routing-attempt-ledger.ts`
- `packages/proxy/src/handlers/__tests__/routing-attempt-ledger.test.ts`
- `packages/proxy/src/handlers/proxy-operations.ts`
- `packages/proxy/src/handlers/__tests__/proxy-operations-failover.test.ts`
- `packages/proxy/src/handlers/__tests__/proxy-operations-codex-websocket.test.ts`
- `packages/proxy/src/handlers/__tests__/proxy-operations-client-abort.test.ts`
- `packages/proxy/src/codex-websocket-contract.ts`
- `packages/proxy/src/codex-websocket-transport.ts`
- `packages/proxy/src/handlers/routing-terminal.ts`
- `packages/proxy/src/handlers/__tests__/routing-terminal.test.ts`
- `scripts/__tests__/ccflare-guard-policy.test.ts`
- `scripts/__tests__/ccflare-guard.test.ts`

**Test first**

- first hosted claim wins and every later claim fails;
- competing async paths still produce one claim;
- HTTP claims immediately before fetch;
- WebSocket claims before `response.create` write;
- WS write ambiguity never falls back to HTTP;
- abort before claim sends zero; abort after claim sends at most one;
- 400/401/429/529/5xx, redirect, EOF, timeout, malformed lifecycle, and every current retry family remain at one send;
- post-claim responses never emit guard retry authorization;
- non-hosted retry/failover behavior remains unchanged;
- current circuit-success accounting, body draining, clone disposal, reader release, and deadline cleanup remain green.

**Implementation**

- Add read-only hosted dispatch state plus synchronous `claimHostedDispatch()`.
- Thread hosted ownership through the current attempt-plan dispatch seam.
- Add a WebSocket pre-write hook and retain the existing post-write receipt hook for telemetry.
- Suppress all in-process and guard retry paths after claim without changing ordinary retry behavior.

### U6 — Vertical slice, verification, and deployment

**Files**

- Codex/provider/proxy integration tests listed above
- root `README.md`
- this plan

**Verification**

1. Run focused provider, replay, database, routing-ledger, proxy-operation, guard, abort, and WebSocket tests.
2. Run isolated PostgreSQL migration/repository tests; a missing PostgreSQL test URL is a release blocker for this database change.
3. Run `bun run lint && bun run typecheck && bun run format` and confirm `git diff --check`.
4. Run the repository's full test suite and build gates required by CI.
5. Run an independent code review against the exact current-main merge base and resolve all P0/P1 findings.
6. Push a focused draft PR without generated-worker or version changes.
7. Merge only after CI/review, update the launch checkout to `refs/heads/main`, and deploy with `scripts/deploy-ccflare.sh`.
8. Verify the existing service is healthy and `/health.git_sha` equals merged main.
9. Observe naturally initiated Claude Code traffic: turn one performs one native hosted search; turn two consumes authenticated evidence with no hosted search unless explicitly requested. Confirm one physical upstream dispatch per inbound request, zero guard replay, valid citations, and a normal terminal without inspecting prompt/result content.

## Acceptance Matrix

| Case | Expected admission | Provider sends | Retry/failover | Client result |
|---|---:|---:|---|---|
| Ordinary request | unchanged | unchanged | unchanged | unchanged |
| Function named `web_search` | ordinary function path | unchanged | unchanged | unchanged |
| Exact Codex fresh profile | admitted | exactly 1 | none after send | native Anthropic server-tool lifecycle |
| Exact continuation with valid `bccf2` evidence | admitted | exactly 1 request dispatch; zero new hosted executions unless declared | none after send | evidence-aware continuation |
| Unsupported option/model/endpoint/mode | rejected locally | 0 | 0 | typed routing error |
| Replay key/counter unavailable | rejected locally for continuation-capable tuple | 0 | 0 | typed routing error |
| Abort before claim | rejected/aborted | 0 | 0 | client-aborted terminal |
| Abort or transport ambiguity after claim | admitted then terminal | at most 1 | 0 | non-replayable error/abort |
| Unknown/malformed native event | admitted then terminal | 1 | 0 | honest translation error |
| WS frame-write ambiguity | admitted then terminal | at most 1 | no HTTP rescue | non-replayable error |
| WebFetch | out of scope | unchanged | unchanged | unchanged |

## Rollback

- Rollback is code-based, not a runtime flag. Revert the hosted-search integration on `refs/heads/main`, retain reader-compatible replay/database schema, deploy with `scripts/deploy-ccflare.sh`, and verify the prior SHA at `/health`.
- Never drop the replay issuance table during rollback. Old readers ignore it; later reintroduction can reuse its monotonic count.
- If only the active replay writer is unsafe, remove its protected key-file configuration and restart to make capability admission fail closed, then land the reviewed main revert. This is emergency containment, not the normal activation model.
- Do not retry the failed live request automatically and do not switch it to another provider after hosted dispatch.

## Definition of Done

- Codex owns and wires an exact native hosted-search capability and attempt plan.
- Claude Code no longer receives a client `tool_use` surrogate for an admitted server-owned search.
- Native SSE and JSON lifecycles translate honestly to streaming and non-streaming Anthropic output.
- Continuation evidence is authenticated, bounded, request-private, and fleet issuance is durably counted without content persistence.
- A capability-bearing inbound request can cross exactly one irreversible HTTP or WebSocket send boundary.
- Every existing retry, failover, guard replay, abort, circuit, body-disposal, and WebSocket-rescue path is proven against that boundary.
- `CCFLARE_SERVER_TOOL_WEB_SEARCH` no longer exists; exact capability admission is live automatically in the existing service.
- Ordinary requests have no new database/network work and retain existing behavior.
- SQLite and PostgreSQL parity, focused/full gates, independent review, draft PR, main-only deploy, matching health SHA, and a natural two-turn Claude Code canary are complete.
- No generated worker, `apps/cli/README.md`, version, WebFetch, reverse adapter, pair-canary/proof-control, or synthetic Anthropic/Codex traffic change is present.
