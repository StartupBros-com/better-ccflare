---
title: Verify fix ancestry before writing a measured production rate into permanent rationale
date: 2026-09-11
category: workflow-issues
module: deploy-measurement-provenance
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Writing a production incident's measured rate into permanent config rationale such as docs or sizing thresholds
  - Citing a rate measured on a specific deployed pin without checking what main has fixed since
  - Re-tuning a watchdog, cap, or threshold using a previously written incident baseline
  - Main has merged fixes that are not yet on the production pin the incident was measured on
symptoms:
  - A config doc states a leak or error rate with no reference to the build or pin it was measured on
  - "`git merge-base --is-ancestor` shows a contributing fix landed on main before the measurement but after the pin it was measured on"
  - The same fix is already an ancestor of the commit production runs today
  - A future re-tune of the same cap would use the old rate as its only justification
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - systemd-deploy
  - documentation
tags:
  - deploy-lag
  - measurement-provenance
  - build-ancestry
  - stale-baseline
  - merge-vs-deploy
  - config-rationale
  - systemd
  - production-pin
---

# Verify fix ancestry before writing a measured production rate into permanent rationale

## Context

In this repo, merging to `main` never deploys production. Deployment is a separate, manual, operator-run step (`scripts/deploy-ccflare.sh`), which refuses to build or ship any commit that is not an ancestor of `origin/main` — but nothing forces a deploy to happen promptly, or at all, after a merge. So `main` routinely runs ahead of the deployed pin, sometimes by dozens of commits. The systemd pin records exactly which SHA is live, and the health endpoint exposes the same value as `git_sha`.

That gap creates a specific trap for any number measured *on the running system*. The measurement is scoped to whatever code that pin happened to contain — not to "the system" in general, and not to current understanding of the bug. Written into permanent documentation or config rationale, it silently inherits an unstated assumption: that nothing relevant has changed since. Where merge and deploy are decoupled, that assumption is frequently false, and nothing about reading the resulting doc later would tell you so.

**This gap has already been caught once, by the operator, in a different workstream (session history).** During the v3.5.78 upstream integration, a closeout declared the work done; the operator pushed back that it was not live locally and therefore not done, and the assistant corrected itself: *"merged isn't deployed. Production is still running the v3.5.70 binary while main is at 3.5.78."* The same decoupling that made that correction necessary is what makes a measured number go stale.

## Guidance

Before a measured production number becomes permanent rationale, verify the build it was taken on and what has moved since.

1. **Identify the exact build the measurement came from.** The systemd pin encodes the SHA; the health endpoint's `git_sha` confirms it at runtime independent of any binary filename.

2. **Ask what has landed on `main` since that build that could move the number.**

   ```bash
   git log <measured-sha>..origin/main --oneline -- <relevant-subsystem-path>
   ```

3. **Settle presence with ancestry, not assumption.**

   ```bash
   git merge-base --is-ancestor <fix-sha> <measured-sha>
   echo $?   # 0 = fix was already in the measured build; non-zero = it was not
   ```

4. **If a contributor turns out fixed-but-undeployed**, either re-measure after deploying, or write the number down *with its build and its known-superseded components named*, so the next reader knows what it does and does not describe.

The cheap version: a measured number entering permanent docs should carry the SHA it was measured on. A number without provenance cannot be re-evaluated later; one with provenance can be checked with a single `git merge-base --is-ancestor` whenever someone needs to trust it again.

This is a documentation-provenance practice, not a memory-leak fix. The technical root cause and remediation for the watchdog itself is documented separately at [rss-watchdog-blind-to-swap-evicted-memory.md](../performance-issues/rss-watchdog-blind-to-swap-evicted-memory.md); this note does not restate it.

## Why This Matters

A rationale paragraph outlives the incident that produced it. `docs/systemd.md:200-203` currently reads:

> The recycle budget is sized from the observed growth rate: at roughly 1 GiB/hour a fresh process reaches the 4 GiB threshold in about four hours, so a 24-hour window needs about six recycles.

That sentence carries no SHA, no date, and no caveat. A future engineer re-tuning the cap has no way to know, from the doc alone, that "1 GiB/hour" already includes a contributor that no longer exists on `main`.

`docs/troubleshooting.md:216-226` independently documents that contributor: on Bun 1.3.x, `Request.clone().json()` never frees the clone's native body buffer, measured at ~950 KiB/request, "which works out to roughly half a gigabyte per hour under sustained traffic" (upstream issue #382).

