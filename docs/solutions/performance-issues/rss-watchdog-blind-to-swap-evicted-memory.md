---
title: An RSS-only containment watchdog goes blind when the kernel swaps the leak out
date: 2026-09-11
category: performance-issues
module: rss-watchdog
problem_type: performance_issue
component: infrastructure
severity: high
symptoms:
  - "Watchdog sampled only VmRSS, so kernel swap eviction under memory pressure lowered the reading exactly when the true footprint was highest."
  - "Production measured 0.69 GiB VmRSS against 10.66 GiB VmSwap - an 11.35 GiB true footprint, 2.8x the 4 GiB threshold - while the trigger streak reset every poll and never fired."
  - "The host reached PSI memory-full avg300=62% and load 645 with no corresponding recycle entry in the runner log."
  - "Separately, a fixed cap of 3 recycles per 24h exhausted on high non-cache-token-volume days, logging RSS recycle suppressed 38 times across two days."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - scripts
  - systemd-deploy
tags:
  - rss-watchdog
  - vmswap
  - swap-eviction
  - memory-containment
  - recycle-budget
  - proc-status
  - systemd
  - production-incident
---

# An RSS-only containment watchdog goes blind when the kernel swaps the leak out

## Problem

The production RSS containment watchdog (`rss_watchdog`, `scripts/run-ccflare-stack.sh:312`) exists to recycle the Bun upstream before an off-heap memory leak takes down the host. It sampled only `VmRSS` from `/proc/<pid>/status`. Under host memory pressure the kernel evicts a leaking process's anonymous pages to swap, which *lowers* `VmRSS` — so the one metric the watchdog trusted went blind precisely when containment was needed.

A second, independent fault made the mechanism's own cap too small for real demand: `RUNNER_RSS_MAX_RECYCLES=3` per 24h undercounted trigger volume on high-throughput days, so containment also went idle for the remainder of those windows. **The two faults are distinct and were observed on different days** — neither fix is sufficient alone.

## Symptoms

- Production evidence, pin `v3.5.70-0471bb24`, 2026-09-08/09: `VmRSS` 0.69 GiB against `VmSwap` 10.66 GiB — true footprint 11.35 GiB, 2.8x the 4 GiB threshold (`RUNNER_RSS_THRESHOLD_BYTES=4294967296`). The watchdog's reading sat at 17% of the threshold, which is only 6% of the process's actual footprint, so the streak reset every poll and it never fired.
- The journal proves the *logic* was sound, not the *input*: it fired correctly twice on Sep 8 while growth was still resident (`RSS recycle trigger; rss_bytes=4378308608; samples=5`, then `rss_bytes=4452995072`), draining cleanly each time — then went silent for roughly 1.5 days as the same growth migrated to swap. **There is no `RSS recycle suppressed; cap exhausted` line in that window**, which rules out the cap as the cause there: it genuinely never triggered again. Host reached PSI `memory full avg300=62%`, load 645.
- Cap exhaustion was real, but on *other* days and for the *other* reason. The 30-day journal shows triggers/day of 6 (Aug 30), 4 (Aug 31), 4 (Sep 1), 3 (Sep 2), 2 (Sep 8), and `RSS recycle suppressed; cap exhausted` fired 35 times on Aug 31 plus 3 times on Sep 1 (38 total) — on days when the metric was still resident and reading correctly, and the watchdog was firing as designed until it ran out of budget.
- Demand tracks non-cache token volume, not request count: trigger days ran 294–1300 Mtok/day non-cache; every zero-trigger day ran 9–279 Mtok. 2026-09-05 served 41,060 requests — comparable to a trigger day — at only 118 Mtok non-cache, with zero triggers. Request count alone would have been the wrong denominator to size the cap against.

## What Didn't Work

