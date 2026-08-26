# Issue #260 — v3.5.67 Deferred Deployment Handoff

> **Non-executable evidence only.** This document does not authorize a production
> deployment, service restart, systemd mutation, production database operation, or
> live health request. A separate operator decision is required after the candidate
> has merged to canonical `refs/heads/main`.

## Candidate identity

| Field | Required value / state |
|---|---|
| Integration commit | **Pending** — replace with the verified two-parent merge SHA after creation |
| First parent | `94cfc55bcdcce59fc94f4a85f1ac5b131486bc1a` |
| Upstream parent | `ebc904903dc828338cd2d5da707b0d3dd2d0922f` (peeled `refs/tags/v3.5.67`) |
| Manifest version | `3.5.67` in root and CLI manifests |
| Distribution identity | `v1:startupbros-managed-source` |
| Producer | `startupbros` |
| Artifact mode | `managed-source` |
| Update channel | absent / `null` |
| Provenance result | `proven: true`, `reason: proven_non_actionable` |
| Source ref | `refs/heads/main` |
| Source SHA | Must equal the final integration commit in `CCFLARE_GIT_SHA` and `CCFLARE_SOURCE_SHA` |

The managed-source identity is intentionally non-actionable. The ordinary updater
must not offer a mutable npm, GitHub release, or container replacement for it.

## Pre-deployment evidence

- Issue #260 inventory and ledger: 227 Git-derived rows (120 upstream commits, 65
  predicted conflicts, 42 clean two-sided paths).
- Database acceptance manifest and guarded SQLite/PostgreSQL rehearsal are recorded
  under `docs/plans/`.
- Isolated U2-U7 acceptance packets are recorded in the issue #260 ledger.
- The pre-merge fixture-only hermetic provenance rehearsal passed 138 tests and
  772 assertions across the shared resolver, Docker metadata, CLI builder metadata,
  managed-source pin renderer, runtime health projection, and zero-lookup updater
  behavior. It made no live network, provider, deployment, service, database, or
  health-endpoint request.
- **Final integration SHA, final combined-diff receipt, final-candidate provenance
  rerun, independent review, and CI:** pending until the candidate merge exists.
- Production was not queried or mutated while producing this handoff.

This section must be updated with the final candidate SHA and receipts before the
candidate can be called merge-ready. Local source tests or fixture health responses
do not prove a production runtime.

## Separately authorized source gate

Only after the candidate is merged may an operator separately authorize:

```bash
scripts/deploy-ccflare.sh --check
```

Run that check only from a clean canonical checkout where:

1. `HEAD` is attached to `refs/heads/main`;
2. `HEAD` exactly equals freshly fetched `refs/remotes/origin/main`;
3. `HEAD` is an ancestor of `refs/remotes/origin/main`;
4. the working tree is clean;
5. root and CLI manifest versions match and are not behind the highest contained
   stable `v*` tag.

A passing `--check` proves only source/version eligibility. It does not build an
artifact, validate the effective systemd policy, restart the service, or prove the
running runtime identity.

## Pre-restart stop conditions

If a full deployment is later authorized, stop before restart when any of these
conditions fails:

- the source gate above or the non-blocking deployment lock;
- immutable source-snapshot creation or candidate-SHA equality;
- build completion and binary digest equality after installation;
- source-to-installed digest equality for the runner, guard, and guard policy;
- deploy-owned pin validation, backup capture, atomic pin replacement, or expected
  managed-source provenance fields;
- rendered or effective guard timing/body-admission policy validation;
- compare-and-swap proof that the live pin still matches the captured backup;
- capture of the prior proxy/guard runtime needed for a provable rollback.

The effective systemd policy must be validated after daemon reload and before the
first restart. A policy failure restores the prior pin without touching the running
service.

## Post-restart identity evidence

After a separately authorized restart, the operator must require all of the
following before accepting the deployment:

- proxy health reports `version: "3.5.67"`, `git_sha` equal to the candidate SHA,
  `git_ref: "refs/heads/main"`, and a non-unknown `build_date`;
- proxy health `distribution` reports identity
  `v1:startupbros-managed-source`, producer `startupbros`, artifact mode
  `managed-source`, `proven: true`, and `reason: proven_non_actionable`;
- guard health identifies the same source/policy IDs and the systemd `MainPID`
  started through the expected commit-addressed runner;
- binary, runner, guard, and policy paths and SHA-256 digests match the artifacts
  staged before restart;
- effective deadline, retry, shutdown, request-body, aggregate-buffer, and admission
  queue limits match the validated pin;
- both proxy and guard health endpoints respond within the deployment timeout.

Do not infer runtime identity from a binary filename, package version, Git branch,
or a single HTTP 200 response.

## Operator-owned rollback decisions

The deployment script arms rollback after the prior pin/runtime are captured. A
post-restart health or identity failure must restore the prior pin, reload systemd,
restart the prior stack, and verify the restored binary/runner/guard/policy identity.

The operator owns these decisions:

1. whether to authorize any full deployment after reviewing the final candidate,
   CI, and provenance receipts;
2. whether all post-restart evidence is complete enough to accept the new runtime;
3. whether to permit automatic rollback to proceed when validation fails;
4. how to intervene if prior runtime identity was incomplete or rollback identity
   cannot be proven (a hard failure, not a successful restore);
5. whether and when old artifacts or pin backups may be pruned after a verified
   deployment and rollback window.

Until those decisions and observations occur, production remains unchanged and the
candidate remains only source-level work.
