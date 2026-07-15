# Systemd Deployment Guide

Production deployment of better-ccflare as a systemd service on Linux.

## Reference Unit File

```ini
[Unit]
Description=better-ccflare proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=better-ccflare
Group=better-ccflare

# --- Environment ---
Environment=PORT=8889
Environment=BUN_JSC_forceRAMSize=2147483648

# --- Preflight: strip invalid BUN_JSC_* vars before Bun starts ---
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh

# --- Main process ---
# --smol enables aggressive GC (the correct way to reduce memory usage)
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889

# --- Resource limits ---
MemoryMax=3G
MemoryHigh=2G
CPUQuota=200%

# --- Restart policy ---
Restart=always
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5

# --- Security hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/better-ccflare
PrivateTmp=true

# --- Logging ---
StandardOutput=journal
StandardError=journal
SyslogIdentifier=better-ccflare

[Install]
WantedBy=multi-user.target
```

## Memory Management

### The `--smol` flag (recommended)

The `--smol` CLI flag is Bun's **supported** mechanism for reducing memory usage. It enables aggressive garbage collection and is safe for production use:

```ini
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

This is equivalent to JavaScriptCore's "small heap" mode but exposed through Bun's stable CLI interface.

### `BUN_JSC_*` environment variables (dangerous)

Bun exposes `BUN_JSC_*` environment variables that map to internal JavaScriptCore options. These are **unstable, undocumented, and change between Bun versions**.

The critical problem: Bun validates these variables in C++ runtime **before any JavaScript executes**. If an invalid variable is set, Bun exits with code 1 immediately. No user code can catch or prevent this crash.

**Known-valid variables** (use with caution, may break in future Bun versions):

| Variable | Purpose | Example |
|---|---|---|
| `BUN_JSC_forceRAMSize` | Cap JSC heap size in bytes | `2147483648` (2 GB) |
| `BUN_JSC_useJIT` | Disable JIT compilation | `0` |
| `BUN_JSC_forceGCSlowPaths` | Force slow GC paths (debug) | `1` |

**Invalid variables that will crash Bun:**

| Variable | Why it fails |
|---|---|
| `BUN_JSC_smallHeap` | Not a real JSC option despite the name |
| `BUN_JSC_aggressiveGC` | Not a real JSC option |
| Any typo or guess | JSC option validation is strict |

### Rule of thumb

Use `--smol` for memory tuning. Use `BUN_JSC_forceRAMSize` only if you need a specific heap cap. Avoid all other `BUN_JSC_*` variables unless you have verified them against Bun's source code for your exact version.

## Preflight Environment Validator

The `scripts/preflight-env.sh` script strips invalid `BUN_JSC_*` environment variables before Bun starts. It uses an allowlist of known-valid variables and unsets anything else with a warning to stderr.

### Wiring as ExecStartPre

```ini
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

systemd runs `ExecStartPre` before the main process. If a stale or invalid `BUN_JSC_*` variable exists in the environment (from a previous configuration, an inherited environment, or a mistake in the unit file), the preflight script catches it.

### Sourcing interactively

When running better-ccflare outside systemd, source the script before starting:

```sh
. /opt/better-ccflare/scripts/preflight-env.sh
exec bun run better-ccflare --smol --serve
```

## Resource Limits

### Memory

```ini
MemoryMax=3G      # Hard kill if exceeded (OOM)
MemoryHigh=2G     # Kernel applies memory pressure, reclaims pages
```

Set `MemoryMax` above what the process actually needs. `MemoryHigh` applies back-pressure before the hard limit. Combined with `--smol`, this keeps better-ccflare within predictable bounds.

### CPU

```ini
CPUQuota=200%     # Allow up to 2 CPU cores
```

Adjust based on your expected request volume. For most single-proxy deployments, 100-200% is sufficient.

## Restart Policy Best Practices

```ini
Restart=always
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5
```

This means:

- systemd restarts the process on any exit (including crashes)
- It waits 5 seconds between restart attempts
- If the process crashes 5 times within 120 seconds, systemd stops trying and marks the unit as failed
- After a `StartLimitBurst` failure, manual intervention is required: `systemctl reset-failed better-ccflare && systemctl start better-ccflare`

