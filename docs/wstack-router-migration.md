# Moving to HoV Router

<a id="moving-to-wstack-router"></a>

HoV Router is a House of Vibe project targeting [StartupBros/hov-router](https://github.com/StartupBros/hov-router). HoV Router and hovstack are independent sibling products; neither requires the other. Router continues tombii/better-ccflare and snipeship/ccflare under the existing MIT license. Git history, contributor acknowledgements, and license terms remain intact.

The public repository moved from `StartupBros-com/better-ccflare` to `StartupBros/wstack-router` on 2026-10-19 (see [the repository move](#repository-move)). **Before the HoV rename:** use the live [StartupBros/wstack-router](https://github.com/StartupBros/wstack-router) in clone, download, and support URLs until cutover. [Fork support targets StartupBros/hov-router/issues](https://github.com/StartupBros/hov-router/issues). Source must merge before the repository rename; this guide performs neither operation.

The published [3.6.2 Linux x86_64 binary](reference.md#install-the-linux-x86_64-release) remains historical wstack Router, including its exact bytes, source SHA, tag, and signing identity. It still prints `wstack Router v3.6.2` through `hov-router`; a filesystem alias cannot relabel its embedded output. New source builds display HoV Router. Router npm packages, container images, and other-platform binaries are not published.

## Install without replacing your current executable

Follow the [source quickstart](reference.md#install-from-source). It builds the current fork with `bun install --frozen-lockfile` and `bun run build`, then installs the unchanged `apps/cli/dist/better-ccflare` artifact under **all three** executable names in a fresh directory:

- `hov-router` is the preferred command.
- `wstack-router` and `better-ccflare` remain compatible commands for the same server.

Record the current executable location with `command -v wstack-router` or `command -v better-ccflare` before changing PATH. Keep that executable. The quickstart changes only the current shell's PATH unless you explicitly make it permanent; it does not replace a global package or repoint a service. Do not run multiple aliases as separate servers against the same database.

## What stays the same

| Surface | Existing contract |
| --- | --- |
| Linux/macOS config directory | `$XDG_CONFIG_HOME/better-ccflare`, or `~/.config/better-ccflare` when XDG is unset |
| Config filename | `better-ccflare.json` in that directory |
| Windows config directory | `better-ccflare` beneath `LOCALAPPDATA`, then `APPDATA`, then `~/AppData/Local` |
| Default SQLite database | `better-ccflare.db` in the platform config directory |
| Config override | `BETTER_CCFLARE_CONFIG_PATH`, with legacy `ccflare_CONFIG_PATH` fallback |
| Database override | `BETTER_CCFLARE_DB_PATH`; `DATABASE_URL` still selects PostgreSQL |
| Other integration names | Existing `BETTER_CCFLARE_*`, `CCFLARE_*`, and other environment variables; `x-better-ccflare-*` headers |
| Default server port | `8080`; existing port overrides and deployment ports remain unchanged |
| Build/package names | `apps/cli/dist/better-ccflare`, the `better-ccflare` package identity, and internal `@better-ccflare/*` packages |

There is no new HoV configuration namespace and no config or credential migration. Do not rename storage directories, recovery files, environment variables, headers, or database files to match the product name. Existing deployments keep their paths, service names, and ports. Existing documentation filenames, including this guide's `wstack-router-migration.md`, remain unchanged.

`hov-router --get-model` reads the default agent model from configuration without opening the account database or contacting a provider. `--help` and `--version` alone do not prove that configuration was loaded. `--show-config` provides a broader diagnostic view, but its normal default-loading behavior may persist missing defaults; it is not a byte-preservation check.

## Manual source updates

Branded builds do not offer an actionable upstream update. Do not install a registry package or a tombii release to update this fork: those are upstream distributions, not HoV Router.

1. Keep the prior installed directory and record its `--version` and `--git-sha` output. Back up configuration and database using your existing backup procedure before running a newer server; an identity change is not a promise that future schema changes can be downgraded.
2. In the clean source checkout created by the quickstart, inspect `git remote -v` and confirm `origin` points to `StartupBros/hov-router` after cutover, or the live `StartupBros/wstack-router` before it (see [the repository move](#repository-move)). Confirm `git symbolic-ref HEAD` reports `refs/heads/main` before updating; use a separate fresh checkout if you are working on another branch. Fetch and fast-forward from the unambiguous remote reference (the repository also has a `main` tag):

   ```bash
   git fetch origin refs/heads/main
   git merge --ff-only origin/main
   bun install --frozen-lockfile
   bun run build
   ```

   If you have local changes or a diverged branch, stop and resolve them; do not reset or overwrite your work. These are manual maintainer commands, not an auto-updater.
3. Repeat the [source installation](reference.md#install-from-source) local installation block. It creates another fresh directory instead of overwriting the previous executable. Verify all three commands' `--version` and `--git-sha` output before choosing that directory in PATH. Repointing or restarting an existing service is a separate deployment operation, not part of this installation guide.

## Roll back the command choice

1. Stop a newly started local server before returning to the prior executable. Do not start a second process against its database.
2. Remove the new install directory from the shell PATH configuration you added, or open a shell that still uses the previous PATH. You can also invoke the retained previous executable by its absolute path. Keep the new directory until you have verified the rollback; no deletion is needed.
3. Check `command -v better-ccflare`, then the selected executable's `--version` and `--git-sha`. This verifies command selection, not database downgrade safety. If you ran a version with schema changes, use that version's migration/backup guidance before restarting an older server.

## Maintainer: prepare local release artifacts

Preparation is not publication. From the repository root on **Linux x86_64**, install dependencies with `bun install --frozen-lockfile`, then run the helper with a new output directory:

```bash
bun run apps/cli/prepare-router-artifacts.ts /tmp/wstack-router-prep-001
```

The destination must not already exist; choose a different path for each run. The helper builds the dashboard and reuses the selected-platform CLI builder. Its output directory contains exactly:

- `better-ccflare-linux-amd64` — the compatibility asset name remains unchanged.
- `SHA256SUMS` — the checksum for that executable.

The helper checks copies named `hov-router`, `wstack-router`, and `better-ccflare` with `--help` and `--version` in an isolated environment. These checks do not start a server, exercise provider inference, or prove configuration/database compatibility. Existing all-platform build support remains available; this preparation helper only covers Linux x86_64.

Verify the bytes from inside the output directory:

```bash
cd /tmp/wstack-router-prep-001
sha256sum -c SHA256SUMS
```

Expect `better-ccflare-linux-amd64: OK`. A checksum detects a byte mismatch against the manifest; it does **not** authenticate the publisher. An untagged preparation build has no proven release SHA or distribution identity, even if its version output looks familiar. Do not use its `--git-sha` output as release proof. The updater remains non-actionable.

The CI counterpart is the separate [artifact preparation](../.github/workflows/prepare-router-artifacts.yml) job for pull requests and manual runs, with read-only repository permissions and no artifact uploads. It is not any of the existing publishing workflows:

- `release-dispatch.yml` bumps versions, commits, pushes a tag, and publishes to npm.
- `release.yml` runs on version tags or manual dispatch and creates releases/uploads assets.
- `signpath-release.yml` and `signpath-test.yml` submit signing requests; they are not local smoke checks.
- `docker-publish.yml` can publish images on manual dispatch or after the release workflow completes successfully.

Do not invoke those workflows for preparation, change versions manually, or push a tag to test this path. Actual publication requires separate approval and validation of release wiring, version/tag agreement, provenance, and intended destinations **before** creating a release tag. These locally prepared files are not a published downloadable release. For the separately published 3.6.2 artifact, use the [consumer installation](reference.md#install-the-linux-x86_64-release).

## Repository move

On 2026-10-19 the source repository was transferred from `StartupBros-com/better-ccflare` to [`StartupBros/wstack-router`](https://github.com/StartupBros/wstack-router). It remains a public fork of tombii/better-ccflare, and the transfer retains the fork relationship, Git history, and the MIT license. Contributor credits are unchanged. The post-transfer check confirmed the same repository ID, default-branch commit, branches/tags, issue and pull-request identities, and active workflows. The old repository URL redirects to the new home. At the time of the transfer check, there were no releases or assets before or immediately after the move; the move itself was not a binary release. Router 3.6.2 was published separately afterward.

Existing checkouts keep working under their current directory name; do not rename it. For the HoV rename, the target is `StartupBros/hov-router`. Before that rename, keep the live `StartupBros/wstack-router` remote. Only after cutover is confirmed, inspect and update an existing checkout's remote:

```bash
git remote -v
git remote set-url origin https://github.com/StartupBros/hov-router.git
git remote -v
```

The old repository URLs are kept in historical documentation and were verified to redirect after the 2026-10-19 move. Verify redirects during the HoV cutover rather than assuming the earlier transfer proves them. A fresh clone uses the [source guide's](reference.md#install-from-source) `git clone https://github.com/StartupBros/hov-router.git better-ccflare` form after cutover, keeping the local directory name compatible.

At transfer time, npm publication, GHCR images, signing, and release workflows still required separate approval and validation. The move did not validate any of them; subsequent Router release automation is documented in the [release guide](wstack-router-releases.md). The existing publishing workflows listed above must not be invoked merely to move the repository. The transfer-time check also found that `.github/workflows/managed-routing-postgres.yml` used an exact repository match for its self-hosted runner, with the moved repository taking the hosted fallback; inspect current workflow configuration before making runner assumptions. The exact-origin allowlist in `apps/cli/build-provenance.ts` accepts the verified new origin forms while retaining the old ones. Its clean-tree, explicit-context, version, and exact-tag checks remain unchanged; untagged builds still have no proven release identity and branded builds have no actionable update channel.

GitHub redirects can be broken by reuse of the old repository path. [Detaching a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork) is a separate irreversible decision and has not been made.

## Not included

No detaching of the fork or visibility change; registry/package, image or release publication; tag push; production deployment; provider inference; new installer; config migration; update adapter; or external harness/wstack integration was part of the identity-change and repository-transfer handoff. Upstream Docker Compose recipes retain their existing behavior and images. A new product name does not change the provider usage rules.

## If installation fails

- **Repository not found:** before cutover use `https://github.com/StartupBros/wstack-router`; after the confirmed rename use `https://github.com/StartupBros/hov-router`. Check your network/Git configuration; hovstack is a separate product, not an alternate Router repository.
- **Missing build artifact:** run `bun run build` from the checkout root before copying. The build includes the dashboard and compiled CLI; do not invoke `prepublish`.
- **Command not found or old branding:** check PATH order and the printed installation directory with `command -v`; an older global command may still be selected.
- **Missing accounts/config:** check the existing HOME/XDG and config/database overrides. Do not create a replacement namespace or move credentials to fix a command-name change.
- **Port occupied:** leave the existing server alone and select a different local port, or perform a separate planned service handoff.
