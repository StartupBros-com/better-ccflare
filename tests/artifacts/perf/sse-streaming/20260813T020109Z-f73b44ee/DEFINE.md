# Profiling scenario: synthetic SSE translation

- **Scenario:** Translate production-shaped streaming responses entirely in memory using the repository's `scripts/bench-sse-resource-limits.ts` harness.
- **Path represented:** provider stream translation immediately before the proxy response lifecycle (`CodexProvider.processResponse` and `translateAnthropicStreamToResponses`).
- **Fixtures:** `incident-110079b` (110,079-byte field-derived frame) and `near-4mib` (4,000,000-byte frame); chunking `whole-frame`, `64kib`, and `256b`; concurrency `1`, `12`, and `24`; five waves per configuration.
- **Safety:** no server start, sockets, fetch, credentials, provider calls, or Anthropic traffic. `bench/drain-strategy-harness.ts` is intentionally excluded because it fetches jsDelivr.
- **Golden output:** benchmark must complete successfully and emit one result row per valid matrix configuration; the translated stream must reach `.text()` without a crash. This existing harness is informational and does not enforce a numeric threshold.
- **Primary metrics:** median wall time per wave, derived input throughput (MiB/s), peak heap delta, settled heap delta.
- **Required reporting:** baseline matrix output, host/toolchain fingerprint, ranked hotspot table, hypothesis ledger, and limitations.
- **Comparability:** same worktree/commit, same Bun runtime, same WSL2 host, warm cache, no kernel/governor/cache tuning.
- **Attribution limit:** `perf` and `samply` are unavailable on this host; results identify workload sensitivity, not sampled function-level CPU attribution.
