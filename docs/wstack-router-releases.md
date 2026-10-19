# wstack Router release automation (draft-only)

This is the operator guide for `StartupBros/wstack-router`. It stages a verified
**draft** GitHub release. It never publishes a release, publishes npm packages or
images, announces, installs, restarts services, or deploys. Public publication is
a separate decision that is not part of this increment.

## Status: not active until a repository policy blocker is resolved

The repository reports `default_workflow_permissions: read` and
`can_approve_pull_request_reviews: false`. The second setting stops the built-in
`GITHUB_TOKEN` from creating release pull requests, so a
`router-release.yml` run fails at its `pull-requests` job when a release PR is needed.
A chore-only implementation run can no-op without creating a PR, tag or release. This implementation
changes no repository setting and uses no personal access token. Whoever owns the
repository settings must decide how to unblock PR creation. Until then, describe the
automation as installed but not operating.

The `drafts` job still runs when `pull-requests` fails, so an already merged release
is not hidden by the policy blocker. The overall workflow run stays red.

## Version policy

- One product version for the whole repository, calculated by the pinned
  `release-please` 17.11.2 engine. The initial cutoff is bootstrap commit
  `d981843f014e76d8d1743410010d3628bbdc3962`; subsequent releases use the engine's
  matching version tags as their cutoff.
- The lineage continues from 3.5.78 (seeded in `.release-please-manifest.json`);
  no manual version bump is needed or allowed.
- Root `package.json`, `apps/cli/package.json`, the release manifest and the Bun
  `apps/cli` workspace entry in `bun.lock` always advance together.
- Prefixes: `fix`/`bug`/`resolve` produce a patch; `feat`/`feature`/`add`/`new` a minor;
  a breaking change (`!` or `BREAKING CHANGE`) a major. `security`, `improve`,
  `enhance` and `update` keep their existing changelog intent. `docs`, `chore`, `test`
  and `style` alone produce no release pull request.
- Tags are `vX.Y.Z` with no component. The change that merges this automation uses
  `chore` commits and creates no tag or release.

## What authorizes a draft

Only a merged release PR whose exact merge commit has a successful
`Managed Routing Foundation Gate` push run on `main`. A newer commit on `main` never
vouches for an older release commit: that commit needs its own green run and must be
an ancestor of `main`. Release PR reconciliation requires the source to be the
current `main` head.

## Flow

1. `router-release.yml` (the coordinator) runs after a successful foundation gate
   push on `main`. It validates the exact repository, event, workflow path, branch
   and SHA, reconciles release PRs, then creates or reuses the draft and tag.
2. It explicitly dispatches `router-release-artifacts.yml` **at the tag**
   (`--ref vX.Y.Z`), not at `main`. A checkout alone does not change GitHub's OIDC
   claims; dispatching at the tag makes the attestation certificate carry the
   release commit and tag ref. The workflow file must exist on `main` and in the tag.
3. The tag run requires `github.sha` and `github.ref` to equal the release identity,
   then revalidates eligibility, source CI, merged PR, tag and draft read-only.
4. A credential-free `build` job runs `apps/cli/prepare-router-release.ts prepare`.
   A separate `attest` job (`id-token: write`, `attestations: write`) attests the
   binary and manifest. A separate `stage` job holds the write token.
5. `stage` uploads only missing assets, re-reads the inventory, downloads fresh bytes,
   authenticates attestations and then runs smoke checks. It revalidates release
   eligibility, source CI, merged PR, tag and draft again after those checks, before
   printing the verified draft URL and source identity. This is a final recheck,
   not an atomic guarantee against subsequent GitHub changes.

The coordinator processes every validated pending candidate. Its concurrency group
is separate from the artifact workflow's per-tag groups. All use
`cancel-in-progress: false`: staging for the same tag is serialized, while distinct
release tags do not replace each other's pending runs.

## Fixed inventory and provenance

The draft holds exactly `better-ccflare-linux-amd64`, `SHA256SUMS` and
`release-manifest.json`. The manifest records repository, version, ref, SHA, Bun pin,
target and binary size/digest, plus the compiled provenance claim. It is a claim,
not its own trust anchor. GitHub build attestation covers the binary and manifest;
attestation bundles are not extra release assets.

Verification binds repository, source digest, source ref `refs/tags/vX.Y.Z`, the
signer workflow identity
`.../router-release-artifacts.yml@refs/tags/vX.Y.Z`, the signer commit, and denies
self-hosted runners. The binary is executed only after that passes. The compiled
fixture check covers the full provenance tuple; the shipped binary itself is checked
through `--version` and `--git-sha`.

## Reruns and failures

- Rerun the failed `stage` job: it reuses the same-run build artifact (retained 7 days).
  Existing identical assets are reused; missing assets are uploaded.
- A fresh rebuild that produces different bytes, a differing remote asset, an
  unexpected asset, a moved tag, a published release or mismatched metadata stops with
  the offending identity. Nothing is deleted, clobbered, replaced or published, and
  a human must resolve it.
- A failed draft/coordinator step: run the coordinator by `workflow_dispatch` with
  `source_sha` (the release PR merge commit) and `version`. It re-validates and
  re-dispatches the artifact run; each write is preceded by re-validation.
- The auto-rerun workflow excludes both new workflows.

GitHub immutable releases are currently disabled on the platform. The no-clobber
behavior is enforced by this pipeline only; do not describe it as platform immutability.

## Pull request CI approval

`GITHUB_TOKEN`-created release PRs may have their `pull_request` runs held at "Approve
workflows to run" until a user with write access approves them. Required PR CI is not
bypassed or automatically dispatched. When runs are suppressed or unavailable, a
maintainer must start CI manually before the PR can merge.

## Containment

The inherited npm release, multi-architecture release, both SignPath workflows and
Docker publishing have a job-level `github.repository != 'StartupBros/wstack-router'`
condition. Their triggers and other repositories' behavior are unchanged.
`prepare-router-artifacts.yml` stays a local, non-publishing preparation check.

## Unexercised remote behavior

No live draft, tag, attestation, upload or dispatch has been run. The action pins
(`actions/checkout` 7.0.1, `setup-bun` 2.2.0, `upload-artifact` 6.0.0,
`download-artifact` 7.0.0, `actions/attest` 4.2.1) and the `gh attestation verify`
flags are checked against official sources and local tests only. The `stage` job
checks the runner's `gh` supports every verifier flag used by the helper before
using it. Local executable fixtures exercise CLI output and the coordinator's shell
with synthetic API responses and command stand-ins; they do not prove live GitHub
attestation or dispatch behavior.
