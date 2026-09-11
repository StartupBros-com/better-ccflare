# Spec: OpenAI server-side Responses compaction on the outbound Codex lane

Status: revised draft, gated behind two unresolved PRE-ENABLE GATES (§5, §7).
Read-only research performed on `feat/codex-server-side-compaction` at
`e5602a6b`. No code changed by this document.

## Verdict (revised 2026-09-10, post-research)

**Build, but do not flip `CCFLARE_CODEX_COMPACTION=1` for any real account
until the two PRE-ENABLE GATES below are closed.** This is not a plain
default-off ship-and-forget: default-off protects against *this feature*
misbehaving, not against the possibility that its core mechanism is a no-op.

1. **The subscription-endpoint exclusion is removed.** The prior draft
   excluded `isSubscriptionEndpoint` as a "conservative default." A hard fact
   from the operator's own database makes that exclusion costly, not
   conservative: all three of the operator's Codex accounts resolve to the
   default `chatgpt.com/backend-api/codex` subscription endpoint and carry
   all 357,218 recorded requests — there are no `api.openai.com`-endpoint
   Codex accounts. Keeping the exclusion would have shipped a feature with
   zero eligible real accounts. Source-level research into `openai/codex`
   (detailed in §5) confirms the exclusion was also *factually wrong*:
   remote compaction is a provider-scoped capability, not gated to API-key
   auth — if anything, the newest context-management mechanism in that
   codebase is subscription-*exclusive*. The exclusion is removed; §5 has
   the full reasoning and citations.
2. **That same research surfaced a new, more fundamental, endpoint-agnostic
   blocker this spec did not previously ask about.** The Codex CLI's actual
   compaction implementation does not send a `context_management` /
   `compact_threshold` request field at all — it triggers compaction via a
   special turn-item type inside an ordinary `/responses` POST. This spec's
   entire mechanism (§1–§3) assumes `context_management` /
   `compact_threshold` is a real, effective Responses-API request parameter
   (per the task's original verified-external-facts, presumably OpenAI's
   public Responses-API documentation — a separate surface from the Codex
   CLI's own internal implementation, which this research did not
   re-examine). Whether that literal field does anything at all, on *either*
   endpoint, is now less certain than the auth-mode question this spec
   previously worried about. §5 specifies the exact minimal probe that
   settles it and makes enabling for real traffic explicitly contingent on
   that probe.

Everything else in this spec — the structural interlock on the single
`responseIdOwns` boolean (§4), the `store=false` / ZDR finding (§6), and the
SSE frame-boundary safety (§3.4) — holds regardless of how the two gates
above resolve, and is unchanged.

Scope statement (see §10 for the full non-goals list): this spec covers only
the standard Anthropic-Messages-translated Codex lane used by real Claude
Code sessions (the lane that runs through `handleCodexEvent` /
`processEvents`). It explicitly excludes hosted-search attempts and the
raw Responses-native custom-tool passthrough lane.

## 0. Goal recap

Enable OpenAI's server-side Responses compaction
(`context_management: [{ type: "compaction", compact_threshold: N }]`) on
outbound Codex requests, default-off, so long Claude-Code-via-Codex sessions
get server-side context pruning before inference instead of failing or
silently truncating locally. No benchmarks exist for this feature; treat any
claimed benefit as an unverified hypothesis to be measured (§8), not a given.

## 1. Where `context_management` is attached, and why

