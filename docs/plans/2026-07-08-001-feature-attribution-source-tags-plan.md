# Attribution source tags and caller lineage plan

## Status

Draft plan for upstreamable better-ccflare attribution improvements.

## Problem

better-ccflare currently records useful request data, including `project`, `agent_used`, model, account, token fields, cost, status, and failover attempts. That was enough to identify a large `Harness` and `gpt-5.5` spend spike, but not enough to answer the next diagnostic questions quickly:

- Did `project=Harness` come from an explicit caller header, a path heuristic, or a prompt heading?
- Which caller, job, or campaign launched the expensive requests?
- Was spend original work, retry amplification, or fallback amplification?
- Which model was requested versus which upstream model actually served the request?
- Was the spike expected high-concurrency work, a stale resumed session, or a runaway loop?
- Were cache reads effective for the route that served the traffic?

Today, answers require database archaeology and sometimes source inspection. Future incidents should be diagnosable from request metadata without reading request payloads, prompt bodies, auth files, or secret-bearing headers.

## Goals

- Add first-class, sanitized attribution dimensions to request records.
- Preserve existing behavior for callers that send no new headers.
- Distinguish explicit caller attribution from heuristic project or agent extraction.
- Support cost and usage diagnostics by caller, job, campaign, project, agent, route, and failover group.
- Avoid storing prompts, tool inputs, raw auth headers, cookies, or high-cardinality unbounded data.
- Keep the first implementation small enough to be upstreamable as OSS PRs.

## Non-goals

- Do not add pi-evals, pi-lens, or private harness-specific logic to better-ccflare upstream.
- Do not parse historical request payloads to backfill attribution.
- Do not store raw request bodies, prompt text, tool arguments, cookies, authorization headers, or raw trace IDs.
- Do not implement budget enforcement in the first PR. Attribution comes first, policy can build on it later.
- Do not build a full dashboard redesign before the write path and API filters are proven.

## Current state

### Request table

The live SQLite `requests` table includes:

- `id`
- `timestamp`
- `method`
- `path`
- `account_used`
- `status_code`
- `success`
- `error_message`
- `response_time_ms`
- `failover_attempts`
- `model`
- token and cost fields
- `agent_used`
- `project`
- `billing_type`
- `api_key_id`
- `api_key_name`
- `combo_name`

It does not include:

- attribution source fields
- caller identity
- job or campaign identifiers
- request attempt grouping
- requested versus resolved model fields
- transport or provider route classification beyond existing account/model fields

### Project extraction

Project extraction currently appears in more than one place. The observed extraction order is:

1. `x-project` header
2. workspace path inferred from the system prompt
3. first eligible markdown heading in the system prompt
4. `NULL`

There is no persisted source tag, so a value like `Harness` cannot be distinguished as explicit header attribution versus a heading/path heuristic after the fact.

### Agent attribution

Agent attribution uses `x-anthropic-agent-id` when present and can fall back to prompt or registry matching. The stored field is `agent_used`, with no source tag.

### API and dashboard

Request filtering is currently stronger for accounts, models, API keys, and status than it is for attribution fields. Diagnostics by project and agent are possible in SQL, but not yet first-class across summary APIs, analytics, insights, and UI filters.

## Recommended MVP field set

Add nullable columns to `requests` in both SQLite and Postgres migrations.

| Field | Type | Source | Why |
| --- | --- | --- | --- |
| `project_attribution_source` | text enum, app-validated | project extraction helper | Distinguishes header, path, heading, or none. |
| `agent_attribution_source` | text enum, app-validated | agent interceptor | Distinguishes header, prompt, or none. |
| `caller` | text, sanitized, max 128 | header | Identifies caller family such as `claude-code`, `pi-lens`, `pi-evals`, `codex-host`, `cron`, or `ci`. |
| `job_id` | text, sanitized, max 128 | header | Stable unit of work for runaway and cost analysis. |
| `campaign_id` | text, sanitized, max 128 | header | Groups related jobs into a batch or campaign ledger. |
| `request_attempt_group_id` | text, generated or supplied | proxy entry and failover path | Links original request and fallback attempts. |
| `failover_attempt_number` | integer | proxy operations | Distinguishes original and subsequent attempts. |
| `requested_model` | text | client request | Shows what the caller asked for. |
| `resolved_model` | text | routing/provider layer | Shows what upstream model actually served after mapping or fallback. |
| `transport` | text enum, app-validated | account/provider route | Separates `anthropic`, `codex-via-ccflare`, `openai-compatible`, and similar routes. |

