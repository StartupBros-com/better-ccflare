---
title: "Codex Native Hosted Web Search on Current Main - Implementation Plan"
type: fix
date: 2026-07-29
reconciled: 2026-08-08
topic: provider-server-tool-capabilities
artifact_contract: ce-unified-plan/v1
artifact_readiness: historical
product_contract_source: ce-plan-bootstrap
execution: code
planning_base_sha: 93fc8e17f36e83de529ba785ba7676fe85467eef
implementation_status: shipped
operational_status: deployed-and-verified
closed: 2026-09-01
shipped_prs:
  foundation: 129
  forced_choice_compatibility: 287
  live_contract_corrections: "290-306"
---

# Codex Native Hosted Web Search on Current Main - Implementation Plan

> **Closed implementation record (2026-09-01).** The native Codex Hosted WebSearch foundation shipped in [PR #129](https://github.com/StartupBros-com/better-ccflare/pull/129) (`77c82ca40`). Live Claude Code compatibility and current ChatGPT Codex response semantics were completed by [PR #287](https://github.com/StartupBros-com/better-ccflare/pull/287) and PRs [#290](https://github.com/StartupBros-com/better-ccflare/pull/290)–[#306](https://github.com/StartupBros-com/better-ccflare/pull/306): beta-query semantic aliasing and attempt-plan parity (#290–#291), removal of unsupported request fields (#292–#293), forced-choice mapping (#294), bounded privacy-safe diagnostics (#295–#302), multi-query/source-less search decoding (#303), auxiliary open/find actions (#304), authoritative completed-action handling (#305), and latest source-less-search citation attribution (#306). The final contract ran on `refs/heads/main` as version 3.5.70 / runtime `a1ae9169`; naturally initiated Claude Code WebSearch completed with one physical attempt and valid citations. The qualified post-success observation is recorded in the descendant-routing plan and did not use scripted subscription traffic.

The requirements and implementation units below are retained as historical design authority. The former pair-canary/proof-control machinery remains superseded and must not be reintroduced. Current behavior is canonical in [Hosted WebSearch routing contract](../routing-architecture.md#hosted-websearch-routing-contract), and the cross-cutting authorization/ownership rule is captured in [Authorization-Before-Ranking and Success-Conditioned Route Ownership](../solutions/architecture-patterns/commit-bound-routing.md).

## Goal Capsule

- **Objective:** Preserve Anthropic server-tool semantics when Claude Code is routed through a Codex OAuth account: send a native Codex hosted-search request, translate its native lifecycle back into valid Anthropic server-tool output, and support a later turn without permitting duplicate hosted execution.
- **Current-main finding:** `origin/main` already contains provider-neutral server-tool requirements, exact capability tuples, candidate filtering, immutable attempt plans, authenticated `bccf2` replay readers, request-body reuse, route deduplication, circuit admission, WebSocket transport, client-abort propagation, response disposal, and the latest Codex usage-polling fixes through PR #125. Codex still has no capability tuple, hosted-search request mapper, native response decoder, or working attempt-plan integration, and the proxy still hides requirement extraction behind `CCFLARE_SERVER_TOOL_WEB_SEARCH`.
- **Decision:** The plan remains relevant, but its former pair-canary/proof-control system is not. Admission authority is reviewed embedded code plus the deployed git SHA. Request-scoped at-most-one dispatch belongs in `RoutingAttemptLedger`. The only new durable state is the bounded fleet issuance count required to enable the already-landed AES-GCM replay writer safely.
- **Execution profile:** Test-first in a branch rooted directly at current `origin/main`; selectively port isolated protocol modules from the old branch and manually integrate them against current routing, circuit, abort, drain, and WebSocket behavior.
- **Performance posture:** Ordinary requests add no network or database work. Server-tool requirements are derived once from the already-buffered body. Capability resolution is frozen and synchronous. Each capability request performs one atomic durable reservation of the exact 512-slot hosted-search lifecycle bound before request-private replay binding and before provider I/O; per-envelope claims are then in-memory only after dispatch, so responses do not serialize one database write per source or citation.
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
- **R2 — Exact admission:** A supported tuple binds provider, OAuth subscription endpoint class, physical model, normalized declaration profile, response mode, mixed-tool mode, and one of exactly eight replay rows: fresh input `[] -> proxy-evidence` output or natural-continuation input `[native-Anthropic] -> proxy-evidence` output, each crossed with `json`/`streaming` and server-only/mixed modes. Unknown provider, endpoint, query-bearing route, model, declaration revision, option field, mode, or replay row fails locally before provider I/O.
- **R3 — Finite Codex authority:** Codex owns one embedded, deep-frozen capability matrix derived from committed sanitized fixtures. Provider hooks materialize only those exact tuples; callers cannot forge support by constructing a structurally similar object.
- **R4 — Options:** Preserve and validate the supported `max_uses`, domain filter, and location contract with byte-based bounds, deterministic normalization, duplicate handling, mutual-exclusion rules, and unknown-field rejection. Never silently drop a restriction.
- **R5 — Request mapping:** A capability-bearing Codex attempt maps the Anthropic declaration to the exact native hosted-search request and removes the client-function surrogate. Non-capability attempts retain current Codex behavior byte-for-byte.
- **R6 — Native decoding:** Decode both Responses SSE and JSON into one bounded lifecycle. Reject unknown, malformed, duplicate, out-of-order, contradictory, or incomplete events. Raw provider events never pass through as valid Anthropic server-tool output.
- **R7 — Anthropic encoding:** Emit valid streaming and non-streaming Anthropic server-tool blocks, citations, usage, error, and terminal ordering. Never invent a successful result, citation, locator, usage count, or zero-search predicate.
- **R8 — Continuation:** Emit authenticated `bccf2` source/citation envelopes through request-private closures. Natural-continuation input `[native-Anthropic]` is admissible only when request-private authenticated history projection validates prior proxy evidence and projects it into the native Codex history shape; a caller assertion, missing projector, or invalid, expired, mismatched, oversized, or unknown envelope fails locally.
- **R9 — Replay writer accounting:** Every capability request must acquire an exclusive durable issuance lease of exactly `HOSTED_SEARCH_LIFECYCLE_LIMITS.replayEnvelopes` (`512`) slots—the hard hosted-search lifecycle bound—before request-private replay binding and before provider I/O. Each bind performs one atomic reservation; structural writer readiness without a successful request lease is insufficient. Concurrent requests cannot share a lease or overcommit the fleet bound. Only after hosted dispatch may that request claim one slot per envelope in memory; claims 1–512 are unique, claim 513 fails closed without a second store call, and unused slots burn on completion, failure, or crash and are never refunded or reused. Enforce the existing rotation/exhaustion thresholds. Store only opaque counter identity and reserved-slot count; never store request, query, result, URL, citation, token, envelope, build, or revision content.
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
- A missing/unavailable replay key, issuance counter, or successful 512-slot request lease makes capability-bearing Codex tuples ineligible locally; structural writer readiness alone does not admit them, and ordinary traffic remains unaffected.

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

- `packages/types/src/provider-capabilities.ts`
- `packages/providers/src/types.ts`
- `packages/providers/src/server-tool-capabilities.ts`
- `packages/providers/src/server-tool-capabilities.test.ts`
- `packages/providers/src/provider-attempt-plan.ts`
- `packages/providers/src/provider-attempt-plan.test.ts`
- `packages/providers/src/providers/codex/server-tools.ts`
- `packages/providers/src/providers/codex/provider.ts`
- `packages/providers/src/providers/codex/provider.server-tools.test.ts`
- `packages/providers/src/index.ts`
- `packages/proxy/src/server-tool-replay-runtime.ts`
- `packages/proxy/src/server-tool-replay-runtime.test.ts`
- `packages/proxy/src/proxy.ts`
- `packages/proxy/src/handlers/proxy-operations.ts`
- `packages/proxy/src/handlers/__tests__/proxy-operations-failover.test.ts`

**Test first**

- exact endpoint/model/declaration matrix admits only the following eight replay rows:

  | Request shape | Input replay | Output replay | Response mode | Tool mode |
  |---|---|---|---|---|
  | fresh | `[]` | `proxy-evidence` | `json` | server-only |
  | fresh | `[]` | `proxy-evidence` | `json` | mixed |
  | fresh | `[]` | `proxy-evidence` | streaming | server-only |
  | fresh | `[]` | `proxy-evidence` | streaming | mixed |
  | natural continuation | `[native-Anthropic]` | `proxy-evidence` | `json` | server-only |
  | natural continuation | `[native-Anthropic]` | `proxy-evidence` | `json` | mixed |
  | natural continuation | `[native-Anthropic]` | `proxy-evidence` | streaming | server-only |
  | natural continuation | `[native-Anthropic]` | `proxy-evidence` | streaming | mixed |

- the natural-continuation regression derives `[native-Anthropic]` from Anthropic encoder output, rejects every non-native replay-input assertion, and admits the request only with request-private authenticated history projection;
- near misses and unknown fields reject locally;
- ordinary functions named `web_search` remain functions;
- normalized restrictions survive native mapping exactly;
- mapper output is deeply immutable and request-local;
- no provider hook exposes a generic callback capable of blessing a forged tuple.
- option values, response mode, mixed-tool mode, and replay shape all participate in tuple identity;
- history projector and replay issuer closures are available only to the capability-bearing custom planner after a successful request-private replay bind and never appear on serializable request metadata or the returned plan.

**Implementation**

- Extend the provider-neutral requirement and tuple contract with exact option-profile, response-mode, and mixed-tool-mode dimensions.
- Define the finite embedded Codex profile matrix.
- Implement `CodexProvider.createServerToolCapabilityTuple`, `resolveServerToolCapability`, and `createAttemptPlan`.
- After the durable request lease succeeds, bind the replay codec to trusted request-local audience/lineage and pass only frozen projector/issuer closures through capability-only attempt-plan context; structural codec/writer readiness alone is not admission.
- Map only a proven capability-bearing request to native hosted search.
- Parse each native response event once and fan it out to hosted lifecycle reduction plus the existing client-function and usage/model terminal paths.
- Preserve existing Codex request behavior for every non-capability attempt; `createAttemptPlan` is bypassed when the capability proof key is null.

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
- `packages/database/src/repositories/__tests__/server-tool-replay-issuance.repository.test.ts`
- `packages/database/src/database-operations.ts`
- `packages/database/src/index.ts`
- `packages/proxy/src/server-tool-replay-runtime.ts`
- `packages/proxy/src/server-tool-replay-runtime.test.ts`
- `apps/server/src/server.ts`
- `apps/server/src/device-setup-lifecycle.test.ts`
- `.github/workflows/managed-routing-postgres.yml`

**Test first**

- SQLite and PostgreSQL new-install and upgrade parity;
- every capability bind makes exactly one atomic durable reservation for an exclusive `HOSTED_SEARCH_LIFECYCLE_LIMITS.replayEnvelopes` (`512`) lease—the hard hosted-search lifecycle bound—before private replay binding and provider I/O, while structural writer readiness without that lease fails closed;
- concurrent requests receive disjoint leases and cannot share or overcommit slots;
- per-envelope claims begin only after hosted dispatch, claims 1–512 are unique and in-memory, claim 513 fails closed with no second store call, and unused slots burn on completion, failure, or crash without refund;
- unknown future schema remains reader-compatible;
- writer unavailable when count read/write is unavailable;
- rotation/exhaustion thresholds and failed-record behavior;
- no content columns and no ordinary-request repository calls;
- the natural-continuation regression accepts `[native-Anthropic]` only through request-private authenticated history projection, emits `proxy-evidence`, and rejects missing-projector, reuse, or forgery paths before provider I/O;
- `server-tool-replay-issuance.repository.test.ts` exercises PostgreSQL under `BETTER_CCFLARE_TEST_POSTGRES_URL` in the existing managed-routing workflow.

**Implementation**

- Add only the bounded `server_tool_replay_issuance` counter table to both database backends.
- Make one atomic 512-slot reservation per capability bind and publish no request-private replay authority until the exclusive lease succeeds.
- Bind the lease to the existing replay runtime without exposing the codec or key material globally; claim envelope slots in memory only after dispatch and never refill the lease.
- Build request-private history projector and replay issuer closures in the Codex attempt plan, with unused issuance slots conservatively burned rather than refunded.

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
- the client-abort/cancel regression settles a committed, untransferred degraded lifecycle as `cancelled` before returning 499 and never reopens retry or failover;
- 400/401/429/529/5xx, redirect, EOF, timeout, malformed lifecycle, and every current retry family remain at one send;
- post-claim responses never emit guard retry authorization;
- non-hosted retry/failover behavior remains unchanged;
- current circuit-success accounting, body draining, clone disposal, reader release, and deadline cleanup remain green.

**Implementation**

- Add read-only hosted dispatch state plus synchronous `claimHostedDispatch()`.
- Thread hosted ownership through the current attempt-plan dispatch seam.
- Add a WebSocket pre-write hook and retain the existing post-write receipt hook for telemetry.
- Preserve client-abort cancellation settlement before the 499 return while keeping the hosted claim monotonic.
- Suppress all in-process and guard retry paths after claim without changing ordinary retry behavior.

### U6 — Vertical slice, verification, and deployment

**Files**

- `packages/providers/src/providers/codex/provider.server-tools.test.ts`
- `packages/proxy/src/server-tool-replay-runtime.test.ts`
- `packages/proxy/src/handlers/__tests__/proxy-operations-client-abort.test.ts`
- `packages/database/src/repositories/__tests__/server-tool-replay-issuance.repository.test.ts`
- `.github/workflows/managed-routing-postgres.yml`
- remaining Codex/provider/proxy integration tests listed above
- root `README.md`
- this plan

**Verification**

1. Run focused provider, replay, database, routing-ledger, proxy-operation, guard, abort, and WebSocket tests, explicitly including the natural-continuation and client-abort/cancel regressions.
2. In the existing `.github/workflows/managed-routing-postgres.yml` PostgreSQL job, explicitly run `packages/database/src/repositories/__tests__/server-tool-replay-issuance.repository.test.ts` with `BETTER_CCFLARE_TEST_POSTGRES_URL`; a missing URL or failing PostgreSQL path is a release blocker.
3. Run `bun run lint && bun run typecheck && bun run format` and confirm `git diff --check`.
4. Run the repository's full test suite and build gates required by CI.
5. Run an independent code review against the exact current-main merge base and resolve all P0/P1 findings.
6. Push a focused draft PR without generated-worker or version changes.
7. Merge only after CI/review, update the launch checkout to `refs/heads/main`, and deploy with `scripts/deploy-ccflare.sh`.
8. Verify the existing service is healthy and `/health.git_sha` equals merged main.
9. Observe naturally initiated Claude Code traffic: turn one performs one native hosted search; turn two sends natural `[native-Anthropic]` history, passes request-private authenticated projection, emits `proxy-evidence`, and performs no hosted search unless explicitly requested. Confirm one physical upstream dispatch per inbound request, zero guard replay, valid citations, and a normal terminal without inspecting prompt/result content.

## Acceptance Matrix

| Case | Expected admission | Provider sends | Retry/failover | Client result |
|---|---:|---:|---|---|
| Ordinary request | unchanged | unchanged | unchanged | unchanged |
| Function named `web_search` | ordinary function path | unchanged | unchanged | unchanged |
| Exact fresh `[] -> proxy-evidence` profile in `json`/`streaming` and server-only/mixed modes | admitted | exactly 1 | none after send | native Anthropic server-tool lifecycle |
| Exact natural continuation `[native-Anthropic] -> proxy-evidence` through request-private authenticated projection | admitted | exactly 1 request dispatch; zero new hosted executions unless declared | none after send | evidence-aware continuation |
| Unsupported option/model/endpoint/mode | rejected locally | 0 | 0 | typed routing error |
| Replay key/counter/request lease unavailable | rejected locally for capability-bearing tuple | 0 | 0 | typed routing error |
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
- The exact eight-row fresh/natural-continuation matrix is enforced; `[native-Anthropic]` input is admitted only through request-private authenticated projection and every output replay mode is `proxy-evidence`.
- Every capability bind acquires one exclusive durable 512-slot issuance lease before private replay binding and provider I/O; post-dispatch claims are in-memory, claim 513 fails without a second store call, concurrent requests cannot share or overcommit, and unused slots are never refunded.
- A capability-bearing inbound request can cross exactly one irreversible HTTP or WebSocket send boundary.
- Every existing retry, failover, guard replay, abort, circuit, body-disposal, and WebSocket-rescue path is proven against that boundary, including the natural-continuation and client-abort/cancel regressions.
- `CCFLARE_SERVER_TOOL_WEB_SEARCH` no longer exists; exact capability admission is live automatically in the existing service.
- Ordinary requests have no new database/network work and retain existing behavior.
- SQLite and PostgreSQL parity, focused/full gates, independent review, draft PR, main-only deploy, matching health SHA, and a natural two-turn Claude Code canary are complete.
- No generated worker, `apps/cli/README.md`, version, WebFetch, reverse adapter, pair-canary/proof-control, or synthetic Anthropic/Codex traffic change is present.