Earlier investigation (issue #277, PRs #278/#283) chased an application-level leak and ruled out every live holder it checked, before the swap-blindness in the watchdog itself was identified as the actual containment gap:

- `smaps_rollup` showed the growth as almost entirely private dirty anonymous memory (file-backed PSS only ~21 MiB) — not a mapped-file leak.
- JSC heap size stayed flat (~231 MiB) at 4.17 GiB RSS — ruling out a JS-level leak; the growth is native/off-heap.
- `AsyncDbWriter` queues were empty, `storePayloads` was false, cache keepalive TTLs were 0, affinity maps were tiny — none were live holders of the growth.
- Two application-level fixes were profiled and rejected on their own merits: consume-once transformed bodies / lazy retry `Request`s worsened median settled RSS by 11%; bypassing the final `new Request(target, ...)` wrapper gave only a noisy 0–4% improvement.
- The 1 GiB body-admission budget was confirmed to be an admission-queue limit, not an RSS cap, so it was never going to bound this growth.

None of that was wrong, but all of it was solving for "why is native memory growing" when the open failure was "why didn't containment fire." The watchdog's own input metric was the gap, not the leak's mechanism.

## Solution

PR #337 replaces the RSS-only sample with a combined resident+swap read and raises the recycle cap to match measured demand.

Before, `proc_rss_bytes` read only `VmRSS:`. After, `proc_mem_bytes` (`scripts/run-ccflare-stack.sh:282`) reads the whole file and matches both fields in one `case`:

```bash
proc_mem_bytes() {
	local key kib unit extra rss="" swap=0
	while read -r key kib unit extra; do
		case "$key" in
		VmRSS: | VmSwap:)
			[[ "$kib" =~ ^[0-9]+$ && "$unit" == "kB" && -z "${extra:-}" ]] || return 1
			((kib <= 8796093022207)) || return 1
			if [[ "$key" == "VmRSS:" ]]; then rss="$kib"; else swap="$kib"; fi
			;;
		esac
	done <"$RUNNER_PROC_ROOT/$1/status"
	[[ -n "$rss" ]] || return 1
	((rss + swap <= 8796093022207)) || return 1
	printf '%s %s %s\n' "$(((rss + swap) * 1024))" "$((rss * 1024))" "$((swap * 1024))"
	return 0
}
```

Two deliberate edge-case rules live in that function:

- A **missing `VmSwap:` field defaults to `swap=0`** (the local starts pre-initialized) rather than failing the sample — kernels built without swap support keep the previous resident-only behavior instead of silently losing containment.
- A **malformed** `VmRSS:`/`VmSwap:` value trips the `return 1` inside the `case`, discarding the whole sample — fail closed, safe under `set -Eeuo pipefail` because the caller treats a nonzero return as "skip this poll," not a script abort.

The caller, `rss_watchdog` (`scripts/run-ccflare-stack.sh:312`), consumes all three numbers, compares the combined `mem` against the threshold instead of `rss`, and logs the breakdown (`scripts/run-ccflare-stack.sh:340`):

```
RSS recycle trigger; upstream_pid=...; mem_bytes=...; rss_bytes=...; swap_bytes=...; threshold_bytes=...; samples=...
```

The post-read identity re-check is preserved from the earlier TOCTOU fix — reading two `/proc` files is never atomic, so the PID's start time is re-verified *after* `proc_mem_bytes` returns, not only before.

`RUNNER_RSS_MAX_RECYCLES` was raised from 3 to 8 in every place the tuple is asserted, in lockstep: the systemd pin renderer (`scripts/deploy-ccflare-lib.sh:437`), the deploy-time expected tuple in `validate_production_rss_policy_values` (`scripts/deploy-ccflare-lib.sh:787`), the literal in `scripts/deploy-ccflare.sh:501`, plus tests and docs. It stays finite — a genuine runaway still surfaces as `RSS recycle suppressed; cap exhausted` rather than being masked by endless silent restarts — and the 1-hour cooldown remains the actual pacing control, not the cap.

## Why This Works

The watchdog's logic — periodic poll, minimum uptime, a consecutive-sample anti-flap streak, and a cooldown — was never the problem; the Sep 8 journal shows it firing and draining cleanly twice. The problem was the input. `VmRSS` measures pages currently resident in physical memory, and the kernel's own response to memory pressure is to evict a large anonymous-memory process's cold pages to swap. So the exact condition that makes containment matter most is also the condition that makes `VmRSS` under-report the offending process. `VmRSS + VmSwap` does not have that failure mode: pages moved to swap are still counted, just via a different field. The fix does not change what triggers a recycle — it changes what the watchdog is allowed to *not know*.

The cap fix addresses a different mechanism. Even with a correct metric, a per-24h cap smaller than real trigger demand still produces silent gaps. Sizing it against measured non-cache token volume rather than request count matters because the two are decoupled here — 2026-09-05 had trigger-day request volume but non-trigger-day token volume and zero triggers.

### Accepted trade-offs

Widening the metric is not free, and both costs were accepted deliberately:

- **`VmRSS + VmSwap` counts cold pages the kernel evicted because *other* processes demanded memory.** A healthy-but-swapped process can now cross a threshold it previously would not, so a recycle can be triggered by foreign memory pressure rather than by this process's own growth. The consecutive-sample streak, minimum uptime, cooldown, and the finite cap bound the damage, and a recycle drains the guard first rather than dropping in-flight work. On a host that swaps routinely this is a real, if bounded, false-positive vector.
- **`VmSwap` per `proc(5)` covers private anonymous swap only, not shmem/tmpfs-backed swap.** A shared-memory-backed leak could still under-report the same way `VmRSS` alone did. Worth checking first if this blindness pattern ever recurs with the fix already deployed.

## Prevention

- Regression tests in `scripts/__tests__/run-ccflare-stack.test.ts` exercise the failure mode and its edge cases:
  - `counts swapped-out pages so a leak hidden in swap still recycles` (line 560) — drives RSS low and swap high, asserting the `mem_bytes`/`rss_bytes`/`swap_bytes` breakdown; reproduces the production miss in miniature.
  - `treats a swapless host's absent VmSwap field as zero and still recycles` (line 588) — asserts the fixture's `/proc/<pid>/status` genuinely *omits* the `VmSwap` key rather than writing `VmSwap: 0`, so it cannot pass against a `proc_mem_bytes` that discards every sample when the key is missing.
  - `discards a malformed VmSwap line and recovers on the next clean sample` (line 617) — corrupts swap before raising RSS above threshold, asserting no trigger fires on the malformed sample and that containment resumes on the next clean one, proving the fail-closed path does not also fail permanently.
- Each of those was mutation-verified rather than merely observed green: making a missing field fail the sample breaks the swapless test, and coercing a malformed value to zero breaks the malformed test with a false trigger. A containment test that still passes when containment is removed is worse than no test.
- `validate_production_rss_policy_values` (`scripts/deploy-ccflare-lib.sh:787`) hard-fails a deploy if any of the seven RSS policy values drift from the exact managed tuple, so a future tweak to the cap cannot ship without updating the validator too. Note that `scripts/deploy-ccflare.sh --check` does **not** run this validator — it covers only the main-source, ancestry, clean-tree and version gates — so pin drift is invisible to `--check` until a full deploy runs. Read the pin file directly when you need to confirm the live tuple.
- **The general lesson: a containment or alerting threshold must be measured on a metric that cannot be deflated by the very pressure it exists to detect.** `VmRSS` degrades exactly when the host is under memory pressure, because the kernel's pressure-relief mechanism is also the metric's blind spot. Before wiring a watchdog or alert to a single OS- or runtime-reported number, ask what system response to the guarded condition would move that number in the wrong direction, and whether a broader read closes the gap without inventing a new failure mode.
- A corollary for soak criteria: a soak that passes while the guard is silent proves nothing. The pre-fix soak for this watchdog could have passed with containment inert, because a host under pressure hides the very growth being measured. Any soak over a safety net needs a positive liveness signal from the net itself, not just the absence of an incident.
- Independent measurement on the live host, 2026-09-11 (14 samples over 14 minutes, post-fix build), found swap held 23–55% of the true footprint continuously, median ~40%. This was never an occasional-incident blind spot — it was a standing under-read at all times, by a factor of `1/(1 - swap_share)`: 1.3x at the low end, 2.2x at the high end, about 1.7x at the median. `VmHWM` reached 5.14 GiB in that window without triggering a recycle, which is the anti-flap streak behaving correctly on a transient resident spike rather than a second miss; worth remembering before reading `VmHWM` against the threshold in isolation.

## Related Issues

- Issue #277 — `perf: bound native RSS under large-context traffic`. The umbrella issue; this fix repairs the safety net that was supposed to bound the growth, and does **not** close the underlying native-RSS question.
- PR #283 / issue #281 — established the guard-first drain watchdog and the seven-value tuple that turned out to be swap-blind.
- PR #278 — added the native-memory telemetry used to distinguish JS-heap from native/off-heap growth.
- [docs/solutions/workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md](../workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md) — the companion TOCTOU stale-PID race in this same watchdog. Different root cause, same function; its guidance on re-checking identity after the sample is the other half of this watchdog's contract.
- [docs/solutions/performance-issues/stream-reader-deadline-settlement-before-lock-release.md](stream-reader-deadline-settlement-before-lock-release.md) — the native-RSS growth *source* this watchdog exists to contain. Different layer: cause versus safety net.
- `docs/systemd.md` — source of truth for the current managed-pin values; do not re-derive them from this doc.