Keep enum validation in application code rather than database `CHECK` constraints unless migrations explicitly handle future enum expansion across SQLite and Postgres.

## Header contract

Prefer namespaced headers for new metadata, while keeping existing headers as compatibility aliases.

| Header | Meaning | Notes |
| --- | --- | --- |
| `x-better-ccflare-project` | Project label | Preferred new project header. Existing `x-project` remains accepted. |
| `x-better-ccflare-agent-id` | Agent label | Preferred new agent header. Existing `x-anthropic-agent-id` remains accepted. |
| `x-better-ccflare-caller` | Caller family | Low-cardinality values such as `claude-code`, `pi-lens`, `pi-evals`, `codex-host`, `cron`, `ci`. |
| `x-better-ccflare-job-id` | Unit of work | Opaque or slug value, not a prompt or description. |
| `x-better-ccflare-campaign-id` | Batch or campaign | Opaque or slug value for campaign-level budgets and reporting. |
| `x-better-ccflare-repo` | Optional repo slug | Short repo slug only, no raw path with secrets. Defer if not needed in MVP. |
| `x-better-ccflare-worktree` | Optional worktree slug | Short slug only. Defer if not needed in MVP. |

### Header aliases

- Accept `x-project` as an alias for `x-better-ccflare-project`.
- Accept `x-anthropic-agent-id` as an alias for `x-better-ccflare-agent-id`.
- If both old and new headers exist, prefer the namespaced better-ccflare header.

## Sanitization and privacy rules

Use allowlist-first persistence. Never persist arbitrary headers.

### Persistable values

- Normalize to short text.
- Strip control characters.
- Cap to 128 characters unless a field has a smaller existing limit.
- Prefer allowlisted characters such as letters, digits, `.`, `_`, `-`, `/`, and `:`.
- Lowercase canonical fields where appropriate, especially `caller` and source enums.
- Reject obvious secrets, emails, high-entropy tokens, bearer-like strings, and cookie-like values.
- Store rejected values as `NULL` or `none`, optionally with a low-cardinality rejection reason.

### Explicit denylist

Never persist these headers or their values:

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `api-key`
- `proxy-authorization`
- `x-auth-token`
- `x-csrf-token`
- `x-session`
- `x-amz-security-token`
- `x-goog-*`
- `x-ms-*`
- raw IP forwarding headers

### Backfill policy

- Do not backfill from request payload bodies.
- Do not parse historical prompts.
- Backfill only from already-sanitized columns if necessary.
- Treat historical `Harness` rows as unknown provenance unless future request rows include source tags.

## Implementation plan

### PR 1: Source tagging and shared extraction helper

This is the most upstream-friendly first PR.

Scope:

- Create a shared project extraction helper that returns `{ project, projectAttributionSource }`.
- Replace duplicated project extraction logic in proxy and usage collector paths.
- Update agent attribution to return `{ agentUsed, agentAttributionSource }`.
- Preserve existing extraction order and behavior.
- Add unit tests for header, path, heading, and none cases.

Suggested enum values:

```ts
type ProjectAttributionSource =
  | 'header_project'
  | 'path_project'
  | 'heading_project'
  | 'none'

type AgentAttributionSource =
  | 'header_agent'
  | 'prompt_agent'
  | 'none'
```

Notes:

- This PR can initially keep source tags in memory if maintainers prefer to defer schema changes.
- If schema changes are accepted in the same PR, add the source columns and persist them immediately.

### PR 2: Persist caller, job, campaign, and source tags

Scope:

- Add nullable columns to SQLite and Postgres migrations.
- Add performance indexes only for high-value filters.
- Thread fields through:
  - request metadata creation
  - `RequestMeta`
  - start messages
  - usage collector state
  - response handler
  - early failure paths
  - pool exhausted paths
  - database save path
