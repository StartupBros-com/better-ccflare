---
title: SSE translation hot path — what actually helps, and why the matrix benchmark lies under load
date: 2026-08-16
category: performance
module: sse-stream-translation
problem_type: performance_optimization
component: openai_responses_adapter
severity: medium
applies_when:
  - Optimizing packages/openai-responses-adapter/src/stream-translator.ts
  - Optimizing packages/core/src/sse-frame-buffer.ts
  - Interpreting output from scripts/bench-sse-resource-limits.ts
  - Any change justified by an A/B of two separate benchmark process runs
symptoms:
  - A cross-process benchmark A/B reports a 20-70% change that does not reproduce
  - Identical code measured twice differs by more than the effect being chased
  - "Replacing string += with chunks[].join makes the translator slower, not faster"
root_cause: measurement_methodology
resolution_type: performance_improvement
related_components:
  - core
  - openai-responses-adapter
  - providers
tags:
  - sse
  - stream-translation
  - rope-strings
  - javascriptcore
  - benchmark-noise
  - frame-parsing
---

# SSE translation hot path — what actually helps, and why the matrix benchmark lies under load

## The one change that matters: frame parsing

`processSseFrame` used to read an SSE frame with `rawEvent.split(/\r?\n/)`.
The overwhelmingly common frame is two lines, LF-terminated:

```
event: content_block_delta
data: {"type":"content_block_delta",...}
```

A `data:` line can approach the 4MiB transport cap
(`BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES`). Splitting on a regex walks that
whole frame and materializes an array of substrings just to read two fields.
Replacing that with `indexOf("\n")` plus two slices, on the two-line LF shape
only, measured **~77% faster** on the parse step (three separate in-process runs:
−78.9%, −77.3%, −77.1% on a 1MB canonical frame).

Every other frame shape — CRLF framing, multi-line data, `id:`/comment lines, no
newline at all — still falls through to the original scanner. The fast path is
guarded to exactly one LF that is not preceded by CR, so it is deliberately
conservative: shapes it is unsure about get the old code, not a new code path.

A 400,000-input differential fuzz (hand-written adversarial corpus plus randomized
token assembly) found zero divergence between the two parsers.

### The same fix applies to the Codex provider, and is worth more there

`CodexProvider.processResponse` had the same hot spot in a worse form: it called
`eventText.split(/\r?\n/)` **twice** per frame — once to `.find()` the `event:`
line and again to `.find()` the `data:` line — so every frame paid two full
regex splits and two array scans.

`findCodexSseFrameLines()` applies the same guarded fast path there and, on the
fallback, splits once instead of twice. Measured **~88% faster** on a 1MB frame
(−89.0%, −87.9%, −88.6% across three runs), with a separate 400,000-input
differential fuzz showing zero divergence.

**The two parsers are deliberately NOT unified.** Their semantics differ and
both are load-bearing:

| | OpenAI Responses adapter | Codex provider |
|---|---|---|
| prefix | `event: ` / `data: ` (trailing space) | `event:` / `data:` (no space) |
| duplicate lines | **last** match wins | **first** match wins (`.find()`) |

Merging them would silently change how one of the two providers reads frames.
If you touch either, keep its own test suite green — each pins its parser to its
own reference implementation.

## String accumulation: the deciding factor is READ FREQUENCY, not concatenation

**Read this whole section before "fixing" any string accumulator in this
codebase. The right answer inverts depending on how often the accumulator is
read, and both wrong answers are severe.**

