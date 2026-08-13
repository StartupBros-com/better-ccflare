# Ranked hotspot table

Evidence is workload-level because `perf` and `samply` are unavailable on this WSL2 host. The benchmark invokes production translator functions with in-memory fixtures; it does not attribute time to individual functions inside those translators.

| Rank | Location / workload | Metric | Value | Category | Evidence |
|---:|---|---:|---:|---|---|
| 1 | `translateAnthropicStreamToResponses` — near-4MiB, 256B chunks, concurrency 24 | median wave time | **1,818.9 ms** | CPU / alloc | `sse-benchmark.txt` row `responses-adapter near-4mib 256b 24`; 50.3 MiB/s and 1,478.1 MiB settled heap |
| 2 | `translateAnthropicStreamToResponses` — near-4MiB, 64KiB chunks, concurrency 24 | settled heap delta | **1,523.7 MiB** | alloc | `sse-benchmark.txt` row `responses-adapter near-4mib 64kib 24`; 770.3 ms and 118.9 MiB/s |
| 3 | `translateAnthropicStreamToResponses` — near-4MiB, whole-frame, concurrency 24 | settled heap delta | **1,423.4 MiB** | alloc | `sse-benchmark.txt` row `responses-adapter near-4mib whole-frame 24`; 658.8 ms and 139.0 MiB/s |
| 4 | `CodexProvider.processResponse` — near-4MiB, 256B chunks, concurrency 24 | median wave time | **886.3 ms** | CPU | `sse-benchmark.txt` row `codex near-4mib 256b 24`; 103.3 MiB/s and 372.3 MiB settled heap |
| 5 | `translateAnthropicStreamToResponses` — near-4MiB, 256B chunks, concurrency 12 | settled heap delta | **874.9 MiB** | alloc | `sse-benchmark.txt` row `responses-adapter near-4mib 256b 12`; 872.8 ms and 52.5 MiB/s |
| 6 | Selected configuration process envelope — Responses adapter, near-4MiB, 256B, concurrency 24 | p95 / p99 process latency | **2,093.4 / 2,150.9 ms** | end-to-end | `BASELINE.md`, `hyperfine.json`; peak RSS ~2.29 GiB, 20/20 launches passed |

## Scaling observations

- **Frame size dominates:** Responses adapter at 256B/concurrency 24 rises from 27.0 ms for the 110,079B incident fixture to 1,818.9 ms near 4MiB (~67.4×), while input size rises ~36.3×. Codex rises from 18.9 ms to 886.3 ms (~46.9×).
- **Concurrency amplifies cost:** Responses adapter near-4MiB/256B rises 56.7 → 872.8 → 1,818.9 ms for concurrency 1 → 12 → 24 (32.1× at 24-way); settled heap rises 55.4 → 874.9 → 1,478.1 MiB.
- **Chunk granularity matters at the boundary:** At Responses adapter near-4MiB/concurrency 24, 256B is 1,818.9 ms versus 658.8 ms whole-frame (~2.76×) and 770.3 ms at 64KiB (~2.36×). At Codex the same comparison is 886.3 ms versus 215.4 ms (~4.11×) and 201.5 ms (~4.40×).
- **Translator asymmetry:** At near-4MiB/256B/concurrency 24, the Responses adapter is ~2.05× slower than Codex and retains ~4.0× as much heap (1,478.1 vs 372.3 MiB).
- **RSS confirmation:** Process-level hyperfine for the selected worst case has p50 1,865.8 ms, p95 2,093.4 ms, p99/max 2,150.9 ms and ~2.29 GiB peak RSS (`BASELINE.md`).

These observations are measurement targets for the optimization hand-off, not optimization recommendations.