**Decision: attach it in `CodexProvider.transformRequestBody`
(`packages/providers/src/providers/codex/provider.ts`), immediately after
`selectCodexResponseIdOwner` resolves `responseIdOwns`
(provider.ts:2855-2862), and before the request is serialized at
`JSON.stringify(codexBody)` (provider.ts:3021`). Do NOT attach it inside
`convertToCodexFormat` (provider.ts:4278).**

Why not `convertToCodexFormat`: that method builds `codexRequest`
(provider.ts:4472-4482, `store` set at 4478-4479) and returns before
`selectCodexResponseIdOwner` has run. It has no way to know whether this
physical attempt will become response-id-owned — that decision happens later,
in the caller, using the very `codexBody` this method returns
(provider.ts:2855). Attaching the field here would force a second,
independently-maintained "did response-id win" check at a different call
site to retroactively delete it — exactly the kind of duplicated guard the
project's own root-cause conventions reject. It would also run for hosted
search (`createAttemptPlan`, provider.ts:2245, which calls
`transformRequestBody(..., { hosted: true })`) and for the custom-tool
Responses-passthrough lane, both explicitly out of scope (§10).

Why the chosen point is correct: at provider.ts:2855-2862, `responseIdOwns`
is already a single boolean, already the sole gate the codebase uses to
decide "does this attempt own continuation." Gating the new field off the
*same* boolean (see §4) makes the two mechanisms mutually exclusive by
construction, not by two independently-written conditionals that could drift
apart. This point also already has `hasCustomTools` (provider.ts:2818-2822),
`options.hosted` (checked inside `selectCodexResponseIdOwner`,
provider.ts:1816-1830), `isSubscriptionEndpoint` (provider.ts:2750, used at
2809-2811 to delete `max_output_tokens`), and `account` all in scope, which
§5's predicate needs. Everything written into `codexBody` up to line 3021 is
what actually goes over the wire, and the same object is also what
`writeCodexTrace` receives at provider.ts:2904 as `codexRequest: codexBody`
(provider.ts:2969) — so tracing the attached field is free (§8), no new
plumbing required.

Mechanically: after computing `responseIdOwns` (2855) and before building
`turnStateDecision` (2878), add one block:

```ts
const compactionDecision = this.selectCodexCompactionDecision({
  responseIdOwns,
  hosted: options.hosted === true,
  customToolsDeclared: hasCustomTools,
  account,
  physicalModel: codexBody.model,
});
if (compactionDecision.attach) {
  codexBody.context_management = [
    { type: "compaction", compact_threshold: compactionDecision.threshold },
  ];
}
```

`selectCodexCompactionDecision` is new, private, pure given its inputs (no
mutation, no I/O) — mirroring the shape of `selectCodexResponseIdOwner`
(provider.ts:1783) but far simpler since it does not need lane state,
digests, or KTD13 byte budgets. See §5 for its exact predicate.

`CodexRequest` (interface at provider.ts:701-730) needs a new optional field:

```ts
context_management?: [{ type: "compaction"; compact_threshold: number }];
```

placed near `previous_response_id?: string;` (provider.ts:729), with a
comment cross-referencing §4's interlock the same way the existing
`previous_response_id` doc comment (provider.ts:725-728) cross-references
KTD6.

## 2. Threshold: value, units, config, and justification

**Units: tokens** (matches OpenAI's `compact_threshold`, and matches the
units of `resolveModelContextCapability`'s `effectiveContextWindow`).

**Mechanism: computed per-request as a percentage of the physical model's
resolved effective context window, not a hardcoded absolute.**

Fork fact: `resolveModelContextCapability("codex", model)`
(`packages/providers/src/request-capabilities.ts:274-304`, re-exported at
provider.ts:48) already resolves, for the exact physical model string this
request will use, `effectiveContextWindow = floor(maxContextWindow *
effectiveContextPercent / 100)`. This is the same value the response path
already uses for the OpenAI example's `compact_threshold: 200000` is a fixed
example value in OpenAI's own guide, tied to whatever context window their
example model has. This fork's own model catalog
(`packages/providers/src/request-capabilities.ts:217-261`) spans from
128,000 (`gpt-5.3-codex-spark`) to 1,000,000 (`gpt-5.4`, effective 950,000)
to 872,000 (`gpt-5.6-sol` / `-terra` / `-luna`, effective 828,400 —
`request-capabilities.ts:247-261`, confirmed against the memory note
"Codex context capacity fix" which cites 872k/828.4k). Copying OpenAI's
200,000 literal would mean compacting a `gpt-5.6-sol` session at ~24% of its
828,400-token effective window — the exact mistake this fork already paid
for once with the invented 372k hard cap that "caused clients to fail large
tool-result turns locally before any request was sent" (issue #205, cited in
`request-capabilities.ts:213-220`). A fixed low threshold would silently
discard most of the reason this fork advertises the larger window at all.

client-facing `context_window_size` telemetry (`extractContextWindow`,
provider.ts:4139-4172, uses `capability.effectiveContextWindow` when the env
var named by `CODEX_EFFECTIVE_CONTEXT_ENV` (provider.ts:623) — whose actual
string value is `CCFLARE_CODEX_EFFECTIVE_CONTEXT`, **not**
`CCFLARE_CODEX_EFFECTIVE_CONTEXT_ENV` (an earlier draft of this spec
conflated the TypeScript constant's name, which carries an `_ENV` suffix by
this file's naming convention, with the string it holds) — is `"1"`, else
`rawContextWindow`. Use
`effectiveContextWindow` for the compaction threshold unconditionally
(independent of that env var, which only controls what number is *reported*
to the client) — `effectiveContextWindow` already bakes in the
`effectiveContextPercent` safety margin the fork uses everywhere else, so
compacting relative to it keeps one consistent notion of "how much of this
model's window is actually usable" across telemetry and behavior.

**Default percentage: 85% of `effectiveContextWindow`, floor of 10,000
tokens, computed and clamped to a non-negative integer.**

Justification: compaction should behave as a late safety net that prunes
context just before the point where the model would otherwise start
rejecting or the fork's own tool-result-size guards would trip, not as a
routine per-turn summarizer that erodes long-context work the fork already
fought to preserve (§ above). 85% leaves real headroom below the ceiling
(e.g. ~704,140 tokens for the 828,400-effective sol/terra/luna family;
~103,360 for the 121,600-effective spark family) while still firing well
before the hard ceiling in the pathological case (a single turn with an
enormous tool result). This number is a starting hypothesis, not a
measured optimum — no benchmarks exist (per the task's verified external
facts) — and §8's A/B is the intended mechanism to tune it. The 10,000-token
floor exists only to avoid a degenerate near-zero threshold if a future
catalog entry has an unusually small `effectiveContextWindow`; it is not
expected to bind in practice given the current catalog's minimum
(121,600 effective for spark).

**Config: two env vars**, following this file's own naming and parsing
conventions (mirroring `CODEX_TURN_STATE_PERCENT_ENV`'s
`strictUnsignedInteger(value, default, min, max)` pattern at
turn-state.ts:235, 281-286):

- `CCFLARE_CODEX_COMPACTION_THRESHOLD_PERCENT` — integer 1-100, default 85.
  Percentage of `effectiveContextWindow` used to compute `compact_threshold`
  for the physical model in play.
- (No separate absolute-token override in v1 — an operator who needs one can
  set the percent to whatever fraction reproduces the number they want for
  a single model family; a second, competing "absolute tokens" knob would
  create two ways to express the same setting and is deferred, §10.)

Residual uncertainty: OpenAI's guide does not state a minimum accepted
`compact_threshold`, nor whether the ChatGPT-backend Codex endpoint
(`chatgpt.com/backend-api/codex/responses`, see §5) enforces the same
bounds as `api.openai.com`. No live traffic was sent to verify this (spec
task constraint). Flag for the implementer: confirm the computed value is
accepted before removing the default-off gate for any real account.

**A second, distinct residual uncertainty: the model-string mismatch.** The
threshold above is derived entirely from this fork's own catalog
(`CODEX_MODEL_CONTEXT_METADATA`), keyed on this fork's own physical model
strings (`gpt-5.6-sol`, `gpt-5.3-codex-spark`, etc.) and this fork's own
`effectiveContextPercent` safety margins. Nothing in this design checks
whether OpenAI's backend independently enforces a *lower* ceiling for the
exact same model string — i.e., whether upstream's own idea of
`gpt-5.6-sol`'s usable window agrees with this fork's 828,400-token
`effectiveContextWindow`, or is smaller. This fork already has a documented
history of its own context-window numbers being invented rather than
upstream-confirmed (issue #205, request-capabilities.ts:213-220 — the
retired 372k hard cap). Computing `compact_threshold` as 85% of a number
this fork asserts, without confirming upstream agrees that number is even
reachable for that model string, risks silently sending a
`compact_threshold` upstream regards as out-of-range or simply caps at its
own (possibly lower) ceiling before the fork's math ever gets to run. This is
a second, independent thing the PRE-ENABLE GATE probe in §5 should check
for the specific model under test: does the compaction item (if any) fire at
the threshold this fork sent, or does the response shape suggest upstream
silently substituted its own bound? No live traffic was sent to verify this.

## 3. Handling the compaction output item on the live streaming path

This is the correctness crux the task calls out. The investigated evidence
below shows the crux is smaller than it first appears **for this fork's
default (non-continuation) lane**, because that lane never maintains a
persistent Responses `input` array across turns to prune in the first
place — but the item still has to be recognized and handled deliberately,
not by accidental fallthrough, and it must never reach
`normalizeReplayItemForDigest`'s recognized set (§4).

### 3.0 Why OpenAI's "append + drop pre-compaction items" pattern does not apply to this lane

OpenAI's stateless-chaining guidance ("append output items including
compaction items to the next input array... drop items that came before the
most recent compaction item") assumes the caller maintains an evolving
Responses `input` array across turns. Fork fact: outside the response-id lane
(interlocked off from compaction, §4), this provider does **not** do that.
`convertToCodexFormat` (provider.ts:4278) rebuilds `input` from scratch on
every request, straight from `body.messages` — the client's (Claude Code's)
own full Anthropic message history, resent every turn exactly like the
ordinary Anthropic Messages API contract. `turn-state.ts` (the fork's other,
unrelated continuation mechanism, used for retry-replay token issuance) does
no `input` truncation at all (confirmed: no `input.slice`/`input =` mutation
anywhere in that file). Only `selectCodexResponseIdOwner`
(provider.ts:1880-1900) ever truncates `codexBody.input`, and only when it
owns the attempt.

Consequence: in the default lane, each request's rendered context is
recomputed fresh from the client's full history every turn. If it crosses
`compact_threshold`, upstream compacts *that one call's* rendered context
before running inference, returns a compaction item describing what it
pruned, and finishes the turn. Ccflare does not need to carry that item
into a "next input array" because there is no persistent input array on this
side to carry it into — next turn, the full (still-uncompacted, growing)
client history is resent and evaluated against the threshold again,
independently. The benefit (if any — unmeasured, §8) is a smaller rendered
context and correspondingly cheaper/faster inference for whichever
individual turns cross the threshold, not a compounding reduction in what
ccflare transmits over the wire.

### 3.1 Recognizing the item

**Residual uncertainty flagged explicitly**: the task's verified-external-facts
block does not give the literal `item.type` string OpenAI's Responses API
uses for a compaction output item. This spec assumes `"compaction"` (matching
OpenAI's own terminology for the feature, and matching the pattern of every
other Responses output item type already handled in this file — `"message"`,
`"function_call"`, `"reasoning"`). **Verify this literal against a real
captured trace or OpenAI's schema before merging** (see §9's first proof-first
test). If it differs, every reference to `"compaction"` below in code
(`itemType === "compaction"`) needs the corrected literal; the surrounding
design does not change.

### 3.2 What already happens today, unmodified (evidence, not a plan)

- `codexEventCommitsOutput` (provider.ts:1097-1115) only returns `true` for
  `response.output_item.added` when `item.type === "function_call"`
  (provider.ts:1103-1105). A compaction item hits the `default: return false`
  branch (provider.ts:1113-1114). So `response.output_item.added` for a
  compaction item today already does **not** trigger `ensureMessageStart()`
  or open any Anthropic content block — it is inert at that event.
- `response.output_item.done` (provider.ts:5778) branches on `itemType ===
  "function_call"` (5793) and `itemType === "reasoning"` (5884, with a nested
  encrypted-retention check). Neither matches `"compaction"`, so today it
  falls through to the final generic block (provider.ts:5941-5972): close any
  open content block, flush any pending reasoning blocks. **Moved to the
  explicit uncertainty list, not stated as fact:** the claim that this
  fallthrough is *harmless* today rests entirely on an unverified assumption
  about OpenAI's SSE event ordering — that a compaction output item is
  always emitted before any content block opens in the same stream. This
  spec has no captured trace confirming that ordering; it is inferred from
  the task's verified external fact describing compaction conceptually, not
  from an observed event sequence. If that ordering assumption is wrong —
  e.g. a compaction item arrives *after* a content block has already opened,
  or interleaved mid-stream — this same generic block would incorrectly
  close that open content block and flush `pendingReasoningBlocks` as a side
  effect of an unrelated item's completion, which is a real correctness bug,
  not a no-op. §3.3's explicit branch below does not have this problem: it
  runs *before* the fallthrough can ever execute for a compaction item and
  is robust regardless of where in the stream the item arrives, precisely
  because it never reaches the ordering-dependent generic code at all. Any
  test premise of "this already passes today" (§9 test 4) is therefore only
  true under the unverified ordering assumption, not a settled fact — stated
  plainly there.
- `response.completed` (provider.ts:6037) captures `resp.output` verbatim
  into `state.responseIdTerminal.output` (provider.ts:6079-6086) **only when
  a response-id checkpoint is pending for this attempt** — i.e. only on the
  response-id lane, which is interlocked off from compaction (§4). On the
  default lane, `resp.output`'s compaction item is not captured or stored
  anywhere beyond the event stream.
- `normalizeReplayItemForDigest` (provider.ts:1311-1391) / `replayItemDigest`
  (provider.ts:1393-1399) — the function that decides whether an output item
  is "recognized" for response-id replay bookkeeping — has no branch for a
  compaction item type. `digestReplayItems` (provider.ts:1402-1413) fails
  closed (returns `null`) the instant any item fails to normalize.
  `commitCodexResponseIdCheckpoint` (provider.ts:1988) treats a `null` result
  from `digestReplayItems(terminal.output)` as "Fail closed: an unrecognized
  output item type disqualifies this checkpoint" (provider.ts:2013-2019) and
  discards the candidate without corrupting the lane. **This is real,
  already-existing defense in depth for the one scenario where a compaction
  item could reach the response-id bookkeeping path (§4's "what if both are
  enabled anyway" case) — do not weaken it (§4, §10).**

### 3.3 What to add (deliberate, not fallthrough)

Add an explicit branch in `response.output_item.done` (provider.ts:5778),
checked before the `function_call`/`reasoning` branches so it can never be
shadowed by a future edit to those:

```ts
if (itemType === "compaction") {
  state.traceCompactionOutputItemCount++;
  break;
}
```

This does three things: (1) makes "ignore this item type on the client-facing
stream" a designed decision instead of an accidental shared fallthrough, so
a later change to the generic close-block logic at the bottom of the switch
cannot retroactively start misbehaving for compaction items; (2) captures a
lightweight, content-free counter for §8's measurement (mirrors
`traceReasoningOutputItemCount`, provider.ts:963, 4870, 5784 exactly); (3)
`break`s before the generic block, so no double-processing. Do **not**
capture the item's actual pruned-content payload into trace or state — it is
large, may contain prompt/tool-result content, and nothing in this design
needs it (the default lane never replays it, §3.0).

`response.output_item.added` needs no new code: the existing
`codexEventCommitsOutput` default-false behavior (§3.2) is already the
correct, designed behavior for an item type that must never open a content
block. Leave it as-is; a future engineer reading `codexEventCommitsOutput`'s
own doc comment (provider.ts:1080-1095, "Scope: only those four decision
points are covered") will already understand why compaction isn't listed
there.

`StreamState` (the interface holding `traceReasoningOutputItemCount` etc.,
provider.ts:963-964) gets one new field, initialized alongside the reasoning
counters at provider.ts:4870-4871:

```ts
traceCompactionOutputItemCount: number; // init: 0
```

Wire it into `summarizeCodexResponse`'s trace payload
(`packages/providers/src/providers/codex/trace.ts:380-441`) as
`compaction_output_item_count`, following exactly the precedent of
`reasoning_output_item_count` (trace.ts:410-411) — same file, same function,
same call site (provider.ts:1072-1074 passes the reasoning fields; add the
compaction count alongside).

### 3.4 Mid-stream arrival, split-across-SSE-frames, and terminal-adjacent arrival

- **Mid-stream**: handled by definition — the compaction item arrives as an
  ordinary `response.output_item.added` / `response.output_item.done` pair
  like any other output item, processed by `handleCodexEvent`
  (provider.ts:5560) in the same per-event loop as everything else. No
  special-casing needed beyond §3.3.
- **Split across SSE frames**: cannot happen at the `handleCodexEvent`
  boundary. `SseFrameBuffer.push()`
  (`packages/core/src/sse-frame-buffer.ts`) only ever yields *complete*
  frames, delimited by the blank-line `FRAME_DELIMITER` regex
  (sse-frame-buffer.ts:14); a frame straddling a TCP/read-chunk boundary is
  buffered internally and never handed to a caller until it is whole
  (provider.ts:5166-5169's own comment: "Frame boundary detection and cap
  enforcement live in SseFrameBuffer"). `findCodexSseFrameLines`
  (provider.ts:575) then extracts the `event:`/`data:` lines from one
  complete frame and `JSON.parse(dataStr)` (provider.ts:5212) parses one
  complete JSON object. This guarantee is identical for every event type
  already handled (`response.completed`, `response.output_item.done`,
  etc.) — compaction introduces no new risk here. One pre-existing,
  compaction-unrelated fragility is worth naming for awareness, not fixing
  here (§10): `findCodexSseFrameLines` takes only the *first* line starting
  with `data:` (provider.ts:601), so a hypothetical multi-line SSE `data:`
  payload (legal per the SSE spec, not currently observed from this
  provider) would silently mis-parse for *any* event type, not specifically
  compaction. Out of scope.
- **Alongside a terminal event in the same read chunk**: if a compaction
  item's `response.output_item.done` and the turn's `response.completed`
  land in the same `reader.read()` chunk, `SseFrameBuffer.push()` returns
  both as separate frames in one `frames` array, and the existing loop
  (provider.ts:5169-5217) calls `handleCodexEvent` once per frame, in order,
  synchronously. The compaction branch (§3.3) runs and returns before
  `response.completed` is processed; no interaction. This is the same
  ordering guarantee every other pre-terminal event already relies on.

### 3.5 Interaction with the tail validator and clean-EOF checkpoint promotion — must not weaken

`runCodexResponseIdTailValidator` (provider.ts:2098) and
`commitCodexResponseIdCheckpoint` (provider.ts:1988) only ever run for a
response-id-owned attempt (`handoffEligible` requires
`this.pendingResponseIdByAttempt.has(handoffAttemptId)`, provider.ts:5228-5232,
which is only populated when `selectCodexResponseIdOwner` returned `true`,
provider.ts:1900-1904). §4's hard interlock means a compaction-enabled
attempt is *never* response-id-owned, so the tail validator's contract
("exactly one valid completed response... no other data-bearing frame") is
never exercised against a compaction item in the first place — there is
nothing to weaken because the two code paths are structurally disjoint per
attempt. §3.2's already-existing fail-closed behavior in
`commitCodexResponseIdCheckpoint` (discard on unrecognized item type) is
kept as-is, untouched, as a second line of defense in case the interlock
itself is ever violated by a future bug (§4, §10 — do not "improve" this by
teaching `normalizeReplayItemForDigest` to recognize `"compaction"`; that
would remove the fail-safe exactly where it matters most).

## 4. Hard interlock with `previous_response_id` continuation

**Rule: a single physical attempt may have compaction attached
(`context_management`) OR be response-id-owned (`previous_response_id` +
truncated `input`), never both. Response-id wins when eligible.**

Why response-id wins rather than compaction: response-id ownership already
carries its own multi-stage commit protocol (KTD6/KTD7/KTD13 — lane
matching, KTD13 byte budgets, the tail validator) that assumes exclusive
control over what "the next request's input" means. Compaction's benefit is
speculative and unmeasured (per the task's verified facts); response-id's
mechanism is already-shipped, tested infrastructure with real invariants.
Deferring to the already-invested mechanism is the smaller-blast-radius
choice, and it matches the plain reading of OpenAI's own hard rule: "If you
use previous_response_id chaining, do not manually prune" — since attaching
`context_management` to a `previous_response_id`-chained request is
precisely a form of asking upstream to prune under chaining, which the API
contract forbids attempting to combine with our own truncation.

**Structural enforcement (not convention):** implemented as described in
§1 — `selectCodexCompactionDecision` takes `responseIdOwns` (the exact
boolean already computed at provider.ts:2855, before either the compaction
attach block or `turnStateDecision` reads it) as one of its required
parameters, and its predicate short-circuits to "do not attach" when
`responseIdOwns === true`, with no independent env-var/config check capable
of overriding that branch. There is exactly one boolean produced by exactly
one call (`selectCodexResponseIdOwner`, provider.ts:1783) that both the
existing response-id gate and the new compaction gate read — not two
separately-maintained conditions that happen to agree today. Concretely:

```ts
private selectCodexCompactionDecision(params: {
  responseIdOwns: boolean;
  hosted: boolean;
  customToolsDeclared: boolean;
  account: Account | undefined;
  physicalModel: string;
}): { attach: false } | { attach: true; threshold: number } {
  if (params.responseIdOwns) return { attach: false }; // hard interlock
  // ...remaining predicate, see §5
}
```

**Operator enables both flags simultaneously**: nothing bad happens, by
design. `CCFLARE_CODEX_MESSAGES_CONTINUATION=1` (provider.ts:1186) and
`CCFLARE_CODEX_COMPACTION=1` (§5) can both be `"1"` in the environment at the
same time; per-attempt, `responseIdOwns` is still resolved first
(provider.ts:2855) and is still the single source of truth the compaction
gate reads. On any attempt where response-id *does* win ownership
(non-hosted, non-custom-tools, matching lane, etc. — the existing
eligibility check at provider.ts:1816-1830), compaction is silently not
attached for that attempt. There is no operator-visible error or rejected
combination to design for — "both enabled" degrades to "response-id wins,
compaction is a no-op for that attempt," which is the same outcome as if the
operator had left compaction disabled for accounts on that lane. Document
this behavior in the env var's own comment (mirroring the doc-comment style
at provider.ts:1179-1195) so it is not rediscovered as a bug report.

**Defense in depth if the interlock itself is ever buggy**: §3.2/§3.5's
already-existing fail-closed behavior in `commitCodexResponseIdCheckpoint`
(discard checkpoint on unrecognized output item type, provider.ts:2013-2019)
means that even in a hypothetical future where the interlock above is broken
by a careless edit and a response-id-owned attempt somehow also requested
compaction, the resulting compaction item in `resp.output` would still fail
`normalizeReplayItemForDigest` and cause the checkpoint to be discarded
rather than silently corrupt or leak pruned context into a replay. This is a
backstop, not a substitute for the structural gate above — do not rely on it
as the primary mechanism (§10).

## 5. Default-off gating: env var and exact predicate

**Env var:** `CCFLARE_CODEX_COMPACTION` (master switch, exact string `"1"`
to enable — mirrors `CCFLARE_CODEX_MESSAGES_CONTINUATION`'s exact-`"1"`
convention at provider.ts:1179-1185). Unset or any other value: disabled.

**Optional scoping env vars** (both default unset; when unset, see the
per-var default note — deliberately *not* symmetric with each other, because
the two carry different risk profiles):

- `CCFLARE_CODEX_COMPACTION_MODELS` — comma-separated allowlist of physical
  Codex model ids. **Default when unset: no model is admitted** (differs
  deliberately from `CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS_ENV`'s
  "unset = all models," provider.ts:1188-1194). Justification: this fork
  already knows the messages-continuation feature works across its model
  catalog (it shipped and is exercised). Compaction's request shape itself is
  now the open question (the PRE-ENABLE GATE below) — not "does the
  subscription endpoint support it" (resolved, see below) but "does the
  literal `context_management`/`compact_threshold` field this spec sends do
  anything at all, on either endpoint, for this model." Requiring an
  explicit model allowlist means an operator must deliberately name a model
  only after that gate is closed for it, rather than the flag silently
  fanning out to every model the moment it is flipped on.
- `CCFLARE_CODEX_COMPACTION_ACCOUNT_IDS` — comma-separated allowlist of
  account ids. Default unset: no account-level restriction beyond the other
  gates. Primary purpose is §8's single-account A/B (set this to exactly one
  account id under test), following the existing pattern at
  `CODEX_TURN_STATE_ACCOUNT_IDS_ENV` (turn-state.ts:4, consumed via
  `readCsvSet`, turn-state.ts:256-263).

**Exact predicate** (all must hold):

```
attach = CCFLARE_CODEX_COMPACTION === "1"
  && !responseIdOwns                                  // §4 hard interlock
  && !hosted                                           // hosted search: different response shape, untested
  && !hasCustomTools                                   // raw Responses passthrough lane: out of scope, §10
  && isOpenAiPromptCacheEndpoint(account)              // genuine OpenAI/ChatGPT infra only -- includes the subscription endpoint, see below
  && CCFLARE_CODEX_COMPACTION_MODELS names physicalModel
  && (CCFLARE_CODEX_COMPACTION_ACCOUNT_IDS unset OR names account.id)
```

Notes on each conjunct beyond the ones already justified above:

- `!hosted`: mirrors `selectCodexResponseIdOwner`'s own `hosted` exclusion
  (provider.ts:1816-1830) for the identical reason —
  `createCodexHostedSearchAttemptPlan` (provider.ts:2250) is a distinct
  response-handling path (`processCodexHostedSearchResponse`) that this spec
  did not audit and that OpenAI's compaction guide does not address.
- `!hasCustomTools`: requests with a declared custom (non-function) tool
  take the raw Responses passthrough branch
  (`buildCustomToolCallPassthroughResponse`, referenced in
  `selectCodexResponseIdOwner`'s own doc comment, provider.ts:1822-1826) and
  never run `processEvents`/`handleCodexEvent` at all — so none of §3's
  handling would ever execute for such a request, and any compaction item
  would be forwarded completely raw to whatever client declared that custom
  tool (a Responses-native client, per the "Responses Lite" comment at
  provider.ts:4488-4491). That may well be *correct* behavior for that
  client (it already speaks native Responses format), but it is untested and
  explicitly deferred (§10) rather than accidentally included.

**`isSubscriptionEndpoint` is deliberately NOT a conjunct here (revised
2026-09-10, was in an earlier draft).** An earlier draft excluded the
ChatGPT-subscription endpoint (`chatgpt.com/backend-api/codex`,
`CODEX_DEFAULT_ENDPOINT` at provider.ts:174-176 — the *default* endpoint for
this fork's Codex accounts, not `api.openai.com`) as a "conservative
default," reasoning from this fork's own `max_output_tokens` precedent
(provider.ts:2809-2811: that field is deleted unconditionally for
`isSubscriptionEndpoint` because the subscription backend is known to reject
it). **This was backwards, and a hard fact from the operator's own database
shows the cost of getting it backwards: all three of the operator's Codex
accounts resolve to the default subscription endpoint and carry all 357,218
recorded requests — there are no `api.openai.com`-endpoint Codex accounts.
Keeping the exclusion would have shipped a feature with zero eligible real
accounts.**

Source-level research into `openai/codex` (the reference Codex CLI — the
only other real client of this backend) settles the auth-mode question
directly, independent of the `max_output_tokens` precedent:
`ConfiguredModelProvider::capabilities()` sets `remote_compaction =
RemoteCompactionSupport::V2` when `self.info.is_openai()`
(codex-rs/model-provider/src/provider.rs:354), and `is_openai()` checks
provider *name* (`self.name == "openai"`,
codex-rs/model-provider-info/src/lib.rs:546) — not auth mode, not base URL.
The one built-in `"openai"` provider backs both ChatGPT-subscription and
API-key auth in that client; `to_api_provider()` only changes which
`base_url` it resolves to (`CHATGPT_CODEX_BASE_URL` for
`Chatgpt`/`ChatgptAuthTokens` auth modes, `api.openai.com/v1` otherwise —
codex-rs/model-provider-info/src/lib.rs:369-382). `remote_compaction = V2`
therefore applies identically to both, so remote compaction is not an
API-key-only capability. The even newer `[features.context_management]
experimental_mode` mechanism in that same codebase goes further:
`experimental_context_is_eligible`
(codex-rs/core/src/session/token_budget.rs:12-18) requires
`auth.auth_mode() == AuthMode::Chatgpt` with a paid plan type and fails
outright under plain API-key auth — that feature is subscription-
**exclusive**, the opposite gating direction from what the removed
exclusion assumed. Given the `max_output_tokens` precedent and this new
evidence point in opposite directions, and given the reference client
treats subscription auth as no less capable, the auth-mode question is
settled: nothing supports singling out the subscription endpoint here.
Removing the exclusion is what makes this feature reachable for real
traffic at all — it corrects a predicate that was guessing wrong, not a
speculative loosening of a still-open question.

**PRE-ENABLE GATE — request-shape verification (new; supersedes the removed
exclusion as the actual blocker; §7 has a second, independent gate for
rejection-classifier strings).** The same research that settles the
auth-mode question above also surfaced a sharper, endpoint-agnostic problem
this spec did not previously ask. Grepping the Codex CLI's own compaction
implementation for `context_management` and `compact_threshold` returns
**no matches as outbound wire fields** — those two names exist in that
codebase only as Rust-side feature-flag/config identifiers. The reference
client instead triggers remote compaction by sending a
`TurnItem::ContextCompaction` (`ContextCompactionItem`) as an ordinary item
inside an ordinary `/responses` POST (codex-rs/core/src/compact_remote_v2.rs)
— not by attaching a `context_management: [{ type: "compaction",
compact_threshold: N }]` field to the request body the way §0/§1 of this
spec assume. This spec's assumption traces to a separate source (the task's
original verified-external-facts, presumably OpenAI's public Responses-API
documentation for general API callers, distinct from the Codex CLI's own
internal implementation) that this research did not re-examine. **Net
effect: whether the literal field this spec sends does anything at all — on
`chatgpt.com` OR `api.openai.com` — is now a materially less certain
question than "is it gated to subscription auth," which is what this spec
previously worried about.**

Do not flip `CCFLARE_CODEX_COMPACTION=1` for any real account, subscription
or API-key, before this gate is closed. **Minimal probe (risk assessed):**
one manually-issued (not scripted-in-a-loop) request to a non-Anthropic
Codex account, force-routed with the `x-better-ccflare-account-id` header
(the pattern this file's own "Testing OpenRouter" section already sanctions
for non-Anthropic accounts — a Codex/ChatGPT account is not
Anthropic-backed, so this does not fall under AGENTS.md's restriction on
scripted traffic to `claude` accounts), carrying `context_management: [{
type: "compaction", compact_threshold: <a value comfortably below the
conversation's actual token count, e.g. a few thousand> }]` plus enough
input to exceed it, then inspecting the raw response/stream for either a
compaction-shaped output item or an explicit rejection naming the field.
Cost/risk: a Codex subscription is flat-rate (unlike token-billed API-key
usage), so a single probe request carries no material dollar cost; it is
one request, not a harness, and never touches an Anthropic-backed account.
Until this probe (or equivalent confirmation from OpenAI's own
Responses-API documentation of the exact parameter name and its acceptance
on both endpoint families) is run, treat §2's `compact_threshold`
computation, §3's item-recognition code, and this section's allowlist
gating as correctly designed *contingent on* a request field that has not
yet been shown to exist on the wire.

- `isOpenAiPromptCacheEndpoint(account)` (existing helper, provider.ts:408-
  416, checks the resolved endpoint's hostname against
  `OPENAI_PROMPT_CACHE_HOSTS = {"chatgpt.com", "api.openai.com"}`,
  provider.ts:178): reused verbatim rather than re-implemented, matching the
  same prudence this fork already applies (only apply OpenAI-specific
  request shaping to genuine OpenAI/ChatGPT hosts, never to a
  self-hosted/compatible custom endpoint). This is now the *only* endpoint
  gate — it correctly admits the subscription endpoint alongside
  `api.openai.com`, per the auth-mode finding above.

## 6. `store` and ZDR

Fork fact: `store` is set unconditionally at provider.ts:4478-4479:
`store: typeof passthrough?.store === "boolean" ? passthrough.store : false`.
`passthrough` (`__better_ccflare_codex_passthrough`) is populated only by the
Responses-native adapter (`openai-responses-adapter`), server-verified per
the doc comment at provider.ts:1147-1158, and is `undefined` for an ordinary
Claude-Code-via-Anthropic-Messages request — i.e. for the exact lane this
spec targets (§0's goal). **Today, for the target lane, `store` is always
`false`.** This is already ZDR-friendly per the task's verified external
fact ("ZDR-friendly when store=false").

**Decision: do not change `store` for this feature.** Compaction does not
require `store: true` — OpenAI's guide describes it working with stateless,
non-stored requests (that is precisely the "stateless input-array chaining"
pattern quoted in the task). The only lane where `store` can be `true` today
is the Responses-native passthrough lane, driven entirely by the client's
own explicit `store` value, not by this provider's own choice — and that
lane is out of scope (§5, §10). Changing the default `store` value is
exactly the kind of change the task explicitly flags as "its own blast
radius" and this spec deliberately does not touch it; leaving it alone also
respects the global convention against narrowing or expanding existing
behavior as an unrequested side effect.

## 7. Failure modes

1. **Upstream rejects `context_management`** (e.g. a 400 naming the param,
   or the ChatGPT backend's known pattern of rejecting API-only Responses
   fields — precedent: `max_output_tokens`, provider.ts:2809-2811). No
   existing generic "retry any 400" mechanism exists in this codebase for
   request-shape errors; the established idiom (confirmed by reading
   `packages/proxy/src/handlers/proxy-operations.ts:1723-1765`,
   `isCodexReasoningVerificationError`, and its consumer at
   proxy-operations.ts:5061-5089) is a dedicated, narrow classifier
   function per known rejection shape, which on match strips the offending
   field and retries the same physical route exactly once with a stamped
   attempt cause (`stampCodexAttempt`, proxy-operations.ts:5086; compare
   `"reasoning_retry"`). **Decision: add
   `isCodexCompactionRejectionError(response, readJson)` mirroring that
   exact shape** (400 status; tolerate a missing `content-type`, per the
   comment at proxy-operations.ts:1728-1729 noting "The Codex backend
   routinely answers without one"; match on `error.param ===
   "context_management"` with `error.type === "invalid_request_error"`, or
   an `error.code` naming the field — **the exact match strings are
   unverified, no real rejection body was observed**).

   **PRE-ENABLE GATE, not a post-merge discovery item: these match strings
   MUST be corrected against a captured real error body before this feature
   is enabled for any real account, exactly like §5's request-shape gate.**
   `isCodexReasoningVerificationError`'s own comment records the actual
   failure mode of guessing here: the 2026-08-11 live-wire capture that
   shaped its match strings found no `content-type` header at all on the
   rejection body, which would have silently defeated a copied
   `includes("application/json")` gate and left the conversation wedged. A
   classifier written from documentation guesses, never checked against a
   captured real rejection, is exactly that failure mode waiting to repeat.
   **Until a real rejection body is captured and the match strings above are
   corrected against it, a real upstream rejection of `context_management`
   fails the request outright — no retry, no suppression, no cooldown.** The
   classifier and the cooldown map below are aspirational until that
   capture happens; ship the default-off flag and this failure-mode design,
   but do not treat the classifier as trustworthy in production before its
   match strings are verified.

   On match: mark the account (not just this attempt) as
   compaction-rejected for a cooldown TTL (new
   `compactionRejectedAccounts: Map<accountId, expiresAt>` on `CodexProvider`,
   mirroring `responseIdRejectedLanes` (provider.ts:1541) and
   `CODEX_RESPONSE_ID_REJECTED_TTL_MS` (provider.ts:1233)), consulted by
   §5's predicate, and retry the current attempt once without the field. Do
   **not** fail over to a different account for this error class — a 400
   about the request shape will reproduce identically on any account, per
   the existing convention visible throughout `proxy-operations.ts`'s other
   `response.status !== 400` classifiers (none of which trigger
   cross-account failover).
2. **Threshold never reached** (short session, or a model whose
   `effectiveContextWindow` is large relative to the conversation): no
   observable behavior change — `context_management` is present on the wire
   but inert. This is the expected common case and needs no special
   handling; §9's tests should include one proving this explicitly (the
   field is sent, no compaction item appears, output is byte-identical to
   the no-flag case).
3. **A compaction item arrives when compaction was not requested for this
   attempt** (e.g. upstream applies it unprompted, or a bug lets it leak
   through the interlock): §3.3's handling in `response.output_item.done` is
   **unconditional** — it does not check whether `context_management` was
   sent on this attempt. This is a deliberate design choice (stated
   explicitly, not left implicit): the receiving side must tolerate a
   compaction item regardless of what this specific request asked for,
   since upstream's actual behavior is not something this fork fully
   controls or has verified. "Default-off" describes what we *send*, not
   what we're willing to *receive*.
4. **A compaction item arrives on a response-id-owned (non-compaction)
   attempt** — covered in depth by §3.2/§3.5/§4's defense-in-depth: the item
   fails `normalizeReplayItemForDigest`, `commitCodexResponseIdCheckpoint`
   discards the checkpoint (fail-closed, provider.ts:2013-2019), and the
   lane falls back to a cold send on the next request. No corruption, only a
   missed cache-continuation opportunity for that one lane/generation — an
   acceptable, already-existing degradation mode, not a new one introduced
   by this feature.
5. **Interaction with rejected-id repair (Behavior 2,
   `isCodexResponseIdRejectionError`, provider.ts:1462) and retry/failover**:
   disjoint by construction. Rejected-id repair only ever runs on a
   response-id-owned attempt (`prepareCodexResponseIdRejectionRepair`,
   provider.ts:1939, checks `owner.owner !== "response-id"` and bails
   otherwise, 1944). §4's interlock guarantees a compaction-enabled attempt
   is never response-id-owned. The two repair paths (failure mode 1 above,
   and the existing rejected-id repair) can both exist in the codebase
   without ever firing for the same attempt.

## 8. Measurement plan (single-account A/B)

**Setup**: set `CCFLARE_CODEX_COMPACTION=1`,
`CCFLARE_CODEX_COMPACTION_MODELS=<model under test>`,
`CCFLARE_CODEX_COMPACTION_ACCOUNT_IDS=<one account id>` for the treatment
account; leave an otherwise-comparable account (same model, same usage
pattern) as control with the flag off. Requires no code beyond this spec's
implementation — every signal below already exists.

**Primary signal: `requests` table, existing columns** (schema:
`packages/database/src/migrations.ts:423-459` — `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`model`, `account_used`, `client_session_id`, `timestamp`,
`response_time_ms`; already indexed on `(timestamp DESC, account_used)`,
migrations.ts:476-478).

**No session-pairing mechanism exists in this codebase, and "matched by
conversation length" is not a real methodology — corrected here rather than
left as a fallback clause.** `client_session_id` is populated verbatim from
`requestBodyContext.getClientId()` (`packages/proxy/src/request-body-context.ts:88-97`),
which reads `metadata.user_id` out of the client's own request body — it is
Claude Code's own client-generated identifier for one real conversation, not
a value ccflare mints, controls, or can "pin" across two different backend
accounts. A single real Claude Code session is handled by exactly one
account for its lifetime (force-routing changes which account handles a
*request*, not which account "owns" an ongoing session), so the treatment
account and the control account necessarily see two genuinely different
real conversations with two different `client_session_id` values — there is
no shared key to join "this treatment session" to "its equivalent control
session," pinned or otherwise. The only way to get a literal apples-to-apples
pair would be a scripted, byte-identical conversation replayed once per
account, which this spec's own constraints (and AGENTS.md's general
skepticism of synthetic traffic standing in for real usage) argue against
building as new harness infrastructure for a single measurement.

**Revised methodology: aggregate by `turn_no`, not by session identity.**
Run the per-session query below separately for every session on each
account over the measurement window, normalize each session's turns to
`turn_no` (1, 2, 3, ...), then compare the treatment account's
`turn_no`-keyed average `input_tokens` curve against the control account's,
across as many sessions as the window provides. This trades exact pairing
for statistical power: it needs more sessions to see a clear signal (no
single-session proof), but it uses a real, already-existing column
(`turn_no` is derived, not stored) instead of a session-identity match that
cannot occur across accounts. State this explicitly in whatever writes up
the A/B result — an aggregate divergence is suggestive, not a controlled
paired comparison, and should be reported as such.

```sql
SELECT
  timestamp,
  ROW_NUMBER() OVER (PARTITION BY client_session_id ORDER BY timestamp) AS turn_no,
  input_tokens,
  cache_read_input_tokens,
  output_tokens,
  response_time_ms
FROM requests
WHERE account_used = ?
  AND model = ?
ORDER BY client_session_id, timestamp;
```

(Run once per account — treatment and control — then aggregate the result by
`turn_no` client-side, e.g. mean/median `input_tokens` per `turn_no` across
all sessions in the window, rather than filtering to one `client_session_id`
as an earlier draft of this query did.)

**What a win looks like**: on the treatment account, once a `turn_no`
cohort's average cumulative conversation size would cross
`compact_threshold`, the average `input_tokens` for that `turn_no` and later
should show a visible **drop or plateau** relative to the control account's
monotonically-growing curve at the same `turn_no` — i.e. the treatment curve
stops tracking the control curve's growth at the threshold crossing.
`response_time_ms` may show a mixed signal (a one-time compaction-pass cost
on the triggering turn, offset by less inference work on that and later
turns) — report the delta, do not assume it's net positive without
measuring.

**What would falsify it**: `input_tokens` on the treatment account continues
growing at the same rate as control past the point where the conversation
should have crossed `compact_threshold` (compaction not actually firing —
check `compaction_output_item_count` in the trace, §3.3, to distinguish
"never crossed threshold" from "crossed but had no measurable token effect"
from "flag didn't take effect at all," e.g. account not in
`CCFLARE_CODEX_COMPACTION_ACCOUNT_IDS`); or `response_time_ms` regresses
sharply with no offsetting `input_tokens` benefit (compaction overhead
without payoff).

**Secondary signal: `CCFLARE_CODEX_TRACE_DIR` JSONL trace** (opt-in,
`packages/providers/src/providers/codex/trace.ts:15,42` — "summaries only,
no prompt content" per its own doc comment). Once §3.3 is implemented,
`compaction_output_item_count` (new field) appears per-response alongside
existing fields (`requestId`, `attemptId`, `sessionKeyHash`, `input_tokens`
equivalents via `summary`, per `writeCodexResponseTrace`'s existing shape,
trace.ts:574 and provider.ts:1039-1074). This gives an exact
per-turn "did compaction fire on this specific response" boolean/count to
correlate against the `requests` table's token deltas above without
guessing from token curves alone.

**Known measurement caveats** (from project memory, apply here unchanged):
`cost_usd` is unreliable for streaming/free/unpriced models (memory:
"ccflare split cost-recording paths") — use `input_tokens`/`output_tokens`
directly, not `cost_usd`, for this A/B. Cache-hit-rate formulas are easy to
compute two incompatible ways (memory: "cache hit rate two incompatible
formulas") — this A/B does not require a cache-hit computation, so it is
avoidable; if computed anyway, cite which formula.

## 9. Proof-first test list

Each entry: what must be RED (fail, or observably wrong) before the fix, and
what turns it GREEN. All are unit/integration tests against the existing
`provider.test.ts` / dedicated `provider.*.test.ts` file conventions already
used in this directory (e.g. `provider.tail-validator.test.ts`,
`provider.response-id-rejection-repair.test.ts`) — no live provider traffic
per this task's constraints, and per AGENTS.md's testing restrictions for
any future scripted verification against a real account.

1. **Field attaches at threshold-relative default.** RED: `codexRequest`
   built via `convertToCodexFormat`/`transformRequestBody` for a
   `CCFLARE_CODEX_COMPACTION=1`-enabled, allowlisted model/account never has
   `context_management` (field doesn't exist pre-implementation). GREEN:
   present with `compact_threshold` equal to `floor(effectiveContextWindow *
   85 / 100)` for the physical model in play (assert against
   `resolveModelContextCapability` output directly, not a hardcoded number,
   so the test survives catalog changes).
2. **Default-off.** RED/GREEN is trivial pre- and post-implementation with
   the env var unset: `context_management` must never appear. Include as a
   regression guard, not just a smoke test.
3. **Hard interlock: response-id owns, compaction requested.** Construct an
   attempt eligible for response-id ownership (matching lane, prior
   checkpoint present) with `CCFLARE_CODEX_COMPACTION=1` and a matching
   model/account allowlist. RED (pre-fix, if the interlock were naively
   implemented as two independent conditionals that could both pass):
   `context_management` present AND `previous_response_id` present on the
   same request. GREEN: `previous_response_id` present, `context_management`
   absent — assert both on the *same* serialized body.
4. **Compaction item does not open a content block.** Feed a synthetic SSE
   stream through `processEvents`/`handleCodexEvent` containing
   `response.output_item.added` with `item.type: "compaction"` followed by
   `response.output_item.done` for the same item, then real assistant
   output. Run this test **both before and after §3.3's explicit branch
   exists**, not just after: before the branch exists, it exercises the
   generic fallthrough (§3.2) and its result is only correct *if* the
   unverified event-ordering assumption holds for this synthetic stream —
   passing here is not proof the fallthrough is safe against a differently-
   ordered real stream, only that it's safe against the ordering this test
   assumes. After §3.3's branch exists, the same assertions hold
   unconditionally, because the explicit branch never reaches the
   ordering-dependent generic code at all. Assert no
   `content_block_start`/`content_block_stop` pair is emitted for the
   compaction item, and the subsequent real content block still gets the
   correct index (no index gap or collision), in both runs.
5. **Compaction item is counted, not content-leaked.** Same synthetic
   stream as (4). GREEN only after §3.3's explicit branch exists: assert
   `state.traceCompactionOutputItemCount === 1` and that no trace field
   contains the compaction item's actual payload text.
6. **Compaction item never disqualifies a non-response-id attempt.** Same
   synthetic stream as (4), on a turn-state-owned or unowned attempt: assert
   the response still completes normally (stop_reason set, terminal SSE
   events sent) — proves §3's handling doesn't accidentally trip any
   existing terminal-event or content-block invariant.
7. **Compaction item on a response-id-owned attempt still fails closed.**
   Synthetic `response.completed` with `resp.output` containing a
   `"compaction"`-typed item, on an attempt that HAS a pending response-id
   candidate (simulating the "interlock somehow bypassed" scenario). RED
   (would be a bug if ever introduced): checkpoint gets committed with the
   compaction item silently absorbed into `digests`. GREEN (current +
   unchanged behavior, locked in by this test): checkpoint is discarded
   (`commitCodexResponseIdCheckpoint` returns without setting `laneEntry.state`),
   matching provider.ts:2013-2019's existing fail-closed branch — this test
   should pass without any code change; write it now specifically so a
   future change to `normalizeReplayItemForDigest` that adds a
   `"compaction"` case (§4/§10's explicit non-goal) would break it loudly.
8. **Rejection repair strips the field and retries once.** Synthetic 400
   response shaped per §7 item 1's classifier match. RED (pre-fix): request
   fails outright, no retry. GREEN: exactly one retry on the same account
   without `context_management`, and `compactionRejectedAccounts` records a
   cooldown entry preventing re-attachment within the TTL on a subsequent
   request to the same account. **This test validates the classifier's
   plumbing (strip-and-retry-once, cooldown recording), not its match
   strings — the match strings themselves are gated separately by §7 item
   1's PRE-ENABLE GATE, which no unit test can substitute for since it
   requires a real captured rejection body.** Note in the test file itself
   that a passing suite here does not mean the classifier will actually
   match a real rejection.
9. **Subscription-endpoint accounts DO receive the field (reversed from an
   earlier draft).** Build a request against an account resolving to
   `CODEX_DEFAULT_ENDPOINT` (`isSubscriptionEndpoint` true, per
   `isCodexSubscriptionEndpoint`, provider.ts:2750) with compaction
   otherwise fully eligible. GREEN: `context_management` present, exactly as
   it would be for an `api.openai.com`-endpoint account — per §5's removed
   exclusion. This is now a **regression guard against re-introducing** the
   incorrect exclusion, not a guard that it stays absent. It does not
   substitute for §5's PRE-ENABLE GATE probe (whether the field does
   anything once it reaches either endpoint) — this test only proves the
   predicate builds the request the same way regardless of endpoint.
10. **Custom-endpoint (non-OpenAI-host) accounts never receive the field.**
    Same shape as (9) but for an account whose resolved endpoint hostname is
    neither `chatgpt.com` nor `api.openai.com`. GREEN: absent, via
    `isOpenAiPromptCacheEndpoint` reuse.
11. **Hosted search and custom-tools passthrough attempts never receive the
    field.** Two variants of the same assertion, using `options.hosted =
    true` and a request declaring an `additional_tools` item respectively.

## 10. Non-goals and deferrals

- **No support for the Responses-native custom-tool passthrough lane.**
  Compaction may well be safe and even more directly useful there (that
  client already speaks raw Responses format and can handle a compaction
  item itself, per OpenAI's documented contract) — deliberately deferred
  because this spec did not audit
  `buildCustomToolCallPassthroughResponse`'s response handling and the
  task's goal is explicitly the Claude-Code-via-Codex lane.
- **No support for hosted search attempts** (`createAttemptPlan`,
  `processCodexHostedSearchResponse`) — different response-handling code
  path, not audited here.
- **No absolute-token-count override env var.** Percent-of-effective-window
  is the only v1 knob (§2); an absolute override is deferred rather than
  shipping two competing ways to express the same setting.
- **The subscription-endpoint exclusion from an earlier draft is removed,
  not deferred** (§5) — this is a correction, not a non-goal; recorded here
  only so a reader of an older copy of this spec knows the change is
  deliberate and evidence-backed, not an oversight.
- **Do not teach `normalizeReplayItemForDigest` to recognize a `"compaction"`
  item type**, ever, even to make it "cleanly ignored" instead of
  fail-closed. The current fail-closed-on-unrecognized-type behavior is
  load-bearing defense-in-depth for §4's interlock (§3.5, §9 test 7) and
  must not be weakened, per the task's explicit instruction not to touch the
  hardened SSE/tail-validator/checkpoint machinery's guarantees.
- **No change to `store`** (§6) — out of scope, explicitly called out as its
  own blast radius.
- **No new "compaction" concept collision cleanup.** This fork's
  `analyze-trace.ts` already uses "compaction" for an unrelated, client-side
  concept (Claude Code's own conversation compaction, detected via
  `lineage_match` root-election basis and counted as
  `compactionContinuations`, analyze-trace.ts:209, 1962). This spec's
  `traceCompactionOutputItemCount` (§3.3) is a *different* thing (OpenAI
  server-side Responses compaction) that happens to share the English word.
  Flagging this explicitly so the implementer picks a field name and doc
  comment that won't be misread as the same mechanism (`traceCompaction
  OutputItemCount` is deliberately not `compactionContinuations` or anything
  resembling it) — a naming cleanup that unifies or disambiguates the two
  "compaction" vocabularies fork-wide is out of scope for this feature.
- **No live provider traffic was sent to verify any of the following; all
  are residual, explicitly flagged uncertainty. Items 1 and 2 are PRE-ENABLE
  GATES — this feature must not be flipped on for any real account, on
  either endpoint, until they are closed. Items 3-5 should be resolved
  before shipping past default-off but do not block writing/merging the
  default-off code itself:**
  1. **[PRE-ENABLE GATE, §5]** Whether the literal `context_management` /
     `compact_threshold` request field this spec attaches (§1) is honored
     at all by the Codex backend, on *either* `chatgpt.com/backend-api/codex`
     or `api.openai.com`. This is no longer phrased as an
     auth-mode/subscription question — source research into `openai/codex`
     found the reference client's own compaction implementation does not
     send this field on the wire at all (it uses a different mechanism, a
     `ContextCompactionItem` turn type). §5 specifies the exact minimal
     probe that settles this.
  2. **[PRE-ENABLE GATE, §3.1]** The literal `item.type` string for a
     compaction output item, assumed `"compaction"`. Not confirmed by the
     research above either, since that research examined a client that
     doesn't use this wire shape in the first place. The same probe in §5
     should capture this simultaneously if the field turns out to be
     honored.
  3. Whether upstream enforces its own ceiling on `compact_threshold` for
     this fork's specific model strings, independent of this fork's own
     `effectiveContextWindow` math (§2's new second residual-uncertainty
     paragraph).
  4. The exact JSON shape of an upstream rejection of `context_management`,
     if any (§7 item 1's classifier match strings — its own PRE-ENABLE GATE,
     independent of items 1-2 above).
  5. Any minimum accepted `compact_threshold` value (§2).