- Replace or wrap long positional `saveRequest` arguments with a typed attribution object.
- Add repository save and UPSERT tests.

Minimal indexes:

- `(timestamp, caller)` or `(caller, timestamp)`, depending existing query style
- `(timestamp, job_id)` or `(job_id, timestamp)`
- `(timestamp, campaign_id)` or `(campaign_id, timestamp)`
- `(timestamp, project)` if not already covered for the desired query shape
- `(timestamp, request_attempt_group_id)` only if failover waterfall queries are frequent

Avoid indexing every source enum initially. They are low cardinality and cheap to group after time filtering.

### PR 3: Server-side filters and diagnostic API

Scope:

- Extend request row and response types.
- Ensure request summary handlers map `project` plus new fields.
- Add filter params for:
  - projects
  - agents
  - callers
  - job IDs
  - campaign IDs
  - project attribution sources
  - agent attribution sources
  - request attempt group IDs
- Plumb filters through analytics and insights queries.
- Add tests for filters and response mapping.

### PR 4: Dashboard surfacing

Scope:

- Add optional request table columns.
- Add request details modal fields.
- Add filters for caller, job, campaign, project source, and agent source.
- Move agent/project filtering server-side where practical.
- Add top spend by caller/job/campaign widgets.
- Add unattributed spend ratio.

This PR should come after server-side filters so UI does not rely on partial client-side filtering.

### PR 5: Optional budgets and alerts

Defer until attribution is reliable.

Possible policies:

- per-caller request/minute limit
- per-job cost ceiling
- per-campaign token ceiling
- failover amplification ceiling
- high-context `gpt-5.5` approval or alert
- unattributed spend alert

## Producer instrumentation plan

better-ccflare cannot invent ground truth. Callers must emit the headers.

### Generic caller rules

Every automated caller should send:

- caller family
- project
- job id
- campaign id when part of a batch
- explicit agent id when known

### Example mappings

| Producer | `caller` | `project` | `job_id` | `campaign_id` |
| --- | --- | --- | --- | --- |
| Claude Code wrapper | `claude-code` | repo slug | transcript/session id hash | task or workflow id |
| pi-lens harness | `pi-lens` | case suite or repo slug | harness run id | suite/campaign id |
| pi-evals dispatcher | `pi-evals` | eval family or repo slug | run id or sample id | campaign stamp |
| Codex host | `codex-host` | repo slug | thread/job id | workflow id |
| cron/systemd | `cron` | service slug | invocation id | unit/timer name |
| CI | `ci` | repo slug | CI job id | workflow/run id |

Use opaque or slug identifiers. Do not send prompt text, user emails, branch names with secrets, or raw authorization material.

## Diagnostic queries

Use actual existing token field names where possible.

### Top cost by caller and job

```sql
SELECT
  caller,
  job_id,
  campaign_id,
  model,
  COUNT(*) AS requests,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(cost_usd), 2) AS cost_usd
FROM requests
WHERE timestamp >= ?
GROUP BY caller, job_id, campaign_id, model
ORDER BY cost_usd DESC
LIMIT 50;
```

### Attribution quality

```sql
SELECT
  project,
  project_attribution_source,
  COUNT(*) AS requests,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(cost_usd), 2) AS cost_usd
FROM requests
WHERE timestamp >= ?
GROUP BY project, project_attribution_source
ORDER BY cost_usd DESC;
```

### Unattributed spend ratio

```sql
SELECT
  ROUND(
    1.0 * SUM(CASE WHEN caller IS NULL AND job_id IS NULL AND campaign_id IS NULL THEN cost_usd ELSE 0 END)
    / NULLIF(SUM(cost_usd), 0),
    4
  ) AS unattributed_cost_ratio
FROM requests
WHERE timestamp >= ?;
```

### Runaway candidates

