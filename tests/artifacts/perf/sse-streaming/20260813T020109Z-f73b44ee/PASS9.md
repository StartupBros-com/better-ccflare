# Pass 9 cumulative re-profile

The cumulative source changes were re-profiled with the full local-only matrix: 2 translators × 2 frame sizes × 3 chunk sizes × 3 concurrency levels × 5 waves = 36 configurations.

## Aggregate comparison

| Metric | Original | Cumulative | Delta |
|---|---:|---:|---:|
| Sum of row medians | 6860.9 ms | 6074.7 ms | **-11.4%** |
| Median row latency | 17.25 ms | 12.6 ms | **-27.0%** |
| Sum row throughput | 8009.1 MiB/s | 11167.0 MiB/s | **+39.4%** |
| Median row throughput | 155.2 MiB/s | 205.35 MiB/s | **+32.3%** |
| Median peak heap delta | 28.9 MiB | 28.9 MiB | unchanged |
| Sum peak heap deltas | 8146.0 MiB | 8158.5 MiB | +0.2% |

Across comparable nonzero rows, latency improved in 31, regressed in 4, and was unchanged in 1. Heap values are subject to Bun/JSC GC scheduling variance.

## Selected worst-case process baseline

Responses adapter / near-4MiB / 256B / concurrency 24 / one wave, 10 hyperfine runs:

- mean: 1840.35 ms
- median: 1848.51 ms
- standard deviation: 197.31 ms
- range: 1585.63–2074.18 ms
- CV: 10.72%
- all 10 runs exited zero

The corresponding five-wave in-process median was **1426.5 ms**, versus the original **1818.9 ms** (**-21.6%**). Fresh-process and in-process numbers are not directly interchangeable.

## Current latency hotspots

1. Responses adapter / near-4MiB / 256B / 24: **1426.5 ms** (-21.6%)
2. Responses adapter / near-4MiB / 64KiB / 24: **980.7 ms** (+27.3%; new regression)
3. Responses adapter / near-4MiB / whole-frame / 24: **787.2 ms** (+19.5%; new regression)
4. Responses adapter / near-4MiB / 256B / 12: **766.5 ms** (-12.2%)
5. Codex / near-4MiB / 256B / 24: **741.2 ms** (-16.4%)

## Current heap hotspots

1. Responses adapter / near-4MiB / whole-frame / 24: **1638.9 MiB** (+15.1%)
2. Responses adapter / near-4MiB / 256B / 24: **1535.3 MiB** (+3.9%)
3. Responses adapter / near-4MiB / 64KiB / 24: **1197.9 MiB** (-21.4%)
4. Responses adapter / near-4MiB / 256B / 12: **898.9 MiB** (+2.7%)
5. Responses adapter / near-4MiB / 64KiB / 12: **640.9 MiB** (+40.9%)

## Regression interpretation

The new 64KiB and whole-frame latency/heap hotspots are benchmark-observed shifts, not correctness failures. The existing accepted changes improve the highly fragmented 256B case and the shared buffer tail path; the next optimization must target the newly shifted boundary configurations and must be independently measured before acceptance.

Raw evidence in this directory:

- `pass9-matrix.log`
- `pass9-comparison.tsv`
- `pass9-comparison-summary.txt`
- `pass9-hyperfine.log`
- `pass9-hyperfine.json`
