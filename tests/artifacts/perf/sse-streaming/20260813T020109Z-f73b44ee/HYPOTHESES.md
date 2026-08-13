# Hypothesis ledger

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Large translated frame size is the primary driver of cost. | **supports** | At Responses adapter/256B/concurrency 24, median time grows 67.4× from 110,079B (27.0 ms) to 4,000,000B (1,818.9 ms), while input bytes grow ~36.3× (`sse-benchmark.txt`). |
| Fine-grained chunks amplify parser/stream overhead. | **supports** | At near-4MiB/concurrency 24, Responses adapter is 1,818.9 ms with 256B chunks vs 658.8 ms whole-frame and 770.3 ms at 64KiB; Codex is 886.3 ms vs 215.4/201.5 ms (`sse-benchmark.txt`). |
| Concurrent stream transformations amplify allocation pressure. | **supports** | Responses adapter near-4MiB/256B settled heap is 55.4 MiB at concurrency 1, 874.9 MiB at 12, and 1,478.1 MiB at 24; process peak RSS is ~2.29 GiB in the 24-way case (`sse-benchmark.txt`, `BASELINE.md`). |
| Responses-adapter translation is a stronger target than Codex translation for this workload. | **supports** | At near-4MiB/256B/concurrency 24, Responses adapter is 1,818.9 ms/1,478.1 MiB settled heap versus Codex 886.3 ms/372.3 MiB (`sse-benchmark.txt`). |
| Disk I/O is the bottleneck. | **rejects for this scenario** | The benchmark builds `ReadableStream` fixtures in memory and performs no fetch/socket/filesystem work; `/usr/bin/time -v` reports 0 file-system inputs/outputs and 0 major faults (`BASELINE.md`). |
| Provider/network latency explains the result. | **rejects for this scenario** | No server, credentials, provider, sockets, or network calls are used; the benchmark calls pure translation paths with synthetic responses (`DEFINE.md`). |
| Bun GC scheduling contributes measurement variance. | **supports / known limitation** | The harness documents GC scheduling around large stream buffers; hyperfine spans 1,656.4–2,150.9 ms (20 process launches), so p99 is explicitly conservative (`BASELINE.md`). |
| A function-level hotspot can be claimed from this run alone. | **rejects** | `perf` and `samply` are unavailable; this run ranks fixture/configuration sensitivity only. A future attribution pass needs an installed sampler or measurement-only spans/sentinels (`DEFINE.md`). |
