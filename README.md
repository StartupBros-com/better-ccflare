# HoV Router

<a id="wstack-router"></a>

Use your AI accounts from one place, and see which account handled each request. HoV Router connects Claude Code to your chosen providers, routes requests across available accounts, and shows usage, costs, and errors in a dashboard. Run one Router privately over Tailscale for several computers, or start with one local computer.

## Send this to your AI agent

Copy this into **Claude Code or another coding agent with access to your computer and terminal**. A chat-only assistant can explain the steps, but can't install Router for you.

```text
Help me set up HoV Router for Claude Code.

Read https://github.com/StartupBros/hov-router/blob/main/docs/agent-setup.md
First determine whether to connect to an existing Router or host a new one.
Reuse an existing Router instead of installing another or repeating provider
setup. Preserve my working settings and login. Ask before paid usage,
authentication changes, or server changes.

Do the setup you can; leave browser sign-in, MFA, and private credentials to me,
without secrets in chat. Verify a real request used the intended account and
model, with the owner's help if needed. Report missing evidence or human steps
as pending, not done. Show me how to launch and undo the client setup without
disrupting a shared server.
```

Your agent handles the technical steps; you supply any private access details. Already have a Router? Use [shared-client setup](docs/agent-setup.md#shared-client-only). Tailscale connects the computers; it does not replace Router authentication. Starting your first Router? Use the [manual installation instructions](docs/reference.md#install-the-linux-x86_64-release).

## What it looks like

With two coding accounts, the Router owner adds them and reviews their routing order. Claude Code sends a request; Router picks an eligible account. If that account becomes unavailable, Router can try another eligible account under your routing settings. In **Requests**, you can check the account, model, and outcome rather than guess where the request went.

Router doesn't create more quota or make a paid provider free. If every eligible account is unavailable, the request can still fail. Provider access, billing, and usage rules still apply.

![Router dashboard showing account usage and request activity](apps/lander/src/screenshot-dashboard.png)

[Watch the dashboard walkthrough](https://github.com/user-attachments/assets/c859872f-ca5e-4f8b-b6a0-7cc7461fe62a).

## Will it run on my computer?

Shared clients need Claude Code and access to the confirmed server, not a Router binary. The limits below concern the **server**, not the client OS.

- **Linux x86_64:** [Router 3.6.2](https://github.com/StartupBros/hov-router/releases/tag/v3.6.2) has a standalone binary with a pinned checksum. It still prints `wstack Router v3.6.2`; a command alias doesn't change its bytes. It doesn't need Node.js or Bun to run.
- **Source builds:** instructions use a POSIX shell on Linux/macOS, or WSL on Windows, with Git, Node.js, and Bun 1.4.2. The source-install acceptance check runs on Linux x86_64; macOS and native Windows installation have not been verified here.
- **Other distributions:** Router does not publish npm packages, container images, or binaries for other platforms. The upstream better-ccflare packages and downloads are a different distribution.

Use `hov-router`; `wstack-router` and `better-ccflare` remain compatible commands with unchanged storage/configuration names. See [migration and rollback](docs/wstack-router-migration.md). The repository was renamed to [StartupBros/hov-router](https://github.com/StartupBros/hov-router) on 2026-10-21; it is the same repository, not a new fork.

## Help and contributions

Start with [troubleshooting](docs/troubleshooting.md) or the [documentation index](docs/index.md) for configuration, providers, routing, and deployment. Report Router problems at [StartupBros/hov-router/issues](https://github.com/StartupBros/hov-router/issues). Include your platform, version, and the failing step; remove credentials and private request content.

Issues and pull requests are welcome. For non-trivial changes, open an issue first to agree on the approach. See the [contribution guide](docs/contributing.md).

## Acknowledgements

A House of Vibe project from StartupBros, continuing [tombii/better-ccflare](https://github.com/tombii/better-ccflare) and its ancestor [snipeship/ccflare](https://github.com/snipeship/ccflare). Their work and the community's contributions remain credited in the [full acknowledgements](docs/acknowledgements.md), including upstream sponsors.

HoV Router and hovstack are independent sibling projects by House of Vibe; neither requires the other.

MIT - See [LICENSE](LICENSE) for details.