JavaScriptCore (Bun's engine) represents `a + b` as a *rope* — a lazy tree node,
built in O(1). The rope is flattened into a real contiguous string only when
something forces it: a search, a slice, a regex match, an encode. So:

| Accumulator is… | Correct form | Wrong form costs |
|---|---|---|
| **read once**, at the end | `s += chunk` | `parts[]`+`join` is **~13x slower** |
| **searched/sliced on every append** | `parts[]` + carry | `s += chunk` is **~332x slower** |

Measured in-process on Bun 1.3.11, both cases in the same process:

- Read once (20,000 x 200B appends, one read): `+=` **0.08ms**, `parts[].join` **1.11ms**.
- Searched every append (4,000 x 256B appends, regex exec per append): `+=` **235.62ms**, `parts[]`+carry **0.71ms**.

### Consequence 1 — the translator must use `+=`

`block.text` in `stream-translator.ts` is appended per delta and read exactly
once, at `content_block_stop`. That is the read-once row, so `+=` is already
optimal. Replacing it with `block.chunks.push(text)` + `chunks.join("")`
measured **+58.1%, +26.3%, +33.4% slower** across three runs and was rejected.

### Consequence 2 — `SseFrameBuffer.parts` must NOT use `+=`

`SseFrameBuffer` searches its buffer for a frame delimiter on every `push()`.
That is the searched-every-append row. The `parts: string[]` design plus the
3-character `carry` exists precisely so the delimiter search only ever scans
`carry + newChunk` instead of the whole accumulated tail. Collapsing it to
`buffer += decoded` and searching `buffer` reintroduces quadratic behaviour —
measured **332x slower** on a 4,000-chunk unterminated tail. Do not do it, and
do not cite Consequence 1 as a reason to.

### Consequence 3 — an early map delete frees nothing

Because `block.text` and the `fullText` local are the same string reference,
deleting the `textByBlock` entry *earlier* in `content_block_stop` releases no
memory. `content_block_stop` already deletes the entry at its end; adding a
second, earlier delete buys nothing and duplicates code.

## Why the matrix benchmark must not be A/B'd across processes

`scripts/bench-sse-resource-limits.ts` is explicitly informational — it prints a
table and never fails on a number. On a developer box running parallel agent
sessions it is far noisier than the effects usually being chased.

Measured 2026-08-16 at load average ~13-16, running the full matrix six times,
alternating unpatched and patched:

- Sum of all config medians, **identical code**, three runs: 7025ms, 9093ms, 6808ms — a **34% spread** with nothing changed.
- Median within-baseline spread per configuration: **38%**; the worst configuration spread **209%**.
- The resulting "candidate is 55% slower" aggregate was pure noise, and reversed sign between rounds.

So: **a difference between two separate benchmark process runs is not evidence**
unless it is much larger than that spread, and even then it needs repetition.
This is also why a previously recorded "regression" in a specific matrix
configuration (for example near-4MiB / 64KiB / concurrency 24) should not be
treated as real without re-measurement — the reported magnitudes sit inside the
noise band.

### What to do instead

Run both variants **in the same process, alternating sample by sample**, so
ambient load hits both sides equally, and take the median of many samples:

```ts
for (let i = 0; i < SAMPLES; i++) {
  let t = performance.now(); runMain(); aSamples.push(performance.now() - t);
  t = performance.now();     runCand(); bSamples.push(performance.now() - t);
}
```

Two cautions learned doing exactly this:

1. **Consume the result** (accumulate into a sink that is printed at the end), or
   the JIT eliminates the work and both sides measure ~0ms.
2. **Make each sample big enough** to sit well above timer resolution; sub-0.01ms
   samples produce spreads in the thousands of percent and mean nothing.

## Reusing the real class in a microbenchmark

To A/B a one-line change inside `SseFrameBuffer` without trusting a synthetic
re-implementation, read the real source, string-replace just that line to build a
second variant in a temp file, and `import()` both into one process. That keeps
the surrounding scanning, cap-checking, and decoder behaviour identical between
the two arms, so the measured delta is attributable to the changed line.

That method showed the `searchText` reuse in `push()` is **performance-neutral**
(−5.1%, +3.0%, −1.5% across three runs — inside the noise), even though it
strictly removes a redundant `this.carry + decoded` concatenation. It was kept as
a correctness-preserving simplification, not as a measured speedup: `searchText`
is assigned at the top of `push()` and `this.carry` is not reassigned until the
line in question, so the two expressions are provably the same string.
