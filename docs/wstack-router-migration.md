# Moving to wstack Router

wstack Router is the independent product identity of the existing [StartupBros-com/better-ccflare fork](https://github.com/StartupBros-com/better-ccflare), presented as a House of Vibe project. It continues tombii/better-ccflare and snipeship/ccflare under the existing MIT license. Git history, contributor acknowledgements, and license terms remain intact.

The current source repository is public. This identity change does not create or transfer a repository, change its visibility, or publish a new package. [Fork support](https://github.com/StartupBros-com/better-ccflare/issues) stays in the current repository.

## Install without replacing your current executable

Follow the [source quickstart](../README.md#install-from-source). It builds the current fork with `bun install --frozen-lockfile` and `bun run build`, then installs the unchanged `apps/cli/dist/better-ccflare` artifact under **both** executable names in a fresh directory:

- `wstack-router` is the preferred command.
- `better-ccflare` is the compatibility command, not a second server.

Record the current executable location with `command -v better-ccflare` before changing PATH. Keep that executable. The quickstart changes only the current shell's PATH unless you explicitly make it permanent; it does not replace a global package or repoint a service. Do not run both names as servers against the same database.

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

There is no new wstack configuration namespace and no config or credential migration. Do not rename storage directories, recovery files, environment variables, headers, or database files to match the product name. Existing deployments keep their paths, service names, and ports.

`wstack-router --get-model` reads the default agent model from configuration without opening the account database or contacting a provider. `--help` and `--version` alone do not prove that configuration was loaded. `--show-config` provides a broader diagnostic view, but its normal default-loading behavior may persist missing defaults; it is not a byte-preservation check.

## Manual source updates

Branded builds do not offer an actionable upstream update. Do not install a registry package or a tombii release to update this fork: those are upstream distributions, not wstack Router.

1. Keep the prior installed directory and record its `--version` and `--git-sha` output. Back up configuration and database using your existing backup procedure before running a newer server; an identity change is not a promise that future schema changes can be downgraded.
2. In the clean source checkout created by the quickstart, inspect `git remote -v` and confirm `origin` points to `StartupBros-com/better-ccflare`. Confirm `git symbolic-ref HEAD` reports `refs/heads/main` before updating; use a separate fresh checkout if you are working on another branch. Fetch and fast-forward from the unambiguous remote reference (the repository also has a `main` tag):

   ```bash
   git fetch origin refs/heads/main
   git merge --ff-only origin/main
   bun install --frozen-lockfile
   bun run build
   ```

   If you have local changes or a diverged branch, stop and resolve them; do not reset or overwrite your work. These are manual maintainer commands, not an auto-updater.
3. Repeat the README's local installation block. It creates another fresh directory instead of overwriting the previous executable. Verify both commands' `--version` and `--git-sha` output before choosing that directory in PATH. Repointing or restarting an existing service is a separate deployment operation, not part of this installation guide.

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

The helper checks copies named `wstack-router` and `better-ccflare` with `--help` and `--version` in an isolated environment. These checks do not start a server, exercise provider inference, or prove configuration/database compatibility. Existing all-platform build support remains available; this preparation helper only covers Linux x86_64.

Verify the bytes from inside the output directory:

```bash
cd /tmp/wstack-router-prep-001
sha256sum -c SHA256SUMS
```

Expect `better-ccflare-linux-amd64: OK`. A checksum detects a byte mismatch against the manifest; it does **not** authenticate the publisher. An untagged preparation build has no proven release SHA or distribution identity, even if its version output looks familiar. Do not use its `--git-sha` output as release proof. The updater remains non-actionable.

The CI counterpart is the separate [Prepare wstack Router Artifacts](../.github/workflows/prepare-router-artifacts.yml) job for pull requests and manual runs, with read-only repository permissions and no artifact uploads. It is not any of the existing publishing workflows:

- `release-dispatch.yml` bumps versions, commits, pushes a tag, and publishes to npm.
- `release.yml` runs on version tags or manual dispatch and creates releases/uploads assets.
- `signpath-release.yml` and `signpath-test.yml` submit signing requests; they are not local smoke checks.
- `docker-publish.yml` can publish images on manual dispatch or after the release workflow completes successfully.

Do not invoke those workflows for preparation, change versions manually, or push a tag to test this path. Actual publication requires separate approval and validation of release wiring, version/tag agreement, provenance, and intended destinations **before** creating a release tag. These local files are not a published downloadable release, and there is no new live download URL.

## Maintainer: later repository cutover

`StartupBros/wstack-router` is a proposed destination, not a live repository or reserved name. Its absence does not establish transfer eligibility or legal clearance. The existing `StartupBros/wstack` repository is a different project, not this destination. Keep current quickstart, support, package, and provenance URLs until a separately approved move has been verified. Source preparation authorizes no repository creation, rename, transfer, fork detachment, publication, or deployment.

If a move is approved later:

1. **Confirm the exact destination and eligibility.** Recheck administrative access to the source, the destination owner's ability to receive it, name availability, and GitHub's current fork-network restrictions. Do not pre-create the destination repository: an existing repository at that name can prevent a transfer. For this organization-to-personal-account proposal, review the metadata/access losses before approval: issue types are removed, assignees other than the receiving owner are cleared, and read-only collaborators do not transfer. See GitHub's [transfer requirements and effects](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).
2. **Record the state that must survive.** Capture the repository's stable ID, default branch and SHA, branches/tags and history, fork parent, issues/PRs, releases and asset URLs, access, and integrations. Inspect Actions permissions, secrets, environments, webhooks, Pages, package/image ownership, and signing configuration without exporting secret values. Do not assume a repository transfer moves registry namespaces or approves signing for the new identity. npm is separate; GitHub Packages associations may transfer or be lost depending on the registry, so verify GHCR ownership, links, and access explicitly.
3. **Move only under that approval, then verify.** Prefer transfer with the final name if GitHub supports it for this source and destination. Otherwise rename first, verify identity/history and redirects, then transfer and verify again. Before changing consumer URLs or remotes, compare the stable ID, history/default SHA, fork parent, issues/PRs, releases/assets, access, and redirects with the recorded state. Test old release-asset URLs before and after; do not promise their continuity from repository redirects alone. Preserve Git history, the MIT license, and contributor credits.
4. **Update integrations against the verified destination.** The exact-origin allowlist in `apps/cli/build-provenance.ts` rejects unapproved future remotes. Add only the verified new origin forms with matching tests, preserving current compatible origins; do not loosen the allowlist or merely replace URLs. In `.github/workflows/managed-routing-postgres.yml`, the exact repository match selects the self-hosted runner only for main-branch push/manual events; a moved repository falls back to the hosted runner. Verify destination runner access and restrictions before updating that match, retaining the main-only event restrictions. Separately verify Pages and Actions repository references, package/image namespaces, and signing/release wiring before switching public URLs or remotes.

GitHub redirects can be broken by reuse of the old repository path; Pages and Actions references have their own migration requirements. Consult the [rename guidance](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository) as well as the transfer guidance. Moving a repository preserves its fork relationship. [Detaching a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork) is a separate irreversible decision, not part of this cutover plan.

## Not included

No repository creation, transfer or visibility change; registry/package, image or release publication; tag push; production deployment; provider inference; new installer; config migration; update adapter; or external harness/wstack integration is part of this handoff. Upstream Docker Compose recipes retain their existing behavior and images. A new product name does not change the provider usage rules.

## If installation fails

- **Repository not found:** check the exact current repository URL and your network/Git configuration; do not substitute an uncreated future repository name.
- **Missing build artifact:** run `bun run build` from the checkout root before copying. The build includes the dashboard and compiled CLI; do not invoke `prepublish`.
- **Command not found or old branding:** check PATH order and the printed installation directory with `command -v`; an older global command may still be selected.
- **Missing accounts/config:** check the existing HOME/XDG and config/database overrides. Do not create a replacement namespace or move credentials to fix a command-name change.
- **Port occupied:** leave the existing server alone and select a different local port, or perform a separate planned service handoff.
