# better-ccflare Configuration Guide

This guide covers all configuration options for better-ccflare, including file-based configuration, environment variables, and runtime API updates.

## Table of Contents

- [Configuration Overview](#configuration-overview)
- [Configuration Precedence](#configuration-precedence)
- [Configuration File Format](#configuration-file-format)
- [Configuration Options](#configuration-options)
- [Environment Variables](#environment-variables)
- [Service-Lifetime Cohort Seal](#service-lifetime-cohort-seal)
- [Claude Code Model Route Profiles](#claude-code-model-route-profiles)
- [Anthropic Degraded Mode](#anthropic-degraded-mode)
- [Implicit Fallback Drain Policy](#implicit-fallback-drain-policy)
- [Guard Request-Body and Admission Limits](#guard-request-body-and-admission-limits)
- [Model Catalog](#model-catalog)
- [Editable Provider Model Defaults](#editable-provider-model-defaults)
- [Runtime Configuration API](#runtime-configuration-api)
- [Example Configurations](#example-configurations)
- [Auto-Fallback Setup](#auto-fallback-setup)
- [Configuration Validation](#configuration-validation)
- [Migration Guide](#migration-guide)

## Configuration Overview

better-ccflare uses a flexible configuration system that supports:

- **File-based configuration**: JSON configuration file for persistent settings
- **Environment variables**: Override configuration for deployment flexibility
- **Runtime updates**: Modify certain settings via API without restart

Configuration is managed through the `@better-ccflare/config` package, which provides automatic loading, validation, and change notifications.

## Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Environment variables** - Always take precedence when set
2. **Configuration file** - Values from `~/.config/better-ccflare/better-ccflare.json` (or custom path)
3. **Default values** - Built-in defaults when no other value is specified

### Special Cases

- **Load balancing strategy**: Environment variable `LB_STRATEGY` overrides file configuration
- **Runtime configuration**: Some values (like strategy) can be changed at runtime via API
- **Anthropic degraded mode**: All policy and diagnostic settings are captured at process start; changing them requires a full restart

## Configuration File Format

The configuration file is stored at:

- **Linux/macOS**: `~/.config/better-ccflare/better-ccflare.json` (or `$XDG_CONFIG_HOME/better-ccflare/better-ccflare.json`)
- **Windows**: `%LOCALAPPDATA%\better-ccflare\better-ccflare.json` (or `%APPDATA%\better-ccflare\better-ccflare.json`)
- **Custom path**: Set via `better-ccflare_CONFIG_PATH` environment variable

### File Structure

```json
{
  "lb_strategy": "session",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

## Configuration Options

### Complete Options Table

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lb_strategy` | string | `"session"` | Load balancing strategy. Supported values are `"session"` (default), `"session-affinity"`, `"session-drain-soonest"`, and `"least-used"`. Prefer a session-based strategy for OAuth accounts; per-request spreading can trigger provider anti-abuse systems |
| `client_id` | string | `"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` | OAuth client ID for authentication |
| `retry_attempts` | number | `3` | Maximum number of retry attempts for failed requests |
| `retry_delay_ms` | number | `1000` | Initial delay in milliseconds between retry attempts |
| `retry_backoff` | number | `2` | Exponential backoff multiplier for retry delays |
| `session_duration_ms` | number | `18000000` (5 hours) | Session persistence duration in milliseconds |
| `port` | number | `8080` | HTTP server port |

### Load Balancing Strategy

⚠️ **WARNING**: Prefer `session`, `session-affinity`, or the opt-in `session-drain-soonest` for Anthropic OAuth traffic because they preserve account stickiness. `least-used` can spread individual requests across accounts and may trigger Claude's anti-abuse systems; reserve it for providers and credentials where per-request balancing is safe. `session-drain-soonest` only changes fresh-session/failover ordering when a known future all-model weekly reset is available; it does not replace an existing client-affinity owner.

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `session` | Maintains client-account affinity for session duration, with automatic alignment to Anthropic OAuth usage window resets | Default and recommended - mimics natural usage patterns and optimizes resource utilization |
| `session-affinity` | Maintains independent client-to-account affinity while preserving automatic failover and session expiry | Multiple concurrent clients that need sticky routing without sharing one global active account |
| `session-drain-soonest` | Opt-in session-affinity variant that ranks fresh candidates by earliest known future all-model weekly reset, then priority/utilization; unknown or stale resets fail open | OAuth pools where weekly capacity should be consumed before it expires while preserving per-client/lane stickiness |
| `least-used` | Orders available accounts by utilization rather than maintaining sticky OAuth sessions | API-key and compatible-provider pools where per-request spreading is explicitly acceptable |

### Logging Configuration (Environment Only)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_LEVEL` | string | `"INFO"` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | string | `"pretty"` | Log format: `"pretty"` or `"json"` |
| `better-ccflare_DEBUG` | string | - | Set to `"1"` to enable debug mode with console output |

## Environment Variables

### Configuration Mapping

| Environment Variable | Config Field | Type | Example |
|---------------------|--------------|------|---------|
| `LB_STRATEGY` | `lb_strategy` | string | `LB_STRATEGY=session` |
| `CLIENT_ID` | `client_id` | string | `CLIENT_ID=your-client-id` |
| `RETRY_ATTEMPTS` | `retry_attempts` | number | `RETRY_ATTEMPTS=5` |
| `RETRY_DELAY_MS` | `retry_delay_ms` | number | `RETRY_DELAY_MS=2000` |
| `RETRY_BACKOFF` | `retry_backoff` | number | `RETRY_BACKOFF=1.5` |
| `SESSION_DURATION_MS` | `session_duration_ms` | number | `SESSION_DURATION_MS=3600000` |
| `PORT` | `port` | number | `PORT=3000` |
| `DATA_RETENTION_DAYS` | `data_retention_days` | number | `DATA_RETENTION_DAYS=3` (payloads) |
| `REQUEST_RETENTION_DAYS` | `request_retention_days` | number | `REQUEST_RETENTION_DAYS=90` (metadata) |
| `better-ccflare_CONFIG_PATH` | - | string | `better-ccflare_CONFIG_PATH=/etc/better-ccflare.json` |

### Additional Environment Variables

These environment variables are not stored in the configuration file and must be set via environment:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `LOG_LEVEL` | Set logging verbosity (DEBUG, INFO, WARN, ERROR) | `INFO` | `LOG_LEVEL=DEBUG` |
| `LOG_FORMAT` | Set log output format (pretty, json) | `pretty` | `LOG_FORMAT=json` |
| `better-ccflare_DEBUG` | Enable debug mode with console output | - | `better-ccflare_DEBUG=1` |
| `better-ccflare_DB_PATH` | Custom database file path (SQLite only) | Platform-specific | `better-ccflare_DB_PATH=/var/lib/better-ccflare/db.sqlite` |
| `DATABASE_URL` | Use PostgreSQL instead of SQLite. Set to a `postgresql://` or `postgres://` connection string. When set, `better-ccflare_DB_PATH` is ignored. | - | `DATABASE_URL=postgresql://user:pass@localhost:5432/ccflare` |
| `CF_PRICING_REFRESH_HOURS` | Hours between pricing data refreshes | `24` | `CF_PRICING_REFRESH_HOURS=12` |
| `CF_PRICING_OFFLINE` | Disable online pricing updates | - | `CF_PRICING_OFFLINE=1` |
| `CF_PRICING_TIMEOUT_MS` | Pricing estimate deadline in milliseconds. Accepts integers from `1` through `60000`; unset or invalid values fall back to `5000` | `5000` | `CF_PRICING_TIMEOUT_MS=10000` |
| `BETTER_CCFLARE_MODELS_REFRESH_HOURS` | Hours between scheduled model catalog refreshes; `0` disables scheduled refresh entirely | `168` (7 days) | `BETTER_CCFLARE_MODELS_REFRESH_HOURS=48` |
| `BETTER_CCFLARE_MODELS_OFFLINE` | Disable scheduled/manual model catalog refresh **and** passive `/v1/models` capture | - | `BETTER_CCFLARE_MODELS_OFFLINE=1` |
| `BETTER_CCFLARE_MODELS_CACHE_DIR` | Directory for the persisted model catalog cache file. Use a persistent directory (not a tmpdir that's wiped on restart) to keep the refresh schedule stable across restarts | Platform tmp dir | `BETTER_CCFLARE_MODELS_CACHE_DIR=/var/lib/better-ccflare` |
| `BETTER_CCFLARE_MODELS_OAUTH_REFRESH` | Allow OAuth accounts as a fallback source for *scheduled* model catalog refreshes when no console/API-key account is eligible. Same as the `model_catalog_oauth_refresh_enabled` config file field; env var takes precedence. Manual refreshes (`POST /api/models/refresh`) always allow the OAuth fallback regardless of this setting | - (console-only) | `BETTER_CCFLARE_MODELS_OAUTH_REFRESH=1` |
| `CCFLARE_MODEL_ROUTE_PROFILES_JSON` | Restart-scoped Claude Code `/model` route profiles. The value is a strict JSON array; malformed nonblank input prevents startup | unset (disabled) | See [Claude Code Model Route Profiles](#claude-code-model-route-profiles) |
| `BETTER_CCFLARE_HOST` | Server binding host | `0.0.0.0` | `BETTER_CCFLARE_HOST=127.0.0.1` (localhost-only) |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | SSL private key / certificate paths for HTTPS | - | `SSL_KEY_PATH=/path/to/key.pem` |
| `CCFLARE_OVERLOAD_RETRY_ENABLED` | In-place retry of Anthropic 529 "no reset" overloads before falling back to account cooldown | `true` | `CCFLARE_OVERLOAD_RETRY_ENABLED=false` |
| `CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS` | Total attempts including the original request | `2` | `CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS=3` |
| `CCFLARE_OVERLOAD_RETRY_BASE_MS` | Overload retry backoff base in ms; `0` = no sleep | `750` | `CCFLARE_OVERLOAD_RETRY_BASE_MS=500` |
| `CCFLARE_OVERLOAD_RETRY_MAX_MS` | Overload retry backoff ceiling in ms | `3000` | `CCFLARE_OVERLOAD_RETRY_MAX_MS=5000` |
| `CCFLARE_OVERLOAD_COOLDOWN_MS` | Fixed per-account cooldown after a 529 (overloaded) response with no Retry-After header. Unlike 429 cooldowns it never ramps with a streak; pairs with a single-flight recovery probe that admits exactly one request once the cooldown expires, as long as another account is available to defer to — if every account in the pool is currently suppressed, the request runs ungated instead | `10000` (10s) | `CCFLARE_OVERLOAD_COOLDOWN_MS=15000` |
| `CCFLARE_OVERLOAD_WITH_RESET_MAX_MS` | Cap on a 529-with-reset cooldown duration (`min(resetTime, now + cap)`). Guards against a multi-hour quota-window reset header (`anthropic-ratelimit-unified-reset`) being mistaken for a short, real retry-after | `60000` (60s) | `CCFLARE_OVERLOAD_WITH_RESET_MAX_MS=120000` |
| `CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS` | Base delay for adaptive per-account 429 cooldown backoff | `30000` (30s) | `CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS=15000` |
| `CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS` | Ceiling for adaptive per-account 429 cooldown backoff | `300000` (5min) | `CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS=600000` |
| `CCFLARE_RATE_LIMIT_RESET_STABILITY_MS` | Window after which a clean streak resets the consecutive-429 counter | `300000` (5min) | `CCFLARE_RATE_LIMIT_RESET_STABILITY_MS=600000` |
| `HEALTH_DETAIL_ENABLED` | Expose per-account status on `GET /health?detail=1` | `false` | `HEALTH_DETAIL_ENABLED=true` |
| `CCFLARE_DISABLE_COMBO_SESSION_FALLBACK` | When enabled, combo-routed requests stop after every combo slot fails instead of falling through to normal SessionStrategy routing. This keeps explicit combo chains isolated, which is useful when combos intentionally separate provider pools (for example Anthropic-only Opus/Fable combos next to Codex-only Sonnet/Haiku combos). Disabled by default to preserve existing behavior | `false` | `CCFLARE_DISABLE_COMBO_SESSION_FALLBACK=true` |
| `CCFLARE_IMPLICIT_FALLBACK_MODE` | Restart-scoped policy for implicit normal/combo fallback. `observe` reports what enforcement would exclude; `enforce` removes denied route classes. Explicit forced and capability-profile routes are outside this policy | `off` | `CCFLARE_IMPLICIT_FALLBACK_MODE=observe` |
| `CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES` | Comma-separated route classes that are explicit exceptions to the active denial set: `oauth-subscription`, `api-key`, `local`, or `cloud-credential` | empty | `CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES=oauth-subscription,local` |
| `CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES` | Comma-separated route classes to deny for implicit fallback. In `observe`/`enforce`, `api-key` and `cloud-credential` are denied by default unless allowed explicitly | empty (plus active defaults) | `CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES=api-key,cloud-credential` |
| `GUARD_MAX_REQUEST_BODY_BYTES` | Maximum request body retained by the front guard before it returns a local 413. Limited requests acquire guard admission before body buffering | `4194304` (4 MiB) | `GUARD_MAX_REQUEST_BODY_BYTES=8388608` (8 MiB; hard max 16 MiB) |
| `GUARD_MAX_BODY_READERS` | Maximum concurrent bounded request-body readers. This pool is separate from upstream permits so trickle uploads cannot monopolize provider concurrency; completed bodies retain a reader slot until an upstream permit is available | `8` (or `2 * GUARD_MAX_ACTIVE`, whichever is larger; hard max 256) | `GUARD_MAX_BODY_READERS=16` |
| `GUARD_REQUEST_DRAIN_TIMEOUT_MS` | Maximum time the guard spends draining a rejected or oversized upload before it destroys the request socket. Prevents stalled clients from pinning file descriptors | `10000` (10s; range 1s-60s) | `GUARD_REQUEST_DRAIN_TIMEOUT_MS=5000` |
| `BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS` | Discover agents distributed by Claude Code plugins (reads `~/.claude/plugins/installed_plugins.json`) | `false` | `BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS=true` |
| `STORE_PAYLOADS` | Set to `false` to stop storing request/response bodies (token counts, cost, model, status, and timing are still recorded) | `true` | `STORE_PAYLOADS=false` |
| `PAYLOAD_ENCRYPTION_KEY` | AES-256-GCM key encrypting `request_payloads` at rest. 64-char hex (32 bytes), generate with `openssl rand -hex 32`. Unset = plaintext storage. Losing the key makes encrypted rows unreadable; read once at process start (and per Bun worker), so rotation needs a re-encrypt migration (not yet built) | - (plaintext) | `PAYLOAD_ENCRYPTION_KEY=$(openssl rand -hex 32)` |
| `CCFLARE_CODEX_PROMPT_CACHE_KEY` | Enabled by default: attach an OpenAI `prompt_cache_key` to converted Codex requests, per [OpenAI's prompt-caching guidance](https://platform.openai.com/docs/guides/prompt-caching) for GPT-5.6-family models. Only applies when the account's resolved endpoint is OpenAI's own `chatgpt.com` / `api.openai.com` — custom/self-hosted OpenAI-compatible endpoints and native Anthropic accounts are unaffected regardless of this setting. Set to `0` to opt out | `1` | `CCFLARE_CODEX_PROMPT_CACHE_KEY=0` |
| `CCFLARE_CODEX_CACHE_KEY_MODE` | Cache key granularity when the above is enabled. `conversation` keys off session id + instructions + first input item, stable per conversation turn and distinct per subagent, so concurrent subagent fan-out does not thrash one OpenAI cache machine. `session` explicitly uses one coarse key per session, shared by all subagents in it. Independent of `LB_STRATEGY`/`SESSION_DURATION_MS`, which pick the upstream *account* for a session rather than the OpenAI-side cache key | `conversation` | `CCFLARE_CODEX_CACHE_KEY_MODE=session` |
| `CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT` | Deterministic session-level canary percentage for comparing conversation and session cache-key modes on eligible OpenAI endpoints. Only unsigned base-10 integers are accepted; malformed values become `0`, and valid values above `100` clamp to `100`. `0` preserves conversation assignment, while `100` assigns every eligible session to session mode. An explicit `CCFLARE_CODEX_CACHE_KEY_MODE=session` still takes precedence | `0` | `CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT=10` |
| `CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT` | Default-off deterministic canary for reusing the bounded orchestration root cache identity across safe conversation continuations such as context compaction. Only unsigned base-10 integers are accepted; malformed values become `0`, and valid values above `100` clamp to `100`. Treatment requires conversation mode, an eligible official OpenAI/Codex endpoint, unchanged orchestration instructions, and validated overlapping `function_call`/`function_call_output` lineage. It never merges rejected siblings, attributed descendants, unrelated instructions, custom endpoints, or explicit session-mode traffic | `0` | `CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT=10` |

### Codex cache-key continuity rollout

`CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT` is intentionally independent of `CCFLARE_CODEX_CACHE_KEY_SESSION_PERCENT`: it changes only the conversation identity selected after the existing bounded orchestration election accepts a continuation. The default is `0`, so existing conversation-key behavior is unchanged. The election state is process-local, bounded, and cleared on restart; it is not a durable identity registry and does not authorize cache reuse from a read-only snapshot.

The opt-in Codex JSONL trace records categorical continuity evidence plus whether the canonical identity was actually applied. `lineage_match` means validated continuity evidence was present; it does not by itself mean the canary selected the canonical cache key. A bounded `continuity_evidence_id` sequences those validated turns, while `canonical_conversation_id` is emitted only for applied treatment. The analyzer therefore keeps derived control compaction turns together, counts their key rotations, and reports rows by application (`canonical`, `derived`, or `unknown`), basis, safe model family, observed turn/gap band, cache-read and cache-write measurements, effective-key concentration, joined responses, and unknown measurements. It never adds prompts, instructions, raw call IDs, raw session UUIDs, credentials, or full cache keys to this provenance output. Existing legacy traces without schema-17 application fields remain readable but are conservatively classified as unknown.

Use a staged rollout on naturally initiated, authorized Codex traffic:

1. Keep the setting at `0` while collecting a baseline trace. Confirm trace joins are healthy and record the control's cache-read ratio, positive-hit rate, zero-hit count, and effective-key concentration.
2. Enable a small deterministic treatment cohort, such as `10`, while retaining a permanent `0`-cohort control. Compare `lineage_match` continuations with `derived` conversation traffic by model and turn/gap band; require more cache reads without higher error/fallback rates or sibling-contamination evidence.
3. Before expanding, confirm `keysOver15RequestsPerMinute` remains `0` for the continuity rows and that `maxRequestsPerKeyMinute` does not create a sustained hotspot. Treat missing or ambiguous joins and unavailable usage as unknown, not as cache misses.
4. Expand only after the compacted-continuation evidence is consistently favorable. The setting does not change retry/rescue-key rotation, WebSocket identity, database schemas, or dashboard analytics.

Rollback is fail-safe: set `CCFLARE_CODEX_CACHE_KEY_CONTINUITY_PERCENT=0` and restart the process. No migration or data cleanup is required; restart also clears the process-local continuity state. Do not validate this feature with scripted traffic against Anthropic-backed or Codex accounts; use focused fixtures or naturally initiated authorized traffic instead.

| `CCFLARE_CODEX_TURN_STATE_PERCENT` | Default-off deterministic percentage for the official Codex HTTP same-turn sticky-routing canary. Account and model allowlists are required first; exact cohort allowlisting is required before an assigned treatment may retain or replay a token. Malformed values become `0`, and valid values above `100` clamp to `100` | `0` | `CCFLARE_CODEX_TURN_STATE_PERCENT=100` |
| `CCFLARE_CODEX_TURN_STATE_ACCOUNT_IDS` | Comma-separated exact account IDs eligible for observe/control/treatment attribution. Empty means no accounts are eligible | empty | `CCFLARE_CODEX_TURN_STATE_ACCOUNT_IDS=account-uuid` |
| `CCFLARE_CODEX_TURN_STATE_MODELS` | Comma-separated exact physical Codex model allowlist, matched case-insensitively. Empty means no models are eligible | empty | `CCFLARE_CODEX_TURN_STATE_MODELS=gpt-5.6-sol` |
| `CCFLARE_CODEX_TURN_STATE_COHORT_IDS` | Comma-separated exact opaque 16-hex cohort IDs discovered through observe-only telemetry. A percentage-selected cohort that is not listed remains token-free control; an empty list permits no treatment | empty | `CCFLARE_CODEX_TURN_STATE_COHORT_IDS=0123456789abcdef` |
| `CCFLARE_CODEX_TURN_STATE_OBSERVE_ONLY` | Set exactly to `1` or `true` to emit bounded eligible cohort/action telemetry without retaining a token or tool lineage and without changing requests. Account and model allowlists are still required | unset | `CCFLARE_CODEX_TURN_STATE_OBSERVE_ONLY=1` |
| `CCFLARE_CODEX_TURN_STATE_MAX_ENTRIES` | Combined process-local ceiling across generation, pending-turn, and attempt records. Only unsigned integers from 1 through 10,000 are accepted; invalid or out-of-range values use the default. Eviction suppresses replay rather than request handling | `2048` | `CCFLARE_CODEX_TURN_STATE_MAX_ENTRIES=1024` |
| `CCFLARE_CODEX_TURN_STATE_IDLE_TTL_MS` | Idle expiry for all process-local turn-state bookkeeping. Only unsigned integers from 1 ms through 24 hours are accepted; invalid or out-of-range values use the default. Active requests are not interrupted | `1800000` (30min) | `CCFLARE_CODEX_TURN_STATE_IDLE_TTL_MS=900000` |

### Codex HTTP same-turn sticky-routing rollout

`x-codex-turn-state` is not a conversation identifier or a durable `previous_response_id`. It follows the official Codex per-turn contract: the first successful tool-use response may supply one token; that exact first token is replayed only on matching tool-result continuations and compatible physical retries in the same logical turn; a new user turn starts without it. Later response tokens cannot replace the first token. Successful `end_turn`, `max_tokens`, and `refusal` terminals retire the state.

The scope is exact account ID + lowercase physical model + the existing privacy-safe selected conversation identity. Continuation requires exact equality with the bounded tool-call lineage in the latest user message. Mixed latest-user content, malformed or duplicate IDs, more than 64 IDs, IDs over 512 UTF-8 bytes, and response tokens over 4 KiB fail closed. One logical request leases a pending lineage; a concurrent request cannot consume it. A lease is held only while that request still has an attempt in flight, so once its last attempt reaches a terminal or is abandoned the claim is released and a later retry is never suppressed by a request that can no longer act. State is process-local, bounded, idle-expiring, and cleared on restart.

The canary applies only to the official ChatGPT-subscription Responses endpoint. A trusted replay-bearing request is forced onto the ordinary HTTP transport and is never offered to the persistent WebSocket lane. Keep WebSocket treatment disabled while evaluating this canary. Client-supplied turn-state headers are removed before conversion, and the provider removes the upstream header from downstream streaming and non-streaming responses.

| Situation | Turn-state behavior |
|---|---|
| Initial request or new user turn | Advance the scoped generation, clear pending state, and send no token |
| Exact latest-user tool-result continuation | Treatment replays the immutable first token; control records only that it would replay |
| `thinking_retry`, `reasoning_retry`, `cache_control_retry`, `prompt_cache_breakpoint_retry`, `overload_529`, or `other_retry` | Reuse only the exact same logical-request lease on the same account/model/conversation |
| `cache_lane_rescue` or `precommit_sse_retry` | Invalidate and suppress, preserving rescue cache-key rotation |
| `account_failover` or `model_fallback` | Invalidate and suppress; a token never crosses the physical account/model boundary |
| Custom endpoint, hosted-search request, synthetic count request, missing binding, ambiguous lineage, expiry, eviction, or concurrent lease | No replay; scoped state is invalidated where a safe scope exists |
| Error, abrupt EOF, cancellation, malformed/incomplete tool call, or stale generation | Never capture or advance state; only a compatible retry of an existing exact lease may continue |

Treatment retains the raw token only in bounded process memory. Observe mode retains no token or lineage; control shadow state retains only token presence and domain-separated call-ID fingerprints. Schema-18 Codex traces store bounded arm/action/terminal categories, an opaque cohort, and keyed token HMACs for request/response matching. A request record is written while the body is transformed, which is before route claiming, so a candidate that is then abandoned — a duplicate route claim or a superseded fallback — is annulled by an `attempt_aborted` record carrying only the request and attempt IDs its request record already held. Analysis drops both records, so requests-per-key pressure, fallback totals, and final-attempt attribution count only attempts that reached the wire. Those turn-state fields never carry the raw token, raw call IDs, lineage sets, session/account IDs, or full cache keys. That guarantee covers the turn-state telemetry only. The separate opt-in `CCFLARE_CODEX_TRACE_FULL=1` mode embeds complete Anthropic and Codex request bodies in the same records, and those bodies do contain raw tool-call IDs, `metadata.user_id` session data, and the full prompt cache key. Full-trace mode records bodies rather than headers, so it never gains the raw turn-state token, but treat its output as sensitive and leave it off for rollout review. The cache-experiment analyzer reports only aggregate treatment/control cache, error, retry, latency, context/gap, HMAC-match, and prompt-key-concentration metrics.

Roll out only on naturally initiated authorized Codex traffic. First obtain fresh operator approval to enable observe-only for one exact account/model scope. After reviewing aggregate cohorts and confirming WebSocket treatment remains off, obtain separate fresh approval before setting a nonzero percentage plus one exact cohort. Require no error/fallback/context-overflow/latency regression and keep every prompt key at or below 15 requests per minute. Read that ceiling from the report-wide `prompt_key_concentration` summary on the turn-state canary line, not from per-row concentration: rows partition one key across arm, model, turn, gap, and context bands, so a key over the limit can sit under it in every individual row. Roll back by setting `CCFLARE_CODEX_TURN_STATE_PERCENT=0`, clearing `CCFLARE_CODEX_TURN_STATE_COHORT_IDS`, and restarting; no migration or data cleanup is required. Never infer Anthropic parity from fixtures, unmatched windows, or aggregate correlation.

| `CCFLARE_CODEX_WS_PERCENT` | Default-off deterministic percentage for the official ChatGPT-subscription Responses WebSocket canary. Assignment is stable per account and `prompt_cache_key`; both account and model allowlists below are also required | `0` | `CCFLARE_CODEX_WS_PERCENT=10` |
| `CCFLARE_CODEX_WS_ACCOUNT_IDS` | Comma-separated exact account IDs eligible for the WebSocket canary. Empty means no accounts are eligible | empty | `CCFLARE_CODEX_WS_ACCOUNT_IDS=account-uuid` |
| `CCFLARE_CODEX_WS_MODELS` | Comma-separated physical Codex model allowlist for the WebSocket canary, matched case-insensitively. Empty means no models are eligible | empty | `CCFLARE_CODEX_WS_MODELS=gpt-5.6-sol` |
| `CCFLARE_CODEX_WS_OBSERVE_ONLY` | Set exactly to `1` or `true` to discover privacy-safe eligible conversation cohort IDs while keeping every request on HTTP. No WebSocket is opened, and idle canary sockets are retired. Account and model allowlists are still required | unset | `CCFLARE_CODEX_WS_OBSERVE_ONLY=1` |
| `CCFLARE_CODEX_WS_COHORT_IDS` | Optional comma-separated allowlist of opaque, restart-stable cohort IDs emitted by observe-only telemetry. When set, non-listed cohorts remain on HTTP before percentage assignment. Use this with `CCFLARE_CODEX_WS_PERCENT=100` to enroll only explicitly selected natural-traffic cohorts instead of relying on a low percentage across a small population | empty | `CCFLARE_CODEX_WS_COHORT_IDS=0123456789abcdef` |
| `CCFLARE_CODEX_WS_MAX_GLOBAL` | Maximum open plus opening canary WebSocket connections process-wide | `32` | `CCFLARE_CODEX_WS_MAX_GLOBAL=8` |
| `CCFLARE_CODEX_WS_MAX_PER_ACCOUNT` | Maximum open plus opening canary WebSocket connections for one account | `8` | `CCFLARE_CODEX_WS_MAX_PER_ACCOUNT=4` |
| `CCFLARE_CODEX_WS_IDLE_TTL_MS` | Retire an idle canary connection after this duration; active requests are never interrupted by TTL cleanup | `300000` | `CCFLARE_CODEX_WS_IDLE_TTL_MS=120000` |
| `CCFLARE_CODEX_WS_MAX_AGE_MS` | Retire a canary connection at this age, capped below the upstream 55-minute maximum; active requests finish first | `3240000` | `CCFLARE_CODEX_WS_MAX_AGE_MS=1800000` |
| `CCFLARE_CODEX_WS_TELEMETRY_WARN` | Default-off telemetry escalation for scoped dogfood canaries. Set exactly to `1` or `true` (case-insensitive) to emit privacy-safe `codex_ws_transport` observations at WARN so a WARN-pinned journal can join `requestId`/`attemptId` to Codex cache traces; otherwise observations remain INFO | unset | `CCFLARE_CODEX_WS_TELEMETRY_WARN=1` |
| `CF_STREAM_USAGE_BUFFER_KB` | Stream usage buffer size in KB | `64` | `CF_STREAM_USAGE_BUFFER_KB=128` |
| `CF_STREAM_TIMEOUT_MS` | Stream processing timeout in milliseconds | `60000` (1 minute) | `CF_STREAM_TIMEOUT_MS=120000` |
| `BETTER_CCFLARE_OUTBOUND_PROXY` | Routes all outbound HTTP(S) traffic through a forward proxy | unset | `BETTER_CCFLARE_OUTBOUND_PROXY=http://127.0.0.1:3636` |
| `CCFLARE_MODEL_DEFAULTS_PROVIDERS` | Comma-separated list of providers whose model-default map is editable via `POST /api/config/provider-model-defaults` and the dashboard's Advanced Settings card. Gates only the override *surface* — every provider's built-in factory map keeps translating models regardless | `codex` | `CCFLARE_MODEL_DEFAULTS_PROVIDERS=codex,xai,qwen` |
| `CCFLARE_XAI_CACHE_NATIVE` | Opt-in: derive a privacy-safe conversation id from the client's Claude session id and attach it as `x-grok-conv-id` on requests to `api.x.ai`, with sticky account affinity so a conversation stays on the account owning its upstream cache partition. Byte-for-byte no-op when unset | unset (off) | `CCFLARE_XAI_CACHE_NATIVE=1` |

## Service-Lifetime Cohort Seal

The Service-Lifetime Cohort Seal is opt-in, passive evidence provenance for eligible official-xAI cache-flight recorder observations. It records which service/profile occurrence and concurrent observation partition produced a retained turn. It does not enable, disable, or tune routing, native cache, keepalive, or provider behavior.

### Activation and eligibility

There is no independent seal flag. A seal receipt follows the existing recorder and native-cache eligibility gates; both environment variables must equal the exact string `1`:

| Setting | Default | Operator contract |
|---|---:|---|
| `CCFLARE_CACHE_FLIGHT_RECORDER` | unset (disabled) | `1` enables privacy-safe recorder IDs and turn capture. Other values, including `true`, are disabled |
| `CCFLARE_XAI_CACHE_NATIVE` | unset (disabled) | `1` enables the native xAI cache path. Other values, including `true`, are disabled |
| `CACHE_FLIGHT_RECORDER_RETENTION_HOURS` / `cache_flight_recorder_retention_hours` | `72` | Retains recorder evidence for 1–336 hours; the environment value takes precedence and values are clamped to that range |
| `CACHE_KEEPALIVE_TTL_MINUTES` / `cache_keepalive_ttl_minutes` | `0` | Captured global keepalive input, clamped to 0–60 minutes; `0` is disabled |
| `CCFLARE_XAI_CACHE_KEEPALIVE_TTL_MINUTES` / `xai_cache_keepalive_ttl_minutes` | `0` | Captured official-xAI override, clamped to 0–60 minutes; a positive value overrides the global TTL for xAI, otherwise xAI inherits a positive global TTL |

A receipt is issued only for a delivered recorder observation when both opt-ins are active, the attempt is for `/v1/messages`, the recorder derived an opaque conversation ID, and the final serving account/provider is xAI on the official xAI endpoint. `CCFLARE_CACHE_FLIGHT_RECORDER=1` can record an otherwise eligible turn while native cache is disabled; that turn remains unsealed. When either opt-in is inactive or the request is ineligible, no seal is issued and the existing provider, routing, cache, and keepalive behavior is unchanged.

### Service epochs and observation partitions

A **service epoch** identifies one occurrence of the captured service profile. Its visible dimensions cover seal-contract semantics, deployment revision, opaque service instance, process start, native-cache state, recorder state, the captured xAI keepalive profile, and a distinct occurrence ID. Any captured profile change or process restart creates a new occurrence. Returning from profile A to B and later to A creates a third occurrence; the original A occurrence is never reopened.

An **observation partition** identifies a concurrent privacy-safe serving-account scope plus route/model epoch inside that service occurrence. Interleaved accounts, routes, or models create or reuse their own partitions without rotating, closing, or merging the service epoch. A report cohort ID combines the privacy-safe service-epoch ID and observation-partition ID as `<serviceEpochId>:<observationPartitionId>`.

This distinction matters operationally: a deployment, restart, recorder/native-cache state change, or changed keepalive profile is a service-lifetime boundary; ordinary interleaving among serving accounts and route/model choices is not.

### Report and health commands

The recorder commands are standalone CLI operations; only the optional `--json` flag may accompany them:

```text
--cache-flight-recorder-report <id> [--json]
--cache-flight-recorder-health [--json]
```

`--cache-flight-recorder-report` reads one retained recorder conversation by opaque ID. Its existing report fields remain unchanged, and the cohort projection is additive under `cohortAnalysis` in JSON and under `Cohort analysis` in human output. Both forms are produced from the same report object and expose the same boundaries, eligibility decisions, unknowns, and rejection reasons; they are not byte-for-byte renderings of one another.

The cohort analysis shows:

- privacy-safe cohort, service-epoch, occurrence, and observation-partition IDs;
- first/last retained observation boundaries, observation counts, and hit/miss/unknown descriptive counts;
- visible `seal_contract_version`, `deployment_revision`, `service_instance`, `process_started_at`, `native_cache_state`, `recorder_state`, `keepalive_policy`, `service_epoch_occurrence`, `serving_account_scope`, `route_model_epoch`, and `seal_receipt` dimensions as known values or `unknown`;
- deterministic, chronologically ordered contributors, represented as recorder conversation ID plus turn sequence;
- blockers whose kind is one of three, kept deliberately distinct because they answer different questions: `changed` when multiple known cohort-selection values genuinely differ; `unknown` when required seal or turn evidence is missing and so cannot support a conclusion; and `not_comparable` when the values are present and known but cannot be compared at all. The last applies to `serving_account_scope` and `route_model_epoch` across a restart: those identifiers are derived per process, so the same account and route produce different identifiers in the next process. Reporting that as `changed` would claim the account changed when only the process restarted, and reporting it as `unknown` would claim the evidence is missing when it is not. A blocker also carries the scope it applies to, so a dimension can legitimately be reported as `changed` within one service instance and `not_comparable` across instances in the same report without contradiction; and
- safe within-cohort subsets containing only complete, dimension-complete, gap-free turns with a known cache outcome under a complete seal with no `changed` blocker. An ineligible cohort can still expose a smaller safe subset when only some of its turns are unsound.

`crossCohortMetric` and `cachePolicyRecommendation` are explicitly `null` in every report. Cohort output is descriptive evidence: never pool incompatible cohorts or infer a cache-policy change across them.

`--cache-flight-recorder-health` is recorder-wide rather than conversation-specific. Its `enabled` field reflects `CCFLARE_CACHE_FLIGHT_RECORDER`, not the combined seal gate. Count units and persistence ratings are:

| Health field | Unit or rule |
|---|---|
| `Retained` / `retainedCount` | Retained conversation count |
| `Incomplete` / `incompleteCount` | Conversations marked incomplete |
| `Dropped` / `droppedCount` | Accumulated lost-evidence events; any value above zero is `unhealthy` |
| `Sealed turns` / `sealedTurnCount` | Turns with a complete projected seal |
| `Unsealed turns` / `unsealedTurnCount` | Turns with no seal reference, including historical turns |
| `Incomplete-seal turns` / `incompleteSealTurnCount` | Turns whose present seal reference is incomplete or malformed |
| `Persistence` / `persistenceHealth` | `unhealthy` for any drop; otherwise `degraded` for an incomplete conversation or incomplete-seal turn; otherwise `healthy` |

Historical unsealed turns alone do not degrade persistence health.

### Evidence completeness and retention

Required facts are captured from the delivered response attempt at write time only. Missing deployment, serving-account-scope, route, or model facts remain `unknown` and make the relevant seal incomplete. An absent or ineligible final serving account produces no receipt instead. A historical null seal reference remains explicitly unsealed. Nothing is reconstructed, inferred, or backfilled from later state.

Seal completeness and turn completeness are independent. A complete seal never upgrades partial, incomplete, gapped, lost, or contradictory turn evidence. Unsound turns remain visible descriptively and are excluded from safe subsets; their evidence is not silently repaired.

There is no durable cohort summary or aggregate. Normalized epoch/partition provenance and turn references are durable, while each report recomputes `cohortAnalysis` from the retained turns in the one requested recorder conversation. Deleting or expiring the final retained contributor removes its cohort summary on the next query. Retention pruning also removes orphan observation partitions and then orphan service epochs after their retained turn references disappear.

### Privacy and behavior boundaries

The seal and additive `cohortAnalysis` store and expose evidence provenance only. No prompt text, request body, credential, raw cache key, raw host, raw serving account ID, raw model, raw route candidate, or secret configuration value enters seal storage or seal output. Serving-account and route/model dimensions are restart-scoped privacy-safe identifiers, and the captured keepalive policy values are non-secret evidence dimensions.

These guarantees apply to the seal additions. Existing legacy recorder report fields are neither removed nor narrowed. The seal observes final routing/native-cache/recorder/keepalive conditions; it does not select an account, alter cache control, schedule keepalives, rewrite a request, or change provider behavior. A seal-capture failure leaves the delivered request behavior intact and records no receipt.

### Runtime verification safety

> [!CAUTION]
> Current builds treat `x-better-ccflare-account-id` as an exact-account, fail-closed route: a conflicting directive, missing or unavailable target, lookup failure, provider exclusion, or exhausted account/model capacity fails before transport instead of entering ordinary account selection. Verify the runtime build before relying on that contract. For evidence-boundary testing, the header is still only an attribution assertion—not the sole isolation boundary—and does not replace disposable catalog isolation.

Live runtime verification may proceed only after proving, before startup and before transport, that the **complete disposable account catalog contains exactly one available approved official-xAI non-Anthropic fixture**. Use a disposable database and runtime, never a normal user or production catalog. If any Anthropic account is present, the intended target is unavailable, or no safe official-xAI non-Anthropic fixture exists, skip the smoke test before sending a proxy request.

Only after that preflight may the request carry `x-better-ccflare-account-id` for attribution. Afterward, verify the persisted serving account and provider match the approved fixture, then compare the human and JSON conversation report boundaries and contributors. A force-route header alone is never evidence that the safe account served the request.

## Claude Code Model Route Profiles

`CCFLARE_MODEL_ROUTE_PROFILES_JSON` adds operator-defined routes to Claude Code's native `/model` picker. A profile can retain the legacy exact-account behavior or use an additive capability pool that resolves an eligible account at request time. The setting is read once at process start. Unset or whitespace-only input configures no profiles and preserves the existing `/v1/models` pass-through behavior. A nonblank value must be valid and conform to the schema below; malformed JSON, unknown fields, duplicate IDs, or invalid values abort startup instead of silently disabling an intended route.

The value is a JSON array with at most 32 objects. This example deliberately uses placeholder account and model values:

```bash
CCFLARE_MODEL_ROUTE_PROFILES_JSON='[
  {
    "id": "premium-reasoning",
    "displayName": "Premium reasoning route",
    "description": "Pins one Claude Code session tree to a dedicated account",
    "accountId": "00000000-0000-0000-0000-000000000000",
    "logicalModel": "claude-example-model",
    "defaultEffort": "xhigh",
    "expectedProvider": "example-provider",
    "expectedPhysicalModel": "example-physical-model"
  }
]'
```

To let one picker entry use every current and future account that serves the same
provider/model capability, omit `accountId` and set `selection` to `capability`:

```bash
CCFLARE_MODEL_ROUTE_PROFILES_JSON='[
  {
    "id": "sol-capability",
    "displayName": "GPT 5.6 Sol pool",
    "description": "Uses any healthy Codex account mapped to GPT 5.6 Sol",
    "selection": "capability",
    "logicalModel": "claude-opus-5",
    "defaultEffort": "xhigh",
    "expectedProvider": "codex",
    "expectedPhysicalModel": "gpt-5.6-sol"
  }
]'
```

Capability profiles are evaluated against the live account catalog on every
request. An account joins when its provider matches `expectedProvider` and the
first physical model produced by its mapping for `logicalModel` matches
`expectedPhysicalModel`. The normal strategy, availability checks, and model or
account capacity checks then order and filter that matching set. Paused,
rate-limited, or exhausted candidates are skipped; an empty set fails closed
with a route-unavailable response and never falls back to an unrelated account.
Adding a new account later therefore requires no profile edit, provided its
provider and mapping satisfy the same capability predicate.

To migrate an existing single-account Sol picker without changing the public
model ID that Claude Code has saved, keep its `id` and replace `accountId` with
`selection: "capability"`, `expectedProvider: "codex"`, and
`expectedPhysicalModel: "gpt-5.6-sol"`. The next process start will resolve the
same picker against every currently eligible matching account; no session or
account UUID is copied into the public discovery response.

| Field | Required | Contract |
|---|---:|---|
| `id` | yes | Unique lowercase kebab-case slug, up to 48 characters. better-ccflare generates the reserved public model ID `claude-bccf-route-<id>`; clients cannot configure a different public ID |
| `displayName` | yes | Picker label, 1–120 characters |
| `description` | no | Operator-facing description, up to 500 characters |
| `selection` | no | Set to `capability` for a live matching-account pool. When omitted, the profile retains legacy exact-account selection |
| `accountId` | conditional | Required for legacy profiles; omit it for `selection: "capability"`. It is never returned by the discovery endpoint |
| `logicalModel` | yes | Claude request model written on an explicit root selection before the account's normal model mapping is applied |
| `defaultEffort` | no | Default used only when the request omits effort. Accepted values: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; an explicit client effort always wins |
| `expectedProvider` | capability: yes; legacy: no | Lowercase provider guard. Capability profiles use it to build the candidate pool; legacy profiles fail closed if the pinned account differs |
| `expectedPhysicalModel` | capability: yes; legacy: no | Guard for the first physical model produced by the account's mapping for `logicalModel`. Capability profiles use it as the pool predicate; legacy profiles fail closed if the pinned account differs |

At startup, better-ccflare logs only the configured profile count, never the JSON, account IDs, logical models, or physical models. Legacy profiles name exact account IDs, so keep those values in a protected environment file or service-manager credential rather than committing a real deployment value. Capability profiles contain no account IDs, but their provider/model constraints are still operational configuration and should be protected accordingly.

### Claude Code `/model` setup

Point Claude Code's Anthropic base URL and authentication at better-ccflare as usual, then enable [gateway model discovery](https://code.claude.com/docs/en/llm-gateway):

```bash
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

When at least one route profile is configured, authenticated `GET /v1/models` requests are answered locally with only each reserved public model ID and display name. Discovery does not select an account or contact an upstream provider. Claude Code labels these entries as gateway models in `/model`.

The reserved IDs are intentionally opaque to Claude Code's built-in model-family inference. To expose effort, `xhigh`, and `max` controls for one discovered profile, pair that same public ID with Claude Code's [custom model option](https://code.claude.com/docs/en/model-config):

```bash
ANTHROPIC_CUSTOM_MODEL_OPTION=claude-bccf-route-premium-reasoning
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Premium reasoning route"
ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Pinned account with explicit effort controls"
ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES=effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking
```

Gateway discovery can list multiple profiles; Claude Code's custom-model variables describe one option. Pairing the exact same ID augments that discovered row with the declared capabilities instead of creating a different route. `xhigh` and `max` remain explicit picker/request overrides: choosing the route does not silently force `max`, and `defaultEffort` applies only when Claude Code sends no effort.

Selecting a profile on a root agent pins only that authenticated caller's Claude Code session tree. Legacy profiles inherit the exact account. Capability profiles inherit the root capability predicate (provider plus root logical/physical mapping), then use each child request's own model for capacity and dispatch; children cannot broaden the pool to accounts that do not satisfy the root predicate. Other sessions continue through ordinary better-ccflare routing. Switching the same root session back to a native Claude model clears its profile binding on the next root request.

Bindings are process-local, bounded, and restart-scoped. Their TTL matches `session_duration_ms`, and a restart clears every binding. Missing, paused, unavailable, rate-limited, or quota-exhausted exact accounts fail closed; capability profiles fail closed when no matching candidate remains, without falling back outside the profile. Configured provider and physical-model guards also fail closed, as does a conflicting `x-better-ccflare-account-id` header. Matching is exact: an OpenRouter account mapped to `fusion`, for example, does not satisfy a capability profile expecting provider `codex` and physical model `gpt-5.6-sol`. See [Account Routing Architecture](./routing-architecture.md#claude-code-model-route-profiles) for the request flow and inheritance boundary.

## Anthropic Degraded Mode

Anthropic degraded mode is an opt-in, restart-scoped safety layer for large native Anthropic OAuth requests during a confirmed provider-cohort overload. It is `off` by default. For the routing and recovery model, see [Account Routing Architecture](./routing-architecture.md#anthropic-degraded-mode); for staged activation and rollback, see [Systemd Deployment](./systemd.md#anthropic-degraded-mode-rollout).

| Mode | Effect |
|---|---|
| `off` | No cohort evidence is retained and existing routing, ownership, transport, response, and retry behavior is unchanged. |
| `observe` | Builds isolated shadow state and reports the decisions enforcement would make. It does not change candidate order, cache-owner mappings, provider sends, responses, or retry counts. Shadow state is discarded on restart and is never promoted into enforcement state. |
| `enforce` | Bounds large-request sends and preserves an established cache owner when available after a matching cross-account overload quorum. This is supported only when all affected traffic shares one server-process coordinator. Separate replicas can each elect one recovery probe. |

Environment values take precedence over the matching configuration-file fields. All numeric settings require safe integers, including when supplied as strings through the environment.

| Environment variable | Configuration-file field | Default | Accepted value or bound |
|---|---|---:|---|
| `CCFLARE_ANTHROPIC_DEGRADED_MODE` | `anthropic_degraded_mode` | `off` | `off`, `observe`, or `enforce` |
| `CCFLARE_ANTHROPIC_DEGRADED_LARGE_REQUEST_TOKENS` | `anthropic_degraded_large_request_tokens` | `100000` | `10000`–`2000000` tokens |
| `CCFLARE_ANTHROPIC_DEGRADED_LARGE_REQUEST_BYTES` | `anthropic_degraded_large_request_bytes` | `262144` | `65536`–`16777216` bytes |
| `CCFLARE_ANTHROPIC_DEGRADED_EVIDENCE_WINDOW_MS` | `anthropic_degraded_evidence_window_ms` | `30000` | `5000`–`300000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_QUORUM` | `anthropic_degraded_quorum` | `2` | `2`–`8` distinct underlying accounts |
| `CCFLARE_ANTHROPIC_DEGRADED_RETRY_MIN_MS` | `anthropic_degraded_retry_min_ms` | `5000` | `1000`–`60000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_RETRY_FALLBACK_MS` | `anthropic_degraded_retry_fallback_ms` | `10000` | `1000`–`300000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_RETRY_MAX_MS` | `anthropic_degraded_retry_max_ms` | `60000` | `5000`–`300000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_RECOVERY_WINDOW_MS` | `anthropic_degraded_recovery_window_ms` | `30000` | `5000`–`300000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_PROBE_LEASE_MS` | `anthropic_degraded_probe_lease_ms` | `600000` | `60000`–`900000` ms |
| `CCFLARE_ANTHROPIC_DEGRADED_MAX_COHORTS` | `anthropic_degraded_max_cohorts` | `1024` | `1`–`10000` retained cohorts |
| `CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS` | `anthropic_degraded_diagnostics_enabled` | `false` | Environment: `true`/`1` or `false`/`0`; file: JSON boolean |

The retry values must also satisfy `retry min <= retry fallback <= retry max`. If the mode or any numeric policy setting is malformed, out of range, or violates that relationship, the entire policy resolves atomically to the built-in defaults (including mode `off`) and writes a warning. It never runs with a partially accepted policy. An invalid diagnostic flag separately leaves detailed diagnostics off and writes a warning.

All cohort, probe, shadow-owner, and diagnostic-correlation state is in memory. A restart clears it, rotates the opaque boot identity, and starts fresh in the configured mode; there is no database migration or cleanup step. Configuration API writes do not hot-switch a running coordinator.

### Aggregate health

Ordinary `GET /health` includes a fixed, aggregate-only `runtime.anthropicDegraded` object. The existing short health cache can delay a new snapshot by about two seconds.

| Group | Fields |
|---|---|
| Identity and policy | `schemaVersion`, opaque `bootId`, `mode`, `diagnosticsEnabled`, and `thresholds.{largeRequestTokenThreshold,largeRequestByteThreshold,evidenceWindowMs,quorum,retryMinMs,retryFallbackMs,retryMaxMs,recoveryWindowMs,probeLeaseMs,maxCohorts}` |
| Cohort state | `cohorts.total`, `cohorts.byState.{collecting,open,probing,recovering}`, `cohorts.ageBands.{under30Seconds,from30SecondsTo5Minutes,atLeast5Minutes}`, and `activeProbes` |
| Attempt accounting | `attempts.{logical,guard,local,physical}` |
| Decisions and terminals | `decisions.{suppressedSends,wouldSuppressSends,probeSends,wouldProbeSends}` and `terminals.{success,overload,suppressed,failure,cancelled,timeout}` |
| Pressure | `droppedEvents`, `droppedEvidence`, and `saturation` |

Health never exposes exact request sizes, per-cohort/account/owner identifiers, or diagnostic event history. Enabling `HEALTH_DETAIL_ENABLED` does not add degraded-mode joins or a detailed degraded-mode route.

### Detailed diagnostics

`CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS=true` enables bounded, privacy-safe structured events after the next restart. The default is `false`. Each accepted line is written to stdout as JSON with `event: "anthropic_degraded_mode"` and is captured by journald in the production unit. Event kinds cover request risk, physical attempts, would-suppress/suppress decisions, quorum/probe/owner transitions, and terminal outcomes. Exact bounded byte/token estimates and boot-scoped opaque joins appear only in this stream.

Detailed events never include prompts, reasoning, tool payloads, response bodies, credentials, raw account or session identifiers, endpoint URLs, or arbitrary serialized errors. Delivery is bounded and nonblocking; dropped events increment `droppedEvents` and cannot affect routing or lease cleanup. The application provides no public HTTP endpoint or queryable history for these records.

Enable diagnostics only for a bounded observation window after verifying who can read the service journal and that journald has explicit size and time retention. See [Journal access and retention](./systemd.md#journal-access-and-retention). Disable diagnostics and restart when the window ends.

For a WebSocket cache canary, export the bounded service journal window as JSONL and join it to the matching Codex trace. The analyzer accepts direct transport observations, logger JSON, and `journalctl -o json` records; it excludes duplicate or ambiguous identities and prints aggregate-only output:

```sh
journalctl -u ccflare-stack.service --since "2026-07-22 12:00:00 UTC" --until "2026-07-22 12:30:00 UTC" -o json > /tmp/codex-ws-observations.jsonl
bun run packages/providers/src/providers/codex/analyze-trace.ts --cache-experiments --ws-observations /tmp/codex-ws-observations.jsonl /path/to/codex-trace-2026-07-22.jsonl
```

The raw journal export still contains ephemeral join identities and must be protected and deleted after analysis. The formatted report never emits request or attempt IDs, cohort hashes, account IDs, endpoints, model strings, prompts, or unknown action values.

Model-family capacity handling is integrated into account selection and does not require a standalone feature flag. Fresh Anthropic `limits[]` telemetry is interpreted by scope: exhausted `session` and `weekly_all` windows exclude the account, while an exhausted `weekly_scoped` row excludes only requests for the matching model family when paid overage is confirmed unavailable. Stale, malformed, unrelated, or incomplete scoped telemetry fails open, and observed upstream capacity responses provide short-lived reactive evidence while telemetry catches up.

## Implicit Fallback Drain Policy

The implicit fallback drain is a **restart-scoped** policy for ordinary and combo candidate selection. It is `off` by default. The process snapshots the policy at startup; changing an environment variable or config-file value does not hot-switch a running process. This documentation is an operator example and does not imply that any current live deployment has been changed.

| Mode | Behavior |
|---|---|
| `off` | Preserve existing implicit normal/combo candidate admission and ordering. |
| `observe` | Evaluate the policy and emit bounded diagnostics, but return the original candidates; no candidate order, provider send, response, or retry changes. Unknown route classes are observed but allowed. |
| `enforce` | Remove denied route classes from implicit normal/combo candidates. Unknown route classes fail closed. If every implicit candidate is removed, selection ends locally with no provider attempt. |

Route classes are derived from provider and credential shape, not from secret values:

| Route class | Examples |
|---|---|
| `oauth-subscription` | Native subscription/OAuth credentials. |
| `api-key` | API-key routes, including OpenRouter and compatible API providers. |
| `local` | Local Ollama routes. |
| `cloud-credential` | Cloud-credential routes such as Bedrock or Vertex AI. |

`CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES` and `CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES` accept comma-separated, case-insensitive class names (duplicates are ignored). In an active mode, the conservative default denial set is `api-key,cloud-credential`; an allowed class removes that class from the denial set, and a denied class adds to it. The allowed list is therefore an exception list, not an exclusive allowlist. Malformed modes or class names resolve the entire policy to the built-in `off` policy and write a warning. The equivalent file fields are `implicit_fallback_mode`, `implicit_fallback_allowed_classes`, and `implicit_fallback_denied_classes`; environment values win per field.

The policy applies only to **implicit** normal and combo fallback. An explicit `x-better-ccflare-account-id` route, an exact model route profile, and a capability model route profile retain their own fail-closed admission and bypass this drain policy. This lets an operator stop accidental OpenRouter/API-key spillover while preserving intentional, explicitly selected routes.

### Safe production activation example

For a deployment that should keep OAuth and local routes in the implicit pool while excluding OpenRouter/API-key and cloud-credential spillover, stage `observe` first, then use `enforce` after reviewing the bounded diagnostics. The following shell values are illustrative; apply them to the service environment and restart the service for each mode change:

```sh
# Stage first: no routing behavior changes, only policy observations.
export CCFLARE_IMPLICIT_FALLBACK_MODE=observe
export CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES=oauth-subscription,local
export CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES=api-key,cloud-credential

# After review, switch the same environment to:
# export CCFLARE_IMPLICIT_FALLBACK_MODE=enforce
```

OpenRouter accounts classify as `api-key` and are consequently excluded from **implicit** fallback in the enforced example. OAuth and local accounts remain eligible. An explicit force route or capability profile can still select its declared route by design.

### Monitoring, guardrails, and rollback

After an activation restart, inspect the service journal for the rate-limited terms `Implicit fallback policy` (candidate counts by `normal`/`combo` lane) and `Routing selection terminal diagnostics` (selection-terminal counts and reason). Sample route-unavailable responses for the bounded `error.routing_diagnostics` object described in [Account Routing Architecture](./routing-architecture.md#selection-diagnostics). Do not treat a policy observation as proof that a provider was contacted: `attempted_routes: 0` means selection ended before any provider attempt.

The front guard exposes its effective body limit and bounded counters at `GET /_guard/health`; monitor `maxRequestBodyBytes`, `maxBodyReaders`, `requestDrainTimeoutMs`, `active`, `queued`, `bodyReaders`, `draining`, and `counters.oversizedRequestBodies`/`counters.requestDrainTimeouts`. Useful journal terms are `guard_request_body_too_large`, `guard_request_drain_timeout`, `guard_queue_full`, `guard_body_reader_queue_full`, `guard_admission_error`, and `guard_draining`. These records contain bounded metadata only; request bodies and credentials are not logged.

To roll back the drain, set `CCFLARE_IMPLICIT_FALLBACK_MODE=off` in the service environment and **restart** the process (run `systemctl daemon-reload` first if a systemd drop-in changed). Restarting clears the process-local policy snapshot and diagnostics; it does not alter account data or current production state outside that restart.

## Guard Request-Body and Admission Limits

`GUARD_MAX_REQUEST_BODY_BYTES` bounds the body buffer used by the local front guard. The default is **4 MiB** (`4,194,304` bytes); values may be lowered to 1 KiB, but the hard maximum is **16 MiB** (`16,777,216` bytes). Invalid or out-of-range values prevent an unbounded override. A declared `Content-Length` above the limit is rejected before buffering. Chunked or misleading uploads are counted as bytes arrive and are stopped at the same limit; the guard drains the remainder so keep-alive parsing stays synchronized. The client receives `413` with error type `guard_request_body_too_large`.

The limit applies to every guarded request body. For limited inference paths (`/v1/messages` except `count_tokens`, and `/v1/complete`), the guard first reserves fair admission **before** attaching body listeners or buffering bytes. It then releases the upstream permit while the bounded body-reader pool handles the upload, so a slow client cannot consume provider concurrency. A completed body keeps its body-reader slot until it acquires an upstream permit; this bounds retained body buffers while preserving fair upstream ordering. Queue-full, shutdown, and abort decisions therefore happen before an unadmitted request can consume an aggregate body buffer. Other paths still receive the body-size bound but do not consume a limited-path admission slot.

Rejected, oversized, invalid-target, and shutdown uploads are drained only for the configured drain window (`GUARD_REQUEST_DRAIN_TIMEOUT_MS`). If the client does not finish, the guard destroys that request socket and emits `guard_request_drain_timeout`; this prevents a stalled peer from pinning a keep-alive connection or file descriptor indefinitely. The effective body-reader count, queue, and timeout appear in `/_guard/health` and in the `runtime.limits` object.

The effective limit is restart-scoped in the guard process. Confirm it after restart in `/_guard/health` (`maxRequestBodyBytes` and `runtime.limits.maxRequestBodyBytes`) and correlate 413s with `guard_request_body_too_large` and `counters.oversizedRequestBodies`; no request content is retained in these diagnostics.

## Outbound Proxy

better-ccflare can route all of its outbound HTTP(S) traffic — provider requests, OAuth flows, usage polling, and webhooks — through an explicit forward proxy using HTTP CONNECT. This is useful for enterprises that want every egress connection from better-ccflare to pass through a security/inspection proxy.

Configure it via the `BETTER_CCFLARE_OUTBOUND_PROXY` environment variable (or the equivalent `outbound_proxy` config file key); env var takes precedence over the config file value, matching the pattern used elsewhere in this doc. A dedicated variable is used instead of the conventional `HTTPS_PROXY`/`HTTP_PROXY` because those affect every process on the machine by convention — a dedicated variable lets operators scope the proxy to just this application (e.g. via MDM/provisioning) without redirecting traffic for every other tool.

Loopback destinations (`localhost`, `127.0.0.0/8` addresses, `::1`) are always exempt and never routed through the configured proxy, so local testing setups (e.g. a local Ollama or LiteLLM instance) keep working unaffected.

If the forward proxy performs TLS interception (MITM), such as an LLM security/inspection gateway, its CA certificate must be trusted by the Node/Bun process. Set `NODE_EXTRA_CA_CERTS` as a real environment variable at process launch — not inside a `.env` file loaded at runtime — since it must be present before the process starts.

This setting operates at the transport layer and is unrelated to a per-account `custom_endpoint`, which is a URL/routing-level override rather than a proxy.

Coverage spans both the running server process and CLI-only commands that never start the server (e.g. `better-ccflare --add-account`, `--reauthenticate`) — account management and OAuth flows invoked directly from the CLI are proxied the same way; the one carve-out is the embedded database-maintenance worker threads, which run in their own global scope outside this wrapper, but they make no outbound HTTP requests themselves so no traffic escapes unproxied through them.

## Alerts

better-ccflare can emit threshold and anomaly alerts and deliver them via webhook and the dashboard. Alerts are persisted to the same database as requests and deduplicated per cooldown bucket; persistence is best-effort — a database failure is logged and skipped rather than failing the request or crashing the proxy. All `ALERT_*` env vars have equivalent config-file fields (`alert_daily_spend_usd`, `alert_tokens_per_hour`, `alert_request_tokens`, `alert_anomaly_enabled`, `alert_anomaly_interval_minutes`, `alert_cooldown_minutes`, `alert_webhook_url`); env vars take precedence.

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `ALERT_DAILY_SPEND_USD` | Fire a warning alert when aggregate spend since local midnight meets or exceeds this USD amount. Clamped to `[0, 1000000]`; `0` disables | `0` | `ALERT_DAILY_SPEND_USD=25` |
| `ALERT_TOKENS_PER_HOUR` | Fire a warning alert when total tokens consumed in the trailing hour meets or exceeds this count. `0` disables | `0` | `ALERT_TOKENS_PER_HOUR=500000` |
| `ALERT_REQUEST_TOKENS` | Fire a critical alert when a single request's total token count meets or exceeds this value. `0` disables | `0` | `ALERT_REQUEST_TOKENS=200000` |
| `ALERT_ANOMALY_ENABLED` | Run periodic anomaly detection over recent requests (token outliers, output blowups, runaway loops, model misrouting). Accepts `1`/`true`/`0`/`false` | `false` | `ALERT_ANOMALY_ENABLED=true` |
| `ALERT_ANOMALY_INTERVAL_MINUTES` | Cadence of anomaly-detection sweeps, in minutes. Clamped to `[5, 1440]` | `15` | `ALERT_ANOMALY_INTERVAL_MINUTES=30` |
| `ALERT_ANOMALY_LOOP_MIN_REQUESTS` | Minimum request count in the detection window before the runaway-loop detector will flag a burst, keyed per account + model + project + agent (with the `x-claude-code-session-id` header as an attribution fallback). Set above the rate a single legitimate worker reaches in the window so a true loop (50+ req/min) stands out. Clamped to `[5, 1000]` | `25` | `ALERT_ANOMALY_LOOP_MIN_REQUESTS=50` |
| `ALERT_COOLDOWN_MINUTES` | Per-alert-type-and-scope cooldown bucket size in minutes — within a bucket, only the first alert is persisted and delivered (no SSE storms or duplicate webhooks). Clamped to `[1, 1440]` | `60` | `ALERT_COOLDOWN_MINUTES=120` |
| `ALERT_WEBHOOK_URL` | `http(s)` URL to receive `POST` deliveries of `{ type: "alert", alert: { ... } }`. Unset = no webhook delivery. Must be a valid URL or the setter rejects it | unset | `ALERT_WEBHOOK_URL=https://example.com/alerts` |

In addition to threshold alerts, an `auth_failure` alert (severity `critical`) fires automatically when an OAuth account's refresh token fails definitively (e.g. `invalid_grant`) and the account is marked `requires_reauth`. It is deduplicated by the same cooldown bucket as the threshold alerts.

Alerts are listed on the dashboard and via the API; unacknowledged counts surface in `/health`. Persistence uses dialect-appropriate conflict handling (`INSERT OR IGNORE` on SQLite, `ON CONFLICT (id) DO NOTHING` on PostgreSQL), so alerts work identically on both backends.

## Database Configuration

better-ccflare supports two database backends:

| Backend | When used | Environment variable |
|---------|-----------|---------------------|
| **SQLite** (default) | `DATABASE_URL` is not set, or starts with `sqlite://` | `BETTER_CCFLARE_DB_PATH` (optional path override) |
| **PostgreSQL** | `DATABASE_URL` starts with `postgres://` or `postgresql://` | `DATABASE_URL=postgresql://user:pass@host:5432/db` |

### SQLite (default)

No configuration required. The database is created automatically in the platform-specific directory (`~/.config/better-ccflare/better-ccflare.db`).

```bash
# Optional: store database at a custom path
export BETTER_CCFLARE_DB_PATH=/var/lib/better-ccflare/better-ccflare.db
```

### PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string:

```bash
export DATABASE_URL=postgresql://ccflare_user:secret@localhost:5432/ccflare
```

The schema and any missing columns are created automatically on startup. No manual migration steps are required. This backend is recommended for Kubernetes or other multi-pod deployments where multiple instances need to share the same database.

**Connection tuning** (PostgreSQL only — see [database.md](database.md#postgresql-connection-tuning) for details):

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_CCFLARE_DB_POOL_MAX` | `10` | Maximum pooled connections |
| `BETTER_CCFLARE_DB_IDLE_TIMEOUT` | `0` (disabled) | Seconds before an idle pooled connection is closed |
| `BETTER_CCFLARE_DB_STATEMENT_TIMEOUT` | `7000` | Server-side statement timeout in milliseconds (clamped below the 8000ms client-side timeout) |
| `BETTER_CCFLARE_DB_PG_PREPARE` | `false` | Set to `true` to re-enable named prepared statement caching |

```yaml
# Kubernetes Secret example
apiVersion: v1
kind: Secret
metadata:
  name: better-ccflare-secrets
type: Opaque
stringData:
  database-url: "postgresql://ccflare_user:secret@postgres-svc:5432/ccflare"
```

```yaml
# Deployment env reference
env:
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: better-ccflare-secrets
      key: database-url
```

## Model Catalog

better-ccflare maintains a cache of the Anthropic model catalog (id, display name, creation date) used to populate model dropdowns in the dashboard (agent preferences, default agent model). It's exposed read-only via `GET /api/models` and force-refreshable via `POST /api/models/refresh` — see [api-http.md](api-http.md#model-catalog) for the endpoint reference.

### Why this isn't fetched from every account

A consumer OAuth account (`claude-oauth` mode) is meant for interactive Claude Code traffic. Recurring background API calls — and the proactive OAuth token refreshes they can trigger — are an atypical automation pattern for that account type and risk a flag or ban. API-key accounts (`console`, `zai`, `minimax`, `muse-spark`, `anthropic-compatible`, `openai-compatible`) are the sanctioned surface for unattended, programmatic requests. Because of this, the model catalog refresh is deliberately restrictive by default:

- **Scheduled (automatic) refresh**: only console/API-key accounts are eligible, unless `BETTER_CCFLARE_MODELS_OAUTH_REFRESH=1` (or the `model_catalog_oauth_refresh_enabled` config field) opts in to an OAuth fallback.
- **Manual refresh** (`POST /api/models/refresh`, human-triggered from the dashboard or `curl`): always allows the OAuth fallback in addition to console accounts, since a one-off manual action doesn't carry the same recurring-automation risk.
- If no eligible account exists at all, a refresh (scheduled or manual) is a no-op — the existing cached catalog (live or bundled fallback) is left untouched; it's never emptied or errored out.

### Refresh cadence

When at least one eligible account exists, the catalog refreshes automatically on a schedule controlled by `BETTER_CCFLARE_MODELS_REFRESH_HOURS` (default **168 hours / 7 days**; `0` disables scheduled refresh). To avoid many independently-restarting instances all hitting Anthropic at the same wall-clock moment, each scheduled refresh is smeared with random jitter (up to 24 hours) on top of the configured interval. Every successful catalog write — scheduled, manual, or passive (see below) — recomputes and persists the next scheduled refresh time, so the schedule stays anchored to the most recent real data rather than drifting.

### Passive capture

Any successful `GET /v1/models` response proxied through better-ccflare from a console/API-key account (a client calling the pass-through endpoint directly) is also captured into the catalog cache opportunistically, independent of the scheduled/manual refresh paths. This never triggers extra outbound calls — it only observes traffic that was going to happen anyway.

### Bundled fallback

If no live fetch has ever succeeded (fresh install, no eligible account, or `BETTER_CCFLARE_MODELS_OFFLINE=1`), `GET /api/models` serves a static list bundled with better-ccflare (`CLAUDE_MODEL_IDS` in `packages/core/src/models.ts`). Its response reports `source: "fallback"` and a `fetchedAt` timestamp equal to the bundled list's snapshot date (`BUNDLED_MODELS_AS_OF`), not the current time — this is an intentional, honest "as of `<date>`" provenance rather than a `Date.now()` that would misleadingly imply the list was just fetched. The dashboard surfaces this distinction next to the model catalog's refresh button ("Live model list · fetched ..." vs. "Bundled model list · as of ...").

## Editable Provider Model Defaults

When a request has no combo-slot model and no account-level model mapping, better-ccflare falls back to a per-provider, per-family default model map. For most providers that map is compiled in; for Codex it's derived live from the account's own model listing (`chatgpt.com/backend-api/codex/models`), since the compiled guess (`gpt-5.3-codex` for opus/sonnet) 400s on ChatGPT-subscription accounts that don't support it.

Resolution order:

```
combo slot model -> account.model_mappings -> global override -> account listing (Codex only) -> factory map
```

The **global override** is an editable layer in between: an operator-set default per provider+family that applies when no combo slot or account mapping specifies a model. It's stored in the config file, applied via an in-memory registry populated at boot and refreshed on every `POST`, and takes effect immediately — no restart required. Overrides are merged per family, so setting `codex.opus` never clears `codex.haiku`. Setting a family to an empty string removes its override rather than mapping it to an empty model.

Only `codex` is editable by default. `xai` and `qwen` use the same mechanism but are gated behind `CCFLARE_MODEL_DEFAULTS_PROVIDERS` (see [Additional Environment Variables](#additional-environment-variables)) since they haven't been exercised against real accounts as extensively. Disabling a provider doesn't discard its stored override — it just stops applying until the provider is re-enabled.

Manage this via the dashboard (Settings → Advanced → Provider Model Defaults) or directly through the API — see [api-http.md](api-http.md#get-apiconfigprovider-model-defaults).

## Runtime Configuration API

Some configuration values can be updated at runtime through the HTTP API without restarting the server.

### Available Endpoints

#### Get Current Configuration
```http
GET /api/config
```

Response:
```json
{
  "lb_strategy": "session",
  "port": 8080,
  "sessionDurationMs": 18000000
}
```

Note: The API response uses camelCase (`sessionDurationMs`) while the configuration file uses snake_case (`session_duration_ms`).

#### Get Current Strategy
```http
GET /api/config/strategy
```

Response:
```json
{
  "strategy": "session"
}
```

#### Update Strategy
```http
POST /api/config/strategy
Content-Type: application/json

{
  "strategy": "session"
}
```

Response:
```json
{
  "success": true,
  "strategy": "session"
}
```

#### Get Available Strategies
```http
GET /api/strategies
```

Response:
```json
["session", "least-used", "session-affinity", "session-drain-soonest"]
```

The `session-drain-soonest` strategy is opt-in. It preserves the current
session-affinity owner and route/profile class; only a fresh assignment or
account failover can use a known future `weekly_all`/`seven_day` reset to rank
candidates. Missing, malformed, or past reset telemetry falls back to the
ordinary affinity ranking.

### Runtime Update Behavior

- Strategy changes take effect immediately for new requests
- Existing sessions (for session strategy) are maintained until expiration
- Configuration file is automatically updated when changed via API
- Change events are emitted for monitoring and logging

## Example Configurations

### High Throughput Setup

Optimized for maximum request throughput with minimal overhead:

```json
{
  "lb_strategy": "session",
  "retry_attempts": 2,
  "retry_delay_ms": 500,
  "retry_backoff": 1.5,
  "session_duration_ms": 300000,
  "port": 8080
}
```

Environment variables:
```bash
export LB_STRATEGY=session
export RETRY_ATTEMPTS=2
export RETRY_DELAY_MS=500
export SESSION_DURATION_MS=300000  # 5 minutes
export LOG_LEVEL=WARN  # Reduce logging overhead
```

### Session Persistence Setup

Ideal for maintaining conversation context with Claude:

```json
{
  "lb_strategy": "session",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 21600000,
  "port": 8080
}
```

Environment variables:
```bash
export LB_STRATEGY=session
export SESSION_DURATION_MS=21600000  # 6 hours
export RETRY_ATTEMPTS=3
export LOG_LEVEL=INFO
```

### Development Setup

Configuration for local development and debugging:

```json
{
  "lb_strategy": "session",
  "retry_attempts": 5,
  "retry_delay_ms": 2000,
  "retry_backoff": 2,
  "session_duration_ms": 3600000,
  "port": 3000
}
```

Environment variables:
```bash
export PORT=3000
export LOG_LEVEL=DEBUG
export LOG_FORMAT=pretty
export better-ccflare_DEBUG=1
export RETRY_ATTEMPTS=5
```

### Production Setup

Recommended configuration for production deployments:

```json
{
  "lb_strategy": "session",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 7200000,
  "port": 8080
}
```

Environment variables:
```bash
export LB_STRATEGY=session
export SESSION_DURATION_MS=7200000  # 2 hours
export LOG_LEVEL=INFO
export LOG_FORMAT=json
export CF_PRICING_OFFLINE=1  # Reduce external API calls
```

### Auto-Fallback Setup

Configuration for optimizing account usage with automatic fallback to higher priority accounts. **Note**: Auto-fallback is only available for Anthropic accounts.

```json
{
  "lb_strategy": "session",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

**Setup Script for Auto-Fallback Configuration:**

```bash
#!/bin/bash
# Setup accounts with auto-fallback for optimal usage

# Add primary account with highest priority and auto-fallback enabled
better-ccflare --add-account primary-account --mode max --priority 0

# Add secondary accounts with lower priorities
better-ccflare --add-account secondary-1 --mode max --priority 10
better-ccflare --add-account secondary-2 --mode max --priority 20

# Add backup account with lowest priority
better-ccflare --add-account backup --mode console --priority 50

# Enable auto-fallback on primary account (API call)
ACCOUNT_ID=$(better-ccflare --list | grep "primary-account" | jq -r '.id')
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

echo "Auto-fallback setup complete!"
echo "Primary account (priority 0): auto-fallback enabled"
echo "Secondary accounts (priorities 10, 20): standard usage"
echo "Backup account (priority 50): emergency fallback"
```

**Use Case Scenarios:**

1. **Cost Optimization**: Configure free accounts with auto-fallback to automatically use them when available:
   ```bash
   # Free account (priority 0) - auto-fallback enabled
   # Paid accounts (priorities 10+) - used when free account is rate limited
   ```

2. **Performance Prioritization**: Configure highest-priority accounts with auto-fallback:
   ```bash
   # High priority account (priority 0) - auto-fallback enabled for best performance
   # Medium priority account (priority 10) - fallback when high priority is rate limited
   # Low priority account (priority 20) - emergency backup
   ```

3. **Mixed Priority Strategy**: Combine different account priorities for optimal performance:
   ```bash
   # High priority account (priority 0) - auto-fallback enabled for maximum performance
   # Medium priority account (priority 10) - balanced performance and cost
   # Low priority account (priority 20) - cost-effective backup
   ```

**Monitoring Auto-Fallback:**

```bash
# Monitor logs for auto-fallback events
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep "Auto-fallback"

# Check account status
curl http://localhost:8080/api/accounts | jq '.[] | {name, priority, autoFallbackEnabled, rateLimitStatus}'

# Real-time monitoring
watch -n 5 'curl -s http://localhost:8080/api/accounts | jq ".[] | select(.autoFallbackEnabled == true)"'
```

## Configuration Validation

### Automatic Validation

better-ccflare performs validation on:

1. **Strategy names**: Must be one of the valid strategy options (validated by `isValidStrategy`)
2. **Numeric values**: Parsed and validated as integers/floats
3. **Port ranges**: Should be valid port numbers (1-65535)
4. **File permissions**: Config directory is created with appropriate permissions

### Validation Errors

Invalid configurations result in:

- **Strategy errors**: Throws error when setting via API, falls back to default strategy when loading
- **Parse errors**: Logged to console, uses default values
- **File errors**: Creates new config file with defaults
- **Invalid numeric values**: Falls back to default values

### Best Practices

1. **Test configuration changes**: Use the API to test strategy changes before updating files
2. **Monitor logs**: Check logs after configuration updates for validation errors
3. **Use environment variables**: For deployment-specific settings that shouldn't be committed
4. **Backup configurations**: Keep backups before major changes

## Migration Guide

### From Environment-Only Configuration

If migrating from environment variables to file-based configuration:

1. Create the configuration file:
   ```bash
   mkdir -p ~/.config/better-ccflare
   ```

2. Export current configuration:
   ```bash
   curl http://localhost:8080/api/config > ~/.config/better-ccflare/better-ccflare.json
   ```

3. Edit and format the file:
   ```bash
   jq '.' ~/.config/better-ccflare/better-ccflare.json > temp.json && mv temp.json ~/.config/better-ccflare/better-ccflare.json
   ```

### From Older Versions

#### Pre-1.0 to Current

1. **Configuration location**: Move from `~/.better-ccflare/config.json` to platform-specific paths
2. **Field naming**: Update any deprecated field names (none currently deprecated)
3. **Strategy names**: Use one of the supported lowercase values: `"session"`,
   `"least-used"`, `"session-affinity"`, or the opt-in
   `"session-drain-soonest"`.

### Configuration Backup

Always backup your configuration before upgrades:

```bash
cp ~/.config/better-ccflare/better-ccflare.json ~/.config/better-ccflare/better-ccflare.json.backup
```

### Rollback Procedure

If issues occur after configuration changes:

1. **Via API**: Revert strategy changes using the runtime API
2. **File restoration**: Restore from backup configuration file
3. **Environment override**: Use environment variables to override problematic settings

## Troubleshooting

### Common Issues

1. **Configuration not loading**:
   - Check file permissions: `ls -la ~/.config/better-ccflare/`
   - Verify JSON syntax: `jq '.' ~/.config/better-ccflare/better-ccflare.json`
   - Check logs for parse errors

2. **Environment variables not working**:
   - Ensure variables are exported: `export VAR=value`
   - Check variable names match exactly (case-sensitive)
   - Verify no typos in variable names

3. **Runtime updates not persisting**:
   - Check file write permissions
   - Ensure configuration directory exists
   - Look for save errors in logs

### Debug Mode

Enable comprehensive debugging:

```bash
export better-ccflare_DEBUG=1
export LOG_LEVEL=DEBUG
export LOG_FORMAT=json  # For structured logging
```

This provides detailed configuration loading information and operation logs.

#### Get Retention
```http
GET /api/config/retention
```

Response:
```json
{ "payloadDays": 7, "requestDays": 365 }
```

Note: Payload retention applies to request/response JSON payloads. Request metadata retention controls how long rows in the `requests` table are kept (affects analytics beyond the window).

#### Set Retention
```http
POST /api/config/retention
Content-Type: application/json

{ "payloadDays": 14, "requestDays": 180 }
```

Response: `204 No Content`

#### Manual Cleanup
```http
POST /api/maintenance/cleanup
```

Response:
```json
{ "removedRequests": 0, "removedPayloads": 123, "cutoffIso": "2025-08-20T12:34:56.000Z" }
```
