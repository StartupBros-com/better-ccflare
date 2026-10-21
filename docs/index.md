# HoV Router Documentation

<a id="wstack-router-documentation"></a>

New here? [Send the setup prompt to your coding agent](../README.md#send-this-to-your-ai-agent). The [agent setup guide](agent-setup.md) takes it from inspecting your computer to verifying a client request, with sign-in left to you.

## Install or connect

- [Connect to a shared Router](agent-setup.md#shared-client-only): client-only setup over Tailscale or another approved private connection; no local Router install.
- [Manual installation](reference.md#install-the-linux-x86_64-release): verified Linux x86_64 binary, with optional [signed provenance](wstack-router-releases.md#optional-consumer-provenance-verification).
- [Source build](reference.md#install-from-source): requirements and installation without overwriting an existing command.
- [Local server and account setup](reference.md#start-the-local-server): dashboard workflow and request verification.
- [Claude Code authentication](reference.md#configure-claude-sdk) or [Codex client configuration](reference.md#codex-cli-as-a-client).
- [Migration and rollback](wstack-router-migration.md): existing wstack-router/better-ccflare users, unchanged storage names, and manual updates.

Router 3.6.2 publishes a Linux x86_64 binary only. The [platform notes](reference.md#platform-support) distinguish source-build coverage from upstream packages and downloads, which do not install Router.

## Configure and operate

- [Technical reference](reference.md): installation commands, TLS, legacy upstream recipes, detailed feature contracts, screenshots, and source-checkout commands.
- [CLI commands](cli.md) and [HTTP API](api-http.md).
- [Configuration](configuration.md): environment variables, authentication settings, telemetry, and model controls.
- [Provider system](providers.md) and [model mappings](models.md).
- [Account routing architecture](routing-architecture.md), [load-balancing strategies](load-balancing.md), and [Combos](combos.md).
- [Auto-fallback](auto-fallback.md) and [auto-refresh](auto-refresh.md).
- [Troubleshooting](troubleshooting.md), including [database repair](reference.md#troubleshooting-database-issues).
- [Deployment](deployment.md), [systemd](systemd.md), and [Docker](../DOCKER.md). Upstream container recipes retain their upstream images.
- [Security](security.md), [database schema](database.md), and [v2-to-v3 migration](migration-v2-to-v3.md).

## Develop and maintain

- [Architecture](architecture.md), [data flow](data-flow.md), and [source-checkout commands](reference.md#source-checkout-reference).
- [Contribution guide](contributing.md) and [acknowledgements](acknowledgements.md).
- [Release automation](wstack-router-releases.md): maintainer draft-release workflow, separate from consumer installation.
- [Anthropic usage API changelog](anthropic-api-changelog.md).

[Router source and issues](https://github.com/StartupBros/hov-router) · [MIT license](../LICENSE)

Use `hov-router`; `wstack-router` and `better-ccflare` remain compatible commands. The same repository was renamed to [StartupBros/hov-router](https://github.com/StartupBros/hov-router) on 2026-10-21; see [the repository move](wstack-router-migration.md#repository-move) for verification and the known old-issue URL exception. Existing documentation filenames remain unchanged.

External references: [Anthropic API](https://docs.anthropic.com/claude/docs), [Bun](https://bun.sh/docs), [SQLite](https://www.sqlite.org/docs.html).
