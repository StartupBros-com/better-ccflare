# wstack Router release automation (draft-only)

This is the operator guide for `StartupBros/wstack-router`. It stages a verified
**draft** GitHub release. It never publishes a release, publishes npm packages or
images, announces, installs, restarts services, or deploys. Public publication is
a separate decision that is not part of this increment.

## App authentication and verification boundaries

Release PR reconciliation uses a dedicated GitHub App installation token, not the
built-in Actions token. Keep `default_workflow_permissions: read` and the combined
“Allow GitHub Actions to create and approve pull requests” setting
(`can_approve_pull_request_reviews`) **off**. Neither policy needs relaxing.
The `pull-requests` job's built-in token has only `contents: read`; top-level workflow
permissions remain empty. This change does not grant the App a ruleset bypass or
authorize unattended release-PR merges, and it uses no personal access token.

PR #556 activated the scoped App/token wiring with the required checks preserved.
Its coordinator passed App token minting, release-PR reconciliation and post-job
token revocation. That no-op reconciliation did not create a release PR and is not
proof of the release PR, its checks, or the draft/artifact path. Verify those steps
for each actual release; the release's Actions runs are the evidence, not this
setup guide. Missing configuration fails the mint step; it never silently skips
reconciliation or falls back to the built-in token, even on a chore-only run that
would otherwise need no release PR.

The `drafts` job still runs when `pull-requests` fails, so an already merged release
is not hidden by an App failure. The overall workflow run stays red. Manual draft
retries skip the entire PR job and never mint an App token.

## Dedicated Router App configuration

1. Register a dedicated App that can be installed on the personal-owned
   `StartupBros/wstack-router` repository. Existing private, organization-owned HoV
   Apps cannot serve this installation; do not broaden their visibility to reuse them.
   Grant repository permissions **Contents: read/write**, **Pull requests: read/write**,
   **Issues: read/write** (release labels), and **Actions: read-only** (source CI).
   GitHub's implicit **Metadata: read-only** permission remains. No administration,
   workflow-write, organization permissions, or ruleset bypass is needed.
2. Install it on `StartupBros`, selecting **only `wstack-router`**. Preserve all other
   repository protection and Actions policies. The token request also restricts
   `owner: StartupBros` and `repositories: wstack-router` with the four explicit
   permissions above; neither installation nor request should include other repos.
3. Set repository Actions variable `ROUTER_RELEASE_APP_CLIENT_ID` to the App's
   **Client ID**, not its numeric App ID. Generate its private key and set repository
   Actions secret `ROUTER_RELEASE_APP_PRIVATE_KEY` through the approved secure
   provisioning path. Never paste the PEM into chat, command arguments, source, or
   logs; never echo it or invent another credential store. App registration,
   installation and key handling require the operator's provisioning decision.
4. Verify the real coordinator can mint the token, create or update a genuinely
   needed release PR, and trigger its required checks. Do not fake a version bump
   to exercise this. Local tests cannot verify installation access or live CI events.

The pinned `actions/create-github-app-token` v3.3.0 action
(`64ab729a6294000f5aa4a4bc0b73d1f32bc45510`, Node 24) mints after dependency installation,
only immediately before reconciliation. Only that step receives the output through
the existing `GITHUB_TOKEN` interface. Checkout does not persist credentials. The
App token is not passed to dependency installation, build, smoke, draft or artifact
jobs, and the action's default post-job revocation remains enabled. Draft and
artifact jobs retain their separate built-in tokens and existing permissions.

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

## Intentional first release or explicit version request

An intentional release request can use the engine's `Release-As` commit-body
trailer without inventing a feature or editing version files. For the first Router
release, preserve this complete message on the request PR's squash commit:

```text
chore: prepare the first wstack Router release

Release-As:3.6.0
```

1. Open a normal request PR and let its required checks pass. Ordinary unmarked
   `docs`, `chore`, `test` and `style` commits remain no-ops; the trailer is a
   deliberate release request, not a new rule that releases every chore.
2. When merging the request PR, put `Release-As:3.6.0` in a local body file and use
   `gh pr merge <request-pr> --squash --subject "chore: prepare the first wstack Router release" --body-file <body-file>`.
   Do not rely on the PR description or GitHub's default squash body to retain it.
   Use the normal checked merge path, never a direct-main push, force push or bypass.
3. Read back the **actual main commit message** using the merged PR's
   `mergeCommit.oid` and `gh api repos/StartupBros/wstack-router/commits/<sha> --jq .commit.message`.
   Confirm the honest subject, blank line and exact `Release-As:3.6.0` trailer before
   treating the request as delivered. A local message or PR description is not proof.
4. After that commit's foundation gate passes, observe the coordinator's generated
   release PR. The pinned engine selects 3.6.0 and synchronizes root/CLI packages,
   release manifest and Bun workspace version without changing dependency resolution.
   The request subject appears in generated PR notes and `CHANGELOG.md`; arbitrary
   body prose is not a supported way to enrich those notes. Leave version-file edits
   to the engine and verify the actual App-authored PR's required checks.
5. Merge that genuine engine release PR only through the normal required-check path.
   The request commit alone cannot authorize a draft. Its release PR's exact merged
   commit needs its own successful foundation gate before the coordinator can create
   the draft/tag and stage verified artifacts. After observing draft creation, richer
   release notes can be supplied through supported release-note editing; do not
   publish the draft as part of this procedure.

This procedure does not enable auto-merge or change the publication boundary.
Local characterization verifies engine behavior, not completion of these live steps.

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

PRs created or updated with the built-in `GITHUB_TOKEN` produce approval-required
`pull_request` runs for `opened`, `synchronize`, and `reopened` events. App-authored
PRs avoid that token-specific manual approval gate. This wiring does not prove
that the live installation will trigger CI: verify the actual release PR and its checks.

The strict required checks have been verified live as `managed-routing-foundation`
and `prepare`, both bound to the GitHub Actions integration **15368**. Preserve that
binding and all other policies. The App receives no bypass; required PR CI is neither
waived nor automatically dispatched by this change. If checks are held for approval,
suppressed or unavailable, the PR remains blocked until normal approval and CI
requirements are satisfied. Unattended release-PR merging is outside this increment.

## Containment

The inherited npm release, multi-architecture release, both SignPath workflows and
Docker publishing have a job-level `github.repository != 'StartupBros/wstack-router'`
condition. Their triggers and other repositories' behavior are unchanged.
`prepare-router-artifacts.yml` stays a local, non-publishing preparation check.

## Evidence required for each release

Verify the actual App-authored release PR and its CI events, draft, tag,
attestation, upload and dispatch at the release's immutable source SHA. PR #556's
successful token mint, no-op reconciliation and revocation prove the App wiring,
not that later releases completed those steps.

The App action's pinned `action.yml` and `main.js` confirm the inputs, Node 24
runtime and failure on missing Client ID or private key. Static YAML assertions
alone prove wiring, not live credential availability, revocation or GitHub event
behavior. The other action pins (`actions/checkout` 7.0.1, `setup-bun` 2.2.0,
`upload-artifact` 6.0.0, `download-artifact` 7.0.0, `actions/attest` 4.2.1) and the
`gh attestation verify` flags have source and local-test coverage. The `stage` job
checks the runner's `gh` supports every verifier flag used by the helper before
using it. Local executable fixtures exercise CLI output and the coordinator's shell
with synthetic API responses and command stand-ins; they do not prove live GitHub
attestation or dispatch behavior.
