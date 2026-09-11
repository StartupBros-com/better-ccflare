---
title: Never poll an unknown HTTP path against a local ccflare — unknown paths fall through to the generic proxy
date: 2026-09-10
category: workflow-issues
module: local-testing
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Writing a script that starts a local ccflare and waits for it to be ready
  - Health-checking or smoke-testing a dev instance from a shell script or CI job
  - Any harness that loops on an HTTP request until the server answers
symptoms:
  - "ValidationError: Provider cannot handle path: /api/health repeated in the server log"
  - "WARN All models exhausted on account <name>, failing over to next account during startup"
  - A readiness loop generated one routing attempt per account per poll
  - Startup poll never succeeded even though the server printed its ready banner
root_cause: incorrect_assumption
resolution_type: workflow_improvement
related_components:
  - proxy
  - testing_framework
tags:
  - local-testing
  - readiness-probe
  - generic-proxy-fallthrough
  - anthropic-account-safety
  - startup-banner
---

# Never poll an unknown HTTP path against a local ccflare

## Context

ccflare's fetch handler routes a small set of known paths (the dashboard, the API
router, `/v1/responses`) and **forwards everything else to the generic proxy**, which
attempts to serve it across the real account pool.

That makes an unknown path a live routing attempt, not a harmless 404.

## What went wrong

A probe harness waited for a locally-started ccflare by polling `/api/health` in a
loop. That path is not a route. Every poll fell through to the generic proxy and was
attempted against real accounts — including **Anthropic-backed ones**, which this
repository's top-level instruction says must never receive scripted traffic:

```
ERROR [ProxyOperations] ValidationError: Provider cannot handle path: /api/health
ERROR [ProxyOperations] Failed to proxy request with account pro-tertiary-will
WARN  [ProxyOperations] All models exhausted on account max-primary-bros, failing over to next account
```

Nothing left the machine — each attempt failed closed at `buildUrl` validation
before any outbound fetch, and that error is caught per-account so routing simply
tried the next one. But the harness was manufacturing routing attempts across the
whole pool, once per poll, and the only thing standing between that and real traffic
was a validation error firing first. That is too thin a margin to rely on.

## The fix: read the startup banner, send zero requests

Readiness is observable from the server's own log without touching the proxy at all:

```bash
READY=0
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died during startup" >&2; tail -40 "$SERVER_LOG" >&2; exit 1
  fi
  if grep -q "Ready to proxy requests" "$SERVER_LOG" 2>/dev/null; then
    READY=1; break
  fi
  sleep 1
done
```

This also handles the case the HTTP poll could not: it distinguishes *still starting*
from *died during startup*, because it checks the process as well as the log.

## Two related traps in the same harness

**Do not point a second ccflare at the production database.** It holds the real DB and
a multi-instance guard will correctly refuse the second writer. Use
`BETTER_CCFLARE_DB_PATH` pointed at a disposable copy.

**Do not copy the production database wholesale to get one.** It can be multiple
gigabytes of request history, and startup against it will outrun any reasonable
readiness window. Build a minimal database with the schema and just the `accounts`
rows:

```bash
sqlite3 -readonly "$PROD_DB" ".schema" | grep -v '^CREATE TABLE sqlite_' | sqlite3 "$PROBE_DB"
sqlite3 "$PROBE_DB" "ATTACH DATABASE '$PROD_DB' AS prod; INSERT INTO accounts SELECT * FROM prod.accounts; DETACH DATABASE prod;"
```

Before doing even that, confirm the relevant access tokens are not near expiry — a
refresh fired against a copy can rotate a refresh token that production still depends
on.

## Applicability

Any script that starts a ccflare instance and waits on it. The general rule: on a
proxy that forwards unknown paths to real upstreams, **a readiness probe must not be
an HTTP request** unless you have verified the exact path is a locally-handled route.