```sql
SELECT
  caller,
  job_id,
  campaign_id,
  COUNT(*) AS requests,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(cost_usd), 2) AS cost_usd,
  MAX(timestamp) AS last_seen
FROM requests
WHERE timestamp >= ?
GROUP BY caller, job_id, campaign_id
HAVING requests > ? OR cost_usd > ?
ORDER BY cost_usd DESC
LIMIT 50;
```

### Failover amplification

```sql
SELECT
  request_attempt_group_id,
  COUNT(*) AS attempts,
  SUM(failover_attempts) AS failover_attempts,
  ROUND(SUM(cost_usd), 2) AS cost_usd,
  GROUP_CONCAT(DISTINCT model) AS models,
  MAX(success) AS any_success
FROM requests
WHERE timestamp >= ?
  AND request_attempt_group_id IS NOT NULL
GROUP BY request_attempt_group_id
HAVING attempts > 1
ORDER BY attempts DESC, cost_usd DESC
LIMIT 50;
```

### Cache effectiveness by caller and model

```sql
SELECT
  caller,
  model,
  SUM(input_tokens) AS input_tokens,
  SUM(cache_read_input_tokens) AS cache_read_input_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
  SUM(output_tokens) AS output_tokens,
  ROUND(
    1.0 * SUM(cache_read_input_tokens)
    / NULLIF(SUM(input_tokens) + SUM(cache_read_input_tokens) + SUM(cache_creation_input_tokens), 0),
    4
  ) AS cache_read_share
FROM requests
WHERE timestamp >= ?
GROUP BY caller, model
ORDER BY cache_read_share ASC, input_tokens DESC;
```

## Tests

Add tests for:

- header precedence and alias behavior
- project extraction source tagging
- agent extraction source tagging
- sanitizer allowlist and denylist
- rejection of secret-like values
- migration column creation in SQLite and Postgres paths
- request repository insert and UPSERT with partial updates
- early failure request saving with attribution fields
- pool exhausted path saving with attribution fields
- request summary response mapping
- server filters
- analytics filters

Add privacy canaries:

- send fake `authorization`
- send fake `cookie`
- send fake `x-api-key`
- send secret-like `x-better-ccflare-job-id`
- assert none are persisted in requests, payload metadata, logs, errors, or analytics responses

## Upstream contribution strategy

This is viable for upstream if split into focused PRs.

Recommended order:

1. shared extraction helper and source tagging
2. persistence of optional sanitized attribution fields
3. server-side filters and diagnostics
4. dashboard surfacing
5. optional budgets and alerts

Do not submit a giant observability-platform PR first.

Suggested upstream pitch:

> better-ccflare currently records `project` and `agent_used`, but diagnostics cannot tell whether those labels came from explicit headers or heuristic extraction from prompts/paths. In high-volume agent or eval workloads, this makes cost spikes difficult to attribute. This change adds explicit attribution source tagging and optional sanitized caller/job/campaign metadata without storing prompt bodies or secrets. Existing callers continue to work unchanged.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Schema expansion too broad | Start with MVP spine only. |
| Parameter-order bugs in save path | Replace long positional args with typed attribution object. |
| High-cardinality labels | Enforce length, character, and secret-pattern limits. Add cardinality reports. |
| Secret leakage through headers | Allowlist persisted headers and denylist auth/cookie/key headers with tests. |
| Existing callers send nothing | Nullable fields, old behavior preserved, unattributed spend metric. |
| Dashboard table scans | Server-side filters and focused indexes before UI polish. |
| Backfill privacy risk | No payload/prompt backfill. |
| Ambiguous single source field | Split project and agent attribution source columns. |

## Acceptance criteria

- New attribution fields are nullable and do not break existing callers.
- Existing `x-project` and `x-anthropic-agent-id` behavior still works.
- Namespaced headers populate caller, job, campaign, project, and agent fields.
- Project and agent source tags identify header versus heuristic extraction.
- Better-ccflare can answer top spend by caller/job/campaign without reading payload bodies.
- Failover attempts can be linked by request attempt group.
- Request summary API returns the new fields.
- Server filters can filter by caller, job, campaign, project, agent, and source tags.
- Tests prove secret-like headers are not persisted.
- A local diagnostic query can identify a future `Harness`-style spike by caller/job/campaign and source.