The timing is the sharp part. The fix for that leak landed on `main` on 2026-09-06 — **three days before** the rate was measured on 2026-09-09 — but was not in the deployed pin at measurement time. Verified by ancestry:

```
git merge-base --is-ancestor e5c46112 0471bb24   -> exit 1 (false): not in the measured build
git merge-base --is-ancestor e5c46112 2387d522   -> exit 0 (true):  already on main
```

So roughly half the measured rate came from a defect already fixed on `main` but not yet running. That does not make the cap increase wrong — it has an independent justification, namely production journal evidence that the old cap was exhausted 38 times across two days. What is wrong is narrower and easy to miss: the *written rate* is a superseded baseline presented as an unqualified fact. An engineer who later retunes the cap by reasoning from "the leak is ~1 GiB/hour" is reasoning from a number that no longer describes the system being tuned.

Note also what the measurement's own staleness window looked like in practice. Deploy timestamps are operational facts that version control does not record, but per this session's own history the measured pin went live 2026-09-06 and was replaced on 2026-09-10 — so by the time the rate reached permanent docs it described a build that was no longer running at all.

## When to Apply

Apply whenever a number observed on a live system is about to be promoted from an incident investigation into something durable: a sizing formula, a threshold, a timeout, a capacity plan, or a rationale comment in code or docs. It applies with most force to performance and capacity numbers, because those are the ones a future engineer reuses as a baseline for a *different* decision rather than reading once and discarding.

It does not apply to numbers that stay scoped to the incident write-up itself — a PR description or an issue comment is naturally dated and SHA-adjacent already. The risk is specifically in promoting a number into prose where it reads as a standing property of the system.

This matters most exactly where merge and deploy are decoupled, which is this repo's normal operating condition. In a continuously-deployed repo, "what is running" and "what is on `main`" converge within minutes and the gap is small — the check is cheap enough to do anyway, but expect it to catch little.

## Examples

**Before — what happened.** A leak rate reported as 0.98 GiB/hour, from a stated 0.11 to 5.99 GiB over 6.2 h, was measured on pin `v3.5.70-0471bb24`, and a rounded version was written straight into `docs/systemd.md` as the sizing rationale for raising the recycle cap — with no ancestry check and no mention of the build the number came from. (Whether anyone checked is not recorded either way; what is verifiable is that the resulting doc carries no provenance.)

Worth noting as its own small lesson: those endpoints do not actually produce that rate. `(5.99 - 0.11) / 6.2 = 0.95` GiB/hour, and no rounding of the stated inputs reaches 0.98. Either the figure came from a fit that was not shown, or it is a few percent overstated. A number published without the derivation that produces it is a number nobody can check — which is the same failure this doc is about, one level down.

**The check that would have surfaced it:**

```
$ git log 0471bb24..origin/main --oneline -- 'packages/providers/**'
...
e5c46112 fix(providers): read cloned request bodies as text, not json() — Bun 1.3.x leaks the body (#382)
...
$ git merge-base --is-ancestor e5c46112 0471bb24; echo $?
1
```

One command shows the measured build predates the clone-leak fix, even though that fix was on `main` days before the measurement was taken.

**After — what the prose should say.** Keep the cap where the journal evidence puts it, but qualify the rate instead of stating it as a bare constant: *"roughly 1 GiB/hour, measured on `v3.5.70-0471bb24` before the `Request.clone().json()` native-buffer leak documented in `docs/troubleshooting.md` was deployed; that fix removes roughly half the measured rate, so re-measure before using this number to retune the cap."* One sentence turns a silently-stale constant into a number a future reader can re-evaluate.

## Related Issues

- Issue #277 — the umbrella native-RSS issue whose containment work produced the measurement.
- Upstream issue #382 — the umbrella native-memory-leak report covering the investigation that identified the `Request.clone().json()` native-body leak, which accounts for roughly half the measured rate. Note `docs/troubleshooting.md` attaches the #382 link to the earlier, already-fixed contributors rather than to the clone-body sentence itself.
- [rss-watchdog-blind-to-swap-evicted-memory.md](../performance-issues/rss-watchdog-blind-to-swap-evicted-memory.md) — the technical fix from the same incident; different layer, and it deliberately does not restate the rate.
- `docs/systemd.md` — holds the sizing paragraph that needs the provenance caveat.
- `docs/troubleshooting.md` — source of truth for the leak mechanism and its measured per-request cost.
