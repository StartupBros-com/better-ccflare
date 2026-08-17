# Codex trace `input_tokens` is cache-INCLUSIVE; the DB's is not

Applying the database's cache-hit formula to Codex *trace* data double-counts
cached tokens and roughly halves the apparent cache rate. This produced a
published-then-retracted measurement on 2026-08-17 (see issues #174 and #199):
arm medians were reported as ~48% when they were actually ~93%.

## The two shapes

| source | what `input_tokens` means | correct cache-read share |
|---|---|---|
| trace JSONL (`codex-trace-*.jsonl`, schema 18) | Codex's **cache-inclusive** `totalInputTokens` | `cache_read / input_tokens` |
| `requests` table | Anthropic-compatible **additive uncached** input | `cache_read / (input_tokens + cache_read + cache_creation)` |

Trace side: `packages/providers/src/providers/codex/provider.ts` writes
`totalInputTokens` straight into the trace's `input_tokens`.
DB side: `packages/providers/src/providers/codex/usage.ts` normalizes into the
Anthropic additive shape, where uncached input, cache read, and cache creation
are three disjoint buckets.

Both were verified by reconciling 230 DB-matched trace joins: `DB prompt_tokens
== trace input_tokens`, and `DB (input + read + creation) == prompt_tokens`.

## Two more traps in the same analysis

**Omitting `cache_creation` from the DB denominator** inflates the result.
Anthropic traffic reads 99.9% without it and 96.2% with it — the second is the
honest number.

**Quoting only one central tendency.** Median and token-weighted share diverge
sharply here because a handful of very large requests dominate the weighting.
On the same 2026-08-17 records, treatment `replay` was 94.48% median but 53.25%
token-weighted, while control `would_replay` was 92.53% median and 82.50%
weighted — the two statistics point opposite directions. Report both, or the
conclusion flips with the choice of statistic.

## Also

Date-scope every trace query. The trace directory retains files from before
turn-state shipped, and an unscoped aggregate silently mixes pre-deploy records
in: one unscoped funnel read "0.3% of traffic is treated" when the
correctly-scoped figure for that day was 50.2%.

Turn-state fields in the JSONL are snake_case and prefixed `codex_turn_state_*`
— not the camelCase names in `trace.ts`'s TypeScript input interface. Grepping
the TypeScript names returns zero matches and reads as "telemetry is broken"
when it is flowing fine.

A reference implementation of the corrected analysis (attempt-aware joins,
read-only SQLite, both formulas side by side) lives on the
`codex-cache-diagnosis` branch as `scripts/analyze_codex_turn_state.py`. It was
deliberately kept out of `main`: it is Python, and this repo has no Python
toolchain or CI.
