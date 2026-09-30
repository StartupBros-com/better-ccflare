---
module: Codex response streaming
problem_type: performance_issue
tags: [codex, streaming, memory, reasoning, diagnostics]
---

# Bound deferred reasoning and retain first-attempt stall evidence

Encrypted reasoning items completing while a tool or text block is open must wait
for that block to close. Emitting them immediately would violate the block ordering
fixed in PR #139. Individual SSE-frame limits do not bound this deferred list:
a local stream with 160 independently valid frames retained over 10 MiB while
emitting only its opening tool block. This proves an unbounded retention path; it
does not establish the cause of any particular process memory threshold or model stall.

Each translated stream now admits at most 4 MiB of deferred wrapped reasoning and
1,024 items. The byte charge is the UTF-8 size of the complete replay envelope,
including its prefix, ID and encrypted string. Admission checks run before pushing
the new item. Four MiB matches the existing parser tail budget; the independent
count limit bounds the object/list overhead of tiny items. Under both limits,
content and ordering are preserved exactly. Crossing either limit uses the existing
`sse_limit_exceeded` terminal path, closes the open block, and releases the owned
transport through the bounded drain. There is no silent dropping or truncation.
Flushes release their charge; terminal, error and cancellation paths clear retained
reasoning and argument references. A cap failure claims its single terminal trace
before a backpressured error write, so cancellation cannot replace that cause.
The bounded upstream drain starts before those writes too: a consumer that stops
reading the terminal error cannot keep the upstream transport or reader alive.

Trace schema 22 adds `stream_diagnostics` only for translated streaming attempts
(including the stream consumed by the nonstreaming adapter). Fixed event categories
distinguish encrypted reasoning completion, visible summary deltas, text deltas,
function-call events, terminal events, and ignored/malformed frames. Counters
saturate at `Number.MAX_SAFE_INTEGER`; event ages use a monotonic clock and are
integer milliseconds or null. The snapshot contains raw bytes read, argument delta
bytes, and current/peak retained tool and deferred-reasoning bytes/counts. Current
counts describe retention at the terminal boundary, before cleanup; they are not
post-cleanup process memory measurements. Raw byte totals include the complete
chunk containing the terminal event; event categories stop at that terminal.
Unknown event names, payloads, IDs and arguments are never added to these fields,
and serialization uses an explicit runtime allowlist. Existing trace fields are
unchanged. These counters do not measure model productivity or heap/RSS usage.

The first cache-lane rescue and first precommit SSE retry now retain the gate's
existing frame-kind counts, last valid protocol activity age and terminal evidence.
A successful second attempt cannot overwrite the first attempt's classification.

This patch deliberately does not forward ignored reasoning summaries or raw tool
argument fragments, change meaningful-progress classification, alter deadlines,
change routing or clear quota state. Those behavior changes need separate evidence
and complete streaming/nonstreaming ownership and sanitization tests.

Validation uses in-memory synthetic streams only: exact UTF-8 and item boundaries,
repeated flushes, original block-order regressions, cancellation and finite transport
cleanup, one terminal trace, strict serialization, counter saturation, and real proxy
rescue fixtures with mocked fetch. No inference traffic is needed.