Without the preflight script, an invalid `BUN_JSC_*` variable would burn through all 5 restart attempts in ~25 seconds, causing total proxy downtime until an operator notices.

## Common Pitfalls

### BUN_JSC_smallHeap crash loop

**Symptom:** Service fails immediately on start, burns through `StartLimitBurst`, then stays in failed state.

**Cause:** `BUN_JSC_smallHeap=1` (or similar invalid variable) set in the unit file or inherited environment. Bun validates this in C++ before JavaScript runs, exits code 1.

**Fix:** Remove the invalid variable from the unit file. Use `--smol` flag on `ExecStart` instead. Add the preflight script as `ExecStartPre` to prevent recurrence.

```sh
# Check journal for the crash
journalctl -u better-ccflare --no-pager -n 20

# Reset the failed state
systemctl reset-failed better-ccflare

# Fix the unit file, then reload and start
systemctl daemon-reload
systemctl start better-ccflare
```

### Forgetting daemon-reload

After editing a unit file, you must run `systemctl daemon-reload` before restarting the service. Otherwise systemd uses the cached version.

### Running as root

The reference unit file uses a dedicated `better-ccflare` user. Create it:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin better-ccflare
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

### Database path permissions

If using the default SQLite database, ensure the service user has write access:

```sh
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

Set the database path in the unit file:

```ini
Environment=BETTER_CCFLARE_DB_PATH=/var/lib/better-ccflare/better-ccflare.db
```
## Codex orchestration safety

Codex routing allows one orchestration-capable conversation per identified Claude Code session. The first conversation that offers `Agent` or `Task` becomes the session root. Other conversation identities in that session keep their normal tools but have current `Agent` and `Task` declarations removed. The election is process-local, expires after five hours of orchestration inactivity, and resets when the service restarts. Concurrent independent orchestration roots in one Claude Code session are intentionally unsupported.

Containment is enabled by default. For emergency rollback only:

```ini
Environment=CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT=0
```

This switch disables root election only. Trusted descendant filtering and `CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR` remain active. Remove the override to restore containment.

### Codex prompt-cache-key canary

The Codex prompt-cache-key canary compares the existing conversation-scoped key with a session-scoped key. It is off by default and assigns each eligible Claude session deterministically, so every validated request in that session remains in the same arm across turns, sibling conversations, provider instances, and service restarts.

Configure the canary in the systemd environment:

```ini
Environment=CCFLARE_CODEX_PROMPT_CACHE_KEY=1
Environment=CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT=0
```

`CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT` produces an effective percentage from 0 through 100. Parsing accepts only an unsigned base-10 integer with no sign, fraction, exponent, or surrounding whitespace. Missing, empty, malformed, signed, fractional, exponential, and whitespace-padded values become `0`. Valid integers above `100` clamp to `100`.

Eligible requests must contain valid Claude session metadata. The normalized session UUID is assigned through a domain-separated SHA-256 bucket. Requests outside the configured percentage use the `conversation` control arm, while requests inside it use the `session` treatment arm. Invalid or missing session metadata is not assigned and emits no prompt cache key.

Configuration precedence is:

1. `CCFLARE_CODEX_PROMPT_CACHE_KEY` is the feature gate. Unless it equals `1`, no prompt cache key or eligible experiment assignment is emitted.
2. Missing or malformed Claude session metadata remains ineligible and emits no key.
3. `CCFLARE_CODEX_CACHE_KEY_MODE=session` is an explicit all-session override. It produces a session key and records effective session behavior even if deterministic assignment would select conversation mode.
4. Without the explicit override, the deterministic canary assignment selects the existing conversation or session key derivation.

At `0`, eligible traffic retains the current conversation-key behavior. At `100`, all eligible sessions use session keys. Changing the percentage can reclassify sessions near the threshold, so keep it fixed throughout an observation window. Do not use repeated percentage changes as a ramping mechanism within one cohort window.

#### Trace schema and analysis

Codex trace schema 8 adds these nullable request fields:

| Field | Meaning |
|---|---|
| `cache_key_assignment` | Intended `conversation` or `session` arm for eligible canary traffic |
| `cache_key_cohort_id` | Short domain-separated digest of the normalized session UUID for assignment-stability checks |
| `conversation_id` | Short digest of the logical conversation identity, independent of the outbound cache key |
| `cache_key_assignment_source` | `canary`, `explicit_session_override`, or null |

The existing `prompt_cache_key_set`, `prompt_cache_key_id`, and `cache_key_mode` fields remain authoritative for effective behavior. Assignment and effective mode are intentionally separate so the analyzer can report configuration crossovers rather than infer them from key prefixes. The analyzer joins request and response records only by `request_id`, retains schema 6 and 7 records in an explicit unassigned compatibility bucket, reports unjoined responses separately, and counts assigned requests without responses as missing terminals rather than client aborts.

For each intended arm, the analyzer reports:

- Assigned requests, joined terminal responses, missing-terminal requests, and cache-measured responses
- Weighted cache reuse using only responses with numeric cache telemetry
- Cache-positive response rate with its measured denominator
- Input, output, and cache token totals
- Terminal distributions, including errors, refusals, and `max_tokens`
- Effective-mode distributions and explicit crossover counts
- Model and account distributions
- Logical conversation counts
- First-request and cache-eligible follow-up statistics
- Observed conversation-turn bands derived from all retained records for each `conversation_id`

Use intention-to-treat arm comparisons as the primary result. Check effective-mode crossovers, model and account balance, missing terminals, and complete-session coverage before interpreting cache reuse.

#### Privacy

Schema 8 stores only bounded digests and enum values for the canary. It never stores raw session IDs, prompt material, or outbound cache keys. Internal experiment metadata is stripped before upstream transport. Cache token counts and serialized prefix-boundary byte lengths are different units, so trace analysis must not claim an exact provider token-cache boundary from HMAC boundary telemetry.

Prefix retention and instruction/tool stability require `CCFLARE_CODEX_TRACE_HMAC_KEY`, because summaries written without that key intentionally contain no HMACs. Those comparisons are reported as unavailable rather than changed when HMACs are absent. With a dedicated trace key, traces include bounded cumulative prefix-boundary HMACs and byte lengths, allowing an earlier full input to be compared with the corresponding prefix of a later turn. Old boundaries outside the bounded retention window are also reported as unavailable. The key itself is never written to the trace. Rotate or remove it after the observation window.

#### Rollout and stop conditions

Use this bounded rollout after the schema 8 build is merged and deployed from `refs/heads/main`:

1. Deploy with `CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT=0`. Do not change prompt-key, pacing, routing, model, or orchestration settings.
2. Verify service health, schema 8 trace coverage, stable cohort IDs, distinct and stable conversation IDs, request-response joins, and zero unexpected effective-mode crossovers.
3. Set a small treatment cohort, preferably `10` rather than `1` when an overnight window contains only about ten sessions. Keep the percentage fixed for the full observation window.
4. Compare intention-to-treat weighted reuse, cache-positive rate, follow-up-only behavior, available request latency, terminal outcomes, missing-terminal rate, model and account balance, and orchestration containment indicators.

Stop the canary and return the percentage to `0` if errors, refusals, `max_tokens` terminals, missing terminals, containment failures, or unexpected effective-mode crossovers worsen. Also stop if cache reuse shows no credible benefit after enough complete sessions have been observed. An immediate global switch to session mode is outside this rollout.

Rollback requires only restoring conversation assignment and restarting the service:

```ini
Environment=CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT=0
```

```sh
systemctl daemon-reload
systemctl restart ccflare-stack.service
```

Leave `CCFLARE_CODEX_PROMPT_CACHE_KEY=1` unchanged to preserve the existing conversation-scoped prompt-cache-key behavior. Remove `CCFLARE_CODEX_CACHE_KEY_MODE=session` if an explicit session override was present, because that override takes precedence over the percentage. If prompt cache keys themselves must be disabled, set `CCFLARE_CODEX_PROMPT_CACHE_KEY=0` as a separate rollback decision.

Accounts with mature repeated 429 streaks use process-local single-flight recovery probes after cooldown expiry. Journal events are `cooldown_probe_admitted`, `cooldown_probe_suppressed`, `cooldown_probe_recovery_success`, and `cooldown_probe_reapplied`. The upstream reset time remains authoritative; probe gating prevents concurrent re-entry without imposing a longer fixed cooldown.
