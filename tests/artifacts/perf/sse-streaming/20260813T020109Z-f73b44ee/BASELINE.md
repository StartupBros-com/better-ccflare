# Baseline: worst observed synthetic SSE configuration

Command:

```bash
BENCH_TRANSLATORS=responses-adapter \
BENCH_FRAME_SHAPES=near-4mib \
BENCH_CHUNK_SHAPES=256b \
BENCH_CONCURRENCY=24 \
BENCH_WAVES=1 \
bun scripts/bench-sse-resource-limits.ts >/dev/null
```

- Measured process launches: 20
- Warmups: 3
- Exit codes: 20/20 zero
- Mean: **1,871.6 ms**
- Standard deviation: **121.6 ms**
- p50: **1,865.8 ms**
- p95: **2,093.4 ms**
- p99: **2,150.9 ms** (20 samples; conservative tail estimate)
- Max: **2,150.9 ms**
- Min: **1,656.4 ms**
- User CPU: 1.297 s mean
- System CPU: 0.965 s mean
- Hyperfine sampled peak memory: 2,450,894,848 bytes (~2.28 GiB)
- Independent `/usr/bin/time -v` peak RSS: 2,397,080 kB (~2.29 GiB)
- Swap: 0; major faults: 0

The process-level baseline includes Bun startup/import overhead. Use the in-process matrix for steady-state translation comparisons; use this baseline only for reproducible end-to-end process cost of the selected configuration.
